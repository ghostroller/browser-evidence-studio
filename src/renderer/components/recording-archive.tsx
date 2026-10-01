import { useWorkbenchClient, scopedWorkbenchCall } from '../lib/workbench-client';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Film, Play, RefreshCw, ArrowLeft } from 'lucide-react';
import type { MaterialCatalog } from '@/contracts/workspace';
import type { RecordingUsageResult } from '@/contracts/workbench-project';
import type { ArchiveExitGuard } from './material-archive';
import { Button } from './ui/button';
import { IconButton } from './ui/icon-button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

interface RunEntry { id: string; status: string; createdAt?: string; kind?: string }
interface Props {
  projectId: string; runs: RunEntry[]; exitGuardRef?: ArchiveExitGuard;
  onReplay(id: string): Promise<unknown>; onDiagnostic(id: string): Promise<unknown>; onRecovery(id: string): void;
}
const recordingStatus = (value: string) => ({ recording: '正在录制，尚未封存', sealed: '已封存', sealing: '正在封存', unreadable: '不可读取' }[value] || value);
const recordingTitle = (item: RunEntry, catalog: MaterialCatalog | null) => catalog?.recordings[item.id]?.name || `${item.kind === 'validate' ? '执行' : '人工示范'}录制 · ${item.createdAt ? new Date(item.createdAt).toLocaleString() : item.id}`;

export function RecordingArchive({ projectId, runs, onReplay, onDiagnostic, onRecovery, exitGuardRef }: Props) {
  const client = useWorkbenchClient();
  const [catalog, setCatalog] = useState<MaterialCatalog | null>(null), [search, setSearch] = useState(''), [removed, setRemoved] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(''), [selected, setSelected] = useState('');
  const [name, setName] = useState(''), [note, setNote] = useState(''), [baseline, setBaseline] = useState({ name: '', note: '' });
  const [usage, setUsage] = useState<RecordingUsageResult | null>(null);
  const scope = useRef({ projectId, generation: 0 }), alive = useRef(true), busyRef = useRef(false), loadSequence = useRef(0), lastSelection = useRef(''), initialSelected = useRef(false);
  if (scope.current.projectId !== projectId) scope.current = { projectId, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const owns = () => alive.current && scope.current.projectId === projectId && scope.current.generation === generation;
  const call = scopedWorkbenchCall(client, { projectId });
  const item = runs.find(value => value.id === selected), entry = catalog?.recordings[selected];
  const dirty = name !== baseline.name || note !== baseline.note;
  const region = useRef<HTMLElement>(null);
  const load = async () => {
    const sequence = ++loadSequence.current;
    const next = await call('materialCatalog');
    if (owns() && sequence === loadSequence.current) setCatalog(next);
  };
  useEffect(() => {
    alive.current = true; initialSelected.current = false; setCatalog(null); setSelected(''); setUsage(null); setError(''); setNotice(''); setSearch(''); setName(''); setNote(''); setBaseline({ name: '', note: '' }); busyRef.current = false; setBusy('读取录制目录');
    void load().catch(failure => { if (owns()) setError(String(failure)); }).finally(() => { if (owns()) setBusy(''); });
    return () => { alive.current = false; ++loadSequence.current; };
  }, [projectId]);
  useEffect(() => {
    if (!initialSelected.current && catalog && runs.length) { initialSelected.current = true; setSelected(runs.find(value => !catalog.recordings[value.id]?.hidden)?.id || ''); }
  }, [catalog, runs, selected]);
  // A stale clean projection must not replace the first editable input.
  useLayoutEffect(() => {
    if (lastSelection.current !== selected || !dirty) { const next = { name: entry?.name || '', note: entry?.note || '' }; setName(next.name); setNote(next.note); setBaseline(next); }
    if (lastSelection.current !== selected) { setUsage(null); if (selected && !region.current?.closest('[hidden]')) { const anchor = region.current?.closest('.archive-center')?.querySelector<HTMLElement>('[data-archive-context-anchor]') || region.current; anchor?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } }
    lastSelection.current = selected;
  }, [selected, entry?.name, entry?.note]);
  const guard = () => {
    if (busyRef.current) { setError('正在处理录制操作，请等待完成后再切换。'); return false; }
    if (dirty) { setError('录制目录有未保存输入，请先保存或取消修改。'); return false; }
    return true;
  };
  useEffect(() => { if (exitGuardRef) exitGuardRef.current = guard; return () => { if (exitGuardRef) exitGuardRef.current = null; }; });
  const choose = (action: () => void) => { if (guard()) { setError(''); setNotice(''); action(); } };
  const perform = async (label: string, action: () => Promise<unknown>) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (owns()) setError(String(failure)); }
    finally { if (owns()) { busyRef.current = false; setBusy(''); } }
  };
  const manage = async (id: string, patch: { hidden?: boolean; name?: string; note?: string }) => {
    if (!catalog) throw new Error('目录尚未读取，请重试读取目录。');
    try {
      const updated = await call('manageMaterialCatalog', { kind: 'recordings', id, expectedCatalogRevision: catalog.catalogRevision, ...patch });
      if (owns()) { setCatalog(updated); setNotice('录制目录已保存；原始录制保持不变。'); }
    } catch (failure) {
      // Refresh the CAS baseline for an explicit retry, while retaining unsaved text.
      try { await load(); } catch { /* The original write failure remains the useful error. */ }
      throw failure;
    }
  };
  const visible = runs.filter(value => (removed || !catalog?.recordings[value.id]?.hidden) && `${catalog?.recordings[value.id]?.name || ''} ${value.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section ref={region} className="recording-archive" aria-label="原始录制存档" aria-busy={!!busy}>
    <div className="archive-toolbar"><h3>原始录制</h3><IconButton icon={RefreshCw} label="刷新录制目录" disabled={!!busy} onClick={() => choose(() => { void perform('读取录制目录', load); })}/></div>
    {error && <p role="alert" className="error-inline">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{busy}…</p>}
    <div className="archive-toolbar"><Label>搜索录制<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称或录制 ID" /></Label><Label className="archive-removed"><input type="checkbox" checked={removed} onChange={event => setRemoved(event.target.checked)} />显示已隐藏录制</Label></div>
    {!catalog ? !busy && <Button onClick={() => void perform('读取录制目录', load)}>重试读取录制目录</Button> : <div className={`archive-catalog-layout${item ? ' has-detail' : ''}`}>
      <div className="archive-directory"><div className="archive-entry-list" aria-label="录制目录">{visible.map(value => <section className="archive-list-entry" data-selected={value.id === selected} key={value.id}><h4>{recordingTitle(value, catalog)}</h4><small>{recordingStatus(value.status)}{catalog.recordings[value.id]?.hidden ? ' · 已隐藏' : ''}</small><Button disabled={!!busy} aria-pressed={selected === value.id} onClick={() => choose(() => setSelected(value.id))}>查看录制详情</Button></section>)}</div>{!visible.length && <div className="catalog-empty"><Film aria-hidden="true"/><strong>{runs.length ? '没有匹配的录制' : '当前项目还没有原始录制'}</strong><p>{runs.length ? '调整搜索或显示已隐藏录制' : '开始并完成一次网页示范后，可在这里查看来源'}</p></div>}</div>
      <div className="archive-detail">{item ? <section aria-label="录制详情"><IconButton icon={ArrowLeft} label="返回录制列表" disabled={!!busy} onClick={() => choose(() => setSelected(''))}/><h3>{recordingTitle(item, catalog)}</h3><p>{recordingStatus(item.status)}</p>{item.status === 'recording' && <p className="archive-readonly-notice">这段录制仍在进行，尚不能作为已封存来源固定进资料版本。</p>}
        <div className="button-row"><Button variant="default" disabled={!!busy || item.status === 'unreadable'} onClick={() => choose(() => { void perform('打开录制回放', () => onReplay(item.id)); })}><Play aria-hidden="true"/>回放录制</Button><Button disabled={!!busy} onClick={() => void perform('读取使用位置', async () => { const result = await call('recordingUsage', { recordingId: item.id }); if (owns()) setUsage(result); })}>查看使用位置</Button></div>
        {usage && <section aria-label="录制使用位置"><h4>被哪些资料使用</h4>{usage.revisions.map(value => <p key={value.revisionId}>存档 V{value.displayNumber ?? '—'} · {value.cards} 张保存点</p>)}{usage.drafts.map(value => <p key={value.draftId}>{value.name} · {value.cards} 张保存点</p>)}{!usage.revisions.length && !usage.drafts.length && <p>目前没有资料引用。</p>}</section>}
        <form className="archive-metadata-form" onSubmit={event => { event.preventDefault(); const next = { name: name.trim(), note }; void perform('保存录制目录', async () => { await manage(item.id, next); if (owns()) { setName(next.name); setBaseline(next); } }); }}><h4>录制目录信息</h4><p className="hint">名称与备注单独保存，不修改原始录制</p><Label>录制名称<Input maxLength={200} value={name} disabled={!!busy} onChange={event => setName(event.target.value)} /></Label><Label>备注<Textarea maxLength={4000} rows={2} value={note} disabled={!!busy} onChange={event => setNote(event.target.value)} /></Label><div className="button-row"><Button variant="default" type="submit" disabled={!!busy || !dirty}>保存录制目录</Button><Button type="button" disabled={!!busy || !dirty} onClick={() => { setName(entry?.name || ''); setNote(entry?.note || ''); setBaseline({ name: entry?.name || '', note: entry?.note || '' }); setError(''); }}>取消录制修改</Button>{dirty && <small>未保存</small>}</div></form>
        <details className="archive-identity"><summary>录制管理与诊断</summary><p>录制 ID：{item.id}</p><div className="button-row"><Button disabled={!!busy} onClick={() => choose(() => { void perform('更新录制目录', () => manage(item.id, { hidden: !entry?.hidden })); })}>{entry?.hidden ? '恢复录制' : '隐藏录制'}</Button><Button disabled={!!busy} onClick={() => choose(() => { void onDiagnostic(item.id).catch(failure => { if (owns()) setError(String(failure)); }); })}>原件诊断</Button><Button disabled={!!busy} onClick={() => choose(() => onRecovery(item.id))}>检查/重建索引</Button></div><p className="hint">隐藏可恢复；历史引用仍保留。原件诊断与索引重建不编辑资料版本。</p></details>
      </section> : <div className="catalog-empty"><Film aria-hidden="true"/><p>选择录制以回放和管理目录</p></div>}</div>
    </div>}
  </section>;
}
