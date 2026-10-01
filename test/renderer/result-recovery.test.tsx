/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from './workbench-test-client';
import { afterEach, expect, test, vi } from 'vitest';
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import { ResultCenter } from '@/renderer/components/result-center';

afterEach(() => { cleanup(); clearTestWorkbenchClient(); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
  let assessment: Promise<any> | undefined, review: Promise<any> | undefined;
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'execution') return { status: 'completed', workflowAttemptId: 'workflow', binding: { materialRevisionId: 'fixed' } };
    if (method === 'executionItems') return { items: body.collection === 'datasets' ? ['first', 'second'].map(attemptId => ({ executionId: body.executionId, attemptId, datasetId: 'orders', status: 'complete', committedBatches: 1, committedRecords: 1 })) : [] };
    if (method === 'executionReports') return { items: ['report-a', 'report-b'].map(reportId => ({ reportId, overall: 'inconclusive' })) };
    if (method === 'executionReport') return { reportId: body.reportId, overall: 'inconclusive', binding: { executionId: body.executionId, materialRevisionId: 'fixed' } };
    if (method === 'executionReportItems') return { items: body.collection === 'requirements' ? [{ requirementId: 'shared-requirement', verdict: 'inconclusive', materialContext: { description: 'Same requirement in both reports', fields: [] } }] : [{ identity: { executionId: body.executionId, datasetId: 'orders', attemptId: body.reportId === 'report-a' ? 'first' : 'second' }, status: 'complete', committedRecords: 1 }] };
    if (method === 'assessExecution') return assessment ?? { reportId: 'report-new' };
    if (method === 'reviewExecution') return review ?? { id: 'review' };
    throw new Error(method);
  });
  setTestWorkbenchClient({ call, bounds: vi.fn() });
  const view = render(<ResultCenter projectId="project" executionId="execution"/>);
  const open = async (id: string) => { fireEvent.click(await screen.findByRole('button', { name: `${id} · inconclusive` })); await screen.findByRole('heading', { name: 'Same requirement in both reports' }); };
  const typeReview = () => { fireEvent.change(screen.getByLabelText('需求'), { target: { value: 'shared-requirement' } }); fireEvent.change(screen.getByLabelText('判断'), { target: { value: 'reject' } }); fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'Only report A was checked' } }); };
  return { call, view, open, typeReview, holdAssessment: (promise: Promise<any>) => { assessment = promise; }, holdReview: (promise: Promise<any>) => { review = promise; } };
}

test('a saved-report switch cannot strand assessment busy state or admit a duplicate write', async () => {
  const f = fixture(), pending = deferred<any>(); f.holdAssessment(pending.promise);
  await f.open('report-a'); fireEvent.click(screen.getAllByRole('button', { name: '用于验收' })[0]);
  fireEvent.click(screen.getByRole('button', { name: '按所选 attempt 验收' }));
  await waitFor(() => expect(f.call.mock.calls.filter(([method]) => method === 'assessExecution')).toHaveLength(1));
  await f.open('report-b');
  expect((screen.getByRole('button', { name: '固定资料验收' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getAllByRole('button', { name: '用于验收' })[1]);
  expect((screen.getByRole('button', { name: '固定资料验收' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve({ reportId: 'report-new' }));
  expect((await screen.findByRole('button', { name: '按所选 attempt 验收' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('report-new')).toBeNull();
  expect(f.call.mock.calls.filter(([method]) => method === 'assessExecution')).toHaveLength(1);
});

test('review input belongs to its report and saved-report attempts do not follow prospective choices', async () => {
  const f = fixture(); await f.open('report-a'); f.typeReview();
  await f.open('report-b');
  expect((screen.getByLabelText('需求') as HTMLSelectElement).value).toBe('');
  expect((screen.getByLabelText('判断') as HTMLSelectElement).value).toBe('accept');
  expect((screen.getByLabelText('理由') as HTMLTextAreaElement).value).toBe('');
  expect((screen.getByRole('button', { name: '保存人工判定' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText('人工判定目标').textContent).toContain('report-b');
  expect(screen.getByLabelText('本报告数据集范围').textContent).toContain('second');
  expect(screen.getByLabelText('本报告数据集范围').textContent).not.toContain('first');
  f.typeReview(); f.view.rerender(<ResultCenter projectId="project" executionId="another-execution"/>);
  await waitFor(() => expect(f.call).toHaveBeenCalledWith('execution', expect.objectContaining({ executionId: 'another-execution' })));
  await f.open('report-a'); expect((screen.getByLabelText('理由') as HTMLTextAreaElement).value).toBe('');
});

test('late review failure cannot replace newer report input and a failed save can be retried', async () => {
  const f = fixture(), pending = deferred<any>(); f.holdReview(pending.promise);
  await f.open('report-a'); f.typeReview(); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  await waitFor(() => expect(f.call.mock.calls.filter(([method]) => method === 'reviewExecution')).toHaveLength(1));
  await f.open('report-b'); f.typeReview(); fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'Fresh report B review' } });
  await act(async () => pending.reject(new Error('Late report A failure')));
  expect(screen.queryByText(/Late report A failure/)).toBeNull();
  expect((screen.getByLabelText('理由') as HTMLTextAreaElement).value).toBe('Fresh report B review');
  expect((screen.getByRole('button', { name: '保存人工判定' }) as HTMLButtonElement).disabled).toBe(false);
  const retry = deferred<any>(); f.holdReview(retry.promise); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  await act(async () => retry.reject(new Error('Current report B failure')));
  expect((await screen.findByText(/Current report B failure/)).closest('.human-review')).toBeTruthy();
  expect((screen.getByLabelText('理由') as HTMLTextAreaElement).value).toBe('Fresh report B review');
  f.holdReview(Promise.resolve({ id: 'saved-review' })); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  expect((await screen.findByText(/人工判定已追加保存/)).closest('.human-review')).toBeTruthy();
  expect(f.call).toHaveBeenLastCalledWith('reviewExecution', expect.objectContaining({ reportId: 'report-b', reason: 'Fresh report B review' }));
});

test('the owning review form is disabled while its exact submitted draft is being saved', async () => {
  const f = fixture(), pending = deferred<any>(); f.holdReview(pending.promise);
  await f.open('report-a'); f.typeReview(); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  expect(screen.getByLabelText('理由').closest('fieldset')?.disabled).toBe(true);
  await act(async () => pending.resolve({ id: 'saved-old-input' }));
  expect((screen.getByLabelText('理由') as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByLabelText('理由').closest('fieldset')?.disabled).toBe(false);
});

test('an assessment from a previous visit to the same execution cannot refresh the new visit', async () => {
  const f = fixture(), pending = deferred<any>(); f.holdAssessment(pending.promise);
  await f.open('report-a'); fireEvent.click(screen.getByRole('button', { name: '按所选 attempt 验收' }));
  f.view.rerender(<ResultCenter projectId="project" executionId="another"/>);
  await waitFor(() => expect(f.call).toHaveBeenCalledWith('execution', expect.objectContaining({ executionId: 'another' })));
  f.view.rerender(<ResultCenter projectId="project" executionId="execution"/>);
  await f.open('report-b'); const reads = f.call.mock.calls.filter(([method]) => method === 'executionReports').length;
  await act(async () => pending.resolve({ reportId: 'old-visit-report' }));
  expect(f.call.mock.calls.filter(([method]) => method === 'executionReports')).toHaveLength(reads);
  expect(screen.getByLabelText('人工判定目标').textContent).toContain('report-b');
});

test('a new failed review does not retain an earlier success notice and requirement labels remain exact', async () => {
  const f = fixture(); await f.open('report-a');
  const option = screen.getByRole('option', { name: 'Same requirement in both reports' }) as HTMLOptionElement;
  expect(option.value).toBe('shared-requirement'); expect(option.title).toBe('shared-requirement');
  f.typeReview(); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' })); await screen.findByText(/人工判定已追加保存/);
  const pending = deferred<any>(); f.holdReview(pending.promise); f.typeReview(); fireEvent.click(screen.getByRole('button', { name: '保存人工判定' }));
  expect(screen.queryByText(/人工判定已追加保存/)).toBeNull(); await act(async () => pending.reject(new Error('Second write refused')));
  expect((await screen.findByText(/Second write refused/)).closest('.human-review')).toBeTruthy(); expect(screen.queryByText(/人工判定已追加保存/)).toBeNull();
});
