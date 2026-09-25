import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BatchReceipt, DatasetBatch, DatasetCompletion, DatasetIdentity, DatasetService, ExecutionBinding } from '../contracts/execution';
import type { BoundedPage, ReadBudget } from '../contracts/recording';
import type { JsonValue } from '../contracts/workflow';
import { atomicFile, atomicJson, exists, safeFile } from '../evidence/files';
import { claimWriterLock, type WriterLockHandle } from '../evidence/writer-lock';
import type { StepEvent } from './steps';

export class DatasetError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); this.name = 'DatasetError'; }
}
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCHES = 100_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function executionId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new DatasetError('INVALID_ID', 'Execution identifiers must be safe single path segments', 400);
  return value;
}

/** JSON only; reject lossy values before hashing or accepting a commit. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) throw new DatasetError('INVALID_JSON', 'JSON nesting exceeds 64', 400);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || active.has(item)) throw new DatasetError('INVALID_JSON', 'Data must contain finite, acyclic JSON values', 400);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new DatasetError('INVALID_JSON', 'Data must contain plain JSON objects', 400);
    active.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, child => visit(child, depth + 1)).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    active.delete(item);
    return result;
  };
  return visit(value, 0);
}

async function directory(root: string, parts: string[], create: boolean): Promise<string> {
  let current = path.resolve(root);
  // Reject links in every ancestor, including an imported BES_DATA root.
  const parsed = path.parse(current);
  const components = current.slice(parsed.root.length).split(path.sep).filter(Boolean);
  current = parsed.root;
  for (const segment of [...components, ...parts.map(executionId)]) {
    current = path.join(current, segment);
    if (create) { try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new DatasetError('INVALID_PATH', 'Dataset paths must use real directories', 400);
  }
  return current;
}
interface StoredBatch { schemaVersion: 1; sequence: number; batch: DatasetBatch; receipt: BatchReceipt }
interface DatasetIndex { directory: string; identity: DatasetIdentity; committedBatches: number; committedRecords: number; completion?: DatasetCompletion }
export interface RecordQuery extends ReadBudget { fields?: string[]; entity?: { field: string; equals: JsonValue } }
export interface DatasetRecord { batchId: string; recordIndex: number; value: JsonValue; missingFields?: string[] }
export interface BatchMetadata { receipt: BatchReceipt; provenance: DatasetBatch['provenance']; reusedFrom?: DatasetBatch['reusedFrom']; contentVerified: true; returnedBytes: number }

/** One execution writer; batches are immutable authoritative files, indexes are reconstructed. */
export class PersistentDatasetService implements DatasetService {
  private readonly indexes = new Map<string, DatasetIndex>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  private queuedBytes = 0;
  private constructor(readonly root: string, readonly binding: ExecutionBinding, private readonly lock?: WriterLockHandle) {}

  static async open(root: string, binding: ExecutionBinding): Promise<PersistentDatasetService> {
    validateBinding(binding);
    const executionDir = await directory(root, ['executions', binding.executionId], true);
    const lock = await claimWriterLock(executionDir);
    try {
      const file = path.join(executionDir, 'binding.json');
      if (await exists(file)) {
        const current: unknown = JSON.parse(await readFile(await safeFile(executionDir, 'binding.json'), 'utf8'));
        if (canonicalJson(current) !== canonicalJson(binding)) throw new DatasetError('BINDING_CONFLICT', 'Execution already belongs to a different immutable binding');
      } else await atomicJson(file, binding);
      return new PersistentDatasetService(path.resolve(root), structuredClone(binding), lock);
    } catch (error) { await lock.release(); throw error; }
  }
  /** Read-only history does not claim a writer lease. Active execution reads should reuse its service. */
  static async openReader(root: string, id: string): Promise<PersistentDatasetService> {
    const dir = await directory(root, ['executions', executionId(id)], false);
    const binding = JSON.parse(await readFile(await safeFile(dir, 'binding.json'), 'utf8')) as ExecutionBinding;
    validateBinding(binding);
    if (binding.executionId !== id) throw new DatasetError('BINDING_CONFLICT', 'Stored execution identity differs');
    return new PersistentDatasetService(path.resolve(root), binding);
  }
  private writable(): void { if (!this.lock) throw new DatasetError('READ_ONLY', 'History reader cannot mutate datasets'); }
  private operation<T>(action: () => Promise<T>, bytes = 0): Promise<T> {
    if (this.closed) return Promise.reject(new DatasetError('CLOSED', 'Dataset writer is closed'));
    if (this.queued >= 64 || this.queuedBytes + bytes > 16 * 1024 * 1024) return Promise.reject(new DatasetError('QUEUE_LIMIT', 'Dataset queue exceeds 64 operations / 16 MiB; await batch receipts', 429));
    this.queued++; this.queuedBytes += bytes;
    const pending = this.tail.then(action).finally(() => { this.queued--; this.queuedBytes -= bytes; });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.tail; await this.lock?.release(); }
  private check(identity: DatasetIdentity): void {
    executionId(identity.executionId); executionId(identity.attemptId); executionId(identity.datasetId);
    if (identity.executionId !== this.binding.executionId) throw new DatasetError('WRONG_EXECUTION', 'Dataset belongs to another execution');
  }
  private async index(identity: DatasetIdentity, create = false): Promise<DatasetIndex> {
    identity = pickIdentity(identity);
    this.check(identity);
    const key = canonicalJson(identity);
    const cached = this.lock ? this.indexes.get(key) : undefined;
    if (cached) return cached;
    if (this.indexes.size >= 128) throw new DatasetError('INDEX_LIMIT', 'Execution exceeds 128 active dataset indexes', 413);
    const dir = await directory(this.root, ['executions', identity.executionId, 'datasets', identity.attemptId, identity.datasetId], create);
    const manifest = path.join(dir, 'dataset.json');
    if (await exists(manifest)) {
      const saved: unknown = JSON.parse(await readFile(await safeFile(dir, 'dataset.json'), 'utf8'));
      if (canonicalJson(saved) !== canonicalJson({ schemaVersion: 1, ...identity })) throw new DatasetError('IDENTITY_CONFLICT', 'Stored dataset identity differs');
    } else {
      if (!create) throw new DatasetError('NOT_BEGUN', 'Dataset has not begun', 404);
      await atomicJson(manifest, { schemaVersion: 1, ...identity });
      await atomicJson(path.join(dir, 'state.json'), { schemaVersion: 1, ...identity, committedBatches: 0, committedRecords: 0 });
    }
    if (this.lock && await exists(path.join(dir, 'pending.json'))) throw new DatasetError('INDEX_RECOVERY_REQUIRED', 'Interrupted batch commit requires explicit rebuild before writing');
    let state: { schemaVersion: number; committedBatches: number; committedRecords: number } & DatasetIdentity;
    try { state = await readMetadata(dir, 'state.json') as typeof state; }
    catch (error) { throw new DatasetError('INDEX_RECOVERY_REQUIRED', `Dataset metadata cannot be read; explicit rebuild required: ${String(error)}`); }
    if (state.schemaVersion !== 1 || canonicalJson(pickIdentity(state)) !== canonicalJson(identity) || !Number.isSafeInteger(state.committedBatches) || state.committedBatches < 0 || state.committedBatches > MAX_BATCHES || !Number.isSafeInteger(state.committedRecords) || state.committedRecords < 0) throw new DatasetError('INDEX_RECOVERY_REQUIRED', 'Invalid dataset metadata; explicit rebuild required');
    const result: DatasetIndex = { directory: dir, identity: structuredClone(identity), committedBatches: state.committedBatches, committedRecords: state.committedRecords };
    if (await exists(path.join(dir, 'completion.json'))) {
      result.completion = await readMetadata(dir, 'completion.json') as DatasetCompletion;
      this.validateCompletion(result, result.completion);
    }
    if (this.lock) this.indexes.set(key, result);
    return result;
  }
  private async readStored(dir: string, name: string): Promise<StoredBatch> {
    const file = await safeFile(dir, name);
    if ((await lstat(file)).size > MAX_BATCH_BYTES + 8192) throw new DatasetError('CORRUPT_BATCH', 'Stored batch exceeds read limit', 413);
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredBatch;
    validateBatch(stored.batch);
    const receipt = stored.receipt;
    if (stored.schemaVersion !== 1 || !Number.isSafeInteger(stored.sequence) || stored.sequence < 1 || !receipt || receipt.contentHash !== hash(canonicalJson(stored.batch)) || receipt.recordCount !== stored.batch.records.length || receipt.batchId !== stored.batch.batchId || name !== batchFile(stored.batch.batchId) || canonicalJson(pickIdentity(receipt)) !== canonicalJson(pickIdentity(stored.batch))) throw new DatasetError('CORRUPT_BATCH', 'Batch content or receipt hash does not match');
    const expectedArtifact = `executions/${stored.batch.executionId}/datasets/${stored.batch.attemptId}/${stored.batch.datasetId}/${name}`;
    if (receipt.artifactId !== expectedArtifact || path.relative(this.root, file).split(path.sep).join('/') !== expectedArtifact || receipt.replayed !== false || typeof receipt.durableAt !== 'string' || !Number.isFinite(Date.parse(receipt.durableAt)) || new Date(receipt.durableAt).toISOString() !== receipt.durableAt) throw new DatasetError('CORRUPT_RECEIPT', 'Receipt location, durable timestamp or original commit marker is invalid');
    return stored;
  }
  begin(identity: DatasetIdentity): Promise<void> { return this.operation(async () => { this.writable(); await this.index(identity, true); }); }
  append(batch: DatasetBatch, signal?: AbortSignal): Promise<BatchReceipt> {
    // Snapshot synchronously: caller mutation during an await cannot alter the hash or bytes.
    validateBatch(batch);
    const serialized = canonicalJson(batch);
    return this.operation(async () => {
      this.writable();
      const frozen = JSON.parse(serialized) as DatasetBatch;
      signal?.throwIfAborted();
      const index = await this.index(pickIdentity(frozen));
      const contentHash = hash(canonicalJson(frozen));
      const previous = await exists(path.join(index.directory, batchFile(frozen.batchId))) ? (await this.readStored(index.directory, batchFile(frozen.batchId))).receipt : undefined;
      if (previous) {
        if (previous.contentHash !== contentHash) throw new DatasetError('BATCH_CONFLICT', 'The batch ID was already committed with different records, provenance or reuse');
        return { ...previous, replayed: true };
      }
      if (index.completion) throw new DatasetError('FINISHED', 'Cannot append to a finished dataset; create a new attempt');
      if (index.committedBatches >= MAX_BATCHES) throw new DatasetError('INDEX_LIMIT', 'Dataset has reached its 100,000 batch limit', 413);
      if (frozen.reusedFrom) await this.validateReuse(frozen);
      signal?.throwIfAborted();
      const receipt: BatchReceipt = { ...pickIdentity(frozen), batchId: frozen.batchId, contentHash, recordCount: frozen.records.length,
        artifactId: `executions/${frozen.executionId}/datasets/${frozen.attemptId}/${frozen.datasetId}/${batchFile(frozen.batchId)}`, durableAt: new Date().toISOString(), replayed: false };
      const sequence = index.committedBatches + 1;
      await atomicJson(path.join(index.directory, 'pending.json'), { batchId: frozen.batchId, sequence });
      try {
        await immutableFile(path.join(index.directory, batchFile(frozen.batchId)), Buffer.from(canonicalJson({ schemaVersion: 1, sequence, batch: frozen, receipt } satisfies StoredBatch)));
        await atomicJson(path.join(index.directory, receiptFile(sequence)), receipt);
        await atomicJson(path.join(index.directory, 'state.json'), { schemaVersion: 1, ...index.identity, committedBatches: sequence, committedRecords: index.committedRecords + receipt.recordCount });
        await unlink(await safeFile(index.directory, 'pending.json'));
        index.committedBatches = sequence; index.committedRecords += receipt.recordCount;
      } catch (error) {
        this.indexes.delete(canonicalJson(index.identity));
        throw error;
      }
      // Cancellation cannot undo durable data. The caller can replay the same batch ID to recover its receipt.
      signal?.throwIfAborted();
      return structuredClone(receipt);
    }, Buffer.byteLength(serialized));
  }
  private async validateReuse(batch: DatasetBatch): Promise<void> {
    const ref = batch.reusedFrom!;
    if (ref.executionId !== batch.executionId) throw new DatasetError('REUSE_SCOPE', 'Cross-execution reuse requires a separate verified import');
    if (ref.attemptId === batch.attemptId) throw new DatasetError('REUSE_ATTEMPT', 'Reuse must reference a prior attempt');
    const source = await this.index(pickIdentity(ref));
    const stored = await this.readStored(source.directory, batchFile(ref.batchId));
    if (canonicalJson(stored.batch.records) !== canonicalJson(batch.records) || canonicalJson(stored.batch.provenance) !== canonicalJson(batch.provenance)) throw new DatasetError('REUSE_CONTENT', 'Reused records and original provenance must match their source batch');
  }
  private validateCompletion(index: DatasetIndex, completion: DatasetCompletion): void {
    if (canonicalJson(pickIdentity(completion)) !== canonicalJson(index.identity) || !['complete', 'partial', 'failed', 'cancelled'].includes(completion.status) || completion.committedBatches !== index.committedBatches || completion.committedRecords !== index.committedRecords) throw new DatasetError('COMPLETION_MISMATCH', 'Completion must account for every durable batch and record');
    canonicalJson(completion);
    if (completion.status === 'complete' && completion.pagination && !completion.pagination.complete) throw new DatasetError('COMPLETION_MISMATCH', 'Incomplete pagination cannot declare a complete dataset');
  }
  finish(completion: DatasetCompletion): Promise<void> {
    const frozen = JSON.parse(canonicalJson(completion)) as DatasetCompletion;
    return this.operation(async () => {
      this.writable();
      const index = await this.index(pickIdentity(frozen));
      this.validateCompletion(index, frozen);
      if (index.completion) {
        if (canonicalJson(index.completion) !== canonicalJson(frozen)) throw new DatasetError('COMPLETION_CONFLICT', 'Dataset completion is immutable; create a new attempt');
        return;
      }
      await atomicJson(path.join(index.directory, 'completion.json'), frozen);
      index.completion = frozen;
    });
  }
  batches(identity: DatasetIdentity, budget: ReadBudget): Promise<BoundedPage<BatchReceipt>> {
    return this.operation(async () => {
      const index = await this.index(identity);
      const query = hash(canonicalJson(identity));
      const range = cursorRange(budget, query, index.committedBatches);
      const receipts: BatchReceipt[] = [];
      let bytes = 0;
      for (let offset = range.start; offset < range.end && receipts.length < budget.limit; offset++) {
        const receipt = await readMetadata(index.directory, receiptFile(offset + 1)) as BatchReceipt;
        validateReceipt(receipt, identity);
        receipts.push(receipt); bytes += Buffer.byteLength(JSON.stringify(receipt));
        if (bytes > budget.maxBytes) break;
      }
      return bounded(receipts, budget, query, range);
    });
  }
  summary(identity: DatasetIdentity): Promise<{ identity: DatasetIdentity; status: DatasetCompletion['status'] | 'unfinished'; committedBatches: number; committedRecords: number; completion?: DatasetCompletion }> {
    return this.operation(async () => {
      const index = await this.index(identity);
      return { identity: structuredClone(index.identity), status: index.completion?.status ?? 'unfinished', committedBatches: index.committedBatches,
        committedRecords: index.committedRecords, ...(index.completion ? { completion: structuredClone(index.completion) } : {}) };
    });
  }
  /** Explicit bounded body query; receipt listing never includes business records. */
  records(identity: DatasetIdentity, batchId: string, query: RecordQuery): Promise<BoundedPage<DatasetRecord>> {
    return this.operation(async () => {
      const index = await this.index(identity);
      const { batch } = await this.readStored(index.directory, batchFile(executionId(batchId)));
      if (query.fields && (query.fields.length > 64 || !query.fields.every(field => typeof field === 'string' && field.length > 0 && field.length <= 128))) throw new DatasetError('INVALID_PROJECTION', 'Projection accepts up to 64 top-level fields', 400);
      const selected = batch.records.flatMap((value, recordIndex): DatasetRecord[] => {
        if (query.entity && (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, query.entity.field) || canonicalJson(value[query.entity.field]) !== canonicalJson(query.entity.equals))) return [];
        if (!query.fields) return [{ batchId, recordIndex, value }];
        const projected: Record<string, JsonValue> = {}, missingFields: string[] = [];
        for (const field of query.fields) {
          if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, field)) Object.defineProperty(projected, field, { value: value[field], enumerable: true });
          else missingFields.push(field);
        }
        return [{ batchId, recordIndex, value: projected, ...(missingFields.length ? { missingFields } : {}) }];
      });
      return bounded(selected, query, hash(canonicalJson({ identity, batchId, fields: query.fields ?? null, entity: query.entity ?? null })));
    });
  }
  batchMetadata(identity: DatasetIdentity, batchId: string, budget: ReadBudget): Promise<BatchMetadata> {
    return this.operation(async () => {
      cursorRange(budget, 'batch-metadata', 0);
      if (budget.cursor) throw new DatasetError('INVALID_CURSOR', 'Batch metadata is one identified bounded result', 400);
      const index = await this.index(identity);
      const stored = await this.readStored(index.directory, batchFile(batchId));
      const value: BatchMetadata = { receipt: stored.receipt, provenance: stored.batch.provenance, ...(stored.batch.reusedFrom ? { reusedFrom: stored.batch.reusedFrom } : {}), contentVerified: true, returnedBytes: 0 };
      for (let pass = 0; pass < 4; pass++) value.returnedBytes = Buffer.byteLength(JSON.stringify(value));
      if (value.returnedBytes > budget.maxBytes) throw new DatasetError('ITEM_TOO_LARGE', 'Batch metadata exceeds the explicit read budget', 413);
      return value;
    });
  }
  saveStep(event: StepEvent): Promise<void> {
    const serialized = canonicalJson(event);
    if (Buffer.byteLength(serialized) > 64 * 1024) return Promise.reject(new DatasetError('STEP_TOO_LARGE', 'Step event exceeds 64 KiB; return dataset references instead of records', 413));
    return this.operation(async () => {
      this.writable();
      const frozen = JSON.parse(serialized) as StepEvent;
      validateStepEvent(frozen);
      if (frozen.identity.executionId !== this.binding.executionId) throw new DatasetError('INVALID_STEP', 'Step event does not match this execution', 400);
      executionId(frozen.identity.attemptId); executionId(frozen.identity.stepId);
      const dir = await directory(this.root, ['executions', this.binding.executionId, 'attempts', frozen.identity.attemptId], true);
      const sequences: number[] = [];
      for await (const file of await opendir(dir)) {
        if (!/^step-\d{4}\.json$/.test(file.name)) continue;
        sequences.push(Number(file.name.slice(5, 9)));
        if (sequences.length >= 129) throw new DatasetError('STEP_EVENT_LIMIT', 'Step exceeds 128 lifecycle events', 413);
      }
      sequences.sort((a, b) => a - b);
      if (sequences.some((sequence, index) => sequence !== index + 1)) throw new DatasetError('CORRUPT_STEP_SEQUENCE', 'Step event sequence is incomplete; original files were preserved');
      const count = sequences.length;
      if (count >= 128) throw new DatasetError('STEP_EVENT_LIMIT', 'Step exceeds 128 lifecycle events', 413);
      if (count > 0) {
        const previousFile = await safeFile(dir, `step-${String(count).padStart(4, '0')}.json`);
        if ((await lstat(previousFile)).size > 64 * 1024) throw new DatasetError('CORRUPT_STEP', 'Previous step event exceeds 64 KiB');
        const previous = JSON.parse(await readFile(previousFile, 'utf8')) as StepEvent;
        validateStepEvent(previous);
        if (canonicalJson(previous.identity) !== canonicalJson(frozen.identity)) throw new DatasetError('ATTEMPT_CONFLICT', 'Step attempt identity cannot change');
        if (!['running', 'awaiting-human'].includes(previous.state)) throw new DatasetError('STEP_FINISHED', 'Step attempt already has a durable terminal result');
      }
      await immutableFile(path.join(dir, `step-${String(count + 1).padStart(4, '0')}.json`), Buffer.from(serialized));
    }, Buffer.byteLength(serialized));
  }
  /** Explicit recovery only: validate immutable originals and rebuild the small metadata files.
   * It never runs as a side effect of summary, receipt pagination, or a body-by-ID read. */
  rebuild(identity: DatasetIdentity): Promise<{ batches: number; records: number; scannedBytes: number }> {
    return this.operation(async () => {
      this.writable(); this.check(identity);
      const dir = await directory(this.root, ['executions', identity.executionId, 'datasets', identity.attemptId, identity.datasetId], false);
      const manifest = await readMetadata(dir, 'dataset.json');
      if (canonicalJson(manifest) !== canonicalJson({ schemaVersion: 1, ...identity })) throw new DatasetError('IDENTITY_CONFLICT', 'Dataset recovery identity differs');
      const ordered: { sequence: number; receipt: BatchReceipt }[] = [];
      let scannedBytes = 0;
      for await (const file of await opendir(dir)) {
        if (!/^batch-[a-f0-9]{64}\.json$/.test(file.name)) continue;
        if (ordered.length >= MAX_BATCHES) throw new DatasetError('RECOVERY_LIMIT', 'Recovery exceeds 100,000 batches', 413);
        scannedBytes += (await lstat(await safeFile(dir, file.name))).size;
        const stored = await this.readStored(dir, file.name);
        if (canonicalJson(pickIdentity(stored.batch)) !== canonicalJson(identity)) throw new DatasetError('CORRUPT_BATCH', 'Recovery batch belongs to another dataset');
        ordered.push({ sequence: stored.sequence, receipt: stored.receipt });
      }
      ordered.sort((a, b) => a.sequence - b.sequence);
      if (ordered.some((item, index) => item.sequence !== index + 1)) throw new DatasetError('CORRUPT_SEQUENCE', 'Durable batch sequence is missing or duplicated');
      const state = { schemaVersion: 1, ...identity, committedBatches: ordered.length, committedRecords: ordered.reduce((n, item) => n + item.receipt.recordCount, 0) };
      if (await exists(path.join(dir, 'completion.json'))) this.validateCompletion({ directory: dir, identity, ...state }, await readMetadata(dir, 'completion.json') as DatasetCompletion);
      // Do not modify any metadata until all originals have passed validation.
      for (const item of ordered) await atomicJson(path.join(dir, receiptFile(item.sequence)), item.receipt);
      await atomicJson(path.join(dir, 'state.json'), state);
      if (await exists(path.join(dir, 'pending.json'))) {
        const pending = await readMetadata(dir, 'pending.json');
        await atomicJson(path.join(dir, `recovered-pending-${hash(canonicalJson(pending))}.json`), pending);
        await unlink(await safeFile(dir, 'pending.json'));
      }
      this.indexes.delete(canonicalJson(identity));
      return { batches: state.committedBatches, records: state.committedRecords, scannedBytes };
    });
  }
}

function pickIdentity(value: DatasetIdentity): DatasetIdentity { return { executionId: value.executionId, attemptId: value.attemptId, datasetId: value.datasetId }; }
const batchFile = (id: string) => `batch-${hash(executionId(id))}.json`;
const receiptFile = (sequence: number) => `receipt-${String(sequence).padStart(8, '0')}.json`;
async function immutableFile(file: string, content: Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  // link is an atomic create-if-absent operation: an existing original is never replaced.
  await link(temporary, file);
  await unlink(temporary);
}
function validateStepEvent(event: StepEvent): void {
  if (!event?.identity || !['running', 'succeeded', 'partial', 'failed', 'blocked', 'cancelled', 'awaiting-human'].includes(event.state) || !Number.isFinite(Date.parse(event.occurredAt))) throw new DatasetError('INVALID_STEP', 'Invalid step state or timestamp', 400);
  for (const id of [event.identity.executionId, event.identity.stepId, event.identity.attemptId]) executionId(id);
  if (event.state === 'running' ? event.result !== undefined : !event.result || event.result.status !== event.state || canonicalJson(event.result.identity) !== canonicalJson(event.identity)) throw new DatasetError('INVALID_STEP', 'Step result identity and state must match its lifecycle event', 400);
  if (event.resultValueState !== undefined && (event.resultValueState !== 'undefined' || !event.result || !['succeeded', 'partial'].includes(event.result.status) || !('value' in event.result) || event.result.value !== null)) throw new DatasetError('INVALID_STEP', 'Undefined step result encoding does not match its value placeholder', 400);
}
async function readMetadata(dir: string, name: string): Promise<unknown> {
  const file = await safeFile(dir, name);
  if ((await lstat(file)).size > 16 * 1024) throw new DatasetError('CORRUPT_METADATA', 'Dataset metadata exceeds 16 KiB; rebuild required', 413);
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
function validateReceipt(receipt: BatchReceipt, identity: DatasetIdentity): void {
  if (!receipt || canonicalJson(pickIdentity(receipt)) !== canonicalJson(identity) || !Number.isSafeInteger(receipt.recordCount) || receipt.recordCount < 0 || !/^[a-f0-9]{64}$/.test(receipt.contentHash) || receipt.artifactId !== `executions/${identity.executionId}/datasets/${identity.attemptId}/${identity.datasetId}/${batchFile(receipt.batchId)}` || receipt.replayed !== false || !Number.isFinite(Date.parse(receipt.durableAt)) || new Date(receipt.durableAt).toISOString() !== receipt.durableAt) throw new DatasetError('CORRUPT_RECEIPT', 'Receipt metadata is invalid; rebuild required');
}
function validateBinding(binding: ExecutionBinding): void {
  if (!binding || binding.schemaVersion !== 1 || !['current-page-test', 'from-start-validation'].includes(binding.mode)) throw new DatasetError('INVALID_BINDING', 'Invalid execution binding', 400);
  executionId(binding.executionId); executionId(binding.projectId); executionId(binding.materialRevisionId);
  for (const field of ['materialContentHash', 'codeFingerprint', 'inputFingerprint', 'environmentRef'] as const) if (typeof binding[field] !== 'string' || !binding[field].trim() || binding[field].length > 4096) throw new DatasetError('INVALID_BINDING', `Missing execution ${field}`, 400);
  canonicalJson(binding);
}
function validateBatch(batch: DatasetBatch): void {
  if (!batch) throw new DatasetError('INVALID_BATCH', 'Missing batch', 400);
  for (const value of [batch.executionId, batch.attemptId, batch.datasetId, batch.batchId]) executionId(value);
  if (!Array.isArray(batch.records) || !batch.provenance || !['browser', 'node', 'derived'].includes(batch.provenance.origin) || !Array.isArray(batch.provenance.sourceRefs) || !batch.provenance.sourceRefs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 2048)) throw new DatasetError('INVALID_BATCH', 'Batch records and provenance are required', 400);
  if (batch.reusedFrom) {
    for (const value of [batch.reusedFrom.executionId, batch.reusedFrom.attemptId, batch.reusedFrom.datasetId, batch.reusedFrom.batchId]) executionId(value);
    if (!Array.isArray(batch.reusedFrom.validityEvidenceRefs) || !batch.reusedFrom.validityEvidenceRefs.length || !batch.reusedFrom.validityEvidenceRefs.every(ref => typeof ref === 'string' && ref.trim())) throw new DatasetError('INVALID_REUSE', 'Reuse requires explicit validity evidence references', 400);
  }
  if (Buffer.byteLength(canonicalJson(batch)) > MAX_BATCH_BYTES) throw new DatasetError('BATCH_TOO_LARGE', 'Split batch into at most 1 MiB of records and provenance', 413);
}
function cursorRange(budget: ReadBudget, query: string, available: number): { start: number; end: number } {
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.limit > 1000 || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 128 || budget.maxBytes > 1024 * 1024) throw new DatasetError('INVALID_BUDGET', 'Read budget needs limit 1–1000 and maxBytes 128–1048576', 400);
  let start = 0, end = available;
  if (budget.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(budget.cursor, 'base64url').toString('utf8')) as { version: number; query: string; offset: number; end: number };
      if (parsed.version !== 1 || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || !Number.isSafeInteger(parsed.end) || parsed.offset < 0 || parsed.end > available || parsed.offset > parsed.end) throw new Error();
      start = parsed.offset; end = parsed.end;
    } catch { throw new DatasetError('INVALID_CURSOR', 'Cursor does not match this dataset query', 400); }
  }
  return { start, end };
}
function bounded<T>(source: T[], budget: ReadBudget, query: string, loadedRange?: { start: number; end: number }): BoundedPage<T> {
  const { start, end } = loadedRange ?? cursorRange(budget, query, source.length);
  const items: T[] = [];
  const make = (): BoundedPage<T> => {
    const offset = start + items.length, outputTruncated = offset < end;
    const nextCursor = outputTruncated ? Buffer.from(JSON.stringify({ version: 1, query, offset, end })).toString('base64url') : undefined;
    const result: BoundedPage<T> = { items, ...(nextCursor ? { nextCursor } : {}), returnedBytes: 0, outputTruncated };
    for (let pass = 0; pass < 4; pass++) result.returnedBytes = Buffer.byteLength(JSON.stringify(result));
    return result;
  };
  for (let offset = loadedRange ? 0 : start; offset < source.length && items.length < budget.limit && start + items.length < end; offset++) {
    items.push(structuredClone(source[offset]));
    if (make().returnedBytes > budget.maxBytes) { items.pop(); break; }
  }
  if (start < end && !items.length) throw new DatasetError('ITEM_TOO_LARGE', 'One item exceeds maxBytes; use projection or a larger explicit budget', 413);
  return make();
}
