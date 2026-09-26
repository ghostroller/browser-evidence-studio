import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoricalElementRef, ReplayPosition, ReplayState } from '@/contracts/recording';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';

type Stream = { first: ReplayPosition; last: ReplayPosition; events: number; monotonicTime: boolean };
type PositionRow = { position: ReplayPosition; type: number; source: number };
type Foreground = { status: 'recorded' | 'legacy'; items: Array<{ sequence: number; pageId: string | null; observedAtMs: number; transitionOrdinal: number; reason: string }>; nextCursor?: string };
type Host = { replayId: string; generation: number; status: 'loading' | 'ready' | 'failed' | 'closed'; position?: ReplayPosition;
  state?: ReplayState; selection?: HistoricalElementRef; selectionSequence?: number; selecting: boolean; playing?: boolean; rebuilds?: number; commandSequence?: number; error?: string; selectionError?: string;
  resources?: { status: 'loading' | 'pending' | 'ready' | 'partial'; blockedRequests: number; pendingCount?: number; unavailableCount?: number; failures: Array<{ resourceId?: string; generation: number; code?: string; name: string; message: string }> } };
const same = (a?: ReplayPosition | null, b?: ReplayPosition | null) => a && b && a.recordingId === b.recordingId && a.pageId === b.pageId &&
  a.documentId === b.documentId && a.streamEpoch === b.streamEpoch && a.eventSeq === b.eventSeq && a.sourceTimeMs === b.sourceTimeMs;
const streamId = (value: Stream) => `${value.first.pageId}/${value.first.documentId}/${value.first.streamEpoch}`;
const IDLE_SKIP_MS = 5000;
const sourceGapMs = (from: ReplayPosition, to: ReplayPosition) => Math.max(0, to.sourceTimeMs - from.sourceTimeMs);
function waitForSourceGap(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let remaining=milliseconds;
    let timer:ReturnType<typeof setTimeout>;
    function tick(){const slice=Math.min(remaining,0x7fffffff);remaining-=slice;timer=setTimeout(()=>remaining>0?tick():finish(),slice);}
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
    tick();
  });
}
const completeForeground=(timeline:Foreground|null)=>!!timeline&&timeline.status==='recorded'&&!timeline.nextCursor&&
  timeline.items[0]?.transitionOrdinal===1&&timeline.items.every((item,index)=>index===0||item.transitionOrdinal===timeline.items[index-1].transitionOrdinal+1);

/** Controls E's isolated native ReplayHost. The renderer never owns an rrweb iframe. */
export function ReplayWorkspace({ projectId, recordingId, requestedPosition, selecting, canStop, onPosition, onTarget, onSelectionReady, onCancelSelection, onStop, onClose, onError }: {
  projectId: string; recordingId: string; requestedPosition?: ReplayPosition | null; selecting: boolean;
  canStop: boolean; onPosition(position: ReplayPosition, state?: ReplayState): void; onTarget(target: HistoricalElementRef,replayId:string,generation:number): void; onSelectionReady(replayId:string,generation:number):void; onCancelSelection(): void; onStop(): void; onClose(): void; onError?(message: string): void;
}) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [streamCursor, setStreamCursor] = useState('');
  const [stream, setStream] = useState<Stream | null>(null);
  const [foreground, setForeground] = useState<Foreground | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [nextOrdinal, setNextOrdinal] = useState<number | undefined>();
  const [host, setHost] = useState<Host | null>(null);
  const [position, setPosition] = useState<ReplayPosition | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playRevision, setPlayRevision] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(false);
  const [waitingGapMs, setWaitingGapMs] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [error, setError] = useState('');
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const hostRef = useRef<Host | null>(null);
  const mounted = useRef(false);
  const seekToken = useRef(0);
  const loadToken = useRef(0);
  const pollSelection = useRef(0);
  const requestedHandled = useRef('');
  const playPending = useRef(false);
  const segmentEnd = useRef<ReplayPosition | null>(null);
  const positionRef = useRef<ReplayPosition | null>(null);
  const positionsRef = useRef<PositionRow[]>([]);
  const nextOrdinalRef = useRef<number | undefined>(undefined);
  const streamRef = useRef<Stream | null>(null);
  const streamsRef = useRef<Stream[]>([]);
  const foregroundRef = useRef<Foreground | null>(null);
  const playRef = useRef(false);
  const gapWait = useRef<AbortController | null>(null);
  const skipIdleRef = useRef(skipIdle);
  skipIdleRef.current = skipIdle;
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const call = useCallback((method: string, body: Record<string, unknown> = {}) => window.studio.call(method, { projectId, ...body }), [projectId]);
  const closeNative = useCallback((replayId: string) => {
    void call('closeReplay', { replayId }).catch(failure => {
      if (String(failure).includes('Replay view is no longer active')) return;
      const message = `历史视图关闭失败：${String(failure)}`;
      if (mounted.current) setError(message);
      onError?.(message);
    });
  }, [call, onError]);
  const applyHost = useCallback((next: Host, token: number) => {
    if (token !== seekToken.current || next.status === 'closed') return;
    if(hostRef.current?.replayId===next.replayId&&
      (next.generation<hostRef.current.generation||
        (next.generation===hostRef.current.generation&&(next.commandSequence??0)<(hostRef.current.commandSequence??0))))return;
    hostRef.current = next; setHost(next);
    if (next.status === 'failed') { setError(next.error || '历史回放不可用'); return; }
    if (next.position) { positionRef.current = next.position; setPosition(next.position); onPosition(next.position, next.state); }
  }, [onPosition]);
  const seek = useCallback(async (target: ReplayPosition, continuePlayback = false) => {
    gapWait.current?.abort(); gapWait.current = null; setWaitingGapMs(0);
    const token = ++seekToken.current;
    setSeeking(true); setError('');
    if (!continuePlayback) { setPlaying(false); playRef.current = false; }
    const current = hostRef.current;
    const opened = !current;
    try {
      const next: Host = current
        ? await call('seekReplay', { replayId: current.replayId, position: target })
        : await call('openReplay', { position: target });
      if (!mounted.current || token !== seekToken.current) {
        if (opened) closeNative(next.replayId);
        return;
      }
      applyHost(next, token);
    } catch (failure) { if (mounted.current && token === seekToken.current) setError(String(failure)); }
    finally { if (mounted.current && token === seekToken.current) setSeeking(false); }
  }, [applyHost, call, closeNative]);
  const loadPositions = useCallback(async (selected: Stream, ordinal = 0): Promise<PositionRow[]> => {
    const result: { items: PositionRow[]; nextOrdinal?: number } = await call('recordingPositions', { position: selected.first, ordinal, limit: 100 });
    if (!mounted.current || streamRef.current !== selected) return [];
    const next = ordinal ? [...positionsRef.current, ...result.items].slice(-500) : result.items;
    positionsRef.current = next; nextOrdinalRef.current = result.nextOrdinal;
    setPositions(next); setNextOrdinal(result.nextOrdinal);
    return next;
  }, [call]);
  useEffect(() => {
    mounted.current = true;
    const token = ++loadToken.current;
    streamsRef.current=[];foregroundRef.current=null;setStreams([]); setForeground(null); setStream(null); setPositions([]); setStreamCursor(''); setError('');
    void Promise.all([
      call('recordingForeground',{recordingId,limit:100}) as Promise<Foreground>,
      call('recordingStreams', { recordingId, limit: 50 }) as Promise<{items:Stream[];nextCursor?:string}>,
    ]).then(([timeline,page]) => {
      if (token !== loadToken.current) return;
      foregroundRef.current=timeline;setForeground(timeline);
      streamsRef.current=page.items;setStreams(page.items); setStreamCursor(page.nextCursor || '');
      const first = page.items.find(entry => requestedPosition && streamId(entry) === `${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}`) ||
        (completeForeground(timeline)?page.items.filter(entry=>entry.first.pageId===timeline.items[0].pageId).sort((a,b)=>a.first.sourceTimeMs-b.first.sourceTimeMs)[0]:undefined) || page.items[0];
      if (first) { streamRef.current = first; setStream(first);
        requestedHandled.current = requestedPosition ? `${requestedPosition.recordingId}/${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}/${requestedPosition.eventSeq}` : '';
        void loadPositions(first).then(rows => {
          if (!mounted.current || streamRef.current !== first) return;
          const baseline = rows.find(row => row.type === 2)?.position;
          if (!baseline) { setError('当前流的首批事件没有可还原的完整快照。'); return; }
          const requested = requestedPosition && requestedPosition.eventSeq > first.first.eventSeq ? requestedPosition : baseline;
          void seek(requested);
        }).catch(failure => setError(String(failure))); }
    }).catch(failure => { if (token === loadToken.current) setError(String(failure)); });
    return () => { mounted.current = false; ++loadToken.current; ++seekToken.current; playRef.current = false; gapWait.current?.abort(); const current = hostRef.current;
      hostRef.current = null; if (current) closeNative(current.replayId); };
  }, [projectId, recordingId, call, loadPositions, seek, closeNative]);
  const requestedKey = requestedPosition && `${requestedPosition.recordingId}/${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}/${requestedPosition.eventSeq}`;
  useEffect(() => {
    if (selecting || !requestedPosition || !streams.length || requestedHandled.current === requestedKey || same(positionRef.current, requestedPosition)) return;
    const selected = streams.find(item => streamId(item) === `${requestedPosition.pageId}/${requestedPosition.documentId}/${requestedPosition.streamEpoch}`);
    if (!selected) { setError('请求的历史位置未在当前已加载的流中；请继续读取流列表。'); return; }
    if (streamRef.current !== selected) { streamRef.current = selected; setStream(selected); void loadPositions(selected).catch(failure => setError(String(failure))); }
    requestedHandled.current = requestedKey || '';
    void seek(requestedPosition);
  }, [requestedKey, streams, loadPositions, seek,selecting]);
  useEffect(() => {
    const current = hostRef.current;
    if (!current || current.status !== 'ready') return;
    if(selecting){
      if(playRef.current||current.playing){gapWait.current?.abort();setWaitingGapMs(0);playRef.current=false;setPlaying(false);void call('pauseReplay',{replayId:current.replayId}).then((next:Host)=>{if(mounted.current&&hostRef.current?.replayId===next.replayId&&hostRef.current.generation===next.generation&&(next.commandSequence??0)>=(hostRef.current.commandSequence??0)){hostRef.current=next;setHost(next);}}).catch(failure=>setError(String(failure)));return;}
      if(requestedPosition&&!same(current.position,requestedPosition)){void seek(requestedPosition);return;}
      if(current.state?.reliability!=='reliable'){setError('此卡片位置的源结构不可靠，不能选择元素。');onCancelSelection();return;}
    }
    if (current.selecting === selecting){if(selecting)onSelectionReady(current.replayId,current.generation);return;}
    const generation = current.generation;
    void call('selectReplay', { replayId: current.replayId, enabled: selecting }).then((next: Host) => {
      if (mounted.current && hostRef.current?.replayId === next.replayId && hostRef.current.generation === generation &&
        (next.commandSequence??0)>=(hostRef.current.commandSequence??0) &&
        next.generation === generation && selectingRef.current === selecting) { hostRef.current = next; setHost(next);if(selecting&&next.selecting)onSelectionReady(next.replayId,next.generation); }
    }).catch(failure => { if (mounted.current && hostRef.current?.replayId === current.replayId && hostRef.current.generation === generation) setError(String(failure)); });
  }, [selecting, call, host?.replayId, host?.status,host?.playing,host?.position?.eventSeq,requestedKey,requestedPosition,seek,onSelectionReady,onCancelSelection]);
  useEffect(() => {
    if (!host?.replayId) return;
    const timer = setInterval(() => {
      const current = hostRef.current;
      if (!current) return;
      const token = seekToken.current;
      void call('replayStatus', { replayId: current.replayId }).then((next: Host) => {
        const previous = hostRef.current;
        if (!mounted.current || token !== seekToken.current || previous?.replayId !== next.replayId || next.generation < previous.generation ||
          (next.generation===previous.generation&&(next.commandSequence??0)<(previous.commandSequence??0))) return;
        hostRef.current = next; setHost(next);
        if (next.status === 'failed') setError(next.error || '历史回放不可用');
        if (next.position && (!same(previous.position, next.position) || previous.state?.reliability !== next.state?.reliability)) {
          positionRef.current = next.position; setPosition(next.position); onPosition(next.position, next.state);
        }
        if (next.selection && (next.selectionSequence || 0) > pollSelection.current) { pollSelection.current = next.selectionSequence || 0; onTarget(next.selection,next.replayId,next.generation); }
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
  const followStream = useCallback(async (selected:Stream,sourceTimeMs:number)=>{
    if(!selected.monotonicTime)throw new Error('目标页面流的源时钟不单调，请手动选择事件位置。');
    streamRef.current=selected;setStream(selected);positionsRef.current=[];nextOrdinalRef.current=undefined;
    const rows=await loadPositions(selected);
    const baseline=rows.find(row=>row.type===2)?.position;
    if(!baseline)throw new Error('目标前台流没有可还原的完整快照。');
    let target=baseline;
    if(sourceTimeMs>=baseline.sourceTimeMs){
      target=await call('resolveRecordingTime',{position:selected.first,sourceTimeMs:Math.min(sourceTimeMs,selected.last.sourceTimeMs)});
      if(target.eventSeq<baseline.eventSeq)target=baseline;
    }
    if(target.sourceTimeMs>sourceTimeMs&&!(skipIdleRef.current&&target.sourceTimeMs-sourceTimeMs>IDLE_SKIP_MS)){
      const waiter=new AbortController();gapWait.current=waiter;const gap=target.sourceTimeMs-sourceTimeMs;
      setWaitingGapMs(gap);await waitForSourceGap(gap/speedRef.current,waiter.signal);
      if(gapWait.current===waiter){gapWait.current=null;setWaitingGapMs(0);}
      if(waiter.signal.aborted||!playRef.current)return;
    }
    if(playRef.current&&streamRef.current===selected)await seek(target,true);
  },[call,loadPositions,seek]);
  const waitUntil = useCallback(async (from:number,to:number)=>{
    const gap=Math.max(0,to-from);
    if(skipIdleRef.current&&gap>IDLE_SKIP_MS||!gap)return true;
    const waiter=new AbortController();gapWait.current=waiter;setWaitingGapMs(gap);
    await waitForSourceGap(gap/speedRef.current,waiter.signal);
    if(gapWait.current===waiter){gapWait.current=null;setWaitingGapMs(0);}
    return !waiter.signal.aborted&&playRef.current;
  },[]);
  useEffect(() => {
    if (!playing || host?.playing || playPending.current || !hostRef.current || !positionRef.current) return;
    let cancelled=false;playPending.current=true;
    void (async()=>{
      try {
        const selected=streamRef.current!,currentPosition=positionRef.current!;
        const timeline=foregroundRef.current;
        const activeTransition=completeForeground(timeline)?[...timeline!.items].reverse().find(item=>item.observedAtMs<=currentPosition.sourceTimeMs):undefined;
        const followsForeground=!!activeTransition&&activeTransition.pageId===selected.first.pageId;
        const transition=followsForeground?timeline!.items.find(item=>item.observedAtMs>currentPosition.sourceTimeMs):undefined;
        const next=await nextPosition();if(cancelled||!playRef.current)return;
        const following=!next&&followsForeground?streamsRef.current.filter(item=>item!==selected&&item.first.pageId===selected.first.pageId&&item.first.sourceTimeMs>=selected.last.sourceTimeMs)
          .sort((a,b)=>a.first.sourceTimeMs-b.first.sourceTimeMs)[0]:undefined;
        if(transition&&(!next||next.sourceTimeMs>=transition.observedAtMs)&&(!following||transition.observedAtMs<=following.first.sourceTimeMs)){
          if(!await waitUntil(currentPosition.sourceTimeMs,transition.observedAtMs)||cancelled)return;
          if(!transition.pageId){playRef.current=false;setPlaying(false);setError('录制此时没有前台页面。');return;}
          const candidates=streamsRef.current.filter(item=>item.first.pageId===transition.pageId&&item.last.sourceTimeMs>=transition.observedAtMs)
            .sort((a,b)=>a.first.sourceTimeMs-b.first.sourceTimeMs);
          const target=candidates.filter(item=>item.first.sourceTimeMs<=transition.observedAtMs).at(-1)??candidates[0];
          if(!target){playRef.current=false;setPlaying(false);setError('前台页面流尚未载入；请读取更多页面流。');return;}
          await followStream(target,transition.observedAtMs);return;
        }
        if(!next){
          if(following){if(await waitUntil(currentPosition.sourceTimeMs,following.first.sourceTimeMs)&&!cancelled)await followStream(following,following.first.sourceTimeMs);return;}
          playRef.current=false;setPlaying(false);return;
        }
        const available=positionsRef.current.filter(item=>item.position.eventSeq>=next.eventSeq);
        const beforeTransition=transition?available.findIndex(item=>item.position.sourceTimeMs>=transition.observedAtMs):-1;
        // A full snapshot starts a new bounded source window. Cross that
        // boundary with one exact seek, then play the next continuous segment.
        const gap=sourceGapMs(positionRef.current!, next);
        if(available[0]?.type===2||skipIdleRef.current&&gap>IDLE_SKIP_MS){
          if(!(skipIdleRef.current&&gap>IDLE_SKIP_MS)&&gap>0){
            const waiter=new AbortController();gapWait.current=waiter;setWaitingGapMs(gap);
            await waitForSourceGap(gap/speedRef.current,waiter.signal);
            if(gapWait.current===waiter){gapWait.current=null;setWaitingGapMs(0);}
            if(waiter.signal.aborted||cancelled||!playRef.current)return;
          }
          await seek(next,true);return;
        }
        const boundary=available.findIndex(item=>item.type===2);
        const idleBoundary=skipIdleRef.current?available.findIndex((item,index)=>index>0&&sourceGapMs(available[index-1].position,item.position)>IDLE_SKIP_MS):-1;
        const stopAt=[boundary,idleBoundary,beforeTransition].filter(index=>index>=0).sort((a,b)=>a-b)[0]??-1;
        const end=(stopAt<0?available.at(-1):available[stopAt-1])?.position??next,current=hostRef.current;
        if(!current)return;
        segmentEnd.current=end;
        const token=seekToken.current;
        const updated:Host=await call('playReplay',{replayId:current.replayId,endPosition:end,speed:speedRef.current});
        if(!cancelled&&mounted.current&&token===seekToken.current&&playRef.current)applyHost(updated,token);
      }catch(failure){if(!cancelled){playRef.current=false;setPlaying(false);setError(String(failure));}}
      finally{playPending.current=false;if(mounted.current&&playRef.current)setPlayRevision(value=>value+1);}
    })();
    return()=>{cancelled=true;gapWait.current?.abort();};
  },[playing,host?.playing,host?.replayId,host?.generation,host?.status,playRevision,nextPosition,call,applyHost,seek,followStream,waitUntil]);
  useEffect(()=>{
    const current=hostRef.current,end=segmentEnd.current;
    if(!playing||!current?.playing||!end)return;
    void call('playReplay',{replayId:current.replayId,endPosition:end,speed}).catch(failure=>{if(mounted.current)setError(String(failure));});
  },[speed,call]);
  useEffect(() => {
    if (!selecting) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation();
      const current = hostRef.current; if (current) void call('selectReplay', { replayId: current.replayId, enabled: false }).catch(() => undefined);
      onCancelSelection(); document.querySelector<HTMLElement>('.replay-cancel-selection')?.focus(); }
    };
    window.addEventListener('keydown', cancel, true); return () => window.removeEventListener('keydown', cancel, true);
  }, [selecting, call, onCancelSelection]);
  const changeStream = (index: number) => { const selected = streams[index]; if (!selected) return;
    gapWait.current?.abort();playRef.current=false;setPlaying(false);setWaitingGapMs(0);
    streamRef.current = selected; setStream(selected); positionsRef.current = []; nextOrdinalRef.current = undefined;
    void loadPositions(selected).then(rows => { const baseline=rows.find(row=>row.type===2)?.position;
      if (baseline) void seek(baseline); else setError('当前流的首批事件没有可还原的完整快照。');
    }).catch(failure => setError(String(failure))); };
  const scrub = async (value: number) => { if (!stream) return; setScrubTime(null);
    try { const target: ReplayPosition = await call('resolveRecordingTime', { position: stream.first, sourceTimeMs: value }); await seek(target); }
    catch (failure) { setError(String(failure)); } };
  return <div className="replay-workspace"><div className="replay-controls"><strong>历史回放 · 隔离视图</strong>
    <NativeSelect aria-label="历史页面流" disabled={selecting} value={stream ? String(streams.indexOf(stream)) : ''} onChange={event => changeStream(Number(event.target.value))}>{streams.map((item, index) => <option key={streamId(item)} value={index}>{item.first.pageId.slice(0, 12)} · {item.first.documentId.slice(0, 12)} · {item.events} 事件</option>)}</NativeSelect>
    {streamCursor && <Button disabled={selecting} onClick={() => void call('recordingStreams', { recordingId, cursor: streamCursor, limit: 50 }).then((page: { items: Stream[]; nextCursor?: string }) => { streamsRef.current=[...streamsRef.current,...page.items];setStreams(streamsRef.current); setStreamCursor(page.nextCursor || ''); }).catch(failure => setError(String(failure)))}>更多页面流</Button>}
    {foreground?.nextCursor&&<Button disabled={selecting} onClick={()=>void call('recordingForeground',{recordingId,cursor:foreground.nextCursor,limit:100}).then((page:Foreground)=>{const merged={...page,status:'recorded' as const,items:[...foreground.items,...page.items]};foregroundRef.current=merged;setForeground(merged);}).catch(failure=>setError(String(failure)))}>更多前台切换</Button>}
    <Button disabled={!host || seeking || selecting} onClick={() => {if(playing){gapWait.current?.abort();setWaitingGapMs(0);playRef.current=false;setPlaying(false);const current=hostRef.current;if(current)void call('pauseReplay',{replayId:current.replayId}).then((next:Host)=>{if(mounted.current&&hostRef.current?.replayId===next.replayId)applyHost(next,seekToken.current);}).catch(failure=>setError(String(failure)));}else{playRef.current=true;setPlaying(true);}}}>{playing ? '暂停' : '播放'}</Button>
    <NativeSelect aria-label="播放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></NativeSelect>
    <label><input type="checkbox" aria-label="跳过空闲" checked={skipIdle} onChange={event=>{skipIdleRef.current=event.target.checked;gapWait.current?.abort();setWaitingGapMs(0);setSkipIdle(event.target.checked);}} />跳过空闲（超过 5 秒）</label>
    {selecting && <Button className="replay-cancel-selection" onClick={onCancelSelection}>取消选择（Esc）</Button>}
    <Button className="danger-quiet" disabled={!canStop} onClick={onStop}>停止并接管</Button>
    <Button disabled={!host || seeking || selecting} onClick={() => { gapWait.current?.abort();playRef.current = false; setPlaying(false); onClose(); }}>返回实时页面</Button></div>
    {stream && <div className="replay-timeline"><input type="range" aria-label="历史时间轴" min={stream.first.sourceTimeMs} max={Math.max(stream.first.sourceTimeMs + 1, stream.last.sourceTimeMs)}
      disabled={selecting || seeking} value={scrubTime ?? position?.sourceTimeMs ?? stream.first.sourceTimeMs} onChange={event => setScrubTime(Number(event.target.value))}
      onPointerUp={event => void scrub(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) void scrub(Number(event.currentTarget.value)); }} />
      <span>{position ? `${new Date(position.sourceTimeMs).toLocaleTimeString('zh-CN', { hour12: false })} · event #${position.eventSeq}` : '读取中'}</span>
      <Button disabled={!position || seeking || selecting} onClick={() => { const previous = [...positions].reverse().find(item => position && item.position.eventSeq < position.eventSeq); if (previous) void seek(previous.position); }}>上一步</Button>
      <Button disabled={!position || seeking || selecting} onClick={() => { const next = positions.find(item => position && item.position.eventSeq > position.eventSeq); if (next) void seek(next.position); else if (nextOrdinal !== undefined && stream) void loadPositions(stream, nextOrdinal); }}>下一步</Button></div>}
    <div className="replay-status" role="status">{host?.state?.reliability === 'reliable' ? '历史结构可靠' : host?.state?.reliability === 'gap' ? '结构缺口：元素绑定不可用' : host?.state?.reliability === 'unsupported' ? '此位置不支持精确还原' : host?.status || '正在读取'}
      {selecting && <span> · 检查模式：选中历史元素后返回资料编辑</span>}{seeking && <span> · 正在定位</span>}{waitingGapMs>0&&<span> · 源时间空档 {Math.round(waitingGapMs/1000)} 秒，等待下一历史位置</span>}{foreground?.status==='legacy'&&streams.length>1&&<span> · 前台切换未记录，其他页面流需手动选择</span>}{foreground?.status==='recorded'&&!completeForeground(foreground)&&<span> · 前台切换记录未读完或不连续，跨页面连播暂停</span>}</div>
    {host?.resources && <p className={host.resources.status === 'partial' ? 'error-inline' : 'hint'}>历史资源：{host.resources.status === 'partial' ? '部分缺失' : host.resources.status === 'ready' ? '已就绪' : host.resources.status === 'pending' ? '等待源响应' : '读取中'} · 拦截外部请求 {host.resources.blockedRequests} 次{(host.resources.pendingCount??0)>0 ? ` · ${host.resources.pendingCount} 项当时尚未可用` : ''}{(host.resources.unavailableCount??0)>0 ? ` · ${host.resources.unavailableCount} 项不可用` : ''}</p>}
    {host?.resources?.failures.length ? <details><summary>历史资源读取失败</summary>{host.resources.failures.slice(0, 20).map((failure, index) => <p key={`${failure.resourceId || failure.name}-${index}`}>{failure.code || failure.name}：{failure.message}</p>)}</details> : null}
    {(error || host?.error || host?.selectionError) && <p className="error-inline" role="alert">{error || host?.error || host?.selectionError}</p>}
    <div className="replay-sequence" aria-label="已加载历史事件">{positions.map(row => <Button key={`${row.position.streamEpoch}-${row.position.eventSeq}`} className={same(position, row.position) ? 'selected' : ''} disabled={seeking || selecting}
      onClick={() => void seek(row.position)}>#{row.position.eventSeq}</Button>)}{nextOrdinal !== undefined && stream && <Button disabled={selecting} onClick={() => void loadPositions(stream, nextOrdinal)}>后续事件</Button>}</div>
  </div>;
}
