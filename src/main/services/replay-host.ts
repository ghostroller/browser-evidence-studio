import { randomUUID } from 'node:crypto';
import { session, WebContentsView } from 'electron';
import path from 'node:path';
import type { RecordingGap, ReplayPosition } from '@/contracts/recording';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';
import type { RecordingEnvelope } from '@/capture/recording-types';
import { SourceModel } from '@/replay/source-model';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { ResourceArchive } from '@/resources/archive';
import { OfflineResourceService, prepareArchivedReplay } from '@/resources/replay-resources';
import { OFFLINE_CSP } from '@/resources/rewrite';
import { ensure } from '@/shared/errors';
import { captureError } from '@/capture/url-privacy';
import { replayHit, waitReplayPresentation } from './replay-presentation';
import type { StudioWindow } from '../window';
import type { ProjectMaterials } from './project-materials';
import type { ReplayHostState, ReplayOpenInput, ReplaySeekInput, ReplayPlayInput } from './client-types';
import rrwebSource from '../../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';

interface ActiveReplay {
  view: WebContentsView; partition: Electron.Session; state: ReplayHostState; abort?: AbortController;
  source?: SourceModel; resource?: OfflineResourceService; ready: Promise<void>; bridgeSequence: number; selectionGeneration:number;
  resourcePositions: Map<number, ReplayPosition>; records?: RecordingEnvelope[];
  playback?: { end: ReplayPosition; offsets: Array<{ position: ReplayPosition; offset: number }>; gaps: RecordingGap[] };
}
/** The replay has its own ephemeral session and no preload or business profile.
 * Only original archive resources can enter it; a seek generation owns every byte. */
export class ReplayHost {
  private active?: ActiveReplay;
  private lifetime=0;
  constructor(private readonly window: StudioWindow, private readonly materials: ProjectMaterials, private readonly root: string) {}
  async open(body: ReplayOpenInput): Promise<ReplayHostState> {
    body=structuredClone(body);const request=++this.lifetime,replayId=randomUUID(),position = parseReplayPosition(body.position);
    await this.materials.replay(position.recordingId, body.projectId);
    if(request!==this.lifetime)return {replayId,projectId:body.projectId,generation:0,status:'closed',selecting:false,selectionSequence:0};
    this.closeActive();
    const partition = session.fromPartition(`bes-replay-${replayId}`);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => {const cancel=!/^about:blank(?:#|$)|^bes-resource:\/\/archive\//.test(details.url);if(cancel&&this.active?.state.replayId===replayId&&this.active.state.resources){this.active.state.resources.blockedRequests++;this.resourceFailure(this.active,this.active.state.generation,'BLOCKED_EXTERNAL_REQUEST','Replay attempted a resource outside the offline archive');}callback({cancel});});
    partition.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-frame-navigate', event => { if(event.url !== 'about:blank')event.preventDefault(); });
    const active: ActiveReplay = { view, partition, state: { replayId, projectId: body.projectId, generation: 0, status: 'loading', selecting: false, selectionSequence: 0,playing:false,rebuilds:0,resources:{status:'loading',blockedRequests:0,failures:[]} }, bridgeSequence: 0, selectionGeneration:0, ready: Promise.resolve(),resourcePositions:new Map() };
    this.active = active;
    partition.protocol.handle('bes-resource', async request => {
      const url = new URL(request.url), generation = Number(url.searchParams.get('seek')), at = Number(url.searchParams.get('at')), id = url.pathname.slice(1);
      const position = active.resourcePositions.get(at);
      if(this.active!==active || !active.resource || !position || url.hostname!=='archive' || url.hash || !/^[a-f0-9-]{36}$/.test(id) || generation!==active.state.generation)return new Response('', { status: 409 });
      const resource = active.resource;
      try {
        const result = await resource.response(id, position, resourceId => this.resourceUrl(resourceId, generation, position));
        if(this.active!==active || generation!==active.state.generation)return new Response('', { status: 409 });
        for(const diagnostic of result.diagnostics)this.resourceFailure(active,generation,diagnostic.status,diagnostic.reason,diagnostic.url);
        return new Response(result.bytes as BodyInit, { headers: result.headers });
      } catch(error) {
        const details=captureError(error),missing=['ENOENT','RESOURCE_NOT_FOUND'].includes(details.code??'');
        if(this.active===active&&generation===active.state.generation)this.resourceFailure(active,generation,details.code??details.name,details.message,id);
        return new Response('', { status: missing?404:500 });
      }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if(input.key==='Escape' && active.state.selecting) { event.preventDefault(); void this.select(replayId, false).catch(()=>{}); }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if(this.active===active){active.abort?.abort();active.state.status='failed';active.state.error=`Replay renderer exited (${details.reason})`;this.window.hideReplay(view);}
    });
    active.ready = (async () => {
      await view.webContents.loadURL('about:blank');
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(`document.head.innerHTML=${JSON.stringify(`<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP.replace(/"/g, '&quot;')}"><style>html,body{margin:0;height:100%;overflow:auto;background:white}#replay{position:relative}#selection{position:fixed;inset:0;z-index:2147483647;display:none;cursor:crosshair;background:transparent}#selected{position:fixed;pointer-events:none;border:2px solid #2563eb;z-index:2147483646;display:none}</style>`)};document.body.innerHTML='<div id="replay"></div><div id="selected"></div><div id="selection" tabindex="0" aria-label="选择历史元素；Escape 退出"></div>';true`);
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(rrwebSource);
      if(this.active!==active||view.webContents.isDestroyed())return;
      await view.webContents.executeJavaScript(`window.__besReplay={sequence:0,nodeId:null};document.querySelector('#selection').addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();const frame=document.querySelector('#replay iframe');if(!frame)return;const hit=(${replayHit.toString()})(frame,event.clientX,event.clientY);const id=hit&&window.__besPlayer?.getMirror().getId(hit.node);if(!Number.isSafeInteger(id)||id<0){window.__besReplay={sequence:window.__besReplay.sequence+1,nodeId:null,error:'此位置没有可解析的源节点；frame/shadow可能不可用'};return;}const marker=document.querySelector('#selected');Object.assign(marker.style,{display:'block',left:hit.rect.x+'px',top:hit.rect.y+'px',width:hit.rect.width+'px',height:hit.rect.height+'px'});window.__besReplay={sequence:window.__besReplay.sequence+1,nodeId:id};});true`);
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
  private require(id: string) { ensure(this.active?.state.replayId===id, 'Replay view is no longer active', 409); return this.active; }
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
      const generation=active.state.generation;
      await active.view.webContents.executeJavaScript(`(()=>{if(window.__besGeneration!==${generation})return false;window.__besPlayer.setConfig({speed:${body.speed}});window.__besPlaybackEnded=false;window.__besPlayer.play(window.__besPlayer.getCurrentTime());return true;})()`);
      if(this.active===active&&active.state.generation===generation)active.state.playing=true;
      return structuredClone(active.state);
    }
    return this.render(active,end,start,body.speed);
  }
  async pause(id: string, projectId: string): Promise<ReplayHostState> {
    const active=this.require(id);ensure(active.state.projectId===projectId,'Replay belongs to another project',403);
    if(active.state.status!=='ready'||!active.state.playing)return structuredClone(active.state);
    const generation=active.state.generation;
    const clock=await active.view.webContents.executeJavaScript(`(()=>{if(window.__besGeneration!==${generation})return null;window.__besPlayer.pause();return window.__besPlayer.getCurrentTime();})()`);
    if(this.active===active&&active.state.generation===generation&&typeof clock==='number')this.updatePlayback(active,clock,false);
    return structuredClone(active.state);
  }
  private updatePlayback(active: ActiveReplay, clock: number, playing: boolean) {
    const playback=active.playback;if(!playback)return;
    let low=0,high=playback.offsets.length;
    while(low<high){const middle=Math.floor((low+high)/2);if(playback.offsets[middle].offset<=clock+0.0001)low=middle+1;else high=middle;}
    const position=playback.offsets[Math.max(0,low-1)].position;
    active.state.position=position;active.state.playing=playing;
    const gaps=playback.gaps.filter(gap=>gap.from.eventSeq<=position.eventSeq);
    if(active.state.state)active.state.state={...active.state.state,position,gaps,reliability:gaps.some(gap=>gap.category==='structure'||gap.category==='metadata')?'gap':'reliable'};
    if(!playing&&active.records)active.source=new SourceModel(active.records.filter(record=>record.position.eventSeq<=position.eventSeq));
  }
  private async render(active: ActiveReplay, end: ReplayPosition, start: ReplayPosition, speed?: number): Promise<ReplayHostState> {
    const generation = ++active.state.generation; active.selectionGeneration++;active.abort?.abort(); const abort = new AbortController(); active.abort=abort;
    active.state={...active.state,status:'loading',position:start,playing:false,selection:undefined,selecting:false,error:undefined,selectionError:undefined,resources:{status:'loading',blockedRequests:0,failures:[]}};active.source=undefined;active.playback=undefined;active.resourcePositions.clear();
    if(speed===undefined)this.window.showReplay(active.view,false);
    try {
      await active.ready; abort.signal.throwIfAborted();
      // Destroy the previous mirror before allocating another bounded reconstruction.
      await active.view.webContents.executeJavaScript(`window.__besGeneration=${generation};window.__besPlayer?.destroy();window.__besPlayer=null;document.querySelector('#selection').style.display='none';document.querySelector('#selected').style.display='none';true`);
      const service=await this.materials.replay(end.recordingId,active.state.projectId),window=await service.window(end,abort.signal);
      ensure(window.records.some(record=>sameReplayPosition(record.position,start)),'Playback start is outside the bounded source window',409);
      const archive=new ResourceArchive(path.join(this.root,'runs',end.recordingId));
      const resolved=await prepareArchivedReplay(window.records,archive,(id,position)=>this.resourceUrl(id,generation,position));
      const prepared=prepareReplayEvents({...window,records:resolved.records});
      abort.signal.throwIfAborted(); if(this.active!==active||active.state.generation!==generation)return structuredClone(active.state);
      active.resource=new OfflineResourceService(archive);active.records=window.records;
      active.resourcePositions=new Map(window.records.map(record=>[record.position.eventSeq,record.position]));
      const offsets=window.records.map((record,index)=>({position:record.position,offset:prepared.events[index+1].timestamp-prepared.events[0].timestamp+0.001}));
      const startOffset=offsets.find(item=>sameReplayPosition(item.position,start))!.offset;
      active.playback=speed===undefined?undefined:{end,offsets,gaps:window.gaps};
      active.source=new SourceModel(window.records.filter(record=>record.position.eventSeq<=start.eventSeq));
      for(const diagnostic of resolved.diagnostics)this.resourceFailure(active,generation,diagnostic.status,diagnostic.reason,diagnostic.url);
      const assetErrors:string[]=await active.view.webContents.executeJavaScript(`(async()=>{if(window.__besGeneration!==${generation})return [];const player=new rrweb.Replayer(${JSON.stringify(prepared.events)},{root:document.querySelector('#replay'),speed:${speed??1},showWarning:false,showDebug:false,UNSAFE_replayCanvas:false});window.__besPlayer=player;window.__besPlaybackEnded=false;player.on('finish',()=>{if(window.__besGeneration===${generation}&&window.__besPlayer===player)window.__besPlaybackEnded=true});player.pause(${startOffset});window.__besReplay={sequence:0,nodeId:null};const failures=await (${waitReplayPresentation.toString()})(document.querySelector('#replay iframe').contentDocument,${generation});${speed!==undefined?`player.play(${startOffset});`:''}return failures;})()`);
      abort.signal.throwIfAborted();
      if(this.active!==active||active.state.generation!==generation)return structuredClone(active.state);
      for(const message of assetErrors)if(active.state.resources!.failures.length<16)active.state.resources!.failures.push({generation,name:'AssetReadinessError',message});
      active.state.resources!.status=active.state.resources!.failures.length?'partial':'ready';
      active.bridgeSequence=0;active.state={...active.state,status:'ready',playing:speed!==undefined,rebuilds:(active.state.rebuilds??0)+1,state:{position:start,reliability:window.gaps.some(gap=>gap.from.eventSeq<=start.eventSeq&&(gap.category==='structure'||gap.category==='metadata'))?'gap':'reliable',gaps:window.gaps.filter(gap=>gap.from.eventSeq<=start.eventSeq),viewport:window.records.at(-1)!.viewport}};
      if(active.state.resources!.status==='partial')active.state.error='历史结构已重建，但部分归档资源缺失、读取失败或未就绪';
      this.window.showReplay(active.view);
      return structuredClone(active.state);
    } catch(error) {
      if(abort.signal.aborted||this.active!==active)return structuredClone(active.state);
      active.state={...active.state,status:'failed',error:String(error).slice(0,1000)};return structuredClone(active.state);
    }
  }
  async status(id: string): Promise<ReplayHostState> {
    const active=this.require(id),generation=active.state.generation;
    if(active.state.status==='ready'&&active.state.playing&&active.playback){
      const sampled=await active.view.webContents.executeJavaScript(`(()=>{if(window.__besGeneration!==${generation})return null;return {clock:window.__besPlayer.getCurrentTime(),ended:window.__besPlaybackEnded===true};})()`);
      if(this.active===active&&generation===active.state.generation&&sampled&&Number.isFinite(sampled.clock))this.updatePlayback(active,sampled.ended?Number.POSITIVE_INFINITY:sampled.clock,!sampled.ended);
    }
    if(active.state.status==='ready'&&active.state.selecting){
      const selected=await active.view.webContents.executeJavaScript('window.__besReplay');
      if(this.active===active&&generation===active.state.generation&&Number.isSafeInteger(selected?.sequence)&&selected.sequence>active.bridgeSequence){
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
    ensure(active.state.status==='ready'&&!active.state.playing,'Pause at an exact historical position before selecting',409);
    const generation=active.state.generation,selection=++active.selectionGeneration;
    const applied=await active.view.webContents.executeJavaScript(`(()=>{if(window.__besGeneration!==${generation}||(window.__besSelectSequence||0)>${selection})return false;window.__besSelectSequence=${selection};document.querySelector('#selection').style.display=${JSON.stringify(enabled?'block':'none')};${enabled?"document.querySelector('#selection').focus();":"document.querySelector('#selected').style.display='none';"}return true;})()`);
    if(!applied||this.active!==active||active.state.generation!==generation||active.selectionGeneration!==selection||active.state.status!=='ready')return structuredClone(active.state);
    active.state.selecting=enabled;
    if(enabled)active.view.webContents.focus();else this.window.window.webContents.focus();
    return structuredClone(active.state);
  }
  close(id?: string): ReplayHostState | undefined {
    this.lifetime++;return this.closeActive(id);
  }
  private closeActive(id?:string):ReplayHostState|undefined{
    const active=id?this.require(id):this.active;if(!active)return;
    this.active=undefined;active.abort?.abort();active.state={...active.state,status:'closed',playing:false,selecting:false,selection:undefined};
    this.window.hideReplay(active.view);active.source=undefined;active.resource=undefined;active.records=undefined;active.playback=undefined;active.resourcePositions.clear();
    if(!active.view.webContents.isDestroyed())active.view.webContents.close();
    active.partition.webRequest.onBeforeRequest(null);active.partition.protocol.unhandle('bes-resource');
    return structuredClone(active.state);
  }
}
