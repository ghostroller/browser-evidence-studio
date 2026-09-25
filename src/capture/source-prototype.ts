import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';

/** S0 only: not installed in the production recorder. The three verified 2.1.6
 * insertion points preserve rrweb's recorder, privacy policy, and node IDs.
 * Refuse a different distribution instead of silently running without metadata.
 * A must replace this spike with a maintained, versioned adapter/patch. */
export function instrumentRrweb216ForSourcePrototype(source: string): string {
  if (source.includes('globalThis.__besS0SourceHook')) throw new Error('rrweb distribution is already instrumented');
  const patches = [
    ['onSerialize: (currentN) => {', 'onSerialize: (currentN) => {\n globalThis.__besS0SourceHook(currentN, this.mirror);'],
    ['onSerialize: (n2) => {', 'onSerialize: (n2) => {\n globalThis.__besS0SourceHook(n2, mirror);'],
    ['let item = this.attributeMap.get(m.target);', 'globalThis.__besS0SourceHook(m.target, this.mirror);\n let item = this.attributeMap.get(m.target);'],
  ];
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error(`Unsupported rrweb distribution: expected one source hook marker ${before}`);
    source = source.replace(before, after);
  }
  return source;
}

export interface PrototypeSourceMetadata {
  nodeId: number;
  tagName: string;
  namespaceURI: string | null;
  attributes: Record<string, string>;
  redactedAttributes: string[];
  properties: { checked?: boolean; selected?: boolean; value?: 'redacted' };
  documentUrl: string;
  baseURI: string;
}

export interface PrototypeSourceEvent {
  seq: number;
  event: eventWithTime;
  metadata: PrototypeSourceMetadata[];
}

export interface PrototypeSourceNode {
  id: number;
  type: number;
  tagName?: string;
  namespaceURI?: string | null;
  attributes?: Record<string, string>;
  properties?: PrototypeSourceMetadata['properties'];
  textContent?: string;
  children: PrototypeSourceNode[];
}

/** Reuses rrweb structure; sparse metadata restores overwritten original values.
 * This bounded, single-document prototype deliberately rejects unsupported roots.
 * It never reads the replayer DOM to reconstruct original source structure. */
export function reconstructPrototypeSource(records: PrototypeSourceEvent[], throughSeq: number): PrototypeSourceNode {
  const nodes = new Map<number, PrototypeSourceNode>();
  const metadata = new Map<number, PrototypeSourceMetadata>();
  let root: PrototypeSourceNode | undefined;
  function restore(source: serializedNodeWithId): PrototypeSourceNode {
    if ('isShadow' in source && source.isShadow || 'rootId' in source && source.rootId) throw new Error('S0 source model does not support frame/shadow roots');
    const result: PrototypeSourceNode = { id: source.id, type: source.type, children: [] };
    nodes.set(source.id, result);
    if (source.type === 2) {
      const original = metadata.get(source.id);
      if (!original) throw new Error(`Metadata gap for node ${source.id}`);
      Object.assign(result, { tagName: original.tagName, namespaceURI: original.namespaceURI, attributes: { ...original.attributes }, properties: { ...original.properties } });
    } else if ('textContent' in source) result.textContent = source.textContent;
    if ('childNodes' in source) result.children = source.childNodes.map(restore);
    return result;
  }
  function remove(id: number): void {
    const item = nodes.get(id);
    if (!item) throw new Error(`Missing source removal ${id}`);
    for (const child of item.children) remove(child.id);
    for (const parent of nodes.values()) parent.children = parent.children.filter(child => child.id !== id);
    nodes.delete(id);
  }
  for (const record of records) {
    if (record.seq > throughSeq) break;
    const event = record.event;
    if (event.type === 2) { nodes.clear(); metadata.clear(); }
    for (const entry of record.metadata) metadata.set(entry.nodeId, entry);
    if (event.type === 2) root = restore(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      for (const entry of event.data.removes) remove(entry.id);
      for (const entry of event.data.adds) {
        const parent = nodes.get(entry.parentId);
        if (!parent) throw new Error(`Missing source parent ${entry.parentId}`);
        const child = restore(entry.node);
        const nextIndex = entry.nextId === null ? parent.children.length : parent.children.findIndex(candidate => candidate.id === entry.nextId);
        if (nextIndex < 0) throw new Error(`Missing source next sibling ${entry.nextId}`);
        parent.children.splice(nextIndex, 0, child);
      }
      for (const entry of event.data.texts) {
        const node = nodes.get(entry.id);
        if (!node) throw new Error(`Missing source text node ${entry.id}`);
        node.textContent = entry.value ?? '';
      }
      for (const entry of event.data.attributes) {
        if (!record.metadata.some(candidate => candidate.nodeId === entry.id)) throw new Error(`Metadata gap for attribute mutation ${entry.id}`);
      }
    }
    for (const entry of record.metadata) {
      const node = nodes.get(entry.nodeId);
      if (node) Object.assign(node, { tagName: entry.tagName, namespaceURI: entry.namespaceURI, attributes: { ...entry.attributes }, properties: { ...entry.properties } });
    }
  }
  if (!root) throw new Error('No full snapshot before requested source position');
  return root;
}

export function prototypeLocators(node: PrototypeSourceNode): { css: string; xpath: string; basis: string } {
  const attr = node.attributes?.href !== undefined ? 'href' : node.attributes?.['data-key'] !== undefined ? 'data-key' : undefined;
  if (!attr || !node.tagName || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new Error('No supported original-source locator basis');
  const value = node.attributes![attr];
  const cssValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  const xpathValue = !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : `concat(${value.split("'").map(part => `'${part}'`).join(`,"'",`)})`;
  return { css: `${node.tagName}[${attr}="${cssValue}"]`, xpath: `//${node.tagName}[@${attr}=${xpathValue}]`, basis: `original ${attr}; historical uniqueness requires independent validation` };
}
