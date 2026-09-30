import { profileCanOpen, profileProviderLabel, compatibleProfileProvider } from '@/contracts/host-capabilities';
import { useWorkbenchClient } from '../lib/workbench-client';
import type { WorkbenchInput, WorkbenchMethod } from '@/contracts/workbench';
import React, { useEffect, useRef, useState } from 'react';
import type { ManagementDependencies, Profile, Project } from '@/main/services/workspace-management';
import { Button } from './ui/button';
import { ProjectMetadataForm } from './project-metadata-form';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { ArrowLeft, Folder, Plus, Settings2 } from 'lucide-react';
import { IconButton } from './ui/icon-button';

export interface WorkspaceManagementProps {
  state: { projects?: Project[]; profiles?: Profile[]; session?: { projectId: string; profileId: string; sessionId: string } | null };
  projectId: string; onSelectProject(id: string): void | Promise<void>;
  onRefresh(): unknown | Promise<unknown>; onError(message: string): void;
  initialIntent?: 'project' | 'profile'; onCreatedProject?(project: Project): void | Promise<void>; onCreatedProfile?(profile: Profile): void | Promise<void>; onCancelCreate?(): void;
  exitGuardRef?: React.MutableRefObject<((leave: () => void) => void) | null>;
}
interface Confirmation { kind: 'project' | 'profile' | 'close'; action: 'archive' | 'disable' | 'delete' | 'close'; id: string; projectId: string; revision: number; name: string; report: ManagementDependencies }
const status = (profile: Profile) => ({ unknown: '未验证', verified: '已验证', expired: '检查未通过或已过期' })[profile.loginStatus];
/** Trusted UI commands only. The selected management row is independent of the live session. */
export function WorkspaceManagementPanel({ state, projectId, onSelectProject, onRefresh, onError, exitGuardRef, initialIntent, onCreatedProject, onCreatedProfile, onCancelCreate }: WorkspaceManagementProps) {
  const client = useWorkbenchClient();
  const [search, setSearch] = useState(''), [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState(initialIntent === 'project' ? '' : projectId), [profileId, setProfileId] = useState('');
  const [projectName, setProjectName] = useState(''), [objective, setObjective] = useState('');
  const [profileName, setProfileName] = useState(''), [entryUrl, setEntryUrl] = useState(''), [instructions, setInstructions] = useState(''), [checkSelector, setCheckSelector] = useState(''), [expectedOrigin, setExpectedOrigin] = useState('');
  const [quickIntent, setQuickIntent] = useState(initialIntent);
  const [newProject, setNewProject] = useState(initialIntent === 'project'), [newProfile, setNewProfile] = useState(initialIntent === 'profile');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [navigation, setNavigation] = useState<(() => void) | null>(null);
  const busyRef = useRef(false), mounted = useRef(true);
  const priorProject = useRef(projectId);
  const detailRef = useRef<HTMLElement>(null);
  const directoryRef = useRef<HTMLUListElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const operationIds = useRef(new Map<string, string>());
  const projectBaseline = useRef<Project | undefined>(undefined), profileBaseline = useRef<Profile | undefined>(undefined);
  const projects = state.projects ?? [], profiles = state.profiles ?? [];
  const project = projects.find(item => item.id === selected), profile = profiles.find(item => item.id === profileId && item.projectId === selected);
  const visibleProjects = projects.filter(item => (showInactive || item.lifecycle !== 'archived') && `${item.name} ${item.objective}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleProfiles = profiles.filter(item => item.projectId === selected && (showInactive || item.lifecycle !== 'disabled'));
  useEffect(() => { directoryRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [selected, !!project]);
  const activeProfile = profile && state.session?.profileId === profile.id;
  useEffect(() => { if (!selected && projectId && !newProject) setSelected(projectId); }, [projectId, selected, newProject]);
  const projectDirty = projectName !== (projectBaseline.current?.name ?? '') || objective !== (projectBaseline.current?.objective ?? '');
  const profileDirty = profileName !== (profileBaseline.current?.name ?? '') || entryUrl !== (profileBaseline.current?.entryUrl ?? '') || instructions !== (profileBaseline.current?.instructions ?? '') || checkSelector !== (profileBaseline.current?.checkSelector ?? '') || expectedOrigin !== (profileBaseline.current?.expectedOrigin ?? '');
  const loadProject = (value?: Project) => { projectBaseline.current = value; setProjectName(value?.name ?? ''); setObjective(value?.objective ?? ''); };
  const loadProfile = (value?: Profile) => { profileBaseline.current = value; setProfileName(value?.name ?? ''); setEntryUrl(value?.entryUrl ?? ''); setInstructions(value?.instructions ?? ''); setCheckSelector(value?.checkSelector ?? ''); setExpectedOrigin(value?.expectedOrigin ?? ''); };
  useEffect(() => { if (selected && !project) return; if (projectBaseline.current?.id !== project?.id || !projectDirty) loadProject(project); }, [project?.id, project?.revision, project?.name, project?.objective]);
  useEffect(() => { if (profileId && !profile) return; if (profileBaseline.current?.id !== profile?.id || !profileDirty) loadProfile(profile); }, [profile?.id, profile?.revision]);
  const choose = (action: () => void) => {
    if (busyRef.current) { setFailure('正在保存或检查，请等待完成后再离开。'); return; }
    if (projectDirty || profileDirty) { setFailure('有未保存的管理输入，请先保存或明确撤销输入，再切换对象。'); setNavigation(() => action); return; }
    setFailure(''); setMessage(''); setConfirmation(null); action();
  };
  useEffect(() => { if (exitGuardRef) exitGuardRef.current = choose; return () => { if (exitGuardRef) exitGuardRef.current = null; }; });
  useEffect(() => { detailRef.current?.scrollTo?.(0, 0); }, [selected, profileId, newProject, newProfile]);
  const cancelCreation = () => choose(() => { if (quickIntent && onCancelCreate) { onCancelCreate(); return; } if (newProfile) { setNewProfile(false); setProfileId(''); loadProfile(); return; } setNewProject(false); setNewProfile(false); setSelected(priorProject.current && projects.some(item => item.id === priorProject.current) ? priorProject.current : projectId); setProfileId(''); loadProject(projects.find(item => item.id === (priorProject.current || projectId))); loadProfile(); });
  const call = async <M extends WorkbenchMethod,>(method: M, body: WorkbenchInput<M>, durable = true) => {
    const fingerprint = JSON.stringify([method, body]);
    let operationId = operationIds.current.get(fingerprint);
    if (durable && !operationId) { operationId = crypto.randomUUID(); operationIds.current.set(fingerprint, operationId); }
    const result = await client.call(method, durable ? { ...body, operationId } : body);
    operationIds.current.delete(fingerprint); return result;
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setFailure(''); setMessage('');
    try { await operation(); } catch (error) { if (mounted.current) { const explanation = String(error); setFailure(explanation); } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const refreshed = async (notice: string) => { await onRefresh(); if (mounted.current) setMessage(notice); };
  const requestLifecycle = (kind: Confirmation['kind'], action: Confirmation['action'], item: Project | Profile) => perform(async () => {
    const owner = 'projectId' in item ? item.projectId : item.id;
    const report = await call('managementDependencies', { projectId: owner, ...('projectId' in item ? { profileId: item.id } : {}) }, false);
    setConfirmation({ kind, action, id: item.id, projectId: owner, revision: item.revision ?? 0, name: item.name, report });
  });
  const confirmLifecycle = (settle: boolean) => perform(async () => {
    const plan = confirmation; if (!plan) return;
    if (settle || plan.kind === 'close') await call('settleManagementDependencies', { projectId: plan.projectId, ...(plan.kind !== 'project' ? { profileId: plan.id } : {}), expectedSessionId: plan.report.sessionId ?? null, authorizationIds: plan.report.dependencies.filter(item => item.kind === 'authorization' && item.active).map(item => item.id) }, false);
    const body = { projectId: plan.projectId, expectedRevision: plan.revision, ...(plan.action === 'delete' ? { confirmEmptyDelete: true } : {}) };
    if (plan.kind === 'project' && (plan.action === 'archive' || plan.action === 'delete')) await call('manageProject', { ...body, action: plan.action });
    if (plan.kind === 'profile' && (plan.action === 'disable' || plan.action === 'delete')) await call('manageProfile', { ...body, profileId: plan.id, action: plan.action });
    setConfirmation(null); if (plan.action === 'delete') { if (plan.kind === 'project') setSelected(''); else setProfileId(''); }
    await refreshed(plan.kind === 'close' ? '已停止任务并关闭环境；原始录制与登录数据保留。' : '管理状态已保存；历史资料保持可读。');
  });
  const restore = (kind: 'project' | 'profile', item: Project | Profile) => perform(async () => {
    await call(kind === 'project' ? 'manageProject' : 'manageProfile', { projectId: 'projectId' in item ? item.projectId : item.id, ...(kind === 'profile' ? { profileId: item.id } : {}), action: 'restore', expectedRevision: item.revision ?? 0 });
    await refreshed('已恢复，可重新使用。');
  });
  useEffect(() => { if (confirmation) detailRef.current?.querySelector('[aria-label="确认管理操作"]')?.scrollIntoView?.({ block: 'nearest' }); }, [confirmation]);
  const profileRoute = !!profile || newProfile;
  return <section className="management-panel" aria-label="项目与环境管理" aria-busy={busy}>
    <header className="management-context">
      <div><strong>管理目录</strong><p className="hint">选择项目管理资料与登录环境。切换目录不会切换实时浏览器。</p></div>
      <div className="management-context-badges"><span>当前浏览：{projects.find(item => item.id === projectId)?.name || '未选择'}</span><span>实时环境：{profiles.find(item => item.id === state.session?.profileId)?.name || '未打开'}</span></div>
    </header>
    {state.session && state.session.projectId !== projectId && <p className="management-notice" role="status">正在浏览其他项目；实时浏览器仍属于「{projects.find(item => item.id === state.session?.projectId)?.name ?? state.session.projectId}」。</p>}
    {failure && <p className="management-notice error-inline" role="alert">{failure}</p>}{message && <p className="management-notice" role="status">{message}</p>}
    {navigation && <section className="management-confirm" role="region" aria-label="未保存的管理输入"><strong>保留输入，还是放弃后继续？</strong><p>尚未保存的项目或环境输入只属于当前表单。</p><div className="button-row"><Button onClick={() => { setNavigation(null); setFailure(''); }}>继续编辑</Button><Button variant="destructive" onClick={() => { const next = navigation; setNavigation(null); setFailure(''); setMessage(''); setConfirmation(null); loadProject(project); loadProfile(profile); next(); }}>放弃输入并继续</Button></div></section>}
    <div className="management-layout">
      <aside className="management-directory" aria-label="项目目录导航">
        <div className="management-directory-tools"><div className="management-section-heading"><h3>项目</h3><Button disabled={busy} onClick={() => choose(() => { setQuickIntent(undefined); priorProject.current = selected || projectId; setSelected(''); setProfileId(''); loadProject(); loadProfile(); setNewProject(true); setNewProfile(false); })}><Plus aria-hidden="true"/>新建项目</Button></div>
          <Label>搜索项目<Input aria-label="搜索项目" placeholder="名称或目录简介" value={search} onChange={event => setSearch(event.target.value)} /></Label>
          <Label className="management-checkbox"><input type="checkbox" checked={showInactive} onChange={event => setShowInactive(event.target.checked)} /> 显示已归档项目和已停用环境</Label>
        </div>
        <ul ref={directoryRef} className="management-project-list" aria-label="项目目录">{visibleProjects.map(item => <li key={item.id}><Button className="management-project-row" aria-pressed={item.id === selected && !newProject} aria-label={`${item.name}${item.lifecycle === 'archived' ? ' · 已归档' : ''}${item.id === projectId ? ' · 当前浏览' : ''}`} variant="ghost" disabled={busy} onClick={() => choose(() => { setQuickIntent(undefined); setSelected(item.id); setProfileId(''); setNewProject(false); setNewProfile(false); loadProject(item); loadProfile(); })}><Folder aria-hidden="true"/><span><strong>{item.name}</strong><small>{item.lifecycle === 'archived' ? '已归档 · ' : ''}{item.id === projectId ? '当前浏览' : '可浏览'}{item.id === state.session?.projectId ? ' · 实时环境所在项目' : ''}</small></span></Button></li>)}</ul>
        {!visibleProjects.length && <div className="catalog-empty"><Folder aria-hidden="true"/><p>{projects.length ? '没有匹配的项目' : '还没有项目'}</p><small>{projects.length ? '调整搜索或显示已归档项目' : '新建项目后添加登录环境'}</small></div>}
      </aside>
      <section className="management-detail" ref={detailRef} aria-label="管理详情">
        {(project || newProject) ? <>
          <header className="management-detail-heading"><div className="button-row">{profileRoute && <IconButton icon={ArrowLeft} label="返回项目资料" disabled={busy} onClick={() => choose(() => { setProfileId(''); setNewProfile(false); loadProfile(); })}/>}<div><small>{newProject ? '创建项目' : profileRoute ? `${project?.name} / 登录环境` : '项目资料'}</small><h2>{newProject ? '新建项目' : newProfile ? '添加登录环境' : profileRoute ? profile?.name : project?.name}</h2></div></div><span className="catalog-status">{projectDirty || profileDirty ? '未保存输入' : busy ? '正在处理' : profileRoute ? activeProfile ? '正在使用' : profile?.lifecycle === 'disabled' ? '已停用' : '配置' : project?.lifecycle === 'archived' ? '已归档' : project?.id === projectId ? '当前浏览项目' : '管理中'}</span></header>
          {!profileRoute && <>
            <ProjectMetadataForm name={projectName} objective={objective} onName={setProjectName} onObjective={setObjective} dirty={projectDirty} busy={busy} creating={newProject} onCancel={() => { loadProject(project); setFailure(''); setNavigation(null); }} onSubmit={() => { void perform(async () => {
              const creating = newProject;
              const result = await call(creating ? 'createProject' : 'updateProject', { ...(creating ? {} : { projectId: project!.id, expectedRevision: projectBaseline.current?.revision ?? 0 }), name: projectName, objective });
              if (!mounted.current) return; loadProject(result); setSelected(result.id); setSearch(''); setNewProject(false); setNavigation(null); await refreshed(creating ? '项目已创建，可继续修改资料或设为当前浏览项目。' : '项目名称和简介已保存。'); if (creating && quickIntent === 'project') await onCreatedProject?.(result);
            }); }} />
            {newProject ? <Button disabled={busy} onClick={cancelCreation}>取消创建项目</Button> : project && <>
              <div className="management-primary-action"><Button variant="default" disabled={busy || project.id === projectId} onClick={() => choose(() => { void perform(async () => { await onSelectProject(project.id); setMessage('已切换浏览项目；打开的浏览器环境保持原归属。'); }); })}>{project.id === projectId ? '正在浏览此项目' : '设为当前浏览项目'}</Button><p className="hint">项目简介用于目录。固定资料版本中的任务目标保持原样。</p></div>
              <section className="management-profiles" aria-label="项目登录环境"><div className="management-section-heading"><h3>登录环境</h3><Button disabled={busy || project.lifecycle === 'archived'} onClick={() => choose(() => { setProfileId(''); setNewProfile(true); loadProfile(); })}><Plus aria-hidden="true"/>添加登录环境</Button></div>
                <ul className="management-profile-list" aria-label="登录环境目录">{visibleProfiles.map(item => <li key={item.id}><Button className="management-profile-row" variant="ghost" disabled={busy} aria-label={`${item.name}${item.lifecycle === 'disabled' ? ' · 已停用' : ''}${item.id === state.session?.profileId ? ' · 正在使用' : ''}`} onClick={() => choose(() => { setProfileId(item.id); setNewProfile(false); loadProfile(item); })}><Settings2 aria-hidden="true"/><span><strong>{item.name}</strong><small>{item.entryUrl || 'about:blank'}</small><small>{profileProviderLabel(item)} · {status(item)}{item.lifecycle === 'disabled' ? ' · 已停用' : ''}{item.id === state.session?.profileId ? ' · 正在使用' : ''}</small></span></Button></li>)}</ul>
                {!visibleProfiles.length && <p className="catalog-empty">{project.lifecycle === 'archived' ? '恢复项目后可添加登录环境' : '还没有可见环境，添加一个以准备登录和录制'}</p>}
              </section>
              <details className="management-lifecycle"><summary>项目归档与删除</summary><p>归档可恢复，历史资料保持可读；有历史或环境依赖的项目不能删除。</p><div className="button-row">{project.lifecycle === 'archived' ? <Button disabled={busy} onClick={() => choose(() => { void restore('project', project); })}>恢复项目</Button> : <Button disabled={busy} onClick={() => choose(() => { void requestLifecycle('project', 'archive', project); })}>归档项目</Button>}<Button disabled={busy} onClick={() => choose(() => { void requestLifecycle('project', 'delete', project); })}>检查并删除空项目</Button></div></details>
            </>}
          </>}
          {project && profileRoute && <>
            <form className="form-stack management-profile-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
              const creating = newProfile;
              const result = await call(newProfile ? 'createProfile' : 'updateProfile', { projectId: project.id, ...(newProfile ? {} : { profileId: profile!.id, expectedRevision: profileBaseline.current?.revision ?? 0 }), name: profileName, entryUrl: entryUrl || 'about:blank', instructions, checkSelector, expectedOrigin });
              if (!mounted.current) return; loadProfile(result); setProfileId(result.id); setNewProfile(false); setNavigation(null); await refreshed('环境配置已保存；新入口下次打开时生效。'); if (creating && quickIntent === 'profile') await onCreatedProfile?.(result);
            }); }}>
              <Label>环境名称<Input aria-label="环境名称" value={profileName} onChange={event => setProfileName(event.target.value)} maxLength={120} disabled={busy} /></Label>
              <Label>登录入口<Input aria-label="环境登录入口" value={entryUrl} onChange={event => setEntryUrl(event.target.value)} placeholder="https://example.com/login" disabled={busy} /></Label>
              <Label>登录说明<Textarea aria-label="登录说明" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} disabled={busy} /></Label>
              <details><summary>高级登录检查（可选）</summary><Label>预期业务站点<Input aria-label="预期业务站点" value={expectedOrigin} onChange={event => setExpectedOrigin(event.target.value)} placeholder="https://example.com" disabled={busy} /></Label><Label>登录完成标记（CSS）<Input aria-label="登录完成标记" value={checkSelector} onChange={event => setCheckSelector(event.target.value)} disabled={busy} /></Label><p className="hint">配置变化后旧检查失效。保存登录状态不代表登录有效。</p></details>
              <div className="button-row"><Button type="submit" variant="default" disabled={busy || !profileName.trim()}>{newProfile ? '创建登录环境' : '保存环境修改'}</Button>{profileDirty && <Button type="button" disabled={busy} onClick={() => { loadProfile(profile); setFailure(''); setNavigation(null); }}>撤销环境输入</Button>}{newProfile && <Button type="button" disabled={busy} onClick={cancelCreation}>取消创建环境</Button>}</div>
            </form>
            {profile && !newProfile && <>
              <section className="management-profile-state"><h3>运行与登录状态</h3><p>{status(profile)}{profile.checkReason ? `：${profile.checkReason}` : ''}</p><small>{profile.checkedAt ? `最近检查 ${new Date(profile.checkedAt).toLocaleString()}` : '尚未检查'} · {profileProviderLabel(profile)}</small><div className="button-row">
                {!activeProfile && <Button variant="default" disabled={busy || !!state.session || !profileCanOpen(profile, client.host.provider) || project.lifecycle === 'archived'} onClick={() => choose(() => { void perform(async () => { await call('openEnvironment', { projectId: project.id, profileId: profile.id }, false); await refreshed('环境已打开，尚未录制。'); }); })}>打开环境</Button>}
                {activeProfile && <><Button disabled={busy} onClick={() => choose(() => { void perform(async () => { await call('checkEnvironment', {}, false); await refreshed('检查完成，以当前环境结果为准。'); }); })}>检查登录状态</Button><Button disabled={busy} onClick={() => choose(() => { void perform(async () => { await call('saveProfile', {}, false); await refreshed('持久登录状态已保存，不代表登录仍有效。'); }); })}>保存登录状态</Button><Button disabled={busy} onClick={() => choose(() => { void requestLifecycle('close', 'close', profile); })}>关闭环境</Button></>}
              </div>{compatibleProfileProvider(profile) !== client.host.provider && <p className="hint">此环境属于 {profileProviderLabel(profile)}，当前宿主不能打开。配置和历史仍可管理，原存储身份保持不变。</p>}{state.session && !activeProfile && <p className="hint">另一个环境仍打开。请先选择正在使用的环境并明确关闭，再打开此环境。</p>}{profile.lifecycle === 'disabled' && <p className="hint">恢复环境后才能打开；原登录数据保留。</p>}</section>
              <details className="management-lifecycle"><summary>环境停用与删除</summary><p>停用可恢复。改名或停用不会清空登录数据。</p><div className="button-row">{profile.lifecycle === 'disabled' ? <Button disabled={busy || project.lifecycle === 'archived'} onClick={() => choose(() => { void restore('profile', profile); })}>恢复环境</Button> : <Button disabled={busy} onClick={() => choose(() => { void requestLifecycle('profile', 'disable', profile); })}>停用环境</Button>}<Button disabled={busy} onClick={() => choose(() => { void requestLifecycle('profile', 'delete', profile); })}>检查并删除未使用配置</Button></div></details>
            </>}
          </>}
        </> : <div className="catalog-empty"><Folder aria-hidden="true"/><h2>选择要管理的项目</h2><p>从左侧选择项目，或新建一个项目</p></div>}
        {confirmation && <section role="region" aria-label="确认管理操作" className="management-confirm">
          <h3>{confirmation.action === 'delete' ? '确认删除空对象' : confirmation.kind === 'close' ? '关闭浏览器环境' : confirmation.kind === 'project' ? '归档项目' : '停用环境'}：{confirmation.name}</h3>
          <p>{confirmation.action === 'delete' ? '只有完全未使用的目录对象可删除。不会清理磁盘上的登录数据或历史文件。' : '录制、资料版本、来源与登录数据会保留；停用后可恢复。'}</p>
          <ul aria-label="操作影响">{confirmation.report.dependencies.map((item, index) => <li key={`${item.kind}-${item.id}-${index}`}>{item.active ? '活动：' : '保留：'}{item.label}</li>)}</ul>
          <div className="button-row">{confirmation.action === 'delete' && !confirmation.report.canDelete ? <p role="status">存在依赖，不能删除。可取消后选择归档项目或停用环境。</p> : confirmation.kind === 'close' || !confirmation.report.canDeactivate ? <Button variant="destructive" disabled={busy} onClick={() => void confirmLifecycle(true)}>停止任务、结束录制并关闭环境{confirmation.kind !== 'close' ? '，然后停用' : ''}</Button> : <Button variant="destructive" disabled={busy} onClick={() => void confirmLifecycle(false)}>{confirmation.action === 'delete' ? '确认删除空对象' : '确认停用'}</Button>}<Button disabled={busy} onClick={() => setConfirmation(null)}>取消</Button></div>
        </section>}
      </section>
    </div>
  </section>;
}
