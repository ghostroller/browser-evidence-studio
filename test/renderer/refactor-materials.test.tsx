/** @vitest-environment jsdom */
import { clearTestWorkbenchClient } from './workbench-test-client';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Harness, fixture, target, deferred } from './material-harness';

afterEach(()=>{cleanup();localStorage.clear();clearTestWorkbenchClient();});
const click=async(name:string|RegExp)=>{
 if(name instanceof RegExp&&name.source.startsWith('^Example')){const list=document.querySelector<HTMLDetailsElement>('.material-card-navigation');if(list&&!list.open)fireEvent.click(list.querySelector('summary')!); }
 const button=await screen.findByRole('button',{name});await waitFor(()=>{expect((button as HTMLButtonElement).disabled).toBe(false);expect(button.closest('[inert]')).toBeNull();});fireEvent.click(button);
 await waitFor(()=>expect(screen.queryByText(/^(保存资料|保存编辑快照|读取编辑对象|读取工作副本)$/)).toBeNull());
 if(name instanceof RegExp&&name.source.startsWith('^Example'))await waitFor(()=>expect(screen.getByRole('button',{name}).getAttribute('aria-pressed')).toBe('true'));
 if(name==='工作区')await screen.findByRole('button',{name:'保存修改'});
};
async function archive(){await click('存档');await click('保存存档版本');await click('确认保存存档版本');}

async function waitForWorkspaceReady() {
 // Directory rows can arrive before working-draft bootstrap. A disabled-button
 // fireEvent would never exercise the blur-to-click queue this test covers.
 const save = await screen.findByRole('button', { name: '保存修改' });
 await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
}

test('workspace exposes checkpoint creation without draft/version management and separate archive units',async()=>{
 await fixture();render(<Harness/>);await screen.findByRole('button',{name:'保存修改'});expect(screen.queryByRole('button',{name:'新建工作副本'})).toBeNull();expect(screen.queryByRole('button',{name:'保存存档版本'})).toBeNull();expect(screen.getByRole('button',{name:'新增保存点'})).toBeTruthy();await click('存档');expect(screen.getByRole('button',{name:'资料版本'})).toBeTruthy();expect(screen.getByRole('button',{name:'原始录制'})).toBeTruthy();expect(screen.getByRole('button',{name:'工作副本'})).toBeTruthy();
});
test('fixed revision is strictly read-only and explicit derive creates the parent relationship',async()=>{
 const f=await fixture();render(<Harness/>);await screen.findByRole('button',{name:'保存修改'});await archive();await waitFor(()=>expect(f.fixed).toHaveLength(1));await click('查看固定版本');await screen.findByLabelText('固定版本只读');expect(screen.queryByLabelText('说明')).toBeNull();expect(screen.queryByRole('button',{name:'保存修改'})).toBeNull();await click('基于此版继续编辑');await screen.findByRole('button',{name:'保存修改'});const selected=await f.materials.service.workingDraft('project');expect(selected.draftId).not.toBe(f.draft.draftId);expect(selected.baseRevisionId).toBe(f.fixed[0].revisionId);expect((await f.materials.service.revision('project',f.fixed[0].revisionId)).contentHash).toBe(f.fixed[0].contentHash);
});
test('brief-only edits are visible in immutable revision comparison',async()=>{
 const f=await fixture();render(<Harness/>);await screen.findByRole('button',{name:'保存修改'});await archive();await waitFor(()=>expect(f.fixed).toHaveLength(1));await click('工作区');fireEvent.click(screen.getByText('任务目标与共享需求'));await click('编辑任务目标');fireEvent.change(screen.getByLabelText('任务范围'),{target:{value:'Only September'}});await archive();await waitFor(()=>expect(f.fixed).toHaveLength(2));const diff=await f.materials.service.diff('project',f.fixed[0].revisionId,f.fixed[1].revisionId,{limit:10,maxBytes:4000});expect(diff.items).toEqual([{collection:'taskBrief',id:'taskBrief',change:'changed',changedFields:['scope']}]);
});
test('a bound field opens its owner and description edit retains source and numeric type',async()=>{
 const f=await fixture();render(<Harness/>);await click(/^Example 1/);await click(/^Paid amount/);await screen.findByDisplayValue('Amount displayed');expect((screen.getByLabelText('所属需求') as HTMLSelectElement).value).toBe('requirement');fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Actual amount'}});await click('保存字段');await waitFor(async()=>expect((await f.get()).content.fields[0]).toMatchObject({description:'Actual amount',target,valueType:'number',checkpointId:'card-0'}));
});
test('adding and removing a second example preserves primary and old fixed content',async()=>{
 const f=await fixture(),v1=await f.materials.service.publish('project',f.draft.draftId,f.draft.draftRevision,'human'),select=vi.fn();const view=render(<Harness onSelectTarget={select}/>);await click(/^Example 2/);await click(/^Paid amount/);await click('添加当前保存点例证');const request=select.mock.calls.at(-1)![0];view.rerender(<Harness onSelectTarget={select} selectedTarget={{request,target,replayId:"replay",generation:1}}/>);await click('保存字段');await waitFor(async()=>expect((await f.get()).content.fields[0].examples).toHaveLength(1));expect((await f.get()).content.fields[0].target).toEqual(target);await click(/^Paid amount/);await click('移除此例证');await waitFor(async()=>expect((await f.get()).content.fields[0].examples).toHaveLength(0));expect((await f.materials.service.revision('project',v1.revisionId,v1.contentHash)).content.fields[0].examples).toBeUndefined();
});
test('selection receipt purpose cannot populate a different annotation editor',async()=>{
 const f=await fixture(),select=vi.fn();const view=render(<Harness onSelectTarget={select}/>);await click(/^Example 1/);await click('添加字段');await click('选择当前保存点的元素');const request=select.mock.calls.at(-1)![0];await click('添加注释');view.rerender(<Harness onSelectTarget={select} selectedTarget={{request,target,replayId:"replay",generation:1}}/>);fireEvent.change(screen.getByLabelText('注释'),{target:{value:'No stale binding'}});await click('保存注释');await waitFor(async()=>expect((await f.get()).content.annotations.find(item=>item.text==='No stale binding')?.target).toBeUndefined());
});
test('clear binding is explicit and retains meaning and old fixed hash',async()=>{
 const f=await fixture(),v1=await f.materials.service.publish('project',f.draft.draftId,f.draft.draftRevision,'human');render(<Harness/>);await click(/^Example 1/);await click(/^Paid amount/);await click('解除绑定');await click('保留绑定');expect((await f.get()).content.fields[0].target).toEqual(target);await click('解除绑定');await click('确认解除绑定');await click('保存字段');await waitFor(async()=>expect((await f.get()).content.fields[0].target).toBeUndefined());expect((await f.get()).content.fields[0].description).toBe('Amount displayed');expect((await f.materials.service.revision('project',v1.revisionId)).contentHash).toBe(v1.contentHash);
});
test('ordinary count and uniqueness controls persist and do not infer business coverage',async()=>{
 const f=await fixture();render(<Harness/>);await screen.findByRole('button',{name:'保存修改'});fireEvent.click(screen.getByText('任务目标与共享需求'));await click('管理共享需求');await screen.findByRole('option',{name:'Amounts'});fireEvent.change(screen.getByLabelText('需求'),{target:{value:'requirement'}});await waitFor(()=>expect((screen.getByLabelText('需求说明') as HTMLTextAreaElement).value).toBe('Amounts'));fireEvent.change(screen.getByLabelText('期望记录数（可选）'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('不重复的输出标识字段（可选）'),{target:{value:'orderId'}});await click('保存需求');await waitFor(async()=>expect((await f.get()).content.requirements[0].rules).toEqual([{type:'row-count',count:2},{type:'unique',field:'orderId'}]));
});
test('workcopy directory rename and current pointer survive component remount',async()=>{
 const f=await fixture();await f.materials.service.createDraft('project','human');const view=render(<Harness/>);await screen.findByRole('button',{name:'保存修改'});await click('存档');await click('工作副本');const names=await screen.findAllByLabelText('副本名称');fireEvent.blur(names[0],{target:{value:'Named copy'}});await waitFor(async()=>expect(Object.values((await f.materials.service.workspaceCatalog('project')).drafts).some(item=>item.name==='Named copy')).toBe(true));view.unmount();render(<Harness/>);await click('存档');await click('工作副本');await screen.findByDisplayValue('Named copy');
});

test('blur rename completes before copy, and refocusing an unchanged name does not write again',async()=>{
 const f=await fixture(),gate=deferred<void>(),service=f.materials.service,manage=service.manageCatalog.bind(service);
 render(<Harness/>);await waitForWorkspaceReady();await click('存档');await click('工作副本');const input=await screen.findByLabelText('副本名称');
 const copy=vi.spyOn(service,'copyDraft');vi.spyOn(service,'manageCatalog').mockImplementationOnce(async(...args)=>{await gate.promise;return manage(...args);});
 fireEvent.change(input,{target:{value:'Alternative'}});fireEvent.blur(input);
 await waitFor(()=>expect(service.manageCatalog).toHaveBeenCalledTimes(1));const copyButton=screen.getByRole('button',{name:'复制工作副本'});expect((copyButton as HTMLButtonElement).disabled).toBe(false);fireEvent.click(copyButton);
 await act(async()=>{});expect(copy).not.toHaveBeenCalled();await act(async()=>gate.resolve());
 await screen.findByText('已复制工作副本；可设为当前后继续编辑。');await screen.findByDisplayValue('Alternative 副本');
 expect(copy).toHaveBeenCalledTimes(1);expect((await service.listDrafts('project',{limit:100,maxBytes:28000})).items).toHaveLength(2);
 expect((await service.workspaceCatalog('project')).workingDraftId).toBe(f.draft.draftId);
 const before=(await service.workspaceCatalog('project')).catalogRevision;
 fireEvent.focus(screen.getByDisplayValue('Alternative'));fireEvent.blur(screen.getByDisplayValue('Alternative'));
 await act(async()=>{});await service.workspaceCatalog('project');expect((await service.workspaceCatalog('project')).catalogRevision).toBe(before);
});

test('failed blur rename blocks the queued copy and leaves input available for an explicit retry',async()=>{
 const f=await fixture(),gate=deferred<void>(),service=f.materials.service;
 render(<Harness/>);await waitForWorkspaceReady();await click('存档');await click('工作副本');const input=await screen.findByLabelText('副本名称');
 const copy=vi.spyOn(service,'copyDraft');vi.spyOn(service,'manageCatalog').mockImplementationOnce(async()=>{await gate.promise;throw new Error('rename unavailable');});
 fireEvent.change(input,{target:{value:'Retained input'}});fireEvent.blur(input);
 await waitFor(()=>expect(service.manageCatalog).toHaveBeenCalledTimes(1));const copyButton=screen.getByRole('button',{name:'复制工作副本'});expect((copyButton as HTMLButtonElement).disabled).toBe(false);fireEvent.click(copyButton);
 await act(async()=>gate.resolve());await screen.findByText('Error: rename unavailable');expect(copy).not.toHaveBeenCalled();
 expect((input as HTMLInputElement).value).toBe('Retained input');expect((await service.listDrafts('project',{limit:100,maxBytes:28000})).items).toHaveLength(1);
 fireEvent.blur(input);fireEvent.click(screen.getByRole('button',{name:'复制工作副本'}));
 await screen.findByText('已复制工作副本；可设为当前后继续编辑。');await screen.findByDisplayValue('Retained input 副本');expect(copy).toHaveBeenCalledTimes(1);
});

test('field on the second page keeps its exact identity and owner after saving',async()=>{
 const f=await fixture(),current=await f.get();const template=current.content.fields[0];
 current.content.fields=Array.from({length:65},(_,n)=>({...template,id:`field-${n}`,name:`Field ${n+1}`}));
 current.content.requirements[0].fieldIds=current.content.fields.map(item=>item.id);
 await f.materials.service.updateDraft('project',current.draftId,current.draftRevision,current.content,'human');
 render(<Harness/>);await click(/^Example 1/);expect(screen.queryByRole('button',{name:/^Field 65 ·/})).toBeNull();await click('更多字段');await click(/^Field 65 ·/);
 expect((screen.getByLabelText('所属需求') as HTMLSelectElement).value).toBe('requirement');fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:'Last field revised'}});await click('保存字段');
 await waitFor(async()=>expect((await f.get()).content.fields.find(item=>item.id==='field-64')?.description).toBe('Last field revised'));
 expect((await f.get()).content.fields).toHaveLength(65);expect((await f.get()).content.fields[0].description).toBe('Amount displayed');
 expect(f.call.mock.calls.some(([method,body])=>method==='materialEntity'&&body.entityId==='field-64')).toBe(true);
});

test('filtering a second recording is only a projection and the fixed version retains both sources',async()=>{
 const f=await fixture(),current=await f.get();current.content.recordingRefs.push('recording-two');current.content.checkpoints[1].anchor={...current.content.checkpoints[1].anchor,recordingId:'recording-two'};
 await mkdir(path.join(f.root,'runs','recording-two'),{recursive:true});await writeFile(path.join(f.root,'runs','recording-two','manifest.json'),JSON.stringify({schemaVersion:2,id:'recording-two',projectId:'project',status:'sealed'}));
 await f.materials.service.updateDraft('project',current.draftId,current.draftRevision,current.content,'human');
 render(<Harness/>);await screen.findByRole('option',{name:'recording-two'});await screen.findByRole('button',{name:/^Example 2/});fireEvent.change(screen.getByLabelText('来源录制筛选'),{target:{value:'recording-two'}});
 expect(screen.queryByRole('button',{name:/^Example 1/})).toBeNull();expect(screen.getByRole('button',{name:/^Example 2/})).toBeTruthy();
 const saved=await f.get(),fixed=await f.materials.service.publish('project',saved.draftId,saved.draftRevision,'human');expect(fixed.content.recordingRefs).toEqual(['recording','recording-two']);expect(fixed.content.checkpoints).toHaveLength(2);
});

test('focused annotation editing collapses navigation and returns to the same saved card',async()=>{
 const f=await fixture();render(<Harness/>);await click(/^Example 1/);await click('添加注释');
 await waitFor(()=>expect(document.querySelector<HTMLDetailsElement>('.material-card-navigation')?.open).toBe(false));
 expect(screen.queryByRole('button',{name:/^Paid amount/})).toBeNull();
 expect(screen.getByRole('button',{name:'查看来源'})).toBeTruthy();
 fireEvent.change(screen.getByLabelText('注释'),{target:{value:'A focused note'}});await click('返回摘要');
 await waitFor(()=>expect(screen.queryByLabelText('编辑注释')).toBeNull());
 expect((await f.get()).content.annotations.some(item=>item.text==='A focused note'&&item.checkpointId==='card-0')).toBe(true);
 expect(document.querySelector<HTMLDetailsElement>('.material-card-navigation')?.open).toBe(true);
 expect(screen.getByRole('button',{name:/^Example 1/}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:/^Paid amount/})).toBeTruthy();
});
test('failed save when leaving a focused editor retains the input and editor',async()=>{
 const f=await fixture();render(<Harness/>);await click(/^Example 1/);await click('编辑保存点');
 fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Unsaved explanation'}});f.fail();await click('返回摘要');
 await screen.findByText(/disk unavailable/);expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('Unsaved explanation');
 expect(screen.getByLabelText('编辑保存点')).toBeTruthy();expect((await f.get()).content.checkpoints[0].notes).toBe('');
});
