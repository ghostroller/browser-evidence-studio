/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MaterialWorkbench } from '@/renderer/components/material-workbench';
import type { MaterialContent } from '@/contracts/materials';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import type { SelectionRequest } from '@/renderer/selection-session';

const position: ReplayPosition = { recordingId: 'recording-one', pageId: 'page-one', documentId: 'document-one', streamEpoch: 'epoch-one', sourceTimeMs: 1000, eventSeq: 7 };
const target: HistoricalElementRef = { kind: 'dom-node', position, frameId: 'top', mirrorScopeId: 'scope-one', nodeId: 42 };
const content = (): MaterialContent => ({ recordingRefs: ['recording-one'], annotations: [],
  requirements: [{ id: 'orders', description: 'All paid orders', dataset: 'orders', rules: [], fieldIds: ['amount'] }],
  fields: [{ id: 'amount', dataset: 'orders', name: 'Paid amount', description: 'Charged amount', outputPath: '/amount', sourcePolicy: 'any-evidenced' }],
  checkpoints: [{ id: 'card', kind: 'requirement', anchor: position, capturedAt: new Date(1000).toISOString(), createdAt: new Date(2000).toISOString(), title: 'Order example', notes: '', requirementIds: ['orders'], annotationIds: [] }],
});
afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }

test('shows an optimistic edit conflict and never silently overwrites the newer draft', async () => {
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: [{ draftId: 'draft-one', draftRevision: 0, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: 'draft-one', draftRevision: 0 };
    if (method === 'materialCollection') return { items: content()[body.collection as keyof MaterialContent] };
    if (method === 'editMaterialDraft') return { status: 'conflict', current: { draftId: 'draft-one', draftRevision: 1 } };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /draft-one/ }));
  fireEvent.change(await screen.findByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('需求说明'), { target: { value: 'All paid orders including final page' } });
  fireEvent.click(screen.getByRole('button', { name: '保存需求' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('当前修订 1'));
  expect((screen.getByLabelText('需求说明') as HTMLTextAreaElement).value).toBe('All paid orders including final page');
  expect(call).toHaveBeenCalledWith('editMaterialDraft', expect.objectContaining({ projectId: 'project-one', draftId: 'draft-one', expectedDraftRevision: 0 }));
  expect(call.mock.calls.filter(([method]) => method === 'editMaterialDraft')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /读取修订 1/ })).toBeTruthy();
});

test('edits a field through description, target, and target plus annotation paths', async () => {
  let revision = 0;
  let stored = content();
  stored.annotations = [{ id: 'note-one', checkpointId: 'card', target, text: 'Visible paid amount', author: 'human', interpretation: 'observed', bindingStatus: 'bound' }];
  stored.checkpoints[0].annotationIds = ['note-one'];
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: [{ draftId: 'draft-one', draftRevision: revision, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: 'draft-one', draftRevision: revision };
    if (method === 'materialCollection') return { items: stored[body.collection as keyof MaterialContent] };
    if (method === 'editMaterialDraft') {
      expect(body.expectedDraftRevision).toBe(revision);
      for (const edit of body.edits) if (edit.operation === 'upsert') {
        const collection = stored[edit.collection as 'fields' | 'requirements'] as Array<{ id: string }>;
        const index = collection.findIndex(item => item.id === edit.item.id);
        if (index >= 0) collection[index] = edit.item; else collection.push(edit.item);
      }
      return { status: 'saved', draft: { draftId: 'draft-one', draftRevision: ++revision } };
    }
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const onSelectTarget=vi.fn();
  const view = render(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={onSelectTarget} />);
  fireEvent.click(await screen.findByRole('button', { name: /draft-one/ }));
  fireEvent.change(await screen.findByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('字段'), { target: { value: 'amount' } });
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(1));
  expect(stored.fields[0].target).toBeUndefined();
  expect(stored.fields[0].annotationId).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: /Order example/ }));
  fireEvent.click(screen.getByRole('button',{name:'从历史页绑定元素'}));
  const request=onSelectTarget.mock.lastCall?.[0] as SelectionRequest;
  view.rerender(<MaterialWorkbench projectId="project-one" recordingId="recording-one" position={position} selectedTarget={{request,target,replayId:'replay-one',generation:1}} onOpenReplay={vi.fn()} onSelectTarget={onSelectTarget} />);
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(2));
  expect(stored.fields[0].target).toEqual(target);
  expect(stored.fields[0].annotationId).toBeUndefined();
  expect(stored.fields[0].checkpointId).toBe('card');
  fireEvent.change(screen.getByLabelText('关联元素注释（可选）'), { target: { value: 'note-one' } });
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }));
  await waitFor(() => expect(revision).toBe(3));
  expect(stored.fields[0].annotationId).toBe('note-one');
});

test('late collections and edits cannot cross a draft or project switch', async () => {
  const oldCollection = deferred<any>();
  const oldEdit = deferred<any>();
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: body.projectId === 'project-two'
      ? [{ draftId: 'project-two-draft', draftRevision: 0, status: 'available' }]
      : [{ draftId: 'old-draft', draftRevision: 0, status: 'available' }, { draftId: 'new-draft', draftRevision: 0, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: body.draftId, draftRevision: 0 };
    if (method === 'materialCollection') {
      if (body.draftId === 'old-draft' && body.collection === 'checkpoints') return oldCollection.promise;
      const material = content();
      if (body.draftId === 'new-draft') material.checkpoints[0].title = 'New draft card';
      if (body.draftId === 'project-two-draft') material.checkpoints[0].title = 'Project two card';
      return { items: material[body.collection as keyof MaterialContent] };
    }
    if (method === 'editMaterialDraft') return oldEdit.promise;
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const props = { recordingId: 'recording-one', position, onOpenReplay: vi.fn(), onSelectTarget: vi.fn() };
  const view = render(<MaterialWorkbench projectId="project-one" {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /old-draft/ }));
  fireEvent.click(screen.getByRole('button', { name: /new-draft/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /New draft card/ })).toBeTruthy());
  await act(async () => oldCollection.resolve({ items: [{ ...content().checkpoints[0], title: 'Leaked old draft card' }] }));
  expect(screen.queryByText(/Leaked old draft card/)).toBeNull();
  fireEvent.change(screen.getByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('需求说明'), { target: { value: 'Unsaved local change' } });
  fireEvent.click(screen.getByRole('button', { name: '保存需求' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('editMaterialDraft', expect.objectContaining({ projectId: 'project-one', draftId: 'new-draft' })));
  view.rerender(<MaterialWorkbench projectId="project-two" {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /project-two-dra/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Project two card/ })).toBeTruthy());
  expect((screen.getByLabelText('需求说明') as HTMLTextAreaElement).value).toBe('');
  await act(async () => oldEdit.resolve({ status: 'saved', draft: { draftId: 'new-draft', draftRevision: 1 } }));
  expect(screen.queryByText('Unsaved local change')).toBeNull();
  expect(screen.queryByText(/已保存到草稿/)).toBeNull();
  expect(screen.getByRole('button', { name: /Project two card/ })).toBeTruthy();
});

test('recording-reference read failure stays visible and never submits a checkpoint edit', async () => {
  let references = 0;
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'materialDrafts') return { items: [{ draftId: 'draft-one', draftRevision: 0, status: 'available' }] };
    if (method === 'materialRevisions') return { items: [] };
    if (method === 'materialDraft') return { draftId: 'draft-one', draftRevision: 0 };
    if (method === 'materialCollection') {
      if (body.collection === 'recordingRefs' && ++references > 1) throw new Error('reference index unavailable');
      const value = content()[body.collection as keyof MaterialContent];
      return { items: body.collection === 'checkpoints' ? [] : value };
    }
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<MaterialWorkbench projectId="project-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /draft-one/ }));
  await waitFor(() => expect(screen.getByLabelText('标题')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'New checkpoint' } });
  fireEvent.click(screen.getByRole('button', { name: '保存卡片草稿' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('reference index unavailable'));
  expect(call.mock.calls.some(([method]) => method === 'editMaterialDraft')).toBe(false);
});

test('annotation and field selection requests carry distinct card and draft identities',async()=>{
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[{draftId:'draft-one',draftRevision:0}]};
    if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:'draft-one',draftRevision:0};
    if(method==='materialCollection')return {items:content()[body.collection as keyof MaterialContent]};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  const onSelectTarget=vi.fn();
  render(<MaterialWorkbench projectId="project-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={onSelectTarget}/>);
  fireEvent.click(await screen.findByRole('button',{name:/draft-one/}));
  fireEvent.click(await screen.findByRole('button',{name:/Order example/}));
  fireEvent.click(screen.getByRole('button',{name:'在历史页选择元素'}));
  expect(onSelectTarget).toHaveBeenCalledWith(expect.objectContaining({projectId:'project-one',draftId:'draft-one',expectedDraftRevision:0,checkpointId:'card',anchor:position,purpose:'annotation'}));
});

test('card offers an inline requirement association instead of a requirement ID input',async()=>{
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[{draftId:'draft-one',draftRevision:0}]};
    if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:'draft-one',draftRevision:0};
    if(method==='materialCollection')return {items:content()[body.collection as keyof MaterialContent]};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};const onSelectTarget=vi.fn();
  const props={projectId:'project-one',position,onOpenReplay:vi.fn(),onSelectTarget};
  const view=render(<MaterialWorkbench {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:/draft-one/}));
  fireEvent.click(await screen.findByRole('button',{name:/Order example/}));
  expect(screen.queryByLabelText('关联需求 ID')).toBeNull();
  expect(screen.getByRole('button',{name:'新建并关联需求'})).toBeTruthy();
});

test('selection receipts cannot cross annotation and field editors or a later selection',async()=>{
  let revision=0;const stored=content();
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[{draftId:'draft-one',draftRevision:revision}]};
    if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:'draft-one',draftRevision:revision};
    if(method==='materialCollection')return {items:stored[body.collection as keyof MaterialContent]};
    if(method==='editMaterialDraft'){
      for(const edit of body.edits)if(edit.operation==='upsert'){const list=stored[edit.collection as 'fields'|'requirements'] as Array<{id:string}>;const index=list.findIndex(item=>item.id===edit.item.id);if(index>=0)list[index]=edit.item;else list.push(edit.item);}
      return {status:'saved',draft:{draftId:'draft-one',draftRevision:++revision}};
    }
    return {};
  });
  window.studio={call,bounds:vi.fn()};const onSelectTarget=vi.fn();
  const props={projectId:'project-one',position,onOpenReplay:vi.fn(),onSelectTarget};
  const view=render(<MaterialWorkbench {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:/draft-one/}));
  fireEvent.click(await screen.findByRole('button',{name:/Order example/}));
  fireEvent.change(screen.getByLabelText('需求'),{target:{value:'orders'}});
  fireEvent.change(screen.getByLabelText('字段'),{target:{value:'amount'}});
  fireEvent.click(screen.getByRole('button',{name:'在历史页选择元素'}));
  const annotationRequest=onSelectTarget.mock.lastCall?.[0] as SelectionRequest;
  view.rerender(<MaterialWorkbench {...props} selectedTarget={{request:annotationRequest,target,replayId:'replay-one',generation:1}}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存字段'}));
  await waitFor(()=>expect(revision).toBe(1));
  expect(stored.fields[0].target).toBeUndefined();
  fireEvent.click(screen.getByRole('button',{name:'从历史页绑定元素'}));
  const fieldRequest=onSelectTarget.mock.lastCall?.[0] as SelectionRequest;
  expect(fieldRequest.purpose).toBe('field');expect(fieldRequest.selectionId).not.toBe(annotationRequest.selectionId);
  view.rerender(<MaterialWorkbench {...props} selectedTarget={{request:annotationRequest,target,replayId:'replay-one',generation:2}}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存字段'}));
  await waitFor(()=>expect(revision).toBe(2));expect(stored.fields[0].target).toBeUndefined();
  fireEvent.click(screen.getByRole('button',{name:'从历史页绑定元素'}));
  const currentFieldRequest=onSelectTarget.mock.lastCall?.[0] as SelectionRequest;
  const fieldTarget={...target,nodeId:43};
  view.rerender(<MaterialWorkbench {...props} selectedTarget={{request:currentFieldRequest,target:fieldTarget,replayId:'replay-one',generation:3}}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存字段'}));
  await waitFor(()=>expect(revision).toBe(3));expect(stored.fields[0].target).toEqual(fieldTarget);
});

test('annotation edits reuse its ID and deletion clears only dependent field association',async()=>{
  let revision=0;const stored=content();
  stored.annotations=[{id:'note-one',checkpointId:'card',target,text:'Original',author:'human',interpretation:'observed',bindingStatus:'bound'}];
  stored.checkpoints[0].annotationIds=['note-one'];stored.fields[0]={...stored.fields[0],target,checkpointId:'card',bindingStatus:'bound',annotationId:'note-one'};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[{draftId:'draft-one',draftRevision:revision}]};
    if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:'draft-one',draftRevision:revision};
    if(method==='materialCollection')return {items:stored[body.collection as keyof MaterialContent]};
    if(method==='editMaterialDraft'){
      expect(body.expectedDraftRevision).toBe(revision);
      for(const edit of body.edits){const list=stored[edit.collection as 'annotations'|'checkpoints'|'fields'] as Array<{id:string}>;
        if(edit.operation==='remove'){const index=list.findIndex(item=>item.id===edit.id);if(index>=0)list.splice(index,1);}
        if(edit.operation==='upsert'){const index=list.findIndex(item=>item.id===edit.item.id);if(index>=0)list[index]=edit.item;else list.push(edit.item);}
      }
      return {status:'saved',draft:{draftId:'draft-one',draftRevision:++revision}};
    }
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};const onSelectTarget=vi.fn();
  const props={projectId:'project-one',position,onOpenReplay:vi.fn(),onSelectTarget};
  const view=render(<MaterialWorkbench {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:/draft-one/}));
  fireEvent.click(await screen.findByRole('button',{name:/Order example/}));
  fireEvent.click(screen.getByRole('button',{name:'编辑注释'}));
  fireEvent.change(screen.getByLabelText('注释'),{target:{value:'Revised interpretation'}});
  fireEvent.click(screen.getByRole('button',{name:'保存注释修改'}));
  await waitFor(()=>expect(revision).toBe(1));
  expect(stored.annotations).toHaveLength(1);expect(stored.annotations[0].id).toBe('note-one');expect(stored.annotations[0].text).toBe('Revised interpretation');
  fireEvent.click(screen.getByRole('button',{name:'重新绑定历史元素'}));
  const request=onSelectTarget.mock.lastCall?.[0] as SelectionRequest;
  const rebound={...target,nodeId:43};
  view.rerender(<MaterialWorkbench {...props} selectedTarget={{request,target:rebound,replayId:'replay-one',generation:2}}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存注释修改'}));
  await waitFor(()=>expect(revision).toBe(2));
  expect(stored.annotations[0].target).toEqual(rebound);
  expect(stored.fields[0].target).toEqual(target);expect(stored.fields[0].bindingStatus).toBe('needs-rebind');expect(stored.fields[0].annotationId).toBeUndefined();
  fireEvent.click(screen.getByRole('button',{name:'删除注释'}));
  await waitFor(()=>expect(revision).toBe(3));
  expect(stored.annotations).toHaveLength(0);expect(stored.checkpoints[0].annotationIds).toEqual([]);
  expect(stored.fields[0].annotationId).toBeUndefined();expect(stored.fields[0].target).toEqual(target);
});

test('creates a requirement and links it to the selected card in one conditional edit',async()=>{
  let revision=0;const stored=content();
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[{draftId:'draft-one',draftRevision:revision}]};
    if(method==='materialRevisions')return {items:[]};
    if(method==='materialDraft')return {draftId:'draft-one',draftRevision:revision};
    if(method==='materialCollection')return {items:stored[body.collection as keyof MaterialContent]};
    if(method==='editMaterialDraft'){
      expect(body.expectedDraftRevision).toBe(0);
      expect(body.edits.map((edit:any)=>edit.collection)).toEqual(['requirements','checkpoints']);
      const created=body.edits[0].item;const card=body.edits[1].item;
      expect(card.requirementIds).toContain(created.id);
      stored.requirements.push(created);stored.checkpoints[0]=card;
      return {status:'saved',draft:{draftId:'draft-one',draftRevision:++revision}};
    }
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  render(<MaterialWorkbench projectId="project-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:/draft-one/}));
  fireEvent.click(await screen.findByRole('button',{name:/Order example/}));
  fireEvent.change(screen.getByLabelText('新需求含义'),{target:{value:'Include refunds'}});
  fireEvent.click(screen.getByRole('button',{name:'新建并关联需求'}));
  await waitFor(()=>expect(revision).toBe(1));
  expect(stored.requirements.at(-1)?.description).toBe('Include refunds');
  expect(stored.checkpoints[0].requirementIds).toHaveLength(2);
});

test('opens a fixed revision by hash and derives a new draft without editing the revision',async()=>{
  const fixed=content();const revision={revisionId:'revision-v1',contentHash:'hash-v1',createdAt:'2026-09-26T00:00:00.000Z'};
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='materialDrafts')return {items:[]};
    if(method==='materialRevisions')return {items:[revision]};
    if(method==='materialRevision')return revision;
    if(method==='materialCollection')return {items:fixed[body.collection as keyof MaterialContent]};
    if(method==='createMaterialDraft')return {draftId:'derived-draft',draftRevision:0,baseRevisionId:body.baseRevisionId};
    if(method==='materialDraft')return {draftId:'derived-draft',draftRevision:0,baseRevisionId:'revision-v1'};
    throw new Error(method);
  });
  window.studio={call,bounds:vi.fn()};
  render(<MaterialWorkbench projectId="project-one" position={position} onOpenReplay={vi.fn()} onSelectTarget={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看固定版本'}));
  await waitFor(()=>expect(screen.getByText('All paid orders')).toBeTruthy());
  expect(call).toHaveBeenCalledWith('materialRevision',expect.objectContaining({revisionId:'revision-v1',contentHash:'hash-v1'}));
  fireEvent.click(screen.getByRole('button',{name:'从此版本派生草稿'}));
  await waitFor(()=>expect(call).toHaveBeenCalledWith('createMaterialDraft',expect.objectContaining({baseRevisionId:'revision-v1'})));
  expect(fixed.requirements[0].description).toBe('All paid orders');
});
