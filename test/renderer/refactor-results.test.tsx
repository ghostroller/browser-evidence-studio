/** @vitest-environment jsdom */
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { ResultCenter } from '@/renderer/components/result-center';

afterEach(() => { cleanup(); clearTestWorkbenchClient(); });

test('C19: fixed requirement examples and actual verification sources navigate to distinct identities',async()=>{
  const position={recordingId:'example-run',pageId:'p',documentId:'d',streamEpoch:'e',sourceTimeMs:10,eventSeq:3};
  const example={kind:'dom-node' as const,position,frameId:'f',mirrorScopeId:'m',nodeId:7};
  const actual={...example,position:{...position,recordingId:'execution-run',eventSeq:18},nodeId:25};
  const open=vi.fn();
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='execution')return {status:'completed',workflowAttemptId:'a',binding:{materialRevisionId:'fixed-v3'}};
    if(method==='executionItems')return {items:[]};
    if(method==='executionReports')return {items:[{reportId:'r',overall:'fail'}]};
    if(method==='executionReport')return {reportId:'r',overall:'fail',binding:{materialRevisionId:'fixed-v3'}};
    if(method==='executionReportItems')return {items:body.collection==='requirements'?[{requirementId:'req',verdict:'fail',schemaVerdict:'pass',sourceVerdict:'fail',checks:[],materialContext:{description:'逐条核对到账元',fields:[{id:'f',name:'到账元',target:example,example:{id:'card',title:'第二行例证',notes:'固定的说明',anchor:position}}]},fieldDiagnostics:[{fieldId:'f',outputPath:'/paid',entity:'order-two',actual:46,expected:45,rawText:'45.00',interpretation:'plain-decimal-v1',code:'value-mismatch',sourceRef:'dom-current',target:actual,identity:{executionId:'x',attemptId:'a',datasetId:'records'},batchId:'b',recordIndex:1,verdict:'fail',reason:'值不一致'}]}]:[]};
    if(method==='historicalNode')return {ref:body.target};
    throw new Error(method);
  });
  setTestWorkbenchClient({call,bounds:vi.fn()});render(<ResultCenter projectId="project" executionId="x" onOpenSource={open}/>);
  fireEvent.click(await screen.findByRole('button',{name:'r · fail'}));
  expect(await screen.findByRole('heading', { name: '逐条核对到账元' })).toBeTruthy();
  expect(screen.getByText(/业务范围尚缺证明/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'需求示例：第二行例证'}));
  await waitFor(()=>expect(open).toHaveBeenCalledWith(expect.objectContaining({position,target:example,label:expect.stringContaining('需求示例')})));
  fireEvent.click(screen.getByRole('button',{name:'本次验证来源'}));
  await waitFor(()=>expect(open).toHaveBeenLastCalledWith(expect.objectContaining({position:actual.position,target:actual,label:expect.stringContaining('本次验证来源'),detail:expect.stringContaining('45.00')})));
  expect(call).not.toHaveBeenCalledWith('materialDraft',expect.anything());
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }

test('an interrupted corrupt dataset stays diagnosed while committed sibling batches remain accessible', async () => {
  const call=vi.fn(async(method:string,body:any)=>{
    if(method==='execution')return {status:'interrupted',workflowAttemptId:'attempt',snapshotVerified:false,binding:{},datasetCatalogIssues:[{entry:'invalid-attempt',code:'INVALID_ENTRY',message:'Not a directory'}]};
    if(method==='executionItems'&&body.collection==='steps')return {items:[]};
    if(method==='executionItems'&&body.collection==='datasets')return {items:[
      {executionId:'execution-one',attemptId:'attempt',datasetId:'good',status:'unfinished',committedBatches:1,committedRecords:2},
      {executionId:'execution-one',attemptId:'attempt',datasetId:'bad',status:'corrupt',committedBatches:0,committedRecords:0,diagnostic:{code:'INVALID_JSON',message:'Metadata is corrupt'}},
    ]};
    if(method==='executionReports')return {items:[]};
    if(method==='datasetBatches')return {items:[{batchId:'committed',contentHash:'hash',recordCount:2,durableAt:'now'}]};
    throw new Error(method);
  });
  setTestWorkbenchClient({call,bounds:vi.fn()});
  render(<ResultCenter projectId="project-one" executionId="execution-one"/>);
  await waitFor(()=>expect(screen.getByText(/invalid-attempt/)).toBeTruthy());
  const bad=screen.getByText('bad').closest('.result-row')!;
  expect(bad.textContent).toContain('INVALID_JSON');
  expect((bad.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  expect((bad.querySelectorAll('button')[1] as HTMLButtonElement).disabled).toBe(true);
  const good=screen.getByText('good').closest('.result-row')!;
  fireEvent.click(good.querySelector('button')!);
  await waitFor(()=>expect(screen.getByText(/committed/)).toBeTruthy());
  expect(call).toHaveBeenCalledWith('datasetBatches',expect.objectContaining({datasetId:'good',attemptId:'attempt'}));
  expect(call).not.toHaveBeenCalledWith('datasetBatches',expect.objectContaining({datasetId:'bad'}));
});

test('assesses an explicitly selected dataset attempt and keeps machine and human layers separate', async () => {
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'execution') return { status: 'partial', workflowAttemptId: 'workflow-attempt', snapshotVerified: true,
      binding: { materialRevisionId: 'material-v1', codeFingerprint: 'c'.repeat(64), inputFingerprint: 'i'.repeat(64) } };
    if (method === 'executionItems' && body.collection === 'steps') return { items: [{ identity: { stepId: 'details', attemptId: 'step-attempt' }, state: 'partial', error: { message: 'one entity failed' } }] };
    if (method === 'executionItems' && body.collection === 'datasets') return { items: [
      { executionId: 'execution-one', attemptId: 'first-attempt', datasetId: 'orders', status: 'partial', committedBatches: 1, committedRecords: 2 },
      { executionId: 'execution-one', attemptId: 'second-attempt', datasetId: 'orders', status: 'complete', committedBatches: 2, committedRecords: 4 },
    ] };
    if (method === 'assessExecution') return { reportId: 'report-one', overall: 'inconclusive', coverage: 'partial' };
    if (method === 'executionReport') return { reportId: 'report-one', overall: 'inconclusive', coverage: 'partial', materialStatus: 'candidate', version: { verdict: 'pass' }, reasons: ['Source content unverified'] };
    if (method === 'executionReportItems' && body.collection === 'requirements') return { items: [{ requirementId: 'orders', verdict: 'inconclusive', coverage: 'partial', schemaVerdict: 'pass', sourceVerdict: 'inconclusive', checks: [], evidence: [], scriptAssertions: [], humanReviews: [] }] };
    if (method === 'executionReportItems' && body.collection === 'datasets') return { items: [{ identity: { executionId: 'execution-one', attemptId: 'second-attempt', datasetId: 'orders' }, status: 'complete', committedRecords: 4 }] };
    if (method === 'executionReports') return { items: [] };
    if (method === 'reviewExecution') return { id: 'review-one' };
    throw new Error(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  render(<ResultCenter projectId="project-one" executionId="execution-one" />);
  await waitFor(() => expect(screen.getByText('one entity failed')).toBeTruthy());
  fireEvent.click(screen.getAllByRole('button', { name: '用于验收' })[1]);
  fireEvent.click(screen.getByRole('button', { name: '按所选 attempt 验收' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('assessExecution', { projectId: 'project-one', executionId: 'execution-one', datasetIdentities: [{ executionId: 'execution-one', attemptId: 'second-attempt', datasetId: 'orders' }] }));
  await waitFor(() => expect(screen.getByText('Source content unverified')).toBeTruthy());
  expect(screen.getByText('候选资料版本不表示人已批准。', { exact: false })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('需求'), { target: { value: 'orders' } });
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'Reviewed a partial range only' } });
  fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('reviewExecution', expect.objectContaining({ projectId: 'project-one', executionId: 'execution-one', reportId: 'report-one', requirementId: 'orders', decision: 'accept', reason: 'Reviewed a partial range only' })));
  expect(screen.getByText(/机器总评/)).toBeTruthy();
});

test('late dataset, batch and record responses stay with their exact execution and attempt', async () => {
  const oldBatches = deferred<any>();
  const oldRecords = deferred<any>();
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'execution') return { status: 'partial', workflowAttemptId: 'workflow', snapshotVerified: true, binding: {} };
    if (method === 'executionItems' && body.collection === 'steps') return { items: [] };
    if (method === 'executionItems' && body.collection === 'datasets') return { items: [
      { executionId: body.executionId, attemptId: 'old-attempt', datasetId: 'orders', status: 'partial', committedBatches: 1, committedRecords: 1 },
      { executionId: body.executionId, attemptId: 'new-attempt', datasetId: 'orders', status: 'complete', committedBatches: 1, committedRecords: 1 },
    ] };
    if (method === 'executionReports') return { items: [] };
    if (method === 'datasetBatches') return body.attemptId === 'old-attempt' ? oldBatches.promise : { items: [{ batchId: 'new-batch', contentHash: 'new-hash', recordCount: 1, durableAt: 'now' }] };
    if (method === 'datasetRecords') return body.batchId === 'new-batch' ? oldRecords.promise : { items: [] };
    throw new Error(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  const view = render(<ResultCenter projectId="project-one" executionId="execution-one" />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: '查看数据' })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: '查看数据' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '查看数据' })[1]);
  await waitFor(() => expect(screen.getByText(/new-batch/)).toBeTruthy());
  await act(async () => oldBatches.resolve({ items: [{ batchId: 'old-batch', contentHash: 'old-hash', recordCount: 1 }] }));
  expect(screen.queryByText(/old-batch/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /new-batch/ }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('datasetRecords', expect.objectContaining({ attemptId: 'new-attempt', batchId: 'new-batch' })));
  view.rerender(<ResultCenter projectId="project-one" executionId="execution-two" />);
  await waitFor(() => expect(screen.getByText('execution-two')).toBeTruthy());
  await act(async () => oldRecords.resolve({ items: [{ leaked: 'old-record' }] }));
  expect(screen.queryByText('old-record')).toBeNull();
});

test('reopens a saved fixed report and ignores a late report from a different selection', async () => {
  const oldReport = deferred<any>();
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'execution') return { status: 'complete', workflowAttemptId: 'workflow', snapshotVerified: true, binding: {} };
    if (method === 'executionItems' && body.collection === 'steps') return { items: [] };
    if (method === 'executionItems' && body.collection === 'datasets') return { items: [
      { executionId: 'execution-one', attemptId: 'first', datasetId: 'orders', status: 'complete', committedBatches: 1, committedRecords: 1 },
      { executionId: 'execution-one', attemptId: 'second', datasetId: 'orders', status: 'complete', committedBatches: 1, committedRecords: 1 },
    ] };
    if (method === 'executionReports') return { items: [{ reportId: 'saved-report', overall: 'inconclusive' }] };
    if (method === 'executionReport') return body.reportId === 'saved-report' ? oldReport.promise : { reportId: 'new-report', overall: 'pass', coverage: 'complete', reasons: ['new-report-reason'] };
    if (method === 'executionReportItems') return { items: [] };
    if (method === 'assessExecution') return { reportId: 'new-report' };
    throw new Error(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  render(<ResultCenter projectId="project-one" executionId="execution-one" />);
  await waitFor(() => expect(screen.getByRole('button', { name: /saved-report/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /saved-report/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '用于验收' })[1]);
  fireEvent.click(screen.getByRole('button', { name: '按所选 attempt 验收' }));
  await waitFor(() => expect(screen.getByText('new-report-reason')).toBeTruthy());
  await act(async () => oldReport.resolve({ reportId: 'saved-report', overall: 'fail', coverage: 'none', reasons: ['old-report-reason'] }));
  expect(screen.queryByText('old-report-reason')).toBeNull();
});

test('initial result failure is explicit and retries instead of remaining permanently loading', async () => {
  let fail = true;
  const call = vi.fn(async (method: string) => {
    if (method === 'execution') { if (fail) throw new Error('Synthetic read failure'); return { status: 'completed', binding: {} }; }
    return { items: [] };
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() }); render(<ResultCenter projectId="project" executionId="execution"/>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: Synthetic read failure');
  expect(screen.queryByText('正在读取实际执行身份…')).toBeNull();
  fail = false; fireEvent.click(screen.getByRole('button', { name: '重新读取执行结果' }));
  expect(await screen.findByText('执行结果中心')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
