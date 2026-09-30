import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import { rewriteCssUrls, rewriteSrcset } from './rewrite';
/** Pure injectable lexical URL transformation used in archive preparation and the isolated document. */
export function createReplayEventRewriter(rewriteCss: typeof rewriteCssUrls, srcset: typeof rewriteSrcset) {
type ElementContext = { tagName?: string; rel?: string };
type ResourceUseSite = { nodeId: number; attribute: string };
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
function rewriteReplayEvent(original: eventWithTime, resolve: (url: string, frameId?:string, site?:ResourceUseSite) => string,
  frameForNode?: (nodeId:number)=>string|undefined, frameForStyle?: (styleId:number)=>string|undefined,
  elementForNode?: (nodeId:number)=>ElementContext|undefined, frameForStyleText?: (nodeId:number)=>string|undefined): eventWithTime {
  const event = structuredClone(original);
  function attributes(attributes: Record<string, unknown>,nodeId:number,element?:ElementContext): void {
    const resolveNode=(url:string,attribute:string)=>resolve(url,frameForNode?frameForNode(nodeId):'top',{nodeId,attribute});
    const context={...elementForNode?.(nodeId),...element};
    const rel=typeof attributes.rel==='string'?attributes.rel:context.rel;
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('on') || ['action', 'formaction', 'srcdoc', 'ping'].includes(name)) { delete attributes[name]; continue; }
      if (typeof value !== 'string') continue;
      if (name === '_cssText' || name === 'style') attributes[name] = rewriteCss(value, url=>resolveNode(url,name));
      else if (name === 'srcset') attributes[name] = loadableAttribute(name,context) ? srcset(value, url=>resolveNode(url,name)) : 'about:blank';
      else if (['src', 'href', 'poster', 'xlink:href', 'background', 'rr_src'].includes(name)) {
        attributes[name] = loadableAttribute(name,{...context,rel}) ? (value.startsWith('#') ? value : resolveNode(value,name)) : 'about:blank';
      }
    }
  }
  function tree(node: serializedNodeWithId): void {
    if (node.type === 2) {
      attributes(node.attributes,node.id,{tagName:node.tagName,rel:typeof node.attributes.rel==='string'?node.attributes.rel:undefined});
      if (node.tagName === 'style') for (const child of node.childNodes) if (child.type === 3) child.textContent = rewriteCss(child.textContent, url=>resolve(url,frameForNode?frameForNode(node.id):'top'));
      if (node.tagName === 'iframe') { delete node.attributes.src; delete node.attributes.rr_src; }
    }
    if ('childNodes' in node) node.childNodes.forEach(tree);
  }
  if (event.type === 2) tree(event.data.node);
  if (event.type === 4) event.data.href = 'about:blank';
  if (event.type === 3) {
    if (event.data.source === 0) { event.data.adds.forEach(addition => tree(addition.node)); event.data.attributes.forEach(change => attributes(change.attributes,change.id));event.data.texts.forEach(change=>{const frame=frameForStyleText?.(change.id);if(frame&&change.value!==null)change.value=rewriteCss(change.value,url=>resolve(url,frame));}); }
    if (event.data.source === 8) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      const css = (url: string) => resolve(url, frame);
      event.data.adds?.forEach(addition => { addition.rule = rewriteCss(addition.rule, css); });
      if (event.data.replace !== undefined) event.data.replace = rewriteCss(event.data.replace, css);
      if (event.data.replaceSync !== undefined) event.data.replaceSync = rewriteCss(event.data.replaceSync, css);
    }
    if (event.data.source === 13 && event.data.set?.value != null) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      event.data.set.value = rewriteCss(event.data.set.value, url => resolve(url, frame));
    }
    if (event.data.source === 15) { const frame=frameForNode?.(event.data.id);event.data.styles?.forEach(style => style.rules.forEach(rule => { rule.rule = rewriteCss(rule.rule, url => resolve(url, frame)); })); }
  }
  return event;
}

return rewriteReplayEvent;
}
export const rewriteReplayEvent = createReplayEventRewriter(rewriteCssUrls, rewriteSrcset);
