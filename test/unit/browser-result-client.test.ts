import { afterEach, expect, test, vi } from 'vitest';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import type { BrowserResultMethod } from '@/contracts/browser-results';
const clients: BrowserWorkbenchClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.useRealTimers(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function fixture(grant = 'project-workbench') {
  let reply: () => Promise<Response> = async () => json({ items: [], returnedBytes: 55, outputTruncated: false });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (url === '/workbench/session') return json({ token: 'b'.repeat(43), instanceId: 'instance', projectId: 'project', grant, expiresAt: Date.now() + 1000 });
    if (url === '/workbench/events') return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    if (JSON.parse(String(init?.body)).method === 'state') return json({ project: { id: 'project', name: 'Project', objective: '', revision: 0 } });
    return reply();
  });
  const client = new BrowserWorkbenchClient({ instanceId: 'instance', fetch: fetcher as typeof fetch, retryDelaysMs: [] }); clients.push(client); await client.connect('a'.repeat(43));
  return { client, fetcher, reply: (value: typeof reply) => { reply = value; }, offline: () => stream.error(new Error('offline')) };
}
test('results only work with explicit combined grant and no generic/native call exists', async () => {
  for (const grant of ['project-metadata', 'project-materials']) { const f = await fixture(grant); await expect(f.client.resultCall('projectExecutions', { projectId: 'project' })).rejects.toMatchObject({ code: 'forbidden' }); expect(f.fetcher).toHaveBeenCalledTimes(3); }
  const f = await fixture(); expect(f.client.results.canRead()).toBe(true); expect(f.client.materials.canEdit()).toBe(true); expect('call' in f.client).toBe(false); expect(f.client.nativePresentation).toBeNull();
  await expect(f.client.resultCall('projectExecutions', { projectId: 'other' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.client.resultCall('assessExecution' as BrowserResultMethod, { projectId: 'project' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.client.resultCall('projectExecutions', { projectId: 'project' })).resolves.toHaveProperty('items');
});
test('wrong execution bindings and malformed/over-budget responses are errors, never empty results', async () => {
  for (const value of [{ binding: { projectId: 'other', executionId: 'e' } }, { binding: { projectId: 'project', executionId: 'other' } }, null]) {
    const f = await fixture(); f.reply(async () => json(value)); await expect(f.client.resultCall('execution', { projectId: 'project', executionId: 'e' })).rejects.toMatchObject({ code: 'protocol' });
  }
  const f = await fixture(); f.reply(async () => json({ items: [], outputTruncated: false })); await expect(f.client.resultCall('projectExecutions', { projectId: 'project' })).rejects.toMatchObject({ code: 'protocol' });
  const big = await fixture(); big.reply(async () => json({ items: ['x'.repeat(70_000)], returnedBytes: 0, outputTruncated: false })); await expect(big.client.resultCall('projectExecutions', { projectId: 'project' })).rejects.toMatchObject({ code: 'protocol' });
});
test('disconnect or natural expiry withholds late reads; no read automatically loops or mutates', async () => {
  for (const expire of [false, true]) {
    vi.useFakeTimers(); const f = await fixture(); let resolve!: (value: Response) => void;
    f.reply(() => new Promise(done => { resolve = done; })); const pending = f.client.resultCall('projectExecutions', { projectId: 'project' });
    if (expire) await vi.advanceTimersByTimeAsync(1000); else f.client.disconnect();
    resolve(json({ items: [{ secret: 'old scope' }], returnedBytes: 55, outputTruncated: false }));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); expect(f.client.getSnapshot().state).toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(4); vi.useRealTimers();
  }
});
test('domain failures keep authenticated connection; offline blocks reads until recovered', async () => {
  const f = await fixture(); f.reply(async () => json({ error: { code: 'conflict' } }, 409));
  await expect(f.client.resultCall('projectExecutions', { projectId: 'project' })).rejects.toMatchObject({ code: 'conflict' }); expect(f.client.getSnapshot().status).toBe('connected'); expect(f.fetcher).toHaveBeenCalledTimes(4);
  f.offline(); await vi.waitFor(() => expect(f.client.getSnapshot().status).toBe('stale'));
  await expect(f.client.resultCall('projectExecutions', { projectId: 'project' })).rejects.toMatchObject({ code: 'unavailable' }); expect(f.fetcher).toHaveBeenCalledTimes(4);
});
