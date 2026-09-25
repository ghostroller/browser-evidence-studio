import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointCard, MaterialAnnotation, MaterialField, MaterialRequirement } from '@/contracts/materials';
import type { HistoricalTarget, ReplayPosition } from '@/contracts/recording';
import type { DataRule, FieldSourceProof } from '@/contracts/workflow';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';

type Collection = 'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs';
type Page<T> = { items: T[]; nextCursor?: string; outputTruncated: boolean };
type Draft = { draftId: string; draftRevision: number; baseRevisionId?: string; status?: string; counts?: Record<string, number> };
type Revision = { revisionId: string; contentHash: string; status?: string; createdAt?: string };
type Edit = { operation: 'upsert'; collection: Exclude<Collection, 'recordingRefs'>; item: unknown }
  | { operation: 'remove'; collection: Exclude<Collection, 'recordingRefs'>; id: string }
  | { operation: 'recordings'; recordingRefs: string[] }
  | { operation: 'copy-checkpoint' | 'remove-checkpoint'; checkpointId: string }
  | { operation: 'move-checkpoint'; checkpointId: string; position: ReplayPosition };
const COLLECTIONS: Collection[] = ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'];
const empty = (): Record<Collection, Page<any>> => ({ requirements: { items: [], outputTruncated: false }, fields: { items: [], outputTruncated: false },
  checkpoints: { items: [], outputTruncated: false }, annotations: { items: [], outputTruncated: false }, recordingRefs: { items: [], outputTruncated: false } });
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const unique = (values: string[]) => [...new Set(values)];

/** A bounded, version-aware editor. Every mutation is checked against B's draftRevision. */
export function MaterialWorkbench({ projectId, recordingId, position, selectedTarget, onOpenReplay, onSelectTarget }: {
  projectId: string; recordingId?: string; position?: ReplayPosition | null; selectedTarget?: HistoricalTarget | null;
  onOpenReplay(position: ReplayPosition): void; onSelectTarget(kind: 'field' | 'annotation', checkpointId?: string): void;
}) {
  const [drafts, setDrafts] = useState<Page<Draft>>({ items: [], outputTruncated: false });
  const [revisions, setRevisions] = useState<Page<Revision>>({ items: [], outputTruncated: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pages, setPages] = useState(empty);
  const [cardId, setCardId] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<'observation' | 'requirement'>('observation');
  const [requirementIds, setRequirementIds] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [rulesJson, setRulesJson] = useState('[]');
  const [fieldId, setFieldId] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [fieldDescription, setFieldDescription] = useState('');
  const [fieldDataset, setFieldDataset] = useState('');
  const [fieldPath, setFieldPath] = useState('');
  const [fieldPolicy, setFieldPolicy] = useState<MaterialField['sourcePolicy']>('any-evidenced');
  const [fieldValueType, setFieldValueType] = useState<MaterialField['valueType'] | ''>('');
  const [sourceProofJson, setSourceProofJson] = useState('');
  const [fieldTarget, setFieldTarget] = useState<HistoricalTarget | null>(null);
  const [fieldAnnotationId, setFieldAnnotationId] = useState('');
  const [annotationText, setAnnotationText] = useState('');
  const [interpretation, setInterpretation] = useState<MaterialAnnotation['interpretation']>('observed');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<Draft | null>(null);
  const listRequest = useRef(0);
  const selectionRequest = useRef(0);
  const writeRequest = useRef(0);
  const pendingRef = useRef(false);
  const scopeRef = useRef(projectId);
  scopeRef.current = projectId;
  const draftRef = useRef<Draft | null>(null);
  const selectedDraft = (scope: string, token: number, id: string, revision?: number) => scopeRef.current === scope &&
    selectionRequest.current === token && draftRef.current?.draftId === id && (revision === undefined || draftRef.current.draftRevision === revision);
  const resetEditor = () => {
    setCardId(''); setTitle(''); setNotes(''); setKind('observation'); setRequirementIds('');
    setRequirementId(''); setRequirementDescription(''); setRulesJson('[]');
    setFieldId(''); setFieldName(''); setFieldDescription(''); setFieldDataset(''); setFieldPath('');
    setFieldPolicy('any-evidenced'); setFieldValueType(''); setSourceProofJson(''); setFieldTarget(null); setFieldAnnotationId('');
    setAnnotationText(''); setConflict(null); setNotice('');
  };
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, ...body }), [projectId]);
  const refreshLists = useCallback(async () => {
    const token = ++listRequest.current;
    try { const [nextDrafts, nextRevisions] = await Promise.all([
      call('materialDrafts', { limit: 50, maxBytes: 24576 }), call('materialRevisions', { limit: 50, maxBytes: 24576 }),
    ]);
      if (token === listRequest.current && scopeRef.current === projectId) { setDrafts(nextDrafts); setRevisions(nextRevisions); }
    } catch (failure) { if (token === listRequest.current && scopeRef.current === projectId) setError(String(failure)); }
  }, [call, projectId]);
  const loadCollection = useCallback(async (selected: Draft, collection: Collection, token: number, cursor?: string) => {
    const result: Page<any> = await call('materialCollection', { kind: 'draft', draftId: selected.draftId, collection, cursor, limit: 50, maxBytes: 24576 });
    if (scopeRef.current !== projectId || selectionRequest.current !== token || draftRef.current?.draftId !== selected.draftId || draftRef.current.draftRevision !== selected.draftRevision) return;
    setPages(current => ({ ...current, [collection]: cursor ? current[collection].nextCursor === cursor
      ? { ...result, items: [...current[collection].items, ...result.items] } : current[collection] : result }));
  }, [call, projectId]);
  const openDraft = useCallback(async (id: string) => {
    const token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = false; setPending('');
    draftRef.current = null; setDraft(null); setPages(empty()); resetEditor();
    try { const selected: Draft = await call('materialDraft', { draftId: id });
      if (token !== selectionRequest.current || scopeRef.current !== projectId) return;
      draftRef.current = selected; setDraft(selected);
      await Promise.all(COLLECTIONS.map(collection => loadCollection(selected, collection, token)));
    } catch (failure) { if (token === selectionRequest.current && scopeRef.current === projectId) setError(String(failure)); }
  }, [call, loadCollection]);
  useEffect(() => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; pendingRef.current = false;
    draftRef.current = null; setDraft(null); setDrafts({ items: [], outputTruncated: false }); setRevisions({ items: [], outputTruncated: false });
    setPages(empty()); resetEditor(); setPending(''); setError('');
    void refreshLists();
    return () => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; };
  }, [projectId, refreshLists]);
  useEffect(() => {
    if (!selectedTarget) return;
    setFieldTarget(selectedTarget);
  }, [selectedTarget]);
  const mutate = async (edits: Edit[], message: string, expected = draftRef.current): Promise<boolean> => {
    if (!expected || pendingRef.current || draftRef.current?.draftId !== expected.draftId || draftRef.current.draftRevision !== expected.draftRevision) return false;
    pendingRef.current = true;
    const scope = projectId, selection = selectionRequest.current, write = ++writeRequest.current;
    const activeWrite = () => scopeRef.current === scope && selectionRequest.current === selection && write === writeRequest.current && draftRef.current?.draftId === expected.draftId;
    const current = () => activeWrite() && draftRef.current?.draftRevision === expected.draftRevision;
    setPending('保存资料'); setError(''); setConflict(null);
    try {
      const result = await call('editMaterialDraft', { draftId: expected.draftId, expectedDraftRevision: expected.draftRevision, edits });
      if (!current()) return false;
      if (result.status === 'conflict') { setConflict(result.current); setError(`草稿已由其他操作更新：本地修订 ${expected.draftRevision}，当前修订 ${result.current.draftRevision}。请重新读取后再编辑。`); return false; }
      draftRef.current = result.draft; setDraft(result.draft); setNotice(message); setPages(empty());
      await Promise.all(COLLECTIONS.map(collection => loadCollection(result.draft, collection, selection)));
      return scopeRef.current === scope && selectionRequest.current === selection && write === writeRequest.current;
    } catch (failure) { if (activeWrite()) setError(String(failure)); return false; }
    finally { if (scopeRef.current === scope && selectionRequest.current === selection && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const card = pages.checkpoints.items.find((item: CheckpointCard) => item.id === cardId) as CheckpointCard | undefined;
  const selectCard = (item: CheckpointCard) => {
    setCardId(item.id); setTitle(item.title); setNotes(item.notes); setKind(item.kind); setRequirementIds(item.requirementIds.join(', '));
    onOpenReplay(item.anchor);
  };
  const currentRequirements = pages.requirements.items as MaterialRequirement[];
  const allRecordingRefs = async (selected: Draft) => {
    let cursor: string | undefined;
    const result: string[] = [];
    do {
      const page: Page<string> = await call('materialCollection', { kind: 'draft', draftId: selected.draftId, collection: 'recordingRefs', cursor, limit: 100, maxBytes: 24576 });
      result.push(...page.items); cursor = page.nextCursor;
      if (result.length > 2000) throw new Error('录制引用超过编辑上限。');
    } while (cursor);
    return result;
  };
  const selectedRequirement = currentRequirements.find(item => item.id === requirementId);
  const selectedField = (pages.fields.items as MaterialField[]).find(item => item.id === fieldId);
  const saveCard = async () => {
    const selected = draftRef.current;
    if (!selected) return;
    const scope = projectId, token = selectionRequest.current;
    if (!position && !card) { setError('先在可靠的历史时间轴上选择位置。'); return; }
    const anchor = card?.anchor ?? position!;
    const next: CheckpointCard = { id: card?.id ?? newId('checkpoint'), kind, anchor, capturedAt: card?.capturedAt ?? new Date(anchor.sourceTimeMs).toISOString(),
      createdAt: card?.createdAt ?? new Date().toISOString(), title: title.trim(), notes, requirementIds: unique(requirementIds.split(/[,，\s]+/).filter(Boolean)), annotationIds: card?.annotationIds ?? [] };
    if (!next.title) { setError('输入 checkpoint 标题。'); return; }
    if (next.requirementIds.some(id => !currentRequirements.some(requirement => requirement.id === id))) { setError('先创建所引用的需求。'); return; }
    let refs: string[];
    try { refs = await allRecordingRefs(selected); }
    catch (failure) { if (selectedDraft(scope, token, selected.draftId, selected.draftRevision)) setError(`录制引用读取失败：${String(failure)}`); return; }
    const edits: Edit[] = [...(!refs.includes(anchor.recordingId) ? [{ operation: 'recordings' as const, recordingRefs: [...refs, anchor.recordingId] }] : []),
      { operation: 'upsert', collection: 'checkpoints', item: next }];
    if (await mutate(edits, card ? '已更新 checkpoint 草稿。' : '已在历史位置新增 checkpoint 草稿。', selected)) setCardId(next.id);
  };
  const saveRequirement = async () => {
    const description = requirementDescription.trim();
    if (!description) { setError('输入需求含义。'); return; }
    const id = selectedRequirement?.id ?? newId('requirement');
    let rules: DataRule[];
    try { rules = JSON.parse(rulesJson); if (!Array.isArray(rules)) throw new Error('规则必须是数组。'); }
    catch (failure) { setError(`规则 JSON 无效：${String(failure)}`); return; }
    if (await mutate([{ operation: 'upsert', collection: 'requirements', item: { id, description, dataset: selectedRequirement?.dataset,
      rules, fieldIds: selectedRequirement?.fieldIds ?? [] } satisfies MaterialRequirement }], '需求已保存到草稿。')) setRequirementId(id);
  };
  const saveField = async () => {
    if (!selectedRequirement) { setError('先选择一个需求。'); return; }
    if (!fieldName.trim() || !fieldDescription.trim() || !fieldDataset.trim()) { setError('字段需要数据集、名称和明确含义。'); return; }
    const id = selectedField?.id ?? newId('field');
    const target = fieldTarget;
    let sourceProof: FieldSourceProof | undefined;
    try { sourceProof = sourceProofJson.trim() ? JSON.parse(sourceProofJson) : undefined; }
    catch (failure) { setError(`来源规则 JSON 无效：${String(failure)}`); return; }
    const field: MaterialField = { ...(selectedField || {}), id, dataset: fieldDataset.trim(), name: fieldName.trim(), description: fieldDescription.trim(),
      sourcePolicy: fieldPolicy };
    if (fieldPath.trim()) field.outputPath = fieldPath.trim(); else delete field.outputPath;
    if (sourceProof) field.sourceProof = sourceProof; else delete field.sourceProof;
    if (fieldValueType) field.valueType = fieldValueType; else delete field.valueType;
    if (target) {
      const changed = JSON.stringify(target) !== JSON.stringify(selectedField?.target);
      field.target = target;
      if (changed) { field.bindingStatus = 'bound'; field.annotationId = undefined; field.checkpointId = card?.id; }
    } else { delete field.target; delete field.bindingStatus; delete field.checkpointId; delete field.annotationId; }
    if (fieldAnnotationId) {
      const annotation = (pages.annotations.items as MaterialAnnotation[]).find(item => item.id === fieldAnnotationId);
      if (!annotation || !target || JSON.stringify(annotation.target) !== JSON.stringify(target)) { setError('字段注释必须绑定相同的历史元素；继续读取注释列表或重新选择。'); return; }
      field.annotationId = annotation.id; field.checkpointId = annotation.checkpointId;
    } else delete field.annotationId;
    if (target && card && JSON.stringify(target.position) !== JSON.stringify(card.anchor)) { setError('字段元素必须来自所选卡片的精确历史位置。'); return; }
    const requirement = { ...selectedRequirement, fieldIds: unique([...selectedRequirement.fieldIds, id]) };
    if (await mutate([{ operation: 'upsert', collection: 'fields', item: field }, { operation: 'upsert', collection: 'requirements', item: requirement }], '字段和需求关联已保存。')) setFieldId(id);
  };
  const saveAnnotation = async () => {
    if (!card || !selectedTarget || !annotationText.trim()) { setError('选择卡片的历史元素并填写注释。'); return; }
    if (JSON.stringify(selectedTarget.position) !== JSON.stringify(card.anchor)) { setError('注释元素必须来自卡片的精确历史位置。'); return; }
    const id = newId('annotation');
    const annotation: MaterialAnnotation = { id, checkpointId: card.id, target: selectedTarget, text: annotationText.trim(), author: 'human', interpretation, bindingStatus: 'bound' };
    if (await mutate([{ operation: 'upsert', collection: 'annotations', item: annotation },
      { operation: 'upsert', collection: 'checkpoints', item: { ...card, annotationIds: [...card.annotationIds, id] } }], '历史元素注释已保存。')) setAnnotationText('');
  };
  const publish = async () => {
    const selected = draftRef.current;
    if (!selected || pendingRef.current) return;
    pendingRef.current = true;
    const scope = projectId, token = selectionRequest.current, write = ++writeRequest.current;
    const current = () => selectedDraft(scope, token, selected.draftId, selected.draftRevision) && write === writeRequest.current;
    setPending('发布版本'); setError('');
    try {
      const revision = await call('publishMaterialDraft', { draftId: selected.draftId, expectedDraftRevision: selected.draftRevision });
      if (!current()) return;
      await openDraft(selected.draftId); await refreshLists();
      if (scopeRef.current === scope && draftRef.current?.draftId === selected.draftId) setNotice(`已发布候选资料版本 ${revision.revisionId}；发布不表示人工验收通过。`);
    } catch (failure) { if (current()) setError(String(failure)); }
    finally { if (scopeRef.current === scope && token === selectionRequest.current && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const createDraft = async () => {
    if (pendingRef.current) return;
    const scope = projectId, token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = true; draftRef.current = null;
    setDraft(null); setPages(empty()); resetEditor(); setPending('新建草稿'); setError('');
    try { const created: Draft = await call('createMaterialDraft');
      if (scopeRef.current !== scope || selectionRequest.current !== token) return;
      await openDraft(created.draftId); await refreshLists();
    } catch (failure) { if (scopeRef.current === scope && selectionRequest.current === token) setError(String(failure)); }
    finally { if (scopeRef.current === scope && selectionRequest.current === token) { pendingRef.current = false; setPending(''); } }
  };
  const moreList = async (kind: 'drafts' | 'revisions', cursor: string) => {
    const scope = projectId, token = listRequest.current;
    try { if (kind === 'drafts') {
      const page: Page<Draft> = await call('materialDrafts', { cursor, limit: 50, maxBytes: 24576 });
      if (scopeRef.current === scope && listRequest.current === token) setDrafts(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
    } else {
      const page: Page<Revision> = await call('materialRevisions', { cursor, limit: 50, maxBytes: 24576 });
      if (scopeRef.current === scope && listRequest.current === token) setRevisions(previous => previous.nextCursor === cursor ? { ...page, items: [...previous.items, ...page.items] } : previous);
    } } catch (failure) { if (scopeRef.current === scope && listRequest.current === token) setError(String(failure)); }
  };
  const moreCollection = async (selected: Draft, collection: Collection, cursor: string) => {
    const scope = projectId, token = selectionRequest.current;
    try { await loadCollection(selected, collection, token, cursor); }
    catch (failure) { if (selectedDraft(scope, token, selected.draftId, selected.draftRevision)) setError(String(failure)); }
  };
  return <div className="material-workbench">
    <div className="material-toolbar"><strong>任务资料</strong><span className="muted">草稿可编辑 · 发布后按固定 hash 读取</span><Button disabled={!!pending} onClick={() => void refreshLists().catch(failure => setError(String(failure)))}>刷新列表</Button></div>
    {error && <p className="error-inline" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {conflict && <Button onClick={() => void openDraft(conflict.draftId).catch(failure => setError(String(failure)))}>读取修订 {conflict.draftRevision} 并处理冲突</Button>}
    <div className="material-layout"><aside className="material-list"><div className="section-label">草稿 <Button disabled={!!pending} onClick={() => void createDraft()}>新建</Button></div>
      {drafts.items.map(item => <Button key={item.draftId} disabled={item.status === 'unavailable'} className={draft?.draftId === item.draftId ? 'selected' : ''} onClick={() => void openDraft(item.draftId).catch(failure => setError(String(failure)))}>{item.draftId.slice(0, 15)} · r{item.draftRevision ?? '—'}</Button>)}
      {drafts.nextCursor && <Button onClick={() => void moreList('drafts', drafts.nextCursor!)}>更多草稿</Button>}
      <div className="section-label">固定版本</div>{revisions.items.map(item => <div key={item.revisionId} className="material-revision"><code>{item.revisionId.slice(0, 15)}</code><small>{item.contentHash?.slice(0, 12) || item.status}</small></div>)}
      {revisions.nextCursor && <Button onClick={() => void moreList('revisions', revisions.nextCursor!)}>更多版本</Button>}
    </aside><div className="material-editor">{!draft ? <div className="empty">新建或打开资料草稿，编辑历史 checkpoint、需求和字段。</div> : <>
      <div className="material-toolbar"><code>{draft.draftId}</code><span>修订 {draft.draftRevision}</span><Button disabled={!!pending} onClick={() => void publish()}>{pending || '发布候选版本'}</Button></div>
      <section><h3>历史 checkpoint</h3><p className="hint">在时间轴可靠位置新增；移动后旧绑定保留为待复核。</p><div className="material-card-list">{(pages.checkpoints.items as CheckpointCard[]).map(item => <Button key={item.id} className={cardId === item.id ? 'selected' : ''} onClick={() => selectCard(item)}>{item.title}<small>{item.anchor.recordingId.slice(0, 12)} · #{item.anchor.eventSeq}</small></Button>)}</div>
      {pages.checkpoints.nextCursor && <Button onClick={() => void moreCollection(draft, 'checkpoints', pages.checkpoints.nextCursor!)}>下一页 checkpoint</Button>}
      <div className="material-actions"><Button onClick={() => { setCardId(''); setTitle(''); setNotes(''); setRequirementIds(''); }}>新建卡片</Button>{card && <><Button disabled={!!pending} onClick={() => void mutate([{ operation: 'copy-checkpoint', checkpointId: card.id }], '卡片与注释已复制为独立 ID。')}>复制</Button><Button disabled={!position || !!pending} onClick={() => position && void mutate([{ operation: 'move-checkpoint', checkpointId: card.id, position }], '已移动历史位置；旧元素绑定需复核。')}>移至当前时间</Button><Button disabled={!!pending} onClick={() => void mutate([{ operation: 'remove-checkpoint', checkpointId: card.id }], '已移除卡片；共享需求仍保留。')}>删除卡片</Button></>}</div>
      <div className="form-stack"><Label>标题<Input value={title} onChange={event => setTitle(event.target.value)} /></Label><Label>类型<NativeSelect value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="observation">观察</option><option value="requirement">需求示例</option></NativeSelect></Label><Label>说明<Textarea value={notes} onChange={event => setNotes(event.target.value)} /></Label><Label>关联需求 ID<Input value={requirementIds} onChange={event => setRequirementIds(event.target.value)} /></Label><Button disabled={!!pending || (!card && !position)} onClick={() => void saveCard()}>保存卡片草稿</Button></div>
      {card && <><h4>元素注释</h4><p className="hint">检查入口指向这张卡片的历史时间；取消选择不会写入资料。</p><Button onClick={() => onSelectTarget('annotation', card.id)}>在历史页选择元素</Button><Label>注释<Textarea value={annotationText} onChange={event => setAnnotationText(event.target.value)} /></Label><Label>解释层级<NativeSelect value={interpretation} onChange={event => setInterpretation(event.target.value as typeof interpretation)}><option value="observed">观察</option><option value="inferred">推断</option><option value="unverified">未验证</option></NativeSelect></Label><Button disabled={!selectedTarget || !annotationText.trim() || !!pending} onClick={() => void saveAnnotation()}>保存注释</Button>
        {selectedTarget && <SourceTargetPreview projectId={projectId} target={selectedTarget} />}
        {(pages.annotations.items as MaterialAnnotation[]).filter(item => item.checkpointId === card.id).map(item => <p key={item.id} className="material-annotation">{item.text} · {item.interpretation} · {item.bindingStatus}</p>)}</>}
      </section><section><h3>共享需求与字段</h3><p className="hint">多次示范可引用同一需求；删除示例卡片不会删除要求。字段可只写说明，也可绑定元素，注释可选。</p>
      <Label>需求<NativeSelect value={requirementId} onChange={event => { const id = event.target.value; const selected = currentRequirements.find(item => item.id === id); setRequirementId(id); setRequirementDescription(selected?.description || ''); setRulesJson(JSON.stringify(selected?.rules || [], null, 2)); setFieldId(''); setFieldName(''); setFieldDescription(''); setFieldDataset(''); setFieldPath(''); setFieldTarget(null); setFieldAnnotationId(''); setSourceProofJson(''); }}><option value="">新需求</option>{currentRequirements.map(item => <option key={item.id} value={item.id}>{item.description.slice(0, 70)}</option>)}</NativeSelect></Label><Label>需求说明<Textarea value={requirementDescription} onChange={event => setRequirementDescription(event.target.value)} /></Label><details><summary>数据范围与核验规则</summary><Label>规则 JSON<Textarea className="code-input" rows={4} value={rulesJson} onChange={event => setRulesJson(event.target.value)} /></Label></details><Button disabled={!!pending} onClick={() => void saveRequirement()}>保存需求</Button>{pages.requirements.nextCursor && <Button onClick={() => void moreCollection(draft, 'requirements', pages.requirements.nextCursor!)}>更多需求</Button>}
      <Label>字段<NativeSelect value={fieldId} onChange={event => { const selected = (pages.fields.items as MaterialField[]).find(item => item.id === event.target.value); setFieldId(selected?.id || ''); setFieldName(selected?.name || ''); setFieldDescription(selected?.description || ''); setFieldDataset(selected?.dataset || ''); setFieldPath(selected?.outputPath || ''); setFieldPolicy(selected?.sourcePolicy || 'any-evidenced'); setFieldValueType(selected?.valueType || ''); setSourceProofJson(selected?.sourceProof ? JSON.stringify(selected.sourceProof, null, 2) : ''); setFieldTarget(selected?.target || null); setFieldAnnotationId(selected?.annotationId || ''); }}><option value="">新字段</option>{(pages.fields.items as MaterialField[]).map(item => <option key={item.id} value={item.id}>{item.dataset}.{item.name}</option>)}</NativeSelect></Label>
      <div className="material-grid"><Label>数据集<Input value={fieldDataset} onChange={event => setFieldDataset(event.target.value)} /></Label><Label>字段名<Input value={fieldName} onChange={event => setFieldName(event.target.value)} /></Label></div><Label>明确含义<Textarea value={fieldDescription} onChange={event => setFieldDescription(event.target.value)} /></Label><Label>输出 JSON Pointer（可选）<Input value={fieldPath} onChange={event => setFieldPath(event.target.value)} placeholder="/records/0/amount" /></Label><div className="material-grid"><Label>值类型<NativeSelect value={fieldValueType} onChange={event => setFieldValueType(event.target.value as MaterialField['valueType'] | '')}><option value="">未指定</option>{['string','number','boolean','object','array','null'].map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect></Label><Label>来源要求<NativeSelect value={fieldPolicy} onChange={event => setFieldPolicy(event.target.value as MaterialField['sourcePolicy'])}><option value="any-evidenced">任一有证据来源</option><option value="page-displayed">必须按页面显示值</option></NativeSelect></Label></div><details><summary>固定来源约束</summary><p className="hint">json-record 与 dom-text 都只固定数据验证规则；示范值不会成为输出常量。</p><Label>来源规则 JSON<Textarea className="code-input" rows={5} value={sourceProofJson} onChange={event => setSourceProofJson(event.target.value)} /></Label></details>
      <div className="material-actions"><Button disabled={!card} onClick={() => onSelectTarget('field', card?.id)}>从历史页绑定元素</Button>{fieldTarget && <><span className="muted">{fieldTarget.kind === 'dom-node' ? `节点 ${fieldTarget.nodeId}` : '截图区域（非 DOM）'}</span><Button onClick={() => { setFieldTarget(null); setFieldAnnotationId(''); }}>取消绑定</Button></>}</div>
      {fieldTarget && <Label>关联元素注释（可选）<NativeSelect value={fieldAnnotationId} onChange={event => setFieldAnnotationId(event.target.value)}><option value="">无注释</option>{(pages.annotations.items as MaterialAnnotation[]).filter(item => JSON.stringify(item.target) === JSON.stringify(fieldTarget)).map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 70)}</option>)}</NativeSelect></Label>}
      <Button disabled={!selectedRequirement || !!pending} onClick={() => void saveField()}>保存字段</Button>{pages.fields.nextCursor && <Button onClick={() => void moreCollection(draft, 'fields', pages.fields.nextCursor!)}>更多字段</Button>}
      </section></>}</div></div>
  </div>;
}

function SourceTargetPreview({ projectId, target }: { projectId: string; target: HistoricalTarget }) {
  const [node, setNode] = useState<any>(null);
  const [locators, setLocators] = useState<any[]>([]);
  const [error, setError] = useState('');
  const token = useRef(0);
  const identity = JSON.stringify(target);
  useEffect(() => {
    const current = ++token.current;
    setNode(null); setLocators([]); setError('');
    if (target.kind !== 'dom-node') return;
    void Promise.all([
      window.studio.call('historicalNode', { projectId, target, maxBytes: 24576, limit: 10 }),
      window.studio.call('historicalLocators', { projectId, target, maxBytes: 24576, limit: 10 }),
    ]).then(([source, candidates]) => {
      if (current === token.current) { setNode(source); setLocators(candidates.items || []); }
    }).catch(failure => { if (current === token.current) setError(String(failure)); });
    return () => { ++token.current; };
  }, [projectId, identity]);
  if (target.kind === 'visual-region') return <p className="notice">截图区域仅是视觉引用，不能生成 DOM 定位器或声称页面字段已在 DOM 验证。</p>;
  return <div className="source-target"><strong>原始源结构 · 节点 {target.nodeId}</strong><small>{target.position.recordingId} / {target.position.documentId} / event #{target.position.eventSeq}</small>
    {error && <p className="error-inline">源节点暂不可读：{error}</p>}
    {node && <><p>{node.tagName} · {node.metadataComplete ? '元数据完整' : '元数据不完整'}</p><p>源文本：{node.text?.status === 'present' ? String(node.text.value).slice(0, 180) : node.text?.status || '未知'}</p>
      <p>显示采样：{node.presentation?.status === 'present' ? `${node.presentation.value.visibility} · ${String(node.presentation.value.text).slice(0, 100)}` : node.presentation?.status || '未取样'}</p>
      <div>{Object.entries(node.attributes || {}).slice(0, 8).map(([key, value]) => <small key={key}>{key} = {(value as any).status === 'present' ? String((value as any).value).slice(0, 100) : (value as any).status}</small>)}</div></>}
    {locators.length > 0 && <details><summary>原始属性推导的候选定位器（{locators.length}）</summary>{locators.map((item, index) => <p key={index}><code>{item.steps?.map((step: any) => `${step.strategy}:${step.expression}`).join(' → ')}</code><small>{item.historical?.status} · {item.warnings?.join('、') || '无额外警告'}</small></p>)}</details>}
  </div>;
}
