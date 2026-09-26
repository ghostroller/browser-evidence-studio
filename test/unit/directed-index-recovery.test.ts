import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from '@/evidence/store';
import { hashBytes } from '@/evidence/files';
import { RecordingArchive, RecordingIndexWriter } from '@/replay/archive';
import { ResourceArchive, ResourceCapture } from '@/resources/archive';
import type { RecordingEnvelope } from '@/capture/recording-types';
import type { ReplayPosition } from '@/contracts/recording';
import { inspectRunRecovery, recoverRunIndexes } from '@/main/services/run-recovery';
import type { Studio } from '@/main/services/studio';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bes-directed-index-'));
  const runDir=path.join(root,'runs','recording');
  const store=await EvidenceStore.create(runDir,{id:'recording',projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'Directed index recovery'});
  const position:ReplayPosition={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:100,eventSeq:1};
  const event={type:2,timestamp:100,data:{node:{type:0,id:1,childNodes:[]},initialOffset:{left:0,top:0}}} as RecordingEnvelope['event'];
  const record:RecordingEnvelope={formatVersion:2,position,frameId:'top',mirrorScopeId:'top',event,metadata:[],metadataComplete:true,viewport:{width:800,height:600,deviceScaleFactor:1},gaps:[],sourceClock:{timeOrigin:0,monotonicMs:100},receivedAt:new Date().toISOString()};
  await new RecordingIndexWriter(store).append(record);
  const url='https://synthetic.invalid/a.css',capture=new ResourceCapture(store);
  const resource=await capture.capture({position,frameId:'top',requestId:'request-1',url,mediaType:'text/css',data:Buffer.from('a{color:red}'),availableObservedAt:new Date().toISOString()});
  await store.seal();await store.close();
  const archive=new RecordingArchive(runDir),resources=new ResourceArchive(runDir);
  return{root,runDir,position,url,resource,archive,resources,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

describe('directed recording and resource index recovery',()=>{
  it('distinguishes missing URL projection from an unobserved URL and publishes a complete generation',async()=>{
    const f=await fixture();try{
      const raw=path.join(f.runDir,'raw','rrweb','rrweb-000001.jsonl'),original=hashBytes(await fs.readFile(raw));
      const resourceOriginal=hashBytes(await fs.readFile(path.join(f.runDir,'resources',`${f.resource.id}.json`)));
      await fs.rm(path.join(f.runDir,'resource-url-index'),{recursive:true});
      await expect(f.resources.resolve(f.url,f.position)).rejects.toMatchObject({code:'RESOURCE_INDEX_MISSING'});
      const rebuilt=await f.resources.rebuildUrlIndex();expect(rebuilt).toMatchObject({references:1,urls:1,corruptCount:0});
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
      expect(await f.resources.history('https://synthetic.invalid/never.css',f.position,'top')).toEqual([]);
      expect(await f.resources.rebuildUrlIndex()).toMatchObject({references:1,urls:1});
      expect(hashBytes(await fs.readFile(raw))).toBe(original);
      expect(hashBytes(await fs.readFile(path.join(f.runDir,'resources',`${f.resource.id}.json`)))).toBe(resourceOriginal);
    }finally{await f.cleanup();}
  });
  it('repairs a truncated replay position index while preserving exact source position and original hash',async()=>{
    const f=await fixture();try{
      const raw=path.join(f.runDir,'raw','rrweb','rrweb-000001.jsonl'),original=hashBytes(await fs.readFile(raw));
      const [key]=(await fs.readdir(path.join(f.runDir,'replay-index'))).filter(name=>/^[a-f0-9]{64}$/.test(name));
      await fs.truncate(path.join(f.runDir,'replay-index',key,'positions.bin'),3);
      await expect(f.archive.positions(f.position)).rejects.toMatchObject({code:'INVALID_REPLAY'});
      const rebuilt=await f.archive.rebuild();expect(rebuilt).toMatchObject({records:1,corruptCount:0});
      expect((await f.archive.positions(f.position)).items[0].position).toEqual(f.position);
      expect((await f.archive.window(f.position)).records[0].position).toEqual(f.position);
      expect(hashBytes(await fs.readFile(raw))).toBe(original);
    }finally{await f.cleanup();}
  });
  it('keeps a published URL generation readable after a failed staging write and reports index corruption',async()=>{
    const f=await fixture();try{
      await f.resources.rebuildUrlIndex();
      const pointer=JSON.parse(await fs.readFile(path.join(f.runDir,'resource-url-index-current.json'),'utf8'));
      const index=path.join(f.runDir,'resource-url-index-generations',pointer.generation,`${hashBytes(f.url)}.jsonl`);
      await fs.appendFile(index,'garbage\n');
      await expect(f.resources.history(f.url,f.position,'top')).rejects.toMatchObject({code:'RESOURCE_INDEX_CORRUPT'});
      await f.resources.rebuildUrlIndex();expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
      expect(JSON.parse(await fs.readFile(path.join(f.runDir,'resource-url-index-current.json'),'utf8')).generation).not.toBe(pointer.generation);
    }finally{await f.cleanup();}
  });
  it('does not turn a projection write failure into original corruption',async()=>{
    const f=await fixture();try{
      const raw=path.join(f.runDir,'raw','rrweb','rrweb-000001.jsonl'),before=await fs.readFile(raw);
      await fs.writeFile(path.join(f.runDir,'replay-index-generations'),'blocked');
      await expect(f.archive.rebuild()).rejects.toMatchObject({code:'REPLAY_INDEX_WRITE_FAILED'});
      expect(await fs.readFile(raw)).toEqual(before);
      await expect(f.archive.window(f.position)).rejects.toMatchObject({code:'REPLAY_INDEX_MISSING'});
    }finally{await f.cleanup();}
  });
  it('preserves a previously published generation when a later build fails after staging',async()=>{
    const f=await fixture();try{
      await f.resources.rebuildUrlIndex();
      const pointerFile=path.join(f.runDir,'resource-url-index-current.json'),before=await fs.readFile(pointerFile,'utf8');
      const write=fs.writeFile.bind(fs);
      const mocked=vi.spyOn(fs,'writeFile').mockImplementation(async(file,...args)=>{
        if(String(file).includes('resource-url-index-generations')&&String(file).endsWith('.jsonl'))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});
        return write(file,...args);
      });
      try{await expect(f.resources.rebuildUrlIndex()).rejects.toMatchObject({code:'RESOURCE_INDEX_WRITE_FAILED'});}finally{mocked.mockRestore();}
      expect(await fs.readFile(pointerFile,'utf8')).toBe(before);
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
      const staged=await fs.readdir(path.join(f.runDir,'resource-url-index-generations'));
      expect(staged.length).toBe(2);
    }finally{vi.restoreAllMocks();await f.cleanup();}
  });
  it('rejects valid JSON manifest tampering before it can hide an observed URL or replay position',async()=>{
    const f=await fixture();try{
      await f.archive.rebuild();await f.resources.rebuildUrlIndex();
      const replayPointer=JSON.parse(await fs.readFile(path.join(f.runDir,'replay-index-current.json'),'utf8'));
      const resourcePointer=JSON.parse(await fs.readFile(path.join(f.runDir,'resource-url-index-current.json'),'utf8'));
      const replayManifest=path.join(f.runDir,'replay-index-generations',replayPointer.generation,'index-manifest.json');
      const resourceManifest=path.join(f.runDir,'resource-url-index-generations',resourcePointer.generation,'index-manifest.json');
      const changedReplay=JSON.parse(await fs.readFile(replayManifest,'utf8'));changedReplay.records=0;await fs.writeFile(replayManifest,JSON.stringify(changedReplay));
      const changedResource=JSON.parse(await fs.readFile(resourceManifest,'utf8'));changedResource.urls={};await fs.writeFile(resourceManifest,JSON.stringify(changedResource));
      await expect(f.archive.window(f.position)).rejects.toMatchObject({code:'REPLAY_INDEX_CORRUPT'});
      await expect(f.resources.resolve(f.url,f.position)).rejects.toMatchObject({code:'RESOURCE_INDEX_CORRUPT'});
      const fake={root:f.root,runs:[{id:'recording',status:'sealed'}],active:undefined} as unknown as Studio;
      expect(await inspectRunRecovery(fake,{runId:'recording'})).toMatchObject({indexDiagnostics:{replay:{state:'corrupt'},resources:{state:'corrupt'}}});
      await f.archive.rebuild();await f.resources.rebuildUrlIndex();
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
    }finally{await f.cleanup();}
  });
  it('rejects oversized index inputs before reading them into memory',async()=>{
    const f=await fixture();try{
      await fs.truncate(path.join(f.runDir,'resource-url-index','url-census.jsonl'),1024*1024+1);
      await expect(f.resources.history('https://synthetic.invalid/never.css',f.position,'top')).rejects.toMatchObject({code:'RESOURCE_INDEX_BUDGET'});
      await f.archive.rebuild();await f.resources.rebuildUrlIndex();
      const pointer=JSON.parse(await fs.readFile(path.join(f.runDir,'resource-url-index-current.json'),'utf8'));
      const urlIndex=path.join(f.runDir,'resource-url-index-generations',pointer.generation,`${hashBytes(f.url)}.jsonl`);
      await fs.truncate(urlIndex,4*1024*1024+1);
      await expect(f.resources.resolve(f.url,f.position)).rejects.toMatchObject({code:'RESOURCE_INDEX_BUDGET'});
      await fs.truncate(path.join(f.runDir,'replay-index-current.json'),4097);
      await expect(f.archive.window(f.position)).rejects.toMatchObject({code:'REPLAY_INDEX_BUDGET'});
    }finally{await f.cleanup();}
  });
  it('keeps corrupt original bytes visible and rejects a live writer',async()=>{
    const f=await fixture();try{
      const live=await EvidenceStore.open(f.runDir);
      try{await expect(f.archive.rebuild()).rejects.toMatchObject({code:'ACTIVE_INDEX_REBUILD'});}
      finally{await live.close();}
      const raw=path.join(f.runDir,'raw','rrweb','rrweb-000001.jsonl');
      await fs.appendFile(raw,'{broken original');const damaged=await fs.readFile(raw);
      const result=await f.archive.rebuild();expect(result).toMatchObject({records:1,corruptCount:1});
      expect(result.corrupt[0].reason).toContain('Unterminated');
      expect(await fs.readFile(raw)).toEqual(damaged);
      expect((await f.archive.window(f.position)).records).toHaveLength(1);
    }finally{await f.cleanup();}
  });
  it('reports URL index staging failure without claiming missing original resources',async()=>{
    const f=await fixture();try{
      await fs.writeFile(path.join(f.runDir,'resource-url-index-generations'),'blocked');
      await expect(f.resources.rebuildUrlIndex()).rejects.toMatchObject({code:'RESOURCE_INDEX_WRITE_FAILED'});
      expect((await f.resources.read(f.resource.id)).bytes.toString()).toBe('a{color:red}');
    }finally{await f.cleanup();}
  });
  it('uses a confirmed run identity and writer fingerprint at the trusted recovery service boundary',async()=>{
    const f=await fixture();try{
      const fake={root:f.root,runs:[{id:'recording',status:'sealed'}],active:undefined} as unknown as Studio;
      expect(await inspectRunRecovery(fake,{runId:'recording'})).toMatchObject({canRecover:false,canRecoverIndexes:true,indexDiagnostics:{replay:{state:'legacy'},resources:{state:'legacy'}}});
      await expect(recoverRunIndexes(fake,{runId:'other',expectedFingerprint:null})).rejects.toThrow('Unknown recovery run');
      await expect(recoverRunIndexes(fake,{runId:'recording',expectedFingerprint:'stale'})).rejects.toThrow('ownership changed');
      const result=await recoverRunIndexes(fake,{runId:'recording',expectedFingerprint:null});
      expect(result).toMatchObject({runId:'recording',replay:{records:1,corruptCount:0},resources:{references:1,corruptCount:0}});
      expect(await inspectRunRecovery(fake,{runId:'recording'})).toMatchObject({canRecoverIndexes:true,indexDiagnostics:{replay:{state:'published'},resources:{state:'published'}}});
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
    }finally{await f.cleanup();}
  });
});
