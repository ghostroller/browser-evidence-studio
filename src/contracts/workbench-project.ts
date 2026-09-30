/** Renderer-facing, serializable project operations carried by studio:call.
 * These contracts describe the existing trusted UI dispatch, not an HTTP API.
 * Type-only implementation references are transitional and do not bundle main
 * services, Electron, filesystem readers, or runner implementations.
 */
import type {
  CheckpointCard, MaterialContent, MaterialDifference, MaterialField,
  TaskMaterialDraft, TaskMaterialRevision,
} from './materials';
import type {
  BoundedPage, HistoricalElementRef, LocatorCandidate, ReadBudget,
  ReplayPosition, SourceNode,
} from './recording';
import type { BatchReceipt, DatasetIdentity } from './execution';
import type { CatalogKind, MaterialCatalog } from './workspace';
import type { JsonValue } from './workflow';
import type {
  ExecutionSummary, MaterialEdit, ReplayHostState, ReportSummary,
} from '@/main/services/client-types';
import type { DraftSummary, RevisionSummary } from '@/materials/service';
import type { RecordingStream, ForegroundTransition } from '@/replay/archive';
import type { DatasetRecord } from '@/runner/datasets';
import type { DatasetSummary, StepSummary } from '@/runner/manager';
import type { HumanReview, ValidationReport } from '@/validator/types';

export type {
  ExecutionSummary, MaterialEdit, ReplayHostState, ReportSummary,
  DraftSummary, RevisionSummary, DatasetRecord, DatasetSummary, StepSummary,
};

export interface ProjectScope { projectId: string }
export type ProjectReadBudget = Partial<ReadBudget>;
export type MaterialCollection = Exclude<keyof MaterialContent, 'taskBrief'>;
export type MaterialEntityCollection = Exclude<MaterialCollection, 'recordingRefs'>;
export type MaterialCollectionItem = MaterialContent[MaterialCollection][number];
export type MaterialEntity = MaterialContent[MaterialEntityCollection][number];

/** Fetch/create/edit results omit full content; list results have different
 * available/unavailable catalog identities (DraftSummary/RevisionSummary).
 */
export type MaterialView<T extends TaskMaterialDraft | TaskMaterialRevision> = Omit<T, 'content'> & {
  taskBrief?: MaterialContent['taskBrief'];
  counts: Record<string, number>;
  materialStatus: 'candidate';
};
export type MaterialDraftView = MaterialView<TaskMaterialDraft>;
export type MaterialRevisionView = MaterialView<TaskMaterialRevision>;
export type MaterialSource =
  | { kind: 'draft'; draftId: string }
  | { kind: 'revision'; revisionId: string; contentHash: string };
export interface MaterialEntityResult {
  item: MaterialEntity;
  ownerRequirementIds?: string[];
  draftRevision?: number;
  contentHash?: string;
}
export type MaterialUpdateResult =
  | { status: 'saved'; draft: MaterialDraftView; createdIds: string[]; focus?: { collection: 'checkpoints'; id: string } }
  | { status: 'conflict'; current: MaterialDraftView; expectedDraftRevision: number };
export type MaterialPublicationResult =
  | { stage: 'not-started' }
  | { stage: 'prepared' | 'manifest-saved'; draftId: string; expectedDraftRevision: number; revisionId: string; contentHash: string };
export interface RecordingUsageResult {
  revisions: Array<{ revisionId: string; displayNumber?: number; cards: number }>;
  drafts: Array<{ draftId: string; name: string; cards: number }>;
}
export interface MaterialArchivePreparation {
  draftId: string;
  draftRevision: number;
  recordings: Array<{ id: string; status: string }>;
}

export interface ImplementationPreview {
  proposalHash: string;
  draftRevision: number;
  compatible: boolean;
  issues: string[];
  fields: Array<Pick<MaterialField, 'name' | 'description' | 'dataset' | 'valueType' | 'sourcePolicy' | 'outputPath'> & {
    example: string;
    compatibility?: string;
    verification: string;
  }>;
}

/** Retrying passes the same original request identity. Recovered identities can
 * contain null generation/lease values, as recorded by authoringIdentity.
 */
export interface AuthoringInput extends ProjectScope {
  operationId: string;
  draftId: string;
  title?: string;
  notes?: string;
  purpose?: 'field' | 'observation';
  fieldId?: string;
  selection?: boolean;
  selectionId?: string | null;
  pageId?: string;
  generation?: number | null;
  leaseEpoch?: number | null;
  derivedFrom?: string;
}
export type AuthoringStage = 'not-captured' | 'acquiring' | 'unknown' | 'interrupted' | 'source-expired' | 'receipt-saved' | 'associated';
interface AuthoringIdentityResult {
  // Existing source-expired returns do not always include the operation ID.
  operationId?: string;
  receiptId?: string;
  purpose?: 'field' | 'observation';
  fieldId?: string;
  target?: HistoricalElementRef;
  reason?: string;
  error?: string;
}
export type AssociatedAuthoringResult = AuthoringIdentityResult & {
  stage: 'associated'; status: 'saved'; draft: MaterialDraftView; card: CheckpointCard;
};
/** A mutation awaits acquisition/association. It either saves, reports a known
 * incomplete terminal outcome, or rejects; it does not return an acquiring
 * status or the query-only missing-operation result.
 */
export type CaptureAndAuthorResult = AssociatedAuthoringResult | (AuthoringIdentityResult & {
  stage: 'unknown' | 'interrupted' | 'source-expired' | 'receipt-saved';
  status: 'partial'; draft?: never; card?: never;
});
export type AuthoringResult = AssociatedAuthoringResult | (AuthoringIdentityResult & (
  | { stage: Exclude<AuthoringStage, 'associated'>; status: 'partial'; draft?: never; card?: never }
  | { stage: 'not-captured'; status?: never; draft?: never; card?: never }
));
export interface AuthoringRecoveryItem extends AuthoringInput {
  stage: AuthoringStage;
  paused: boolean;
  reason?: string;
}
export interface AuthoringRecoveryResult {
  items: AuthoringRecoveryItem[];
  // The no-directory return deliberately contains no warnings property.
  warnings?: string[];
  outputTruncated: boolean;
}

export interface RecordingStreamsResult { items: RecordingStream[]; nextCursor?: string }
export interface RecordingForegroundResult {
  status: 'recorded' | 'legacy'; items: ForegroundTransition[]; nextCursor?: string;
}
export interface RecordingPositionsResult {
  items: Array<{ position: ReplayPosition; type: number; source: number }>;
  nextOrdinal?: number;
}
export interface ExecutionScope extends ProjectScope { executionId: string }
export type ExecutionCollection = 'steps' | 'datasets';
export type ReportCollection = 'requirements' | 'datasets';
export type ReportItem = ValidationReport[ReportCollection][number];

export interface WorkbenchProjectMethods {
  materialCatalog: { input: ProjectScope; result: MaterialCatalog };
  manageMaterialCatalog: {
    input: ProjectScope & { kind: CatalogKind; id: string; expectedCatalogRevision: number; name?: string; note?: string; hidden?: boolean };
    result: MaterialCatalog;
  };
  recordingUsage: { input: ProjectScope & { recordingId: string }; result: RecordingUsageResult };
  workingMaterialDraft: { input: ProjectScope; result: TaskMaterialDraft };
  setWorkingMaterialDraft: { input: ProjectScope & { draftId: string }; result: MaterialDraftView };
  materialDrafts: { input: ProjectScope & ProjectReadBudget; result: BoundedPage<DraftSummary> };
  materialRevisions: { input: ProjectScope & ProjectReadBudget; result: BoundedPage<RevisionSummary> };
  materialDraft: { input: ProjectScope & { draftId: string }; result: MaterialDraftView };
  materialRevision: { input: ProjectScope & { revisionId: string; contentHash: string }; result: MaterialRevisionView };
  materialCollection: {
    input: ProjectScope & MaterialSource & ProjectReadBudget & { collection: MaterialCollection };
    result: BoundedPage<MaterialCollectionItem>;
  };
  materialEntity: {
    input: ProjectScope & MaterialSource & { collection: MaterialEntityCollection; entityId: string };
    result: MaterialEntityResult;
  };
  createMaterialDraft: { input: ProjectScope & { baseRevisionId?: string; operationId?: string }; result: MaterialDraftView };
  copyMaterialDraft: {
    input: ProjectScope & { draftId: string; expectedDraftRevision: number; operationId: string };
    result: MaterialDraftView;
  };
  editMaterialDraft: {
    input: ProjectScope & { draftId: string; expectedDraftRevision: number; edits: MaterialEdit[] };
    result: MaterialUpdateResult;
  };
  publishMaterialDraft: {
    input: ProjectScope & { draftId: string; expectedDraftRevision: number; operationId?: string };
    result: MaterialRevisionView;
  };
  materialPublicationStatus: { input: ProjectScope & { operationId: string }; result: MaterialPublicationResult };
  prepareMaterialArchive: { input: ProjectScope & { draftId: string }; result: MaterialArchivePreparation };
  materialDiff: {
    input: ProjectScope & ProjectReadBudget & { fromRevisionId: string; toRevisionId: string };
    result: BoundedPage<MaterialDifference>;
  };
  materialDraftDiff: { input: ProjectScope & ProjectReadBudget & { draftId: string }; result: BoundedPage<MaterialDifference> };
  previewImplementation: { input: ProjectScope & { draftId: string }; result: ImplementationPreview };
  confirmImplementation: {
    input: ProjectScope & { draftId: string; expectedDraftRevision: number; proposalHash: string };
    result: MaterialUpdateResult;
  };
  authoringOperation: { input: AuthoringInput; result: AuthoringResult };
  captureAndAuthor: { input: AuthoringInput; result: CaptureAndAuthorResult };
  authoringRecovery: { input: ProjectScope & { draftId: string }; result: AuthoringRecoveryResult };
  historicalNode: {
    input: ProjectScope & ProjectReadBudget & { target: HistoricalElementRef };
    result: SourceNode;
  };
  historicalLocators: {
    input: ProjectScope & ProjectReadBudget & { target: HistoricalElementRef };
    result: BoundedPage<LocatorCandidate>;
  };
  recordingStreams: { input: ProjectScope & ProjectReadBudget & { recordingId: string }; result: RecordingStreamsResult };
  recordingForeground: { input: ProjectScope & ProjectReadBudget & { recordingId: string }; result: RecordingForegroundResult };
  recordingPositions: {
    input: ProjectScope & ProjectReadBudget & { position: ReplayPosition; ordinal?: number };
    result: RecordingPositionsResult;
  };
  resolveRecordingTime: {
    input: ProjectScope & { position: ReplayPosition; sourceTimeMs: number };
    result: ReplayPosition;
  };
  openReplay: { input: ProjectScope & { position: ReplayPosition; replayId?: string }; result: ReplayHostState };
  seekReplay: { input: ProjectScope & { replayId: string; position: ReplayPosition }; result: ReplayHostState };
  playReplay: { input: ProjectScope & { replayId: string; endPosition: ReplayPosition; speed: number }; result: ReplayHostState };
  pauseReplay: { input: ProjectScope & { replayId: string }; result: ReplayHostState };
  replayStatus: { input: Partial<ProjectScope> & { replayId: string }; result: ReplayHostState };
  selectReplay: { input: Partial<ProjectScope> & { replayId: string; enabled: boolean }; result: ReplayHostState };
  closeReplay: { input: Partial<ProjectScope> & { replayId: string }; result: ReplayHostState | undefined };
  execution: { input: ExecutionScope; result: ExecutionSummary };
  executionItems: {
    input: ExecutionScope & ProjectReadBudget & { collection: ExecutionCollection };
    result: BoundedPage<StepSummary | DatasetSummary>;
  };
  datasetBatches: { input: ProjectScope & DatasetIdentity & ProjectReadBudget; result: BoundedPage<BatchReceipt> };
  datasetRecords: {
    input: ProjectScope & DatasetIdentity & ProjectReadBudget & { batchId: string; fields?: string[]; entity?: { field: string; equals: JsonValue } };
    result: BoundedPage<DatasetRecord>;
  };
  assessExecution: { input: ExecutionScope & { datasetIdentities?: DatasetIdentity[] }; result: ReportSummary };
  executionReport: { input: ExecutionScope & { reportId: string }; result: ReportSummary };
  executionReports: { input: ExecutionScope & ProjectReadBudget; result: BoundedPage<ReportSummary> };
  executionReportItems: {
    input: ExecutionScope & ProjectReadBudget & { reportId: string; collection: ReportCollection };
    result: BoundedPage<ReportItem>;
  };
  reviewExecution: {
    input: ExecutionScope & { reportId: string; requirementId: string; decision: HumanReview['decision']; reason: string };
    result: HumanReview;
  };
}
