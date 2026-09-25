import type { DatasetIdentity, ExecutionBinding, RequirementResult } from '@/contracts/execution';
import type { ReadBudget, SourceValue } from '@/contracts/recording';
import type { JsonValue, ReportedAssertion, Verdict } from '@/contracts/workflow';
import type { PersistentDatasetService } from '@/runner/datasets';

export type DatasetReader = Pick<PersistentDatasetService, 'binding' | 'summary' | 'batches' | 'records' | 'batchMetadata'>;
export interface SourceScope { executionId: string; attemptId: string; recordingId: string }
/** Produced by a host-owned reader of originals, never deserialized from a script assertion. */
export interface SourceDocument {
  sourceRef: string;
  scope: SourceScope;
  capturedAt: string;
  /** Read from the captured request, never from script provenance text. */
  requestUrl?: string;
  content: SourceValue<JsonValue>;
  representation: 'network-json' | 'dom-text' | 'dom-property';
  /** DOM existence and a replay node alone do not establish visible page text. */
  display: 'observed' | 'unknown';
}
export interface SourceReader {
  read(sourceRef: string, budget: ReadBudget): Promise<SourceDocument | undefined>;
}
export interface Check { name: string; verdict: Verdict; reason: string }
export interface HumanReview {
  id: string; requirementId: string; decision: 'accept' | 'reject' | 'exception'; reason: string;
  materialRevisionId: string; materialContentHash: string; codeFingerprint: string; inputFingerprint: string;
  executionId: string; attemptId: string;
}
/** This port must be backed by the trusted UI review store; validate() accepts no human flag. */
export interface ReviewReader { read(binding: ExecutionBinding, attemptId: string, budget: ReadBudget): Promise<HumanReview[]> }
export interface ValidationRequest {
  /** Workflow attempt, distinct from attempts owned by individual steps. */
  attemptId: string;
  /** Host selection from persisted execution results; one exact attempt per dataset. No latest/implicit merge. */
  datasetIdentities?: DatasetIdentity[];
  /** Obtained by the host from the executed snapshot, not workflow output. */
  executedCodeFingerprint?: string;
  executedInputFingerprint?: string;
  snapshotVerified: boolean;
  assertions?: ReportedAssertion[];
}
export interface ValidatedRequirement extends RequirementResult {
  checks: Check[];
  schemaVerdict: Verdict;
  sourceVerdict: Verdict;
  scriptAssertions: ReportedAssertion[];
  humanReviews: HumanReview[];
}
export interface ValidationReport {
  schemaVersion: 1; binding: ExecutionBinding; attemptId: string;
  materialStatus: 'candidate';
  overall: Verdict; coverage: 'complete' | 'partial' | 'missing';
  version: Check;
  requirements: ValidatedRequirement[];
  datasets: Array<{ identity: DatasetIdentity; status: string; committedRecords: number; inspectedRecords: number; reasons: string[] }>;
  reasons: string[]; returnedBytes: number;
}
