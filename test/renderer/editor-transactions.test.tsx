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
    if(method==='authoringRecovery')return {items:[]};
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
  render(<MaterialWorkbench {...props}/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));await screen.findByText(/Original note/);await screen.findByRole('option',{name:'orders.Amount'});await screen.findByRole('option',{name:'Amounts'});
  fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});fireEvent.change(screen.getByLabelText('字段'),{target:{value:'amount'}});
  expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('requirement');expect((screen.getByLabelText('明确含义') as HTMLTextAreaElement).value).toBe('Old meaning');
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

test('discovers an interrupted host journal with no local editor cache and unlocks ordinary editing',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!;
 f.call.mockImplementation(async(method,body)=>method==='authoringRecovery'?{items:[{projectId:'project',draftId:f.draft.draftId,operationId:'orphan',stage:'interrupted',paused:true}]}:original(method,body));
 render(<MaterialWorkbench {...props}/>);fireEvent.click(await screen.findByRole('button',{name:'原来源失效：重新选择'}));
 fireEvent.click(screen.getByRole('button',{name:/^Example/}));fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Edited after abrupt exit'}});fireEvent.click(screen.getByRole('button',{name:'保存卡片草稿'}));
 await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.checkpoints[0].notes).toBe('Edited after abrupt exit'));
 expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(false);expect(screen.queryByText(/恢复已保存操作/)).toBeNull();
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
 const select=vi.fn(async(_id:string)=>{});const view=render(<MaterialWorkbench {...props} live onLiveSelect={select}/>);await screen.findByRole('option',{name:'orders.A'});await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('requirement');fireEvent.change(screen.getByLabelText('字段'),{target:{value:'a'}});fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());view.rerender(<MaterialWorkbench {...props} live onLiveSelect={select} liveSelection={{selectionId:select.mock.calls[0][0],sample:{ref:target}}}/>);
 const retry=await screen.findByRole('button',{name:'重试关联已保存原件'});expect((screen.getByLabelText('字段') as HTMLSelectElement).disabled).toBe(true);fireEvent.change(screen.getByLabelText('字段'),{target:{value:'b'}});expect((screen.getByLabelText('字段') as HTMLSelectElement).value).toBe('a');expect((screen.getByLabelText('明确含义') as HTMLInputElement).value).toBe('A meaning');fireEvent.click(retry);await screen.findByText('节点 1');const save=screen.getByRole('button',{name:'保存字段'});await waitFor(()=>expect((save as HTMLButtonElement).disabled).toBe(false));fireEvent.click(save);await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.fields[0].target).toEqual(target));const fields=(await f.materials.service.getDraft('project',f.draft.draftId)).content.fields;expect(fields[0].description).toBe('A meaning');expect(fields[1]).toMatchObject({id:'b',description:'B meaning'});expect(fields[1].target).toBeUndefined();
});

test.each([false,true])('capture preserves dirty card A and unfinished field input (selection=%s)',async selection=>{
 const f=await fixture(),original=f.call.getMockImplementation()!,select=vi.fn(async(_id:string)=>{});
 f.call.mockImplementation(async(method,body)=>method==='captureAndAuthor'?{status:'saved',stage:'associated',target,...(await f.materials.authorReceipt('project',{...body,receiptId:'receipt-b',position,title:'Captured B',notes:''}))}:original(method,body));
 const view=render(<MaterialWorkbench {...props} live onLiveSelect={select}/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});
 fireEvent.change(screen.getByLabelText('说明'),{target:{value:'A remains edited'}});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'Unfinished amount'}});
 if(selection){fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());view.rerender(<MaterialWorkbench {...props} live onLiveSelect={select} liveSelection={{selectionId:select.mock.calls[0][0],sample:{ref:target}}}/>);}else fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));
 await waitFor(()=>expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Captured B'));
 const captured=(await f.materials.service.getDraft('project',f.draft.draftId)).content;expect(captured.checkpoints.find(c=>c.id==='card')?.notes).toBe('A remains edited');expect(captured.checkpoints.find(c=>c.title==='Captured B')?.sourceReceiptRef).toBe('receipt-b');expect(captured.fields).toHaveLength(0);expect((screen.getByLabelText('字段名') as HTMLInputElement).value).toBe('Unfinished amount');
 fireEvent.change(screen.getByLabelText('数据集'),{target:{value:'orders'}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Displayed amount'}});fireEvent.click(screen.getByRole('button',{name:'保存字段'}));
 await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.fields).toHaveLength(1));const saved=(await f.materials.service.getDraft('project',f.draft.draftId)).content;
 expect(saved.requirements.find(r=>r.id==='requirement')?.fieldIds).toEqual([saved.fields[0].id]);if(selection)expect(saved.fields[0]).toMatchObject({target,checkpointId:captured.checkpoints.find(c=>c.title==='Captured B')?.id});
 fireEvent.click(screen.getByRole('button',{name:/^Example/}));await waitFor(()=>expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('A remains edited'));
});

test.each([false,true])('new card requirement R2 does not change explicit R1 field ownership (existing=%s)',async existing=>{
 const f=await fixture(),draft=await f.materials.service.getDraft('project',f.draft.draftId);
 draft.content.fields=[{id:'f0',name:'Existing zero',description:'Keep F0',dataset:'orders',sourcePolicy:'any-evidenced'},...(existing?[{id:'f',name:'Editable',description:'Old F',dataset:'orders',sourcePolicy:'any-evidenced' as const}]:[])];draft.content.requirements[0].fieldIds=draft.content.fields.map(field=>field.id);await f.materials.service.updateDraft('project',draft.draftId,draft.draftRevision,draft.content,'human');
 render(<MaterialWorkbench {...props}/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});await screen.findByRole('option',{name:'orders.Existing zero'});if(existing)fireEvent.change(screen.getByLabelText('字段'),{target:{value:'f'}});
 fireEvent.change(screen.getByLabelText('需求说明'),{target:{value:'R1 edited'}});fireEvent.change(screen.getByLabelText('数据集'),{target:{value:'orders'}});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'F'}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'F belongs to R1'}});fireEvent.change(screen.getByLabelText('新需求含义'),{target:{value:'R2 linked only'}});fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));
 await waitFor(()=>expect(f.fixed).toHaveLength(1));const saved=f.fixed[0].content,r1=saved.requirements.find(r=>r.id==='requirement')!,r2=saved.requirements.find(r=>r.description==='R2 linked only')!,field=saved.fields.find(field=>field.name==='F')!;expect(r1).toMatchObject({description:'R1 edited',fieldIds:['f0',field.id],dataset:'orders'});expect(r2.fieldIds).toEqual([]);expect(saved.fields.find(field=>field.id==='f0')?.description).toBe('Keep F0');expect(saved.checkpoints[0].requirementIds).toEqual(['requirement',r2.id]);
});

test('dirty card save failure stops capture without discarding incomplete field input',async()=>{
 const f=await fixture();render(<MaterialWorkbench {...props} live/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Keep A on failure'}});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'Incomplete F'}});f.fail();fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));await screen.findByText(/disk unavailable/);expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(false);expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Example');expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('Keep A on failure');expect((screen.getByLabelText('字段名') as HTMLInputElement).value).toBe('Incomplete F');
});

test('live selection freezes editor ownership and cancelling preserves dirty card and incomplete field',async()=>{
 const f=await fixture(),select=vi.fn(async(_id:string)=>{}),cancel=vi.fn(async()=>{});render(<MaterialWorkbench {...props} live onLiveSelect={select} onCancelLive={cancel}/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Unsaved A'}});fireEvent.change(screen.getByLabelText('字段名'),{target:{value:'Incomplete F'}});fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());expect(document.querySelector('.material-layout')?.hasAttribute('inert')).toBe(true);fireEvent.click(screen.getByRole('button',{name:/^Other example/}));expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Example');fireEvent.click(screen.getByRole('button',{name:'取消选择'}));expect(cancel).toHaveBeenCalled();expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('Unsaved A');expect((screen.getByLabelText('字段名') as HTMLInputElement).value).toBe('Incomplete F');expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(false);
});

test('unknown recovery can be parked while an unrelated card is edited without another capture',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!;
 f.call.mockImplementation(async(method,body)=>{if(method==='captureAndAuthor')throw new Error('response lost');if(method==='authoringOperation')return {stage:'unknown',reason:'source unreadable'};return original(method,body);});
 render(<MaterialWorkbench {...props} live/>);fireEvent.click(await screen.findByRole('button',{name:/^Example/}));fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));fireEvent.click(await screen.findByRole('button',{name:'暂存恢复并继续编辑'}));expect(document.querySelector('.material-layout')?.hasAttribute('inert')).toBe(false);fireEvent.click(screen.getByRole('button',{name:/^Other example/}));fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Unrelated edit retained'}});fireEvent.click(screen.getByRole('button',{name:'保存卡片草稿'}));await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.checkpoints[1].notes).toBe('Unrelated edit retained'));
 const query=screen.getByRole('button',{name:'查询采集操作状态'});await waitFor(()=>expect((query as HTMLButtonElement).disabled).toBe(false));fireEvent.click(query);await screen.findByText('source unreadable');expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Other example');expect(f.call.mock.calls.filter(([method])=>method==='captureAndAuthor')).toHaveLength(1);expect(JSON.parse(localStorage.getItem(`bes.editor.project.${f.draft.draftId}`)!).retryCapture.paused).toBe(true);
});

test('parked field recovery never replaces unrelated field buffers and binds only by explicit choice',async()=>{
 const f=await fixture(),draft=await f.materials.service.getDraft('project',f.draft.draftId);draft.content.fields=[{id:'a',name:'A',description:'A meaning',dataset:'orders',sourcePolicy:'page-displayed'},{id:'b',name:'B',description:'B meaning',dataset:'orders',sourcePolicy:'page-displayed'}];draft.content.requirements[0].fieldIds=['a','b'];await f.materials.service.updateDraft('project',draft.draftId,draft.draftRevision,draft.content,'human');
 const original=f.call.getMockImplementation()!,select=vi.fn(async(_id:string)=>{});let captures=0;
 f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation')return {stage:'receipt-saved',receiptId:'receipt'};if(method==='captureAndAuthor'){if(++captures===1)return {status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'association interrupted'};return {status:'saved',stage:'associated',target,...(await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Recovered sample',notes:''}))};}return original(method,body);});
 const view=render(<MaterialWorkbench {...props} live onLiveSelect={select}/>);await screen.findByRole('option',{name:'orders.A'});await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});fireEvent.change(screen.getByLabelText('字段'),{target:{value:'a'}});fireEvent.click(screen.getByRole('button',{name:'添加所需字段（实时页面）'}));await waitFor(()=>expect(select).toHaveBeenCalled());view.rerender(<MaterialWorkbench {...props} live onLiveSelect={select} liveSelection={{selectionId:select.mock.calls[0][0],sample:{ref:target}}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'暂存恢复并继续编辑'}));fireEvent.change(screen.getByLabelText('字段'),{target:{value:'b'}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'B independent edit'}});fireEvent.click(screen.getByRole('button',{name:'重试关联已保存原件'}));const bind=await screen.findByRole('button',{name:'使用已保存样例绑定当前字段'});expect((screen.getByLabelText('字段') as HTMLSelectElement).value).toBe('b');expect((screen.getByLabelText('明确含义') as HTMLInputElement).value).toBe('B independent edit');expect(screen.queryByText('节点 1')).toBeNull();fireEvent.click(bind);fireEvent.click(screen.getByRole('button',{name:'保存字段'}));
 await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.fields[1].target).toEqual(target));const saved=(await f.materials.service.getDraft('project',f.draft.draftId)).content;expect(saved.fields[0].target).toBeUndefined();expect(saved.fields[1]).toMatchObject({description:'B independent edit',checkpointId:saved.checkpoints.find(c=>c.title==='Recovered sample')?.id});
});

test('late capture receipt cannot replace another project editor',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!,capture=deferred<any>();f.call.mockImplementation(async(method,body)=>method==='captureAndAuthor'?capture.promise:original(method,body));const view=render(<MaterialWorkbench {...props} live/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'记录当前结果'}));await waitFor(()=>expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(true));view.rerender(<MaterialWorkbench {...props} projectId="another-project" live/>);await screen.findByRole('button',{name:/^Example/});const request=f.call.mock.calls.find(([method])=>method==='captureAndAuthor')![1];await act(async()=>capture.resolve({status:'saved',stage:'associated',...(await f.materials.authorReceipt('project',{...request,receiptId:'late-receipt',position,title:'Late old project',notes:''}))}));expect((screen.getByLabelText('标题') as HTMLInputElement).value).not.toBe('Late old project');expect(screen.queryByText('已保存原始材料并关联同一张可编辑保存点。')).toBeNull();
});

test('existing field opens its unique requirement and dirty unassigned field can choose that requirement without losing a clear binding',async()=>{
 const f=await fixture(),original=await f.materials.service.getDraft('project',f.draft.draftId);
 original.content.fields=[{id:'amount',name:'Amount',description:'Original meaning',dataset:'orders',valueType:'number',sourcePolicy:'page-displayed',target,checkpointId:'card',bindingStatus:'bound'}];original.content.requirements[0].fieldIds=['amount'];original.content.requirements[0].dataset='orders';
 await f.materials.service.updateDraft('project',original.draftId,original.draftRevision,original.content,'human');const current=await f.materials.service.getDraft('project',original.draftId),old=await f.materials.service.publish('project',current.draftId,current.draftRevision,'human');
 const view=render(<MaterialWorkbench {...props}/>);await screen.findByRole('option',{name:'orders.Amount'});await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('字段'),{target:{value:'amount'}});
 expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('requirement');
 // Also recover the already-persisted editor state from the previous build:
 // no selected requirement, with a dirty existing field and an explicit clear.
 const key=`bes.editor.project.${f.draft.draftId}`;await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).requirementId).toBe('requirement'));const cached=JSON.parse(localStorage.getItem(key)!);view.unmount();localStorage.setItem(key,JSON.stringify({...cached,requirementId:'',requirementDescription:'',rulesJson:'[]'}));render(<MaterialWorkbench {...props}/>);await waitFor(()=>expect((screen.getByLabelText('字段') as HTMLSelectElement).value).toBe('amount'));await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Edited before choosing requirement'}});
 fireEvent.click(screen.getByRole('button',{name:'解除绑定'}));fireEvent.click(screen.getByRole('button',{name:'确认解除绑定'}));fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});
 await waitFor(()=>expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('requirement'));expect((screen.getByLabelText('明确含义') as HTMLInputElement).value).toBe('Edited before choosing requirement');
 fireEvent.click(screen.getByRole('button',{name:'保存字段'}));await waitFor(async()=>{const field=(await f.materials.service.getDraft('project',f.draft.draftId)).content.fields[0];expect(field.description).toBe('Edited before choosing requirement');expect(field.target).toBeUndefined();});
 expect((await f.materials.service.revision('project',old.revisionId)).contentHash).toBe(old.contentHash);expect(old.content.fields[0].target).toEqual(target);
});

test('a shared existing field keeps its buffer until an explicit requirement is chosen',async()=>{
 const f=await fixture(),draft=await f.materials.service.getDraft('project',f.draft.draftId);
 draft.content.fields=[{id:'shared',name:'Shared',description:'Before',dataset:'records',sourcePolicy:'any-evidenced'}];for(const requirement of draft.content.requirements){requirement.fieldIds=['shared'];requirement.dataset='records';}
 await f.materials.service.updateDraft('project',draft.draftId,draft.draftRevision,draft.content,'human');render(<MaterialWorkbench {...props}/>);await screen.findByRole('option',{name:'records.Shared'});await screen.findByRole('option',{name:'Other requirement'});
 fireEvent.change(screen.getByLabelText('字段'),{target:{value:'shared'}});expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('');fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'After explicit selection'}});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'other'}});
 await waitFor(()=>expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('other'));expect((screen.getByLabelText('字段') as HTMLSelectElement).value).toBe('shared');fireEvent.click(screen.getByRole('button',{name:'发布候选版本'}));await waitFor(()=>expect(f.fixed).toHaveLength(1));
 expect(f.fixed[0].content.fields[0].description).toBe('After explicit selection');expect(f.fixed[0].content.requirements.map(item=>item.fieldIds)).toEqual([['shared'],['shared']]);
});

test('ordinary requirement controls persist explicit count and unique output key',async()=>{
 const f=await fixture();render(<MaterialWorkbench {...props}/>);await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});fireEvent.change(screen.getByLabelText('期望记录数（可选）'),{target:{value:'7'}});fireEvent.change(screen.getByLabelText('不重复的输出标识字段（可选）'),{target:{value:'bookingRef'}});fireEvent.click(screen.getByRole('button',{name:'保存需求'}));await waitFor(async()=>expect((await f.materials.service.getDraft('project',f.draft.draftId)).content.requirements[0].rules).toEqual([{type:'row-count',count:7},{type:'unique',field:'bookingRef'}]));
});

test('mapping summary exposes example and incompatibility before confirmation',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!;f.call.mockImplementation(async(method,body)=>method==='previewImplementation'?{compatible:false,issues:['数值字段需声明纯十进制解释'],fields:[{dataset:'orders',name:'Total',description:'Displayed total',valueType:'number',example:'Amount savepoint',verification:'只接受纯十进制文本'}]}:original(method,body));render(<MaterialWorkbench {...props}/>);await screen.findByRole('button',{name:/^Example/});fireEvent.click(screen.getByRole('button',{name:'读取实现器映射'}));await screen.findByText('数值字段需声明纯十进制解释');expect(screen.getByText(/Amount savepoint/)).toBeTruthy();expect((screen.getByRole('button',{name:'确认映射并保存草稿'}) as HTMLButtonElement).disabled).toBe(true);
});
