import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '../../src/main/services/studio';
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
  await assert.rejects(studio.releaseHuman(), /Completion check failed/);
  assert.equal(studio.required().controller, 'human', 'No reply or an unfulfilled check must not mean login success');
  await assert.rejects(studio.checkpoint({ key: 'competing-checkpoint' }), /running workflow owns checkpoint/i);
  await studio.current().page.waitForFunction(() => !(document.querySelector('#confirm-login') as HTMLButtonElement)?.disabled);
  await clickSyntheticHuman(studio, '#confirm-login');
  await studio.current().page.waitForSelector('#login-status[data-authenticated="true"]');
  await studio.releaseHuman();
  await waitingHuman(studio, assisted.id, 'confirm-scope');
  assert.equal(studio.current().pageId, loginPageId, 'The managed target remains stable across navigations and handoffs');
  await clickSyntheticHuman(studio, '#confirm-scope');
  await studio.current().page.waitForSelector('#scope-status[data-confirmed="true"]');
  await studio.releaseHuman();
  const assistedResult = (await validationFinished(studio, assisted.id)).result;
  assert.ok(assistedResult);
  assert.equal(assistedResult.validation.overall, 'pass', assistedResult.error);
  assert.deepEqual(assistedResult.humanAttempts.map((attempt: any) => [attempt.id, attempt.status]), [['login', 'completed'], ['confirm-scope', 'completed']]);
  console.log('M3/M5 human flow PASS: explicit native fixture input, real completion checks, two declared assistance points');

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
}
