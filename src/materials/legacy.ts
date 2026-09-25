import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BoundedPage, ReadBudget } from '@/contracts/recording';
import { jsonLines, safeFile } from '@/evidence/files';
import { MaterialError } from './errors';
import { id } from './validate';
import { measured } from './paging';

/** Legacy schema-1 evidence lacks a ReplayPosition; this projection never invents one. */
export interface LegacyCheckpointProjection {
  id: string;
  recordingId: string;
  title: string;
  description: string;
  requirementIds: string[];
  capturedAt?: string;
  captureTimeStatus: 'present' | 'missing';
  truncatedFields: Array<'title' | 'description' | 'requirementIds'>;
  anchorStatus: 'unavailable';
  sourceStatus: 'legacy-schema-1';
}
export interface LegacyMaterialPage extends BoundedPage<LegacyCheckpointProjection> {
  recordingId: string;
  invalidRecords: number;
  sourceStatus: 'complete' | 'partial' | 'missing' | 'read-failed';
  readFailure?: string;
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return measured<LegacyMaterialPage>({ recordingId, items: [], invalidRecords: 0, sourceStatus: 'missing', outputTruncated: false });
    throw error;
  }
  const stat = await fs.stat(file);
  const query = createHash('sha256').update(`${projectId}:${recordingId}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  let offset = 0;
  if (budget.cursor !== undefined) {
    if (budget.cursor.length > 4096) throw new MaterialError('INVALID_CURSOR', 'Legacy projection cursor is too long.');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(budget.cursor, 'base64url').toString('utf8')) as unknown; }
    catch { throw new MaterialError('INVALID_CURSOR', 'Legacy projection cursor is malformed.'); }
    if (!object(parsed) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > stat.size) {
      throw new MaterialError('INVALID_CURSOR', 'Legacy projection cursor is stale or out of range.');
    }
    offset = parsed.offset as number;
  }
  const items: LegacyCheckpointProjection[] = [];
  let invalidRecords = 0, nextOffset = offset, exhausted = true, anyTruncated = false;
  try {
    for await (const line of jsonLines(file, offset)) {
      if (items.length >= budget.limit) { exhausted = false; break; }
      if (line.invalid || !line.value || typeof line.value.id !== 'string') { invalidRecords++; nextOffset = line.offset + line.bytes; continue; }
      const source = line.value;
      const capturedAt = typeof source.captureEndedAt === 'string' ? source.captureEndedAt : typeof source.savedAt === 'string' ? source.savedAt : undefined;
      const title = typeof source.title === 'string' ? source.title : '';
      const description = typeof source.description === 'string' ? source.description : '';
      const requirementIds = Array.isArray(source.requirementIds) ? source.requirementIds.filter((item): item is string => typeof item === 'string') : [];
      const truncatedFields: LegacyCheckpointProjection['truncatedFields'] = [];
      if (title.length > 500) truncatedFields.push('title');
      if (description.length > 8000) truncatedFields.push('description');
      if (requirementIds.length > 100 || Array.isArray(source.requirementIds) && requirementIds.length !== source.requirementIds.length) truncatedFields.push('requirementIds');
      const projection: LegacyCheckpointProjection = { id: source.id as string, recordingId,
        title: title.slice(0, 500), description: description.slice(0, 8000), requirementIds: requirementIds.slice(0, 100),
        ...(capturedAt === undefined ? {} : { capturedAt }), captureTimeStatus: capturedAt === undefined ? 'missing' : 'present',
        truncatedFields, anchorStatus: 'unavailable', sourceStatus: 'legacy-schema-1' };
      const after = line.offset + line.bytes;
      const partial = invalidRecords > 0 || anyTruncated || truncatedFields.length > 0;
      const preview = measured<LegacyMaterialPage>({ recordingId, items: [...items, projection], invalidRecords,
        sourceStatus: partial ? 'partial' : 'complete', outputTruncated: after < stat.size || partial,
        ...(after < stat.size ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: after })).toString('base64url') } : {}) });
      if (preview.returnedBytes > budget.maxBytes) {
        if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One legacy checkpoint exceeds maxBytes.', 413);
        exhausted = false; break;
      }
      items.push(projection); nextOffset = after; anyTruncated ||= truncatedFields.length > 0;
    }
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    const page = measured<LegacyMaterialPage>({ recordingId, items, invalidRecords, sourceStatus: 'read-failed',
      readFailure: error instanceof Error ? error.name.slice(0, 80) : 'unknown-error', outputTruncated: true });
    if (page.returnedBytes > budget.maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Legacy error page exceeds maxBytes.', 413);
    return page;
  }
  const hasMore = !exhausted || nextOffset < stat.size;
  const page = measured<LegacyMaterialPage>({ recordingId, items, invalidRecords,
    sourceStatus: invalidRecords || anyTruncated ? 'partial' : 'complete', outputTruncated: hasMore || invalidRecords > 0 || anyTruncated,
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: nextOffset })).toString('base64url') } : {}) });
  if (page.returnedBytes > budget.maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Legacy projection page exceeds maxBytes.', 413);
  return page;
}
