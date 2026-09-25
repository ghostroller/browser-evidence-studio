import { randomUUID } from 'node:crypto';
import type { MaterialContent, CheckpointCard, MaterialAnnotation } from '@/contracts/materials';
import { sameReplayPosition, type ReplayPosition } from '@/contracts/recording';
import { MaterialError } from './errors';
import { validateContent } from './validate';

/** Produces independent card/annotation IDs; requirements and fields stay project-level. */
export function copyCheckpoint(content: MaterialContent, checkpointId: string, createdAt = new Date().toISOString()): MaterialContent {
  const source = validateContent(content);
  const card = source.checkpoints.find(item => item.id === checkpointId);
  if (!card) throw new MaterialError('NOT_FOUND', 'Checkpoint card does not exist.', 404);
  const annotations = source.annotations.filter(item => item.checkpointId === checkpointId);
  const annotationIds = new Map(annotations.map(item => [item.id, randomUUID()]));
  const copyId = randomUUID();
  const copied: CheckpointCard = { ...structuredClone(card), id: copyId, derivedFrom: card.id, createdAt,
    annotationIds: card.annotationIds.map(annotationId => annotationIds.get(annotationId)!) };
  const copies: MaterialAnnotation[] = annotations.map(item => ({ ...structuredClone(item), id: annotationIds.get(item.id)!, checkpointId: copyId }));
  return validateContent({ ...source, checkpoints: [...source.checkpoints, copied], annotations: [...source.annotations, ...copies] });
}

/** Retains every old target as evidence; a new anchor never validates an old node ID. */
export function moveCheckpoint(content: MaterialContent, checkpointId: string, anchor: ReplayPosition): MaterialContent {
  const source = validateContent(content);
  const card = source.checkpoints.find(item => item.id === checkpointId);
  if (!card) throw new MaterialError('NOT_FOUND', 'Checkpoint card does not exist.', 404);
  if (!source.recordingRefs.includes(anchor.recordingId)) throw new MaterialError('INVALID_SOURCE', 'New anchor recording is not listed.');
  if (sameReplayPosition(card.anchor, anchor)) return source;
  const annotationIds = new Set(card.annotationIds);
  return validateContent({ ...source,
    checkpoints: source.checkpoints.map(item => item.id === checkpointId ? { ...item, anchor } : item),
    annotations: source.annotations.map(item => annotationIds.has(item.id) ? { ...item, bindingStatus: 'needs-rebind' as const } : item),
    fields: source.fields.map(item => {
      if (!item.target) return item;
      const explicit = item.checkpointId === checkpointId || !!item.annotationId && annotationIds.has(item.annotationId);
      const legacyAtOldAnchor = !item.checkpointId && !item.annotationId && sameReplayPosition(item.target.position, card.anchor);
      return explicit || legacyAtOldAnchor ? { ...item, bindingStatus: 'needs-rebind' as const } : item;
    }) });
}

/** Removing a card leaves its shared requirements and fields intact. */
export function removeCheckpoint(content: MaterialContent, checkpointId: string): MaterialContent {
  const source = validateContent(content);
  const card = source.checkpoints.find(item => item.id === checkpointId);
  if (!card) throw new MaterialError('NOT_FOUND', 'Checkpoint card does not exist.', 404);
  const annotationIds = new Set(card.annotationIds);
  return validateContent({ ...source,
    checkpoints: source.checkpoints.filter(item => item.id !== checkpointId),
    annotations: source.annotations.filter(item => !annotationIds.has(item.id)),
    fields: source.fields.map(item => {
      if (!item.target || item.checkpointId !== checkpointId && (!item.annotationId || !annotationIds.has(item.annotationId))) return item;
      return { ...item, checkpointId: undefined, annotationId: undefined, bindingStatus: 'needs-rebind' as const };
    }) });
}
