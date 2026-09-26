import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MaterialContent } from '@/contracts/materials';
import { FileMaterialService } from '@/materials';
import { exportFixedTaskHandoff } from '@/main/services/fixed-task-handoff';
import { TaskAuthorizations } from '@/main/services/task-authorization';

let root: string;
let materials: FileMaterialService;
let tasks: TaskAuthorizations;
const projectId = 'handoff-project';
const content = (): MaterialContent => ({
  requirements: [{ id: 'orders', description: 'Do not export Cookie=private-cookie or Bearer private-token', dataset: 'orders', rules: [{ type: 'min-rows', count: 1 }], fieldIds: ['amount'] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Private customer name', description: 'password=private-value', sourcePolicy: 'page-displayed', bindingStatus: undefined }],
  checkpoints: [], annotations: [], recordingRefs: [],
});

beforeEach(async () => {
  const parent = path.resolve(process.env.BES_DATA ?? path.join(process.cwd(), 'output', 'data-Q3'));
  await fs.mkdir(parent, { recursive: true });
  root = await fs.mkdtemp(path.join(parent, 'handoff-unit-'));
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, projects: [{ id: projectId }] }));
  await fs.mkdir(path.join(root, 'runs', 'recording-1'), { recursive: true });
  await fs.writeFile(path.join(root, 'runs', 'recording-1', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'recording-1', projectId }));
  materials = new FileMaterialService(root, { position: async () => 'reliable', target: async () => true });
  tasks = new TaskAuthorizations();
});
afterEach(async () => {
  tasks.close();
  const parent = path.resolve(process.env.BES_DATA ?? path.join(process.cwd(), 'output', 'data-Q3'));
  if (!path.resolve(root).startsWith(`${parent}${path.sep}`)) throw new Error('Test cleanup escaped generated data root');
  await fs.rm(root, { recursive: true, force: true });
});

async function revision(value = content()) {
  const draft = await materials.createDraft(projectId, 'human');
  const updated = await materials.updateDraft(projectId, draft.draftId, 0, value, 'human');
  if (updated.status !== 'saved') throw new Error('Fixture draft was not saved');
  return materials.publish(projectId, draft.draftId, 1, 'human');
}
async function authorization() {
  return tasks.issue({ projectId }, { origins: [], pages: [], capabilities: ['materials-read', 'handoff-export'], durationMs: 60_000, maxOperations: 10 });
}
const input = (revisionId: string, contentHash: string, authorizationId: string) => ({ projectId, revisionId, contentHash, authorizationId,
  instanceId: 'instance-test', connectionFile: path.join(root, 'connection', 'agent-connection.json') });

describe('fixed task handoff', () => {
  it('exports a hashed, bounded reference bundle while retaining the exact V1 baseline after V2', async () => {
    const first = await revision(), grant = await authorization();
    const result = await exportFixedTaskHandoff(root, materials, tasks, input(first.revisionId, first.contentHash, grant.authorizationId));
    const task = await fs.readFile(result.taskFile, 'utf8');
    const manifest = JSON.parse(await fs.readFile(result.manifestFile, 'utf8'));
    const access = JSON.parse(await fs.readFile(result.accessFile, 'utf8'));
    expect(manifest.contentHash).toBe(first.contentHash);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.counts).toMatchObject({ requirements: 1, fields: 1, checkpoints: 0 });
    expect(manifest.read.collections).toContain('requirements');
    expect(access.authorization.authorizationId).toBe(grant.authorizationId);
    expect(access.instanceId).toBe('instance-test');
    expect(manifest).not.toHaveProperty('authorization');
    expect(manifest).not.toHaveProperty('instanceId');
    expect(manifest.taskSha256).toBe(createHash('sha256').update(task).digest('hex'));
    expect(`${task}\n${JSON.stringify(manifest)}\n${JSON.stringify(access)}`).not.toMatch(/private-cookie|private-token|private-value|Private customer name/);
    expect(manifest).not.toHaveProperty('token');
    const draft = await materials.createDraft(projectId, 'agent', first.revisionId);
    const changed = structuredClone(first.content); changed.requirements[0].description = 'new scope';
    const saved = await materials.updateDraft(projectId, draft.draftId, 0, changed, 'agent');
    if (saved.status !== 'saved') throw new Error('Fixture edit was not saved');
    const second = await materials.publish(projectId, draft.draftId, 1, 'agent');
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(JSON.parse(await fs.readFile(result.manifestFile, 'utf8')).contentHash).toBe(first.contentHash);
  });

  it.each([250, 1000])('exports %i checkpoints without losing fixed semantics or paging access', async count => {
    const value = content();
    value.fields.push({ id: 'access_token_label', dataset: 'orders', name: 'Synthetic label', description: 'ordinary field label', sourcePolicy: 'any-evidenced' });
    value.checkpoints = Array.from({ length: count }, (_, index) => ({ id: `card-${index}`, kind: 'requirement' as const,
      anchor: { recordingId: 'recording-1', pageId: 'page-1', documentId: 'document-1', streamEpoch: 'epoch-1', sourceTimeMs: index, eventSeq: index },
      capturedAt: '2026-09-26T00:00:00.000Z', createdAt: '2026-09-26T00:00:00.000Z', title: `Card ${index}`, notes: '', requirementIds: ['orders'], annotationIds: [] }));
    value.recordingRefs = ['recording-1'];
    const fixed = await revision(value), grant = await authorization();
    const result = await exportFixedTaskHandoff(root, materials, tasks, input(fixed.revisionId, fixed.contentHash, grant.authorizationId));
    const manifest = JSON.parse(await fs.readFile(result.manifestFile, 'utf8'));
    expect(manifest.counts).toMatchObject({ checkpoints: count, fields: 2, recordingRefs: 1 });
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(64 * 1024);
    let cursor: string | undefined, seen = 0;
    do {
      const page = await materials.pageCollection(projectId, { kind: 'revision', id: fixed.revisionId, expectedHash: fixed.contentHash }, 'checkpoints', { limit: 50, maxBytes: 24576, ...(cursor ? { cursor } : {}) });
      seen += page.items.length; cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toBe(count);
  });

  it('keeps fixed facts identical while a new instance receives a distinct access envelope', async () => {
    const fixed = await revision();
    const firstGrant = await authorization();
    const first = await exportFixedTaskHandoff(root, materials, tasks, input(fixed.revisionId, fixed.contentHash, firstGrant.authorizationId));
    const firstManifest = await fs.readFile(first.manifestFile);
    const firstTask = await fs.readFile(first.taskFile);
    tasks.revoke(firstGrant.authorizationId);
    const secondGrant = await authorization();
    const second = await exportFixedTaskHandoff(root, materials, tasks, { ...input(fixed.revisionId, fixed.contentHash, secondGrant.authorizationId), instanceId: 'instance-renewed' });
    expect(await fs.readFile(second.manifestFile)).toEqual(firstManifest);
    expect(await fs.readFile(second.taskFile)).toEqual(firstTask);
    const access = JSON.parse(await fs.readFile(second.accessFile, 'utf8'));
    expect(access.instanceId).toBe('instance-renewed');
    expect(access.authorization.authorizationId).toBe(secondGrant.authorizationId);
    expect(access.authorization.capabilities).not.toContain('history-read');
    expect(firstTask.toString()).toContain('History requires history-read');
  });

  it('rejects stale hash, wrong project, revocation and cancelled exports without publishing a directory', async () => {
    const first = await revision(), grant = await authorization();
    await expect(exportFixedTaskHandoff(root, materials, tasks, input(first.revisionId, '0'.repeat(64), grant.authorizationId))).rejects.toBeTruthy();
    await expect(exportFixedTaskHandoff(root, materials, tasks, { ...input(first.revisionId, first.contentHash, grant.authorizationId), projectId: 'other-project' })).rejects.toBeTruthy();
    tasks.revoke(grant.authorizationId);
    await expect(exportFixedTaskHandoff(root, materials, tasks, input(first.revisionId, first.contentHash, grant.authorizationId))).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
    const current = await authorization(), controller = new AbortController(); controller.abort();
    await expect(exportFixedTaskHandoff(root, materials, tasks, { ...input(first.revisionId, first.contentHash, current.authorizationId), signal: controller.signal })).rejects.toBeTruthy();
    const entries = await fs.readdir(path.join(root, 'projects', projectId));
    expect(entries).not.toContain('handoffs');
  });

  it('does not publish a bundle when authorization is revoked while reading the revision', async () => {
    const first = await revision(), grant = await authorization();
    const delayedMaterials = { revision: async (p: string, id: string, hash: string) => {
      const value = await materials.revision(p, id, hash);
      tasks.revoke(grant.authorizationId);
      return value;
    } };
    await expect(exportFixedTaskHandoff(root, delayedMaterials, tasks, input(first.revisionId, first.contentHash, grant.authorizationId))).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
    const entries = await fs.readdir(path.join(root, 'projects', projectId));
    expect(entries).not.toContain('handoffs');
  });
});
