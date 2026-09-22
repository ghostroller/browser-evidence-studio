import type { Page, CDPSession } from 'puppeteer-core';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from '../evidence/store';
import recorder from '../../node_modules/rrweb/dist/rrweb.umd.min.cjs?raw';
import { RequestLedger, type CapturedRequest } from './request-ledger';
import { readyMainObserverContexts } from './observer-contexts';

export interface PageIdentity { pageId:string; targetId:string; webContentsId:number; navigationGeneration:number; openerPageId?:string; }
const BODY_LIMIT = 8 * 1024 * 1024;
const redact = (headers: Record<string,unknown> = {}) => Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,/authorization|cookie|token|secret/i.test(k)?'[excluded credential]':v]));

export class CaptureCoordinator {
  private cdp!: CDPSession;
  private pending = new Set<Promise<unknown>>();
  private readonly requests:RequestLedger;
  private contexts = new Map<number,string>();
  private paused = false;
  private stopped = false;
  private drops = 0;
  private pendingBytes = 0;
  private degraded = false;
  private readonly fullSnapshots = new Map<number,number>();
  private pauseAt?:string;
  private frameId?:string;
  private readonly world = `bes-observer-${randomUUID()}`;
  private readonly binding = `bes_${randomUUID().replace(/-/g,'')}`;
  constructor(readonly page: Page, readonly identity: PageIdentity, readonly store: EvidenceStore, private onSelection: (data:unknown)=>void = ()=>{}, private onDegraded:(reason:string)=>void=()=>{}) {this.requests=new RequestLedger(randomUUID(),identity.targetId);}
  get health(){return this.degraded?'degraded':this.stopped?'stopped':this.paused?'paused':'recording';}
  private fail(reason:string){if(this.degraded)return;this.degraded=true;this.onDegraded(reason);}
  private task(work: ()=>Promise<unknown>,estimatedBytes=4096) {
    if(this.stopped) return;
    if(this.pending.size >= 256||this.pendingBytes+estimatedBytes>32*1024*1024) { this.drops++;this.fail('Capture queue reached its bounded budget');return; }
    this.pendingBytes+=estimatedBytes;
    const p=work().catch(async error=>{this.fail(String(error));await this.store.appendEvent({type:'gap',source:'capture',pageId:this.identity.pageId,data:{reason:String(error)}}).catch(failure=>{this.fail('Cannot persist capture gap: '+String(failure));});}).finally(()=>{this.pending.delete(p);this.pendingBytes-=estimatedBytes;});
    this.pending.add(p);
  }
  private async unfinished(requests:CapturedRequest[],reason:string){
    for(const request of requests){const artifact=await this.store.putArtifact({kind:'response-body',mediaType:request.mime||'application/octet-stream',captureStatus:request.streaming?'unknown':'missing',reason,source:{requestKey:request.key,url:request.url,frameId:request.frameId}});await this.event('gap',{reason,requestKey:request.key,url:request.url,startedAt:request.startedAt,endedAt:new Date().toISOString(),streaming:!!request.streaming},[artifact.id]);}
  }
  private event(type:string,data:unknown, artifactRefs?:string[]) { return this.store.appendEvent({type,source:'cdp',pageId:this.identity.pageId,navigationGeneration:this.identity.navigationGeneration,data,artifactRefs}); }
  async start() {
    this.cdp=await this.page.createCDPSession();
    const cdp=this.cdp as any;
    cdp.on('Runtime.executionContextCreated',({context}:any)=>{ if(context.name===this.world) this.contexts.set(context.id,context.auxData?.frameId); });
    cdp.on('Runtime.executionContextDestroyed',({executionContextId}:any)=>{this.contexts.delete(executionContextId);this.fullSnapshots.delete(executionContextId);});
    cdp.on('Runtime.executionContextsCleared',()=>{this.contexts.clear();this.fullSnapshots.clear();});
    cdp.on('Page.frameNavigated',({frame}:any)=>{ if(!frame.parentId){ this.frameId=frame.id; this.identity.navigationGeneration++; } if(!this.paused) this.task(()=>this.event('navigation',{frameId:frame.id,url:frame.url,loaderId:frame.loaderId,parentId:frame.parentId})); });
    cdp.on('Runtime.exceptionThrown',(event:any)=>{if(!this.paused) this.task(()=>this.event('page-error',event));});
    cdp.on('Runtime.consoleAPICalled',(event:any)=>{if(!this.paused)this.task(()=>this.event('console',{type:event.type,args:event.args.map((x:any)=>({type:x.type,value:x.value,description:x.description?.slice(0,4000)}))}));});
    cdp.on('Runtime.bindingCalled',(event:any)=>{
      if(event.name!==this.binding||this.paused||this.stopped) return;
      const payloadBytes=Buffer.byteLength(event.payload);if(payloadBytes>16*1024*1024){this.drops++;this.fail('Recorder event exceeds 16 MiB');return;}
      this.task(async()=>{ const data=JSON.parse(event.payload); const frameId=this.contexts.get(event.executionContextId);
        if(data.kind==='rrweb'){await this.store.appendRaw('rrweb',{pageId:this.identity.pageId,frameId,isTop:data.isTop===true,navigationGeneration:this.identity.navigationGeneration,event:data.event});if(data.event?.type===2){this.fullSnapshots.set(event.executionContextId,(this.fullSnapshots.get(event.executionContextId)||0)+1);await this.event('rrweb-full-snapshot',{frameId,isTop:data.isTop===true,contextId:event.executionContextId,timestamp:data.event.timestamp});}}
        else { await this.event(data.kind,{...data,frameId,actor:'unknown',source:'isolated-world-observer'}); if(data.kind==='element-selected') this.onSelection({...data,frameId,pageId:this.identity.pageId,generation:this.identity.navigationGeneration}); }
      },payloadBytes);
    });
    cdp.on('Network.requestWillBeSent',(e:any)=>{
      if(this.paused||this.stopped)return;
      const {current,previous,evicted}=this.requests.begin({requestId:e.requestId,url:e.request.url,frameId:e.frameId,redirect:!!e.redirectResponse});
      const data={requestKey:current.key,requestId:e.requestId,frameId:e.frameId,loaderId:e.loaderId,timestamp:e.timestamp,request:{...e.request,headers:redact(e.request.headers),postData:e.request.postData&&(/password|passwd|token|secret/i.test(e.request.postData)?'[excluded credential-bearing body]':e.request.postData.slice(0,BODY_LIMIT))},redirectHop:current.hop};
      this.task(async()=>{
        if(evicted)await this.unfinished([evicted],'in-flight-request-budget-exceeded');
        if(previous&&!e.redirectResponse)await this.unfinished([previous],'request-id-reused-before-completion');
        if(e.redirectResponse&&previous)await this.event('network-redirect',{requestKey:previous.key,nextRequestKey:current.key,response:{...e.redirectResponse,headers:redact(e.redirectResponse.headers)}});
        else if(e.redirectResponse)await this.event('gap',{reason:'redirect-origin-not-observed',requestKey:current.key});
        await this.store.appendRaw('cdp',{method:'Network.requestWillBeSent',...data}); await this.event('network-request',data);
      },Buffer.byteLength(JSON.stringify(data)));
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
      if(!/json|text|html|xml|javascript|svg|x-www-form-urlencoded/i.test(r.mime)) artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'excluded',reason:'Binary response metadata only',source:{requestKey:r.key,url:r.url}});
      else try { const body=await cdp.send('Network.getResponseBody',{requestId:e.requestId}); const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8'); artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,data:bytes,limitBytes:BODY_LIMIT,source:{requestKey:r.key,url:r.url,frameId:r.frameId}}); }
      catch(error){artifact=await this.store.putArtifact({kind:'response-body',mediaType:r.mime,captureStatus:'read-failed',reason:String(error),source:{requestKey:r.key,url:r.url}});}
      await this.event('network-body',{requestKey:r.key,url:r.url,encodedDataLength:e.encodedDataLength},[artifact.id]);
    });});
    cdp.on('Network.loadingFailed',(e:any)=>{if(this.paused||this.stopped)return;const r=this.requests.finish(e.requestId);this.task(async()=>{const artifact=r?await this.store.putArtifact({kind:'response-body',mediaType:r.mime||'application/octet-stream',captureStatus:'missing',reason:e.errorText||'Network request failed',source:{requestKey:r.key,url:r.url}}):undefined;await this.event('network-failed',{...e,requestKey:r?.key},artifact?[artifact.id]:undefined);});});
    cdp.on('Network.webSocketCreated',(e:any)=>{if(!this.paused)this.task(()=>this.event('gap',{reason:'WebSocket payload completeness unsupported',...e}));});
    cdp.on('Disconnected',()=>{if(!this.stopped){this.fail('Capture CDP disconnected');const unfinished=this.requests.reset();this.task(async()=>{await this.event('gap',{reason:'capture CDP disconnected'});await this.unfinished(unfinished,'capture-disconnected-in-flight');});}});
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Network.enable',{maxTotalBufferSize:64*1024*1024,maxResourceBufferSize:16*1024*1024,maxPostDataSize:BODY_LIMIT});
    await cdp.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world});
    // rrweb itself creates transient helper iframes. Recording every new frame
    // recursively would instrument those helpers and create an iframe loop.
    // P0 records the top document; rrweb handles reachable child DOM itself.
    const script = `(function(){if(window!==window.top)return;\n${recorder}\n;(${observe.toString()})(${JSON.stringify(this.binding)});})();`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:script,worldName:this.world});
    const {frameTree}=await cdp.send('Page.getFrameTree'); this.frameId=frameTree.frame.id;
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:this.frameId,worldName:this.world});
    this.contexts.set(executionContextId,this.frameId!);
    const injection=await cdp.send('Runtime.evaluate',{expression:script,contextId:executionContextId});
    if(injection.exceptionDetails){this.fail('rrweb observer injection failed');throw new Error('rrweb observer injection failed: '+(injection.exceptionDetails.exception?.description||injection.exceptionDetails.text));}
    await this.event('capture-ready',{capabilities:{mainDocument:true,rrweb:true,networkBodies:true,crossOriginFrames:'partial',canvas:'unsupported',media:'unsupported',nodeHttp:'unobserved'},targetId:this.identity.targetId});
  }
  async inspect(enabled:boolean) {
    const contexts=await this.readyObservers();if(!contexts.ready.length)throw new Error('The current main document recorder is not ready for inspection');
    for(const {contextId}of contexts.ready){const result=await(this.cdp as any).send('Runtime.evaluate',{expression:`window.__besInspect = ${enabled}`,contextId});if(result.exceptionDetails)throw new Error('Could not change main document inspection: '+result.exceptionDetails.text);}
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
  async flush(){await Promise.allSettled([...this.pending]);if(this.drops){const dropped=this.drops;this.drops=0;await this.event('gap',{reason:'capture-backpressure',dropped});}await this.store.flush();}
  async stop(){if(this.stopped)return;const wasPaused=this.paused;this.stopped=true;const unfinished=this.requests.reset();await this.cdp.detach().catch(error=>this.fail('Capture detach failed: '+String(error)));await this.flush();if(wasPaused)await this.event('gap',{reason:'recording-paused',startedAt:this.pauseAt,endedAt:new Date().toISOString(),endedBy:'capture-stop'});await this.unfinished(unfinished,'capture-stopped-in-flight');await this.store.flush();}
}

function observe(binding:string) {
  const w=window as any; if(w.__besInstalled)return; w.__besInstalled=true;
  const emit=(data:Record<string,unknown>)=>{try{w[binding](JSON.stringify({...data,isTop:window===window.top}));}catch{}};
  const describe=(el:Element)=>({tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),name:el.getAttribute('aria-label'),text:(el.textContent||'').trim().slice(0,400),selectors:[el.id?'#'+CSS.escape(el.id):null,el.getAttribute('data-testid')?'[data-testid='+JSON.stringify(el.getAttribute('data-testid'))+']':null].filter(Boolean),rect:el.getBoundingClientRect().toJSON(),url:location.href});
  let highlighted:HTMLElement|undefined;
  document.addEventListener('pointermove',e=>{if(!w.__besInspect)return; if(highlighted)highlighted.style.removeProperty('outline');highlighted=e.target as HTMLElement; highlighted.style.outline='2px solid #19bda0';},true);
  document.addEventListener('click',e=>{const el=e.target as Element;if(w.__besInspect){e.preventDefault();e.stopImmediatePropagation();if(highlighted)highlighted.style.removeProperty('outline');w.__besInspect=false;emit({kind:'element-selected',element:describe(el)});}else emit({kind:'action',action:'click',element:describe(el),isTrusted:e.isTrusted});},true);
  document.addEventListener('input',e=>{const el=e.target as HTMLInputElement;emit({kind:'action',action:'input',element:describe(el),inputSummary:{masked:true,length:el.value?.length},isTrusted:e.isTrusted});},true);
  w.rrweb.record({emit:(event:unknown)=>emit({kind:'rrweb',event}),maskAllInputs:true,recordCanvas:false,collectFonts:false,inlineStylesheet:false,checkoutEveryNms:30000,sampling:{mousemove:100,scroll:100}});w.__besRecorderReady=true;
}
