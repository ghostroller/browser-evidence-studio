import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';
import { WorkbenchHttpTransport, WORKBENCH_PATHS } from '@/main/workbench/http';
import { WorkbenchSessions } from '@/main/workbench/session';
import { type ProjectMetadataPort, type WorkbenchExecutionPermit } from '@/main/workbench/dispatch';

const transports: WorkbenchHttpTransport[] = [];
afterEach(async () => { for (const transport of transports.splice(0)) await transport.dispose(); });
interface HttpResult { status: number; headers: IncomingHttpHeaders; body: unknown }
async function fixture(options: Partial<ConstructorParameters<typeof WorkbenchHttpTransport>[0]> = {}) {
  let now = 1_000;
  const sessions = new WorkbenchSessions({ instanceId: 'http-memory-fixture', now: () => now, sessionTtlMs: 1_000 });
  const projects = new Map<string, BrowserProjectMetadata>(['a', 'b'].map(letter => [`project-${letter}`, { id: `project-${letter}`, name: letter, objective: '', revision: 1 }]));
  const writes: Readonly<BrowserUpdateProject>[] = [];
  const port: ProjectMetadataPort = {
    readProject: async (id, permit) => permit.start(() => projects.get(id)!),
    updateProject: async (input, permit) => permit.start(() => {
      writes.push(input);
      const result = { ...projects.get(input.projectId)!, name: input.name ?? 'a', revision: input.expectedRevision + 1 };
      projects.set(input.projectId, result);
      return result;
    }),
  };
  const origin = 'http://127.0.0.1:5173';
  const transport = new WorkbenchHttpTransport({ origin, sessions, projectPort: port, ...options });
  transports.push(transport);
  const address = await transport.start();
  const session = sessions.exchange(sessions.begin('project-a').ticket, sessions.instanceId);
  const headers = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Origin: origin, 'X-Workbench-Instance': sessions.instanceId, 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const read = { instanceId: sessions.instanceId, method: 'state', body: { projectId: 'project-a' } };
  const update = { instanceId: sessions.instanceId, method: 'updateProject', body: { projectId: 'project-a', operationId: 'op-http', expectedRevision: 1, name: 'updated' } };
  const post = (body: unknown = read, settings: { method?: string; path?: string; headers?: Record<string, string | string[] | undefined>; raw?: string } = {}): Promise<HttpResult> => new Promise((resolve, reject) => {
    const allHeaders: Record<string, string | string[] | undefined> = { ...headers, ...settings.headers };
    for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
    const wireHeaders = Object.values(allHeaders).some(Array.isArray)
      ? Object.entries({ Host: new URL(address.baseUrl).host, ...allHeaders }).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value!]).flatMap(item => [key, item]))
      : allHeaders;
    const outgoing = request(address.baseUrl + (settings.path ?? WORKBENCH_PATHS.rpc), { method: settings.method ?? 'POST', headers: wireHeaders }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: response.statusCode!, headers: response.headers, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.end(settings.raw ?? JSON.stringify(body));
  });
  const events = (token = session.token, projectId = 'project-a') => new Promise<{ response: IncomingMessage; chunks: string[]; closed: Promise<void> }>((resolve, reject) => {
    const outgoing = request(address.baseUrl + WORKBENCH_PATHS.events, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` } }, response => {
      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
      response.on('error', () => {});
      const closed = new Promise<void>(done => response.once('close', done));
      resolve({ response, chunks, closed });
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ instanceId: sessions.instanceId, projectId }));
  });
  return { transport, sessions, session, projects, writes, port, address, origin, read, update, post, events, advance: () => { now += 1_000; sessions.sweep(); } };
}
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail('fixture condition did not settle');
}
const errorCode = (response: HttpResult, status: number, code: string) => {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, { error: { code } });
};

test('fixture transport binds only dynamic IPv4 loopback, authenticates state and projects safe JSON', async () => {
  const f = await fixture();
  assert.equal(f.transport.listening, true);
  assert.match(f.address.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const result = await f.post();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { project: f.projects.get('project-a') });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
});

test('fixed POST exchange consumes one ticket; there are no public begin/revoke, OPTIONS or query routes', async () => {
  const f = await fixture();
  const ticket = f.sessions.begin('project-b');
  const body = { instanceId: f.sessions.instanceId, ticket: ticket.ticket };
  const paired = await f.post(body, { path: WORKBENCH_PATHS.session, headers: { Authorization: undefined } });
  assert.equal(paired.status, 200);
  assert.equal((paired.body as { projectId: string }).projectId, 'project-b');
  errorCode(await f.post(body, { path: WORKBENCH_PATHS.session }), 401, 'unauthorized');
  for (const path of ['/workbench/begin', '/workbench/revoke', WORKBENCH_PATHS.rpc + '?token=not-real']) errorCode(await f.post(f.read, { path }), 404, 'not_found');
  for (const method of ['GET', 'OPTIONS']) errorCode(await f.post(f.read, { method }), 404, 'not_found');
});

test('missing/wrong/expired/revoked authentication is rejected for RPC and events', async () => {
  const f = await fixture();
  for (const path of [WORKBENCH_PATHS.rpc, WORKBENCH_PATHS.events]) {
    errorCode(await f.post(f.read, { path, headers: { Authorization: undefined } }), 401, 'unauthorized');
    errorCode(await f.post(f.read, { path, headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } }), 401, 'unauthorized');
  }
  f.advance();
  errorCode(await f.post(), 401, 'unauthorized');
  const fresh = f.sessions.exchange(f.sessions.begin('project-a').ticket, f.sessions.instanceId);
  f.sessions.revokeProject('project-a');
  errorCode(await f.post(f.read, { headers: { Authorization: `Bearer ${fresh.token}` } }), 401, 'unauthorized');
  assert.equal(f.writes.length, 0);
});

test('exact Host, Origin, instance header/body and request content type are mandatory', async () => {
  const f = await fixture();
  for (const headers of [{ Host: 'localhost:1' }, { Origin: undefined }, { Origin: 'null' }, { Origin: f.origin + '/' }, { Origin: 'https://evil.example' }, { 'X-Workbench-Instance': 'other-instance' }, { 'Sec-Fetch-Site': undefined }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Mode': undefined }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-Dest': undefined }]) {
    errorCode(await f.post(f.read, { headers }), 403, 'forbidden');
  }
  errorCode(await f.post({ ...f.read, instanceId: 'other' }), 403, 'forbidden');
  errorCode(await f.post(f.read, { headers: { 'Content-Type': 'text/plain' } }), 400, 'invalid_request');
  errorCode(await f.post(f.read, { headers: { 'Content-Encoding': 'gzip' } }), 400, 'invalid_request');
  assert.equal(f.writes.length, 0);
});

test('cross-project requests, unknown operations and extra fields fail before a business write', async () => {
  const f = await fixture();
  errorCode(await f.post({ ...f.update, body: { ...f.update.body, projectId: 'project-b' } }), 403, 'forbidden');
  errorCode(await f.post({ ...f.update, method: 'createProject' }), 400, 'invalid_request');
  errorCode(await f.post({ ...f.update, source: 'ui' }), 400, 'invalid_request');
  errorCode(await f.post({ ...f.update, body: { ...f.update.body, scriptDirectory: '/private' } }), 400, 'invalid_request');
  assert.equal(f.writes.length, 0);
});

test('oversize, deeply nested and malformed payloads are bounded and errors do not echo input', async () => {
  const f = await fixture({ maxBodyBytes: 256 });
  errorCode(await f.post(null, { raw: 'sensitive-fixture' + 'x'.repeat(1_000) }), 400, 'invalid_request');
  errorCode(await f.post(null, { raw: '{broken-secret-fixture' }), 400, 'invalid_request');
  errorCode(await f.post({ x: { x: { x: { x: { x: { x: { x: { x: 'secret' } } } } } } } }), 400, 'invalid_request');
  f.port.readProject = async () => { throw new Error('fixture-secret-token/path'); };
  errorCode(await f.post(), 500, 'internal_error');
});

test('RPC concurrency budget rejects excess work; session is rechecked after the port queue', async () => {
  const f = await fixture({ maxRequests: 1 });
  let release!: () => void;
  let queued = false;
  f.port.updateProject = (_input, permit) => new Promise((resolve, reject) => {
    queued = true;
    release = () => { try { resolve(permit.start(() => { f.writes.push(_input); return f.projects.get('project-a')!; })); } catch (error) { reject(error); } };
  });
  const waiting = f.post(f.update);
  await eventually(() => queued);
  errorCode(await f.post(), 429, 'busy');
  f.sessions.revokeProject('project-a');
  release();
  errorCode(await waiting, 401, 'unauthorized');
  assert.equal(f.writes.length, 0);
  assert.equal(f.transport.counts.requests, 0);
});

test('authenticated SSE sends only scoped invalidation and cleans up on disconnect', async () => {
  const f = await fixture();
  const a = await f.events();
  const bSession = f.sessions.exchange(f.sessions.begin('project-b').ticket, f.sessions.instanceId);
  const b = await f.events(bSession.token, 'project-b');
  assert.equal(a.response.statusCode, 200);
  f.transport.invalidate('project-b');
  await eventually(() => b.chunks.join('').includes('scope-invalidated'));
  assert.equal(a.chunks.join('').includes('scope-invalidated'), false);
  await f.post(f.update);
  await eventually(() => a.chunks.join('').includes('scope-invalidated'));
  const stream = a.chunks.join('');
  assert.equal(stream, ': connected\n\nevent: scope-invalidated\ndata: {"projectId":"project-a"}\n\n');
  assert.equal(stream.includes(f.session.token), false);
  assert.equal(stream.includes('updated'), false);
  a.response.destroy(); b.response.destroy();
  await Promise.all([a.closed, b.closed]);
  await eventually(() => f.transport.counts.streams === 0);
  assert.equal(f.sessions.counts.listeners, 0);
});

test('SSE scope, per-session/global capacity, revoke, expiry and disposal are enforced', async () => {
  const f = await fixture({ maxStreams: 2, maxStreamsPerSession: 1 });
  const eventsBody = { instanceId: f.sessions.instanceId, projectId: 'project-b' };
  errorCode(await f.post(eventsBody, { path: WORKBENCH_PATHS.events }), 403, 'forbidden');
  const first = await f.events();
  errorCode(await f.post({ ...eventsBody, projectId: 'project-a' }, { path: WORKBENCH_PATHS.events }), 429, 'busy');
  const bSession = f.sessions.exchange(f.sessions.begin('project-b').ticket, f.sessions.instanceId);
  const second = await f.events(bSession.token, 'project-b');
  const thirdSession = f.sessions.exchange(f.sessions.begin('project-a').ticket, f.sessions.instanceId);
  errorCode(await f.post({ ...eventsBody, projectId: 'project-a' }, { path: WORKBENCH_PATHS.events, headers: { Authorization: `Bearer ${thirdSession.token}` } }), 429, 'busy');
  f.sessions.revokeProject('project-a');
  await first.closed;
  assert.equal(f.transport.counts.streams, 1);
  f.advance();
  await second.closed;
  assert.equal(f.transport.counts.streams, 0);
  const fresh = f.sessions.exchange(f.sessions.begin('project-a').ticket, f.sessions.instanceId);
  const last = await f.events(fresh.token);
  await f.transport.dispose();
  await last.closed;
  assert.equal(f.sessions.counts.listeners, 0);
  assert.equal(f.transport.counts.streams, 0);
});

test('slow SSE consumers are disconnected at write backpressure without unbounded buffering', async () => {
  const f = await fixture();
  const stream = await f.events();
  stream.response.pause();
  let writes = 0;
  while (f.transport.counts.streams && writes++ < 4_096) f.transport.invalidate('project-a');
  assert.equal(f.transport.counts.streams, 0);
  assert.ok(writes < 4_096);
  assert.equal(f.sessions.counts.listeners, 0);
  stream.response.destroy();
});

test('disconnecting an unstarted queued RPC cancels its permit without starting the operation', async () => {
  const f = await fixture();
  let permit: WorkbenchExecutionPermit | undefined;
  let finish!: () => void;
  f.port.updateProject = (input, supplied) => new Promise((resolve, reject) => {
    permit = supplied;
    finish = () => { try { resolve(supplied.start(() => { f.writes.push(input); return f.projects.get('project-a')!; })); } catch (error) { reject(error); } };
  });
  const outgoing = request(f.address.baseUrl + WORKBENCH_PATHS.rpc, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Origin: f.origin, 'X-Workbench-Instance': f.sessions.instanceId, 'Content-Type': 'application/json', Authorization: `Bearer ${f.session.token}` } });
  outgoing.on('error', () => {});
  outgoing.end(JSON.stringify(f.update));
  await eventually(() => Boolean(permit));
  outgoing.destroy();
  await eventually(() => permit!.signal.aborted);
  finish();
  await eventually(() => f.transport.counts.requests === 0);
  assert.equal(f.writes.length, 0);
});


test('dispose waits for a pending start, concurrent disposal shares completion, and no listener survives', async () => {
  const sessions = new WorkbenchSessions({ instanceId: 'lifecycle-fixture' });
  const transport = new WorkbenchHttpTransport({ origin: 'http://127.0.0.1:5173', sessions,
    projectPort: { readProject: async () => { throw new Error('unused'); }, updateProject: async () => { throw new Error('unused'); } } });
  transports.push(transport);
  const starting = transport.start();
  const rejected = assert.rejects(starting, /unavailable/);
  const first = transport.dispose();
  assert.equal(transport.dispose(), first);
  await Promise.all([first, rejected]);
  assert.deepEqual(transport.counts, { requests: 0, streams: 0, sockets: 0 });
  assert.equal(transport.listening, false);
  await assert.rejects(transport.start(), /unavailable/);
});


test('duplicate authority, authentication and browser fetch metadata headers are rejected', async () => {
  const f = await fixture();
  for (const [name, value] of Object.entries({ Host: new URL(f.address.baseUrl).host, Origin: f.origin,
    Authorization: `Bearer ${f.session.token}`, 'X-Workbench-Instance': f.sessions.instanceId,
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })) {
    errorCode(await f.post(f.read, { headers: { [name]: [value, value] } }), 403, 'forbidden');
  }
});


test('incomplete raw TCP headers expire within a bounded connection-checking sweep', async () => {
  const f = await fixture({ requestTimeoutMs: 150 });
  const address = new URL(f.address.baseUrl);
  const socket = connect({ host: address.hostname, port: Number(address.port) });
  socket.on('error', () => {});
  socket.resume();
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write('POST /workbench/rpc HTTP/1.1\r\nHost: ' + address.host + '\r\nOrigin: ');
  try {
    // 150 ms deadline + at most 150 ms sweep; 300 ms scheduling margin.
    await Promise.race([closed, delay(600).then(() => { throw new Error('incomplete headers exceeded bounded sweep'); })]);
    assert.equal(socket.destroyed, true);
    await eventually(() => f.transport.counts.sockets === 0);
    assert.equal(f.writes.length, 0);
  } finally { socket.destroy(); }
});
