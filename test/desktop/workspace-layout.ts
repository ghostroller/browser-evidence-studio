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
  async function focusState(expression:string) {
    const renderer=await read<{
      hasFocus:boolean;targetActive:boolean;targetUsable:boolean;active:unknown;target:unknown;
      input:{value:string;selectionStart:number|null;selectionEnd:number|null;type:string}|null;
    }>('(()=>{const target='+expression+';const describe=el=>el?{tag:el.tagName,role:el.getAttribute("role")||(el.tagName==="BUTTON"?"button":el.tagName==="TEXTAREA"?"textbox":null),name:el.getAttribute("aria-label")||(el.tagName==="BUTTON"?el.textContent.trim():null),connected:el.isConnected,tabIndex:el.tabIndex,disabled:!!el.disabled,inert:!!el.closest("[inert]"),visible:!!el.getClientRects().length}:null;return {hasFocus:document.hasFocus(),targetActive:!!target&&document.activeElement===target,targetUsable:!!target&&!target.disabled&&!!target.getClientRects().length&&!target.closest("[hidden],[inert]"),active:describe(document.activeElement),target:describe(target),input:target?.matches("input,textarea")?{value:target.value,selectionStart:target.selectionStart,selectionEnd:target.selectionEnd,type:target.type}:null};})()');
    return {windowFocused:window.isFocused(),uiFocused:ui.isFocused(),windowVisible:window.isVisible(),windowMinimized:window.isMinimized(),...renderer};
  }
  async function waitForFocus(expression:string,label:string,requireTarget:boolean,accept:(state:Awaited<ReturnType<typeof focusState>>)=>boolean=()=>true) {
    const end=Date.now()+3000;
    const initial=await focusState(expression);
    let current=initial;
    while(true) {
      if(current.windowFocused&&current.uiFocused&&current.hasFocus&&current.targetUsable&&(!requireTarget||current.targetActive)&&accept(current))return current;
      if(Date.now()>=end) {
        const diagnostic={label,expression,requireTarget,initial,last:current};
        (report.focusFailures??=[]).push(diagnostic);
        throw new Error('Layout focus timeout: '+JSON.stringify(diagnostic));
      }
      await delay(20);current=await focusState(expression);
    }
  }
  async function clickTarget(expression:string,wc:WebContents=ui) {
    const point=await wait<any>(()=>read<any>('(()=>{const el='+expression+';if(!el||el.disabled||!('+visible+'))return null;el.scrollIntoView({block:"center",inline:"nearest"});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()',wc),Boolean,expression);
    const hitTest='(()=>{const el='+expression+',hit=document.elementFromPoint('+point.x+','+point.y+');return !!el&&!!hit&&(hit===el||el.contains(hit));})()';
    assert(await read<boolean>(hitTest,wc),'Target must be visible and receive the click');
    if(wc===ui) {
      // sendInputEvent does not activate the native host like a desktop click.
      // Focus only Electron surfaces; the actual click must focus the DOM node.
      window.focus();ui.focus();
      await waitForFocus(expression,'UI input owns native focus',false);
      assert(await read<boolean>(hitTest,wc),'Target must still receive the click after native focus');
    }
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(260);
  }
  const button=(name:string)=>'[...document.querySelectorAll("button")].find(el=>(el.textContent.trim()==='+JSON.stringify(name)+'||el.getAttribute("aria-label")==='+JSON.stringify(name)+')&&'+visible+')';
  const click=(name:string)=>clickTarget(button(name));
  async function fill(label:string,value:string) {
    const expression='[...document.querySelectorAll("label")].find(el=>el.firstChild?.textContent.trim()==='+JSON.stringify(label)+'&&'+visible+')?.querySelector("input,textarea")';
    await clickTarget(expression);
    const beforeSelect=await waitForFocus(expression,'Input click focuses '+label,true);
    assert(beforeSelect.input&&typeof beforeSelect.input.selectionStart==='number'&&typeof beforeSelect.input.selectionEnd==='number','Input must support text selection: '+JSON.stringify({label,state:beforeSelect}));
    ui.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});ui.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
    // Observe the one native shortcut's selection before inserting. Never set
    // selection/value through the DOM or retry an input that was not accepted.
    const selected=await waitForFocus(expression,'Ctrl+A selects the entire input: '+label,true,state=>state.input?.selectionStart===0&&state.input.selectionEnd===state.input.value.length);
    await ui.insertText(value);
    const inserted=await waitForFocus(expression,'Visible input committed: '+label,true,state=>state.input?.value===value);
    (report.inputPreparation??=[]).push({label,beforeSelect,selected,inserted});
    assert.equal(await read('('+expression+').value'),value);
  }
  async function disclose(text:string) {const el='[...document.querySelectorAll("summary")].find(el=>el.textContent.startsWith('+JSON.stringify(text)+')&&'+visible+')';if(!await read<boolean>('('+el+')?.parentElement.open'))await clickTarget(el);}
  try {
    // Exercise the empty workspace too: flex-shrinking the status beside all
    // three action buttons used to wrap its Chinese text one glyph per line.
    for (const [width,height] of [[1180,812],[1100,760],[1450,935]]) {
      window.setSize(width,height);await delay(500);
      const footer=await read<any>('(()=>{const el=document.querySelector(".evidence-strip"),status=el.querySelector(":scope > div"),text=status.querySelector("span"),r=el.getBoundingClientRect(),s=status.getBoundingClientRect(),t=text.getBoundingClientRect();return {viewport:innerWidth,width:r.width,height:r.height,statusWidth:s.width,textHeight:t.height,lineHeight:parseFloat(getComputedStyle(text).lineHeight),overflow:el.scrollWidth>el.clientWidth,buttons:[...el.querySelectorAll("button")].map(button=>{const b=button.getBoundingClientRect();return {top:b.top,bottom:b.bottom,right:b.right};}),statusBottom:s.bottom,right:r.right,bottom:r.bottom};})()');
      report.emptyFooterSizes??=[];report.emptyFooterSizes.push(footer);
      assert(footer.textHeight<=footer.lineHeight*2,'Recording status must remain readable, not a vertical glyph column: '+JSON.stringify(footer));
      assert(footer.height<120,'Evidence footer must leave room for the workspace');
      assert(!footer.overflow,'Evidence actions must not overflow horizontally');
      assert(footer.buttons.every((button:any)=>button.top>=footer.statusBottom-1&&button.right<=footer.right+1&&button.bottom<=footer.bottom+1),'History actions wrap below the status and remain inside the footer');
      await captureUiFrame(studio,'layout-empty-footer-'+width+'.png');
    }
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
      const annotationInput='document.querySelector("[aria-label=编辑注释] textarea")';
      await clickTarget(annotationInput);
      const beforeTab=await waitForFocus(annotationInput,'Annotation click focuses the textarea',true);
      ui.sendInputEvent({type:'keyDown',keyCode:'TAB'});ui.sendInputEvent({type:'keyUp',keyCode:'TAB'});
      // Chromium may finish native Tab default handling after executeJavaScript
      // is queued. Wait for the exact action, never force DOM focus or accept an
      // arbitrary button. A prevented or misdirected Tab still fails the gate.
      const sourceSelection='[...document.querySelectorAll("[aria-label=编辑注释] button")].find(el=>(el.getAttribute("role")||"button")==="button"&&(el.getAttribute("aria-label")||el.textContent.trim())==="选择历史元素（可选）"&&'+visible+')';
      const afterTab=await waitForFocus(sourceSelection,'Normal Tab reaches the source-selection action',true);
      (report.keyboardFocus??=[]).push({width,height,beforeTab,afterTab});
      assert(await read<boolean>('(()=>{const el=document.querySelector(".material-toolbar"),r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(el===hit||el.contains(hit));})()'),'Working copy identity remains visible while the editor scrolls');
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
