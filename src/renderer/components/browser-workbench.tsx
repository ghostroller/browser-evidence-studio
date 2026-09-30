import { HostCapabilitiesSummary } from './host-capabilities';
import { SharedWebReplay } from './shared-web-replay';
import type { SelectionRequest, SelectionReceipt } from '../selection-session';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';
import { BrowserWorkbenchClient, BrowserWorkbenchClientError } from '../lib/browser-workbench-client';
import { WorkbenchHeader, WorkbenchShell } from './workbench-shell';
import { ProjectMetadataForm } from './project-metadata-form';
import { usePreferences } from './theme-provider';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { MaterialWorkbench } from './material-workbench';
import type { BrowserMaterialResult } from '@/contracts/browser-materials';
import { ResultCenter } from './result-center';
import type { BrowserResultResult, BrowserExecutionListItem } from '@/contracts/browser-results';
import type { ReplayPosition } from '@/contracts/recording';


const connectionLabels = { disconnected: '尚未配对', exchanging: '正在交换一次性票据', connecting: '正在读取已授权项目', connected: '已连接', stale: '连接待恢复 · 资料可能已过时', expired: '会话已结束，请重新配对', error: '连接失败' };
export function BrowserWorkbench({ client }: { client: BrowserWorkbenchClient }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const { preferences, setTheme } = usePreferences();
  const [ticket, setTicket] = useState('');
  const materialGrant = snapshot.grant === 'project-materials' || (snapshot.grant === 'project-workbench' || snapshot.grant === 'project-replay');
  const connecting = snapshot.status === 'exchanging' || snapshot.status === 'connecting';
  const attempt = useRef(false);
  useEffect(() => () => client.disconnect(), [client]);
  const connect = async () => {
    if (attempt.current) return;
    attempt.current = true;
    const input = ticket.trim(); setTicket('');
    try { await client.connect(input); } catch { /* Client exposes a sanitized connection error. */ }
    finally { attempt.current = false; }
  };
  return <WorkbenchShell browser>
    <WorkbenchHeader><span className="host-label">浏览器 · 合成项目工作台</span><Button variant="ghost" size="icon" aria-label={preferences.theme === 'light' ? '切换为暗色主题' : '切换为亮色主题'} onClick={() => void setTheme(preferences.theme === 'light' ? 'dark' : 'light')}>{preferences.theme === 'light' ? <Moon /> : <Sun />}</Button><span className="hint">主题仅本次页面有效</span></WorkbenchHeader>
    <main className="browser-workbench-content">
      <section className="browser-connection form-stack" aria-label="浏览器工作台连接">
        <h2>浏览器工作台</h2>
        <p role="status" aria-live="polite">{connectionLabels[snapshot.status]}</p>
        <p>实例标识：<code>{client.instanceId}</code></p>
        <p className="hint">{client.host.backend === 'node'?'在此 Node 实例的本机控制页面签发项目回放票据，核对实例标识后手动输入。会话最多 15 分钟，控制会话撤销或到期也会撤销项目访问。':'在此合成实例的 Electron 工作台打开“浏览器配对”，核对实例标识后手动输入一次性票据。会话最多 5 分钟，原生配对面板需保持打开。'}</p>
        {!snapshot.projectId && <form className="form-stack" autoComplete="off" onSubmit={event => { event.preventDefault(); if (ticket.trim() && !connecting) void connect(); }}>
          <Label>一次性配对票据<Input aria-label="一次性配对票据" type="password" autoComplete="off" spellCheck={false} value={ticket} onChange={event => setTicket(event.target.value)} maxLength={128} disabled={connecting} /></Label>
          <Button type="submit" disabled={!ticket.trim() || connecting}>连接合成项目</Button>
        </form>}
        {(snapshot.projectId || connecting) && <div className="button-row"><Button onClick={() => { attempt.current = false; setTicket(''); client.disconnect(); }}>断开连接并清除资料</Button>{snapshot.projectId && <Button disabled={connecting} onClick={() => void client.refresh().catch(() => {})}>刷新授权项目</Button>}</div>}
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.expiresAt && <p className="hint">会话到期：{new Date(snapshot.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}，不会自动续期</p>}
      </section>
      {snapshot.state && <section className="browser-project form-stack" aria-label="授权项目元数据">
        {snapshot.status !== 'connected' && <p role="status">以下是此前读取的资料，可能已过时。当前禁止保存。</p>}
        <p>项目标识：<code>{snapshot.state.project.id}</code> · 版本 {snapshot.state.project.revision}</p>
        <BrowserProjectEditor key={`${snapshot.state.project.id}/${snapshot.sessionEpoch}`} client={client} project={snapshot.state.project} writable={snapshot.status === 'connected'} />
      </section>}
      {snapshot.state && materialGrant && <BrowserMaterials key={`materials/${snapshot.state.project.id}/${snapshot.sessionEpoch}`} client={client} projectId={snapshot.state.project.id} writable={snapshot.status === 'connected'} refreshToken={snapshot.refreshToken}/>}
      {snapshot.state && (snapshot.grant === 'project-workbench' || snapshot.grant === 'project-replay') && <BrowserResults key={`results/${snapshot.state.project.id}/${snapshot.sessionEpoch}`} client={client} projectId={snapshot.state.project.id} readable={snapshot.status === 'connected'}/>}
      <HostCapabilitiesSummary host={client.host} embedded={false} />
      <section className="browser-capabilities" aria-label="浏览器能力边界"><h3>此连接的能力范围</h3>{materialGrant ? <p>本次授权本项目资料编辑与发布。进入资料工作区会初始化工作副本；目录读取可能修补目录。未提交输入和操作身份仅保留于本次内存会话。</p> : <p>本次只提供已配对项目的名称、目录简介和版本。仅明确点击保存时修改元数据。</p>}<ul><li>{client.host.backend === 'node'?'专用 Chromium 环境与录制：请使用本实例的本机控制页面；实时页面在独立 Chromium 窗口':'登录环境、原生浏览器呈现和录制：请使用 Electron 工作台'}</li>{materialGrant ? <li>可编辑已封存来源的保存点、字段和注释，可复制工作副本、固定版本；隔离历史回放及节点选择需明确的新回放授权</li> : <li>任务资料、保存点、回放、复制和固定版本：此元数据连接尚未开放浏览器能力</li>}{(snapshot.grant === 'project-workbench' || snapshot.grant === 'project-replay') && <li>结果只读：可查看实际执行、已提交记录和已保存报告；不能启动执行、生成验收报告或保存人工判定</li>}<li>Agent 授权和执行：此连接不具备权限</li></ul></section>
    </main>
    <footer className="statusbar"><span>合成实例 · {(snapshot.grant === 'project-workbench' || snapshot.grant === 'project-replay') ? '项目资料与只读结果授权' : materialGrant ? '项目资料授权' : '项目元数据配对'}</span><span>录制完成 ≠ 需求通过</span></footer>
  </WorkbenchShell>;
}
function BrowserProjectEditor({ client, project, writable }: { client: BrowserWorkbenchClient; project: BrowserProjectMetadata; writable: boolean }) {
  const [name, setName] = useState(project.name), [objective, setObjective] = useState(project.objective);
  const [baseline, setBaseline] = useState(project);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false), generation = useRef(0);
  const operations = useRef(new Map<string, string>());
  const dirty = name !== baseline.name || objective !== baseline.objective;
  const load = (value: BrowserProjectMetadata) => { setBaseline(value); setName(value.name); setObjective(value.objective); };
  useEffect(() => { if (!dirty && !pending.current) load(project); }, [project.id, project.revision, project.name, project.objective]);
  useEffect(() => () => { ++generation.current; }, []);
  const save = async () => {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    const current = generation.current;
    const fields = { projectId: baseline.id, expectedRevision: baseline.revision, name, objective };
    const fingerprint = JSON.stringify(fields);
    if (!operations.current.has(fingerprint)) operations.current.set(fingerprint, crypto.randomUUID());
    const input: BrowserUpdateProject = { ...fields, operationId: operations.current.get(fingerprint)! };
    try {
      const result = await client.updateProject(input);
      if (generation.current !== current) return;
      operations.current.delete(fingerprint); load(result); setMessage('项目名称和简介已保存。');
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof BrowserWorkbenchClientError ? failure.message : '项目未能保存；输入已保留，请刷新核对后重试。');
    } finally { pending.current = false; if (generation.current === current) setBusy(false); }
  };
  return <>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {dirty && baseline.revision !== project.revision && <p role="status">服务端版本已更新；当前输入仍基于版本 {baseline.revision}。撤销输入后可编辑最新版本。</p>}
    <ProjectMetadataForm name={name} objective={objective} onName={setName} onObjective={setObjective} dirty={dirty} busy={busy} disabled={!writable} onSubmit={() => void save()} onCancel={() => { load(project); setError(''); setMessage(''); operations.current.clear(); }} />
  </>;
}


function BrowserMaterials({ client, projectId, writable, refreshToken }: { client: BrowserWorkbenchClient; projectId: string; writable: boolean; refreshToken?: number }) {
  const [opened, setOpened] = useState(false);
  const [editorBusy, setEditorBusy] = useState(true);
  const [view, setView] = useState<'checkpoints' | 'archives'>('checkpoints');
  const [position, setPosition] = useState<ReplayPosition | null>(null);
  const [notice, setNotice] = useState('');
  const [replayPosition, setReplayPosition] = useState<ReplayPosition | null>(null);
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest | null>(null);
  const [selectionReceipt, setSelectionReceipt] = useState<SelectionReceipt | null>(null);
  const replayOrigin = document.querySelector<HTMLMetaElement>('meta[name="workbench-replay-origin"]')?.content;
  const canReplay = client.getSnapshot().grant === 'project-replay' && !!replayOrigin;
  const openReplay = (next: ReplayPosition) => { if (!canReplay) { setNotice('历史回放需要在可信控制界面重新选择隔离回放配对权限。'); return; } setSelectionRequest(null); setSelectionReceipt(null); setReplayPosition(next); };
  const selectTarget = (request: SelectionRequest) => { if (!canReplay) return; setSelectionReceipt(null); setSelectionRequest(request); setReplayPosition(request.anchor); };
  const transition = useRef<(() => Promise<boolean>) | null>(null);
  const switchView = async (next: typeof view) => {
    if (!writable || editorBusy || !client.materials.canEdit()) return;
    if (transition.current && !await transition.current()) return;
    setView(next);
  };
  return <section className="browser-materials form-stack" aria-label="授权项目资料">
    <h2>项目资料</h2>
    {!opened ? <><p>打开后会读取资料目录，并在需要时初始化当前工作副本或修补目录。来源仅限本项目已封存录制。</p><Button disabled={!writable} onClick={() => setOpened(true)}>打开项目资料工作区</Button></> : <>
      <p role="status">{writable ? '资料连接已就绪' : '资料可能已过时；编辑和保存已暂停，重连后权威回读。'}</p>
      <fieldset className="browser-material-controls" disabled={!writable||editorBusy} inert={!writable||editorBusy}>
        <nav className="material-actions" aria-label="资料视图"><Button aria-pressed={view === 'checkpoints'} onClick={() => void switchView('checkpoints')}>保存点与字段</Button><Button aria-pressed={view === 'archives'} onClick={() => void switchView('archives')}>资料存档</Button></nav>
        <BrowserSourcePicker client={client} projectId={projectId} writable={writable&&!editorBusy} onPosition={value => { setPosition(value); setReplayPosition(null); setSelectionRequest(null); }}/>{canReplay && <Button disabled={!position} onClick={() => position && openReplay(position)}>打开所选历史</Button>}
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      {replayPosition && canReplay && <SharedWebReplay client={client.replay} projectId={projectId} instanceId={client.instanceId} origin={replayOrigin!} position={replayPosition} request={selectionRequest} readable={writable} onPosition={setPosition} onSelection={setSelectionReceipt} onClose={() => { setReplayPosition(null); setSelectionRequest(null); setSelectionReceipt(null); }}/>}
      <MaterialWorkbench historicalSelection={canReplay} selectedTarget={selectionReceipt} client={client.materials} projectId={projectId} position={position} view={view} writable={writable} refreshToken={refreshToken} transitionRef={transition} onBusyChange={setEditorBusy}
        onOpenReplay={openReplay}
        onSelectTarget={selectTarget}
        onEditWorkspace={() => setView('checkpoints')}
        recordingArchive={<p>原始录制管理需要具备原件管理能力的工作台。可在上方选择本项目已封存来源。</p>}/>
    </>}
  </section>;
}

function BrowserSourcePicker({ client, projectId, writable, onPosition }: { client: BrowserWorkbenchClient; projectId: string; writable: boolean; onPosition(value: ReplayPosition | null): void }) {
  const [recordings, setRecordings] = useState<BrowserMaterialResult<'materialRecordings'>>({ items: [], returnedBytes: 0, outputTruncated: false });
  const [streams, setStreams] = useState<BrowserMaterialResult<'recordingStreams'>>({ items: [] });
  const [positions, setPositions] = useState<BrowserMaterialResult<'recordingPositions'>>({ items: [] });
  const [recordingId, setRecordingId] = useState(''), [streamIndex, setStreamIndex] = useState(''), [positionIndex, setPositionIndex] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const selection = useRef(0), listRead = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current=true; return () => { alive.current=false; ++selection.current; ++listRead.current; }; }, []);
  const canRead = () => writable && client.materials.canEdit();
  const loadRecordings = async (cursor?: string) => {
    if (!canRead()) return;
    const token=++listRead.current;
    setBusy(true);setError('');
    try {
      const result=await client.materialCall('materialRecordings',{projectId,limit:50,maxBytes:24576,...(cursor?{cursor}:{})});
      if(alive.current&&token===listRead.current)setRecordings(previous=>cursor?{...result,items:[...previous.items,...result.items]}:result);
    } catch(failure) { if(alive.current&&token===listRead.current)setError(String(failure)); }
    finally { if(alive.current&&token===listRead.current)setBusy(false); }
  };
  const initialRead=useRef(false);
  useEffect(() => { if(writable&&!initialRead.current){initialRead.current=true;void loadRecordings();} }, [projectId,writable]);
  const chooseRecording = async (id: string, cursor?: string) => {
    if(!canRead())return;
    const token=++selection.current;
    if(!cursor){setRecordingId(id);setStreamIndex('');setPositionIndex('');setStreams({items:[]});setPositions({items:[]});onPosition(null);}
    if(!id)return;
    setBusy(true);setError('');
    try {
      const result=await client.materialCall('recordingStreams',{projectId,recordingId:id,limit:50,maxBytes:24576,...(cursor?{cursor}:{})});
      if(alive.current&&token===selection.current)setStreams(previous=>cursor?{...result,items:[...previous.items,...result.items]}:result);
    }catch(failure){if(alive.current&&token===selection.current)setError(String(failure));}
    finally{if(alive.current&&token===selection.current)setBusy(false);}
  };
  const chooseStream = async (index: string, ordinal?: number) => {
    if(!canRead())return;
    const token=++selection.current;
    if(ordinal===undefined){setStreamIndex(index);setPositionIndex('');setPositions({items:[]});onPosition(null);}
    const stream=index===''?undefined:streams.items[Number(index)];if(!stream)return;
    setBusy(true);setError('');
    try {
      const result=await client.materialCall('recordingPositions',{projectId,position:stream.first,limit:50,maxBytes:24576,...(ordinal===undefined?{}:{ordinal})});
      if(alive.current&&token===selection.current)setPositions(previous=>ordinal===undefined?result:{...result,items:[...previous.items,...result.items]});
    }catch(failure){if(alive.current&&token===selection.current)setError(String(failure));}
    finally{if(alive.current&&token===selection.current)setBusy(false);}
  };
  return <details className="browser-source-picker" open><summary>已封存来源位置</summary>
    <p>按录制、文档流和真实事件边界选择来源，再新增保存点。完整快照前的事件不能作为保存点来源。这只是来源索引；取得隔离回放授权后，可打开所选历史并选择节点。</p>
    <div className="browser-source-grid">
      <Label>来源录制<NativeSelect aria-label="来源录制" value={recordingId} disabled={!writable||busy||!recordings.items.length} onChange={event=>void chooseRecording(event.target.value)}><option value="">选择已封存录制</option>{recordings.items.map(item=><option key={item.recordingId} value={item.recordingId}>{item.recordingId} · {new Date(item.sealedAt).toLocaleString()}</option>)}</NativeSelect></Label>
      <Label>来源文档流<NativeSelect aria-label="来源文档流" value={streamIndex} disabled={!writable||busy||!recordingId} onChange={event=>void chooseStream(event.target.value)}><option value="">选择文档流</option>{streams.items.map((stream,index)=><option key={index} value={String(index)}>{stream.first.pageId} / {stream.first.documentId} · {stream.events} 个事件</option>)}</NativeSelect></Label>
      <Label>来源事件位置<NativeSelect aria-label="来源事件位置" value={positionIndex} disabled={!writable||busy||streamIndex===''} onChange={event=>{if(!canRead())return;const index=event.target.value;if(index!==''&&!positions.items.slice(0,Number(index)+1).some(item=>item.type===2))return;setPositionIndex(index);onPosition(index===''?null:positions.items[Number(index)]?.position??null);}}><option value="">选择真实事件边界</option>{positions.items.map((item,index)=><option key={index} value={String(index)} disabled={!positions.items.slice(0,index+1).some(value=>value.type===2)}>事件 #{item.position.eventSeq} · {new Date(item.position.sourceTimeMs).toLocaleTimeString()} · {item.type===2?'完整快照（推荐）':positions.items.slice(0,index+1).some(value=>value.type===2)?'已建立快照的事件':'尚无完整快照，不可选'}</option>)}</NativeSelect></Label>
    </div>
    <div className="button-row"><Button disabled={!writable||busy} onClick={()=>void loadRecordings()}>刷新封存来源</Button>{recordings.nextCursor&&<Button disabled={!writable||busy} onClick={()=>void loadRecordings(recordings.nextCursor)}>更多来源录制</Button>}{streams.nextCursor&&<Button disabled={!writable||busy} onClick={()=>void chooseRecording(recordingId,streams.nextCursor)}>更多文档流</Button>}{positions.nextOrdinal!==undefined&&<Button disabled={!writable||busy} onClick={()=>void chooseStream(streamIndex,positions.nextOrdinal)}>更多事件位置</Button>}</div>
    {!busy&&!recordings.items.length&&!error&&<p>未找到已封存录制。请在对应宿主的控制界面完成合成录制并封存，再刷新来源。</p>}
    {positionIndex!==''&&positions.items[Number(positionIndex)]&&<p role="status">已选择真实来源：{recordingId} / {positions.items[Number(positionIndex)].position.documentId} / 事件 #{positions.items[Number(positionIndex)].position.eventSeq}</p>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}


function BrowserResults({ client, projectId, readable }: { client: BrowserWorkbenchClient; projectId: string; readable: boolean }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [executions, setExecutions] = useState<BrowserResultResult<'projectExecutions'>>({ items: [], returnedBytes: 0, outputTruncated: false });
  const [selected, setSelected] = useState<BrowserExecutionListItem | null>(null);
  const request = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current; }; }, []);
  const load = async (cursor?: string) => {
    if (!readable || !client.results.canRead()) return;
    const token = ++request.current; setBusy(true); setError('');
    try {
      const value = await client.resultCall('projectExecutions', { projectId, limit: 30, maxBytes: 24576, ...(cursor ? { cursor } : {}) });
      if (alive.current && token === request.current) { setExecutions(previous => cursor ? previous.nextCursor === cursor ? { ...value, items: [...previous.items, ...value.items] } : previous : value); setLoaded(true); }
    } catch (failure) { if (alive.current && token === request.current) setError(String(failure)); }
    finally { if (alive.current && token === request.current) setBusy(false); }
  };
  useEffect(() => {
    if (opened && readable) void load();
    return () => { ++request.current; };
  }, [opened, readable, projectId]);
  const label = (item: BrowserExecutionListItem) => `${item.mode === 'from-start-validation' ? '从头验证' : '当前页测试'} · ${new Date(item.startedAt).toLocaleString()} · ${item.status}`;
  return <section className="browser-results form-stack" aria-label="授权项目只读结果">
    <h2>执行与已保存结果</h2>
    <p>只读查看本项目实际执行、已提交批次和固定报告。报告是此前保存的结果；浏览器不会重新执行或验收。</p>
    {!opened ? <Button disabled={!readable} onClick={() => setOpened(true)}>打开只读结果</Button> : <>
      {!readable && <p role="status">结果可能已过时；连接恢复前已暂停读取。未提交的资料输入仍留在原编辑器。</p>}
      <div className="button-row"><Button disabled={!readable || busy} onClick={() => void load()}>刷新执行列表</Button>{executions.nextCursor && <Button disabled={!readable || busy} onClick={() => void load(executions.nextCursor)}>后续执行</Button>}</div>
      {busy && <p role="status">正在读取项目执行列表…</p>}{error && <p role="alert">{error} 执行列表未能读取，请重试；未将失败当作空列表。</p>}
      {!busy && loaded && !executions.items.length && !error && <p>这个项目尚无实际执行。请在对应宿主的控制界面完成执行并保存报告后刷新。</p>}
      <Label>选择项目执行<NativeSelect aria-label="选择项目执行" disabled={!readable || busy} value={selected?.executionId ?? ''} onChange={event => { const item = executions.items.find(value => value.executionId === event.target.value); if (item) setSelected(item); else if (!event.target.value) setSelected(null); }}>
        <option value="">选择实际执行</option>{selected && !executions.items.some(item => item.executionId === selected.executionId) && <option value={selected.executionId}>{label(selected)} · 当前已打开，不在本页</option>}
        {executions.items.map(item => <option key={item.executionId} value={item.executionId}>{label(item)}</option>)}
      </NativeSelect></Label>
      {selected && <><p>当前执行：<code>{selected.executionId}</code> · 固定资料 <code>{selected.materialRevisionId}</code></p>
        <fieldset className="browser-result-content" disabled={!readable} inert={!readable}><ResultCenter client={client.results} readable={readable} projectId={projectId} executionId={selected.executionId}/></fieldset></>}
    </>}
  </section>;
}
