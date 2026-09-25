import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { MaterialContent, TaskMaterialDraft, TaskMaterialRevision } from '@/contracts/materials';
import { parseReplayPosition, sameReplayPosition, type HistoricalTarget, type ReadBudget, type ReplayPosition } from '@/contracts/recording';
import { FileMaterialService, copyCheckpoint, moveCheckpoint, removeCheckpoint } from '@/materials';
import { ArchiveReplayService } from '@/replay/service';
import { safeFile } from '@/evidence/files';
import { ensure } from '@/shared/errors';

export const MATERIAL_COLLECTIONS = ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'] as const;
export type MaterialEdit = { operation: 'upsert'; collection: Exclude<keyof MaterialContent, 'recordingRefs'>; item: MaterialContent[Exclude<keyof MaterialContent, 'recordingRefs'>][number] }
  | { operation: 'remove'; collection: Exclude<keyof MaterialContent, 'recordingRefs'>; id: string }
  | { operation: 'recordings'; recordingRefs: string[] }
  | { operation: 'copy-checkpoint' | 'remove-checkpoint'; checkpointId: string }
  | { operation: 'move-checkpoint'; checkpointId: string; position: ReplayPosition };
export function materialBudget(body: { maxBytes?: number; limit?: number; cursor?: string } = {}): ReadBudget {
  const maxBytes = body.maxBytes ?? 24576, limit = body.limit ?? 50;
  ensure(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 28672 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'Use a 1–28 KiB budget and one to 100 items');
  return { maxBytes, limit, ...(body.cursor ? { cursor: body.cursor } : {}) };
}
export function materialSummary<T extends TaskMaterialDraft | TaskMaterialRevision>(value: T): Omit<T, 'content'> & { counts: Record<string, number>; materialStatus: 'candidate' } {
  const { content, ...identity } = value;
  return { ...identity, counts: Object.fromEntries(MATERIAL_COLLECTIONS.map(key => [key, content[key].length])), materialStatus: 'candidate' as const };
}

/** Main-owned adapter: historical source checks use A's original structure and
 * every recording remains project-scoped. No live browser view/lease is touched. */
export class ProjectMaterials {
  readonly service: FileMaterialService;
  constructor(private readonly root: string) {
    this.service = new FileMaterialService(root, {
      position: async position => (await (await this.replay(position.recordingId)).state(position, { maxBytes: 1024 * 1024, limit: 1000 })).reliability,
      target: target => this.verifyTarget(target),
    });
  }
  async replay(recordingId: string, projectId?: string): Promise<ArchiveReplayService> {
    ensure(typeof recordingId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(recordingId) && recordingId !== '..', 'Invalid recording identity');
    const manifest = await safeFile(this.root, `runs/${recordingId}/manifest.json`);
    ensure((await stat(manifest)).size <= 1024 * 1024, 'Recording manifest exceeds read budget', 413);
    const recorded = JSON.parse(await readFile(manifest, 'utf8'));
    ensure(recorded.id === recordingId && (!projectId || recorded.projectId === projectId), 'Recording does not belong to this project', 403);
    return new ArchiveReplayService(path.dirname(manifest));
  }
  private async verifyTarget(target: HistoricalTarget): Promise<boolean> {
    // A screenshot's existence alone cannot establish its exact ReplayPosition.
    if (target.kind !== 'dom-node') return false;
    const service = await this.replay(target.position.recordingId);
    const state = await service.state(target.position, { maxBytes: 1024 * 1024, limit: 1000 });
    if (state.reliability !== 'reliable' || !sameReplayPosition(state.position, target.position)) return false;
    const node = await service.node(target, { maxBytes: 1024 * 1024, limit: 1 });
    return node.metadataComplete && node.ref.kind === target.kind && sameReplayPosition(node.ref.position, target.position) && node.ref.nodeId === target.nodeId && node.ref.frameId === target.frameId && node.ref.mirrorScopeId === target.mirrorScopeId;
  }
  async edit(projectId: string, draftId: string, expectedDraftRevision: number, edits: MaterialEdit[], source: 'api' | 'ui') {
    ensure(Array.isArray(edits) && edits.length > 0 && edits.length <= 100, 'Use one to 100 material edits');
    const draft = await this.service.getDraft(projectId, draftId);
    ensure(source === 'ui' || draft.author === 'agent', 'Agent may edit its candidate drafts; copy a human draft into a new agent draft first', 403);
    if (draft.draftRevision !== expectedDraftRevision) return { status: 'conflict', current: materialSummary(draft), expectedDraftRevision };
    let content = structuredClone(draft.content);
    for (const edit of edits) {
      ensure(edit && typeof edit === 'object', 'Invalid material edit');
      if (edit.operation === 'copy-checkpoint') content = copyCheckpoint(content, edit.checkpointId);
      else if (edit.operation === 'remove-checkpoint') content = removeCheckpoint(content, edit.checkpointId);
      else if (edit.operation === 'move-checkpoint') content = moveCheckpoint(content, edit.checkpointId, parseReplayPosition(edit.position));
      else if (edit.operation === 'recordings') content.recordingRefs = structuredClone(edit.recordingRefs);
      else {
        ensure(edit.operation === 'upsert' || edit.operation === 'remove', 'Unknown material edit operation');
        ensure(MATERIAL_COLLECTIONS.includes(edit.collection) && edit.collection !== ('recordingRefs' as string), 'Unknown material collection');
        const collection = content[edit.collection] as Array<{ id: string }>;
        if (edit.operation === 'remove') content = { ...content, [edit.collection]: collection.filter(item => item.id !== edit.id) };
        else {
          ensure(edit.item && typeof edit.item.id === 'string', 'Material item ID is required');
          const item = { ...structuredClone(edit.item), ...(edit.collection === 'annotations' ? { author: source === 'ui' ? 'human' : 'agent' } : {}) };
          const offset = collection.findIndex(current => current.id === item.id);
          if (offset >= 0) collection[offset] = item; else collection.push(item);
        }
      }
    }
    const recordings = new Set([...content.recordingRefs, ...content.checkpoints.map(card => card.anchor.recordingId),
      ...content.annotations.map(annotation => annotation.target.position.recordingId), ...content.fields.flatMap(field => field.target ? [field.target.position.recordingId] : [])]);
    for (const recordingId of recordings) await this.replay(recordingId, projectId);
    const result = await this.service.updateDraft(projectId, draftId, expectedDraftRevision, content, source === 'ui' ? 'human' : 'agent');
    return result.status === 'saved' ? { status: result.status, draft: materialSummary(result.draft) } : { status: result.status, current: materialSummary(result.current), expectedDraftRevision };
  }
}
