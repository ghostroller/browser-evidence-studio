import type { DataProvenance, JsonValue } from './workflow';
import type { BoundedPage, ReadBudget } from './recording';

export const EXECUTION_SCHEMA_VERSION = 1 as const;
export type ExecutionMode = 'current-page-test' | 'from-start-validation';
export interface ExecutionBinding {
  schemaVersion: 1;
  executionId: string;
  projectId: string;
  materialRevisionId: string;
  materialContentHash: string;
  codeFingerprint: string;
  inputFingerprint: string;
  environmentRef: string;
  mode: ExecutionMode;
}
export interface OriginalError { name: string; message: string; stack?: string; cause?: OriginalError }
export interface StepIdentity { executionId: string; stepId: string; attemptId: string; entityKey?: string }
export type StepResult<T> =
  | { status: 'succeeded'; identity: StepIdentity; value: T }
  | { status: 'partial'; identity: StepIdentity; value: T; error: OriginalError }
  | { status: 'failed' | 'cancelled'; identity: StepIdentity; error: OriginalError }
  | { status: 'blocked'; identity: StepIdentity; dependencies: StepIdentity[]; reason: string }
  | { status: 'awaiting-human'; identity: StepIdentity; handoffId: string };
export interface DatasetIdentity { executionId: string; attemptId: string; datasetId: string }
export interface DatasetBatch extends DatasetIdentity {
  batchId: string;
  records: JsonValue[];
  provenance: DataProvenance;
  /** Reuse is explicit; a new attempt cannot silently relabel previous records. */
  reusedFrom?: DatasetIdentity & { batchId: string; validityEvidenceRefs: string[] };
}
export interface BatchReceipt extends DatasetIdentity {
  batchId: string;
  contentHash: string;
  recordCount: number;
  artifactId: string;
  durableAt: string;
  replayed: boolean;
}
export interface DatasetCompletion extends DatasetIdentity {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  committedBatches: number;
  committedRecords: number;
  /** A script's completion declaration is not independently verified coverage. */
  pagination?: DataProvenance['pagination'];
  error?: OriginalError;
}
/** C supplies persistent adapter plus optional portable reporter helper; no second Page API. */
export interface DatasetService {
  begin(identity: DatasetIdentity): Promise<void>;
  append(batch: DatasetBatch, signal?: AbortSignal): Promise<BatchReceipt>;
  finish(completion: DatasetCompletion): Promise<void>;
  batches(identity: DatasetIdentity, budget: ReadBudget): Promise<BoundedPage<BatchReceipt>>;
}
export type EvidenceAssessment =
  | { status: 'reference-exists' | 'content-verified'; sourceRefs: string[]; reason: string }
  | { status: 'script-declared' | 'missing' | 'unrelated' | 'inconclusive'; sourceRefs: string[]; reason: string };
export interface RequirementResult {
  requirementId: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'not-run';
  coverage: 'complete' | 'partial' | 'missing';
  evidence: EvidenceAssessment[];
}
