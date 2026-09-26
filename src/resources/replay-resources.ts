import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { ReplayPosition } from '@/contracts/recording';
import { ResourceArchive } from './archive';
import { OFFLINE_CSP, rewriteCssUrls, rewriteSrcset } from './rewrite';
import type { RecordingEnvelope } from '@/capture/recording-types';

export const resourceUrl = (id: string): string => `bes-resource://archive/${id}`;
type ElementContext = { tagName?: string; rel?: string };
function loadableAttribute(name: string, context: ElementContext): boolean {
  const tag = context.tagName?.toLowerCase();
  if (name === 'src' || name === 'rr_src') return ['img', 'audio', 'video', 'source', 'track', 'embed', 'input'].includes(tag ?? '');
  if (name === 'srcset') return tag === 'img' || tag === 'source';
  if (name === 'poster') return tag === 'video';
  if (name === 'background') return ['body', 'table', 'td', 'th'].includes(tag ?? '');
  if (name === 'href' && tag === 'link') return /\b(stylesheet|icon|preload)\b/i.test(context.rel ?? '');
  if (name === 'href' || name === 'xlink:href') return tag === 'image' || tag === 'use';
  return false;
}
/** Presentation copy only. Original URLs and SourceMetadata remain untouched. */
export function rewriteReplayEvent(original: eventWithTime, resolve: (url: string, frameId?:string) => string,
  frameForNode?: (nodeId:number)=>string|undefined, frameForStyle?: (styleId:number)=>string|undefined,
  elementForNode?: (nodeId:number)=>ElementContext|undefined): eventWithTime {
  const event = structuredClone(original);
  function attributes(attributes: Record<string, unknown>,nodeId:number,element?:ElementContext): void {
    const resolveNode=(url:string)=>resolve(url,frameForNode?frameForNode(nodeId):'top');
    const context={...elementForNode?.(nodeId),...element};
    const rel=typeof attributes.rel==='string'?attributes.rel:context.rel;
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('on') || ['action', 'formaction', 'srcdoc', 'ping'].includes(name)) { delete attributes[name]; continue; }
      if (typeof value !== 'string') continue;
      if (name === '_cssText' || name === 'style') attributes[name] = rewriteCssUrls(value, resolveNode);
      else if (name === 'srcset') attributes[name] = loadableAttribute(name,context) ? rewriteSrcset(value, resolveNode) : 'about:blank';
      else if (['src', 'href', 'poster', 'xlink:href', 'background', 'rr_src'].includes(name)) {
        attributes[name] = loadableAttribute(name,{...context,rel}) ? (value.startsWith('#') ? value : resolveNode(value)) : 'about:blank';
      }
    }
  }
  function tree(node: serializedNodeWithId): void {
    if (node.type === 2) {
      attributes(node.attributes,node.id,{tagName:node.tagName,rel:typeof node.attributes.rel==='string'?node.attributes.rel:undefined});
      if (node.tagName === 'style') for (const child of node.childNodes) if (child.type === 3) child.textContent = rewriteCssUrls(child.textContent, url=>resolve(url,frameForNode?frameForNode(node.id):'top'));
      if (node.tagName === 'iframe') { delete node.attributes.src; delete node.attributes.rr_src; }
    }
    if ('childNodes' in node) node.childNodes.forEach(tree);
  }
  if (event.type === 2) tree(event.data.node);
  if (event.type === 4) event.data.href = 'about:blank';
  if (event.type === 3) {
    if (event.data.source === 0) { event.data.adds.forEach(addition => tree(addition.node)); event.data.attributes.forEach(change => attributes(change.attributes,change.id)); }
    if (event.data.source === 8) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      const css = (url: string) => resolve(url, frame);
      event.data.adds?.forEach(addition => { addition.rule = rewriteCssUrls(addition.rule, css); });
      if (event.data.replace !== undefined) event.data.replace = rewriteCssUrls(event.data.replace, css);
      if (event.data.replaceSync !== undefined) event.data.replaceSync = rewriteCssUrls(event.data.replaceSync, css);
    }
    if (event.data.source === 13 && event.data.set?.value != null) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      event.data.set.value = rewriteCssUrls(event.data.set.value, url => resolve(url, frame));
    }
    if (event.data.source === 15) { const frame=frameForNode?.(event.data.id);event.data.styles?.forEach(style => style.rules.forEach(rule => { rule.rule = rewriteCssUrls(rule.rule, url => resolve(url, frame)); })); }
  }
  return event;
}

/** Advance original per-node frame scopes alongside the source event stream;
 * callers bind the URL lookup to that logical frame, never to the live profile. */
export function rewriteReplayRecords(records:RecordingEnvelope[],resolve:(url:string,frameId:string|undefined,position:ReplayPosition)=>string):RecordingEnvelope[]{
  const frames=new Map<number,string>(),styles=new Map<number,string>(),elements=new Map<number,ElementContext>();
  return records.map(record=>{
    if(record.event.type===2){frames.clear();styles.clear();elements.clear();}
    for(const metadata of record.metadata){
      frames.set(metadata.nodeId,metadata.frameId);
      elements.set(metadata.nodeId,{tagName:metadata.tagName,rel:metadata.attributes.rel?.status==='present'?metadata.attributes.rel.value:undefined});
    }
    const event = record.event;
    if(event.type===3&&event.data.source===15){const frame=frames.get(event.data.id);if(frame)for(const style of event.data.styles??[])styles.set(style.styleId,frame);}
    return{...record,event:rewriteReplayEvent(record.event,(url,frame)=>resolve(url,frame,record.position),id=>frames.get(id),id=>styles.get(id),id=>elements.get(id))};
  });
}

export interface ReplayResourceDiagnostic {
  url: string; frameId?: string; position: ReplayPosition;
  status: 'missing' | 'excluded' | 'unsupported' | 'read-failed'; reason: string;
}
/** Shared production/test preparation. Every URL use resolves at its source
 * event and logical frame; no final-position or top-frame fallback is allowed. */
export async function prepareArchivedReplay(records: RecordingEnvelope[], archive: ResourceArchive,
  urlForResource: (id: string, position: ReplayPosition) => string): Promise<{ records: RecordingEnvelope[]; diagnostics: ReplayResourceDiagnostic[] }> {
  const uses = new Map<string, { url: string; frameId?: string; position: ReplayPosition }>();
  const key = (url: string, frameId: string | undefined, position: ReplayPosition) => JSON.stringify([url, frameId, position.recordingId, position.pageId, position.documentId, position.streamEpoch, position.eventSeq]);
  rewriteReplayRecords(records, (url, frameId, position) => { uses.set(key(url, frameId, position), { url, frameId, position }); return url; });
  const replacements = new Map<string, string>(), diagnostics: ReplayResourceDiagnostic[] = [];
  if (uses.size > 5000) throw new Error('Replay resource use budget exceeded');
  for (const [identity, use] of uses) {
    const { url, frameId, position } = use;
    if (url.startsWith('#') || url === 'about:blank') { replacements.set(identity, url); continue; }
    if (!frameId) { diagnostics.push({ ...use, status: 'unsupported', reason: 'source-frame-unmapped' }); replacements.set(identity, 'about:blank'); continue; }
    try {
      const reference = await archive.resolve(url, position, frameId);
      if (reference?.status === 'captured') { replacements.set(identity, urlForResource(reference.id, position)); continue; }
      diagnostics.push({ ...use, status: reference?.status === 'redacted' ? 'excluded' : reference?.status === 'unsupported' ? 'unsupported' : 'missing',
        reason: reference?.reason ?? (reference?.status ? `resource-${reference.status}` : 'resource-not-captured') });
    } catch (error) {
      diagnostics.push({ ...use, status: 'read-failed', reason: error instanceof Error ? error.name : 'resource-read-error' });
    }
    replacements.set(identity, 'about:blank');
  }
  return { records: rewriteReplayRecords(records, (url, frameId, position) => replacements.get(key(url, frameId, position)) ?? 'about:blank'), diagnostics };
}

/** Protocol adapter contains no navigation/fetch. Caller must bind the archive
 * to the authorized replay view and refuse any ID outside that run. */
export class OfflineResourceService {
  constructor(private readonly archive: ResourceArchive) {}
  async response(id: string, position: ReplayPosition, urlForResource: (id:string)=>string = resourceUrl): Promise<{ bytes: Uint8Array; headers: Record<string, string>; diagnostics: ReplayResourceDiagnostic[] }> {
    const { reference, bytes } = await this.archive.read(id);
    if (reference.position.recordingId !== position.recordingId || reference.position.pageId !== position.pageId || reference.position.documentId !== position.documentId || reference.position.streamEpoch !== position.streamEpoch || reference.position.eventSeq > position.eventSeq) throw new Error('Resource belongs to another historical position');
    let content: Uint8Array = bytes;
    const diagnostics: ReplayResourceDiagnostic[] = [];
    if (/^text\/css(?:;|$)/i.test(reference.mediaType) && reference.originalUrl.status === 'present') {
      const css = bytes.toString('utf8'), base = reference.originalUrl.value;
      const urls = new Set<string>(); rewriteCssUrls(css, url => { urls.add(url); return url; });
      if (urls.size > 1000) throw new Error('Stylesheet dependency count exceeds budget');
      const mapped = new Map<string, string>();
      for (const url of urls) {
        if (url.startsWith('#')) { mapped.set(url, url); continue; }
        let absolute: string; try { absolute = new URL(url, base).href; } catch { mapped.set(url, 'about:blank'); diagnostics.push({url,frameId:reference.frameId,position,status:'unsupported',reason:'invalid-css-resource-url'}); continue; }
        try {
          const dependency = await this.archive.resolve(absolute, position, reference.frameId);
          if (dependency?.status === 'captured') mapped.set(url, urlForResource(dependency.id));
          else {
            mapped.set(url, 'about:blank');
            diagnostics.push({url:absolute,frameId:reference.frameId,position,status:dependency?.status === 'redacted' ? 'excluded' : dependency?.status === 'unsupported' ? 'unsupported' : 'missing',reason:dependency?.reason ?? 'css-resource-not-captured'});
          }
        } catch (error) {
          mapped.set(url, 'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'read-failed',reason:error instanceof Error?error.name:'css-resource-read-error'});
        }
      }
      content = Buffer.from(rewriteCssUrls(css, url => mapped.get(url) ?? 'about:blank'));
    }
    return { bytes: content, diagnostics, headers: { 'content-type': reference.mediaType, 'content-security-policy': OFFLINE_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } };
  }
}
