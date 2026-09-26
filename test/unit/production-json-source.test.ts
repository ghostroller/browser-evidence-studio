import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { CaptureCoordinator } from '@/capture/coordinator';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';

test('production JSON response keeps the observed page and header time when body persistence is delayed', async () => {
  const store = await EvidenceStore.create(path.resolve('output/q1-json-tests', randomUUID()), {
    id: 'recording', projectId: 'synthetic', kind: 'demonstrate', mode: 'synthetic', objective: 'JSON source identity',
  });
  const cdp = new EventEmitter() as EventEmitter & { send: (method: string, args?: unknown) => Promise<any> };
  let releaseBody!: () => void;
  const delayedBody = new Promise<void>(resolve => { releaseBody = resolve; });
  cdp.send = async method => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
    if (method === 'Network.getResponseBody') { await delayedBody; return { body: '{"value":"correct"}', base64Encoded: false }; }
    return { result: {} };
  };
  const identity = { pageId: 'managed-page', targetId: 'managed-target', webContentsId: 1, navigationGeneration: 2 };
  const capture = new CaptureCoordinator({ createCDPSession: async () => cdp } as unknown as Page, identity, store);
  try {
    await capture.start();
    cdp.emit('Network.requestWillBeSent', { requestId: '42', request: { url: 'https://fixture.test/orders', method: 'GET' }, frameId: 'main', loaderId: 'loader', timestamp: 1 });
    const beforeHeaders = Date.now();
    cdp.emit('Network.responseReceived', { requestId: '42', response: { url: 'https://fixture.test/orders', mimeType: 'application/json', headers: {} } });
    const afterHeaders = Date.now();
    cdp.emit('Network.loadingFinished', { requestId: '42', encodedDataLength: 19 });
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseBody();
    await capture.flush();
    const reader = new EvidenceReader(store.runDir);
    const records = await reader.artifacts({ limit: 30, maxBytes: 32768 });
    const response = records.items.find((item: any) => item.kind === 'response-body' && item.captureStatus === 'complete') as any;
    assert.ok(response, 'CaptureCoordinator must persist the complete JSON response body');
    assert.equal(response.source.pageId, identity.pageId);
    assert.equal(response.source.targetId, identity.targetId);
    assert.equal(response.source.recordingId, store.manifest.id);
    assert.equal(response.source.frameId, 'main');
    assert.equal(response.source.loaderId, 'loader');
    assert.equal(response.source.navigationGeneration, 2);
    assert.ok(response.source.requestKey.includes('/42/'));
    assert.ok(Date.parse(response.source.responseObservedAt) >= beforeHeaders);
    assert.ok(Date.parse(response.source.responseObservedAt) <= afterHeaders);
  } finally { releaseBody(); await capture.flush(); await store.close(); }
});
