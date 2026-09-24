/** @vitest-environment jsdom */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ValidationView } from '@/renderer/components/evidence-view';

const projectId = 'project-current';
const validationRunId = 'run-validation';
const checkpointKey = 'orders-loaded';

const record = {
  id: 'validation-current', projectId, runId: validationRunId, currentVersion: 'matched',
  result: {
    durationMs: 12, datasets: [],
    validation: {
      overall: 'pass', coverageVerdict: 'pass', assertionVerdict: 'pass',
      versionVerdict: 'pass', executionVerdict: 'pass',
      requirements: [{ id: 'orders', checkpointKey, coverageVerdict: 'pass', assertionVerdict: 'pass', checks: [] }],
    },
  },
};

function demoRun(id: string) {
  return { id, projectId, kind: 'demonstrate', createdAt: '2026-09-24T00:00:00.000Z' };
}

function checkpoint(title: string, screenshotId: string) {
  return {
    key: checkpointKey, title, description: `${title}说明`,
    metadata: { artifacts: [{ id: screenshotId, kind: 'screenshot', captureStatus: 'complete' }] },
  };
}

function history(runId: string, title: string, screenshotId: string, returnedProjectId = projectId, returnedRunId = runId) {
  return { summary: { run: { id: returnedRunId, projectId: returnedProjectId } }, checkpoints: [checkpoint(title, screenshotId)] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  delete (window as Partial<Window>).studio;
});

test.each([
  ['another project', 'project-foreign', 'demo-current'],
  ['another run', projectId, 'demo-foreign'],
])('rejects history from %s before showing its checkpoint or screenshot', async (_case, returnedProjectId, returnedRunId) => {
  const runId = 'demo-current';
  const call = vi.fn(async (method: string, body?: unknown): Promise<any> => {
    if (method === 'reviews') return { items: [] };
    if (method === 'history') return history(runId, 'foreign checkpoint', 'foreign-screenshot', returnedProjectId, returnedRunId);
    throw new Error(`Unexpected studio method: ${method}`);
  });
  window.studio = { call, bounds: vi.fn() };

  render(<ValidationView record={record} onReview={vi.fn()} checkpoints={[]} runs={[demoRun(runId)]} />);
  fireEvent.change(screen.getByRole('combobox', { name: '同项目人工示范' }), { target: { value: runId } });

  await waitFor(() => expect(screen.getByText(/示范不属于当前验收项目/)).toBeTruthy());
  expect(call).toHaveBeenCalledWith('history', { runId });
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '同项目人工示范' }).value).toBe('');
  expect(screen.queryByText(/foreign checkpoint/)).toBeNull();
  expect(screen.queryByRole('img', { name: '人工示例 checkpoint' })).toBeNull();
});

test('keeps the newer demonstration when older history returns last', async () => {
  const first = deferred<ReturnType<typeof history>>();
  const second = deferred<ReturnType<typeof history>>();
  const call = vi.fn((method: string, body?: any): Promise<any> => {
    if (method === 'reviews') return Promise.resolve({ items: [] });
    if (method === 'history' && body.runId === 'demo-first') return first.promise;
    if (method === 'history' && body.runId === 'demo-second') return second.promise;
    throw new Error(`Unexpected studio method: ${method}`);
  });
  window.studio = { call, bounds: vi.fn() };

  render(<ValidationView record={record} onReview={vi.fn()} checkpoints={[]} runs={[demoRun('demo-first'), demoRun('demo-second')]} />);
  const selector = screen.getByRole<HTMLSelectElement>('combobox', { name: '同项目人工示范' });
  fireEvent.change(selector, { target: { value: 'demo-first' } });
  await waitFor(() => expect(call).toHaveBeenCalledWith('history', { runId: 'demo-first' }));
  fireEvent.change(selector, { target: { value: 'demo-second' } });
  await waitFor(() => expect(call).toHaveBeenCalledWith('history', { runId: 'demo-second' }));

  await act(async () => { second.resolve(history('demo-second', 'second checkpoint', 'second-screenshot')); });
  expect(screen.getByText('人工示例 · second checkpoint')).toBeTruthy();
  expect(screen.getByRole<HTMLImageElement>('img', { name: '人工示例 checkpoint' }).getAttribute('src'))
    .toBe('bes-artifact://demo-second/second-screenshot');

  await act(async () => { first.resolve(history('demo-first', 'first checkpoint', 'first-screenshot')); });
  expect(selector.value).toBe('demo-second');
  expect(screen.getByText('人工示例 · second checkpoint')).toBeTruthy();
  expect(screen.queryByText(/first checkpoint/)).toBeNull();
  expect(screen.getByRole<HTMLImageElement>('img', { name: '人工示例 checkpoint' }).getAttribute('src'))
    .toBe('bes-artifact://demo-second/second-screenshot');
});
