import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Studio } from '@/main/services/studio';
import { jsonLines } from '@/evidence/files';
import { clickSyntheticHuman } from './native-input';

async function fileHashes(directory:string):Promise<Record<string,string>>{
  const hashes:Record<string,string>={};
  async function visit(relative:string){for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);if(entry.isDirectory())await visit(name);
    else hashes[name]=createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex');
  }}
  await visit('');return hashes;
}
function findNode(node:any,id:string):any{if(node?.attributes?.id===id)return node;for(const child of node?.childNodes??[]){const found=findNode(child,id);if(found)return found;}return undefined;}

/** Actual WebContentsView, native input and recorder restart; no profile or
 * original data is copied. All generated files stay below the desktop BES_DATA.
 */
export async function runSessionScenarios(studio:Studio,origin:string){
  if(studio.active)await studio.seal();if(studio.state().session)await studio.closeSession();
  studio.window.setBrowserVisible(true);
  const project=await studio.createProject({name:'S0 session lifecycle',objective:'Stop records without destroying the live working page'});
  const profile=await studio.createProfile({projectId:project.id,name:'Synthetic session'});
  const report:{passed:boolean;checks:string[];[key:string]:unknown}={passed:false,checks:[],startedAt:new Date().toISOString()};
  try{
    await studio.startRun({projectId:project.id,profileId:profile.id,url:origin+'/orders'});
    const first=studio.required(),page=studio.current(),sessionId=studio.state().session!.sessionId;
    await page.page.waitForFunction(()=>document.querySelector('#api-state')?.textContent==='已就绪');
    await studio.control('agent');
    const command={pageId:page.pageId,generation:page.navigationGeneration,leaseEpoch:first.leaseEpoch};
    await studio.action({...command,type:'fill',selector:'#filter',value:'unsaved synthetic form'});
    await studio.action({...command,type:'click',selector:'#increment'});
    await studio.control('human');await page.capture.inspect(true);
    const before={targetId:page.targetId,webContentsId:page.webContentsId,pageId:page.pageId,generation:page.navigationGeneration,url:page.page.url()};
    await studio.seal();
    const originalHashes=await fileHashes(first.store.runDir);
    assert.equal(studio.active,undefined);assert.equal(studio.state().session?.recordingId,undefined);
    assert.equal(studio.current(),page);assert.equal(page.view.webContents.isDestroyed(),false);
    assert.equal(await page.page.$eval('#filter',element=>(element as HTMLInputElement).value),'unsaved synthetic form');
    await clickSyntheticHuman(studio,'#increment');
    await page.page.waitForFunction(()=>document.querySelector('#action-count')?.textContent==='2');
    report.checks.push('sealed page/input/JS state retained; inspection listeners removed; native input works');

    // The requested old start URL cannot silently replace the retained page.
    await studio.startRun({projectId:project.id,profileId:profile.id,url:origin+'/lab'});
    const second=studio.required();assert.notEqual(second,first);assert.notEqual(second.id,first.id);
    assert.equal(studio.state().session?.sessionId,sessionId);assert.equal(studio.current(),page);
    assert.deepEqual({targetId:page.targetId,webContentsId:page.webContentsId,pageId:page.pageId,generation:page.navigationGeneration,url:page.page.url()},before);
    assert.equal(await page.page.$eval('#filter',element=>(element as HTMLInputElement).value),'unsaved synthetic form');
    await page.capture.flush();
    let snapshots=0,currentCounter:string|undefined;
    for(const file of await readdir(path.join(second.store.runDir,'raw','rrweb'))){
      for await(const row of jsonLines(path.join(second.store.runDir,'raw','rrweb',file))){
        const record=row.value as any;if(record.payload?.event?.type!==2)continue;snapshots++;
        const counter=findNode(record.payload.event.data.node,'action-count');
        if(counter)currentCounter=(counter.childNodes??[]).map((child:any)=>child.textContent??'').join('');
      }
    }
    assert.ok(snapshots>0,'The next recording needs a real full snapshot without navigation');
    assert.equal(currentCounter,'2','The new snapshot must include actions made after the prior recording stopped');
    await studio.control('agent');await assert.rejects(()=>studio.action({...command,type:'click',selector:'#increment'}),/Stale lease/);await studio.control('human');
    report.checks.push('new run/store and full snapshot without navigation; old lease rejected');

    const originalStop=page.capture.stop;
    page.capture.stop=async()=>{throw new Error('Synthetic recorder teardown failure');};
    try{await assert.rejects(()=>studio.seal(),/Synthetic recorder teardown failure/);assert.equal(studio.active,second);assert.notEqual(second.store.manifest.status,'sealed');assert.equal(studio.state().session?.locked,true);}
    finally{page.capture.stop=originalStop;}
    await studio.seal();assert.equal(studio.active,undefined);assert.equal(studio.state().session?.locked,false);
    report.checks.push('teardown failure prevents sealed success; explicit retry retains data');

    const generation=page.navigationGeneration;await studio.navigate(origin+'/lab');
    assert.ok(page.navigationGeneration>generation,'Idle session navigation must advance identity');
    const livePage=studio.current();await studio.history(first.id);assert.equal(studio.current(),livePage);
    await studio.navigateHistory('back');assert.equal(new URL(page.page.url()).pathname,'/orders');
    await studio.navigateHistory('forward');assert.equal(new URL(page.page.url()).pathname,'/lab');
    await studio.navigateHistory('reload');
    assert.deepEqual(await fileHashes(first.store.runDir),originalHashes,'Restart, idle navigation and history reads cannot mutate sealed originals');
    report.checks.push('idle navigation identity, back/forward/reload and history isolation; sealed file hashes unchanged');
    await studio.closePage(page.pageId);assert.equal(page.view.webContents.isDestroyed(),true);assert.equal(studio.state().session?.pages.length,0);
    await studio.closeSession();assert.equal(studio.state().session,null);
    await studio.startRun({projectId:project.id,profileId:profile.id,url:origin+'/orders'});
    assert.notEqual(studio.state().session?.sessionId,sessionId);assert.notEqual(studio.current().targetId,before.targetId);
    await studio.seal();await studio.closeSession();
    report.checks.push('page/session close explicit; new session receives new session and target identities');
    Object.assign(report,{passed:true,firstRunId:first.id,secondRunId:second.id,sessionId,fullSnapshots:snapshots,originalFiles:Object.keys(originalHashes).length});
    console.log('S0 SESSION PASS: stop/restart preserves target/input/state, fresh snapshot, independent navigation identity, unchanged originals, teardown retry and explicit close');
  }catch(error){report.error=String(error);throw error;}
  finally{await writeFile(path.join(studio.root,'session-lifecycle-result.json'),JSON.stringify(report,null,2));}
}
