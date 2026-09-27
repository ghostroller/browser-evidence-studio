import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProjectMaterials } from '@/main/services/project-materials';
import { FileMaterialService, materialContentHash } from '@/materials';

async function setup(){
  const parent=path.resolve('output/product-unit');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'case-'));
  await writeFile(path.join(root,'workspace.json'),JSON.stringify({schemaVersion:1,projects:[{id:'project',objective:'Two displayed amounts'}]}));
  const materials=new ProjectMaterials(root);const draft=await materials.service.createDraft('project','human');
  return {root,materials,draft};
}
it('UI-created requirement acquires its unique dataset and rejects a contradictory link',async()=>{
  const {materials,draft}=await setup();
  const field={id:'amount',name:'实付金额',description:'Displayed amount',dataset:'orders',sourcePolicy:'page-displayed' as const};
  const result=await materials.edit('project',draft.draftId,0,[{operation:'upsert',collection:'requirements',item:{id:'required',description:'Both orders',fieldIds:['amount'],rules:[]}},{operation:'upsert',collection:'fields',item:field}],'ui');
  expect(result.status).toBe('saved');const saved=await materials.service.getDraft('project',draft.draftId);expect(saved.content.requirements[0].dataset).toBe('orders');
  await expect(materials.edit('project',draft.draftId,saved.draftRevision,[{operation:'upsert',collection:'fields',item:{...field,dataset:'accounts'}}],'ui')).rejects.toThrow('conflicts');
});
it('ordinary field edits keep an existing binding; only explicit clear removes it',async()=>{
  const {root,materials,draft}=await setup();await mkdir(path.join(root,'runs','recording'),{recursive:true});await writeFile(path.join(root,'runs','recording','manifest.json'),JSON.stringify({id:'recording',projectId:'project',schemaVersion:2}));
  Object.defineProperty(materials,'service',{value:new FileMaterialService(root,{position:async()=> 'reliable',target:async()=>true})});
  const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',eventSeq:1,sourceTimeMs:1000};
  const target={kind:'dom-node' as const,position,nodeId:7,frameId:'frame',mirrorScopeId:'mirror'};
  const content={...draft.content,recordingRefs:['recording'],checkpoints:[{id:'card',kind:'observation' as const,anchor:position,capturedAt:new Date(1000).toISOString(),createdAt:new Date().toISOString(),title:'Example',notes:'',requirementIds:[],annotationIds:[]}],fields:[{id:'field',name:'Amount',description:'Old',dataset:'orders',sourcePolicy:'page-displayed' as const,target,checkpointId:'card',bindingStatus:'bound' as const}]};
  await materials.service.updateDraft('project',draft.draftId,0,content,'human');
  await materials.edit('project',draft.draftId,1,[{operation:'upsert',collection:'fields',item:{id:'field',name:'Amount',description:'New',dataset:'orders',sourcePolicy:'page-displayed'}},{operation:'field-binding',fieldId:'field',binding:{kind:'keep'}}],'ui');
  expect((await materials.service.getDraft('project',draft.draftId)).content.fields[0].target).toEqual(target);
  await materials.edit('project',draft.draftId,2,[{operation:'field-binding',fieldId:'field',binding:{kind:'clear'}}],'ui');
  expect((await materials.service.getDraft('project',draft.draftId)).content.fields[0].target).toBeUndefined();
});
it('old fixed material without task brief retains its hash and receives no read-time defaults',async()=>{
  const {materials,draft}=await setup();const {taskBrief,...legacy}=draft.content;const before=materialContentHash(legacy);
  await materials.service.updateDraft('project',draft.draftId,0,legacy,'human');const fixed=await materials.service.publish('project',draft.draftId,1,'human');
  expect(fixed.contentHash).toBe(before);expect((await materials.service.revision('project',fixed.revisionId)).content.taskBrief).toBeUndefined();
});
