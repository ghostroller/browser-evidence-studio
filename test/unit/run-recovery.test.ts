import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { makeDispatch } from '@/main/services/dispatch';
import { inspectRunRecovery, recoverRun } from '@/main/services/run-recovery';
import type { Studio } from '@/main/services/studio';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-run-recovery-')), runId = 'synthetic-recovery-run', runDir = path.join(root, 'runs', runId);
  const store = await EvidenceStore.create(runDir, { id: runId, projectId: 'project-a', kind: 'validate', mode: 'synthetic', objective: 'Archive recovery boundaries' });
  const checkpoint = await store.appendCheckpoint({ key: 'retained', title: '已确认保存的材料', description: '恢复后保持稳定身份', requirementIds: ['requirement-a'], captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), captureConsistency: 'consistent', artifactRefs: [] });
  await store.close();
  let refreshes = 0;
  const fake = { root, runs: [{ id: runId, projectId: 'project-a', status: 'unreadable', error: 'Synthetic blocked archive' }], active: undefined as unknown, onChanged: () => undefined,
    serialized: <T>(operation: () => Promise<T>) => operation(), refreshValidations: async () => { refreshes++; return { records: [], diagnostics: [] }; } };
  return { root, runId, runDir, checkpoint, fake, studio: fake as unknown as Studio, refreshes: () => refreshes, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test('trusted archive reopen preserves saved checkpoints and refreshes validation projection without restoring ownership', async () => {
  const f = await fixture();
  try {
    const before = await readFile(path.join(f.runDir, 'checkpoints.jsonl'));
    const inspected = await inspectRunRecovery(f.studio, { runId: f.runId });
    assert.equal(inspected.inspection.state, 'unlocked'); assert.equal(inspected.canRecover, true);
    const restored = await recoverRun(f.studio, { runId: f.runId, expectedFingerprint: inspected.inspection.lockFingerprint });
    assert.equal(restored.recovered, true); assert.equal(restored.status, 'interrupted'); assert.equal(f.refreshes(), 1);
    assert.equal(f.fake.active, undefined); assert.equal(f.fake.runs[0].status, 'interrupted');
    assert.deepEqual(await readFile(path.join(f.runDir, 'checkpoints.jsonl')), before);
    assert.equal(((await new EvidenceReader(f.runDir).checkpoints()).items[0] as { id: string }).id, f.checkpoint.id);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: null }), /already readable/);
  } finally { await f.cleanup(); }
});

test('archive recovery rejects API access, unknown paths, active sessions and stale inspection fingerprints', async () => {
  const f = await fixture();
  try {
    const dispatch = makeDispatch(f.studio);
    for (const method of ['inspectRunRecovery', 'recoverRun']) await assert.rejects(dispatch(method, { runId: f.runId }, 'api'), (error: any) => error.status === 403);
    await assert.rejects(inspectRunRecovery(f.studio, { runId: '../escape' }), /Invalid recovery run identity/);
    await assert.rejects(recoverRun(f.studio, { runId: 'not-registered', expectedFingerprint: null }), (error: any) => error.status === 404);
    const before = await readFile(path.join(f.runDir, 'manifest.json'));
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: 'stale' }), /ownership changed/);
    f.fake.active = { id: 'another-running-session' };
    assert.equal((await inspectRunRecovery(f.studio, { runId: f.runId })).canRecover, false);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: null }), /Seal the current run/);
    assert.deepEqual(await readFile(path.join(f.runDir, 'manifest.json')), before); assert.equal(f.refreshes(), 0);
  } finally { await f.cleanup(); }
});

test('corrupt ownership and mismatched manifest identity remain unchanged and never become readable', async () => {
  const f = await fixture();
  try {
    const lock = path.join(f.runDir, 'writer.lock'); await writeFile(lock, '{incomplete synthetic lock');
    const inspected = await inspectRunRecovery(f.studio, { runId: f.runId });
    assert.equal(inspected.inspection.state, 'corrupt'); assert.equal(inspected.canRecover, false);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: inspected.inspection.lockFingerprint }), /recovery refused/);
    assert.equal(await readFile(lock, 'utf8'), '{incomplete synthetic lock');
    await rm(lock);
    const manifest = JSON.parse(await readFile(path.join(f.runDir, 'manifest.json'), 'utf8')); manifest.id = 'different-run';
    const bytes = JSON.stringify(manifest); await writeFile(path.join(f.runDir, 'manifest.json'), bytes);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: null }), /manifest identity/);
    assert.equal(await readFile(path.join(f.runDir, 'manifest.json'), 'utf8'), bytes);
    assert.equal(f.fake.runs[0].status, 'unreadable'); assert.equal(f.refreshes(), 0);
  } finally { await f.cleanup(); }
});

test('live and unverifiable legacy owners remain blocked even with a matching inspection fingerprint', async () => {
  const f = await fixture();
  let live: EvidenceStore | undefined;
  try {
    live = await EvidenceStore.open(f.runDir);
    const liveBytes = await readFile(path.join(f.runDir, 'writer.lock'));
    const inspected = await inspectRunRecovery(f.studio, { runId: f.runId });
    assert.equal(inspected.inspection.state, 'live'); assert.equal(inspected.canRecover, false);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: inspected.inspection.lockFingerprint }), /recovery refused/);
    assert.deepEqual(await readFile(path.join(f.runDir, 'writer.lock')), liveBytes);
    await live.close(); live = undefined;
    const approximateOwner = JSON.stringify({ pid: process.pid, instanceId: randomUUID(), processStartedAt: 0 });
    await writeFile(path.join(f.runDir, 'writer.lock'), approximateOwner);
    const unknown = await inspectRunRecovery(f.studio, { runId: f.runId });
    assert.equal(unknown.inspection.state, 'unknown'); assert.equal(unknown.canRecover, false);
    await assert.rejects(recoverRun(f.studio, { runId: f.runId, expectedFingerprint: unknown.inspection.lockFingerprint }), /recovery refused/);
    assert.equal(await readFile(path.join(f.runDir, 'writer.lock'), 'utf8'), approximateOwner); assert.equal(f.refreshes(), 0);
  } finally { await live?.close(); await f.cleanup(); }
});
