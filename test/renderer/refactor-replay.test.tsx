/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReplayWorkspace } from '@/renderer/components/replay-workspace';
import type { ReplayPosition } from '@/contracts/recording';

const at = (eventSeq: number): ReplayPosition => ({ recordingId: 'run-one', pageId: 'page-one', documentId: 'document-one', streamEpoch: 'epoch-one', sourceTimeMs: 1000 + eventSeq, eventSeq });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }
const host = (position: ReplayPosition, generation: number) => ({ replayId: 'replay-one', projectId: 'project-one', generation, status: 'ready', selecting: false, selectionSequence: 0,
  position, state: { position, reliability: 'reliable', gaps: [], viewport: { width: 800, height: 600, deviceScaleFactor: 1 } } });
afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });

test('opens the first complete snapshot when a stream begins with a meta event', async () => {
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingForeground') return { status: 'legacy', items: [] };
    if (method === 'recordingStreams') return { items: [{ first: at(0), last: at(1), events: 2, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: [{ position: at(0), type: 4, source: -1 }, { position: at(1), type: 2, source: -1 }] };
    if (method === 'openReplay') return host(body.position, 1);
    if (method === 'replayStatus' || method === 'selectReplay') return host(at(1), 1);
    if (method === 'closeReplay') return { ...host(at(1), 1), status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={at(0)} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('openReplay', expect.objectContaining({ position: at(1) })));
});

test('closes a native replay host that opens after the workspace unmounts', async () => {
  const opening = deferred<ReturnType<typeof host>>();
  const call = vi.fn(async (method: string, _body?:any) => {
    if (method === 'recordingForeground') return { status: 'legacy', items: [] };
    if (method === 'recordingStreams') return { items: [{ first: at(1), last: at(1), events: 1, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: [{ position: at(1), type: 2, source: -1 }] };
    if (method === 'openReplay') return opening.promise;
    if (method === 'closeReplay') return { ...host(at(1), 1), status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const view = render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={at(1)} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('openReplay', expect.anything()));
  const openingId=call.mock.calls.find(args=>args[0]==='openReplay')?.[1]?.replayId;
  expect(openingId).toMatch(/^[a-f0-9-]{36}$/);
  view.unmount();
  expect(call).toHaveBeenCalledWith('closeReplay',expect.objectContaining({replayId:openingId}));
  await act(async () => opening.resolve(host(at(1), 1)));
  await waitFor(() => expect(call).toHaveBeenCalledWith('closeReplay', expect.objectContaining({ replayId: 'replay-one' })));
});

test('playback delegates a bounded continuous segment to the native host without seeking per event', async () => {
  const positions = [at(1), { ...at(2), sourceTimeMs: 5001 }, { ...at(3), sourceTimeMs: 5001 }];
  let current: ReturnType<typeof host> & { playing?: boolean } = host(positions[0], 1);
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingForeground') return { status: 'legacy', items: [] };
    if (method === 'recordingStreams') return { items: [{ first: positions[0], last: positions[2], events: 3, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: positions.map((position, index) => ({ position, type: index ? 3 : 2, source: index ? 0 : -1 })) };
    if (method === 'openReplay') return current;
    if (method === 'playReplay') { current = { ...host(positions[0], current.generation + 1), playing: true }; return current; }
    if (method === 'pauseReplay') { current = { ...current, playing: false }; return current; }
    if (method === 'replayStatus' || method === 'selectReplay') return current;
    if (method === 'closeReplay') return { ...current, status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={positions[0]} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async () => screen.getByRole('button', { name: '播放' }).click());
  await waitFor(() => expect(call).toHaveBeenCalledWith('playReplay',expect.objectContaining({endPosition:positions[2],speed:1})));
  await act(async () => { current={...host(positions[1],current.generation),playing:true};await new Promise(resolve=>setTimeout(resolve,240)); });
  expect(screen.getByText(/event #2/)).toBeTruthy();
  await act(async () => { current={...host(positions[2],current.generation),playing:false};await new Promise(resolve=>setTimeout(resolve,240)); });
  expect(screen.getByText(/event #3/)).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === 'seekReplay')).toHaveLength(0);
});

test('continuous playback crosses a full snapshot boundary and resumes the next segment', async () => {
  const rows = [1,2,3,4].map(index => ({ position: at(index), type: index === 1 || index === 3 ? 2 : 3, source: index === 1 || index === 3 ? -1 : 0 }));
  let current: ReturnType<typeof host> & { playing?: boolean } = host(at(1),1);
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingForeground') return { status: 'legacy', items: [] };
    if (method === 'recordingStreams') return { items: [{ first: at(1), last: at(4), events: 4, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: rows };
    if (method === 'openReplay') return current;
    if (method === 'playReplay') { current = { ...host(current.position!, current.generation + 1), playing: true }; return current; }
    if (method === 'seekReplay') { current = host(body.position, current.generation + 1); return current; }
    if (method === 'replayStatus' || method === 'selectReplay') return current;
    if (method === 'closeReplay') return { ...current, status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={at(1)} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async () => screen.getByRole('button', { name: '播放' }).click());
  await waitFor(() => expect(call).toHaveBeenCalledWith('playReplay', expect.objectContaining({ endPosition: at(2) })));
  await act(async () => { current = { ...host(at(2), current.generation), playing: false }; await new Promise(resolve => setTimeout(resolve,240)); });
  await waitFor(() => expect(call).toHaveBeenCalledWith('seekReplay', expect.objectContaining({ position: at(3) })));
  await waitFor(() => expect(call).toHaveBeenCalledWith('playReplay', expect.objectContaining({ endPosition: at(4) })));
});

test('a full snapshot boundary keeps its source-time gap until the user skips idle time',async()=>{
  const first=at(1),before={...at(2),sourceTimeMs:1010},after={...at(3),sourceTimeMs:1210},last={...at(4),sourceTimeMs:1220};
  const rows=[first,before,after,last].map((position,index)=>({position,type:index===0||index===2?2:3,source:index===0||index===2?-1:0}));
  let current={...host(first,1),playing:false};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='recordingForeground')return {status:'legacy',items:[]};
    if(method==='recordingStreams')return {items:[{first,last,events:4,monotonicTime:true}]};
    if(method==='recordingPositions')return {items:rows};
    if(method==='openReplay')return current;
    if(method==='playReplay'){current={...host(current.position!,current.generation+1),playing:true};return current;}
    if(method==='seekReplay'){current={...host(body.position,current.generation+1),playing:false};return current;}
    if(method==='pauseReplay'){current={...current,playing:false};return current;}
    if(method==='replayStatus'||method==='selectReplay')return current;
    if(method==='closeReplay')return {...current,status:'closed'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async()=>screen.getByRole('button',{name:'播放'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('playReplay',expect.objectContaining({endPosition:before})));
  await act(async()=>{current={...host(before,current.generation),playing:false};await new Promise(resolve=>setTimeout(resolve,240));});
  expect(screen.getByText(/源时间空档/)).toBeTruthy();
  expect(call.mock.calls.filter(([method])=>method==='seekReplay')).toHaveLength(0);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('seekReplay',expect.objectContaining({position:after})));
  expect(screen.getByText(/event #3/)).toBeTruthy();
  expect(screen.getByRole('checkbox',{name:'跳过空闲'})).toBeTruthy();
});

test('explicit idle skip crosses a long same-stream gap without changing source position',async()=>{
  const first={...at(1),sourceTimeMs:1000},before={...at(2),sourceTimeMs:1010};
  const after={...at(3),sourceTimeMs:7010},last={...at(4),sourceTimeMs:7020};
  const rows=[first,before,after,last].map((position,index)=>({position,type:index?3:2,source:index?0:-1}));
  let current={...host(first,1),playing:false};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='recordingForeground')return {status:'legacy',items:[]};
    if(method==='recordingStreams')return {items:[{first,last,events:4,monotonicTime:true}]};
    if(method==='recordingPositions')return {items:rows};
    if(method==='openReplay')return current;
    if(method==='playReplay'){current={...host(current.position!,current.generation+1),playing:true};return current;}
    if(method==='seekReplay'){current={...host(body.position,current.generation+1),playing:false};return current;}
    if(method==='replayStatus'||method==='selectReplay')return current;
    if(method==='closeReplay')return {...current,status:'closed'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  const onPosition=vi.fn();
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={first} selecting={false} canStop={false}
    onPosition={onPosition} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async()=>screen.getByRole('checkbox',{name:'跳过空闲'}).click());
  await act(async()=>screen.getByRole('button',{name:'播放'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('playReplay',expect.objectContaining({endPosition:before})));
  await act(async()=>{current={...host(before,current.generation),playing:false};await new Promise(resolve=>setTimeout(resolve,240));});
  await waitFor(()=>expect(call).toHaveBeenCalledWith('seekReplay',expect.objectContaining({position:after})));
  expect(onPosition.mock.calls.at(-1)?.[0]).toEqual(after);
});

test('pausing during a source-time boundary wait prevents the later seek',async()=>{
  const first={...at(1),sourceTimeMs:1000},before={...at(2),sourceTimeMs:1010};
  const after={...at(3),sourceTimeMs:1510};
  const rows=[first,before,after].map((position,index)=>({position,type:index===0||index===2?2:3,source:index===1?0:-1}));
  let current={...host(first,1),playing:false};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='recordingForeground')return {status:'legacy',items:[]};
    if(method==='recordingStreams')return {items:[{first,last:after,events:3,monotonicTime:true}]};
    if(method==='recordingPositions')return {items:rows};
    if(method==='openReplay')return current;
    if(method==='playReplay'){current={...host(current.position!,current.generation+1),playing:true};return current;}
    if(method==='pauseReplay'){current={...current,playing:false};return current;}
    if(method==='seekReplay'){current={...host(body.position,current.generation+1),playing:false};return current;}
    if(method==='replayStatus'||method==='selectReplay')return current;
    if(method==='closeReplay')return {...current,status:'closed'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={first} selecting={false} canStop={false}
    onPosition={vi.fn()} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async()=>screen.getByRole('button',{name:'播放'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('playReplay',expect.objectContaining({endPosition:before})));
  await act(async()=>{current={...host(before,current.generation),playing:false};await new Promise(resolve=>setTimeout(resolve,240));});
  await waitFor(()=>expect(screen.getByText(/源时间空档/)).toBeTruthy());
  await act(async()=>screen.getByRole('button',{name:'暂停'}).click());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550));});
  expect(call.mock.calls.filter(([method])=>method==='seekReplay')).toHaveLength(0);
});

test('recorded foreground transition follows the selected page and retains its source identity',async()=>{
  const first={...at(1),sourceTimeMs:1000},end={...at(2),sourceTimeMs:1100};
  const pageB={...at(1),pageId:'page-b',documentId:'document-b',streamEpoch:'epoch-b',sourceTimeMs:1200};
  const pageBEnd={...pageB,eventSeq:2,sourceTimeMs:1210};
  const foreground={status:'recorded',items:[
    {sequence:1,pageId:'page-one',observedAtMs:900,transitionOrdinal:1,reason:'initial'},
    {sequence:2,pageId:'page-b',observedAtMs:1150,transitionOrdinal:2,reason:'selected'}]};
  let current={...host(first,1),playing:false};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='recordingForeground')return foreground;
    if(method==='recordingStreams')return {items:[{first,last:end,events:2,monotonicTime:true},{first:pageB,last:pageBEnd,events:2,monotonicTime:true}]};
    if(method==='recordingPositions')return {items:body.position.pageId==='page-b'?
      [{position:pageB,type:2,source:-1},{position:pageBEnd,type:3,source:0}]:
      [{position:first,type:2,source:-1},{position:end,type:3,source:0}]};
    if(method==='openReplay')return current;
    if(method==='playReplay'){current={...host(current.position!,current.generation+1),playing:true};return current;}
    if(method==='seekReplay'){current={...host(body.position,current.generation+1),playing:false};return current;}
    if(method==='replayStatus'||method==='selectReplay')return current;
    if(method==='closeReplay')return {...current,status:'closed'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  const onPosition=vi.fn();
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={first} selecting={false} canStop={false}
    onPosition={onPosition} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(()=>expect(call).toHaveBeenCalledWith('recordingForeground',expect.anything()));
  await waitFor(()=>expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async()=>screen.getByRole('button',{name:'播放'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('playReplay',expect.objectContaining({endPosition:end})));
  await act(async()=>{current={...host(end,current.generation),playing:false};await new Promise(resolve=>setTimeout(resolve,240));});
  await waitFor(()=>expect(call).toHaveBeenCalledWith('seekReplay',expect.objectContaining({position:pageB})));
  expect(onPosition.mock.calls.at(-1)?.[0]).toEqual(pageB);
});

test('an older playing status cannot replace a completed pause in the same generation', async () => {
  const positions=[at(1),at(2),at(3)],lateStatus=deferred<ReturnType<typeof host> & {playing:boolean;commandSequence:number}>();
  let current={...host(at(1),1),playing:false,commandSequence:1};
  let held=false;
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='recordingForeground')return {status:'legacy',items:[]};
    if(method==='recordingStreams')return {items:[{first:positions[0],last:positions[2],events:3,monotonicTime:true}]};
    if(method==='recordingPositions')return {items:positions.map((position,index)=>({position,type:index?3:2,source:index?0:-1}))};
    if(method==='openReplay')return current;
    if(method==='playReplay'){current={...host(at(1),2),playing:true,commandSequence:2};return current;}
    if(method==='pauseReplay'){current={...current,playing:false,commandSequence:3};return current;}
    if(method==='replayStatus'){
      if(current.playing&&!held){held=true;return lateStatus.promise;}
      return current;
    }
    if(method==='selectReplay')return current;
    if(method==='closeReplay')return {...current,status:'closed'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  const onPosition=vi.fn();
  render(<ReplayWorkspace projectId="project-one" recordingId="run-one" requestedPosition={at(1)} selecting={false} canStop={false}
    onPosition={onPosition} onTarget={vi.fn()} onSelectionReady={vi.fn()} onCancelSelection={vi.fn()} onStop={vi.fn()} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText(/event #1/)).toBeTruthy());
  await act(async()=>screen.getByRole('button',{name:'播放'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('playReplay',expect.anything()));
  await waitFor(()=>expect(held).toBe(true));
  await act(async()=>screen.getByRole('button',{name:'暂停'}).click());
  await waitFor(()=>expect(call).toHaveBeenCalledWith('pauseReplay',expect.anything()));
  await act(async()=>lateStatus.resolve({...host(at(2),2),playing:true,commandSequence:2}));
  expect(screen.getByText(/event #1/)).toBeTruthy();
  expect(onPosition.mock.calls.at(-1)?.[0]).toEqual(at(1));
});

test('an older seek response cannot replace a newer exact event position', async () => {
  const second = deferred<ReturnType<typeof host>>();
  const third = deferred<ReturnType<typeof host>>();
  let current = host(at(1), 1);
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'recordingForeground') return { status: 'legacy', items: [] };
    if (method === 'recordingStreams') return { items: [{ first: at(1), last: at(3), events: 3, monotonicTime: true }] };
    if (method === 'recordingPositions') return { items: [1, 2, 3].map(index => ({ position: at(index), type: index === 1 ? 2 : 3, source: index === 1 ? -1 : 0 })) };
    if (method === 'openReplay') return current;
    if (method === 'seekReplay') return body.position.eventSeq === 2 ? second.promise : third.promise;
    if (method === 'replayStatus') return current;
    if (method === 'selectReplay') return current;
    if (method === 'closeReplay') return { ...current, status: 'closed' };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const onPosition = vi.fn();
  const props = { projectId: 'project-one', recordingId: 'run-one', selecting: false, canStop: false, onPosition, onTarget: vi.fn(), onSelectionReady:vi.fn(), onCancelSelection: vi.fn(), onStop: vi.fn(), onClose: vi.fn() };
  const view = render(<ReplayWorkspace {...props} requestedPosition={at(1)} />);
  await waitFor(() => expect(screen.getByText(/event #1/)).toBeTruthy());
  view.rerender(<ReplayWorkspace {...props} requestedPosition={at(2)} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('seekReplay', expect.objectContaining({ position: at(2) })));
  view.rerender(<ReplayWorkspace {...props} requestedPosition={at(3)} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith('seekReplay', expect.objectContaining({ position: at(3) })));
  await act(async () => { current = host(at(3), 3); third.resolve(current); });
  await waitFor(() => expect(screen.getByText(/event #3/)).toBeTruthy());
  await act(async () => second.resolve(host(at(2), 2)));
  expect(screen.getByText(/event #3/)).toBeTruthy();
  expect(onPosition.mock.calls.at(-1)?.[0]).toEqual(at(3));
});
