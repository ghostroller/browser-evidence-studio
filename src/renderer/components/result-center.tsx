import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DatasetIdentity } from '@/contracts/execution';
import type { ValidatedRequirement } from '@/validator/types';
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

/** Reads C's actual attempts and F's fixed report through E's bounded facade. */
export function ResultCenter({ projectId, executionId }: { projectId: string; executionId: string }) {
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
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, executionId, ...body }), [projectId, executionId]);
  const readItems = useCallback(async <T,>(collection: 'steps' | 'datasets', cursor?: string): Promise<Page<T>> =>
    call('executionItems', { collection, limit: 30, maxBytes: 24576, ...(cursor ? { cursor } : {}) }), [call]);
  useEffect(() => {
    const token = ++request.current;
    ++dataRequest.current; ++recordRequest.current; ++reportRequest.current; ++reviewRequest.current;
    datasetRef.current = ''; batchRef.current = ''; reportRef.current = '';
    setLoadedScope(''); setExecution(null); setSteps(empty()); setDatasets(empty()); setSelected({});
    setActiveDataset(null); setBatches(empty()); setBatch(null); setRecords(empty());
    setAssessment(null); setAssessedSelection(''); setReport(null); setSavedReports(empty()); setRequirements(empty()); setReportDatasets(empty()); setError(''); setNotice(''); setPending('');
    void Promise.all([call('execution'), readItems<Step>('steps'), readItems<Dataset>('datasets'), call('executionReports', { limit: 20, maxBytes: 24576 })]).then(([head, stepPage, datasetPage, saved]) => {
      if (token !== request.current || !current(scope)) return;
      setExecution(head); setSteps(stepPage); setDatasets(datasetPage); setSavedReports(saved); setLoadedScope(scope);
    }).catch(failure => { if (token === request.current && current(scope)) { setError(String(failure)); setLoadedScope(scope); } });
    return () => { ++request.current; ++dataRequest.current; ++recordRequest.current; ++reportRequest.current; ++reviewRequest.current; };
  }, [call, readItems]);
  useEffect(() => {
    if (!execution || !['starting', 'running', 'waiting-human'].includes(execution.status)) return;
    let cancelled = false;
    const token = request.current;
    const timer = setInterval(() => {
      void Promise.all([call('execution'), readItems<Step>('steps'), readItems<Dataset>('datasets')]).then(([head, stepPage, datasetPage]) => {
        if (cancelled || token !== request.current || !current(scope)) return;
        setExecution(head); setSteps(stepPage); setDatasets(datasetPage);
      }).catch(failure => { if (!cancelled && token === request.current && current(scope)) setError(String(failure)); });
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [execution?.status, call, readItems]);
  const readReport = async (id: string, token: number) => {
    const [head, reqs, data] = await Promise.all([
      call('executionReport', { reportId: id }),
      call('executionReportItems', { reportId: id, collection: 'requirements', limit: 20, maxBytes: 24576 }),
      call('executionReportItems', { reportId: id, collection: 'datasets', limit: 30, maxBytes: 24576 }),
    ]);
    if (current(scope) && token === reportRequest.current && reportRef.current === id) { setReport(head); setRequirements(reqs); setReportDatasets(data); }
  };
  const assess = async () => {
    const token = ++reportRequest.current;
    const selection = JSON.stringify(selectedRef.current);
    setPending('固定资料验收'); setError('');
    try {
      const identities: DatasetIdentity[] = Object.entries(selectedRef.current).map(([datasetId, attemptId]) => ({ executionId, datasetId, attemptId }));
      const next: Assessment = await call('assessExecution', { datasetIdentities: identities });
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
    if (!assessment || assessedSelection !== JSON.stringify(selectedRef.current) || !reason.trim() || !reviewId) return;
    const token = ++reviewRequest.current, reportId = assessment.reportId;
    setPending('保存人工判定'); setError('');
    try { await call('reviewExecution', { reportId, requirementId: reviewId, decision, reason: reason.trim() });
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
        const page = await readItems<Step>('steps', cursor);
        if (current(scope) && token === request.current) setSteps(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      } else {
        const page = await readItems<Dataset>('datasets', cursor);
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
    try { const page = await call('executionReportItems', { reportId, collection, cursor, limit: collection === 'requirements' ? 20 : 30, maxBytes: 24576 });
      if (!current(scope) || token !== reportRequest.current || reportRef.current !== reportId) return;
      if (collection === 'requirements') setRequirements(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
      else setReportDatasets(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
    } catch (failure) { if (current(scope) && token === reportRequest.current && reportRef.current === reportId) setError(String(failure)); }
  };
  if (loadedScope !== scope) return <div className="result-center" role="status">正在读取执行身份与已保存结果…</div>;
  return <div className="result-center">
    <div className="detail-title"><h3>执行结果中心</h3><code>{executionId}</code></div>
    {error && <p className="error-inline" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {!execution ? <p role="status">正在读取实际执行身份…</p> : <>
      <div className="result-summary"><div><span>执行</span><StatusBadge value={execution.status} /></div><div><span>资料版本</span><code>{execution.binding?.materialRevisionId || '未绑定'}</code></div>
        <div><span>代码 / 输入</span><code>{execution.binding?.codeFingerprint?.slice(0, 12) || '—'} / {execution.binding?.inputFingerprint?.slice(0, 12) || '—'}</code></div>
        <div><span>快照校验</span><StatusBadge value={execution.snapshotVerified ? 'pass' : 'inconclusive'} /></div><div><span>工作流 attempt</span><code>{execution.workflowAttemptId || '未形成'}</code></div></div>
      {execution.datasetCatalogIssues?.map((issue: { entry: string; code: string; message: string }, index: number) =>
        <p className="error-inline" key={`${issue.entry}-${index}`}>数据目录 {issue.entry}：{issue.code} · {issue.message}</p>)}
      <section><h3>步骤与部分失败</h3><p className="hint">每个步骤保持原 attempt 身份；失败、blocked 和已提交数据分别显示。</p>
        {steps.items.map((item, index) => <div className="result-row" key={`${item.identity?.attemptId}-${item.identity?.stepId}-${index}`}><strong>{item.identity?.stepId || '步骤'}</strong><span>{item.identity?.entityKey || ''}</span><StatusBadge value={item.state} /><small>{item.error?.message || ''}</small></div>)}
        {steps.nextCursor && <Button onClick={() => void moreExecutionItems('steps', steps.nextCursor!)}>后续步骤</Button>}
      </section><section><h3>数据集与实际 attempt</h3><p className="hint">每个数据集明确选择一个 attempt 进入验收；保留失败 attempt 的已提交批次。</p>
        {datasets.items.map(item => <div className="result-row" key={`${item.datasetId}-${item.attemptId}`}><strong>{item.datasetId}</strong><span>{item.attemptId.slice(0, 14)} · {item.committedRecords} 条 / {item.committedBatches} 批</span><StatusBadge value={item.status} />
          {item.diagnostic && <small>{item.diagnostic.code} · {item.diagnostic.message}</small>}
          <Button disabled={!!item.diagnostic} onClick={() => void openDataset(item)}>查看数据</Button><Button disabled={!!item.diagnostic} className={selected[item.datasetId] === item.attemptId ? 'selected' : ''} onClick={() => selectDatasetAttempt(item)}>用于验收</Button></div>)}
        {datasets.nextCursor && <Button onClick={() => void moreExecutionItems('datasets', datasets.nextCursor!)}>后续数据集</Button>}
        {activeDataset && <div className="result-data"><h4>{activeDataset.datasetId} · {activeDataset.attemptId}</h4><p className="hint">原件按批次有界读取；真实 null 与缺失字段在记录中分别标识。</p>
          {batches.items.map(item => <Button key={item.batchId} className={batch?.batchId === item.batchId ? 'selected' : ''} onClick={() => void openBatch(item)}>{item.batchId.slice(0, 15)} · {item.recordCount} 条 · {item.contentHash.slice(0, 10)}</Button>)}
          {batches.nextCursor && <Button onClick={() => void moreBatches(batches.nextCursor!)}>后续批次</Button>}
          {batch && <><JsonView value={records.items} />{records.nextCursor && <Button onClick={() => void moreRecords(records.nextCursor!)}>后续记录</Button>}</>}
        </div>}
      </section><section><div className="detail-title"><h3>固定资料验收</h3><Button disabled={!!pending || !execution.workflowAttemptId} onClick={() => void assess()}>{pending || '按所选 attempt 验收'}</Button></div>
        <p className="hint">机器判断区分格式、来源内容、脚本声明、人工判定和版本。候选资料版本不表示人已批准。</p>
        <div className="result-data"><h4>已保存报告</h4>{savedReports.items.map(item => <Button key={item.reportId} className={reportRef.current === item.reportId ? 'selected' : ''} onClick={() => void openSavedReport(item.reportId)}>{item.reportId.slice(0, 16)} · {item.overall || '待读取'}</Button>)}
          {savedReports.nextCursor && <Button onClick={() => void moreSavedReports(savedReports.nextCursor!)}>后续报告</Button>}</div>
        {assessment && <p>报告 <code>{assessment.reportId}</code></p>}
        {report && <><div className="result-summary"><div><span>机器总评</span><StatusBadge value={report.overall} /></div><div><span>覆盖</span><StatusBadge value={report.coverage} /></div><div><span>资料</span>{report.materialStatus || 'candidate'}</div><div><span>版本</span><StatusBadge value={report.version?.verdict || 'inconclusive'} /></div></div>
          {report.reasons?.map((reason: string, index: number) => <p key={index} className="notice">{reason}</p>)}
          <div className="result-requirements">{requirements.items.map(item => <article key={item.requirementId} className="requirement-report"><div className="detail-title"><h3>{item.requirementId}</h3><StatusBadge value={item.verdict} /></div>
            <div className="result-summary"><div><span>覆盖</span>{item.coverage}</div><div><span>格式</span><StatusBadge value={item.schemaVerdict} /></div><div><span>来源</span><StatusBadge value={item.sourceVerdict} /></div><div><span>人工</span>{item.humanReviews?.length || 0} 条</div></div>
            {item.checks?.map((check, index) => <p key={index} className="result-check"><StatusBadge value={check.verdict} /> {check.name}：{check.reason}</p>)}
            <details><summary>来源与脚本声明</summary><JsonView value={{ evidence: item.evidence, scriptAssertions: item.scriptAssertions, humanReviews: item.humanReviews }} /></details>
          </article>)}{requirements.nextCursor && <Button onClick={() => void moreReport('requirements', requirements.nextCursor!)}>后续需求</Button>}</div>
          <details><summary>数据集验收摘要</summary><JsonView value={reportDatasets.items} />{reportDatasets.nextCursor && <Button onClick={() => void moreReport('datasets', reportDatasets.nextCursor!)}>后续摘要</Button>}</details>
          <div className="human-review"><h3>人工判定</h3><p className="hint">判定追加到固定执行、资料版本和 attempt；不能覆盖机器失败。</p>
            <div className="review-inputs"><label>需求<NativeSelect value={reviewId} onChange={event => setReviewId(event.target.value)}><option value="">选择需求</option>{requirements.items.map(item => <option key={item.requirementId} value={item.requirementId}>{item.requirementId}</option>)}</NativeSelect></label>
              <label>判断<NativeSelect value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="accept">接受</option><option value="reject">拒绝</option><option value="exception">例外接受</option></NativeSelect></label></div>
            <label>理由<Textarea value={reason} onChange={event => setReason(event.target.value)} /></label><Button disabled={!reviewId || !reason.trim() || !!pending} onClick={() => void review()}>保存人工判定</Button></div>
        </>}
      </section>
    </>}
  </div>;
}
