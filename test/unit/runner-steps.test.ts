import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { createStepRunner, type StepEvent } from '@/runner/steps';

function runner(signal = new AbortController().signal) {
  const events: StepEvent[] = [];
  return { events, steps: createStepRunner({ executionId: 'execution', signal, save: async event => { events.push(event); } }) };
}

test('independent profile failure preserves orders; missing list blocks details; one entity failure does not stop siblings', async () => {
  const { steps, events } = runner();
  const profile = await steps.run({ stepId: 'profile', run: async () => { throw new TypeError('profile unavailable', { cause: new Error('raw selector failure') }); } });
  const orders = await steps.run({ stepId: 'orders', run: async () => ['id-1', 'id-2', 'id-3'] });
  assert.equal(profile.status, 'failed'); assert.equal(orders.status, 'succeeded');
  let blockedRan = false;
  const blocked = await steps.run({ stepId: 'needs-profile', dependencies: [profile], run: async () => { blockedRan = true; } });
  assert.equal(blocked.status, 'blocked'); assert.equal(blockedRan, false);
  if (blocked.status === 'blocked') assert.deepEqual(blocked.dependencies, [profile.identity]);
  if (orders.status !== 'succeeded') throw new Error('Missing list');
  const details = [];
  for (const id of orders.value) details.push(await steps.run({ stepId: 'details', entityKey: id, dependencies: [orders], run: async () => { if (id === 'id-2') throw new Error('detail unavailable'); return { id }; } }));
  assert.deepEqual(details.map(item => item.status), ['succeeded', 'failed', 'succeeded']);
  if (profile.status === 'failed') assert.match(profile.error.cause?.message ?? '', /raw selector/);
  assert.ok(events.every(event => event.identity.attemptId));
});

test('data commits before auxiliary screenshot failure, and cleanup never replaces the original business failure', async () => {
  const { steps } = runner(); const saved: string[] = [];
  const result = await steps.run({ stepId: 'orders', run: async () => ['retained'], commit: async value => { saved.push(...value); }, evidence: async () => { throw new Error('screenshot failed'); } });
  assert.equal(result.status, 'partial'); assert.deepEqual(saved, ['retained']);
  if (result.status === 'partial') assert.deepEqual(result.value, ['retained']);
  const failure = await steps.run({ stepId: 'broken', run: async () => { throw new Error('original failure'); }, cleanup: async () => { throw new Error('transport cleanup'); } });
  if (failure.status !== 'failed') throw new Error('Expected failure');
  assert.equal(failure.error.message, 'original failure');
});

test('bounded retries create distinct attempts and never retry persistence failure', async () => {
  const { steps, events } = runner(); let attempts = 0;
  const result = await steps.run({ stepId: 'read', retry: { maxAttempts: 2, policy: 'read-only', backoffMs: 1, totalBudgetMs: 1000 }, run: async () => { if (++attempts === 1) throw new Error('transient'); return 'ok'; } });
  assert.equal(result.status, 'succeeded');
  assert.equal(new Set(events.map(event => event.identity.attemptId)).size, 2);
  let writes = 0;
  await assert.rejects(steps.run({ stepId: 'save', retry: { maxAttempts: 2, policy: 'idempotent', backoffMs: 0, totalBudgetMs: 1000 }, run: async () => ++writes, commit: async () => { throw new Error('disk full'); } }), /could not be saved/);
  assert.equal(writes, 1);
  await assert.rejects(steps.run({ stepId: 'after-disk-failure', run: async () => { throw new Error('must not start'); } }), /could not be saved/);
});

test('same page tasks serialize and cancellation prevents queued work from starting', async () => {
  const abort = new AbortController(); const { steps } = runner(abort.signal); const actions: string[] = [];
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const first = steps.run({ stepId: 'first', run: async ({ signal }) => { actions.push('first'); entered(); await delay(10_000, undefined, { signal }); } });
  const second = steps.run({ stepId: 'second', run: async () => { actions.push('second'); } });
  await started; abort.abort(new Error('user stopped'));
  assert.equal((await first).status, 'cancelled'); assert.equal((await second).status, 'cancelled');
  assert.deepEqual(actions, ['first']);
});

test('timeout awaits actual owned worker termination before returning and no delayed command arrives', async () => {
  const events: StepEvent[] = []; let clicks = 0; let terminated = false;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready'); setTimeout(() => parentPort.postMessage('click'), 150);`, { eval: true });
  worker.on('message', value => { if (value === 'click') clicks++; });
  await new Promise<void>(resolve => worker.once('message', () => resolve()));
  const steps = createStepRunner({ executionId: 'cancel', signal: new AbortController().signal, save: async event => { events.push(event); }, interrupt: async () => { await worker.terminate(); terminated = true; } });
  const result = await steps.run({ stepId: 'unsafe-pending', timeoutMs: 20, run: () => new Promise<never>(() => {}) });
  assert.equal(result.status, 'failed'); assert.equal(terminated, true);
  await delay(180); assert.equal(clicks, 0);
  assert.equal(events.at(-1)?.state, 'failed');
});

test('human wait remains explicit until the real completion check resolves', async () => {
  const { steps, events } = runner();
  const result = await steps.run({ stepId: 'login', run: async context => { await context.awaitHuman('handoff-1', async () => { throw new Error('Human timeout; login unknown'); }); return true; } });
  assert.equal(result.status, 'failed');
  assert.equal(events[1].state, 'awaiting-human');
  assert.equal(events.at(-1)?.state, 'failed');
});

test('work rejecting first and evidence cancellation both await delayed quiescence before cleanup or queue release', async () => {
  for (const phase of ['run', 'evidence'] as const) {
    const abort = new AbortController(); const sequence: string[] = [];
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const steps = createStepRunner({ executionId: 'cancel-race', signal: abort.signal, save: async () => {}, interrupt: async () => { sequence.push('interrupt'); await delay(40); sequence.push('quiet'); } });
    const wait = async (signal: AbortSignal) => { entered(); await delay(10000, undefined, { signal }); };
    const result = steps.run({ stepId: 'first', run: async ({ signal }) => { if (phase === 'run') await wait(signal); return 'data'; }, evidence: async (_value, { signal }) => { if (phase === 'evidence') await wait(signal); }, cleanup: async () => { sequence.push('cleanup'); } });
    const queued = steps.run({ stepId: 'second', run: async () => { sequence.push('next-action'); } });
    await started; abort.abort(new Error('stop'));
    assert.equal((await result).status, 'cancelled');
    assert.deepEqual(sequence, ['interrupt', 'quiet', 'cleanup']);
    assert.equal((await queued).status, 'cancelled');
  }
});

test('uncooperative evidence is interrupted at a real worker stop boundary; cleanup failure poisons only its resource', async () => {
  const events: StepEvent[] = []; let late = 0; let saved = false;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready'); setTimeout(() => parentPort.postMessage('late'), 200);`, { eval: true });
  worker.on('message', value => { if (value === 'late') late++; });
  await new Promise<void>(resolve => worker.once('message', () => resolve()));
  try {
    const steps = createStepRunner({ executionId: 'evidence-timeout', signal: new AbortController().signal, save: async event => { events.push(event); }, interrupt: async () => { await worker.terminate(); } });
    const result = await steps.run({ stepId: 'save-first', timeoutMs: 25, run: async () => 'business-data', commit: async () => { saved = true; }, evidence: () => new Promise<never>(() => {}), cleanup: async () => { throw new Error('cleanup uncertain'); } });
    assert.equal(result.status, 'failed'); assert.equal(saved, true);
    await assert.rejects(steps.run({ stepId: 'must-not-reuse', run: async () => { throw new Error('unsafe action'); } }), /cleanup failed/);
    assert.equal((await steps.run({ stepId: 'other-owned-page', resourceKey: 'other-page', run: async () => 'ok' })).status, 'succeeded');
    await delay(220); assert.equal(late, 0);
  } finally { await worker.terminate(); }
});
