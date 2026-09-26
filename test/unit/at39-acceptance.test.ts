import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assessAt39Completion, inspectAt39Delivery } from '../desktop/at39-acceptance';

const nonce = 'fixed-nonce';
const fixed = { projectId: 'project-1', revisionId: 'revision-1', contentHash: 'a'.repeat(64) };
const ids = { executionId: 'execution-1', reportId: 'report-1' };
const binding = { executionId: ids.executionId, projectId: fixed.projectId,
  materialRevisionId: fixed.revisionId, materialContentHash: fixed.contentHash,
  codeFingerprint: 'code-1', inputFingerprint: 'input-1', mode: 'from-start-validation' };
const requirement = (requirementId: string, names: string[]) => ({ requirementId, verdict: 'pass', coverage: 'complete', sourceVerdict: 'pass',
  checks: names.map(name => ({ name, verdict: 'pass' })) });
const reader = {
  async summary() { return { binding, status: 'completed', finishedAt: '2026-09-27T00:00:00Z',
    snapshotVerified: true, codeFingerprint: binding.codeFingerprint, inputFingerprint: binding.inputFingerprint, workflowAttemptId: 'attempt-1' }; },
  async reportSummary() { return { binding, reportId: ids.reportId, overall: 'pass', coverage: 'complete',
    version: { verdict: 'pass' }, counts: { requirements: 2, datasets: 1 }, attemptId: 'attempt-1' }; },
  async reportItems(_projectId: string, _executionId: string, _reportId: string, collection: string) {
    return { items: collection === 'requirements' ? [
      requirement('all-orders', ['min-rows', 'unique:id', 'pagination-complete', 'source:order-id']),
      requirement('matching-details', ['required:imageOrderId', 'same-entity:imageOrderId', 'source:image-order-id']),
    ] : [{ identity: { executionId: ids.executionId, datasetId: 'orders', attemptId: 'attempt-1' },
      status: 'complete', committedRecords: 7, inspectedRecords: 7 }], outputTruncated: false };
  },
};

const delivered = async () => ({ present: true, codeFingerprint: binding.codeFingerprint });
const completion = { nonce, status: 'completed' as const, ...ids };

describe('AT39 acceptance', () => {
  it('does not accept a completed nonce without an agent deliverable', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'bes-at39-negative-'));
    try {
      await writeFile(path.join(empty, 'verdict.md'), 'A completion claim alone is not an implementation.');
      const result = await assessAt39Completion({ nonce, fixed, signal: completion, reader,
        delivered: () => inspectAt39Delivery(empty, empty, path.join(empty, 'package-lock.json')) });
      expect(result).toMatchObject({ harnessCompleted: true, agentDelivered: false, businessVerified: false, passed: false });
    } finally { await rm(empty, { recursive: true, force: true }); }
  });

  it('rejects a different revision, code identity, and a not-run report', async () => {
    for (const changed of [
      { reader: { ...reader, summary: async () => ({ ...(await reader.summary()), binding: { ...binding, materialRevisionId: 'other' } }) } },
      { delivered: async () => ({ present: true, codeFingerprint: 'other-code' }) },
      { reader: { ...reader, summary: async () => ({ ...(await reader.summary()), inputFingerprint: 'other-input' }) } },
      { reader: { ...reader, reportSummary: async () => ({ ...(await reader.reportSummary()), binding: { ...binding, codeFingerprint: 'other-code' } }) } },
      { reader: { ...reader, reportSummary: async () => ({ ...(await reader.reportSummary()), overall: 'not-run' }) } },
    ]) {
      const result = await assessAt39Completion({ nonce, fixed, signal: completion, reader, delivered, ...changed });
      expect(result.passed).toBe(false);
    }
  });

  it('does not accept a business result lacking independent pagination or image checks', async () => {
    const weak = { ...reader, reportItems: async (_projectId: string, _executionId: string, _reportId: string, collection: string) => ({
      items: collection === 'requirements' ? [
        requirement('all-orders', ['min-rows', 'unique:id', 'source:order-id']),
        requirement('matching-details', ['required:imageOrderId', 'source:image-order-id']),
      ] : [{ identity: { executionId: ids.executionId, datasetId: 'orders', attemptId: 'attempt-1' },
        status: 'complete', committedRecords: 7, inspectedRecords: 7 }], outputTruncated: false,
    }) };
    expect((await assessAt39Completion({ nonce, fixed, signal: completion, reader: weak, delivered })).passed).toBe(false);
  });

  it('accepts exact host-owned report and source-backed synthetic requirements', async () => {
    const result = await assessAt39Completion({ nonce, fixed, signal: completion, reader, delivered });
    expect(result).toMatchObject({ harnessCompleted: true, agentDelivered: true, businessVerified: true, passed: true });
  });
});
