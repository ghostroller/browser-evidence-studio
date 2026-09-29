/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Harness, fixture, deferred, position, target } from './material-harness';
import { materialSummary } from '@/main/services/project-materials';

afterEach(()=>{cleanup();localStorage.clear();delete (window as Partial<Window>).studio;});
const click=async(name:string|RegExp)=>{
 if(name instanceof RegExp&&name.source.startsWith("^Example")){const list=document.querySelector<HTMLDetailsElement>(".material-card-navigation");if(list&&!list.open)fireEvent.click(list.querySelector("summary")!);}
 const button=await screen.findByRole('button',{name});await waitFor(()=>{expect((button as HTMLButtonElement).disabled).toBe(false);expect(button.closest('[inert]')).toBeNull();});fireEvent.click(button);
 await waitFor(()=>expect(screen.queryByText(/^(保存资料|保存编辑快照|读取编辑对象|读取工作副本)$/)).toBeNull());
 if(name instanceof RegExp&&name.source.startsWith('^Example'))await waitFor(()=>expect(screen.getByRole('button',{name}).getAttribute('aria-pressed')).toBe('true'));
 if(name==='工作区')await screen.findByRole('button',{name:'保存修改'});
};
async function card(n=1){await click(new RegExp(`^Example ${n}`));await screen.findByRole('region',{name:'保存点摘要'}).catch(()=>screen.findByLabelText('保存点摘要'));}
async function editCard(){await click('编辑保存点');return screen.findByLabelText('说明');}
async function publish(){await click('存档');await click('保存存档版本');await click('确认保存存档版本');}

test('dirty same-card reselection reads the saved entity instead of the old list closure',async()=>{
 const f=await fixture();render(<Harness/>);await card();await editCard();fireEvent.change(screen.getByLabelText('标题'),{target:{value:'Renamed'}});fireEvent.click(document.querySelector('.material-card-navigation > summary')!);fireEvent.click(screen.getByRole('button',{name:/^Example 1/}));
 await waitFor(async()=>expect((await f.get()).content.checkpoints[0].title).toBe('Renamed'));await click('编辑保存点');expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Renamed');
});
test('copy first saves dirty edits, focuses independent copy and preserves original annotation',async()=>{
 const f=await fixture();render(<Harness/>);await card();await editCard();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Keep original'}});await click('返回摘要');fireEvent.click(screen.getByText('更多操作'));await click('复制保存点');
 await waitFor(()=>expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Example 1 副本'));fireEvent.change(screen.getByLabelText('标题'),{target:{value:'Copy name'}});await click('保存修改');
 await waitFor(async()=>{const value=await f.get();expect(value.content.checkpoints).toHaveLength(3);expect(value.content.checkpoints[0]).toMatchObject({title:'Example 1',notes:'Keep original'});expect(value.content.checkpoints[2]).toMatchObject({title:'Copy name',derivedFrom:'card-0'});expect(value.content.checkpoints[2].annotationIds[0]).not.toBe('note');expect(value.content.annotations[0].text).toBe('Original note');});
});
test('ordinary annotation saves before switching card and remains text-only',async()=>{
 const f=await fixture();render(<Harness/>);await card();await click('添加注释');fireEvent.change(screen.getByLabelText('注释'),{target:{value:'Pure note'}});await click(/^Example 2/);
 await waitFor(async()=>expect((await f.get()).content.annotations.find(item=>item.text==='Pure note')).toMatchObject({checkpointId:'card-0',bindingStatus:'none'}));expect((await f.get()).content.annotations.find(item=>item.text==='Pure note')?.target).toBeUndefined();
});
test('two fields on one frozen card reuse its anchor without capture or duplicate card',async()=>{
 const f=await fixture();const select=vi.fn();const view=render(<Harness onSelectTarget={select}/>);await card();
 for(const name of ['Tax','Total']){await click('添加字段');fireEvent.change(screen.getByLabelText('字段名'),{target:{value:name}});fireEvent.change(screen.getByLabelText('明确含义'),{target:{value:name+' displayed'}});await click('选择当前保存点的元素');const request=select.mock.calls.at(-1)![0];view.rerender(<Harness onSelectTarget={select} selectedTarget={{request,target,replayId:"replay",generation:1}}/>);await click('保存字段');await waitFor(async()=>expect((await f.get()).content.fields.some(item=>item.name===name)).toBe(true));}
 expect((await f.get()).content.checkpoints).toHaveLength(2);expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(false);
});
test('dirty save failure preserves input and prevents archive version',async()=>{
 const f=await fixture();render(<Harness/>);await card();await editCard();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Never discard'}});f.fail();await click('存档');await click('保存存档版本');await screen.findByText(/disk unavailable/);expect(f.fixed).toHaveLength(0);await click('工作区');expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('Never discard');
});
test('editor buffer survives remount and stale draft revision is an explicit conflict',async()=>{
 const f=await fixture();const view=render(<Harness/>);await card();await editCard();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Recovered buffer'}});view.unmount();const old=await f.get();await f.materials.service.updateDraft('project',old.draftId,old.draftRevision,old.content,'human');render(<Harness/>);await screen.findByDisplayValue('Recovered buffer');await click('保存修改');await screen.findByText(/本机恢复输入需要先读取/);expect((await f.get()).content.checkpoints[0].notes).toBe('');
});
test('editing a page-two card stays on exact identity after the list reloads page one',async()=>{
 const f=await fixture({cards:65});render(<Harness/>);await click('更多保存点');await card(61);await editCard();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Page two edit'}});await click('保存修改');await waitFor(async()=>expect((await f.get()).content.checkpoints[60].notes).toBe('Page two edit'));expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('Page two edit');fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Second edit'}});await click('保存修改');await waitFor(async()=>expect((await f.get()).content.checkpoints[60].notes).toBe('Second edit'));expect((await f.get()).content.checkpoints).toHaveLength(65);
});
test('late project bootstrap cannot clear or select the newer project',async()=>{
 const f=await fixture(),first=deferred<any>(),original=f.call.getMockImplementation()!;f.call.mockImplementation((method,body)=>method==='workingMaterialDraft'&&body.projectId==='project'?first.promise:original(method,body));const view=render(<Harness/>);view.rerender(<Harness projectId="other-project"/>);await screen.findByRole('button',{name:'保存修改'});await act(async()=>first.resolve(materialSummary(f.draft)));expect(f.call.mock.calls.some(([method,body])=>method==='materialDraft'&&body.draftId===f.draft.draftId)).toBe(false);
});
test('late archive completion never publishes into another project UI',async()=>{
 const f=await fixture(),reopen=deferred<any>(),original=f.call.getMockImplementation()!,published=vi.fn();let publishing=false;f.call.mockImplementation((method,body)=>{if(method==='publishMaterialDraft')publishing=true;if(method==='materialDraft'&&publishing&&body.projectId==='project')return reopen.promise;return original(method,body);});const view=render(<Harness onPublished={published}/>);await screen.findByRole('button',{name:'保存修改'});await publish();await waitFor(()=>expect(f.fixed).toHaveLength(1));view.rerender(<Harness projectId="other-project" onPublished={published}/>);await act(async()=>reopen.resolve(materialSummary(await f.get())));expect(published).not.toHaveBeenCalled();
});
test('unknown capture queries never issue a second acquisition and can be parked',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!;f.call.mockImplementation((method,body)=>{if(method==='captureAndAuthor')throw new Error('response lost');if(method==='authoringOperation')return Promise.resolve({stage:'unknown'});return original(method,body);});render(<Harness position={null} live/>);await click('新增保存点');await screen.findByRole('button',{name:'查询采集操作状态'});await click('查询采集操作状态');expect(f.call.mock.calls.filter(([method])=>method==='captureAndAuthor')).toHaveLength(1);await click('保留记录并继续编辑');await card();await editCard();fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Still editable'}});await click('保存修改');await waitFor(async()=>expect((await f.get()).content.checkpoints[0].notes).toBe('Still editable'));
});
test('partial receipt retries original operation and associates exactly one card',async()=>{
 const f=await fixture(),original=f.call.getMockImplementation()!;let first=true;f.call.mockImplementation(async(method,body)=>{if(method==='authoringOperation')return {stage:'receipt-saved'};if(method==='captureAndAuthor'){if(first){first=false;return {status:'partial',stage:'receipt-saved',receiptId:'receipt',reason:'association failed'};}const authored=await f.materials.authorReceipt('project',{...body,receiptId:'receipt',position,title:'Recovered',notes:''});return {status:'saved',stage:'associated',...authored};}return original(method,body);});render(<Harness position={null} live/>);await click('新增保存点');await click('重试关联已保存原件');await waitFor(async()=>expect((await f.get()).content.checkpoints).toHaveLength(3));const requests=f.call.mock.calls.filter(([method])=>method==='captureAndAuthor');expect(requests[0][1].operationId).toBe(requests[1][1].operationId);
});
test('late capture receipt cannot replace another project editing context',async()=>{
 const f=await fixture(),capture=deferred<any>(),original=f.call.getMockImplementation()!;f.call.mockImplementation((method,body)=>method==='captureAndAuthor'?capture.promise:original(method,body));const view=render(<Harness position={null} live/>);await click('新增保存点');await waitFor(()=>expect(f.call.mock.calls.some(([method])=>method==='captureAndAuthor')).toBe(true));view.rerender(<Harness projectId="other-project"/>);await act(async()=>capture.resolve({status:'saved',stage:'associated',draft:materialSummary(f.draft),card:f.draft.content.checkpoints[0]}));await screen.findByRole('button',{name:'保存修改'});expect(screen.queryByText('Example 1')).toBeNull();
});
