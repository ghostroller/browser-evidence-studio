import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer, { type ElementHandle } from 'puppeteer-core';
import type { Studio } from '@/main/services/studio';

/** Empty synthetic instance; production UI owns every task, report, and review
 * write. Only standalone workflow input files are authored directly. Faults are
 * bounded pre-commit service delays/refusals, always restored in finally. */
export async function runResultRecoveryJourney(studio: Studio) {
  assert.equal(process.env.BES_TEST, '1');
  assert.equal(path.resolve(studio.root), path.resolve(process.env.BES_DATA || ''));
  assert.equal(studio.projects.length, 0); assert.equal(studio.runs.length, 0);
  const proof = path.join(studio.root, 'result-recovery'); await mkdir(proof);
  const report: any = { passed: false, startedAt: new Date().toISOString(), processId: process.pid, steps: [], pageErrors: [], dialogs: [], faults: [], layouts: [] };
  const save = () => writeFile(path.join(studio.root, 'result-recovery-detail.json'), JSON.stringify(report, null, 2));
  const [port, endpoint] = (await readFile(path.join(studio.root, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${endpoint}`, defaultViewport: null });
  const page = await browser.waitForTarget(t => t.url().includes('/main_window/index.html')).then(t => t.page()); assert(page);
  const window = studio.window.window; window.show(); window.focus();
  page.on('pageerror', error => report.pageErrors.push(error instanceof Error ? error.message : String(error)));
  page.on('dialog', dialog => { report.dialogs.push({ type: dialog.type(), message: dialog.message() }); void save(); });
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><title>结果恢复合成来源</title><style>body{font:22px system-ui;padding:40px}</style><h1>结果恢复合成来源</h1><p data-amount>12.00</p>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalAssess = studio.executions.assess, originalReview = studio.executions.review, originalReplay = studio.materials.replay;
  let releaseFault: (() => void) | undefined;
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeout = 25000): Promise<T> { const end = Date.now() + timeout; let last: T | undefined; while (Date.now() < end) { last = await read(); if (accept(last)) return last; await delay(80); } throw new Error(`Result recovery timeout: ${label}; last=${JSON.stringify(last)}`); }
  async function control(kind: 'button' | 'input' | 'summary', name: string): Promise<ElementHandle<Element>> {
    const value = await page!.waitForFunction((kind, name) => {
      const ok = (e: Element) => !!e.getClientRects().length && !e.closest('[hidden],[inert],fieldset[disabled]') && !(e as HTMLButtonElement).disabled;
      const root = document.querySelector('[role="dialog"]') || document;
      if (kind === 'button') return [...root.querySelectorAll('button')].find(e => ok(e) && (e.textContent?.trim() === name || e.getAttribute('aria-label') === name));
      if (kind === 'summary') return [...root.querySelectorAll('summary')].find(e => ok(e) && e.textContent?.trim().startsWith(name));
      return [...root.querySelectorAll('input,textarea,select')].find(e => ok(e) && (e.getAttribute('aria-label') === name || e.closest('label')?.firstChild?.textContent?.trim() === name));
    }, { timeout: 25000 }, kind, name); const element = value.asElement(); assert(element, name); return element as ElementHandle<Element>;
  }
  async function hit(element: ElementHandle<Element>, clickCount = 1) { await page!.bringToFront(); window.focus(); await element.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'nearest' })); assert(await element.evaluate(e => { const r = e.getBoundingClientRect(), p = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!p && (p === e || e.contains(p)); }), 'Actual visible control receives input'); await element.click({ count: clickCount }); }
  async function click(name: string) { await hit(await control('button', name)); await delay(100); }
  async function fill(name: string, value: string) { const element = await control('input', name); await hit(element); await page!.keyboard.down('Control'); await page!.keyboard.press('a'); await page!.keyboard.up('Control'); await page!.keyboard.press('Backspace'); if (value) await element.type(value); assert.equal(await element.evaluate(e => (e as HTMLInputElement).value), value); }
  async function select(name: string, value: string) { const element = await control('input', name); await (element as ElementHandle<HTMLSelectElement>).select(value); assert.equal(await element.evaluate(e => (e as HTMLSelectElement).value), value); }
  async function disclose(name: string) { const element = await control('summary', name); if (!await element.evaluate(e => (e.parentElement as HTMLDetailsElement).open)) await hit(element); }
  async function hasText(text: string) { await page!.waitForFunction(text => document.body.innerText.includes(text), { timeout: 25000 }, text); }
  async function idle() { await page!.waitForFunction(() => !document.querySelector('.statusbar')?.textContent?.includes('正在处理') && !document.querySelector('.panel-busy')); }
  async function mark(name: string) { report.steps.push({ name, at: new Date().toISOString() }); await save(); console.log('RESULT-RECOVERY ' + name); }
  async function screenshot(name: string) { await page!.screenshot({ path: path.join(proof, name + '.renderer.png') }); }
  async function treeHashes(root: string) { const values: Record<string, string> = {}; async function walk(relative: string) { for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) { const item = path.join(relative, entry.name); if (entry.isDirectory()) await walk(item); else values[item] = hash(await readFile(path.join(root, item))); } } await walk(''); return values; }
  try {
    window.setSize(1450, 935); await page.waitForSelector('.evidence-strip'); await idle();
    await click('新建项目'); await fill('项目名称', '结果上下文与失败恢复'); await fill('目录简介', '报告必须绑定实际选择，失败不能堵住返回'); await click('创建项目'); await idle();
    await click('添加环境'); await fill('环境名称', '无账号合成环境'); await fill('登录入口', origin); await click('创建登录环境'); await idle(); await click('打开环境'); await idle();
    const live = await browser.waitForTarget(t => t.url().startsWith(origin)).then(t => t.page()); assert(live); await live.waitForSelector('[data-amount]');
    const projectId = studio.projects[0].id, profileId = studio.profiles[0].id;
    await click('开始录制'); await until(() => studio.active?.capture, value => value === 'recording', 'real recording ready'); await idle();
    await click('新增保存点'); await page.waitForSelector('.material-card-list button'); if (!await page.$('[aria-label="编辑保存点"]')) await click('编辑保存点');
    await fill('标题', '结果核验的合成例证'); await click('完成保存点编辑'); await idle();
    await click('添加字段'); await fill('字段名', '当前金额'); await fill('明确含义', '合成页面显示的金额文本，用于结果范围与人工判定恢复'); await select('值类型', 'string'); await disclose('高级实现信息'); await fill('数据集', 'orders'); await fill('输出 JSON Pointer', '/amount'); await click('保存字段'); await idle();
    await click('结束并封存'); await until(() => studio.active, value => !value, 'sealed real recording'); await idle();
    const recordingId = studio.runs[0].id, materialRoot = path.join(studio.root, 'projects', projectId, 'materials');
    const catalog = JSON.parse(await readFile(path.join(materialRoot, 'catalog.json'), 'utf8'));
    const draft = await studio.materials.service.getDraft(projectId, catalog.workingDraftId); assert.equal(draft.content.requirements.length, 1); assert.equal(draft.content.requirements[0].dataset, 'orders'); const requirement = draft.content.requirements[0];
    const originals = async () => Object.fromEntries(Object.entries(await treeHashes(path.join(studio.root, 'runs', recordingId))).filter(([name]) => !name.startsWith('replay-index/') && !name.startsWith('index/')));
    const originalHashes = await originals();
    await click('存档'); await click('保存存档版本'); await fill('版本名称', '结果恢复固定版'); await click('确认保存存档版本'); await hasText('已保存存档版本'); await idle();
    const revisions = (await readdir(path.join(materialRoot, 'revisions'))).filter(name => name.endsWith('.json')); assert.equal(revisions.length, 1);
    const fixedFile = path.join(materialRoot, 'revisions', revisions[0]), fixedBytes = await readFile(fixedFile), fixed = JSON.parse(fixedBytes.toString());
    await mark('normal-ui-created-source-requirement-and-fixed-material');

    // Initial archive read refuses once, with unchanged real source bytes.
    let replayRefusals = 0;
    studio.materials.replay = async (...args) => { if (args[0] === recordingId && replayRefusals++ === 0) throw new Error('合成测试：首次历史读取暂不可用'); return originalReplay.apply(studio.materials, args); };
    await click('保存点工作区'); await click('打开历史回放'); await hasText('合成测试：首次历史读取暂不可用'); await screenshot('replay-initial-error-return-available');
    assert(!await (await control('button', '返回实时页面')).evaluate(e => (e as HTMLButtonElement).disabled));
    studio.materials.replay = originalReplay; await click('重新读取历史回放'); await until(() => (studio.replayHost as any).active?.state?.status, value => value === 'ready', 'same source retry ready'); await disclose('页面、事件与资源详情'); await hasText('历史结构可靠'); await click('返回实时页面'); await until(() => page.$('.replay-workspace'), value => !value, 'return from recovered history');
    report.faults.push({ method: 'materials.replay', type: 'one-shot pre-read refusal', recordingId, recoveredThroughUi: true }); await mark('failed-replay-visible-retry-and-return');

    // Hold only archive reads; returning during initial load must reject late UI.
    let heldReads = 0; const heldRead = new Promise<void>(resolve => { releaseFault = resolve; });
    studio.materials.replay = async (...args) => { if (args[0] === recordingId) { heldReads++; await heldRead; } return originalReplay.apply(studio.materials, args); };
    await click('打开历史回放'); await until(() => heldReads, value => value > 0, 'held initial history read'); await click('返回实时页面'); releaseFault!(); releaseFault = undefined; studio.materials.replay = originalReplay;
    await delay(400); assert.equal(await page.$('.replay-workspace'), null); assert(!(studio.replayHost as any).active); assert.equal(studio.state().session?.profileId, profileId); await mark('interrupted-replay-read-cannot-reopen-left-context');

    const workflow = path.join(proof, 'workflow'); await mkdir(workflow); await writeFile(path.join(workflow, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(path.join(workflow, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'result-recovery-ui', driver: 'puppeteer', entry: './run.mjs', exportName: 'run', requirements: [{ id: requirement.id, description: requirement.description, checkpointKey: 'orders', dataset: 'orders' }] }));
    await writeFile(path.join(workflow, 'run.mjs'), `export async function run({page,reporter,steps}) { return steps.run({stepId:'orders',run:async ctx=>{const amount=await page.$eval('[data-amount]',e=>e.textContent);const receipt=await reporter.checkpoint('orders',{requirementIds:[${JSON.stringify(requirement.id)}],stepAttemptId:ctx.identity.attemptId});return{records:[{amount}],sourceRefs:receipt.sourceRefs}},commit:async(value,ctx)=>{const identity={executionId:ctx.identity.executionId,attemptId:ctx.identity.attemptId,datasetId:'orders'};await reporter.beginDataset(identity);await reporter.appendBatch({...identity,batchId:'actual-amount',records:value.records,provenance:{origin:'browser',sourceRefs:value.sourceRefs}});await reporter.finishDataset({...identity,status:'complete',committedBatches:1,committedRecords:1})}}) }`);
    const ordinaryWidth = await page.$eval('.workspace-panel', e => e.getBoundingClientRect().width); const mountedEditor = await page.$('.material-workbench'); assert(mountedEditor);
    await click('实现与结果');
    await until(() => page.$eval('.workspace-panel', e => e.getBoundingClientRect().width), width => width > ordinaryWidth + 100, 'implementation gains focused reading width');
    assert(await mountedEditor.evaluate(e => e.isConnected && e === document.querySelector('.material-workbench')), 'Focused implementation preserves the exact editor');
    const preferencesFile = path.join(studio.root, 'ui-preferences.json');
    const preferences = async (): Promise<{ layout: Record<string, number[]> }> => { try { return JSON.parse(await readFile(preferencesFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { layout: {} }; throw error; } };
    const beforeDrag = await preferences(); const separator = await page.$('[role="separator"][aria-label="调整工作台与浏览器宽度"]'); assert(separator);
    const point = await separator.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x - 35, point.y, { steps: 8 }); await page.mouse.up();
    const afterDrag = await until(preferences, value => !!value.layout['workspace-implementation'], 'user implementation ratio persisted');
    assert.deepEqual(afterDrag.layout.workspace, beforeDrag.layout.workspace); assert.deepEqual(afterDrag.layout['workspace-archive'], beforeDrag.layout['workspace-archive']);
    report.implementationDragPreferences = { before: beforeDrag, after: afterDrag }; await screenshot('implementation-focused-width'); await fill('脚本目录', workflow); await click('登记脚本目录'); await idle(); await select('运行方式', 'current-page-test'); await select('固定任务资料版本', fixed.revisionId); await fill('输入 JSON', '{}');
    await click('运行脚本并验收'); await hasText('执行结果中心');
    const executionId = await until(() => studio.state().validations[0]?.id, Boolean, 'actual execution identity');
    await until(async () => (await studio.executions.summary(projectId, executionId)).status, value => value === 'completed', 'actual worker complete', 60000);
    await click('用于验收'); const storedReports = async () => (await studio.executions.reports(projectId, executionId, { limit: 20, maxBytes: 24576 })).items;
    const assess = async () => { const prior = new Set((await storedReports()).map(item => item.reportId)); await click('按所选 attempt 验收'); const created = await until(async () => (await storedReports()).find(item => !prior.has(item.reportId)), Boolean, 'durable UI report'); await control('button', '按所选 attempt 验收'); await page.waitForSelector('.human-review'); return created!; };
    const first = await assess(), second = await assess();
    assert(await page.$eval('.human-review select', (e, expected) => [...(e as HTMLSelectElement).options].some(option => option.value === expected.id && option.title === expected.id && option.textContent === expected.description), requirement), 'Human review displays the fixed requirement description while retaining its exact ID');
    const openReport = async (id: string) => { const button = await page.waitForFunction(id => [...document.querySelectorAll('.result-center button')].find(e => e.textContent?.startsWith(id.slice(0, 16)) && e.getClientRects().length), {}, id); await hit(button.asElement() as ElementHandle<Element>); await page.waitForFunction(id => document.querySelector('[aria-label="人工判定目标"]')?.textContent?.includes(id), {}, id); };
    const typeReview = async (reason: string) => { await select('需求', requirement.id); await select('判断', 'reject'); await fill('理由', reason); };
    await openReport(first.reportId); await typeReview('仅用于报告 A 的未保存意见'); await openReport(second.reportId);
    assert.equal(await (await control('input', '理由')).evaluate(e => (e as HTMLTextAreaElement).value), ''); assert.equal(await (await control('input', '需求')).evaluate(e => (e as HTMLSelectElement).value), '');
    assert(await page.$eval('.human-review button', e => (e as HTMLButtonElement).disabled));
    const execution = JSON.parse(await readFile(path.join(studio.root, 'executions', executionId, 'host-state.json'), 'utf8')); assert((await page.$eval('[aria-label="本报告数据集范围"]', e => e.textContent))!.includes(execution.datasets[0].attemptId));
    report.identity = { projectId, profileId, recordingId, executionId, fixedRevisionId: fixed.revisionId, fixedContentHash: fixed.contentHash, reports: [first.reportId, second.reportId], dataset: execution.datasets[0] };
    const reportHashes = Object.fromEntries(await Promise.all([first, second].map(async item => [item.reportId, hash(await readFile(path.join(studio.root, 'executions', executionId, `report-${item.reportId}.json`)))])));
    await screenshot('report-scope-and-cleared-review'); await mark('two-real-reports-isolate-unsaved-review-intent');

    let assessments = 0; const gate = new Promise<void>(resolve => { releaseFault = resolve; });
    studio.executions.assess = async (...args) => { if (args[1] === executionId) { assessments++; await gate; } return originalAssess.apply(studio.executions, args); };
    await hit(await control('button', '按所选 attempt 验收'), 2); await until(() => assessments, value => value === 1, 'one actual pending assessment'); await openReport(first.reportId); await screenshot('assessment-pending-other-report');
    assert(await page.$$eval('.result-center button', es => es.some(e => e.textContent === '固定资料验收' && (e as HTMLButtonElement).disabled))); releaseFault!(); releaseFault = undefined;
    await control('button', '按所选 attempt 验收'); studio.executions.assess = originalAssess; assert.equal(assessments, 1); assert.equal((await storedReports()).length, 3); assert((await page.$eval('[aria-label="人工判定目标"]', e => e.textContent))!.includes(first.reportId));
    report.faults.push({ method: 'executions.assess', type: 'one bounded pre-commit delay', calls: assessments, reportsCreated: 1, selectedReportPreserved: first.reportId }); await mark('assessment-repeat-blocked-and-report-switch-releases-busy');

    let reviews = 0; const heldReview = new Promise<void>(resolve => { releaseFault = resolve; });
    studio.executions.review = async (...args) => { if (args[1] === executionId) { reviews++; await heldReview; throw new Error('合成测试：报告 A 迟到拒绝'); } return originalReview.apply(studio.executions, args); };
    await typeReview('报告 A 提交前会失败'); await hit(await control('button', '保存人工判定'), 2); await until(() => reviews, value => value === 1, 'held review once'); assert(await page.$eval('.review-form', e => (e as HTMLFieldSetElement).disabled)); await openReport(second.reportId); await typeReview('报告 B 独立填写的意见'); releaseFault!(); releaseFault = undefined;
    await control('button', '保存人工判定'); assert(!(await page.evaluate(() => document.body.innerText)).includes('报告 A 迟到拒绝')); assert.equal(await (await control('input', '理由')).evaluate(e => (e as HTMLTextAreaElement).value), '报告 B 独立填写的意见');
    studio.executions.review = async () => { throw new Error('合成测试：本报告提交前拒绝'); };
    await click('保存人工判定'); await hasText('本报告提交前拒绝'); assert.equal(await (await control('input', '理由')).evaluate(e => (e as HTMLTextAreaElement).value), '报告 B 独立填写的意见');
    studio.executions.review = originalReview; await click('保存人工判定'); await hasText('人工判定已追加保存');
    const reviewFiles = (await readdir(path.join(studio.root, 'executions', executionId))).filter(name => name.startsWith('review-'));
    assert.equal(reviewFiles.length, 1); const savedReview = JSON.parse(await readFile(path.join(studio.root, 'executions', executionId, reviewFiles[0]), 'utf8')); assert.equal(savedReview.reportId, second.reportId); assert.equal(savedReview.reason, '报告 B 独立填写的意见'); assert.equal(savedReview.materialRevisionId, fixed.revisionId); report.savedReview = savedReview;
    await typeReview('第二次提交前拒绝，不得沿用上次成功提示'); studio.executions.review = async () => { throw new Error('合成测试：第二次判定提交前拒绝'); };
    await click('保存人工判定'); await hasText('第二次判定提交前拒绝'); assert(!(await page.$eval('.human-review', e => e.textContent))!.includes('人工判定已追加保存'));
    studio.executions.review = originalReview; await openReport(first.reportId); await openReport(second.reportId);
    assert.equal((await readdir(path.join(studio.root, 'executions', executionId))).filter(name => name.startsWith('review-')).length, 1);
    await mark('review-late-error-isolated-current-error-retains-input-retry-persists');

    for (const [width, height] of [[1100, 760], [1450, 935]]) {
      window.setSize(width, height); await delay(200); await (await control('input', '理由')).evaluate(e => e.scrollIntoView({ block: 'center' }));
      const layout: { width: number; height: number; pageOverflow: boolean; target?: string | null; scope?: string | null } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, target: document.querySelector('[aria-label="人工判定目标"]')?.textContent, scope: document.querySelector('[aria-label="本报告数据集范围"]')?.textContent })); assert.equal(layout.pageOverflow, false); report.layouts.push(layout); await screenshot(`review-result-${width}`);
    }
    await page.reload(); await page.waitForSelector('.evidence-strip'); await idle(); await click('实现与结果');
    await click('查看需求、数据与验收'); await hasText('执行结果中心'); await openReport(second.reportId);
    assert.equal(await (await control('input', '理由')).evaluate(e => (e as HTMLTextAreaElement).value), ''); assert.equal((await storedReports()).length, 3);
    assert.equal(hash(await readFile(fixedFile)), hash(fixedBytes)); assert.deepEqual(await originals(), originalHashes);
    for (const [id, expected] of Object.entries(reportHashes)) assert.equal(hash(await readFile(path.join(studio.root, 'executions', executionId, `report-${id}.json`))), expected);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.dialogs, []); report.immutableOriginalFixedAndReportsUnchanged = true; await mark('renderer-reload-authoritative-readback-and-immutable-evidence');
    await click('返回工作台'); await click('打开历史回放');
    await until(() => (studio.replayHost as any).active?.state?.status, value => value === 'ready', 'explicit source opens actual current execution history');
    const sourceWidth = await page.$eval('.workspace-panel', e => e.getBoundingClientRect().width);
    assert(Math.abs(sourceWidth - ordinaryWidth) < 3, 'Explicit source navigation restores ordinary pane ratio');
    await click('实现与结果'); // Already selected: no artificial panel state change.
    await click('返回实时页面');
    await until(() => page.$eval('.workspace-panel', e => e.getBoundingClientRect().width), width => width > ordinaryWidth + 100, 'return from source restores implementation focus');
    await click('保存点工作区'); await until(() => page.$eval('.workspace-panel', e => e.getBoundingClientRect().width), width => Math.abs(width - ordinaryWidth) < 3, 'ordinary workspace ratio retained');
    await click('实现与结果'); await click('查看需求、数据与验收'); await openReport(second.reportId);
    report.implementationFocus = { ordinaryWidth, sourceWidth, editorPreserved: true }; await mark('implementation-source-workspace-widths-and-context-restored');
    if (process.env.BES_TEST_VISUAL_HOLD) {
      const hold = path.resolve(process.env.BES_TEST_VISUAL_HOLD); await mkdir(hold, { recursive: true });
      await page.$eval('.result-center', e => e.scrollIntoView({ block: 'start' }));
      await writeFile(path.join(hold, 'visual-ready.json'), JSON.stringify({ processId: process.pid, instanceId: studio.instanceId, dataRoot: studio.root, uiUrl: page.url(), reportId: second.reportId, proofDirectory: proof }, null, 2));
      console.log('RESULT-RECOVERY VISUAL_READY ' + hold);
      await until(async () => { try { await readFile(path.join(hold, 'resume')); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }, Boolean, 'explicit visual review resume', 300000);
      await mark('independent-visual-review-resumed');
    }
    report.passed = true; return report;
  } catch (error) { report.error = String(error); report.stack = error instanceof Error ? error.stack : undefined; try { report.failureText = await page.evaluate(() => document.body.innerText); await screenshot('failure'); } catch {} throw error; }
  finally { releaseFault?.(); studio.executions.assess = originalAssess; studio.executions.review = originalReview; studio.materials.replay = originalReplay; report.finishedAt = new Date().toISOString(); await save(); await browser.disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
