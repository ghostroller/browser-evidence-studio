import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckpointCard, MaterialAnnotation, MaterialField, MaterialRequirement } from '@/contracts/materials';
import { sameReplayPosition, type HistoricalTarget, type ReplayPosition } from '@/contracts/recording';
import type { DataRule, FieldSourceProof } from '@/contracts/workflow';
import type { SelectionReceipt, SelectionRequest } from '@/renderer/selection-session';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';

type EditorPart = 'card' | 'requirement' | 'field' | 'annotation' | 'link';
type Collection = 'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs';
type Page<T> = { items: T[]; nextCursor?: string; outputTruncated: boolean };
type Draft = { draftId: string; draftRevision: number; baseRevisionId?: string; status?: string; counts?: Record<string, number> };
type Revision = { revisionId: string; contentHash: string; status?: string; createdAt?: string };
type Edit = { operation: 'upsert'; collection: Exclude<Collection, 'recordingRefs'>; item: unknown }
  | { operation: 'remove'; collection: Exclude<Collection, 'recordingRefs'>; id: string }
  | { operation:'field-binding';fieldId:string;binding:{kind:'keep'|'clear'}|{kind:'set';target:HistoricalTarget;checkpointId:string;annotationId?:string} }
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
export function MaterialWorkbench({ projectId, recordingId, position, selectedTarget, onOpenReplay, onSelectTarget, live, liveScope, liveSelection, onLiveSelect, onCancelLive, onPublished }: {
  projectId: string; recordingId?: string; position?: ReplayPosition | null; selectedTarget?: SelectionReceipt | null;
  live?:boolean; liveScope?:{pageId:string;generation:number;leaseEpoch:number}; liveSelection?:any; onLiveSelect?(selectionId:string):Promise<void>; onCancelLive?():Promise<void>; onPublished?(id:string):void;
  onOpenReplay(position: ReplayPosition): void; onSelectTarget(request: SelectionRequest): void;
}) {
  const [drafts, setDrafts] = useState<Page<Draft>>({ items: [], outputTruncated: false });
  const [revisions, setRevisions] = useState<Page<Revision>>({ items: [], outputTruncated: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pages, setPages] = useState(empty);
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
      if (token === listRequest.current && ownsSession()) { setDrafts(nextDrafts); setRevisions({...nextRevisions,items:[...nextRevisions.items].sort((a:any,b:any)=>String(b.createdAt).localeCompare(String(a.createdAt)))}); }
    } catch (failure) { if (token === listRequest.current && ownsSession()) setError(String(failure)); }
  }, [call, projectId, editorSessionId]);
  const loadCollection = useCallback(async (selected: Draft, collection: Collection, token: number, cursor?: string) => {
    if(!ownsSession()||selectionRequest.current!==token)return;
    const result: Page<any> = await call('materialCollection', { kind: 'draft', draftId: selected.draftId, collection, cursor, limit: 50, maxBytes: 24576 });
    if (!ownsSession() || selectionRequest.current !== token || draftRef.current?.draftId !== selected.draftId || draftRef.current.draftRevision !== selected.draftRevision) return;
    setPages(current => ({ ...current, [collection]: cursor ? current[collection].nextCursor === cursor
      ? { ...result, items: [...current[collection].items, ...result.items] } : current[collection] : result }));
  }, [call, projectId, editorSessionId]);
  const openDraft = useCallback(async (id: string, preserve=false) => {
    if(!ownsSession()||(pendingRef.current&&!preserve))return;
    const token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = false; setPending('');
    draftRef.current = null; setDraft(null); setPages(empty()); if(!preserve)resetEditor();
    try { const selected: Draft = await call('materialDraft', { draftId: id });
      if (token !== selectionRequest.current || !ownsSession()) return;
      if(!preserve){try{const raw=localStorage.getItem(`bes.editor.${projectId}.${id}`);if(raw){const saved=JSON.parse(raw);setCardId(saved.cardId);setTitle(saved.title);setNotes(saved.notes);setKind(saved.kind);setCardRequirementIds(saved.cardRequirementIds);setNewCardRequirement(saved.newCardRequirement);setRequirementId(saved.requirementId);setRequirementDescription(saved.requirementDescription);setRulesJson(saved.rulesJson);setFieldId(saved.fieldId);setFieldName(saved.fieldName);setFieldDescription(saved.fieldDescription);setFieldDataset(saved.fieldDataset);setFieldPath(saved.fieldPath);setFieldPolicy(saved.fieldPolicy);setFieldValueType(saved.fieldValueType);setSourceProofJson(saved.sourceProofJson);setTechnicalDirty(saved.technicalDirty??false);setFieldTarget(saved.fieldTarget);setFieldCheckpointId(saved.fieldCheckpointId??'');setFieldAnnotationId(saved.fieldAnnotationId);setAnnotationId(saved.annotationId);setAnnotationTarget(saved.annotationTarget);setAnnotationText(saved.annotationText);setInterpretation(saved.interpretation);setBindingAction(saved.bindingAction);if(saved.draftRevision!==selected.draftRevision||!Array.isArray(saved.dirty)){cacheConflict.current=saved.draftRevision??-1;setConflict(selected);setNotice('已恢复本机输入，但版本或缓存格式不同；请先读取当前修订并核对，再保存或发布。');}dirty.current=new Set(saved.dirty??[...(saved.cardId?['card']:[]),...(saved.requirementId?['requirement']:[]),...(saved.fieldName?['field']:[]),...(saved.annotationText?['annotation']:[])]);setRetryCapture(saved.retryCapture?.projectId===projectId&&saved.retryCapture?.draftId===id?saved.retryCapture:null);}}catch{setNotice('本机编辑恢复记录不可读；已保留原记录，当前显示服务端草稿。');}}
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
  }, [call, loadCollection, editorSessionId]);
  useEffect(() => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; pendingRef.current = false;
    ++revisionRequest.current;setViewedRevision(null);setViewedPages(empty());
    draftRef.current = null; setDraft(null); setDrafts({ items: [], outputTruncated: false }); setRevisions({ items: [], outputTruncated: false });
    setPages(empty()); resetEditor(); setPending(''); setError('');
    if(projectId)void refreshLists();
    const bootstrap=selectionRequest.current;
    if(projectId)void call("workingMaterialDraft").then(value=>{if(ownsSession()&&selectionRequest.current===bootstrap)return openDraft(localStorage.getItem(`bes.activeDraft.${projectId}`)||value.draftId);}).catch(failure=>{if(ownsSession()&&selectionRequest.current===bootstrap)setError(String(failure));});
    return () => { ++listRequest.current; ++selectionRequest.current; ++writeRequest.current; };
  }, [projectId, refreshLists]);
  useEffect(()=>{
    if(!draft||draftRef.current?.draftId!==draft.draftId||scopeRef.current!==projectId)return;
    try{localStorage.setItem(`bes.editor.${projectId}.${draft.draftId}`,JSON.stringify({draftRevision:cacheConflict.current??draft.draftRevision,cardId,title,notes,kind,cardRequirementIds,newCardRequirement,requirementId,requirementDescription,rulesJson,fieldId,fieldName,fieldDescription,fieldDataset,fieldPath,fieldPolicy,fieldValueType,sourceProofJson,fieldTarget,fieldCheckpointId,fieldAnnotationId,annotationId,annotationTarget,annotationText,interpretation,bindingAction,technicalDirty,dirty:[...dirty.current],retryCapture:retryCapture.current}));localStorage.setItem(`bes.activeDraft.${projectId}`,draft.draftId);}
    catch{setNotice('本机未提交输入暂时无法持久化，请先保存草稿再退出。');}
  },[projectId,draft,cardId,title,notes,kind,cardRequirementIds,newCardRequirement,requirementId,requirementDescription,rulesJson,fieldId,fieldName,fieldDescription,fieldDataset,fieldPath,fieldPolicy,fieldValueType,sourceProofJson,fieldTarget,fieldCheckpointId,fieldAnnotationId,annotationId,annotationTarget,annotationText,interpretation,bindingAction,technicalDirty,retryVersion]);
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
    else {markDirty('field');setFieldTarget(selectedTarget.target);setFieldCheckpointId(request.checkpointId);setBindingAction('set');setFieldAnnotationId('');}
  }, [selectedTarget]);
  const beginSelection=(purpose:'annotation'|'field')=>{
    const selected=draftRef.current, card=(pages.checkpoints.items as CheckpointCard[]).find(item=>item.id===cardId);
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
      return ownsSession() && selectionRequest.current === selection && write === writeRequest.current ? result.draft : null;
    } catch (failure) { if (activeWrite()) setError(String(failure)); return null; }
    finally { if (!hold && ownsSession() && selectionRequest.current === selection && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const card = pages.checkpoints.items.find((item: CheckpointCard) => item.id === cardId) as CheckpointCard | undefined;
  const prepareEditorTransition=(capture=false)=>saveEditor(undefined,false,capture?new Set([...dirty.current].filter(part=>['card','link','annotation'].includes(part))):undefined);
  const changeEditor=(change:()=>void)=>{if(pendingRef.current||!ownsSession())return;if(liveIntent||locksEditor(retryCapture.current)){setError('请先完成或取消当前选择，再切换编辑对象。');return;}if(!dirty.current.size){change();return;}void prepareEditorTransition().then(saved=>{if(saved&&ownsSession())change();});};
  const selectCard = (item: CheckpointCard) => changeEditor(()=>{
    pendingSelection.current=null;
    setCardId(item.id);setTitle(item.title);setNotes(item.notes);setKind(item.kind);setCardRequirementIds(item.requirementIds);setNewCardRequirement('');
    setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');
  });
  const currentRequirements = pages.requirements.items as MaterialRequirement[];
  const loadRequirement=(id:string)=>{const selected=currentRequirements.find(item=>item.id===id);setRequirementId(id);setRequirementDescription(selected?.description||'');setRulesJson(JSON.stringify(selected?.rules||[],null,2));};
  const selectRequirement=(id:string)=>{
    // A dirty field without an owner must be able to acquire one. Flushing it
    // before this selection would require precisely the identity being chosen.
    if(!requirementId&&id&&dirty.current.has('field')&&!dirty.current.has('requirement')){
      if(pendingRef.current||!ownsSession()||liveIntent||locksEditor(retryCapture.current))return;
      const owner=selectionRequest.current;
      void prepareEditorTransition(true).then(saved=>{if(saved&&ownsSession()&&selectionRequest.current===owner){pendingSelection.current=null;loadRequirement(id);}});return;
    }
    changeEditor(()=>{pendingSelection.current=null;loadRequirement(id);setFieldId('');setFieldName('');setFieldDescription('');setFieldDataset('');setFieldPath('');setFieldTarget(null);setFieldCheckpointId('');setFieldAnnotationId('');setSourceProofJson('');});
  };
  const selectField=(id:string)=>{
    const inferOwner=!requirementId&&!dirty.current.has('requirement');
    changeEditor(()=>{
      pendingSelection.current=null;const selected=(pages.fields.items as MaterialField[]).find(item=>item.id===id);
      const owners=currentRequirements.filter(item=>item.fieldIds.includes(id));
      if(selected&&inferOwner&&owners.length===1&&!pages.requirements.nextCursor&&!pages.requirements.outputTruncated)loadRequirement(owners[0].id);
      setBindingAction('keep');setTechnicalDirty(false);setFieldId(selected?.id||'');setFieldName(selected?.name||'');setFieldDescription(selected?.description||'');setFieldDataset(selected?.dataset||'records');setFieldPath(selected?.outputPath||'');setFieldPolicy(selected?.sourcePolicy||'any-evidenced');setFieldValueType(selected?.valueType||'');setSourceProofJson(selected?.sourceProof?JSON.stringify(selected.sourceProof,null,2):'');setFieldTarget(selected?.target||null);setFieldCheckpointId(selected?.checkpointId||'');setFieldAnnotationId(selected?.annotationId||'');
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
  const selectedField = (pages.fields.items as MaterialField[]).find(item => item.id === fieldId);
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
        if(!nextCard||!annotationTarget||!annotationText.trim())throw new Error('选择卡片的历史元素并填写注释。');
        if(!sameReplayPosition(annotationTarget.position,nextCard.anchor))throw new Error('注释元素必须来自卡片的精确历史位置。');
        const existing=(pages.annotations.items as MaterialAnnotation[]).find(item=>item.id===annotationId);
        if(annotationId&&!existing)throw new Error('当前注释尚未加载。');
        nextAnnotation={id:annotationId||newId('annotation'),checkpointId:nextCard.id,target:annotationTarget,text:annotationText.trim(),author:'human',interpretation,bindingStatus:'bound'};
        nextCard.annotationIds=unique([...nextCard.annotationIds,nextAnnotation.id]);
      }
      if(parts.has('field')){
        if(!nextRequirement)throw new Error('先选择一个需求。');
        if(fieldId&&!selectedField)throw new Error('当前字段尚未加载。');
        if(!fieldName.trim()||!fieldDescription.trim()||!fieldDataset.trim())throw new Error('字段需要数据集、名称和明确含义。');
        nextField={...selectedField,id:selectedField?.id??newId('field'),dataset:fieldDataset.trim(),name:fieldName.trim(),description:fieldDescription.trim(),sourcePolicy:fieldPolicy};
        if(technicalDirty||!selectedField){if(fieldPath.trim())nextField.outputPath=fieldPath.trim();else delete nextField.outputPath;if(sourceProofJson.trim())nextField.sourceProof=JSON.parse(sourceProofJson);else delete nextField.sourceProof;}
        if(fieldValueType)nextField.valueType=fieldValueType;else delete nextField.valueType;
        const target=bindingAction==='clear'?null:bindingAction==='keep'?(selectedField?.target??fieldTarget):fieldTarget;
        if(target){nextField.target=target;if(bindingAction==='set'){const bindingCard=fieldCheckpointId?(pages.checkpoints.items as CheckpointCard[]).find(item=>item.id===fieldCheckpointId):nextCard;if(!bindingCard||!sameReplayPosition(target.position,bindingCard.anchor))throw new Error('字段元素必须来自其保存点的精确历史位置。');nextField.checkpointId=bindingCard.id;nextField.bindingStatus='bound';delete nextField.annotationId;}}
        if(fieldAnnotationId){const annotation=nextAnnotation?.id===fieldAnnotationId?nextAnnotation:(pages.annotations.items as MaterialAnnotation[]).find(item=>item.id===fieldAnnotationId);if(!annotation||JSON.stringify(annotation.target)!==JSON.stringify(target))throw new Error('字段注释必须绑定相同的历史元素。');nextField.annotationId=annotation.id;nextField.checkpointId=annotation.checkpointId;}
        else if(bindingAction!=='keep')delete nextField.annotationId;
        nextRequirement.fieldIds=unique([...nextRequirement.fieldIds,nextField.id]);
      }
      if(nextCard&&(parts.has('card')||parts.has('annotation')||parts.has('link'))){
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
      if(nextField)edits.push({operation:'field-binding',fieldId:nextField.id,binding:bindingAction==='set'&&fieldTarget&&nextField.checkpointId?{kind:'set',target:fieldTarget,checkpointId:nextField.checkpointId,...(fieldAnnotationId?{annotationId:fieldAnnotationId}:{})}:{kind:bindingAction==='clear'?'clear':'keep'}});
      if(!current())return null;
      const receipt=await mutate(edits,'编辑快照已保存到草稿。',expected,true,hold);if(!receipt||!current())return null;
      for(const part of parts)dirty.current.delete(part);if(nextCard)setCardId(nextCard.id);if(nextAnnotation)setAnnotationId(nextAnnotation.id);
      if(nextRequirement&&(parts.has('requirement')||parts.has('field')))setRequirementId(nextRequirement.id);
      if(linkedRequirement){setNewCardRequirement('');setCardRequirementIds(nextCard!.requirementIds);}
      if(nextField){setFieldId(nextField.id);setBindingAction('keep');setTechnicalDirty(false);}
      return receipt;
    }catch(failure){if(current())setError(failure instanceof Error?failure.message:String(failure));return null;}
    finally{if(current()&&(!hold||dirty.current.size)){pendingRef.current=false;setPending('');}}
  };
  const saveCard=()=>saveEditor('card');
  const saveRequirement=()=>saveEditor('requirement');
  const saveField=()=>saveEditor('field');
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
      if(request.purpose==='field'||request.selection){setFieldId(request.fieldId??'');markDirty('field');setFieldTarget(result.target);setFieldCheckpointId(result.card.id);setBindingAction('set');setFieldAnnotationId('');if(!fieldDataset)setFieldDataset('records');}
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
  const saveAnnotation=()=>saveEditor('annotation');
  const editAnnotation=(item:MaterialAnnotation)=>changeEditor(()=>{
    pendingSelection.current=null;setAnnotationId(item.id);setAnnotationTarget(item.target);setAnnotationText(item.text);setInterpretation(item.interpretation);
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
      const revision = await call('publishMaterialDraft', { draftId: selected.draftId, expectedDraftRevision: selected.draftRevision });
      if (!current()) return;
      await openDraft(selected.draftId,true);if(!ownsSession()||draftRef.current?.draftId!==selected.draftId)return;const reopened=selectionRequest.current;await refreshLists();if(!ownsSession()||selectionRequest.current!==reopened||draftRef.current?.draftId!==selected.draftId)return;onPublished?.(revision.revisionId);
      if (ownsSession() && draftRef.current?.draftId === selected.draftId) setNotice(`已发布候选资料版本 ${revision.revisionId}；发布不表示人工验收通过。`);
    } catch (failure) { if (current()) setError(String(failure)); }
    finally { if (scopeRef.current === scope && token === selectionRequest.current && write === writeRequest.current) { pendingRef.current = false; setPending(''); } }
  };
  const createDraft = async (baseRevisionId?:string) => {
    if (!ownsSession()||pendingRef.current) return;
    const scope = projectId, token = ++selectionRequest.current;
    ++writeRequest.current; pendingRef.current = true; draftRef.current = null;
    setDraft(null); setPages(empty()); resetEditor(); setPending('新建草稿'); setError('');
    try { const created: Draft = await call('createMaterialDraft',baseRevisionId?{baseRevisionId}:{});
      if (scopeRef.current !== scope || selectionRequest.current !== token) return;
      if(!ownsSession())return;pendingRef.current=false;await openDraft(created.draftId); await refreshLists();
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
    if(!ownsSession())return;
    const token=++revisionRequest.current,scope=projectId;
    setViewedRevision(null);setViewedPages(empty());setError('');
    try{
      const fixed:Revision=await call('materialRevision',{revisionId:item.revisionId,contentHash:item.contentHash});
      if(scopeRef.current!==scope||revisionRequest.current!==token)return;
      if(fixed.revisionId!==item.revisionId||fixed.contentHash!==item.contentHash)throw new Error('固定版本身份或内容 hash 不匹配。');
      const collections=await Promise.all(COLLECTIONS.map(async collection=>[collection,await call('materialCollection',{kind:'revision',revisionId:item.revisionId,contentHash:item.contentHash,collection,limit:50,maxBytes:24576})] as const));
      if(scopeRef.current!==scope||revisionRequest.current!==token)return;
      setViewedRevision(fixed);setViewedPages(Object.fromEntries(collections) as Record<Collection,Page<any>>);
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
  return <div className="material-workbench">
    <div className="material-toolbar"><strong>保存点与任务资料</strong><span className="muted">草稿可编辑 · 发布后按固定 hash 读取</span><Button disabled={!!pending} onClick={() => void refreshLists().catch(failure => setError(String(failure)))}>刷新列表</Button></div>
    <p className="hint">保存点与字段在这里统一编辑。实时选择会保存点击时刻的新例证；历史选择保留原时间。</p>
    <Button disabled={(!live&&!retryCapture.current)||!!pending} onClick={()=>{if(retryCapture.current&&endedCapture(retryCapture.current)){setRetryCapture(null);setNotice('旧操作已保留；下一次记录使用新的来源身份。');setError('');}else void recordCurrent();}}>{retryCapture.current?.stage==='receipt-saved'?'重试关联已保存原件':retryCapture.current?(endedCapture(retryCapture.current)?'原来源失效：重新选择':'查询采集操作状态'):'记录当前结果'}</Button>
    {liveIntent&&<p role="status">点击实时页面中需要的字段。<Button onClick={()=>{setLiveIntent(null);void onCancelLive?.();}}>取消选择</Button></p>}
    {recoveryOperations.filter(item=>item.operationId!==retryCapture.current?.operationId).map(item=><Button key={item.operationId} disabled={!!pending} onClick={()=>{setRetryCapture(item);setRecoveryOperations(values=>values.filter(value=>value.operationId!==item.operationId));}}>恢复已保存操作 {item.operationId}</Button>)}
    {retryCapture.current&&!endedCapture(retryCapture.current)&&!pending&&<p className="notice">采集操作 {retryCapture.current.operationId} 已保留。
      {!retryCapture.current.paused&&<Button onClick={()=>{setRetryCapture({...retryCapture.current,paused:true});setNotice('已暂存采集恢复；可以继续编辑，查询结果不会替换当前输入。');}}>暂存恢复并继续编辑</Button>}
      {retryCapture.current.paused&&retryCapture.current.recovered?.target&&<Button onClick={()=>{const recovered=retryCapture.current.recovered;markDirty('field');setFieldTarget(recovered.target);setFieldCheckpointId(recovered.card.id);setBindingAction('set');setFieldAnnotationId('');setRetryCapture(null);setNotice('已将保存的样例选给当前字段；填写完整后保存字段。');}}>使用已保存样例绑定当前字段</Button>}
      {retryCapture.current.paused&&retryCapture.current.recovered&&!retryCapture.current.recovered.target&&<Button onClick={()=>{setRetryCapture(null);setNotice('原操作已关联保存点，可从列表查看；当前编辑保留。');}}>完成恢复并保留当前编辑</Button>}
    </p>}

    {error && <p className="error-inline" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {conflict && <Button onClick={() => void openDraft(conflict.draftId,true).catch(failure => setError(String(failure)))}>读取修订 {conflict.draftRevision} 并处理冲突</Button>}
    <div className="material-layout" inert={!!pending||!!liveIntent||locksEditor(retryCapture.current)}><aside className="material-list"><div className="section-label">草稿 <Button disabled={!!pending} onClick={() => void createDraft()}>新建</Button></div>
      {drafts.items.map(item => <Button data-draft-id={item.draftId} aria-label={`工作草稿 ${item.draftId}`} key={item.draftId} disabled={!!pending || item.status === 'unavailable'} className={draft?.draftId === item.draftId ? 'selected' : ''} onClick={() => void openDraft(item.draftId).catch(failure => setError(String(failure)))}>工作草稿 · r{item.draftRevision ?? '—'}</Button>)}
      {drafts.nextCursor && <Button onClick={() => void moreList('drafts', drafts.nextCursor!)}>更多草稿</Button>}
       <div className="section-label">固定版本</div>{revisions.items.map((item,index) => <div key={item.revisionId} className="material-revision"><strong>V{revisions.items.length-index}</strong><span>{item.createdAt?new Date(item.createdAt).toLocaleString():'固定版本'}</span><code>{item.revisionId.slice(0, 15)}</code><small>hash {item.contentHash?.slice(0, 12) || item.status}</small><Button disabled={item.status==='unavailable'} onClick={()=>void viewRevision(item)}>查看固定版本</Button></div>)}
      {revisions.nextCursor && <Button onClick={() => void moreList('revisions', revisions.nextCursor!)}>更多版本</Button>}
     </aside><div className="material-editor">{viewedRevision&&<section><h3>固定版本 · {viewedRevision.createdAt?new Date(viewedRevision.createdAt).toLocaleString():viewedRevision.revisionId}</h3><p className="hint">版本 {viewedRevision.revisionId} · hash {viewedRevision.contentHash}。内容只读；派生会新建草稿。</p><Button disabled={!!pending} onClick={()=>void createDraft(viewedRevision.revisionId)}>从此版本派生草稿</Button>{COLLECTIONS.map(collection=><div key={collection}><h4>{collection}</h4>{viewedPages[collection].items.map((item:any,index:number)=><p key={item.id??index}>{collection==='recordingRefs'?item:item.description??item.title??item.name??item.text??item.id}</p>)}{viewedPages[collection].nextCursor&&<Button onClick={()=>void moreRevisionCollection(collection,viewedPages[collection].nextCursor!)}>更多 {collection}</Button>}</div>)}</section>}{!draft ? <div className="empty">新建或打开资料草稿，编辑历史 checkpoint、需求和字段。</div> : <>
      <div className="material-toolbar"><strong>当前工作草稿</strong><span>修订 {draft.draftRevision}</span><Button disabled={!!pending} onClick={() => void publish()}>{pending || '发布候选版本'}</Button></div>
      <section><h3>任务目标</h3><p>{(draft as any).taskBrief?.objective||'旧资料未固定目标'}</p><Button disabled={!!pending} onClick={()=>void prepareMapping()}>读取实现器映射</Button>{mapping&&<div role="status"><h4>实现映射待确认</h4>{mapping.fields.map((field:any)=><p key={field.name}><strong>{field.dataset} / {field.name}</strong>：{field.description}<br/>输出 {field.outputPath}；来源要求 {field.sourcePolicy}<br/>值类型 {field.valueType||'未指定'}；需求示例 {field.example||'未绑定'}<br/>{field.verification}</p>)}{mapping.issues?.map((issue:string,index:number)=><p className="error-inline" key={index}>{issue}</p>)}<Button disabled={mapping.compatible===false} onClick={()=>void confirmMapping()}>确认映射并保存草稿</Button></div>}</section><section><h3>保存点</h3><p className="hint">在时间轴可靠位置新增；移动后旧绑定保留为待复核。</p><div className="material-card-list">{(pages.checkpoints.items as CheckpointCard[]).map(item => <Button key={item.id} className={cardId === item.id ? 'selected' : ''} onClick={() => selectCard(item)}>{item.title}<small>{item.anchor.recordingId.slice(0, 12)} · #{item.anchor.eventSeq}</small></Button>)}</div>
      {pages.checkpoints.nextCursor && <Button onClick={() => void moreCollection(draft, 'checkpoints', pages.checkpoints.nextCursor!)}>下一页 checkpoint</Button>}
       <div className="material-actions"><Button onClick={() => changeEditor(()=>{pendingSelection.current=null;setCardId(''); setTitle(''); setNotes(''); setCardRequirementIds([]);setNewCardRequirement('');setAnnotationId('');setAnnotationTarget(null);setAnnotationText(''); })}>新建卡片</Button>{card && <><Button onClick={()=>onOpenReplay(card.anchor)}>查看来源</Button><Button disabled={!!pending} onClick={() => void mutate([{ operation: 'copy-checkpoint', checkpointId: card.id }], '卡片与注释已复制为独立 ID。')}>复制</Button><Button disabled={!position || !!pending} onClick={() => position && void mutate([{ operation: 'move-checkpoint', checkpointId: card.id, position }], '已移动历史位置；旧元素绑定需复核。')}>移至当前时间</Button><Button disabled={!!pending} onClick={() => void mutate([{ operation: 'remove-checkpoint', checkpointId: card.id }], '已移除卡片；共享需求仍保留。')}>删除卡片</Button></>}</div>
       <div className="form-stack"><Label>标题<Input value={title} onChange={event => {markDirty('card');setTitle(event.target.value);}} /></Label><Label>类型<NativeSelect value={kind} onChange={event => {markDirty('card');setKind(event.target.value as typeof kind);}}><option value="observation">观察</option><option value="requirement">需求示例</option></NativeSelect></Label><Label>说明<Textarea value={notes} onChange={event => {markDirty('card');setNotes(event.target.value);}} /></Label><fieldset><legend>关联需求</legend>{currentRequirements.map(item=><Label key={item.id}><input type="checkbox" checked={cardRequirementIds.includes(item.id)} onChange={event=>{markDirty('card');setCardRequirementIds(current=>event.target.checked?unique([...current,item.id]):current.filter(id=>id!==item.id));}}/>{item.description}</Label>)}</fieldset><Label>新需求含义<Textarea value={newCardRequirement} onChange={event=>{markDirty('link');setNewCardRequirement(event.target.value);}}/></Label><Button disabled={!card||!!pending} onClick={()=>void createAndLinkRequirement()}>新建并关联需求</Button><Button disabled={!!pending || (!card && !position)} onClick={() => void saveCard()}>保存卡片草稿</Button></div>
       {card && <><h4>元素注释</h4><p className="hint">检查入口指向这张卡片的历史时间；取消选择不会写入资料。</p><div className="material-actions"><Button onClick={()=>changeEditor(()=>{pendingSelection.current=null;setAnnotationId('');setAnnotationTarget(null);setAnnotationText('');setInterpretation('observed');})}>新增注释</Button><Button onClick={() => beginSelection('annotation')}>{annotationId?'重新绑定历史元素':'在历史页选择元素'}</Button></div><Label>注释<Textarea value={annotationText} onChange={event => {markDirty('annotation');setAnnotationText(event.target.value);}} /></Label><Label>解释层级<NativeSelect value={interpretation} onChange={event => {markDirty('annotation');setInterpretation(event.target.value as typeof interpretation);}}><option value="observed">观察</option><option value="inferred">推断</option><option value="unverified">未验证</option></NativeSelect></Label><Button disabled={!annotationTarget || !annotationText.trim() || !!pending} onClick={() => void saveAnnotation()}>{annotationId?'保存注释修改':'保存注释'}</Button>
         {annotationTarget && <SourceTargetPreview projectId={projectId} target={annotationTarget} />}
         {(pages.annotations.items as MaterialAnnotation[]).filter(item => item.checkpointId === card.id).map(item => <div key={item.id} className="material-annotation"><p>{item.text} · {item.interpretation} · {item.bindingStatus}</p><Button onClick={()=>editAnnotation(item)}>编辑注释</Button><Button disabled={!!pending} onClick={()=>void removeAnnotation(item)}>删除注释</Button></div>)}</>}
      </section><section><h3>共享需求与字段</h3><p className="hint">多次示范可引用同一需求；删除示例卡片不会删除要求。字段可只写说明，也可绑定元素，注释可选。</p>
       <Label>需求<NativeSelect value={requirementId} onChange={event=>selectRequirement(event.target.value)}><option value="">新需求</option>{currentRequirements.map(item => <option key={item.id} value={item.id}>{item.description.slice(0, 70)}</option>)}</NativeSelect></Label><Label>需求说明<Textarea value={requirementDescription} onChange={event => {markDirty('requirement');setRequirementDescription(event.target.value);}} /></Label><div className="material-grid"><Label>期望记录数（可选）<Input type="number" min="0" step="1" disabled={!visibleRules} value={visibleRules?.find(rule=>rule.type==='row-count')?.count??''} onChange={event=>updateSimpleRule('row-count',event.target.value===''?null:{type:'row-count',count:Number(event.target.value)})}/></Label><Label>不重复的输出标识字段（可选）<Input disabled={!visibleRules} value={visibleRules?.find(rule=>rule.type==='unique')?.field??''} onChange={event=>updateSimpleRule('unique',event.target.value?{type:'unique',field:event.target.value}:null)}/></Label></div><p className="hint">按需求填写条数。标识字段使用实现输出字段名，可在映射确认后填写；示例条数不会自动成为全量要求。</p><details><summary>数据范围与核验规则</summary><Label>规则 JSON<Textarea className="code-input" rows={4} value={rulesJson} onChange={event => {markDirty('requirement');setRulesJson(event.target.value);}} /></Label></details><Button disabled={!!pending} onClick={() => void saveRequirement()}>保存需求</Button>{pages.requirements.nextCursor && <Button onClick={() => void moreCollection(draft, 'requirements', pages.requirements.nextCursor!)}>更多需求</Button>}
       <Label>字段<NativeSelect disabled={!!liveIntent||locksEditor(retryCapture.current)} value={fieldId} onChange={event=>selectField(event.target.value)}><option value="">新字段</option>{(pages.fields.items as MaterialField[]).map(item => <option key={item.id} value={item.id}>{item.dataset}.{item.name}</option>)}</NativeSelect></Label>
      <div className="material-grid"><Label>数据集<Input value={fieldDataset} onChange={event => {markDirty('field');setFieldDataset(event.target.value);}} /></Label><Label>字段名<Input value={fieldName} onChange={event => {markDirty('field');setFieldName(event.target.value);}} /></Label></div><Label>明确含义<Textarea value={fieldDescription} onChange={event => {markDirty('field');setFieldDescription(event.target.value);}} /></Label><div className="material-grid"><Label>值类型<NativeSelect value={fieldValueType} onChange={event => {markDirty('field');setFieldValueType(event.target.value as MaterialField['valueType'] | '');}}><option value="">未指定</option>{['string','number','boolean','object','array','null'].map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect></Label><Label>来源要求<NativeSelect value={fieldPolicy} onChange={event => {markDirty('field');setFieldPolicy(event.target.value as MaterialField['sourcePolicy']);}}><option value="any-evidenced">任一有证据来源</option><option value="page-displayed">必须按页面显示值</option></NativeSelect></Label></div><details><summary>高级实现信息与来源约束</summary><Label>输出 JSON Pointer（可选）<Input value={fieldPath} onChange={event => {markDirty('field');setTechnicalDirty(true);setFieldPath(event.target.value);}} placeholder="/records/0/amount" /></Label><p className="hint">json-record 与 dom-text 都只固定数据验证规则；示范值不会成为输出常量。</p><Label>来源规则 JSON<Textarea className="code-input" rows={5} value={sourceProofJson} onChange={event => {markDirty('field');setTechnicalDirty(true);setSourceProofJson(event.target.value);}} /></Label></details>
       <div className="material-actions"><Button disabled={!live||!!pending} onClick={()=>void beginLive()}>添加所需字段（实时页面）</Button><Button disabled={!card} onClick={() => beginSelection('field')}>从历史页绑定元素</Button>{fieldTarget && <><span className="muted">{fieldTarget.kind === 'dom-node' ? `节点 ${fieldTarget.nodeId}` : '截图区域（非 DOM）'}</span><Button onClick={()=>setConfirmClear(true)}>解除绑定</Button></>}</div>
      {confirmClear&&<p role="alert">解除该字段的绑定，保留说明？<Button onClick={()=>{markDirty('field');setBindingAction('clear');setFieldTarget(null);setFieldAnnotationId('');setConfirmClear(false);}}>确认解除绑定</Button><Button onClick={()=>setConfirmClear(false)}>保留绑定</Button></p>}
      {fieldTarget && <SourceTargetPreview projectId={projectId} target={fieldTarget}/>}
      {fieldTarget && <Label>关联元素注释（可选）<NativeSelect value={fieldAnnotationId} onChange={event => {markDirty('field');setFieldAnnotationId(event.target.value);}}><option value="">无注释</option>{(pages.annotations.items as MaterialAnnotation[]).filter(item => JSON.stringify(item.target) === JSON.stringify(fieldTarget)).map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 70)}</option>)}</NativeSelect></Label>}
      {!selectedRequirement&&<p className="hint">请先在“需求”中选择这个字段所属的需求；卡片的新关联不会自动改变字段归属。</p>}
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
