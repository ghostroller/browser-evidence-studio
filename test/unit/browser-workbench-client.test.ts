import { afterEach, expect, test, vi } from 'vitest';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';

const instanceId = 'synthetic-instance', projectId = 'project';
const ticket = 'a'.repeat(43), token = 'b'.repeat(43);
const clients: BrowserWorkbenchClient[] = [];
afterEach(() => { clients.forEach(client => client.disconnect()); clients.length = 0; vi.useRealTimers(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
function fixture(options: { ttl?: number; retries?: number[] } = {}) {
  let current: BrowserProjectMetadata = { id: projectId, name: 'Orders', objective: 'Read amounts', revision: 1 };
  let readOverride: (() => Promise<Response>) | undefined;
  let updateOverride: ((input: BrowserUpdateProject) => Promise<Response>) | undefined;
  let sessionOverride: (() => Response) | undefined;
  const streams: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal; cancelled: boolean }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url === '/workbench/session') return sessionOverride?.() ?? json({ token, instanceId, projectId, expiresAt: Date.now() + (options.ttl ?? 300_000) });
    if (url === '/workbench/events') {
      const entry = { controller: null as unknown as ReadableStreamDefaultController<Uint8Array>, signal: init!.signal as AbortSignal, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({ start(controller) { entry.controller = controller; }, cancel() { entry.cancelled = true; } });
      streams.push(entry);
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === '/workbench/rpc' && body.method === 'state') return readOverride ? readOverride() : json({ project: { ...current, privatePath: '/never-retain' }, profiles: ['private'] });
    if (url === '/workbench/rpc' && body.method === 'updateProject') {
      if (updateOverride) return updateOverride(body.body);
      current = { ...current, name: body.body.name ?? current.name, objective: body.body.objective ?? current.objective, revision: current.revision + 1 };
      return json(current);
    }
    throw new Error('Unexpected request');
  });
  const client = new BrowserWorkbenchClient({ instanceId, fetch: fetcher as typeof fetch, retryDelaysMs: options.retries ?? [10, 20] }); clients.push(client);
  return { client, fetcher, streams, setProject: (value: BrowserProjectMetadata) => { current = value; }, setRead: (value?: typeof readOverride) => { readOverride = value; }, setUpdate: (value: typeof updateOverride) => { updateOverride = value; }, setSession: (value: typeof sessionOverride) => { sessionOverride = value; },
    invalidate: (index = 0, id = projectId) => streams[index].controller.enqueue(new TextEncoder().encode(`event: scope-invalidated\ndata: ${JSON.stringify({ projectId: id })}\n\n`)) };
}

test('uses only scoped same-origin POST endpoints, private bearer headers and projected metadata', async () => {
  const f = fixture(); await f.client.connect(ticket);
  expect(f.client.nativePresentation).toBeNull(); expect('call' in f.client).toBe(false);
  expect(f.client.getSnapshot()).toMatchObject({ status: 'connected', state: { project: { id: projectId, name: 'Orders', objective: 'Read amounts', revision: 1 } } });
  expect(Object.keys(f.client.getSnapshot().state!)).toEqual(['project']);
  expect(Object.keys(f.client.getSnapshot().state!.project)).toEqual(['id', 'name', 'objective', 'revision']);
  expect(JSON.stringify(f.client)).not.toContain(token);
  expect(JSON.stringify(f.client.getSnapshot())).not.toContain(token);
  for (const [url, init] of f.fetcher.mock.calls) {
    expect(String(url)).not.toMatch(/[?#]/); expect(String(url)).not.toContain(token); expect(String(url)).not.toContain(ticket);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'same-origin' });
    expect(init!.headers).toMatchObject({ 'x-workbench-instance': instanceId });
    expect((init!.headers as Record<string, string>).Authorization).toBe(url === '/workbench/session' ? undefined : `Bearer ${token}`);
  }
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]!.body))).toEqual({ instanceId, ticket });
  expect(JSON.parse(String(f.fetcher.mock.calls[1][1]!.body))).toEqual({ instanceId, projectId });
  expect(JSON.parse(String(f.fetcher.mock.calls[2][1]!.body))).toEqual({ instanceId, method: 'state', body: { projectId } });
});
test('a failed or wrong-instance exchange never fabricates empty state', async () => {
  const f = fixture(); f.setSession(() => json({ token, instanceId: 'other', projectId, expiresAt: Date.now() + 5000 }));
  await expect(f.client.connect(ticket)).rejects.toMatchObject({ code: 'protocol' });
  expect(f.client.getSnapshot()).toMatchObject({ status: 'error', state: null }); expect(f.streams).toHaveLength(0);
  f.setSession(() => json({ error: { code: 'unauthorized', detail: 'do not echo credential' } }, 401));
  await expect(f.client.connect(ticket)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(f.client.getSnapshot()).toMatchObject({ status: 'expired', state: null });
  expect(f.client.getSnapshot().error).not.toContain('credential');
});
test('state read errors are explicit; an out-of-scope projection is not accepted', async () => {
  const f = fixture(); f.setRead(async () => json({ project: { id: 'different', name: 'Private', objective: '', revision: 1 } }));
  await expect(f.client.connect(ticket)).rejects.toMatchObject({ code: 'protocol' });
  expect(f.client.getSnapshot().state).toBeNull(); expect(f.client.getSnapshot().status).toBe('stale');
});
test('transient disconnect retains labeled stale data, bounds retries, refreshes on every stream reconnect', async () => {
  vi.useFakeTimers(); const f = fixture({ retries: [10, 20] }); await f.client.connect(ticket);
  f.streams[0].controller.error(new Error('network')); await settle();
  expect(f.client.getSnapshot()).toMatchObject({ status: 'stale', state: { project: { name: 'Orders' } } });
  await expect(f.client.updateProject({ projectId, expectedRevision: 1, operationId: 'op', name: 'No' })).rejects.toMatchObject({ code: 'unavailable' });
  f.setProject({ id: projectId, name: 'From native', objective: '', revision: 2 });
  await vi.advanceTimersByTimeAsync(10);
  expect(f.client.getSnapshot()).toMatchObject({ status: 'connected', state: { project: { name: 'From native', revision: 2 } } });
  expect(f.streams).toHaveLength(2);
  f.streams[1].controller.close(); await settle(); await vi.advanceTimersByTimeAsync(20); expect(f.streams).toHaveLength(3);
  f.streams[2].controller.close(); await settle(); await vi.advanceTimersByTimeAsync(1000); expect(f.streams).toHaveLength(3);
  await f.client.refresh(); expect(f.streams).toHaveLength(4);
});
test('invalidations refresh authorized scope and reject wrong-project frames', async () => {
  const f = fixture(); await f.client.connect(ticket);
  f.setProject({ id: projectId, name: 'Native edit', objective: '', revision: 2 }); f.invalidate(); await settle();
  expect(f.client.getSnapshot().state!.project.name).toBe('Native edit');
  f.invalidate(0, 'other'); await settle(); expect(f.client.getSnapshot().status).toBe('stale');
  expect(f.client.getSnapshot().state!.project.id).toBe(projectId);
});
test('revocation clears projection and session; expiry aborts the event reader and pending requests', async () => {
  vi.useFakeTimers(); const f = fixture({ ttl: 1000 }); await f.client.connect(ticket);
  f.setRead(async () => json({ error: { code: 'unauthorized' } }, 401));
  await expect(f.client.refresh()).rejects.toMatchObject({ code: 'unauthorized' });
  expect(f.client.getSnapshot()).toEqual({ status: 'expired', state: null, error: expect.any(String) }); expect(f.streams[0].signal.aborted).toBe(true);
  f.setRead(); await f.client.connect(ticket); await vi.advanceTimersByTimeAsync(1000);
  expect(f.client.getSnapshot().state).toBeNull(); expect(f.client.getSnapshot().status).toBe('expired'); expect(f.streams[1].cancelled).toBe(true);
});
test('same-tick queued SSE after disconnect cannot restore stale state', async () => {
  const f = fixture(); await f.client.connect(ticket); f.invalidate(); f.client.disconnect(); await settle();
  expect(f.client.getSnapshot()).toEqual({ status: 'disconnected', state: null, error: '' }); expect(f.streams[0].cancelled).toBe(true);
});
test('older reads and a disconnected generation cannot overwrite current state', async () => {
  const f = fixture(); await f.client.connect(ticket);
  let resolve!: (response: Response) => void;
  f.setRead(() => new Promise<Response>(done => { resolve = done; })); const old = f.client.refresh();
  f.setRead(); f.setProject({ id: projectId, name: 'Newest', objective: '', revision: 3 }); await f.client.refresh();
  resolve(json({ project: { id: projectId, name: 'Old', objective: '', revision: 2 } })); await old;
  expect(f.client.getSnapshot().state!.project.name).toBe('Newest');
  f.setRead(() => new Promise<Response>(done => { resolve = done; })); const pending = f.client.refresh();
  f.client.disconnect(); resolve(json({ project: { id: projectId, name: 'After close', objective: '', revision: 4 } })); await pending;
  expect(f.client.getSnapshot().state).toBeNull(); expect(f.client.getSnapshot().status).toBe('disconnected');
});
test('mutation uses caller CAS/id, never retries automatically and rejects non-whitelist or cross-scope fields', async () => {
  const f = fixture(); await f.client.connect(ticket); const input = { projectId, expectedRevision: 1, operationId: 'stable-operation', name: 'Edited' };
  f.setUpdate(async () => { throw new Error('secret transport detail'); });
  await expect(f.client.updateProject(input)).rejects.toMatchObject({ code: 'network' }); await settle();
  const writes = () => f.fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init!.body)).method === 'updateProject');
  expect(writes()).toHaveLength(1); expect(JSON.parse(String(writes()[0][1]!.body)).body).toEqual(input);
  expect(f.client.getSnapshot().error).not.toContain('secret');
  await expect(f.client.updateProject(input)).rejects.toMatchObject({ code: 'network' }); expect(writes()).toHaveLength(2);
  await settle();
  await expect(f.client.updateProject({ ...input, projectId: 'private' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.client.updateProject({ ...input, source: 'ui' } as typeof input)).rejects.toMatchObject({ code: 'invalid_request' }); expect(writes()).toHaveLength(2);
});
test('disconnect aborts pending exchange and discards its late successful response', async () => {
  const f = fixture(); let resolve!: (response: Response) => void;
  const delayed = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>(done => { resolve = done; }));
  const client = new BrowserWorkbenchClient({ instanceId, fetch: delayed as typeof fetch }); clients.push(client);
  const connect = client.connect(ticket); client.disconnect();
  expect(delayed.mock.calls[0][1]!.signal!.aborted).toBe(true);
  resolve(json({ token, instanceId, projectId, expiresAt: Date.now() + 5000 })); await connect;
  expect(client.getSnapshot()).toEqual({ status: 'disconnected', state: null, error: '' }); expect(f.streams).toHaveLength(0);
});
test('queued invalidation from a prior connection cannot change the next connection state', async () => {
  const f = fixture(); await f.client.connect(ticket); f.invalidate();
  f.setProject({ id: projectId, name: 'Second session', objective: '', revision: 2 });
  await f.client.connect(ticket); await settle();
  expect(f.client.getSnapshot()).toMatchObject({ status: 'connected', state: { project: { name: 'Second session', revision: 2 } } }); expect(f.streams[0].cancelled).toBe(true);
});
test('bursty invalidation has one active event refresh plus one latest read', async () => {
  const f = fixture(); await f.client.connect(ticket); const before = f.fetcher.mock.calls.length;
  let resolve!: (response: Response) => void; f.setRead(() => new Promise(done => { resolve = done; }));
  f.invalidate(); await settle();
  for (let i = 0; i < 30; ++i) f.invalidate(); await settle();
  expect(f.fetcher.mock.calls.length - before).toBe(1);
  resolve(json({ project: { id: projectId, name: 'During batch', objective: '', revision: 2 } })); await settle();
  expect(f.fetcher.mock.calls.length - before).toBe(2);
  expect(f.client.getSnapshot()).toMatchObject({ status: 'stale', state: { project: { name: 'Orders', revision: 1 } } });
  await expect(f.client.updateProject({ projectId, expectedRevision: 1, operationId: 'too-early', name: 'No' })).rejects.toMatchObject({ code: 'unavailable' });
  resolve(json({ project: { id: projectId, name: 'Latest batch', objective: '', revision: 3 } })); await settle();
  expect(f.client.getSnapshot()).toMatchObject({ status: 'connected', state: { project: { name: 'Latest batch', revision: 3 } } });
});
test('401 response cannot disguise revocation with a conflicting error body', async () => {
  const f = fixture(); await f.client.connect(ticket); f.setRead(async () => json({ error: { code: 'busy' } }, 401));
  await expect(f.client.refresh()).rejects.toMatchObject({ code: 'unauthorized' }); expect(f.client.getSnapshot().state).toBeNull();
});
