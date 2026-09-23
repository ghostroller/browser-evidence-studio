import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EvidenceReader } from '@/evidence/reader';
import { EvidenceStore } from '@/evidence/store';
import { buildSoakEvidenceSnapshot, verifySoakEvidenceSnapshot } from '../desktop/soak-evidence';

async function fixture(checkpoints = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bes-soak-evidence-'));
  const store = await EvidenceStore.create(directory, { id: 'soak-fixture', projectId: 'synthetic', kind: 'demonstrate', mode: 'synthetic', objective: 'Long-run restart audit' });
  const artifact = await store.putArtifact({ kind: 'response-body', mediaType: 'application/json', data: '{"cycle":7}' });
  await store.appendRaw('rrweb', { event: { type: 3, data: { source: 0 } } });
  for (let index = 0; index < checkpoints; index++) {
    const at = new Date().toISOString();
    await store.appendCheckpoint({ key: `soak-${index}`, artifactRefs: [artifact.id], captureStartedAt: at, captureEndedAt: at, captureConsistency: 'consistent' });
  }
  await store.seal(); await store.close();
  return { directory, artifact, reader: new EvidenceReader(directory), async cleanup() {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bes-soak-evidence-'));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('soak evidence audit pages all checkpoints and matches a freshly reopened index', async () => {
  const f = await fixture(105);
  try {
    const snapshot = await buildSoakEvidenceSnapshot(f.reader);
    assert.equal(snapshot.checkpointIds.length, 105); assert.equal(snapshot.counts.raw, 1);
    const reopened = await EvidenceStore.open(f.directory); await reopened.close();
    const verified = await verifySoakEvidenceSnapshot(new EvidenceReader(f.directory), snapshot);
    assert.equal(verified.passed, true); assert.equal(verified.checkpoints, 105);
    assert.ok(verified.files >= 4); assert.ok(verified.fileBytes > 0);
  } finally { await f.cleanup(); }
});

test('soak evidence audit rejects changed raw data and missing captured blobs', async t => {
  for (const change of ['raw', 'blob'] as const) await t.test(change, async () => {
    const f = await fixture();
    try {
      const snapshot = await buildSoakEvidenceSnapshot(f.reader);
      if (change === 'raw') {
        const name = (await readdir(path.join(f.directory, 'raw', 'rrweb')))[0];
        const file = path.join(f.directory, 'raw', 'rrweb', name);
        await writeFile(file, (await readFile(file, 'utf8')).replace('"type":3', '"type":4'));
      } else await unlink(path.join(f.directory, f.artifact.path!));
      await assert.rejects(verifySoakEvidenceSnapshot(f.reader, snapshot));
    } finally { await f.cleanup(); }
  });
});

test('soak evidence audit refuses corrupt sealed raw records even when a startup rebuild hid them', async () => {
  const f = await fixture();
  try {
    const integrityPath = path.join(f.directory, 'integrity.json'), integrity = JSON.parse(await readFile(integrityPath, 'utf8'));
    const entry = integrity.files.find((item: { path: string }) => item.path.startsWith('raw/rrweb/'));
    const file = path.join(f.directory, entry.path), bytes = Buffer.concat([await readFile(file), Buffer.from('{')]);
    await writeFile(file, bytes);
    entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(integrityPath, JSON.stringify(integrity));
    const reopened = await EvidenceStore.open(f.directory); await reopened.close();
    await assert.rejects(buildSoakEvidenceSnapshot(new EvidenceReader(f.directory)), /silently omit damaged records/);
  } finally { await f.cleanup(); }
});
