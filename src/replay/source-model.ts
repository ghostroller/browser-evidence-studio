import type { serializedNodeWithId } from '@rrweb/types';
import type { HistoricalElementRef, SourceNode, SourceValue } from '@/contracts/recording';
import type { RecordingEnvelope, SourceMetadata } from '@/capture/recording-types';
import { EvidenceError } from '@/evidence/contracts';

export interface SourceTreeNode {
  id: number; type: number; parentId?: number; isShadow: boolean;
  children: number[]; textContent: string; metadata?: SourceMetadata;
}
/** A non-executable source structure. Never consumes the replay DOM and never
 * fills absent metadata with rrweb's transformed attributes. */
export class SourceModel {
  readonly nodes = new Map<number, SourceTreeNode>();
  rootId?: number;
  private metadata = new Map<number, SourceMetadata>();
  metadataComplete = true;
  constructor(readonly records: RecordingEnvelope[]) {
    for (const record of records) this.apply(record);
    if (this.rootId === undefined) this.fail('No source full snapshot');
  }
  private fail(reason: string): never { throw new EvidenceError('SOURCE_STRUCTURE_GAP', reason, 409); }
  private restore(input: serializedNodeWithId, parentId?: number, depth = 0, incoming?: Map<number, SourceMetadata>): number {
    if (depth > 512 || this.nodes.size >= 100_000) this.fail('Source structure exceeds bounded node/depth budget');
    if (this.nodes.has(input.id)) this.fail(`Duplicate source node ${input.id}`);
    // A moved subtree can be removed and re-added in this same rrweb batch.
    // Its newly captured metadata belongs to the new structure, not the old
    // node being removed below.
    const metadata = incoming?.get(input.id) ?? this.metadata.get(input.id);
    if (metadata) this.metadata.set(input.id, metadata);
    const node: SourceTreeNode = { id: input.id, type: input.type, parentId, isShadow: 'isShadow' in input && input.isShadow === true,
      children: [], textContent: 'textContent' in input ? input.textContent : '', metadata };
    this.nodes.set(input.id, node);
    if (input.type === 2 && !node.metadata) this.metadataComplete = false;
    if ('childNodes' in input) node.children = input.childNodes.map(child => this.restore(child, input.id, depth + 1, incoming));
    return input.id;
  }
  private remove(id: number): void {
    const node = this.nodes.get(id); if (!node) this.fail(`Missing source removal ${id}`);
    for (const child of node.children) this.remove(child);
    const parent = node.parentId === undefined ? undefined : this.nodes.get(node.parentId);
    if (parent) parent.children = parent.children.filter(child => child !== id);
    this.nodes.delete(id); this.metadata.delete(id);
  }
  private apply(record: RecordingEnvelope): void {
    const event = record.event;
    if (event.type === 2) { this.nodes.clear(); this.metadata.clear(); this.metadataComplete = record.metadataComplete; }
    if (!record.metadataComplete) this.metadataComplete = false;
    const incoming = new Map(record.metadata.map(item => [item.nodeId, structuredClone(item)]));
    if (event.type === 3 && event.data.source === 0) for (const change of event.data.removes) this.remove(change.id);
    for (const item of record.metadata) this.metadata.set(item.nodeId, structuredClone(item));
    if (event.type === 2) this.rootId = this.restore(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      // rrweb may emit children before deferred parents. Resolve each add once,
      // bounded by the batch; unresolved parent/nextId is a structural gap.
      let waiting = [...event.data.adds];
      while (waiting.length) {
        const next = [] as typeof waiting;
        for (const addition of waiting) {
          const parent = this.nodes.get(addition.parentId);
          if (!parent || addition.nextId !== null && !parent.children.includes(addition.nextId)) { next.push(addition); continue; }
          const at = addition.nextId === null ? parent.children.length : parent.children.indexOf(addition.nextId);
          if (this.nodes.has(addition.node.id)) this.remove(addition.node.id);
          parent.children.splice(at, 0, this.restore(addition.node, parent.id, 0, incoming));
        }
        if (next.length === waiting.length) this.fail('Unresolved parent or sibling in source mutation');
        waiting = next;
      }
      for (const change of event.data.texts) {
        const node = this.nodes.get(change.id); if (!node) this.fail(`Missing source text node ${change.id}`);
        node.textContent = change.value ?? '';
      }
      for (const change of event.data.attributes) if (!record.metadata.some(item => item.nodeId === change.id)) {
        this.metadataComplete = false;const node=this.nodes.get(change.id);
        if(node?.metadata){node.metadata=structuredClone(node.metadata);node.metadata.metadataComplete=false;for(const name of Object.keys(change.attributes))Object.defineProperty(node.metadata.attributes,name,{value:{status:'missing',reason:'source-attribute-mutation-metadata-gap'},writable:true,enumerable:true,configurable:true});}
      }
    }
    if(event.type===3&&event.data.source===5){const input=event.data;if(!record.metadata.some(item=>item.nodeId===input.id)){
      this.metadataComplete=false;const node=this.nodes.get(input.id);if(node?.metadata){node.metadata=structuredClone(node.metadata);node.metadata.metadataComplete=false;node.metadata.properties.value={status:'missing',reason:'source-input-metadata-gap'};node.metadata.properties.checked={status:'missing',reason:'source-input-metadata-gap'};}
    }
    }
    for (const item of record.metadata) { const node = this.nodes.get(item.nodeId); if (node) node.metadata = this.metadata.get(item.nodeId); }
  }
  node(ref: HistoricalElementRef): SourceNode {
    const node = this.nodes.get(ref.nodeId), metadata = node?.metadata;
    if (!node || node.type !== 2) throw new EvidenceError('SOURCE_NODE_NOT_FOUND', 'The historical reference does not identify an element.', 404);
    if (!metadata) throw new EvidenceError('SOURCE_METADATA_GAP', 'Original source metadata is missing; replay attributes cannot substitute for it.', 409);
    if (metadata.frameId !== ref.frameId || metadata.mirrorScopeId !== ref.mirrorScopeId) throw new EvidenceError('SOURCE_SCOPE_MISMATCH', 'Node ID belongs to another frame or mirror scope.', 409);
    const { tagName, namespaceURI, documentUrl, baseURI, attributes, properties } = metadata;
    return { ref, tagName, namespaceURI, documentUrl, baseURI, attributes, properties,
      presentation: metadata.presentation ?? { status: 'missing', reason: 'no-source-presentation-observation' },
      text: { status: 'present', value: this.text(node) }, metadataComplete: this.metadataComplete && metadata.metadataComplete };
  }
  attribute(node: SourceTreeNode, name: string): SourceValue<string> {
    return node.metadata&&Object.hasOwn(node.metadata.attributes,name)?node.metadata.attributes[name]:(node.metadata?.metadataComplete ? { status: 'absent' } : { status: 'missing', reason: 'source-metadata-gap' });
  }
  private text(node: SourceTreeNode, depth = 0): string {
    if (depth > 512) this.fail('Source text exceeds depth budget');
    return node.type === 3 ? node.textContent : node.children.map(id => this.text(this.nodes.get(id)!, depth + 1)).join('');
  }
  scope(node: SourceTreeNode): SourceTreeNode[] {
    const metadata = node.metadata; if (!metadata) return [];
    return [...this.nodes.values()].filter(candidate => candidate.type === 2 && candidate.metadata?.rootId === metadata.rootId &&
      JSON.stringify(candidate.metadata.shadowHostIds) === JSON.stringify(metadata.shadowHostIds));
  }
}
