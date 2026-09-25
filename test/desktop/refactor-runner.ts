import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { SocketTransport } from '@/main/browser/connection';
import { PersistentDatasetService } from '@/runner/datasets';
import { fingerprintInput, fingerprintWorkflow } from '@/runner/fingerprint';
import { GateTransport } from '@/runner/gate';
import { startWorkflow, type WorkflowRunResult } from '@/runner/manager';
import type { ExecutionBinding } from '@/contracts/execution';

/** Root owns scheduling/wiring this fixture into the single visible Electron test process. */
export async function runRefactorRunnerScenarios(studio: Studio, siteUrl: string): Promise<{ results: { variant: string; status: string; records: number }[] }> {
  if (studio.active) await studio.seal();
  if (studio.state().session) await studio.closeSession();
  const fixture = path.join(studio.root, 'incremental-runner-fixture'); await mkdir(fixture, { recursive: true });
  await writeFile(path.join(fixture, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'incremental-runner-fixture', driver: 'puppeteer', entry: './run.mjs', exportName: 'run', requirements: [{ id: 'orders', checkpointKey: 'orders', description: 'Synthetic fixed-version requirements', dataset: 'orders' }] }));
  await writeFile(path.join(fixture, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(path.join(fixture, 'run.mjs'), `
    export async function run({page,input,reporter,steps}) {
      await page.goto(input.baseUrl+'/orders',{waitUntil:'domcontentloaded'});
      await page.waitForSelector('#increment');
      if(input.variant==='cancel'||input.variant==='timeout') {
        return steps.run({stepId:'delayed-click',timeoutMs:input.variant==='timeout'?100:5000,run:async()=>{
          await reporter.progress('delayed-click-ready');
          await new Promise(resolve=>setTimeout(resolve,1000));
          await page.click('#increment');
          return 'late-click';
        }});
      }
      const profile=await steps.run({stepId:'profile',run:async()=>{await page.title();throw new TypeError('Synthetic profile failed',{cause:new Error('Original profile selector diagnosis')});}});
      const blocked=await steps.run({stepId:'needs-profile',dependencies:[profile],run:async()=>{throw new Error('Blocked module must not run');}});
      const list=await steps.run({stepId:'orders',run:async()=>page.$eval('#ssr-data',element=>JSON.parse(element.textContent).items),commit:async(value,ctx)=>{
        const id={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'orders'};
        await reporter.beginDataset(id);
        await reporter.appendBatch({...id,batchId:'ssr-page',records:value,provenance:{origin:'browser',sourceRefs:['synthetic-ssr-data']}});
        await reporter.finishDataset({...id,status:'partial',committedBatches:1,committedRecords:value.length});
      }});
      const details=[];
      if(list.status==='succeeded') for(let index=0;index<list.value.length;index++) {
        const order=list.value[index];
        details.push(await steps.run({stepId:'detail',entityKey:order.id,dependencies:[list],run:async()=>{
          if(index===1) throw new Error('Synthetic one-entity detail failure');
          await page.goto(input.baseUrl+'/orders/'+encodeURIComponent(order.id),{waitUntil:'domcontentloaded'});
          return page.$eval('#detail-data',element=>JSON.parse(element.textContent));
        },commit:async(value,ctx)=>{
          const id={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'details'};
          await reporter.beginDataset(id);
          await reporter.appendBatch({...id,batchId:order.id,records:[value],provenance:{origin:'browser',sourceRefs:['synthetic-detail-'+order.id]}});
          await reporter.finishDataset({...id,status:'complete',committedBatches:1,committedRecords:1});
        },evidence:async()=>{if(index===0)await reporter.attachArtifact('intentional-screenshot-failure','synthetic','image/png');}}));
      }
      return {profile,blocked,list,details};
    }
  `);
  const project = await studio.createProject({ name: 'C 增量执行实跑', objective: '模块隔离、耐久批次、真实取消静默', scriptDirectory: fixture });
  const profile = await studio.createProfile({ projectId: project.id, name: 'C 合成独立环境' });
  const results: { variant: string; status: string; records: number }[] = [];
  for (const variant of ['partial', 'cancel', 'timeout']) {
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/orders`, kind: 'validate' });
    await studio.control('agent');
    const page = studio.current();
    const input = { baseUrl: siteUrl, variant };
    const binding: ExecutionBinding = { schemaVersion: 1, executionId: `execution-${variant}`, projectId: project.id, materialRevisionId: 'synthetic-v1', materialContentHash: 'synthetic-revision-hash', codeFingerprint: (await fingerprintWorkflow(fixture)).sha256, inputFingerprint: fingerprintInput(input), environmentRef: `recording:${studio.required().id}`, mode: 'from-start-validation' };
    const service = await PersistentDatasetService.open(studio.root, binding);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let handle: Awaited<ReturnType<typeof startWorkflow>> | undefined;
    try {
      const transport = new GateTransport(await SocketTransport.connect(studio.endpoint));
      handle = await startWorkflow({ directory: fixture, input, targetId: page.targetId, transport, snapshotDirectory: studio.root, maxDurationMs: 20_000,
        execution: { binding, datasets: service, saveStep: event => service.saveStep(event) }, hooks: {
          checkpoint: async key => ({ id: key }), emitData: async () => { throw new Error('Incremental path must not retain legacy records'); },
          attachArtifact: async name => { throw new TypeError(`Auxiliary ${name}`, { cause: new Error('Synthetic screenshot backend failure') }); },
          assertion: async () => {}, requestHuman: async () => { throw new Error('No undeclared human step in this fixture'); },
          progress: async message => { if (message === 'delayed-click-ready') entered(); },
        } });
      if (variant === 'cancel') { await Promise.race([started, handle.done.then(result => { throw new Error(`Exited before cancel point: ${result.error}`); })]); await handle.cancel('Synthetic user cancelled delayed browser click'); }
      const result: WorkflowRunResult = await handle.done;
      assert.equal(transport.snapshot().state, 'closed');
      if (variant === 'partial') {
        assert.equal(result.status, 'completed', result.error);
        const output = result.output as { profile: { status: string }; blocked: { status: string }; list: { status: string }; details: { status: string }[] };
        assert.equal(output.profile.status, 'failed'); assert.equal(output.blocked.status, 'blocked'); assert.equal(output.list.status, 'succeeded');
        assert.ok(output.details.some(detail => detail.status === 'failed'));
        assert.ok(output.details.some(detail => detail.status === 'partial'));
        assert.ok((result.datasetSummaries ?? []).some(dataset => dataset.datasetId === 'details' && dataset.committedRecords > 0));
        assert.deepEqual(result.datasets, []);
      } else {
        assert.equal(result.status, variant === 'cancel' ? 'cancelled' : 'failed', result.error);
        await delay(1200);
        assert.equal(await page.page.$eval('#action-count', element => element.textContent), '0', 'Terminated worker must never send the delayed Puppeteer click');
        assert.equal(result.steps?.at(-1)?.state, variant === 'cancel' ? 'cancelled' : 'failed');
      }
      const records = result.datasetSummaries?.reduce((count, dataset) => count + dataset.committedRecords, 0) ?? 0;
      results.push({ variant, status: result.status, records });
      await writeFile(path.join(studio.root, `refactor-runner-${variant}.json`), JSON.stringify(result, null, 2));
      await studio.control('human');
    } finally {
      if (handle) await handle.cancel('Fixture cleanup');
      await service.close();
      await studio.seal(); await studio.closeSession();
    }
  }
  return { results };
}
