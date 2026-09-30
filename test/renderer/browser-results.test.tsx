/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { SessionThemeProvider } from '@/renderer/components/theme-provider';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[], nextCursor?: string) => ({ items, returnedBytes: 100, outputTruncated: !!nextCursor, ...(nextCursor ? { nextCursor } : {}) });
const binding = (id: string) => ({ schemaVersion: 1, projectId: 'project', executionId: id, materialRevisionId: 'fixed-v1', materialContentHash: 'h', codeFingerprint: 'c', inputFingerprint: 'i', mode: 'current-page-test' });
const descriptor = (executionId: string) => ({ executionId, startedAt: '2026-09-30T01:00:00.000Z', status: 'partial', materialRevisionId: 'fixed-v1', mode: 'current-page-test' });
const position = { recordingId: 'recording', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', eventSeq: 3, sourceTimeMs: 1000 };
const clients: BrowserWorkbenchClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); delete window.studio; });
function fixture(grant = 'project-workbench') {
  let override: ((method: string, body: any) => Promise<Response> | undefined) | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (url === '/workbench/session') return json({ token: 'b'.repeat(43), instanceId: 'instance', projectId: 'project', grant, expiresAt: Date.now() + 300_000 });
    if (url === '/workbench/events') return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
    const { method, body } = JSON.parse(String(init?.body));
    const replaced = override?.(method, body); if (replaced) return replaced;
    if (method === 'state') return json({ project: { id: 'project', name: 'Orders', objective: 'Keep input', revision: 1 } });
    if (method === 'projectExecutions') return json(page([descriptor(body.cursor ? 'execution-two' : 'execution-one')], body.cursor ? undefined : 'catalog-next'));
    if (method === 'execution') return json({ binding: binding(body.executionId), status: 'partial', workflowAttemptId: 'workflow', counts: { steps: 1, datasets: 1 }, snapshotVerified: true });
    if (method === 'executionItems') return json(page(body.collection === 'steps' ? [{ identity: { executionId: body.executionId, stepId: 'orders', attemptId: 'attempt' }, state: 'failed', error: { name: 'Error', message: 'Synthetic step failed' } }] : [{ executionId: body.executionId, attemptId: 'attempt', datasetId: 'orders', status: 'partial', committedBatches: 1, committedRecords: 1 }]));
    if (method === 'executionReports') return json(page([{ reportId: 'saved-report', binding: binding(body.executionId), overall: 'fail' }]));
    if (method === 'datasetBatches') return json(page([{ executionId: body.executionId, attemptId: 'attempt', datasetId: 'orders', batchId: 'batch', contentHash: 'hash', recordCount: 1, durableAt: 'now' }]));
    if (method === 'datasetRecords') return json(page([{ batchId: 'batch', recordIndex: 0, value: { amount: null }, missingFields: ['absent'] }]));
    if (method === 'executionReport') return json({ binding: binding(body.executionId), reportId: 'saved-report', overall: 'fail', version: { verdict: 'pass' }, reasons: ['Saved failure'] });
    if (method === 'executionReportItems') return json(page(body.collection === 'requirements' ? [{ requirementId: 'amount', verdict: 'fail', schemaVerdict: 'pass', sourceVerdict: 'fail', materialContext: { description: '实际到账金额', fields: [{ id: 'amount', name: '金额', example: { id: 'example', title: '合成来源示例', notes: '示例', anchor: position } }] }, checks: [], humanReviews: [], evidence: [], scriptAssertions: [] }] : []));
    throw new Error(`Unexpected method ${method}`);
  });
  const client = new BrowserWorkbenchClient({ instanceId: 'instance', fetch: fetcher as typeof fetch, retryDelaysMs: [] }); clients.push(client);
  const native = vi.fn(() => { throw new Error('Native must not run'); }); window.studio = { call: native, bounds: native, onChanged: native };
  const rendered = render(<SessionThemeProvider><App host="browser" client={client}/></SessionThemeProvider>);
  const connect = async () => { fireEvent.change(screen.getByLabelText('一次性配对票据'), { target: { value: 'a'.repeat(43) } }); fireEvent.click(screen.getByRole('button', { name: '连接合成项目' })); await screen.findByLabelText('项目名称'); };
  const open = async () => { fireEvent.click(screen.getByRole('button', { name: '打开只读结果' })); await screen.findByRole('option', { name: /当前页测试/ }); await waitFor(() => expect((screen.getByLabelText('选择项目执行') as HTMLSelectElement).disabled).toBe(false)); fireEvent.change(screen.getByLabelText('选择项目执行'), { target: { value: 'execution-one' } }); await screen.findByText('Synthetic step failed'); };
  return { client, connect, open, native, rendered, override: (value: typeof override) => { override = value; }, offline: () => controller.error(new Error('offline')), rpc: () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(value => value.method) };
}
test.each(['project-metadata', 'project-materials'])('%s never exposes results or reads their catalog', async grant => {
  const f = fixture(grant); await f.connect(); expect(screen.queryByRole('button', { name: '打开只读结果' })).toBeNull(); expect(f.rpc().map(value => value.method)).toEqual(['state']);
});
test('combined scope selects the actual paged execution, reads records and saved reports with no native or mutation calls', async () => {
  const f = fixture(); await f.connect(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Unsaved project edit' } }); await f.open();
  expect(screen.queryByRole('button', { name: '用于验收' })).toBeNull(); expect(screen.queryByRole('button', { name: '按所选 attempt 验收' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看数据' })); fireEvent.click(await screen.findByRole('button', { name: /batch · 1 条/ }));
  await screen.findByText('missingFields'); fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' })); expect(document.body.textContent).toContain('"amount": null'); expect(document.body.textContent).toContain('"absent"');
  fireEvent.click(screen.getByRole('button', { name: 'saved-report · fail' })); await screen.findByText('实际到账金额');
  expect((screen.getByRole('button', { name: '需求示例：合成来源示例' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/来源录制 recording/)).toBeTruthy(); expect(screen.queryByRole('button', { name: '保存人工判定' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '后续执行' })); await waitFor(() => expect(screen.getAllByRole('option', { name: /当前页测试/ })).toHaveLength(2));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Unsaved project edit'); expect(f.native).not.toHaveBeenCalled();
  expect(f.rpc().every(value => ['state', 'projectExecutions', 'execution', 'executionItems', 'datasetBatches', 'datasetRecords', 'executionReports', 'executionReport', 'executionReportItems'].includes(value.method))).toBe(true);
});
test('catalog errors remain errors with a manual retry; result initial failure is recoverable', async () => {
  const f = fixture(); await f.connect(); f.override(method => method === 'projectExecutions' ? Promise.resolve(json({ error: { code: 'unavailable' } }, 503)) : undefined);
  fireEvent.click(screen.getByRole('button', { name: '打开只读结果' })); await screen.findByText(/执行列表未能读取/); expect(screen.queryByText(/这个项目尚无实际执行/)).toBeNull();
  f.override(method => method === 'execution' ? Promise.resolve(json({ error: { code: 'unavailable' } }, 503)) : undefined);
  fireEvent.click(screen.getByRole('button', { name: '刷新执行列表' })); await screen.findByRole('option', { name: /当前页测试/ });
  fireEvent.change(screen.getByLabelText('选择项目执行'), { target: { value: 'execution-one' } }); await screen.findByRole('button', { name: '重新读取执行结果' });
  expect(screen.queryByText('正在读取实际执行身份…')).toBeNull(); f.override(undefined);
  fireEvent.click(screen.getByRole('button', { name: '重新读取执行结果' })); await screen.findByText('Synthetic step failed');
});
test('late report cannot steal a newer execution and disconnect clears results', async () => {
  const f = fixture(); await f.connect(); await f.open(); let resolve!: (response: Response) => void;
  f.override((method, body) => method === 'executionReport' && body.executionId === 'execution-one' ? new Promise(done => { resolve = done; }) : undefined);
  fireEvent.click(screen.getByRole('button', { name: 'saved-report · fail' }));
  fireEvent.click(screen.getByRole('button', { name: '后续执行' })); await waitFor(() => expect(screen.getAllByRole('option', { name: /当前页测试/ })).toHaveLength(2));
  fireEvent.change(screen.getByLabelText('选择项目执行'), { target: { value: 'execution-two' } }); await waitFor(() => expect(f.rpc().some(value => value.method === 'execution' && value.body.executionId === 'execution-two')).toBe(true));
  await act(async () => { resolve(json({ binding: binding('execution-one'), reportId: 'saved-report', overall: 'fail', reasons: ['OLD-REPORT'] })); }); expect(document.body.textContent).not.toContain('OLD-REPORT');
  fireEvent.click(screen.getByRole('button', { name: '断开连接并清除资料' })); expect(screen.queryByText('执行结果中心')).toBeNull(); expect(screen.queryByLabelText('选择项目执行')).toBeNull();
});
test('stale result connection disables reads without clearing unrelated unsaved input', async () => {
  const f = fixture(); await f.connect(); await f.open(); fireEvent.change(screen.getByLabelText('目录简介'), { target: { value: 'Unsaved objective' } });
  await act(async () => f.offline()); expect((screen.getByRole('button', { name: '刷新执行列表' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('目录简介') as HTMLTextAreaElement).value).toBe('Unsaved objective'); expect(screen.getByText(/结果可能已过时/)).toBeTruthy();
});
