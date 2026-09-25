import type { eventWithTime } from '@rrweb/types';
import type { ReplayWindow } from './archive';

/** rrweb's public pause boundary is strict (< timestamp). Build a disposable
 * presentation clock with sub-millisecond ties broken by SOURCE sequence. The
 * original records and ReplayPosition are never changed. Distinct source clock
 * ticks retain their durations; same-ms positions become independently seekable. */
export function prepareReplayEvents(window: ReplayWindow): { events: eventWithTime[]; pauseOffset: number; sourceTimeMs: number } {
  const baseline = window.records[0], initialTime = baseline.event.timestamp;
  const events: eventWithTime[] = [{ type: 4, timestamp: initialTime - 0.001, data: { href: 'about:blank', width: baseline.viewport.width, height: baseline.viewport.height } }];
  let previous = initialTime - 0.001;
  for (const record of window.records) {
    const event = structuredClone(record.event);
    event.timestamp = Math.max(event.timestamp, previous + 0.001); previous = event.timestamp;
    // Mouse-path offsets are visualization-only. They cannot run before the
    // bounded baseline when rebuilding an exact paused historical position.
    if (event.type === 3 && (event.data.source === 1 || event.data.source === 6 || event.data.source === 12)) for (const item of event.data.positions) item.timeOffset = 0;
    events.push(event);
  }
  return { events, pauseOffset: previous - events[0].timestamp + 0.001, sourceTimeMs: window.position.sourceTimeMs };
}
