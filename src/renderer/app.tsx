import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';

declare global { interface Window { studio: { call(method: string, body?: unknown): Promise<any>; bounds(rect: unknown): void } } }
const labels: Record<string, string> = { recording: '正在记录', starting: '准备采集', paused: '已暂停', degraded: '采集降级', stopped: '已停止', sealed: '已封存', human: '人工控制', agent: '自动化控制', none: '输入已锁定', ready: '就绪', running: '执行中', 'waiting-human': '等待人工', completed: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '异常中断', complete: '完整', empty: '真实空值', missing: '缺失', truncated: '已截断', 'read-failed': '读取失败', excluded: '未采集', consistent: '同一导航代际', mixed: '跨越导航', unknown: '未知', pass: '通过', fail: '不通过', inconclusive: '证据不足', 'not-run': '未覆盖' };
const label = (value: unknown) => labels[String(value)] || String(value ?? '—');
const items = (value: any): any[] => Array.isArray(value) ? value : value?.items || [];
const short = (value: unknown, length = 90) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text?.length > length ? `${text.slice(0, length)}…` : text ?? '—'; };
const time = (value: string | undefined) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
function Badge({ value, text }: { value: unknown; text?: string }) { return <span className={`badge ${String(value)}`}>{text || label(value)}</span>; }
function JsonView({ value }: { value: any }) {
  if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object') {
    const keys = [...new Set(value.slice(0, 20).flatMap(row => Object.keys(row || {})))].slice(0, 9);
    return <div className="data-table-wrap"><table className="data-table"><thead><tr>{keys.map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{value.slice(0, 30).map((row, index) => <tr key={index}>{keys.map(key => <td key={key} title={short(row?.[key], 300)}>{short(row?.[key], 80)}</td>)}</tr>)}</tbody></table>{value.length > 30 && <p className="muted">当前展示前 30 条，共 {value.length} 条。</p>}</div>;
  }
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
function Replay({ events, warning }: { events: any[]; warning?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const player = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!root.current || events.length < 2) return;
    try { player.current = new Replayer(events, { root: root.current, showWarning: false, mouseTail: false, UNSAFE_replayCanvas: false }); }
    catch (failure) { setError(String(failure)); }
    return () => { player.current?.destroy?.(); player.current = null; };
  }, [events]);
  return <><div className="replay-toolbar"><button disabled={events.length < 2} onClick={() => { player.current?.play(); setPlaying(true); }}>播放</button><button onClick={() => { player.current?.pause(); setPlaying(false); }}>暂停</button><Badge value={playing ? 'running' : 'paused'} /><span className="muted">{events.length} 条 rrweb 事件；回放不能证明业务结果</span></div>{warning && <p className="notice">{warning}</p>}{error && <p className="error-inline">{error}</p>}{events.length < 2 ? <div className="empty">当前范围没有可播放的完整 rrweb 起始快照。</div> : <div className="replay-stage" ref={root} />}</>;
}

export function App() {
  const [state, setState] = useState<any>({ projects: [], profiles: [], runs: [] });
  const [projectId, setProjectId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [url, setUrl] = useState('about:blank');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [panel, setPanel] = useState('checkpoints');
  const [overlay, setOverlay] = useState<string | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [historyRunId, setHistoryRunId] = useState('');
  const [artifact, setArtifact] = useState<any>(null);
  const [replay, setReplay] = useState<any>(null);
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
  const [inspecting, setInspecting] = useState(false);
  const [historyTab, setHistoryTab] = useState('checkpoints');
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<any>(null);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const browserBox = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const active = state.active;
  const projects = items(state.projects);
  const profiles = items(state.profiles).filter((profile: any) => !projectId || profile.projectId === projectId);
  const runs = items(state.runs).filter((run: any) => !projectId || run.projectId === projectId);
  const project = projects.find((entry: any) => entry.id === projectId);
  const checkpoints = items(history?.checkpoints);
  const pages = items(active?.pages);
  const selectedPage = pages.find((page: any) => page.pageId === active?.selectedPageId) || pages[0];
  const activeValidation = items(state.validations).find((record: any) => record.runId === active?.id);
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
  const perform = (action: () => Promise<any>) => { void action().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); };
  const loadHistory = useCallback(async (id: string) => { const result = await window.studio.call('history', { runId: id }); setHistory(result); setHistoryRunId(id); return result; }, []);
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); const timer = setInterval(() => void refresh().catch(failure => setError(String(failure))), 2000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!projectId && projects.length) setProjectId(projects[0].id); }, [projects, projectId]);
  useEffect(() => { if (active?.projectId && active.projectId !== projectId) setProjectId(active.projectId); }, [active?.projectId, projectId]);
  useEffect(() => { setScriptDirectory(project?.scriptDirectory || ''); }, [project?.id, project?.scriptDirectory]);
  useEffect(() => { if (!profiles.some((entry: any) => entry.id === profileId)) setProfileId(profiles[0]?.id || ''); }, [profiles, profileId]);
  useEffect(() => { if (selectedPage?.url && document.activeElement !== addressInput.current) setUrl(selectedPage.url); }, [selectedPage?.url]);
  useEffect(() => { if (!active && state.fixtureUrl && url === 'about:blank') { setUrl(state.fixtureUrl); setInputJson(JSON.stringify({ baseUrl: state.fixtureUrl }, null, 2)); } }, [state.fixtureUrl, active, url]);
  useEffect(() => { if (active?.id) { void loadHistory(active.id).catch(() => undefined); const timer = setInterval(() => { if (!overlay) void loadHistory(active.id).catch(() => undefined); }, 6000); return () => clearInterval(timer); } }, [active?.id, loadHistory, overlay]);
  useEffect(() => {
    const report = () => { const rect = browserBox.current?.getBoundingClientRect(); if (rect) window.studio.bounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }); };
    const observer = new ResizeObserver(report); if (browserBox.current) observer.observe(browserBox.current); window.addEventListener('resize', report); report();
    return () => { observer.disconnect(); window.removeEventListener('resize', report); };
  }, [active?.id, panel]);
  useEffect(() => { void window.studio.call('showBrowser', { visible: !overlay }).catch(failure => setError(String(failure))); }, [overlay]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  const openHistory = async (runId: string) => { await loadHistory(runId); setArtifact(null); setSelectedCheckpoint(null); setHistoryTab('checkpoints'); setOverlay('evidence'); };
  const openArtifact = async (id: string, options: any = {}) => { const result = await call('artifact', { runId: historyRunId || active?.id, id, ...options }); setArtifact(result); };
  const openValidation = async (id: string) => { const record = await call('validation', { id }); await loadHistory(record.runId); setValidation(record); setHistoryTab('validation'); setOverlay('evidence'); };
  const queryEvents = async (cursor?: string) => {
    const from = checkpoints.find((entry: any) => entry.id === rangeStart);
    const to = checkpoints.find((entry: any) => entry.id === rangeEnd);
    const page = await call('events', { runId: historyRunId, fromSequence: from?.sequence, toSequence: to?.sequence, cursor, limit: 50, maxBytes: 16000 });
    setHistory((current: any) => ({ ...current, events: page }));
  };
  const synthetic = async () => { const result = await call('syntheticSite'); const address = result.url || state.fixtureUrl; setUrl(address); setInputJson(JSON.stringify({ baseUrl: address }, null, 2)); if (active) await call('navigate', { url: address }); };
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
  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark">BE</div><div className="brand"><strong>Browser Evidence Studio</strong><span>浏览器证据工作台</span></div><div className="topbar-spacer" /><span className="local-label"><i /> 本机工作区</span><button className="quiet" onClick={() => setOverlay('setup')}>连接与环境</button></header>
    <div className="workspace"><aside className="sidebar"><div className="sidebar-title">项目空间 <span>{projects.length}</span></div><div className="project-list">{projects.map((entry: any) => <button key={entry.id} className={`project-item ${entry.id === projectId ? 'selected' : ''}`} disabled={!!active && active.projectId !== entry.id} onClick={() => { setProjectId(entry.id); setScriptDirectory(entry.scriptDirectory || ''); }}><span className="project-symbol">{entry.name?.slice(0, 1) || 'P'}</span><span>{entry.name}<small>{entry.objective || '尚未填写目标'}</small></span></button>)}</div>
      <details className="sidebar-form" open={!projects.length}><summary>新建项目</summary><label>项目名称<input value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="例如：订单采集验收" /></label><label>业务目标<textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="要取得什么数据，如何判断完成" rows={2} /></label><button disabled={!!active || !newProject.trim() || !!busy} onClick={() => perform(async () => { const result = await call('createProject', { name: newProject, objective }); setProjectId(result.id || result.project?.id); setNewProject(''); setObjective(''); })}>创建项目</button></details>
      <div className="sidebar-title section-space">命名登录环境</div><select aria-label="登录环境" value={profileId} onChange={event => setProfileId(event.target.value)} disabled={!!active}>{profiles.length ? profiles.map((profile: any) => <option key={profile.id} value={profile.id}>{profile.name}</option>) : <option value="">先创建环境</option>}</select><div className="inline-form"><input aria-label="新环境名称" value={newProfile} onChange={event => setNewProfile(event.target.value)} placeholder="新环境名称" /><button disabled={!projectId || !newProfile.trim() || !!busy} onClick={() => perform(async () => { const result = await call('createProfile', { projectId, name: newProfile }); setProfileId(result.id || result.profile?.id); setNewProfile(''); })}>添加</button></div><p className="sidebar-hint">按项目隔离；保存环境后仍需在实际页面验证登录。</p>
      <div className="sidebar-title section-space">运行存档 <span>{runs.length}</span></div><div className="run-list">{runs.slice(0, 15).map((run: any) => <button key={run.id} className={`run-item ${run.id === active?.id ? 'current' : ''}`} onClick={() => perform(() => openHistory(run.id))}><span className={`run-dot ${run.status}`} /><span>{run.kind === 'validate' ? '脚本验收' : '人工示范'}<small>{new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span><small>{label(run.status)}</small></button>)}</div><div className="sidebar-bottom">原件追加保存 · 索引可重建<br />本地账号状态不进入代码仓库</div></aside>
    <main className="main-workspace"><div className="workspace-heading"><div><p className="eyebrow">DEMONSTRATE / VERIFY</p><h1>{project?.name || '开始一个可验证的浏览器流程'}</h1><p>{project?.objective || '创建项目、演示流程，再用普通 Puppeteer 脚本复跑并逐项验收。'}</p></div><div className="heading-actions">{active ? <><Badge value={active.capture} /><button disabled={!!busy} onClick={() => perform(async () => { await call('seal', {}, '运行已封存，材料可从左侧存档重新打开。'); if (active.id) await loadHistory(active.id); })}>结束并封存</button></> : <button className="primary" disabled={!projectId || !profileId || !!busy} onClick={() => perform(() => call('startRun', { projectId, profileId, url, kind: 'demonstrate' }, '录制已启动，证据采集准备完成。'))}>开始录制</button>}</div></div>
      {error && <div className="banner error" role="alert"><strong>操作未完成</strong><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}{notice && <div className="banner success" role="status">{notice}</div>}
      {active?.handoff?.status === 'waiting' && <div className="handoff-banner"><div><strong>等待你完成页面操作</strong><p>{active.handoff.instructions || '完成页面要求后，明确交还控制。'}</p><small>等待与超时不表示成功；交还后会验证实际页面状态。</small></div><button className="primary" disabled={!!busy} onClick={() => perform(() => call('releaseHuman', {}, '已提交交还请求；按真实完成条件判断。'))}>交还控制</button></div>}
      {active?.handoff?.status === 'needs-attention' && <div className="banner error"><strong>人工协助未完成</strong><span>超时、取消或连接结束后，没有推断操作成功。当前材料仍保留，请停止后重新开始明确的尝试。</span></div>}
      <div className="workbench"><section className="browser-workspace"><form className="addressbar" onSubmit={event => { event.preventDefault(); if (active) perform(() => call('navigate', { url })); }}><span className="address-prefix">URL</span><input ref={addressInput} aria-label="浏览器地址" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" /><button disabled={!active || !!busy || active.controller === 'agent'}>前往</button><button type="button" className="quiet" disabled={!!busy} onClick={() => perform(synthetic)}>合成站点</button></form>
        <div className="browser-tabs">{pages.length ? pages.map((page: any) => <button key={page.pageId} title={page.url} className={page.pageId === selectedPage?.pageId ? 'selected' : ''} onClick={() => perform(() => call('selectPage', { pageId: page.pageId }))}>{short(page.title || page.url || '业务页面', 30)}<small>{page.openerPageId ? '弹窗' : '页面'}</small></button>) : <span className="muted">受管理的业务浏览器</span>}<div className="topbar-spacer" />{active && <Badge value={active.controller} />}</div>
        <div className={`native-browser ${!active ? 'inactive' : ''}`} ref={browserBox}>{!active && <div className="browser-empty"><div className="empty-symbol">BE</div><h2>让每一次操作，都有可回看的依据</h2><p>选择项目和命名环境，输入地址后开始录制。<br />保存 checkpoint 记录关键结果；原始演示不等于需求通过。</p><div className="steps"><span><b>01</b> 人工示范</span><span><b>02</b> 原生脚本</span><span><b>03</b> 逐项验收</span></div></div>}</div>
        <div className="browser-toolbar"><button disabled={!active || !!busy || active.controller !== 'human'} className={inspecting ? 'active' : ''} onClick={() => perform(async () => { await call('inspect', { enabled: !inspecting }); setInspecting(!inspecting); setPanel('selection'); })}>{inspecting ? '退出元素检查' : '检查并标记元素'}</button><button disabled={!active || !!busy || active.controller !== 'human'} onClick={() => perform(() => call('pauseOperations', { paused: !active?.locked }))}>{active?.locked ? '恢复人工输入' : '暂停页面输入'}</button><button disabled={!active || !!busy} onClick={() => perform(() => call('pauseCapture', { paused: active?.capture !== 'paused' }))}>{active?.capture === 'paused' ? '恢复录制' : '暂停录制'}</button><button disabled={!active || !!busy || ['running', 'waiting-human', 'finalizing'].includes(active.execution)} onClick={() => perform(() => call('control', { controller: active?.controller === 'agent' ? 'human' : 'agent' }, active?.controller === 'agent' ? '已收回人工控制。' : '已授予 Agent 控制；人工输入已锁定。'))}>{active?.controller === 'agent' ? '收回人工控制' : '交给 Agent 控制'}</button><div className="topbar-spacer" /><span className="muted">蒙版只阻止输入，网页脚本继续运行</span></div>
        <div className="evidence-strip"><div><span className="recording-dot" /><strong>{active ? '连续证据' : '工作区就绪'}</strong><span>{active ? `Run ${active.id.slice(0, 12)} · ${checkpoints.length} 个已加载 checkpoint` : '动作、网络、DOM 与截图分别保留来源'}</span></div><button disabled={!active && !historyRunId} onClick={() => perform(() => openHistory(active?.id || historyRunId))}>打开证据时间线</button><button disabled={!active && !historyRunId} onClick={() => perform(async () => { const result = await call('replay', { runId: active?.id || historyRunId, pageId: selectedPage?.pageId }); setReplay(result); setOverlay('replay'); })}>DOM 回放</button></div>
      </section><aside className="inspector"><div className="panel-tabs">{[['checkpoints', '保存点'], ['selection', '元素'], ['validation', '执行 / 验收']].map(([key, name]) => <button key={key} className={panel === key ? 'selected' : ''} onClick={() => setPanel(key)}>{name}</button>)}</div><div className="panel-content">
        {panel === 'checkpoints' && <><div className="panel-heading"><p className="eyebrow">CHECKPOINT</p><h2>保存关键结果</h2><p>描述需要什么结果，帮助复跑按相同需求验收。</p></div><label>标题<input value={checkpointTitle} onChange={event => setCheckpointTitle(event.target.value)} placeholder="例如：订单已加载到最后一页" /></label><label>结果与范围<textarea rows={3} value={checkpointDescription} onChange={event => setCheckpointDescription(event.target.value)} placeholder="数据范围、关键字段、页面含义与未确认项" /></label><details className="advanced"><summary>稳定标识与需求对应</summary><label>Checkpoint key<input value={checkpointKey} onChange={event => setCheckpointKey(event.target.value)} placeholder="orders-complete" /></label><label>需求 ID（空格或逗号分隔）<input value={requirementIds} onChange={event => setRequirementIds(event.target.value)} placeholder="orders-complete" /></label></details><button className="primary full" disabled={!active || !!busy || !!active.checkpoint || active.controller === 'agent'} onClick={() => perform(saveCheckpoint)}>{busy === 'checkpoint' ? active?.checkpoint?.phase === 'saving' ? '正在持久化已获取材料…' : '正在采集（最长 10 秒）…' : '保存 checkpoint'}</button>{active?.checkpoint && <div className="checkpoint-progress"><p role="status">{active.checkpoint.phase === 'saving' ? '采集已结束，正在完成证据写入。' : active.checkpoint.phase === 'draining' ? '正在等待操作连接停止写入…' : '正在获取截图和 DOM，可取消并保留已取得材料。'}</p>{active.checkpoint.phase !== 'saving' && <button disabled={cancellingCheckpoint} onClick={() => perform(cancelCheckpoint)}>{cancellingCheckpoint ? '正在取消…' : '取消采集'}</button>}</div>}<p className="hint">短暂锁定输入，保存截图、DOM 和采集时间范围。部分失败也会保留成功材料。</p><div className="section-label">已保存 <span>{checkpoints.length}</span></div>{checkpoints.length ? [...checkpoints].reverse().map((checkpoint: any, index: number) => <button className="checkpoint-card" key={checkpoint.id} onClick={() => perform(async () => { await openHistory(active?.id || historyRunId); setSelectedCheckpoint(checkpoint); })}><span className="checkpoint-number">{String(checkpoints.length - index).padStart(2, '0')}</span><span><strong>{checkpoint.title || checkpoint.key}</strong><small>{time(checkpoint.savedAt)} · {label(checkpoint.captureConsistency)} · {label(checkpoint.metadata?.captureStatus || 'unknown')}</small><p>{short(checkpoint.description || '没有补充说明', 80)}</p></span></button>) : <div className="empty compact">尚未保存关键结果。<br />{active ? '连续录制独立进行，可随时保存关键结果。' : '开始录制后可保存关键结果。'}</div>}</>}
        {panel === 'selection' && <><div className="panel-heading"><p className="eyebrow">ELEMENT EVIDENCE</p><h2>检查与定位记录</h2><p>检查模式下点击只选中元素，不执行网站动作。</p></div><button className="primary full" disabled={!active || !!busy} onClick={() => perform(async () => { await call('inspect', { enabled: !inspecting }); setInspecting(!inspecting); })}>{inspecting ? '结束检查模式' : '进入元素检查'}</button>{active?.selection ? <><div className="selection-header"><Badge value="complete" text="已记录元素" /></div><JsonView value={active.selection} /></> : <div className="empty compact">进入元素检查后，在业务页面选择元素。<br />保存文本、角色、候选定位器及 frame 来源。</div>}<p className="hint">定位记录不依赖易失效坐标。首版不修改、隐藏或删除业务页面元素。</p></>}
        {panel === 'validation' && <><div className="panel-heading"><p className="eyebrow">NATIVE PUPPETEER</p><h2>受控复跑</h2><p>执行已登记目录里的普通脚本，绑定实际代码、配置与依赖版本。</p></div><label>脚本目录<input value={scriptDirectory} onChange={event => setScriptDirectory(event.target.value)} placeholder="包含 workflow.json 的绝对目录" /></label><button className="full" disabled={!projectId || !scriptDirectory.trim() || !!busy} onClick={() => perform(() => call('updateProject', { projectId, scriptDirectory }, '已登记此项目的脚本目录，Agent 可执行这里的 workflow.json。'))}>登记脚本目录</button><label>输入 JSON<textarea className="code-input" rows={7} value={inputJson} onChange={event => setInputJson(event.target.value)} spellCheck={false} /></label><button className="primary full" disabled={!!validationDisabledReason} title={validationDisabledReason || undefined} onClick={() => perform(async () => { const input = JSON.parse(inputJson); const result = await call('validate', { projectId: validationProjectId, profileId: validationProfileId, input }, '已提交受控执行，执行结果与验收分开记录。'); setValidation(result); })}>运行脚本并验收</button><p className="hint">{validationDisabledReason || '按所选项目和登录环境创建验收记录；已有示范会自动封存。'}</p><div className="execution-actions"><Badge value={active?.execution || 'ready'} /><button disabled={!active || !!busy} className="danger-quiet" onClick={() => perform(() => call('stopRunner', {}, '自动化已停止；确认静默后可人工接管。'))}>停止并接管</button></div><button className="full" disabled={!active || !!busy} onClick={() => perform(() => call('saveProfile', {}, '已刷新可持久化浏览器数据并登记登录环境；未承诺完整状态快照。'))}>保存当前登录环境</button>{activeValidation && <div className="validation-result"><div className="section-label">本次执行</div><div className="execution-actions"><Badge value={activeValidation.status} /><Badge value={activeValidation.validation?.overall || 'not-run'} /></div><button className="full" onClick={() => perform(() => openValidation(activeValidation.id))}>查看需求、数据与验收</button></div>}<p className="hint">未覆盖、证据不足、机器失败与人工判定分别保存。修改脚本后须重新运行。</p></>}
      </div></aside></div>
    </main></div><footer className="statusbar"><span>{busy ? `正在处理：${busy}` : '本地存储'}{active ? ` · ${label(active.capture)} · ${label(active.controller)}` : ''}</span><span>观察 ≠ 推断 · 录制完成 ≠ 需求通过</span><span>0.1.0</span></footer>
    {overlay && <div className="overlay"><div className={`overlay-panel ${overlay === 'setup' ? 'narrow' : ''}`}><div className="overlay-heading"><div><p className="eyebrow">{overlay === 'evidence' ? 'EVIDENCE ARCHIVE' : overlay === 'replay' ? 'RECORDED DOM' : 'LOCAL CONNECTION'}</p><h2>{overlay === 'evidence' ? '证据与验收存档' : overlay === 'replay' ? 'DOM 基础回放' : '连接与已验证环境'}</h2></div><button onClick={() => { setOverlay(null); setArtifact(null); }}>返回工作台</button></div>
      {overlay === 'setup' && <div className="overlay-body"><p>Agent 使用单一本机 HTTP 接口；可信工作台使用窄 IPC。连接文件只供本机当前用户读取。</p><label>连接文件<code className="block-code">{state.connection?.file || '启动后生成'}</code></label><label>地址<code className="block-code">{state.connection?.address || '尚未准备'}</code></label><h3>运行版本</h3><JsonView value={state.versions || {}} /><p className="hint">连接 token 是本机管理凭据，不复制到网页或项目源码。</p></div>}
      {overlay === 'replay' && <div className="overlay-body"><Replay events={replay?.events || []} warning={replay?.warning} /></div>}
      {overlay === 'evidence' && <><div className="archive-meta"><code>{historyRunId}</code><span>有界读取；缺失、截断与真实空值分开</span></div><div className="archive-tabs">{[['checkpoints', 'Checkpoint'], ['events', '时间线'], ['gaps', '缺口'], ['summary', '运行摘要'], ['validation', '结构化数据 / 验收']].map(([key, title]) => <button key={key} className={historyTab === key ? 'selected' : ''} onClick={() => { setHistoryTab(key); setArtifact(null); }}>{title}</button>)}</div><div className="overlay-body archive-body">
        {historyTab === 'checkpoints' && <div className="checkpoint-archive"><div className="checkpoint-archive-list">{checkpoints.map((checkpoint: any) => <button className={selectedCheckpoint?.id === checkpoint.id ? 'selected' : ''} key={checkpoint.id} onClick={() => { setSelectedCheckpoint(checkpoint); setArtifact(null); }}><strong>{checkpoint.title || checkpoint.key}</strong><small>{time(checkpoint.savedAt)} · {checkpoint.key}</small></button>)}{!checkpoints.length && <div className="empty">当前已加载范围没有 checkpoint。</div>}</div><div className="checkpoint-detail">{selectedCheckpoint ? <><div className="detail-title"><h3>{selectedCheckpoint.title || selectedCheckpoint.key}</h3><Badge value={selectedCheckpoint.captureConsistency} /><Badge value={selectedCheckpoint.metadata?.captureStatus || 'unknown'} /></div><p>{selectedCheckpoint.description || '没有补充说明'}</p><dl className="metadata"><dt>需求</dt><dd>{selectedCheckpoint.requirementIds?.join(', ') || '未绑定'}</dd><dt>采集范围</dt><dd>{time(selectedCheckpoint.captureStartedAt)} — {time(selectedCheckpoint.captureEndedAt)}</dd><dt>页面代际</dt><dd>{selectedCheckpoint.navigationGeneration ?? '未知'}</dd></dl><div className="artifact-actions">{selectedCheckpoint.artifactRefs?.map((id: string, index: number) => { const meta = items(selectedCheckpoint.metadata?.artifacts).find((entry: any) => entry.id === id); return <button key={id} onClick={() => perform(() => openArtifact(id))}>{meta?.kind || `读取材料 ${index + 1}`}</button>; })}</div></> : <div className="empty">选择一个保存点查看描述、来源和材料。</div>}{artifact && <ArtifactView value={artifact} onRead={(id, options) => perform(() => openArtifact(id, options))} />}</div></div>}
        {historyTab === 'events' && <><div className="timeline-controls"><label>从 checkpoint<select value={rangeStart} onChange={event => setRangeStart(event.target.value)}><option value="">运行开始</option>{checkpoints.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.title || entry.key}</option>)}</select></label><label>到 checkpoint<select value={rangeEnd} onChange={event => setRangeEnd(event.target.value)}><option value="">当前末尾</option>{checkpoints.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.title || entry.key}</option>)}</select></label><button disabled={!!busy} onClick={() => perform(() => queryEvents())}>读取范围</button>{history?.events?.nextCursor && <button disabled={!!busy} onClick={() => perform(() => queryEvents(history.events.nextCursor))}>下一页</button>}</div><p className="muted">事件按时间关联，相关不等于因果。当前展示有界范围。</p><div className="timeline">{items(history?.events).map((event: any) => <div className="timeline-event" key={event.id}><time>{time(event.occurredAt)}</time><div><strong>{event.type}</strong><small>{event.pageId || '运行级'} · {typeof event.source === 'string' ? event.source : short(event.source, 80)}</small><pre>{short(event.data || event, 850)}</pre>{event.artifactRefs?.map((id: string) => <button key={id} onClick={() => perform(() => openArtifact(id))}>按需读取正文</button>)}</div></div>)}</div>{history?.events?.outputTruncated && <p className="notice">当前响应达到读取预算。完整证据仍保存在原件中，可通过 API 游标继续读取。</p>}{artifact && <ArtifactView value={artifact} onRead={(id, options) => perform(() => openArtifact(id, options))} />}</>}
        {historyTab === 'gaps' && (items(history?.gaps).length ? <JsonView value={items(history.gaps)} /> : <div className="empty">当前已加载范围没有缺口记录。此结果不自动证明所有网页能力均受支持。</div>)}
        {historyTab === 'summary' && <JsonView value={history?.summary || {}} />}
        {historyTab === 'validation' && <div className="validation-archive"><div className="validation-list">{items(state.validations).filter((record: any) => record.runId === historyRunId).map((record: any) => <button key={record.id} onClick={() => perform(() => openValidation(record.id))}><span>{record.id.slice(0, 8)}</span><Badge value={record.status} /><Badge value={record.validation?.overall || 'not-run'} /></button>)}</div>{validation?.runId === historyRunId && validation?.result ? <ValidationView key={validation.id} record={validation} checkpoints={checkpoints} runs={items(state.runs)} onReview={body => call('review', body, '人工判定已追加保存；机器原结论保持不变。')} /> : <div className="empty">选择一次执行以读取需求、结构化数据和实际版本验收。</div>}</div>}
      </div></>}
    </div></div>}
  </div>;
}
function ArtifactView({ value, onRead }: { value: any; onRead: (id: string, options: any) => void }) {
  const [jsonPath, setJsonPath] = useState('');
  const mediaType = value.mediaType || value.artifact?.mediaType || '';
  const content = Object.hasOwn(value, 'value') ? value.value : value.content ?? value.result ?? value.text ?? value;
  const imageUrl = value.url || value.imageUrl;
  const id = value.artifact?.id || value.id;
  return <section className="artifact-view"><div className="detail-title"><h3>按需读取的材料</h3><Badge value={value.captureStatus || value.artifact?.captureStatus || 'unknown'} /></div>{imageUrl && mediaType.startsWith('image/') ? <img src={imageUrl} alt="已保存 checkpoint 截图" /> : <><div className="artifact-query"><input aria-label="JSON 定向路径" placeholder="JSON 路径，例如 $.records[0].id" value={jsonPath} onChange={event => setJsonPath(event.target.value)} /><button onClick={() => onRead(id, jsonPath ? { jsonPath } : {})}>定向读取</button></div>{typeof content === 'string' ? <pre className="json">{content}</pre> : <JsonView value={content} />}{value.nextCursor && <button onClick={() => onRead(id, { cursor: value.nextCursor, ...(jsonPath ? { jsonPath } : {}) })}>读取下一片</button>}</>}{value.outputTruncated && <p className="notice">达到单次输出预算；通过游标继续读取，未把截断当作完整。</p>}</section>;
}

function ValidationView({ record, onReview, checkpoints, runs }: { record: any; onReview(body: any): Promise<any>; checkpoints: any[]; runs: any[] }) {
  const [verdict, setVerdict] = useState('accept');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('all');
  const [feedback, setFeedback] = useState('');
  const [demoId, setDemoId] = useState('');
  const [demoCheckpoints, setDemoCheckpoints] = useState<any[]>([]);
  const [reviewPage, setReviewPage] = useState<any>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [recentReview, setRecentReview] = useState<any>(null);
  const demoRequest = useRef(0);
  const reviewRequest = useRef(0);
  const demonstrations = runs.filter(run => record.projectId && run.projectId === record.projectId && run.kind === 'demonstrate' && run.id !== record.runId);
  const loadReviews = useCallback(async (cursor?: string) => {
    const request = ++reviewRequest.current;
    setReviewLoading(true); setReviewError('');
    try {
      const page = await window.studio.call('reviews', { id: record.id, limit: 20, maxBytes: 32768, ...(cursor ? { cursor } : {}) });
      if (request === reviewRequest.current) setReviewPage(page);
    } catch (error) { if (request === reviewRequest.current) setReviewError(String(error)); }
    finally { if (request === reviewRequest.current) setReviewLoading(false); }
  }, [record.id]);
  useEffect(() => { void loadReviews(); return () => { reviewRequest.current++; }; }, [loadReviews]);
  useEffect(() => {
    const request = ++demoRequest.current;
    setDemoCheckpoints([]);
    if (demoId && demonstrations.some(run => run.id === demoId)) {
      void window.studio.call('history', { runId: demoId }).then(data => {
        if (request !== demoRequest.current) return;
        if (data.summary?.run?.projectId !== record.projectId || data.summary?.run?.id !== demoId) throw new Error('示范不属于当前验收项目，未加载对照材料。');
        setDemoCheckpoints(items(data.checkpoints));
      }).catch(error => { if (request === demoRequest.current) { setDemoId(''); setFeedback(String(error)); } });
    } else if (demoId) setDemoId('');
    return () => { demoRequest.current++; };
  }, [demoId, record.id, record.projectId]);
  const saveReview = async () => {
    setSavingReview(true); setFeedback('');
    try {
      const saved = await onReview({ id: record.id, verdict, reason, scope });
      setRecentReview(saved); setReason(''); setFeedback('人工判定已追加保存，机器结论未变。');
      await loadReviews();
    } catch (error) { setFeedback(String(error)); }
    finally { setSavingReview(false); }
  };
  const report = record.result;
  const result = report.validation;
  const screenshot = (runId: string, checkpoint: any) => { const metadata = items(checkpoint?.metadata?.artifacts).find((artifact: any) => artifact.kind === 'screenshot' && artifact.captureStatus === 'complete'); return metadata ? `bes-artifact://${runId}/${metadata.id}` : null; };
  return <div className="validation-report"><div className="verdict-summary"><div><span>机器总评</span><Badge value={result.overall} /></div><div><span>需求覆盖</span><Badge value={result.coverageVerdict} /></div><div><span>业务断言</span><Badge value={result.assertionVerdict} /></div><div><span>执行版本</span><Badge value={result.versionVerdict} /></div><div><span>控制流</span><Badge value={result.executionVerdict} /></div></div>
    <p className="muted">当前文件与已运行版本：{record.currentVersion === 'matched' ? '一致' : record.currentVersion === 'needs-revalidation' ? '发生变化，必须重新验证' : '未确认'} · 用时 {Math.round(report.durationMs)} ms</p>{record.currentVersion === 'needs-revalidation' && <p className="notice">历史结果保持原样。当前文件已经变化，历史通过不能应用到当前版本。</p>}{report.error && <p className="error-inline">{report.error}</p>}
    <label>并排查看人工示例<select aria-label="同项目人工示范" value={demoId} onChange={event => { setDemoCheckpoints([]); setDemoId(event.target.value); }}><option value="">选择同项目的一次人工示范</option>{demonstrations.map(run => <option value={run.id} key={run.id}>{run.id.slice(0, 12)} · {time(run.createdAt)}</option>)}</select></label>
    {items(result.requirements).map((requirement: any) => { const actual = checkpoints.find(checkpoint => checkpoint.key === requirement.checkpointKey); const example = demoCheckpoints.find(checkpoint => checkpoint.key === requirement.checkpointKey); const actualImage = screenshot(record.runId, actual); const exampleImage = screenshot(demoId, example); return <section className="requirement-report" key={requirement.id}><div className="detail-title"><h3>{requirement.id}</h3><div><Badge value={requirement.coverageVerdict} /><Badge value={requirement.assertionVerdict} /></div></div><p className="muted">Checkpoint: {requirement.checkpointKey}</p><table className="data-table"><thead><tr><th>检查</th><th>结果</th><th>依据</th></tr></thead><tbody>{requirement.checks.map((check: any, index: number) => <tr key={index}><td>{check.name}</td><td><Badge value={check.verdict} /></td><td>{check.message}</td></tr>)}</tbody></table>{demoId && <div className="comparison"><figure><figcaption>人工示例 · {example?.title || '该 key 没有匹配保存点'}</figcaption>{exampleImage ? <img src={exampleImage} alt="人工示例 checkpoint" /> : <p className="empty compact">没有可用截图</p>}<p>{example?.description}</p></figure><figure><figcaption>受控复跑 · {actual?.title || '该 key 未覆盖'}</figcaption>{actualImage ? <img src={actualImage} alt="复跑 checkpoint" /> : <p className="empty compact">没有可用截图</p>}<p>{actual?.description}</p></figure></div>}</section>; })}
    {items(report.datasets).map((dataset: any) => <section key={dataset.name} className="dataset-report"><h3>结构化数据：{dataset.name}</h3><p className="muted">{dataset.records.length} 条 · 来源 {dataset.origin} · {dataset.sourceRefs.length} 个来源引用 {dataset.pagination && `· ${dataset.pagination.pages} 页，分页终止 ${dataset.pagination.complete ? '已观察' : '未证明'}`}</p><JsonView value={dataset.records} /><details><summary>来源引用</summary><JsonView value={dataset.sourceRefs} /></details></section>)}
    <section className="human-review"><h3>人工判定</h3><p className="hint">独立追加保存，不覆盖机器原始失败。例外接受需明确范围与理由。</p><div className="review-inputs"><label>判定<select value={verdict} onChange={event => setVerdict(event.target.value)}><option value="accept">接受</option><option value="reject">拒绝</option><option value="exception">有条件例外接受</option></select></label><label>范围<input value={scope} onChange={event => setScope(event.target.value)} placeholder="all 或 requirementId" /></label></div><label>理由<textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="对业务含义、差异、覆盖范围的判断" /></label><button className="primary" disabled={!reason.trim() || !scope.trim() || savingReview} onClick={() => void saveReview()}>{savingReview ? '正在保存判定…' : '保存人工判定'}</button>{feedback && <p className="notice">{feedback}</p>}
      <div className="review-history"><div className="detail-title"><h3>已保存的人工判定</h3><button disabled={reviewLoading} onClick={() => void loadReviews()}>从头刷新</button></div><p className="hint">按追加顺序展示，保留每次理由和范围；人工判定不改变上方机器结论。</p>{reviewError && <p className="error-inline" role="alert">{reviewError}</p>}{reviewLoading && <p role="status">正在读取人工判定…</p>}{reviewPage && !items(reviewPage).length && !reviewPage.nextCursor && <p className="empty compact">当前验收尚无人工判定。</p>}{items(reviewPage).map(review => <ReviewEntry key={review.id} review={review} />)}{reviewPage?.nextCursor && <button disabled={reviewLoading} onClick={() => void loadReviews(reviewPage.nextCursor)}>下一页人工判定</button>}{recentReview && !items(reviewPage).some(review => review.id === recentReview.id) && <><h4>刚保存的判定</h4><ReviewEntry review={recentReview} /></>}</div>
    </section>
  </div>;
}

function ReviewEntry({ review }: { review: any }) {
  const reviewLabels: Record<string, string> = { accept: '接受', reject: '拒绝', exception: '有条件例外接受' };
  return <article className="review-entry" data-review-id={review.id}><div className="detail-title"><strong>{reviewLabels[review.verdict] || review.verdict}</strong><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString('zh-CN', { hour12: false })}</time></div><p className="review-scope">范围：{review.scope}</p><p className="review-reason">{review.reason}</p></article>;
}
