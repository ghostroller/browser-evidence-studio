/** @vitest-environment jsdom */
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import React, { useState, useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '@/evidence/files';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';
import { WorkspaceManagementPanel } from '@/renderer/components/workspace-management';
import { FileMaterialService } from '@/materials/service';

afterEach(() => { cleanup(); clearTestWorkbenchClient(); });
async function fixture() {
  await mkdir('output/workspace-management-ui', { recursive: true }); const root = await mkdtemp(path.resolve('output/workspace-management-ui/case-'));
  let failWrite = false;
  let session: { sessionId: string; projectId: string; profileId: string } | null = null;
  const host: WorkspaceManagementHost = { root, projects: [], profiles: [], state: () => ({ session }) };
  const service = new WorkspaceManagement(host, async (file, value) => { if (failWrite) throw new Error('Synthetic workspace write failure'); await atomicJson(file, value); });
  const a = await service.createProject({ name: 'Oders', objective: 'Read order amounts' });
  const b = await service.createProject({ name: 'Invoices', objective: 'Other project' });
  const profile = await service.createProfile({ projectId: a.id, name: 'Orders account', entryUrl: 'https://example.com', checkSelector: '#account' });
  const materials = new FileMaterialService(root);
  const onSelect = vi.fn(), onError = vi.fn();
  const call = vi.fn(async (method: string, body: any): Promise<any> => {
    if (method === 'state') return { projects: host.projects, profiles: host.profiles, session };
    if (['createProject', 'updateProject', 'createProfile', 'updateProfile', 'manageProject', 'manageProfile', 'managementDependencies'].includes(method)) return (service as any)[method](body);
    if (method === 'settleManagementDependencies') { expect(body.expectedSessionId).toBe(session?.sessionId); session = null; return {}; }
    throw new Error(`Unhandled visible command: ${method}`);
  }); setTestWorkbenchClient({ call, bounds: vi.fn() });
  function Harness() {
    const [snapshot, setSnapshot] = useState({ projects: host.projects, profiles: host.profiles, session });
    const [projectId, setProjectId] = useState(a.id);
    return <WorkspaceManagementPanel state={snapshot} projectId={projectId} onSelectProject={async id => { await materials.workingDraft(id); onSelect(id); setProjectId(id); }} onRefresh={() => setSnapshot({ projects: host.projects, profiles: host.profiles, session })} onError={onError} />;
  }
  return { root, host, service, a, b, profile, call, onSelect, onError, Harness, fail: (value: boolean) => { failWrite = value; }, open: () => { session = { sessionId: 'synthetic-session', projectId: a.id, profileId: profile.id }; } };
}

test('IA14/17: real UI rename survives persistence and a write failure preserves unsaved input', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Orders corrected' } }); f.fail(true);
  fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await screen.findByRole('alert'); expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Orders corrected');
  expect(f.host.projects[0].name).toBe('Oders');
  f.fail(false); fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await screen.findByText('项目名称和简介已保存。');
  expect(f.host.projects[0].name).toBe('Orders corrected');
  const attempts = f.call.mock.calls.filter(([method]) => method === 'updateProject'); expect(attempts).toHaveLength(2); expect(attempts[0][1].operationId).toBe(attempts[1][1].operationId);
  expect(JSON.parse(await readFile(path.join(f.root, 'workspace.json'), 'utf8')).projects[0].name).toBe('Orders corrected');
});
test('IA14: project archive disappears from daily list and is discoverable and restorable', async () => {
  const f = await fixture(); render(<f.Harness />);
  if (!(screen.getByText('项目归档与删除').parentElement as HTMLDetailsElement).open) fireEvent.click(screen.getByText('项目归档与删除'));
  fireEvent.click(screen.getByRole('button', { name: '归档项目' }));
  await screen.findByRole('region', { name: '确认管理操作' });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await screen.findByText('管理状态已保存；历史资料保持可读。');
  expect(f.host.projects[0].lifecycle).toBe('archived'); expect(screen.queryByRole('button', { name: 'Oders · 当前浏览' })).toBeNull();
  fireEvent.click(screen.getByLabelText('显示已归档项目和已停用环境'));
  expect(await screen.findByRole('button', { name: 'Oders · 已归档 · 当前浏览' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '恢复项目' })); await screen.findByText('已恢复，可重新使用。');
  expect(f.host.projects[0].lifecycle).toBe('active');
});
test('IA15: environment configuration edits use CAS and retain the original login partition', async () => {
  const f = await fixture(); await f.service.commitProfileState(f.profile.id, 1, { loginStatus: 'verified', checkedAt: '2026-09-29T00:00:00Z', checkedConfigRevision: 1 }); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Orders account' }));
  fireEvent.change(await screen.findByLabelText('环境名称'), { target: { value: 'Renamed account' } });
  fireEvent.change(screen.getByLabelText('登录完成标记'), { target: { value: '#new-account' } });
  fireEvent.click(screen.getByRole('button', { name: '保存环境修改' }));
  await screen.findByText('环境配置已保存；新入口下次打开时生效。');
  expect(f.host.profiles[0]).toMatchObject({ name: 'Renamed account', storageRef: f.profile.storageRef, loginStatus: 'unknown', configRevision: 2 });
  const request = f.call.mock.calls.find(([method]) => method === 'updateProfile')![1]; expect(request.expectedRevision).toBe(2); expect(request.operationId).toBeTruthy();
});
test('IA15: active environment requires explicit stop/close choice before disable, cancel changes nothing', async () => {
  const f = await fixture(); f.open(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Orders account · 正在使用' }));
  fireEvent.click(await screen.findByRole('button', { name: '停用环境' }));
  await screen.findByRole('region', { name: '确认管理操作' });
  expect(f.call.mock.calls.some(([method]) => method === 'settleManagementDependencies')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(f.host.profiles[0].lifecycle).toBe('active');
  if (!(screen.getByText('环境停用与删除').parentElement as HTMLDetailsElement).open) fireEvent.click(screen.getByText('环境停用与删除'));
  fireEvent.click(screen.getByRole('button', { name: '停用环境' }));
  fireEvent.click(await screen.findByRole('button', { name: '停止任务、结束录制并关闭环境，然后停用' }));
  await screen.findByText('管理状态已保存；历史资料保持可读。');
  expect(f.host.profiles[0].lifecycle).toBe('disabled');
  expect(f.call.mock.calls.filter(([method]) => method === 'settleManagementDependencies')).toHaveLength(1);
});
test('IA18: project browsing remains possible while another project owns the live session', async () => {
  const f = await fixture(); f.open(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  fireEvent.click(await screen.findByRole('button', { name: '设为当前浏览项目' }));
  await waitFor(() => expect(f.onSelect).toHaveBeenCalledWith(f.b.id));
  expect(await screen.findByText('正在浏览其他项目；实时浏览器仍属于「Oders」。')).toBeTruthy();
  expect(f.call.mock.calls.some(([method]) => method === 'settleManagementDependencies')).toBe(false);
});
test('IA14: visible dependency preview prevents deletion of a project with an environment', async () => {
  const f = await fixture(); render(<f.Harness />);
  if (!(screen.getByText('项目归档与删除').parentElement as HTMLDetailsElement).open) fireEvent.click(screen.getByText('项目归档与删除'));
  fireEvent.click(screen.getByRole('button', { name: '检查并删除空项目' }));
  await screen.findByText('存在依赖，不能删除。可取消后选择归档项目或停用环境。');
  expect(screen.queryByRole('button', { name: '确认删除空对象' })).toBeNull();
  expect(f.call.mock.calls.some(([method]) => method === 'manageProject')).toBe(false);
});
test('IA14: creating another project starts blank, focuses its persisted identity and can immediately be renamed', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'New task typo' } });
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  await screen.findByText('项目已创建，可继续修改资料或设为当前浏览项目。');
  const created = f.host.projects.find(item => item.name === 'New task typo')!; expect(created).toBeTruthy(); expect(f.onSelect).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'New task' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await waitFor(() => expect(f.host.projects.find(item => item.id === created.id)?.name).toBe('New task'));
  fireEvent.click(screen.getByRole('button', { name: '设为当前浏览项目' }));
  await waitFor(() => expect(f.onSelect).toHaveBeenCalledWith(created.id));
  expect((await f.service.managementDependencies({ projectId: created.id })).canDelete).toBe(false);
});
test('IA14: a newly registered project can be genuinely deleted before entering its workspace', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Unused project' } });
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  await screen.findByText('项目已创建，可继续修改资料或设为当前浏览项目。');
  const created = f.host.projects.find(item => item.name === 'Unused project')!;
  expect((await f.service.managementDependencies({ projectId: created.id })).canDelete).toBe(true);
  if (!(screen.getByText('项目归档与删除').parentElement as HTMLDetailsElement).open) fireEvent.click(screen.getByText('项目归档与删除'));
  fireEvent.click(screen.getByRole('button', { name: '检查并删除空项目' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认删除空对象' }));
  await screen.findByText('管理状态已保存；历史资料保持可读。');
  expect(f.host.projects.some(item => item.id === created.id)).toBe(false);
  expect(JSON.parse(await readFile(path.join(f.root, 'workspace.json'), 'utf8')).projects.some((item: any) => item.id === created.id)).toBe(false);
  expect(f.onSelect).not.toHaveBeenCalled();
});
test('IA17: changing management rows does not discard unsubmitted fields', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Unsubmitted spelling' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  await screen.findByText('有未保存的管理输入，请先保存或明确撤销输入，再切换对象。');
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Unsubmitted spelling');
  fireEvent.click(screen.getByRole('button', { name: '撤销项目输入' }));
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Invoices');
});
test('IA17: a stale project form preserves input and reports CAS conflict', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'My attempted name' } });
  await f.service.updateProject({ projectId: f.a.id, expectedRevision: 1, name: 'Concurrent change' });
  fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('My attempted name'); expect(f.host.projects[0].name).toBe('Concurrent change');
});

test('Chromium profiles can be managed in Electron without offering incompatible open', async () => {
  const f=await fixture(); f.host.profiles[0].provider='chromium'; render(<f.Harness />);
  fireEvent.click(screen.getByRole('button',{name:'Orders account'}));
  expect(await screen.findByText(/当前宿主不能打开/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'打开环境'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'打开环境'})); expect(f.call.mock.calls.some(([method])=>method==='openEnvironment')).toBe(false);
  expect((screen.getByRole('button',{name:'保存环境修改'}) as HTMLButtonElement).disabled).toBe(false);
});


test('cancel-create exits the blank form and dirty creation requires an explicit discard', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  fireEvent.click(screen.getByRole('button', { name: '取消创建项目' }));
  expect(screen.queryByRole('button', { name: '创建项目' })).toBeNull();
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Oders');
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Not saved' } });
  fireEvent.click(screen.getByRole('button', { name: '取消创建项目' }));
  expect(screen.getByRole('region', { name: '未保存的管理输入' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Not saved');
  fireEvent.click(screen.getByRole('button', { name: '取消创建项目' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃输入并继续' }));
  expect(screen.queryByRole('button', { name: '创建项目' })).toBeNull();
  expect(f.host.projects).toHaveLength(2);
});

test('environment route shows one editing context and cancel returns to its owner project', async () => {
  const f = await fixture(); render(<f.Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  fireEvent.click(screen.getByRole('button', { name: '添加登录环境' }));
  expect(screen.queryByLabelText('项目名称')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '取消创建环境' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Invoices');
  expect(screen.queryByLabelText('环境名称')).toBeNull();
});

test('management exit guard blocks busy or dirty close and continues only after discard', async () => {
  const f = await fixture(), leave = vi.fn();
  let guard!: React.MutableRefObject<((leave: () => void) => void) | null>;
  function Guarded() { guard = useRef(null); return <WorkspaceManagementPanel state={{projects:f.host.projects, profiles:f.host.profiles}} projectId={f.a.id} onSelectProject={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} exitGuardRef={guard}/>; }
  render(<Guarded/>);
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Keep my input' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  const { act } = await import('@testing-library/react');
  act(() => guard.current?.(leave));
  expect(leave).not.toHaveBeenCalled();
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Keep my input');
  fireEvent.click(screen.getByRole('button', { name: '放弃输入并继续' }));
  expect(leave).toHaveBeenCalledTimes(1);
});


test('navigating away from a quick environment intent drops automatic selection of a different project profile',async()=>{
 const f=await fixture(), created=vi.fn();
 function Quick(){const [snapshot,setSnapshot]=useState({projects:f.host.projects,profiles:f.host.profiles});return <WorkspaceManagementPanel state={snapshot} projectId={f.a.id} initialIntent="profile" onCreatedProfile={created} onSelectProject={vi.fn()} onRefresh={()=>setSnapshot({projects:f.host.projects,profiles:f.host.profiles})} onError={vi.fn()}/>;}
 render(<Quick/>);expect(screen.getByLabelText('环境名称')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Invoices'}));fireEvent.click(screen.getByRole('button',{name:'添加登录环境'}));
 fireEvent.change(screen.getByLabelText('环境名称'),{target:{value:'Invoice environment'}});fireEvent.click(screen.getByRole('button',{name:'创建登录环境'}));
 await screen.findByText('环境配置已保存；新入口下次打开时生效。');expect(f.host.profiles.find(item=>item.name==='Invoice environment')?.projectId).toBe(f.b.id);expect(created).not.toHaveBeenCalled();
});

test('selecting a management project reveals its row without hijacking typing or background refresh',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView'), scroll=vi.fn();Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});
 try {const f=await fixture();render(<f.Harness/>);const initial=scroll.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:'Invoices'}));expect(scroll.mock.calls.length).toBeGreaterThan(initial);
 expect(scroll.mock.instances.some(value=>(value as Element)?.classList.contains('management-project-row'))).toBe(true);
 const selected=scroll.mock.calls.length;fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Invoices updated'}});expect(scroll.mock.calls).toHaveLength(selected);fireEvent.click(screen.getByRole('button',{name:'保存项目修改'}));await screen.findByText('项目名称和简介已保存。');expect(scroll.mock.calls).toHaveLength(selected);
 } finally {cleanup();if(descriptor)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',descriptor);else delete (HTMLElement.prototype as any).scrollIntoView;}
});
