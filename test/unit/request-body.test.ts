import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureRequestBody, requestMetadata, type NetworkRequest } from '@/capture/request-body';
import { RequestLedger } from '@/capture/request-ledger';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';

const request = (input: Partial<NetworkRequest> = {}): NetworkRequest => ({ method: 'POST', url: 'https://synthetic.invalid/submit', headers: { 'Content-Type': 'application/json' }, ...input });

function capture(input: NetworkRequest, options: { ledger?: RequestLedger; response?: Promise<{ postData?: string; base64Encoded?: boolean }>; limitBytes?: number; timeoutMs?: number } = {}) {
  const ledger = options.ledger ?? new RequestLedger('session', 'target');
  const current = ledger.begin({ requestId: 'request-1', url: input.url, redirect: false }).current;
  const calls: string[] = [];
  const cdp = { send(method: string, body: { requestId: string }) { calls.push(method); assert.equal(body.requestId, current.requestId); return options.response ?? Promise.resolve({}); } };
  const result = captureRequestBody(input, {
    source: { requestKey: current.key, url: current.url, frameId: 'main', loaderId: 'loader', pageId: 'page', targetId: 'target' },
    acquireRead: () => ledger.acquireBodyRead(current), readPostData: () => cdp.send('Network.getRequestPostData', { requestId: current.requestId }),
    limitBytes: options.limitBytes, timeoutMs: options.timeoutMs,
  });
  return { ledger, current, calls, result };
}

async function storeFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-request-body-'));
  const store = await EvidenceStore.create(directory, { id: 'request-fixture', projectId: 'synthetic', kind: 'demonstrate', mode: 'synthetic', objective: 'Request body integrity and attribution' });
  return { directory, store, reader: new EvidenceReader(directory), async close() { await store.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('request artifacts distinguish absent, observed empty, missing CDP data and failed reads', async () => {
  const fixture = await storeFixture();
  try {
    const absent = capture(request({ method: 'GET', hasPostData: false }));
    const empty = capture(request({ hasPostData: true, postData: '' }));
    const missing = capture(request({ hasPostData: true }));
    const failure = capture(request({ hasPostData: true }), { response: Promise.reject(new Error('password=do-not-save-this-error')) });
    for (const [result, expected] of [[absent, 'not-applicable'], [empty, 'empty'], [missing, 'missing'], [failure, 'read-failed']] as const) {
      const artifact = await fixture.store.putArtifact(await result.result);
      assert.equal(artifact.kind, 'request-body');
      assert.equal(artifact.captureStatus, expected);
      assert.equal((artifact.source as Record<string, unknown>).requestKey, result.current.key);
      if (expected === 'empty') { assert.equal(artifact.originalBytes, 0); assert.equal((await fixture.reader.artifact(artifact.id)).text, ''); }
      else assert.equal(artifact.path, undefined);
      assert.ok(!JSON.stringify(artifact).includes('do-not-save-this-error'));
    }
    assert.deepEqual(absent.calls, []); assert.deepEqual(empty.calls, []);
    assert.deepEqual(missing.calls, ['Network.getRequestPostData']);
  } finally { await fixture.close(); }
});

test('request body limits count UTF-8 bytes and do not split a code point', async () => {
  const fixture = await storeFixture();
  try {
    const original = '甲🙂乙';
    const complete = await fixture.store.putArtifact(await capture(request({ postData: original }), { limitBytes: 10 }).result);
    assert.equal(complete.captureStatus, 'complete'); assert.equal(complete.capturedBytes, 10);
    const partial = await fixture.store.putArtifact(await capture(request({ postData: original }), { limitBytes: 5 }).result);
    assert.equal(partial.captureStatus, 'truncated'); assert.equal(partial.originalBytes, 10); assert.equal(partial.capturedBytes, 3);
    assert.equal(partial.limitBytes, 5); assert.equal(partial.reason, 'capture-byte-limit');
    assert.equal((await fixture.reader.artifact(partial.id)).text, '甲');
    const fetched = await fixture.store.putArtifact(await capture(request({ hasPostData: true }), { limitBytes: 5, response: Promise.resolve({ postData: original }) }).result);
    assert.equal(fetched.captureStatus, 'truncated'); assert.equal(fetched.originalBytes, 10);
    assert.equal((await fixture.reader.artifact(fetched.id)).text, '甲');
    const short = await fixture.store.putArtifact(await capture(request({ postData: '{}', headers: { 'content-type': 'application/json', 'content-length': '20' } })).result);
    assert.equal(short.captureStatus, 'truncated'); assert.equal(short.metadata?.declaredBytes, 20);
    assert.equal(short.reason, 'request-body-shorter-than-content-length');
  } finally { await fixture.close(); }
});

test('credential bodies are excluded before truncation and never copied through request metadata', async () => {
  const fixture = await storeFixture();
  try {
    for (const postData of ['{"password":"credential-sentinel"}', 'pass%77ord=credential-sentinel', 'pass%77ord=credential-sentinel&broken=%ZZ', '{"pass\\u0077ord":"credential-sentinel"}', 'x'.repeat(100) + 'access_token=credential-sentinel']) {
      const input = request({ postData, postDataEntries: [{ bytes: Buffer.from(postData).toString('base64') }], headers: { Authorization: 'credential-sentinel', 'Content-Type': 'application/json' } });
      const result = await capture(input, { limitBytes: 4 }).result;
      const artifact = await fixture.store.putArtifact(result);
      assert.equal(artifact.captureStatus, 'excluded'); assert.equal(artifact.reason, 'credential-bearing-request-body');
      assert.equal(artifact.path, undefined); assert.equal(artifact.capturedBytes, 0);
      const metadata = requestMetadata(input);
      assert.ok(!Object.hasOwn(metadata, 'postData')); assert.ok(!Object.hasOwn(metadata, 'postDataEntries'));
      const stored = { request: metadata, requestBodyArtifactId: artifact.id };
      assert.ok(!JSON.stringify(stored).includes('credential-sentinel'));
      await fixture.store.appendRaw('cdp', stored);
      await fixture.store.appendEvent({ type: 'network-request', source: 'cdp', data: stored, artifactRefs: [artifact.id] });
    }
    const fetched = await capture(request({ hasPostData: true }), { response: Promise.resolve({ postData: '{"api_key":"credential-sentinel"}' }) }).result;
    assert.equal(fetched.captureStatus, 'excluded'); assert.equal(fetched.data, undefined);
    await fixture.store.flush();
    for (const directory of ['journal', 'raw/cdp']) {
      for (const file of await fs.readdir(path.join(fixture.directory, directory))) assert.ok(!(await fs.readFile(path.join(fixture.directory, directory, file), 'utf8')).includes('credential-sentinel'));
    }
  } finally { await fixture.close(); }
});

test('multipart, binary and unsupported text encodings are explicit policy exclusions', async () => {
  for (const contentType of ['multipart/form-data; boundary=synthetic', 'application/octet-stream', 'text/plain; charset=ISO-8859-1']) {
    const result = capture(request({ hasPostData: true, postDataEntries: [{ bytes: 'c2VjcmV0' }], headers: { 'Content-Type': contentType } }));
    const body = await result.result;
    assert.equal(body.captureStatus, 'excluded'); assert.equal(body.data, undefined); assert.deepEqual(result.calls, []);
  }
});

test('CDP base64 request text is decoded before budgeting and credential exclusion', async () => {
  const fixture = await storeFixture();
  try {
    const encoded = (postData: string) => Promise.resolve({ postData: Buffer.from(postData).toString('base64'), base64Encoded: true });
    const text = await fixture.store.putArtifact(await capture(request({ hasPostData: true }), { response: encoded('甲🙂乙'), limitBytes: 5 }).result);
    assert.equal(text.captureStatus, 'truncated'); assert.equal(text.originalBytes, 10);
    assert.equal((await fixture.reader.artifact(text.id)).text, '甲');
    const credentials = await capture(request({ hasPostData: true }), { response: encoded('{"password":"base64-secret"}') }).result;
    assert.equal(credentials.captureStatus, 'excluded'); assert.equal(credentials.data, undefined);
    const binary = await capture(request({ hasPostData: true }), { response: Promise.resolve({ postData: '/w==', base64Encoded: true }) }).result;
    assert.equal(binary.captureStatus, 'excluded'); assert.equal(binary.reason, 'request-body-is-not-utf8-text');
    const malformed = await capture(request({ hasPostData: true }), { response: Promise.resolve({ postData: '%not-base64', base64Encoded: true }) }).result;
    assert.equal(malformed.captureStatus, 'read-failed'); assert.equal(malformed.data, undefined);
  } finally { await fixture.close(); }
});

test('fallback reads start immediately and retain source identity after ordinary request completion', async () => {
  let resolve!: (value: { postData: string }) => void;
  const result = capture(request({ hasPostData: true }), { response: new Promise(done => { resolve = done; }) });
  assert.deepEqual(result.calls, ['Network.getRequestPostData']);
  result.ledger.finish(result.current.requestId);
  resolve({ postData: '{"entity":"order-17"}' });
  const body = await result.result;
  assert.equal(body.data, '{"entity":"order-17"}'); assert.equal(body.metadata?.acquiredBy, 'getRequestPostData');
  assert.equal((body.source as Record<string, unknown>).requestKey, result.current.key);
});

test('redirect, reuse after completion, pause and eviction discard late fallback bodies', async () => {
  for (const change of ['redirect', 'reuse', 'pause', 'evict'] as const) {
    let resolve!: (value: { postData: string }) => void;
    const ledger = new RequestLedger('session', 'target', 1);
    const result = capture(request({ hasPostData: true }), { ledger, response: new Promise(done => { resolve = done; }) });
    if (change === 'reuse') ledger.finish(result.current.requestId);
    if (change === 'pause') ledger.reset();
    else ledger.begin({ requestId: change === 'evict' ? 'other-request' : result.current.requestId, url: '/different-request', redirect: change === 'redirect' });
    resolve({ postData: '{"wrongEntity":"must-never-be-persisted"}' });
    const body = await result.result;
    assert.equal(body.captureStatus, 'missing', change); assert.equal(body.data, undefined, change);
    assert.equal((body.source as Record<string, unknown>).requestKey, result.current.key);
    assert.match(body.reason!, /during-body-read/);
  }
});

test('a timed-out body read returns explicit failure and never adopts a late body', async () => {
  let resolve!: (value: { postData: string }) => void;
  const result = capture(request({ hasPostData: true }), { timeoutMs: 5, response: new Promise(done => { resolve = done; }) });
  const body = await result.result;
  assert.equal(body.captureStatus, 'read-failed'); assert.equal(body.reason, 'request-body-read-timeout');
  resolve({ postData: 'late' });
  await Promise.resolve();
  assert.equal(body.data, undefined);
  const next = result.ledger.acquireBodyRead(result.current);
  assert.equal(next.invalidated, undefined); next.release();
});
