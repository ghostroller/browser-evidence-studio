import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { startApi, type ApiOptions } from '@/main/api/server';
import { makeDispatch } from '@/main/services/dispatch';
import type { Studio } from '@/main/services/studio';
import { TaskAuthorizations, type TaskCapability } from '@/main/services/task-authorization';

const authorizations: TaskAuthorizations[] = [];
afterEach(() => { for (const tasks of authorizations.splice(0)) tasks.close(); });

async function setup(dispatch: ApiOptions['dispatch'], authorizationId?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-validation-api-'));
  const api = await startApi({ root, dispatch });
  const { token } = JSON.parse(await readFile(api.connectionFile, 'utf8')) as { token: string };
  const call = (method: string, endpoint: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const job=/^\/v1\/jobs\/[a-f0-9-]+(?:\/cancel)?$/.test(endpoint);
    const target=job&&method==='GET'&&authorizationId?`${endpoint}?authorizationId=${authorizationId}`:endpoint;
    const payload=method==='POST'&&authorizationId?{...(body as object),authorizationId,projectId:'project-1'}:body;
    const serialized = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request(`${api.address}${target}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(serialized)) }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    req.on('error', reject); req.end(serialized);
  });
  return { call, async cleanup() { await api.close(); await rm(root, { recursive: true, force: true }); } };
}

async function eventual<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The validation job did not reach the expected state');
}

type ValidationOptions = { signal?: AbortSignal; requireGrant?: boolean };
async function fakeStudio(validate: (body: any, options: ValidationOptions) => Promise<unknown>, controller: 'human' | 'agent' = 'agent') {
  let queue: Promise<unknown> = Promise.resolve();
  const calls: string[] = [];
  const run = { id: 'run-1', projectId: 'project-1', profileId: 'profile-1', leaseEpoch: 1, controller };
  const tasks = new TaskAuthorizations(); authorizations.push(tasks);
  const scope = { projectId: run.projectId, profileId: run.profileId, sessionId: 'session-1', directory: process.cwd(), pageId: 'page-1', targetId: 'target-1', url: 'https://fixture.test/' };
  const grant = await tasks.issue(scope, { origins: ['https://fixture.test'], pages: [{ pageId: scope.pageId, targetId: scope.targetId }], capabilities: ['execute', 'page-act'], durationMs: 60000, maxOperations: 100 });
  const studio = {
    tasks,
    instanceId:'fixture-instance',
    projects:[{id:'project-1',name:'One'},{id:'project-2',name:'Two'}],
    profiles:[{id:'profile-1',projectId:'project-1'},{id:'profile-2',projectId:'project-2'}],
    runs:[{id:'run-1',projectId:'project-1',profileId:'profile-1',status:'open',createdAt:'2026-09-26T00:00:00.000Z'}],
    state(){return {instanceId:'fixture-instance',projects:this.projects,profiles:this.profiles,runs:this.runs,validations:[],active:null};},
    authorizedOperation: (body: any, capability: TaskCapability, operation: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) => tasks.run(body.authorizationId, capability, scope, operation, signal),
    required: () => run,
    serialized<T>(action: () => Promise<T>) { const result = queue.then(action); queue = result.catch(() => {}); return result; },
    async validate(body: any, options: ValidationOptions) { calls.push(`validate:${body.input?.key}`); return validate(body, options); },
    async stopRunner() { calls.push('stopRunner'); return {}; },
    async control() { calls.push('control'); return {}; },
    async action() { calls.push('action'); return {}; },
    async authorizeValidationStart() { calls.push('authorizeValidationStart'); return {}; },
    async revokeValidationStart() { calls.push('revokeValidationStart'); return {}; },
    async validationStartGrant(body: any) { calls.push('validationStartGrant'); return { runId: body.runId, grant: null }; },
  };
  const dispatch = makeDispatch(studio as unknown as Studio);
  // Queue/cancellation fixtures supply a real grant; production scope and absent
  // grant rejection are covered by the dedicated authorization/API tests.
  const authorizedDispatch: typeof dispatch = (method, body, source, context) => dispatch(method, { authorizationId: grant.authorizationId, projectId: run.projectId, ...body }, source, context);
  return { calls, run, tasks, authorizationId:grant.authorizationId, dispatch: authorizedDispatch, rawDispatch:dispatch };
}

test('job status, cached result and idempotent retry require the owning active task', async () => {
  const fake=await fakeStudio(async()=>({validationId:'validation-owned'}));
  const other=await fake.tasks.issue({projectId:'project-1'}, {origins:[],pages:[],capabilities:['results-read'],durationMs:60000,maxOperations:10});
  const fixture=await setup(fake.rawDispatch);
  try {
    const body={leaseEpoch:1,projectId:'project-1',authorizationId:fake.authorizationId,idempotencyKey:'owned-key',input:{key:'owned'}};
    const accepted=await fixture.call('POST','/v1/runs/run-1/validations',body);
    assert.equal(accepted.status,202);
    const endpoint=`/v1/jobs/${accepted.json.jobId}`;
    assert.equal((await fixture.call('GET',endpoint)).status,403);
    assert.equal((await fixture.call('GET',`${endpoint}?authorizationId=${other.authorizationId}`)).status,403);
    const owned=await eventual(()=>fixture.call('GET',`${endpoint}?authorizationId=${fake.authorizationId}`),result=>result.json.status==='succeeded');
    assert.equal(owned.json.result.validationId,'validation-owned');
    fake.tasks.revoke(fake.authorizationId);
    assert.equal((await fixture.call('GET',`${endpoint}?authorizationId=${fake.authorizationId}`)).status,403);
    assert.equal((await fixture.call('POST','/v1/runs/run-1/validations',body)).status,403);
    const safeStop=await fixture.call('POST',`${endpoint}/cancel`,{authorizationId:fake.authorizationId});
    assert.equal(safeStop.status,202);assert.equal(safeStop.json.status,'succeeded');
  } finally { await fixture.cleanup(); }
});

test('HTTP discovery is limited to the authorized project and closes on revocation',async()=>{
  const fake=await fakeStudio(async()=>({}));
  const other=await fake.tasks.issue({projectId:'project-2'},{origins:[],pages:[],capabilities:['materials-read'],durationMs:60000,maxOperations:10});
  const fixture=await setup(fake.rawDispatch);
  try{
    assert.equal((await fixture.call('GET','/v1/state')).status,403);
    const one=await fixture.call('GET',`/v1/state?authorizationId=${fake.authorizationId}`);
    assert.equal(one.status,200);assert.deepEqual(one.json.projects.map((item:any)=>item.id),['project-1']);
    const two=await fixture.call('GET',`/v1/projects?authorizationId=${other.authorizationId}`);
    assert.equal(two.status,200);assert.deepEqual(two.json.items.map((item:any)=>item.id),['project-2']);
    assert.equal((await fixture.call('GET',`/v1/projects/project-2?authorizationId=${fake.authorizationId}`)).status,403);
    fake.tasks.revoke(other.authorizationId);
    assert.equal((await fixture.call('GET',`/v1/projects?authorizationId=${other.authorizationId}`)).status,403);
  }finally{await fixture.cleanup();}
});

test('revocation prevents a queued validation from starting while owner cancellation stays available',async()=>{
  let releaseFirst!:()=>void;
  const fake=await fakeStudio(async(body)=>{if(body.input.key==='first')await new Promise<void>(resolve=>{releaseFirst=resolve;});return {validationId:`validation-${body.input.key}`};});
  const second=await fake.tasks.issue({projectId:'project-1',profileId:'profile-1',sessionId:'session-1',directory:process.cwd()},
    {origins:['https://fixture.test'],pages:[{pageId:'page-1',targetId:'target-1'}],capabilities:['execute','page-act'],durationMs:60000,maxOperations:10});
  const fixture=await setup(fake.rawDispatch);
  try{
    const base={projectId:'project-1',profileId:'profile-1',sessionId:'session-1',pageId:'page-1',leaseEpoch:1};
    const first=await fixture.call('POST','/v1/runs/run-1/validations',{...base,authorizationId:fake.authorizationId,input:{key:'first'}});
    assert.equal(first.status,202);
    await eventual(()=>fake.calls.length,count=>count===1);
    const queued=await fixture.call('POST','/v1/runs/run-1/validations',{...base,authorizationId:second.authorizationId,input:{key:'second'}});
    assert.equal(queued.status,202);
    fake.tasks.revoke(second.authorizationId);
    assert.equal((await fixture.call('GET',`/v1/jobs/${queued.json.jobId}?authorizationId=${second.authorizationId}`)).status,403);
    assert.equal((await fixture.call('POST',`/v1/jobs/${queued.json.jobId}/cancel`,{authorizationId:second.authorizationId})).status,202);
    releaseFirst();
    await eventual(()=>fixture.call('GET',`/v1/jobs/${first.json.jobId}?authorizationId=${fake.authorizationId}`),response=>response.json.status==='succeeded');
    assert.deepEqual(fake.calls,['validate:first']);
  }finally{releaseFirst?.();await fixture.cleanup();}
});

test('cancelling queued validation B leaves active validation A running and never invokes B', async () => {
  let finishA: (() => void) | undefined, signalA: AbortSignal | undefined;
  const fake = await fakeStudio(async (body, options) => {
    assert.equal(body.input.key, 'a', 'cancelled B must never enter Studio.validate');
    signalA = options.signal;
    await new Promise<void>(resolve => { finishA = resolve; });
    return { validationId: 'validation-a' };
  });
  const fixture = await setup(fake.dispatch,fake.authorizationId);
  try {
    const a = await fixture.call('POST', '/v1/runs/run-1/validations', { leaseEpoch: 1, input: { key: 'a' } });
    assert.equal(a.status, 202);
    await eventual(() => signalA, Boolean);
    const b = await fixture.call('POST', '/v1/runs/run-1/validations', { leaseEpoch: 1, input: { key: 'b' } });
    assert.equal(b.status, 202);
    await eventual(() => fixture.call('GET', `/v1/jobs/${b.json.jobId}`), result => result.json.status === 'running');
    const cancel = await fixture.call('POST', `/v1/jobs/${b.json.jobId}/cancel`, {});
    assert.equal(cancel.status, 202);
    assert.equal(cancel.json.cancellationRequested, true);
    assert.deepEqual(fake.calls, ['validate:a']);
    assert.equal(signalA!.aborted, false, 'B cancellation must not abort A');
    assert.equal((await fixture.call('GET', `/v1/jobs/${a.json.jobId}`)).json.status, 'running');
    finishA!();
    const completed = await eventual(() => fixture.call('GET', `/v1/jobs/${a.json.jobId}`), result => result.json.status === 'succeeded');
    assert.equal(completed.json.result.validationId, 'validation-a');
    const cancelled = await eventual(() => fixture.call('GET', `/v1/jobs/${b.json.jobId}`), result => result.json.status === 'cancelled');
    assert.equal(cancelled.json.error, undefined);
    assert.deepEqual(fake.calls, ['validate:a'], 'queued cancellation must not call global stopRunner or validate');
  } finally { finishA?.(); await fixture.cleanup(); }
});

test('active validation cancellation propagates its own signal reason and leaves another job unaffected', async () => {
  const signals = new Map<string, AbortSignal>();
  let rejectActive: ((reason: unknown) => void) | undefined, finishIndependent: (() => void) | undefined;
  let caughtReason: unknown;
  const fake = await fakeStudio(async (body, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    const key = body.input.key as string;
    signals.set(key, options.signal);
    if (key === 'active') {
      try {
        await new Promise<never>((_resolve, reject) => {
          rejectActive = reject;
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        });
      } catch (error) { caughtReason = error; throw error; }
    } else await new Promise<void>(resolve => { finishIndependent = resolve; });
    return { validationId: `validation-${key}` };
  });
  const fixture = await setup(fake.dispatch,fake.authorizationId);
  try {
    const active = await fixture.call('POST', '/v1/runs/run-1/validations', { leaseEpoch: 1, input: { key: 'active' } });
    assert.equal(active.status, 202);
    await eventual(() => signals.has('active'), Boolean);
    const other = await fixture.call('POST', '/v1/runs/run-1/validations', { leaseEpoch: 1, input: { key: 'independent' } });
    assert.equal(other.status, 202);
    await eventual(() => fixture.call('GET', `/v1/jobs/${other.json.jobId}`), result => result.json.status === 'running');
    const cancel = await fixture.call('POST', `/v1/jobs/${active.json.jobId}/cancel`, {});
    assert.equal(cancel.status, 202);
    const cancelled = await eventual(() => fixture.call('GET', `/v1/jobs/${active.json.jobId}`), result => result.json.status === 'cancelled');
    assert.equal(cancelled.json.error, undefined, 'the exact abort reason is cancellation, not a worker failure');
    assert.equal(caughtReason, signals.get('active')!.reason);
    assert.ok(caughtReason instanceof Error);
    await eventual(() => signals.has('independent'), Boolean);
    assert.notEqual(signals.get('active'), signals.get('independent'));
    assert.equal(signals.get('independent')!.aborted, false);
    await fixture.call('POST', `/v1/jobs/${active.json.jobId}/cancel`, {});
    assert.equal(signals.get('independent')!.aborted, false, 'repeated cancellation of A must not target the next job');
    finishIndependent!();
    const completed = await eventual(() => fixture.call('GET', `/v1/jobs/${other.json.jobId}`), result => result.json.status === 'succeeded');
    assert.equal(completed.json.result.validationId, 'validation-independent');
    assert.deepEqual(fake.calls, ['validate:active', 'validate:independent']);
  } finally { rejectActive?.(new Error('Test cleanup')); finishIndependent?.(); await fixture.cleanup(); }
});

test('retired one-time validation grants are absent from HTTP capabilities and routes', async () => {
  const fake = await fakeStudio(async () => ({}), 'human'), fixture = await setup(fake.dispatch,fake.authorizationId);
  try {
    const capabilities = await fixture.call('GET', '/v1/capabilities');
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.json.validationStartAuthorization, undefined);
    assert.equal(capabilities.json.taskAuthorization.requestField, 'authorizationId');
    assert.ok(!capabilities.json.operations.some((entry: { operation: string }) => ['authorizeValidationStart', 'revokeValidationStart'].includes(entry.operation)));
    for (const endpoint of [
      '/v1/authorizeValidationStart', '/v1/revokeValidationStart',
      '/v1/runs/run-1/authorize-validation-start', '/v1/runs/run-1/revoke-validation-start',
      '/v1/runs/run-1/validation-start-grant', '/v1/runs/run-1/validation-start-grant/revoke',
    ]) {
      const response = await fixture.call('POST', endpoint, { leaseEpoch: 1 });
      assert.equal(response.status, 404, endpoint);
      assert.equal(response.json.error.code, 'NOT_FOUND');
    }
    for (const method of ['authorizeValidationStart', 'revokeValidationStart']) {
      await assert.rejects(fake.dispatch(method, { runId: 'run-1', leaseEpoch: 1 }, 'api'), (error: any) => error.status === 403);
    }
    assert.deepEqual(fake.calls, [], 'the authorization service must never be reached by an API mutation');
    const read = await fixture.call('GET', '/v1/runs/run-1/validation-start-grant');
    assert.equal(read.status, 404);
    assert.deepEqual(fake.calls, []);
    await assert.rejects(fake.rawDispatch('startValidation',{startGrantId:'old-grant'},'api'),(error:any)=>error.status===403&&/task authorization/.test(error.message));
  } finally { await fixture.cleanup(); }
});

test('human ownership blocks ordinary control and actions even when a startup grant ID is supplied', async () => {
  const fake = await fakeStudio(async () => ({}), 'human'), fixture = await setup(fake.dispatch,fake.authorizationId);
  try {
    for (const [endpoint, body] of [
      ['validations', { input: {} }],
      ['control', { controller: 'agent', startGrantId: 'grant-for-validation-only' }],
      ['actions', { type: 'click', pageId: 'page-1', generation: 1, selector: '#safe', startGrantId: 'grant-for-validation-only' }],
    ] as const) {
      const accepted = await fixture.call('POST', `/v1/runs/run-1/${endpoint}`, { leaseEpoch: 1, ...body });
      assert.equal(accepted.status, 202);
      const failed = await eventual(() => fixture.call('GET', `/v1/jobs/${accepted.json.jobId}`), result => result.json.status === 'failed');
      assert.equal(failed.json.error.status, endpoint === 'control' ? 403 : 409);
      assert.match(failed.json.error.message, endpoint === 'control' ? /trusted client UI/ : /Human owns this browser/);
    }
    assert.deepEqual(fake.calls, [], 'a validation grant must not open general browser control');
  } finally { await fixture.cleanup(); }
});
