import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import { StatusBadge } from './status-badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Textarea } from './ui/textarea';

const items = (value: any): any[] => Array.isArray(value) ? value : value?.items || [];
const short = (value: unknown, length = 90) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text?.length > length ? `${text.slice(0, length)}…` : text ?? '—';
};
const time = (value: string | undefined) => value
  ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
  : '—';

export function JsonView({ value }: { value: any }) {
  const [raw, setRaw] = useState(false);
  if (!Array.isArray(value) || !value.length || !value[0] || typeof value[0] !== 'object') {
    return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
  }
  const rows = value.slice(0, 30);
  const allKeys = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  const keys = allKeys.slice(0, 9);
  return <div className="data-table-wrap">
    <div className="data-table-toolbar">
      <span className="muted">本次读取 {value.length} 条</span>
      <Button variant="ghost" size="sm" onClick={() => setRaw(current => !current)}>
        {raw ? '查看表格' : '查看完整 JSON'}
      </Button>
    </div>
    {raw ? <pre className="json">{JSON.stringify(value, null, 2)}</pre> : <>
      <Table className="data-table">
        <TableHeader><TableRow>{keys.map(key => <TableHead key={key}>{key}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{rows.map((row, index) => <TableRow key={index}>
          {keys.map(key => <TableCell key={key} title={short(row?.[key], 300)}>{short(row?.[key], 80)}</TableCell>)}
        </TableRow>)}</TableBody>
      </Table>
      {value.length > 30 && <p className="muted">当前展示前 30 条，共 {value.length} 条。</p>}
      {allKeys.length > keys.length && <p className="muted">当前表格展示前 {keys.length} 个字段，本页共有 {allKeys.length} 个字段。</p>}
      <p className="hint">表格单元格为预览；完整 JSON 展示本次已读取的内容，未包含尚未读取的材料。</p>
    </>}
  </div>;
}

export function Replay({ events, warning }: { events: any[]; warning?: string }) {
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
  return <>
    <div className="replay-toolbar">
      <Button size="sm" disabled={events.length < 2} onClick={() => { player.current?.play(); setPlaying(true); }}>播放</Button>
      <Button variant="outline" size="sm" onClick={() => { player.current?.pause(); setPlaying(false); }}>暂停</Button>
      <StatusBadge value={playing ? 'running' : 'paused'} />
      <span className="muted">{events.length} 条 rrweb 事件；回放不能证明业务结果</span>
    </div>
    {warning && <p className="notice">{warning}</p>}
    {error && <p className="error-inline">{error}</p>}
    {events.length < 2
      ? <div className="empty">当前范围没有可播放的完整 rrweb 起始快照。</div>
      : <div className="replay-stage" ref={root} />}
  </>;
}

export function RunRecoveryView({ runId, active, onRecovered, onOpen }: {
  runId: string;
  active: boolean;
  onRecovered(): Promise<any>;
  onOpen(): Promise<any>;
}) {
  const [data, setData] = useState<any>(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [recovered, setRecovered] = useState(false);
  const request = useRef(0);
  const inspect = useCallback(async () => {
    const current = ++request.current;
    setPending('inspect'); setError(''); setData(null);
    try {
      const result = await window.studio.call('inspectRunRecovery', { runId });
      if (current === request.current) setData(result);
    } catch (failure) {
      if (current === request.current) setError(String(failure));
    } finally {
      if (current === request.current) setPending('');
    }
  }, [runId]);
  useEffect(() => { void inspect(); return () => { request.current++; }; }, [inspect]);
  const recover = async () => {
    setPending('recover'); setError('');
    try {
      await window.studio.call('recoverRun', { runId, expectedFingerprint: data.inspection.lockFingerprint });
      setRecovered(true);
      await onRecovered();
    } catch (failure) {
      setError(String(failure)); setData(null);
    } finally { setPending(''); }
  };
  const states: Record<string, string> = {
    unlocked: '未见写入标记', live: '另一个写入进程仍在运行', dead: '原写入进程已退出',
    'pid-reused': '进程编号已被其他进程使用', unknown: '尚不能确认原写入进程', corrupt: '写入标记损坏',
  };
  const state = data?.inspection?.state;
  return <div className="overlay-body run-recovery" data-run-id={runId}>
    <code>{runId}</code>
    <p>恢复只重建可读存档与验收记录。已有原件保留，旧浏览器控制权和执行栈不会恢复。</p>
    {data && <>
      <h3 data-lock-state={state}>{states[state] || state}</h3>
      <p>{data.inspection.message}</p>
      {data.inspection.owner?.pid && <p className="muted">原进程编号：{data.inspection.owner.pid} · 检查时间：{time(data.inspection.checkedAt)}</p>}
      {data.error && <details><summary>上次读取失败原因</summary><p>{data.error}</p></details>}
    </>}
    {pending && <p role="status">{pending === 'recover' ? '正在确认所有权并重建存档…' : '正在检查写入所有权…'}</p>}
    {error && <p className="error-inline" role="alert">{error}</p>}
    {recovered && <p className="notice">存档已恢复为可读状态。请检查已保存材料和中断原因，再新建运行重试。</p>}
    {active && <p className="notice">当前存在打开的运行；请先结束并封存，再恢复存档。</p>}
    {data && !data.canRecover && data.status === 'unreadable' && !active && <p className="hint">当前状态不能安全恢复。原件保持不变，可稍后重新检查。</p>}
    <div className="recovery-actions">
      <Button variant="outline" size="sm" disabled={!!pending} onClick={() => void inspect()}>重新检查</Button>
      {!recovered && data?.canRecover && <Button size="sm" disabled={!!pending || active} onClick={() => void recover()}>
        {state === 'unlocked' ? '重建可读索引' : '安全恢复存档'}
      </Button>}
      {(recovered || data && data.status !== 'unreadable') && <Button size="sm" disabled={!!pending} onClick={() => {
        void onOpen().catch(failure => setError(String(failure)));
      }}>查看已保存材料</Button>}
    </div>
  </div>;
}

export function InterruptedValidationView({ record, checkpoints, historyError, active, onCheckpoints, onRetry }: {
  record: any;
  checkpoints: any[];
  historyError?: string;
  active: boolean;
  onCheckpoints(): void;
  onRetry(): void;
}) {
  const interrupted = ['interrupted', 'failed', 'cancelled'].includes(record.status);
  return <section className="interrupted-validation">
    <div className="detail-title">
      <h3>{interrupted ? '执行未形成完整验收报告' : '尚无完整验收报告'}</h3>
      <StatusBadge value={record.status} />
    </div>
    <p>{record.recovery?.reason || record.error || '当前没有可确认的完成报告，不能据此判定需求通过。'}</p>
    {record.error && record.error !== record.recovery?.reason && <p className="error-inline">{record.error}</p>}
    <p>运行：<code>{record.runId}</code></p>
    <p>已保存的 checkpoint 和附件仍可单独查看；{historyError ? '本次材料读取失败，不能当作没有证据。' : `当前页已读取 ${checkpoints.length} 个 checkpoint。`}</p>
    <p className="hint">重新执行会创建新的 run。旧控制权、人工等待和未完成的自动化步骤不会继续。</p>
    <div className="recovery-actions">
      <Button variant="outline" size="sm" onClick={onCheckpoints}>查看已有 checkpoint</Button>
      <Button size="sm" disabled={active || !interrupted || !record.projectId} onClick={onRetry}>准备新运行重试</Button>
    </div>
    {active && <p className="hint">先结束并封存当前运行，再选择新运行的登录环境与输入。</p>}
  </section>;
}

export function ArtifactView({ value, onRead }: { value: any; onRead: (id: string, options: any) => void }) {
  const [jsonPath, setJsonPath] = useState('');
  const mediaType = value.mediaType || value.artifact?.mediaType || '';
  const content = Object.hasOwn(value, 'value') ? value.value : value.content ?? value.result ?? value.text ?? value;
  const imageUrl = value.url || value.imageUrl;
  const id = value.artifact?.id || value.id;
  return <section className="artifact-view">
    <div className="detail-title">
      <h3>按需读取的材料</h3>
      <StatusBadge value={value.captureStatus || value.artifact?.captureStatus || 'unknown'} />
    </div>
    {imageUrl && mediaType.startsWith('image/') ? <img src={imageUrl} alt="已保存 checkpoint 截图" /> : <>
      <div className="artifact-query">
        <Input aria-label="JSON 定向路径" placeholder="JSON 路径，例如 $.records[0].id" value={jsonPath} onChange={event => setJsonPath(event.target.value)} />
        <Button variant="outline" size="sm" onClick={() => onRead(id, jsonPath ? { jsonPath } : {})}>定向读取</Button>
      </div>
      {typeof content === 'string' ? <pre className="json">{content}</pre> : <JsonView value={content} />}
      {value.nextCursor && <Button variant="outline" size="sm" onClick={() => onRead(id, { cursor: value.nextCursor, ...(jsonPath ? { jsonPath } : {}) })}>读取下一片</Button>}
    </>}
    {value.outputTruncated && <p className="notice">达到单次输出预算；通过游标继续读取，未把截断当作完整。</p>}
  </section>;
}

export function ValidationView({ record, onReview, checkpoints, runs }: {
  record: any;
  onReview(body: any): Promise<any>;
  checkpoints: any[];
  runs: any[];
}) {
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
    } catch (error) {
      if (request === reviewRequest.current) setReviewError(String(error));
    } finally {
      if (request === reviewRequest.current) setReviewLoading(false);
    }
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
      }).catch(error => {
        if (request === demoRequest.current) { setDemoId(''); setFeedback(String(error)); }
      });
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
  const screenshot = (runId: string, checkpoint: any) => {
    const metadata = items(checkpoint?.metadata?.artifacts).find((artifact: any) => artifact.kind === 'screenshot' && artifact.captureStatus === 'complete');
    return metadata ? `bes-artifact://${runId}/${metadata.id}` : null;
  };
  return <div className="validation-report">
    <div className="verdict-summary">
      <div><span>机器总评</span><StatusBadge value={result.overall} /></div>
      <div><span>需求覆盖</span><StatusBadge value={result.coverageVerdict} /></div>
      <div><span>业务断言</span><StatusBadge value={result.assertionVerdict} /></div>
      <div><span>执行版本</span><StatusBadge value={result.versionVerdict} /></div>
      <div><span>控制流</span><StatusBadge value={result.executionVerdict} /></div>
    </div>
    <p className="muted">当前文件与已运行版本：{record.currentVersion === 'matched' ? '一致' : record.currentVersion === 'needs-revalidation' ? '发生变化，必须重新验证' : '未确认'} · 用时 {Math.round(report.durationMs)} ms</p>
    {record.currentVersion === 'needs-revalidation' && <p className="notice">历史结果保持原样。当前文件已经变化，历史通过不能应用到当前版本。</p>}
    {report.error && <p className="error-inline">{report.error}</p>}
    <label>并排查看人工示例
      <NativeSelect aria-label="同项目人工示范" value={demoId} onChange={event => { setDemoCheckpoints([]); setDemoId(event.target.value); }}>
        <option value="">选择同项目的一次人工示范</option>
        {demonstrations.map(run => <option value={run.id} key={run.id}>{run.id.slice(0, 12)} · {time(run.createdAt)}</option>)}
      </NativeSelect>
    </label>
    {items(result.requirements).map((requirement: any) => {
      const actual = checkpoints.find(checkpoint => checkpoint.key === requirement.checkpointKey);
      const example = demoCheckpoints.find(checkpoint => checkpoint.key === requirement.checkpointKey);
      const actualImage = screenshot(record.runId, actual);
      const exampleImage = screenshot(demoId, example);
      return <section className="requirement-report" key={requirement.id}>
        <div className="detail-title">
          <h3>{requirement.id}</h3>
          <div><StatusBadge value={requirement.coverageVerdict} /><StatusBadge value={requirement.assertionVerdict} /></div>
        </div>
        <p className="muted">Checkpoint: {requirement.checkpointKey}</p>
        <Table className="data-table">
          <TableHeader><TableRow><TableHead>检查</TableHead><TableHead>结果</TableHead><TableHead>依据</TableHead></TableRow></TableHeader>
          <TableBody>{requirement.checks.map((check: any, index: number) => <TableRow key={index}>
            <TableCell>{check.name}</TableCell>
            <TableCell><StatusBadge value={check.verdict} /></TableCell>
            <TableCell>{check.message}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {demoId && <div className="comparison">
          <figure>
            <figcaption>人工示例 · {example?.title || '该 key 没有匹配保存点'}</figcaption>
            {exampleImage ? <img src={exampleImage} alt="人工示例 checkpoint" /> : <p className="empty compact">没有可用截图</p>}
            <p>{example?.description}</p>
          </figure>
          <figure>
            <figcaption>受控复跑 · {actual?.title || '该 key 未覆盖'}</figcaption>
            {actualImage ? <img src={actualImage} alt="复跑 checkpoint" /> : <p className="empty compact">没有可用截图</p>}
            <p>{actual?.description}</p>
          </figure>
        </div>}
      </section>;
    })}
    {items(report.datasets).map((dataset: any) => <section key={dataset.name} className="dataset-report">
      <h3>结构化数据：{dataset.name}</h3>
      <p className="muted">{dataset.records.length} 条 · 来源 {dataset.origin} · {dataset.sourceRefs.length} 个来源引用 {dataset.pagination && `· ${dataset.pagination.pages} 页，分页终止 ${dataset.pagination.complete ? '已观察' : '未证明'}`}</p>
      <JsonView value={dataset.records} />
      <details><summary>来源引用</summary><JsonView value={dataset.sourceRefs} /></details>
    </section>)}
    <section className="human-review">
      <h3>人工判定</h3>
      <p className="hint">独立追加保存，不覆盖机器原始失败。例外接受需明确范围与理由。</p>
      <div className="review-inputs">
        <label>判定
          <NativeSelect value={verdict} onChange={event => setVerdict(event.target.value)}>
            <option value="accept">接受</option><option value="reject">拒绝</option><option value="exception">有条件例外接受</option>
          </NativeSelect>
        </label>
        <label>范围<Input value={scope} onChange={event => setScope(event.target.value)} placeholder="all 或 requirementId" /></label>
      </div>
      <label>理由<Textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="对业务含义、差异、覆盖范围的判断" /></label>
      <Button size="sm" disabled={!reason.trim() || !scope.trim() || savingReview} onClick={() => void saveReview()}>
        {savingReview ? '正在保存判定…' : '保存人工判定'}
      </Button>
      {feedback && <p className="notice">{feedback}</p>}
      <div className="review-history">
        <div className="detail-title"><h3>已保存的人工判定</h3><Button variant="outline" size="sm" disabled={reviewLoading} onClick={() => void loadReviews()}>从头刷新</Button></div>
        <p className="hint">按追加顺序展示，保留每次理由和范围；人工判定不改变上方机器结论。</p>
        {reviewError && <p className="error-inline" role="alert">{reviewError}</p>}
        {reviewLoading && <p role="status">正在读取人工判定…</p>}
        {reviewPage && !items(reviewPage).length && !reviewPage.nextCursor && <p className="empty compact">当前验收尚无人工判定。</p>}
        {items(reviewPage).map(review => <ReviewEntry key={review.id} review={review} />)}
        {reviewPage?.nextCursor && <Button variant="outline" size="sm" disabled={reviewLoading} onClick={() => void loadReviews(reviewPage.nextCursor)}>下一页人工判定</Button>}
        {recentReview && !items(reviewPage).some(review => review.id === recentReview.id) && <><h4>刚保存的判定</h4><ReviewEntry review={recentReview} /></>}
      </div>
    </section>
  </div>;
}

function ReviewEntry({ review }: { review: any }) {
  const reviewLabels: Record<string, string> = { accept: '接受', reject: '拒绝', exception: '有条件例外接受' };
  return <article className="review-entry" data-review-id={review.id}>
    <div className="detail-title">
      <strong>{reviewLabels[review.verdict] || review.verdict}</strong>
      <time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
    </div>
    <p className="review-scope">范围：{review.scope}</p>
    <p className="review-reason">{review.reason}</p>
  </article>;
}
