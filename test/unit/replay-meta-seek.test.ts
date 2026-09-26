import { describe, expect, it } from 'vitest';
import type { ReplayWindow } from '@/replay/archive';
import { prepareReplayEvents } from '@/replay/rrweb-player';

function replayWindow(sameMillisecond = false): ReplayWindow {
  const position = { recordingId: 'synthetic', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', eventSeq: 4, sourceTimeMs: 1203 };
  const rows = [
    { seq: 1, time: 1000, event: { type: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } }, viewport: { width: 800, height: 600 } },
    { seq: 2, time: 1100, event: { type: 3, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } }, viewport: { width: 800, height: 600 } },
    { seq: 3, time: sameMillisecond ? 1203 : 1200, event: { type: 3, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } }, viewport: { width: 800, height: 600 } },
    { seq: 4, time: 1203, event: { type: 4, data: { href: 'https://synthetic.invalid/', width: 1024, height: 768 } }, viewport: { width: 1024, height: 768 } },
  ];
  return { position, baselineSeq: 1, readBytes: 0, gaps: [], records: rows.map(row => ({
    position: { ...position, eventSeq: row.seq, sourceTimeMs: row.time }, event: { ...row.event, timestamp: row.time }, viewport: row.viewport,
  })) as ReplayWindow['records'] };
}

describe('rrweb replay preparation at a source Meta boundary', () => {
  it.each([false, true])('keeps DOM history and exact viewport order (same millisecond: %s)', sameMillisecond => {
    const window = replayWindow(sameMillisecond);
    const prepared = prepareReplayEvents(window);
    expect(prepared.events).toHaveLength(window.records.length + 1);
    expect(prepared.events.map(event => event.timestamp)).toEqual([...prepared.events.map(event => event.timestamp)].sort((a, b) => a - b));
    expect(prepared.events.filter(event => event.type === 4)).toHaveLength(1);
    expect(prepared.events.at(-1)).toMatchObject({ type: 3, data: { source: 4, width: 1024, height: 768 } });
    expect(window.records.at(-1)?.event).toMatchObject({ type: 4, data: { width: 1024, height: 768 } });
  });
  it('keeps the following full snapshot strictly after the Meta seek boundary', () => {
    const window = replayWindow();
    const target = prepareReplayEvents(window);
    window.records.push({ ...window.records[0], position: { ...window.position, eventSeq: 5, sourceTimeMs: 1207 }, event: { ...window.records[0].event, timestamp: 1207 } });
    window.position = window.records.at(-1)!.position;
    const next = prepareReplayEvents(window);
    expect(target.events.at(-1)).toMatchObject({ type: 3, data: { source: 4 } });
    expect(next.events.at(-1)?.type).toBe(2);
    expect(next.events.at(-1)!.timestamp - next.events.at(-2)!.timestamp).toBeCloseTo(4);
    expect(target.events.at(-1)!.timestamp).toBeLessThan(next.events.at(-1)!.timestamp);
  });
});
