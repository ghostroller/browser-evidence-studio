import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ReplayPosition, RecordingGap } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import type { RecordingEnvelope, RawReceipt } from '@/capture/recording-types';
import { sameStream } from '@/capture/recording-types';
import { EvidenceError } from '@/evidence/contracts';
import { EvidenceReader } from '@/evidence/reader';
import { atomicJson, hashBytes, jsonLines, readSlice, safeFile } from '@/evidence/files';
import type { EvidenceStore } from '@/evidence/store';
import { inspectWriterLock } from '@/evidence/writer-lock';

export const REPLAY_MAX_EVENT_BYTES = 16 * 1024 * 1024;
export const REPLAY_MAX_WINDOW_BYTES = 64 * 1024 * 1024;
export const REPLAY_MAX_WINDOW_EVENTS = 4096;
interface Entry {
  version: 2; position: ReplayPosition; receipt: RawReceipt; baseline: number | null;
  previousSeq?: number; windowBytes: number; windowEvents: number; gaps: RecordingGap[];
  ordinal: number;
  first: ReplayPosition;
  monotonicTime: boolean;
}
export interface RecordingStream { first: ReplayPosition; last: ReplayPosition; events: number; monotonicTime: boolean }
export interface ForegroundTransition { sequence: number; pageId: string | null; observedAtMs: number; transitionOrdinal: number; reason: string }
export interface ReplayWindow {
  position: ReplayPosition;
  records: RecordingEnvelope[];
  gaps: RecordingGap[];
  readBytes: number;
  baselineSeq: number;
}
function streamKey(position: ReplayPosition): string {
  return createHash('sha256').update(JSON.stringify([position.recordingId, position.pageId, position.documentId, position.streamEpoch])).digest('hex');
}
function entryPath(position: ReplayPosition, prefix = 'replay-index'): string { return `${prefix}/${streamKey(position)}/${position.eventSeq}.json`; }
const generationFile = 'replay-index-current.json';
async function indexPrefix(runDir: string): Promise<string> {
  let pointer: { version?: number; generation?: string };
  try { pointer = JSON.parse(await fs.readFile(await safeFile(runDir, generationFile), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT'){try{await fs.stat(path.join(runDir,'replay-index-generations'));throw new EvidenceError('REPLAY_INDEX_MISSING','Replay generation pointer is missing; directed recovery required',409);}catch(problem){if((problem as NodeJS.ErrnoException).code==='ENOENT')return 'replay-index';throw problem;}} throw new EvidenceError(error instanceof SyntaxError?'REPLAY_INDEX_CORRUPT':'REPLAY_INDEX_READ_FAILED', `Cannot read replay index generation: ${String(error)}`, 409); }
  if (pointer.version !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.generation ?? '')) invalid('Malformed replay index generation pointer');
  const prefix = `replay-index-generations/${pointer.generation}`;
  try {
    const manifest = JSON.parse(await fs.readFile(await safeFile(runDir, `${prefix}/index-manifest.json`), 'utf8')) as { version: number; generation: string; records: number };
    if (manifest.version !== 1 || manifest.generation !== pointer.generation || !Number.isSafeInteger(manifest.records)) invalid('Malformed replay index generation manifest');
  } catch (error) { if(error instanceof EvidenceError)throw error;throw new EvidenceError((error as NodeJS.ErrnoException).code==='ENOENT'?'REPLAY_INDEX_MISSING':error instanceof SyntaxError?'REPLAY_INDEX_CORRUPT':'REPLAY_INDEX_READ_FAILED', `Published replay index generation is unavailable: ${String(error)}`, 409); }
  return prefix;
}
function invalid(message: string): never { throw new EvidenceError('INVALID_REPLAY', message, 409); }
async function savedIndexFile(runDir:string,relative:string):Promise<string>{
  try{return await safeFile(runDir,relative);}
  catch(error){throw new EvidenceError((error as NodeJS.ErrnoException).code==='ENOENT'?'REPLAY_INDEX_MISSING':'REPLAY_INDEX_READ_FAILED',`Cannot open replay index ${relative}: ${String(error)}`,409);}
}
function checkRecord(record: RecordingEnvelope): void {
  const position = parseReplayPosition(record.position);
  if (record.formatVersion !== 2 || !record.event || record.event.timestamp !== position.sourceTimeMs || !Array.isArray(record.metadata) || !Array.isArray(record.gaps)) invalid('Malformed format-2 recording record');
}
function gap(record: RecordingEnvelope, from: ReplayPosition, category: RecordingGap['category'], reason: string): RecordingGap {
  return { id: `${record.position.streamEpoch}-${record.position.eventSeq}-${category}-${reason}`, from, category, reason };
}

/** Incremental, replaceable projection over durable raw records. It retains only
 * one entry per active stream; event payloads leave memory after persistence.
 * The exact event slot points to a bounded full-snapshot window, never an archive
 * sized array. Missing/corrupt projections are rebuilt explicitly from originals. */
export class RecordingIndexWriter {
  private previous = new Map<string, Entry>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: EvidenceStore) {}
  append(record: RecordingEnvelope): Promise<ReplayPosition> {
    checkRecord(record);
    const work = this.tail.then(async () => {
      const key = streamKey(record.position), previous = this.previous.get(key);
      if (previous && record.position.eventSeq <= previous.position.eventSeq) invalid('Recording source sequence must increase');
      const receipt = await this.store.appendRaw('rrweb', { ...record, pageId: record.position.pageId, isTop: true });
      const entry = project(record, receipt, previous);
      await atomicJson(path.join(this.store.runDir, entryPath(record.position)), entry);
      await writeTimeline(this.store.runDir,entry,record);
      this.previous.set(key, entry);
      // Navigation releases obsolete document state. Other page writers own their own maps.
      for (const [oldKey, old] of this.previous) if (old.position.pageId === record.position.pageId && oldKey !== key) this.previous.delete(oldKey);
      return record.position;
    });
    this.tail = work;
    return work;
  }
  async flush(): Promise<void> { await this.tail; }
}

function project(record: RecordingEnvelope, receipt: RawReceipt, previous?: Entry): Entry {
  const full = record.event.type === 2;
  const inherited = previous?.gaps.filter(item => !item.to) ?? [];
  const gaps = [...inherited, ...record.gaps];
  if (previous && record.position.eventSeq !== previous.position.eventSeq + 1 && !record.gaps.some(item => item.category === 'sampling' && item.from.eventSeq <= previous.position.eventSeq + 1 && (item.to?.eventSeq ?? -1) >= record.position.eventSeq - 1)) gaps.push(gap(record, previous.position, 'structure', 'source-sequence-gap'));
  if (!record.metadataComplete) gaps.push(gap(record, previous?.position ?? record.position, 'metadata', 'source-metadata-incomplete'));
  let baseline = full ? record.position.eventSeq : previous?.baseline ?? null;
  const windowBytes = (full ? 0 : previous?.windowBytes ?? 0) + receipt.bytes;
  const windowEvents = (full ? 0 : previous?.windowEvents ?? 0) + 1;
  if (windowBytes > REPLAY_MAX_WINDOW_BYTES || windowEvents > REPLAY_MAX_WINDOW_EVENTS) {
    baseline = null;
    gaps.push(gap(record, previous?.position ?? record.position, 'structure', 'replay-window-budget-new-snapshot-required'));
  }
  // A complete full snapshot is a new reliable point, not proof that the previous
  // interval was complete. Earlier immutable entries continue to expose its gap.
  const currentGaps = full && record.metadataComplete ? record.gaps.filter(item => item.category !== 'structure' && item.category !== 'metadata') : gaps;
  const unique = [...new Map(currentGaps.map(item => [item.id, item])).values()];
  if (unique.length > 128) invalid('Too many recording gaps in one snapshot interval');
  return { version: 2, position: record.position, receipt, baseline, previousSeq: previous?.position.eventSeq, windowBytes, windowEvents, gaps: unique,
    ordinal:(previous?.ordinal??-1)+1,first:previous?.first??record.position,monotonicTime:(previous?.monotonicTime??true)&&(!previous||record.position.sourceTimeMs>=previous.position.sourceTimeMs) };
}

async function writeTimeline(runDir:string,entry:Entry,record:RecordingEnvelope,prefix='replay-index'):Promise<void>{
  const directory=path.join(runDir,prefix,streamKey(entry.position));
  const filename=path.join(directory,'positions.bin');
  const row=Buffer.alloc(24);row.writeDoubleLE(entry.position.sourceTimeMs,0);row.writeDoubleLE(entry.position.eventSeq,8);row.writeInt32LE(record.event.type,16);row.writeInt32LE(record.event.type===3?record.event.data.source:-1,20);
  const handle=await fs.open(filename,'r+').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return fs.open(filename,'wx+');throw error;});
  try{await handle.write(row,0,row.length,entry.ordinal*24);}finally{await handle.close();}
  await atomicJson(path.join(directory,'stream.json'),{first:entry.first,last:entry.position,events:entry.ordinal+1,monotonicTime:entry.monotonicTime});
}

export class RecordingArchive {
  constructor(readonly runDir: string) {}
  /** Host-owned page selection history. Legacy recordings have no such history;
   * rrweb stream timestamps alone cannot identify the foreground page. */
  async foreground(limit=50,cursor?:string):Promise<{status:'recorded'|'legacy';items:ForegroundTransition[];nextCursor?:string}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid('Foreground transition limit must be 1..100');
    const page=await new EvidenceReader(this.runDir).events({types:['page-foreground'],limit,cursor,maxBytes:28672});
    const items=page.items.map(value=>{
      const event=value as {sequence?:unknown;pageId?:unknown;source?:unknown;occurredAt?:unknown;timeBasis?:unknown;data?:unknown};
      const data=event.data as Record<string,unknown>|undefined;
      if(!Number.isSafeInteger(event.sequence)||event.source!=='electron'||event.timeBasis!=='host-wall-clock'||!data||data.version!==1||
        !Number.isSafeInteger(data.observedAtMs)||Number(data.observedAtMs)<0||!Number.isSafeInteger(data.transitionOrdinal)||Number(data.transitionOrdinal)<1||
        (data.selectedPageId!==null&&typeof data.selectedPageId!=='string')||
        (event.pageId!==undefined&&event.pageId!==data.selectedPageId)||typeof data.reason!=='string'||
        typeof event.occurredAt!=='string'||Date.parse(event.occurredAt)!==data.observedAtMs)invalid('Malformed foreground transition');
      return {sequence:event.sequence as number,pageId:data.selectedPageId as string|null,observedAtMs:data.observedAtMs as number,transitionOrdinal:data.transitionOrdinal as number,reason:data.reason as string};
    });
    for(let index=1;index<items.length;index++)if(items[index].transitionOrdinal<=items[index-1].transitionOrdinal||items[index].observedAtMs<items[index-1].observedAtMs)invalid('Foreground transitions are out of order');
    return {status:items.length?'recorded':'legacy',items,...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
  }
  async streams(limit=100,after?:string):Promise<{items:RecordingStream[];nextCursor?:string}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)invalid('Stream limit must be 1..1000');
    const prefix=await indexPrefix(this.runDir),generation=prefix==='replay-index'?'legacy':prefix.split('/')[1];
    let afterKey:string|undefined;
    if(after){const match=/^(legacy|[a-f0-9-]{36}):([a-f0-9]{64})$/.exec(after);if(!match)invalid('Invalid stream cursor');if(match[1]!==generation)throw new EvidenceError('REPLAY_INDEX_GENERATION_CHANGED','Replay index generation changed; restart stream enumeration',409);afterKey=match[2];}
    if(after){const manifest=JSON.parse(await fs.readFile(await safeFile(this.runDir,'manifest.json'),'utf8')) as {status:string};if(manifest.status!=='sealed')throw new EvidenceError('ACTIVE_STREAM_CURSOR','Paginated stream enumeration requires a sealed recording; refresh the active first page.',409);}
    const directory=await fs.opendir(path.join(this.runDir,prefix));
    const keys:string[]=[];
    for await(const entry of directory){
      if(!/^[a-f0-9]{64}$/.test(entry.name)||afterKey&&entry.name<=afterKey)continue;
      keys.push(entry.name);keys.sort();if(keys.length>limit+1)keys.pop();
    }
    const items:RecordingStream[]=[];
    for(const key of keys.slice(0,limit)){const file=await savedIndexFile(this.runDir,`${prefix}/${key}/stream.json`);if((await fs.stat(file)).size>4096)invalid('Stream descriptor exceeds budget');const descriptor=checkedStream(JSON.parse(await fs.readFile(file,'utf8')));if(streamKey(descriptor.first)!==key)invalid('Stream descriptor identity mismatch');items.push(descriptor);}
    return{items,...(keys.length>limit?{nextCursor:`${generation}:${keys[limit-1]}`}:{})};
  }
  async positions(stream:ReplayPosition,limit=100,ordinal=0):Promise<{items:Array<{position:ReplayPosition;type:number;source:number}>;nextOrdinal?:number}>{
    return this.readPositions(stream,limit,ordinal,await indexPrefix(this.runDir));
  }
  private async readPositions(stream:ReplayPosition,limit:number,ordinal:number,prefix:string):Promise<{items:Array<{position:ReplayPosition;type:number;source:number}>;nextOrdinal?:number}>{
    const descriptor=await this.stream(stream,prefix);
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>descriptor.events)invalid('Invalid position query range');
    const count=Math.min(limit,descriptor.events-ordinal);
    await savedIndexFile(this.runDir,`${prefix}/${streamKey(stream)}/positions.bin`);
    let data:Buffer;try{data=await readSlice(this.runDir,`${prefix}/${streamKey(stream)}/positions.bin`,ordinal*24,count*24);}
    catch(error){throw new EvidenceError('REPLAY_INDEX_READ_FAILED',`Cannot read replay positions: ${String(error)}`,409);}
    if(data.length!==count*24)invalid('Position index is truncated; rebuild required');
    const items=Array.from({length:count},(_,index)=>({position:parseReplayPosition({...descriptor.first,sourceTimeMs:data.readDoubleLE(index*24),eventSeq:data.readDoubleLE(index*24+8)}),type:data.readInt32LE(index*24+16),source:data.readInt32LE(index*24+20)}));
    for(let index=0;index<items.length;index++){const item=items[index];if(item.type<0||item.type>6||item.source< -1||item.source>16||item.position.eventSeq<descriptor.first.eventSeq||item.position.eventSeq>descriptor.last.eventSeq||index>0&&items[index-1].position.eventSeq>=item.position.eventSeq)invalid('Malformed position index row');}
    return{items,...(ordinal+count<descriptor.events?{nextOrdinal:ordinal+count}:{})};
  }
  async resolveTime(stream:ReplayPosition,sourceTimeMs:number):Promise<ReplayPosition>{
    const prefix=await indexPrefix(this.runDir),descriptor=await this.stream(stream,prefix);
    if(!Number.isFinite(sourceTimeMs)||!descriptor.monotonicTime)invalid('Time seek requires a finite timestamp and a monotonic source clock; choose an explicit event position');
    let low=0,high=descriptor.events-1,selected:ReplayPosition|undefined;
    while(low<=high){const mid=Math.floor((low+high)/2),item=(await this.readPositions(stream,1,mid,prefix)).items[0];if(item.position.sourceTimeMs<=sourceTimeMs){selected=item.position;low=mid+1;}else high=mid-1;}
    if(!selected)invalid('Requested time precedes this stream');
    await this.windowAt(selected,prefix);return selected;
  }
  private async stream(position:ReplayPosition,prefix:string):Promise<RecordingStream>{
    parseReplayPosition(position);const file=await savedIndexFile(this.runDir,`${prefix}/${streamKey(position)}/stream.json`);
    if((await fs.stat(file)).size>4096)invalid('Stream descriptor exceeds budget');
    const descriptor=checkedStream(JSON.parse(await fs.readFile(file,'utf8')));
    if(!sameStream(descriptor.first,position)||!Number.isSafeInteger(descriptor.events)||descriptor.events<1)invalid('Malformed stream descriptor');return descriptor;
  }
  async window(position: ReplayPosition, signal?: AbortSignal): Promise<ReplayWindow> {
    return this.windowAt(position,await indexPrefix(this.runDir),signal);
  }
  private async windowAt(position:ReplayPosition,prefix:string,signal?:AbortSignal):Promise<ReplayWindow>{
    parseReplayPosition(position); signal?.throwIfAborted();
    const target = await this.entry(position,prefix);
    if (target.baseline === null) throw new EvidenceError('REPLAY_GAP', 'No bounded full snapshot exists before this event; inspect gaps or choose a later baseline.', 409);
    if (target.windowBytes > REPLAY_MAX_WINDOW_BYTES || target.windowEvents > REPLAY_MAX_WINDOW_EVENTS || position.eventSeq - target.baseline >= REPLAY_MAX_WINDOW_EVENTS) invalid('Replay window exceeds its budget');
    const records: RecordingEnvelope[] = []; let readBytes = 0;
    const slots: Entry[] = [];
    for (let seq = position.eventSeq; seq >= target.baseline;) {
      signal?.throwIfAborted();
      const slot = seq === position.eventSeq ? target : await this.entry({ ...position, eventSeq: seq }, prefix,false);
      slots.push(slot);
      if(slots.length > REPLAY_MAX_WINDOW_EVENTS) invalid('Replay window event count exceeds budget');
      if (slot.receipt.bytes > REPLAY_MAX_EVENT_BYTES || readBytes + slot.receipt.bytes > REPLAY_MAX_WINDOW_BYTES) invalid('Replay record exceeds its read budget');
      const bytes = await readSlice(this.runDir, slot.receipt.file, slot.receipt.offset, slot.receipt.bytes);
      readBytes += bytes.length;
      if (bytes.length !== slot.receipt.bytes || hashBytes(bytes) !== slot.receipt.sha256) invalid('Original recording bytes are missing, truncated, or changed');
      const raw = JSON.parse(bytes.toString('utf8')) as { payload: RecordingEnvelope; id: string; sequence: number };
      const record = raw.payload; checkRecord(record);
      if (raw.id !== slot.receipt.id || raw.sequence !== slot.receipt.sequence || !sameStream(record.position, position) || !sameReplayPosition(record.position,slot.position) || record.position.eventSeq !== seq) invalid('Recording slot does not identify the requested original event');
      records.push(record);
      if(seq===target.baseline)break;
      if(slot.previousSeq===undefined||!Number.isSafeInteger(slot.previousSeq)||slot.previousSeq>=seq||slot.previousSeq<target.baseline)invalid('Replay index has a missing event predecessor');
      seq=slot.previousSeq;
    }
    signal?.throwIfAborted();
    records.reverse(); slots.reverse();
    if (records[0]?.event.type !== 2) invalid('Replay baseline is not a full snapshot');
    let checked: Entry | undefined;
    for(let index=0;index<records.length;index++)checked=project(records[index],slots[index].receipt,checked);
    return { position, records, gaps: checked!.gaps, readBytes, baselineSeq: target.baseline };
  }
  async status(position: ReplayPosition): Promise<{ gaps: RecordingGap[]; baselineSeq: number | null }> {
    const entry = await this.entry(position,await indexPrefix(this.runDir)); return { gaps: entry.gaps, baselineSeq: entry.baseline };
  }
  private async entry(position: ReplayPosition,prefix:string, exactTime = true): Promise<Entry> {
    const file = await savedIndexFile(this.runDir, entryPath(position,prefix));
    if ((await fs.stat(file)).size > 128 * 1024) invalid('Replay index entry exceeds budget');
    const entry = JSON.parse(await fs.readFile(file, 'utf8')) as Entry;
    if (entry.version !== 2 || !sameStream(entry.position, position) || entry.position.eventSeq !== position.eventSeq || exactTime && entry.position.sourceTimeMs !== position.sourceTimeMs) invalid('Replay position does not match its index');
    if (!entry.receipt || !Number.isSafeInteger(entry.receipt.offset) || entry.receipt.offset < 0 || !Number.isSafeInteger(entry.receipt.bytes) || entry.receipt.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.receipt.sha256) || !Array.isArray(entry.gaps)) invalid('Malformed replay index receipt');
    return entry;
  }
  /** Maintenance-only streaming rebuild; queries never call this implicitly.
   * Damaged raw tails are reported and never repaired or removed here. */
  async rebuild(): Promise<{ records: number; corruptCount: number; corrupt: Array<{ file: string; offset: number; reason: string }> }> {
    const ownership=await inspectWriterLock(this.runDir);
    if(ownership.state!=='unlocked')throw new EvidenceError('ACTIVE_INDEX_REBUILD',`Replay recovery requires an unlocked writer (${ownership.state})`,409);
    const previous = new Map<string, Entry>(), corrupt: Array<{ file: string; offset: number; reason: string }> = [];
    let records = 0, corruptCount=0;
    const report=(item:{file:string;offset:number;reason:string})=>{corruptCount++;if(corrupt.length<128)corrupt.push(item);};
    const generation = randomUUID(), prefix = `replay-index-generations/${generation}`;
    try{await fs.mkdir(path.join(this.runDir,prefix),{recursive:true});}
    catch(error){throw new EvidenceError('REPLAY_INDEX_WRITE_FAILED',`Cannot stage replay index generation ${generation}: ${String(error)}`,507);}
    let files: string[];
    try { files = (await fs.readdir(path.join(this.runDir, 'raw', 'rrweb'))).filter(name => /^rrweb-\d{6}\.jsonl$/.test(name)).sort(); }
    catch(error) { throw new EvidenceError('REPLAY_ORIGINAL_READ_FAILED',`Cannot enumerate original recordings: ${String(error)}`,409); }
    try { for (const name of files) {
      const relative = `raw/rrweb/${name}`;
      let source: string;
      try { source = await safeFile(this.runDir, relative); }
      catch(error) { throw new EvidenceError('REPLAY_ORIGINAL_READ_FAILED',`Cannot open ${relative}: ${String(error)}`,409); }
      for await (const line of jsonLines(source)) {
        if (line.invalid) { report({ file: relative, offset: line.offset, reason: line.invalid }); continue; }
        const raw = line.value!, record = raw.payload as RecordingEnvelope | undefined;
        if (record?.formatVersion !== 2) continue;
        let entry: Entry;
        try {
          checkRecord(record);
          const key = streamKey(record.position);
          let bytes: Buffer;
          try { bytes = await readSlice(this.runDir, relative, line.offset, line.bytes); }
          catch(error) { throw new EvidenceError('REPLAY_ORIGINAL_READ_FAILED',`Cannot read ${relative} at ${line.offset}: ${String(error)}`,409); }
          if(bytes.length!==line.bytes)throw new Error('Original recording line was truncated during recovery');
          const receipt = { id: String(raw.id), sequence: Number(raw.sequence), file: relative, offset: line.offset, bytes: line.bytes, sha256: hashBytes(bytes) };
          entry = project(record, receipt, previous.get(key));
        } catch (error) { if(error instanceof EvidenceError&&error.code==='REPLAY_ORIGINAL_READ_FAILED')throw error;report({ file: relative, offset: line.offset, reason: String(error) }); continue; }
        try {
          await atomicJson(path.join(this.runDir, entryPath(record.position,prefix)), entry);
          await writeTimeline(this.runDir,entry,record,prefix);
        } catch(error) { throw new EvidenceError('REPLAY_INDEX_WRITE_FAILED',`Replay index generation ${generation} remains unpublished after write failure: ${String(error)}`,507); }
        previous.set(streamKey(record.position), entry); records++;
        if(previous.size>256)throw new EvidenceError('REPLAY_INDEX_BUDGET','Replay recovery exceeds 256 concurrent source streams',413);
        if(records>1_000_000)throw new EvidenceError('REPLAY_INDEX_BUDGET','Replay recovery exceeds one million events',413);
      }
      }
    } catch(error) { if(error instanceof EvidenceError)throw error; throw new EvidenceError('REPLAY_ORIGINAL_READ_FAILED',`Cannot scan original recordings: ${String(error)}`,409); }
    try {
      for(const [key,entry] of previous){const descriptor=checkedStream(JSON.parse(await fs.readFile(await safeFile(this.runDir,`${prefix}/${key}/stream.json`),'utf8')));if(descriptor.events!==entry.ordinal+1||(await fs.stat(await safeFile(this.runDir,`${prefix}/${key}/positions.bin`))).size!==descriptor.events*24)invalid('Rebuilt replay timeline is incomplete');}
      await atomicJson(path.join(this.runDir,prefix,'index-manifest.json'),{version:1,generation,records,streams:previous.size,corruptCount});
      await atomicJson(path.join(this.runDir,generationFile),{version:1,generation});
    } catch(error) { throw new EvidenceError('REPLAY_INDEX_WRITE_FAILED',`Replay index generation ${generation} remains unpublished after validation/publication failure: ${String(error)}`,507); }
    return { records, corruptCount, corrupt };
  }
}
function checkedStream(input:unknown):RecordingStream{
  if(!input||typeof input!=='object')invalid('Malformed stream descriptor');const value=input as RecordingStream;
  parseReplayPosition(value.first);parseReplayPosition(value.last);
  if(!sameStream(value.first,value.last)||!Number.isSafeInteger(value.events)||value.events<1||value.events>100_000_000||value.first.eventSeq>value.last.eventSeq||typeof value.monotonicTime!=='boolean')invalid('Malformed stream descriptor');
  return value;
}
