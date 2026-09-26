import type { ArtifactInput } from '@/evidence/contracts';
import { redactHtml } from './privacy';

export type CheckpointCaptureOutcome = 'completed' | 'timed-out' | 'cancelled';
export type CheckpointMaterial = Pick<ArtifactInput, 'kind' | 'mediaType' | 'data' | 'captureStatus' | 'reason' | 'metadata'>;

export interface CheckpointCaptureOptions {
  screenshot: () => Promise<Uint8Array>;
  dom: () => Promise<string>;
  signal?: AbortSignal;
  /** Remaining budget after the caller has acquired control and drained input. */
  timeoutMs: number;
}

export interface CheckpointCaptureResult {
  captureEndedAt: string;
  outcome: CheckpointCaptureOutcome;
  /** Fixed order: screenshot, then DOM. No persistence is performed here. */
  materials: [CheckpointMaterial, CheckpointMaterial];
}

function errorText(reason: unknown): string {
  try { return reason instanceof Error ? reason.message : String(reason); }
  catch { return 'Capture failed with an unreadable error'; }
}

/**
 * Freeze the available material at completion, deadline or explicit cancellation.
 * Native capture promises cannot necessarily be stopped. Their eventual results
 * are consumed, but can never modify this result or another capture's state.
 */
export async function captureCheckpointMaterials(options: CheckpointCaptureOptions): Promise<CheckpointCaptureResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error('Checkpoint capture timeout must be between 0 and 2147483647 milliseconds');
  }
  const deadline = performance.now() + options.timeoutMs;
  return new Promise(resolve => {
    const descriptors = [
      { kind: 'screenshot', mediaType: 'image/png', metadata: { capturePrivacy: { policy: 'bes-capture-privacy-v1', access: 'restricted', reason: 'unredacted-pixels' } } },
      { kind: 'dom', mediaType: 'text/html' },
    ] as const;
    const settled: (CheckpointMaterial | undefined)[] = [undefined, undefined];
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: CheckpointCaptureOutcome) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const reason = outcome === 'cancelled'
        ? `Checkpoint capture cancelled${options.signal?.reason === undefined ? '' : ': ' + errorText(options.signal.reason)}`
        : `Checkpoint capture timed out after ${options.timeoutMs} ms`;
      resolve({
        captureEndedAt: new Date().toISOString(), outcome,
        materials: descriptors.map((descriptor, index) => settled[index] ?? {
          ...descriptor, captureStatus: 'read-failed', reason,
        }) as CheckpointCaptureResult['materials'],
      });
    };
    const onAbort = () => finish('cancelled');
    const canAccept = () => {
      if (finished) return false;
      if (options.signal?.aborted) { finish('cancelled'); return false; }
      // A delayed timer must not admit a result observed after its deadline.
      if (performance.now() >= deadline) { finish('timed-out'); return false; }
      return true;
    };
    const accept = (index: number, material: CheckpointMaterial) => {
      settled[index] = material;
      if (settled.every(Boolean)) finish('completed');
    };

    if (options.signal?.aborted) { finish('cancelled'); return; }
    if (options.timeoutMs === 0) { finish('timed-out'); return; }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish('timed-out'), options.timeoutMs);

    [options.screenshot, options.dom].forEach((capture, index) => {
      // Defer invocation so a synchronous throw cannot suppress the other channel.
      void Promise.resolve().then<string | Uint8Array | undefined>(() => canAccept() ? capture() : undefined).then(
        data => {
          if (!canAccept() || data === undefined) return;
          const privacy=index===1&&typeof data==='string'?redactHtml(data):undefined;
          accept(index, { ...descriptors[index], data:privacy?.text??data, captureStatus: data.length ? 'complete' : 'empty',...(privacy?.redacted?{reason:'Form values and privacy-marked DOM content redacted at capture',metadata:{capturePrivacy:{policy:'bes-capture-privacy-v1',representation:'redacted-dom'}}}:{}) });
        },
        reason => {
          if (!canAccept()) return;
          accept(index, { ...descriptors[index], captureStatus: 'read-failed', reason: errorText(reason) });
        },
      );
    });
  });
}
