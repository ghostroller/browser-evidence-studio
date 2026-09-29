import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { clickSyntheticHuman } from './native-input';
import { captureUiFrame } from './ui-layout';
import { startFixture } from '../fixtures/site';

export async function runNativeInputScenarios(studio:Studio){
  const fixture=await startFixture(),report:any={passed:false,pid:process.pid,cases:[]};
  const record=(name:string)=>{report.cases.push(name);console.log('NATIVE PASS: '+name);};
  try{
    const project=await studio.createProject({name:'Native lifecycle input',objective:'Synthetic target ownership and cancellation'});
    const profile=await studio.createProfile({projectId:project.id,name:'Synthetic isolated'});
    await studio.startRun({projectId:project.id,profileId:profile.id,url:fixture.url+'/orders'});
    const r=studio.required(),front=studio.current();
    const ready=async()=>{await front.page.waitForFunction(()=>document.querySelector('#api-state')?.textContent==='已就绪');};await ready();
    const visibleDeadline=Date.now()+5000;while(!front.view.getVisible()&&Date.now()<visibleDeadline)await delay(20);
    assert(front.view.getVisible(),JSON.stringify(studio.window.presentationStatus()));
    await studio.control('agent');
    const action=(target=front,signal?:AbortSignal)=>studio.action({type:'click',selector:'#increment',pageId:target.pageId,generation:target.navigationGeneration,leaseEpoch:r.leaseEpoch},signal);
    const count=(target=front)=>target.page.$eval('#action-count',el=>Number(el.textContent));
    const host=studio.window.window;host.minimize();await delay(100);
    report.minimized={contentSize:host.getContentSize(),minimized:host.isMinimized(),presentation:studio.window.presentationStatus()};
    try{await assert.rejects(action(),/input_not_ready|native-hidden|native-bounds|minimized/);}
    finally{host.restore();await delay(100);}
    assert.equal(await count(),0);record('minimized window rejects input');
    await action();assert.equal(await count(),1);record('foreground actual click');
    await front.capture!.flush();const position=front.capture!.recordingPosition;assert(position);
    for(let i=0;i<3;i++){
      const opened=await studio.replayHost.open({projectId:project.id,position});assert.equal(opened.status,'ready',opened.error);
      if(i===0){
        const replay=(studio.replayHost as any).active.view;
        report.replayPresentation={native:studio.window.presentationStatus(),frame:await replay.webContents.executeJavaScript(`(()=>{const f=document.querySelector('#replay iframe'),r=f?.getBoundingClientRect(),root=document.querySelector('#replay')?.getBoundingClientRect();return {iframe:r&&{x:r.x,y:r.y,width:r.width,height:r.height},root:root&&{x:root.x,y:root.y,width:root.width,height:root.height},bodyTextLength:f?.contentDocument?.body?.innerText?.length||0,visible:document.visibilityState,viewportHeight:window.innerHeight,mousePosition:getComputedStyle(document.querySelector('.replayer-mouse')).position}})()`)};
        assert(replay.getVisible(),JSON.stringify(studio.window.presentationStatus()));
        assert.equal(report.replayPresentation.frame.mousePosition,'absolute','rrweb cursor must not push the page iframe below the viewport');
        assert(report.replayPresentation.frame.iframe.y<report.replayPresentation.frame.viewportHeight/4,JSON.stringify(report.replayPresentation.frame));
        assert(report.replayPresentation.frame.bodyTextLength>50,'Source content must exist in the visible replay iframe');
        await captureUiFrame(studio,'native-replay.png');
      }
      assert(!front.view.getVisible());await assert.rejects(action(),/replay-owner/);studio.replayHost.close(opened.replayId);
      if(i===0)await captureUiFrame(studio,'native-live-after-replay.png');
      assert(front.view.getVisible(),JSON.stringify(studio.window.presentationStatus()));await action();assert.equal(await count(),i+2);
    }
    record('live archive live real clicks and closed owner');
    const ui=studio.window.window.webContents;
    const wait=async(predicate:()=>Promise<boolean>|boolean,label:string)=>{
      const until=Date.now()+10000;
      while(Date.now()<until){if(await predicate())return;await delay(50);}
      throw new Error(`${label}: ${JSON.stringify(studio.window.presentationStatus())}`);
    };
    for(let i=0;i<5;i++){
      await ui.executeJavaScript(`Array.from(document.querySelectorAll('.evidence-strip button')).find(button=>button.textContent.trim()==='打开历史回放').click()`);
      await wait(()=>!!(studio.replayHost as any).active?.state?.status&&
        (studio.replayHost as any).active.state.status==='ready','React history replay ready');
      const replay=(studio.replayHost as any).active.view;
      assert(replay.getVisible(),JSON.stringify(studio.window.presentationStatus()));
      const frame=await replay.webContents.executeJavaScript(`(()=>{const f=document.querySelector('#replay iframe'),r=f.getBoundingClientRect();return {top:r.top,height:r.height,viewport:innerHeight,bodyTextLength:f.contentDocument.body.innerText.length}})()`);
      assert(frame.top<frame.viewport/4&&frame.bodyTextLength>50,JSON.stringify(frame));
      if(i===0)await captureUiFrame(studio,'native-react-replay.png');
      await ui.executeJavaScript(`Array.from(document.querySelectorAll('.replay-heading button')).find(button=>button.textContent.trim()==='返回实时页面').click()`);
      await wait(()=>!(studio.replayHost as any).active&&front.view.getVisible(),'React return to live page');
      if(i===0||i===4)await captureUiFrame(studio,`native-react-live-restored-${i+1}.png`);
    }
    record('React replay repeatedly paints source and restores live native view');
    studio.window.setPresentation('overlay',true);await assert.rejects(action(),/overlay/);assert.equal(await count(),4);studio.window.setPresentation('overlay',false);
    assert(studio.window.mask.getVisible());await action();assert.equal(await count(),5);record('overlay rejects input and retains mask');
    await studio.control('human');
    await front.page.evaluate(()=>{
      (window as any).__besPointerDownCount=0;
      document.querySelector('#increment')?.addEventListener('pointerdown',()=>{(window as any).__besPointerDownCount++;});
    });
    await wait(()=>ui.executeJavaScript(`Array.from(document.querySelectorAll('.browser-toolbar button')).some(button=>button.textContent.trim()==='选取元素（实时页）'&&!button.disabled)`),'live picker button available');
    await ui.executeJavaScript(`Array.from(document.querySelectorAll('.browser-toolbar button')).find(button=>button.textContent.trim()==='选取元素（实时页）').click()`);
    await wait(()=>front.capture!.inspecting,'live picker enabled');
    const beforePick=await count();
    await clickSyntheticHuman(studio,'#increment');
    await wait(()=>!!(r.selection as any)?.element&&(r.selection as any).element.tag==='button','native live target selected');
    assert.equal(await count(),beforePick,'Inspection must not execute the site click handler');
    assert.equal(await front.page.evaluate(()=>(window as any).__besPointerDownCount),0,'Inspection must not execute the site pointerdown handler');
    await wait(()=>ui.executeJavaScript(`document.querySelector('.live-element-selection')?.textContent?.includes('已选实时元素')||false`),'live selection summary visible');
    await ui.executeJavaScript(`Array.from(document.querySelectorAll('.browser-toolbar button')).find(button=>button.textContent.trim()==='结束选取（实时页）').click()`);
    await wait(()=>!front.capture!.inspecting,'live picker disabled');
    await clickSyntheticHuman(studio,'#increment');
    assert.equal(await count(),beforePick+1,'Normal native page click resumes after inspection');
    record('React live picker intercepts native click and pointerdown, then restores normal page input');
    const grant=await studio.authorizeTask({projectId:project.id,profileId:profile.id,sessionId:studio.browserSessionId,leaseEpoch:r.leaseEpoch,pageIds:[front.pageId],origins:[fixture.url],capabilities:['page-read','page-act','page-create'],durationMs:180000,maxOperations:100});
    const created=await studio.createTaskPage({authorizationId:grant.authorizationId,pageId:front.pageId,generation:front.navigationGeneration,leaseEpoch:r.leaseEpoch,startUrl:fixture.url+'/orders'});
    const back=r.pages.get(created.pageId)!;await back.page.waitForFunction(()=>document.querySelector('#api-state')?.textContent==='已就绪');await action(back);
    assert.equal(await count(back),1);assert.equal(r.selectedPageId,front.pageId);assert(!back.view.getVisible());assert(studio.window.mask.getVisible());record('background actual click keeps foreground and mask');
    await action();
    // Hold after genuine browser geometry, then cancel before any mouse command.
    const heldAction=async(kind:'abort'|'deadline'|'navigation')=>{
      const operation=r.operation!,original=operation.page.$.bind(operation.page),controller=new AbortController();
      let reached!:()=>void,release!:()=>void;const atPoint=new Promise<void>(resolve=>{reached=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
      operation.page.$=(async(...args:Parameters<typeof original>)=>{const el=await original(...args);if(el){const geometry=el.clickablePoint.bind(el);el.clickablePoint=async(...params)=>{const point=await geometry(...params);reached();await held;return point;};}return el;}) as typeof original;
      const before=await count(),signal=kind==='deadline'?AbortSignal.timeout(100):controller.signal;
      const result=action(front,signal).then(()=>({ok:true,error:''}),error=>({ok:false,error:String(error)}));
      try{
        await atPoint;
        if(kind==='navigation'){await front.page.goto(fixture.url+'/orders?document=changed');await ready();}
        else if(kind==='deadline')await delay(140);else controller.abort();
        release();const outcome=await result;assert.equal(outcome.ok,false,outcome.error);
        assert.match(outcome.error,kind==='navigation'?/generation|document/:/Action stopped/);
        await delay(120);assert.equal(await count(),kind==='navigation'?0:before,'No late mouse input after cancellation/document replacement');
        if(kind!=='navigation'){assert.equal(r.operation,undefined);assert.equal(r.pendingOperation,undefined);}
      }finally{release();operation.page.$=original;}
      record(kind+' after geometry rejects late input');
    };
    await heldAction('abort');await action();await heldAction('deadline');await action();await heldAction('navigation');await action();
    assert.equal(await count(),1);record('fresh document input recovers');
    host.minimize();await delay(100);await studio.control('human');await clickSyntheticHuman(studio,'#increment');await delay(100);assert.equal(await count(),2);record('human synthetic input restores minimized window before readiness');
    await studio.control('agent');
    let releaseQueue!:()=>void;const heldQueue=new Promise<void>(resolve=>{releaseQueue=resolve;}),blocked=studio.serialized(()=>heldQueue);
    const beforeQueue=await count();
    try{await assert.rejects(studio.serialized(()=>action(),AbortSignal.timeout(75)),/Action stopped during queue/);}finally{releaseQueue();await blocked;}
    await delay(100);assert.equal(await count(),beforeQueue);record('queued deadline never executes later');
    report.passed=true;return report;
  }finally{await writeFile(path.join(studio.root,'native-input-report.json'),JSON.stringify(report,null,2));await fixture.close();}
}
