import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {repo,sourceBuildManifest} from './source-manifest.mjs';
import {createFixture} from './fixture.mjs';
import {startHost,recordFixture,closeHost,originalHashes} from './host.mjs';
import {authorMaterial,nativeReadback,hash} from './material.mjs';
import {executeVariants} from './execution.mjs';
import {compareHosts,semanticProjection} from './compare.mjs';

const options={host:'both',chromium:process.env.BES_TEST_CHROMIUM,output:path.join(repo,'output','dual-host-'+Date.now())};
for(const arg of process.argv.slice(2)){
  const match=arg.match(/^--(host|chromium|output)=(.+)$/);if(!match)throw Error('Use --chromium=/absolute/executable [--host=electron|node|both] [--output=/absolute/directory]');options[match[1]]=match[2];
}
assert(['both','electron','node'].includes(options.host));assert(options.chromium&&path.isAbsolute(options.chromium),'Explicit absolute --chromium or BES_TEST_CHROMIUM required');options.output=path.resolve(options.output);
await fs.mkdir(options.output,{recursive:true});
// A proof directory is write-once. Never overwrite a prior failure or read an old
// report as evidence for this run.
const resultPath=path.join(options.output,'result.json');await fs.writeFile(resultPath,'{}',{flag:'wx'});
const report={startedAt:new Date().toISOString(),scope:'Bounded real-UI same-input dual-host compatibility, not the entire platform/profile matrix',options,hosts:[],passed:false};
const save=()=>fs.writeFile(resultPath,JSON.stringify(report,null,2));
let context,fixture,fixturePort;
try{
  const before=await sourceBuildManifest();await fs.writeFile(options.output+'/source-manifest-before.json',JSON.stringify(before,null,2));
  for(const host of options.host==='both'?['electron','node']:[options.host]){
    const result={host,startedAt:new Date().toISOString(),steps:[],passed:false};report.hosts.push(result);const root=path.join(options.output,host);
    const mark=async name=>{result.steps.push({name,at:new Date().toISOString()});await save();console.log(host+': '+name)};
    fixture=await createFixture({port:fixturePort??0});fixturePort=new URL(fixture.url).port;fixturePort=Number(fixturePort);
    context=await startHost({host,root,chromium:options.chromium},result);await recordFixture(context,fixture);fixture=undefined;await mark('normal-ui-sealed-real-source-and-source-server-offline');
    await authorMaterial(context,mark);await nativeReadback(context,mark);await executeVariants(context,mark);
    assert.deepEqual(await originalHashes(context.runRoot),result.sourceHashes);assert.equal(hash(await fs.readFile(context.fixedFile)),result.fixed.fileHash);result.immutableSourceAndFixedUnchanged=true;assert.deepEqual(result.pageErrors,[]);assert.deepEqual(result.unexpectedWebRequests,[]);
    result.semanticProjection=semanticProjection(result);await closeHost(context);context=undefined;assert(!result.cleanup.result.timeout,'Owned launcher drained');assert.equal(result.cleanup.result.code,0);assert.equal(result.cleanup.providerAlive,false);result.passed=true;result.finishedAt=new Date().toISOString();await save();
  }
  if(options.host==='both')report.comparison=compareHosts(report.hosts[0],report.hosts[1]);
  report.passed=true;
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};if(context){const result=context.report;result.failure=report.failure;try{if(!await context.ui.$('[aria-label="启动器一次性票据"],code[aria-label="一次性票据"]')){result.failureUi=await context.ui.evaluate(()=>document.body.innerText);await context.ui.screenshot({path:context.root+'/failure-host.png',fullPage:true})}if(!await context.web.$('[aria-label="一次性配对票据"]')){result.failureWorkbench=await context.web.evaluate(()=>document.body.innerText);await context.web.screenshot({path:context.root+'/failure-workbench.png',fullPage:true})}}catch{}}console.error(error.message)}
finally{
  if(context)await closeHost(context);await fixture?.close();
  const after=await sourceBuildManifest();await fs.writeFile(options.output+'/source-manifest-after.json',JSON.stringify(after,null,2));const before=JSON.parse(await fs.readFile(options.output+'/source-manifest-before.json'));report.sourceBuildUnchanged=JSON.stringify(before.files)===JSON.stringify(after.files);if(report.passed&&!report.sourceBuildUnchanged){report.passed=false;report.failure={message:'Source/build changed during actual acceptance'}}report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({passed:report.passed,output:options.output,hosts:report.hosts.map(x=>({host:x.host,passed:x.passed})),failure:report.failure?.message}));process.exitCode=report.passed?0:1;
}
