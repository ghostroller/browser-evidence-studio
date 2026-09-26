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
const PRIVATE_ID = /(?:password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key)/i;

export interface FixedTaskHandoffInput {
  projectId: string;
  revisionId: string;
  contentHash: string;
  authorizationId: string;
  instanceId: string;
  connectionFile: string;
  scriptDirectory?: string;
  signal?: AbortSignal;
}

export interface FixedTaskHandoffManifest {
  schemaVersion: 1;
  kind: 'browser-evidence-studio-fixed-task';
  projectId: string;
  revisionId: string;
  contentHash: string;
  instanceId: string;
  authorization: { authorizationId: string; expiresAt: string; capabilities: TaskAuthorization['capabilities']; sessionId?: string; profileId?: string; pages: TaskAuthorization['pages'] };
  connectionFile: string;
  scriptDirectory?: string;
  requirements: Array<{ id: string; dataset?: string; fieldIds: string[]; ruleTypes: string[] }>;
  fields: Array<{ id: string; dataset: string; sourcePolicy: string; bindingStatus?: string }>;
  checkpoints: Array<{ id: string; kind: string; anchor: { recordingId: string; pageId: string; documentId: string; streamEpoch: string; sourceTimeMs: number; eventSeq: number }; requirementIds: string[] }>;
  recordingRefs: string[];
  gaps: Array<{ kind: 'unbound-field'; fieldId: string }>;
  sourcePolicy: 'references-only';
  excluded: string[];
  taskSha256: string;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function safeId(value: string): string {
  ensure(SAFE_ID.test(value) && !PRIVATE_ID.test(value), 'Handoff identity is unsafe to export', 422);
  return value;
}
function safeSourceId(value: string): string {
  ensure(SAFE_ID.test(value) && !PRIVATE_ID.test(value), 'Historical identity is unsafe to export; inspect it through the authorized API', 422);
  return value;
}
function bounded(text: string, limit: number): string {
  ensure(Buffer.byteLength(text, 'utf8') <= limit, 'Fixed handoff exceeds its export budget; narrow the material revision', 413);
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
): Promise<{ directory: string; taskFile: string; manifestFile: string; taskSha256: string; revisionId: string; contentHash: string }> {
  input.signal?.throwIfAborted();
  safeId(input.projectId); safeId(input.revisionId);
  ensure(/^[a-f0-9]{64}$/.test(input.contentHash), 'Fixed material contentHash is required');
  const grant = await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });
  ensure(grant.capabilities.includes('materials-read'), 'Handoff authorization also requires materials-read', 403);
  ensure(typeof input.instanceId === 'string' && SAFE_ID.test(input.instanceId), 'Current instance identity is required');
  ensure(path.isAbsolute(input.connectionFile) && path.resolve(input.connectionFile) === path.join(path.resolve(root), 'connection', 'agent-connection.json'), 'Current connection file path is required');
  if (input.scriptDirectory !== undefined) ensure(grant.directory === await fs.realpath(input.scriptDirectory), 'Workflow directory differs from task authorization', 403);
  const revision = await materials.revision(input.projectId, input.revisionId, input.contentHash);
  ensure(revision.projectId === input.projectId && revision.revisionId === input.revisionId && revision.contentHash === input.contentHash && materialContentHash(revision.content) === input.contentHash,
    'Fixed material identity or hash differs from the requested revision', 409);
  input.signal?.throwIfAborted();
  await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });

  const requirements = revision.content.requirements.map(item => ({ id: safeId(item.id), ...(item.dataset ? { dataset: safeId(item.dataset) } : {}), fieldIds: item.fieldIds.map(safeId), ruleTypes: item.rules.map(rule => rule.type) }));
  const fields = revision.content.fields.map(item => ({ id: safeId(item.id), dataset: safeId(item.dataset), sourcePolicy: item.sourcePolicy, ...(item.bindingStatus ? { bindingStatus: item.bindingStatus } : {}) }));
  const checkpoints = revision.content.checkpoints.map(item => ({ id: safeId(item.id), kind: item.kind,
    anchor: { recordingId: safeId(item.anchor.recordingId), pageId: safeSourceId(item.anchor.pageId), documentId: safeSourceId(item.anchor.documentId), streamEpoch: safeSourceId(item.anchor.streamEpoch), sourceTimeMs: item.anchor.sourceTimeMs, eventSeq: item.anchor.eventSeq },
    requirementIds: item.requirementIds.map(safeId) }));
  const recordingRefs = revision.content.recordingRefs.map(safeId);
  const gaps = revision.content.fields.filter(item => item.bindingStatus && item.bindingStatus !== 'bound').map(item => ({ kind: 'unbound-field' as const, fieldId: safeId(item.id) }));
  const task = bounded(`# Browser Evidence Studio fixed task\n\nProject: ${input.projectId}\nMaterial revision: ${input.revisionId}\nContent SHA-256: ${input.contentHash}\nInstance: ${input.instanceId}\nAuthorization ID: ${grant.authorizationId} (scope identifier, not a Bearer token; expires ${grant.expiresAt})\nConnection file: ${input.connectionFile}\n\nRead manifest.json first. Use the current-user-only connection file for the Bearer token, then verify /v1/health instanceId and query the fixed revision with both revisionId and contentHash. Read requirements, fields, checkpoints and recording references through bounded materialCollection pages; descriptions and source bodies are intentionally absent from this export. Check taskChanges and materialDiff before adopting a newer revision. Candidate materials and machine assessment do not replace human approval. Respect task page/origin scope, control ownership, expiry and revocation.\n`, MAX_TASK_BYTES);
  const manifest: FixedTaskHandoffManifest = { schemaVersion: 1, kind: 'browser-evidence-studio-fixed-task', projectId: input.projectId, revisionId: input.revisionId, contentHash: input.contentHash, instanceId: input.instanceId,
    authorization: { authorizationId: grant.authorizationId, expiresAt: grant.expiresAt, capabilities: grant.capabilities, ...(grant.sessionId ? { sessionId: grant.sessionId } : {}), ...(grant.profileId ? { profileId: grant.profileId } : {}), pages: grant.pages.map(page => ({ pageId: safeSourceId(page.pageId), targetId: safeSourceId(page.targetId) })) },
    connectionFile: input.connectionFile, ...(input.scriptDirectory ? { scriptDirectory: input.scriptDirectory } : {}), requirements, fields, checkpoints, recordingRefs, gaps,
    sourcePolicy: 'references-only', excluded: ['Bearer token', 'Cookie', 'browser profile', 'screenshot pixels', 'DOM and response bodies', 'signed URLs', 'free-text descriptions'], taskSha256: hash(task) };
  const manifestText = bounded(`${JSON.stringify(manifest, null, 2)}\n`, MAX_MANIFEST_BYTES);
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
    for (const [file, text] of [[path.join(temporary, 'task.md'), task], [path.join(temporary, 'manifest.json'), manifestText]]) {
      const handle = await fs.open(file, 'wx');
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    }
    input.signal?.throwIfAborted();
    await tasks.check(input.authorizationId, 'handoff-export', { projectId: input.projectId });
    await fs.rename(temporary, directory);
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
  return { directory, taskFile: path.join(directory, 'task.md'), manifestFile: path.join(directory, 'manifest.json'), taskSha256: manifest.taskSha256, revisionId: input.revisionId, contentHash: input.contentHash };
}
