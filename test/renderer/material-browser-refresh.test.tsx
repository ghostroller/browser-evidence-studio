/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';
import { memoryEditorStorage, type MaterialEditorCall, type MaterialWorkbenchClient } from '@/renderer/lib/material-workbench-client';
import type { CheckpointCard } from '@/contracts/materials';

const position={recordingId:'recording',pageId:'page',documentId:'doc',streamEpoch:'epoch',sourceTimeMs:1000,eventSeq:1};
afterEach(cleanup);
function fixture(empty=false) {
  let revision=1;
  let cards:CheckpointCard[]=empty?[]:[{id:'card',title:'Original title',notes:'',kind:'observation',anchor:position,capturedAt:new Date(1000).toISOString(),createdAt:new Date(1000).toISOString(),requirementIds:[],annotationIds:[]}];
  let delay:(()=>Promise<void>)|undefined;
  const draft=()=>({draftId:'draft',draftRevision:revision,taskBrief:{objective:'Goal',scope:''}});
  const call=vi.fn(async(method:string,body:any={})=>{
    if(method==='workingMaterialDraft'||method==='materialDraft')return draft();
    if(method==='materialCatalog')return {catalogRevision:1,workingDraftId:'draft',drafts:{draft:{name:'Current'}},revisions:{},recordings:{}};
    if(method==='materialDrafts')return {items:[draft()],outputTruncated:false};
    if(method==='materialRevisions')return {items:[],outputTruncated:false};
    if(method==='materialEntity')return {item:structuredClone(cards.find(card=>card.id===body.entityId)),draftRevision:revision};
    if(method==='materialCollection'){
      const items=body.collection==='checkpoints'?structuredClone(cards):body.collection==='recordingRefs'?['recording']:[];
      if(body.collection==='checkpoints')await delay?.();
      return {items,outputTruncated:false};
    }
    if(method==='editMaterialDraft'){
      if(body.expectedDraftRevision!==revision)return {status:'conflict',current:draft()};
      for(const edit of body.edits)if(edit.operation==='upsert'&&edit.collection==='checkpoints'){const index=cards.findIndex(card=>card.id===edit.item.id);if(index<0)cards.push(structuredClone(edit.item));else cards[index]=structuredClone(edit.item);}
      revision++;return {status:'saved',draft:draft(),createdIds:[]};
    }
    throw new Error(method);
  });
  const client:MaterialWorkbenchClient={host:'browser',storage:memoryEditorStorage(),canEdit:()=>true,call:call as MaterialEditorCall};
  const props={projectId:'project',client,writable:true,refreshToken:0,position,onOpenReplay:vi.fn(),onSelectTarget:vi.fn()};
  const view=render(<MaterialWorkbench {...props}/>);
  const ready=async()=>{await screen.findByRole('button',{name:'保存修改'});await waitFor(()=>expect(screen.queryByText('读取工作副本')).toBeNull());};
  return {call,props,view,ready,cards:()=>cards,setDelay:(value?:()=>Promise<void>)=>{delay=value;},update:()=>{revision++;cards=cards.map(card=>({...card,title:'Server title'}));}};
}
test('a complete external projection cannot adopt a new revision over input typed while collections load',async()=>{
  const f=fixture();await f.ready();fireEvent.click(screen.getByRole('button',{name:/Original title/}));
  fireEvent.click(await screen.findByRole('button',{name:'编辑保存点'}));const title=await screen.findByLabelText('标题');
  await waitFor(()=>expect(screen.queryByText('读取编辑对象')).toBeNull());
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  f.setDelay(async()=>{entered();await gate;});f.update();
  f.view.rerender(<MaterialWorkbench {...f.props} refreshToken={1}/>);
  await act(async()=>{await waiting;});
  fireEvent.change(title,{target:{value:'Local input during refresh'}});
  f.setDelay(undefined);await act(async()=>release());
  await screen.findByText(/本页输入和原修订保留/);
  expect(screen.getByLabelText('标题')).toBe(title);expect((title as HTMLInputElement).value).toBe('Local input during refresh');
  fireEvent.click(screen.getByRole('button',{name:'完成保存点编辑'}));await screen.findByText('本机恢复输入需要先读取当前修订并核对，尚未保存或发布。');
  expect(f.call.mock.calls.filter(([method])=>method==='editMaterialDraft')).toHaveLength(0);
});
test('a new checkpoint retains the real source chosen when creation began',async()=>{
  const f=fixture(true);await f.ready();fireEvent.click(screen.getByRole('button',{name:'新增保存点'}));
  const title=await screen.findByLabelText('标题');fireEvent.change(title,{target:{value:'Frozen source'}});
  f.view.rerender(<MaterialWorkbench {...f.props} position={{...position,eventSeq:2,sourceTimeMs:2000}}/>);
  fireEvent.click(screen.getByRole('button',{name:'完成保存点编辑'}));await waitFor(()=>expect(f.cards()).toHaveLength(1));
  expect(f.cards()[0].anchor).toEqual(position);
});
