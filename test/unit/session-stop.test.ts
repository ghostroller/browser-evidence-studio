import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));

import { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';
import { TaskAuthorizations } from '@/main/services/task-authorization';

const authorizations: TaskAuthorizations[] = [];
afterEach(() => { for (const tasks of authorizations.splice(0)) tasks.close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const connectionReady = deferred(), transportQuiet = deferred();
  const pending = { abort: new AbortController(), gate: { close: vi.fn() }, promise: connectionReady.promise };
  const operation = { gate: { close: vi.fn() }, browser: { disconnect: vi.fn(() => transportQuiet.promise) } };
  const pages = new Map([['page', { pageId: 'page', targetId: 'target', navigationGeneration: 3,
    view: { webContents: { isDestroyed: () => false, stop: vi.fn() } } }]]);
  const runtime: any = { projectId: 'project', profileId: 'profile', controller: 'agent', leaseEpoch: 7,
    locked: false, execution: 'ready', pages, selectedPageId: 'page', pendingOperation: pending, operation };
  const tasks = new TaskAuthorizations(); authorizations.push(tasks);
  const studio: any = Object.create(Studio.prototype);
  Object.assign(studio, {
    active: undefined, browser: { id: 'session-current', runtime }, queue: Promise.resolve(), tasks,
    projects: [], profiles: [], runs: [], validations: [], onChanged: vi.fn(),
    window: { lock: vi.fn(), show: vi.fn(), remove: vi.fn() },
    // State projection is a read adapter; stopping/revocation use the real services.
    state: () => ({ active: studio.active, validationStarting: null, validations: [],
      session: studio.browser ? { sessionId: studio.browser.id, ...studio.browser.runtime } : null }),
  });
  return { studio, runtime, pending, operation, pages, connectionReady, transportQuiet, dispatch: makeDispatch(studio) };
}

it('global stop bypasses the operation queue and waits for an unrecorded session to become quiet before human takeover', async () => {
  const f = fixture(), blockedQueue = deferred();
  f.studio.queue = blockedQueue.promise;
  let returned = false;
  const stopping = f.dispatch('stopRunner', { sessionId: 'session-current' }, 'ui').then(() => { returned = true; });
  try {
    await Promise.resolve();
    expect(f.pending.abort.signal.aborted).toBe(true);
    expect(f.pending.gate.close).toHaveBeenCalledOnce();
    expect(f.operation.gate.close).toHaveBeenCalledOnce();
    expect(f.operation.browser.disconnect).toHaveBeenCalledOnce();
    expect(f.runtime.leaseEpoch).toBeGreaterThan(7);
    expect(f.runtime.locked).toBe(true);
    expect(f.runtime.controller).not.toBe('human');
    expect(returned).toBe(false);

    f.connectionReady.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(f.runtime.controller).not.toBe('human');
    expect(returned).toBe(false);
    f.transportQuiet.resolve();
    await stopping;

    expect(f.runtime.pendingOperation).toBeUndefined();
    expect(f.runtime.operation).toBeUndefined();
    expect(f.runtime.controller).toBe('human');
    expect(f.runtime.locked).toBe(false);
    expect(f.runtime.stopping).toBeFalsy();
    expect(f.studio.window.lock).toHaveBeenLastCalledWith(false);
    expect(f.studio.active).toBeUndefined();
    expect(f.runtime.pages).toBe(f.pages);
    expect(f.studio.window.remove).not.toHaveBeenCalled();
  } finally {
    f.connectionReady.resolve(); f.transportQuiet.resolve(); blockedQueue.resolve(); await stopping;
  }
});

it('a stale session-only stop is rejected before it can revoke the current session', async () => {
  const f = fixture();
  const stop = vi.spyOn(f.studio, 'stopRunner');
  await expect(f.dispatch('stopRunner', { sessionId: 'session-previous' }, 'ui')).rejects.toMatchObject({ status: 409 });
  expect(stop).not.toHaveBeenCalled();
  expect(f.pending.abort.signal.aborted).toBe(false);
  expect(f.pending.gate.close).not.toHaveBeenCalled();
  expect(f.operation.gate.close).not.toHaveBeenCalled();
  expect(f.runtime.leaseEpoch).toBe(7);
  expect(f.runtime.controller).toBe('agent');
  expect(f.studio.window.lock).not.toHaveBeenCalled();
});

it('completion of an old session stop cannot unlock or take over a replacement session', async () => {
  const f = fixture();
  const stopping = f.dispatch('stopRunner', { sessionId: 'session-current' }, 'ui');
  await Promise.resolve();
  expect(f.pending.abort.signal.aborted).toBe(true);
  const replacement = { ...f.runtime, controller: 'agent', locked: true, leaseEpoch: 40,
    pendingOperation: undefined, operation: undefined };
  f.studio.browser = { id: 'session-replacement', runtime: replacement };
  f.studio.window.lock.mockClear();
  f.connectionReady.resolve(); f.transportQuiet.resolve(); await stopping;
  expect(f.studio.browser.runtime).toBe(replacement);
  expect(replacement.controller).toBe('agent');
  expect(replacement.locked).toBe(true);
  expect(replacement.leaseEpoch).toBe(40);
  expect(f.studio.window.lock).not.toHaveBeenCalledWith(false);
});

it('global stop with no live session or validation is a no-op and never creates or locks a session', async () => {
  const f = fixture(); f.studio.browser = undefined;
  await expect(f.studio.stopRunner()).resolves.toBeNull();
  expect(f.studio.active).toBeUndefined();
  expect(f.studio.browser).toBeUndefined();
  expect(f.studio.window.lock).not.toHaveBeenCalled();
  expect(f.studio.window.remove).not.toHaveBeenCalled();
  expect(f.pending.abort.signal.aborted).toBe(false);
});

it('concurrent global stops share the same transport drain and neither acknowledges takeover early', async () => {
  const f = fixture(), returned: number[] = [];
  const first = f.dispatch('stopRunner', { sessionId: 'session-current' }, 'ui').then(() => { returned.push(1); });
  const second = f.dispatch('stopRunner', { sessionId: 'session-current' }, 'ui').then(() => { returned.push(2); });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toEqual([]);
    expect(f.operation.browser.disconnect).toHaveBeenCalledOnce();
    expect(f.pending.gate.close).toHaveBeenCalledOnce();
    expect(f.runtime.leaseEpoch).toBe(8);
    f.connectionReady.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toEqual([]);
    expect(f.runtime.controller).not.toBe('human');
    f.transportQuiet.resolve(); await Promise.all([first, second]);
    expect(returned.sort()).toEqual([1, 2]);
    expect(f.runtime.controller).toBe('human');
    expect(f.runtime.locked).toBe(false);
  } finally {
    f.connectionReady.resolve(); f.transportQuiet.resolve(); await Promise.all([first, second]);
  }
});

it('stopping during real task-page creation waits for allocation and rollback without granting or retaining the new page', async () => {
  const f = fixture(), allocated = deferred(), cleanup = deferred();
  const grant = await f.studio.tasks.issue({ projectId: 'project', profileId: 'profile', sessionId: 'session-current' },
    { origins: ['https://fixture.test'], pages: [{ pageId: 'page', targetId: 'target' }],
      capabilities: ['page-create'], durationMs: 60000, maxOperations: 10 });
  f.studio.browserAuthorizationId = grant.authorizationId;
  const created = { pageId: 'created', targetId: 'created-target', navigationGeneration: 0,
    view: { webContents: { isDestroyed: () => false, stop: vi.fn() } } };
  // Native allocation is the explicit mock boundary; createTaskPage, stop and
  // authorization are real services, with independent allocation/cleanup waits.
  f.studio.addPage = vi.fn(async () => { await allocated.promise; f.runtime.pages.set('created', created); return created; });
  f.studio.closePageContents = vi.fn(async () => { await cleanup.promise; f.runtime.pages.delete('created'); });
  const addAuthorizedPage = vi.spyOn(f.studio.tasks, 'addPage');
  let creationError: unknown, returned = false;
  const creation = f.studio.createTaskPage({ authorizationId: grant.authorizationId, pageId: 'page', generation: 3,
    leaseEpoch: 7, startUrl: 'https://fixture.test/new' }).catch((error: unknown) => { creationError = error; });
  const stopping = f.dispatch('stopRunner', { sessionId: 'session-current' }, 'ui').then(() => { returned = true; });
  try {
    f.connectionReady.resolve(); f.transportQuiet.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(f.runtime.locked).toBe(true);
    expect(f.runtime.controller).not.toBe('human');
    allocated.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.studio.closePageContents).toHaveBeenCalledWith(created);
    expect(returned).toBe(false);
    expect(f.runtime.controller).not.toBe('human');
    cleanup.resolve(); await Promise.all([creation, stopping]);
    expect(creationError).toBeInstanceOf(Error);
    expect(f.runtime.pages.has('created')).toBe(false);
    expect(f.runtime.pages.has('page')).toBe(true);
    expect(addAuthorizedPage).not.toHaveBeenCalled();
    expect(f.studio.browserAuthorizationId).toBeUndefined();
    expect(f.runtime.controller).toBe('human');
    expect(f.runtime.locked).toBe(false);
    expect(f.studio.active).toBeUndefined();
  } finally {
    allocated.resolve(); cleanup.resolve(); f.connectionReady.resolve(); f.transportQuiet.resolve();
    await Promise.all([creation, stopping]);
  }
});
