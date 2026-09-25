/** This function is also serialized into the isolated recorder world. Keep all
 * runtime dependencies inside it. Public URLs retain their literal spelling. */
export function credentialUrl(value: string, base = 'https://capture.invalid/'): boolean {
  if (!/[?#]|:\/\/|^\/\//.test(value)) return false;
  const credential = /password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i;
  const candidates = [value, ...(value.match(/(?:https?|wss?):\/\/[^\s"'<>]+/gi) ?? [])];
  for (const candidate of candidates) try {
    const url = new URL(candidate, base);
    if (url.username || url.password || [...url.searchParams.keys()].some(key => credential.test(key))) return true;
    const fragment = url.hash.slice(1), query = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
    if ([...new URLSearchParams(query).keys()].some(key => credential.test(key))) return true;
  } catch { if (/(?:password|token|secret|credential|api[_-]?key)(?:=|%3d)/i.test(candidate)) return true; }
  return false;
}

export function redactUrlText(value: string): string {
  if (credentialUrl(value)) return '[redacted credential URL]';
  return value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, url => credentialUrl(url) ? '[redacted credential URL]' : url);
}

/** New capture metadata only: preserve payload shape and annotate an affected
 * object. This never edits already saved originals or body bytes. */
export function captureMetadata<T>(input: T): T {
  let redacted = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 128) { redacted = true; return '[excluded metadata nesting budget]'; }
    if (typeof value === 'string') { const safe = redactUrlText(value); redacted ||= safe !== value; return safe; }
    if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, depth + 1)]));
    return value;
  };
  const result = visit(input, 0);
  if (redacted && result && typeof result === 'object' && !Array.isArray(result)) Object.assign(result, { capturePrivacy: { credentialUrls: 'redacted' } });
  return result as T;
}
