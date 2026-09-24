/** @vitest-environment jsdom */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ThemeProvider, usePreferences } from '@/renderer/components/theme-provider';

afterEach(() => {
  cleanup();
  delete (window as Partial<Window>).studio;
});

function LayoutControls() {
  const { preferences, saveLayout, resetLayout } = usePreferences();
  return <>
    <output aria-label="已保存的布局">{JSON.stringify(preferences.layout)}</output>
    <button onClick={() => saveLayout('workspace', [35, 65])}>保存工作台宽度</button>
    <button onClick={() => saveLayout('checkpoints', [60, 40])}>保存保存点高度</button>
    <button onClick={() => void resetLayout()}>重置布局</button>
  </>;
}

test('serializes layout writes before resetting preferences', async () => {
  const releases: Array<() => void> = [];
  const call = vi.fn((_method: string, _body?: unknown) => new Promise<void>(resolve => {
    releases.push(resolve);
  }));
  window.studio = { call, bounds: vi.fn() };
  render(<ThemeProvider initial={{ theme: 'light', layout: {} }}><LayoutControls /></ThemeProvider>);

  fireEvent.click(screen.getByRole('button', { name: '保存工作台宽度' }));
  fireEvent.click(screen.getByRole('button', { name: '保存保存点高度' }));
  fireEvent.click(screen.getByRole('button', { name: '重置布局' }));

  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(call).toHaveBeenNthCalledWith(1, 'uiPreferences', { layout: { workspace: [35, 65] } });
  expect(screen.getByRole('status', { name: '已保存的布局' }).textContent).toBe('{}');

  await act(async () => { releases[0](); });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call).toHaveBeenNthCalledWith(2, 'uiPreferences', { layout: { checkpoints: [60, 40] } });
  expect(screen.getByRole('status', { name: '已保存的布局' }).textContent).toBe('{"workspace":[35,65]}');

  await act(async () => { releases[1](); });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  expect(call).toHaveBeenNthCalledWith(3, 'uiPreferences', { layout: {} });
  expect(screen.getByRole('status', { name: '已保存的布局' }).textContent)
    .toBe('{"workspace":[35,65],"checkpoints":[60,40]}');

  await act(async () => { releases[2](); });
  await waitFor(() => expect(screen.getByRole('status', { name: '已保存的布局' }).textContent).toBe('{}'));
});
