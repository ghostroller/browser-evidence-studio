import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore } from '../../src/evidence/store';
import { EvidenceReader } from '../../src/evidence/reader';
import { evidenceSources } from '../../src/evidence/index';
import { hashBytes, jsonLines } from '../../src/evidence/files';
import { fingerprintInput, fingerprintWorkflow } from '../../src/runner/fingerprint';
import { GateTransport, type ProtocolTransport } from '../../src/runner/gate';
import { startWorkflow, type RunnerHooks, type WorkflowPrepared, type WorkflowRunResult } from '../../src/runner/manager';
import { validateExecution } from '../../src/runner/validation';
import type { WorkflowManifest } from '../../src/contracts/workflow';
import { commitValidation, recoverValidationCatalog, registerValidation, type ValidationRecord } from '../../src/main/services/validation-lifecycle';

const manifest: WorkflowManifest = { schemaVersion: 1, workflowId: 'recovery', entry: './run.mjs', exportName: 'run', driver: 'puppeteer',
  requirements: [{ id: 'saved', checkpointKey: 'saved', description: 'A saved synthetic observation' }] };

async function fixture(action: (f: {
  root: string; directory: string; store: EvidenceStore; prepared: WorkflowPrepared; record: ValidationRecord;
  result: (complete?: boolean) => Promise<WorkflowRunResult>; recover: () => ReturnType<typeof recoverValidationCatalog>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-validation-recovery-'));
  let store: EvidenceStore | undefined;
  try {
    const directory = path.join(root, 'workflow'); await mkdir(directory);
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'run.mjs'), 'export const run = async () => {};');
    await writeFile(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    store = await EvidenceStore.create(path.join(root, 'runs', 'run-a'), { id: 'run-a', projectId: 'project-a', profileId: 'profile-a', kind: 'validate', objective: 'synthetic', mode: 'synthetic' });
    const prepared: WorkflowPrepared = { manifest, entryPath: path.join(directory, 'run.mjs'), inputSha256: fingerprintInput({ sample: true }), fingerprintBefore: await fingerprintWorkflow(directory), startedAt: new Date().toISOString() };
    const identity = { id: 'validation-a', runId: 'run-a', projectId: 'project-a', profileId: 'profile-a', directory };
    const record = await registerValidation(store, identity, prepared), current = store;
    const result = async (complete = true): Promise<WorkflowRunResult> => {
      const screenshot = await current.putArtifact({ kind: 'screenshot', mediaType: 'image/png', data: 'synthetic-image' });
      const dom = await current.putArtifact({ kind: 'dom', mediaType: 'text/html', ...(complete ? { data: '<p>Observed</p>' } : { captureStatus: 'read-failed' as const, reason: 'Synthetic capture failed' }) });
      const checkpoint = await current.appendCheckpoint({ key: 'saved', captureStartedAt: prepared.startedAt, captureEndedAt: new Date().toISOString(), captureConsistency: 'consistent', artifactRefs: [screenshot.id, dom.id], metadata: { captureOutcome: 'completed', captureStatus: 'complete' } });
      const checkpoints = [{ id: checkpoint.id, key: checkpoint.key }], assertions: WorkflowRunResult['assertions'] = [{ requirementId: 'saved', name: 'observed', verdict: 'pass', sourceRefs: [checkpoint.id] }];
      const result: WorkflowRunResult = { ...prepared, status: 'completed', finishedAt: new Date().toISOString(), durationMs: 1, runtimeNodeVersion: process.versions.node,
        fingerprintAfter: prepared.fingerprintBefore, checkpoints, assertions, datasets: [], humanAttempts: [],
        validation: validateExecution({ manifest, execution: 'completed', checkpoints, assertions, datasets: [], fingerprintBefore: prepared.fingerprintBefore, fingerprintAfter: prepared.fingerprintBefore, knownSourceRefs: [checkpoint.id] }) };
      assert.equal(result.validation.overall, 'pass'); return result;
    };
    const recover = async () => { await current.flush(); return recoverValidationCatalog(root, [current.manifest], [{ id: 'project-a', scriptDirectory: directory }]); };
    await action({ root, directory, store, record, prepared, result, recover });
  } finally {
    await store?.close();
    assert.equal(await realpath(path.dirname(root)), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('bes-validation-recovery-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('registered and running executions recover as interrupted without trusting a cached pass', async () => {
  await fixture(async f => {
    await f.store.appendEvent({ type: 'validation-running', source: 'runner', data: { id: f.record.id } });
    await f.store.appendEvent({ type: 'handoff', source: 'runner', data: { status: 'waiting' } });
    await writeFile(path.join(f.root, 'validations.json'), JSON.stringify([{ ...f.record, status: 'completed', result: await f.result() }, { id: 'external-pass', result: { validation: { overall: 'pass' } } }]));
    const recovered = await f.recover();
    assert.equal(recovered.records.length, 1); assert.equal(recovered.records[0].status, 'interrupted');
    assert.equal(recovered.records[0].result, undefined); assert.equal(recovered.records[0].recovery?.startEventId, f.record.recovery?.startEventId);
    assert.ok(recovered.diagnostics.some(item => item.code === 'catalog-entry-unverified'));
  });
});

test('a saved report without its terminal event stays interrupted and preserves the orphan report', async () => {
  await fixture(async f => {
    let reportId = '';
    await assert.rejects(commitValidation(f.store, f.record, await f.result(), async (stage, context) => {
      if (stage === 'report-before-terminal') { reportId = context.reportId!; throw new Error('Synthetic process cut'); }
    }), /Synthetic process cut/);
    const recovered = await f.recover();
    assert.equal(recovered.records[0].status, 'interrupted'); assert.equal(recovered.records[0].result, undefined);
    assert.equal((await new EvidenceReader(f.store.runDir).artifactFile(reportId)).artifact.kind, 'validation-report');
  });
});

test('terminal evidence restores a complete result despite lost catalog and repeated recovery changes no originals', async () => {
  await fixture(async f => {
    await assert.rejects(commitValidation(f.store, f.record, await f.result(), async stage => { if (stage === 'terminal-before-catalog') throw new Error('Synthetic catalog cut'); }), /Synthetic catalog cut/);
    const sourceHashes = async () => Promise.all((await evidenceSources(f.store.runDir)).map(async source => ({ file: source.file, sha256: hashBytes(await readFile(path.join(f.store.runDir, source.file))) })));
    const before = await sourceHashes();
    await writeFile(path.join(f.root, 'validations.json'), '{corrupt catalog');
    const first = await f.recover(), second = await f.recover();
    assert.equal(first.records[0].result?.validation.overall, 'pass'); assert.equal(first.records[0].recovery?.state, 'verified');
    assert.ok(first.diagnostics.some(item => item.code === 'catalog-unreadable')); assert.deepEqual(second.records, first.records);
    assert.deepEqual(await sourceHashes(), before);
  });
});

test('changed report bytes fail hash verification and cannot restore acceptance', async () => {
  await fixture(async f => {
    const completed = await commitValidation(f.store, f.record, await f.result()); await f.store.flush();
    const report = await new EvidenceReader(f.store.runDir).artifactFile(completed.artifactId!);
    await writeFile(report.path, '{"validation":{"overall":"pass"}}');
    const recovered = await f.recover(); assert.equal(recovered.records[0].result, undefined); assert.equal(recovered.records[0].recovery?.state, 'invalid');
  });
});

test('a validly hashed report with wrong profile, input or executed version is rejected', async () => {
  for (const mode of ['profile', 'input', 'version'] as const) await fixture(async f => {
    const result = await f.result();
    if (mode === 'input') result.inputSha256 = fingerprintInput({ foreign: true });
    if (mode === 'version') {
      const fingerprint = { files: [], dependencyLockSha256: f.prepared.fingerprintBefore.dependencyLockSha256 };
      result.fingerprintBefore = { ...fingerprint, sha256: hashBytes(JSON.stringify(fingerprint)) };
    }
    await commitValidation(f.store, mode === 'profile' ? { ...f.record, profileId: 'foreign-profile' } : f.record, result);
    const recovered = await f.recover(); assert.equal(recovered.records[0].result, undefined, mode); assert.equal(recovered.records[0].recovery?.state, 'invalid', mode);
  });
});

test('recovery does not accept a checkpoint whose saved DOM material failed', async () => {
  await fixture(async f => {
    await commitValidation(f.store, f.record, await f.result(false));
    const recovered = await f.recover(); assert.equal(recovered.records[0].result, undefined); assert.match(recovered.records[0].error!, /DOM|dom/);
  });
});

test('missing or modified checkpoint material bytes cannot restore a pass from intact report metadata', async () => {
  for (const mode of ['missing', 'modified'] as const) await fixture(async f => {
    await commitValidation(f.store, f.record, await f.result()); await f.store.flush();
    let materialId = '';
    for await (const line of jsonLines(path.join(f.store.runDir, 'artifacts.jsonl'))) if (line.value?.kind === (mode === 'missing' ? 'dom' : 'screenshot')) materialId = String(line.value.id);
    const material = await new EvidenceReader(f.store.runDir).artifactFile(materialId);
    if (mode === 'missing') await rm(material.path);
    else await writeFile(material.path, 'modified material');
    const recovered = await f.recover(); assert.equal(recovered.records[0].result, undefined, mode); assert.equal(recovered.records[0].recovery?.state, 'invalid', mode);
  });
});

test('malformed lifecycle field types do not prevent recovery of an independent valid result', async () => {
  await fixture(async f => {
    await commitValidation(f.store, f.record, await f.result());
    await f.store.appendEvent({ type: 'validation-started', source: 'studio', data: { schemaVersion: 1, id: 'malformed', runId: 'run-a', projectId: 'project-a', profileId: 'profile-a', directory: 42, startedAt: { corrupt: true } } });
    await f.store.appendEvent({ type: 'validation-started', source: 'studio', data: { id: { bad: true } } });
    const recovered = await f.recover(), malformed = recovered.records.find(record => record.id === 'malformed')!;
    assert.equal(recovered.records.find(record => record.id === f.record.id)?.result?.validation.overall, 'pass');
    assert.equal(malformed.recovery?.state, 'invalid'); assert.equal(typeof malformed.startedAt, 'string'); assert.equal(typeof malformed.directory, 'string');
    assert.ok(recovered.diagnostics.some(item => item.code === 'invalid-lifecycle-event'));
  });
});

test('a legacy terminal report is recovered from evidence even when the old catalog result lies', async () => {
  await fixture(async f => {
    const result = await f.result(), report = await f.store.putArtifact({ kind: 'validation-report', mediaType: 'application/json', data: JSON.stringify(result) });
    await f.store.appendEvent({ type: 'validation-complete', source: 'runner', artifactRefs: [report.id], data: { id: 'legacy', status: result.status, validation: result.validation } });
    await writeFile(path.join(f.root, 'validations.json'), JSON.stringify([{ id: 'legacy', runId: 'run-a', projectId: 'project-a', directory: f.directory, result: { status: 'foreign', validation: { overall: 'fail' } } }]));
    const legacy = (await f.recover()).records.find(record => record.id === 'legacy')!;
    assert.equal(legacy.recovery?.state, 'legacy-verified'); assert.equal(legacy.result?.validation.overall, 'pass'); assert.equal(legacy.artifactId, report.id);
  });
});

test('catalog write failure does not erase a verified result', async () => {
  await fixture(async f => {
    await commitValidation(f.store, f.record, await f.result());
    await mkdir(path.join(f.root, 'validations.json'));
    const recovered = await f.recover(); assert.equal(recovered.catalogStatus, 'write-failed'); assert.equal(recovered.records[0].result?.validation.overall, 'pass');
  });
});

const hooks: RunnerHooks = { checkpoint: async () => ({ id: 'unused' }), emitData: async () => {}, attachArtifact: async () => ({ id: 'unused' }), assertion: async () => {}, requestHuman: async () => {}, progress: async () => {} };
function transport() { const raw: ProtocolTransport = { send() {}, close() { raw.onclose?.(); } }; return new GateTransport(raw); }

test('pre-worker registration failure and cancellation never execute a worker', async () => {
  await fixture(async f => {
    const workerPath = path.join(f.directory, 'worker.cjs'), marker = path.join(f.root, 'must-not-exist');
    await writeFile(workerPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'worker started');`);
    await assert.rejects(startWorkflow({ directory: f.directory, input: {}, targetId: 'synthetic', workerPath, transport: transport(), hooks,
      beforeWorker: async prepared => { assert.match(prepared.inputSha256, /^[a-f0-9]{64}$/); throw new Error('Registration failed'); } }), /Registration failed/);
    const cancellation = new AbortController();
    await assert.rejects(startWorkflow({ directory: f.directory, input: {}, targetId: 'synthetic', workerPath, transport: transport(), hooks, startupSignal: cancellation.signal,
      beforeWorker: async () => { cancellation.abort(new Error('Cancelled before launch')); } }), /Cancelled before launch/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
});

test('cancelling while the durable running hook waits still settles the worker and pending hook', { timeout: 5000 }, async () => {
  await fixture(async f => {
    const workerPath = path.join(f.directory, 'worker.cjs');
    await writeFile(workerPath, `require('node:worker_threads').parentPort.postMessage({type:'started',nodeVersion:process.versions.node});setInterval(()=>{},100);`);
    let reached!: () => void; const running = new Promise<void>(resolve => { reached = resolve; });
    const gate = transport();
    const handle = await startWorkflow({ directory: f.directory, input: {}, targetId: 'synthetic', workerPath, transport: gate, hooks,
      onStarted: async (_version, signal) => { reached(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } });
    await running; await handle.cancel();
    assert.equal((await handle.done).status, 'cancelled'); assert.equal((await handle.done).validation.overall, 'fail'); assert.equal(gate.snapshot().state, 'closed');
  });
});
