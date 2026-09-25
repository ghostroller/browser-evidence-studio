import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Frame, Page } from 'puppeteer-core';
import type { Studio } from '@/main/services/studio';

async function environment(context: Page | Frame) {
  await context.waitForFunction(() => Boolean((window as any).__browserEnvironment?.ready), { timeout: 10_000 });
  return context.evaluate(() => (window as any).__browserEnvironment);
}

function verifyEnvironment(value: any, label: string, expectedUa?: string): string {
  assert.equal(value.error, undefined, `${label}: fixture collection failed`);
  const early = value.early, major = process.versions.chrome!.split('.')[0];
  assert.match(early.userAgent, new RegExp(` Chrome/${major}\\.0\\.0\\.0 Safari/537\\.36$`), `${label}: UA must use the running Chromium major`);
  assert.doesNotMatch(early.userAgent, /Electron|BrowserEvidenceStudio|browser-evidence-studio/i);
  if (expectedUa) assert.equal(early.userAgent, expectedUa, `${label}: all native browsing contexts must share the UA`);
  assert.equal(early.webdriver, false, `${label}: startup debugging must not mark the native navigator as automated`);
  for (const name of ['userAgent', 'webdriver']) {
    assert.equal(early.getters[name].own, false, `${label}: navigator.${name} must not be an own-property shim`);
    assert.match(early.getters[name].source, /\[native code\]/, `${label}: ${name} must retain its native getter`);
  }
  assert.deepEqual(early.node, { process: 'undefined', require: 'undefined' }, `${label}: Node globals must not reach the site`);
  assert.equal(early.userAgentData?.mobile, false);
  assert.ok(early.userAgentData?.brands.some((brand: any) => brand.brand === 'Chromium' && brand.version === major), `${label}: native Chromium client hints must remain available`);
  assert.ok(value.highEntropy?.fullVersionList.some((brand: any) => brand.brand === 'Chromium' && brand.version === process.versions.chrome), `${label}: native full-version hints must reflect the actual engine`);
  for (const [request, headers] of Object.entries({ navigation: value.navigation.headers, fetch: value.fetch.headers }) as Array<[string, any]>) {
    assert.equal(headers['user-agent'], early.userAgent, `${label} ${request}: HTTP and DOM UA must match`);
    if (request === 'fetch') {
      assert.match(headers['sec-ch-ua'] || '', new RegExp(`"Chromium";v="${major}"`), `${label} fetch: native low-entropy client hints must remain available`);
      assert.equal(headers['sec-ch-ua-mobile'], '?0');
      assert.equal(headers['sec-ch-ua-platform'], JSON.stringify(early.userAgentData.platform));
    } else {
      // Electron 44.4.3 has no ClientHintsControllerDelegate. Two independent
      // baseline/compatible processes confirmed this native navigation limit;
      // it is not a UA fallback regression. Reassess on an Electron upgrade.
      for (const name of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
        assert.equal(headers[name], null, `${label}: record the verified Electron navigation limitation explicitly`);
      }
    }
    assert.equal(String(headers['accept-language']).split(',')[0].split(';')[0].toLowerCase(), early.language.toLowerCase(), `${label} ${request}: language must remain internally consistent`);
  }
  return early.userAgent;
}

function securityPreferences(page: ReturnType<Studio['current']>) {
  // Electron exposes this introspection method internally; use it only in tests.
  const preferences = (page.view.webContents as any).getLastWebPreferences();
  const actual = { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity };
  assert.deepEqual(actual, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  return actual;
}

/** Small local compatibility regression, included in the existing desktop suite. */
export async function runBrowserEnvironmentScenarios(studio: Studio, siteUrl: string): Promise<void> {
  if (studio.active) await studio.seal(); if(studio.state().session)await studio.closeSession();
  const report: Record<string, any> = { schemaVersion: 1, processId: process.pid, versions: { electron: process.versions.electron, chromium: process.versions.chrome }, startedAt: new Date().toISOString(), passed: false, limitations: ['Electron native navigation omits Client Hints; this test does not assert Chrome equivalence'], contexts: {} };
  try {
    const project = await studio.createProject({ name: '合成浏览器环境', objective: '初始请求、刷新、弹窗与 iframe 的原生浏览器属性一致性' });
    const profile = await studio.createProfile({ projectId: project.id, name: '隔离环境检查' });
    await studio.startRun({ projectId: project.id, profileId: profile.id, url: `${siteUrl}/browser-environment` });
    const run = studio.required(), parent = studio.current();
    report.runId = run.id;
    report.security = { parent: securityPreferences(parent) };
    const first = await environment(parent.page);
    report.contexts.initial = first;
    const expectedUa = verifyEnvironment(first, 'initial');
    report.browserEnvironment = run.store.manifest.browserEnvironment;
    assert.deepEqual(report.browserEnvironment, {
      policy: 'chrome-compatible-v1', userAgent: expectedUa, chromiumVersion: process.versions.chrome,
      clientHintsPolicy: 'native-chromium', automationControlled: 'disabled-at-startup',
    }, 'Run metadata must describe the browser configuration actually observed');
    const frame = parent.page.frames().find(item => item.url() === `${siteUrl}/browser-environment?kind=frame`);
    assert.ok(frame, 'The initial document must create its real iframe');
    report.contexts.iframe = await environment(frame);
    verifyEnvironment(report.contexts.iframe, 'iframe', expectedUa);

    await studio.control('agent');
    await studio.action({ type: 'click', selector: '#environment-fetch', pageId: parent.pageId, generation: parent.navigationGeneration, leaseEpoch: run.leaseEpoch });
    assert.ok(run.operation, 'Managed operation must use the ordinary Puppeteer connection');
    await environment(parent.page);
    await run.operation.page.reload({ waitUntil: 'load' });
    report.contexts.reload = await environment(parent.page);
    assert.notEqual(report.contexts.reload.navigation.id, first.navigation.id, 'Reload must issue a fresh server navigation');
    verifyEnvironment(report.contexts.reload, 'reload', expectedUa);

    await studio.action({ type: 'click', selector: '#environment-popup', pageId: parent.pageId, generation: parent.navigationGeneration, leaseEpoch: run.leaseEpoch });
    const deadline = Date.now() + 10_000;
    let popup = [...run.pages.values()].find(page => page.openerPageId === parent.pageId);
    while (!popup && Date.now() < deadline) { await delay(50); popup = [...run.pages.values()].find(page => page.openerPageId === parent.pageId); }
    assert.ok(popup, 'Native window.open must register a managed popup');
    report.security.popup = securityPreferences(popup);
    report.contexts.popup = await environment(popup.page);
    verifyEnvironment(report.contexts.popup, 'popup', expectedUa);
    await Promise.all([...run.pages.values()].map(page => page.capture.flush()));
    assert.ok([...run.pages.values()].every(page => page.capture.health === 'recording'), 'Ordinary CDP evidence capture must remain active');
    await studio.seal(); if(studio.state().session)await studio.closeSession();
    report.passed = true;
    console.log('Browser environment PASS: native UA/getters and fetch Client Hints, initial navigation/reload/iframe/popup; Electron navigation Client Hints limitation recorded');
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(studio.root, 'browser-environment-result.json'), JSON.stringify(report, null, 2));
  }
}
