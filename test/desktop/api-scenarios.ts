import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { runValidationStartScenarios } from './validation-start-scenarios';

interface JsonReply { response: Response; data: any; bytes: number; elapsedMs: number; }
interface Accepted { jobId: string; elapsedMs: number; }
const round = (value: number) => Math.round(value * 100) / 100;

/** Uses the actual Electron API and managed page. The token stays in this closure. */
export async function runApiScenarios(studio: Studio, siteUrl: string): Promise<void> {
  assert.equal(studio.active, undefined, 'API scenarios require the preceding run to be sealed');
  if(studio.state().session)await studio.closeSession();
  assert.equal(typeof studio.connection?.file, 'string');
  const connection = JSON.parse(await readFile(studio.connection.file, 'utf8'));
  assert.ok(typeof connection.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(connection.token), 'Current instance connection token is required');
  assert.ok(typeof connection.address === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(connection.address));
  assert.equal(connection.address, studio.connection.address);
  assert.equal(connection.processId, process.pid);
  const started = performance.now();
  // Keep this report deliberately limited to numbers and generated identifiers.
  const report = { schemaVersion: 1, passed: 0, elapsedMs: 0, projectId: '', profileId: '', runId: '', pageId: '', checkpointId: '',
    artifactIds: [] as string[], jobIds: [] as string[], submitMs: [] as number[], completedJobs: 0, rejectedJobs: 0,
    snapshotBytes: 0, summaryBytes: 0, artifactBytes: 0, artifactContinuationBytes: 0, screenshotBytes: 0,
    slowSubmitMs: 0, slowJobMs: 0, actionCount: 0, fillVerified: 0 };
  let ownedRunId: string | undefined;
  let authorizationId: string | undefined;
  let taskScope: { projectId: string; profileId: string; sessionId: string } | undefined;

  function scopedRoute(route: string): string {
    if (!authorizationId || !taskScope) return route;
    const url = new URL(route, connection.address);
    for (const [key, value] of Object.entries({ authorizationId, ...taskScope })) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  }

  function assertJsonHeaders(response: Response): void {
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const policy = response.headers.get('content-security-policy')?.split(';').map(value => value.trim()) || [];
    for (const directive of ["default-src 'none'", 'sandbox', "frame-ancestors 'none'"]) assert.ok(policy.includes(directive));
  }
  async function request(method: string, route: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<JsonReply> {
    const at = performance.now();
    const response = await fetch(connection.address + route, {
      method, headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    const text = await response.text(), bytes = Buffer.byteLength(text);
    assert.ok(bytes <= 32768, 'HTTP JSON envelope must remain within 32 KiB');
    assert.ok(!text.includes(connection.token), 'The API must not echo its bearer token');
    assertJsonHeaders(response);
    return { response, data: JSON.parse(text), bytes, elapsedMs: round(performance.now() - at) };
  }
  async function get(route: string, maxBytes?: number): Promise<JsonReply> {
    const reply = await request('GET', scopedRoute(route));
    assert.equal(reply.response.status, 200, `GET ${route.split('?')[0]} must succeed: ${JSON.stringify(reply.data.error)}`);
    if (maxBytes !== undefined) {
      assert.ok(reply.bytes <= maxBytes, `Entire response must fit the ${maxBytes}-byte caller budget`);
      if (reply.data.responseBytes !== undefined) assert.equal(reply.data.responseBytes, reply.bytes);
    }
    return reply;
  }
  async function submit(route: string, body: Record<string, unknown>, key = randomUUID()): Promise<Accepted> {
    const scopedBody = authorizationId && taskScope ? { authorizationId, ...taskScope, ...body } : body;
    const reply = await request('POST', route, scopedBody, { 'Idempotency-Key': key });
    assert.equal(reply.response.status, 202, `POST ${route} must acknowledge a job: ${JSON.stringify(reply.data.error)}`);
    assert.ok(typeof reply.data.jobId === 'string' && /^[a-f0-9-]{36}$/.test(reply.data.jobId));
    assert.equal(reply.data.idempotencyKey, key);
    assert.ok(['queued', 'running', 'succeeded', 'failed'].includes(reply.data.status));
    assert.ok(reply.elapsedMs < 5000, 'Job acceptance must return before the HTTP request timeout');
    report.jobIds.push(reply.data.jobId); report.submitMs.push(reply.elapsedMs);
    return { jobId: reply.data.jobId, elapsedMs: reply.elapsedMs };
  }
  async function job(accepted: Accepted, expected: 'succeeded' | 'failed' = 'succeeded', errorStatus = 409): Promise<any> {
    const deadline = performance.now() + 40_000;
    for (let polls = 0; polls < 200 && performance.now() < deadline; polls++) {
      const { data } = await get(`/v1/jobs/${accepted.jobId}`);
      assert.equal(data.id, accepted.jobId);
      assert.ok(['queued', 'running', 'waiting-human', 'succeeded', 'failed', 'cancelled'].includes(data.status));
      if (['succeeded', 'failed', 'cancelled'].includes(data.status)) {
        assert.equal(data.status, expected, `Job ${accepted.jobId} reached the wrong terminal state: ${JSON.stringify(data.error)}`);
        if (expected === 'failed') { assert.equal(data.error?.status, errorStatus, `Job ${accepted.jobId}: ${JSON.stringify(data.error)}`); report.rejectedJobs++; }
        else { assert.equal(data.error, undefined); report.completedJobs++; }
        return data;
      }
      await delay(100);
    }
    throw new Error(`API job ${accepted.jobId} did not settle within the bounded poll window; presentation=${JSON.stringify(studio.window.presentationStatus())}`);
  }

  try {
    assert.equal((await request('GET', '/v1/health', undefined, { Authorization: '' })).response.status, 401);
    assert.equal((await request('GET', '/v1/health', undefined, { Origin: 'https://untrusted.example' })).response.status, 403);
    await get('/v1/health');
    await job(await submit('/v1/projects', { name: 'HTTP 不得创建项目' }), 'failed', 403);
    const project = await studio.createProject({ name: 'HTTP 合成验收', objective: '真实 HTTP 作业、控制权与有界证据读取' });
    report.projectId = project.id;
    await job(await submit(`/v1/projects/${project.id}/profiles`, { name: 'HTTP 不得创建 profile' }), 'failed', 403);
    const profile = await studio.createProfile({ projectId: project.id, name: 'HTTP 独立合成 profile' });
    report.profileId = profile.id;
    await job(await submit('/v1/runs', { projectId: project.id, profileId: profile.id, url: `${siteUrl}/orders` }), 'failed', 403);
    const run = await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/orders` });
    assert.ok(run);
    ownedRunId = run.id; report.runId = run.id;
    assert.equal(run.controller, 'human');
    const managed = studio.current();
    await managed.page.waitForFunction(() => document.querySelector('#api-state')?.textContent === '已就绪', { timeout: 10_000 });
    const actionRoute = `/v1/runs/${run.id}/actions`;
    const base = { pageId: managed.pageId, generation: managed.navigationGeneration, leaseEpoch: run.leaseEpoch };
    const count = () => managed.page.$eval('#action-count', element => Number(element.textContent));
    assert.equal(await count(), 0);
    await job(await submit(actionRoute, { ...base, type: 'click', selector: '#increment' }), 'failed');
    await job(await submit(`/v1/runs/${run.id}/control`, { ...base, controller: 'agent' }), 'failed', 403);
    assert.equal(studio.required().controller, 'human'); assert.equal(await count(), 0);

    // Only the trusted client can establish the scoped task and browser lease.
    const sessionId = studio.state().session!.sessionId;
    const grant = await studio.authorizeTask({ projectId: project.id, profileId: profile.id, sessionId, leaseEpoch: run.leaseEpoch,
      pageIds: [managed.pageId], origins: [new URL(siteUrl).origin], capabilities: ['page-read', 'page-act', 'history-read'],
      durationMs: 180_000, maxOperations: 1000 });
    authorizationId = grant.authorizationId;
    taskScope = { projectId: project.id, profileId: profile.id, sessionId };
    assert.equal(grant.status, 'active');
    assert.equal((await request('GET', '/v1/state')).response.status, 403, 'A bearer alone cannot discover task state');
    const foreignProject = await request('GET', scopedRoute(`/v1/projects/${randomUUID()}`));
    assert.equal(foreignProject.response.status, 403, JSON.stringify(foreignProject.data.error));
    const scopedProjects = await get('/v1/projects');
    assert.deepEqual(scopedProjects.data.items.map((item: any) => item.id), [project.id]);
    const { data: pages } = await get(`/v1/runs/${run.id}/pages`);
    const page = pages.items.find((value: any) => value.pageId === run.selectedPageId);
    assert.ok(page); assert.equal(page.pageId, managed.pageId); assert.equal(page.targetId, managed.targetId);
    report.pageId = page.pageId;
    await job(await submit(`/v1/runs/${run.id}/control`, { ...base, controller: 'human' }), 'failed', 403);
    await job(await submit(`/v1/runs/${run.id}/seal`, { leaseEpoch: studio.required().leaseEpoch }), 'failed', 403);
    const { data: currentState } = await get('/v1/state');
    assert.equal(currentState.active.id, run.id);
    assert.equal(currentState.active.controller, 'agent');
    base.leaseEpoch = currentState.active.leaseEpoch;
    const clickBody = { ...base, type: 'click', selector: '#increment' }, clickKey = randomUUID();
    const click = await submit(actionRoute, clickBody, clickKey);
    const duplicate = await submit(actionRoute, { selector: '#increment', type: 'click', ...base }, clickKey);
    assert.equal(duplicate.jobId, click.jobId);
    const clickJob = await job(click);
    assert.equal(typeof clickJob.result.commandId, 'string');
    assert.equal(await count(), 1, 'Repeating an accepted idempotency key must perform one click');
    const missingJobGrant = await request('GET', `/v1/jobs/${click.jobId}`);
    assert.equal(missingJobGrant.response.status, 403, 'Job identity alone must not disclose a task result');
    const conflict = await request('POST', actionRoute, { authorizationId, ...taskScope, ...clickBody, selector: '#next' }, { 'Idempotency-Key': clickKey });
    assert.equal(conflict.response.status, 409); assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');

    const invalidActions = [
      { route: actionRoute, body: { ...clickBody, leaseEpoch: base.leaseEpoch - 1 } },
      { route: actionRoute, body: { ...clickBody, pageId: randomUUID() } },
      { route: actionRoute, body: { ...clickBody, generation: base.generation + 1 } },
      { route: `/v1/runs/${randomUUID()}/actions`, body: clickBody },
    ];
    for (const invalid of invalidActions) {
      await job(await submit(invalid.route, invalid.body), 'failed');
      assert.equal(await count(), 1, 'Rejected run/page/generation/lease must not touch the managed page');
    }
    const foreignOrigin = await job(await submit(actionRoute, { ...base, type: 'navigate', url: 'https://unauthorized.invalid/' }), 'failed', 403);
    assert.equal(foreignOrigin.error.code, 'AUTHORIZATION_ORIGIN');
    assert.equal(await count(), 1, 'Rejected navigation origin must not touch the managed page');
    assert.equal(await managed.page.$eval('#page-label', element => element.textContent), '第 1 页');
    await job(await submit(actionRoute, { ...base, type: 'fill', selector: '#filter', value: 'synthetic-check' }));
    assert.equal(await managed.page.$eval('#filter', element => (element as HTMLInputElement).value), 'synthetic-check', 'Agent-owned HTTP fill must reach the real page through Puppeteer typing');
    report.fillVerified = 1;

    const identityQuery = new URLSearchParams({ pageId: page.pageId, generation: String(page.generation) });
    const snapshot = await get(`/v1/runs/${run.id}/snapshot?${identityQuery}&maxBytes=1024`, 1024);
    assert.equal(snapshot.data.pageId, page.pageId); assert.equal(snapshot.data.generation, page.generation);
    assert.ok(Array.isArray(snapshot.data.elements)); report.snapshotBytes = snapshot.bytes;
    assert.equal((await request('GET', scopedRoute(`/v1/runs/${run.id}/snapshot?maxBytes=1024`))).response.status, 409);
    assert.equal((await request('GET', scopedRoute(`/v1/runs/${run.id}/snapshot?pageId=${page.pageId}&generation=${page.generation + 1}`))).response.status, 409);
    const checkpoint = (await job(await submit(`/v1/runs/${run.id}/checkpoints`, { ...base, key: 'http-orders', title: 'HTTP 精确页面保存点', requirementIds: ['http-click-once'] }))).result;
    assert.equal(checkpoint.pageId, page.pageId); assert.equal(checkpoint.navigationGeneration, page.generation);
    assert.equal(checkpoint.captureConsistency, 'consistent'); assert.equal(checkpoint.artifactRefs.length, 2);
    report.checkpointId = checkpoint.id; report.artifactIds = checkpoint.artifactRefs;
    const checkpointIndex = await get(`/v1/runs/${run.id}/checkpoints?maxBytes=2048&fields=key,pageId,artifactRefs`, 2048);
    assert.ok(checkpointIndex.data.items.some((value: any) => value.id === checkpoint.id));
    const summary = await get(`/v1/runs/${run.id}/summary?maxBytes=2048`, 2048);
    assert.equal(summary.data.run.id, run.id); report.summaryBytes = summary.bytes;
    const events = await get(`/v1/runs/${run.id}/events?maxBytes=2048&types=command&fields=type,pageId,data.type`, 2048);
    assert.equal(events.data.items.length, 2, 'Only the accepted unique click and fill may create commands');
    assert.deepEqual(events.data.items.map((value: any) => value['data.type']), ['click', 'fill']);
    assert.ok(events.data.items.every((value: any) => value.pageId === page.pageId));

    const artifacts = checkpoint.metadata.artifacts as Array<{ id: string; kind: string; captureStatus: string; capturedBytes: number }>;
    const dom = artifacts.find(value => value.kind === 'dom'), screenshot = artifacts.find(value => value.kind === 'screenshot');
    assert.ok(dom); assert.ok(screenshot); assert.equal(dom.captureStatus, 'complete'); assert.equal(screenshot.captureStatus, 'complete');
    const artifactRoute = `/v1/runs/${run.id}/artifacts/${dom.id}`;
    const fragment = await get(`${artifactRoute}?maxBytes=2048`, 2048);
    assert.equal(fragment.data.artifact.id, dom.id); assert.equal(fragment.data.byteOffset, 0);
    assert.equal(fragment.data.outputTruncated, true); assert.ok(fragment.data.nextCursor); assert.ok(fragment.data.text.length > 0);
    const continuation = await get(`${artifactRoute}?maxBytes=2048&cursor=${encodeURIComponent(fragment.data.nextCursor)}`, 2048);
    assert.equal(continuation.data.byteOffset, fragment.data.readBytes); assert.ok(continuation.data.readBytes > 0);
    assert.doesNotMatch(fragment.data.text + continuation.data.text, /\uFFFD/);
    report.artifactBytes = fragment.bytes; report.artifactContinuationBytes = continuation.bytes;
    const binaryMetadata = await get(`/v1/runs/${run.id}/artifacts/${screenshot.id}?maxBytes=2048`, 2048);
    assert.equal(binaryMetadata.data.bodyStatus, 'binary'); assert.equal(binaryMetadata.data.text, undefined);
    const screenshotContent = await fetch(`${connection.address}${scopedRoute(`/v1/runs/${run.id}/artifacts/${screenshot.id}/content`)}`, {
      headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    assert.equal(screenshotContent.status, 403, 'Ordinary Agent history cannot read unredacted checkpoint pixels');
    assert.equal((await screenshotContent.json()).error?.code, 'invalid_request');
    for (const artifact of [dom]) {
      const response: Response = await fetch(`${connection.address}${scopedRoute(`/v1/runs/${run.id}/artifacts/${artifact.id}/content`)}`, {
        headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/html');
      assert.equal(response.headers.get('content-disposition'), 'attachment'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const policy = response.headers.get('content-security-policy')?.split(';').map(value => value.trim()) || [];
      assert.ok(policy.includes("default-src 'none'")); assert.ok(policy.includes('sandbox'));
      const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, artifact.capturedBytes);
      assert.match(bytes.toString('utf8'), /^<!doctype html>/i);
    }
    report.actionCount = await count(); assert.equal(report.actionCount, 1);

    // The real browser navigation remains pending while HTTP accepts and exposes the job.
    const slowStarted = performance.now();
    const slow = await submit(actionRoute, { ...base, type: 'navigate', url: `${siteUrl}/slow?ms=3000` });
    report.slowSubmitMs = slow.elapsedMs;
    assert.ok(slow.elapsedMs < 2500, '202 acceptance must not wait for the three-second navigation');
    const pending = await get(`/v1/jobs/${slow.jobId}`);
    assert.ok(['queued', 'running'].includes(pending.data.status), 'Long browser work must be observable before completion');
    await job(slow); report.slowJobMs = round(performance.now() - slowStarted);
    assert.ok(report.slowJobMs >= 2500);
    const sealed = await studio.seal();
    assert.equal(sealed.status, 'sealed'); assert.equal(studio.active, undefined);
    const sealedSummary = await get(`/v1/runs/${run.id}/summary?maxBytes=2048`, 2048);
    assert.equal(sealedSummary.data.run.status, 'sealed');
    const revoked = await studio.revokeTask({ projectId: project.id, authorizationId });
    assert.equal(revoked.status, 'revoked');
    const revokedHistory = await request('GET', scopedRoute(`/v1/runs/${run.id}/summary?maxBytes=2048`));
    assert.equal(revokedHistory.response.status, 403, JSON.stringify(revokedHistory.data.error));
    assert.equal(revokedHistory.data.error.code, 'AUTHORIZATION_REVOKED');
    const revokedJob = await request('GET', scopedRoute(`/v1/jobs/${click.jobId}`));
    assert.equal(revokedJob.response.status, 403, JSON.stringify(revokedJob.data.error));
    await studio.closeSession();
    report.passed = 1;
    console.log(`M4 HTTP PASS: ${report.completedJobs} completed jobs, ${report.rejectedJobs} ownership/identity rejections; 202 slow-navigation acceptance ${report.slowSubmitMs} ms`);
  } finally {
    // On a failed assertion, avoid leaving this test's browser lease alive for shutdown.
    if (ownedRunId && studio.state().active?.id === ownedRunId) {
      try { await studio.stopRunner(); await studio.seal(); if(studio.state().session)await studio.closeSession(); } catch { console.error('API scenario cleanup did not finish; application shutdown must finish the run'); }
    }
    report.elapsedMs = round(performance.now() - started);
    await writeFile(path.join(studio.root, 'api-result.json'), JSON.stringify(report, null, 2));
  }
  await runValidationStartScenarios(studio, siteUrl);
}
