import { app, BrowserWindow, protocol, session } from 'electron';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CaptureCoordinator } from '@/capture/coordinator';
import { EvidenceStore } from '@/evidence/store';
import { ResourceArchive } from '@/resources/archive';
import { OfflineResourceService } from '@/resources/replay-resources';

const root=process.env.BES_RESOURCE_PROBE_ROOT;
if(process.env.BES_TEST!=='1'||!root||!path.isAbsolute(root))throw new Error('Requires an explicit isolated synthetic root');
app.setPath('userData',path.join(root,'profile'));app.commandLine.appendSwitch('remote-debugging-port','0');
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
protocol.registerSchemesAsPrivileged([{scheme:'bes-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.on('window-all-closed',()=>{});

async function main(){
  await mkdir(root!,{recursive:true});await app.whenReady();
  const font=await readFile(path.join(process.env.WINDIR||'C:/Windows','Fonts','segmdl2.ttf'));
  let requests=0;
  const css=(second=false)=>`@font-face{font-family:${second?'ProofSecond':'ProofIcon'};src:url("/${second?'second':'icons'}.ttf")} .${second?'second':'icon'}{font-family:${second?'ProofSecond':'ProofIcon'};font-size:24px}.${second?'second':'icon'}::before{content:"${second?'\ue701':'\ue700'}"}`;
  const server=createServer((request,response)=>{
    requests++;const url=request.url;
    if(url?.endsWith('.ttf')){response.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'public,max-age=3600'});response.end(font);return;}
    if(url?.endsWith('.css')){response.writeHead(200,{'Content-Type':'text/css','Cache-Control':'public,max-age=3600'});response.end(Buffer.from(css(url==='/two.css'),'utf8'));return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/one.css"><span id="glyph" class="icon">\ue700</span>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const native=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'probe-source'}});
  const offline=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'probe-offline'}});
  assert(!native.isVisible()&&!offline.isVisible());
  let observer:Awaited<ReturnType<typeof puppeteer.connect>>|undefined,capture:CaptureCoordinator|undefined,store:EvidenceStore|undefined;
  const report:any={mode:'hidden-synthetic-only',processId:process.pid,root,fontFixture:'Windows/Fonts/segmdl2.ttf',windowsVisible:false};
  try{
    const [port]=String(await readFile(path.join(app.getPath('userData'),'DevToolsActivePort'),'utf8')).split('\n');
    const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as {webSocketDebuggerUrl:string};
    observer=await puppeteer.connect({browserWSEndpoint:version.webSocketDebuggerUrl,defaultViewport:null,networkEnabled:false});
    await native.loadURL(origin+'/');const target=await observer.waitForTarget(t=>t.url()===origin+'/');const page=await target.page();assert(page);
    await page.evaluate(()=>document.fonts.ready);
    const probe=await page.createCDPSession();const sheets:any[]=[];probe.on('CSS.styleSheetAdded',event=>sheets.push(event.header));
    await probe.send('Page.enable');await probe.send('DOM.enable');await probe.send('CSS.enable');
    const {frameTree}=await probe.send('Page.getResourceTree');
    const cached=await probe.send('Page.getResourceContent',{frameId:frameTree.frame.id,url:origin+'/one.css'});
    const sheet=sheets.find(item=>item.sourceURL===origin+'/one.css');assert(sheet);
    const decoded=await probe.send('CSS.getStyleSheetText',{styleSheetId:sheet.styleSheetId});
    const cachedFont=await probe.send('Page.getResourceContent',{frameId:frameTree.frame.id,url:origin+'/icons.ttf'}).catch(error=>({content:'',base64Encoded:false,error:String(error)}));
    report.protocol={cacheContainsCorrectIcon:cached.content.includes('\ue700'),rendererContainsCorrectIcon:decoded.text.includes('\ue700'),sameText:cached.content===decoded.text,cacheContentPoints:[...(/content:"([^"]*)"/.exec(cached.content)?.[1]??'')].map(c=>c.codePointAt(0)!.toString(16)),rendererContentPoints:[...(/content:"([^"]*)"/.exec(decoded.text)?.[1]??'')].map(c=>c.codePointAt(0)!.toString(16)),resources:frameTree.resources.map(r=>({type:r.type,mime:r.mimeType}))};
    report.protocol.cachedFont={base64:cachedFont.base64Encoded,length:cachedFont.content.length,prefix:[...cachedFont.content.slice(0,12)].map(c=>c.codePointAt(0)!.toString(16)),...('error' in cachedFont?{error:cachedFont.error}:{})};
    assert(decoded.text.includes('\ue700'));
    store=await EvidenceStore.create(path.join(root!,'runs','recording'),{id:'recording',projectId:'synthetic',mode:'synthetic',kind:'demonstrate',objective:'Hidden UTF8 cached CSS and generic-MIME font proof'});
    capture=new CaptureCoordinator(page,{pageId:'page',targetId:(target as any)._targetId,navigationGeneration:0},store);
    await capture.start();await capture.flush();
    await page.evaluate(async()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/two.css';const loaded=new Promise<void>((resolve,reject)=>{link.onload=()=>resolve();link.onerror=()=>reject(new Error('second stylesheet failed'));});document.head.append(link);await loaded;const span=document.createElement('span');span.id='second';span.className='second';span.textContent='\ue701';document.body.append(span);await document.fonts.ready;});
    await new Promise(resolve=>setTimeout(resolve,700));await capture.flush();
    await page.evaluate(()=>document.body.setAttribute('data-proof-ready','yes'));await new Promise(resolve=>setTimeout(resolve,50));await capture.flush();
    const position=capture.recordingPosition;assert(position);const archive=new ResourceArchive(store.runDir),resources=(await archive.list()).items;
    const first=resources.find(r=>r.originalUrl.status==='present'&&r.originalUrl.value===origin+'/one.css'&&r.status==='captured');
    const second=resources.find(r=>r.originalUrl.status==='present'&&r.originalUrl.value===origin+'/two.css'&&r.status==='captured');
    assert(first,'cached stylesheet must be archived');assert(second,'new network stylesheet must be archived');
    const fonts=resources.filter(r=>r.mediaType==='font/ttf'&&r.status==='captured');assert(fonts.length>=1);
    const service=new OfflineResourceService(archive),firstResponse=await service.response(first.id,position),secondResponse=await service.response(second.id,position);
    report.cachedFontDiagnostics=firstResponse.diagnostics;assert.equal(secondResponse.diagnostics.length,0);
    assert(Buffer.from(firstResponse.bytes).toString().includes('\ue700'));assert(Buffer.from(secondResponse.bytes).toString().includes('\ue701'));
    const offlineSession=session.fromPartition('probe-offline');let blockedNetwork=0;
    offlineSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{blockedNetwork++;callback({cancel:true});});
    offlineSession.protocol.handle('bes-resource',async request=>{const id=new URL(request.url).pathname.slice(1);assert(resources.some(item=>item.id===id));const result=await service.response(id,position);return new Response(result.bytes as Uint8Array<ArrayBuffer>,{headers:result.headers});});
    const requestsBefore=requests;
    await offline.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src bes-resource: 'unsafe-inline';font-src bes-resource:"><link rel="stylesheet" href="bes-resource://archive/${first.id}"><link rel="stylesheet" href="bes-resource://archive/${second.id}"><span id="glyph" class="icon">\ue700</span><span id="second" class="second">\ue701</span>`));
    await offline.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
    const offlineTarget=await observer.waitForTarget(t=>t.url().startsWith('data:text/html;charset=utf-8,'));const offlinePage=await offlineTarget.page();assert(offlinePage);
    const offlineCdp=await offlinePage.createCDPSession();await offlineCdp.send('DOM.enable');await offlineCdp.send('CSS.enable');
    const documentTree=await offlineCdp.send('DOM.getDocument');const glyph=await offlineCdp.send('DOM.querySelector',{nodeId:documentTree.root.nodeId,selector:'#second'});
    const platform=await offlineCdp.send('CSS.getPlatformFontsForNode',{nodeId:glyph.nodeId});
    report.offline={content:await offlinePage.$eval('#glyph',node=>getComputedStyle(node,'::before').content),secondContent:await offlinePage.$eval('#second',node=>getComputedStyle(node,'::before').content),fonts:platform.fonts,blockedNetwork,newSourceRequests:requests-requestsBefore};
    assert.equal(report.offline.content,'"\ue700"');assert.equal(report.offline.secondContent,'"\ue701"');assert(platform.fonts.some(face=>face.isCustomFont&&face.glyphCount>0));assert.equal(requests,requestsBefore);assert.equal(blockedNetwork,0);
    report.archived={css:2,fonts:fonts.length,statuses:resources.map(r=>({type:r.mediaType,status:r.status,reason:r.reason,representation:r.source.byteRepresentation}))};report.passed=true;
    assert(!native.isVisible()&&!offline.isVisible());
  }catch(error){report.passed=false;report.error=String(error);throw error;}
  finally{await writeFile(path.join(root!,'result.json'),JSON.stringify(report,null,2));await capture?.stop().catch(()=>{});await store?.close();await observer?.disconnect();native.destroy();offline.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
