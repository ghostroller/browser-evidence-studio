export interface ObserverContext { contextId: number; frameId: string }
export interface ObserverProbeResult { result?: { value?: unknown }; exceptionDetails?: { text?: string } }

/** Probe only the current main frame. Child isolated worlds intentionally have no recorder. */
export async function readyMainObserverContexts(
  contexts: ReadonlyMap<number, string>, mainFrameId: string | undefined,
  probe: (contextId: number) => Promise<ObserverProbeResult>,
): Promise<{ ready: ObserverContext[]; unavailable: (ObserverContext & { reason: string })[] }> {
  const ready: ObserverContext[] = [], unavailable: (ObserverContext & { reason: string })[] = [];
  for (const [contextId, frameId] of contexts) {
    if (!mainFrameId || frameId !== mainFrameId) continue;
    const context = { contextId, frameId };
    try {
      const result = await probe(contextId);
      if (!result.exceptionDetails && result.result?.value === true) ready.push(context);
      else unavailable.push({ ...context, reason: result.exceptionDetails?.text ?? 'Main recorder has not finished injection' });
    } catch (error) { unavailable.push({ ...context, reason: String(error) }); }
  }
  return { ready, unavailable };
}
