import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { childEnvironment, lockNodeWorkspace, chromiumExecutable } from '@/node/environment';
import { ChromiumPresentation, type ChromiumView } from '@/node/chromium-presentation';
import { NodeOwnerServer } from '@/node/owner-server';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();});
test('Node children receive an explicit environment without inherited credentials or injection',()=>{
  expect(childEnvironment({PATH:'/bin',HOME:'/home/test',DISPLAY:':2',OPENAI_API_KEY:'synthetic-secret',HTTP_PROXY:'synthetic-proxy',NODE_OPTIONS:'--require bad.js',BES_WORKBENCH_TOKEN:'synthetic-token'})).toEqual({PATH:'/bin',HOME:'/home/test',DISPLAY:':2'});
});
test('workspace has a single OS-owned writer, survives normal reopen, and never adopts Electron data',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bes-node-lock-'));
  const first=await lockNodeWorkspace(root);await expect(lockNodeWorkspace(root)).rejects.toThrow('already open');
  await first.close();const second=await lockNodeWorkspace(root);cleanups.push(()=>second.close());
  expect(JSON.parse(await readFile(path.join(root,'node-workbench.json'),'utf8'))).toMatchObject({provider:'chromium',schemaVersion:1});
  const old=await mkdtemp(path.join(tmpdir(),'bes-electron-data-'));await writeFile(path.join(old,'workspace.json'),'original');
  await expect(lockNodeWorkspace(old)).rejects.toThrow();expect(await readFile(path.join(old,'workspace.json'),'utf8')).toBe('original');
});
test('executable resolver fails explicitly for missing executable',async()=>{await expect(chromiumExecutable('/definitely-missing-chromium')).rejects.toThrow();});
test('input barriers await acknowledgement, fail closed, and retired views cannot poison a reopened session',async()=>{
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});let first=true,closed=false;
  const p=new ChromiumPresentation(),view={page:{isClosed:()=>closed,close:async()=>{closed=true;}},cdp:{send:async()=>{if(first){first=false;await gate;}else throw new Error('target gone');}}} as unknown as ChromiumView;
  p.add(view);p.lock(true);let settled=false;const waiting=p.awaitInput().then(()=>{settled=true;},()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);finish();await waiting;
  await expect(p.awaitInput()).rejects.toThrow('ownership');p.remove(view);
  const fresh={page:{isClosed:()=>false,close:async()=>{}},cdp:{send:async()=>{}}} as unknown as ChromiumView;p.add(fresh);await expect(p.awaitInput()).resolves.toBeUndefined();
});
test('owner transport requires exact origin/instance, one-use ticket and strict allowlisted schemas',async()=>{
  const instanceId='node-test-instance',origin='http://127.0.0.1:44444';let writes=0,cancellations=0,revocations=0;
  const studio={instanceId,cancelOwnerOperations:async()=>{cancellations++;},serialized:async(fn:()=>unknown)=>fn(),ownerOperation:async(fn:()=>unknown)=>fn(),createProject:async()=>{writes++;return {id:'created'};}} as any;
  const owner=new NodeOwnerServer({studio,origin,pairing:{revoke:()=>{revocations++;}} as any,shutdown:async()=>{}});const {port}=await owner.start();cleanups.push(()=>owner.dispose());
  const ticket=await owner.ticket();
  const send=(route:string,body:unknown,token?:string,override:Record<string,string>={})=>fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json',origin,'x-workbench-instance':instanceId,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty',...(token?{authorization:`Bearer ${token}`}:{ }),...override},body:JSON.stringify(body)});
  expect((await send('/owner/session',{instanceId,ticket:ticket.ticket},undefined,{origin:'http://evil.invalid'})).status).toBe(403);
  const exchange=await send('/owner/session',{instanceId,ticket:ticket.ticket});expect(exchange.status).toBe(200);const auth=await exchange.json() as {token:string};
  expect((await send('/owner/session',{instanceId,ticket:ticket.ticket})).status).toBe(401);
  expect((await send('/owner/rpc',{instanceId,method:'dispatch',body:{}},auth.token)).status).toBe(400);
  expect((await send('/owner/rpc',{instanceId,method:'createProject',body:{name:'Synthetic',objective:'',operationId:'create',extra:true}},auth.token)).status).toBe(400);expect(writes).toBe(0);
  expect((await send('/owner/rpc',{instanceId,method:'createProject',body:{name:'Synthetic',objective:'',operationId:'create'}},auth.token)).status).toBe(200);expect(writes).toBe(1);
  expect((await send('/owner/rpc',{instanceId,method:'revokeOwner',body:{}},auth.token)).status).toBe(200);
  expect((await send('/owner/rpc',{instanceId,method:'createProject',body:{name:'Synthetic',objective:'',operationId:'after-revoke'}},auth.token)).status).toBe(401);expect(writes).toBe(1);expect(cancellations).toBe(2);expect(revocations).toBe(2);
});
test('confirmed interruption recovery has an exact session lane independent of the blocked mutation queue',async()=>{
  const identity={projectId:'project',profileId:'profile',sessionId:'session',leaseEpoch:4};let recovered=false;
  const studio={instanceId:'test',state:()=>({session:identity}),serialized:()=>{throw new Error('blocked normal queue');},ownerOperation:()=>{throw new Error('blocked owner operation');},endInterruptedSession:async(body:unknown)=>{expect(body).toEqual(identity);recovered=true;return {closed:true};}} as any;
  const owner=new NodeOwnerServer({studio,origin:'http://127.0.0.1:44444',pairing:{} as any,shutdown:async()=>{}});
  await expect((owner as any).execute('endInterruptedSession',identity,()=>{})).resolves.toEqual({closed:true});expect(recovered).toBe(true);
  expect(()=> (owner as any).execute('endInterruptedSession',{...identity,leaseEpoch:3},()=>{})).toThrow('identity changed');
  expect(()=> (owner as any).validate('endInterruptedSession',{...identity,rendererCrashed:true})).toThrow();
});
