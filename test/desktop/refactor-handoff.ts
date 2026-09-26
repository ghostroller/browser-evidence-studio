import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';
import { ArchiveReplayService } from '@/replay/service';
import { SourceModel } from '@/replay/source-model';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(50); }
  throw new Error(`Fixed handoff timed out: ${label}; last=${JSON.stringify(last)}`);
}

/** One trusted preparation followed by a fresh client using only the exported
 * manifest, current-user connection file and public loopback API. */
export async function runRefactorHandoffScenario(studio: Studio, siteUrl: string): Promise<Record<string, unknown>> {
  if (process.env.BES_HANDOFF_LIVE === '1') return runLiveHandoffScenario(studio, siteUrl);
  const report: Record<string, any> = { passed: false, pid: process.pid };
  const dispatch = makeDispatch(studio);
  let authorizationId = '';
  try {
    if (studio.active) await studio.seal();
    if (studio.state().session) await studio.closeSession();
    const directory = path.join(studio.root, 'handoff-business');
    await mkdir(directory);
    await writeFile(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'handoff-business',
      driver: 'puppeteer', entry: './run.mjs', exportName: 'run', requirements: [
        { id: 'observed', checkpointKey: 'observed', description: 'A synthetic result is present', dataset: 'observations' },
      ] }));
    await writeFile(path.join(directory, 'run.mjs'), `export async function run({page,input,reporter}) {
      await page.goto(input.baseUrl + '/lab', {waitUntil:'domcontentloaded'});
      const text = await page.$eval('#lab-result', element => element.textContent);
      await reporter.checkpoint('observed', {title:'Synthetic result'});
      await reporter.emitData('observations', [{text}], {origin:'browser',sourceRefs:[]});
      return {count:1};
    }`);
    const project = await studio.createProject({ name: 'Fixed handoff smoke', objective: 'Discover and execute a fixed task', scriptDirectory: directory });
    const profile = await studio.createProfile({ projectId: project.id, name: 'Handoff synthetic profile' });
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: siteUrl + '/lab' });
    const run = studio.required(), page = studio.current();
    await page.page.waitForSelector('#lab-result'); await page.capture.flush();
    const position = page.capture.recordingPosition; assert.ok(position);
    const source = new SourceModel((await new ArchiveReplayService(studio.reader(run.id).runDir).window(position)).records);
    const node = [...source.nodes.values()].find(item => item.metadata?.attributes.id?.status === 'present' && item.metadata.attributes.id.value === 'lab-result');
    assert.ok(node?.metadata, 'The target exists in the recorded source model');
    const target = { kind: 'dom-node' as const, position, nodeId: node.id, frameId: node.metadata.frameId, mirrorScopeId: node.metadata.mirrorScopeId };
    const draft = await dispatch('createMaterialDraft', { projectId: project.id }, 'ui');
    const edited = await dispatch('editMaterialDraft', { projectId: project.id, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision, edits: [
      { operation: 'recordings', recordingRefs: [run.id] },
      { operation: 'upsert', collection: 'checkpoints', item: { id: 'observed-card', kind: 'requirement', anchor: position,
        capturedAt: new Date().toISOString(), createdAt: new Date().toISOString(), title: 'Synthetic target', notes: '', requirementIds: ['observed'], annotationIds: [] } },
      { operation: 'upsert', collection: 'fields', item: { id: 'result-text', dataset: 'observations', name: 'Result text', description: 'Synthetic public result', outputPath: '/text',
        valueType: 'string', sourcePolicy: 'any-evidenced', checkpointId: 'observed-card', target, bindingStatus: 'bound' } },
      { operation: 'upsert', collection: 'requirements', item: { id: 'observed', description: 'One result from the synthetic lab', dataset: 'observations',
        rules: [{ type: 'min-rows', count: 1 }], fieldIds: ['result-text'] } },
    ] }, 'ui');
    assert.equal(edited.status, 'saved');
    const revision = await dispatch('publishMaterialDraft', { projectId: project.id, draftId: draft.draftId,
      expectedDraftRevision: edited.draft.draftRevision }, 'ui');
    const grant = await dispatch('authorizeTask', { projectId: project.id, profileId: profile.id, sessionId: studio.state().session!.sessionId,
      leaseEpoch: run.leaseEpoch, pageIds: [page.pageId], origins: [new URL(siteUrl).origin],
      capabilities: ['materials-read', 'materials-edit', 'history-read', 'page-read', 'page-act', 'page-create', 'execute', 'results-read', 'handoff-export'],
      durationMs: 300_000, maxOperations: 300 }, 'ui');
    authorizationId = grant.authorizationId;

    // Use the actual React affordance after the trusted client published V1 and
    // issued the grant; the external client never calls an internal dispatcher.
    const ui = studio.window.window.webContents;
    await until(() => ui.executeJavaScript(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='任务授权'&&!item.disabled);if(!button)return false;button.click();return true})()`), Boolean, 'enabled task overlay');
    await until(() => ui.executeJavaScript(`document.querySelector('.overlay-heading')?.textContent?.includes('任务授权与撤销')===true`), Boolean, 'opened task overlay');
    await until(() => ui.executeJavaScript(`(() => ({ready:!![...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent'),project:document.querySelector('select[aria-label="项目"]')?.value,overlay:document.querySelector('.overlay-heading')?.textContent?.slice(0,80),grants:document.querySelectorAll('.task-grant').length,revisions:document.querySelectorAll('select[aria-label="交接资料版本"] option').length}))()`), value => value.ready, 'handoff button');
    await ui.executeJavaScript(`(() => {const select=document.querySelector('select[aria-label="交接资料版本"]');select.value=${JSON.stringify(revision.revisionId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => ui.executeJavaScript(`!![...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent'&&!item.disabled)`), Boolean, 'selected fixed revision');
    assert.equal(await ui.executeJavaScript(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent'&&!item.disabled);if(!button)return false;button.click();return true})()`), true);
    await until(() => ui.executeJavaScript(`!![...document.querySelectorAll('[role="status"]')].find(item=>item.textContent?.includes('固定交接已保存'))`), Boolean, 'saved fixed handoff');
    // The exported task may start while the trusted handoff dialog still
    // occludes the native page. A checkpoint must retain both channels.
    await until(async () => !studio.current().view.getVisible(), Boolean, 'native view hidden by handoff overlay');
    await studio.current().page.goto(siteUrl + '/orders', { waitUntil: 'domcontentloaded' });
    await studio.current().page.waitForSelector('#ssr-data');
    const overlayCheckpoint = await dispatch('checkpoint', { key: 'handoff-overlay-capture', title: 'Handoff overlay capture' }, 'ui');
    assert.equal(overlayCheckpoint.metadata?.artifacts?.[0]?.captureStatus, 'complete', JSON.stringify(overlayCheckpoint.metadata?.artifacts?.[0]));
    assert.equal(overlayCheckpoint.metadata?.artifacts?.[1]?.captureStatus, 'complete', 'Hidden native page DOM should be captured');
    await studio.current().page.goto(siteUrl + '/orders/SYN-001', { waitUntil: 'domcontentloaded' });
    await studio.current().page.waitForSelector('#order-detail');
    const hiddenDetail = await dispatch('checkpoint', { key: 'handoff-hidden-detail', title: 'Hidden detail capture' }, 'ui');
    assert.equal(hiddenDetail.metadata?.artifacts?.[0]?.captureStatus, 'complete', JSON.stringify(hiddenDetail.metadata?.artifacts?.[0]));
    assert.equal(hiddenDetail.metadata?.artifacts?.[1]?.captureStatus, 'complete', 'Hidden detail DOM should be captured');
    await ui.executeJavaScript(`([...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='返回工作台'))?.click()`);
    const handoffs = await readdir(path.join(studio.root, 'projects', project.id, 'handoffs'));
    assert.equal(handoffs.length, 1);
    const handoffDir = path.join(studio.root, 'projects', project.id, 'handoffs', handoffs[0]);
    const task = await readFile(path.join(handoffDir, 'task.md'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(handoffDir, 'manifest.json'), 'utf8'));
    const access = JSON.parse(await readFile(path.join(handoffDir, 'access.json'), 'utf8'));
    assert.equal(manifest.revisionId, revision.revisionId); assert.equal(manifest.contentHash, revision.contentHash);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(access.authorization.authorizationId, authorizationId);
    assert.equal(manifest.taskSha256, createHash('sha256').update(task).digest('hex'));
    assert.equal(manifest.counts.fields, 1); assert.equal(manifest.counts.checkpoints, 1);
    assert.equal(path.basename(access.skillFile), 'SKILL.md');
    assert.match(await readFile(access.skillFile, 'utf8'), /references\/handoff\.md/);
    assert.match(await readFile(path.join(path.dirname(access.skillFile), 'references', 'handoff.md'), 'utf8'), /materialCollection/);
    const connection = JSON.parse(await readFile(access.connectionFile, 'utf8'));
    assert.ok(!task.includes(connection.token) && !JSON.stringify(manifest).includes(connection.token) && !JSON.stringify(access).includes(connection.token));
    async function request(method: string, route: string, body?: Record<string, unknown>): Promise<{ status: number; data: any }> {
      const response = await fetch(connection.address + route, { method, headers: { Authorization: `Bearer ${connection.token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error' });
      const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 32_768 && !text.includes(connection.token));
      return { status: response.status, data: JSON.parse(text) };
    }
    const scoped = (route: string) => `${route}${route.includes('?') ? '&' : '?'}authorizationId=${authorizationId}`;
    async function job(route: string, body: Record<string, unknown>): Promise<any> {
      const submitted = await request('POST', route, { ...body, authorizationId });
      assert.equal(submitted.status, 202, JSON.stringify(submitted.data.error));
      const terminal = await until(async () => (await request('GET', scoped(`/v1/jobs/${submitted.data.jobId}`))).data,
        item => ['succeeded', 'failed', 'cancelled'].includes(item.status), route, 60_000);
      return terminal;
    }
    const health = await request('GET', '/v1/health');
    assert.equal(health.data.instanceId, access.instanceId);
    const capabilities = await request('GET', '/v1/capabilities');
    assert.equal(capabilities.status, 200);
    assert(capabilities.data.operations.some((item: any) => item.operation === 'createPage'));
    const state = await request('GET', scoped('/v1/state'));
    assert.equal(state.status, 200); assert.equal(state.data.active.projectId, manifest.projectId);
    assert.equal(state.data.active.sessionId, grant.sessionId);
    const identity = state.data.active.pages.find((item: any) => item.pageId === grant.pages[0].pageId);
    assert.ok(identity?.targetId && Number.isSafeInteger(identity.generation));
    const livePages = await request('GET', scoped(`/v1/runs/${state.data.active.id}/pages`));
    assert.equal(livePages.status, 200, JSON.stringify(livePages.data.error));
    assert(livePages.data.items.some((item: any) => item.pageId === identity.pageId && item.targetId === identity.targetId));
    const liveSnapshot = await request('GET', scoped(`/v1/runs/${state.data.active.id}/snapshot?pageId=${identity.pageId}&generation=${identity.generation}`));
    assert.equal(liveSnapshot.status, 200, JSON.stringify(liveSnapshot.data.error));
    assert.equal(liveSnapshot.data.pageId, identity.pageId);
    const mismatchedRead = await request('GET', scoped(`/v1/runs/${state.data.active.id}/pages?sessionId=wrong-session`));
    assert.equal(mismatchedRead.status, 409, 'An explicitly wrong read identity remains rejected');
    const fixed = await request('POST', `/v1/projects/${manifest.projectId}/query/materialRevision`, {
      authorizationId, revisionId: manifest.revisionId, contentHash: manifest.contentHash });
    assert.equal(fixed.status, 200); assert.equal(fixed.data.contentHash, revision.contentHash);
    const fields = await request('POST', `/v1/projects/${manifest.projectId}/query/materialCollection`, {
      authorizationId, kind: 'revision', revisionId: manifest.revisionId, contentHash: manifest.contentHash,
      collection: 'fields', limit: 1, maxBytes: 8192 });
    assert.equal(fields.status, 200); assert.equal(fields.data.items[0].id, 'result-text');
    const historical = await request('POST', `/v1/projects/${manifest.projectId}/query/historicalNode`, {
      authorizationId, target: fields.data.items[0].target, limit: 10, maxBytes: 8192 });
    assert.equal(historical.status, 200, JSON.stringify(historical.data.error));
    assert.equal(historical.data.attributes.id.value, 'lab-result');
    const foreign = await request('POST', `/v1/projects/${randomUUID()}/query/materialRevision`, {
      authorizationId, revisionId: manifest.revisionId, contentHash: manifest.contentHash });
    assert.equal(foreign.status, 404);

    const candidate = await job(`/v1/projects/${manifest.projectId}/operations/createMaterialDraft`, { projectId: manifest.projectId, baseRevisionId: manifest.revisionId });
    assert.equal(candidate.status, 'succeeded', JSON.stringify(candidate.error));
    const changed = await job(`/v1/projects/${manifest.projectId}/operations/editMaterialDraft`, { projectId: manifest.projectId,
      draftId: candidate.result.draftId, expectedDraftRevision: candidate.result.draftRevision,
      edits: [{ operation: 'upsert', collection: 'requirements', item: { id: 'observed', description: 'Candidate wording from authorized agent',
        dataset: 'observations', rules: [{ type: 'min-rows', count: 1 }], fieldIds: ['result-text'] } }] });
    assert.equal(changed.status, 'succeeded', JSON.stringify(changed.error));
    const published = await job(`/v1/projects/${manifest.projectId}/operations/publishMaterialDraft`, { projectId: manifest.projectId,
      draftId: candidate.result.draftId, expectedDraftRevision: changed.result.draft.draftRevision });
    assert.equal(published.status, 'succeeded', JSON.stringify(published.error));
    assert.notEqual(published.result.contentHash, manifest.contentHash);
    const diff = await request('POST', `/v1/projects/${manifest.projectId}/query/materialDiff`, { authorizationId,
      fromRevisionId: manifest.revisionId, toRevisionId: published.result.revisionId, limit: 10, maxBytes: 8192 });
    assert.equal(diff.status, 200); assert(diff.data.items.some((item: any) => item.collection === 'requirements' && item.id === 'observed'));
    const changes = await request('POST', `/v1/projects/${manifest.projectId}/query/taskChanges`, { authorizationId, afterSequence: 0, limit: 50, maxBytes: 8192 });
    assert.equal(changes.status, 200); assert(changes.data.items.some((item: any) => item.type === 'material-revision-published'));
    assert.equal(createHash('sha256').update(await readFile(path.join(handoffDir, 'task.md'))).digest('hex'), manifest.taskSha256);

    const base = { projectId: manifest.projectId, profileId: state.data.active.profileId, sessionId: state.data.active.sessionId,
      pageId: identity.pageId, generation: identity.generation, leaseEpoch: state.data.active.leaseEpoch };
    const rejectedOrigin = await job(`/v1/runs/${state.data.active.id}/pages`, { ...base, startUrl: 'https://unauthorized.invalid/' });
    assert.equal(rejectedOrigin.status, 'failed'); assert.equal(rejectedOrigin.error.status, 403);
    const created = await job(`/v1/runs/${state.data.active.id}/pages`, { ...base, startUrl: siteUrl + '/orders' });
    assert.equal(created.status, 'succeeded', JSON.stringify(created.error));
    const background = created.result;
    assert.notEqual(background.pageId, identity.pageId); assert.equal(background.selectedPageId, identity.pageId);
    const afterCreate = await request('GET', scoped('/v1/state'));
    assert.equal(afterCreate.data.active.selectedPageId, identity.pageId);
    assert(afterCreate.data.active.pages.some((item: any) => item.pageId === background.pageId));
    const backgroundBase = { ...base, pageId: background.pageId, generation: background.generation };
    const snapshot = await request('GET', scoped(`/v1/runs/${state.data.active.id}/snapshot?${new URLSearchParams(backgroundBase as any)}`));
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data.error)); assert.equal(snapshot.data.pageId, background.pageId);
    const action = await job(`/v1/runs/${state.data.active.id}/actions`, { ...backgroundBase, type: 'click', selector: '#increment' });
    assert.equal(action.status, 'succeeded', JSON.stringify(action.error));
    const afterAction = await request('GET', scoped(`/v1/runs/${state.data.active.id}/snapshot?${new URLSearchParams(backgroundBase as any)}`));
    assert.equal(afterAction.status, 200);
    assert.equal(afterAction.data.elements.find((item: any) => item.selector === '#action-count')?.text, '1', 'The background target received native mouse input');
    assert.equal((await request('GET', scoped('/v1/state'))).data.active.selectedPageId, identity.pageId);

    const launchState = await request('GET', scoped('/v1/state'));
    const started = await job(`/v1/runs/${launchState.data.active.id}/validations`, { ...base,
      leaseEpoch: launchState.data.active.leaseEpoch, executionMode: 'from-start-validation',
      materialRevisionId: manifest.revisionId, materialContentHash: manifest.contentHash, input: { baseUrl: siteUrl } });
    assert.equal(started.status, 'succeeded', JSON.stringify(started.error));
    const validation = await until(async () => (await request('GET', scoped(`/v1/validations/${started.result.id}`))).data,
      value => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) && Boolean(value.result || value.error), 'trial execution', 60_000);
    assert.equal(validation.status, 'completed', JSON.stringify(validation.error));
    assert.equal(validation.result.validation.overall, 'not-run', 'Trial completion is distinct from source-backed acceptance');
    const summary = await request('POST', `/v1/projects/${manifest.projectId}/query/execution`, { authorizationId, executionId: started.result.id });
    assert.equal(summary.status, 200); assert.equal(summary.data.binding.materialRevisionId, manifest.revisionId);
    report.handoff = { projectId: manifest.projectId, revisionId: manifest.revisionId, contentHash: manifest.contentHash,
      directory: handoffDir, taskSha256: manifest.taskSha256, authorizationId, candidateRevisionId: published.result.revisionId,
      createdPageId: background.pageId, trialExecutionId: started.result.id };
    await dispatch('revokeTask', { projectId: project.id, authorizationId }, 'ui');
    assert.equal((await request('GET', scoped('/v1/state'))).status, 403);
    assert.equal((await request('GET', scoped(`/v1/jobs/${created.id}`))).status, 403);
    assert.equal((await request('POST', `/v1/projects/${manifest.projectId}/query/materialRevision`, {
      authorizationId, revisionId: manifest.revisionId, contentHash: manifest.contentHash })).status, 403);
    await studio.seal(); if (studio.state().session) await studio.closeSession();
    report.passed = true;
    console.log('Q3 HANDOFF PASS: trusted export, fixed discovery, bounded material/history, candidate diff, background page, trial and revocation');
    return report;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    await writeFile(path.join(studio.root, 'refactor-handoff-report.json'), JSON.stringify(report, null, 2));
    if (authorizationId && report.handoff?.projectId) {
      try { if (studio.tasks.get(authorizationId).status === 'active') await dispatch('revokeTask', { projectId: report.handoff.projectId, authorizationId }, 'ui'); } catch { /* preserve original test error */ }
    }
  }
}

/** AT39 preparation. The separate evaluator sees only an installed skill and
 * the exported envelopes; its workflow directory starts empty. */
async function runLiveHandoffScenario(studio: Studio, siteUrl: string): Promise<Record<string, unknown>> {
  const report: Record<string, any> = { passed: false, mode: 'at39-live', pid: process.pid };
  const dispatch = makeDispatch(studio);
  const deadlineMs = 45 * 60_000;
  const nonce = randomUUID();
  const handoffDir = await mkdtemp(path.join(tmpdir(), 'bes-at39-handoff-'));
  const workflowDir = await mkdtemp(path.join(tmpdir(), 'bes-at39-workflow-'));
  const completionFile = path.join(tmpdir(), `bes-at39-complete-${nonce}.json`);
  let authorizationId = '';
  let projectId = '';
  try {
    if (studio.active) await studio.seal();
    if (studio.state().session) await studio.closeSession();
    const project = await studio.createProject({ name: 'AT39 synthetic orders',
      objective: 'Collect every synthetic order and its detail using ordinary Puppeteer. Preserve page completion and prove each image belongs to the same order. Repair a failed assumption before final validation.',
      scriptDirectory: workflowDir });
    projectId = project.id;
    const profile = await studio.createProfile({ projectId, name: 'AT39 synthetic profile' });
    await studio.startRun({ projectId, profileId: profile.id, url: siteUrl + '/orders' });
    const run = studio.required(), page = studio.current();
    await page.page.waitForSelector('#ssr-data');
    await page.capture.flush();
    const position = page.capture.recordingPosition;
    assert.ok(position, 'The list page has a recorded position');
    const draft = await dispatch('createMaterialDraft', { projectId }, 'ui');
    const edited = await dispatch('editMaterialDraft', { projectId, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision,
      edits: [
        { operation: 'recordings', recordingRefs: [run.id] },
        { operation: 'upsert', collection: 'checkpoints', item: { id: 'orders-list', kind: 'requirement', anchor: position,
          capturedAt: new Date().toISOString(), createdAt: new Date().toISOString(), title: 'Synthetic orders list',
          notes: 'Use the visible list and detail pages. API and SSR observations can corroborate; neither alone proves every rendered page was visited.',
          requirementIds: ['all-orders', 'matching-details'], annotationIds: [] } },
        { operation: 'upsert', collection: 'fields', item: { id: 'order-id', dataset: 'orders', name: 'Order ID',
          description: 'Stable synthetic order identity', outputPath: '/id', valueType: 'string', sourcePolicy: 'any-evidenced' } },
        { operation: 'upsert', collection: 'fields', item: { id: 'image-order-id', dataset: 'orders', name: 'Image order ID',
          description: 'Identity displayed by each detail image; must equal its order ID', outputPath: '/imageOrderId', valueType: 'string', sourcePolicy: 'any-evidenced' } },
        { operation: 'upsert', collection: 'requirements', item: { id: 'all-orders', dataset: 'orders',
          description: 'Visit all pages of the synthetic orders list, collect each distinct order and its detail, and show a termination proof for pagination.',
          rules: [{ type: 'min-rows', count: 7 }, { type: 'unique', field: 'id' }, { type: 'pagination-complete', minPages: 3 }], fieldIds: ['order-id'] } },
        { operation: 'upsert', collection: 'requirements', item: { id: 'matching-details', dataset: 'orders',
          description: 'For each order, verify that the detail image identity matches the order ID. A mismatch is a failed result that must be diagnosed and corrected.',
          rules: [{ type: 'required', field: 'imageOrderId' }, { type: 'same-entity', field: 'imageOrderId', equalsField: 'id' }], fieldIds: ['order-id', 'image-order-id'] } },
      ] }, 'ui');
    assert.equal(edited.status, 'saved');
    const revision = await dispatch('publishMaterialDraft', { projectId, draftId: draft.draftId,
      expectedDraftRevision: edited.draft.draftRevision }, 'ui');
    const grant = await dispatch('authorizeTask', { projectId, profileId: profile.id, sessionId: studio.state().session!.sessionId,
      leaseEpoch: run.leaseEpoch, pageIds: [page.pageId], origins: [new URL(siteUrl).origin],
      capabilities: ['materials-read', 'materials-edit', 'history-read', 'page-read', 'page-act', 'page-create', 'execute', 'results-read', 'handoff-export'],
      durationMs: 50 * 60_000, maxOperations: 2000 }, 'ui');
    authorizationId = grant.authorizationId;

    const ui = studio.window.window.webContents;
    await until(() => ui.executeJavaScript(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='任务授权'&&!item.disabled);if(!button)return false;button.click();return true})()`), Boolean, 'enabled task overlay');
    await until(() => ui.executeJavaScript(`document.querySelector('.overlay-heading')?.textContent?.includes('任务授权与撤销')===true`), Boolean, 'opened task overlay');
    await until(() => ui.executeJavaScript(`!![...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent')`), Boolean, 'handoff button');
    await ui.executeJavaScript(`(() => {const select=document.querySelector('select[aria-label="交接资料版本"]');select.value=${JSON.stringify(revision.revisionId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => ui.executeJavaScript(`!![...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent'&&!item.disabled)`), Boolean, 'selected fixed revision');
    assert.equal(await ui.executeJavaScript(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='准备交给 Agent'&&!item.disabled);if(!button)return false;button.click();return true})()`), true);
    await until(() => ui.executeJavaScript(`!![...document.querySelectorAll('[role="status"]')].find(item=>item.textContent?.includes('固定交接已保存'))`), Boolean, 'saved fixed handoff');
    const handoffs = await readdir(path.join(studio.root, 'projects', projectId, 'handoffs'));
    assert.equal(handoffs.length, 1);
    const sourceDir = path.join(studio.root, 'projects', projectId, 'handoffs', handoffs[0]);
    for (const name of ['task.md', 'manifest.json', 'access.json']) await copyFile(path.join(sourceDir, name), path.join(handoffDir, name));
    const task = await readFile(path.join(handoffDir, 'task.md'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(handoffDir, 'manifest.json'), 'utf8'));
    const access = JSON.parse(await readFile(path.join(handoffDir, 'access.json'), 'utf8'));
    assert.equal(manifest.revisionId, revision.revisionId);
    assert.equal(manifest.contentHash, revision.contentHash);
    assert.equal(manifest.taskSha256, createHash('sha256').update(task).digest('hex'));
    assert.equal(access.authorization.authorizationId, authorizationId);
    assert.equal(access.scriptDirectory, workflowDir);
    assert.equal((await readdir(workflowDir)).length, 0, 'Independent workflow directory must start empty');
    assert.equal(path.basename(access.skillFile), 'SKILL.md');
    await stat(access.skillFile);
    const connection = JSON.parse(await readFile(access.connectionFile, 'utf8'));
    assert.ok(!task.includes(connection.token) && !JSON.stringify(manifest).includes(connection.token) && !JSON.stringify(access).includes(connection.token));
    const healthResponse = await fetch(connection.address + '/v1/health', { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).instanceId, access.instanceId);
    const stateResponse = await fetch(connection.address + `/v1/state?authorizationId=${authorizationId}`,
      { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(stateResponse.status, 200);
    assert.equal((await stateResponse.json()).active.projectId, projectId);
    const ready = { schemaVersion: 1, mode: 'at39-live', nonce, projectId, revisionId: revision.revisionId,
      contentHash: revision.contentHash, handoffDir, workflowDir, completionFile, studioPid: process.pid,
      expiresAt: grant.expiresAt, deadlineAt: new Date(Date.now() + deadlineMs).toISOString() };
    await writeFile(path.join(handoffDir, 'ready.json'), JSON.stringify(ready, null, 2), { flag: 'wx' });
    assert.deepEqual((await readdir(handoffDir)).sort(), ['task.md', 'manifest.json', 'access.json', 'ready.json'].sort());
    report.handoff = ready;
    console.log('BES_AT39_READY ' + JSON.stringify(ready));
    const end = Date.now() + deadlineMs;
    for (;;) {
      if (Date.now() >= end) throw new Error('AT39 live handoff timed out without explicit completion signal');
      if (studio.tasks.get(authorizationId).status !== 'active') throw new Error('AT39 task authorization expired or was revoked before completion');
      try {
        const info = await stat(completionFile);
        assert.ok(info.isFile() && info.size <= 2048, 'AT39 completion signal must be a small regular file');
        const signal = JSON.parse(await readFile(completionFile, 'utf8'));
        assert.equal(signal.nonce, nonce, 'AT39 completion nonce differs');
        assert.ok(['completed', 'failed'].includes(signal.status), 'AT39 completion status is invalid');
        report.completion = { status: signal.status, at: new Date().toISOString() };
        if (signal.status === 'failed') throw new Error('AT39 evaluator reported failure');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(500);
    }
    report.passed = true;
    return report;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    if (authorizationId && projectId) {
      try { if (studio.tasks.get(authorizationId).status === 'active') await dispatch('revokeTask', { projectId, authorizationId }, 'ui'); }
      catch (error) { report.cleanupError = String(error); }
    }
    try { if (studio.active) await studio.seal(); if (studio.state().session) await studio.closeSession(); }
    catch (error) { report.cleanupError = String(error); }
    await writeFile(path.join(studio.root, 'at39-live-result.json'), JSON.stringify(report, null, 2));
  }
}
