import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';

/** Real HTTP consumption of authorization issued only through trusted UI dispatch. */
export async function runValidationStartScenarios(studio: Studio, siteUrl: string): Promise<void> {
  assert.equal(process.env.BES_TEST, '1', 'Trusted-renderer test input is restricted to synthetic desktop runs');
  assert.equal(studio.active, undefined, 'Validation-start scenarios require the preceding API run to be sealed');
  if(studio.state().session)await studio.closeSession();
  const connection = JSON.parse(await readFile(studio.connection.file, 'utf8'));
  const dispatch = makeDispatch(studio);
  const report = { schemaVersion: 1, passed: false, projectId: '', profileId: '', authorizationRunId: '',
    validationRunId: '', validationId: '', rejectedStarts: 0, issuedGrants: 0, consumedGrants: 0,
    cancelledJobId: '', schemaFailureRunId: '', cancelledTransitionJobId: '', checks: [] as string[], elapsedMs: 0 };
  const startedAt = performance.now();
  let unblockQueue: (() => void) | undefined;
  let queueBarrier: Promise<unknown> | undefined;

  async function request(method: string, route: string, body?: Record<string, unknown>, key?: string, authenticated = true) {
    const response = await fetch(connection.address + route, { method,
      headers: { ...(authenticated ? { Authorization: `Bearer ${connection.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 32768, 'Validation-start replies must remain bounded');
    assert.ok(!text.includes(connection.token), 'The API must not expose its connection token');
    return { status: response.status, data: JSON.parse(text) };
  }
  async function get(route: string) {
    const reply = await request('GET', route); assert.equal(reply.status, 200, route); return reply.data;
  }
  async function submit(route: string, body: Record<string, unknown>, key = randomUUID()) {
    const reply = await request('POST', route, body, key);
    assert.equal(reply.status, 202, `${route}: ${JSON.stringify(reply.data)}`);
    assert.equal(reply.data.idempotencyKey, key); assert.equal(typeof reply.data.jobId, 'string');
    return reply.data.jobId as string;
  }
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const value = await read(); if (accept(value)) return value;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const waitJob = (id: string) => waitFor(() => get(`/v1/jobs/${id}`), job => ['succeeded', 'failed', 'cancelled'].includes(job.status), `job ${id}`);
  async function rejectJob(route: string, body: Record<string, unknown>) {
    const job = await waitJob(await submit(route, body));
    assert.equal(job.status, 'failed'); assert.equal(job.error?.status, 409);
    return job;
  }
  const grantRoute = (runId: string) => `/v1/runs/${runId}/validation-start-grant`;
  const validationRoute = (runId: string) => `/v1/runs/${runId}/validations`;
  const workflowId = 'synthetic-authorized-start';
  const input = { baseUrl: siteUrl, label: 'synthetic-authorized-input' };

  try {
    const directory = await mkdtemp(path.join(studio.root, 'validation-start-workflow-'));
    const script = `
      export async function run({ page, input, reporter }) {
        await page.goto(input.baseUrl + '/lab', { waitUntil: 'domcontentloaded' });
        const text = await page.$eval('#lab-result', element => element.textContent);
        const checkpoint = await reporter.checkpoint('authorized-start', { title: 'Synthetic authorized validation' });
        await reporter.emitData('collected', [{ text, label: input.label }], { origin: 'browser', sourceRefs: [checkpoint.id] });
        return { count: 1 };
      }
    `;
    await writeFile(path.join(directory, 'run.mjs'), script);
    await writeFile(path.join(directory, 'input.schema.json'), JSON.stringify({ type: 'object', required: ['baseUrl', 'label'], additionalProperties: false,
      properties: { baseUrl: { type: 'string' }, label: { type: 'string', minLength: 1 } },
    }));
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId, entry: './run.mjs', exportName: 'run', driver: 'puppeteer', inputSchema: './input.schema.json',
      requirements: [{ id: 'authorized-start', checkpointKey: 'authorized-start', description: 'Run only the specifically authorized synthetic workflow and input',
        dataset: 'collected', rules: [{ type: 'min-rows', count: 1 }, { type: 'required', field: 'text' }, { type: 'required', field: 'label' }] }],
    }, null, 2));
    const project = await studio.createProject({ name: 'HTTP 验收启动授权', objective: '一次性受限启动授权，不授予通用浏览器控制', scriptDirectory: directory });
    const profile = await studio.createProfile({ projectId: project.id, name: '启动授权独立合成环境' });
    report.projectId = project.id; report.profileId = profile.id;
    const run = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/orders`, kind: 'demonstrate' });
    assert.ok(run); const authorizationRunId = run.id; report.authorizationRunId = authorizationRunId;
    await studio.current().page.waitForFunction(() => document.querySelector('#api-state')?.textContent === '已就绪', { timeout: 10_000 });
    const validationCountBefore = studio.state().validations.length;
    const authorizationBody = () => ({ runId: authorizationRunId, projectId: project.id, profileId: profile.id, leaseEpoch: studio.required().leaseEpoch, input });
    const startBody = (grant: any) => ({ projectId: project.id, profileId: profile.id, workflowId,
      leaseEpoch: grant.leaseEpoch, startGrantId: grant.grantId, input });
    const stillHuman = () => {
      assert.equal(studio.required().id, authorizationRunId); assert.equal(studio.required().controller, 'human');
      assert.equal(studio.required().locked, false); assert.equal(studio.required().execution, 'ready');
      assert.equal(studio.state().validations.length, validationCountBefore, 'Rejected starts must not create a validation');
    };
    async function authorize() {
      if ((await get(grantRoute(authorizationRunId))).grant) await dispatch('revokeValidationStart', { runId: authorizationRunId, leaseEpoch: studio.required().leaseEpoch }, 'ui');
      const beforeEpoch = studio.required().leaseEpoch;
      const grant = await dispatch('authorizeValidationStart', authorizationBody(), 'ui');
      assert.equal(grant.runId, authorizationRunId); assert.equal(grant.projectId, project.id); assert.equal(grant.profileId, profile.id);
      assert.equal(grant.workflowId, workflowId); assert.equal(grant.leaseEpoch, beforeEpoch);
      assert.equal(grant.pageId, studio.current().pageId); assert.equal(grant.targetId, studio.current().targetId);
      assert.equal(grant.generation, studio.current().navigationGeneration);
      assert.match(grant.workflowSha256, /^[a-f0-9]{64}$/); assert.match(grant.inputSha256, /^[a-f0-9]{64}$/);
      assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), 120_000);
      assert.deepEqual((await get(grantRoute(authorizationRunId))).grant, grant);
      assert.equal(studio.required().leaseEpoch, beforeEpoch, 'Issuing a start grant must not transfer control');
      stillHuman(); report.issuedGrants++; return grant;
    }

    assert.equal((await request('GET', grantRoute(run.id), undefined, undefined, false)).status, 401);
    assert.equal((await get(grantRoute(run.id))).grant, null);
    assert.equal((await request('POST', grantRoute(run.id), authorizationBody(), randomUUID())).status, 404, 'HTTP cannot mint a start grant');
    await assert.rejects(dispatch('authorizeValidationStart', authorizationBody(), 'api'), /trusted|UI|client|授权/i);
    await rejectJob(validationRoute(run.id), { projectId: project.id, profileId: profile.id, workflowId, leaseEpoch: run.leaseEpoch, input });
    report.rejectedStarts++; stillHuman(); report.checks.push('no-grant-and-no-http-issuance');

    // Exercise the actual React buttons and isolated-preload IPC, not just the
    // equivalent dispatch methods. All injected input stays in the trusted UI.
    const ui = studio.window.window.webContents;
    const evaluateUi = <T>(expression: string): Promise<T> => ui.executeJavaScript(expression, true);
    async function clickUi(label: string) {
      await waitFor(() => evaluateUi<boolean>(`(() => {
        const button=Array.from(document.querySelectorAll('.workspace-panel button')).find(node=>node.textContent.trim()===${JSON.stringify(label)});
        if(!button||button.disabled)return false;
        const rect=button.getBoundingClientRect();if(!rect.width||!rect.height)return false;
        if(button.getAttribute('role')==='tab'){
          button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));
          button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));
        }
        button.click();return true;
      })()`), Boolean, `trusted UI button ${label}`, 12_000);
    }
    await waitFor(() => evaluateUi<string>(`document.querySelector('select[aria-label="项目"]')?.value || ''`), value => value === project.id, 'trusted UI follows synthetic project', 12_000);
    await waitFor(() => evaluateUi<string>(`document.querySelector('.evidence-strip')?.textContent || ''`), value => value.includes(authorizationRunId.slice(0, 12)), 'trusted UI follows authorization run', 12_000);
    await clickUi('执行');
    await waitFor(() => evaluateUi<boolean>(`!!document.querySelector('.panel-content textarea.code-input')`), Boolean, 'trusted workflow input');
    await evaluateUi<void>(`(() => {
      const input=document.querySelector('.panel-content textarea.code-input');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(JSON.stringify(input))});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await clickUi('允许 Agent 启动一次');
    const uiGrant = (await waitFor(() => get(grantRoute(authorizationRunId)), value => Boolean(value.grant), 'grant issued by trusted UI')).grant;
    assert.equal(uiGrant.runId, authorizationRunId); assert.equal(uiGrant.projectId, project.id); assert.equal(uiGrant.workflowId, workflowId);
    report.issuedGrants++; stillHuman();
    await clickUi('撤销启动授权');
    await waitFor(() => get(grantRoute(authorizationRunId)), value => value.grant === null, 'grant revoked by trusted UI');
    stillHuman(); report.checks.push('trusted-ui-issue-and-revoke-through-preload');

    let grant = await authorize();
    assert.equal(grant.inputSha256, uiGrant.inputSha256, 'The JSON entered in the UI must bind the same input as trusted dispatch');
    const page = studio.current(), base = { pageId: page.pageId, generation: page.navigationGeneration, leaseEpoch: grant.leaseEpoch };
    await rejectJob(`/v1/runs/${run.id}/actions`, { ...base, type: 'click', selector: '#increment', startGrantId: grant.grantId });
    await rejectJob(`/v1/runs/${run.id}/control`, { ...base, controller: 'agent', startGrantId: grant.grantId });
    assert.equal(await page.page.$eval('#action-count', element => Number(element.textContent)), 0);
    await assert.rejects(dispatch('revokeValidationStart', { runId: run.id, leaseEpoch: grant.leaseEpoch }, 'api'), /trusted|UI|client|授权/i);
    stillHuman(); report.checks.push('grant-does-not-authorize-actions-or-control');

    for (const [binding, patch] of [
      ['project', { projectId: randomUUID() }], ['profile', { profileId: randomUUID() }],
      ['workflow', { workflowId: 'wrong-synthetic-workflow' }], ['grant', { startGrantId: randomUUID() }],
      ['input', { input: { ...input, label: 'not-authorized' } }],
    ] as const) {
      grant = await authorize();
      await rejectJob(validationRoute(run.id), { ...startBody(grant), ...patch });
      report.rejectedStarts++; stillHuman(); report.checks.push(`reject-${binding}-binding`);
    }
    grant = await authorize();
    await rejectJob(validationRoute(randomUUID()), startBody(grant));
    report.rejectedStarts++; stillHuman(); report.checks.push('reject-run-binding');

    grant = await authorize();
    try {
      await writeFile(path.join(directory, 'run.mjs'), `${script}\n// Synthetic fingerprint change after authorization.\n`);
      await rejectJob(validationRoute(run.id), startBody(grant));
      report.rejectedStarts++; stillHuman(); report.checks.push('reject-workflow-fingerprint-change');
    } finally { await writeFile(path.join(directory, 'run.mjs'), script); }

    grant = await authorize();
    await studio.control('agent'); await studio.control('human');
    assert.ok(studio.required().leaseEpoch > grant.leaseEpoch);
    await rejectJob(validationRoute(run.id), startBody(grant));
    report.rejectedStarts++; stillHuman(); report.checks.push('reject-stale-lease');

    grant = await authorize();
    await studio.navigate(`${siteUrl}/orders?after-grant-navigation=1`);
    await studio.current().page.waitForFunction(() => document.querySelector('#api-state')?.textContent === '已就绪', { timeout: 10_000 });
    assert.ok(studio.current().navigationGeneration > grant.generation);
    assert.equal((await get(grantRoute(run.id))).grant, null);
    await rejectJob(validationRoute(run.id), startBody(grant));
    report.rejectedStarts++; stillHuman(); report.checks.push('reject-changed-page-generation');

    grant = await authorize();
    await dispatch('revokeValidationStart', { runId: run.id, leaseEpoch: grant.leaseEpoch }, 'ui');
    assert.equal((await get(grantRoute(run.id))).grant, null);
    await rejectJob(validationRoute(run.id), startBody(grant));
    report.rejectedStarts++; stillHuman(); report.checks.push('reject-revoked-grant');

    grant = await authorize();
    const beforeCancelEpoch = studio.required().leaseEpoch;
    let queueEntered!: () => void;
    const entered = new Promise<void>(resolve => { queueEntered = resolve; });
    const held = new Promise<void>(resolve => { unblockQueue = resolve; });
    queueBarrier = studio.serialized(async () => { queueEntered(); await held; });
    await entered;
    const cancelledKey = randomUUID();
    const cancelledJobId = await submit(validationRoute(run.id), startBody(grant), cancelledKey);
    report.cancelledJobId = cancelledJobId;
    // The HTTP job is running but its dispatch is still queued behind Studio's
    // barrier. Cancelling it must not invoke stopRunner on the existing run.
    await waitFor(() => get(`/v1/jobs/${cancelledJobId}`), job => job.status === 'running', 'validation dispatch waiting in Studio queue', 5000);
    assert.equal((await request('POST', `/v1/jobs/${cancelledJobId}/cancel`, {})).status, 202);
    assert.equal((await get(grantRoute(run.id))).grant.grantId, grant.grantId, 'Cancellation before dispatch must preserve the unconsumed grant');
    unblockQueue!(); await queueBarrier; unblockQueue = undefined; queueBarrier = undefined;
    const cancelled = await waitJob(cancelledJobId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await submit(validationRoute(run.id), startBody(grant), cancelledKey), cancelledJobId);
    assert.equal((await get(grantRoute(run.id))).grant.grantId, grant.grantId);
    assert.equal(studio.required().leaseEpoch, beforeCancelEpoch, 'Cancelling a queued start must not stop or take over the existing run');
    stillHuman(); report.checks.push('queued-start-cancel-preserves-grant-and-current-run');

    const consumptionBody = { ...startBody(grant), input: { label: input.label, baseUrl: input.baseUrl } }, key = randomUUID();
    const [firstJobId, duplicateJobId, competingJobId] = await Promise.all([
      submit(validationRoute(run.id), consumptionBody, key), submit(validationRoute(run.id), consumptionBody, key),
      submit(validationRoute(run.id), consumptionBody),
    ]);
    assert.equal(firstJobId, duplicateJobId, 'A repeated idempotency key must return the same start job');
    assert.notEqual(firstJobId, competingJobId);
    const jobs = await Promise.all([waitJob(firstJobId), waitJob(competingJobId)]);
    assert.deepEqual(jobs.map(job => job.status).sort(), ['failed', 'succeeded'], 'One grant may start exactly one validation under concurrent requests');
    const accepted = jobs.find(job => job.status === 'succeeded')!.result;
    assert.equal(jobs.find(job => job.status === 'failed')!.error.status, 409);
    report.rejectedStarts++;
    report.validationRunId = accepted.runId; report.validationId = accepted.id;
    assert.notEqual(accepted.runId, run.id, 'Authorized validation gets a new evidence run');
    const validation = await waitFor(() => get(`/v1/validations/${accepted.id}`), value => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) && Boolean(value.artifactId || value.error), 'authorized validation completion');
    assert.equal(validation.status, 'completed', validation.result?.error ?? validation.error);
    assert.equal(validation.result?.validation.overall, 'pass');
    assert.equal(studio.state().validations.length, validationCountBefore + 1);
    assert.equal(studio.required().id, accepted.runId); assert.equal(studio.required().controller, 'human'); assert.equal(studio.required().locked, false);
    assert.equal((await get(grantRoute(accepted.runId))).grant, null);
    report.checks.push('single-consumption-idempotency-canonical-input-and-human-return');

    async function eventsFor(runId: string, types = ['validation-start-grant-issued', 'validation-start-grant-consumed', 'validation-start-grant-applied']) {
      const summary = await get(`/v1/runs/${runId}/summary?maxBytes=8192`);
      const events: any[] = []; let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ types: types.join(','), fields: 'type,data',
          toSequence: String(summary.lastSequence), limit: '30', maxBytes: '8192', ...(cursor ? { cursor } : {}) });
        const batch = await get(`/v1/runs/${runId}/events?${query}`);
        events.push(...batch.items);
        if (!batch.nextCursor) return events;
        assert.notEqual(batch.nextCursor, cursor); cursor = batch.nextCursor;
      }
      throw new Error('Grant evidence exceeded the bounded 100-page audit');
    }
    const originEvents = await eventsFor(run.id), targetEvents = await eventsFor(accepted.runId);
    const issued = originEvents.filter(event => event.type === 'validation-start-grant-issued');
    const consumed = originEvents.filter(event => event.type === 'validation-start-grant-consumed');
    const applied = targetEvents.filter(event => event.type === 'validation-start-grant-applied');
    assert.equal(issued.length, report.issuedGrants); assert.equal(consumed.length, 1); assert.equal(applied.length, 1);
    assert.ok(issued.some(event => event.data.grantId === grant.grantId));
    assert.equal(consumed[0].data.grantId, grant.grantId); assert.equal(consumed[0].data.runId, run.id);
    assert.equal(consumed[0].data.validationRunId, accepted.runId); assert.equal(consumed[0].data.validationId, accepted.id);
    assert.equal(applied[0].data.grantId, grant.grantId); assert.equal(applied[0].data.authorizationRunId, run.id);
    assert.equal(applied[0].data.validationRunId, accepted.runId); assert.equal(applied[0].data.validationId, accepted.id);
    report.consumedGrants = consumed.length; report.checks.push('persisted-authorization-to-validation-link');
    await studio.seal(); if(studio.state().session)await studio.closeSession();

    // The user may authorize an input that fails its workflow schema. Failure
    // after consumption must be recorded and must not make the grant reusable.
    const schemaRun = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/lab`, kind: 'demonstrate' });
    assert.ok(schemaRun);
    const invalidInput = { baseUrl: siteUrl, label: 42 };
    const schemaGrant = await dispatch('authorizeValidationStart', { runId: schemaRun.id, projectId: project.id, profileId: profile.id,
      leaseEpoch: schemaRun.leaseEpoch, input: invalidInput }, 'ui');
    report.issuedGrants++;
    const schemaBody = { ...startBody(schemaGrant), input: invalidInput };
    const schemaJob = await waitJob(await submit(validationRoute(schemaRun.id), schemaBody));
    assert.equal(schemaJob.status, 'failed'); assert.equal(schemaJob.error?.status, 500, 'Public job failures retain the API redaction boundary');
    const schemaConsumption = (await eventsFor(schemaRun.id)).filter(event => event.type === 'validation-start-grant-consumed');
    assert.equal(schemaConsumption.length, 1); assert.equal(schemaConsumption[0].data.grantId, schemaGrant.grantId);
    const schemaValidationRunId = schemaConsumption[0].data.validationRunId as string;
    report.schemaFailureRunId = schemaValidationRunId; report.consumedGrants++;
    assert.equal(studio.required().id, schemaValidationRunId); assert.equal(studio.required().controller, 'human'); assert.equal(studio.required().locked, false);
    assert.equal((await get(grantRoute(schemaValidationRunId))).grant, null);
    const schemaEvents = await eventsFor(schemaValidationRunId, ['validation-start-failed', 'validation-running', 'validation-start-grant-applied']);
    assert.equal(schemaEvents.filter(event => event.type === 'validation-running').length, 0, 'Invalid input cannot reach a worker');
    assert.ok(schemaEvents.some(event => event.type === 'validation-start-failed' && event.data.grantId === schemaGrant.grantId && /Workflow input violates schema/.test(event.data.error)), 'Consumed-grant startup failure must remain explainable in evidence');
    const schemaRunCount = studio.runs.length, schemaValidationCount = studio.state().validations.length;
    await rejectJob(validationRoute(schemaRun.id), schemaBody);
    await rejectJob(validationRoute(schemaValidationRunId), { ...schemaBody, leaseEpoch: studio.required().leaseEpoch });
    report.rejectedStarts += 3;
    assert.equal(studio.runs.length, schemaRunCount); assert.equal(studio.state().validations.length, schemaValidationCount);
    assert.equal((await eventsFor(schemaRun.id)).filter(event => event.type === 'validation-start-grant-consumed').length, 1);
    report.checks.push('schema-failure-recorded-and-consumed-grant-not-reusable');
    await studio.seal(); if(studio.state().session)await studio.closeSession();

    // A source can change while the consumed grant is being persisted. The
    // post-write identity check must run before sealing or starting a worker.
    const changedSourceRun = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/lab`, kind: 'demonstrate' });
    assert.ok(changedSourceRun);
    const changedSourceGrant = await dispatch('authorizeValidationStart', { runId: changedSourceRun.id, projectId: project.id, profileId: profile.id,
      leaseEpoch: changedSourceRun.leaseEpoch, input }, 'ui');
    report.issuedGrants++;
    const changedSource = studio.required(), changedPage = studio.current();
    const originalAppend = changedSource.store.appendEvent;
    const beforeChangeRuns = studio.runs.length, beforeChangeValidations = studio.state().validations.length;
    let advancedGeneration = false;
    changedSource.store.appendEvent = async function(event) {
      const saved = await originalAppend.call(this, event);
      if (event.type === 'validation-start-grant-consumed' && (event.data as { grantId?: string } | undefined)?.grantId === changedSourceGrant.grantId) {
        // Simulate the registered navigation generation changing at the exact
        // asynchronous persistence boundary; no business page is injected.
        changedPage.navigationGeneration++; advancedGeneration = true;
      }
      return saved;
    };
    try {
      await rejectJob(validationRoute(changedSourceRun.id), startBody(changedSourceGrant));
      assert.equal(advancedGeneration, true); report.rejectedStarts++;
      assert.equal(studio.required().id, changedSourceRun.id); assert.equal(studio.required().controller, 'human'); assert.equal(studio.required().locked, false);
      assert.equal(studio.runs.length, beforeChangeRuns); assert.equal(studio.state().validations.length, beforeChangeValidations);
      const changeEvents = await eventsFor(changedSourceRun.id, ['validation-start-grant-consumed', 'validation-start-failed', 'validation-running']);
      assert.equal(changeEvents.filter(event => event.type === 'validation-start-grant-consumed').length, 1);
      assert.equal(changeEvents.filter(event => event.type === 'validation-running').length, 0);
      assert.ok(changeEvents.some(event => event.type === 'validation-start-failed' && event.data.grantId === changedSourceGrant.grantId));
      report.consumedGrants++; report.checks.push('reject-source-generation-change-during-consumption-persistence');
    } finally { changedSource.store.appendEvent = originalAppend; }
    await studio.seal(); if(studio.state().session)await studio.closeSession();

    // Fingerprinting is awaited inside the serialized start operation. The
    // trusted UI must still be able to revoke that grant before consumption.
    const revokeRun = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/lab`, kind: 'demonstrate' });
    assert.ok(revokeRun); const revokeRunId = revokeRun.id;
    const revokeGrant = await dispatch('authorizeValidationStart', { runId: revokeRunId, projectId: project.id, profileId: profile.id,
      leaseEpoch: revokeRun.leaseEpoch, input }, 'ui');
    report.issuedGrants++;
    const beforeRevokeRuns = studio.runs.length, beforeRevokeValidations = studio.state().validations.length;
    // Test-only timing hook on the real binding implementation; its fingerprint
    // and scope result are computed unchanged before awaiting this barrier.
    const bindingOwner = studio as unknown as { grantBinding: (source: ReturnType<Studio['required']>, value: unknown) => Promise<unknown> };
    const originalBinding = bindingOwner.grantBinding;
    let bindingEntered = false, releaseBinding!: () => void;
    const bindingBarrier = new Promise<void>(resolve => { releaseBinding = resolve; });
    let bindingSettlement: Promise<any> | undefined, revokeSettlement: Promise<any> | undefined;
    bindingOwner.grantBinding = async function(source, value) {
      const binding = await originalBinding.call(studio, source, value);
      bindingEntered = true; await bindingBarrier; return binding;
    };
    try {
      const revocableJobId = await submit(validationRoute(revokeRunId), startBody(revokeGrant));
      bindingSettlement = waitJob(revocableJobId); void bindingSettlement.catch(() => {});
      await waitFor(async () => bindingEntered, Boolean, 'validation fingerprinting barrier');
      let revokeFinished = false;
      revokeSettlement = dispatch('revokeValidationStart', { runId: revokeRunId, leaseEpoch: revokeGrant.leaseEpoch }, 'ui')
        .then(value => { revokeFinished = true; return value; }, error => { revokeFinished = true; throw error; });
      void revokeSettlement.catch(() => {});
      await waitFor(async () => revokeFinished, Boolean, 'trusted revocation bypasses the occupied Studio queue', 2000);
      assert.equal((await revokeSettlement).revoked, true);
      releaseBinding();
      const revokedStart = await bindingSettlement;
      assert.equal(revokedStart.status, 'failed'); assert.equal(revokedStart.error?.status, 409); report.rejectedStarts++;
      assert.equal(studio.required().id, revokeRunId); assert.equal(studio.required().controller, 'human'); assert.equal(studio.required().locked, false);
      assert.equal(studio.required().leaseEpoch, revokeGrant.leaseEpoch); assert.equal(studio.required().execution, 'ready');
      assert.equal(studio.runs.length, beforeRevokeRuns); assert.equal(studio.state().validations.length, beforeRevokeValidations);
      assert.equal((await get(grantRoute(revokeRunId))).grant, null);
      const revokeEvents = await eventsFor(revokeRunId, ['validation-start-grant-revoked', 'validation-start-grant-consumed', 'validation-running']);
      assert.equal(revokeEvents.filter(event => event.type === 'validation-start-grant-consumed' || event.type === 'validation-running').length, 0);
      assert.ok(revokeEvents.some(event => event.type === 'validation-start-grant-revoked' && event.data.grantId === revokeGrant.grantId));
      report.checks.push('trusted-revocation-during-awaited-binding-prevents-consumption');
    } finally {
      releaseBinding(); await bindingSettlement?.catch(() => {}); await revokeSettlement?.catch(() => {}); bindingOwner.grantBinding = originalBinding;
    }
    await studio.seal(); if(studio.state().session)await studio.closeSession();

    // Hold the transition after its original run is fully sealed, when active
    // is absent. Cancellation must target this startup rather than require or
    // stop some other active run, and must prevent creation of the next run.
    const transitionRun = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/lab`, kind: 'demonstrate' });
    assert.ok(transitionRun); const transitionRunId = transitionRun.id;
    const transitionGrant = await dispatch('authorizeValidationStart', { runId: transitionRunId, projectId: project.id, profileId: profile.id,
      leaseEpoch: transitionRun.leaseEpoch, input }, 'ui');
    report.issuedGrants++;
    const priorRunCount = studio.runs.length, priorValidationCount = studio.state().validations.length;
    const originalSeal = studio.seal;
    let transitionEntered = false, releaseTransition!: () => void;
    const transitionBarrier = new Promise<void>(resolve => { releaseTransition = resolve; });
    let transitionSettlement: Promise<any> | undefined;
    studio.seal = (async (...args: Parameters<typeof originalSeal>) => {
      const sealingRunId = studio.state().active?.id;
      const result = await originalSeal.apply(studio, args);
      if (sealingRunId === transitionRunId) { transitionEntered = true; await transitionBarrier; }
      return result;
    }) as typeof studio.seal;
    try {
      const transitionJobId = await submit(validationRoute(transitionRunId), startBody(transitionGrant));
      report.cancelledTransitionJobId = transitionJobId;
      transitionSettlement = waitJob(transitionJobId);
      // Observe rejections immediately while the test waits for its barrier.
      void transitionSettlement.catch(() => {});
      await waitFor(async () => transitionEntered, Boolean, 'startup after sealing the old run');
      assert.equal(studio.state().active, null);
      assert.equal((await request('POST', `/v1/jobs/${transitionJobId}/cancel`, {})).status, 202);
      releaseTransition();
      const cancelledTransition = await transitionSettlement;
      assert.equal(cancelledTransition.status, 'cancelled');
      assert.equal(studio.state().active, null, 'Cancellation after seal must not create or activate the planned validation run');
      assert.equal(studio.runs.length, priorRunCount); assert.equal(studio.state().validations.length, priorValidationCount, 'No worker execution may be registered after the cancellation');
      const transitionConsumed = (await eventsFor(transitionRunId)).filter(event => event.type === 'validation-start-grant-consumed');
      assert.equal(transitionConsumed.length, 1); assert.equal(transitionConsumed[0].data.grantId, transitionGrant.grantId);
      assert.ok(!studio.runs.some(candidate => candidate.id === transitionConsumed[0].data.validationRunId));
      report.consumedGrants++; report.checks.push('cancel-after-seal-with-no-active-run-prevents-start');
    } finally { releaseTransition(); await transitionSettlement?.catch(() => {}); studio.seal = originalSeal; }
    report.passed = true;
    console.log('M4 validation-start PASS: trusted grant, bindings, single consumption, cancellation before/after seal, schema failure evidence and human return');
  } finally {
    unblockQueue?.(); await queueBarrier?.catch(() => {});
    if (report.projectId && studio.state().active?.projectId === report.projectId) {
      try { await studio.stopRunner(); await studio.seal(); if(studio.state().session)await studio.closeSession(); } catch { console.error('Validation-start scenario cleanup needs application shutdown'); }
    }
    report.elapsedMs = Math.round(performance.now() - startedAt);
    await writeFile(path.join(studio.root, 'validation-start-result.json'), JSON.stringify(report, null, 2));
  }
}
