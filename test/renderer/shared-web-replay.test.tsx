// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SharedWebReplay } from '@/renderer/components/shared-web-replay';
import type { WebReplayBundle } from '@/contracts/web-replay';
afterEach(cleanup);
const position = { recordingId: 'r', pageId: 'p', documentId: 'd', streamEpoch: 's', sourceTimeMs: 1, eventSeq: 1 }, origin = 'http://127.0.0.1:9876';
const request = { projectId: 'p', selectionId: 'selection', draftId: 'draft', expectedDraftRevision: 1, checkpointId: 'card', anchor: position, purpose: 'field' as const };
function harness(selection = false) {
  const calls: any[] = [], onSelection = vi.fn();
  const client = { call: vi.fn(async (method: string, body: any) => {
    calls.push({ method, body });
    if (method === 'webReplaySelection') return { ...body, target: { kind: 'dom-node', position, nodeId: body.nodeId, frameId: 'top', mirrorScopeId: 'mirror' } };
    return { ...body, events: [], resources: [], diagnostics: [], offsets: [{ position, offset: 1 }] } as WebReplayBundle;
  }) };
  const props = { client: client as any, projectId: 'p', instanceId: 'instance', origin, position, request: selection ? request : null, readable: true, onPosition: vi.fn(), onSelection, onClose: vi.fn() };
  const view = render(<SharedWebReplay {...props}/>);
  const frame = () => screen.getByTitle('只读隔离历史文档') as HTMLIFrameElement;
  const post = (data: any, sender = frame().contentWindow, incomingOrigin = origin) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { instanceId: 'instance', ...data }, source: sender, origin: incomingOrigin })); });
  const boot = async () => { const spy = vi.spyOn(frame().contentWindow!, 'postMessage'); post({ type: 'boot' }); await waitFor(() => expect(spy).toHaveBeenCalled()); const load = spy.mock.calls.find(([message]) => message.type === 'load')![0] as any; return { spy, load }; };
  return { calls, client, props, view, frame, post, boot, onSelection };
}
test('dedicated iframe grants no management origin access and wrong sender/origin/identity cannot ready it', async () => {
  const f = harness(), { load } = await f.boot();
  expect(f.frame().getAttribute('sandbox')).toBe('allow-scripts allow-same-origin'); expect(f.frame().src).toBe(`${origin}/replay.html`);
  const ready = { ...load, type: 'ready', sequence: 1, index: 0, position };
  f.post(ready, window); f.post(ready, f.frame().contentWindow, 'http://evil.invalid'); f.post({ ...ready, generation: load.generation - 1 });
  expect((screen.getByRole('button', { name: '播放历史' }) as HTMLButtonElement).disabled).toBe(true);
  f.post(ready); expect((screen.getByRole('button', { name: '播放历史' }) as HTMLButtonElement).disabled).toBe(false);
});
test('disconnect destroys document; fresh boot accepts sequence one rather than waiting for old sequence', async () => {
  const f = harness(), first = await f.boot(); f.post({ ...first.load, type: 'ready', sequence: 50, index: 0, position });
  f.view.rerender(<SharedWebReplay {...f.props} readable={false}/>); expect(screen.queryByTitle('只读隔离历史文档')).toBeNull();
  f.view.rerender(<SharedWebReplay {...f.props} readable/>); const second = await f.boot();
  f.post({ ...second.load, type: 'ready', sequence: 1, index: 0, position });
  expect((screen.getByRole('button', { name: '播放历史' }) as HTMLButtonElement).disabled).toBe(false); expect(second.load.generation).toBeGreaterThan(first.load.generation);
});
test('selection is exact source/request scoped and duplicate messages cannot bind twice', async () => {
  const f = harness(true), { spy, load } = await f.boot(); f.post({ ...load, type: 'ready', sequence: 1, index: 0, position });
  const select = spy.mock.calls.find(([message]) => message.type === 'select')![0] as any;
  f.post({ ...select, type: 'selection', sequence: 2, index: 0, position: { ...position, documentId: 'foreign' }, nodeId: 10 });
  expect(f.client.call).toHaveBeenCalledTimes(1);
  const selected = { ...select, type: 'selection', sequence: 3, index: 0, position, nodeId: 10 };
  f.post(selected); f.post({ ...selected, sequence: 4 });
  await waitFor(() => expect(f.onSelection).toHaveBeenCalledTimes(1));
  expect(f.onSelection.mock.calls[0][0].target).toMatchObject({ nodeId: 10, frameId: 'top', mirrorScopeId: 'mirror', position });
});
test('close invalidates a pending verified selection response', async () => {
  const f = harness(true), { spy, load } = await f.boot(); f.post({ ...load, type: 'ready', sequence: 1, index: 0, position });
  const select = spy.mock.calls.find(([message]) => message.type === 'select')![0] as any;
  let release!: (value: any) => void; f.client.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  f.post({ ...select, type: 'selection', sequence: 2, index: 0, position, nodeId: 10 });
  fireEvent.click(screen.getByRole('button', { name: '关闭历史回放' }));
  await act(async () => release({ ...load.bundle, target: { kind: 'dom-node', position, nodeId: 10, frameId: 'top', mirrorScopeId: 'mirror' } }));
  expect(f.onSelection).not.toHaveBeenCalled();
});
