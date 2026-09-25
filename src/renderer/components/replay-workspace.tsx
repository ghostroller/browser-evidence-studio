import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoricalElementRef, ReplayPosition, ReplayState } from '@/contracts/recording';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';

type Stream = { first: ReplayPosition; last: ReplayPosition; events: number; monotonicTime: boolean };
type PositionRow = { position: ReplayPosition; type: number; source: number };
type Host = { replayId: string; generation: number; status: 'loading' | 'ready' | 'failed' | 'closed'; position?: ReplayPosition;
  state?: ReplayState; selection?: HistoricalElementRef; selectionSequence?: number; selecting: boolean; error?: string };
const same = (a?: ReplayPosition | null, b?: ReplayPosition | null) => a && b && a.recordingId === b.recordingId && a.pageId === b.pageId &&
  a.documentId === b.documentId && a.streamEpoch === b.streamEpoch && a.eventSeq === b.eventSeq && a.sourceTimeMs === b.sourceTimeMs;
const streamId = (value: Stream) => `${value.first.pageId}/${value.first.documentId}/${value.first.streamEpoch}`;

/** Controls E's isolated native ReplayHost. The renderer never owns an rrweb iframe. */
export function ReplayWorkspace({ projectId, recordingId, requestedPosition, selecting, canStop, onPosition, onTarget, onCancelSelection, onStop, onClose }: {
  projectId: string; recordingId: string; requestedPosition?: ReplayPosition | null; selecting: boolean;
  canStop: boolean; onPosition(position: ReplayPosition, state?: ReplayState): void; onTarget(target: HistoricalElementRef): void; onCancelSelection(): void; onStop(): void; onClose(): void;
}) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [streamCursor, setStreamCursor] = useState('');
  const [stream, setStream] = useState<Stream | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [nextOrdinal, setNextOrdinal] = useState<number | undefined>();
  const [host, setHost] = useState<Host | null>(null);
  const [position, setPosition] = useState<ReplayPosition | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [seeking, setSeeking] = useState(false);
  const [error, setError] = useState('');
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const hostRef = useRef<Host | null>(null);
  const mounted = useRef(false);
  const seekToken = useRef(0);
  const loadToken = useRef(0);
  const pollSelection = useRef(0);
  const requestedHandled = useRef('');
  const advancePending = useRef(false);
  const positionRef = useRef<ReplayPosition | null>(null);
  const positionsRef = useRef<PositionRow[]>([]);
  const nextOrdinalRef = useRef<number | undefined>(undefined);
  const streamRef = useRef<Stream | null>(null);
  const playRef = useRef(false);
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, ...body }), [projectId]);
  const applyHost = useCallback((next: Host, token: number) => {
    if (token !== seekToken.current || next.status === 'closed') return;
    hostRef.current = next; setHost(next);
    if (next.status === 'failed') { setError(next.error || '历史回放不可用'); return; }
    if (next.position) { positionRef.current = next.position; setPosition(next.position); onPosition(next.position, next.state); }
  }, [onPosition]);
  const seek = useCallback(async (target: ReplayPosition) => {
    const token = ++seekToken.current;
    setSeeking(true); setError(''); setPlaying(false); playRef.current = false;
    const current = hostRef.current;
    const opened = !current;
    try {
      const next: Host = current
        ? await call('seekReplay', { replayId: current.replayId, position: target })
        : await call('openReplay', { position: target });
      if (!mounted.current || token !== seekToken.current) {
        if (opened) void call('closeReplay', { replayId: next.replayId }).catch(() => undefined);
        return;
      }
      applyHost(next, token);
    } catch (failure) { if (mounted.current && token === seekToken.current) setError(String(failure)); }
    finally { if (mounted.current && token === seekToken.current) setSeeking(false); }
  }, [applyHost, call]);
  const loadPositions = useCallback(async (selected: Stream, ordinal = 0) => {
    const result: { items: PositionRow[]; nextOrdinal?: number } = await call('recordingPositions', { position: selected.first, ordinal, limit: 100 });
    if (!mounted.current || streamRef.current !== selected) return;
    const next = ordinal ? [...positionsRef.current, ...result.items].slice(-500) : result.items;
    positionsRef.current = next; nextOrdinalRef.current = result.nextOrdinal;
    setPositions(next); setNextOrdinal(result.nextOrdinal);
  }, [call]);
  useEffect(() => {
    mounted.current = true;
    const token = ++loadToken.current;
    setStreams([]); setStream(null); setPositions([]); setStreamCursor(''); setError('');
    void call('recordingStreams', { recordingId, limit: 50 }).then((page: { items: Stream[]; nextCursor?: string }) => {
      if (token !== loadToken.current) return;
      setStreams(page.items); setStreamCursor(page.nextCursor || '');
      const first = page.items.find(entry => requestedPosition && streamId(entry) === `${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}`) || page.items[0];
      if (first) { streamRef.current = first; setStream(first); void loadPositions(first).catch(failure => setError(String(failure)));
        requestedHandled.current = requestedPosition ? `${requestedPosition.recordingId}/${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}/${requestedPosition.eventSeq}` : '';
        void seek(requestedPosition || first.first); }
    }).catch(failure => { if (token === loadToken.current) setError(String(failure)); });
    return () => { mounted.current = false; ++loadToken.current; ++seekToken.current; playRef.current = false; const current = hostRef.current;
      hostRef.current = null; if (current) void call('closeReplay', { replayId: current.replayId }).catch(() => undefined); };
  }, [projectId, recordingId, call, loadPositions, seek]);
  const requestedKey = requestedPosition && `${requestedPosition.recordingId}/${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}/${requestedPosition.eventSeq}`;
  useEffect(() => {
    if (!requestedPosition || !streams.length || requestedHandled.current === requestedKey || same(positionRef.current, requestedPosition)) return;
    const selected = streams.find(item => streamId(item) === `${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}`);
    if (!selected) { setError('请求的历史位置未在当前已加载的流中；请继续读取流列表。'); return; }
    if (streamRef.current !== selected) { streamRef.current = selected; setStream(selected); void loadPositions(selected).catch(failure => setError(String(failure))); }
    requestedHandled.current = requestedKey || '';
    void seek(requestedPosition);
  }, [requestedKey, streams, loadPositions, seek]);
  useEffect(() => {
    const current = hostRef.current;
    if (!current || current.status !== 'ready' || current.selecting === selecting) return;
    const generation = current.generation;
    void call('selectReplay', { replayId: current.replayId, enabled: selecting }).then((next: Host) => {
      if (mounted.current && hostRef.current?.replayId === next.replayId && hostRef.current.generation === generation &&
        next.generation === generation && selectingRef.current === selecting) { hostRef.current = next; setHost(next); }
    }).catch(failure => { if (mounted.current && hostRef.current?.replayId === current.replayId && hostRef.current.generation === generation) setError(String(failure)); });
  }, [selecting, call, host?.replayId, host?.status]);
  useEffect(() => {
    if (!host?.replayId) return;
    const timer = setInterval(() => {
      const current = hostRef.current;
      if (!current) return;
      const token = seekToken.current;
      void call('replayStatus', { replayId: current.replayId }).then((next: Host) => {
        const previous = hostRef.current;
        if (!mounted.current || token !== seekToken.current || previous?.replayId !== next.replayId || next.generation < previous.generation) return;
        hostRef.current = next; setHost(next);
        if (next.status === 'failed') setError(next.error || '历史回放不可用');
        if (next.position && (!same(previous.position, next.position) || previous.state?.reliability !== next.state?.reliability)) {
          positionRef.current = next.position; setPosition(next.position); onPosition(next.position, next.state);
        }
        if (next.selection && (next.selectionSequence || 0) > pollSelection.current) { pollSelection.current = next.selectionSequence || 0; onTarget(next.selection); }
        if (selecting && !next.selecting && previous.selecting) onCancelSelection();
      }).catch(failure => { if (mounted.current && token === seekToken.current && hostRef.current?.replayId === current.replayId && hostRef.current.generation === current.generation) setError(String(failure)); });
    }, 200);
    return () => clearInterval(timer);
  }, [host?.replayId, call, onTarget, onPosition, selecting, onCancelSelection]);
  const nextPosition = useCallback(async (): Promise<ReplayPosition | null> => {
    const selected = streamRef.current, current = positionRef.current;
    if (!selected || !current) return null;
    const loaded = positionsRef.current.find(item => item.position.eventSeq > current.eventSeq);
    if (loaded) return loaded.position;
    // A direct seek may be far beyond the loaded page. Binary search archive ordinals
    // instead of scanning or retaining the entire recording in renderer memory.
    let low = 0, high = selected.events;
    while (low < high && playRef.current && streamRef.current === selected) {
      const middle = Math.floor((low + high) / 2);
      const page: { items: PositionRow[] } = await call('recordingPositions', { position: selected.first, ordinal: middle, limit: 1 });
      const row = page.items[0];
      if (!row) throw new Error('历史位置索引不完整。');
      if (row.position.eventSeq <= current.eventSeq) low = middle + 1; else high = middle;
    }
    if (!playRef.current || streamRef.current !== selected || low >= selected.events) return null;
    await loadPositions(selected, low);
    return positionsRef.current.find(item => item.position.eventSeq > current.eventSeq)?.position || null;
  }, [call, loadPositions]);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = async () => {
      if (cancelled || !playRef.current || advancePending.current) return;
      advancePending.current = true;
      try {
        const next = await nextPosition();
        if (cancelled || !playRef.current) return;
        if (!next) { playRef.current = false; setPlaying(false); return; }
        const elapsed = Math.max(0, next.sourceTimeMs - (positionRef.current?.sourceTimeMs ?? next.sourceTimeMs));
        // Keep same-millisecond events ordered and compress long idle periods.
        const delay = Math.max(16, Math.min(3000, elapsed / speedRef.current));
        timer = setTimeout(async () => {
          if (cancelled || !playRef.current) return;
          const currentHost = hostRef.current;
          if (!currentHost) { playRef.current = false; setPlaying(false); return; }
          const token = ++seekToken.current;
          try {
            const updated: Host = await call('seekReplay', { replayId: currentHost.replayId, position: next });
            if (!cancelled && mounted.current && token === seekToken.current) applyHost(updated, token);
          } catch (failure) { if (!cancelled) { playRef.current = false; setPlaying(false); setError(String(failure)); } }
          finally { advancePending.current = false; if (!cancelled && playRef.current) void schedule(); }
        }, delay);
      } catch (failure) { if (!cancelled) { playRef.current = false; setPlaying(false); setError(String(failure)); } }
      finally { if (!timer) advancePending.current = false; }
    };
    void schedule();
    return () => { cancelled = true; if (timer) clearTimeout(timer); advancePending.current = false; };
  }, [playing, speed, nextPosition, call, applyHost]);
  useEffect(() => {
    if (!selecting) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation();
      const current = hostRef.current; if (current) void call('selectReplay', { replayId: current.replayId, enabled: false }).catch(() => undefined);
      onCancelSelection(); document.querySelector<HTMLElement>('.replay-cancel-selection')?.focus(); }
    };
    window.addEventListener('keydown', cancel, true); return () => window.removeEventListener('keydown', cancel, true);
  }, [selecting, call, onCancelSelection]);
  const changeStream = (index: number) => { const selected = streams[index]; if (!selected) return;
    streamRef.current = selected; setStream(selected); positionsRef.current = []; nextOrdinalRef.current = undefined;
    void loadPositions(selected).catch(failure => setError(String(failure))); void seek(selected.first); };
  const scrub = async (value: number) => { if (!stream) return; setScrubTime(null);
    try { const target: ReplayPosition = await call('resolveRecordingTime', { position: stream.first, sourceTimeMs: value }); await seek(target); }
    catch (failure) { setError(String(failure)); } };
  return <div className="replay-workspace"><div className="replay-controls"><strong>历史回放 · 隔离视图</strong>
    <NativeSelect aria-label="历史页面流" disabled={selecting} value={stream ? String(streams.indexOf(stream)) : ''} onChange={event => changeStream(Number(event.target.value))}>{streams.map((item, index) => <option key={streamId(item)} value={index}>{item.first.pageId.slice(0, 12)} · {item.first.documentId.slice(0, 12)} · {item.events} 事件</option>)}</NativeSelect>
    {streamCursor && <Button disabled={selecting} onClick={() => void call('recordingStreams', { recordingId, cursor: streamCursor, limit: 50 }).then((page: { items: Stream[]; nextCursor?: string }) => { setStreams(current => [...current, ...page.items]); setStreamCursor(page.nextCursor || ''); }).catch(failure => setError(String(failure)))}>更多页面流</Button>}
    <Button disabled={!host || seeking || selecting} onClick={() => { playRef.current = !playing; setPlaying(!playing); }}>{playing ? '暂停' : '播放'}</Button>
    <NativeSelect aria-label="播放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></NativeSelect>
    {selecting && <Button className="replay-cancel-selection" onClick={onCancelSelection}>取消选择（Esc）</Button>}
    <Button className="danger-quiet" disabled={!canStop} onClick={onStop}>停止并接管</Button>
    <Button disabled={!host || seeking || selecting} onClick={() => { playRef.current = false; setPlaying(false); onClose(); }}>返回实时页面</Button></div>
    {stream && <div className="replay-timeline"><input type="range" aria-label="历史时间轴" min={stream.first.sourceTimeMs} max={Math.max(stream.first.sourceTimeMs + 1, stream.last.sourceTimeMs)}
      disabled={selecting || seeking} value={scrubTime ?? position?.sourceTimeMs ?? stream.first.sourceTimeMs} onChange={event => setScrubTime(Number(event.target.value))}
      onPointerUp={event => void scrub(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) void scrub(Number(event.currentTarget.value)); }} />
      <span>{position ? `${new Date(position.sourceTimeMs).toLocaleTimeString('zh-CN', { hour12: false })} · event #${position.eventSeq}` : '读取中'}</span>
      <Button disabled={!position || seeking || selecting} onClick={() => { const previous = [...positions].reverse().find(item => position && item.position.eventSeq < position.eventSeq); if (previous) void seek(previous.position); }}>上一步</Button>
      <Button disabled={!position || seeking || selecting} onClick={() => { const next = positions.find(item => position && item.position.eventSeq > position.eventSeq); if (next) void seek(next.position); else if (nextOrdinal !== undefined && stream) void loadPositions(stream, nextOrdinal); }}>下一步</Button></div>}
    <div className="replay-status" role="status">{host?.state?.reliability === 'reliable' ? '历史状态可靠' : host?.state?.reliability === 'gap' ? '结构缺口：元素绑定不可用' : host?.state?.reliability === 'unsupported' ? '此位置不支持精确还原' : host?.status || '正在读取'}
      {selecting && <span> · 检查模式：选中历史元素后返回资料编辑</span>}{seeking && <span> · 正在定位</span>}</div>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <div className="replay-sequence" aria-label="已加载历史事件">{positions.map(row => <Button key={`${row.position.streamEpoch}-${row.position.eventSeq}`} className={same(position, row.position) ? 'selected' : ''} disabled={seeking || selecting}
      onClick={() => void seek(row.position)}>#{row.position.eventSeq}</Button>)}{nextOrdinal !== undefined && stream && <Button disabled={selecting} onClick={() => void loadPositions(stream, nextOrdinal)}>后续事件</Button>}</div>
  </div>;
}
