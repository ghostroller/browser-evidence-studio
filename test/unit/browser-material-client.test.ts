import { afterEach, expect, test, vi } from 'vitest';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import type { BrowserMaterialMethod } from '@/contracts/browser-materials';
const clients:BrowserWorkbenchClient[]=[];
afterEach(()=>{clients.forEach(client=>client.disconnect());clients.length=0;vi.useRealTimers();});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(grant:unknown='project-materials') {
  let result:()=>Promise<Response>=async()=>json({draftId:'draft',draftRevision:1});
  let stream!:ReadableStreamDefaultController<Uint8Array>;
  let read:(()=>Promise<Response>)|undefined;
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    if(url==='/workbench/session')return json({token:'b'.repeat(43),instanceId:'instance',projectId:'project',expiresAt:Date.now()+300_000,...(grant==='legacy'?{}:{grant})});
    if(url==='/workbench/events')return new Response(new ReadableStream<Uint8Array>({start(value){stream=value;}}),{headers:{'content-type':'text/event-stream'}});
    const envelope=JSON.parse(String(init?.body));
    if(envelope.method==='state')return read?read():json({project:{id:'project',name:'Project',objective:'',revision:0}});
    return result();
  });
  const client=new BrowserWorkbenchClient({instanceId:'instance',fetch:fetcher as typeof fetch,retryDelaysMs:[]});clients.push(client);
  return {client,fetcher,connect:()=>client.connect('a'.repeat(43)),result:(value:()=>Promise<Response>)=>{result=value;},offline:()=>stream.error(new Error('offline')),read:(value?:()=>Promise<Response>)=>{read=value;},invalidate:()=>stream.enqueue(new TextEncoder().encode('event: scope-invalidated\ndata: {"projectId":"project"}\n\n')),
    rpc:()=>fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).filter(value=>value.method)};
}
test('material grant is explicit, unknown values reject and legacy sessions remain metadata only',async()=>{
  for(const grant of ['all','',null,{},1]) {const f=await fixture(grant);await expect(f.connect()).rejects.toMatchObject({code:'protocol'});expect(f.rpc()).toHaveLength(0);}
  for(const grant of ['legacy','project-metadata']) {const f=await fixture(grant);await f.connect();await expect(f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'})).rejects.toMatchObject({code:'forbidden'});expect(f.rpc()).toHaveLength(1);}
});
test('narrow material RPC enforces session/project/method and stale write boundary',async()=>{
  const f=await fixture();await f.connect();
  expect('call' in f.client).toBe(false);expect(f.client.nativePresentation).toBeNull();
  await expect(f.client.materialCall('materialDraft',{projectId:'other',draftId:'draft'})).rejects.toMatchObject({code:'forbidden'});
  await expect(f.client.materialCall('seal' as BrowserMaterialMethod,{projectId:'project'})).rejects.toMatchObject({code:'forbidden'});
  await f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'});expect(f.rpc()[1]).toEqual({instanceId:'instance',method:'materialDraft',body:{projectId:'project',draftId:'draft'}});
  f.offline();await vi.waitFor(()=>expect(f.client.getSnapshot().status).toBe('stale'));
  await expect(f.client.materialCall('editMaterialDraft',{projectId:'project',draftId:'draft',expectedDraftRevision:1,edits:[]})).rejects.toMatchObject({code:'unavailable'});expect(f.rpc()).toHaveLength(2);
});
test('material read domain errors do not create metadata rereads or a reconnect loop',async()=>{
  const f=await fixture();await f.connect();const token=f.client.getSnapshot().refreshToken;
  f.result(async()=>json({error:{code:'internal_error'}},500));
  await expect(f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'})).rejects.toMatchObject({code:'internal_error',resultUncertain:false});
  await new Promise(resolve=>setTimeout(resolve,40));
  expect(f.rpc()).toHaveLength(2);expect(f.client.getSnapshot()).toMatchObject({status:'connected',refreshToken:token});
});
test('material read network failure pauses writes without automatically retrying the read',async()=>{
  const f=await fixture();await f.connect();f.result(async()=>{throw new Error('offline');});
  await expect(f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'})).rejects.toMatchObject({code:'network',resultUncertain:false});
  await new Promise(resolve=>setTimeout(resolve,40));expect(f.rpc()).toHaveLength(2);expect(f.client.getSnapshot().status).toBe('stale');
});
test('a dropped edit response is flagged unknown and never automatically retried',async()=>{
  const f=await fixture();await f.connect();f.result(async()=>{throw new Error('lost response');});
  const input={projectId:'project',draftId:'draft',expectedDraftRevision:1,edits:[]};
  await expect(f.client.materialCall('editMaterialDraft',input)).rejects.toMatchObject({code:'network',resultUncertain:true});
  await vi.waitFor(()=>expect(f.client.getSnapshot().status).toBe('connected'));
  expect(f.rpc().filter(value=>value.method==='editMaterialDraft')).toEqual([{instanceId:'instance',method:'editMaterialDraft',body:input}]);
});
test('disconnect and revocation erase session input recovery and late result cannot return',async()=>{
  const f=await fixture();await f.connect();f.client.materials.storage.setItem('private-input','private text');
  let resolve!:(value:Response)=>void;f.result(()=>new Promise(done=>{resolve=done;}));
  const pending=f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'});f.client.disconnect();resolve(json({draftId:'draft',private:'old result'}));
  await expect(pending).rejects.toMatchObject({code:'cancelled'});expect(f.client.materials.storage.getItem('private-input')).toBeNull();expect(f.client.getSnapshot().state).toBeNull();
  await f.connect();f.client.materials.storage.setItem('private-input','new private text');f.result(async()=>json({error:{code:'unauthorized'}},401));
  await expect(f.client.materialCall('materialDraft',{projectId:'project',draftId:'draft'})).rejects.toMatchObject({code:'unauthorized'});expect(f.client.materials.storage.getItem('private-input')).toBeNull();expect(f.client.getSnapshot().state).toBeNull();
});

for(const method of ['materialCatalog','materialDrafts','materialRevisions','workingMaterialDraft'] as const) {
  test(`${method} ensure/repair read failure cannot recursively trigger metadata refresh`,async()=>{
    const f=await fixture();await f.connect();f.result(async()=>{throw new Error('directory response lost');});
    await expect(f.client.materialCall(method,{projectId:'project'})).rejects.toMatchObject({code:'network',resultUncertain:false});
    await new Promise(resolve=>setTimeout(resolve,40));expect(f.rpc()).toHaveLength(2);expect(f.client.getSnapshot().status).toBe('stale');
  });
}

const metadata=()=>json({project:{id:'project',name:'Project',objective:'',revision:0}});
async function staleAcknowledgement() {
  const f=await fixture();await f.connect();
  let release!:(value:Response)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.read(()=>{entered();return new Promise(resolve=>{release=resolve;});});
  f.result(async()=>{f.invalidate();await started;return json({draftId:'created',draftRevision:0});});
  const input={projectId:'project',operationId:'same-create'};
  const ack=await f.client.materialCall('createMaterialDraft',input);
  expect(f.client.getSnapshot().status).toBe('stale');
  return {...f,ack,release:(value=metadata())=>release(value)};
}
test('SSE before successful create response waits for its existing authoritative read without replaying the write',async()=>{
  const f=await staleAcknowledgement();let settled=false;
  const ready=f.client.waitAfterMaterialWrite(f.ack).then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);
  await expect(f.client.materialCall('setWorkingMaterialDraft',{projectId:'project',draftId:'created'})).rejects.toMatchObject({code:'unavailable'});
  expect(f.rpc().filter(value=>value.method==='state')).toHaveLength(2);
  f.result(async()=>json({draftId:'created',draftRevision:0}));f.release();await ready;
  await f.client.materialCall('setWorkingMaterialDraft',{projectId:'project',draftId:'created'});
  expect(f.rpc().filter(value=>value.method==='createMaterialDraft')).toHaveLength(1);
  expect(f.rpc().filter(value=>value.method==='setWorkingMaterialDraft')).toHaveLength(1);
  expect(f.ack).toEqual({draftId:'created',draftRevision:0});
});
test('stream loss cancels an acknowledged continuation without replay, even if its metadata read later succeeds',async()=>{
  const f=await staleAcknowledgement();const ready=f.client.waitAfterMaterialWrite(f.ack);
  f.offline();await expect(ready).rejects.toMatchObject({code:'unavailable'});f.release();
  await Promise.resolve();expect(f.rpc().filter(value=>value.method==='createMaterialDraft')).toHaveLength(1);
  expect(f.rpc().some(value=>value.method==='setWorkingMaterialDraft')).toBe(false);
});
test('a new session cannot continue an old acknowledged write',async()=>{
  const f=await staleAcknowledgement();const ready=f.client.waitAfterMaterialWrite(f.ack);
  f.client.disconnect();await expect(ready).rejects.toMatchObject({code:'cancelled'});f.read();await f.connect();f.release();
  await expect(f.client.waitAfterMaterialWrite(f.ack)).rejects.toMatchObject({code:'cancelled'});
  expect(f.rpc().some(value=>value.method==='setWorkingMaterialDraft')).toBe(false);
});
test('readiness timeout preserves the successful ack and does not retry writes or poll metadata',async()=>{
  const f=await staleAcknowledgement();vi.useFakeTimers();
  const ready=expect(f.client.waitAfterMaterialWrite(f.ack)).rejects.toMatchObject({code:'unavailable'});
  await vi.advanceTimersByTimeAsync(5000);await ready;
  expect(f.ack).toEqual({draftId:'created',draftRevision:0});
  expect(f.rpc().filter(value=>value.method==='state')).toHaveLength(2);
  expect(f.rpc().filter(value=>value.method==='createMaterialDraft')).toHaveLength(1);f.release();
});
test('revoked authoritative read stops the continuation but cannot turn a successful ack into a failed create',async()=>{
  const f=await staleAcknowledgement();const ready=f.client.waitAfterMaterialWrite(f.ack);
  f.release(json({error:{code:'unauthorized'}},401));await expect(ready).rejects.toMatchObject({code:'cancelled'});
  expect(f.ack.draftId).toBe('created');expect(f.client.getSnapshot().status).toBe('expired');
  expect(f.rpc().some(value=>value.method==='setWorkingMaterialDraft')).toBe(false);
});
