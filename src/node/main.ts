import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { ChromiumStudio } from './chromium-studio';
import { shutdownNodeWorkspace } from './shutdown';
import { nodeLaunchOptions } from './launch-options';
import { chromiumExecutable, lockNodeWorkspace } from './environment';
import { NodeOwnerServer } from './owner-server';
import { WorkbenchSessions } from '../main/workbench/session';
import { WorkbenchHttpTransport } from '../main/workbench/http';
import { WorkbenchPairing } from '../main/workbench/pairing';
import { createProjectMetadataPort } from '../main/workbench/project-port';
import { createBrowserMaterialPort } from '../main/workbench/material-port';
import { createBrowserResultPort } from '../main/workbench/result-port';
import { createBrowserReplayPort } from '../main/workbench/replay-port';
import { ReplayDocumentServer } from '../main/workbench/replay-document';
import { ensure } from '@/shared/errors';

async function freePort(){const server=netServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('No loopback port');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
export async function startNodeWorkbench(args:string[]=process.argv.slice(2)){
  const applicationPath=path.resolve(import.meta.dirname,'../..');
  const {root,executable,headless,devCooperativeInput}=nodeLaunchOptions(args,path.join(applicationPath,'output',`node-workbench-${Date.now()}-${randomUUID().slice(0,8)}`));
  ensure(!process.versions.electron,'Node entry must not run inside Electron');
  const executablePath=await chromiumExecutable(executable);const lease=await lockNodeWorkspace(root);
  let studio:ChromiumStudio|undefined,workbench:WorkbenchHttpTransport|undefined,owner:NodeOwnerServer|undefined,replay:ReplayDocumentServer|undefined,vite:ViteDevServer|undefined,uiServer:HttpServer|undefined,closed=false;
  let sessions:WorkbenchSessions|undefined;
  let launchIdentity:Record<string,unknown>|undefined;
  let finishStartup!:()=>void;const startupDone=new Promise<void>(resolve=>{finishStartup=resolve;});
  const assertStarting=()=>{if(closed)throw new Error('Node startup cancelled by shutdown');};
  let shutting:Promise<void>|undefined,readyResolve!:()=>void;const finished=new Promise<void>(resolve=>{readyResolve=resolve;});
  const shutdown=()=>shutting??=(async()=>{
    closed=true;await startupDone;
    try{await shutdownNodeWorkspace([
      ()=>owner?.dispose(),()=>workbench?.dispose(),()=>studio?.close(),()=>replay?.dispose(),()=>vite?.close(),
      ()=>new Promise<void>(resolve=>{if(uiServer?.listening){uiServer.closeAllConnections();uiServer.close(()=>resolve());}else resolve();}),
      ()=>sessions?.dispose(),
    ],async clean=>{
      // Set only after this invocation wrote its own launch identity. Early
      // startup failure must not overwrite a previous launch's manifest.
      if(launchIdentity)await writeFile(path.join(root,'launch.json'),JSON.stringify({...launchIdentity,status:clean?'closed':'shutdown-failed',closedAt:new Date().toISOString()},null,2),{mode:0o600});
    },()=>{ensure(!studio||studio.providerTerminated,'Owned Chromium termination is unconfirmed; workspace writer lease retained',409);return lease.close();});}finally{readyResolve();}
  })();

  const onSignal=()=>{void shutdown().catch(error=>{console.error('Node shutdown failed:',String(error));process.exitCode=1;readyResolve();});};
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try{
    const browserPort=await freePort();assertStarting();const origin=`http://127.0.0.1:${browserPort}`;
    studio=new ChromiumStudio(root,applicationPath,{executablePath,headless,devCooperativeInput});await studio.init();assertStarting();
    // Scope registries share the actual running Studio identity, never a global/static token.
    const scopedSessions=sessions=new WorkbenchSessions({instanceId:studio.instanceId,sessionTtlMs:900000});
    const pairing=new WorkbenchPairing(scopedSessions,studio.management,origin);
    replay=new ReplayDocumentServer();const replayOrigin=await replay.start(origin,studio.instanceId);assertStarting();
    workbench=new WorkbenchHttpTransport({origin,sessions:scopedSessions,projectPort:createProjectMetadataPort(studio.management),materialPort:createBrowserMaterialPort(root,studio.materials),resultPort:createBrowserResultPort(studio.executions),replayPort:createBrowserReplayPort(root,studio.materials)});
    const backend=await workbench.start();assertStarting();studio.onChanged=()=>{for(const project of studio!.projects)workbench!.invalidate(project.id);};
    owner=new NodeOwnerServer({studio,origin,pairing,shutdown});const ownerPort=(await owner.start()).port;assertStarting();
    Object.assign(process.env,{BES_WORKBENCH_BROWSER_PORT:String(browserPort),BES_WORKBENCH_TARGET_PORT:new URL(backend.baseUrl).port,BES_WORKBENCH_OWNER_PORT:String(ownerPort),BES_WORKBENCH_INSTANCE_ID:studio.instanceId,BES_WORKBENCH_REPLAY_ORIGIN:replayOrigin});
    // Middleware mode deliberately leaves signal/stdin ownership with this assembly.
    // Vite's standalone server installs an exit handler that would preempt evidence draining.
    uiServer=createHttpServer((request,response)=>{if(!vite){response.writeHead(503);response.end();return;}vite.middlewares(request,response,()=>{response.writeHead(404);response.end();});});
    vite=await createViteServer({configFile:path.join(applicationPath,'vite.browser.config.ts'),root:path.join(applicationPath,'src/renderer'),server:{middlewareMode:true,hmr:{server:uiServer}}});assertStarting();
    await new Promise<void>((resolve,reject)=>{uiServer!.once('error',reject);uiServer!.listen(browserPort,'127.0.0.1',resolve);});assertStarting();
    const build=await readFile(path.join(import.meta.dirname,'node-studio.js'));assertStarting();
    const manifest={schemaVersion:1,status:'ready',backendKind:'node',runtimeProvider:'chromium',instanceId:studio.instanceId,processId:process.pid,startedAt:new Date().toISOString(),dataRoot:root,headless,executionPolicy:studio.executionPolicy,sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:applicationPath,encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:applicationPath,encoding:'utf8'}).trim(),buildSha256:createHash('sha256').update(build).digest('hex'),frontendOrigin:origin,backendOrigin:backend.baseUrl,replayOrigin,ownerUrl:`${origin}/node-owner.html`,browserUrl:`${origin}/browser.html`};
    await writeFile(path.join(root,'launch.json'),JSON.stringify(manifest,null,2),{mode:0o600});launchIdentity=manifest;assertStarting();
    console.log('DEV/TEST cooperative input: keep hands off the dedicated browser while a workflow runs. Physical input is not blocked; interference detection is partial. A passing report does not prove noninterference. Use Stop before manual work.');
    console.log(`Pure Node + dedicated Chromium\nOwner UI: ${manifest.ownerUrl}\nShared workbench: ${manifest.browserUrl}\nLaunch identity: ${path.join(root,'launch.json')}\nOnly newly created dedicated Chromium environments are supported. Existing Electron storage is not migrated.`);
    const issue=async()=>{if(!closed){const ticket=await owner!.ticket();console.log(`One-use local owner ticket (60 seconds; do not save in logs/screenshots): ${ticket.ticket}`);}};
    await issue();assertStarting();console.log('Type pair then Enter here to revoke old owner access and issue a new ticket. Ctrl+C drains recording and exits.');
    const terminal=createInterface({input:process.stdin,terminal:false});terminal.on('line',line=>{if(line.trim()==='pair')void issue().catch(error=>console.error('Could not renew owner ticket:',String(error)));});
    finishStartup();await finished;terminal.close();await shutting;
  }catch(error){finishStartup();await shutdown().catch(cleanup=>console.error('Node cleanup also failed:',String(cleanup)));throw error;}
  finally{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.join(import.meta.dirname,'node-studio.js'))void startNodeWorkbench().catch(error=>{console.error(error instanceof Error?error.message:'Node startup failed');process.exitCode=1;});
