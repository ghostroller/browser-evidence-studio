import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { ReplayHost } from '@/main/services/replay-host';
import { replayHit } from '@/main/services/replay-presentation';

const fake=vi.hoisted(()=>({views:[] as any[],partitions:[] as any[],response:vi.fn(),load:undefined as undefined|Promise<void>,selection:undefined as undefined|Promise<boolean>,script:undefined as undefined|((code:string)=>unknown),diagnostics:[] as any[]}));
vi.mock('electron',()=>({session:{fromPartition:()=>{const value={setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),webRequest:{onBeforeRequest:vi.fn()},on:vi.fn(),protocol:{handler:undefined as any,handle(_name:string,handler:any){this.handler=handler;},unhandle:vi.fn()}};fake.partitions.push(value);return value;}},WebContentsView:class{webContents={destroyed:false,setWindowOpenHandler:vi.fn(),on:vi.fn(),loadURL:vi.fn(()=>fake.load??Promise.resolve()),executeJavaScript:vi.fn(async(code:string)=>fake.script?fake.script(code):code.includes('window.__besSelectSequence=')?(fake.selection??true):code.includes('new rrweb.Replayer')?[]:true),isDestroyed:()=>this.webContents.destroyed,close:()=>{this.webContents.destroyed=true;},focus:vi.fn()};constructor(){fake.views.push(this);}}}));
vi.mock('@/main/services/replay-presentation',async importOriginal=>({...await importOriginal<typeof import('@/main/services/replay-presentation')>(),fitReplayViewport:function fitReplayViewport(){return()=>{};},waitReplayPresentation:async function waitReplayPresentation(){return await (globalThis as any).__replayPresentation??[];}}));
vi.mock('@/replay/source-model',()=>({SourceModel:class{nodes=new Map();}}));
vi.mock('@/replay/rrweb-player',()=>({prepareReplayEvents:(window:any)=>({events:[{timestamp:0},...window.records.map((record:any,index:number)=>({timestamp:index+1}))],pauseOffset:window.records.length+1})}));
vi.mock('@/resources/archive',()=>({ResourceArchive:class{resolve=vi.fn();}}));
vi.mock('@/resources/replay-resources',()=>({prepareArchivedReplay:async(records:unknown)=>({records,diagnostics:fake.diagnostics}),OfflineResourceService:class{response=fake.response;}}));
vi.mock('../../../node_modules/rrweb/dist/rrweb.umd.cjs?raw',()=>({default:'/* fixture replay */'}));
const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:1,eventSeq:1};
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(){const window={showReplay:vi.fn(),hideReplay:vi.fn(),window:{webContents:{focus:vi.fn()}}};const service={window:vi.fn(async(end:typeof position)=>({records:Array.from({length:end.eventSeq},(_,index)=>({position:{...position,eventSeq:index+1,sourceTimeMs:index+1},event:{type:index===0?2:3,timestamp:index+1},viewport:{width:800,height:600,deviceScaleFactor:1}})),gaps:[]}))};const materials={replay:vi.fn(async()=>service)};return {host:new ReplayHost(window as any,materials as any,'fixture'),window,materials,service};}
beforeEach(()=>{fake.views=[];fake.partitions=[];fake.response.mockReset();fake.load=undefined;fake.selection=undefined;fake.script=undefined;fake.diagnostics=[];});
function browserFixture(){
  const playback={play:vi.fn(),pause:vi.fn(),destroy:vi.fn()};
  class Player {clock=0;on=vi.fn();setConfig=vi.fn();getCurrentTime=()=>this.clock;getMirror=()=>({getId:()=>1});
    play=(at?:number)=>{if(at!==undefined)this.clock=at;playback.play(at);};
    pause=(at?:number)=>{if(at!==undefined)this.clock=at;playback.pause(at);};
    destroy=()=>playback.destroy();}
  const style={display:'none'},element={style,focus:vi.fn(),contentDocument:{}};
  const browser:any={};
  const context=createContext({window:browser,document:{querySelector:()=>element},rrweb:{Replayer:Player},__replayPresentation:Promise.resolve([])});
  fake.script=(code:string)=>{
    if(!code.startsWith('if((window.__besGeneration')&&!code.startsWith('window.__besCommand=')&&!code.startsWith('(async()=>{')&&!code.startsWith('(()=>{'))return true;
    return runInContext(code,context);
  };
  return {browser,playback,holdPresentation:(promise:Promise<string[]>)=>{(context as any).__replayPresentation=promise;}};
}
describe('isolated replay lifecycle',()=>{
  it('does not allow a delayed open to replace a newer native view',async()=>{const f=setup(),first=deferred<any>();f.materials.replay.mockImplementationOnce(()=>first.promise);const old=f.host.open({projectId:'project',position});const current=await f.host.open({projectId:'project',position});first.resolve(f.service);expect((await old).status).toBe('closed');expect(fake.views).toHaveLength(1);expect((await f.host.status(current.replayId)).status).toBe('ready');f.host.close();});
  it('handles destruction while shell initialization is pending',async()=>{const f=setup(),load=deferred<void>();fake.load=load.promise;const pending=f.host.open({projectId:'project',position});await vi.waitFor(()=>expect(fake.views).toHaveLength(1));f.host.close();load.reject(new Error('Destroyed during load'));expect((await pending).status).toBe('closed');expect(fake.views[0].webContents.executeJavaScript).not.toHaveBeenCalled();});
  it('does not focus or publish selection from a superseded seek',async()=>{const f=setup(),opened=await f.host.open({projectId:'project',position}),selection=deferred<boolean>();fake.selection=selection.promise;const pending=f.host.select(opened.replayId,true);await f.host.seek({projectId:'project',replayId:opened.replayId,position:{...position,eventSeq:2,sourceTimeMs:2}});selection.resolve(true);expect((await pending).selecting).toBe(false);expect(fake.views[0].webContents.focus).not.toHaveBeenCalled();f.host.close();});
  it('distinguishes corrupted and missing archive bytes with visible diagnostics',async()=>{const f=setup(),opened=await f.host.open({projectId:'project',position}),handler=fake.partitions[0].protocol.handler,id='00000000-0000-0000-0000-000000000001';fake.response.mockRejectedValueOnce(Object.assign(new Error('Archive hash mismatch'),{code:'INTEGRITY'}));expect((await handler({url:`bes-resource://archive/${id}?seek=${opened.generation}&at=${position.eventSeq}`})).status).toBe(500);fake.response.mockRejectedValueOnce(Object.assign(new Error('Missing archive bytes'),{code:'ENOENT'}));expect((await handler({url:`bes-resource://archive/${id}?seek=${opened.generation}&at=${position.eventSeq}`})).status).toBe(404);const state=await f.host.status(opened.replayId);expect(state.resources?.status).toBe('partial');expect(state.resources?.failures.map(item=>item.code)).toEqual(['INTEGRITY','ENOENT']);expect(state.error).toBeTruthy();expect(f.window.showReplay.mock.calls[0][1]).toBe(false);f.host.close();});
  it('shows pending resources only before their activation and does not report future failures early',async()=>{
    const f=setup(),third={...position,eventSeq:3,sourceTimeMs:3};
    fake.diagnostics=[
      {url:'https://source.invalid/late.png',position,status:'pending',reason:'resource-response-not-yet-observed',resolvedAt:third},
      {url:'https://source.invalid/missing.png',position:third,status:'missing',reason:'resource-not-captured'}
    ];
    const opened=await f.host.open({projectId:'project',position});
    expect(opened.resources).toMatchObject({status:'pending',pendingCount:1,failures:[]});
    expect(opened.error).toBeUndefined();
    const atThird=await f.host.seek({projectId:'project',replayId:opened.replayId,position:third});
    expect(atThird.resources).toMatchObject({status:'partial',pendingCount:0,unavailableCount:1});
    expect(atThird.resources?.failures).toHaveLength(1);
    f.host.close();
  });
  it('cancels play while archive preparation is delayed, then permits a fresh play',async()=>{
    const browser=browserFixture(),f=setup(),opened=await f.host.open({projectId:'project',position}),held=deferred<Awaited<ReturnType<typeof f.service.window>>>();
    expect(opened.status,opened.error).toBe('ready');
    const original=f.service.window.getMockImplementation()!;f.service.window.mockImplementationOnce(()=>held.promise);
    const endPosition={...position,eventSeq:3,sourceTimeMs:3},pending=f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1});
    await vi.waitFor(()=>expect(f.service.window).toHaveBeenCalledTimes(2));
    expect((await f.host.pause(opened.replayId,'project')).playing).toBe(false);
    held.resolve(await original(endPosition));
    expect((await pending).playing).toBe(false);
    expect(browser.playback.play).not.toHaveBeenCalled();
    expect((await f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1})).playing).toBe(true);
    expect(browser.playback.play).toHaveBeenCalledTimes(1);
    f.host.close();
  });
  it('cancels inside browser presentation before player.play, including a later seek',async()=>{
    const browser=browserFixture(),f=setup(),opened=await f.host.open({projectId:'project',position}),held=deferred<string[]>();
    expect(opened.status,opened.error).toBe('ready');
    browser.holdPresentation(held.promise);
    const endPosition={...position,eventSeq:3,sourceTimeMs:3},pending=f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1});
    await vi.waitFor(()=>expect(browser.playback.pause).toHaveBeenCalledTimes(2));
    await f.host.pause(opened.replayId,'project');
    held.resolve([]);expect((await pending).playing).toBe(false);
    expect(browser.playback.play).not.toHaveBeenCalled();
    const sought=await f.host.seek({projectId:'project',replayId:opened.replayId,position:{...position,eventSeq:2,sourceTimeMs:2}});
    expect(sought.position?.eventSeq).toBe(2);expect(sought.playing).toBe(false);
    f.host.close();
  });
  it('does not let preparation from a closed view start later',async()=>{
    const browser=browserFixture(),f=setup(),opened=await f.host.open({projectId:'project',position}),held=deferred<Awaited<ReturnType<typeof f.service.window>>>();
    expect(opened.status,opened.error).toBe('ready');
    f.service.window.mockImplementationOnce(()=>held.promise);
    const pending=f.host.play({projectId:'project',replayId:opened.replayId,endPosition:{...position,eventSeq:3,sourceTimeMs:3},speed:1});
    await vi.waitFor(()=>expect(f.service.window).toHaveBeenCalledTimes(2));
    expect(f.host.close(opened.replayId)?.status).toBe('closed');
    held.resolve({records:[],gaps:[]});expect((await pending).status).toBe('closed');
    expect(browser.playback.play).not.toHaveBeenCalled();
  });
  it('keeps pause ahead of an in-flight status sample in the same seek generation',async()=>{
    browserFixture();const f=setup(),opened=await f.host.open({projectId:'project',position}),endPosition={...position,eventSeq:3,sourceTimeMs:3};
    expect((await f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1})).playing).toBe(true);
    const sampled=deferred<{clock:number;ended:boolean}>(),execute=fake.script!;
    fake.script=code=>code.includes('return {clock:window.__besPlayer')?sampled.promise:execute(code);
    const pending=f.host.status(opened.replayId);
    const paused=await f.host.pause(opened.replayId,'project');
    sampled.resolve({clock:3,ended:false});
    expect((await pending).playing).toBe(false);
    expect((await f.host.status(opened.replayId)).commandSequence).toBe(paused.commandSequence);
    expect((await f.host.status(opened.replayId)).position?.eventSeq).toBe(1);
    f.host.close();
  });
  it('rejects playback during selection and keeps selection off after a fresh play',async()=>{
    const browser=browserFixture(),f=setup(),opened=await f.host.open({projectId:'project',position}),endPosition={...position,eventSeq:3,sourceTimeMs:3};
    const selected=await f.host.select(opened.replayId,true);
    expect(selected.selecting).toBe(true);
    await expect(f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1})).rejects.toThrow('Pause and finish historical selection');
    expect(browser.playback.play).not.toHaveBeenCalled();
    await f.host.select(opened.replayId,false);
    expect((await f.host.play({projectId:'project',replayId:opened.replayId,endPosition,speed:1})).playing).toBe(true);
    expect(browser.playback.play).toHaveBeenCalledTimes(1);
    browser.browser.__besPlaybackEnded=true;
    expect((await f.host.status(opened.replayId)).playing).toBe(false);
    expect((await f.host.select(opened.replayId,true)).selecting).toBe(true);
    f.host.close();
  });
  it('a seek supersedes delayed playback preparation without starting the old segment',async()=>{
    const browser=browserFixture(),f=setup(),opened=await f.host.open({projectId:'project',position}),held=deferred<Awaited<ReturnType<typeof f.service.window>>>();
    const original=f.service.window.getMockImplementation()!;f.service.window.mockImplementationOnce(()=>held.promise);
    const pending=f.host.play({projectId:'project',replayId:opened.replayId,endPosition:{...position,eventSeq:3,sourceTimeMs:3},speed:1});
    await vi.waitFor(()=>expect(f.service.window).toHaveBeenCalledTimes(2));
    const sought=await f.host.seek({projectId:'project',replayId:opened.replayId,position:{...position,eventSeq:2,sourceTimeMs:2}});
    held.resolve(await original({...position,eventSeq:3,sourceTimeMs:3}));
    expect((await pending).generation).toBe(sought.generation);
    expect(sought.position?.eventSeq).toBe(2);expect(sought.playing).toBe(false);
    expect(browser.playback.play).not.toHaveBeenCalled();
    f.host.close();
  });
  it('does not publish a late selection poll after inspection ends',async()=>{
    browserFixture();const f=setup(),opened=await f.host.open({projectId:'project',position});
    await f.host.select(opened.replayId,true);
    const selected=deferred<{sequence:number;nodeId:null;error:string}>(),execute=fake.script!;
    fake.script=code=>code==='window.__besReplay'?selected.promise:execute(code);
    const pending=f.host.status(opened.replayId);
    await f.host.select(opened.replayId,false);
    selected.resolve({sequence:1,nodeId:null,error:'stale selection'});
    expect((await pending).selectionError).toBeUndefined();
    expect((await f.host.status(opened.replayId)).selecting).toBe(false);
    f.host.close();
  });
});
it('selects the actual element through scaled nested frame and open shadow boundaries',()=>{const target={tagName:'SPAN',getBoundingClientRect:()=>({left:4,top:6,width:10,height:8})},shadow={tagName:'DIV',shadowRoot:{elementFromPoint:()=>target}},child={tagName:'IFRAME',getBoundingClientRect:()=>({left:10,top:20,width:200,height:100}),contentWindow:{innerWidth:100,innerHeight:50},contentDocument:{elementFromPoint:()=>shadow}},frame={getBoundingClientRect:()=>({left:50,top:80,width:400,height:300}),contentWindow:{innerWidth:200,innerHeight:150},contentDocument:{elementFromPoint:()=>child}};const hit=replayHit(frame as any,100,150);expect(hit?.node).toBe(target);expect(hit?.rect).toEqual({x:86,y:144,width:40,height:32});child.contentDocument=null as any;expect(replayHit(frame as any,100,150)).toBeUndefined();});
