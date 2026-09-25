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

  it('accepts a described field alone, a field with a target, and a field with target plus annotation', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    const described = fixture();
    described.fields[0] = { id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'Charged amount', sourcePolicy: 'any-evidenced' };
    described.annotations = [];
    described.checkpoints[0].annotationIds = [];
    let result = await service.updateDraft(PROJECT, draft.draftId, 0, described, 'human');
    expect(result.status).toBe('saved');
    const withTarget = structuredClone(described);
    withTarget.fields[0] = { ...withTarget.fields[0], target: target(position('recording-one')), checkpointId: 'first', bindingStatus: 'bound' };
    result = await service.updateDraft(PROJECT, draft.draftId, 1, withTarget, 'human');
    expect(result.status).toBe('saved');
    result = await service.updateDraft(PROJECT, draft.draftId, 2, fixture(), 'human');
    expect(result.status).toBe('saved');
    const current = await service.getDraft(PROJECT, draft.draftId);
    expect(current.content.fields[0].annotationId).toBe('note-one');
    expect(current.content.requirements).toHaveLength(1);
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
    const compact = await service.pageCollection(PROJECT, { kind: 'draft', id: draft.draftId }, 'recordingRefs', { maxBytes: 1024, limit: 1 });
    expect(compact.items).toEqual(['recording-one']);
    expect(compact.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(compact), 'utf8'));
    expect(compact.returnedBytes).toBeLessThanOrEqual(1024);
  });

  it('requires recorded-source verification for new anchors and checks the actual run project first', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    const withoutVerifier = new FileMaterialService(root);
    await expect(withoutVerifier.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human')).rejects.toMatchObject({ code: 'SOURCE_VERIFIER_REQUIRED' });
    const gapVerifier = new FileMaterialService(root, { position: async () => 'gap', target: async () => true });
    await expect(gapVerifier.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const fieldOnly = fixture(); fieldOnly.annotations = []; fieldOnly.checkpoints[0].annotationIds = []; delete fieldOnly.fields[0].annotationId;
    await expect(gapVerifier.updateDraft(PROJECT, draft.draftId, 0, fieldOnly, 'human')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const wrongProject = fixture(); wrongProject.recordingRefs = ['foreign'];
    await expect(service.updateDraft(PROJECT, draft.draftId, 0, wrongProject, 'human')).rejects.toMatchObject({ code: 'INVALID_MATERIAL' });
    const foreignOnly: MaterialContent = { requirements: [], fields: [], checkpoints: [], annotations: [], recordingRefs: ['foreign'] };
    await expect(gapVerifier.updateDraft(PROJECT, draft.draftId, 0, foreignOnly, 'human')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('measures diff response bytes including the envelope and preserves a small page budget', async () => {
    const draft = await service.createDraft(PROJECT, 'human');
    await service.updateDraft(PROJECT, draft.draftId, 0, fixture(), 'human');
    const v1 = await service.publish(PROJECT, draft.draftId, 1, 'human');
    const current = await service.getDraft(PROJECT, draft.draftId);
    const changed = structuredClone(current.content);
    changed.requirements[0].description = 'Updated requirement';
    changed.checkpoints[0].title = 'Updated title';
    await service.updateDraft(PROJECT, draft.draftId, current.draftRevision, changed, 'human');
    const v2 = await service.publish(PROJECT, draft.draftId, current.draftRevision + 1, 'human');
    const page = await service.diff(PROJECT, v1.revisionId, v2.revisionId, { maxBytes: 1024, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.outputTruncated).toBe(true);
    expect(page.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(page), 'utf8'));
    expect(page.returnedBytes).toBeLessThanOrEqual(1024);
    const second = await service.diff(PROJECT, v1.revisionId, v2.revisionId, { maxBytes: 1024, limit: 1, cursor: page.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(second), 'utf8'));
  });

  it('discovers drafts and revisions through bounded summaries with stale-cursor detection', async () => {
    const first = await service.createDraft(PROJECT, 'human');
    const second = await service.createDraft(PROJECT, 'agent');
    const draftPage = await service.listDrafts(PROJECT, { maxBytes: 1024, limit: 1 });
    expect(draftPage.items).toHaveLength(1);
    expect(draftPage.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(draftPage), 'utf8'));
    const next = await service.listDrafts(PROJECT, { maxBytes: 1024, limit: 1, cursor: draftPage.nextCursor });
    expect(new Set([draftPage.items[0].draftId, next.items[0].draftId])).toEqual(new Set([first.draftId, second.draftId]));
    const v1 = await service.publish(PROJECT, first.draftId, 0, 'human');
    const v2 = await service.publish(PROJECT, second.draftId, 0, 'agent');
    const revisions = await service.listRevisions(PROJECT, { maxBytes: 1024, limit: 1 });
    expect(revisions.items).toHaveLength(1);
    expect(revisions.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(revisions), 'utf8'));
    const revisionTail = await service.listRevisions(PROJECT, { maxBytes: 1024, limit: 1, cursor: revisions.nextCursor });
    expect(new Set([revisions.items[0].revisionId, revisionTail.items[0].revisionId])).toEqual(new Set([v1.revisionId, v2.revisionId]));
    await service.createDraft(PROJECT, 'human');
    await expect(service.listDrafts(PROJECT, { maxBytes: 1024, limit: 1, cursor: draftPage.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    const damagedFile = path.join(root, 'projects', PROJECT, 'materials', 'revisions', `${v1.revisionId}.json`);
    await fs.writeFile(damagedFile, '{damaged');
    const discovered = await service.listRevisions(PROJECT, { maxBytes: 4096, limit: 10 });
    expect(discovered.items.find(item => item.revisionId === v1.revisionId)).toMatchObject({ status: 'unavailable', reason: 'INVALID_RECORD' });
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
      requirementIds: ['orders'], capturedAt: '2026-09-26T00:00:00.000Z', captureTimeStatus: 'present', truncatedFields: [], anchorStatus: 'unavailable', sourceStatus: 'legacy-schema-1' }]);
    expect(page.sourceStatus).toBe('complete');
    expect(page.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(page), 'utf8'));
    expect(createHash('sha256').update(await fs.readFile(file)).digest('hex')).toBe(before);
    await expect(projectLegacyRecording(root, PROJECT, 'foreign', { maxBytes: 32768, limit: 10 })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('marks legacy field summaries and malformed records without hiding truncation', async () => {
    const file = path.join(root, 'runs', 'recording-one', 'checkpoints.jsonl');
    const missing = await projectLegacyRecording(root, PROJECT, 'recording-one', { maxBytes: 1024, limit: 1 });
    expect(missing.sourceStatus).toBe('missing');
    expect(missing.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(missing), 'utf8'));
    await fs.writeFile(file, `${JSON.stringify({ id: 'old-long', title: 'x'.repeat(510), description: 'short', requirementIds: ['orders'] })}\n{invalid-json}\n`);
    const page = await projectLegacyRecording(root, PROJECT, 'recording-one', { maxBytes: 1024, limit: 1 });
    expect(page.items[0].truncatedFields).toContain('title');
    expect(page.items[0].captureTimeStatus).toBe('missing');
    expect(page.sourceStatus).toBe('partial');
    expect(page.outputTruncated).toBe(true);
    expect(page.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(page), 'utf8'));
    expect(page.returnedBytes).toBeLessThanOrEqual(1024);
    const tail = await projectLegacyRecording(root, PROJECT, 'recording-one', { maxBytes: 1024, limit: 1, cursor: page.nextCursor });
    expect(tail.invalidRecords).toBe(1);
    expect(tail.sourceStatus).toBe('partial');
    expect(tail.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(tail), 'utf8'));
  });
});
