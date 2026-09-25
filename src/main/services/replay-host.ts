import { randomUUID } from 'node:crypto';
import { session, WebContentsView } from 'electron';
import path from 'node:path';
import type { ReplayPosition } from '@/contracts/recording';
import { parseReplayPosition } from '@/contracts/recording';
import { SourceModel } from '@/replay/source-model';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { ResourceArchive } from '@/resources/archive';
import { OfflineResourceService, rewriteReplayEvent } from '@/resources/replay-resources';
import { OFFLINE_CSP } from '@/resources/rewrite';
import { ensure } from '@/shared/errors';
import type { StudioWindow } from '../window';
import type { ProjectMaterials } from './project-materials';
import type { ReplayHostState, ReplayOpenInput, ReplaySeekInput } from './client-types';
import rrwebSource from '../../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';

interface ActiveReplay {
  view: WebContentsView; partition: Electron.Session; state: ReplayHostState; abort?: AbortController;
  source?: SourceModel; resource?: OfflineResourceService; ready: Promise<void>; bridgeSequence: number;
}
/** The replay has its own ephemeral session and no preload or business profile.
 * Only original archive resources can enter it; a seek generation owns every byte. */
export class ReplayHost {
  private active?: ActiveReplay;
  constructor(private readonly window: StudioWindow, private readonly materials: ProjectMaterials, private readonly root: string) {}
  async open(body: ReplayOpenInput): Promise<ReplayHostState> {
    const position = parseReplayPosition(body.position);
    await this.materials.replay(position.recordingId, body.projectId);
    this.close();
    const replayId = randomUUID(), partition = session.fromPartition(`bes-replay-${replayId}`);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^about:blank(?:#|$)|^bes-resource:\/\/archive\//.test(details.url) }));
    partition.on('will-download', event => event.preventDefault());
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-frame-navigate', event => { if(event.url !== 'about:blank')event.preventDefault(); });
    const active: ActiveReplay = { view, partition, state: { replayId, projectId: body.projectId, generation: 0, status: 'loading', selecting: false, selectionSequence: 0 }, bridgeSequence: 0, ready: Promise.resolve() };
    this.active = active;
    partition.protocol.handle('bes-resource', async request => {
      const url = new URL(request.url), generation = Number(url.searchParams.get('seek')), id = url.pathname.slice(1);
      if(this.active!==active || !active.resource || !active.state.position || url.hostname!=='archive' || url.hash || !/^[a-f0-9-]{36}$/.test(id) || generation!==active.state.generation)return new Response('', { status: 409 });
      const position = active.state.position, resource = active.resource;
      try {
        const result = await resource.response(id, position, resourceId => this.resourceUrl(resourceId, generation));
        if(this.active!==active || generation!==active.state.generation)return new Response('', { status: 409 });
        return new Response(result.bytes as BodyInit, { headers: result.headers });
      } catch { return new Response('', { status: 404 }); }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if(input.key==='Escape' && active.state.selecting) { event.preventDefault(); void this.select(replayId, false); this.window.window.webContents.focus(); }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if(this.active===active){active.abort?.abort();active.state.status='failed';active.state.error=`Replay renderer exited (${details.reason})`;this.window.hideReplay(view);}
    });
    active.ready = (async () => {
      await view.webContents.loadURL('about:blank');
      await view.webContents.executeJavaScript(`document.head.innerHTML=${JSON.stringify(`<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP.replace(/"/g, '&quot;')}"><style>html,body{margin:0;height:100%;overflow:auto;background:white}#replay{position:relative}#selection{position:fixed;inset:0;z-index:2147483647;display:none;cursor:crosshair;background:transparent}#selected{position:fixed;pointer-events:none;border:2px solid #2563eb;z-index:2147483646;display:none}</style>`)};document.body.innerHTML='<div id="replay"></div><div id="selected"></div><div id="selection" tabindex="0" aria-label="选择历史元素；Escape 退出"></div>';true`);
      await view.webContents.executeJavaScript(rrwebSource);
      await view.webContents.executeJavaScript(`window.__besReplay={sequence:0,nodeId:null};document.querySelector('#selection').addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();const frame=document.querySelector('#replay iframe');if(!frame)return;const box=frame.getBoundingClientRect();const x=event.clientX-box.left,y=event.clientY-box.top;const node=frame.contentDocument?.elementFromPoint(x,y);const id=window.__besPlayer?.getMirror().getId(node);if(!Number.isSafeInteger(id)||id<0)return;const rect=node.getBoundingClientRect();const marker=document.querySelector('#selected');Object.assign(marker.style,{display:'block',left:(box.left+rect.left)+'px',top:(box.top+rect.top)+'px',width:rect.width+'px',height:rect.height+'px'});window.__besReplay={sequence:window.__besReplay.sequence+1,nodeId:id};});true`);
    })();
    this.window.showReplay(view);
    return this.seek({ ...body, replayId });
  }
  private resourceUrl(id: string, generation: number) { return `bes-resource://archive/${id}?seek=${generation}`; }
  private require(id: string) { ensure(this.active?.state.replayId===id, 'Replay view is no longer active', 409); return this.active; }
  async seek(body: ReplaySeekInput): Promise<ReplayHostState> {
    const active = this.require(body.replayId), position = parseReplayPosition(body.position);
    ensure(active.state.projectId===body.projectId, 'Replay belongs to another project', 403);
    const generation = ++active.state.generation; active.abort?.abort(); const abort = new AbortController(); active.abort=abort;
    active.state={...active.state,status:'loading',position,selection:undefined,selecting:false,error:undefined};active.source=undefined;
    try {
      await active.ready; abort.signal.throwIfAborted();
      // Destroy the previous mirror before allocating another bounded reconstruction.
      await active.view.webContents.executeJavaScript(`window.__besPlayer?.destroy();window.__besPlayer=null;document.querySelector('#selection').style.display='none';document.querySelector('#selected').style.display='none';true`);
      const service=await this.materials.replay(position.recordingId,body.projectId), window=await service.window(position,abort.signal);
      const archive=new ResourceArchive(path.join(this.root,'runs',position.recordingId)), urls=new Set<string>();
      for(const record of window.records)rewriteReplayEvent(record.event,url=>{urls.add(url);return url;});
      ensure(urls.size<=5000,'Replay resource URL budget exceeded',413);
      const mapping=new Map<string,string>();
      for(const url of urls){abort.signal.throwIfAborted();if(url.startsWith('#')){mapping.set(url,url);continue;}const resource=await archive.resolve(url,position,'top');if(resource?.status==='captured')mapping.set(url,this.resourceUrl(resource.id,generation));}
      const prepared=prepareReplayEvents({...window,records:window.records.map(record=>({...record,event:rewriteReplayEvent(record.event,url=>mapping.get(url)??'about:blank')}))});
      abort.signal.throwIfAborted(); if(this.active!==active||active.state.generation!==generation)return structuredClone(active.state);
      active.resource=new OfflineResourceService(archive); active.source=new SourceModel(window.records);
      await active.view.webContents.executeJavaScript(`window.__besPlayer=new rrweb.Replayer(${JSON.stringify(prepared.events)},{root:document.querySelector('#replay'),speed:1,showWarning:false,showDebug:false,UNSAFE_replayCanvas:false});window.__besPlayer.pause(${prepared.pauseOffset});window.__besReplay={sequence:0,nodeId:null};true`);
      abort.signal.throwIfAborted();
      active.bridgeSequence=0;active.state={...active.state,status:'ready',state:{position,reliability:window.gaps.some(gap=>gap.category==='structure'||gap.category==='metadata')?'gap':'reliable',gaps:window.gaps,viewport:window.records.at(-1)!.viewport}};
      return structuredClone(active.state);
    } catch(error) {
      if(abort.signal.aborted||this.active!==active)return structuredClone(active.state);
      active.state={...active.state,status:'failed',error:String(error).slice(0,1000)};return structuredClone(active.state);
    }
  }
  async status(id: string): Promise<ReplayHostState> {
    const active=this.require(id),generation=active.state.generation;
    if(active.state.status==='ready'&&active.state.selecting){
      const selected=await active.view.webContents.executeJavaScript('window.__besReplay');
      if(this.active===active&&generation===active.state.generation&&Number.isSafeInteger(selected?.sequence)&&selected.sequence>active.bridgeSequence){
        active.bridgeSequence=selected.sequence;
        const node=active.source?.nodes.get(selected.nodeId);
        if(node?.metadata&&active.state.position){active.state.selection={kind:'dom-node',position:active.state.position,nodeId:node.id,frameId:node.metadata.frameId,mirrorScopeId:node.metadata.mirrorScopeId};active.state.selectionSequence++;}
      }
    }
    return structuredClone(active.state);
  }
  async select(id: string, enabled: boolean): Promise<ReplayHostState> {
    const active=this.require(id);ensure(typeof enabled==='boolean','Selection flag must be boolean');
    ensure(active.state.status==='ready','Wait for a complete seek before selecting',409);
    active.state.selecting=enabled;
    await active.view.webContents.executeJavaScript(`document.querySelector('#selection').style.display=${JSON.stringify(enabled?'block':'none')};${enabled?"document.querySelector('#selection').focus();":"document.querySelector('#selected').style.display='none';"}true`);
    if(enabled)active.view.webContents.focus();else this.window.window.webContents.focus();
    return structuredClone(active.state);
  }
  close(id?: string): ReplayHostState | undefined {
    const active=id?this.require(id):this.active;if(!active)return;
    this.active=undefined;active.abort?.abort();active.state={...active.state,status:'closed',selecting:false,selection:undefined};
    this.window.hideReplay(active.view);active.source=undefined;active.resource=undefined;
    if(!active.view.webContents.isDestroyed())active.view.webContents.close();
    active.partition.webRequest.onBeforeRequest(null);active.partition.protocol.unhandle('bes-resource');
    return structuredClone(active.state);
  }
}
