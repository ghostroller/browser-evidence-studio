/** S0 contract v1. New recording capability; legacy schema-1 archives stay read-only. */
export const RECORDING_FORMAT_VERSION = 2 as const;
export interface ReplayPosition {
  recordingId: string;
  pageId: string;
  documentId: string;
  streamEpoch: string;
  sourceTimeMs: number;
  eventSeq: number;
}
export interface HistoricalElementRef {
  kind: 'dom-node';
  position: ReplayPosition;
  frameId: string;
  mirrorScopeId: string;
  nodeId: number;
}
export interface VisualRegionRef {
  kind: 'visual-region';
  position: ReplayPosition;
  artifactId: string;
  rect: { x: number; y: number; width: number; height: number };
}
export type HistoricalTarget = HistoricalElementRef | VisualRegionRef;
/** Missing metadata is never inferred from the transformed replay DOM. */
export type SourceValue<T> =
  | { status: 'present'; value: T }
  | { status: 'absent' }
  | { status: 'redacted' | 'missing' | 'unsupported'; reason: string };
export interface SourceNode {
  ref: HistoricalElementRef;
  tagName: string;
  namespaceURI: string | null;
  documentUrl: SourceValue<string>;
  baseURI: SourceValue<string>;
  attributes: Record<string, SourceValue<string>>;
  properties: { value?: SourceValue<string>; checked?: SourceValue<boolean>; selected?: SourceValue<boolean> };
  text: SourceValue<string>;
  metadataComplete: boolean;
}
export interface RecordingGap {
  id: string;
  from: ReplayPosition;
  to?: ReplayPosition;
  category: 'structure' | 'metadata' | 'resource' | 'sampling' | 'redaction';
  reason: string;
}
export interface ResourceReference {
  id: string;
  position: ReplayPosition;
  frameId: string;
  requestId?: string;
  originalUrl: SourceValue<string>;
  mediaType: string;
  status: 'captured' | 'late-fetched' | 'missing' | 'redacted' | 'unsupported' | 'failed';
  blobHash?: string;
  reason?: string;
}
export interface LocatorCandidate {
  steps: Array<{ kind: 'frame' | 'shadow' | 'target'; strategy: 'css' | 'xpath'; expression: string }>;
  source: HistoricalElementRef;
  historical: { status: 'historical-unique' | 'historical-ambiguous' | 'invalid' | 'unavailable'; matchCount: number; matchesTarget: boolean; reason?: string };
  live: { status: 'not-live-checked' } | { status: 'live-verified' | 'live-failed'; pageId: string; documentId: string; checkedAt: string };
  warnings: string[];
}
export interface ReadBudget { maxBytes: number; limit: number; cursor?: string }
export interface BoundedPage<T> { items: T[]; nextCursor?: string; returnedBytes: number; outputTruncated: boolean }
export interface ReplayState {
  position: ReplayPosition;
  reliability: 'reliable' | 'gap' | 'unsupported';
  gaps: RecordingGap[];
  viewport: { width: number; height: number; deviceScaleFactor: number };
}
/** A implements these in src/replay. Tokens are caller-owned, monotonically increasing per view. */
export interface ReplayService {
  state(position: ReplayPosition, budget: ReadBudget, signal?: AbortSignal): Promise<ReplayState>;
  node(ref: HistoricalElementRef, budget: ReadBudget, signal?: AbortSignal): Promise<SourceNode>;
  locators(ref: HistoricalElementRef, budget: ReadBudget, signal?: AbortSignal): Promise<BoundedPage<LocatorCandidate>>;
}
export function parseReplayPosition(value: unknown): ReplayPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ReplayPosition');
  const item = value as Record<string, unknown>;
  for (const field of ['recordingId', 'pageId', 'documentId', 'streamEpoch']) {
    if (typeof item[field] !== 'string' || !(item[field] as string).trim()) throw new Error(`ReplayPosition requires ${field}`);
  }
  if (typeof item.sourceTimeMs !== 'number' || !Number.isFinite(item.sourceTimeMs) || item.sourceTimeMs < 0 ||
    !Number.isSafeInteger(item.eventSeq) || (item.eventSeq as number) < 0) throw new Error('Invalid replay event boundary');
  return { recordingId: item.recordingId as string, pageId: item.pageId as string, documentId: item.documentId as string,
    streamEpoch: item.streamEpoch as string, sourceTimeMs: item.sourceTimeMs, eventSeq: item.eventSeq as number };
}
export function sameReplayPosition(a: ReplayPosition, b: ReplayPosition): boolean {
  return a.recordingId === b.recordingId && a.pageId === b.pageId && a.documentId === b.documentId &&
    a.streamEpoch === b.streamEpoch && a.sourceTimeMs === b.sourceTimeMs && a.eventSeq === b.eventSeq;
}
