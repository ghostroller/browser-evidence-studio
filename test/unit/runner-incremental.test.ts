import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkflow, type RunnerHooks, type StartWorkflowOptions } from '@/runner/manager';
import { GateTransport, type ProtocolTransport } from '@/runner/gate';
import { PersistentDatasetService } from '@/runner/datasets';
import { fingerprintInput, fingerprintWorkflow } from '@/runner/fingerprint';
import type { DatasetIdentity, ExecutionBinding } from '@/contracts/execution';
import { assertWorkflowOutputBudget } from '@/runner/context';

const hooks: RunnerHooks = { checkpoint: async key => ({ id: key }), emitData: async () => {}, attachArtifact: async name => ({ id: name }), assertion: async () => {}, requestHuman: async () => {}, progress: async () => {} };
const preamble = `import { parentPort,workerData } from 'node:worker_threads';
  let next=0; const calls=new Map();
  parentPort.on('message',msg=>{ if(msg.type==='reply'){const call=calls.get(msg.id);calls.delete(msg.id);msg.error?call.reject(msg.originalError??msg.error):call.resolve(msg.value);} if(msg.type==='finish')parentPort.close(); });
  const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++next;calls.set(id,{resolve,reject});parentPort.postMessage({type:'reporter',id,method,args});});
  const identity={executionId:workerData.execution.binding.executionId,attemptId:workerData.execution.attemptId,datasetId:'orders'};
  parentPort.postMessage({type:'started',nodeVersion:process.versions.node});
`;
async function fixture(script: string, run: (options: StartWorkflowOptions, service: PersistentDatasetService, root: string, commands: string[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-c-incremental-'));
  const source = path.join(root, 'source'), output = path.join(root, 'output'); await mkdir(source); await mkdir(output);
  await writeFile(path.join(source, 'run.mjs'), `export async function run(){return 'frozen-v1';}`);
  await writeFile(path.join(source, 'workflow.json'), JSON.stringify({ schemaVersion: 1, driver: 'puppeteer', workflowId: 'incremental-test', entry: './run.mjs', exportName: 'run', requirements: [{ id: 'orders', checkpointKey: 'orders', description: 'Must remain user-defined', dataset: 'orders' }] }));
  await writeFile(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}');
  const workerPath = path.join(output, 'test-worker.mjs'); await writeFile(workerPath, preamble + script);
  const binding: ExecutionBinding = { schemaVersion: 1, executionId: 'execution', projectId: 'project', materialRevisionId: 'v1', materialContentHash: 'fixed-material-hash', codeFingerprint: (await fingerprintWorkflow(source)).sha256, inputFingerprint: fingerprintInput({}), environmentRef: 'synthetic-node', mode: 'current-page-test' };
  const service = await PersistentDatasetService.open(root, binding);
  const commands: string[] = [];
  const raw: ProtocolTransport = { send: message => { commands.push(message); }, close: () => raw.onclose?.() };
  const options: StartWorkflowOptions = { directory: source, workerPath, transport: new GateTransport(raw), targetId: 'synthetic-managed-target', input: {}, hooks,
    snapshotDirectory: output, execution: { binding, datasets: service, saveStep: event => service.saveStep(event) } };
  try { await run(options, service, root, commands); }
  finally {
    await service.close();
    assert.equal(await realpath(path.dirname(root)), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('bes-c-incremental-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('managed incremental worker retains durable records and original evidence error without copying records into the run result', async () => fixture(`
  await call('beginDataset',identity);
  const receipt=await call('appendBatch',{...identity,batchId:'page-1',records:[{id:'o-1',note:null}],provenance:{origin:'browser',sourceRefs:['data-source']}});
  const replay=await call('appendBatch',{...identity,batchId:'page-1',records:[{id:'o-1',note:null}],provenance:{origin:'browser',sourceRefs:['data-source']}});
  let evidenceError; try{await call('attachArtifact','screenshot','pixels','image/png');}catch(error){evidenceError=error;}
  await call('finishDataset',{...identity,status:'partial',committedBatches:1,committedRecords:1});
  parentPort.postMessage({type:'complete',output:{identity,receipt,replayed:replay.replayed,evidenceError},nodeVersion:process.versions.node});
`, async (options, service) => {
  options.hooks = { ...hooks, attachArtifact: async () => { throw new TypeError('screenshot backend failed', { cause: new Error('capture device unavailable') }); } };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.datasets, []);
  assert.equal(result.datasetSummaries?.[0].committedRecords, 1);
  assert.equal(result.datasetSummaries?.[0].committedBatches, 1);
  assert.equal(result.datasetSummaries?.[0].status, 'partial');
  const output = result.output as { identity: DatasetIdentity; replayed: boolean; evidenceError: { name: string; cause: { message: string } } };
  assert.equal(output.replayed, true); assert.equal(output.evidenceError.name, 'TypeError'); assert.equal(output.evidenceError.cause.message, 'capture device unavailable');
  assert.equal(result.evidenceErrors?.[0].error.name, 'TypeError');
  assert.equal((await service.records(output.identity, 'page-1', { limit: 5, maxBytes: 4096 })).items.length, 1);
  assert.notEqual(result.validation.overall, 'pass', 'Legacy workflow acceptance cannot verify fixed material requirements');
}));

test('cancel waits for worker exit, blocks delayed commands, and writes interrupted step result after durable data', async () => fixture(`
  const stepIdentity={executionId:identity.executionId,attemptId:'step-attempt',stepId:'details',entityKey:'o-1'};
  await call('stepEvent',{identity:stepIdentity,state:'running',occurredAt:new Date().toISOString()});
  await call('beginDataset',identity);
  await call('appendBatch',{...identity,batchId:'page-1',records:[{id:'o-1'}],provenance:{origin:'browser',sourceRefs:['source']}});
  await call('progress','durable');
  setTimeout(()=>parentPort.postMessage({type:'cdp.send',message:JSON.stringify({id:99,method:'Input.dispatchMouseEvent',params:{type:'mousePressed'}})}),150);
`, async (options, service, root, commands) => {
  let ready!: () => void; const durable = new Promise<void>(resolve => { ready = resolve; });
  options.hooks = { ...hooks, progress: async () => { ready(); } };
  const handle = await startWorkflow(options); await durable; await handle.cancel('user stopped');
  const result = await handle.done;
  assert.equal(result.status, 'cancelled'); assert.equal(options.transport.snapshot().state, 'closed');
  await delay(180); assert.deepEqual(commands, []);
  assert.equal(result.steps?.at(-1)?.state, 'cancelled');
  assert.equal(result.datasetSummaries?.[0].committedRecords, 1);
  assert.equal((await service.summary(result.datasetSummaries![0])).status, 'unfinished');
  const terminal = JSON.parse(await readFile(path.join(root, 'executions/execution/attempts/step-attempt/step-0002.json'), 'utf8')) as { state: string };
  assert.equal(terminal.state, 'cancelled');
}));

test('legacy emitData uses durable batch adapter when fixed execution is supplied', async () => fixture(`
  await call('emitData','orders',[{id:'legacy-row'}],{origin:'browser',sourceRefs:['legacy-source'],pagination:{complete:true,pages:1,terminalReason:'script declared end'}});
  parentPort.postMessage({type:'complete',output:null,nodeVersion:process.versions.node});
`, async (options, service) => {
  let legacyCalls = 0; options.hooks = { ...hooks, emitData: async () => { legacyCalls++; } };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.status, 'completed'); assert.equal(legacyCalls, 0);
  assert.equal(result.datasetSummaries?.[0].status, 'complete');
  assert.equal((await service.records(result.datasetSummaries![0], 'legacy-emitData', { limit: 5, maxBytes: 4096 })).items.length, 1);
}));

test('binding mismatch prevents worker startup and late changes to source do not replace snapshot code', async () => fixture(`
  const module=await import(new URL('file:///' + workerData.entryPath.replaceAll('\\\\','/')).href);
  parentPort.postMessage({type:'complete',output:await module.run(),nodeVersion:process.versions.node});
`, async options => {
  const invalid = { ...options, execution: { ...options.execution!, binding: { ...options.execution!.binding, inputFingerprint: 'wrong' } } };
  await assert.rejects(startWorkflow(invalid), /does not match/);
  options.beforeWorker = async () => { await writeFile(path.join(options.directory, 'run.mjs'), `export async function run(){return 'changed-v2';}`); };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.output, 'frozen-v1');
  assert.equal(result.validation.versionVerdict, 'fail');
  assert.ok(result.snapshot?.contentHash);
}));

test('oversized entry output is refused before worker message serialization and defensively at the host without discarding durable data', async () => {
  assert.throws(() => assertWorkflowOutputBudget({ data: 'x'.repeat(65536) }), /64 KiB/);
  await fixture(`
    await call('emitData','orders',[{id:'retained'}],{origin:'browser',sourceRefs:['source']});
    parentPort.postMessage({type:'complete',output:'x'.repeat(70000),nodeVersion:process.versions.node});
  `, async (options, service) => {
    const result = await (await startWorkflow(options)).done;
    assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /64 KiB/);
    assert.equal(result.output, undefined); assert.equal(result.datasetSummaries?.[0].committedRecords, 1);
    assert.equal((await service.records(result.datasetSummaries![0], 'legacy-emitData', { limit: 5, maxBytes: 4096 })).items.length, 1);
  });
});

test('checkpoint handles round-trip with manager-resolved workflow and active step scopes', async () => fixture(`
  const stepIdentity={executionId:identity.executionId,attemptId:'step-sample',stepId:'details'};
  const workflow=await call('checkpoint','workflow');
  await call('stepEvent',{identity:stepIdentity,state:'running',occurredAt:new Date().toISOString()});
  const step=await call('checkpoint','step',{stepAttemptId:stepIdentity.attemptId});
  await call('stepEvent',{identity:stepIdentity,state:'succeeded',occurredAt:new Date().toISOString(),result:{status:'succeeded',identity:stepIdentity,value:null}});
  parentPort.postMessage({type:'complete',output:{workflow,step},nodeVersion:process.versions.node});
`, async options => {
  const scopes: unknown[] = [];
  options.hooks = { ...hooks, checkpoint: async (key, _details, _signal, scope) => { scopes.push(scope); return { id: key, sourceRefs: ['sample-' + key] }; } };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(scopes, [{ executionId: 'execution', attemptId: result.workflowAttemptId }, { executionId: 'execution', attemptId: 'step-sample', stepId: 'details' }]);
  assert.deepEqual(result.output, { step: { id: 'step', sourceRefs: ['sample-step'] }, workflow: { id: 'workflow', sourceRefs: ['sample-workflow'] } });
}));

for (const invalid of ['unknown', 'stale', 'oversized'] as const) test(`checkpoint ${invalid} identity or receipt fails the execution`, async () => fixture(`
  const stepIdentity={executionId:identity.executionId,attemptId:'step-sample',stepId:'details'};
  if ('${invalid}' === 'stale') {
    await call('stepEvent',{identity:stepIdentity,state:'running',occurredAt:new Date().toISOString()});
    await call('stepEvent',{identity:stepIdentity,state:'succeeded',occurredAt:new Date().toISOString(),result:{status:'succeeded',identity:stepIdentity,value:null}});
  }
  await call('checkpoint','bad','${invalid}'==='oversized'?undefined:{stepAttemptId:'step-sample'}).catch(()=>{});
`, async options => {
  let calls = 0;
  options.hooks = { ...hooks, checkpoint: async key => { calls++; return { id: key, sourceRefs: ['x'.repeat(513)] }; } };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', invalid === 'oversized' ? /handle budget/ : /currently running/);
  assert.equal(calls, invalid === 'oversized' ? 1 : 0);
  assert.deepEqual(result.checkpoints, []);
}));

for (const conflict of ['checkpoint', 'terminal'] as const) test(`pending checkpoint rejects concurrent ${conflict} and preserves step identity`, async () => fixture(`
  const stepIdentity={executionId:identity.executionId,attemptId:'step-sample',stepId:'details'};
  await call('stepEvent',{identity:stepIdentity,state:'running',occurredAt:new Date().toISOString()});
  void call('checkpoint','first',{stepAttemptId:stepIdentity.attemptId}).catch(()=>{});
  if ('${conflict}' === 'checkpoint') await call('checkpoint','second',{stepAttemptId:stepIdentity.attemptId}).catch(()=>{});
  else await call('stepEvent',{identity:stepIdentity,state:'succeeded',occurredAt:new Date().toISOString(),result:{status:'succeeded',identity:stepIdentity,value:null}}).catch(()=>{});
`, async options => {
  options.hooks = { ...hooks, checkpoint: async (_key, _details, signal) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const result = await (await startWorkflow(options)).done;
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', conflict === 'checkpoint' ? /Concurrent checkpoint/ : /while its checkpoint/);
  assert.deepEqual(result.checkpoints, []);
  assert.equal(result.steps?.at(-1)?.state, 'failed');
}));
