import { describe, expect, it } from 'vitest';
import { waitForMeasuredDuration } from '../desktop/soak-timing';

describe('fixed-load monotonic duration',()=>{
  it('rechecks after a timer wakes early instead of certifying a short load',async()=>{
    const durationMs=60_000,sleeps:number[]=[];
    let elapsedMs=59_990;
    const measured=await waitForMeasuredDuration(durationMs,()=>elapsedMs,async milliseconds=>{
      sleeps.push(milliseconds);
      elapsedMs+=sleeps.length===1?9.43:milliseconds;
    });
    expect(sleeps.length).toBeGreaterThan(1);
    expect(measured).toBeGreaterThanOrEqual(durationMs);
  });
  it('does not delay when the measured duration was already reached',async()=>{
    let waits=0;
    const measured=await waitForMeasuredDuration(60_000,()=>60_007,async()=>{waits++;});
    expect(measured).toBe(60_007);
    expect(waits).toBe(0);
  });
});
