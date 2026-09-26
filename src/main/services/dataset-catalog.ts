import type { Dirent } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { DatasetError, executionId, type PersistentDatasetService } from '@/runner/datasets';
import type { DatasetSummary } from '@/runner/manager';
import { ensure } from '@/shared/errors';

export interface DatasetCatalogIssue { entry: string; code: string; message: string }
export interface DatasetCatalog { items: DatasetSummary[]; issues: DatasetCatalogIssue[] }

async function entries(directory: string, optional = false): Promise<Dirent[]> {
  try {
    const info = await lstat(directory);
    ensure(info.isDirectory() && !info.isSymbolicLink(), 'Dataset catalog requires a real root directory', 409);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: Dirent[] = [];
  for await (const entry of await opendir(directory)) found.push(entry);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function diagnostic(error: unknown): { status: DatasetSummary['status']; code: string; message: string } {
  const code = error instanceof DatasetError ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' :
    (error as NodeJS.ErrnoException).code ?? 'READ_FAILED';
  if (code === 'NOT_BEGUN' || code === 'NOT_INITIALIZED') return { status: 'not-initialized', code, message: 'Dataset initialization did not complete' };
  if (['INVALID_JSON', 'INDEX_RECOVERY_REQUIRED', 'IDENTITY_CONFLICT', 'COMPLETION_MISMATCH'].includes(code))
    return { status: 'corrupt', code, message: 'Dataset metadata is corrupt; explicit recovery is required' };
  return { status: 'unavailable', code, message: 'Dataset metadata is unavailable; preserved files were not changed' };
}

/** Enumerates durable indexes without a writer lease or batch-body scan.
 * A broken entry stays visible while independent committed datasets remain readable. */
export async function datasetCatalog(directory: string, id: string, reader: PersistentDatasetService): Promise<DatasetCatalog> {
  const root = path.join(directory, 'datasets'), items: DatasetSummary[] = [], issues: DatasetCatalogIssue[] = [];
  for (const attempt of await entries(root, true)) {
    const attemptEntry = attempt.name.slice(0, 128);
    try { executionId(attempt.name); } catch { issues.push({ entry: attemptEntry, code: 'INVALID_ID', message: 'Unsafe attempt directory name was not followed' }); continue; }
    if (!attempt.isDirectory() || attempt.isSymbolicLink()) {
      issues.push({ entry: attemptEntry, code: 'INVALID_ENTRY', message: 'Attempt entry is not a real directory and was not followed' }); continue;
    }
    let datasets: Dirent[];
    try { datasets = await entries(path.join(root, attempt.name)); }
    catch (error) { issues.push({ entry: attemptEntry, code: (error as NodeJS.ErrnoException).code ?? 'READ_FAILED', message: 'Attempt directory cannot be read' }); continue; }
    for (const dataset of datasets) {
      const entry = `${attemptEntry}/${dataset.name.slice(0, 128)}`;
      try { executionId(dataset.name); } catch { issues.push({ entry, code: 'INVALID_ID', message: 'Unsafe dataset entry name was not followed' }); continue; }
      const identity = { executionId: id, attemptId: attempt.name, datasetId: dataset.name };
      if (!dataset.isDirectory() || dataset.isSymbolicLink()) {
        items.push({ ...identity, status: 'unavailable', committedBatches: 0, committedRecords: 0,
          diagnostic: { code: 'INVALID_ENTRY', message: 'Dataset entry is not a real directory and was not followed' } });
        continue;
      }
      try {
        const value = await reader.summary(identity);
        items.push({ ...value.identity, status: value.status, committedBatches: value.committedBatches, committedRecords: value.committedRecords });
      } catch (error) {
        const { status, code, message } = diagnostic(error);
        items.push({ ...identity, status, committedBatches: 0, committedRecords: 0, diagnostic: { code, message } });
      }
    }
  }
  return { items, issues };
}
