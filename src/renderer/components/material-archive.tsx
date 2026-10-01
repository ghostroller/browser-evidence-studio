import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Copy, FileText, FolderOpen, Plus, RefreshCw } from 'lucide-react';
import type { DraftSummary, RevisionSummary } from '@/contracts/workbench-project';
import type { MaterialCatalog } from '@/contracts/workspace';
import type { ReplayPosition } from '@/contracts/recording';
import { Button } from './ui/button';
import { IconButton } from './ui/icon-button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';

type Page<T> = { items: T[]; nextCursor?: string };
type Collection = 'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs';
const COLLECTIONS: Collection[] = ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'];
const names: Record<Collection, string> = { requirements: '需求', fields: '字段', checkpoints: '保存点', annotations: '注释', recordingRefs: '来源录制' };
type Fixed = { revisionId: string; contentHash: string; displayNumber?: number; taskBrief?: { objective: string; scope: string } };
export type ArchiveExitGuard = React.MutableRefObject<(() => boolean) | null>;
interface Props {
  active: boolean; catalog: MaterialCatalog | null; drafts: Page<DraftSummary>; revisions: Page<RevisionSummary>;
  viewedRevision: Fixed | null; viewedPages: Record<Collection, Page<any>>; pending: string; draftReady: boolean;
  recordingArchive?: React.ReactNode; recordingGuardRef?: ArchiveExitGuard; exitGuardRef: ArchiveExitGuard;
  archivePrompt: React.ReactNode; recoveringPublication: boolean; publicationOpen: boolean;
  onRefresh(): Promise<unknown>; onPrepareArchive(): Promise<unknown>;
  onViewRevision(item: Extract<RevisionSummary, { status: 'available' }>): Promise<unknown>; onClearRevision(): void;
  onReturnToWorkspace(): void; onCreateDraft(base?: string): Promise<unknown>; onCopyDraft(id: string): Promise<unknown>; onSwitchDraft(id: string): void;
  onManage(kind: 'drafts' | 'revisions', id: string, patch: { name?: string; note?: string; hidden?: boolean }): Promise<unknown>;
  onMore(kind: 'drafts' | 'revisions', cursor: string): Promise<unknown>;
  onMoreRevision(collection: Collection, cursor: string): Promise<unknown>;
  onCompareDraft(id: string): Promise<any[]>; onCompareRevision(from: string, to: string): Promise<any[]>;
  onOpenReplay(position: ReplayPosition): void;
}
/** Catalog navigation only. All durable actions reuse the workbench's existing service commands. */
export function MaterialArchivePanel(props: Props) {
  const { catalog, drafts, revisions, viewedRevision, viewedPages } = props;
  const [tab, setTab] = useState<'revisions' | 'recordings' | 'drafts'>('revisions');
  const [showRemoved, setShowRemoved] = useState(false), [search, setSearch] = useState('');
  const [selectedDraft, setSelectedDraft] = useState('');
  const initialDraftSelected = useRef(false);
  const [name, setName] = useState(''), [note, setNote] = useState('');
  const [baseline, setBaseline] = useState({ name: '', note: '' });
  const [compareFrom, setCompareFrom] = useState(''), [differences, setDifferences] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const busyRef = useRef(false), alive = useRef(true), detail = useRef<HTMLDivElement>(null);
  const contextAnchor = useRef<HTMLSpanElement>(null), revealedContext = useRef(''), wasActive = useRef(false);
  const entryId = tab === 'drafts' ? selectedDraft : tab === 'revisions' ? viewedRevision?.revisionId || '' : '';
  const entryKind = tab === 'drafts' ? 'drafts' : 'revisions';
  const entry = entryId ? catalog?.[entryKind]?.[entryId] : undefined;
  const dirty = name !== baseline.name || note !== baseline.note;
  const context = `${tab}/${entryId}`, lastContext = useRef('');
  const disabled = !!busy || !!props.pending;
  useEffect(() => {
    if (props.active && (!wasActive.current || revealedContext.current !== context)) contextAnchor.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    wasActive.current = props.active; revealedContext.current = context;
  }, [props.active, context]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Hydrate the selected metadata before a newly visible form accepts input.
  useLayoutEffect(() => {
    if (lastContext.current !== context || !dirty) {
      const next = { name: entry?.name || '', note: entry?.note || '' };
      setName(next.name); setNote(next.note); setBaseline(next);
    }
    if (lastContext.current !== context) { setDifferences(null); setCompareFrom(''); detail.current?.scrollTo?.(0, 0); }
    lastContext.current = context;
  }, [context, entry?.name, entry?.note]);
  useEffect(() => {
    if (!initialDraftSelected.current && catalog?.workingDraftId) { initialDraftSelected.current = true; setSelectedDraft(catalog.workingDraftId); }
  }, [selectedDraft, catalog?.workingDraftId]);
  const guard = () => {
    if (busyRef.current || props.pending) { setError('正在处理存档操作，请等待完成后再切换。'); return false; }
    if (props.publicationOpen) { setError('请先确认存档范围，或返回继续编辑，再切换。'); return false; }
    if (dirty) { setError('目录信息有未保存输入，请先保存或取消修改，再切换。'); return false; }
    if (tab === 'recordings' && props.recordingGuardRef?.current && !props.recordingGuardRef.current()) return false;
    return true;
  };
  useEffect(() => { props.exitGuardRef.current = guard; return () => { props.exitGuardRef.current = null; }; });
  const choose = (action: () => void) => { if (guard()) { setError(''); setDifferences(null); action(); } };
  const perform = async (label: string, action: () => Promise<unknown>) => {
    if (busyRef.current || props.pending) return;
    busyRef.current = true; setBusy(label); setError('');
    try { await action(); } catch (failure) { if (alive.current) setError(String(failure)); }
    finally { busyRef.current = false; if (alive.current) setBusy(''); }
  };
  const matching = (id: string, value: string) => `${value} ${id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleRevisions = revisions.items.filter(item => (showRemoved || !catalog?.revisions?.[item.revisionId]?.hidden) && matching(item.revisionId, `V${item.status === 'available' ? item.displayNumber ?? '' : ''} ${catalog?.revisions?.[item.revisionId]?.name || ''}`));
  const visibleDrafts = drafts.items.filter(item => (showRemoved || !catalog?.drafts?.[item.draftId]?.hidden) && matching(item.draftId, catalog?.drafts?.[item.draftId]?.name || '工作副本'));
  const draft = drafts.items.find(item => item.draftId === selectedDraft);
  const metadata = <form className="archive-metadata-form" onSubmit={event => { event.preventDefault(); if (!dirty) return; const next = { name: name.trim(), note }; void perform('保存目录信息', async () => { await props.onManage(entryKind, entryId, next); if (alive.current) { setName(next.name); setBaseline(next); } }); }}>
    <h4>目录信息</h4><p className="hint">标签和备注不修改{tab === 'revisions' ? '固定内容或版本 hash' : '副本里的资料内容'}。输入后明确保存。</p>
    <Label>{tab === 'drafts' ? '副本名称' : '版本标签'}<Input maxLength={200} value={name} onChange={event => setName(event.target.value)} disabled={disabled} /></Label>
    <Label>{tab === 'drafts' ? '副本备注' : '版本备注'}<Textarea maxLength={4000} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} rows={2} /></Label>
    <div className="button-row"><Button type="submit" variant="default" disabled={disabled || !dirty}>保存目录信息</Button><Button type="button" disabled={disabled || !dirty} onClick={() => { setName(baseline.name); setNote(baseline.note); setError(''); }}>取消目录修改</Button>{dirty && <small>未保存</small>}</div>
  </form>;
  const diffResult = differences && <section className="archive-differences" aria-label="版本差异"><h4>比较结果</h4>{differences.length ? differences.map((item, index) => <p key={index}>{names[item.collection as Collection] || item.collection} · {item.id} · {item.change} · {item.changedFields.join('、')}</p>) : <p>没有内容差异</p>}</section>;
  return <section className="archive-center" aria-label="存档中心" aria-busy={disabled}>
    <span ref={contextAnchor} data-archive-context-anchor aria-hidden="true" className="archive-context-anchor"/><nav className="archive-tabs-nav" aria-label="存档分类">{([['revisions', '资料版本', Archive], ['recordings', '原始录制', FolderOpen], ['drafts', '工作副本', FileText]] as const).map(([id, label, Icon]) => <Button key={id} variant="ghost" aria-pressed={tab === id} disabled={disabled} onClick={() => { if (id !== tab) choose(() => { setTab(id); setSearch(''); }); }}><Icon aria-hidden="true"/>{label}</Button>)}</nav>
    <p className="archive-explainer">{tab === 'revisions' ? '固定的任务资料。查看内容、比较版本，或派生新的可编辑副本。' : tab === 'drafts' ? '尚可编辑的任务资料。只有一份当前工作副本，切换后在保存点工作区编辑。' : '网页示范的连续来源。回放、查找引用，或管理目录标签。'}</p>
    {(error || busy || props.pending) && <p className={error ? 'error-inline' : 'archive-feedback'} role={error ? 'alert' : 'status'}>{error || busy || props.pending}</p>}
    {tab === 'recordings' ? props.recordingArchive : <>
      <div className="archive-toolbar"><div className="button-row">{tab === 'revisions' ? <Button variant="default" disabled={disabled || !props.draftReady || !!viewedRevision} onClick={() => choose(() => { void perform('准备存档范围', props.onPrepareArchive); })}><Plus aria-hidden="true"/>{props.recoveringPublication ? '恢复上次存档操作' : '保存存档版本'}</Button> : <Button variant="default" disabled={disabled} onClick={() => choose(() => { void perform('创建工作副本', () => props.onCreateDraft()); })}><Plus aria-hidden="true"/>新建工作副本</Button>}<IconButton icon={RefreshCw} label="刷新存档" disabled={disabled} onClick={() => choose(() => { void perform('刷新存档', props.onRefresh); })}/></div>
        <Label className="archive-removed"><input type="checkbox" checked={showRemoved} onChange={event => setShowRemoved(event.target.checked)} />显示已移除条目</Label>
      </div>
      {props.archivePrompt}
      {!catalog ? <p role="status">正在读取存档目录…</p> : <div className={`archive-catalog-layout${entryId ? ' has-detail' : ''}`}>
        <div className="archive-directory"><Label>搜索{tab === 'revisions' ? '版本' : '副本'}<Input placeholder="名称、编号或 ID" value={search} onChange={event => setSearch(event.target.value)} /></Label>
          <div className="archive-entry-list" aria-label={tab === 'revisions' ? '资料版本目录' : '工作副本目录'}>
            {tab === 'revisions' ? visibleRevisions.map(item => <section className="archive-list-entry" key={item.revisionId} data-selected={viewedRevision?.revisionId === item.revisionId}>
              <strong>V{item.status === 'available' ? item.displayNumber ?? '—' : '—'} {catalog.revisions?.[item.revisionId]?.name || '未命名版本'}</strong>
              <small>{item.status === 'available' ? new Date(item.createdAt).toLocaleString() : `不可读取：${item.reason}`}</small>
              <small>{catalog.revisions?.[item.revisionId]?.hidden ? '已隐藏 · ' : ''}固定内容只读{item.status === 'available' ? ` · ${item.author === 'agent' ? 'Agent' : '人工'}` : ''}</small>
              <Button disabled={disabled || item.status !== 'available'} onClick={() => choose(() => { if (item.status === 'available') void perform('读取固定版本', () => props.onViewRevision(item)); })}>查看固定版本</Button>
            </section>) : visibleDrafts.map(item => <section className="archive-list-entry" key={item.draftId} data-selected={item.draftId === selectedDraft}>
              <strong>{catalog.drafts?.[item.draftId]?.name || '未命名工作副本'}</strong><small>{catalog.workingDraftId === item.draftId ? '当前工作副本' : catalog.drafts?.[item.draftId]?.hidden ? '已移除' : '可切换编辑'}{item.status === 'unavailable' ? ' · 不可读取' : ''}</small><Button aria-pressed={item.draftId === selectedDraft} disabled={disabled} onClick={() => choose(() => setSelectedDraft(item.draftId))}>管理此副本</Button>
            </section>)}
            {!(tab === 'revisions' ? visibleRevisions : visibleDrafts).length && <div className="catalog-empty"><Archive aria-hidden="true"/><strong>{search || showRemoved ? '没有匹配的条目' : tab === 'revisions' ? '还没有存档版本' : '还没有工作副本'}</strong><p>{tab === 'revisions' ? '编辑好当前资料后，保存一份固定版本' : '新建副本，或从资料版本继续编辑'}</p></div>}
          </div>
          {(tab === 'revisions' ? revisions.nextCursor : drafts.nextCursor) && <Button disabled={disabled} onClick={() => void perform('加载更多', () => props.onMore(tab === 'revisions' ? 'revisions' : 'drafts', (tab === 'revisions' ? revisions.nextCursor : drafts.nextCursor)!))}>{tab === 'revisions' ? '更多版本' : '更多工作副本'}</Button>}
        </div>
        <div className="archive-detail" ref={detail}>
          {tab === 'revisions' ? viewedRevision ? <section aria-label="固定版本只读">
            <div className="archive-detail-heading"><IconButton icon={ArrowLeft} label="返回版本列表" disabled={disabled} onClick={() => choose(props.onClearRevision)}/><h3>存档 V{viewedRevision.displayNumber ?? '—'} · 只读</h3></div>
            <p className="archive-readonly-notice">正在查看固定版本。继续编辑会创建新的工作副本，原版保持不变。</p>
            <div className="button-row"><Button variant="default" disabled={disabled} onClick={() => choose(() => { void perform('基于版本创建副本', () => props.onCreateDraft(viewedRevision.revisionId)); })}>基于此版继续编辑</Button><Button disabled={disabled} onClick={() => choose(props.onReturnToWorkspace)}>返回当前工作副本</Button></div>
            <h4>任务目标</h4><p>{viewedRevision.taskBrief?.objective || '此版本未填写任务目标'}</p>{viewedRevision.taskBrief?.scope && <p>{viewedRevision.taskBrief.scope}</p>}
            {COLLECTIONS.map(collection => <details className="archive-content-group" key={collection} open={collection === 'checkpoints'}><summary>{names[collection]} · {viewedPages[collection].items.length}{viewedPages[collection].nextCursor ? '+' : ''}</summary>{viewedPages[collection].items.length ? viewedPages[collection].items.map((item: any, index: number) => <div className="archive-content-row" key={item.id ?? index}><p>{collection === 'recordingRefs' ? item : item.description || item.title || item.name || item.text || item.id}</p>{collection === 'checkpoints' && <Button disabled={disabled} onClick={() => props.onOpenReplay(item.anchor)}>查看来源</Button>}</div>) : <p className="hint">此版本没有{names[collection]}</p>}{viewedPages[collection].nextCursor && <Button disabled={disabled} onClick={() => void perform('读取版本内容', () => props.onMoreRevision(collection, viewedPages[collection].nextCursor!))}>更多{names[collection]}</Button>}</details>)}
            <section className="archive-compare"><h4>版本比较</h4><Label>比较起始版本<NativeSelect value={compareFrom} disabled={disabled} onChange={event => { setCompareFrom(event.target.value); setDifferences(null); }}><option value="">选择另一版本</option>{revisions.items.filter(item => item.status === 'available' && item.revisionId !== viewedRevision.revisionId).map(item => <option key={item.revisionId} value={item.revisionId}>V{item.status === 'available' ? item.displayNumber : ''} {catalog.revisions?.[item.revisionId]?.name}</option>)}</NativeSelect></Label><Button disabled={disabled || !compareFrom} onClick={() => void perform('比较版本', async () => { const result = await props.onCompareRevision(compareFrom, viewedRevision.revisionId); if (alive.current) setDifferences(result); })}>比较版本</Button>{diffResult}</section>
            {metadata}<details className="archive-identity"><summary>版本标识与目录管理</summary><p>版本 ID：{viewedRevision.revisionId}</p><p>hash：{viewedRevision.contentHash}</p><Button disabled={disabled} onClick={() => choose(() => { void perform('更新版本目录', () => props.onManage('revisions', viewedRevision.revisionId, { hidden: !entry?.hidden })); })}>{entry?.hidden ? '恢复版本' : '隐藏版本'}</Button><p className="hint">隐藏可恢复，不改变原内容或历史引用</p></details>
          </section> : <div className="catalog-empty"><Archive aria-hidden="true"/><h3>选择一个版本</h3><p>查看固定资料、来源录制和版本差异</p></div> : draft ? <section aria-label="工作副本详情">
            <div className="archive-detail-heading"><IconButton icon={ArrowLeft} label="返回副本列表" disabled={disabled} onClick={() => choose(() => setSelectedDraft(''))}/><h3>{catalog.drafts?.[draft.draftId]?.name || '工作副本'}</h3></div><p>{catalog.workingDraftId === draft.draftId ? '这是当前工作副本' : '此副本尚未设为当前'}{entry?.hidden ? ' · 已移除' : ''}</p>
            {draft.status === 'available' ? <><p>来源：{draft.baseRevisionId ? `存档 V${catalog.revisions?.[draft.baseRevisionId]?.displayNumber ?? '—'}` : '从空白开始'} · 副本修订 {draft.draftRevision}</p><div className="button-row"><Button variant="default" disabled={disabled || !!entry?.hidden} onClick={() => choose(() => props.onSwitchDraft(draft.draftId))}>设为当前并编辑</Button><Button disabled={disabled} onClick={() => choose(() => { void perform('复制工作副本', async () => { const copied = await props.onCopyDraft(draft.draftId); if (alive.current && typeof copied === 'string') setSelectedDraft(copied); }); })}><Copy aria-hidden="true"/>复制工作副本</Button></div><Button disabled={disabled} onClick={() => choose(() => { void perform('读取副本差异', async () => { const result = await props.onCompareDraft(draft.draftId); if (alive.current) setDifferences(result); }); })}>查看副本差异</Button>{diffResult}</> : <p role="alert">副本读取失败：{draft.reason}。不能视为空白副本。</p>}
            {metadata}<details className="archive-identity"><summary>副本标识与移除</summary><p>{draft.draftId}</p><p className="hint">移除可恢复。当前副本需先切换至另一份，才能移除。</p><Button disabled={disabled || catalog.workingDraftId === draft.draftId} onClick={() => choose(() => { void perform('更新副本目录', () => props.onManage('drafts', draft.draftId, { hidden: !entry?.hidden })); })}>{entry?.hidden ? '恢复副本' : '移除副本'}</Button></details>
          </section> : <div className="catalog-empty"><FileText aria-hidden="true"/><p>选择要管理的工作副本</p></div>}
        </div>
      </div>}
    </>}
  </section>;
}
