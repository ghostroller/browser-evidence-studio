import type { HistoricalTarget, ReplayPosition } from '@/contracts/recording';

/** One trusted workbench request, bound to an immutable draft revision and
 * exact source position. The replay view only returns a target for this request. */
export interface SelectionRequest {
  selectionId: string; projectId: string; draftId: string; expectedDraftRevision: number;
  checkpointId: string; anchor: ReplayPosition; purpose: 'annotation' | 'field';
  annotationId?: string; fieldId?: string;
}
export interface SelectionReceipt {
  request: SelectionRequest; target: HistoricalTarget;
  replayId: string; generation: number;
}
