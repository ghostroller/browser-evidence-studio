import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { EvidenceStore } from '@/evidence/store';
import { RecordingArchive } from '@/replay/archive';

const stores:EvidenceStore[]=[];
afterEach(async()=>{for(const store of stores.splice(0))await store.close();});
async function recording(){
  const store=await EvidenceStore.create(path.resolve('output','replay-foreground-tests',randomUUID(),'runs','recording'),
    {id:'recording',projectId:'synthetic',mode:'synthetic',kind:'demonstrate',objective:'foreground transitions'});
  stores.push(store);return {store,archive:new RecordingArchive(store.runDir)};
}

test('old recordings explicitly report missing foreground history',async()=>{
  const {archive}=await recording();
  expect(await archive.foreground()).toEqual({status:'legacy',items:[]});
});

test('trusted foreground transitions remain bounded, ordered and preserve page identity',async()=>{
  const {store,archive}=await recording();
  for(const [index,pageId] of ['page-a','page-b','page-a'].entries()){
    const observedAtMs=1000+index*500;
    await store.appendEvent({type:'page-foreground',source:'electron',occurredAt:new Date(observedAtMs).toISOString(),timeBasis:'host-wall-clock',pageId,
      data:{version:1,previousPageId:index?['page-a','page-b'][index-1]:null,selectedPageId:pageId,observedAtMs,transitionOrdinal:index+1,reason:'synthetic'}});
  }
  const first=await archive.foreground(2);
  expect(first.status).toBe('recorded');
  expect(first.items.map(item=>item.pageId)).toEqual(['page-a','page-b']);
  expect(first.nextCursor).toBeTruthy();
  const second=await archive.foreground(2,first.nextCursor);
  expect(second.items).toEqual([expect.objectContaining({pageId:'page-a',observedAtMs:2000,transitionOrdinal:3})]);
  expect(second.nextCursor).toBeUndefined();
});
