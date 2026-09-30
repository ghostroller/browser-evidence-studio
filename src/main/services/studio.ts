import { WebContentsView, session, app, Menu, clipboard, shell, type Session } from 'electron';
import { mkdir, readFile, readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { sameReplayPosition } from '@/contracts/recording';
import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser, type Page, type Dialog } from 'puppeteer-core';
import { StudioWindow } from '../window';
import { SocketTransport } from '../browser/connection';
import { browserEnvironmentMetadata } from '../browser/environment';
import { GateTransport } from '@/runner/gate';
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
import { ReplayHost } from './replay-host';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { rewriteReplayEvent } from '@/resources/replay-resources';
import { ProjectExecutions, type ManagedExecution } from './project-executions';
import { captureMetadata } from '@/capture/url-privacy';
import { navigateObserved } from '../browser/navigation';
import { browserUrl, browserShortcut, type BrowserCommand, type BrowserPageStatus, type BrowserSessionStatus } from '../browser/browser-controls';
import { SessionDownloads } from '../browser/downloads';
import { commitValidation, recoverValidationCatalog, registerValidation, saveValidationCatalog, type ValidationLifecycleContext, type ValidationLifecycleObserver, type ValidationLifecycleStage, type ValidationRecord, type ValidationRecoveryDiagnostic } from './validation-lifecycle';
export type { ValidationLifecycleContext, ValidationLifecycleObserver, ValidationLifecycleStage } from './validation-lifecycle';

import { StudioCore, type ManagedPage as RuntimePage, type SessionRuntime as RuntimeSession, type ActiveRun as RuntimeRun } from './studio-core';
import { assertProfileProvider } from '../browser/runtime';
import type { ElectronPageIdentity } from '@/capture/coordinator';
type ManagedPage = RuntimePage<ElectronPageIdentity,WebContentsView>;
export type SessionRuntime = RuntimeSession<ElectronPageIdentity,WebContentsView,Session>;
export type ActiveRun = RuntimeRun<ElectronPageIdentity,WebContentsView,Session>;
export class Studio extends StudioCore<ElectronPageIdentity,WebContentsView,Session> {
  readonly runtimeProvider='electron' as const;
  readonly replayHost:ReplayHost;
  declare readonly window:StudioWindow;
  constructor(root:string,window:StudioWindow,endpoint:string,lifecycleObserver?:ValidationLifecycleObserver){super(root,window,endpoint,app.getAppPath(),lifecycleObserver);this.replayHost=new ReplayHost(window,this.materials,root);window.onBrowserShortcut=action=>this.handleBrowserShortcut(action);}
  protected async providerSession(profile:Profile){assertProfileProvider(profile,'electron');return session.fromPartition(profile.storageRef??`persist:bes-${profile.projectId}-${profile.id}`);}
  protected async releaseProviderSession(_session:Session){}
  protected providerEnvironment(session:Session){return browserEnvironmentMetadata(session);}
  protected installNavigationPolicy(browserSession:Session){browserSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:(details.resourceType==='mainFrame'||details.resourceType==='subFrame')&&!this.navigationAllowed(details.url)}));}
  protected hostIdentity(page:ManagedPage){return {provider:'electron' as const,webContentsId:page.webContentsId};}
  protected screenshot(p:ManagedPage){return p.view.getVisible()?p.view.webContents.capturePage().then(img=>img.toPNG()):p.page.screenshot({type:'png',captureBeyondViewport:false});}
  protected stopPage(p:ManagedPage){if(!p.view.webContents.isDestroyed())p.view.webContents.stop();}
  protected pageContents(p:ManagedPage){try{const contents=p.view.webContents;return contents&&!contents.isDestroyed()?contents:undefined;}catch{return undefined;}}

  protected configurePermissions(browserSession:Session){
    browserSession.setPermissionRequestHandler((wc,permission,callback,details)=>{
      callback(false);this.browserNotice=`网站权限已拒绝：${permission}（${details.requestingUrl||wc?.getURL()||'未知来源'}）。此权限暂未支持，未改变环境安全设置。`;this.onChanged();
    });
    browserSession.setPermissionCheckHandler((wc,permission,origin)=>{if(wc&&this.browser?.runtime.pages.size&&[...this.browser.runtime.pages.values()].some(page=>page.webContentsId===wc.id)){this.browserNotice=`网站权限已拒绝：${permission}（${origin}）。此权限暂未支持。`;this.onChanged();}return false;});
  }

  protected async ensureDownloads(){
    if(this.browserDownloads)return;
    const owner=this.browser!;
    const downloads=new SessionDownloads(owner.runtime.session,path.join(this.root,'downloads'),wc=>this.browser===owner?[...owner.runtime.pages.values()].find(page=>page.webContentsId===wc.id)?.pageId:undefined,()=>this.onChanged());
    await downloads.start();this.browserDownloads=downloads;
  }

  protected async addPage(r:SessionRuntime,openerPageId?:string,existingView?:WebContentsView,activate=true){
    const owner=this.browser!;
    const previousPageId=r.selectedPageId;
    const view=existingView||new WebContentsView({webPreferences:{session:r.session,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
    const wc=view.webContents,pageId=randomUUID(),webContentsId=wc.id;let registered:ManagedPage|undefined,committed=false,registrationRecorded=false,foregroundRecorded=false,removeObserver:(()=>void)|undefined;
    try{
    this.window.add(view,activate);this.window.lock(true);
    wc.once('destroyed',()=>{if(committed)this.pageDestroyed(owner.runtime,view,{provider:'electron',pageId,webContentsId,targetId:registered?.targetId??'unregistered',navigationGeneration:registered?.navigationGeneration??0,openerPageId},registered);});
    wc.on('before-input-event',(e,input)=>{const live=owner.runtime;const action=browserShortcut(input);if(live.locked||live.controller!=='human'){e.preventDefault();return;}if(action){e.preventDefault();this.handleBrowserShortcut(action,registered);}});
    const denied=(url:string)=>{if(registered)registered.loadError={kind:'denied',url,message:'导航被当前授权范围或网址协议限制拒绝'};this.onChanged();};
    wc.on('will-navigate',(e,url)=>{if(!/^https?:|^about:blank$/.test(url)||!this.navigationAllowed(url)){e.preventDefault();denied(url);}});
    wc.on('will-redirect',(event,url)=>{if(!this.navigationAllowed(url)){event.preventDefault();denied(url);}});
    wc.on('did-start-loading',()=>{if(registered)registered.loadError=undefined;this.onChanged();});
    wc.on('did-stop-loading',()=>this.onChanged());wc.on('page-title-updated',()=>this.onChanged());
    wc.on('did-navigate',(_event,url)=>{if(registered)registered.lastUrl=url;this.onChanged();});
    wc.on('did-fail-load',(_event,code,message,url,main)=>{if(registered&&main&&code!==-3){registered.loadError={kind:message.includes('CERT')?'certificate':'network',url,message,code};this.onChanged();}});
    wc.on('found-in-page',(_event,result)=>{if(registered){registered.find={requestId:result.requestId,activeMatchOrdinal:result.activeMatchOrdinal,matches:result.matches};this.onChanged();}});
    wc.on('context-menu',(_event,params)=>{if(!registered||this.browser!==owner||owner.runtime.controller!=='human'||owner.runtime.locked||registered.capture?.inspecting)return;const target=registered,body=this.humanCommandIdentity(target);Menu.buildFromTemplate([
      {label:'复制文字',enabled:!!params.selectionText,click:()=>clipboard.writeText(params.selectionText)},
      {label:'复制链接',enabled:!!params.linkURL,click:()=>clipboard.writeText(params.linkURL)},
      {label:'粘贴',enabled:params.isEditable,click:()=>{if(this.browser===owner&&owner.runtime.leaseEpoch===body.leaseEpoch&&owner.runtime.controller==='human'&&!owner.runtime.locked&&owner.runtime.pages.get(target.pageId)===target&&target.navigationGeneration===body.generation)wc.paste();}},
      {label:'在新受管标签打开链接',enabled:/^https?:\/\//.test(params.linkURL),click:()=>{void this.serialized(()=>this.browserCommand({...body,command:'new',url:params.linkURL})).catch(error=>this.browserFailure(error));}},
    ]).popup({window:this.window.window});});
    wc.setWindowOpenHandler(details=>this.browser!==owner||owner.runtime.ending||this.closing||!this.navigationAllowed(details.url)||(owner.runtime.controller==='agent'&&!!this.browserAuthorizationId&&!this.tasks.get(this.browserAuthorizationId).capabilities.includes('page-create'))?{action:'deny'}:({action:'allow',overrideBrowserWindowOptions:{webPreferences:{session:r.session,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}},createWindow:(options)=>{
      // Electron has already created the guest WebContents. Adopting it preserves
      // window.open/opener identity; creating another one throws in openGuestWindow.
      const child=new WebContentsView(options);
      const parentPageId=[...owner.runtime.pages.values()].find(page=>page.webContentsId===wc.id)?.pageId;
      void this.serialized(async()=>{const live=owner.runtime;if(this.browser!==owner||live.ending||this.closing){if(child.webContents&&!child.webContents.isDestroyed())child.webContents.close();return;}const p=await this.addPage(live,parentPageId,child);if(this.active===live)await live.store!.appendEvent({type:'gap',source:'electron',pageId:p.pageId,data:{reason:'popup-before-capture-ready',openerPageId:parentPageId}});this.window.lock(live.locked||live.controller!=='human');}).catch(async error=>{this.window.remove(child);const live=owner.runtime;if(this.active===live&&!live.ending)await live.store!.appendEvent({type:'gap',source:'electron',data:{reason:String(error)}}).catch(writeError=>console.error('Could not persist popup failure',writeError));else console.error('Could not register live session popup',error);});return child.webContents;
    }}));
    wc.on('render-process-gone',(_e,details)=>{registered?.capture?.documentDestroyed();if(registered)registered.loadError={kind:'renderer',url:registered.lastUrl||'',message:'网页进程退出：'+details.reason};const live=owner.runtime;if(live.ending)return;live.capture='degraded';this.onChanged();if(this.active===live)void live.store!.appendEvent({type:'gap',source:'electron',data:{reason:'render-process-gone',details}}).catch(error=>console.error('Could not persist renderer failure',error));});
    // An un-navigated WebContents has an empty URL and Puppeteer intentionally keeps
    // its target uninitialized. Prime only new views with about:blank before binding.
    if(!existingView)await wc.loadURL('about:blank');
    // Ask this WebContents itself for its CDP identity. URL and active-page position are never used.
    wc.debugger.attach('1.3'); let targetId:string;
    try{const info=await wc.debugger.sendCommand('Target.getTargetInfo');targetId=info.targetInfo.targetId;}finally{wc.debugger.detach();}
    const target=await this.observer.waitForTarget(t=>(t as any)._targetId===targetId,{timeout:10000});const page=await target.page();ensure(page,'Business target is not a page');
    const identity:ElectronPageIdentity={provider:'electron',pageId,targetId,webContentsId,navigationGeneration:0,openerPageId};
    // Navigation identity belongs to the browser session and must keep advancing
    // when there is no recorder. The Puppeteer observer outlives capture CDP.
    const onNavigation=(frame:ReturnType<Page['mainFrame']>)=>{if(frame===page.mainFrame()){identity.navigationGeneration++;this.onChanged();}};
    page.on('framenavigated',onNavigation);removeObserver=()=>page.off('framenavigated',onNavigation);
    const capture=this.active===r?this.createCapture(this.active,Object.assign(identity,{page})):undefined;
    const p=Object.assign(identity,{view,page,capture,lastUrl:wc.getURL()}) as ManagedPage;ensure(!wc.isDestroyed(),'Business page closed before registration',409);registered=p;r.pages.set(p.pageId,p);if(activate)r.selectedPageId=p.pageId;const foregroundAt=Date.now();
    page.on('pageerror',error=>{if(this.browser===owner&&owner.runtime.pages.get(p.pageId)===p&&String(error).includes('prompt')){this.browserNotice='当前 Electron 不支持网站 prompt() 输入对话框；未确认此请求，请使用站内表单或联系站点提供其他输入方式。';this.onChanged();}});
    page.on('dialog',dialog=>{p.dialog={id:randomUUID(),value:dialog};this.onChanged();});
    if(this.active===r){await capture!.start();ensure(r.pages.get(pageId)===p&&!wc.isDestroyed(),'Business page closed while capture was starting',409);await r.store!.appendEvent({type:'page-registered',source:'electron',pageId:p.pageId,data:{pageId:p.pageId,targetId:p.targetId,webContentsId:p.webContentsId,navigationGeneration:p.navigationGeneration,openerPageId,appInstanceId:this.instanceId,browserSessionId:this.browserSessionId}});registrationRecorded=true;if(activate){await this.recordForeground(r as ActiveRun,previousPageId||null,'page-created',foregroundAt);foregroundRecorded=true;}}
    ensure(this.browser===owner&&owner.runtime===r&&!r.ending&&!this.closing,'Browser session changed during page initialization',409);
    if(activate)this.window.show(view);
    // Authorization is the final potentially throwing registration step.
    if(openerPageId&&r.controller==='agent'&&this.browserAuthorizationId)this.tasks.addPage(this.browserAuthorizationId,{pageId:p.pageId,targetId:p.targetId});
    committed=true;this.onChanged();return p;
    }catch(error){
      removeObserver?.();if(registered){r.pages.delete(pageId);await registered.capture?.stop().catch(cleanup=>console.error('Failed page capture cleanup',cleanup));}
      if(r.selectedPageId===pageId)r.selectedPageId=r.pages.has(previousPageId)?previousPageId:'';
      this.window.remove(view);if(this.browser===owner)this.window.show(owner.runtime.pages.get(owner.runtime.selectedPageId)?.view);
      if(this.active===r&&(registrationRecorded||foregroundRecorded)){
        await r.store!.appendEvent({type:'gap',source:'electron',pageId,data:{reason:'page-initialization-failed',registrationRecorded,foregroundRecorded,message:String(error)}}).catch(failure=>console.error('Could not persist failed page initialization',failure));
        if(foregroundRecorded)await this.recordForeground(r as ActiveRun,pageId,'page-initialization-rollback',Date.now()).catch(failure=>console.error('Could not persist foreground restoration',failure));
      }
      throw error;
    }finally{if(this.browser===owner)this.window.lock(owner.runtime.locked||owner.runtime.controller!=='human');this.onChanged();}
  }

  protected handleBrowserShortcut(action:string,page?:ManagedPage){
    const r=this.browser?.runtime;if(!r)return;
    const target=page??r.pages.get(r.selectedPageId);
    if(page&&r.pages.get(page.pageId)!==page)return;
    if(['address','find','save','cancel'].includes(action)){
      this.browserUiAction={id:randomUUID(),action:action as 'address'|'find'|'save'|'cancel',pageId:target?.pageId??''};
      this.window.focusUi();this.onChanged();return;
    }
    const body=this.humanCommandIdentity(target);
    if(action.startsWith('zoom-')){const factor=target?.view.webContents.getZoomFactor()??1;void this.serialized(()=>this.browserCommand({...body,command:'zoom',zoomFactor:action==='zoom-reset'?1:Math.max(.25,Math.min(3,factor+(action==='zoom-in'?.1:-.1)))})).catch(error=>this.browserFailure(error));return;}
    void this.serialized(()=>this.browserCommand({...body,command:action as BrowserCommand['command']})).catch(error=>this.browserFailure(error));
  }

  protected loadHumanUrl(page:ManagedPage,input:string){
    let url:string;try{url=browserUrl(input);}catch(error){page.loadError={kind:'url',url:String(input),message:String(error)};this.onChanged();throw error;}
    if(!this.navigationAllowed(url)){page.loadError={kind:'denied',url,message:'此网址不在当前授权范围内'};this.onChanged();throw new StudioError(403,'navigation_denied','此网址不在当前授权范围内');}
    page.loadError=undefined;page.lastUrl=url;
    // Native events own human navigation progress. Do not hold the command queue
    // until load completion: Stop must be able to interrupt a slow response.
    void page.view.webContents.loadURL(url).catch(error=>{if(this.browser?.runtime.pages.get(page.pageId)===page&&!page.view.webContents.isDestroyed()&&!String(error).includes('ERR_ABORTED')){page.loadError??={kind:'network',url,message:String(error)};this.onChanged();}});this.onChanged();
  }

  async browserCommand(body:BrowserCommand){
    const r=this.live();ensure(body.sessionId===this.browserSessionId&&body.leaseEpoch===r.leaseEpoch,'浏览器会话或控制权已变化，请重试',409);
    ensure(r.controller==='human'&&!r.locked&&!r.ending&&!r.stopping,'浏览器由自动化控制或正在锁定，请先停止或接管',409);
    const page=body.pageId?r.pages.get(body.pageId):undefined;
    if(body.pageId)ensure(page&&body.targetId===page.targetId&&body.generation===page.navigationGeneration,'标签身份或页面代际已变化，请重试',409);
    const selected=r.pages.get(r.selectedPageId);
    if(!['dialog','notice-dismiss','download-cancel','download-show'].includes(body.command))ensure(this.active!==r||!selected?.capture?.inspecting,'请先结束元素选择',409);
    if(['new','reopen'].includes(body.command)){
      ensure(!selected||page===selected,'新标签需绑定当前页面身份',409);
      const previous=body.command==='reopen'?this.closedPages?.at(-1):undefined;
      if(body.command==='reopen')ensure(previous,'没有可恢复的已关闭标签',409);
      const url=browserUrl(previous?.url??body.url??'about:blank');
      const created=await this.addPage(r,page?.pageId);r.leaseEpoch++;
      this.loadHumanUrl(created,url);if(previous)this.closedPages.pop();return this.browserState();
    }
    if(body.command==='notice-dismiss'){this.browserNotice=undefined;return this.browserState();}
    if(body.command==='download-cancel'){ensure(body.downloadId,'缺少下载身份');this.browserDownloads?.cancel(body.downloadId);return this.browserState();}
    if(body.command==='download-show'){ensure(body.downloadId&&this.browserDownloads,'缺少下载身份');shell.showItemInFolder(this.browserDownloads.location(body.downloadId));return this.browserState();}
    ensure(page,'请选择一个实时标签',409);
    if(body.command==='select'){await this.selectPage(page.pageId);return this.browserState();}
    if(body.command==='close')return this.closePage(page.pageId);
    ensure(page===selected,'此操作仅适用于当前标签',409);
    const wc=page.view.webContents;
    switch(body.command){
      case 'navigate':this.loadHumanUrl(page,body.url??'');break;
      case 'back':ensure(wc.navigationHistory.canGoBack(),'没有上一页',409);wc.navigationHistory.goBack();break;
      case 'forward':ensure(wc.navigationHistory.canGoForward(),'没有下一页',409);wc.navigationHistory.goForward();break;
      case 'reload':this.loadHumanUrl(page,page.loadError?.url||page.lastUrl||wc.getURL());break;
      case 'stop':wc.stop();break;
      case 'find':ensure(typeof body.text==='string'&&body.text.length>0&&body.text.length<=500,'请输入 1–500 字的查找文字');wc.findInPage(body.text,{forward:body.forward!==false,findNext:!body.findNext});break;
      case 'find-close':wc.stopFindInPage('clearSelection');page.find=undefined;break;
      case 'zoom':{ensure(typeof body.zoomFactor==='number'&&Number.isFinite(body.zoomFactor)&&body.zoomFactor>=.25&&body.zoomFactor<=3,'缩放范围是 25%–300%');const previous=wc.getZoomFactor();wc.setZoomFactor(body.zoomFactor);await this.pageAudit(r,{type:'page-zoom',source:'ui',pageId:page.pageId,navigationGeneration:page.navigationGeneration,data:{previous,zoomFactor:body.zoomFactor}});break;}
      case 'dialog':{const pending=page.dialog;ensure(pending&&pending.id===body.dialogId,'站点对话框已变化',409);if(body.accept)await pending.value.accept(body.text);else await pending.value.dismiss();if(page.dialog===pending)page.dialog=undefined;break;}
      default:ensure(false,'未知浏览器操作');
    }
    this.onChanged();return this.browserState();
  }

  async navigate(url:string,p=this.current(),initial=false){ensure(/^https?:\/\//.test(url)||url==='about:blank','Only HTTP(S) and about:blank URLs supported');const r=this.live();if(!initial)ensure(!r.locked&&r.controller==='human'&&!r.ending,'Browser is controlled by automation or locked',409);const lease=r.leaseEpoch;return navigateObserved(p.view.webContents,p.page,url,()=>ensure(this.live()===r&&r.pages.get(p.pageId)===p&&p.targetId===(r.pages.get(p.pageId)?.targetId)&&r.leaseEpoch===lease&&!r.ending&&!this.closing,'Navigation target or ownership changed',409));}

  async navigateHistory(direction:'back'|'forward'|'reload'){
    const r=this.live(),p=this.current();ensure(!r.locked&&r.controller==='human'&&!r.ending,'Browser is controlled by automation or locked',409);
    if(direction==='reload')await p.page.reload();
    else if(direction==='back'){ensure(p.view.webContents.navigationHistory.canGoBack(),'No previous page',409);await p.page.goBack();}
    else{ensure(direction==='forward','Unknown navigation command');ensure(p.view.webContents.navigationHistory.canGoForward(),'No next page',409);await p.page.goForward();}
    return this.browserState();
  }

  protected async closePageContents(p:ManagedPage){
    const contents=this.pageContents(p);if(!contents){this.window.remove(p.view);return;}
    // Keep registry/native ownership until Electron confirms destruction. A
    // beforeunload rejection must leave a visible, usable page in the session.
    await new Promise<void>((resolve,reject)=>{
      let settled=false,cancellationAcknowledged=false;
      let dismissalError:unknown;
      const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);contents.removeListener('destroyed',destroyed);contents.removeListener('will-prevent-unload',prevented);p.page.off('dialog',beforeUnloadDialog);if(error)reject(error);else resolve();};
      const destroyed=()=>finish();
      const preventedError=(detail='')=>{const error=new StudioError(409,'page_close_prevented','The page prevented closing; its live session is retained'+detail+(dismissalError?'; dialog response diagnostic: '+String(dismissalError):''));if(dismissalError)error.cause=dismissalError;return error;};
      const prevented=()=>{
        if(cancellationAcknowledged)return;cancellationAcknowledged=true;
        // Native events and the observer socket arrive on separate channels.
        // Drain one read response before allowing another close: a late dialog
        // notification from this cancellation must not become the next attempt.
        void p.page.mainFrame().evaluate(()=>document.readyState).then(()=>finish(preventedError()),error=>finish(preventedError('; observer readiness check failed: '+String(error))));
      };
      // The permanent Puppeteer observer enables CDP Page. Chromium may route
      // beforeunload through javascriptDialogOpening and await its response,
      // before Electron can report will-prevent-unload. Dismiss only this close
      // attempt's beforeunload dialog (cancel closing), never arbitrary dialogs.
      const beforeUnloadDialog=(dialog:Dialog)=>{
        if(dialog.type()!=='beforeunload'||cancellationAcknowledged)return;
        // This close attempt owns its cancellation. Navigation beforeunload
        // prompts outside this scope remain visible for an explicit response.
        if(p.dialog?.value===dialog)p.dialog=undefined;
        // Electron may already have cancelled before this CDP response arrives.
        // Keep any rejection as evidence while awaiting the native outcome;
        // neither a stale dialog nor a protocol failure proves close success.
        void dialog.dismiss().then(prevented,error=>{dismissalError=error;});
      };
      const timer=setTimeout(()=>finish(cancellationAcknowledged?preventedError('; observer readiness was not confirmed within 5 seconds'):new StudioError(409,'page_close_timeout','The page did not confirm closing within 5 seconds; its live session is retained'+(dismissalError?'; dialog response failed: '+String(dismissalError):''))),5000);
      contents.once('destroyed',destroyed);contents.once('will-prevent-unload',prevented);p.page.on('dialog',beforeUnloadDialog);
      try{contents.close({waitForBeforeUnload:true});}catch(error){finish(error);}
    });
  }

  async saveProfile(){const r=this.live(),profile=this.profiles.find(p=>p.id===r.profileId)!;await r.session.cookies.flushStore();r.session.flushStorageData();const p=await this.management.commitProfileState(profile.id,profile.configRevision??0,{savedAt:now(),loginStatus:'unknown'});if(this.active===r)await r.store!.appendEvent({type:'profile-saved',source:'studio',data:{profileId:p.id,loginStatus:'unknown',scope:'persistent cookies/localStorage/IndexedDB; memory/sessionStorage not guaranteed'}});return p;}

}
