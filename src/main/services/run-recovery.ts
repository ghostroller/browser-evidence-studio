import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceStore } from '@/evidence/store';
import { safeFile } from '@/evidence/files';
import { inspectWriterLock, recoverWriterLock } from '@/evidence/writer-lock';
import { ensure } from '@/shared/errors';
import type { Studio } from './studio';

async function recoveryTarget(studio: Studio, runId: unknown) {
  ensure(typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId), 'Invalid recovery run identity');
  const record = studio.runs.find(run => run.id === runId);
  ensure(record, 'Unknown recovery run', 404);
  const root = await realpath(studio.root), runsDirectory = path.join(root, 'runs'), runDir = path.join(runsDirectory, runId);
  for (const directory of [runsDirectory, runDir]) {
    const info = await lstat(directory);
    ensure(info.isDirectory() && !info.isSymbolicLink(), 'Recovery requires a regular run directory', 409);
  }
  const actual = await realpath(runDir), relative = path.relative(root, actual);
  ensure(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Recovery run escapes the workspace', 409);
  return { record, runDir: actual };
}

export async function inspectRunRecovery(studio: Studio, body: { runId?: unknown }) {
  const { record, runDir } = await recoveryTarget(studio, body.runId);
  const inspection = await inspectWriterLock(runDir);
  return { runId: record.id, status: record.status, error: record.error, inspection, canRecover: !studio.active && record.status === 'unreadable' && ['unlocked', 'dead', 'pid-reused'].includes(inspection.state) };
}

/** Only the trusted UI invokes this after displaying the currently inspected ownership. */
export async function recoverRun(studio: Studio, body: { runId?: unknown; expectedFingerprint?: unknown }) {
  const { record, runDir } = await recoveryTarget(studio, body.runId);
  ensure(!studio.active, 'Seal the current run before recovering an archive', 409);
  ensure(record.status === 'unreadable', 'This run is already readable; open its saved evidence', 409);
  const inspection = await inspectWriterLock(runDir);
  ensure(body.expectedFingerprint === inspection.lockFingerprint, 'Writer ownership changed; inspect the archive again', 409);
  ensure(['unlocked', 'dead', 'pid-reused'].includes(inspection.state), `Writer recovery refused (${inspection.state}): ${inspection.message}`, 409);
  const manifestPath = await safeFile(runDir, 'manifest.json');
  ensure((await stat(manifestPath)).size <= 64 * 1024, 'Run manifest exceeds the recovery metadata budget', 413);
  const storedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  ensure(storedManifest.id === record.id, 'Run manifest identity does not match its archive', 409);
  let recovery: Awaited<ReturnType<typeof recoverWriterLock>> | undefined;
  try {
    if (inspection.state !== 'unlocked') {
      ensure(typeof body.expectedFingerprint === 'string', 'A current writer fingerprint is required', 409);
      recovery = await recoverWriterLock(runDir, { expectedFingerprint: body.expectedFingerprint });
    }
    const store = await EvidenceStore.open(runDir);
    let manifest;
    try {
      ensure(store.manifest.id === record.id, 'Run manifest identity does not match its archive', 409);
      manifest = { ...store.manifest };
    } finally { await store.close(); }
    studio.runs = studio.runs.map(run => run.id === record.id ? manifest : run);
    const validations = await studio.refreshValidations();
    studio.onChanged();
    return { runId: record.id, status: manifest.status, recovered: true, ...(recovery ? { preservedLockPath: recovery.preservedLockPath, diagnosticPath: recovery.diagnosticPath } : {}), validationDiagnostics: validations.diagnostics.filter(diagnostic => !diagnostic.runId || diagnostic.runId === record.id).slice(0, 20) };
  } catch (error) {
    // A failed reopen remains visible and retryable without claiming a live execution.
    studio.runs = studio.runs.map(run => run.id === record.id ? { ...record, status: 'unreadable', error: String(error) } : run);
    studio.onChanged();
    throw error;
  }
}
