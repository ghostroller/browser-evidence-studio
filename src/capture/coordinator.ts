import type { Page, CDPSession } from 'puppeteer-core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EvidenceStore } from '@/evidence/store';
import recorder from '../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';
import { RequestLedger, type CapturedRequest } from './request-ledger';
import { readyMainObserverContexts } from './observer-contexts';
import { captureRequestBody, redactHeaders as redact, requestMetadata, REQUEST_BODY_LIMIT } from './request-body';
import { instrumentRecorder, RRWEB_ADAPTER_VERSION } from './rrweb-adapter';
import { installSourceRecorder } from './source-recorder';
import { RecordingIndexWriter } from '@/replay/archive';
import { sameStream, type PresentationSample, type RecordingEnvelope } from './recording-types';
import { parseReplayPosition, sameReplayPosition, type HistoricalElementRef, type ReplayPosition } from '@/contracts/recording';
import { ArchiveReplayService } from '@/replay/service';
import { CaptureBudget, DeferredBodyReads, type CaptureChannel } from './budget';
import { ResourceCapture, isArchivableResource, privateResourceUrl, RESOURCE_MAX_BYTES } from '@/resources/archive';
import { captureError, captureMetadata, credentialUrl } from './url-privacy';
import { prepareResponseBody, RESPONSE_CDP_BUFFER_BYTES, RESPONSE_WORKING_BYTES } from './response-body';
import type { ArtifactInput } from '@/evidence/contracts';
import { SourceFrameScopes } from './frame-scopes';

export interface PageIdentity { pageId:string; targetId:string; webContentsId:number; navigationGeneration:number; openerPageId?:string; }
const BODY_LIMIT = 8 * 1024 * 1024;
interface ResourceDocument { frameId:string; loaderId:string; }

export class CaptureCoordinator {
  private cdp!: CDPSession;
  private pending = new Set<Promise<unknown>>();
  private readonly requests:RequestLedger;
  private contexts = new Map<number,string>();
  private readonly contextDocuments = new Map<number,ResourceDocument>();
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
  private unknownStructuralLoss = false;
  private archivedDocument?:string;
  private readonly bodyReads=new DeferredBodyReads();
  private pendingMainBaseline=false;
  private readonly sourceFrameScopes=new SourceFrameScopes();
  private readonly frameLoaders=new Map<string,string>();
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
  get queueMetrics(){return{...this.budget.snapshot(),bodyDescriptors:this.bodyReads.metrics()};}
  private bodyTask(work:()=>Promise<unknown>,descriptorBytes:number,channel:'resource'|'network'='resource'){
    if(this.stopped)return false;
    const accepted=this.bodyReads.add(async()=>{
      const release=this.budget.reserve('resource',RESPONSE_WORKING_BYTES);
      if(!release)throw new Error('Reserved body working set is unavailable');
      try{await work();}catch(error){this.fail(String(error));await this.event('gap',{category:'resource',reason:'body-read-or-persistence-failed',error:String(error),from:this.lastPosition});throw error;}finally{release();}
    },descriptorBytes);
    if(!accepted){this.drops++;this.droppedChannels.set(channel,(this.droppedChannels.get(channel)||0)+1);this.fail('Pending response descriptors reached their bounded budget');}
    return accepted;
  }
  private currentDocument():ResourceDocument|undefined {const frameId=this.frameId,loaderId=frameId&&this.frameLoaders.get(frameId);return frameId&&loaderId?{frameId,loaderId}:undefined;}
  private documentMatches(expected:ResourceDocument|undefined){return !!expected&&this.frameId===expected.frameId&&this.frameLoaders.get(expected.frameId)===expected.loaderId;}
  private async currentSourcePosition(expected:ResourceDocument|undefined){
    const deadline=Date.now()+5000;
    while(this.pendingMainBaseline){if(!this.documentMatches(expected))return undefined;if(Date.now()>=deadline)throw new Error('Current document source baseline was not committed before resource capture');await delay(10);}
    await this.recording.flush();return this.documentMatches(expected)?this.lastPosition:undefined;
  }
  private task(work: ()=>Promise<unknown>,estimatedBytes=4096,channel:CaptureChannel='network') {
    if(this.stopped) return false;
    const release=this.budget.reserve(channel,estimatedBytes);
    if(!release) { this.drops++;this.droppedChannels.set(channel,(this.droppedChannels.get(channel)||0)+1);if(channel==='structure'||channel==='metadata')this.recoveryNeeded=true;this.fail('Capture queue reached its bounded '+channel+' budget');return false; }
    this.pendingBytes+=estimatedBytes;
    const p=work().catch(async error=>{this.fail(String(error));await this.store.appendEvent({type:'gap',source:'capture',pageId:this.identity.pageId,data:captureMetadata({reason:String(error),category:channel==='network'?'resource':channel,from:this.lastPosition})}).catch(failure=>{this.fail('Cannot persist capture gap: '+String(failure));});}).finally(()=>{this.pending.delete(p);this.pendingBytes-=estimatedBytes;release();this.recoverSnapshot();});
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
    for(const request of requests){const artifact=await this.artifact({kind:'response-body',mediaType:request.mime||'application/octet-stream',captureStatus:request.streaming?'unknown':'missing',reason,source:{requestKey:request.key,url:request.url,frameId:request.frameId}});await this.event('gap',{reason,requestKey:request.key,url:request.url,startedAt:request.startedAt,endedAt:new Date().toISOString(),streaming:!!request.streaming},[artifact.id]);}
  }
  private event(type:string,data:unknown, artifactRefs?:string[],navigationGeneration=this.identity.navigationGeneration) { return this.store.appendEvent({type,source:'cdp',pageId:this.identity.pageId,navigationGeneration,data:captureMetadata(data),artifactRefs}); }
  private artifact(input:ArtifactInput,observedOriginalBytes?:number){const{data,...metadata}=input;const safe={...captureMetadata(metadata),data};return observedOriginalBytes===undefined?this.store.putArtifact(safe):this.store.putArtifactPrefix(safe,observedOriginalBytes);}
  async start() {
    this.cdp=await this.page.createCDPSession();
    const cdp=this.cdp as any;
    cdp.on('Runtime.executionContextCreated',({context}:any)=>{ if(context.name===this.world){const frameId=context.auxData?.frameId,loaderId=this.frameLoaders.get(frameId);this.contexts.set(context.id,frameId);if(loaderId)this.contextDocuments.set(context.id,{frameId,loaderId});} });
    cdp.on('Runtime.executionContextDestroyed',({executionContextId}:any)=>{this.contexts.delete(executionContextId);this.contextDocuments.delete(executionContextId);this.fullSnapshots.delete(executionContextId);});
    cdp.on('Runtime.executionContextsCleared',()=>{this.contexts.clear();this.contextDocuments.clear();this.fullSnapshots.clear();});
    cdp.on('Page.frameNavigated',({frame}:any)=>{ if(!frame.parentId){ this.frameLoaders.clear();this.frameId=frame.id;this.pendingMainBaseline=true; if(this.trackNavigationGeneration)this.identity.navigationGeneration++; this.inspectionEnabled=false; }if(this.frameLoaders.has(frame.id)||this.frameLoaders.size<256)this.frameLoaders.set(frame.id,frame.loaderId); if(!this.paused) this.task(()=>this.event('navigation',{frameId:frame.id,url:frame.url,loaderId:frame.loaderId,parentId:frame.parentId})); });
    cdp.on('Page.frameDetached',({frameId}:any)=>{this.frameLoaders.delete(frameId);});
    cdp.on('Runtime.exceptionThrown',(event:any)=>{if(!this.paused) this.task(()=>this.event('page-error',event));});
    cdp.on('Runtime.consoleAPICalled',(event:any)=>{if(!this.paused)this.task(()=>this.event('console',{type:event.type,args:event.args.map((x:any)=>({type:x.type,value:x.value,description:x.description?.slice(0,4000)}))}));});
    cdp.on('Runtime.bindingCalled',(event:any)=>{
      if(event.name!==this.binding||this.paused||this.stopped) return;
      const payloadBytes=Buffer.byteLength(event.payload);if(payloadBytes>16*1024*1024){this.drops++;this.droppedChannels.set('structure',(this.droppedChannels.get('structure')||0)+1);this.unknownStructuralLoss=true;this.recoveryNeeded=true;this.fail('Recorder event exceeds 16 MiB; exact source boundary unavailable');this.recoverSnapshot();return;}
      let data;try{data=JSON.parse(event.payload);}catch{this.fail('Malformed recorder payload');return;}
      const source=data.event?.type===3?data.event.data?.source:undefined;
      const channel:CaptureChannel=data.kind!=='rrweb'||data.event?.type===5&&data.event.data?.tag==='bes-source-presentation'?'metadata':[1,3,6].includes(source)?'sampling':'structure';
      const document=this.contextDocuments.get(event.executionContextId),frameId=this.contexts.get(event.executionContextId);
      const accepted=this.task(async()=>{
        if(data.kind==='rrweb'){
          const losses=[...this.losses].map(([category,range])=>({id:randomUUID(),from:range.from,to:range.to,category:category==='network'?'resource':category,reason:'capture-channel-budget',count:range.count}));this.losses.clear();
          if(this.unknownStructuralLoss){losses.push({id:randomUUID(),from:this.lastPosition??data.position,to:data.position,category:'structure',reason:'oversized-recorder-event-unknown-boundary',count:1});this.unknownStructuralLoss=false;}
          const record:RecordingEnvelope={...data,receivedAt:new Date().toISOString(),gaps:[...losses,...(data.errors??[]).map((reason:string)=>({id:randomUUID(),from:data.position,category:'metadata',reason}))]};
          await this.recording.append(record);if(this.documentMatches(document)){this.sourceFrameScopes.append(record);this.lastPosition=record.position;if(data.event?.type===2)this.pendingMainBaseline=false;}
          if(data.event?.type===2){this.fullSnapshots.set(event.executionContextId,(this.fullSnapshots.get(event.executionContextId)||0)+1);await this.event('rrweb-full-snapshot',{frameId,isTop:data.isTop===true,contextId:event.executionContextId,timestamp:data.event.timestamp,position:record.position});if(this.archivedDocument!==record.position.documentId){this.archivedDocument=record.position.documentId;this.bodyTask(()=>this.captureLoadedResources(record.position,document),256,'resource');}}}
        else { await this.event(data.kind,{...data,frameId,actor:'unknown',source:'isolated-world-observer'}); if(data.kind==='element-selected') {await this.recording.flush();this.onSelection(captureMetadata({...data,frameId,pageId:this.identity.pageId,generation:this.identity.navigationGeneration}));} }
      },payloadBytes*3,channel);
      if(!accepted&&data.position){const previous=this.losses.get(channel);this.losses.set(channel,{from:previous?.from??data.position,to:data.position,count:(previous?.count??0)+1});}
    });
    cdp.on('Network.requestWillBeSent',(e:any)=>{
      if(this.paused||this.stopped)return;
      const {current,previous,evicted}=this.requests.begin({requestId:e.requestId,url:e.request.url,frameId:e.frameId,loaderId:e.loaderId,redirect:!!e.redirectResponse});
      const navigationGeneration=this.identity.navigationGeneration;
      const data={requestKey:current.key,requestId:e.requestId,frameId:e.frameId,loaderId:e.loaderId,timestamp:e.timestamp,request:requestMetadata(e.request),redirectHop:current.hop};
      this.task(async()=>{
        // Begin the CDP read before persistence can yield to redirects or reused request IDs.
        const body=captureRequestBody(e.request,{source:{requestKey:current.key,url:current.url,frameId:current.frameId,loaderId:e.loaderId,pageId:this.identity.pageId,targetId:this.identity.targetId,navigationGeneration,method:e.request.method},acquireRead:()=>this.requests.acquireBodyRead(current),readPostData:()=>cdp.send('Network.getRequestPostData',{requestId:e.requestId})});
        if(evicted)await this.unfinished([evicted],'in-flight-request-budget-exceeded');
        if(previous&&!e.redirectResponse)await this.unfinished([previous],'request-id-reused-before-completion');
        if(e.redirectResponse&&previous)await this.event('network-redirect',{requestKey:previous.key,nextRequestKey:current.key,response:{...e.redirectResponse,headers:redact(e.redirectResponse.headers)}});
        else if(e.redirectResponse)await this.event('gap',{reason:'redirect-origin-not-observed',requestKey:current.key});
        const artifact=await this.artifact(await body);
        const captured={...data,requestBodyArtifactId:artifact.id};
        await this.store.appendRaw('cdp',captureMetadata({method:'Network.requestWillBeSent',...captured})); await this.event('network-request',captured,[artifact.id],navigationGeneration);
        await this.event('network-request-body',{requestKey:current.key,captureStatus:artifact.captureStatus,capturedBytes:artifact.capturedBytes,originalBytes:artifact.originalBytes,reason:artifact.reason},[artifact.id],navigationGeneration);
        if(['missing','truncated','read-failed','unknown'].includes(artifact.captureStatus))await this.event('gap',{reason:artifact.reason||'request-body-incomplete',requestKey:current.key,captureStatus:artifact.captureStatus},[artifact.id],navigationGeneration);
      },Buffer.byteLength(JSON.stringify(data))+(typeof e.request.postData==='string'?Math.min(Buffer.byteLength(e.request.postData),REQUEST_BODY_LIMIT):e.request.hasPostData||e.request.postDataEntries?.length?REQUEST_BODY_LIMIT:0));
    });
    cdp.on('Network.responseReceived',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.response(e.requestId,e.response.mimeType);this.task(async()=>{
      await this.event('network-response',{requestKey:r?.key,response:{...e.response,headers:redact(e.response.headers)}});
      if(!r)await this.event('gap',{reason:'response-without-observed-request',requestId:e.requestId,url:e.response.url});
      if(r?.streaming){const artifact=await this.artifact({kind:'response-body',mediaType:r.mime,captureStatus:'unknown',reason:'SSE payload completeness unsupported; connection may remain open',source:{requestKey:r.key,url:r.url}});await this.event('network-stream',{requestKey:r.key,url:r.url,completeness:'unsupported'},[artifact.id]);}
    });});
    cdp.on('Network.loadingFinished',(e:any)=>{if(this.paused||this.stopped)return;const responseObservedAt=new Date().toISOString(),responseRead=this.requests.acquireResponseRead(e.requestId),r=this.requests.finish(e.requestId),document=r?.frameId&&r.loaderId&&this.frameLoaders.get(r.frameId)===r.loaderId?this.currentDocument():undefined;
    const responseSource={responseObservedAt,pageId:this.identity.pageId,requestKey:r?.key,url:r?.url,frameId:r?.frameId,loaderId:r?.loaderId};
    const accepted=this.bodyTask(async()=>{try{
      if(!r){await this.event('gap',{reason:'completion-without-observed-request',requestId:e.requestId});return;}
      if(r.streaming){await this.event('network-stream-ended',{requestKey:r.key,encodedDataLength:e.encodedDataLength,completeness:'unsupported'});return;}
      let artifact;
      const resource=isArchivableResource(r.mime);let position:ReplayPosition|undefined;
      if(resource){try{position=await this.currentSourcePosition(document);}catch(error){await this.event('gap',{category:'resource',reason:'resource-source-baseline-unavailable',requestKey:r.key,cause:captureError(error)});}if(!position)await this.event('gap',{category:'resource',reason:'resource-source-document-changed',requestKey:r.key});}
      const resourceFrameId=resource&&position?await this.resourceFrame(r.frameId,position,r.loaderId):undefined;
      const resourceInput=position?{position,frameId:resourceFrameId??'unmapped',requestId:r.key,url:r.url,mediaType:r.mime,...(!resourceFrameId?{status:'unsupported' as const,reason:'frame-source-scope-unavailable'}:{}),source:{encodedDataLength:e.encodedDataLength,cdpFrameId:r.frameId}}:undefined;
      if(!resource&&!/json|text|html|xml|javascript|svg|x-www-form-urlencoded/i.test(r.mime)) artifact=await this.artifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'excluded',reason:'Binary response metadata only',source:responseSource});
      else if(privateResourceUrl(r.url)){
        if(resource&&resourceInput)await this.resources.capture({...resourceInput,status:'redacted',reason:'credential-bearing-resource-url'});
        artifact=await this.artifact({kind:'response-body',mediaType:r.mime,captureStatus:'excluded',reason:'credential-bearing-response-url',source:{...responseSource,url:'[redacted]'}});
      } else {
        let safe: ReturnType<typeof prepareResponseBody>;
        try {
          if(responseRead.invalidated)throw new Error(responseRead.invalidated);
          const body=await cdp.send('Network.getResponseBody',{requestId:e.requestId});
          if(responseRead.invalidated)throw new Error(responseRead.invalidated);
          safe=prepareResponseBody(body,r.mime);
        } catch(error) {
          const reason=responseRead.invalidated??'observed-response-body-unavailable',cause=captureError(error);
          if(resource&&resourceInput)await this.resources.capture({...resourceInput,status:'failed',reason});
          artifact=await this.artifact({kind:'response-body',mediaType:r.mime,captureStatus:responseRead.invalidated?'missing':'read-failed',reason,metadata:{cause},source:responseSource});
          await this.event('network-body',{requestKey:r.key,url:r.url,encodedDataLength:e.encodedDataLength},[artifact.id]);return;
        }
        // Persistence errors must reach the capture task's durable gap/failure
        // path, rather than becoming a successful body-read fallback artifact.
        if(resource&&resourceInput)await this.resources.capture({...resourceInput,...(safe.redacted?{status:'redacted' as const,reason:safe.excludedReason??'response-privacy-policy'}:safe.observedBytes?{status:'missing' as const,reason:'resource-byte-budget'}:{data:safe.data})});
        if(resource&&!/text|svg/i.test(r.mime))artifact=await this.artifact({kind:'response-body',mediaType:r.mime,captureStatus:resourceInput&&resourceFrameId||safe.redacted?'excluded':'missing',reason:safe.redacted?'response-privacy-policy':resourceInput&&resourceFrameId?'Binary bytes captured in offline resource archive':'offline-resource-source-scope-unavailable',source:responseSource});
        else {artifact=await this.artifact({kind:'response-body',mediaType:r.mime,data:safe.data,limitBytes:BODY_LIMIT,...(safe.excludedReason?{captureStatus:'excluded' as const,reason:safe.excludedReason}:{}),metadata:{privacyRedacted:safe.redacted,representation:safe.redacted?'privacy-redacted-response':'observed-response',...(safe.privacyError?{privacyError:safe.privacyError}:{}),...(safe.observedBytes?{originalByteBasis:'entire-observed-CDP-response-UTF8'}:{})},source:responseSource},safe.observedBytes);}
      }
      await this.event('network-body',{requestKey:r.key,url:r.url,encodedDataLength:e.encodedDataLength},[artifact.id]);
    }finally{responseRead.release();}},Buffer.byteLength(JSON.stringify({event:e,request:r}))+256,isArchivableResource(r?.mime||'')?'resource':'network');if(!accepted)responseRead.release();});
    cdp.on('Network.loadingFailed',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.finish(e.requestId);this.task(async()=>{const artifact=r?await this.artifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'missing',reason:e.errorText||'Network request failed',source:{requestKey:r.key,url:r.url}}):undefined;await this.event('network-failed',{...e,requestKey:r?.key},artifact?[artifact.id]:undefined);});});
    cdp.on('Network.webSocketCreated',(e:any)=>{if(!this.paused)this.task(()=>this.event('gap',{reason:'WebSocket payload completeness unsupported',...e}));});
    cdp.on('Disconnected',()=>{if(!this.stopped){this.fail('Capture CDP disconnected');const unfinished=this.requests.reset();this.task(async()=>{await this.event('gap',{reason:'capture CDP disconnected'});await this.unfinished(unfinished,'capture-disconnected-in-flight');});}});
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Network.enable',{maxTotalBufferSize:64*1024*1024,maxResourceBufferSize:RESPONSE_CDP_BUFFER_BYTES,maxPostDataSize:BODY_LIMIT});
    await cdp.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world});
    // rrweb itself creates transient helper iframes. Recording every new frame
    // recursively would instrument those helpers and create an iframe loop.
    // P0 records the top document; rrweb handles reachable child DOM itself.
    const config={binding:this.binding,recordingId:this.store.manifest.id,pageId:this.identity.pageId,checkoutEveryNms:30000,checkoutEveryNth:500};
    const script = `(function(){if(window!==window.top)return;\n${instrumentRecorder(recorder)}\n;const urlPrivacy=(${credentialUrl.toString()});(${installSourceRecorder.toString()})(${JSON.stringify(config)},urlPrivacy);(${observe.toString()})(${JSON.stringify(this.binding)},urlPrivacy);})();`;
    this.scriptId=(await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:script,worldName:this.world})).identifier;
    const {frameTree}=await this.cdp.send('Page.getFrameTree'); this.frameId=frameTree.frame.id;
    const registerFrame=(tree:typeof frameTree)=>{if(this.frameLoaders.size>=256)return;this.frameLoaders.set(tree.frame.id,tree.frame.loaderId);for(const child of tree.childFrames??[])registerFrame(child);};registerFrame(frameTree);
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:this.frameId,worldName:this.world});
    this.contexts.set(executionContextId,this.frameId!);
    const document=this.currentDocument();if(document)this.contextDocuments.set(executionContextId,document);
    const injection=await cdp.send('Runtime.evaluate',{expression:script,contextId:executionContextId});
    if(injection.exceptionDetails){this.fail('rrweb observer injection failed');throw new Error('rrweb observer injection failed: '+(injection.exceptionDetails.exception?.description||injection.exceptionDetails.text));}
    await this.event('capture-ready',{capabilities:{mainDocument:true,rrweb:true,recordingFormat:2,sourceAdapter:RRWEB_ADAPTER_VERSION,networkBodies:true,crossOriginFrames:'unsupported',openShadowRoots:'captured-unverified',canvas:'unsupported',media:'unsupported',nodeHttp:'unobserved'},targetId:this.identity.targetId});
  }
  private async captureLoadedResources(position:ReplayPosition,document:ResourceDocument|undefined){
    const current=()=>this.documentMatches(document)&&!this.pendingMainBaseline&&!!this.lastPosition&&sameStream(position,this.lastPosition);
    const skipped=async(stage:string,cdpFrameId=document?.frameId)=>this.event('resource-cache-probe-skipped',{reason:'source-document-or-loader-changed',from:position,cdpFrameId,loaderId:document?.loaderId,stage});
    if(!current()){await skipped('queued');return;}
    let frameTree;
    try{({frameTree}=await this.cdp.send('Page.getResourceTree'));}catch(error){if(!current()){await skipped('resource-tree-error');return;}throw error;}
    if(!current()||frameTree.frame.id!==document!.frameId||frameTree.frame.loaderId!==document!.loaderId){await skipped('resource-tree');return;}
    let count=0;
    const visit=async(tree:typeof frameTree):Promise<void>=>{
      const frameCurrent=()=>current()&&this.frameLoaders.get(tree.frame.id)===tree.frame.loaderId;
      if(!frameCurrent()){await skipped('frame-tree',tree.frame.id);return;}
      const frameId=await this.resourceFrame(tree.frame.id,position,tree.frame.loaderId);
      for(const resource of tree.resources){
        if(!frameCurrent()){await skipped('before-content',tree.frame.id);return;}
        if(!isArchivableResource(resource.mimeType))continue;
        if(++count>1000){await this.event('gap',{category:'resource',reason:'initial-resource-count-budget',from:position});return;}
        const input={position,frameId:frameId??'unmapped',url:resource.url,mediaType:resource.mimeType,...(!frameId?{status:'unsupported' as const,reason:'frame-source-scope-unavailable'}:{}),source:{fromCache:true,cdpFrameId:tree.frame.id}};
        if(privateResourceUrl(resource.url)){await this.resources.capture({...input,status:'redacted'});continue;}
        let body;
        try{
          body=await this.cdp.send('Page.getResourceContent',{frameId:tree.frame.id,url:resource.url});
          if(!frameCurrent()){await skipped('after-content',tree.frame.id);return;}
          if(body.content.length>(body.base64Encoded?Math.ceil(RESOURCE_MAX_BYTES/3)*4:RESOURCE_MAX_BYTES))throw new Error('resource-byte-budget');
        }catch(error){if(!frameCurrent()){await skipped('content-error',tree.frame.id);return;}await this.resources.capture({...input,status:'failed',reason:'browser-cached-resource-unavailable'});await this.event('resource-cache-probe-failed',{from:position,url:resource.url,cdpFrameId:tree.frame.id,cause:captureError(error)});continue;}
        await this.resources.capture({...input,data:Buffer.from(body.content,body.base64Encoded?'base64':'utf8')});
      }
      for(const child of tree.childFrames??[])await visit(child);
    };
    await visit(frameTree);
  }
  private async resourceFrame(cdpFrameId:string|undefined,position:ReplayPosition,loaderId?:string):Promise<string|undefined>{
    if(!cdpFrameId||!this.lastPosition||!sameStream(this.lastPosition,position)||this.pendingMainBaseline)return undefined;
    if(loaderId&&this.frameLoaders.get(cdpFrameId)!==loaderId)return undefined;
    if(cdpFrameId===this.frameId)return'top';
    const document=this.currentDocument();
    let objectId:string|undefined;
    try{
      const contexts=await this.readyObservers();if(contexts.ready.length!==1)return undefined;
      const owner=await this.cdp.send('DOM.getFrameOwner',{frameId:cdpFrameId});
      const remote=await this.cdp.send('DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:contexts.ready[0].contextId});objectId=remote.object.objectId;if(!objectId)return undefined;
      const result=await this.cdp.send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){try { const mirror=window.rrweb.record.mirror;return {hostId:mirror.getId(this),rootId:mirror.getId(this.contentDocument)}; } catch { return null; }}',returnByValue:true});
      const ids=result.result.value as {hostId:number;rootId:number}|null;
      if(!this.documentMatches(document)||loaderId&&this.frameLoaders.get(cdpFrameId)!==loaderId||this.pendingMainBaseline||!this.lastPosition||!sameStream(this.lastPosition,position)||result.exceptionDetails||!ids||!Number.isSafeInteger(ids.hostId)||!Number.isSafeInteger(ids.rootId))return undefined;
      return this.sourceFrameScopes.resolve(ids.hostId,ids.rootId,position);
    }catch(error){await this.event('gap',{category:'resource',reason:'frame-source-scope-unavailable',from:position,cdpFrameId,cause:captureError(error)});return undefined;}
    finally{if(objectId)await this.cdp.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
  }
  async inspect(enabled:boolean) {
    const generation=this.identity.navigationGeneration;
    const contexts=await this.readyObservers();if(enabled&&!contexts.ready.length)throw new Error('The current main document recorder is not ready for inspection');
    for(const {contextId}of contexts.ready){const result=await(this.cdp as any).send('Runtime.evaluate',{expression:`window.__besInspect = ${enabled}`,contextId});if(result.exceptionDetails)throw new Error('Could not change main document inspection: '+result.exceptionDetails.text);}
    if(generation!==this.identity.navigationGeneration)throw new Error('Inspection target navigated while changing mode');
    this.inspectionEnabled=enabled;
  }
  /** Existing authorized capture facade only: sample an explicitly identified
   * live source node, then return its NEW durable historical observation. */
  async samplePresentation(ref:HistoricalElementRef,signal?:AbortSignal):Promise<PresentationSample>{
    signal?.throwIfAborted();
    parseReplayPosition(ref.position);
    ref=structuredClone(ref);
    if(ref.kind!=='dom-node'||!Number.isSafeInteger(ref.nodeId)||ref.nodeId<0||typeof ref.frameId!=='string'||typeof ref.mirrorScopeId!=='string')throw new Error('Invalid presentation target');
    if(this.stopped||this.paused||!this.lastPosition||!sameStream(ref.position,this.lastPosition))throw new Error('Presentation target is not in the active recording document');
    const service=new ArchiveReplayService(this.store.runDir);
    // Establish that the supplied historical identity existed in its own source
    // structure before resolving that same mirror identity on the live page.
    await service.node(ref,{maxBytes:1024*1024,limit:1},signal);signal?.throwIfAborted();
    const contexts=await this.readyObservers();
    signal?.throwIfAborted();
    if(contexts.ready.length!==1)throw new Error('Exactly one active source observer is required for presentation sampling');
    const result=await this.cdp.send('Runtime.evaluate',{expression:`window.__besSamplePresentation(${JSON.stringify(ref)})`,contextId:contexts.ready[0].contextId,awaitPromise:true,returnByValue:true});
    signal?.throwIfAborted();
    if(result.exceptionDetails){const exception=result.exceptionDetails.exception;const safe=captureError(Object.assign(new Error(exception?.description??result.exceptionDetails.text),{name:exception?.className??'Error'}));throw new Error(`Source presentation sampling failed (${safe.name}): ${safe.message}`);}
    const observed=result.result.value as PresentationSample|undefined;
    if(!observed?.ref||!sameStream(observed.ref.position,ref.position)||observed.ref.nodeId!==ref.nodeId||observed.ref.frameId!==ref.frameId||observed.ref.mirrorScopeId!==ref.mirrorScopeId||observed.ref.position.eventSeq<=ref.position.eventSeq)throw new Error('Source presentation returned another target identity');
    parseReplayPosition(observed.ref.position);
    await this.flush();
    signal?.throwIfAborted();
    const archived=await service.node(observed.ref,{maxBytes:1024*1024,limit:1},signal);signal?.throwIfAborted();
    if(!archived.metadataComplete||!archived.presentation||JSON.stringify(archived.presentation)!==JSON.stringify(observed.presentation)||archived.presentation.status==='present'&&!sameReplayPosition(archived.presentation.value.sampledAt,observed.ref.position))throw new Error('Source presentation did not reach a complete durable source boundary');
    return{ref:observed.ref,presentation:archived.presentation};
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
  async flush(){while(this.pending.size)await Promise.allSettled([...this.pending]);await this.bodyReads.flush();await this.recording.flush();await this.resources.flush();if(this.drops){const dropped=this.drops;this.drops=0;await this.event('gap',{reason:'capture-backpressure',dropped,channels:Object.fromEntries(this.droppedChannels),from:this.lastPosition,queueMetrics:this.queueMetrics});this.droppedChannels.clear();}await this.store.flush();}
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
        try{const result=await this.cdp.send('Runtime.evaluate',{expression:'(()=>{const before=window.__besSourceHealth?.();window.__besStop?.();return {before,after:window.__besSourceHealth?.()}})()',contextId,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Recorder teardown failed');const health=result.result.value;if(health&&(health.before?.failedEmits||health.after?.failedEmits||health.after?.pendingMetadata||health.after?.metadataComplete===false))throw new Error('Final recorder emission failed: '+JSON.stringify(health));}
        catch(error){
          // A document that has already disappeared cannot retain a recorder.
          if(!this.page.isClosed()&&!/Cannot find context|Execution context was destroyed|Cannot find execution context/i.test(String(error)))throw error;
        }
      }
    }
    const wasPaused=this.paused;this.stopped=true;this.inspectionEnabled=false;
    // Accepted body descriptors still need the capture CDP connection. Stop
    // accepting new events first, drain durable reads, then detach the observer.
    await this.flush();
    this.unfinishedOnStop??=this.requests.reset();
    if(this.cdp&&!this.cdp.detached)await this.cdp.detach().catch(error=>{if(!this.page.isClosed()&&!this.documentGone)throw error;});
    await this.flush();if(this.unknownStructuralLoss){await this.event('gap',{category:'structure',reason:'oversized-final-recorder-event-unknown-boundary',from:this.lastPosition,to:'unknown',finalEmissionLost:true});await this.store.flush();throw new Error('Final source event exceeded its budget; capture remains incomplete');}if(wasPaused&&!this.pausedStopRecorded){await this.event('gap',{reason:'recording-paused',startedAt:this.pauseAt,endedAt:new Date().toISOString(),endedBy:'capture-stop'});this.pausedStopRecorded=true;}
    while(this.unfinishedOnStop.length){await this.unfinished([this.unfinishedOnStop[0]!],'capture-stopped-in-flight');this.unfinishedOnStop.shift();}
    await this.store.flush();this.stopComplete=true;
  }
}

function observe(binding:string,urlPrivacy:(value:string,base?:string)=>boolean) {
  const w=window as any; if(w.__besInstalled)return; w.__besInstalled=true;
  const emit=(data:Record<string,unknown>)=>{try{w[binding](JSON.stringify({...data,isTop:window===window.top}));}catch{}};
  const privateElement=(el:Element)=>{if(/^(input|textarea|select|option)$/i.test(el.localName)||el.querySelector('.rr-mask,.rr-block,input,textarea,select,option'))return true;let current:Element|null=el;while(current){if(current.matches('.rr-mask,.rr-block'))return true;const root:Node=current.getRootNode();current=current.parentElement??('host' in root?(root as ShadowRoot).host:null);}return false;};
  const describe=(el:Element)=>{const privateText=privateElement(el);return{tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),name:privateText?'[redacted]':el.getAttribute('aria-label'),text:privateText?'[redacted]':(el.textContent||'').trim().slice(0,400),selectors:privateText?[]:[el.id?'#'+CSS.escape(el.id):null,el.getAttribute('data-testid')?'[data-testid='+JSON.stringify(el.getAttribute('data-testid'))+']':null].filter(Boolean),rect:el.getBoundingClientRect().toJSON(),url:urlPrivacy(location.href)?'[redacted credential URL]':location.href};};
  const listeners=new AbortController(),options={capture:true,signal:listeners.signal};
  const sampleError=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);return{name:error instanceof Error?error.name:'Error',message:urlPrivacy(message)||/password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i.test(message)?'[redacted credential-bearing error message]':message.slice(0,4096)};};
  let highlighted:HTMLElement|undefined;
  document.addEventListener('pointermove',e=>{if(!w.__besInspect)return; if(highlighted)highlighted.style.removeProperty('outline');highlighted=e.target as HTMLElement; highlighted.style.outline='2px solid #19bda0';},options);
  document.addEventListener('click',e=>{const el=(e.composedPath().find(node=>node instanceof Element)??e.target) as Element;if(w.__besInspect){e.preventDefault();e.stopImmediatePropagation();if(highlighted)highlighted.style.removeProperty('outline');void w.__besSampleSelectedNode(el).then((sample:PresentationSample)=>emit({kind:'element-selected',element:describe(el),sample}),(error:unknown)=>emit({kind:'element-selected',element:describe(el),sampleError:sampleError(error)}));}else emit({kind:'action',action:'click',element:describe(el),isTrusted:e.isTrusted});},options);
  document.addEventListener('input',e=>{const el=e.target as HTMLInputElement;emit({kind:'action',action:'input',element:describe(el),inputSummary:{masked:true,length:el.value?.length},isTrusted:e.isTrusted});},options);
  w.__besStop=()=>{w.__besInspect=false;w.__besRecorderReady=false;listeners.abort();if(highlighted)highlighted.style.removeProperty('outline');w.__besStopSource?.();w.__besInstalled=false;};
}
