import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TaskMaterialRevision } from '@/contracts/materials';

/** Explicit demonstration implementer. Consumes UI-authored semantics; writes
 * only ordinary code and a proposal that must be read and confirmed in the UI. */
export async function implementProductTask(directory:string,revision:TaskMaterialRevision,sourceUrl:string){
  const field=revision.content.fields.find(item=>item.name==='实付金额');
  if(!field||!field.target)throw new Error('The user must create and bind the requested amount field first');
  const requirements=revision.content.requirements.filter(item=>item.fieldIds.includes(field.id));
  if(requirements.length!==1||requirements[0].dataset!==field.dataset)throw new Error('UI-created dataset relationship is invalid');
  const requirement=requirements[0];await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'implementation.json'),JSON.stringify({materialContentHash:revision.contentHash,fields:[{fieldId:field.id,outputPath:'/amount',sourceProof:{kind:'dom-text',sourceUrl,nodeAttribute:{name:'data-field',value:'amount'},entityAttribute:'data-entity',outputEntityPath:'/id'}}]},null,2));
  await writeFile(path.join(directory,'package-lock.json'),'{"lockfileVersion":3}');
  await writeFile(path.join(directory,'workflow.json'),JSON.stringify({schemaVersion:1,workflowId:'ui-authored-orders',driver:'puppeteer',entry:'./run.mjs',exportName:'run',requirements:[{id:requirement.id,checkpointKey:'orders',description:requirement.description,dataset:requirement.dataset}]},null,2));
  await writeFile(path.join(directory,'run.mjs'),`export async function run({page,input,reporter,steps}) {
    return steps.run({stepId:'orders',run:async ctx=>{
      await page.waitForSelector('[data-field=amount]');
      const records=await page.$$eval('[data-entity]',nodes=>nodes.map(node=>({id:node.getAttribute('data-entity'),amount:node.querySelector('[data-field=amount]').innerText})));
      if(input.variant==='wrong')records[0].amount='999.00';
      const checkpoint=await reporter.checkpoint('orders',{requirementIds:[${JSON.stringify(requirement.id)}],stepAttemptId:ctx.identity.attemptId});
      return {records,sourceRefs:input.variant==='unverified'?[]:checkpoint.sourceRefs};
    },commit:async(value,ctx)=>{
      const identity={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:${JSON.stringify(field.dataset)}};
      await reporter.beginDataset(identity);
      await reporter.appendBatch({...identity,batchId:'displayed-orders',records:value.records,provenance:{origin:'browser',sourceRefs:value.sourceRefs}});
      await reporter.finishDataset({...identity,status:'complete',committedBatches:1,committedRecords:value.records.length});
    }});
  }`);
}

/** Reads the ordinary exported envelope and paginated authorized public API. */
export async function implementExportedProductTask(handoff:string,directory:string,source:string){
  const manifest=JSON.parse(await readFile(path.join(handoff,'manifest.json'),'utf8'));
  const access=JSON.parse(await readFile(path.join(handoff,'access.json'),'utf8'));
  const connection=JSON.parse(await readFile(access.connectionFile,'utf8'));
  const identity={authorizationId:access.authorization.authorizationId,revisionId:manifest.revisionId,contentHash:manifest.contentHash};
  const query=async(operation:string,body:object)=>{
    const response=await fetch(`${connection.address}/v1/projects/${manifest.projectId}/query/${operation}`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:JSON.stringify({...identity,...body})});
    const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;
  };
  const summary=await query('materialRevision',{});
  const content:any={taskBrief:summary.taskBrief};
  for(const collection of ['requirements','fields','checkpoints','annotations','recordingRefs']){
    content[collection]=[];let cursor:string|undefined;
    do{const page=await query('materialCollection',{kind:'revision',collection,cursor,limit:50,maxBytes:24576});content[collection].push(...page.items);cursor=page.nextCursor;}while(cursor);
  }
  await implementProductTask(path.resolve(directory),{...summary,content} as TaskMaterialRevision,source);
  return {revisionId:manifest.revisionId,contentHash:manifest.contentHash};
}
