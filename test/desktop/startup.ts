import assert from 'node:assert/strict';
import { WebContentsView } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import type { StudioWindow } from '@/main/window';

/** Reproduce a failed module followed by the same reload Vite requests after optimization. */
export function prepareStartupReload(window: StudioWindow, permanentFailure = false) {
  const ui = window.window.webContents;
  let failedModules = 0, reloadRequests = 0, commits = 0;
  const onCommit = () => { commits++; };
  const onReload = (event: Electron.Event, url: string) => {
    if (url === window.uiUrl) {
      reloadRequests++;
      console.log(`STARTUP RELOAD: prevented=${event.defaultPrevented}`);
    }
  };
  ui.on('did-navigate', onCommit);
  ui.on('will-navigate', onReload);
  ui.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const entry = url.pathname === '/index.tsx' || /\/assets\/index-[^/]+\.js$/.test(url.pathname);
    const fail = details.webContentsId === ui.id && entry && (permanentFailure || failedModules === 0);
    if (fail) failedModules++;
    callback({ cancel: fail });
  });
  // Forge's initial preload build sends a real Vite full-reload to the first HMR
  // connection. Built-file tests reproduce that browser action without a server.
  if (window.uiUrl.startsWith('file:')) ui.once('dom-ready', () => {
    void ui.executeJavaScript('setTimeout(() => location.reload(), 0); void 0');
  });
  return () => {
    ui.session.webRequest.onBeforeRequest(null);
    ui.off('did-navigate', onCommit); ui.off('will-navigate', onReload);
    assert.equal(failedModules, 1);
    assert(reloadRequests >= 1, 'A renderer-initiated reload was requested');
    assert(commits >= 2, 'The replacement trusted document must actually commit');
    return { failedModules, reloadRequests, commits };
  };
}

export async function verifyStartup(window: StudioWindow) {
  const ui = window.window.webContents;
  if (window.uiUrl.startsWith('http:')) {
    // Consume Forge's buffered first-connection reload before asserting document
    // identity across deliberately rejected navigations. Do not hide it with a sleep.
    const deadline = Date.now() + 5000;
    const ready = () => { const status=window.startupStatus(); return status.commits >= 2 && !status.needsBounds && !status.loading; };
    while (!ready() && Date.now() < deadline) await delay(25);
    assert(ready(), 'Forge initial HMR reload must commit and report fresh usable bounds');
  }
  const result = await ui.executeJavaScript(`(() => {
    const rect = document.querySelector('.native-browser')?.getBoundingClientRect();
    return { bridge: typeof window.studio?.call, width: rect?.width, height: rect?.height };
  })()`);
  assert.equal(result.bridge, 'function');
  assert(result.width > 0 && result.height > 0, 'React must mount a usable browser area');
  assert.equal(ui.getURL(), window.uiUrl);
  const view = new WebContentsView({ webPreferences: { sandbox:true, contextIsolation:true, nodeIntegration:false } });
  window.add(view);
  try {
    await ui.executeJavaScript('window.__startupDocument = document; void 0');
    // Exact-document reload permission must not permit arbitrary dev-server or remote pages.
    const blocked = [new URL('other.html', window.uiUrl).href, window.uiUrl + '?untrusted=1', 'https://untrusted.invalid/'];
    for (const destination of blocked) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ui.off('will-navigate', onNavigate); reject(new Error('Navigation policy was not exercised')); }, 3000);
        const onNavigate = (event: Electron.Event, url: string) => {
          clearTimeout(timer);
          try { assert.equal(url, destination); assert.equal(event.defaultPrevented, true); resolve(); }
          catch (error) { reject(error); }
        };
        ui.once('will-navigate', onNavigate);
        void ui.executeJavaScript(`setTimeout(() => location.href=${JSON.stringify(destination)}, 0); void 0`).catch(reject);
      });
      assert.equal(await ui.executeJavaScript('window.__startupDocument === document'), true);
      assert.equal(ui.getURL(), window.uiUrl);
      assert.equal(view.getVisible(), true, 'Rejected navigation retains valid native presentation');
    }
    window.setPresentation('overlay', true);
    assert.equal(view.getVisible(), false);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ui.off('did-navigate', onCommit); reject(new Error('Trusted document reload was blocked')); }, 3000);
      const onCommit = (_event: Electron.Event, url: string) => {
        clearTimeout(timer);
        try { assert.equal(url, window.uiUrl); assert.equal(view.getVisible(), false, 'Commit waits for fresh bounds'); resolve(); }
        catch (error) { reject(error); }
      };
      ui.once('did-navigate', onCommit);
      void ui.executeJavaScript('setTimeout(() => location.reload(), 0); void 0').catch(reject);
    });
    const deadline = Date.now() + 5000;
    while (!view.getVisible() && Date.now() < deadline) await delay(25);
    assert.equal(view.getVisible(), true, 'Fresh trusted bounds restore the native view after reload');
    assert.equal(await ui.executeJavaScript('window.__startupDocument === undefined'), true);
    return { ...result, rejectedNavigations:blocked.length, reloadRestoredBounds:true };
  } finally { window.remove(view); }
}
