import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { jsonBytes, jsonLines, safeFile } from '@/evidence/files';
import { ensure, StudioError } from '@/shared/errors';

export interface HumanReview {
  id: string;
  validationId: string;
  verdict: 'accept' | 'reject' | 'exception';
  reason: string;
  scope: string;
  createdAt: string;
}
export interface ReviewQuery { limit?: number; maxBytes?: number; cursor?: string; }
export interface ReviewPage {
  validationId: string;
  items: HumanReview[];
  nextCursor?: string;
  outputTruncated: boolean;
  maxBytes: number;
  responseBytes: number;
}
interface Cursor { scope: string; file: string; end: number; offset: number; }
const filename = 'reviews.jsonl';
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function fail(code: string, message: string, status = 422): never { throw new StudioError(status, code, message); }
function validRecord(value: unknown): value is HumanReview {
  const review = value as HumanReview | undefined;
  return !!review && typeof review.id === 'string' && typeof review.validationId === 'string'
    && ['accept', 'reject', 'exception'].includes(review.verdict) && typeof review.reason === 'string' && !!review.reason.trim()
    && typeof review.scope === 'string' && !!review.scope.trim() && typeof review.createdAt === 'string' && Number.isFinite(Date.parse(review.createdAt));
}
function finish(page: ReviewPage): ReviewPage {
  let bytes = jsonBytes(page);
  while (page.responseBytes !== bytes) { page.responseBytes = bytes; bytes = jsonBytes(page); }
  return page;
}

/** Preserve the existing append-only format; reviews never modify validation results. */
export async function appendReview(root: string, validationId: string, body: { verdict?: unknown; reason?: unknown; scope?: unknown }): Promise<HumanReview> {
  ensure(typeof validationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(validationId), 'Invalid validation identity');
  ensure(typeof body.verdict === 'string' && ['accept', 'reject', 'exception'].includes(body.verdict) && typeof body.reason === 'string' && body.reason.trim(), 'Review verdict and reason required');
  ensure(body.scope === undefined || typeof body.scope === 'string' && body.scope.trim(), 'Review scope must be nonempty text');
  const review: HumanReview = { id: randomUUID(), validationId, verdict: body.verdict as HumanReview['verdict'], reason: body.reason, scope: body.scope as string || 'all', createdAt: new Date().toISOString() };
  ensure(jsonBytes(review) <= 16 * 1024, 'Review exceeds 16 KiB; shorten its reason or scope', 413);
  let file = path.join(root, filename);
  try { file = await safeFile(root, filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = await open(file, 'a+');
  try {
    const size = (await handle.stat()).size;
    if (size) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 10) fail('REVIEW_WRITE_FAILED', 'Review history has an incomplete tail; preserve it for recovery before adding a review.', 409); }
    await handle.writeFile(JSON.stringify(review) + '\n'); await handle.sync();
  } finally { await handle.close(); }
  return review;
}

/** A cursor reads a fixed append boundary, survives restart, and cannot select another validation. */
export async function readReviews(root: string, validationId: string, options: ReviewQuery = {}): Promise<ReviewPage> {
  ensure(typeof validationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(validationId), 'Invalid validation identity');
  const limit = options.limit ?? 20, maxBytes = options.maxBytes ?? 8192;
  ensure(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'Review limit must be between 1 and 100');
  ensure(Number.isSafeInteger(maxBytes) && maxBytes >= 512 && maxBytes <= 32768, 'Review maxBytes must be between 512 and 32768');
  let file: string;
  try { file = await safeFile(root, filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (options.cursor) fail('STALE_CURSOR', 'Review history is no longer available; restart the query.', 409);
    return finish({ validationId, items: [], outputTruncated: false, maxBytes, responseBytes: 0 });
  }
  const identity = await stat(file), scope = createHash('sha256').update(file + '\n' + validationId).digest('hex');
  let cursor: Cursor = { scope, file: `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`, end: identity.size, offset: 0 };
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length > 2048) fail('INVALID_CURSOR', 'Invalid review cursor.');
    let saved: Cursor;
    try { saved = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as Cursor; } catch { return fail('INVALID_CURSOR', 'Unreadable review cursor.'); }
    if (!saved || saved.scope !== scope || !Number.isSafeInteger(saved.end) || !Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > saved.end) fail('INVALID_CURSOR', 'Cursor does not match this validation review query.');
    if (saved.file !== cursor.file || saved.end > identity.size) fail('STALE_CURSOR', 'Review history changed; restart the query.', 409);
    cursor = saved;
    if (cursor.offset) {
      const handle = await open(file, 'r');
      try { const boundary = Buffer.alloc(1); await handle.read(boundary, 0, 1, cursor.offset - 1); if (boundary[0] !== 10) fail('INVALID_CURSOR', 'Review cursor must point to a record boundary.'); } finally { await handle.close(); }
    }
  }
  const items: HumanReview[] = [], start = cursor.offset;
  let offset = cursor.offset;
  for await (const line of jsonLines(file, offset)) {
    if (line.offset >= cursor.end) break;
    if (line.invalid || line.offset + line.bytes > cursor.end || !validRecord(line.value)) fail('REVIEW_READ_FAILED', `Review history contains an incomplete or invalid record at byte ${line.offset}.`, 409);
    const next = line.offset + line.bytes;
    if (line.value.validationId === validationId) {
      // Reserve the largest remaining cursor and full response metadata before accepting a record.
      const candidate = finish({ validationId, items: [...items, line.value], ...(next < cursor.end ? { nextCursor: encode({ ...cursor, offset: cursor.end }) } : {}), outputTruncated: false, maxBytes, responseBytes: 0 });
      if (candidate.responseBytes > maxBytes) {
        if (!items.length) fail('REVIEW_BUDGET_TOO_SMALL', 'A complete review cannot fit this budget; increase maxBytes (up to 32768). The saved reason is unchanged.', 413);
        break;
      }
      items.push(line.value);
    }
    offset = next;
    // Stop at a whole-record boundary after 1 MiB, including histories dominated by other validations.
    if (items.length >= limit || offset - start >= 1024 * 1024) break;
  }
  const page = finish({ validationId, items, ...(offset < cursor.end ? { nextCursor: encode({ ...cursor, offset }) } : {}), outputTruncated: offset < cursor.end, maxBytes, responseBytes: 0 });
  if (page.responseBytes > maxBytes) fail('REVIEW_BUDGET_TOO_SMALL', 'Review pagination metadata exceeds this budget; increase maxBytes.', 413);
  return page;
}
