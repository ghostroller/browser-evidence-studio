import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IndexState } from '@/evidence/contracts';
import { jsonLines, safeFile } from '@/evidence/files';
import { evidenceSources } from '@/evidence/index';
import type { EvidenceReader } from '@/evidence/reader';

interface FileDigest { path: string; sha256: string; bytes: number; }
interface Integrity { schemaVersion: 1; runId: string; files: FileDigest[]; }
export interface SoakEvidenceSnapshot {
  schemaVersion: 1;
  runId: string;
  counts: IndexState['counts'];
  lastSequence: number;
  checkpointIds: string[];
  integrity: { sha256: string; bytes: number; files: number; fileBytes: number; };
}
export interface SoakEvidenceVerification {
  passed: true;
  runId: string;
  processId: number;
  verifiedAt: string;
  elapsedMs: number;
  rebuildMs: number;
  files: number;
  fileBytes: number;
  checkpoints: number;
}

async function digestFile(runDir: string, relative: string): Promise<FileDigest> {
  const file = await safeFile(runDir, relative), before = await stat(file);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  const after = await stat(file);
  assert.equal(bytes, before.size, `Evidence length changed while hashing ${relative}`);
  assert.deepEqual([after.size, after.mtimeMs, after.ctimeMs, after.ino], [before.size, before.mtimeMs, before.ctimeMs, before.ino], `Evidence changed while hashing ${relative}`);
  return { path: relative, sha256: hash.digest('hex'), bytes };
}

/** Hash streams directly: the audit must neither trust nor populate the reader's blob cache. */
async function verifyIntegrity(reader: EvidenceReader, runId: string): Promise<SoakEvidenceSnapshot['integrity']> {
  const ledgerDigest = await digestFile(reader.runDir, 'integrity.json');
  const ledger = JSON.parse(await readFile(await safeFile(reader.runDir, 'integrity.json'), 'utf8')) as Integrity;
  assert.equal(ledger.schemaVersion, 1); assert.equal(ledger.runId, runId); assert.ok(Array.isArray(ledger.files));
  const entries = new Map<string, FileDigest>(); let fileBytes = 0;
  for (const entry of ledger.files) {
    assert.equal(typeof entry.path, 'string'); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    assert.ok(!entries.has(entry.path), `Duplicate integrity entry ${entry.path}`);
    assert.notEqual(entry.path, 'integrity.json');
    assert.deepEqual(await digestFile(reader.runDir, entry.path), entry, `Sealed evidence changed: ${entry.path}`);
    entries.set(entry.path, entry); fileBytes += entry.bytes;
  }
  // A valid subset is insufficient: the seal must cover every current source and captured blob.
  for (const source of await evidenceSources(reader.runDir)) {
    assert.ok(entries.has(source.file), `The seal omitted evidence source ${source.file}`);
    if (source.kind !== 'artifacts') continue;
    for await (const line of jsonLines(await safeFile(reader.runDir, source.file))) {
      assert.ok(!line.invalid && line.value, 'The sealed artifact catalog must contain complete records');
      const artifact = line.value;
      if (typeof artifact.path === 'string') {
        const entry = entries.get(artifact.path);
        assert.ok(entry, `The seal omitted artifact ${artifact.id}`);
        assert.equal(entry.sha256, artifact.sha256); assert.equal(entry.bytes, artifact.capturedBytes);
      }
    }
  }
  assert.deepEqual(await digestFile(reader.runDir, 'integrity.json'), ledgerDigest, 'Integrity ledger changed during verification');
  return { sha256: ledgerDigest.sha256, bytes: ledgerDigest.bytes, files: entries.size, fileBytes };
}

async function indexSnapshot(reader: EvidenceReader): Promise<Omit<SoakEvidenceSnapshot, 'integrity'>> {
  const summary = await reader.summary(), run = summary.run as { id: string; status: string };
  assert.equal(run.status, 'sealed', 'The completed long run must reopen as sealed');
  const counts = summary.counts as IndexState['counts'];
  for (const kind of ['events', 'artifacts', 'checkpoints', 'raw'] as const) assert.ok(Number.isSafeInteger(counts[kind]) && counts[kind] >= 0);
  assert.ok(Number.isSafeInteger(summary.lastSequence) && Number(summary.lastSequence) >= 0);
  const checkpointIds: string[] = [], cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await reader.checkpoints({ cursor, fields: [], limit: 100, maxBytes: 32768 });
    for (const item of page.items as { id: string }[]) { assert.match(item.id, /^cp-\d{12}$/); checkpointIds.push(item.id); }
    assert.ok(checkpointIds.length <= counts.checkpoints, 'Checkpoint index returned more records than its declared count');
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor), 'Checkpoint cursor must advance'); cursors.add(cursor); }
  } while (cursor);
  assert.equal(checkpointIds.length, counts.checkpoints); assert.equal(new Set(checkpointIds).size, checkpointIds.length);
  return { schemaVersion: 1, runId: run.id, counts: { ...counts }, lastSequence: Number(summary.lastSequence), checkpointIds };
}

async function audit(reader: EvidenceReader): Promise<{ snapshot: SoakEvidenceSnapshot; rebuildMs: number }> {
  const before = await indexSnapshot(reader), integrity = await verifyIntegrity(reader, before.runId);
  const started = performance.now(), rebuilt = await reader.rebuildIndex(), rebuildMs = performance.now() - started;
  assert.deepEqual(rebuilt.corrupt, [], 'The long-run index rebuild must not silently omit damaged records');
  assert.deepEqual(await indexSnapshot(reader), before, 'Rebuilding the index changed acknowledged record counts or checkpoint identities');
  assert.deepEqual(await verifyIntegrity(reader, before.runId), integrity, 'Index rebuilding changed sealed evidence');
  return { snapshot: { ...before, integrity }, rebuildMs };
}

export async function buildSoakEvidenceSnapshot(reader: EvidenceReader): Promise<SoakEvidenceSnapshot> {
  return (await audit(reader)).snapshot;
}

export async function verifySoakEvidenceSnapshot(reader: EvidenceReader, expected: SoakEvidenceSnapshot): Promise<SoakEvidenceVerification> {
  assert.equal(expected.schemaVersion, 1);
  const started = performance.now(), { snapshot, rebuildMs } = await audit(reader);
  assert.deepEqual(snapshot, expected, 'Reopened long-run evidence does not match the first-process snapshot');
  return { passed: true, runId: snapshot.runId, processId: process.pid, verifiedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started, rebuildMs, files: snapshot.integrity.files, fileBytes: snapshot.integrity.fileBytes, checkpoints: snapshot.checkpointIds.length };
}
