import type { BatchReceipt, DatasetIdentity, EvidenceAssessment, ExecutionBinding } from '@/contracts/execution';
import type { MaterialService } from '@/contracts/materials';
import type { ReadBudget } from '@/contracts/recording';
import type { JsonValue, Verdict } from '@/contracts/workflow';
import { materialContentHash } from '@/materials';
import { executionId } from '@/runner/datasets';
import { combine, pointer, ruleCheck } from './rules';
import { fieldProof, paginationProof, type SourceEntityIndex } from './proofs';
import type { Check, DatasetReader, ReviewReader, SourceDocument, SourceReader, ValidatedRequirement, ValidationReport, ValidationRequest } from './types';

export class ValidatorError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = 'ValidatorError'; }
}
interface LoadedRow { batchId: string; recordIndex: number; value: JsonValue }
interface LoadedDataset {
  identity: DatasetIdentity; rows: LoadedRow[]; complete: boolean; status: string; committedRecords: number;
  reasons: string[]; refs: Map<string, string[]>; reused: Set<string>;
}
const READ: ReadBudget = { maxBytes: 1024 * 1024, limit: 500 };
const MAX_ROWS = 10_000, MAX_BYTES = 16 * 1024 * 1024, MAX_READS = 500;
const errorText = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const check = (name: string, verdict: Verdict, reason: string): Check => ({ name, verdict, reason });

/** Reads a fixed material revision and durable attempts. It never accepts a replacement requirement set. */
export class ValidatorService {
  constructor(private readonly materials: Pick<MaterialService, 'revision'>, private readonly data: DatasetReader,
    private readonly sources?: SourceReader, private readonly reviews?: ReviewReader) {}

  async validate(request: ValidationRequest, budget: ReadBudget = READ): Promise<ValidationReport> {
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1024 || budget.maxBytes > READ.maxBytes || !Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.limit > 2000 || budget.cursor) throw new ValidatorError('INVALID_BUDGET', 'Validation accepts a 1 KiB–1 MiB report budget and 1–2000 requirements; no cursor');
    executionId(request.attemptId);
    if ((request.assertions?.length ?? 0) > 2000 || size(request) > 1024 * 1024) throw new ValidatorError('INPUT_LIMIT', 'Validation assertions exceed the bounded input limit', 413);
    // Snapshot caller-owned structures before the first await.
    request = structuredClone(request);
    const binding: ExecutionBinding = structuredClone(this.data.binding);
    const revision = await this.materials.revision(binding.projectId, binding.materialRevisionId, binding.materialContentHash);
    if (revision.projectId !== binding.projectId || revision.revisionId !== binding.materialRevisionId || revision.contentHash !== binding.materialContentHash || materialContentHash(revision.content) !== binding.materialContentHash) throw new ValidatorError('MATERIAL_MISMATCH', 'Loaded material does not match the immutable execution binding', 409);
    if (revision.content.requirements.length > budget.limit) throw new ValidatorError('REPORT_LIMIT', 'Requirement count exceeds the requested report limit; increase it explicitly', 413);
    const datasets = new Map<string, LoadedDataset>();
    const names = new Set(revision.content.requirements.flatMap(r => [r.dataset, ...r.rules.filter(x => x.type === 'reference').map(x => x.dataset)]).filter((x): x is string => Boolean(x)));
    if (names.size > 64) throw new ValidatorError('DATASET_LIMIT', 'At most 64 datasets can be inspected per validation', 413);
    const consumed = { bytes: 0, rows: 0, reads: 0 };
    const selected = new Map<string, DatasetIdentity>();
    if ((request.datasetIdentities?.length ?? 0) > 64) throw new ValidatorError('DATASET_LIMIT', 'At most 64 dataset selections are allowed', 413);
    for (const identity of request.datasetIdentities ?? []) {
      executionId(identity.executionId); executionId(identity.attemptId); executionId(identity.datasetId);
      if (identity.executionId !== binding.executionId || selected.has(identity.datasetId)) throw new ValidatorError('INVALID_SELECTION', 'Select exactly one attempt per dataset within this execution');
      selected.set(identity.datasetId, identity);
    }
    for (const name of names) {
      const identity = selected.get(name) ?? { executionId: binding.executionId, attemptId: request.attemptId, datasetId: name };
      if (request.datasetIdentities && !selected.has(name)) datasets.set(name, { identity, rows: [], complete: false, status: 'unselected', committedRecords: 0, reasons: ['No explicit attempt was selected for this required dataset'], refs: new Map(), reused: new Set() });
      else datasets.set(name, await this.load(identity, consumed));
    }
    const schemaData = new Map([...datasets].map(([name, d]) => [name, { rows: d.rows.map(r => r.value), complete: d.complete }]));
    const version = request.executedCodeFingerprint !== undefined && request.executedCodeFingerprint !== binding.codeFingerprint || request.executedInputFingerprint !== undefined && request.executedInputFingerprint !== binding.inputFingerprint
      ? check('executed-version', 'fail', 'Executed code or input fingerprint differs from the fixed binding')
      : request.snapshotVerified && request.executedCodeFingerprint === binding.codeFingerprint && request.executedInputFingerprint === binding.inputFingerprint
        ? check('executed-version', 'pass', 'Host-verified execution snapshot and input match the fixed binding')
        : check('executed-version', 'inconclusive', 'Actual executed snapshot/input identity has not been independently verified');
    const reasons: string[] = [];
    let humanReviews: Awaited<ReturnType<ReviewReader['read']>> = [];
    if (this.reviews) {
      try {
        humanReviews = await this.reviews.read(binding, request.attemptId, READ);
        if (humanReviews.length > 2000 || size(humanReviews) > READ.maxBytes) throw new ValidatorError('REVIEW_LIMIT', 'Review response exceeds budget', 413);
        humanReviews = humanReviews.filter(r => r.executionId === binding.executionId && r.attemptId === request.attemptId && r.materialRevisionId === binding.materialRevisionId && r.materialContentHash === binding.materialContentHash && r.codeFingerprint === binding.codeFingerprint && r.inputFingerprint === binding.inputFingerprint);
      } catch (error) { reasons.push(`Human review read failed: ${errorText(error)}`); humanReviews = []; }
    }
    const cache = new Map<string, SourceDocument | undefined>();
    const sourceEntityIndex: SourceEntityIndex = new Map();
    const requirements: ValidatedRequirement[] = [];
    for (const requirement of revision.content.requirements) {
      const dataset = requirement.dataset ? datasets.get(requirement.dataset) : undefined;
      const checks: Check[] = [], evidence: EvidenceAssessment[] = [];
      const documents = new Map<string, SourceDocument>();
      if (dataset) for (const ref of new Set([...dataset.refs.values()].flat())) {
        const source = await this.readSource(ref, dataset.identity, cache, consumed);
        evidence.push(source.assessment);
        if (source.document) documents.set(ref, source.document);
      }
      const scriptAssertions = (request.assertions ?? []).filter(x => x.requirementId === requirement.id);
      for (const assertion of scriptAssertions) evidence.push({ status: 'script-declared', sourceRefs: assertion.sourceRefs, reason: `Script assertion ${assertion.name}: ${assertion.verdict}; it is not an independent check` });
      if (!dataset) checks.push(check('dataset', 'not-run', 'No dataset is defined for this requirement; script assertions cannot establish acceptance'));
      else {
        if (!dataset.complete) checks.push(check('dataset-coverage', 'inconclusive', dataset.reasons.join('; ') || `Dataset status is ${dataset.status}`));
        for (const rule of requirement.rules) {
          if (rule.type !== 'pagination-complete') checks.push(ruleCheck(rule, dataset.rows.map(r => r.value), dataset.complete, schemaData));
          else if (rule.proof && dataset.complete && !dataset.reused.size) {
            const proof = paginationProof(rule, dataset.rows.map(r => r.value), [...documents.values()]);
            checks.push(proof);
            evidence.push({ status: proof.verdict === 'pass' ? 'content-verified' : 'inconclusive', sourceRefs: [...documents.keys()], reason: proof.reason });
          }
          else checks.push(check('pagination-complete', 'inconclusive', 'A script complete flag, page count or terminalReason does not prove that the last page was collected; independent task-specific terminal evidence is required'));
        }
      }
      const sourceChecks: Check[] = [];
      const fields = revision.content.fields.filter(f => requirement.fieldIds.includes(f.id));
      for (const materialField of fields) {
        if (!dataset || !dataset.rows.length) { sourceChecks.push(check(`source:${materialField.id}`, 'inconclusive', 'No output rows to compare with source content')); continue; }
        if (materialField.valueType && materialField.outputPath) {
          const values = dataset.rows.map(row => pointer(row.value, materialField.outputPath!));
          const matches = values.every(v => v.exists && (materialField.valueType === 'null' ? v.value === null : materialField.valueType === 'array' ? Array.isArray(v.value) : materialField.valueType === 'object' ? v.value !== null && typeof v.value === 'object' && !Array.isArray(v.value) : typeof v.value === materialField.valueType));
          checks.push(check(`field-type:${materialField.id}`, matches ? dataset.complete ? 'pass' : 'inconclusive' : 'fail', `Frozen output ${materialField.outputPath} must be ${materialField.valueType}`));
        }
        const verdicts: Verdict[] = [];
        const explanations = new Set<string>();
        for (const row of dataset.rows) {
          const docs = (dataset.refs.get(row.batchId) ?? []).flatMap(ref => documents.has(ref) ? [documents.get(ref)!] : []);
          const proof = dataset.reused.has(row.batchId)
            ? check(`source:${materialField.id}`, 'inconclusive', 'Reused prior-attempt data requires independent current validity proof')
            : fieldProof(materialField, row.value, docs, sourceEntityIndex);
          verdicts.push(proof.verdict); explanations.add(proof.reason);
        }
        const verdict = combine(verdicts);
        sourceChecks.push(check(`source:${materialField.id}`, verdict, [...explanations].join('; ')));
        if (verdict === 'pass') evidence.push({ status: 'content-verified', sourceRefs: [...documents.keys()], reason: `Frozen field ${materialField.id} matches original source values and entities` });
      }
      if (evidence.some(e => ['missing', 'unrelated', 'inconclusive'].includes(e.status))) sourceChecks.push(check('source-availability', 'inconclusive', 'Some declared source evidence is unavailable, unrelated or unreadable'));
      if (!fields.length && !evidence.some(e => e.status === 'content-verified')) sourceChecks.push(check('source', 'inconclusive', 'No frozen field content constraints are available; schema checks alone do not establish business acceptance'));
      const schemaVerdict = combine(checks.filter(c => c.name !== 'pagination-complete' && c.name !== 'dataset-coverage').map(c => c.verdict)), sourceVerdict = sourceChecks.length ? combine(sourceChecks.map(c => c.verdict)) : evidence.some(e => e.status === 'content-verified') ? 'pass' : 'inconclusive';
      requirements.push({ requirementId: requirement.id, verdict: combine([...checks.map(c => c.verdict), sourceVerdict, version.verdict]), coverage: dataset?.complete && checks.filter(c => c.name === 'pagination-complete').every(c => c.verdict === 'pass') ? 'complete' : dataset?.rows.length ? 'partial' : 'missing',
        evidence, checks: [...checks, ...sourceChecks], schemaVerdict, sourceVerdict, scriptAssertions,
        humanReviews: humanReviews.filter(r => r.requirementId === requirement.id) });
    }
    const report: ValidationReport = { schemaVersion: 1, binding, attemptId: request.attemptId, materialStatus: 'candidate',
      overall: combine(requirements.map(r => r.verdict)), coverage: requirements.length && requirements.every(r => r.coverage === 'complete') ? 'complete' : requirements.some(r => r.coverage !== 'missing') ? 'partial' : 'missing', version, requirements,
      datasets: [...datasets.values()].map(d => ({ identity: d.identity, status: d.status, committedRecords: d.committedRecords, inspectedRecords: d.rows.length, reasons: d.reasons })), reasons, returnedBytes: 0 };
    for (let i = 0; i < 4; i++) report.returnedBytes = size(report);
    if (report.returnedBytes > budget.maxBytes) throw new ValidatorError('REPORT_LIMIT', 'Validation report exceeds maxBytes; no requirements were omitted', 413);
    return report;
  }

  private async load(identity: DatasetIdentity, consumed: { bytes: number; rows: number; reads: number }): Promise<LoadedDataset> {
    const d: LoadedDataset = { identity, rows: [], complete: false, status: 'unavailable', committedRecords: 0, reasons: [], refs: new Map(), reused: new Set() };
    try {
      const summary = await this.data.summary(identity);
      d.status = summary.status; d.committedRecords = summary.committedRecords;
      let cursor: string | undefined, receipts = 0;
      const seen = new Set<string>();
      do {
        if (++consumed.reads > MAX_READS) throw new ValidatorError('READ_LIMIT', 'Validation reached 500 bounded reads', 413);
        const page = await this.data.batches(identity, { ...READ, cursor });
        consumed.bytes += size(page);
        if (consumed.bytes > MAX_BYTES) throw new ValidatorError('READ_LIMIT', 'Validation reached its 16 MiB aggregate read budget', 413);
        for (const receipt of page.items) {
          if (seen.has(receipt.batchId)) throw new ValidatorError('DUPLICATE_BATCH', 'Duplicate receipt while reading the immutable batch boundary');
          seen.add(receipt.batchId); receipts++;
          await this.loadBatch(d, receipt, consumed);
        }
        if (page.outputTruncated && !page.nextCursor || page.nextCursor === cursor && page.nextCursor) throw new ValidatorError('INCOMPLETE_PAGE', 'Batch reader returned an incomplete or non-advancing cursor');
        cursor = page.nextCursor;
      } while (cursor);
      d.complete = summary.status === 'complete' && receipts === summary.committedBatches && d.rows.length === summary.committedRecords;
      if (!d.complete) d.reasons.push(`Durable dataset ${summary.status}; inspected ${receipts}/${summary.committedBatches} batches and ${d.rows.length}/${summary.committedRecords} records`);
      if (summary.completion?.pagination) d.reasons.push(`Script pagination declaration: ${JSON.stringify(summary.completion.pagination)}`);
    } catch (error) { d.reasons.push(`Dataset read failed: ${errorText(error)}`); }
    return d;
  }

  private async loadBatch(d: LoadedDataset, receipt: BatchReceipt, consumed: { bytes: number; rows: number; reads: number }): Promise<void> {
    if (++consumed.reads > MAX_READS) throw new ValidatorError('READ_LIMIT', 'Validation reached 500 bounded reads', 413);
    const metadata = await this.data.batchMetadata(d.identity, receipt.batchId, READ);
    if (!metadata.contentVerified || metadata.receipt.contentHash !== receipt.contentHash) throw new ValidatorError('BATCH_MISMATCH', 'Durable batch content does not match its receipt');
    d.refs.set(receipt.batchId, metadata.provenance.sourceRefs);
    if (metadata.reusedFrom) d.reused.add(receipt.batchId);
    consumed.bytes += size(metadata);
    let cursor: string | undefined;
    do {
      if (++consumed.reads > MAX_READS) throw new ValidatorError('READ_LIMIT', 'Validation reached 500 bounded reads', 413);
      const page = await this.data.records(d.identity, receipt.batchId, { ...READ, cursor });
      consumed.bytes += size(page); consumed.rows += page.items.length;
      if (consumed.bytes > MAX_BYTES || consumed.rows > MAX_ROWS) throw new ValidatorError('READ_LIMIT', 'Validation reached 16 MiB or 10,000 rows; retained prior inspected rows', 413);
      d.rows.push(...page.items);
      if (page.outputTruncated && !page.nextCursor || page.nextCursor === cursor && page.nextCursor) throw new ValidatorError('INCOMPLETE_PAGE', 'Record reader returned an incomplete or non-advancing cursor');
      cursor = page.nextCursor;
    } while (cursor);
  }

  private async readSource(ref: string, identity: DatasetIdentity, cache: Map<string, SourceDocument | undefined>, consumed: { reads: number; bytes: number }): Promise<{ document?: SourceDocument; assessment: EvidenceAssessment }> {
    const answer = (status: EvidenceAssessment['status'], reason: string, document?: SourceDocument) => ({ assessment: { status, sourceRefs: [ref], reason }, ...(document ? { document } : {}) });
    if (!this.sources) return answer('inconclusive', 'No trusted original-source reader is connected');
    try {
      if (!cache.has(ref)) {
        if (++consumed.reads > MAX_READS) return answer('inconclusive', 'Source read budget exhausted');
        const doc = await this.sources.read(ref, READ);
        consumed.bytes += size(doc ?? null);
        if (size(doc ?? null) > READ.maxBytes || consumed.bytes > MAX_BYTES) return answer('inconclusive', 'Source response exceeds explicit read budget');
        cache.set(ref, doc);
      }
      const doc = cache.get(ref);
      if (!doc) return answer('missing', 'Source reference was not found');
      if (doc.sourceRef !== ref || doc.scope.executionId !== identity.executionId || doc.scope.attemptId !== identity.attemptId) return answer('unrelated', 'Source belongs to a different execution or attempt');
      if (!doc.scope.recordingId || !Number.isFinite(Date.parse(doc.capturedAt))) return answer('inconclusive', 'Source recording identity or capture time is unavailable');
      if (doc.content.status !== 'present') return answer('inconclusive', `Source content is ${doc.content.status}; it is not an empty or null value`);
      return answer('reference-exists', 'Original source exists in this attempt; content semantics are evaluated separately', doc);
    } catch (error) { return answer('inconclusive', `Original-source read failed: ${errorText(error)}`); }
  }
}
