import { mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser, type BrowserContext, type CDPSession, type Page } from 'puppeteer-core';
import { StudioCore, type ManagedPage, type SessionRuntime } from '../main/services/studio-core';
import type { ChromiumPageIdentity } from '@/capture/coordinator';
import { ChromiumPresentation, type ChromiumView } from './chromium-presentation';
import { childEnvironment } from './environment';
import { CHROMIUM_PROTOCOL_TIMEOUT_MS, closeOwnedChromium } from './owned-process';
import { assertProfileProvider, type RuntimeDownloads } from '../main/browser/runtime';
import type { Profile } from '../main/services/workspace-management';
import { browserUrl, type BrowserCommand } from '../main/browser/browser-controls';
import { captureError } from '@/capture/url-privacy';
import type { NodeExecutionPolicy, NodeOwnerSessionIdentity } from '@/contracts/node-owner';
import type { HumanRequest } from '@/contracts/workflow';
import type { ProtocolCommand } from '@/runner/gate';
import { ensure, now, StudioError } from '@/shared/errors';

interface ChromiumSession { browser:Browser;context:BrowserContext;browserInstanceId:ReturnType<typeof randomUUID>;userDataDir:string;version:string;userAgent:string;closing:boolean;control:CDPSession;abort:AbortController;failedTargets:Set<string>;startupPage?:Page;closeTask?:Promise<void>;released?:boolean;forcedTermination?:boolean;forcedTerminationRecorded?:boolean }
type Runtime=SessionRuntime<ChromiumPageIdentity,ChromiumView,ChromiumSession>;
type RuntimePage=ManagedPage<ChromiumPageIdentity,ChromiumView>;
const deniedDownloads:RuntimeDownloads={list:()=>[],beginRecording:()=>{},finishRecording:async()=>{},dispose:async()=>{},cancel:()=>{throw new Error('Downloads are denied in this provider');},location:()=>{throw new Error('Downloads are denied in this provider');}};
/** Dedicated Chromium lifecycle. All domain uses, evidence, sources and execution settlement are inherited unchanged. */
export class ChromiumStudio extends StudioCore<ChromiumPageIdentity,ChromiumView,ChromiumSession> {
  readonly runtimeProvider='chromium' as const;
  readonly replayHost={close:()=>undefined}; // Web replay is owned by the isolated shared replay transport.
  declare readonly window:ChromiumPresentation;
  private provider?:ChromiumSession;
  private pendingOwned?:{browser:Browser;abort:AbortController};
  private launchAbort?:AbortController;
  private closingTask?:Promise<void>;
  private managedTargets=new Set<string>();
  private creating=0;
  private lifecycleAbort=new AbortController();
  private ownerEpoch=0;
  private ownerOperationEpoch?:number;
  private recoveringSession?:string;
  private forcedTerminations=0;
  private recoveryTask?:{identity:string;promise:Promise<{closed:true;sessionId:string;recordingId?:string;status:'interrupted';cleanupFailures:number}>};
  async ownerOperation<T>(work:()=>Promise<T>):Promise<T>{
    ensure(!this.recoveringSession,'Interrupted browser recovery is in progress',409);
    ensure(this.ownerOperationEpoch===undefined,'A local owner operation is already active',409);const epoch=this.ownerEpoch;this.ownerOperationEpoch=epoch;
    try{const result=await work();ensure(epoch===this.ownerEpoch,'Owner operation was cancelled',409);return result;}finally{if(this.ownerOperationEpoch===epoch)this.ownerOperationEpoch=undefined;}
  }
  private navigationIntents=new Map<string,{url:string;leaseEpoch:number;expiresAt:number}>();
  private navigationChains=new Map<string,{url:string;leaseEpoch:number}>();
  readonly executionPolicy:Readonly<NodeExecutionPolicy>;
  constructor(root:string,applicationPath:string,private readonly options:{executablePath:string;headless:boolean;devCooperativeInput?:boolean}){
    super(root,new ChromiumPresentation(options.devCooperativeInput===true),'',applicationPath);
    ensure(!(options.devCooperativeInput&&options.headless),'Cooperative DEV/TEST execution requires headed Chromium');
    this.executionPolicy=Object.freeze({executionMode:options.devCooperativeInput===true?'cooperative-dev-test':'disabled',inputIsolation:'none',physicalInputExclusive:false,interferenceDetection:'partial',humanHandoff:'unsupported'});
  }
  override async validate(body:any,options:{signal?:AbortSignal;requireGrant?:boolean}={}){
    // Apply before shared validation can seal the user's recording, create an
    // execution run, or claim its page. An RPC body cannot enable this policy.
    ensure(this.executionPolicy.executionMode==='cooperative-dev-test','Interactive Node execution requires the launch-time --dev-cooperative-input opt-in',409);
    this.assertHealthyProvider();
    return super.validate(body,options);
  }
  private assertHealthyProvider(){
    ensure(!this.recoveringSession&&!this.provider?.failedTargets.size,'A renderer crashed. End the interrupted session to close all owned pages before recording, sealing, or starting another execution.',409);
    ensure(!this.provider||this.provider.browser.connected&&!this.provider.closing,'Chromium is disconnected. End the interrupted session before recording, sealing, or starting another execution.',409);
  }
  override async startRun(...args:Parameters<StudioCore<ChromiumPageIdentity,ChromiumView,ChromiumSession>['startRun']>){this.assertHealthyProvider();return super.startRun(...args);}
  override async seal(...args:Parameters<StudioCore<ChromiumPageIdentity,ChromiumView,ChromiumSession>['seal']>){this.assertHealthyProvider();return super.seal(...args);}
  protected override async beginHuman(_request:HumanRequest,_owner:'runner'|'agent',_pageId:string,_signal?:AbortSignal):Promise<never>{
    throw new StudioError(409,'unsupported_human_handoff','Human handoff is unsupported in this Node DEV/TEST surface. Stop the workflow, interact manually, then start a new current-page test.');
  }
  protected override gateCommand(page:RuntimePage,command:Readonly<ProtocolCommand>){
    if(command.method==='Page.navigate'&&typeof command.params?.url==='string')this.noteNavigation(page,command.params.url);
    if(command.method==='Page.reload')this.noteNavigation(page,page.page.url());
  }
  private noteNavigation(page:RuntimePage,url:string){url=new URL(url).href;const runtime=this.browser?.runtime;if(runtime?.pages.get(page.pageId)===page)this.navigationIntents.set(page.pageId,{url,leaseEpoch:runtime.leaseEpoch,expiresAt:Date.now()+5000});}
  private ownsNavigation(page:RuntimePage,url:string,consume=true){url=new URL(url).href;const runtime=this.browser?.runtime,intent=this.navigationIntents.get(page.pageId);if(!runtime||!intent||intent.url!==url||intent.leaseEpoch!==runtime.leaseEpoch||intent.expiresAt<Date.now())return false;if(consume)this.navigationIntents.delete(page.pageId);return true;}
  private unownedNavigation(page:RuntimePage){const runtime=this.browser?.runtime;if(!runtime||runtime.pages.get(page.pageId)!==page||runtime.controller!=='agent')return;runtime.locked=true;runtime.leaseEpoch++;this.window.lock(true);
    // Revoke synchronously, but do not await worker/report/capture settlement in
    // a paused Fetch request: that settlement can depend on this navigation.
    this.workflowStarting?.gate?.close();this.validationLaunch?.abort.abort(new Error('Observed unmatched browser navigation'));
    void this.revokeOperation(runtime).catch(()=>{});void this.workflow?.cancel('Observed unmatched browser navigation').catch(()=>{});
    this.browserNotice='观察到未匹配执行意图的导航，已请求取消执行并保留诊断；此检查不能发现所有人工干扰。';if(this.active===runtime)void runtime.store!.appendEvent({type:'gap',source:'chromium',pageId:page.pageId,data:{reason:'unowned-browser-navigation',attribution:'observed-unmatched-navigation',interferenceDetection:'partial'}}).catch(()=>{});void this.stopRunner().catch(()=>{});this.onChanged();}
  protected override workerEnvironment(){return childEnvironment();}
  protected async providerSession(profile:Profile):Promise<ChromiumSession>{
    const epoch=this.ownerOperationEpoch??this.ownerEpoch;ensure(epoch===this.ownerEpoch,'Owner cancelled browser startup',409);
    assertProfileProvider(profile,'chromium');ensure(!this.provider&&!this.launchAbort&&!this.pendingOwned,'A Chromium environment is already open, starting, or awaiting confirmed process cleanup',409);
    ensure(profile.storageRef===`chromium:${profile.id}`,'Chromium storage reference does not match its profile identity',409);
    const parent=path.join(this.root,'chromium-profiles');
    await mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const parentInfo=await lstat(parent);ensure(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink()&&await realpath(parent)===parent,'Chromium profile parent must not be a symlink');
    const userDataDir=path.join(parent,profile.id);
    await mkdir(userDataDir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(userDataDir);
    ensure(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(userDataDir)===userDataDir,'Dedicated Chromium profile path must not be a symlink');
    ensure(epoch===this.ownerEpoch,'Owner cancelled browser startup',409);const abort=new AbortController();this.launchAbort=abort;let browser:Browser|undefined,providerStage='launch';
    try{
      this.lifecycleAbort.signal.throwIfAborted();
      browser=await puppeteer.launch({executablePath:this.options.executablePath,headless:this.options.headless,userDataDir,defaultViewport:null,
        env:childEnvironment(),handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,timeout:20000,protocolTimeout:CHROMIUM_PROTOCOL_TIMEOUT_MS,
        args:['--no-first-run','--no-default-browser-check','--disable-backgrounding-occluded-windows'],
        signal:abort.signal,networkEnabled:false});
      this.pendingOwned={browser,abort};
      this.lifecycleAbort.signal.throwIfAborted();abort.signal.throwIfAborted();ensure(epoch===this.ownerEpoch,'Owner cancelled browser startup',409);
      providerStage='browser-control';const context=browser.defaultBrowserContext(),control=await browser.target().createCDPSession();
      await control.send('Browser.setDownloadBehavior',{behavior:'deny'});
      providerStage='permission-policy';await control.send('Browser.grantPermissions',{permissions:[]});
      providerStage='browser-metadata';const provider:ChromiumSession={browser,context,browserInstanceId:randomUUID(),userDataDir,version:await browser.version(),userAgent:await browser.userAgent(),closing:false,control,abort,failedTargets:new Set()};
      providerStage='observer-connect';this.endpoint=browser.wsEndpoint();
      this.observer=await puppeteer.connect({browserWSEndpoint:this.endpoint,defaultViewport:null,networkEnabled:true,protocolTimeout:CHROMIUM_PROTOCOL_TIMEOUT_MS});
      providerStage='startup-page-adoption';
      const startupPages=await this.observer.pages();
      provider.startupPage=startupPages.find(page=>page.url()==='about:blank')??await this.observer.newPage();
      // Never close Chromium's last window before the first managed page exists.
      // Keep one verified blank target and adopt that exact target into capture.
      for(const page of startupPages)if(page!==provider.startupPage)await page.close();
      ensure(epoch===this.ownerEpoch,'Owner cancelled browser startup',409);this.provider=provider;this.pendingOwned=undefined;this.managedTargets.clear();
      this.observer.on('targetcreated',target=>{if(target.type()!=='page')return;void (async()=>{
        const page=await target.page();if(!page)return;const cdp=await page.createCDPSession();let targetId:string;try{targetId=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await cdp.detach();}
        // newPage target arrives before its own continuation. Give the sole host creation its registration turn.
        for(let count=0;this.creating&&count<200;count++)await new Promise(resolve=>setTimeout(resolve,10));
        if(this.managedTargets.has(targetId)||provider.closing||this.provider!==provider)return;
        await page.close();this.browserNotice='未受管的新标签或弹窗已拒绝；请使用工作台的新标签按钮。';
        if(this.active&&this.active.session===provider)await this.active.store.appendEvent({type:'gap',source:'chromium',data:{reason:'unmanaged-popup-rejected',targetId}});
        this.onChanged();
      })().catch(error=>{if(!provider.closing)console.error('Chromium target registration failed',String(error));});});
      browser.on('disconnected',()=>{if(provider.closing||this.provider!==provider)return;this.browserNotice='专用 Chromium 已断开。录制保留为中断状态，请停止并重新打开环境。';
        const runtime=this.browser?.runtime;if(runtime){runtime.capture='degraded';runtime.locked=true;runtime.leaseEpoch++;void this.stopRunner().catch(()=>{});}
        this.onChanged();});
      return provider;
    }catch(error){this.observer?.disconnect();if(browser)try{await closeOwnedChromium(browser,abort);if(this.pendingOwned?.browser===browser)this.pendingOwned=undefined;}catch{/* Preserve the startup error; unconfirmed ownership remains tracked for shutdown. */}if(error&&typeof error==='object')Object.assign(error,{providerStage});throw error;}finally{if(this.launchAbort===abort)this.launchAbort=undefined;}
  }
  private async terminateProviderProcess(session:ChromiumSession){
    if(session.released)return;
    if(session.closeTask)return session.closeTask;
    session.closing=true;
    const closing=session.closeTask=(async()=>{
      // Only the process handle returned by this provider's own launch is used.
      this.observer?.disconnect();
      const {forced}=await closeOwnedChromium(session.browser,session.abort);session.forcedTermination=forced;if(forced)this.forcedTerminations++;
      session.abort.abort();session.released=true;
    })();
    try{await closing;}catch(error){session.closing=false;if(session.closeTask===closing)session.closeTask=undefined;throw error;}
  }
  protected async releaseProviderSession(session:ChromiumSession){
    await this.terminateProviderProcess(session);
    if(session.forcedTermination&&!session.forcedTerminationRecorded){
      await this.sessionAudit('provider-forced-termination',{browserInstanceId:session.browserInstanceId,profilePersistence:'unconfirmed'},this.browserSessionId??session.browserInstanceId);session.forcedTerminationRecorded=true;
    }
    if(this.provider===session){this.provider=undefined;this.endpoint='';this.managedTargets.clear();this.navigationIntents.clear();this.navigationChains.clear();}
  }

  protected configurePermissions(_session:ChromiumSession){}
  protected installNavigationPolicy(_session:ChromiumSession){} // Every managed page owns its request interception.
  protected providerEnvironment(session:ChromiumSession){return {provider:'chromium',browserInstanceId:session.browserInstanceId,policy:'dedicated-chromium-v1',executionPolicy:this.executionPolicy,userAgent:session.userAgent,chromiumVersion:session.version,clientHintsPolicy:'native-chromium',automationControlled:'default'};}
  protected async ensureDownloads(){this.browserDownloads??=deniedDownloads;}
  protected pageContents(page:RuntimePage){return page.page.isClosed()?undefined:page.view;}
  private scalarIdentity(page:RuntimePage):ChromiumPageIdentity{return {provider:'chromium',browserInstanceId:page.browserInstanceId,pageId:page.pageId,targetId:page.targetId,navigationGeneration:page.navigationGeneration,...(page.openerPageId?{openerPageId:page.openerPageId}:{})};}
  protected hostIdentity(page:RuntimePage){return {provider:'chromium' as const,browserInstanceId:page.browserInstanceId};}
  protected screenshot(page:RuntimePage){return page.page.screenshot({type:'png',captureBeyondViewport:false});}
  protected stopPage(page:RuntimePage){if(!page.page.isClosed())void page.view.cdp.send('Page.stopLoading').catch(()=>{});}
  protected async addPage(runtime:Runtime,openerPageId?:string,_existing?:ChromiumView,activate=true):Promise<RuntimePage>{
    const owner=this.browser!,epoch=this.ownerOperationEpoch??this.ownerEpoch;ensure(epoch===this.ownerEpoch,'Owner cancelled page creation',409);const previous=runtime.selectedPageId;this.creating++;
    let page:Page|undefined,registered:RuntimePage|undefined;
    try{
      ensure(this.provider===runtime.session&&!runtime.session.closing,'Browser session has ended',409);
      page=runtime.session.startupPage??await this.observer.newPage();runtime.session.startupPage=undefined;ensure(page.url()==='about:blank','New managed page must begin at the pre-capture blank boundary',409);const cdp=await page.createCDPSession();
      const targetId=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;this.managedTargets.add(targetId);
      const identity:ChromiumPageIdentity={provider:'chromium',browserInstanceId:runtime.session.browserInstanceId,pageId:randomUUID(),targetId,navigationGeneration:0,openerPageId};
      const view:ChromiumView={page,cdp,title:'',loading:false,back:false,forward:false,inputBlocked:false,
        getURL:()=>page!.url(),getTitle:()=>view.title,isLoadingMainFrame:()=>view.loading,getZoomFactor:()=>1,
        navigationHistory:{canGoBack:()=>view.back,canGoForward:()=>view.forward}};
      registered=Object.assign(identity,{page,view,lastUrl:page.url()});const p=registered;
      this.window.add(view);this.window.lock(true);await this.window.awaitInput();
      await page.setRequestInterception(true);
      page.on('request',request=>{void (async()=>{
        if(request.isInterceptResolutionHandled())return;const navigation=request.isNavigationRequest(),url=request.url();
        let allowed=!navigation||((/^https?:\/\//.test(url)||url==='about:blank')&&this.navigationAllowed(url));
        const live=owner.runtime;
        if(allowed&&navigation&&request.frame()===page!.mainFrame()&&live.controller==='agent'){
          // Renderer navigation intent and network events use independent sessions; drain one event turn before matching.
          await new Promise(resolve=>setTimeout(resolve,0));
          const chain=this.navigationChains.get(p.pageId);
          allowed=this.ownsNavigation(p,url)||(chain?.leaseEpoch===live.leaseEpoch&&request.redirectChain().some(previous=>previous.url()===chain.url));
          if(allowed&&!request.redirectChain().length)this.navigationChains.set(p.pageId,{url,leaseEpoch:live.leaseEpoch});
          if(!allowed){this.unownedNavigation(p);if(this.executionPolicy.executionMode==='cooperative-dev-test')allowed=true;}
        }
        if(!request.isInterceptResolutionHandled())await (allowed?request.continue():request.abort('blockedbyclient'));
      })().catch(()=>{});});
      cdp.on('Page.frameRequestedNavigation',event=>{if(event.frameId===(page!.mainFrame() as any)._id)this.noteNavigation(p,event.url);});
      cdp.on('Page.navigatedWithinDocument',event=>{if(event.frameId!==(page!.mainFrame() as any)._id||owner.runtime.controller!=='agent')return;
        if(event.navigationType!=='historyApi'&&!this.ownsNavigation(p,event.url))this.unownedNavigation(p);
      });
      const refresh=async()=>{if(page!.isClosed())return;try{const history=await cdp.send('Page.getNavigationHistory');view.back=history.currentIndex>0;view.forward=history.currentIndex<history.entries.length-1;view.title=await page!.title();}catch{/* A closing target has no usable status. */}this.onChanged();};
      page.on('framenavigated',frame=>{if(frame===page!.mainFrame()){identity.navigationGeneration++;p.lastUrl=page!.url();void refresh();this.onChanged();}});
      page.on('requestfailed',request=>{if(request.isNavigationRequest()&&request.frame()===page!.mainFrame()){p.loadError={kind:'network',url:request.url(),message:request.failure()?.errorText??'Navigation failed'};this.onChanged();}});
      cdp.on('Page.frameStartedLoading',()=>{view.loading=true;this.onChanged();});cdp.on('Page.frameStoppedLoading',()=>{view.loading=false;void refresh();});await cdp.send('Page.enable');
      page.on('dialog',dialog=>{p.dialog={id:randomUUID(),value:dialog};this.browserNotice='站点对话框需要处理；本阶段会拒绝对话框并保留诊断。';void dialog.dismiss().finally(()=>{if(p.dialog?.value===dialog)p.dialog=undefined;this.onChanged();}).catch(()=>{});});
      page.on('error',error=>{if(this.provider!==runtime.session||runtime.session.closing)return;runtime.session.failedTargets.add(p.targetId);p.capture?.documentDestroyed();p.loadError={kind:'renderer',url:p.lastUrl??'',message:String(error)};const live=owner.runtime;live.capture='degraded';this.browserNotice='受控页面的渲染进程已崩溃。请结束中断会话；这会关闭本会话的全部页面并保留中断原件。';if(this.active===live)void live.store!.appendEvent({type:'gap',source:'chromium',pageId:p.pageId,data:{reason:'renderer-crashed',targetId:p.targetId,finalEmissionLost:true}}).catch(()=>{});void this.stopRunner().catch(()=>{});this.onChanged();});
      page.once('close',()=>{this.managedTargets.delete(targetId);this.navigationIntents.delete(p.pageId);this.navigationChains.delete(p.pageId);if(owner.runtime.pages.get(p.pageId)===p){this.pageDestroyed(owner.runtime,view,this.scalarIdentity(p),p);if(['running','waiting-human','finalizing'].includes(owner.runtime.execution))void this.stopRunner().catch(()=>{});}});
      runtime.pages.set(p.pageId,p);if(activate)runtime.selectedPageId=p.pageId;
      if(this.active===runtime){p.capture=this.createCapture(this.active,p);await p.capture.start();
        ensure(!page.isClosed()&&owner.runtime===runtime&&!runtime.ending,'Capture target changed during setup',409);
        await runtime.store!.appendEvent({type:'page-registered',source:'chromium',pageId:p.pageId,data:{...this.scalarIdentity(p),appInstanceId:this.instanceId,browserSessionId:owner.id}});
        if(activate)await this.recordForeground(this.active,previous||null,'page-created');}
      ensure(epoch===this.ownerEpoch&&this.browser===owner&&owner.runtime===runtime&&!runtime.ending&&!this.closing,'Browser session changed during page initialization',409);
      if(activate)this.window.show(view);await refresh();return p;
    }catch(error){if(registered){runtime.pages.delete(registered.pageId);await registered.capture?.stop().catch(()=>{});this.window.remove(registered.view);}await page?.close().catch(()=>{});if(!runtime.pages.has(runtime.selectedPageId))runtime.selectedPageId=runtime.pages.has(previous)?previous:'';throw error;}
    finally{this.creating--;if(this.browser===owner)this.window.lock(owner.runtime.locked||owner.runtime.controller!=='human');await this.window.awaitInput();this.onChanged();}
  }
  protected loadHumanUrl(page:RuntimePage,input:string){const url=browserUrl(input);ensure(this.navigationAllowed(url),'Navigation outside authorized origins',403);page.loadError=undefined;
    void page.page.goto(url,{waitUntil:'load',timeout:15000}).catch(error=>{if(!page.page.isClosed()){page.loadError={kind:'network',url,message:String(error)};this.onChanged();}});}
  async navigate(url:string,page=this.current(),initial=false){
    url=browserUrl(url);const runtime=this.live(),epoch=runtime.leaseEpoch;
    ensure(initial||runtime.controller==='human'&&!runtime.locked&&!runtime.ending,'Browser is controlled or locked',409);
    ensure(this.navigationAllowed(url),'Navigation outside authorized origins',403);
    await page.page.goto(url,{waitUntil:'load',timeout:15000});
    ensure(this.browser?.runtime===runtime&&runtime.pages.get(page.pageId)===page&&runtime.leaseEpoch===epoch&&!runtime.ending&&!this.closing,'Navigation target or ownership changed',409);
    return {url:page.page.url()};
  }
  async navigateHistory(direction:string){const runtime=this.live(),page=this.current();ensure(runtime.controller==='human'&&!runtime.locked,'Browser is controlled or locked',409);
    if(direction==='back')await page.page.goBack();else if(direction==='forward')await page.page.goForward();else if(direction==='reload')await page.page.reload();else ensure(false,'Unknown navigation direction');return this.state();}
  async browserCommand(body:BrowserCommand){
    const runtime=this.live();ensure(body.sessionId===this.browserSessionId&&body.leaseEpoch===runtime.leaseEpoch&&runtime.controller==='human'&&!runtime.locked&&!runtime.ending&&!runtime.stopping,'Browser ownership changed',409);
    const page=runtime.pages.get(body.pageId??'');
    if(body.command==='new'){const created=await this.addPage(runtime,runtime.selectedPageId||undefined);runtime.leaseEpoch++;this.loadHumanUrl(created,body.url??'about:blank');}
    else {ensure(page&&body.targetId===page.targetId&&body.generation===page.navigationGeneration,'Page identity or generation changed',409);
    if(body.command==='select')await this.selectPage(page.pageId);
    else if(body.command==='close')return this.closePage(page.pageId);
    else{ensure(page.pageId===runtime.selectedPageId,'Command requires selected page',409);
      if(body.command==='navigate')this.loadHumanUrl(page,body.url??'');
      else if(body.command==='reload')this.loadHumanUrl(page,page.page.url());
      else if(body.command==='back'||body.command==='forward')void this.navigateHistory(body.command).catch(error=>{this.browserNotice=String(error);this.onChanged();});
      else if(body.command==='stop')await page.view.cdp.send('Page.stopLoading');
      else ensure(false,'This Chromium control is not supported',422);}}
    this.onChanged();return this.browserState();
  }
  protected async closePageContents(page:RuntimePage){
    if(page.page.isClosed()){this.window.remove(page.view);return;}
    if(this.provider?.failedTargets.has(page.targetId))await this.provider.control.send('Target.closeTarget',{targetId:page.targetId});
    else await page.page.close({runBeforeUnload:true});
    if(!page.page.isClosed())await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{page.page.off('close',closed);reject(new StudioError(409,'page_close_prevented','Page did not confirm closure; session retained'));},5000);const closed=()=>{clearTimeout(timer);resolve();};page.page.once('close',closed);});
  }
  async saveProfile(){const runtime=this.live(),profile=this.profiles.find(item=>item.id===runtime.profileId)!;
    ensure(!runtime.locked&&runtime.controller==='human','Profile save requires human control',409);
    // CDP has no durable flush acknowledgement equivalent to Electron. A clean session close is the persistence boundary.
    return {profileId:profile.id,persistence:'close-required',message:'Close the environment normally to flush Chromium profile storage.'};}
  override async closeSession(){const provider=this.provider;const result=await super.closeSession();return {...result,closed:true as const,profilePersistence:provider?.forcedTermination?'unconfirmed' as const:'flushed' as const,...(provider?.forcedTermination?{warning:'Chromium required forced termination. Profile storage flush is unconfirmed; inspect the environment after reopening.'}:{})};}
  get providerStatus():'not-open'|'connected'|'disconnected'|'renderer-failed'{return !this.provider?'not-open':!this.provider.browser.connected?'disconnected':this.provider.failedTargets.size?'renderer-failed':'connected';}
  get providerTerminated(){return !this.pendingOwned&&(!this.provider||this.provider.released===true);}
  async endInterruptedSession(body:NodeOwnerSessionIdentity){
    const identity=JSON.stringify([body.projectId,body.profileId,body.sessionId,body.leaseEpoch]);
    if(this.recoveryTask){ensure(this.recoveryTask.identity===identity,'Another interrupted session recovery is active',409);return this.recoveryTask.promise;}
    const promise=this.endInterruptedOwned(body);this.recoveryTask={identity,promise};
    try{return await promise;}finally{if(this.recoveryTask?.promise===promise)this.recoveryTask=undefined;this.recoveringSession=undefined;this.onChanged();}
  }
  private async endInterruptedOwned(body:NodeOwnerSessionIdentity){
    const owner=this.browser,provider=this.provider;
    ensure(owner&&provider&&owner.runtime.session===provider,'No owned Chromium environment to recover',409);
    const initial=owner.runtime;
    ensure(body.projectId===initial.projectId&&body.profileId===initial.profileId&&body.sessionId===owner.id&&body.leaseEpoch===initial.leaseEpoch,'Interrupted session identity changed',409);
    ensure((!provider.browser.connected||provider.failedTargets.size>0)&&(!provider.closing||provider.released),'Only a backend-confirmed disconnected or renderer-crashed Chromium environment can be ended as interrupted',409);
    const reason=provider.failedTargets.size?'renderer-crashed':'provider-process-disconnected';
    const failedTargets=[...provider.failedTargets];
    this.recoveringSession=owner.id;++this.ownerEpoch;initial.locked=true;initial.leaseEpoch++;
    this.launchAbort?.abort(new Error('Interrupted session ending'));this.validationLaunch?.abort.abort(new Error('Interrupted session ending'));
    const stopping=super.stopRunner();void stopping.catch(()=>{});this.onChanged();
    // A transport disconnect alone does not prove a dead process. Join the exact
    // owned process before treating retained page documents as destroyed.
    await this.terminateProviderProcess(provider);
    for(const page of owner.runtime.pages.values())page.capture?.documentDestroyed();
    await stopping;await this.queue.catch(()=>{});
    ensure(this.browser===owner&&this.provider===provider&&!provider.browser.connected,'Interrupted environment changed during shutdown',409);
    ensure(!this.workflow&&!this.workflowStarting&&!this.workflowSettlement&&!this.validationLaunch,'Worker shutdown has not completed',409);
    const runtime=owner.runtime;
    runtime.ending=true;runtime.locked=true;runtime.leaseEpoch++;
    const failures:Array<{stage:string;name:string;message:string;code?:string}>=[];
    const attempt=async(stage:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){const details=captureError(error);failures.push({stage,...details,message:details.message.replace(/wss?:\/\/[^\s'"<>]+/gi,'[private browser endpoint]')});}};
    const recording=this.active;
    if(recording){
      ensure(recording===runtime,'Interrupted recording belongs to another session',409);
      await attempt('downloads',()=>recording.stopDownloads?.()??Promise.resolve());
      for(const work of [...(recording.pageClosures??[])])await attempt('page-closure',()=>work);
      for(const page of [...recording.pages.values()])await attempt(`capture:${page.pageId}`,()=>page.capture?.stop()??Promise.resolve());
      // Durable state, not a synthesized successful seal: raw records are retained
      // exactly as written, and final source emission can no longer be proved.
      await recording.store.appendEvent({type:'recovery.gap',source:'chromium',data:{reason,browserInstanceId:provider.browserInstanceId,browserSessionId:owner.id,failedTargets,forcedTermination:provider.forcedTermination===true,finalEmissionLost:true,cleanupFailures:failures}});
      await recording.store.updateManifest({status:'interrupted',capture:'degraded',execution:'interrupted',interruptionReason:reason});
      await recording.store.close();
      this.runs=this.runs.map(item=>item.id===recording.id?recording.store.manifest:item);
      owner.detach(recording.id);this.active=undefined;
    }else await this.sessionAudit('interrupted-session-ended',{reason,browserInstanceId:provider.browserInstanceId,failedTargets,forcedTermination:provider.forcedTermination===true},owner.id);
    await this.browserDownloads?.dispose();this.browserDownloads=undefined;
    // Browser.close owns the launched process and waits for process termination.
    // Do not expose a reusable profile while that close has not succeeded.
    await this.releaseProviderSession(provider);
    for(const page of [...runtime.pages.values()])this.window.remove(page.view);runtime.pages.clear();
    this.browser=undefined;this.browserAuthorizationId=undefined;this.closedPages=[];this.browserNotice=undefined;this.window.show(undefined);this.window.lock(false);await this.window.awaitInput();this.onChanged();
    return {closed:true as const,sessionId:owner.id,...(recording?{recordingId:recording.id}:{}),status:'interrupted' as const,cleanupFailures:failures.length};
  }
  async cancelOwnerOperations(){
    ++this.ownerEpoch;this.launchAbort?.abort(new Error('Owner access ended during browser launch'));
    for(const page of this.browser?.runtime.pages.values()??[])this.stopPage(page);
    await this.stopRunner();await this.queue.catch(()=>{});
    if(this.active&&!this.active.ending){await this.pauseCapture(true);this.onChanged();}
    await this.window.awaitInput();
  }
  override async stopRunner(){const result=await super.stopRunner();await this.window.awaitInput();return result;}
  override async close(){if(this.closingTask)return this.closingTask;this.lifecycleAbort.abort(new Error('Node application closing'));this.launchAbort?.abort();
    const forcedBefore=this.forcedTerminations;
    for(const page of this.browser?.runtime.pages.values()??[])this.stopPage(page);
    this.closingTask=(async()=>{try{
      if(this.pendingOwned){await closeOwnedChromium(this.pendingOwned.browser,this.pendingOwned.abort);this.pendingOwned=undefined;}
      // Dead-renderer CDP work cannot be drained by waiting on the renderer.
      // Tear down the exact owned process first; pending capture calls reject.
      if(this.provider&&(!this.provider.browser.connected||this.provider.failedTargets.size)){await this.terminateProviderProcess(this.provider);for(const page of this.browser?.runtime.pages.values()??[])page.capture?.documentDestroyed();}
      await this.recoveryTask?.promise;await super.close();
    }finally{if(this.provider)await this.releaseProviderSession(this.provider);}
    ensure(this.forcedTerminations===forcedBefore,'Chromium required forced termination during shutdown; profile storage flush is unconfirmed',409);
    })();return this.closingTask;}
}
