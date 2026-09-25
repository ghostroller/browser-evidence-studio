import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReplayPosition, ResourceReference, SourceValue } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import { EvidenceError } from '@/evidence/contracts';
import { atomicFile, atomicJson, exists, hashBytes, safeFile } from '@/evidence/files';
import type { EvidenceStore } from '@/evidence/store';
import { jsonLines } from '@/evidence/files';
import { credentialUrl } from '@/capture/url-privacy';
import { responsePrivacy } from '@/capture/privacy';

export const RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const RESOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
export function privateResourceUrl(value: string): boolean {
  try { new URL(value); return credentialUrl(value); }
  catch { return true; }
}
export interface ArchivedResource extends ResourceReference {
  capturedAt: string;
  bytes: number;
  source: { fromCache?: boolean; fromServiceWorker?: boolean; encodedDataLength?: number; redirectUrl?: string; byteRepresentation: 'decoded-response' };
}
export interface CaptureResourceInput {
  position: ReplayPosition; frameId: string; requestId?: string; url: string; mediaType: string;
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
      const privateUrl = privateResourceUrl(input.url);
      if (privateUrl) { status = 'redacted'; reason = 'credential-bearing-resource-url'; }
      else if (!isArchivableResource(input.mediaType)) { status = 'unsupported'; reason = 'resource-media-type-not-supported'; }
      else if ((suppliedBytes ?? 0) > RESOURCE_MAX_BYTES || this.writer.totalBytes + (suppliedBytes ?? 0) > RESOURCE_TOTAL_BYTES) { status = 'missing'; reason = 'resource-byte-budget'; }
      else if (data && responsePrivacy(data, input.mediaType).redacted) { status = 'redacted'; reason = 'credential-url-in-resource-body'; }
      if ((status === 'captured' || status === 'late-fetched') && !data) throw new EvidenceError('RESOURCE_BYTES_MISSING', 'Captured resources require their observed bytes');
      const originalUrl: SourceValue<string> = privateUrl ? { status: 'redacted', reason: reason! } : { status: 'present', value: input.url };
      const captured = status === 'captured' || status === 'late-fetched';
      const reference: ArchivedResource = { id: randomUUID(), position: { ...input.position }, frameId: input.frameId, ...(input.requestId ? { requestId: input.requestId } : {}), originalUrl,
        mediaType: input.mediaType, status, ...(reason ? { reason } : {}), ...(captured ? { blobHash: hashBytes(data!) } : {}), capturedAt: new Date().toISOString(), bytes: captured ? data!.length : 0,
        source: { ...input.source, ...(input.source?.redirectUrl && privateResourceUrl(input.source.redirectUrl) ? { redirectUrl: '[redacted]' } : {}), byteRepresentation: 'decoded-response' } };
      if (captured) {
        const directory = await ensureLocalDirectory(this.dataRoot, 'blobs');
        const filename = path.join(directory, reference.blobHash!);
        if (!await exists(filename)) await atomicFile(filename, data!);
        else if (hashBytes(await fs.readFile(await safeFile(this.dataRoot, `blobs/${reference.blobHash}`))) !== reference.blobHash) throw new EvidenceError('RESOURCE_INTEGRITY', 'Existing resource blob does not match its content hash', 409);
      }
      const directory = await ensureLocalDirectory(this.store.runDir, 'resources');
      await atomicJson(path.join(directory, `${reference.id}.json`), reference);
      await this.store.appendEvent({ type: 'resource-reference', source: 'resource-archive', pageId: input.position.pageId, data: reference });
      if(reference.originalUrl.status==='present'){
        const directory=await ensureLocalDirectory(this.store.runDir,'resource-url-index');
        await fs.appendFile(path.join(directory,hashBytes(reference.originalUrl.value)+'.jsonl'),JSON.stringify({id:reference.id,position:reference.position,frameId:reference.frameId})+'\n');
      }
      this.writer.totalBytes += reference.bytes;this.writer.references++; return reference;
    });
    this.writer.tail = task; return task;
  }
  async flush(): Promise<void> { await this.writer.tail; }
}

export class ResourceArchive {
  constructor(readonly runDir: string, readonly dataRoot = path.dirname(path.dirname(runDir))) {}
  async reference(id: string): Promise<ArchivedResource> {
    const file = await safeFile(this.runDir, `resources/${checkedId(id)}.json`);
    if ((await fs.stat(file)).size > 32 * 1024) throw new EvidenceError('RESOURCE_METADATA_BUDGET', 'Resource metadata exceeds budget');
    const reference = JSON.parse(await fs.readFile(file, 'utf8')) as ArchivedResource;
    parseReplayPosition(reference.position);
    if (reference.id !== id || typeof reference.frameId!=='string'||!reference.frameId||reference.frameId.length>512||!Number.isSafeInteger(reference.bytes)||reference.bytes<0||reference.bytes>RESOURCE_MAX_BYTES||typeof reference.mediaType!=='string'||reference.mediaType.length>200||!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(reference.mediaType)||!['captured','late-fetched','missing','redacted','unsupported','failed'].includes(reference.status)||!reference.originalUrl||!['present','redacted','absent','missing','unsupported'].includes(reference.originalUrl.status)||reference.originalUrl.status==='present'&&(typeof reference.originalUrl.value!=='string'||reference.originalUrl.value.length>16384)||reference.blobHash && !/^[a-f0-9]{64}$/.test(reference.blobHash)||(reference.status==='captured'||reference.status==='late-fetched')&&!reference.blobHash) throw new EvidenceError('INVALID_RESOURCE', 'Malformed resource reference');
    return reference;
  }
  async read(id: string): Promise<{ reference: ArchivedResource; bytes: Buffer }> {
    const reference = await this.reference(id);
    if (reference.status !== 'captured' || !reference.blobHash) throw new EvidenceError('RESOURCE_UNAVAILABLE', `Resource is ${reference.status}; no network fallback is allowed`, 404);
    const file = await safeFile(this.dataRoot, `blobs/${reference.blobHash}`);
    if ((await fs.stat(file)).size > RESOURCE_MAX_BYTES) throw new EvidenceError('RESOURCE_BYTE_BUDGET', 'Resource exceeds its bounded byte limit', 413);
    const bytes = await fs.readFile(file);
    if (bytes.length !== reference.bytes || hashBytes(bytes) !== reference.blobHash) throw new EvidenceError('RESOURCE_INTEGRITY', 'Archived resource hash or length mismatch', 409);
    return { reference, bytes };
  }
  async resolve(url:string,position:ReplayPosition,frameId='top'):Promise<ArchivedResource|undefined>{
    const relative=`resource-url-index/${hashBytes(url)}.jsonl`;
    if(!await exists(path.join(this.runDir,relative)))return undefined;
    const candidates:Array<{id:string;position:ReplayPosition;frameId:string}>=[];let count=0;
    for await(const line of jsonLines(await safeFile(this.runDir,relative))){
      if(++count>10000)throw new EvidenceError('RESOURCE_INDEX_BUDGET','Resource URL history exceeds bounded scan budget',413);
      if(line.invalid)throw new EvidenceError('RESOURCE_INDEX_CORRUPT','Resource URL index is incomplete; rebuild from resource-reference events',409);
      const entry=line.value as unknown as {id:string;position:ReplayPosition;frameId:string};
      parseReplayPosition(entry.position);
      if(entry.frameId===frameId&&entry.position.recordingId===position.recordingId&&entry.position.pageId===position.pageId&&entry.position.documentId===position.documentId&&entry.position.streamEpoch===position.streamEpoch&&entry.position.eventSeq<=position.eventSeq)candidates.push(entry);
    }
    let probeFailure:ArchivedResource|undefined;
    for(const selected of candidates.reverse().sort((a,b)=>b.position.eventSeq-a.position.eventSeq)){
      const reference=await this.reference(selected.id);
      if(reference.originalUrl.status!=='present'||reference.originalUrl.value!==url||!sameReplayPosition(reference.position,selected.position)||reference.frameId!==selected.frameId||reference.frameId!==frameId)throw new EvidenceError('RESOURCE_INDEX_MISMATCH','Resource URL index does not match its immutable manifest',409);
      // A cache probe returning no bytes is an observation failure, not a new
      // resource version. Keep its original, but never let it erase an actual
      // request's captured OR failed version at this historical position.
      if(reference.source.fromCache&&!reference.requestId&&['failed','missing'].includes(reference.status)){probeFailure??=reference;continue;}
      return reference;
    }
    return probeFailure;
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
