import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import type { RecordingEnvelope } from '@/capture/recording-types';
import type { BrowserMaterialInput, BrowserMaterialMethod, BrowserMaterialResult } from '@/contracts/browser-materials';
import type { MaterialEdit } from '@/contracts/workbench-project';
import { EvidenceStore } from '@/evidence/store';
import { claimWriterLock } from '@/evidence/writer-lock';
import { RecordingIndexWriter } from '@/replay/archive';
import { WorkbenchDispatcher } from '@/main/workbench/dispatch';
import { WorkbenchSessions } from '@/main/workbench/session';
import { WorkbenchHttpTransport } from '@/main/workbench/http';
import { WorkbenchPairing } from '@/main/workbench/pairing';
import { createProjectMetadataPort } from '@/main/workbench/project-port';
import { createBrowserMaterialPort } from '@/main/workbench/material-port';
import { parseMaterialRequest } from '@/main/workbench/material-validation';
import { ProjectMaterials } from '@/main/services/project-materials';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-browser-material-test-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const host: WorkspaceManagementHost = { root, projects: [], profiles: [], state: () => ({}) };
  const management = new WorkspaceManagement(host); await management.init();
  const project = await management.createProject({ name: 'Materials fixture', objective: 'A real domain fixture' });
  const other = await management.createProject({ name: 'Another project' });
  const materials = new ProjectMaterials(root), changed = vi.fn(); materials.service.onChanged = changed;
  const sessions = new WorkbenchSessions({ instanceId: 'material-instance' }); cleanup.push(() => sessions.dispose());
  const session = sessions.exchange(sessions.begin(project.id, 'project-materials').ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const dispatcher = new WorkbenchDispatcher(sessions, createProjectMetadataPort(management), undefined, createBrowserMaterialPort(root, materials));
  const request = (method: string, body: object = {}) => ({ instanceId: sessions.instanceId, method, body: { projectId: project.id, ...body } });
  const call = <M extends BrowserMaterialMethod>(method: M, body: Omit<BrowserMaterialInput<M>, 'projectId'> = {} as Omit<BrowserMaterialInput<M>, 'projectId'>): Promise<BrowserMaterialResult<M>> => dispatcher.dispatch(request(method, body), context) as Promise<BrowserMaterialResult<M>>;
  return { root, host, management, project, other, materials, changed, sessions, session, context, dispatcher, request, call };
}
async function recording(f: Awaited<ReturnType<typeof fixture>>, id = 'recording', projectId = f.project.id, seal = true, incompleteNode = false) {
  const store = await EvidenceStore.create(path.join(f.root, 'runs', id), { id, projectId, mode: 'synthetic', kind: 'demonstrate', objective: 'legal source fixture' });
  const position = { recordingId: id, pageId: 'page', documentId: 'document', streamEpoch: 'epoch', sourceTimeMs: 100, eventSeq: 1 };
  const event = { type: 2, timestamp: 100, data: { node: { type: 0, id: 1, childNodes: incompleteNode ? [{ type: 2, id: 2, tagName: 'div', attributes: {}, childNodes: [] }] : [] }, initialOffset: { left: 0, top: 0 } } } as RecordingEnvelope['event'];
  const record: RecordingEnvelope = { formatVersion: 2, position, frameId: 'top', mirrorScopeId: 'top', event, metadata: incompleteNode ? [{ nodeId: 2, rootId: 1, frameId: 'top', mirrorScopeId: 'top', shadowHostIds: [], tagName: 'div', namespaceURI: null, documentUrl: { status: 'present', value: 'https://synthetic.invalid/' }, baseURI: { status: 'present', value: 'https://synthetic.invalid/' }, attributes: {}, properties: {}, metadataComplete: false }] : [], metadataComplete: true,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, gaps: [], sourceClock: { timeOrigin: 0, monotonicMs: 100 }, receivedAt: new Date().toISOString() };
  await new RecordingIndexWriter(store).append(record);
  if (seal) await store.seal(); await store.close();
  return position;
}
test('pairing explicitly binds a new materials grant; default and old metadata sessions cannot expand it', async () => {
  const f = await fixture(), pairing = new WorkbenchPairing(f.sessions, f.management, 'http://127.0.0.1:43210');
  const ticket = await pairing.begin({ projectId: f.project.id }, () => {});
  const old = f.sessions.exchange(ticket.ticket, ticket.instanceId);
  expect(old.grant).toBe('project-metadata');
  await expect(f.dispatcher.dispatch(f.request('workingMaterialDraft'), f.sessions.authenticate(old.token, old.instanceId))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(pairing.begin({ projectId: f.project.id, grant: 'all' }, () => {})).rejects.toMatchObject({ code: 'invalid_request' });
  const fresh = await pairing.begin({ projectId: f.project.id, grant: 'project-materials' }, () => {});
  expect(f.sessions.exchange(fresh.ticket, fresh.instanceId).grant).toBe('project-materials');
  expect(() => f.sessions.authenticate(old.token, old.instanceId)).toThrow('unauthorized');
});
test('method/body/schema, prototype, depth, bytes and cross-project identities remain narrow', async () => {
  const f = await fixture();
  for (const method of ['seal', 'stateWithMaterials', 'authorizeTask', 'captureAndAuthor', 'artifact', 'historicalNode', 'openReplay']) {
    await expect(f.dispatcher.dispatch(f.request(method), f.context)).rejects.toMatchObject({ code: 'invalid_request' });
  }
  for (const body of [{ source: 'ui' }, { profileId: 'profile' }, { directory: '/tmp' }]) expect(() => parseMaterialRequest(f.request('workingMaterialDraft', body))).toThrow('invalid_request');
  expect(() => parseMaterialRequest(f.request('createMaterialDraft'))).toThrow('invalid_request');
  expect(() => parseMaterialRequest(f.request('workingMaterialDraft', { projectId: Object.create({ id: f.project.id }) }))).toThrow('invalid_request');
  let deep: unknown = 'value'; for (let i = 0; i < 30; i++) deep = { nested: deep };
  expect(() => parseMaterialRequest(f.request('editMaterialDraft', { draftId: 'draft', expectedDraftRevision: 0, edits: [deep] }))).toThrow('invalid_request');
  expect(() => parseMaterialRequest(f.request('editMaterialDraft', { draftId: 'draft', expectedDraftRevision: 0, edits: [{ operation: 'task-brief', taskBrief: { objective: 'x'.repeat(66000), scope: '' } }] }))).toThrow('invalid_request');
  expect(() => parseMaterialRequest(f.request('recordingPositions', { position: { recordingId: 'r', pageId: 'p', documentId: 'd', streamEpoch: 'e', sourceTimeMs: 1, eventSeq: 1, token: 'extra' } }))).toThrow('invalid_request');
  await expect(f.dispatcher.dispatch(f.request('workingMaterialDraft', { projectId: f.other.id }), f.context)).rejects.toMatchObject({ code: 'forbidden' });
});
test('real working copy, edit, copy and immutable publication use the shared domain and existing operation receipts', async () => {
  const f = await fixture(), at = await recording(f);
  const draft = await f.call('workingMaterialDraft');
  expect(draft).not.toHaveProperty('content');
  const edits: MaterialEdit[] = [
    { operation: 'recordings', recordingRefs: [at.recordingId] },
    { operation: 'upsert', collection: 'requirements', item: { id: 'requirement', description: 'Measured amount', fieldIds: ['field'], rules: [], dataset: 'records' } },
    { operation: 'upsert', collection: 'fields', item: { id: 'field', dataset: 'records', name: 'amount', description: 'Amount in source', sourcePolicy: 'any-evidenced', valueType: 'number' } },
    { operation: 'upsert', collection: 'checkpoints', item: { id: 'card', kind: 'observation', anchor: at, capturedAt: new Date(at.sourceTimeMs).toISOString(), createdAt: new Date().toISOString(), title: 'First card', notes: 'Saved normally', requirementIds: ['requirement'], annotationIds: ['note'] } },
    { operation: 'upsert', collection: 'annotations', item: { id: 'note', checkpointId: 'card', text: 'Plain observation', author: 'human', interpretation: 'observed', bindingStatus: 'none' } },
  ];
  const saved = await f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits }); expect(saved.status).toBe('saved');
  const copied = await f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 1, edits: [{ operation: 'copy-checkpoint', checkpointId: 'card' }] });
  expect(copied.status).toBe('saved'); if (copied.status !== 'saved') throw new Error('Expected saved');
  expect(copied.focus?.id).toBe(copied.createdIds[0]); expect(copied.createdIds[0]).not.toBe('card');
  const stale = await f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 1, edits: [{ operation: 'copy-checkpoint', checkpointId: 'card' }] }); expect(stale.status).toBe('conflict');
  const fixed = await f.call('publishMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 2, operationId: 'publish' });
  expect(await f.call('publishMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 2, operationId: 'publish' })).toEqual(fixed);
  expect((await f.call('materialPublicationStatus', { operationId: 'publish' })).stage).toBe('manifest-saved');
  const draftCopy = await f.call('copyMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 3, operationId: 'copy' });
  expect(await f.call('copyMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 3, operationId: 'copy' })).toEqual(draftCopy);
  const derived = await f.call('createMaterialDraft', { baseRevisionId: fixed.revisionId, operationId: 'derive' });
  expect(await f.call('createMaterialDraft', { baseRevisionId: fixed.revisionId, operationId: 'derive' })).toEqual(derived);
  const disk = JSON.parse(await readFile(path.join(f.root, 'projects', f.project.id, 'materials', 'revisions', `${fixed.revisionId}.json`), 'utf8'));
  expect(disk.content.fields[0].description).toBe('Amount in source'); expect(disk.content.checkpoints).toHaveLength(2);
  expect((await f.materials.service.revision(f.project.id, fixed.revisionId, fixed.contentHash)).content).toEqual(disk.content);
  await expect(f.call('materialRevision', { revisionId: fixed.revisionId, contentHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
});
test('only sealed same-project sources and exact recorded positions can enter a browser draft', async () => {
  const f = await fixture(); const at = await recording(f), live = await recording(f, 'live', f.project.id, false), foreign = await recording(f, 'foreign', f.other.id);
  const list = await f.call('materialRecordings'); expect(list.items.map(item => item.recordingId)).toEqual(['recording']);
  expect((await f.call('recordingStreams', { recordingId: at.recordingId })).items[0].first).toEqual(at);
  expect((await f.call('recordingPositions', { position: at })).items[0].position).toEqual(at);
  await expect(f.call('recordingStreams', { recordingId: live.recordingId })).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.call('recordingStreams', { recordingId: foreign.recordingId })).rejects.toMatchObject({ code: 'forbidden' });
  const draft = await f.call('workingMaterialDraft');
  for (const source of [live, foreign, { ...at, eventSeq: 999 }]) {
    await expect(f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [
      { operation: 'recordings', recordingRefs: [source.recordingId] },
      { operation: 'upsert', collection: 'checkpoints', item: { id: 'bad', kind: 'observation', anchor: source, capturedAt: new Date(source.sourceTimeMs).toISOString(), createdAt: new Date().toISOString(), title: 'Rejected', notes: '', requirementIds: [], annotationIds: [] } },
    ] })).rejects.toThrow();
  }
  expect((await f.call('materialDraft', { draftId: draft.draftId })).draftRevision).toBe(0);
});
test('catalog repair/ensure emit only actual domain changes; normal reads do not self-invalidate', async () => {
  const f = await fixture(); await f.call('workingMaterialDraft'); const count = f.changed.mock.calls.length; expect(count).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) await Promise.all([f.call('workingMaterialDraft'), f.call('materialCatalog'), f.call('materialDrafts'), f.call('materialRevisions')]);
  expect(f.changed).toHaveBeenCalledTimes(count);
  const draft = await f.call('workingMaterialDraft'); await f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [{ operation: 'task-brief', taskBrief: { objective: 'Updated', scope: '' } }] });
  expect(f.changed).toHaveBeenCalledTimes(count + 1);
  expect(f.project.revision).toBe(1);
});
test.each(['revoke', 'abort'] as const)('queued material write rechecks %s after the real domain writer lock', async cancellation => {
  const f = await fixture(), draft = await f.call('workingMaterialDraft');
  const materialRoot = path.join(f.root, 'projects', f.project.id, 'materials'), lock = await claimWriterLock(materialRoot);
  const controller = new AbortController();
  const pending = f.dispatcher.dispatch(f.request('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [{ operation: 'task-brief', taskBrief: { objective: 'Must not write', scope: '' } }] }), f.context, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: cancellation === 'revoke' ? 'unauthorized' : 'cancelled' });
  // The held real lock ensures the browser operation cannot start its write.
  await new Promise(resolve => setTimeout(resolve, 50));
  if (cancellation === 'revoke') f.sessions.revokeIssuer(); else controller.abort();
  await lock.release(); await rejected;
  expect((await f.materials.service.getDraft(f.project.id, draft.draftId)).draftRevision).toBe(0);
});
test('already-entered domain write may complete after revocation without claiming rollback', async () => {
  const f = await fixture(), draft = await f.call('workingMaterialDraft');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  // Source validation happens within updateDraft's writer operation.
  const at = await recording(f);
  const original = f.materials.replay.bind(f.materials);
  let calls = 0;
  vi.spyOn(f.materials, 'replay').mockImplementation(async (...args) => { if (++calls === 2) { entered(); await gate; } return original(...args); });
  const pending = f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [
    { operation: 'recordings', recordingRefs: [at.recordingId] },
    { operation: 'upsert', collection: 'checkpoints', item: { id: 'c', kind: 'observation', anchor: at, capturedAt: new Date(at.sourceTimeMs).toISOString(), createdAt: new Date().toISOString(), title: 'Finishes', notes: '', requirementIds: [], annotationIds: [] } },
  ] });
  await reached; f.sessions.revokeIssuer(); release();
  expect(await pending).toMatchObject({ status: 'saved', draft: { draftRevision: 1 } });
  expect((await f.materials.service.getDraft(f.project.id, draft.draftId)).draftRevision).toBe(1);
});
test('HTTP material budget is independent, metadata defaults stay bounded, and private error bodies never escape', async () => {
  const f = await fixture();
  const transport = new WorkbenchHttpTransport({ origin: 'http://127.0.0.1:43211', sessions: f.sessions, projectPort: createProjectMetadataPort(f.management), materialPort: createBrowserMaterialPort(f.root, f.materials) });
  const endpoint = await transport.start(); cleanup.push(() => transport.dispose());
  const headers = { Origin: endpoint.origin, 'Content-Type': 'application/json', 'X-Workbench-Instance': f.sessions.instanceId, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Authorization: `Bearer ${f.session.token}` };
  const post = (body: unknown, token = f.session.token) => fetch(`${endpoint.baseUrl}/workbench/rpc`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const draft = await f.call('workingMaterialDraft');
  const body = f.request('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [{ operation: 'task-brief', taskBrief: { objective: '中'.repeat(7000), scope: '' } }] });
  expect((await post(body)).status).toBe(200);
  const paddedMetadata = await fetch(`${endpoint.baseUrl}/workbench/rpc`, { method: 'POST', headers, body: ' '.repeat(17000) + JSON.stringify(f.request('state')) });
  expect(paddedMetadata.status).toBe(400);
  const metadata = f.sessions.exchange(f.sessions.begin(f.project.id).ticket, f.sessions.instanceId);
  expect((await post(body, metadata.token)).status).toBe(400);
  await writeFile(path.join(f.root, 'projects', f.project.id, 'materials', 'drafts', `${draft.draftId}.json`), '{corrupt');
  const response = await post(f.request('materialDraft', { draftId: draft.draftId }));
  expect(await response.json()).toEqual({ error: { code: 'unavailable' } });
});


test.each(['create', 'copy'] as const)('browser %s receipt recovery rechecks native unsealed snapshots before manifest restoration', async kind => {
  const f = await fixture();
  await recording(f, 'interrupted-source', f.project.id, false);
  // Normal native recovery records interrupted state; no receipt or content file
  // is hand-written to manufacture the security condition.
  const recovered = await EvidenceStore.open(path.join(f.root, 'runs', 'interrupted-source')); await recovered.close();
  const original = await f.materials.service.createDraft(f.project.id, 'human');
  await f.materials.service.updateDraft(f.project.id, original.draftId, 0, { ...original.content, recordingRefs: ['interrupted-source'] }, 'human');
  const base = kind === 'create' ? await f.materials.service.publish(f.project.id, original.draftId, 1, 'human', 'native-publish') : undefined;
  const operationId = `native-${kind}`, id = `${kind}-${operationId}`;
  const target = path.join(f.root, 'projects', f.project.id, 'materials', 'drafts', `${id}.json`);
  const link = fs.link.bind(fs);
  const failure = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (String(destination) === target) throw Object.assign(new Error('Synthetic manifest failure after receipt'), { code: 'ENOSPC' });
    return link(source, destination);
  });
  await expect(kind === 'copy'
    ? f.materials.service.copyDraft(f.project.id, original.draftId, 1, operationId)
    : f.materials.service.createDraft(f.project.id, 'human', base!.revisionId, operationId)).rejects.toThrow('Synthetic manifest failure');
  failure.mockRestore();
  const receiptFile = path.join(path.dirname(path.dirname(target)), `${kind}-${operationId}.receipt`);
  const receiptBefore = await readFile(receiptFile, 'utf8');
  await expect(kind === 'copy'
    ? f.call('copyMaterialDraft', { draftId: original.draftId, expectedDraftRevision: 1, operationId })
    : f.call('createMaterialDraft', { baseRevisionId: base!.revisionId, operationId })).rejects.toMatchObject({ code: 'conflict' });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(receiptFile, 'utf8')).toBe(receiptBefore);
});

test.each(['create', 'copy'] as const)('browser %s receipt recovery preserves the original sealed snapshot and notifies actual restoration', async kind => {
  const f = await fixture(); await recording(f);
  const original = await f.materials.service.createDraft(f.project.id, 'human');
  await f.materials.service.updateDraft(f.project.id, original.draftId, 0, { ...original.content, recordingRefs: ['recording'] }, 'human');
  const base = kind === 'create' ? await f.materials.service.publish(f.project.id, original.draftId, 1, 'human', 'native-publish') : undefined;
  const operationId = `sealed-${kind}`, id = `${kind}-${operationId}`;
  const target = path.join(f.root, 'projects', f.project.id, 'materials', 'drafts', `${id}.json`);
  const link = fs.link.bind(fs);
  const failure = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (String(destination) === target) throw Object.assign(new Error('Synthetic manifest failure after receipt'), { code: 'ENOSPC' });
    return link(source, destination);
  });
  await expect(kind === 'copy'
    ? f.materials.service.copyDraft(f.project.id, original.draftId, 1, operationId)
    : f.materials.service.createDraft(f.project.id, 'human', base!.revisionId, operationId)).rejects.toThrow('Synthetic manifest failure');
  failure.mockRestore(); f.changed.mockClear();
  const restore = () => kind === 'copy'
    ? f.call('copyMaterialDraft', { draftId: original.draftId, expectedDraftRevision: 1, operationId })
    : f.call('createMaterialDraft', { baseRevisionId: base!.revisionId, operationId });
  const result = await restore(); expect(result.draftId).toBe(id); expect(f.changed).toHaveBeenCalledWith(f.project.id);
  const written = await readFile(target, 'utf8');
  expect(await restore()).toEqual(result); expect(await readFile(target, 'utf8')).toBe(written);
});

test.each([false, true])('publication journal recovery rechecks the original snapshot (sealed=%s) after a later clean native edit', async sealed => {
  const f = await fixture(); await recording(f, 'journal-source', f.project.id, sealed);
  if (!sealed) { const recovered = await EvidenceStore.open(path.join(f.root, 'runs', 'journal-source')); await recovered.close(); }
  const original = await f.materials.service.createDraft(f.project.id, 'human');
  await f.materials.service.updateDraft(f.project.id, original.draftId, 0, { ...original.content, recordingRefs: ['journal-source'] }, 'human');
  const link = fs.link.bind(fs);
  const failure = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (path.dirname(String(destination)).endsWith('/materials/revisions')) throw Object.assign(new Error('Synthetic fixed-manifest failure'), { code: 'ENOSPC' });
    return link(source, destination);
  });
  await expect(f.materials.service.publish(f.project.id, original.draftId, 1, 'human', 'native-publication')).rejects.toThrow('Synthetic fixed-manifest failure');
  failure.mockRestore();
  await f.materials.service.updateDraft(f.project.id, original.draftId, 1, original.content, 'human');
  const status = await f.materials.service.publicationStatus(f.project.id, 'native-publication');
  if (status.stage === 'not-started') throw new Error('Expected journal identity');
  f.changed.mockClear();
  const result = f.call('publishMaterialDraft', { draftId: original.draftId, expectedDraftRevision: 1, operationId: 'native-publication' });
  if (!sealed) {
    await expect(result).rejects.toMatchObject({ code: 'conflict' });
    await expect(fs.stat(path.join(f.root, 'projects', f.project.id, 'materials', 'revisions', `${status.revisionId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.changed).not.toHaveBeenCalled();
  } else {
    expect(await result).toMatchObject({ revisionId: status.revisionId, contentHash: status.contentHash });
    expect(f.changed).toHaveBeenCalledWith(f.project.id);
    expect((await f.materials.service.getDraft(f.project.id, original.draftId)).draftRevision).toBe(2);
  }
});

test.each(['field', 'example'])('forged %s binding enums are rejected before they can bypass recorded target verification', async kind => {
  const f = await fixture(), position = await recording(f, 'recording', f.project.id, true, true), draft = await f.call('workingMaterialDraft');
  const card = { id: 'c', kind: 'observation' as const, anchor: position, capturedAt: new Date(position.sourceTimeMs).toISOString(), createdAt: new Date().toISOString(), title: 'Source card', notes: '', requirementIds: [], annotationIds: [] };
  await f.call('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 0, edits: [{ operation: 'recordings', recordingRefs: [position.recordingId] }, { operation: 'upsert', collection: 'checkpoints', item: card }] });
  const target = { kind: 'dom-node', position, frameId: 'top', mirrorScopeId: 'top', nodeId: 2 };
  const verify = vi.spyOn(f.materials as unknown as { verifyTarget(value: unknown): Promise<boolean> }, 'verifyTarget');
  const field = (bindingStatus: unknown) => ({ id: 'f', dataset: 'records', name: 'missing node', description: 'A real source target must be verified', sourcePolicy: 'any-evidenced',
    ...(kind === 'field' ? { target, checkpointId: 'c', bindingStatus } : { examples: [{ id: 'example', checkpointId: 'c', target, bindingStatus }] }) });
  const attempt = (bindingStatus: unknown) => f.dispatcher.dispatch(f.request('editMaterialDraft', { draftId: draft.draftId, expectedDraftRevision: 1, edits: [{ operation: 'upsert', collection: 'fields', item: field(bindingStatus) }] }), f.context);
  await expect(attempt(['bound'])).rejects.toMatchObject({ code: 'invalid_request' }); expect(verify).not.toHaveBeenCalled();
  await expect(attempt('bound')).rejects.toMatchObject({ code: 'invalid_request' }); expect(verify).toHaveBeenCalledTimes(1);
  await expect(verify.mock.results[0].value).resolves.toBe(false); // Domain rejects INVALID_SOURCE; transport exposes only its fixed code.
  expect((await f.materials.service.getDraft(f.project.id, draft.draftId)).draftRevision).toBe(1);
});
