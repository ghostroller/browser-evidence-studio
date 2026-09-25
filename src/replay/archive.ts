import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReplayPosition, RecordingGap } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import type { RecordingEnvelope, RawReceipt } from '@/capture/recording-types';
import { sameStream } from '@/capture/recording-types';
import { EvidenceError } from '@/evidence/contracts';
import { atomicJson, hashBytes, jsonLines, readSlice, safeFile } from '@/evidence/files';
import type { EvidenceStore } from '@/evidence/store';

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
function entryPath(position: ReplayPosition): string { return `replay-index/${streamKey(position)}/${position.eventSeq}.json`; }
function invalid(message: string): never { throw new EvidenceError('INVALID_REPLAY', message, 409); }
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

async function writeTimeline(runDir:string,entry:Entry,record:RecordingEnvelope):Promise<void>{
  const directory=path.join(runDir,'replay-index',streamKey(entry.position));
  const filename=path.join(directory,'positions.bin');
  const row=Buffer.alloc(24);row.writeDoubleLE(entry.position.sourceTimeMs,0);row.writeDoubleLE(entry.position.eventSeq,8);row.writeInt32LE(record.event.type,16);row.writeInt32LE(record.event.type===3?record.event.data.source:-1,20);
  const handle=await fs.open(filename,'r+').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return fs.open(filename,'wx+');throw error;});
  try{await handle.write(row,0,row.length,entry.ordinal*24);}finally{await handle.close();}
  await atomicJson(path.join(directory,'stream.json'),{first:entry.first,last:entry.position,events:entry.ordinal+1,monotonicTime:entry.monotonicTime});
}

export class RecordingArchive {
  constructor(readonly runDir: string) {}
  async streams(limit=100,after?:string):Promise<{items:RecordingStream[];nextCursor?:string}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)invalid('Stream limit must be 1..1000');
    if(after&&!/^[a-f0-9]{64}$/.test(after))invalid('Invalid stream cursor');
    if(after){const manifest=JSON.parse(await fs.readFile(await safeFile(this.runDir,'manifest.json'),'utf8')) as {status:string};if(manifest.status!=='sealed')throw new EvidenceError('ACTIVE_STREAM_CURSOR','Paginated stream enumeration requires a sealed recording; refresh the active first page.',409);}
    const directory=await fs.opendir(path.join(this.runDir,'replay-index'));
    const keys:string[]=[];
    for await(const entry of directory){
      if(!/^[a-f0-9]{64}$/.test(entry.name)||after&&entry.name<=after)continue;
      keys.push(entry.name);keys.sort();if(keys.length>limit+1)keys.pop();
    }
    const items:RecordingStream[]=[];
    for(const key of keys.slice(0,limit)){const file=await safeFile(this.runDir,`replay-index/${key}/stream.json`);if((await fs.stat(file)).size>4096)invalid('Stream descriptor exceeds budget');const descriptor=checkedStream(JSON.parse(await fs.readFile(file,'utf8')));if(streamKey(descriptor.first)!==key)invalid('Stream descriptor identity mismatch');items.push(descriptor);}
    return{items,...(keys.length>limit?{nextCursor:keys[limit-1]}:{})};
  }
  async positions(stream:ReplayPosition,limit=100,ordinal=0):Promise<{items:Array<{position:ReplayPosition;type:number;source:number}>;nextOrdinal?:number}>{
    const descriptor=await this.stream(stream);
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>descriptor.events)invalid('Invalid position query range');
    const count=Math.min(limit,descriptor.events-ordinal),data=await readSlice(this.runDir,`replay-index/${streamKey(stream)}/positions.bin`,ordinal*24,count*24);
    if(data.length!==count*24)invalid('Position index is truncated; rebuild required');
    const items=Array.from({length:count},(_,index)=>({position:parseReplayPosition({...descriptor.first,sourceTimeMs:data.readDoubleLE(index*24),eventSeq:data.readDoubleLE(index*24+8)}),type:data.readInt32LE(index*24+16),source:data.readInt32LE(index*24+20)}));
    for(let index=0;index<items.length;index++){const item=items[index];if(item.type<0||item.type>6||item.source< -1||item.source>16||item.position.eventSeq<descriptor.first.eventSeq||item.position.eventSeq>descriptor.last.eventSeq||index>0&&items[index-1].position.eventSeq>=item.position.eventSeq)invalid('Malformed position index row');}
    return{items,...(ordinal+count<descriptor.events?{nextOrdinal:ordinal+count}:{})};
  }
  async resolveTime(stream:ReplayPosition,sourceTimeMs:number):Promise<ReplayPosition>{
    const descriptor=await this.stream(stream);
    if(!Number.isFinite(sourceTimeMs)||!descriptor.monotonicTime)invalid('Time seek requires a finite timestamp and a monotonic source clock; choose an explicit event position');
    let low=0,high=descriptor.events-1,selected:ReplayPosition|undefined;
    while(low<=high){const mid=Math.floor((low+high)/2),item=(await this.positions(stream,1,mid)).items[0];if(item.position.sourceTimeMs<=sourceTimeMs){selected=item.position;low=mid+1;}else high=mid-1;}
    if(!selected)invalid('Requested time precedes this stream');
    await this.window(selected);return selected;
  }
  private async stream(position:ReplayPosition):Promise<RecordingStream>{
    parseReplayPosition(position);const file=await safeFile(this.runDir,`replay-index/${streamKey(position)}/stream.json`);
    if((await fs.stat(file)).size>4096)invalid('Stream descriptor exceeds budget');
    const descriptor=checkedStream(JSON.parse(await fs.readFile(file,'utf8')));
    if(!sameStream(descriptor.first,position)||!Number.isSafeInteger(descriptor.events)||descriptor.events<1)invalid('Malformed stream descriptor');return descriptor;
  }
  async window(position: ReplayPosition, signal?: AbortSignal): Promise<ReplayWindow> {
    parseReplayPosition(position); signal?.throwIfAborted();
    const target = await this.entry(position);
    if (target.baseline === null) throw new EvidenceError('REPLAY_GAP', 'No bounded full snapshot exists before this event; inspect gaps or choose a later baseline.', 409);
    if (target.windowBytes > REPLAY_MAX_WINDOW_BYTES || target.windowEvents > REPLAY_MAX_WINDOW_EVENTS || position.eventSeq - target.baseline >= REPLAY_MAX_WINDOW_EVENTS) invalid('Replay window exceeds its budget');
    const records: RecordingEnvelope[] = []; let readBytes = 0;
    const slots: Entry[] = [];
    for (let seq = position.eventSeq; seq >= target.baseline;) {
      signal?.throwIfAborted();
      const slot = seq === position.eventSeq ? target : await this.entry({ ...position, eventSeq: seq }, false);
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
    const entry = await this.entry(position); return { gaps: entry.gaps, baselineSeq: entry.baseline };
  }
  private async entry(position: ReplayPosition, exactTime = true): Promise<Entry> {
    const file = await safeFile(this.runDir, entryPath(position));
    if ((await fs.stat(file)).size > 128 * 1024) invalid('Replay index entry exceeds budget');
    const entry = JSON.parse(await fs.readFile(file, 'utf8')) as Entry;
    if (entry.version !== 2 || !sameStream(entry.position, position) || entry.position.eventSeq !== position.eventSeq || exactTime && entry.position.sourceTimeMs !== position.sourceTimeMs) invalid('Replay position does not match its index');
    if (!entry.receipt || !Number.isSafeInteger(entry.receipt.offset) || entry.receipt.offset < 0 || !Number.isSafeInteger(entry.receipt.bytes) || entry.receipt.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.receipt.sha256) || !Array.isArray(entry.gaps)) invalid('Malformed replay index receipt');
    return entry;
  }
  /** Maintenance-only streaming rebuild; queries never call this implicitly.
   * Damaged raw tails are reported and never repaired or removed here. */
  async rebuild(): Promise<{ records: number; corruptCount: number; corrupt: Array<{ file: string; offset: number; reason: string }> }> {
    const previous = new Map<string, Entry>(), corrupt: Array<{ file: string; offset: number; reason: string }> = [];
    let records = 0, corruptCount=0;
    const report=(item:{file:string;offset:number;reason:string})=>{corruptCount++;if(corrupt.length<128)corrupt.push(item);};
    const files = (await fs.readdir(path.join(this.runDir, 'raw', 'rrweb'))).filter(name => /^rrweb-\d{6}\.jsonl$/.test(name)).sort();
    for (const name of files) {
      const relative = `raw/rrweb/${name}`;
      for await (const line of jsonLines(await safeFile(this.runDir, relative))) {
        if (line.invalid) { report({ file: relative, offset: line.offset, reason: line.invalid }); continue; }
        const raw = line.value!, record = raw.payload as RecordingEnvelope | undefined;
        if (record?.formatVersion !== 2) continue;
        try {
          checkRecord(record);
          const bytes = await readSlice(this.runDir, relative, line.offset, line.bytes), key = streamKey(record.position);
          const receipt = { id: String(raw.id), sequence: Number(raw.sequence), file: relative, offset: line.offset, bytes: line.bytes, sha256: hashBytes(bytes) };
          const entry = project(record, receipt, previous.get(key));
          await atomicJson(path.join(this.runDir, entryPath(record.position)), entry);
          await writeTimeline(this.runDir,entry,record);
          previous.set(key, entry); records++;
          for(const [oldKey,old] of previous)if(oldKey!==key&&old.position.pageId===record.position.pageId)previous.delete(oldKey);
          if(previous.size>256)previous.delete(previous.keys().next().value!);
        } catch (error) { report({ file: relative, offset: line.offset, reason: String(error) }); }
      }
    }
    return { records, corruptCount, corrupt };
  }
}
function checkedStream(input:unknown):RecordingStream{
  if(!input||typeof input!=='object')invalid('Malformed stream descriptor');const value=input as RecordingStream;
  parseReplayPosition(value.first);parseReplayPosition(value.last);
  if(!sameStream(value.first,value.last)||!Number.isSafeInteger(value.events)||value.events<1||value.events>100_000_000||value.first.eventSeq>value.last.eventSeq||typeof value.monotonicTime!=='boolean')invalid('Malformed stream descriptor');
  return value;
}
