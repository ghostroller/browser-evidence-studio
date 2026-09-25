import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { ReplayPosition } from '@/contracts/recording';
import { ResourceArchive } from './archive';
import { OFFLINE_CSP, rewriteCssUrls, rewriteSrcset } from './rewrite';

export const resourceUrl = (id: string): string => `bes-resource://archive/${id}`;
/** Presentation copy only. Original URLs and SourceMetadata remain untouched. */
export function rewriteReplayEvent(original: eventWithTime, resolve: (url: string) => string): eventWithTime {
  const event = structuredClone(original);
  function attributes(attributes: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('on') || ['action', 'formaction', 'srcdoc', 'ping'].includes(name)) { delete attributes[name]; continue; }
      if (typeof value !== 'string') continue;
      if (name === '_cssText' || name === 'style') attributes[name] = rewriteCssUrls(value, resolve);
      else if (name === 'srcset') attributes[name] = rewriteSrcset(value, resolve);
      else if (['src', 'href', 'poster', 'xlink:href', 'background', 'rr_src'].includes(name)) attributes[name] = value.startsWith('#') ? value : resolve(value);
    }
  }
  function tree(node: serializedNodeWithId): void {
    if (node.type === 2) {
      attributes(node.attributes);
      if (node.tagName === 'style') for (const child of node.childNodes) if (child.type === 3) child.textContent = rewriteCssUrls(child.textContent, resolve);
      if (node.tagName === 'iframe') { delete node.attributes.src; delete node.attributes.rr_src; }
    }
    if ('childNodes' in node) node.childNodes.forEach(tree);
  }
  if (event.type === 2) tree(event.data.node);
  if (event.type === 4) event.data.href = 'about:blank';
  if (event.type === 3) {
    if (event.data.source === 0) { event.data.adds.forEach(addition => tree(addition.node)); event.data.attributes.forEach(change => attributes(change.attributes)); }
    if (event.data.source === 8) event.data.adds?.forEach(addition => { addition.rule = rewriteCssUrls(addition.rule, resolve); });
    if (event.data.source === 13 && event.data.set?.value != null) event.data.set.value = rewriteCssUrls(event.data.set.value, resolve);
    if (event.data.source === 15) event.data.styles?.forEach(style => style.rules.forEach(rule => { rule.rule = rewriteCssUrls(rule.rule, resolve); }));
  }
  return event;
}

/** Protocol adapter contains no navigation/fetch. Caller must bind the archive
 * to the authorized replay view and refuse any ID outside that run. */
export class OfflineResourceService {
  constructor(private readonly archive: ResourceArchive) {}
  async response(id: string, position: ReplayPosition, urlForResource: (id:string)=>string = resourceUrl): Promise<{ bytes: Uint8Array; headers: Record<string, string> }> {
    const { reference, bytes } = await this.archive.read(id);
    if (reference.position.recordingId !== position.recordingId || reference.position.pageId !== position.pageId || reference.position.documentId !== position.documentId || reference.position.streamEpoch !== position.streamEpoch || reference.position.eventSeq > position.eventSeq) throw new Error('Resource belongs to another historical position');
    let content: Uint8Array = bytes;
    if (/^text\/css(?:;|$)/i.test(reference.mediaType) && reference.originalUrl.status === 'present') {
      const css = bytes.toString('utf8'), base = reference.originalUrl.value;
      const urls = new Set<string>(); rewriteCssUrls(css, url => { urls.add(url); return url; });
      if (urls.size > 1000) throw new Error('Stylesheet dependency count exceeds budget');
      const mapped = new Map<string, string>();
      for (const url of urls) {
        if (url.startsWith('#')) { mapped.set(url, url); continue; }
        let absolute: string; try { absolute = new URL(url, base).href; } catch { mapped.set(url, 'about:blank'); continue; }
        const dependency = await this.archive.resolve(absolute, position, reference.frameId);
        mapped.set(url, dependency?.status === 'captured' ? urlForResource(dependency.id) : 'about:blank');
      }
      content = Buffer.from(rewriteCssUrls(css, url => mapped.get(url) ?? 'about:blank'));
    }
    return { bytes: content, headers: { 'content-type': reference.mediaType, 'content-security-policy': OFFLINE_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } };
  }
}
