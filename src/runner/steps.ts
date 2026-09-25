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
  rerun?: { from: StepIdentity; status: 'pending' | 'passed' | 'failed'; validityEvidenceRefs: string[]; checkedAt?: string; reason?: string };
}
export interface StepSelection { stepIds?: string[]; entityKeys?: string[] }
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
  /** Explicit manual rerun: verify current login/input/prerequisite/code/material compatibility
   * in ordinary business code. The callback's result is a recorded declaration, not acceptance. */
  prior?: { identity: StepIdentity; validate(context: StepContext): Promise<{ valid: boolean; evidenceRefs: string[]; reason?: string }> };
}
export interface StepRunnerOptions {
  executionId: string;
  signal: AbortSignal;
  save(event: StepEvent): Promise<void>;
  /** Must revoke the resource and await verified quiescence (e.g. terminate its worker).
   * Without this hook cancellation waits for the function to settle, never claims a race stopped it. */
  interrupt?(identity: StepIdentity, reason: Error, resourceKey: string): Promise<void>;
  selection?: StepSelection;
}
export class StepTimeoutError extends Error { constructor() { super('Step timeout elapsed; external effects may require inspection'); this.name = 'StepTimeoutError'; } }
export class StepPersistenceError extends Error { constructor(cause: unknown) { super('Step result or business output could not be saved', { cause }); this.name = 'StepPersistenceError'; } }

/** Portable ordinary-JS helper. It schedules no workflow, navigates no page and invents no dependencies. */
export function createStepRunner(options: StepRunnerOptions): { run<T>(step: StepOptions<T>): Promise<StepResult<T>>; pending(): number; selected(stepId: string, entityKey?: string): boolean } {
  const selection = parseStepSelection(options.selection);
  const resources = new Map<string, Promise<unknown>>();
  const unsafeResources = new Map<string, Error>();
  let fatal: unknown;
  let pendingSteps = 0;
  const save = async (event: StepEvent): Promise<void> => {
    try { await options.save(event); } catch (error) { fatal = new StepPersistenceError(error); throw fatal; }
  };
  const record = async <T>(result: StepResult<T>, diagnostics?: StepEvent['diagnostics'], rerun?: StepEvent['rerun']): Promise<StepResult<T>> => {
    await save({ identity: result.identity, state: result.status, occurredAt: new Date().toISOString(), result, ...(diagnostics?.length ? { diagnostics } : {}), ...(rerun ? { rerun } : {}) });
    return result;
  };
  async function execute<T>(step: StepOptions<T>, resourceKey: string): Promise<StepResult<T>> {
    if (fatal) throw fatal;
    if (unsafeResources.has(resourceKey)) throw unsafeResources.get(resourceKey);
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
      let rerun: StepEvent['rerun'] = step.prior ? { from: step.prior.identity, status: 'pending', validityEvidenceRefs: [] } : undefined;
      let removeAbort = () => {};
      try {
        controller.signal.throwIfAborted();
        await save({ identity: current, state: 'running', occurredAt: new Date().toISOString(), ...(rerun ? { rerun } : {}) });
        const work = (async () => {
          if (step.prior) {
            if (step.prior.identity.stepId !== step.stepId || step.prior.identity.entityKey !== step.entityKey) throw new Error('Prior attempt must identify the same step and entity');
            const checked = await step.prior.validate(context);
            controller.signal.throwIfAborted();
            if (typeof checked.valid !== 'boolean' || !Array.isArray(checked.evidenceRefs) || checked.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) || (checked.valid && !checked.evidenceRefs.length)) throw new Error('Rerun compatibility requires an explicit boolean and validity evidence references');
            rerun = { from: step.prior.identity, status: checked.valid ? 'passed' : 'failed', validityEvidenceRefs: checked.evidenceRefs, checkedAt: new Date().toISOString(), ...(checked.reason ? { reason: checked.reason } : {}) };
            if (!checked.valid) return { status: 'blocked', identity: current, dependencies: [step.prior.identity], reason: checked.reason ?? 'Rerun prerequisites or version compatibility were not verified' } satisfies StepResult<T>;
            await save({ identity: current, state: 'running', occurredAt: new Date().toISOString(), rerun });
          }
          const value = await step.run(context);
          controller.signal.throwIfAborted();
          if (step.commit) {
            try { await step.commit(value, context); committed = true; }
            catch (error) { fatal = new StepPersistenceError(error); throw fatal; }
          }
          controller.signal.throwIfAborted();
          let outcome: StepResult<T> = { status: 'succeeded', identity: current, value };
          if (step.evidence) {
            try { await step.evidence(value, context); controller.signal.throwIfAborted(); }
            catch (error) {
              if (controller.signal.aborted) throw error;
              diagnostics.push({ phase: 'evidence', error: originalError(error) });
              outcome = { status: 'partial', identity: current, value, error: originalError(error) };
            }
          }
          return outcome;
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
        result = await Promise.race([work, interrupted]);
        controller.signal.throwIfAborted();
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
        catch (error) {
          diagnostics.push({ phase: 'cleanup', error: originalError(error) });
          unsafeResources.set(resourceKey, new Error('Resource cleanup failed; replace the resource before another step', { cause: error }));
        }
      }
      if (fatal) throw fatal;
      if (diagnostics.some(item => item.phase === 'cleanup') && result.status === 'succeeded') result = { ...result, status: 'partial', error: diagnostics.find(item => item.phase === 'cleanup')!.error };
      await record(result, diagnostics, rerun);
      if (result.status !== 'failed' || committed || unsafeResources.has(resourceKey) || !step.retry || attempt + 1 >= maxAttempts || options.signal.aborted || Date.now() - startedAt + step.retry.backoffMs >= step.retry.totalBudgetMs) return result;
      // Unsafe/non-idempotent steps have no retry option; every retry gets a new attempt identity.
      try { await delay(step.retry.backoffMs, undefined, { signal: options.signal }); }
      catch { return record({ status: 'cancelled', identity: identity(), error: originalError(options.signal.reason) }); }
    }
    throw new Error('Unreachable attempt boundary');
  }
  return { pending: () => pendingSteps,
    selected: (stepId, entityKey) => (!selection?.stepIds || selection.stepIds.includes(stepId)) && (!selection?.entityKeys || (entityKey !== undefined && selection.entityKeys.includes(entityKey))),
    run: <T>(step: StepOptions<T>): Promise<StepResult<T>> => {
    if (!step.stepId || step.stepId.length > 128 || (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 1))) return Promise.reject(new Error('Invalid step identity or timeout'));
    if (step.retry && (!['read-only', 'idempotent'].includes(step.retry.policy) || !Number.isSafeInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1 || step.retry.maxAttempts > 5 || !Number.isFinite(step.retry.backoffMs) || step.retry.backoffMs < 0 || step.retry.backoffMs > 30_000 || !Number.isFinite(step.retry.totalBudgetMs) || step.retry.totalBudgetMs < 1 || step.retry.totalBudgetMs > 30 * 60_000)) return Promise.reject(new Error('Retry requires explicit idempotence, at most 5 attempts, bounded backoff and total budget'));
    const resourceKey = step.resourceKey ?? 'shared-page';
    if (pendingSteps >= 256 || (!resources.has(resourceKey) && resources.size >= 64)) return Promise.reject(new Error('Step queue exceeds 256 pending steps or 64 owned resources; await step results'));
    pendingSteps++;
    const previous = resources.get(resourceKey) ?? Promise.resolve();
    const pending = previous.then(() => execute(step, resourceKey)).finally(() => { pendingSteps--; });
    const settled = pending.then(() => undefined, () => undefined);
    resources.set(resourceKey, settled);
    void settled.finally(() => { if (resources.get(resourceKey) === settled) resources.delete(resourceKey); });
    return pending;
  } };
}
export function parseStepSelection(value?: StepSelection): StepSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid step selection');
  const result: StepSelection = {};
  for (const field of ['stepIds', 'entityKeys'] as const) {
    const values = value[field];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length === 0 || values.length > 256 || !values.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256) || new Set(values).size !== values.length) throw new Error('Step selection requires 1–256 distinct step IDs or entity keys');
    result[field] = [...values];
  }
  return result;
}
