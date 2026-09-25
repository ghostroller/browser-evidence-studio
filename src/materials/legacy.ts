import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BoundedPage, ReadBudget } from '@/contracts/recording';
import { jsonLines, safeFile } from '@/evidence/files';
import { MaterialError } from './errors';
import { id } from './validate';

/** Legacy schema-1 evidence lacks a ReplayPosition; this projection never invents one. */
export interface LegacyCheckpointProjection {
  id: string;
  recordingId: string;
  title: string;
  description: string;
  requirementIds: string[];
  capturedAt: string;
  anchorStatus: 'unavailable';
  sourceStatus: 'legacy-schema-1';
}
export interface LegacyMaterialPage extends BoundedPage<LegacyCheckpointProjection> {
  recordingId: string;
  invalidRecords: number;
  sourceStatus: 'complete' | 'missing' | 'read-failed';
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function projectLegacyRecording(dataRoot: string, projectId: string, recordingId: string, budget: ReadBudget): Promise<LegacyMaterialPage> {
  id(projectId, 'projectId'); id(recordingId, 'recordingId');
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.limit > 100 ||
      !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1024 || budget.maxBytes > 1024 * 1024) {
    throw new MaterialError('INVALID_BUDGET', 'Legacy projection budget is outside supported limits.');
  }
  const root = await fs.realpath(dataRoot);
  const run = path.join(root, 'runs', recordingId);
  let manifest: unknown;
  try { manifest = JSON.parse(await fs.readFile(await safeFile(root, `runs/${recordingId}/manifest.json`), 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MaterialError('NOT_FOUND', 'Legacy recording does not exist.', 404);
    throw error;
  }
  if (!object(manifest) || manifest.id !== recordingId || manifest.projectId !== projectId || manifest.schemaVersion !== 1) {
    throw new MaterialError('INVALID_SOURCE', 'Legacy recording identity, project or schema does not match.', 422);
  }
  let file: string;
  try { file = await safeFile(run, 'checkpoints.jsonl'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recordingId, items: [], invalidRecords: 0, sourceStatus: 'missing', returnedBytes: 0, outputTruncated: false };
    throw error;
  }
  const stat = await fs.stat(file);
  const query = createHash('sha256').update(`${projectId}:${recordingId}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  let offset = 0;
  if (budget.cursor !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(budget.cursor, 'base64url').toString('utf8')) as unknown; }
    catch { throw new MaterialError('INVALID_CURSOR', 'Legacy projection cursor is malformed.'); }
    if (!object(parsed) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > stat.size) {
      throw new MaterialError('INVALID_CURSOR', 'Legacy projection cursor is stale or out of range.');
    }
    offset = parsed.offset as number;
  }
  const items: LegacyCheckpointProjection[] = [];
  let invalidRecords = 0, nextOffset = offset, exhausted = true, itemBytes = 0;
  try {
    for await (const line of jsonLines(file, offset)) {
      if (items.length >= budget.limit) { exhausted = false; break; }
      if (line.invalid || !line.value || typeof line.value.id !== 'string') { invalidRecords++; nextOffset = line.offset + line.bytes; continue; }
      const source = line.value;
      const projection: LegacyCheckpointProjection = { id: source.id as string, recordingId,
        title: typeof source.title === 'string' ? source.title.slice(0, 500) : '',
        description: typeof source.description === 'string' ? source.description.slice(0, 8000) : '',
        requirementIds: Array.isArray(source.requirementIds) ? source.requirementIds.filter((item): item is string => typeof item === 'string').slice(0, 100) : [],
        capturedAt: typeof source.captureEndedAt === 'string' ? source.captureEndedAt : typeof source.savedAt === 'string' ? source.savedAt : '',
        anchorStatus: 'unavailable', sourceStatus: 'legacy-schema-1' };
      const bytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
      if (itemBytes + bytes > budget.maxBytes - 1024) {
        if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One legacy checkpoint exceeds maxBytes.', 413);
        exhausted = false; break;
      }
      items.push(projection); itemBytes += bytes; nextOffset = line.offset + line.bytes;
    }
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    return { recordingId, items, invalidRecords, sourceStatus: 'read-failed', returnedBytes: itemBytes, outputTruncated: true };
  }
  const outputTruncated = !exhausted || nextOffset < stat.size;
  const page: LegacyMaterialPage = { recordingId, items, invalidRecords, sourceStatus: 'complete', returnedBytes: 0, outputTruncated,
    ...(outputTruncated ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: nextOffset })).toString('base64url') } : {}) };
  page.returnedBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
  if (page.returnedBytes > budget.maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Legacy projection page exceeds maxBytes.', 413);
  return page;
}
