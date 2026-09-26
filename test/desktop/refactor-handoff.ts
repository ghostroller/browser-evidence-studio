import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
    await ui.executeJavaScript(`([...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='返回工作台'))?.click()`);
    const handoffs = await readdir(path.join(studio.root, 'projects', project.id, 'handoffs'));
    assert.equal(handoffs.length, 1);
    const handoffDir = path.join(studio.root, 'projects', project.id, 'handoffs', handoffs[0]);
    const task = await readFile(path.join(handoffDir, 'task.md'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(handoffDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.revisionId, revision.revisionId); assert.equal(manifest.contentHash, revision.contentHash);
    assert.equal(manifest.authorization.authorizationId, authorizationId);
    assert.equal(manifest.taskSha256, createHash('sha256').update(task).digest('hex'));
    assert.equal(manifest.fields[0].id, 'result-text'); assert.equal(manifest.checkpoints[0].anchor.recordingId, run.id);
    const connection = JSON.parse(await readFile(manifest.connectionFile, 'utf8'));
    assert.ok(!task.includes(connection.token) && !JSON.stringify(manifest).includes(connection.token));
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
    assert.equal(health.data.instanceId, manifest.instanceId);
    const capabilities = await request('GET', '/v1/capabilities');
    assert.equal(capabilities.status, 200);
    assert(capabilities.data.operations.some((item: any) => item.operation === 'createPage'));
    const state = await request('GET', scoped('/v1/state'));
    assert.equal(state.status, 200); assert.equal(state.data.active.projectId, manifest.projectId);
    assert.equal(state.data.active.sessionId, grant.sessionId);
    const identity = state.data.active.pages.find((item: any) => item.pageId === grant.pages[0].pageId);
    assert.ok(identity?.targetId && Number.isSafeInteger(identity.generation));
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
