import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { promisify } from 'node:util';
import { appendReview, readReviews } from '@/main/services/reviews';

test('persisted review history preserves reasons and scopes across reads without rewriting machine results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-reviews-'));
  try {
    const machineFile = path.join(root, 'validations.json');
    const original = JSON.stringify([{ id: 'validation-a', result: { validation: { overall: 'fail' } } }]);
    await writeFile(machineFile, original);
    const legacy = { id: 'legacy-review', validationId: 'validation-a', verdict: 'reject', reason: '原始判定\n范围不足', scope: 'orders', createdAt: '2026-09-22T01:00:00.000Z' };
    await writeFile(path.join(root, 'reviews.jsonl'), JSON.stringify(legacy) + '\n');
    await appendReview(root, 'validation-b', { verdict: 'accept', reason: '其他验收', scope: 'all' });
    const appended = await appendReview(root, 'validation-a', { verdict: 'exception', reason: '保留机器失败，仅接受已证明的字段。', scope: 'orders.title' });
    const reopened = await readReviews(root, 'validation-a');
    assert.deepEqual(reopened.items, [legacy, appended]);
    assert.equal(reopened.outputTruncated, false);
    assert.equal(reopened.responseBytes, Buffer.byteLength(JSON.stringify(reopened)));
    assert.equal(await readFile(machineFile, 'utf8'), original);
    assert.equal((await readReviews(root, 'unreviewed-validation')).items.length, 0);
    const moduleUrl = new URL('../../src/main/services/reviews.ts', import.meta.url).href;
    const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {readReviews} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await readReviews(process.argv[1], 'validation-a')));`, root], { windowsHide: true });
    assert.deepEqual(JSON.parse(restarted.stdout).items, [legacy, appended], 'A fresh Node process reads the same persisted judgments');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review pagination fits actual UTF-8 bytes, remains stable across appends and rejects another validation cursor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-reviews-'));
  try {
    const saved = [];
    for (let index = 0; index < 7; index++) {
      await appendReview(root, 'other-validation', { verdict: 'accept', reason: '不同项目的独立验收' });
      saved.push(await appendReview(root, 'validation-a', { verdict: 'reject', reason: `${index}:` + '合成理由🧪'.repeat(35), scope: 'orders' }));
    }
    const first = await readReviews(root, 'validation-a', { limit: 3, maxBytes: 1600 });
    assert(first.nextCursor); assert(first.items.length > 0 && first.items.length < saved.length);
    await assert.rejects(readReviews(root, 'other-validation', { cursor: first.nextCursor }), (error: any) => error.code === 'INVALID_CURSOR');
    await appendReview(root, 'validation-a', { verdict: 'exception', reason: '读取开始之后新追加' });
    const restoredFirst = JSON.parse(JSON.stringify(first));
    const all = [...first.items];
    let cursor = restoredFirst.nextCursor;
    while (cursor) {
      const page = await readReviews(root, 'validation-a', { limit: 3, maxBytes: 1600, cursor });
      assert.equal(page.responseBytes, Buffer.byteLength(JSON.stringify(page)));
      assert(page.responseBytes <= 1600);
      all.push(...page.items); cursor = page.nextCursor;
    }
    assert.deepEqual(all, saved, 'Appending reviews must not change the original query snapshot');
    assert.equal((await readReviews(root, 'validation-a', { maxBytes: 32768 })).items.length, 8);
    const fabricated = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    fabricated.offset = 3;
    await assert.rejects(readReviews(root, 'validation-a', { cursor: Buffer.from(JSON.stringify(fabricated)).toString('base64url') }), (error: any) => error.code === 'INVALID_CURSOR');
    await truncate(path.join(root, 'reviews.jsonl'), 0);
    await assert.rejects(readReviews(root, 'validation-a', { cursor: first.nextCursor }), (error: any) => error.code === 'STALE_CURSOR');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review history distinguishes empty data, insufficient budget and a corrupt tail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-reviews-'));
  try {
    assert.deepEqual((await readReviews(root, 'validation-a', { maxBytes: 512 })).items, []);
    await assert.rejects(readReviews(root, '../validation-a'), /Invalid validation identity/);
    const saved = await appendReview(root, 'validation-a', { verdict: 'reject', reason: '保留完整理由'.repeat(250), scope: 'orders' });
    await assert.rejects(readReviews(root, 'validation-a', { maxBytes: 512 }), (error: any) => error.code === 'REVIEW_BUDGET_TOO_SMALL' && error.status === 413);
    assert.deepEqual((await readReviews(root, 'validation-a', { maxBytes: 32768 })).items, [saved]);
    const prior = await readFile(path.join(root, 'reviews.jsonl'), 'utf8');
    await assert.rejects(appendReview(root, 'validation-a', { verdict: ['accept'], reason: '数组不能伪装成有效判定' }), (error: any) => error.status === 422);
    await assert.rejects(appendReview(root, 'validation-a', { verdict: 'accept', reason: '超大'.repeat(10000) }), (error: any) => error.status === 413);
    assert.equal(await readFile(path.join(root, 'reviews.jsonl'), 'utf8'), prior);
    await appendFile(path.join(root, 'reviews.jsonl'), '{"id":"interrupted');
    await assert.rejects(readReviews(root, 'validation-a'), (error: any) => error.code === 'REVIEW_READ_FAILED');
    await assert.rejects(appendReview(root, 'validation-a', { verdict: 'accept', reason: '坏尾部之后不应追加' }), (error: any) => error.code === 'REVIEW_WRITE_FAILED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review storage does not treat a directory as a review file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-reviews-'));
  try {
    await mkdir(path.join(root, 'reviews.jsonl'));
    await assert.rejects(readReviews(root, 'validation-a'), (error: any) => error.code === 'INVALID_PATH');
    await assert.rejects(appendReview(root, 'validation-a', { verdict: 'accept', reason: '不应写入' }), (error: any) => error.code === 'INVALID_PATH');
  } finally { await rm(root, { recursive: true, force: true }); }
});
