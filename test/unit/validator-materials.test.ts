import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatasetBatch, ExecutionBinding } from '@/contracts/execution';
import type { MaterialContent } from '@/contracts/materials';
import type { JsonValue } from '@/contracts/workflow';
import { FileMaterialService } from '@/materials';
import { PersistentDatasetService } from '@/runner/datasets';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { CapturedJsonSourceReader, ValidatorService, type SourceDocument, type ValidationRequest, type ReviewReader } from '@/validator';

const sourceUrl = 'https://fixture.test/api/orders?filter=paid';
const output = [{ id: 'o-1', amount: '12.00' }, { id: 'o-2', amount: '45.00' }];
const material = (): MaterialContent => ({ recordingRefs: [], checkpoints: [], annotations: [],
  requirements: [{ id: 'all-orders', description: 'Every paid order', dataset: 'orders', fieldIds: ['amount'], rules: [
    { type: 'required', field: 'amount' }, { type: 'unique', field: 'id' },
    { type: 'pagination-complete', proof: { kind: 'numbered-pages', sourceUrl, pageParameter: 'page', pagePointer: '/page', rowsPointer: '/items', entityPointer: '/id', outputEntityPath: '/id', termination: { kind: 'has-next-and-total', hasNextPointer: '/hasNext', totalRecordsPointer: '/total' } } },
  ] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'The charged amount', outputPath: '/amount', sourcePolicy: 'any-evidenced',
    sourceProof: { kind: 'json-record', sourceUrl, pageParameter: 'page', rowsPointer: '/items', entityPointer: '/id', outputEntityPath: '/id', valuePointer: '/amount' } }],
});
const open: PersistentDatasetService[] = [];
afterEach(async () => { for (const service of open.splice(0)) await service.close(); });

async function fixture(content = material()) {
  const parent = path.resolve(process.env.BES_DATA ?? 'output/data-F');
  await mkdir(parent, { recursive: true });
  // Keep synthetic originals and failure logs available for review.
  const root = await mkdtemp(path.join(parent, 'validator-'));
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project-f' }] }));
  const materials = new FileMaterialService(root);
  const draft = await materials.createDraft('project-f', 'human');
  await materials.updateDraft('project-f', draft.draftId, 0, content, 'human');
  const revision = await materials.publish('project-f', draft.draftId, 1, 'agent');
  const binding: ExecutionBinding = { schemaVersion: 1, executionId: 'execution-f', projectId: 'project-f', materialRevisionId: revision.revisionId,
    materialContentHash: revision.contentHash, codeFingerprint: 'code-v1', inputFingerprint: 'input-v1', environmentRef: 'synthetic-node', mode: 'from-start-validation' };
  const data = await PersistentDatasetService.open(root, binding); open.push(data);
  const identity = { executionId: binding.executionId, attemptId: 'attempt-1', datasetId: 'orders' };
  const docs = new Map<string, SourceDocument>();
  for (let i = 0; i < 2; i++) docs.set(`source-${i + 1}`, { sourceRef: `source-${i + 1}`, scope: { executionId: binding.executionId, attemptId: identity.attemptId, recordingId: 'recording-f' }, capturedAt: '2026-09-26T00:00:00Z',
    requestUrl: `${sourceUrl}&page=${i + 1}`, content: { status: 'present', value: { page: i + 1, total: 2, hasNext: i === 0, items: [output[i]] } }, representation: 'network-json', display: 'unknown' });
  const request: ValidationRequest = { attemptId: identity.attemptId, snapshotVerified: true, executedCodeFingerprint: 'code-v1', executedInputFingerprint: 'input-v1', assertions: [] };
  const validator = (reviews?: ReviewReader) => new ValidatorService(materials, data, { read: async ref => docs.get(ref) }, reviews);
  async function append(records: JsonValue[] = output, refs = ['source-1', 'source-2'], status: 'complete' | 'partial' = 'complete') {
    await data.begin(identity);
    await data.append({ ...identity, batchId: 'batch-1', records, provenance: { origin: 'browser', sourceRefs: refs } });
    await data.finish({ ...identity, status, committedBatches: 1, committedRecords: records.length, pagination: { complete: status === 'complete', pages: 99, terminalReason: 'script says done' } });
  }
  return { root, materials, revision, draft, binding, data, identity, docs, request, validator, append };
}

describe('fixed material validation using real B/C stores', () => {
  it('passes complete original contents without any script assertions and keeps published material a candidate', async () => {
    const f = await fixture(); await f.append();
    const report = await f.validator().validate(f.request);
    expect(report.overall).toBe('pass'); expect(report.materialStatus).toBe('candidate');
    expect(report.requirements[0].scriptAssertions).toEqual([]);
    expect(report.requirements[0].evidence.some(e => e.status === 'reference-exists')).toBe(true);
    expect(report.requirements[0].evidence.some(e => e.status === 'content-verified')).toBe(true);
    expect(report.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(report)));
    expect(report.requirements[0].humanReviews).toEqual([]);
  });
  it('cannot remove a fixed user requirement by deleting it from script reports or publishing V2', async () => {
    const content = material(); content.requirements.push({ id: 'account', description: 'Account nickname', dataset: 'account', fieldIds: [], rules: [{ type: 'required', field: 'nickname' }] });
    const f = await fixture(content); await f.append();
    const latest = await f.materials.getDraft('project-f', f.draft.draftId);
    await f.materials.updateDraft('project-f', latest.draftId, latest.draftRevision, material(), 'human');
    await f.materials.publish('project-f', latest.draftId, latest.draftRevision + 1, 'human');
    const report = await f.validator().validate(f.request);
    expect(report.requirements.map(r => r.requirementId)).toEqual(['all-orders', 'account']);
    expect(report.overall).not.toBe('pass'); expect(report.binding.materialRevisionId).toBe(f.revision.revisionId);
    expect(report.requirements[1].coverage).toBe('missing');
  });
  it('rejects a first page self-reported complete and retains its useful partial data', async () => {
    const f = await fixture(); await f.append([output[0]], ['source-1']);
    f.request.assertions = [{ requirementId: 'all-orders', name: 'everything', verdict: 'pass', sourceRefs: ['source-1'] }];
    const report = await f.validator().validate(f.request);
    expect(report.overall).toBe('inconclusive'); expect(report.datasets[0].inspectedRecords).toBe(1);
    expect(report.requirements[0].checks.find(c => c.name === 'pagination-complete')?.reason).toMatch(/terminal page/);
    expect(report.requirements[0].evidence.some(e => e.status === 'script-declared')).toBe(true);
  });
  it('fails when captured complete pages contain a row omitted from output', async () => {
    const f = await fixture(); await f.append([output[0]]);
    const report = await f.validator().validate(f.request);
    expect(report.overall).toBe('fail');
    expect(report.requirements[0].checks.find(c => c.name === 'pagination-complete')?.reason).toMatch(/omits/);
  });
  it('does not accept unrelated IDs, URL filters, changed entity values or cross-attempt sources', async () => {
    const f = await fixture(); await f.append();
    f.docs.get('source-1')!.requestUrl = 'https://fixture.test/api/orders?filter=unpaid&page=1';
    expect((await f.validator().validate(f.request)).overall).not.toBe('pass');
    f.docs.get('source-1')!.requestUrl = `${sourceUrl}&page=1`;
    f.docs.get('source-1')!.scope.attemptId = 'older-attempt';
    const wrongAttempt = await f.validator().validate(f.request);
    expect(wrongAttempt.requirements[0].evidence.some(e => e.status === 'unrelated')).toBe(true);
    expect(wrongAttempt.overall).not.toBe('pass');
    f.docs.get('source-1')!.scope.attemptId = f.identity.attemptId;
    f.docs.get('source-1')!.content = { status: 'present', value: { page: 1, total: 2, hasNext: true, items: [{ id: 'o-1', amount: '999' }] } };
    expect((await f.validator().validate(f.request)).overall).toBe('fail');
  });
  it('separates page displayed masks, collector redaction and JSON values', async () => {
    const content = material(); content.fields[0].sourcePolicy = 'page-displayed';
    const f = await fixture(content); await f.append();
    expect((await f.validator().validate(f.request)).overall).toBe('inconclusive');
    f.docs.get('source-1')!.content = { status: 'redacted', reason: 'Collector privacy mask' };
    const report = await f.validator().validate(f.request);
    expect(report.requirements[0].evidence.some(e => e.reason.includes('redacted'))).toBe(true);
    expect(report.overall).not.toBe('pass');
  });
  it('does not infer output path from display name or source semantics from arbitrary script claims', async () => {
    const content = material(); delete content.fields[0].outputPath; delete content.fields[0].sourceProof;
    const f = await fixture(content); await f.append();
    const report = await f.validator().validate(f.request);
    expect(report.requirements[0].sourceVerdict).toBe('inconclusive');
    expect(report.requirements[0].checks.find(c => c.name === 'source:amount')?.reason).toMatch(/display name/);
  });
  it('fails a changed code hash and requires actual snapshot attestation', async () => {
    const f = await fixture(); await f.append();
    expect((await f.validator().validate({ ...f.request, executedCodeFingerprint: 'code-v2' })).version.verdict).toBe('fail');
    expect((await f.validator().validate({ ...f.request, snapshotVerified: false })).overall).toBe('inconclusive');
  });
  it('preserves partial status and read errors without turning them into empty success', async () => {
    const f = await fixture(); await f.append([output[0]], ['source-1'], 'partial');
    const report = await f.validator().validate(f.request);
    expect(report.coverage).toBe('partial'); expect(report.datasets[0].status).toBe('partial');
    expect(report.datasets[0].inspectedRecords).toBe(1); expect(report.overall).not.toBe('pass');
    const reader = new ValidatorService(f.materials, f.data, { read: async () => { throw new Error('original truncated'); } });
    expect((await reader.validate(f.request)).requirements[0].evidence.some(e => e.reason.includes('original truncated'))).toBe(true);
  });
  it('keeps human acceptance separate from machine failure and ignores reviews for another version', async () => {
    const f = await fixture(); await f.append([output[0]]);
    const review = { id: 'review-1', requirementId: 'all-orders', decision: 'accept' as const, reason: 'Exception accepted by human', materialRevisionId: f.binding.materialRevisionId, materialContentHash: f.binding.materialContentHash, codeFingerprint: f.binding.codeFingerprint, inputFingerprint: f.binding.inputFingerprint, executionId: f.binding.executionId, attemptId: f.identity.attemptId };
    const report = await f.validator({ read: async () => [review, { ...review, id: 'old', codeFingerprint: 'old' }] }).validate(f.request);
    expect(report.overall).toBe('fail'); expect(report.requirements[0].humanReviews).toEqual([review]);
  });
  it('does not relabel reused prior-attempt data as current content verification', async () => {
    const f = await fixture(); await f.append();
    const identity = { ...f.identity, attemptId: 'attempt-2' };
    await f.data.begin(identity);
    const batch: DatasetBatch = { ...identity, batchId: 'reuse', records: output, provenance: { origin: 'browser', sourceRefs: ['source-1', 'source-2'] }, reusedFrom: { ...f.identity, batchId: 'batch-1', validityEvidenceRefs: ['script-validity-claim'] } };
    await f.data.append(batch); await f.data.finish({ ...identity, status: 'complete', committedBatches: 1, committedRecords: 2 });
    const report = await f.validator().validate({ ...f.request, attemptId: 'attempt-2' });
    expect(report.overall).not.toBe('pass'); expect(report.requirements[0].checks.some(c => c.reason.includes('prior-attempt'))).toBe(true);
  });
  it('rejects insufficient report budget explicitly instead of omitting requirements', async () => {
    const f = await fixture(); await f.append();
    await expect(f.validator().validate(f.request, { maxBytes: 1024, limit: 10 })).rejects.toMatchObject({ code: 'REPORT_LIMIT', statusCode: 413 });
  });
  it('reads UTF-8 Chinese and emoji across 16 KiB source chunks and detects original corruption', async () => {
    const f = await fixture();
    const runDir = path.join(f.root, 'runs', 'recording-f');
    const store = await EvidenceStore.create(runDir, { id: 'recording-f', projectId: 'project-f', kind: 'validate', mode: 'synthetic', objective: 'F reader integration' });
    const refs: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const artifact = await store.putArtifact({ kind: 'response-body', mediaType: 'application/json', data: JSON.stringify({ page: i + 1, total: 2, hasNext: i === 0, items: [output[i]], padding: '中文🙂'.repeat(4000) }), source: { requestKey: `request-${i}`, url: `${sourceUrl}&page=${i + 1}` } });
        refs.push(artifact.id);
      }
    } finally { await store.close(); }
    await f.append(output, refs);
    const reader = new EvidenceReader(runDir);
    const source = new CapturedJsonSourceReader(async ref => refs.includes(ref) ? { reader, scope: { executionId: f.binding.executionId, attemptId: f.identity.attemptId, recordingId: 'recording-f' } } : undefined);
    const original = await source.read(refs[0], { maxBytes: 65536, limit: 1 });
    expect(original?.content).toEqual({ status: 'present', value: { page: 1, total: 2, hasNext: true, items: [output[0]], padding: '中文🙂'.repeat(4000) } });
    const report = await new ValidatorService(f.materials, f.data, source).validate(f.request);
    expect(report.overall).toBe('pass');
    await expect(source.read(refs[0], { maxBytes: 1024, limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    const raw = await reader.artifactMetadata(refs[0]);
    await writeFile(path.join(runDir, raw.path!), 'tampered');
    const damaged = await new ValidatorService(f.materials, f.data, source).validate(f.request);
    expect(damaged.overall).not.toBe('pass');
    expect(damaged.requirements[0].evidence.some(e => /integrity|hash/i.test(e.reason))).toBe(true);
  });
  it('treats captured privacy replacements as redacted instead of verifying matching mask strings', async () => {
    const f = await fixture();
    const runDir = path.join(f.root, 'runs', 'recording-redacted');
    const store = await EvidenceStore.create(runDir, { id: 'recording-redacted', projectId: 'project-f', kind: 'validate', mode: 'synthetic', objective: 'Capture privacy metadata' });
    const refs: string[] = [], masked = output.map(row => ({ ...row, amount: '[redacted]' }));
    try {
      for (let i = 0; i < 2; i++) {
        const artifact = await store.putArtifact({ kind: 'response-body', mediaType: 'application/json', data: JSON.stringify({ page: i + 1, total: 2, hasNext: i === 0, items: [masked[i]] }), source: { requestKey: `request-${i}`, url: `${sourceUrl}&page=${i + 1}` }, metadata: i === 0 ? { privacyRedacted: true } : { representation: 'privacy-redacted-response' } });
        refs.push(artifact.id);
      }
    } finally { await store.close(); }
    await f.append(masked, refs);
    const reader = new EvidenceReader(runDir);
    const source = new CapturedJsonSourceReader(async ref => refs.includes(ref) ? { reader, scope: { executionId: f.binding.executionId, attemptId: f.identity.attemptId, recordingId: 'recording-redacted' } } : undefined);
    for (const ref of refs) expect((await source.read(ref, { maxBytes: 65536, limit: 1 }))?.content.status).toBe('redacted');
    const report = await new ValidatorService(f.materials, f.data, source).validate(f.request);
    expect(report.overall).toBe('inconclusive');
    expect(report.requirements[0].evidence.some(e => e.status === 'content-verified')).toBe(false);
    expect(report.requirements[0].evidence.filter(e => e.reason.includes('redacted'))).toHaveLength(2);
  });
  it('accepts an explicitly empty root output pointer and applies its frozen field type', async () => {
    const content = material(); content.fields[0].outputPath = ''; content.fields[0].valueType = 'object'; content.fields[0].sourceProof!.valuePointer = '';
    const f = await fixture(content); await f.append();
    const report = await f.validator().validate(f.request);
    expect(report.overall).toBe('pass');
    expect(report.requirements[0].checks.find(c => c.name === 'field-type:amount')?.verdict).toBe('pass');
    content.fields[0].valueType = 'string';
    const wrongType = await fixture(content); await wrongType.append();
    const failed = await wrongType.validator().validate(wrongType.request);
    expect(failed.overall).toBe('fail');
    expect(failed.requirements[0].checks.find(c => c.name === 'field-type:amount')?.verdict).toBe('fail');
  });
  it('selects each real step attempt explicitly and rejects mixed/latest identity guesses', async () => {
    const f = await fixture();
    const identity = { ...f.identity, attemptId: 'orders-step-attempt' };
    await f.data.begin(identity);
    await f.data.append({ ...identity, batchId: 'step-output', records: output, provenance: { origin: 'browser', sourceRefs: ['source-1', 'source-2'] } });
    await f.data.finish({ ...identity, status: 'complete', committedBatches: 1, committedRecords: 2 });
    for (const doc of f.docs.values()) doc.scope.attemptId = identity.attemptId;
    const request = { ...f.request, attemptId: 'workflow-attempt', datasetIdentities: [identity] };
    const report = await f.validator().validate(request);
    expect(report.overall).toBe('pass'); expect(report.attemptId).toBe('workflow-attempt'); expect(report.datasets[0].identity.attemptId).toBe(identity.attemptId);
    expect((await f.validator().validate({ ...request, datasetIdentities: [] })).overall).not.toBe('pass');
    await expect(f.validator().validate({ ...request, datasetIdentities: [identity, { ...identity, attemptId: 'latest' }] })).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await expect(f.validator().validate({ ...request, datasetIdentities: [{ ...identity, executionId: 'foreign' }] })).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
  });
  it('can verify a pagination-only requirement from content without requiring invented fields', async () => {
    const content = material(); content.requirements[0].fieldIds = []; content.fields = [];
    const f = await fixture(content); await f.append();
    expect((await f.validator().validate(f.request)).overall).toBe('pass');
  });
});
