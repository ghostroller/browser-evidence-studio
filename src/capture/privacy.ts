import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { credentialUrl, redactUrlText } from './url-privacy';
import { rewriteCssUrls } from '@/resources/rewrite';

const credential = /password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i;
/** Parse, then redact the same form attributes that the rrweb/source adapter
 * masks. Unchanged documents retain original bytes; redacted serialization is
 * explicitly marked derived by the artifact producer. Parsing cannot execute
 * scripts or fetch referenced URLs. */
export function redactHtml(html: string): { text: string; redacted: boolean } {
  const document = parse(html); let redacted = false;
  function visit(node: DefaultTreeAdapterTypes.Node, maskText = false): void {
    if ('tagName' in node) {
      const classValue = node.attrs.find(attr => attr.name === 'class')?.value ?? '';
      maskText ||= /(?:^|\s)rr-mask(?:\s|$)/.test(classValue) || node.tagName === 'textarea';
      if (/(?:^|\s)rr-block(?:\s|$)/.test(classValue)) { node.attrs = [{ name: 'class', value: 'rr-block' }]; node.childNodes = []; redacted = true; return; }
      for (const attr of node.attrs) if (maskText && attr.name !== 'class' || credential.test(attr.name) || credentialUrl(attr.value) || attr.name === 'value' && /^(input|textarea|select|option)$/.test(node.tagName)) { attr.value = '[redacted]'; redacted = true; }
      if ('content' in node) visit(node.content, maskText);
    }
    if (node.nodeName === '#text' && 'value' in node) { const safe = maskText ? '[redacted]' : redactUrlText(node.value); redacted ||= safe !== node.value; node.value = safe; }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, maskText);
  }
  visit(document); return { text: redacted ? serialize(document) : html, redacted };
}

export function responsePrivacy(bytes: Buffer, mediaType: string): { data?: Buffer; redacted: boolean; excludedReason?: string } {
  if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(mediaType)) {
    const result = redactHtml(bytes.toString('utf8')); return { data: result.redacted ? Buffer.from(result.text) : bytes, redacted: result.redacted };
  }
  if (/json/i.test(mediaType)) {
    let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { return { data: bytes, redacted: false }; }
    let redacted = false;
    function visit(input: unknown, depth = 0): unknown {
      if (depth > 256) throw new Error('Response privacy nesting budget');
      if (typeof input === 'string') { const safe = redactUrlText(input); redacted ||= safe !== input; return safe; }
      if (Array.isArray(input)) return input.map(child => visit(child, depth + 1));
      if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => { if (credential.test(key)) { redacted = true; return [key, '[redacted]']; } return [key, visit(child, depth + 1)]; }));
      return input;
    }
    try { value = visit(value); } catch { return { redacted: true, excludedReason: 'response-privacy-nesting-budget' }; }
    return { data: redacted ? Buffer.from(JSON.stringify(value)) : bytes, redacted };
  }
  if (/^text\/|xml|javascript|svg/i.test(mediaType)) {
    const text = bytes.toString('utf8');
    let privateUrl = credentialUrl(text);
    if (/css/i.test(mediaType)) rewriteCssUrls(text, url => { privateUrl ||= credentialUrl(url); return url; });
    if (privateUrl) return { redacted: true, excludedReason: 'credential-url-in-text-response' };
  }
  return { data: bytes, redacted: false };
}
