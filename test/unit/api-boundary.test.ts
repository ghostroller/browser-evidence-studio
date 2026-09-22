import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { test } from 'node:test';
import { makeDispatch } from '@/main/services/dispatch';
import type { Studio } from '@/main/services/studio';
import { SocketTransport } from '@/main/browser/connection';

function mockStudio() {
  const pageA = { pageId: 'page-a', navigationGeneration: 3, view: {} };
  const pageB = { pageId: 'page-b', navigationGeneration: 4, view: {} };
  const run = { id: 'run-1', leaseEpoch: 7, controller: 'agent', execution: 'ready', selectedPageId: 'page-a', pages: new Map([['page-a', pageA], ['page-b', pageB]]) };
  const calls: { method: string; body: any }[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const fake = {
    active: run,
    required: () => run,
    serialized<T>(fn: () => Promise<T>): Promise<T> { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
    block(promise: Promise<unknown>) { queue = promise; },
    state: () => ({ active: run }),
    window: { show: () => undefined },
    snapshot: async (body: unknown) => { calls.push({ method: 'snapshot', body }); return body; },
    checkpoint: async (body: unknown) => { calls.push({ method: 'checkpoint', body }); return body; },
    action: async (body: unknown) => { calls.push({ method: 'action', body }); return body; },
    validation: async (id: string) => { calls.push({ method: 'validation', body: id }); return { id }; },
    review: async (body: unknown) => { calls.push({ method: 'review', body }); return body; },
    reviews: async (id: string, body: unknown) => { calls.push({ method: 'reviews', body: { id, options: body } }); return { id }; },
    reader: () => ({ summary: async (body: unknown) => { calls.push({ method: 'summary', body }); return body; } }),
  };
  return { fake, run, calls, dispatch: makeDispatch(fake as unknown as Studio) };
}

test('HTTP checkpoint/snapshot reject wrong run, unknown page and stale generation before touching the browser', async () => {
  const { dispatch, calls } = mockStudio();
  for (const method of ['snapshot', 'checkpoint']) {
    for (const body of [
      { runId: 'other-run', pageId: 'page-a', generation: 3, leaseEpoch: 7 },
      { runId: 'run-1', leaseEpoch: 7 },
      { runId: 'run-1', pageId: 'unknown', generation: 3, leaseEpoch: 7 },
      { runId: 'run-1', pageId: 'page-a', generation: 2, leaseEpoch: 7 },
    ]) await assert.rejects(dispatch(method, body, 'api'), (error: any) => error.status === 409);
  }
  assert.equal(calls.length, 0);
  const request = { runId: 'run-1', pageId: 'page-b', generation: 4, leaseEpoch: 7 };
  await dispatch('snapshot', request, 'api'); await dispatch('checkpoint', request, 'api');
  assert.deepEqual(calls.map((call) => call.body.pageId), ['page-b', 'page-b']);
});

test('a queued request is reauthorized after a human takes over, and selecting a page invalidates old commands', async () => {
  const { fake, dispatch, run, calls } = mockStudio();
  let release!: () => void;
  fake.block(new Promise<void>((resolve) => { release = resolve; }));
  const pending = dispatch('checkpoint', { runId: 'run-1', pageId: 'page-a', generation: 3, leaseEpoch: 7 }, 'api');
  const rejected = assert.rejects(pending, (error: any) => error.status === 409);
  run.controller = 'human'; run.leaseEpoch = 8; release(); await rejected;
  assert.equal(calls.length, 0);
  run.controller = 'agent';
  await dispatch('selectPage', { runId: 'run-1', pageId: 'page-b', leaseEpoch: 8 }, 'api');
  assert.equal(run.selectedPageId, 'page-b'); assert.equal(run.leaseEpoch, 9);
  await assert.rejects(dispatch('action', { runId: 'run-1', pageId: 'page-a', leaseEpoch: 8 }, 'api'), (error: any) => error.status === 409);
  assert.equal(calls.length, 0);
});

test('path validation identity wins over a conflicting body/query alias and summary keeps its requested budget', async () => {
  const { dispatch, calls } = mockStudio();
  await dispatch('validation', { validationId: 'path-id', id: 'wrong-id' }, 'api');
  await dispatch('review', { validationId: 'path-id', id: 'wrong-id', verdict: 'accept', reason: 'scope' }, 'api');
  await dispatch('summary', { runId: 'run-1', maxBytes: 1200 }, 'api');
  await dispatch('reviews', { validationId: 'path-id', id: 'wrong-id', maxBytes: 1200, cursor: 'bounded-next' }, 'api');
  assert.equal(calls[0].body, 'path-id'); assert.equal(calls[1].body.id, 'path-id'); assert.equal(calls[2].body.maxBytes, 1200);
  assert.equal(calls[3].body.id, 'path-id'); assert.equal(calls[3].body.options.maxBytes, 1200); assert.equal(calls[3].body.options.cursor, 'bounded-next');
});

test('a pending WebSocket handshake can be revoked without ever exposing an operation transport', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const abort = new AbortController();
  try {
    const accepted = once(server, 'connection');
    const connection = SocketTransport.connect(`ws://127.0.0.1:${address.port}`, abort.signal);
    const rejected = assert.rejects(connection, /takeover/);
    await accepted; abort.abort(new Error('takeover'));
    await rejected;
    const alreadyStopped = new AbortController(); alreadyStopped.abort(new Error('already stopped'));
    await assert.rejects(SocketTransport.connect(`ws://127.0.0.1:${address.port}`, alreadyStopped.signal), /already stopped/);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
