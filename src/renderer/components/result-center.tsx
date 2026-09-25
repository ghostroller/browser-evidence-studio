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
type Dataset = { executionId: string; attemptId: string; datasetId: string; status: string; committedBatches: number; committedRecords: number };
type Batch = { batchId: string; contentHash: string; recordCount: number; durableAt: string };
type Step = { identity: { stepId: string; attemptId: string; entityKey?: string }; state: string; error?: { message: string }; diagnostics?: unknown };
type Assessment = { reportId: string; overall?: string; coverage?: string; reasons?: string[] };
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
  const [report, setReport] = useState<any>(null);
  const [requirements, setRequirements] = useState<Page<ValidatedRequirement>>(empty);
  const [reportDatasets, setReportDatasets] = useState<Page<any>>(empty);
  const [reviewId, setReviewId] = useState('');
  const [decision, setDecision] = useState<'accept' | 'reject' | 'exception'>('accept');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, executionId, ...body }), [projectId, executionId]);
  const readItems = useCallback(async <T,>(collection: 'steps' | 'datasets', cursor?: string): Promise<Page<T>> =>
    call('executionItems', { collection, limit: 30, maxBytes: 24576, ...(cursor ? { cursor } : {}) }), [call]);
  useEffect(() => {
    const token = ++request.current;
    setExecution(null); setSteps(empty()); setDatasets(empty()); setSelected({}); setAssessment(null); setReport(null); setError('');
    void Promise.all([call('execution'), readItems<Step>('steps'), readItems<Dataset>('datasets')]).then(([head, stepPage, datasetPage]) => {
      if (token !== request.current) return;
      setExecution(head); setSteps(stepPage); setDatasets(datasetPage);
    }).catch(failure => { if (token === request.current) setError(String(failure)); });
    return () => { ++request.current; };
  }, [call, readItems]);
  const readReport = async (id: string) => {
    const token = ++request.current;
    const [head, reqs, data] = await Promise.all([
      call('executionReport', { reportId: id }),
      call('executionReportItems', { reportId: id, collection: 'requirements', limit: 20, maxBytes: 24576 }),
      call('executionReportItems', { reportId: id, collection: 'datasets', limit: 30, maxBytes: 24576 }),
    ]);
    if (token === request.current) { setReport(head); setRequirements(reqs); setReportDatasets(data); }
  };
  const assess = async () => {
    setPending('固定资料验收'); setError('');
    try {
      const identities: DatasetIdentity[] = Object.entries(selected).map(([datasetId, attemptId]) => ({ executionId, datasetId, attemptId }));
      const next: Assessment = await call('assessExecution', { datasetIdentities: identities });
      setAssessment(next); await readReport(next.reportId);
    } catch (failure) { setError(String(failure)); }
    finally { setPending(''); }
  };
  const openDataset = async (item: Dataset) => {
    setActiveDataset(item); setBatch(null); setRecords(empty()); setError('');
    try { setBatches(await call('datasetBatches', { attemptId: item.attemptId, datasetId: item.datasetId, maxBytes: 24576, limit: 30 })); }
    catch (failure) { setError(String(failure)); }
  };
  const openBatch = async (item: Batch) => {
    if (!activeDataset) return;
    setBatch(item); setRecords(empty()); setError('');
    try { setRecords(await call('datasetRecords', { attemptId: activeDataset.attemptId, datasetId: activeDataset.datasetId, batchId: item.batchId, maxBytes: 24576, limit: 30 })); }
    catch (failure) { setError(String(failure)); }
  };
  const review = async () => {
    if (!assessment || !reason.trim() || !reviewId) return;
    setPending('保存人工判定'); setError('');
    try { await call('reviewExecution', { reportId: assessment.reportId, requirementId: reviewId, decision, reason: reason.trim() });
      setNotice('人工判定已追加保存；机器报告未改变。重新验收可读取新判定。'); setReason(''); }
    catch (failure) { setError(String(failure)); }
    finally { setPending(''); }
  };
  return <div className="result-center">
    <div className="detail-title"><h3>执行结果中心</h3><code>{executionId}</code></div>
    {error && <p className="error-inline" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {!execution ? <p role="status">正在读取实际执行身份…</p> : <>
      <div className="result-summary"><div><span>执行</span><StatusBadge value={execution.status} /></div><div><span>资料版本</span><code>{execution.binding?.materialRevisionId || '未绑定'}</code></div>
        <div><span>代码 / 输入</span><code>{execution.binding?.codeFingerprint?.slice(0, 12) || '—'} / {execution.binding?.inputFingerprint?.slice(0, 12) || '—'}</code></div>
        <div><span>快照校验</span><StatusBadge value={execution.snapshotVerified ? 'pass' : 'inconclusive'} /></div><div><span>工作流 attempt</span><code>{execution.workflowAttemptId || '未形成'}</code></div></div>
      <section><h3>步骤与部分失败</h3><p className="hint">每个步骤保持原 attempt 身份；失败、blocked 和已提交数据分别显示。</p>
        {steps.items.map((item, index) => <div className="result-row" key={`${item.identity?.attemptId}-${item.identity?.stepId}-${index}`}><strong>{item.identity?.stepId || '步骤'}</strong><span>{item.identity?.entityKey || ''}</span><StatusBadge value={item.state} /><small>{item.error?.message || ''}</small></div>)}
        {steps.nextCursor && <Button onClick={() => void readItems<Step>('steps', steps.nextCursor).then(next => setSteps({ ...next, items: [...steps.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续步骤</Button>}
      </section><section><h3>数据集与实际 attempt</h3><p className="hint">每个数据集明确选择一个 attempt 进入验收；保留失败 attempt 的已提交批次。</p>
        {datasets.items.map(item => <div className="result-row" key={`${item.datasetId}-${item.attemptId}`}><strong>{item.datasetId}</strong><span>{item.attemptId.slice(0, 14)} · {item.committedRecords} 条 / {item.committedBatches} 批</span><StatusBadge value={item.status} />
          <Button onClick={() => void openDataset(item)}>查看数据</Button><Button className={selected[item.datasetId] === item.attemptId ? 'selected' : ''} onClick={() => setSelected(current => ({ ...current, [item.datasetId]: item.attemptId }))}>用于验收</Button></div>)}
        {datasets.nextCursor && <Button onClick={() => void readItems<Dataset>('datasets', datasets.nextCursor).then(next => setDatasets({ ...next, items: [...datasets.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续数据集</Button>}
        {activeDataset && <div className="result-data"><h4>{activeDataset.datasetId} · {activeDataset.attemptId}</h4><p className="hint">原件按批次有界读取；真实 null 与缺失字段在记录中分别标识。</p>
          {batches.items.map(item => <Button key={item.batchId} className={batch?.batchId === item.batchId ? 'selected' : ''} onClick={() => void openBatch(item)}>{item.batchId.slice(0, 15)} · {item.recordCount} 条 · {item.contentHash.slice(0, 10)}</Button>)}
          {batches.nextCursor && <Button onClick={() => void call('datasetBatches', { attemptId: activeDataset.attemptId, datasetId: activeDataset.datasetId, cursor: batches.nextCursor, maxBytes: 24576, limit: 30 }).then((next: Page<Batch>) => setBatches({ ...next, items: [...batches.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续批次</Button>}
          {batch && <><JsonView value={records.items} />{records.nextCursor && <Button onClick={() => void call('datasetRecords', { attemptId: activeDataset.attemptId, datasetId: activeDataset.datasetId, batchId: batch.batchId, cursor: records.nextCursor, maxBytes: 24576, limit: 30 }).then((next: Page<any>) => setRecords({ ...next, items: [...records.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续记录</Button>}</>}
        </div>}
      </section><section><div className="detail-title"><h3>固定资料验收</h3><Button disabled={!!pending || !execution.workflowAttemptId} onClick={() => void assess()}>{pending || '按所选 attempt 验收'}</Button></div>
        <p className="hint">机器判断区分格式、来源内容、脚本声明、人工判定和版本。候选资料版本不表示人已批准。</p>
        {assessment && <p>报告 <code>{assessment.reportId}</code></p>}
        {report && <><div className="result-summary"><div><span>机器总评</span><StatusBadge value={report.overall} /></div><div><span>覆盖</span><StatusBadge value={report.coverage} /></div><div><span>资料</span>{report.materialStatus || 'candidate'}</div><div><span>版本</span><StatusBadge value={report.version?.verdict || 'inconclusive'} /></div></div>
          {report.reasons?.map((reason: string, index: number) => <p key={index} className="notice">{reason}</p>)}
          <div className="result-requirements">{requirements.items.map(item => <article key={item.requirementId} className="requirement-report"><div className="detail-title"><h3>{item.requirementId}</h3><StatusBadge value={item.verdict} /></div>
            <div className="result-summary"><div><span>覆盖</span>{item.coverage}</div><div><span>格式</span><StatusBadge value={item.schemaVerdict} /></div><div><span>来源</span><StatusBadge value={item.sourceVerdict} /></div><div><span>人工</span>{item.humanReviews?.length || 0} 条</div></div>
            {item.checks?.map((check, index) => <p key={index} className="result-check"><StatusBadge value={check.verdict} /> {check.name}：{check.reason}</p>)}
            <details><summary>来源与脚本声明</summary><JsonView value={{ evidence: item.evidence, scriptAssertions: item.scriptAssertions, humanReviews: item.humanReviews }} /></details>
          </article>)}{requirements.nextCursor && <Button onClick={() => void call('executionReportItems', { reportId: assessment?.reportId, collection: 'requirements', cursor: requirements.nextCursor, limit: 20, maxBytes: 24576 }).then((next: Page<ValidatedRequirement>) => setRequirements({ ...next, items: [...requirements.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续需求</Button>}</div>
          <details><summary>数据集验收摘要</summary><JsonView value={reportDatasets.items} />{reportDatasets.nextCursor && <Button onClick={() => void call('executionReportItems', { reportId: assessment?.reportId, collection: 'datasets', cursor: reportDatasets.nextCursor, limit: 30, maxBytes: 24576 }).then((next: Page<any>) => setReportDatasets({ ...next, items: [...reportDatasets.items, ...next.items] })).catch(failure => setError(String(failure)))}>后续摘要</Button>}</details>
          <div className="human-review"><h3>人工判定</h3><p className="hint">判定追加到固定执行、资料版本和 attempt；不能覆盖机器失败。</p>
            <div className="review-inputs"><label>需求<NativeSelect value={reviewId} onChange={event => setReviewId(event.target.value)}><option value="">选择需求</option>{requirements.items.map(item => <option key={item.requirementId} value={item.requirementId}>{item.requirementId}</option>)}</NativeSelect></label>
              <label>判断<NativeSelect value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="accept">接受</option><option value="reject">拒绝</option><option value="exception">例外接受</option></NativeSelect></label></div>
            <label>理由<Textarea value={reason} onChange={event => setReason(event.target.value)} /></label><Button disabled={!reviewId || !reason.trim() || !!pending} onClick={() => void review()}>保存人工判定</Button></div>
        </>}
      </section>
    </>}
  </div>;
}
