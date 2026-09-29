/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Harness, fixture, target } from './material-harness';

afterEach(()=>{cleanup();localStorage.clear();delete (window as Partial<Window>).studio;});
const click=async(name:string|RegExp)=>{
 const button=await screen.findByRole('button',{name});await waitFor(()=>{expect((button as HTMLButtonElement).disabled).toBe(false);expect(button.closest('[inert]')).toBeNull();});fireEvent.click(button);
 await waitFor(()=>expect(screen.queryByText(/^(保存资料|保存编辑快照|读取编辑对象|读取工作副本)$/)).toBeNull());
 if(name instanceof RegExp&&name.source.startsWith('^Example'))await waitFor(()=>expect(screen.getByRole('button',{name}).getAttribute('aria-pressed')).toBe('true'));
 if(name==='工作区')await screen.findByRole('button',{name:'保存修改'});
};
async function archive(){await click('存档');await click('保存存档版本');await click('确认保存存档版本');}

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
