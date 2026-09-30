import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import React, { useState } from 'react';
import { vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectMaterials, materialSummary } from '@/main/services/project-materials';
import { FileMaterialService } from '@/materials';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';
import type { MaterialContent, TaskMaterialRevision } from '@/contracts/materials';
import type { WorkspaceView } from '@/contracts/workspace';

export const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',eventSeq:1,sourceTimeMs:1000};
export const target={kind:'dom-node' as const,position,frameId:'top',mirrorScopeId:'mirror',nodeId:1};
export function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
export async function fixture(options:{cards?:number;empty?:boolean}={}) {
  await mkdir('output/workspace-components',{recursive:true});const root=await mkdtemp(path.resolve('output/workspace-components/case-'));
  await mkdir(path.join(root,'runs','recording'),{recursive:true});await writeFile(path.join(root,'runs','recording','manifest.json'),JSON.stringify({schemaVersion:2,id:'recording',projectId:'project',status:'sealed'}));
  await writeFile(path.join(root,'workspace.json'),JSON.stringify({schemaVersion:1,projects:[{id:'project',objective:'Displayed amounts'},{id:'other-project'}]}));
  const materials=new ProjectMaterials(root);Object.defineProperty(materials,'service',{value:new FileMaterialService(root,{position:async()=> 'reliable',target:async()=>true})});
  let draft=await materials.service.workingDraft('project');
  const content:MaterialContent={taskBrief:{objective:'Displayed amounts',scope:'two orders'},recordingRefs:['recording'],requirements:[{id:'requirement',description:'Amounts',fieldIds:['amount'],rules:[],dataset:'records'}],fields:[{id:'amount',name:'Paid amount',description:'Amount displayed',dataset:'records',valueType:'number',sourcePolicy:'page-displayed',target,checkpointId:'card-0',bindingStatus:'bound'}],checkpoints:Array.from({length:options.cards??2},(_,n)=>({id:`card-${n}`,title:`Example ${n+1}`,notes:'',kind:'observation' as const,anchor:position,capturedAt:new Date(1000).toISOString(),createdAt:new Date(1000+n).toISOString(),requirementIds:['requirement'],annotationIds:n===0?['note']:[]})),annotations:[{id:'note',checkpointId:'card-0',target,text:'Original note',author:'human',interpretation:'observed',bindingStatus:'bound'}]};
  if(!options.empty){await materials.service.updateDraft('project',draft.draftId,0,content,'human');draft=await materials.service.getDraft('project',draft.draftId);}
  const fixed:TaskMaterialRevision[]=[];let failEdit=false;
  const call=vi.fn(async(method:string,body:any={}):Promise<any>=>{
    const projectId=body.projectId??'project', service=materials.service;
    if(method==='workingMaterialDraft')return materialSummary(await service.workingDraft(projectId));
    if(method==='materialDraft')return materialSummary(await service.getDraft(projectId,body.draftId));
    if(method==='materialDrafts')return service.listDrafts(projectId,{limit:body.limit??50,maxBytes:24576,cursor:body.cursor});
    if(method==='materialRevisions')return service.listRevisions(projectId,{limit:body.limit??50,maxBytes:24576,cursor:body.cursor});
    if(method==='materialCatalog')return service.workspaceCatalog(projectId);
    if(method==='manageMaterialCatalog')return service.manageCatalog(projectId,body);
    if(method==='materialEntity')return service.entity(projectId,{kind:body.kind,id:body.kind==='draft'?body.draftId:body.revisionId,expectedHash:body.contentHash},body.collection,body.entityId);
    if(method==='materialCollection')return service.pageCollection(projectId,{kind:body.kind,id:body.kind==='draft'?body.draftId:body.revisionId,expectedHash:body.contentHash},body.collection,{limit:50,maxBytes:24576,cursor:body.cursor});
    if(method==='editMaterialDraft'){if(failEdit)throw new Error('disk unavailable');return materials.edit(projectId,body.draftId,body.expectedDraftRevision,body.edits,'ui');}
    if(method==='publishMaterialDraft'){const value=await service.publish(projectId,body.draftId,body.expectedDraftRevision,'human',body.operationId);fixed.push(value);return materialSummary(value);}
    if(method==='materialRevision')return materialSummary(await service.revision(projectId,body.revisionId,body.contentHash));
    if(method==='materialDiff')return service.diff(projectId,body.fromRevisionId,body.toRevisionId,{limit:100,maxBytes:28672,cursor:body.cursor});
    if(method==='createMaterialDraft')return materialSummary(await service.createDraft(projectId,'human',body.baseRevisionId,body.operationId));
    if(method==='setWorkingMaterialDraft')return materialSummary(await service.setWorkingDraft(projectId,body.draftId));
    if(method==='copyMaterialDraft')return materialSummary(await service.copyDraft(projectId,body.draftId,body.expectedDraftRevision,body.operationId));
    if(method==='historicalNode')return {tagName:'span',text:{status:'present',value:'12.00'}};
    if(method==='historicalLocators')return {items:[]};
    if(method==='authoringRecovery')return {items:[]};
    if(method==='authoringOperation')return {stage:'not-captured'};
    if(method==='materialPublicationStatus')return service.publicationStatus(projectId,body.operationId);
    if(method==='prepareMaterialArchive')return service.prepareArchive(projectId,body.draftId);
    if(method==='state')return {runs:[{id:'recording',status:'sealed'}]};
    throw new Error(method);
  });setTestWorkbenchClient({call,bounds:vi.fn()});
  return {root,materials,draft,call,fixed,fail:()=>{failEdit=true;},get:()=>materials.service.getDraft('project',draft.draftId)};
}
export function Harness(props:Partial<React.ComponentProps<typeof MaterialWorkbench>>={}) {
  const [view,setView]=useState<WorkspaceView>('checkpoints');
  return <><button onClick={()=>setView('checkpoints')}>工作区</button><button onClick={()=>setView('archives')}>存档</button><button onClick={()=>setView('implementation')}>实现</button><MaterialWorkbench projectId="project" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} {...props} view={view} onEditWorkspace={()=>setView('checkpoints')}/></>;
}
