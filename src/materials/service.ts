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
export type DraftSummary = { draftId: string; status: 'available'; draftRevision: number; updatedAt: string; author: MaterialAuthor; baseRevisionId?: string } |
  { draftId: string; status: 'unavailable'; reason: string };
export type RevisionSummary = { revisionId: string; status: 'available'; contentHash: string; createdAt: string; author: MaterialAuthor; parentRevisionId?: string } |
  { revisionId: string; status: 'unavailable'; reason: string };
/** Production adapter must resolve these against A's recorded replay/source index. */
export interface MaterialSourceVerifier {
  position(position: ReplayPosition): Promise<'reliable' | 'gap' | 'unsupported'>;
  target(target: HistoricalTarget): Promise<boolean>;
}
export class FileMaterialService implements MaterialService {
  constructor(private readonly dataRoot: string, private readonly sourceVerifier?: MaterialSourceVerifier) {}

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
  private async checkRecordingRefs(root: string, projectId: string, content: MaterialContent): Promise<void> {
    for (const recordingId of content.recordingRefs) {
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
      const reliability = await this.sourceVerifier!.position(checkpoint.anchor);
      if (reliability === 'unsupported') throw new MaterialError('INVALID_SOURCE', `Checkpoint ${checkpoint.id} has unsupported historical identity.`);
      if (reliability !== 'reliable' && content.annotations.some(annotation => annotation.checkpointId === checkpoint.id && annotation.bindingStatus === 'bound')) {
        throw new MaterialError('INVALID_SOURCE', `Checkpoint ${checkpoint.id} cannot have bound elements in a source gap.`);
      }
    }
    for (const annotation of content.annotations) {
      if (annotation.bindingStatus === 'bound' && !await this.sourceVerifier!.target(annotation.target)) throw new MaterialError('INVALID_SOURCE', `Annotation ${annotation.id} target is not recorded.`);
    }
    for (const field of content.fields) {
      if (field.target && field.bindingStatus === 'bound' && (!this.sourceVerifier || !await this.sourceVerifier.target(field.target))) {
        throw new MaterialError('INVALID_SOURCE', `Field ${field.id} target is not recorded.`);
      }
    }
  }
  async createDraft(projectId: string, author: MaterialAuthor, baseRevisionId?: string): Promise<TaskMaterialDraft> {
    authorOf(author);
    return this.locked(projectId, async (root, paths) => {
      const base = baseRevisionId === undefined ? undefined : await this.storedRevision(projectId, baseRevisionId, root, paths);
      const draft: TaskMaterialDraft = { schemaVersion: 1, projectId, draftId: randomUUID(), draftRevision: 0,
        ...(base ? { baseRevisionId: base.revisionId } : {}), author, updatedAt: new Date().toISOString(), content: clone(base?.content ?? EMPTY) };
      await createJson(path.join(paths.drafts, `${draft.draftId}.json`), draft);
      return draft;
    });
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
      await this.checkRecordingRefs(root, projectId, validated);
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
  async pageCollection<K extends keyof MaterialContent>(projectId: string,
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
    return this.withProject(projectId, async (root, paths) => {
      const folder = kind === 'draft' ? paths.drafts : paths.revisions;
      const before = await fs.stat(folder, { bigint: true });
      const query = createHash('sha256').update(`${projectId}:${kind}:${before.dev}:${before.ino}:${before.mtimeNs}`).digest('hex');
      let afterId = '';
      if (cursor !== undefined) {
        if (cursor.length > 4096) throw new MaterialError('INVALID_CURSOR', 'Material listing cursor is too long.');
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new MaterialError('INVALID_CURSOR', 'Material listing cursor is malformed.'); }
        if (!isRecord(parsed) || parsed.query !== query || typeof parsed.afterId !== 'string') throw new MaterialError('INVALID_CURSOR', 'Material listing cursor is stale or belongs to another collection.');
        afterId = id(parsed.afterId, 'cursor.afterId');
      }
      // opendir need not return sorted entries; keep only the next limit+1 IDs.
      const candidates: string[] = [];
      for await (const entry of await fs.opendir(folder)) {
        if (!entry.name.endsWith('.json')) continue;
        if (entry.isSymbolicLink()) throw new MaterialError('INVALID_PATH', 'Material listing contains a symbolic link.');
        if (!entry.isFile()) throw new MaterialError('INVALID_PATH', 'Material listing contains a non-file entry.');
        const entryId = entry.name.slice(0, -5);
        id(entryId, 'material file ID');
        if (entryId <= afterId) continue;
        candidates.push(entryId);
        candidates.sort();
        if (candidates.length > limit + 1) candidates.pop();
      }
      const items: Array<DraftSummary | RevisionSummary> = [];
      for (const candidateId of candidates.slice(0, limit)) {
        let summary: DraftSummary | RevisionSummary;
        try {
          if (kind === 'draft') {
            const draft = await this.storedDraft(projectId, candidateId, root, paths);
            summary = { draftId: candidateId, status: 'available', draftRevision: draft.draftRevision,
              updatedAt: draft.updatedAt, author: draft.author, ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}) };
          } else {
            const revision = await this.storedRevision(projectId, candidateId, root, paths);
            summary = { revisionId: candidateId, status: 'available', contentHash: revision.contentHash,
              createdAt: revision.createdAt, author: revision.author, ...(revision.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}) };
          }
        } catch (error) {
          if (!(error instanceof MaterialError) || !['INVALID_RECORD', 'HASH_MISMATCH', 'NOT_FOUND', 'MATERIAL_TOO_LARGE'].includes(error.code)) throw error;
          summary = kind === 'draft' ? { draftId: candidateId, status: 'unavailable', reason: error.code } :
            { revisionId: candidateId, status: 'unavailable', reason: error.code };
        }
        const candidate = [...items, summary];
        const hasMore = candidateId !== candidates.at(-1) || candidates.length > limit;
        const preview = measured<BoundedPage<DraftSummary | RevisionSummary>>({ items: candidate, outputTruncated: hasMore,
          ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ query, afterId: candidateId })).toString('base64url') } : {}) });
        if (preview.returnedBytes > maxBytes) {
          if (!items.length) throw new MaterialError('READ_BUDGET_EXCEEDED', 'One material summary exceeds maxBytes.', 413);
          break;
        }
        items.push(summary);
      }
      const after = await fs.stat(folder, { bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || before.dev !== after.dev) throw new MaterialError('LIST_CHANGED', 'Material listing changed during this read; restart from the first page.', 409);
      const lastId = items.length ? kind === 'draft' ? (items.at(-1) as DraftSummary).draftId : (items.at(-1) as RevisionSummary).revisionId : afterId;
      const hasMore = candidates.some(candidate => candidate > lastId);
      const page = measured<BoundedPage<DraftSummary | RevisionSummary>>({ items, outputTruncated: hasMore,
        ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ query, afterId: lastId })).toString('base64url') } : {}) });
      if (page.returnedBytes > maxBytes) throw new MaterialError('READ_BUDGET_EXCEEDED', 'Material summary page exceeds maxBytes.', 413);
      return page;
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
