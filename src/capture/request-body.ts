import type { ArtifactInput } from '@/evidence/contracts';
import type { RequestBodyRead } from './request-ledger';

export const REQUEST_BODY_LIMIT = 8 * 1024 * 1024;
const credentialPattern = /password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i;

export interface NetworkRequest {
  method: string;
  url: string;
  headers?: Record<string, unknown>;
  hasPostData?: boolean;
  postData?: string;
  postDataEntries?: unknown[];
  [key: string]: unknown;
}

export const redactHeaders = (headers: Record<string, unknown> = {}) => Object.fromEntries(
  Object.entries(headers).map(([key, value]) => [key, credentialPattern.test(key) ? '[excluded credential]' : value]),
);

/** Never duplicate either textual or base64-encoded bodies into raw/event metadata. */
export function requestMetadata(request: NetworkRequest): Omit<NetworkRequest, 'postData' | 'postDataEntries'> {
  const { postData: _postData, postDataEntries: _entries, ...metadata } = request;
  return { ...metadata, headers: redactHeaders(request.headers) };
}

function header(request: NetworkRequest, name: string): string | undefined {
  const value = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function hasCredentials(text: string): boolean {
  // Inspect the whole observed body before truncating; cover JSON-escaped names and form keys.
  let decoded = text.replace(/\\u([a-f0-9]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (credentialPattern.test(decoded)) return true;
  try { decoded = decodeURIComponent(decoded.replace(/\+/g, ' ')); }
  catch { decoded = decoded.replace(/%([a-f0-9]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
  return credentialPattern.test(decoded);
}

export interface RequestBodyOptions {
  source: Record<string, unknown>;
  acquireRead(): RequestBodyRead;
  readPostData(): Promise<{ postData?: string; base64Encoded?: boolean }>;
  limitBytes?: number;
  timeoutMs?: number;
}

/** Called directly from requestWillBeSent, before awaiting any disk write. */
export async function captureRequestBody(request: NetworkRequest, options: RequestBodyOptions): Promise<ArtifactInput> {
  const contentType = header(request, 'content-type');
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase() || 'text/plain';
  const base: ArtifactInput = { kind: 'request-body', mediaType, limitBytes: options.limitBytes ?? REQUEST_BODY_LIMIT, source: options.source };
  const state = (captureStatus: ArtifactInput['captureStatus'], reason: string): ArtifactInput => ({ ...base, captureStatus, reason });
  const declared = header(request, 'content-length');
  const declaredBytes = declared !== undefined && /^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) ? Number(declared) : undefined;
  const hasBody = typeof request.postData === 'string' || request.hasPostData === true || !!request.postDataEntries?.length || (declaredBytes ?? 0) > 0;
  if (!hasBody) return state('not-applicable', 'request-has-no-post-data');
  // CDP getRequestPostData omits file parts; never claim a multipart body is complete.
  if (/^multipart\//i.test(mediaType)) return state('excluded', 'multipart-request-body-excluded-file-parts-not-guaranteed');
  if (contentType && !/^(text\/|application\/(?:[^;]+\+)?(?:json|xml)$|application\/(?:javascript|x-www-form-urlencoded)$|image\/svg\+xml$)/i.test(mediaType)) return state('excluded', 'binary-request-body-metadata-only');
  const charset = /;\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType ?? '')?.[1];
  if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) return state('excluded', 'request-body-charset-not-supported');

  let text = request.postData;
  let acquiredBy = 'requestWillBeSent';
  if (typeof text !== 'string') {
    const read = options.acquireRead();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (read.invalidated) return state('missing', read.invalidated);
      acquiredBy = 'getRequestPostData';
      const outcome = await Promise.race([
        options.readPostData().then(value => ({ type: 'body' as const, value }), () => ({ type: 'failed' as const })),
        new Promise<{ type: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ type: 'timeout' }), options.timeoutMs ?? 5000); }),
      ]);
      if (read.invalidated) return state('missing', read.invalidated);
      if (outcome.type !== 'body') return state('read-failed', outcome.type === 'timeout' ? 'request-body-read-timeout' : 'request-body-read-failed');
      text = outcome.value?.postData;
      if (typeof text !== 'string') return state('missing', 'request-body-not-returned-by-cdp');
      if (outcome.value.base64Encoded) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return state('read-failed', 'request-body-invalid-cdp-base64');
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(text, 'base64')); }
        catch { return state('excluded', 'request-body-is-not-utf8-text'); }
      }
    } catch {
      // CDP errors can contain site-controlled strings. Do not copy them into evidence.
      return state(read.invalidated ? 'missing' : 'read-failed', read.invalidated ?? 'request-body-read-failed');
    } finally { if (timer) clearTimeout(timer); read.release(); }
  }
  if (hasCredentials(text)) return state('excluded', 'credential-bearing-request-body');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return state('excluded', 'binary-request-body-metadata-only');
  const observedBytes = Buffer.byteLength(text);
  const incomplete = declaredBytes !== undefined && declaredBytes > observedBytes;
  return {
    ...base, data: text,
    ...(incomplete ? { captureStatus: 'truncated' as const, reason: 'request-body-shorter-than-content-length' } : {}),
    metadata: { acquiredBy, observedBytes, ...(declaredBytes !== undefined ? { declaredBytes } : {}), byteRepresentation: 'CDP text encoded as UTF-8' },
  };
}
