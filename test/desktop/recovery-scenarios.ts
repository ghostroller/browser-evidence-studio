import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import type { ValidationRecord } from '@/main/services/validation-lifecycle';
import { atomicJson, safeFile } from '@/evidence/files';
import { evidenceSources } from '@/evidence/index';
import { EvidenceReader } from '@/evidence/reader';
import { startFixture } from '../fixtures/site';

const stages = ['registered-before-worker', 'running', 'waiting-human', 'report-before-terminal', 'terminal-before-catalog'];

/** Available only through the app's synthetic desktop phase, never through public IPC/HTTP. */
export function recoveryObserver(root: string, onCut: (stage: string) => Promise<void>) {
  const wanted = process.env.BES_RECOVERY_STAGE;
  assert.ok(stages.includes(wanted || ''), 'The crash stage must be a declared synthetic boundary');
  return async (stage: string, context: { validationId: string; runId: string; projectId: string; profileId: string; reportId?: string }) => {
    if (stage !== wanted) return;
    const report = context.reportId ? await new EvidenceReader(path.join(root, 'runs', context.runId)).artifactMetadata(context.reportId) : undefined;
    await atomicJson(path.join(root, 'recovery-cut.json'), { ...context, report: report ? { id: report.id, sha256: report.sha256, bytes: report.capturedBytes } : undefined, stage, processId: process.pid, at: new Date().toISOString() });
    await onCut(stage);
    process.stdout.write('BES_RECOVERY_READY\n');
    // The parent terminates precisely this Electron process after checking the marker.
    await new Promise<void>(() => {});
  };
}

export async function runRecoveryCrash(studio: Studio): Promise<void> {
  const site = await startFixture();
  const project = await studio.createProject({ name: '异常恢复合成验收', objective: '强杀后保留已确认材料与真实验收状态', scriptDirectory: path.resolve('examples/orders') });
  const profile = await studio.createProfile({ projectId: project.id, name: '恢复测试独立环境' });
  await studio.startRun({ projectId: project.id, profileId: profile.id, url: site.url + '/orders', kind: 'validate' });
  const run = studio.required();
  const checkpoint = await studio.checkpoint({ key: 'acknowledged-before-crash', title: '强杀前已确认保存' });
  assert.equal(checkpoint.metadata?.captureStatus, 'complete');
  const artifacts = await Promise.all(checkpoint.artifactRefs.map(id => studio.reader(run.id).artifactMetadata(id)));
  await atomicJson(path.join(studio.root, 'recovery-seed.json'), { processId: process.pid, projectId: project.id,
    profileId: profile.id, runId: run.id, checkpointId: checkpoint.id,
    artifacts: artifacts.map(artifact => ({ id: artifact.id, sha256: artifact.sha256, bytes: artifact.capturedBytes })) });
  const started = await studio.validate({ projectId: project.id, profileId: profile.id,
    input: { baseUrl: site.url, variant: 'normal', ...(process.env.BES_RECOVERY_STAGE === 'waiting-human' ? { requireLogin: true } : {}) } });
  // Other cut points occur asynchronously after validate returns. A premature
  // terminal outcome is a test failure, never a successful crash experiment.
  for (;;) {
    const record = await studio.validation(started.id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) throw new Error('Validation ended before the requested crash boundary: ' + record.status);
    await delay(50);
  }
}

async function originalHashes(runDir: string) {
  const result = [];
  for (const source of await evidenceSources(runDir)) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(await safeFile(runDir, source.file))) { hash.update(chunk); bytes += chunk.length; }
    result.push({ file: source.file, bytes, sha256: hash.digest('hex') });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export async function verifyRecovery(studio: Studio, repeat: boolean) {
  const seed = JSON.parse(await readFile(path.join(studio.root, 'recovery-seed.json'), 'utf8'));
  const cut = JSON.parse(await readFile(path.join(studio.root, 'recovery-cut.json'), 'utf8'));
  assert.notEqual(process.pid, seed.processId);
  assert.equal(cut.processId, seed.processId); assert.equal(cut.runId, seed.runId);
  assert.equal(studio.active, undefined, 'Restart cannot restore a former control lease, worker or human window');
  const listed = studio.state().validations.filter((record: any) => record.id === cut.validationId);
  assert.equal(listed.length, 1, 'The interrupted or completed validation must be discoverable exactly once');
  const record = await studio.validation(cut.validationId);
  assert.equal(record.runId, seed.runId); assert.equal(record.projectId, seed.projectId);
  const hasCommittedResult = cut.stage === 'terminal-before-catalog';
  if (hasCommittedResult) { assert.equal(record.status, 'completed'); assert.equal(record.result?.validation?.overall, 'pass'); assert.ok(record.artifactId); }
  else { assert.equal(record.status, 'interrupted'); assert.ok(record.error || record.recovery); assert.equal(record.result, undefined, 'An uncommitted report cannot become an execution result'); }
  const reader = studio.reader(seed.runId);
  const checkpoints = await reader.checkpoints({ limit: 100, maxBytes: 32768 });
  assert.ok(checkpoints.items.some((checkpoint: any) => checkpoint.id === seed.checkpointId));
  for (const artifact of seed.artifacts) {
    const verified = await reader.artifactFile(artifact.id);
    assert.equal(verified.artifact.sha256, artifact.sha256); assert.equal(verified.artifact.capturedBytes, artifact.bytes);
  }
  let retainedReport;
  if (cut.stage === 'report-before-terminal' || hasCommittedResult) {
    assert.ok(cut.reportId); assert.equal(cut.report.id, cut.reportId);
    const verified = await reader.artifactFile(cut.reportId);
    assert.equal(verified.artifact.kind, 'validation-report'); assert.equal(verified.artifact.captureStatus, 'complete');
    assert.equal(verified.artifact.sha256, cut.report.sha256); assert.equal(verified.artifact.capturedBytes, cut.report.bytes);
    const envelope = JSON.parse(await readFile(verified.path, 'utf8'));
    assert.equal(envelope.validationId, cut.validationId); assert.equal(envelope.runId, seed.runId);
    retainedReport = cut.report;
    if (hasCommittedResult) assert.equal(record.artifactId, cut.reportId);
  }
  const snapshot = { validationId: record.id, status: record.status, result: record.result ?? null,
    artifactId: record.artifactId ?? null, retainedReport: retainedReport ?? null, originals: await originalHashes(reader.runDir) };
  if (repeat) {
    const previous = JSON.parse(await readFile(path.join(studio.root, 'recovery-observed.json'), 'utf8'));
    assert.deepEqual(snapshot, previous, 'Repeated startup must not duplicate validation records or append another recovery gap');
    const rerun = JSON.parse(await readFile(path.join(studio.root, 'recovery-rerun.json'), 'utf8'));
    const rerunRecord = await studio.validation(rerun.id);
    assert.equal(rerunRecord.result?.validation?.overall, 'pass', 'A successful fresh run remains discoverable after another restart');
  } else {
    await atomicJson(path.join(studio.root, 'recovery-observed.json'), snapshot);
    const site = await startFixture();
    // Pause just this fresh run at its catalog write. The production public
    // surface gets no fault-injection operation, and the pause is time bounded.
    const catalog = studio as unknown as { saveValidations(records?: ValidationRecord[]): Promise<void> };
    const originalSave = catalog.saveValidations.bind(studio);
    let releaseCatalog: (() => void) | undefined, reachedCatalog: ((records: ValidationRecord[]) => void) | undefined;
    let catalogTimer: ReturnType<typeof setTimeout> | undefined;
    const catalogReached = new Promise<ValidationRecord[]>(resolve => { reachedCatalog = resolve; });
    if (cut.stage === 'report-before-terminal') {
      const released = new Promise<void>(resolve => { releaseCatalog = resolve; });
      catalog.saveValidations = async records => {
        assert.ok(records, 'Finalization must supply a terminal catalog snapshot');
        reachedCatalog!(records);
        try {
          await Promise.race([released, new Promise<never>((_resolve, reject) => {
            catalogTimer = setTimeout(() => reject(new Error('Synthetic catalog barrier timed out')), 10000);
          })]);
        } finally { clearTimeout(catalogTimer); }
        await originalSave(records);
      };
    }
    try {
      const started = await studio.validate({ projectId: seed.projectId, profileId: seed.profileId, input: { baseUrl: site.url, variant: 'normal' } });
      assert.notEqual(started.runId, seed.runId, 'Recovery creates a fresh execution instead of resuming an interrupted stack');
      if (cut.stage === 'report-before-terminal') {
        let reachedTimer: ReturnType<typeof setTimeout> | undefined;
        let candidate: ValidationRecord | undefined;
        try {
          const candidates = await Promise.race([catalogReached, new Promise<never>((_resolve, reject) => {
            reachedTimer = setTimeout(() => reject(new Error('Fresh execution never reached its catalog write')), 60000);
          })]);
          candidate = candidates.find(item => item.id === started.id);
        } finally { clearTimeout(reachedTimer); }
        assert.equal(candidate?.status, 'completed'); assert.ok(candidate?.artifactId); assert.equal(candidate.result?.validation.overall, 'pass');
        const saving = await studio.validation(started.id), savingState = studio.state();
        assert.equal(saving.status, 'finalizing'); assert.equal(saving.result, undefined); assert.equal(saving.artifactId, undefined);
        assert.equal(savingState.validations.find(item => item.id === started.id)?.status, 'finalizing');
        assert.equal(savingState.active?.execution, 'finalizing'); assert.equal(savingState.active?.locked, true);
        assert.equal(savingState.active?.controller, 'agent');
        await assert.rejects(studio.validate({ projectId: seed.projectId, profileId: seed.profileId, input: { baseUrl: site.url, variant: 'normal' } }), (error: any) => error.status === 409);
        await delay(50); assert.equal((await studio.validation(started.id)).status, 'finalizing');
        releaseCatalog!();
      }
      const deadline = Date.now() + 60000;
      let finished: any;
      while (Date.now() < deadline) {
        finished = await studio.validation(started.id);
        if (['completed', 'failed', 'cancelled'].includes(finished.status) && (finished.artifactId || finished.error)) break;
        await delay(50);
      }
      assert.equal(finished?.status, 'completed', String(finished?.error || finished?.result?.error));
      assert.equal(finished?.result?.validation?.overall, 'pass');
      assert.equal(studio.required().controller, 'human'); assert.equal(studio.required().locked, false);
      if (cut.stage === 'report-before-terminal') {
        const savedCatalog: ValidationRecord[] = JSON.parse(await readFile(path.join(studio.root, 'validations.json'), 'utf8'));
        assert.equal(savedCatalog.find(item => item.id === started.id)?.result?.validation.overall, 'pass');
        console.log('RECOVERY PASS: catalog barrier keeps finalizing locked until completion and human ownership become visible together');
      }
      await studio.seal();
      await atomicJson(path.join(studio.root, 'recovery-rerun.json'), { id: started.id, runId: started.runId });
    } finally { releaseCatalog?.();clearTimeout(catalogTimer);catalog.saveValidations=originalSave;await site.close(); }
  }
  console.log(`RECOVERY PASS: ${cut.stage}; ${repeat ? 'idempotent second reopen' : 'evidence retained and fresh validation passed'}`);
  return { crashStage: cut.stage, originalProcessId: seed.processId, recoveredValidationId: record.id, recoveredStatus: record.status, repeated: repeat };
}
