// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { waitReplayPresentation } from '@/replay/presentation';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(loading = false) {
  vi.useFakeTimers(); (window as any).__besGeneration = 1;
  const document = window.document.implementation.createHTMLDocument('synthetic archive');
  Object.defineProperty(document, 'fonts', { value: { status: loading ? 'loading' : 'loaded', forEach: () => {} } });
  const raf = vi.fn(); vi.stubGlobal('requestAnimationFrame', raf); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return { document, raf };
}
test('offscreen frame cannot wait forever for animation callbacks, and reports unobserved paint honestly', async () => {
  const { document, raf } = fixture(); let complete = false;
  const pending = waitReplayPresentation(document, 1).then(result => { complete = true; return result; });
  await vi.advanceTimersByTimeAsync(999); expect(complete).toBe(false); expect(raf).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(['Historical DOM rebuilt; offscreen paint was not observed within 1 second (see asset diagnostics)']);
});
test('paint timeout does not skip the existing five-second asset readiness budget', async () => {
  const { document } = fixture(true); let complete = false;
  const pending = waitReplayPresentation(document, 1).then(result => { complete = true; return result; });
  await vi.advanceTimersByTimeAsync(4999); expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1001); expect(await pending).toEqual(['Archived fonts did not become ready within 5 seconds', 'Historical DOM rebuilt; offscreen paint was not observed within 1 second (see asset diagnostics)']);
});
test('destroy or superseding generation while paint is stalled rejects rather than publishing readiness', async () => {
  const { document } = fixture(); const pending = waitReplayPresentation(document, 1);
  const rejected = expect(pending).rejects.toThrow('Replay seek superseded');
  (window as any).__besGeneration = 2; await vi.advanceTimersByTimeAsync(1000); await rejected;
});
test('two observed frames complete without a paint warning', async () => {
  const { document, raf } = fixture(); const pending = waitReplayPresentation(document, 1);
  raf.mock.calls[0][0](); raf.mock.calls[1][0](); expect(await pending).toEqual([]);
});
