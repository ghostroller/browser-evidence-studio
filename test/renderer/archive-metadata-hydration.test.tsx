/** @vitest-environment jsdom */
import React, { useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialArchivePanel } from '@/renderer/components/material-archive';
afterEach(cleanup);
test('the first committed archive metadata input survives context hydration', async () => {
  const onManage = vi.fn(async () => {}), nothing = vi.fn(async () => {});
  const props: React.ComponentProps<typeof MaterialArchivePanel> = {
    active: true, catalog: { schemaVersion: 1, catalogRevision: 1, drafts: {}, revisions: { fixed: { name: 'Original name', note: '', hidden: false } }, recordings: {} },
    drafts: { items: [] }, revisions: { items: [] }, viewedRevision: { revisionId: 'fixed', contentHash: 'h' }, viewedPages: { requirements: { items: [] }, fields: { items: [] }, checkpoints: { items: [] }, annotations: { items: [] }, recordingRefs: { items: [] } }, pending: '', draftReady: true, exitGuardRef: { current: null }, archivePrompt: null, recoveringPublication: false, publicationOpen: false,
    onRefresh: nothing, onPrepareArchive: nothing, onViewRevision: nothing, onClearRevision: vi.fn(), onReturnToWorkspace: vi.fn(), onCreateDraft: nothing, onCopyDraft: nothing, onSwitchDraft: vi.fn(), onManage, onMore: nothing, onMoreRevision: nothing, onCompareDraft: vi.fn(async () => []), onCompareRevision: vi.fn(async () => []), onOpenReplay: vi.fn(),
  };
  function Probe() { useLayoutEffect(() => { const input = screen.getByLabelText('版本标签') as HTMLInputElement; expect(input.disabled).toBe(false); fireEvent.change(input, { target: { value: 'First archive input' } }); }, []); return <MaterialArchivePanel {...props}/>; }
  render(<Probe/>); await act(async () => {}); expect((screen.getByLabelText('版本标签') as HTMLInputElement).value).toBe('First archive input');
  fireEvent.click(screen.getByRole('button', { name: '保存目录信息' })); await waitFor(() => expect(onManage).toHaveBeenCalledWith('revisions', 'fixed', { name: 'First archive input', note: '' }));
});
