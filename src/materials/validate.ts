import type { MaterialContent, MaterialField, MaterialRequirement, CheckpointCard, MaterialAnnotation } from '@/contracts/materials';
import type { DataRule } from '@/contracts/workflow';
import { parseJsonPointer, parseFieldSourceProof, parsePaginationProof } from '@/contracts/workflow';
import { parseReplayPosition, sameReplayPosition, type HistoricalTarget, type ReplayPosition } from '@/contracts/recording';
import { MaterialError } from './errors';

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 2000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string): never => { throw new MaterialError('INVALID_MATERIAL', message); };
const keys = (v: Record<string, unknown>, allowed: string[], label: string): void => {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`${label} has unknown property ${key}`);
};
export function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value) || value.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail(`${label} must be a single safe path segment`);
  return value as string;
}
function sourceIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is not a valid source identity`);
  return value as string;
}
function string(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label} must be text of at most ${max} characters`);
  return value as string;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(`${label} must be an array of at most ${MAX_ITEMS} items`);
  return value as unknown[];
}
function ids(value: unknown, label: string): string[] {
  const result = list(value, label).map((item, n) => id(item, `${label}[${n}]`));
  if (new Set(result).size !== result.length) fail(`${label} has duplicate IDs`);
  return result;
}
function position(value: unknown, label: string): ReplayPosition {
  if (!record(value)) fail(`${label} must be a replay position`);
  keys(value as Record<string, unknown>, ['recordingId', 'pageId', 'documentId', 'streamEpoch', 'sourceTimeMs', 'eventSeq'], label);
  let parsed: ReplayPosition;
  try { parsed = parseReplayPosition(value); } catch { return fail(`${label} is invalid`); }
  id(parsed.recordingId, `${label}.recordingId`);
  for (const property of ['pageId', 'documentId', 'streamEpoch'] as const) sourceIdentity(parsed[property], `${label}.${property}`);
  return parsed;
}
function target(value: unknown, label: string): HistoricalTarget {
  if (!record(value)) fail(`${label} must be a historical target`);
  const item = value as Record<string, unknown>;
  const at = position(item.position, `${label}.position`);
  if (item.kind === 'dom-node') {
    keys(item, ['kind', 'position', 'frameId', 'mirrorScopeId', 'nodeId'], label);
    sourceIdentity(item.frameId, `${label}.frameId`); sourceIdentity(item.mirrorScopeId, `${label}.mirrorScopeId`);
    if (!Number.isSafeInteger(item.nodeId) || Number(item.nodeId) < 0) fail(`${label}.nodeId is invalid`);
    return { kind: 'dom-node', position: at, frameId: item.frameId as string, mirrorScopeId: item.mirrorScopeId as string, nodeId: item.nodeId as number };
  }
  if (item.kind === 'visual-region') {
    keys(item, ['kind', 'position', 'artifactId', 'rect'], label);
    id(item.artifactId, `${label}.artifactId`);
    if (!record(item.rect)) fail(`${label}.rect is invalid`);
    const rect = item.rect as Record<string, unknown>;
    keys(rect, ['x', 'y', 'width', 'height'], `${label}.rect`);
    if (!['x', 'y', 'width', 'height'].every(k => typeof rect[k] === 'number' && Number.isFinite(rect[k])) || Number(rect.width) <= 0 || Number(rect.height) <= 0) fail(`${label}.rect is invalid`);
    return { kind: 'visual-region', position: at, artifactId: item.artifactId as string, rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number } };
  }
  return fail(`${label}.kind is invalid`);
}
function rule(value: unknown): DataRule {
  if (!record(value)) fail('Requirement rule must be an object');
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case 'required':
      keys(item, ['type', 'field', 'allowNull'], 'required rule');
      string(item.field, 'rule.field', 256);
      if (item.allowNull !== undefined && typeof item.allowNull !== 'boolean') fail('allowNull must be boolean');
      break;
    case 'field-type':
      keys(item, ['type', 'field', 'valueType'], 'field-type rule');
      string(item.field, 'rule.field', 256);
      if (!['string', 'number', 'boolean', 'object', 'array', 'null'].includes(String(item.valueType))) fail('Invalid field valueType');
      break;
    case 'unique':
      keys(item, ['type', 'field'], 'unique rule'); string(item.field, 'rule.field', 256); break;
    case 'min-rows':
      keys(item, ['type', 'count'], 'min-rows rule');
      if (!Number.isSafeInteger(item.count) || Number(item.count) < 0) fail('Invalid min-rows count');
      break;
    case 'pagination-complete':
      keys(item, ['type', 'minPages', 'proof'], 'pagination rule');
      if (item.minPages !== undefined && (!Number.isSafeInteger(item.minPages) || Number(item.minPages) < 1)) fail('Invalid minPages');
      if (item.proof !== undefined) {
        try { return { type: 'pagination-complete', ...(item.minPages === undefined ? {} : { minPages: item.minPages as number }), proof: parsePaginationProof(item.proof) }; }
        catch (error) { return fail(String(error)); }
      }
      break;
    case 'same-entity':
      keys(item, ['type', 'field', 'equalsField'], 'same-entity rule');
      string(item.field, 'rule.field', 256); string(item.equalsField, 'rule.equalsField', 256); break;
    case 'reference':
      keys(item, ['type', 'field', 'dataset', 'targetField'], 'reference rule');
      string(item.field, 'rule.field', 256); id(item.dataset, 'rule.dataset'); string(item.targetField, 'rule.targetField', 256); break;
    default: return fail('Unknown requirement rule');
  }
  return { ...item } as DataRule;
}
function unique<T extends { id: string }>(items: T[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label} has duplicate IDs`);
}
export function validateContent(value: unknown): MaterialContent {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return fail('Material content is not JSON'); }
  if (bytes > MAX_CONTENT_BYTES) fail(`Material content exceeds ${MAX_CONTENT_BYTES} bytes`);
  if (!record(value)) fail('Material content must be an object');
  const content = value as Record<string, unknown>;
  keys(content, ['requirements', 'fields', 'checkpoints', 'annotations', 'recordingRefs'], 'content');
  const recordingRefs = ids(content.recordingRefs, 'recordingRefs');
  const requirements = list(content.requirements, 'requirements').map((raw): MaterialRequirement => {
    if (!record(raw)) fail('Requirement must be an object');
    const item = raw as Record<string, unknown>;
    keys(item, ['id', 'description', 'dataset', 'rules', 'fieldIds'], 'requirement');
    return { id: id(item.id, 'requirement.id'), description: string(item.description, 'requirement.description', 8000),
      ...(item.dataset === undefined ? {} : { dataset: id(item.dataset, 'requirement.dataset') }),
      rules: list(item.rules, 'requirement.rules').map(rule), fieldIds: ids(item.fieldIds, 'requirement.fieldIds') };
  });
  const fields = list(content.fields, 'fields').map((raw): MaterialField => {
    if (!record(raw)) fail('Field must be an object');
    const item = raw as Record<string, unknown>;
    keys(item, ['id', 'dataset', 'name', 'description', 'outputPath', 'sourceProof', 'valueType', 'sourcePolicy', 'target', 'annotationId', 'checkpointId', 'bindingStatus'], 'field');
    if (!['any-evidenced', 'page-displayed'].includes(String(item.sourcePolicy))) fail('Invalid source policy');
    if (item.valueType !== undefined && !['string', 'number', 'boolean', 'object', 'array', 'null'].includes(String(item.valueType))) fail('Invalid field type');
    if ((item.checkpointId !== undefined || item.bindingStatus !== undefined) && item.target === undefined) fail('Field binding metadata requires a target');
    if (item.bindingStatus !== undefined && !['bound', 'needs-rebind', 'unavailable'].includes(String(item.bindingStatus))) fail('Invalid field binding status');
    let proofFields: Pick<MaterialField, 'outputPath' | 'sourceProof'> = {};
    try {
      if (item.outputPath !== undefined) proofFields.outputPath = parseJsonPointer(item.outputPath);
      if (item.sourceProof !== undefined) {
        if (item.outputPath === undefined) fail('Source proof requires an explicit outputPath');
        proofFields.sourceProof = parseFieldSourceProof(item.sourceProof);
      }
    } catch (error) { fail(String(error)); }
    return { id: id(item.id, 'field.id'), dataset: id(item.dataset, 'field.dataset'), name: string(item.name, 'field.name', 256),
      description: string(item.description, 'field.description', 8000), sourcePolicy: item.sourcePolicy as MaterialField['sourcePolicy'], ...proofFields,
      ...(item.valueType === undefined ? {} : { valueType: item.valueType as MaterialField['valueType'] }),
      ...(item.target === undefined ? {} : { target: target(item.target, 'field.target') }),
      ...(item.annotationId === undefined ? {} : { annotationId: id(item.annotationId, 'field.annotationId') }),
      ...(item.checkpointId === undefined ? {} : { checkpointId: id(item.checkpointId, 'field.checkpointId') }),
      ...(item.bindingStatus === undefined ? {} : { bindingStatus: item.bindingStatus as MaterialField['bindingStatus'] }) };
  });
  const checkpoints = list(content.checkpoints, 'checkpoints').map((raw): CheckpointCard => {
    if (!record(raw)) fail('Checkpoint must be an object');
    const item = raw as Record<string, unknown>;
    keys(item, ['id', 'kind', 'anchor', 'capturedAt', 'createdAt', 'derivedFrom', 'title', 'notes', 'requirementIds', 'annotationIds'], 'checkpoint');
    if (item.kind !== 'observation' && item.kind !== 'requirement') fail('Invalid checkpoint kind');
    const capturedAt = string(item.capturedAt, 'checkpoint.capturedAt', 64);
    const createdAt = string(item.createdAt, 'checkpoint.createdAt', 64);
    if (!Number.isFinite(Date.parse(capturedAt)) || !Number.isFinite(Date.parse(createdAt))) fail('Invalid checkpoint timestamp');
    return { id: id(item.id, 'checkpoint.id'), kind: item.kind as CheckpointCard['kind'], anchor: position(item.anchor, 'checkpoint.anchor'), capturedAt, createdAt,
      ...(item.derivedFrom === undefined ? {} : { derivedFrom: id(item.derivedFrom, 'checkpoint.derivedFrom') }),
      title: string(item.title, 'checkpoint.title', 500, false), notes: string(item.notes, 'checkpoint.notes', 16000, false),
      requirementIds: ids(item.requirementIds, 'checkpoint.requirementIds'), annotationIds: ids(item.annotationIds, 'checkpoint.annotationIds') };
  });
  const annotations = list(content.annotations, 'annotations').map((raw): MaterialAnnotation => {
    if (!record(raw)) fail('Annotation must be an object');
    const item = raw as Record<string, unknown>;
    keys(item, ['id', 'checkpointId', 'target', 'text', 'author', 'interpretation', 'bindingStatus'], 'annotation');
    if (item.author !== 'human' && item.author !== 'agent') fail('Invalid annotation author');
    if (!['observed', 'inferred', 'unverified'].includes(String(item.interpretation))) fail('Invalid interpretation');
    if (!['bound', 'needs-rebind', 'unavailable'].includes(String(item.bindingStatus))) fail('Invalid binding status');
    return { id: id(item.id, 'annotation.id'), checkpointId: id(item.checkpointId, 'annotation.checkpointId'), target: target(item.target, 'annotation.target'),
      text: string(item.text, 'annotation.text', 16000), author: item.author as MaterialAnnotation['author'], interpretation: item.interpretation as MaterialAnnotation['interpretation'],
      bindingStatus: item.bindingStatus as MaterialAnnotation['bindingStatus'] };
  });
  unique(requirements, 'requirements'); unique(fields, 'fields'); unique(checkpoints, 'checkpoints'); unique(annotations, 'annotations');
  const requirementById = new Map(requirements.map(item => [item.id, item]));
  const fieldById = new Map(fields.map(item => [item.id, item]));
  const checkpointById = new Map(checkpoints.map(item => [item.id, item]));
  const annotationById = new Map(annotations.map(item => [item.id, item]));
  const refs = new Set(recordingRefs);
  for (const requirement of requirements) {
    for (const fieldId of requirement.fieldIds) {
      const field = fieldById.get(fieldId);
      if (!field || (requirement.dataset !== undefined && field.dataset !== requirement.dataset)) fail(`Requirement ${requirement.id} has invalid field ${fieldId}`);
    }
  }
  for (const checkpoint of checkpoints) {
    if (!refs.has(checkpoint.anchor.recordingId)) fail(`Checkpoint ${checkpoint.id} has unlisted recording`);
    for (const requirementId of checkpoint.requirementIds) if (!requirementById.has(requirementId)) fail(`Checkpoint ${checkpoint.id} has unknown requirement ${requirementId}`);
    for (const annotationId of checkpoint.annotationIds) if (annotationById.get(annotationId)?.checkpointId !== checkpoint.id) fail(`Checkpoint ${checkpoint.id} has invalid annotation ${annotationId}`);
  }
  for (const annotation of annotations) {
    const checkpoint = checkpointById.get(annotation.checkpointId) ?? fail(`Annotation ${annotation.id} has no matching checkpoint membership`);
    if (!checkpoint.annotationIds.includes(annotation.id)) fail(`Annotation ${annotation.id} has no matching checkpoint membership`);
    if (!refs.has(annotation.target.position.recordingId)) fail(`Annotation ${annotation.id} has unlisted recording`);
    if (annotation.bindingStatus === 'bound' && !sameReplayPosition(annotation.target.position, checkpoint.anchor)) fail(`Annotation ${annotation.id} must be reviewed after anchor movement`);
  }
  for (const field of fields) {
    if (field.annotationId && !annotationById.has(field.annotationId)) fail(`Field ${field.id} has unknown annotation`);
    if (field.target && !refs.has(field.target.position.recordingId)) fail(`Field ${field.id} has unlisted recording`);
    if (field.checkpointId) {
      const checkpoint = checkpointById.get(field.checkpointId) ?? fail(`Field ${field.id} has unknown checkpoint`);
      if (field.bindingStatus === 'bound' && field.target && !sameReplayPosition(field.target.position, checkpoint.anchor)) fail(`Field ${field.id} must be reviewed after anchor movement`);
    }
    if (field.target && field.annotationId) {
      const annotation = annotationById.get(field.annotationId)!;
      if (stableTarget(field.target) !== stableTarget(annotation.target)) fail(`Field ${field.id} target and annotation disagree`);
      if (field.checkpointId && field.checkpointId !== annotation.checkpointId) fail(`Field ${field.id} checkpoint and annotation disagree`);
    }
  }
  return { requirements, fields, checkpoints, annotations, recordingRefs };
}

function stableTarget(value: HistoricalTarget): string {
  return value.kind === 'dom-node'
    ? JSON.stringify([value.kind, value.position, value.frameId, value.mirrorScopeId, value.nodeId])
    : JSON.stringify([value.kind, value.position, value.artifactId, value.rect]);
}
