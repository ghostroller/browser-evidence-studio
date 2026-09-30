/** @vitest-environment jsdom */
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';

afterEach(() => { cleanup(); localStorage.clear(); clearTestWorkbenchClient(); });

function fixture() {
  let rejectRename!: (error: Error) => void;
  let renameCalls = 0;
  const rename = new Promise<never>((_resolve, reject) => { rejectRename = reject; });
  const call = vi.fn(async (method: string, body: Record<string, any> = {}) => {
    const project = body.projectId;
    const draft = { draftId: `${project}-draft`, draftRevision: 0, taskBrief: { objective: project, scope: '' } };
    switch (method) {
      case 'workingMaterialDraft': case 'materialDraft': return draft;
      case 'materialDrafts': return { items: [draft], outputTruncated: false };
      case 'materialRevisions': case 'materialCollection': case 'authoringRecovery': return { items: [], outputTruncated: false };
      case 'materialCatalog': return { catalogRevision: 0, workingDraftId: draft.draftId, drafts: { [draft.draftId]: { name: `${project} copy` } }, revisions: {} };
      case 'manageMaterialCatalog':
        if (++renameCalls === 1) return rename;
        throw new Error('Current project rename failed');
      default: throw new Error(`Unexpected call: ${method}`);
    }
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  const element = (projectId: string) => <MaterialWorkbench projectId={projectId} view="archives" onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />;
  const view = render(element('first'));
  const ready = async (project: string) => {
    await screen.findByDisplayValue(`${project} copy`);
    await waitFor(() => expect((screen.getByRole('button', { name: '复制工作副本' }) as HTMLButtonElement).disabled).toBe(false));
  };
  const startRename = async () => {
    fireEvent.click(screen.getByRole('button', { name: '工作副本' }));
    await ready('first');
    fireEvent.blur(screen.getByLabelText('副本名称'), { target: { value: 'Renamed copy' } });
    await waitFor(() => expect(call).toHaveBeenCalledWith('manageMaterialCatalog', expect.objectContaining({ projectId: 'first', name: 'Renamed copy' })));
  };
  return { view, element, ready, startRename, rejectRename };
}

for (const returnToOriginal of [false, true]) {
  test(`late directory failure does not reach ${returnToOriginal ? 'a new session of the original project' : 'another project'}`, async () => {
    const f = fixture();
    await f.startRename();
    f.view.rerender(f.element('second'));
    await f.ready('second');
    if (returnToOriginal) {
      f.view.rerender(f.element('first'));
      await f.ready('first');
    }
    await act(async () => { f.rejectRename(new Error('Old project rename failed')); });
    expect(screen.queryByText('Error: Old project rename failed')).toBeNull();
    expect(screen.getByDisplayValue(`${returnToOriginal ? 'first' : 'second'} copy`)).toBeTruthy();
  });
}

test('directory failure remains visible in its originating project session', async () => {
  const f = fixture();
  await f.startRename();
  await act(async () => { f.rejectRename(new Error('Current project rename failed')); });
  expect(await screen.findByText('Error: Current project rename failed')).toBeTruthy();
  expect(screen.getByDisplayValue('Renamed copy')).toBeTruthy();
});

for (const returnToOriginal of [false, true]) {
  test(`old directory queue cannot block a rename in ${returnToOriginal ? 'a new session of the original project' : 'another project'}`, async () => {
    const f = fixture();
    await f.startRename();
    f.view.rerender(f.element('second'));
    await f.ready('second');
    if (returnToOriginal) {
      f.view.rerender(f.element('first'));
      await f.ready('first');
    }
    fireEvent.blur(screen.getByLabelText('副本名称'), { target: { value: 'New session name' } });
    // A pending old-session write must not prevent this session's action.
    expect(await screen.findByText('Error: Current project rename failed')).toBeTruthy();
    await act(async () => { f.rejectRename(new Error('Old project rename failed')); });
    expect(screen.queryByText('Error: Old project rename failed')).toBeNull();
    expect(screen.getByText('Error: Current project rename failed')).toBeTruthy();
    expect(screen.getByDisplayValue('New session name')).toBeTruthy();
  });
}
