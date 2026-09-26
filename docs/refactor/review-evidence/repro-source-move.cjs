// Minimal extraction of SourceModel's restore/remove/apply logic at
// f55e015, src/replay/source-model.ts. Type annotations and unrelated read
// helpers removed; execution order is unchanged. This is not an Electron test.
const assert = require('node:assert/strict');
class SourceModel {
  nodes = new Map(); metadata = new Map(); metadataComplete = true;
  constructor(records) { for (const record of records) this.apply(record); if (this.rootId === undefined) this.fail('No source full snapshot'); }
  fail(reason) { throw new Error(reason); }
  restore(input, parentId, depth = 0) {
    if (depth > 512 || this.nodes.size >= 100_000) this.fail('Source structure exceeds bounded node/depth budget');
    if (this.nodes.has(input.id)) this.fail(`Duplicate source node ${input.id}`);
    const node = { id: input.id, type: input.type, parentId, isShadow: 'isShadow' in input && input.isShadow === true,
      children: [], textContent: 'textContent' in input ? input.textContent : '', metadata: this.metadata.get(input.id) };
    this.nodes.set(input.id, node);
    if (input.type === 2 && !node.metadata) this.metadataComplete = false;
    if ('childNodes' in input) node.children = input.childNodes.map(child => this.restore(child, input.id, depth + 1));
    return input.id;
  }
  remove(id) {
    const node = this.nodes.get(id); if (!node) this.fail(`Missing source removal ${id}`);
    for (const child of node.children) this.remove(child);
    const parent = node.parentId === undefined ? undefined : this.nodes.get(node.parentId);
    if (parent) parent.children = parent.children.filter(child => child !== id);
    this.nodes.delete(id); this.metadata.delete(id);
  }
  apply(record) {
    const event = record.event;
    if (event.type === 2) { this.nodes.clear(); this.metadata.clear(); this.metadataComplete = record.metadataComplete; }
    if (!record.metadataComplete) this.metadataComplete = false;
    for (const item of record.metadata) this.metadata.set(item.nodeId, structuredClone(item));
    if (event.type === 2) this.rootId = this.restore(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      for (const change of event.data.removes) this.remove(change.id);
      let waiting = [...event.data.adds];
      while (waiting.length) {
        const next = [];
        for (const addition of waiting) {
          const parent = this.nodes.get(addition.parentId);
          if (!parent || addition.nextId !== null && !parent.children.includes(addition.nextId)) { next.push(addition); continue; }
          const at = addition.nextId === null ? parent.children.length : parent.children.indexOf(addition.nextId);
          if (this.nodes.has(addition.node.id)) this.remove(addition.node.id);
          parent.children.splice(at, 0, this.restore(addition.node, parent.id));
        }
        if (next.length === waiting.length) this.fail('Unresolved parent or sibling in source mutation');
        waiting = next;
      }
      for (const change of event.data.texts) {
        const node = this.nodes.get(change.id); if (!node) this.fail(`Missing source text node ${change.id}`);
        node.textContent = change.value ?? '';
      }
      for (const change of event.data.attributes) if (!record.metadata.some(item => item.nodeId === change.id)) {
        this.metadataComplete = false; const node=this.nodes.get(change.id);
        if(node?.metadata){node.metadata=structuredClone(node.metadata);node.metadata.metadataComplete=false;for(const name of Object.keys(change.attributes))Object.defineProperty(node.metadata.attributes,name,{value:{status:'missing',reason:'source-attribute-mutation-metadata-gap'},writable:true,enumerable:true,configurable:true});}
      }
    }
    if(event.type===3&&event.data.source===5){const input=event.data;if(!record.metadata.some(item=>item.nodeId===input.id)){
      this.metadataComplete=false;const node=this.nodes.get(input.id);if(node?.metadata){node.metadata=structuredClone(node.metadata);node.metadata.metadataComplete=false;node.metadata.properties.value={status:'missing',reason:'source-input-metadata-gap'};node.metadata.properties.checked={status:'missing',reason:'source-input-metadata-gap'};}
    }}
    for (const item of record.metadata) { const node = this.nodes.get(item.nodeId); if (node) node.metadata = this.metadata.get(item.nodeId); }
  }
}
const el = (id, children=[]) => ({ id, type:2, tagName:'div', attributes:{}, childNodes:children });
const meta = id => ({ nodeId:id, rootId:0, frameId:'top', mirrorScopeId:'s', shadowHostIds:[], tagName:'div', attributes:{id:{status:'present',value:'n'+id}}, properties:{}, metadataComplete:true });
const full = { metadataComplete:true, metadata:[1,2,3,4].map(meta), event:{type:2,data:{node:{id:0,type:0,childNodes:[el(1,[el(2,[el(4)]),el(3)])]}}} };
const moved = { metadataComplete:true, metadata:[meta(4)], event:{type:3,data:{source:0,removes:[{parentId:2,id:4}],adds:[{parentId:3,nextId:null,node:el(4)}],texts:[],attributes:[]}} };
const before=new SourceModel([full]);
assert.ok(before.nodes.get(4).metadata);
const after=new SourceModel([full,moved]);
assert.equal(after.nodes.get(4).parentId,3);
assert.equal(after.nodes.get(4).metadata,undefined);
assert.equal(after.metadataComplete,false);
console.log(JSON.stringify({test:'same-batch remove/add retains node but loses supplied source metadata',beforeMetadata:!!before.nodes.get(4).metadata,afterParent:after.nodes.get(4).parentId,afterMetadata:!!after.nodes.get(4).metadata,metadataComplete:after.metadataComplete,result:'BUG REPRODUCED in extracted logic; production recorder/desktop coverage still required'},null,2));
