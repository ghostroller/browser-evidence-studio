/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from './workbench-test-client';
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { RecordingArchive } from '@/renderer/components/recording-archive';
import type { MaterialCatalog } from '@/contracts/workspace';

afterEach(() => { cleanup(); clearTestWorkbenchClient(); });
const runs = [{ id: 'first-run', status: 'sealed' }, { id: 'second-run', status: 'sealed' }];
function fixture() {
  let catalog: MaterialCatalog = { schemaVersion: 1, catalogRevision: 0, drafts: {}, revisions: {}, recordings: { 'first-run': {name:'First recording', hidden:false}, 'second-run':{name:'Second recording', hidden:false} } };
  let fail = false;
  const call = vi.fn(async (method: string, body: any): Promise<any> => {
    if (method === 'materialCatalog') return structuredClone(catalog);
    if (method === 'manageMaterialCatalog') {
      if (fail) throw new Error('directory conflict');
      expect(body.expectedCatalogRevision).toBe(catalog.catalogRevision);
      catalog = {...catalog, catalogRevision:catalog.catalogRevision+1, recordings:{...catalog.recordings,[body.id]:{...catalog.recordings[body.id],...('name' in body?{name:body.name}:{}),...('note' in body?{note:body.note}:{}),...('hidden' in body?{hidden:body.hidden}:{})}}};
      return structuredClone(catalog);
    }
    throw new Error(method);
  });
  setTestWorkbenchClient({call,bounds:vi.fn()});
  const guard={current:null as (()=>boolean)|null};
  render(<RecordingArchive projectId="project" runs={runs} onReplay={vi.fn(async()=>{})} onDiagnostic={vi.fn(async()=>{})} onRecovery={vi.fn()} exitGuardRef={guard}/>);
  return {call, guard, get catalog(){return catalog;}, fail:(value:boolean)=>{fail=value;}};
}
async function select(name: string) {
  const heading=await screen.findByRole('heading',{level:4,name});
  fireEvent.click(within(heading.closest('section')!).getByRole('button',{name:'查看录制详情'}));
}

test('recording metadata only writes on explicit save and never leaks to another selected recording',async()=>{
 const f=fixture();await screen.findByDisplayValue('First recording');
 fireEvent.change(screen.getByLabelText('录制名称'),{target:{value:'Local first label'}});fireEvent.blur(screen.getByLabelText('录制名称'));
 expect(f.call.mock.calls.some(([method])=>method==='manageMaterialCatalog')).toBe(false);
 await select('Second recording');expect((screen.getByLabelText('录制名称') as HTMLInputElement).value).toBe('Local first label');
 let allowed=true;act(()=>{allowed=f.guard.current!();});expect(allowed).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'保存录制目录'}));await screen.findByText('录制目录已保存；原始录制保持不变。');
 expect(f.catalog.recordings['first-run'].name).toBe('Local first label');expect(f.catalog.recordings['second-run'].name).toBe('Second recording');
 await select('Second recording');expect((screen.getByLabelText('录制名称') as HTMLInputElement).value).toBe('Second recording');
});

test('recording write failure retains input and rereads a CAS baseline for explicit retry',async()=>{
 const f=fixture();await screen.findByDisplayValue('First recording');f.fail(true);
 fireEvent.change(screen.getByLabelText('录制名称'),{target:{value:'Retry this name'}});fireEvent.click(screen.getByRole('button',{name:'保存录制目录'}));
 await screen.findByText('Error: directory conflict');expect((screen.getByLabelText('录制名称') as HTMLInputElement).value).toBe('Retry this name');
 expect(f.call.mock.calls.filter(([method])=>method==='materialCatalog').length).toBeGreaterThan(1);f.fail(false);
 fireEvent.click(screen.getByRole('button',{name:'保存录制目录'}));await screen.findByText('录制目录已保存；原始录制保持不变。');expect(f.catalog.recordings['first-run'].name).toBe('Retry this name');
});

test('empty filtered recordings show an honest no-match state',async()=>{
 fixture();await screen.findByDisplayValue('First recording');fireEvent.change(screen.getByLabelText('搜索录制'),{target:{value:'does-not-exist'}});expect(screen.getByText('没有匹配的录制')).toBeTruthy();expect(screen.queryByText('当前项目还没有原始录制')).toBeNull();
});

test('a late failure from the previous project does not contaminate a new project session',async()=>{
 let reject!:(error:Error)=>void;
 const pending=new Promise<never>((_,no)=>{reject=no;});
 const catalog=(project:string)=>({schemaVersion:1,catalogRevision:0,drafts:{},revisions:{},recordings:{'first-run':{name:project,hidden:false}}});
 const call=vi.fn(async(method:string,body:any):Promise<any>=>method==='materialCatalog'?catalog(body.projectId):pending);
 setTestWorkbenchClient({call,bounds:vi.fn()});
 const element=(projectId:string)=><RecordingArchive projectId={projectId} runs={[runs[0]]} onReplay={vi.fn(async()=>{})} onDiagnostic={vi.fn(async()=>{})} onRecovery={vi.fn()}/>;
 const view=render(element('A'));await screen.findByDisplayValue('A');fireEvent.change(screen.getByLabelText('录制名称'),{target:{value:'A edit'}});fireEvent.click(screen.getByRole('button',{name:'保存录制目录'}));
 await waitFor(()=>expect(call.mock.calls.some(([method])=>method==='manageMaterialCatalog')).toBe(true));view.rerender(element('B'));await screen.findByDisplayValue('B');
 view.rerender(element('A'));await screen.findByDisplayValue('A');await act(async()=>reject(new Error('old session failed')));
 expect(screen.queryByText('Error: old session failed')).toBeNull();expect((screen.getByLabelText('录制名称') as HTMLInputElement).value).toBe('A');
});
