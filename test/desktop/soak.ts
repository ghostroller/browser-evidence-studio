import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Studio } from '../../src/main/services/studio';
export async function runSoak(studio:Studio,url:string,minutes:number){
  if(studio.active)await studio.seal();const project=await studio.createProject({name:'长录制验证',objective:'连续记录、checkpoint与有界回读'}),profile=await studio.createProfile({projectId:project.id,name:'独立合成长录制'});
  await studio.startRun({projectId:project.id,profileId:profile.id,url:url+'/orders'});const run=studio.required(),page=studio.current();
  await studio.control('agent');
  studio.window.window.setTitle('Browser Evidence Studio — 合成长录制自动验证，请勿手动导航');
  const start=Date.now(),checkpointMs:number[]=[],summaryMs:number[]=[],memory:any[]=[],ids:string[]=[];let cycles=0;
  while(Date.now()-start<minutes*60000){
    assert.equal(run.controller,'agent','The synthetic soak stops if a human explicitly takes ownership');
    assert.equal(studio.current().pageId,page.pageId,'The long-run synthetic target must remain selected');
    assert.equal(new URL(page.page.url()).origin,new URL(url).origin,'The synthetic soak never operates on an external site');
    await studio.action({type:'click',selector:'#increment',pageId:page.pageId,generation:page.navigationGeneration,leaseEpoch:run.leaseEpoch});
    await run.operation!.page.evaluate(async()=>{await(await fetch('/api/orders?page=1')).json();});
    if(cycles%6===0){let at=performance.now();const cp=await studio.checkpoint({key:'soak-'+cycles,title:'长录制 '+Math.floor((Date.now()-start)/60000)+' 分钟'});checkpointMs.push(performance.now()-at);ids.push(cp.id);await page.capture.flush();at=performance.now();const summary=await studio.reader(run.id).summary();summaryMs.push(performance.now()-at);assert.ok(Buffer.byteLength(JSON.stringify(summary))<=8192);memory.push({elapsedMs:Date.now()-start,main:process.memoryUsage(),browserPage:await page.page.metrics()});await writeFile(path.join(studio.root,'soak-progress.json'),JSON.stringify({status:'running',minutes,elapsedMs:Date.now()-start,cycles,checkpointMs,summaryMs,memory}));console.log(`SOAK ${((Date.now()-start)/60000).toFixed(1)}/${minutes} min; checkpoint ${cp.id}`);}
    cycles++;await delay(Math.min(10000,Math.max(1,minutes*60000-(Date.now()-start))));
  }
  await page.capture.flush();await studio.seal();const reader=studio.reader(run.id);const checkpoints=await reader.checkpoints({limit:100,maxBytes:32768});assert.equal(checkpoints.items.length,ids.length);await reader.rebuildIndex();const rebuilt=await reader.checkpoints({limit:100,maxBytes:32768});assert.deepEqual(rebuilt.items.map((x:any)=>x.id),ids);
  const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  const report={minutes,elapsedMs:Date.now()-start,runId:run.id,cycles,checkpoints:ids.length,checkpointP95Ms:p95(checkpointMs),summaryP95Ms:p95(summaryMs),memory,summary:await reader.summary(),gaps:await reader.gaps({limit:50,maxBytes:32768})};await writeFile(path.join(studio.root,'soak-result.json'),JSON.stringify(report,null,2));console.log('SOAK PASS '+JSON.stringify({elapsedMs:report.elapsedMs,checkpointP95Ms:report.checkpointP95Ms,summaryP95Ms:report.summaryP95Ms}));return report;
}
