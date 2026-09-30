import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProjectMaterials } from '@/main/services/project-materials';
import { ProjectExecutions } from '@/main/services/project-executions';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';
import { dispatchProject } from '@/main/services/project-dispatch';
import { createBrowserMaterialPort } from '@/main/workbench/material-port';
import { createBrowserResultPort } from '@/main/workbench/result-port';
import { connectMaterialChanges } from '@/main/workbench/material-changes';
import { materialContentHash } from '@/materials/service';
import { projectLegacyRecording } from '@/materials/legacy';
import { assertProfileProvider } from '@/main/browser/runtime';
import type { Studio } from '@/main/services/studio';
import type { BrowserMaterialRequest } from '@/contracts/browser-materials';
import legacyFixed from '../fixtures/compatibility/legacy-fixed.json';
import legacyWorkspace from '../fixtures/compatibility/legacy-workspace.json';

afterEach(()=>vi.restoreAllMocks());
const projectId='legacy-project';
const budget={limit:50,maxBytes:24576};
/** Deliberately hand-built old-format disk fixtures, never GUI proof or migrated
 * login data. Golden bytes/hash catch read-time default injection. */
async function fixture(){
  await mkdir('output/dual-host-unit',{recursive:true});
  const root=await mkdtemp(path.resolve('output/dual-host-unit/case-'));
  const write=async(relative:string,value:unknown)=>{const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
  await write('workspace.json',await readFile('test/fixtures/compatibility/legacy-workspace.json','utf8'));
  await write('projects/legacy-project/materials/revisions/legacy-fixed.json',await readFile('test/fixtures/compatibility/legacy-fixed.json','utf8'));
  await write('runs/legacy-recording/manifest.json',{schemaVersion:1,id:'legacy-recording',projectId,status:'sealed',sealedAt:'2026-09-26T12:05:00.000Z'});
  await write('runs/legacy-recording/checkpoints.jsonl',JSON.stringify({id:'legacy-save',title:'Old observation',description:'Recorded without a replay position',requirementIds:[],savedAt:'2026-09-26T12:01:00.000Z'})+'\n{truncated-record\n');
  const binding={schemaVersion:1,executionId:'failed-execution',projectId,materialRevisionId:'legacy-fixed',materialContentHash:legacyFixed.contentHash,codeFingerprint:'b'.repeat(64),inputFingerprint:'c'.repeat(64),environmentRef:'legacy-project/legacy-profile',mode:'current-page-test'};
  await write('executions/failed-execution/binding.json',binding);
  await write('executions/failed-execution/host-state.json',{binding,runId:'legacy-recording',pageId:'legacy-page',validationId:'failed-validation',startedAt:'2026-09-26T13:00:00.000Z',finishedAt:'2026-09-26T13:00:01.000Z',status:'failed',snapshotVerified:true,workflowAttemptId:'failed-attempt',steps:[{identity:{executionId:'failed-execution',stepId:'read',attemptId:'failed-attempt'},state:'failed',error:{name:'Error',message:'Synthetic legacy failure /private/example'}}],datasets:[],assertions:[]});
  const commits=vi.fn(), materials=new ProjectMaterials(root,commits), executions=new ProjectExecutions(root,materials);
  const host:WorkspaceManagementHost={root,projects:[],profiles:[],state:()=>({})};const management=new WorkspaceManagement(host);await management.init();
  const studio={root,projects:host.projects,materials,executions} as unknown as Studio;
  const native=(method:string,body:Record<string,unknown>={})=>dispatchProject(studio,method,{projectId,...body},'ui');
  const port=createBrowserMaterialPort(root,materials), authorize=vi.fn();
  const browser=(method:BrowserMaterialRequest['method'],body:Record<string,unknown>={})=>port.execute({instanceId:'compatibility',method,body:{projectId,...body}} as BrowserMaterialRequest,{authorize});
  return {root,host,management,materials,executions,native,browser,commits,authorize,write};
}
async function bytes(root:string):Promise<Record<string,string>>{
  const output:Record<string,string>={};
  async function walk(relative:string){for(const item of await readdir(path.join(root,relative),{withFileTypes:true})){const name=path.posix.join(relative,item.name);if(item.isDirectory())await walk(name);else output[name]=createHash('sha256').update(await readFile(path.join(root,name))).digest('hex');}}
  await walk('');return output;
}

test('native and browser ports read exactly the same old fixed fields without defaults or byte rewrites',async()=>{
  const f=await fixture(), before=await bytes(f.root), identity={revisionId:legacyFixed.revisionId,contentHash:legacyFixed.contentHash};
  expect(materialContentHash(legacyFixed.content as never)).toBe(legacyFixed.contentHash);
  expect(await f.browser('materialRevision',identity)).toEqual(await f.native('materialRevision',identity));
  for(const collection of ['requirements','fields','checkpoints','annotations','recordingRefs']){
    const body={kind:'revision',...identity,collection,...budget};
    expect(await f.browser('materialCollection',body)).toEqual(await f.native('materialCollection',body));
  }
  const material=await f.materials.service.revision(projectId,legacyFixed.revisionId,legacyFixed.contentHash);
  expect(material.content).toEqual(legacyFixed.content);expect(material.content.taskBrief).toBeUndefined();
  expect(material.content.fields[0]).not.toHaveProperty('valueType');expect(material.content.fields[0]).not.toHaveProperty('examples');
  const source=await projectLegacyRecording(f.root,projectId,'legacy-recording',budget);
  expect(source.sourceStatus).toBe('partial');expect(source.invalidRecords).toBe(1);expect(source.items[0].anchorStatus).toBe('unavailable');
  expect(source.items[0]).not.toHaveProperty('anchor');
  await expect(f.browser('recordingStreams',{recordingId:'legacy-recording'})).rejects.toBeTruthy();
  expect(await bytes(f.root)).toEqual(before);expect(f.commits).not.toHaveBeenCalled();
});

test('failed legacy execution stays failed through both result readers; only private diagnostics are projected',async()=>{
  const f=await fixture(),before=await bytes(f.root),port=createBrowserResultPort(f.executions);
  const browser=await port.execute({instanceId:'compatibility',method:'execution',body:{projectId,executionId:'failed-execution'}},{authorize:()=>{}}) as any;
  const native=await f.native('execution',{executionId:'failed-execution'}) as any;
  expect(browser.status).toBe('failed');expect(browser.counts).toEqual(native.counts);expect(browser.binding.materialContentHash).toBe(native.binding.materialContentHash);
  expect(browser.binding).not.toHaveProperty('environmentRef');
  const steps=await port.execute({instanceId:'compatibility',method:'executionItems',body:{projectId,executionId:'failed-execution',collection:'steps',...budget}},{authorize:()=>{}}) as any;
  expect(steps.items[0].state).toBe('failed');expect(steps.items[0].identity).toEqual({executionId:'failed-execution',stepId:'read',attemptId:'failed-attempt'});
  expect(steps.items[0].error.message).not.toContain('Electron');expect(steps.items[0].error.message).not.toContain('/private');
  expect(await bytes(f.root)).toEqual(before);
});

test('workspace management preserves omitted providers and custom storage during native/Node reads and rename',async()=>{
  const f=await fixture(),before=await bytes(f.root);
  expect(f.host.profiles).toEqual(legacyWorkspace.profiles);
  for(const profile of f.host.profiles){assertProfileProvider(profile,'electron');expect(()=>assertProfileProvider(profile,'chromium')).toThrow('different browser provider');}
  expect(await bytes(f.root)).toEqual(before);
  await f.management.updateProfile({projectId,profileId:'legacy-profile',expectedRevision:0,name:'Renamed legacy',operationId:'rename-legacy'});
  expect(f.host.profiles[0].storageRef).toBe('persist:custom-legacy-login');expect(f.host.profiles[0]).not.toHaveProperty('provider');expect(f.host.profiles[1]).not.toHaveProperty('storageRef');
  const after=await bytes(f.root);for(const [file,hash] of Object.entries(before))if(file!=='workspace.json')expect(after[file]).toBe(hash);
});

test('native and browser material writes share commit events, idempotent publication and retained legacy evidence',async()=>{
  const f=await fixture(),before=await bytes(f.root),invalidate=vi.fn(),changed=vi.fn();
  connectMaterialChanges(f.materials,invalidate,changed);
  const draft=await f.native('createMaterialDraft',{baseRevisionId:'legacy-fixed',operationId:'derive-legacy'}) as any;
  expect(await f.browser('materialDraft',{draftId:draft.draftId})).toEqual(await f.native('materialDraft',{draftId:draft.draftId}));
  invalidate.mockClear();changed.mockClear();
  await f.browser('editMaterialDraft',{draftId:draft.draftId,expectedDraftRevision:0,edits:[{operation:'task-brief',taskBrief:{objective:'New explicit brief',scope:''}}]});
  expect(invalidate).toHaveBeenCalledWith(projectId);expect(changed).toHaveBeenCalled();
  expect(f.commits).toHaveBeenCalledWith(projectId,'material-draft-saved',{draftId:draft.draftId,draftRevision:'1'});
  const count=f.commits.mock.calls.length;invalidate.mockClear();changed.mockClear();
  expect((await f.native('editMaterialDraft',{draftId:draft.draftId,expectedDraftRevision:0,edits:[{operation:'task-brief',taskBrief:{objective:'Stale',scope:''}}]}) as any).status).toBe('conflict');
  expect(f.commits).toHaveBeenCalledTimes(count);expect(invalidate).not.toHaveBeenCalled();
  await f.browser('materialDraft',{draftId:draft.draftId});
  await f.native('materialDraft',{draftId:draft.draftId});
  expect(invalidate).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
  const input={draftId:draft.draftId,expectedDraftRevision:1,operationId:'publish-shared'};
  const fixed=await f.native('publishMaterialDraft',input) as any;
  expect(await f.browser('publishMaterialDraft',input)).toEqual(fixed);
  // Receipt replay preserves prior native semantics: same revision, repeated notification.
  expect(f.commits.mock.calls.filter(([,type])=>type==='material-revision-published')).toHaveLength(2);
  expect(f.commits).toHaveBeenLastCalledWith(projectId,'material-revision-published',{revisionId:fixed.revisionId,contentHash:fixed.contentHash});
  expect((await f.browser('materialRevisions',budget) as any).items).toHaveLength(2);
  const after=await bytes(f.root);for(const [file,hash] of Object.entries(before))expect(after[file]).toBe(hash);
  f.commits.mockImplementation(()=>{throw new Error('Observer failed after commit');});
  await expect(f.browser('editMaterialDraft',{draftId:draft.draftId,expectedDraftRevision:2,edits:[{operation:'task-brief',taskBrief:{objective:'Still durable',scope:''}}]})).resolves.toMatchObject({status:'saved'});
  await expect(f.browser('publishMaterialDraft',{draftId:draft.draftId,expectedDraftRevision:3,operationId:'publish-observer-failure'})).resolves.toMatchObject({projectId});
  expect((await f.browser('materialRevisions',budget) as any).items).toHaveLength(3);
});
