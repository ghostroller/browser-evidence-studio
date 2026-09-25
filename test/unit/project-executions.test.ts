import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectMaterials } from '@/main/services/project-materials';
import { ProjectExecutions } from '@/main/services/project-executions';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { startWorkflow } from '@/runner/manager';
import { GateTransport, type ProtocolTransport } from '@/runner/gate';

describe('fixed material / worker / source host adapter',()=>{
  for(const overlap of [false,true])it(`persists resumed scope and independently verifies JSON after restart (overlap=${overlap})`,async()=>{
    const parent=path.resolve(process.env.BES_DATA??'output/data-E');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'host-execution-'));
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(root,'workspace.json'),JSON.stringify({schemaVersion:1,projects:[{id:'project'}]}));
    await writeFile(path.join(source,'run.mjs'),'export async function run() { return null; }');
    await writeFile(path.join(source,'workflow.json'),JSON.stringify({schemaVersion:1,driver:'puppeteer',workflowId:'host-source',entry:'run.mjs',exportName:'run',requirements:[{id:'script-only',checkpointKey:'script-only',description:'Script cannot replace the fixed material requirement'}]}));
    await writeFile(path.join(source,'package-lock.json'),'{"lockfileVersion":3}');
    const materials=new ProjectMaterials(root),draft=await materials.service.createDraft('project','human');
    await materials.service.updateDraft('project',draft.draftId,0,{checkpoints:[],annotations:[],recordingRefs:[],requirements:[{id:'amount',description:'Captured order amount',dataset:'orders',fieldIds:['amount'],rules:[{type:'required',field:'amount'}]}],fields:[{id:'amount',dataset:'orders',name:'amount',description:'amount',sourcePolicy:'any-evidenced',outputPath:'/amount',sourceProof:{kind:'json-record',sourceUrl:'https://fixture.test/orders',rowsPointer:'/items',entityPointer:'/id',outputEntityPath:'/id',valuePointer:'/amount'}}]},'human');
    const revision=await materials.service.publish('project',draft.draftId,1,'human');
    const store=await EvidenceStore.create(path.join(root,'runs','run'),{id:'run',projectId:'project',kind:'validate',mode:'synthetic',objective:'Host integration',profileId:'profile'});
    const executions=new ProjectExecutions(root,materials),managed=await executions.begin({executionId:'execution',projectId:'project',materialRevisionId:revision.revisionId,materialContentHash:revision.contentHash,directory:source,dependencyLockPath:path.join(source,'package-lock.json'),input:{},mode:'current-page-test',runId:'run',pageId:'page',environmentRef:'synthetic-node'});
    const worker=path.join(root,'synthetic-worker.mjs');
    await writeFile(worker,`import {parentPort,workerData} from 'node:worker_threads';
      let next=0;const pending=new Map();parentPort.on('message',m=>{if(m.type==='reply'){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}if(m.type==='finish')parentPort.close();});
      const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});parentPort.postMessage({type:'reporter',id,method,args});});
      parentPort.postMessage({type:'started',nodeVersion:process.versions.node});
      const step={executionId:workerData.execution.binding.executionId,stepId:'orders',attemptId:'step-one'};
      await call('stepEvent',{identity:step,state:'running',occurredAt:new Date().toISOString()});
      await call('stepEvent',{identity:step,state:'awaiting-human',occurredAt:new Date().toISOString(),result:{identity:step,status:'awaiting-human',handoffId:'synthetic-resume'}});
      await call('stepEvent',{identity:step,state:'running',occurredAt:new Date().toISOString()});
      const other={...step,attemptId:'step-other',stepId:'concurrent'};
      if(${overlap})await call('stepEvent',{identity:other,state:'running',occurredAt:new Date().toISOString()});
      const source=await call('attachArtifact','source','ignored','application/json');
      const identity={executionId:step.executionId,attemptId:step.attemptId,datasetId:'orders'};
      await call('beginDataset',identity);await call('appendBatch',{...identity,batchId:'batch',records:[{id:'one',amount:'12.00'}],provenance:{origin:'browser',sourceRefs:[source.id]}});
      await call('finishDataset',{...identity,status:'complete',committedBatches:1,committedRecords:1});
      await call('stepEvent',{identity:step,state:'succeeded',occurredAt:new Date().toISOString(),result:{identity:step,status:'succeeded',value:null}});
      if(${overlap})await call('stepEvent',{identity:other,state:'succeeded',occurredAt:new Date().toISOString(),result:{identity:other,status:'succeeded',value:null}});
      parentPort.postMessage({type:'complete',output:{identity},nodeVersion:process.versions.node});`);
    const raw:ProtocolTransport={send:()=>{},close:()=>raw.onclose?.()};
    try{
      const result=await (await startWorkflow({directory:source,input:{},targetId:'synthetic-target',workerPath:worker,transport:new GateTransport(raw),dependencyLockPath:path.join(source,'package-lock.json'),snapshotDirectory:managed.snapshotDirectory,execution:{binding:managed.binding,datasets:managed.datasets,saveStep:managed.saveStep},beforeWorker:managed.prepared,hooks:{checkpoint:async()=>({id:'cp'}),emitData:async()=>{},assertion:async()=>{},progress:async()=>{},requestHuman:async()=>{},attachArtifact:async()=>{const artifact=await store.putArtifact({kind:'response-body',mediaType:'application/json',data:JSON.stringify({items:[{id:'one',amount:'12.00'}]}),source:{pageId:'page',url:'https://fixture.test/orders',requestKey:'request',responseObservedAt:new Date().toISOString()}});return {id:artifact.id};}}})).done;
      expect(result.status).toBe('completed');await managed.finish(result);await managed.close();await store.close();
      const reopened=new ProjectExecutions(root,new ProjectMaterials(root));
      const summary=await reopened.summary('project','execution');expect(summary.snapshotVerified).toBe(true);expect(summary.codeFingerprint).toBe(managed.binding.codeFingerprint);expect(summary.counts.datasets).toBe(1);
      await expect(reopened.summary('other','execution')).rejects.toMatchObject({status:403});
      await expect(reopened.assess('project','execution',[{executionId:'execution',attemptId:'fake',datasetId:'orders'}])).rejects.toMatchObject({status:403});
      const report=await reopened.assess('project','execution',[{executionId:'execution',attemptId:'step-one',datasetId:'orders'}]);expect(report.overall).toBe(overlap?'inconclusive':'pass');expect(report.version.verdict).toBe('pass');expect(report.materialStatus).toBe('candidate');
      const page=await reopened.reportItems('project','execution',report.reportId,'requirements',{maxBytes:8192,limit:10});expect(page.items).toHaveLength(1);expect((page.items[0] as any).humanReviews).toEqual([]);expect((page.items[0] as any).sourceVerdict).toBe(overlap?'inconclusive':'pass');
      const reports=await reopened.reports('project','execution',{maxBytes:8192,limit:1});expect(reports.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(reports)));expect(reports.returnedBytes).toBeLessThanOrEqual(8192);
      const receipts=await reopened.batches('project',{executionId:'execution',attemptId:'step-one',datasetId:'orders'},{maxBytes:4096,limit:1});expect(receipts.items).toHaveLength(1);
      const records=await reopened.records('project',{executionId:'execution',attemptId:'step-one',datasetId:'orders'},'batch',{maxBytes:4096,limit:1});expect(records.items[0].value).toEqual({id:'one',amount:'12.00'});
      const original=await readFile(path.join(root,'executions','execution',`report-${report.reportId}.json`),'utf8');
      await reopened.review('project','execution',report.reportId,{requirementId:'amount',decision:'exception',reason:'Human annotated this fixed report'});
      expect(await readFile(path.join(root,'executions','execution',`report-${report.reportId}.json`),'utf8')).toBe(original);
      if(!overlap){
        const denied=vi.spyOn(EvidenceReader.prototype,'artifactMetadata').mockRejectedValue(Object.assign(new Error('Synthetic metadata access denied'),{code:'EACCES'}));
        try{const failure=await reopened.assess('project','execution');const items=await reopened.reportItems('project','execution',failure.reportId,'requirements',{maxBytes:8192,limit:10});expect(JSON.stringify(items)).toContain('Original-source read failed');expect(JSON.stringify(items)).toContain('Synthetic metadata access denied');}finally{denied.mockRestore();}
      }
    }finally{await managed.close();await store.close();}
  });
});

