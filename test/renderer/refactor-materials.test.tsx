/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';
import type { MaterialContent } from '@/contracts/materials';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';

const position: ReplayPosition = { recordingId: 'recording-one', pageId: 'page-one', documentId: 'document-one', streamEpoch: 'epoch-one', sourceTimeMs: 1000, eventSeq: 7 };
const target: HistoricalElementRef = { kind: 'dom-node', position, frameId: 'top', mirrorScopeId: 'scope-one', nodeId: 42 };
const content = (): MaterialContent => ({ recordingRefs: ['recording-one'], annotations: [],
  requirements: [{ id: 'orders', description: 'All paid orders', dataset: 'orders', rules: [], fieldIds: ['amount'] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'Charged amount', outputPath: '/amount', sourcePolicy: 'any-evidenced' }],
  checkpoints: [{ id: 'card', kind: 'requirement', anchor: position, capturedAt: new Date(1000).toISOString(), createdAt: new Date(2000).toISOString(), title: 'Order example', notes: '', requirementIds: ['orders'], annotationIds: [] }],
});
afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });

test('shows an optimistic edit conflict and never silently overwrites the newer draft', async () => {
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: [{ draftId: 'draft-one', draftRevision: 0, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: 'draft-one', draftRevision: 0 };
    if (method === 'materialCollection') return { items: content()[body.collection as keyof MaterialContent] };
    if (method === 'editMaterialDraft') return { status: 'conflict', current: { draftId: 'draft-one', draftRevision: 1 } };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /draft-one/ }));
  fireEvent.change(await screen.findByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('需求说明'), { target: { value: 'All paid orders including final page' } });
  fireEvent.click(screen.getByRole('button', { name: '保存需求' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('当前修订 1'));
  expect(call).toHaveBeenCalledWith('editMaterialDraft', expect.objectContaining({ projectId: 'project-one', draftId: 'draft-one', expectedDraftRevision: 0 }));
  expect(call.mock.calls.filter(([method]) => method === 'editMaterialDraft')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /读取修订 1/ })).toBeTruthy();
});

test('edits a field through description, target, and target plus annotation paths', async () => {
  let revision = 0;
  let stored = content();
  stored.annotations = [{ id: 'note-one', checkpointId: 'card', target, text: 'Visible paid amount', author: 'human', interpretation: 'observed', bindingStatus: 'bound' }];
  stored.checkpoints[0].annotationIds = ['note-one'];
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: [{ draftId: 'draft-one', draftRevision: revision, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: 'draft-one', draftRevision: revision };
    if (method === 'materialCollection') return { items: stored[body.collection as keyof MaterialContent] };
    if (method === 'editMaterialDraft') {
      expect(body.expectedDraftRevision).toBe(revision);
      for (const edit of body.edits) if (edit.operation === 'upsert') {
        const collection = stored[edit.collection as 'fields' | 'requirements'] as Array<{ id: string }>;
        const index = collection.findIndex(item => item.id === edit.item.id);
        if (index >= 0) collection[index] = edit.item; else collection.push(edit.item);
      }
      return { status: 'saved', draft: { draftId: 'draft-one', draftRevision: ++revision } };
    }
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const view = render(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /draft-one/ }));
  fireEvent.change(await screen.findByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('字段'), { target: { value: 'amount' } });
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(1));
  expect(stored.fields[0].target).toBeUndefined();
  expect(stored.fields[0].annotationId).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: /Order example/ }));
  view.rerender(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} selectedTarget={target} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(2));
  expect(stored.fields[0].target).toEqual(target);
  expect(stored.fields[0].annotationId).toBeUndefined();
  expect(stored.fields[0].checkpointId).toBe('card');
  fireEvent.change(screen.getByLabelText('关联元素注释（可选）'), { target: { value: 'note-one' } });
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(3));
  expect(stored.fields[0].annotationId).toBe('note-one');
});
