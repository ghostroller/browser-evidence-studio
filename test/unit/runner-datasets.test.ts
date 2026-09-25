import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatasetBatch, ExecutionBinding } from '@/contracts/execution';
import { PersistentDatasetService } from '@/runner/datasets';

const binding: ExecutionBinding = { schemaVersion: 1, executionId: 'execution-c', projectId: 'project-c', materialRevisionId: 'revision-v1', materialContentHash: 'material-v1-hash', codeFingerprint: 'code-sha', inputFingerprint: 'input-sha', environmentRef: 'synthetic-node', mode: 'current-page-test' };
const identity = { executionId: binding.executionId, attemptId: 'attempt-1', datasetId: 'orders' };
const batch = (batchId = 'page-1'): DatasetBatch => ({ ...identity, batchId, records: [{ id: 'order-1', note: null }, { id: 'order-2' }], provenance: { origin: 'browser', sourceRefs: ['artifact-orders'] } });
const budget = { maxBytes: 4096, limit: 10 };
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-c-datasets-'));
  try { await run(root); }
  finally {
    assert.equal(await realpath(path.dirname(root)), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('bes-c-datasets-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('durable batches replay exactly, reject conflicting provenance and survive reopen with null/missing distinction', async () => fixture(async root => {
  let service = await PersistentDatasetService.open(root, binding);
  await service.begin(identity);
  const receipt = await service.append(batch());
  assert.equal(receipt.recordCount, 2);
  assert.equal((await service.append(batch())).replayed, true);
  await assert.rejects(service.append({ ...batch(), provenance: { origin: 'node', sourceRefs: ['different'] } }), /different records, provenance/);
  await service.close();
  service = await PersistentDatasetService.open(root, binding);
  try {
    assert.deepEqual((await service.batches(identity, budget)).items, [receipt]);
    const records = await service.records(identity, 'page-1', { ...budget, fields: ['id', 'note'] });
    assert.deepEqual(records.items[0].value, { id: 'order-1', note: null });
    assert.deepEqual(records.items[1].missingFields, ['note']);
    assert.equal((await service.summary(identity)).status, 'unfinished');
    await service.finish({ ...identity, status: 'partial', committedBatches: 1, committedRecords: 2 });
    await assert.rejects(service.append(batch('page-2')), /finished dataset/);
    assert.equal((await service.append(batch())).replayed, true, 'Retry after finish recovers the original receipt');
    await assert.rejects(service.finish({ ...identity, status: 'complete', committedBatches: 1, committedRecords: 2 }), /immutable/);
  } finally { await service.close(); }
}));

test('cancellation before commit leaves no batch; receipts remain after caller cancellation', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  try {
    await service.begin(identity);
    const stopped = new AbortController(); stopped.abort(new Error('cancelled before commit'));
    await assert.rejects(service.append(batch(), stopped.signal), /cancelled before commit/);
    assert.equal((await service.batches(identity, budget)).items.length, 0);
    await service.append(batch());
    stopped.abort();
    assert.equal((await service.batches(identity, budget)).items.length, 1);
    await assert.rejects(service.finish({ ...identity, status: 'complete', committedBatches: 2, committedRecords: 4 }), /every durable/);
  } finally { await service.close(); }
}));

test('receipt cursor freezes its boundary and rejects another dataset; large records require explicit projection', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  try {
    await service.begin(identity);
    await service.append(batch('z-first')); await service.append(batch('a-second'));
    const first = await service.batches(identity, { ...budget, limit: 1 });
    await service.append({ ...batch('third'), records: [{ id: 'large', payload: 'x'.repeat(9000) }] });
    const second = await service.batches(identity, { ...budget, limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0].batchId, 'a-second');
    assert.equal(second.outputTruncated, false, 'Append after first read does not extend its cursor snapshot');
    const other = { ...identity, datasetId: 'other' }; await service.begin(other);
    await assert.rejects(service.batches(other, { ...budget, cursor: first.nextCursor }), /Cursor/);
    await assert.rejects(service.records(identity, 'third', { ...budget, maxBytes: 1024 }), /exceeds maxBytes/);
    const projected = await service.records(identity, 'third', { ...budget, maxBytes: 1024, fields: ['id'] });
    assert.deepEqual(projected.items[0].value, { id: 'large' });
    assert.equal(projected.returnedBytes, Buffer.byteLength(JSON.stringify(projected)));
  } finally { await service.close(); }
}));

test('new attempt reuse retains source attempt and requires matching records/provenance and validity evidence', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  try {
    await service.begin(identity); await service.append(batch());
    const next = { ...identity, attemptId: 'attempt-2' }; await service.begin(next);
    const reused = { ...batch(), ...next, reusedFrom: { ...identity, batchId: 'page-1', validityEvidenceRefs: ['fresh-login-check', 'input-compatibility-check'] } };
    const receipt = await service.append(reused);
    const stored = JSON.parse(await readFile(path.join(root, receipt.artifactId), 'utf8')) as { batch: DatasetBatch };
    assert.deepEqual(stored.batch.reusedFrom, reused.reusedFrom);
    const metadata = await service.batchMetadata(next, 'page-1', budget);
    assert.equal(metadata.contentVerified, true);
    assert.deepEqual(metadata.reusedFrom, reused.reusedFrom);
    assert.deepEqual(metadata.provenance, batch().provenance);
    assert.equal(metadata.returnedBytes, Buffer.byteLength(JSON.stringify(metadata)));
    await assert.rejects(service.append({ ...reused, batchId: 'different', records: [{ id: 'invented' }] }), /must match/);
    assert.throws(() => service.append({ ...reused, batchId: 'invalid', reusedFrom: { ...reused.reusedFrom, validityEvidenceRefs: [] } }), /validity evidence/);
  } finally { await service.close(); }
}));

test('step attempt lifecycle is durable and cannot be relabeled or given a second terminal result', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  const stepIdentity = { executionId: binding.executionId, stepId: 'orders', attemptId: 'step-attempt-1', entityKey: 'order-1' };
  const occurredAt = new Date().toISOString();
  try {
    await service.saveStep({ identity: stepIdentity, occurredAt, state: 'running' });
    await service.saveStep({ identity: stepIdentity, occurredAt, state: 'failed', result: { identity: stepIdentity, status: 'failed', error: { name: 'Error', message: 'original business error' } } });
    await assert.rejects(service.saveStep({ identity: stepIdentity, occurredAt, state: 'running' }), /already has a durable terminal/);
    const terminal = JSON.parse(await readFile(path.join(root, 'executions', binding.executionId, 'attempts', stepIdentity.attemptId, 'step-0002.json'), 'utf8')) as { result: { error: { message: string } } };
    assert.equal(terminal.result.error.message, 'original business error');
  } finally { await service.close(); }
}));

test('gapped step lifecycle and a copied batch from another dataset are rejected without overwriting originals', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  try {
    const stepIdentity = { executionId: binding.executionId, stepId: 'orders', attemptId: 'gapped-attempt' };
    const event = { identity: stepIdentity, occurredAt: new Date().toISOString(), state: 'running' as const };
    await service.saveStep(event);
    const dir = path.join(root, 'executions', binding.executionId, 'attempts', stepIdentity.attemptId);
    const third = path.join(dir, 'step-0003.json'); await writeFile(third, 'untouched existing original');
    await assert.rejects(service.saveStep(event), /sequence is incomplete/);
    assert.equal(await readFile(third, 'utf8'), 'untouched existing original');
    await service.begin(identity); const receipt = await service.append(batch());
    const other = { ...identity, datasetId: 'other' }; await service.begin(other);
    const copied = path.join(root, 'executions', binding.executionId, 'datasets', identity.attemptId, 'other', path.basename(receipt.artifactId));
    await writeFile(copied, await readFile(path.join(root, receipt.artifactId)));
    await assert.rejects(service.batchMetadata(other, 'page-1', budget), /Receipt location/);
  } finally { await service.close(); }
}));

test('exclusive writer, immutable version binding and traversal/junction rejection protect execution data', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  await assert.rejects(PersistentDatasetService.open(root, binding), /writer guard|writer process/i);
  await assert.rejects(service.begin({ ...identity, datasetId: '..' }), /single path/);
  await service.close();
  await assert.rejects(PersistentDatasetService.open(root, { ...binding, materialRevisionId: 'revision-v2' }), /different immutable binding/);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const target = path.join(root, 'executions', binding.executionId, 'datasets');
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  const reopened = await PersistentDatasetService.open(root, binding);
  try { await assert.rejects(reopened.begin(identity), /real directories/); }
  finally { await reopened.close(); }
}));

test('real process SIGKILL preserves acknowledged batches and recovers writer ownership without completing the dataset', { timeout: 20_000 }, async () => fixture(async root => {
  const script = path.join(root, 'crash-writer.mjs');
  const module = pathToFileURL(path.resolve('src/runner/datasets.ts')).href;
  await writeFile(script, `import { PersistentDatasetService } from ${JSON.stringify(module)};
    const service = await PersistentDatasetService.open(process.env.BES_DATA, ${JSON.stringify(binding)});
    await service.begin(${JSON.stringify(identity)});
    const receipt = await service.append(${JSON.stringify(batch())});
    process.send({ receipt });
    setInterval(() => {}, 1000);`);
  const child = fork(script, [], { execArgv: ['--import', 'tsx'], cwd: process.cwd(), env: { ...process.env, BES_DATA: root }, silent: true });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const message = await new Promise<{ receipt: { artifactId: string } }>((resolve, reject) => {
      child.once('message', value => resolve(value as { receipt: { artifactId: string } }));
      child.once('error', reject); child.once('exit', code => reject(new Error(`Writer exited ${code}: ${stderr}`)));
    });
    const before = await readFile(path.join(root, message.receipt.artifactId));
    child.kill('SIGKILL'); await exited;
    const service = await PersistentDatasetService.open(root, binding);
    try {
      const recovered = await service.batches(identity, budget);
      assert.equal(recovered.items.length, 1);
      assert.deepEqual(await readFile(path.join(root, recovered.items[0].artifactId)), before);
      assert.equal((await service.summary(identity)).status, 'unfinished');
      assert.equal((await service.append(batch())).replayed, true);
    } finally { await service.close(); }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
}));

test('queue admission rejects unbounded pending batches; a reader can inspect a live execution without a writer lease', async () => fixture(async root => {
  const service = await PersistentDatasetService.open(root, binding);
  try {
    await service.begin(identity);
    const pending = Array.from({ length: 80 }, (_, index) => service.append(batch(`page-${index}`)));
    const settled = await Promise.allSettled(pending);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 64);
    assert.ok(settled.filter(item => item.status === 'rejected').every(item => /queue exceeds/.test(String(item.reason))));
    const reader = await PersistentDatasetService.openReader(root, binding.executionId);
    try {
      assert.equal((await reader.summary(identity)).committedBatches, 64);
      await assert.rejects(reader.begin(identity), /cannot mutate/);
      assert.equal((await reader.batches(identity, budget)).items.length, 10);
    } finally { await reader.close(); }
  } finally { await service.close(); }
}));

test('normal summary and ID body reads never load other batch bodies; corrupt metadata requires explicit rebuild', async () => fixture(async root => {
  const writer = await PersistentDatasetService.open(root, binding);
  await writer.begin(identity);
  await writer.append(batch('small'));
  const other = await writer.append({ ...batch('unselected-large'), records: [{ payload: 'x'.repeat(500_000) }] });
  await writer.close();
  const original = await readFile(path.join(root, other.artifactId));
  await writeFile(path.join(root, other.artifactId), 'deliberately damaged unselected body');
  const reader = await PersistentDatasetService.openReader(root, binding.executionId);
  try {
    assert.equal((await reader.summary(identity)).committedBatches, 2);
    assert.equal((await reader.batches(identity, { ...budget, limit: 1 })).items[0].batchId, 'small');
    assert.equal((await reader.records(identity, 'small', budget)).items.length, 2);
    await assert.rejects(reader.records(identity, 'unselected-large', budget), /JSON/);
  } finally { await reader.close(); }
  const recovered = await PersistentDatasetService.open(root, binding);
  try {
    await assert.rejects(recovered.rebuild(identity), /JSON/);
    await writeFile(path.join(root, other.artifactId), original);
    const dataDir = path.dirname(path.join(root, other.artifactId));
    await writeFile(path.join(dataDir, 'state.json'), 'broken metadata');
    await assert.rejects(recovered.summary(identity), /explicit rebuild required/);
    const result = await recovered.rebuild(identity);
    assert.equal(result.batches, 2); assert.ok(result.scannedBytes > 500_000);
    assert.equal((await recovered.summary(identity)).committedBatches, 2);
  } finally { await recovered.close(); }
}));

test('interrupted commit marker never becomes an empty dataset and rebuild preserves acknowledged originals', async () => fixture(async root => {
  let writer = await PersistentDatasetService.open(root, binding);
  await writer.begin(identity); const receipt = await writer.append(batch()); await writer.close();
  const dataDir = path.dirname(path.join(root, receipt.artifactId));
  const before = await readFile(path.join(root, receipt.artifactId));
  await writeFile(path.join(dataDir, 'pending.json'), JSON.stringify({ batchId: 'next-unwritten', sequence: 2 }));
  writer = await PersistentDatasetService.open(root, binding);
  try {
    await assert.rejects(writer.append(batch('new')), /explicit rebuild/);
    await writer.rebuild(identity);
    assert.deepEqual(await readFile(path.join(root, receipt.artifactId)), before);
    assert.equal((await writer.append(batch())).replayed, true);
    await writer.append(batch('new'));
    assert.equal((await writer.summary(identity)).committedBatches, 2);
  } finally { await writer.close(); }
}));
