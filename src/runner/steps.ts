import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OriginalError, StepIdentity, StepResult } from '../contracts/execution';
import { originalError } from './errors';

export interface StepEvent {
  identity: StepIdentity;
  state: 'running' | StepResult<unknown>['status'];
  occurredAt: string;
  result?: StepResult<unknown>;
  diagnostics?: { phase: 'evidence' | 'cleanup'; error: OriginalError }[];
}
export interface StepContext {
  identity: StepIdentity;
  signal: AbortSignal;
  /** Persist the waiting identity before the actual human request, which must verify completion. */
  awaitHuman(handoffId: string, wait: () => Promise<void>): Promise<void>;
}
export interface StepOptions<T> {
  stepId: string;
  entityKey?: string;
  dependencies?: StepResult<unknown>[];
  /** Shared resource keys serialize; separate keys require caller-owned independent pages/resources. */
  resourceKey?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number; policy: 'read-only' | 'idempotent'; backoffMs: number; totalBudgetMs: number };
  run(context: StepContext): Promise<T>;
  /** Business persistence precedes optional evidence. Failure here is fatal to this execution. */
  commit?(value: T, context: StepContext): Promise<void>;
  evidence?(value: T, context: StepContext): Promise<void>;
  cleanup?(context: StepContext): Promise<void>;
}
export interface StepRunnerOptions {
  executionId: string;
  signal: AbortSignal;
  save(event: StepEvent): Promise<void>;
  /** Must revoke the resource and await verified quiescence (e.g. terminate its worker).
   * Without this hook cancellation waits for the function to settle, never claims a race stopped it. */
  interrupt?(identity: StepIdentity, reason: Error, resourceKey: string): Promise<void>;
}
export class StepTimeoutError extends Error { constructor() { super('Step timeout elapsed; external effects may require inspection'); this.name = 'StepTimeoutError'; } }
export class StepPersistenceError extends Error { constructor(cause: unknown) { super('Step result or business output could not be saved', { cause }); this.name = 'StepPersistenceError'; } }

/** Portable ordinary-JS helper. It schedules no workflow, navigates no page and invents no dependencies. */
export function createStepRunner(options: StepRunnerOptions): { run<T>(step: StepOptions<T>): Promise<StepResult<T>> } {
  const resources = new Map<string, Promise<unknown>>();
  let fatal: unknown;
  const save = async (event: StepEvent): Promise<void> => {
    try { await options.save(event); } catch (error) { fatal = new StepPersistenceError(error); throw fatal; }
  };
  const record = async <T>(result: StepResult<T>, diagnostics?: StepEvent['diagnostics']): Promise<StepResult<T>> => {
    await save({ identity: result.identity, state: result.status, occurredAt: new Date().toISOString(), result, ...(diagnostics?.length ? { diagnostics } : {}) });
    return result;
  };
  async function execute<T>(step: StepOptions<T>, resourceKey: string): Promise<StepResult<T>> {
    if (fatal) throw fatal;
    const identity = (): StepIdentity => ({ executionId: options.executionId, stepId: step.stepId, attemptId: randomUUID(), ...(step.entityKey === undefined ? {} : { entityKey: step.entityKey }) });
    if (options.signal.aborted) return record({ status: 'cancelled', identity: identity(), error: originalError(options.signal.reason) });
    const failedDependencies = step.dependencies?.filter(result => result.status !== 'succeeded') ?? [];
    if (failedDependencies.length) return record({ status: 'blocked', identity: identity(), dependencies: failedDependencies.map(result => result.identity), reason: 'Required preceding results did not succeed' });
    const startedAt = Date.now();
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = identity(), controller = new AbortController();
      const abort = () => controller.abort(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const remaining = step.retry ? step.retry.totalBudgetMs - (Date.now() - startedAt) : Infinity;
      const duration = Math.min(step.timeoutMs ?? Infinity, remaining);
      const timer = Number.isFinite(duration) ? setTimeout(() => controller.abort(new StepTimeoutError()), Math.max(0, duration)) : undefined;
      const context: StepContext = { identity: current, signal: controller.signal, awaitHuman: async (handoffId, wait) => {
        controller.signal.throwIfAborted();
        await save({ identity: current, state: 'awaiting-human', occurredAt: new Date().toISOString(), result: { status: 'awaiting-human', identity: current, handoffId } });
        await wait();
        controller.signal.throwIfAborted();
        await save({ identity: current, state: 'running', occurredAt: new Date().toISOString() });
      } };
      let result: StepResult<T>;
      let committed = false;
      let quiet: Promise<void> | undefined;
      const diagnostics: NonNullable<StepEvent['diagnostics']> = [];
      let removeAbort = () => {};
      try {
        controller.signal.throwIfAborted();
        await save({ identity: current, state: 'running', occurredAt: new Date().toISOString() });
        const work = (async () => {
          const value = await step.run(context);
          controller.signal.throwIfAborted();
          if (step.commit) {
            try { await step.commit(value, context); committed = true; }
            catch (error) { fatal = new StepPersistenceError(error); throw fatal; }
          }
          controller.signal.throwIfAborted();
          return value;
        })();
        // This race only detects cancellation; interrupt must establish a real stop boundary.
        const interrupted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const reason = controller.signal.reason instanceof Error ? controller.signal.reason : new Error(String(controller.signal.reason));
            quiet = options.interrupt ? options.interrupt(current, reason, resourceKey) : work.then(() => undefined, () => undefined);
            void quiet.then(() => reject(reason), error => { fatal = error; reject(error); });
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
          if (controller.signal.aborted) onAbort();
        });
        const value = await Promise.race([work, interrupted]);
        controller.signal.throwIfAborted();
        result = { status: 'succeeded', identity: current, value };
        if (step.evidence) {
          try { await step.evidence(value, context); controller.signal.throwIfAborted(); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            diagnostics.push({ phase: 'evidence', error: originalError(error) });
            result = { status: 'partial', identity: current, value, error: originalError(error) };
          }
        }
      } catch (error) {
        if (fatal) throw fatal;
        result = { status: options.signal.aborted ? 'cancelled' : 'failed', identity: current, error: originalError(controller.signal.aborted ? controller.signal.reason : error) };
      } finally {
        // Work may reject before resource revocation finishes. Never return early in that race.
        if (quiet) { try { await quiet; } catch (error) { fatal = error; } }
        removeAbort();
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        try { await step.cleanup?.(context); }
        catch (error) { diagnostics.push({ phase: 'cleanup', error: originalError(error) }); }
      }
      if (fatal) throw fatal;
      if (diagnostics.some(item => item.phase === 'cleanup') && result.status === 'succeeded') result = { ...result, status: 'partial', error: diagnostics.find(item => item.phase === 'cleanup')!.error };
      await record(result, diagnostics);
      if (result.status !== 'failed' || committed || !step.retry || attempt + 1 >= maxAttempts || options.signal.aborted || Date.now() - startedAt + step.retry.backoffMs >= step.retry.totalBudgetMs) return result;
      // Unsafe/non-idempotent steps have no retry option; every retry gets a new attempt identity.
      try { await delay(step.retry.backoffMs, undefined, { signal: options.signal }); }
      catch { return record({ status: 'cancelled', identity: identity(), error: originalError(options.signal.reason) }); }
    }
    throw new Error('Unreachable attempt boundary');
  }
  return { run: <T>(step: StepOptions<T>): Promise<StepResult<T>> => {
    if (!step.stepId || step.stepId.length > 128 || (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 1))) return Promise.reject(new Error('Invalid step identity or timeout'));
    if (step.retry && (!['read-only', 'idempotent'].includes(step.retry.policy) || !Number.isSafeInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1 || step.retry.maxAttempts > 5 || !Number.isFinite(step.retry.backoffMs) || step.retry.backoffMs < 0 || step.retry.backoffMs > 30_000 || !Number.isFinite(step.retry.totalBudgetMs) || step.retry.totalBudgetMs < 1 || step.retry.totalBudgetMs > 30 * 60_000)) return Promise.reject(new Error('Retry requires explicit idempotence, at most 5 attempts, bounded backoff and total budget'));
    const resourceKey = step.resourceKey ?? 'shared-page';
    const previous = resources.get(resourceKey) ?? Promise.resolve();
    const pending = previous.then(() => execute(step, resourceKey));
    const settled = pending.then(() => undefined, () => undefined);
    resources.set(resourceKey, settled);
    void settled.finally(() => { if (resources.get(resourceKey) === settled) resources.delete(resourceKey); });
    return pending;
  } };
}
