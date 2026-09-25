import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';

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
      for (const attr of node.attrs) if (credential.test(attr.name) || attr.name === 'value' && /^(input|textarea|select|option)$/.test(node.tagName)) { attr.value = '[redacted]'; redacted = true; }
      if ('content' in node) visit(node.content, maskText);
    }
    if (node.nodeName === '#text' && maskText && 'value' in node) { node.value = '[redacted]'; redacted = true; }
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
    function visit(input: unknown, depth = 0): void {
      if (depth > 256) throw new Error('Response privacy nesting budget');
      if (input && typeof input === 'object') for (const [key, child] of Object.entries(input)) {
        if (credential.test(key)) { (input as Record<string, unknown>)[key] = '[redacted]'; redacted = true; }
        else visit(child, depth + 1);
      }
    }
    try { visit(value); } catch { return { redacted: true, excludedReason: 'response-privacy-nesting-budget' }; }
    return { data: redacted ? Buffer.from(JSON.stringify(value)) : bytes, redacted };
  }
  return { data: bytes, redacted: false };
}
