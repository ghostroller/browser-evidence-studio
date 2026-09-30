import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {repo,sourceBuildManifest} from './source-manifest.mjs';
import {until,click,fill,select,hasText,delay} from './ui.mjs';
import {launchWithRedactedConsole} from './launch-capture.mjs';
import {createLegacyWorkspace,assertLegacyProfilePreserved,LEGACY_PROFILE_ID,LEGACY_STORAGE_REF} from './legacy-profile-fixture.mjs';
const require=createRequire(repo+'/package.json'),pp=require('puppeteer-core'),electron=require('electron');
const argument=process.argv[2];assert(argument?.startsWith('--output='),'Use --output=/absolute/new/proof-directory');const output=path.resolve(argument.slice(9)),dataRoot=output+'/synthetic-electron-root';
await fs.mkdir(output,{recursive:true});await fs.mkdir(dataRoot,{mode:0o700});
const report={startedAt:new Date().toISOString(),scope:'NEW synthetic pre-provider schema with custom Electron partition, not a copied real or historical cookie profile',passed:false,phases:[],loginPosts:0};
const save=()=>fs.writeFile(output+'/result.json',JSON.stringify(report,null,2));
const server=http.createServer((request,response)=>{
  response.setHeader('cache-control','no-store');
  if(request.method==='POST'&&request.url==='/login'){report.loginPosts++;response.writeHead(303,{'set-cookie':'b4_synthetic=known-owned; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/','location':'/orders'});response.end();return}
  const logged=(request.headers.cookie??'').split(';').some(x=>x.trim()==='b4_synthetic=known-owned');report.cookieObservations??=[];report.cookieObservations.push({path:request.url,loggedIn:logged});
  response.setHeader('content-type','text/html;charset=utf-8');response.end(`<!doctype html><meta charset="utf-8"><title>B4 synthetic legacy partition</title><style>body{font:22px system-ui;padding:30px}</style><h1>本地合成旧环境兼容</h1>${logged?'<p id="logged-in">合成账户已登录</p>':'<p id="logged-out">合成账户未登录</p><form action="/login" method="post"><button>登录合成账户</button></form>'}`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;report.origin=origin;
const workspace=createLegacyWorkspace(origin+'/orders');await fs.writeFile(dataRoot+'/workspace.json',JSON.stringify(workspace,null,2),{flag:'wx'});
const initial=await fs.readFile(dataRoot+'/workspace.json');report.initialWorkspace=workspace;
const readWorkspace=async()=>JSON.parse(await fs.readFile(dataRoot+'/workspace.json'));
let current;
async function start(phase){
  const env={...process.env,BES_DATA:dataRoot};for(const key of Object.keys(env))if(key.startsWith('BES_TEST')||key.startsWith('BES_WORKBENCH'))delete env[key];delete env.ELECTRON_RUN_AS_NODE;
  const launcher=await launchWithRedactedConsole({command:electron,args:['.'],cwd:repo,env,logPath:output+'/'+phase+'.log'});
  const result={phase,pid:launcher.child.pid,startedAt:new Date().toISOString()};report.phases.push(result);
  const endpoint=await until(async()=>{try{const latest=JSON.parse(await fs.readFile(dataRoot+'/diagnostics/latest.json'));if(latest.processId!==launcher.child.pid||latest.stage!=='ui-ready')return;const[port,browserPath]=(await fs.readFile(dataRoot+'/DevToolsActivePort','utf8')).trim().split(/\r?\n/);return`ws://127.0.0.1:${port}${browserPath}`}catch{}if(launcher.child.exitCode!==null)throw Error('Legacy fixture Electron exited before ready')},Boolean,'owned legacy-profile Electron ready',60000);
  const browser=await pp.connect({browserWSEndpoint:endpoint,defaultViewport:null}),ui=await browser.waitForTarget(t=>t.url().includes('/main_window/index.html')).then(t=>t.page());await ui.waitForSelector('.evidence-strip');
  assertLegacyProfilePreserved(await readWorkspace());return{launcher,browser,ui,result};
}
async function openProfile(id,expected){
  await select(current.ui,'登录环境',id);await click(current.ui,'打开环境');
  const page=await current.browser.waitForTarget(t=>t.url().startsWith(origin+'/orders')).then(t=>t.page());await page.waitForSelector(expected?'#logged-in':'#logged-out');assertLegacyProfilePreserved(await readWorkspace());
  const session=await page.createCDPSession();const{targetInfo}=await session.send('Target.getTargetInfo');await session.detach();current.result.opened??=[];current.result.opened.push({profileId:id,targetId:targetInfo.targetId,loggedIn:expected});return page;
}
async function stop({native=false}={}){if(!current)return;if(native){await current.ui.bringToFront();await fs.writeFile(output+'/awaiting-native-close.json',JSON.stringify({pid:current.launcher.child.pid,phase:current.result.phase,expectedProject:'B4 合成旧格式兼容',at:new Date().toISOString()},null,2));console.log('AWAITING_NATIVE_CLOSE '+current.result.phase+' PID '+current.launcher.child.pid);}else await current.browser.close();const result=await Promise.race([current.launcher.done,delay(native?120000:20000).then(()=>({timeout:true}))]);assert(!result.timeout,'Owned native-close barrier completed');assert.equal(result.code,0);if(native){await fs.rename(output+'/awaiting-native-close.json',output+'/native-close-'+current.result.phase+'.json');current.result.nativeClose=true;}await current.browser.disconnect();await current.launcher.closeLog();const lifecycle=JSON.parse(await fs.readFile(dataRoot+'/diagnostics/latest.json'));assert.equal(lifecycle.processId,current.launcher.child.pid);assert.equal(lifecycle.stage,'shutdown-complete');current.result.shutdown={result,lifecycle};current=undefined;}
try{
  const before=await sourceBuildManifest();await fs.writeFile(output+'/source-manifest-before.json',JSON.stringify(before,null,2));
  current=await start('initial');assert.deepEqual(await fs.readFile(dataRoot+'/workspace.json'),initial,'Startup read does not rewrite legacy metadata');
  let page=await openProfile(LEGACY_PROFILE_ID,false);await click(page,'登录合成账户');await page.waitForSelector('#logged-in');assert.equal(report.loginPosts,1);
  await click(current.ui,'检查登录状态');await hasText(current.ui,'登录已验证');assert.equal(assertLegacyProfilePreserved(await readWorkspace()).loginStatus,'verified');await click(current.ui,'保留环境');assert.equal(assertLegacyProfilePreserved(await readWorkspace()).loginStatus,'unknown','Saving persistent state does not re-certify login');
  await click(current.ui,'关闭浏览器会话');page=await openProfile(LEGACY_PROFILE_ID,true);await page.screenshot({path:output+'/same-process-retained-login.png'});await click(current.ui,'关闭浏览器会话');
  await click(current.ui,'添加环境');await fill(current.ui,'环境名称','B4 独立空环境');await fill(current.ui,'登录入口',origin+'/orders');await click(current.ui,'添加');const second=(await readWorkspace()).profiles.find(p=>p.id!==LEGACY_PROFILE_ID);assert(second);assert.notEqual(second.storageRef,LEGACY_STORAGE_REF);await openProfile(second.id,false);await click(current.ui,'关闭浏览器会话');await openProfile(LEGACY_PROFILE_ID,true);
  const partitions=await fs.readdir(dataRoot+'/Partitions');assert(partitions.includes(LEGACY_STORAGE_REF.slice('persist:'.length)));report.partitionDirectories=partitions;report.relativeLegacyPartition='Partitions/'+LEGACY_STORAGE_REF.slice('persist:'.length);assert.equal((await fs.stat(dataRoot+'/'+report.relativeLegacyPartition)).isDirectory(),true);
  await stop({native:true});current=await start('restart');assert.notEqual(report.phases[0].pid,report.phases[1].pid);page=await openProfile(LEGACY_PROFILE_ID,true);assert.equal(report.loginPosts,1,'Process restart needs no repeated login');await page.screenshot({path:output+'/restart-retained-login.png'});assert.equal((await fs.stat(dataRoot+'/'+report.relativeLegacyPartition)).isDirectory(),true);
  assert.equal((await fs.readdir(dataRoot+'/runs')).length,0,'Profile proof never creates recordings');report.finalProfile=assertLegacyProfilePreserved(await readWorkspace());await stop({native:true});report.passed=true;
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};if(current)try{report.failure.ui=await current.ui.evaluate(()=>document.body.innerText);await current.ui.screenshot({path:output+'/failure-ui.png',fullPage:true})}catch{}console.error(error.message)}
finally{try{await stop()}catch(error){report.cleanupFailure=String(error);report.passed=false}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const after=await sourceBuildManifest();await fs.writeFile(output+'/source-manifest-after.json',JSON.stringify(after,null,2));const before=JSON.parse(await fs.readFile(output+'/source-manifest-before.json'));report.sourceBuildUnchanged=JSON.stringify(before.files)===JSON.stringify(after.files);if(!report.sourceBuildUnchanged)report.passed=false;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({passed:report.passed,output,failure:report.failure?.message}));process.exitCode=report.passed?0:1}
