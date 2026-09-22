export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export type CaptureStatus = 'complete' | 'empty' | 'missing' | 'truncated' | 'read-failed' | 'not-applicable' | 'excluded' | 'unknown';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Source = string | Record<string, unknown>;

export interface RunInput {
  id?: string;
  projectId: string;
  kind: 'demonstrate' | 'validate';
  mode: string;
  objective: string;
  versions?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  sourceRunId?: string;
  [key: string]: unknown;
}
export interface RunManifest extends RunInput {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'recording' | 'interrupted' | 'sealing' | 'sealed';
  sealedAt?: string;
}
export interface EventInput {
  type: string;
  source: Source;
  occurredAt?: string;
  timeBasis?: string;
  pageId?: string;
  frameId?: string;
  navigationGeneration?: number;
  artifactRefs?: string[];
  data?: unknown;
  [key: string]: unknown;
}
export interface EvidenceEvent extends EventInput {
  schemaVersion: 1;
  id: string;
  sequence: number;
  occurredAt: string;
  receivedAt: string;
  timeBasis: string;
}
export interface ArtifactInput {
  kind: string;
  mediaType: string;
  data?: string | Uint8Array;
  captureStatus?: CaptureStatus;
  reason?: string;
  limitBytes?: number;
  source?: Source;
  metadata?: Record<string, unknown>;
}
export interface Artifact extends Omit<ArtifactInput, 'data'> {
  schemaVersion: 1;
  id: string;
  sequence: number;
  createdAt: string;
  captureStatus: CaptureStatus;
  capturedBytes: number;
  originalBytes?: number;
  path?: string;
  sha256?: string;
}
export interface CheckpointInput {
  key: string;
  title?: string;
  description?: string;
  requirementIds?: string[];
  requirementVersion?: string;
  captureStartedAt: string;
  captureEndedAt: string;
  pageId?: string;
  navigationGeneration?: number;
  captureConsistency: 'consistent' | 'mixed' | 'unknown';
  artifactRefs: string[];
  eventRange?: { from: number; to: number };
  metadata?: Record<string, unknown>;
}
export interface Checkpoint extends CheckpointInput {
  schemaVersion: 1;
  id: string;
  sequence: number;
  savedAt: string;
}
export type RecordKind = 'events' | 'artifacts' | 'checkpoints' | 'raw';
export interface IndexEntry {
  id: string;
  sequence: number;
  kind: RecordKind;
  file: string;
  offset: number;
  bytes: number;
  type?: string;
  timestamp?: string;
  captureStatus?: CaptureStatus;
  key?: string;
}
export interface IndexState {
  schemaVersion: 1;
  generation: string;
  counts: Record<RecordKind, number>;
  lastSequence: number;
  updatedAt: string;
  gaps: number;
}
export interface QueryOptions {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  fields?: string[];
  types?: string[];
  fromSequence?: number;
  toSequence?: number;
}
export interface QueryPage {
  items: unknown[];
  nextCursor?: string;
  outputTruncated: boolean;
  responseBytes: number;
  elapsedMs: number;
  maxBytes: number;
}
export interface ArtifactReadOptions { cursor?: string; maxBytes?: number; jsonPath?: string; }
export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'EvidenceError'; }
}
