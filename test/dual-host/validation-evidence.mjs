import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {until} from './ui.mjs';
import path from 'node:path';
import {runtimeAmountEvidence} from './source-evidence.mjs';
export async function terminalExecution(root,executionId){const dir=root+'/executions/'+executionId;const host=await until(async()=>{try{return JSON.parse(await fs.readFile(dir+'/host-state.json'))}catch{}},h=>h?.finishedAt,'terminal execution '+executionId,90000);return{dir,host};}
export async function sourceVerdict({dir,host},fixed,field,requirement,variant){
 const reportFile=await until(async()=>(await fs.readdir(dir)).find(f=>/^report-.*\.json$/.test(f)),Boolean,'saved actual validation report');
 const saved=JSON.parse(await fs.readFile(dir+'/'+reportFile));
 assert.equal(saved.report.binding.materialRevisionId,fixed.revisionId);assert.equal(saved.report.binding.materialContentHash,fixed.contentHash);assert.equal(saved.report.attemptId,host.workflowAttemptId);assert.equal(saved.report.datasets.length,1);
 const executionId=dir.split('/').at(-1);const identity={executionId,attemptId:host.datasets[0].attemptId,datasetId:'orders'};assert.deepEqual(saved.report.datasets[0].identity,identity);
 const datasetDirectory=dir+'/datasets/'+identity.attemptId+'/orders';const batchFile=(await fs.readdir(datasetDirectory)).find(f=>/^batch-.*\.json$/.test(f));assert(batchFile,'Actual committed batch exists');
 const batch=JSON.parse(await fs.readFile(datasetDirectory+'/'+batchFile)).batch;
 assert.deepEqual(batch.records,[{id:'order-one',amount:variant==='wrong'?'15.00':'14.00'}]);
 const samples=[];for(const ref of batch.provenance.sourceRefs){const sample=JSON.parse(await fs.readFile(dir+'/sample-'+ref+'.json'));assert.equal(sample.scope.executionId,executionId);assert.equal(sample.scope.attemptId,identity.attemptId);assert.equal(sample.target.position.recordingId,host.runId);assert.notEqual(sample.target.position.recordingId,field.target.position.recordingId,'Runtime observation is not historical demonstration');sample.rawEvidence=await runtimeAmountEvidence(path.resolve(dir,'../../runs',host.runId),sample.target);samples.push(sample)}
 assert.equal(batch.provenance.sourceRefs.length,variant==='no-source'?0:1);
 const actual=saved.report.requirements.find(r=>r.requirementId===requirement.id);const sourceCheck=actual?.checks.find(x=>x.name==='source:'+field.id);assert(sourceCheck,'Source proof check exists');
 const expected={good:'pass',wrong:'fail','no-source':'inconclusive'}[variant];assert.equal(sourceCheck.verdict,expected,'Actual three-state proof '+variant);
 return{variant,expected,executionId,reportId:saved.reportId,overall:saved.report.overall,sourceCheck,fieldDiagnostics:actual.fieldDiagnostics,binding:saved.report.binding,workflowAttemptId:host.workflowAttemptId,selectedIdentity:identity,records:batch.records,sourceRefs:batch.provenance.sourceRefs,sourceSamples:samples,hostStatus:host.status};
}
