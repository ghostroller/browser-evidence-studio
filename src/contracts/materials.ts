import type { DataRule, JsonRecordSourceProof } from './workflow';
import type { BoundedPage, HistoricalTarget, ReadBudget, ReplayPosition } from './recording';

export const MATERIAL_SCHEMA_VERSION = 1 as const;
export type MaterialAuthor = 'human' | 'agent';
export interface MaterialField {
  id: string;
  dataset: string;
  name: string;
  description: string;
  /** name is a display label; this optional RFC 6901 pointer selects output data. */
  outputPath?: string;
  sourceProof?: JsonRecordSourceProof;
  valueType?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  sourcePolicy: 'any-evidenced' | 'page-displayed';
  target?: HistoricalTarget;
  /** Optional example-card ownership, including binding without an annotation. */
  checkpointId?: string;
  /** Retains the old target when moving a card requires revalidation. */
  bindingStatus?: 'bound' | 'needs-rebind' | 'unavailable';
  annotationId?: string;
}
export interface MaterialRequirement {
  id: string;
  description: string;
  dataset?: string;
  rules: DataRule[];
  fieldIds: string[];
}
export interface CheckpointCard {
  id: string;
  kind: 'observation' | 'requirement';
  anchor: ReplayPosition;
  capturedAt: string;
  createdAt: string;
  derivedFrom?: string;
  title: string;
  notes: string;
  requirementIds: string[];
  annotationIds: string[];
}
export interface MaterialAnnotation {
  id: string;
  checkpointId: string;
  target: HistoricalTarget;
  text: string;
  author: MaterialAuthor;
  interpretation: 'observed' | 'inferred' | 'unverified';
  bindingStatus: 'bound' | 'needs-rebind' | 'unavailable';
}
export interface MaterialContent {
  requirements: MaterialRequirement[];
  fields: MaterialField[];
  checkpoints: CheckpointCard[];
  annotations: MaterialAnnotation[];
  recordingRefs: string[];
}
export interface TaskMaterialDraft {
  schemaVersion: 1;
  projectId: string;
  draftId: string;
  draftRevision: number;
  baseRevisionId?: string;
  author: MaterialAuthor;
  updatedAt: string;
  content: MaterialContent;
}
/** Immutable manifest and content. A revision is not a human approval. */
export interface TaskMaterialRevision {
  schemaVersion: 1;
  projectId: string;
  revisionId: string;
  parentRevisionId?: string;
  contentHash: string;
  createdAt: string;
  author: MaterialAuthor;
  content: MaterialContent;
}
export interface MaterialDifference {
  collection: keyof Omit<MaterialContent, 'recordingRefs'> | 'recordingRefs';
  id: string;
  change: 'added' | 'removed' | 'changed';
  changedFields: string[];
}
export type DraftUpdateResult = { status: 'saved'; draft: TaskMaterialDraft } |
  { status: 'conflict'; current: TaskMaterialDraft; expectedDraftRevision: number };
/** B owns implementation and input validation in src/materials; no original-recording writes. */
export interface MaterialService {
  createDraft(projectId: string, author: MaterialAuthor, baseRevisionId?: string): Promise<TaskMaterialDraft>;
  getDraft(projectId: string, draftId: string): Promise<TaskMaterialDraft>;
  updateDraft(projectId: string, draftId: string, expectedDraftRevision: number, content: MaterialContent, author: MaterialAuthor): Promise<DraftUpdateResult>;
  publish(projectId: string, draftId: string, expectedDraftRevision: number, author: MaterialAuthor): Promise<TaskMaterialRevision>;
  revision(projectId: string, revisionId: string, expectedHash?: string): Promise<TaskMaterialRevision>;
  diff(projectId: string, fromRevisionId: string, toRevisionId: string, budget: ReadBudget): Promise<BoundedPage<MaterialDifference>>;
}
