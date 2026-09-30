/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

afterEach(() => { document.body.replaceChildren(); delete document.documentElement.dataset.workbenchHost; vi.resetModules(); });
test('missing Electron preload displays an explicit startup error instead of a fake workbench', async () => {
  delete window.studio;
  document.documentElement.dataset.workbenchHost = 'electron';
  document.body.innerHTML = '<div id="root"></div>';
  await import('@/renderer/index');
  await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('工作台无法启动'));
  expect(document.body.textContent).toContain('浏览器配对请使用明确的 browser.html 入口');
  expect(document.querySelector('.app-shell')).toBeNull();
  expect(window.studio).toBeUndefined();
});
