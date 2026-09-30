import type { BrowserResultRequest } from '../../contracts/browser-results';
import { BROWSER_RESULT_BUDGET } from '../../contracts/browser-results';
import type { BoundedPage, HistoricalTarget } from '../../contracts/recording';
import type { ValidationReport, ValidatedRequirement, FieldDiagnostic } from '../../validator/types';
import type { ExecutionSummary, ReportSummary, StepSummary, DatasetSummary } from '../../contracts/workbench-project';
import type { ExecutionBinding, BatchReceipt } from '../../contracts/execution';
import type { DatasetRecord } from '../../runner/datasets';
import { DatasetError } from '../../runner/datasets';
import { MaterialError } from '../../materials/errors';
import { EvidenceError } from '../../evidence/contracts';
import { measured } from '../../materials/paging';
import { StudioError } from '../../shared/errors';
import { ProjectExecutions } from '../services/project-executions';
import { materialBudget } from '../services/project-materials';
import { WorkbenchError } from './errors';
import { checkJsonBudget } from './validation';

export interface ResultReadAccess { authorize(): void }
export interface BrowserResultPort { execute(request: BrowserResultRequest, access: ResultReadAccess): Promise<unknown> }
function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as Pick<T, K>;
}
/** Diagnostic text can originate in host exceptions. Never forward stacks,
 * console output, filesystem paths or credential-like diagnostic fragments.
 * Actual result values are separate business JSON and remain unchanged. */
function diagnostic(text: string): string {
  if (typeof text !== 'string') throw new WorkbenchError('unavailable');
  // All three ValidatorService exception-bearing reason paths are fixed here,
  // regardless of the error body's spelling or credential format.
  if (/(?:Human review|Dataset|Original-source) read failed:/i.test(text)) return '原件读取失败；详细异常保留于宿主诊断，未将失败当作空值。';
  // Do not try to partially redact unknown exception syntax: JSON quoting,
  // nested causes and Basic authentication can leave secret suffixes behind.
  if (/(?:file:\/\/|[A-Za-z]:[\\/]|(^|[\s"'(=:])\/(?!\/)|\b(?:bearer|basic|token|password|secret|authorization|cookie|credential|api[_-]?key)\b)/i.test(text)) return '诊断包含宿主路径或敏感信息；详情保留于宿主原件，不在浏览器连接中展示。';
  return text;
}
const binding = (value: ExecutionBinding) => pick(value, ['schemaVersion', 'executionId', 'projectId', 'materialRevisionId', 'materialContentHash', 'codeFingerprint', 'inputFingerprint', 'mode']);
const datasetIdentity = <T extends { executionId: string; attemptId: string; datasetId: string }>(value: T) => pick(value, ['executionId', 'attemptId', 'datasetId']);
const stepIdentity = (value: StepSummary['identity']) => pick(value, ['executionId', 'stepId', 'attemptId', 'entityKey']);
const issue = <T extends { code: string; message: string }>(value: T) => ({ code: value.code, message: diagnostic(value.message) });
function execution(value: ExecutionSummary) {
  return { ...pick(value, ['runId', 'validationId', 'pageId', 'startedAt', 'finishedAt', 'status', 'workflowAttemptId', 'codeFingerprint', 'inputFingerprint', 'snapshotVerified']), binding: binding(value.binding),
    counts: pick(value.counts, ['steps', 'datasets']), ...(value.datasetCatalogIssues ? { datasetCatalogIssues: value.datasetCatalogIssues.map(item => ({ entry: diagnostic(item.entry), ...issue(item) })) } : {}) };
}
function step(value: StepSummary) {
  return { ...pick(value, ['state', 'occurredAt', 'resultValueState', 'handoffId']), identity: stepIdentity(value.identity),
    ...(value.error ? { error: { name: 'ExecutionError', message: '步骤记录了原始错误；详细异常保留于宿主原件，不在浏览器连接中展示。' } } : {}),
    ...(value.dependencies ? { dependencies: value.dependencies.map(stepIdentity) } : {}) };
}
function dataset(value: DatasetSummary) {
  return { ...datasetIdentity(value), ...pick(value, ['status', 'committedBatches', 'committedRecords']), ...(value.diagnostic ? { diagnostic: issue(value.diagnostic) } : {}) };
}
function fieldDiagnostic(value: FieldDiagnostic) {
  return { ...pick(value, ['fieldId', 'outputPath', 'entity', 'actual', 'interpretation', 'code', 'rawText', 'expected', 'sourceRef']), ...(value.target ? { target: target(value.target) } : {}) };
}
function position(value: NonNullable<FieldDiagnostic['target']>['position']) { return pick(value, ['recordingId', 'pageId', 'documentId', 'streamEpoch', 'eventSeq', 'sourceTimeMs']); }
function target(value: HistoricalTarget) {
  return value.kind === 'dom-node' ? { ...pick(value, ['kind', 'frameId', 'mirrorScopeId', 'nodeId']), position: position(value.position) }
    : { ...pick(value, ['kind', 'artifactId']), rect: pick(value.rect, ['x', 'y', 'width', 'height']), position: position(value.position) };
}
function check(value: ValidationReport['version']) { return { name: value.name, verdict: value.verdict, reason: diagnostic(value.reason), ...(value.diagnostic ? { diagnostic: fieldDiagnostic(value.diagnostic) } : {}) }; }
function report(value: ReportSummary) {
  return { ...pick(value, ['schemaVersion', 'attemptId', 'materialStatus', 'overall', 'coverage', 'reportId', 'contentHash', 'returnedBytes']), binding: binding(value.binding), version: check(value.version),
    counts: pick(value.counts, ['requirements', 'datasets']), reasons: value.reasons.map(diagnostic) };
}
function requirement(value: ValidatedRequirement) {
  return { ...pick(value, ['requirementId', 'verdict', 'coverage', 'schemaVerdict', 'sourceVerdict', 'diagnosticsTruncated', 'businessCoverage']),
    checks: value.checks.map(check), evidence: value.evidence.map(item => ({ ...pick(item, ['status', 'sourceRefs']), reason: diagnostic(item.reason) })),
    scriptAssertions: value.scriptAssertions.map(item => ({ ...pick(item, ['requirementId', 'name', 'verdict', 'sourceRefs']), ...(item.message === undefined ? {} : { message: diagnostic(item.message) }) })),
    humanReviews: value.humanReviews.map(item => pick(item, ['id', 'requirementId', 'decision', 'reason', 'materialRevisionId', 'materialContentHash', 'codeFingerprint', 'inputFingerprint', 'executionId', 'attemptId'])),
    ...(value.fieldDiagnostics ? { fieldDiagnostics: value.fieldDiagnostics.map(item => ({ ...fieldDiagnostic(item), identity: datasetIdentity(item.identity), ...pick(item, ['batchId', 'recordIndex', 'verdict']), reason: diagnostic(item.reason) })) } : {}),
    ...(value.materialContext ? { materialContext: { description: value.materialContext.description, fields: value.materialContext.fields.map(field => ({ ...pick(field, ['id', 'name']),
      ...(field.target ? { target: target(field.target) } : {}), ...(field.example ? { example: { ...pick(field.example, ['id', 'title', 'notes']), anchor: position(field.example.anchor) } } : {}) })) } } : {}) };
}
function reportDataset(value: ValidationReport['datasets'][number]) { return { identity: datasetIdentity(value.identity), ...pick(value, ['status', 'committedRecords', 'inspectedRecords']), reasons: value.reasons.map(diagnostic) }; }
function page<T, U>(value: BoundedPage<T>, project: (item: T) => U) {
  return measured<BoundedPage<U>>({ items: value.items.map(project), outputTruncated: value.outputTruncated, ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) });
}

/** Reuses the actual domain reader; no generic Studio dispatch, source replay,
 * assessment or writer is reachable. Read results are withheld after expiry. */
export function createBrowserResultPort(executions: ProjectExecutions): BrowserResultPort {
  return { execute: async (request, access) => {
    try {
      access.authorize();
      const { method, body } = request, budget = materialBudget(body as { maxBytes?: number; limit?: number; cursor?: string });
      let result: unknown;
      switch (method) {
        case 'projectExecutions': result = await executions.list(body.projectId, budget, access.authorize); break;
        case 'execution': result = execution(await executions.summary(body.projectId, body.executionId)); break;
        case 'executionItems': {
          const source = await executions.items(body.projectId, body.executionId, body.collection, budget);
          result = body.collection === 'steps' ? page(source as BoundedPage<StepSummary>, step) : page(source as BoundedPage<DatasetSummary>, dataset); break;
        }
        case 'datasetBatches': result = page(await executions.batches(body.projectId, datasetIdentity(body), budget), (item: BatchReceipt) => ({ ...datasetIdentity(item), ...pick(item, ['batchId', 'contentHash', 'recordCount', 'durableAt', 'replayed']) })); break;
        case 'datasetRecords': result = page(await executions.records(body.projectId, datasetIdentity(body), body.batchId, { ...budget, ...pick(body, ['fields', 'entity']) }), (item: DatasetRecord) => pick(item, ['batchId', 'recordIndex', 'value', 'missingFields'])); break;
        case 'executionReport': result = report(await executions.reportSummary(body.projectId, body.executionId, body.reportId)); break;
        case 'executionReports': result = page(await executions.reports(body.projectId, body.executionId, budget), report); break;
        case 'executionReportItems': {
          const source = await executions.reportItems(body.projectId, body.executionId, body.reportId, body.collection, budget);
          result = body.collection === 'requirements' ? page(source as BoundedPage<ValidatedRequirement>, requirement) : page(source as BoundedPage<ValidationReport['datasets'][number]>, reportDataset); break;
        }
      }
      access.authorize();
      checkJsonBudget(result, BROWSER_RESULT_BUDGET.depth, BROWSER_RESULT_BUDGET.nodes);
      const maximum = ['execution', 'executionReport'].includes(method) ? BROWSER_RESULT_BUDGET.responseBytes : budget.maxBytes;
      if (Buffer.byteLength(JSON.stringify(result)) > maximum) throw new WorkbenchError('unavailable');
      return result;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      const status = error instanceof StudioError ? error.status : error instanceof DatasetError || error instanceof MaterialError || error instanceof EvidenceError ? error.statusCode : 500;
      throw new WorkbenchError(status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 400 || status === 422 ? 'invalid_request' : 'unavailable');
    }
  } };
}
