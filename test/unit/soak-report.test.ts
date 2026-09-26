import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSoakReport } from '../desktop/soak-report';

const locked=()=>Object.assign(new Error('Windows reader temporarily holds destination'),{code:'EPERM'});
afterEach(()=>vi.restoreAllMocks());
describe('soak report publication',()=>{
  it('retries a concurrent-read replacement using one UUID staging file and publishes complete JSON',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'bes-soak-report-'));
    try{
      const destination=path.join(root,'soak-progress.json');
      await fs.writeFile(destination,JSON.stringify({status:'previous'}));
      const realRename=fs.rename.bind(fs),staged:string[]=[];let contention=0;
      vi.spyOn(fs,'rename').mockImplementation(async(source,target)=>{
        if(String(target)===destination){
          staged.push(String(source));
          expect(JSON.parse(await fs.readFile(destination,'utf8'))).toEqual({status:'previous'});
          if(contention++<2)throw locked();
        }
        return realRename(source,target);
      });
      await saveSoakReport(root,{status:'running',cycles:1081});
      expect(staged).toHaveLength(3);
      expect(new Set(staged).size).toBe(1);
      expect(staged[0]).toMatch(/soak-progress\.json\.[a-f0-9-]{36}\.tmp$/);
      expect(JSON.parse(await fs.readFile(destination,'utf8'))).toEqual({status:'running',cycles:1081});
      expect(JSON.parse(await fs.readFile(path.join(root,'soak-result.json'),'utf8'))).toEqual({status:'running',cycles:1081});
      expect((await fs.readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it('propagates a vanished staging path and keeps the previous complete report',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'bes-soak-report-'));
    try{
      const destination=path.join(root,'soak-progress.json');
      await fs.writeFile(destination,JSON.stringify({status:'previous'}));
      const realRename=fs.rename.bind(fs);
      vi.spyOn(fs,'rename').mockImplementation(async(source,target)=>{
        if(String(target)===destination){await fs.rm(source);return realRename(source,target);}
        return realRename(source,target);
      });
      await expect(saveSoakReport(root,{status:'running'})).rejects.toMatchObject({code:'ENOENT'});
      expect(JSON.parse(await fs.readFile(destination,'utf8'))).toEqual({status:'previous'});
      expect((await fs.readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it('does not turn persistent replacement denial into a successful report',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'bes-soak-report-'));
    try{
      const destination=path.join(root,'soak-progress.json');
      await fs.writeFile(destination,JSON.stringify({status:'previous'}));
      const realRename=fs.rename.bind(fs);let attempts=0;
      vi.spyOn(fs,'rename').mockImplementation(async(source,target)=>{
        if(String(target)===destination){attempts++;throw locked();}
        return realRename(source,target);
      });
      await expect(saveSoakReport(root,{status:'completed',passed:true})).rejects.toMatchObject({code:'EPERM'});
      expect(attempts).toBeGreaterThan(1);
      expect(JSON.parse(await fs.readFile(destination,'utf8'))).toEqual({status:'previous'});
      expect((await fs.readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
