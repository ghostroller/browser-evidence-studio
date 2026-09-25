import type { Page, CDPSession } from 'puppeteer-core';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from '@/evidence/store';
import recorder from '../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';
import { RequestLedger, type CapturedRequest } from './request-ledger';
import { readyMainObserverContexts } from './observer-contexts';
import { captureRequestBody, redactHeaders as redact, requestMetadata, REQUEST_BODY_LIMIT } from './request-body';
import { instrumentRecorder, RRWEB_ADAPTER_VERSION } from './rrweb-adapter';
import { installSourceRecorder } from './source-recorder';
import { RecordingIndexWriter } from '@/replay/archive';
import type { RecordingEnvelope } from './recording-types';
import type { ReplayPosition } from '@/contracts/recording';
import { CaptureBudget, type CaptureChannel } from './budget';
import { ResourceCapture, isArchivableResource, privateResourceUrl, RESOURCE_MAX_BYTES } from '@/resources/archive';

export interface PageIdentity { pageId:string; targetId:string; webContentsId:number; navigationGeneration:number; openerPageId?:string; }
const BODY_LIMIT = 8 * 1024 * 1024;

export class CaptureCoordinator {
  private cdp!: CDPSession;
  private pending = new Set<Promise<unknown>>();
  private readonly requests:RequestLedger;
  private contexts = new Map<number,string>();
  private paused = false;
  private stopped = false;
  private stopComplete = false;
  private stopTask?:Promise<void>;
  private unfinishedOnStop?:CapturedRequest[];
  private pausedStopRecorded = false;
  private documentGone = false;
  private inspectionEnabled = false;
  private drops = 0;
  private pendingBytes = 0;
  private degraded = false;
  private readonly budget = new CaptureBudget();
  private readonly recording: RecordingIndexWriter;
  private readonly resources: ResourceCapture;
  private recoveryNeeded = false;
  private recoveryRunning = false;
  private lastPosition?: ReplayPosition;
  private readonly droppedChannels = new Map<CaptureChannel, number>();
  private readonly losses = new Map<CaptureChannel,{from:ReplayPosition;to:ReplayPosition;count:number}>();
  private readonly fullSnapshots = new Map<number,number>();
  private pauseAt?:string;
  private frameId?:string;
  private scriptId?:string;
  private readonly world = `bes-observer-${randomUUID()}`;
  private readonly binding = `bes_${randomUUID().replace(/-/g,'')}`;
  constructor(readonly page: Page, readonly identity: PageIdentity, readonly store: EvidenceStore, private onSelection: (data:unknown)=>void = ()=>{}, private onDegraded:(reason:string)=>void=()=>{}, private trackNavigationGeneration=true) {this.requests=new RequestLedger(randomUUID(),identity.targetId);this.recording=new RecordingIndexWriter(store);this.resources=new ResourceCapture(store);}
  get health(){return this.degraded?'degraded':this.stopped?'stopped':this.paused?'paused':'recording';}
  get inspecting(){return this.inspectionEnabled;}
  documentDestroyed(){this.documentGone=true;this.inspectionEnabled=false;}
  private fail(reason:string){if(this.degraded)return;this.degraded=true;this.onDegraded(reason);}
  get recordingPosition(){return this.lastPosition && {...this.lastPosition};}
  get queueMetrics(){return this.budget.snapshot();}
  private task(work: ()=>Promise<unknown>,estimatedBytes=4096,channel:CaptureChannel='network') {
    if(this.stopped) return false;
    const release=this.budget.reserve(channel,estimatedBytes);
    if(!release) { this.drops++;this.droppedChannels.set(channel,(this.droppedChannels.get(channel)||0)+1);if(channel==='structure'||channel==='metadata')this.recoveryNeeded=true;this.fail('Capture queue reached its bounded '+channel+' budget');return false; }
    this.pendingBytes+=estimatedBytes;
    const p=work().catch(async error=>{this.fail(String(error));await this.store.appendEvent({type:'gap',source:'capture',pageId:this.identity.pageId,data:{reason:String(error),category:channel==='network'?'resource':channel,from:this.lastPosition}}).catch(failure=>{this.fail('Cannot persist capture gap: '+String(failure));});}).finally(()=>{this.pending.delete(p);this.pendingBytes-=estimatedBytes;release();this.recoverSnapshot();});
    this.pending.add(p);
    return true;
  }
  private recoverSnapshot(){
    if(!this.recoveryNeeded||this.recoveryRunning||this.stopped||this.paused||this.pending.size>16)return;
    this.recoveryNeeded=false;this.recoveryRunning=true;
    const task=this.freshSnapshots('structural-backpressure-recovery').catch(error=>this.fail('Recovery snapshot failed: '+String(error))).finally(()=>{this.recoveryRunning=false;});
    // freshSnapshots waits pending, so this promise must not enter that same set.
    void task;
  }
  private async unfinished(requests:CapturedRequest[],reason:string){
    for(const request of requests){const artifact=await this.store.putArtifact({kind:'response-body',mediaType:request.mime||'application/octet-stream',captureStatus:request.streaming?'unknown':'missing',reason,source:{requestKey:request.key,url:request.url,frameId:request.frameId}});await this.event('gap',{reason,requestKey:request.key,url:request.url,startedAt:request.startedAt,endedAt:new Date().toISOString(),streaming:!!request.streaming},[artifact.id]);}
  }
  private event(type:string,data:unknown, artifactRefs?:string[],navigationGeneration=this.identity.navigationGeneration) { return this.store.appendEvent({type,source:'cdp',pageId:this.identity.pageId,navigationGeneration,data,artifactRefs}); }
  async start() {
    this.cdp=await this.page.createCDPSession();
    const cdp=this.cdp as any;
    cdp.on('Runtime.executionContextCreated',({context}:any)=>{ if(context.name===this.world) this.contexts.set(context.id,context.auxData?.frameId); });
    cdp.on('Runtime.executionContextDestroyed',({executionContextId}:any)=>{this.contexts.delete(executionContextId);this.fullSnapshots.delete(executionContextId);});
    cdp.on('Runtime.executionContextsCleared',()=>{this.contexts.clear();this.fullSnapshots.clear();});
    cdp.on('Page.frameNavigated',({frame}:any)=>{ if(!frame.parentId){ this.frameId=frame.id; if(this.trackNavigationGeneration)this.identity.navigationGeneration++; this.inspectionEnabled=false; } if(!this.paused) this.task(()=>this.event('navigation',{frameId:frame.id,url:frame.url,loaderId:frame.loaderId,parentId:frame.parentId})); });
    cdp.on('Runtime.exceptionThrown',(event:any)=>{if(!this.paused) this.task(()=>this.event('page-error',event));});
    cdp.on('Runtime.consoleAPICalled',(event:any)=>{if(!this.paused)this.task(()=>this.event('console',{type:event.type,args:event.args.map((x:any)=>({type:x.type,value:x.value,description:x.description?.slice(0,4000)}))}));});
    cdp.on('Runtime.bindingCalled',(event:any)=>{
      if(event.name!==this.binding||this.paused||this.stopped) return;
      const payloadBytes=Buffer.byteLength(event.payload);if(payloadBytes>16*1024*1024){this.drops++;this.fail('Recorder event exceeds 16 MiB');return;}
      let data;try{data=JSON.parse(event.payload);}catch{this.fail('Malformed recorder payload');return;}
      const source=data.event?.type===3?data.event.data?.source:undefined;
      const channel:CaptureChannel=data.kind!=='rrweb'?'metadata':[1,3,6].includes(source)?'sampling':'structure';
      const accepted=this.task(async()=>{ const frameId=this.contexts.get(event.executionContextId);
        if(data.kind==='rrweb'){
          const losses=[...this.losses].map(([category,range])=>({id:randomUUID(),from:range.from,to:range.to,category:category==='network'?'resource':category,reason:'capture-channel-budget',count:range.count}));this.losses.clear();
          const record:RecordingEnvelope={...data,receivedAt:new Date().toISOString(),gaps:[...losses,...(data.errors??[]).map((reason:string)=>({id:randomUUID(),from:data.position,category:'metadata',reason}))]};
          await this.recording.append(record);this.lastPosition=record.position;
          if(data.event?.type===2){this.fullSnapshots.set(event.executionContextId,(this.fullSnapshots.get(event.executionContextId)||0)+1);await this.event('rrweb-full-snapshot',{frameId,isTop:data.isTop===true,contextId:event.executionContextId,timestamp:data.event.timestamp,position:record.position});}}
        else { await this.event(data.kind,{...data,frameId,actor:'unknown',source:'isolated-world-observer'}); if(data.kind==='element-selected') this.onSelection({...data,frameId,pageId:this.identity.pageId,generation:this.identity.navigationGeneration}); }
      },payloadBytes*3,channel);
      if(!accepted&&data.position){const previous=this.losses.get(channel);this.losses.set(channel,{from:previous?.from??data.position,to:data.position,count:(previous?.count??0)+1});}
    });
    cdp.on('Network.requestWillBeSent',(e:any)=>{
      if(this.paused||this.stopped)return;
      const {current,previous,evicted}=this.requests.begin({requestId:e.requestId,url:e.request.url,frameId:e.frameId,redirect:!!e.redirectResponse});
      const navigationGeneration=this.identity.navigationGeneration;
      const data={requestKey:current.key,requestId:e.requestId,frameId:e.frameId,loaderId:e.loaderId,timestamp:e.timestamp,request:requestMetadata(e.request),redirectHop:current.hop};
      this.task(async()=>{
        // Begin the CDP read before persistence can yield to redirects or reused request IDs.
        const body=captureRequestBody(e.request,{source:{requestKey:current.key,url:current.url,frameId:current.frameId,loaderId:e.loaderId,pageId:this.identity.pageId,targetId:this.identity.targetId,navigationGeneration,method:e.request.method},acquireRead:()=>this.requests.acquireBodyRead(current),readPostData:()=>cdp.send('Network.getRequestPostData',{requestId:e.requestId})});
        if(evicted)await this.unfinished([evicted],'in-flight-request-budget-exceeded');
        if(previous&&!e.redirectResponse)await this.unfinished([previous],'request-id-reused-before-completion');
        if(e.redirectResponse&&previous)await this.event('network-redirect',{requestKey:previous.key,nextRequestKey:current.key,response:{...e.redirectResponse,headers:redact(e.redirectResponse.headers)}});
        else if(e.redirectResponse)await this.event('gap',{reason:'redirect-origin-not-observed',requestKey:current.key});
        const artifact=await this.store.putArtifact(await body);
        const captured={...data,requestBodyArtifactId:artifact.id};
        await this.store.appendRaw('cdp',{method:'Network.requestWillBeSent',...captured}); await this.event('network-request',captured,[artifact.id],navigationGeneration);
        await this.event('network-request-body',{requestKey:current.key,captureStatus:artifact.captureStatus,capturedBytes:artifact.capturedBytes,originalBytes:artifact.originalBytes,reason:artifact.reason},[artifact.id],navigationGeneration);
        if(['missing','truncated','read-failed','unknown'].includes(artifact.captureStatus))await this.event('gap',{reason:artifact.reason||'request-body-incomplete',requestKey:current.key,captureStatus:artifact.captureStatus},[artifact.id],navigationGeneration);
      },Buffer.byteLength(JSON.stringify(data))+(typeof e.request.postData==='string'?Math.min(Buffer.byteLength(e.request.postData),REQUEST_BODY_LIMIT):e.request.hasPostData||e.request.postDataEntries?.length?REQUEST_BODY_LIMIT:0));
    });
    cdp.on('Network.responseReceived',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.response(e.requestId,e.response.mimeType);this.task(async()=>{
      await this.event('network-response',{requestKey:r?.key,response:{...e.response,headers:redact(e.response.headers)}});
      if(!r)await this.event('gap',{reason:'response-without-observed-request',requestId:e.requestId,url:e.response.url});
      if(r?.streaming){const artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,captureStatus:'unknown',reason:'SSE payload completeness unsupported; connection may remain open',source:{requestKey:r.key,url:r.url}});await this.event('network-stream',{requestKey:r.key,url:r.url,completeness:'unsupported'},[artifact.id]);}
    });});
    cdp.on('Network.loadingFinished',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.finish(e.requestId);this.task(async()=>{
      if(!r){await this.event('gap',{reason:'completion-without-observed-request',requestId:e.requestId});return;}
      if(r.streaming){await this.event('network-stream-ended',{requestKey:r.key,encodedDataLength:e.encodedDataLength,completeness:'unsupported'});return;}
      let artifact;
      await this.recording.flush();
      const resource=isArchivableResource(r.mime),position=this.lastPosition;
      const resourceInput=position?{position,frameId:!r.frameId||r.frameId===this.frameId?'top':r.frameId,requestId:r.key,url:r.url,mediaType:r.mime,source:{encodedDataLength:e.encodedDataLength}}:undefined;
      if(!resource&&!/json|text|html|xml|javascript|svg|x-www-form-urlencoded/i.test(r.mime)) artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'excluded',reason:'Binary response metadata only',source:{requestKey:r.key,url:r.url}});
      else if(privateResourceUrl(r.url)){
        if(resource&&resourceInput)await this.resources.capture({...resourceInput,status:'redacted',reason:'credential-bearing-resource-url'});
        artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,captureStatus:'excluded',reason:'credential-bearing-response-url',source:{requestKey:r.key,url:'[redacted]'}});
      } else try {
        const body=await cdp.send('Network.getResponseBody',{requestId:e.requestId});
        if(body.body.length>(body.base64Encoded?Math.ceil(BODY_LIMIT/3)*4:BODY_LIMIT))throw new Error('response-decoded-byte-budget');
        const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
        if(bytes.length>BODY_LIMIT)throw new Error('response-decoded-byte-budget');
        if(resource&&resourceInput)await this.resources.capture({...resourceInput,data:bytes});
        if(resource&&!/text|svg/i.test(r.mime))artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,captureStatus:'excluded',reason:'Binary bytes captured in offline resource archive',source:{requestKey:r.key,url:r.url}});
        else artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,data:bytes,limitBytes:BODY_LIMIT,source:{requestKey:r.key,url:r.url,frameId:r.frameId}});
      }
      catch(error){if(resource&&resourceInput)await this.resources.capture({...resourceInput,status:'failed',reason:'observed-response-body-unavailable'});artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,captureStatus:'read-failed',reason:String(error),source:{requestKey:r.key,url:r.url}});}
      await this.event('network-body',{requestKey:r.key,url:r.url,encodedDataLength:e.encodedDataLength},[artifact.id]);
    },BODY_LIMIT*4+4096,isArchivableResource(r?.mime||'')?'resource':'network');});
    cdp.on('Network.loadingFailed',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.finish(e.requestId);this.task(async()=>{const artifact=r?await this.store.putArtifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'missing',reason:e.errorText||'Network request failed',source:{requestKey:r.key,url:r.url}}):undefined;await this.event('network-failed',{...e,requestKey:r?.key},artifact?[artifact.id]:undefined);});});
    cdp.on('Network.webSocketCreated',(e:any)=>{if(!this.paused)this.task(()=>this.event('gap',{reason:'WebSocket payload completeness unsupported',...e}));});
    cdp.on('Disconnected',()=>{if(!this.stopped){this.fail('Capture CDP disconnected');const unfinished=this.requests.reset();this.task(async()=>{await this.event('gap',{reason:'capture CDP disconnected'});await this.unfinished(unfinished,'capture-disconnected-in-flight');});}});
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Network.enable',{maxTotalBufferSize:64*1024*1024,maxResourceBufferSize:RESOURCE_MAX_BYTES,maxPostDataSize:BODY_LIMIT});
    await cdp.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world});
    // rrweb itself creates transient helper iframes. Recording every new frame
    // recursively would instrument those helpers and create an iframe loop.
    // P0 records the top document; rrweb handles reachable child DOM itself.
    const config={binding:this.binding,recordingId:this.store.manifest.id,pageId:this.identity.pageId,checkoutEveryNms:30000,checkoutEveryNth:500};
    const script = `(function(){if(window!==window.top)return;\n${instrumentRecorder(recorder)}\n;(${installSourceRecorder.toString()})(${JSON.stringify(config)});(${observe.toString()})(${JSON.stringify(this.binding)});})();`;
    this.scriptId=(await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:script,worldName:this.world})).identifier;
    const {frameTree}=await cdp.send('Page.getFrameTree'); this.frameId=frameTree.frame.id;
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:this.frameId,worldName:this.world});
    this.contexts.set(executionContextId,this.frameId!);
    const injection=await cdp.send('Runtime.evaluate',{expression:script,contextId:executionContextId});
    if(injection.exceptionDetails){this.fail('rrweb observer injection failed');throw new Error('rrweb observer injection failed: '+(injection.exceptionDetails.exception?.description||injection.exceptionDetails.text));}
    await this.event('capture-ready',{capabilities:{mainDocument:true,rrweb:true,recordingFormat:2,sourceAdapter:RRWEB_ADAPTER_VERSION,networkBodies:true,crossOriginFrames:'unsupported',openShadowRoots:'captured-unverified',canvas:'unsupported',media:'unsupported',nodeHttp:'unobserved'},targetId:this.identity.targetId});
    this.task(()=>this.captureLoadedResources(),RESOURCE_MAX_BYTES*4+4096,'resource');
  }
  private async captureLoadedResources(){
    await this.recording.flush();
    const position=this.lastPosition;if(!position)return;
    const {frameTree}=await this.cdp.send('Page.getResourceTree');
    let count=0;
    const visit=async(tree:typeof frameTree):Promise<void>=>{
      for(const resource of tree.resources){
        if(!isArchivableResource(resource.mimeType))continue;
        if(++count>1000){await this.event('gap',{category:'resource',reason:'initial-resource-count-budget',from:position});return;}
        const input={position,frameId:tree.frame.id===this.frameId?'top':tree.frame.id,url:resource.url,mediaType:resource.mimeType,source:{fromCache:true}};
        if(privateResourceUrl(resource.url)){await this.resources.capture({...input,status:'redacted'});continue;}
        try{
          const body=await this.cdp.send('Page.getResourceContent',{frameId:tree.frame.id,url:resource.url});
          if(body.content.length>(body.base64Encoded?Math.ceil(RESOURCE_MAX_BYTES/3)*4:RESOURCE_MAX_BYTES))throw new Error('resource-byte-budget');
          await this.resources.capture({...input,data:Buffer.from(body.content,body.base64Encoded?'base64':'utf8')});
        }catch{await this.resources.capture({...input,status:'failed',reason:'browser-cached-resource-unavailable'});}
      }
      for(const child of tree.childFrames??[])await visit(child);
    };
    await visit(frameTree);
  }
  async inspect(enabled:boolean) {
    const generation=this.identity.navigationGeneration;
    const contexts=await this.readyObservers();if(enabled&&!contexts.ready.length)throw new Error('The current main document recorder is not ready for inspection');
    for(const {contextId}of contexts.ready){const result=await(this.cdp as any).send('Runtime.evaluate',{expression:`window.__besInspect = ${enabled}`,contextId});if(result.exceptionDetails)throw new Error('Could not change main document inspection: '+result.exceptionDetails.text);}
    if(generation!==this.identity.navigationGeneration)throw new Error('Inspection target navigated while changing mode');
    this.inspectionEnabled=enabled;
  }
  private readyObservers(){return readyMainObserverContexts(this.contexts,this.frameId,contextId=>(this.cdp as any).send('Runtime.evaluate',{expression:'Boolean(window.__besRecorderReady === true && window.rrweb?.record?.takeFullSnapshot)',contextId,returnByValue:true}));}
  async pause(value:boolean) {
    if(this.stopped)throw new Error('Capture has stopped');
    if(value===this.paused)return;
    if(value){this.pauseAt=new Date().toISOString();this.paused=true;const unfinished=this.requests.reset();await this.flush();await this.unfinished(unfinished,'recording-paused-in-flight');}
    else {this.paused=false;await this.event('gap',{reason:'recording-paused',startedAt:this.pauseAt,endedAt:new Date().toISOString()});await this.freshSnapshots('recording-resumed');}
  }
  private async freshSnapshots(reason:string){
    const startedAt=new Date().toISOString(),before=new Map(this.fullSnapshots),outcomes:{contextId:number;frameId:string;requested:boolean;error?:string;observed?:boolean}[]=[];
    const contexts=await this.readyObservers();for(const context of contexts.unavailable)outcomes.push({...context,requested:false,error:context.reason});
    for(const {contextId,frameId}of contexts.ready){try{const result=await(this.cdp as any).send('Runtime.evaluate',{expression:'window.rrweb.record.takeFullSnapshot();true',contextId});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Snapshot expression failed');outcomes.push({contextId,frameId,requested:true});}catch(error){outcomes.push({contextId,frameId,requested:false,error:String(error)});}}
    await this.flush();for(const outcome of outcomes)outcome.observed=(this.fullSnapshots.get(outcome.contextId)||0)>(before.get(outcome.contextId)||0);
    const complete=outcomes.length>0&&outcomes.every(outcome=>outcome.requested&&outcome.observed);
    await this.event(complete?'rrweb-resumed':'gap',{reason:complete?reason:'fresh-rrweb-snapshot-not-observed',requestedBecause:reason,startedAt,endedAt:new Date().toISOString(),outcomes});if(!complete)this.fail('Fresh rrweb snapshot was not observed after resume');
  }
  async flush(){while(this.pending.size)await Promise.allSettled([...this.pending]);await this.recording.flush();await this.resources.flush();if(this.drops){const dropped=this.drops;this.drops=0;await this.event('gap',{reason:'capture-backpressure',dropped,channels:Object.fromEntries(this.droppedChannels),from:this.lastPosition,queueMetrics:this.budget.snapshot()});this.droppedChannels.clear();}await this.store.flush();}
  stop(){
    // Page destruction and a user seal can race. Share one teardown attempt;
    // a failed attempt is released so an explicit retry can finish durability.
    return this.stopTask??=this.stopRecorder().finally(()=>{this.stopTask=undefined;});
  }
  private async stopRecorder(){
    if(this.stopComplete)return;
    // Detaching CDP alone leaves rrweb and capture-phase inspection listeners
    // running inside the retained document. Remove injection, then stop every
    // surviving observer before releasing human input or the evidence writer.
    if(!this.stopped && this.cdp && !this.page.isClosed()&&!this.documentGone){
      if(this.scriptId){await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:this.scriptId});this.scriptId=undefined;}
      for(const contextId of [...this.contexts.keys()]){
        try{const result=await this.cdp.send('Runtime.evaluate',{expression:'window.__besStop?.();window.__besSourceHealth?.() || null',contextId,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Recorder teardown failed');const health=result.result.value;if(health&&(health.failedEmits||!health.metadataComplete))throw new Error('Final recorder emission failed: '+JSON.stringify(health));}
        catch(error){
          // A document that has already disappeared cannot retain a recorder.
          if(!this.page.isClosed()&&!/Cannot find context|Execution context was destroyed|Cannot find execution context/i.test(String(error)))throw error;
        }
      }
    }
    const wasPaused=this.paused;this.stopped=true;this.inspectionEnabled=false;
    this.unfinishedOnStop??=this.requests.reset();
    if(this.cdp&&!this.cdp.detached)await this.cdp.detach().catch(error=>{if(!this.page.isClosed()&&!this.documentGone)throw error;});
    await this.flush();if(wasPaused&&!this.pausedStopRecorded){await this.event('gap',{reason:'recording-paused',startedAt:this.pauseAt,endedAt:new Date().toISOString(),endedBy:'capture-stop'});this.pausedStopRecorded=true;}
    while(this.unfinishedOnStop.length){await this.unfinished([this.unfinishedOnStop[0]!],'capture-stopped-in-flight');this.unfinishedOnStop.shift();}
    await this.store.flush();this.stopComplete=true;
  }
}

function observe(binding:string) {
  const w=window as any; if(w.__besInstalled)return; w.__besInstalled=true;
  const emit=(data:Record<string,unknown>)=>{try{w[binding](JSON.stringify({...data,isTop:window===window.top}));}catch{}};
  const describe=(el:Element)=>({tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),name:el.getAttribute('aria-label'),text:(el.textContent||'').trim().slice(0,400),selectors:[el.id?'#'+CSS.escape(el.id):null,el.getAttribute('data-testid')?'[data-testid='+JSON.stringify(el.getAttribute('data-testid'))+']':null].filter(Boolean),rect:el.getBoundingClientRect().toJSON(),url:location.href});
  const listeners=new AbortController(),options={capture:true,signal:listeners.signal};
  let highlighted:HTMLElement|undefined;
  document.addEventListener('pointermove',e=>{if(!w.__besInspect)return; if(highlighted)highlighted.style.removeProperty('outline');highlighted=e.target as HTMLElement; highlighted.style.outline='2px solid #19bda0';},options);
  document.addEventListener('click',e=>{const el=e.target as Element;if(w.__besInspect){e.preventDefault();e.stopImmediatePropagation();if(highlighted)highlighted.style.removeProperty('outline');emit({kind:'element-selected',element:describe(el)});}else emit({kind:'action',action:'click',element:describe(el),isTrusted:e.isTrusted});},options);
  document.addEventListener('input',e=>{const el=e.target as HTMLInputElement;emit({kind:'action',action:'input',element:describe(el),inputSummary:{masked:true,length:el.value?.length},isTrusted:e.isTrusted});},options);
  w.__besStop=()=>{w.__besInspect=false;w.__besRecorderReady=false;listeners.abort();if(highlighted)highlighted.style.removeProperty('outline');w.__besStopSource?.();w.__besInstalled=false;};
}
