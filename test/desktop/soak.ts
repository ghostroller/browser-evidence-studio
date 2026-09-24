import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, powerMonitor } from 'electron';
import type { Metrics } from 'puppeteer-core';
import type { Studio } from '@/main/services/studio';
import type { EvidenceReader } from '@/evidence/reader';
import { safeFile } from '@/evidence/files';
import { buildSoakEvidenceSnapshot } from './soak-evidence';

const KiB = 1024, MiB = KiB * KiB;
const limits = { checkpointP95Ms: 2000, summaryP95Ms: 500, httpSubmitP95Ms: 300, mainRssBytes: 1024 * MiB, pagePrivateBytes: 512 * MiB };
const round = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], fraction = .95) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
interface ExpectedAction { sequence: number; commandId: string; selector: string; }
interface ExpectedRequest { sequence: string; url: string; bytes: number; sha256: string; }
interface MemorySample {
  elapsedMs: number; main: NodeJS.MemoryUsage; pageProcessId: number; pagePrivateBytes: number | null; pageWorkingSetBytes: number | null; browserPage: Metrics;
  windowVisible: boolean; windowFocused: boolean; browserViewVisible: boolean; systemIdleSeconds: number; systemIdleStateAt60Seconds: 'active' | 'idle' | 'locked' | 'unknown';
}

async function* events(reader: EvidenceReader, types: string[]) {
  let cursor: string | undefined;
  do {
    const result = await reader.events({ types, cursor, limit: 200, maxBytes: 32768, fields: ['type', 'pageId', 'data', 'artifactRefs'] });
    assert.ok(result.responseBytes <= 32768);
    for (const item of result.items as any[]) { assert.equal(item.readStatus, undefined, 'Projected evidence must fit its explicit budget'); yield item; }
    cursor = result.nextCursor;
  } while (cursor);
}

async function verifyExpected(reader: EvidenceReader, pageId: string, actions: ExpectedAction[], requests: ExpectedRequest[]) {
  const commands = new Map(actions.map(item => [item.commandId, item])), selectors = new Map(actions.map(item => [item.selector, item]));
  const expected = new Map(requests.map(item => [item.url, item]));
  const commandCounts = new Map<string, number>(), actionCounts = new Map<string, number>(), requestCounts = new Map<string, number>();
  const requestKeys = new Map<string, string>(), responses = new Map<string, { count: number; url: string }>(), bodies = new Map<string, { count: number; artifactId: string; url: string }>();
  let unexpectedActions = 0, unexpectedRequests = 0;
  for await (const event of events(reader, ['command', 'action', 'network-request', 'network-response', 'network-body'])) {
    if (event.pageId !== pageId) continue;
    const data = event.data;
    if (event.type === 'command' && data.type === 'click') {
      const wanted = commands.get(data.commandId);
      assert.ok(wanted, 'Every persisted click command must have a completed synthetic action');
      assert.equal(data.selector, wanted.selector);
      commandCounts.set(data.commandId, (commandCounts.get(data.commandId) || 0) + 1);
    } else if (event.type === 'action' && data.action === 'click') {
      const selector = data.element?.selectors?.find((value: string) => selectors.has(value));
      if (!selector) unexpectedActions++;
      else actionCounts.set(selector, (actionCounts.get(selector) || 0) + 1);
    } else if (event.type === 'network-request') {
      const url = data.request?.url;
      if (typeof url !== 'string' || new URL(url).pathname !== '/api/soak') continue;
      if (!expected.has(url)) { unexpectedRequests++; continue; }
      assert.equal(data.request.method, 'GET');
      assert.ok(typeof data.requestKey === 'string' && !requestKeys.has(data.requestKey));
      requestKeys.set(data.requestKey, url); requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
    } else if (event.type === 'network-response' && typeof data.response?.url === 'string' && expected.has(data.response.url)) {
      assert.equal(data.response.status, 200);
      responses.set(data.requestKey, { count: (responses.get(data.requestKey)?.count || 0) + 1, url: data.response.url });
    } else if (event.type === 'network-body' && expected.has(data.url)) {
      assert.equal(event.artifactRefs.length, 1);
      const previous = bodies.get(data.requestKey);
      bodies.set(data.requestKey, { count: (previous?.count || 0) + 1, artifactId: event.artifactRefs[0], url: data.url });
    }
  }
  assert.equal(unexpectedActions, 0); assert.equal(unexpectedRequests, 0);
  for (const action of actions) { assert.equal(commandCounts.get(action.commandId), 1, `Persisted command ${action.sequence}`); assert.equal(actionCounts.get(action.selector), 1, `Observed click ${action.sequence}`); }
  const verified: Array<{ sequence: string; requestKey: string; artifactId: string; bytes: number; sha256: string }> = [];
  for (const [requestKey, url] of requestKeys) {
    const wanted = expected.get(url)!;
    assert.equal(requestCounts.get(url), 1, `Unique request ${wanted.sequence}`);
    assert.equal(responses.get(requestKey)?.count, 1, `Unique response ${wanted.sequence}`);
    assert.equal(responses.get(requestKey)?.url, url, `Response identity ${wanted.sequence}`);
    const body = bodies.get(requestKey); assert.equal(body?.count, 1, `Unique body ${wanted.sequence}`); assert.ok(body);
    assert.equal(body.url, url, `Body event identity ${wanted.sequence}`);
    const artifact = await reader.artifactMetadata(body.artifactId);
    assert.equal(artifact.kind, 'response-body'); assert.equal(artifact.captureStatus, 'complete');
    assert.equal((artifact.source as any)?.requestKey, requestKey); assert.equal((artifact.source as any)?.url, url);
    assert.equal(artifact.capturedBytes, wanted.bytes); assert.equal(artifact.originalBytes, wanted.bytes); assert.equal(artifact.sha256, wanted.sha256); assert.ok(artifact.path);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(await safeFile(reader.runDir, artifact.path))) { hash.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, wanted.bytes); assert.equal(hash.digest('hex'), wanted.sha256);
    verified.push({ sequence: wanted.sequence, requestKey, artifactId: artifact.id, bytes, sha256: wanted.sha256 });
  }
  assert.equal(requestKeys.size, requests.length); assert.equal(responses.size, requests.length); assert.equal(bodies.size, requests.length);
  return { actions: actions.length, requests: requests.length, verifiedResponseBytes: verified.reduce((sum, item) => sum + item.bytes, 0), responseDigests: verified };
}

function memoryReport(samples: MemorySample[]) {
  const fields = { mainRssBytes: (sample: MemorySample) => sample.main.rss, mainHeapUsedBytes: (sample: MemorySample) => sample.main.heapUsed,
    pagePrivateBytes: (sample: MemorySample) => sample.pagePrivateBytes, pageJsHeapUsedBytes: (sample: MemorySample) => sample.browserPage.JSHeapUsedSize ?? null };
  const windows = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 60]].map(([from, to]) => ({ fromMinute: from, toMinute: to,
    sampleCount: samples.filter(sample => sample.elapsedMs >= from * 60000 && sample.elapsedMs < to * 60000).length,
    metrics: Object.fromEntries(Object.entries(fields).map(([key, read]) => {
      const values = samples.filter(sample => sample.elapsedMs >= from * 60000 && sample.elapsedMs < to * 60000).map(read).filter((value): value is number => value !== null);
      return [key, { minimum: values.length ? Math.min(...values) : null, median: percentile(values, .5), maximum: values.length ? Math.max(...values) : null }];
    })) }));
  const slopes = Object.fromEntries(Object.entries(fields).map(([key, read]) => {
    const values = samples.filter(sample => sample.elapsedMs >= 5 * 60000).flatMap(sample => { const y = read(sample); return y === null ? [] : [{ x: sample.elapsedMs / 60000, y }]; });
    const meanX = values.reduce((sum, item) => sum + item.x, 0) / values.length, meanY = values.reduce((sum, item) => sum + item.y, 0) / values.length;
    const denominator = values.reduce((sum, item) => sum + (item.x - meanX) ** 2, 0);
    return [key, values.length < 2 || !denominator ? null : round(values.reduce((sum, item) => sum + (item.x - meanX) * (item.y - meanY), 0) / denominator)];
  }));
  return { samples, windows, postWarmupSlopeBytesPerMinute: slopes,
    protection: { mainRssBytes: limits.mainRssBytes, pagePrivateBytes: limits.pagePrivateBytes, pagePrivateAvailable: samples.every(sample => sample.pagePrivateBytes !== null),
      withinLimits: samples.every(sample => sample.main.rss <= limits.mainRssBytes && (sample.pagePrivateBytes === null || sample.pagePrivateBytes <= limits.pagePrivateBytes)) },
    interpretation: 'Fixed-load observations and predeclared process protection limits only; no unbounded-duration or leak-free verdict. Main memory includes fixture server and test harness. Electron process memory KiB is converted to bytes. Slopes omit the first five minutes.' };
}

/** A fixed synthetic workload. One-minute runs are mechanism preflights, never long-run acceptance. */
export async function runSoak(studio: Studio, url: string, minutes: number) {
  assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 60);
  if (studio.active) await studio.seal();
  const actions: ExpectedAction[] = [], requests: ExpectedRequest[] = [], checkpointIds: string[] = [], samples: MemorySample[] = [];
  const checkpointMs: number[] = [], checkpointCaptureTimestampMs: number[] = [], summaryMs: number[] = [], submitMs: number[] = [], summaryBytes: number[] = [];
  const stageMs: Record<string, number[]> = { click: [], pageAck: [], regularFetch: [], largeFetch: [], checkpoint: [], captureFlush: [], summary: [], memory: [], fieldRead: [] };
  const slowCycles: Array<{ slot: number; cycle: number; elapsedMs: number; workMs: number; visibility: string; focused: boolean; stages: Record<string, number> }> = [];
  const missedSlots: Array<{ expectedSlot: number; resumedSlot: number; elapsedMs: number; previousCycle?: (typeof slowCycles)[number] }> = [];
  const measure = async <T>(name: string, work: () => Promise<T>, cycle?: Record<string, number>): Promise<T> => {
    const at = performance.now();
    try { return await work(); }
    finally { const elapsed = round(performance.now() - at); stageMs[name].push(elapsed); if (cycle) cycle[name] = elapsed; }
  };
  const report: any = { schemaVersion: 2, processId: process.pid, runId: '', minutes, elapsedMs: 0, passed: false, status: 'starting', checkpointIds,
    qualification: minutes >= 30 ? '30-minute-or-longer-fixed-load' : minutes >= 20 ? '20-minute-fixed-load' : 'mechanism-preflight-only',
    load: { cadenceMs: 1000, plannedCycles: Math.ceil(minutes * 60), regularResponseBytes: 64 * KiB, largeResponseBytes: MiB, largeEveryMs: 60000, checkpointEveryMs: 60000, summaryEveryMs: 10000, domTickMs: 100, skippedScheduleSlots: 0, completedCycles: 0, maxCycleWorkMs: 0, cyclesOverCadence: 0 },
    thresholds: limits, expected: { actions, requests }, limitations: ['UI first-visible-feedback latency is not measured.', 'Memory protection limits are not a leak-free or indefinite-growth acceptance criterion.', 'Evidence completeness is limited to acknowledged synthetic actions and responses in this run.'] };
  const powerEvents: Array<{ event: string; at: string; elapsedMs: number | null }> = [];
  report.powerEvents = { items: powerEvents, dropped: 0 };
  const save = async (status: string) => {
    report.status = status;
    report.performance = { checkpointDurableAcknowledgementMs: checkpointMs, checkpointCaptureTimestampMs, summaryMs, httpSubmitMs: submitMs, summaryBytes,
      checkpointP95Ms: percentile(checkpointMs), summaryP95Ms: percentile(summaryMs), httpSubmitP95Ms: percentile(submitMs),
      stageTimings: Object.fromEntries(Object.entries(stageMs).map(([name, values]) => [name, { count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values), maxMs: values.length ? Math.max(...values) : null }])),
      slowCycles, missedSlots,
      checkpointTiming: 'Client POST start through succeeded job response: includes HTTP, queue, durable completion and up to 50 ms polling delay. Stored captureStartedAt/savedAt timestamps are supplementary, not a durable completion clock.' };
    report.memory = memoryReport(samples);
    for (const file of ['soak-result.json', 'soak-progress.json']) {
      const destination = path.join(studio.root, file), temporary = destination + '.tmp';
      await writeFile(temporary, JSON.stringify(report, null, file === 'soak-result.json' ? 2 : undefined)); await rename(temporary, destination);
    }
  };
  let started: number | undefined, startedMonotonic: number | undefined;
  const recordPowerEvent = (event: string) => {
    if (powerEvents.length < 32) powerEvents.push({ event, at: new Date().toISOString(), elapsedMs: startedMonotonic === undefined ? null : round(performance.now() - startedMonotonic) });
    else report.powerEvents.dropped++;
  };
  const onLock = () => recordPowerEvent('lock-screen'), onUnlock = () => recordPowerEvent('unlock-screen');
  const onSuspend = () => recordPowerEvent('suspend'), onResume = () => recordPowerEvent('resume');
  powerMonitor.on('lock-screen', onLock); powerMonitor.on('unlock-screen', onUnlock);
  powerMonitor.on('suspend', onSuspend); powerMonitor.on('resume', onResume);
  try {
    const project = await studio.createProject({ name: '固定合成长录制验证', objective: '唯一动作和请求、原件完整性、HTTP 性能和进程内存观察' });
    const profile = await studio.createProfile({ projectId: project.id, name: '独立合成长录制' });
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: url + '/soak' });
    const run = studio.required(), page = studio.current(); report.runId = run.id;
    await studio.control('agent');
    studio.window.window.setTitle('Browser Evidence Studio — 合成长录制自动验证，请勿手动导航');
    const connection = JSON.parse(await readFile(studio.connection.file, 'utf8'));
    assert.equal(connection.processId, process.pid); assert.equal(connection.address, studio.connection.address);
    const request = async (method: string, route: string, body?: unknown) => {
      const at = performance.now();
      const response = await fetch(connection.address + route, { method, headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
      const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 32768); assert.ok(!text.includes(connection.token));
      return { status: response.status, data: JSON.parse(text), bytes: Buffer.byteLength(text), elapsedMs: performance.now() - at };
    };
    const checkpoint = async (key: string) => {
      const at = performance.now(), submitted = await request('POST', `/v1/runs/${run.id}/checkpoints`, { key, title: key, runId: run.id, pageId: page.pageId, generation: page.navigationGeneration, leaseEpoch: run.leaseEpoch });
      submitMs.push(round(submitted.elapsedMs)); assert.equal(submitted.status, 202); assert.equal(typeof submitted.data.jobId, 'string');
      while (performance.now() - at < 30000) {
        const reply = await request('GET', `/v1/jobs/${submitted.data.jobId}`); assert.equal(reply.status, 200);
        if (['succeeded', 'failed', 'cancelled'].includes(reply.data.status)) {
          assert.equal(reply.data.status, 'succeeded'); const captured = reply.data.result;
          assert.equal(captured.metadata.captureStatus, 'complete'); assert.equal(captured.metadata.captureOutcome, 'completed'); assert.equal(captured.captureConsistency, 'consistent');
          assert.equal(captured.pageId, page.pageId); assert.equal(captured.artifactRefs.length, 2);
          checkpointIds.push(captured.id); checkpointCaptureTimestampMs.push(Date.parse(captured.savedAt) - Date.parse(captured.captureStartedAt)); checkpointMs.push(round(performance.now() - at)); return;
        }
        await delay(50);
      }
      throw new Error('Synthetic checkpoint job did not settle within 30 seconds');
    };
    const summary = async () => {
      const reply = await request('GET', `/v1/runs/${run.id}/summary?maxBytes=8192`);
      assert.equal(reply.status, 200); assert.equal(reply.data.run.id, run.id); assert.equal(reply.bytes, reply.data.responseBytes); assert.ok(reply.bytes <= 8192);
      summaryMs.push(round(reply.elapsedMs)); summaryBytes.push(reply.bytes);
    };
    const memory = async () => {
      const pageProcessId = page.view.webContents.getOSProcessId(), metric = app.getAppMetrics().find(item => item.pid === pageProcessId);
      const sample: MemorySample = { elapsedMs: performance.now() - startedMonotonic!, main: process.memoryUsage(), pageProcessId,
        pagePrivateBytes: metric?.memory.privateBytes === undefined ? null : metric.memory.privateBytes * KiB,
        pageWorkingSetBytes: metric?.memory.workingSetSize === undefined ? null : metric.memory.workingSetSize * KiB, browserPage: await page.page.metrics(),
        windowVisible: studio.window.window.isVisible(), windowFocused: studio.window.window.isFocused(), browserViewVisible: page.view.getVisible(),
        systemIdleSeconds: powerMonitor.getSystemIdleTime(), systemIdleStateAt60Seconds: powerMonitor.getSystemIdleState(60) };
      samples.push(sample);
      assert.ok(sample.main.rss <= limits.mainRssBytes, 'Main RSS exceeds predeclared 1 GiB protection limit');
      assert.ok(sample.pagePrivateBytes === null || sample.pagePrivateBytes <= limits.pagePrivateBytes, 'Page private bytes exceed predeclared 512 MiB protection limit');
    };
    const fetchPayload = async (sequence: string, bytes: number) => {
      const requestUrl = `${url}/api/soak?runId=${run.id}&sequence=${sequence}&bytes=${bytes}`;
      const acknowledged = await run.operation!.page.evaluate(async ({ requestUrl, runId, sequence, bytes }) => {
        const response = await fetch(requestUrl), text = await response.text(), data = JSON.parse(text), encoded = new TextEncoder().encode(text);
        if (response.status !== 200 || data.runId !== runId || data.sequence !== sequence || data.tailMarker !== 'SOAK-END' || encoded.byteLength !== bytes) throw new Error('Synthetic response did not match the requested identity and byte size');
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))).map(value => value.toString(16).padStart(2, '0')).join('');
        return { bytes: encoded.byteLength, sha256 };
      }, { requestUrl, runId: run.id, sequence, bytes });
      requests.push({ sequence, url: requestUrl, ...acknowledged });
    };
    let firstArtifactId: string | undefined;
    const fieldRead = async (phase: string) => {
      if (!firstArtifactId) {
        for await (const event of events(studio.reader(run.id), ['network-body'])) if (event.data.url === requests[0].url) { firstArtifactId = event.artifactRefs[0]; break; }
        assert.ok(firstArtifactId, 'The first acknowledged response must be readable after flush');
      }
      const reply = await request('GET', `/v1/runs/${run.id}/artifacts/${firstArtifactId}?jsonPath=%2FtailMarker&maxBytes=1024`);
      assert.equal(reply.status, 200); assert.equal(reply.data.pathStatus, 'present'); assert.equal(reply.data.value, 'SOAK-END'); assert.equal(reply.data.outputTruncated, false); assert.ok(reply.bytes <= 1024);
      (report.fieldReads ||= []).push({ phase, artifactId: firstArtifactId, maxBytes: 1024, responseBytes: reply.bytes, elapsedMs: round(reply.elapsedMs), value: reply.data.value });
    };
    started = Date.now(); startedMonotonic = performance.now(); report.startedAt = new Date(started).toISOString(); await save('running');
    const durationMs = minutes * 60000; let slot = 0, nextCheckpoint = 0, nextSummary = 0;
    let previousCycle: (typeof slowCycles)[number] | undefined;
    const loadElapsed = () => performance.now() - startedMonotonic!;
    while (loadElapsed() < durationMs) {
      const due = startedMonotonic + slot * 1000; if (due >= startedMonotonic + durationMs) break;
      await delay(Math.max(1, due - performance.now()));
      if (loadElapsed() >= durationMs) break;
      const currentSlot = Math.floor(loadElapsed() / 1000);
      if (currentSlot > slot) { report.load.skippedScheduleSlots += currentSlot - slot; missedSlots.push({ expectedSlot: slot, resumedSlot: currentSlot, elapsedMs: round(loadElapsed()), previousCycle }); slot = currentSlot; }
      const cycleAt = performance.now();
      const cycleStages: Record<string, number> = {};
      assert.equal(run.controller, 'agent', 'Stop if a human takes ownership'); assert.equal(studio.current().pageId, page.pageId); assert.equal(new URL(page.page.url()).origin, new URL(url).origin);
      const sequence = actions.length + 1, selector = '#soak-click-' + sequence;
      const action = await measure('click', () => studio.action({ type: 'click', selector, pageId: page.pageId, generation: page.navigationGeneration, leaseEpoch: run.leaseEpoch }), cycleStages);
      const observed = await measure('pageAck', () => page.page.$eval('#action-count', element => ({ count: Number(element.textContent), visibility: document.visibilityState, focused: document.hasFocus() })), cycleStages);
      assert.equal(observed.count, sequence);
      actions.push({ sequence, commandId: action.commandId, selector });
      await measure('regularFetch', () => fetchPayload('regular-' + sequence, 64 * KiB), cycleStages);
      if (loadElapsed() >= nextCheckpoint) {
        await measure('largeFetch', () => fetchPayload('large-' + sequence, MiB), cycleStages);
        await measure('checkpoint', () => checkpoint('soak-' + sequence), cycleStages);
        await measure('captureFlush', () => page.capture.flush(), cycleStages);
        if (!firstArtifactId) await measure('fieldRead', () => fieldRead('early'), cycleStages);
        console.log(`SOAK ${(loadElapsed() / 60000).toFixed(1)}/${minutes} min; actions=${actions.length}, checkpoint=${checkpointIds.length}`);
        nextCheckpoint += 60000;
      }
      if (loadElapsed() >= nextSummary) { await measure('summary', summary, cycleStages); await measure('memory', memory, cycleStages); nextSummary += 10000; }
      report.elapsedMs = round(loadElapsed()); report.load.completedCycles = actions.length;
      if (slot % 10 === 0) await save('running');
      const cycleWorkMs = performance.now() - cycleAt;
      report.load.maxCycleWorkMs = Math.max(report.load.maxCycleWorkMs, round(cycleWorkMs));
      if (cycleWorkMs > 1000) report.load.cyclesOverCadence++;
      previousCycle = { slot, cycle: sequence, elapsedMs: round(loadElapsed()), workMs: round(cycleWorkMs), visibility: observed.visibility, focused: observed.focused, stages: cycleStages };
      if (cycleWorkMs > 900) {
        if (slowCycles.length < 100) slowCycles.push(previousCycle);
        else {
          const slowest = slowCycles.reduce((minimum, item, index) => item.workMs < slowCycles[minimum].workMs ? index : minimum, 0);
          if (previousCycle.workMs > slowCycles[slowest].workMs) slowCycles[slowest] = previousCycle;
        }
      }
      slot++;
    }
    if (loadElapsed() < durationMs) await delay(durationMs - loadElapsed());
    report.load.loadEndedAt = new Date().toISOString(); report.load.loadElapsedMs = round(loadElapsed());
    report.elapsedMs = report.load.loadElapsedMs; report.load.completedCycles = actions.length;
    assert.ok(report.elapsedMs >= durationMs); await page.capture.flush(); await summary(); await memory(); await fieldRead('late');
    report.pageAcknowledgedActions = await page.page.$eval('#action-count', element => Number(element.textContent)); assert.equal(report.pageAcknowledgedActions, actions.length);
    await save('verifying'); const verificationAt = performance.now();
    await studio.seal(); const reader = studio.reader(run.id);
    report.digests = await verifyExpected(reader, page.pageId, actions, requests);
    report.summary = await reader.summary(); assert.equal(report.summary.gaps, 0, 'This normal fixed load must have no unexplained capture gaps');
    report.evidenceSnapshot = await buildSoakEvidenceSnapshot(reader); assert.deepEqual(report.evidenceSnapshot.checkpointIds, checkpointIds);
    report.verificationElapsedMs = round(performance.now() - verificationAt);
    report.performanceVerdict = { checkpoint: percentile(checkpointMs)! <= limits.checkpointP95Ms, summary: percentile(summaryMs)! <= limits.summaryP95Ms, httpSubmit: percentile(submitMs)! <= limits.httpSubmitP95Ms };
    report.load.metPlannedCadence = actions.length === report.load.plannedCycles && report.load.skippedScheduleSlots === 0;
    report.mechanismVerified = true; report.longRunAcceptance = minutes >= 30 ? 'fixed-load-thresholds-evaluated' : 'not-evaluated-duration-below-30-minutes';
    await save('verified');
    assert.ok(Object.values(report.performanceVerdict).every(Boolean), 'One or more predeclared P95 performance targets failed; measurements are saved');
    assert.ok(report.load.metPlannedCadence, 'The fixed cadence was not sustained; completed cycles and missed slots are saved');
    assert.ok(report.memory.protection.pagePrivateAvailable, 'Page private memory was unavailable; memory protection was not fully measured');
    report.passed = true; await save('completed');
    console.log('SOAK PASS ' + JSON.stringify({ runId: run.id, minutes, qualification: report.qualification, elapsedMs: report.elapsedMs, actions: actions.length, requests: requests.length, checkpointP95Ms: percentile(checkpointMs), summaryP95Ms: percentile(summaryMs), httpSubmitP95Ms: percentile(submitMs) }));
    return report;
  } catch (error) {
    report.passed = false; report.error = String(error); if (startedMonotonic) report.elapsedMs = Math.max(report.elapsedMs, round(performance.now() - startedMonotonic));
    await save('failed'); throw error;
  } finally {
    powerMonitor.off('lock-screen', onLock); powerMonitor.off('unlock-screen', onUnlock);
    powerMonitor.off('suspend', onSuspend); powerMonitor.off('resume', onResume);
  }
}
