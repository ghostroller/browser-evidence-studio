/** @vitest-environment jsdom */
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { ThemeProvider } from '@/renderer/components/theme-provider';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceManagement } from '@/main/services/workspace-management';
import { FileMaterialService } from '@/materials/service';

const runA = 'run-a-000001';
const runB = 'run-b-000002';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function history(runId: string, suffix: string) {
  return {
    checkpoints: { items: [{
      id: `checkpoint-${suffix}`, key: `key-${suffix}`, title: `${suffix} 保存点`,
      artifactRefs: [`artifact-${suffix}`], metadata: { artifacts: [{ id: `artifact-${suffix}`, kind: `DOM ${suffix}` }] },
    }] },
  };
}

function stubLayout() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
}

const state = {
  projects: [{ id: 'project-1', name: 'Test project' }],
  profiles: [{ id: 'profile-1', projectId: 'project-1', name: 'Test profile' }],
  runs: [runA, runB].map(id => ({ id, projectId: 'project-1', kind: 'demonstrate', status: 'sealed' })),
};

/** Only the new workspace bootstrap is stubbed; archive reads below retain each
 * test's deferred, run-scoped responses and original stale-result assertions. */
function emptyWorkspace(method: string) {
  const draft = { draftId: 'empty-working-copy', draftRevision: 0, name: '当前工作副本', status: 'available' };
  if (method === 'workingMaterialDraft' || method === 'materialDraft') return draft;
  if (method === 'materialDrafts') return { items: [draft], outputTruncated: false };
  if (['materialRevisions', 'materialCollection', 'authoringRecovery'].includes(method)) return { items: [], outputTruncated: false };
  if (method === 'materialCatalog') return { schemaVersion: 1, catalogRevision: 0, workingDraftId: draft.draftId, drafts: { [draft.draftId]: { name: draft.name, hidden: false } }, revisions: {}, recordings: {} };
  throw new Error(`Unexpected studio method: ${method}`);
}

async function showRecordingArchive() {
  await waitFor(() => expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.mouseDown(screen.getByRole('tab', { name: '存档' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('button', { name: '原始录制' }));
  await screen.findByRole('region', { name: '原始录制存档' });
  await screen.findByRole('heading', { level: 4, name: new RegExp(runA) });
}

function recordingDiagnostics(runId: string) {
  const heading = screen.getByRole('heading', { level: 4, name: new RegExp(runId) });
  fireEvent.click(within(heading.closest('section')!).getByRole('button', { name: '查看录制详情' }));
  const recording = within(screen.getByRole('region', { name: '录制详情' }));
  const summary = recording.getByText('录制管理与诊断');
  if (!(summary.parentElement as HTMLDetailsElement).open) fireEvent.click(summary);
  return recording;
}

test('urgent stop remains available during an unrelated pending request and targets the active run', async () => {
  stubLayout();
  const pendingSave = deferred<unknown>();
  const active = { id: runA, projectId: 'project-1', profileId: 'profile-1', execution: 'ready', controller: 'human', leaseEpoch: 1, pages: [] };
  const call = vi.fn(async (method: string) => {
    if (method === 'state') return { ...state, active };
    if (method === 'history') return { checkpoints: { items: [] } };
    if (method === 'presentation') return undefined;
    if (method === 'saveProfile') return pendingSave.promise;
    if (method === 'stopRunner') return { stopped: true };
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await waitFor(() => expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.mouseDown(screen.getByRole('tab', { name: '实现与结果' }), { button: 0, ctrlKey: false });
  await waitFor(() => expect((screen.getByRole('button', { name: '保存当前登录环境' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '保存当前登录环境' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('saveProfile', {}));
  const stop = screen.getByRole('button', { name: '停止并接管' }) as HTMLButtonElement;
  expect(stop.disabled).toBe(false);
  expect((screen.getByRole('button', { name: '全局停止自动化' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(stop);
  await waitFor(() => expect(call).toHaveBeenCalledWith('stopRunner', { runId: runA, sessionId:undefined, validationId: undefined }));
  await act(async () => pendingSave.resolve({}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  clearTestWorkbenchClient();
});

test('quick project creation retries the same operation after a lost response',async()=>{
  stubLayout();let saved:any,first=true;const receipts=new Map<string,any>();
  const call=vi.fn(async(method:string,body:any={})=>{
    if(method==='state')return {projects:saved?[saved]:[],profiles:[],runs:[]};
    if(method==='presentation')return undefined;
    if(method==='createProject'){
      if(!receipts.has(body.operationId)){saved={id:'project-1',name:body.name,objective:body.objective};receipts.set(body.operationId,saved);}
      if(first){first=false;throw new Error('reply lost');}return receipts.get(body.operationId);
    }
    return emptyWorkspace(method);
  });setTestWorkbenchClient({call,bounds:vi.fn()});
  render(<ThemeProvider initial={{theme:'light',layout:{}}}><App/></ThemeProvider>);
  fireEvent.click(screen.getByRole('button',{name:'新建项目'}));fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Synthetic retry'}});
  fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await screen.findAllByText(/reply lost/);
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Synthetic retry');
  fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await waitFor(()=>expect(screen.queryByLabelText('项目名称')).toBeNull());
  const attempts=call.mock.calls.filter(([method])=>method==='createProject');expect(attempts).toHaveLength(2);expect(attempts[0][1].operationId).toBeTruthy();expect(attempts[1][1].operationId).toBe(attempts[0][1].operationId);expect(receipts.size).toBe(1);
});

test('first management project stays unused across modal close; explicit selection prepares one real workspace',async()=>{
  stubLayout();await mkdir('output/app-management',{recursive:true});const root=await mkdtemp(path.resolve('output/app-management/case-'));
  const host={root,projects:[] as any[],profiles:[] as any[],state:()=>({})},management=new WorkspaceManagement(host),materials=new FileMaterialService(root);
  const call=vi.fn(async(method:string,body:any={})=>{
    if(method==='state')return {projects:host.projects,profiles:host.profiles,runs:[]};
    if(method==='presentation')return undefined;
    if(['createProject','updateProject','managementDependencies','manageProject'].includes(method))return (management as any)[method](body);
    if(method==='workingMaterialDraft')return materials.workingDraft(body.projectId);
    if(method==='materialDraft')return materials.getDraft(body.projectId,body.draftId);
    if(method==='materialDrafts')return materials.listDrafts(body.projectId,body);
    if(method==='materialRevisions')return materials.listRevisions(body.projectId,body);
    return emptyWorkspace(method);
  });setTestWorkbenchClient({call,bounds:vi.fn()});
  render(<ThemeProvider initial={{theme:'light',layout:{}}}><App/></ThemeProvider>);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('state', {}));
  fireEvent.click(screen.getByRole('button',{name:'项目与环境管理'}));
  const dialog=within(await screen.findByRole('dialog'));
  fireEvent.click(dialog.getByRole('button',{name:'新建项目'}));fireEvent.change(dialog.getByLabelText('项目名称'),{target:{value:'Unused first project'}});
  fireEvent.click(dialog.getByRole('button',{name:'创建项目'}));await dialog.findByText('项目已创建，可继续修改资料或设为当前浏览项目。');
  const first=host.projects[0];expect((await management.managementDependencies({projectId:first.id})).canDelete).toBe(true);
  fireEvent.click(dialog.getByRole('button',{name:'返回工作台'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('');
  expect(call.mock.calls.some(([method])=>method==='workingMaterialDraft')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'项目与环境管理'}));const reopened=within(await screen.findByRole('dialog'));
  fireEvent.click(reopened.getByRole('button',{name:'Unused first project'}));fireEvent.click(reopened.getByText('项目归档与删除'));fireEvent.click(reopened.getByRole('button',{name:'检查并删除空项目'}));
  fireEvent.click(await reopened.findByRole('button',{name:'确认删除空对象'}));await reopened.findByText('管理状态已保存；历史资料保持可读。');
  expect(host.projects).toHaveLength(0);expect(JSON.parse(await readFile(path.join(root,'workspace.json'),'utf8')).projects).toHaveLength(0);
  fireEvent.click(reopened.getByRole('button',{name:'新建项目'}));fireEvent.change(reopened.getByLabelText('项目名称'),{target:{value:'Ready project'}});
  fireEvent.click(reopened.getByRole('button',{name:'创建项目'}));await reopened.findByText('项目已创建，可继续修改资料或设为当前浏览项目。');
  fireEvent.click(reopened.getByRole('button',{name:'设为当前浏览项目'}));
  await waitFor(()=>expect(call.mock.calls.some(([method,body])=>method==='workingMaterialDraft'&&body.projectId===host.projects[0].id)).toBe(true));
  await waitFor(async()=>expect((await materials.listDrafts(host.projects[0].id,{limit:50,maxBytes:24576})).items).toHaveLength(1));
  expect((await management.managementDependencies({projectId:host.projects[0].id})).canDelete).toBe(false);
});

test('a readable sealed run offers explicit trusted index repair with its inspected writer fingerprint', async () => {
  stubLayout();
  const call = vi.fn(async (method: string) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'inspectRunRecovery') return {
      runId: runA, status: 'sealed', inspection: { state: 'unlocked', lockFingerprint: 'inspected-lock', message: 'No writer owns this run' },
      canRecover: false, canRecoverIndexes: true,
      indexDiagnostics: { replay: { state: 'missing', reason: 'index-lost' }, resources: { state: 'published', reason: 'generation-manifest-present' } },
    };
    if (method === 'recoverRunIndexes') return { runId: runA, replay: {}, resources: {} };
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await showRecordingArchive();
  fireEvent.click(recordingDiagnostics(runA).getByRole('button', { name: '检查/重建索引' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByText(/回放索引：missing/)).toBeTruthy());
  fireEvent.click(within(dialog).getByRole('button', { name: '检查并重建回放/资源索引' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('recoverRunIndexes', { runId: runA, expectedFingerprint: 'inspected-lock' }));
  expect(within(dialog).getByText(/索引已重建/)).toBeTruthy();
});

test('a late history response cannot replace the selected archive or redirect artifact reads', async () => {
  stubLayout();

  const requestA = deferred<ReturnType<typeof history>>();
  const requestB = deferred<ReturnType<typeof history>>();
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') return (body as { runId: string }).runId === runA ? requestA.promise : requestB.promise;
    if (method === 'artifact') return { id: (body as { id: string }).id, value: 'B material' };
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await showRecordingArchive();
  await waitFor(() => expect(screen.getByRole('heading', { level: 4, name: new RegExp(runA) })).toBeTruthy());
  fireEvent.click(recordingDiagnostics(runA).getByRole('button', { name: '原件诊断' }));
  fireEvent.click(recordingDiagnostics(runB).getByRole('button', { name: '原件诊断' }));
  expect(call).toHaveBeenCalledWith('history', { runId: runA });
  expect(call).toHaveBeenCalledWith('history', { runId: runB });

  await act(async () => { requestB.resolve(history(runB, 'B')); });
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: /B 保存点/ })).toBeTruthy();

  await act(async () => { requestA.resolve(history(runA, 'A')); });
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).queryByText(runA)).toBeNull();
  expect(within(dialog).getByRole('button', { name: /B 保存点/ })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: /B 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM B' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('artifact', { runId: runB, id: 'artifact-B' }));
  await waitFor(() => expect(within(dialog).getByText('B material')).toBeTruthy());
});

test('an old artifact response cannot appear in a newly opened archive', async () => {
  stubLayout();
  const oldArtifact = deferred<{ id: string; value: string }>();
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') {
      const runId = (body as { runId: string }).runId;
      return history(runId, runId === runA ? 'A' : 'B');
    }
    if (method === 'artifact') {
      const { id } = body as { id: string };
      return id === 'artifact-A' ? oldArtifact.promise : { id, value: 'B material' };
    }
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await showRecordingArchive();
  fireEvent.click(recordingDiagnostics(runA).getByRole('button', { name: '原件诊断' }));
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /A 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM A' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('artifact', { runId: runA, id: 'artifact-A' }));

  fireEvent.click(within(dialog).getByRole('button', { name: '返回工作台' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(recordingDiagnostics(runB).getByRole('button', { name: '原件诊断' }));
  dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(runB)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: /B 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM B' }));
  await waitFor(() => expect(within(dialog).getByText('B material')).toBeTruthy());
  expect(call).toHaveBeenCalledWith('artifact', { runId: runB, id: 'artifact-B' });

  await act(async () => { oldArtifact.resolve({ id: 'artifact-A', value: 'A material' }); });
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).getByText('B material')).toBeTruthy();
  expect(within(dialog).queryByText('A material')).toBeNull();
});

test('a delayed artifact from checkpoint A cannot appear under checkpoint B in the same run', async () => {
  stubLayout();
  const oldArtifact = deferred<{ id: string; value: string }>();
  const both = { checkpoints: { items: [...history(runA, 'A').checkpoints.items, ...history(runA, 'B').checkpoints.items] } };
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') return both;
    if (method === 'artifact') {
      const { id } = body as { id: string };
      return id === 'artifact-A' ? oldArtifact.promise : { id, value: 'B material' };
    }
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await showRecordingArchive();
  fireEvent.click(recordingDiagnostics(runA).getByRole('button', { name: '原件诊断' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /A 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM A' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('artifact', { runId: runA, id: 'artifact-A' }));
  fireEvent.click(within(dialog).getByRole('button', { name: /B 保存点/ }));

  await act(async () => { oldArtifact.resolve({ id: 'artifact-A', value: 'A material' }); });
  expect(within(dialog).queryByText('A material')).toBeNull();
  expect(within(dialog).getByRole('heading', { name: 'B 保存点' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM B' }));
  await waitFor(() => expect(within(dialog).getByText('B material')).toBeTruthy());
});

test('changing a timeline range clears its cursor and discards a pending old-range response', async () => {
  stubLayout();
  const oldEvents = deferred<any>();
  let eventCalls = 0;
  const runHistory = {
    checkpoints: { items: [
      { id: 'checkpoint-A', key: 'A', title: 'A 保存点', sequence: 10 },
      { id: 'checkpoint-B', key: 'B', title: 'B 保存点', sequence: 20 },
    ] },
    events: { items: [{ id: 'initial', type: 'initial-event', source: 'test', data: {} }], nextCursor: 'old-cursor' },
  };
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') return runHistory;
    if (method === 'events') {
      ++eventCalls;
      return eventCalls === 1 ? oldEvents.promise : { items: [{ id: 'fresh', type: 'fresh-event', source: 'test', data: {} }] };
    }
    return emptyWorkspace(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  await showRecordingArchive();
  fireEvent.click(recordingDiagnostics(runA).getByRole('button', { name: '原件诊断' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.mouseDown(within(dialog).getByRole('tab', { name: '时间线' }), { button: 0, ctrlKey: false });
  expect(within(dialog).getByText('initial-event')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: '下一页' })).toBeTruthy();

  fireEvent.change(within(dialog).getByRole('combobox', { name: '从 checkpoint' }), { target: { value: 'checkpoint-A' } });
  expect(within(dialog).queryByText('initial-event')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '下一页' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: '读取范围' }));
  await waitFor(() => expect(eventCalls).toBe(1));
  fireEvent.change(within(dialog).getByRole('combobox', { name: '到 checkpoint' }), { target: { value: 'checkpoint-B' } });
  await act(async () => { oldEvents.resolve({ items: [{ id: 'stale', type: 'stale-event', source: 'test', data: {} }], nextCursor: 'stale-cursor' }); });
  expect(within(dialog).queryByText('stale-event')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '下一页' })).toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: '读取范围' }));
  await waitFor(() => expect(within(dialog).getByText('fresh-event')).toBeTruthy());
  expect(call).toHaveBeenCalledWith('events', { runId: runA, fromSequence: 10, toSequence: 20, cursor: undefined, limit: 50, maxBytes: 16000 });
});

test.each([false, true])('injected client refreshes and unsubscribes without a preload global (StrictMode=%s)', async strict => {
  stubLayout();
  const call = vi.fn(async (method: string) => method === 'state' ? { projects: [], profiles: [], runs: [] } : {});
  const unsubscribe = vi.fn();
  let changed!: () => void;
  const onChanged = vi.fn((listener: () => void) => { changed = listener; return unsubscribe; });
  setTestWorkbenchClient({ call, bounds: vi.fn(), onChanged });
  expect(window.studio).toBeUndefined();
  const app = <ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>;
  const view = render(app, { reactStrictMode: strict });
  const mounts = strict ? 2 : 1;
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'state')).toHaveLength(mounts));
  expect(onChanged).toHaveBeenCalledTimes(mounts);
  expect(unsubscribe).toHaveBeenCalledTimes(mounts - 1);
  act(() => { changed(); changed(); });
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'state')).toHaveLength(mounts + 1));
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(mounts);
});


test.each(['button','escape'])('management dirty input survives overlay %s close until explicitly discarded', async how => {
 stubLayout();const call=vi.fn(async(method:string)=>method==='state'?state:method==='presentation'?undefined:emptyWorkspace(method));setTestWorkbenchClient({call,bounds:vi.fn()});
 render(<ThemeProvider initial={{theme:'light',layout:{}}}><App/></ThemeProvider>);
 await waitFor(()=>expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('project-1'));
 fireEvent.click(screen.getByRole('button',{name:'项目与环境管理'}));
 const dialog=within(await screen.findByRole('dialog'));fireEvent.change(dialog.getByLabelText('项目名称'),{target:{value:'Unsaved project name'}});
 if(how==='button')fireEvent.click(dialog.getByRole('button',{name:'返回工作台'}));else fireEvent.keyDown(dialog.getByLabelText('项目名称'),{key:'Escape'});
 expect(screen.getByRole('dialog')).toBeTruthy();expect((dialog.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Unsaved project name');
 fireEvent.click(dialog.getByRole('button',{name:'继续编辑'}));expect(screen.getByRole('dialog')).toBeTruthy();
 fireEvent.click(dialog.getByRole('button',{name:'返回工作台'}));fireEvent.click(dialog.getByRole('button',{name:'放弃输入并继续'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(call.mock.calls.some(([method])=>method==='updateProject')).toBe(false);
});

test('initial material bootstrap visibly disables section navigation until the authoritative draft is ready',async()=>{
 stubLayout();const gate=deferred<any>();const call=vi.fn(async(method:string)=>method==='state'?state:method==='presentation'?undefined:method==='workingMaterialDraft'?gate.promise:emptyWorkspace(method));setTestWorkbenchClient({call,bounds:vi.fn()});
 render(<ThemeProvider initial={{theme:'light',layout:{}}}><App/></ThemeProvider>);
 await waitFor(()=>expect(call.mock.calls.some(([method])=>method==='workingMaterialDraft')).toBe(true));
 await waitFor(()=>expect((screen.getByRole('tab',{name:'存档'}) as HTMLButtonElement).disabled).toBe(true));expect(screen.getByText('正在处理资料，请稍候…')).toBeTruthy();
 await act(async()=>gate.resolve(emptyWorkspace('workingMaterialDraft')));await waitFor(()=>expect((screen.getByRole('tab',{name:'存档'}) as HTMLButtonElement).disabled).toBe(false));
});
