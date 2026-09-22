import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '../../src/main/services/studio';
import { captureUiFrame, runUiLayoutScenarios, setUiTheme } from './ui-layout';

/** Exercise persisted judgments and project-scoped comparisons using a completed synthetic validation. */
export async function runReviewUiScenarios(studio: Studio): Promise<void> {
  const candidate = studio.state().validations.find(candidate => candidate.validation?.overall === 'fail' && candidate.validation.requirements.length);
  assert.ok(candidate, 'Review UI needs an actual failed validation from the runner scenarios');
  const record = await studio.validation(candidate.id);
  assert.ok(record.result, 'Review UI requires a completed machine report');
  const machineBefore = JSON.stringify(record.result);
  const project = studio.projects.find(candidate => candidate.id === record.projectId)!;
  const profile = studio.profiles.find(candidate => candidate.projectId === project.id)!;
  const foreignProject = studio.projects.find(candidate => candidate.id !== project.id)!;
  const foreignProfile = studio.profiles.find(candidate => candidate.projectId === foreignProject.id)!;
  const key = record.result.validation.requirements[0].checkpointKey;
  if (studio.active) await studio.seal();
  await studio.startRun({ projectId: project.id, profileId: profile.id, url: 'about:blank', kind: 'demonstrate' });
  const ownRunId = studio.required().id;
  await studio.checkpoint({ key, title: '当前项目合成示范', description: '同项目对照说明' }); await studio.seal();
  await studio.startRun({ projectId: foreignProject.id, profileId: foreignProfile.id, url: 'about:blank', kind: 'demonstrate' });
  const foreignRunId = studio.required().id;
  await studio.checkpoint({ key, title: '其他项目合成示范', description: '不应出现的跨项目对照' }); await studio.seal();
  for (let index = 0; index < 21; index++) await studio.review({ id: record.id, verdict: 'reject', reason: `合成历史判定 ${index}`, scope: key });

  const ui = studio.window.window.webContents;
  const evaluate = <T>(expression: string): Promise<T> => ui.executeJavaScript(expression, true);
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(70); }
    const diagnostics = await evaluate<string>(`document.querySelector('.banner.error')?.textContent || document.querySelector('.review-history')?.textContent || document.querySelector('.workspace-heading')?.textContent || ''`);
    throw new Error(`Review UI timed out: ${label}; ${diagnostics}`);
  }
  async function click(label: string, scope = 'document') {
    await waitFor(() => evaluate<boolean>(`(() => {const button=Array.from((${scope})?.querySelectorAll('button') || []).find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return false;if(button.getAttribute('role')==='tab'){button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));}button.click();return true;})()`), Boolean, label);
  }
  async function openReport() {
    await waitFor(() => evaluate<boolean>(`(() => {const select=document.querySelector('select[aria-label="项目"]');if(!select||select.disabled||!Array.from(select.options).some(option=>option.value===${JSON.stringify(project.id)}))return false;select.value=${JSON.stringify(project.id)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`), Boolean, 'select validation project');
    await waitFor(() => evaluate<string>(`document.querySelector('select[aria-label="项目"]')?.value || ''`), value => value === project.id, 'project selected');
    await click('存档', `document.querySelector('.panel-tabs')`);
    const visibleRuns = studio.runs.filter(run => run.projectId === project.id);
    await waitFor(() => evaluate<number>(`document.querySelectorAll('.run-list button').length`), count => count === visibleRuns.length, 'fresh project archive list');
    const index = visibleRuns.findIndex(run => run.id === record.runId);
    assert(index >= 0);
    await evaluate<void>(`document.querySelectorAll('.run-list button')[${index}].click()`);
    await waitFor(() => evaluate<string>(`document.querySelector('.archive-meta code')?.textContent || ''`), value => value === record.runId, 'validation run opened');
    await click('结构化数据 / 验收', `document.querySelector('.archive-tabs')`);
    await evaluate<void>(`document.querySelector('.validation-list button').click()`);
    await waitFor(() => evaluate<number>(`document.querySelectorAll('.review-history .review-entry').length`), count => count === 20, 'initial bounded review page');
  }
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('.native-browser.inactive') && !document.querySelector('select[aria-label="项目"]')?.disabled`), Boolean, 'sealed run reaches the empty workspace');
  await evaluate<void>(`document.querySelector('button[aria-label="新建项目"]').click()`);
  await waitFor(() => evaluate<string>(`document.querySelector('.overlay-heading h2')?.textContent || ''`), value => value === '新建项目', 'new project dialog');
  await evaluate<void>(`(() => {const input=document.querySelector('[placeholder="例如：订单采集验收"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'UI 新建项目');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('创建项目', `document.querySelector('[role="dialog"]')`);
  await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]') && document.querySelector('select[aria-label="项目"]')?.selectedOptions[0]?.textContent === 'UI 新建项目'`), Boolean, 'project created and selected through UI');
  await evaluate<void>(`document.querySelector('button[aria-label="添加环境"]').click()`);
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('input[aria-label="新环境名称"]')`), Boolean, 'new profile dialog');
  await evaluate<void>(`(() => {const input=document.querySelector('input[aria-label="新环境名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'UI 合成环境');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('添加', `document.querySelector('[role="dialog"]')`);
  await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]') && document.querySelector('select[aria-label="登录环境"]')?.selectedOptions[0]?.textContent === 'UI 合成环境'`), Boolean, 'profile created and selected through UI');
  const createdProject = studio.projects.find(item => item.name === 'UI 新建项目');
  assert(createdProject && studio.profiles.some(item => item.name === 'UI 合成环境' && item.projectId === createdProject.id), 'New profile retains the project binding');
  assert(await evaluate<boolean>(`document.querySelectorAll('.checkpoint-card').length === 0 && Array.from(document.querySelectorAll('.evidence-strip button')).every(button=>button.disabled)`), 'New project cannot display or open the previous project\'s workspace evidence');
  await setUiTheme(studio, 'light');
  await captureUiFrame(studio, 'ui-empty-light.png');
  await setUiTheme(studio, 'dark');
  await captureUiFrame(studio, 'ui-empty-dark.png');
  await setUiTheme(studio, 'light');
  await openReport();
  const candidates = await evaluate<string[]>(`Array.from(document.querySelector('[aria-label="同项目人工示范"]').options).map(option=>option.value)`);
  assert(candidates.includes(ownRunId)); assert(!candidates.includes(foreignRunId), 'An identical checkpoint key from another project must not be selectable');
  await evaluate<void>(`(() => {const select=document.querySelector('[aria-label="同项目人工示范"]');select.value=${JSON.stringify(ownRunId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate<string>(`document.querySelector('.comparison')?.textContent || ''`), text => text.includes('同项目对照说明') && !text.includes('不应出现的跨项目对照'), 'same-project comparison');
  await click('下一页人工判定', `document.querySelector('.review-history')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.review-history')?.textContent || ''`), text => text.includes('合成历史判定 20') && !text.includes('合成历史判定 0'), 'review pagination replaces the bounded page');
  const reason = '合成 UI 例外接受：只接受已核对范围；机器失败必须保留。';
  await evaluate<void>(`(() => {const root=document.querySelector('.human-review');const verdict=root.querySelector('select');verdict.value='exception';verdict.dispatchEvent(new Event('change',{bubbles:true}));const scope=root.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(scope,${JSON.stringify(key)});scope.dispatchEvent(new Event('input',{bubbles:true}));const reason=root.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(reason,${JSON.stringify(reason)});reason.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('保存人工判定', `document.querySelector('.human-review')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.review-history')?.textContent || ''`), text => text.includes(reason), 'saved judgment visible immediately');
  assert.equal(JSON.stringify(record.result), machineBefore);
  await click('返回工作台', `document.querySelector('.overlay-heading')`);
  await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]')`), Boolean, 'report closed');
  await openReport(); await click('下一页人工判定', `document.querySelector('.review-history')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.review-history')?.textContent || ''`), text => text.includes(reason) && text.includes('有条件例外接受') && text.includes(key), 'reopened persisted judgment');
  assert.equal(JSON.stringify((await studio.validation(record.id)).result), machineBefore, 'Human exception leaves machine failure intact');
  await evaluate<void>(`(async () => {
    await document.fonts.ready;
    document.querySelector('.review-history').scrollIntoView({block:'center'});
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('Review screenshot did not receive two rendered frames')),3000);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));
    });
  })()`);
  await delay(160);
  assert(await evaluate<boolean>(`document.querySelector('.review-history')?.textContent.includes(${JSON.stringify(reason)})`), 'Review screenshot retains the reopened judgment');
  await captureUiFrame(studio, 'ui-reviews.png');
  await click('返回工作台', `document.querySelector('.overlay-heading')`);
  await setUiTheme(studio, 'dark'); await openReport();
  await click('下一页人工判定', `document.querySelector('.review-history')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.review-history')?.textContent || ''`), text => text.includes(reason), 'dark review retains saved judgment');
  await evaluate<void>(`document.querySelector('.review-history').scrollIntoView({block:'center'})`);
  await captureUiFrame(studio, 'ui-reviews-dark.png');
  await click('返回工作台', `document.querySelector('.overlay-heading')`);
  await setUiTheme(studio, 'light');
  console.log('M5 review UI PASS: append/read/page/reopen, preserved machine failure, project-scoped demonstration comparison');
}

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
    // Radix tabs activate on focus/primary mousedown, not HTMLElement.click().
    await waitFor(() => evaluate<{ clicked: boolean; reason?: string }>(`(() => { const root = ${scope}; if(!root)return {clicked:false,reason:'scope-not-mounted'}; const button = Array.from(root.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) return {clicked:false,reason:'label-not-mounted'}; if(button.disabled)return {clicked:false,reason:'disabled'}; const rect=button.getBoundingClientRect();if(!rect.width||!rect.height)return {clicked:false,reason:'hidden'};if(button.getAttribute('role')==='tab'){button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));}button.click(); return {clicked:true}; })()`), result => result.clicked, `clickable UI button: ${text}`);
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
    await captureUiFrame(studio, filename);
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
    await runUiLayoutScenarios(studio);
    await click('暂停页面输入');
    await waitFor(() => run.locked, Boolean, 'UI locks native input');
    assert.equal(studio.window.mask.getVisible(), true);
    await waitIdle();
    const pausedLease = run.leaseEpoch;
    await setUiTheme(studio, 'dark');
    await click('连接与环境');
    await waitFor(() => studio.current().view.getVisible(), value => !value, 'paused dialog hides the native view');
    await click('返回工作台');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'paused dialog close restores native view');
    assert.equal(run.controller, 'human'); assert.equal(run.leaseEpoch, pausedLease); assert.equal(run.locked, true);
    assert.equal(studio.window.mask.getVisible(), true, 'Closing a presentation dialog retains the existing input lock');
    await setUiTheme(studio, 'light');
    await waitFor(() => evaluate<string>(`document.querySelector('.browser-toolbar').textContent`), text => text.includes('恢复人工输入'), 'pause button updates');
    await click('恢复人工输入');
    await waitFor(() => run.locked, value => !value, 'UI restores native input');
    await waitIdle();
    await click('交给 Agent 控制');
    await waitFor(() => run.controller, value => value === 'agent', 'UI grants explicit agent control');
    assert.equal(studio.window.mask.getVisible(), true);
    await waitIdle();
    const agentLease = run.leaseEpoch;
    await setUiTheme(studio, 'dark'); await click('连接与环境');
    await waitFor(() => studio.current().view.getVisible(), value => !value, 'agent dialog hides native view');
    const managed = studio.current();
    const clicksBeforeDialogAction = await managed.page.$eval('#action-count', element => Number(element.textContent));
    // Ordinary Puppeteer click includes its visibility/IntersectionObserver path.
    // Keep the real dialog open throughout; no DOM click or CSS workaround.
    let actionDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        studio.action({ type: 'click', selector: '#increment', pageId: managed.pageId, generation: managed.navigationGeneration, leaseEpoch: agentLease }),
        new Promise<never>((_resolve, reject) => { actionDeadline = setTimeout(() => reject(new Error('Puppeteer click stalled while a trusted dialog hid the native browser')), 10000); }),
      ]);
    } finally { clearTimeout(actionDeadline); }
    assert.equal(await managed.page.$eval('#action-count', element => Number(element.textContent)), clicksBeforeDialogAction + 1, 'Ordinary agent action progresses while the native view is hidden');
    assert.equal(managed.view.getVisible(), false, 'The action cannot uncover the browser below the dialog');
    assert(await evaluate<boolean>(`document.querySelector('.overlay-heading h2')?.textContent==='连接与已验证环境'`), 'The dialog remains open during hidden-view execution');
    assert.equal(run.controller, 'agent'); assert.equal(run.leaseEpoch, agentLease);
    await click('返回工作台');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'agent dialog close restores native view');
    assert.equal(run.controller, 'agent'); assert.equal(run.leaseEpoch, agentLease);
    assert.equal(studio.window.mask.getVisible(), true, 'Presentation changes retain agent input protection');
    await setUiTheme(studio, 'light');
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
  await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]')`), Boolean, 'close dialog');
  if (run) await waitFor(() => studio.current().view.getVisible(), Boolean, 'native view restored');

  await click('执行', `document.querySelector('.panel-tabs')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.panel-heading h2')?.textContent || ''`), text => text === '受控复跑', 'validation tab');
  assert(await evaluate<boolean>(`!!Array.from(document.querySelectorAll('button')).find(button => button.textContent === '登记脚本目录')`));
  await click('保存点');
  await captureUi('ui.png', `!document.querySelector('[role="dialog"]') && document.querySelector('.panel-heading h2')?.textContent === '保存关键结果' && document.querySelector('.panel-tabs button.selected')?.textContent === '保存点'`);

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
    await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]')`), Boolean, 'archive overlay unmounted');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'archive close restores business view');

    await setUiTheme(studio, 'dark'); await click('打开证据时间线');
    await waitFor(() => evaluate<boolean>(`!!document.querySelector('.checkpoint-archive-list button')`), Boolean, 'dark archive checkpoints');
    await evaluate<void>(`document.querySelector('.checkpoint-archive-list button').click()`);
    await click('screenshot', `document.querySelector('.artifact-actions')`);
    await captureUi('ui-evidence-dark.png', `(() => {const image=document.querySelector('.artifact-view img');return !!image&&image.complete&&image.naturalWidth>0&&document.documentElement.classList.contains('dark');})()`);
    await click('返回工作台');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'dark archive close restores native view');
    await setUiTheme(studio, 'light');

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
    await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]') && !document.querySelector('.replay-stage iframe')`), Boolean, 'replayer and sandbox iframe removed on close');
    await waitFor(() => studio.current().view.getVisible(), Boolean, 'replay close restores live business view');
  }
  console.log('UI PASS: real React/IPC, native bounds, explicit control, archive screenshot, sandboxed rrweb play/pause and replay screenshot');
}
