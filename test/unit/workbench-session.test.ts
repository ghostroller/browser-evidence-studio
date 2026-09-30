import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { WorkbenchSessions } from '@/main/workbench/session';
import { WorkbenchError } from '@/main/workbench/errors';

const registries: WorkbenchSessions[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.dispose(); });
function fixture(options: Partial<ConstructorParameters<typeof WorkbenchSessions>[0]> = {}) {
  let now = 1_000;
  const sessions = new WorkbenchSessions({ instanceId: 'fixture-instance', now: () => now, ...options });
  registries.push(sessions);
  const pair = (projectId = 'project-a') => sessions.exchange(sessions.begin(projectId).ticket, sessions.instanceId);
  return { sessions, pair, advance: (ms: number) => { now += ms; sessions.sweep(); } };
}
const code = (value: string) => (error: unknown) => error instanceof WorkbenchError && error.code === value;

test('single-use memory ticket yields an instance/project-scoped session, never a renewed expiry', () => {
  const { sessions, advance } = fixture();
  const ticket = sessions.begin('project-a');
  const session = sessions.exchange(ticket.ticket, sessions.instanceId);
  assert.equal(session.projectId, 'project-a');
  assert.equal(sessions.authenticate(session.token, sessions.instanceId).expiresAt, session.expiresAt);
  advance(1_000);
  assert.equal(sessions.authenticate(session.token, sessions.instanceId).expiresAt, session.expiresAt);
  assert.throws(() => sessions.exchange(ticket.ticket, sessions.instanceId), code('unauthorized'));
});

test('concurrent exchanges of one ticket admit exactly one session', async () => {
  const { sessions } = fixture();
  const { ticket } = sessions.begin('project-a');
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => sessions.exchange(ticket, sessions.instanceId))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(sessions.counts.sessions, 1);
});

test('missing, malformed, wrong-instance and forged session contexts are rejected', () => {
  const { sessions, pair } = fixture();
  const session = pair();
  for (const token of [undefined, '', 'wrong', 'x'.repeat(43)]) assert.throws(() => sessions.authenticate(token, sessions.instanceId), code('unauthorized'));
  assert.throws(() => sessions.authenticate(session.token, 'other-instance'), code('unauthorized'));
  const context = sessions.authenticate(session.token, sessions.instanceId);
  assert.throws(() => sessions.assertActive({ ...context }), code('unauthorized'));
});

test('ticket and session expire exactly at deadline, with bounded cleanup and no refresh', () => {
  const { sessions, pair, advance } = fixture({ ticketTtlMs: 10, sessionTtlMs: 20 });
  const session = pair();
  const ticket = sessions.begin('project-b');
  let invalidated = 0;
  sessions.onInvalidated(sessions.authenticate(session.token, sessions.instanceId), () => invalidated++);
  advance(10);
  assert.throws(() => sessions.exchange(ticket.ticket, sessions.instanceId), code('unauthorized'));
  advance(10);
  assert.throws(() => sessions.authenticate(session.token, sessions.instanceId), code('unauthorized'));
  assert.deepEqual(sessions.counts, { tickets: 0, sessions: 0, listeners: 0 });
  assert.equal(invalidated, 1);
});

test('project revocation removes pending tickets and sessions without revoking another project', () => {
  const { sessions, pair } = fixture();
  const a = pair();
  const b = pair('project-b');
  const ticket = sessions.begin('project-a');
  sessions.revokeProject('project-a');
  assert.throws(() => sessions.authenticate(a.token, sessions.instanceId), code('unauthorized'));
  assert.throws(() => sessions.exchange(ticket.ticket, sessions.instanceId), code('unauthorized'));
  assert.equal(sessions.authenticate(b.token, sessions.instanceId).projectId, 'project-b');
});

test('issuer epoch invalidates all old tickets/contexts; new sessions have a new epoch', () => {
  const { sessions, pair } = fixture();
  const old = pair();
  const context = sessions.authenticate(old.token, sessions.instanceId);
  const pending = sessions.begin('project-b');
  sessions.revokeIssuer();
  assert.throws(() => sessions.assertActive(context), code('unauthorized'));
  assert.throws(() => sessions.exchange(pending.ticket, sessions.instanceId), code('unauthorized'));
  const fresh = pair();
  assert.equal(sessions.authenticate(fresh.token, sessions.instanceId).issuerEpoch, context.issuerEpoch + 1);
});

test('ticket/session capacities are bounded, and a capacity-rejected exchange still consumes its ticket', () => {
  const { sessions, pair } = fixture({ maxTickets: 1, maxSessions: 1 });
  const ticket = sessions.begin('project-a');
  assert.throws(() => sessions.begin('project-b'), code('busy'));
  sessions.exchange(ticket.ticket, sessions.instanceId);
  const full = sessions.begin('project-b');
  assert.throws(() => sessions.exchange(full.ticket, sessions.instanceId), code('busy'));
  sessions.revokeProject('project-a');
  assert.throws(() => sessions.exchange(full.ticket, sessions.instanceId), code('unauthorized'));
  assert.equal(pair('project-b').projectId, 'project-b');
});

test('exchange attempts have a bounded window, including malformed and wrong-instance attempts', () => {
  const { sessions, advance } = fixture({ maxExchangeAttempts: 2, attemptWindowMs: 10 });
  const ticket = sessions.begin('project-a');
  assert.throws(() => sessions.exchange('bad', sessions.instanceId), code('unauthorized'));
  assert.throws(() => sessions.exchange(ticket.ticket, 'wrong-instance'), code('unauthorized'));
  assert.throws(() => sessions.exchange(ticket.ticket, sessions.instanceId), code('busy'));
  advance(10);
  assert.equal(sessions.exchange(ticket.ticket, sessions.instanceId).projectId, 'project-a');
});

test('listener limit, unsubscribe, failing cleanup and repeated disposal remain bounded', () => {
  const { sessions, pair } = fixture();
  const session = pair();
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const remove = Array.from({ length: 16 }, () => sessions.onInvalidated(context, () => { throw new Error('private fixture error'); }));
  assert.throws(() => sessions.onInvalidated(context, () => {}), code('busy'));
  remove[0]();
  sessions.onInvalidated(context, () => {});
  sessions.dispose();
  sessions.dispose();
  assert.deepEqual(sessions.counts, { tickets: 0, sessions: 0, listeners: 0 });
  assert.throws(() => sessions.begin('project-a'), code('unavailable'));
});

test('automatic timer expiry invalidates listeners without a new request or explicit sweep', async () => {
  const sessions = new WorkbenchSessions({ instanceId: 'timer-fixture', sessionTtlMs: 20 });
  registries.push(sessions);
  const session = sessions.exchange(sessions.begin('project-a').ticket, sessions.instanceId);
  const context = sessions.authenticate(session.token, sessions.instanceId);
  const invalidated = new Promise<void>(resolve => sessions.onInvalidated(context, resolve));
  // Keep this fixture alive independently; production HTTP owns its own socket.
  const keepAlive = setTimeout(() => {}, 100);
  try { await invalidated; } finally { clearTimeout(keepAlive); }
  assert.throws(() => sessions.assertActive(context), code('unauthorized'));
  assert.equal(sessions.counts.sessions, 0);
});
