import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';
import { setUiTheme } from './ui-layout';

async function waitUntil<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,label:string,timeoutMs=30000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){const value=await read();if(accept(value))return value;await delay(25);}
  throw new Error('Timed out waiting for '+label);
}

export async function runCheckpointScenarios(studio:Studio,url:string){
  if(studio.active)await studio.seal(); if(studio.state().session)await studio.closeSession();
  const project=await studio.createProject({name:'Checkpoint cancellation',objective:'Synthetic timeout, partial capture and cancellation'});
  const profile=await studio.createProfile({projectId:project.id,name:'isolated checkpoint profile'});
  await studio.startRun({projectId:project.id,profileId:profile.id,url:url+'/orders'});
  const run=studio.required(),page=studio.current(),dispatch=makeDispatch(studio);
  const originalEvaluate=page.page.evaluate,originalCapture=page.view.webContents.capturePage;
  let lateDom!:(html:string)=>void,screenshotDone!:()=>void;
  const screenshotReady=new Promise<void>(resolve=>{screenshotDone=resolve;});
  try{
    page.page.evaluate=(()=>new Promise<string>(resolve=>{lateDom=resolve;})) as typeof originalEvaluate;
    page.view.webContents.capturePage=(async(...args:Parameters<typeof originalCapture>)=>{
      const image=await originalCapture.apply(page.view.webContents,args);screenshotDone();return image;
    }) as typeof originalCapture;
    const pending=dispatch('checkpoint',{key:'cancelled-dom',title:'Screenshot survives cancellation'});
    await screenshotReady;await delay(0);
    const operationId=run.checkpointTask!.id;
    assert.equal(run.locked,true);
    await assert.rejects(dispatch('cancelCheckpoint',{runId:run.id,operationId:'other-operation'}));
    if(process.env.BES_SKIP_UI)await dispatch('cancelCheckpoint',{runId:run.id,operationId});
    else{
      const ui=studio.window.window.webContents;
      const leaseBeforePresentation=run.leaseEpoch,controllerBeforePresentation=run.controller;
      await setUiTheme(studio,'dark');
      await ui.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='连接与环境')?.click()`);
      await waitUntil(()=>page.view.getVisible(),visible=>!visible,'checkpoint dialog hides native view without waiting for capture',5000);
      assert.equal(run.locked,true);assert.equal(run.checkpointTask?.id,operationId);
      await ui.executeJavaScript(`Array.from(document.querySelectorAll('.overlay-heading button')).find(button=>button.textContent.trim()==='返回工作台')?.click()`);
      await waitUntil(()=>page.view.getVisible(),Boolean,'checkpoint dialog restores native view',5000);
      assert.equal(studio.window.mask.getVisible(),true,'Closing the dialog cannot release an active checkpoint input lock');
      assert.equal(run.leaseEpoch,leaseBeforePresentation);assert.equal(run.controller,controllerBeforePresentation);
      await setUiTheme(studio,'light');
      await ui.executeJavaScript(`(()=>{const button=Array.from(document.querySelectorAll('.panel-tabs button')).find(button=>button.textContent==='保存点');if(!button)return;button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));button.click();})()`);
      await waitUntil(()=>ui.executeJavaScript(`!!document.querySelector('.checkpoint-progress button:not(:disabled)')`),Boolean,'React checkpoint cancel button',5000);
      assert.equal(await ui.executeJavaScript(`(()=>{const button=document.querySelector('.checkpoint-progress button:not(:disabled)');if(!button)return false;button.click();return true;})()`),true);
    }
    const cancelled=await pending;
    assert.equal(cancelled.metadata.captureOutcome,'cancelled');assert.equal(cancelled.metadata.captureStatus,'partial');
    assert.equal(run.locked,false);assert.equal(run.checkpointTask,undefined);
    assert.equal(cancelled.metadata.artifacts[0].captureStatus,'complete');
    assert.equal(cancelled.metadata.artifacts[1].captureStatus,'read-failed');
    page.page.evaluate=originalEvaluate;page.view.webContents.capturePage=originalCapture;
    const next=await dispatch('checkpoint',{key:'after-cancel',title:'A new capture succeeds'});
    lateDom('<html>late data from the cancelled capture</html>');await delay(0);
    assert.equal(next.metadata.captureStatus,'complete');assert.equal(next.metadata.captureOutcome,'completed');
    const reader=studio.reader(run.id);
    const oldDom=await reader.artifactMetadata(cancelled.artifactRefs[1]);
    assert.equal(oldDom.captureStatus,'read-failed');assert.equal(oldDom.path,undefined);
    assert.equal(run.locked,false);
    // Real service deadline with a native capture promise that never settles.
    page.view.webContents.capturePage=(()=>new Promise(()=>{})) as typeof originalCapture;
    const started=performance.now();const timed=await dispatch('checkpoint',{key:'timed-out-shot'});
    assert.ok(performance.now()-started<15000,'A hung screenshot must not lock the service indefinitely');
    assert.equal(timed.metadata.captureOutcome,'timed-out');assert.equal(timed.metadata.captureStatus,'partial');
    assert.equal(timed.metadata.artifacts[1].captureStatus,'complete');assert.equal(run.locked,false);
    assert.equal(run.checkpointTask,undefined);
    page.view.webContents.capturePage=originalCapture;
    // Page closure transfers cleanup to a new lease. Human input may reopen only
    // after the former capture and any operation disconnect both finish.
    for(const controller of ['human','agent'] as const){
      await studio.control('agent');
      await studio.action({type:'click',selector:'#open-popup',pageId:page.pageId,generation:page.navigationGeneration,leaseEpoch:run.leaseEpoch});
      const child=await waitUntil(()=>[...run.pages.values()].find(candidate=>candidate.pageId!==page.pageId),Boolean,'checkpoint popup');
      assert.ok(child);await studio.serialized(async()=>{});await child.page.waitForSelector('#popup-button');
      await dispatch('selectPage',{pageId:child.pageId});
      try{await studio.action({type:'click',selector:'#popup-button',pageId:child.pageId,generation:child.navigationGeneration,leaseEpoch:run.leaseEpoch});}
      catch(error){throw new Error(`Checkpoint popup click failed; native=${JSON.stringify(studio.window.presentationStatus())}`,{cause:error});}
      if(controller==='human')await studio.control('human');
      const operation=run.operation,childContents=child.view.webContents;
      const childEvaluate=child.page.evaluate,childCapture=childContents.capturePage;
      const disconnect=operation?.browser.disconnect;
      let releaseDisconnect=()=>{},finishImage!:()=>void,late!: (html:string)=>void;
      const imageReady=new Promise<void>(resolve=>{finishImage=resolve;});
      if(operation){
        const disconnected=new Promise<void>(resolve=>{releaseDisconnect=resolve;});
        operation.browser.disconnect=async()=>{await disconnected;await disconnect!.call(operation.browser);};
      }
      try{
        child.page.evaluate=(()=>new Promise<string>(resolve=>{late=resolve;})) as typeof childEvaluate;
        childContents.capturePage=(async(...args:Parameters<typeof childCapture>)=>{const image=await childCapture.apply(childContents,args);finishImage();return image;}) as typeof childCapture;
        // This legacy lifecycle probe is driven by the trusted client; HTTP
        // checkpoint access requires a separate scoped task authorization.
        const capturing=dispatch('checkpoint',{key:'closed-'+controller,runId:run.id,pageId:child.pageId,generation:child.navigationGeneration,leaseEpoch:run.leaseEpoch},'ui');
        await imageReady;await delay(0);const leaseBeforeClosure=run.leaseEpoch;
        childContents.close();
        const retained=await capturing;
        assert.equal(retained.metadata.captureOutcome,'cancelled');assert.equal(retained.metadata.captureStatus,'partial');
        assert.equal(retained.captureConsistency,'unknown');assert.ok(run.leaseEpoch>leaseBeforeClosure);
        assert.equal(run.selectedPageId,page.pageId);assert.equal(run.controller,controller);
        if(operation){assert.equal(run.locked,true,'A page-close cleanup must await operation disconnect before restoring input');assert.equal(operation.gate.snapshot().state,'closed');}
        releaseDisconnect();await Promise.allSettled([...(run.pageClosures??[])]);
        assert.equal(run.locked,false,'The replacement page cannot retain the finished checkpoint lock');
        assert.equal(run.checkpointTask,undefined);assert.equal(run.operation,undefined);
        late('<html>late closed-page DOM must be ignored</html>');await delay(0);
        const failedDom=await studio.reader(run.id).artifactMetadata(retained.artifactRefs[1]);
        assert.equal(failedDom.captureStatus,'read-failed');assert.equal(failedDom.path,undefined);
        if(controller==='human')await studio.navigate(url+'/orders');
        else await studio.action({type:'click',selector:'#increment',pageId:page.pageId,generation:page.navigationGeneration,leaseEpoch:run.leaseEpoch});
      }finally{
        releaseDisconnect();child.page.evaluate=childEvaluate;
        if(operation&&disconnect)operation.browser.disconnect=disconnect;
        if(!childContents.isDestroyed()){childContents.capturePage=childCapture;childContents.close();}
      }
    }
    console.log('CHECKPOINT PASS: real service timeout, task-bound cancellation, partial durability, unlock and late-result isolation');
  }finally{
    page.page.evaluate=originalEvaluate;page.view.webContents.capturePage=originalCapture;
    if(studio.active===run){await studio.seal(); if(studio.state().session)await studio.closeSession();}
  }
  await runIncompleteRunnerCheckpoints(studio,url);
}

async function runIncompleteRunnerCheckpoints(studio:Studio,url:string){
  const project=await studio.createProject({name:'Incomplete runner checkpoints',objective:'A persisted incomplete checkpoint cannot count as successful workflow coverage',scriptDirectory:path.resolve('examples/orders')});
  const profile=await studio.createProfile({projectId:project.id,name:'isolated incomplete runner profile'});
  const originalCheckpoint=studio.checkpoint;
  try{
    for(const scenario of ['partial','failed','timed-out'] as const){
      studio.checkpoint=async(body,options)=>{
        const target=studio.current(),contents=target.view.webContents;
        const capture=contents.capturePage,evaluate=target.page.evaluate;
        contents.capturePage=(scenario==='timed-out'?()=>new Promise(()=>{}):async()=>{throw new Error('Synthetic screenshot acquisition failure');}) as typeof capture;
        if(scenario==='failed')target.page.evaluate=(async()=>{throw new Error('Synthetic DOM acquisition failure');}) as typeof evaluate;
        try{return await originalCheckpoint.call(studio,body,options);}
        finally{contents.capturePage=capture;target.page.evaluate=evaluate;}
      };
      const started=await studio.validate({projectId:project.id,profileId:profile.id,input:{baseUrl:url,variant:'normal'}});
      const record=await waitUntil(()=>studio.validation(started.id),value=>['completed','failed','cancelled','interrupted'].includes(value.status)&&!!(value.artifactId||value.error),'incomplete runner validation',45000);
      assert.equal(record.result?.status,'failed',scenario+': incomplete checkpoint must fail execution');
      assert.equal(record.result.validation.overall,'fail');assert.equal(record.result.validation.coverageVerdict,'not-run');
      assert.deepEqual(record.result.checkpoints,[],'Persisted partial evidence must not become a covered checkpoint');
      assert.ok(record.result.error);
      assert.match(record.result.error,/Checkpoint capture is incomplete/);
      const checkpoints=await studio.reader(started.runId).checkpoints({limit:20,maxBytes:32768});
      const retained=checkpoints.items.find((value:any)=>value.key==='orders-complete') as any;
      assert.ok(retained,'Incomplete capture evidence must remain available for diagnosis');
      assert.equal(retained.metadata.captureOutcome,scenario==='timed-out'?'timed-out':'completed');
      assert.equal(retained.metadata.captureStatus,scenario==='failed'?'failed':'partial');
      assert.equal(retained.artifactRefs.length,2);assert.equal(studio.required().controller,'human');assert.equal(studio.required().locked,false);
      await studio.seal(); if(studio.state().session)await studio.closeSession();
    }
    console.log('CHECKPOINT RUNNER PASS: partial, failed and timed-out captures remain saved but cannot satisfy validation coverage');
  }finally{
    studio.checkpoint=originalCheckpoint;
    if(studio.active){await studio.stopRunner();await studio.seal(); if(studio.state().session)await studio.closeSession();}
  }
}
