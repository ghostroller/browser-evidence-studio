import { afterEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CDPSession, Page } from 'puppeteer-core';
import { CaptureCoordinator } from '@/capture/coordinator';
import { StylesheetTextCapture } from '@/capture/stylesheet-text';
import { EvidenceStore } from '@/evidence/store';
import { ResourceArchive, ResourceCapture } from '@/resources/archive';
import { OfflineResourceService } from '@/resources/replay-resources';
import { observedFontMediaType } from '@/resources/font';
import { EvidenceReader } from '@/evidence/reader';

const stores:EvidenceStore[]=[];
afterEach(async()=>{for(const store of stores.splice(0))await store.close();});
const font=Buffer.concat([Buffer.from([0,1,0,0]),Buffer.alloc(12)]);
const css='.icon::before{content:"\ue6fe"}@font-face{font-family:icon;src:url("/icons.ttf")}';
const mojibake=new TextDecoder('windows-1252').decode(Buffer.from(css));

async function captured(options:{emptyCachedFont?:boolean;resourceChangeDuringProbe?:boolean}={}){
  const root=path.resolve('output/resource-encoding-tests',randomUUID());
  const store=await EvidenceStore.create(path.join(root,'runs','recording'),{id:'recording',projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'Synthetic cached CSS/font observation'});stores.push(store);
  const cdp=new EventEmitter() as EventEmitter&{send:(method:string,args?:any)=>Promise<any>};
  let binding='',cssCacheReads=0;
  const tree={frame:{id:'main',loaderId:'loader'},resources:[{url:'https://fixture.test/main.css',mimeType:'text/css',type:'Stylesheet'},{url:'https://fixture.test/icons.ttf',mimeType:'application/octet-stream',type:'Font'}]};
  cdp.send=async(method,args)=>{
    if(method==='Runtime.addBinding')binding=args.name;
    if(method==='Page.getFrameTree'||method==='Page.getResourceTree')return{frameTree:tree};
    if(method==='Page.createIsolatedWorld')return{executionContextId:1};
    if(method==='CSS.enable')cdp.emit('CSS.styleSheetAdded',{header:{styleSheetId:'sheet',frameId:'main',sourceURL:'https://fixture.test/main.css',isInline:false}});
    if(method==='CSS.getStyleSheetText')return{text:css};
    if(method==='Page.getResourceContent'){
      if(args.url.endsWith('.css')){cssCacheReads++;return{content:mojibake,base64Encoded:false};}
      if(options.resourceChangeDuringProbe){cdp.emit('Network.requestWillBeSent',{requestId:'replacement',type:'Font',frameId:'main',loaderId:'loader',request:{url:'https://fixture.test/icons.ttf',method:'GET',headers:{}}});cdp.emit('Network.loadingFailed',{requestId:'replacement',errorText:'synthetic replacement cancelled'});}
      if(options.emptyCachedFont)return{content:'',base64Encoded:false};
      return{content:font.toString('base64'),base64Encoded:true};
    }
    return{result:{}};
  };
  const capture=new CaptureCoordinator({createCDPSession:async()=>cdp} as unknown as Page,{pageId:'page',targetId:'target',webContentsId:1,navigationGeneration:0},store);
  await capture.start();
  const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:100,eventSeq:0};
  cdp.emit('Runtime.bindingCalled',{name:binding,executionContextId:1,payload:JSON.stringify({kind:'rrweb',formatVersion:2,position,event:{type:2,timestamp:100,data:{node:{type:0,id:1,childNodes:[]},initialOffset:{left:0,top:0}}},metadata:[],metadataComplete:true,errors:[],isTop:true})});
  await capture.flush();
  const archive=new ResourceArchive(store.runDir),resources=(await archive.list()).items;
  return {store,capture,archive,position,resources,cssCacheReads};
}

it('captures the renderer-decoded CSS and generic-MIME Font bytes, then serves the same cached dependency offline',async()=>{
  const f=await captured(),style=f.resources.find(r=>r.mediaType.startsWith('text/css'))!,face=f.resources.find(r=>r.mediaType==='font/ttf')!;
  expect(f.cssCacheReads).toBe(0);
  expect((await f.archive.read(style.id)).bytes.toString('utf8')).toBe(css);
  expect(style.source).toMatchObject({textSource:'renderer-stylesheet',textEncoding:'utf-8',byteRepresentation:'renderer-stylesheet-utf8'});
  expect(face.source.observedMediaType).toBe('application/octet-stream');
  expect(face.source.cacheProbeId).toBe(style.source.cacheProbeId);
  expect((await f.archive.read(face.id)).bytes).toEqual(font);
  const response=await new OfflineResourceService(f.archive).response(style.id,f.position,id=>'offline:'+id);
  expect(Buffer.from(response.bytes).toString()).toContain('content:"\ue6fe"');
  expect(Buffer.from(response.bytes).toString()).toContain('offline:'+face.id);
  expect(response.headers['content-type']).toBe('text/css; charset=utf-8');
  expect(response.diagnostics).toEqual([]);
});

it('never repairs old mojibake or borrows a font from another cache observation',async()=>{
  const f=await captured(),writer=new ResourceCapture(f.store),face=f.resources.find(r=>r.mediaType==='font/ttf')!;
  const legacy=await writer.capture({position:f.position,frameId:'top',url:'https://fixture.test/legacy.css',mediaType:'text/css',data:Buffer.from(mojibake),source:{fromCache:true,cdpFrameId:'main'}});
  const response=await new OfflineResourceService(f.archive).response(legacy.id,f.position,id=>'offline:'+id);
  expect(Buffer.from(response.bytes).toString()).toContain('content:"î›¾"');
  expect(Buffer.from(response.bytes).toString()).not.toContain('offline:'+face.id);
  expect(response.diagnostics).toContainEqual(expect.objectContaining({reason:'css-dependency-request-interval-unproven'}));
  const unrelated=await writer.capture({position:f.position,frameId:'top',url:'https://fixture.test/other.css',mediaType:'text/css',data:Buffer.from(css),source:{fromCache:true,cdpFrameId:'main',cacheProbeId:randomUUID(),cacheProbeLoaderId:'loader'}});
  const other=await new OfflineResourceService(f.archive).response(unrelated.id,f.position,id=>'offline:'+id);
  expect(Buffer.from(other.bytes).toString()).not.toContain('offline:'+face.id);
  expect(other.diagnostics).toHaveLength(1);
});

it('ambiguous cached versions stay blocked instead of choosing a URL winner',async()=>{
  const f=await captured(),style=f.resources.find(r=>r.mediaType.startsWith('text/css'))!,face=f.resources.find(r=>r.mediaType==='font/ttf')!;
  await new ResourceCapture(f.store).capture({position:f.position,frameId:'top',url:'https://fixture.test/icons.ttf',mediaType:'font/ttf',data:font,source:face.source});
  const response=await new OfflineResourceService(f.archive).response(style.id,f.position);
  expect(response.diagnostics).toContainEqual(expect.objectContaining({reason:'same-url-css-dependency-version-ambiguous'}));
});

it('renderer text lookup rejects a changed loader, changed sheet and same-URL ambiguity',async()=>{
  const cdp=new EventEmitter() as any;let loader='loader',duringRead=()=>{};
  cdp.send=async(method:string)=>{if(method==='CSS.getStyleSheetText'){duringRead();return{text:css};}return{};};
  const source=new StylesheetTextCapture(cdp as CDPSession,()=>loader);await source.start();
  const added=(id:string)=>cdp.emit('CSS.styleSheetAdded',{header:{styleSheetId:id,frameId:'main',sourceURL:'https://fixture.test/main.css',isInline:false}});
  added('one');duringRead=()=>{loader='replacement';};
  await expect(source.read('main','loader','https://fixture.test/main.css')).rejects.toThrow('scope-changed');
  loader='loader';duringRead=()=>cdp.emit('CSS.styleSheetChanged',{styleSheetId:'one'});
  await expect(source.read('main','loader','https://fixture.test/main.css')).rejects.toThrow('scope-changed');
  duringRead=()=>{};added('two');
  await expect(source.read('main','loader','https://fixture.test/main.css')).rejects.toThrow('ambiguous');
});

it('font MIME normalization requires a recognized binary signature',()=>{
  expect(observedFontMediaType(font)).toBe('font/ttf');
  expect(observedFontMediaType(Buffer.from('not actually a font despite .ttf'))).toBeUndefined();
  expect(observedFontMediaType(Buffer.from('wOF2'))).toBeUndefined();
});

it('an empty preloaded Font body is an explicit missing resource, never a captured empty font',async()=>{
  const f=await captured({emptyCachedFont:true});
  expect(f.resources.find(r=>r.mediaType==='font/unknown')).toMatchObject({status:'missing',reason:'browser-cached-font-bytes-unavailable',bytes:0});
  const style=f.resources.find(r=>r.mediaType.startsWith('text/css'))!;
  const response=await new OfflineResourceService(f.archive).response(style.id,f.position);
  expect(response.diagnostics).toContainEqual(expect.objectContaining({status:'missing',reason:'browser-cached-font-bytes-unavailable'}));
});

it('a new resource request during a cache probe cannot join the previous observation batch',async()=>{
  const f=await captured({resourceChangeDuringProbe:true});
  expect(f.resources.some(r=>r.mediaType==='font/ttf')).toBe(false);
  const events=await new EvidenceReader(f.store.runDir).events({limit:100});
  expect(events.items).toContainEqual(expect.objectContaining({type:'resource-cache-probe-skipped',data:expect.objectContaining({stage:'after-content'})}));
});
