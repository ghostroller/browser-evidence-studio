import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { EvidenceReader } from '@/evidence/reader';
import { clickSyntheticHuman } from './native-input';

async function waitUntil<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 90_000): Promise<T> {
  const expires = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < expires) {
    last = await read();
    if (accept(last)) return last;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${label}; last status=${JSON.stringify(last).slice(0,1200)}`);
}

async function validationFinished(studio: Studio, id: string) {
  return waitUntil(() => studio.validation(id), record => ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status) && Boolean(record.artifactId || record.error), 'persisted validation result');
}

async function waitingHuman(studio: Studio, id: string, point: string) {
  await waitUntil(async () => {
    const validation = await studio.validation(id);
    if (['failed', 'cancelled', 'interrupted'].includes(validation.status)) throw new Error(`Workflow failed before ${point}: ${validation.result?.error ?? validation.error}`);
    return studio.state().active;
  }, state => state?.handoff?.status === 'waiting' && state.handoff.id === point, `${point} human window`);
  assert.equal(studio.required().controller, 'human');
  assert.equal(studio.required().capture, 'recording');
  assert.equal(studio.required().locked, false);
}

/** Hold persistence to make a duplicate release overlap the first check reliably. */
async function releaseHumanConcurrently(studio: Studio, handoffId: string) {
  const run = studio.required(), page = studio.current().page;
  const originalAppend = run.store.appendEvent, originalEvaluate = page.$eval;
  let releasePersistence!: () => void;
  const persistenceBlocked = new Promise<void>(resolve => { releasePersistence = resolve; });
  let completionWrites = 0, completionChecks = 0, entered = false, firstError: unknown;
  const selector = run.handoff.completionCheck.selector;
  run.store.appendEvent = async function(event) {
    if (event.type === 'handoff-completed' && (event.data as { id?: string } | undefined)?.id === handoffId) {
      completionWrites += 1;
      entered = true;
      await persistenceBlocked;
    }
    return originalAppend.call(this, event);
  };
  page.$eval = (async (...args: Parameters<typeof originalEvaluate>) => {
    if (args[0] === selector) completionChecks += 1;
    return originalEvaluate.apply(page, args);
  }) as typeof page.$eval;
  const initialEpoch = run.leaseEpoch;
  const first = studio.releaseHuman(handoffId);
  // Attach a rejection observer immediately, including failures before the barrier.
  const settled = first.then(() => {}, error => { firstError = error; });
  try {
    await waitUntil(() => entered || firstError !== undefined, Boolean, 'first handoff completion persistence', 5000);
    if (firstError) throw firstError;
    assert.equal(run.locked, true, 'The first completion check must still own the input lock');
    const second = studio.releaseHuman(handoffId);
    const results = Promise.allSettled([first, second]);
    releasePersistence();
    const outcomes = await results;
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'fulfilled', outcome.status === 'rejected' ? String(outcome.reason) : undefined);
    }
    const result = await first;
    assert.deepEqual(await second, result, 'Concurrent releases of one handoff must share the same successful result');
    assert.equal(completionChecks, 1, 'Duplicate releases must not re-evaluate the completion condition');
    assert.equal(completionWrites, 1, 'Duplicate releases must persist exactly one completion event');
    assert.equal(run.leaseEpoch, initialEpoch + 1, 'Duplicate releases must transfer ownership only once');
    assert.deepEqual(await studio.releaseHuman(handoffId), result, 'A late retry after successful release must be idempotent');
    assert.equal(run.leaseEpoch, initialEpoch + 1);
    return result;
  } finally {
    releasePersistence();
    await settled;
    run.store.appendEvent = originalAppend;
    page.$eval = originalEvaluate;
  }
}

/** Called inside the real Electron desktop harness after the M0 baseline. */
export async function runRunnerScenarios(studio: Studio, siteUrl: string) {
  if (studio.active) await studio.seal();
  const project = await studio.createProject({ name: '原生脚本与验收合成测试', objective: '分页、身份、人工交接及取消的实际 worker 验收', scriptDirectory: path.resolve('examples/orders') });
  const profile = await studio.createProfile({ projectId: project.id, name: 'Runner 独立合成环境' });
  assert.equal(studio.active, undefined, 'A registered project and profile must be sufficient to start validation from idle');

  const runIds = new Set<string>();
  for (const variant of ['normal', 'duplicate', 'wrong-image', 'missing', 'empty-middle']) {
    if (variant === 'normal' || variant === 'duplicate') assert.equal(studio.active, undefined, `${variant} must start without a preparation recording`);
    const started = await studio.validate({ projectId: project.id, profileId: profile.id, input: { baseUrl: siteUrl, variant } });
    assert.equal(studio.required().projectId, project.id);
    assert.equal(studio.required().profileId, profile.id);
    assert.equal(studio.required().store.manifest.kind, 'validate');
    assert.ok(!runIds.has(started.runId), 'Every execution must get its own run and evidence boundary');
    runIds.add(started.runId);
    const record = await validationFinished(studio, started.id);
    const result = record.result;
    assert.ok(result, `Missing execution result for ${variant}: ${record.error}`);
    assert.equal(record.currentVersion, 'matched');
    assert.ok(result.runtimeNodeVersion, 'The actual worker must report its embedded Node runtime');
    if (variant === 'normal' || variant === 'duplicate') {
      assert.equal(result.status, 'completed', `${variant}: ${result.error}`);
      assert.equal(result.validation.overall, 'pass', `${variant}: ${JSON.stringify(result.validation)}`);
      assert.equal(result.datasets.find((dataset: any) => dataset.name === 'orders')?.records.length, 7);
      assert.equal(result.datasets.find((dataset: any) => dataset.name === 'details')?.records.length, 7);
    } else {
      assert.equal(result.validation.overall, 'fail', `Broken ${variant} data must fail acceptance`);
      assert.ok(result.validation.requirements.some((requirement: any) => requirement.checks.some((check: any) => check.verdict === 'fail')) || result.status === 'failed');
    }
    assert.equal(studio.required().controller, 'human');
    assert.equal(studio.required().locked, false);
    console.log(`M5 runner ${variant}: execution=${result.status}, acceptance=${result.validation.overall}`);
    if (variant === 'normal') {
      await studio.seal();
      assert.equal(studio.active, undefined, 'Sealing a validation must allow the same project and profile to start another one directly');
    }
  }

  const assisted = await studio.validate({ input: { baseUrl: siteUrl, variant: 'normal', requireLogin: true, requireHumanReview: true } });
  await waitingHuman(studio, assisted.id, 'login');
  const loginPageId = studio.current().pageId;
  const loginHandoffId = studio.required().handoff.handoffId as string;
  await assert.rejects(studio.releaseHuman(), /Completion check failed/);
  assert.equal(studio.required().controller, 'human', 'No reply or an unfulfilled check must not mean login success');
  await assert.rejects(studio.checkpoint({ key: 'competing-checkpoint' }), /running workflow owns checkpoint/i);
  await studio.current().page.waitForFunction(() => !(document.querySelector('#confirm-login') as HTMLButtonElement)?.disabled);
  await clickSyntheticHuman(studio, '#confirm-login');
  await studio.current().page.waitForSelector('#login-status[data-authenticated="true"]');
  const beforeNavigation = studio.current().navigationGeneration;
  await clickSyntheticHuman(studio, '#navigate-login');
  await waitUntil(async () => {
    const validation = await studio.validation(assisted.id);
    if (['failed', 'cancelled', 'interrupted'].includes(validation.status)) throw new Error(`Workflow failed during human-owned navigation: ${validation.result?.error ?? validation.error}`);
    return studio.current().navigationGeneration > beforeNavigation && new URL(studio.current().page.url()).searchParams.has('after-handoff-worker');
  }, Boolean, 'human-owned worker creation and document navigation', 15000);
  await studio.current().page.waitForSelector('#login-status[data-authenticated="true"]');
  await waitingHuman(studio, assisted.id, 'login');
  assert.equal(studio.required().handoff.handoffId, loginHandoffId, 'Navigation must retain the awaiting human request');
  const loginRelease = await releaseHumanConcurrently(studio, loginHandoffId);
  await waitingHuman(studio, assisted.id, 'confirm-scope');
  assert.equal(studio.current().pageId, loginPageId, 'The managed target remains stable across navigations and handoffs');
  const scopeHandoffId = studio.required().handoff.handoffId as string;
  const scopeEpoch = studio.required().leaseEpoch;
  assert.notEqual(scopeHandoffId, loginHandoffId);
  assert.deepEqual(await studio.releaseHuman(loginHandoffId), loginRelease, 'An old completed handoff may be replayed without applying it to the current one');
  assert.equal(studio.required().handoff.handoffId, scopeHandoffId);
  assert.equal(studio.required().handoff.status, 'waiting');
  assert.equal(studio.required().controller, 'human');
  assert.equal(studio.required().locked, false);
  assert.equal(studio.required().leaseEpoch, scopeEpoch, 'A previous handoff ID cannot release the next human window');
  await clickSyntheticHuman(studio, '#confirm-scope');
  await studio.current().page.waitForSelector('#scope-status[data-confirmed="true"]');
  await studio.releaseHuman(scopeHandoffId);
  const assistedResult = (await validationFinished(studio, assisted.id)).result;
  assert.ok(assistedResult);
  assert.equal(assistedResult.validation.overall, 'pass', assistedResult.error);
  assert.deepEqual(assistedResult.humanAttempts.map((attempt: any) => [attempt.id, attempt.status]), [['login', 'completed'], ['confirm-scope', 'completed']]);
  const handoffReader = new EvidenceReader(studio.required().store.runDir);
  const handoffSequence = Number((await handoffReader.summary()).lastSequence);
  let handoffCursor: string | undefined, completedHandoffs = 0, controlConflicts = 0;
  for (let page = 0; page < 50; page++) {
    const events = await handoffReader.events({ types: ['handoff-completed', 'control-conflict'], fields: ['type'],
      toSequence: handoffSequence, cursor: handoffCursor, limit: 20, maxBytes: 4096 });
    for (const event of events.items) {
      const type = (event as { type: string }).type;
      if (type === 'handoff-completed') completedHandoffs++;
      if (type === 'control-conflict') controlConflicts++;
    }
    if (!events.nextCursor) { handoffCursor = undefined; break; }
    assert.notEqual(events.nextCursor, handoffCursor, 'The bounded handoff query must advance its cursor');
    handoffCursor = events.nextCursor;
  }
  assert.equal(handoffCursor, undefined, 'The handoff event audit must finish within 50 bounded pages');
  assert.equal(controlConflicts, 0, 'Puppeteer target maintenance during human navigation is not a workflow control violation');
  assert.equal(completedHandoffs, 2, 'Each assistance point has one persisted completion');
  console.log('M3/M5 human flow PASS: native input, worker/document changes during handoff, idempotent release, two declared assistance points');

  const cancelled = await studio.validate({ input: { baseUrl: siteUrl, variant: 'normal', requireHumanReview: true } });
  await waitingHuman(studio, cancelled.id, 'confirm-scope');
  const retainedPage = studio.current();
  await studio.stopRunner();
  const cancelledResult = (await validationFinished(studio, cancelled.id)).result;
  assert.ok(cancelledResult);
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal(cancelledResult.validation.overall, 'fail');
  assert.equal(studio.required().controller, 'human');
  assert.equal(studio.required().locked, false);
  assert.equal(retainedPage.view.webContents.isDestroyed(), false, 'Cancellation preserves the observed page for diagnosis');
  await delay(200);
  assert.equal(studio.required().execution, 'cancelled');
  await retainedPage.capture.flush();
  await studio.seal();
  console.log('M5 cancel PASS: worker exited, result persisted, human ownership restored, captured page retained');

  // Use real Puppeteer and the bundled worker, with a registered fixture kept
  // inside this synthetic data root. Existing business examples stay untouched.
  const failureDirectory = await mkdtemp(path.join(studio.root, 'runner-close-fixture-'));
  await writeFile(path.join(failureDirectory, 'workflow.json'), JSON.stringify({
    schemaVersion: 1, workflowId: 'synthetic-worker-close', entry: './run.mjs', exportName: 'run', driver: 'puppeteer',
    requirements: [{ id: 'collected-before-close', checkpointKey: 'before-close', description: 'Retain completed work when the real worker later fails',
      dataset: 'collected', rules: [{ type: 'min-rows', count: 1 }, { type: 'required', field: 'title' }, { type: 'required', field: 'text' }] }],
  }, null, 2));
  await writeFile(path.join(failureDirectory, 'run.mjs'), `
    export async function run({ page, input, reporter }) {
      await page.goto(input.baseUrl + '/lab', { waitUntil: 'domcontentloaded' });
      const record = { title: await page.title(), text: await page.$eval('#lab-result', element => element.textContent) };
      const checkpoint = await reporter.checkpoint('before-close', { title: 'Synthetic data before worker failure' });
      await reporter.emitData('collected', [record], { origin: 'browser', sourceRefs: [checkpoint.id] });
      if (input.failure === 'selector-timeout') {
        await page.waitForSelector('#synthetic-never-present', { timeout: 80 });
      } else {
        await page.browser().disconnect();
        await new Promise(() => {});
      }
    }
  `);
  const failureProject = await studio.createProject({ name: 'Worker 原始异常与本地断开', objective: '保留真实 Puppeteer 错误和已完成证据；无终态断开不得通过', scriptDirectory: failureDirectory });
  const failureProfile = await studio.createProfile({ projectId: failureProject.id, name: 'Worker 断开独立合成环境' });
  for (const failure of ['selector-timeout', 'disconnect-without-result']) {
    const started = await studio.validate({ projectId: failureProject.id, profileId: failureProfile.id, input: { baseUrl: siteUrl, failure } });
    const record = await validationFinished(studio, started.id);
    const result = record.result;
    assert.ok(result, `Missing persisted worker result for ${failure}: ${record.error}`);
    assert.equal(result.status, 'failed', `${failure} cannot complete successfully`);
    assert.equal(result.validation.overall, 'fail', 'A retained dataset does not turn a failed execution into a pass');
    assert.equal(result.operationTransportClose?.trigger, 'worker', 'Puppeteer disconnect is a worker-origin close, not a remote transport loss');
    assert.doesNotMatch(result.error ?? '', /Operation transport disconnected/);
    if (failure === 'selector-timeout') {
      assert.equal(result.errorSource, 'worker');
      assert.match(result.error ?? '', /synthetic-never-present/, 'The original Puppeteer selector error must survive disconnect cleanup');
      assert.match(result.error ?? '', /timeout|waiting for selector/i);
    }
    const dataset = result.datasets.find(dataset => dataset.name === 'collected');
    const checkpoint = result.checkpoints.find(checkpoint => checkpoint.key === 'before-close');
    assert.ok(dataset && checkpoint, 'Successful data and checkpoint reports must remain in the failed execution');
    assert.deepEqual(dataset.records, [{ title: '证据实验 · 合成站点', text: '点击触发采集' }]);
    assert.deepEqual(dataset.sourceRefs, [checkpoint.id], 'The retained dataset must reference its actual checkpoint');
    assert.equal(result.validation.coverageVerdict, 'pass');
    assert.equal(result.validation.assertionVerdict, 'pass');
    assert.equal(record.currentVersion, 'matched');
    assert.equal(studio.required().controller, 'human');
    assert.equal(studio.required().locked, false);
    assert.equal(studio.current().view.webContents.isDestroyed(), false, 'Disconnecting the worker must retain the observed page');
    await studio.seal();
    console.log(`M5 worker close PASS: ${failure}, original error and prior evidence retained, acceptance failed`);
  }
}
