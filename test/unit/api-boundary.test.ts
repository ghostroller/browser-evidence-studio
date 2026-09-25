import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { afterEach, test } from 'vitest';
import { makeDispatch } from '@/main/services/dispatch';
import type { Studio } from '@/main/services/studio';
import { SocketTransport } from '@/main/browser/connection';
import { TaskAuthorizations, type TaskCapability } from '@/main/services/task-authorization';
import { ensure } from '@/shared/errors';

const authorizations: TaskAuthorizations[] = [];
afterEach(() => { for (const tasks of authorizations.splice(0)) tasks.close(); });

async function mockStudio() {
  const pageA = { pageId: 'page-a', targetId: 'target-a', navigationGeneration: 3, view: {} };
  const pageB = { pageId: 'page-b', targetId: 'target-b', navigationGeneration: 4, view: {} };
  const run = { id: 'run-1', projectId: 'project-1', profileId: 'profile-1', leaseEpoch: 7, controller: 'agent', execution: 'ready', selectedPageId: 'page-a', pages: new Map([['page-a', pageA], ['page-b', pageB]]) };
  const tasks = new TaskAuthorizations(); authorizations.push(tasks);
  const scope = { projectId: run.projectId, profileId: run.profileId, sessionId: 'session-1' };
  const grant = await tasks.issue(scope, { origins: ['https://fixture.test'], pages: [pageA, pageB], capabilities: ['page-read', 'page-act', 'history-read', 'results-read'], durationMs: 60000, maxOperations: 100 });
  const calls: { method: string; body: any }[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const fake = {
    tasks, runs: [run],
    active: run,
    required: () => run,
    serialized<T>(fn: () => Promise<T>): Promise<T> { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
    block(promise: Promise<unknown>) { queue = promise; },
    state: () => ({ active: run, validations: [{ id: 'path-id', runId: run.id }] }),
    authorizedOperation: (body: any, capability: TaskCapability, operation: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) => {
      const page = run.pages.get(body.pageId ?? run.selectedPageId);
      ensure(page, 'Unknown page or stale navigation generation', 409);
      return tasks.run(body.authorizationId, capability, { ...scope, pageId: page.pageId, targetId: page.targetId, url: 'https://fixture.test/' }, operation, signal);
    },
    window: { show: () => undefined },
    // Page lifecycle moved into Studio; this dispatcher fixture supplies its
    // contract while actual lease/target changes are exercised in Electron.
    selectPage: async (pageId: string) => { run.selectedPageId = pageId; run.leaseEpoch++; return { active: run }; },
    snapshot: async (body: unknown) => { calls.push({ method: 'snapshot', body }); return body; },
    checkpoint: async (body: unknown) => { calls.push({ method: 'checkpoint', body }); return body; },
    action: async (body: unknown) => { calls.push({ method: 'action', body }); return body; },
    validation: async (id: string) => { calls.push({ method: 'validation', body: id }); return { id }; },
    releaseHuman: async (id: string) => { calls.push({ method: 'releaseHuman', body: id }); return { passed: true, handoffId: id }; },
    review: async (body: unknown) => { calls.push({ method: 'review', body }); return body; },
    reviews: async (id: string, body: unknown) => { calls.push({ method: 'reviews', body: { id, options: body } }); return { id }; },
    reader: () => ({ summary: async (body: unknown) => { calls.push({ method: 'summary', body }); return body; } }),
  };
  const dispatch = makeDispatch(fake as unknown as Studio);
  // These lease/identity tests run as a real authorized task; omission/revocation
  // is tested separately in refactor-agent-api, without this request builder.
  const authorizedDispatch: typeof dispatch = (method, body, source, context) => dispatch(method, { ...scope, authorizationId: grant.authorizationId, ...body }, source, context);
  return { fake, run, calls, dispatch: authorizedDispatch };
}

test('HTTP checkpoint/snapshot reject wrong run, unknown page and stale generation before touching the browser', async () => {
  const { dispatch, calls } = await mockStudio();
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
  const { fake, dispatch, run, calls } = await mockStudio();
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

test('HTTP action requires the selected page generation and rejects a queued action after navigation', async () => {
  const { fake, dispatch, run, calls } = await mockStudio();
  const identity = { runId: run.id, pageId: 'page-a', leaseEpoch: run.leaseEpoch, type: 'click', selector: '#safe' };
  await assert.rejects(dispatch('action', identity, 'api'), (error: any) => error.status === 409);
  let release!: () => void;
  fake.block(new Promise<void>(resolve => { release = resolve; }));
  const pending = dispatch('action', { ...identity, generation: 3 }, 'api');
  const rejected = assert.rejects(pending, (error: any) => error.status === 409);
  run.pages.get('page-a')!.navigationGeneration = 4;
  release(); await rejected;
  assert.equal(calls.length, 0, 'A stale command never reaches the browser operation');
  await dispatch('action', { ...identity, generation: 4 }, 'api');
  assert.equal(calls[0].method, 'action');
});

test('a stop from startup still targets the same running validation, but cannot stop a replacement execution', async () => {
  const { fake, run } = await mockStudio();
  let stopped = 0;
  const studio = { ...fake, state: () => ({ active: run, validationStarting: null,
    validations: [{ id: 'validation-1', runId: run.id }] }), stopRunner: async () => { stopped++; } };
  const dispatch = makeDispatch(studio as unknown as Studio);
  await dispatch('stopRunner', { validationId: 'validation-1' }, 'ui');
  assert.equal(stopped, 1);
  await assert.rejects(dispatch('stopRunner', { validationId: 'validation-previous' }, 'ui'), (error: any) => error.status === 409);
  await assert.rejects(dispatch('stopRunner', { runId: 'run-previous' }, 'ui'), (error: any) => error.status === 409);
  assert.equal(stopped, 1);
});

test('human handoff release and review writes require the trusted UI source', async () => {
  const { dispatch, calls } = await mockStudio();
  for (const method of ['replyHuman', 'releaseHuman', 'review']) {
    await assert.rejects(dispatch(method, { handoffId: 'handoff-1', validationId: 'validation-a', verdict: 'accept', reason: 'forged', leaseEpoch: 7 }, 'api'), (error: any) => error.status === 403);
  }
  assert.deepEqual(calls, []);
  await dispatch('releaseHuman', { handoffId: 'handoff-1' }, 'ui');
  await dispatch('review', { id: 'validation-a', verdict: 'exception', reason: 'Trusted decision' }, 'ui');
  assert.deepEqual(calls.map(({ method }) => method), ['releaseHuman', 'review']);
});

test('path validation identity wins for reads and summary keeps its requested budget', async () => {
  const { dispatch, calls } = await mockStudio();
  await dispatch('validation', { validationId: 'path-id', id: 'wrong-id' }, 'api');
  await dispatch('summary', { runId: 'run-1', maxBytes: 1200 }, 'api');
  await dispatch('reviews', { validationId: 'path-id', id: 'wrong-id', maxBytes: 1200, cursor: 'bounded-next' }, 'api');
  assert.equal(calls[0].body, 'path-id'); assert.equal(calls[1].body.maxBytes, 1200);
  assert.equal(calls[2].body.id, 'path-id'); assert.equal(calls[2].body.options.maxBytes, 1200); assert.equal(calls[2].body.options.cursor, 'bounded-next');
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
