import type { DataRule, Dataset, JsonValue, ReportedAssertion, Verdict, WorkflowManifest } from '../contracts/workflow';
import type { WorkflowFingerprint } from './fingerprint';

export interface RuleResult { name: string; verdict: Verdict; message: string }
export interface ValidationResult {
  overall: Verdict;
  coverageVerdict: Verdict;
  assertionVerdict: Verdict;
  versionVerdict: Verdict;
  executionVerdict: Verdict;
  requirements: { id: string; checkpointKey: string; coverageVerdict: Verdict; assertionVerdict: Verdict; checks: RuleResult[] }[];
  warnings: string[];
}

export interface ValidationInput {
  manifest: WorkflowManifest;
  execution: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  checkpoints: { id: string; key: string }[];
  datasets: Dataset[];
  assertions: ReportedAssertion[];
  fingerprintBefore: WorkflowFingerprint;
  fingerprintAfter: WorkflowFingerprint;
  /** Actual persisted artifacts/checkpoints/events available in THIS execution. */
  knownSourceRefs: string[];
}

function combine(values: Verdict[]): Verdict {
  if (values.includes('fail')) return 'fail';
  if (values.includes('inconclusive')) return 'inconclusive';
  if (values.length === 0 || values.includes('not-run')) return 'not-run';
  return 'pass';
}

function field(record: JsonValue, name: string): { exists: boolean; value?: JsonValue } {
  let value: JsonValue = record;
  for (const part of name.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { exists: false };
    value = (value as Record<string, JsonValue>)[part];
  }
  return { exists: true, value };
}

function applyRule(rule: DataRule, dataset: Dataset, datasets: Dataset[]): RuleResult {
  const name = rule.type + ('field' in rule ? `:${rule.field}` : '');
  const result = (passes: boolean, message: string): RuleResult => ({ name, verdict: passes ? 'pass' : 'fail', message });
  if (rule.type === 'min-rows') return result(dataset.records.length >= rule.count, `${dataset.records.length} rows; require at least ${rule.count}`);
  if (rule.type === 'pagination-complete') {
    const pagination = dataset.pagination;
    if (!pagination) return { name, verdict: 'inconclusive', message: 'No pagination termination evidence reported' };
    return result(pagination.complete === true && pagination.pages >= (rule.minPages ?? 1) && pagination.terminalReason.trim().length > 0, `pages=${pagination.pages}; complete=${pagination.complete}; terminal=${pagination.terminalReason}`);
  }
  const values = dataset.records.map(record => field(record, rule.field));
  if (dataset.records.length === 0) return { name, verdict: 'inconclusive', message: 'No records to check; declare min-rows when empty results are invalid' };
  if (rule.type === 'required') return result(values.every(value => value.exists && (rule.allowNull || value.value !== null)), `Missing: ${values.filter(value => !value.exists).length}; null: ${values.filter(value => value.exists && value.value === null).length}`);
  if (rule.type === 'field-type') return result(values.every(({ exists, value }) => exists && (rule.valueType === 'null' ? value === null : rule.valueType === 'array' ? Array.isArray(value) : rule.valueType === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === rule.valueType)), `Expected ${rule.valueType} for ${values.length} records`);
  if (rule.type === 'unique') return result(values.every(value => value.exists && value.value !== null) && new Set(values.map(value => JSON.stringify(value.value))).size === values.length, `${values.length} keys; ${new Set(values.map(value => JSON.stringify(value.value))).size} distinct`);
  if (rule.type === 'same-entity') return result(dataset.records.every(record => {
    const a = field(record, rule.field), b = field(record, rule.equalsField);
    return a.exists && b.exists && a.value !== null && JSON.stringify(a.value) === JSON.stringify(b.value);
  }), `Compared ${rule.field} with ${rule.equalsField} per record`);
  const reference = datasets.find(item => item.name === rule.dataset);
  if (!reference) return { name, verdict: 'inconclusive', message: `Missing reference dataset ${rule.dataset}` };
  const targets = new Set(reference.records.map(record => field(record, rule.targetField)).filter(value => value.exists && value.value !== null).map(value => JSON.stringify(value.value)));
  return result(values.every(value => value.exists && value.value !== null && targets.has(JSON.stringify(value.value))), `Checked ${values.length} links against ${rule.dataset}.${rule.targetField}`);
}

export function validateExecution(input: ValidationInput): ValidationResult {
  const sources = new Set([...input.knownSourceRefs, ...input.checkpoints.map(checkpoint => checkpoint.id)]);
  const evidenceAvailable = (refs: string[]) => refs.length > 0 && refs.every(ref => sources.has(ref));
  const requirements = input.manifest.requirements.map(requirement => {
    const checkpoint = input.checkpoints.find(item => item.key === requirement.checkpointKey);
    const dataset = input.datasets.find(item => item.name === requirement.dataset);
    const assertions = input.assertions.filter(item => item.requirementId === requirement.id);
    const checks: RuleResult[] = [];
    if (requirement.dataset) {
      if (!dataset) checks.push({ name: 'dataset', verdict: 'not-run', message: `Dataset ${requirement.dataset} was not emitted` });
      else {
        if (!evidenceAvailable(dataset.sourceRefs)) checks.push({ name: 'provenance', verdict: 'inconclusive', message: `${dataset.origin} dataset lacks available source evidence` });
        for (const rule of requirement.rules ?? []) checks.push(applyRule(rule, dataset, input.datasets));
      }
    }
    for (const assertion of assertions) checks.push({ name: assertion.name, verdict: evidenceAvailable(assertion.sourceRefs) ? assertion.verdict : 'inconclusive', message: assertion.message ?? (evidenceAvailable(assertion.sourceRefs) ? 'Reported by executed workflow' : 'Assertion source evidence is unavailable') });
    return {
      id: requirement.id, checkpointKey: requirement.checkpointKey,
      coverageVerdict: (checkpoint ? 'pass' : 'not-run') as Verdict,
      assertionVerdict: combine(checks.map(check => check.verdict)), checks,
    };
  });
  const coverageVerdict = combine(requirements.map(requirement => requirement.coverageVerdict));
  const assertionVerdict = combine(requirements.map(requirement => requirement.assertionVerdict));
  const versionVerdict: Verdict = input.fingerprintBefore.sha256 !== input.fingerprintAfter.sha256 ? 'fail' : !input.fingerprintBefore.dependencyLockSha256 ? 'inconclusive' : 'pass';
  const executionVerdict: Verdict = input.execution === 'completed' ? 'pass' : 'fail';
  const warnings: string[] = [];
  if (versionVerdict === 'fail') warnings.push('Source, build, configuration or dependency files changed during execution; re-run the changed version');
  if (versionVerdict === 'inconclusive') warnings.push('Dependency lockfile fingerprint is unavailable');
  if (coverageVerdict !== 'pass') warnings.push('Uncovered requirements prevent acceptance');
  return { overall: combine([coverageVerdict, assertionVerdict, versionVerdict, executionVerdict]), coverageVerdict, assertionVerdict, versionVerdict, executionVerdict, requirements, warnings };
}
