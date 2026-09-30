import { afterEach, expect, test } from 'vitest';
import { WorkbenchDispatcher } from '@/main/workbench/dispatch';
import { WorkbenchSessions } from '@/main/workbench/session';
import type { BrowserMaterialPort } from '@/main/workbench/material-port';
const registries: WorkbenchSessions[] = [];
afterEach(() => registries.splice(0).forEach(registry => registry.dispose()));

test.each(['materialCatalog', 'materialDrafts', 'materialRevisions', 'workingMaterialDraft'])('%s suppresses an expired read result even if directory repair could have occurred', async method => {
  let now = 1000;
  const sessions = new WorkbenchSessions({ instanceId: 'instance', now: () => now, sessionTtlMs: 100 }); registries.push(sessions);
  const session = sessions.exchange(sessions.begin('project', 'project-materials').ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const materials: BrowserMaterialPort = { execute: async (_request, access) => { access.authorize(); now = session.expiresAt; return { privateFixture: 'authorized read started before expiry' }; } };
  const metadata = { readProject: async () => { throw new Error('Unexpected metadata call'); }, updateProject: async () => { throw new Error('Unexpected metadata write'); } };
  const dispatcher = new WorkbenchDispatcher(sessions, metadata, undefined, materials);
  await expect(dispatcher.dispatch({ instanceId: 'instance', method, body: { projectId: 'project' } }, context)).rejects.toMatchObject({ code: 'unauthorized' });
});

test('an explicit atomic edit that has started may report its saved result after expiry', async () => {
  let now = 1000;
  const sessions = new WorkbenchSessions({ instanceId: 'instance', now: () => now, sessionTtlMs: 100 }); registries.push(sessions);
  const session = sessions.exchange(sessions.begin('project', 'project-materials').ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const materials: BrowserMaterialPort = { execute: async (_request, access) => { access.authorize(); now = session.expiresAt; return { status: 'saved' }; } };
  const metadata = { readProject: async () => { throw new Error('Unexpected metadata call'); }, updateProject: async () => { throw new Error('Unexpected metadata write'); } };
  const dispatcher = new WorkbenchDispatcher(sessions, metadata, undefined, materials);
  expect(await dispatcher.dispatch({ instanceId: 'instance', method: 'editMaterialDraft', body: { projectId: 'project', draftId: 'draft', expectedDraftRevision: 0, edits: [{ operation: 'task-brief', taskBrief: { objective: 'Saved', scope: '' } }] } }, context)).toEqual({ status: 'saved' });
});

import { parseMaterialRequest } from '@/main/workbench/material-validation';
const position = { recordingId: 'recording', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', eventSeq: 1, sourceTimeMs: 100 };
const target = { kind: 'dom-node', position, frameId: 'top', mirrorScopeId: 'top', nodeId: 999999 };
const shapes = [
  { collection: 'fields', property: 'sourcePolicy', allowed: 'any-evidenced', item: { id: 'f', dataset: 'records', name: 'field', description: '', sourcePolicy: 'any-evidenced' } },
  { collection: 'fields', property: 'valueType', allowed: 'number', item: { id: 'f', dataset: 'records', name: 'field', description: '', sourcePolicy: 'any-evidenced' } },
  { collection: 'fields', property: 'bindingStatus', allowed: 'bound', item: { id: 'f', dataset: 'records', name: 'field', description: '', sourcePolicy: 'any-evidenced', target, checkpointId: 'c' } },
  { collection: 'annotations', property: 'bindingStatus', allowed: 'bound', item: { id: 'n', checkpointId: 'c', text: 'note', author: 'human', interpretation: 'observed', bindingStatus: 'bound', target } },
  { collection: 'annotations', property: 'interpretation', allowed: 'observed', item: { id: 'n', checkpointId: 'c', text: 'note', author: 'human', interpretation: 'observed', bindingStatus: 'none' } },
  { collection: 'annotations', property: 'author', allowed: 'human', item: { id: 'n', checkpointId: 'c', text: 'note', author: 'human', interpretation: 'observed', bindingStatus: 'none' } },
];
for (const shape of shapes) test(`${shape.collection}.${shape.property} rejects arrays and objects masquerading as string enums`, () => {
  for (const invalid of [[shape.allowed], { value: shape.allowed }]) {
    expect(() => parseMaterialRequest({ instanceId: 'instance', method: 'editMaterialDraft', body: { projectId: 'project', draftId: 'draft', expectedDraftRevision: 0,
      edits: [{ operation: 'upsert', collection: shape.collection, item: { ...shape.item, [shape.property]: invalid } }] } })).toThrow('invalid_request');
  }
});
test('nested field example and requirement value-type enums are also strict strings', () => {
  for (const edit of [
    { operation: 'add-field-example', fieldId: 'field', example: { id: 'ex', checkpointId: 'c', target, bindingStatus: ['bound'] } },
    { operation: 'upsert', collection: 'fields', item: { id: 'f', dataset: 'records', name: 'f', description: '', sourcePolicy: 'any-evidenced', examples: [{ id: 'ex', checkpointId: 'c', target, bindingStatus: ['bound'] }] } },
    { operation: 'upsert', collection: 'requirements', item: { id: 'r', description: 'rule', fieldIds: [], rules: [{ type: 'field-type', field: 'f', valueType: ['number'] }] } },
  ]) expect(() => parseMaterialRequest({ instanceId: 'instance', method: 'editMaterialDraft', body: { projectId: 'project', draftId: 'draft', expectedDraftRevision: 0, edits: [edit] } })).toThrow('invalid_request');
});
