import { mkdir, readFile, readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { sameReplayPosition } from '@/contracts/recording';
import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser, type Page, type Dialog } from 'puppeteer-core';
import { SocketTransport } from '../browser/connection';
import { GateTransport, type ProtocolCommand } from '@/runner/gate';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { atomicJson, jsonLines, safeFile } from '@/evidence/files';
import { CaptureCoordinator, type PageIdentity } from '@/capture/coordinator';
import { ensure, now, StudioError } from '@/shared/errors';
import { startWorkflow, type WorkflowHandle } from '@/runner/manager';
import type { HumanRequest } from '@/contracts/workflow';
import { fingerprintInput, fingerprintWorkflow, loadWorkflow } from '@/runner/fingerprint';
import { ValidationStartGrants, type ValidationStartBinding, type ValidationStartGrant } from './validation-start-grants';
import { clickManagedElement } from '@/runner/managed-input';
import { connectManagedPage } from '@/runner/puppeteer';
import { captureCheckpointMaterials } from '@/capture/checkpoint';
import { snapshotElements } from '@/capture/privacy';
import { appendReview, readReviews, type ReviewQuery } from './reviews';
import { BrowserSessionLifecycle } from './browser-session';
import { WorkspaceManagement, type Project, type Profile } from './workspace-management';
import { ProjectMaterials, materialSummary } from './project-materials';
import { TaskAuthorizations, type TaskCapability } from './task-authorization';
import type { ReplayHost } from './replay-host';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { rewriteReplayEvent } from '@/resources/replay-resources';
import { ProjectExecutions, type ManagedExecution } from './project-executions';
import { captureMetadata } from '@/capture/url-privacy';
import { browserUrl, browserShortcut, type BrowserCommand, type BrowserPageStatus, type BrowserSessionStatus } from '../browser/browser-controls';
import type { RuntimeDownloads, BrowserPresentation, PageStatusReader } from '../browser/runtime';
import { commitValidation, recoverValidationCatalog, registerValidation, saveValidationCatalog, type ValidationLifecycleContext, type ValidationLifecycleObserver, type ValidationLifecycleStage, type ValidationRecord, type ValidationRecoveryDiagnostic } from './validation-lifecycle';
export type { ValidationLifecycleContext, ValidationLifecycleObserver, ValidationLifecycleStage } from './validation-lifecycle';

export type ManagedPage<I extends PageIdentity, V> = I & { view:V; page:Page; capture?:CaptureCoordinator; loadError?:BrowserPageStatus['loadError']; find?:BrowserPageStatus['find']; dialog?:{id:string;value:Dialog}; lastUrl?:string; }
interface ManagedOperation { browser:Browser; gate:GateTransport; page:Page; targetId:string; documentEpoch:number; }
interface PendingOperation { targetId:string; leaseEpoch:number; abort:AbortController; gate?:GateTransport; promise:Promise<ManagedOperation>; }
interface CheckpointOperation { id:string; pageId:string; phase:'draining'|'capturing'|'saving'; startedAt:string; abort:AbortController; done:Promise<void>; }
interface HandoffReleaseResult { passed:true; handoffId:string; }
function canonicalValidationInput(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonicalValidationInput);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalValidationInput(item)]));
  return value;
}
interface ValidationLaunch {
  abort:AbortController; done:Promise<void>; finish:()=>void; validationId:string; validationRunId:string;
  grant?:ValidationStartGrant; claimed:boolean; handle?:WorkflowHandle;
  target?:{pageId:string;targetId:string;generation:number};
}
export interface SessionRuntime<I extends PageIdentity,V,S> {
  id?:string; projectId:string; profileId:string; store?:EvidenceStore; pages:Map<string,ManagedPage<I,V>>; selectedPageId:string;
  foregroundOrdinal?:number;
  session:S; controller:'human'|'agent'|'none'; leaseEpoch:number; capture:string; execution:string;
  operation?:ManagedOperation; pendingOperation?:PendingOperation; locked:boolean; stopping?:boolean; ending?:boolean; selection?:unknown; handoff?:any;
  pageClosures?:Set<Promise<void>>;
  pageCreations?:Set<Promise<unknown>>;
  stopDownloads?:()=>Promise<void>;releaseDownloads?:()=>void;
  checkpointTask?:CheckpointOperation;
  handoffReleases?:Map<string,Promise<HandoffReleaseResult>>;
}
export interface ActiveRun<I extends PageIdentity,V,S> extends SessionRuntime<I,V,S> { id:string; store:EvidenceStore; }
export abstract class StudioCore<I extends PageIdentity,V,S> {
  readonly instanceId=randomUUID();
  protected readonly authoringTasks=new Map<string,{appInstanceId:string;sessionId:string|undefined;fingerprint:string;promise:Promise<any>}>();
  protected browser?:BrowserSessionLifecycle<SessionRuntime<I,V,S>>;
  protected browserDownloads?:RuntimeDownloads;
  protected closedPages:{url:string;title:string}[]=[];
  protected stopTask?:{owner:unknown;promise:Promise<unknown>};
  protected browserNotice?:string;
  protected browserUiAction?:BrowserSessionStatus['uiAction'];
  get browserSessionId(){return this.browser?.id;}
  projects:Project[]=[]; profiles:Profile[]=[]; runs:any[]=[]; active?:ActiveRun<I,V,S>;
  connection:any;
  protected observer!:Browser;
  protected queue:Promise<unknown>=Promise.resolve();
  protected historyRun?:string;
  protected workflow?:WorkflowHandle;
  protected workflowSettlement?:Promise<void>;
  protected workflowStarting?:{abort:AbortController;gate?:GateTransport;done:Promise<void>;finish:()=>void};
  protected validationLaunch?:ValidationLaunch;
  protected readonly validationGrants=new ValidationStartGrants();
  readonly management=new WorkspaceManagement(this);
  taskAuthorizations(projectId:string){return this.tasks.list(projectId);}
  readonly materials:ProjectMaterials;
  abstract readonly replayHost:Pick<ReplayHost,'close'>;
  abstract readonly runtimeProvider: 'electron' | 'chromium';
  readonly executions:ProjectExecutions;
  readonly tasks=new TaskAuthorizations(()=>this.taskAuthorizationChanged());
  protected executingAuthorizationId?:string;
  protected browserAuthorizationId?:string;
  protected closing=false;
  protected humanDone?:{resolve:()=>void;reject:(e:Error)=>void};
  protected validations:ValidationRecord[]=[];
  protected validationRecovery:{diagnostics:ValidationRecoveryDiagnostic[];catalogStatus:'rebuilt'|'write-failed'}={diagnostics:[],catalogStatus:'rebuilt'};
  protected fixture?:{url:string;close:()=>Promise<void>};
  onChanged=()=>{};
  constructor(readonly root:string, readonly window:BrowserPresentation<V>, public endpoint:string, readonly applicationPath:string, protected readonly lifecycleObserver?:ValidationLifecycleObserver) {this.materials=new ProjectMaterials(root);this.executions=new ProjectExecutions(root,this.materials);}
  protected gateCommand(_page:ManagedPage<I,V>,_command:Readonly<ProtocolCommand>):void {}
  protected workerEnvironment():NodeJS.ProcessEnv|undefined{return undefined;}
  protected abstract providerSession(profile:Profile):Promise<S>;
  protected abstract releaseProviderSession(session:S):Promise<void>;
  protected abstract configurePermissions(session:S):void;
  protected abstract providerEnvironment(session:S):unknown;
  protected abstract installNavigationPolicy(session:S):void;
  protected abstract ensureDownloads():Promise<void>;
  protected abstract pageContents(page:ManagedPage<I,V>):PageStatusReader|undefined;
  protected abstract hostIdentity(page:ManagedPage<I,V>):{provider:'electron';webContentsId:number}|{provider:'chromium';browserInstanceId:string};
  protected abstract addPage(runtime:SessionRuntime<I,V,S>,openerPageId?:string,existingView?:V,activate?:boolean):Promise<ManagedPage<I,V>>;
  protected abstract loadHumanUrl(page:ManagedPage<I,V>,url:string):void;
  abstract browserCommand(body:BrowserCommand):Promise<unknown>;
  abstract navigate(url:string,page?:ManagedPage<I,V>,initial?:boolean):Promise<{url:string}>;
  abstract navigateHistory(direction:string):Promise<unknown>;
  protected abstract closePageContents(page:ManagedPage<I,V>):Promise<void>;
  protected abstract screenshot(page:ManagedPage<I,V>):Promise<Uint8Array>;
  protected abstract stopPage(page:ManagedPage<I,V>):void;
  abstract saveProfile():Promise<unknown>;
  protected taskAuthorizationChanged(){
    if(!this.closing&&this.executingAuthorizationId&&this.tasks.get(this.executingAuthorizationId).status!=='active')void this.stopRunner().catch(error=>console.error('Task revocation could not complete worker shutdown',error));
    this.onChanged();
  }
  protected async sessionAudit(type:string,data:unknown,sessionId=this.browserSessionId){
    const directory=path.join(this.root,'session-audit');await mkdir(directory,{recursive:true});
    const file=await open(path.join(directory,sessionId+'.jsonl'),'a',0o600);
    try{await file.writeFile(JSON.stringify({at:now(),sessionId,type,data})+'\n');await file.sync();}finally{await file.close();}
  }
  protected pageAudit(r:SessionRuntime<I,V,S>,event:any,sessionId=this.browserSessionId){return this.active===r?r.store!.appendEvent(event):this.sessionAudit(event.type,{...event,projectId:r.projectId,profileId:r.profileId},sessionId);}
  async authorizeTask(body:any){return this.serialized(async()=>{
    const project=this.projects.find(item=>item.id===body.projectId);ensure(project,'Unknown project',404);this.assertActivity(body.projectId,body.profileId);
    ensure(Array.isArray(body.capabilities),'Choose task capabilities');
    const browser=body.capabilities.some((value:string)=>['page-read','page-act','page-create','execute'].includes(value));
    if(!browser)return this.tasks.issue({projectId:project.id},{origins:[],pages:[],capabilities:body.capabilities,durationMs:body.durationMs,maxOperations:body.maxOperations});
    this.assertValidationIdle();const r=this.live();ensure(r.controller==='human','Task authorization requires human ownership',409);
    ensure(body.projectId===r.projectId&&body.profileId===r.profileId&&body.sessionId===this.browserSessionId&&body.leaseEpoch===r.leaseEpoch,'Task authorization target or lease is stale',409);
    ensure(Array.isArray(body.pageIds)&&body.pageIds.length>0,'Choose the pages covered by task authorization');
    const pages=body.pageIds.map((id:string)=>{const page=r.pages.get(id);ensure(page,'Task page does not exist',409);return {pageId:page.pageId,targetId:page.targetId};});
    const grant=await this.tasks.issue({projectId:r.projectId,sessionId:this.browserSessionId!,profileId:r.profileId,directory:project.scriptDirectory},{origins:body.origins,pages,capabilities:body.capabilities,durationMs:body.durationMs,maxOperations:body.maxOperations});
    try {await this.sessionAudit('task-authorization-issued',grant);if(this.active===r){await r.store!.appendEvent({type:'task-authorization-issued',source:'ui',data:grant});await r.store!.flush();}if(grant.capabilities.some(value=>['page-act','page-create','execute'].includes(value))){this.browserAuthorizationId=grant.authorizationId;await this.control('agent');}}
    catch(error){this.tasks.revoke(grant.authorizationId,'Authorization was not durably established');throw error;}
    return {...grant,leaseEpoch:r.leaseEpoch};
  });}
  async revokeTask(body:any){
    const grant=this.tasks.get(body.authorizationId);ensure(grant.projectId===body.projectId,'Task belongs to another project',403);
    this.tasks.revoke(grant.authorizationId);
    let auditFailure:unknown;
    try{await this.sessionAudit('task-authorization-revoked',{authorizationId:grant.authorizationId});}catch(error){auditFailure=error;}
    // Persistence failure must never prevent closing the revoked transport and
    // returning control. The failure is reported after those safety transitions.
    try{if(this.executingAuthorizationId===grant.authorizationId)await this.stopRunner();}
    finally{
      if(this.browserAuthorizationId===grant.authorizationId)this.browserAuthorizationId=undefined;
      const r=this.browser?.runtime;
      if(r&&this.browserSessionId===grant.sessionId){
        try{await this.revokeOperation(r);}
        finally{if(r.controller==='agent'&&!this.workflow&&!this.workflowStarting&&!this.workflowSettlement)await this.control('human');}
        if(this.active===r)await r.store!.appendEvent({type:'task-authorization-revoked',source:'ui',data:{authorizationId:grant.authorizationId}});
      }
    }
    if(auditFailure)throw auditFailure;
    return this.tasks.get(grant.authorizationId);
  }
  async authorizedOperation<T>(body:any,capability:TaskCapability,operation:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const r=this.live(),page=r.pages.get(body.pageId??r.selectedPageId),project=this.projects.find(item=>item.id===r.projectId)!;
    ensure(page&&body.projectId===r.projectId&&body.profileId===r.profileId&&body.sessionId===this.browserSessionId,'Task browser identity is stale',409);
    if(capability!=='page-read')ensure(this.browserAuthorizationId===body.authorizationId,'This authorization does not own the agent browser lease',403);
    const url=capability==='page-create'?body.startUrl:capability==='page-act'&&body.type==='navigate'?body.url:capability==='execute'&&body.executionMode!=='current-page-test'?(body.startUrl??this.current().page.url()):page.page.url();
    return this.tasks.run(body.authorizationId,capability,{projectId:r.projectId,sessionId:this.browserSessionId!,profileId:r.profileId,...(capability==='execute'?{directory:project.scriptDirectory}:{}),pageId:page.pageId,targetId:page.targetId,url},operation,signal);
  }
  protected navigationAllowed(url:string):boolean {
    if(!this.browserAuthorizationId)return true;
    const live=this.browser?.runtime;
    if(live?.controller==='human'&&!this.validationLaunch)return true;
    const grant=this.tasks.get(this.browserAuthorizationId);
    if(grant.status!=='active'||grant.sessionId!==this.browserSessionId)return false;
    if(url==='about:blank')return true;
    try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&grant.origins.includes(parsed.origin);}catch{return false;}
  }
  /** All newly persisted main metadata shares capture's URL privacy policy.
   * Byte payloads stay separate and are never transformed by this adapter. */
  protected protectCaptureMetadata(store:EvidenceStore):void {
    const appendEvent=store.appendEvent.bind(store),appendCheckpoint=store.appendCheckpoint.bind(store),putArtifact=store.putArtifact.bind(store),updateManifest=store.updateManifest.bind(store);
    store.appendEvent=input=>appendEvent(captureMetadata(input));
    store.appendCheckpoint=input=>appendCheckpoint(captureMetadata(input));
    store.putArtifact=input=>{const {data,...metadata}=input;return putArtifact({...captureMetadata(metadata),data});};
    store.updateManifest=input=>updateManifest(captureMetadata(input));
  }
  async init(){
    await mkdir(this.root,{recursive:true});
    await this.management.init();
    await mkdir(path.join(this.root,'runs'),{recursive:true});
    for(const id of await readdir(path.join(this.root,'runs'))){
      try{const store=await EvidenceStore.open(path.join(this.root,'runs',id));this.runs.push(store.manifest);await store.close();}catch(error){this.runs.push({id,status:'unreadable',error:String(error)});}
    }
    await this.refreshValidations();
    // Capture owns a separate, bounded Network CDP session. Keep this long-lived
    // page observer out of network monitoring; operation pages retain it for workflows.
    if(this.endpoint)this.observer=await puppeteer.connect({browserWSEndpoint:this.endpoint,defaultViewport:null,networkEnabled:false});
  }
  async refreshValidations(){
    ensure(!this.workflow&&!this.workflowStarting&&!this.workflowSettlement&&!this.validationLaunch,'Cannot rebuild validation history during execution',409);
    const recovered=await recoverValidationCatalog(this.root,this.runs,this.projects);
    this.validations=recovered.records;this.validationRecovery={diagnostics:recovered.diagnostics,catalogStatus:recovered.catalogStatus};this.onChanged();return recovered;
  }
  protected async saveValidations(records:ValidationRecord[]=this.validations){
    try{await saveValidationCatalog(this.root,records);this.validationRecovery.catalogStatus='rebuilt';}
    catch(error){this.validationRecovery.catalogStatus='write-failed';this.validationRecovery.diagnostics.push({code:'catalog-write-failed',message:`Validation evidence is saved, but its catalog could not be updated: ${String(error)}`});}
  }
  protected async observeValidation(stage:ValidationLifecycleStage,context:ValidationLifecycleContext,signal?:AbortSignal){
    if(!process.env.BES_TEST||!this.lifecycleObserver)return;
    signal?.throwIfAborted();
    const observed=Promise.resolve().then(()=>this.lifecycleObserver!(stage,context));
    if(!signal){await observed;return;}
    let aborted!:()=>void;const cancelled=new Promise<never>((_resolve,reject)=>{aborted=()=>reject(signal.reason??new Error('Validation stopped'));signal.addEventListener('abort',aborted,{once:true});});
    try{await Promise.race([observed,cancelled]);}finally{signal.removeEventListener('abort',aborted);}
  }
  serialized<T>(fn:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    let started=false;const next=this.queue.then(()=>{signal?.throwIfAborted();started=true;return fn();});this.queue=next.catch(()=>{});
    if(!signal)return next;
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>{if(!started)reject(new StudioError(signal.reason?.name==='TimeoutError'?408:409,signal.reason?.name==='TimeoutError'?'action_deadline':'action_cancelled','Action stopped during queue'));};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      void next.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  required(){ensure(this.active,'No active run',409);return this.active;}
  protected live(){ensure(this.browser,'No live browser session',409);return this.browser.runtime;}
  current(){const r=this.live();const p=r.pages.get(r.selectedPageId);ensure(p&&this.pageContents(p),'No live selected page',409);return p;}
  protected recordForeground(r:ActiveRun<I,V,S>,previousPageId:string|null,reason:string,observedAtMs=Date.now()){
    const selectedPageId=r.selectedPageId||null;
    const transitionOrdinal=(r.foregroundOrdinal??0)+1;r.foregroundOrdinal=transitionOrdinal;
    return r.store!.appendEvent({type:'page-foreground',source:this.runtimeProvider,occurredAt:new Date(observedAtMs).toISOString(),timeBasis:'host-wall-clock',
      ...(selectedPageId?{pageId:selectedPageId}:{}),data:{version:1,previousPageId,selectedPageId,observedAtMs,transitionOrdinal,reason}});
  }
  protected browserState():BrowserSessionStatus|null{const browser=this.browser;if(!browser)return null;const r=browser.runtime;return {sessionId:browser.id,projectId:r.projectId,profileId:r.profileId,recordingId:browser.recordingId,controller:r.controller,leaseEpoch:r.leaseEpoch,locked:r.locked,selectedPageId:r.selectedPageId,closedPageCount:this.closedPages?.length??0,downloads:this.browserDownloads?.list()??[],notice:this.browserNotice,uiAction:this.browserUiAction,pages:[...r.pages.values()].flatMap(p=>{const contents=this.pageContents(p);return contents?[{pageId:p.pageId,targetId:p.targetId,...this.hostIdentity(p),url:contents.getURL(),title:contents.getTitle(),generation:p.navigationGeneration,inspecting:!!this.active&&!!p.capture?.inspecting,openerPageId:p.openerPageId,canGoBack:contents.navigationHistory.canGoBack(),canGoForward:contents.navigationHistory.canGoForward(),loading:contents.isLoadingMainFrame?.()??false,zoomFactor:contents.getZoomFactor?.()??1,loadError:p.loadError,find:p.find,dialog:p.dialog?{id:p.dialog.id,type:p.dialog.value.type(),message:p.dialog.value.message(),defaultValue:p.dialog.value.defaultValue()}:undefined}]:[];})};}
  state(){const r=this.active;return {instanceId:this.instanceId,session:this.browserState(),validationStarting:this.validationLaunch?{validationId:this.validationLaunch.validationId,validationRunId:this.validationLaunch.validationRunId}:null,projects:this.projects,profiles:this.profiles,runs:this.runs,validations:this.validations.map(({result,...v})=>({...v,executionId:result?.executionBinding?.executionId,executionBinding:result?.executionBinding,validation:result?.validation})),validationRecovery:this.validationRecovery,fixtureUrl:this.fixture?.url,versions:{node:process.versions.node,electron:process.versions.electron,chromium:process.versions.chrome,puppeteer:'25.11.0',rrweb:'2.1.6'},active:r?{id:r.id,projectId:r.projectId,profileId:r.profileId,controller:r.controller,leaseEpoch:r.leaseEpoch,capture:r.capture,execution:r.execution,locked:r.locked,checkpoint:r.checkpointTask?{id:r.checkpointTask.id,pageId:r.checkpointTask.pageId,phase:r.checkpointTask.phase,startedAt:r.checkpointTask.startedAt}:null,pages:[...r.pages.values()].flatMap(p=>{const contents=this.pageContents(p);return contents?[{pageId:p.pageId,targetId:p.targetId,...this.hostIdentity(p),url:contents.getURL(),title:contents.getTitle(),generation:p.navigationGeneration,inspecting:p.capture!.inspecting,openerPageId:p.openerPageId}]:[];}),selectedPageId:r.selectedPageId,validationStartGrant:this.validationStartGrant({runId:r.id}).grant,handoff:r.handoff,selection:r.selection}:null,connection:this.connection};}
  createProject(body:any){return this.management.createProject(body);}
  updateProject(body:any){return this.management.updateProject(body);}
  createProfile(body:any){return this.management.createProfile(body);}
  updateProfile(body:any){return this.management.updateProfile(body);}
  manageProject(body:any){return this.management.manageProject(body);}
  manageProfile(body:any){return this.management.manageProfile(body);}
  managementDependencies(body:any){return this.management.managementDependencies(body);}
  protected assertActivity(projectId:string,profileId?:string){
    const project=this.projects.find(item=>item.id===projectId);ensure(project&&project.lifecycle!=='archived','Restore the archived project before opening or running a session',409);
    if(profileId){const profile=this.profiles.find(item=>item.id===profileId&&item.projectId===projectId);ensure(profile&&profile.lifecycle!=='disabled','Restore the disabled environment before use',409);}
  }
  async settleManagementDependencies(body:{projectId:string;profileId?:string;expectedSessionId:string|null;authorizationIds:string[]}){
    const current=await this.managementDependencies(body),ids=current.dependencies.filter(item=>item.kind==='authorization'&&item.active).map(item=>item.id).sort();
    ensure((current.sessionId??null)===body.expectedSessionId&&Array.isArray(body.authorizationIds)&&JSON.stringify([...body.authorizationIds].sort())===JSON.stringify(ids),'Management dependencies changed; inspect them again before stopping',409);
    for(const authorizationId of ids)this.tasks.revoke(authorizationId,'User explicitly closed management dependencies');
    const runtime=this.browser?.runtime;
    if(runtime&&runtime.projectId===body.projectId&&(!body.profileId||runtime.profileId===body.profileId)){
      await this.stopRunner();if(this.active)await this.seal();await this.closeSession();
    }
    return this.managementDependencies(body);
  }
  async openEnvironment(body:any){
    this.assertActivity(body.projectId,body.profileId);
    ensure(!this.browser,'Close the current environment first',409);
    const profile=this.profiles.find(p=>p.id===body.profileId&&p.projectId===body.projectId);ensure(profile,'Unknown environment',404);
    const browserSession=await this.providerSession(profile);
    try {
    this.configurePermissions(browserSession);
    this.installNavigationPolicy(browserSession);
    const runtime:SessionRuntime<I,V,S>={projectId:profile.projectId,profileId:profile.id,pages:new Map(),selectedPageId:'',session:browserSession,controller:'human',leaseEpoch:1,capture:'not-recording',execution:'ready',locked:false};
    const owner=this.browser=new BrowserSessionLifecycle(runtime);this.closedPages=[];this.browserNotice=undefined;
    try{await this.ensureDownloads();const page=await this.addPage(runtime);this.loadHumanUrl(page,profile.entryUrl||'about:blank');await this.management.commitProfileState(profile.id,profile.configRevision??0,{openedAt:now()});return this.state().session;}
    catch(error){runtime.ending=true;await this.revokeOperation(runtime);for(const page of [...runtime.pages.values()])this.window.remove(page.view);await this.browserDownloads?.dispose();this.browserDownloads=undefined;if(this.browser===owner){this.browser=undefined;this.browserAuthorizationId=undefined;this.window.show(undefined);}throw error;}
    finally{if(this.browser===owner)this.window.lock(runtime.locked||runtime.controller!=='human');else if(!this.browser)this.window.lock(false);this.onChanged();}
    }catch(error){if(this.browser?.runtime.session!==browserSession)await this.releaseProviderSession(browserSession);throw error;}
  }
  async checkEnvironment(){
    const runtime=this.live(),profile=this.profiles.find(p=>p.id===runtime.profileId)!;
    ensure(runtime.controller==='human'&&!runtime.locked,'Environment check requires human ownership',409);
    const revision=profile.configRevision??0,page=this.current(),generation=page.navigationGeneration;
    const origin=new URL(page.page.url()).origin;
    let loginStatus:Profile['loginStatus']='unknown',checkReason='未配置可靠的登录检查条件。';
    try {
      if(profile.expectedOrigin&&profile.expectedOrigin!==origin){loginStatus='expired';checkReason='当前页面来源与预期业务站点不同。';}
      else if(profile.checkSelector){
        const element=await page.page.$(profile.checkSelector);
        const visible=element?await element.evaluate(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';}):false;
        await element?.dispose();
        ensure(this.browser?.runtime===runtime&&runtime.pages.get(page.pageId)===page&&page.navigationGeneration===generation,'页面在检查期间已改变',409);
        loginStatus=visible?'verified':'expired';checkReason=visible?'当前页面可见登录标记满足已配置的检查条件。':'当前页面未找到可见登录标记。';
      }
    } catch(error){loginStatus='unknown';checkReason='登录检查未完成：'+String(error);}
    return this.management.commitProfileState(profile.id,revision,{checkedAt:now(),checkedConfigRevision:revision,checkOrigin:origin,loginStatus,checkReason});
  }
  async startRun(body:any, launch?:ValidationLaunch,options:{freshPage?:boolean}={}){
    this.assertActivity(body.projectId,body.profileId);
    ensure(!this.validationLaunch||this.validationLaunch===launch,'Validation startup owns the browser',409);launch?.abort.signal.throwIfAborted();
    ensure(!this.active,'Seal the active run first',409); const project=this.projects.find(p=>p.id===body.projectId);ensure(project,'Unknown project');
    const profile=this.profiles.find(p=>p.id===body.profileId&&p.projectId===project.id);ensure(profile,'Profile must belong to project');
    const previous=this.browser?.runtime;
    ensure(!previous||(previous.projectId===project.id&&previous.profileId===profile.id),'Close the live browser session before changing project or profile',409);
    ensure(!previous||previous.pages.size>0||options.freshPage,'Close the empty browser session before starting a new one',409);
    const id=launch?.validationRunId??randomUUID();const browserSession=previous?.session??await this.providerSession(profile);
    try {
    this.configurePermissions(browserSession);
    this.installNavigationPolicy(browserSession);
    const store=await EvidenceStore.create(path.join(this.root,'runs',id),captureMetadata({id,projectId:project.id,kind:body.kind==='validate'?'validate':'demonstrate',mode:process.env.BES_TEST?'synthetic':'local',objective:project.objective,profileId:profile.id,versions:this.state().versions,browserEnvironment:this.providerEnvironment(browserSession),appInstanceId:this.instanceId,browserSessionId:this.browserSessionId}));
    this.protectCaptureMetadata(store);
    const r:ActiveRun<I,V,S>={id,projectId:project.id,profileId:profile.id,store,pages:previous?.pages??new Map(),selectedPageId:previous?.selectedPageId??'',session:browserSession,controller:'none',leaseEpoch:(previous?.leaseEpoch??0)+1,capture:'starting',execution:'ready',locked:true};
    if(this.browser)this.browser.attach(r);else this.browser=new BrowserSessionLifecycle(r);
    this.active=r;this.runs.unshift(store.manifest);this.window.lock(true);
    try{
      await store.updateManifest({browserSessionId:this.browser.id});launch?.abort.signal.throwIfAborted();
      await this.manageDownloads(r);launch?.abort.signal.throwIfAborted();
      let page:ManagedPage<I,V>;
      if(previous){
        const recordingForegroundAt=Date.now();
        for(const existing of r.pages.values()){
          existing.capture=this.createCapture(r,existing);await existing.capture.start();await existing.capture.flush();
          await store.appendEvent({type:'page-registered',source:this.runtimeProvider,pageId:existing.pageId,navigationGeneration:existing.navigationGeneration,data:{pageId:existing.pageId,targetId:existing.targetId,...this.hostIdentity(existing),navigationGeneration:existing.navigationGeneration,appInstanceId:this.instanceId,browserSessionId:this.browser.id,resumedSession:true}});
        }
        if(options.freshPage){page=await this.addPage(r);launch?.abort.signal.throwIfAborted();await this.navigate(String(body.url||'about:blank'),page,true);}
        else page=this.current();
        await store.appendEvent({type:'recording-started-in-existing-session',source:'lifecycle',pageId:page.pageId,navigationGeneration:page.navigationGeneration,data:{browserSessionId:this.browser.id,previousRecordingId:previous.id??null,historyBeforeStart:'not-recorded'}});
        if(!options.freshPage)await this.recordForeground(r as ActiveRun<I,V,S>,null,'recording-started',recordingForegroundAt);
      }else{page=await this.addPage(r);launch?.abort.signal.throwIfAborted();await this.navigate(String(body.url||'about:blank'),page,true);}
      launch?.abort.signal.throwIfAborted();if(launch){launch.target={pageId:page.pageId,targetId:page.targetId,generation:page.navigationGeneration};ensure(r.selectedPageId===page.pageId,'Validation startup page was replaced',409);}
      r.capture=[...r.pages.values()].some(p=>p.capture!.health==='degraded')?'degraded':'recording';r.controller='human';r.locked=!!launch;this.window.lock(!!launch);await store.updateManifest({capture:r.capture,controller:'human',leaseEpoch:r.leaseEpoch});return this.state().active;
    }
    catch(error){r.capture='degraded';r.execution='failed';if(this.active===r&&!r.stopping&&!r.ending){r.controller='human';r.locked=false;this.window.lock(false);}await store.appendEvent({type:'gap',source:'lifecycle',data:{reason:String(error)}});throw error;}
    }catch(error){if(!previous&&this.browser?.runtime.session!==browserSession)await this.releaseProviderSession(browserSession);throw error;}
  }
  protected async manageDownloads(r:ActiveRun<I,V,S>){
    await this.ensureDownloads();this.browserDownloads!.beginRecording(r.id,r.store);
    r.stopDownloads=()=>this.browserDownloads!.finishRecording();
  }
  protected pageDestroyed(r:SessionRuntime<I,V,S>,view:V,identity:I,registered?:ManagedPage<I,V>){
    const closedAt=now(),wasSelected=r.selectedPageId===identity.pageId,targetId=registered?.targetId;
    const checkpoint=r.checkpointTask,controllerAtClosure=r.controller;
    r.pages.delete(identity.pageId);
    if((r.selection as any)?.pageId===identity.pageId)r.selection=undefined;
    const operationAffected=!!targetId&&(r.operation?.targetId===targetId||r.pendingOperation?.targetId===targetId);
    const checkpointAffected=!!checkpoint&&(checkpoint.pageId===identity.pageId||wasSelected||operationAffected);
    if(checkpointAffected)checkpoint.abort.abort(new Error('Page closed during checkpoint acquisition'));
    if(wasSelected||operationAffected||checkpointAffected)r.leaseEpoch++;
    const closureEpoch=r.leaseEpoch,operationRevoked=operationAffected||checkpointAffected;
    // Revocation starts synchronously, before another task can use the old lease.
    const revoked=operationRevoked?this.revokeOperation(r):Promise.resolve();
    this.window.remove(view);
    let foregroundWrite:Promise<unknown>|undefined;
    if(wasSelected){
      const opener=identity.openerPageId?r.pages.get(identity.openerPageId):undefined;
      const replacement=opener&&this.pageContents(opener)?opener:[...r.pages.values()].reverse().find(page=>this.pageContents(page));
      r.selectedPageId=replacement?.pageId||'';
      if(this.browser?.runtime===r&&!r.ending&&!this.closing){this.window.show(replacement?.view);this.window.lock(r.locked||r.controller!=='human');}
      if(this.active===r&&!r.ending&&!this.closing)foregroundWrite=this.recordForeground(r as ActiveRun<I,V,S>,identity.pageId,'page-closed',Date.parse(closedAt));
    }
    if(r.ending||this.closing||this.active!==r){if(!r.pages.size&&controllerAtClosure!=='human')r.controller='none';this.onChanged();void revoked.catch(error=>console.error('Could not revoke closed-page operation',error));return;}
    if(r.handoff?.pageId===identity.pageId&&r.handoff.status==='waiting'){
      r.handoff.status='needs-attention';const done=this.humanDone;this.humanDone=undefined;
      if(r.handoff.owner==='agent')r.execution='paused';
      done?.reject(new Error('The human-assistance page closed before completion was verified'));
    }
    // Closing the last human tab does not stop the recorder or surrender ownership.
    if(!r.pages.size&&controllerAtClosure!=='human')r.controller='none';
    const selectedPageId=r.selectedPageId||null,closures=r.pageClosures??(r.pageClosures=new Set<Promise<void>>());
    const checkpointRecovery=checkpointAffected?(async()=>{
      // The old checkpoint cannot release a newer lease. This page-close owner
      // may restore input only after its capture and operation connection stop.
      await revoked;await checkpoint.done;
      if(this.active!==r||r.ending||this.closing||r.stopping||r.leaseEpoch!==closureEpoch||r.controller!==controllerAtClosure||r.selectedPageId!==selectedPageId||!r.pages.has(r.selectedPageId)||r.checkpointTask||r.operation||r.pendingOperation)return;
      // Managed worker shutdown/finalization owns its own input transition.
      if(this.workflow||this.workflowStarting||this.workflowSettlement||['running','waiting-human','finalizing','stopping'].includes(r.execution))return;
      r.locked=false;this.window.lock(r.controller!=='human');this.onChanged();
    })():Promise.resolve();
    const cleanup=(async()=>{
      const outcomes=await Promise.allSettled([revoked,registered?.capture?.stop(),checkpointRecovery,foregroundWrite]);
      const errors=outcomes.flatMap(outcome=>outcome.status==='rejected'?[String(outcome.reason)]:[]);
      await r.store!.appendEvent({type:'page-closed',source:this.runtimeProvider,pageId:identity.pageId,data:{...identity,targetId,wasRegistered:!!registered,selectedPageId,operationRevoked,closedAt,cleanupErrors:errors}});
      if(errors.length){r.capture='degraded';await r.store!.appendEvent({type:'gap',source:this.runtimeProvider,pageId:identity.pageId,data:{reason:'closed-page-cleanup-failed',errors}});}
    })().catch(error=>{r.capture='degraded';console.error('Could not persist business page closure',error);}).finally(()=>{closures.delete(cleanup);this.onChanged();});
    closures.add(cleanup);this.onChanged();
  }
  protected createCapture(r:ActiveRun<I,V,S>,p:PageIdentity&{page:Page}){return new CaptureCoordinator(p.page,p,r.store,selection=>{if(this.active===r&&r.pages.has(p.pageId)){r.selection=selection;this.onChanged();}},reason=>{if(r.ending||this.active!==r||!r.pages.has(p.pageId))return;r.capture='degraded';this.onChanged();void r.store.updateManifest({capture:'degraded',captureHealthReason:reason}).catch(error=>console.error('Could not persist capture health',error));},false);}
  protected humanCommandIdentity(page?:ManagedPage<I,V>){const r=this.live();return {sessionId:this.browserSessionId!,leaseEpoch:r.leaseEpoch,...(page?{pageId:page.pageId,targetId:page.targetId,generation:page.navigationGeneration}:{})};}
  protected browserFailure(error:unknown){this.browserNotice=String(error);this.onChanged();}
  async createTaskPage(body:any,signal?:AbortSignal){
    const runtime=this.live(),pending=this.createTaskPageOwned(body,signal);
    (runtime.pageCreations??=new Set()).add(pending);
    try{return await pending;}finally{runtime.pageCreations.delete(pending);}
  }
  protected async createTaskPageOwned(body:any,signal?:AbortSignal){
    signal?.throwIfAborted();
    const r=this.live(),anchor=r.pages.get(body.pageId),leaseEpoch=r.leaseEpoch;
    ensure(anchor&&anchor.navigationGeneration===body.generation&&body.leaseEpoch===leaseEpoch,'Task page identity or lease is stale',409);
    ensure(r.controller==='agent'&&!r.locked&&!r.ending&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Agent does not own an idle browser',409);
    ensure(this.browserAuthorizationId===body.authorizationId,'This task does not own the browser lease',403);
    ensure(typeof body.startUrl==='string'&&body.startUrl.length<=4096&&/^https?:\/\//.test(body.startUrl),'An HTTP(S) startUrl is required',422);
    const destination=new URL(body.startUrl);
    ensure(!destination.username&&!destination.password&&this.navigationAllowed(destination.href),'Task page destination is outside authorized origins',403);
    const previousPageId=r.selectedPageId;
    let page:ManagedPage<I,V>|undefined;
    try{
      page=await this.addPage(r,undefined,undefined,false);
      signal?.throwIfAborted();
      ensure(this.browser?.runtime===r&&r.controller==='agent'&&!r.locked&&r.pages.get(anchor.pageId)===anchor&&anchor.navigationGeneration===body.generation&&r.leaseEpoch===leaseEpoch&&r.selectedPageId===previousPageId,'Task page creation lost its browser lease',409);
      await this.navigate(destination.href,page,true);
      signal?.throwIfAborted();
      ensure(this.browser?.runtime===r&&r.controller==='agent'&&!r.locked&&r.pages.get(anchor.pageId)===anchor&&anchor.navigationGeneration===body.generation&&r.leaseEpoch===leaseEpoch&&r.selectedPageId===previousPageId&&r.pages.get(page.pageId)===page,'Task page creation lost its browser lease',409);
      await this.pageAudit(r,{type:'page-created',source:'api',pageId:page.pageId,data:{authorizationId:body.authorizationId,anchorPageId:anchor.pageId,generation:page.navigationGeneration}});
      signal?.throwIfAborted();
      ensure(this.browser?.runtime===r&&r.leaseEpoch===leaseEpoch&&r.controller==='agent'&&r.pages.get(anchor.pageId)===anchor&&anchor.navigationGeneration===body.generation&&r.pages.get(page.pageId)===page,'Task page creation lost its browser lease',409);
      this.tasks.addPage(body.authorizationId,{pageId:page.pageId,targetId:page.targetId});
      return {runId:this.active===r?r.id:undefined,sessionId:this.browserSessionId,profileId:r.profileId,pageId:page.pageId,targetId:page.targetId,generation:page.navigationGeneration,selectedPageId:r.selectedPageId};
    }catch(error){
      if(page&&r.pages.get(page.pageId)===page){try{await this.closePageContents(page);}catch{this.window.remove(page.view);}await Promise.all([...(r.pageClosures??[])]);}
      throw error;
    }finally{if(this.browser?.runtime===r)this.window.lock(r.locked||String(r.controller)!=='human');this.onChanged();}
  }
  async selectPage(pageId:string){
    const r=this.live(),p=r.pages.get(pageId),leaseEpoch=r.leaseEpoch;ensure(p,'Unknown page');
    ensure(!r.locked&&!r.ending&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Cannot change execution target while running or locked',409);
    ensure(!r.pendingOperation,'Operation connection is still starting',409);
    const operation=r.operation;if(operation){await operation.gate.quiesce();await operation.browser.disconnect();if(r.operation===operation)r.operation=undefined;}
    ensure(this.browser?.runtime===r&&r.leaseEpoch===leaseEpoch&&r.pages.get(p.pageId)===p,'Page selection was cancelled',409);const previousPageId=r.selectedPageId||null;r.selectedPageId=p.pageId;r.leaseEpoch++;this.window.show(p.view);if(this.active===r&&previousPageId!==p.pageId)await this.recordForeground(r as ActiveRun<I,V,S>,previousPageId,'page-selected');this.onChanged();return this.state();
  }
  async closePage(pageId:string){
    const r=this.live(),p=r.pages.get(pageId);ensure(p,'Unknown page',404);
    const closed={url:p.page.url(),title:this.pageContents(p)?.getTitle()??''};
    ensure(r.controller==='human'&&!r.locked&&!r.ending&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Stop the runner before closing its page',409);
    r.locked=true;r.leaseEpoch++;this.window.lock(true);
    try{await this.closePageContents(p);await Promise.all([...(r.pageClosures??[])]);if(!r.pages.has(pageId)){this.closedPages??=[];this.closedPages.push(closed);this.closedPages=this.closedPages.slice(-20);}}
    finally{if(this.browser?.runtime===r&&!r.stopping&&!r.ending){r.locked=false;this.window.lock(r.controller!=='human');}this.onChanged();}
    return this.browserState();
  }
  async closeSession(){
    const browser=this.browser;ensure(browser,'No live browser session',409);ensure(!this.active,'Seal the recording before closing its browser session',409);
    ensure(!browser.runtime.stopping,'Wait for browser automation to stop before closing its session',409);
    ensure(!this.validationLaunch&&!this.workflow&&!this.workflowStarting&&!this.workflowSettlement,'Stop the runner before closing its browser session',409);
    const r=browser.runtime;r.ending=true;r.locked=true;r.leaseEpoch++;this.window.lock(true);
    try{await this.revokeOperation(r);for(const p of [...r.pages.values()])await this.closePageContents(p);await this.browserDownloads?.dispose();this.browserDownloads=undefined;await this.releaseProviderSession(r.session);this.browser=undefined;this.browserAuthorizationId=undefined;this.closedPages=[];return {closed:true,sessionId:browser.id};}
    finally{r.ending=false;r.locked=false;if(this.browser===browser)this.window.lock(r.controller!=='human');else if(!this.browser)this.window.lock(false);this.onChanged();}
  }
  protected assertOperationOwner(r:SessionRuntime<I,V,S>,p:ManagedPage<I,V>,leaseEpoch:number,generation?:number){
    ensure(this.browser?.runtime===r&&!this.closing&&!r.ending&&r.controller==='agent'&&!r.locked&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Agent no longer owns this browser',409);
    ensure(r.leaseEpoch===leaseEpoch&&r.pages.get(p.pageId)===p,'Control lease or operation page changed',409);
    if(generation!==undefined)ensure(p.navigationGeneration===generation,'Stale navigation generation',409);
  }
  protected async revokeOperation(r:SessionRuntime<I,V,S>){
    const pending=r.pendingOperation,operation=r.operation;
    pending?.abort.abort(new Error('Operation connection revoked'));
    pending?.gate?.close();operation?.gate.close();r.operation=undefined;
    await Promise.allSettled([pending?.promise,operation?.browser.disconnect()]);
    if(r.pendingOperation===pending)r.pendingOperation=undefined;
  }
  protected async operation(r:SessionRuntime<I,V,S>,p:ManagedPage<I,V>,leaseEpoch:number){
    this.assertOperationOwner(r,p,leaseEpoch);
    if(r.operation?.targetId===p.targetId)return r.operation;
    if(r.pendingOperation){ensure(r.pendingOperation.targetId===p.targetId&&r.pendingOperation.leaseEpoch===leaseEpoch,'Another operation connection is starting',409);return r.pendingOperation.promise;}
    const auditSessionId=this.browserSessionId;
    const pending:PendingOperation={targetId:p.targetId,leaseEpoch,abort:new AbortController(),promise:undefined!};
    r.pendingOperation=pending;
    pending.promise=(async()=>{
      let browser:Browser|undefined;
      try{
        if(r.operation){const previous=r.operation;await previous.gate.quiesce();await previous.browser.disconnect();if(r.operation===previous)r.operation=undefined;}
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const transport=await SocketTransport.connect(this.endpoint,pending.abort.signal);
        const gate=new GateTransport(transport,{onCommand:command=>this.gateCommand(p,command),onConflict:conflict=>{void this.pageAudit(r,{type:'control-conflict',source:'gate',data:conflict},auditSessionId).catch(error=>console.error('Could not save control conflict',error));}});
        pending.gate=gate;
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const connected=await connectManagedPage(gate,p.targetId);browser=connected.browser;
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const operation={...connected,gate,targetId:p.targetId,documentEpoch:0};
        connected.page.on('framenavigated',frame=>{if(frame===connected.page.mainFrame())operation.documentEpoch++;});
        r.operation=operation;return operation;
      }catch(error){pending.gate?.close();await browser?.disconnect();throw error;}
      finally{if(r.pendingOperation===pending)r.pendingOperation=undefined;}
    })();
    return pending.promise;
  }
  async control(controller:'human'|'agent',launch?:ValidationLaunch){
    ensure(!this.validationLaunch||this.validationLaunch===launch,'Validation startup owns the browser',409);launch?.abort.signal.throwIfAborted();
    const r=this.live();ensure(!r.stopping&&!r.ending,'Browser is stopping or closing',409);ensure(r.handoff?.status!=='waiting','Use the handoff release or stop button',409);ensure(!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Stop the runner before changing ownership',409);
    r.locked=true;const transitionEpoch=++r.leaseEpoch;this.window.lock(true);
    if(r.pendingOperation)await this.revokeOperation(r);
    if(r.operation){const operation=r.operation;await operation.gate.quiesce();await operation.browser.disconnect();if(r.operation===operation)r.operation=undefined;}
    ensure(this.browser?.runtime===r&&r.leaseEpoch===transitionEpoch&&!this.closing,'Control transition was cancelled',409);
    if(controller==='agent')await Promise.all([...r.pages.values()].filter(page=>page.capture?.inspecting).map(page=>page.capture!.inspect(false)));
    ensure(this.browser?.runtime===r&&r.leaseEpoch===transitionEpoch&&!this.closing,'Control transition was cancelled',409);
    r.controller=controller;r.locked=false;this.window.lock(controller!=='human');await this.window.awaitInput();
    await this.pageAudit(r,{type:'control',source:'studio',data:{controller,leaseEpoch:r.leaseEpoch}});return this.state().session;
  }
  async action(body:any,signal?:AbortSignal){
    const timeout=AbortSignal.timeout(15_000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    combined.throwIfAborted();const r=this.live(),p=r.pages.get(body.pageId),leaseEpoch=r.leaseEpoch;
    ensure(p,'Unknown managed page',409);ensure(Number.isSafeInteger(body.generation)&&body.generation>=0,'Navigation generation is required',409);
    this.assertOperationOwner(r,p,leaseEpoch,body.generation);ensure(body.leaseEpoch===leaseEpoch,'Stale lease or wrong page identity',409);
    let documentEpoch=0;
    let phase='connection',stopping:Promise<void>|undefined,op:ManagedOperation|undefined;
    const abort=()=>{if(r.leaseEpoch===leaseEpoch)r.leaseEpoch++;stopping=this.revokeOperation(r);};
    const check=()=>{combined.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch,body.type==='navigate'?undefined:body.generation);if(op){ensure(op.targetId===p.targetId&&r.operation===op,'Target mismatch',409);if(body.type!=='navigate')ensure(op.documentEpoch===documentEpoch,'Operation document changed',409);}};
    combined.addEventListener('abort',abort,{once:true});
    try{
      op=await this.operation(r,p,leaseEpoch);documentEpoch=op.documentEpoch;check();this.assertOperationOwner(r,p,leaseEpoch,body.generation);op.gate.setCommandGuard(check);
      const commandId=randomUUID();await this.pageAudit(r,{type:'command',source:'api',pageId:p.pageId,data:{commandId,type:body.type,selector:body.selector,controller:r.controller}});check();
      phase='preparation';
      const input=async()=>{
        const inputCheck=()=>{check();this.window.assertInputReady(p.view);};inputCheck();op!.gate.setCommandGuard(inputCheck);phase='input';
        switch(body.type){
          case 'click':await clickManagedElement(op!.page,String(body.selector),inputCheck);break;
          case 'fill':await op!.page.$eval(String(body.selector),(el:any)=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});inputCheck();await op!.page.type(String(body.selector),String(body.value));break;
          case 'press':await op!.page.keyboard.press(body.key);break;
          case 'scroll':await op!.page.evaluate(({x,y})=>window.scrollBy(x,y),{x:Number(body.x)||0,y:Number(body.y)||0});break;
          case 'select':await op!.page.select(String(body.selector),String(body.value));break;
          default:ensure(false,'Unsupported action');
        }
        check();
      };
      if(body.type==='navigate'){ensure(/^https?:\/\//.test(body.url),'HTTP(S) URL required');phase='navigation';await op.page.goto(body.url);check();}
      else await this.window.withBackgroundInteraction(p.view,input);
      return {commandId,generation:p.navigationGeneration,completion:'command-completed'};
    }catch(error){
      if(combined.aborted)throw new StudioError(timeout.aborted||combined.reason?.name==='TimeoutError'?408:409,timeout.aborted||combined.reason?.name==='TimeoutError'?'action_deadline':'action_cancelled','Action stopped during '+phase);
      throw error;
    }finally{op?.gate.setCommandGuard();combined.removeEventListener('abort',abort);await stopping;}
  }
  protected authoringFile(body:any){
    ensure(typeof body.operationId==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(body.operationId),'Operation identity required');
    return path.join(this.root,'authoring',body.operationId+'.json');
  }
  protected authoringIdentity(body:any){return JSON.stringify([body.projectId,body.draftId,body.purpose??(body.selection?'field':'observation'),body.fieldId??'',!!body.selection,body.selectionId??'',body.pageId??'',body.generation??null,body.leaseEpoch??null,body.derivedFrom??'',body.title??'',body.notes??'']);}
  protected async readAuthoring(body:any){
    let operation:any;try{operation=JSON.parse(await readFile(this.authoringFile(body),'utf8'));}catch(error:any){if(error.code==='ENOENT')return null;throw error;}
    ensure(operation.projectId===body.projectId&&operation.draftId===body.draftId,'Operation project/draft identity changed',403);
    if(operation.fingerprint)ensure(operation.fingerprint===this.authoringIdentity(body),'Operation request identity changed',409);
    return operation;
  }
  protected async recoverAuthoringReceipt(operation:any){
    if(operation.receiptId)return;
    let cursor:string|undefined;
    do{const checkpoints=await this.reader(operation.recordingId).checkpoints({limit:100,maxBytes:32768,cursor,fields:['pageId','navigationGeneration','captureConsistency','/metadata/authoring']});
      ensure(!checkpoints.items.some((item:any)=>item.readStatus),'原始收据超出读取预算，保存状态仍未知',409);
      const found=checkpoints.items.find((item:any)=>(item['/metadata/authoring']??item.metadata?.authoring)?.operationId===operation.operationId) as any;
      if(found){
        const author=found['/metadata/authoring']??found.metadata.authoring;
        ensure(author.projectId===operation.projectId&&author.draftId===operation.draftId&&author.recordingId===operation.recordingId&&author.fingerprint===operation.fingerprint&&author.appInstanceId===operation.appInstanceId&&JSON.stringify(author.source)===JSON.stringify(operation.source),'原始收据的操作身份不一致，保存状态仍未知',409);
        operation.receiptId=found.id;operation.stage='receipt-saved';if(operation.fingerprint&&(found.captureConsistency!=='consistent'||found.pageId!==operation.source?.pageId||found.navigationGeneration!==operation.source?.generation))operation.sourceExpired=true;return;
      }cursor=checkpoints.nextCursor;
    }while(cursor);
  }
  protected async reconcileAuthoring(operation:any){
    try{await this.recoverAuthoringReceipt(operation);delete operation.recoveryError;}
    catch(error){operation.recoveryError=String(error);return {stage:'unknown',status:'partial',operationId:operation.operationId,reason:'原件读取失败，无法确认是否已采集：'+String(error)};}
    const task=this.authoringTasks.get(operation.operationId);
    if(task&&task.appInstanceId===this.instanceId&&task.fingerprint===operation.fingerprint&&task.sessionId===operation.source?.sessionId)return {stage:'acquiring',status:'partial',operationId:operation.operationId,receiptId:operation.receiptId,reason:'当前实例仍在完成这次采集；查询不会启动第二次采集。'};
    if(!operation.receiptId&&(operation.stage==='acquiring'||operation.stage==='unknown'||operation.appInstanceId&&operation.appInstanceId!==this.instanceId)){
      operation.stage='interrupted';operation.reason='原采集执行者已结束，未查得原始收据；已保留操作和部分附件，请重新选择。';await atomicJson(this.authoringFile(operation),operation);
    }
    return undefined;
  }
  async authoringRecovery(body:any){
    await this.materials.service.getDraft(body.projectId,body.draftId);
    let files:string[];try{files=(await readdir(path.join(this.root,'authoring'))).filter(file=>/^[a-zA-Z0-9-]{1,128}\.json$/.test(file)).sort();}catch(error:any){if(error.code==='ENOENT')return {items:[],outputTruncated:false};throw error;}
    const items:any[]=[],warnings:string[]=[];let bytes=0,scanned=0,truncated=false;
    for(const file of files.slice(0,500)){
      scanned++;
      try{
        const location=path.join(this.root,'authoring',file);ensure((await stat(location)).size<=32768,'Operation journal exceeds recovery budget',413);
        const operation=JSON.parse(await readFile(location,'utf8'));
        if(operation.projectId!==body.projectId||operation.draftId!==body.draftId||['associated','interrupted','source-expired'].includes(operation.stage))continue;
        ensure(operation.operationId+'.json'===file,'Operation journal identity mismatch',409);
        // The persisted fingerprint contains the original request identity even
        // when Chromium's editor cache did not survive an abrupt process exit.
        const [projectId,draftId,purpose,fieldId,selection,selectionId,pageId,generation,leaseEpoch,derivedFrom,title,notes]=JSON.parse(operation.fingerprint);
        const request={projectId,draftId,operationId:operation.operationId,purpose,fieldId,selection,selectionId,pageId,generation,leaseEpoch,derivedFrom,title,notes};
        ensure(this.authoringIdentity(request)===operation.fingerprint,'Operation request cannot be reconstructed',409);
        const state=await this.authoringOperation(request),item={...request,stage:state.stage,paused:true,reason:'reason' in state?state.reason:undefined};
        const size=Buffer.byteLength(JSON.stringify(item));if(items.length===20||bytes+size>24576){truncated=true;break;}items.push(item);bytes+=size;
      }catch(error){if(warnings.length<5)warnings.push(file+': '+String(error).slice(0,300));}
    }
    return {items,warnings,outputTruncated:truncated||scanned<files.length};
  }
  async authoringOperation(body:any){
    const operation=await this.readAuthoring(body);
    if(!operation){
      const task=this.authoringTasks.get(body.operationId);
      if(task){ensure(task.fingerprint===this.authoringIdentity(body),'Operation request identity changed',409);return {stage:'acquiring',status:'partial',operationId:body.operationId,reason:'当前实例仍在准备采集；尚未写入意图不表示任务已结束。'};}
      return {stage:'not-captured',operationId:body.operationId};
    }
    const pending=await this.reconcileAuthoring(operation);if(pending)return pending;
    const common={operationId:operation.operationId,receiptId:operation.receiptId,purpose:operation.purpose??(operation.target?'field':'observation'),fieldId:operation.fieldId,target:operation.target};
    if(operation.sourceExpired)return {...common,stage:'source-expired',status:'partial'};
    if(operation.receiptId){const draft=await this.materials.service.getDraft(operation.projectId,operation.draftId);const card=draft.content.checkpoints.find(item=>item.operationId===operation.operationId);if(card){ensure(card.sourceReceiptRef===operation.receiptId&&sameReplayPosition(card.anchor,operation.position),'Operation card has a different original receipt or source position',409);return {...common,stage:'associated',status:'saved',card,draft:materialSummary(draft)};}}
    return {...common,stage:operation.receiptId?'receipt-saved':operation.stage??'not-captured',status:'partial',reason:operation.reason};
  }
  async captureAndAuthor(body:any){
    const operationId=body.operationId;this.authoringFile(body);
    const fingerprint=this.authoringIdentity(body),existing=this.authoringTasks.get(operationId);
    if(existing){ensure(existing.fingerprint===fingerprint,'Operation request identity changed',409);return existing.promise;}
    // Register before the first await. A journal stage alone is not a live task.
    const task={appInstanceId:this.instanceId,sessionId:this.browserSessionId,fingerprint,promise:undefined as unknown as Promise<any>};
    this.authoringTasks.set(operationId,task);
    task.promise=this.performCaptureAndAuthor(body).finally(()=>{if(this.authoringTasks.get(operationId)===task)this.authoringTasks.delete(operationId);});
    return task.promise;
  }
  protected async performCaptureAndAuthor(body:any){
    const run=this.active;ensure(!run||run.controller==='human','Authoring requires human ownership',409);
    const file=this.authoringFile(body);await mkdir(path.dirname(file),{recursive:true});let operation=await this.readAuthoring(body);
    if(operation){
      try{await this.recoverAuthoringReceipt(operation);}catch(error){return {stage:'unknown',status:'partial',operationId:body.operationId,reason:'原件读取失败，无法确认是否已采集：'+String(error)};}
      if(!operation.receiptId&&(operation.stage==='acquiring'||operation.stage==='unknown'||operation.appInstanceId&&operation.appInstanceId!==this.instanceId)){operation.stage='interrupted';operation.reason='原采集执行者已结束，未查得原始收据；请重新选择。';await atomicJson(file,operation);}
      if(operation.stage==='interrupted')return {stage:'interrupted',status:'partial',operationId:body.operationId,reason:operation.reason};
    }
    if(!operation){
      ensure(run&&run.projectId===body.projectId,'Start recording in this project before creating a live savepoint',409);const page=this.current();
      const selected=(run.selection as any)?.sample?.ref;
      if(body.selection)ensure(page.capture?.inspecting&&page.capture.selectionId===body.selectionId&&selected&&(run.selection as any).selectionId===body.selectionId&&typeof body.selectionId==='string'&&(run.selection as any).generation===page.navigationGeneration&&body.generation===page.navigationGeneration&&body.pageId===page.pageId&&body.leaseEpoch===run.leaseEpoch&&selected.position.recordingId===run.id&&selected.position.pageId===page.pageId,'Live selection has no current durable source',409);
      const source={sessionId:this.browserSessionId,pageId:page.pageId,targetId:page.targetId,generation:page.navigationGeneration,leaseEpoch:run.leaseEpoch};
      const position=body.selection?selected.position:await page.capture!.snapshotPosition();
      operation={appInstanceId:this.instanceId,projectId:run.projectId,recordingId:run.id,operationId:body.operationId,position,title:body.title||'当前结果',notes:body.notes||'',draftId:body.draftId,derivedFrom:body.derivedFrom,purpose:body.purpose??(body.selection?'field':'observation'),fieldId:body.fieldId,source,fingerprint:this.authoringIdentity(body),stage:'not-captured',...(body.selection?{target:selected}:{})};
      await atomicJson(file,operation);
    }
    if(operation.sourceExpired)return {status:'partial',stage:'source-expired',receiptId:operation.receiptId,reason:'采集期间来源变化；原件保留，请重新选择。'};
    if(!operation.receiptId){
      const source=operation.source,page=run?.pages.get(source?.pageId);
      const current=()=>!!(source&&run&&this.active===run&&operation.recordingId===run.id&&this.browserSessionId===source.sessionId&&run.controller==='human'&&run.leaseEpoch===source.leaseEpoch&&run.selectedPageId===source.pageId&&page&&run.pages.get(source.pageId)===page&&page.targetId===source.targetId&&page.navigationGeneration===source.generation);
      if(!current()){operation.stage='source-expired';await atomicJson(file,operation);return {stage:'source-expired',status:'partial',operationId:operation.operationId,reason:'原页面身份已过期；旧意图已保留，请重新选择。'};}
      operation.stage='acquiring';await atomicJson(file,operation);
      // Recheck after the durable intent write, immediately before acquisition.
      if(!current()){operation.stage='source-expired';await atomicJson(file,operation);return {stage:'source-expired',status:'partial',operationId:operation.operationId,reason:'原页面身份已过期；请重新选择。'};}
      let receipt:any;try{receipt=await this.checkpoint({title:operation.title,description:operation.notes,generation:source.generation},{pageId:source.pageId,authoring:operation});}catch(error){try{await this.recoverAuthoringReceipt(operation);if(!operation.receiptId)operation.stage='not-captured';}catch(readError){operation.stage='unknown';operation.recoveryError=String(readError);}await atomicJson(file,operation);throw error;}
      operation.receiptId=receipt.id;operation.stage='receipt-saved';await run!.store.flush();
      if(!current()||receipt.captureConsistency!=='consistent'||receipt.pageId!==source.pageId||receipt.navigationGeneration!==source.generation){operation.sourceExpired=true;operation.stage='source-expired';await atomicJson(file,operation);return {status:'partial',stage:'source-expired',receiptId:operation.receiptId,reason:'采集期间来源变化；原件保留，请重新选择。'};}
    }
    try{await atomicJson(file,operation);const authored=await this.materials.authorReceipt(operation.projectId,operation);
      operation.stage='associated';await atomicJson(file,operation);
      return {status:'saved',stage:'associated',...authored,receiptId:operation.receiptId,target:operation.target,purpose:operation.purpose,fieldId:operation.fieldId,operationId:operation.operationId};
    }catch(error){return {status:'partial',stage:'receipt-saved',receiptId:operation.receiptId,operationId:operation.operationId,purpose:operation.purpose,fieldId:operation.fieldId,error:String(error),reason:'原始收据已保存，资料关联未完成。使用同一操作重试，不会再次采集。'};}
  }
  async checkpoint(body:any,options:{fromRunner?:boolean;pageId?:string;signal?:AbortSignal;authoring?:unknown}={}){
    options.signal?.throwIfAborted();
    const r=this.required();ensure(options.fromRunner||!['running','waiting-human','finalizing','stopping'].includes(r.execution),'A running workflow owns checkpoint capture; stop it before taking a manual checkpoint',409);
    const requestedPageId=options.pageId??body.pageId,p=requestedPageId?r.pages.get(requestedPageId):this.current();ensure(p,'Checkpoint page no longer exists',409);
    if(body.generation!==undefined)ensure(body.generation===p.navigationGeneration,'Stale navigation generation',409);
    ensure(!r.locked&&!r.checkpointTask,'Checkpoint or transition already in progress',409);
    const wasLocked=r.locked,leaseEpoch=r.leaseEpoch,op=r.operation,generation=p.navigationGeneration;
    const selection=r.selection===undefined?undefined:structuredClone(r.selection),deadline=performance.now()+10000;
    let finish!:()=>void;const task:CheckpointOperation={id:randomUUID(),pageId:p.pageId,phase:'draining',startedAt:now(),abort:new AbortController(),done:new Promise<void>(resolve=>{finish=resolve;})};
    const abort=()=>{if(task.phase!=='saving')task.abort.abort(options.signal?.reason);};options.signal?.addEventListener('abort',abort,{once:true});
    r.checkpointTask=task;r.locked=true;this.window.lock(true);this.onChanged();let drained=!op,released=false;
    const releaseInput=()=>{
      if(released)return;released=true;
      if(this.active!==r||r.checkpointTask!==task||r.leaseEpoch!==leaseEpoch||r.stopping||this.closing)return;
      // Failed drains remain closed until explicit stop/revocation confirms silence.
      if(!drained)return;
      if(op&&r.operation===op&&r.controller==='agent'&&op.gate.snapshot().state==='quiesced')op.gate.resume();
      r.locked=wasLocked;this.window.lock(r.locked||r.controller!=='human');
    };
    try{
      await this.window.awaitInput();
      if(op){await op.gate.quiesce(Math.min(5000,Math.max(1,deadline-performance.now())));drained=true;}
      task.phase='capturing';this.onChanged();
      const captured=await captureCheckpointMaterials({
        screenshot:()=>this.screenshot(p),
        dom:()=>p.page.evaluate(()=>{const clone=document.documentElement.cloneNode(true) as HTMLElement;clone.querySelectorAll('input,textarea').forEach(el=>{el.removeAttribute('value');if(el.tagName==='TEXTAREA')el.textContent='[masked]';});return '<!doctype html>'+clone.outerHTML;}),
        signal:task.abort.signal,timeoutMs:Math.max(1,deadline-performance.now()),
      });
      const consistency=r.pages.get(p.pageId)!==p?'unknown':p.navigationGeneration===generation?'consistent':'mixed';
      task.phase='saving';releaseInput();this.onChanged();
      // Once queued, evidence writes must reach their durable boundary; cancellation
      // stops acquisition only and never falsely acknowledges unfinished disk writes.
      const artifacts=[];
      for(const material of captured.materials)artifacts.push(await r.store.putArtifact({...material,limitBytes:material.kind==='dom'?16*1024*1024:undefined,source:{pageId:p.pageId,checkpointOperationId:task.id}}));
      const complete=artifacts.filter(a=>a.captureStatus==='complete'||a.captureStatus==='empty').length;
      return await r.store.appendCheckpoint({key:String(body.key||'checkpoint-'+Date.now()).slice(0,200),title:String(body.title||''),description:String(body.description||''),requirementIds:Array.isArray(body.requirementIds)?body.requirementIds:[],captureStartedAt:task.startedAt,captureEndedAt:captured.captureEndedAt,pageId:p.pageId,navigationGeneration:generation,captureConsistency:consistency,artifactRefs:artifacts.map(a=>a.id),metadata:{artifacts,selection,...(options.authoring?{authoring:options.authoring}:{}),operationId:task.id,captureOutcome:captured.outcome,captureStatus:complete===artifacts.length?'complete':complete?'partial':'failed',note:'A capture interval, not an atomic or frozen page snapshot'}});
    }finally{
      releaseInput();options.signal?.removeEventListener('abort',abort);if(r.checkpointTask===task)r.checkpointTask=undefined;finish();this.onChanged();
    }
  }
  async cancelCheckpoint(body:{runId:string;operationId:string}){
    const r=this.required(),task=r.checkpointTask;
    ensure(body.runId===r.id&&task?.id===body.operationId,'Checkpoint operation is no longer active',409);
    ensure(task.phase!=='saving','Acquisition has finished; saved materials are being committed',409);
    task.abort.abort(new Error('Checkpoint acquisition cancelled'));await task.done;return {operationId:task.id,cancelled:true};
  }
  async snapshot(body:any={}){const r=this.live(),p=body.pageId?r.pages.get(body.pageId):this.current();ensure(p,'Snapshot page no longer exists',409);const generation=p.navigationGeneration;if(body.generation!==undefined)ensure(body.generation===generation,'Stale navigation generation',409);const max=body.maxBytes??4000;ensure(Number.isSafeInteger(max)&&max>=512&&max<=16000,'Snapshot maxBytes must be between 512 and 16000');const elements=await p.page.evaluate(snapshotElements);ensure(this.browser?.runtime===r&&r.pages.get(p.pageId)===p&&p.navigationGeneration===generation,'Snapshot target navigated during capture; refresh its identity',409);const result={pageId:p.pageId,generation,url:p.page.url(),elements:[] as typeof elements,outputTruncated:false};for(const item of elements){const candidate={...result,elements:[...result.elements,item]};if(Buffer.byteLength(JSON.stringify(candidate))+32>max)break;result.elements.push(item);}result.outputTruncated=result.elements.length<elements.length;ensure(Buffer.byteLength(JSON.stringify(result))<=max,'Snapshot metadata exceeds maxBytes; increase the budget',413);return captureMetadata(result);}
  async pauseOperations(paused:boolean){const r=this.required();ensure(r.controller==='human','Only manual control can be paused here',409);r.locked=paused;this.window.lock(paused);return this.state().active;}
  async pauseCapture(paused:boolean){const r=this.required();for(const p of r.pages.values())await p.capture!.pause(paused);r.capture=paused?'paused':[...r.pages.values()].some(p=>p.capture!.health==='degraded')?'degraded':'recording';return this.state().active;}
  async seal(launch?:ValidationLaunch){ensure(!this.validationLaunch||this.validationLaunch===launch,'Validation startup owns the browser',409);launch?.abort.signal.throwIfAborted();const r=this.required();ensure(!this.workflow&&!this.workflowStarting&&!this.workflowSettlement&&!r.stopping&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Stop the runner and finish saving its report before sealing',409);r.ending=true;r.locked=true;this.window.lock(true);
    r.leaseEpoch++;
    try{
      await this.revokeOperation(r);await r.stopDownloads?.();await Promise.all([...(r.pageClosures??[])]);
      for(const p of [...r.pages.values()])await p.capture!.stop();await r.store.seal();const manifest=r.store.manifest;await r.store.close();
      r.releaseDownloads?.();r.releaseDownloads=undefined;r.stopDownloads=undefined;
      this.runs=this.runs.map(x=>x.id===r.id?manifest:x);this.browser!.detach(r.id);this.active=undefined;
      r.ending=false;r.capture='stopped';r.controller='human';r.locked=false;r.selection=undefined;r.handoff=undefined;
      this.window.lock(false);this.onChanged();return manifest;
    }catch(error){
      r.capture='degraded';r.ending=false;r.locked=true;this.onChanged();
      // Keep the writer and live pages available for explicit retry/close. Never
      // advertise a sealed recording when recorder teardown or durability failed.
      throw error;
    }
  }
  reader(runId:string){ensure(this.runs.some(r=>r.id===runId),'Unknown run',404);return new EvidenceReader(path.join(this.root,'runs',runId));}
  async history(runId:string){const reader=this.reader(runId);this.historyRun=runId;return {summary:await reader.summary(),checkpoints:await reader.checkpoints({limit:100,maxBytes:32768}),events:await reader.events({limit:50,maxBytes:16000}),gaps:await reader.gaps({limit:20}),validations:this.validations.filter(record=>record.runId===runId).map(record=>({id:record.id,status:record.status,validation:record.result?.validation,artifactId:record.artifactId}))};}
  async syntheticSite(){if(!this.fixture){const {startFixture}=await import('../../../test/fixtures/site');this.fixture=await startFixture();}return {url:this.fixture.url};}
  async replay(body:any){
    const reader=this.reader(body.runId),replayActive=this.active;if(replayActive&&replayActive.id===body.runId)await replayActive.store.flush();
    const manifest=this.runs.find(run=>run.id===body.runId);
    // New archives use exact source identity; never concatenate navigation epochs.
    const service=await this.materials.replay(body.runId,manifest.projectId);
    const streams=await service.archive.streams(100).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return {items:[]};throw error;});
    if(streams.items.length){
      const selected=body.position??streams.items.find(stream=>!body.pageId||stream.first.pageId===body.pageId)?.last;
      ensure(selected,'No recording stream matches this page',404);
      const window=await service.window(selected),prepared=prepareReplayEvents(window);
      const events=prepared.events.map(event=>rewriteReplayEvent(event,()=> 'about:blank'));
      const returnedBytes=Buffer.byteLength(JSON.stringify(events));ensure(returnedBytes<=16*1024*1024,'Use native bounded replay for this source window',413);
      return {events,position:selected,pageId:selected.pageId,streams,warning:'精确单 document/streamEpoch 窗口；离线资源与选择请使用隔离回放',returnedBytes};
    }
    // The UI gets one top-document timeline. Every navigation starts at a metadata/full-snapshot pair.
    const events:any[]=[];let bytes=2,warning='',selectedPageId=body.pageId||(replayActive&&replayActive.id===body.runId?replayActive.selectedPageId:undefined);
    let generation:unknown,pendingMetadata:any,ready=false,sawLegacy=false;
    const append=(batch:any[])=>{const added=batch.reduce((total,event)=>total+Buffer.byteLength(JSON.stringify(event))+1,0);if(bytes+added>16*1024*1024){warning='回放材料超过16MiB，显示单页面的有界片段';return false;}events.push(...batch);bytes+=added;return true;};
    try{
      const files=(await readdir(path.join(reader.runDir,'raw','rrweb'))).filter(file=>/^rrweb-\d{6}\.jsonl$/.test(file)).sort();
      reading:for(const file of files)for await(const line of jsonLines(await safeFile(reader.runDir,`raw/rrweb/${file}`))){
        if(line.invalid||!line.value){warning='回放原件含损坏记录；保留已读取片段';break reading;}
        const data=line.value.payload as any;if(!data?.event)continue;if(data.isTop!==true){if(data.isTop===undefined)sawLegacy=true;continue;}
        selectedPageId??=data.pageId;if(data.pageId!==selectedPageId)continue;
        if(generation!==data.navigationGeneration){generation=data.navigationGeneration;pendingMetadata=undefined;ready=false;}
        const event=data.event;
        if(event.type===4){pendingMetadata=event;continue;}
        if(event.type===2){if(pendingMetadata){if(!append([pendingMetadata,event]))break reading;pendingMetadata=undefined;ready=true;}else if(ready&&!append([event]))break reading;continue;}
        if(ready&&!pendingMetadata&&!append([event]))break reading;
      }
    }catch(error:any){if(error.code!=='ENOENT')throw error;warning='该运行无可回放DOM材料';}
    if(!events.length&&!warning)warning=sawLegacy?'旧材料缺少顶层页面身份，首版不混合回放这些记录':'所选页面缺少完整的metadata和DOM起始快照';
    return {events,pageId:selectedPageId,warning:warning||'仅回放单页面顶层DOM；不执行原站脚本，外部资源被阻止，iframe/Canvas/媒体可能缺失。',returnedBytes:bytes};
  }
  protected assertValidationIdle(){
    ensure(!this.closing&&!this.workflow&&!this.workflowSettlement&&!this.workflowStarting&&!this.validationLaunch,'An execution is active, starting, saving, or the application is closing',409);
    const r=this.active;if(r)ensure(!r.locked&&!r.stopping&&!r.ending&&!r.checkpointTask&&r.handoff?.status!=='waiting'&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'The browser is busy; finish or stop its current operation first',409);
  }
  protected grantScope(){
    const r=this.active,p=r?.pages.get(r.selectedPageId);if(!r||!p)return undefined;
    return {runId:r.id,projectId:r.projectId,profileId:r.profileId,leaseEpoch:r.leaseEpoch,pageId:p.pageId,targetId:p.targetId,generation:p.navigationGeneration,directory:this.projects.find(project=>project.id===r.projectId)?.scriptDirectory};
  }
  protected assertGrantSource(grant:ValidationStartGrant){
    const scope=this.grantScope();ensure(scope&&Object.entries(scope).every(([key,value])=>grant[key as keyof ValidationStartGrant]===value),'Authorized browser identity changed before validation startup',409);
  }
  validationStartGrant(body:any){
    const r=this.required();ensure(body.runId===r.id,'Run is not active',409);
    return {grant:r.controller==='human'&&!r.locked&&!r.stopping&&!r.ending&&!this.validationLaunch?this.validationGrants.available(this.grantScope()):null};
  }
  protected async grantBinding(r:ActiveRun<I,V,S>,input:unknown):Promise<ValidationStartBinding>{
    const scope=this.grantScope();ensure(scope?.runId===r.id&&scope.directory,'Register the workflow directory in the project first',409);
    const directory=scope.directory;
    const [loaded,fingerprint]=await Promise.all([loadWorkflow(directory),fingerprintWorkflow(directory,path.join(this.applicationPath,'package-lock.json'))]);
    ensure(this.active===r&&JSON.stringify(this.grantScope())===JSON.stringify(scope),'Browser identity or workflow registration changed during authorization',409);
    return {...scope,directory,workflowId:loaded.manifest.workflowId,workflowSha256:fingerprint.sha256,inputSha256:fingerprintInput(canonicalValidationInput(input))};
  }
  async authorizeValidationStart(body:any){
    this.assertValidationIdle();const r=this.required();ensure(r.controller==='human','Only the human controller can authorize validation startup',409);
    ensure(body.runId===r.id&&body.projectId===r.projectId&&body.profileId===r.profileId&&body.leaseEpoch===r.leaseEpoch,'Authorization identity or lease is stale',409);
    const binding=await this.grantBinding(r,body.input??{});this.assertValidationIdle();ensure(r.controller==='human','Control changed during authorization',409);
    const prior=this.validationGrants.revoke();if(prior)await r.store!.appendEvent({type:'validation-start-grant-revoked',source:'ui',data:{grantId:prior.grantId,reason:'replaced'}});
    this.assertValidationIdle();ensure(this.active===r&&r.leaseEpoch===binding.leaseEpoch&&r.selectedPageId===binding.pageId&&this.current().navigationGeneration===binding.generation,'Browser changed while replacing authorization',409);
    const grant=this.validationGrants.issue(binding);
    try{await r.store!.appendEvent({type:'validation-start-grant-issued',source:'ui',data:{...grant}});await r.store.flush();}catch(error){this.validationGrants.revoke();throw error;}
    this.onChanged();return grant;
  }
  async revokeValidationStart(body:any){
    const r=this.required();ensure(body.runId===r.id&&body.leaseEpoch===r.leaseEpoch,'Authorization identity or lease is stale',409);
    const grant=this.validationGrants.revoke();if(grant){await r.store!.appendEvent({type:'validation-start-grant-revoked',source:'ui',data:{grantId:grant.grantId,reason:'human-revoked'}});await r.store.flush();}
    this.onChanged();return {revoked:!!grant};
  }
  async validate(body:any,options:{signal?:AbortSignal;requireGrant?:boolean}={}){
    options.signal?.throwIfAborted();this.assertValidationIdle();this.assertActivity(body.projectId,body.profileId);
    const executionMode=body.executionMode??'from-start-validation';
    ensure(['current-page-test','from-start-validation'].includes(executionMode),'Unknown execution mode');
    ensure(!options.requireGrant||executionMode==='from-start-validation','This one-time grant authorizes from-start validation only',409);
    if(body.startUrl!==undefined)ensure(typeof body.startUrl==='string'&&(/^https?:\/\//.test(body.startUrl)||body.startUrl==='about:blank'),'Invalid validation start URL');
    ensure(!options.requireGrant||body.startUrl===undefined||body.startUrl===this.current().page.url(),'Start URL differs from the authorized page',409);
    body={...body,executionMode};
    if(body.authorizationId)ensure(typeof body.materialRevisionId==='string'&&typeof body.materialContentHash==='string','Task execution requires a fixed material revision and content hash');
    ensure((body.materialRevisionId===undefined)===(body.materialContentHash===undefined),'Material revision and content hash must be supplied together');
    if(executionMode==='current-page-test'){
      const live=this.live(),page=this.current();
      ensure(body.projectId===live.projectId&&body.profileId===live.profileId&&body.pageId===page.pageId&&body.generation===page.navigationGeneration,'Current-page test requires the exact live page and document generation',409);
    }
    const original=this.active;
    let finish!:()=>void;const launch:ValidationLaunch={abort:new AbortController(),done:new Promise<void>(resolve=>{finish=resolve;}),finish:()=>finish(),validationId:randomUUID(),validationRunId:randomUUID(),claimed:false};
    this.validationLaunch=launch;this.executingAuthorizationId=body.authorizationId;
    const abort=()=>{launch.abort.abort(options.signal?.reason??new Error('Validation startup cancelled'));void launch.handle?.cancel('Validation startup cancelled');};
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    try{
      const input=structuredClone(options.requireGrant?canonicalValidationInput(body.input??{}):body.input??{});body={...body,input};
      if(options.requireGrant){
        const r=this.required();ensure(r.controller==='human'&&!r.locked,'Validation grant requires idle human control',409);
        ensure(body.runId===r.id&&body.projectId===r.projectId&&body.profileId===r.profileId&&body.leaseEpoch===r.leaseEpoch,'Validation authorization identity or lease is stale',409);
        const binding=await this.grantBinding(r,input);launch.abort.signal.throwIfAborted();ensure(body.workflowId===binding.workflowId,'Workflow does not match authorization',409);
        launch.grant=this.validationGrants.consume(body.startGrantId,binding);
      }
      launch.abort.signal.throwIfAborted();launch.claimed=true;
      if(this.browser){this.browser.runtime.locked=true;this.window.lock(true);}
      if(launch.grant)await original!.store.appendEvent({type:'validation-start-grant-consumed',source:'api',data:{...launch.grant,validationId:launch.validationId,validationRunId:launch.validationRunId}});
      if(launch.grant)this.assertGrantSource(launch.grant);
      launch.abort.signal.throwIfAborted();return await this.launchValidation(body,launch);
    }catch(error){
      const r=this.active;
      if(r&&(!original||r===original||r.id===launch.validationRunId)){
        await r.store!.appendEvent({type:launch.grant?'validation-start-failed':'validation-start-rejected',source:'studio',data:{grantId:launch.grant?.grantId,validationId:launch.validationId,validationRunId:launch.validationRunId,cancelled:launch.abort.signal.aborted,error:String(error).slice(0,512)}}).then(()=>r.store.flush()).catch(()=>console.warn('Validation startup failure evidence could not be published',JSON.stringify({runId:r.id,validationId:launch.validationId})));
        if(launch.claimed&&(r.locked||r.controller!=='human')&&!r.stopping&&!r.ending&&!this.closing){r.controller='human';r.locked=false;r.leaseEpoch++;r.execution=launch.abort.signal.aborted?'cancelled':'failed';this.window.lock(false);}
      }
      if(!r&&launch.claimed&&this.browser&&!this.closing){
        const live=this.browser.runtime;live.controller=live.pages.size?'human':'none';live.locked=false;live.leaseEpoch++;this.window.lock(false);
      }
      console.warn('Validation startup did not complete',JSON.stringify({validationId:launch.validationId,authorizationRunId:original?.id,validationRunId:launch.validationRunId,grantId:launch.grant?.grantId,cancelled:launch.abort.signal.aborted}));
      throw launch.abort.signal.aborted?launch.abort.signal.reason:error;
    }finally{options.signal?.removeEventListener('abort',abort);if(this.validationLaunch===launch)this.validationLaunch=undefined;launch.finish();this.onChanged();}
  }
  protected async launchValidation(body:any,launch:ValidationLaunch){
    launch.abort.signal.throwIfAborted();
    if(launch.grant)this.assertGrantSource(launch.grant);
    const old=this.active,projectId=old?.projectId??body.projectId,profileId=old?.profileId??body.profileId;
    const currentPageTest=body.executionMode==='current-page-test';
    const retained=currentPageTest?this.current():undefined;
    if(retained)ensure(retained.pageId===body.pageId&&retained.navigationGeneration===body.generation,'Current-page target changed during validation startup',409);
    const project=this.projects.find(p=>p.id===projectId);ensure(project,'Select a registered project before validation',404);
    ensure(this.profiles.some(profile=>profile.id===profileId&&profile.projectId===project.id),'Select a profile belonging to the validation project',409);
    // Directory registration is a trusted UI project setting, never a path accepted from an HTTP execution request.
    const directory=project.scriptDirectory;ensure(directory,'Register the workflow directory in the project first');
    if(body.materialRevisionId)await this.materials.service.revision(project.id,body.materialRevisionId,body.materialContentHash);
    {
      const live=this.browser?.runtime,selected=old?.pages.get(old.selectedPageId)??live?.pages.get(live.selectedPageId),url=selected?this.pageContents(selected)?.getURL():'about:blank';
      if(old)await this.seal(launch);launch.abort.signal.throwIfAborted();
      await this.startRun({projectId:project.id,profileId,url:body.startUrl??url??'about:blank',kind:'validate'},launch,{freshPage:!currentPageTest});
    }
    launch.abort.signal.throwIfAborted();const r=this.required(),p=this.current();launch.target??={pageId:p.pageId,targetId:p.targetId,generation:p.navigationGeneration};await this.control('agent',launch);launch.abort.signal.throwIfAborted();
    if(body.authorizationId){
      if(!currentPageTest)this.tasks.addExecutionPage(body.authorizationId,{pageId:p.pageId,targetId:p.targetId});
      await this.tasks.check(body.authorizationId,'execute',{projectId:r.projectId,sessionId:this.browserSessionId,profileId:r.profileId,directory,pageId:p.pageId,targetId:p.targetId,url:p.page.url()});
    }
    if(retained)ensure(p===retained&&p.pageId===body.pageId&&p.navigationGeneration===body.generation,'Current-page target changed before execution',409);
    await r.store.updateManifest({executionMode:body.executionMode,executionStart:{pageId:p.pageId,generation:p.navigationGeneration,url:p.page.url(),profileReused:true}});
    const targetLease=r.leaseEpoch;
    const verifyTarget=()=>{launch.abort.signal.throwIfAborted();ensure(this.active===r&&r.selectedPageId===launch.target!.pageId&&p.targetId===launch.target!.targetId&&p.navigationGeneration===launch.target!.generation&&r.leaseEpoch===targetLease&&r.controller==='agent'&&!r.stopping,'Validation startup lost its authorized target or lease',409);};
    verifyTarget();r.execution='running';
    const id=launch.validationId,record:ValidationRecord={id,runId:r.id,projectId:r.projectId,profileId:r.profileId,directory,executionMode:body.executionMode,status:'starting',startedAt:now()};this.validations.unshift(record);
    const context:ValidationLifecycleContext={validationId:id,runId:r.id,projectId:r.projectId,profileId:r.profileId,directory};
    let fixed:ManagedExecution|undefined;
    if(body.materialRevisionId)fixed=await this.executions.begin({executionId:id,projectId:r.projectId,materialRevisionId:body.materialRevisionId,materialContentHash:body.materialContentHash,directory,dependencyLockPath:path.join(this.applicationPath,'package-lock.json'),input:body.input??{},mode:body.executionMode,runId:r.id,pageId:p.pageId,environmentRef:`${this.instanceId}/${this.browserSessionId}/${r.profileId}`});
    let finishStartup!:()=>void;const startup={abort:launch.abort,gate:undefined as GateTransport|undefined,done:new Promise<void>(resolve=>{finishStartup=resolve;}),finish:()=>finishStartup()};this.workflowStarting=startup;
    try{const gate=new GateTransport(await SocketTransport.connect(this.endpoint,startup.abort.signal),{onCommand:command=>this.gateCommand(p,command),onConflict:conflict=>{void r.store!.appendEvent({type:'control-conflict',source:'runner',data:{validationId:id,pageId:p.pageId,...conflict}}).catch(error=>console.error('Could not persist runner control conflict',error));},onClosed:details=>{void r.store!.appendEvent({type:'operation-transport-closed',source:'runner',data:{validationId:id,pageId:p.pageId,...details}}).catch(error=>console.error('Could not persist runner transport closure',error));}});startup.gate=gate;startup.abort.signal.throwIfAborted();ensure(this.active===r&&r.controller==='agent'&&!r.locked,'Workflow startup lost control',409);this.workflow=await startWorkflow({workerEnvironment:this.workerEnvironment(),directory,input:body.input??{},targetId:p.targetId,transport:gate,dependencyLockPath:path.join(this.applicationPath,'package-lock.json'),startupSignal:startup.abort.signal,
      ...(fixed?{execution:{binding:fixed.binding,datasets:fixed.datasets,saveStep:(event:Parameters<ManagedExecution['saveStep']>[0])=>fixed!.saveStep(event)},snapshotDirectory:fixed.snapshotDirectory}:{}),selection:body.selection,
      beforeWorker:async prepared=>{verifyTarget();await fixed?.prepared(prepared);if(launch.grant){ensure(prepared.manifest.workflowId===launch.grant.workflowId&&prepared.fingerprintBefore.sha256===launch.grant.workflowSha256&&prepared.inputSha256===launch.grant.inputSha256,'Workflow or input changed after authorization',409);await r.store!.appendEvent({type:'validation-start-grant-applied',source:'runner',data:{grantId:launch.grant.grantId,authorizationRunId:launch.grant.runId,validationRunId:r.id,validationId:id}});}Object.assign(record,await registerValidation(r.store,record,prepared));this.onChanged();await this.observeValidation('registered-before-worker',context,startup.abort.signal);verifyTarget();},
      onStarted:async(nodeVersion,signal)=>{await r.store!.appendEvent({type:'validation-running',source:'runner',data:{id,runId:r.id,startEventId:record.recovery?.startEventId,nodeVersion}});await this.observeValidation('running',context,signal);},hooks:{
       checkpoint:async(key,details,signal,hostScope)=>{
         const generation=p.navigationGeneration;
         const current=()=>{signal?.throwIfAborted();ensure(this.active===r&&r.pages.get(p.pageId)===p&&p.navigationGeneration===generation&&r.controller==='agent'&&!r.stopping&&!this.closing,'Checkpoint source target changed or was revoked',409);};
         current();const cp=await this.checkpoint({key,...details},{fromRunner:true,pageId:p.pageId,signal});current();
         if(cp.metadata?.captureOutcome!=='completed'||cp.metadata?.captureStatus!=='complete'||cp.captureConsistency!=='consistent')throw new Error(`Checkpoint capture is incomplete (${cp.metadata?.captureOutcome}/${cp.metadata?.captureStatus}/${cp.captureConsistency}); retained checkpoint ${cp.id} cannot satisfy validation coverage`);
         if(!fixed)return {id:cp.id};ensure(hostScope?.executionId===fixed.binding.executionId,'Checkpoint manager did not supply the fixed execution scope',409);
         const sourceRefs=await this.executions.sampleCheckpoint(r.projectId,hostScope,p.capture!,details?.requirementIds,current,signal);current();return {id:cp.id,sourceRefs};
       },
      emitData:async(name,records,provenance)=>{const artifact=await r.store.putArtifact({kind:'dataset',mediaType:'application/json',data:JSON.stringify({name,records,...provenance}),source:{origin:'runner'}});await r.store!.appendEvent({type:'dataset',source:'runner',artifactRefs:[artifact.id],data:{name,count:records.length,provenance}});},
      attachArtifact:async(name,content,mediaType)=>{const a=await r.store.putArtifact({kind:'runner-attachment',mediaType,data:content,metadata:{name}});return {id:a.id};},
      assertion:async(assertion)=>{await r.store!.appendEvent({type:'assertion',source:'runner',data:assertion});},
      progress:async(message)=>{await r.store!.appendEvent({type:'progress',source:'runner',data:{message}});},
      requestHuman:async(request,signal)=>{const state=await this.beginHuman(request,'runner',p.pageId,signal);await this.observeValidation('waiting-human',context,signal);return state.completion;},
    }});
    const handle=this.workflow;launch.handle=handle;let terminalRecord:ValidationRecord|undefined,terminalExecution:string|undefined;
    const catalogSnapshot=(candidate:ValidationRecord)=>this.validations.map(item=>item===record?candidate:item);
    const settlement=handle.done.then(async result=>{
      record.status='finalizing';r.execution='finalizing';r.locked=true;this.window.lock(true);
      await fixed?.finish(result);
      terminalRecord=await commitValidation(r.store,record,result,(stage,context)=>this.observeValidation(stage,context));terminalExecution=result.status;
      // Persist a terminal projection without publishing completion while its
      // catalog write and control cleanup are still in progress.
      await this.saveValidations(catalogSnapshot(terminalRecord));
    }).catch(async error=>{
      const message='Validation report could not be committed: '+String(error);
      terminalRecord={...record,status:'interrupted',error:message,recovery:{...record.recovery,state:'interrupted',reason:message}};delete terminalRecord.result;delete terminalRecord.artifactId;terminalExecution='failed';
      this.validationRecovery.diagnostics.push({runId:r.id,validationId:id,code:'validation-commit-failed',message});
      await r.store!.appendEvent({type:'gap',source:'runner',data:{reason:message,validationId:id}}).catch(()=>{});await this.saveValidations(catalogSnapshot(terminalRecord));
    }).finally(async()=>{
      await fixed?.close();
      const continuing=!!body.authorizationId&&this.tasks.get(body.authorizationId).status==='active'&&this.browserAuthorizationId===body.authorizationId;
      if(this.active===r&&!r.stopping&&!this.closing){r.controller=continuing?'agent':'human';r.locked=false;r.leaseEpoch++;this.window.lock(continuing);}
      if(this.executingAuthorizationId===body.authorizationId)this.executingAuthorizationId=undefined;
      if(this.workflow===handle)this.workflow=undefined;if(this.workflowSettlement===settlement)this.workflowSettlement=undefined;
      // No await between releasing ownership and exposing the terminal record.
      if(terminalRecord){Object.assign(record,terminalRecord);if(!r.stopping)r.execution=terminalExecution!;if(r.handoff)r.handoff.status=record.status==='completed'?'completed':record.status==='cancelled'?'cancelled':'needs-attention';}
      if(fixed)this.tasks.publish(r.projectId,'execution-finished',{executionId:id,runId:r.id});this.onChanged();
    });
    this.workflowSettlement=settlement;if(this.closing||startup.abort.signal.aborted){await handle.cancel('Application closing or takeover during worker startup');await settlement;}return {id,executionId:fixed?id:undefined,runId:r.id,status:record.status};
    }catch(error){startup.gate?.close();await fixed?.close();this.executingAuthorizationId=undefined;r.execution=startup.abort.signal.aborted?'cancelled':'failed';if(!r.stopping&&!this.closing){r.controller='human';r.locked=false;r.leaseEpoch++;this.window.lock(false);}record.status=r.execution;record.error=String(error);await r.store!.appendEvent({type:'validation-launch-failed',source:'studio',data:{id,runId:r.id,projectId:r.projectId,profileId:r.profileId,directory,status:record.status,error:record.error,startEventId:record.recovery?.startEventId}}).catch(failure=>{this.validationRecovery.diagnostics.push({runId:r.id,validationId:id,code:'validation-launch-unrecorded',message:String(failure)});});await this.saveValidations();throw error;}
    finally{if(this.workflowStarting===startup)this.workflowStarting=undefined;startup.finish();}
  }
  protected async beginHuman(request:HumanRequest,owner:'runner'|'agent',pageId:string,signal?:AbortSignal){
    const r=this.required();signal?.throwIfAborted();ensure(r.pages.has(pageId),'Handoff page no longer exists',409);ensure(r.handoff?.status!=='waiting','Already waiting for a human',409);
    const handoff={...request,handoffId:randomUUID(),pageId,owner,status:'waiting',resumeExecution:r.execution,startedAt:now(),attempt:(r.handoff?.attempt||0)+1};r.handoff=handoff;
    let resolve!:()=>void,reject!:(error:Error)=>void;const completion=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void completion.catch(()=>{});
    const onAbort=()=>{handoff.status='needs-attention';if(this.humanDone===done)this.humanDone=undefined;reject(new Error('Execution stopped while waiting for human'));};
    const done={resolve:()=>{signal?.removeEventListener('abort',onAbort);resolve();},reject:(error:Error)=>{signal?.removeEventListener('abort',onAbort);reject(error);}};this.humanDone=done;signal?.addEventListener('abort',onAbort,{once:true});
    r.execution='waiting-human';r.controller='human';r.locked=false;r.leaseEpoch++;const previousPageId=r.selectedPageId||null;this.window.show(r.pages.get(pageId)!.view);r.selectedPageId=pageId;const foregroundAt=Date.now();this.window.lock(false);
    try{if(previousPageId!==pageId)await this.recordForeground(r as ActiveRun<I,V,S>,previousPageId,'human-handoff',foregroundAt);await r.store!.appendEvent({type:'handoff',source:owner==='runner'?'runner':'api',data:handoff});}catch(error){handoff.status='needs-attention';r.execution='paused';done.reject(error instanceof Error?error:new Error(String(error)));throw error;}this.onChanged();return {handoff,completion};
  }
  async requestHuman(request:HumanRequest,signal?:AbortSignal,pageId=this.current().pageId){const state=await this.beginHuman(request,'runner',pageId,signal);return state.completion;}
  async startHandoff(body:any){
    const r=this.required();ensure(body.runId===r.id&&body.pageId===r.selectedPageId&&body.leaseEpoch===r.leaseEpoch,'Wrong run/page or stale lease',409);ensure(r.controller==='agent'&&!r.locked&&!this.workflow&&!this.workflowSettlement,'Agent control is required for an external handoff',409);
    ensure(typeof body.instructions==='string'&&body.instructions.trim()&&typeof body.completionCheck?.selector==='string','Instructions and completion selector required');const timeoutMs=Number(body.timeoutMs)||120000;ensure(timeoutMs>0&&timeoutMs<=1800000,'Handoff timeout must be at most 30 minutes');
    if(r.operation)await r.operation.gate.quiesce();
    const handoffPage=r.pages.get(body.pageId);ensure(handoffPage,'Handoff page no longer exists',409);this.assertOperationOwner(r,handoffPage,body.leaseEpoch,body.generation);
    const state=await this.beginHuman({id:body.id||randomUUID(),instructions:body.instructions,completionCheck:body.completionCheck,timeoutMs},'agent',body.pageId);
    const timer=setTimeout(()=>{if(state.handoff.status==='waiting'){state.handoff.status='needs-attention';r.execution='paused';this.humanDone?.reject(new Error('Human assistance timed out; success remains unverified'));this.humanDone=undefined;this.onChanged();}},timeoutMs);
    void state.completion.catch(error=>r.store!.appendEvent({type:'handoff-failed',source:'api',data:{id:state.handoff.handoffId,reason:String(error)}})).finally(()=>clearTimeout(timer)).catch(error=>console.error('Could not save handoff outcome',error));return {...state.handoff,accepted:true};
  }
  async releaseHuman(handoffId?:string):Promise<HandoffReleaseResult>{
    const r=this.required();
    ensure(!r.stopping&&!r.ending&&!this.closing&&r.execution!=='cancelled','Handoff release is unavailable while the run is stopping or cancelled',409);
    const id=handoffId??r.handoff?.handoffId;
    ensure(typeof id==='string'&&id.length>0,'No available waiting handoff',409);
    const releases=r.handoffReleases??=new Map<string,Promise<HandoffReleaseResult>>();
    // A delayed reply for a completed handoff must never release the next one.
    // Keep successful replies for this run; failed checks remain retryable.
    const existing=releases.get(id);if(existing)return existing;
    ensure(id===r.handoff?.handoffId,'Wrong handoff identity',409);
    ensure(r.handoff.status==='waiting'&&this.humanDone&&!r.locked,'No available waiting handoff, or completion is already being checked',409);
    const p=r.pages.get(r.handoff.pageId);ensure(p,'Handoff page no longer exists',409);
    const handoff=r.handoff,check=handoff.completionCheck,done=this.humanDone,leaseEpoch=r.leaseEpoch;
    const current=()=>this.active===r&&r.handoff===handoff&&handoff.status==='waiting'&&this.humanDone===done&&r.leaseEpoch===leaseEpoch&&r.pages.get(p.pageId)===p&&Boolean(this.pageContents(p))&&!r.stopping&&!r.ending&&!this.closing;
    r.locked=true;this.window.lock(true);
    let release!:Promise<HandoffReleaseResult>;
    release=(async():Promise<HandoffReleaseResult>=>{
      try{
        let result:{text:string;value:string|null}|null=null;
        // Cross-document navigation may destroy the context between selector
        // lookup and evaluation. Retry only that transition, never a mismatch.
        for(let attempt=0;attempt<3;attempt++){
          ensure(current(),'Handoff changed while checking',409);
          try{
            result=await p.page.$eval(check.selector,(el,args:any)=>({text:el.textContent||'',value:args.attribute?el.getAttribute(args.attribute):null}),check);
            break;
          }catch(error){
            ensure(current(),'Handoff changed while checking',409);
            const message=error instanceof Error?error.message:String(error);
            if(/failed to find element matching selector/i.test(message))break;
            const navigated=/Execution context was destroyed|Cannot find context with specified id/i.test(message);
            if(!navigated||attempt===2)throw new Error(`Completion check could not be evaluated; human control is retained: ${message}`,{cause:error});
            await new Promise(resolve=>setTimeout(resolve,100));
          }
        }
        ensure(current(),'Handoff changed while checking',409);
        ensure(result&&(!check.text||result.text.includes(check.text))&&(!check.attribute||result.value===check.equals),'Completion check failed; human control is retained',409);
        await r.store!.appendEvent({type:'handoff-completed',source:'studio',data:{id:handoff.handoffId,pageId:p.pageId,check}});
        ensure(current(),'Handoff was cancelled while saving its completion check',409);
        if(handoff.owner==='agent'&&r.operation)r.operation.gate.resume();
        r.controller='agent';r.leaseEpoch++;r.execution=handoff.owner==='runner'?'running':handoff.resumeExecution;handoff.status='completed';this.humanDone=undefined;r.locked=false;done.resolve();this.onChanged();return {passed:true,handoffId:id};
      }catch(error){if(current()){r.locked=false;this.window.lock(false);}throw error;}
    })().catch(error=>{if(releases.get(id)===release)releases.delete(id);throw error;});
    releases.set(id,release);return release;
  }
  async cancelHandoff(handoffId?:string){const r=this.required();ensure(r.handoff&&(!handoffId||r.handoff.handoffId===handoffId),'Unknown handoff',404);return this.stopRunner();}
  async stopRunner(){
    const owner=this.browser??this.active??this.validationLaunch;
    if(this.stopTask&&this.stopTask.owner===owner)return this.stopTask.promise;
    const task={owner,promise:this.stopRunnerOwned()};this.stopTask=task;
    try{return await task.promise;}finally{if(this.stopTask===task)this.stopTask=undefined;}
  }
  protected async stopRunnerOwned(){
    const launch=this.validationLaunch;
    if(launch){
      const before=this.active;if(before){before.stopping=true;before.locked=true;before.leaseEpoch++;this.window.lock(true);}
      launch.abort.abort(new Error('User requested stop during validation startup'));this.workflowStarting?.gate?.close();
      if(launch.handle)await launch.handle.cancel('User requested stop during validation startup');
      await launch.done;
    }
    const r=this.active??this.browser?.runtime;if(!r)return null;
    const startup=this.workflowStarting,checkpoint=r.checkpointTask;
    checkpoint?.abort.abort(new Error('Runner stopping'));
    r.stopping=true;r.locked=true;r.execution='stopping';const stopEpoch=++r.leaseEpoch;this.window.lock(true);this.browserAuthorizationId=undefined;
    startup?.abort.abort(new Error('User requested stop during workflow startup'));startup?.gate?.close();
    const operationStopped=this.revokeOperation(r);
    if(r.pageCreations?.size)for(const page of r.pages.values())this.stopPage(page);
    if(this.workflow)await this.workflow.cancel('User requested stop and takeover');
    if(startup)await startup.done;
    if(this.workflowSettlement)await this.workflowSettlement;
    await operationStopped;
    await Promise.allSettled([...(r.pageCreations??[])]);
    if(checkpoint)await checkpoint.done;
    this.humanDone?.reject(new Error('Handoff cancelled'));this.humanDone=undefined;
    if((this.active===r||this.browser?.runtime===r)&&r.leaseEpoch===stopEpoch&&!this.closing&&!r.ending){r.stopping=false;r.execution='cancelled';r.controller='human';r.locked=false;if(r.handoff)r.handoff.status='cancelled';this.window.lock(false);}
    this.onChanged();return this.active===r?this.state().active:this.state().session;
  }
  async validation(id:string){const record=this.validations.find(v=>v.id===id);ensure(record,'Unknown validation',404);let currentVersion='unknown';if(record.result){const registered=this.projects.find(project=>project.id===record.projectId)?.scriptDirectory;if(!registered||path.relative(path.resolve(record.directory),path.resolve(registered))!=='')currentVersion='needs-revalidation';else try{const hash=await fingerprintWorkflow(registered,path.join(this.applicationPath,'package-lock.json'));currentVersion=hash.sha256===record.result.fingerprintAfter.sha256?'matched':'needs-revalidation';}catch{currentVersion='unavailable';}}return {...record,currentVersion};}
  async review(body:any){ensure(this.validations.some(v=>v.id===body.id),'Unknown validation',404);return appendReview(this.root,body.id,body);}
  async reviews(id:string,options:ReviewQuery={}){ensure(this.validations.some(v=>v.id===id),'Unknown validation',404);return readReviews(this.root,id,options);}
  async close(){this.closing=true;this.replayHost.close();this.tasks.close();this.validationLaunch?.abort.abort(new Error('Application closing during validation startup'));this.active?.checkpointTask?.abort.abort(new Error('Application closing'));const startup=this.workflowStarting;startup?.abort.abort(new Error('Application closing'));startup?.gate?.close();if(this.active){this.active.ending=true;this.active.locked=true;this.active.leaseEpoch++;await this.revokeOperation(this.active);}await this.queue.catch(()=>{});if(startup)await startup.done;const settlement=this.workflowSettlement;if(this.workflow)await this.workflow.cancel('Application closing');if(settlement)await settlement;this.humanDone?.reject(new Error('Application closing'));this.humanDone=undefined;if(this.active){const r=this.active;await r.stopDownloads?.();await Promise.allSettled([...(r.pageClosures??[])]);for(const p of [...r.pages.values()])await p.capture!.stop().catch(()=>{});await r.store.updateManifest({status:'interrupted',execution:'interrupted'});await r.store.close();this.window.closeViews();r.releaseDownloads?.();this.active=undefined;}await this.browserDownloads?.dispose();this.browserDownloads=undefined;await this.fixture?.close();this.observer?.disconnect();this.window.closeViews();if(this.browser)await this.releaseProviderSession(this.browser.runtime.session);this.browser=undefined;}
}
