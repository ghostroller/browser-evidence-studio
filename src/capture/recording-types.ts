import type { eventWithTime } from '@rrweb/types';
import type { RecordingGap, ReplayPosition, SourceNode } from '@/contracts/recording';

/** Internal format-2 payload. The containing evidence journal remains schema 1. */
export interface SourceMetadata extends Omit<SourceNode, 'ref' | 'text'> {
  nodeId: number;
  rootId: number;
  frameId: string;
  mirrorScopeId: string;
  frameHostId?: number;
  shadowHostIds: number[];
}
export interface RecordingEnvelope {
  formatVersion: 2;
  position: ReplayPosition;
  frameId: string;
  mirrorScopeId: string;
  event: eventWithTime;
  metadata: SourceMetadata[];
  metadataComplete: boolean;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  gaps: RecordingGap[];
  sourceClock: { timeOrigin: number; monotonicMs: number };
  receivedAt: string;
}
export interface RawReceipt {
  id: string;
  sequence: number;
  file: string;
  offset: number;
  bytes: number;
  sha256: string;
}
export function sameStream(a: ReplayPosition, b: ReplayPosition): boolean {
  return a.recordingId === b.recordingId && a.pageId === b.pageId && a.documentId === b.documentId && a.streamEpoch === b.streamEpoch;
}
