/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { SessionThemeProvider } from '@/renderer/components/theme-provider';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import { fixture as materialFixture, position } from './material-harness';
import { BROWSER_MATERIAL_METHODS } from '@/contracts/browser-materials';

const ticket='a'.repeat(43), token='b'.repeat(43);
const clients: BrowserWorkbenchClient[]=[];
afterEach(()=>{cleanup();clients.forEach(client=>client.disconnect());clients.length=0;localStorage.clear();vi.restoreAllMocks();});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
/** A single user click, only after that exact control is actually actionable.
 * No retries of the click and no reliance on a different component's readiness. */
async function readyControl(find:()=>HTMLElement) {
  let target!:HTMLElement;
  await waitFor(()=>{
    target=find();
    expect(target.isConnected).toBe(true);
    expect(target.matches(':disabled')).toBe(false);
    expect(target.closest('[inert], fieldset[disabled]')).toBeNull();
    for(let element:HTMLElement|null=target;element;element=element.parentElement){
      expect(element.hidden).toBe(false);
      const style=getComputedStyle(element);
      expect(style.display).not.toBe('none');
      expect(['hidden','collapse']).not.toContain(style.visibility);
      expect(style.opacity).not.toBe('0');
      if(element.tagName==='DETAILS'&&!element.hasAttribute('open'))expect(element.querySelector('summary')?.contains(target)).toBe(true);
    }
  });
  return target;
}
const clickReady=async(find:()=>HTMLElement)=>{fireEvent.click(await readyControl(find));};
const clickButton=(name:string|RegExp)=>clickReady(()=>screen.getByRole('button',{name}));
async function fixture(empty=false,grant='project-materials') {
  const domain=await materialFixture({empty});
  let event!:ReadableStreamDefaultController<Uint8Array>, loseEdit=false, losePublish=false, readFailure=false;
  let collectionDelay: (()=>Promise<void>) | undefined;
  let metadataDelay:(()=>Promise<void>)|undefined;
  let recordingsDelay:(()=>Promise<void>)|undefined;
  const invalidate=()=>event.enqueue(new TextEncoder().encode('event: scope-invalidated\ndata: {"projectId":"project"}\n\n'));
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    const envelope=JSON.parse(String(init?.body));
    if(url==='/workbench/session')return json({token,instanceId:'instance',projectId:'project',grant,expiresAt:Date.now()+300_000});
    if(url==='/workbench/events')return new Response(new ReadableStream<Uint8Array>({start(controller){event=controller;}}),{headers:{'content-type':'text/event-stream'}});
    const {method,body}=envelope;
    if(method==='state'){await metadataDelay?.();if(readFailure)throw new Error('connection offline');return json({project:{id:'project',name:'Orders',objective:'Amounts',revision:1}});}
    if(method==='projectExecutions')return json({items:[],returnedBytes:55,outputTruncated:false});
    if(method==='materialRecordings'){await recordingsDelay?.();return json({items:[{recordingId:'recording',sealedAt:'2026-09-30T00:00:00Z'}],returnedBytes:100,outputTruncated:false});}
    if(method==='recordingStreams')return json({items:[{first:position,last:position,events:1,monotonicTime:true}]});
    if(method==='recordingPositions')return json({items:[{position,type:2,source:0}]});
    const result=await domain.call(method,body);
    if(method==='materialCollection'&&body.collection==='checkpoints'&&collectionDelay)await collectionDelay();
    if(method==='editMaterialDraft'&&loseEdit){loseEdit=false;throw new Error('response lost after commit');}
    if(method==='publishMaterialDraft'&&losePublish){losePublish=false;throw new Error('response lost after publish');}
    return json(result);
  });
  const client=new BrowserWorkbenchClient({instanceId:'instance',fetch:fetcher as typeof fetch,retryDelaysMs:[]});clients.push(client);
  const rendered=render(<SessionThemeProvider><App host="browser" client={client}/></SessionThemeProvider>);
  const connect=async()=>{
    fireEvent.change(screen.getByLabelText('一次性配对票据'),{target:{value:ticket}});
    await clickButton('连接合成项目');
    await clickButton('打开项目资料工作区');
    await waitFor(()=>expect((screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(()=>expect(screen.queryByText('读取工作副本')).toBeNull());
  };
  return {...domain,client,fetcher,rendered,connect,delayRecordings:(value?:()=>Promise<void>)=>{recordingsDelay=value;},delayMetadata:(value?:()=>Promise<void>)=>{metadataDelay=value;},domainEvents:()=>{domain.materials.service.onChanged=invalidate;},offline:()=>event.error(new Error('offline')),delayCollections:(value?:()=>Promise<void>)=>{collectionDelay=value;},loseEdit:()=>{loseEdit=true;},losePublish:()=>{losePublish=true;},readFailure:(value:boolean)=>{readFailure=value;},
    invalidate,
    rpc:()=>fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).filter(value=>value.method)};
}
async function selectFirstCard(){await clickButton(/Example 1/);await screen.findByRole('button',{name:'编辑保存点'});}
async function copyCard(){await clickReady(()=>screen.getByText('更多操作'));await clickButton('复制保存点');}
async function archives(){await clickButton('资料存档');await screen.findByRole('button',{name:'保存存档版本'});}

test('shared browser editor uses real selected source, edits fields and plain notes, copies and publishes without native APIs or Web Storage',async()=>{
  const f=await fixture(true), store=vi.spyOn(Storage.prototype,'setItem');await f.connect();
  expect(f.rpc().every(item=>item.method==='state'||BROWSER_MATERIAL_METHODS.includes(item.method))).toBe(true);
  fireEvent.change(await readyControl(()=>screen.getByLabelText('来源录制')),{target:{value:'recording'}});
  await waitFor(()=>expect((screen.getByLabelText('来源文档流') as HTMLSelectElement).options.length).toBe(2));
  fireEvent.change(await readyControl(()=>screen.getByLabelText('来源文档流')),{target:{value:'0'}});
  await waitFor(()=>expect((screen.getByLabelText('来源事件位置') as HTMLSelectElement).options.length).toBe(2));
  fireEvent.change(await readyControl(()=>screen.getByLabelText('来源事件位置')),{target:{value:'0'}});
  await clickButton('新增保存点');
  fireEvent.change(await screen.findByLabelText('标题'),{target:{value:'Browser source card'}});
  await clickButton('完成保存点编辑');
  await screen.findByRole('button',{name:'编辑保存点'});
  let saved=await f.get();expect(saved.content.checkpoints[0].anchor).toEqual(position);
  await clickButton('添加字段');
  fireEvent.change(await screen.findByLabelText('字段名'),{target:{value:'Amount'}});
  fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Displayed amount'}});
  await clickButton('保存字段');
  await screen.findByRole('button',{name:'编辑保存点'});
  await clickButton('添加注释');
  fireEvent.change(await screen.findByLabelText('注释'),{target:{value:'Plain browser note'}});
  expect((screen.getByRole('button',{name:'选择历史元素（可选） · 需回放授权'}) as HTMLButtonElement).disabled).toBe(true);
  await clickButton('保存注释');
  await screen.findByRole('button',{name:'编辑保存点'});
  saved=await f.get();expect(saved.content.fields[0].name).toBe('Amount');expect(saved.content.annotations[0]).toMatchObject({text:'Plain browser note',bindingStatus:'none'});expect(saved.content.annotations[0].target).toBeUndefined();
  await copyCard();await waitFor(async()=>expect((await f.get()).content.checkpoints).toHaveLength(2));
  await archives();await clickButton('保存存档版本');await clickButton('确认保存存档版本');
  await waitFor(()=>expect(f.fixed).toHaveLength(1));expect(f.fixed[0].content.fields[0].name).toBe('Amount');
  expect(f.rpc().every(item=>item.method==='state'||BROWSER_MATERIAL_METHODS.includes(item.method))).toBe(true);expect(store).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(token);expect(document.body.textContent).not.toContain(ticket);
});

test('SSE refresh preserves mounted input and stale disables editing and hotkey writes until authoritative reconnect',async()=>{
  const f=await fixture();await f.connect();await selectFirstCard();await clickButton('编辑保存点');
  const title=await screen.findByLabelText('标题');fireEvent.change(title,{target:{value:'Unsaved browser title'}});
  f.readFailure(true);await act(async()=>f.invalidate());await screen.findByText('资料可能已过时；编辑和保存已暂停，重连后权威回读。');
  expect(title.closest('fieldset[disabled]')).toBeTruthy();expect(title.closest('[inert]')).toBeTruthy();
  const edits=f.rpc().filter(item=>item.method==='editMaterialDraft').length;
  fireEvent.keyDown(window,{key:'s',ctrlKey:true});/* intentional disabled-control probe */fireEvent.click(screen.getByRole('button',{name:'完成保存点编辑'}));
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(edits);
  f.readFailure(false);await clickButton('刷新授权项目');await screen.findByText('资料连接已就绪');
  expect(screen.getByLabelText('标题')).toBe(title);expect((title as HTMLInputElement).value).toBe('Unsaved browser title');
  await clickButton('断开连接并清除资料');expect(screen.queryByLabelText('标题')).toBeNull();expect(f.client.materials.storage.getItem(`bes.editor.project.${f.draft.draftId}`)).toBeNull();
  await f.connect();expect(screen.queryByDisplayValue('Unsaved browser title')).toBeNull();
});

test('a lost edit response is never retried with a new revision and requires explicit result verification',async()=>{
  const f=await fixture();await f.connect();await selectFirstCard();f.loseEdit();
  await copyCard();
  await screen.findByText(/结果待确认：保存请求可能已经完成/);
  expect((await f.get()).content.checkpoints).toHaveLength(3);
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(1);
  fireEvent.keyDown(window,{key:'s',ctrlKey:true});/* intentional disabled-control probe */fireEvent.click(screen.getByRole('button',{name:'复制保存点'}));
  await act(async()=>f.invalidate());expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(1);
  await clickButton('读取服务器结果并核验');
  await clickButton('已核验，放弃旧输入并继续');
  await screen.findByText('已读取当前工作副本；旧请求未重放。请检查内容后继续编辑。');
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(1);
  expect((await f.get()).content.checkpoints).toHaveLength(3);
});

test('a lost publish response retains the exact operation identity across authoritative readback',async()=>{
  const f=await fixture();await f.connect();await archives();f.losePublish();
  await clickButton('保存存档版本');await clickButton('确认保存存档版本');
  await screen.findByRole('button',{name:'恢复上次存档操作'});
  await act(async()=>f.invalidate());
  // The receipt button appears as soon as its ID is retained, even while the
  // catch/status query or connection recovery is still pending.
  await waitFor(()=>{
    expect(f.client.getSnapshot().status).toBe('connected');
    expect(screen.getByRole('button',{name:'恢复上次存档操作'}).matches(':disabled')).toBe(false);
  });
  await clickButton('恢复上次存档操作');
  await screen.findByText(/已保存存档版本/);
  const publications=f.rpc().filter(item=>item.method==='publishMaterialDraft');
  expect(publications).toHaveLength(2);expect(publications[1].body).toEqual(publications[0].body);
  expect(f.fixed[0].revisionId).toBe(f.fixed[1].revisionId);
});


test('an edit during delayed external collection refresh keeps the old input and CAS baseline',async()=>{
  const f=await fixture();await f.connect();await selectFirstCard();await clickButton('编辑保存点');
  const title=await screen.findByLabelText('标题');
  const original=await f.get();
  await f.materials.edit('project',original.draftId,original.draftRevision,[{operation:'upsert',collection:'checkpoints',item:{...original.content.checkpoints[0],title:'External title'}}],'ui');
  let release!:()=>void, entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.delayCollections(async()=>{entered();await gate;});
  await act(async()=>{f.invalidate();await waiting;});
  fireEvent.change(title,{target:{value:'Input typed during refresh'}});
  f.delayCollections(undefined);await act(async()=>release());
  await screen.findByText(/本页输入和原修订保留/);
  expect(screen.getByLabelText('标题')).toBe(title);expect((title as HTMLInputElement).value).toBe('Input typed during refresh');
  await clickButton('完成保存点编辑');
  await screen.findByText('本机恢复输入需要先读取当前修订并核对，尚未保存或发布。');
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(0);
  expect((await f.get()).content.checkpoints[0].title).toBe('External title');
});


test('browser navigation and source controls stay disabled through material write readback',async()=>{
  const f=await fixture();await f.connect();await selectFirstCard();
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  f.delayCollections(async()=>{entered();await gate;});
  await copyCard();await act(async()=>{await waiting;});
  expect((await f.get()).content.checkpoints).toHaveLength(3);
  const navigation=screen.getByRole('button',{name:'资料存档'}),source=screen.getByLabelText('来源录制');
  await waitFor(()=>{expect(navigation.matches(':disabled')).toBe(true);expect(source.matches(':disabled')).toBe(true);});
  fireEvent.click(navigation);expect(document.querySelector('.material-workbench')?.getAttribute('data-view')).toBe('checkpoints');
  f.delayCollections(undefined);await act(async()=>release());
  await waitFor(()=>{expect(navigation.matches(':disabled')).toBe(false);expect(source.matches(':disabled')).toBe(false);});
  await clickButton('资料存档');await screen.findByRole('button',{name:'保存存档版本'});
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(1);
});


test('domain SSE before create response waits for delayed metadata and sets the derived draft current once',async()=>{
  const f=await fixture();await f.connect();await archives();await clickButton('保存存档版本');await clickButton('确认保存存档版本');
  await waitFor(()=>expect(f.fixed).toHaveLength(1));const fixed=f.fixed[0];
  await clickButton('查看固定版本');await screen.findByLabelText('固定版本只读');
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  f.delayMetadata(async()=>{entered();await gate;});f.domainEvents();
  await clickButton('基于此版继续编辑');await act(async()=>{await started;});
  await screen.findByText(/工作副本 .* 已创建，正在设为当前/);
  expect(f.client.getSnapshot().status).toBe('stale');
  expect(f.rpc().filter(item=>item.method==='createMaterialDraft')).toHaveLength(1);
  expect(f.rpc().filter(item=>item.method==='setWorkingMaterialDraft')).toHaveLength(0);
  f.delayMetadata(undefined);await act(async()=>release());
  await screen.findByText('已创建工作副本并设为当前。');
  const creations=f.rpc().filter(item=>item.method==='createMaterialDraft'),selections=f.rpc().filter(item=>item.method==='setWorkingMaterialDraft');
  expect(creations).toHaveLength(1);expect(creations[0].body).toMatchObject({baseRevisionId:fixed.revisionId,operationId:expect.any(String)});
  expect(selections).toHaveLength(1);const current=await f.materials.service.workingDraft('project');
  expect(current.draftId).toBe(selections[0].body.draftId);expect(current.draftId).not.toBe(f.draft.draftId);expect(current.baseRevisionId).toBe(fixed.revisionId);
  expect((await f.materials.service.revision('project',fixed.revisionId,fixed.contentHash)).contentHash).toBe(fixed.contentHash);
  expect(document.querySelector('.material-workbench')?.getAttribute('data-view')).toBe('checkpoints');
});
test('stream loss after a successful create reports partial completion and never sets current',async()=>{
  const f=await fixture();await f.connect();await archives();await clickButton('工作副本');
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  f.delayMetadata(async()=>{entered();await new Promise<void>(()=>{});});f.domainEvents();
  await clickButton('新建工作副本');await act(async()=>{await started;});
  await screen.findByText(/工作副本 .* 已创建，正在设为当前/);
  await act(async()=>f.offline());await screen.findByText(/已创建；尚未设为当前/);
  expect(f.rpc().filter(item=>item.method==='createMaterialDraft')).toHaveLength(1);
  expect(f.rpc().filter(item=>item.method==='setWorkingMaterialDraft')).toHaveLength(0);
  expect((await f.materials.service.workingDraft('project')).draftId).toBe(f.draft.draftId);
});


test('opening and refreshing combined read-only results preserves a dirty material editor without writes',async()=>{
  const f=await fixture(false,'project-workbench');await f.connect();await selectFirstCard();await clickButton('编辑保存点');
  fireEvent.change(await screen.findByLabelText('标题'),{target:{value:'Unsaved material title'}});
  const before=f.rpc().filter(item=>item.method==='editMaterialDraft').length;
  await clickButton('打开只读结果');await screen.findByText(/这个项目尚无实际执行/);
  await clickButton('刷新执行列表');await waitFor(()=>expect(f.rpc().filter(item=>item.method==='projectExecutions')).toHaveLength(2));
  expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Unsaved material title');
  expect(f.rpc().filter(item=>item.method==='editMaterialDraft')).toHaveLength(before);
  expect((await f.get()).content.checkpoints[0].title).toBe('Example 1');
});


test('browser source picker stays unavailable until its initial recording directory is actually loaded',async()=>{
 const f=await fixture(true);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.delayRecordings(()=>gate);await f.connect();
 await waitFor(()=>expect(f.rpc().some(item=>item.method==='materialRecordings')).toBe(true));
 const recording=screen.getByLabelText('来源录制') as HTMLSelectElement;expect(recording.matches(':disabled')).toBe(true);expect(recording.options).toHaveLength(1);
 await act(async()=>release());await waitFor(()=>expect(recording.matches(':disabled')).toBe(false));expect(recording.options).toHaveLength(2);
 fireEvent.change(recording,{target:{value:'recording'}});await waitFor(()=>expect((screen.getByLabelText('来源文档流') as HTMLSelectElement).options).toHaveLength(2));
});
