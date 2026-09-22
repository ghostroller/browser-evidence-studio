import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader, selectJson } from '@/evidence/reader';
import { CaptureStatus, EvidenceError } from '@/evidence/contracts';

async function fixture(options?: Parameters<typeof EvidenceStore.create>[2]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-evidence-test-'));
  const store = await EvidenceStore.create(directory, { id: 'synthetic-run', projectId: 'synthetic-project', kind: 'demonstrate', mode: 'synthetic', objective: 'Evidence reliability fixture', versions: { node: process.version } }, options);
  return { directory, store, reader: new EvidenceReader(directory), async cleanup() { await store.close().catch(() => undefined); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('serialized confirmed writes survive reopen, chunk rotation, seal and index rebuilding with stable IDs', async () => {
  const fixtureRun = await fixture({ chunkBytes: 512 });
  const { store, directory, reader } = fixtureRun;
  try {
    const events = await Promise.all(Array.from({ length: 40 }, (_, number) => store.appendEvent({ type: 'action', source: 'synthetic', data: { number } })));
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 40 }, (_, number) => number + 1));
    assert.ok((await fs.readdir(path.join(directory, 'journal'))).length > 1);
    await store.flush();
    const before = await reader.events({ limit: 2 });
    assert.ok(before.nextCursor);
    await store.close();
    const reopened = await EvidenceStore.open(directory);
    assert.equal(reopened.manifest.status, 'interrupted');
    assert.ok((await reader.gaps()).items.length);
    const recovered = await reader.events({ limit: 100, maxBytes: 32768, fields: ['id'] });
    assert.deepEqual(recovered.items.slice(0, 40).map((event) => (event as { id: string }).id), events.map((event) => event.id));
    await assert.rejects(reader.events({ cursor: before.nextCursor }), (error: EvidenceError) => error.code === 'STALE_CURSOR');
    await reopened.seal();
    await assert.rejects(reopened.appendEvent({ type: 'forbidden', source: 'test' }), (error: EvidenceError) => error.code === 'RUN_SEALED');
    await reopened.close();
    const afterSeal = await reader.events({ limit: 100, maxBytes: 32768, fields: ['id'] });
    await reader.rebuildIndex();
    const afterRebuild = await reader.events({ limit: 100, maxBytes: 32768, fields: ['id'] });
    assert.deepEqual(afterSeal.items, afterRebuild.items);
  } finally { await fixtureRun.cleanup(); }
});

test('capture states distinguish absent bytes, empty bytes and a truncated original', async () => {
  const f = await fixture();
  try {
    const states: CaptureStatus[] = ['missing', 'read-failed', 'not-applicable', 'excluded', 'unknown'];
    for (const state of states) {
      const artifact = await f.store.putArtifact({ kind: 'response', mediaType: 'application/json', captureStatus: state, reason: `synthetic-${state}` });
      const read = await f.reader.artifact(artifact.id);
      assert.equal((read.artifact as { captureStatus: string }).captureStatus, state);
      assert.equal(read.bodyStatus, state);
    }
    const empty = await f.store.putArtifact({ kind: 'response', mediaType: 'text/plain', data: '' });
    const truncated = await f.store.putArtifact({ kind: 'response', mediaType: 'text/plain', data: 'abcdef', limitBytes: 3 });
    assert.equal(empty.captureStatus, 'empty');
    assert.equal(truncated.captureStatus, 'truncated');
    assert.equal(truncated.originalBytes, 6);
    assert.equal((await f.reader.artifact(empty.id)).text, '');
    assert.equal((await f.reader.artifact(truncated.id)).text, 'abc');
    const unicodeLimit = await f.store.putArtifact({ kind: 'dom', mediaType: 'text/html', data: '中🙂文', limitBytes: 5 });
    assert.equal(unicodeLimit.captureStatus, 'truncated');
    assert.equal((await f.reader.artifact(unicodeLimit.id)).text, '中');
    const largeTruncated = await f.store.putArtifact({ kind: 'response', mediaType: 'text/plain', data: Buffer.alloc(40 * 1024 * 1024, 'x'), limitBytes: 1024 });
    assert.equal(largeTruncated.captureStatus, 'truncated');
    assert.equal(largeTruncated.originalBytes, 40 * 1024 * 1024);
    assert.equal(largeTruncated.capturedBytes, 1024);
    await assert.rejects(f.store.putArtifact({ kind: 'dom', mediaType: 'text/html', captureStatus: 'complete' }), (error: EvidenceError) => error.code === 'INVALID_CAPTURE_STATUS');
    const metadataOnly = await f.store.putArtifact({ kind: 'image', mediaType: 'image/png', captureStatus: 'excluded' });
    await assert.rejects(f.reader.artifactFile(metadataOnly.id), (error: EvidenceError) => error.code === 'ARTIFACT_UNAVAILABLE');
  } finally { await f.cleanup(); }
});

test('large JSON and HTML remain complete while query output obeys UTF-8 and serialized byte budgets', async () => {
  const f = await fixture();
  try {
    const large = { nullable: null, text: '中文🙂\\"\n'.repeat(70000), identity: { entity: 'synthetic-entity-17' } };
    const artifact = await f.store.putArtifact({ kind: 'response', mediaType: 'application/json', data: JSON.stringify(large) });
    assert.ok(artifact.capturedBytes >= 1024 * 1024);
    assert.equal(artifact.captureStatus, 'complete');
    assert.deepEqual((await f.reader.artifact(artifact.id, { jsonPath: '/nullable' })).value, null);
    assert.equal((await f.reader.artifact(artifact.id, { jsonPath: '/nullable' })).pathStatus, 'present');
    assert.equal((await f.reader.artifact(artifact.id, { jsonPath: '/absent' })).pathStatus, 'missing');
    assert.equal((await f.reader.artifact(artifact.id, { jsonPath: '$.identity.entity' })).value, 'synthetic-entity-17');
    const text = '甲🙂乙\\"\n'.repeat(900), small = await f.store.putArtifact({ kind: 'dom', mediaType: 'text/html', data: text });
    let cursor: string | undefined, combined = '', pageCount = 0;
    do {
      const response = await f.reader.artifact(small.id, { maxBytes: 1200, cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 1200);
      assert.equal(response.responseBytes, Buffer.byteLength(JSON.stringify(response)));
      assert.ok(!(response.text as string).includes('\ufffd'));
      combined += response.text;
      cursor = response.nextCursor as string | undefined;
      pageCount++;
    } while (cursor);
    assert.equal(combined, text);
    assert.ok(pageCount > 1);
    const html = await f.store.putArtifact({ kind: 'dom', mediaType: 'text/html', data: `<html><script type="application/json">${JSON.stringify({ embedded: 'x'.repeat(375 * 1024) })}</script></html>` });
    assert.ok(html.capturedBytes > 375 * 1024);
    assert.equal(html.captureStatus, 'complete');
    await assert.rejects(f.reader.artifact(artifact.id, { jsonPath: '$..[bad]' }), (error: EvidenceError) => error.code === 'INVALID_JSON_PATH');
  } finally { await f.cleanup(); }
});

test('JSON selection never confuses null, missing, array bounds or inherited properties', () => {
  assert.deepEqual(selectJson({ nullable: null }, '/nullable'), { pathStatus: 'present', value: null });
  assert.deepEqual(selectJson({ nullable: null }, '/nullable/name'), { pathStatus: 'missing' });
  assert.deepEqual(selectJson({ items: ['a'] }, '$.items[1]'), { pathStatus: 'missing' });
  assert.deepEqual(selectJson({}, '/toString'), { pathStatus: 'missing' });
  assert.deepEqual(selectJson({ 'a/b': { '~': null } }, '/a~1b/~0'), { pathStatus: 'present', value: null });
});

test('incomplete tails are preserved, reported as gaps and never absorb a later record', async () => {
  const f = await fixture();
  try {
    const event = await f.store.appendEvent({ type: 'before-crash', source: 'synthetic' });
    const artifact = await f.store.putArtifact({ kind: 'dom', mediaType: 'text/html', data: '<p>durable</p>' });
    await f.store.close();
    const journal = (await fs.readdir(path.join(f.directory, 'journal')))[0];
    await fs.appendFile(path.join(f.directory, 'journal', journal), '{"id":"half');
    await fs.appendFile(path.join(f.directory, 'artifacts.jsonl'), '{"id":"half');
    const resumed = await EvidenceStore.open(f.directory);
    const after = await resumed.appendEvent({ type: 'after-recovery', source: 'synthetic' });
    await resumed.flush();
    const ids = (await f.reader.events({ maxBytes: 32768 })).items.map((record) => (record as { id: string }).id);
    assert.ok(ids.includes(event.id)); assert.ok(ids.includes(after.id));
    assert.equal((await f.reader.artifact(artifact.id)).text, '<p>durable</p>');
    assert.equal((await f.reader.gaps()).items.length, 3);
    const preserved = await fs.readdir(path.join(f.directory, 'recovery'));
    assert.equal(preserved.length, 2);
    for (const file of preserved) assert.ok((await fs.readFile(path.join(f.directory, 'recovery', file), 'utf8')).endsWith('{"id":"half'));
    await resumed.seal(); await resumed.close();
  } finally { await f.cleanup(); }
});

test('seal detects damaged bytes, missing artifact references and previously unreported corruption', async () => {
  const f = await fixture();
  try {
    const artifact = await f.store.putArtifact({ kind: 'dom', mediaType: 'text/plain', data: 'authentic' });
    await assert.rejects(f.store.appendCheckpoint({ key: 'missing', captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), captureConsistency: 'unknown', artifactRefs: ['art-999999999999'] }), (error: EvidenceError) => error.code === 'MISSING_REFERENCE');
    await fs.writeFile(path.join(f.directory, artifact.path!), 'tampered');
    await assert.rejects(f.reader.artifactFile(artifact.id), (error: EvidenceError) => error.code === 'INTEGRITY_FAILED');
    await assert.rejects(f.store.seal(), (error: EvidenceError) => error.code === 'INTEGRITY_FAILED');
    assert.equal(f.store.manifest.status, 'interrupted');
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    await g.store.appendEvent({ type: 'valid', source: 'synthetic' });
    const journal = (await fs.readdir(path.join(g.directory, 'journal')))[0];
    await fs.appendFile(path.join(g.directory, 'journal', journal), 'corruption');
    await assert.rejects(g.store.seal(), (error: EvidenceError) => error.code === 'INTEGRITY_FAILED');
  } finally { await g.cleanup(); }
});

test('queue budget produces a persisted gap and resumes without losing acknowledged records', async () => {
  const f = await fixture({ maxPendingBytes: 1200 });
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => f.store.appendEvent({ type: 'burst', source: 'synthetic', data: { index, padding: 'x'.repeat(150) } })));
    await f.store.flush();
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.ok(accepted.length > 0 && rejected.length > 0);
    const gaps = await f.reader.gaps();
    assert.equal(gaps.items.length, 1);
    assert.equal((gaps.items[0] as { data: { droppedRecords: number } }).data.droppedRecords, rejected.length);
    assert.equal((await f.reader.events({ types: ['burst'] })).items.length, accepted.length);
    await f.store.appendEvent({ type: 'resumed', source: 'synthetic' });
  } finally { await f.cleanup(); }
});

test('bounded event pages reject wrong directions and cursors and support missing field projection', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, number) => f.store.appendEvent({ type: 'network', source: 'synthetic', data: { number, nullable: null, text: '中文🙂'.repeat(100) } })));
    await f.store.flush();
    const page = await f.reader.events({ maxBytes: 1500 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1500);
    assert.ok(page.nextCursor);
    const projected = await f.reader.events({ fields: ['data.nullable', 'data.missing'], limit: 1 });
    assert.equal((projected.items[0] as Record<string, unknown>)['data.nullable'], null);
    assert.deepEqual((projected.items[0] as Record<string, unknown>)['data.missing'], { fieldStatus: 'missing' });
    await assert.rejects(f.reader.events({ fromSequence: 20, toSequence: 10 }), (error: EvidenceError) => error.code === 'INVALID_RANGE');
    await assert.rejects(f.reader.checkpoints({ cursor: page.nextCursor }), (error: EvidenceError) => error.code === 'INVALID_CURSOR');
    await assert.rejects(f.reader.events({ cursor: 'garbage' }), (error: EvidenceError) => error.code === 'INVALID_CURSOR');
    await assert.rejects(f.reader.artifact('../manifest.json'), (error: EvidenceError) => error.code === 'INVALID_ARTIFACT_ID');
    await assert.rejects(EvidenceStore.open(f.directory), (error: EvidenceError) => error.code === 'WRITER_BUSY');
  } finally { await f.cleanup(); }
});

test('an index append after the read snapshot cannot overflow the page or lose its continuation', async (context) => {
  const f = await fixture();
  const originalOpen = fs.open.bind(fs);
  try {
    const first = await f.store.appendEvent({ type: 'network', source: 'synthetic', data: { text: '中文🙂\\"'.repeat(80) } });
    await f.store.flush();
    const full = await f.reader.events({ maxBytes: 32768 });
    // The original payload fits, but an unreserved cursor does not fit this small margin.
    const maxBytes = Buffer.byteLength(JSON.stringify({ ...full, maxBytes: 16000, responseBytes: 0, elapsedMs: 0 })) + 64;
    const ids = [first.id]; let appended = false;
    const mock = context.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      if (!appended && flags === 'r' && String(file).replaceAll('\\', '/').endsWith('/events.jsonl')) {
        appended = true;
        // This is a real writer append after stat, before the reader opens the index.
        for (let i = 0; i < 2; i++) ids.push((await f.store.appendEvent({ type: 'network', source: 'synthetic', data: { text: 'x'.repeat(maxBytes) } })).id);
        await f.store.flush();
      }
      return originalOpen(file, flags, mode);
    });
    let page;
    try { page = await f.reader.events({ maxBytes }); } finally { mock.mock.restore(); }
    assert.equal(appended, true);
    assert.ok(page.nextCursor, 'Newly appended evidence must remain reachable');
    const seen: string[] = []; let reads = 0;
    while (true) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      assert.equal(page.responseBytes, Buffer.byteLength(JSON.stringify(page)));
      seen.push(...page.items.map(item => String((item as { id: string }).id)));
      if (!page.nextCursor) break;
      assert.ok(++reads < 10, 'Continuation must make progress');
      page = await f.reader.events({ maxBytes, cursor: page.nextCursor });
    }
    assert.deepEqual(seen, ids);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});

test('long event metadata and projected fields paginate within full envelope budgets', async () => {
  const f = await fixture();
  try {
    const records = [];
    for (let i = 0; i < 9; i++) records.push(await f.store.appendEvent({ type: `network-${'长'.repeat(400)}`, source: 'synthetic', data: { index: i, text: '甲🙂\\"\n'.repeat(900) } }));
    await f.store.flush();
    for (const maxBytes of [512, 1024, 8192, 16000, 32768]) {
      for (const fields of [undefined, ['type', 'data.text', 'data.missing']]) {
        const ids: string[] = []; let cursor: string | undefined, reads = 0;
        do {
          const response = await f.reader.events({ maxBytes, fields, limit: 3, cursor });
          assert.ok(Buffer.byteLength(JSON.stringify(response)) <= maxBytes);
          assert.equal(response.responseBytes, Buffer.byteLength(JSON.stringify(response)));
          assert.ok(response.items.length > 0, 'A fitting record or bounded reference must advance the page');
          for (const raw of response.items) {
            const item = raw as Record<string, unknown>;
            ids.push(String(item.id));
            if (item.readStatus) assert.equal(item.readStatus, 'record-exceeds-query-budget');
            else if (fields) assert.deepEqual(item['data.missing'], { fieldStatus: 'missing' });
          }
          cursor = response.nextCursor;
          assert.ok(++reads <= records.length, 'Pagination must not repeat or skip a record');
        } while (cursor);
        assert.deepEqual(ids, records.map(record => record.id));
      }
    }
  } finally { await f.cleanup(); }
});

test('a checkpoint acknowledged by a forcibly terminated writer remains readable after stale-lock recovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-evidence-crash-'));
  const moduleUrl = new URL('../../src/evidence/store.ts', import.meta.url).href;
  const program = `import { EvidenceStore } from ${JSON.stringify(moduleUrl)}; (async () => {
    const store = await EvidenceStore.create(${JSON.stringify(directory)}, {id:'crash-run', projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'Forced termination durability'});
    const artifact = await store.putArtifact({kind:'dom',mediaType:'text/html',data:'<p>acknowledged before termination</p>'});
    const cp = await store.appendCheckpoint({key:'durable',captureStartedAt:new Date().toISOString(),captureEndedAt:new Date().toISOString(),captureConsistency:'consistent',artifactRefs:[artifact.id]});
    process.stdout.write(JSON.stringify({checkpointId:cp.id,artifactId:artifact.id})+'\\n');
    setInterval(() => {}, 1000);
  })().catch(error=>{process.stderr.write(String(error));process.exit(1)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const acknowledged = await new Promise<{ checkpointId: string; artifactId: string }>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Writer did not acknowledge checkpoint.')), 10000);
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); } });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { if (!output.includes('\n')) { clearTimeout(timer); reject(new Error(`Writer exited before acknowledgement (${code}).`)); } });
    });
    child.kill('SIGKILL'); await exited;
    const recovered = await EvidenceStore.open(directory), reader = new EvidenceReader(directory);
    try {
      assert.equal((await reader.checkpoints()).items.length, 1);
      assert.equal(((await reader.checkpoints()).items[0] as { id: string }).id, acknowledged.checkpointId);
      assert.equal((await reader.artifact(acknowledged.artifactId)).text, '<p>acknowledged before termination</p>');
      assert.equal(recovered.manifest.status, 'interrupted');
      const gaps = (await reader.gaps()).items as { data: { reason: string; writerLockRecovery?: { preservedLockPath: string; diagnosticPath: string } } }[];
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0].data.reason, 'previous-capture-no-longer-live');
      const recovery = gaps[0].data.writerLockRecovery;
      assert.ok(recovery?.preservedLockPath && recovery.diagnosticPath);
      assert.ok(await fs.stat(path.join(directory, recovery.preservedLockPath)));
    } finally { await recovered.close(); }
  } finally { child.kill('SIGKILL'); await exited; await fs.rm(directory, { recursive: true, force: true }); }
});
