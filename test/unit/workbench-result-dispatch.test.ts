import { afterEach, expect, test, vi } from 'vitest';
import { WorkbenchDispatcher } from '@/main/workbench/dispatch';
import { WorkbenchSessions } from '@/main/workbench/session';
import { parseResultRequest } from '@/main/workbench/result-validation';
import { createBrowserResultPort, type BrowserResultPort } from '@/main/workbench/result-port';
import type { ProjectExecutions } from '@/main/services/project-executions';
import type { BrowserWorkbenchGrant } from '@/contracts/browser-workbench';
const registries: WorkbenchSessions[] = [];
afterEach(() => registries.splice(0).forEach(value => value.dispose()));
const request = (method = 'projectExecutions', body: object = {}) => ({ instanceId: 'instance', method, body: { projectId: 'project', ...body } });
const metadata = { readProject: vi.fn(), updateProject: vi.fn() };
function fixture(grant: BrowserWorkbenchGrant = 'project-workbench') {
  let now = 1000;
  const sessions = new WorkbenchSessions({ instanceId: 'instance', now: () => now, sessionTtlMs: 100 }); registries.push(sessions);
  const session = sessions.exchange(sessions.begin('project', grant).ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, session.instanceId);
  const execute = vi.fn<BrowserResultPort['execute']>(async (_request, access) => { access.authorize(); return { items: [], returnedBytes: 53, outputTruncated: false }; });
  return { sessions, context, execute, dispatcher: new WorkbenchDispatcher(sessions, metadata, undefined, undefined, { execute }), expire: () => { now = session.expiresAt; } };
}
test('only the explicit combined grant admits result reads; metadata/material grants never grow', async () => {
  for (const grant of ['project-metadata', 'project-materials'] as const) {
    const f = fixture(grant); await expect(f.dispatcher.dispatch(request(), f.context)).rejects.toMatchObject({ code: 'forbidden' }); expect(f.execute).not.toHaveBeenCalled();
  }
  const f = fixture(); await expect(f.dispatcher.dispatch(request(), f.context)).resolves.toHaveProperty('items'); expect(f.execute).toHaveBeenCalledOnce();
  await expect(f.dispatcher.dispatch(request('projectExecutions', { projectId: 'other' }), f.context)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.dispatcher.dispatch({ ...request(), instanceId: 'other' }, f.context)).rejects.toMatchObject({ code: 'forbidden' });
});
test.each(['assessExecution', 'reviewExecution', 'historicalNode', 'openReplay', 'startWorkflow', 'seal'])('result grant cannot call %s', async method => {
  const f = fixture(); await expect(f.dispatcher.dispatch(request(method, { executionId: 'execution' }), f.context)).rejects.toMatchObject({ code: 'invalid_request' }); expect(f.execute).not.toHaveBeenCalled();
});
test('result reads reject abort, expiry and revocation before publishing late payloads', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.dispatcher.dispatch(request(), f.context, controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(f.execute).not.toHaveBeenCalled();
  f.execute.mockImplementation(async () => { f.expire(); return { secret: 'late result' }; });
  await expect(f.dispatcher.dispatch(request(), f.context)).rejects.toMatchObject({ code: 'unauthorized' });
  const revoked = fixture(); revoked.execute.mockImplementation(async () => { revoked.sessions.revokeIssuer(); return {}; });
  await expect(revoked.dispatcher.dispatch(request(), revoked.context)).rejects.toMatchObject({ code: 'unauthorized' });
});
test('result parser rejects extra/host fields, coercible enums, invalid paths and every budget excess', () => {
  const invalid = [request('projectExecutions', { source: 'ui' }), request('execution', { executionId: '../outside' }),
    request('executionItems', { executionId: 'e', collection: ['steps'] }), request('executionReportItems', { executionId: 'e', reportId: 'r', collection: 'other' }),
    request('datasetRecords', { executionId: 'e', attemptId: 'a', datasetId: 'd', batchId: 'b', entity: { field: 'id', equals: null, token: 'hidden' } }),
    request('projectExecutions', { limit: 101 }), request('projectExecutions', { limit: 0 }), request('projectExecutions', { maxBytes: 28673 }), request('projectExecutions', { maxBytes: 1023 }),
    request('projectExecutions', { cursor: 'x'.repeat(4097) }), request('execution', { executionId: 'e', operationId: 'mutation' }),
    { ...request(), source: 'ui' },
  ];
  for (const value of invalid) expect(() => parseResultRequest(value)).toThrow('invalid_request');
  expect(() => parseResultRequest({ ...request(), body: Object.assign(Object.create({}), { projectId: 'project' }) })).toThrow('invalid_request');
  const query = request('datasetRecords', { executionId: 'e', attemptId: 'a', datasetId: 'd', batchId: 'b', fields: ['id'], entity: { field: 'id', equals: { nested: null } }, limit: 1, maxBytes: 1024 });
  const parsed = parseResultRequest(query); expect(parsed).toEqual(query);
  (query.body as unknown as {fields: string[]}).fields.push('changed'); expect((parsed.body as any).fields).toEqual(['id']);
  expect(() => parseResultRequest(request('datasetRecords', { executionId: 'e', attemptId: 'a', datasetId: 'd', batchId: 'b', entity: { field: 'id', equals: 'x'.repeat(17000) } }))).toThrow('invalid_request');
});
test('port projects host metadata and original exceptions while preserving business JSON values', async () => {
  const binding = { schemaVersion: 1, executionId: 'e', projectId: 'project', materialRevisionId: 'v', materialContentHash: 'h', codeFingerprint: 'c', inputFingerprint: 'i', environmentRef: '/private/profile', mode: 'current-page-test' };
  const fake = { summary: vi.fn(async () => ({ binding, status: 'failed', startedAt: 'now', snapshotVerified: false, counts: { steps: 1, datasets: 0 }, console: ['secret-console'], directory: '/private/code' })),
    items: vi.fn(async () => ({ items: [{ identity: { executionId: 'e', stepId: 's', attemptId: 'a' }, state: 'failed', occurredAt: 'now', error: { name: 'Error', message: '{"token":"SYNTHETIC_SECRET","password":"SYNTHETIC_PASS"} Authorization: Basic SYNTHETIC_BASIC', stack: '/private/code:1', cause: { message: 'secret' } }, diagnostics: [{ error: { message: 'secret' } }] }], outputTruncated: false, returnedBytes: 0 })),
    records: vi.fn(async () => ({ items: [{ batchId: 'b', recordIndex: 0, value: { path: '/a-business-path', token: 'business-value', missing: null } }], outputTruncated: false, returnedBytes: 0 })),
  };
  const port = createBrowserResultPort(fake as unknown as ProjectExecutions), access = { authorize: vi.fn() };
  const head = await port.execute(parseResultRequest(request('execution', { executionId: 'e' })), access);
  expect(JSON.stringify(head)).not.toMatch(/private|console|environmentRef|directory/);
  const steps = await port.execute(parseResultRequest(request('executionItems', { executionId: 'e', collection: 'steps' })), access);
  expect(JSON.stringify(steps)).not.toMatch(/SYNTHETIC|stack|cause|diagnostics/);
  const records = await port.execute(parseResultRequest(request('datasetRecords', { executionId: 'e', attemptId: 'a', datasetId: 'd', batchId: 'b' })), access);
  expect((records as any).items[0].value).toEqual({ path: '/a-business-path', token: 'business-value', missing: null });
  expect((records as any).returnedBytes).toBe(Buffer.byteLength(JSON.stringify(records)));
});
test('port suppresses expired result and oversized service output, without leaking errors', async () => {
  const fake = { list: vi.fn(async () => ({ items: ['x'.repeat(70_000)], outputTruncated: false, returnedBytes: 0 })) };
  const port = createBrowserResultPort(fake as unknown as ProjectExecutions);
  await expect(port.execute(parseResultRequest(request()), { authorize: () => {} })).rejects.toMatchObject({ code: 'unavailable' });
  fake.list.mockRejectedValueOnce(new Error('/private/service token=secret'));
  await expect(port.execute(parseResultRequest(request()), { authorize: () => {} })).rejects.toMatchObject({ message: 'unavailable' });
});

test.each(['Original-source', 'Dataset', 'Human review'])('%s exception reasons are fixed without relying on secret spellings', async prefix => {
  const binding = { schemaVersion: 1, executionId: 'e', projectId: 'project', materialRevisionId: 'v', materialContentHash: 'h', codeFingerprint: 'c', inputFingerprint: 'i', environmentRef: 'private', mode: 'current-page-test' };
  const reason = `${prefix} read failed: Error: {"access_token":"UNIQUE_SECRET_ONE","accessToken":"UNIQUE_SECRET_TWO","clientSecret":"UNIQUE_SECRET_THREE","AWS_ACCESS_KEY_ID":"UNIQUE_SECRET_FOUR"}`;
  const fake = { reportSummary: async () => ({ binding, schemaVersion: 1, reportId: 'r', contentHash: 'h', attemptId: 'a', materialStatus: 'candidate', overall: 'inconclusive', coverage: 'missing', version: { name: 'version', verdict: 'pass', reason: 'Fixed version' }, counts: { requirements: 0, datasets: 0 }, returnedBytes: 0, reasons: [reason] }) };
  const result = await createBrowserResultPort(fake as unknown as ProjectExecutions).execute(parseResultRequest(request('executionReport', { executionId: 'e', reportId: 'r' })), { authorize: () => {} });
  expect(JSON.stringify(result)).not.toMatch(/UNIQUE_SECRET|access_token|accessToken|clientSecret|AWS_ACCESS_KEY_ID/); expect(JSON.stringify(result)).toContain('原件读取失败');
});

test('dataset transport fields never become part of the strict persisted identity or record query', async () => {
  const fake = { batches: vi.fn(async () => ({ items: [], returnedBytes: 0, outputTruncated: false })), records: vi.fn(async () => ({ items: [], returnedBytes: 0, outputTruncated: false })) };
  const port = createBrowserResultPort(fake as unknown as ProjectExecutions), access = { authorize: () => {} };
  const identity = { executionId: 'e', attemptId: 'a', datasetId: 'd' }, query = { limit: 1, maxBytes: 4096, cursor: 'cursor' };
  await port.execute(parseResultRequest(request('datasetBatches', { ...identity, ...query })), access);
  expect(fake.batches).toHaveBeenCalledExactlyOnceWith('project', identity, query);
  const projection = { fields: ['id'], entity: { field: 'id', equals: null } };
  await port.execute(parseResultRequest(request('datasetRecords', { ...identity, ...query, batchId: 'b', ...projection })), access);
  expect(fake.records).toHaveBeenCalledExactlyOnceWith('project', identity, 'b', { ...query, ...projection });
  expect(() => parseResultRequest(request('datasetBatches', { ...identity, arbitrary: 'unknown' }))).toThrow('invalid_request');
});

test('record pagination keeps cursor out of identity across successive reads', async () => {
  const fake = { records: vi.fn(async (_project: string, _identity: object) => ({ items: [], returnedBytes: 0, outputTruncated: false })) };
  const port = createBrowserResultPort(fake as unknown as ProjectExecutions), identity = { executionId: 'e', attemptId: 'a', datasetId: 'd' };
  for (const cursor of [undefined, 'next-page']) await port.execute(parseResultRequest(request('datasetRecords', { ...identity, batchId: 'b', limit: 1, maxBytes: 4096, ...(cursor ? { cursor } : {}) })), { authorize: () => {} });
  expect(fake.records.mock.calls.map(args => args[1])).toEqual([identity, identity]);
});
