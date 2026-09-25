export type CaptureChannel = 'structure' | 'metadata' | 'sampling' | 'network' | 'resource';
export interface ChannelBudget { maxBytes: number; maxTasks: number }
export interface ChannelMetrics { activeBytes: number; activeTasks: number; peakBytes: number; peakTasks: number; rejectedBytes: number; rejectedTasks: number }
export const CAPTURE_BUDGETS: Record<CaptureChannel, ChannelBudget> = {
  structure: { maxBytes: 32 * 1024 * 1024, maxTasks: 256 },
  metadata: { maxBytes: 4 * 1024 * 1024, maxTasks: 64 },
  sampling: { maxBytes: 1024 * 1024, maxTasks: 32 },
  network: { maxBytes: 40 * 1024 * 1024, maxTasks: 128 },
  resource: { maxBytes: 40 * 1024 * 1024, maxTasks: 4 },
};
/** Reservations include the response string, decoded Buffer and store copy for
 * reads whose bytes have not arrived yet; structural capacity is independent. */
export class CaptureBudget {
  private channels = new Map<CaptureChannel, ChannelMetrics>();
  constructor(private limits = CAPTURE_BUDGETS) {}
  reserve(channel: CaptureChannel, bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid capture reservation');
    const limit = this.limits[channel], state = this.channels.get(channel) ?? { activeBytes: 0, activeTasks: 0, peakBytes: 0, peakTasks: 0, rejectedBytes: 0, rejectedTasks: 0 };
    this.channels.set(channel, state);
    if (state.activeBytes + bytes > limit.maxBytes || state.activeTasks >= limit.maxTasks) { state.rejectedTasks++; state.rejectedBytes += bytes; return null; }
    state.activeBytes += bytes; state.activeTasks++;
    state.peakBytes = Math.max(state.peakBytes, state.activeBytes); state.peakTasks = Math.max(state.peakTasks, state.activeTasks);
    let released = false;
    return () => { if (released) throw new Error('Capture reservation already released'); released = true; state.activeBytes -= bytes; state.activeTasks--; };
  }
  snapshot(): Partial<Record<CaptureChannel, ChannelMetrics>> { return Object.fromEntries([...this.channels].map(([key, value]) => [key, { ...value }])); }
}
