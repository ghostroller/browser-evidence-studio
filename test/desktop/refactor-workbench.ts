import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import type { ReplayPosition } from '@/contracts/recording';

interface WorkbenchFixture { projectId: string; recordingId: string; replayPosition: ReplayPosition; executionId?: string; targetSelector?: string }

/** Run only under the root desktop lock, after the A/B/C/E/F synthetic chain.
 * Every mutation below originates in the trusted React renderer. The native
 * input targets E's isolated ReplayHost, never the business page. */
export async function runRefactorWorkbenchUi(studio: Studio, fixture: WorkbenchFixture): Promise<void> {
  const ui = studio.window.window.webContents;
  const evaluate = <T>(source: string): Promise<T> => ui.executeJavaScript(source, true);
  const wait = async <T>(read: () => Promise<T>, valid: (value: T) => boolean, name: string): Promise<T> => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await read(); if (valid(value)) return value; await delay(80); }
    const diagnostic = await evaluate<string>(`document.querySelector('.workspace-error')?.textContent || document.querySelector('.overlay-body')?.textContent?.slice(0,300) || document.body.textContent?.slice(0,300) || ''`);
    throw new Error(`Workbench UI timed out: ${name}; ${diagnostic}`);
  };
  const click = async (name: string, scope = 'document') => wait(() => evaluate<boolean>(`(() => {
    const root=${scope};const button=Array.from(root?.querySelectorAll('button')||[]).find(value=>value.textContent.trim()===${JSON.stringify(name)});
    if(!button||button.disabled)return false;button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
    button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));button.click();return true;
  })()`), Boolean, `click ${name}`);
  const clickIncludes = async (name: string, scope = 'document') => wait(() => evaluate<boolean>(`(() => {
    const root=${scope};const button=Array.from(root?.querySelectorAll('button')||[]).find(value=>value.textContent.includes(${JSON.stringify(name)}));
    if(!button||button.disabled)return false;button.click();return true;
  })()`), Boolean, `click ${name}`);
  const fillLabel = async (name: string, value: string) => {
    const found = await evaluate<boolean>(`(() => {const label=Array.from(document.querySelectorAll('.material-editor label')).find(node=>node.textContent.trim().startsWith(${JSON.stringify(name)}));
      const input=label?.querySelector('input,textarea');if(!input)return false;
      const base=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(base,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    assert(found, `UI labeled input missing: ${name}`);
  };
  const openRun = async (runId: string) => {
    await click('存档', `document.querySelector('.panel-tabs')`);
    const index = studio.runs.filter(run => run.projectId === fixture.projectId).findIndex(run => run.id === runId);
    assert(index >= 0, `Run ${runId} was not indexed in the project`);
    await wait(() => evaluate<number>(`document.querySelectorAll('.run-list button').length`), count => count > index, 'project archive list');
    await evaluate<void>(`document.querySelectorAll('.run-list button')[${index}].click()`);
    await wait(() => evaluate<string>(`document.querySelector('.archive-meta code')?.textContent || ''`), value => value === runId, 'requested run archive');
  };
  assert.equal(fixture.replayPosition.recordingId, fixture.recordingId);
  assert.equal(studio.active?.projectId, fixture.projectId, 'Fixture requires a human active run in the recorded project');
  assert.equal(studio.active?.controller, 'human');
  await wait(() => evaluate<string>(`document.querySelector('select[aria-label="项目"]')?.value || ''`), value => value === fixture.projectId, 'selected project');
  await openRun(fixture.recordingId);
  await click('回放此存档', `document.querySelector('.archive-meta')`);
  await wait(() => evaluate<string>(`document.querySelector('.replay-timeline')?.textContent || ''`), text => text.includes('event #'), 'native replay ready');
  const sequence = fixture.replayPosition.eventSeq;
  const alreadyAt = await evaluate<boolean>(`document.querySelector('.replay-timeline')?.textContent?.includes(${JSON.stringify(`event #${sequence}`)}) || false`);
  if (!alreadyAt) await click(`#${sequence}`, `document.querySelector('.replay-sequence')`);
  await wait(() => evaluate<string>(`document.querySelector('.replay-timeline')?.textContent || ''`), text => text.includes(`event #${sequence}`), 'exact replay position');
  await click('任务资料', `document.querySelector('.panel-tabs')`);
  await click('新建', `document.querySelector('.material-list')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.material-editor .material-toolbar code')`), Boolean, 'new draft');
  await fillLabel('标题', 'D fixture checkpoint');
  await click('保存卡片草稿', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<number>(`document.querySelectorAll('.material-card-list button').length`), count => count === 1, 'saved historical checkpoint');
  await clickIncludes('D fixture checkpoint', `document.querySelector('.material-card-list')`);
  await click('复制', `document.querySelector('.material-actions')`);
  await wait(() => evaluate<number>(`document.querySelectorAll('.material-card-list button').length`), count => count === 2, 'independent copied card');
  await fillLabel('需求说明', 'D fixture source requirement');
  await click('保存需求', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<string>(`Array.from(document.querySelectorAll('.material-editor label')).find(node=>node.textContent.trim().startsWith('需求'))?.querySelector('select')?.value || ''`), Boolean, 'requirement saved and selected');
  await click('从历史页绑定元素', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.replay-cancel-selection')`), Boolean, 'history inspection mode');
  const replay = (studio as any).replayHost?.active?.view?.webContents;
  assert(replay, 'The isolated native ReplayHost must exist during inspection');
  replay.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  replay.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => evaluate<boolean>(`!document.querySelector('.replay-cancel-selection')`), Boolean, 'Escape cancels historical selection');
  await click('从历史页绑定元素', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.replay-cancel-selection')`), Boolean, 'inspection re-entered');
  const selector = fixture.targetSelector || '[data-entity="o-1"] [data-field="amount"]';
  const point: { x: number; y: number } = await replay.executeJavaScript(`(() => {
    const frame=document.querySelector('#replay iframe'),element=frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    if(!frame||!element)throw new Error('Synthetic replay target is absent');
    const a=frame.getBoundingClientRect(),b=element.getBoundingClientRect();
    const sx=a.width/(frame.contentWindow?.innerWidth||frame.clientWidth||a.width),sy=a.height/(frame.contentWindow?.innerHeight||frame.clientHeight||a.height);
    return {x:Math.round(a.left+(b.left+b.width/2)*sx),y:Math.round(a.top+(b.top+b.height/2)*sy)};
  })()`);
  replay.sendInputEvent({ type: 'mouseMove', ...point });
  replay.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  replay.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await wait(() => evaluate<boolean>(`!!document.querySelector('.material-editor .material-actions .muted')`), Boolean, 'historical DOM target returned to field editor');
  await fillLabel('数据集', 'orders'); await fillLabel('字段名', 'amount'); await fillLabel('明确含义', '页面显示的订单金额');
  await click('保存字段', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<string>(`document.querySelector('.material-workbench .notice')?.textContent || ''`), text => text.includes('字段和需求关联已保存'), 'bound field without annotation');
  assert(await evaluate<boolean>(`!!document.querySelector('.material-editor .material-actions .muted')`), 'Historical target remains selected without an annotation');
  await click('任务授权', `document.querySelector('.topbar')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.task-authorizations')`), Boolean, 'task authorization dialog');
  const priorGrantIds = new Set(((studio as any).tasks.list(fixture.projectId) as Array<{ authorizationId: string }>).map(item => item.authorizationId));
  await evaluate<void>(`(() => {const box=Array.from(document.querySelectorAll('.task-capabilities label')).find(item=>item.textContent.includes('读取当前页面'))?.querySelector('input');
    if(!box)throw new Error('page-read capability missing');box.click();})()`);
  await click('授予这次任务', `document.querySelector('.task-authorizations')`);
  const issued = await wait(async () => ((studio as any).tasks.list(fixture.projectId) as Array<{ authorizationId: string; status: string; pages: unknown[]; origins: string[] }>).find(item => !priorGrantIds.has(item.authorizationId)), Boolean, 'trusted UI grant issued');
  assert(issued, 'Trusted UI did not create a task authorization');
  assert(issued.status === 'active' && issued.pages.length > 0 && issued.origins.length > 0, 'Browser grant retains page and origin scope');
  await wait(() => evaluate<boolean>(`!!Array.from(document.querySelectorAll('.task-grant')).find(node=>node.textContent.includes(${JSON.stringify(issued.authorizationId)}))?.querySelector('button')`), Boolean, 'new grant card visible');
  await click('撤销此授权', `Array.from(document.querySelectorAll('.task-grant')).find(node=>node.textContent.includes(${JSON.stringify(issued.authorizationId)}))`);
  await wait(async () => (studio as any).tasks.get(issued.authorizationId).status, status => status === 'revoked', 'trusted UI revocation');
  await click('返回工作台', `document.querySelector('.overlay-heading')`);
  if (fixture.executionId) {
    const record = studio.state().validations.find((item: any) => item.executionId === fixture.executionId);
    assert(record, 'Fixed execution must be discoverable in the archive index');
    await openRun(record.runId);
    await click('结构化数据 / 验收', `document.querySelector('.archive-tabs')`);
    await wait(() => evaluate<number>(`document.querySelectorAll('.validation-list button').length`), count => count > 0, 'validation list');
    const index = studio.state().validations.filter((item: any) => item.runId === record.runId).findIndex((item: any) => item.id === record.id);
    assert(index >= 0);
    await evaluate<void>(`document.querySelectorAll('.validation-list button')[${index}].click()`);
    await wait(() => evaluate<string>(`document.querySelector('.result-center code')?.textContent || ''`), value => value === fixture.executionId, 'fixed result center');
    await wait(() => evaluate<boolean>(`!!document.querySelector('.result-summary')`), Boolean, 'actual bound result summary');
  }
  console.log('D trusted workbench UI PASS: exact historical replay, draft card/copy, bound field, inspection Escape, task grant/revoke, fixed results');
}
