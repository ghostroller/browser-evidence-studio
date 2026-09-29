import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointCard, MaterialAnnotation, MaterialField, MaterialRequirement } from '@/contracts/materials';
import { sameReplayPosition, type HistoricalTarget, type ReplayPosition } from '@/contracts/recording';
import type { WorkspaceView } from '@/contracts/workspace';
import type { DataRule, FieldSourceProof } from '@/contracts/workflow';
import type { SelectionReceipt, SelectionRequest } from '@/renderer/selection-session';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';

type EditorPart = 'brief' | 'card' | 'requirement' | 'field' | 'annotation' | 'link';
type Collection = 'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs';
type Page<T> = { items: T[]; nextCursor?: string; outputTruncated: boolean };
type Draft = { name?: string; hidden?: boolean; current?: boolean; taskBrief?: { objective: string; scope: string }; draftId: string; draftRevision: number; baseRevisionId?: string; status?: string; counts?: Record<string, number> };
type Revision = { displayNumber?: number; name?: string; revisionId: string; contentHash: string; status?: string; createdAt?: string };
type Edit = { operation: 'upsert'; collection: Exclude<Collection, 'recordingRefs'>; item: unknown }
  | { operation: 'remove'; collection: Exclude<Collection, 'recordingRefs'>; id: string }
  | { operation:'field-binding';fieldId:string;binding:{kind:'keep'|'clear'}|{kind:'set';target:HistoricalTarget;checkpointId:string;annotationId?:string} }
  | { operation: 'task-brief'; taskBrief: { objective: string; scope: string } }
  | { operation: 'add-field-example'; fieldId: string; example: import('@/contracts/materials').FieldExample }
  | { operation: 'remove-field-example'; fieldId: string; exampleId: string }
  | { operation: 'recordings'; recordingRefs: string[] }
  | { operation: 'copy-checkpoint' | 'remove-checkpoint'; checkpointId: string }
  | { operation: 'move-checkpoint'; checkpointId: string; position: ReplayPosition };
const COLLECTIONS: Collection[] = ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'];
const empty = (): Record<Collection, Page<any>> => ({ requirements: { items: [], outputTruncated: false }, fields: { items: [], outputTruncated: false },
  checkpoints: { items: [], outputTruncated: false }, annotations: { items: [], outputTruncated: false }, recordingRefs: { items: [], outputTruncated: false } });
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const unique = (values: string[]) => [...new Set(values)];
const endedCapture = (value: any) => !value || ['not-captured','source-expired','interrupted'].includes(value.stage);
const locksEditor = (value: any) => !endedCapture(value) && !value.paused;

/** A bounded, version-aware editor. Every mutation is checked against B's draftRevision. */
export function MaterialWorkbench({ projectId, recordingId, position, selectedTarget, onOpenReplay, onSelectTarget, live, liveScope, liveSelection, onLiveSelect, onCancelLive, onPublished, view = 'checkpoints', recordingArchive, onEditWorkspace, onStartRecording, transitionRef }: {
  transitionRef?: React.MutableRefObject<(()=>Promise<boolean>)|null>; view?: WorkspaceView; recordingArchive?: React.ReactNode; onEditWorkspace?():void; onStartRecording?():Promise<void>;
  projectId: string; recordingId?: string; position?: ReplayPosition | null; selectedTarget?: SelectionReceipt | null;
  live?:boolean; liveScope?:{pageId:string;generation:number;leaseEpoch:number}; liveSelection?:any; onLiveSelect?(selectionId:string):Promise<void>; onCancelLive?():Promise<void>; onPublished?(id:string):void;
  onOpenReplay(position: ReplayPosition): void; onSelectTarget(request: SelectionRequest): void;
}) {
  const [drafts, setDrafts] = useState<Page<Draft>>({ items: [], outputTruncated: false });
  const [revisions, setRevisions] = useState<Page<Revision>>({ items: [], outputTruncated: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pages, setPages] = useState(empty);
  const entityCache = useRef<Record<string, Record<string, any>>>({});
  const [, renderEntities] = useState(0);
  const [editor, setEditor] = useState<'summary'|'card'|'field'|'annotation'|'requirement'|'brief'>('summary');
  const [search, setSearch] = useState('');
  const [sourceFilter,setSourceFilter]=useState('');
  const ownerIds=useRef<Record<string,string[]>>({});
  const [briefObjective, setBriefObjective] = useState('');
  const [briefScope, setBriefScope] = useState('');
  const [appendExample, setAppendExample] = useState(false);
  const [catalog, setCatalog] = useState<import('@/contracts/workspace').MaterialCatalog|null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [discardPrompt,setDiscardPrompt]=useState(false);
  const [compareFrom, setCompareFrom] = useState('');
  const [differences, setDifferences] = useState<any[]>([]);
  const publication=useRef<{draftId:string;draftRevision:number;operationId:string}|null>(null);
  const [archiveName, setArchiveName] = useState('');
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [archiveImpact, setArchiveImpact] = useState<string[]>([]);
  const entity = <T,>(collection: Collection, id: string): T|undefined => entityCache.current[collection]?.[id] as T|undefined;
  const cacheItems = (collection: Collection, values: any[]) => { if(collection!=='recordingRefs') for(const item of values) { entityCache.current[collection] ??= {}; entityCache.current[collection][item.id] = item; } };

  const [archiveTab, setArchiveTab] = useState<'revisions'|'recordings'|'drafts'>('revisions');
  const [viewedRevision,setViewedRevision]=useState<Revision|null>(null);
  const [viewedPages,setViewedPages]=useState(empty);
  const [cardId, setCardId] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<'observation' | 'requirement'>('observation');
  const [cardRequirementIds, setCardRequirementIds] = useState<string[]>([]);
  const [newCardRequirement, setNewCardRequirement] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [rulesJson, setRulesJson] = useState('[]');
  const [fieldId, setFieldId] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [fieldDescription, setFieldDescription] = useState('');
  const [fieldDataset, setFieldDataset] = useState('records');
  const [confirmClear,setConfirmClear]=useState(false);
  const [bindingAction,setBindingAction]=useState<'keep'|'set'|'clear'>('keep');
  const [liveIntent,setLiveIntent]=useState<string|null>(null);
  const liveScopeRef=useRef(liveScope);
  const liveRequest=useRef(0);
  const retryCapture=useRef<any>(null);
  const [retryVersion,setRetryVersion]=useState(0);
  const [recoveryOperations,setRecoveryOperations]=useState<any[]>([]);
  const setRetryCapture=(value:any)=>{retryCapture.current=value;setRetryVersion(version=>version+1);};
  const consumedSample=useRef('');
  const dirty=useRef(new Set<EditorPart>());
  const cacheConflict=useRef<number|null>(null);
  const markDirty=(part:EditorPart)=>{dirty.current.add(part);};
  const [fieldPath, setFieldPath] = useState('');
  const [fieldPolicy, setFieldPolicy] = useState<MaterialField['sourcePolicy']>('any-evidenced');
  const [fieldValueType, setFieldValueType] = useState<MaterialField['valueType'] | ''>('');
  const [sourceProofJson, setSourceProofJson] = useState('');
  const [technicalDirty,setTechnicalDirty]=useState(false);
  const [fieldTarget, setFieldTarget] = useState<HistoricalTarget | null>(null);
  const [fieldCheckpointId,setFieldCheckpointId]=useState('');
  const [fieldAnnotationId, setFieldAnnotationId] = useState('');
  const [annotationId, setAnnotationId] = useState('');
  const [annotationTarget, setAnnotationTarget] = useState<HistoricalTarget | null>(null);
  const [annotationText, setAnnotationText] = useState('');
  const [interpretation, setInterpretation] = useState<MaterialAnnotation['interpretation']>('observed');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mapping,setMapping]=useState<any>(null);
  const [conflict, setConflict] = useState<Draft | null>(null);
  const listRequest = useRef(0);
  const revisionRequest=useRef(0);
  const selectionRequest = useRef(0);
  const pendingSelection = useRef<SelectionRequest | null>(null);
  const writeRequest = useRef(0);
  const pendingRef = useRef(false);
  const changingEditor = useRef(false);
  const scopeRef = useRef(projectId);
  scopeRef.current = projectId;
  const editorSession=useRef({projectId,sequence:0});
  if(editorSession.current.projectId!==projectId)editorSession.current={projectId,sequence:editorSession.current.sequence+1};
  const editorSessionId=editorSession.current.sequence;
  const ownsSession=()=>scopeRef.current===projectId&&editorSession.current.sequence===editorSessionId;
  const draftRef = useRef<Draft | null>(null);
  const selectedDraft = (scope: string, token: number, id: string, revision?: number) => scopeRef.current === scope &&
    selectionRequest.current === token && draftRef.current?.draftId === id && (revision === undefined || draftRef.current.draftRevision === revision);
  const resetEditor = () => {
    pendingSelection.current = null;liveRequest.current++;dirty.current.clear();cacheConflict.current=null;setRetryCapture(null);setRecoveryOperations([]);consumedSample.current='';setLiveIntent(null);setMapping(null);setBindingAction('keep');setTechnicalDirty(false);setConfirmClear(false);
    entityCache.current={};ownerIds.current={};setSourceFilter('');setEditor('summary');setAppendExample(false);publication.current=null;
    setCardId(''); setTitle(''); setNotes(''); setKind('observation'); setCardRequirementIds([]);setNewCardRequirement('');
    setRequirementId(''); setRequirementDescription(''); setRulesJson('[]');
    setFieldId(''); setFieldName(''); setFieldDescription(''); setFieldDataset(''); setFieldPath('');
    setFieldPolicy('any-evidenced'); setFieldValueType(''); setSourceProofJson(''); setFieldTarget(null); setFieldCheckpointId('');setFieldAnnotationId('');
    setAnnotationId(''); setAnnotationTarget(null); setAnnotationText(''); setInterpretation('observed'); setConflict(null); setNotice('');
  };
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, ...body }), [projectId]);
  const refreshLists = useCallback(async () => {
    if(!ownsSession())return;
    const token = ++listRequest.current;
    try { const [nextDrafts, nextRevisions] = await Promise.all([
      call('materialDrafts', { limit: 50, maxBytes: 24576 }), call('materialRevisions', { limit: 50, maxBytes: 24576 }),
    ]);
      if (token === listRequest.current && ownsSession()) { setDrafts(nextDrafts); void call('materialCatalog').then(value=>{if(token===listRequest.current&&ownsSession())setCatalog(value);}).catch(failure=>{if(ownsSession())setError(String(failure));}); setRevisions({...nextRevisions,items:[...nextRevisions.items].sort((a:any,b:any)=>String(b.createdAt).localeCompare(String(a.createdAt)))}); }
    } catch (failure) { if (token === listRequest.current && ownsSession()) setError(String(failure)); }
  }, [call, projectId, editorSessionId]);
  const loadCollection = useCallback(async (selected: Draft, collection: Collection, token: number, cursor?: string) => {
    if(!ownsSession()||selectionRequest.current!==token)return;
    const result: Page<any> = await call('materialCollection', { kind: 'draft', draftId: selected.draftId, collection, cursor, limit: 50, maxBytes: 24576 });
    if (!ownsSession() || selectionRequest.current !== token || draftRef.current?.draftId !== selected.draftId || draftRef.current.draftRevision !== selected.draftRevision) return;
    cacheItems(collection, result.items);
    setPages(current => ({ ...current, [collection]: cursor ? current[collection].nextCursor === cursor
      ? { ...result, items: [...current[collection].items, ...result.items] } : current[collection] : result }));
  }, [call, projectId, editorSessionId]);
  const openDraft = useCallback(async (id: string, preserve=false) => {
    if(!ownsSession()||(pendingRef.current&&!preserve))return;
    const token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = false; setPending('');
    draftRef.current = null; setDraft(null); setPages(empty()); setPending('读取工作副本'); if(!preserve){resetEditor();setViewedRevision(null);}
    try { const selected: Draft = await call('materialDraft', { draftId: id });
      if (token !== selectionRequest.current || !ownsSession()) return;
      if(!preserve){try{const raw=localStorage.getItem(`bes.editor.${projectId}.${id}`);if(raw){const saved=JSON.parse(raw);publication.current=saved.publication??null;setEditor(saved.editor??'card');setBriefObjective(saved.briefObjective??selected.taskBrief?.objective??'');setBriefScope(saved.briefScope??selected.taskBrief?.scope??'');setCardId(saved.cardId);setTitle(saved.title);setNotes(saved.notes);setKind(saved.kind);setCardRequirementIds(saved.cardRequirementIds);setNewCardRequirement(saved.newCardRequirement);setRequirementId(saved.requirementId);setRequirementDescription(saved.requirementDescription);setRulesJson(saved.rulesJson);setFieldId(saved.fieldId);setFieldName(saved.fieldName);setFieldDescription(saved.fieldDescription);setFieldDataset(saved.fieldDataset);setFieldPath(saved.fieldPath);setFieldPolicy(saved.fieldPolicy);setFieldValueType(saved.fieldValueType);setSourceProofJson(saved.sourceProofJson);setTechnicalDirty(saved.technicalDirty??false);setFieldTarget(saved.fieldTarget);setFieldCheckpointId(saved.fieldCheckpointId??'');setFieldAnnotationId(saved.fieldAnnotationId);setAnnotationId(saved.annotationId);setAnnotationTarget(saved.annotationTarget);setAnnotationText(saved.annotationText);setInterpretation(saved.interpretation);setBindingAction(saved.bindingAction);if(saved.draftRevision!==selected.draftRevision||!Array.isArray(saved.dirty)){cacheConflict.current=saved.draftRevision??-1;setConflict(selected);setNotice('已恢复本机输入，但版本或缓存格式不同；请先读取当前修订并核对，再保存或发布。');}dirty.current=new Set(saved.dirty??[...(saved.cardId?['card']:[]),...(saved.requirementId?['requirement']:[]),...(saved.fieldName?['field']:[]),...(saved.annotationText?['annotation']:[])]);setRetryCapture(saved.retryCapture?.projectId===projectId&&saved.retryCapture?.draftId===id?saved.retryCapture:null);}}catch{setNotice('本机编辑恢复记录不可读；已保留原记录，当前显示服务端草稿。');}}
      if(!preserve&&!localStorage.getItem(`bes.editor.${projectId}.${id}`)){setBriefObjective(selected.taskBrief?.objective??'');setBriefScope(selected.taskBrief?.scope??'');}
      draftRef.current = selected; setDraft(selected);if(preserve){cacheConflict.current=null;setConflict(null);}else if(cacheConflict.current===null)setConflict(null);
      await Promise.all(COLLECTIONS.map(collection => loadCollection(selected, collection, token)));
      if(!preserve){
        const write=writeRequest.current;
        const recovery=await call('authoringRecovery',{draftId:id});
        if(token!==selectionRequest.current||write!==writeRequest.current||!ownsSession())return;
        if(!retryCapture.current&&recovery.items?.length){setRetryCapture(recovery.items[0]);setRecoveryOperations(recovery.items.slice(1));}
        else setRecoveryOperations((recovery.items??[]).filter((item:any)=>item.operationId!==retryCapture.current?.operationId));
        if(recovery.outputTruncated||recovery.warnings?.length)setError('采集恢复日志未完整读取；已保留原记录。'+(recovery.warnings??[]).join(' '));
      }
    } catch (failure) { if (token === selectionRequest.current && ownsSession()) setError(String(failure)); }
    finally { if(token===selectionRequest.current&&ownsSession())setPending(''); }
  }, [call, loadCollection, editorSessionId]);
  useEffect(() => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; pendingRef.current = false;
    ++revisionRequest.current;setViewedRevision(null);setViewedPages(empty());
    draftRef.current = null; setDraft(null); setDrafts({ items: [], outputTruncated: false }); setRevisions({ items: [], outputTruncated: false });
    setPages(empty()); resetEditor(); setPending(''); setError('');
    if(projectId)void refreshLists();
    const bootstrap=selectionRequest.current;
    if(projectId)void call("workingMaterialDraft").then(value=>{if(ownsSession()&&selectionRequest.current===bootstrap)return openDraft(value.draftId);}).catch(failure=>{if(ownsSession()&&selectionRequest.current===bootstrap)setError(String(failure));});
    return () => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; };
  }, [projectId, refreshLists]);
  useEffect(()=>{
    if(!draft||draftRef.current?.draftId!==draft.draftId||scopeRef.current!==projectId)return;
    try{localStorage.setItem(`bes.editor.${projectId}.${draft.draftId}`,JSON.stringify({publication:publication.current,editor,briefObjective,briefScope,draftRevision:cacheConflict.current??draft.draftRevision,cardId,title,notes,kind,cardRequirementIds,newCardRequirement,requirementId,requirementDescription,rulesJson,fieldId,fieldName,fieldDescription,fieldDataset,fieldPath,fieldPolicy,fieldValueType,sourceProofJson,fieldTarget,fieldCheckpointId,fieldAnnotationId,annotationId,annotationTarget,annotationText,interpretation,bindingAction,technicalDirty,dirty:[...dirty.current],retryCapture:retryCapture.current}));localStorage.setItem(`bes.activeDraft.${projectId}`,draft.draftId);}
    catch{setNotice('本机未提交输入暂时无法持久化，请先保存草稿再退出。');}
  },[projectId,draft,cardId,title,notes,kind,cardRequirementIds,newCardRequirement,requirementId,requirementDescription,rulesJson,fieldId,fieldName,fieldDescription,fieldDataset,fieldPath,fieldPolicy,fieldValueType,sourceProofJson,fieldTarget,fieldCheckpointId,fieldAnnotationId,annotationId,annotationTarget,annotationText,interpretation,bindingAction,technicalDirty,retryVersion,editor,briefObjective,briefScope]);
  useEffect(() => {
    if (!selectedTarget) return;
    const request=pendingSelection.current, received=selectedTarget.request, selected=draftRef.current;
    if(!request||!selected)return;
    if(request.selectionId!==received.selectionId||request.projectId!==projectId||request.projectId!==received.projectId||
      request.draftId!==selected.draftId||request.draftId!==received.draftId||request.expectedDraftRevision!==selected.draftRevision||
      request.expectedDraftRevision!==received.expectedDraftRevision||request.checkpointId!==cardId||request.checkpointId!==received.checkpointId||
      request.purpose!==received.purpose||request.annotationId!==received.annotationId||request.fieldId!==received.fieldId||
      !sameReplayPosition(request.anchor,received.anchor)||!sameReplayPosition(request.anchor,selectedTarget.target.position)||
      request.annotationId!==(annotationId||undefined)&&request.purpose==='annotation'||request.fieldId!==(fieldId||undefined)&&request.purpose==='field')return;
    pendingSelection.current=null;
    if(request.purpose==='annotation'){markDirty('annotation');setAnnotationTarget(selectedTarget.target);}
    else {markDirty('field');setEditor('field');setFieldTarget(selectedTarget.target);setFieldCheckpointId(request.checkpointId);setBindingAction('set');setFieldAnnotationId('');}
  }, [selectedTarget]);
  const beginSelection=(purpose:'annotation'|'field')=>{
    const selected=draftRef.current, card=entity<CheckpointCard>('checkpoints',cardId);
    if(!selected||!card){setError('先打开草稿并选择历史卡片。');return;}
    const request:SelectionRequest={selectionId:crypto.randomUUID(),projectId,draftId:selected.draftId,expectedDraftRevision:selected.draftRevision,
      checkpointId:card.id,anchor:card.anchor,purpose,...(purpose==='annotation'&&annotationId?{annotationId}:{}),...(purpose==='field'&&fieldId?{fieldId}:{})};
    pendingSelection.current=request;setError('');onSelectTarget(request);
  };
  const mutate = async (edits: Edit[], message: string, expected = draftRef.current, ownLock=false, hold=false): Promise<Draft|null> => {
    if (!ownsSession() || !expected || (pendingRef.current&&!ownLock) || draftRef.current?.draftId !== expected.draftId || draftRef.current.draftRevision !== expected.draftRevision) return null;
    pendingRef.current = true;
    const scope = projectId, selection = selectionRequest.current, write = ++writeRequest.current;
    const activeWrite = () => ownsSession() && selectionRequest.current === selection && write === writeRequest.current && draftRef.current?.draftId === expected.draftId;
    const current = () => activeWrite() && draftRef.current?.draftRevision === expected.draftRevision;
    setPending('保存资料'); setError(''); setConflict(null);
    try {
      const result = await call('editMaterialDraft', { draftId: expected.draftId, expectedDraftRevision: expected.draftRevision, edits });
      if (!current()) return null;
      if (result.status === 'conflict') { setConflict(result.current); setError(`草稿已由其他操作更新：本地修订 ${expected.draftRevision}，当前修订 ${result.current.draftRevision}。请重新读取后再编辑。`); return null; }
      draftRef.current = result.draft; setDraft(result.draft); setNotice(message); setPages(empty());
      await Promise.all(COLLECTIONS.map(collection => loadCollection(result.draft, collection, selection)));
      for (const [collection, id] of [['checkpoints', cardId], ['fields', fieldId], ['requirements', requirementId], ['annotations', annotationId]] as const) {
        if (!id || !activeWrite()) continue;
        try { const value = await call('materialEntity', { kind:'draft', draftId:result.draft.draftId, collection, entityId:id }); if(activeWrite()&&value?.draftRevision===result.draft.draftRevision)cacheItems(collection,[value.item]); }
        catch (failure) { if (!edits.some(edit=>('id' in edit&&edit.id===id)||('checkpointId' in edit&&edit.operation==='remove-checkpoint'&&edit.checkpointId===id))) throw failure; delete entityCache.current[collection]?.[id]; }
      }
      if (activeWrite() && result.focus?.collection==='checkpoints') {
        const value=await call('materialEntity',{kind:'draft',draftId:result.draft.draftId,collection:'checkpoints',entityId:result.focus.id});
        if(activeWrite()){cacheItems('checkpoints',[value.item]);setCardId(value.item.id);setTitle(value.item.title);setNotes(value.item.notes);setKind(value.item.kind);setCardRequirementIds(value.item.requirementIds);setEditor('card');}
      }
      renderEntities(value=>value+1);
      return ownsSession() && selectionRequest.current === selection && write === writeRequest.current ? result.draft : null;
    } catch (failure) { if (activeWrite()) setError(String(failure)); return null; }
    finally { if (!hold && ownsSession() && selectionRequest.current === selection && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const card = entity<CheckpointCard>('checkpoints',cardId);
  const prepareEditorTransition=(capture=false)=>saveEditor(undefined,false,capture?new Set([...dirty.current].filter(part=>['card','link','annotation'].includes(part))):undefined);
  const changeEditor=async(change:()=>void|Promise<void>)=>{
    if(pendingRef.current||changingEditor.current||!ownsSession())return;
    if(liveIntent||locksEditor(retryCapture.current)){setError('请先完成或取消当前选择，再切换编辑对象。');return;}
    changingEditor.current=true;
    try{
      if(dirty.current.size&&!await prepareEditorTransition())return;
      if(!ownsSession())return;
      setPending('读取编辑对象');await change();
    }catch(failure){if(ownsSession())setError(String(failure));}
    finally{changingEditor.current=false;if(ownsSession())setPending('');}
  };
  const readEntity = async <T,>(collection: Collection, id: string): Promise<T> => {
    const selected=draftRef.current, token=selectionRequest.current;
    if(!selected)throw new Error('工作副本尚未准备');
    const value=await call('materialEntity',{kind:'draft',draftId:selected.draftId,collection,entityId:id});
    if(!ownsSession()||selectionRequest.current!==token||draftRef.current?.draftRevision!==selected.draftRevision)throw new Error('编辑上下文已切换');
    if(value.draftRevision!==selected.draftRevision)throw new Error('资料已更新，请重新读取工作副本');
    cacheItems(collection,[value.item]);if(collection==='fields')ownerIds.current[id]=value.ownerRequirementIds??[];renderEntities(value=>value+1);return value.item as T;
  };
  const selectCard = (id: string) => changeEditor(async()=>{
    const item=await readEntity<CheckpointCard>('checkpoints',id);
    await Promise.all(item.requirementIds.map(id=>readEntity<MaterialRequirement>('requirements',id)));
    pendingSelection.current=null;
    setCardId(item.id);setTitle(item.title);setNotes(item.notes);setKind(item.kind);setCardRequirementIds(item.requirementIds);setNewCardRequirement('');
    setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');setEditor('summary');
  });
  const currentRequirements = Object.values(entityCache.current.requirements??{}) as MaterialRequirement[];
  const loadRequirement=async(id:string)=>{const selected=id?await readEntity<MaterialRequirement>('requirements',id):undefined;setRequirementId(id);setRequirementDescription(selected?.description||'');setRulesJson(JSON.stringify(selected?.rules||[],null,2));};
  const selectRequirement=(id:string)=>{
    // A dirty field without an owner must be able to acquire one. Flushing it
    // before this selection would require precisely the identity being chosen.
    if(!requirementId&&id&&dirty.current.has('field')&&!dirty.current.has('requirement')){
      if(pendingRef.current||!ownsSession()||liveIntent||locksEditor(retryCapture.current))return;
      const owner=selectionRequest.current;
      void prepareEditorTransition(true).then(saved=>{if(saved&&ownsSession()&&selectionRequest.current===owner){pendingSelection.current=null;loadRequirement(id);}});return;
    }
    changeEditor(async()=>{pendingSelection.current=null;await loadRequirement(id);setFieldId('');setFieldName('');setFieldDescription('');setFieldDataset('');setFieldPath('');setFieldTarget(null);setFieldCheckpointId('');setFieldAnnotationId('');setSourceProofJson('');});
  };
  const selectField=(id:string)=>{
    const inferOwner=!dirty.current.has('requirement');
    changeEditor(async()=>{
      pendingSelection.current=null;const selected=id?await readEntity<MaterialField>('fields',id):undefined;
      const owners=ownerIds.current[id]??currentRequirements.filter(item=>item.fieldIds.includes(id)).map(item=>item.id);
      if(selected&&inferOwner){if(owners.length===1)await loadRequirement(owners[0]);else if(!owners.includes(requirementId))await loadRequirement('');}
      setEditor('field');setAppendExample(false);setBindingAction('keep');setTechnicalDirty(false);setFieldId(selected?.id||'');setFieldName(selected?.name||'');setFieldDescription(selected?.description||'');setFieldDataset(selected?.dataset||'records');setFieldPath(selected?.outputPath||'');setFieldPolicy(selected?.sourcePolicy||'any-evidenced');setFieldValueType(selected?.valueType||'');setSourceProofJson(selected?.sourceProof?JSON.stringify(selected.sourceProof,null,2):'');setFieldTarget(selected?.target||null);setFieldCheckpointId(selected?.checkpointId||'');setFieldAnnotationId(selected?.annotationId||'');
    });
  };
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
  let visibleRules:DataRule[]|null=null;
  try{const parsed=JSON.parse(rulesJson);if(Array.isArray(parsed)&&parsed.every(rule=>rule&&typeof rule==='object'&&typeof rule.type==='string'))visibleRules=parsed;}catch{/* Preserve invalid advanced input until the author corrects it. */}
  const updateSimpleRule=(type:'row-count'|'unique',rule:DataRule|null)=>{
    if(!visibleRules){setError('请先修正高级规则 JSON，再使用普通范围设置。');return;}
    const next=[...visibleRules],index=next.findIndex(item=>item.type===type);
    if(index<0){if(rule)next.push(rule);}else if(rule)next[index]=rule;else next.splice(index,1);
    markDirty('requirement');setRulesJson(JSON.stringify(next,null,2));
  };
  const selectedField = entity<MaterialField>('fields',fieldId);
  useEffect(()=>{if(selectedField&&!technicalDirty){setFieldPath(selectedField.outputPath||'');setSourceProofJson(selectedField.sourceProof?JSON.stringify(selectedField.sourceProof,null,2):'');}},[selectedField?.outputPath,JSON.stringify(selectedField?.sourceProof),fieldId]);
  // Freeze one render's dirty patches and expected revision. Relationships are
  // composed once, then the service validates the resulting graph in one CAS.
  const saveEditor=async(force?:EditorPart,hold=false,onlyParts?:Set<EditorPart>):Promise<Draft|null>=>{
    const expected=draftRef.current,token=selectionRequest.current;
    if(!ownsSession()||!expected||pendingRef.current)return null;
    if(cacheConflict.current!==null){setError('本机恢复输入需要先读取当前修订并核对，尚未保存或发布。');return null;}
    const parts=new Set<EditorPart>(onlyParts??(force?[force,...(force==='field'&&dirty.current.has('requirement')?['requirement' as const]:[]),...(['link','annotation'].includes(force)&&dirty.current.has('card')?['card' as const]:[])]:dirty.current));
    if(!parts.size)return expected;
    pendingRef.current=true;setPending('保存编辑快照');setError('');
    const current=()=>ownsSession()&&selectionRequest.current===token&&draftRef.current?.draftId===expected.draftId;
    try{
      const edits:Edit[]=[];
      if(parts.has('brief'))edits.push({operation:'task-brief',taskBrief:{objective:briefObjective,scope:briefScope}});
      let nextCard=card?structuredClone(card):undefined;
      let nextRequirement=selectedRequirement?structuredClone(selectedRequirement):undefined;
      let linkedRequirement:MaterialRequirement|undefined;
      let nextField:MaterialField|undefined,nextAnnotation:MaterialAnnotation|undefined;
      if(parts.has('card')){
        const anchor=card?.anchor??position;if(!anchor)throw new Error('先在可靠的历史时间轴上选择位置。');
        if(!title.trim())throw new Error('输入 checkpoint 标题。');
        if(cardId&&!card)throw new Error('当前卡片尚未加载，不能将它当作新卡片保存。');
        nextCard={...card,id:card?.id??newId('checkpoint'),kind,anchor,capturedAt:card?.capturedAt??new Date(anchor.sourceTimeMs).toISOString(),createdAt:card?.createdAt??new Date().toISOString(),title:title.trim(),notes,requirementIds:unique(cardRequirementIds),annotationIds:card?.annotationIds??[]};
      }
      if(parts.has('requirement')){
        if(requirementId&&!selectedRequirement)throw new Error('当前需求尚未加载。');
        if(!requirementDescription.trim())throw new Error('输入需求含义。');
        const rules=JSON.parse(rulesJson);if(!Array.isArray(rules))throw new Error('规则必须是数组。');
        nextRequirement={...selectedRequirement,id:selectedRequirement?.id??newId('requirement'),description:requirementDescription.trim(),rules,fieldIds:selectedRequirement?.fieldIds??[]};
      }
      if(parts.has('link')){
        if(!nextCard||!newCardRequirement.trim())throw new Error('先选择卡片并输入新需求的含义。');
        linkedRequirement={id:newId('requirement'),description:newCardRequirement.trim(),rules:[],fieldIds:[]};nextCard.requirementIds=unique([...nextCard.requirementIds,linkedRequirement.id]);
      }
      if(parts.has('annotation')){
        if(!nextCard||!annotationText.trim())throw new Error('选择卡片并填写注释；元素可选。');
        if(annotationTarget&&!sameReplayPosition(annotationTarget.position,nextCard.anchor))throw new Error('注释元素必须来自卡片的精确历史位置。');
        const existing=entity<MaterialAnnotation>('annotations',annotationId);
        if(annotationId&&!existing)throw new Error('当前注释尚未加载。');
        nextAnnotation={id:annotationId||newId('annotation'),checkpointId:nextCard.id,...(annotationTarget?{target:annotationTarget}:{}),text:annotationText.trim(),author:'human',interpretation,bindingStatus:annotationTarget?'bound':'none'};
        nextCard.annotationIds=unique([...nextCard.annotationIds,nextAnnotation.id]);
      }
      if(parts.has('field')){
        if(!nextRequirement) {
          if(currentRequirements.length>1)throw new Error('请按业务名称选择此字段所属需求。');
          nextRequirement=currentRequirements.length===1?structuredClone(currentRequirements[0]):{id:newId('requirement'),description:requirementDescription.trim()||'当前保存点的数据要求',dataset:fieldDataset||'records',rules:[],fieldIds:[]};
        }
        if(nextCard){nextCard.requirementIds=unique([...nextCard.requirementIds,nextRequirement.id]);}

        if(fieldId&&!selectedField)throw new Error('当前字段尚未加载。');
        if(!fieldName.trim()||!fieldDescription.trim()||!fieldDataset.trim())throw new Error('字段需要数据集、名称和明确含义。');
        nextField={...selectedField,id:selectedField?.id??newId('field'),dataset:fieldDataset.trim(),name:fieldName.trim(),description:fieldDescription.trim(),sourcePolicy:fieldPolicy};
        if(technicalDirty||!selectedField){if(fieldPath.trim())nextField.outputPath=fieldPath.trim();else delete nextField.outputPath;if(sourceProofJson.trim())nextField.sourceProof=JSON.parse(sourceProofJson);else delete nextField.sourceProof;}
        if(fieldValueType)nextField.valueType=fieldValueType;else delete nextField.valueType;
        const target=bindingAction==='clear'?null:bindingAction==='keep'?(selectedField?.target??fieldTarget):fieldTarget;
        if(target&&!appendExample){nextField.target=target;if(bindingAction==='set'){const bindingCard=fieldCheckpointId?(entity<CheckpointCard>('checkpoints',fieldCheckpointId)??await readEntity<CheckpointCard>('checkpoints',fieldCheckpointId)):nextCard;if(!bindingCard||!sameReplayPosition(target.position,bindingCard.anchor))throw new Error('字段元素必须来自其保存点的精确历史位置。');nextField.checkpointId=bindingCard.id;nextField.bindingStatus='bound';delete nextField.annotationId;}}
        if(fieldAnnotationId){const annotation=nextAnnotation?.id===fieldAnnotationId?nextAnnotation:(pages.annotations.items as MaterialAnnotation[]).find(item=>item.id===fieldAnnotationId);if(!annotation||JSON.stringify(annotation.target)!==JSON.stringify(target))throw new Error('字段注释必须绑定相同的历史元素。');nextField.annotationId=annotation.id;nextField.checkpointId=annotation.checkpointId;}
        else if(bindingAction!=='keep')delete nextField.annotationId;
        nextRequirement.fieldIds=unique([...nextRequirement.fieldIds,nextField.id]);
      }
      if(nextCard&&(parts.has('card')||parts.has('annotation')||parts.has('link')||parts.has('field'))){
        const refs=await allRecordingRefs(expected);if(!current())return null;
        if(!refs.includes(nextCard.anchor.recordingId))edits.push({operation:'recordings',recordingRefs:[...refs,nextCard.anchor.recordingId]});
        edits.push({operation:'upsert',collection:'checkpoints',item:nextCard});
      }
      if(nextAnnotation){
        const existing=(pages.annotations.items as MaterialAnnotation[]).find(item=>item.id===nextAnnotation.id);
        if(existing&&JSON.stringify(existing.target)!==JSON.stringify(nextAnnotation.target)){
          for(const field of pages.fields.items as MaterialField[])if(field.annotationId===nextAnnotation.id){
            if(nextField?.id===field.id){if(bindingAction!=='set'){delete nextField.annotationId;nextField.bindingStatus='needs-rebind';}}
            else edits.push({operation:'upsert',collection:'fields',item:{...field,annotationId:undefined,bindingStatus:'needs-rebind'}});
          }
        }
        edits.push({operation:'upsert',collection:'annotations',item:nextAnnotation});
      }
      if(nextField)edits.push({operation:'upsert',collection:'fields',item:nextField});
      if(nextRequirement&&(parts.has('requirement')||parts.has('field')))edits.unshift({operation:'upsert',collection:'requirements',item:nextRequirement});
      if(linkedRequirement)edits.unshift({operation:'upsert',collection:'requirements',item:linkedRequirement});
      if(nextField&&appendExample&&fieldTarget&&fieldCheckpointId)edits.push({operation:'add-field-example',fieldId:nextField.id,example:{id:newId('example'),checkpointId:fieldCheckpointId,target:fieldTarget,bindingStatus:'bound'}});
      if(nextField&&!appendExample)edits.push({operation:'field-binding',fieldId:nextField.id,binding:bindingAction==='set'&&fieldTarget&&nextField.checkpointId?{kind:'set',target:fieldTarget,checkpointId:nextField.checkpointId,...(fieldAnnotationId?{annotationId:fieldAnnotationId}:{})}:{kind:bindingAction==='clear'?'clear':'keep'}});
      if(!current())return null;
      const receipt=await mutate(edits,'编辑快照已保存到草稿。',expected,true,hold);if(!receipt||!current())return null;
      for(const part of parts)dirty.current.delete(part);if(nextCard)setCardId(nextCard.id);if(nextAnnotation)setAnnotationId(nextAnnotation.id);
      if(nextRequirement&&(parts.has('requirement')||parts.has('field'))){setRequirementId(nextRequirement.id);setRequirementDescription(nextRequirement.description);setRulesJson(JSON.stringify(nextRequirement.rules,null,2));}
      if(linkedRequirement){setNewCardRequirement('');setCardRequirementIds(nextCard!.requirementIds);}
      if(nextField){setAppendExample(false);setFieldId(nextField.id);setBindingAction('keep');setTechnicalDirty(false);}
      return receipt;
    }catch(failure){if(current())setError(failure instanceof Error?failure.message:String(failure));return null;}
    finally{if(current()&&(!hold||dirty.current.size)){pendingRef.current=false;setPending('');}}
  };
  const saveCard=()=>saveEditor('card');
  const saveRequirement=()=>saveEditor('requirement');
  const saveField=async()=>{if(await saveEditor('field'))setEditor('summary');};
  const createAndLinkRequirement=()=>saveEditor('link');
  const recordCurrent=async(selection=false)=>{
    if(!ownsSession()||!draftRef.current||pendingRef.current)return;
    const transitionOwner=selectionRequest.current;
    const previous=retryCapture.current;
    const expected=previous?draftRef.current:await prepareEditorTransition(true);
    if(!expected||!ownsSession()||selectionRequest.current!==transitionOwner){if(selection&&ownsSession()){setLiveIntent(null);await onCancelLive?.();}return;}
    const token=selectionRequest.current,write=++writeRequest.current;
    const current=()=>ownsSession()&&selectionRequest.current===token&&writeRequest.current===write&&draftRef.current?.draftId===expected.draftId;
    pendingRef.current=true;setPending('保存当前结果');setError('');
    try{
      const request=previous??{projectId,operationId:crypto.randomUUID(),draftId:expected.draftId,title:selection?'字段现场示例':'当前结果',selection,purpose:selection?'field':'observation',fieldId:selection?fieldId:undefined,selectionId:liveIntent,...(selection?liveScopeRef.current:{}),derivedFrom:selection?cardId:undefined};
      setRetryCapture({...request,stage:'unknown'});
      let result=previous?await call('authoringOperation',request):null;if(!current())return;
      if(result?.stage==='source-expired'||result?.stage==='interrupted'){setRetryCapture({...request,stage:result.stage});setError(result.reason||'原采集已中断或来源过期；请重新选择，已保存原件仍保留。');return;}
      if(result?.stage==='acquiring'||result?.stage==='unknown'){setRetryCapture({...request,stage:result.stage});setError(result.reason||'采集结果尚未确认；请查询操作状态，不会再次采集。');return;}
      if(request.paused){if(result?.stage==='receipt-saved')result=await call('captureAndAuthor',request);if(!current())return;setRetryCapture({...request,stage:result?.stage??'unknown',recovered:result?.stage==='associated'?result:undefined});if(result?.draft){draftRef.current=result.draft;setDraft(result.draft);await Promise.all(COLLECTIONS.map(collection=>loadCollection(result.draft,collection,token)));}if(current())setNotice('已查询原操作；当前输入保留。已保存的样例可显式绑定到当前字段。');return;}
      if(result?.stage!=='associated')result=await call('captureAndAuthor',request);if(!current())return;
      if(result.status==='partial'){setRetryCapture({...request,stage:result.stage??(result.receiptId?'receipt-saved':'unknown')});setError([result.reason,result.error].filter(Boolean).join(' '));return;}setRetryCapture(null);
      draftRef.current=result.draft;setDraft(result.draft);
      await Promise.all(COLLECTIONS.map(collection=>loadCollection(result.draft,collection,token)));if(!current())return;
      await refreshLists();if(!current())return;
      setCardId(result.card.id);setTitle(result.card.title);setNotes(result.card.notes);setKind(result.card.kind);setCardRequirementIds(result.card.requirementIds);setNewCardRequirement('');setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');
      if(request.purpose==='field'||request.selection){setEditor('field');setFieldId(request.fieldId??'');markDirty('field');setFieldTarget(result.target);setFieldCheckpointId(result.card.id);setBindingAction('set');setFieldAnnotationId('');if(!fieldDataset)setFieldDataset('records');}
      setNotice(request.selection?'已固化点击时刻；这是新的现场示例，旧保存点未移动。':'已保存原始材料并关联同一张可编辑保存点。');
    }catch(failure){if(current()){
      const request=retryCapture.current;
      try{const status=await call('authoringOperation',request);if(current())setRetryCapture({...request,stage:status.stage});}catch{if(current())setRetryCapture({...request,stage:'unknown'});}
      if(current())setError(String(failure)+(retryCapture.current?.stage==='unknown'?'；结果未知，请查询操作状态，禁止重复采集。':''));
    }}finally{if(current()){pendingRef.current=false;setPending('');setLiveIntent(null);if(selection)await onCancelLive?.();}}
  };
  useEffect(()=>{
    if(!liveIntent||liveSelection?.selectionId!==liveIntent)return;
    if(liveSelection?.cancelled){setLiveIntent(null);return;}
    const identity=JSON.stringify(liveSelection?.sample?.ref);
    if(!liveSelection?.sample?.ref||consumedSample.current===identity)return;
    consumedSample.current=identity;void recordCurrent(true);
  },[liveSelection,liveIntent]);
  const beginLive=async()=>{if(!ownsSession()||pendingRef.current)return;if(!endedCapture(retryCapture.current)){setError('请先查询并完成已有采集操作，避免重复原件。');return;}setRetryCapture(null);const request=++liveRequest.current;const owner=selectionRequest.current;setError('');consumedSample.current=JSON.stringify(liveSelection?.sample?.ref);const id=crypto.randomUUID();liveScopeRef.current=liveScope;setLiveIntent(id);try{await onLiveSelect?.(id);}catch(failure){if(ownsSession()&&liveRequest.current===request&&selectionRequest.current===owner){setLiveIntent(null);setError(String(failure));}}};
  const saveAnnotation=async()=>{if(await saveEditor('annotation'))setEditor('summary');};
  const editAnnotation=(item:MaterialAnnotation)=>changeEditor(async()=>{
    item=await readEntity<MaterialAnnotation>('annotations',item.id);setEditor('annotation');pendingSelection.current=null;setAnnotationId(item.id);setAnnotationTarget(item.target??null);setAnnotationText(item.text);setInterpretation(item.interpretation);
  });
  const removeAnnotation=async(item:MaterialAnnotation)=>{
    if(!card||item.checkpointId!==card.id)return;
    const affectedFields=(pages.fields.items as MaterialField[]).filter(field=>field.annotationId===item.id).map(field=>({operation:'upsert' as const,collection:'fields' as const,item:{...field,annotationId:undefined}}));
    if(await mutate([{operation:'remove',collection:'annotations',id:item.id},{operation:'upsert',collection:'checkpoints',item:{...card,annotationIds:card.annotationIds.filter(id=>id!==item.id)}},...affectedFields], '注释已从当前草稿删除；固定版本不变。')){
      if(annotationId===item.id){setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');setInterpretation('observed');}
    }
  };
  const publish = async () => {
    if(!ownsSession()||pendingRef.current)return;
    const selected=await saveEditor(undefined,true);
    if (!selected || !ownsSession() || draftRef.current?.draftId!==selected.draftId) return;
    pendingRef.current = true;
    const scope = projectId, token = selectionRequest.current, write = ++writeRequest.current;
    const current = () => ownsSession() && selectedDraft(scope, token, selected.draftId, selected.draftRevision) && write === writeRequest.current;
    setPending('发布版本'); setError('');
    try {
      publication.current??={draftId:selected.draftId,draftRevision:selected.draftRevision,operationId:crypto.randomUUID()};
      const cacheKey=`bes.editor.${projectId}.${selected.draftId}`;localStorage.setItem(cacheKey,JSON.stringify({...JSON.parse(localStorage.getItem(cacheKey)||'{}'),publication:publication.current}));
      const attempt=publication.current;if(attempt.draftId!==selected.draftId)throw new Error('先完成另一工作副本的存档回执查询。');
      const revision = await call('publishMaterialDraft', { draftId: attempt.draftId, expectedDraftRevision: attempt.draftRevision, operationId: attempt.operationId });
      if(archiveName.trim()){const directory=await call('materialCatalog');await call('manageMaterialCatalog',{kind:'revisions',id:revision.revisionId,name:archiveName.trim(),expectedCatalogRevision:directory.catalogRevision});setArchiveName('');}
      if (!current()) return;
      publication.current=null;localStorage.setItem(cacheKey,JSON.stringify({...JSON.parse(localStorage.getItem(cacheKey)||'{}'),publication:null}));
      await openDraft(selected.draftId,true);if(!ownsSession()||draftRef.current?.draftId!==selected.draftId)return;const reopened=selectionRequest.current;await refreshLists();if(!ownsSession()||selectionRequest.current!==reopened||draftRef.current?.draftId!==selected.draftId)return;onPublished?.(revision.revisionId);
      if (ownsSession() && draftRef.current?.draftId === selected.draftId) setNotice(`已保存存档版本 ${revision.revisionId}；发布不表示人工验收通过。`);
    } catch (failure) {
      if (current()) {
        if(publication.current)try{const result=await call('materialPublicationStatus',{operationId:publication.current.operationId});if(current()&&result.stage==='not-started')publication.current=null;}catch{/* Unknown status retains the operation ID. */}
        if(current()){setError(String(failure)+(publication.current?'；上次存档结果待恢复，将按同一操作查询，不会另建重复版本。':''));setRetryVersion(value=>value+1);}
      }
    }
    finally { if (scopeRef.current === scope && token === selectionRequest.current && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const createDraft = async (baseRevisionId?:string) => {
    if (!ownsSession()||pendingRef.current) return;
    if(!await saveEditor())return;
    const scope = projectId, token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = true;
    setPending('新建草稿'); setError('');
    const operationKey=`bes.create.${projectId}.${baseRevisionId??'empty'}`;
    try { const operationId=localStorage.getItem(operationKey)||crypto.randomUUID();localStorage.setItem(operationKey,operationId);
      const created: Draft = await call('createMaterialDraft',{...(baseRevisionId?{baseRevisionId}:{}),operationId});
      if (scopeRef.current !== scope || selectionRequest.current !== token) return;
      if(!ownsSession())return;pendingRef.current=false;await call('setWorkingMaterialDraft',{draftId:created.draftId});await openDraft(created.draftId);await refreshLists();localStorage.removeItem(operationKey);onEditWorkspace?.();
    } catch (failure) { if (scopeRef.current === scope && selectionRequest.current === token) setError(String(failure)); }
    finally { if (scopeRef.current === scope && selectionRequest.current === token) { pendingRef.current = false; setPending(''); } }
  };
  const prepareMapping=async()=>{
    if(!ownsSession()||pendingRef.current)return;
    const saved=await saveEditor();if(!saved||!ownsSession())return;
    const token=selectionRequest.current,write=++writeRequest.current;
    const current=()=>ownsSession()&&selectionRequest.current===token&&writeRequest.current===write&&draftRef.current?.draftId===saved.draftId;
    pendingRef.current=true;setPending('读取实现映射');setError('');
    try{const result=await call('previewImplementation',{draftId:saved.draftId});if(current())setMapping({...result,owner:{projectId,draftId:saved.draftId,editorSessionId,token}});}
    catch(failure){if(current())setError(String(failure));}
    finally{if(current()){pendingRef.current=false;setPending('');}}
  };
  const confirmMapping=async()=>{
    if(!ownsSession()||pendingRef.current||!mapping||mapping.owner?.projectId!==projectId||mapping.owner?.draftId!==draftRef.current?.draftId||mapping.owner?.editorSessionId!==editorSessionId||mapping.owner?.token!==selectionRequest.current)return;
    const expected=draftRef.current!,token=selectionRequest.current,write=++writeRequest.current;
    const current=()=>ownsSession()&&selectionRequest.current===token&&writeRequest.current===write&&draftRef.current?.draftId===expected.draftId;
    pendingRef.current=true;setPending('确认实现映射');setError('');
    try{const result=await call('confirmImplementation',{draftId:expected.draftId,expectedDraftRevision:mapping.draftRevision,proposalHash:mapping.proposalHash});if(!current())return;
      if(result.status!=='saved')throw new Error('映射确认冲突，输入已保留');draftRef.current=result.draft;setDraft(result.draft);
      await Promise.all(COLLECTIONS.map(collection=>loadCollection(result.draft,collection,token)));if(!current())return;
      setMapping(null);setNotice('技术映射已确认；任务含义不变。固定新版本后执行。');
    }catch(failure){if(current())setError(String(failure));}finally{if(current()){pendingRef.current=false;setPending('');}}
  };
  const viewRevision=async(item:Revision)=>{
    if(!ownsSession()||pendingRef.current)return;
    if(!await saveEditor())return;
    const token=++revisionRequest.current,scope=projectId;
    setViewedRevision(null);setViewedPages(empty());setDifferences([]);setError('');
    try{
      const fixed:Revision=await call('materialRevision',{revisionId:item.revisionId,contentHash:item.contentHash});
      if(scopeRef.current!==scope||revisionRequest.current!==token)return;
      if(fixed.revisionId!==item.revisionId||fixed.contentHash!==item.contentHash)throw new Error('固定版本身份或内容 hash 不匹配。');
      const collections=await Promise.all(COLLECTIONS.map(async collection=>[collection,await call('materialCollection',{kind:'revision',revisionId:item.revisionId,contentHash:item.contentHash,collection,limit:50,maxBytes:24576})] as const));
      if(scopeRef.current!==scope||revisionRequest.current!==token)return;
      setViewedRevision({...fixed,displayNumber:item.displayNumber});setViewedPages(Object.fromEntries(collections) as Record<Collection,Page<any>>);
    }catch(failure){if(scopeRef.current===scope&&revisionRequest.current===token)setError(`固定版本读取失败：${String(failure)}`);}
  };
  const moreRevisionCollection=async(collection:Collection,cursor:string)=>{
    const fixed=viewedRevision,scope=projectId,token=revisionRequest.current;if(!fixed)return;
    try{
      const page:Page<any>=await call('materialCollection',{kind:'revision',revisionId:fixed.revisionId,contentHash:fixed.contentHash,collection,cursor,limit:50,maxBytes:24576});
      if(scopeRef.current===scope&&revisionRequest.current===token)setViewedPages(previous=>({...previous,[collection]:previous[collection].nextCursor===cursor?{...page,items:[...previous[collection].items,...page.items]}:previous[collection]}));
    }catch(failure){if(scopeRef.current===scope&&revisionRequest.current===token)setError(String(failure));}
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
  const run = (action:()=>Promise<unknown>) => { void action().catch(failure=>setError(String(failure))); };
  const switchDraft = (id:string) => changeEditor(async()=>{ await call('setWorkingMaterialDraft',{draftId:id}); await openDraft(id); await refreshLists(); onEditWorkspace?.(); });
  const manage = async(kind:'drafts'|'revisions',id:string,patch:{name?:string;hidden?:boolean;note?:string})=>{
    const current=await call('materialCatalog');
    await call('manageMaterialCatalog',{kind,id,expectedCatalogRevision:current.catalogRevision,...patch});await refreshLists();
  };
  const copyWorkingDraft=async(id:string)=>{
    const saved=await saveEditor();if(!saved||!ownsSession())return;
    const key=`bes.copy.${projectId}.${id}`;
    const prior=localStorage.getItem(key);
    const original=await call('materialDraft',{draftId:id});
    const request=prior?JSON.parse(prior):{draftId:id,expectedDraftRevision:original.draftRevision,operationId:crypto.randomUUID()};
    localStorage.setItem(key,JSON.stringify(request));
    const copy=await call('copyMaterialDraft',request);
    if(!ownsSession())return;
    await manage('drafts',copy.draftId,{name:(catalog?.drafts?.[id]?.name||'工作副本')+' 副本'});
    localStorage.removeItem(key);await refreshLists();
  };
  const copyCard = async()=>{ if(!card)return;const id=card.id;const saved=await saveEditor();if(saved)await mutate([{operation:'copy-checkpoint',checkpointId:id}],'已复制并选中新保存点。',saved); };
  const removeCard = async()=>{if(!card)return;const id=card.id;const saved=await saveEditor();if(saved&&await mutate([{operation:'remove-checkpoint',checkpointId:id}],'已移除保存点；原始录制和固定版本保留。',saved)){setCardId('');setEditor('summary');}};
  const newField = ()=>changeEditor(()=>{pendingSelection.current=null;setEditor('field');setAppendExample(false);setFieldId('');setFieldName('');setFieldDescription('');setFieldDataset('records');setFieldPath('');setFieldValueType('');setSourceProofJson('');setFieldTarget(null);setFieldCheckpointId('');setFieldAnnotationId('');setBindingAction('keep');setTechnicalDirty(false);const owners=currentRequirements.filter(item=>card?.requirementIds.includes(item.id));if(owners.length===1)void loadRequirement(owners[0].id);else if(currentRequirements.length===1)void loadRequirement(currentRequirements[0].id);else {setRequirementId('');setRequirementDescription('');setRulesJson('[]');}});
  const newAnnotation=()=>changeEditor(()=>{pendingSelection.current=null;setEditor('annotation');setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');setInterpretation('observed');});
  const prepareArchive=async()=>{if(publication.current){await publish();return;}const saved=await saveEditor();if(!saved)return;const impact=await call('prepareMaterialArchive',{draftId:saved.draftId});const open=impact.recordings.filter((item:any)=>['recording','sealing'].includes(item.status)).map((item:any)=>item.id);setArchiveImpact(open);setArchivePrompt(true);};
  const confirmArchive=async()=>{if(archiveImpact.length){const state=await call('state');if(archiveImpact.length!==1||state.active?.id!==archiveImpact[0]||state.active.projectId!==projectId)throw new Error('存在其他未封存录制，请先在对应环境完成收尾。');await call('seal');}setArchivePrompt(false);await publish();};
  const startCheckpoint=async()=>{if(position){changeEditor(()=>{setCardId('');setTitle('保存点 '+new Date(position.sourceTimeMs).toLocaleTimeString());setNotes('');setKind('observation');setCardRequirementIds([]);setEditor('card');markDirty('card');});}else if(live)await recordCurrent();else if(onStartRecording){await onStartRecording();await recordCurrent();}else throw new Error('请打开环境并开始录制，或暂停历史回放。');};
  useEffect(()=>{if(transitionRef)transitionRef.current=async()=>!!await saveEditor();return()=>{if(transitionRef)transitionRef.current=null;};});
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!viewedRevision)void saveEditor();}if(event.key==='Escape'&&liveIntent){setLiveIntent(null);void onCancelLive?.();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  const fields = Object.values(entityCache.current.fields??{}) as MaterialField[];
  const cardFields=fields.filter(field=>field.checkpointId===cardId||field.examples?.some(example=>example.checkpointId===cardId)||card?.requirementIds.some(id=>currentRequirements.find(req=>req.id===id)?.fieldIds.includes(field.id)));
  const annotations=Object.values(entityCache.current.annotations??{}) as MaterialAnnotation[];
  return <div className="material-workbench" data-view={view}>
    <div className="material-toolbar"><strong>{view==='archives'?'存档中心':view==='implementation'?'实现映射':'保存点工作区'}</strong><span className="muted">{viewedRevision?`存档 V${viewedRevision.displayNumber??'—'} · 只读`:`${catalog?.drafts?.[draft?.draftId??'']?.name||'当前工作副本'} · ${dirty.current.size?'有修改':'已保存'}`}</span></div>
    {error&&<p className="error-inline" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {conflict&&<Button onClick={()=>run(()=>openDraft(conflict.draftId,true))}>读取修订 {conflict.draftRevision} 并处理冲突</Button>}
    {liveIntent&&<p role="status">选择实时元素将新增当前现场例证，旧卡片位置保留。<Button onClick={()=>{setLiveIntent(null);void onCancelLive?.();}}>取消选择</Button></p>}
    {retryCapture.current&&<div role="status"><p>采集状态：{retryCapture.current.stage}；原操作已保留。</p><Button disabled={!!pending} onClick={()=>run(()=>recordCurrent())}>{retryCapture.current.stage==='receipt-saved'?'重试关联已保存原件':'查询采集操作状态'}</Button><Button onClick={()=>{if(endedCapture(retryCapture.current))setRetryCapture(null);else setRetryCapture({...retryCapture.current,paused:true});}}>保留记录并继续编辑</Button>{retryCapture.current.paused&&retryCapture.current.recovered?.target&&<Button onClick={()=>{const value=retryCapture.current.recovered;markDirty('field');setFieldTarget(value.target);setFieldCheckpointId(value.card.id);setBindingAction('set');setEditor('field');setRetryCapture(null);}}>使用已保存样例绑定当前字段</Button>}</div>}
    {recoveryOperations.map(item=><Button key={item.operationId} onClick={()=>setRetryCapture(item)}>恢复采集操作 {item.operationId.slice(0,8)}</Button>)}
    {view==='archives'?<>
      <nav className="material-actions">{([['revisions','资料版本'],['recordings','原始录制'],['drafts','工作副本']] as const).map(([id,label])=><Button aria-pressed={archiveTab===id} key={id} onClick={()=>setArchiveTab(id)}>{label}</Button>)}</nav>
      <Button onClick={()=>run(refreshLists)}>刷新存档</Button><Label><input type="checkbox" checked={showRemoved} onChange={event=>setShowRemoved(event.target.checked)}/>显示已移除条目</Label>
      {archiveTab==='recordings'&&recordingArchive}
      {archiveTab==='revisions'&&<>
        <Button disabled={!draft||!!pending} onClick={()=>run(prepareArchive)}>{publication.current?'恢复上次存档操作':'保存存档版本'}</Button>
        {archivePrompt&&<section role="region" aria-label="确认存档范围"><h3>固定当前工作副本</h3><p>保存点、字段、注释、任务目标与引用录制将成为一致快照。</p><Label>版本名称<Input value={archiveName} onChange={event=>setArchiveName(event.target.value)}/></Label>{archiveImpact.length>0&&<p>以下录制尚未结束：{archiveImpact.join('、')}。结束后保留浏览页面。</p>}<Button disabled={!!pending} onClick={()=>run(confirmArchive)}>{archiveImpact.length?'结束这段录制并保存版本（保留页面）':'确认保存存档版本'}</Button><Button onClick={()=>setArchivePrompt(false)}>返回继续编辑</Button></section>}
        {revisions.items.filter(item=>showRemoved||!catalog?.revisions?.[item.revisionId]?.hidden).map(item=><section className="material-revision" key={item.revisionId}><strong>V{item.displayNumber??'—'} {catalog?.revisions?.[item.revisionId]?.name}</strong><span>{item.createdAt?new Date(item.createdAt).toLocaleString():item.status}</span><small>{item.revisionId} · {item.contentHash?.slice(0,12)}</small><div className="material-actions"><Button disabled={item.status==='unavailable'||!!pending} onClick={()=>run(()=>viewRevision(item))}>查看固定版本</Button><Button disabled={!!pending} onClick={()=>run(()=>manage('revisions',item.revisionId,{hidden:!catalog?.revisions?.[item.revisionId]?.hidden}))}>{catalog?.revisions?.[item.revisionId]?.hidden?'恢复版本':'隐藏版本'}</Button></div></section>)}
        {revisions.nextCursor&&<Button onClick={()=>run(()=>moreList('revisions',revisions.nextCursor!))}>更多版本</Button>}
        {viewedRevision&&<section aria-label="固定版本只读"><h3>存档 V{viewedRevision.displayNumber??'—'} · 只读</h3><p>hash {viewedRevision.contentHash}</p><p>{(viewedRevision as any).taskBrief?.objective}</p><Button disabled={!!pending} onClick={()=>run(()=>createDraft(viewedRevision.revisionId))}>基于此版继续编辑</Button><Button onClick={()=>{setViewedRevision(null);onEditWorkspace?.();}}>返回当前工作副本</Button><Label>版本备注<Input defaultValue={catalog?.revisions?.[viewedRevision.revisionId]?.note??''} key={viewedRevision.revisionId+'note'} onBlur={event=>run(()=>manage('revisions',viewedRevision.revisionId,{note:event.target.value}))}/></Label><Label>版本标签<Input defaultValue={catalog?.revisions?.[viewedRevision.revisionId]?.name??''} key={viewedRevision.revisionId} onBlur={event=>run(()=>manage('revisions',viewedRevision.revisionId,{name:event.target.value}))}/></Label><Label>比较起始版本<NativeSelect value={compareFrom} onChange={event=>setCompareFrom(event.target.value)}><option value="">选择版本</option>{revisions.items.filter(item=>item.status!=='unavailable').map(item=><option key={item.revisionId} value={item.revisionId}>V{item.displayNumber}</option>)}</NativeSelect></Label><Button disabled={!compareFrom} onClick={()=>run(async()=>{let cursor:string|undefined;const result:any[]=[];do{const page=await call('materialDiff',{fromRevisionId:compareFrom,toRevisionId:viewedRevision.revisionId,cursor,limit:100,maxBytes:28672});result.push(...page.items);cursor=page.nextCursor;}while(cursor);setDifferences(result);})}>比较版本</Button>{differences.map((item,index)=><p key={index}>{item.collection} · {item.id} · {item.change} · {item.changedFields.join('、')}</p>)}{COLLECTIONS.map(collection=><div key={collection}><h4>{{requirements:'需求',fields:'字段',checkpoints:'保存点',annotations:'注释',recordingRefs:'来源录制'}[collection]}</h4>{viewedPages[collection].items.map((item:any,index:number)=><div key={item.id??index}><p>{collection==='recordingRefs'?item:item.description??item.title??item.name??item.text??item.id}</p>{collection==='checkpoints'&&<Button onClick={()=>onOpenReplay(item.anchor)}>查看来源</Button>}</div>)}{viewedPages[collection].nextCursor&&<Button onClick={()=>run(()=>moreRevisionCollection(collection,viewedPages[collection].nextCursor!))}>更多{collection}</Button>}</div>)}</section>}
      </>}
      {archiveTab==='drafts'&&<>{differences.map((item,index)=><p key={index}>{item.collection} · {item.id} · {item.change} · {item.changedFields.join('、')}</p>)}<Button disabled={!!pending} onClick={()=>run(()=>createDraft())}>新建工作副本</Button>{drafts.items.filter(item=>showRemoved||!catalog?.drafts?.[item.draftId]?.hidden).map(item=><section key={item.draftId}><strong>{catalog?.drafts?.[item.draftId]?.name||'其他工作副本'} {catalog?.workingDraftId===item.draftId?'· 当前':''}</strong><p>来源版本 {item.baseRevisionId??'从空白开始'} · 修订 {item.draftRevision}</p><Button disabled={!!pending} onClick={()=>run(async()=>{if(!await saveEditor())return;let cursor:string|undefined;const values:any[]=[];do{const page=await call('materialDraftDiff',{draftId:item.draftId,cursor,limit:100,maxBytes:28672});values.push(...page.items);cursor=page.nextCursor;}while(cursor);setDifferences(values);setNotice('此工作副本相对来源版本的变更（空白副本相对空资料）。');})}>查看副本差异</Button><Label>副本名称<Input defaultValue={catalog?.drafts?.[item.draftId]?.name??''} onBlur={event=>run(()=>manage('drafts',item.draftId,{name:event.target.value}))}/></Label><Button disabled={!!pending||item.status==='unavailable'||catalog?.drafts?.[item.draftId]?.hidden} onClick={()=>switchDraft(item.draftId)}>设为当前并编辑</Button><Button disabled={!!pending} onClick={()=>run(()=>copyWorkingDraft(item.draftId))}>复制工作副本</Button><Button disabled={!!pending||catalog?.workingDraftId===item.draftId} onClick={()=>run(()=>manage('drafts',item.draftId,{hidden:!catalog?.drafts?.[item.draftId]?.hidden}))}>{catalog?.drafts?.[item.draftId]?.hidden?'恢复副本':'移除副本'}</Button></section>)}{drafts.nextCursor&&<Button onClick={()=>run(()=>moreList('drafts',drafts.nextCursor!))}>更多工作副本</Button>}</>}
    </>:viewedRevision?<div><p>正在查看固定版本；内容只读。</p><Button onClick={()=>{setViewedRevision(null);onEditWorkspace?.();}}>返回当前工作副本</Button><Button onClick={()=>run(()=>createDraft(viewedRevision.revisionId))}>基于此版继续编辑</Button></div>:!draft?<p>正在准备工作副本。</p>:<>
      <div className="material-actions"><Button disabled={!!pending||!!liveIntent||locksEditor(retryCapture.current)} onClick={()=>run(()=>saveEditor())}>保存修改</Button>{pending&&<span role="status">{pending}</span>}<Button disabled={!!pending||!dirty.current.size} onClick={()=>setDiscardPrompt(true)}>撤销未保存输入</Button></div>{discardPrompt&&<p role="alert">恢复服务器已保存的工作副本，放弃当前未保存输入？<Button onClick={()=>run(async()=>{if(!draft)return;localStorage.removeItem(`bes.editor.${projectId}.${draft.draftId}`);setDiscardPrompt(false);await openDraft(draft.draftId);})}>确认撤销输入</Button><Button onClick={()=>setDiscardPrompt(false)}>保留输入</Button></p>}
      {view==='implementation'?<section><h3>任务目标</h3><p>{draft.taskBrief?.objective||'未填写任务目标'}</p><Button onClick={()=>run(prepareMapping)}>读取实现器映射</Button>{mapping&&<div role="status"><h4>实现映射待确认</h4>{mapping.fields.map((field:any)=><p key={field.name}><strong>{field.dataset} / {field.name}</strong>：{field.description}<br/>输出 {field.outputPath}；来源要求 {field.sourcePolicy}<br/>值类型 {field.valueType||'未指定'}；需求示例 {field.example||'未绑定'}<br/>{field.verification}</p>)}{mapping.issues?.map((issue:string,index:number)=><p key={index}>{issue}</p>)}<Button disabled={mapping.compatible===false} onClick={()=>run(confirmMapping)}>确认映射并保存工作副本</Button></div>}</section>:<div inert={!!pending||!!liveIntent||locksEditor(retryCapture.current)}>
        <div className="material-actions"><Button onClick={()=>run(startCheckpoint)}>新增保存点</Button><Button disabled={!card} onClick={newField}>添加字段</Button><Button disabled={!card} onClick={newAnnotation}>添加注释</Button></div>
        <Label>来源录制筛选<NativeSelect value={sourceFilter} onChange={event=>setSourceFilter(event.target.value)}><option value="">全部来源</option>{pages.recordingRefs.items.map((id:string)=><option key={id} value={id}>{catalog?.recordings?.[id]?.name||id}</option>)}</NativeSelect></Label><Label>搜索保存点<Input value={search} onChange={event=>setSearch(event.target.value)}/></Label><div className="material-card-list">{(pages.checkpoints.items as CheckpointCard[]).filter(item=>(!sourceFilter||item.anchor.recordingId===sourceFilter)&&(item.title+' '+item.notes).includes(search)).map(item=><Button key={item.id} aria-pressed={cardId===item.id} onClick={()=>selectCard(item.id)}>{item.title}<small>{new Date(item.capturedAt).toLocaleTimeString()}</small></Button>)}</div>{pages.checkpoints.nextCursor&&<Button onClick={()=>run(()=>moreCollection(draft,'checkpoints',pages.checkpoints.nextCursor!))}>更多保存点</Button>}
        {!card&&editor!=='card'&&<p>新增或选择一个保存点，再添加字段和注释。</p>}
        {card&&<section aria-label="保存点摘要"><h3>{card.title}</h3><p>{card.notes||'尚无说明'}</p><small>{new Date(card.capturedAt).toLocaleString()} · {card.anchor.recordingId.slice(0,12)}</small><div className="material-actions"><Button onClick={()=>changeEditor(()=>setEditor('card'))}>编辑保存点</Button><Button onClick={()=>onOpenReplay(card.anchor)}>查看来源</Button><details><summary>更多操作</summary><Button onClick={()=>run(copyCard)}>复制保存点</Button><p>移位后该卡片字段与注释的绑定须重新核验。</p><Button disabled={!position} onClick={()=>run(async()=>{const saved=await saveEditor();if(saved&&position)await mutate([{operation:'move-checkpoint',checkpointId:card.id,position}],'位置已移动，旧绑定待复核。',saved);})}>确认移至当前历史位置</Button><p>移除仅影响此工作副本的卡片及其注释；共享需求和字段保留。</p><Button onClick={()=>run(removeCard)}>确认移除保存点</Button></details></div>
          <h4>字段</h4>{cardFields.map(field=><Button key={field.id} onClick={()=>selectField(field.id)}>{field.name} · {field.valueType||'未指定类型'} · {field.target?'有来源':'仅说明'}</Button>)}
          {pages.fields.nextCursor&&<Button onClick={()=>run(()=>moreCollection(draft,'fields',pages.fields.nextCursor!))}>更多字段</Button>}<h4>注释</h4>{annotations.filter(item=>item.checkpointId===card.id).map(item=><div key={item.id}><p>{item.text} · {item.target?item.bindingStatus:'纯文字'}</p><Button onClick={()=>editAnnotation(item)}>编辑注释</Button><Button onClick={()=>run(()=>removeAnnotation(item))}>移除注释</Button></div>)}
        </section>}
        {editor==='card'&&<section aria-label="编辑保存点"><Label>标题<Input autoFocus value={title} onChange={event=>{markDirty('card');setTitle(event.target.value);}}/></Label><Label>说明<Textarea value={notes} onChange={event=>{markDirty('card');setNotes(event.target.value);}}/></Label><details><summary>类型与共享需求</summary><Label>类型<NativeSelect value={kind} onChange={event=>{markDirty('card');setKind(event.target.value as typeof kind);}}><option value="observation">观察</option><option value="requirement">需求示例</option></NativeSelect></Label>{currentRequirements.map(item=><Label key={item.id}><input type="checkbox" checked={cardRequirementIds.includes(item.id)} onChange={event=>{markDirty('card');setCardRequirementIds(current=>event.target.checked?unique([...current,item.id]):current.filter(id=>id!==item.id));}}/>{item.description}</Label>)}<Label>新需求含义<Textarea value={newCardRequirement} onChange={event=>{markDirty('link');setNewCardRequirement(event.target.value);}}/></Label></details><Button onClick={()=>run(async()=>{if(await saveEditor())setEditor('summary');})}>完成保存点编辑</Button></section>}
        {editor==='annotation'&&card&&<section aria-label="编辑注释"><Label>注释<Textarea autoFocus value={annotationText} onChange={event=>{markDirty('annotation');setAnnotationText(event.target.value);}}/></Label><p>可只写文字；元素绑定可选。</p><Button onClick={()=>beginSelection('annotation')}>选择历史元素（可选）</Button>{annotationTarget&&<details><summary>绑定来源</summary><SourceTargetPreview projectId={projectId} target={annotationTarget}/></details>}<Label>解释层级<NativeSelect value={interpretation} onChange={event=>{markDirty('annotation');setInterpretation(event.target.value as typeof interpretation);}}><option value="observed">观察</option><option value="inferred">推断</option><option value="unverified">未验证</option></NativeSelect></Label><Button disabled={!annotationText.trim()} onClick={()=>run(saveAnnotation)}>保存注释</Button></section>}
        {editor==='field'&&<section aria-label="编辑字段"><Label>字段名<Input autoFocus value={fieldName} onChange={event=>{markDirty('field');setFieldName(event.target.value);}}/></Label><Label>明确含义<Textarea value={fieldDescription} onChange={event=>{markDirty('field');setFieldDescription(event.target.value);}}/></Label><Label>值类型<NativeSelect value={fieldValueType} onChange={event=>{markDirty('field');setFieldValueType(event.target.value as MaterialField['valueType']);}}><option value="">未指定</option>{['string','number','boolean','object','array','null'].map(value=><option key={value} value={value}>{value}</option>)}</NativeSelect></Label><Label>所属需求<NativeSelect value={requirementId} onChange={event=>run(()=>loadRequirement(event.target.value))}><option value="">自动选择唯一需求 / 创建当前卡片的数据要求</option>{currentRequirements.map(item=><option key={item.id} value={item.id}>{item.description}</option>)}</NativeSelect></Label><Label>来源要求<NativeSelect value={fieldPolicy} onChange={event=>{markDirty('field');setFieldPolicy(event.target.value as MaterialField['sourcePolicy']);}}><option value="any-evidenced">任一有证据来源</option><option value="page-displayed">必须按页面显示值</option></NativeSelect></Label>
          <div className="material-actions"><Button disabled={!card} onClick={()=>{setAppendExample(false);beginSelection('field');}}>选择当前保存点的元素</Button><Button disabled={!live} onClick={()=>{setAppendExample(!!selectedField);run(beginLive);}}>新增实时例证</Button>{fieldTarget&&<Button onClick={()=>setConfirmClear(true)}>解除绑定</Button>}</div><p>历史选择复用当前卡片；新增实时例证会保留旧卡片并创建当前现场。</p>
          {selectedField&&<div><h4>字段例证</h4>{selectedField.target&&<p>首个例证 · {selectedField.checkpointId} · {selectedField.bindingStatus}</p>}{selectedField.examples?.map(example=><p key={example.id}>{example.checkpointId} · {example.bindingStatus}<Button onClick={()=>run(async()=>{const saved=await saveEditor();if(saved)await mutate([{operation:'remove-field-example',fieldId:selectedField.id,exampleId:example.id}],'已移除此例证；其他例证及固定版保留。',saved);})}>移除此例证</Button></p>)}<Button disabled={!card} onClick={()=>{setAppendExample(true);beginSelection('field');}}>添加当前保存点例证</Button><Label>例证保存点<NativeSelect value={cardId} onChange={event=>selectCard(event.target.value)}>{(pages.checkpoints.items as CheckpointCard[]).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</NativeSelect></Label></div>}
          {confirmClear&&<p role="alert">只解除首个绑定，保留字段说明及其他例证？<Button onClick={()=>{markDirty('field');setBindingAction('clear');setFieldTarget(null);setFieldAnnotationId('');setConfirmClear(false);}}>确认解除绑定</Button><Button onClick={()=>setConfirmClear(false)}>保留绑定</Button></p>}
          {fieldTarget&&<details><summary>查看绑定来源</summary><SourceTargetPreview projectId={projectId} target={fieldTarget}/></details>}
          <details><summary>高级实现信息</summary><Label>数据集<Input value={fieldDataset} onChange={event=>{markDirty('field');setFieldDataset(event.target.value);}}/></Label><Label>输出 JSON Pointer<Input value={fieldPath} onChange={event=>{markDirty('field');setTechnicalDirty(true);setFieldPath(event.target.value);}}/></Label><Label>来源规则 JSON<Textarea value={sourceProofJson} onChange={event=>{markDirty('field');setTechnicalDirty(true);setSourceProofJson(event.target.value);}}/></Label></details><Button onClick={()=>run(saveField)}>保存字段</Button>
        </section>}
        <details><summary>任务目标与共享需求</summary><Button onClick={()=>changeEditor(()=>setEditor('brief'))}>编辑任务目标</Button><Button onClick={()=>changeEditor(()=>setEditor('requirement'))}>管理共享需求</Button></details>
        {editor==='brief'&&<section><Label>任务目标<Textarea value={briefObjective} onChange={event=>{markDirty('brief');setBriefObjective(event.target.value);}}/></Label><Label>任务范围<Textarea value={briefScope} onChange={event=>{markDirty('brief');setBriefScope(event.target.value);}}/></Label><Button onClick={()=>run(async()=>{if(await saveEditor('brief'))setEditor('summary');})}>保存任务目标</Button></section>}
        {editor==='requirement'&&<section><Label>需求<NativeSelect value={requirementId} onChange={event=>selectRequirement(event.target.value)}><option value="">新需求</option>{currentRequirements.map(item=><option key={item.id} value={item.id}>{item.description}</option>)}</NativeSelect></Label><Label>需求说明<Textarea value={requirementDescription} onChange={event=>{markDirty('requirement');setRequirementDescription(event.target.value);}}/></Label><Label>期望记录数（可选）<Input type="number" min="0" step="1" value={visibleRules?.find(rule=>rule.type==='row-count')?.count??''} onChange={event=>updateSimpleRule('row-count',event.target.value===''?null:{type:'row-count',count:Number(event.target.value)})}/></Label><Label>不重复的输出标识字段（可选）<Input value={visibleRules?.find(rule=>rule.type==='unique')?.field??''} onChange={event=>updateSimpleRule('unique',event.target.value?{type:'unique',field:event.target.value}:null)}/></Label><details><summary>高级规则</summary><Label>规则 JSON<Textarea value={rulesJson} onChange={event=>{markDirty('requirement');setRulesJson(event.target.value);}}/></Label></details><Button onClick={()=>run(async()=>{if(await saveRequirement())setEditor('summary');})}>保存需求</Button>{pages.requirements.nextCursor&&<Button onClick={()=>run(()=>moreCollection(draft,'requirements',pages.requirements.nextCursor!))}>更多需求</Button>}</section>}
      </div>}
    </>}
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
