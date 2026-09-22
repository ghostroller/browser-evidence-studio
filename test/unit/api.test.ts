import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startApi, ApiOptions } from '../../src/main/api/server';

async function setup(dispatch: ApiOptions['dispatch']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-api-test-'));
  const api = await startApi({ root, dispatch });
  const connection = JSON.parse(await fs.readFile(api.connectionFile, 'utf8')) as { token: string; address: string };
  const call = (method: string, endpoint: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any; bytes: Buffer; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const serialized = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(`${api.address}${endpoint}`, { method, headers: { Authorization: `Bearer ${connection.token}`, ...(serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(serialized)) }), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { const bytes = Buffer.concat(chunks); let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = undefined; } resolve({ status: response.statusCode!, json: parsed, bytes, headers: response.headers }); });
    });
    req.on('error', reject); req.end(serialized);
  });
  return { root, api, connection, call, async cleanup() { await api.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function eventual<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 80; i++) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Asynchronous operation did not reach its expected state.');
}

test('loopback API protects its connection secret and rejects wrong auth, browser origin and host', async () => {
  const fixture = await setup(() => ({ healthy: true }));
  try {
    assert.ok(fixture.api.address.startsWith('http://127.0.0.1:'));
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(fixture.connection.token));
    assert.equal((await fixture.call('GET', '/v1/health')).status, 200);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { Authorization: '' })).status, 401);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { Authorization: `Bearer ${'x'.repeat(43)}` })).status, 401);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { Origin: 'null' })).status, 403);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { Host: 'untrusted.example' })).status, 403);
    assert.equal((await fixture.call('GET', '/v1/health', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await fixture.call('POST', '/v1/eval', { code: 'process.exit()' })).status, 404);
    const health = await fixture.call('GET', '/v1/health');
    assert.ok(!health.bytes.toString('utf8').includes(fixture.connection.token));
    await fixture.api.close();
    await assert.rejects(fs.access(fixture.api.connectionFile));
  } finally { await fixture.cleanup(); }
});

test('mutations return promptly and idempotency binds canonical body, route and verb without duplicate effects', async () => {
  let release!: (value: unknown) => void;
  const blocked = new Promise((resolve) => { release = resolve; });
  const calls: { method: string; body: Record<string, unknown>; source: string }[] = [];
  const fixture = await setup((method, body, source) => { calls.push({ method, body, source }); return blocked; });
  try {
    const first = await fixture.call('POST', '/v1/projects', { name: 'Synthetic', objective: 'test' }, { 'Idempotency-Key': 'same-operation' });
    assert.equal(first.status, 202); assert.ok(first.json.jobId);
    const duplicate = await fixture.call('POST', '/v1/projects', { objective: 'test', name: 'Synthetic' }, { 'Idempotency-Key': 'same-operation' });
    assert.equal(duplicate.json.jobId, first.json.jobId);
    const conflict = await fixture.call('POST', '/v1/projects', { name: 'Different' }, { 'Idempotency-Key': 'same-operation' });
    assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await fixture.call('POST', '/v1/runs', { name: 'Synthetic', objective: 'test' }, { 'Idempotency-Key': 'same-operation' })).status, 409);
    const running = await fixture.call('GET', `/v1/jobs/${first.json.jobId}`);
    assert.equal(running.json.status, 'running'); assert.equal(calls.length, 1); assert.equal(calls[0].source, 'api');
    release({ id: 'created-project' });
    const complete = await eventual(() => fixture.call('GET', `/v1/jobs/${first.json.jobId}`), (response) => response.json.status === 'succeeded');
    assert.deepEqual(complete.json.result, { id: 'created-project' });
  } finally { release({}); await fixture.cleanup(); }
});

test('body and lease checks reject invalid input before dispatch and path identity overrides body', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fixture = await setup((method, body) => { calls.push({ method, body }); return { saved: true }; });
  try {
    assert.equal((await fixture.call('POST', '/v1/projects', { name: 'x'.repeat(65536) })).status, 413);
    assert.equal((await fixture.call('POST', '/v1/projects', '{invalid')).status, 400);
    assert.equal((await fixture.call('POST', '/v1/projects', [])).status, 400);
    assert.equal((await fixture.call('POST', '/v1/projects', { name: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fixture.call('POST', '/v1/runs/run-1/actions', { type: 'click' })).status, 409);
    assert.equal((await fixture.call('POST', '/v1/runs/run-1/inspect', { leaseEpoch: 3, enabled: true })).status, 404);
    assert.equal((await fixture.call('POST', '/v1/runs/run-1/pause', { leaseEpoch: 3 })).status, 404);
    assert.equal(calls.length, 0);
    const started = await fixture.call('POST', '/v1/runs/run-1/actions', { runId: 'other-run', leaseEpoch: 3, pageId: 'page-1', type: 'click', selector: '#safe' });
    assert.equal(started.status, 202);
    await eventual(() => fixture.call('GET', `/v1/jobs/${started.json.jobId}`), (response) => response.json.status === 'succeeded');
    assert.equal(calls[0].body.runId, 'run-1'); assert.equal(calls[0].method, 'action');
    assert.equal((await fixture.call('GET', '/v1/runs/run-1/events?maxBytes=-1')).status, 400);
    assert.equal((await fixture.call('GET', '/v1/runs/run-1/events?limit=1&limit=2')).status, 400);
    assert.equal((await fixture.call('GET', '/v1/runs/run-1/events?__proto__=evil')).status, 400);
  } finally { await fixture.cleanup(); }
});

test('evidence reader cursors remain unwrapped and binary content is a separate safe response', async () => {
  const fixture = await setup((method, body) => method === 'artifactContent' ? { binary: Buffer.from([137, 80, 78, 71]), mediaType: 'image/png' } : { items: [{ id: 'evt-1' }], nextCursor: 'bounded-next', outputTruncated: true, options: body });
  try {
    const events = await fixture.call('GET', '/v1/runs/run-1/events?maxBytes=4096&fields=type,data.url&cursor=previous');
    assert.equal(events.status, 200); assert.equal(events.json.nextCursor, 'bounded-next');
    assert.deepEqual(events.json.options.fields, ['type', 'data.url']); assert.equal(events.json.options.maxBytes, 4096);
    const binary = await fixture.call('GET', '/v1/runs/run-1/artifacts/art-000000000001/content');
    assert.equal(binary.status, 200); assert.equal(binary.headers['content-type'], 'image/png');
    assert.equal(binary.headers['content-disposition'], 'attachment'); assert.equal(binary.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual([...binary.bytes], [137, 80, 78, 71]);
  } finally { await fixture.cleanup(); }
});

test('job cancellation remains pending until runner stop is confirmed; dispatch failures stay failures', async () => {
  let stop!: () => void;
  const stopping = new Promise<void>((resolve) => { stop = resolve; });
  const fixture = await setup((method) => {
    if (method === 'startRun') return new Promise(() => undefined);
    if (method === 'cancelJob') return stopping;
    throw Object.assign(new Error('Synthetic validation failure'), { code: 'SYNTHETIC_FAILURE', status: 422 });
  });
  try {
    const started = await fixture.call('POST', '/v1/runs', { projectId: 'synthetic' });
    const cancelling = await fixture.call('POST', `/v1/jobs/${started.json.jobId}/cancel`, {});
    assert.equal(cancelling.status, 202); assert.equal(cancelling.json.cancellationRequested, true); assert.equal(cancelling.json.status, 'running');
    stop();
    const cancelled = await eventual(() => fixture.call('GET', `/v1/jobs/${started.json.jobId}`), (response) => response.json.status === 'cancelled');
    assert.equal(cancelled.json.status, 'cancelled');
    const failed = await fixture.call('POST', '/v1/projects', { name: 'error' });
    const failedJob = await eventual(() => fixture.call('GET', `/v1/jobs/${failed.json.jobId}`), (response) => response.json.status === 'failed');
    assert.equal(failedJob.json.error.code, 'SYNTHETIC_FAILURE'); assert.equal(failedJob.json.error.status, 422);
  } finally { stop(); await fixture.cleanup(); }
});

test('large job outputs preserve artifact references and oversized direct responses fail within 32 KiB', async () => {
  const fixture = await setup((method) => method === 'createProject' ? { id: 'project-id', runId: 'run-id', artifactId: 'art-000000000001', large: '中'.repeat(20000) } : { large: '中'.repeat(20000) });
  try {
    const started = await fixture.call('POST', '/v1/projects', { name: 'large output' });
    const result = await eventual(() => fixture.call('GET', `/v1/jobs/${started.json.jobId}`), (response) => response.json.status === 'succeeded');
    assert.ok(result.bytes.length <= 32768);
    assert.equal(result.json.result.outputTruncated, true);
    assert.equal(result.json.result.references.artifactId, 'art-000000000001');
    const direct = await fixture.call('GET', '/v1/projects');
    assert.equal(direct.status, 413); assert.ok(direct.bytes.length <= 32768);
  } finally { await fixture.cleanup(); }
});
