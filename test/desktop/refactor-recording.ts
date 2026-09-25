import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
import { OfflineResourceService, resourceUrl, rewriteReplayEvent } from '@/resources/replay-resources';
import { ResourceArchive } from '@/resources/archive';
import { OFFLINE_CSP } from '@/resources/rewrite';
import rrwebSource from '../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';

interface SavedRecording {
  runId: string; originalUrl: string; recordPid: number; capturedAt: string;
  positions: Array<{ label: string; position: ReplayPosition; originalHtml: string }>;
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
  let styleVersion=0;
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css"></head><body><main id="fixture"><a id="selected" data-key="订单'&quot;" href="../orders/42">initial</a><a id="duplicate">one</a><a id="duplicate">two</a><input id="choice" type="checkbox" value="synthetic-private" checked><textarea id="private-text">synthetic-private-textarea</textarea><img id="picture" src="/assets/pixel.png"><svg><a data-key="svg" href="/svg-target"><text>svg target</text></a></svg><div id="shadow-host"></div><iframe id="child" src="/frame"></iframe><form action="/forbidden"><button id="danger" onclick="fetch('/forbidden')">action</button></form></main><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<a data-key="shadow" href="/shadow-target">shadow</a>';window.__sourceScriptRan=true;</script></body></html>`;
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('cache-control','no-store');
    if(request.url==='/switch-version'){styleVersion++;response.end('switched');}
    else if (request.url === '/assets/main.css') { response.setHeader('content-type', 'text/css'); response.end(`@import "nested.css"; @font-face {font-family:BesFixture;src:url("font.ttf")} #selected {color:${styleVersion?'rgb(51, 34, 17)':'rgb(17, 34, 51)'};font-family:BesFixture}`); }
    else if (request.url === '/assets/nested.css') { response.setHeader('content-type', 'text/css'); response.end('body {background:rgb(220, 230, 240)} #picture {width:13px;height:17px}'); }
    else if (request.url === '/assets/font.ttf') { response.setHeader('content-type', 'font/ttf'); response.end(font); }
    else if (request.url === '/assets/pixel.png') { response.setHeader('content-type', 'image/png'); response.end(png); }
    else if (request.url === '/frame') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><a data-key="frame" href="../frame-target">frame child</a>'); }
    else if (request.url?.startsWith('/privacy?')) { response.setHeader('content-type','application/json');response.end('{"ok":true}'); }
    else { response.setHeader('content-type', 'text/html'); response.end(html); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const report: Record<string, unknown> = { phase: 'record', passed: false, pid: process.pid, requests };
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
              if (observed.status === 'present' && observed.value === text) { positions.push({ label, position, originalHtml: await current.page.content() }); return; }
            }
          } catch (error) { if (Date.now() - started > 10000) throw error; }
        }
        if (Date.now() - started > 10000) throw new Error(`Production recorder never committed ${label}`);
        await delay(10);
      }
    }
    await boundary('initial', 'initial');
    await current.page.evaluate(async () => {
      const selected = document.querySelector('#selected')!; selected.textContent = 'updated'; selected.setAttribute('href', '../orders/43'); selected.setAttribute('data-empty', '');
      const input = document.querySelector('#choice') as HTMLInputElement; input.checked = false; input.dispatchEvent(new Event('input', { bubbles: true }));
      const late = document.createElement('span'); late.id = 'late'; late.textContent = 'late'; document.querySelector('#fixture')!.appendChild(late);
      await fetch('/switch-version',{method:'POST'});
      const old=document.querySelector('link[rel=stylesheet]')!;old.remove();
      await new Promise<void>((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/main.css';link.onload=()=>resolve();link.onerror=()=>reject(new Error('Updated stylesheet failed'));document.head.appendChild(link);});
    });
    await current.page.waitForFunction(()=>getComputedStyle(document.querySelector('#selected')!).color==='rgb(51, 34, 17)');
    await boundary('updated', 'updated');
    const queueMetrics = current.capture.queueMetrics;
    await studio.control('human'); await studio.seal();
    const final = current.capture.recordingPosition!;
    const resources = await new ResourceArchive(run.store.runDir).list(1000);
    for (const mediaType of ['text/css', 'image/png', 'font/ttf']) assert.ok(resources.items.some(item => item.status === 'captured' && item.mediaType === mediaType), `Production archive must contain ${mediaType}`);
    const originalFiles=['artifacts.jsonl'];for(const directory of ['raw/rrweb','raw/cdp','journal'])for(const file of await readdir(path.join(run.store.runDir,directory)))if(file.endsWith('.jsonl'))originalFiles.push(path.join(directory,file));
    for (const file of originalFiles) {const raw=await readFile(path.join(run.store.runDir,file),'utf8');assert.ok(!raw.includes('synthetic-private'),'Production originals must not leak masked input values');assert.ok(!raw.includes('synthetic-url-private'),'Production originals must not leak credential URLs');}
    const saved: SavedRecording = { runId: run.id, originalUrl: origin + '/source', recordPid: process.pid, capturedAt: new Date().toISOString(), positions, final };
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
    await writeFile(path.join(studio.root, 'refactor-recording-record-report.json'), JSON.stringify(report, null, 2));
  }
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
  partition.protocol.handle('bes-resource', async request => {
    const url = new URL(request.url); const id = url.pathname.slice(1);
    const generation=Number(url.searchParams.get('seek'));
    if (url.hostname !== 'archive' || url.hash || !/^[a-f0-9-]{36}$/.test(id)||generation!==activeGeneration) return new Response('', { status: 409 });
    const position=activePosition;
    try { const result = await resourceService.response(id, position, id=>resourceUrl(id)+`?seek=${generation}`);if(generation!==activeGeneration)return new Response('',{status:409}); return new Response(result.bytes as BodyInit, { headers: result.headers }); }
    catch { return new Response('', { status: 404 }); }
  });
  const replay = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false } });
  replay.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); replay.webContents.on('will-navigate', event => event.preventDefault());
  const rendererMessages: unknown[] = [];
  const report: Record<string, unknown> = { phase: 'offline', passed: false, pid: process.pid, recordedPid: saved.recordPid, blocked, seeks: [], rendererMessages, stage: 'created' };
  replay.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    if (rendererMessages.length < 100) rendererMessages.push({ level, message: message.slice(0, 4000), lineNumber, sourceId: sourceId.slice(0, 1000) });
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
      for(const resource of resources.items){if(resource.originalUrl.status!=='present')continue;const selected=await archive.resolve(resource.originalUrl.value,item.position,'top');if(selected?.status==='captured')mapping.set(resource.originalUrl.value,resourceUrl(selected.id)+`?seek=${generation}`);}
      const started = performance.now(), window = await service.window(item.position), model = new SourceModel(window.records);
      const prepared = prepareReplayEvents({ ...window, records: window.records.map(record => ({ ...record, event: rewriteReplayEvent(record.event, url => mapping.get(url) ?? 'about:blank') })) });
      const result = await execute(`seek-${generation}-${item.label}`, `(async()=>{window.__aPlayer?.destroy();window.__aPlayer=new rrweb.Replayer(${JSON.stringify(prepared.events)},{root:document.querySelector('#replay'),speed:1,showWarning:false,showDebug:false,UNSAFE_replayCanvas:false});window.__aPlayer.pause(${prepared.pauseOffset});const frame=document.querySelector('#replay iframe');const doc=frame.contentDocument;await Promise.race([doc.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('font readiness timeout')),5000))]);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const a=doc.querySelector('#selected'),img=doc.querySelector('#picture');return {text:a.textContent,nodeId:window.__aPlayer.getMirror().getId(a),color:frame.contentWindow.getComputedStyle(a).color,background:frame.contentWindow.getComputedStyle(doc.body).backgroundColor,font:doc.fonts.check('16px BesFixture'),image:img.complete&&img.naturalWidth>0,sandbox:frame.getAttribute('sandbox'),scriptRan:frame.contentWindow.__sourceScriptRan===true,width:frame.width,height:frame.height};})()`);
      assert.equal(result.text, item.label === 'initial' ? 'initial' : 'updated'); assert.equal(result.scriptRan, false); assert.equal(result.sandbox, 'allow-same-origin');
      assert.equal(result.color,item.label==='initial'?'rgb(17, 34, 51)':'rgb(51, 34, 17)','A seek must use that historical version of a reused stylesheet URL');
      // Native original HTML is an independent verification source, never replay DOM.
      const node = model.nodes.get(result.nodeId); assert.ok(node?.metadata);
      const ref: HistoricalElementRef = { kind: 'dom-node', position: item.position, nodeId: node.id, frameId: node.metadata.frameId, mirrorScopeId: node.metadata.mirrorScopeId };
      const locators = sourceLocators(model, ref);
      const verified = await replay.webContents.executeJavaScript(`(()=>{const doc=new DOMParser().parseFromString(${JSON.stringify(item.originalHtml)},'text/html');return ${JSON.stringify(locators)}.map(candidate=>{const step=candidate.steps.at(-1);if(step.strategy==='css'){const found=[...doc.querySelectorAll(step.expression)];return {count:found.length,target:found.some(node=>node.id==='selected')}}const query=doc.evaluate(step.expression,doc,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);return {count:query.snapshotLength,target:Array.from({length:query.snapshotLength},(_,index)=>query.snapshotItem(index)).some(node=>node.id==='selected')}})})()`);
      for (let index = 0; index < verified.length; index++) { assert.equal(verified[index].count, locators[index].historical.matchCount); assert.equal(verified[index].target, true); }
      (report.seeks as unknown[]).push({ position: item.position, durationMs: performance.now() - started, readBytes: window.readBytes, result, verified });
    }
    const last = (report.seeks as Array<{ result: { color: string; background: string; image: boolean; font: boolean } }>).at(-1)!.result;
    assert.equal(last.color, 'rgb(17, 34, 51)'); assert.equal(last.background, 'rgb(220, 230, 240)'); assert.equal(last.image, true); assert.equal(last.font, true);
    assert.deepEqual(blocked, [], 'Offline replay must not even attempt original-site network requests');
    await replay.webContents.executeJavaScript('window.__aPlayer.destroy();delete window.__aPlayer;true');
    assert.equal(await replay.webContents.executeJavaScript('document.querySelectorAll("#replay iframe").length'), 0);
    Object.assign(report, { passed: true, memory: { main: process.memoryUsage(), renderers: app.getAppMetrics().filter(metric => metric.pid === replay.webContents.getOSProcessId()).map(metric => metric.memory) } });
    return report;
  } catch(error){report.error=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);throw error;
  } finally {
    await writeFile(path.join(studio.root, 'refactor-recording-offline-report.json'), JSON.stringify(report, null, 2));
    if (!replay.isDestroyed()) replay.destroy(); partition.webRequest.onBeforeRequest(null); partition.protocol.unhandle('bes-resource');
  }
}
