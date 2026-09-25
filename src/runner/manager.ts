import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import Ajv from 'ajv';
import type { CheckpointDetails, CheckpointReceipt, DataProvenance, Dataset, HumanRequest, JsonValue, ReportedAssertion, WorkflowManifest, WorkflowReporter } from '@/contracts/workflow';
import { GateTransport, type GateCloseDiagnostic } from './gate';
import { fingerprintInput, fingerprintWorkflow, loadWorkflow, resolveRegisteredFile, type WorkflowFingerprint } from './fingerprint';
import { validateExecution, type ValidationResult } from './validation';
import { assertWorkflowOutputBudget, type HostMessage, type WorkerMessage } from './context';
import type { DatasetBatch, DatasetCompletion, DatasetIdentity, DatasetService, ExecutionBinding, OriginalError, StepIdentity } from '../contracts/execution';
import { originalError } from './errors';
import { parseStepSelection, type StepEvent, type StepSelection } from './steps';
import { prepareExecutionSnapshot, type ExecutionSnapshot } from './snapshot';
import { canonicalJson, executionId } from './datasets';

/** Resolved by the manager; script checkpoint details are not scope facts. */
export interface CheckpointHostScope { executionId: string; attemptId: string; stepId?: string }
export type RunnerHooks = Omit<WorkflowReporter, 'signal' | 'requestHuman' | 'checkpoint'> & {
  requestHuman(request: HumanRequest, signal?: AbortSignal): Promise<void>;
  checkpoint(key: string, details?: CheckpointDetails, signal?: AbortSignal, scope?: CheckpointHostScope): Promise<CheckpointReceipt>;
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
  execution?: { binding: ExecutionBinding; datasets: DatasetService; saveStep: (event: StepEvent) => Promise<void> };
  /** Main-owned archive directory for immutable code copies. Defaults to a fresh temporary directory. */
  snapshotDirectory?: string;
  /** Ordinary business code applies selection through steps.selected(); no hidden workflow DSL. */
  selection?: StepSelection;
}

export interface WorkflowPrepared {
  manifest: WorkflowManifest;
  entryPath: string;
  inputSha256: string;
  fingerprintBefore: WorkflowFingerprint;
  startedAt: string;
  snapshot?: ExecutionSnapshot;
  sourceEntryPath?: string;
  selection?: StepSelection;
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
  errorSource?: 'worker' | 'worker-disconnect' | 'transport' | 'host' | 'worker-exit';
  errorStack?: string;
  originalError?: OriginalError;
  executionBinding?: ExecutionBinding;
  workflowAttemptId?: string;
  datasetSummaries?: DatasetSummary[];
  steps?: StepSummary[];
  evidenceErrors?: { method: string; error: OriginalError }[];
  snapshot?: ExecutionSnapshot;
  selection?: StepSelection;
  operationTransportClose?: GateCloseDiagnostic;
  validation: ValidationResult;
}
export interface DatasetSummary extends DatasetIdentity { status: DatasetCompletion['status'] | 'unfinished'; committedBatches: number; committedRecords: number }
export type StepSummary = Pick<StepEvent, 'identity' | 'state' | 'occurredAt' | 'diagnostics' | 'rerun' | 'resultValueState'> & { error?: OriginalError; dependencies?: StepIdentity[]; handoffId?: string };
function summarizeStep(event: StepEvent): StepSummary {
  return { identity: event.identity, state: event.state, occurredAt: event.occurredAt, ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}),
    ...(event.rerun ? { rerun: event.rerun } : {}),
    ...(event.resultValueState ? { resultValueState: event.resultValueState } : {}),
    ...(event.result && 'error' in event.result ? { error: event.result.error } : {}),
    ...(event.result?.status === 'blocked' ? { dependencies: event.result.dependencies } : {}),
    ...(event.result?.status === 'awaiting-human' ? { handoffId: event.result.handoffId } : {}) };
}

export interface WorkflowHandle {
  done: Promise<WorkflowRunResult>;
  /** Resolves only once the worker has exited; caller may then unlock input. */
  cancel(reason?: string): Promise<void>;
}

export async function startWorkflow(options: StartWorkflowOptions): Promise<WorkflowHandle> {
  const selection = parseStepSelection(options.selection);
  const loaded = await loadWorkflow(options.directory, options.manifest);
  const { manifest, entryPath: sourceEntryPath } = loaded;
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
  options.startupSignal?.throwIfAborted();
  const snapshot = await prepareExecutionSnapshot(options.directory, fingerprintBefore, options.snapshotDirectory, options.startupSignal);
  const entryPath = path.join(snapshot.directory, path.relative(await realpath(options.directory), sourceEntryPath));
  if (options.execution && (options.execution.binding.codeFingerprint !== fingerprintBefore.sha256 || options.execution.binding.inputFingerprint !== inputSha256)) throw new Error('Execution binding does not match the actual code and input fingerprints');
  const executionBinding = options.execution ? structuredClone(options.execution.binding) : undefined;
  const workflowAttemptId = randomUUID();
  const checkpoints: WorkflowRunResult['checkpoints'] = [];
  const datasets: Dataset[] = [];
  const assertions: ReportedAssertion[] = [];
  const humanAttempts: WorkflowRunResult['humanAttempts'] = [];
  const sources = new Set(options.knownSourceRefs ?? []);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  options.startupSignal?.throwIfAborted();
  await options.beforeWorker?.({ manifest, entryPath, inputSha256, fingerprintBefore, startedAt, snapshot, sourceEntryPath, selection });
  options.startupSignal?.throwIfAborted();
  const worker = new Worker(options.workerPath ?? path.join(import.meta.dirname, 'runner-worker.js'), {
    workerData: { entryPath, exportName: manifest.exportName, input: options.input, targetId: options.targetId, snapshot, selection, ...(executionBinding ? { execution: { binding: executionBinding, attemptId: workflowAttemptId } } : {}) },
  });
  let status: WorkflowRunResult['status'] = 'interrupted';
  let error: string | undefined;
  let errorSource: WorkflowRunResult['errorSource'];
  let errorStack: string | undefined;
  let firstError: OriginalError | undefined;
  const datasetSummaries = new Map<string, DatasetSummary>();
  const steps: StepSummary[] = [];
  const evidenceErrors: { method: string; error: OriginalError }[] = [];
  const interruptedSteps = new Map<string, StepEvent>();
  const checkpointAttempts = new Set<string>();
  const stepTransitions = new Set<string>();
  let output: unknown;
  let runtimeNodeVersion: string | null = null;
  let stopping = false;
  let completeReceived = false;
  let reportCalls = 0;
  let activeExclusive = false;
  let totalReportedBytes = 0;
  let disconnectDeadline: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  const outstandingReports = new Set<Promise<unknown>>();
  let settle!: (result: WorkflowRunResult) => void;
  const done = new Promise<WorkflowRunResult>(resolve => { settle = resolve; });
  const send = (message: HostMessage) => { if (!stopping) worker.postMessage(message); };
  options.transport.onmessage = message => send({ type: 'cdp.message', message });
  options.transport.onclose = () => {
    send({ type: 'cdp.closed' });
    if (stopping || status === 'completed') return;
    const closure = options.transport.closeDiagnostic;
    console.warn('Runner operation transport closed', JSON.stringify(closure));
    if (closure?.trigger === 'worker') {
      // Puppeteer disconnects in its error cleanup BEFORE the worker can report
      // the original failure. Keep the gate closed, but let that FIFO message win.
      disconnectDeadline = setTimeout(() => {
        void stop('failed', 'Worker closed the operation transport without reporting its outcome', 'worker-disconnect');
      }, 1000);
    } else {
      const info = closure?.transport;
      const detail = info ? ` (${info.source}${info.code === undefined ? '' : `; code=${info.code}`}${info.errorCode ? `; ${info.errorCode}` : ''})` : '';
      void stop('failed', `Operation transport disconnected${detail}`, 'transport');
    }
  };
  const maxDuration = setTimeout(() => { void stop('failed', 'Workflow maximum duration elapsed'); }, options.maxDurationMs ?? 30 * 60_000);

  async function stop(nextStatus: WorkflowRunResult['status'], reason: string, source: WorkflowRunResult['errorSource'] = 'host', stack?: string, cause?: OriginalError): Promise<void> {
    if (stopping) { await done; return; }
    status = nextStatus;
    error = reason;
    errorSource = source;
    errorStack = stack?.slice(0,8192);
    firstError ??= cause ?? { name: nextStatus === 'cancelled' ? 'AbortError' : 'Error', message: reason, ...(stack ? { stack } : {}) };
    if (disconnectDeadline) clearTimeout(disconnectDeadline);
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
    cancellation.signal.throwIfAborted();
    const args = message.args;
    const reportBytes = Buffer.byteLength(JSON.stringify(args));
    if (options.execution && reportBytes > 1024 * 1024 + 16384) throw new Error('One reporter call exceeds 1 MiB; split data into batches');
    if (!['appendBatch', 'beginDataset', 'finishDataset'].includes(message.method)) totalReportedBytes += reportBytes;
    if (totalReportedBytes > 32 * 1024 * 1024) throw new Error('Workflow reporter exceeded 32 MiB; emit bounded datasets and attach focused evidence');
    switch (message.method) {
      case 'checkpoint': {
        const [key, details] = args as [string, CheckpointDetails | undefined];
        if (typeof key !== 'string' || !/^[\w.-]{1,128}$/.test(key)) throw new Error('Invalid checkpoint key');
        if (activeExclusive) throw new Error('Concurrent checkpoint/handoff requests are not allowed');
        if (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details))) throw new Error('Invalid checkpoint details');
        let scope: CheckpointHostScope | undefined = executionBinding ? { executionId: executionBinding.executionId, attemptId: workflowAttemptId } : undefined;
        if (details?.stepAttemptId !== undefined) {
          executionId(details.stepAttemptId);
          const step = interruptedSteps.get(details.stepAttemptId);
          if (!scope || !step || step.state !== 'running' || stepTransitions.has(details.stepAttemptId)) throw new Error('Checkpoint requires a currently running step attempt');
          scope = { executionId: scope.executionId, attemptId: step.identity.attemptId, stepId: step.identity.stepId };
        }
        const pinnedAttempt = details?.stepAttemptId;
        if (pinnedAttempt) checkpointAttempts.add(pinnedAttempt);
        try {
          const result = await exclusive(() => options.hooks.checkpoint(key, details, cancellation.signal, scope));
          const validRef = (ref: unknown): ref is string => typeof ref === 'string' && ref.length > 0 && Buffer.byteLength(ref) <= 512 && !/[\u0000-\u001f\u007f]/.test(ref);
          if (!result || !validRef(result.id) || (result.sourceRefs !== undefined && (!Array.isArray(result.sourceRefs) || result.sourceRefs.length > 64 || !result.sourceRefs.every(validRef)))) throw new Error('Checkpoint receipt exceeds the host evidence handle budget');
          const receipt: CheckpointReceipt = { id: result.id, ...(result.sourceRefs ? { sourceRefs: [...new Set(result.sourceRefs)] } : {}) };
          checkpoints.push({ id: receipt.id, key }); sources.add(receipt.id);
          for (const ref of receipt.sourceRefs ?? []) sources.add(ref);
          return receipt;
        } finally { if (pinnedAttempt) checkpointAttempts.delete(pinnedAttempt); }
      }
      case 'emitData': {
        const [name, records, provenance] = args as [string, JsonValue[], DataProvenance];
        if (typeof name !== 'string' || !Array.isArray(records) || !provenance || !Array.isArray(provenance.sourceRefs) || !['browser', 'node', 'derived'].includes(provenance.origin)) throw new Error('Invalid emitted dataset');
        if (options.execution) {
          const identity = { executionId: options.execution.binding.executionId, attemptId: workflowAttemptId, datasetId: executionId(name) };
          await beginDataset(identity);
          const receipt = await options.execution.datasets.append({ ...identity, batchId: 'legacy-emitData', records, provenance }, cancellation.signal);
          acceptReceipt(identity, receipt.recordCount, receipt.replayed);
          const completion: DatasetCompletion = { ...identity, status: provenance.pagination?.complete === false ? 'partial' : 'complete', committedBatches: 1, committedRecords: records.length, ...(provenance.pagination ? { pagination: provenance.pagination } : {}) };
          await options.execution.datasets.finish(completion);
          datasetSummaries.get(canonicalJson(identity))!.status = completion.status;
          return;
        }
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
      case 'beginDataset': return beginDataset(args[0] as DatasetIdentity);
      case 'appendBatch': {
        if (!options.execution) throw new Error('Incremental dataset execution is not configured');
        const batch = args[0] as DatasetBatch;
        const identity = checkDataset(batch);
        const receipt = await options.execution.datasets.append(batch, cancellation.signal);
        acceptReceipt(identity, receipt.recordCount, receipt.replayed);
        return receipt;
      }
      case 'finishDataset': {
        if (!options.execution) throw new Error('Incremental dataset execution is not configured');
        const completion = args[0] as DatasetCompletion;
        const identity = checkDataset(completion);
        await options.execution.datasets.finish(completion);
        datasetSummaries.get(canonicalJson(identity))!.status = completion.status;
        return;
      }
      case 'stepEvent': {
        if (!options.execution) throw new Error('Step persistence is not configured');
        const event = args[0] as StepEvent;
        if (!event?.identity || event.identity.executionId !== executionBinding?.executionId || !['running', 'succeeded', 'partial', 'failed', 'blocked', 'cancelled', 'awaiting-human'].includes(event.state) || steps.length >= 2048 || reportBytes > 64 * 1024) throw new Error('Invalid step event or step report budget exceeded');
        executionId(event.identity.attemptId); executionId(event.identity.stepId);
        if (checkpointAttempts.has(event.identity.attemptId)) throw new Error('Step state cannot change while its checkpoint is being captured');
        if (stepTransitions.has(event.identity.attemptId)) throw new Error('Concurrent state changes for one step attempt are not allowed');
        const activeStep = interruptedSteps.get(event.identity.attemptId);
        if (activeStep && canonicalJson(activeStep.identity) !== canonicalJson(event.identity)) throw new Error('Cannot replace an active step identity');
        stepTransitions.add(event.identity.attemptId);
        try {
          await options.execution.saveStep(event);
          steps.push(summarizeStep(event));
          if (event.state === 'running' || event.state === 'awaiting-human') interruptedSteps.set(event.identity.attemptId, event);
          else interruptedSteps.delete(event.identity.attemptId);
        } finally { stepTransitions.delete(event.identity.attemptId); }
        return;
      }
      case 'interruptStep': {
        const [identity, reason] = args as [StepIdentity, OriginalError];
        if (identity?.executionId !== executionBinding?.executionId || !interruptedSteps.has(identity.attemptId)) throw new Error('Cannot interrupt an unknown step');
        void stop('failed', reason.message, 'worker', reason.stack, reason);
        return;
      }
      default: throw new Error('Unknown reporter method');
    }
  }
  function checkDataset(identity: DatasetIdentity): DatasetIdentity {
    if (!options.execution || !identity || identity.executionId !== executionBinding?.executionId) throw new Error('Dataset has the wrong execution identity');
    executionId(identity.attemptId); executionId(identity.datasetId);
    const key = canonicalJson({ executionId: identity.executionId, attemptId: identity.attemptId, datasetId: identity.datasetId });
    if (!datasetSummaries.has(key)) throw new Error('Dataset must begin before appending or finishing');
    return { executionId: identity.executionId, attemptId: identity.attemptId, datasetId: identity.datasetId };
  }
  async function beginDataset(identity: DatasetIdentity): Promise<void> {
    if (!options.execution || !identity || identity.executionId !== executionBinding?.executionId) throw new Error('Dataset has the wrong execution identity');
    executionId(identity.attemptId); executionId(identity.datasetId);
    if (identity.attemptId !== workflowAttemptId && !interruptedSteps.has(identity.attemptId)) throw new Error('Dataset requires the current workflow or an active step attempt');
    const key = canonicalJson(identity);
    if (!datasetSummaries.has(key) && datasetSummaries.size >= 128) throw new Error('Execution exceeds 128 dataset summaries');
    await options.execution.datasets.begin(identity);
    if (!datasetSummaries.has(key)) datasetSummaries.set(key, { ...identity, status: 'unfinished', committedBatches: 0, committedRecords: 0 });
  }
  function acceptReceipt(identity: DatasetIdentity, count: number, replayed: boolean): void {
    const summary = datasetSummaries.get(canonicalJson(identity))!;
    if (!replayed) { summary.committedBatches++; summary.committedRecords += count; }
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
        if (options.transport.snapshot().rejectedCommands !== before) {
          const { method } = JSON.parse(message.message) as { method: string };
          void stop('failed', `Workflow attempted a browser operation while control was revoked (${method}; gate=${options.transport.snapshot().state})`);
        }
      } catch (cause) { void stop('failed', String(cause)); }
    } else if (message.type === 'cdp.close') {
      options.transport.close('worker');
    } else if (message.type === 'reporter') {
      if (reportCalls >= 64) { void stop('failed', 'Too many concurrent reporter operations; await their receipts'); return; }
      reportCalls += 1;
      const reported = report(message).then(value => send({ type: 'reply', id: message.id, value }), cause => {
        send({ type: 'reply', id: message.id, error: String(cause), originalError: originalError(cause) });
        if (message.method === 'attachArtifact' && !cancellation.signal.aborted) evidenceErrors.push({ method: message.method, error: originalError(cause) });
        else void stop('failed', String(cause), 'host', cause instanceof Error ? cause.stack : undefined, originalError(cause));
      }).finally(() => { reportCalls -= 1; outstandingReports.delete(reported); });
      outstandingReports.add(reported);
    } else if (message.type === 'complete') {
      try { assertWorkflowOutputBudget(message.output); }
      catch (cause) { void stop('failed', String(cause), 'host', cause instanceof Error ? cause.stack : undefined, originalError(cause)); return; }
      completeReceived = true;
      runtimeNodeVersion = message.nodeVersion;
      output = message.output;
      if (reportCalls > 0) { void stop('failed', 'Workflow completed with pending reporter operations'); return; }
      if (interruptedSteps.size) { void stop('failed', 'Workflow completed with unfinished step attempts'); return; }
      if (validateOutput && !validateOutput(output)) { void stop('failed', `Output violates schema: ${ajv.errorsText(validateOutput.errors)}`); return; }
      void options.transport.quiesce().then(() => {
        if (stopping) return;
        status = 'completed';
        send({ type: 'finish' });
      }, cause => { void stop('failed', `Workflow completion could not drain browser operations: ${String(cause)}`); });
    } else if (message.type === 'failed') {
      runtimeNodeVersion = message.nodeVersion;
      if (message.cleanupError) evidenceErrors.push({ method: 'worker-cleanup', error: message.cleanupError });
      void stop('failed', `${message.name ? `${message.name.slice(0,128)}: ` : ''}${message.error.slice(0,4096)}`, 'worker', message.stack, message.originalError);
    }
  });
  worker.once('error', cause => {
    if (stopping) return;
    status = 'failed'; error = cause.message.slice(0,4096); errorSource = 'worker'; errorStack = cause.stack?.slice(0,8192);
    firstError ??= originalError(cause);
  });
  worker.once('exit', code => {
    stopping = true;
    cancellation.abort(new Error('Worker exited'));
    clearTimeout(maxDuration);
    if (disconnectDeadline) clearTimeout(disconnectDeadline);
    options.transport.close();
    if (status === 'completed' && code !== 0) { status = 'failed'; error = `Worker exited with code ${code}`; }
    if (!completeReceived && !error) {
      error = `Worker exited without completion (code ${code})`;
      errorSource = options.transport.closeDiagnostic?.trigger === 'worker' ? 'worker-disconnect' : 'worker-exit';
    }
    void (async () => {
      await Promise.allSettled(outstandingReports);
      for (const event of interruptedSteps.values()) {
        const failure: StepEvent = { identity: event.identity, state: status === 'cancelled' ? 'cancelled' : 'failed', occurredAt: new Date().toISOString(), ...(event.rerun ? { rerun: event.rerun } : {}),
          result: { status: status === 'cancelled' ? 'cancelled' : 'failed', identity: event.identity, error: firstError ?? { name: 'WorkerInterrupted', message: error ?? 'Worker exited without completing this step' } } };
        try { await options.execution?.saveStep(failure); steps.push(summarizeStep(failure)); }
        catch (cause) { status = 'failed'; error = `${error ?? ''} Step interruption could not be saved: ${String(cause)}`.trim(); }
      }
      let fingerprintAfter: WorkflowFingerprint;
      try { fingerprintAfter = await fingerprintWorkflow(options.directory, options.dependencyLockPath); }
      catch (cause) {
        status = 'failed'; error = `${error ?? ''} Fingerprint after execution failed: ${String(cause)}`.trim();
        fingerprintAfter = { sha256: 'unavailable-after-execution', files: [], dependencyLockSha256: null };
      }
      const validation = validateExecution({ manifest, execution: status, checkpoints, datasets, assertions, fingerprintBefore, fingerprintAfter, knownSourceRefs: [...sources] });
      if (executionBinding) validation.warnings.push('Dataset summaries require fixed-material evaluation; script completion does not verify user requirements or pagination');
      settle({ status, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, manifest, entryPath, inputSha256, runtimeNodeVersion, fingerprintBefore, fingerprintAfter, checkpoints, datasets, assertions, humanAttempts, output, error, errorSource, errorStack, originalError: firstError, snapshot, selection, ...(executionBinding ? { executionBinding, workflowAttemptId, datasetSummaries: [...datasetSummaries.values()], steps } : {}), evidenceErrors, operationTransportClose: options.transport.closeDiagnostic, validation });
    })();
  });
  return { done, cancel: reason => stop('cancelled', reason ?? 'Cancelled by user') };
}
