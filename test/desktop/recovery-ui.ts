import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import { EvidenceStore } from '@/evidence/store';
import { registerValidation } from '@/main/services/validation-lifecycle';
import { fingerprintInput, fingerprintWorkflow, loadWorkflow } from '@/runner/fingerprint';
import { captureUiFrame, setUiTheme } from './ui-layout';

/** Synthetic files and the real trusted renderer; this never opens an account profile. */
export async function runRecoveryUiScenarios(studio: Studio): Promise<void> {
  if (studio.active) await studio.seal();
  const directory = path.resolve('examples/orders');
  const project = await studio.createProject({ name: '异常存档恢复合成验证', objective: '保存证据、确认所有权并从新运行重试', scriptDirectory: directory });
  const profile = await studio.createProfile({ projectId: project.id, name: '恢复专用合成环境' });
  const runId = randomUUID(), validationId = randomUUID(), runDir = path.join(studio.root, 'runs', runId);
  const store = await EvidenceStore.create(runDir, { id: runId, projectId: project.id, profileId: profile.id, kind: 'validate', mode: 'synthetic', objective: project.objective });
  const { manifest, entryPath } = await loadWorkflow(directory);
  await registerValidation(store, { id: validationId, runId, projectId: project.id, profileId: profile.id, directory }, { manifest, entryPath, startedAt: new Date().toISOString(), inputSha256: fingerprintInput({ synthetic: true }), fingerprintBefore: await fingerprintWorkflow(directory, path.resolve('package-lock.json')) });
  const checkpoint = await store.appendCheckpoint({ key: 'retained-before-interruption', title: '中断前已保存的合成 checkpoint', description: '恢复必须保留此记录', requirementIds: [], captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), captureConsistency: 'consistent', artifactRefs: [] });
  const lock = JSON.parse(await readFile(path.join(runDir, 'writer.lock'), 'utf8'));
  await store.close();
  // The real ownership checker must confirm this synthetic PID is no longer running.
  lock.pid = 2147483647; await writeFile(path.join(runDir, 'writer.lock'), JSON.stringify(lock));
  studio.runs.unshift({ id: runId, status: 'unreadable', error: 'Synthetic exited writer; project identity not yet loaded' });
  const corruptId = randomUUID(), corruptDir = path.join(studio.root, 'runs', corruptId);
  const corruptStore = await EvidenceStore.create(corruptDir, { id: corruptId, projectId: project.id, kind: 'demonstrate', mode: 'synthetic', objective: 'Corrupt ownership must remain untouched' });
  await corruptStore.close(); await writeFile(path.join(corruptDir, 'writer.lock'), '{synthetic incomplete ownership');
  studio.runs.unshift({ id: corruptId, status: 'unreadable', error: 'Synthetic corrupt writer marker' });
  await studio.refreshValidations(); studio.onChanged();

  const ui = studio.window.window.webContents;
  const evaluate = <T>(expression: string): Promise<T> => ui.executeJavaScript(expression, true);
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(70); }
    const diagnostics = await evaluate<string>(`document.querySelector('[role="dialog"]')?.textContent || document.querySelector('.banner.error')?.textContent || ''`);
    throw new Error(`Recovery UI timed out: ${label}; ${diagnostics.slice(0, 1600)}`);
  }
  async function click(label: string, scope = 'document') {
    await waitFor(() => evaluate<boolean>(`(() => {const button=Array.from((${scope})?.querySelectorAll('button')||[]).find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return false;if(button.getAttribute('role')==='tab'){button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));}button.click();return true;})()`), Boolean, label);
  }
  async function openRecovery(id: string) {
    await click('存档', `document.querySelector('.panel-tabs')`);
    await waitFor(() => evaluate<boolean>(`(() => {const button=document.querySelector('.recovery-run[data-run-id="${id}"]');if(!button)return false;if(button.getAttribute('role')==='tab'){button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));}button.click();return true;})()`), Boolean, 'orphan archive recovery entry');
    await waitFor(() => evaluate<boolean>(`!!document.querySelector('.run-recovery[data-run-id="${id}"] [data-lock-state]')`), Boolean, 'ownership inspection');
  }
  async function screenshot(filename: string) {
    await evaluate<void>(`(async()=>{await document.fonts.ready;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No recovery UI frame')),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});})()`);
    await captureUiFrame(studio, filename);
  }

  await setUiTheme(studio, 'light'); await openRecovery(corruptId);
  assert.equal(await evaluate<string>(`document.querySelector('.run-recovery [data-lock-state]').getAttribute('data-lock-state')`), 'corrupt');
  assert.equal(await evaluate<boolean>(`Array.from(document.querySelectorAll('.run-recovery button')).some(button=>button.textContent==='安全恢复存档'||button.textContent==='重建可读索引')`), false);
  await click('重新检查', `document.querySelector('.run-recovery')`);
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('.run-recovery [data-lock-state="corrupt"]')`), Boolean, 'corrupt ownership remains visible');
  assert.equal(await readFile(path.join(corruptDir, 'writer.lock'), 'utf8'), '{synthetic incomplete ownership');
  await screenshot('ui-recovery-refused.png'); await click('返回工作台', `document.querySelector('.overlay-heading')`);
  await setUiTheme(studio, 'dark'); await openRecovery(corruptId);
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('.run-recovery [data-lock-state="corrupt"]')`), Boolean, 'dark recovery preserves refusal');
  await screenshot('ui-recovery-refused-dark.png'); await click('返回工作台', `document.querySelector('.overlay-heading')`);
  await setUiTheme(studio, 'light');

  await openRecovery(runId);
  assert.equal(await evaluate<string>(`document.querySelector('.run-recovery [data-lock-state]').getAttribute('data-lock-state')`), 'dead');
  await click('安全恢复存档', `document.querySelector('.run-recovery')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.run-recovery')?.textContent || ''`), text => text.includes('存档已恢复为可读状态'), 'safe archive recovery');
  assert.equal(studio.active, undefined, 'Archive recovery must not regain browser control');
  const restored = await studio.validation(validationId); assert.equal(restored.status, 'interrupted'); assert.equal(restored.result, undefined);
  assert((await studio.reader(runId).checkpoints()).items.some((item: any) => item.id === checkpoint.id));
  await click('查看已保存材料', `document.querySelector('.run-recovery')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.archive-meta code')?.textContent || ''`), value => value === runId, 'restored archive');
  await click('结构化数据 / 验收', `document.querySelector('.archive-tabs')`);
  await waitFor(() => evaluate<boolean>(`(() => {const button=document.querySelector('.validation-list button');if(!button)return false;if(button.getAttribute('role')==='tab'){button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,ctrlKey:false}));button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));}button.click();return true;})()`), Boolean, 'interrupted validation available');
  await waitFor(() => evaluate<string>(`document.querySelector('.interrupted-validation')?.textContent || ''`), text => text.includes('执行未形成完整验收报告') && text.includes('1 个 checkpoint'), 'interrupted report and retained checkpoint count');
  await screenshot('ui-recovery-interrupted.png');
  await click('查看已有 checkpoint', `document.querySelector('.interrupted-validation')`);
  await waitFor(() => evaluate<string>(`document.querySelector('.checkpoint-archive-list')?.textContent || ''`), text => text.includes('中断前已保存的合成 checkpoint'), 'retained checkpoint accessible');
  await click('结构化数据 / 验收', `document.querySelector('.archive-tabs')`);
  await click('准备新运行重试', `document.querySelector('.interrupted-validation')`);
  await waitFor(() => evaluate<boolean>(`!document.querySelector('[role="dialog"]') && document.querySelector('.panel-heading h2')?.textContent==='受控复跑'`), Boolean, 'fresh-run setup');
  assert.equal(studio.active, undefined, 'Preparing a retry does not resume the interrupted execution');
  console.log('RECOVERY UI PASS: corrupt marker refused, orphan archive visible, dead writer recovered, interrupted validation and checkpoint readable, fresh retry setup');
}
