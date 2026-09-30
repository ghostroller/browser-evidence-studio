import { BROWSER_MATERIAL_BUDGET, BROWSER_MATERIAL_METHODS, type BrowserMaterialRequest } from '../../contracts/browser-materials';
import { parseReplayPosition } from '../../contracts/recording';
import { WorkbenchError } from './errors';
import { checkJsonBudget, exactKeys, identifier, record, revision, textField } from './validation';

const methods = new Set<string>(BROWSER_MATERIAL_METHODS);
const collections = ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'];
export const isMaterialMethod = (method: unknown): boolean => typeof method === 'string' && methods.has(method);
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new WorkbenchError('invalid_request');
  return Number(value);
}
function oneOf(value: unknown, options: readonly string[]): void { if (typeof value !== 'string' || !options.includes(value)) throw new WorkbenchError('invalid_request'); }
function position(value: unknown): void {
  const input = record(value); exactKeys(input, ['recordingId', 'pageId', 'documentId', 'streamEpoch', 'sourceTimeMs', 'eventSeq']);
  identifier(input.recordingId);
  for (const key of ['pageId', 'documentId', 'streamEpoch']) textField(input[key], 256, true);
  try { parseReplayPosition(value); } catch { throw new WorkbenchError('invalid_request'); }
}
function target(value: unknown): void {
  const input = record(value); position(input.position);
  if (input.kind === 'dom-node') {
    exactKeys(input, ['kind', 'position', 'frameId', 'mirrorScopeId', 'nodeId']);
    textField(input.frameId, 256, true); textField(input.mirrorScopeId, 256, true); revision(input.nodeId);
  } else if (input.kind === 'visual-region') {
    exactKeys(input, ['kind', 'position', 'artifactId', 'rect']); identifier(input.artifactId);
    const rect = record(input.rect); exactKeys(rect, ['x', 'y', 'width', 'height']);
    if (Object.values(rect).some(value => typeof value !== 'number' || !Number.isFinite(value)) || Number(rect.width) <= 0 || Number(rect.height) <= 0) throw new WorkbenchError('invalid_request');
  } else throw new WorkbenchError('invalid_request');
}
function example(value: unknown): void {
  const input = record(value); exactKeys(input, ['id', 'checkpointId', 'target', 'bindingStatus']);
  identifier(input.id); identifier(input.checkpointId); target(input.target); oneOf(input.bindingStatus, ['bound', 'needs-rebind', 'unavailable']);
}
const itemKeys: Record<string, [string[], string[]]> = {
  requirements: [['id', 'description', 'rules', 'fieldIds'], ['dataset']],
  fields: [['id', 'dataset', 'name', 'description', 'sourcePolicy'], ['outputPath', 'sourceProof', 'valueType', 'target', 'checkpointId', 'bindingStatus', 'annotationId', 'examples']],
  checkpoints: [['id', 'kind', 'anchor', 'capturedAt', 'createdAt', 'title', 'notes', 'requirementIds', 'annotationIds'], ['derivedFrom', 'sourceReceiptRef', 'operationId']],
  annotations: [['id', 'checkpointId', 'text', 'author', 'interpretation', 'bindingStatus'], ['target']],
};
function edits(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new WorkbenchError('invalid_request');
  for (const entry of value) {
    const edit = record(entry);
    switch (edit.operation) {
      case 'upsert': {
        exactKeys(edit, ['operation', 'collection', 'item']); oneOf(edit.collection, collections.slice(0, 4));
        const item = record(edit.item), shape = itemKeys[String(edit.collection)]; exactKeys(item, ...shape); identifier(item.id);
        if (edit.collection === 'fields') {
          oneOf(item.sourcePolicy, ['any-evidenced', 'page-displayed']);
          if (item.valueType !== undefined) oneOf(item.valueType, ['string', 'number', 'boolean', 'object', 'array', 'null']);
          if (item.bindingStatus !== undefined) oneOf(item.bindingStatus, ['bound', 'needs-rebind', 'unavailable']);
        }
        if (edit.collection === 'checkpoints') oneOf(item.kind, ['observation', 'requirement']);
        if (edit.collection === 'annotations') {
          oneOf(item.author, ['human', 'agent']);
          oneOf(item.interpretation, ['observed', 'inferred', 'unverified']);
          oneOf(item.bindingStatus, ['bound', 'needs-rebind', 'unavailable', 'none']);
        }
        if (edit.collection === 'requirements') {
          if (!Array.isArray(item.rules) || item.rules.length > 100) throw new WorkbenchError('invalid_request');
          for (const entry of item.rules) {
            const rule = record(entry); oneOf(rule.type, ['required', 'field-type', 'unique', 'min-rows', 'row-count', 'pagination-complete', 'same-entity', 'reference']);
            if (rule.type === 'field-type') oneOf(rule.valueType, ['string', 'number', 'boolean', 'object', 'array', 'null']);
          }
        }
        if (item.anchor !== undefined) position(item.anchor);
        if (item.target !== undefined) target(item.target);
        if (item.examples !== undefined) { if (!Array.isArray(item.examples) || item.examples.length > 100) throw new WorkbenchError('invalid_request'); item.examples.forEach(example); }
        // Remaining item fields and cross-item references use the existing
        // validateContent parser before any domain write, not a second schema.
        break;
      }
      case 'remove': exactKeys(edit, ['operation', 'collection', 'id']); oneOf(edit.collection, collections.slice(0, 4)); identifier(edit.id); break;
      case 'task-brief': { exactKeys(edit, ['operation', 'taskBrief']); const brief = record(edit.taskBrief); exactKeys(brief, ['objective', 'scope']); textField(brief.objective, 8000); textField(brief.scope, 8000); break; }
      case 'recordings': exactKeys(edit, ['operation', 'recordingRefs']); if (!Array.isArray(edit.recordingRefs) || edit.recordingRefs.length > 100) throw new WorkbenchError('invalid_request'); edit.recordingRefs.forEach(identifier); break;
      case 'copy-checkpoint': case 'remove-checkpoint': exactKeys(edit, ['operation', 'checkpointId']); identifier(edit.checkpointId); break;
      case 'move-checkpoint': exactKeys(edit, ['operation', 'checkpointId', 'position']); identifier(edit.checkpointId); position(edit.position); break;
      case 'field-binding': {
        exactKeys(edit, ['operation', 'fieldId', 'binding']); identifier(edit.fieldId); const binding = record(edit.binding);
        if (binding.kind === 'set') { exactKeys(binding, ['kind', 'target', 'checkpointId'], ['annotationId']); target(binding.target); identifier(binding.checkpointId); if (binding.annotationId !== undefined) identifier(binding.annotationId); }
        else { exactKeys(binding, ['kind']); oneOf(binding.kind, ['keep', 'clear']); } break;
      }
      case 'add-field-example': exactKeys(edit, ['operation', 'fieldId', 'example']); identifier(edit.fieldId); example(edit.example); break;
      case 'remove-field-example': exactKeys(edit, ['operation', 'fieldId', 'exampleId']); identifier(edit.fieldId); identifier(edit.exampleId); break;
      default: throw new WorkbenchError('invalid_request');
    }
  }
}
export function parseMaterialRequest(value: unknown): BrowserMaterialRequest {
  checkJsonBudget(value, BROWSER_MATERIAL_BUDGET.depth, BROWSER_MATERIAL_BUDGET.nodes);
  // Direct callers have the same JSON/prototype/byte boundary as HTTP callers.
  const pending = [value];
  while (pending.length) { const item = pending.pop(); if (item && typeof item === 'object') { if (!Array.isArray(item)) record(item); pending.push(...Object.values(item)); } }
  if (Buffer.byteLength(JSON.stringify(value)) > BROWSER_MATERIAL_BUDGET.requestBytes) throw new WorkbenchError('invalid_request');
  const envelope = record(value); exactKeys(envelope, ['instanceId', 'method', 'body']); identifier(envelope.instanceId);
  if (!isMaterialMethod(envelope.method)) throw new WorkbenchError('invalid_request');
  const body = record(envelope.body), method = String(envelope.method);
  const required = ['projectId'], optional: string[] = [];
  if (['materialDraft', 'setWorkingMaterialDraft', 'prepareMaterialArchive', 'materialDraftDiff'].includes(method)) required.push('draftId');
  if (['materialDrafts', 'materialRevisions', 'materialDiff', 'materialDraftDiff', 'recordingStreams', 'recordingPositions', 'materialRecordings'].includes(method)) optional.push('limit', 'maxBytes', 'cursor');
  if (method === 'materialRevision') required.push('revisionId', 'contentHash');
  if (['materialCollection', 'materialEntity'].includes(method)) {
    required.push('kind', 'collection'); oneOf(body.kind, ['draft', 'revision']);
    if (body.kind === 'draft') required.push('draftId'); else required.push('revisionId', 'contentHash');
    if (method === 'materialEntity') required.push('entityId'); else optional.push('limit', 'maxBytes', 'cursor');
    oneOf(body.collection, method === 'materialEntity' ? collections.slice(0, 4) : collections);
  }
  if (method === 'createMaterialDraft') { required.push('operationId'); optional.push('baseRevisionId'); }
  if (method === 'copyMaterialDraft' || method === 'publishMaterialDraft') required.push('draftId', 'expectedDraftRevision', 'operationId');
  if (method === 'editMaterialDraft') required.push('draftId', 'expectedDraftRevision', 'edits');
  if (method === 'materialPublicationStatus') required.push('operationId');
  if (method === 'manageMaterialCatalog') {
    required.push('kind', 'id', 'expectedCatalogRevision'); optional.push('name', 'note', 'hidden');
    oneOf(body.kind, ['drafts', 'revisions', 'recordings']);
    if (!optional.some(key => Object.hasOwn(body, key))) throw new WorkbenchError('invalid_request');
    if (body.name !== undefined) textField(body.name, 200);
    if (body.note !== undefined) textField(body.note, 4000);
    if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw new WorkbenchError('invalid_request');
  }
  if (method === 'materialDiff') required.push('fromRevisionId', 'toRevisionId');
  if (method === 'recordingStreams') required.push('recordingId');
  if (method === 'recordingPositions') { required.push('position'); optional.push('ordinal'); position(body.position); if (body.ordinal !== undefined) revision(body.ordinal); }
  exactKeys(body, required, optional);
  for (const key of ['projectId', 'draftId', 'revisionId', 'baseRevisionId', 'operationId', 'id', 'entityId', 'fromRevisionId', 'toRevisionId', 'recordingId']) if (body[key] !== undefined) identifier(body[key]);
  for (const key of ['expectedDraftRevision', 'expectedCatalogRevision']) if (body[key] !== undefined) revision(body[key]);
  if (body.contentHash !== undefined && (typeof body.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentHash))) throw new WorkbenchError('invalid_request');
  if (body.limit !== undefined) integer(body.limit, 1, 100);
  if (body.maxBytes !== undefined) integer(body.maxBytes, 1024, 28672);
  if (body.cursor !== undefined) textField(body.cursor, 4096, true);
  if (method === 'editMaterialDraft') edits(body.edits);
  // Detach the caller's object after validation so an awaited authorization
  // cannot turn a previously valid request into another operation.
  return structuredClone(value) as BrowserMaterialRequest;
}
