import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { makeDispatch } from '@/main/services/dispatch';
import type { Artifact, QueryPage } from '@/evidence/contracts';
import type { EvidenceReader } from '@/evidence/reader';
import { clickSyntheticHuman as nativeFixtureClick } from './native-input';

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(60);
  }
  throw new Error(`Lifecycle scenario timed out: ${label}`);
}

async function pages(read: (cursor?: string) => Promise<QueryPage>): Promise<any[]> {
  const results: unknown[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 30; count++) {
    const page = await read(cursor);
    results.push(...page.items);
    if (!page.nextCursor) return results;
    assert.notEqual(page.nextCursor, cursor, 'Bounded evidence cursor must advance');
    cursor = page.nextCursor;
  }
  throw new Error('The short lifecycle fixture exceeded its bounded 30-page evidence budget');
}

async function eventRecords(reader: EvidenceReader, types: string[]): Promise<any[]> {
  return pages(cursor => reader.events({ cursor, types, limit: 100, maxBytes: 32768, fields: ['type', 'pageId', 'data', 'artifactRefs'] }));
}

async function responseArtifact(studio: Studio, url: string): Promise<Artifact> {
  const run = studio.required(), reader = studio.reader(run.id);
  const found = await waitFor<any>(async () => {
    await Promise.all([...run.pages.values()].map(page => page.capture.flush()));
    const artifacts = await pages(cursor => reader.artifacts({ cursor, limit: 100, maxBytes: 32768, fields: ['kind', 'source', 'captureStatus', 'capturedBytes'] }));
    return artifacts.find(artifact => artifact.kind === 'response-body' && artifact.source?.url === url);
  }, Boolean, `persisted response body for ${new URL(url).pathname}`);
  return reader.artifactMetadata(found.id);
}

async function rrwebRecords(runDir: string): Promise<any[]> {
  const directory = path.join(runDir, 'raw', 'rrweb'), records: unknown[] = [];
  let bytes = 0;
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const stream = createReadStream(path.join(directory, name));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line);
        assert.ok(bytes < 16 * 1024 * 1024, 'Short iframe scenario must not produce a recursively expanding rrweb recording');
        if (!line) continue;
        const raw = JSON.parse(line), payload = raw.payload ?? raw.data ?? raw;
        if (payload.event) records.push(payload);
      }
    } finally { lines.close(); stream.destroy(); }
  }
  return records;
}

async function action(studio: Studio, body: Record<string, unknown>): Promise<void> {
  const run = studio.required(), page = studio.current();
  await studio.action({ ...body, pageId: page.pageId, leaseEpoch: run.leaseEpoch, generation: page.navigationGeneration });
}

async function storageState(studio: Studio): Promise<any> {
  const page = studio.current().page;
  await page.waitForFunction(() => Boolean((window as any).__storageResult), { timeout: 10_000 });
  return page.evaluate(() => (window as any).__storageResult);
}

function assertStoredAccount(value: any): void {
  assert.equal(value.session.authenticated, true, 'Persisted cookie must be verified by the synthetic server');
  assert.equal(value.session.accountId, 'fake-account-001');
  assert.equal(value.localStorageAccount, 'fake-account-001');
  assert.equal(value.indexedDbAccount, 'fake-account-001');
}

interface RestartState {
  schemaVersion: 1;
  projectId: string;
  profileId: string;
  isolatedProfileId: string;
  siteOrigin: string;
  fixturePort: number;
  originalProcessId: number;
  savedAt: string;
  restartStatus: 'not-run' | 'passed';
  restartProcessId?: number;
  restartVerifiedAt?: string;
}

/**
 * First phase, called by the real Electron harness with the existing fixture.
 * All browser writes use managed actions or explicit native synthetic input.
 */
export async function runLifecycleScenarios(studio: Studio, siteUrl: string): Promise<void> {
  if (studio.active) await studio.seal();
  const origin = new URL(siteUrl).origin;
  const project = await studio.createProject({ name: '页面身份和 profile 生命周期', objective: '合成 popup、frame、证据预算、持久状态及崩溃验收' });
  const profile = await studio.createProfile({ projectId: project.id, name: '持久状态 A' });
  await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${origin}/orders` });
  const run = studio.required(), parent = studio.current(), dispatch = makeDispatch(studio);
  await parent.page.waitForFunction(() => document.querySelector('#api-state')?.textContent === '已就绪');

  const beforeClicks = await parent.page.$eval('#action-count', element => element.textContent);
  await parent.capture.inspect(true);
  await nativeFixtureClick(studio, '#increment');
  await waitFor(() => run.selection as any, selection => selection?.element?.selectors?.includes('#increment'), 'element inspection persisted');
  assert.equal(await parent.page.$eval('#action-count', element => element.textContent), beforeClicks, 'Inspection click must not execute the site click handler');
  assert.equal((run.selection as any).pageId, parent.pageId);
  await studio.control('agent');
  const racingAction = Promise.allSettled([studio.action({ type: 'click', selector: '#increment', pageId: parent.pageId, leaseEpoch: run.leaseEpoch })]);
  await studio.stopRunner();
  assert.equal((await racingAction)[0].status, 'rejected', 'Takeover must revoke a still-connecting operation before it can click');
  assert.equal(run.controller, 'human');
  assert.equal(await parent.page.$eval('#action-count', element => element.textContent), beforeClicks);
  await studio.control('agent');
  await action(studio, { type: 'click', selector: '#increment' });
  assert.equal(await parent.page.$eval('#action-count', element => element.textContent), '1');

  await action(studio, { type: 'click', selector: '#open-popup' });
  const child = await waitFor(() => [...run.pages.values()].find(page => page.pageId !== parent.pageId), Boolean, 'business popup registration');
  assert.ok(child);
  await child.page.waitForSelector('#popup-button');
  assert.equal(child.openerPageId, parent.pageId);
  assert.notEqual(child.targetId, parent.targetId);
  assert.notEqual(child.webContentsId, studio.window.window.webContents.id);
  await dispatch('selectPage', { pageId: child.pageId }, 'ui');
  await action(studio, { type: 'click', selector: '#popup-button' });
  assert.equal(await child.page.$eval('#popup-count', element => element.textContent), '1', 'Operation transport must reconnect to the selected popup target');
  await dispatch('selectPage', { pageId: parent.pageId }, 'ui');
  await action(studio, { type: 'click', selector: '#increment' });
  assert.equal(await parent.page.$eval('#action-count', element => element.textContent), '2');
  await dispatch('selectPage', { pageId: child.pageId }, 'ui');
  await action(studio, { type: 'click', selector: '#popup-button' });
  const popupContents=child.view.webContents,popupOperation=run.operation;
  assert.equal(popupOperation?.targetId,child.targetId);
  assert.ok(popupOperation);
  const closingLease=run.leaseEpoch;
  // Exercise the site's real close path through the currently authorized native
  // Puppeteer transport. Closing its own target may reject the last CDP reply.
  await Promise.allSettled([popupOperation.page.evaluate(()=>window.close())]);
  await waitFor(()=>!run.pages.has(child.pageId),Boolean,'closed popup removed from registry');
  await Promise.allSettled([...(run.pageClosures??[])]);
  assert.equal(popupContents.isDestroyed(),true);
  assert.equal(run.selectedPageId,parent.pageId,'Closing the selected popup restores its live opener');
  assert.ok(run.leaseEpoch>closingLease,'Closing the selected target invalidates its operation lease');
  assert.equal(run.operation,undefined,'Closed target operation connection must be revoked');
  assert.equal(run.pendingOperation,undefined);
  assert.equal(studio.window.window.contentView.children.includes(child.view),false,'Destroyed popup view must leave the native view tree');
  assert.equal(studio.state().active?.pages.some(page=>page.pageId===child.pageId),false,'State queries must never dereference or return the destroyed WebContents');
  const closed=await eventRecords(studio.reader(run.id),['page-closed']);
  assert.ok(closed.some(event=>event.pageId===child.pageId&&event.data.targetId===child.targetId&&event.data.operationRevoked===true),'Closure evidence preserves page/target identity and operation revocation');
  await assert.rejects(dispatch('selectPage',{pageId:child.pageId},'ui'),/Unknown page/);
  await action(studio,{type:'click',selector:'#increment'});
  assert.equal(await parent.page.$eval('#action-count',element=>element.textContent),'3','Parent operations continue after popup self-close');
  console.log('M0/M2 lifecycle PASS: inspection, popup/opener identities, self-close cleanup and subsequent parent operation');

  await action(studio, { type: 'navigate', url: `${origin}/iframe` });
  await parent.page.waitForFunction(() => Boolean((document.querySelector('#same-origin-frame') as HTMLIFrameElement)?.contentDocument?.querySelector('#frame-button')));
  await delay(350);
  await studio.pauseCapture(true);
  await studio.pauseCapture(false);
  assert.equal(studio.required().capture, 'recording', 'Resuming with an iframe must request only ready main-document recorders');
  await parent.capture.flush();
  const raw = await rrwebRecords(run.store.runDir);
  const topFrames = raw.filter(record => record.pageId === parent.pageId && record.navigationGeneration === parent.navigationGeneration);
  assert.ok(topFrames.some(record => record.event.type === 2), 'The iframe-containing top document needs a persisted full rrweb snapshot');
  assert.ok(raw.every(record => record.isTop === true), 'Only top-document recorder streams may be saved; nested independent rrweb snapshots would corrupt playback');
  assert.ok(topFrames.length < 500, 'A single static iframe must not recursively inflate recording');
  const replay = await studio.replay({ runId: run.id, pageId: parent.pageId });
  const replaySources = (await rrwebRecords(run.store.runDir)).filter(record => record.pageId === parent.pageId && record.isTop);
  const parentEventSet = new Set(replaySources.map(record => JSON.stringify(record.event)));
  assert.ok(replay.events.length > 0 && replay.events.length <= replaySources.length);
  assert.ok(replay.events.every(event => parentEventSet.has(JSON.stringify(event))), 'Replay must include only the requested business page top-document stream');
  assert.equal(parent.capture.health, 'recording');

  await action(studio, { type: 'navigate', url: `${origin}/lab` });
  for (const bytes of [1024 * 1024, 9 * 1024 * 1024]) {
    await action(studio, { type: 'click', selector: `[data-fetch="/api/large?bytes=${bytes}"]` });
    await parent.page.waitForFunction(expected => {
      try { return JSON.parse(document.querySelector('#lab-result')?.textContent || '{}').bytes === expected; } catch { return false; }
    }, {}, bytes);
    const artifact = await responseArtifact(studio, `${origin}/api/large?bytes=${bytes}`);
    assert.equal(artifact.captureStatus, bytes > 8 * 1024 * 1024 ? 'truncated' : 'complete');
    assert.equal(artifact.capturedBytes, Math.min(bytes, 8 * 1024 * 1024));
    if (bytes > 8 * 1024 * 1024) assert.equal(artifact.originalBytes, bytes);
    else assert.equal((await studio.reader(run.id).artifact(artifact.id, { jsonPath: '$.tailMarker', maxBytes: 1024 })).value, 'END');
  }
  await action(studio, { type: 'click', selector: '[data-fetch="/redirect"]' });
  await parent.page.waitForFunction(() => {
    try { return new URL(JSON.parse(document.querySelector('#lab-result')?.textContent || '{}').url).pathname === '/orders'; } catch { return false; }
  });
  await parent.capture.flush();
  const redirects = (await eventRecords(studio.reader(run.id), ['network-redirect'])).filter(event => event.pageId === parent.pageId && /\/redirect(?:-final)?$/.test(event.data.response.url));
  assert.equal(redirects.length, 2, 'Both HTTP redirect hops must remain visible');
  const first = redirects.find(event => event.data.response.url === `${origin}/redirect`)!;
  const second = redirects.find(event => event.data.response.url === `${origin}/redirect-final`)!;
  assert.equal(first.data.nextRequestKey, second.data.requestKey);
  assert.notEqual(first.data.requestKey, second.data.nextRequestKey);
  const finalArtifacts = await pages(cursor => studio.reader(run.id).artifacts({ cursor, limit: 100, maxBytes: 32768, fields: ['kind', 'source', 'captureStatus'] }));
  assert.ok(finalArtifacts.some(artifact => artifact.kind === 'response-body' && artifact.source?.requestKey === second.data.nextRequestKey && artifact.captureStatus === 'complete'), 'Final response body must retain the final redirect hop identity');
  console.log('M1/M2 lifecycle PASS: iframe recorder bounded; 1 MiB JSON complete; 9 MiB JSON explicitly truncated at 8 MiB; redirect hop identities linked');

  await action(studio, { type: 'navigate', url: `${origin}/login` });
  await studio.control('human');
  await parent.page.waitForFunction(() => !(document.querySelector('#confirm-login') as HTMLButtonElement)?.disabled);
  await nativeFixtureClick(studio, '#confirm-login');
  await parent.page.waitForSelector('#login-status[data-authenticated="true"]');
  const saved = await studio.saveProfile();
  assert.equal(saved.loginStatus, 'unknown', 'Saving storage alone must not become a permanent verified-login claim');
  await studio.navigate(`${origin}/storage`);
  assertStoredAccount(await storageState(studio));
  await studio.seal();

  await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${origin}/storage` });
  assertStoredAccount(await storageState(studio));
  await studio.seal();
  const isolated = await studio.createProfile({ projectId: project.id, name: '隔离状态 B' });
  await studio.startRun({ projectId: project.id, profileId: isolated.id, url: `${origin}/storage` });
  const isolatedState = await storageState(studio);
  assert.equal(isolatedState.session.authenticated, false);
  assert.equal(isolatedState.localStorageAccount, null);
  assert.equal(isolatedState.indexedDbAccount, null);
  const restart: RestartState = { schemaVersion: 1, projectId: project.id, profileId: profile.id, isolatedProfileId: isolated.id, siteOrigin: origin, fixturePort: Number(new URL(origin).port), originalProcessId: process.pid, savedAt: new Date().toISOString(), restartStatus: 'not-run' };
  await writeFile(path.join(studio.root, 'profile-restart-state.json'), JSON.stringify(restart, null, 2));
  console.log('M3 lifecycle PASS: named profile survives a new run; another profile is isolated. Separate process restart remains explicitly not-run.');

  const crashed = studio.current(), crashedRun = studio.required();
  const gone = new Promise<void>(resolve => crashed.view.webContents.once('render-process-gone', () => resolve()));
  crashed.view.webContents.forcefullyCrashRenderer();
  await Promise.race([gone, delay(10_000).then(() => { throw new Error('Renderer crash did not report a lifecycle event'); })]);
  await waitFor(() => crashedRun.capture, capture => capture === 'degraded', 'crash capture health');
  const manifest = await studio.seal();
  assert.equal(manifest.status, 'sealed', 'A crashed renderer must still permit durable evidence sealing');
  const crashGaps = await eventRecords(studio.reader(crashedRun.id), ['gap']);
  assert.ok(crashGaps.some(event => /render-process-gone|capture CDP disconnected/.test(event.data.reason)));
  console.log('M0/M6 lifecycle PASS: renderer crash marks degraded, preserves explicit gap, and still seals evidence');
}

/**
 * Optional second-process phase. The harness must reopen the SAME BES_DATA and
 * restart the synthetic fixture on state.fixturePort before calling this.
 * This function is deliberately not invoked by the first phase.
 */
export async function runProfileRestartScenarios(studio: Studio, siteUrl: string): Promise<void> {
  const statePath = path.join(studio.root, 'profile-restart-state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8')) as RestartState;
  assert.equal(saved.schemaVersion, 1);
  assert.notEqual(process.pid, saved.originalProcessId, 'Restart verification must execute in a different Electron process');
  assert.equal(new URL(siteUrl).origin, saved.siteOrigin, 'Storage is scoped to the original fixture origin, including its port');
  if (studio.active) await studio.seal();
  await studio.startRun({ projectId: saved.projectId, profileId: saved.profileId, url: `${saved.siteOrigin}/storage` });
  assertStoredAccount(await storageState(studio));
  await studio.seal();
  await studio.startRun({ projectId: saved.projectId, profileId: saved.isolatedProfileId, url: `${saved.siteOrigin}/storage` });
  const isolated = await storageState(studio);
  assert.equal(isolated.session.authenticated, false);
  assert.equal(isolated.localStorageAccount, null);
  assert.equal(isolated.indexedDbAccount, null);
  await studio.seal();
  await writeFile(statePath, JSON.stringify({ ...saved, restartStatus: 'passed', restartProcessId: process.pid, restartVerifiedAt: new Date().toISOString() }, null, 2));
  console.log('M3 profile restart PASS: persistent cookie/localStorage/IndexedDB survive a different Electron process; isolated profile stays empty');
}
