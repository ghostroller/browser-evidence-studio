import { app, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { StudioWindow } from './window';
import { Studio } from './services/studio';
import { ensure } from '@/shared/errors';
import { makeDispatch } from './services/dispatch';
import { startApi, type ApiHandle } from './api/server';
import { LifecycleLog } from './lifecycle-log';
import { isTrustedUiSender } from './ui-ipc';
import { configureBrowserEnvironment } from './browser/environment';
import { resolveStudioDataRoot } from './test-mode';

configureBrowserEnvironment();
const dataRoot=(()=>{
  try{return resolveStudioDataRoot(process.env,app.getPath('appData'),app.isPackaged);}
  catch(error){console.error('Browser Evidence Studio startup refused: '+String(error));process.exit(2);}
})();
app.setPath('userData',dataRoot);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port','0');
// Managed scripts still need compositor visibility callbacks behind other desktop windows.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
protocol.registerSchemesAsPrivileged([
  {scheme:'bes-artifact',privileges:{standard:true,secure:true,supportFetchAPI:true}},
  // Handlers are installed only on an authorized, isolated replay partition.
  {scheme:'bes-resource',privileges:{standard:true,secure:true,corsEnabled:true,supportFetchAPI:true}}
]);
let studio:Studio|undefined;let api:ApiHandle|undefined;let quitting=false;let lifecycle:LifecycleLog|undefined;
let shutdownTask:Promise<void>|undefined;let shutdownExitCode=0;
async function endpoint(){for(let i=0;i<100;i++){try{const [port,browserPath]=(await readFile(path.join(dataRoot,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);const url=`http://127.0.0.1:${port}/json/version`;const data=await fetch(url).then(r=>r.json()) as any;if(data.webSocketDebuggerUrl)return `ws://127.0.0.1:${port}${browserPath}`;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Internal CDP endpoint did not become ready');}
if(!app.requestSingleInstanceLock())app.quit();
else app.whenReady().then(async()=>{
  await mkdir(dataRoot,{recursive:true});lifecycle=await LifecycleLog.start(dataRoot);
  const testPhase=process.env.BES_TEST?process.env.BES_TEST_PHASE||'main':undefined;
  const recoveryObserver=testPhase==='recovery-crash'?(await import('../../test/desktop/recovery-scenarios')).recoveryObserver(dataRoot,async(stage)=>{await lifecycle?.record('recovery-test-cut',{stage});},()=>{ensure(studio,'Synthetic recovery requires initialized Studio');return studio;}):undefined;
  const window=new StudioWindow();studio=new Studio(dataRoot,window,await endpoint(),recoveryObserver);
  await lifecycle.record('workspace-opening');await studio.init();await lifecycle.record('workspace-opened');
  const dispatch=makeDispatch(studio);api=await startApi({root:dataRoot,instanceId:studio.instanceId,dispatch});studio.connection={address:api.address,file:api.connectionFile};
  protocol.handle('bes-artifact',async request=>{try{
    const u=new URL(request.url),reader=studio!.reader(u.hostname),id=u.pathname.slice(1),metadata=await reader.artifactMetadata(id);
    if(metadata.kind!=='screenshot'||metadata.mediaType!=='image/png'||metadata.captureStatus!=='complete'||metadata.capturedBytes>16*1024*1024)return new Response('Only saved PNG screenshots can be displayed',{status:403});
    const artifact=await reader.artifactFile(id),source=await net.fetch(pathToFileURL(artifact.path).href);
    return new Response(source.body,{headers:{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'"}});
  }catch{return new Response('Artifact unavailable',{status:404});}});
  ipcMain.handle('studio:call',async(event,method,body)=>{
    ensure(!quitting&&isTrustedUiSender(event,window),'Untrusted or closing UI sender',403);
    return dispatch(method,body,'ui');
  });
  ipcMain.on('studio:bounds',(event,rect)=>{if(!quitting&&isTrustedUiSender(event,window))window.bounds(rect);});
  const startupReload = testPhase==='startup-reload'||testPhase==='startup-failed' ? (await import('../../test/desktop/startup')).prepareStartupReload(window,testPhase==='startup-failed') : undefined;
  try{await window.load();}
  catch(error){await lifecycle.record('ui-startup-failed',window.startupStatus());throw error;}
  await lifecycle.record('ui-ready');
  window.window.on('close',event=>{event.preventDefault();void shutdown('window-close');});
  if(process.env.BES_TEST){
    const phase=process.env.BES_TEST_PHASE||'main';
    const allowedPhases=['native-input','main','refactor-s0','refactor-replay','refactor-recording-record','refactor-recording-offline','refactor-recovery','refactor-recovery-soak','refactor-recovery-verify','refactor-runner','refactor-system','refactor-handoff','profile-restart','recovery-crash','recovery-verify','recovery-repeat','exit-window-close','exit-app-quit','startup-cold','startup-warm','startup-reload','startup-failed'];
    ensure(allowedPhases.includes(phase),'Unknown desktop test phase');
    const resultFile=phase==='main'?'test-result.json':`${phase}-result.json`;
    const identity:Record<string,unknown>={phase,processId:process.pid,startedAt:new Date().toISOString()};
    try{
      await lifecycle.record('test-started',{phase});
      if(phase==='exit-window-close'||phase==='exit-app-quit'){
        const {startFixture}=await import('../../test/fixtures/site');const fixture=await startFixture();
        const project=await studio.createProject({name:'Exit reentry',objective:'Retain acknowledged evidence while close requests repeat'});
        const profile=await studio.createProfile({projectId:project.id,name:'Synthetic exit profile'});
        await studio.startRun({projectId:project.id,profileId:profile.id,url:fixture.url+'/orders'});
        const runId=studio.required().id,checkpoint=await studio.checkpoint({key:'before-exit',title:'Acknowledged before repeated exit'});
        ensure(checkpoint.metadata?.captureStatus==='complete','Exit regression requires a complete checkpoint');
        const savedArtifacts=await Promise.all(checkpoint.artifactRefs.map(id=>studio!.reader(runId).artifactMetadata(id)));
        const originalClose=studio.close.bind(studio);let closeCalls=0,reentryChecked=false;
        let reachedClose!:()=>void,releaseClose!:()=>void;
        const closing=new Promise<void>(resolve=>{reachedClose=resolve;}),released=new Promise<void>(resolve=>{releaseClose=resolve;});
        studio.close=async()=>{
          closeCalls++;reachedClose();await released;
          ensure(reentryChecked&&closeCalls===1,'Repeated exit bypassed or duplicated the pending Studio close');
          await originalClose();
          const reader=studio!.reader(runId),checkpoints=await reader.checkpoints({limit:20,maxBytes:32768});
          ensure(checkpoints.items.some((item:any)=>item.id===checkpoint.id),'The saved checkpoint was lost during repeated exit');
          for(const saved of savedArtifacts){const verified=await reader.artifactFile(saved.id);ensure(verified.artifact.sha256===saved.sha256&&verified.artifact.capturedBytes===saved.capturedBytes,'Checkpoint material changed during repeated exit');}
          let writerLockPresent=true;try{await readFile(path.join(reader.runDir,'writer.lock'));}catch(error:any){if(error.code!=='ENOENT')throw error;writerLockPresent=false;}
          ensure(!writerLockPresent&&!studio!.active,'Repeated exit must finish closing its writer and active run');
          await fixture.close();await lifecycle!.record('exit-reentry-verified',{phase,runId,checkpointId:checkpoint.id,closeCalls,materialCount:savedArtifacts.length});
        };
        const requestExit=()=>phase==='exit-window-close'?window.window.close():app.quit();
        requestExit();await closing;
        try{
          const firstShutdown=shutdownTask;requestExit();
          await new Promise(resolve=>setTimeout(resolve,100));
          ensure(!window.window.isDestroyed()&&closeCalls===1&&shutdownTask===firstShutdown,'Repeated exit escaped the pending shutdown barrier');
          reentryChecked=true;
        }finally{releaseClose();}
        await shutdownTask;return;
      }
      if(phase==='native-input'){
        const {runNativeInputScenarios}=await import('../../test/desktop/native-input-scenarios');Object.assign(identity,await runNativeInputScenarios(studio));
      }else if(phase==='refactor-recovery'||phase==='refactor-recovery-soak'||phase==='refactor-recovery-verify'){
        const {runRefactorRecoveryScenario}=await import('../../test/desktop/refactor-recovery');
        Object.assign(identity,await runRefactorRecoveryScenario(studio,phase));
      }else if(phase.startsWith('startup-')){
        const {verifyStartup}=await import('../../test/desktop/startup');
        const reload=startupReload?.();
        Object.assign(identity,{layout:await verifyStartup(window),reload});
      }else if(phase==='refactor-handoff'){
        const {startFixture}=await import('../../test/fixtures/site');
        const {runRefactorHandoffScenario}=await import('../../test/desktop/refactor-handoff');
        const fixture=await startFixture();
        try{Object.assign(identity,{handoff:await runRefactorHandoffScenario(studio,fixture.url)});}finally{await fixture.close();}
      }else if(phase==='refactor-system'){
        const {runRefactorSystemScenario}=await import('../../test/desktop/refactor-system');
        Object.assign(identity,{system:await runRefactorSystemScenario(studio)});
      }else if(phase==='refactor-runner'){
        const {startFixture}=await import('../../test/fixtures/site');
        const {runRefactorRunnerScenarios}=await import('../../test/desktop/refactor-runner');
        const fixture=await startFixture();
        try{Object.assign(identity,{runner:await runRefactorRunnerScenarios(studio,fixture.url)});}finally{await fixture.close();}
      }else if(phase==='refactor-recording-record'||phase==='refactor-recording-offline'){
        const {runRefactorRecordingScenario}=await import('../../test/desktop/refactor-recording');
        Object.assign(identity,{recording:await runRefactorRecordingScenario(studio,phase==='refactor-recording-record'?'record':'offline')});
      }else if(phase==='refactor-s0'||phase==='refactor-replay'){
        const {startFixture}=await import('../../test/fixtures/site');
        const {runSessionScenarios}=await import('../../test/desktop/session-scenarios');
        const {runExecutionModeScenarios}=await import('../../test/desktop/execution-mode-scenarios');
        const fixture=await startFixture();
        try{if(phase==='refactor-s0'){await runSessionScenarios(studio,fixture.url);await runExecutionModeScenarios(studio,fixture.url);}}finally{await fixture.close();}
        const {runRefactorReplayPrototype}=await import('../../test/desktop/refactor-replay');
        Object.assign(identity,{session:phase==='refactor-s0'?'passed':'not-run',replay:await runRefactorReplayPrototype(studio)});
      }else if(phase==='profile-restart'){
        const saved=JSON.parse(await readFile(path.join(dataRoot,'profile-restart-state.json'),'utf8'));
        ensure(saved.schemaVersion===1&&saved.restartStatus==='not-run','A fresh first-process profile restart checkpoint is required');
        ensure(Number.isSafeInteger(saved.fixturePort)&&saved.fixturePort>0&&saved.fixturePort<=65535,'Invalid saved fixture port');
        ensure(saved.siteOrigin===`http://127.0.0.1:${saved.fixturePort}`,'Restart fixture must reuse the saved loopback origin');
        ensure(Number.isSafeInteger(saved.originalProcessId)&&saved.originalProcessId!==process.pid,'Profile restart must run in a different process');
        Object.assign(identity,{originalProcessId:saved.originalProcessId,fixturePort:saved.fixturePort,siteOrigin:saved.siteOrigin});
        const {startFixture}=await import('../../test/fixtures/site');
        const {runProfileRestartScenarios}=await import('../../test/desktop/lifecycle');
        const fixture=await startFixture({port:saved.fixturePort});
        const expectSoak=process.env.BES_EXPECT_SOAK?JSON.parse(process.env.BES_EXPECT_SOAK):undefined;
        try{Object.assign(identity,await runProfileRestartScenarios(studio,fixture.url,expectSoak));}finally{await fixture.close();}
      }else if(phase.startsWith('recovery-')){
        const {runRecoveryCrash,verifyRecovery}=await import('../../test/desktop/recovery-scenarios');
        if(phase==='recovery-crash')await runRecoveryCrash(studio);
        else Object.assign(identity,await verifyRecovery(studio,phase==='recovery-repeat'));
      }else{
        const {runDesktopTests}=await import('../../test/desktop/scenarios');
        await runDesktopTests(studio);
        Object.assign(identity,{ui:process.env.BES_SKIP_UI?'skipped':'passed',lifecycle:'passed',profileRestart:'pending-second-process'});
      }
      await writeFile(path.join(dataRoot,resultFile),JSON.stringify({...identity,passed:true,finishedAt:new Date().toISOString(),versions:studio.state().versions},null,2));
      await lifecycle.record('test-completed',{phase});await shutdown('test-completed');
    }catch(error){
      console.error(error);
      await writeFile(path.join(dataRoot,resultFile),JSON.stringify({...identity,passed:false,finishedAt:new Date().toISOString(),error:String(error),stack:(error as Error).stack},null,2));
      await shutdown('test-failed',1);
    }
  }
}).catch(error=>{console.error(error);void shutdown('startup-failed',1);});
app.on('second-instance',()=>studio?.window.window.focus());
app.on('child-process-gone',(_event,details)=>{
  if(!quitting)void lifecycle?.record('child-process-gone',{type:details.type,reason:details.reason,exitCode:details.exitCode}).catch(error=>console.error('Lifecycle diagnostic could not be saved',error));
});
app.on('render-process-gone',(_event,contents,details)=>{
  if(!quitting)void lifecycle?.record('renderer-gone',{webContentsId:contents.id,reason:details.reason,exitCode:details.exitCode}).catch(error=>console.error('Lifecycle diagnostic could not be saved',error));
});
app.on('before-quit',event=>{event.preventDefault();void shutdown('app-quit');});
function shutdown(reason:string,code=0):Promise<void>{
  shutdownExitCode=Math.max(shutdownExitCode,code);
  if(shutdownTask)return shutdownTask;
  quitting=true;
  shutdownTask=(async()=>{
    const record=async(stage:string,details:Record<string,unknown>={})=>{try{await lifecycle?.record(stage,{reason,...details});}catch(error){shutdownExitCode=1;console.error('Lifecycle diagnostic could not be saved',error);}};
    await record('shutdown-requested',{exitCode:shutdownExitCode,runId:studio?.active?.id,execution:studio?.active?.execution});
    for(const [stage,close] of [['api',()=>api?.close()],['studio',()=>studio?.close()]] as const){
      await record('closing-'+stage);
      try{await close();await record(stage+'-closed');}
      catch(error){shutdownExitCode=1;console.error(stage+' shutdown failed',error);await record(stage+'-close-failed');}
    }
    // app.exit bypasses before-quit/close, so every ordinary exit request can
    // remain blocked until this single cleanup promise has finished.
    await record('shutdown-complete',{exitCode:shutdownExitCode});app.exit(shutdownExitCode);
  })();
  return shutdownTask;
}
