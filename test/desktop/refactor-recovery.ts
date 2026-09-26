import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Studio } from '@/main/services/studio';
import { RecordingArchive, REPLAY_MAX_WINDOW_EVENTS } from '@/replay/archive';
import { ResourceArchive } from '@/resources/archive';
import { recoverRunIndexes } from '@/main/services/run-recovery';
import { startFixture } from '../fixtures/site';
import { runSoak, settleInitialCaptureBaseline } from './soak';
import { verifySoakEvidenceSnapshot, type SoakEvidenceSnapshot } from './soak-evidence';
import { EvidenceReader } from '@/evidence/reader';
import { hashBytes } from '@/evidence/files';
import type { ReplayPosition } from '@/contracts/recording';
import { sameStream } from '@/capture/recording-types';
import { SourceModel } from '@/replay/source-model';
import { assertReadyReplay, assertReplayDom, type ReplayDomExpectation, type ReplayDomObservation } from './replay-verification';
import { app, webContents } from 'electron';

interface NewArchitectureSoak {schemaVersion:1;processId:number;runId:string;projectId:string;minutes:number;position:ReplayPosition;resourceId:string;resourceUrl:string;frameId:string;blobHash:string;rawFiles:Array<{name:string;sha256:string}>;evidenceSnapshot:SoakEvidenceSnapshot;recovery:{replayRecords:number;resourceReferences:number};sourceStream:{events:number;preBaselineEvents:number;first:ReplayPosition;lastPreBaseline:ReplayPosition|null;baseline:ReplayPosition};}

function savedDom(model:SourceModel,outlineColor?:string):ReplayDomExpectation{
  const id=(value:string)=>[...model.nodes.values()].find(node=>node.type===2&&node.metadata?.attributes.id?.status==='present'&&node.metadata.attributes.id.value===value);
  const count=id('action-count');
  const button=[...model.nodes.values()].find(node=>node.type===2&&node.metadata?.tagName.toLowerCase()==='button'&&node.metadata.attributes.id?.status==='present'&&node.metadata.attributes.id.value.startsWith('soak-click-'));
  assert.ok(count&&button,'Saved source must contain the soak count and button');
  const buttonId=button.metadata!.attributes.id;assert.equal(buttonId.status,'present');
  const countText=model.node({kind:'dom-node',position:model.records.at(-1)!.position,frameId:count.metadata!.frameId,mirrorScopeId:count.metadata!.mirrorScopeId,nodeId:count.id}).text;
  assert.equal(countText.status,'present');
  return {nodeId:count.id,text:countText.value,buttonNodeId:button.id,buttonId:buttonId.value,outlineColor};
}

async function replayMemory(studio:Studio,projectId:string,positions:ReplayPosition[],stylesheetAt?:number){
  const before=new Set(webContents.getAllWebContents().map(contents=>contents.id));
  const started=performance.now();
  const opened=await studio.replayHost.open({projectId,position:positions[0]});
  const fresh=webContents.getAllWebContents().filter(contents=>!before.has(contents.id));
  const samples:Array<{seek:number;latencyMs:number;events:number;readBytes:number;generation:number;mainRssBytes:number;replayPrivateBytes:number|null;replayWorkingSetBytes:number|null}>=[];
  try{
    assert.equal(fresh.length,1,'Replay operation must create exactly one identifiable WebContents');
    const source=fresh[0];assert.ok(!source.isDestroyed(),'Replay WebContents was destroyed');
    const pid=source.getOSProcessId();assert.ok(pid>0);
    const recording=new RecordingArchive(path.join(studio.root,'runs',positions[0].recordingId));
    let previous=0;
    for(const [seek,position] of positions.entries()){
      const began=seek?performance.now():started;
      const result=seek?await studio.replayHost.seek({projectId,replayId:opened.replayId,position}):opened;
      assertReadyReplay(result,position,opened.replayId,previous);previous=result.generation;
      const window=await recording.window(position);
      const expected=savedDom(new SourceModel(window.records),seek===stylesheetAt?'rgb(20, 40, 60)':undefined);
      const observed=await source.executeJavaScript(`(()=>{const frame=document.querySelector('#replay iframe');const doc=frame?.contentDocument;const count=doc?.querySelector('#action-count');const button=doc?.querySelector('button[id^="soak-click-"]');const mirror=window.__besPlayer?.getMirror();return {nodeId:count&&mirror?mirror.getId(count):null,text:count?.textContent??null,buttonNodeId:button&&mirror?mirror.getId(button):null,buttonId:button?.id??null,outlineColor:doc?.body?getComputedStyle(doc.body).outlineColor:null};})()` ) as ReplayDomObservation;
      assertReplayDom(observed,expected);
      const metric=app.getAppMetrics().find(item=>item.pid===pid);
      samples.push({seek,latencyMs:performance.now()-began,events:window.records.length,readBytes:window.readBytes,generation:result.generation,mainRssBytes:process.memoryUsage().rss,replayPrivateBytes:metric?.memory.privateBytes===undefined?null:metric.memory.privateBytes*1024,replayWorkingSetBytes:metric?.memory.workingSetSize===undefined?null:metric.memory.workingSetSize*1024});
    }
    assert.ok(samples.every(sample=>sample.replayPrivateBytes!==null),'Replay private memory must be available for the long-run verification');
    return{pid,webContentsId:source.id,samples,changeBytes:samples.at(-1)!.replayPrivateBytes!-samples[0].replayPrivateBytes!,interpretation:'Bounded post-recording seek samples; no claim of indefinite memory stability.'};
  }finally{studio.replayHost.close(opened.replayId);}
}

async function longSoak(studio:Studio):Promise<Record<string,unknown>>{
  const minutes=Number(process.env.BES_SOAK_MINUTES||1);
  assert.ok(Number.isSafeInteger(minutes)&&minutes>=1&&minutes<=60);
  const fixture=await startFixture();
  try{
    const load=await runSoak(studio,fixture.url,minutes,{newArchitecture:true});
    const runDir=path.join(studio.root,'runs',load.runId);
    const recording=new RecordingArchive(runDir),resources=new ResourceArchive(runDir);
    const streams=await recording.streams(1000);assert.ok(streams.items.length>0,'Long load must save format-2 source streams');
    const cssCandidate=(await resources.list(1000)).items.find(item=>item.status==='captured'&&item.originalUrl.status==='present'&&item.originalUrl.value===fixture.url+'/soak-resource.css');
    assert.ok(cssCandidate,'Long load must include an observed CSS response');
    const stream=streams.items.find(item=>sameStream(item.first,cssCandidate.position));
    assert.ok(stream&&stream.first.eventSeq<=cssCandidate.position.eventSeq&&stream.last.eventSeq>=cssCandidate.position.eventSeq,'The measured replay stream must contain the observed CSS position');
    let baselineOrdinal:number|undefined,baseline:ReplayPosition|undefined;
    for(let ordinal=0;ordinal<Math.min(stream.events,REPLAY_MAX_WINDOW_EVENTS);ordinal+=1000){
      const page=await recording.positions(stream.first,Math.min(1000,stream.events-ordinal),ordinal);
      const index=page.items.findIndex(item=>item.type===2);
      if(index>=0){baselineOrdinal=ordinal+index;baseline=page.items[index].position;break;}
    }
    assert.ok(baselineOrdinal!==undefined&&baseline,'The source stream must have a bounded full snapshot before reliable seeks');
    assert.ok(stream.events-baselineOrdinal>=15,'The source stream must provide 15 distinct replayable seek positions');
    const lastPreBaseline=baselineOrdinal>0?(await recording.positions(stream.first,1,baselineOrdinal-1)).items[0].position:null;
    const sourceStream={events:stream.events,preBaselineEvents:baselineOrdinal,first:stream.first,lastPreBaseline,baseline};
    const first=baselineOrdinal,middle=Math.floor((first+stream.events-1)/2),last=stream.events-1;
    let seed=0x51a7e;const selected=new Set([first,middle,last]);
    while(selected.size<15){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;selected.add(first+(seed>>>0)%(stream.events-first));}
    const ordinals=[first,middle,last,...[...selected].filter(ordinal=>ordinal!==first&&ordinal!==middle&&ordinal!==last)];
    const seeks=[];
    for(const ordinal of ordinals){const item:{position:ReplayPosition;type:number;source:number}=(await recording.positions(stream.first,1,ordinal)).items[0];assert.ok(item);const window=await recording.window(item.position);assert.deepEqual(window.position,item.position);assert.deepEqual(window.gaps,[],'Selected replay position must have no source gaps');seeks.push({ordinal,position:item.position,events:window.records.length,readBytes:window.readBytes});}
    const position=seeks[2].position;
    const css=await resources.resolve(fixture.url+'/soak-resource.css',position,cssCandidate.frameId);
    assert.ok(css&&css.status==='captured','Select the latest observed CSS request version at the replay position');
    const blobHash=hashBytes((await resources.read(css.id)).bytes);
    const rawDirectory=path.join(runDir,'raw','rrweb');
    const rawFiles=await Promise.all((await readdir(rawDirectory)).filter(name=>/^rrweb-\d{6}\.jsonl$/.test(name)).sort().map(async name=>({name,sha256:hashBytes(await readFile(path.join(rawDirectory,name)))})));
    await rm(path.join(runDir,'resource-url-index',`${hashBytes(fixture.url+'/soak-resource.css')}.jsonl`));
    await assert.rejects(resources.resolve(fixture.url+'/soak-resource.css',position,css.frameId),(error:{code?:string})=>error.code==='RESOURCE_INDEX_MISSING');
    const key=createHash('sha256').update(JSON.stringify([position.recordingId,position.pageId,position.documentId,position.streamEpoch])).digest('hex');
    await truncate(path.join(runDir,'replay-index',key,'positions.bin'),3);
    const recovery=await recoverRunIndexes(studio,{runId:load.runId,expectedFingerprint:null});
    assert.equal(recovery.replay.corruptCount,0);assert.equal(recovery.resources.corruptCount,0);
    assert.deepEqual((await recording.positions(stream.first,1,stream.events-1)).items[0].position,position);
    assert.equal((await resources.resolve(fixture.url+'/soak-resource.css',position,css.frameId))?.id,css.id);
    for(const original of rawFiles)assert.equal(hashBytes(await readFile(path.join(rawDirectory,original.name))),original.sha256);
    const projectId=studio.runs.find(run=>run.id===load.runId)?.projectId;assert.ok(projectId);
    const replay=await replayMemory(studio,projectId,seeks.map(item=>item.position),2);
    const saved:NewArchitectureSoak={schemaVersion:1,processId:process.pid,runId:load.runId,projectId,minutes,position,resourceId:css.id,resourceUrl:fixture.url+'/soak-resource.css',frameId:css.frameId,blobHash,rawFiles,evidenceSnapshot:load.evidenceSnapshot,sourceStream,
      recovery:{replayRecords:recovery.replay.records,resourceReferences:recovery.resources.references}};
    await writeFile(path.join(studio.root,'new-architecture-soak.json'),JSON.stringify(saved,null,2));
    return{passed:true,load:{minutes,cycles:load.load.completedCycles,plannedCycles:load.load.plannedCycles,skippedSlots:load.load.skippedScheduleSlots,performance:load.performanceVerdict,queueMetrics:load.newArchitectureQueueMetrics,archiveGrowth:load.newArchitectureArchiveGrowth,memory:load.memory},streams:streams.items.length,sourceStream,seeks,replayMemory:replay,workerMemory:{status:'not-running',reason:'The fixed recording load does not start a runner worker; worker_threads share the main PID.'},recovery:saved.recovery,resourceId:css.id,runId:load.runId};
  }finally{await fixture.close();}
}

async function verifyLongSoak(studio:Studio):Promise<Record<string,unknown>>{
  const saved=JSON.parse(await readFile(path.join(studio.root,'new-architecture-soak.json'),'utf8')) as NewArchitectureSoak;
  assert.equal(saved.schemaVersion,1);assert.notEqual(saved.processId,process.pid,'Recovery verification requires a new Electron PID');
  const runDir=path.join(studio.root,'runs',saved.runId),recording=new RecordingArchive(runDir),resources=new ResourceArchive(runDir);
  assert.deepEqual((await recording.window(saved.position)).position,saved.position);
  assert.equal((await resources.resolve(saved.resourceUrl,saved.position,saved.frameId))?.id,saved.resourceId);
  assert.equal(hashBytes((await resources.read(saved.resourceId)).bytes),saved.blobHash);
  for(const original of saved.rawFiles)assert.equal(hashBytes(await readFile(path.join(runDir,'raw','rrweb',original.name))),original.sha256);
  const evidence=await verifySoakEvidenceSnapshot(new EvidenceReader(runDir),saved.evidenceSnapshot);
  const replay=await replayMemory(studio,saved.projectId,[saved.position],0);
  return{passed:true,originalProcessId:saved.processId,processId:process.pid,runId:saved.runId,minutes:saved.minutes,sourceStream:saved.sourceStream,recovered: saved.recovery,evidence,replay};
}

/** One real Electron process, a real format-2 recorder and a directed recovery.
 * The long-load entry extends this same fixture after the short gate passes. */
export async function runRefactorRecoveryScenario(studio:Studio,phase:string):Promise<Record<string,unknown>>{
  if(phase==='refactor-recovery-soak')return longSoak(studio);
  if(phase==='refactor-recovery-verify')return verifyLongSoak(studio);
  assert.equal(phase,'refactor-recovery');
  if(studio.active)await studio.seal();if(studio.state().session)await studio.closeSession();
  const fixture=await startFixture();
  try{
    const project=await studio.createProject({name:'合成索引恢复',objective:'原件与可重建索引分离'});
    const profile=await studio.createProfile({projectId:project.id,name:'合成恢复环境'});
    await studio.startRun({projectId:project.id,profileId:profile.id,url:fixture.url+'/soak'});
    const run=studio.required(),page=studio.current();
    await settleInitialCaptureBaseline(page, run.id);
    await page.page.evaluate(async()=>{await new Promise<void>((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/soak-resource.css';link.onload=()=>resolve();link.onerror=()=>reject(new Error('Synthetic CSS failed'));document.head.appendChild(link);});});
    await page.capture.flush();
    const recording=new RecordingArchive(run.store.runDir),resources=new ResourceArchive(run.store.runDir);
    const streams=await recording.streams();assert.ok(streams.items.length>0,'Production recorder must save a format-2 stream');
    const cssCandidate=(await resources.list(1000)).items.find(item=>item.status==='captured'&&item.originalUrl.status==='present'&&item.originalUrl.value===fixture.url+'/soak-resource.css');
    assert.ok(cssCandidate,'Synthetic observed CSS must have a saved manifest and blob');
    const stream=streams.items.find(item=>sameStream(item.first,cssCandidate.position));
    assert.ok(stream&&stream.first.eventSeq<=cssCandidate.position.eventSeq&&stream.last.eventSeq>=cssCandidate.position.eventSeq,'The selected replay stream must contain the observed CSS position');
    const positions=await recording.positions(stream.first,1000);assert.ok(positions.items.length>0);
    const position=positions.items.at(-1)!.position;
    const css=await resources.resolve(fixture.url+'/soak-resource.css',position,cssCandidate.frameId);
    assert.ok(css&&css.status==='captured','Select the latest observed CSS request version at the replay position');
    const blob=await resources.read(css.id),blobHash=createHash('sha256').update(blob.bytes).digest('hex');
    await studio.seal();await studio.closeSession();
    const rawDirectory=path.join(run.store.runDir,'raw','rrweb');
    const rawFiles=(await readdir(rawDirectory)).filter(name=>/^rrweb-\d{6}\.jsonl$/.test(name)).sort();
    const originalHashes=await Promise.all(rawFiles.map(async name=>({name,sha256:createHash('sha256').update(await readFile(path.join(rawDirectory,name))).digest('hex')})));
    await rm(path.join(run.store.runDir,'resource-url-index'),{recursive:true});
    await assert.rejects(resources.resolve(fixture.url+'/soak-resource.css',position,css.frameId),(error:{code?:string})=>error.code==='RESOURCE_INDEX_MISSING');
    const [key]=(await readdir(path.join(run.store.runDir,'replay-index'))).filter(name=>/^[a-f0-9]{64}$/.test(name));
    await truncate(path.join(run.store.runDir,'replay-index',key,'positions.bin'),3);
    const result=await recoverRunIndexes(studio,{runId:run.id,expectedFingerprint:null});
    assert.equal(result.replay.corruptCount,0);assert.equal(result.resources.corruptCount,0);
    assert.deepEqual((await recording.window(position)).records.at(-1)!.position,position);
    assert.equal((await resources.resolve(fixture.url+'/soak-resource.css',position,css.frameId))?.id,css.id);
    assert.equal(createHash('sha256').update((await resources.read(css.id)).bytes).digest('hex'),blobHash);
    for(const original of originalHashes)assert.equal(createHash('sha256').update(await readFile(path.join(rawDirectory,original.name))).digest('hex'),original.sha256);
    const report={schemaVersion:1,passed:true,runId:run.id,processId:process.pid,recording:result.replay,resources:result.resources,position,rawFiles:originalHashes,blobHash};
    await writeFile(path.join(studio.root,'refactor-recovery-report.json'),JSON.stringify(report,null,2));
    return report;
  }finally{await fixture.close();}
}
