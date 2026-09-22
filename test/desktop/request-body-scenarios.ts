import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '../../src/main/services/studio';
import type { Artifact, QueryPage } from '../../src/evidence/contracts';
import { jsonLines, safeFile } from '../../src/evidence/files';

const credentialSentinel = 'BES-REQUEST-CREDENTIAL-SENTINEL';
const variants = ['complete', 'large', 'truncated', 'credential', 'binary', 'multipart', 'no-body'] as const;
type Variant = typeof variants[number];

async function pages(read: (cursor?: string) => Promise<QueryPage>): Promise<any[]> {
  const result: unknown[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await read(cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768, 'Request scenario list reads must obey their full response budget');
    assert.ok(page.items.every((item: any) => !item.readStatus), 'The scenario must not silently ignore oversized metadata references');
    result.push(...page.items);
    if (!page.nextCursor) return result;
    assert.notEqual(page.nextCursor, cursor, 'Request scenario cursors must advance');
    cursor = page.nextCursor;
  }
  throw new Error('Short request-body scenario exceeded its 50-page evidence budget');
}

/** Real Chromium requests; no response reflects request content or credential sentinels. */
export async function runRequestBodyScenarios(studio: Studio, url: string): Promise<void> {
  const origin = new URL(url).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Request-body regression only operates on its local synthetic fixture');
  if (studio.active) await studio.seal();
  const project = await studio.createProject({ name: '请求正文完整性回归', objective: '真实 POST、正文预算、凭据排除和有界回读' });
  const profile = await studio.createProfile({ projectId: project.id, name: '请求正文独立合成环境' });
  await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${origin}/lab` });
  const run = studio.required(), page = studio.current(), reader = studio.reader(run.id);
  await studio.control('agent');
  await studio.action({ type: 'scroll', x: 0, y: 0, pageId: page.pageId, generation: page.navigationGeneration, leaseEpoch: run.leaseEpoch });
  assert.ok(run.operation, 'POST fixture writes must use the managed operation connection');
  const bodies = new Map<Variant, Artifact>();

  for (const variant of variants) {
    assert.equal(run.controller, 'agent');
    assert.equal(new URL(page.page.url()).origin, origin);
    const requestUrl = `${origin}/api/request-body?case=${variant}`;
    const result: { status: number; summary: { marker: string; receivedBytes: number; limitBytes: number }; expectedBytes?: number } = await run.operation.page.evaluate(async ({ variant, requestUrl, credentialSentinel }) => {
      let body: BodyInit | undefined;
      const headers: Record<string, string> = {};
      let expectedBytes: number | undefined;
      if (variant === 'complete') {
        body = JSON.stringify({ entityId: 'REQUEST-ENTITY-17', text: '甲🙂乙', nullable: null });
        headers['content-type'] = 'application/json; charset=utf-8';
      } else if (variant === 'large') {
        const envelope = { entityId: 'REQUEST-LARGE-1', payload: '', tailMarker: 'REQUEST-END' };
        envelope.payload = 'x'.repeat(1024 * 1024 - new TextEncoder().encode(JSON.stringify(envelope)).byteLength);
        body = JSON.stringify(envelope); headers['content-type'] = 'application/json';
      } else if (variant === 'truncated') {
        const prefix = '甲🙂';
        body = prefix + 'x'.repeat(9 * 1024 * 1024 - new TextEncoder().encode(prefix).byteLength);
        headers['content-type'] = 'text/plain; charset=utf-8';
      } else if (variant === 'credential') {
        body = JSON.stringify({ password: credentialSentinel }); headers['content-type'] = 'application/json';
      } else if (variant === 'binary') {
        body = new Uint8Array([0, 1, 2, 255]); headers['content-type'] = 'application/octet-stream'; expectedBytes = 4;
      } else if (variant === 'multipart') {
        const form = new FormData(); form.append('file', new Blob(['synthetic-file-content'], { type: 'text/plain' }), 'synthetic.txt'); body = form;
      } else expectedBytes = 0;
      if (typeof body === 'string') expectedBytes = new TextEncoder().encode(body).byteLength;
      const response = await fetch(requestUrl, { method: variant === 'no-body' ? 'GET' : 'POST', headers, body });
      return { status: response.status, summary: await response.json(), expectedBytes };
    }, { variant, requestUrl, credentialSentinel });
    assert.equal(result.status, 200, variant);
    assert.equal(result.summary.marker, 'request-body-sink');
    assert.ok(!JSON.stringify(result.summary).includes(credentialSentinel), 'The fixture must never echo synthetic credentials');
    if (result.expectedBytes !== undefined) assert.equal(result.summary.receivedBytes, result.expectedBytes, `${variant} upload must fully reach the sink`);
    else assert.ok(result.summary.receivedBytes > 0);

    const deadline = Date.now() + 15_000;
    let found: any;
    while (Date.now() < deadline) {
      await page.capture.flush();
      const listed = await pages(cursor => reader.artifacts({ cursor, limit: 3, maxBytes: 32768, fields: ['kind', 'source', 'captureStatus'] }));
      const matching = listed.filter(artifact => artifact.kind === 'request-body' && artifact.source?.url === requestUrl);
      assert.ok(matching.length <= 1, `One request must not produce duplicate ${variant} body artifacts`);
      if (matching[0]) { found = matching[0]; break; }
      await delay(50);
    }
    assert.ok(found, `No persisted request-body artifact for ${variant}`);
    bodies.set(variant, await reader.artifactMetadata(found.id));
  }
  await page.capture.flush();
  await studio.seal();

  const complete = bodies.get('complete')!, large = bodies.get('large')!, truncated = bodies.get('truncated')!;
  for (const artifact of [complete, large]) assert.equal(artifact.captureStatus, 'complete');
  const entity = await reader.artifact(complete.id, { jsonPath: '$.entityId', maxBytes: 1024 });
  assert.equal(entity.value, 'REQUEST-ENTITY-17'); assert.ok(Buffer.byteLength(JSON.stringify(entity)) <= 1024);
  assert.equal((await reader.artifact(complete.id, { jsonPath: '$.text', maxBytes: 1024 })).value, '甲🙂乙');
  assert.equal((await reader.artifact(complete.id, { jsonPath: '$.nullable', maxBytes: 1024 })).value, null);
  assert.equal(large.capturedBytes, 1024 * 1024);
  const tail = await reader.artifact(large.id, { jsonPath: '$.tailMarker', maxBytes: 1024 });
  assert.equal(tail.value, 'REQUEST-END'); assert.ok(Buffer.byteLength(JSON.stringify(tail)) <= 1024);
  assert.equal(truncated.captureStatus, 'truncated'); assert.equal(truncated.originalBytes, 9 * 1024 * 1024);
  assert.equal(truncated.capturedBytes, 8 * 1024 * 1024); assert.equal(truncated.limitBytes, 8 * 1024 * 1024);
  assert.equal(truncated.metadata?.acquiredBy, 'getRequestPostData', 'A request larger than maxPostDataSize must exercise real CDP fallback');
  const first = await reader.artifact(truncated.id, { maxBytes: 2048 });
  assert.ok(String(first.text).startsWith('甲🙂')); assert.equal(first.outputTruncated, true); assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const second = await reader.artifact(truncated.id, { maxBytes: 2048, cursor: String(first.nextCursor) });
  assert.equal(second.byteOffset, first.readBytes); assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 2048);
  for (const variant of ['credential', 'binary', 'multipart'] as const) {
    const artifact = bodies.get(variant)!;
    assert.equal(artifact.captureStatus, 'excluded', variant); assert.equal(artifact.path, undefined); assert.equal(artifact.capturedBytes, 0);
    assert.equal((await reader.artifact(artifact.id, { maxBytes: 1024 })).bodyStatus, 'excluded');
  }
  assert.equal(bodies.get('credential')!.reason, 'credential-bearing-request-body');
  assert.equal(bodies.get('no-body')!.captureStatus, 'not-applicable'); assert.equal(bodies.get('no-body')!.path, undefined);

  const events = await pages(cursor => reader.events({ cursor, limit: 3, maxBytes: 32768, types: ['network-request', 'network-request-body', 'gap'], fields: ['type', 'pageId', 'navigationGeneration', 'data', 'artifactRefs'] }));
  for (const [variant, artifact] of bodies) {
    const source = artifact.source as Record<string, unknown>;
    assert.equal(source.pageId, page.pageId); assert.equal(source.targetId, page.targetId); assert.ok(source.frameId); assert.ok(source.loaderId);
    const requestEvent = events.find(event => event.type === 'network-request' && event.data?.requestKey === source.requestKey);
    assert.ok(requestEvent, `${variant} must retain its observed request event`);
    assert.equal(requestEvent.data.requestBodyArtifactId, artifact.id); assert.ok(requestEvent.artifactRefs.includes(artifact.id));
    assert.equal(requestEvent.navigationGeneration, source.navigationGeneration);
    assert.ok(!Object.hasOwn(requestEvent.data.request, 'postData')); assert.ok(!Object.hasOwn(requestEvent.data.request, 'postDataEntries'));
    const bodyEvent = events.find(event => event.type === 'network-request-body' && event.data?.requestKey === source.requestKey);
    assert.equal(bodyEvent?.data.captureStatus, artifact.captureStatus); assert.ok(bodyEvent?.artifactRefs.includes(artifact.id));
  }
  assert.ok(events.some(event => event.type === 'gap' && event.data?.requestKey === (truncated.source as any).requestKey && event.data.captureStatus === 'truncated'));

  let scannedBytes = 0;
  const rawRequestReferences = new Set<string>();
  for (const directory of ['raw/cdp', 'journal']) {
    for (const filename of (await readdir(path.join(reader.runDir, directory))).filter(name => name.endsWith('.jsonl'))) {
      for await (const line of jsonLines(await safeFile(reader.runDir, `${directory}/${filename}`))) {
        scannedBytes += line.bytes;
        assert.ok(scannedBytes < 32 * 1024 * 1024, 'Synthetic metadata must not contain duplicate 9 MiB request bodies');
        assert.ok(!line.invalid && line.value, 'Request-body raw/event evidence must remain readable');
        const serialized = JSON.stringify(line.value);
        assert.ok(!serialized.includes(credentialSentinel), 'Credential body must never be duplicated in raw or events');
        assert.ok(!/"postData(?:Entries)?"\s*:/.test(serialized), 'Raw and event records must reference request artifacts instead of inlining bodies');
        const raw = line.value.payload as any;
        if (raw?.method === 'Network.requestWillBeSent' && String(raw.request?.url).startsWith(`${origin}/api/request-body?case=`)) rawRequestReferences.add(raw.requestBodyArtifactId);
      }
    }
  }
  assert.deepEqual([...rawRequestReferences].sort(), [...bodies.values()].map(artifact => artifact.id).sort());
  console.log('M1 request body PASS: real UTF-8 JSON, 1 MiB complete, 9 MiB CDP fallback/truncation, credential/binary/multipart exclusions, source references and bounded readback');
}
