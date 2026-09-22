export type Verdict = 'pass' | 'fail' | 'inconclusive' | 'not-run';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Data checks only; navigation, branches and loops belong in ordinary JS. */
export type DataRule =
  | { type: 'required'; field: string; allowNull?: boolean }
  | { type: 'field-type'; field: string; valueType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' }
  | { type: 'unique'; field: string }
  | { type: 'min-rows'; count: number }
  | { type: 'pagination-complete'; minPages?: number }
  | { type: 'same-entity'; field: string; equalsField: string }
  | { type: 'reference'; field: string; dataset: string; targetField: string };

export interface WorkflowRequirement {
  id: string;
  checkpointKey: string;
  description: string;
  dataset?: string;
  rules?: DataRule[];
  referenceEvidence?: string[];
}

export interface WorkflowManifest {
  schemaVersion: 1;
  workflowId: string;
  entry: string;
  exportName: string;
  driver: 'puppeteer';
  inputSchema?: string;
  outputSchema?: string;
  requirements: WorkflowRequirement[];
  humanPoints?: { id: string; description: string }[];
}

export interface DataProvenance {
  sourceRefs: string[];
  origin: 'browser' | 'node' | 'derived';
  pagination?: { complete: boolean; pages: number; terminalReason: string };
}

export interface Dataset extends DataProvenance {
  name: string;
  records: JsonValue[];
}

export interface ReportedAssertion {
  requirementId: string;
  name: string;
  verdict: Exclude<Verdict, 'not-run'>;
  sourceRefs: string[];
  message?: string;
}

export interface HumanRequest {
  id: string;
  instructions: string;
  timeoutMs: number;
  completionCheck: { selector: string; text?: string };
}

export interface CheckpointDetails {
  title?: string;
  description?: string;
  requirementIds?: string[];
}

export interface WorkflowReporter {
  checkpoint(key: string, details?: CheckpointDetails): Promise<{ id: string }>;
  emitData(name: string, records: JsonValue[], provenance: DataProvenance): Promise<void>;
  attachArtifact(name: string, content: string | Uint8Array, mediaType: string): Promise<{ id: string }>;
  assertion(assertion: ReportedAssertion): Promise<void>;
  requestHuman(request: HumanRequest): Promise<void>;
  progress(message: string): Promise<void>;
  readonly signal: AbortSignal;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identifier = (value: unknown): value is string => nonempty(value) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);

export function parseWorkflowManifest(value: unknown): WorkflowManifest {
  if (!object(value) || value.schemaVersion !== 1 || value.driver !== 'puppeteer' ||
      !identifier(value.workflowId) || !nonempty(value.entry) || !identifier(value.exportName) ||
      !Array.isArray(value.requirements) || value.requirements.length === 0) {
    throw new Error('Invalid workflow: require schemaVersion=1, puppeteer driver, identity, entry, exportName and requirements');
  }
  const ids = new Set<string>();
  for (const requirement of value.requirements) {
    if (!object(requirement) || !identifier(requirement.id) || !identifier(requirement.checkpointKey) || !nonempty(requirement.description)) {
      throw new Error('Each requirement needs id, checkpointKey and description');
    }
    if (ids.has(requirement.id)) throw new Error(`Duplicate requirement ${requirement.id}`);
    ids.add(requirement.id);
    if (requirement.dataset !== undefined && !identifier(requirement.dataset)) throw new Error('Invalid dataset name');
    if (requirement.referenceEvidence !== undefined && (!Array.isArray(requirement.referenceEvidence) || !requirement.referenceEvidence.every(nonempty))) throw new Error('Invalid referenceEvidence');
    if (requirement.rules !== undefined) {
      if (!Array.isArray(requirement.rules) || !requirement.dataset) throw new Error('Data rules require a named dataset');
      for (const rule of requirement.rules) validateDataRule(rule);
    }
  }
  for (const field of ['inputSchema', 'outputSchema'] as const) {
    if (value[field] !== undefined && !nonempty(value[field])) throw new Error(`Invalid ${field}`);
  }
  if (value.humanPoints !== undefined) {
    if (!Array.isArray(value.humanPoints)) throw new Error('humanPoints must be an array');
    const humanIds = new Set<string>();
    for (const point of value.humanPoints) {
      if (!object(point) || !identifier(point.id) || !nonempty(point.description) || humanIds.has(point.id)) throw new Error('Invalid or duplicate human point');
      humanIds.add(point.id);
    }
  }
  return value as unknown as WorkflowManifest;
}

function validateDataRule(value: unknown): void {
  if (!object(value)) throw new Error('Invalid data rule');
  switch (value.type) {
    case 'min-rows':
      if (!Number.isSafeInteger(value.count) || (value.count as number) < 0) throw new Error('Invalid min-rows count');
      return;
    case 'pagination-complete':
      if (value.minPages !== undefined && (!Number.isSafeInteger(value.minPages) || (value.minPages as number) < 1)) throw new Error('Invalid minPages');
      return;
    case 'required':
      if (value.allowNull !== undefined && typeof value.allowNull !== 'boolean') throw new Error('Invalid allowNull');
      break;
    case 'field-type':
      if (!['string', 'number', 'boolean', 'object', 'array', 'null'].includes(String(value.valueType))) throw new Error('Invalid valueType');
      break;
    case 'unique': break;
    case 'same-entity':
      if (!nonempty(value.equalsField)) throw new Error('Missing equalsField');
      break;
    case 'reference':
      if (!identifier(value.dataset) || !nonempty(value.targetField)) throw new Error('Invalid reference rule');
      break;
    default: throw new Error(`Unknown data rule ${String(value.type)}`);
  }
  if (!nonempty(value.field)) throw new Error('Data rule field is required');
}
