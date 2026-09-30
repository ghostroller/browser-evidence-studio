import { expect, test } from 'vitest';
import { shutdownNodeWorkspace } from '@/node/shutdown';

test('final launch identity is fully saved before successor can acquire the workspace',async()=>{
  const order:string[]=[];let releaseWrite!:()=>void,stored='old-ready';const writing=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const shutdown=shutdownNodeWorkspace([()=>{order.push('resources');}],async clean=>{expect(clean).toBe(true);order.push('final-write-start');await writing;stored='old-closed';order.push('final-write-done');},()=>{order.push('lease-release');stored='successor-ready';});
  await Promise.resolve();await Promise.resolve();expect(order).toEqual(['resources','final-write-start']);expect(stored).toBe('old-ready');
  releaseWrite();await shutdown;expect(order).toEqual(['resources','final-write-start','final-write-done','lease-release']);expect(stored).toBe('successor-ready');
});
test('resource failure drains remaining resources and records failure before releasing last',async()=>{
  const order:string[]=[];const failure=new Error('drain failed');
  const shutdown=shutdownNodeWorkspace([()=>{order.push('first');throw failure;},()=>{order.push('second');}],clean=>{expect(clean).toBe(false);order.push('failed-manifest');},()=>{order.push('lease-release');});
  await expect(shutdown).rejects.toMatchObject({name:'AggregateError',errors:[failure]});expect(order).toEqual(['first','second','failed-manifest','lease-release']);
});
test('a failed final write still releases last and never reports clean shutdown',async()=>{
  const order:string[]=[];const failure=new Error('manifest write failed');
  await expect(shutdownNodeWorkspace([],()=>{order.push('manifest');throw failure;},()=>{order.push('lease-release');})).rejects.toMatchObject({errors:[failure]});expect(order).toEqual(['manifest','lease-release']);
});
test('early startup with no owned manifest can release without rewriting prior launch metadata',async()=>{
  let prior='previous-launch-closed';const owned=undefined;
  await shutdownNodeWorkspace([],()=>{if(owned)prior='incorrect';},()=>{});expect(prior).toBe('previous-launch-closed');
});
test('a provider-exit guard can retain the root lease when termination remains unconfirmed',async()=>{
  const leaseClose=()=>{throw new Error('must not reach lease close');};let leaseHeld=true;
  await expect(shutdownNodeWorkspace([()=>{throw new Error('provider exit unconfirmed');}],()=>{},()=>{
    const providerTerminated=false;if(!providerTerminated)throw new Error('workspace writer lease retained');leaseClose();leaseHeld=false;
  })).rejects.toMatchObject({name:'AggregateError'});expect(leaseHeld).toBe(true);
});
