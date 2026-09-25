import type { DataRule, JsonValue, Verdict } from '@/contracts/workflow';
import type { Check } from './types';
import { canonicalJson } from '@/runner/datasets';

export function combine(values: Verdict[]): Verdict {
  if (values.includes('fail')) return 'fail';
  if (values.includes('inconclusive')) return 'inconclusive';
  if (!values.length || values.includes('not-run')) return 'not-run';
  return 'pass';
}
export function field(record: JsonValue, name: string): { exists: boolean; value?: JsonValue } {
  if (record !== null && typeof record === 'object' && Object.hasOwn(record, name)) return { exists: true, value: (record as Record<string, JsonValue>)[name] };
  let value = record;
  for (const part of name.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { exists: false };
    value = (value as Record<string, JsonValue>)[part];
  }
  return { exists: true, value };
}
export function pointer(record: JsonValue, path: string): { exists: boolean; value?: JsonValue } {
  if (path === '') return { exists: true, value: record };
  if (!path.startsWith('/') || /~(?:[^01]|$)/.test(path)) return { exists: false };
  let value = record;
  for (const part of path.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { exists: false };
    value = (value as Record<string, JsonValue>)[part];
  }
  return { exists: true, value };
}
export function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as Record<string, JsonValue>)[key], (b as Record<string, JsonValue>)[key]));
}
export function ruleCheck(rule: Exclude<DataRule, { type: 'pagination-complete' }>, rows: JsonValue[], complete: boolean,
  datasets: Map<string, { rows: JsonValue[]; complete: boolean }>): Check {
  const name = rule.type + ('field' in rule ? `:${rule.field}` : '');
  const answer = (ok: boolean, reason: string): Check => ({ name, verdict: ok ? complete ? 'pass' : 'inconclusive' : 'fail', reason });
  if (rule.type === 'min-rows') return { name, verdict: rows.length >= rule.count ? 'pass' : complete ? 'fail' : 'inconclusive', reason: `${rows.length} inspected rows; minimum ${rule.count}` };
  if (!rows.length) return { name, verdict: 'inconclusive', reason: 'No records on which to evaluate this rule' };
  const values = rows.map(row => field(row, rule.field));
  if (rule.type === 'required') return answer(values.every(x => x.exists && (rule.allowNull || x.value !== null)), 'Missing properties and explicit null are evaluated separately');
  if (rule.type === 'field-type') return answer(values.every(x => x.exists && (rule.valueType === 'null' ? x.value === null : rule.valueType === 'array' ? Array.isArray(x.value) : rule.valueType === 'object' ? x.value !== null && typeof x.value === 'object' && !Array.isArray(x.value) : typeof x.value === rule.valueType)), `Expected ${rule.valueType}`);
  if (rule.type === 'unique') {
    const seen = new Set<string>();
    return answer(values.every(x => { if (!x.exists || x.value === null || x.value === undefined) return false; const key = canonicalJson(x.value); if (seen.has(key)) return false; seen.add(key); return true; }), 'Keys must be present, non-null and unique across all inspected batches');
  }
  if (rule.type === 'same-entity') return answer(rows.every(row => { const a = field(row, rule.field), b = field(row, rule.equalsField); return a.exists && b.exists && a.value !== null && equal(a.value, b.value); }), `Compared ${rule.field} and ${rule.equalsField}`);
  const target = datasets.get(rule.dataset);
  if (!target) return { name, verdict: 'inconclusive', reason: `Reference dataset ${rule.dataset} is unavailable` };
  const targetKeys = new Set(target.rows.flatMap(row => { const y = field(row, rule.targetField); return y.exists && y.value !== undefined && y.value !== null ? [canonicalJson(y.value)] : []; }));
  const matches = values.every(x => x.exists && x.value !== null && x.value !== undefined && targetKeys.has(canonicalJson(x.value)));
  return { name, verdict: !matches ? target.complete ? 'fail' : 'inconclusive' : complete ? 'pass' : 'inconclusive', reason: `Reference target ${rule.dataset}.${rule.targetField}; target coverage ${target.complete ? 'complete' : 'partial'}` };
}
