import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskMaterialRevision } from '@/contracts/materials';
import { materialContentHash } from '@/materials';
import { ensure } from '@/shared/errors';
import type { TaskAuthorization, TaskAuthorizations } from './task-authorization';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 32 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Match recognizable credential values, not ordinary logical names containing
// words such as token or credential. Material IDs/bodies are read through the API.
const CREDENTIAL_VALUE = /^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})$/;

export interface FixedTaskHandoffInput {
  projectId: string;
  revisionId: string;
  contentHash: string;
  authorizationId: string;
  instanceId: string;
  connectionFile: string;
  skillFile?: string;
  scriptDirectory?: string;
  signal?: AbortSignal;
}

export interface FixedTaskHandoffManifest {
  schemaVersion: 2;
  kind: 'browser-evidence-studio-fixed-task';
  projectId: string;
  revisionId: string;
  contentHash: string;
  counts: Record<'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs' | 'unboundFields', number>;
  read: { operation: 'materialCollection'; kind: 'revision'; collections: Array<'requirements' | 'fields' | 'checkpoints' | 'annotations' | 'recordingRefs'>; limit: number; maxBytes: number };
  sourcePolicy: 'references-only';
  excluded: string[];
  taskSha256: string;
}

/** Ephemeral authority is kept apart from the immutable material identity. */
export interface FixedTaskAccess {
  schemaVersion: 1;
  instanceId: string;
  authorization: { authorizationId: string; expiresAt: string; capabilities: TaskAuthorization['capabilities']; sessionId?: string; profileId?: string; pages: TaskAuthorization['pages'] };
  connectionFile: string;
  skillFile?: string;
  scriptDirectory?: string;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function safeId(value: string): string {
  ensure(SAFE_ID.test(value) && !CREDENTIAL_VALUE.test(value), 'Handoff identity is unsafe to export', 422);
  return value;
}
function safeSourceId(value: string): string {
  ensure(SAFE_ID.test(value) && !CREDENTIAL_VALUE.test(value), 'Historical identity is unsafe to export; inspect it through the authorized API', 422);
  return value;
}
function bounded(text: string, limit: number): string {
  ensure(Buffer.byteLength(text, 'utf8') <= limit, 'Fixed handoff envelope exceeds its export budget', 413);
  return text;
}
async function regularDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'Handoff parent must be a regular directory', 422);
}

/** Trusted UI calls this after explicit human authorization. The durable files
 * carry only fixed references; no source bodies, screenshots or Bearer token. */
export async function exportFixedTaskHandoff(
  root: string,
  materials: { revision(projectId: string, revisionId: string, contentHash: string): Promise<TaskMaterialRevision> },
  tasks: TaskAuthorizations,
  input: FixedTaskHandoffInput,
): Promise<{ directory: string; taskFile: string; manifestFile: string; accessFile: string; taskSha256: string; revisionId: string; contentHash: string }> {
  input.signal?.throwIfAborted();
  safeId(input.projectId); safeId(input.revisionId);
  ensure(/^[a-f0-9]{64}$/.test(input.contentHash), 'Fixed material contentHash is required');
  const grant = await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });
  ensure(grant.capabilities.includes('materials-read'), 'Handoff authorization also requires materials-read', 403);
  ensure(typeof input.instanceId === 'string' && SAFE_ID.test(input.instanceId), 'Current instance identity is required');
  ensure(path.isAbsolute(input.connectionFile) && path.resolve(input.connectionFile) === path.join(path.resolve(root), 'connection', 'agent-connection.json'), 'Current connection file path is required');
  if (input.skillFile !== undefined) {
    ensure(path.isAbsolute(input.skillFile) && path.basename(input.skillFile) === 'SKILL.md', 'Installed skill path is invalid', 422);
    ensure((await fs.stat(input.skillFile)).isFile(), 'Installed task skill is unavailable', 409);
  }
  if (input.scriptDirectory !== undefined) ensure(grant.directory === await fs.realpath(input.scriptDirectory), 'Workflow directory differs from task authorization', 403);
  const revision = await materials.revision(input.projectId, input.revisionId, input.contentHash);
  ensure(revision.projectId === input.projectId && revision.revisionId === input.revisionId && revision.contentHash === input.contentHash && materialContentHash(revision.content) === input.contentHash,
    'Fixed material identity or hash differs from the requested revision', 409);
  input.signal?.throwIfAborted();
  await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });

  const counts = {
    requirements: revision.content.requirements.length, fields: revision.content.fields.length,
    checkpoints: revision.content.checkpoints.length, annotations: revision.content.annotations.length,
    recordingRefs: revision.content.recordingRefs.length,
    unboundFields: revision.content.fields.filter(item => item.bindingStatus && item.bindingStatus !== 'bound').length,
  };
  const task = bounded(`# Browser Evidence Studio fixed task\n\nProject: ${input.projectId}\nMaterial revision: ${input.revisionId}\nContent SHA-256: ${input.contentHash}\n\nRead manifest.json for fixed task identity and collection counts. Read access.json for this instance's temporary authorization; it is not part of the fixed task. Read the current-user-only connection file into the process without printing its token, then verify /v1/health instanceId against access.json before using the authorization. If the instance differs, authorization expired, or access was revoked, ask the human for a new trusted export.\n\nQuery materialRevision with both revisionId and contentHash, then page every materialCollection named in manifest.json. Use each response's nextCursor only for the next page of that same query; on a stale cursor restart that fixed collection. All requirements, fields, checkpoints, annotations, and recording references remain in the fixed revision, including items beyond the manifest budget. Descriptions and source bodies are intentionally absent from this export. History requires history-read; a materials-only grant can read task materials but cannot inspect historical evidence. Check taskChanges and materialDiff before adopting a newer revision. Candidate materials and machine assessment do not replace human approval. Respect page/origin scope, control ownership, expiry and revocation.\n`, MAX_TASK_BYTES);
  const manifest: FixedTaskHandoffManifest = { schemaVersion: 2, kind: 'browser-evidence-studio-fixed-task', projectId: input.projectId, revisionId: input.revisionId, contentHash: input.contentHash,
    counts, read: { operation: 'materialCollection', kind: 'revision', collections: ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'], limit: 50, maxBytes: 24576 },
    sourcePolicy: 'references-only', excluded: ['Bearer token', 'Cookie', 'browser profile', 'screenshot pixels', 'DOM and response bodies', 'signed URLs', 'free-text descriptions'], taskSha256: hash(task) };
  const access: FixedTaskAccess = { schemaVersion: 1, instanceId: input.instanceId,
    authorization: { authorizationId: grant.authorizationId, expiresAt: grant.expiresAt, capabilities: grant.capabilities, ...(grant.sessionId ? { sessionId: grant.sessionId } : {}), ...(grant.profileId ? { profileId: grant.profileId } : {}), pages: grant.pages.map(page => ({ pageId: safeSourceId(page.pageId), targetId: safeSourceId(page.targetId) })) },
    connectionFile: input.connectionFile, ...(input.skillFile ? { skillFile: input.skillFile } : {}), ...(input.scriptDirectory ? { scriptDirectory: input.scriptDirectory } : {}) };
  const manifestText = bounded(`${JSON.stringify(manifest, null, 2)}\n`, MAX_MANIFEST_BYTES);
  const accessText = bounded(`${JSON.stringify(access, null, 2)}\n`, MAX_MANIFEST_BYTES);
  const dataRoot = await fs.realpath(root);
  await regularDirectory(dataRoot);
  const projects = path.join(dataRoot, 'projects'); await regularDirectory(projects);
  const project = path.join(projects, input.projectId); await regularDirectory(project);
  const handoffs = path.join(project, 'handoffs');
  await fs.mkdir(handoffs, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  await regularDirectory(handoffs);
  const name = randomUUID(), temporary = path.join(handoffs, `.${name}.tmp`), directory = path.join(handoffs, name);
  await fs.mkdir(temporary);
  try {
    for (const [file, text] of [[path.join(temporary, 'task.md'), task], [path.join(temporary, 'manifest.json'), manifestText], [path.join(temporary, 'access.json'), accessText]]) {
      const handle = await fs.open(file, 'wx');
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    }
    input.signal?.throwIfAborted();
    await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });
    await fs.rename(temporary, directory);
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
  return { directory, taskFile: path.join(directory, 'task.md'), manifestFile: path.join(directory, 'manifest.json'), accessFile: path.join(directory, 'access.json'), taskSha256: manifest.taskSha256, revisionId: input.revisionId, contentHash: input.contentHash };
}
