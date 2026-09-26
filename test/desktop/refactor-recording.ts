import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { BrowserWindow, session, app } from 'electron';
import type { Studio } from '@/main/services/studio';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import { ArchiveReplayService } from '@/replay/service';
import { SourceModel } from '@/replay/source-model';
import { sourceLocators } from '@/replay/locators';
import { prepareReplayEvents } from '@/replay/rrweb-player';
import { OfflineResourceService, resourceUrl, rewriteReplayRecords } from '@/resources/replay-resources';
import { ResourceArchive } from '@/resources/archive';
import { OFFLINE_CSP } from '@/resources/rewrite';
import rrwebSource from '../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';

interface SavedRecording {
  runId: string; projectId: string; originalUrl: string; recordPid: number; capturedAt: string;
  positions: Array<{ label: string; position: ReplayPosition; originalHtml: string }>;
  lateImage?: { before: ReplayPosition; after: ReplayPosition };
  final: ReplayPosition;
}

/** Root schedules record then offline in DIFFERENT Electron processes with the
 * same synthetic BES_DATA. No physical input or real profile is required. */
export async function runRefactorRecordingScenario(studio: Studio, phase: 'record' | 'offline'): Promise<Record<string, unknown>> {
  return phase === 'record' ? recordScenario(studio) : offlineScenario(studio);
}
async function recordScenario(studio: Studio): Promise<Record<string, unknown>> {
  if (studio.active) await studio.seal(); if (studio.state().session) await studio.closeSession();
  // Fixture-only OS font bytes are served locally and stored in ignored BES_DATA;
  // no real recording/profile/file is imported into source control.
  const font = await readFile(path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
  const requests: string[] = [];
  const crossRequests: string[] = [];
  let styleVersion=0;
  let slowResponse: ServerResponse | undefined;
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css"><style id="cssom-style">#cssom {color:rgb(30,40,50)}</style><style id="incremental-style">#fixture {outline:1px solid blue}</style><style id="viewport-style">@media(min-width:900px){#selected{text-decoration-line:underline}}</style></head><body><main id="fixture"><div id="cssom">CSSOM</div><div id="adopted">adopted stylesheet</div><a id="selected" data-key="订单'&quot;" href="../orders/42">initial</a><a id="duplicate">one</a><a id="duplicate">two</a><input id="choice" type="checkbox" value="synthetic-private" checked><textarea id="private-text">synthetic-private-textarea</textarea><img id="picture" src="/assets/pixel.png"><svg><a data-key="svg" href="/svg-target"><text>svg target</text></a></svg><div id="shadow-host"></div><iframe id="child" src="/frame"></iframe><form action="/forbidden"><button id="danger" onclick="fetch('/forbidden')">action</button></form></main><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<a data-key="shadow" href="/shadow-target">shadow</a>';const adopted=new CSSStyleSheet();adopted.replaceSync('#adopted {color:rgb(70,80,90)}');document.adoptedStyleSheets=[adopted];window.__sourceScriptRan=true;</script></body></html>`;
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('cache-control','no-store');
    if(request.url==='/switch-version'){styleVersion++;response.end('switched');}
    else if (request.url === '/assets/main.css') { response.setHeader('content-type', 'text/css'); response.end(`@import "nested.css"; @font-face {font-family:BesFixture;src:url("font.ttf")} #selected {color:${styleVersion?'rgb(51, 34, 17)':'rgb(17, 34, 51)'};font-family:BesFixture}`); }
    else if (request.url === '/assets/nested.css') { response.setHeader('content-type', 'text/css'); response.end('body {background:rgb(220, 230, 240)} #picture {width:13px;height:17px}'); }
    else if (request.url === '/assets/frame.css') { response.setHeader('content-type','text/css');response.end('a {color:rgb(88, 99, 111)}'); }
    else if (request.url === '/assets/font.ttf') { response.setHeader('content-type', 'font/ttf'); response.end(font); }
    else if (request.url === '/assets/pixel.png') { response.setHeader('content-type', 'image/png'); response.end(png); }
    else if (request.url === '/assets/cache-picture.png') { response.setHeader('cache-control','max-age=3600');response.setHeader('content-type','image/png');response.end(png); }
    else if (request.url === '/sw.js') { response.setHeader('content-type','application/javascript');response.end(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/assets/sw-picture.png')event.respondWith(new Response(Uint8Array.from(atob('${png.toString('base64')}'),char=>char.charCodeAt(0)),{headers:{'content-type':'image/png'}}))});`); }
    else if (request.url === '/assets/sw-picture.png') { response.statusCode=500;response.end('Service Worker did not intercept'); }
    else if (request.url === '/assets/slow.png') { response.setHeader('content-type', 'image/png'); slowResponse = response; }
    else if (request.url === '/assets/style-background.png') { response.setHeader('content-type', 'image/png'); response.end(png); }
    else if (request.url === '/frame') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><link rel="stylesheet" href="/assets/frame.css"><a data-key="frame" href="../frame-target">frame child</a><img id="frame-picture" src="/assets/pixel.png">'); }
    else if (request.url?.startsWith('/privacy?')) { response.setHeader('content-type','application/json');response.end('{"ok":true}'); }
    else { response.setHeader('content-type', 'text/html'); response.end(html); }
  });
  const crossServer = createServer((request, response) => {
    crossRequests.push(request.url ?? '');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('access-control-allow-origin', '*');
    if (request.url === '/redirect.css') { response.statusCode = 302; response.setHeader('location', '/final/styles.css'); response.end(); }
    else if (request.url === '/final/styles.css') { response.setHeader('content-type', 'text/css'); response.end('@font-face {font-family:CrossFixture;src:url("../cross-font.ttf")} #fixture {border-left:7px solid rgb(9, 80, 140);font-family:CrossFixture} #cross-picture {background-image:url("../cross.png")}'); }
    else if (request.url === '/cross-font.ttf') { response.setHeader('content-type', 'font/ttf'); response.end(font); }
    else if (request.url === '/cross.png') { response.setHeader('content-type', 'image/png'); response.end(png); }
    else if (request.url === '/cross-frame') { response.setHeader('content-type','text/html');response.end('<!doctype html><a data-key="cross-frame-only" href="/private-target">cross origin frame source</a>'); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => crossServer.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const crossAddress = crossServer.address(); assert.ok(crossAddress && typeof crossAddress !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const crossOrigin = `http://127.0.0.1:${crossAddress.port}`;
  const report: Record<string, unknown> = { phase: 'record', passed: false, pid: process.pid, requests, crossRequests };
  try {
    const project = await studio.createProject({ name: 'A production recording fixture', objective: 'Source positions and offline reconstruction' });
    const profile = await studio.createProfile({ projectId: project.id, name: 'Synthetic A profile' });
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: origin + '/source' });
    await studio.control('agent');
    const current = studio.current(), run = studio.required();
    // Exercise actual network, navigation and attribute collectors. The secret
    // is passed as an argument, never embedded in a fixture script source.
    const privateUrl=origin+'/privacy?access_token=synthetic-url-private';
    await current.page.evaluate(async url=>{const link=document.createElement('a');link.id='privacy-link';link.href=url;link.textContent='private link';document.body.appendChild(link);history.replaceState(null,'',url);await fetch(url);},privateUrl);
    await current.page.waitForFunction(async () => { await document.fonts.load('16px BesFixture'); const image = document.querySelector('#picture') as HTMLImageElement | null; return !!image?.complete && image.naturalWidth > 0 && document.fonts.check('16px BesFixture') && !!document.querySelector('#child')?.getAttribute('src'); });
    const positions: SavedRecording['positions'] = [];
    async function boundary(label: string, text: string): Promise<void> {
      const started = Date.now();
      while (true) {
        await current.capture.flush(); const position = current.capture.recordingPosition;
        if (position) {
          try {
            const window = await new ArchiveReplayService(run.store.runDir).window(position), model = new SourceModel(window.records);
            const selected = [...model.nodes.values()].find(node => node.metadata?.attributes.id?.status === 'present' && node.metadata.attributes.id.value === 'selected');
            if (selected?.metadata) {
              const ref: HistoricalElementRef = { kind: 'dom-node', position, nodeId: selected.id, frameId: selected.metadata.frameId, mirrorScopeId: selected.metadata.mirrorScopeId };
              const observed=model.node(ref).text;
              if (observed.status === 'present' && observed.value === text) {
                const sample=await current.capture.samplePresentation(ref);
                assert.equal(sample.presentation.status,'present','Explicit source text observation must be available');
                if(sample.presentation.status==='present'){assert.equal(sample.presentation.value.text,text);assert.deepEqual(sample.presentation.value.sampledAt,sample.ref.position);assert.ok(sample.presentation.value.basis.includes('source-innerText'));}
                positions.push({ label, position:sample.ref.position, originalHtml: await current.page.content() }); return;
              }
            }
          } catch (error) { if (Date.now() - started > 10000) throw error; }
        }
        if (Date.now() - started > 10000) throw new Error(`Production recorder never committed ${label}`);
        await delay(10);
      }
    }
    await boundary('initial', 'initial');
    await current.page.evaluate(()=>{const node=document.createElement('div');node.id='display-check';node.innerHTML='shown<span hidden>hidden-source-text</span>';document.body.appendChild(node);});
    await delay(20);await current.capture.flush();
    const displayPosition=current.capture.recordingPosition!,displayWindow=await new ArchiveReplayService(run.store.runDir).window(displayPosition),displayModel=new SourceModel(displayWindow.records);
    const displayNode=[...displayModel.nodes.values()].find(node=>node.metadata?.attributes.id?.status==='present'&&node.metadata.attributes.id.value==='display-check');assert.ok(displayNode?.metadata);
    const displayRef:HistoricalElementRef={kind:'dom-node',position:displayPosition,nodeId:displayNode.id,frameId:displayNode.metadata.frameId,mirrorScopeId:displayNode.metadata.mirrorScopeId};
    assert.deepEqual(displayModel.node(displayRef).text,{status:'present',value:'shownhidden-source-text'});
    const cancelledSample=new AbortController();cancelledSample.abort(new Error('synthetic-presentation-cancelled'));
    await assert.rejects(current.capture.samplePresentation(displayRef,cancelledSample.signal),/synthetic-presentation-cancelled/);
    const displaySample=await current.capture.samplePresentation(displayRef);assert.equal(displaySample.presentation.status,'present');
    if(displaySample.presentation.status==='present'){assert.equal(displaySample.presentation.value.text,'shown');assert.equal(displaySample.presentation.value.visibility,'visible');}
    report.sourcePresentation=displaySample;
    await current.page.evaluate(async () => {
      (document.querySelector('#cssom-style') as HTMLStyleElement).sheet!.insertRule('#cssom {color:rgb(60,70,80)}',1);document.adoptedStyleSheets[0].replaceSync('#adopted {color:rgb(100,110,120)}');
      const selected = document.querySelector('#selected')!; selected.textContent = 'updated'; selected.setAttribute('href', '../orders/43'); selected.setAttribute('data-empty', '');
      const input = document.querySelector('#choice') as HTMLInputElement; input.checked = false; input.dispatchEvent(new Event('input', { bubbles: true }));
      const late = document.createElement('span'); late.id = 'late'; late.textContent = 'late'; document.querySelector('#fixture')!.appendChild(late);
      await fetch('/switch-version',{method:'POST'});
      const old=document.querySelector('link[rel=stylesheet]')!;old.remove();
      await new Promise<void>((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/main.css';link.onload=()=>resolve();link.onerror=()=>reject(new Error('Updated stylesheet failed'));document.head.appendChild(link);});
    });
    await current.page.waitForFunction(()=>getComputedStyle(document.querySelector('#selected')!).color==='rgb(51, 34, 17)');
    assert.deepEqual(await current.page.evaluate(()=>['cssom','adopted'].map(id=>getComputedStyle(document.getElementById(id)!).color)),['rgb(60, 70, 80)','rgb(100, 110, 120)']);
    await boundary('updated', 'updated');
    await current.page.evaluate(async crossOrigin => {
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = crossOrigin + '/redirect.css';
      await new Promise<void>((resolve, reject) => { stylesheet.onload = () => resolve(); stylesheet.onerror = () => reject(new Error('Cross-origin stylesheet failed')); document.head.appendChild(stylesheet); });
      const image = document.createElement('img'); image.id = 'cross-picture'; image.src = crossOrigin + '/cross.png'; document.querySelector('#fixture')!.appendChild(image);
      await image.decode(); await document.fonts.load('16px CrossFixture');
      const frame=document.createElement('iframe');frame.id='cross-frame';frame.src=crossOrigin+'/cross-frame';await new Promise<void>((resolve,reject)=>{frame.onload=()=>resolve();frame.onerror=()=>reject(new Error('Cross-origin iframe failed'));document.querySelector('#fixture')!.appendChild(frame);});
    }, crossOrigin);
    assert.deepEqual(await current.page.evaluate(() => { const fixture = document.querySelector('#fixture')!; const style = getComputedStyle(fixture); return { border: style.borderLeftColor, image: (document.querySelector('#cross-picture') as HTMLImageElement).naturalWidth > 0, font: document.fonts.check('16px CrossFixture') }; }),
      { border: 'rgb(9, 80, 140)', image: true, font: true });
    const inlineSource=await current.page.evaluate(async base64 => {
      const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
      const data=document.createElement('img');data.id='data-picture';data.src=`data:image/png;base64,${base64}`;document.querySelector('#fixture')!.appendChild(data);await data.decode();
      const blob=document.createElement('img');blob.id='blob-picture';blob.src=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));document.querySelector('#fixture')!.appendChild(blob);await blob.decode();
      return {data:data.naturalWidth>0,blob:blob.naturalWidth>0,blobUrl:blob.src};
    },png.toString('base64'));
    assert.ok(inlineSource.data&&inlineSource.blob,'Source data and blob images load before the recorded boundary');
    await current.capture.flush();
    report.inlineSource={data:inlineSource.data,blob:inlineSource.blob};
    const workerSource=await current.page.evaluate(async()=>{
      const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await Promise.race([new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true})),new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('Service Worker did not claim fixture page')),5000))]);
      const image=document.createElement('img');image.id='sw-picture';image.src='/assets/sw-picture.png';document.querySelector('#fixture')!.appendChild(image);await image.decode();
      const first=await fetch('/assets/cache-picture.png',{cache:'force-cache'}),second=await fetch('/assets/cache-picture.png',{cache:'force-cache'});
      await first.arrayBuffer();await second.arrayBuffer();await registration.unregister();
      return {controlled:!!navigator.serviceWorker.controller,image:image.naturalWidth>0,cacheResponses:[first.status,second.status]};
    });
    assert.deepEqual(workerSource,{controlled:true,image:true,cacheResponses:[200,200]});
    report.workerSource=workerSource;
    await current.page.evaluate(() => {
      const image = document.createElement('img');
      image.id = 'late-picture';
      image.src = '/assets/slow.png';
      document.querySelector('#fixture')!.appendChild(image);
    });
    const slowStarted = Date.now();
    while (!slowResponse) {
      if (Date.now() - slowStarted > 10000) throw new Error('Delayed image request never reached the fixture server');
      await delay(10);
    }
    const beforeStarted = Date.now();
    let lateBefore: ReplayPosition | undefined;
    while (!lateBefore) {
      await current.capture.flush();
      const position = current.capture.recordingPosition;
      if (position) {
        const window = await new ArchiveReplayService(run.store.runDir).window(position);
        if ([...new SourceModel(window.records).nodes.values()].some(node => node.metadata?.attributes.id?.status === 'present' && node.metadata.attributes.id.value === 'late-picture')) lateBefore = position;
      }
      if (Date.now() - beforeStarted > 10000) throw new Error('Delayed image insertion never entered the production recording');
      if (!lateBefore) await delay(10);
    }
    assert.equal(await current.page.evaluate(() => (document.querySelector('#late-picture') as HTMLImageElement).naturalWidth), 0);
    slowResponse.end(png);
    await current.page.waitForFunction(() => (document.querySelector('#late-picture') as HTMLImageElement).naturalWidth > 0);
    await current.capture.flush();
    await current.page.evaluate(() => document.querySelector('#fixture')!.setAttribute('data-late-image-observed', 'yes'));
    await current.capture.flush();
    const lateAfter = current.capture.recordingPosition;
    assert.ok(lateAfter && lateAfter.eventSeq > lateBefore.eventSeq, 'A later source mutation must follow the image response');
    report.lateImage = { before: lateBefore, after: lateAfter };
    await current.page.evaluate(() => {
      (document.querySelector('#incremental-style')!.firstChild as Text).data = '#fixture {background-image:url("/assets/style-background.png")}';
    });
    await current.page.waitForFunction(() => getComputedStyle(document.querySelector('#fixture')!).backgroundImage.includes('/assets/style-background.png'));
    await current.capture.flush();
    const locatorPosition=current.capture.recordingPosition!,locatorWindow=await new ArchiveReplayService(run.store.runDir).window(locatorPosition),locatorModel=new SourceModel(locatorWindow.records);
    assert.equal([...locatorModel.nodes.values()].some(node=>node.metadata?.attributes['data-key']?.status==='present'&&node.metadata.attributes['data-key'].value==='cross-frame-only'),false,'Cross-origin iframe DOM must not be claimed as captured by the top-document recorder');
    const capabilityEvents=await studio.reader(run.id).events({types:['capture-ready'],limit:10,maxBytes:16384,fields:['type','data']});
    assert.ok(capabilityEvents.items.some(event=>(event as {data?:{capabilities?:{crossOriginFrames?:string}}}).data?.capabilities?.crossOriginFrames==='unsupported'),'Observed cross-origin iframe must remain explicit in the capture capability report');
    report.crossOriginFrame='unsupported';
    const sourceChecks:unknown[]=[];
    for(const key of ['frame','shadow','svg']){
      const node=[...locatorModel.nodes.values()].find(node=>node.metadata?.attributes['data-key']?.status==='present'&&node.metadata.attributes['data-key'].value===key);assert.ok(node?.metadata,`Source metadata for ${key} must exist`);
      const ref:HistoricalElementRef={kind:'dom-node',position:locatorPosition,nodeId:node.id,frameId:node.metadata.frameId,mirrorScopeId:node.metadata.mirrorScopeId},candidates=sourceLocators(locatorModel,ref);
      const results=await current.page.evaluate(({candidates,key})=>candidates.map(candidate=>{
        let root:Document|ShadowRoot=document,found:Element[]=[];
        for(const step of candidate.steps){
          if(step.strategy==='css')found=[...root.querySelectorAll(step.expression)];
          else{const doc=root.ownerDocument??root as Document;const query=doc.evaluate(step.expression,root,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);found=Array.from({length:query.snapshotLength},(_,index)=>query.snapshotItem(index)).filter((node):node is Element=>node?.nodeType===1);}
          if(step.kind==='frame'){if(found.length!==1)throw new Error('Ambiguous frame step');const next=(found[0] as HTMLIFrameElement).contentDocument;if(!next)throw new Error('Frame document unavailable');root=next;}
          if(step.kind==='shadow'){if(found.length!==1||!found[0].shadowRoot)throw new Error('Shadow root unavailable');root=found[0].shadowRoot;}
        }
        return{count:found.length,target:found.some(node=>node.getAttribute('data-key')===key)};
      }),{candidates,key});
      candidates.forEach((candidate,index)=>{assert.equal(results[index].count,candidate.historical.matchCount);assert.equal(results[index].target,true);});
      sourceChecks.push({key,ref,candidates:candidates.length,results});
    }
    report.sourceLocatorChecks=sourceChecks;
    const queueMetrics = current.capture.queueMetrics;
    await studio.control('human'); await studio.seal();
    const final = current.capture.recordingPosition!;
    const resources = await new ResourceArchive(run.store.runDir).list(1000);
    for (const mediaType of ['text/css', 'image/png', 'font/ttf']) assert.ok(resources.items.some(item => item.status === 'captured' && item.mediaType === mediaType), `Production archive must contain ${mediaType}`);
    assert.ok(resources.items.some(item=>item.status==='captured'&&item.originalUrl.status==='present'&&item.originalUrl.value===crossOrigin+'/final/styles.css'),'Redirected cross-origin CSS must retain its observed final URL');
    assert.ok(crossRequests.includes('/redirect.css')&&crossRequests.includes('/final/styles.css')&&crossRequests.includes('/cross.png')&&crossRequests.includes('/cross-font.ttf'));
    assert.ok(resources.items.some(item=>item.status==='captured'&&item.frameId.startsWith('document-')&&item.originalUrl.status==='present'&&item.originalUrl.value.endsWith('/assets/frame.css')),'Same-origin frame CSS requires an exact logical source frame mapping');
    report.blobResource=resources.items.filter(item=>item.originalUrl.status==='present'&&item.originalUrl.value===inlineSource.blobUrl).map(item=>({status:item.status,reason:item.reason,source:item.source,bytes:item.bytes}));
    assert.ok(resources.items.some(item=>item.originalUrl.status==='present'&&item.originalUrl.value===inlineSource.blobUrl&&item.status==='captured'&&item.bytes===png.length),'Blob bytes must come from the observed browser response');
    report.cacheResources=resources.items.filter(item=>item.originalUrl.status==='present'&&item.originalUrl.value===origin+'/assets/cache-picture.png').map(item=>({status:item.status,source:item.source,bytes:item.bytes}));
    report.workerResources=resources.items.filter(item=>item.originalUrl.status==='present'&&item.originalUrl.value===origin+'/assets/sw-picture.png').map(item=>({status:item.status,source:item.source,bytes:item.bytes}));
    assert.ok(resources.items.some(item=>item.originalUrl.status==='present'&&item.originalUrl.value===origin+'/assets/cache-picture.png'&&item.status==='captured'&&item.source.fromCache&&item.bytes===png.length),'A real cache hit must retain observed bytes and provenance');
    assert.ok(resources.items.some(item=>item.originalUrl.status==='present'&&item.originalUrl.value===origin+'/assets/sw-picture.png'&&item.status==='captured'&&item.source.fromServiceWorker&&item.bytes===png.length),'A real Service Worker response must retain observed bytes and provenance');
    const originalFiles=['artifacts.jsonl'];for(const directory of ['raw/rrweb','raw/cdp','journal'])for(const file of await readdir(path.join(run.store.runDir,directory)))if(file.endsWith('.jsonl'))originalFiles.push(path.join(directory,file));
    for (const file of originalFiles) {const raw=await readFile(path.join(run.store.runDir,file),'utf8');assert.ok(!raw.includes('synthetic-private'),'Production originals must not leak masked input values');assert.ok(!raw.includes('synthetic-url-private'),'Production originals must not leak credential URLs');}
    const saved: SavedRecording = { runId: run.id, projectId: project.id, originalUrl: origin + '/source', recordPid: process.pid, capturedAt: new Date().toISOString(), positions, lateImage: { before: lateBefore, after: lateAfter }, final };
    await writeFile(path.join(studio.root, 'refactor-recording-fixture.json'), JSON.stringify(saved, null, 2));
    Object.assign(report, { passed: true, runId: run.id, positions: positions.map(item => ({ label: item.label, position: item.position })), resources: resources.items.map(item => ({ id: item.id, mediaType: item.mediaType, status: item.status, bytes: item.bytes })), queueMetrics });
    return report;
  } catch(error){report.error=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);throw error;
  } finally {
    // Persist the assertion before teardown, so an open synthetic connection
    // cannot hide the cause behind the launcher's process timeout.
    await writeFile(path.join(studio.root, 'refactor-recording-record-report.json'), JSON.stringify(report, null, 2));
    if(!studio.active&&studio.state().session)await studio.closeSession();
    server.closeIdleConnections();server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    crossServer.closeIdleConnections();crossServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => crossServer.close(error => error ? reject(error) : resolve()));
    await writeFile(path.join(studio.root, 'refactor-recording-record-report.json'), JSON.stringify(report, null, 2));
  }
}

async function waitReplayAssets(doc: Document, depth=0): Promise<string[]> {
  const errors: string[] = [];
  if(depth>8)return['Nested replay frame depth budget'];
  async function bounded(work: Promise<unknown>, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ': timeout')), 5000); })]); }
    catch(error) { errors.push(error instanceof Error ? error.message : String(error)); }
    finally { if(timer)clearTimeout(timer); }
  }
  await Promise.all([...doc.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map(link => bounded(link.sheet ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    link.addEventListener('load', () => resolve(), { once: true }); link.addEventListener('error', () => reject(new Error('stylesheet failed: ' + link.href)), { once: true });
  }), 'stylesheet ' + link.href)));
  // fonts.ready can resolve before an external stylesheet has introduced any
  // font face. Wait for the stylesheet boundary first, then request the fixture.
  await bounded(doc.fonts.load('16px BesFixture').then(() => doc.fonts.ready), 'font readiness');
  await Promise.all([...doc.images].map(image => bounded(image.decode(), 'image ' + image.src)));
  const frames=[...doc.querySelectorAll<HTMLIFrameElement>('iframe')];
  if(frames.length>32)errors.push('Nested replay frame count budget');
  for(const frame of frames.slice(0,32)){if(frame.contentDocument)errors.push(...await waitReplayAssets(frame.contentDocument,depth+1));else errors.push('Replay child document unavailable');}
  return errors;
}

async function offlineScenario(studio: Studio): Promise<Record<string, unknown>> {
  const saved = JSON.parse(await readFile(path.join(studio.root, 'refactor-recording-fixture.json'), 'utf8')) as SavedRecording;
  assert.notEqual(saved.recordPid, process.pid, 'Offline acceptance requires a fresh Electron process');
  const runDir = path.join(studio.root, 'runs', saved.runId), service = new ArchiveReplayService(runDir), archive = new ResourceArchive(runDir);
  const partition = session.fromPartition(`a-offline-${process.pid}-${Date.now()}`), blocked: string[] = [];
  partition.webRequest.onBeforeRequest((details, callback) => { if (/^https?:|^wss?:|^file:/i.test(details.url)) { blocked.push(details.url); callback({ cancel: true }); } else callback({}); });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const resourceService = new OfflineResourceService(archive);
  let activePosition=saved.final,activeGeneration=0;
  const protocolRequests: unknown[] = [];
  partition.protocol.handle('bes-resource', async request => {
    const url = new URL(request.url); const id = url.pathname.slice(1);
    const generation=Number(url.searchParams.get('seek'));
    const diagnostic: Record<string, unknown> = { id, generation, activeGeneration };
    if(protocolRequests.length<1000)protocolRequests.push(diagnostic);
    if (url.hostname !== 'archive' || url.hash || !/^[a-f0-9-]{36}$/.test(id)||generation!==activeGeneration) { diagnostic.status=409;diagnostic.reason='invalid-resource-route-or-seek-generation';return new Response('', { status: 409 }); }
    const position=activePosition;
    try { const result = await resourceService.response(id, position, id=>resourceUrl(id)+`?seek=${generation}`);if(generation!==activeGeneration){diagnostic.status=409;diagnostic.reason='seek-replaced-during-read';return new Response('',{status:409});}diagnostic.status=200;diagnostic.bytes=result.bytes.byteLength; return new Response(result.bytes as BodyInit, { headers: result.headers }); }
    catch(error) { diagnostic.status=404;diagnostic.error=error instanceof Error?{name:error.name,message:error.message}:String(error);return new Response('', { status: 404 }); }
  });
  const replay = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false } });
  replay.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); replay.webContents.on('will-navigate', event => event.preventDefault());
  const rendererMessages: unknown[] = [];
  const report: Record<string, unknown> = { phase: 'offline', passed: false, pid: process.pid, recordedPid: saved.recordPid, blocked, seeks: [], rendererMessages, protocolRequests, stage: 'created' };
  replay.webContents.on('console-message', details => {
    if (rendererMessages.length < 100) rendererMessages.push({ level: details.level, message: details.message.slice(0, 4000), lineNumber: details.lineNumber, sourceId: details.sourceId.slice(0, 1000) });
  });
  const execute = async (stage: string, script: string) => { report.stage = stage; return replay.webContents.executeJavaScript(script); };
  try {
    report.stage = 'load-shell';
    await replay.loadURL('about:blank');
    await execute('install-csp', `const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=${JSON.stringify(OFFLINE_CSP)};document.head.appendChild(policy);document.body.innerHTML='<div id="replay"></div>';true`);
    await execute('install-rrweb', rrwebSource);
    const resources = await archive.list(1000);
    for (const item of [...saved.positions, ...saved.positions].reverse()) {
      activePosition=item.position;activeGeneration++;const generation=activeGeneration;
      const mapping=new Map<string,string>();
      for(const resource of resources.items){if(resource.originalUrl.status!=='present')continue;const selected=await archive.resolve(resource.originalUrl.value,item.position,resource.frameId);if(selected?.status==='captured')mapping.set(resource.frameId+'\0'+resource.originalUrl.value,resourceUrl(selected.id)+`?seek=${generation}`);}
      const started = performance.now(), window = await service.window(item.position), model = new SourceModel(window.records);
      const prepared = prepareReplayEvents({ ...window, records: rewriteReplayRecords(window.records,(url,frameId)=>mapping.get(frameId+'\0'+url)??'about:blank') });
      const result = await execute(`seek-${generation}-${item.label}`, `(async()=>{window.__aPlayer?.destroy();window.__aPlayer=new rrweb.Replayer(${JSON.stringify(prepared.events)},{root:document.querySelector('#replay'),speed:1,showWarning:false,showDebug:false,UNSAFE_replayCanvas:false});window.__aPlayer.pause(${prepared.pauseOffset});const frame=document.querySelector('#replay iframe');const doc=frame.contentDocument;const assetErrors=await (${waitReplayAssets.toString()})(doc);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const a=doc.querySelector('#selected'),img=doc.querySelector('#picture');return {dynamicColors:['cssom','adopted'].map(id=>frame.contentWindow.getComputedStyle(doc.getElementById(id)).color),text:a.textContent,nodeId:window.__aPlayer.getMirror().getId(a),color:frame.contentWindow.getComputedStyle(a).color,background:frame.contentWindow.getComputedStyle(doc.body).backgroundColor,font:doc.fonts.check('16px BesFixture'),image:img.complete&&img.naturalWidth>0,sandbox:frame.getAttribute('sandbox'),scriptRan:frame.contentWindow.__sourceScriptRan===true,width:frame.width,height:frame.height,assetErrors,stylesheets:[...doc.querySelectorAll('link[rel=stylesheet]')].map(link=>({href:link.href,loaded:!!link.sheet}))};})()`);
      const seekReport: Record<string,unknown> = { position: item.position, durationMs: performance.now() - started, readBytes: window.readBytes, mapping: [...mapping], result };
      (report.seeks as unknown[]).push(seekReport);
      const childResult=await execute(`frame-${generation}-${item.label}`,`(()=>{const frame=document.querySelector('#replay iframe').contentDocument.querySelector('#child');const doc=frame?.contentDocument;const a=doc?.querySelector('a'),img=doc?.querySelector('#frame-picture');return {available:!!a,color:a?frame.contentWindow.getComputedStyle(a).color:null,image:!!img?.complete&&img.naturalWidth>0};})()`);
      seekReport.childResult=childResult;
      assert.equal(childResult.available,true);assert.equal(childResult.color,'rgb(88, 99, 111)');assert.equal(childResult.image,true);
      assert.equal(result.text, item.label === 'initial' ? 'initial' : 'updated'); assert.equal(result.scriptRan, false); assert.equal(result.sandbox, 'allow-same-origin');
      assert.equal(result.color,item.label==='initial'?'rgb(17, 34, 51)':'rgb(51, 34, 17)','A seek must use that historical version of a reused stylesheet URL');
      assert.deepEqual(result.dynamicColors,item.label==='initial'?['rgb(30, 40, 50)','rgb(70, 80, 90)']:['rgb(60, 70, 80)','rgb(100, 110, 120)'],'Main-world CSSOM and adopted styles must match the historical source');
      assert.deepEqual(result.assetErrors, [], 'Every archived stylesheet/image/font must finish successfully');
      // Native original HTML is an independent verification source, never replay DOM.
      const node = model.nodes.get(result.nodeId); assert.ok(node?.metadata);
      const ref: HistoricalElementRef = { kind: 'dom-node', position: item.position, nodeId: node.id, frameId: node.metadata.frameId, mirrorScopeId: node.metadata.mirrorScopeId };
      const locators = sourceLocators(model, ref);
      const verified = await replay.webContents.executeJavaScript(`(()=>{const doc=new DOMParser().parseFromString(${JSON.stringify(item.originalHtml)},'text/html');return ${JSON.stringify(locators)}.map(candidate=>{const step=candidate.steps.at(-1);if(step.strategy==='css'){const found=[...doc.querySelectorAll(step.expression)];return {count:found.length,target:found.some(node=>node.id==='selected')}}const query=doc.evaluate(step.expression,doc,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);return {count:query.snapshotLength,target:Array.from({length:query.snapshotLength},(_,index)=>query.snapshotItem(index)).some(node=>node.id==='selected')}})})()`);
      for (let index = 0; index < verified.length; index++) { assert.equal(verified[index].count, locators[index].historical.matchCount); assert.equal(verified[index].target, true); }
      seekReport.verified=verified;
    }
    const last = (report.seeks as Array<{ result: { color: string; background: string; image: boolean; font: boolean } }>).at(-1)!.result;
    assert.equal(last.color, 'rgb(17, 34, 51)'); assert.equal(last.background, 'rgb(220, 230, 240)'); assert.equal(last.image, true); assert.equal(last.font, true);
    assert.deepEqual(blocked, [], 'Offline replay must not even attempt original-site network requests');
    await replay.webContents.executeJavaScript('window.__aPlayer.destroy();delete window.__aPlayer;true');
    assert.equal(await replay.webContents.executeJavaScript('document.querySelectorAll("#replay iframe").length'), 0);
    const updated=saved.positions.find(item=>item.label==='updated')!;
    const production=await studio.replayHost.open({projectId:saved.projectId,position:updated.position});
    try {
      assert.equal(production.status,'ready',production.error);
      const native=(studio.replayHost as any).active.view.webContents;
      const observed=await native.executeJavaScript(`(()=>{const root=document.querySelector('#replay iframe'),doc=root.contentDocument,child=doc.querySelector('#child')?.contentDocument,anchor=child?.querySelector('a'),image=child?.querySelector('#frame-picture');return {cssom:root.contentWindow.getComputedStyle(doc.querySelector('#cssom')).color,adopted:root.contentWindow.getComputedStyle(doc.querySelector('#adopted')).color,frameAvailable:!!anchor,frameColor:anchor?child.defaultView.getComputedStyle(anchor).color:null,frameImage:!!image?.complete&&image.naturalWidth>0,scriptRan:root.contentWindow.__sourceScriptRan===true};})()`);
      assert.deepEqual(observed,{cssom:'rgb(60, 70, 80)',adopted:'rgb(100, 110, 120)',frameAvailable:true,frameColor:'rgb(88, 99, 111)',frameImage:true,scriptRan:false});
      assert.equal(production.resources?.status,'ready',JSON.stringify(production.resources?.failures));
      assert.equal(production.resources?.blockedRequests,0);
      const replayView=(studio.replayHost as any).active.view,originalBounds=replayView.getBounds();
      replayView.setBounds({...originalBounds,width:420,height:360});
      const fit=await native.executeJavaScript(`(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const frame=document.querySelector('#replay iframe'),selected=frame.contentDocument.querySelector('#selected');return {sourceWidth:frame.contentWindow.innerWidth,presentedWidth:frame.getBoundingClientRect().width,decoration:frame.contentWindow.getComputedStyle(selected).textDecorationLine};})()`);
      replayView.setBounds(originalBounds);
      assert.ok(fit.sourceWidth>=900&&fit.presentedWidth<=420&&fit.decoration.includes('underline'),`Replay viewport must scale presentation without changing source media queries: ${JSON.stringify(fit)}`);
      report.productionHost={status:production.status,resources:production.resources,observed,fit};
    } finally {studio.replayHost.close(production.replayId);}
    if (saved.lateImage) {
      const timeline: Record<string, unknown> = {};
      for (const [label, position] of [['before', saved.lateImage.before], ['after', saved.lateImage.after]] as const) {
        const state = await studio.replayHost.open({ projectId: saved.projectId, position });
        try {
          assert.equal(state.status, 'ready', state.error);
          const webContents = (studio.replayHost as any).active.view.webContents;
          const image = await webContents.executeJavaScript(`(() => { const image = document.querySelector('#replay iframe')?.contentDocument?.querySelector('#late-picture'); return { present: !!image, src: image?.getAttribute('src') ?? null, loaded: !!image?.naturalWidth }; })()`);
          timeline[label] = { position, image, resources: state.resources };report.productionLateImage = timeline;
          assert.equal(image.present, true, `Delayed image should exist at ${label} source position`);
          assert.equal(image.loaded, label === 'after', `Delayed image availability at ${label} must follow the recorded response`);
          assert.equal(state.resources?.status, label === 'before' ? 'pending' : 'ready', `Delayed image resource state at ${label}`);
        } finally { studio.replayHost.close(state.replayId); }
      }
      report.productionLateImage = timeline;
    }
    const finalHost = await studio.replayHost.open({ projectId: saved.projectId, position: saved.final });
    try {
      assert.equal(finalHost.status, 'ready', finalHost.error);
      const webContents = (studio.replayHost as any).active.view.webContents;
      const background = await webContents.executeJavaScript(`(async () => { try { const frame = document.querySelector('#replay iframe'), element = frame?.contentDocument?.querySelector('#fixture'); if (!frame || !element) throw new Error('Replay frame or fixture is missing'); const value = frame.contentWindow.getComputedStyle(element).backgroundImage; const raw = value.startsWith('url(') && value.endsWith(')') ? value.slice(4, -1) : ''; const url = raw.replaceAll('"', '').replaceAll("'", ''); if (!url) return { value, loaded: false }; const image = new frame.contentWindow.Image(); image.src = url; try { await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('Archived background load timed out')), 5000))]); return { value, loaded: image.naturalWidth > 0 }; } catch (error) { return { value, loaded: false, error: String(error) }; } } catch (error) { return { value: '', loaded: false, error: String(error) }; } })()`);
      assert.equal(background.error, undefined, JSON.stringify(background));
      assert.match(background.value, /bes-resource:\/\/archive\//, 'Incremental style text must use the offline archive');
      assert.equal(background.loaded, true, 'Incremental style background bytes must load offline');
      report.productionStyleText = { background, resources: finalHost.resources };
      const cross = await webContents.executeJavaScript(`(() => { const frame=document.querySelector('#replay iframe'), doc=frame.contentDocument, fixture=doc.querySelector('#fixture'), image=doc.querySelector('#cross-picture'), link=[...doc.querySelectorAll('link[rel=stylesheet]')].find(item=>item.href.includes('redirect.css')||item.href.includes('bes-resource://archive/')); return { border:frame.contentWindow.getComputedStyle(fixture).borderLeftColor, image:!!image?.complete&&image.naturalWidth>0, font:doc.fonts.check('16px CrossFixture'), stylesheets:[...doc.querySelectorAll('link[rel=stylesheet]')].map(item=>({href:item.href,loaded:!!item.sheet})) }; })()`);
      assert.equal(cross.border,'rgb(9, 80, 140)','Cross-origin redirected CSS must apply from the archive');
      assert.equal(cross.image,true,'Cross-origin image must load offline');
      assert.equal(cross.font,true,'Cross-origin font must load offline');
      report.productionCrossOrigin = cross;
      const inline=await webContents.executeJavaScript(`(() => { const doc=document.querySelector('#replay iframe').contentDocument, data=doc.querySelector('#data-picture'), blob=doc.querySelector('#blob-picture'), worker=doc.querySelector('#sw-picture');return {dataPresent:!!data,dataSource:data?.getAttribute('src')?.slice(0,22),dataLoaded:!!data?.complete&&data.naturalWidth>0,blobPresent:!!blob,blobSource:blob?.getAttribute('src')?.slice(0,22),blobLoaded:!!blob?.complete&&blob.naturalWidth>0,workerPresent:!!worker,workerSource:worker?.getAttribute('src')?.slice(0,22),workerLoaded:!!worker?.complete&&worker.naturalWidth>0};})()`);
      report.productionInlineResources={...inline,resources:finalHost.resources};
      assert.equal(inline.dataLoaded,true,'Recorded raster data URL must load within bounded offline policy');
      assert.equal(inline.blobLoaded,true,'Observed blob bytes must load from the offline resource archive');
      assert.equal(inline.blobSource,'bes-resource://archive','Replay must not depend on the source process blob URL');
      assert.equal(inline.workerLoaded,true,'Observed Service Worker response must load offline without the worker');
      assert.equal(inline.workerSource,'bes-resource://archive','Replay must serve the archived Service Worker response');
      assert.ok(cross.stylesheets.every((item:{href:string;loaded:boolean})=>item.href.startsWith('bes-resource://archive/')&&item.loaded),`Cross-origin stylesheet must use an offline URL: ${JSON.stringify(cross.stylesheets)}`);
    } finally { studio.replayHost.close(finalHost.replayId); }
    Object.assign(report, { passed: true, memory: { main: process.memoryUsage(), renderers: app.getAppMetrics().filter(metric => metric.pid === replay.webContents.getOSProcessId()).map(metric => metric.memory) } });
    return report;
  } catch(error){report.error=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);throw error;
  } finally {
    await writeFile(path.join(studio.root, 'refactor-recording-offline-report.json'), JSON.stringify(report, null, 2));
    if (!replay.isDestroyed()) replay.destroy(); partition.webRequest.onBeforeRequest(null); partition.protocol.unhandle('bes-resource');
  }
}
