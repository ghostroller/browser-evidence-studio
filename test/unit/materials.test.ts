import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MaterialContent } from '@/contracts/materials';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import { FileMaterialService, MaterialConflictError, MaterialError, copyCheckpoint, moveCheckpoint, projectLegacyRecording, removeCheckpoint } from '@/materials';

const PROJECT = 'project-one';
let root: string;
let service: FileMaterialService;
const position = (recordingId: string, eventSeq = 1): ReplayPosition => ({ recordingId, pageId: 'page-a', documentId: 'document-a',
  streamEpoch: 'epoch-a', sourceTimeMs: 1000, eventSeq });
const target = (at: ReplayPosition): HistoricalElementRef => ({ kind: 'dom-node', position: at, frameId: 'top', mirrorScopeId: 'epoch-a:document-1', nodeId: 3 });
const fixture = (): MaterialContent => ({
  recordingRefs: ['recording-one', 'recording-two'],
  requirements: [{ id: 'orders', description: 'Every paid order', dataset: 'orders', rules: [{ type: 'pagination-complete', minPages: 2 }], fieldIds: ['amount'] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'The charged amount', sourcePolicy: 'any-evidenced',
    target: target(position('recording-one')), checkpointId: 'first', annotationId: 'note-one', bindingStatus: 'bound' }],
  checkpoints: [
    { id: 'first', kind: 'requirement', anchor: position('recording-one'), capturedAt: '2026-09-26T00:00:00.000Z',
      createdAt: '2026-09-26T01:00:00.000Z', title: 'First demo', notes: '', requirementIds: ['orders'], annotationIds: ['note-one'] },
    { id: 'second', kind: 'requirement', anchor: position('recording-two'), capturedAt: '2026-09-26T02:00:00.000Z',
      createdAt: '2026-09-26T03:00:00.000Z', title: 'Second demo', notes: '', requirementIds: ['orders'], annotationIds: [] },
  ],
  annotations: [{ id: 'note-one', checkpointId: 'first', target: target(position('recording-one')), text: 'Example paid amount',
    author: 'human', interpretation: 'observed', bindingStatus: 'bound' }],
});

beforeEach(async () => {
  const testDataRoot = process.env.BES_DATA ?? path.join(process.cwd(), 'output', 'data-B');
  await fs.mkdir(testDataRoot, { recursive: true });
  root = await fs.mkdtemp(path.join(testDataRoot, 'materials-unit-'));
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, projects: [{ id: PROJECT }, { id: 'project-other' }] }));
  for (const [recordingId, projectId] of [['recording-one', PROJECT], ['recording-two', PROJECT], ['foreign', 'project-other']]) {
    const run = path.join(root, 'runs', recordingId);
    await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: recordingId, projectId }));
  }
  service = new FileMaterialService(root, { position: async () => 'reliable', target: async () => true });
});
afterEach(async () => {
  const testDataRoot = path.resolve(process.env.BES_DATA ?? path.join(process.cwd(), 'output', 'data-B'));
  if (!path.resolve(root).startsWith(`${testDataRoot}${path.sep}`)) throw new Error('Test cleanup escaped its generated data root');
  await fs.rm(root, { recursive: true, force: true });
});

describe('project materials', () => {
  it('keeps one project requirement shared by two demonstrations and preserves V1 across V2', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    const source = fixture();
    const saved = await service.updateDraft(PROJECT, draft.draftId, 0, source, 'human');
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') throw new Error('Expected saved draft');
    source.requirements[0].description = 'Caller mutation after update';
    const v1 = await service.publish(PROJECT, draft.draftId, 1, 'agent');
    expect(v1.content.requirements).toHaveLength(1);
    expect(v1.content.checkpoints.map(card => card.requirementIds)).toEqual([['orders'], ['orders']]);
    expect(v1.content.requirements[0].description).toBe('Every paid order');
    expect(v1.author).toBe('agent'); // publishing is not approval
    const afterPublish = await service.getDraft(PROJECT, draft.draftId);
    expect(afterPublish.draftRevision).toBe(2);
    expect(afterPublish.baseRevisionId).toBe(v1.revisionId);
    const changed = structuredClone(afterPublish.content);
    changed.requirements[0].description = 'Every paid order including refunds';
    const second = await service.updateDraft(PROJECT, draft.draftId, 2, changed, 'human');
    expect(second.status).toBe('saved');
    const v2 = await service.publish(PROJECT, draft.draftId, 3, 'human');
    expect(v2.parentRevisionId).toBe(v1.revisionId);
    expect((await service.revision(PROJECT, v1.revisionId, v1.contentHash)).content.requirements[0].description).toBe('Every paid order');
    expect(v2.contentHash).not.toBe(v1.contentHash);
    await expect(service.revision(PROJECT, v1.revisionId, v2.contentHash)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    const diff = await service.diff(PROJECT, v1.revisionId, v2.revisionId, { maxBytes: 32768, limit: 20 });
    expect(diff.items).toEqual([{ collection: 'requirements', id: 'orders', change: 'changed', changedFields: ['description'] }]);
  });

  it('shows the current draft on concurrent update and rejects stale publication', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    const [a, b] = await Promise.all([
      service.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human'),
      service.updateDraft(PROJECT, draft.draftId, 0, { ...fixture(), requirements: [{ ...fixture().requirements[0], description: 'A competing edit' }] }, 'agent'),
    ]);
    expect([a.status, b.status].sort()).toEqual(['conflict', 'saved']);
    const conflict = a.status === 'conflict' ? a : b;
    if (conflict.status !== 'conflict') throw new Error('Expected conflict');
    expect(conflict.current.draftRevision).toBe(1);
    await expect(service.publish(PROJECT, draft.draftId, 0, 'human')).rejects.toBeInstanceOf(MaterialConflictError);
    expect((await service.getDraft(PROJECT, draft.draftId)).draftRevision).toBe(1);
  });

  it('copies card and annotation IDs, moves old bindings to review, and leaves shared requirement intact on removal', () => {
    const source = fixture();
    const copied = copyCheckpoint(source, 'first', '2026-09-26T04:00:00.000Z');
    expect(copied.requirements).toEqual(source.requirements);
    expect(copied.fields).toEqual(source.fields);
    expect(copied.checkpoints).toHaveLength(3);
    const card = copied.checkpoints[2];
    expect(card.id).not.toBe('first');
    expect(card.derivedFrom).toBe('first');
    expect(card.capturedAt).toBe(source.checkpoints[0].capturedAt);
    expect(card.createdAt).not.toBe(card.capturedAt);
    expect(card.annotationIds[0]).not.toBe('note-one');
    expect(copied.annotations[1].target).toEqual(source.annotations[0].target);
    const moved = moveCheckpoint(source, 'first', position('recording-one', 2));
    expect(moved.annotations[0].bindingStatus).toBe('needs-rebind');
    expect(moved.fields[0].bindingStatus).toBe('needs-rebind');
    expect(moved.annotations[0].target).toEqual(source.annotations[0].target);
    expect(moved.fields[0].target).toEqual(source.fields[0].target);
    const removed = removeCheckpoint(source, 'first');
    expect(removed.requirements).toEqual(source.requirements);
    expect(removed.checkpoints).toHaveLength(1);
    expect(removed.fields[0].bindingStatus).toBe('needs-rebind');
  });

  it('rejects unsafe paths, foreign recordings, wrong target identity and stale page cursors', async () => {
    await expect(service.createDraft('CON', 'human')).rejects.toBeInstanceOf(MaterialError);
    await expect(service.createDraft('../escape', 'human')).rejects.toBeInstanceOf(MaterialError);
    const draft = await service.createDraft(PROJECT, 'human');
    const foreign = fixture(); foreign.recordingRefs = ['foreign'];
    foreign.checkpoints = []; foreign.annotations = []; foreign.fields = []; foreign.requirements = [];
    await expect(service.updateDraft(PROJECT, draft.draftId, 0, foreign, 'human')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const wrong = fixture();
    wrong.fields[0].target = { ...target(position('recording-one')), nodeId: 99 };
    await expect(service.updateDraft(PROJECT, draft.draftId, 0, wrong, 'human')).rejects.toMatchObject({ code: 'INVALID_MATERIAL' });
    const saved = await service.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human');
    expect(saved.status).toBe('saved');
    const firstPage = await service.pageCollection(PROJECT, { kind: 'draft', id: draft.draftId }, 'checkpoints', { maxBytes: 2048, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const next = await service.pageCollection(PROJECT, { kind: 'draft', id: draft.draftId }, 'checkpoints', { maxBytes: 2048, limit: 1, cursor: firstPage.nextCursor });
    expect(next.items[0].id).toBe('second');
    await expect(service.pageCollection(PROJECT, { kind: 'draft', id: draft.draftId }, 'fields', { maxBytes: 2048, limit: 1, cursor: firstPage.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('detects revision corruption without replacing the original manifest', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    await service.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human');
    const revision = await service.publish(PROJECT, draft.draftId, 1, 'human');
    const file = path.join(root, 'projects', PROJECT, 'materials', 'revisions', `${revision.revisionId}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as typeof revision;
    raw.content.requirements[0].description = 'tampered';
    await fs.writeFile(file, JSON.stringify(raw));
    await expect(service.revision(PROJECT, revision.revisionId)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it('projects legacy checkpoints without fabricating historical anchors or modifying source bytes', async () => {
    const file = path.join(root, 'runs', 'recording-one', 'checkpoints.jsonl');
    await fs.writeFile(file, `${JSON.stringify({ id: 'old-one', title: 'Old save', description: 'Observed', requirementIds: ['orders'], captureEndedAt: '2026-09-26T00:00:00.000Z' })}\n`);
    const before = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const page = await projectLegacyRecording(root, PROJECT, 'recording-one', { maxBytes: 32768, limit: 10 });
    expect(page.items).toEqual([{ id: 'old-one', recordingId: 'recording-one', title: 'Old save', description: 'Observed',
      requirementIds: ['orders'], capturedAt: '2026-09-26T00:00:00.000Z', anchorStatus: 'unavailable', sourceStatus: 'legacy-schema-1' }]);
    expect(page.sourceStatus).toBe('complete');
    expect(createHash('sha256').update(await fs.readFile(file)).digest('hex')).toBe(before);
    await expect(projectLegacyRecording(root, PROJECT, 'foreign', { maxBytes: 32768, limit: 10 })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });
});
