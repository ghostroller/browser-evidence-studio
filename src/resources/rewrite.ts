/** Resource URL rewriting is lexical: CSS strings/comments are distinguished
 * from url() and @import tokens; no global replacement of site-controlled text. */
function escapeString(text: string): string { return '"' + text.replace(/["\\\n\r\f]/g, char => char === '"' || char === '\\' ? '\\' + char : '\\a ') + '"'; }
function decodeCss(text: string): string { return text.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n\f])|\r?\n)/gi, (_match, hex: string | undefined, escaped: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : escaped ?? ''); }
function stringEnd(css: string, start: number): number {
  const quote = css[start]; let i = start + 1;
  while (i < css.length) { if (css[i] === '\\') { i += 2; continue; } if (css[i++] === quote) return i; }
  return css.length;
}
export function rewriteCssUrls(css: string, resolve: (url: string) => string): string {
  const output: string[] = []; let i = 0, importPending = false;
  while (i < css.length) {
    if (css.startsWith('/*', i)) { const end = css.indexOf('*/', i + 2); const next = end < 0 ? css.length : end + 2; output.push(css.slice(i, next)); i = next; continue; }
    const char = css[i];
    if (char === '"' || char === "'") {
      const end = stringEnd(css, i);
      output.push(importPending ? escapeString(resolve(decodeCss(css.slice(i + 1, end - 1)))) : css.slice(i, end));
      importPending = false; i = end; continue;
    }
    if (/[a-z@_-]/i.test(char)) {
      const start = i; while (i < css.length && /[a-z0-9@_-]/i.test(css[i])) i++;
      const token = css.slice(start, i), lower = token.toLowerCase();
      if (lower === '@import') { importPending = true; output.push(token); continue; }
      let next = i; while (/\s/.test(css[next] ?? '') && next < css.length) next++;
      if (lower !== 'url' || css[next] !== '(') { output.push(token); if (token.trim()) importPending = false; continue; }
      i = next + 1; while (/\s/.test(css[i] ?? '') && i < css.length) i++;
      let value: string;
      if (css[i] === '"' || css[i] === "'") { const end = stringEnd(css, i); value = decodeCss(css.slice(i + 1, end - 1)); i = end; }
      else {
        const start = i;
        while (i < css.length && css[i] !== ')') { if (css[i] === '\\') i++; i++; }
        value = decodeCss(css.slice(start, i).trim());
      }
      while (i < css.length && css[i] !== ')') i++;
      if (css[i] === ')') i++;
      output.push(`url(${escapeString(resolve(value))})`); importPending = false; continue;
    }
    output.push(char); i++;
    if (char === ';' || char === '{') importPending = false;
  }
  return output.join('');
}

/** HTML srcset tokenization keeps commas inside data URLs and preserves width
 * or density descriptors. Invalid candidates resolve to the blocked placeholder. */
export function rewriteSrcset(value: string, resolve: (url: string) => string): string {
  const items: string[] = []; let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    const start = i; while (i < value.length && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i), immediate = false;
    if (!url) break;
    if (url.endsWith(',')) { url = url.replace(/,+$/, ''); immediate = true; }
    let descriptor = '';
    if (!immediate) { const start = i; while (i < value.length && value[i] !== ',') i++; descriptor = value.slice(start, i).trim(); }
    if (value[i] === ',') i++;
    const valid = !descriptor || /^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor);
    items.push(`${valid ? resolve(url) : 'about:blank'}${valid && descriptor ? ' ' + descriptor : ''}`);
  }
  return items.join(', ');
}

export const OFFLINE_CSP = "default-src 'none'; img-src bes-resource: data: blob:; style-src 'unsafe-inline' bes-resource:; font-src bes-resource: data: blob:; media-src 'none'; frame-src 'none'; connect-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

/** Runs in the trusted replay shell against a detached DOMParser document.
 * The actual replay partition must independently deny network and navigation. */
export function sanitizeReplayDocument(document: Document, resolve: (url: string) => string): void {
  for (const element of document.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv]')) element.remove();
  for (const element of document.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ['action', 'formaction', 'srcdoc', 'ping', 'autofocus'].includes(name)) element.removeAttribute(attr.name);
      else if (name === 'style') element.setAttribute(attr.name, rewriteCssUrls(attr.value, resolve));
      else if (name === 'srcset') element.setAttribute(attr.name, rewriteSrcset(attr.value, resolve));
      else if (['src', 'href', 'poster', 'xlink:href', 'background'].includes(name)) element.setAttribute(attr.name, attr.value.startsWith('#') ? attr.value : resolve(attr.value));
    }
    if (element.localName === 'style') element.textContent = rewriteCssUrls(element.textContent ?? '', resolve);
  }
  const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = OFFLINE_CSP;
  document.head?.prepend(policy);
}
