import type { MaterialField } from '@/contracts/materials';
import type { DataRule, JsonValue } from '@/contracts/workflow';
import { canonicalJson } from '@/runner/datasets';
import { equal, pointer } from './rules';
import type { Check, SourceDocument } from './types';

/** Strip only the frozen page parameter. Filters, variants, origin and remaining query stay significant. */
export function matchesUrl(actual: string | undefined, expected: string, pageParameter?: string): boolean {
  try {
    if (!actual) return false;
    const a = new URL(actual), b = new URL(expected);
    if (a.hash || b.hash || a.username || a.password || b.username || b.password) return false;
    if (pageParameter) { a.searchParams.delete(pageParameter); b.searchParams.delete(pageParameter); }
    return a.href === b.href;
  } catch { return false; }
}

export type SourceEntityIndex = Map<SourceDocument, Map<string, Map<string, JsonValue[]>>>;
export function fieldProof(f: MaterialField, row: JsonValue, docs: SourceDocument[], index: SourceEntityIndex = new Map()): Check {
  const name = `source:${f.id}`;
  if (f.outputPath === undefined) return { name, verdict: 'inconclusive', reason: 'Field has no frozen outputPath; its display name is not an output mapping' };
  const proof = f.sourceProof;
  if (!proof) return { name, verdict: 'inconclusive', reason: 'Field has no frozen content proof; a source ID or script-selected pointer alone cannot prove its meaning' };
  if (f.sourcePolicy === 'page-displayed') return { name, verdict: 'inconclusive', reason: 'A JSON response cannot independently prove displayed text or a displayed mask' };
  const output = pointer(row, f.outputPath), entity = pointer(row, proof.outputEntityPath);
  if (!output.exists || !entity.exists || entity.value === null) return { name, verdict: 'fail', reason: 'Output field or entity key is absent/null at the frozen output path' };
  let matched = false, conflicting = false;
  for (const doc of docs) {
    if (doc.representation !== 'network-json' || doc.content.status !== 'present' || !matchesUrl(doc.requestUrl, proof.sourceUrl, proof.pageParameter)) continue;
    const paths = canonicalJson([proof.rowsPointer, proof.entityPointer]);
    let byPaths = index.get(doc);
    if (!byPaths) { byPaths = new Map(); index.set(doc, byPaths); }
    let entities = byPaths.get(paths);
    if (!entities) {
      entities = new Map(); byPaths.set(paths, entities);
      const records = pointer(doc.content.value, proof.rowsPointer);
      if (records.exists && Array.isArray(records.value)) for (const record of records.value) {
        const key = pointer(record, proof.entityPointer);
        if (!key.exists || key.value === undefined || key.value === null) continue;
        const serialized = canonicalJson(key.value);
        const list = entities.get(serialized) ?? []; list.push(record); entities.set(serialized, list);
      }
    }
    for (const record of entities.get(canonicalJson(entity.value)) ?? []) {
      const sourceValue = pointer(record, proof.valuePointer);
      if (sourceValue.exists && equal(sourceValue.value, output.value)) matched = true;
      else conflicting = true;
    }
  }
  return { name, verdict: conflicting ? 'fail' : matched ? 'pass' : 'inconclusive', reason: conflicting ? 'Captured entity has a different field value under the frozen source constraint' : matched ? 'Captured request URL, entity and field value satisfy the frozen source constraint' : 'No captured source matches the frozen URL, row/entity path and field value' };
}

export function paginationProof(rule: Extract<DataRule, { type: 'pagination-complete' }>, rows: JsonValue[], docs: SourceDocument[]): Check {
  const result = (verdict: Check['verdict'], reason: string): Check => ({ name: 'pagination-complete', verdict, reason });
  const proof = rule.proof;
  if (!proof) return result('inconclusive', 'No frozen pagination proof; script complete/pages/terminalReason do not independently prove the last page');
  const pages = new Map<number, { rows: JsonValue[]; total: number; hasNext?: boolean; body: JsonValue }>();
  for (const doc of docs) {
    if (doc.representation !== 'network-json' || doc.content.status !== 'present' || !matchesUrl(doc.requestUrl, proof.sourceUrl, proof.pageParameter)) continue;
    const body = doc.content.value, page = pointer(body, proof.pagePointer), records = pointer(body, proof.rowsPointer);
    if (!page.exists || typeof page.value !== 'number' || !Number.isSafeInteger(page.value) || page.value < 1 || !records.exists || !Array.isArray(records.value)) return result('inconclusive', 'A captured page lacks the frozen page number or row array');
    const url = new URL(doc.requestUrl!);
    const numbers = url.searchParams.getAll(proof.pageParameter);
    if (numbers.length !== 1 || !/^[1-9]\d*$/.test(numbers[0]) || Number(numbers[0]) !== page.value) return result('fail', 'Captured request page parameter differs from the response page number');
    const total = pointer(body, proof.termination.kind === 'total-pages' ? proof.termination.pointer : proof.termination.totalRecordsPointer);
    if (!total.exists || typeof total.value !== 'number' || !Number.isSafeInteger(total.value) || total.value < (proof.termination.kind === 'total-pages' ? 1 : 0)) return result('inconclusive', 'Captured page has no valid frozen total count');
    const next = proof.termination.kind === 'has-next-and-total' ? pointer(body, proof.termination.hasNextPointer) : undefined;
    if (next && (!next.exists || typeof next.value !== 'boolean')) return result('inconclusive', 'Captured has-next state is missing or not boolean');
    const previous = pages.get(page.value);
    if (previous && !equal(previous.body, body)) return result('fail', 'Conflicting originals describe the same page number');
    pages.set(page.value, { rows: records.value, total: total.value, ...(next ? { hasNext: next.value as boolean } : {}), body });
  }
  if (!pages.size) return result('inconclusive', 'No captured pages match the frozen source URL and query');
  const sorted = [...pages].sort((a, b) => a[0] - b[0]), total = sorted[0][1].total;
  if (sorted.some(([, p]) => p.total !== total)) return result('inconclusive', 'Captured total changed during pagination; consistency is not established');
  if (sorted.some(([n], i) => n !== i + 1)) return result('inconclusive', 'The first page or an intermediate page is missing');
  if (sorted.length < (rule.minPages ?? 1)) return result('fail', 'Observed page count is below the frozen minimum');
  if (proof.termination.kind === 'total-pages' && sorted.length !== total) return result('inconclusive', 'The captured page sequence does not reach the reported final page');
  if (proof.termination.kind === 'has-next-and-total' && sorted.some(([, p], i) => p.hasNext !== (i < sorted.length - 1))) return result('inconclusive', 'No consistent captured terminal page; has-next is still true or an earlier page claims termination');
  const sourceKeys = new Set<string>();
  for (const [, page] of sorted) for (const row of page.rows) {
    const key = pointer(row, proof.entityPointer);
    if (!key.exists || key.value === null || key.value === undefined) return result('inconclusive', 'A captured row has no entity key');
    const serialized = canonicalJson(key.value);
    if (sourceKeys.has(serialized)) return result('inconclusive', 'Repeated entity across captured pages prevents independent completeness proof');
    sourceKeys.add(serialized);
  }
  if (proof.termination.kind === 'has-next-and-total' && sourceKeys.size !== total) return result('inconclusive', 'Captured unique entity count differs from the reported total');
  const outputKeys = new Set<string>();
  for (const row of rows) {
    const key = pointer(row, proof.outputEntityPath);
    if (!key.exists || key.value === null || key.value === undefined) return result('fail', 'An output row has no entity key');
    const serialized = canonicalJson(key.value);
    if (outputKeys.has(serialized)) return result('fail', 'Duplicate output entities prevent exact coverage');
    outputKeys.add(serialized);
  }
  if (outputKeys.size !== sourceKeys.size || [...sourceKeys].some(k => !outputKeys.has(k))) return result('fail', 'Output entity set omits captured rows or includes entities outside the complete source sequence');
  return result('pass', 'Captured request/response page sequence reaches the frozen terminal condition and exactly matches output entities');
}
