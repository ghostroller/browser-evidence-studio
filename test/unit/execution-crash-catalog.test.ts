import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectMaterials } from '@/main/services/project-materials';
import { ProjectExecutions } from '@/main/services/project-executions';

it('discovers durable batches after the host dies before finish without rewriting history',async()=>{
  const parent=path.resolve(process.env.BES_DATA??'output/data-E');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'host-crash-')),source=path.join(root,'source');await mkdir(source);
  await writeFile(path.join(root,'workspace.json'),JSON.stringify({schemaVersion:1,projects:[{id:'project'}]}));
  await writeFile(path.join(source,'run.mjs'),'export async function run() {}');await writeFile(path.join(source,'workflow.json'),JSON.stringify({schemaVersion:1,driver:'puppeteer',workflowId:'crash',entry:'run.mjs',exportName:'run',requirements:[{id:'req',checkpointKey:'cp',description:'fixture'}]}));await writeFile(path.join(source,'package-lock.json'),'{"lockfileVersion":3}');
  const materials=new ProjectMaterials(root),draft=await materials.service.createDraft('project','human'),revision=await materials.service.publish('project',draft.draftId,0,'human');
  const input={executionId:'execution',projectId:'project',materialRevisionId:revision.revisionId,materialContentHash:revision.contentHash,directory:source,dependencyLockPath:path.join(source,'package-lock.json'),input:{},mode:'current-page-test',runId:'run',pageId:'page',environmentRef:'synthetic-crash'};
  const childFile=path.join(root,'host.mts');await writeFile(childFile,`import {ProjectExecutions} from ${JSON.stringify(pathToFileURL(path.resolve('src/main/services/project-executions.ts')).href)};import {ProjectMaterials} from ${JSON.stringify(pathToFileURL(path.resolve('src/main/services/project-materials.ts')).href)};const root=${JSON.stringify(root)};const managed=await new ProjectExecutions(root,new ProjectMaterials(root)).begin(${JSON.stringify(input)});const identity={executionId:'execution',attemptId:'attempt',datasetId:'orders'};await managed.datasets.begin(identity);await managed.datasets.append({...identity,batchId:'batch',records:[{id:'one'},{id:'two'}],provenance:{origin:'node',sourceRefs:[]}});process.stdout.write('DURABLE\\n');await new Promise(()=>{});`);
  const child=spawn(process.execPath,['--import','tsx',childFile],{cwd:path.resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Host did not commit: ${stderr}`)),10000);child.stdout.on('data',chunk=>{if(String(chunk).includes('DURABLE')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(`Host exited early: ${stderr}`));});});child.kill('SIGKILL');await exited;
    const directory=path.join(root,'executions','execution'),host=await readFile(path.join(directory,'host-state.json'),'utf8'),lock=await readFile(path.join(directory,'writer.lock'),'utf8');expect(JSON.parse(host).datasets).toEqual([]);
    const reopened=new ProjectExecutions(root,new ProjectMaterials(root)),summary=await reopened.summary('project','execution');expect(summary.status).toBe('interrupted');expect(summary.counts.datasets).toBe(1);
    const catalog=await reopened.items('project','execution','datasets',{maxBytes:4096,limit:10});expect(catalog.items).toEqual([{executionId:'execution',attemptId:'attempt',datasetId:'orders',status:'unfinished',committedBatches:1,committedRecords:2}]);
    const records=await reopened.records('project',{executionId:'execution',attemptId:'attempt',datasetId:'orders'},'batch',{maxBytes:4096,limit:10});expect(records.items.map(item=>item.value)).toEqual([{id:'one'},{id:'two'}]);expect(await readFile(path.join(directory,'host-state.json'),'utf8')).toBe(host);expect(await readFile(path.join(directory,'writer.lock'),'utf8')).toBe(lock);
  }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;}
});

