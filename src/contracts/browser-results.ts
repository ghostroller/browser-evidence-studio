/** Read-only result surface. No execution start, assessment, review, replay or
 * host metadata is granted by this contract. Existing grants do not include it. */
import type { ExecutionBinding, ExecutionMode } from './execution';
import type { BoundedPage } from './recording';
import type { ExecutionSummary, ReportSummary, StepSummary, DatasetSummary, ProjectScope, ProjectReadBudget, WorkbenchProjectMethods } from './workbench-project';

export const BROWSER_RESULT_METHODS = [
  'projectExecutions', 'execution', 'executionItems', 'datasetBatches', 'datasetRecords',
  'executionReports', 'executionReport', 'executionReportItems',
] as const;
export type BrowserResultMethod = typeof BROWSER_RESULT_METHODS[number];
export type ResultReadMethod = Exclude<BrowserResultMethod, 'projectExecutions'>;
export interface BrowserExecutionListItem {
  executionId: string; status: string; startedAt: string; finishedAt?: string;
  materialRevisionId: string; mode: ExecutionMode;
}
export type BrowserExecutionBinding = Omit<ExecutionBinding, 'environmentRef'>;
export type BrowserExecutionSummary = Omit<ExecutionSummary, 'binding'> & { binding: BrowserExecutionBinding };
export type BrowserReportSummary = Omit<ReportSummary, 'binding'> & { binding: BrowserExecutionBinding };
export type BrowserStepSummary = Pick<StepSummary, 'identity' | 'state' | 'occurredAt' | 'resultValueState' | 'dependencies' | 'handoffId'> & {
  error?: { name: string; message: string };
};
export type BrowserResultMethods = Pick<WorkbenchProjectMethods, 'datasetRecords' | 'executionReportItems'> & {
  projectExecutions: { input: ProjectScope & ProjectReadBudget; result: BoundedPage<BrowserExecutionListItem> };
  execution: { input: WorkbenchProjectMethods['execution']['input']; result: BrowserExecutionSummary };
  executionItems: { input: WorkbenchProjectMethods['executionItems']['input']; result: BoundedPage<BrowserStepSummary | DatasetSummary> };
  datasetBatches: { input: WorkbenchProjectMethods['datasetBatches']['input']; result: BoundedPage<Omit<WorkbenchProjectMethods['datasetBatches']['result']['items'][number], 'artifactId'>> };
  executionReport: { input: WorkbenchProjectMethods['executionReport']['input']; result: BrowserReportSummary };
  executionReports: { input: WorkbenchProjectMethods['executionReports']['input']; result: BoundedPage<BrowserReportSummary> };
};
export type BrowserResultInput<M extends BrowserResultMethod> = BrowserResultMethods[M]['input'];
export type BrowserResultResult<M extends BrowserResultMethod> = BrowserResultMethods[M]['result'];
export type BrowserResultRequest = { [M in BrowserResultMethod]: { instanceId: string; method: M; body: BrowserResultInput<M> } }[BrowserResultMethod];
export const BROWSER_RESULT_BUDGET = Object.freeze({ requestBytes: 16_384, responseBytes: 65_536, depth: 24, nodes: 8_192 });
