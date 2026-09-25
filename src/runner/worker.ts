import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createReporter, type HostMessage, type ReporterMethod, type WorkerInput, type WorkerMessage } from './context';
import { connectManagedPage } from './puppeteer';
import type { ProtocolTransport } from './gate';
import { originalError, restoreError } from './errors';
import { createStepRunner } from './steps';
import { installSnapshotLoader } from './snapshot-loader';
import type { OriginalError } from '../contracts/execution';

const port = parentPort;
if (!port) throw new Error('Managed workflow requires a parent message port');
const send = (message: WorkerMessage) => port.postMessage(message);
const cancellation = new AbortController();
let cleanupError: OriginalError | undefined;
let acknowledgeFinish!: () => void;
const finishAcknowledged = new Promise<void>(resolve => { acknowledgeFinish = resolve; });
let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const transport: ProtocolTransport = {
  send: message => send({ type: 'cdp.send', message }),
  close: () => send({ type: 'cdp.close' }),
};
port.on('message', (message: HostMessage) => {
  if (message.type === 'cdp.message') transport.onmessage?.(message.message);
  else if (message.type === 'cdp.closed') transport.onclose?.();
  else if (message.type === 'finish') acknowledgeFinish();
  else if (message.type === 'cancel') {
    cancellation.abort(new Error(message.reason));
    for (const item of pending.values()) item.reject(new Error(message.reason));
    pending.clear();
  } else {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.originalError) item.reject(restoreError(message.originalError));
    else if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.value);
  }
});

async function main(): Promise<void> {
  send({type:'started',nodeVersion:process.versions.node});
  const options = workerData as WorkerInput;
  const reporter = createReporter((method: ReporterMethod, args: unknown[]) => {
    cancellation.signal.throwIfAborted();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'reporter', id, method, args });
    });
  }, cancellation.signal, options.execution);
  const { browser, page } = await connectManagedPage(transport, options.targetId);
  const steps = options.execution ? createStepRunner({ executionId: options.execution.binding.executionId, signal: cancellation.signal,
    save: event => reporter.stepEvent(event), interrupt: (identity, reason) => reporter.interruptStep(identity, originalError(reason)) }) : undefined;
  const snapshotLoader = options.snapshot ? installSnapshotLoader(options.snapshot) : undefined;
  let primaryError: unknown;
  try {
    // Native import retains registered entries outside the client's bundle.
    const module = await import(/* @vite-ignore */ pathToFileURL(options.entryPath).href);
    const entry = module[options.exportName];
    if (typeof entry !== 'function') throw new Error(`Workflow export ${options.exportName} is not a function`);
    const output = await entry({ page, input: options.input, reporter, steps });
    cancellation.signal.throwIfAborted();
    if (steps?.pending()) throw new Error('Workflow returned with unawaited steps');
    if (pending.size) throw new Error('Workflow returned with unawaited reporter calls');
    send({ type: 'complete', output, nodeVersion: process.versions.node });
    // The host closes the command gate and drains in-flight operations before
    // acknowledging completion. No detached timer may keep driving the page.
    await finishAcknowledged;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    snapshotLoader?.deregister();
    // Browser ownership remains with Electron. Never browser.close().
    try { await browser.disconnect(); }
    catch (error) { if (primaryError === undefined) throw error; cleanupError = originalError(error); }
  }
}

void main().catch(error => {
  send({ type: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 4096), name: error instanceof Error ? error.name.slice(0,128) : undefined, stack: error instanceof Error ? error.stack?.slice(0,8192) : undefined, originalError: originalError(error), cleanupError, nodeVersion: process.versions.node });
}).finally(() => port.close());
