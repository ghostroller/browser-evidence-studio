import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { rewriteReplayEvent } from '../resources/replay-event-rewrite';
/** Resolve only resource use sites and CSS URL tokens. Text content, ordinary
 * attributes and CSS string literals remain original presentation text. */
export function materializeReplayEvents(events: eventWithTime[], resolve: (url: string) => string, rewrite: typeof rewriteReplayEvent): eventWithTime[] {
  const elements = new Map<number, { tagName: string; rel?: string }>(), styleTexts = new Set<number>();
  const observe = (node: serializedNodeWithId, style = false) => {
    if (node.type === 2) { elements.set(node.id, { tagName: node.tagName, rel: typeof node.attributes.rel === 'string' ? node.attributes.rel : undefined }); style = node.tagName === 'style'; }
    if (node.type === 3 && style) styleTexts.add(node.id);
    if ('childNodes' in node) for (const child of node.childNodes) observe(child, style);
  };
  return events.map(event => {
    if (event.type === 2) { elements.clear(); styleTexts.clear(); observe(event.data.node); }
    if (event.type === 3 && event.data.source === 0) {
      for (const addition of event.data.adds) observe(addition.node, elements.get(addition.parentId)?.tagName === 'style');
      for (const removal of event.data.removes) { elements.delete(removal.id); styleTexts.delete(removal.id); }
    }
    return rewrite(event, resolve, () => 'top', () => 'top', id => elements.get(id), id => styleTexts.has(id) ? 'top' : undefined);
  });
}
