import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChromiumStudio } from '@/node/chromium-studio';
import { BrowserSessionLifecycle } from '@/main/services/browser-session';
import { EvidenceStore } from '@/evidence/store';

const stores:EvidenceStore[]=[];
afterEach(async()=>{for(const store of stores.splice(0))await store.close();});
async function fixture({connected=false,terminated=true,captureFails=false,rendererFailed=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'bes-node-interrupted-'));
  const studio=new ChromiumStudio(root,process.cwd(),{executablePath:'/not-launched',headless:false});
  const store=await EvidenceStore.create(path.join(root,'runs','recording'),{id:'recording',projectId:'project',kind:'demonstrate',mode:'synthetic',objective:'interruption contract'});stores.push(store);
  const artifact=await store.putArtifact({kind:'original-proof',mediaType:'text/plain',data:'immutable original'});
  let destroyed=false,stopped=false,closeCount=0;
  const child=Object.assign(new EventEmitter(),{exitCode:terminated?0:null,signalCode:null});
  const provider={browser:{connected,process:()=>child,close:async()=>{closeCount++;provider.browser.connected=false;}},failedTargets:new Set(rendererFailed?['target']:[]),browserInstanceId:'owned-browser',closing:false,abort:new AbortController()};
  const page={pageId:'page',targetId:'target',navigationGeneration:1,provider:'chromium',browserInstanceId:'owned-browser',page:{isClosed:()=>false},view:{getURL:()=>"https://example.invalid/",getTitle:()=>"Synthetic page",isLoadingMainFrame:()=>false,getZoomFactor:()=>1,navigationHistory:{canGoBack:()=>false,canGoForward:()=>false}},capture:{documentDestroyed:()=>{destroyed=true;},stop:async()=>{expect(destroyed).toBe(true);stopped=true;if(captureFails)throw new Error('Synthetic capture drain failure');}}};
  const runtime={id:'recording',projectId:'project',profileId:'profile',store,pages:new Map([['page',page]]),selectedPageId:'page',session:provider,controller:'human',leaseEpoch:3,capture:'degraded',execution:'ready',locked:false};
  const owner=new BrowserSessionLifecycle(runtime);
  Object.assign(studio,{browser:owner,provider,active:runtime,runs:[store.manifest],observer:{disconnect:()=>{}}});
  const body=()=>({projectId:'project',profileId:'profile',sessionId:owner.id,leaseEpoch:runtime.leaseEpoch});
  return {root,studio,store,artifact,runtime,body,child,get stopped(){return stopped;},get destroyed(){return destroyed;},get closeCount(){return closeCount;}};
}
test('connected or stale environments cannot be labeled interrupted by a caller',async()=>{
  const healthy=await fixture({connected:true});await expect(healthy.studio.endInterruptedSession(healthy.body())).rejects.toThrow('backend-confirmed');expect(healthy.closeCount).toBe(0);expect(healthy.store.manifest.status).toBe('recording');
  const stale=await fixture();await expect(stale.studio.endInterruptedSession({...stale.body(),leaseEpoch:999})).rejects.toThrow('identity changed');expect(stale.closeCount).toBe(0);
});
test('disconnected recovery joins the owned process, drains capture, preserves originals and releases the writer as interrupted',async()=>{
  const f=await fixture({captureFails:true});const original=await readFile(path.join(f.store.runDir,f.artifact.path!));
  const result=await f.studio.endInterruptedSession(f.body());
  expect(result).toMatchObject({closed:true,recordingId:'recording',status:'interrupted',cleanupFailures:1});expect(f.closeCount).toBe(1);expect(f.stopped).toBe(true);
  expect(f.studio.state().session).toBeNull();expect(f.studio.active).toBeUndefined();expect(f.studio.providerStatus).toBe('not-open');
  expect(await readFile(path.join(f.store.runDir,f.artifact.path!))).toEqual(original);
  const restored=await EvidenceStore.open(f.store.runDir);stores.push(restored);expect(restored.manifest.status).toBe('interrupted');expect(restored.manifest.sealedAt).toBeUndefined();
  const {EvidenceReader}=await import('@/evidence/reader');const gaps=await new EvidenceReader(f.store.runDir).gaps({limit:10});
  expect(gaps.items).toContainEqual(expect.objectContaining({type:'recovery.gap',data:expect.objectContaining({reason:'provider-process-disconnected',finalEmissionLost:true,cleanupFailures:expect.any(Array)})}));
});
test('a transport disconnect without confirmed process termination cannot release or fabricate interrupted evidence',async()=>{
  const f=await fixture({terminated:false});vi.useFakeTimers();const outcome=expect(f.studio.endInterruptedSession(f.body())).rejects.toThrow('did not confirm termination');await vi.advanceTimersByTimeAsync(10000);await outcome;vi.useRealTimers();
  expect(f.destroyed).toBe(false);expect(f.stopped).toBe(false);expect(f.store.manifest.status).toBe('recording');expect(f.studio.active).toBe(f.runtime);expect(f.studio.providerStatus).toBe('disconnected');
});
test('a disconnected environment after sealing ends without relabeling or changing its old recording',async()=>{
  const f=await fixture();await f.store.seal();await f.store.close();
  const before=await readFile(path.join(f.store.runDir,'manifest.json'));
  const owner=(f.studio as any).browser;owner.detach('recording');Object.assign(f.studio,{active:undefined});
  const result=await f.studio.endInterruptedSession(f.body());
  expect(result).toEqual({closed:true,sessionId:owner.id,status:'interrupted',cleanupFailures:0});expect(f.closeCount).toBe(1);expect(f.stopped).toBe(false);
  expect(await readFile(path.join(f.store.runDir,'manifest.json'))).toEqual(before);expect(f.studio.state().session).toBeNull();
});

test('an observed renderer crash closes the whole owned provider and persists interrupted failure without sealing',async()=>{
  const f=await fixture({connected:true,rendererFailed:true});
  expect(f.studio.providerStatus).toBe('renderer-failed');
  const result=await f.studio.endInterruptedSession(f.body());expect(result.status).toBe('interrupted');expect(f.closeCount).toBe(1);
  expect(f.store.manifest).toMatchObject({status:'interrupted',interruptionReason:'renderer-crashed'});expect(f.store.manifest.sealedAt).toBeUndefined();
  expect(f.studio.providerTerminated).toBe(true);expect(f.studio.providerStatus).toBe('not-open');
});

test('interrupted recovery terminates the owned provider before joining a queued capture waiting on its transport',async()=>{
  const f=await fixture({connected:true,rendererFailed:true});let settle!:()=>void;
  Object.assign(f.studio,{queue:new Promise<void>(resolve=>{settle=resolve;})});
  const provider=(f.studio as any).provider,close=provider.browser.close;
  provider.browser.close=async()=>{await close();settle();};
  await expect(f.studio.endInterruptedSession(f.body())).resolves.toMatchObject({closed:true,status:'interrupted'});
});
