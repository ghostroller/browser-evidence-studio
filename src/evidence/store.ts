import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Artifact, ArtifactInput, Checkpoint, CheckpointInput, EvidenceError, EvidenceEvent, EventInput, IndexEntry, RecordKind, RunInput, RunManifest } from './contracts';
import { atomicFile, atomicJson, exists, hashBytes, jsonLines, readSlice, safeFile } from './files';
import { EvidenceIndex, evidenceSources, rebuildIndex, type CorruptRecord } from './index';
import { claimWriterLock, type WriterLockHandle } from './writer-lock';

export interface StoreOptions { chunkBytes?: number; maxPendingBytes?: number; }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function captureContent(data: ArtifactInput['data'], input: Omit<ArtifactInput, 'data'>): { content?: Buffer; originalBytes?: number; truncated: boolean } {
  if (data === undefined) return { truncated: false };
  const original = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let capturedBytes = Math.min(original.length, input.limitBytes ?? original.length);
  if (capturedBytes < original.length && /(^text\/|json|javascript|xml|svg)/i.test(input.mediaType)) {
    while (capturedBytes > 0 && (original[capturedBytes] & 0xc0) === 0x80) capturedBytes--;
  }
  return { content: Buffer.from(original.subarray(0, capturedBytes)), originalBytes: original.length, truncated: capturedBytes < original.length };
}

async function unreportedCorruption(runDir: string, corrupt: CorruptRecord[]): Promise<CorruptRecord[]> {
  if (!corrupt.length) return [];
  const preserved = new Map<string, string[]>();
  const key = (file: string, offset: number, bytes: number) => JSON.stringify([file, offset, bytes]);
  for (const source of await evidenceSources(runDir)) if (source.kind === 'events') {
    for await (const line of jsonLines(await safeFile(runDir, source.file))) {
      const data = line.value?.data as Record<string, unknown> | undefined;
      if (line.value?.type !== 'recovery.gap' || data?.reason !== 'corrupt-records-preserved' || typeof data.file !== 'string' || typeof data.preserved !== 'string' || !Array.isArray(data.records)) continue;
      for (const record of data.records) if (record && record.file === data.file && Number.isSafeInteger(record.offset) && record.offset >= 0 && Number.isSafeInteger(record.bytes) && record.bytes > 0) {
        const id = key(record.file, record.offset, record.bytes);
        preserved.set(id, [...preserved.get(id) ?? [], data.preserved]);
      }
    }
  }
  const unseen: CorruptRecord[] = [];
  for (const record of corrupt) {
    let acknowledged = false;
    for (const original of preserved.get(key(record.file, record.offset, record.bytes)) ?? []) {
      try {
        const [current, previous] = await Promise.all([readSlice(runDir, record.file, record.offset, record.bytes), readSlice(runDir, original, record.offset, record.bytes)]);
        if (current.length === record.bytes && current.equals(previous)) { acknowledged = true; break; }
      } catch { /* A missing or unreadable preserved copy cannot acknowledge corruption. */ }
    }
    if (!acknowledged) unseen.push(record);
  }
  return unseen;
}

/** The only writer of run evidence. A resolved append has reached FileHandle.sync(). */
export class EvidenceStore {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingBytes = 0;
  private overflowCount = 0;
  private overflowScheduled = false;
  private closed = false;
  private closing = false;
  private fault?: Error;
  private lastIndexPublish = 0;
  private readonly chunkBytes: number;
  private readonly maxPendingBytes: number;
  private chunks = new Map<string, { number: number; bytes: number }>();
  private constructor(public readonly runDir: string, public manifest: RunManifest, private index: EvidenceIndex, private readonly writerLock: WriterLockHandle, options: StoreOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? 1024 * 1024;
    this.maxPendingBytes = options.maxPendingBytes ?? 32 * 1024 * 1024;
  }
  static async create(runDir: string, input: RunInput, options?: StoreOptions): Promise<EvidenceStore> {
    runDir = path.resolve(runDir);
    await fs.mkdir(runDir, { recursive: true });
    const writerLock = await claimWriterLock(runDir);
    try {
      if (await exists(path.join(runDir, 'manifest.json'))) throw new EvidenceError('RUN_EXISTS', 'This run already exists.', 409);
      for (const directory of ['journal', 'raw/cdp', 'raw/rrweb', 'raw/checkpoints', 'blobs', 'reports', 'recovery']) await fs.mkdir(path.join(runDir, directory), { recursive: true });
      const now = new Date().toISOString();
      const manifest: RunManifest = { ...clone(input), id: input.id ?? randomUUID(), schemaVersion: 1, status: 'recording', createdAt: now, updatedAt: now };
      const index = await EvidenceIndex.create(runDir);
      await index.publish();
      await atomicJson(path.join(runDir, 'manifest.json'), manifest);
      return new EvidenceStore(runDir, manifest, index, writerLock, options);
    } catch (error) { await writerLock.release(); throw error; }
  }
  static async open(runDir: string, options?: StoreOptions): Promise<EvidenceStore> {
    runDir = path.resolve(runDir);
    const writerLock = await claimWriterLock(runDir);
    try {
      const manifest = JSON.parse(await fs.readFile(await safeFile(runDir, 'manifest.json'), 'utf8')) as RunManifest;
      if (manifest.schemaVersion !== 1) throw new EvidenceError('UNSUPPORTED_SCHEMA', 'Unsupported evidence schema.');
      const rebuilt = await rebuildIndex(runDir);
      const store = new EvidenceStore(runDir, manifest, rebuilt.index, writerLock, options);
      for (const source of await evidenceSources(runDir)) {
        const match = /^(.*)\/(\w+)-(\d{6})\.jsonl$/.exec(source.file);
        if (match) {
          const key = `${match[1]}/${match[2]}`, number = Number(match[3]);
          const previous = store.chunks.get(key);
          if (!previous || number >= previous.number) store.chunks.set(key, { number, bytes: (await fs.stat(path.join(runDir, source.file))).size });
        }
      }
      if (manifest.status === 'sealed') return store;
      // Every original damaged byte remains in recovery; repaired active logs contain only valid records.
      const unseenCorruption = await unreportedCorruption(runDir, rebuilt.corrupt);
      const damagedFiles = [...new Set(unseenCorruption.map((record) => record.file))];
      for (const file of new Set(rebuilt.corrupt.map(record => record.file))) {
        const match = /^(.*\/\w+)-(\d{6})\.jsonl$/.exec(file);
        const chunk = match && store.chunks.get(match[1]);
        if (chunk && chunk.number === Number(match![2])) chunk.bytes = store.chunkBytes; // Never append after even an acknowledged incomplete record.
      }
      for (const file of damagedFiles) {
        const originalFile = await safeFile(runDir, file);
        const preserved = `recovery/${Date.now()}-${randomUUID()}-${path.basename(file)}`;
        await fs.copyFile(originalFile, path.join(runDir, preserved));
        const preservedHandle = await fs.open(path.join(runDir, preserved), 'r+');
        try { await preservedHandle.sync(); } finally { await preservedHandle.close(); }
        if (file === 'artifacts.jsonl' || file === 'checkpoints.jsonl') {
          const temporary = `${originalFile}.${randomUUID()}.tmp`, repaired = await fs.open(temporary, 'wx');
          try {
            for await (const line of jsonLines(originalFile)) if (!line.invalid && line.value && typeof line.value.id === 'string' && /^[a-z]+-\d{12}$/.test(line.value.id) && Number.isSafeInteger(line.value.sequence) && Number(line.value.sequence) > 0) await repaired.writeFile(await readSlice(runDir, file, line.offset, line.bytes));
            await repaired.sync();
          } finally { await repaired.close(); }
          await fs.rename(temporary, originalFile);
        }
        await store.appendEvent({ type: 'recovery.gap', source: 'evidence-store', data: { reason: 'corrupt-records-preserved', file, preserved, records: unseenCorruption.filter((record) => record.file === file) } });
      }
      if (damagedFiles.length) store.index = (await rebuildIndex(runDir)).index;
      const priorStatus = manifest.status;
      if (priorStatus !== 'interrupted' || damagedFiles.length) {
        store.manifest = { ...manifest, status: 'interrupted', updatedAt: new Date().toISOString() };
        await atomicJson(path.join(runDir, 'manifest.json'), store.manifest);
      }
      if (priorStatus !== 'interrupted') await store.appendEvent({ type: 'recovery.gap', source: 'evidence-store', data: { reason: priorStatus === 'sealing' ? 'seal-interrupted' : 'previous-capture-no-longer-live', previousStatus: priorStatus, ...(writerLock.recovery ? { writerLockRecovery: writerLock.recovery } : {}) } });
      await store.flush();
      return store;
    } catch (error) { await writerLock.release(); throw error; }
  }
  private writable(): void {
    if (this.closed) throw new EvidenceError('STORE_CLOSED', 'Evidence store is closed.', 409);
    if (this.fault) throw new EvidenceError('STORE_FAULTED', `Evidence writes stopped after an I/O failure: ${this.fault.message}`, 503);
    if (this.manifest.status === 'sealed' || this.manifest.status === 'sealing') throw new EvidenceError('RUN_SEALED', 'Run evidence is immutable after sealing begins.', 409);
  }
  private enqueue<T>(bytes: number, operation: () => Promise<T>, internal = false): Promise<T> {
    if (this.closed || this.closing && !internal) return Promise.reject(new EvidenceError('STORE_CLOSED', 'Evidence store is closing or closed.', 409));
    if (!internal && this.pendingBytes + bytes > this.maxPendingBytes) {
      this.overflowCount++;
      if (!this.overflowScheduled) {
        this.overflowScheduled = true;
        this.tail = this.tail.catch(() => undefined).then(async () => {
          const droppedRecords = this.overflowCount; this.overflowCount = 0; this.overflowScheduled = false;
          this.writable();
          await this.event({ type: 'capture.gap', source: 'evidence-store', data: { reason: 'write-queue-budget-exceeded', droppedRecords, maxPendingBytes: this.maxPendingBytes } });
          await this.index.publish();
        });
        void this.tail.catch(() => undefined);
      }
      return Promise.reject(new EvidenceError('WRITE_BACKPRESSURE', 'Evidence write queue is full; a capture gap is being recorded.', 429));
    }
    this.pendingBytes += bytes;
    const result = this.tail.catch(() => undefined).then(operation).finally(() => { this.pendingBytes -= bytes; });
    this.tail = result;
    return result;
  }
  private async appendLine(kind: RecordKind, record: Record<string, unknown>, channel?: 'cdp' | 'rrweb'): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    let file = `${kind}.jsonl`;
    if (kind === 'events' || kind === 'raw') {
      const key = kind === 'events' ? 'journal/events' : `raw/${channel}/${channel}`;
      let chunk = this.chunks.get(key) ?? { number: 1, bytes: 0 };
      if (chunk.bytes && chunk.bytes + data.length > this.chunkBytes) chunk = { number: chunk.number + 1, bytes: 0 };
      file = `${key}-${String(chunk.number).padStart(6, '0')}.jsonl`;
      chunk.bytes += data.length;
      this.chunks.set(key, chunk);
    }
    let offset: number;
    try {
      const handle = await fs.open(path.join(this.runDir, file), 'a');
      try { offset = (await handle.stat()).size; await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { this.fault = error as Error; throw error; }
    const entry: IndexEntry = { id: String(record.id), sequence: Number(record.sequence), kind, file, offset, bytes: data.length,
      type: record.type as string | undefined, timestamp: String(record.receivedAt ?? record.createdAt ?? record.savedAt ?? ''), captureStatus: record.captureStatus as IndexEntry['captureStatus'], key: record.key as string | undefined };
    try {
      await this.index.append(entry);
      if (Date.now() - this.lastIndexPublish >= 1000) { await this.index.publish(); this.lastIndexPublish = Date.now(); }
    } catch (error) { this.fault = error as Error; throw error; }
  }
  private identity(prefix: string): { id: string; sequence: number } { const sequence = this.index.state.lastSequence + 1; return { id: `${prefix}-${String(sequence).padStart(12, '0')}`, sequence }; }
  private async event(input: EventInput): Promise<EvidenceEvent> {
    const now = new Date().toISOString();
    const record: EvidenceEvent = { ...input, schemaVersion: 1, ...this.identity('evt'), occurredAt: input.occurredAt ?? now, receivedAt: now, timeBasis: input.timeBasis ?? 'host-received' };
    await this.appendLine('events', record);
    return record;
  }
  appendEvent(input: EventInput): Promise<EvidenceEvent> {
    const snapshot = clone(input);
    return this.enqueue(Buffer.byteLength(JSON.stringify(snapshot)), async () => { this.writable(); return this.event(snapshot); });
  }
  putArtifact(input: ArtifactInput): Promise<Artifact> {
    const { data, ...attributes } = input;
    const snapshot = clone(attributes);
    if (input.limitBytes !== undefined && (!Number.isSafeInteger(input.limitBytes) || input.limitBytes < 0)) return Promise.reject(new EvidenceError('INVALID_LIMIT', 'Artifact limitBytes must be a nonnegative integer.'));
    const { content, originalBytes, truncated } = captureContent(data, snapshot);
    if (content === undefined && (snapshot.captureStatus === 'complete' || snapshot.captureStatus === 'empty') || content !== undefined && ['missing', 'excluded', 'not-applicable'].includes(snapshot.captureStatus ?? '') || snapshot.captureStatus === 'empty' && originalBytes) {
      return Promise.reject(new EvidenceError('INVALID_CAPTURE_STATUS', 'Capture status contradicts the supplied artifact bytes.'));
    }
    return this.enqueue((content?.length ?? 0) + 512, async () => {
      this.writable();
      const record: Artifact = { ...snapshot, schemaVersion: 1, ...this.identity('art'), createdAt: new Date().toISOString(), capturedBytes: content?.length ?? 0,
        captureStatus: truncated ? 'truncated' : snapshot.captureStatus === 'complete' && content?.length === 0 ? 'empty' : snapshot.captureStatus ?? (content === undefined ? 'missing' : content.length ? 'complete' : 'empty'),
        ...(originalBytes !== undefined ? { originalBytes } : {}), ...(truncated ? { reason: snapshot.reason ?? 'capture-byte-limit' } : {}) };
      if (content !== undefined) {
        record.sha256 = hashBytes(content); record.path = `blobs/${record.sha256}`;
        if (!await exists(path.join(this.runDir, record.path))) await atomicFile(path.join(this.runDir, record.path), content);
      }
      await this.appendLine('artifacts', record as unknown as Record<string, unknown>);
      return record;
    });
  }
  appendCheckpoint(input: CheckpointInput): Promise<Checkpoint> {
    const snapshot = clone(input);
    return this.enqueue(Buffer.byteLength(JSON.stringify(snapshot)), async () => {
      this.writable();
      for (const reference of snapshot.artifactRefs) await this.requireArtifact(reference);
      const record: Checkpoint = { ...snapshot, schemaVersion: 1, ...this.identity('cp'), savedAt: new Date().toISOString() };
      await this.appendLine('checkpoints', record as unknown as Record<string, unknown>);
      await this.index.publish();
      return record;
    });
  }
  appendRaw(channel: 'cdp' | 'rrweb', payload: unknown): Promise<{ id: string; sequence: number }> {
    if (!['cdp', 'rrweb'].includes(channel)) return Promise.reject(new EvidenceError('INVALID_CHANNEL', 'Unknown raw evidence channel.'));
    const snapshot = clone(payload);
    return this.enqueue(Buffer.byteLength(JSON.stringify(snapshot)), async () => {
      this.writable();
      const record = { schemaVersion: 1, ...this.identity('raw'), receivedAt: new Date().toISOString(), channel, payload: snapshot };
      await this.appendLine('raw', record, channel);
      return { id: record.id, sequence: record.sequence };
    });
  }
  private async requireArtifact(id: string): Promise<IndexEntry> {
    if (!/^art-\d{12}$/.test(id)) throw new EvidenceError('INVALID_REFERENCE', 'Invalid artifact reference.');
    try { return JSON.parse(await fs.readFile(path.join(this.index.directory, 'artifacts', `${id}.json`), 'utf8')) as IndexEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EvidenceError('MISSING_REFERENCE', `Artifact ${id} does not exist.`, 409); throw error; }
  }
  updateManifest(patch: Partial<RunManifest>): Promise<RunManifest> {
    const snapshot = clone(patch);
    return this.enqueue(0, async () => {
      this.writable();
      if (snapshot.status === 'sealed' || snapshot.status === 'sealing') throw new EvidenceError('INVALID_STATUS', 'Use seal() to seal a run.');
      this.manifest = { ...this.manifest, ...snapshot, id: this.manifest.id, schemaVersion: 1, createdAt: this.manifest.createdAt, updatedAt: new Date().toISOString() };
      await atomicJson(path.join(this.runDir, 'manifest.json'), this.manifest);
      return this.manifest;
    }, true);
  }
  flush(): Promise<void> { return this.enqueue(0, async () => { if (this.fault) throw this.fault; await this.index.publish(); }, true); }
  seal(): Promise<{ status: 'sealed'; integrityPath: string; files: number }> {
    return this.enqueue(0, async () => {
      this.writable();
      this.manifest = { ...this.manifest, status: 'sealing', updatedAt: new Date().toISOString() };
      await atomicJson(path.join(this.runDir, 'manifest.json'), this.manifest);
      try {
        const files = new Map<string, { path: string; sha256: string; bytes: number }>();
        const acknowledgedCorruption = new Set<string>();
        for (const source of await evidenceSources(this.runDir)) if (source.kind === 'events') {
          for await (const line of jsonLines(await safeFile(this.runDir, source.file))) {
            const data = line.value?.data as Record<string, unknown> | undefined;
            if (line.value?.type === 'recovery.gap' && data?.reason === 'corrupt-records-preserved' && typeof data.file === 'string' && typeof data.preserved === 'string') {
              const checked = await this.hashFile(data.preserved); files.set(checked.path, checked);
              acknowledgedCorruption.add(data.file);
            }
          }
        }
        for (const source of await evidenceSources(this.runDir)) {
          for await (const line of jsonLines(await safeFile(this.runDir, source.file))) {
            if (line.invalid || !line.value) {
              // Corrupt historical tails are acceptable only when explicitly preserved and reported.
              if (acknowledgedCorruption.has(source.file)) continue;
              throw new EvidenceError('INTEGRITY_FAILED', `Invalid record in ${source.file}.`, 409);
            }
            const record = line.value;
            for (const id of (record.artifactRefs as string[] | undefined) ?? []) await this.requireArtifact(id);
            if (source.kind === 'artifacts' && ['complete', 'empty', 'truncated'].includes(String(record.captureStatus)) && (!record.path || !record.sha256)) throw new EvidenceError('INTEGRITY_FAILED', `Artifact ${record.id} is missing captured bytes.`, 409);
            if (source.kind === 'artifacts' && record.path) {
              const checked = await this.hashFile(String(record.path));
              if (checked.sha256 !== record.sha256 || checked.bytes !== record.capturedBytes) throw new EvidenceError('INTEGRITY_FAILED', `Artifact ${record.id} has changed.`, 409);
              files.set(checked.path, checked);
            }
          }
          const checked = await this.hashFile(source.file); files.set(checked.path, checked);
        }
        await atomicJson(path.join(this.runDir, 'integrity.json'), { schemaVersion: 1, runId: this.manifest.id, checkedAt: new Date().toISOString(), files: [...files.values()], acknowledgedGaps: this.index.state.gaps });
        await this.index.publish();
        this.manifest = { ...this.manifest, status: 'sealed', sealedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await atomicJson(path.join(this.runDir, 'manifest.json'), this.manifest);
        return { status: 'sealed', integrityPath: 'integrity.json', files: files.size };
      } catch (error) {
        this.manifest = { ...this.manifest, status: 'interrupted', updatedAt: new Date().toISOString() };
        await atomicJson(path.join(this.runDir, 'manifest.json'), this.manifest);
        throw error;
      }
    }, true);
  }
  private async hashFile(relative: string): Promise<{ path: string; sha256: string; bytes: number }> {
    const file = await safeFile(this.runDir, relative), hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
    return { path: relative, sha256: hash.digest('hex'), bytes };
  }
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try { await this.flush(); } finally { this.closed = true; await this.writerLock.release(); }
  }
}
