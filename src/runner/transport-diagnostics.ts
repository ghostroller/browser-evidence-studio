export interface TransportCloseInfo {
  source: 'local' | 'remote' | 'error' | 'unknown';
  occurredAt: string;
  code?: number;
  reason?: string;
  reasonTruncated?: boolean;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
}

const textLimit = 512;

/** Close reasons and socket errors are untrusted diagnostics, never protocol payloads. */
function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:cookie|set-cookie)\s*[:=].*/gi, '[redacted-cookie]')
    .replace(/\b(?:authorization|proxy-authorization|token|access_token|password|secret)["']?\s*[:=]\s*["']?[^\s,;"']+/gi, '[redacted-credential]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[redacted-address]')
    .replace(/\[[\da-f:]+\](?::\d+)?/gi, '[redacted-address]')
    .replace(/(?<!\w)(?:[a-f\d]{0,4}:){2,}[a-f\d:]+/gi, '[redacted-address]')
    .replace(/\b(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '[redacted-address]')
    .slice(0, textLimit);
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z\d_.-]{1,80}$/i.test(value) ? value : undefined;
}

export function transportCloseInfo(source: TransportCloseInfo['source'], details: { code?: unknown; reason?: unknown; error?: unknown } = {}): TransportCloseInfo {
  const result: TransportCloseInfo = { source, occurredAt: new Date().toISOString() };
  if (typeof details.code === 'number' && Number.isInteger(details.code) && details.code >= 0 && details.code <= 65535) result.code = details.code;
  const reason = safeText(details.reason);
  if (reason !== undefined) result.reason = reason;
  if (typeof details.reason === 'string' && details.reason.length > textLimit) result.reasonTruncated = true;
  if (details.error && typeof details.error === 'object') {
    const error = details.error as { name?: unknown; code?: unknown; message?: unknown };
    const name = identifier(error.name), code = identifier(error.code), message = safeText(error.message);
    if (name) result.errorName = name;
    if (code) result.errorCode = code;
    if (message !== undefined) result.errorMessage = message;
  } else if (typeof details.error === 'string') result.errorMessage = safeText(details.error);
  return result;
}
