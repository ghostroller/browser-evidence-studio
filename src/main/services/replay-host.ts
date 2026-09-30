import { installReplayController } from '@/replay/controller';
import { randomUUID } from 'node:crypto';
import { session, WebContentsView } from 'electron';
import path from 'node:path';
import type { RecordingGap, ReplayPosition } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import type { RecordingEnvelope } from '@/capture/recording-types';
import { SourceModel } from '@/replay/source-model';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { ResourceArchive } from '@/resources/archive';
import { OfflineResourceService, prepareArchivedReplay, type ReplayResourceDiagnostic } from '@/resources/replay-resources';
import { OFFLINE_CSP } from '@/resources/rewrite';
import { ensure } from '@/shared/errors';
import { captureError } from '@/capture/url-privacy';
import { fitReplayViewport, replayHit, waitReplayPresentation } from './replay-presentation';
import type { StudioWindow } from '../window';
import type { ProjectMaterials } from './project-materials';
import type { ReplayHostState, ReplayOpenInput, ReplaySeekInput, ReplayPlayInput } from './client-types';
import rrwebSource from '../../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';
import rrwebStyles from '../../../node_modules/rrweb/dist/style.css?raw';

interface ActiveReplay {
  view: WebContentsView; partition: Electron.Session; state: ReplayHostState; abort?: AbortController;
  source?: SourceModel; resource?: OfflineResourceService; ready: Promise<void>; bridgeSequence: number; selectionGeneration:number;
  commandSequence:number; playIntent:boolean;
  resourcePositions: Map<number, ReplayPosition>; records?: RecordingEnvelope[];
  resourceDiagnostics?: ReplayResourceDiagnostic[]; reportedResourceDiagnostics?: Set<number>;
  protocolPending?: Map<string,Map<number,number>>;
  playback?: { end: ReplayPosition; offsets: Array<{ position: ReplayPosition; offset: number }>; gaps: RecordingGap[] };
}
/** The replay has its own ephemeral session and no preload or business profile.
 * Only original archive resources can enter it; a seek generation owns every byte. */
export class ReplayHost {
  private active?: ActiveReplay;
  private pending?: { replayId: string; projectId: string };
  constructor(private readonly window: StudioWindow, private readonly materials: ProjectMaterials, private readonly root: string) {}
  async open(body: ReplayOpenInput): Promise<ReplayHostState> {
    body=structuredClone(body);const replayId=body.replayId??randomUUID(),position=parseReplayPosition(body.position);
    ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(replayId),'Invalid replay operation ID',400);
    ensure(this.pending?.replayId!==replayId&&this.active?.state.replayId!==replayId,'Replay operation ID is already active',409);
    const request={replayId,projectId:body.projectId};this.pending=request;
    try{await this.materials.replay(position.recordingId, body.projectId);}catch(error){if(this.pending===request)this.pending=undefined;throw error;}
    if(request!==this.pending)return {replayId,projectId:body.projectId,generation:0,status:'closed',selecting:false,selectionSequence:0};
    this.pending=undefined;this.closeActive();
    const partition = session.fromPartition(`bes-replay-${replayId}`);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => {const cancel=!/^about:blank(?:#|$)|^bes-resource:\/\/archive\//.test(details.url);if(cancel&&this.active?.state.replayId===replayId&&this.active.state.resources){this.active.state.resources.blockedRequests++;this.resourceFailure(this.active,this.active.state.generation,'BLOCKED_EXTERNAL_REQUEST','Replay attempted a resource outside the offline archive');}callback({cancel});});
    partition.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-frame-navigate', event => { if(event.url !== 'about:blank')event.preventDefault(); });
    const active: ActiveReplay = { view, partition, state: { replayId, projectId: body.projectId, generation: 0, commandSequence:0, status: 'loading', selecting: false, selectionSequence: 0,playing:false,rebuilds:0,resources:{status:'loading',blockedRequests:0,failures:[]} }, bridgeSequence: 0, selectionGeneration:0, commandSequence:0,playIntent:false,ready: Promise.resolve(),resourcePositions:new Map() };
    this.active = active;
    partition.protocol.handle('bes-resource', async request => {
      const url = new URL(request.url), generation = Number(url.searchParams.get('seek')), at = Number(url.searchParams.get('at')), id = url.pathname.slice(1);
      const position = active.resourcePositions.get(at);
      if(this.active!==active || !active.resource || !position || url.hostname!=='archive' || url.hash || !/^[a-f0-9-]{36}$/.test(id) || generation!==active.state.generation)return new Response('', { status: 409 });
      const resource = active.resource;
      try {
        const result = await resource.response(id, position, resourceId => this.resourceUrl(resourceId, generation, position));
        if(this.active!==active || generation!==active.state.generation)return new Response('', { status: 409 });
        const byPosition=active.protocolPending??=new Map<string,Map<number,number>>();
        const pending=byPosition.get(id)??new Map<number,number>();
        pending.set(at,result.diagnostics.filter(diagnostic=>diagnostic.status==='pending').length);byPosition.set(id,pending);
        for(const diagnostic of result.diagnostics)if(diagnostic.status!=='pending')this.resourceFailure(active,generation,diagnostic.status,diagnostic.reason,diagnostic.url);
        return new Response(result.bytes as BodyInit, { headers: result.headers });
      } catch(error) {
        const details=captureError(error),missing=['ENOENT','RESOURCE_NOT_FOUND'].includes(details.code??'');
        if(this.active===active&&generation===active.state.generation)this.resourceFailure(active,generation,details.code??details.name,details.message,id);
        return new Response('', { status: missing?404:500 });
      }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if(input.key==='Escape' && active.state.selecting) { event.preventDefault(); void this.select(replayId,false).catch(error=>{if(this.active===active)active.state.selectionError=captureError(error).message;}); }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if(this.active===active){active.abort?.abort();active.state.status='failed';active.state.error=`Replay renderer exited (${details.reason})`;this.window.hideReplay(view);}
    });
    active.ready = (async () => {
      await view.webContents.loadURL('about:blank');
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(`document.head.innerHTML=${JSON.stringify(`<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP.replace(/"/g, '&quot;')}"><style>html,body{margin:0;height:100%;overflow:auto;background:white}#replay-stage{position:relative;overflow:hidden}#replay{position:absolute;left:0;top:0;transform-origin:top left}#selection{position:fixed;inset:0;z-index:2147483647;display:none;cursor:crosshair;background:transparent}#selected{position:fixed;pointer-events:none;border:2px solid #2563eb;z-index:2147483646;display:none}</style>`)};const replayStyle=document.createElement('style');replayStyle.textContent=${JSON.stringify(rrwebStyles)};document.head.append(replayStyle);document.body.innerHTML='<div id="replay-stage"><div id="replay"></div></div><div id="selected"></div><div id="selection" tabindex="0" aria-label="选择历史元素；Escape 退出"></div>';true`);
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(rrwebSource);
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(`(${installReplayController.toString()})(${replayHit.toString()},${fitReplayViewport.toString()},${waitReplayPresentation.toString()});true`);
    })();
    void active.ready.catch(()=>{});
    this.window.showReplay(view,false);
    return this.seek({ ...body, replayId });
  }
  private resourceUrl(id: string, generation: number, position: ReplayPosition) { return `bes-resource://archive/${id}?seek=${generation}&at=${position.eventSeq}`; }
  private resourceFailure(active: ActiveReplay, generation: number, code: string, message: string, resourceId?: string) {
    const resources=active.state.resources;if(!resources)return;
    resources.status='partial';resources.unavailableCount=(resources.unavailableCount??0)+1;
    active.state.error='归档资源缺失或读取失败；查看资源诊断';
    if(resources.failures.length<16)resources.failures.push({resourceId,generation,name:'ReplayResourceUnavailable',code,message:message.slice(0,256)});
  }
  private updateResourceDiagnostics(active: ActiveReplay, generation: number, position: ReplayPosition) {
    const resources=active.state.resources, diagnostics=active.resourceDiagnostics;if(!resources||!diagnostics)return;
    const reported=active.reportedResourceDiagnostics??=new Set<number>();
    let pending=0;
    for(const versions of active.protocolPending?.values()??[]){const latest=[...versions].filter(([at])=>at<=position.eventSeq).sort(([a],[b])=>b-a)[0];pending+=latest?.[1]??0;}
    diagnostics.forEach((diagnostic,index)=>{
      if(diagnostic.position.eventSeq>position.eventSeq)return;
      if(diagnostic.status==='pending') {
        if(!diagnostic.resolvedAt||position.eventSeq<diagnostic.resolvedAt.eventSeq)pending++;
      } else if(!reported.has(index)) {reported.add(index);this.resourceFailure(active,generation,diagnostic.status,diagnostic.reason,diagnostic.url);}
    });
    resources.pendingCount=pending;
    if(resources.status!=='partial'&&resources.status!=='loading')resources.status=pending?'pending':'ready';
  }
  private require(id: string) { ensure(this.active?.state.replayId===id, 'Replay view is no longer active', 409); return this.active; }
  private command(active:ActiveReplay,playIntent:boolean){active.playIntent=playIntent;active.state.commandSequence=++active.commandSequence;return active.commandSequence;}
  async seek(body: ReplaySeekInput): Promise<ReplayHostState> {
    const active = this.require(body.replayId), position = parseReplayPosition(body.position);
    ensure(active.state.projectId===body.projectId, 'Replay belongs to another project', 403);
    return this.render(active,position,position);
  }
  async play(body: ReplayPlayInput): Promise<ReplayHostState> {
    const active=this.require(body.replayId),end=parseReplayPosition(body.endPosition),start=active.state.position;
    ensure(active.state.projectId===body.projectId,'Replay belongs to another project',403);
    ensure(active.state.status==='ready'&&start&&!active.state.selecting,'Pause and finish historical selection before playback',409);
    ensure([0.5,1,2,4].includes(body.speed),'Unsupported replay speed',400);
    ensure(start.recordingId===end.recordingId&&start.pageId===end.pageId&&start.documentId===end.documentId&&start.streamEpoch===end.streamEpoch&&start.eventSeq<end.eventSeq,'Playback end must follow the current position in the same source stream',409);
    if(active.playback&&sameReplayPosition(active.playback.end,end)){
      const generation=active.state.generation,command=this.command(active,true),selection=++active.selectionGeneration;
      const started=await active.view.webContents.executeJavaScript(`window.__besReplayController.play(${generation},${command},${body.speed})`);
      if(this.active===active&&active.state.generation===generation&&active.commandSequence===command){active.state.playing=started===true;active.playIntent=started===true;}
      return structuredClone(active.state);
    }
    return this.render(active,end,start,body.speed);
  }
  async pause(id: string, projectId: string): Promise<ReplayHostState> {
    const active=this.require(id);ensure(active.state.projectId===projectId,'Replay belongs to another project',403);
    const generation=active.state.generation,command=this.command(active,false);
    active.state.playing=false;
    if(active.state.status==='failed')return structuredClone(active.state);
    const clock=await active.view.webContents.executeJavaScript(`window.__besReplayController.pause(${generation},${command})`);
    if(this.active===active&&active.state.generation===generation&&active.commandSequence===command&&typeof clock==='number')this.updatePlayback(active,clock,false);
    return structuredClone(active.state);
  }
  private updatePlayback(active: ActiveReplay, clock: number, playing: boolean) {
    const playback=active.playback;if(!playback)return;
    let low=0,high=playback.offsets.length;
    while(low<high){const middle=Math.floor((low+high)/2);if(playback.offsets[middle].offset<=clock+0.0001)low=middle+1;else high=middle;}
    const position=playback.offsets[Math.max(0,low-1)].position;
    active.state.position=position;active.state.playing=playing;active.playIntent=playing;
    this.updateResourceDiagnostics(active,active.state.generation,position);
    const gaps=playback.gaps.filter(gap=>gap.from.eventSeq<=position.eventSeq);
    if(active.state.state)active.state.state={...active.state.state,position,gaps,reliability:gaps.some(gap=>gap.category==='structure'||gap.category==='metadata')?'gap':'reliable'};
    if(!playing&&active.records)active.source=new SourceModel(active.records.filter(record=>record.position.eventSeq<=position.eventSeq));
  }
  private async render(active: ActiveReplay, end: ReplayPosition, start: ReplayPosition, speed?: number): Promise<ReplayHostState> {
    const generation = ++active.state.generation,command=this.command(active,speed!==undefined); active.selectionGeneration++;active.abort?.abort(); const abort = new AbortController(); active.abort=abort;
    active.state={...active.state,status:'loading',position:start,playing:false,selection:undefined,selecting:false,error:undefined,selectionError:undefined,resources:{status:'loading',blockedRequests:0,failures:[]}};active.source=undefined;active.playback=undefined;active.resourcePositions.clear();active.resourceDiagnostics=undefined;active.reportedResourceDiagnostics=undefined;active.protocolPending=new Map();
    if(speed===undefined)this.window.showReplay(active.view,false);
    try {
      await active.ready; abort.signal.throwIfAborted();
      // Destroy the previous mirror before allocating another bounded reconstruction.
      await active.view.webContents.executeJavaScript(`window.__besReplayController.reset(${generation},${command})`);
      const service=await this.materials.replay(end.recordingId,active.state.projectId),window=await service.window(end,abort.signal);
      ensure(window.records.some(record=>sameReplayPosition(record.position,start)),'Playback start is outside the bounded source window',409);
      const archive=new ResourceArchive(path.join(this.root,'runs',end.recordingId));
      const resolved=await prepareArchivedReplay(window.records,archive,(id,position)=>this.resourceUrl(id,generation,position));
      const prepared=prepareReplayEvents({...window,records:resolved.records});
      abort.signal.throwIfAborted(); if(this.active!==active||active.state.generation!==generation)return structuredClone(active.state);
      active.resource=new OfflineResourceService(archive);active.records=window.records;
      active.resourceDiagnostics=resolved.diagnostics;active.reportedResourceDiagnostics=new Set();
      active.resourcePositions=new Map(window.records.map(record=>[record.position.eventSeq,record.position]));
      const offsets=window.records.map((record,index)=>({position:record.position,offset:prepared.events[index+1].timestamp-prepared.events[0].timestamp+0.001}));
      const startOffset=offsets.find(item=>sameReplayPosition(item.position,start))!.offset;
      active.playback=speed===undefined?undefined:{end,offsets,gaps:window.gaps};
      active.source=new SourceModel(window.records.filter(record=>record.position.eventSeq<=start.eventSeq));
      const assetErrors:string[]=await active.view.webContents.executeJavaScript(`window.__besReplayController.mount(${JSON.stringify(prepared.events)},${startOffset},${generation},${command},${speed??1},${speed!==undefined})`);
      abort.signal.throwIfAborted();
      if(this.active!==active||active.state.generation!==generation)return structuredClone(active.state);
      for(const message of assetErrors)if(active.state.resources!.failures.length<16)active.state.resources!.failures.push({generation,name:'AssetReadinessError',message});
      active.state.resources!.status=active.state.resources!.failures.length?'partial':'ready';
      this.updateResourceDiagnostics(active,generation,start);
      active.bridgeSequence=0;active.state={...active.state,status:'ready',playing:speed!==undefined&&active.playIntent&&active.commandSequence===command,rebuilds:(active.state.rebuilds??0)+1,state:{position:start,reliability:window.gaps.some(gap=>gap.from.eventSeq<=start.eventSeq&&(gap.category==='structure'||gap.category==='metadata'))?'gap':'reliable',gaps:window.gaps.filter(gap=>gap.from.eventSeq<=start.eventSeq),viewport:window.records.at(-1)!.viewport}};
      if(active.state.resources!.status==='partial')active.state.error='历史结构已重建，但部分归档资源缺失、读取失败或未就绪';
      this.window.showReplay(active.view);
      return structuredClone(active.state);
    } catch(error) {
      if(abort.signal.aborted||this.active!==active)return structuredClone(active.state);
      active.state={...active.state,status:'failed',error:String(error).slice(0,1000)};return structuredClone(active.state);
    }
  }
  async status(id: string): Promise<ReplayHostState> {
    const active=this.require(id),generation=active.state.generation,command=active.commandSequence;
    if(active.state.status==='ready'&&active.state.playing&&active.playback){
      const sampled=await active.view.webContents.executeJavaScript(`(()=>{if(window.__besGeneration!==${generation})return null;return {clock:window.__besPlayer.getCurrentTime(),ended:window.__besPlaybackEnded===true};})()`);
      if(this.active===active&&generation===active.state.generation&&command===active.commandSequence&&active.state.playing&&sampled&&Number.isFinite(sampled.clock))this.updatePlayback(active,sampled.ended?Number.POSITIVE_INFINITY:sampled.clock,!sampled.ended);
    }
    if(active.state.status==='ready'&&active.state.selecting){
      const selected=await active.view.webContents.executeJavaScript('window.__besReplay');
      if(this.active===active&&generation===active.state.generation&&command===active.commandSequence&&active.state.selecting&&Number.isSafeInteger(selected?.sequence)&&selected.sequence>active.bridgeSequence){
        active.bridgeSequence=selected.sequence;
        active.state.selectionError=typeof selected.error==='string'?selected.error:undefined;
        const node=active.source?.nodes.get(selected.nodeId);
        if(node?.metadata&&active.state.position){active.state.selection={kind:'dom-node',position:active.state.position,nodeId:node.id,frameId:node.metadata.frameId,mirrorScopeId:node.metadata.mirrorScopeId};active.state.selectionSequence++;}
      }
    }
    return structuredClone(active.state);
  }
  async select(id: string, enabled: boolean): Promise<ReplayHostState> {
    const active=this.require(id);ensure(typeof enabled==='boolean','Selection flag must be boolean');
    ensure(active.state.status==='ready'&&!active.state.playing&&!active.playIntent,'Pause at an exact historical position before selecting',409);
    const generation=active.state.generation,selection=++active.selectionGeneration,command=this.command(active,false);
    const applied=await active.view.webContents.executeJavaScript(`window.__besReplayController.select(${enabled},${generation},${command})`);
    if(!applied||this.active!==active||active.state.generation!==generation||active.selectionGeneration!==selection||active.commandSequence!==command||active.state.status!=='ready')return structuredClone(active.state);
    active.state.selecting=enabled;
    if(enabled)active.view.webContents.focus();else this.window.window.webContents.focus();
    return structuredClone(active.state);
  }
  close(id?: string): ReplayHostState | undefined {
    if(!id){this.pending=undefined;return this.closeActive();}
    if(this.pending?.replayId===id){const pending=this.pending;this.pending=undefined;return {...pending,generation:0,status:'closed',selecting:false,selectionSequence:0};}
    // A concrete close only owns its own view; it cannot cancel another open.
    return this.closeActive(id);
  }
  private closeActive(id?:string):ReplayHostState|undefined{
    const active=id?this.require(id):this.active;if(!active)return;
    this.active=undefined;this.command(active,false);active.abort?.abort();active.state={...active.state,status:'closed',playing:false,selecting:false,selection:undefined};
    this.window.hideReplay(active.view);active.source=undefined;active.resource=undefined;active.records=undefined;active.playback=undefined;active.resourceDiagnostics=undefined;active.reportedResourceDiagnostics=undefined;active.protocolPending=undefined;active.resourcePositions.clear();
    if(!active.view.webContents.isDestroyed())active.view.webContents.close();
    active.partition.webRequest.onBeforeRequest(null);active.partition.protocol.unhandle('bes-resource');
    return structuredClone(active.state);
  }
}
