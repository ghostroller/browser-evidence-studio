import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, safeFile } from '@/evidence/files';
import { ensure, now, StudioError } from '@/shared/errors';

export interface Project {
  id: string; name: string; objective: string; scriptDirectory?: string; createdAt: string;
  revision?: number; lifecycle?: 'active' | 'archived'; updatedAt?: string;
}
export interface Profile {
  id: string; projectId: string; name: string; entryUrl?: string; instructions?: string; storageRef?: string;
  revision?: number; lifecycle?: 'active' | 'disabled'; createdAt?: string; updatedAt?: string; openedAt?: string;
  configRevision?: number; checkedAt?: string; checkedConfigRevision?: number; checkSelector?: string;
  expectedOrigin?: string; checkOrigin?: string; checkReason?: string; savedAt?: string;
  loginStatus: 'unknown' | 'verified' | 'expired';
}
export interface ManagementDependency {
  kind: 'session' | 'recording' | 'execution' | 'authorization' | 'profile' | 'material' | 'authoring' | 'history' | 'unreadable';
  id: string; label: string; active: boolean;
}
export interface ManagementDependencies {
  projectId: string; profileId?: string; sessionId?: string; dependencies: ManagementDependency[];
  canDeactivate: boolean; canDelete: boolean;
}
interface ManagementState {
  session?: { sessionId: string; projectId: string; profileId: string } | null;
  active?: { id: string; projectId: string; profileId: string; execution?: string } | null;
  validationStarting?: { validationId: string; validationRunId?: string } | null;
}
export interface WorkspaceManagementHost {
  root: string; projects: Project[]; profiles: Profile[]; state(): ManagementState;
  taskAuthorizations?(projectId: string): Array<{ authorizationId: string; profileId?: string; status: string }>;
  onChanged?(): void;
}
interface Workspace {
  schemaVersion: 1; projects: Project[]; profiles: Profile[]; workspaceRevision?: number;
  managementOperations?: Record<string, { fingerprint: string; result: unknown }>;
  [key: string]: unknown;
}
interface Command { operationId?: string; expectedRevision?: number; [key: string]: unknown }
const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const key = (value: unknown): string => { ensure(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value), 'Invalid management identity'); return value; };
const canonical = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item) ? Object.fromEntries(Object.keys(item).sort().filter(name => item[name] !== undefined).map(name => [name, item[name]])) : item);
function text(value: unknown, field: string, maximum: number, required = false): string {
  ensure(typeof value === 'string', `${field} must be text`);
  const result = value.trim(); ensure(!required || result.length > 0, `${field} is required`);
  ensure(result.length <= maximum, `${field} is too long`); return result;
}
function entryUrl(value: unknown): string {
  const source = text(value, 'Login URL', 2048) || 'about:blank';
  let parsed: URL; try { parsed = new URL(source); } catch { throw new StudioError(422, 'invalid_request', 'Login URL must be an HTTP or HTTPS URL'); }
  ensure(source === 'about:blank' || ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'Login URL must be HTTP, HTTPS or about:blank without credentials');
  return source;
}
function origin(value: unknown): string | undefined {
  const source = text(value, 'Expected origin', 2048); if (!source) return undefined;
  let parsed: URL; try { parsed = new URL(source); } catch { throw new StudioError(422, 'invalid_request', 'Expected origin must be an exact HTTP or HTTPS origin'); }
  ensure(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash, 'Expected origin must not include a path, credentials, query or fragment'); return parsed.origin;
}
function cas(item: { revision?: number }, body: Command) {
  ensure(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision === (item.revision ?? 0), '目录已被修改，请刷新后再保存；未提交输入已保留。', 409);
}
function bump<T extends { revision?: number; updatedAt?: string }>(item: T): T { item.revision = (item.revision ?? 0) + 1; item.updatedAt = now(); return item; }

/** One durable workspace manifest: candidate -> atomic replacement -> published arrays.
 * Every caller that writes project/profile metadata must use this queue, including
 * browser check/save results. No material, original, partition or history is edited. */
export class WorkspaceManagement {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: WorkspaceManagementHost, private readonly write = atomicJson) {}
  private get file() { return path.join(this.host.root, 'workspace.json'); }
  private async read(): Promise<Workspace> {
    let value: unknown;
    try { value = JSON.parse(await readFile(await safeFile(this.host.root, 'workspace.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return { schemaVersion: 1, projects: clone(this.host.projects), profiles: clone(this.host.profiles) }; throw error; }
    ensure(record(value) && value.schemaVersion === 1 && Array.isArray(value.projects) && Array.isArray(value.profiles), 'Workspace directory is damaged; retained without changes', 500);
    for (const [items, kind] of [[value.projects, 'project'], [value.profiles, 'profile']] as const) {
      const ids = new Set<string>();
      for (const item of items) {
        ensure(record(item) && typeof item.name === 'string', `Invalid ${kind} directory record`, 500);
        key(item.id); ensure(!ids.has(item.id), `Duplicate ${kind} directory identity`, 500); ids.add(item.id);
        ensure(item.revision === undefined || Number.isSafeInteger(item.revision) && item.revision >= 0, `Invalid ${kind} revision`, 500);
        ensure(item.lifecycle === undefined || (kind === 'project' ? ['active', 'archived'] : ['active', 'disabled']).includes(item.lifecycle), `Invalid ${kind} lifecycle`, 500);
      }
    }
    ensure(value.profiles.every((profile: any) => value.projects.some((project: any) => project.id === profile.projectId)), 'Profile has an unknown project', 500);
    ensure(value.managementOperations === undefined || record(value.managementOperations), 'Invalid management operation directory', 500);
    return value as Workspace;
  }
  private publish(value: Workspace) { this.host.projects = clone(value.projects); this.host.profiles = clone(value.profiles); }
  async init() { const value = await this.read(); this.publish(value); }
  private transaction<T>(method: string, body: Command, apply: (candidate: Workspace) => Promise<T> | T): Promise<T & { operationId: string }> {
    const operationId = key(body.operationId ?? randomUUID());
    const fingerprint = createHash('sha256').update(canonical({ method, ...body, operationId })).digest('hex');
    const pending = this.tail.then(async () => {
      const current = await this.read(), prior = current.managementOperations?.[operationId];
      if (prior) { ensure(prior.fingerprint === fingerprint, 'Operation ID was already used for another management request', 409); this.publish(current); return clone(prior.result) as T & { operationId: string }; }
      const candidate = clone(current), result = { ...await apply(candidate), operationId };
      candidate.workspaceRevision = (current.workspaceRevision ?? 0) + 1;
      candidate.managementOperations = { ...current.managementOperations, [operationId]: { fingerprint, result } };
      await this.write(this.file, candidate);
      this.publish(candidate); this.host.onChanged?.(); return clone(result);
    });
    this.tail = pending.catch(() => {}); return pending;
  }
  createProject(body: Command) {
    return this.transaction('createProject', body, value => {
      const project: Project = { id: randomUUID(), name: text(body.name, 'Project name', 200, true), objective: text(body.objective ?? '', 'Project description', 4000), createdAt: now(), revision: 1, lifecycle: 'active' };
      if (body.scriptDirectory) project.scriptDirectory = path.resolve(text(body.scriptDirectory, 'Script directory', 4096));
      value.projects.push(project); return project;
    });
  }
  updateProject(body: Command) {
    return this.transaction('updateProject', body, value => {
      const project = value.projects.find(item => item.id === key(body.projectId ?? body.id)); ensure(project, 'Unknown project', 404); cas(project, body);
      if (body.name !== undefined) project.name = text(body.name, 'Project name', 200, true);
      if (body.objective !== undefined) project.objective = text(body.objective, 'Project description', 4000);
      if (body.scriptDirectory !== undefined) project.scriptDirectory = body.scriptDirectory === null || body.scriptDirectory === '' ? undefined : path.resolve(text(body.scriptDirectory, 'Script directory', 4096));
      return bump(project);
    });
  }
  createProfile(body: Command) {
    return this.transaction('createProfile', body, value => {
      const project = value.projects.find(item => item.id === key(body.projectId)); ensure(project, 'Unknown project', 404); ensure(project.lifecycle !== 'archived', 'Restore this project before creating an environment', 409);
      const profile: Profile = { id: randomUUID(), projectId: project.id, name: text(body.name, 'Environment name', 120, true), entryUrl: entryUrl(body.entryUrl ?? 'about:blank'), instructions: text(body.instructions ?? '', 'Login instructions', 4000), checkSelector: text(body.checkSelector ?? '', 'Login check selector', 2000) || undefined, expectedOrigin: origin(body.expectedOrigin ?? ''), revision: 1, configRevision: 1, lifecycle: 'active', createdAt: now(), loginStatus: 'unknown' };
      profile.storageRef = `persist:bes-${profile.projectId}-${profile.id}`; value.profiles.push(profile); return profile;
    });
  }
  updateProfile(body: Command) {
    return this.transaction('updateProfile', body, value => {
      const profile = value.profiles.find(item => item.id === key(body.profileId ?? body.id) && item.projectId === key(body.projectId)); ensure(profile, 'Unknown environment', 404); cas(profile, body);
      const previous = canonical([profile.entryUrl, profile.instructions, profile.checkSelector, profile.expectedOrigin]);
      if (body.name !== undefined) profile.name = text(body.name, 'Environment name', 120, true);
      if (body.entryUrl !== undefined) profile.entryUrl = entryUrl(body.entryUrl);
      if (body.instructions !== undefined) profile.instructions = text(body.instructions, 'Login instructions', 4000);
      if (body.checkSelector !== undefined) profile.checkSelector = text(body.checkSelector, 'Login check selector', 2000) || undefined;
      if (body.expectedOrigin !== undefined) profile.expectedOrigin = origin(body.expectedOrigin);
      if (previous !== canonical([profile.entryUrl, profile.instructions, profile.checkSelector, profile.expectedOrigin])) {
        profile.configRevision = (profile.configRevision ?? 0) + 1; profile.loginStatus = 'unknown'; profile.checkReason = '检查配置已变化；上次结果仅适用于旧配置。';
      }
      return bump(profile);
    });
  }
  /** Persist browser-observed outcomes without replacing concurrently edited config. */
  commitProfileState(profileId: string, expectedConfigRevision: number, patch: Pick<Partial<Profile>, 'loginStatus' | 'checkedAt' | 'checkedConfigRevision' | 'checkOrigin' | 'checkReason' | 'savedAt' | 'openedAt'>, operationId = randomUUID()) {
    return this.transaction('commitProfileState', { profileId, expectedConfigRevision, patch, operationId }, value => {
      const profile = value.profiles.find(item => item.id === key(profileId)); ensure(profile, 'Unknown environment', 404);
      ensure((profile.configRevision ?? 0) === expectedConfigRevision, 'Environment configuration changed while checking; check again', 409);
      if (patch.loginStatus !== undefined) ensure(['unknown', 'verified', 'expired'].includes(patch.loginStatus), 'Invalid login status');
      for (const field of ['loginStatus', 'checkedAt', 'checkedConfigRevision', 'checkOrigin', 'checkReason', 'savedAt', 'openedAt'] as const) if (patch[field] !== undefined) (profile as any)[field] = patch[field];
      return bump(profile);
    });
  }
  private activeDependencies(projectId: string, profileId?: string): ManagementDependency[] {
    const state = this.host.state(), result: ManagementDependency[] = [];
    const matches = (item: { projectId: string; profileId?: string }) => item.projectId === projectId && (!profileId || item.profileId === profileId);
    if (state.session && matches(state.session)) result.push({ kind: 'session', id: state.session.sessionId, label: '打开的浏览器环境', active: true });
    if (state.active && matches(state.active)) {
      result.push({ kind: 'recording', id: state.active.id, label: '正在录制，需先结束并保留原件', active: true });
      if (state.active.execution && !['ready', 'idle', 'finished', 'stopped'].includes(state.active.execution)) result.push({ kind: 'execution', id: state.active.id, label: '正在执行的任务', active: true });
    }
    if (state.validationStarting && (!state.session || matches(state.session))) result.push({ kind: 'execution', id: state.validationStarting.validationId, label: '正在启动的验收', active: true });
    for (const grant of this.host.taskAuthorizations?.(projectId) ?? []) if (grant.status === 'active' && (!profileId || !grant.profileId || grant.profileId === profileId)) result.push({ kind: 'authorization', id: grant.authorizationId, label: '仍有效的任务授权', active: true });
    return result;
  }
  async managementDependencies(body: { projectId: string; profileId?: string }): Promise<ManagementDependencies> {
    await this.tail;
    return this.dependencies(body.projectId, body.profileId);
  }
  private async dependencies(projectValue: string, profileValue?: string): Promise<ManagementDependencies> {
    const projectId = key(projectValue), profileId = profileValue === undefined ? undefined : key(profileValue);
    const result = this.activeDependencies(projectId, profileId), state = this.host.state();
    const add = (kind: ManagementDependency['kind'], id: string, label: string) => result.push({ kind, id, label, active: false });
    const unreadable = (id: string) => add('unreadable', id, '无法核对的资料；不能视为空对象');
    const entries = async (relative: string) => {
      const directory = path.join(this.host.root, relative);
      try {
        let checked = this.host.root;
        for (const segment of relative.split('/')) { checked = path.join(checked, segment); const info = await lstat(checked); ensure(info.isDirectory() && !info.isSymbolicLink(), 'Dependency directory is not a regular directory'); }
        return await readdir(directory, { withFileTypes: true });
      } catch (error: any) { if (error.code !== 'ENOENT') unreadable(relative); return []; }
    };
    const json = async (relative: string): Promise<any> => {
      try { const file = await safeFile(this.host.root, relative); ensure((await lstat(file)).size <= 8 * 1024 * 1024, 'Dependency metadata exceeds read budget'); return JSON.parse(await readFile(file, 'utf8')); }
      catch { unreadable(relative); return null; }
    };
    if (!profileId) {
      for (const profile of this.host.profiles.filter(item => item.projectId === projectId)) add('profile', profile.id, `登录环境：${profile.name}`);
      // Walk this project's full metadata tree, never a paginated UI projection.
      const walk = async (relative: string): Promise<void> => {
        for (const item of await entries(relative)) {
          const name = `${relative}/${item.name}`;
          if (item.isSymbolicLink()) unreadable(name);
          else if (item.isDirectory()) await walk(name);
          else add('material', name, '工作副本、固定版本或项目资料');
        }
      };
      await walk(`projects/${projectId}`);
    } else {
      const profile = this.host.profiles.find(item => item.id === profileId && item.projectId === projectId); ensure(profile, 'Unknown environment', 404);
      if (profile.savedAt || profile.openedAt || profile.checkedAt) add('history', profileId, '此环境已有使用或登录状态记录；可停用并恢复');
      else if (!profile.createdAt) add('unreadable', profileId, '旧环境的使用历史未完整登记；请停用，保留登录数据与身份');
    }
    const recordingProfiles = new Map<string, string>();
    for (const item of await entries('runs')) {
      if (!item.isDirectory() || item.isSymbolicLink()) { unreadable(`runs/${item.name}`); continue; }
      const manifest = await json(`runs/${item.name}/manifest.json`);
      if (manifest && typeof manifest.projectId !== 'string') { unreadable(`runs/${item.name}/manifest.json`); continue; }
      if (manifest?.profileId) recordingProfiles.set(item.name, manifest.profileId);
      if (manifest?.projectId === projectId && (!profileId || !manifest.profileId || manifest.profileId === profileId)) add('recording', item.name, '原始录制及历史来源');
    }
    for (const item of await entries('executions')) {
      if (!item.isDirectory() || item.isSymbolicLink()) { unreadable(`executions/${item.name}`); continue; }
      const binding = await json(`executions/${item.name}/binding.json`);
      if (binding && typeof binding.projectId !== 'string') { unreadable(`executions/${item.name}/binding.json`); continue; }
      if (binding?.projectId === projectId && (!profileId || typeof binding.environmentRef !== 'string' || binding.environmentRef.split('/').at(-1) === profileId)) add('execution', item.name, '执行与固定资料引用');
    }
    for (const item of await entries('authoring')) {
      if (!item.isFile() || !item.name.endsWith('.json') || item.isSymbolicLink()) { unreadable(`authoring/${item.name}`); continue; }
      const operation = await json(`authoring/${item.name}`);
      if (operation && typeof operation.projectId !== 'string') { unreadable(`authoring/${item.name}`); continue; }
      if (operation?.projectId === projectId && (!profileId || !operation.recordingId || !recordingProfiles.has(operation.recordingId) || recordingProfiles.get(operation.recordingId) === profileId)) add('authoring', item.name, '采集与资料关联操作记录');
    }
    // Older runs may only remain in the validation catalog. Missing is distinct from damaged.
    try {
      await lstat(path.join(this.host.root, 'validations.json'));
      const validations = await json('validations.json');
      if (validations && !Array.isArray(validations)) unreadable('validations.json');
      if (Array.isArray(validations)) for (const validation of validations) {
        if (!record(validation) || typeof validation.projectId !== 'string') { unreadable('validations.json'); continue; }
        if (validation.projectId === projectId && (!profileId || !validation.profileId || validation.profileId === profileId)) add('execution', String(validation.id), '已保存的验收记录');
      }
    } catch (error: any) { if (error.code !== 'ENOENT') unreadable('validations.json'); }
    const dependencies = result.filter((item, index) => result.findIndex(other => other.kind === item.kind && other.id === item.id && other.active === item.active) === index);
    return { projectId, profileId, sessionId: state.session?.projectId === projectId && (!profileId || state.session.profileId === profileId) ? state.session.sessionId : undefined, dependencies, canDeactivate: !dependencies.some(item => item.active), canDelete: dependencies.length === 0 };
  }
  manageProject(body: Command) {
    return this.transaction('manageProject', body, async value => {
      const project = value.projects.find(item => item.id === key(body.projectId)); ensure(project, 'Unknown project', 404); cas(project, body);
      ensure(['archive', 'restore', 'delete'].includes(String(body.action)), 'Unknown project lifecycle action');
      if (body.action !== 'restore') {
        const dependencies = await this.dependencies(project.id);
        ensure(dependencies.canDeactivate, '项目仍被活动会话、录制、执行或授权使用。先明确停止并关闭，或取消此操作。', 409);
        if (body.action === 'delete') { ensure(body.confirmEmptyDelete === true, 'Confirm deletion of this empty project'); ensure(dependencies.canDelete, '项目有历史或依赖，不能删除；请归档后按需恢复。', 409); value.projects = value.projects.filter(item => item.id !== project.id); return { ...project, deleted: true }; }
      }
      project.lifecycle = body.action === 'restore' ? 'active' : 'archived'; return bump(project);
    });
  }
  manageProfile(body: Command) {
    return this.transaction('manageProfile', body, async value => {
      const profile = value.profiles.find(item => item.id === key(body.profileId) && item.projectId === key(body.projectId)); ensure(profile, 'Unknown environment', 404); cas(profile, body);
      ensure(['disable', 'restore', 'delete'].includes(String(body.action)), 'Unknown environment lifecycle action');
      if (body.action === 'restore') ensure(value.projects.find(item => item.id === profile.projectId)?.lifecycle !== 'archived', '先恢复项目，再恢复登录环境。', 409);
      else {
        const dependencies = await this.dependencies(profile.projectId, profile.id);
        ensure(dependencies.canDeactivate, '环境仍被活动会话、录制、执行或授权使用。先明确停止并关闭，或取消此操作。', 409);
        if (body.action === 'delete') { ensure(body.confirmEmptyDelete === true, 'Confirm deletion of this unused environment configuration'); ensure(dependencies.canDelete, '环境已有使用记录或依赖，不能删除；请停用后按需恢复。', 409); value.profiles = value.profiles.filter(item => item.id !== profile.id); return { ...profile, deleted: true }; }
      }
      profile.lifecycle = body.action === 'restore' ? 'active' : 'disabled'; return bump(profile);
    });
  }
}
