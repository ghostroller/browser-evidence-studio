/**
 * Independent logic excerpts of two source paths at commit 97d6623.
 * NOT importing the application, NOT an Electron test, and NOT a fix.
 * Purpose: give the local agent small, deterministic regression targets.
 * Source: src/renderer/components/material-workbench.tsx
 *         src/validator/service.ts
 */
import assert from 'node:assert/strict';

// P04: create/save requirement omits dataset; field save adds only fieldIds.
const requirement = { id: 'r1', description: '采集订单金额', rules: [], fieldIds: [] };
const field = { id: 'f1', dataset: 'orders', name: 'amount', description: '实付金额', sourcePolicy: 'any-evidenced' };
const savedRequirement = { ...requirement, fieldIds: [...new Set([...requirement.fieldIds, field.id])] };
const names = new Set([savedRequirement].flatMap(r => [
  r.dataset, ...r.rules.filter(rule => rule.type === 'reference').map(rule => rule.dataset),
]).filter(Boolean));
assert.equal(field.dataset, 'orders');
assert.equal(savedRequirement.dataset, undefined);
assert.equal(names.size, 0);

// P05: selecting/reselecting a card clears fieldTarget, but not selected fieldId.
const originalTarget = { kind: 'dom-node', position: { recordingId: 'demo', eventSeq: 10 }, nodeId: 42 };
const storedField = { ...field, target: originalTarget, checkpointId: 'c1', bindingStatus: 'bound' };
const editor = { fieldId: storedField.id, fieldTarget: originalTarget, fieldAnnotationId: '' };
// Relevant state mutations from selectCard().
editor.fieldTarget = null;
editor.fieldAnnotationId = '';
// Relevant branch from saveField().
const savedField = { ...storedField, description: '实付金额，单位元' };
if (editor.fieldTarget) {
  savedField.target = editor.fieldTarget;
} else {
  delete savedField.target;
  delete savedField.bindingStatus;
  delete savedField.checkpointId;
  delete savedField.annotationId;
}
assert.equal(editor.fieldId, storedField.id);
assert.equal(Object.hasOwn(savedField, 'target'), false);
assert.equal(Object.hasOwn(storedField, 'target'), true);

console.log(JSON.stringify({
  sourceCommit: '97d6623d8028bdef9008a52a0f965e8d82187c74',
  runtime: process.version,
  scope: 'Independent logical excerpts only; not application or desktop execution',
  P04: { fieldDataset: field.dataset, requirementDataset: savedRequirement.dataset ?? null,
    datasetsRequestedByValidator: [...names], defectExhibited: names.size === 0 },
  P05: { selectedFieldIdStillPresent: editor.fieldId, originalHasTarget: true,
    savedHasTargetAfterOnlyCardSelectionAndTextEdit: Object.hasOwn(savedField, 'target'), defectExhibited: true },
}, null, 2));
