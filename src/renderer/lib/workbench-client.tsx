import type { MaterialContent } from '@/contracts/materials';
import type { BoundedPage } from '@/contracts/recording';
import type { MaterialCollection, MaterialEntityCollection, MaterialEntityResult, ExecutionCollection, ReportCollection, StepSummary, DatasetSummary } from '@/contracts/workbench-project';
import type { ValidationReport } from '@/validator/types';
import React, { createContext, useContext } from 'react';
import type { NativePresentation, WorkbenchClient, WorkbenchInput, WorkbenchMethod, WorkbenchResult } from '@/contracts/workbench';

const WorkbenchContext = createContext<WorkbenchClient | null>(null);
export function WorkbenchClientProvider({ client, children }: { client: WorkbenchClient; children: React.ReactNode }) {
  return <WorkbenchContext.Provider value={client}>{children}</WorkbenchContext.Provider>;
}
export function useWorkbenchClient(): WorkbenchClient {
  const client = useContext(WorkbenchContext);
  if (!client) throw new Error('WorkbenchClientProvider is required');
  return client;
}
export class WorkbenchCapabilityError extends Error {
  constructor() { super('当前工作台连接不支持原生浏览器呈现。请使用 Electron 工作台。'); this.name = 'WorkbenchCapabilityError'; }
}
export function requireNativePresentation(client: WorkbenchClient): NativePresentation {
  if (!client.nativePresentation) throw new WorkbenchCapabilityError();
  return client.nativePresentation;
}

type RemoveScope<I, S> = I extends unknown ? Omit<I, keyof S> & Partial<Pick<I, Extract<keyof S, keyof I>>> : never;
type ScopedInput<M extends WorkbenchMethod, S> = RemoveScope<WorkbenchInput<M>, S>;
type ScopedOptional<S> = { [M in WorkbenchMethod]: {} extends ScopedInput<M, S> ? M : never }[WorkbenchMethod];
export interface ScopedWorkbenchCall<S> {
  <C extends MaterialCollection>(method: 'materialCollection', body: ScopedInput<'materialCollection', S> & { collection: C }): Promise<BoundedPage<MaterialContent[C][number]>>;
  <C extends MaterialEntityCollection>(method: 'materialEntity', body: ScopedInput<'materialEntity', S> & { collection: C }): Promise<Omit<MaterialEntityResult, 'item'> & { item: MaterialContent[C][number] }>;
  <C extends ExecutionCollection>(method: 'executionItems', body: ScopedInput<'executionItems', S> & { collection: C }): Promise<BoundedPage<C extends 'steps' ? StepSummary : DatasetSummary>>;
  <C extends ReportCollection>(method: 'executionReportItems', body: ScopedInput<'executionReportItems', S> & { collection: C }): Promise<BoundedPage<ValidationReport[C][number]>>;
  <M extends WorkbenchMethod>(method: M, body: ScopedInput<M, S>): Promise<WorkbenchResult<M>>;
  <M extends ScopedOptional<S>>(method: M): Promise<WorkbenchResult<M>>;
}
/** Component scope is added first; explicit request identities retain precedence. */
export function scopedWorkbenchCall<S extends { projectId: string; executionId?: string }>(client: WorkbenchClient, scope: S): ScopedWorkbenchCall<S> {
  return (<M extends WorkbenchMethod>(method: M, body?: ScopedInput<M, S>) => client.call(method, { ...scope, ...body } as WorkbenchInput<M>)) as ScopedWorkbenchCall<S>;
}
