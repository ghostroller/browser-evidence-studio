import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RequestLedger } from '@/capture/request-ledger';
import { readyMainObserverContexts } from '@/capture/observer-contexts';

test('redirect response/body identity advances before delayed redirect persistence', async () => {
  const ledger = new RequestLedger('capture-session', 'business-target');
  const first = ledger.begin({ requestId: '42', url: '/redirect', redirect: false }).current;
  const firstObservedAt='2026-09-26T01:00:00.000Z';
  ledger.response('42','text/plain',firstObservedAt);
  let finishWrite!: () => void;
  const delayedWrite = new Promise<void>(resolve => { finishWrite = resolve; });
  const redirect = ledger.begin({ requestId: '42', url: '/final', redirect: true });
  const write = delayedWrite.then(() => redirect.previous?.key);
  const response = ledger.response('42', 'application/json','2026-09-26T01:00:01.000Z');
  const completed = ledger.finish('42');
  assert.equal(response?.key, redirect.current.key);
  assert.equal(completed?.url, '/final');
  assert.equal(completed?.hop, 1);
  assert.equal(first.responseObservedAt,firstObservedAt,'Delayed persistence cannot rebind the old hop to final response headers');
  assert.equal(completed?.responseObservedAt,'2026-09-26T01:00:01.000Z');
  finishWrite();
  assert.equal(await write, first.key);
  assert.notEqual(first.key, completed?.key);
});

test('pause/reset cannot attach a stale body to a newly reused CDP request id', () => {
  const ledger = new RequestLedger('capture-session', 'business-target');
  const old = ledger.begin({ requestId: '42', url: '/before-pause', redirect: false }).current;
  assert.equal(ledger.reset()[0].key, old.key);
  assert.equal(ledger.finish('42'), undefined);
  const next = ledger.begin({ requestId: '42', url: '/after-resume', redirect: false }).current;
  assert.notEqual(old.key, next.key);
  assert.equal(next.hop, 0);
});

test('incomplete streams are classified at headers and remain available for stop gaps', () => {
  const ledger = new RequestLedger('capture-session', 'business-target');
  ledger.begin({ requestId: 'stream', url: '/events', redirect: false });
  const stream = ledger.response('stream', 'text/event-stream');
  assert.equal(stream?.streaming, true);
  const unfinished = ledger.reset();
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0].streaming, true);
  assert.equal(ledger.size, 0);
});

test('bounded in-flight tracking exposes the evicted identity instead of silently growing', () => {
  const ledger = new RequestLedger('capture-session', 'business-target', 2);
  const first = ledger.begin({ requestId: 'one', url: '/slow-one', redirect: false }).current;
  ledger.begin({ requestId: 'two', url: '/slow-two', redirect: false });
  const third = ledger.begin({ requestId: 'three', url: '/slow-three', redirect: false });
  assert.equal(third.evicted?.key, first.key);
  assert.equal(ledger.size, 2);
  assert.equal(ledger.finish('one'), undefined);
});

test('inspection and resumed snapshots never probe or mutate child iframe observer contexts', async () => {
  const probes: number[] = [];
  const contexts = new Map([[1, 'main-frame'], [2, 'child-frame'], [3, 'nested-frame']]);
  const result = await readyMainObserverContexts(contexts, 'main-frame', async contextId => {
    probes.push(contextId);
    if (contextId !== 1) throw new Error('Child intentionally has no rrweb');
    return { result: { value: true } };
  });
  assert.deepEqual(probes, [1]);
  assert.deepEqual(result.ready, [{ contextId: 1, frameId: 'main-frame' }]);
  assert.deepEqual(result.unavailable, []);
});

test('navigation while paused selects the new main context and requires completed recorder injection', async () => {
  const contexts = new Map([[1, 'old-main-frame'], [2, 'new-main-frame'], [3, 'child-frame']]);
  const incomplete = await readyMainObserverContexts(contexts, 'new-main-frame', async () => ({ result: { value: false } }));
  assert.equal(incomplete.ready.length, 0);
  assert.equal(incomplete.unavailable[0].contextId, 2);
  const ready = await readyMainObserverContexts(contexts, 'new-main-frame', async () => ({ result: { value: true } }));
  assert.deepEqual(ready.ready, [{ contextId: 2, frameId: 'new-main-frame' }]);
});

test('a destroyed main observer context remains an explicit unavailable result', async () => {
  const result = await readyMainObserverContexts(new Map([[1, 'main']]), 'main', async () => { throw new Error('Execution context was destroyed'); });
  assert.equal(result.ready.length, 0);
  assert.match(result.unavailable[0].reason, /destroyed/);
});
