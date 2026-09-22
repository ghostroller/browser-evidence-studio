import { WebContentsView, session, app, type Session, type DownloadItem, type WebContents } from 'electron';
import { mkdir, readFile, readdir, writeFile, rename, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { StudioWindow } from '../window';
import { SocketTransport } from '../browser/connection';
import { GateTransport } from '../../runner/gate';
import { EvidenceStore } from '../../evidence/store';
import { EvidenceReader } from '../../evidence/reader';
import { jsonLines, safeFile } from '../../evidence/files';
import { CaptureCoordinator, type PageIdentity } from '../../capture/coordinator';
import { ensure, now } from '../../shared/errors';
import { startWorkflow, type WorkflowHandle } from '../../runner/manager';
import type { HumanRequest } from '../../contracts/workflow';
import { fingerprintWorkflow } from '../../runner/fingerprint';
import { connectManagedPage } from '../../runner/puppeteer';

interface Project { id:string; name:string; objective:string; scriptDirectory?:string; createdAt:string; }
interface Profile { id:string; projectId:string; name:string; savedAt?:string; loginStatus:'unknown'|'verified'|'expired'; }
interface ManagedPage extends PageIdentity { view:WebContentsView; page:Page; capture:CaptureCoordinator; }
interface ManagedOperation { browser:Browser; gate:GateTransport; page:Page; targetId:string; }
interface PendingOperation { targetId:string; leaseEpoch:number; abort:AbortController; gate?:GateTransport; promise:Promise<ManagedOperation>; }
export interface ActiveRun {
  id:string; projectId:string; profileId:string; store:EvidenceStore; pages:Map<string,ManagedPage>; selectedPageId:string;
  session:Session; controller:'human'|'agent'|'none'; leaseEpoch:number; capture:string; execution:string;
  operation?:ManagedOperation; pendingOperation?:PendingOperation; locked:boolean; stopping?:boolean; ending?:boolean; selection?:unknown; handoff?:any;
  pageClosures?:Set<Promise<void>>;
  stopDownloads?:()=>Promise<void>;releaseDownloads?:()=>void;
}
export class Studio {
  readonly instanceId=randomUUID();
  readonly browserSessionId=randomUUID();
  projects:Project[]=[]; profiles:Profile[]=[]; runs:any[]=[]; active?:ActiveRun;
  connection:any;
  private observer!:Browser;
  private queue:Promise<unknown>=Promise.resolve();
  private historyRun?:string;
  private workflow?:WorkflowHandle;
  private workflowSettlement?:Promise<void>;
  private workflowStarting?:{abort:AbortController;gate?:GateTransport;done:Promise<void>;finish:()=>void};
  private closing=false;
  private humanDone?:{resolve:()=>void;reject:(e:Error)=>void};
  private validations:any[]=[];
  private fixture?:{url:string;close:()=>Promise<void>};
  onChanged=()=>{};
  constructor(readonly root:string, readonly window:StudioWindow, readonly endpoint:string) {}
  async init(){
    await mkdir(this.root,{recursive:true});
    try{const ws=JSON.parse(await readFile(path.join(this.root,'workspace.json'),'utf8'));this.projects=ws.projects;this.profiles=ws.profiles;}catch(e:any){if(e.code!=='ENOENT')throw e;}
    await mkdir(path.join(this.root,'runs'),{recursive:true});
    for(const id of await readdir(path.join(this.root,'runs'))){
      try{const store=await EvidenceStore.open(path.join(this.root,'runs',id));this.runs.push(store.manifest);await store.close();}catch(error){this.runs.push({id,status:'unreadable',error:String(error)});}
    }
    try{this.validations=JSON.parse(await readFile(path.join(this.root,'validations.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
    this.observer=await puppeteer.connect({browserWSEndpoint:this.endpoint,defaultViewport:null});
  }
  private async save(){ const file=path.join(this.root,'workspace.json');await writeFile(file+'.tmp',JSON.stringify({schemaVersion:1,projects:this.projects,profiles:this.profiles},null,2));await rename(file+'.tmp',file); }
  serialized<T>(fn:()=>Promise<T>):Promise<T>{const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
  required(){ensure(this.active,'No active run',409);return this.active;}
  private pageContents(p:ManagedPage){try{const contents=p.view.webContents;return contents&&!contents.isDestroyed()?contents:undefined;}catch{return undefined;}}
  current(){const r=this.required();const p=r.pages.get(r.selectedPageId);ensure(p&&this.pageContents(p),'No live selected page',409);return p;}
  state(){const r=this.active;return {instanceId:this.instanceId,projects:this.projects,profiles:this.profiles,runs:this.runs,validations:this.validations.map(v=>({id:v.id,runId:v.runId,status:v.status,validation:v.result?.validation})),fixtureUrl:this.fixture?.url,versions:{node:process.versions.node,electron:process.versions.electron,chromium:process.versions.chrome,puppeteer:'25.11.0',rrweb:'2.1.6'},active:r?{id:r.id,projectId:r.projectId,profileId:r.profileId,controller:r.controller,leaseEpoch:r.leaseEpoch,capture:r.capture,execution:r.execution,locked:r.locked,pages:[...r.pages.values()].flatMap(p=>{const contents=this.pageContents(p);return contents?[{pageId:p.pageId,targetId:p.targetId,webContentsId:p.webContentsId,url:contents.getURL(),title:contents.getTitle(),generation:p.navigationGeneration,openerPageId:p.openerPageId}]:[];}),selectedPageId:r.selectedPageId,handoff:r.handoff,selection:r.selection}:null,connection:this.connection};}
  async createProject(body:any){ensure(typeof body.name==='string'&&body.name.trim(),'Project name required');const p={id:randomUUID(),name:body.name.trim().slice(0,200),objective:String(body.objective||'').slice(0,4000),scriptDirectory:body.scriptDirectory?path.resolve(body.scriptDirectory):undefined,createdAt:now()};this.projects.push(p);await this.save();return p;}
  async updateProject(body:any){const project=this.projects.find(item=>item.id===(body.projectId||body.id));ensure(project,'Unknown project',404);if(body.name!==undefined){ensure(typeof body.name==='string'&&body.name.trim(),'Project name required');project.name=body.name.trim().slice(0,200);}if(body.objective!==undefined){ensure(typeof body.objective==='string','Objective must be text');project.objective=body.objective.slice(0,4000);}if(body.scriptDirectory!==undefined){ensure(typeof body.scriptDirectory==='string'||body.scriptDirectory===null,'Workflow directory must be a path');project.scriptDirectory=body.scriptDirectory?path.resolve(body.scriptDirectory):undefined;}await this.save();return project;}
  async createProfile(body:any){ensure(this.projects.some(p=>p.id===body.projectId),'Unknown project');ensure(typeof body.name==='string'&&body.name.trim(),'Profile name required');const p:Profile={id:randomUUID(),projectId:body.projectId,name:body.name.trim().slice(0,120),loginStatus:'unknown'};this.profiles.push(p);await this.save();return p;}
  async startRun(body:any){
    ensure(!this.active,'Seal the active run first',409); const project=this.projects.find(p=>p.id===body.projectId);ensure(project,'Unknown project');
    const profile=this.profiles.find(p=>p.id===body.profileId&&p.projectId===project.id);ensure(profile,'Profile must belong to project');
    const id=randomUUID();const browserSession=session.fromPartition(`persist:bes-${project.id}-${profile.id}`);
    browserSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false)); browserSession.setPermissionCheckHandler(()=>false);
    const store=await EvidenceStore.create(path.join(this.root,'runs',id),{id,projectId:project.id,kind:body.kind==='validate'?'validate':'demonstrate',mode:process.env.BES_TEST?'synthetic':'local',objective:project.objective,profileId:profile.id,versions:this.state().versions,appInstanceId:this.instanceId,browserSessionId:this.browserSessionId});
    const r:ActiveRun={id,projectId:project.id,profileId:profile.id,store,pages:new Map(),selectedPageId:'',session:browserSession,controller:'none',leaseEpoch:1,capture:'starting',execution:'ready',locked:true};this.active=r;this.runs.unshift(store.manifest);
    try{await this.manageDownloads(r);const page=await this.addPage(r);await this.navigate(String(body.url||'about:blank'),page,true);r.capture=[...r.pages.values()].some(p=>p.capture.health==='degraded')?'degraded':'recording';r.controller='human';r.locked=false;this.window.lock(false);await store.updateManifest({capture:r.capture,controller:'human',leaseEpoch:r.leaseEpoch});return this.state().active;}
    catch(error){r.capture='degraded';r.execution='failed';await store.appendEvent({type:'gap',source:'lifecycle',data:{reason:String(error)}});throw error;}
  }
  private async manageDownloads(r:ActiveRun){
    const directory=path.join(this.root,'downloads');await mkdir(directory,{recursive:true});let accepting=true;const active=new Set<DownloadItem>(),writes=new Set<Promise<unknown>>();
    const listener=(event:Electron.Event,item:DownloadItem,wc:WebContents)=>{const p=[...r.pages.values()].find(page=>page.webContentsId===wc.id);if(!accepting||!p){event.preventDefault();return;}const download=path.join(directory,randomUUID());item.setSavePath(download);active.add(item);
      item.once('done',(_event,state)=>{active.delete(item);if(!accepting)return;const source={pageId:p.pageId,url:item.getURL(),filename:item.getFilename()};const writing=(async()=>{if(state==='completed'){const size=(await stat(download)).size;const artifact=size>64*1024*1024?await r.store.putArtifact({kind:'download',mediaType:item.getMimeType()||'application/octet-stream',captureStatus:'excluded',reason:'Download exceeds the 64 MiB evidence import budget; original remains in the local downloads directory',source:{...source,downloadBytes:size},metadata:{localDownloadId:path.basename(download)}}):await r.store.putArtifact({kind:'download',mediaType:item.getMimeType()||'application/octet-stream',data:await readFile(download),source});await r.store.appendEvent({type:'download',source:'electron',artifactRefs:[artifact.id],data:{captureStatus:artifact.captureStatus}});}else await r.store.appendEvent({type:'gap',source:'electron',data:{reason:'download-'+state,...source}});})().catch(async error=>{r.capture='degraded';this.onChanged();await r.store.appendEvent({type:'gap',source:'electron',data:{reason:'download-capture-failed',error:String(error),...source}}).catch(failure=>console.error('Could not save download failure',failure));}).finally(()=>writes.delete(writing));writes.add(writing);});};
    r.session.on('will-download',listener);
    r.stopDownloads=async()=>{if(!accepting)return;accepting=false;for(const item of active){const source={url:item.getURL(),filename:item.getFilename()};item.cancel();await r.store.appendEvent({type:'gap',source:'electron',data:{reason:'download-cancelled-at-run-end',...source}});}active.clear();await Promise.allSettled(writes);};
    r.releaseDownloads=()=>r.session.removeListener('will-download',listener);
  }
  private pageDestroyed(r:ActiveRun,view:WebContentsView,identity:{pageId:string;webContentsId:number;openerPageId?:string},registered?:ManagedPage){
    const closedAt=now(),wasSelected=r.selectedPageId===identity.pageId,targetId=registered?.targetId;
    r.pages.delete(identity.pageId);
    if((r.selection as any)?.pageId===identity.pageId)r.selection=undefined;
    const operationAffected=!!targetId&&(r.operation?.targetId===targetId||r.pendingOperation?.targetId===targetId);
    if(wasSelected||operationAffected)r.leaseEpoch++;
    // Revocation starts synchronously, before another task can use the old lease.
    const revoked=operationAffected?this.revokeOperation(r):Promise.resolve();
    this.window.remove(view);
    if(wasSelected){
      const opener=identity.openerPageId?r.pages.get(identity.openerPageId):undefined;
      const replacement=opener&&this.pageContents(opener)?opener:[...r.pages.values()].reverse().find(page=>this.pageContents(page));
      r.selectedPageId=replacement?.pageId||'';
      if(this.active===r&&!r.ending&&!this.closing){this.window.show(replacement?.view);this.window.lock(r.locked||r.controller!=='human');}
    }
    if(r.ending||this.closing||this.active!==r){void revoked.catch(error=>console.error('Could not revoke closed-page operation',error));return;}
    if(r.handoff?.pageId===identity.pageId&&r.handoff.status==='waiting'){
      r.handoff.status='needs-attention';const done=this.humanDone;this.humanDone=undefined;
      if(r.handoff.owner==='agent')r.execution='paused';
      done?.reject(new Error('The human-assistance page closed before completion was verified'));
    }
    if(!r.pages.size){r.capture='stopped';r.controller='none';}
    const selectedPageId=r.selectedPageId||null,closures=r.pageClosures??(r.pageClosures=new Set<Promise<void>>());
    const cleanup=(async()=>{
      const outcomes=await Promise.allSettled([revoked,registered?.capture.stop()]);
      const errors=outcomes.flatMap(outcome=>outcome.status==='rejected'?[String(outcome.reason)]:[]);
      await r.store.appendEvent({type:'page-closed',source:'electron',pageId:identity.pageId,data:{...identity,targetId,wasRegistered:!!registered,selectedPageId,operationRevoked:operationAffected,closedAt,cleanupErrors:errors}});
      if(errors.length){r.capture='degraded';await r.store.appendEvent({type:'gap',source:'electron',pageId:identity.pageId,data:{reason:'closed-page-cleanup-failed',errors}});}
    })().catch(error=>{r.capture='degraded';console.error('Could not persist business page closure',error);}).finally(()=>{closures.delete(cleanup);this.onChanged();});
    closures.add(cleanup);this.onChanged();
  }
  private async addPage(r:ActiveRun,openerPageId?:string,existingView?:WebContentsView){
    const view=existingView||new WebContentsView({webPreferences:{session:r.session,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
    this.window.add(view);this.window.lock(true);
    const wc=view.webContents,pageId=randomUUID(),webContentsId=wc.id;let registered:ManagedPage|undefined;
    wc.once('destroyed',()=>this.pageDestroyed(r,view,{pageId,webContentsId,openerPageId},registered));
    wc.on('before-input-event',(e)=>{if(r.locked||r.controller!=='human')e.preventDefault();});wc.on('will-navigate',(e,url)=>{if(!/^https?:|^about:blank$/.test(url))e.preventDefault();});
    wc.setWindowOpenHandler(()=>this.active!==r||r.ending||this.closing?{action:'deny'}:({action:'allow',overrideBrowserWindowOptions:{webPreferences:{session:r.session,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}},createWindow:(options)=>{
      // Electron has already created the guest WebContents. Adopting it preserves
      // window.open/opener identity; creating another one throws in openGuestWindow.
      const child=new WebContentsView(options);
      const parentPageId=[...r.pages.values()].find(page=>page.webContentsId===wc.id)?.pageId;
      void this.serialized(async()=>{if(this.active!==r||r.ending||this.closing){if(child.webContents&&!child.webContents.isDestroyed())child.webContents.close();return;}const p=await this.addPage(r,parentPageId,child);await r.store.appendEvent({type:'gap',source:'electron',pageId:p.pageId,data:{reason:'popup-before-capture-ready',openerPageId:parentPageId}});this.window.lock(r.locked||r.controller!=='human');}).catch(async error=>{this.window.remove(child);if(!r.ending)await r.store.appendEvent({type:'gap',source:'electron',data:{reason:String(error)}}).catch(writeError=>console.error('Could not persist popup failure',writeError));});return child.webContents;
    }}));
    wc.on('render-process-gone',(_e,details)=>{if(r.ending)return;r.capture='degraded';void r.store.appendEvent({type:'gap',source:'electron',data:{reason:'render-process-gone',details}}).catch(error=>console.error('Could not persist renderer failure',error));});
    // An un-navigated WebContents has an empty URL and Puppeteer intentionally keeps
    // its target uninitialized. Prime only new views with about:blank before binding.
    if(!existingView)await wc.loadURL('about:blank');
    // Ask this WebContents itself for its CDP identity. URL and active-page position are never used.
    wc.debugger.attach('1.3'); let targetId:string;
    try{const info=await wc.debugger.sendCommand('Target.getTargetInfo');targetId=info.targetInfo.targetId;}finally{wc.debugger.detach();}
    const target=await this.observer.waitForTarget(t=>(t as any)._targetId===targetId,{timeout:10000});const page=await target.page();ensure(page,'Business target is not a page');
    const identity:PageIdentity={pageId,targetId,webContentsId,navigationGeneration:0,openerPageId};
    const capture=new CaptureCoordinator(page,identity,r.store,selection=>{if(r.pages.has(pageId)){r.selection=selection;this.onChanged();}},reason=>{if(r.ending||this.active!==r||!r.pages.has(pageId))return;r.capture='degraded';this.onChanged();void r.store.updateManifest({capture:'degraded',captureHealthReason:reason}).catch(error=>console.error('Could not persist capture health',error));});
    const p=Object.assign(identity,{view,page,capture}) as ManagedPage;ensure(!wc.isDestroyed(),'Business page closed before registration',409);registered=p;r.pages.set(p.pageId,p);r.selectedPageId=p.pageId;
    await capture.start();ensure(r.pages.get(pageId)===p&&!wc.isDestroyed(),'Business page closed while capture was starting',409);await r.store.appendEvent({type:'page-registered',source:'electron',pageId:p.pageId,data:{...identity,view:undefined,page:undefined,capture:undefined,appInstanceId:this.instanceId,browserSessionId:this.browserSessionId}});this.window.show(view);return p;
  }
  async navigate(url:string,p=this.current(),initial=false){ensure(/^https?:\/\//.test(url)||url==='about:blank','Only HTTP(S) and about:blank URLs supported');const r=this.required();if(!initial)ensure(!r.locked&&r.controller==='human','Browser is controlled by automation or locked',409);await p.view.webContents.loadURL(url);return {url:p.view.webContents.getURL()};}
  private assertOperationOwner(r:ActiveRun,p:ManagedPage,leaseEpoch:number,generation?:number){
    ensure(this.active===r&&!this.closing&&!r.ending&&r.controller==='agent'&&!r.locked&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Agent no longer owns this browser',409);
    ensure(r.leaseEpoch===leaseEpoch&&r.selectedPageId===p.pageId&&r.pages.get(p.pageId)===p,'Control lease or operation page changed',409);
    if(generation!==undefined)ensure(p.navigationGeneration===generation,'Stale navigation generation',409);
  }
  private async revokeOperation(r:ActiveRun){
    const pending=r.pendingOperation,operation=r.operation;
    pending?.abort.abort(new Error('Operation connection revoked'));
    pending?.gate?.close();operation?.gate.close();r.operation=undefined;
    await Promise.allSettled([pending?.promise,operation?.browser.disconnect()]);
    if(r.pendingOperation===pending)r.pendingOperation=undefined;
  }
  private async operation(r:ActiveRun,p:ManagedPage,leaseEpoch:number){
    this.assertOperationOwner(r,p,leaseEpoch);
    if(r.operation?.targetId===p.targetId)return r.operation;
    if(r.pendingOperation){ensure(r.pendingOperation.targetId===p.targetId&&r.pendingOperation.leaseEpoch===leaseEpoch,'Another operation connection is starting',409);return r.pendingOperation.promise;}
    const pending:PendingOperation={targetId:p.targetId,leaseEpoch,abort:new AbortController(),promise:undefined!};
    r.pendingOperation=pending;
    pending.promise=(async()=>{
      let browser:Browser|undefined;
      try{
        if(r.operation){const previous=r.operation;await previous.gate.quiesce();await previous.browser.disconnect();if(r.operation===previous)r.operation=undefined;}
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const transport=await SocketTransport.connect(this.endpoint,pending.abort.signal);
        const gate=new GateTransport(transport,{onConflict:conflict=>{void r.store.appendEvent({type:'control-conflict',source:'gate',data:conflict}).catch(error=>console.error('Could not save control conflict',error));}});
        pending.gate=gate;
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const connected=await connectManagedPage(gate,p.targetId);browser=connected.browser;
        pending.abort.signal.throwIfAborted();this.assertOperationOwner(r,p,leaseEpoch);
        const operation={...connected,gate,targetId:p.targetId};r.operation=operation;return operation;
      }catch(error){pending.gate?.close();await browser?.disconnect();throw error;}
      finally{if(r.pendingOperation===pending)r.pendingOperation=undefined;}
    })();
    return pending.promise;
  }
  async control(controller:'human'|'agent'){
    const r=this.required();ensure(r.handoff?.status!=='waiting','Use the handoff release or stop button',409);ensure(!['running','waiting-human','finalizing'].includes(r.execution),'Stop the runner before changing ownership',409);
    r.locked=true;const transitionEpoch=++r.leaseEpoch;this.window.lock(true);
    if(r.pendingOperation)await this.revokeOperation(r);
    if(r.operation){const operation=r.operation;await operation.gate.quiesce();await operation.browser.disconnect();if(r.operation===operation)r.operation=undefined;}
    ensure(this.active===r&&r.leaseEpoch===transitionEpoch&&!this.closing,'Control transition was cancelled',409);
    r.controller=controller;r.locked=false;this.window.lock(controller!=='human');
    await r.store.appendEvent({type:'control',source:'studio',data:{controller,leaseEpoch:r.leaseEpoch}});return this.state().active;
  }
  async action(body:any){const r=this.required(),p=this.current(),leaseEpoch=r.leaseEpoch;this.assertOperationOwner(r,p,leaseEpoch,body.generation);ensure(body.leaseEpoch===leaseEpoch&&body.pageId===p.pageId,'Stale lease or wrong page identity',409);
    const op=await this.operation(r,p,leaseEpoch);this.assertOperationOwner(r,p,leaseEpoch,body.generation);ensure(op.targetId===p.targetId&&r.operation===op,'Target mismatch',409);
    const commandId=randomUUID();await r.store.appendEvent({type:'command',source:'api',pageId:p.pageId,data:{commandId,type:body.type,selector:body.selector,controller:r.controller}});
    this.assertOperationOwner(r,p,leaseEpoch,body.generation);
    switch(body.type){case 'navigate':ensure(/^https?:\/\//.test(body.url),'HTTP(S) URL required');await op.page.goto(body.url);break;case 'click':await op.page.click(String(body.selector));break;case 'fill':await op.page.$eval(String(body.selector),(el:any)=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});await op.page.type(String(body.selector),String(body.value));break;case 'press':await op.page.keyboard.press(body.key);break;case 'scroll':await op.page.evaluate(({x,y})=>window.scrollBy(x,y),{x:Number(body.x)||0,y:Number(body.y)||0});break;case 'select':await op.page.select(String(body.selector),String(body.value));break;default:ensure(false,'Unsupported action');}
    return {commandId,generation:p.navigationGeneration};
  }
  async checkpoint(body:any,options:{fromRunner?:boolean;pageId?:string}={}){const r=this.required();ensure(options.fromRunner||!['running','waiting-human','finalizing','stopping'].includes(r.execution),'A running workflow owns checkpoint capture; stop it before taking a manual checkpoint',409);const requestedPageId=options.pageId??body.pageId;const p=requestedPageId?r.pages.get(requestedPageId):this.current();ensure(p,'Checkpoint page no longer exists',409);if(body.generation!==undefined)ensure(body.generation===p.navigationGeneration,'Stale navigation generation',409);ensure(!r.locked,'Checkpoint or transition already in progress',409);const wasLocked=r.locked,leaseEpoch=r.leaseEpoch;r.locked=true;this.window.lock(true);const op=r.operation;let drained=false;
    try{if(op){await op.gate.quiesce();drained=true;}const captureStartedAt=now(),generation=p.navigationGeneration;
      const result=await Promise.allSettled([p.view.webContents.capturePage().then(img=>r.store.putArtifact({kind:'screenshot',mediaType:'image/png',data:img.toPNG(),source:{pageId:p.pageId}})),p.page.evaluate(()=>{const clone=document.documentElement.cloneNode(true) as HTMLElement;clone.querySelectorAll('input,textarea').forEach(el=>{el.removeAttribute('value');if(el.tagName==='TEXTAREA')el.textContent='[masked]';});return '<!doctype html>'+clone.outerHTML;}).then(dom=>r.store.putArtifact({kind:'dom',mediaType:'text/html',data:dom,limitBytes:16*1024*1024,source:{pageId:p.pageId}}))]);
      const artifacts=[];for(let i=0;i<result.length;i++){const a=result[i];artifacts.push(a.status==='fulfilled'?a.value:await r.store.putArtifact({kind:i===0?'screenshot':'dom',mediaType:i===0?'image/png':'text/html',captureStatus:'read-failed',reason:String(a.reason)}));}
      const checkpoint=await r.store.appendCheckpoint({key:String(body.key||'checkpoint-'+Date.now()).slice(0,200),title:String(body.title||''),description:String(body.description||''),requirementIds:Array.isArray(body.requirementIds)?body.requirementIds:[],captureStartedAt,captureEndedAt:now(),pageId:p.pageId,navigationGeneration:generation,captureConsistency:p.navigationGeneration===generation?'consistent':'mixed',artifactRefs:artifacts.map(a=>a.id),metadata:{artifacts,selection:r.selection,note:'A capture interval, not an atomic or frozen page snapshot'}});
      return checkpoint;
    }finally{if(this.active===r&&r.leaseEpoch===leaseEpoch){if(op&&drained&&r.operation===op&&r.controller==='agent')op.gate.resume();r.locked=wasLocked;this.window.lock(r.locked||r.controller!=='human');}}
  }
  async snapshot(body:any={}){const r=this.required(),p=body.pageId?r.pages.get(body.pageId):this.current();ensure(p,'Snapshot page no longer exists',409);const generation=p.navigationGeneration;if(body.generation!==undefined)ensure(body.generation===generation,'Stale navigation generation',409);const max=body.maxBytes??4000;ensure(Number.isSafeInteger(max)&&max>=512&&max<=16000,'Snapshot maxBytes must be between 512 and 16000');const elements=await p.page.evaluate(()=>Array.from(document.querySelectorAll('a,button,input,select,[role],h1,h2')).slice(0,80).map((el,i)=>({ref:i,tag:el.tagName,role:el.getAttribute('role'),name:el.getAttribute('aria-label'),text:el.textContent?.trim().slice(0,180),selector:el.id?'#'+CSS.escape(el.id):null})));ensure(this.active===r&&r.pages.get(p.pageId)===p&&p.navigationGeneration===generation,'Snapshot target navigated during capture; refresh its identity',409);const result={pageId:p.pageId,generation,url:p.view.webContents.getURL(),elements:[] as typeof elements,outputTruncated:false};for(const item of elements){const candidate={...result,elements:[...result.elements,item]};if(Buffer.byteLength(JSON.stringify(candidate))+32>max)break;result.elements.push(item);}result.outputTruncated=result.elements.length<elements.length;ensure(Buffer.byteLength(JSON.stringify(result))<=max,'Snapshot metadata exceeds maxBytes; increase the budget',413);return result;}
  async pauseOperations(paused:boolean){const r=this.required();ensure(r.controller==='human','Only manual control can be paused here',409);r.locked=paused;this.window.lock(paused);return this.state().active;}
  async pauseCapture(paused:boolean){const r=this.required();for(const p of r.pages.values())await p.capture.pause(paused);r.capture=paused?'paused':[...r.pages.values()].some(p=>p.capture.health==='degraded')?'degraded':'recording';return this.state().active;}
  async saveProfile(){const r=this.required();await r.session.cookies.flushStore();r.session.flushStorageData();const p=this.profiles.find(p=>p.id===r.profileId)!;p.savedAt=now();p.loginStatus='unknown';await this.save();await r.store.appendEvent({type:'profile-saved',source:'studio',data:{profileId:p.id,loginStatus:'unknown',scope:'persistent cookies/localStorage/IndexedDB; memory/sessionStorage not guaranteed'}});return p;}
  async seal(){const r=this.required();ensure(!this.workflow&&!this.workflowStarting&&!this.workflowSettlement&&!r.stopping&&!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Stop the runner and finish saving its report before sealing',409);r.ending=true;r.locked=true;this.window.lock(true);
    if(r.operation){r.operation.gate.close();r.operation.browser.disconnect();r.operation=undefined;}
    await r.stopDownloads?.();await Promise.allSettled([...(r.pageClosures??[])]);for(const p of [...r.pages.values()])await p.capture.stop();await r.store.seal();const manifest=r.store.manifest;await r.store.close();for(const p of [...r.pages.values()])this.window.remove(p.view);r.releaseDownloads?.();this.runs=this.runs.map(x=>x.id===r.id?manifest:x);this.active=undefined;return manifest;
  }
  reader(runId:string){ensure(this.runs.some(r=>r.id===runId),'Unknown run',404);return new EvidenceReader(path.join(this.root,'runs',runId));}
  async history(runId:string){const reader=this.reader(runId);this.historyRun=runId;return {summary:await reader.summary(),checkpoints:await reader.checkpoints({limit:100,maxBytes:32768}),events:await reader.events({limit:50,maxBytes:16000}),gaps:await reader.gaps({limit:20}),validations:this.validations.filter(record=>record.runId===runId).map(record=>({id:record.id,status:record.status,validation:record.result?.validation,artifactId:record.artifactId}))};}
  async syntheticSite(){if(!this.fixture){const {startFixture}=await import('../../../test/fixtures/site');this.fixture=await startFixture();}return {url:this.fixture.url};}
  async replay(body:any){
    const reader=this.reader(body.runId),replayActive=this.active;if(replayActive&&replayActive.id===body.runId)await replayActive.store.flush();
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
  async validate(body:any){
    ensure(!this.closing&&!this.workflow&&!this.workflowSettlement&&!this.workflowStarting,'An execution is active, starting, saving, or the application is closing',409);
    const old=this.active,projectId=old?.projectId??body.projectId,profileId=old?.profileId??body.profileId;
    const project=this.projects.find(p=>p.id===projectId);ensure(project,'Select a registered project before validation',404);
    ensure(this.profiles.some(profile=>profile.id===profileId&&profile.projectId===project.id),'Select a profile belonging to the validation project',409);
    // Directory registration is a trusted UI project setting, never a path accepted from an HTTP execution request.
    const directory=project.scriptDirectory;ensure(directory,'Register the workflow directory in the project first');
    if(!old||old.store.manifest.kind!=='validate'||old.execution!=='ready'){
      const selected=old?.pages.get(old.selectedPageId),url=selected?this.pageContents(selected)?.getURL():'about:blank';
      if(old)await this.seal();
      await this.startRun({projectId:project.id,profileId,url:url||'about:blank',kind:'validate'});
    }
    const r=this.required(),p=this.current();await this.control('agent');r.execution='running';
    const id=randomUUID(),record:any={id,runId:r.id,projectId:r.projectId,directory,status:'running',startedAt:now()};this.validations.unshift(record);
    let finishStartup!:()=>void;const startup={abort:new AbortController(),gate:undefined as GateTransport|undefined,done:new Promise<void>(resolve=>{finishStartup=resolve;}),finish:()=>finishStartup()};this.workflowStarting=startup;
    try{const gate=new GateTransport(await SocketTransport.connect(this.endpoint,startup.abort.signal));startup.gate=gate;startup.abort.signal.throwIfAborted();ensure(this.active===r&&r.controller==='agent'&&!r.locked,'Workflow startup lost control',409);this.workflow=await startWorkflow({directory,input:body.input||{},targetId:p.targetId,transport:gate,dependencyLockPath:path.join(app.getAppPath(),'package-lock.json'),hooks:{
      checkpoint:async(key,details)=>{const cp=await this.checkpoint({key,...details},{fromRunner:true,pageId:p.pageId});return {id:cp.id};},
      emitData:async(name,records,provenance)=>{const artifact=await r.store.putArtifact({kind:'dataset',mediaType:'application/json',data:JSON.stringify({name,records,...provenance}),source:{origin:'runner'}});await r.store.appendEvent({type:'dataset',source:'runner',artifactRefs:[artifact.id],data:{name,count:records.length,provenance}});},
      attachArtifact:async(name,content,mediaType)=>{const a=await r.store.putArtifact({kind:'runner-attachment',mediaType,data:content,metadata:{name}});return {id:a.id};},
      assertion:async(assertion)=>{await r.store.appendEvent({type:'assertion',source:'runner',data:assertion});},
      progress:async(message)=>{await r.store.appendEvent({type:'progress',source:'runner',data:{message}});},
      requestHuman:(request,signal)=>this.requestHuman(request,signal,p.pageId),
    }});
    const handle=this.workflow;const settlement=handle.done.then(async result=>{
      record.status='finalizing';r.execution='finalizing';r.locked=true;this.window.lock(true);
      const report=await r.store.putArtifact({kind:'validation-report',mediaType:'application/json',data:JSON.stringify(result)});await r.store.appendEvent({type:'validation-complete',source:'runner',artifactRefs:[report.id],data:{id,status:result.status,validation:result.validation}});await r.store.flush();
      const savedRecord={...record,result,status:result.status,artifactId:report.id};
      await writeFile(path.join(this.root,'validations.json.tmp'),JSON.stringify(this.validations.map(v=>v===record?savedRecord:v)));await rename(path.join(this.root,'validations.json.tmp'),path.join(this.root,'validations.json'));
      Object.assign(record,savedRecord);r.execution=result.status;if(r.handoff)r.handoff.status=result.status==='completed'?'completed':result.status==='cancelled'?'cancelled':'needs-attention';
    }).catch(async error=>{record.status='failed';record.error='Validation report could not be saved: '+String(error);r.execution='failed';await r.store.appendEvent({type:'gap',source:'runner',data:{reason:record.error}}).catch(()=>{});
    }).finally(()=>{if(this.active===r&&!r.stopping&&!this.closing){r.controller='human';r.locked=false;r.leaseEpoch++;this.window.lock(false);}if(this.workflow===handle)this.workflow=undefined;if(this.workflowSettlement===settlement)this.workflowSettlement=undefined;this.onChanged();});
    this.workflowSettlement=settlement;if(this.closing||startup.abort.signal.aborted){await handle.cancel('Application closing or takeover during worker startup');await settlement;}return {id,runId:r.id,status:record.status};
    }catch(error){startup.gate?.close();r.execution=startup.abort.signal.aborted?'cancelled':'failed';if(!r.stopping&&!this.closing){r.controller='human';r.locked=false;r.leaseEpoch++;this.window.lock(false);}record.status=r.execution;record.error=String(error);throw error;}
    finally{if(this.workflowStarting===startup)this.workflowStarting=undefined;startup.finish();}
  }
  private async beginHuman(request:HumanRequest,owner:'runner'|'agent',pageId:string,signal?:AbortSignal){
    const r=this.required();signal?.throwIfAborted();ensure(r.pages.has(pageId),'Handoff page no longer exists',409);ensure(r.handoff?.status!=='waiting','Already waiting for a human',409);
    const handoff={...request,handoffId:randomUUID(),pageId,owner,status:'waiting',resumeExecution:r.execution,startedAt:now(),attempt:(r.handoff?.attempt||0)+1};r.handoff=handoff;
    let resolve!:()=>void,reject!:(error:Error)=>void;const completion=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void completion.catch(()=>{});
    const onAbort=()=>{handoff.status='needs-attention';if(this.humanDone===done)this.humanDone=undefined;reject(new Error('Execution stopped while waiting for human'));};
    const done={resolve:()=>{signal?.removeEventListener('abort',onAbort);resolve();},reject:(error:Error)=>{signal?.removeEventListener('abort',onAbort);reject(error);}};this.humanDone=done;signal?.addEventListener('abort',onAbort,{once:true});
    r.execution='waiting-human';r.controller='human';r.locked=false;r.leaseEpoch++;this.window.show(r.pages.get(pageId)!.view);r.selectedPageId=pageId;this.window.lock(false);
    try{await r.store.appendEvent({type:'handoff',source:owner==='runner'?'runner':'api',data:handoff});}catch(error){handoff.status='needs-attention';r.execution='paused';done.reject(error instanceof Error?error:new Error(String(error)));throw error;}this.onChanged();return {handoff,completion};
  }
  async requestHuman(request:HumanRequest,signal?:AbortSignal,pageId=this.current().pageId){const state=await this.beginHuman(request,'runner',pageId,signal);return state.completion;}
  async startHandoff(body:any){
    const r=this.required();ensure(body.runId===r.id&&body.pageId===r.selectedPageId&&body.leaseEpoch===r.leaseEpoch,'Wrong run/page or stale lease',409);ensure(r.controller==='agent'&&!r.locked&&!this.workflow&&!this.workflowSettlement,'Agent control is required for an external handoff',409);
    ensure(typeof body.instructions==='string'&&body.instructions.trim()&&typeof body.completionCheck?.selector==='string','Instructions and completion selector required');const timeoutMs=Number(body.timeoutMs)||120000;ensure(timeoutMs>0&&timeoutMs<=1800000,'Handoff timeout must be at most 30 minutes');
    if(r.operation)await r.operation.gate.quiesce();
    const handoffPage=r.pages.get(body.pageId);ensure(handoffPage,'Handoff page no longer exists',409);this.assertOperationOwner(r,handoffPage,body.leaseEpoch,body.generation);
    const state=await this.beginHuman({id:body.id||randomUUID(),instructions:body.instructions,completionCheck:body.completionCheck,timeoutMs},'agent',body.pageId);
    const timer=setTimeout(()=>{if(state.handoff.status==='waiting'){state.handoff.status='needs-attention';r.execution='paused';this.humanDone?.reject(new Error('Human assistance timed out; success remains unverified'));this.humanDone=undefined;this.onChanged();}},timeoutMs);
    void state.completion.catch(error=>r.store.appendEvent({type:'handoff-failed',source:'api',data:{id:state.handoff.handoffId,reason:String(error)}})).finally(()=>clearTimeout(timer)).catch(error=>console.error('Could not save handoff outcome',error));return {...state.handoff,accepted:true};
  }
  async releaseHuman(handoffId?:string){const r=this.required();ensure(r.handoff?.status==='waiting'&&this.humanDone&&!r.locked&&!r.stopping,'No available waiting handoff, or completion is already being checked',409);ensure(!handoffId||handoffId===r.handoff.handoffId,'Wrong handoff identity',409);const p=r.pages.get(r.handoff.pageId);ensure(p,'Handoff page no longer exists',409);
    const handoff=r.handoff,check=handoff.completionCheck,done=this.humanDone,leaseEpoch=r.leaseEpoch;
    const current=()=>this.active===r&&r.handoff===handoff&&handoff.status==='waiting'&&this.humanDone===done&&r.leaseEpoch===leaseEpoch&&!r.stopping&&!this.closing;
    r.locked=true;this.window.lock(true);
    try{
      const result=await p.page.$eval(check.selector,(el,args:any)=>({text:el.textContent||'',value:args.attribute?el.getAttribute(args.attribute):null}),check).catch(()=>null);
      ensure(current(),'Handoff changed while checking',409);
      ensure(result&&(!check.text||result.text.includes(check.text))&&(!check.attribute||result.value===check.equals),'Completion check failed; human control is retained',409);
      await r.store.appendEvent({type:'handoff-completed',source:'studio',data:{id:handoff.handoffId,pageId:p.pageId,check}});
      ensure(current(),'Handoff was cancelled while saving its completion check',409);
      if(handoff.owner==='agent'&&r.operation)r.operation.gate.resume();
      r.controller='agent';r.leaseEpoch++;r.execution=handoff.owner==='runner'?'running':handoff.resumeExecution;handoff.status='completed';this.humanDone=undefined;r.locked=false;done.resolve();this.onChanged();return {passed:true,handoffId:handoff.handoffId};
    }catch(error){if(current()){r.locked=false;this.window.lock(false);}throw error;}
  }
  async cancelHandoff(handoffId?:string){const r=this.required();ensure(r.handoff&&(!handoffId||r.handoff.handoffId===handoffId),'Unknown handoff',404);return this.stopRunner();}
  async stopRunner(){
    const r=this.required(),startup=this.workflowStarting;
    r.stopping=true;r.locked=true;r.execution='stopping';r.leaseEpoch++;this.window.lock(true);
    startup?.abort.abort(new Error('User requested stop during workflow startup'));startup?.gate?.close();
    const operationStopped=this.revokeOperation(r);
    if(this.workflow)await this.workflow.cancel('User requested stop and takeover');
    if(startup)await startup.done;
    if(this.workflowSettlement)await this.workflowSettlement;
    await operationStopped;
    this.humanDone?.reject(new Error('Handoff cancelled'));this.humanDone=undefined;
    if(this.active===r){r.stopping=false;r.execution='cancelled';r.controller='human';r.locked=false;if(r.handoff)r.handoff.status='cancelled';this.window.lock(false);}
    return this.state().active;
  }
  async validation(id:string){const record=this.validations.find(v=>v.id===id);ensure(record,'Unknown validation',404);let currentVersion='unknown';if(record.result){const registered=this.projects.find(project=>project.id===record.projectId)?.scriptDirectory;if(!registered||path.relative(path.resolve(record.directory),path.resolve(registered))!=='')currentVersion='needs-revalidation';else try{const hash=await fingerprintWorkflow(registered,path.join(app.getAppPath(),'package-lock.json'));currentVersion=hash.sha256===record.result.fingerprintAfter.sha256?'matched':'needs-revalidation';}catch{currentVersion='unavailable';}}return {...record,currentVersion};}
  async review(body:any){ensure(this.validations.some(v=>v.id===body.id),'Unknown validation',404);ensure(['accept','reject','exception'].includes(body.verdict)&&typeof body.reason==='string'&&body.reason.trim(),'Review verdict and reason required');const review={id:randomUUID(),validationId:body.id,verdict:body.verdict,reason:body.reason,scope:body.scope||'all',createdAt:now()};await appendFile(path.join(this.root,'reviews.jsonl'),JSON.stringify(review)+'\n');return review;}
  async close(){this.closing=true;const startup=this.workflowStarting;startup?.abort.abort(new Error('Application closing'));startup?.gate?.close();if(this.active){this.active.ending=true;this.active.locked=true;this.active.leaseEpoch++;await this.revokeOperation(this.active);}await this.queue.catch(()=>{});if(startup)await startup.done;const settlement=this.workflowSettlement;if(this.workflow)await this.workflow.cancel('Application closing');if(settlement)await settlement;this.humanDone?.reject(new Error('Application closing'));this.humanDone=undefined;if(this.active){const r=this.active;await r.stopDownloads?.();await Promise.allSettled([...(r.pageClosures??[])]);for(const p of [...r.pages.values()])await p.capture.stop().catch(()=>{});await r.store.updateManifest({status:'interrupted',execution:'interrupted'});await r.store.close();this.window.closeViews();r.releaseDownloads?.();this.active=undefined;}await this.fixture?.close();this.observer?.disconnect();this.window.closeViews();}
}
