import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { CaptureCoordinator } from '@/capture/coordinator';
import { EvidenceStore } from '@/evidence/store';
import { EvidenceReader } from '@/evidence/reader';
import { ResourceArchive } from '@/resources/archive';

test('a queued old-document cache probe is cancelled while the new loader retains its own resources', async () => {
  const store=await EvidenceStore.create(path.resolve('output/refactor-a-tests',randomUUID()),{id:'recording',projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'CDP navigation race'});
  const cdp=new EventEmitter() as EventEmitter&{send:(method:string,args?:any)=>Promise<any>};
  let binding='',world='',context=1,loader='old',treeReads=0;
  let entered!:()=>void,release!:()=>void;
  const pendingTree=new Promise<void>(resolve=>{entered=resolve;}),oldTree=new Promise<void>(resolve=>{release=resolve;});
  const tree=(loaderId:string)=>({frame:{id:'main',loaderId},resources:[{url:'https://source.invalid/main.css',mimeType:'text/css'}]});
  cdp.send=async(method,args)=>{
    if(method==='Runtime.addBinding'){binding=args.name;world=args.executionContextName;}
    if(method==='Page.getFrameTree')return{frameTree:tree(loader)};
    if(method==='Page.createIsolatedWorld')return{executionContextId:context};
    if(method==='Page.getResourceTree'){const captured=loader;if(++treeReads===1){entered();await oldTree;}return{frameTree:tree(captured)};}
    if(method==='Page.getResourceContent')return{content:'a{color:rgb(1,2,3)}',base64Encoded:false};
    return{result:{}};
  };
  const identity={pageId:'page',targetId:'target',webContentsId:1,navigationGeneration:0};
  const capture=new CaptureCoordinator({createCDPSession:async()=>cdp} as unknown as Page,identity,store);
  const snapshot=(documentId:string)=>cdp.emit('Runtime.bindingCalled',{name:binding,executionContextId:context,payload:JSON.stringify({kind:'rrweb',formatVersion:2,position:{recordingId:'recording',pageId:'page',documentId,streamEpoch:documentId,sourceTimeMs:100,eventSeq:0},event:{type:2,timestamp:100,data:{node:{type:0,id:1,childNodes:[]},initialOffset:{left:0,top:0}}},metadata:[],metadataComplete:true,errors:[],isTop:true})});
  try{
    await capture.start();snapshot('old-document');await pendingTree;
    loader='new';context=2;cdp.emit('Runtime.executionContextsCleared');cdp.emit('Page.frameNavigated',{frame:{id:'main',loaderId:loader,url:'https://source.invalid/'}});
    cdp.emit('Runtime.executionContextCreated',{context:{id:context,name:world,auxData:{frameId:'main'}}});snapshot('new-document');
    // Puppeteer's independent counter is deliberately delayed; it must not cancel this CDP loader.
    identity.navigationGeneration+=20;release();await capture.flush();
    assert.equal(capture.health,'recording');assert.equal(capture.recordingPosition?.documentId,'new-document');
    const resources=await new ResourceArchive(store.runDir).list();assert.equal(resources.items.length,1);assert.equal(resources.items[0].position.documentId,'new-document');assert.equal(resources.items[0].status,'captured');
    const events=await new EvidenceReader(store.runDir).events({limit:100});assert.ok(events.items.some((event:any)=>event.type==='resource-cache-probe-skipped'));assert.ok(!events.items.some((event:any)=>event.type==='gap'));
  }finally{release();await capture.flush();await store.close();}
});

test('response observation time survives deferred body reads and read failures without becoming persistence time',async()=>{
  const store=await EvidenceStore.create(path.resolve('output/refactor-a-tests',randomUUID()),{id:'recording',projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'response observation attribution'});
  const cdp=new EventEmitter() as EventEmitter&{send:(method:string,args?:any)=>Promise<any>};
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  cdp.send=async(method,args)=>{
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main',loaderId:'loader'}}};
    if(method==='Page.createIsolatedWorld')return{executionContextId:1};
    if(method==='Network.getResponseBody'){if(args.requestId==='bad')throw new Error('body evicted from protocol buffer');enter();await pending;return{body:'{"value":42}',base64Encoded:false};}
    return{result:{}};
  };
  const capture=new CaptureCoordinator({createCDPSession:async()=>cdp} as unknown as Page,{pageId:'page',targetId:'target',webContentsId:1,navigationGeneration:0},store);
  try{
    await capture.start();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-09-26T00:00:00.000Z');
    for(const requestId of ['good','bad']){cdp.emit('Network.requestWillBeSent',{requestId,frameId:'main',loaderId:'loader',request:{url:`https://source.invalid/${requestId}`,method:'GET',headers:{}}});cdp.emit('Network.responseReceived',{requestId,response:{mimeType:'application/json',headers:{}}});cdp.emit('Network.loadingFinished',{requestId,encodedDataLength:12});}
    await entered;vi.setSystemTime('2026-09-26T00:01:00.000Z');release();await capture.flush();
    const page=await new EvidenceReader(store.runDir).artifacts({limit:100}),responses=page.items.filter((item:any)=>item.kind==='response-body') as any[];
    assert.equal(responses.length,2);assert.deepEqual(new Set(responses.map(item=>item.captureStatus)),new Set(['complete','read-failed']));
    for(const item of responses){assert.equal(item.source.responseObservedAt,'2026-09-26T00:00:00.000Z');assert.equal(item.source.pageId,'page');assert.match(item.source.requestKey,/\/target\/(good|bad)\//);assert.equal(item.createdAt,'2026-09-26T00:01:00.000Z');}
  }finally{vi.useRealTimers();release();await capture.flush();await store.close();}
});
