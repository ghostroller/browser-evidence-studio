import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatasetIdentity, ExecutionBinding, ExecutionMode } from '@/contracts/execution';
import { sameReplayPosition, type BoundedPage, type HistoricalElementRef, type ReadBudget } from '@/contracts/recording';
import { atomicJson, safeFile } from '@/evidence/files';
import { EvidenceReader } from '@/evidence/reader';
import { PersistentDatasetService, canonicalJson, executionId } from '@/runner/datasets';
import { fingerprintInput, fingerprintWorkflow } from '@/runner/fingerprint';
import type { DatasetSummary, StepSummary, WorkflowPrepared, WorkflowRunResult } from '@/runner/manager';
import type { StepEvent } from '@/runner/steps';
import { CapturedJsonSourceReader } from '@/validator/captured-json-source';
import { CapturedDomSourceReader } from '@/validator/captured-dom-source';
import { ValidatorService } from '@/validator/service';
import type { HumanReview, ValidationReport } from '@/validator/types';
import { ensure } from '@/shared/errors';
import type { ProjectMaterials } from './project-materials';
import { materialBudget } from './project-materials';
import { checkpointSourceProofs, checkpointSourceTargets } from './checkpoint-sources';
import { SourceModel } from '@/replay/source-model';
import type { CaptureCoordinator } from '@/capture/coordinator';
import type { CheckpointHostScope } from '@/runner/manager';

const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
interface HostExecution {
  binding:ExecutionBinding;runId:string;validationId:string;pageId:string;startedAt:string;finishedAt?:string;status:string;
  workflowAttemptId?:string;codeFingerprint?:string;inputFingerprint?:string;snapshotVerified:boolean;
  steps:StepSummary[];datasets:DatasetSummary[];assertions:WorkflowRunResult['assertions'];
}
export type ExecutionSummary=Omit<HostExecution,'steps'|'datasets'|'assertions'> & {counts:{steps:number;datasets:number}};
export type ReportSummary=Omit<ValidationReport,'requirements'|'datasets'> & {reportId:string;contentHash:string;counts:{requirements:number;datasets:number}};
interface StoredReport {reportId:string;contentHash:string;report:ValidationReport}
interface AttemptScope {executionId:string;attemptId:string;recordingId:string;pageId:string;startedAt:string;finishedAt?:string}
interface StoredSample {sourceRef:string;target:HistoricalElementRef;scope:{executionId:string;attemptId:string;recordingId:string};createdAt:string}
export interface ManagedExecution {binding:ExecutionBinding;datasets:PersistentDatasetService;snapshotDirectory:string;prepared(value:WorkflowPrepared):Promise<void>;saveStep(event:StepEvent):Promise<void>;finish(result:WorkflowRunResult):Promise<void>;close():Promise<void>}
export function boundedItems<T>(items:T[],scope:string,budget:ReadBudget):BoundedPage<T>{
  let offset=0;const binding=hash({scope,items});
  if(budget.cursor){let cursor:any;try{cursor=JSON.parse(Buffer.from(budget.cursor,'base64url').toString('utf8'));}catch{ensure(false,'Malformed cursor');}ensure(cursor.binding===binding&&Number.isSafeInteger(cursor.offset)&&cursor.offset>=0&&cursor.offset<=items.length,'Cursor belongs to another immutable selection',409);offset=cursor.offset;}
  const selected:T[]=[];let page:BoundedPage<T>={items:[],returnedBytes:0,outputTruncated:false};
  for(const item of items.slice(offset,offset+budget.limit)){
    const next=[...selected,item],more=offset+next.length<items.length;
    const candidate={items:next,returnedBytes:budget.maxBytes,outputTruncated:more,...(more?{nextCursor:Buffer.from(JSON.stringify({binding,offset:offset+next.length})).toString('base64url')}:{})};
    if(Buffer.byteLength(JSON.stringify(candidate))>budget.maxBytes)break;
    selected.push(item);page=candidate;
  }
  ensure(selected.length||offset===items.length,'A complete item exceeds the explicit read budget',413);
  page.returnedBytes=0;let size=Buffer.byteLength(JSON.stringify(page));while(page.returnedBytes!==size){page.returnedBytes=size;size=Buffer.byteLength(JSON.stringify(page));}return page;
}
function summary(value:HostExecution):ExecutionSummary{const {steps,datasets,assertions,...base}=value;return {...base,counts:{steps:steps.length,datasets:datasets.length}};}
function reportSummary(value:StoredReport):ReportSummary{const {requirements,datasets,...base}=value.report;return {...base,reportId:value.reportId,contentHash:value.contentHash,counts:{requirements:requirements.length,datasets:datasets.length}};}

/** Host-owned binding and source maps; none of these facts are taken from HTTP
 * fingerprints, sourceRefs, knownRefs, snapshotVerified or review flags. */
export class ProjectExecutions {
  private active=new Map<string,PersistentDatasetService>();
  private terminal=new Set<string>();
  constructor(private readonly root:string,private readonly materials:ProjectMaterials){}
  private async directory(id:string){const binding=await safeFile(this.root,`executions/${executionId(id)}/binding.json`);return path.dirname(binding);}
  private async json<T>(directory:string,name:string,maxBytes=2*1024*1024):Promise<T>{const file=await safeFile(directory,name);ensure((await stat(file)).size<=maxBytes,'Stored execution metadata exceeds its budget',413);return JSON.parse(await readFile(file,'utf8'));}
  private async original(directory:string,name:string,value:unknown){const serialized=JSON.stringify(value);ensure(Buffer.byteLength(serialized)<=2*1024*1024,'Execution metadata exceeds 2 MiB',413);const file=await open(path.join(directory,name),'wx',0o600);try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}}
  async begin(input:{executionId:string;projectId:string;materialRevisionId:string;materialContentHash:string;directory:string;dependencyLockPath:string;input:unknown;mode:ExecutionMode;runId:string;pageId:string;environmentRef:string}):Promise<ManagedExecution>{
    const revision=await this.materials.service.revision(input.projectId,input.materialRevisionId,input.materialContentHash);
    const fingerprint=await fingerprintWorkflow(input.directory,input.dependencyLockPath);
    const binding:ExecutionBinding={schemaVersion:1,executionId:input.executionId,projectId:input.projectId,materialRevisionId:revision.revisionId,materialContentHash:revision.contentHash,codeFingerprint:fingerprint.sha256,inputFingerprint:fingerprintInput(input.input),environmentRef:input.environmentRef,mode:input.mode};
    const datasets=await PersistentDatasetService.open(this.root,binding),directory=await this.directory(binding.executionId);
    const value:HostExecution={binding,runId:input.runId,validationId:input.executionId,pageId:input.pageId,startedAt:new Date().toISOString(),status:'starting',snapshotVerified:false,steps:[],datasets:[],assertions:[]};
    try{await this.original(directory,'host-start.json',summary(value));await atomicJson(path.join(directory,'host-state.json'),value);}catch(error){await datasets.close();throw error;}
    const snapshotDirectory=path.join(directory,'code');try{await mkdir(snapshotDirectory);ensure((await lstat(snapshotDirectory)).isDirectory()&&!(await lstat(snapshotDirectory)).isSymbolicLink(),'Snapshot directory must not be a link');}catch(error){await datasets.close();throw error;}
    this.active.set(binding.executionId,datasets);
    let tail:Promise<unknown>=Promise.resolve();
    const save=(operation:()=>Promise<void>)=>{const pending=tail.then(operation);tail=pending.catch(()=>{});return pending;};
    return {binding,datasets,snapshotDirectory,
      prepared:prepared=>save(async()=>{
        ensure(prepared.fingerprintBefore.sha256===binding.codeFingerprint&&prepared.inputSha256===binding.inputFingerprint&&prepared.snapshot?.sourceFingerprint===binding.codeFingerprint,'Executed snapshot differs from fixed binding',409);
        value.codeFingerprint=prepared.fingerprintBefore.sha256;value.inputFingerprint=prepared.inputSha256;value.snapshotVerified=true;value.status='running';
        await this.original(directory,'host-prepared.json',{codeFingerprint:value.codeFingerprint,inputFingerprint:value.inputFingerprint,snapshot:prepared.snapshot});await atomicJson(path.join(directory,'host-state.json'),value);
      }),
      saveStep:event=>save(async()=>{
        await datasets.saveStep(event);ensure(event.identity.executionId===binding.executionId,'Step belongs to another execution',409);
        const attempt=executionId(event.identity.attemptId),name=`host-attempt-${attempt}`;
        if(event.state==='running'){
          const scope={executionId:binding.executionId,attemptId:attempt,recordingId:input.runId,pageId:input.pageId,startedAt:new Date().toISOString()};
          try{await this.original(directory,`${name}-start.json`,scope);}catch(error){
            if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
            const original=await this.json<AttemptScope>(directory,`${name}-start.json`,4096);
            ensure(original.executionId===scope.executionId&&original.attemptId===attempt&&original.recordingId===scope.recordingId&&original.pageId===scope.pageId,'Existing host attempt has another identity',409);
          }
        }
        else if(!['awaiting-human'].includes(event.state))await this.original(directory,`${name}-end.json`,{finishedAt:new Date().toISOString()});
        const {result,...eventSummary}=event;value.steps.push({...eventSummary,...(result&&'error' in result?{error:result.error}:{})});
        ensure(value.steps.length<=4096,'Step summary budget exceeded',413);await atomicJson(path.join(directory,'host-state.json'),value);
      }),
      finish:result=>{this.terminal.add(binding.executionId);return save(async()=>{
        ensure(result.executionBinding?.executionId===binding.executionId&&result.workflowAttemptId,'Worker result lacks fixed execution identity',409);
        value.status=result.status;value.finishedAt=new Date().toISOString();value.workflowAttemptId=result.workflowAttemptId;value.steps=result.steps??[];value.datasets=result.datasetSummaries??[];value.assertions=result.assertions;
        // This identity is generated by manager; broad workflow scope is used only
        // for legacy emitData batches whose actual attempt is the workflow itself.
        await this.original(directory,`host-attempt-${executionId(result.workflowAttemptId)}-start.json`,{executionId:binding.executionId,attemptId:result.workflowAttemptId,recordingId:input.runId,pageId:input.pageId,startedAt:value.startedAt});
        await this.original(directory,`host-attempt-${result.workflowAttemptId}-end.json`,{finishedAt:value.finishedAt});
        await this.original(directory,'host-finished.json',value);await atomicJson(path.join(directory,'host-state.json'),value);
      });},
      close:async()=>{this.terminal.add(binding.executionId);await tail;this.active.delete(binding.executionId);await datasets.close();},
    };
  }
  private async state(projectId:string,id:string):Promise<HostExecution>{
    const directory=await this.directory(id),value=await this.json<HostExecution>(directory,'host-state.json');
    ensure(value.binding.projectId===projectId&&value.binding.executionId===id,'Execution belongs to another project',403);
    const binding=await this.json<ExecutionBinding>(directory,'binding.json');ensure(canonicalJson(value.binding)===canonicalJson(binding),'Execution projection binding mismatch',409);
    if(!value.finishedAt&&!this.active.has(id))value.status='interrupted';return value;
  }
  async summary(projectId:string,id:string){return summary(await this.state(projectId,id));}
  async items(projectId:string,id:string,collection:'steps'|'datasets',budget:ReadBudget){ensure(collection==='steps'||collection==='datasets','Unknown execution collection');const value=await this.state(projectId,id);return boundedItems<StepSummary|DatasetSummary>(value[collection],`${id}/${collection}`,budget);}
  private async data(projectId:string,identity:DatasetIdentity){const value=await this.state(projectId,identity.executionId);if(value.finishedAt)ensure(value.datasets.some(item=>item.attemptId===identity.attemptId&&item.datasetId===identity.datasetId),'Dataset is not in the persisted execution result',404);return this.active.get(identity.executionId)??PersistentDatasetService.openReader(this.root,identity.executionId);}
  async batches(projectId:string,identity:DatasetIdentity,budget:ReadBudget){return (await this.data(projectId,identity)).batches(identity,budget);}
  async records(projectId:string,identity:DatasetIdentity,batchId:string,body:any){return (await this.data(projectId,identity)).records(identity,batchId,{...materialBudget(body),...(body.fields?{fields:body.fields}:{}),...(body.entity?{entity:body.entity}:{})});}
  private async scope(directory:string,attemptId:string):Promise<AttemptScope|undefined>{
    try{const start=await this.json<AttemptScope>(directory,`host-attempt-${executionId(attemptId)}-start.json`,4096),end=await this.json<{finishedAt:string}>(directory,`host-attempt-${attemptId}-end.json`,4096);return {...start,...end};}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  async assess(projectId:string,id:string,selected?:DatasetIdentity[]):Promise<ReportSummary>{
    const value=await this.state(projectId,id);ensure(value.finishedAt&&value.workflowAttemptId,'Execution must finish before independent assessment',409);
    const directory=await this.directory(id),data=await this.dataReader(id);
    const byName=new Map<string,DatasetSummary[]>();for(const item of value.datasets)byName.set(item.datasetId,[...(byName.get(item.datasetId)??[]),item]);
    const identities=selected??[...byName.values()].filter(items=>items.length===1).map(([item])=>({executionId:id,attemptId:item.attemptId,datasetId:item.datasetId}));
    ensure(identities.length<=64&&identities.every(identity=>identity.executionId===id&&value.datasets.some(item=>item.attemptId===identity.attemptId&&item.datasetId===identity.datasetId)),'Select only exact datasets in the persisted execution result',403);
    // User selection must never turn overlapping live scopes into apparent
    // uniqueness. A workflow-level batch owns only observations outside steps.
    const allAttemptIds=[...new Set([value.workflowAttemptId,...value.steps.filter(item=>item.state==='running').map(item=>item.identity.attemptId)])];
    const scopes=(await Promise.all(allAttemptIds.map(attempt=>this.scope(directory,attempt)))).filter((item):item is AttemptScope=>!!item);
    ensure(scopes.length===allAttemptIds.length,'Host attempt scope is incomplete; preserve and inspect execution originals',409);
    const reader=new EvidenceReader(path.join(this.root,'runs',value.runId));
    const jsonSources=new CapturedJsonSourceReader(async sourceRef=>{
      let metadata;try{metadata=await reader.artifactMetadata(sourceRef);}catch(error){if(['ENOENT','ARTIFACT_NOT_FOUND'].includes((error as {code:string}).code))return;throw error;}
      const observed=typeof metadata.source==='object'?metadata.source?.responseObservedAt:undefined;
      const time=typeof observed==='string'?Date.parse(observed):NaN,sourcePage=typeof metadata.source==='object'?metadata.source?.pageId:undefined,matches=scopes.filter(scope=>scope.executionId===id&&scope.recordingId===value.runId&&sourcePage===scope.pageId&&time>=Date.parse(scope.startedAt)&&time<=Date.parse(scope.finishedAt!));
      const stepMatches=matches.filter(scope=>scope.attemptId!==value.workflowAttemptId),owners=stepMatches.length?stepMatches:matches;
      if(owners.length!==1)return;
      return {reader,scope:{executionId:id,attemptId:owners[0].attemptId,recordingId:value.runId}};
    });
    const domSources=new CapturedDomSourceReader(async sourceRef=>{
      if(!/^dom-[a-f0-9-]{36}$/.test(sourceRef))return;
      const sample=await this.json<StoredSample>(directory,`sample-${sourceRef}.json`,16384).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;});
      if(!sample||sample.sourceRef!==sourceRef||sample.scope.executionId!==id||sample.scope.recordingId!==value.runId||!identities.some(identity=>identity.attemptId===sample.scope.attemptId)||sample.target.position.recordingId!==value.runId||sample.target.position.pageId!==value.pageId)return;
      return {replay:await this.materials.replay(value.runId,projectId),target:sample.target,scope:sample.scope};
    });
    const sources={read:(reference:string,budget:ReadBudget)=>reference.startsWith('dom-')?domSources.read(reference,budget):jsonSources.read(reference,budget)};
    const reviews={read:async()=>this.readReviews(directory,value)};
    const report=await new ValidatorService(this.materials.service,data,sources,reviews).validate({attemptId:value.workflowAttemptId,datasetIdentities:identities,executedCodeFingerprint:value.codeFingerprint,executedInputFingerprint:value.inputFingerprint,snapshotVerified:value.snapshotVerified,assertions:value.assertions},{maxBytes:1024*1024,limit:2000});
    const stored:StoredReport={reportId:randomUUID(),contentHash:hash(report),report};await this.original(directory,`report-${stored.reportId}.json`,stored);return reportSummary(stored);
  }
  private async dataReader(id:string){return this.active.get(id)??PersistentDatasetService.openReader(this.root,id);}
  async sampleCheckpoint(projectId:string,scope:CheckpointHostScope,capture:Pick<CaptureCoordinator,'recordingPosition'|'samplePresentation'|'flush'>,requirementIds:unknown,assertCurrent:()=>void,signal?:AbortSignal):Promise<string[]>{
    scope=structuredClone(scope);requirementIds=structuredClone(requirementIds);
    const current=()=>{signal?.throwIfAborted();assertCurrent();ensure(this.active.has(scope.executionId)&&!this.terminal.has(scope.executionId),'Checkpoint execution is no longer active',409);};
    current();const value=await this.state(projectId,scope.executionId);current();
    const revision=await this.materials.service.revision(projectId,value.binding.materialRevisionId,value.binding.materialContentHash);current();
    if(!checkpointSourceProofs(revision.content,requirementIds).length)return [];
    await capture.flush();current();const position=capture.recordingPosition;
    ensure(position&&position.recordingId===value.runId&&position.pageId===value.pageId,'Checkpoint has no current source recording position',409);
    const replay=await this.materials.replay(value.runId,projectId);current();const window=await replay.window(position,signal);current();
    ensure(!window.gaps.some(gap=>gap.category==='structure'||gap.category==='metadata'),'Checkpoint source has a structural or metadata gap',409);
    const targets=checkpointSourceTargets(revision.content,requirementIds,new SourceModel(window.records),position),refs:string[]=[];
    for(const target of targets){current();const sample=await capture.samplePresentation(target,signal);current();refs.push(await this.recordSample(projectId,scope.executionId,scope.attemptId,sample.ref,signal));current();}
    return refs;
  }
  /** Only called after manager supplies an actual active attempt and capture
   * supplies a durable sample. No public route accepts this host scope. */
  async recordSample(projectId:string,id:string,attemptId:string,target:HistoricalElementRef,signal?:AbortSignal):Promise<string>{
    target=structuredClone(target);const writer=this.active.get(id);
    const current=()=>{signal?.throwIfAborted();ensure(writer&&this.active.get(id)===writer&&!this.terminal.has(id),'Execution ended while sampling its source',409);};
    current();const value=await this.state(projectId,id);current();ensure(!value.finishedAt&&target.position.recordingId===value.runId&&target.position.pageId===value.pageId,'Sample does not belong to the active execution recording',409);
    executionId(attemptId);
    const replay=await this.materials.replay(value.runId,projectId);current();const node=await replay.node(target,{maxBytes:1024*1024,limit:1},signal);current();
    ensure(node.metadataComplete&&node.presentation!==undefined,'Source presentation did not reach the archive',409);
    if(node.presentation.status==='present')ensure(sameReplayPosition(node.presentation.value.sampledAt,target.position),'Source sample is stale',409);
    const sourceRef=`dom-${randomUUID()}`,sample:StoredSample={sourceRef,target,scope:{executionId:id,attemptId,recordingId:value.runId},createdAt:new Date().toISOString()};
    const directory=await this.directory(id);current();await this.original(directory,`sample-${sourceRef}.json`,sample);current();return sourceRef;
  }
  private async report(projectId:string,id:string,reportId:string){await this.state(projectId,id);const stored=await this.json<StoredReport>(await this.directory(id),`report-${executionId(reportId)}.json`);ensure(stored.reportId===reportId&&stored.report.binding.executionId===id&&stored.report.binding.projectId===projectId&&hash(stored.report)===stored.contentHash,'Fixed report integrity check failed',409);return stored;}
  async reportSummary(projectId:string,id:string,reportId:string){return reportSummary(await this.report(projectId,id,reportId));}
  async reports(projectId:string,id:string,budget:ReadBudget){
    await this.state(projectId,id);const directory=await this.directory(id),files=(await readdir(directory)).filter(name=>/^report-[a-f0-9-]{36}\.json$/.test(name)).sort();
    ensure(files.length<=1000,'Report catalog exceeds 1000 reports; use an exact report ID',413);
    const ids=boundedItems(files,`${id}/reports`,{...budget,maxBytes:Math.min(budget.maxBytes,4096)});
    const items:ReportSummary[]=[];for(const file of ids.items){const stored=await this.json<StoredReport>(directory,file);ensure(hash(stored.report)===stored.contentHash,'Report integrity check failed',409);items.push(reportSummary(stored));}
    const result={...ids,items,returnedBytes:0};let bytes=Buffer.byteLength(JSON.stringify(result));while(bytes!==result.returnedBytes){result.returnedBytes=bytes;bytes=Buffer.byteLength(JSON.stringify(result));}ensure(bytes<=budget.maxBytes,'Report summaries exceed budget; request fewer items',413);return result;
  }
  async reportItems(projectId:string,id:string,reportId:string,collection:'requirements'|'datasets',budget:ReadBudget){ensure(collection==='requirements'||collection==='datasets','Unknown report collection');const stored=await this.report(projectId,id,reportId);return boundedItems<ValidationReport['requirements'][number]|ValidationReport['datasets'][number]>(stored.report[collection],`${id}/${reportId}/${collection}`,budget);}
  async review(projectId:string,id:string,reportId:string,body:{requirementId:string;decision:HumanReview['decision'];reason:string}){
    const stored=await this.report(projectId,id,reportId),report=stored.report;
    ensure(report.requirements.some(item=>item.requirementId===body.requirementId)&&['accept','reject','exception'].includes(body.decision)&&typeof body.reason==='string'&&body.reason.trim().length>0&&body.reason.length<=4000,'Review requires an exact requirement, decision and reason');
    const review:HumanReview={id:randomUUID(),requirementId:body.requirementId,decision:body.decision,reason:body.reason,materialRevisionId:report.binding.materialRevisionId,materialContentHash:report.binding.materialContentHash,codeFingerprint:report.binding.codeFingerprint,inputFingerprint:report.binding.inputFingerprint,executionId:id,attemptId:report.attemptId};
    await this.original(await this.directory(id),`review-${review.id}.json`,{...review,reportId,reportHash:stored.contentHash,createdAt:new Date().toISOString()});return review;
  }
  private async readReviews(directory:string,value:HostExecution){const files=(await readdir(directory)).filter(name=>/^review-[a-f0-9-]{36}\.json$/.test(name));ensure(files.length<=2000,'Human review list exceeds its read budget',413);const reviews=await Promise.all(files.map(file=>this.json<HumanReview>(directory,file,16*1024)));ensure(Buffer.byteLength(JSON.stringify(reviews))<=1024*1024,'Human review bytes exceed budget',413);return reviews.filter(review=>review.executionId===value.binding.executionId);}
}
