import { app, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { StudioWindow } from './window';
import { Studio } from './services/studio';
import { ensure } from '../shared/errors';
import { makeDispatch } from './services/dispatch';
import { startApi, type ApiHandle } from './api/server';

const dataRoot=process.env.BES_DATA||path.join(app.getPath('appData'),app.isPackaged?'BrowserEvidenceStudio':'BrowserEvidenceStudio-dev');
app.setPath('userData',dataRoot);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port','0');
// Managed scripts still need compositor visibility callbacks behind other desktop windows.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
protocol.registerSchemesAsPrivileged([{scheme:'bes-artifact',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let studio:Studio|undefined;let api:ApiHandle|undefined;let quitting=false;
async function endpoint(){for(let i=0;i<100;i++){try{const [port,browserPath]=(await readFile(path.join(dataRoot,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);const url=`http://127.0.0.1:${port}/json/version`;const data=await fetch(url).then(r=>r.json()) as any;if(data.webSocketDebuggerUrl)return `ws://127.0.0.1:${port}${browserPath}`;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Internal CDP endpoint did not become ready');}
if(!app.requestSingleInstanceLock())app.quit();
else app.whenReady().then(async()=>{
  await mkdir(dataRoot,{recursive:true});const window=new StudioWindow();studio=new Studio(dataRoot,window,await endpoint());await studio.init();
  const dispatch=makeDispatch(studio);api=await startApi({root:dataRoot,dispatch});studio.connection={address:api.address,file:api.connectionFile};
  protocol.handle('bes-artifact',async request=>{try{
    const u=new URL(request.url),reader=studio!.reader(u.hostname),id=u.pathname.slice(1),metadata=await reader.artifactMetadata(id);
    if(metadata.kind!=='screenshot'||metadata.mediaType!=='image/png'||metadata.captureStatus!=='complete'||metadata.capturedBytes>16*1024*1024)return new Response('Only saved PNG screenshots can be displayed',{status:403});
    const artifact=await reader.artifactFile(id),source=await net.fetch(pathToFileURL(artifact.path).href);
    return new Response(source.body,{headers:{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'"}});
  }catch{return new Response('Artifact unavailable',{status:404});}});
  ipcMain.handle('studio:call',async(event,method,body)=>{
    ensure(event.sender===window.window.webContents&&event.senderFrame===window.window.webContents.mainFrame&&event.senderFrame.url===window.uiUrl,'Untrusted UI sender',403);
    return dispatch(method,body,'ui');
  });
  ipcMain.on('studio:bounds',(event,rect)=>{if(event.sender===window.window.webContents&&event.senderFrame===window.window.webContents.mainFrame&&event.senderFrame.url===window.uiUrl)window.bounds(rect);});
  await window.load();
  window.window.on('close',event=>{if(!quitting){event.preventDefault();void shutdown();}});
  if(process.env.BES_TEST){
    const phase=process.env.BES_TEST_PHASE||'main';
    const resultFile=phase==='profile-restart'?'profile-restart-result.json':'test-result.json';
    const identity:Record<string,unknown>={phase,processId:process.pid,startedAt:new Date().toISOString()};
    try{
      ensure(phase==='main'||phase==='profile-restart','Unknown desktop test phase');
      if(phase==='profile-restart'){
        const saved=JSON.parse(await readFile(path.join(dataRoot,'profile-restart-state.json'),'utf8'));
        ensure(saved.schemaVersion===1&&saved.restartStatus==='not-run','A fresh first-process profile restart checkpoint is required');
        ensure(Number.isSafeInteger(saved.fixturePort)&&saved.fixturePort>0&&saved.fixturePort<=65535,'Invalid saved fixture port');
        ensure(saved.siteOrigin===`http://127.0.0.1:${saved.fixturePort}`,'Restart fixture must reuse the saved loopback origin');
        ensure(Number.isSafeInteger(saved.originalProcessId)&&saved.originalProcessId!==process.pid,'Profile restart must run in a different process');
        Object.assign(identity,{originalProcessId:saved.originalProcessId,fixturePort:saved.fixturePort,siteOrigin:saved.siteOrigin});
        const {startFixture}=await import('../../test/fixtures/site');
        const {runProfileRestartScenarios}=await import('../../test/desktop/lifecycle');
        const fixture=await startFixture({port:saved.fixturePort});
        try{await runProfileRestartScenarios(studio,fixture.url);}finally{await fixture.close();}
      }else{
        const {runDesktopTests}=await import('../../test/desktop/scenarios');
        await runDesktopTests(studio);
        Object.assign(identity,{ui:process.env.BES_SKIP_UI?'skipped':'passed',lifecycle:'passed',profileRestart:'pending-second-process'});
      }
      await writeFile(path.join(dataRoot,resultFile),JSON.stringify({...identity,passed:true,finishedAt:new Date().toISOString(),versions:studio.state().versions},null,2));
      await shutdown();
    }catch(error){
      console.error(error);
      await writeFile(path.join(dataRoot,resultFile),JSON.stringify({...identity,passed:false,finishedAt:new Date().toISOString(),error:String(error),stack:(error as Error).stack},null,2));
      await shutdown(1);
    }
  }
}).catch(error=>{console.error(error);app.exit(1);});
app.on('second-instance',()=>studio?.window.window.focus());
app.on('before-quit',event=>{if(!quitting){event.preventDefault();void shutdown();}});
async function shutdown(code=0){if(quitting)return;quitting=true;try{await api?.close();await studio?.close();}finally{app.exit(code);}}
