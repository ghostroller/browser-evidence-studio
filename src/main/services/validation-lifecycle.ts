import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { evidenceSources } from '@/evidence/index';
import { atomicJson, hashBytes, jsonLines, safeFile } from '@/evidence/files';
import type { EvidenceEvent, RunManifest } from '@/evidence/contracts';
import { parseWorkflowManifest } from '@/contracts/workflow';
import { validateExecution } from '@/runner/validation';
import type { WorkflowPrepared, WorkflowRunResult } from '@/runner/manager';

export type ValidationLifecycleStage = 'registered-before-worker' | 'running' | 'waiting-human' | 'report-before-terminal' | 'terminal-before-catalog';
export interface ValidationLifecycleContext {
  validationId: string; runId: string; projectId: string; profileId: string; directory: string; reportId?: string;
}
export type ValidationLifecycleObserver = (stage: ValidationLifecycleStage, context: ValidationLifecycleContext) => void | Promise<void>;
export interface ValidationIdentity { id: string; runId: string; projectId: string; profileId: string; directory: string; }
export interface ValidationRecoveryDiagnostic { runId?: string; validationId?: string; code: string; message: string; }
export interface ValidationRecord extends ValidationIdentity {
  startedAt: string;
  status: string;
  result?: WorkflowRunResult;
  artifactId?: string;
  error?: string;
  recovery?: { state: 'verified' | 'interrupted' | 'invalid' | 'legacy-verified'; reason?: string; startEventId?: string; terminalEventId?: string };
}
interface StartData extends ValidationIdentity {
  schemaVersion: 1; startedAt: string; inputSha256: string; entryPath: string;
  executionVersion: { sha256: string; dependencyLockSha256: string | null; manifestSha256: string };
}
interface ReportEnvelope {
  schemaVersion: 1; kind: 'managed-validation-report'; validationId: string; runId: string;
  projectId: string; profileId: string; startEventId: string; result: WorkflowRunResult;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const maxReportBytes = 32 * 1024 * 1024;
const text = (value: unknown, fallback = '', limit = 4096): string => typeof value === 'string' && value.length <= limit ? value : fallback;
const validTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

export async function registerValidation(store: EvidenceStore, identity: ValidationIdentity, prepared: WorkflowPrepared): Promise<ValidationRecord> {
  const data: StartData = { ...identity, schemaVersion: 1, startedAt: prepared.startedAt, inputSha256: prepared.inputSha256,
    entryPath: prepared.entryPath, executionVersion: { sha256: prepared.fingerprintBefore.sha256,
      dependencyLockSha256: prepared.fingerprintBefore.dependencyLockSha256, manifestSha256: hashBytes(JSON.stringify(prepared.manifest)) } };
  const start = await store.appendEvent({ type: 'validation-started', source: 'studio', data });
  return { ...identity, startedAt: prepared.startedAt, status: 'running', recovery: { state: 'interrupted', startEventId: start.id } };
}

/** The catalog is only a projection. Neither report bytes alone nor a catalog pass is a terminal execution. */
export async function commitValidation(store: EvidenceStore, record: ValidationRecord, result: WorkflowRunResult,
  observe?: (stage: ValidationLifecycleStage, context: ValidationLifecycleContext) => Promise<void>): Promise<ValidationRecord> {
  const startEventId = record.recovery?.startEventId;
  check(startEventId, 'A validation must be registered before its report is committed');
  const envelope: ReportEnvelope = { schemaVersion: 1, kind: 'managed-validation-report', validationId: record.id,
    runId: record.runId, projectId: record.projectId, profileId: record.profileId, startEventId, result };
  const data = JSON.stringify(envelope);
  check(Buffer.byteLength(data) <= maxReportBytes, 'Validation report exceeds the 32 MiB recovery budget');
  const report = await store.putArtifact({ kind: 'validation-report', mediaType: 'application/json', data, limitBytes: maxReportBytes,
    source: 'studio', metadata: { validationId: record.id, runId: record.runId, projectId: record.projectId, profileId: record.profileId, startEventId } });
  check(report.captureStatus === 'complete' && report.sha256, 'Validation report was not saved completely');
  const context = { validationId: record.id, runId: record.runId, projectId: record.projectId, profileId: record.profileId, directory: record.directory, reportId: report.id };
  await observe?.('report-before-terminal', context);
  const terminal = await store.appendEvent({ type: 'validation-complete', source: 'runner', artifactRefs: [report.id], data: {
    schemaVersion: 1, id: record.id, runId: record.runId, projectId: record.projectId, profileId: record.profileId,
    startEventId, reportId: report.id, reportSha256: report.sha256, status: result.status, validation: result.validation,
  } });
  await store.flush();
  await observe?.('terminal-before-catalog', context);
  return { ...record, result, status: result.status, artifactId: report.id,
    recovery: { state: 'verified', startEventId, terminalEventId: terminal.id } };
}

export function saveValidationCatalog(root: string, records: ValidationRecord[]): Promise<void> {
  return atomicJson(path.join(root, 'validations.json'), records);
}

function validateResult(value: unknown): asserts value is WorkflowRunResult {
  check(object(value), 'Report result is not an object');
  check(['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status), 'Unknown execution status');
  check(typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) && typeof value.finishedAt === 'string' && Number.isFinite(Date.parse(value.finishedAt)), 'Report execution times are invalid');
  check(typeof value.entryPath === 'string' && path.isAbsolute(value.entryPath) && sha(value.inputSha256), 'Report execution identity is invalid');
  parseWorkflowManifest(value.manifest);
  for (const fingerprint of [value.fingerprintBefore, value.fingerprintAfter]) {
    check(object(fingerprint) && Array.isArray(fingerprint.files), 'Report fingerprint is missing');
    if (fingerprint.sha256 === 'unavailable-after-execution' && value.status === 'failed') continue;
    check(sha(fingerprint.sha256) && (fingerprint.dependencyLockSha256 === null || sha(fingerprint.dependencyLockSha256)), 'Invalid execution fingerprint');
    check(hashBytes(JSON.stringify({ files: fingerprint.files, dependencyLockSha256: fingerprint.dependencyLockSha256 })) === fingerprint.sha256, 'Execution fingerprint contents do not match its hash');
  }
  check(Array.isArray(value.checkpoints) && Array.isArray(value.datasets) && Array.isArray(value.assertions) && Array.isArray(value.humanAttempts), 'Report evidence references are missing');
  check(object(value.validation) && ['pass', 'fail', 'inconclusive', 'not-run'].includes(value.validation.overall), 'Report verdict is invalid');
  check(value.status === 'completed' || value.validation.overall !== 'pass', 'An unfinished or failed execution cannot pass');
}

async function scanRun(runDir: string): Promise<{ events: EvidenceEvent[]; checkpoints: Map<string, any>; artifacts: Map<string, any>; sources: { id: string; sequence: number }[] }> {
  const events: EvidenceEvent[] = [], checkpoints = new Map<string, any>(), artifacts = new Map<string, any>(), sources: { id: string; sequence: number }[] = [];
  for (const source of await evidenceSources(runDir)) {
    if (source.kind === 'raw') continue;
    for await (const line of jsonLines(await safeFile(runDir, source.file))) {
      const value = line.value;
      if (!value || value.schemaVersion !== 1 || typeof value.id !== 'string' || !Number.isSafeInteger(value.sequence)) continue;
      if (source.kind === 'events' && ['validation-started', 'validation-complete', 'validation-launch-failed'].includes(String(value.type))) events.push(value as unknown as EvidenceEvent);
      if (source.kind === 'checkpoints') checkpoints.set(value.id, value);
      if (source.kind === 'artifacts') artifacts.set(value.id, value);
      if (source.kind === 'artifacts' || source.kind === 'checkpoints') sources.push({ id: value.id, sequence: Number(value.sequence) });
    }
  }
  return { events, checkpoints, artifacts, sources };
}

async function readReport(reader: EvidenceReader, terminal: EvidenceEvent) {
  check(terminal.source === 'runner' && terminal.artifactRefs?.length === 1, 'Terminal report reference is invalid');
  const report = await reader.artifactFile(terminal.artifactRefs[0]);
  check(report.artifact.kind === 'validation-report' && report.artifact.mediaType === 'application/json' && report.artifact.captureStatus === 'complete', 'Terminal artifact is not a complete validation report');
  check(report.artifact.capturedBytes <= maxReportBytes, 'Validation report exceeds the 32 MiB recovery budget');
  return { report, value: JSON.parse(await readFile(report.path, 'utf8')) as unknown };
}

export async function recoverValidationCatalog(root: string, runs: Record<string, any>[], projects: { id: string; scriptDirectory?: string }[]): Promise<{
  records: ValidationRecord[]; diagnostics: ValidationRecoveryDiagnostic[]; catalogStatus: 'rebuilt' | 'write-failed';
}> {
  const records: ValidationRecord[] = [], diagnostics: ValidationRecoveryDiagnostic[] = [];
  let previous: Record<string, any>[] = [];
  try {
    const file = path.join(root, 'validations.json');
    check((await stat(file)).size <= 64 * 1024 * 1024, 'Validation catalog exceeds the 64 MiB projection budget');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    check(Array.isArray(value), 'Validation catalog must be an array');
    previous = value.filter(object);
  } catch (error: any) {
    if (error.code !== 'ENOENT') diagnostics.push({ code: 'catalog-unreadable', message: `Validation catalog was rebuilt from evidence: ${String(error)}` });
  }
  for (const run of runs) {
    if (run.status === 'unreadable') { diagnostics.push({ runId: run.id, code: 'run-unreadable', message: 'Validation recovery requires safe recovery of this run first.' }); continue; }
    if (run.kind !== 'validate') continue;
    try {
      check(typeof run.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(run.id), 'Invalid run directory identity');
      const runDir = path.join(root, 'runs', run.id), manifest = JSON.parse(await readFile(await safeFile(runDir, 'manifest.json'), 'utf8')) as RunManifest;
      check(manifest.id === run.id && manifest.kind === 'validate' && manifest.projectId === run.projectId && manifest.profileId === run.profileId, 'Run identity disagrees with its persisted manifest');
      const project = projects.find(item => item.id === manifest.projectId);
      check(project, 'Run does not belong to a registered workspace project');
      const { events, checkpoints, artifacts, sources } = await scanRun(runDir), reader = new EvidenceReader(runDir);
      const groups = new Map<string, EvidenceEvent[]>();
      for (const event of events) {
        const data = event.data;
        if (!object(data) || typeof data.id !== 'string' || !data.id || data.id.length > 200) { diagnostics.push({ runId: run.id, code: 'invalid-lifecycle-event', message: 'Validation lifecycle event lacks a bounded identity.' }); continue; }
        const items = groups.get(data.id) ?? []; items.push(event); groups.set(data.id, items);
      }
      for (const [id, events] of groups) {
        const starts = events.filter(event => event.type === 'validation-started'), terminals = events.filter(event => event.type === 'validation-complete');
        const start = starts[0], startData = start?.data as StartData | undefined;
        const hint = previous.find(item => item.id === id && item.runId === run.id && item.projectId === manifest.projectId);
        const record: ValidationRecord = { id, runId: run.id, projectId: text(manifest.projectId, '', 200), profileId: text(manifest.profileId, '', 200),
          directory: text(startData?.directory, text(hint?.directory, text(project.scriptDirectory))), startedAt: validTime(startData?.startedAt) ? startData.startedAt : validTime(events[0].occurredAt) ? events[0].occurredAt : text(manifest.createdAt),
          status: 'interrupted', recovery: { state: 'interrupted', reason: 'Execution ended without a committed terminal report.', startEventId: start?.id } };
        records.push(record);
        try {
          check(starts.length <= 1 && terminals.length <= 1, 'Conflicting validation lifecycle records');
          if (start) {
            check(start.source === 'studio' && startData?.schemaVersion === 1, 'Unknown validation registration format');
            check(startData.id === id && startData.runId === run.id && startData.projectId === manifest.projectId && startData.profileId === manifest.profileId, 'Validation registration belongs to a different run/project/profile');
            check(typeof startData.directory === 'string' && startData.directory.length <= 4096 && path.isAbsolute(startData.directory) && typeof startData.entryPath === 'string' && startData.entryPath.length <= 4096 && path.isAbsolute(startData.entryPath) && validTime(startData.startedAt) && sha(startData.inputSha256) && sha(startData.executionVersion?.sha256) && sha(startData.executionVersion?.manifestSha256), 'Validation registration is incomplete');
          }
          if (!terminals.length) {
            const failed = events.find(event => event.type === 'validation-launch-failed');
            if (failed && object(failed.data) && failed.source === 'studio' && failed.data.runId === run.id && failed.data.projectId === manifest.projectId && failed.data.profileId === manifest.profileId) {
              record.status = failed.data.status === 'cancelled' ? 'cancelled' : 'failed'; record.error = String(failed.data.error ?? 'Worker launch failed');
              record.recovery!.reason = 'Worker did not start; no acceptance result was produced.';
            } else record.error = record.recovery!.reason;
            diagnostics.push({ runId: run.id, validationId: id, code: 'validation-interrupted', message: record.recovery!.reason! });
            continue;
          }
          const terminal = terminals[0], terminalData = terminal.data as Record<string, any>;
          const { report, value } = await readReport(reader, terminal);
          let result: unknown;
          if (start) {
            check(terminalData.schemaVersion === 1 && terminalData.runId === run.id && terminalData.projectId === manifest.projectId && terminalData.profileId === manifest.profileId && terminalData.startEventId === start.id && terminal.sequence > start.sequence, 'Terminal identity does not match registration');
            check(terminalData.reportId === report.artifact.id && terminalData.reportSha256 === report.artifact.sha256 && report.artifact.sequence > start.sequence && terminal.sequence > report.artifact.sequence, 'Terminal report hash or sequence does not match');
            check(object(value) && value.schemaVersion === 1 && value.kind === 'managed-validation-report' && value.validationId === id && value.runId === run.id && value.projectId === manifest.projectId && value.profileId === manifest.profileId && value.startEventId === start.id, 'Report envelope belongs to a different validation');
            result = value.result;
          } else {
            // Legacy catalogs supply a directory hint only. Their result/pass fields are never trusted.
            check(!terminalData.schemaVersion && object(value) && !value.kind, 'New terminal record is missing its registration');
            result = value;
          }
          validateResult(result);
          check(terminalData.status === result.status && same(terminalData.validation, result.validation), 'Report verdict disagrees with the terminal event');
          if (startData) {
            check(result.startedAt === startData.startedAt && result.inputSha256 === startData.inputSha256 && result.entryPath === startData.entryPath && result.fingerprintBefore.sha256 === startData.executionVersion.sha256 && result.fingerprintBefore.dependencyLockSha256 === startData.executionVersion.dependencyLockSha256 && hashBytes(JSON.stringify(result.manifest)) === startData.executionVersion.manifestSha256, 'Report input or executed version does not match registration');
          } else {
            check(record.directory && path.resolve(record.directory, result.manifest.entry) === path.resolve(result.entryPath), 'Legacy report cannot be associated with its workflow directory');
          }
          for (const checkpoint of result.checkpoints) {
            const saved = checkpoints.get(checkpoint.id);
            check(saved?.key === checkpoint.key, 'Report refers to a missing or mismatched checkpoint');
            // Registrations were introduced after the complete-material checkpoint contract.
            // Older reports retain their historical rule; this is explicit in legacy-verified.
            if (start) {
              check(saved.sequence > start.sequence && saved.sequence < report.artifact.sequence && saved.captureConsistency === 'consistent' && saved.metadata?.captureOutcome === 'completed' && saved.metadata?.captureStatus === 'complete', 'Report checkpoint materials are incomplete, inconsistent, or outside this execution');
              check(Array.isArray(saved.artifactRefs), 'Checkpoint material references are missing');
              const materials = saved.artifactRefs.map((ref: string) => artifacts.get(ref));
              for (const kind of ['screenshot', 'dom']) {
                const material = materials.find((material: any) => material?.kind === kind && material.captureStatus === 'complete' && material.sequence > start.sequence && material.sequence < saved.sequence && sha(material.sha256));
                check(material, `Checkpoint ${kind} material is unavailable`);
                // Metadata alone cannot establish that acknowledged material survived the crash.
                await reader.artifactFile(material.id);
              }
            }
          }
          const sourceIds = sources.filter(source => source.sequence < report.artifact.sequence && (!start || source.sequence > start.sequence)).map(source => source.id);
          const recomputed = validateExecution({ ...result, execution: result.status, knownSourceRefs: sourceIds });
          check(result.validation.overall !== 'pass' || recomputed.overall === 'pass', 'Saved pass cannot be reproduced from its execution and evidence references');
          Object.assign(record, { status: result.status, result, artifactId: report.artifact.id, recovery: {
            state: start ? 'verified' : 'legacy-verified', startEventId: start?.id, terminalEventId: terminal.id,
          } });
        } catch (error) {
          record.status = 'interrupted'; delete record.result; delete record.artifactId;
          record.error = `Validation evidence could not be verified: ${String(error)}`;
          record.recovery = { state: 'invalid', reason: record.error, startEventId: start?.id };
          diagnostics.push({ runId: run.id, validationId: id, code: 'validation-invalid', message: record.error });
        }
      }
    } catch (error) { diagnostics.push({ runId: run.id, code: 'run-validation-unreadable', message: String(error) }); }
  }
  const identityCounts = new Map<string, number>();
  for (const record of records) identityCounts.set(record.id, (identityCounts.get(record.id) ?? 0) + 1);
  for (const record of records) {
    if (identityCounts.get(record.id)! > 1) {
      delete record.result; delete record.artifactId; record.status = 'interrupted'; record.error = 'Validation identity occurs in multiple runs.';
      record.recovery = { state: 'invalid', reason: record.error };
      diagnostics.push({ runId: record.runId, validationId: record.id, code: 'validation-identity-conflict', message: record.error });
    }
  }
  for (const hint of previous) if (typeof hint.id === 'string' && !records.some(record => record.id === hint.id && record.runId === hint.runId)) diagnostics.push({ runId: hint.runId, validationId: hint.id, code: 'catalog-entry-unverified', message: 'Catalog entry has no verified run lifecycle and was not restored.' });
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  let catalogStatus: 'rebuilt' | 'write-failed' = 'rebuilt';
  try { await saveValidationCatalog(root, records); }
  catch (error) { catalogStatus = 'write-failed'; diagnostics.push({ code: 'catalog-write-failed', message: `Evidence was recovered but its catalog could not be saved: ${String(error)}` }); }
  return { records, diagnostics, catalogStatus };
}
