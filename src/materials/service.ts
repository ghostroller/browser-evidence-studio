import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BoundedPage, HistoricalTarget, ReadBudget, ReplayPosition } from '@/contracts/recording';
import type { DraftUpdateResult, MaterialAuthor, MaterialContent, MaterialDifference, MaterialService, TaskMaterialDraft, TaskMaterialRevision } from '@/contracts/materials';
import { atomicJson, safeFile } from '@/evidence/files';
import { claimWriterLock, WriterLockError } from '@/evidence/writer-lock';
import { MaterialConflictError, MaterialError, MaterialPartialPublishError } from './errors';
import { id, validateContent } from './validate';
import { measured } from './paging';
import type { MaterialCatalog } from '@/contracts/workspace';

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const EMPTY: MaterialContent = { requirements: [], fields: [], checkpoints: [], annotations: [], recordingRefs: [] };
const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const authorOf = (value: unknown): MaterialAuthor => {
  if (value !== 'human' && value !== 'agent') throw new MaterialError('INVALID_AUTHOR', 'Author must be human or agent.');
  return value;
};
const revisionNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MaterialError('INVALID_REVISION', 'Expected draft revision must be a nonnegative integer.');
  return value as number;
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function materialContentHash(content: MaterialContent): string {
  return createHash('sha256').update(stable(validateContent(content))).digest('hex');
}
function checkHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new MaterialError('INVALID_HASH', 'Material hash must be SHA-256.');
  return value;
}
async function directory(parent: string, segment: string): Promise<string> {
  const result = path.join(parent, segment);
  try { await fs.mkdir(result); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(result);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MaterialError('INVALID_PATH', 'Material directory is not a regular directory.');
  return result;
}
async function readJson(file: string, root: string): Promise<unknown> {
  let resolved: string;
  try { resolved = await safeFile(root, path.relative(root, file).replaceAll('\\', '/')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MaterialError('NOT_FOUND', 'Material record does not exist.', 404);
    throw error;
  }
  const stat = await fs.stat(resolved);
  if (stat.size > MAX_FILE_BYTES) throw new MaterialError('MATERIAL_TOO_LARGE', 'Material record exceeds its read budget.', 413);
  try { return JSON.parse(await fs.readFile(resolved, 'utf8')) as unknown; }
  catch { throw new MaterialError('INVALID_RECORD', 'Material record is unreadable or damaged.', 500); }
}
async function createJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  let failure: unknown;
  try {
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
  } catch (error) { failure = error; }
  try { await fs.unlink(temporary); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (failure) throw new AggregateError([failure, error], 'Material manifest creation and temporary-file cleanup both failed.');
      throw error;
    }
  }
  if (failure) throw failure;
}

interface ProjectPaths { material: string; drafts: string; revisions: string }
export type DraftSummary = { draftId: string; status: 'available'; draftRevision: number; updatedAt: string; author: MaterialAuthor; baseRevisionId?: string; name?: string; hidden?: boolean; current?: boolean } |
  { draftId: string; status: 'unavailable'; reason: string };
export type RevisionSummary = { revisionId: string; status: 'available'; contentHash: string; createdAt: string; author: MaterialAuthor; parentRevisionId?: string; name?: string; hidden?: boolean; displayNumber?: number } |
  { revisionId: string; status: 'unavailable'; reason: string };
/** Production adapter must resolve these against A's recorded replay/source index. */
export interface MaterialSourceVerifier {
  position(position: ReplayPosition): Promise<'reliable' | 'gap' | 'unsupported'>;
  target(target: HistoricalTarget): Promise<boolean>;
}
export class FileMaterialService implements MaterialService {
  constructor(private readonly dataRoot: string, private readonly sourceVerifier?: MaterialSourceVerifier) {}

  private async readCatalog(root: string, paths: ProjectPaths): Promise<MaterialCatalog> {
    try {
      const value = await readJson(path.join(paths.material, 'catalog.json'), root);
      if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.catalogRevision) || !isRecord(value.drafts) || !isRecord(value.revisions) || !isRecord(value.recordings)) throw new MaterialError('INVALID_CATALOG', 'Material directory is damaged; original content was retained.', 500);
      for (const entries of [value.drafts, value.revisions, value.recordings]) for (const [key, entry] of Object.entries(entries)) {
        id(key, 'catalog identity');
        if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.hidden !== 'boolean' || entry.displayNumber !== undefined && (!Number.isSafeInteger(entry.displayNumber) || Number(entry.displayNumber) < 1)) throw new MaterialError('INVALID_CATALOG', 'Material directory entry is damaged.', 500);
      }
      if (value.workingDraftId !== undefined) id(value.workingDraftId, 'workingDraftId');
      return value as unknown as MaterialCatalog;
    } catch (error) {
      if (!(error instanceof MaterialError) || error.code !== 'NOT_FOUND') throw error;
      return { schemaVersion: 1, catalogRevision: 0, drafts: {}, revisions: {}, recordings: {} };
    }
  }
  private async saveCatalog(paths: ProjectPaths, catalog: MaterialCatalog) {
    await atomicJson(path.join(paths.material, 'catalog.json'), { ...catalog, catalogRevision: catalog.catalogRevision + 1 });
  }
  private async fileIds(folder: string) {
    const result: string[] = [];
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new MaterialError('INVALID_PATH', 'Material directory contains a non-file entry.');
      result.push(id(entry.name.slice(0, -5), 'material file ID'));
    }
    return result;
  }
  /** Migrate the complete legacy collection once, under the same writer as publication. */
  private async catalog(projectId: string, root: string, paths: ProjectPaths) {
    const catalog = await this.readCatalog(root, paths);
    let changed = false;
    const missing: Array<{ id: string; at: string }> = [];
    for (const revisionId of await this.fileIds(paths.revisions)) if (!catalog.revisions[revisionId]) {
      try { missing.push({ id: revisionId, at: (await this.storedRevision(projectId, revisionId, root, paths)).createdAt }); }
      catch (error) { if (!(error instanceof MaterialError) || !['INVALID_RECORD', 'HASH_MISMATCH', 'NOT_FOUND', 'MATERIAL_TOO_LARGE'].includes(error.code)) throw error; }
    }
    let number = Math.max(0, ...Object.values(catalog.revisions).map(entry => entry.displayNumber ?? 0));
    for (const value of missing.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      catalog.revisions[value.id] = { name: '', hidden: false, displayNumber: ++number }; changed = true;
    }
    if (changed) { await this.saveCatalog(paths, catalog); catalog.catalogRevision++; }
    return catalog;
  }
  workspaceCatalog(projectId: string) {
    return this.locked(projectId, (root, paths) => this.catalog(projectId, root, paths));
  }
  async workingDraft(projectId: string): Promise<TaskMaterialDraft> {
    return this.locked(projectId, async (root, paths) => {
      const catalog = await this.catalog(projectId, root, paths);
      if (catalog.workingDraftId) {
        if (catalog.drafts[catalog.workingDraftId]?.hidden) throw new MaterialError('INVALID_CATALOG', 'Current working copy is removed.', 409);
        return this.storedDraft(projectId, catalog.workingDraftId, root, paths);
      }
      const candidates: TaskMaterialDraft[] = [];
      for (const draftId of await this.fileIds(paths.drafts)) {
        if (catalog.drafts[draftId]?.hidden) continue;
        const candidate = await this.storedDraft(projectId, draftId, root, paths);
        if (candidate.author === 'human') candidates.push(candidate);
      }
      candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId));
      const draft = candidates[0] ?? await this.newDraft(projectId, 'human', root, paths);
      catalog.workingDraftId = draft.draftId;
      catalog.drafts[draft.draftId] ??= { name: '默认工作副本', hidden: false };
      await this.saveCatalog(paths, catalog);
      return draft;
    });
  }
  async setWorkingDraft(projectId: string, draftId: string) {
    return this.locked(projectId, async (root, paths) => {
      const draft = await this.storedDraft(projectId, draftId, root, paths), catalog = await this.catalog(projectId, root, paths);
      if (draft.author !== 'human' || catalog.drafts[draftId]?.hidden) throw new MaterialError('INVALID_WORKING_COPY', 'Choose an available human working copy.', 409);
      catalog.workingDraftId = draftId;
      catalog.drafts[draftId] ??= { name: '工作副本', hidden: false };
      await this.saveCatalog(paths, catalog); return draft;
    });
  }
  async entity(projectId: string, source: { kind: 'draft' | 'revision'; id: string; expectedHash?: string }, collection: Exclude<keyof MaterialContent, 'taskBrief' | 'recordingRefs'>, entityId: string) {
    if (!['requirements', 'fields', 'checkpoints', 'annotations'].includes(collection)) throw new MaterialError('INVALID_COLLECTION', 'Unknown entity collection.');
    id(entityId, 'entityId');
    const material = source.kind === 'draft' ? await this.getDraft(projectId, source.id) : await this.revision(projectId, source.id, source.expectedHash);
    const item = material.content[collection].find(value => value.id === entityId);
    if (!item) throw new MaterialError('NOT_FOUND', 'Material entity does not exist.', 404);
    return { item, draftRevision: 'draftRevision' in material ? material.draftRevision : undefined, contentHash: 'contentHash' in material ? material.contentHash : undefined };
  }

  private async root(): Promise<string> {
    const root = await fs.realpath(this.dataRoot);
    if (!(await fs.stat(root)).isDirectory()) throw new MaterialError('INVALID_DATA_ROOT', 'BES_DATA must be a directory.');
    return root;
  }
  private async project(root: string, projectId: string): Promise<ProjectPaths> {
    id(projectId, 'projectId');
    const workspace = await readJson(path.join(root, 'workspace.json'), root);
    if (!isRecord(workspace) || workspace.schemaVersion !== 1 || !Array.isArray(workspace.projects) ||
      workspace.projects.filter(item => isRecord(item) && item.id === projectId).length !== 1) {
      throw new MaterialError('UNKNOWN_PROJECT', 'Project is not registered in this data root.', 404);
    }
    const projects = await directory(root, 'projects');
    const project = await directory(projects, projectId);
    const material = await directory(project, 'materials');
    return { material, drafts: await directory(material, 'drafts'), revisions: await directory(material, 'revisions') };
  }
  private async withProject<T>(projectId: string, operation: (root: string, paths: ProjectPaths) => Promise<T>): Promise<T> {
    const root = await this.root();
    const paths = await this.project(root, projectId);
    return operation(root, paths);
  }
  private async locked<T>(projectId: string, operation: (root: string, paths: ProjectPaths) => Promise<T>): Promise<T> {
    return this.withProject(projectId, async (root, paths) => {
      let lock: Awaited<ReturnType<typeof claimWriterLock>> | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { lock = await claimWriterLock(paths.material); break; }
        catch (error) {
          if (!(error instanceof WriterLockError) || error.code !== 'WRITER_BUSY' || attempt === 29) throw error;
          await delay(Math.min(20 * (attempt + 1), 200));
        }
      }
      if (!lock) throw new MaterialError('WRITER_BUSY', 'Material writer did not become available.', 409);
      try { return await operation(root, paths); } finally { await lock.release(); }
    });
  }
  private async storedDraft(projectId: string, draftId: string, root: string, paths: ProjectPaths): Promise<TaskMaterialDraft> {
    id(draftId, 'draftId');
    const raw = await readJson(path.join(paths.drafts, `${draftId}.json`), root);
    if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.projectId !== projectId || raw.draftId !== draftId ||
      !Number.isSafeInteger(raw.draftRevision) || Number(raw.draftRevision) < 0 ||
      (raw.baseRevisionId !== undefined && typeof raw.baseRevisionId !== 'string') ||
      typeof raw.updatedAt !== 'string') throw new MaterialError('INVALID_RECORD', 'Draft identity or schema is damaged.', 500);
    const content = validateContent(raw.content);
    return { schemaVersion: 1, projectId, draftId, draftRevision: raw.draftRevision as number,
      ...(raw.baseRevisionId === undefined ? {} : { baseRevisionId: id(raw.baseRevisionId, 'baseRevisionId') }),
      author: authorOf(raw.author), updatedAt: raw.updatedAt, content };
  }
  private async storedRevision(projectId: string, revisionId: string, root: string, paths: ProjectPaths): Promise<TaskMaterialRevision> {
    id(revisionId, 'revisionId');
    const raw = await readJson(path.join(paths.revisions, `${revisionId}.json`), root);
    if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.projectId !== projectId || raw.revisionId !== revisionId ||
      (raw.parentRevisionId !== undefined && typeof raw.parentRevisionId !== 'string') || typeof raw.createdAt !== 'string') {
      throw new MaterialError('INVALID_RECORD', 'Revision identity or schema is damaged.', 500);
    }
    const content = validateContent(raw.content);
    const contentHash = checkHash(raw.contentHash);
    if (materialContentHash(content) !== contentHash) throw new MaterialError('HASH_MISMATCH', 'Revision content differs from its immutable hash.', 409);
    return { schemaVersion: 1, projectId, revisionId,
      ...(raw.parentRevisionId === undefined ? {} : { parentRevisionId: id(raw.parentRevisionId, 'parentRevisionId') }),
      contentHash, createdAt: raw.createdAt, author: authorOf(raw.author), content };
  }
  private async checkRecordingRefs(root: string, projectId: string, content: MaterialContent, previous?: MaterialContent): Promise<void> {
    for (const recordingId of content.recordingRefs) {
      if(previous?.recordingRefs.includes(recordingId))continue;
      id(recordingId, 'recordingId');
      const runs = path.join(root, 'runs');
      const run = path.join(runs, recordingId);
      let manifest: unknown;
      try { manifest = await readJson(path.join(run, 'manifest.json'), root); }
      catch (error) {
        if (error instanceof MaterialError && error.code === 'NOT_FOUND') throw new MaterialError('INVALID_SOURCE', `Recording ${recordingId} does not exist.`, 422);
        throw error;
      }
      if (!isRecord(manifest) || manifest.id !== recordingId || manifest.projectId !== projectId ||
        manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
        throw new MaterialError('INVALID_SOURCE', `Recording ${recordingId} does not belong to this project or has an unsupported manifest.`, 422);
      }
    }
    if (content.checkpoints.length && !this.sourceVerifier) throw new MaterialError('SOURCE_VERIFIER_REQUIRED', 'Checkpoint anchors require a recording source verifier.', 409);
    for (const checkpoint of content.checkpoints) {
      if(previous?.checkpoints.some(old=>old.id===checkpoint.id&&JSON.stringify(old.anchor)===JSON.stringify(checkpoint.anchor)))continue;
      const reliability = await this.sourceVerifier!.position(checkpoint.anchor);
      if (reliability === 'unsupported') throw new MaterialError('INVALID_SOURCE', `Checkpoint ${checkpoint.id} has unsupported historical identity.`);
      if (reliability !== 'reliable' && content.annotations.some(annotation => annotation.checkpointId === checkpoint.id && annotation.bindingStatus === 'bound')) {
        throw new MaterialError('INVALID_SOURCE', `Checkpoint ${checkpoint.id} cannot have bound elements in a source gap.`);
      }
    }
    for (const annotation of content.annotations) {
      if(previous?.annotations.some(old=>old.id===annotation.id&&old.bindingStatus===annotation.bindingStatus&&JSON.stringify(old.target)===JSON.stringify(annotation.target)))continue;
      if (annotation.bindingStatus === 'bound' && !await this.sourceVerifier!.target(annotation.target)) throw new MaterialError('INVALID_SOURCE', `Annotation ${annotation.id} target is not recorded.`);
    }
    for (const field of content.fields) {
      if(previous?.fields.some(old=>old.id===field.id&&old.bindingStatus===field.bindingStatus&&JSON.stringify(old.target)===JSON.stringify(field.target)))continue;
      if (field.target && field.bindingStatus === 'bound') {
        if (!this.sourceVerifier || await this.sourceVerifier.position(field.target.position) !== 'reliable' || !await this.sourceVerifier.target(field.target)) {
          throw new MaterialError('INVALID_SOURCE', `Field ${field.id} target is not reliable recorded source.`);
        }
      }
    }
  }
  private async newDraft(projectId: string, author: MaterialAuthor, root: string, paths: ProjectPaths, baseRevisionId?: string): Promise<TaskMaterialDraft> {
    const base = baseRevisionId === undefined ? undefined : await this.storedRevision(projectId, baseRevisionId, root, paths);
    const workspace = await readJson(path.join(root, 'workspace.json'), root) as { projects: Array<{ id: string; objective?: string }> };
    const draft: TaskMaterialDraft = { schemaVersion: 1, projectId, draftId: randomUUID(), draftRevision: 0,
      ...(base ? { baseRevisionId: base.revisionId } : {}), author, updatedAt: new Date().toISOString(),
      content: clone(base?.content ?? { ...EMPTY, taskBrief: { objective: workspace.projects.find(p => p.id === projectId)?.objective ?? '', scope: '' } }) };
    await createJson(path.join(paths.drafts, `${draft.draftId}.json`), draft);
    return draft;
  }
  async createDraft(projectId: string, author: MaterialAuthor, baseRevisionId?: string): Promise<TaskMaterialDraft> {
    authorOf(author);
    return this.locked(projectId, (root, paths) => this.newDraft(projectId, author, root, paths, baseRevisionId));
  }
  getDraft(projectId: string, draftId: string): Promise<TaskMaterialDraft> {
    return this.withProject(projectId, (root, paths) => this.storedDraft(projectId, draftId, root, paths));
  }
  async updateDraft(projectId: string, draftId: string, expectedDraftRevision: number, content: MaterialContent, author: MaterialAuthor): Promise<DraftUpdateResult> {
    revisionNumber(expectedDraftRevision); authorOf(author);
    const validated = validateContent(content);
    return this.locked(projectId, async (root, paths) => {
      const current = await this.storedDraft(projectId, draftId, root, paths);
      if (current.draftRevision !== expectedDraftRevision) return { status: 'conflict', current, expectedDraftRevision };
      await this.checkRecordingRefs(root, projectId, validated, current.content);
      const draft: TaskMaterialDraft = { ...current, draftRevision: current.draftRevision + 1, author, updatedAt: new Date().toISOString(), content: validated };
      await atomicJson(path.join(paths.drafts, `${draftId}.json`), draft);
      return { status: 'saved', draft };
    });
  }
  async publish(projectId: string, draftId: string, expectedDraftRevision: number, author: MaterialAuthor): Promise<TaskMaterialRevision> {
    revisionNumber(expectedDraftRevision); authorOf(author);
    return this.locked(projectId, async (root, paths) => {
      const draft = await this.storedDraft(projectId, draftId, root, paths);
      if (draft.draftRevision !== expectedDraftRevision) throw new MaterialConflictError(draft, expectedDraftRevision);
      await this.checkRecordingRefs(root, projectId, draft.content);
      const revision: TaskMaterialRevision = { schemaVersion: 1, projectId, revisionId: randomUUID(),
        ...(draft.baseRevisionId === undefined ? {} : { parentRevisionId: draft.baseRevisionId }),
        contentHash: materialContentHash(draft.content), createdAt: new Date().toISOString(), author, content: clone(draft.content) };
      await createJson(path.join(paths.revisions, `${revision.revisionId}.json`), revision);
      // The manifest is already durable. A failed draft advance is reported and
      // cannot make publication appear complete; the manifest remains inspectable.
      try {
        await atomicJson(path.join(paths.drafts, `${draftId}.json`), {
          ...draft, draftRevision: draft.draftRevision + 1, baseRevisionId: revision.revisionId,
          updatedAt: new Date().toISOString(), author,
        } satisfies TaskMaterialDraft);
      } catch (error) { throw new MaterialPartialPublishError(revision.revisionId, revision.contentHash, error); }
      try { await this.catalog(projectId, root, paths); } catch (error) { throw new MaterialPartialPublishError(revision.revisionId, revision.contentHash, error); }
      return revision;
    });
  }
  async revision(projectId: string, revisionId: string, expectedHash?: string): Promise<TaskMaterialRevision> {
    if (expectedHash !== undefined) checkHash(expectedHash);
    return this.withProject(projectId, async (root, paths) => {
      const revision = await this.storedRevision(projectId, revisionId, root, paths);
      if (expectedHash !== undefined && revision.contentHash !== expectedHash) throw new MaterialError('HASH_MISMATCH', 'Requested material hash does not match the revision.', 409);
      return revision;
    });
  }
  /** E can expose this page directly without serializing the complete draft/revision. */
  async pageCollection<K extends Exclude<keyof MaterialContent,"taskBrief">>(projectId: string,
    source: { kind: 'draft'; id: string } | { kind: 'revision'; id: string; expectedHash?: string },
    collection: K, budget: ReadBudget): Promise<BoundedPage<MaterialContent[K][number]>> {
    if (!['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'].includes(collection)) throw new MaterialError('INVALID_COLLECTION', 'Unknown material collection.');
    const { maxBytes, limit, cursor } = budget;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new MaterialError('INVALID_BUDGET', 'Material page budget is outside supported limits.');
    }
    const material = source.kind === 'draft' ? await this.getDraft(projectId, source.id) : await this.revision(projectId, source.id, source.expectedHash);
    const identity = 'draftRevision' in material ? `${material.draftRevision}:${materialContentHash(material.content)}` : material.contentHash;
    const query = createHash('sha256').update(`${projectId}:${source.kind}:${source.id}:${identity}:${collection}`).digest('hex');
    let offset = 0;
    if (cursor !== undefined) {
      if (cursor.length > 4096) throw new MaterialError('INVALID_CURSOR', 'Material cursor is too long.');
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new MaterialError('INVALID_CURSOR', 'Material cursor is malformed.'); }
      if (!isRecord(parsed) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new MaterialError('INVALID_CURSOR', 'Material cursor is stale or belongs to another collection.');
      offset = parsed.offset as number;
    }
    const all = material.content[collection];
    if (offset > all.length) throw new MaterialError('INVALID_CURSOR', 'Material cursor is past the end.');
    const items: MaterialContent[K][number][] = [];
    for (let index = offset; index < all.length && items.length < limit; index++) {
      const next = all[index] as MaterialContent[K][number];
      const candidate = [...items, next];
      const after = index + 1;
      const preview = measured<BoundedPage<MaterialContent[K][number]>>({ items: candidate, outputTruncated: after < all.length,
        ...(after < all.length ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: after })).toString('base64url') } : {}) });
      if (preview.returnedBytes > maxBytes) {
        if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One material item exceeds maxBytes; increase the read budget.', 413);
        break;
      }
      items.push(next);
    }
    const next = offset + items.length;
    const page = measured<BoundedPage<MaterialContent[K][number]>>({ items, outputTruncated: next < all.length,
      ...(next < all.length ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: next })).toString('base64url') } : {}) });
    if (page.returnedBytes > maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Material page exceeds maxBytes.', 413);
    return page;
  }
  listDrafts(projectId: string, budget: ReadBudget): Promise<BoundedPage<DraftSummary>> {
    return this.listSummaries(projectId, 'draft', budget);
  }
  listRevisions(projectId: string, budget: ReadBudget): Promise<BoundedPage<RevisionSummary>> {
    return this.listSummaries(projectId, 'revision', budget);
  }
  private async listSummaries(projectId: string, kind: 'draft', budget: ReadBudget): Promise<BoundedPage<DraftSummary>>;
  private async listSummaries(projectId: string, kind: 'revision', budget: ReadBudget): Promise<BoundedPage<RevisionSummary>>;
  private async listSummaries(projectId: string, kind: 'draft' | 'revision', budget: ReadBudget): Promise<BoundedPage<DraftSummary | RevisionSummary>> {
    const { maxBytes, limit, cursor } = budget;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new MaterialError('INVALID_BUDGET', 'Material listing budget is outside supported limits.');
    }
    return this.locked(projectId, async (root, paths) => {
      const catalog = await this.catalog(projectId, root, paths);
      const entries: Array<DraftSummary | RevisionSummary> = [];
      for (const key of await this.fileIds(kind === 'draft' ? paths.drafts : paths.revisions)) {
        try {
          if (kind === 'draft') {
            const value = await this.storedDraft(projectId, key, root, paths);
            entries.push({ draftId: key, status: 'available', draftRevision: value.draftRevision, updatedAt: value.updatedAt, author: value.author, baseRevisionId: value.baseRevisionId,
              ...catalog.drafts[key], current: catalog.workingDraftId === key });
          } else {
            const value = await this.storedRevision(projectId, key, root, paths);
            entries.push({ revisionId: key, status: 'available', contentHash: value.contentHash, createdAt: value.createdAt, author: value.author, parentRevisionId: value.parentRevisionId, ...catalog.revisions[key] });
          }
        } catch (error) {
          if (!(error instanceof MaterialError) || !['INVALID_RECORD', 'HASH_MISMATCH', 'NOT_FOUND', 'MATERIAL_TOO_LARGE'].includes(error.code)) throw error;
          entries.push(kind === 'draft' ? { draftId: key, status: 'unavailable', reason: error.code } : { revisionId: key, status: 'unavailable', reason: error.code });
        }
      }
      const key = (entry: DraftSummary | RevisionSummary) => 'draftId' in entry ? entry.draftId : entry.revisionId;
      const date = (entry: DraftSummary | RevisionSummary) => entry.status === 'available' ? ('updatedAt' in entry ? entry.updatedAt : entry.createdAt) : '';
      entries.sort((a, b) => date(b).localeCompare(date(a)) || key(b).localeCompare(key(a)));
      const query = createHash('sha256').update(JSON.stringify([projectId, kind, catalog.catalogRevision, entries])).digest('hex');
      let offset = 0;
      if (cursor !== undefined) {
        let parsed: unknown;
        try { if (cursor.length > 4096) throw new Error(); parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new MaterialError('INVALID_CURSOR', 'Material listing cursor is malformed.'); }
        if (!isRecord(parsed) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > entries.length) throw new MaterialError('INVALID_CURSOR', 'Material listing changed; restart from the first page.');
        offset = Number(parsed.offset);
      }
      const items: Array<DraftSummary | RevisionSummary> = [];
      const pageFor = (values: Array<DraftSummary | RevisionSummary>) => {
        const next = offset + values.length, more = next < entries.length;
        return measured<BoundedPage<DraftSummary | RevisionSummary>>({ items: values, outputTruncated: more,
          ...(more ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: next })).toString('base64url') } : {}) });
      };
      for (const entry of entries.slice(offset, offset + limit)) {
        if (pageFor([...items, entry]).returnedBytes > maxBytes) {
          if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One material summary exceeds maxBytes.', 413);
          break;
        }
        items.push(entry);
      }
      return pageFor(items);
    });
  }

  async diff(projectId: string, fromRevisionId: string, toRevisionId: string, budget: ReadBudget): Promise<BoundedPage<MaterialDifference>> {
    const { maxBytes, limit, cursor } = budget;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new MaterialError('INVALID_BUDGET', 'Diff budget is outside supported limits.');
    }
    const [before, after] = await Promise.all([this.revision(projectId, fromRevisionId), this.revision(projectId, toRevisionId)]);
    const query = createHash('sha256').update(`${projectId}:${before.revisionId}:${before.contentHash}:${after.revisionId}:${after.contentHash}`).digest('hex');
    let offset = 0;
    if (cursor !== undefined) {
      if (cursor.length > 4096) throw new MaterialError('INVALID_CURSOR', 'Diff cursor is too long.');
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new MaterialError('INVALID_CURSOR', 'Diff cursor is malformed.'); }
      if (!isRecord(parsed) || parsed.query !== query || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new MaterialError('INVALID_CURSOR', 'Diff cursor does not match this revision pair.');
      offset = parsed.offset as number;
    }
    const all = differences(before.content, after.content);
    if (offset > all.length) throw new MaterialError('INVALID_CURSOR', 'Diff cursor is past the end.');
    const items: MaterialDifference[] = [];
    for (let n = offset; n < all.length && items.length < limit; n++) {
      const after = n + 1;
      const preview = measured<BoundedPage<MaterialDifference>>({ items: [...items, all[n]], outputTruncated: after < all.length,
        ...(after < all.length ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: after })).toString('base64url') } : {}) });
      if (preview.returnedBytes > maxBytes) {
        if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One difference exceeds maxBytes; increase the read budget.', 413);
        break;
      }
      items.push(all[n]);
    }
    const next = offset + items.length;
    const page = measured<BoundedPage<MaterialDifference>>({ items, outputTruncated: next < all.length,
      ...(next < all.length ? { nextCursor: Buffer.from(JSON.stringify({ query, offset: next })).toString('base64url') } : {}) });
    if (page.returnedBytes > maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Difference page exceeds maxBytes.', 413);
    return page;
  }
}

function differences(before: MaterialContent, after: MaterialContent): MaterialDifference[] {
  const result: MaterialDifference[] = [];
  if (stable(before.taskBrief) !== stable(after.taskBrief)) result.push({ collection: 'taskBrief', id: 'taskBrief', change: !before.taskBrief ? 'added' : !after.taskBrief ? 'removed' : 'changed', changedFields: ['objective', 'scope'].filter(key => stable(before.taskBrief?.[key as 'objective' | 'scope']) !== stable(after.taskBrief?.[key as 'objective' | 'scope'])) });
  for (const collection of ['requirements', 'fields', 'checkpoints', 'annotations'] as const) {
    const left = new Map(before[collection].map(item => [item.id, item]));
    const right = new Map(after[collection].map(item => [item.id, item]));
    for (const entryId of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const a = left.get(entryId), b = right.get(entryId);
      if (!a || !b) result.push({ collection, id: entryId, change: a ? 'removed' : 'added', changedFields: [] });
      else if (stable(a) !== stable(b)) {
        const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => stable((a as unknown as Record<string, unknown>)[key]) !== stable((b as unknown as Record<string, unknown>)[key]));
        result.push({ collection, id: entryId, change: 'changed', changedFields: fields.map(key =>
          collection === 'checkpoints' && key === 'anchor' ? 'checkpoint-anchor-moved' :
          (collection === 'fields' || collection === 'annotations') && key === 'target' ? 'element-rebound' :
          collection === 'requirements' && key === 'rules' ? 'validation-rules' : key) });
      }
    }
  }
  for (const recordingId of [...new Set([...before.recordingRefs, ...after.recordingRefs])].sort()) {
    if (!before.recordingRefs.includes(recordingId) || !after.recordingRefs.includes(recordingId)) result.push({ collection: 'recordingRefs', id: recordingId,
      change: before.recordingRefs.includes(recordingId) ? 'removed' : 'added', changedFields: [] });
  }
  return result;
}
