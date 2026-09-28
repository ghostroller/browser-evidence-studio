import { describe, expect, it } from 'vitest';
import type { MaterialField } from '@/contracts/materials';
import type { SourceDocument } from '@/validator/types';
import { fieldProof } from '@/validator/proofs';
import { parseFieldSourceProof } from '@/contracts/workflow';
import { validateContent } from '@/materials/validate';
import { materialContentHash } from '@/materials/service';
import { interpretPlainDecimal, sourceProofCompatibility } from '@/contracts/value-interpretation';

const field: MaterialField = { id: 'amount', dataset: 'orders', name: 'Paid', description: 'Exactly displayed paid text', outputPath: '/paid', sourcePolicy: 'page-displayed',
  sourceProof: { kind: 'dom-text', sourceUrl: 'https://fixture.invalid/orders', nodeAttribute: { name: 'data-field', value: 'paid' }, entityAttribute: 'data-order-id', outputEntityPath: '/id' } };
function doc(): SourceDocument {
  const position = { recordingId: 'run', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', sourceTimeMs: 1000, eventSeq: 5 };
  const ref = { kind: 'dom-node' as const, position, nodeId: 7, frameId: 'document-1', mirrorScopeId: 'epoch:document-1' };
  return { sourceRef: 'sample', scope: { recordingId: 'run', executionId: 'execution', attemptId: 'attempt' }, capturedAt: '2026-09-26T00:00:00Z',
    requestUrl: 'https://fixture.invalid/orders', content: { status: 'present', value: '￥12.30' }, representation: 'dom-text', display: 'observed',
    dom: { node: { ref, tagName: 'span', namespaceURI: 'http://www.w3.org/1999/xhtml', documentUrl: { status: 'present', value: 'https://fixture.invalid/orders' }, baseURI: { status: 'present', value: 'https://fixture.invalid/orders' },
      attributes: { 'data-field': { status: 'present', value: 'paid' } }, properties: {}, text: { status: 'present', value: 'structure text is not displayed proof' }, metadataComplete: true,
      presentation: { status: 'present', value: { text: '￥12.30', visibility: 'visible', sampledAt: position, rect: { x: 0, y: 0, width: 50, height: 20 }, basis: ['source-computed-style', 'source-layout'] } } },
      ancestors: [{ ref: { ...ref, nodeId: 6 }, attributes: { 'data-order-id': { status: 'present', value: 'order-1' } } }] } };
}
describe('fixed displayed-source proof', () => {
  const numeric = (): MaterialField => ({ ...field, valueType: 'number', sourceProof: { ...field.sourceProof!, kind: 'dom-text', ...(field.sourceProof as any), valueInterpretation: { kind: 'plain-decimal', version: 1 } } });
  const decimalDoc = (text = '45.00', entity = 'order-1') => {
    const source = doc(); source.content = { status: 'present', value: text };
    if (source.dom!.node.presentation?.status === 'present') source.dom!.node.presentation.value.text = text;
    source.dom!.ancestors[0].attributes['data-order-id'] = { status: 'present', value: entity }; return source;
  };
  it('C01-C05: explicit numeric semantics distinguish value mismatch, missing source and output type', () => {
    expect(sourceProofCompatibility({ ...field, valueType: 'number' })).toMatch(/配置不相容/);
    expect(fieldProof({ ...field, valueType: 'number' }, { id: 'order-1', paid: 45 }, [decimalDoc()])).toMatchObject({ verdict: 'inconclusive', diagnostic: { code: 'mapping-incompatible' } });
    expect(fieldProof(numeric(), { id: 'order-1', paid: 45 }, [decimalDoc()])).toMatchObject({ verdict: 'pass', diagnostic: { rawText: '45.00', expected: 45, actual: 45, interpretation: 'plain-decimal-v1' } });
    expect(fieldProof(numeric(), { id: 'order-1', paid: 46 }, [decimalDoc()])).toMatchObject({ verdict: 'fail', diagnostic: { code: 'value-mismatch', expected: 45, actual: 46 } });
    expect(fieldProof(numeric(), { id: 'order-1', paid: 45 }, [])).toMatchObject({ verdict: 'inconclusive', diagnostic: { code: 'source-insufficient' } });
    expect(fieldProof(numeric(), { id: 'order-1', paid: '45' }, [])).toMatchObject({ verdict: 'fail', diagnostic: { code: 'output-type' } });
    expect(sourceProofCompatibility({ ...numeric(), valueType: 'string' })).toBeTruthy();
  });
  it('C07: freezes strict decimal grammar, range and observable round-trip precision', () => {
    for (const [raw, value] of [['45.00',45],['12.30',12.3],['-12.30',-12.3],['-0.00',0],['0.000000000000000001',1e-18],['9007199254740991',Number.MAX_SAFE_INTEGER]] as const) expect(interpretPlainDecimal(raw)).toEqual({ ok:true,value });
    for (const raw of ['', ' ', ' 45', '45 ', '+45', '01', '.5', '5.', '1e2', '￥45', '45%', '1,000', '12,30', '1万', '(45)', '--', '***', 'NaN', 'Infinity', '9007199254740992', '9007199254740991.1', '0.10000000000000001', '0.0000000000000000001', '1'.repeat(65)]) {
      expect(interpretPlainDecimal(raw), raw).toMatchObject({ok:false});
      expect(fieldProof(numeric(), {id:'order-1',paid:45}, [decimalDoc(raw)]).verdict, raw).toBe('inconclusive');
    }
    expect(() => parseFieldSourceProof({ ...numeric().sourceProof, valueInterpretation: {kind:'plain-decimal',version:2} })).toThrow();
    expect(() => parseFieldSourceProof({ ...numeric().sourceProof, valueInterpretation: {kind:'plain-decimal',version:1,trim:true} })).toThrow();
  });
  it('C08: never normalizes entity identity and never accepts a normalizedValue claim', () => {
    expect(fieldProof(numeric(),{id:'12',paid:45},[decimalDoc('45.00','0012')]).verdict).toBe('inconclusive');
    expect(fieldProof(numeric(),{id:'0012',paid:45},[decimalDoc('45.00','0012')]).verdict).toBe('pass');
    const source = decimalDoc('46.00'); (source as any).normalizedValue = 45;
    expect(fieldProof(numeric(),{id:'order-1',paid:45},[source]).verdict).toBe('fail');
  });
  it('pins meaning in material hashes and rejects executable/credential constraints', () => {
    expect(parseFieldSourceProof(field.sourceProof)).toEqual(field.sourceProof);
    const material = { requirements: [{ id: 'req', description: 'paid', fieldIds: ['amount'], dataset: 'orders', rules: [] }], fields: [field], checkpoints: [], annotations: [], recordingRefs: [] };
    const validated = validateContent(material), before = materialContentHash(validated);
    const next = structuredClone(validated); if (next.fields[0].sourceProof?.kind === 'dom-text') next.fields[0].sourceProof.nodeAttribute.value = 'list-price';
    expect(materialContentHash(next)).not.toBe(before); expect(materialContentHash(validated)).toBe(before);
    expect(() => parseFieldSourceProof({ ...field.sourceProof, execute: 'document.click()' })).toThrow();
    expect(() => parseFieldSourceProof({ ...field.sourceProof, entityAttribute: 'access_token' })).toThrow();
  });
  it('compares exact sampled text and the current entity, independently of a demonstration value', () => {
    expect(fieldProof(field, { id: 'order-1', paid: '￥12.30' }, [doc()]).verdict).toBe('pass');
    expect(fieldProof(field, { id: 'order-1', paid: '12.30' }, [doc()]).verdict).toBe('fail');
    expect(fieldProof(field, { id: 'another-order', paid: '￥12.30' }, [doc()]).verdict).toBe('inconclusive');
    const another = doc(); another.dom!.ancestors[0].attributes['data-order-id'] = { status: 'present', value: 'another-order' };
    expect(fieldProof(field, { id: 'another-order', paid: '￥12.30' }, [another]).verdict).toBe('pass');
  });
  it('refuses stale, hidden, masked, cross-frame and semantically unrelated values', () => {
    for (const mutate of [
      (value: SourceDocument) => { value.dom!.node.ref.position = { ...value.dom!.node.ref.position, eventSeq: 6 }; },
      (value: SourceDocument) => { if (value.dom!.node.presentation?.status === 'present') value.dom!.node.presentation.value.visibility = 'hidden'; },
      (value: SourceDocument) => { value.dom!.node.presentation = { status: 'redacted', reason: 'privacy' }; },
      (value: SourceDocument) => { value.dom!.ancestors[0].ref.frameId = 'other-frame'; },
      (value: SourceDocument) => { value.dom!.node.attributes['data-field'] = { status: 'present', value: 'list-price' }; },
      (value: SourceDocument) => { value.representation = 'network-json'; },
      (value: SourceDocument) => { value.requestUrl += '?different-filter=yes'; },
    ]) { const changed = doc(); mutate(changed); expect(fieldProof(field, { id: 'order-1', paid: '￥12.30' }, [changed]).verdict).toBe('inconclusive'); }
  });
});
