import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {repo} from './source-manifest.mjs';
import {until,click,fill,select,disclose,hasText,delay} from './ui.mjs';
import {launchWithRedactedConsole} from './launch-capture.mjs';
import {ownedProcessTree,assertNoElectronDependency,isAlive} from './process-evidence.mjs';
import {recordingFacts,fileTreeHashes} from './source-evidence.mjs';

const require=createRequire(repo+'/package.json'),pp=require('puppeteer-core');
export const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export async function readCurrent(c){const cat=await readJson(c.materialRoot+'/catalog.json');return readJson(c.materialRoot+'/drafts/'+cat.workingDraftId+'.json')}
export async function originalHashes(root){return Object.fromEntries(Object.entries(await fileTreeHashes(root)).filter(([name])=>!name.startsWith('replay-index/')&&!name.startsWith('index/')))}
export const observedState=(c,predicate=()=>true,label='owner state')=>until(()=>c.ownerState,s=>s&&predicate(s),label,60000);

async function observeBrowser(c){
  c.cb=await pp.launch({executablePath:c.chromium,headless:false,userDataDir:c.root+'/isolated-ui-profile',defaultViewport:{width:1450,height:935}});
  c.report.uiBrowserVersion=await c.cb.version();
  c.web=await c.cb.newPage();c.report.scopeInvalidations=[];
  const network=await c.web.createCDPSession();await network.send('Network.enable');const streamed=new Set(),buffers=new Map();
  const consume=(id,data)=>{let text=(buffers.get(id)??'')+Buffer.from(data,'base64').toString('utf8');const frames=text.split('\n\n');buffers.set(id,frames.pop());for(const frame of frames)if(frame.includes('event: scope-invalidated')){const line=frame.split('\n').find(x=>x.startsWith('data: '));if(line)try{const value=JSON.parse(line.slice(6));c.report.scopeInvalidations.push({projectId:value.projectId,at:Date.now()})}catch{}}};
  network.on('Network.responseReceived',async event=>{if(new URL(event.response.url).pathname!=='/workbench/events')return;try{streamed.add(event.requestId);const r=await network.send('Network.streamResourceContent',{requestId:event.requestId});if(r.bufferedData)consume(event.requestId,r.bufferedData)}catch(error){c.report.sseObservationError=String(error)}});
  network.on('Network.dataReceived',event=>{if(streamed.has(event.requestId)&&event.data)consume(event.requestId,event.data)});
  c.report.pageErrors=[];c.report.rpc=[];c.report.responses=[];c.report.unexpectedWebRequests=[];
  c.web.on('pageerror',e=>c.report.pageErrors.push({surface:'workbench',message:e.message}));
  c.web.on('request',request=>{
    const url=new URL(request.url());
    if(/^https?:$/.test(url.protocol)&&![c.launch.frontendOrigin,c.launch.backendOrigin,c.launch.replayOrigin].includes(url.origin))c.report.unexpectedWebRequests.push({url:request.url(),type:request.resourceType()});
    if(url.pathname==='/workbench/rpc')try{const q=JSON.parse(request.postData());c.report.rpc.push({method:q.method,at:Date.now(),...(['webReplayBundle','webReplaySelection'].includes(q.method)?{replayId:q.body.replayId,generation:q.body.generation,position:q.body.position,nodeId:q.body.nodeId}:{})})}catch{}
  });
  c.web.on('response',response=>{if(new URL(response.url()).pathname.startsWith('/workbench/')){let method;try{method=JSON.parse(response.request().postData()).method}catch{}c.report.responses.push({path:new URL(response.url()).pathname,method,status:response.status()})}});
  await c.web.goto(c.launch.browserUrl);assert.equal(await c.web.$eval('meta[name="workbench-instance"]',e=>e.content),c.launch.instanceId);
}

export async function startHost({host,root,chromium},report){
  const c={host,root,chromium,report};await fs.mkdir(root,{recursive:true});
  const existing=new Set(await fs.readdir(repo+'/output').catch(()=>[]));
  const args=host==='node'?[repo+'/.vite/node/node-studio.js','--dev-cooperative-input','--chromium',chromium]:[repo+'/scripts/start-workbench.mjs'];
  c.launcher=await launchWithRedactedConsole({args,cwd:repo,env:process.env,logPath:root+'/launcher.log',ticketPattern:host==='node'?/(?:owner|bootstrap|启动器|票据).*?([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i:undefined});
  try{
    c.launch=await until(async()=>{
      for(const entry of await fs.readdir(repo+'/output'))if(!existing.has(entry))try{const launch=await readJson(repo+'/output/'+entry+'/launch.json');if(launch.status==='ready'&&(host==='node'?launch.processId===c.launcher.child.pid:launch.backendKind==='electron-companion'))return launch}catch{}
      if(c.launcher.child.exitCode!==null)throw Error('Host launcher exited before readiness');
    },Boolean,'owned '+host+' launch manifest',90000);
    report.identity=c.launch;report.launcherPid=c.launcher.child.pid;
    await observeBrowser(c);
    if(host==='electron'){
      const[port,endpoint]=(await fs.readFile(c.launch.dataRoot+'/DevToolsActivePort','utf8')).trim().split(/\r?\n/);
      c.eb=await pp.connect({browserWSEndpoint:`ws://127.0.0.1:${port}${endpoint}`,defaultViewport:null});
      c.ui=await c.eb.waitForTarget(t=>t.url().includes('/main_window/index.html')).then(t=>t.page());await c.ui.waitForSelector('.evidence-strip');
      assert.equal(c.launch.runtimeProvider,'electron');c.providerPid=c.launch.companionProcessId;
    }else{
      assert.equal(c.launch.runtimeProvider,'chromium');assertNoElectronDependency(ownedProcessTree([c.launcher.child.pid]));
      assert.deepEqual(c.launch.executionPolicy,{executionMode:'cooperative-dev-test',inputIsolation:'none',physicalInputExclusive:false,interferenceDetection:'partial',humanHandoff:'unsupported'});
      c.ui=await c.cb.newPage();report.ownerCalls=[];
      c.ui.on('pageerror',e=>report.pageErrors.push({surface:'owner',message:e.message}));
      c.ui.on('response',async response=>{if(new URL(response.url()).pathname!=='/owner/rpc')return;try{const request=JSON.parse(response.request().postData()),call={method:request.method,status:response.status()};report.ownerCalls.push(call);if(!response.ok()){call.error=await response.json();c.lastOwnerFailure=call}if(request.method==='state'&&response.ok()){const state=await response.json();assert.equal(state.instanceId,c.launch.instanceId);c.ownerState=state}}catch(error){report.observerErrors??=[];report.observerErrors.push(String(error))}});
      await c.ui.goto(c.launch.ownerUrl);let ticket=await c.launcher.readTicket();await fill(c.ui,'启动器一次性票据',ticket);ticket='';c.launcher.clearTicket();await click(c.ui,'连接 Node 实例');await observedState(c);await hasText(c.ui,'开发／测试模式 · 人工输入不会被拦截');
    }
    if(host==='electron')await click(c.ui,'连接信息');
    const capability=await c.ui.$('[aria-label="宿主能力"]');assert(capability);report.hostCapabilityText=await capability.evaluate(e=>e.innerText);assert(report.hostCapabilityText.includes(host==='node'?'人工输入不被拦截':'Electron 原生工作台'));await capability.screenshot({path:root+'/host-capabilities.png'});if(host==='electron')await c.ui.keyboard.press('Escape');
    return c;
  }catch(error){await closeHost(c);throw error}
}

async function connectNodeTarget(c){
  const registered=c.ownerState.session.pages.find(p=>p.pageId===c.ownerState.session.selectedPageId);
  assert.equal(registered.provider,'chromium');assert(!('webContentsId'in registered));assert(registered.browserInstanceId);
  const tree=ownedProcessTree([c.launcher.child.pid]);assertNoElectronDependency(tree);
  const providers=tree.processes.filter(p=>p.args.includes('--user-data-dir=')&&!p.args.includes('--type='));assert.equal(providers.length,1);
  const storage=providers[0].args.match(/--user-data-dir=(\S+)/)?.[1];assert(storage?.startsWith(c.launch.dataRoot+'/'));
  const[port,endpoint]=(await fs.readFile(storage+'/DevToolsActivePort','utf8')).trim().split(/\r?\n/);
  c.runtimeBrowser=await pp.connect({browserWSEndpoint:`ws://127.0.0.1:${port}${endpoint}`,defaultViewport:null});
  c.live=await until(async()=>{for(const page of await c.runtimeBrowser.pages()){const session=await page.createCDPSession();const{targetInfo}=await session.send('Target.getTargetInfo');await session.detach();if(targetInfo.targetId===registered.targetId)return page}},Boolean,'registered Chromium target');
  c.providerPid=providers[0].pid;c.report.runtime={registered,storage,processTree:tree,providerPid:c.providerPid};
}

export async function recordFixture(c,fixture){
  const{ui,report}=c;c.fixture=fixture;c.sourceUrl=fixture.url;report.fixture={url:fixture.url,label:fixture.label};
  if(c.host==='electron'){
    await click(ui,'新建项目');await fill(ui,'项目名称','B4 同输入双宿主验收');await fill(ui,'目录简介','精确历史金额与运行时采样分离');await click(ui,'创建项目');
    await click(ui,'添加环境');await fill(ui,'环境名称','B4 无账号合成来源');await fill(ui,'登录入口',fixture.url);await click(ui,'创建登录环境');await click(ui,'打开环境');
    c.live=await c.eb.waitForTarget(t=>t.url().startsWith(fixture.url)).then(t=>t.page());await c.live.waitForSelector('#amount');await ui.waitForFunction(()=>!document.querySelector('.statusbar').textContent.includes('正在处理'));await click(ui,'开始录制');
    const workspace=await readJson(c.launch.dataRoot+'/workspace.json');assert.equal(workspace.projects.length,1);assert.equal(workspace.profiles.length,1);c.projectId=workspace.projects[0].id;c.profileId=workspace.profiles[0].id;report.profile=workspace.profiles[0];
  }else{
    assert.equal(c.ownerState.projects.length,0);await disclose(ui,'新建项目');await fill(ui,'项目名称','B4 同输入双宿主验收');await fill(ui,'项目说明','精确历史金额与运行时采样分离');await click(ui,'创建项目');await observedState(c,s=>s.projects.length===1);c.projectId=c.ownerState.projects[0].id;
    await fill(ui,'目标网址',fixture.url);await disclose(ui,'新建 Chromium 环境');await fill(ui,'环境名称','B4 无账号合成来源');await click(ui,'创建 Chromium 环境');await observedState(c,s=>s.profiles.length===1);c.profileId=c.ownerState.profiles[0].id;report.profile=c.ownerState.profiles[0];
    await click(ui,'开始录制并导航');await observedState(c,s=>{if(c.lastOwnerFailure?.method==='startRun')throw Error(JSON.stringify(c.lastOwnerFailure));return s.active&&s.session?.pages.some(p=>p.url===fixture.url+'/')});await connectNodeTarget(c);
  }
  c.materialRoot=path.join(c.launch.dataRoot,'projects',c.projectId,'materials');
  await c.live.waitForFunction(()=>document.querySelector('#archived-image').naturalWidth===1&&getComputedStyle(document.querySelector('.source-banner')).color==='rgb(12, 67, 89)');await delay(450);
  const session=await c.live.createCDPSession();const{targetInfo}=await session.send('Target.getTargetInfo');await session.detach();report.liveTarget=targetInfo;report.documentToken=await c.live.evaluate(()=>window.b4ReadDocumentToken());
  await click(c.live,'更新金额到 13.00');await c.live.waitForFunction(()=>document.querySelector('#amount').textContent==='13.00');await delay(650);
  await click(c.live,'更新金额到 14.00');await c.live.waitForFunction(()=>document.querySelector('#amount').textContent==='14.00');await delay(250);
  await click(c.live,'加载已知缺失资源');await c.live.waitForSelector('#known-missing');await delay(300);
  await click(ui,c.host==='node'?'停止录制并封存':'结束并封存');if(c.host==='node')await observedState(c,s=>!s.active&&s.session);
  const runs=await fs.readdir(c.launch.dataRoot+'/runs');assert.equal(runs.length,1);c.recordingId=runs[0];c.runRoot=c.launch.dataRoot+'/runs/'+c.recordingId;
  const manifest=await until(()=>readJson(c.runRoot+'/manifest.json'),m=>m.status==='sealed','sealed original');assert.equal(manifest.projectId,c.projectId);assert.equal(manifest.profileId,c.profileId);assert.equal(!!manifest.versions.electron,c.host==='electron');
  c.source=await recordingFacts(c.runRoot);assert(c.source.metadata?.metadataComplete);report.source={recordingId:c.recordingId,projectId:c.projectId,baseline:c.source.baseline,thirteen:c.source.thirteen,fourteen:c.source.fourteen,missing:c.source.missing,nodeId:c.source.sourceNodeId,frameId:c.source.metadata.frameId,mirrorScopeId:c.source.metadata.mirrorScopeId,manifest};
  report.sourceHashes=await originalHashes(c.runRoot);await c.live.screenshot({path:c.root+'/actual-source.png'});await fixture.close();c.fixture=undefined;report.sourceServerClosedAt=new Date().toISOString();report.sourceRequests=fixture.requests;
  if(c.host==='electron')await click(ui,'浏览器配对');
}

export async function pair(c){
  let ticket;
  if(c.host==='node'){await click(c.ui,'生成工作台配对票据');ticket=await c.ui.$eval('[aria-label="工作台一次性票据"]',e=>e.value)}
  else{await select(c.ui,'配对权限范围','project-replay');await click(c.ui,'生成一次性配对票据');ticket=await c.ui.$eval('code[aria-label="一次性票据"]',e=>e.textContent)}
  assert(/^[A-Za-z0-9_-]{43}$/.test(ticket));await fill(c.web,'一次性配对票据',ticket);ticket='';await click(c.web,'连接合成项目');await hasText(c.web,'已连接');const capability=await c.web.$('[aria-label="宿主能力"]');assert(capability);c.report.browserCapabilityText=await capability.evaluate(e=>e.innerText);assert(c.report.browserCapabilityText.includes('当前网页不嵌入实时浏览器'));assert(c.report.browserCapabilityText.includes(c.host==='node'?'Node · 独立 Chromium':'Electron 伴随服务'));await capability.screenshot({path:c.root+'/browser-capabilities.png'});
}

export async function closeHost(c){
  await c.runtimeBrowser?.disconnect();
  await c.cb?.close().catch(()=>{});
  await c.eb?.disconnect();
  if(c.launcher?.child.exitCode===null)c.launcher.child.kill('SIGTERM');
  if(c.launcher){const result=await Promise.race([c.launcher.done,delay(25000).then(()=>({timeout:true}))]);c.report.cleanup={launcherPid:c.launcher.child.pid,result,providerPid:c.providerPid,providerAlive:c.providerPid?isAlive(c.providerPid):undefined};await c.launcher.closeLog()}
  await c.fixture?.close();
}
