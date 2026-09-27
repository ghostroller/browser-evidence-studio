/** @vitest-environment jsdom */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { ThemeProvider } from '@/renderer/components/theme-provider';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));

const page = { pageId: 'page-one', generation: 3, url: 'https://example.test/current', title: 'Current page', inspecting: false };
const active = { id: 'run-one', projectId: 'project-one', profileId: 'profile-one', controller: 'human', locked: false, execution: 'ready', capture: 'recording', pages: [page], selectedPageId: page.pageId, selection: null };
const base = { projects: [{ id: 'project-one', name: 'Project' }], profiles: [{ id: 'profile-one', projectId: 'project-one', name: 'Profile' }], runs: [], active, session: { ...active, pages: [page] } };

afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });

test('live picker requires human control and shows only a selection from the current page generation', async () => {
  let current: any = structuredClone(base);
  let openings = 0;
  const call = vi.fn(async (method: string, body?: any) => {
    if (method === 'state') return structuredClone(current);
    if (method === 'history') return { checkpoints: { items: [] } };
    if (method === 'presentation') return undefined;
    if (method === 'inspect') {
      current.active.pages[0].inspecting = body.enabled;
      current.session.pages[0].inspecting = body.enabled;
      if (body.enabled) current.active.selection = openings++ === 0
        ? { pageId: page.pageId, generation: 2, frameId: 'old-frame', element: { tag: 'button', text: 'Old result' } }
        : null;
      return { enabled: body.enabled };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><App /></ThemeProvider>);

  const start = await screen.findByRole('button', { name: '选取元素（实时页）' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(call).toHaveBeenCalledWith('inspect', { enabled: true }));
  expect(await screen.findByText(/检查模式已开启/)).toBeTruthy();

  expect(screen.queryByText(/Old result/)).toBeNull();

  current.active.selection = { pageId: page.pageId, generation: 3, frameId: 'current-frame', element: { tag: 'button', role: 'button', text: 'Current result', selectors: ['#current'] } };
  await waitFor(() => expect(screen.getByText(/Current result/)).toBeTruthy(), { timeout: 3500 });
  expect(screen.getByText(/#current/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '结束选取（实时页）' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '选取元素（实时页）' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '选取元素（实时页）' }));
  await waitFor(() => expect(screen.getByText(/检查模式已开启/)).toBeTruthy());
  expect(screen.queryByText(/Current result/)).toBeNull();

  current.active.controller = 'agent'; current.session.controller = 'agent';
  await waitFor(() => expect((screen.getByRole('button', { name: '结束选取（实时页）' }) as HTMLButtonElement).disabled).toBe(true), { timeout: 3500 });
});
