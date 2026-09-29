import React, { useEffect, useRef, useState } from 'react';
import type { ManagementDependencies, Profile, Project } from '@/main/services/workspace-management';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

export interface WorkspaceManagementProps {
  state: { projects?: Project[]; profiles?: Profile[]; session?: { projectId: string; profileId: string; sessionId: string } | null };
  projectId: string; onSelectProject(id: string): void | Promise<void>;
  onRefresh(): unknown | Promise<unknown>; onError(message: string): void;
}
interface Confirmation { kind: 'project' | 'profile' | 'close'; action: 'archive' | 'disable' | 'delete' | 'close'; id: string; projectId: string; revision: number; name: string; report: ManagementDependencies }
const status = (profile: Profile) => ({ unknown: '未验证', verified: '已验证', expired: '检查未通过或已过期' })[profile.loginStatus];
/** Trusted UI commands only. The selected management row is independent of the live session. */
export function WorkspaceManagementPanel({ state, projectId, onSelectProject, onRefresh, onError }: WorkspaceManagementProps) {
  const [search, setSearch] = useState(''), [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState(projectId), [profileId, setProfileId] = useState('');
  const [projectName, setProjectName] = useState(''), [objective, setObjective] = useState('');
  const [profileName, setProfileName] = useState(''), [entryUrl, setEntryUrl] = useState(''), [instructions, setInstructions] = useState(''), [checkSelector, setCheckSelector] = useState(''), [expectedOrigin, setExpectedOrigin] = useState('');
  const [newProject, setNewProject] = useState(false), [newProfile, setNewProfile] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const operationIds = useRef(new Map<string, string>());
  const projectBaseline = useRef<Project | undefined>(undefined), profileBaseline = useRef<Profile | undefined>(undefined);
  const projects = state.projects ?? [], profiles = state.profiles ?? [];
  const project = projects.find(item => item.id === selected), profile = profiles.find(item => item.id === profileId && item.projectId === selected);
  const visibleProjects = projects.filter(item => (showInactive || item.lifecycle !== 'archived') && `${item.name} ${item.objective}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleProfiles = profiles.filter(item => item.projectId === selected && (showInactive || item.lifecycle !== 'disabled'));
  const activeProfile = profile && state.session?.profileId === profile.id;
  useEffect(() => { if (!selected && projectId && !newProject) setSelected(projectId); }, [projectId, selected, newProject]);
  const projectDirty = projectName !== (projectBaseline.current?.name ?? '') || objective !== (projectBaseline.current?.objective ?? '');
  const profileDirty = profileName !== (profileBaseline.current?.name ?? '') || entryUrl !== (profileBaseline.current?.entryUrl ?? '') || instructions !== (profileBaseline.current?.instructions ?? '') || checkSelector !== (profileBaseline.current?.checkSelector ?? '') || expectedOrigin !== (profileBaseline.current?.expectedOrigin ?? '');
  const loadProject = (value?: Project) => { projectBaseline.current = value; setProjectName(value?.name ?? ''); setObjective(value?.objective ?? ''); };
  const loadProfile = (value?: Profile) => { profileBaseline.current = value; setProfileName(value?.name ?? ''); setEntryUrl(value?.entryUrl ?? ''); setInstructions(value?.instructions ?? ''); setCheckSelector(value?.checkSelector ?? ''); setExpectedOrigin(value?.expectedOrigin ?? ''); };
  useEffect(() => { if (projectBaseline.current?.id !== project?.id || !projectDirty) loadProject(project); }, [project?.id, project?.revision, project?.name, project?.objective]);
  useEffect(() => { if (profileBaseline.current?.id !== profile?.id || !profileDirty) loadProfile(profile); }, [profile?.id, profile?.revision]);
  const choose = (action: () => void) => { if (projectDirty || profileDirty) { setFailure('有未保存的管理输入，请先保存或明确撤销输入，再切换对象。'); return; } action(); };
  const call = async (method: string, body: Record<string, unknown>, durable = true) => {
    const fingerprint = JSON.stringify([method, body]);
    let operationId = operationIds.current.get(fingerprint);
    if (durable && !operationId) { operationId = crypto.randomUUID(); operationIds.current.set(fingerprint, operationId); }
    const result = await window.studio.call(method, durable ? { ...body, operationId } : body);
    operationIds.current.delete(fingerprint); return result;
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); setFailure(''); setMessage('');
    try { await operation(); } catch (error) { const explanation = String(error); setFailure(explanation); onError(explanation); }
    finally { setBusy(false); }
  };
  const refreshed = async (notice: string) => { await onRefresh(); setMessage(notice); };
  const requestLifecycle = (kind: Confirmation['kind'], action: Confirmation['action'], item: Project | Profile) => perform(async () => {
    const owner = 'projectId' in item ? item.projectId : item.id;
    const report = await call('managementDependencies', { projectId: owner, ...('projectId' in item ? { profileId: item.id } : {}) }, false);
    setConfirmation({ kind, action, id: item.id, projectId: owner, revision: item.revision ?? 0, name: item.name, report });
  });
  const confirmLifecycle = (settle: boolean) => perform(async () => {
    const plan = confirmation; if (!plan) return;
    if (settle || plan.kind === 'close') await call('settleManagementDependencies', { projectId: plan.projectId, ...(plan.kind !== 'project' ? { profileId: plan.id } : {}), expectedSessionId: plan.report.sessionId ?? null, authorizationIds: plan.report.dependencies.filter(item => item.kind === 'authorization' && item.active).map(item => item.id) }, false);
    if (plan.kind !== 'close') await call(plan.kind === 'project' ? 'manageProject' : 'manageProfile', { projectId: plan.projectId, ...(plan.kind === 'profile' ? { profileId: plan.id } : {}), action: plan.action, expectedRevision: plan.revision, ...(plan.action === 'delete' ? { confirmEmptyDelete: true } : {}) });
    setConfirmation(null); if (plan.action === 'delete') { if (plan.kind === 'project') setSelected(''); else setProfileId(''); }
    await refreshed(plan.kind === 'close' ? '已停止任务并关闭环境；原始录制与登录数据保留。' : '管理状态已保存；历史资料保持可读。');
  });
  const restore = (kind: 'project' | 'profile', item: Project | Profile) => perform(async () => {
    await call(kind === 'project' ? 'manageProject' : 'manageProfile', { projectId: 'projectId' in item ? item.projectId : item.id, ...(kind === 'profile' ? { profileId: item.id } : {}), action: 'restore', expectedRevision: item.revision ?? 0 });
    await refreshed('已恢复，可重新使用。');
  });
  return <section className="pane-scroll form-stack" aria-label="项目与环境管理">
    <h2>项目与环境管理</h2>
    <p className="hint">项目简介整理目录信息。固定资料版本中的任务目标保持原样。停用可恢复，登录数据不会因改名而重建。</p>
    {state.session && state.session.projectId !== projectId && <p role="status">正在浏览其他项目；实时浏览器仍属于「{projects.find(item => item.id === state.session?.projectId)?.name ?? state.session.projectId}」。</p>}
    {failure && <p role="alert">{failure}</p>}{message && <p role="status">{message}</p>}
    <Label>搜索项目<Input aria-label="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></Label>
    <Label><input type="checkbox" checked={showInactive} onChange={event => setShowInactive(event.target.checked)} /> 显示已归档项目和已停用环境</Label>
    <div className="button-row"><Button disabled={busy} onClick={() => choose(() => { setSelected(''); setProfileId(''); loadProject(); loadProfile(); setNewProject(true); setNewProfile(false); setConfirmation(null); })}>新建项目</Button></div>
    <ul aria-label="项目目录">{visibleProjects.map(item => <li key={item.id}><Button variant={item.id === selected ? 'default' : 'outline'} disabled={busy} onClick={() => choose(() => { setSelected(item.id); setProfileId(''); setNewProject(false); setNewProfile(false); setConfirmation(null); })}>{item.name}{item.lifecycle === 'archived' ? ' · 已归档' : ''}{item.id === projectId ? ' · 当前浏览' : ''}</Button></li>)}</ul>
    {!visibleProjects.length && <p className="hint">当前筛选没有项目。</p>}
    {(project || newProject) && <form className="form-stack" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = await call(newProject ? 'createProject' : 'updateProject', { ...(newProject ? {} : { projectId: project!.id, expectedRevision: projectBaseline.current?.revision ?? 0 }), name: projectName, objective });
      loadProject(result); setSelected(result.id); setNewProject(false); await refreshed(newProject ? '项目已创建，可继续修改资料或设为当前浏览项目。' : '项目名称和简介已保存。');
    }); }}>
      <h3>{newProject ? '创建项目' : '项目资料'}</h3>
      {newProject && <p className="hint">创建后先整理项目资料；设为当前浏览项目后开始整理保存点。</p>}
      <Label>项目名称<Input aria-label="项目名称" value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={200} disabled={busy} /></Label>
      <Label>目录简介<Textarea aria-label="目录简介" value={objective} onChange={event => setObjective(event.target.value)} maxLength={4000} disabled={busy} /></Label>
      <Button type="submit" disabled={busy || !projectName.trim()}>{newProject ? '创建项目' : '保存项目修改'}</Button>
      {projectDirty && <Button type="button" disabled={busy} onClick={() => { loadProject(project); setFailure(''); }}>撤销项目输入</Button>}
      {project && !newProject && <div className="button-row">
        <Button type="button" disabled={busy} onClick={() => void perform(async () => { await onSelectProject(project.id); setMessage('已切换浏览项目；打开的浏览器环境保持原归属。'); })}>设为当前浏览项目</Button>
        {project.lifecycle === 'archived' ? <Button type="button" disabled={busy} onClick={() => void restore('project', project)}>恢复项目</Button> : <Button type="button" disabled={busy} onClick={() => void requestLifecycle('project', 'archive', project)}>归档项目</Button>}
        <Button type="button" disabled={busy} onClick={() => void requestLifecycle('project', 'delete', project)}>检查并删除空项目</Button>
      </div>}
    </form>}
    {project && !newProject && <>
      <h3>登录环境</h3>
      <Button disabled={busy || project.lifecycle === 'archived'} onClick={() => choose(() => { setProfileId(''); setNewProfile(true); loadProfile(); setConfirmation(null); })}>添加登录环境</Button>
      <ul aria-label="登录环境目录">{visibleProfiles.map(item => <li key={item.id}><Button variant={item.id === profileId ? 'default' : 'outline'} disabled={busy} onClick={() => choose(() => { setProfileId(item.id); setNewProfile(false); setConfirmation(null); })}>{item.name}{item.lifecycle === 'disabled' ? ' · 已停用' : ''}{item.id === state.session?.profileId ? ' · 正在使用' : ''}</Button><small>{item.entryUrl || 'about:blank'} · {status(item)}{item.checkedAt ? ` · 最近检查 ${new Date(item.checkedAt).toLocaleString()}` : ' · 尚未检查'}</small></li>)}</ul>
      {!visibleProfiles.length && <p className="hint">当前筛选没有登录环境。</p>}
    </>}
    {project && (profile || newProfile) && <form className="form-stack" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = await call(newProfile ? 'createProfile' : 'updateProfile', { projectId: project.id, ...(newProfile ? {} : { profileId: profile!.id, expectedRevision: profileBaseline.current?.revision ?? 0 }), name: profileName, entryUrl: entryUrl || 'about:blank', instructions, checkSelector, expectedOrigin });
      loadProfile(result); setProfileId(result.id); setNewProfile(false); await refreshed('环境配置已保存；新入口下次打开时生效。');
    }); }}>
      <h3>{newProfile ? '创建登录环境' : '环境配置'}</h3>
      <Label>环境名称<Input aria-label="环境名称" value={profileName} onChange={event => setProfileName(event.target.value)} maxLength={120} disabled={busy} /></Label>
      <Label>登录入口<Input aria-label="环境登录入口" value={entryUrl} onChange={event => setEntryUrl(event.target.value)} placeholder="https://example.com/login" disabled={busy} /></Label>
      <Label>登录说明<Textarea aria-label="登录说明" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} disabled={busy} /></Label>
      <details><summary>高级登录检查（可选）</summary>
        <Label>预期业务站点<Input aria-label="预期业务站点" value={expectedOrigin} onChange={event => setExpectedOrigin(event.target.value)} placeholder="https://example.com" disabled={busy} /></Label>
        <Label>登录完成标记（CSS）<Input aria-label="登录完成标记" value={checkSelector} onChange={event => setCheckSelector(event.target.value)} disabled={busy} /></Label>
        <p className="hint">检查可见标记及预期站点；配置变化后旧检查不再代表当前状态。保存状态不代表登录有效。</p>
      </details>
      <Button type="submit" disabled={busy || !profileName.trim()}>{newProfile ? '创建登录环境' : '保存环境修改'}</Button>
      {profileDirty && <Button type="button" disabled={busy} onClick={() => { loadProfile(profile); setFailure(''); }}>撤销环境输入</Button>}
      {profile && !newProfile && <>
        <p>{status(profile)}{profile.checkReason ? `：${profile.checkReason}` : ''}{profile.checkedAt ? `；检查时间 ${new Date(profile.checkedAt).toLocaleString()}，配置 ${profile.checkedConfigRevision ?? '旧记录未注明'}` : ''}</p>
        <div className="button-row">
          {!activeProfile && <Button type="button" disabled={busy || !!state.session || profile.lifecycle === 'disabled' || project.lifecycle === 'archived'} onClick={() => void perform(async () => { await call('openEnvironment', { projectId: project.id, profileId: profile.id }, false); await refreshed('环境已打开，尚未录制。'); })}>打开环境</Button>}
          {activeProfile && <><Button type="button" disabled={busy} onClick={() => void perform(async () => { await call('checkEnvironment', {}, false); await refreshed('检查完成，以当前环境结果为准。'); })}>检查登录状态</Button><Button type="button" disabled={busy} onClick={() => void perform(async () => { await call('saveProfile', {}, false); await refreshed('持久登录状态已保存，不代表登录仍有效。'); })}>保存登录状态</Button><Button type="button" disabled={busy} onClick={() => void requestLifecycle('close', 'close', profile)}>关闭环境</Button></>}
          {profile.lifecycle === 'disabled' ? <Button type="button" disabled={busy || project.lifecycle === 'archived'} onClick={() => void restore('profile', profile)}>恢复环境</Button> : <Button type="button" disabled={busy} onClick={() => void requestLifecycle('profile', 'disable', profile)}>停用环境</Button>}
          <Button type="button" disabled={busy} onClick={() => void requestLifecycle('profile', 'delete', profile)}>检查并删除未使用配置</Button>
        </div>
        {state.session && !activeProfile && <p className="hint">另一个环境仍打开。请先选择正在使用的环境并明确关闭，再打开此环境。</p>}
      </>}
    </form>}
    {confirmation && <section role="region" aria-label="确认管理操作" className="form-stack">
      <h3>{confirmation.action === 'delete' ? '确认删除空对象' : confirmation.kind === 'close' ? '关闭浏览器环境' : '确认停用'}：{confirmation.name}</h3>
      <p>{confirmation.action === 'delete' ? '只有完全未使用的目录对象可删除。不会清理磁盘上的登录数据或历史文件。' : '录制、资料版本、来源与登录数据会保留；停用后可恢复。'}</p>
      <ul aria-label="操作影响">{confirmation.report.dependencies.map((item, index) => <li key={`${item.kind}-${item.id}-${index}`}>{item.active ? '活动：' : '保留：'}{item.label} · {item.id}</li>)}</ul>
      {confirmation.action === 'delete' && !confirmation.report.canDelete ? <p role="status">存在依赖，不能删除。可取消后选择归档项目或停用环境。</p> : confirmation.kind === 'close' || !confirmation.report.canDeactivate ? <Button disabled={busy} onClick={() => void confirmLifecycle(true)}>停止任务、结束录制并关闭环境{confirmation.kind !== 'close' ? '，然后停用' : ''}</Button> : <Button disabled={busy} onClick={() => void confirmLifecycle(false)}>{confirmation.action === 'delete' ? '确认删除空对象' : '确认停用'}</Button>}
      <Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button>
    </section>}
  </section>;
}
