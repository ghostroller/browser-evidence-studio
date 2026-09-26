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
import { claimIndexMaintenance } from '@/evidence/writer-lock';
import type { Studio } from '@/main/services/studio';

async function fixture(twoVersions=false,extraResource=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bes-directed-index-'));
  const runDir=path.join(root,'runs','recording');
  const store=await EvidenceStore.create(runDir,{id:'recording',projectId:'synthetic',kind:'demonstrate',mode:'synthetic',objective:'Directed index recovery'});
  const position:ReplayPosition={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:100,eventSeq:1};
  const event={type:2,timestamp:100,data:{node:{type:0,id:1,childNodes:[]},initialOffset:{left:0,top:0}}} as RecordingEnvelope['event'];
  const record:RecordingEnvelope={formatVersion:2,position,frameId:'top',mirrorScopeId:'top',event,metadata:[],metadataComplete:true,viewport:{width:800,height:600,deviceScaleFactor:1},gaps:[],sourceClock:{timeOrigin:0,monotonicMs:100},receivedAt:new Date().toISOString()};
  await new RecordingIndexWriter(store).append(record);
  const url='https://synthetic.invalid/a.css',capture=new ResourceCapture(store);
  const resource=await capture.capture({position,frameId:'top',requestId:'request-1',url,mediaType:'text/css',data:Buffer.from('a{color:red}'),availableObservedAt:new Date().toISOString()});
  const latestResource=twoVersions?await capture.capture({position,frameId:'top',requestId:'request-2',url,mediaType:'text/css',data:Buffer.from('a{color:blue}'),availableObservedAt:new Date().toISOString(),source:{fromServiceWorker:true,encodedDataLength:13}}):resource;
  const independent=extraResource?await capture.capture({position,frameId:'top',requestId:'request-3',url:'https://synthetic.invalid/good.css',mediaType:'text/css',data:Buffer.from('body{color:black}'),availableObservedAt:new Date().toISOString()}):undefined;
  await store.seal();await store.close();
  const archive=new RecordingArchive(runDir),resources=new ResourceArchive(runDir);
  return{root,runDir,position,url,resource,latestResource,independent,archive,resources,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

describe('directed recording and resource index recovery',()=>{
  it('keeps legacy replay and resource readers after unpublished first generations',async()=>{
    const f=await fixture();try{
      await fs.mkdir(path.join(f.runDir,'replay-index-generations','unpublished'),{recursive:true});
      await fs.mkdir(path.join(f.runDir,'resource-url-index-generations','unpublished'),{recursive:true});
      expect((await f.archive.window(f.position)).records).toHaveLength(1);
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
      const fake={root:f.root,runs:[{id:'recording',status:'sealed'}],active:undefined} as unknown as Studio;
      expect(await inspectRunRecovery(fake,{runId:'recording'})).toMatchObject({indexDiagnostics:{replay:{state:'legacy'},resources:{state:'legacy'}}});
    }finally{await f.cleanup();}
  });
  it('keeps both legacy readers after first staging writes fail and preserves the staging directories',async()=>{
    const f=await fixture();try{
      const originalOpen=fs.open.bind(fs);
      const failedReplay=vi.spyOn(fs,'open').mockImplementation(async(file,...args)=>{
        if(String(file).includes('replay-index-generations')&&String(file).endsWith('.tmp'))throw Object.assign(new Error('synthetic replay disk full'),{code:'ENOSPC'});
        return originalOpen(file,...args);
      });
      try{await expect(f.archive.rebuild()).rejects.toMatchObject({code:'REPLAY_INDEX_WRITE_FAILED'});}
      finally{failedReplay.mockRestore();}
      const originalWrite=fs.writeFile.bind(fs);
      const mocked=vi.spyOn(fs,'writeFile').mockImplementation(async(file,...args)=>{
        if(String(file).includes('-generations')&&String(file).endsWith('.jsonl'))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});
        return originalWrite(file,...args);
      });
      try{
        await expect(f.resources.rebuildUrlIndex()).rejects.toMatchObject({code:'RESOURCE_INDEX_WRITE_FAILED'});
      }finally{mocked.mockRestore();}
      const replayDirectory=path.join(f.runDir,'replay-index-generations');
      expect((await fs.readdir(replayDirectory)).length).toBe(1);
      expect((await fs.readdir(path.join(f.runDir,'resource-url-index-generations'))).length).toBe(1);
      expect((await f.archive.window(f.position)).records).toHaveLength(1);
      expect((await f.resources.resolve(f.url,f.position))?.id).toBe(f.resource.id);
    }finally{vi.restoreAllMocks();await f.cleanup();}
  });
  it('does not erase a confirmed damaged newer resource version during rebuild',async()=>{
    const f=await fixture(true,true);try{
      await fs.writeFile(path.join(f.root,'blobs',f.latestResource.blobHash!),Buffer.from('a{color:cyan}'));
      const rebuilt=await f.resources.rebuildUrlIndex();
      expect(rebuilt.corruptCount).toBe(1);
      const version=await f.resources.resolve(f.url,f.position);
      expect(version?.id).toBe(f.latestResource.id);
      expect(version?.status).toBe('failed');expect(version?.reason).toContain('RESOURCE_INTEGRITY');
      expect(version?.mediaType).toBe(f.latestResource.mediaType);
      expect(version?.capturedAt).toBe(f.latestResource.capturedAt);
      expect(version?.source).toEqual(f.latestResource.source);
      expect(version?.bytes).toBe(f.latestResource.bytes);
      expect(version?.recovery).toMatchObject({status:'observed-unavailable',observedStatus:'captured'});
      const pointer=JSON.parse(await fs.readFile(path.join(f.runDir,'resource-url-index-current.json'),'utf8'));
      const tombstone=await fs.readFile(path.join(f.runDir,'resource-url-index-generations',pointer.generation,`${hashBytes(f.url)}.jsonl`),'utf8');
      expect(tombstone).not.toContain(f.url);
      expect((await f.resources.history(f.url,f.position,'top')).map(item=>item.id)).toContain(f.latestResource.id);
      expect((await f.resources.resolve('https://synthetic.invalid/good.css',f.position))?.id).toBe(f.independent?.id);
      expect((await f.resources.read(f.independent!.id)).bytes.toString()).toContain('black');
    }finally{await f.cleanup();}
  });
  it('distinguishes a URL with only a damaged observed version from an unobserved URL',async()=>{
    const f=await fixture();try{
      await fs.writeFile(path.join(f.root,'blobs',f.resource.blobHash!),Buffer.from('a{color:tan}'));
      await f.resources.rebuildUrlIndex();
      expect(await f.resources.resolve(f.url,f.position)).toMatchObject({id:f.resource.id,status:'failed'});
      expect((await f.resources.history(f.url,f.position,'top')).map(item=>item.id)).toEqual([f.resource.id]);
      expect(await f.resources.resolve('https://synthetic.invalid/never.css',f.position)).toBeUndefined();
    }finally{await f.cleanup();}
  });
  it('rejects valid JSON original edits against the sealed integrity ledger',async()=>{
    const f=await fixture();try{
      const raw=path.join(f.runDir,'raw','rrweb','rrweb-000001.jsonl');
      const original=await fs.readFile(raw,'utf8');
      await fs.writeFile(raw,original.replace('"width":800','"width":801'));
      expect(await fs.readFile(raw,'utf8')).not.toBe(original);
      await expect(f.archive.rebuild()).rejects.toMatchObject({code:'REPLAY_ORIGINAL_INTEGRITY'});
      expect(await fs.readFile(path.join(f.runDir,'integrity.json'),'utf8')).toContain('rrweb-000001.jsonl');
    }finally{await f.cleanup();}
  });
  it('keeps confirmed manifest tampering visible and rejects a changed sealed event journal',async()=>{
    const f=await fixture();try{
      const manifestPath=path.join(f.runDir,'resources',`${f.resource.id}.json`);
      const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      await fs.writeFile(manifestPath,JSON.stringify({...manifest,mediaType:'image/png'}));
      expect(await f.resources.rebuildUrlIndex()).toMatchObject({corruptCount:1});
      expect(await f.resources.resolve(f.url,f.position)).toMatchObject({id:f.resource.id,status:'failed'});
      const journal=path.join(f.runDir,'journal','events-000001.jsonl');
      const original=await fs.readFile(journal,'utf8');
      await fs.writeFile(journal,original.replace('text/css','image/png'));
      await expect(f.resources.rebuildUrlIndex()).rejects.toMatchObject({code:'RESOURCE_ORIGINAL_INTEGRITY'});
    }finally{await f.cleanup();}
  });
  it('reports a missing published pointer rather than claiming the legacy reader is current',async()=>{
    const f=await fixture();try{
      await f.archive.rebuild();await f.resources.rebuildUrlIndex();
      await fs.rm(path.join(f.runDir,'replay-index-current.json'));
      await fs.rm(path.join(f.runDir,'resource-url-index-current.json'));
      await expect(f.archive.window(f.position)).rejects.toMatchObject({code:'REPLAY_INDEX_MISSING'});
      await expect(f.resources.resolve(f.url,f.position)).rejects.toMatchObject({code:'RESOURCE_INDEX_MISSING'});
    }finally{await f.cleanup();}
  });
  it('marks an interrupted archive without a seal as unverified after a bounded rebuild',async()=>{
    const f=await fixture();try{
      const manifestPath=path.join(f.runDir,'manifest.json');const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      await fs.writeFile(manifestPath,JSON.stringify({...manifest,status:'interrupted'}));
      await fs.rm(path.join(f.runDir,'integrity.json'));
      expect(await f.archive.rebuild()).toMatchObject({verificationBasis:'unverified'});
      expect(await f.resources.rebuildUrlIndex()).toMatchObject({verificationBasis:'unverified'});
      for(const [prefix,current] of [['replay-index-generations','replay-index-current.json'],['resource-url-index-generations','resource-url-index-current.json']]){
        const pointer=JSON.parse(await fs.readFile(path.join(f.runDir,current),'utf8'));
        const generation=JSON.parse(await fs.readFile(path.join(f.runDir,prefix,pointer.generation,'index-manifest.json'),'utf8'));
        expect(generation.verificationBasis).toBe('unverified');
      }
      await expect(f.archive.window(f.position)).rejects.toMatchObject({code:'REPLAY_ORIGINAL_UNVERIFIED'});
      await expect(f.resources.resolve(f.url,f.position)).rejects.toMatchObject({code:'RESOURCE_ORIGINAL_UNVERIFIED'});
      const fake={root:f.root,runs:[{id:'recording',status:'interrupted'}],active:undefined} as unknown as Studio;
      expect(await inspectRunRecovery(fake,{runId:'recording'})).toMatchObject({indexDiagnostics:{replay:{state:'unverified'},resources:{state:'unverified'}}});
    }finally{await f.cleanup();}
  });
  it('holds the writer kernel guard across index maintenance',async()=>{
    const f=await fixture();try{
      const guard=await claimIndexMaintenance(f.runDir);
      try{await expect(EvidenceStore.open(f.runDir)).rejects.toMatchObject({code:'WRITER_BUSY'});}
      finally{await guard.release();}
      const reopened=await EvidenceStore.open(f.runDir);await reopened.close();
    }finally{await f.cleanup();}
  });
  it('retains the actual latest request version rather than whichever manifest is listed first',async()=>{
    const f=await fixture(true);try{
      const before=await f.resources.resolve(f.url,f.position);
      expect(before?.id).toBe(f.latestResource.id);
      expect((await f.resources.read(before!.id)).bytes.toString()).toContain('blue');
      await fs.rm(path.join(f.runDir,'resource-url-index'),{recursive:true});
      await f.resources.rebuildUrlIndex();
      const after=await f.resources.resolve(f.url,f.position);
      expect(after?.id).toBe(before?.id);
      expect((await f.resources.read(after!.id)).bytes).toEqual((await f.resources.read(before!.id)).bytes);
    }finally{await f.cleanup();}
  });
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
      expect((await f.archive.window(f.position)).records).toHaveLength(1);
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
      await expect(f.archive.rebuild()).rejects.toMatchObject({code:'REPLAY_ORIGINAL_INTEGRITY'});
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
