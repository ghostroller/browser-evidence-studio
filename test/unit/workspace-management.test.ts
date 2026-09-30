import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { atomicJson } from '@/evidence/files';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';

let root: string, host: WorkspaceManagementHost, management: WorkspaceManagement;
let state: ReturnType<WorkspaceManagementHost['state']>, grants: Array<{ authorizationId: string; profileId?: string; status: string }>;
beforeEach(async () => {
  await mkdir('output/workspace-management', { recursive: true });
  root = await mkdtemp(path.resolve('output/workspace-management/case-'));
  state = {}; grants = [];
  host = { root, projects: [], profiles: [], state: () => state, taskAuthorizations: () => grants };
  management = new WorkspaceManagement(host); await management.init();
});
const project = () => management.createProject({ name: 'Oders', objective: 'Directory description', operationId: 'create-project' });
async function profile() { const p = await project(); return management.createProfile({ projectId: p.id, name: 'Account', entryUrl: 'https://example.com/login', checkSelector: '#account', expectedOrigin: 'https://example.com', operationId: 'create-profile' }); }
async function restart() { const restored: WorkspaceManagementHost = { ...host, projects: [], profiles: [] }; const service = new WorkspaceManagement(restored); await service.init(); return { host: restored, service }; }
async function stored() { return JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8')); }
async function metadata(relative: string, data: unknown) { await atomicJson(path.join(root, relative), data); }

test('IA14: rename/archive/restore survives restart without changing identity, brief or originals', async () => {
  const p = await project();
  await metadata(`projects/${p.id}/materials/revisions/fixed.json`, { contentHash: 'old-hash', content: { taskBrief: { objective: 'Frozen objective' } } });
  await metadata('runs/source/manifest.json', { id: 'source', projectId: p.id, status: 'sealed' });
  const before = await readFile(path.join(root, `projects/${p.id}/materials/revisions/fixed.json`), 'utf8');
  const renamed = await management.updateProject({ projectId: p.id, expectedRevision: 1, name: 'Orders', objective: 'New directory only', operationId: 'rename' });
  expect(renamed.id).toBe(p.id);
  const archived = await management.manageProject({ projectId: p.id, expectedRevision: renamed.revision, action: 'archive', operationId: 'archive' });
  const second = await restart(); expect(second.host.projects[0].lifecycle).toBe('archived');
  await second.service.manageProject({ projectId: p.id, expectedRevision: archived.revision, action: 'restore', operationId: 'restore' });
  expect((await restart()).host.projects[0]).toMatchObject({ name: 'Orders', objective: 'New directory only', lifecycle: 'active' });
  expect(await readFile(path.join(root, `projects/${p.id}/materials/revisions/fixed.json`), 'utf8')).toBe(before);
});
test('IA14: only a confirmed genuinely empty project can be deleted; deletion is idempotent', async () => {
  const p = await project(); expect((await management.managementDependencies({ projectId: p.id })).canDelete).toBe(true);
  const body = { projectId: p.id, expectedRevision: p.revision, action: 'delete', operationId: 'delete', confirmEmptyDelete: true };
  await expect(management.manageProject({ ...body, confirmEmptyDelete: false })).rejects.toThrow('Confirm');
  await management.manageProject(body); expect(host.projects).toEqual([]);
  expect(await management.manageProject(body)).toMatchObject({ id: p.id, deleted: true });
  expect((await restart()).host.projects).toEqual([]);
});
test.each(['projects', 'runs', 'executions', 'authoring', 'validations'])('IA14: complete %s disk references block empty deletion even when absent from UI state', async kind => {
  const p = await project();
  if (kind === 'projects') await metadata(`projects/${p.id}/materials/drafts/not-in-first-50.json`, { draftId: 'later-draft' });
  if (kind === 'runs') await metadata('runs/not-in-state/manifest.json', { projectId: p.id });
  if (kind === 'executions') await metadata('executions/not-in-state/binding.json', { projectId: p.id });
  if (kind === 'authoring') await metadata('authoring/pending.json', { projectId: p.id, stage: 'unknown' });
  if (kind === 'validations') await metadata('validations.json', [{ id: 'older', projectId: p.id }]);
  expect((await management.managementDependencies({ projectId: p.id })).canDelete).toBe(false);
  await expect(management.manageProject({ projectId: p.id, expectedRevision: 1, action: 'delete', confirmEmptyDelete: true })).rejects.toThrow('历史');
  expect(host.projects).toHaveLength(1);
});
test('IA14: damaged/unassigned history is unknown, never proof of an empty project', async () => {
  const p = await project(); await mkdir(path.join(root, 'runs', 'damaged'), { recursive: true });
  await writeFile(path.join(root, 'runs', 'damaged', 'manifest.json'), '{');
  const dependencies = await management.managementDependencies({ projectId: p.id });
  expect(dependencies.canDelete).toBe(false); expect(dependencies.dependencies).toContainEqual(expect.objectContaining({ kind: 'unreadable' }));
});
test('IA15: rename preserves partition and verified state, config edits invalidate only the current check status', async () => {
  const p = await profile();
  const checked = await management.commitProfileState(p.id, 1, { loginStatus: 'verified', checkedAt: '2026-09-29T01:00:00Z', checkedConfigRevision: 1, checkOrigin: 'https://example.com' });
  const renamed = await management.updateProfile({ projectId: p.projectId, profileId: p.id, name: 'Primary account', expectedRevision: checked.revision });
  expect(renamed).toMatchObject({ storageRef: p.storageRef, loginStatus: 'verified', configRevision: 1 });
  const changed = await management.updateProfile({ projectId: p.projectId, profileId: p.id, entryUrl: 'https://example.com/other', expectedRevision: renamed.revision });
  expect(changed).toMatchObject({ storageRef: p.storageRef, loginStatus: 'unknown', configRevision: 2, checkedConfigRevision: 1, checkOrigin: 'https://example.com', checkedAt: '2026-09-29T01:00:00Z' });
  const disabled = await management.manageProfile({ projectId: p.projectId, profileId: p.id, action: 'disable', expectedRevision: changed.revision });
  expect((await restart()).host.profiles[0]).toMatchObject({ lifecycle: 'disabled', storageRef: p.storageRef });
  const restored = await management.manageProfile({ projectId: p.projectId, profileId: p.id, action: 'restore', expectedRevision: disabled.revision });
  expect(restored).toMatchObject({ lifecycle: 'active', storageRef: p.storageRef });
});
test('IA15: stale asynchronous check cannot verify a changed environment configuration', async () => {
  const p = await profile();
  await management.updateProfile({ projectId: p.projectId, profileId: p.id, checkSelector: '#different', expectedRevision: p.revision });
  await expect(management.commitProfileState(p.id, 1, { loginStatus: 'verified', checkedConfigRevision: 1 })).rejects.toThrow('configuration changed');
  expect(host.profiles[0].loginStatus).toBe('unknown');
});
test('IA15: browser save results merge after a name change without losing either state', async () => {
  const p = await profile(); await management.updateProfile({ projectId: p.projectId, profileId: p.id, name: 'New name', expectedRevision: p.revision });
  await management.commitProfileState(p.id, 1, { loginStatus: 'unknown', savedAt: '2026-09-29T02:00:00Z' });
  expect((await restart()).host.profiles[0]).toMatchObject({ name: 'New name', savedAt: '2026-09-29T02:00:00Z', storageRef: p.storageRef });
});
test('IA15: session, recording, execution and task authorization all prevent lifecycle change', async () => {
  const p = await profile(); state = { session: { sessionId: 'session-a', projectId: p.projectId, profileId: p.id }, active: { id: 'recording-a', projectId: p.projectId, profileId: p.id, execution: 'running' } }; grants = [{ authorizationId: 'grant', profileId: p.id, status: 'active' }];
  const report = await management.managementDependencies({ projectId: p.projectId, profileId: p.id });
  expect(report.dependencies.filter(item => item.active).map(item => item.kind)).toEqual(['session', 'recording', 'execution', 'authorization']);
  await expect(management.manageProfile({ projectId: p.projectId, profileId: p.id, action: 'disable', expectedRevision: 1 })).rejects.toThrow('活动');
  expect(host.profiles[0].lifecycle).toBe('active'); expect(state.session?.sessionId).toBe('session-a');
});
test('IA18: active project A does not prevent reading or renaming project B', async () => {
  const a = await profile(), b = await management.createProject({ name: 'Other project' }); state = { session: { sessionId: 'live-a', projectId: a.projectId, profileId: a.id } };
  expect((await management.managementDependencies({ projectId: b.id })).canDeactivate).toBe(true);
  await management.updateProject({ projectId: b.id, name: 'Project B', expectedRevision: 1 });
  expect(state.session?.projectId).toBe(a.projectId);
});
test('IA17: create persistence failure leaves both arrays unchanged and the same operation retry creates only once', async () => {
  let fail = true; management = new WorkspaceManagement(host, async (file, value) => { if (fail) throw new Error('disk full'); await atomicJson(file, value); });
  await expect(project()).rejects.toThrow('disk full'); expect(host.projects).toEqual([]);
  fail = false; const created = await project(); expect((await project()).id).toBe(created.id); expect(host.projects).toHaveLength(1);
  expect((await restart()).host.projects).toHaveLength(1);
});
test('IA17: failed update leaves old in-memory and persisted metadata unchanged', async () => {
  const p = await project(); const before = await stored(); management = new WorkspaceManagement(host, async () => { throw new Error('access denied'); });
  await expect(management.updateProject({ projectId: p.id, name: 'Wrong', expectedRevision: 1, operationId: 'rename' })).rejects.toThrow('access denied');
  expect(host.projects[0].name).toBe('Oders'); expect(await stored()).toEqual(before);
});
test('IA17: durable write with lost response replays its original receipt across restart', async () => {
  management = new WorkspaceManagement(host, async (file, value) => { await atomicJson(file, value); throw new Error('response lost after persistence'); });
  await expect(project()).rejects.toThrow('response lost'); expect(host.projects).toEqual([]);
  const restarted = await restart(); const result = await restarted.service.createProject({ name: 'Oders', objective: 'Directory description', operationId: 'create-project' });
  expect(result.id).toBe(restarted.host.projects[0].id); expect(restarted.host.projects).toHaveLength(1);
});
test('IA17: concurrent requests serialize, duplicate operation IDs converge, stale CAS rejects', async () => {
  const [a, b] = await Promise.all([project(), project()]); expect(a.id).toBe(b.id); expect(host.projects).toHaveLength(1);
  const [first, second] = await Promise.allSettled([management.updateProject({ projectId: a.id, name: 'First', expectedRevision: 1 }), management.updateProject({ projectId: a.id, name: 'Second', expectedRevision: 1 })]);
  expect(first.status).toBe('fulfilled'); expect(second.status).toBe('rejected'); expect(host.projects[0].name).toBe('First');
  await expect(management.createProject({ name: 'Another body', operationId: 'create-project' })).rejects.toThrow('already used');
});
test('legacy metadata keeps its original partition and unrelated manifest fields during migration', async () => {
  await metadata('workspace.json', { schemaVersion: 1, projects: [{ id: 'legacy', name: 'Legacy', objective: '', createdAt: 'old' }], profiles: [{ id: 'old-profile', projectId: 'legacy', name: 'Old account', storageRef: 'persist:existing-login', loginStatus: 'verified', configRevision: 3 }], customField: { retained: true } });
  await management.init(); await management.updateProfile({ projectId: 'legacy', profileId: 'old-profile', expectedRevision: 0, name: 'New label' });
  expect((await stored()).customField).toEqual({ retained: true }); expect(host.profiles[0]).toMatchObject({ storageRef: 'persist:existing-login', configRevision: 3, loginStatus: 'verified' });
});
test('invalid configured origin cannot be saved or silently reduce the origin check', async () => {
  const p = await profile(); await expect(management.updateProfile({ projectId: p.projectId, profileId: p.id, expectedRevision: 1, expectedOrigin: 'https://example.com/wrong/path' })).rejects.toThrow('must not include');
  expect(host.profiles[0].expectedOrigin).toBe('https://example.com');
});
test('IA15: unknown legacy environment usage and missing source profile identity are not empty proof', async () => {
  const p = await profile(); await metadata('runs/old/manifest.json', { projectId: p.projectId });
  expect((await management.managementDependencies({ projectId: p.projectId, profileId: p.id })).canDelete).toBe(false);
  const persisted = await stored(); delete persisted.profiles[0].createdAt; await metadata('workspace.json', persisted); await management.init();
  const report = await management.managementDependencies({ projectId: p.projectId, profileId: p.id });
  expect(report.dependencies).toContainEqual(expect.objectContaining({ kind: 'unreadable', id: p.id }));
});
test('IA17: failed environment creation, editing, and lifecycle writes never publish partial arrays', async () => {
  const p = await profile(); const original = structuredClone(host.profiles);
  management = new WorkspaceManagement(host, async () => { throw new Error('synthetic write refusal'); });
  await expect(management.createProfile({ projectId: p.projectId, name: 'Failed new' })).rejects.toThrow('write refusal');
  await expect(management.updateProfile({ projectId: p.projectId, profileId: p.id, name: 'Failed rename', expectedRevision: 1 })).rejects.toThrow('write refusal');
  await expect(management.manageProfile({ projectId: p.projectId, profileId: p.id, action: 'disable', expectedRevision: 1 })).rejects.toThrow('write refusal');
  expect(host.profiles).toEqual(original); expect((await restart()).host.profiles).toEqual(original);
});

test('B3: dedicated Chromium metadata is explicit and survives reopen without partition migration', async () => {
  host.runtimeProvider='chromium';
  const p=await profile();
  expect(p.provider).toBe('chromium');expect(p.storageRef).toBe(`chromium:${p.id}`);
  await management.updateProfile({projectId:p.projectId,profileId:p.id,expectedRevision:p.revision,name:'Renamed dedicated environment'});
  expect((await restart()).host.profiles[0]).toMatchObject({provider:'chromium',storageRef:p.storageRef});
});
test('B3: absent provider and a custom Electron partition remain byte-identical on rename/reopen', async () => {
  const p=await profile(),before=await stored();
  before.profiles[0].storageRef='persist:legacy-custom-partition';delete before.profiles[0].provider;
  await atomicJson(path.join(root,'workspace.json'),before);
  await management.updateProfile({projectId:p.projectId,profileId:p.id,expectedRevision:p.revision,name:'Legacy renamed'});
  const restored=(await restart()).host.profiles[0];
  expect(restored.storageRef).toBe('persist:legacy-custom-partition');expect(Object.hasOwn(restored,'provider')).toBe(false);
});
test('B3: unknown provider fails closed and retains the original workspace bytes', async () => {
  await profile();const before=await stored();before.profiles[0].provider='other';
  await atomicJson(path.join(root,'workspace.json'),before);const bytes=await readFile(path.join(root,'workspace.json'),'utf8');
  await expect(restart()).rejects.toThrow('Unsupported browser');expect(await readFile(path.join(root,'workspace.json'),'utf8')).toBe(bytes);
});
