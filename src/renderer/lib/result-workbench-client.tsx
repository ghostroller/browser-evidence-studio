import type { BrowserResultInput, BrowserResultResult, ResultReadMethod, BrowserStepSummary } from '@/contracts/browser-results';
import type { WorkbenchClient } from '@/contracts/workbench';
import type { BoundedPage } from '@/contracts/recording';
import type { DatasetSummary, ExecutionCollection, ReportCollection, WorkbenchProjectMethods } from '@/contracts/workbench-project';
import type { ValidationReport } from '@/validator/types';

type Input<M extends ResultReadMethod> = Omit<BrowserResultInput<M>, 'projectId' | 'executionId'>;
type OptionalMethod = { [M in ResultReadMethod]: {} extends Input<M> ? M : never }[ResultReadMethod];
export interface ResultReadCall {
  <M extends ResultReadMethod>(method: M, body: BrowserResultInput<M>): Promise<BrowserResultResult<M>>;
}
export interface ScopedResultCall {
  <C extends ExecutionCollection>(method: 'executionItems', body: Input<'executionItems'> & { collection: C }): Promise<BoundedPage<C extends 'steps' ? BrowserStepSummary : DatasetSummary>>;
  <C extends ReportCollection>(method: 'executionReportItems', body: Input<'executionReportItems'> & { collection: C }): Promise<BoundedPage<ValidationReport[C][number]>>;
  <M extends ResultReadMethod>(method: M, body: Input<M>): Promise<BrowserResultResult<M>>;
  <M extends OptionalMethod>(method: M): Promise<BrowserResultResult<M>>;
}
export interface ResultWorkbenchClient { host: 'browser' | 'electron'; call: ResultReadCall; canRead(): boolean }
type NativeResultMethod = 'assessExecution' | 'reviewExecution' | 'historicalNode';
/** Only the Electron wrapper can supply these existing consequential actions. */
export interface NativeResultCall {
  <M extends NativeResultMethod>(method: M, body: Omit<WorkbenchProjectMethods[M]['input'], 'projectId' | 'executionId'>): Promise<WorkbenchProjectMethods[M]['result']>;
}
export function scopedResultCall(client: ResultWorkbenchClient, projectId: string, executionId: string): ScopedResultCall {
  return ((method: ResultReadMethod, body?: object) => client.call(method, { ...body, projectId, executionId } as BrowserResultInput<typeof method>)) as ScopedResultCall;
}
export function electronResultClient(client: WorkbenchClient): ResultWorkbenchClient {
  return { host: 'electron', call: client.call as ResultReadCall, canRead: () => true };
}
