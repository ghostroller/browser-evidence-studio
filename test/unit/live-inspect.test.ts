import { expect, test, vi } from 'vitest';
import { makeDispatch } from '@/main/services/dispatch';

test('a new live inspection clears its previous selection only after mode is enabled', async () => {
  const old = { pageId: 'page', generation: 3, element: { tag: 'button' } };
  const run: { controller: string; execution: string; selection?: typeof old } = { controller: 'human', execution: 'ready', selection: old };
  const inspect = vi.fn(async (_enabled: boolean) => {});
  const studio = { required: () => run, current: () => ({ capture: { inspect } }), serialized: (operation: () => Promise<unknown>) => operation() };
  const dispatch = makeDispatch(studio as never);

  await dispatch('inspect', { enabled: true });
  expect(inspect).toHaveBeenCalledWith(true);
  expect(run.selection).toBeUndefined();

  run.selection = old;
  await dispatch('inspect', { enabled: false });
  expect(run.selection).toBe(old);

  inspect.mockRejectedValueOnce(new Error('observer unavailable'));
  await expect(dispatch('inspect', { enabled: true })).rejects.toThrow('observer unavailable');
  expect(run.selection).toBe(old);
});
