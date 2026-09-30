/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

afterEach(() => { document.body.replaceChildren(); document.querySelector('meta[name="workbench-instance"]')?.remove(); delete document.documentElement.dataset.workbenchHost; delete window.studio; vi.restoreAllMocks(); vi.resetModules(); });
test('explicit browser bootstrap never reads preferences or probes the native bridge', async () => {
  document.documentElement.dataset.workbenchHost = 'browser';
  document.head.insertAdjacentHTML('beforeend', '<meta name="workbench-instance" content="startup-instance">');
  document.body.innerHTML = '<div id="root"></div>';
  const native = vi.fn(async () => { throw new Error('Should never call native'); });
  window.studio = { call: native, bounds: vi.fn(), onChanged: vi.fn() };
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await import('@/renderer/index');
  await waitFor(() => expect(document.querySelector('.browser-workbench-shell')).not.toBeNull());
  expect(document.body.textContent).toContain('startup-instance'); expect(document.body.textContent).toContain('尚未配对');
  expect(native).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
