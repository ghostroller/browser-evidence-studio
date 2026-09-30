import React, { useEffect, useRef, useState } from 'react';
import type { WebReplayBundle, WebReplayClient } from '@/contracts/web-replay';
import { sameReplayPosition, type ReplayPosition } from '@/contracts/recording';
import type { SelectionRequest, SelectionReceipt } from '../selection-session';
import { Button } from './ui/button';
import { Label } from './ui/label';
/** Trusted controls own source identities. The separate-origin document receives
 * only a bounded presentation copy, never the HTTP client or its credentials. */
export function SharedWebReplay({ client, projectId, instanceId, origin, position, request, readable, onPosition, onSelection, onClose }: {
  client: WebReplayClient; projectId: string; instanceId: string; origin: string; position: ReplayPosition;
  request?: SelectionRequest | null; readable: boolean;
  onPosition(position: ReplayPosition): void; onSelection(receipt: SelectionReceipt): void; onClose(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null), replayId = useRef(crypto.randomUUID()), lastSelection = useRef(''), reads = useRef(new Set<AbortController>());
  const active = useRef({ generation: 0, command: 0, sequence: 0, alive: true, selecting: false, ready: false, pending: null as SelectionRequest | null, bundle: null as WebReplayBundle | null });
  const [boot, setBoot] = useState(0), [status, setStatus] = useState('正在打开隔离回放'), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [ready, setReady] = useState(false), [diagnostics, setDiagnostics] = useState<string[]>([]), [bundle, setBundle] = useState<WebReplayBundle | null>(null);
  const callbacks = useRef({ onPosition, onSelection }); callbacks.current = { onPosition, onSelection };
  const send = (type: string, values: Record<string, unknown> = {}) => {
    const state = active.current;
    if (!state.alive || !readable) return;
    frame.current?.contentWindow?.postMessage({ type, instanceId, replayId: replayId.current, generation: state.generation, command: ++state.command, ...values }, origin);
  };
  useEffect(() => {
    active.current.alive = true;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin || !readable || !active.current.alive) return;
      const data = event.data;
      if (!data || data.instanceId !== instanceId) return;
      if (data.type === 'boot') { active.current.sequence = 0; active.current.ready = false; active.current.bundle = null; ++active.current.generation; setReady(false); setBoot(value => value + 1); return; }
      const state = active.current;
      if (data.replayId !== replayId.current || data.generation !== state.generation || data.command !== state.command || !Number.isSafeInteger(data.sequence) || data.sequence <= state.sequence) return;
      state.sequence = data.sequence;
      const loaded = state.bundle;
      if (!loaded) return;
      if (['ready', 'state', 'selection'].includes(data.type)) {
        if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index >= loaded.offsets.length || !data.position || !sameReplayPosition(data.position, loaded.offsets[data.index].position)) return;
      }
      if (data.type === 'ready' || data.type === 'state') {
        state.ready = true; setReady(true); setIndex(data.index); setPlaying(data.playing === true); callbacks.current.onPosition(loaded.offsets[data.index].position);
        setStatus(data.playing ? '正在播放已封存历史' : '已暂停在精确来源事件');
        if (data.type === 'ready') {
          if (Array.isArray(data.failures) && data.failures.length) setDiagnostics(previous => [...previous, ...data.failures.slice(0, 64).map((item: unknown) => typeof item === 'string' ? item.slice(0, 256) : '归档呈现未能确认')]);
          if (state.pending && sameReplayPosition(state.pending.anchor, loaded.offsets[data.index].position)) { state.selecting = true; send('select', { selectionId: state.pending.selectionId }); }
        }
      } else if (data.type === 'selecting') setStatus('点选历史元素；Escape 退出');
      else if (data.type === 'selection-cancelled') { state.pending = null; state.selecting = false; setStatus('已退出历史选择'); }
      else if (data.type === 'selection-error') setStatus('此位置没有可核验的源节点，请重选');
      else if (data.type === 'error') { state.ready = false; state.pending = null; setReady(false); setStatus('历史重建失败；请关闭后重开，不会从网络补全'); }
      else if (data.type === 'selection') {
        const pending = state.pending;
        if (!state.ready || !state.selecting || !pending || data.selectionId !== pending.selectionId || !sameReplayPosition(pending.anchor, data.position) || !Number.isSafeInteger(data.nodeId) || data.nodeId < 0) return;
        state.pending = null; state.selecting = false; setStatus('正在核验原始源节点');
        const generation = state.generation, command = state.command, abort = new AbortController(); reads.current.add(abort);
        void client.call('webReplaySelection', { projectId, replayId: replayId.current, generation, position: pending.anchor, nodeId: data.nodeId }, abort.signal).then(result => {
          if (!active.current.alive || active.current.generation !== generation || active.current.command !== command || result.replayId !== replayId.current || result.generation !== generation || result.projectId !== projectId || !sameReplayPosition(result.position, pending.anchor) || !sameReplayPosition(result.target.position, pending.anchor) || result.target.nodeId !== data.nodeId) return;
          callbacks.current.onSelection({ request: pending, target: result.target, replayId: result.replayId, generation });
          send('cancel-selection'); setStatus(`已核验源节点 ${result.target.nodeId}；请在资料编辑器保存字段`);
        }).catch(() => { if (active.current.alive && active.current.generation === generation && active.current.command === command) { send('cancel-selection'); setStatus('源节点核验失败；未绑定字段，请重新选择'); } }).finally(() => reads.current.delete(abort));
      }
    };
    window.addEventListener('message', receive);
    return () => { const state = active.current; state.alive = false; ++state.generation; state.pending = null; state.bundle = null; for (const read of reads.current) read.abort(); reads.current.clear(); window.removeEventListener('message', receive); };
  }, [client, projectId, instanceId, origin, readable]);
  const positionKey = JSON.stringify(position);
  useEffect(() => { if (readable) frame.current?.closest('section')?.scrollIntoView?.({ block: 'start', behavior: 'instant' }); }, [positionKey, request?.selectionId, readable]);
  useEffect(() => {
    const state = active.current; const generation = ++state.generation;
    state.ready = false; state.selecting = false; state.pending = request ?? null; state.bundle = null;
    setReady(false); setPlaying(false); setBundle(null); setDiagnostics([]);
    if (!readable || !boot) return;
    state.pending = request && lastSelection.current !== request.selectionId ? request : null;
    if (state.pending) lastSelection.current = state.pending.selectionId;
    setStatus('正在读取已封存历史窗口');
    const abort = new AbortController(); reads.current.add(abort);
    void client.call('webReplayBundle', { projectId, replayId: replayId.current, generation, position }, abort.signal).then(result => {
      if (!active.current.alive || active.current.generation !== generation || result.replayId !== replayId.current || result.generation !== generation || result.projectId !== projectId || !sameReplayPosition(result.position, position)) return;
      state.bundle = result; setBundle(result); setDiagnostics(result.diagnostics.map(item => `${item.status} · ${item.reason}`));
      send('load', { bundle: result });
    }).catch(() => { if (active.current.alive && active.current.generation === generation) setStatus('历史读取失败或超过预算；请关闭后重开，不会从网络补全'); }).finally(() => reads.current.delete(abort));
    return () => { abort.abort(); if (active.current.generation === generation) { ++active.current.generation; active.current.pending = null; } };
  }, [client, projectId, positionKey, request?.selectionId, readable, boot]);
  const cancelSelection = () => { active.current.pending = null; active.current.selecting = false; };
  const close = () => { active.current.alive = false; ++active.current.generation; active.current.pending = null; active.current.bundle = null; for (const read of reads.current) read.abort(); reads.current.clear(); onClose(); };
  return <section className="shared-web-replay form-stack" aria-label="隔离历史回放" data-replay-id={replayId.current} data-generation={active.current.generation} data-ready={ready}>
    <h3>隔离历史回放</h3><p role="status">{status}</p>
    <p>只读已封存来源；当前窗口截至事件 #{position.eventSeq}。资源缺失、损坏或超限均不访问原网站。</p>
    <div className="button-row"><Button disabled={!ready || !readable || index === 0} onClick={() => { cancelSelection(); setReady(false); send('seek', { index: 0 }); }}>定位窗口起点</Button><Button disabled={!ready || !readable || playing || !!request && active.current.selecting} onClick={() => { cancelSelection(); send('play'); }}>播放历史</Button><Button disabled={!ready || !readable || !playing} onClick={() => send('pause')}>暂停历史</Button><Button onClick={close}>关闭历史回放</Button></div>
    <Label>精确来源事件<input aria-label="精确来源事件" type="range" min="0" max={Math.max(0, (bundle?.offsets.length ?? 1) - 1)} value={index} disabled={!ready || !readable} onChange={event => { cancelSelection(); setReady(false); send('seek', { index: Number(event.target.value) }); }}/></Label>
    {bundle?.offsets[index] && <p>事件 #{bundle.offsets[index].position.eventSeq} · {bundle.offsets[index].position.documentId}</p>}
    {diagnostics.length > 0 && <details><summary>归档资源诊断 · {diagnostics.length}</summary>{diagnostics.map((item, at) => <p key={at}>{item}</p>)}</details>}
    {readable && <iframe ref={frame} src={`${origin}/replay.html`} title="只读隔离历史文档" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ width: '100%', height: 480, border: '1px solid var(--border)' }}/>}
  </section>;
}
