import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Moon, Sun, PanelLeft, Plus, Settings } from 'lucide-react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Label } from './components/ui/label';
import { NativeSelect } from './components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { Separator } from './components/ui/separator';
import { Alert, AlertDescription } from './components/ui/alert';
import { SplitPane } from './components/split-pane';
import { StatusBadge as Badge, statusLabel as label } from './components/status-badge';
import { usePreferences } from './components/theme-provider';
import { BrowserPresentation } from './lib/browser-presentation';
import { JsonView, RunRecoveryView, InterruptedValidationView, ArtifactView, ValidationView } from './components/evidence-view';
import { MaterialWorkbench } from './components/material-workbench';
import { ReplayWorkspace } from './components/replay-workspace';
import { ResultCenter } from './components/result-center';
import type { HistoricalElementRef, ReplayPosition, ReplayState } from '@/contracts/recording';

declare global { interface Window { studio: { call(method: string, body?: unknown): Promise<any>; bounds(rect: unknown): void } } }
const EMPTY_ITEMS: any[] = [];
const items = (value: any): any[] => Array.isArray(value) ? value : value?.items || EMPTY_ITEMS;
const short = (value: unknown, length = 90) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text?.length > length ? text.slice(0, length) + '…' : text ?? '—'; };
const time = (value: string | undefined) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
export function App() {
  const [state, setState] = useState<any>({ projects: [], profiles: [], runs: [] });
  const [projectId, setProjectId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [url, setUrl] = useState('about:blank');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [stopping, setStopping] = useState(false);
  const [executionMode, setExecutionMode] = useState<'current-page-test' | 'from-start-validation'>('from-start-validation');
  const [panel, setPanel] = useState('checkpoints');
  const [overlay, setOverlay] = useState<string | null>(null);
  const [recoveryRunId, setRecoveryRunId] = useState('');
  const [history, setHistory] = useState<any>(null);
  const [historyRunId, setHistoryRunId] = useState('');
  const [artifact, setArtifact] = useState<any>(null);
  const [replayRecordingId, setReplayRecordingId] = useState('');
  const [requestedReplayPosition, setRequestedReplayPosition] = useState<ReplayPosition | null>(null);
  const [replayPosition, setReplayPosition] = useState<ReplayPosition | null>(null);
  const [replayState, setReplayState] = useState<ReplayState | null>(null);
  const [historicalTarget, setHistoricalTarget] = useState<HistoricalElementRef | null>(null);
  const [selectingHistory, setSelectingHistory] = useState(false);
  const [checkpointTitle, setCheckpointTitle] = useState('');
  const [cancellingCheckpoint, setCancellingCheckpoint] = useState(false);
  const [checkpointDescription, setCheckpointDescription] = useState('');
  const [checkpointKey, setCheckpointKey] = useState('');
  const [requirementIds, setRequirementIds] = useState('');
  const [newProject, setNewProject] = useState('');
  const [objective, setObjective] = useState('');
  const [scriptDirectory, setScriptDirectory] = useState('');
  const [newProfile, setNewProfile] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [validation, setValidation] = useState<any>(null);
  const [fixedExecutionId, setFixedExecutionId] = useState('');
  const [revisionPage, setRevisionPage] = useState<any>({ items: [] });
  const [materialRevisionId, setMaterialRevisionId] = useState('');
  const [historyTab, setHistoryTab] = useState('checkpoints');
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<any>(null);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const browserBox = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const historyRequest = useRef(0);
  const historySelection = useRef(0);
  const selectedHistoryRun = useRef('');
  const artifactRequest = useRef(0);
  const eventRequest = useRef(0);
  const eventRange = useRef({ start: '', end: '' });
  const { preferences, revision, setTheme, resetLayout, clearError: clearPreferenceError, error: preferenceError } = usePreferences();
  const active = state.active;
  const liveSession = state.session || active;
  const projects = items(state.projects);
  const profiles = items(state.profiles).filter((profile: any) => !projectId || profile.projectId === projectId);
  const runs = items(state.runs).filter((run: any) => !projectId || run.projectId === projectId);
  const recoveryRuns = items(state.runs).filter((run: any) => run.status === 'unreadable');
  const project = projects.find((entry: any) => entry.id === projectId);
  const checkpoints = items(history?.checkpoints);
  const workspaceRunId = active?.id || (runs.some(run => run.id === historyRunId) ? historyRunId : '');
  const workspaceCheckpoints = historyRunId === workspaceRunId ? checkpoints : [];
  const pages = items(liveSession?.pages);
  const selectedPage = pages.find((page: any) => page.pageId === liveSession?.selectedPageId) || pages[0];
  const activeValidation = items(state.validations).find((record: any) => record.runId === active?.id);
  const selectedMaterialRevision = items(revisionPage).find((entry: any) => entry.revisionId === materialRevisionId && entry.status === 'available');
  const validationProjectId = active?.projectId || projectId;
  const validationProfileId = active?.profileId || profileId;
  const validationDisabledReason = !validationProjectId || !validationProfileId
    ? '先选择项目和命名登录环境。'
    : ['running', 'waiting-human', 'finalizing', 'stopping'].includes(active?.execution)
      ? '请等待当前执行、人工交接或报告保存结束；需要中止时使用“停止并接管”。'
      : busy ? '请等待当前操作完成。' : '';
  const refresh = useCallback(async () => { const next = await window.studio.call('state'); setState(next); return next; }, []);
  const call = useCallback(async (method: string, body: any = {}, success = '') => {
    setBusy(method); setError('');
    try { const result = await window.studio.call(method, body); if (success) setNotice(success); await refresh(); return result; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); throw failure; }
    finally { setBusy(''); }
  }, [refresh]);
  const stopExecution = async () => {
    setStopping(true); setError('');
    try {
      await window.studio.call('stopRunner', { runId: active?.id, validationId: state.validationStarting?.validationId });
      setNotice('自动化已停止；确认静默后可人工接管。'); await refresh();
    } catch (failure) { setError(String(failure)); }
    finally { setStopping(false); }
  };
  const perform = (action: () => Promise<any>) => { void action().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); };
  const loadHistory = useCallback(async (id: string, selection?: number) => {
    if (selection === undefined && selectedHistoryRun.current) return null;
    const request = ++historyRequest.current;
    const result = await window.studio.call('history', { runId: id });
    if (request !== historyRequest.current || (selection === undefined
      ? !!selectedHistoryRun.current
      : selection !== historySelection.current || selectedHistoryRun.current !== id)) return null;
    setHistory(result); setHistoryRunId(id); return result;
  }, []);
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); const timer = setInterval(() => void refresh().catch(failure => setError(String(failure))), 2000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!projectId && projects.length) setProjectId(projects[0].id); }, [projects, projectId]);
  useEffect(() => { if (active?.projectId && active.projectId !== projectId) setProjectId(active.projectId); }, [active?.projectId, projectId]);
  useEffect(() => { setScriptDirectory(project?.scriptDirectory || ''); }, [project?.id, project?.scriptDirectory]);
  useEffect(() => { if (!profiles.some((entry: any) => entry.id === profileId)) setProfileId(profiles[0]?.id || ''); }, [profiles, profileId]);
  useEffect(() => { if (selectedPage?.url && document.activeElement !== addressInput.current) setUrl(selectedPage.url); }, [selectedPage?.url]);
  useEffect(() => {
    setMaterialRevisionId(''); setRevisionPage({ items: [] });
    if (!projectId) return;
    void window.studio.call('materialRevisions', { projectId, limit: 50, maxBytes: 24576 }).then(setRevisionPage).catch(() => undefined);
  }, [projectId]);
  useEffect(() => { if (!active && state.fixtureUrl && url === 'about:blank') { setUrl(state.fixtureUrl); setInputJson(JSON.stringify({ baseUrl: state.fixtureUrl }, null, 2)); } }, [state.fixtureUrl, active, url]);
  useEffect(() => { if (active?.id) { void loadHistory(active.id).catch(() => undefined); const timer = setInterval(() => { if (!overlay) void loadHistory(active.id).catch(() => undefined); }, 6000); return () => clearInterval(timer); } }, [active?.id, loadHistory, overlay]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  const openHistory = async (runId: string) => {
    const selection = ++historySelection.current;
    selectedHistoryRun.current = runId;
    ++artifactRequest.current; ++eventRequest.current;
    eventRange.current = { start: '', end: '' }; setRangeStart(''); setRangeEnd('');
    try {
      if (!await loadHistory(runId, selection)) return false;
      setArtifact(null); setSelectedCheckpoint(null); setHistoryTab('checkpoints'); setOverlay('evidence');
      return true;
    } catch (failure) {
      if (selection !== historySelection.current) return false;
      selectedHistoryRun.current = ''; ++historyRequest.current;
      throw failure;
    }
  };
  const openArtifact = async (id: string, options: any = {}) => {
    const runId = historyRunId || active?.id;
    const selection = historySelection.current;
    const request = ++artifactRequest.current;
    const result = await call('artifact', { runId, id, ...options });
    if (request === artifactRequest.current && selection === historySelection.current && selectedHistoryRun.current === runId) setArtifact(result);
  };
  const openValidation = async (id: string) => {
    const selection = ++historySelection.current;
    ++historyRequest.current; ++artifactRequest.current; ++eventRequest.current;
    eventRange.current = { start: '', end: '' }; setRangeStart(''); setRangeEnd('');
    const record = await call('validation', { id });
    if (selection !== historySelection.current) return;
    selectedHistoryRun.current = record.runId;
    setValidation(record); setArtifact(null); setHistory(null); setHistoryRunId(record.runId); setHistoryTab('validation'); setOverlay('evidence');
    try { await loadHistory(record.runId, selection); }
    catch (failure) { if (selection === historySelection.current) setHistory({ error: String(failure), checkpoints: { items: [] } }); }
  };
  const closeOverlay = () => {
    if (overlay === 'evidence') {
      ++historySelection.current; ++historyRequest.current; ++artifactRequest.current; ++eventRequest.current;
      selectedHistoryRun.current = '';
    }
    setOverlay(null); setArtifact(null);
  };
  const openRecovery = (runId: string) => { setRecoveryRunId(runId); setOverlay('recovery'); };
  const openFixedResults = (executionId: string) => { setFixedExecutionId(executionId); setOverlay('results'); };
  const prepareRetry = (record: any) => {
    if (active) return;
    if (projects.some(project => project.id === record.projectId)) setProjectId(record.projectId);
    if (items(state.profiles).some(profile => profile.id === record.profileId && profile.projectId === record.projectId)) setProfileId(record.profileId);
    closeOverlay(); setPanel('validation'); setNotice('已打开执行面板。核对登录环境、脚本和输入后新建验收运行；旧控制权与执行栈不恢复。');
  };
  const queryEvents = async (cursor?: string) => {
    const request = ++eventRequest.current;
    const { start, end } = eventRange.current;
    const from = checkpoints.find((entry: any) => entry.id === start);
    const to = checkpoints.find((entry: any) => entry.id === end);
    const runId = historyRunId;
    const selection = historySelection.current;
    const page = await call('events', { runId, fromSequence: from?.sequence, toSequence: to?.sequence, cursor, limit: 50, maxBytes: 16000 });
    if (request === eventRequest.current && selection === historySelection.current && selectedHistoryRun.current === runId && eventRange.current.start === start && eventRange.current.end === end) setHistory((current: any) => ({ ...current, events: page }));
  };
  const changeEventRange = (which: 'start' | 'end', value: string) => {
    eventRange.current = { ...eventRange.current, [which]: value };
    ++eventRequest.current; ++artifactRequest.current;
    setHistory((current: any) => current ? { ...current, events: null } : current);
    setArtifact(null);
    if (which === 'start') setRangeStart(value); else setRangeEnd(value);
  };
  const synthetic = async () => { const result = await call('syntheticSite'); const address = result.url || state.fixtureUrl; setUrl(address); setInputJson(JSON.stringify({ baseUrl: address }, null, 2)); if (liveSession) await call('navigate', { url: address }); };
  const saveCheckpoint = async () => {
    const result = await call('checkpoint', { key: checkpointKey.trim() || `checkpoint-${Date.now()}`, title: checkpointTitle.trim() || '未命名保存点', description: checkpointDescription, requirementIds: requirementIds.split(/[,，\s]+/).filter(Boolean) });
    setNotice(result.metadata?.captureOutcome === 'cancelled' ? '采集已取消，已获取材料和缺失原因已保存。' : result.metadata?.captureOutcome === 'timed-out' ? '采集已超时，已获取材料和超时原因已保存。' : result.metadata?.captureStatus !== 'complete' ? 'checkpoint 已保存，部分材料采集失败，请查看材料状态。' : '已持久化 checkpoint；截图与 DOM 的时间范围已记录。');
    setCheckpointTitle(''); setCheckpointDescription(''); setCheckpointKey('');
    if (active?.id) await loadHistory(active.id);
  };
  const cancelCheckpoint = async () => {
    if (!active?.checkpoint || cancellingCheckpoint) return;
    setCancellingCheckpoint(true);
    try { await window.studio.call('cancelCheckpoint', { runId: active.id, operationId: active.checkpoint.id }); await refresh(); }
    finally { setCancellingCheckpoint(false); }
  };
  const openReplayPosition = useCallback((position: ReplayPosition) => {
    setReplayRecordingId(position.recordingId); setRequestedReplayPosition(position); setReplayPosition(position);
  }, []);
  const closeReplayWorkspace = useCallback(() => {
    setSelectingHistory(false); setReplayRecordingId(''); setRequestedReplayPosition(null); setReplayPosition(null); setReplayState(null); setHistoricalTarget(null);
  }, []);
  const receiveReplayPosition = useCallback((position: ReplayPosition, state?: ReplayState) => {
    setReplayPosition(position); setReplayState(state || null); setHistoricalTarget(null);
  }, []);
  const receiveHistoricalTarget = useCallback((target: HistoricalElementRef) => {
    setHistoricalTarget(target); setSelectingHistory(false); setPanel('materials');
  }, []);
  const cancelHistoricalSelection = useCallback(() => setSelectingHistory(false), []);
  const beginHistoricalSelection = useCallback((kind: 'field' | 'annotation', checkpointId?: string) => {
    if (checkpointId && !replayPosition) { setError('先打开卡片的历史位置。'); return; }
    if (!replayRecordingId || replayState?.reliability !== 'reliable') { setError('先在可靠的历史位置打开回放，才能绑定元素。'); return; }
    setHistoricalTarget(null); setSelectingHistory(true); setNotice(kind === 'annotation' ? '在隔离历史页选择注释对象；按 Esc 取消。' : '在隔离历史页选择字段示例；按 Esc 取消。');
  }, [replayPosition, replayRecordingId, replayState?.reliability]);
  const openRecordingReplay = async (recordingId: string) => {
    const streams = await window.studio.call('recordingStreams', { projectId, recordingId, limit: 1 });
    const first = streams.items?.[0]?.first as ReplayPosition | undefined;
    if (!first) throw new Error('这个存档没有可读取的历史页面流。');
    openReplayPosition(first);
  };
  return <BrowserPresentation browserBox={browserBox} revision={revision} overlay={overlay} onError={setError}><div className="app-shell">
    <header className="topbar" inert={selectingHistory}><div className="brand"><strong>Browser Evidence Studio</strong></div><div className="topbar-spacer" />
      <Button variant="ghost" size="icon" aria-label="恢复默认布局" title="恢复默认布局" onClick={() => perform(resetLayout)}><PanelLeft /></Button>
      <Button variant="ghost" size="icon" aria-label={preferences.theme === 'light' ? '切换为暗色主题' : '切换为亮色主题'} title={preferences.theme === 'light' ? '切换为暗色主题' : '切换为亮色主题'} onClick={() => perform(() => setTheme(preferences.theme === 'light' ? 'dark' : 'light'))}>{preferences.theme === 'light' ? <Moon /> : <Sun />}</Button>
      <Separator orientation="vertical" className="topbar-separator" /><Button variant="ghost" onClick={() => setOverlay('setup')}><Settings />连接与环境</Button>
    </header>
    <main className="workspace"><SplitPane key={revision} name="workspace" label="调整工作台与浏览器宽度" initial={Math.min(440, Math.max(320, window.innerWidth * .3)) / window.innerWidth * 100} minFirst="320px" minSecond="400px" first={<aside className="workspace-panel" inert={selectingHistory} data-selection-locked={selectingHistory || undefined}>
      <div className="project-controls"><div className="selector-row"><NativeSelect aria-label="项目" title={project?.objective || project?.name} value={projectId} disabled={!!liveSession} onChange={event => setProjectId(event.target.value)}>{projects.length ? projects.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.name}</option>) : <option value="">选择项目</option>}</NativeSelect><Button size="icon" aria-label="新建项目" title="新建项目" disabled={!!active} onClick={() => setOverlay('project')}><Plus /></Button></div>
      <div className="selector-row"><NativeSelect aria-label="登录环境" value={profileId} disabled={!!liveSession} onChange={event => setProfileId(event.target.value)}>{profiles.length ? profiles.map((profile: any) => <option key={profile.id} value={profile.id}>{profile.name}</option>) : <option value="">选择登录环境</option>}</NativeSelect><Button size="icon" aria-label="添加环境" title="添加环境" disabled={!projectId || !!active} onClick={() => setOverlay('profile')}><Plus /></Button></div>
      <div className="run-controls">{active ? <><Badge value={active.capture} /><Button disabled={!!busy} onClick={() => perform(async () => { await call('seal', {}, '录制已封存，实时页面保留。'); await loadHistory(active.id); })}>结束并封存</Button></> : <Button variant="default" className="primary full" disabled={!projectId || !profileId || !!busy} onClick={() => perform(() => call('startRun', { projectId, profileId, url, kind: 'demonstrate' }, '录制已启动。'))}>开始录制</Button>}</div></div>
            {items(state.validationRecovery?.diagnostics).length > 0 && <details className="recovery-notice"><summary>验收存档恢复提示（{items(state.validationRecovery.diagnostics).length}）</summary><p>已保留可读取的记录。以下问题不表示执行成功，也不会恢复自动化控制。</p>{items(state.validationRecovery.diagnostics).slice(0, 20).map((entry: any, index: number) => <p key={index}><code>{entry.runId || entry.validationId || '验收目录'}</code> · {entry.message || entry.code}</p>)}</details>}
      {active?.handoff?.status === 'waiting' && <div className="handoff-banner"><div><strong>等待你完成页面操作</strong><p>{active.handoff.instructions || '完成页面要求后，明确交还控制。'}</p><small>等待与超时不表示成功；交还后会验证实际页面状态。</small></div><Button variant="default" className="primary" disabled={!!busy || active.locked} onClick={() => perform(() => call('releaseHuman', { handoffId: active.handoff.handoffId }, '已提交交还请求；按真实完成条件判断。'))}>交还控制</Button></div>}
      {active?.handoff?.status === 'needs-attention' && <div className="banner error"><strong>人工协助未完成</strong><span>超时、取消或连接结束后，没有推断操作成功。当前材料仍保留，请停止后重新开始明确的尝试。</span></div>}

      <Tabs value={panel} onValueChange={setPanel} className="inspector"><TabsList className="panel-tabs">{[['checkpoints','保存点'],['materials','任务资料'],['validation','执行'],['archives','存档']].map(([key,name]) => <TabsTrigger key={key} value={key} className={panel === key ? 'selected' : ''}>{name}</TabsTrigger>)}</TabsList><div className="panel-content" role="tabpanel">
      {panel === 'checkpoints' && <SplitPane name="checkpoints" orientation="vertical" label="调整保存点表单与列表高度" initial={58} minFirst="200px" minSecond="72px" first={<div className="pane-scroll form-stack"><div className="panel-heading"><h2>保存关键结果</h2></div><Label>标题<Input value={checkpointTitle} onChange={event => setCheckpointTitle(event.target.value)} placeholder="例如：订单已加载到最后一页" /></Label><Label>结果与范围<Textarea rows={3} value={checkpointDescription} onChange={event => setCheckpointDescription(event.target.value)} placeholder="数据范围、关键字段、页面含义与未确认项" /></Label><Collapsible className="advanced"><CollapsibleTrigger asChild><Button variant="ghost" className="advanced-trigger">稳定标识与需求对应</Button></CollapsibleTrigger><CollapsibleContent className="form-stack"><Label>Checkpoint key<Input value={checkpointKey} onChange={event => setCheckpointKey(event.target.value)} placeholder="orders-complete" /></Label><Label>需求 ID（空格或逗号分隔）<Input value={requirementIds} onChange={event => setRequirementIds(event.target.value)} placeholder="orders-complete" /></Label></CollapsibleContent></Collapsible><Button variant="default" className="primary full" disabled={!active || !!busy || !!active.checkpoint || active.controller === 'agent'} onClick={() => perform(saveCheckpoint)}>{busy === 'checkpoint' ? active?.checkpoint?.phase === 'saving' ? '正在持久化已获取材料…' : '正在采集（最长 10 秒）…' : '保存 checkpoint'}</Button>{active?.checkpoint && <div className="checkpoint-progress"><p role="status">{active.checkpoint.phase === 'saving' ? '采集已结束，正在完成证据写入。' : active.checkpoint.phase === 'draining' ? '正在等待操作连接停止写入…' : '正在获取截图和 DOM，可取消并保留已取得材料。'}</p>{active.checkpoint.phase !== 'saving' && <Button disabled={cancellingCheckpoint} onClick={() => perform(cancelCheckpoint)}>{cancellingCheckpoint ? '正在取消…' : '取消采集'}</Button>}</div>}<p className="hint">短暂锁定输入，保存截图、DOM 和采集时间范围。部分失败也会保留成功材料。</p></div>} second={<div className="pane-scroll"><div className="section-label">已保存 <span>{workspaceCheckpoints.length}</span></div>{workspaceCheckpoints.length ? [...workspaceCheckpoints].reverse().map((checkpoint: any, index: number) => <Button className="checkpoint-card" key={checkpoint.id} onClick={() => perform(async () => { if (await openHistory(workspaceRunId)) setSelectedCheckpoint(checkpoint); })}><span><strong>{checkpoint.title || checkpoint.key}</strong><small>{time(checkpoint.savedAt)} · {label(checkpoint.captureConsistency)} · {label(checkpoint.metadata?.captureStatus || 'unknown')}</small><p>{short(checkpoint.description || '没有补充说明', 80)}</p></span></Button>) : <div className="empty compact">尚未保存关键结果。<br />{active ? '连续录制独立进行，可随时保存关键结果。' : '开始录制后可保存关键结果。'}</div>}</div>} />}
      {panel === 'materials' && <MaterialWorkbench projectId={projectId} recordingId={workspaceRunId} position={replayPosition} selectedTarget={historicalTarget} onOpenReplay={openReplayPosition} onSelectTarget={beginHistoricalSelection} />}
      {panel === 'validation' && <SplitPane name="validation" orientation="vertical" label="调整脚本输入与执行结果高度" initial={68} minFirst="240px" minSecond="90px" first={<div className="pane-scroll form-stack"><div className="panel-heading"><h2>受控复跑</h2></div><Label>脚本目录<Input value={scriptDirectory} onChange={event => setScriptDirectory(event.target.value)} placeholder="包含 workflow.json 的绝对目录" /></Label><Button className="full" disabled={!projectId || !scriptDirectory.trim() || !!busy} onClick={() => perform(() => call('updateProject', { projectId, scriptDirectory }, '已登记此项目的脚本目录，Agent 可执行这里的 workflow.json。'))}>登记脚本目录</Button><Label>运行方式<NativeSelect aria-label="运行方式" value={executionMode} onChange={event => setExecutionMode(event.target.value as typeof executionMode)}><option value="from-start-validation">从起点验证（新页面）</option><option value="current-page-test">当前页面试跑（保留现场）</option></NativeSelect></Label><Label>输入 JSON<Textarea className="code-input" rows={7} value={inputJson} onChange={event => setInputJson(event.target.value)} spellCheck={false} /></Label><Label>固定任务资料<NativeSelect aria-label="固定任务资料版本" value={materialRevisionId} onChange={event => setMaterialRevisionId(event.target.value)}><option value="">旧流程试跑（无固定资料）</option>{items(revisionPage).filter((entry: any) => entry.status === 'available').map((entry: any) => <option key={entry.revisionId} value={entry.revisionId}>{entry.revisionId.slice(0, 16)} · {entry.contentHash.slice(0, 12)}</option>)}</NativeSelect></Label>{revisionPage.nextCursor && <Button onClick={() => perform(async () => { const page = await window.studio.call('materialRevisions', { projectId, cursor: revisionPage.nextCursor, limit: 50, maxBytes: 24576 }); setRevisionPage((current: any) => ({ ...page, items: [...items(current), ...items(page)] })); })}>更多资料版本</Button>}<Button variant="default" className="primary full" disabled={!!validationDisabledReason} title={validationDisabledReason || undefined} onClick={() => perform(async () => { const input = JSON.parse(inputJson); const result = await call('validate', { projectId: validationProjectId, profileId: validationProfileId, input, executionMode, startUrl: executionMode==='from-start-validation'?url:undefined, pageId: selectedPage?.pageId, generation: selectedPage?.generation, ...(selectedMaterialRevision ? { materialRevisionId: selectedMaterialRevision.revisionId, materialContentHash: selectedMaterialRevision.contentHash } : {}) }, '已提交受控执行，执行结果与验收分开记录。'); setValidation(result); if (selectedMaterialRevision) openFixedResults(result.executionId || result.id); })}>运行脚本并验收</Button>
<Button className="full" disabled={!!validationDisabledReason || !active || active.controller !== 'human' || active.locked} onClick={() => perform(() => call('authorizeValidationStart', { runId: active.id, projectId: active.projectId, profileId: active.profileId, leaseEpoch: active.leaseEpoch, input: JSON.parse(inputJson) }, '已允许 Agent 在两分钟内启动一次当前脚本和输入。'))}>允许 Agent 启动一次</Button>
{active?.validationStartGrant && <div className="form-stack"><p className="hint" role="status">已授权 {active.validationStartGrant.workflowId}，有效至 {time(active.validationStartGrant.expiresAt)}。仅允许按授权时的输入启动一次；启动前仍由你操作。</p><Button className="full" disabled={!!busy} onClick={() => perform(() => call('revokeValidationStart', { runId: active.id, leaseEpoch: active.leaseEpoch }, '已撤销这次启动授权。'))}>撤销启动授权</Button></div>}
<p className="hint">{active ? '一次授权有效两分钟，绑定当前页面、脚本版本和输入。切换页面、修改脚本或输入后需重新授权。' : '开始一次录制后，可授权 Agent 从当前页面启动。'}</p><p className="hint">{validationDisabledReason || '按所选项目和登录环境创建验收记录；已有示范会自动封存；起点采用地址栏 URL。'}</p></div>} second={<div className="pane-scroll form-stack"><div className="execution-actions"><Badge value={active?.execution || 'ready'} /><Button disabled={stopping || (!active && !state.validationStarting)} className="danger-quiet" onClick={() => perform(stopExecution)}>停止并接管</Button></div><Button className="full" disabled={!active || !!busy} onClick={() => perform(() => call('saveProfile', {}, '已刷新可持久化浏览器数据并登记登录环境；未承诺完整状态快照。'))}>保存当前登录环境</Button>{activeValidation && <div className="validation-result"><div className="section-label">本次执行</div><div className="execution-actions"><Badge value={activeValidation.status} /><Badge value={activeValidation.validation?.overall || 'not-run'} /></div><Button className="full" onClick={() => perform(() => openValidation(activeValidation.id))}>查看需求、数据与验收</Button></div>}<p className="hint">未覆盖、证据不足、机器失败与人工判定分别保存。修改脚本后须重新运行。</p></div>} />}
      {panel === 'archives' && <div className="pane-scroll"><div className="panel-heading"><h2>运行存档</h2><p className="muted">当前已加载范围 · {runs.length} 次运行</p></div><div className="run-list">{runs.map((run: any) => <Button key={run.id} className={`run-item ${run.id === active?.id ? 'current' : ''}`} onClick={() => run.status === 'unreadable' ? openRecovery(run.id) : perform(() => openHistory(run.id))}><span className={`run-dot ${run.status}`} /><span>{run.kind === 'validate' ? '脚本验收' : '人工示范'}<small>{run.createdAt ? new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : run.id.slice(0, 12)}</small></span><small>{run.status === 'unreadable' ? '暂不可读' : label(run.status)}</small></Button>)}</div>{recoveryRuns.length > 0 && <div className="recovery-run-list"><div className="sidebar-title section-space">需要检查的存档 <span>{recoveryRuns.length}</span></div>{recoveryRuns.map((run: any) => <Button key={run.id} className="recovery-run" data-run-id={run.id} onClick={() => openRecovery(run.id)}><strong>{run.id.slice(0, 12)}</strong><small>{run.projectId ? projects.find(project => project.id === run.projectId)?.name || '项目暂不可读' : '项目身份尚未读出'} · 检查恢复状态</small></Button>)}</div>}{!runs.length && <div className="empty">当前项目没有运行存档。</div>}</div>}
      </div></Tabs>
      <div className="evidence-strip"><div><span>{active ? `Run ${active.id.slice(0, 12)} · ${workspaceCheckpoints.length} 个已加载 checkpoint` : '连续录制与保存点分别记录'}</span></div><Button disabled={!workspaceRunId} onClick={() => perform(() => openHistory(workspaceRunId))}>打开证据时间线</Button><Button disabled={!workspaceRunId || !projectId} onClick={() => perform(() => openRecordingReplay(workspaceRunId))}>打开历史回放</Button></div>

    </aside>} second={<section className="browser-workspace">{!replayRecordingId && <form className="addressbar" onSubmit={event => { event.preventDefault(); if (liveSession) perform(() => call('navigate', { url })); }}><span className="address-prefix">URL</span><Input ref={addressInput} aria-label="浏览器地址" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" /><Button disabled={!liveSession || !!busy || liveSession.controller === 'agent' || liveSession.locked}>前往</Button><Button type="button" className="quiet" disabled={!!busy} onClick={() => perform(synthetic)}>合成站点</Button></form>}
        {!replayRecordingId && <div className="browser-tabs"><Button disabled={!liveSession || !!busy || liveSession.locked || liveSession.controller !== 'human'} onClick={() => perform(() => call('navigateHistory', { direction: 'back' }))}>后退</Button><Button disabled={!liveSession || !!busy || liveSession.locked || liveSession.controller !== 'human'} onClick={() => perform(() => call('navigateHistory', { direction: 'forward' }))}>前进</Button><Button disabled={!liveSession || !!busy || liveSession.locked || liveSession.controller !== 'human'} onClick={() => perform(() => call('navigateHistory', { direction: 'reload' }))}>刷新</Button>{pages.length ? pages.map((page: any) => <Button key={page.pageId} title={page.url} className={page.pageId === selectedPage?.pageId ? 'selected' : ''} onClick={() => perform(() => call('selectPage', { pageId: page.pageId }))}>{short(page.title || page.url || '业务页面', 30)}<small>{page.openerPageId ? '弹窗' : '页面'}</small></Button>) : <span className="muted">受管理的业务浏览器</span>}<div className="topbar-spacer" />{active && <Badge value={active.controller} />}</div>}
        {replayRecordingId && <ReplayWorkspace projectId={projectId} recordingId={replayRecordingId} requestedPosition={requestedReplayPosition} selecting={selectingHistory} canStop={!!active || !!state.validationStarting} onPosition={receiveReplayPosition} onTarget={receiveHistoricalTarget} onCancelSelection={cancelHistoricalSelection} onStop={() => perform(stopExecution)} onClose={closeReplayWorkspace} />}
        <div className={`native-browser ${!liveSession && !replayRecordingId ? 'inactive' : ''}`} ref={browserBox}>{!liveSession && !replayRecordingId && <div className="browser-empty"><p>选择项目和登录环境后开始录制</p><span className="muted">浏览器页面将在此处显示</span></div>}</div>
{!replayRecordingId && <div className="browser-toolbar">{liveSession && !active && <><span>实时页面 · 未录制</span><Button disabled={!!busy} onClick={() => perform(() => call('closeSession', {}, '已关闭浏览器会话。'))}>关闭浏览器会话</Button></>}<Button disabled={!selectedPage || !!busy || liveSession?.locked || liveSession?.controller !== 'human'} onClick={() => perform(() => call('closePage', { pageId: selectedPage?.pageId }))}>关闭当前页</Button><Button disabled={!active || !!busy || active.controller !== 'human'} onClick={() => perform(() => call('pauseOperations', { paused: !active?.locked }))}>{active?.locked ? '恢复人工输入' : '暂停页面输入'}</Button><Button disabled={!active || !!busy} onClick={() => perform(() => call('pauseCapture', { paused: active?.capture !== 'paused' }))}>{active?.capture === 'paused' ? '恢复录制' : '暂停录制'}</Button><Button disabled={!active || !!busy || ['running', 'waiting-human', 'finalizing'].includes(active.execution)} onClick={() => perform(() => call('control', { controller: active?.controller === 'agent' ? 'human' : 'agent' }, active?.controller === 'agent' ? '已收回人工控制。' : '已授予 Agent 控制；人工输入已锁定。'))}>{active?.controller === 'agent' ? '收回人工控制' : '交给 Agent 控制'}</Button><div className="topbar-spacer" /></div>}
        </section>} /></main>
    <footer className="statusbar"><span role="status">{busy ? '正在处理：' + busy : notice || '就绪'}{active ? ' · ' + label(active.controller) : ''}</span><span>录制完成 ≠ 需求通过</span></footer>
    {(error || preferenceError) && <Alert variant="destructive" className="workspace-error"><AlertDescription><strong>操作未完成</strong><span>{error || preferenceError}</span><Button variant="ghost" onClick={() => {setError('');clearPreferenceError();}}>关闭</Button></AlertDescription></Alert>}
    <Dialog open={!!overlay} onOpenChange={open => { if (!open) closeOverlay(); }}><DialogContent className={'overlay-panel ' + (['setup','recovery','project','profile'].includes(overlay || '') ? 'narrow' : '')} showCloseButton={false}>
      <div className="overlay-heading"><DialogTitle>{overlay === 'evidence' ? '证据与验收存档' : overlay === 'results' ? '固定版本结果中心' : overlay === 'recovery' ? '检查与恢复存档' : overlay === 'project' ? '新建项目' : overlay === 'profile' ? '添加登录环境' : '连接与已验证环境'}</DialogTitle><Button onClick={closeOverlay}>返回工作台</Button></div>
      {error && <Alert variant="destructive"><AlertDescription>{error}<Button variant="ghost" onClick={() => setError('')}>关闭错误</Button></AlertDescription></Alert>}
      <DialogDescription className="sr-only">{overlay === 'project' ? '设置项目名称与业务目标' : overlay === 'profile' ? '创建按项目隔离的命名登录环境' : '读取本地存档、连接信息或已保存材料'}</DialogDescription>
      {overlay === 'project' && <form className="overlay-body form-stack" onSubmit={event => {event.preventDefault();perform(async () => {const result = await call('createProject', {name:newProject,objective});setProjectId(result.id || result.project?.id);setNewProject('');setObjective('');setOverlay(null);});}}><Label>项目名称<Input autoFocus value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="例如：订单采集验收" /></Label><Label>业务目标<Textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="要取得什么数据，如何判断完成" rows={3} /></Label><Button variant="default" type="submit" className="primary" disabled={!!active || !newProject.trim() || !!busy}>创建项目</Button></form>}
      {overlay === 'profile' && <form className="overlay-body form-stack" onSubmit={event => {event.preventDefault();perform(async () => {const result = await call('createProfile', {projectId,name:newProfile});setProfileId(result.id || result.profile?.id);setNewProfile('');setOverlay(null);});}}><Label>环境名称<Input autoFocus aria-label="新环境名称" value={newProfile} onChange={event => setNewProfile(event.target.value)} placeholder="新环境名称" /></Label><p className="hint">按项目隔离。创建后在实际页面验证登录。</p><Button variant="default" type="submit" className="primary" disabled={!projectId || !newProfile.trim() || !!busy}>添加</Button></form>}
            {overlay === 'recovery' && <RunRecoveryView key={recoveryRunId} runId={recoveryRunId} active={!!active} onRecovered={refresh} onOpen={() => openHistory(recoveryRunId)} />}
      {overlay === 'setup' && <div className="overlay-body"><p>Agent 使用单一本机 HTTP 接口；可信工作台使用窄 IPC。连接文件只供本机当前用户读取。</p><Label>连接文件<code className="block-code">{state.connection?.file || '启动后生成'}</code></Label><Label>地址<code className="block-code">{state.connection?.address || '尚未准备'}</code></Label><h3>运行版本</h3><JsonView value={state.versions || {}} /><p className="hint">连接 token 是本机管理凭据，不复制到网页或项目源码。</p></div>}
      {overlay === 'results' && fixedExecutionId && <div className="overlay-body"><ResultCenter key={fixedExecutionId} projectId={projectId} executionId={fixedExecutionId} /></div>}
      {overlay === 'evidence' && <Tabs className="archive-layout" value={historyTab} onValueChange={value => {++artifactRequest.current;setHistoryTab(value);setArtifact(null);}}><div className="archive-meta"><code>{historyRunId}</code><span>有界读取；缺失、截断与真实空值分开</span></div><TabsList className="archive-tabs">{[['checkpoints', 'Checkpoint'], ['events', '时间线'], ['gaps', '缺口'], ['summary', '运行摘要'], ['validation', '结构化数据 / 验收']].map(([key, title]) => <TabsTrigger key={key} value={key} className={historyTab === key ? 'selected' : ''}>{title}</TabsTrigger>)}</TabsList><div className="overlay-body archive-body">
        {history?.error && <p className="error-inline" role="alert">已有证据暂时无法读取：{history.error}。不能将读取失败当作没有证据。</p>}
        {historyTab === 'checkpoints' && <SplitPane name="evidence" label="调整保存点列表与材料宽度" initial={24} minFirst="180px" minSecond="320px" first={<div className="checkpoint-archive-list">{checkpoints.map((checkpoint: any) => <Button className={selectedCheckpoint?.id === checkpoint.id ? 'selected' : ''} key={checkpoint.id} onClick={() => { ++artifactRequest.current; setSelectedCheckpoint(checkpoint); setArtifact(null); }}><strong>{checkpoint.title || checkpoint.key}</strong><small>{time(checkpoint.savedAt)} · {checkpoint.key}</small></Button>)}{!checkpoints.length && <div className="empty">当前已加载范围没有 checkpoint。</div>}</div>} second={<div className="checkpoint-detail">{selectedCheckpoint ? <><div className="detail-title"><h3>{selectedCheckpoint.title || selectedCheckpoint.key}</h3><Badge value={selectedCheckpoint.captureConsistency} /><Badge value={selectedCheckpoint.metadata?.captureStatus || 'unknown'} /></div><p>{selectedCheckpoint.description || '没有补充说明'}</p><dl className="metadata"><dt>需求</dt><dd>{selectedCheckpoint.requirementIds?.join(', ') || '未绑定'}</dd><dt>采集范围</dt><dd>{time(selectedCheckpoint.captureStartedAt)} — {time(selectedCheckpoint.captureEndedAt)}</dd><dt>页面代际</dt><dd>{selectedCheckpoint.navigationGeneration ?? '未知'}</dd></dl><div className="artifact-actions">{selectedCheckpoint.artifactRefs?.map((id: string, index: number) => { const meta = items(selectedCheckpoint.metadata?.artifacts).find((entry: any) => entry.id === id); return <Button key={id} onClick={() => perform(() => openArtifact(id))}>{meta?.kind || `读取材料 ${index + 1}`}</Button>; })}</div></> : <div className="empty">选择一个保存点查看描述、来源和材料。</div>}{artifact && <ArtifactView value={artifact} onRead={(id, options) => perform(() => openArtifact(id, options))} />}</div>} />}
        {historyTab === 'events' && <><div className="timeline-controls"><Label>从 checkpoint<NativeSelect value={rangeStart} onChange={event => changeEventRange('start', event.target.value)}><option value="">运行开始</option>{checkpoints.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.title || entry.key}</option>)}</NativeSelect></Label><Label>到 checkpoint<NativeSelect value={rangeEnd} onChange={event => changeEventRange('end', event.target.value)}><option value="">当前末尾</option>{checkpoints.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.title || entry.key}</option>)}</NativeSelect></Label><Button disabled={!!busy} onClick={() => perform(() => queryEvents())}>读取范围</Button>{history?.events?.nextCursor && <Button disabled={!!busy} onClick={() => perform(() => queryEvents(history.events.nextCursor))}>下一页</Button>}</div><p className="muted">事件按时间关联，相关不等于因果。当前展示有界范围。</p><div className="timeline">{items(history?.events).map((event: any) => <div className="timeline-event" key={event.id}><time>{time(event.occurredAt)}</time><div><strong>{event.type}</strong><small>{event.pageId || '运行级'} · {typeof event.source === 'string' ? event.source : short(event.source, 80)}</small><pre>{short(event.data || event, 850)}</pre>{event.artifactRefs?.map((id: string) => <Button key={id} onClick={() => perform(() => openArtifact(id))}>按需读取正文</Button>)}</div></div>)}</div>{history?.events?.outputTruncated && <p className="notice">当前响应达到读取预算。完整证据仍保存在原件中，可通过 API 游标继续读取。</p>}{artifact && <ArtifactView value={artifact} onRead={(id, options) => perform(() => openArtifact(id, options))} />}</>}
        {historyTab === 'gaps' && (items(history?.gaps).length ? <JsonView value={items(history.gaps)} /> : <div className="empty">当前已加载范围没有缺口记录。此结果不自动证明所有网页能力均受支持。</div>)}
        {historyTab === 'summary' && <JsonView value={history?.summary || {}} />}
        {historyTab === 'validation' && <div className="validation-archive"><div className="validation-list">{items(state.validations).filter((record: any) => record.runId === historyRunId).map((record: any) => <Button key={record.id} onClick={() => perform(() => openValidation(record.id))}><span>{record.id.slice(0, 8)}</span><Badge value={record.status} /><Badge value={record.validation?.overall || 'not-run'} /></Button>)}</div>{validation?.runId === historyRunId ? validation.result ? <ValidationView key={validation.id} record={validation} checkpoints={checkpoints} checkpointCursor={history?.checkpoints?.nextCursor} historyError={history?.error} runs={items(state.runs)} onReview={body => call('review', body, '人工判定已追加保存；机器原结论保持不变。')} /> : <InterruptedValidationView record={validation} checkpoints={checkpoints} historyError={history?.error} active={!!active} onCheckpoints={() => setHistoryTab('checkpoints')} onRetry={() => prepareRetry(validation)} /> : <div className="empty">选择一次执行以读取需求、结构化数据和实际版本验收。</div>}</div>}
      </div></Tabs>}

    </DialogContent></Dialog>
  </div></BrowserPresentation>;
}
