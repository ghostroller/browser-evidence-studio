import { describe, expect, it } from 'vitest';
import type { MaterialContent } from '../../src/contracts/materials';
import { parseJsonPointer, parsePaginationProof, type NumberedPaginationProof } from '../../src/contracts/workflow';
import { validateContent } from '../../src/materials/validate';
import { materialContentHash } from '../../src/materials/service';

const proof: NumberedPaginationProof = {
  kind: 'numbered-pages', sourceUrl: 'https://fixture.invalid/api/orders?variant=normal', pageParameter: 'page',
  pagePointer: '/page', rowsPointer: '/items', entityPointer: '/id', outputEntityPath: '/id',
  termination: { kind: 'has-next-and-total', hasNextPointer: '/hasNext', totalRecordsPointer: '/total' },
};
const content = (): MaterialContent => ({
  recordingRefs: [], checkpoints: [], annotations: [],
  requirements: [{ id: 'all-orders', description: 'All matching orders with the displayed paid amount', dataset: 'orders',
    fieldIds: ['amount'], rules: [{ type: 'pagination-complete', minPages: 1, proof: structuredClone(proof) }] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'Charged amount in cents',
    outputPath: '/amountCents', valueType: 'number', sourcePolicy: 'any-evidenced', sourceProof: {
      kind: 'json-record', sourceUrl: proof.sourceUrl, pageParameter: 'page', rowsPointer: '/items', entityPointer: '/id',
      outputEntityPath: '/id', valuePointer: '/amountCents',
    } }],
});

describe('fixed material source constraints', () => {
  it('keeps display names separate from output paths and hashes the exact proof scope', () => {
    const original = content();
    const validated = validateContent(original);
    expect(validated.fields[0]).toMatchObject({ name: 'Paid amount', outputPath: '/amountCents' });
    const before = materialContentHash(validated);
    original.fields[0].sourceProof!.sourceUrl = 'https://fixture.invalid/api/orders?variant=other';
    expect(materialContentHash(original)).not.toBe(before);
    expect(validated.fields[0].sourceProof!.sourceUrl).toContain('variant=normal');
    expect(materialContentHash(validated)).toBe(before);
  });
  it('rejects ambiguous pointers, active/credential URLs and unknown termination rules', () => {
    for (const invalid of ['amount', '/bad~escape', '/line\n', 'x'.repeat(1025)]) expect(() => parseJsonPointer(invalid)).toThrow();
    expect(parseJsonPointer('/a~1b/~0value')).toBe('/a~1b/~0value');
    for (const sourceUrl of ['javascript:alert(1)', 'file:///tmp/orders', 'https://user:pass@fixture.invalid/', 'https://fixture.invalid/?token=secret', 'https://fixture.invalid/#fragment']) {
      expect(() => parsePaginationProof({ ...proof, sourceUrl })).toThrow();
    }
    expect(() => parsePaginationProof({ ...proof, termination: { kind: 'script-says-done' } })).toThrow();
    expect(() => parsePaginationProof({ ...proof, execute: 'untrusted()' })).toThrow();
    const noPath = content(); delete noPath.fields[0].outputPath;
    expect(() => validateContent(noPath)).toThrow(/outputPath/);
  });
  it('preserves old field definitions and unproven pagination without inventing bindings', () => {
    const old = content(); delete old.fields[0].outputPath; delete old.fields[0].sourceProof;
    old.requirements[0].rules = [{ type: 'pagination-complete', minPages: 3 }];
    expect(validateContent(old)).toEqual(old);
  });
});
