import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectMaterials } from '@/main/services/project-materials';
import { ProjectExecutions } from '@/main/services/project-executions';
import { createBrowserResultPort } from '@/main/workbench/result-port';
import { parseResultRequest } from '@/main/workbench/result-validation';
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
      await call('beginDataset',identity);await call('appendBatch',{...identity,batchId:'batch',records:[{id:'one',amount:'12.00'},{id:'two',amount:'24.00'}],provenance:{origin:'browser',sourceRefs:[source.id]}});
      await call('finishDataset',{...identity,status:'complete',committedBatches:1,committedRecords:2});
      await call('stepEvent',{identity:step,state:'succeeded',occurredAt:new Date().toISOString(),result:{identity:step,status:'succeeded',value:null}});
      if(${overlap})await call('stepEvent',{identity:other,state:'succeeded',occurredAt:new Date().toISOString(),result:{identity:other,status:'succeeded',value:null}});
      parentPort.postMessage({type:'complete',output:{identity},nodeVersion:process.versions.node});`);
    const raw:ProtocolTransport={send:()=>{},close:()=>raw.onclose?.()};
    try{
      const result=await (await startWorkflow({directory:source,input:{},targetId:'synthetic-target',workerPath:worker,transport:new GateTransport(raw),dependencyLockPath:path.join(source,'package-lock.json'),snapshotDirectory:managed.snapshotDirectory,execution:{binding:managed.binding,datasets:managed.datasets,saveStep:managed.saveStep},beforeWorker:managed.prepared,hooks:{checkpoint:async()=>({id:'cp'}),emitData:async()=>{},assertion:async()=>{},progress:async()=>{},requestHuman:async()=>{},attachArtifact:async()=>{const observedAt=new Date().toISOString();const artifact=await store.putArtifact({kind:'response-body',mediaType:'application/json',data:JSON.stringify({items:[{id:'one',amount:'12.00'},{id:'two',amount:'24.00'}]}),source:{pageId:'page',recordingId:'run',url:'https://fixture.test/orders',requestKey:'request',requestStartedAt:observedAt,responseObservedAt:observedAt}});return {id:artifact.id};}}})).done;
      expect(result.status).toBe('completed');await managed.finish(result);await managed.close();await store.close();
      const reopened=new ProjectExecutions(root,new ProjectMaterials(root));
      const summary=await reopened.summary('project','execution');expect(summary.snapshotVerified).toBe(true);expect(summary.codeFingerprint).toBe(managed.binding.codeFingerprint);expect(summary.counts.datasets).toBe(1);
      await expect(reopened.summary('other','execution')).rejects.toMatchObject({status:403});
      await expect(reopened.assess('project','execution',[{executionId:'execution',attemptId:'fake',datasetId:'orders'}])).rejects.toMatchObject({status:403});
      const report=await reopened.assess('project','execution',[{executionId:'execution',attemptId:'step-one',datasetId:'orders'}]);expect(report.overall).toBe(overlap?'inconclusive':'pass');expect(report.version.verdict).toBe('pass');expect(report.materialStatus).toBe('candidate');
      const page=await reopened.reportItems('project','execution',report.reportId,'requirements',{maxBytes:8192,limit:10});expect(page.items).toHaveLength(1);expect((page.items[0] as any).humanReviews).toEqual([]);expect((page.items[0] as any).sourceVerdict).toBe(overlap?'inconclusive':'pass');
      const browser=createBrowserResultPort(reopened),access={authorize:()=>{}};
      const catalog=await browser.execute(parseResultRequest({instanceId:'i',method:'projectExecutions',body:{projectId:'project',maxBytes:8192,limit:1}}),access);
      expect((catalog as any).items[0].executionId).toBe('execution');
      const browserReport=await browser.execute(parseResultRequest({instanceId:'i',method:'executionReport',body:{projectId:'project',executionId:'execution',reportId:report.reportId}}),access);
      expect((browserReport as any).overall).toBe(report.overall);expect((browserReport as any).binding.environmentRef).toBeUndefined();
      const browserRequirements=await browser.execute(parseResultRequest({instanceId:'i',method:'executionReportItems',body:{projectId:'project',executionId:'execution',reportId:report.reportId,collection:'requirements',maxBytes:8192,limit:10}}),access);
      expect((browserRequirements as any).items[0].sourceVerdict).toBe(overlap?'inconclusive':'pass');
      const reports=await reopened.reports('project','execution',{maxBytes:8192,limit:1});expect(reports.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(reports)));expect(reports.returnedBytes).toBeLessThanOrEqual(8192);
      const receipts=await reopened.batches('project',{executionId:'execution',attemptId:'step-one',datasetId:'orders'},{maxBytes:4096,limit:1});expect(receipts.items).toHaveLength(1);
      const records=await reopened.records('project',{executionId:'execution',attemptId:'step-one',datasetId:'orders'},'batch',{maxBytes:4096,limit:1});expect(records.items[0].value).toEqual({id:'one',amount:'12.00'});
      const browserBatches=await browser.execute(parseResultRequest({instanceId:'i',method:'datasetBatches',body:{projectId:'project',executionId:'execution',attemptId:'step-one',datasetId:'orders',maxBytes:4096,limit:1}}),access);
      expect((browserBatches as any).items).toHaveLength(1);expect((browserBatches as any).items[0]).toMatchObject({executionId:'execution',attemptId:'step-one',datasetId:'orders',batchId:'batch',recordCount:2});expect((browserBatches as any).items[0].artifactId).toBeUndefined();
      const browserRecords=await browser.execute(parseResultRequest({instanceId:'i',method:'datasetRecords',body:{projectId:'project',executionId:'execution',attemptId:'step-one',datasetId:'orders',batchId:'batch',maxBytes:4096,limit:1,fields:['id','amount','missing'],entity:{field:'id',equals:'one'}}}),access);
      expect((browserRecords as any).items[0]).toEqual({batchId:'batch',recordIndex:0,value:{id:'one',amount:'12.00'},missingFields:['missing']});
      const recordBody={projectId:'project',executionId:'execution',attemptId:'step-one',datasetId:'orders',batchId:'batch',maxBytes:4096,limit:1};
      const firstPage=await browser.execute(parseResultRequest({instanceId:'i',method:'datasetRecords',body:recordBody}),access) as any;
      expect(firstPage.items[0].value.id).toBe('one');expect(firstPage.nextCursor).toBeTruthy();
      const secondPage=await browser.execute(parseResultRequest({instanceId:'i',method:'datasetRecords',body:{...recordBody,cursor:firstPage.nextCursor}}),access) as any;
      expect(secondPage.items[0].value.id).toBe('two');expect(secondPage.nextCursor).toBeUndefined();


      const original=await readFile(path.join(root,'executions','execution',`report-${report.reportId}.json`),'utf8');
      await reopened.review('project','execution',report.reportId,{requirementId:'amount',decision:'exception',reason:'Human annotated this fixed report'});
      expect(await readFile(path.join(root,'executions','execution',`report-${report.reportId}.json`),'utf8')).toBe(original);
      if(!overlap){
        const denied=vi.spyOn(EvidenceReader.prototype,'artifactMetadata').mockRejectedValue(Object.assign(new Error('Synthetic metadata access denied'),{code:'EACCES'}));
        try{const failure=await reopened.assess('project','execution');const items=await reopened.reportItems('project','execution',failure.reportId,'requirements',{maxBytes:8192,limit:10});expect(JSON.stringify(items)).toContain('Original-source read failed');expect(JSON.stringify(items)).toContain('Synthetic metadata access denied');
          const browserFailure=await browser.execute(parseResultRequest({instanceId:'i',method:'executionReportItems',body:{projectId:'project',executionId:'execution',reportId:failure.reportId,collection:'requirements',maxBytes:8192,limit:10}}),access);
          expect(JSON.stringify(browserFailure)).toContain('原件读取失败');expect(JSON.stringify(browserFailure)).not.toContain('Synthetic metadata access denied');
        }finally{denied.mockRestore();}
      }
    }finally{await managed.close();await store.close();}
  });
});

