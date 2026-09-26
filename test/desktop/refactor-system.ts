import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';
import { ArchiveReplayService } from '@/replay/service';
import { SourceModel } from '@/replay/source-model';
import type { HistoricalElementRef } from '@/contracts/recording';
import { runRefactorWorkbenchUi } from './refactor-workbench';
import { SocketTransport } from '@/main/browser/connection';
import { GateTransport } from '@/runner/gate';
import { startWorkflow } from '@/runner/manager';
import { EvidenceReader } from '@/evidence/reader';

/** Real A/B/C/E/F integration. The root alone schedules its Electron process.
 * No HTTP request can supply source observations, scope facts or human reviews. */
export async function runRefactorSystemScenario(studio: Studio): Promise<Record<string, unknown>> {
  const report: Record<string, any> = { passed: false, pid: process.pid, variants: [] };
  const html = '<!doctype html><title>Fixed source fixture</title><style>body{font:20px sans-serif}.amount{display:inline-block}</style><main><div data-entity="o-1"><span class="amount" data-field="amount">12.00</span></div><div data-entity="o-2"><span class="amount" data-field="amount">45.00</span></div><div id="source-a"><span id="moved" data-original="stable-source">moved source</span></div><div id="source-b"></div><input id="unsaved" value="synthetic-unsaved"></main>';
  const server = createServer((request, response) => {
    if(request.url?.startsWith('/api/orders')){response.setHeader('content-type','application/json');response.end(JSON.stringify({items:[{id:'o-1',amount:'12.00'},{id:'o-2',amount:'45.00'}]}));return;}
    response.setHeader('content-type', 'text/html'); response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, sourceUrl = origin + '/orders';
  const dispatch = makeDispatch(studio);
  let sourceClosed=false;
  const closeSource=async()=>{if(sourceClosed)return;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));sourceClosed=true;};
  try {
    if (studio.active) await studio.seal(); if (studio.state().session) await studio.closeSession();
    const directory = path.join(studio.root, 'fixed-source-business'); await mkdir(directory);
    await writeFile(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'fixed-source-business', driver: 'puppeteer', entry: './run.mjs', exportName: 'run', requirements: [{ id: 'orders', checkpointKey: 'orders', description: 'Two displayed amounts', dataset: 'orders' }] }));
    await writeFile(path.join(directory, 'run.mjs'), `export async function run({page,input,reporter,steps}) {
      const result=await steps.run({stepId:'orders',run:async ctx=>{
        const records=await page.$$eval('[data-entity]',nodes=>nodes.map(node=>({id:node.getAttribute('data-entity'),amount:node.querySelector('[data-field=amount]').innerText})));
        if(input.variant==='wrong-value')records[0].amount='unobserved-value';
        const checkpoint=await reporter.checkpoint('orders',{requirementIds:['orders'],stepAttemptId:ctx.identity.attemptId});
        if(!checkpoint.sourceRefs||checkpoint.sourceRefs.length<2)throw new Error('Host did not persist both displayed source samples');
        return {records,sourceRefs:checkpoint.sourceRefs};
      },commit:async(value,ctx)=>{
        const identity={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'orders'};
        await reporter.beginDataset(identity);
        await reporter.appendBatch({...identity,batchId:'displayed',records:value.records,provenance:{origin:'browser',sourceRefs:value.sourceRefs}});
        await reporter.finishDataset({...identity,status:'complete',committedBatches:1,committedRecords:2});
      },evidence:async()=>{if(input.variant==='evidence-partial')throw new TypeError('Synthetic auxiliary evidence failed after durable business output');}});
      return {stepStatus:result.status};
    }`);
    const project = await studio.createProject({ name: 'G fixed source integration', objective: 'Real source samples and fixed requirements', scriptDirectory: directory });
    const profile = await studio.createProfile({ projectId: project.id, name: 'G synthetic isolated profile' });
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: sourceUrl });
    const live = studio.current(), recordingId = studio.required().id, targetId = live.targetId;
    await live.page.waitForSelector('[data-field=amount]'); await live.capture.flush();
    const position = live.capture.recordingPosition; assert.ok(position);
    const window = await new ArchiveReplayService(studio.reader(recordingId).runDir).window(position), model = new SourceModel(window.records);
    const example = [...model.nodes.values()].find(node => node.metadata?.attributes['data-field']?.status === 'present' && node.metadata.attributes['data-field'].value === 'amount'); assert.ok(example?.metadata);
    const target: HistoricalElementRef = { kind: 'dom-node', position, nodeId: example.id, frameId: example.metadata.frameId, mirrorScopeId: example.metadata.mirrorScopeId };
    await live.page.evaluate(async () => {
      document.querySelector('#source-b')!.appendChild(document.querySelector('#moved')!);
      for (let index = 0; index < 240; index++) {
        document.body.setAttribute('data-tick', String(index));
        if (index === 40 || index === 160) await new Promise(resolve => setTimeout(resolve, 150));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
    await live.capture.flush();
    const movedPosition=live.capture.recordingPosition!;
    const movedWindow=await new ArchiveReplayService(studio.reader(recordingId).runDir).window(movedPosition),movedModel=new SourceModel(movedWindow.records);
    assert.ok(movedWindow.records.length>=200,`Synthetic stream contains only ${movedWindow.records.length} source events`);
    const moved=[...movedModel.nodes.values()].find(node=>node.metadata?.attributes.id?.status==='present'&&node.metadata.attributes.id.value==='moved');
    assert.ok(moved?.metadata);const original=moved.metadata.attributes['data-original'];assert.equal(original?.status,'present');if(original?.status==='present')assert.equal(original.value,'stable-source');
    const movedParent=movedModel.nodes.get(moved.parentId!);const parentId=movedParent?.metadata?.attributes.id;assert.equal(parentId?.status,'present');if(parentId?.status==='present')assert.equal(parentId.value,'source-b');
    const movedRef:HistoricalElementRef={kind:'dom-node',position:movedPosition,nodeId:moved.id,frameId:moved.metadata.frameId,mirrorScopeId:moved.metadata.mirrorScopeId};
    const source=await new ArchiveReplayService(studio.reader(recordingId).runDir).node(movedRef,{maxBytes:24576,limit:10});
    const archivedOriginal=source.attributes['data-original'];assert.equal(archivedOriginal?.status,'present');if(archivedOriginal?.status==='present')assert.equal(archivedOriginal.value,'stable-source');
    report.movedSource={eventSeq:movedPosition.eventSeq,originalAttribute:source.attributes['data-original'],recordCount:movedWindow.records.length};
    await studio.seal(); assert.equal(studio.current().targetId, targetId);
    let draft = await dispatch('createMaterialDraft', { projectId: project.id }, 'ui');
    const edited = await dispatch('editMaterialDraft', { projectId: project.id, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision, edits: [
      { operation: 'recordings', recordingRefs: [recordingId] },
      { operation: 'upsert', collection: 'checkpoints', item: { id: 'later-card', kind: 'requirement', anchor: position, capturedAt: window.records.at(-1)!.receivedAt, createdAt: new Date().toISOString(), title: 'Created after recording', notes: '', requirementIds: ['orders'], annotationIds: [] } },
      { operation: 'upsert', collection: 'fields', item: { id: 'amount', dataset: 'orders', name: 'Displayed amount', description: 'Current entity amount', outputPath: '/amount', valueType: 'string', sourcePolicy: 'page-displayed', checkpointId: 'later-card', target, bindingStatus: 'bound', sourceProof: { kind: 'dom-text', sourceUrl, nodeAttribute: { name: 'data-field', value: 'amount' }, entityAttribute: 'data-entity', outputEntityPath: '/id' } } },
      { operation: 'upsert', collection: 'requirements', item: { id: 'orders', dataset: 'orders', description: 'Both displayed amounts', rules: [{ type: 'min-rows', count: 2 }, { type: 'unique', field: 'id' }], fieldIds: ['amount'] } },
    ] }, 'ui');
    assert.equal(edited.status, 'saved'); draft = edited.draft;
    const revision = await dispatch('publishMaterialDraft', { projectId: project.id, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision }, 'ui');
    report.material = { projectId: project.id, recordingId, revisionId: revision.revisionId, contentHash: revision.contentHash };
    const connection = JSON.parse(await readFile(studio.connection.file, 'utf8'));
    async function http(method: string, route: string, body?: Record<string, unknown>) {
      const response = await fetch(connection.address + route, { method, headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
      const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 32768); assert.ok(!text.includes(connection.token));
      return { status: response.status, data: JSON.parse(text) };
    }
    async function waitFor<T>(read: () => Promise<T>, complete: (value: T) => boolean): Promise<T> {
      const end = Date.now() + 45000;
      while (Date.now() < end) { const value = await read(); if (complete(value)) return value; await delay(50); }
      throw new Error('G integration did not reach a terminal state');
    }
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: sourceUrl });
    assert.equal(studio.current().targetId, targetId, 'Recording restart must preserve the live page');
    const grant = await dispatch('authorizeTask', { projectId: project.id, profileId: profile.id, sessionId: studio.state().session!.sessionId, leaseEpoch: studio.required().leaseEpoch, pageIds: [live.pageId], origins: [origin], capabilities: ['execute', 'history-read', 'materials-read', 'results-read'], durationMs: 120000, maxOperations: 100 }, 'ui');
    for (const variant of ['good', 'wrong-value', 'evidence-partial']) {
      const page = studio.current(), run = studio.required();
      const started = await http('POST', `/v1/runs/${run.id}/validations`, { authorizationId: grant.authorizationId, projectId: project.id, profileId: profile.id, sessionId: studio.state().session!.sessionId, pageId: page.pageId, generation: page.navigationGeneration, leaseEpoch: run.leaseEpoch, executionMode: 'current-page-test', materialRevisionId: revision.revisionId, materialContentHash: revision.contentHash, input: { variant } });
      assert.equal(started.status, 202);
      const job = await waitFor(async () => (await http('GET', `/v1/jobs/${started.data.jobId}?authorizationId=${grant.authorizationId}`)).data, value => ['succeeded', 'failed', 'cancelled'].includes(value.status));
      assert.equal(job.status, 'succeeded', JSON.stringify(job.error)); assert.ok(job.result.executionId);
      const executionId = job.result.executionId;
      const execution = await waitFor(() => dispatch('execution', { projectId: project.id, executionId }, 'ui'), value => !['starting', 'running', 'waiting-human'].includes(value.status));
      assert.equal(execution.status, 'completed'); assert.equal(execution.binding.materialRevisionId, revision.revisionId);
      const datasets = await dispatch('executionItems', { projectId: project.id, executionId, collection: 'datasets', limit: 10 }, 'ui');
      assert.equal(datasets.items.length, 1); assert.equal(datasets.items[0].committedRecords, 2);
      const assessed = await dispatch('assessExecution', { projectId: project.id, executionId, datasetIdentities: datasets.items.map(({ executionId, attemptId, datasetId }: any) => ({ executionId, attemptId, datasetId })) }, 'ui');
      assert.equal(assessed.overall, variant === 'wrong-value' ? 'fail' : 'pass', JSON.stringify(assessed));
      const requirements = await dispatch('executionReportItems', { projectId: project.id, executionId, reportId: assessed.reportId, collection: 'requirements', limit: 10 }, 'ui');
      assert.equal(requirements.items[0].sourceVerdict, variant === 'wrong-value' ? 'fail' : 'pass');
      const steps = await dispatch('executionItems', { projectId: project.id, executionId, collection: 'steps', limit: 10 }, 'ui');
      assert.equal(steps.items.at(-1).state, variant === 'evidence-partial' ? 'partial' : 'succeeded');
      report.variants.push({ variant, executionId, reportId: assessed.reportId, overall: assessed.overall, sourceVerdict: requirements.items[0].sourceVerdict, step: steps.items.at(-1).state });
    }
    const checkpointArtifacts=await studio.reader(studio.required().id).artifacts({limit:100,maxBytes:32768});
    const restrictedScreenshot=checkpointArtifacts.items.find((item:any)=>item.kind==='screenshot'&&item.captureStatus==='complete') as any;
    assert.ok(restrictedScreenshot,'Real checkpoint keeps its complete screenshot bytes');
    const deniedScreenshot=await http('GET',`/v1/runs/${studio.required().id}/artifacts/${restrictedScreenshot.id}/content?authorizationId=${grant.authorizationId}`);
    assert.equal(deniedScreenshot.status,403,'Ordinary Agent history cannot export raw checkpoint pixels');
    const trustedScreenshot=await dispatch('artifactContent',{runId:studio.required().id,artifactId:restrictedScreenshot.id},'ui');
    assert.deepEqual(trustedScreenshot.binary.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    report.screenshotPrivacy={agentContentStatus:deniedScreenshot.status,trustedUiBytes:trustedScreenshot.binary.length};
    await dispatch('revokeTask', { projectId: project.id, authorizationId: grant.authorizationId }, 'ui');
    const revoked = await http('POST', `/v1/projects/${project.id}/query/materialRevisions`, { authorizationId: grant.authorizationId, limit: 10 });
    assert.equal(revoked.status, 403); assert.equal(studio.current().targetId, targetId);
    const field = await dispatch('materialCollection', { projectId: project.id, kind: 'revision', revisionId: revision.revisionId, contentHash: revision.contentHash, collection: 'fields', limit: 10 }, 'ui');
    assert.equal(field.items[0].annotationId, undefined, 'Element examples do not require annotations');
    const goodExecutionId=report.variants[0].executionId;
    const goodDatasets=await dispatch('executionItems',{projectId:project.id,executionId:goodExecutionId,collection:'datasets',limit:10},'ui');
    const healthy=goodDatasets.items.find((item:any)=>item.datasetId==='orders'&&item.committedRecords===2);
    assert(healthy,'Committed good dataset must remain available before the disk fault');
    const catalogRoot=path.join(studio.root,'executions',goodExecutionId,'datasets');
    const bad=path.join(catalogRoot,healthy.attemptId,'bad-state');
    await mkdir(bad);
    await writeFile(path.join(bad,'dataset.json'),JSON.stringify({schemaVersion:1,executionId:goodExecutionId,attemptId:healthy.attemptId,datasetId:'bad-state'}));
    await writeFile(path.join(bad,'state.json'),'{broken');
    await writeFile(path.join(catalogRoot,'unexpected-attempt'),'preserved');
    const mixed=await dispatch('executionItems',{projectId:project.id,executionId:goodExecutionId,collection:'datasets',limit:10},'ui');
    assert(mixed.items.some((item:any)=>item.datasetId==='orders'&&item.committedRecords===2));
    assert(!mixed.items.some((item:any)=>item.datasetId==='bad-state'),'Post-finish directory cannot become a selectable dataset');
    const withIssue=await dispatch('execution',{projectId:project.id,executionId:goodExecutionId},'ui');
    assert(withIssue.datasetCatalogIssues?.some((item:any)=>item.entry.endsWith('/bad-state')&&item.code==='INDEX_RECOVERY_REQUIRED'));
    assert(withIssue.datasetCatalogIssues?.some((item:any)=>item.entry==='unexpected-attempt'));
    report.badDataset={status:'corrupt-unselectable',goodCommittedRecords:2,catalogIssue:'unexpected-attempt'};
    report.jsonSource=await runProductionJsonSourceChain(studio,project.id,origin);
    await closeSource();
    await runRefactorWorkbenchUi(studio, { projectId: project.id, recordingId, replayPosition: movedPosition, executionId: goodExecutionId, partialExecutionId: report.variants[2].executionId, brokenDatasetId:'bad-state', targetSelector: '#moved' });
    report.workbenchUi = 'passed-with-source-server-closed';
    report.passed = true; return report;
  } catch (error) { report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error); throw error; }
  finally {
    await writeFile(path.join(studio.root, 'refactor-system-report.json'), JSON.stringify(report, null, 2));
    await closeSource();
  }
}

async function runProductionJsonSourceChain(studio:Studio,projectId:string,origin:string){
  const run=studio.required(),page=studio.current(),sourceUrl=origin+'/api/orders';
  const directory=path.join(studio.root,'json-source-business');await mkdir(directory);
  await writeFile(path.join(directory,'package-lock.json'),'{"lockfileVersion":3}');
  await writeFile(path.join(directory,'workflow.json'),JSON.stringify({schemaVersion:1,workflowId:'json-source-business',driver:'puppeteer',entry:'./run.mjs',exportName:'run',requirements:[{id:'orders-json',checkpointKey:'orders-json',description:'Captured JSON order amounts',dataset:'orders-json'}]}));
  await writeFile(path.join(directory,'run.mjs'),`export async function run({page,input,reporter,steps}){
    const result=await steps.run({stepId:'orders-json',run:async()=>{
      const records=await page.evaluate(async()=>{const response=await fetch('/api/orders');return (await response.json()).items;});
      const source=await reporter.attachArtifact('captured-network-json','source-handle','application/json');
      if(input.variant==='wrong-value')records[0].amount='unobserved-value';
      return {records,sourceRef:source.id};
    },commit:async(value,ctx)=>{
      const identity={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'orders-json'};
      await reporter.beginDataset(identity);
      await reporter.appendBatch({...identity,batchId:'captured-json',records:value.records,provenance:{origin:'browser',sourceRefs:[value.sourceRef]}});
      await reporter.finishDataset({...identity,status:'complete',committedBatches:1,committedRecords:value.records.length});
    }});
    return {stepStatus:result.status};
  }`);
  const draft=await studio.materials.service.createDraft(projectId,'human');
  await studio.materials.service.updateDraft(projectId,draft.draftId,0,{checkpoints:[],annotations:[],recordingRefs:[run.id],
    requirements:[{id:'orders-json',description:'Captured order amounts',dataset:'orders-json',fieldIds:['amount'],rules:[{type:'min-rows',count:2},{type:'unique',field:'id'}]}],
    fields:[{id:'amount',dataset:'orders-json',name:'amount',description:'Amount in captured response',sourcePolicy:'any-evidenced',outputPath:'/amount',sourceProof:{kind:'json-record',sourceUrl,rowsPointer:'/items',entityPointer:'/id',outputEntityPath:'/id',valuePointer:'/amount'}}]},'human');
  const revision=await studio.materials.service.publish(projectId,draft.draftId,1,'human');
  const seen=new Set<string>();
  const variants=[] as Array<{variant:string;overall:string;sourceVerdict:string;sourceRef:string}>;
  for(const variant of ['good','wrong-value']){
    const executionId=randomUUID(),managed=await studio.executions.begin({executionId,projectId,materialRevisionId:revision.revisionId,materialContentHash:revision.contentHash,
      directory,dependencyLockPath:path.join(directory,'package-lock.json'),input:{variant},mode:'current-page-test',runId:run.id,pageId:page.pageId,environmentRef:'real-electron-puppeteer'});
    let sourceRef='';
    try{
      const transport=new GateTransport(await SocketTransport.connect(studio.endpoint));
      const result=await (await startWorkflow({directory,input:{variant},targetId:page.targetId,transport,dependencyLockPath:path.join(directory,'package-lock.json'),
        snapshotDirectory:managed.snapshotDirectory,execution:{binding:managed.binding,datasets:managed.datasets,saveStep:managed.saveStep},beforeWorker:managed.prepared,
        hooks:{checkpoint:async()=>({id:'unused'}),emitData:async()=>{},assertion:async()=>{},progress:async()=>{},requestHuman:async()=>{},attachArtifact:async()=>{
          await page.capture.flush();
          const reader=studio.reader(run.id);let cursor:string|undefined;const candidates:any[]=[];
          do{const batch=await reader.artifacts({limit:100,maxBytes:32768,cursor});candidates.push(...batch.items.filter((item:any)=>item.kind==='response-body'&&item.captureStatus==='complete'&&item.source?.url===sourceUrl&&item.source?.recordingId===run.id&&!seen.has(item.id)));cursor=batch.nextCursor;}while(cursor);
          assert.equal(candidates.length,1,'The test host must resolve one real captured JSON body, not create source metadata');
          sourceRef=candidates[0].id;seen.add(sourceRef);return {id:sourceRef};
        }}})).done;
      assert.equal(result.status,'completed');await managed.finish(result);
    }finally{await managed.close();}
    assert.ok(sourceRef);
    const assessed=await studio.executions.assess(projectId,executionId);
    const requirements=await studio.executions.reportItems(projectId,executionId,assessed.reportId,'requirements',{maxBytes:8192,limit:10});
    assert.equal(assessed.overall,variant==='good'?'pass':'fail',JSON.stringify(assessed));
    assert.equal((requirements.items[0] as any).sourceVerdict,variant==='good'?'pass':'fail');
    variants.push({variant,overall:assessed.overall,sourceVerdict:(requirements.items[0] as any).sourceVerdict,sourceRef});
    if(variant==='good'){
      const original=EvidenceReader.prototype.artifactMetadata;
      EvidenceReader.prototype.artifactMetadata=async function(id){const metadata=await original.call(this,id);if(id!==sourceRef)return metadata;return {...metadata,source:{...(typeof metadata.source==='object'?metadata.source:{}),responseObservedAt:undefined}};};
      try{const missing=await studio.executions.assess(projectId,executionId);assert.equal(missing.overall,'inconclusive','Missing producer identity must never pass as JSON source');}
      finally{EvidenceReader.prototype.artifactMetadata=original;}
    }
  }
  return {sourceUrl,variants,missingIdentity:'inconclusive'};
}
