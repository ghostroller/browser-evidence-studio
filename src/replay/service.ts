import { createHash } from 'node:crypto';
import type { BoundedPage, HistoricalElementRef, LocatorCandidate, ReadBudget, ReplayPosition, ReplayService, ReplayState, SourceNode } from '@/contracts/recording';
import { EvidenceError } from '@/evidence/contracts';
import { RecordingArchive, type ReplayWindow } from './archive';
import { SourceModel } from './source-model';
import { sourceLocators } from './locators';

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function budget(input: ReadBudget): void {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1024 * 1024 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new EvidenceError('INVALID_BUDGET', 'Replay maxBytes must be 1..1048576 and limit 1..1000.', 400);
}
function bounded<T>(value: T, input: ReadBudget): T { if (bytes(value) > input.maxBytes) throw new EvidenceError('REPLAY_OUTPUT_TOO_LARGE', 'The complete result exceeds maxBytes; increase the explicit budget.', 413); return value; }

/** Read-only service, no live-page lease and no retained whole-archive cache. */
export class ArchiveReplayService implements ReplayService {
  readonly archive: RecordingArchive;
  constructor(runDir: string) { this.archive = new RecordingArchive(runDir); }
  async state(position: ReplayPosition, input: ReadBudget, signal?: AbortSignal): Promise<ReplayState> {
    budget(input); signal?.throwIfAborted();
    const window = await this.archive.window(position, signal);
    const last = window.records.at(-1)!;
    return bounded({ position, reliability: window.gaps.some(item => item.category === 'structure' || item.category === 'metadata') ? 'gap' : 'reliable', gaps: window.gaps, viewport: last.viewport }, input);
  }
  async node(ref: HistoricalElementRef, input: ReadBudget, signal?: AbortSignal): Promise<SourceNode> {
    budget(input); signal?.throwIfAborted();
    if (ref.kind !== 'dom-node') throw new EvidenceError('INVALID_TARGET_KIND', 'Visual regions do not identify DOM nodes.', 400);
    const model = new SourceModel((await this.archive.window(ref.position, signal)).records);
    signal?.throwIfAborted(); return bounded(model.node(ref), input);
  }
  async locators(ref: HistoricalElementRef, input: ReadBudget, signal?: AbortSignal): Promise<BoundedPage<LocatorCandidate>> {
    budget(input);
    const model = new SourceModel((await this.archive.window(ref.position, signal)).records);
    const candidates = sourceLocators(model, ref);
    const binding = createHash('sha256').update(JSON.stringify({ ref, format: 2 })).digest('hex');
    let offset = 0;
    if (input.cursor) {
      let cursor: { binding: string; offset: number };
      try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { throw new EvidenceError('INVALID_CURSOR', 'Malformed locator cursor', 400); }
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > candidates.length) throw new EvidenceError('INVALID_CURSOR', 'Locator cursor belongs to another position or format', 400);
      offset = cursor.offset;
    }
    const items: LocatorCandidate[] = [];
    let result: BoundedPage<LocatorCandidate> = { items, returnedBytes: 0, outputTruncated: false };
    for (const candidate of candidates.slice(offset, offset + input.limit)) {
      const next = [...items, candidate], more = offset + next.length < candidates.length;
      const nextCursor = more ? Buffer.from(JSON.stringify({ binding, offset: offset + next.length })).toString('base64url') : undefined;
      const projected = { items: next, ...(nextCursor ? { nextCursor } : {}), returnedBytes: input.maxBytes, outputTruncated: more };
      if (bytes(projected) > input.maxBytes) break;
      items.push(candidate); result = { ...projected, items, returnedBytes: 0 };
    }
    if (!items.length && offset < candidates.length) throw new EvidenceError('REPLAY_OUTPUT_TOO_LARGE', 'One complete locator cannot fit maxBytes.', 413);
    result.returnedBytes = bytes(result); result.returnedBytes = bytes(result);
    signal?.throwIfAborted(); return result;
  }
  window(position: ReplayPosition, signal?: AbortSignal): Promise<ReplayWindow> { return this.archive.window(position, signal); }
}

/** Caller-owned view generation prevents late loads, mirrors or resource work
 * from publishing into a newer selection. Dispose releases the active payload. */
export class ReplayViewSession<T> {
  private generation = 0;
  private pending?: AbortController;
  private current?: { value: T; dispose: () => void };
  async seek(load: (signal: AbortSignal) => Promise<{ value: T; dispose: () => void }>): Promise<T | undefined> {
    const generation = ++this.generation; this.pending?.abort();
    const controller = new AbortController(); this.pending = controller;
    let next: { value: T; dispose: () => void };
    try { next = await load(controller.signal); }
    catch (error) { if (generation !== this.generation || controller.signal.aborted) return undefined; throw error; }
    if (generation !== this.generation || controller.signal.aborted) { next.dispose(); return undefined; }
    this.current?.dispose(); this.current = next; return next.value;
  }
  dispose(): void { this.generation++; this.pending?.abort(); this.current?.dispose(); this.current = undefined; this.pending = undefined; }
}
