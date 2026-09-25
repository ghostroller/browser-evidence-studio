import { responsePrivacy } from './privacy';
import { credentialUrl } from './url-privacy';
import type { captureError } from './url-privacy';

export const RESPONSE_CAPTURE_BYTES = 8 * 1024 * 1024;
export const RESPONSE_CDP_BUFFER_BYTES = 10 * 1024 * 1024;
export const RESPONSE_WORKING_BYTES = 40 * 1024 * 1024;
// CDP strings, the retained prefix and the store's immutable prefix copy fit
// together in the existing 40 MiB reservation. Reject before further allocation.
const MAX_STRING_CHARACTERS = 12 * 1024 * 1024 - 128 * 1024;

/** Privacy check on the ENTIRE observed large response, before truncation.
 * This deliberately excludes ambiguous large structured text rather than
 * parsing an unbounded JSON/HTML object graph alongside the original string. */
function largeTextMayBePrivate(text: string): boolean {
  for (let start = 0; start < text.length; start += 64 * 1024) {
    const chunk = text.slice(Math.max(0, start - 512), start + 64 * 1024 + 512)
      .replace(/\\u([a-f0-9]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/%([a-f0-9]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (/password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i.test(chunk) || credentialUrl(chunk)) return true;
  }
  return false;
}

export function prepareResponseBody(body: { body: string; base64Encoded: boolean }, mediaType: string): {
  data?: Buffer; redacted: boolean; excludedReason?: string; observedBytes?: number; privacyError?: ReturnType<typeof captureError>;
} {
  if (body.body.length > MAX_STRING_CHARACTERS) throw new Error('response-observed-string-working-set-budget');
  const observedBytes = body.base64Encoded
    ? Math.floor(body.body.length / 4) * 3 - (body.body.endsWith('==') ? 2 : body.body.endsWith('=') ? 1 : 0)
    : Buffer.byteLength(body.body);
  if (observedBytes <= RESPONSE_CAPTURE_BYTES) return responsePrivacy(Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8'), mediaType);
  // Large base64/HTML cannot be inspected within this narrow text prefix path;
  // resource capture also needs complete bytes, never a truncated blob.
  if (body.base64Encoded || !/^text\/plain(?:;|$)|json/i.test(mediaType)) return { redacted: true, excludedReason: 'large-response-privacy-representation-unsupported' };
  if (largeTextMayBePrivate(body.body)) return { redacted: true, excludedReason: 'credential-bearing-large-response' };
  const data = Buffer.allocUnsafe(RESPONSE_CAPTURE_BYTES);
  const written = data.write(body.body, 0, data.length, 'utf8');
  return { data: data.subarray(0, written), redacted: false, observedBytes };
}
