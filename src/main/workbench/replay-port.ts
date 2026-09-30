import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { WEB_REPLAY_BUDGET, type WebReplayIdentity, type WebReplayMethod, type WebReplayBundle } from '../../contracts/web-replay';
import { parseReplayPosition } from '../../contracts/recording';
import { safeFile } from '../../evidence/files';
import { SourceModel } from '../../replay/source-model';
import { prepareReplayEvents } from '../../replay/rrweb-player';
import { ResourceArchive } from '../../resources/archive';
import { OfflineResourceService, prepareArchivedReplay } from '../../resources/replay-resources';
import type { ProjectMaterials } from '../services/project-materials';
import { checkJsonBudget, exactKeys, identifier, record, revision, textField } from './validation';
import { WorkbenchError } from './errors';
export const isReplayMethod = (method: unknown): method is WebReplayMethod => method === 'webReplayBundle' || method === 'webReplaySelection';
export function parseWebReplayRequest(value: unknown) {
  checkJsonBudget(value);
  if (Buffer.byteLength(JSON.stringify(value)) > WEB_REPLAY_BUDGET.requestBytes) throw new WorkbenchError('invalid_request');
  const envelope = record(value); exactKeys(envelope, ['instanceId', 'method', 'body']);
  if (!isReplayMethod(envelope.method)) throw new WorkbenchError('invalid_request');
  const body = record(envelope.body); exactKeys(body, ['projectId', 'replayId', 'generation', 'position'], envelope.method === 'webReplaySelection' ? ['nodeId'] : []);
  identifier(body.projectId); identifier(body.replayId); revision(body.generation);
  if (Number(body.generation) < 1) throw new WorkbenchError('invalid_request');
  const position = record(body.position); exactKeys(position, ['recordingId', 'pageId', 'documentId', 'streamEpoch', 'sourceTimeMs', 'eventSeq']);
  identifier(position.recordingId); for (const field of ['pageId', 'documentId', 'streamEpoch']) textField(position[field], 256, true);
  let parsed; try { parsed = parseReplayPosition(position); } catch { throw new WorkbenchError('invalid_request'); }
  if (envelope.method === 'webReplaySelection') revision(body.nodeId);
  return { instanceId: identifier(envelope.instanceId), method: envelope.method, body: { projectId: String(body.projectId), replayId: String(body.replayId), generation: Number(body.generation), position: parsed, ...(envelope.method === 'webReplaySelection' ? { nodeId: Number(body.nodeId) } : {}) } };
}
export interface BrowserReplayPort { execute(request: ReturnType<typeof parseWebReplayRequest>, access: { authorize(): void }, signal?: AbortSignal): Promise<unknown> }
/** No cached authority, writer, raw paths or resource-id endpoint. Every bundle
 * is self-contained and can only contain bytes selected by the archive resolver. */
export function createBrowserReplayPort(root: string, materials: ProjectMaterials): BrowserReplayPort {
  return { async execute(request, access, signal) {
    const check = () => { access.authorize(); signal?.throwIfAborted(); };
    try {
      check(); const { body } = request;
      const manifestFile = await safeFile(root, `runs/${body.position.recordingId}/manifest.json`);
      if ((await stat(manifestFile)).size > 1024 * 1024) throw new WorkbenchError('unavailable');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); check();
      if (manifest.id !== body.position.recordingId || manifest.projectId !== body.projectId) throw new WorkbenchError('forbidden');
      if (manifest.status !== 'sealed' || typeof manifest.sealedAt !== 'string' || !Number.isFinite(Date.parse(manifest.sealedAt))) throw new WorkbenchError('conflict');
      const service = await materials.replay(body.position.recordingId, body.projectId);
      const window = await service.window(body.position, signal); check();
      const identity: WebReplayIdentity = { projectId: body.projectId, replayId: body.replayId, generation: body.generation, position: body.position };
      if (request.method === 'webReplaySelection') {
        const model = new SourceModel(window.records), node = model.nodes.get(body.nodeId!);
        if (!node?.metadata) throw new WorkbenchError('not_found');
        const target = { kind: 'dom-node' as const, position: body.position, nodeId: node.id, frameId: node.metadata.frameId, mirrorScopeId: node.metadata.mirrorScopeId };
        if (!model.node(target).metadataComplete || window.gaps.some(gap => gap.category === 'structure' || gap.category === 'metadata')) throw new WorkbenchError('conflict');
        check(); return { ...identity, target };
      }
      if (Buffer.byteLength(JSON.stringify(window.records)) > WEB_REPLAY_BUDGET.eventBytes) throw new WorkbenchError('unavailable');
      const archive = new ResourceArchive(path.join(root, 'runs', body.position.recordingId)), offline = new OfflineResourceService(archive);
      const pending = new Map<string, { id: string; position: typeof body.position }>();
      const url = (id: string, position: typeof body.position): string => {
        const key = `bes-inline:${id}:${position.eventSeq}`;
        if (!pending.has(key)) {
          if (pending.size >= WEB_REPLAY_BUDGET.resources) throw new WorkbenchError('unavailable');
          pending.set(key, { id, position });
        }
        return key;
      };
      const resolved = await prepareArchivedReplay(window.records, archive, url); check();
      const resources: WebReplayBundle['resources'] = [];
      const diagnostics = resolved.diagnostics.map(item => ({ status: item.status, reason: item.reason }));
      let totalBytes = 0;
      // Dependencies are discovered only through OfflineResourceService's
      // source/version checks. The global unique-resource cap also bounds cycles.
      for (const [key, resource] of pending) {
        check();
        try {
          const result = await offline.response(resource.id, resource.position, id => url(id, resource.position)); check();
          totalBytes += result.bytes.byteLength;
          if (totalBytes > WEB_REPLAY_BUDGET.resourceBytes) throw new WorkbenchError('unavailable');
          resources.push({ key, mime: result.headers['content-type'], base64: Buffer.from(result.bytes).toString('base64') });
          diagnostics.push(...result.diagnostics.map(item => ({ status: item.status, reason: item.reason })));
        } catch (error) { check(); if (error instanceof WorkbenchError) throw error; const code = (error as { code?: string }).code; diagnostics.push({ status: code === 'ENOENT' || code === 'RESOURCE_UNAVAILABLE' ? 'missing' : 'read-failed', reason: code === 'RESOURCE_INTEGRITY' ? 'Archived resource hash or length mismatch' : 'Archived resource failed integrity or availability verification' }); }
      }
      const prepared = prepareReplayEvents({ ...window, records: resolved.records });
      const bundle: WebReplayBundle = { ...identity, events: prepared.events, offsets: window.records.map((item, index) => ({ position: item.position, offset: prepared.events[index + 1].timestamp - prepared.events[0].timestamp + 0.001 })), resources, diagnostics: diagnostics.slice(0, 128) };
      if (Buffer.byteLength(JSON.stringify(bundle)) > WEB_REPLAY_BUDGET.responseBytes) throw new WorkbenchError('unavailable');
      check(); return bundle;
    } catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError(signal?.aborted ? 'cancelled' : 'unavailable'); }
  } };
}
