import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { app, type BrowserWindow, type Session, type WebContents, type WebContentsView, type WebPreferences } from 'electron';

type ContextKind = 'main' | 'frame' | 'popup';
type Round = 'first' | 'reload';
interface Inputs {
  open(): WebContentsView;
  windows: Map<BrowserWindow, WebContentsView>;
  closedContents: WebContents[];
  browserSession: Session;
  root: string;
}

const requestHeaders = (request: IncomingMessage) => Object.fromEntries([
  'user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
].map(name => [name, request.headers[name] ?? null]));

async function eventually(check: () => boolean, message: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** The synthetic site reports its own state; the harness never injects or uses CDP. */
export async function verifyBaseline({ open, windows, closedContents, browserSession, root }: Inputs) {
  const startedAt = new Date().toISOString();
  const nonce = randomUUID();
  const storageKey = 'bes-baseline-synthetic';
  const reports = new Map<string, Record<string, any>>();
  const navigations = new Map<string, { headers: ReturnType<typeof requestHeaders>; syntheticCookie: boolean }>();
  const failures: string[] = [];
  let origin = '', mainLoads = 0, requests = 0;
  const prefix = '/' + nonce;
  const knownContexts = new Set(['main:first', 'frame:first', 'popup:first', 'main:reload', 'frame:reload']);
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      if (++requests > 60) { response.writeHead(429).end(); return; }
      const url = new URL(request.url || '/', origin);
      if (url.origin !== origin || !url.pathname.startsWith(prefix + '/')) { response.writeHead(404).end(); return; }
      const route = url.pathname.slice(prefix.length + 1);
      if (route === 'probe' && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ headers: requestHeaders(request) })); return;
      }
      if (route === 'report' && request.method === 'POST') {
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return; }
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.byteLength;
          if (bytes > 16_384) { response.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const key = `${report.kind}:${report.round}`;
        assert.ok(knownContexts.has(key), 'Only expected synthetic documents may report');
        assert.ok(!reports.has(key), `Duplicate synthetic report: ${key}`);
        reports.set(key, report);
        response.writeHead(204).end(); return;
      }
      if (request.method !== 'GET' || !['main', 'frame', 'popup'].includes(route)) { response.writeHead(404).end(); return; }
      const kind = route as ContextKind;
      const round = kind === 'main' ? (++mainLoads === 1 ? 'first' : 'reload') : url.searchParams.get('round') as Round;
      const key = `${kind}:${round}`;
      assert.ok(mainLoads <= 2 && knownContexts.has(key), 'Unexpected synthetic navigation');
      assert.ok(!navigations.has(key), `Duplicate synthetic navigation: ${key}`);
      navigations.set(key, { headers: requestHeaders(request), syntheticCookie: request.headers.cookie?.split('; ').includes(`bes_baseline=${nonce}`) === true });
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness');
      if (kind === 'main' && round === 'first') response.setHeader('Set-Cookie', `bes_baseline=${nonce}; Path=/; SameSite=Lax`);
      const config = JSON.stringify({ kind, round, prefix, storageKey, marker: nonce }).replace(/</g, '\\u003c');
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic baseline ${key}</title><script>
        const config = ${config};
        const getter = name => { const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, name); return { own: Object.prototype.hasOwnProperty.call(navigator, name), source: descriptor && descriptor.get ? Function.prototype.toString.call(descriptor.get) : null }; };
        const report = { kind: config.kind, round: config.round, early: {
          userAgent: navigator.userAgent, webdriver: navigator.webdriver, platform: navigator.platform,
          language: navigator.language, languages: [...navigator.languages], visibility: document.visibilityState,
          userAgentData: navigator.userAgentData ? navigator.userAgentData.toJSON() : null,
          getters: { userAgent: getter('userAgent'), webdriver: getter('webdriver') },
          node: { process: typeof process, require: typeof require },
          recorder: { rrweb: typeof window.rrweb, ready: window.__besRecorderReady === true },
          hasOpener: window.opener !== null, cookieMatches: document.cookie.split('; ').includes('bes_baseline=' + config.marker),
          localStorageBefore: localStorage.getItem(config.storageKey)
        } };
        if (config.kind === 'main' && config.round === 'first') localStorage.setItem(config.storageKey, config.marker);
        addEventListener('DOMContentLoaded', async () => {
          try {
            report.fetch = await fetch(config.prefix + '/probe').then(response => response.json());
            report.highEntropy = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'platformVersion']) : null;
          } catch (error) { report.error = String(error); }
          await fetch(config.prefix + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
          if (config.kind === 'main' && config.round === 'first') window.open(config.prefix + '/popup?round=first', 'baseline-synthetic-popup');
        });
      </script></head><body><h1>无账号合成对照</h1>${kind === 'main' ? `<iframe title="synthetic frame" src="${prefix}/frame?round=${round}"></iframe>` : ''}</body></html>`);
    })().catch(error => {
      failures.push(String(error));
      if (!response.headersSent) response.writeHead(500).end(); else response.destroy();
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const ownedContents: WebContents[] = [];
  try {
    assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false);
    assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false);
    for (const key of ['userData', 'sessionData'] as const) {
      const relative = path.relative(root, app.getPath(key));
      assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), `${key} must stay inside this independent baseline root`);
      await assert.rejects(access(path.join(app.getPath(key), 'DevToolsActivePort')), { code: 'ENOENT' });
    }
    const initial = open();
    const contents = initial.webContents;
    await contents.loadURL(origin + prefix + '/main');
    await eventually(() => failures.length > 0 || ['main:first', 'frame:first', 'popup:first'].every(key => reports.has(key)), 'Initial document, iframe and native popup did not all report');
    assert.deepEqual(failures, []);
    assert.equal(windows.size, 2, 'The native popup needs its own host');
    contents.reload();
    await eventually(() => failures.length > 0 || ['main:reload', 'frame:reload'].every(key => reports.has(key)), 'Reloaded main document and iframe did not both report');
    assert.deepEqual(failures, []);
    const native = [...windows.values()].map(view => {
      const wc = view.webContents; ownedContents.push(wc);
      const preferences = (wc as WebContents & { getLastWebPreferences(): WebPreferences }).getLastWebPreferences();
      for (const property of ['sandbox', 'contextIsolation', 'webSecurity'] as const) assert.equal(preferences[property], true, property);
      assert.equal(preferences.nodeIntegration, false);
      assert.ok(!preferences.preload, 'No business preload may be installed');
      assert.equal(wc.session, browserSession, 'Popup and primary document must share the isolated session');
      assert.equal(wc.debugger.isAttached(), false);
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, webSecurity: preferences.webSecurity, nodeIntegration: preferences.nodeIntegration, preload: false, debuggerAttached: false };
    });
    assert.equal(navigations.get('main:first')?.syntheticCookie, false, 'The fresh context must start without the synthetic cookie');
    assert.equal(reports.get('main:first')?.early.localStorageBefore, null, 'The fresh context must start without the synthetic storage marker');
    const ua = browserSession.getUserAgent();
    assert.match(ua, /Chrome\/\d+\.0\.0\.0/);
    assert.doesNotMatch(ua, /Electron|BrowserEvidenceStudio|browser-evidence-studio/);
    for (const key of knownContexts) {
      const report = reports.get(key), navigation = navigations.get(key);
      assert.ok(report && navigation, `Missing ${key} evidence`);
      assert.equal(report.error, undefined, `Synthetic probe failed in ${key}`);
      assert.equal(navigation.headers['user-agent'], ua, `${key} initial navigation UA`);
      assert.equal(report.early.userAgent, ua, `${key} parser-blocking UA`);
      assert.equal(report.fetch.headers['user-agent'], ua, `${key} fetch UA`);
      assert.equal(report.early.webdriver, false, `${key} webdriver`);
      assert.deepEqual(report.early.node, { process: 'undefined', require: 'undefined' });
      assert.deepEqual(report.early.recorder, { rrweb: 'undefined', ready: false });
      assert.equal(report.early.cookieMatches, true, `${key} shared cookie`);
      assert.equal(report.early.hasOpener, key === 'popup:first', `${key} opener relationship`);
      for (const getter of Object.values(report.early.getters) as Array<{ own: boolean; source: string | null }>) {
        assert.equal(getter.own, false); assert.match(getter.source ?? '', /\[native code\]/);
      }
      if (key !== 'main:first') {
        assert.equal(navigation.syntheticCookie, true, `${key} outgoing synthetic cookie`);
        assert.equal(report.early.localStorageBefore, nonce, `${key} shared localStorage`);
      }
    }
    const popup = ownedContents.find(wc => wc !== contents);
    assert.ok(popup, 'The native popup must exist before testing guest-driven close');
    popup.close({ waitForBeforeUnload: false });
    await eventually(() => popup.isDestroyed() && windows.size === 1, 'Closing the popup WebContents must remove its host without reentrant close failures');
    assert.equal(contents.isDestroyed(), false, 'Closing a popup must preserve the opener');
    for (const host of [...windows.keys()]) host.close();
    await eventually(() => windows.size === 0 && ownedContents.every(wc => wc.isDestroyed()), 'Closing every host must destroy every business WebContents');
    assert.ok(ownedContents.every(wc => closedContents.includes(wc)), 'Every closed view must have completed owner cleanup');
    return {
      startedAt, finishedAt: new Date().toISOString(), contexts: Object.fromEntries(reports),
      navigationHeaders: Object.fromEntries(navigations), native, destroyedViewCount: ownedContents.length, popupGuestClose: 'passed',
      limitations: ['Only synthetic pages were tested; real-site login remains unverified.', 'Main-world recorder signals alone cannot detect isolated-world code; the separate build dependency audit verifies no recorder is imported.', 'The fresh profile differs from existing recorded profiles; success cannot identify recording as the sole cause.'],
    };
  } finally {
    for (const host of [...windows.keys()]) host.destroy();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
