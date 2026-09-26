import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReplayPosition, ResourceReference, SourceValue } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import { EvidenceError } from '@/evidence/contracts';
import { atomicFile, atomicJson, exists, hashBytes, safeFile } from '@/evidence/files';
import { jsonLines } from '@/evidence/files';
import type { EvidenceStore } from '@/evidence/store';
import { credentialUrl } from '@/capture/url-privacy';
import { responsePrivacy } from '@/capture/privacy';
import { inspectWriterLock } from '@/evidence/writer-lock';

export const RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const RESOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
export function privateResourceUrl(value: string): boolean {
  try { new URL(value); return credentialUrl(value); }
  catch { return true; }
}
export interface ArchivedResource extends ResourceReference {
  capturedAt: string;
  /** CDP loadingFinished callback time. Distinct from the later body read/write. */
  availableObservedAt?: string;
  /** CDP requestWillBeSent callback time for this exact request hop. */
  requestStartedAt?: string;
  bytes: number;
  source: { fromCache?: boolean; fromServiceWorker?: boolean; encodedDataLength?: number; redirectUrl?: string; requestUrl?: string; cdpFrameId?: string; byteRepresentation: 'decoded-response' };
}
export interface CaptureResourceInput {
  position: ReplayPosition; frameId: string; requestId?: string; url: string; mediaType: string;
  availableObservedAt?: string; requestStartedAt?: string;
  data?: Uint8Array; status?: ResourceReference['status']; reason?: string;
  source?: Omit<ArchivedResource['source'], 'byteRepresentation'>;
}
export function isArchivableResource(mediaType: string): boolean { return /^(text\/css|image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon)|font\/[^;]+|application\/(?:font-woff|vnd.ms-fontobject))$/i.test(mediaType.split(';')[0]); }
export async function ensureLocalDirectory(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) throw new EvidenceError('INVALID_PATH', 'Resource directory must stay within its data root.');
  let current = root;
  if ((await fs.lstat(root)).isSymbolicLink()) throw new EvidenceError('INVALID_PATH', 'Resource data root cannot be a symbolic link.');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    await fs.mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new EvidenceError('INVALID_PATH', 'Resource directory is not a regular local directory.');
  }
  return current;
}
function checkedId(value: string): string { if (!/^[a-f0-9-]{36}$/.test(value)) throw new EvidenceError('INVALID_RESOURCE_ID', 'Invalid archived resource ID'); return value; }

/** Consumes observed response bytes only. It has no fetch capability and never
 * reacquires a missing response from the network. Content deduplication does not
 * collapse URL/request/time provenance. No automatic resource garbage collector. */
export class ResourceCapture {
  private static readonly writers=new WeakMap<EvidenceStore,{totalBytes:number;references:number;tail:Promise<unknown>}>();
  private readonly writer:{totalBytes:number;references:number;tail:Promise<unknown>};
  constructor(private readonly store: EvidenceStore, readonly dataRoot = path.dirname(path.dirname(store.runDir))) {
    let writer=ResourceCapture.writers.get(store);if(!writer){writer={totalBytes:0,references:0,tail:Promise.resolve()};ResourceCapture.writers.set(store,writer);}this.writer=writer;
  }
  capture(input: CaptureResourceInput): Promise<ArchivedResource> {
    // Snapshot/cap bytes synchronously, before callers can mutate a response.
    const suppliedBytes = input.data?.byteLength;
    const data = input.data && input.data.byteLength <= RESOURCE_MAX_BYTES ? Buffer.from(input.data) : undefined;
    const task = this.writer.tail.then(async () => {
      if (this.store.manifest.status === 'sealed' || this.store.manifest.status === 'sealing') throw new EvidenceError('RUN_SEALED', 'Resources cannot be appended after sealing.', 409);
      if(this.writer.references>=10000)throw new EvidenceError('RESOURCE_COUNT_BUDGET','Offline resource reference budget reached; recording is degraded.',429);
      let status: ResourceReference['status'] = input.status ?? (data ? 'captured' : 'missing'), reason = input.reason;
      const privateUrl = privateResourceUrl(input.url), privateRequestUrl = !!input.source?.requestUrl && privateResourceUrl(input.source.requestUrl);
      if (privateUrl || privateRequestUrl) { status = 'redacted'; reason = 'credential-bearing-resource-url'; }
      else if (!isArchivableResource(input.mediaType)) { status = 'unsupported'; reason = 'resource-media-type-not-supported'; }
      else if ((suppliedBytes ?? 0) > RESOURCE_MAX_BYTES || this.writer.totalBytes + (suppliedBytes ?? 0) > RESOURCE_TOTAL_BYTES) { status = 'missing'; reason = 'resource-byte-budget'; }
      else if (data && responsePrivacy(data, input.mediaType).redacted) { status = 'redacted'; reason = 'credential-url-in-resource-body'; }
      if ((status === 'captured' || status === 'late-fetched') && !data) throw new EvidenceError('RESOURCE_BYTES_MISSING', 'Captured resources require their observed bytes');
      const originalUrl: SourceValue<string> = privateUrl ? { status: 'redacted', reason: reason! } : { status: 'present', value: input.url };
      const captured = status === 'captured' || status === 'late-fetched';
      const reference: ArchivedResource = { id: randomUUID(), position: { ...input.position }, frameId: input.frameId, ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.availableObservedAt ? { availableObservedAt: input.availableObservedAt } : {}), ...(input.requestStartedAt ? { requestStartedAt: input.requestStartedAt } : {}), originalUrl,
        mediaType: input.mediaType, status, ...(reason ? { reason } : {}), ...(captured ? { blobHash: hashBytes(data!) } : {}), capturedAt: new Date().toISOString(), bytes: captured ? data!.length : 0,
        source: { ...input.source, ...(privateRequestUrl ? { requestUrl: '[redacted]' } : {}), ...(input.source?.redirectUrl && privateResourceUrl(input.source.redirectUrl) ? { redirectUrl: '[redacted]' } : {}), byteRepresentation: 'decoded-response' } };
      if (captured) {
        const directory = await ensureLocalDirectory(this.dataRoot, 'blobs');
        const filename = path.join(directory, reference.blobHash!);
        if (!await exists(filename)) await atomicFile(filename, data!);
        else if (hashBytes(await fs.readFile(await safeFile(this.dataRoot, `blobs/${reference.blobHash}`))) !== reference.blobHash) throw new EvidenceError('RESOURCE_INTEGRITY', 'Existing resource blob does not match its content hash', 409);
      }
      const directory = await ensureLocalDirectory(this.store.runDir, 'resources');
      await atomicJson(path.join(directory, `${reference.id}.json`), reference);
      let indexedUrls:Set<string>|undefined,indexDirectory:string|undefined;
      if(reference.originalUrl.status==='present'){
        indexDirectory=await ensureLocalDirectory(this.store.runDir,'resource-url-index');
        indexedUrls=new Set([reference.originalUrl.value,...(reference.source.requestUrl&&reference.source.requestUrl!=='[redacted]'?[reference.source.requestUrl]:[])]);
        // Record the bounded URL census before confirming the resource event.
        // A failed later URL projection then remains distinguishable from a URL
        // never observed by this run.
        await fs.appendFile(path.join(indexDirectory,'url-census.jsonl'),[...indexedUrls].map(url=>hashBytes(url)).join('\n')+'\n');
      }
      await this.store.appendEvent({ type: 'resource-reference', source: 'resource-archive', pageId: input.position.pageId, data: reference });
      if(indexedUrls&&indexDirectory)for(const url of indexedUrls)await fs.appendFile(path.join(indexDirectory,hashBytes(url)+'.jsonl'),JSON.stringify({id:reference.id,position:reference.position,frameId:reference.frameId})+'\n');
      this.writer.totalBytes += reference.bytes;this.writer.references++; return reference;
    });
    this.writer.tail = task; return task;
  }
  async flush(): Promise<void> { await this.writer.tail; }
}

export class ResourceArchive {
  constructor(readonly runDir: string, readonly dataRoot = path.dirname(path.dirname(runDir))) {}
  private async urlEntries(url:string):Promise<Array<{id:string;position:ReplayPosition;frameId:string}>>{
    const urlHash=hashBytes(url);
    let relative=`resource-url-index/${urlHash}.jsonl`,expectedHash:string|undefined,pointerFound=false;
    try {
      const pointer=JSON.parse(await fs.readFile(await safeFile(this.runDir,'resource-url-index-current.json'),'utf8')) as {version?:number;generation?:string};
      pointerFound=true;
      if(pointer.version!==1||!/^[a-f0-9-]{36}$/.test(pointer.generation??''))throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Malformed resource index generation pointer',409);
      const prefix=`resource-url-index-generations/${pointer.generation}`;
      const manifest=JSON.parse(await fs.readFile(await safeFile(this.runDir,`${prefix}/index-manifest.json`),'utf8')) as {version?:number;generation?:string;urls?:Record<string,string>};
      if(manifest.version!==1||manifest.generation!==pointer.generation||!manifest.urls||typeof manifest.urls!=='object')throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Malformed resource index generation manifest',409);
      expectedHash=manifest.urls[urlHash];if(!expectedHash)return [];
      if(!/^[a-f0-9]{64}$/.test(expectedHash))throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Malformed resource index file hash',409);
      relative=`${prefix}/${urlHash}.jsonl`;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT'||pointerFound){
        if(error instanceof EvidenceError)throw error;
        throw new EvidenceError((error as NodeJS.ErrnoException).code==='ENOENT'?'RESOURCE_INDEX_MISSING':error instanceof SyntaxError?'RESOURCE_INDEX_CORRUPT':'RESOURCE_INDEX_READ_FAILED',`Cannot read published URL index: ${String(error)}`,409);
      }
      if(await exists(path.join(this.runDir,'resource-url-index-generations')))throw new EvidenceError('RESOURCE_INDEX_MISSING','Resource generation pointer is missing; directed recovery required',409);
    }
    let file:string;
    try{file=await safeFile(this.runDir,relative);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new EvidenceError('RESOURCE_INDEX_READ_FAILED',`Cannot open URL index: ${String(error)}`,409);
      if(expectedHash)throw new EvidenceError('RESOURCE_INDEX_MISSING','Published URL index file is missing; directed recovery required',409);
      let census:Buffer;
      try{census=await fs.readFile(await safeFile(this.runDir,'resource-url-index/url-census.jsonl'));}
      catch(issue){
        if((issue as NodeJS.ErrnoException).code!=='ENOENT')throw new EvidenceError('RESOURCE_INDEX_READ_FAILED',`Cannot read URL census: ${String(issue)}`,409);
        const resources=await fs.readdir(path.join(this.runDir,'resources')).catch(problem=>{if((problem as NodeJS.ErrnoException).code==='ENOENT')return [];throw problem;});
        if(resources.some(name=>/^[a-f0-9-]{36}\.json$/.test(name)))throw new EvidenceError('RESOURCE_INDEX_MISSING','Resource URL census is missing; directed recovery required',409);
        return [];
      }
      if(census.length>1024*1024)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL census exceeds 1 MiB; directed recovery required',413);
      const hashes=census.toString('utf8').trim().split('\n');
      if(hashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Resource URL census is malformed; directed recovery required',409);
      if(hashes.includes(urlHash))throw new EvidenceError('RESOURCE_INDEX_MISSING','Observed resource URL index is missing; directed recovery required',409);
      return [];
    }
    let bytes:Buffer;
    try{bytes=await fs.readFile(file);}catch(error){throw new EvidenceError('RESOURCE_INDEX_READ_FAILED',`Cannot read URL index: ${String(error)}`,409);}
    if(bytes.length>4*1024*1024)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL index exceeds the 4 MiB read budget',413);
    if(expectedHash&&hashBytes(bytes)!==expectedHash)throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Resource URL index hash mismatch; directed recovery required',409);
    const entries:Array<{id:string;position:ReplayPosition;frameId:string}>=[];
    for(const line of bytes.toString('utf8').split('\n')){
      if(!line)continue;
      if(entries.length>=10000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL history exceeds bounded scan budget',413);
      let entry:{id:string;position:ReplayPosition;frameId:string};
      try{entry=JSON.parse(line);checkedId(entry.id);parseReplayPosition(entry.position);if(typeof entry.frameId!=='string'||!entry.frameId)throw new Error('Invalid frame');}
      catch(error){throw new EvidenceError('RESOURCE_INDEX_CORRUPT',`Malformed resource URL index row: ${String(error)}`,409);}
      entries.push(entry);
    }
    return entries;
  }
  async reference(id: string): Promise<ArchivedResource> {
    const file = await safeFile(this.runDir, `resources/${checkedId(id)}.json`);
    if ((await fs.stat(file)).size > 32 * 1024) throw new EvidenceError('RESOURCE_METADATA_BUDGET', 'Resource metadata exceeds budget');
    const reference = JSON.parse(await fs.readFile(file, 'utf8')) as ArchivedResource;
    parseReplayPosition(reference.position);
    if (reference.id !== id || typeof reference.frameId!=='string'||!reference.frameId||reference.frameId.length>512||!Number.isSafeInteger(reference.bytes)||reference.bytes<0||reference.bytes>RESOURCE_MAX_BYTES||typeof reference.mediaType!=='string'||reference.mediaType.length>200||!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(reference.mediaType)||!['captured','late-fetched','missing','redacted','unsupported','failed'].includes(reference.status)||!reference.originalUrl||!['present','redacted','absent','missing','unsupported'].includes(reference.originalUrl.status)||reference.originalUrl.status==='present'&&(typeof reference.originalUrl.value!=='string'||reference.originalUrl.value.length>16384)||reference.blobHash && !/^[a-f0-9]{64}$/.test(reference.blobHash)||(reference.status==='captured'||reference.status==='late-fetched')&&!reference.blobHash||[reference.availableObservedAt,reference.requestStartedAt].some(value=>value!==undefined&&(!Number.isFinite(Date.parse(value))||typeof value!=='string'))) throw new EvidenceError('INVALID_RESOURCE', 'Malformed resource reference');
    return reference;
  }
  async read(id: string): Promise<{ reference: ArchivedResource; bytes: Buffer }> {
    const reference = await this.reference(id);
    if (!['captured','late-fetched'].includes(reference.status) || !reference.blobHash) throw new EvidenceError('RESOURCE_UNAVAILABLE', `Resource is ${reference.status}; no network fallback is allowed`, 404);
    const file = await safeFile(this.dataRoot, `blobs/${reference.blobHash}`);
    if ((await fs.stat(file)).size > RESOURCE_MAX_BYTES) throw new EvidenceError('RESOURCE_BYTE_BUDGET', 'Resource exceeds its bounded byte limit', 413);
    const bytes = await fs.readFile(file);
    if (bytes.length !== reference.bytes || hashBytes(bytes) !== reference.blobHash) throw new EvidenceError('RESOURCE_INTEGRITY', 'Archived resource hash or length mismatch', 409);
    return { reference, bytes };
  }
  async resolve(url:string,position:ReplayPosition,frameId='top'):Promise<ArchivedResource|undefined>{
    const candidates:Array<{id:string;position:ReplayPosition;frameId:string}>=[];let count=0;
    for(const entry of await this.urlEntries(url)){
      if(++count>10000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL history exceeds bounded scan budget',413);
      if(entry.frameId===frameId&&entry.position.recordingId===position.recordingId&&entry.position.pageId===position.pageId&&entry.position.documentId===position.documentId&&entry.position.streamEpoch===position.streamEpoch&&entry.position.eventSeq<=position.eventSeq)candidates.push(entry);
    }
    let probeFailure:ArchivedResource|undefined;
    for(const selected of candidates.reverse().sort((a,b)=>b.position.eventSeq-a.position.eventSeq)){
      const reference=await this.reference(selected.id);
      if(reference.originalUrl.status!=='present'||reference.originalUrl.value!==url&&reference.source.requestUrl!==url||!sameReplayPosition(reference.position,selected.position)||reference.frameId!==selected.frameId||reference.frameId!==frameId)throw new EvidenceError('RESOURCE_INDEX_MISMATCH','Resource URL index does not match its immutable manifest',409);
      // A cache probe returning no bytes is an observation failure, not a new
      // resource version. Keep its original, but never let it erase an actual
      // request's captured OR failed version at this historical position.
      if(reference.source.fromCache&&!reference.requestId&&['failed','missing'].includes(reference.status)){probeFailure??=reference;continue;}
      return reference;
    }
    return probeFailure;
  }
  /** All observed versions in one source stream. Position is a storage anchor,
   * not an availability clock; replay must inspect availableObservedAt. */
  async history(url:string,position:ReplayPosition,frameId:string):Promise<ArchivedResource[]>{
    const found:ArchivedResource[]=[];let count=0;
    for(const entry of await this.urlEntries(url)){
      if(++count>10000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL history exceeds bounded scan budget',413);
      if(entry.frameId!==frameId||entry.position.recordingId!==position.recordingId||entry.position.pageId!==position.pageId||entry.position.documentId!==position.documentId||entry.position.streamEpoch!==position.streamEpoch)continue;
      const reference=await this.reference(entry.id);
      if(reference.originalUrl.status!=='present'||reference.originalUrl.value!==url&&reference.source.requestUrl!==url||!sameReplayPosition(reference.position,entry.position)||reference.frameId!==frameId)throw new EvidenceError('RESOURCE_INDEX_MISMATCH','Resource URL index does not match its immutable manifest',409);
      found.push(reference);
    }
    return found;
  }
  /** Rebuild only this run's URL projection from saved manifests and blobs. A
   * failed generation remains on disk for diagnosis and is never published. */
  async rebuildUrlIndex():Promise<{generation:string;references:number;urls:number;corrupt:Array<{id:string;reason:string}>;corruptCount:number}>{
    const ownership=await inspectWriterLock(this.runDir);
    if(ownership.state!=='unlocked')throw new EvidenceError('ACTIVE_INDEX_REBUILD',`Resource recovery requires an unlocked writer (${ownership.state})`,409);
    const generation=randomUUID(),prefix=`resource-url-index-generations/${generation}`;
    const staged=path.join(this.runDir,prefix);
    try{await fs.mkdir(staged,{recursive:true});}
    catch(error){throw new EvidenceError('RESOURCE_INDEX_WRITE_FAILED',`Cannot stage URL index generation ${generation}: ${String(error)}`,507);}
    let names:string[];
    try{names=(await fs.readdir(path.join(this.runDir,'resources'))).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).sort();}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')names=[];else throw new EvidenceError('RESOURCE_ORIGINAL_READ_FAILED',`Cannot enumerate resource manifests: ${String(error)}`,409);}
    if(names.length>10000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource recovery exceeds 10000 saved manifests',413);
    const byUrl=new Map<string,string[]>(),corrupt:Array<{id:string;reason:string}>=[];let corruptCount=0,references=0;
    let eventFiles:string[];
    try{eventFiles=(await fs.readdir(path.join(this.runDir,'journal'))).filter(name=>/^events-\d{6}\.jsonl$/.test(name)).sort();}
    catch(error){throw new EvidenceError('RESOURCE_ORIGINAL_READ_FAILED',`Cannot enumerate original resource events: ${String(error)}`,409);}
    const orderedIds:string[]=[],confirmed=new Map<string,ArchivedResource>(),manifestNames=new Set(names);let scanned=0;
    try{for(const name of eventFiles){
      const relative=`journal/${name}`;
      for await(const line of jsonLines(await safeFile(this.runDir,relative))){
        if(++scanned>1_000_000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource event recovery scan exceeds one million records',413);
        if(line.invalid)throw new EvidenceError('RESOURCE_ORIGINAL_CORRUPT',`Original event ${relative}:${line.offset} is malformed: ${line.invalid}`,409);
        if(line.value?.type!=='resource-reference')continue;
        const data=line.value.data as ArchivedResource|undefined,id=data?.id;
        if(!data||typeof id!=='string'||!manifestNames.has(`${id}.json`)||confirmed.has(id))throw new EvidenceError('RESOURCE_ORIGINAL_CORRUPT',`Resource event ${relative}:${line.offset} has missing, invalid, or duplicate manifest identity`,409);
        confirmed.set(id,data);orderedIds.push(id);
      }
    }}catch(error){if(error instanceof EvidenceError)throw error;throw new EvidenceError('RESOURCE_ORIGINAL_READ_FAILED',`Cannot scan original resource events: ${String(error)}`,409);}
    for(const name of names)if(!confirmed.has(name.slice(0,-5))){corruptCount++;if(corrupt.length<128)corrupt.push({id:name.slice(0,-5),reason:'manifest-without-confirmed-resource-event'});}
    for(const id of orderedIds){
      let reference:ArchivedResource;
      try{
        reference=await this.reference(id);
        const event=confirmed.get(id)!;
        if(!sameReplayPosition(reference.position,event.position)||reference.frameId!==event.frameId||reference.status!==event.status||reference.blobHash!==event.blobHash||reference.availableObservedAt!==event.availableObservedAt||JSON.stringify(reference.originalUrl)!==JSON.stringify(event.originalUrl))throw new EvidenceError('INVALID_RESOURCE','Resource manifest no longer matches its confirmed original event',409);
        if(['captured','late-fetched'].includes(reference.status))await this.read(id);
      }
      catch(error){
        if(error instanceof EvidenceError&&['INVALID_RESOURCE','RESOURCE_INTEGRITY','RESOURCE_UNAVAILABLE','RESOURCE_BYTE_BUDGET'].includes(error.code)){corruptCount++;if(corrupt.length<128)corrupt.push({id,reason:String(error)});continue;}
        if(error instanceof SyntaxError){corruptCount++;if(corrupt.length<128)corrupt.push({id,reason:String(error)});continue;}
        throw new EvidenceError('RESOURCE_ORIGINAL_READ_FAILED',`Cannot read original resource ${id}: ${String(error)}`,409);
      }
      references++;
      if(reference.originalUrl.status!=='present')continue;
      const urls=new Set([reference.originalUrl.value,...(reference.source.requestUrl&&reference.source.requestUrl!=='[redacted]'?[reference.source.requestUrl]:[])]);
      for(const url of urls){
        const hash=hashBytes(url),rows=byUrl.get(hash)??[];
        rows.push(JSON.stringify({id,position:reference.position,frameId:reference.frameId}));byUrl.set(hash,rows);
      }
    }
    const hashes:Record<string,string>={};
    try{
      for(const [hash,rows] of [...byUrl].sort(([a],[b])=>a.localeCompare(b))){
        const bytes=Buffer.from(rows.join('\n')+'\n');
        if(bytes.length>4*1024*1024)throw new EvidenceError('RESOURCE_INDEX_BUDGET','One URL history exceeds the 4 MiB read budget',413);
        await fs.writeFile(path.join(staged,`${hash}.jsonl`),bytes,{flag:'wx'});
        const persisted=await fs.readFile(path.join(staged,`${hash}.jsonl`));
        if(hashBytes(persisted)!==hashBytes(bytes))throw new Error('Staged URL index failed its hash check');
        hashes[hash]=hashBytes(bytes);
      }
      await atomicJson(path.join(staged,'index-manifest.json'),{version:1,generation,references,corruptCount,urls:hashes});
      await atomicJson(path.join(this.runDir,'resource-url-index-current.json'),{version:1,generation});
    }catch(error){throw new EvidenceError('RESOURCE_INDEX_WRITE_FAILED',`URL index generation ${generation} remains unpublished after write/validation failure: ${String(error)}`,507);}
    return{generation,references,urls:byUrl.size,corrupt,corruptCount};
  }
  /** Manifest listing is bounded by count; callers use the next ID as cursor. */
  async list(limit = 128, after?: string): Promise<{ items: ArchivedResource[]; nextCursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new EvidenceError('INVALID_LIMIT', 'Resource limit must be 1..1000');
    if (after) checkedId(after);
    const names = (await fs.readdir(path.join(this.runDir, 'resources')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort();
    const selected = names.filter(name => !after || name > `${after}.json`).slice(0, limit + 1);
    const items = await Promise.all(selected.slice(0, limit).map(name => this.reference(name.slice(0, -5))));
    return { items, ...(selected.length > limit ? { nextCursor: items.at(-1)!.id } : {}) };
  }
}
