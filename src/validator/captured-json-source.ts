import type { ReadBudget } from '@/contracts/recording';
import type { JsonValue } from '@/contracts/workflow';
import type { EvidenceReader } from '@/evidence/reader';
import { ValidatorError } from './service';
import type { SourceDocument, SourceReader, SourceScope } from './types';

export interface CapturedSourceLocation {
  reader: Pick<EvidenceReader, 'artifactMetadata' | 'artifact'>;
  /** Supplied by a host-owned persisted execution/attempt -> recording mapping. */
  scope: SourceScope;
}
/** Adapts the production evidence reader; raw artifacts stay immutable and integrity-checked. */
export class CapturedJsonSourceReader implements SourceReader {
  constructor(private readonly locate: (sourceRef: string) => Promise<CapturedSourceLocation | undefined>) {}
  async read(sourceRef: string, budget: ReadBudget): Promise<SourceDocument | undefined> {
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1024 || budget.maxBytes > 1024 * 1024 || !Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.cursor) throw new ValidatorError('INVALID_BUDGET', 'Source reads require a 1 KiB–1 MiB explicit budget');
    const location = await this.locate(sourceRef);
    if (!location) return undefined;
    const scope = structuredClone(location.scope);
    const metadata = await location.reader.artifactMetadata(sourceRef);
    if (Buffer.byteLength(JSON.stringify(metadata)) > budget.maxBytes) throw new ValidatorError('SOURCE_LIMIT', 'Source metadata exceeds budget', 413);
    const base = { sourceRef, scope, capturedAt: metadata.createdAt, representation: 'network-json' as const, display: 'unknown' as const };
    if (metadata.id !== sourceRef || metadata.kind !== 'response-body' || !/json/i.test(metadata.mediaType)) return { ...base, content: { status: 'unsupported', reason: 'Source is not a captured JSON response body' } };
    const source = metadata.source;
    if (!source || typeof source !== 'object' || typeof source.url !== 'string' || typeof source.requestKey !== 'string') return { ...base, content: { status: 'missing', reason: 'Captured request URL or request identity is absent' } };
    if (metadata.metadata?.privacyRedacted === true || metadata.metadata?.representation === 'privacy-redacted-response') return { ...base, requestUrl: source.url, content: { status: 'redacted', reason: 'Capture privacy processing replaced response values; the stored mask is not an observed original value' } };
    if (metadata.captureStatus !== 'complete' && metadata.captureStatus !== 'empty') return { ...base, requestUrl: source.url, content: { status: 'missing', reason: `Original capture status: ${metadata.captureStatus}; ${metadata.reason ?? ''}` } };
    if (metadata.capturedBytes > budget.maxBytes) throw new ValidatorError('SOURCE_LIMIT', 'Source body exceeds the explicit JSON parse budget', 413);
    let cursor: string | undefined, body = '', bytes = 0, offset = 0;
    do {
      const page = await location.reader.artifact(sourceRef, { maxBytes: Math.min(budget.maxBytes, 16384), cursor });
      if (typeof page.text !== 'string' || page.format !== 'utf8' || page.byteOffset !== offset || typeof page.readBytes !== 'number') return { ...base, requestUrl: source.url, content: { status: 'missing', reason: `Original body read was unavailable (${String(page.bodyStatus ?? page.format)})` } };
      body += page.text; bytes += Buffer.byteLength(page.text); offset += page.readBytes;
      if (bytes > budget.maxBytes || offset > metadata.capturedBytes) throw new ValidatorError('SOURCE_LIMIT', 'Source read exceeded its recorded length or byte budget', 413);
      if (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || page.nextCursor === cursor)) throw new ValidatorError('INVALID_SOURCE_CURSOR', 'Source continuation did not advance');
      if (page.outputTruncated && !page.nextCursor) throw new ValidatorError('INCOMPLETE_SOURCE', 'Source body was truncated without continuation');
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    if (bytes !== metadata.capturedBytes) return { ...base, requestUrl: source.url, content: { status: 'missing', reason: 'Original response byte count is incomplete' } };
    let value: JsonValue;
    try { value = JSON.parse(body) as JsonValue; }
    catch { return { ...base, requestUrl: source.url, content: { status: 'missing', reason: 'Original complete body is not valid JSON' } }; }
    const result: SourceDocument = { ...base, requestUrl: source.url, content: { status: 'present', value } };
    if (Buffer.byteLength(JSON.stringify(result)) > budget.maxBytes) throw new ValidatorError('SOURCE_LIMIT', 'Source response envelope exceeds budget', 413);
    return result;
  }
}
