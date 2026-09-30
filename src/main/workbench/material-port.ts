import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserMaterialRequest, BrowserRecordingSummary } from '../../contracts/browser-materials';
import { BROWSER_MATERIAL_BUDGET } from '../../contracts/browser-materials';
import type { BoundedPage, ReadBudget } from '../../contracts/recording';
import { EvidenceError } from '../../evidence/contracts';
import { safeFile } from '../../evidence/files';
import { MaterialError } from '../../materials/errors';
import { measured } from '../../materials/paging';
import { StudioError } from '../../shared/errors';
import { ProjectMaterials, materialBudget, materialSummary } from '../services/project-materials';
import { WorkbenchError } from './errors';

export interface MaterialExecutionAccess { authorize(): void }
export interface BrowserMaterialPort { execute(request: BrowserMaterialRequest, access: MaterialExecutionAccess): Promise<unknown> }
function bounded<T>(result: T, maximum: number = BROWSER_MATERIAL_BUDGET.responseBytes): T {
  if (Buffer.byteLength(JSON.stringify(result)) > maximum) throw new WorkbenchError('unavailable');
  return result;
}
/** Explicit application adapter over the same FileMaterialService as Electron.
 * There is no Studio.dispatch(ui), source impersonation or second writer. */
export function createBrowserMaterialPort(root: string, materials: ProjectMaterials): BrowserMaterialPort {
  async function manifest(recordingId: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(recordingId)) throw new WorkbenchError('invalid_request');
    const file = await safeFile(root, `runs/${recordingId}/manifest.json`);
    if ((await stat(file)).size > 1024 * 1024) throw new WorkbenchError('unavailable');
    const result: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WorkbenchError('unavailable');
    return result as Record<string, unknown>;
  }
  async function sealed(projectId: string, recordingId: string): Promise<void> {
    const source = await manifest(recordingId);
    if (source.id !== recordingId || source.projectId !== projectId) throw new WorkbenchError('forbidden');
    if (source.status !== 'sealed' || typeof source.sealedAt !== 'string' || !Number.isFinite(Date.parse(source.sealedAt))) throw new WorkbenchError('conflict');
  }
  async function recordings(projectId: string, budget: ReadBudget): Promise<BoundedPage<BrowserRecordingSummary>> {
    // Scan descriptors only; raw recording resources never cross this boundary.
    // A bounded top-page selection avoids allocating an unbounded directory list.
    let after = '';
    const binding = createHash('sha256').update(projectId).digest('hex');
    if (budget.cursor) {
      try { const parsed = JSON.parse(Buffer.from(budget.cursor, 'base64url').toString('utf8')); if (parsed.binding !== binding || typeof parsed.after !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(parsed.after)) throw new Error(); after = parsed.after; }
      catch { throw new WorkbenchError('invalid_request'); }
    }
    const candidates: BrowserRecordingSummary[] = [];
    let folder;
    try { const runs = path.join(await realpath(root), 'runs'); const info = await lstat(runs); if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkbenchError('forbidden'); folder = await opendir(runs); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return measured({ items: [], outputTruncated: false }); throw error; }
    let scanned = 0, bytes = 0;
    for await (const entry of folder) {
      if (++scanned > 2000) throw new WorkbenchError('unavailable');
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name <= after) continue;
      const source = await manifest(entry.name);
      bytes += Buffer.byteLength(JSON.stringify(source));
      if (bytes > 8 * 1024 * 1024) throw new WorkbenchError('unavailable');
      if (source.projectId !== projectId || source.status !== 'sealed') continue;
      if (source.id !== entry.name || typeof source.sealedAt !== 'string' || !Number.isFinite(Date.parse(source.sealedAt))) throw new WorkbenchError('unavailable');
      candidates.push({ recordingId: entry.name, sealedAt: source.sealedAt });
      candidates.sort((a, b) => a.recordingId < b.recordingId ? -1 : a.recordingId > b.recordingId ? 1 : 0);
      if (candidates.length > budget.limit + 1) candidates.pop();
    }
    const items: BrowserRecordingSummary[] = [];
    const pageFor = (values: BrowserRecordingSummary[]) => measured<BoundedPage<BrowserRecordingSummary>>({ items: values, outputTruncated: values.length < candidates.length,
      ...(values.length < candidates.length && values.length ? { nextCursor: Buffer.from(JSON.stringify({ binding, after: values.at(-1)!.recordingId })).toString('base64url') } : {}) });
    for (const item of candidates.slice(0, budget.limit)) {
      if (pageFor([...items, item]).returnedBytes > budget.maxBytes) break;
      items.push(item);
    }
    if (!items.length && candidates.length) throw new WorkbenchError('unavailable');
    return pageFor(items);
  }
  return { execute: async (request, access) => {
    try {
      access.authorize();
      const { method, body } = request;
      const service = materials.service;
      const result = await service.withAccess({ authorize: () => access.authorize(), verifyRecording: sealed }, async () => {
        const budget = materialBudget(body as { maxBytes?: number; limit?: number; cursor?: string });
        switch (method) {
          case 'materialCatalog': return service.workspaceCatalog(body.projectId);
          case 'manageMaterialCatalog': if (body.kind === 'recordings') await sealed(body.projectId, body.id); return service.manageCatalog(body.projectId, body);
          case 'workingMaterialDraft': return materialSummary(await service.workingDraft(body.projectId));
          case 'setWorkingMaterialDraft': return materialSummary(await service.setWorkingDraft(body.projectId, body.draftId));
          case 'materialDrafts': return service.listDrafts(body.projectId, budget);
          case 'materialRevisions': return service.listRevisions(body.projectId, budget);
          case 'materialDraft': return materialSummary(await service.getDraft(body.projectId, body.draftId));
          case 'materialRevision': return materialSummary(await service.revision(body.projectId, body.revisionId, body.contentHash));
          case 'materialCollection': return service.pageCollection(body.projectId, { kind: body.kind, id: body.kind === 'draft' ? body.draftId : body.revisionId, expectedHash: body.kind === 'revision' ? body.contentHash : undefined }, body.collection, budget);
          case 'materialEntity': return service.entity(body.projectId, { kind: body.kind, id: body.kind === 'draft' ? body.draftId : body.revisionId, expectedHash: body.kind === 'revision' ? body.contentHash : undefined }, body.collection, body.entityId);
          case 'createMaterialDraft': return materialSummary(await service.createDraft(body.projectId, 'human', body.baseRevisionId, body.operationId));
          case 'copyMaterialDraft': return materialSummary(await service.copyDraft(body.projectId, body.draftId, body.expectedDraftRevision, body.operationId));
          case 'editMaterialDraft': return materials.edit(body.projectId, body.draftId, body.expectedDraftRevision, body.edits, 'ui');
          case 'publishMaterialDraft': return materialSummary(await service.publish(body.projectId, body.draftId, body.expectedDraftRevision, 'human', body.operationId));
          case 'materialPublicationStatus': return service.publicationStatus(body.projectId, body.operationId);
          case 'prepareMaterialArchive': return service.prepareArchive(body.projectId, body.draftId);
          case 'materialDiff': return service.diff(body.projectId, body.fromRevisionId, body.toRevisionId, budget);
          case 'materialDraftDiff': return service.draftDiff(body.projectId, body.draftId, budget);
          case 'materialRecordings': return recordings(body.projectId, budget);
          case 'recordingStreams': await sealed(body.projectId, body.recordingId); return bounded(await (await materials.replay(body.recordingId, body.projectId)).archive.streams(budget.limit, body.cursor), budget.maxBytes);
          case 'recordingPositions': await sealed(body.projectId, body.position.recordingId); return bounded(await (await materials.replay(body.position.recordingId, body.projectId)).archive.positions(body.position, budget.limit, body.ordinal), budget.maxBytes);
        }
      });
      return bounded(result);
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      const status = error instanceof MaterialError ? error.statusCode : error instanceof EvidenceError ? error.statusCode : error instanceof StudioError ? error.status : 500;
      throw new WorkbenchError(status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 400 || status === 422 ? 'invalid_request' : 'unavailable');
    }
  } };
}
