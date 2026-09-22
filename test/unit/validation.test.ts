import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseWorkflowManifest, type WorkflowManifest } from '../../src/contracts/workflow';
import { fingerprintWorkflow, loadWorkflow, resolveRegisteredFile } from '../../src/runner/fingerprint';
import { validateExecution, type ValidationInput } from '../../src/runner/validation';
import { GateTransport, type ProtocolTransport } from '../../src/runner/gate';
import { startWorkflow, type RunnerHooks } from '../../src/runner/manager';

const manifest: WorkflowManifest = {
  schemaVersion: 1, workflowId: 'test', entry: './run.mjs', exportName: 'run', driver: 'puppeteer',
  requirements: [{ id: 'orders', checkpointKey: 'orders', description: 'Complete identifiable orders', dataset: 'orders', rules: [
    { type: 'min-rows', count: 2 }, { type: 'required', field: 'tracking', allowNull: true },
    { type: 'unique', field: 'id' }, { type: 'field-type', field: 'id', valueType: 'string' },
    { type: 'same-entity', field: 'imageId', equalsField: 'id' }, { type: 'pagination-complete', minPages: 2 },
  ] }],
};
function execution(): ValidationInput {
  return {
    manifest: structuredClone(manifest), execution: 'completed', checkpoints: [{ id: 'cp-1', key: 'orders' }],
    datasets: [{ name: 'orders', origin: 'browser', sourceRefs: ['body-1'], records: [{ id: 'a', imageId: 'a', tracking: null }, { id: 'b', imageId: 'b', tracking: 't' }], pagination: { complete: true, pages: 2, terminalReason: 'API hasNext=false' } }], assertions: [],
    fingerprintBefore: { sha256: 'same', dependencyLockSha256: 'lock', files: [] },
    fingerprintAfter: { sha256: 'same', dependencyLockSha256: 'lock', files: [] }, knownSourceRefs: ['body-1'],
  };
}

test('full coverage, preserved null, identity and observed pagination can pass', () => {
  assert.equal(validateExecution(execution()).overall, 'pass');
});

test('wrong image entity, duplicate key, missing field and first-page-only result fail acceptance', () => {
  const cases: ((input: ValidationInput) => void)[] = [
    input => { (input.datasets[0].records[1] as Record<string, unknown>).imageId = 'a'; },
    input => { (input.datasets[0].records[1] as Record<string, unknown>).id = 'a'; },
    input => { delete (input.datasets[0].records[0] as Record<string, unknown>).tracking; },
    input => { input.datasets[0].records.length = 1; input.datasets[0].pagination = { complete: false, pages: 1, terminalReason: 'Stopped early' }; },
  ];
  for (const mutate of cases) { const input = execution(); mutate(input); assert.equal(validateExecution(input).overall, 'fail'); }
});

test('uncovered requirements and missing provenance cannot pass even when the script completes', () => {
  const missing = execution(); missing.checkpoints = [];
  assert.equal(validateExecution(missing).coverageVerdict, 'not-run');
  assert.notEqual(validateExecution(missing).overall, 'pass');
  const unknown = execution(); unknown.datasets[0].origin = 'node'; unknown.datasets[0].sourceRefs = ['invented-ref'];
  assert.equal(validateExecution(unknown).overall, 'inconclusive');
});

test('changed executed version or failed worker cannot inherit a historical pass', () => {
  const changed = execution(); changed.fingerprintAfter.sha256 = 'changed';
  assert.equal(validateExecution(changed).versionVerdict, 'fail');
  assert.equal(validateExecution(changed).overall, 'fail');
  const failed = execution(); failed.execution = 'interrupted';
  assert.equal(validateExecution(failed).executionVerdict, 'fail');
  assert.equal(validateExecution(failed).overall, 'fail');
  const unlocked = execution(); unlocked.fingerprintBefore.dependencyLockSha256 = null;
  assert.equal(validateExecution(unlocked).overall, 'inconclusive');
});

test('manifest rejects unknown data rules and duplicate requirement identity', () => {
  const invalid = structuredClone(manifest) as unknown as { requirements: Record<string, unknown>[] };
  invalid.requirements[0].rules = [{ type: 'execute', command: 'click' }];
  assert.throws(() => parseWorkflowManifest(invalid), /Unknown data rule/);
  const duplicates = structuredClone(manifest); duplicates.requirements.push(duplicates.requirements[0]);
  assert.throws(() => parseWorkflowManifest(duplicates), /Duplicate requirement/);
});

test('fingerprint includes source, build, config and lock; entries cannot escape registered root', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'bes-workflow-'));
  try {
    const directory = path.join(temp, 'registered'); await mkdir(directory); await mkdir(path.join(directory, 'dist'));
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'run.mjs'), 'export const run = async () => {};');
    await writeFile(path.join(directory, 'dist', 'run.js'), 'export const built = true;');
    await writeFile(path.join(directory, 'config.json'), '{"variant":"a"}');
    await writeFile(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(path.join(temp, 'outside.mjs'), 'export const run = async () => {};');
    const first = await fingerprintWorkflow(directory);
    assert.equal(first.files.length, 5);
    assert.ok(first.dependencyLockSha256);
    assert.equal((await loadWorkflow(directory)).entryPath, await realpath(path.join(directory, 'run.mjs')));
    await writeFile(path.join(directory, 'config.json'), '{"variant":"b"}');
    assert.notEqual((await fingerprintWorkflow(directory)).sha256, first.sha256);
    await assert.rejects(resolveRegisteredFile(directory, '../outside.mjs'), /outside/);
  } finally {
    assert.equal(await realpath(path.dirname(temp)), await realpath(tmpdir()));
    assert.ok(path.basename(temp).startsWith('bes-workflow-'));
    await rm(temp, { recursive: true, force: true });
  }
});

const hooks: RunnerHooks = {
  checkpoint: async key => ({ id: `cp-${key}` }),
  emitData: async () => {}, attachArtifact: async name => ({ id: `artifact-${name}` }),
  assertion: async () => {}, requestHuman: async () => {}, progress: async () => {},
};

async function withWorker(script: string, run: (directory: string, workerPath: string, transport: GateTransport) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bes-runner-'));
  try {
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({ ...manifest, humanPoints: [{ id: 'confirm', description: 'Explicit synthetic confirmation' }] }));
    await writeFile(path.join(directory, 'run.mjs'), 'export const run = async () => {};');
    await writeFile(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    const workerPath = path.join(directory, 'test-worker.cjs');
    await writeFile(workerPath, script);
    const raw: ProtocolTransport = { send: () => {}, close: () => raw.onclose?.() };
    await run(directory, workerPath, new GateTransport(raw));
  } finally {
    assert.equal(await realpath(path.dirname(directory)), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith('bes-runner-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('a real worker exiting without completion cannot produce a validation pass', async () => {
  await withWorker('process.exit(0);', async (directory, workerPath, transport) => {
    const handle = await startWorkflow({ directory, workerPath, transport, targetId: 'explicit-target', input: {}, hooks });
    const result = await handle.done;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.validation.overall, 'fail');
    assert.match(result.error ?? '', /without completion/);
    assert.equal(transport.snapshot().state, 'closed');
  });
});

test('cancellation stops a busy worker before resolving, retaining a failed acceptance result', async () => {
  await withWorker('setInterval(() => {}, 100);', async (directory, workerPath, transport) => {
    const handle = await startWorkflow({ directory, workerPath, transport, targetId: 'explicit-target', input: {}, hooks });
    await handle.cancel('Synthetic forced takeover');
    const result = await handle.done;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.validation.overall, 'fail');
    assert.equal(transport.snapshot().state, 'closed');
  });
});

test('cancelling during checkpoint capture aborts the hook and drains pending reports without reopening the gate', { timeout: 6000 }, async t => {
  await withWorker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type:'reporter', id:1, method:'checkpoint', args:['orders', { title:'Pending synthetic checkpoint' }] });
    setInterval(() => {}, 100);
  `, async (directory, workerPath, transport) => {
    const resume = t.mock.method(transport, 'resume');
    let entered!: () => void;
    const hookEntered = new Promise<void>(resolve => { entered = resolve; });
    let releaseForCleanup: (() => void) | undefined;
    let checkpointSignal: AbortSignal | undefined;
    let abortObserved = false;
    let hookSettled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const handle = await startWorkflow({ directory, workerPath, transport, targetId: 'explicit-target', input: {}, maxDurationMs: 4000, hooks: {
      ...hooks, checkpoint: async (_key, _details, signal) => {
        assert.ok(signal, 'Checkpoint capture must receive the runner cancellation signal');
        checkpointSignal = signal;
        assert.equal(signal.aborted, false);
        assert.equal(transport.snapshot().state, 'quiesced');
        let onAbort!: () => void;
        try {
          await new Promise<void>((_resolve, reject) => {
            onAbort = () => { abortObserved = true; reject(signal.reason); };
            releaseForCleanup = () => reject(new Error('Release a stuck checkpoint after test failure'));
            signal.addEventListener('abort', onAbort, { once: true });
            entered();
          });
          return { id: 'must-not-accept-an-aborted-checkpoint' };
        } finally {
          signal.removeEventListener('abort', onAbort);
          hookSettled = true;
        }
      },
    } });
    try {
      await Promise.race([
        hookEntered,
        handle.done.then(result => { throw new Error(`Worker ended before reaching checkpoint capture: ${result.error}`); }),
      ]);
      await Promise.race([
        handle.cancel('User cancelled during checkpoint capture'),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Cancellation remained blocked on outstanding checkpoint reports')), 2000); }),
      ]);
      const result = await handle.done;
      assert.equal(abortObserved, true);
      assert.equal(hookSettled, true, 'Cancel must wait for the outstanding reporter operation to settle');
      assert.equal(checkpointSignal?.aborted, true);
      assert.match(String(checkpointSignal?.reason), /User cancelled during checkpoint capture/);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.validation.executionVerdict, 'fail');
      assert.equal(result.validation.overall, 'fail');
      assert.deepEqual(result.checkpoints, [], 'An aborted checkpoint cannot count as covered');
      assert.equal(resume.mock.callCount(), 0, 'Cancellation must never briefly reopen browser operations');
      assert.equal(transport.snapshot().state, 'closed');
    } finally {
      if (deadline) clearTimeout(deadline);
      releaseForCleanup?.();
      await handle.cancel('Test cleanup');
    }
  });
});

test('human assistance timeout is a failure and never resumes the operation connection', async () => {
  await withWorker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type:'reporter', id:1, method:'requestHuman', args:[{ id:'confirm', instructions:'Confirm synthetic page', timeoutMs:15, completionCheck:{selector:'#confirmed'} }] });
    setInterval(() => {}, 100);
  `, async (directory, workerPath, transport) => {
    let humanOpened = false;
    const handle = await startWorkflow({ directory, workerPath, transport, targetId: 'explicit-target', input: {}, hooks: {
      ...hooks, requestHuman: async () => {
        assert.equal(transport.snapshot().state, 'quiesced'); humanOpened = true;
        await new Promise<void>(() => {});
      },
    } });
    const result = await handle.done;
    assert.equal(humanOpened, true);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /timed out/);
    assert.equal(result.humanAttempts[0].status, 'failed');
    assert.equal(transport.snapshot().state, 'closed');
  });
});

test('a timer command during a human window terminates the worker and records failed acceptance', async () => {
  await withWorker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type:'reporter', id:1, method:'requestHuman', args:[{ id:'confirm', instructions:'Confirm synthetic page', timeoutMs:1000, completionCheck:{selector:'#confirmed'} }] });
    setTimeout(() => parentPort.postMessage({type:'cdp.send', message:JSON.stringify({id:2,method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:1,y:1}})}), 25);
    setInterval(() => {}, 100);
  `, async (directory, workerPath, transport) => {
    const handle = await startWorkflow({ directory, workerPath, transport, targetId: 'explicit-target', input: {}, hooks: {
      ...hooks, requestHuman: async () => { await new Promise<void>(() => {}); },
    } });
    const result = await handle.done;
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /control was revoked/);
    assert.equal(transport.snapshot().rejectedCommands, 1);
    assert.equal(transport.snapshot().state, 'closed');
    assert.equal(result.validation.overall, 'fail');
  });
});
