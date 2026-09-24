/** @vitest-environment jsdom */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { ThemeProvider } from '@/renderer/components/theme-provider';

const runA = 'run-a-000001';
const runB = 'run-b-000002';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function history(runId: string, suffix: string) {
  return {
    checkpoints: { items: [{
      id: `checkpoint-${suffix}`, key: `key-${suffix}`, title: `${suffix} 保存点`,
      artifactRefs: [`artifact-${suffix}`], metadata: { artifacts: [{ id: `artifact-${suffix}`, kind: `DOM ${suffix}` }] },
    }] },
  };
}

function stubLayout() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
}

const state = {
  projects: [{ id: 'project-1', name: 'Test project' }],
  profiles: [{ id: 'profile-1', projectId: 'project-1', name: 'Test profile' }],
  runs: [runA, runB].map(id => ({ id, projectId: 'project-1', kind: 'demonstrate', status: 'sealed' })),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as Partial<Window>).studio;
});

test('a late history response cannot replace the selected archive or redirect artifact reads', async () => {
  stubLayout();

  const requestA = deferred<ReturnType<typeof history>>();
  const requestB = deferred<ReturnType<typeof history>>();
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') return (body as { runId: string }).runId === runA ? requestA.promise : requestB.promise;
    if (method === 'artifact') return { id: (body as { id: string }).id, value: 'B material' };
    throw new Error(`Unexpected studio method: ${method}`);
  });
  window.studio = { call, bounds: vi.fn() };

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  fireEvent.mouseDown(screen.getByRole('tab', { name: '存档' }), { button: 0, ctrlKey: false });
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(runA) })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: new RegExp(runA) }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(runB) }));
  expect(call).toHaveBeenCalledWith('history', { runId: runA });
  expect(call).toHaveBeenCalledWith('history', { runId: runB });

  await act(async () => { requestB.resolve(history(runB, 'B')); });
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: /B 保存点/ })).toBeTruthy();

  await act(async () => { requestA.resolve(history(runA, 'A')); });
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).queryByText(runA)).toBeNull();
  expect(within(dialog).getByRole('button', { name: /B 保存点/ })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: /B 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM B' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('artifact', { runId: runB, id: 'artifact-B' }));
  await waitFor(() => expect(within(dialog).getByText('B material')).toBeTruthy());
});

test('an old artifact response cannot appear in a newly opened archive', async () => {
  stubLayout();
  const oldArtifact = deferred<{ id: string; value: string }>();
  const call = vi.fn(async (method: string, body?: unknown) => {
    if (method === 'state') return state;
    if (method === 'presentation') return undefined;
    if (method === 'history') {
      const runId = (body as { runId: string }).runId;
      return history(runId, runId === runA ? 'A' : 'B');
    }
    if (method === 'artifact') {
      const { id } = body as { id: string };
      return id === 'artifact-A' ? oldArtifact.promise : { id, value: 'B material' };
    }
    throw new Error(`Unexpected studio method: ${method}`);
  });
  window.studio = { call, bounds: vi.fn() };

  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);
  fireEvent.mouseDown(screen.getByRole('tab', { name: '存档' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(runA) }));
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /A 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM A' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('artifact', { runId: runA, id: 'artifact-A' }));

  fireEvent.click(within(dialog).getByRole('button', { name: '返回工作台' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: new RegExp(runB) }));
  dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(runB)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: /B 保存点/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'DOM B' }));
  await waitFor(() => expect(within(dialog).getByText('B material')).toBeTruthy());
  expect(call).toHaveBeenCalledWith('artifact', { runId: runB, id: 'artifact-B' });

  await act(async () => { oldArtifact.resolve({ id: 'artifact-A', value: 'A material' }); });
  expect(within(dialog).getByText(runB)).toBeTruthy();
  expect(within(dialog).getByText('B material')).toBeTruthy();
  expect(within(dialog).queryByText('A material')).toBeNull();
});
