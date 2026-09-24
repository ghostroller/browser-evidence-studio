import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ValidationStartGrants, type ValidationStartBinding } from '@/main/services/validation-start-grants';

function binding(): ValidationStartBinding {
  return {
    runId: 'run-1', projectId: 'project-1', profileId: 'profile-1', workflowId: 'workflow-1',
    leaseEpoch: 4, directory: 'D:\\registered-workflow', workflowSha256: 'workflow-sha',
    inputSha256: 'input-sha', pageId: 'page-1', targetId: 'target-1', generation: 2,
  };
}

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { status: number }).status, 409);
    assert.equal((error as Error & { code: string }).code, code);
    return true;
  };
}

test('validation grants bind every identity, version and input field', () => {
  const grants = new ValidationStartGrants();
  const current = binding(), grant = grants.issue(current);
  assert.deepEqual(grants.available(current), grant);
  assert.deepEqual(grants.available({ runId: current.runId, leaseEpoch: current.leaseEpoch }), grant);
  for (const key of Object.keys(current) as (keyof ValidationStartBinding)[]) {
    const changed = { ...current, [key]: typeof current[key] === 'number' ? Number(current[key]) + 1 : `${current[key]}-changed` };
    assert.equal(grants.available({ [key]: changed[key] }), null, key);
    assert.throws(() => grants.consume(grant.grantId, changed), hasCode('VALIDATION_GRANT_MISMATCH'), key);
    assert.deepEqual(grants.available(current), grant, `mismatch must not consume the grant: ${key}`);
  }
  assert.throws(() => grants.consume('wrong-id', current), hasCode('VALIDATION_GRANT_MISMATCH'));
  assert.deepEqual(grants.consume(grant.grantId, current), grant);
  assert.equal(grants.available(), null);
  assert.throws(() => grants.consume(grant.grantId, current), hasCode('VALIDATION_GRANT_CONSUMED'));
});

test('concurrent requests can consume a validation grant only once', async () => {
  const grants = new ValidationStartGrants(), current = binding(), grant = grants.issue(current);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => Promise.resolve().then(() => grants.consume(grant.grantId, current))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 19);
  for (const result of rejected) hasCode('VALIDATION_GRANT_CONSUMED')(result.reason);
});

test('grant expiration includes the exact deadline and preserves metadata for audit', () => {
  let time = 1_800_000_000_000;
  const grants = new ValidationStartGrants(() => time), current = binding(), grant = grants.issue(current);
  assert.equal(grant.issuedAt, new Date(time).toISOString());
  assert.equal(grant.expiresAt, new Date(time + 120_000).toISOString());
  time += 119_999;
  assert.deepEqual(grants.available(), grant);
  time++;
  assert.equal(grants.available(), null);
  assert.throws(() => grants.consume(grant.grantId, current), hasCode('VALIDATION_GRANT_EXPIRED'));
  assert.deepEqual(grants.peek(), grant);
  time -= 120_000;
  assert.equal(grants.available(), null, 'an observed expiration must survive a backward wall-clock adjustment');
  assert.equal(grants.revoke(), null);
  assert.throws(() => grants.consume(grant.grantId, current), hasCode('VALIDATION_GRANT_EXPIRED'));
});

test('revocation and replacement cannot resurrect an old grant', () => {
  const grants = new ValidationStartGrants(), current = binding();
  assert.equal(grants.peek(), null);
  assert.equal(grants.revoke(), null);
  assert.throws(() => grants.consume('missing', current), hasCode('VALIDATION_GRANT_REQUIRED'));
  const first = grants.issue(current);
  assert.deepEqual(grants.revoke(), first);
  assert.equal(grants.available(), null);
  assert.equal(grants.revoke(), null);
  assert.deepEqual(grants.peek(), first);
  assert.throws(() => grants.consume(first.grantId, current), hasCode('VALIDATION_GRANT_REQUIRED'));
  const second = grants.issue(current), third = grants.issue(current);
  assert.notEqual(second.grantId, first.grantId);
  assert.notEqual(third.grantId, second.grantId);
  assert.throws(() => grants.consume(second.grantId, current), hasCode('VALIDATION_GRANT_MISMATCH'));
  assert.throws(() => grants.consume(first.grantId, current), hasCode('VALIDATION_GRANT_MISMATCH'));
  assert.deepEqual(grants.peek(), third);
  grants.consume(third.grantId, current);
  assert.equal(grants.revoke(), null);
  assert.throws(() => grants.consume(third.grantId, current), hasCode('VALIDATION_GRANT_CONSUMED'));
});

test('caller mutation cannot alter grant bindings, deadlines or audit metadata', () => {
  let time = 1_800_000_000_000;
  const grants = new ValidationStartGrants(() => time, 500), current = binding();
  const issued = grants.issue({ ...current, input: { secret: 'must-not-be-retained' } } as ValidationStartBinding);
  const original = structuredClone(issued);
  assert.equal(Object.hasOwn(issued, 'input'), false);
  issued.runId = 'changed'; issued.expiresAt = new Date(time + 99_999).toISOString();
  current.runId = 'changed';
  assert.deepEqual(grants.available(), original);
  const available = grants.available()!;
  available.workflowSha256 = 'changed'; available.grantId = 'changed';
  const peek = grants.peek()!;
  peek.leaseEpoch++; peek.directory = 'changed';
  assert.deepEqual(grants.peek(), original);
  const consumed = grants.consume(original.grantId, binding());
  consumed.profileId = 'changed';
  assert.deepEqual(grants.peek(), original);
  const replacement = grants.issue(binding());
  const revoked = grants.revoke()!;
  revoked.inputSha256 = 'changed';
  assert.deepEqual(grants.peek(), replacement);
  grants.issue(binding()); time += 500;
  assert.equal(grants.available(), null);
});

test('configured lifetime remains finite and positive', () => {
  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new ValidationStartGrants(() => 0, ttl), RangeError);
  }
});
