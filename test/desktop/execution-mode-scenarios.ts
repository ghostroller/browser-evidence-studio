import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';

async function completed(studio:Studio,id:string){
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    const record=await studio.validation(id);
    if(['completed','failed','cancelled','interrupted'].includes(record.status)&&Boolean(record.artifactId||record.error)){
      assert.equal(record.status,'completed',record.result?.error??record.error);
      assert.equal(record.result?.validation.overall,'pass');return record;
    }
    await delay(50);
  }
  throw new Error('Execution-mode workflow did not commit its terminal record');
}

/** Ordinary worker code reads its initial page before any navigation. The two
 * modes must make different, inspectable claims about the same live session.
 */
export async function runExecutionModeScenarios(studio:Studio,origin:string){
  if(studio.active)await studio.seal();if(studio.state().session)await studio.closeSession();
  const directory=await mkdtemp(path.join(studio.root,'execution-mode-workflow-'));
  await writeFile(path.join(directory,'run.mjs'),`
    export async function run({ page, reporter }) {
      const initial = await page.evaluate(() => ({
        url: location.href, marker: window.__syntheticModeMarker ?? null,
        form: document.querySelector('#filter')?.value ?? null,
        profileCookiePresent: document.cookie.split('; ').some(cookie => cookie.startsWith('synthetic-mode-profile='))
      }));
      const checkpoint = await reporter.checkpoint('initial-state', { title: 'Synthetic execution mode initial state' });
      await reporter.emitData('initial-state', [initial], { origin: 'browser', sourceRefs: [checkpoint.id] });
      return { count: 1 };
    }
  `);
  await writeFile(path.join(directory,'workflow.json'),JSON.stringify({schemaVersion:1,workflowId:'synthetic-execution-mode',entry:'./run.mjs',exportName:'run',driver:'puppeteer',requirements:[{id:'initial-state',checkpointKey:'initial-state',description:'Capture the actual initial browser state',dataset:'initial-state',rules:[{type:'min-rows',count:1},{type:'required',field:'url'}]}]},null,2));
  const project=await studio.createProject({name:'S0 explicit execution modes',objective:'Separate a current-page trial from a new-page validation',scriptDirectory:directory});
  const profile=await studio.createProfile({projectId:project.id,name:'Synthetic shared profile'});
  const report:{passed:boolean;checks:string[];[key:string]:unknown}={passed:false,checks:[],startedAt:new Date().toISOString()};
  try{
    await studio.startRun({projectId:project.id,profileId:profile.id,url:origin+'/orders'});
    const source=studio.current(),sourceRun=studio.required(),sessionId=studio.state().session!.sessionId,marker=randomUUID();
    await source.page.waitForFunction(()=>document.querySelector('#api-state')?.textContent==='已就绪');
    await studio.control('agent');
    await studio.action({pageId:source.pageId,generation:source.navigationGeneration,leaseEpoch:sourceRun.leaseEpoch,type:'fill',selector:'#filter',value:'unsaved current-page form'});
    // Synthetic setup owns agent control; this is a deliberately unpersisted JS
    // value which a navigate/new-target implementation cannot accidentally pass.
    await source.page.evaluate(value=>{(window as any).__syntheticModeMarker=value;},marker);
    await sourceRun.session.cookies.set({url:origin,name:'synthetic-mode-profile',value:'synthetic-shared-profile'});
    await studio.control('human');
    const generation=source.navigationGeneration;
    await assert.rejects(()=>studio.validate({projectId:project.id,profileId:profile.id,executionMode:'current-page-test',pageId:source.pageId,generation:generation+1,input:{}}),/generation|identity|target|page/i);
    assert.equal(studio.active,sourceRun);assert.equal(studio.current(),source);
    report.checks.push('stale current-page generation rejected before replacing run or target');

    const current=await studio.validate({projectId:project.id,profileId:profile.id,executionMode:'current-page-test',pageId:source.pageId,generation,input:{}});
    const currentRecord=await completed(studio,current.id),currentRun=studio.required();
    const initial=currentRecord.result!.datasets.find(dataset=>dataset.name==='initial-state')?.records[0] as any;
    assert.ok(initial);assert.equal(initial.marker,marker);assert.equal(initial.form,'unsaved current-page form');assert.equal(initial.profileCookiePresent,true);
    assert.equal(studio.current().targetId,source.targetId);assert.equal(studio.current().pageId,source.pageId);assert.equal(source.navigationGeneration,generation);
    assert.equal(studio.state().session?.sessionId,sessionId);assert.equal(currentRun.store.manifest.executionMode,'current-page-test');
    report.checks.push('current-page trial retains exact target, form, JS heap marker and navigation generation');

    const startUrl=origin+'/orders?from-start-mode=1';
    const fresh=await studio.validate({projectId:project.id,profileId:profile.id,executionMode:'from-start-validation',startUrl,input:{}});
    const freshRecord=await completed(studio,fresh.id),freshRun=studio.required(),freshPage=studio.current();
    const started=freshRecord.result!.datasets.find(dataset=>dataset.name==='initial-state')?.records[0] as any;
    assert.ok(started);assert.equal(started.url,startUrl);assert.equal(started.marker,null);assert.equal(started.form,'');assert.equal(started.profileCookiePresent,true);
    assert.notEqual(freshPage.targetId,source.targetId);assert.notEqual(freshPage.pageId,source.pageId);
    assert.equal(source.view.webContents.isDestroyed(),false);assert.ok(freshRun.pages.has(source.pageId));
    assert.equal(await source.page.$eval('#filter',element=>(element as HTMLInputElement).value),'unsaved current-page form');
    assert.equal(await source.page.evaluate(()=>(window as any).__syntheticModeMarker),marker);
    assert.equal(studio.state().session?.sessionId,sessionId);assert.equal(freshRun.store.manifest.executionMode,'from-start-validation');
    report.checks.push('from-start validation creates a new page at explicit URL, reuses profile, retains original live target');
    await studio.seal();
    const currentManifest=JSON.parse(await readFile(path.join(currentRun.store.runDir,'manifest.json'),'utf8'));
    const freshManifest=JSON.parse(await readFile(path.join(freshRun.store.runDir,'manifest.json'),'utf8'));
    const catalog=JSON.parse(await readFile(path.join(studio.root,'validations.json'),'utf8')) as any[];
    assert.equal(currentManifest.executionMode,'current-page-test');assert.equal(freshManifest.executionMode,'from-start-validation');
    assert.equal(catalog.find(record=>record.id===current.id)?.executionMode,'current-page-test');
    assert.equal(catalog.find(record=>record.id===fresh.id)?.executionMode,'from-start-validation');
    report.checks.push('run manifests and committed validation catalog persist distinct execution modes');
    for(const page of [...studio.state().session!.pages])await studio.closePage(page.pageId);
    assert.equal(studio.state().session?.pages.length,0);
    const emptyStarted=await studio.validate({projectId:project.id,profileId:profile.id,executionMode:'from-start-validation',startUrl,input:{}});
    await completed(studio,emptyStarted.id);
    assert.equal(studio.current().page.url(),startUrl);
    report.checks.push('empty retained session can create a fresh from-start target');
    await studio.seal();await studio.closeSession();
    await studio.startRun({projectId:project.id,profileId:profile.id,url:origin+'/orders',kind:'validate'});
    const prepared=studio.current();
    const defaultStarted=await studio.validate({projectId:project.id,profileId:profile.id,startUrl,input:{}});
    await completed(studio,defaultStarted.id);
    assert.notEqual(studio.current().targetId,prepared.targetId);
    assert.equal(studio.current().page.url(),startUrl);
    assert.equal(studio.required().store.manifest.executionMode,'from-start-validation');
    report.checks.push('omitted mode uses a fresh from-start target and honors startUrl even after a prepared validate run');
    await studio.seal();
    await studio.closeSession();
    Object.assign(report,{passed:true,currentRunId:current.runId,fromStartRunId:fresh.runId,currentValidationId:current.id,fromStartValidationId:fresh.id,sessionId});
    console.log('S0 EXECUTION MODES PASS: stale target denied, current-page initial state retained, from-start uses explicit fresh target, shared profile and persistent mode records');
  }catch(error){report.error=String(error);throw error;}
  finally{await writeFile(path.join(studio.root,'execution-mode-result.json'),JSON.stringify(report,null,2));}
}
