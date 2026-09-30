import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { closeOwnedChromium } from '@/node/owned-process';
afterEach(()=>vi.useRealTimers());
function processFixture(){
  const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as string|null});
  const abort=new AbortController();
  const close=vi.fn(async()=>{}),browser={process:()=>child,close} as any;
  const exit=()=>{child.exitCode=0;child.emit('exit',0);};
  return {child,abort,close,browser,exit};
}
test('Browser.close acknowledgment without process exit does not release ownership',async()=>{
  vi.useFakeTimers();const f=processFixture();let settled=false;
  const result=closeOwnedChromium(f.browser,f.abort).then(value=>{settled=true;return value;});
  await Promise.resolve();expect(settled).toBe(false);f.exit();await expect(result).resolves.toEqual({forced:false});
  await vi.advanceTimersByTimeAsync(20000);expect(f.abort.signal.aborted).toBe(false);expect(f.child.listenerCount('exit')).toBe(0);
});
test('the owned launch abort ends a stuck close after five seconds and actual exit is joined',async()=>{
  vi.useFakeTimers();const f=processFixture();f.close.mockImplementation(()=>new Promise(()=>{}));
  f.abort.signal.addEventListener('abort',()=>f.exit());const result=closeOwnedChromium(f.browser,f.abort);
  await vi.advanceTimersByTimeAsync(5000);await expect(result).resolves.toEqual({forced:true});expect(f.child.listenerCount('exit')).toBe(0);
});
test('unconfirmed process exit fails boundedly and never claims ownership released',async()=>{
  vi.useFakeTimers();const f=processFixture();const result=expect(closeOwnedChromium(f.browser,f.abort)).rejects.toThrow('did not confirm termination');
  await vi.advanceTimersByTimeAsync(10000);await result;expect(f.abort.signal.aborted).toBe(true);expect(f.child.listenerCount('exit')).toBe(0);
});
test('already exited process does not wait forever on a stale Browser.close callback',async()=>{
  const f=processFixture();f.exit();f.close.mockImplementation(()=>new Promise(()=>{}));
  await expect(closeOwnedChromium(f.browser,f.abort)).resolves.toEqual({forced:false});expect(f.abort.signal.aborted).toBe(false);
});
