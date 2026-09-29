import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopCapturer, type WebContents } from 'electron';
import type { Studio } from '@/main/services/studio';
import { clickSyntheticHuman } from './native-input';

async function startBrowserFixture(){
  let recovered=false;const requests:Record<string,number>={};
  const server=createServer((request,response)=>{
    const route=new URL(request.url??'/', 'http://fixture.test').pathname;requests[route]=(requests[route]??0)+1;
    if(route==='/broken'&&!recovered){request.socket.destroy();return;}
    if(route.startsWith('/download')){
      response.writeHead(200,{'content-type':'text/csv','content-disposition':'attachment; filename="synthetic-browser.csv"','content-length':route==='/download-slow'?100000:14});
      response.write('name,value\na,1');
      if(route==='/download-slow'){const timer=setTimeout(()=>response.end(' '.repeat(100000-14)),20000);response.on('close',()=>clearTimeout(timer));}else response.end();return;
    }
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    if(route==='/slow'){response.write('<!doctype html><title>合成慢页</title><h1>等待加载</h1>');const timer=setTimeout(()=>response.end('<p>已完成</p>'),20000);response.on('close',()=>clearTimeout(timer));return;}
    const name=route==='/two'?'合成浏览器第二页':'合成浏览器第一页';
    response.end(`<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{font:16px system-ui;padding:20px}button,a,input{margin:6px;padding:8px}p{margin:10px}</style><h1>${name}</h1><p>页内查找标记 browser-match browser-match</p><a id="next" href="/two">到第二页</a><button id="popup" onclick="window.open('/two')">打开子标签</button><p><button id="alert" onclick="alert('合成 alert');document.querySelector('#result').textContent='alert-closed'">测试 alert</button><button id="confirm" onclick="document.querySelector('#result').textContent='confirm-'+confirm('合成 confirm')">测试 confirm</button><button id="prompt" onclick="document.querySelector('#result').textContent='prompt-'+prompt('合成 prompt','default')">测试 prompt</button></p><p><button id="permission" onclick="navigator.geolocation.getCurrentPosition(()=>document.querySelector('#permission-result').textContent='unexpected-grant',()=>document.querySelector('#permission-result').textContent='denied')">请求定位权限</button><span id="permission-result"></span></p><p><a id="download" href="/download">下载合成文件</a><a id="download-slow" href="/download-slow">慢速下载</a><label>选择合成文件<input id="upload" type="file"></label></p><button id="increment" onclick="document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)">计数</button><span id="count">0</span><p id="result">ready</p>`);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});const address=server.address();assert(address&&typeof address!=='string');
  return {url:`http://127.0.0.1:${address.port}`,requests,recover:()=>{recovered=true;},close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

/** Deliberate Electron resource faults, separate from user interaction evidence.
 * Uses the real addPage allocator and native views in an already UI-created
 * synthetic recording. No material/profile/session is manufactured here. */
export async function runWorkspaceBrowserAllocationFaults(studio:Studio,origin:string){
  assert.equal(process.env.BES_TEST,'1');const r=studio.required(),previous=studio.current(),internal=studio as any;
  assert.equal(new URL(previous.view.webContents.getURL()).origin,origin);assert.equal(r.controller,'human');assert.equal(r.locked,false);
  const identity={sessionId:studio.browserSessionId,pageId:previous.pageId,targetId:previous.targetId,leaseEpoch:r.leaseEpoch},results:Array<{stage:string;layer:string;viewCount:number}>=[];
  for(const stage of ['native-view-registered','target-wait','capture-started','authorization-registration']){
    const viewsBefore=studio.window.presentationStatus().views.length,pagesBefore=r.pages.size;
    const add=studio.window.add,wait=internal.observer.waitForTarget,createCapture=internal.createCapture,register=studio.tasks.addPage;
    const oldAuthorization=internal.browserAuthorizationId;let authorizationId:string|undefined;
    try{
      if(stage==='native-view-registered')studio.window.add=function(...args:Parameters<typeof add>){add.apply(this,args);throw new Error('injected '+stage);};
      if(stage==='target-wait')internal.observer.waitForTarget=async()=>{throw new Error('injected '+stage);};
      if(stage==='capture-started')internal.createCapture=function(...args:unknown[]){const capture=createCapture.apply(this,args),start=capture.start.bind(capture);capture.start=async()=>{await start();throw new Error('injected '+stage);};return capture;};
      if(stage==='authorization-registration'){
        const grant=await studio.tasks.issue({projectId:r.projectId,profileId:r.profileId,sessionId:studio.browserSessionId!},{origins:[origin],pages:[{pageId:previous.pageId,targetId:previous.targetId}],capabilities:['page-create'],durationMs:60000,maxOperations:10});
        authorizationId=grant.authorizationId;internal.browserAuthorizationId=authorizationId;r.controller='agent';studio.tasks.addPage=()=>{throw new Error('injected '+stage);};
      }
      await assert.rejects(()=>internal.addPage(r,previous.pageId),new RegExp('injected '+stage));
      assert.equal(r.pages.size,pagesBefore);assert.equal(studio.window.presentationStatus().views.length,viewsBefore);assert.equal(studio.current(),previous);assert.equal(previous.view.webContents.isDestroyed(),false);
      assert.equal(studio.window.presentationStatus().locked,r.locked||r.controller!=='human');
      results.push({stage,layer:'real Electron view + explicit main-service fault injection',viewCount:viewsBefore});
    }finally{
      studio.window.add=add;internal.observer.waitForTarget=wait;internal.createCapture=createCapture;studio.tasks.addPage=register;internal.browserAuthorizationId=oldAuthorization;r.controller='human';studio.window.lock(r.locked);if(authorizationId)studio.tasks.revoke(authorizationId,'Synthetic allocation fault completed');
    }
    assert.deepEqual({sessionId:studio.browserSessionId,pageId:previous.pageId,targetId:previous.targetId,leaseEpoch:r.leaseEpoch},identity);
    await clickSyntheticHuman(studio,'#increment');
  }
  assert.equal(await previous.page.$eval('#count',element=>element.textContent),'4','Old native view still accepts normal input after all faults');return results;
}

/** Scripted production-UI regression, NOT an independent discovery study.
 * Only UI clicks/keys create the project, environment and recording. Service
 * access is read-only except the separately identified allocator fault block. */
export async function runWorkspaceBrowserScenarios(studio:Studio){
  assert.equal(process.env.BES_TEST,'1','Refuse desktop input outside an explicit synthetic process');assert.equal(path.resolve(studio.root),path.resolve(process.env.BES_DATA??''),'This Studio must be the launched synthetic instance');
  assert.equal(studio.state().session,null,'Begin this browser scenario without someone else’s live session');assert.equal(studio.active,undefined);
  const site=await startBrowserFixture(),ui=studio.window.window.webContents,instanceId=studio.instanceId;
  const evidence=path.join(studio.root,'workspace-browser-evidence');await mkdir(evidence,{recursive:true});
  const report:{passed:boolean;processId:number;instanceId:string;checks:Array<{id:string;check:string;layer:string}>;limitations:string[];[key:string]:unknown}={passed:false,processId:process.pid,instanceId,startedAt:new Date().toISOString(),checks:[],limitations:['Scripted path does not prove independent discoverability.','Native OS file picker selection and right-menu item activation require a separate desktop operator; not replaced with uploadFile or hidden commands.','Certificate failure and automation already running during modal/selection need the integrated execution scenario.','Allocator tests inject main-service boundaries while allocating actual Electron views; these are not OS process-kill experiments.']};
  const check=(id:string,description:string,layer='production UI with actual Electron WebContents input')=>{report.checks.push({id,check:description,layer});console.log('WORKSPACE BROWSER '+id+' '+description);};
  const read=<T>(expression:string,wc=ui):Promise<T>=>wc.executeJavaScript(expression);
  async function wait<T>(fn:()=>T|Promise<T>,accept:(value:T)=>boolean,name:string,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(accept(value))return value;await delay(100);}throw new Error('Browser scenario timeout: '+name+'; '+await read<string>('document.body.innerText.slice(-2500)'));}
  const visible="el.getClientRects().length&&!el.closest('[hidden]')&&!el.closest('[inert]')";
  function assertInstance(wc:WebContents=ui){assert.equal(studio.instanceId,instanceId);assert.equal(path.resolve(studio.root),path.resolve(process.env.BES_DATA!));assert(!studio.window.window.isDestroyed());if(wc!==ui){const current=studio.current();assert.equal(wc.id,current.webContentsId);const url=wc.getURL();assert(url==='about:blank'||new URL(url).origin===site.url,'Native inputs remain inside this task’s synthetic origin');assert.equal(studio.state().session?.controller,'human');assert.equal(studio.state().session?.locked,false);}}
  async function clickExpression(expression:string,wc=ui){assertInstance(wc);studio.window.window.show();studio.window.window.focus();wc.focus();const point=await wait(()=>read<{x:number;y:number}|null>(`(()=>{const el=${expression};if(!el||el.disabled||!(${visible}))return null;el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,wc),Boolean,expression);assert(point);wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(180);}
  const click=(name:string,scope='document')=>clickExpression(`[...${scope}.querySelectorAll('button')].find(el=>(el.textContent.trim()===${JSON.stringify(name)}||el.getAttribute('aria-label')===${JSON.stringify(name)})&&${visible})`);
  async function fill(label:string,value:string){const quoted=JSON.stringify(label),expression=`(document.querySelector('input[aria-label='+${quoted}+'],textarea[aria-label='+${quoted}+']')||[...document.querySelectorAll('label')].find(el=>el.firstChild?.textContent.trim()===${quoted}&&${visible})?.querySelector('input,textarea'))`;await clickExpression(expression);ui.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});ui.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await ui.insertText(value);await wait(()=>read<string>(`(${expression}).value`),result=>result===value,'visible input '+label);}
  async function pageClick(selector:string){assertInstance(studio.current().view.webContents);await clickSyntheticHuman(studio,selector);await delay(150);}
  const selected=()=>{const state=studio.state().session;return state?.pages.find(page=>page.pageId===state.selectedPageId);};
  async function navigate(route:string){await fill('网页地址',site.url+route);await click('前往');await wait(()=>selected(),page=>!!page&&!page.loading&&page.url===site.url+route,'navigation '+route);}
  async function shortcut(keyCode:string,modifiers:Electron.InputEvent['modifiers']=['control']){const wc=studio.current().view.webContents;assertInstance(wc);studio.window.window.focus();wc.focus();wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(200);}
  async function frame(name:string){const sourceId=studio.window.window.getMediaSourceId(),sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1460,height:940}}),source=sources.find(item=>item.id===sourceId);assert(source&&!source.thumbnail.isEmpty(),'Capture exact synthetic native window');await writeFile(path.join(evidence,name+'.png'),source.thumbnail.toPNG());}
  try{
    await click('新建项目');await fill('项目名称','浏览器基础交互 '+randomUUID().slice(0,8));await fill('业务目标','在合成网页浏览、查找和下载，保持原始录制与登录环境身份。');await click('创建项目');
    await click('添加环境');await fill('环境名称','本任务隔离浏览器');await fill('登录入口',site.url+'/one');await click('添加');await click('打开环境');
    await wait(()=>selected(),page=>!!page&&!page.loading&&page.url===site.url+'/one','initial native page');await wait(()=>read<boolean>("!!document.querySelector('[data-browser-toolbar]')"),Boolean,'integrated toolbar');
    const firstSession=studio.state().session!,storageRef=studio.profiles.find(profile=>profile.id===firstSession.profileId)!.storageRef;
    assert.equal(studio.active,undefined);report.identity={sessionId:firstSession.sessionId,projectId:firstSession.projectId,profileId:firstSession.profileId,storageRef};await frame('01-session');
    const firstPage=selected()!;await pageClick('#next');await wait(()=>selected()?.url,url=>url===site.url+'/two','fixture link');await wait(()=>selected()?.loading,loading=>loading===false,'link load complete');
    await click('后退');await wait(()=>selected()?.url,url=>url===site.url+'/one','back');await click('前进');await wait(()=>selected()?.url,url=>url===site.url+'/two','forward');const requests=site.requests['/two'];await click('刷新');await wait(()=>site.requests['/two'],value=>value>requests,'reload issues request');
    await navigate('/one');await fill('网页地址',site.url+'/slow');await click('前往');await wait(()=>selected()?.loading,Boolean,'slow load');await click('停止加载');await wait(()=>selected()?.loading,value=>value===false,'stop load');assert.equal(studio.active,undefined);assert.equal(studio.current().pageId,firstPage.pageId);check('IA19','history, reload and independent loading stop');
    await fill('网页地址',site.url+'/broken');await click('前往');await wait(()=>selected()?.loadError,Boolean,'network error');const brokenTarget=studio.current().targetId;site.recover();await click('重试当前页');await wait(()=>selected(),page=>!!page&&!page.loading&&!page.loadError&&page.url===site.url+'/broken','retry recovers same target');assert.equal(studio.current().targetId,brokenTarget);check('IA19','real socket failure visibly retried on same target');await navigate('/one');
    await shortcut('L');await wait(()=>read<string>('document.activeElement?.getAttribute("aria-label")||""'),name=>name==='网页地址','native Ctrl+L');
    await shortcut('F');await fill('页内查找文字','browser-match');await click('查找');await wait(()=>selected()?.find?.matches,matches=>matches===2,'find matches');await click('下一处');await click('关闭查找');await click('放大页面');await wait(()=>selected()?.zoomFactor,factor=>!!factor&&factor>1,'zoom in');await clickExpression("[...document.querySelectorAll('[data-browser-toolbar] button')].find(el=>el.title==='恢复 100%')");await wait(()=>selected()?.zoomFactor,factor=>factor===1,'zoom reset');check('IA21','native address/find shortcuts and current-page find/zoom');
    await shortcut('T');await wait(()=>studio.state().session?.pages.length,count=>count===2,'native Ctrl+T');const newPage=studio.current().pageId;assert.notEqual(newPage,firstPage.pageId);await shortcut('W');await wait(()=>studio.state().session?.pages.length,count=>count===1,'native Ctrl+W');await shortcut('T',['control','shift']);await wait(()=>studio.state().session?.pages.length,count=>count===2,'native Ctrl+Shift+T');
    await clickExpression("[...document.querySelectorAll('[data-browser-toolbar] button')].find(el=>el.getAttribute('aria-label')?.startsWith('关闭标签')&&el.parentElement.querySelector('[aria-selected=true]'))");await wait(()=>studio.state().session?.pages.length,count=>count===1,'close restored');await clickExpression("document.querySelector('[data-browser-toolbar] button[aria-label^=关闭标签]')");await wait(()=>studio.state().session?.pages.length,count=>count===0,'last page close');assert.equal(studio.state().session?.controller,'human');await click('新标签');await wait(()=>studio.state().session?.pages.length,count=>count===1,'new after last close');await navigate('/one');assert.equal(studio.state().session?.sessionId,firstSession.sessionId);check('IA20','native new/close/reopen and last-tab recovery without recording');
    await pageClick('#popup');await wait(()=>studio.state().session?.pages.length,count=>count===2,'managed popup');assert(studio.current().openerPageId);await clickExpression("[...document.querySelectorAll('[data-browser-toolbar] button')].find(el=>el.getAttribute('aria-label')?.startsWith('关闭标签')&&el.parentElement.querySelector('[aria-selected=true]'))");await wait(()=>studio.state().session?.pages.length,count=>count===1,'popup close');check('IA20','site popup preserves managed opener relation');
    for(const type of ['alert','confirm']){await pageClick('#'+type);await wait(()=>selected()?.dialog?.type,value=>value===type,'dialog '+type);if(type==='prompt')await fill('网站对话框输入','visible reply');await click(type==='confirm'?'取消':'确认',"document.querySelector('[data-browser-toolbar]')");await wait(()=>selected()?.dialog,value=>!value,'dialog responded');await wait(()=>read<string>("document.querySelector('#result').textContent",studio.current().view.webContents),value=>value===(type==='alert'?'alert-closed':type==='confirm'?'confirm-false':'prompt-visible reply'),'site dialog result');}
    await pageClick('#prompt');await wait(()=>studio.state().session?.notice,value=>!!value?.includes('不支持网站 prompt'),'visible unsupported prompt');assert.notEqual(await read<string>("document.querySelector('#result').textContent",studio.current().view.webContents),'prompt-visible reply');report.limitations.push('Electron rejects window.prompt; production UI reports that limitation and never fabricates an answer.');
    await pageClick('#permission');await wait(()=>read<string>("document.querySelector('#permission-result').textContent",studio.current().view.webContents),value=>value==='denied','default permission denial');await wait(()=>read<string>("document.querySelector('[data-browser-toolbar]').textContent"),value=>value.includes('网站权限已拒绝'),'visible denial notice');check('IA23','real alert/confirm, visible unsupported prompt and explicit origin permission denial');await frame('02-controls');
    await pageClick('#download');await wait(()=>studio.state().session?.downloads[0],download=>download?.state==='completed','session download');const idleDownload=studio.state().session!.downloads[0];assert.equal(idleDownload.recordingId,undefined);assert.equal(await readFile(idleDownload.path,'utf8'),'name,value\na,1');await clickExpression("[...document.querySelectorAll('[data-browser-toolbar] button')].find(el=>el.textContent.trim().startsWith('下载'))");await wait(()=>read<string>("document.querySelector('[aria-label=下载列表]').textContent"),value=>value.includes('已完成'),'visible download result');
    await pageClick('#download-slow');await wait(()=>studio.state().session?.downloads[0],download=>download?.state==='progressing','slow download');await click('取消下载');await wait(()=>studio.state().session?.downloads[0].state,state=>state==='cancelled','download cancelled');check('IA22','unrecorded native download, local content and visible cancel');
    await click('开始录制');await wait(()=>studio.active?.capture,state=>state==='recording','recording ready');const runId=studio.active!.id;await pageClick('#download');await wait(()=>studio.state().session?.downloads[0],download=>download?.state==='completed'&&download.evidence==='imported','recorded download imported');assert.equal(studio.state().session?.downloads[0].recordingId,runId);check('IA22','recorded download uses the current evidence writer');
    report.allocationFaults=await runWorkspaceBrowserAllocationFaults(studio,site.url);check('IA25','four allocation failure boundaries leave original view usable','real Electron allocations with explicit internal fault injection');check('IA25','initial navigation network failure remains an explicit retryable page','real loopback socket failure via visible address bar');
    await click('选取元素（实时页）');await wait(()=>selected()?.inspecting,Boolean,'inspection ready');await pageClick('#increment');await wait(()=>studio.active?.selection,Boolean,'selection receipt');assert.equal(await studio.current().page.$eval('#count',element=>element.textContent),'4','Inspecting never invokes business click');
    await wait(()=>read<boolean>("[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='全局停止自动化'&&!el.disabled&&el.getClientRects().length)"),Boolean,'global stop visible while inspecting');await click('取消实时选择（Esc）');check('IA21','real inspection intercepts business-page clicks');check('IA24','global stop remains reachable during live selection (no active worker in this scenario)');
    await frame('03-recording');assert.equal(studio.profiles.find(profile=>profile.id===firstSession.profileId)!.storageRef,storageRef);report.runId=runId;report.passed=true;
  }catch(error){report.error=String(error);await frame('failure').catch(captureError=>{report.captureError=String(captureError);});throw error;}
  finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(studio.root,'workspace-browser-detail.json'),JSON.stringify(report,null,2));await site.close();}
  return report;
}
