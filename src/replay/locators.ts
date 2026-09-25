import type { HistoricalElementRef, LocatorCandidate } from '@/contracts/recording';
import { SourceModel, type SourceTreeNode } from './source-model';

/** CSS string serialization (not an identifier) and XPath 1.0 string literals. */
export function cssString(value: string): string { return '"' + value.replace(/[\0-\x1f\x7f"\\]/g, char => char === '"' || char === '\\' ? '\\' + char : '\\' + char.charCodeAt(0).toString(16) + ' ') + '"'; }
export function xpathString(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map(part => `'${part}'`).join(`,"'",`)})`;
}
function value(node: SourceTreeNode, key: string): string | undefined { const v = node.metadata?.attributes[key]; return v?.status === 'present' ? v.value : undefined; }
function tagXPath(node: SourceTreeNode): string {
  const metadata=node.metadata!;
  return metadata.namespaceURI==='http://www.w3.org/1999/xhtml'&&/^[a-z][a-z0-9-]*$/.test(metadata.tagName)?metadata.tagName:`*[local-name()=${xpathString(metadata.tagName)} and namespace-uri()=${xpathString(metadata.namespaceURI ?? '')}]`;
}

/** Candidate predicates below are restricted to the expressions we generate;
 * matching uses the original source tree and reports actual target identity.
 * Independent browser query verification is covered by the synthetic tests. */
export function sourceLocators(model: SourceModel, ref: HistoricalElementRef): LocatorCandidate[] {
  const selected = model.node(ref), node = model.nodes.get(ref.nodeId)!;
  if (!selected.metadataComplete) return [{ source: ref, steps: [], historical: { status: 'unavailable', matchCount: 0, matchesTarget: false, reason: 'source-metadata-gap' }, live: { status: 'not-live-checked' }, warnings: ['Original source metadata is incomplete.'] }];
  const scope = model.scope(node), candidates: LocatorCandidate[] = [];
  function targetSteps(strategy: 'css' | 'xpath', expression: string): LocatorCandidate['steps'] {
    const steps: LocatorCandidate['steps'] = [];
    const parents: SourceTreeNode[] = [];
    let current = node;
    while (current.metadata?.frameHostId !== undefined) {
      const host = model.nodes.get(current.metadata.frameHostId); if (!host?.metadata) break;
      parents.unshift(host); current = host;
    }
    for (const host of parents) steps.push({ kind: 'frame', strategy: 'css', expression: structuralCss(model, host) });
    for (const hostId of node.metadata!.shadowHostIds) {
      const host = model.nodes.get(hostId); if (host?.metadata) steps.push({ kind: 'shadow', strategy: 'css', expression: structuralCss(model, host) });
    }
    steps.push({ kind: 'target', strategy, expression }); return steps;
  }
  function add(strategy: 'css' | 'xpath', expression: string, matches: SourceTreeNode[], warnings: string[] = []): void {
    const matchesTarget = matches.some(item => item.id === node.id);
    candidates.push({ source: ref, steps: targetSteps(strategy, expression), historical: { status: matches.length === 1 && matchesTarget ? 'historical-unique' : matches.length ? 'historical-ambiguous' : 'invalid', matchCount: matches.length, matchesTarget }, live: { status: 'not-live-checked' }, warnings });
  }
  for (const name of ['id', 'data-testid', 'data-key', 'name', 'aria-label', 'href', 'class']) {
    const original = value(node, name); if (original === undefined || !original) continue;
    const matches = scope.filter(item => value(item, name) === original);
    const warnings = name === 'class' ? ['Class names may depend on transient rendering state.'] : [];
    add('css', `[${name}=${cssString(original)}]`, matches, warnings);
    if(!node.metadata!.shadowHostIds.length)add('xpath', `.//*[@${name}=${xpathString(original)}]`, matches, warnings);
  }
  const cssPath=structuralCss(model,node);
  add('css', cssPath, queryStructuralCss(model,node,cssPath), ['Depends on recorded element order.']);
  const chain: SourceTreeNode[] = []; let cursor: SourceTreeNode | undefined = node;
  while (cursor?.metadata && cursor.metadata.rootId === node.metadata!.rootId && JSON.stringify(cursor.metadata.shadowHostIds) === JSON.stringify(node.metadata!.shadowHostIds)) {
    chain.unshift(cursor); cursor = cursor.parentId === undefined ? undefined : model.nodes.get(cursor.parentId);
  }
  const xpath = './' + chain.map(item => {
    const siblings = item.parentId === undefined ? [item] : model.nodes.get(item.parentId)!.children.map(id => model.nodes.get(id)!).filter(sibling => sibling.type === 2 && sibling.metadata?.tagName === item.metadata!.tagName && sibling.metadata?.namespaceURI === item.metadata!.namespaceURI && sibling.isShadow === item.isShadow);
    return `${tagXPath(item)}[${siblings.findIndex(sibling => sibling.id === item.id) + 1}]`;
  }).join('/');
  if(!node.metadata!.shadowHostIds.length)add('xpath', xpath, queryStructuralXPath(model,node,chain), ['Depends on recorded sibling order; evaluate relative to its document.']);
  return candidates;
}
function scopeChildren(model:SourceModel,node:SourceTreeNode):SourceTreeNode[]{
  const metadata=node.metadata!,root=model.nodes.get(metadata.shadowHostIds.at(-1)??metadata.rootId);
  return root?.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&item.isShadow===!!metadata.shadowHostIds.length)??[];
}
function queryStructuralCss(model:SourceModel,node:SourceTreeNode,expression:string):SourceTreeNode[]{
  let current=scopeChildren(model,node);
  const parts=expression.split(' > ');
  for(let index=0;index<parts.length;index++){
    const match=/^\*:nth-child\(([1-9][0-9]*)\)$/.exec(parts[index]);if(!match)return[];
    current=current.filter(candidate=>{
      const siblings=candidate.parentId===undefined?[candidate]:model.nodes.get(candidate.parentId)!.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&item.isShadow===candidate.isShadow);
      return siblings.indexOf(candidate)+1===Number(match[1]);
    });
    if(index<parts.length-1)current=current.flatMap(parent=>parent.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&!item.isShadow));
  }
  return current;
}
function queryStructuralXPath(model:SourceModel,node:SourceTreeNode,chain:SourceTreeNode[]):SourceTreeNode[]{
  let current=scopeChildren(model,node);
  for(let index=0;index<chain.length;index++){
    const expected=chain[index],metadata=expected.metadata!;
    const siblings=expected.parentId===undefined?[expected]:model.nodes.get(expected.parentId)!.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&item.metadata?.tagName===metadata.tagName&&item.metadata?.namespaceURI===metadata.namespaceURI&&item.isShadow===expected.isShadow);
    const position=siblings.indexOf(expected)+1;
    current=current.filter(candidate=>candidate.metadata?.tagName===metadata.tagName&&candidate.metadata.namespaceURI===metadata.namespaceURI).filter(candidate=>{
      const matches=candidate.parentId===undefined?[candidate]:model.nodes.get(candidate.parentId)!.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&item.metadata?.tagName===metadata.tagName&&item.metadata?.namespaceURI===metadata.namespaceURI&&item.isShadow===candidate.isShadow);
      return matches.indexOf(candidate)+1===position;
    });
    if(index<chain.length-1)current=current.flatMap(parent=>parent.children.map(id=>model.nodes.get(id)!).filter(item=>item.type===2&&!item.isShadow));
  }
  return current;
}
function structuralCss(model: SourceModel, node: SourceTreeNode): string {
  const parts: string[] = []; let current: SourceTreeNode | undefined = node;
  while (current?.metadata && current.metadata.rootId === node.metadata!.rootId && JSON.stringify(current.metadata.shadowHostIds) === JSON.stringify(node.metadata!.shadowHostIds)) {
    const parent: SourceTreeNode | undefined = current.parentId === undefined ? undefined : model.nodes.get(current.parentId);
    const siblings: SourceTreeNode[] = parent ? parent.children.map(id => model.nodes.get(id)!).filter(item => item.type === 2 && item.isShadow === current!.isShadow) : [current];
    parts.unshift(`*:nth-child(${siblings.findIndex(item => item.id === current!.id) + 1})`); current = parent;
  }
  return parts.join(' > ');
}
