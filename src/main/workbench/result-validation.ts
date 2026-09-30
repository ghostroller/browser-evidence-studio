import { BROWSER_RESULT_BUDGET, BROWSER_RESULT_METHODS, type BrowserResultRequest } from '../../contracts/browser-results';
import { executionId } from '../../runner/datasets';
import { WorkbenchError } from './errors';
import { checkJsonBudget, exactKeys, identifier, record, textField } from './validation';

const methods = new Set<string>(BROWSER_RESULT_METHODS);
export const isResultMethod = (method: unknown): boolean => typeof method === 'string' && methods.has(method);
function integer(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new WorkbenchError('invalid_request');
}
function oneOf(value: unknown, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) throw new WorkbenchError('invalid_request');
}
export function parseResultRequest(value: unknown): BrowserResultRequest {
  checkJsonBudget(value, BROWSER_RESULT_BUDGET.depth, BROWSER_RESULT_BUDGET.nodes);
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === 'object') { if (!Array.isArray(item)) record(item); pending.push(...Object.values(item)); }
    else if (typeof item === 'number' && !Number.isFinite(item)) throw new WorkbenchError('invalid_request');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > BROWSER_RESULT_BUDGET.requestBytes) throw new WorkbenchError('invalid_request');
  const envelope = record(value); exactKeys(envelope, ['instanceId', 'method', 'body']); identifier(envelope.instanceId);
  if (!isResultMethod(envelope.method)) throw new WorkbenchError('invalid_request');
  const method = String(envelope.method), body = record(envelope.body);
  const required = ['projectId'], optional: string[] = [];
  if (method !== 'projectExecutions') required.push('executionId');
  if (!['execution', 'executionReport'].includes(method)) optional.push('limit', 'maxBytes', 'cursor');
  if (['executionReport', 'executionReportItems'].includes(method)) required.push('reportId');
  if (method === 'executionItems') { required.push('collection'); oneOf(body.collection, ['steps', 'datasets']); }
  if (method === 'executionReportItems') { required.push('collection'); oneOf(body.collection, ['requirements', 'datasets']); }
  if (['datasetBatches', 'datasetRecords'].includes(method)) required.push('attemptId', 'datasetId');
  if (method === 'datasetRecords') {
    required.push('batchId'); optional.push('fields', 'entity');
    if (body.fields !== undefined) {
      if (!Array.isArray(body.fields) || body.fields.length > 64) throw new WorkbenchError('invalid_request');
      body.fields.forEach(field => textField(field, 128, true));
    }
    if (body.entity !== undefined) { const entity = record(body.entity); exactKeys(entity, ['field', 'equals']); textField(entity.field, 128, true); }
  }
  exactKeys(body, required, optional);
  for (const key of ['projectId', 'executionId', 'attemptId', 'datasetId', 'batchId', 'reportId']) {
    if (body[key] !== undefined) { try { executionId(identifier(body[key])); } catch { throw new WorkbenchError('invalid_request'); } }
  }
  if (body.limit !== undefined) integer(body.limit, 1, 100);
  if (body.maxBytes !== undefined) integer(body.maxBytes, 1024, 28_672);
  if (body.cursor !== undefined) textField(body.cursor, 4096, true);
  return structuredClone(value) as BrowserResultRequest;
}
