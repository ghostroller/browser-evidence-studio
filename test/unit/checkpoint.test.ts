import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { captureCheckpointMaterials } from '@/capture/checkpoint';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('checkpoint preserves capture order and distinguishes an empty DOM from failed capture', async () => {
  const screenshot = deferred<Uint8Array>();
  const dom = deferred<string>();
  const pending = captureCheckpointMaterials({ screenshot: () => screenshot.promise, dom: () => dom.promise, timeoutMs: 1000 });
  dom.resolve('');
  await nextTurn();
  screenshot.resolve(new Uint8Array([137, 80, 78, 71]));
  const result = await pending;
  assert.equal(result.outcome, 'completed');
  assert.ok(Number.isFinite(Date.parse(result.captureEndedAt)));
  assert.deepEqual(result.materials, [
    { kind: 'screenshot', mediaType: 'image/png', metadata: { capturePrivacy: { policy: 'bes-capture-privacy-v1', access: 'restricted', reason: 'unredacted-pixels' } }, data: new Uint8Array([137, 80, 78, 71]), captureStatus: 'complete' },
    { kind: 'dom', mediaType: 'text/html', data: '', captureStatus: 'empty' },
  ]);
});

test('one capture throwing synchronously still preserves the other successful material', async () => {
  let domCalled = false;
  const result = await captureCheckpointMaterials({
    screenshot: () => { throw new Error('Synthetic native capture failure'); },
    dom: async () => { domCalled = true; return '<html>retained</html>'; }, timeoutMs: 1000,
  });
  assert.equal(domCalled, true);
  assert.equal(result.outcome, 'completed', 'Both channels settled, even though one failed');
  assert.equal(result.materials[0].captureStatus, 'read-failed');
  assert.equal(result.materials[0].reason, 'Synthetic native capture failure');
  assert.equal(result.materials[1].data, '<html>retained</html>');
});

test('a hanging channel reaches the deadline, retaining only the material available beforehand', { timeout: 2000 }, async () => {
  const dom = deferred<string>();
  const result = await captureCheckpointMaterials({
    screenshot: async () => new Uint8Array([1, 2, 3]), dom: () => dom.promise, timeoutMs: 30,
  });
  assert.equal(result.outcome, 'timed-out');
  assert.deepEqual(result.materials[0].data, new Uint8Array([1, 2, 3]));
  assert.equal(result.materials[1].captureStatus, 'read-failed');
  assert.match(result.materials[1].reason ?? '', /timed out/);
  assert.equal(result.materials[1].data, undefined);

  const original = structuredClone(result);
  const nextDom = deferred<string>();
  const next = captureCheckpointMaterials({ screenshot: async () => new Uint8Array([4]), dom: () => nextDom.promise, timeoutMs: 1000 });
  dom.resolve('<html>late, previous capture</html>');
  await nextTurn();
  nextDom.resolve('<html>current capture</html>');
  const nextResult = await next;
  assert.deepEqual(result, original, 'Late success must not amend the finished checkpoint');
  assert.equal(nextResult.outcome, 'completed');
  assert.equal(nextResult.materials[1].data, '<html>current capture</html>');
});

test('cancellation preserves a completed channel and consumes a late rejection', async () => {
  const abort = new AbortController();
  const dom = deferred<string>();
  const pending = captureCheckpointMaterials({
    screenshot: async () => new Uint8Array([7]), dom: () => dom.promise, signal: abort.signal, timeoutMs: 1000,
  });
  await nextTurn();
  abort.abort(new Error('User cancelled this checkpoint'));
  const result = await pending;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.materials[0].captureStatus, 'complete');
  assert.equal(result.materials[1].captureStatus, 'read-failed');
  assert.match(result.materials[1].reason ?? '', /User cancelled this checkpoint/);
  const original = structuredClone(result);
  dom.reject(new Error('Late browser rejection after cancellation'));
  await nextTurn();
  assert.deepEqual(result, original);
  // The test runner fails the test if the late rejection is left unhandled.
});

test('a cancelled or exhausted request never starts either capture provider', async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  const providers = {
    screenshot: async () => { calls++; return new Uint8Array([1]); },
    dom: async () => { calls++; return 'unexpected'; },
  };
  const cancelled = await captureCheckpointMaterials({ ...providers, signal: abort.signal, timeoutMs: 1000 });
  const exhausted = await captureCheckpointMaterials({ ...providers, timeoutMs: 0 });
  assert.equal(calls, 0);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(exhausted.outcome, 'timed-out');
  for (const result of [cancelled, exhausted]) {
    assert.ok(result.materials.every(material => material.captureStatus === 'read-failed' && material.data === undefined));
  }
});

test('both hung captures end at the deadline without manufacturing any successful material', { timeout: 2000 }, async () => {
  const result = await captureCheckpointMaterials({
    screenshot: () => new Promise(() => {}), dom: () => new Promise(() => {}), timeoutMs: 10,
  });
  assert.equal(result.outcome, 'timed-out');
  assert.ok(result.materials.every(material => material.captureStatus === 'read-failed' && /timed out/.test(material.reason ?? '') && material.data === undefined));
});

test('a timeout retains an earlier channel error instead of replacing it with a timeout reason', { timeout: 2000 }, async () => {
  const result = await captureCheckpointMaterials({
    screenshot: async () => { throw new Error('Page destroyed before screenshot'); },
    dom: () => new Promise(() => {}), timeoutMs: 10,
  });
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.materials[0].reason, 'Page destroyed before screenshot');
  assert.match(result.materials[1].reason ?? '', /timed out/);
});
