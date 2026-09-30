import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {click,fill,select,element,hit,hasText,until} from './ui.mjs';
import {sourceVerdict,terminalExecution} from './validation-evidence.mjs';
import {hash} from './material.mjs';

// Identical implementation bytes on both hosts. The host-generated requirement ID
// is supplied explicitly in input and retained in the report, never fabricated.
export const workflowSource=`export async function run({page,input,reporter,steps}) {
  return steps.run({stepId:'orders',run:async ctx=>{
    await page.waitForSelector('[data-field=amount]');
    const records=await page.$$eval('[data-entity]',nodes=>nodes.map(n=>({id:n.getAttribute('data-entity'),amount:n.querySelector('[data-field=amount]').innerText})));
    if(input.variant==='wrong')records[0].amount='15.00';
    const receipt=await reporter.checkpoint('orders',{requirementIds:[input.requirementId],stepAttemptId:ctx.identity.attemptId});
    return {records,sourceRefs:input.variant==='no-source'?[]:receipt.sourceRefs};
  },commit:async(value,ctx)=>{
    const identity={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'orders'};
    await reporter.beginDataset(identity);
    await reporter.appendBatch({...identity,batchId:'displayed-orders',records:value.records,provenance:{origin:'browser',sourceRefs:value.sourceRefs}});
    await reporter.finishDataset({...identity,status:'complete',committedBatches:1,committedRecords:value.records.length});
  }})
}`;

export async function executeVariants(c,mark){
  const directory=c.root+'/synthetic-workflow';await fs.mkdir(directory,{recursive:true});await fs.writeFile(directory+'/package-lock.json','{"lockfileVersion":3}');
  const manifest={schemaVersion:1,workflowId:'b4-same-input-source-field',driver:'puppeteer',entry:'./run.mjs',exportName:'run',requirements:[{id:c.requirement.id,checkpointKey:'orders',description:c.requirement.description,dataset:'orders'}]};
  await fs.writeFile(directory+'/workflow.json',JSON.stringify(manifest));await fs.writeFile(directory+'/run.mjs',workflowSource);c.report.workflow={directory,sha256:hash(workflowSource),manifest};c.report.threeState=[];
  const{ui}=c;
  if(c.host==='node'){await fill(ui,'工作流目录',directory);await click(ui,'登记工作流目录');await fill(ui,'固定版本 ID',c.fixed.revisionId);await fill(ui,'固定版本内容 Hash',c.fixed.contentHash);await select(ui,'执行模式','current-page-test')}
  else{await click(ui,'实现与结果');await fill(ui,'脚本目录',directory);await click(ui,'登记脚本目录');await select(ui,'运行方式','当前页面试跑');await select(ui,'固定任务资料版本',c.fixed.revisionId)}
  for(const variant of ['good','wrong','no-source']){
    const input={variant,requirementId:c.requirement.id};await fill(ui,c.host==='node'?'执行输入 JSON':'输入 JSON',JSON.stringify(input));const before=new Set(await fs.readdir(c.launch.dataRoot+'/executions').catch(()=>[]));await click(ui,c.host==='node'?'启动固定版本执行':'运行脚本并验收');
    const executionId=await until(async()=>(await fs.readdir(c.launch.dataRoot+'/executions').catch(()=>[])).find(id=>!before.has(id)),Boolean,'actual '+variant+' execution');const execution=await terminalExecution(c.launch.dataRoot,executionId);assert.equal(execution.host.status,'completed');
    if(c.host==='node'){await fill(ui,'执行 ID',executionId);await click(ui,'读取执行数据集');const control=await element(ui,'label','用于验收 orders '+execution.host.datasets[0].attemptId);await hit(ui,control);assert(await control.evaluate(e=>e.checked));await click(ui,'生成执行核验报告')}
    else{await hasText(ui,'执行结果中心');await click(ui,'用于验收');await ui.waitForFunction(()=>[...document.querySelectorAll('.result-center button')].some(e=>e.textContent==='用于验收'&&e.classList.contains('selected')));await click(ui,'按所选 attempt 验收')}
    const result=await sourceVerdict(execution,c.fixed,c.field,c.requirement,variant);assert.equal(result.overall,result.expected,'Overall verdict matches actual source-proof verdict');result.input=input;c.report.threeState.push(result);
    assert.equal(hash(await fs.readFile(directory+'/run.mjs')),c.report.workflow.sha256);assert.equal(await c.live.evaluate(()=>window.b4ReadDocumentToken()),c.report.documentToken,'same actual live document retained');
    await ui.screenshot({path:c.root+'/validation-'+variant+'.png',fullPage:true});
    if(c.host==='electron'){await click(ui,'返回工作台');await click(ui,'实现与结果')}
  }
  await mark('three-real-dataset-attempts-with-pass-fail-inconclusive');
}
