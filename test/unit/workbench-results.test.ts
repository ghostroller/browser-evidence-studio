import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectExecutions } from '@/main/services/project-executions';
import { ProjectMaterials } from '@/main/services/project-materials';
import { canonicalJson } from '@/runner/datasets';
import { createBrowserResultPort } from '@/main/workbench/result-port';
import { parseResultRequest } from '@/main/workbench/result-validation';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Deliberately hand-built read-only unit fixtures for disk integrity rejection.
// These are not runtime-generated reports and are never used as GUI evidence.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-results-unit-')); roots.push(root);
  const executions = new ProjectExecutions(root, new ProjectMaterials(root));
  const seed = async (id: string, projectId = 'project', startedAt = '2026-09-30T01:00:00.000Z') => {
    const directory = path.join(root, 'executions', id); await mkdir(directory, { recursive: true });
    const binding = { schemaVersion: 1, executionId: id, projectId, materialRevisionId: 'v1', materialContentHash: 'a'.repeat(64), codeFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64), environmentRef: '/private/profile', mode: 'current-page-test' };
    const state = { binding, runId: 'run', pageId: 'page', validationId: id, startedAt, finishedAt: '2026-09-30T02:00:00.000Z', status: 'failed', snapshotVerified: true, workflowAttemptId: 'workflow', steps: [], datasets: [], assertions: [] };
    await writeFile(path.join(directory, 'binding.json'), JSON.stringify(binding)); await writeFile(path.join(directory, 'host-state.json'), JSON.stringify(state));
    return { directory, binding, state };
  };
  return { root, executions, seed };
}
const budget = { limit: 1, maxBytes: 4096 };
test('catalog selects only real same-project descriptors, paginates, rejects stale/cross-scope cursors and never exposes paths', async () => {
  const f = await fixture(); await f.seed('first'); await f.seed('second', 'project', '2026-09-30T01:30:00.000Z'); await f.seed('foreign', 'other');
  const first = await f.executions.list('project', budget); expect(first.items.map(value => value.executionId)).toEqual(['second']); expect(first.nextCursor).toBeTruthy();
  expect(JSON.stringify(first)).not.toMatch(/private|environmentRef|codeFingerprint/);
  const second = await f.executions.list('project', { ...budget, cursor: first.nextCursor }); expect(second.items.map(value => value.executionId)).toEqual(['first']);
  expect(first.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(first)));
  await expect(f.executions.list('other', { ...budget, cursor: first.nextCursor })).rejects.toMatchObject({ status: 409 });
  await f.seed('third'); await expect(f.executions.list('project', { ...budget, cursor: first.nextCursor })).rejects.toMatchObject({ status: 409 });
});
test('absent catalog is empty but corrupt, oversized and linked descriptors fail closed', async () => {
  const f = await fixture(); expect((await f.executions.list('project', budget)).items).toEqual([]);
  const item = await f.seed('broken'); await writeFile(path.join(item.directory, 'host-state.json'), '{}');
  await expect(f.executions.list('project', budget)).rejects.toBeTruthy();
  await writeFile(path.join(item.directory, 'host-state.json'), JSON.stringify(item.state));
  await writeFile(path.join(item.directory, 'binding.json'), 'x'.repeat(16 * 1024 + 1)); await expect(f.executions.list('project', budget)).rejects.toMatchObject({ status: 413 });
  const g = await fixture(); await mkdir(path.join(g.root, 'executions')); await symlink(f.root, path.join(g.root, 'executions', 'linked'));
  await expect(g.executions.list('project', budget)).rejects.toMatchObject({ status: 409 });
});
test.each(['projectId', 'executionId', 'materialRevisionId', 'codeFingerprint', 'attemptId', 'reportId', 'contentHash'])('saved report %s mismatch is rejected by summary, list and item reads', async mismatch => {
  const f = await fixture(), item = await f.seed('execution'), reportId = randomUUID();
  const report = { schemaVersion: 1, binding: { ...item.binding }, attemptId: 'workflow', materialStatus: 'candidate', overall: 'fail', coverage: 'missing', version: { name: 'version', verdict: 'pass', reason: 'fixed' }, requirements: [], datasets: [], reasons: [], returnedBytes: 0 };
  if (['projectId', 'executionId', 'materialRevisionId', 'codeFingerprint'].includes(mismatch)) (report.binding as any)[mismatch] = 'wrong';
  if (mismatch === 'attemptId') report.attemptId = 'wrong';
  const stored = { reportId: mismatch === 'reportId' ? randomUUID() : reportId, contentHash: createHash('sha256').update(canonicalJson(report)).digest('hex'), report };
  if (mismatch === 'contentHash') stored.contentHash = '0'.repeat(64);
  await writeFile(path.join(item.directory, `report-${reportId}.json`), JSON.stringify(stored));
  const port = createBrowserResultPort(f.executions);
  for (const method of ['executionReport', 'executionReports', 'executionReportItems']) {
    const body = { projectId: 'project', executionId: 'execution', ...(method === 'executionReports' ? {} : { reportId }), ...(method === 'executionReportItems' ? { collection: 'requirements' } : {}) };
    await expect(port.execute(parseResultRequest({ instanceId: 'i', method, body }), { authorize: () => {} })).rejects.toMatchObject({ code: 'conflict' });
  }
  expect(JSON.parse(await readFile(path.join(item.directory, `report-${reportId}.json`), 'utf8'))).toEqual(stored);
});
test('catalog rechecks access after asynchronous descriptor reads', async () => {
  const f = await fixture(); await f.seed('e'); let calls = 0;
  await expect(f.executions.list('project', budget, () => { if (++calls >= 3) throw new Error('revoked'); })).rejects.toThrow('revoked');
});

test.each(['steps', 'datasets'])('host %s current identities cannot be relabelled from another execution', async collection => {
  const f = await fixture(), item = await f.seed('execution');
  (item.state as any)[collection] = collection === 'steps' ? [{ identity: { executionId: 'foreign', attemptId: 'a', stepId: 's' }, state: 'failed' }] : [{ executionId: 'foreign', attemptId: 'a', datasetId: 'd', status: 'failed', committedBatches: 0, committedRecords: 0 }];
  await writeFile(path.join(item.directory, 'host-state.json'), JSON.stringify(item.state));
  await expect(f.executions.items('project', 'execution', collection as 'steps' | 'datasets', budget)).rejects.toMatchObject({ status: 409 });
});
test('a legitimate prior-execution dependency remains a reference without changing current step identity', async () => {
  const f = await fixture(), item = await f.seed('execution');
  (item.state as any).steps = [{ identity: { executionId: 'execution', attemptId: 'current', stepId: 's' }, state: 'blocked', dependencies: [{ executionId: 'prior', attemptId: 'old', stepId: 's' }] }];
  await writeFile(path.join(item.directory, 'host-state.json'), JSON.stringify(item.state));
  expect((await f.executions.items('project', 'execution', 'steps', budget)).items[0]).toMatchObject({ dependencies: [{ executionId: 'prior' }] });
});
