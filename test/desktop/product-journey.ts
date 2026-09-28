import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { type WebContents } from 'electron';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { startProductSite } from '../fixtures/product-site';
import { recordNativeWindow } from './native-window-evidence';
import { implementExportedProductTask } from './product-implementer';

/** Task/environment/material writes originate in visible UI. Execution uses
 * the UI and its publicly authorized HTTP API; no hidden business prefill.
 * Test diagnostics only read service state. The named implementer writes code,
 * never task data, and its proposal is confirmed through the normal editor. */
export async function runProductJourney(studio:Studio,reopen=false){
  const numeric=process.env.BES_TEST_NUMERIC==='1';
  const authoringFault=process.env.BES_TEST_AUTHORING_CUT==='1';
  if(!reopen){assert.equal(studio.projects.length,0);assert.equal(studio.runs.length,0);}
  studio.window.window.show();studio.window.window.focus();
  const site=await startProductSite(),ui=studio.window.window.webContents;
  const directory=path.join(studio.root,reopen?'journey-reopen-evidence':'journey-evidence');await mkdir(directory);
  const evidence=await recordNativeWindow(studio.window.window,directory),frames=evidence.frames;
  const report:any={passed:false,journeys:{},inputOrigin:'empty BES_DATA; visible production UI',implementation:'explicit demonstration implementer; proposal confirmed in UI'};
  const mark=(action:string)=>{evidence.mark(action);console.log('JOURNEY '+action);};
  const read=<T>(expression:string,wc=ui):Promise<T>=>wc.executeJavaScript(expression);
  async function wait<T>(fn:()=>Promise<T>,check:(v:T)=>boolean,name:string):Promise<T>{const end=Date.now()+20000;while(Date.now()<end){const value=await fn();if(check(value))return value;await delay(150);}throw new Error('Journey timeout: '+name+'; '+await read('document.body.innerText.slice(-3500)'));}
  const visible="el.getClientRects().length&&!el.closest('[hidden]')&&!el.closest('[inert]')";
  async function target(expression:string,wc=ui){return wait<any>(()=>read<any>(`(()=>{const el=${expression};if(!el||el.disabled||!(${visible}))return null;el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,wc),Boolean,expression);}
  async function clickExpression(expression:string,wc=ui){const point=await target(expression,wc);wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await delay(350);}
  async function click(name:string,scope='document'){mark('点击 '+name);await clickExpression(`[...${scope}.querySelectorAll('button')].find(el=>(el.textContent.trim()===${JSON.stringify(name)}||el.getAttribute('aria-label')===${JSON.stringify(name)})&&${visible})`);}
  async function fill(label:string,value:string,scope='document'){mark('填写 '+label);const expression=`[...${scope}.querySelectorAll('label')].find(el=>el.firstChild?.textContent.trim()===${JSON.stringify(label)}&&${visible})?.querySelector('input,textarea')`;await clickExpression(expression);ui.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});ui.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await delay(120);await ui.insertText(value);await delay(220);if(await read<string>(`(${expression}).value`)!==value){ui.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});ui.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await delay(120);await ui.insertText(value);await delay(220);}assert.equal(await read<string>(`(${expression}).value`),value,'Visible input committed: '+label);}
  async function choose(label:string,text:string){mark('选择 '+label+' / '+text);const expression=`(document.querySelector('select[aria-label=${JSON.stringify(label)}]')||[...document.querySelectorAll('label')].find(el=>el.firstChild?.textContent.trim()===${JSON.stringify(label)})?.querySelector('select'))`;await clickExpression(expression);const index=await read<number>(`[...(${expression}).options].findIndex(el=>el.textContent.includes(${JSON.stringify(text)}))`);assert(index>=0);ui.sendInputEvent({type:'keyDown',keyCode:'HOME'});for(let i=0;i<index;i++)ui.sendInputEvent({type:'keyDown',keyCode:'DOWN'});ui.sendInputEvent({type:'keyDown',keyCode:'ENTER'});await delay(250);}
  async function popupCycle(stage:string){
    if(await read<boolean>("!!document.querySelector('.replay-timeline')"))await click('返回实时页面');
    await wait(async()=>studio.current().view.getVisible(),Boolean,'visible live view before popup input');
    mark(stage+'：打开弹窗、切回父页、切回弹窗并关闭');const parent=studio.current().pageId;
    await clickExpression("document.querySelector('#details')",studio.current().view.webContents);
    await wait(async()=>studio.state().session?.pages.length,n=>n===2,'managed popup');await delay(1000);
    await clickExpression("[...document.querySelectorAll('.browser-tabs button')].find(el=>el.textContent.includes('合成订单后台'))");assert.equal(studio.current().pageId,parent);
    await clickExpression("[...document.querySelectorAll('.browser-tabs button')].find(el=>el.textContent.includes('合成订单详情'))");await click('关闭当前页');
    await wait(async()=>studio.state().session?.pages.length,n=>n===1,'popup closed');assert.equal(studio.current().pageId,parent);assert(studio.current().view.getVisible());assert.equal(studio.active,undefined);
  }
  let knownDraftId='';
  async function pickHistory(selector:string){
    await wait(async()=>(studio.replayHost as any).active?.state?.selecting,Boolean,'historical native selection');
    const wc=(studio.replayHost as any).active.view.webContents as WebContents;
    const point=await read<{x:number;y:number}>(`(()=>{const frame=document.querySelector('#replay iframe'),el=frame?.contentDocument?.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Visible history element missing');el.scrollIntoView({block:'center'});const a=frame.getBoundingClientRect(),b=el.getBoundingClientRect();return{x:Math.round(a.x+(b.x+b.width/2)*a.width/frame.contentWindow.innerWidth),y:Math.round(a.y+(b.y+b.height/2)*a.height/frame.contentWindow.innerHeight)};})()`,wc);
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await wait(()=>read<boolean>("!document.querySelector('.replay-cancel-selection')"),Boolean,'history receipt');
  }
  const draft=async()=>{if(knownDraftId)return studio.materials.service.getDraft(studio.projects[0].id,knownDraftId);const project=studio.projects[0];const page=await studio.materials.service.listDrafts(project.id,{limit:100,maxBytes:28672});assert(page.items.length===1);knownDraftId=page.items[0].draftId;return studio.materials.service.getDraft(project.id,page.items[0].draftId);};
  try{
    await wait(async()=>frames.length,n=>n>0,'visible native-window capture');
    if(reopen&&authoringFault){
      await wait(()=>read<boolean>("!!document.querySelector('.material-card-list button')"),Boolean,'restored interrupted editor');
      const text=await read<string>('document.body.innerText');
      if(text.includes('查询采集操作状态'))await click('查询采集操作状态');
      await wait(()=>read<string>('document.body.innerText'),value=>value.includes('原来源失效：重新选择'),'orphan operation recovered to terminal');
      await click('原来源失效：重新选择');
      if((await read<string>('document.body.innerText')).includes('并处理冲突'))await clickExpression("[...document.querySelectorAll('button')].find(el=>el.textContent.includes('并处理冲突'))");
      await clickExpression("document.querySelector('.material-card-list button')");
      await fill('说明','进程中断后仍可编辑，旧操作和原件保留');await click('保存卡片草稿');
      assert.equal((await draft()).content.checkpoints[0].notes,'进程中断后仍可编辑，旧操作和原件保留');
      report.interruptedRecovery={visible:true,oldOperationRetained:true,unrelatedEditSaved:true};report.passed=true;
      await wait(async()=>frames.length,n=>n>12,'recovery visible evidence');
    }else if(reopen){
      const saved=JSON.parse(await readFile(path.join(studio.root,'journey-state.json'),'utf8'));
      assert.notEqual(saved.processId,process.pid);knownDraftId=saved.draftId;
      await wait(()=>read<boolean>("!!document.querySelector('.material-card-list button')"),Boolean,'restored working draft');
      await choose('字段','实付金额');
      await clickExpression("[...document.querySelector('.material-card-list').querySelectorAll('button')].find(el=>el.textContent.startsWith('字段现场示例'))");
      await click('查看来源');await wait(()=>read<boolean>("!!document.querySelector('.replay-timeline')"),Boolean,'reopened source');
      await wait(()=>read<string>("document.querySelector('.material-editor')?.innerText||''"),value=>value.includes('12.00'),'historical node details');
      const content=(await draft()).content;assert.deepEqual(content.fields[0].target,saved.target);
      assert.equal((await studio.materials.service.revision(studio.projects[0].id,saved.revisionId)).contentHash,saved.contentHash);
      report.journeys.U03={passed:true,restartedProcess:true,restoredBinding:content.fields[0].target};report.passed=true;
      await wait(async()=>frames.length,value=>value>12,'continuous reopened-window evidence');
    }else{
    await click('新建项目');await fill('项目名称','订单金额检查');await fill('业务目标','取得当前合成账户的两条订单实付金额，单位元，按页面显示保留。');await click('创建项目');
    await wait(async()=>studio.projects.length,n=>n===1,'UI-created project');
    await click('添加环境');await fill('环境名称','合成账户环境');await fill('登录入口',site.url+'/orders');await fill('登录说明','点击登录合成账户一');await fill('登录完成标记（可选 CSS）','#logged-in');await click('添加');
    await click('打开环境');await wait(async()=>studio.state().session,Boolean,'environment page');assert.equal(studio.runs.length,0);assert.equal(studio.active,undefined);await wait(()=>read<boolean>("!document.querySelector('.statusbar').textContent.includes('正在处理')"),Boolean,'environment navigation ready');
    if(numeric){
      await clickExpression("[...document.querySelectorAll('button')].find(el=>el.textContent==='尝试错误的合成凭据')",studio.current().view.webContents);
      await click('检查登录状态');assert.notEqual(studio.profiles[0].loginStatus,'verified');
      await clickExpression("document.querySelector('a')",studio.current().view.webContents);
    }
    await clickExpression("[...document.querySelectorAll('button')].find(el=>el.textContent==='登录合成账户一')",studio.current().view.webContents);
    await wait(()=>read<boolean>("!!document.querySelector('#logged-in')",studio.current().view.webContents),Boolean,'logged in');
    await click('检查登录状态');assert.equal(studio.profiles[0].loginStatus,'verified');await click('保留环境');await click('关闭浏览器会话');await click('打开环境');
    await wait(()=>read<boolean>("!!document.querySelector('#logged-in')",studio.current().view.webContents),Boolean,'persistent login');await click('检查登录状态');assert.equal(studio.runs.length,0);
    if(numeric){
      const storageRef=studio.profiles[0].storageRef;
      await clickExpression("[...document.querySelectorAll('button')].find(el=>el.textContent==='模拟登录过期')",studio.current().view.webContents);
      await wait(()=>read<boolean>("!document.querySelector('#logged-in')",studio.current().view.webContents),Boolean,'expired login');
      await click('检查登录状态');assert.notEqual(studio.profiles[0].loginStatus,'verified');
      await clickExpression("[...document.querySelectorAll('button')].find(el=>el.textContent==='登录合成账户一')",studio.current().view.webContents);
      await click('检查登录状态');assert.equal(studio.profiles[0].loginStatus,'verified');assert.equal(studio.profiles[0].storageRef,storageRef);
      report.loginNegative={failedCredentials:true,expired:true,reprepared:true,partitionUnchanged:true};
    }
    await popupCycle('未录制环境');assert.equal(studio.runs.length,0);
    report.journeys.U01={passed:true,storageRef:studio.profiles[0].storageRef,recordingsBeforeDemonstration:0};
    await click('开始录制');await wait(async()=>studio.active?.capture,value=>value==='recording','recording ready');
    await click('记录当前结果');await wait(async()=>(await draft()).content.checkpoints.length,n=>n===1,'unified savepoint');
    await fill('标题','订单列表');await fill('说明','这两条订单的实付金额需要保留元单位。');await click('存档');await click('保存点与字段');
    assert.equal(await read(`document.querySelector('.material-editor textarea')?.value`),'这两条订单的实付金额需要保留元单位。');await click('保存卡片草稿');
    const first=(await draft()).content.checkpoints[0];assert(first.sourceReceiptRef);report.journeys.U02={passed:true,cardId:first.id,receiptId:first.sourceReceiptRef};
    if(authoringFault){
      // Fault injection only: UI still creates the request and durable acquiring journal.
      studio.checkpoint=async()=>{
        await writeFile(path.join(studio.root,'recovery-cut.json'),JSON.stringify({processId:process.pid,stage:'authoring-acquiring',firstCardId:first.id,draftId:knownDraftId}));
        console.log('BES_RECOVERY_READY');return new Promise(()=>{});
      };
      await click('记录当前结果');await new Promise(()=>{});
    }
    await fill('新需求含义','两条订单的实付金额');await click('新建并关联需求');
    await choose('需求','两条订单的实付金额');
    await click('添加所需字段（实时页面）');await click('取消实时选择（Esc）');
    if(numeric)await fill('说明','采集前未保存的旧卡片说明必须保留');
    let associationFailures=0;
    const authorReceipt=studio.materials.authorReceipt.bind(studio.materials);
    if(numeric)studio.materials.authorReceipt=async(...args)=>{if(associationFailures++===0)throw new Error('Synthetic one-shot material association failure');return authorReceipt(...args);};
    await click('添加所需字段（实时页面）');await wait(async()=>studio.current().capture?.inspecting,Boolean,'live selection');
    await clickExpression("document.querySelector('[data-field=amount]')",studio.current().view.webContents);
    if(numeric){await click('重试关联已保存原件');studio.materials.authorReceipt=authorReceipt;report.partialAssociation={visibleRetry:true,associationFailures:1};}
    await wait(async()=>(await draft()).content.checkpoints.length,n=>n===2,'durable live example');
    if(numeric){assert.equal((await draft()).content.checkpoints[0].notes,'采集前未保存的旧卡片说明必须保留');report.dirtyBeforeCapture=true;await choose('值类型','number');}
    await fill('数据集','orders');await fill('字段名','实付金额');await choose('来源要求','必须按页面显示值');await fill('明确含义','订单实际支付的金额，单位元，保持页面显示。');await click('保存字段');
    await wait(async()=>(await draft()).content.fields.length,n=>n===1,'UI field persisted');
    if(numeric){
      await fill('期望记录数（可选）','2');await fill('不重复的输出标识字段（可选）','id');await click('保存需求');
      const before=await read<any>("(()=>{const el=document.querySelector('.material-workbench'),r=el.getBoundingClientRect();return{scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      assert(before.scrollHeight>before.clientHeight,'Long form must have a bounded scrolling container');
      ui.sendInputEvent({type:'mouseWheel',x:before.x,y:before.y,deltaY:before.scrollTop>50?400:-400,deltaX:0,canScroll:true});
      const after=await wait(()=>read<number>("document.querySelector('.material-workbench').scrollTop"),value=>value!==before.scrollTop,'mouse wheel scrolls long editor');
      report.longFormScroll={before,after,mouseWheel:true};
    }
    let content=(await draft()).content;assert.equal(content.requirements[0].dataset,'orders');assert(content.fields[0].target);assert.equal(content.fields[0].annotationId,undefined);assert.equal(content.checkpoints[0].anchor.eventSeq,first.anchor.eventSeq);
    assert.equal(await read("document.querySelector('[data-field=amount]').getAttribute('style')",studio.current().view.webContents),'outline:1px dotted red');
    report.journeys.U03={passed:true,fieldId:content.fields[0].id,target:content.fields[0].target};
    await fill('明确含义','订单实际支付金额，单位元；保留两位小数。');await click('存档');await click('保存点与字段');
    await clickExpression("[...document.querySelector('.material-card-list').querySelectorAll('button')].find(el=>el.textContent.startsWith('订单列表'))");await click('保存字段');
    content=(await draft()).content;assert.deepEqual(content.fields[0].target,report.journeys.U03.target);
    await click('新增注释');await click('在历史页选择元素');await pickHistory('[data-entity="order-two"] [data-field="amount"]');
    await fill('注释','另一条订单的金额示例');await click('保存注释');
    await wait(async()=>(await draft()).content.annotations.length,n=>n===1,'ordinary annotation');
    await click('从历史页绑定元素');await click('取消选择（Esc）');await click('保存字段');
    assert.deepEqual((await draft()).content.fields[0].target,report.journeys.U03.target);
    await click('解除绑定');await click('确认解除绑定');await click('保存字段');
    await wait(async()=>(await draft()).content.fields[0].target,value=>value===undefined,'explicit clear');
    await clickExpression("[...document.querySelector('.material-card-list').querySelectorAll('button')].find(el=>el.textContent.startsWith('字段现场示例'))");
    await click('从历史页绑定元素');await pickHistory('[data-entity="order-one"] [data-field="amount"]');await click('保存字段');
    await wait(async()=>(await draft()).content.fields[0].target,Boolean,'explicit rebind');
    report.journeys.U04={passed:true,retainedBindingAfterCardAndTabSwitch:true,ordinaryAnnotation:true,cancelledSelectionPreserved:true,explicitClear:true};
    await click('结束并封存');assert(studio.state().session);
    const recordingRoot=path.join(studio.root,'runs',report.journeys.U03.target.position.recordingId);
    async function originalHashes(){const result:Record<string,string>={};async function walk(relative:string){for(const entry of await readdir(path.join(recordingRoot,relative),{withFileTypes:true})){const child=path.join(relative,entry.name);if(entry.isDirectory())await walk(child);else result[child]=createHash('sha256').update(await readFile(path.join(recordingRoot,child))).digest('hex');}}await walk('raw');await walk('blobs');for(const file of ['checkpoints.jsonl','artifacts.jsonl'])result[file]=createHash('sha256').update(await readFile(path.join(recordingRoot,file))).digest('hex');return result;}
    const beforeOriginals=await originalHashes();await popupCycle('已封存会话');assert.deepEqual(await originalHashes(),beforeOriginals);await click('查看来源');
    await wait(()=>read<boolean>("!!document.querySelector('.replay-timeline')"),Boolean,'historical workspace');
    await fill('说明','历史补充：金额为订单实付，不含退款。');await click('保存卡片草稿');await click('新建卡片');await fill('标题','历史补充保存点');await fill('说明','从停止录制后的可靠历史位置补充，金额仍按页面显示。');await click('保存卡片草稿');
    await click('新增注释');await click('在历史页选择元素');await pickHistory('[data-entity="order-two"] [data-field="amount"]');
    await choose('类型','需求');await clickExpression("[...document.querySelectorAll('.material-editor label')].find(el=>el.textContent.trim()==='两条订单的实付金额')?.querySelector('input[type=checkbox]')");
    await fill('注释','发布时统一保存的历史注释');await fill('需求说明','两条订单实付金额，保留页面元单位');await fill('明确含义','订单实际支付金额，单位元；直接发布也应保存本次说明。');
    mark('E01：未分别保存卡片类型/关联、普通注释、需求与字段说明，直接发布');await click('发布候选版本');
    let revisions=await wait(()=>studio.materials.service.listRevisions(studio.projects[0].id,{limit:100,maxBytes:28672}),value=>value.items.length===1,'first published revision');assert.equal(revisions.items.length,1);
    const revision=await studio.materials.service.revision(studio.projects[0].id,revisions.items[0].revisionId);
    assert.equal(revision.content.fields[0].description,'订单实际支付金额，单位元；直接发布也应保存本次说明。');assert.deepEqual(revision.content.fields[0].target,report.journeys.U03.target);assert.deepEqual(revision.content.requirements[0].fieldIds,[revision.content.fields[0].id]);assert.equal(revision.content.requirements[0].dataset,'orders');assert.equal(revision.content.checkpoints[2].kind,'requirement');assert.deepEqual(revision.content.checkpoints[2].requirementIds,[revision.content.requirements[0].id]);assert(revision.content.annotations.some(item=>item.text==='发布时统一保存的历史注释'));
    report.regressions={E01:{visible:true,batchedDirectPublish:true,kind:true,association:true,ordinaryAnnotation:true,fieldAndRequirement:true},session:{visible:true,noRecordingPopupAndSwitch:true,sealedPopupAndSwitch:true,auditFailure:'module-only'},E02:{visible:'live cancellation and fresh selection',partialAndStaleFaults:'renderer/service injection only'},E03:{lateResponses:'renderer/service injection only'}};
    report.journeys.U05={passed:true,revisionId:revision.revisionId,contentHash:revision.contentHash};
    await click('复制');
    await wait(async()=>(await draft()).content.checkpoints.length,n=>n===4,'copied card');
    await clickExpression("[...document.querySelector('.material-card-list').querySelectorAll('button')].at(-1)");await fill('标题','订单列表副本');await click('保存卡片草稿');
    const copy=(await draft()).content.checkpoints.at(-1)!;assert(copy.derivedFrom);await click('发布候选版本');
    assert.equal((await studio.materials.service.revision(studio.projects[0].id,revision.revisionId)).contentHash,revision.contentHash);
    assert.equal(copy.title,'订单列表副本');assert.equal((await studio.materials.service.revision(studio.projects[0].id,revision.revisionId)).content.checkpoints.length,3);
    assert.deepEqual(await originalHashes(),beforeOriginals);
    const second=await wait(draft,value=>!!value.baseRevisionId&&value.baseRevisionId!==revision.revisionId,'second published revision');const implementationRevision=await studio.materials.service.revision(studio.projects[0].id,second.baseRevisionId!);
    report.journeys.U05={...report.journeys.U05,copyId:copy.id,derivedFrom:copy.derivedFrom,secondRevisionId:implementationRevision.revisionId,firstUnchanged:true,originalFilesUnchanged:Object.keys(beforeOriginals).length};
    for(const index of [1,0]){await clickExpression(`[...document.querySelectorAll('.material-revision button')][${index}]`);await wait(()=>read<string>("document.querySelector('.material-editor > section')?.innerText||''"),value=>value.includes(index===1?revision.revisionId:implementationRevision.revisionId),'fixed version view');const text=await read<string>("document.querySelector('.material-editor > section').innerText");assert.equal(text.includes('订单列表副本'),index===0);}
    const implementation=path.join(studio.root,'implementation');
    await click('任务授权');await clickExpression("[...document.querySelectorAll('.task-capabilities label')].find(el=>el.textContent.trim()==='导出交接包')?.querySelector('input')");
    await fill('有效分钟数','10');await fill('最多操作数','100');await click('授予这次任务');await choose('交接资料版本',implementationRevision.revisionId.slice(0,16));await click('准备交给 Agent');
    const handoffNotice=await wait(()=>read<string>("document.querySelector('.task-authorizations .notice')?.textContent||''"),value=>value.includes('固定交接已保存'),'implementation handoff export');
    const taskFile=handoffNotice.split('固定交接已保存：')[1].split('。将 task.md')[0];
    const consumed=await implementExportedProductTask(path.dirname(taskFile),implementation,site.url+'/orders');assert.equal(consumed.revisionId,implementationRevision.revisionId);
    await click('撤销此授权');await click('返回工作台');
    await click('执行');await fill('脚本目录',implementation);await click('登记脚本目录');await click('保存点与字段');await click('读取实现器映射');await click('确认映射并保存草稿');await click('发布候选版本');
    revisions=await wait(()=>studio.materials.service.listRevisions(studio.projects[0].id,{limit:100,maxBytes:28672}),value=>value.items.length===3,'mapped published revision');assert.equal(revisions.items.length,3);
    const fixedId=await read<string>("document.querySelector('select[aria-label=\"固定任务资料版本\"]')?.value||''");
    await click('返回实时页面');await click('执行');await choose('运行方式','当前页面试跑');
    const boundId=await read<string>("document.querySelector('select[aria-label=\"固定任务资料版本\"]').value");assert(boundId);
    const fixed=await studio.materials.service.revision(studio.projects[0].id,boundId);
    assert.equal(studio.active,undefined);
    await click('任务授权');
    for(const label of ['运行登记脚本','导出交接包','读取当前页面','操作当前页面','创建页面'])await clickExpression(`[...document.querySelectorAll('.task-capabilities label')].find(el=>el.textContent.trim()===${JSON.stringify(label)})?.querySelector('input')`);
    await fill('有效分钟数','10');await fill('最多操作数','100');await click('授予这次任务');
    await choose('交接资料版本',boundId.slice(0,16));await click('准备交给 Agent');
    await wait(()=>read<string>("document.querySelector('.task-authorizations .notice')?.textContent||''"),value=>value.includes('固定交接已保存'),'fixed handoff export');
    const authorizationId=await read<string>("[...document.querySelectorAll('.task-grant')].find(el=>[...el.querySelectorAll('button')].some(button=>button.textContent==='撤销此授权')).querySelector('code').textContent");
    const connection=JSON.parse(await readFile(path.join(studio.root,'connection','agent-connection.json'),'utf8'));
    const discoveryResponse=await fetch(connection.address+'/v1/state?authorizationId='+authorizationId,{headers:{Authorization:`Bearer ${connection.token}`}});assert.equal(discoveryResponse.status,200);const discovery:any=await discoveryResponse.json();assert.equal(discovery.active,null);const session=discovery.session,page=session.pages.find((page:any)=>page.pageId===session.selectedPageId);assert(page);assert.equal(session.controller,'agent');
    await click('返回工作台');const runsBefore=studio.runs.length,frontPageId=studio.current().pageId;
    const headers={Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'};
    const sessionQuery=(p:any)=>new URLSearchParams({authorizationId,pageId:p.pageId,generation:String(p.generation)});
    const currentRead=await fetch(connection.address+'/v1/sessions/'+session.sessionId+'/snapshot?'+sessionQuery(page),{headers});assert.equal(currentRead.status,200);assert.equal((await currentRead.json() as any).pageId,page.pageId);
    const requestPage=async(operation:string,extra:any)=>{const response=await fetch(connection.address+'/v1/sessions/'+session.sessionId+'/'+operation,{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({authorizationId,projectId:session.projectId,profileId:session.profileId,sessionId:session.sessionId,leaseEpoch:session.leaseEpoch,pageId:page.pageId,generation:page.generation,...extra})});assert.equal(response.status,202);const accepted:any=await response.json();const job=await wait<any>(async()=>{const response=await fetch(connection.address+'/v1/jobs/'+accepted.jobId+'?authorizationId='+authorizationId,{headers});return response.json();},value=>['succeeded','failed','cancelled'].includes(value.status),'session API '+operation);assert.equal(job.status,'succeeded',JSON.stringify(job.error));return job.result;};
    mark('E04：无录制，正式 session API 读取和点击当前页面');await requestPage('actions',{type:'click',selector:'#redraw'});await wait(()=>read<string>("document.querySelector('#redraw-count').textContent",studio.current().view.webContents),value=>value==='1','visible authorized click');
    const created=await requestPage('pages',{startUrl:site.url+'/orders'});assert.equal(created.runId,undefined);const backgroundRead=await fetch(connection.address+'/v1/sessions/'+session.sessionId+'/snapshot?'+sessionQuery(created),{headers});assert.equal(backgroundRead.status,200);assert.equal((await backgroundRead.json() as any).pageId,created.pageId);assert.equal(studio.current().pageId,frontPageId);assert.equal(studio.runs.length,runsBefore);assert.equal(studio.active,undefined);report.regressions.E04={visible:true,authorizedCurrentRead:true,authorizedClick:true,createdBackgroundRead:true,foregroundUnchanged:true,newRecordings:0};

    mark('授权 Agent 经正式 POST /v1/validations 执行 UI 固定资料；当前无录制');
    const launchBody={authorizationId,projectId:session.projectId,profileId:session.profileId,sessionId:session.sessionId,leaseEpoch:session.leaseEpoch,pageId:page.pageId,generation:page.generation,executionMode:'current-page-test',materialRevisionId:boundId,materialContentHash:fixed.contentHash,input:{variant:'good'}};
    for(const wrongRun of [report.journeys.U03.target.position.recordingId,randomUUID()]){
      const deniedResponse=await fetch(connection.address+'/v1/runs/'+wrongRun+'/validations',{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(launchBody)});
      const denied:any=await deniedResponse.json();if(deniedResponse.status===202){const terminal=await wait<any>(async()=>{const response=await fetch(connection.address+'/v1/jobs/'+denied.jobId+'?authorizationId='+authorizationId,{headers:{Authorization:`Bearer ${connection.token}`}});return response.json();},value=>['succeeded','failed','cancelled'].includes(value.status),'stopped run target rejected');assert.equal(terminal.status,'failed');}else assert.equal(deniedResponse.status,409);
      assert.equal(studio.active,undefined);
    }
    const response=await fetch(connection.address+'/v1/validations',{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({authorizationId,projectId:session.projectId,profileId:session.profileId,sessionId:session.sessionId,leaseEpoch:session.leaseEpoch,pageId:page.pageId,generation:page.generation,executionMode:'current-page-test',materialRevisionId:boundId,materialContentHash:fixed.contentHash,input:{variant:'good'}})});
    const submitted:any=await response.json();assert.equal(response.status,202,JSON.stringify(submitted));
    const job=await wait<any>(async()=>{const response=await fetch(connection.address+'/v1/jobs/'+submitted.jobId+'?authorizationId='+authorizationId,{headers:{Authorization:`Bearer ${connection.token}`}});return response.json();},value=>['succeeded','failed','cancelled'].includes(value.status),'authorized execution start');assert.equal(job.status,'succeeded',JSON.stringify(job.error));
    await wait(async()=>studio.state().validations.find(item=>item.id===job.result.id)?.status,value=>value==='completed','authorized execution completion');
    await click('任务授权');await click('撤销此授权');await click('返回工作台');
    const revokedRead=await fetch(connection.address+'/v1/sessions/'+session.sessionId+'/snapshot?'+sessionQuery(page),{headers});assert.equal(revokedRead.status,403);report.regressions.E04.revokedReadRejected=true;
    const results=[];
    for(const variant of ['good','wrong','unverified']){
      await fill('输入 JSON',JSON.stringify({variant}));const before=studio.state().validations.length;
      await click('运行脚本并验收');
      await wait(async()=>studio.state().validations.length,n=>n===before+1,'new UI execution');
      const execution=studio.state().validations[0];
      await wait(async()=>studio.state().validations.find(item=>item.id===execution.id)?.status,value=>value==='completed','execution completion');
      await click('用于验收');await click('查看数据');await clickExpression("document.querySelector('.result-data button')");
      await click('按所选 attempt 验收');
      await wait(()=>read<string>("document.querySelector('.result-center')?.innerText||''"),value=>value.includes('独立')||value.includes('source:'),'saved visible report');
      const reports=await studio.executions.reports(studio.projects[0].id,execution.id,{limit:10,maxBytes:24576});
      const saved=reports.items[0] as any;assert(saved);
      const expected=variant==='good'?'pass':variant==='wrong'?'fail':'inconclusive';assert.equal(saved.overall,expected);
      results.push({variant,executionId:execution.id,materialRevisionId:boundId,reportId:saved.reportId,overall:saved.overall});
      if(numeric&&variant==='wrong'){
        const details:any=await studio.executions.reportItems(studio.projects[0].id,execution.id,saved.reportId,'requirements',{limit:10,maxBytes:24576});
        const req=details.items[0],diagnostic=req.fieldDiagnostics.find((item:any)=>item.code==='value-mismatch');assert(diagnostic);assert.equal(diagnostic.interpretation,'plain-decimal-v1');
        await clickExpression("[...document.querySelectorAll('.result-center button')].find(el=>el.textContent.startsWith('需求示例：'))");
        await wait(()=>read<string>("document.querySelector('.result-source-location')?.textContent||''"),value=>value.includes('需求示例'),'requirement example navigation');
        await click('返回执行结果');await clickExpression(`[...document.querySelectorAll('.result-center button')].find(el=>el.textContent.startsWith(${JSON.stringify(saved.reportId.slice(0,16))}))`);
        await click('本次验证来源');
        await wait(()=>read<string>("document.querySelector('.result-source-location')?.textContent||''"),value=>value.includes('本次验证来源'),'actual source navigation');
        await wait(async()=>(studio.replayHost as any).active?.state?.position,value=>value?.recordingId===execution.runId&&value?.eventSeq===diagnostic.target.position.eventSeq,'actual source exact boundary');
        report.resultNavigation={exampleRecording:req.materialContext.fields[0].example.anchor.recordingId,actualSource:diagnostic};
        await click('返回执行结果');
      }
      await click('返回工作台');
      if(numeric&&variant==='wrong')await click('返回实时页面');
    }
    report.journeys.U06={passed:true,results,authorizedExecutionWithoutActiveRecording:job.result.id,exportedFixedVersion:boundId};report.passed=true;
    await writeFile(path.join(studio.root,'journey-state.json'),JSON.stringify({processId:process.pid,draftId:knownDraftId,target:(await draft()).content.fields[0].target,revisionId:fixed.revisionId,contentHash:fixed.contentHash},null,2));
    }

  }catch(error){report.error=String(error);throw error;}
  finally{await evidence.stop(report);await site.close();}
  assert(report.passed,'Product journey did not complete');assert(frames.length>10,'Continuous window capture has too few frames');assert.equal(report.continuousVideo.exitCode,0,'Continuous video capture failed');assert(report.continuousVideo.maxGapMs<10000,'Continuous frame gap exceeds 10 seconds');return report;
}
