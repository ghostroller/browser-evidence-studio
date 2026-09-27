/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';
import { ProjectMaterials, materialSummary } from '@/main/services/project-materials';
import { FileMaterialService } from '@/materials';
import type { MaterialContent, TaskMaterialRevision } from '@/contracts/materials';

afterEach(()=>{cleanup();localStorage.clear();delete (window as Partial<Window>).studio;});
const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',eventSeq:1,sourceTimeMs:1000};
const target={kind:'dom-node' as const,position,frameId:'top',mirrorScopeId:'mirror',nodeId:1};
const props={projectId:'project',position,onOpenReplay:vi.fn(),onSelectTarget:vi.fn()};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function fixture(){
  await mkdir('output/e-regression',{recursive:true});const root=await mkdtemp(path.resolve('output/e-regression/case-'));
  await mkdir(path.join(root,'runs','recording'),{recursive:true});await writeFile(path.join(root,'runs','recording','manifest.json'),JSON.stringify({schemaVersion:2,id:'recording',projectId:'project'}));
  await writeFile(path.join(root,'workspace.json'),JSON.stringify({schemaVersion:1,projects:[{id:'project',objective:'Displayed amounts'}]}));
  const materials=new ProjectMaterials(root);Object.defineProperty(materials,'service',{value:new FileMaterialService(root,{position:async()=> 'reliable',target:async()=>true})});
  let draft=await materials.service.createDraft('project','human');
  const content:MaterialContent={taskBrief:{objective:'Displayed amounts',scope:'two orders'},recordingRefs:['recording'],requirements:[{id:'requirement',description:'Amounts',fieldIds:[],rules:[]},{id:'other',description:'Other requirement',fieldIds:[],rules:[]}],fields:[],checkpoints:[{id:'card',title:'Example',notes:'',kind:'observation',anchor:position,capturedAt:new Date(1000).toISOString(),createdAt:new Date(1000).toISOString(),requirementIds:['requirement'],annotationIds:['note']},{id:'card-two',title:'Other example',notes:'',kind:'observation',anchor:position,capturedAt:new Date(1000).toISOString(),createdAt:new Date(1000).toISOString(),requirementIds:[],annotationIds:[]}],annotations:[{id:'note',checkpointId:'card',target,text:'Original note',author:'human',interpretation:'observed',bindingStatus:'bound'}]};
  await materials.service.updateDraft('project',draft.draftId,0,content,'human');draft=await materials.service.getDraft('project',draft.draftId);
  const fixed:TaskMaterialRevision[]=[];let failEdit=false;
  const call=vi.fn(async(method:string,body:any):Promise<any>=>{
    if(method==='workingMaterialDraft'||method==='materialDraft')return materialSummary(await materials.service.getDraft('project',body.draftId||draft.draftId));
    if(method==='materialDrafts')return materials.service.listDrafts('project',{limit:50,maxBytes:24576});
    if(method==='materialRevisions')return materials.service.listRevisions('project',{limit:50,maxBytes:24576});
    if(method==='materialCollection')return materials.service.pageCollection('project',{kind:'draft',id:body.draftId},body.collection,{limit:50,maxBytes:24576});
    if(method==='editMaterialDraft'){if(failEdit)throw new Error('disk unavailable');return materials.edit('project',body.draftId,body.expectedDraftRevision,body.edits,'ui');}
    if(method==='publishMaterialDraft'){const result=await materials.service.publish('project',body.draftId,body.expectedDraftRevision,'human');fixed.push(result);return materialSummary(result);}
    if(method==='historicalNode')return {tagName:'span',text:{status:'present',value:'12.00'}};
    if(method==='historicalLocators')return {items:[]};
    throw new Error(method);
  });window.studio={call,bounds:vi.fn()};
  return {materials,draft,call,fixed,fail:()=>{failEdit=true;}};
}
test('publishes one coherent receipt containing simultaneous requirement, new field, card and annotation edits',async()=>{
  const f=await fixture();render(<MaterialWorkbench {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:/^Example/}));
  await screen.findByLabelText('Other requirement');
  fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});
  fireEvent.click(await screen.findByRole('button',{name:'编辑注释'}));
  fireEvent.change(screen.getByLabelText('类型'),{target:{value:'requirement'}});
  fireEvent.click(screen.getByLabelText('Other requirement'));
  fireEvent.change(screen.getByLabelText('注释'),{target:{value:'Edited ordinary note'}});
  fireEvent.change(screen.getByLabelText('需求说明'),{target:{value:'Both displayed amounts'}});
  fireEvent.change(screen.getByLabelText('数据集'),{target:{value:'orders'}});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'Amount'}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Displayed in yuan'}});
  fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));await waitFor(()=>expect(f.fixed).toHaveLength(1));
  const saved=f.fixed[0].content;expect(saved.requirements[0]).toMatchObject({description:'Both displayed amounts',dataset:'orders',fieldIds:[saved.fields[0].id]});
  expect(saved.checkpoints[0]).toMatchObject({kind:'requirement',requirementIds:['requirement','other']});expect(saved.annotations[0].text).toBe('Edited ordinary note');expect(saved.taskBrief).toEqual({objective:'Displayed amounts',scope:'two orders'});
  expect(f.call.mock.calls.filter(([method])=>method==='editMaterialDraft')).toHaveLength(1);
  expect(f.call.mock.calls.find(([method])=>method==='publishMaterialDraft')?.[1].expectedDraftRevision).toBe(f.draft.draftRevision+1);
});

test('keeps a bound field and fixed hash while saving requirement and field descriptions together',async()=>{
  const f=await fixture();const original=await f.materials.service.getDraft('project',f.draft.draftId);
  original.content.fields=[{id:'amount',name:'Amount',description:'Old meaning',dataset:'orders',sourcePolicy:'page-displayed',target,checkpointId:'card',annotationId:'note',bindingStatus:'bound'}];original.content.requirements[0].fieldIds=['amount'];original.content.requirements[0].dataset='orders';
  await f.materials.service.updateDraft('project',original.draftId,original.draftRevision,original.content,'human');const current=await f.materials.service.getDraft('project',original.draftId);const old=await f.materials.service.publish('project',current.draftId,current.draftRevision,'human');
  render(<MaterialWorkbench {...props}/>);await screen.findByRole('button',{name:/^Example/});await screen.findByRole('option',{name:'orders.Amount'});
  fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});fireEvent.change(screen.getByLabelText('字段'),{target:{value:'amount'}});
  fireEvent.change(screen.getByLabelText('需求说明'),{target:{value:'New requirement meaning'}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'New field meaning'}});fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));
  await waitFor(()=>expect(f.fixed).toHaveLength(1));expect(f.fixed[0].content.fields[0]).toMatchObject({target,annotationId:'note',description:'New field meaning'});expect(f.fixed[0].content.requirements[0]).toMatchObject({fieldIds:['amount'],dataset:'orders',description:'New requirement meaning'});
  expect((await f.materials.service.revision('project',old.revisionId)).contentHash).toBe(old.contentHash);
});

test.each(['older-revision','legacy-cache'])('restored %s input cannot publish against a silently adopted revision',async mode=>{
  const f=await fixture();const saved={draftRevision:mode==='older-revision'?0:f.draft.draftRevision,cardId:'card',title:'Locally edited',notes:'local',kind:'observation',cardRequirementIds:['requirement'],newCardRequirement:'',requirementId:'',requirementDescription:'',rulesJson:'[]',fieldId:'',fieldName:'',fieldDescription:'',fieldDataset:'records',fieldPath:'',fieldPolicy:'any-evidenced',fieldValueType:'',sourceProofJson:'',fieldTarget:null,fieldAnnotationId:'',annotationId:'',annotationTarget:null,annotationText:'',interpretation:'observed',bindingAction:'keep',...(mode==='older-revision'?{dirty:['card']}:{})};
  localStorage.setItem(`bes.editor.project.${f.draft.draftId}`,JSON.stringify(saved));render(<MaterialWorkbench {...props}/>);
  await waitFor(()=>expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Locally edited'));
  fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));await screen.findByText(/本机恢复输入需要先读取/);expect(f.fixed).toHaveLength(0);expect(f.call.mock.calls.some(([method])=>method==='editMaterialDraft')).toBe(false);
});

test('a capture owns the editor until completion and a failed operation is not imported into another draft',async()=>{
  const f=await fixture(),second=await f.materials.service.createDraft('project','human'),capture=deferred<any>();const original=f.call.getMockImplementation()!;
  f.call.mockImplementation((method,body)=>method==='captureAndAuthor'?capture.promise:original(method,body));render(<MaterialWorkbench {...props} live/>);
  await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));
  await waitFor(()=>expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(true));const other=screen.getByRole('button',{name:`工作草稿 ${second.draftId}`}) as HTMLButtonElement;expect(other.disabled).toBe(true);
  await act(async()=>capture.resolve({status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'Receipt retained',error:'disk unavailable'}));
  await screen.findByRole('button',{name:'重试关联已保存原件'});fireEvent.click(other);await waitFor(()=>expect(screen.getByRole('button',{name:'记录当前结果'})).toBeTruthy());expect(screen.queryByRole('button',{name:'重试关联已保存原件'})).toBeNull();
});
test('saves an edited ordinary annotation before changing cards, and save failure prevents publishing',async()=>{
  const f=await fixture();render(<MaterialWorkbench {...props}/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));
  fireEvent.click(await screen.findByRole('button',{name:'编辑注释'}));fireEvent.change(screen.getByLabelText('注释'),{target:{value:'Keep this edit'}});fireEvent.click(screen.getByRole('button',{name:/^Other example/}));
  await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.annotations[0].text).toBe('Keep this edit'));
  await waitFor(()=>expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Other example'));
  f.fail();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Cannot save'}});fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));await screen.findByText(/disk unavailable/);expect(f.fixed).toHaveLength(0);
});
test('late project bootstrap cannot invalidate a newer project editor before its guard',async()=>{
  const first=deferred<any>();const call=vi.fn(async(method:string,body:any):Promise<any>=>{
    if(method==='workingMaterialDraft')return body.projectId==='a'?first.promise:{draftId:'b-draft',draftRevision:0};
    if(method==='materialDrafts')return {items:[{draftId:body.projectId+'-draft',draftRevision:0}]};if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:body.draftId,draftRevision:0};
    if(method==='materialCollection')return {items:[]};throw new Error(method);
  });window.studio={call,bounds:vi.fn()};const view=render(<MaterialWorkbench {...props} projectId="a"/>);view.rerender(<MaterialWorkbench {...props} projectId="b"/>);
  await screen.findByText('当前工作草稿');await act(async()=>first.resolve({draftId:'a-draft',draftRevision:0}));
  expect(screen.getByText('当前工作草稿')).toBeTruthy();expect(call.mock.calls.some(([method,body])=>method==='materialDraft'&&body.projectId==='a')).toBe(false);
});

test('a late publish refresh cannot invoke the publication callback after switching project',async()=>{
  const f=await fixture(),reopen=deferred<any>(),original=f.call.getMockImplementation()!,published=vi.fn();let publishing=false;
  f.call.mockImplementation(async(method,body)=>{if(method==='publishMaterialDraft')publishing=true;if(method==='materialDraft'&&publishing&&body.projectId==='project')return reopen.promise;return original(method,body);});
  const view=render(<MaterialWorkbench {...props} onPublished={published}/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));
  await waitFor(()=>expect(f.fixed).toHaveLength(1));await waitFor(()=>expect(f.call.mock.calls.filter(([method])=>method==='materialDraft').length).toBeGreaterThan(1));
  view.rerender(<MaterialWorkbench {...props} projectId="another-project" onPublished={published}/>);
  await act(async()=>reopen.resolve(materialSummary(await f.materials.service.getDraft('project',f.draft.draftId))));expect(published).not.toHaveBeenCalled();
});

test('stale live selection can be replaced with a new operation and source identity',async()=>{
 const f=await fixture();const original=f.call.getMockImplementation()!;let attempts=0;
 f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation')return {stage:'not-captured'};if(method==='captureAndAuthor'){if(++attempts===1)throw new Error('stale selection');const authored=await f.materials.authorReceipt('project',{...body,receiptId:'new-receipt',position,title:'New source',notes:''});return {status:'saved',stage:'associated',target,...authored};}return original(method,body);});
 const select=vi.fn(async(_id:string)=>{});const view=render(<MaterialWorkbench {...props} live liveScope={{pageId:'page',generation:1,leaseEpoch:1}} onLiveSelect={select}/>);await screen.findByRole('button',{name:/^Example/});
 fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalledTimes(1));const first=select.mock.calls[0][0];
 view.rerender(<MaterialWorkbench {...props} live liveScope={{pageId:'page',generation:1,leaseEpoch:1}} onLiveSelect={select} liveSelection={{selectionId:first,sample:{ref:target}}}/>);await screen.findByText(/stale selection/);
 fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalledTimes(2));const second=select.mock.calls[1][0];
 view.rerender(<MaterialWorkbench {...props} live liveScope={{pageId:'page',generation:2,leaseEpoch:1}} onLiveSelect={select} liveSelection={{selectionId:second,sample:{ref:{...target,nodeId:2}}}}/>);
 await screen.findByText('节点 1');const requests=f.call.mock.calls.filter(([method])=>method==='captureAndAuthor').map(([,body])=>body);expect(requests).toHaveLength(2);expect(requests[1].operationId).not.toBe(requests[0].operationId);expect(requests[1].selectionId).toBe(second);
});

test('partial receipt retry restores the original field target and creates one card',async()=>{
 const f=await fixture();const original=f.call.getMockImplementation()!;let captureCount=0;let associated=false;
 f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation')return {stage:'receipt-saved',receiptId:'receipt'};if(method==='captureAndAuthor'){captureCount++;if(captureCount===1)return {status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'association unavailable'};const authored=await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Live field',notes:''});associated=true;return {status:'saved',stage:'associated',purpose:'field',target,...authored};}return original(method,body);});
 const select=vi.fn(async(_id:string)=>{});const view=render(<MaterialWorkbench {...props} live liveScope={{pageId:'page',generation:1,leaseEpoch:1}} onLiveSelect={select}/>);await screen.findByRole('button',{name:/^Example/});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'Chosen amount'}});
 fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());view.rerender(<MaterialWorkbench {...props} live onLiveSelect={select} liveSelection={{selectionId:select.mock.calls[0][0],sample:{ref:target}}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'重试关联已保存原件'}));await screen.findByText('节点 1');expect(associated).toBe(true);expect((screen.getByLabelText('字段名') as HTMLInputElement).value).toBe('Chosen amount');
 const operations=f.call.mock.calls.filter(([method])=>method==='captureAndAuthor').map(([,body])=>body);expect(operations[1].operationId).toBe(operations[0].operationId);expect(operations[1].purpose).toBe('field');expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.checkpoints.filter(card=>card.operationId===operations[0].operationId)).toHaveLength(1);
});

test('unknown status query failures never issue another capture',async()=>{
 const f=await fixture();const original=f.call.getMockImplementation()!;f.call.mockImplementation(async(method,body)=>{if(method==='captureAndAuthor')throw new Error('response lost');if(method==='authoringOperation')throw new Error('query unavailable');return original(method,body);});
 render(<MaterialWorkbench {...props} live/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));const retry=await screen.findByRole('button',{name:'查询采集操作状态'});await waitFor(()=>expect((retry as HTMLButtonElement).disabled).toBe(false));fireEvent.click(retry);await screen.findByText(/query unavailable/);expect(f.call.mock.calls.filter(([method])=>method==='captureAndAuthor')).toHaveLength(1);
});

test('lost successful capture response is queried and restored without another acquisition or card',async()=>{
 const f=await fixture();const original=f.call.getMockImplementation()!;let saved:any;let acquisitions=0;
 f.call.mockImplementation(async(method,body)=>{if(method==='captureAndAuthor'){acquisitions++;saved={status:'saved',stage:'associated',...(await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Saved before disconnect',notes:''}))};throw new Error('response lost');}if(method==='authoringOperation')return saved;return original(method,body);});
 render(<MaterialWorkbench {...props} live/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));const retry=await screen.findByRole('button',{name:'查询采集操作状态'});await waitFor(()=>expect((retry as HTMLButtonElement).disabled).toBe(false));fireEvent.click(retry);await screen.findByText('已保存原始材料并关联同一张可编辑保存点。');expect(acquisitions).toBe(1);expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.checkpoints.filter(card=>card.sourceReceiptRef==='receipt')).toHaveLength(1);
});

test('receipt operation survives editor remount and only retries association with the same identity',async()=>{
 const f=await fixture();const original=f.call.getMockImplementation()!;let first=true;let queried='';
 f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation'){queried=body.operationId;return {stage:'receipt-saved',receiptId:'receipt'};}if(method==='captureAndAuthor'){if(first){first=false;return {status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'association unavailable'};}return {status:'saved',stage:'associated',...(await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Recovered',notes:''}))};}return original(method,body);});
 const view=render(<MaterialWorkbench {...props} live/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));await screen.findByRole('button',{name:'重试关联已保存原件'});const identity=f.call.mock.calls.find(([method])=>method==='captureAndAuthor')![1].operationId;
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(`bes.editor.project.${f.draft.draftId}`)!).retryCapture.operationId).toBe(identity));view.unmount();render(<MaterialWorkbench {...props} live/>);fireEvent.click(await screen.findByRole('button',{name:'重试关联已保存原件'}));await screen.findByText('已保存原始材料并关联同一张可编辑保存点。');expect(queried).toBe(identity);expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.checkpoints.filter(card=>card.operationId===identity)).toHaveLength(1);
});

test('partial field A capture blocks switching to field B and cannot publish B inputs into A',async()=>{
 const f=await fixture();const draft=await f.materials.service.getDraft('project',f.draft.draftId);draft.content.fields=[{id:'a',name:'A',description:'A meaning',dataset:'orders',sourcePolicy:'page-displayed'},{id:'b',name:'B',description:'B meaning',dataset:'orders',sourcePolicy:'page-displayed'}];await f.materials.service.updateDraft('project',draft.draftId,draft.draftRevision,draft.content,'human');
 const original=f.call.getMockImplementation()!;let attempts=0;f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation')return {stage:'receipt-saved',receiptId:'receipt'};if(method==='captureAndAuthor'){if(++attempts===1)return {status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'association unavailable'};return {status:'saved',stage:'associated',target,...(await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Field A',notes:''}))};}return original(method,body);});
 const select=vi.fn(async(_id:string)=>{});const view=render(<MaterialWorkbench {...props} live onLiveSelect={select}/>);await screen.findByRole('option',{name:'orders.A'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});fireEvent.change(screen.getByLabelText('字段'),{target:{value:'a'}});fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());view.rerender(<MaterialWorkbench {...props} live onLiveSelect={select} liveSelection={{selectionId:select.mock.calls[0][0],sample:{ref:target}}}/>);
 const retry=await screen.findByRole('button',{name:'重试关联已保存原件'});expect((screen.getByLabelText('字段') as HTMLSelectElement).disabled).toBe(true);fireEvent.change(screen.getByLabelText('字段'),{target:{value:'b'}});expect((screen.getByLabelText('字段') as HTMLSelectElement).value).toBe('a');expect((screen.getByLabelText('明确含义') as HTMLInputElement).value).toBe('A meaning');fireEvent.click(retry);await screen.findByText('节点 1');const save=screen.getByRole('button',{name:'保存字段'});await waitFor(()=>expect((save as HTMLButtonElement).disabled).toBe(false));fireEvent.click(save);await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.fields[0].target).toEqual(target));const fields=(await f.materials.service.getDraft('project',f.draft.draftId)).content.fields;expect(fields[0].description).toBe('A meaning');expect(fields[1]).toMatchObject({id:'b',description:'B meaning'});expect(fields[1].target).toBeUndefined();
});
