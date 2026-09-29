import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileMaterialService } from '@/materials/service';

let root: string;
let service: FileMaterialService;
beforeEach(async () => {
  const parent = path.resolve('output/workspace-catalog');
  await fs.mkdir(parent, { recursive: true });
  root = await fs.mkdtemp(path.join(parent, 'case-'));
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project', objective: 'Original goal' }] }));
  service = new FileMaterialService(root);
});
it('atomically chooses one default copy and retains the explicit selection across restart', async () => {
  const [a, b] = await Promise.all([service.workingDraft('project'), service.workingDraft('project')]);
  expect(a.draftId).toBe(b.draftId);
  const other = await service.createDraft('project', 'human');
  await service.setWorkingDraft('project', other.draftId);
  expect((await new FileMaterialService(root).workingDraft('project')).draftId).toBe(other.draftId);
  expect((await service.listDrafts('project', { limit: 100, maxBytes: 28000 })).items).toHaveLength(2);
});
it('keeps 61 version numbers and chronological pagination stable after restart', async () => {
  const draft = await service.workingDraft('project');
  // Genuine service publication; no test-only file model.
  for (let n = 0; n < 61; n++) await service.publish('project', draft.draftId, n, 'human');
  const first = await service.listRevisions('project', { limit: 50, maxBytes: 28000 });
  const second = await service.listRevisions('project', { limit: 50, maxBytes: 28000, cursor: first.nextCursor });
  const all = [...first.items, ...second.items];
  expect(all).toHaveLength(61);
  expect(all.every(item => item.status === 'available')).toBe(true);
  expect(all.map(item => item.status === 'available' ? item.displayNumber : 0)).toEqual(Array.from({ length: 61 }, (_, n) => 61 - n));
  expect(await new FileMaterialService(root).listRevisions('project', { limit: 50, maxBytes: 28000 })).toEqual(first);
});
it('reports brief-only changes without changing the previous fixed content', async () => {
  const draft = await service.workingDraft('project');
  const v1 = await service.publish('project', draft.draftId, 0, 'human');
  await service.updateDraft('project', draft.draftId, 1, { ...draft.content, taskBrief: { objective: 'New goal', scope: 'Two records' } }, 'human');
  const v2 = await service.publish('project', draft.draftId, 2, 'human');
  const diff = await service.diff('project', v1.revisionId, v2.revisionId, { limit: 50, maxBytes: 28000 });
  expect(diff.items).toEqual([{ collection: 'taskBrief', id: 'taskBrief', change: 'changed', changedFields: ['objective', 'scope'] }]);
  expect((await service.revision('project', v1.revisionId, v1.contentHash)).content.taskBrief?.objective).toBe('Original goal');
});


afterEach(()=>vi.restoreAllMocks());
it('new workcopy creation recovers its prepared identity after write failure and restart',async()=>{
 const link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(String(b).endsWith('create-new-copy.json'))throw Object.assign(new Error('create failed'),{code:'EIO'});return link(a,b);});
 await expect(service.createDraft('project','human',undefined,'new-copy')).rejects.toThrow('create failed');vi.restoreAllMocks();
 const restart=new FileMaterialService(root),created=await restart.createDraft('project','human',undefined,'new-copy');
 await restart.updateDraft('project',created.draftId,0,{...created.content,taskBrief:{objective:'Later edit',scope:''}},'human');
 expect((await restart.createDraft('project','human',undefined,'new-copy')).content.taskBrief?.objective).toBe('Later edit');
 expect((await restart.listDrafts('project',{limit:100,maxBytes:28000})).items).toHaveLength(1);
 await expect(restart.createDraft('project','agent',undefined,'new-copy')).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
});
it('directory replacement failure leaves memory and disk unchanged and retry survives restart',async()=>{
 const draft=await service.workingDraft('project'),before=await service.workspaceCatalog('project');
 vi.spyOn(fs,'rename').mockImplementationOnce(async()=>{throw Object.assign(new Error('disk write failed'),{code:'EIO'});});
 await expect(service.manageCatalog('project',{kind:'drafts',id:draft.draftId,expectedCatalogRevision:before.catalogRevision,name:'Renamed'})).rejects.toThrow('disk write failed');
 expect(await new FileMaterialService(root).workspaceCatalog('project')).toEqual(before);
 vi.restoreAllMocks();await service.manageCatalog('project',{kind:'drafts',id:draft.draftId,expectedCatalogRevision:before.catalogRevision,name:'Renamed'});
 expect((await new FileMaterialService(root).workspaceCatalog('project')).drafts[draft.draftId].name).toBe('Renamed');
});
it('copy operation recovers the prepared snapshot after manifest failure without another identity',async()=>{
 const source=await service.workingDraft('project');const link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(String(b).endsWith('copy-copy-op.json'))throw Object.assign(new Error('copy write failed'),{code:'EIO'});return link(a,b);});
 await expect(service.copyDraft('project',source.draftId,0,'copy-op')).rejects.toThrow('copy write failed');vi.restoreAllMocks();
 await service.updateDraft('project',source.draftId,0,{...source.content,taskBrief:{objective:'Later',scope:''}},'human');
 const restart=new FileMaterialService(root),copy=await restart.copyDraft('project',source.draftId,0,'copy-op');
 expect(copy.content).toEqual(source.content);expect((await restart.copyDraft('project',source.draftId,0,'copy-op')).draftId).toBe(copy.draftId);
 await expect(restart.copyDraft('project',source.draftId,1,'copy-op')).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
 expect((await restart.listDrafts('project',{limit:100,maxBytes:28000})).items).toHaveLength(2);
});
it('archive journal recovers a prepared manifest and a later pointer failure without duplicate versions',async()=>{
 const draft=await service.workingDraft('project');const link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(String(b).includes(path.sep+'revisions'+path.sep))throw Object.assign(new Error('manifest failed'),{code:'EIO'});return link(a,b);});
 await expect(service.publish('project',draft.draftId,0,'human','archive-op')).rejects.toThrow('manifest failed');vi.restoreAllMocks();
 expect((await service.publicationStatus('project','archive-op')).stage).toBe('prepared');
 const rename=fs.rename.bind(fs);vi.spyOn(fs,'rename').mockImplementation(async(a,b)=>{if(String(b).endsWith(draft.draftId+'.json'))throw Object.assign(new Error('pointer failed'),{code:'EIO'});return rename(a,b);});
 await expect(service.publish('project',draft.draftId,0,'human','archive-op')).rejects.toMatchObject({code:'PUBLISH_DRAFT_ADVANCE_FAILED'});vi.restoreAllMocks();
 const restart=new FileMaterialService(root);expect((await restart.publicationStatus('project','archive-op')).stage).toBe('manifest-saved');
 const revision=await restart.publish('project',draft.draftId,0,'human','archive-op');
 await restart.updateDraft('project',draft.draftId,1,{...draft.content,taskBrief:{objective:'Later edit',scope:''}},'human');
 expect((await restart.publish('project',draft.draftId,0,'human','archive-op')).revisionId).toBe(revision.revisionId);
 expect((await restart.getDraft('project',draft.draftId)).content.taskBrief?.objective).toBe('Later edit');
 expect((await restart.listRevisions('project',{limit:100,maxBytes:28000})).items).toHaveLength(1);
});
it('removed copies retain content and cannot hide the current or unresolved capture copy',async()=>{
 const first=await service.workingDraft('project'),other=await service.createDraft('project','human');let catalog=await service.workspaceCatalog('project');
 await expect(service.manageCatalog('project',{kind:'drafts',id:first.draftId,expectedCatalogRevision:catalog.catalogRevision,hidden:true})).rejects.toMatchObject({code:'CURRENT_WORKING_COPY'});
 await fs.mkdir(path.join(root,'authoring'));await fs.writeFile(path.join(root,'authoring','pending.json'),JSON.stringify({projectId:'project',draftId:other.draftId,stage:'receipt-saved'}));
 await expect(service.manageCatalog('project',{kind:'drafts',id:other.draftId,expectedCatalogRevision:catalog.catalogRevision,hidden:true})).rejects.toMatchObject({code:'PENDING_AUTHORING'});
 await fs.writeFile(path.join(root,'authoring','pending.json'),JSON.stringify({projectId:'project',draftId:other.draftId,stage:'associated'}));
 catalog=await service.manageCatalog('project',{kind:'drafts',id:other.draftId,expectedCatalogRevision:catalog.catalogRevision,hidden:true});
 await expect(service.setWorkingDraft('project',other.draftId)).rejects.toThrow();expect((await service.getDraft('project',other.draftId)).content).toEqual(other.content);
 await service.manageCatalog('project',{kind:'drafts',id:other.draftId,expectedCatalogRevision:catalog.catalogRevision,hidden:false});
 await service.setWorkingDraft('project',other.draftId);expect((await new FileMaterialService(root).workingDraft('project')).draftId).toBe(other.draftId);
});
