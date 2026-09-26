import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, nativeImage } from 'electron';
import type { Studio } from '@/main/services/studio';

type Rect = { x: number; y: number; width: number; height: number };
const separator = '[role="separator"][aria-label="调整工作台与浏览器宽度"]';
const unavailableWindowCapture = new WeakMap<BrowserWindow, string>();

function alignDesktopCursor(window: BrowserWindow, point: { x: number; y: number }): void {
  if (process.platform !== 'win32') return;
  // sendInputEvent does not move the OS pointer. When the native view hides,
  // Chromium emits a hover move at the real pointer position; align it with
  // the synthetic press so that move cannot cancel the active resize.
  const bounds = window.getContentBounds();
  // PowerShell's process uses Windows logical coordinates for SetCursorPos.
  const desktop = { x: bounds.x + point.x, y: bounds.y + point.y };
  const script = `$source='using System.Runtime.InteropServices; public static class BesTestCursor { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }'; Add-Type -TypeDefinition $source; if (-not [BesTestCursor]::SetCursorPos(${desktop.x},${desktop.y})) { exit 1 }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 12000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(50);
  }
  throw new Error(`UI layout timed out: ${label}; last=${JSON.stringify(last)}`);
}

export async function setUiTheme(studio: Studio, theme: 'light' | 'dark'): Promise<void> {
  const ui = studio.window.window.webContents;
  const dark = theme === 'dark';
  if (await ui.executeJavaScript(`document.documentElement.classList.contains('dark')`) !== dark) {
    const label = dark ? '切换为暗色主题' : '切换为亮色主题';
    await until(() => ui.executeJavaScript(`(() => { const button=document.querySelector('button[aria-label="${label}"]'); if(!button||button.disabled)return false;button.click();return true; })()`), Boolean, label);
  }
  await until(() => ui.executeJavaScript(`document.documentElement.classList.contains('dark')`), value => value === dark, `${theme} theme applied`);
  await until(() => ui.executeJavaScript(`window.studio.call('uiPreferences')`), value => value.theme === theme, `${theme} preference saved`);
}

export async function captureUiFrame(studio: Studio, filename: string): Promise<void> {
  const ui = studio.window.window.webContents;
  await ui.executeJavaScript(`(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.querySelectorAll('.artifact-view img')).map(image=>image.decode()));
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('No UI screenshot frame')),3000);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));
    });
  })()`);
  await delay(160);
  // Chromium capturePage omits sibling WebContentsViews. The documented
  // BrowserWindow source ID targets this exact window without enumerating or
  // capturing other desktop sources. Electron's Video type requires id/name.
  // https://www.electronjs.org/docs/latest/api/browser-window#wingetmediasourceid
  // https://github.com/electron/electron/blob/main/spec/api-media-handler-spec.ts
  const host = studio.window.window, sourceId = host.getMediaSourceId();
  const { width, height } = host.getBounds();
  let failure = unavailableWindowCapture.get(host);
  if (!failure) {
    ui.session.setDisplayMediaRequestHandler((request, callback) => {
      callback(request.frame === ui.mainFrame ? { video: { id: sourceId, name: 'Browser Evidence Studio test window' } } : {});
    });
    try {
      const png: string = await ui.executeJavaScript(`(async () => {
      let stream, timer, expired=false;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Own-window screenshot frame timed out'));},10000);});
      const capture=(async()=>{
        stream=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{width:{ideal:${width}},height:{ideal:${height}},frameRate:{ideal:5,max:5}}});
        if(expired){stream.getTracks().forEach(track=>track.stop());return '';}
        const video=document.createElement('video');video.muted=true;video.srcObject=stream;
        await video.play();
        await new Promise(resolve=>video.requestVideoFrameCallback(()=>resolve()));
        if(expired)return '';
        const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        if(!canvas.width||!canvas.height)throw new Error('Own-window capture has no pixels');
        canvas.getContext('2d').drawImage(video,0,0);
        return canvas.toDataURL('image/png');
      })();
      try{return await Promise.race([capture,deadline]);}
      finally{clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());}
      })()`, true);
      const image = nativeImage.createFromDataURL(png);
      assert.equal(image.isEmpty(), false, `${filename} contains a rendered frame`);
      const imageSize = image.getSize();
      assert(imageSize.width >= 800 && imageSize.height >= 500, `${filename} preserves reviewable window detail`);
      await writeFile(path.join(studio.root, filename), image.toPNG());
      await writeFile(path.join(studio.root, filename.replace(/\.png$/, '.capture.json')), JSON.stringify({ kind: 'own-window-media-frame', processId: process.pid, sourceId, width: imageSize.width, height: imageSize.height }, null, 2));
      return;
    } catch (error) {
      failure = String(error);
      unavailableWindowCapture.set(host, failure);
      console.warn('UI SCREENSHOT LIMITATION: own-window media capture unavailable; recording separately labelled renderer and native surfaces. ' + failure);
    } finally {
      ui.session.setDisplayMediaRequestHandler(null);
    }
  }
  // Screenshot backend availability must not suppress control/recording tests.
  // These files are explicitly separate surfaces, never a claimed composite.
  const rendererFile = filename.replace(/\.png$/, '.renderer.png');
  const rendererImage = await ui.capturePage();
  assert.equal(rendererImage.isEmpty(), false, `${rendererFile} contains the trusted renderer`);
  await writeFile(path.join(studio.root, rendererFile), rendererImage.toPNG());
  let browserFile: string | undefined;
  if (studio.active && studio.current().view.getVisible()) {
    browserFile = filename.replace(/\.png$/, '.browser.png');
    const browserImage = await studio.current().view.webContents.capturePage();
    assert.equal(browserImage.isEmpty(), false, `${browserFile} contains the separate synthetic browser surface`);
    await writeFile(path.join(studio.root, browserFile), browserImage.toPNG());
  }
  await writeFile(path.join(studio.root, filename.replace(/\.png$/, '.capture.json')), JSON.stringify({ kind: 'separate-surfaces', processId: process.pid, compositeAvailable: false, includesNativeViews: false, reason: failure, rendererFile, browserFile }, null, 2));
}

/** Electron sends input directly to the trusted renderer; this is not an OS mouse-routing test. */
export async function runUiLayoutScenarios(studio: Studio): Promise<void> {
  const host = studio.window.window, ui = host.webContents;
  const run = studio.required(), managed = studio.current();
  const originalWindowBounds = host.getBounds();
  const snapshot = () => ({ runId: studio.required().id, pageId: studio.current().pageId, webContentsId: studio.current().webContentsId, controller: run.controller, leaseEpoch: run.leaseEpoch, locked: run.locked, capture: run.capture, execution: run.execution, url: managed.view.webContents.getURL() });
  const before = snapshot();
  const readRect = (): Promise<Rect> => ui.executeJavaScript(`(() => {const r=document.querySelector('.native-browser').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()`);
  const assertBounds = async (label: string) => {
    await until(async () => {
      const expected = await readRect(), actual = managed.view.getBounds(), mask = studio.window.mask.getBounds();
      return { expected, actual, mask };
    }, ({ expected, actual, mask }) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(actual[key] - expected[key]) <= 2 && Math.abs(mask[key] - expected[key]) <= 2), label);
    assert.deepEqual(snapshot(), before, `${label} preserves page identity and control state`);
  };
  const focusUi = async () => {
    if (host.isMinimized()) host.restore();
    host.show(); host.focus(); ui.focus();
    await until(() => host.isFocused() && ui.isFocused(), Boolean, 'trusted renderer focus');
  };
  const handlePoint = (): Promise<{ x: number; y: number }> => ui.executeJavaScript(`(() => {const r=document.querySelector(${JSON.stringify(separator)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  const beginDrag = async () => {
    await focusUi();
    const point = await handlePoint();
    alignDesktopCursor(host, point);
    await delay(75);
    ui.sendInputEvent({ type: 'mouseMove', ...point });
    ui.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await until(() => managed.view.getVisible(), value => !value, 'layout drag hides the native input surface');
    assert.equal(studio.window.mask.getVisible(), false, 'Presentation hiding includes the input mask');
    return point;
  };
  const drag = async (distance: number) => {
    const start = await beginDrag();
    try {
      for (let step = 1; step <= 5; step++) {
        ui.sendInputEvent({ type: 'mouseMove', x: start.x + Math.round(distance * step / 5), y: start.y, modifiers: ['leftbuttondown'] });
      }
    } finally {
      ui.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + distance, y: start.y });
    }
    await until(() => managed.view.getVisible(), Boolean, 'drag release restores native visibility');
    await assertBounds('mouse drag bounds');
  };
  const reset = async () => {
    await ui.executeJavaScript(`document.querySelector('button[aria-label="恢复默认布局"]').click()`);
    await assertBounds('reset layout bounds');
  };

  await until(() => ui.executeJavaScript(`!!document.querySelector(${JSON.stringify(separator)})`), Boolean, 'accessible main separator');
  assert.equal(await ui.executeJavaScript(`document.documentElement.classList.contains('dark')`), false, 'Fresh preferences default to light, independently of OS theme');
  const initial = await readRect();
  const contentWidth = await ui.executeJavaScript('window.innerWidth');
  assert(initial.width / contentWidth > .6, 'The native browser receives most of the default workspace width');
  await assertBounds('default layout bounds');
  await captureUiFrame(studio, 'ui-light.png');
  await setUiTheme(studio, 'dark');
  await assertBounds('theme switch bounds');
  await captureUiFrame(studio, 'ui-dark.png');

  const tick = await managed.page.$eval('#tick', element => Number(element.textContent));
  const clicks = await managed.page.$eval('#action-count', element => element.textContent);
  await ui.executeJavaScript(`window.__dragEvents=[];for(const name of ['pointerdown','pointerup','pointermove','pointercancel','blur','focus'])window.addEventListener(name,e=>{if(window.__dragEvents.length<40)window.__dragEvents.push({name:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted,target:e.target?.getAttribute?.('data-slot'),active:document.activeElement?.getAttribute?.('data-slot')});},true);`);
  await drag(160);
  const dragged = await readRect();
  await writeFile(path.join(studio.root, 'ui-drag-events.json'), JSON.stringify({initial,dragged,events:await ui.executeJavaScript('window.__dragEvents')},null,2));
  assert(dragged.x - initial.x >= 80, 'Dragging into the former native browser area widens the workbench: ' + JSON.stringify({initial,dragged,events:await ui.executeJavaScript('window.__dragEvents')}));
  assert.equal(await managed.page.$eval('#action-count', element => element.textContent), clicks, 'Layout dragging cannot activate the synthetic page button');
  assert(await managed.page.$eval('#tick', element => Number(element.textContent)) > tick, 'Business page timers continue through theme and drag changes');

  // A renderer navigation rejected by will-navigate must not enter the new-UI
  // bounds barrier: the original document is still responsible for its view.
  await until(() => ui.isLoadingMainFrame(), loading => !loading, 'trusted document idle before rejected navigation');
  const originalUiUrl = ui.getURL(), originalNativeBounds = managed.view.getBounds();
  const refusedUrl = new URL(originalUiUrl);
  refusedUrl.searchParams.set('bes-synthetic-rejected-navigation', '1');
  await ui.executeJavaScript('window.__besNavigationDocument = document; true');
  let disposeNavigationListeners = () => {};
  const rejectedNavigation = new Promise<{ prevented: boolean; visibleWhenRejected: boolean; committed: boolean }>((resolve, reject) => {
    let observed = false, prevented = false, visibleWhenRejected = false, committed = false;
    const onNavigate = (details: Electron.Event<Electron.WebContentsWillNavigateEventParams>) => {
      if (details.url !== refusedUrl.href || !details.isMainFrame) return;
      observed = true; prevented = details.defaultPrevented; visibleWhenRejected = managed.view.getVisible();
    };
    const onCommit = () => { committed = true; };
    const onStopped = () => {
      if (!observed) return;
      disposeNavigationListeners(); resolve({ prevented, visibleWhenRejected, committed });
    };
    const timer = setTimeout(() => {
      disposeNavigationListeners();
      reject(new Error(`Rejected UI navigation did not complete will-navigate/did-stop-loading: observed=${observed}, loading=${ui.isLoadingMainFrame()}`));
    }, 10000);
    disposeNavigationListeners = () => {
      clearTimeout(timer); ui.off('will-navigate', onNavigate); ui.off('did-navigate', onCommit); ui.off('did-stop-loading', onStopped);
    };
    ui.on('will-navigate', onNavigate); ui.on('did-navigate', onCommit); ui.on('did-stop-loading', onStopped);
  });
  try {
    const [result] = await Promise.all([
      rejectedNavigation,
      ui.executeJavaScript(`window.location.assign(${JSON.stringify(refusedUrl.href)}); true`, true),
    ]);
    assert.equal(result.prevented, true, 'The existing trusted-window navigation policy rejects the attempted navigation');
    assert.equal(result.committed, false, 'A refused navigation never commits a replacement document');
    assert.equal(result.visibleWhenRejected, true, 'Navigation rejection does not hide the still-owned browser view');
    assert.equal(ui.isLoadingMainFrame(), false, 'The rejected navigation has stopped loading');
    assert.equal(ui.getURL(), originalUiUrl);
    assert.equal(await ui.executeJavaScript('window.__besNavigationDocument === document'), true, 'The original trusted UI document survives navigation refusal');
    assert.equal(managed.view.getVisible(), true, 'The existing native view remains visible after rejection');
    assert.deepEqual(managed.view.getBounds(), originalNativeBounds, 'Rejected navigation leaves native bounds unchanged');
    await assertBounds('rejected renderer navigation');
  } finally { disposeNavigationListeners(); }

  // Reload uses the actual userData-backed preferences, not a test-side layout setter.
  await delay(350);
  await focusUi();
  await ui.executeJavaScript(`(async()=>{await window.studio.call('presentation',{reason:'overlay',hidden:true});await window.studio.call('presentation',{reason:'layout',hidden:true});})()`);
  assert.equal(managed.view.getVisible(), false, 'Both presentation reasons hide the browser');
  await ui.executeJavaScript(`window.studio.call('presentation',{reason:'layout',hidden:false})`);
  assert.equal(managed.view.getVisible(), false, 'Ending layout hiding cannot uncover an existing dialog');
  await ui.executeJavaScript(`window.studio.call('presentation',{reason:'layout',hidden:true})`);
  await ui.reload();
  await until(() => ui.executeJavaScript(`!!document.querySelector(${JSON.stringify(separator)}) && document.documentElement.classList.contains('dark')`).catch(() => false), Boolean, 'reloaded theme and workbench');
  await until(readRect, rect => Math.abs(rect.x - dragged.x) <= 2, 'workspace size survives renderer reload');
  await until(() => managed.view.getVisible(), Boolean, 'fresh trusted bounds clear stale pre-reload occlusion');
  await assertBounds('persisted layout bounds');

  await focusUi();
  await ui.executeJavaScript(`document.querySelector(${JSON.stringify(separator)}).focus()`);
  const beforeKeyboard = await readRect();
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await until(readRect, rect => rect.x > beforeKeyboard.x + 2, 'keyboard separator resize');
  await assertBounds('keyboard resize bounds');
  await drag(-70); await drag(45);

  // Windows can ignore blur() while a simulated pressed pointer owns focus.
  // Shift focus to a blank window owned by this test and prove that a native
  // blur actually occurred before asserting the application's cleanup.
  const focusProbe = new BrowserWindow({ width: 180, height: 100, show: false, skipTaskbar: true, title: 'Synthetic focus probe', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let interrupted: { x: number; y: number } | undefined;
  let blurObserved = false;
  const onBlur = () => { blurObserved = true; };
  try {
    await focusProbe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Synthetic focus probe</title><p>合成失焦验证</p>'));
    interrupted = await beginDrag();
    host.on('blur', onBlur);
    focusProbe.show(); focusProbe.focus(); focusProbe.webContents.focus();
    await until(() => ({ blurObserved, hostFocused: host.isFocused(), probeFocused: focusProbe.isFocused() }), value => value.blurObserved && !value.hostFocused && value.probeFocused, 'native focus leaves the application window');
    await until(() => ui.executeJavaScript('document.hasFocus()'), focused => !focused, 'trusted renderer observes focus loss');
    await until(() => managed.view.getVisible(), Boolean, 'observed window blur ends layout hiding');
  } finally {
    host.off('blur', onBlur); focusProbe.destroy();
    await focusUi();
    if (interrupted) ui.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...interrupted });
  }
  await assertBounds('cancelled drag bounds');

  await reset();
  await until(readRect, rect => Math.abs(rect.x - initial.x) <= 2, 'default workspace restored');
  // Reset remounts the browser placeholder. A subsequent content-only resize
  // must still reach the native view without a window or separator resize event.
  const beforeToolbarResize = await readRect();
  const previousToolbarHeight = await ui.executeJavaScript(`(() => {const toolbar=document.querySelector('.browser-toolbar');const previous=toolbar.style.height;toolbar.style.height=(toolbar.getBoundingClientRect().height+48)+'px';return previous;})()`);
  try {
    await until(readRect, rect => rect.height <= beforeToolbarResize.height - 40, 'toolbar content changes browser placeholder after reset');
    await assertBounds('content resize after layout reset');
  } finally {
    await ui.executeJavaScript(`document.querySelector('.browser-toolbar').style.height=${JSON.stringify(previousToolbarHeight)}`);
  }
  await assertBounds('toolbar content size restored');
  host.setSize(1100, 760);
  await until(() => ui.executeJavaScript('window.innerWidth'), width => width <= 1100, 'minimum window viewport');
  await assertBounds('minimum window bounds');
  assert(await ui.executeJavaScript(`document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth`), 'The minimum window has no whole-page horizontal overflow');
  assert((await readRect()).width >= 400, 'Minimum window preserves a usable browser');
  await captureUiFrame(studio, 'ui-minimum-dark.png');
  host.maximize();
  await until(() => host.isMaximized(), Boolean, 'window maximized');
  await assertBounds('maximized window bounds');
  host.unmaximize(); host.setBounds(originalWindowBounds);
  await until(() => ui.executeJavaScript('window.innerWidth'), width => Math.abs(width - contentWidth) <= 2, 'original window viewport restored');
  await reset(); await setUiTheme(studio, 'light');
  await assertBounds('final restored workspace');
  console.log('UI LAYOUT PASS: light/dark, rejected renderer navigation, userData preference reload, renderer-targeted Electron pointer/keyboard resizing, observed native blur cleanup, minimum/maximized bounds and unchanged control lease; OS mouse routing remains unverified');
}
