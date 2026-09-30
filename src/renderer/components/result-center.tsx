import { useWorkbenchClient, scopedWorkbenchCall } from '../lib/workbench-client';
import { electronResultClient, scopedResultCall, type ResultWorkbenchClient, type NativeResultCall } from '../lib/result-workbench-client';
import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import type { DatasetIdentity } from '@/contracts/execution';
import type { ValidatedRequirement } from '@/validator/types';
import { sameReplayPosition, type HistoricalTarget, type ReplayPosition } from '@/contracts/recording';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { JsonView } from './evidence-view';
import { StatusBadge } from './status-badge';

type Page<T> = { items: T[]; nextCursor?: string; outputTruncated?: boolean };
type Dataset = { executionId: string; attemptId: string; datasetId: string; status: string; committedBatches: number; committedRecords: number; diagnostic?: { code: string; message: string } };
type Batch = { batchId: string; contentHash: string; recordCount: number; durableAt: string };
type Step = { identity: { stepId: string; attemptId: string; entityKey?: string }; state: string; error?: { message: string }; diagnostics?: unknown };
type Assessment = { reportId: string; overall?: string; coverage?: string; reasons?: string[] };
type SavedReport = Assessment & { contentHash?: string };
const empty = <T,>(): Page<T> => ({ items: [] });
export interface ResultSourceLocation { position: ReplayPosition; target?: HistoricalTarget; label: string; detail: string }
const valueText = (value: unknown) => value === undefined ? '未取得' : JSON.stringify(value);
const coverageText = (value: ValidatedRequirement['businessCoverage']) => value === 'source-proven' ? '来源分页与输出实体集合已核对' : value === 'configured-count-and-uniqueness' ? '配置的条数与去重检查通过；自然语言业务全量仍需范围依据' : '业务范围尚缺证明；批次完整不代表全部业务数据';

/** Reads C's actual attempts and F's fixed report through E's bounded facade. */
type ResultCenterProps = { projectId: string; executionId: string; onOpenSource?(location: ResultSourceLocation): void; client?: ResultWorkbenchClient; readable?: boolean };
export function ResultCenter(props: ResultCenterProps) {
  return props.client ? <ResultCenterView {...props} client={props.client}/> : <ElectronResultCenter {...props}/>;
}
function ElectronResultCenter(props: ResultCenterProps) {
  const native = useWorkbenchClient();
  const client = useMemo(() => electronResultClient(native), [native]);
  const nativeCall = useMemo(() => scopedWorkbenchCall(native, { projectId: props.projectId, executionId: props.executionId }), [native, props.projectId, props.executionId]);
  return <ResultCenterView {...props} client={client} nativeCall={nativeCall}/>;
}
function ResultCenterView({ projectId, executionId, onOpenSource, client, nativeCall, readable = true }: ResultCenterProps & { client: ResultWorkbenchClient; nativeCall?: NativeResultCall }) {
  const [execution, setExecution] = useState<any>(null);
  const [steps, setSteps] = useState<Page<Step>>(empty);
  const [datasets, setDatasets] = useState<Page<Dataset>>(empty);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [activeDataset, setActiveDataset] = useState<Dataset | null>(null);
  const [batches, setBatches] = useState<Page<Batch>>(empty);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [records, setRecords] = useState<Page<any>>(empty);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [assessedSelection, setAssessedSelection] = useState('');
  const [report, setReport] = useState<any>(null);
  const [savedReports, setSavedReports] = useState<Page<SavedReport>>(empty);
  const [requirements, setRequirements] = useState<Page<ValidatedRequirement>>(empty);
  const [reportDatasets, setReportDatasets] = useState<Page<any>>(empty);
  const [reviewId, setReviewId] = useState('');
  const [decision, setDecision] = useState<'accept' | 'reject' | 'exception'>('accept');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadedScope, setLoadedScope] = useState('');
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const dataRequest = useRef(0);
  const recordRequest = useRef(0);
  const reportRequest = useRef(0);
  const reviewRequest = useRef(0);
  const scope = `${projectId}/${executionId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const datasetRef = useRef('');
  const batchRef = useRef('');
  const reportRef = useRef('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const current = (expectedScope: string) => scopeRef.current === expectedScope;
  const call = useMemo(() => scopedResultCall(client, projectId, executionId), [client, projectId, executionId]);
  const readItems = useCallback(async <C extends 'steps' | 'datasets',>(collection: C, cursor?: string) =>
    call('executionItems', { collection, limit: 30, maxBytes: 24576, ...(cursor ? { cursor } : {}) }), [call]);
  useEffect(() => {
    if (!readable || !client.canRead()) return;
    const token = ++request.current;
    ++dataRequest.current; ++recordRequest.current; ++reportRequest.current; ++reviewRequest.current;
    datasetRef.current = ''; batchRef.current = ''; reportRef.current = '';
    setLoadedScope(''); setExecution(null); setSteps(empty()); setDatasets(empty()); setSelected({});
    setActiveDataset(null); setBatches(empty()); setBatch(null); setRecords(empty());
    setAssessment(null); setAssessedSelection(''); setReport(null); setSavedReports(empty()); setRequirements(empty()); setReportDatasets(empty()); setError(''); setNotice(''); setPending('');
    void Promise.all([call('execution'), readItems('steps'), readItems('datasets'), call('executionReports', { limit: 20, maxBytes: 24576 })]).then(([head, stepPage, datasetPage, saved]) => {
      if (token !== request.current || !current(scope)) return;
      setExecution(head); setSteps(stepPage); setDatasets(datasetPage); setSavedReports(saved); setLoadedScope(scope);
    }).catch(failure => { if (token === request.current && current(scope)) { setError(String(failure)); setLoadedScope(scope); } });
    return () => { ++request.current; ++dataRequest.current; ++recordRequest.current; ++reportRequest.current; ++reviewRequest.current; };
  }, [call, readItems, readable, retry]);
  useEffect(() => {
    if (!readable || !client.canRead() || !execution || !['starting', 'running', 'waiting-human'].includes(execution.status)) return;
    let cancelled = false;
    const token = request.current;
    const timer = setInterval(() => {
      void Promise.all([call('execution'), readItems('steps'), readItems('datasets')]).then(([head, stepPage, datasetPage]) => {
        if (cancelled || token !== request.current || !current(scope)) return;
        setExecution(head); setSteps(stepPage); setDatasets(datasetPage);
      }).catch(failure => { if (!cancelled && token === request.current && current(scope)) setError(String(failure)); });
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [execution?.status, call, readItems, readable]);
  const readReport = async (id: string, token: number) => {
    const [head, reqs, data] = await Promise.all([
      call('executionReport', { reportId: id }),
      call('executionReportItems', { reportId: id, collection: 'requirements', limit: 20, maxBytes: 24576 }),
      call('executionReportItems', { reportId: id, collection: 'datasets', limit: 30, maxBytes: 24576 }),
    ]);
    if (current(scope) && token === reportRequest.current && reportRef.current === id) { setReport(head); setRequirements(reqs); setReportDatasets(data); }
  };
  const assess = async () => {
    if (!nativeCall) return;
    const token = ++reportRequest.current;
    const selection = JSON.stringify(selectedRef.current);
    setPending('固定资料验收'); setError('');
    try {
      const identities: DatasetIdentity[] = Object.entries(selectedRef.current).map(([datasetId, attemptId]) => ({ executionId, datasetId, attemptId }));
      const next: Assessment = await nativeCall('assessExecution', { datasetIdentities: identities });
      if (!current(scope) || token !== reportRequest.current || selection !== JSON.stringify(selectedRef.current)) return;
      reportRef.current = next.reportId; setAssessment(next); setAssessedSelection(selection); setReport(null); setRequirements(empty()); setReportDatasets(empty());
      await readReport(next.reportId, token);
      const saved = await call('executionReports', { limit: 20, maxBytes: 24576 });
      if (current(scope) && token === reportRequest.current) setSavedReports(saved);
    } catch (failure) { if (current(scope) && token === reportRequest.current) setError(String(failure)); }
    finally { if (current(scope) && token === reportRequest.current) setPending(''); }
  };
  const openSavedReport = async (id: string) => {
    const token = ++reportRequest.current;
    reportRef.current = id; setReport(null); setRequirements(empty()); setReportDatasets(empty()); setError('');
    setAssessment({ reportId: id }); setAssessedSelection(JSON.stringify(selectedRef.current));
    try { await readReport(id, token); }
    catch (failure) { if (current(scope) && token === reportRequest.current && reportRef.current === id) setError(String(failure)); }
  };
  const moreSavedReports = async (cursor: string) => {
    const token = request.current;
    try { const page: Page<SavedReport> = await call('executionReports', { cursor, limit: 20, maxBytes: 24576 });
      if (current(scope) && token === request.current) setSavedReports(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous); }
    catch (failure) { if (current(scope) && token === request.current) setError(String(failure)); }
  };
  const openDataset = async (item: Dataset) => {
    const token = ++dataRequest.current;
    ++recordRequest.current;
    const identity = `${item.executionId}/${item.attemptId}/${item.datasetId}`;
    datasetRef.current = identity; batchRef.current = '';
    setActiveDataset(item); setBatch(null); setRecords(empty()); setError('');
    setBatches(empty());
    try { const page = await call('datasetBatches', { attemptId: item.attemptId, datasetId: item.datasetId, maxBytes: 24576, limit: 30 });
      if (current(scope) && token === dataRequest.current && datasetRef.current === identity) setBatches(page); }
    catch (failure) { if (current(scope) && token === dataRequest.current) setError(String(failure)); }
  };
  const openBatch = async (item: Batch) => {
    if (!activeDataset) return;
    const token = ++recordRequest.current;
    const identity = datasetRef.current, selectedBatch = item.batchId;
    batchRef.current = selectedBatch;
    setBatch(item); setRecords(empty()); setError('');
    try { const page = await call('datasetRecords', { attemptId: activeDataset.attemptId, datasetId: activeDataset.datasetId, batchId: item.batchId, maxBytes: 24576, limit: 30 });
      if (current(scope) && token === recordRequest.current && datasetRef.current === identity && batchRef.current === selectedBatch) setRecords(page); }
    catch (failure) { if (current(scope) && token === recordRequest.current && datasetRef.current === identity) setError(String(failure)); }
  };
  const review = async () => {
    if (!nativeCall || !assessment || assessedSelection !== JSON.stringify(selectedRef.current) || !reason.trim() || !reviewId) return;
    const token = ++reviewRequest.current, reportId = assessment.reportId;
    setPending('保存人工判定'); setError('');
    try { await nativeCall('reviewExecution', { reportId, requirementId: reviewId, decision, reason: reason.trim() });
      if (current(scope) && token === reviewRequest.current && reportRef.current === reportId) { setNotice('人工判定已追加保存；机器报告未改变。重新验收可读取新判定。'); setReason(''); } }
    catch (failure) { if (current(scope) && token === reviewRequest.current) setError(String(failure)); }
    finally { if (current(scope) && token === reviewRequest.current) setPending(''); }
  };
  const selectDatasetAttempt = (item: Dataset) => {
    ++reportRequest.current; ++reviewRequest.current; reportRef.current = '';
    setAssessment(null); setAssessedSelection(''); setReport(null); setRequirements(empty()); setReportDatasets(empty()); setPending('');
    setSelected(value => ({ ...value, [item.datasetId]: item.attemptId }));
  };
  const moreExecutionItems = async (collection: 'steps' | 'datasets', cursor: string) => {
    const token = request.current;
    try {
      if (collection === 'steps') {
        const page = await readItems('steps', cursor);
        if (current(scope) && token === request.current) setSteps(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      } else {
        const page = await readItems('datasets', cursor);
        if (current(scope) && token === request.current) setDatasets(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      }
    } catch (failure) { if (current(scope) && token === request.current) setError(String(failure)); }
  };
  const moreBatches = async (cursor: string) => {
    const dataset = activeDataset, identity = datasetRef.current, token = dataRequest.current;
    if (!dataset) return;
    try { const page: Page<Batch> = await call('datasetBatches', { attemptId: dataset.attemptId, datasetId: dataset.datasetId, cursor, maxBytes: 24576, limit: 30 });
      if (current(scope) && token === dataRequest.current && datasetRef.current === identity) setBatches(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous); }
    catch (failure) { if (current(scope) && token === dataRequest.current && datasetRef.current === identity) setError(String(failure)); }
  };
  const moreRecords = async (cursor: string) => {
    const dataset = activeDataset, selectedBatch = batch?.batchId, identity = datasetRef.current, token = recordRequest.current;
    if (!dataset || !selectedBatch) return;
    try { const page: Page<any> = await call('datasetRecords', { attemptId: dataset.attemptId, datasetId: dataset.datasetId, batchId: selectedBatch, cursor, maxBytes: 24576, limit: 30 });
      if (current(scope) && token === recordRequest.current && datasetRef.current === identity && batchRef.current === selectedBatch) setRecords(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous); }
    catch (failure) { if (current(scope) && token === recordRequest.current && datasetRef.current === identity && batchRef.current === selectedBatch) setError(String(failure)); }
  };
  const moreReport = async (collection: 'requirements' | 'datasets', cursor: string) => {
    const reportId = reportRef.current, token = reportRequest.current;
    if (!reportId) return;
    try {
      if (collection === 'requirements') {
        const page = await call('executionReportItems', { reportId, collection, cursor, limit: 20, maxBytes: 24576 });
        if (!current(scope) || token !== reportRequest.current || reportRef.current !== reportId) return;
        setRequirements(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      } else {
        const page = await call('executionReportItems', { reportId, collection, cursor, limit: 30, maxBytes: 24576 });
        if (!current(scope) || token !== reportRequest.current || reportRef.current !== reportId) return;
        setReportDatasets(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      }
    } catch (failure) { if (current(scope) && token === reportRequest.current && reportRef.current === reportId) setError(String(failure)); }
  };
  const openSource = async (location: ResultSourceLocation) => {
    if (!nativeCall) return;
    const id = reportRef.current;
    try {
      if (location.target?.kind === 'dom-node') {
        const node = await nativeCall('historicalNode', { target: location.target, maxBytes: 16384, limit: 1 });
        if (!current(scope) || reportRef.current !== id) return;
        if (!node?.ref || node.ref.nodeId !== location.target.nodeId || node.ref.frameId !== location.target.frameId || node.ref.mirrorScopeId !== location.target.mirrorScopeId || !sameReplayPosition(node.ref.position, location.target.position)) throw new Error('历史节点身份不一致；未跳转。');
      }
      if (current(scope) && reportRef.current === id) onOpenSource?.(location);
    } catch (failure) { if (current(scope) && reportRef.current === id) setError(`来源定位失败：${String(failure)}。原报告仍保留，可检查存档或重新准备来源。`); }
  };
  if (loadedScope !== scope) return <div className="result-center" role="status">{readable ? '正在读取执行身份与已保存结果…' : '连接恢复前已暂停结果读取，请先恢复授权连接。'}</div>;
  return <div className="result-center">
    <div className="detail-title"><h3>执行结果中心</h3><code>{executionId}</code></div>
    {!nativeCall && <p className="hint">只读查看已保存执行、批次与报告；此页不启动执行、不生成验收报告或保存人工判定。来源引用保留；已授权项目回放的连接可在资料工作区查看离线 DOM 并查验节点。</p>}
    {error && <p className="error-inline" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {!execution ? <div><p>执行身份或结果读取失败，未将它当作空执行。</p><Button disabled={!readable || !client.canRead()} onClick={() => setRetry(value => value + 1)}>重新读取执行结果</Button></div> : <>
      <div className="result-summary"><div><span>执行</span><StatusBadge value={execution.status} /></div><div><span>资料版本</span><code>{execution.binding?.materialRevisionId || '未绑定'}</code></div>
        <div><span>代码 / 输入</span><code>{execution.binding?.codeFingerprint?.slice(0, 12) || '—'} / {execution.binding?.inputFingerprint?.slice(0, 12) || '—'}</code></div>
        <div><span>快照校验</span><StatusBadge value={execution.snapshotVerified ? 'pass' : 'inconclusive'} /></div><div><span>工作流 attempt</span><code>{execution.workflowAttemptId || '未形成'}</code></div></div>
      {execution.datasetCatalogIssues?.map((issue: { entry: string; code: string; message: string }, index: number) =>
        <p className="error-inline" key={`${issue.entry}-${index}`}>数据目录 {issue.entry}：{issue.code} · {issue.message}</p>)}
      <section><h3>步骤与部分失败</h3><p className="hint">每个步骤保持原 attempt 身份；失败、blocked 和已提交数据分别显示。</p>
        {steps.items.map((item, index) => <div className="result-row" key={`${item.identity?.attemptId}-${item.identity?.stepId}-${index}`}><strong>{item.identity?.stepId || '步骤'}</strong><span>{item.identity?.entityKey || ''}</span><StatusBadge value={item.state} /><small>{item.error?.message || ''}</small></div>)}
        {steps.nextCursor && <Button onClick={() => void moreExecutionItems('steps', steps.nextCursor!)}>后续步骤</Button>}
      </section><section><h3>数据集与实际 attempt</h3><p className="hint">{nativeCall ? '每个数据集明确选择一个 attempt 进入验收；保留失败 attempt 的已提交批次。' : '按实际 attempt 只读查看已提交批次；失败 attempt 的已提交数据仍保留。'}</p>
        {datasets.items.map(item => <div className="result-row" key={`${item.datasetId}-${item.attemptId}`}><strong>{item.datasetId}</strong><span>{item.attemptId.slice(0, 14)} · {item.committedRecords} 条 / {item.committedBatches} 批</span><StatusBadge value={item.status} />
          {item.diagnostic && <small>{item.diagnostic.code} · {item.diagnostic.message}</small>}
          <Button disabled={!!item.diagnostic} onClick={() => void openDataset(item)}>查看数据</Button>{nativeCall && <Button disabled={!!item.diagnostic} className={selected[item.datasetId] === item.attemptId ? 'selected' : ''} onClick={() => selectDatasetAttempt(item)}>用于验收</Button>}</div>)}
        {datasets.nextCursor && <Button onClick={() => void moreExecutionItems('datasets', datasets.nextCursor!)}>后续数据集</Button>}
        {activeDataset && <div className="result-data"><h4>{activeDataset.datasetId} · {activeDataset.attemptId}</h4><p className="hint">原件按批次有界读取；真实 null 与缺失字段在记录中分别标识。</p>
          {batches.items.map(item => <Button key={item.batchId} className={batch?.batchId === item.batchId ? 'selected' : ''} onClick={() => void openBatch(item)}>{item.batchId.slice(0, 15)} · {item.recordCount} 条 · {item.contentHash.slice(0, 10)}</Button>)}
          {batches.nextCursor && <Button onClick={() => void moreBatches(batches.nextCursor!)}>后续批次</Button>}
          {batch && <><JsonView value={records.items} />{records.nextCursor && <Button onClick={() => void moreRecords(records.nextCursor!)}>后续记录</Button>}</>}
        </div>}
      </section><section><div className="detail-title"><h3>固定资料验收</h3>{nativeCall && <Button disabled={!!pending || !execution.workflowAttemptId} onClick={() => void assess()}>{pending || '按所选 attempt 验收'}</Button>}</div>
        <p className="hint">机器总评只汇总已配置检查。格式、来源内容、脚本声明、人工判定和版本分别记录；批次提交完整不能证明自然语言“全部订单”。候选资料版本不表示人已批准。</p>
        <div className="result-data"><h4>已保存报告</h4>{savedReports.items.map(item => <Button key={item.reportId} className={reportRef.current === item.reportId ? 'selected' : ''} onClick={() => void openSavedReport(item.reportId)}>{item.reportId.slice(0, 16)} · {item.overall || '待读取'}</Button>)}
          {savedReports.nextCursor && <Button onClick={() => void moreSavedReports(savedReports.nextCursor!)}>后续报告</Button>}</div>
        {assessment && <p>报告 <code>{assessment.reportId}</code></p>}
        {report && <><div className="result-summary"><div><span>已配置检查总评</span><StatusBadge value={report.overall} /></div><div><span>批次与分页检查</span><StatusBadge value={report.coverage} /></div><div><span>资料</span>{report.materialStatus || 'candidate'}</div><div><span>版本</span><StatusBadge value={report.version?.verdict || 'inconclusive'} /></div></div>
          {report.reasons?.map((reason: string, index: number) => <p key={index} className="notice">{reason}</p>)}
          <div className="result-requirements">{requirements.items.map(item => <article key={item.requirementId} className="requirement-report"><div className="detail-title"><h3>{item.materialContext?.description || item.requirementId}</h3><StatusBadge value={item.verdict} /></div>
            <p className="hint">固定需求 {item.requirementId} · {coverageText(item.businessCoverage)}</p>
            {!item.materialContext&&<p className="hint">旧报告未保存需求定位摘要；可在本实例的运行控制界面按本次固定执行重新验收追加新报告，旧报告保持不变。</p>}
            <div className="result-summary"><div><span>批次与分页检查</span>{item.coverage}</div><div><span>格式</span><StatusBadge value={item.schemaVerdict} /></div><div><span>来源</span><StatusBadge value={item.sourceVerdict} /></div><div><span>人工</span>{item.humanReviews?.length || 0} 条</div></div>
            {item.materialContext?.fields.map(field => <div key={field.id}><strong>{field.name}</strong>{field.example ? <Button disabled={!onOpenSource} onClick={() => void openSource({ position:field.example!.anchor,...(field.target?{target:field.target}:{}),label:`需求示例 · ${field.name} · ${field.example!.title}`,detail:`固定版本 ${report.binding?.materialRevisionId || execution.binding?.materialRevisionId}；${field.example!.notes}。此例证说明含义，不是每次运行的预期常量。` })}>需求示例：{field.example.title}</Button> : <span> · 固定资料未绑定保存点示例</span>}{!nativeCall && field.example && <small> 来源录制 {field.example.anchor.recordingId} · 文档 {field.example.anchor.documentId} · 事件 #{field.example.anchor.eventSeq}；查看来源需本连接的历史回放授权</small>}</div>)}
            {item.fieldDiagnostics?.map((detail,index) => <div className="result-check" key={index}><strong>{item.materialContext?.fields.find(field=>field.id===detail.fieldId)?.name || detail.fieldId}</strong> · 实体 {valueText(detail.entity)}<br/>
              {detail.code==='value-mismatch'||detail.code==='value-match' ? <>原文 {valueText(detail.rawText)} → 按 {detail.interpretation==='plain-decimal-v1'?'纯十进制 v1':'精确文本'} 应得 {valueText(detail.expected)}；实际 {valueText(detail.actual)}。</> : <>{detail.reason} 实际 {valueText(detail.actual)}；{detail.code==='source-insufficient'?'请补齐本次来源后重新执行，当前没有可确认的期望值。':'请检查实现映射与输出类型。'}</>}
              {detail.target&&detail.sourceRef&&<Button disabled={!onOpenSource} onClick={()=>void openSource({position:detail.target!.position,target:detail.target,label:`本次验证来源 · ${detail.entity} · ${detail.sourceRef}`,detail:`${detail.interpretation}：原文 ${valueText(detail.rawText)}，应得 ${valueText(detail.expected)}，实际 ${valueText(detail.actual)}；${detail.identity.datasetId} / ${detail.identity.attemptId} / ${detail.batchId} / 记录 ${detail.recordIndex} / ${detail.outputPath}`})}>本次验证来源</Button>}
              <details><summary>诊断身份与规则</summary><JsonView value={detail}/></details></div>)}
            {item.diagnosticsTruncated&&<p className="notice">行诊断达到显示预算；判定仍检查所有已读取记录。请按数据集和批次读取后续记录。</p>}
            {item.checks?.map((check, index) => <p key={index} className="result-check"><StatusBadge value={check.verdict} /> {check.name}：{check.reason}</p>)}
            <details><summary>来源与脚本声明</summary><JsonView value={{ evidence: item.evidence, scriptAssertions: item.scriptAssertions, humanReviews: item.humanReviews }} /></details>
          </article>)}{requirements.nextCursor && <Button onClick={() => void moreReport('requirements', requirements.nextCursor!)}>后续需求</Button>}</div>
          <details><summary>数据集验收摘要</summary><JsonView value={reportDatasets.items} />{reportDatasets.nextCursor && <Button onClick={() => void moreReport('datasets', reportDatasets.nextCursor!)}>后续摘要</Button>}</details>
          {nativeCall && <div className="human-review"><h3>人工判定</h3><p className="hint">判定追加到固定执行、资料版本和 attempt；不能覆盖机器失败。</p>
            <div className="review-inputs"><label>需求<NativeSelect value={reviewId} onChange={event => setReviewId(event.target.value)}><option value="">选择需求</option>{requirements.items.map(item => <option key={item.requirementId} value={item.requirementId}>{item.requirementId}</option>)}</NativeSelect></label>
              <label>判断<NativeSelect value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="accept">接受</option><option value="reject">拒绝</option><option value="exception">例外接受</option></NativeSelect></label></div>
            <label>理由<Textarea value={reason} onChange={event => setReason(event.target.value)} /></label><Button disabled={!reviewId || !reason.trim() || !!pending} onClick={() => void review()}>保存人工判定</Button></div>}
        </>}
      </section>
    </>}
  </div>;
}
