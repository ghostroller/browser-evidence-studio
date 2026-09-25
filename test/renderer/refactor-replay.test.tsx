/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReplayWorkspace } from '@/renderer/components/replay-workspace';
import type { ReplayPosition } from '@/contracts/recording';

const at = (eventSeq: number): ReplayPosition => ({ recordingId: 'run-one', pageId: 'page-one', documentId: 'document-one', streamEpoch: 'epoch-one', sourceTimeMs: 1000 + eventSeq, eventSeq });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }
const host = (position: ReplayPosition, generation: number) => ({ replayId: 'replay-one', projectId: 'project-one', generation, status: 'ready', selecting: false, selectionSequence: 0,
  position, state: { position, reliability: 'reliable', gaps: [], viewport: { width: 800, height: 600, deviceScaleFactor: 1 } } });
afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });

test('closes a native replay host that opens after the workspace unmounts', async () => {
  const opening = deferred<ReturnType<typeof host>>();
  const call = vi.fn(async (method: string) => {
    if (method === 'recordingStreams') return { items: [{ first: at(1), last: at(1), events: 1, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: [{ position: at(1), type: 3, source: 0 }] };
    if (method === 'openReplay') return opening.promise;
    if (method === 'closeReplay') return { ...host(at(1), 1), status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const view = render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={at(1)} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('openReplay', expect.anything()));
  view.unmount();
  await act(async () => opening.resolve(host(at(1), 1)));
  await waitFor(() => expect(call).toHaveBeenCalledWith('closeReplay', expect.objectContaining({ replayId: 'replay-one' })));
});

test('playback follows source-time gaps and retains ordered same-time events', async () => {
  const positions = [at(1), { ...at(2), sourceTimeMs: 1201 }, { ...at(3), sourceTimeMs: 1201 }];
  let current = host(positions[0], 1);
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingStreams') return { items: [{ first: positions[0], last: positions[2], events: 3, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: positions.map(position => ({ position, type: 3, source: 0 })) };
    if (method === 'openReplay') return current;
    if (method === 'seekReplay') { current = host(body.position, current.generation + 1); return current; }
    if (method === 'replayStatus' || method === 'selectReplay') return current;
    if (method === 'closeReplay') return { ...current, status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={positions[0]} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/event #1/)).toBeTruthy());
  vi.useFakeTimers();
  try {
    await act(async () => screen.getByRole('button', { name: '播放' }).click());
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(call.mock.calls.filter(([method]) => method === 'seekReplay')).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(101));
    expect(screen.getByText(/event #2/)).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(16));
    expect(screen.getByText(/event #3/)).toBeTruthy();
    expect(call.mock.calls.filter(([method]) => method === 'seekReplay').map(([, body]) => body.position.eventSeq)).toEqual([2, 3]);
  } finally { vi.useRealTimers(); }
});

test('an older seek response cannot replace a newer exact event position', async () => {
  const second = deferred<ReturnType<typeof host>>();
  const third = deferred<ReturnType<typeof host>>();
  let current = host(at(1), 1);
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingStreams') return { items: [{ first: at(1), last: at(3), events: 3, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: [1, 2, 3].map(index => ({ position: at(index), type: 3, source: 0 })) };
    if (method === 'openReplay') return current;
    if (method === 'seekReplay') return body.position.eventSeq === 2 ? second.promise : third.promise;
    if (method === 'replayStatus') return current;
    if (method === 'selectReplay') return current;
    if (method === 'closeReplay') return { ...current, status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const onPosition = vi.fn();
  const props = { projectId: 'project-one', recordingId: 'run-one', selecting: false, canStop: false, onPosition, onTarget: vi.fn(), onCancelSelection: vi.fn(), onStop: vi.fn(), onClose: vi.fn() };
  const view = render(<ReplayWorkspace {...props} requestedPosition={at(1)} />);
  await waitFor(() => expect(screen.getByText(/event #1/)).toBeTruthy());
  view.rerender(<ReplayWorkspace {...props} requestedPosition={at(2)} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('seekReplay', expect.objectContaining({ position: at(2) })));
  view.rerender(<ReplayWorkspace {...props} requestedPosition={at(3)} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('seekReplay', expect.objectContaining({ position: at(3) })));
  await act(async () => { current = host(at(3), 3); third.resolve(current); });
  await waitFor(() => expect(screen.getByText(/event #3/)).toBeTruthy());
  await act(async () => second.resolve(host(at(2), 2)));
  expect(screen.getByText(/event #3/)).toBeTruthy();
  expect(onPosition.mock.calls.at(-1)?.[0]).toEqual(at(3));
});
