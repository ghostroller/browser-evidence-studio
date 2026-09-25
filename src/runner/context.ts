import type { WorkflowReporter } from '@/contracts/workflow';
import type { BatchReceipt, DatasetBatch, DatasetCompletion, DatasetIdentity, ExecutionBinding, OriginalError, StepIdentity } from '../contracts/execution';
import type { StepEvent } from './steps';
import { restoreError } from './errors';
import type { ExecutionSnapshot } from './snapshot';

export interface IncrementalWorkflowReporter extends WorkflowReporter {
  readonly execution?: { binding: ExecutionBinding; attemptId: string };
  beginDataset(identity: DatasetIdentity): Promise<void>;
  appendBatch(batch: DatasetBatch): Promise<BatchReceipt>;
  finishDataset(completion: DatasetCompletion): Promise<void>;
  stepEvent(event: StepEvent): Promise<void>;
  /** A managed page timeout is fatal to this worker; the host waits for actual termination. */
  interruptStep(identity: StepIdentity, reason: OriginalError): Promise<never>;
}
export type ReporterMethod = Exclude<keyof IncrementalWorkflowReporter, 'signal' | 'execution'>;
export type WorkerMessage =
  | { type: 'started'; nodeVersion: string }
  | { type: 'cdp.send'; message: string }
  | { type: 'cdp.close' }
  | { type: 'reporter'; id: number; method: ReporterMethod; args: unknown[] }
  | { type: 'complete'; output: unknown; nodeVersion: string }
  | { type: 'failed'; error: string; name?: string; stack?: string; originalError?: OriginalError; cleanupError?: OriginalError; nodeVersion: string };

export type HostMessage =
  | { type: 'cdp.message'; message: string }
  | { type: 'cdp.closed' }
  | { type: 'finish' }
  | { type: 'reply'; id: number; value?: unknown; error?: string; originalError?: OriginalError }
  | { type: 'cancel'; reason: string };

export interface WorkerInput { entryPath: string; exportName: string; input: unknown; targetId: string; execution?: { binding: ExecutionBinding; attemptId: string }; snapshot?: ExecutionSnapshot }

export function createReporter(
  call: (method: ReporterMethod, args: unknown[]) => Promise<unknown>, signal: AbortSignal, execution?: WorkerInput['execution'],
): IncrementalWorkflowReporter {
  return {
    checkpoint: (key, details) => call('checkpoint', [key, details]) as Promise<{ id: string }>,
    emitData: async (name, records, provenance) => { await call('emitData', [name, records, provenance]); },
    attachArtifact: (name, content, mediaType) => call('attachArtifact', [name, content, mediaType]) as Promise<{ id: string }>,
    assertion: async assertion => { await call('assertion', [assertion]); },
    requestHuman: async request => { await call('requestHuman', [request]); },
    progress: async message => { await call('progress', [message]); },
    beginDataset: async identity => { await call('beginDataset', [identity]); },
    appendBatch: batch => call('appendBatch', [batch]) as Promise<BatchReceipt>,
    finishDataset: async completion => { await call('finishDataset', [completion]); },
    stepEvent: async event => { await call('stepEvent', [event]); },
    interruptStep: async (identity, reason) => { await call('interruptStep', [identity, reason]); throw restoreError(reason); },
    ...(execution ? { execution } : {}),
    signal,
  };
}
