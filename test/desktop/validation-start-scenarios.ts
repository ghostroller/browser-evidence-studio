import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';

/** Exercise task-scoped HTTP validation against the real Electron worker. */
export async function runValidationStartScenarios(studio: Studio, siteUrl: string): Promise<void> {
  assert.equal(process.env.BES_TEST, '1', 'Validation-start tests use the synthetic desktop site');
  assert.equal(studio.active, undefined, 'The preceding API run must be sealed');
  if (studio.state().session) await studio.closeSession();
  const connection = JSON.parse(await readFile(studio.connection.file, 'utf8'));
  const dispatch = makeDispatch(studio);
  const report = { schemaVersion: 2, passed: false, projectId: '', profileId: '', authorizationRunId: '',
    validationRunId: '', validationId: '', materialRevisionId: '', rejectedStarts: 0, cancelledJobId: '',
    checks: [] as string[], elapsedMs: 0 };
  const startedAt = performance.now();
  let authorizationId: string | undefined;
  let taskScope: { projectId: string; profileId: string; sessionId: string } | undefined;
  let unblockQueue: (() => void) | undefined;
  let queueBarrier: Promise<unknown> | undefined;

  function scopedRoute(route: string): string {
    if (!authorizationId || !taskScope) return route;
    const url = new URL(route, connection.address);
    for (const [key, value] of Object.entries({ authorizationId, ...taskScope })) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  }
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
  async function get(route: string): Promise<any> {
    const reply = await request('GET', scopedRoute(route));
    assert.equal(reply.status, 200, `GET ${route}: ${JSON.stringify(reply.data.error)}`);
    return reply.data;
  }
  async function submit(route: string, body: Record<string, unknown>, key = randomUUID()): Promise<string> {
    const scopedBody = authorizationId && taskScope ? { authorizationId, ...taskScope, ...body } : body;
    const reply = await request('POST', route, scopedBody, key);
    assert.equal(reply.status, 202, `POST ${route}: ${JSON.stringify(reply.data.error)}`);
    assert.equal(reply.data.idempotencyKey, key);
    assert.equal(typeof reply.data.jobId, 'string');
    return reply.data.jobId;
  }
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 40_000): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const value = await read(); if (accept(value)) return value;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const waitJob = (id: string) => waitFor(() => get(`/v1/jobs/${id}`), job => ['succeeded', 'failed', 'cancelled'].includes(job.status), `job ${id}`);
  async function rejectJob(route: string, body: Record<string, unknown>, status: number, code?: string): Promise<any> {
    const job = await waitJob(await submit(route, body));
    assert.equal(job.status, 'failed', JSON.stringify(job.error));
    assert.equal(job.error?.status, status, JSON.stringify(job.error));
    if (code) assert.equal(job.error?.code, code, JSON.stringify(job.error));
    report.rejectedStarts++;
    return job;
  }
  const validationRoute = (runId: string) => `/v1/runs/${runId}/validations`;
  const input = { baseUrl: siteUrl, label: 'synthetic-authorized-input' };

  try {
    const directory = await mkdtemp(path.join(studio.root, 'validation-start-workflow-'));
    const script = `
      export async function run({ page, input, reporter }) {
        await page.goto(input.baseUrl + '/lab', { waitUntil: 'domcontentloaded' });
        const text = await page.$eval('#lab-result', element => element.textContent);
        await reporter.checkpoint('authorized-start', { title: 'Synthetic authorized validation' });
        await reporter.emitData('collected', [{ text, label: input.label }], { origin: 'browser', sourceRefs: [] });
        return { count: 1 };
      }
    `;
    await writeFile(path.join(directory, 'run.mjs'), script);
    await writeFile(path.join(directory, 'input.schema.json'), JSON.stringify({ type: 'object', required: ['baseUrl', 'label'], additionalProperties: false,
      properties: { baseUrl: { type: 'string' }, label: { type: 'string', minLength: 1 } } }));
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'synthetic-authorized-start',
      entry: './run.mjs', exportName: 'run', driver: 'puppeteer', inputSchema: './input.schema.json',
      requirements: [{ id: 'authorized-start', checkpointKey: 'authorized-start', description: 'Synthetic authorized validation',
        dataset: 'collected', rules: [{ type: 'min-rows', count: 1 }, { type: 'required', field: 'text' }, { type: 'required', field: 'label' }] }] }, null, 2));
    const project = await studio.createProject({ name: 'HTTP task validation', objective: 'Scoped task execution and fixed material', scriptDirectory: directory });
    const profile = await studio.createProfile({ projectId: project.id, name: 'Task validation profile' });
    report.projectId = project.id; report.profileId = profile.id;
    const draft = await dispatch('createMaterialDraft', { projectId: project.id }, 'ui');
    const edited = await dispatch('editMaterialDraft', { projectId: project.id, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision,
      edits: [{ operation: 'upsert', collection: 'requirements', item: { id: 'authorized-start', description: 'One synthetic result',
        dataset: 'collected', rules: [{ type: 'min-rows', count: 1 }], fieldIds: [] } }] }, 'ui');
    assert.equal(edited.status, 'saved');
    const revision = await dispatch('publishMaterialDraft', { projectId: project.id, draftId: draft.draftId,
      expectedDraftRevision: edited.draft.draftRevision }, 'ui');
    report.materialRevisionId = revision.revisionId;
    const run = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/orders`, kind: 'demonstrate' });
    assert.ok(run); report.authorizationRunId = run.id;
    const page = studio.current();
    await page.page.waitForFunction(() => document.querySelector('#api-state')?.textContent === '已就绪', { timeout: 10_000 });
    const initialRuns = studio.runs.length, initialValidations = studio.state().validations.length;
    const startBody = () => ({ projectId: project.id, profileId: profile.id, sessionId: studio.state().session!.sessionId,
      pageId: studio.current().pageId, generation: studio.current().navigationGeneration, leaseEpoch: studio.required().leaseEpoch,
      executionMode: 'from-start-validation', materialRevisionId: revision.revisionId, materialContentHash: revision.contentHash, input });
    const unchanged = () => {
      assert.equal(studio.required().id, run.id); assert.equal(studio.runs.length, initialRuns);
      assert.equal(studio.state().validations.length, initialValidations);
    };

    assert.equal((await request('GET', '/v1/state', undefined, undefined, false)).status, 401);
    assert.equal((await request('GET', '/v1/state')).status, 403, 'Bearer alone cannot discover task state');
    assert.equal((await request('GET', `/v1/runs/${run.id}/validation-start-grant`)).status, 404, 'Retired one-time grant route is absent');
    await rejectJob(validationRoute(run.id), startBody(), 403, 'AUTHORIZATION_REQUIRED');
    await rejectJob(validationRoute(run.id), { ...startBody(), startGrantId: randomUUID() }, 403);
    unchanged(); assert.equal(studio.required().controller, 'human');
    report.checks.push('bearer-alone-and-retired-grant-rejected');

    await assert.rejects(dispatch('authorizeTask', { projectId: project.id }, 'api'), /trusted client/i);
    const sessionId = studio.state().session!.sessionId;
    const grant = await dispatch('authorizeTask', { projectId: project.id, profileId: profile.id, sessionId,
      leaseEpoch: studio.required().leaseEpoch, pageIds: [page.pageId], origins: [new URL(siteUrl).origin],
      capabilities: ['execute', 'results-read', 'history-read'], durationMs: 300_000, maxOperations: 1000 }, 'ui');
    authorizationId = grant.authorizationId; taskScope = { projectId: project.id, profileId: profile.id, sessionId };
    assert.equal(grant.status, 'active'); assert.equal(studio.required().controller, 'agent');
    const listed = await request('POST', `/v1/projects/${project.id}/query/taskAuthorizations`, { authorizationId });
    assert.equal(listed.status, 200, JSON.stringify(listed.data.error));
    assert.deepEqual(listed.data.items.map((item: any) => item.authorizationId), [authorizationId]);
    const state = await get('/v1/state');
    assert.equal(state.active.id, run.id); assert.equal(state.active.selectedPageId, page.pageId);
    assert.equal(state.active.pages[0].targetId, page.targetId);
    const foreignProject = await request('GET', scopedRoute(`/v1/projects/${randomUUID()}`));
    assert.equal(foreignProject.status, 403, JSON.stringify(foreignProject.data.error));
    report.checks.push('foreign-project-discovery-rejected');
    const noAction = await rejectJob(`/v1/runs/${run.id}/actions`, { ...startBody(), type: 'click', selector: '#increment' }, 403, 'AUTHORIZATION_SCOPE');
    assert.equal((await request('GET', `/v1/jobs/${noAction.id}`)).status, 403, 'Job result requires its task authorization');
    assert.equal(await page.page.$eval('#action-count', element => Number(element.textContent)), 0);
    unchanged(); report.checks.push('execute-grant-does-not-allow-page-actions');

    for (const [label, patch, status] of [
      ['profile', { profileId: randomUUID() }, 409],
      ['session', { sessionId: randomUUID() }, 409], ['page', { pageId: randomUUID() }, 409],
      ['lease', { leaseEpoch: studio.required().leaseEpoch - 1 }, 409],
      ['origin', { startUrl: 'https://unauthorized.invalid/' }, 403],
      ['generation', { executionMode: 'current-page-test', generation: page.navigationGeneration + 1 }, 409],
    ] as const) {
      await rejectJob(validationRoute(run.id), { ...startBody(), ...patch }, status);
      unchanged(); assert.equal(studio.required().controller, 'agent', `${label} rejection must retain task control`);
      report.checks.push(`reject-${label}-scope`);
    }

    let queueEntered!: () => void;
    const entered = new Promise<void>(resolve => { queueEntered = resolve; });
    const held = new Promise<void>(resolve => { unblockQueue = resolve; });
    queueBarrier = studio.serialized(async () => { queueEntered(); await held; });
    await entered;
    const cancelledKey = randomUUID();
    const cancelledJobId = await submit(validationRoute(run.id), startBody(), cancelledKey);
    report.cancelledJobId = cancelledJobId;
    await waitFor(() => get(`/v1/jobs/${cancelledJobId}`), job => job.status === 'running', 'queued validation dispatch', 5000);
    const cancelledReply = await request('POST', `/v1/jobs/${cancelledJobId}/cancel`, { authorizationId });
    assert.equal(cancelledReply.status, 202, JSON.stringify(cancelledReply.data.error));
    unblockQueue!(); await queueBarrier; unblockQueue = undefined; queueBarrier = undefined;
    assert.equal((await waitJob(cancelledJobId)).status, 'cancelled');
    assert.equal(await submit(validationRoute(run.id), startBody(), cancelledKey), cancelledJobId);
    unchanged(); assert.equal(studio.required().controller, 'agent');
    report.checks.push('queued-start-cancel-and-idempotent-readback');

    // Code may change inside the authorized directory; each start binds its
    // actual code fingerprint, input and immutable material version.
    await writeFile(path.join(directory, 'run.mjs'), `${script}\n// Edited within the authorized task directory.\n`);
    const key = randomUUID(), body = startBody();
    const [firstJobId, duplicateJobId, competingJobId] = await Promise.all([
      submit(validationRoute(run.id), body, key), submit(validationRoute(run.id), body, key), submit(validationRoute(run.id), body),
    ]);
    assert.equal(firstJobId, duplicateJobId, 'Same idempotency key returns the same validation job');
    assert.notEqual(firstJobId, competingJobId);
    const jobs = await Promise.all([waitJob(firstJobId), waitJob(competingJobId)]);
    assert.deepEqual(jobs.map(job => job.status).sort(), ['failed', 'succeeded'], JSON.stringify(jobs.map(job => job.error)));
    assert.equal(jobs.find(job => job.status === 'failed')?.error?.status, 409);
    report.rejectedStarts++;
    const accepted = jobs.find(job => job.status === 'succeeded')!.result;
    assert.notEqual(accepted.runId, run.id, 'Validation has a new evidence run');
    report.validationRunId = accepted.runId; report.validationId = accepted.id;
    const validation = await waitFor(() => get(`/v1/validations/${accepted.id}`), value =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) && Boolean(value.artifactId || value.error),
      'authorized validation completion', 60_000);
    assert.equal(validation.status, 'completed', JSON.stringify(validation.error ?? validation.result?.error));
    assert.equal(validation.result?.validation.overall, 'not-run', 'Worker completion cannot independently approve a fixed material requirement');
    assert.deepEqual(validation.result?.datasetSummaries?.map((item:{datasetId:string;status:string;committedRecords:number})=>({datasetId:item.datasetId,status:item.status,committedRecords:item.committedRecords})),[{datasetId:'collected',status:'complete',committedRecords:1}]);
    const assessmentJob=await waitJob(await submit(`/v1/projects/${project.id}/operations/assessExecution`,{executionId:accepted.id}));
    assert.equal(assessmentJob.status,'succeeded',JSON.stringify(assessmentJob.error));
    const assessment=assessmentJob.result;
    assert.equal(assessment.overall,'inconclusive','Schema-only material and no declared source proof cannot establish business acceptance');
    const assessedRequirements=await request('POST',`/v1/projects/${project.id}/query/executionReportItems`,{authorizationId,executionId:accepted.id,reportId:assessment.reportId,collection:'requirements',limit:10});
    assert.equal(assessedRequirements.status,200,JSON.stringify(assessedRequirements.data.error));
    assert.equal(assessedRequirements.data.items[0]?.schemaVerdict,'pass');
    assert.equal(assessedRequirements.data.items[0]?.sourceVerdict,'inconclusive');
    assert.equal(studio.state().validations.length, initialValidations + 1);
    assert.equal(studio.required().id, accepted.runId);
    assert.equal(studio.required().controller, 'agent', 'Active task retains browser control after execution');
    report.checks.push('fixed-material-execution-and-concurrent-start-exclusion');

    const summary = await get(`/v1/runs/${accepted.runId}/summary?maxBytes=8192`);
    assert.equal(summary.run.id, accepted.runId);
    const events = await get(`/v1/runs/${accepted.runId}/events?types=validation-running&fields=type,data&maxBytes=8192`);
    assert.ok(events.items.some((event: any) => event.type === 'validation-running'), 'Worker start is recorded in the validation run');
    const wrongHashRuns = studio.runs.length, wrongHashValidations = studio.state().validations.length;
    await rejectJob(validationRoute(accepted.runId), { ...startBody(), materialContentHash: '0'.repeat(64) }, 409, 'HASH_MISMATCH');
    assert.equal(studio.runs.length, wrongHashRuns); assert.equal(studio.state().validations.length, wrongHashValidations);
    assert.equal(studio.required().id, accepted.runId, 'Wrong fixed material must not seal the current run');
    report.checks.push('wrong-fixed-material-rejected-before-new-run');

    const revoked = await dispatch('revokeTask', { projectId: project.id, authorizationId }, 'ui');
    assert.equal(revoked.status, 'revoked'); assert.equal(studio.required().controller, 'human');
    const revokedResult = await request('GET', scopedRoute(`/v1/validations/${accepted.id}`));
    assert.equal(revokedResult.status, 403, JSON.stringify(revokedResult.data.error));
    const revokedJob = await request('GET', scopedRoute(`/v1/jobs/${firstJobId}`));
    assert.equal(revokedJob.status, 403, JSON.stringify(revokedJob.data.error));
    report.checks.push('revocation-blocks-results-and-job-readback');
    await studio.seal(); if (studio.state().session) await studio.closeSession();
    report.passed = true;
    console.log('M4 validation-start PASS: scoped task execution, fixed material, bounded job access, cancellation, idempotency and revocation');
  } finally {
    unblockQueue?.(); await queueBarrier?.catch(() => {});
    if (authorizationId && report.projectId) {
      try { if (studio.tasks.get(authorizationId).status === 'active') await dispatch('revokeTask', { projectId: report.projectId, authorizationId }, 'ui'); }
      catch { /* Application shutdown revokes remaining grants. */ }
    }
    if (report.projectId && studio.state().active?.projectId === report.projectId) {
      try { await studio.stopRunner(); await studio.seal(); if (studio.state().session) await studio.closeSession(); }
      catch { console.error('Validation-start scenario cleanup needs application shutdown'); }
    }
    report.elapsedMs = Math.round(performance.now() - startedAt);
    await writeFile(path.join(studio.root, 'validation-start-result.json'), JSON.stringify(report, null, 2));
  }
}
