import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '../../src/main/services/studio';

/** Real trusted renderer/IPC verification. The business page is never injected here. */
export async function runUiScenarios(studio: Studio): Promise<void> {
  const ui = studio.window.window.webContents;
  const evaluate = <T>(expression: string): Promise<T> => ui.executeJavaScript(expression, true);
  async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, name: string, timeoutMs = 12000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (accept(last)) return last;
      await delay(70);
    }
    const diagnostics = await evaluate<unknown>(`({ error:document.querySelector('.banner.error')?.textContent || '', status:document.querySelector('.statusbar')?.textContent || '', buttons:Array.from(document.querySelectorAll('button')).slice(0,35).map(button=>({text:button.textContent.trim(),disabled:button.disabled})) })`).catch(() => 'renderer unavailable');
    await writeFile(path.join(studio.root, 'ui-failure.png'), (await ui.capturePage()).toPNG()).catch(() => undefined);
    throw new Error(`UI wait failed: ${name}; last=${JSON.stringify(last)}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
  async function click(text: string, scope = 'document') {
    // The renderer polls main state every 2 s. A main-side transition may have
    // completed while the old label or disabled state is still on screen.
    // Retry observation only; issue the action exactly once when it is ready.
    await waitFor(() => evaluate<{ clicked: boolean; reason?: string }>(`(() => { const root = ${scope}; if(!root)return {clicked:false,reason:'scope-not-mounted'}; const button = Array.from(root.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) return {clicked:false,reason:'label-not-mounted'}; if(button.disabled)return {clicked:false,reason:'disabled'}; const rect=button.getBoundingClientRect();if(!rect.width||!rect.height)return {clicked:false,reason:'hidden'};button.click(); return {clicked:true}; })()`), result => result.clicked, `clickable UI button: ${text}`);
  }
  async function waitIdle() {
    await waitFor(() => evaluate<string>(`document.querySelector('.statusbar')?.textContent || ''`), text => !text.includes('正在处理'), 'UI action completion');
  }
  async function captureUi(filename: string, ready: string): Promise<void> {
    await waitFor(() => evaluate<boolean>(ready), Boolean, `${filename} expected DOM`);
    await evaluate<void>(`(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.querySelectorAll('.artifact-view img')).map(image => image.decode()));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Trusted UI did not produce two animation frames')), 3000);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
      });
    })()`);
    // React DOM readiness precedes compositor submission. Leave one small,
    // explicit paint interval before capturePage reads the composed surface.
    await delay(160);
    assert.equal(await evaluate<boolean>(ready), true, `${filename} DOM must still describe the intended view`);
    const screenshot = await ui.capturePage();
    assert.equal(screenshot.isEmpty(), false, `${filename} must contain an actual rendered frame`);
    await writeFile(path.join(studio.root, filename), screenshot.toPNG());
  }
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('.app-shell') && typeof window.studio?.call === 'function'`), Boolean, 'React/isolated preload ready');
  assert.equal(await evaluate<string>(`document.querySelector('.brand strong').textContent`), 'Browser Evidence Studio');
  const run = studio.active;
  if (run) {
    assert.equal(run.controller, 'human', 'UI scenario requires a synthetic run with human control');
    await waitFor(() => evaluate<string>(`document.querySelector('.evidence-strip').textContent`), text => text.includes(run.id.slice(0, 12)), 'renderer receives active run state');
    const expected = await evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r=document.querySelector('.native-browser').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}; })()`);
    assert(expected.width > 350 && expected.height > 180, 'Native browser has usable layout bounds');
    await waitFor(() => studio.current().view.getBounds(), actual => (['x', 'y', 'width', 'height'] as const).every(field => Math.abs(actual[field] - expected[field]) <= 2), 'native bounds follow renderer ResizeObserver');
    await click('暂停页面输入');
    await waitFor(() => run.locked, Boolean, 'UI locks native input');
    assert.equal(studio.window.mask.getVisible(), true);
    await waitIdle();
    await waitFor(() => evaluate<string>(`document.querySelector('.browser-toolbar').textContent`), text => text.includes('恢复人工输入'), 'pause button updates');
    await click('恢复人工输入');
    await waitFor(() => run.locked, value => !value, 'UI restores native input');
    await waitIdle();
    await click('交给 Agent 控制');
    await waitFor(() => run.controller, value => value === 'agent', 'UI grants explicit agent control');
    assert.equal(studio.window.mask.getVisible(), true);
    await waitIdle();
    await waitFor(() => evaluate<string>(`document.querySelector('.browser-toolbar').textContent`), text => text.includes('收回人工控制'), 'control button updates');
    await click('收回人工控制');
    await waitFor(() => run.controller, value => value === 'human', 'UI revokes agent control');
    await waitIdle();
  }

  await click('连接与环境');
  await waitFor(() => evaluate<string>(`document.querySelector('.overlay-heading h2')?.textContent || ''`), text => text === '连接与已验证环境', 'connection overlay');
  if (run) await waitFor(() => studio.current().view.getVisible(), value => !value, 'overlay hides native business view');
  assert.equal(studio.window.mask.getVisible(), false, 'Hidden native view cannot cover the trusted dialog');
  await click('返回工作台');
  await waitFor(() => evaluate<boolean>(`!document.querySelector('.overlay')`), Boolean, 'close dialog');
  if (run) await waitFor(() => studio.current().view.getVisible(), Boolean, 'native view restored');

  await click('执行 / 验收');
  await waitFor(() => evaluate<string>(`document.querySelector('.panel-heading h2')?.textContent || ''`), text => text === '受控复跑', 'validation tab');
  assert(await evaluate<boolean>(`!!Array.from(document.querySelectorAll('button')).find(button => button.textContent === '登记脚本目录')`));
  await click('保存点');
  await captureUi('ui.png', `!document.querySelector('.overlay') && document.querySelector('.panel-heading h2')?.textContent === '保存关键结果' && document.querySelector('.panel-tabs button.selected')?.textContent === '保存点'`);

  if (run) {
    await click('打开证据时间线');
    await waitFor(() => evaluate<string>(`document.querySelector('.overlay-heading h2')?.textContent || ''`), text => text === '证据与验收存档', 'real stored archive');
    await waitFor(() => studio.current().view.getVisible(), value => !value, 'archive hides native view');
    const count = await waitFor(() => evaluate<number>(`document.querySelectorAll('.checkpoint-archive-list button').length`), count => count > 0, 'saved checkpoint list mounted');
    if (count) {
      await evaluate<void>(`document.querySelector('.checkpoint-archive-list button').click()`);
      await waitFor(() => evaluate<boolean>(`!!document.querySelector('.artifact-actions button')`), Boolean, 'checkpoint sources');
      await click('screenshot', `document.querySelector('.artifact-actions')`);
      await waitFor(() => evaluate<boolean>(`(() => {const image=document.querySelector('.artifact-view img');return !!image&&image.complete&&image.naturalWidth>0;})()`), Boolean, 'custom scheme serves saved PNG');
      await captureUi('ui-evidence.png', `(() => { const image=document.querySelector('.artifact-view img');return document.querySelector('.overlay-heading h2')?.textContent==='证据与验收存档' && document.querySelector('.archive-tabs button.selected')?.textContent==='Checkpoint' && !!image && image.complete && image.naturalWidth>0; })()`);
    }
    await click('返回工作台');
    await waitFor(() => evaluate<boolean>(`!document.querySelector('.overlay')`), Boolean, 'archive overlay unmounted');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'archive close restores business view');

    await click('DOM 回放');
    await waitFor(() => evaluate<string>(`document.querySelector('.overlay-heading h2')?.textContent || ''`), text => text === 'DOM 基础回放', 'real rrweb replay overlay');
    await waitFor(() => studio.current().view.getVisible(), value => !value, 'replay hides live business view');
    await waitFor(() => evaluate<boolean>(`!!document.querySelector('.replay-stage iframe')?.contentDocument`), Boolean, 'rrweb sandbox iframe constructed');
    const readReplay = () => evaluate<{ sandbox: string; bridgeType: string; hasFixture: boolean; tick: string | null }>(`(() => {
      const iframe=document.querySelector('.replay-stage iframe');
      const doc=iframe?.contentDocument;
      return { sandbox:iframe?.getAttribute('sandbox') || '', bridgeType:typeof iframe?.contentWindow?.studio,
        hasFixture:!!doc?.querySelector('#orders [data-order-id="SYN-001"]') && doc?.querySelector('h1')?.textContent === '合成订单',
        tick:doc?.querySelector('#tick')?.textContent ?? null };
    })()`);
    const sandbox = await readReplay();
    assert.ok(sandbox.sandbox.split(/\s+/).includes('allow-same-origin'), 'The trusted renderer can inspect the isolated replay DOM');
    assert.equal(sandbox.sandbox.split(/\s+/).includes('allow-scripts'), false, 'Recorded site scripts must not execute in the replay iframe');
    assert.equal(sandbox.bridgeType, 'undefined', 'The replay iframe must not receive the trusted window.studio preload bridge');
    await click('播放', `document.querySelector('.replay-toolbar')`);
    await waitFor(() => evaluate<boolean>(`!!document.querySelector('.replay-toolbar .badge.running')`), Boolean, 'replay play control state');
    const firstReplay = await waitFor(readReplay, value => value.hasFixture && value.tick !== null, 'recorded synthetic order DOM reconstructed', 15000);
    const changedReplay = await waitFor(readReplay, value => value.hasFixture && value.tick !== null && value.tick !== firstReplay.tick, 'rrweb applies recorded tick mutations during playback', 8000);
    assert.equal(changedReplay.bridgeType, 'undefined');
    assert.equal(changedReplay.sandbox.split(/\s+/).includes('allow-scripts'), false);
    await click('暂停', `document.querySelector('.replay-toolbar')`);
    await waitFor(() => evaluate<boolean>(`!!document.querySelector('.replay-toolbar .badge.paused')`), Boolean, 'replay pause control state');
    await delay(100);
    const pausedReplay = await readReplay();
    await delay(250);
    assert.deepEqual(await readReplay(), pausedReplay, 'Paused playback must stop recorded DOM mutation while site scripts remain disabled');
    await captureUi('replay.png', `document.querySelector('.overlay-heading h2')?.textContent==='DOM 基础回放' && !!document.querySelector('.replay-toolbar .badge.paused') && !!document.querySelector('.replay-stage iframe')?.contentDocument?.querySelector('#orders [data-order-id="SYN-001"]')`);
    await click('返回工作台');
    await waitFor(() => evaluate<boolean>(`!document.querySelector('.overlay') && !document.querySelector('.replay-stage iframe')`), Boolean, 'replayer and sandbox iframe removed on close');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'replay close restores live business view');
  }
  console.log('UI PASS: real React/IPC, native bounds, explicit control, archive screenshot, sandboxed rrweb play/pause and replay screenshot');
}
