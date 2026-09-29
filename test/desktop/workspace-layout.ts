import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { WebContents } from 'electron';
import type { Studio } from '@/main/services/studio';
import { startProductSite } from '../fixtures/product-site';
import { captureUiFrame } from './ui-layout';

/** Empty-root business writes use visible controls; service reads only assert
 * resulting identities. No fixture material injection or hidden dispatcher. */
export async function runWorkspaceLayoutScenarios(studio:Studio) {
  assert.equal(process.env.BES_TEST,'1');
  assert.equal(path.resolve(studio.root),path.resolve(process.env.BES_DATA??''));
  assert.equal(studio.projects.length,0);assert.equal(studio.runs.length,0);
  const window=studio.window.window,ui=window.webContents,site=await startProductSite();
  window.show();window.focus();
  const report:any={passed:false,processId:process.pid,inputOrigin:'empty synthetic root; visible production controls',sizes:[]};
  const read=<T>(script:string,wc=ui):Promise<T>=>wc.executeJavaScript(script);
  const visible="el.getClientRects().length&&!el.closest('[hidden],[inert]')";
  async function wait<T>(fn:()=>Promise<T>,accept:(value:T)=>boolean,label:string) {
    const end=Date.now()+20000;
    while(Date.now()<end){const result=await fn();if(accept(result))return result;await delay(100);}
    throw new Error('Layout timeout: '+label+'; '+await read('document.body.innerText.slice(-2400)'));
  }
  async function clickTarget(expression:string,wc:WebContents=ui) {
    const point=await wait<any>(()=>read<any>('(()=>{const el='+expression+';if(!el||el.disabled||!('+visible+'))return null;el.scrollIntoView({block:"center",inline:"nearest"});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()',wc),Boolean,expression);
    assert(await read<boolean>('(()=>{const el='+expression+',hit=document.elementFromPoint('+point.x+','+point.y+');return !!hit&&(hit===el||el.contains(hit));})()',wc),'Target must be visible and receive the click');
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(260);
  }
  const button=(name:string)=>'[...document.querySelectorAll("button")].find(el=>(el.textContent.trim()==='+JSON.stringify(name)+'||el.getAttribute("aria-label")==='+JSON.stringify(name)+')&&'+visible+')';
  const click=(name:string)=>clickTarget(button(name));
  async function fill(label:string,value:string) {
    const expression='[...document.querySelectorAll("label")].find(el=>el.firstChild?.textContent.trim()==='+JSON.stringify(label)+'&&'+visible+')?.querySelector("input,textarea")';
    await clickTarget(expression);ui.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});ui.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await ui.insertText(value);await delay(120);
    assert.equal(await read('('+expression+').value'),value);
  }
  async function disclose(text:string) {const el='[...document.querySelectorAll("summary")].find(el=>el.textContent.startsWith('+JSON.stringify(text)+')&&'+visible+')';if(!await read<boolean>('('+el+')?.parentElement.open'))await clickTarget(el);}
  try {
    await click('新建项目');await fill('项目名称','布局回放复核');await fill('业务目标','整理两个页面保存点，为其中一个补充纯文字说明。');await click('创建项目');
    await wait(async()=>studio.projects.length,n=>n===1,'project created');
    await click('添加环境');await fill('环境名称','合成登录页');await fill('登录入口',site.url+'/orders');await click('添加');
    await click('打开环境');await wait(async()=>!!studio.state().session,Boolean,'synthetic environment');
    await wait(()=>read<boolean>('!document.querySelector(".statusbar").textContent.includes("正在处理")'),Boolean,'environment settled');
    await click('开始录制');await wait(async()=>studio.active?.capture,v=>v==='recording','recording ready');
    for(const title of ['登录页面说明','登录入口复核']) {
      const before=await read<number>('document.querySelectorAll(".material-card-list button").length');
      await click('新增保存点');await wait(()=>read<number>('document.querySelectorAll(".material-card-list button").length'),n=>n>before,'visible card created');
      await click('编辑保存点');await fill('标题',title);await fill('说明','这是一份通过普通界面创建的合成页面资料。');await click('完成保存点编辑');
    }
    await click('结束并封存');await wait(async()=>studio.active===undefined,Boolean,'recording sealed');
    await click('查看来源');await wait(async()=>(studio.replayHost as any).active?.state?.status,s=>s==='ready','historical view ready');
    assert(await read<boolean>('!document.querySelector(".replay-diagnostics").open'),'Event and resource detail is collapsed initially');
    await click('添加注释');await fill('注释','仅说明页面用途，不绑定网页元素。');
    assert(await read<boolean>('!document.querySelector(".material-card-navigation").open'),'Navigation collapses while editing');
    assert(await read<boolean>('document.querySelectorAll(".material-focused-editor").length===1'),'Only one focused editor');
    assert(await read<boolean>('!document.querySelector(".material-summary-items")'),'Full card detail does not compete with the editor');
    for(const [width,height] of [[1450,935],[1100,760],[2100,1100]]) {
      window.setSize(width,height);await delay(500);
      const metric=await read<any>('(()=>{const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {viewport:{width:innerWidth,height:innerHeight},replay:rect(document.querySelector(".replay-workspace")),browser:rect(document.querySelector(".native-browser")),speed:rect(document.querySelector(".replay-speed [data-slot=native-select-wrapper]")),overflow:document.documentElement.scrollWidth>innerWidth,save:!!document.querySelector("[aria-label=编辑注释]"),stop:[...document.querySelectorAll(".topbar button")].find(el=>el.textContent==="全局停止自动化")?.getBoundingClientRect().height};})()');
      assert(metric.replay.height<210,'Replay controls must not dominate the viewport: '+JSON.stringify(metric));
      assert(metric.browser.height>height*.5,'Historical page retains the majority of height');
      assert(metric.speed.width<100,'Speed select wrapper stays compact');
      assert(!metric.overflow,'No horizontal document overflow');assert(metric.stop>0,'Global stop remains visible');
      await clickTarget('document.querySelector("[aria-label=编辑注释] textarea")');
      ui.sendInputEvent({type:'keyDown',keyCode:'TAB'});ui.sendInputEvent({type:'keyUp',keyCode:'TAB'});
      assert(await read<boolean>('document.activeElement?.tagName==="BUTTON"'),'Normal Tab reaches the source-selection action');
      await captureUiFrame(studio,'layout-editor-'+width+'.png');report.sizes.push(metric);
    }
    await click('保存注释');await wait(()=>read<boolean>('!document.querySelector("[aria-label=编辑注释]")'),Boolean,'annotation saved');
    assert(await read<boolean>('document.querySelector(".material-card-navigation").open'));
    await disclose('更多操作');
    assert(await read<boolean>('(()=>{const details=document.querySelector(".material-card-operations"),a=details.previousElementSibling.getBoundingClientRect(),b=details.getBoundingClientRect();return b.top>=a.bottom-1;})()'),'Expanded operations occupy their own block, below the primary actions');
    await captureUiFrame(studio,'layout-summary-more.png');
    await click('复制保存点');await wait(()=>read<boolean>('!!document.querySelector("[aria-label=编辑保存点] input")'),Boolean,'copy focuses card editor');await fill('标题','登录入口复核 副本');await click('完成保存点编辑');
    await disclose('页面、事件与资源详情');
    assert(await read<boolean>('document.querySelector(".replay-sequence button").getClientRects().length>0'),'Historical event navigation is still discoverable');
    await clickTarget('[...document.querySelectorAll(".replay-sequence button")].filter(el=>/^#/.test(el.textContent)).at(-1)');await wait(async()=>(studio.replayHost as any).active?.state?.status,s=>s==='ready','event seek works');
    await captureUiFrame(studio,'layout-replay-details.png');
    const draft=await studio.materials.service.workingDraft(studio.projects[0].id);
    assert.equal(draft.content.checkpoints.length,3);assert(draft.content.annotations.some(item=>item.text==='仅说明页面用途，不绑定网页元素。'&&!item.target));
    report.sourceIdentity={projectId:studio.projects[0].id,draftId:draft.draftId,recordingIds:draft.content.recordingRefs};
    report.passed=true;return report;
  } catch(error) {report.error=String(error);try{await captureUiFrame(studio,'layout-failure.png');}catch{}throw error;}
  finally {await writeFile(path.join(studio.root,'workspace-layout-detail.json'),JSON.stringify(report,null,2));await site.close();}
}
