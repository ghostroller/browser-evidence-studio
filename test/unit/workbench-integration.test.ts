import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { atomicJson } from '@/evidence/files';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';
import { WorkbenchSessions } from '@/main/workbench/session';
import { WorkbenchDispatcher } from '@/main/workbench/dispatch';
import { WorkbenchHttpTransport } from '@/main/workbench/http';
import { createProjectMetadataPort } from '@/main/workbench/project-port';
import { createWorkbenchDevProxy } from '@/main/workbench/dev-proxy';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function domain(write = atomicJson) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-workbench-fixture-'));
  const host: WorkspaceManagementHost = { root, projects: [], profiles: [], state: () => ({}) };
  const management = new WorkspaceManagement(host, write); await management.init();
  const project = await management.createProject({ name: 'Synthetic metadata', objective: 'Fixture only', operationId: 'create' });
  const sessions = new WorkbenchSessions({ instanceId: 'fixture-instance' }); cleanup.push(() => sessions.dispose());
  const session = sessions.exchange(sessions.begin(project.id).ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const dispatcher = new WorkbenchDispatcher(sessions, createProjectMetadataPort(management));
  const command = (body = {}) => ({ instanceId: sessions.instanceId, method: 'updateProject', body: { projectId: project.id, name: 'Saved fixture', expectedRevision: 1, operationId: 'save', ...body } });
  return { root, host, management, project, sessions, session, context, dispatcher, command };
}
test('real manifest port preserves durable operation identity and CAS across service restart', async () => {
  const f = await domain();
  const saved = await f.dispatcher.dispatch(f.command(), f.context);
  expect(saved).toEqual({ id: f.project.id, name: 'Saved fixture', objective: 'Fixture only', revision: 2 });
  const reopened = new WorkspaceManagement({ ...f.host, projects: [], profiles: [] }); await reopened.init();
  const again = new WorkbenchDispatcher(f.sessions, createProjectMetadataPort(reopened));
  expect(await again.dispatch(f.command(), f.context)).toEqual(saved);
  await expect(again.dispatch(f.command({ operationId: 'different' }), f.context)).rejects.toMatchObject({ code: 'conflict' });
  await expect(again.dispatch(f.command({ name: 'Different payload' }), f.context)).rejects.toMatchObject({ code: 'conflict' });
  const disk = JSON.parse(await readFile(path.join(f.root, 'workspace.json'), 'utf8'));
  expect(disk.workspaceRevision).toBe(2); expect(Object.keys(disk.managementOperations)).toEqual(['create', 'save']);
});
test.each(['revoke', 'abort'] as const)('queued production write and read recheck %s before their actual queue start', async cancellation => {
  let block = false, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await domain(async (file, value) => { if (block) { entered(); await gate; } await atomicJson(file, value); });
  block = true;
  const native = f.management.updateProject({ projectId: f.project.id, expectedRevision: 1, name: 'Native queue owner', operationId: 'native' });
  await reached;
  const controller = new AbortController();
  const pending = f.dispatcher.dispatch(f.command({ expectedRevision: 2 }), f.context, controller.signal);
  const read = f.dispatcher.dispatch({ instanceId: f.sessions.instanceId, method: 'state', body: { projectId: f.project.id } }, f.context, controller.signal);
  const code = cancellation === 'revoke' ? 'unauthorized' : 'cancelled';
  const deniedWrite = expect(pending).rejects.toMatchObject({ code });
  const deniedRead = expect(read).rejects.toMatchObject({ code });
  if (cancellation === 'revoke') f.sessions.revokeIssuer(); else controller.abort();
  release(); await native; await deniedWrite; await deniedRead;
  const disk = JSON.parse(await readFile(path.join(f.root, 'workspace.json'), 'utf8'));
  expect(disk.projects[0].name).toBe('Native queue owner'); expect(disk.managementOperations.save).toBeUndefined();
});
test('started real atomic write completes after revocation without claiming rollback', async () => {
  let block = false, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await domain(async (file, value) => { if (block) { entered(); await gate; } await atomicJson(file, value); });
  block = true;
  const pending = f.dispatcher.dispatch(f.command(), f.context); await reached;
  f.sessions.revokeIssuer(); release();
  expect(await pending).toMatchObject({ revision: 2, name: 'Saved fixture' });
  expect(JSON.parse(await readFile(path.join(f.root, 'workspace.json'), 'utf8')).projects[0].revision).toBe(2);
});
test('corrupt manifest and private service errors become fixed codes, not empty state or paths', async () => {
  const f = await domain(); await writeFile(path.join(f.root, 'workspace.json'), '{broken');
  await expect(f.dispatcher.dispatch({ instanceId: f.sessions.instanceId, method: 'state', body: { projectId: f.project.id } }, f.context)).rejects.toMatchObject({ code: 'internal_error', message: 'internal_error' });
});

async function connected() {
  const f = await domain();
  let middleware: ReturnType<typeof createWorkbenchDevProxy> | undefined;
  const proxy = createServer((req, res) => middleware ? middleware(req, res, () => { res.writeHead(404); res.end(); }) : res.end());
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const transport = new WorkbenchHttpTransport({ origin, sessions: f.sessions, projectPort: createProjectMetadataPort(f.management) });
  const companion = await transport.start(); cleanup.push(() => transport.dispose());
  middleware = createWorkbenchDevProxy({ origin, targetPort: Number(new URL(companion.baseUrl).port) });
  f.host.onChanged = () => transport.invalidate(f.project.id);
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Instance': f.sessions.instanceId,
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Authorization: `Bearer ${f.session.token}` };
  const post = (url: string, body: unknown, patch: Record<string, string> = {}) => fetch(origin + url, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
  return { ...f, transport, origin, headers, post };
}
test('same-origin proxy → authenticated HTTP → real workspace and SSE survive native changes', async () => {
  const f = await connected();
  const exchanged = await f.post('/workbench/session', { instanceId: f.sessions.instanceId, ticket: f.sessions.begin(f.project.id).ticket });
  expect(exchanged.status).toBe(200);
  const controller = new AbortController(); cleanup.push(() => controller.abort());
  const events = await fetch(f.origin + '/workbench/events', { method: 'POST', headers: f.headers, body: JSON.stringify({ instanceId: f.sessions.instanceId, projectId: f.project.id }), signal: controller.signal });
  expect(events.status).toBe(200); const reader = events.body!.getReader(); await reader.read();
  expect((await f.post('/workbench/rpc', f.command())).status).toBe(200);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('scope-invalidated');
  await f.management.updateProject({ projectId: f.project.id, expectedRevision: 2, objective: 'Native update', operationId: 'native-change' });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('scope-invalidated');
  const state = await f.post('/workbench/rpc', { instanceId: f.sessions.instanceId, method: 'state', body: { projectId: f.project.id } });
  expect(await state.json()).toEqual({ project: { id: f.project.id, name: 'Saved fixture', objective: 'Native update', revision: 3 } });
  const reopened = new WorkspaceManagement({ ...f.host, projects: [], profiles: [] }); await reopened.init();
  expect(await reopened.readProject(f.project.id)).toMatchObject({ revision: 3, objective: 'Native update' });
  f.sessions.revokeIssuer();
  // Revocation deliberately destroys the authenticated stream; fetch may report
  // abrupt closure rather than a clean EOF. Neither permits more state access.
  try { while (!(await reader.read()).done) { /* Drain delivered invalidations. */ } } catch { /* Revoked socket. */ }
  expect(f.transport.counts.streams).toBe(0);
  expect((await f.post('/workbench/rpc', f.command())).status).toBe(401);
});
test('proxy keeps exact authority, metadata, path, scope and method allowlists without CORS or Agent forwarding', async () => {
  const f = await connected();
  for (const [route, patch, code] of [
    ['/workbench/rpc', { Origin: 'http://127.0.0.1:1' }, 403],
    ['/workbench/rpc', { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['/workbench/rpc', { Authorization: '' }, 401],
    ['/workbench/rpc?token=fixture', {}, 404], ['/workbench/agent', {}, 404], ['/rpc', {}, 404],
  ] as const) {
    const result = await f.post(route, f.command(), patch); expect(result.status).toBe(code); expect(result.headers.get('access-control-allow-origin')).toBeNull();
  }
  // undici's fetch owns Host; raw HTTP verifies the actual wire authority.
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(f.origin + '/workbench/rpc', { method: 'POST', headers: { ...f.headers, Host: 'evil.example' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }); req.once('error', reject); req.end(JSON.stringify(f.command()));
  });
  expect(wrongHost).toBe(403);
  expect((await f.post('/workbench/rpc', f.command({ projectId: 'another-project' }))).status).toBe(403);
  expect((await f.post('/workbench/rpc', f.command({ scriptDirectory: '/private' }))).status).toBe(400);
  expect((await f.post('/workbench/rpc', { ...f.command(), source: 'ui' })).status).toBe(400);
  expect((await f.post('/workbench/rpc', { ...f.command(), method: 'createProfile' })).status).toBe(400);
  const duplicate = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(f.origin + '/workbench/rpc', { method: 'POST', headers: [
      'Host', new URL(f.origin).host, 'Origin', f.origin, 'Origin', f.origin, 'Content-Type', 'application/json',
      'Sec-Fetch-Site', 'same-origin', 'Sec-Fetch-Mode', 'cors', 'Sec-Fetch-Dest', 'empty',
    ] }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', reject); req.end('{}');
  });
  expect(duplicate).toBe(403);
  expect((await f.management.readProject(f.project.id)).revision).toBe(1);
});
