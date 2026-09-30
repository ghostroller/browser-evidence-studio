/** Renderer-facing RPC contract. No runtime main-process or Electron imports.
 * This is the trusted workbench surface used by the current renderer, not the
 * Agent HTTP allowlist. Dispatch remains responsible for validation/authority.
 * Legacy service DTOs below are type-only reuse until their later extraction.
 */
import type { WorkbenchProjectMethods, MaterialCollection, MaterialEntityCollection, MaterialEntityResult, ExecutionCollection, ReportCollection } from './workbench-project';
import type { Studio } from '@/main/services/studio';
import type { Project, Profile, ManagementDependencies } from '@/main/services/workspace-management';
import type { BrowserCommand } from '@/main/browser/browser-controls';
import type { UiPreferences } from '@/main/ui-preferences';
import type { AuthorizeTaskInput, TaskAuthorizationResult, TaskAuthorization } from '@/main/services/client-types';
import type { exportFixedTaskHandoff } from '@/main/services/fixed-task-handoff';
import type { inspectRunRecovery, recoverRun, recoverRunIndexes } from '@/main/services/run-recovery';
import type { HumanReview, ReviewPage, ReviewQuery } from '@/main/services/reviews';
import type { EvidenceReader } from '@/evidence/reader';
import type { MaterialContent } from './materials';
import type { BoundedPage } from './recording';
import type { StepSummary, DatasetSummary } from '@/runner/manager';
import type { ValidationReport } from '@/validator/types';
import type { WriterLockInspection } from '@/evidence/writer-lock';
import type { JsonValue } from './workflow';
import type { WorkbenchHost } from './host-capabilities';
import type { ArtifactReadOptions, Checkpoint, QueryOptions, QueryPage } from '@/evidence/contracts';

export type WorkbenchOperation<Input, Result> = { input: Input; result: Result };
type Empty = Record<string, never>;
type ResultOf<M extends keyof Studio> = Studio[M] extends (...args: never[]) => infer R ? Awaited<R> : never;
type ProjectInput = { projectId: string };
type Operation = { operationId?: string };
type ProjectFields = { name?: string; objective?: string; scriptDirectory?: string | null };
type ProfileFields = { name?: string; entryUrl?: string; instructions?: string; checkSelector?: string; expectedOrigin?: string };
export interface WorkbenchMethods extends WorkbenchProjectMethods {
  // Transitional legacy state DTO: runs, connection and active.handoff still
  // contain nested any in Studio. The method itself has no any/string fallback;
  // extracting those legacy payloads is separate from this transport slice.
  state: WorkbenchOperation<Empty, ResultOf<'state'>>;
  uiPreferences: WorkbenchOperation<Partial<UiPreferences>, UiPreferences>;
  presentation: WorkbenchOperation<{ reason: 'overlay' | 'layout'; hidden: boolean }, Empty>;
  createProject: WorkbenchOperation<Operation & ProjectFields & { name: string }, Project>;
  updateProject: WorkbenchOperation<Operation & ProjectInput & ProjectFields & { expectedRevision: number }, Project>;
  createProfile: WorkbenchOperation<Operation & ProjectInput & ProfileFields & { name: string }, Profile>;
  updateProfile: WorkbenchOperation<Operation & ProjectInput & ProfileFields & { profileId: string; expectedRevision: number }, Profile>;
  manageProject: WorkbenchOperation<Operation & ProjectInput & { action: 'archive' | 'restore' | 'delete'; expectedRevision: number; confirmEmptyDelete?: boolean }, Project & { deleted?: boolean }>;
  manageProfile: WorkbenchOperation<Operation & ProjectInput & { profileId: string; action: 'disable' | 'restore' | 'delete'; expectedRevision: number; confirmEmptyDelete?: boolean }, Profile & { deleted?: boolean }>;
  managementDependencies: WorkbenchOperation<ProjectInput & { profileId?: string }, ManagementDependencies>;
  settleManagementDependencies: WorkbenchOperation<ProjectInput & { profileId?: string; expectedSessionId: string | null; authorizationIds: string[] }, ManagementDependencies>;
  openEnvironment: WorkbenchOperation<ProjectInput & { profileId: string }, ResultOf<'openEnvironment'>>;
  checkEnvironment: WorkbenchOperation<Empty, Profile>;
  saveProfile: WorkbenchOperation<Empty, Profile>;
  startRun: WorkbenchOperation<ProjectInput & { profileId: string; url?: string; kind?: 'demonstrate' | 'validate' }, ResultOf<'startRun'>>;
  seal: WorkbenchOperation<Empty, ResultOf<'seal'>>;
  closeSession: WorkbenchOperation<Empty, ResultOf<'closeSession'>>;
  browserCommand: WorkbenchOperation<BrowserCommand, ResultOf<'browserCommand'>>;
  navigate: WorkbenchOperation<{ url: string }, ResultOf<'navigate'>>;
  syntheticSite: WorkbenchOperation<Empty, { url: string }>;
  pauseOperations: WorkbenchOperation<{ paused: boolean }, ResultOf<'pauseOperations'>>;
  pauseCapture: WorkbenchOperation<{ paused: boolean }, ResultOf<'pauseCapture'>>;
  control: WorkbenchOperation<{ controller: 'human' | 'agent' }, ResultOf<'control'>>;
  inspect: WorkbenchOperation<{ enabled: boolean; selectionId?: string }, { enabled: boolean }>;
  stopRunner: WorkbenchOperation<{ runId?: string; sessionId?: string; validationId?: string }, ResultOf<'state'>['active'] | ResultOf<'state'>['session']>;
  releaseHuman: WorkbenchOperation<{ handoffId: string }, ResultOf<'releaseHuman'>>;
  checkpoint: WorkbenchOperation<{ key?: string; title?: string; description?: string; requirementIds?: string[]; pageId?: string; generation?: number }, Checkpoint>;
  cancelCheckpoint: WorkbenchOperation<{ runId: string; operationId: string }, { operationId: string; cancelled: boolean }>;
  history: WorkbenchOperation<{ runId: string }, Omit<ResultOf<'history'>, 'summary'> & { summary: { run: { id: string; projectId: string; kind: string; status: string }; [key: string]: unknown } }>;
  events: WorkbenchOperation<QueryOptions & { runId: string }, QueryPage>;
  checkpoints: WorkbenchOperation<QueryOptions & { runId: string }, QueryPage>;
  artifact: WorkbenchOperation<ArtifactReadOptions & { runId: string; id: string }, Awaited<ReturnType<EvidenceReader['artifact']>> & { url: string }>;
  validation: WorkbenchOperation<{ id: string }, ResultOf<'validation'>>;
  validate: WorkbenchOperation<ProjectInput & { profileId: string; input: unknown; executionMode: 'current-page-test' | 'from-start-validation'; startUrl?: string; pageId?: string; generation?: number; materialRevisionId?: string; materialContentHash?: string }, { id: string; executionId?: string; runId: string; status: string }>;
  review: WorkbenchOperation<{ id: string; verdict: HumanReview['verdict']; reason: string; scope?: string }, HumanReview>;
  reviews: WorkbenchOperation<ReviewQuery & { id: string }, ReviewPage>;
  inspectRunRecovery: WorkbenchOperation<{ runId: string }, Awaited<ReturnType<typeof inspectRunRecovery>>>;
  recoverRun: WorkbenchOperation<{ runId: string; expectedFingerprint: WriterLockInspection['lockFingerprint'] }, Awaited<ReturnType<typeof recoverRun>>>;
  recoverRunIndexes: WorkbenchOperation<{ runId: string; expectedFingerprint: WriterLockInspection['lockFingerprint'] }, Awaited<ReturnType<typeof recoverRunIndexes>>>;
  workflowInputSchema: WorkbenchOperation<ProjectInput, { schema: JsonValue }>;
  taskAuthorizations: WorkbenchOperation<ProjectInput, { instanceId: string; items: TaskAuthorization[] }>;
  authorizeTask: WorkbenchOperation<AuthorizeTaskInput, TaskAuthorizationResult>;
  revokeTask: WorkbenchOperation<ProjectInput & { authorizationId: string }, TaskAuthorization>;
  exportFixedTaskHandoff: WorkbenchOperation<ProjectInput & { revisionId: string; contentHash: string; authorizationId: string }, Awaited<ReturnType<typeof exportFixedTaskHandoff>>>;
}
export type WorkbenchMethod = keyof WorkbenchMethods;
export type WorkbenchInput<M extends WorkbenchMethod> = WorkbenchMethods[M]['input'];
export type WorkbenchResult<M extends WorkbenchMethod> = WorkbenchMethods[M]['result'];
export type OptionalWorkbenchMethod = { [M in WorkbenchMethod]: {} extends WorkbenchInput<M> ? M : never }[WorkbenchMethod];
export interface WorkbenchCall {
  <C extends MaterialCollection>(method: 'materialCollection', body: WorkbenchInput<'materialCollection'> & { collection: C }): Promise<BoundedPage<MaterialContent[C][number]>>;
  <C extends MaterialEntityCollection>(method: 'materialEntity', body: WorkbenchInput<'materialEntity'> & { collection: C }): Promise<Omit<MaterialEntityResult, 'item'> & { item: MaterialContent[C][number] }>;
  <C extends ExecutionCollection>(method: 'executionItems', body: WorkbenchInput<'executionItems'> & { collection: C }): Promise<BoundedPage<C extends 'steps' ? StepSummary : DatasetSummary>>;
  <C extends ReportCollection>(method: 'executionReportItems', body: WorkbenchInput<'executionReportItems'> & { collection: C }): Promise<BoundedPage<ValidationReport[C][number]>>;
  <M extends WorkbenchMethod>(method: M, body: WorkbenchInput<M>): Promise<WorkbenchResult<M>>;
  <M extends OptionalWorkbenchMethod>(method: M): Promise<WorkbenchResult<M>>;
}
export interface WorkbenchFeedbackCall {
  <M extends WorkbenchMethod>(method: M, body: WorkbenchInput<M>, success?: string): Promise<WorkbenchResult<M>>;
  <M extends OptionalWorkbenchMethod>(method: M): Promise<WorkbenchResult<M>>;
}
export interface NativeBounds { x: number; y: number; width: number; height: number }
export interface NativePresentation {
  bounds(rect: NativeBounds): void;
  set(body: WorkbenchInput<'presentation'>): Promise<WorkbenchResult<'presentation'>>;
}
export interface WorkbenchClient {
  readonly host: WorkbenchHost;
  call: WorkbenchCall;
  onChanged(listener: () => void): () => void;
  /** null means the host cannot embed native browser/replay surfaces. */
  nativePresentation: NativePresentation | null;
}
