import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';
import { WorkbenchDispatcher, type ProjectMetadataPort, type WorkbenchExecutionPermit } from '@/main/workbench/dispatch';
import { WorkbenchSessions } from '@/main/workbench/session';
import { WorkbenchError } from '@/main/workbench/errors';

const registries: WorkbenchSessions[] = [];
afterEach(() => { for (const sessions of registries.splice(0)) sessions.dispose(); });
const code = (value: string) => (error: unknown) => error instanceof WorkbenchError && error.code === value;
function fixture() {
  let now = 1_000;
  const sessions = new WorkbenchSessions({ instanceId: 'memory-fixture', now: () => now, sessionTtlMs: 100 });
  registries.push(sessions);
  const session = sessions.exchange(sessions.begin('project-a').ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const projects = new Map<string, BrowserProjectMetadata>(['a', 'b'].map(letter => [`project-${letter}`, { id: `project-${letter}`, name: `Project ${letter}`, objective: '', revision: 1 }]));
  const operations = new Map<string, BrowserProjectMetadata>();
  const calls: Readonly<BrowserUpdateProject>[] = [];
  const changed: string[] = [];
  const port: ProjectMetadataPort = {
    readProject: async (id, permit) => permit.start(() => ({ ...projects.get(id)!, scriptDirectory: '/private-fixture-only', token: 'not-a-real-token' })),
    updateProject: async (input, permit) => permit.start(() => {
      calls.push(input);
      const prior = operations.get(input.operationId);
      if (prior) return prior;
      const current = projects.get(input.projectId)!;
      if (current.revision !== input.expectedRevision) throw new WorkbenchError('conflict');
      const next = { ...current, ...(input.name === undefined ? {} : { name: input.name }), ...(input.objective === undefined ? {} : { objective: input.objective }), revision: current.revision + 1 };
      projects.set(input.projectId, next);
      operations.set(input.operationId, next);
      return next;
    }),
  };
  const dispatcher = new WorkbenchDispatcher(sessions, port, id => changed.push(id));
  const read = (body: unknown = { projectId: 'project-a' }) => ({ instanceId: sessions.instanceId, method: 'state', body });
  const update = (patch: Record<string, unknown> = {}) => ({ instanceId: sessions.instanceId, method: 'updateProject', body: { projectId: 'project-a', expectedRevision: 1, operationId: 'operation-a', name: 'New name', ...patch } });
  return { sessions, context, projects, calls, changed, port, dispatcher, read, update, advance: () => { now += 100; } };
}

test('state is one projected project DTO, with no service/private fields', async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatcher.dispatch(f.read(), f.context), { project: f.projects.get('project-a') });
});

test('metadata writes preserve revision/operationId; duplicate idempotency belongs to the port', async () => {
  const f = fixture();
  const input = f.update();
  const first = await f.dispatcher.dispatch(input, f.context);
  const second = await f.dispatcher.dispatch(input, f.context);
  assert.deepEqual(first, second);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], input.body);
  assert.deepEqual(f.calls[1], input.body);
  assert.equal(f.projects.get('project-a')!.revision, 2);
  assert.equal(f.projects.get('project-b')!.revision, 1);
  assert.deepEqual(f.changed, ['project-a', 'project-a']);
});

test('cross-project and wrong-instance envelopes never call a port', async () => {
  const f = fixture();
  await assert.rejects(f.dispatcher.dispatch(f.read({ projectId: 'project-b' }), f.context), code('forbidden'));
  await assert.rejects(f.dispatcher.dispatch({ ...f.update(), instanceId: 'other' }, f.context), code('forbidden'));
  assert.equal(f.calls.length, 0);
});

test('unknown methods, caller source, scriptDirectory and extra nested/top-level fields are denied', async () => {
  const f = fixture();
  for (const input of [
    { ...f.read(), method: 'dispatch' }, { ...f.read(), method: 'createProject' }, { ...f.read(), source: 'ui' },
    f.read({ projectId: 'project-a', source: 'ui' }), f.read({ projectId: 'project-a', extra: {} }),
    f.update({ scriptDirectory: '/tmp' }), f.update({ source: 'ui' }), f.update({ name: { nested: 'bad' } }),
  ]) await assert.rejects(f.dispatcher.dispatch(input, f.context), code('invalid_request'));
  assert.equal(f.calls.length, 0);
});

test('strict input rejects missing scope/revision/operation, invalid revisions and oversize/deep payloads', async () => {
  const f = fixture();
  for (const key of ['projectId', 'expectedRevision', 'operationId']) {
    const input = f.update();
    delete (input.body as Record<string, unknown>)[key];
    await assert.rejects(f.dispatcher.dispatch(input, f.context), code('invalid_request'));
  }
  for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 1.1 }, { operationId: '' }, { name: '' }, { objective: 'x'.repeat(4_001) }, { name: undefined }]) {
    await assert.rejects(f.dispatcher.dispatch(f.update(patch), f.context), code('invalid_request'));
  }
  let nested: unknown = {};
  for (let i = 0; i < 10; i++) nested = { nested };
  await assert.rejects(f.dispatcher.dispatch({ ...f.read(), nested }, f.context), code('invalid_request'));
  assert.equal(f.calls.length, 0);
});

test('conflicts are returned once without transport retries; private exceptions are redacted', async () => {
  const f = fixture();
  await assert.rejects(f.dispatcher.dispatch(f.update({ expectedRevision: 5 }), f.context), code('conflict'));
  assert.equal(f.calls.length, 1);
  f.port.readProject = async () => { throw new Error('secret filesystem and credential fixture'); };
  await assert.rejects(f.dispatcher.dispatch(f.read(), f.context), error => error instanceof WorkbenchError && error.message === 'internal_error');
});

for (const reason of ['revoke', 'expire', 'abort'] as const) test(`queued ${reason} cannot start a write`, async () => {
  const f = fixture();
  const abort = new AbortController();
  let release!: () => void;
  let pendingPermit!: WorkbenchExecutionPermit;
  f.port.updateProject = (_input, permit) => new Promise((resolve, reject) => {
    pendingPermit = permit;
    release = () => { try { resolve(permit.start(() => { throw new Error('must not execute'); })); } catch (error) { reject(error); } };
  });
  const result = f.dispatcher.dispatch(f.update(), f.context, abort.signal);
  if (reason === 'revoke') f.sessions.revokeProject('project-a');
  if (reason === 'expire') f.advance();
  if (reason === 'abort') abort.abort();
  release();
  await assert.rejects(result, code(reason === 'abort' ? 'cancelled' : 'unauthorized'));
  assert.equal(f.projects.get('project-a')!.revision, 1);
  assert.throws(() => pendingPermit.start(() => 1), code('invalid_request'));
});

test('already-started write completion is not falsely relabelled as rollback after cancellation/revoke', async () => {
  const f = fixture();
  const abort = new AbortController();
  let finish!: (project: BrowserProjectMetadata) => void;
  let permit!: WorkbenchExecutionPermit;
  f.port.updateProject = (_input, supplied) => { permit = supplied; return supplied.start(() => new Promise(resolve => { finish = resolve; })); };
  const result = f.dispatcher.dispatch(f.update(), f.context, abort.signal);
  abort.abort();
  f.sessions.revokeProject('project-a');
  assert.equal(permit.signal.aborted, false);
  const actual = { ...f.projects.get('project-a')!, revision: 2 };
  finish(actual);
  assert.deepEqual(await result, actual);
  assert.throws(() => permit.start(() => actual), code('invalid_request'));
});

test('pre-cancelled work, invalid output scope and a port that bypasses start fail closed', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.dispatcher.dispatch(f.update(), f.context, abort.signal), code('cancelled'));
  assert.equal(f.calls.length, 0);
  f.port.readProject = async (_id, permit) => permit.start(() => f.projects.get('project-b')!);
  await assert.rejects(f.dispatcher.dispatch(f.read(), f.context), code('internal_error'));
  f.port.readProject = async () => f.projects.get('project-a')!;
  await assert.rejects(f.dispatcher.dispatch(f.read(), f.context), code('internal_error'));
});

test('a read that finishes after revocation cannot disclose its late project state', async () => {
  const f = fixture();
  let finish!: (project: BrowserProjectMetadata) => void;
  f.port.readProject = (_id, permit) => permit.start(() => new Promise(resolve => { finish = resolve; }));
  const result = f.dispatcher.dispatch(f.read(), f.context);
  f.sessions.revokeProject('project-a');
  finish(f.projects.get('project-a')!);
  await assert.rejects(result, code('unauthorized'));
});

test('notification failure cannot disguise the successful result of an atomic write', async () => {
  const f = fixture();
  const dispatcher = new WorkbenchDispatcher(f.sessions, f.port, () => { throw new Error('fixture subscriber failed'); });
  const result = await dispatcher.dispatch(f.update(), f.context);
  assert.equal((result as BrowserProjectMetadata).revision, 2);
  assert.equal(f.projects.get('project-a')!.revision, 2);
});
