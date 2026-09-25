import { describe, expect, it } from 'vitest';
import { parseReplayPosition, sameReplayPosition } from '@/contracts/recording';

describe('historical event identity', () => {
  const position = { recordingId: 'recording-1', pageId: 'page-1', documentId: 'doc-1', streamEpoch: 'epoch-1', sourceTimeMs: 10, eventSeq: 4 };
  it('rejects missing document/epoch, invalid event boundaries and nonfinite source time', () => {
    for (const change of [{ documentId: '' }, { streamEpoch: undefined }, { sourceTimeMs: Infinity }, { eventSeq: -1 }, { eventSeq: 1.5 }]) {
      expect(() => parseReplayPosition({ ...position, ...change })).toThrow();
    }
  });
  it('does not alias same-millisecond events, document replacement or a restarted mirror stream', () => {
    expect(sameReplayPosition(position, parseReplayPosition(position))).toBe(true);
    for (const change of [{ eventSeq: 5 }, { documentId: 'doc-2' }, { streamEpoch: 'epoch-2' }, { recordingId: 'recording-2' }, { pageId: 'page-2' }]) {
      expect(sameReplayPosition(position, { ...position, ...change })).toBe(false);
    }
  });
});
