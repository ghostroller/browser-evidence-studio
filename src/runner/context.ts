import type { WorkflowReporter } from '@/contracts/workflow';

export type ReporterMethod = Exclude<keyof WorkflowReporter, 'signal'>;
export type WorkerMessage =
  | { type: 'started'; nodeVersion: string }
  | { type: 'cdp.send'; message: string }
  | { type: 'cdp.close' }
  | { type: 'reporter'; id: number; method: ReporterMethod; args: unknown[] }
  | { type: 'complete'; output: unknown; nodeVersion: string }
  | { type: 'failed'; error: string; name?: string; stack?: string; nodeVersion: string };

export type HostMessage =
  | { type: 'cdp.message'; message: string }
  | { type: 'cdp.closed' }
  | { type: 'finish' }
  | { type: 'reply'; id: number; value?: unknown; error?: string }
  | { type: 'cancel'; reason: string };

export interface WorkerInput { entryPath: string; exportName: string; input: unknown; targetId: string }

export function createReporter(
  call: (method: ReporterMethod, args: unknown[]) => Promise<unknown>, signal: AbortSignal,
): WorkflowReporter {
  return {
    checkpoint: (key, details) => call('checkpoint', [key, details]) as Promise<{ id: string }>,
    emitData: async (name, records, provenance) => { await call('emitData', [name, records, provenance]); },
    attachArtifact: (name, content, mediaType) => call('attachArtifact', [name, content, mediaType]) as Promise<{ id: string }>,
    assertion: async assertion => { await call('assertion', [assertion]); },
    requestHuman: async request => { await call('requestHuman', [request]); },
    progress: async message => { await call('progress', [message]); },
    signal,
  };
}
