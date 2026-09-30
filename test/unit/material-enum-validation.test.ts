import { expect, test } from 'vitest';
import { validateContent } from '@/materials/validate';
import type { MaterialContent } from '@/contracts/materials';

function content(): MaterialContent {
  const position = { recordingId: 'recording', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', sourceTimeMs: 100, eventSeq: 1 };
  const target = { kind: 'dom-node' as const, position, frameId: 'top', mirrorScopeId: 'top', nodeId: 1 };
  return { recordingRefs: ['recording'],
    requirements: [{ id: 'r', description: 'requirement', dataset: 'records', rules: [{ type: 'field-type', field: 'value', valueType: 'number' }], fieldIds: ['f'] }],
    fields: [{ id: 'f', dataset: 'records', name: 'value', description: 'value', sourcePolicy: 'any-evidenced', valueType: 'number', target, checkpointId: 'c', annotationId: 'n', bindingStatus: 'bound', examples: [{ id: 'ex', checkpointId: 'c', target, bindingStatus: 'bound' }] }],
    checkpoints: [{ id: 'c', kind: 'observation', anchor: position, capturedAt: new Date(100).toISOString(), createdAt: new Date(100).toISOString(), title: 'card', notes: '', requirementIds: ['r'], annotationIds: ['n'] }],
    annotations: [{ id: 'n', checkpointId: 'c', target, text: 'note', author: 'human', interpretation: 'observed', bindingStatus: 'bound' }],
  };
}
const properties = [
  { label: 'rule.valueType', value: 'number', mutate: (data: MaterialContent, value: unknown) => { (data.requirements[0].rules[0] as unknown as Record<string, unknown>).valueType = value; } },
  { label: 'field.sourcePolicy', value: 'any-evidenced', mutate: (data: MaterialContent, value: unknown) => { (data.fields[0] as unknown as Record<string, unknown>).sourcePolicy = value; } },
  { label: 'field.valueType', value: 'number', mutate: (data: MaterialContent, value: unknown) => { (data.fields[0] as unknown as Record<string, unknown>).valueType = value; } },
  { label: 'field.bindingStatus', value: 'bound', mutate: (data: MaterialContent, value: unknown) => { (data.fields[0] as unknown as Record<string, unknown>).bindingStatus = value; } },
  { label: 'example.bindingStatus', value: 'bound', mutate: (data: MaterialContent, value: unknown) => { (data.fields[0].examples![0] as unknown as Record<string, unknown>).bindingStatus = value; } },
  { label: 'annotation.interpretation', value: 'observed', mutate: (data: MaterialContent, value: unknown) => { (data.annotations[0] as unknown as Record<string, unknown>).interpretation = value; } },
  { label: 'annotation.bindingStatus', value: 'bound', mutate: (data: MaterialContent, value: unknown) => { (data.annotations[0] as unknown as Record<string, unknown>).bindingStatus = value; } },
];
for (const property of properties) test(`shared material ${property.label} accepts strings and rejects forged array/object enum values without coercion`, () => {
  const valid = content(); property.mutate(valid, property.value); expect(validateContent(valid)).toEqual(valid);
  for (const value of [[property.value], { value: property.value }]) {
    const invalid = content(); property.mutate(invalid, value);
    expect(() => validateContent(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_MATERIAL' }));
  }
});
