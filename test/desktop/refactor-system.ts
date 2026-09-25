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

/** Real A/B/C/E/F integration. The root alone schedules its Electron process.
 * No HTTP request can supply source observations, scope facts or human reviews. */
export async function runRefactorSystemScenario(studio: Studio): Promise<Record<string, unknown>> {
  const report: Record<string, any> = { passed: false, pid: process.pid, variants: [] };
  const html = '<!doctype html><title>Fixed source fixture</title><style>body{font:20px sans-serif}.amount{display:inline-block}</style><main><div data-entity="o-1"><span class="amount" data-field="amount">12.00</span></div><div data-entity="o-2"><span class="amount" data-field="amount">45.00</span></div><input id="unsaved" value="synthetic-unsaved"></main>';
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, sourceUrl = origin + '/orders';
  const dispatch = makeDispatch(studio);
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
      const job = await waitFor(async () => (await http('GET', `/v1/jobs/${started.data.jobId}`)).data, value => ['succeeded', 'failed', 'cancelled'].includes(value.status));
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
    await dispatch('revokeTask', { projectId: project.id, authorizationId: grant.authorizationId }, 'ui');
    const revoked = await http('POST', `/v1/projects/${project.id}/query/materialRevisions`, { authorizationId: grant.authorizationId, limit: 10 });
    assert.equal(revoked.status, 403); assert.equal(studio.current().targetId, targetId);
    const field = await dispatch('materialCollection', { projectId: project.id, kind: 'revision', revisionId: revision.revisionId, contentHash: revision.contentHash, collection: 'fields', limit: 10 }, 'ui');
    assert.equal(field.items[0].annotationId, undefined, 'Element examples do not require annotations');
    report.passed = true; return report;
  } catch (error) { report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error); throw error; }
  finally {
    await writeFile(path.join(studio.root, 'refactor-system-report.json'), JSON.stringify(report, null, 2));
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
