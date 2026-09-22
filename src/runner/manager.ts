import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import type { CheckpointDetails, DataProvenance, Dataset, HumanRequest, JsonValue, ReportedAssertion, WorkflowManifest, WorkflowReporter } from '../contracts/workflow';
import { GateTransport } from './gate';
import { fingerprintInput, fingerprintWorkflow, loadWorkflow, resolveRegisteredFile, type WorkflowFingerprint } from './fingerprint';
import { validateExecution, type ValidationResult } from './validation';
import type { HostMessage, WorkerMessage } from './context';

export type RunnerHooks = Omit<WorkflowReporter, 'signal' | 'requestHuman' | 'checkpoint'> & {
  requestHuman(request: HumanRequest, signal?: AbortSignal): Promise<void>;
  checkpoint(key: string, details?: CheckpointDetails, signal?: AbortSignal): Promise<{ id: string }>;
};
export interface StartWorkflowOptions {
  directory: string;
  manifest?: string;
  input: unknown;
  targetId: string;
  /** A fresh, main-owned operation connection dedicated to this worker. */
  transport: GateTransport;
  hooks: RunnerHooks;
  workerPath?: string;
  dependencyLockPath?: string;
  knownSourceRefs?: string[];
  maxDurationMs?: number;
  /** Persist the execution identity before a worker can run user code. */
  beforeWorker?: (prepared: WorkflowPrepared) => Promise<void>;
  onStarted?: (nodeVersion: string, signal: AbortSignal) => Promise<void>;
  startupSignal?: AbortSignal;
}

export interface WorkflowPrepared {
  manifest: WorkflowManifest;
  entryPath: string;
  inputSha256: string;
  fingerprintBefore: WorkflowFingerprint;
  startedAt: string;
}

export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  manifest: WorkflowManifest;
  entryPath: string;
  inputSha256: string;
  runtimeNodeVersion: string | null;
  fingerprintBefore: WorkflowFingerprint;
  fingerprintAfter: WorkflowFingerprint;
  checkpoints: { id: string; key: string }[];
  datasets: Dataset[];
  assertions: ReportedAssertion[];
  humanAttempts: { id: string; startedAt: string; finishedAt?: string; status: 'waiting' | 'completed' | 'failed' }[];
  output?: unknown;
  error?: string;
  validation: ValidationResult;
}

export interface WorkflowHandle {
  done: Promise<WorkflowRunResult>;
  /** Resolves only once the worker has exited; caller may then unlock input. */
  cancel(reason?: string): Promise<void>;
}

export async function startWorkflow(options: StartWorkflowOptions): Promise<WorkflowHandle> {
  const loaded = await loadWorkflow(options.directory, options.manifest);
  const { manifest, entryPath } = loaded;
  const ajv = new Ajv({ allErrors: true, strict: true });
  const loadSchema = async (name: string) => {
    const schemaFile = await resolveRegisteredFile(options.directory, path.resolve(path.dirname(loaded.manifestPath), name));
    return ajv.compile(JSON.parse(await readFile(schemaFile, 'utf8')));
  };
  if (manifest.inputSchema) {
    const validate = await loadSchema(manifest.inputSchema);
    if (!validate(options.input)) throw new Error(`Workflow input violates schema: ${ajv.errorsText(validate.errors)}`);
  }
  const validateOutput = manifest.outputSchema ? await loadSchema(manifest.outputSchema) : undefined;
  const fingerprintBefore = await fingerprintWorkflow(options.directory, options.dependencyLockPath);
  const inputSha256 = fingerprintInput(options.input);
  const checkpoints: WorkflowRunResult['checkpoints'] = [];
  const datasets: Dataset[] = [];
  const assertions: ReportedAssertion[] = [];
  const humanAttempts: WorkflowRunResult['humanAttempts'] = [];
  const sources = new Set(options.knownSourceRefs ?? []);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  options.startupSignal?.throwIfAborted();
  await options.beforeWorker?.({ manifest, entryPath, inputSha256, fingerprintBefore, startedAt });
  options.startupSignal?.throwIfAborted();
  const worker = new Worker(options.workerPath ?? path.join(import.meta.dirname, 'runner-worker.js'), {
    workerData: { entryPath, exportName: manifest.exportName, input: options.input, targetId: options.targetId },
  });
  let status: WorkflowRunResult['status'] = 'interrupted';
  let error: string | undefined;
  let output: unknown;
  let runtimeNodeVersion: string | null = null;
  let stopping = false;
  let completeReceived = false;
  let reportCalls = 0;
  let activeExclusive = false;
  let totalReportedBytes = 0;
  const cancellation = new AbortController();
  const outstandingReports = new Set<Promise<unknown>>();
  let settle!: (result: WorkflowRunResult) => void;
  const done = new Promise<WorkflowRunResult>(resolve => { settle = resolve; });
  const send = (message: HostMessage) => { if (!stopping) worker.postMessage(message); };
  options.transport.onmessage = message => send({ type: 'cdp.message', message });
  options.transport.onclose = () => {
    send({ type: 'cdp.closed' });
    if (!stopping && !completeReceived) void stop('failed', 'Operation transport disconnected');
  };
  const maxDuration = setTimeout(() => { void stop('failed', 'Workflow maximum duration elapsed'); }, options.maxDurationMs ?? 30 * 60_000);

  async function stop(nextStatus: WorkflowRunResult['status'], reason: string): Promise<void> {
    if (stopping) { await done; return; }
    status = nextStatus;
    error = reason;
    cancellation.abort(new Error(reason));
    worker.postMessage({ type: 'cancel', reason } satisfies HostMessage);
    stopping = true;
    options.transport.close();
    await worker.terminate();
    await done;
  }

  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (activeExclusive) throw new Error('Concurrent checkpoint/handoff requests are not allowed');
    activeExclusive = true;
    try {
      await options.transport.quiesce();
      const value = await action();
      if (!stopping) options.transport.resume();
      return value;
    } finally { activeExclusive = false; }
  }

  async function report(message: Extract<WorkerMessage, { type: 'reporter' }>): Promise<unknown> {
    const args = message.args;
    totalReportedBytes += Buffer.byteLength(JSON.stringify(args));
    if (totalReportedBytes > 32 * 1024 * 1024) throw new Error('Workflow reporter exceeded 32 MiB; emit bounded datasets and attach focused evidence');
    switch (message.method) {
      case 'checkpoint': {
        const [key, details] = args as [string, CheckpointDetails | undefined];
        if (typeof key !== 'string' || !/^[\w.-]{1,128}$/.test(key)) throw new Error('Invalid checkpoint key');
        const result = await exclusive(() => options.hooks.checkpoint(key, details, cancellation.signal));
        checkpoints.push({ id: result.id, key }); sources.add(result.id);
        return result;
      }
      case 'emitData': {
        const [name, records, provenance] = args as [string, JsonValue[], DataProvenance];
        if (typeof name !== 'string' || !Array.isArray(records) || !provenance || !Array.isArray(provenance.sourceRefs) || !['browser', 'node', 'derived'].includes(provenance.origin)) throw new Error('Invalid emitted dataset');
        if (datasets.some(dataset => dataset.name === name)) throw new Error(`Dataset ${name} was already emitted; build the final dataset in ordinary JS`);
        await options.hooks.emitData(name, records, provenance);
        datasets.push({ name, records, ...provenance }); return;
      }
      case 'attachArtifact': {
        const [name, content, mediaType] = args as [string, string | Uint8Array, string];
        if (typeof name !== 'string' || typeof mediaType !== 'string' || (typeof content !== 'string' && !(content instanceof Uint8Array))) throw new Error('Invalid artifact');
        const result = await options.hooks.attachArtifact(name, content, mediaType); sources.add(result.id); return result;
      }
      case 'assertion': {
        const [assertion] = args as [ReportedAssertion];
        if (!assertion || !manifest.requirements.some(requirement => requirement.id === assertion.requirementId) || !['pass', 'fail', 'inconclusive'].includes(assertion.verdict) || !Array.isArray(assertion.sourceRefs)) throw new Error('Invalid assertion or undeclared requirement');
        await options.hooks.assertion(assertion); assertions.push(assertion); return;
      }
      case 'requestHuman': {
        const [request] = args as [HumanRequest];
        if (!request || !manifest.humanPoints?.some(point => point.id === request.id)) throw new Error('Undeclared human assistance point');
        if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30 * 60_000 || !request.completionCheck?.selector || !request.instructions) throw new Error('Invalid human request');
        const attempt: WorkflowRunResult['humanAttempts'][number] = { id: request.id, startedAt: new Date().toISOString(), status: 'waiting' };
        humanAttempts.push(attempt);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await exclusive(() => Promise.race([
            options.hooks.requestHuman(request, cancellation.signal),
            new Promise<never>((_, reject) => {
              if (cancellation.signal.aborted) reject(cancellation.signal.reason);
              else cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true });
            }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Human assistance timed out; completion remains unverified')), request.timeoutMs); }),
          ]));
          attempt.status = 'completed';
        } catch (cause) { attempt.status = 'failed'; throw cause; }
        finally { if (timer) clearTimeout(timer); attempt.finishedAt = new Date().toISOString(); }
        return;
      }
      case 'progress': {
        const [text] = args as [string];
        if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) throw new Error('Progress message exceeds 8 KiB');
        return options.hooks.progress(text);
      }
      default: throw new Error('Unknown reporter method');
    }
  }

  worker.on('message', (message: WorkerMessage) => {
    if (stopping) return;
    if(message.type==='started'){
      runtimeNodeVersion=message.nodeVersion;
      if(options.onStarted){
        const started=options.onStarted(message.nodeVersion,cancellation.signal).catch(cause=>{
          if(!stopping)void stop('failed',`Could not save worker startup: ${String(cause)}`);
        }).finally(()=>outstandingReports.delete(started));
        outstandingReports.add(started);
      }
    }
    else if (message.type === 'cdp.send') {
      if(process.env.BES_TEST_VERBOSE){const trace=JSON.parse(message.message);console.log('worker CDP',trace.id,trace.method,trace.method==='Runtime.callFunctionOn'?trace.params?.functionDeclaration?.slice(0,160):'');}
      const before = options.transport.snapshot().rejectedCommands;
      try {
        options.transport.send(message.message);
        if (options.transport.snapshot().rejectedCommands !== before) void stop('failed', 'Workflow attempted a browser operation while control was revoked');
      } catch (cause) { void stop('failed', String(cause)); }
    } else if (message.type === 'cdp.close') {
      options.transport.close();
    } else if (message.type === 'reporter') {
      reportCalls += 1;
      const reported = report(message).then(value => send({ type: 'reply', id: message.id, value }), cause => {
        send({ type: 'reply', id: message.id, error: String(cause) });
        void stop('failed', String(cause));
      }).finally(() => { reportCalls -= 1; outstandingReports.delete(reported); });
      outstandingReports.add(reported);
    } else if (message.type === 'complete') {
      completeReceived = true;
      runtimeNodeVersion = message.nodeVersion;
      output = message.output;
      if (reportCalls > 0) { void stop('failed', 'Workflow completed with pending reporter operations'); return; }
      if (validateOutput && !validateOutput(output)) { void stop('failed', `Output violates schema: ${ajv.errorsText(validateOutput.errors)}`); return; }
      void options.transport.quiesce().then(() => {
        if (stopping) return;
        status = 'completed';
        send({ type: 'finish' });
      }, cause => { void stop('failed', `Workflow completion could not drain browser operations: ${String(cause)}`); });
    } else if (message.type === 'failed') {
      runtimeNodeVersion = message.nodeVersion;
      void stop('failed', message.error);
    }
  });
  worker.once('error', cause => { status = 'failed'; error = cause.stack||cause.message; });
  worker.once('exit', code => {
    stopping = true;
    cancellation.abort(new Error('Worker exited'));
    clearTimeout(maxDuration);
    options.transport.close();
    if (status === 'completed' && code !== 0) { status = 'failed'; error = `Worker exited with code ${code}`; }
    if (!completeReceived && !error) error = `Worker exited without completion (code ${code})`;
    void (async () => {
      await Promise.allSettled(outstandingReports);
      let fingerprintAfter: WorkflowFingerprint;
      try { fingerprintAfter = await fingerprintWorkflow(options.directory, options.dependencyLockPath); }
      catch (cause) {
        status = 'failed'; error = `${error ?? ''} Fingerprint after execution failed: ${String(cause)}`.trim();
        fingerprintAfter = { sha256: 'unavailable-after-execution', files: [], dependencyLockSha256: null };
      }
      const validation = validateExecution({ manifest, execution: status, checkpoints, datasets, assertions, fingerprintBefore, fingerprintAfter, knownSourceRefs: [...sources] });
      settle({ status, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, manifest, entryPath, inputSha256, runtimeNodeVersion, fingerprintBefore, fingerprintAfter, checkpoints, datasets, assertions, humanAttempts, output, error, validation });
    })();
  });
  return { done, cancel: reason => stop('cancelled', reason ?? 'Cancelled by user') };
}
