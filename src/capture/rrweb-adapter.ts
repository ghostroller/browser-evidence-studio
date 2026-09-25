import { createHash } from 'node:crypto';

export const RRWEB_ADAPTER_VERSION = '2.1.6-source-v1';
export const RRWEB_216_SHA256 = 'a95ac410da31a007385cc6df5ae2446af4cb5eff397d3cc6fe0574c3bee957e4';

/** Narrow, fail-closed hooks in the pinned upstream distribution. No node_modules
 * edits and no second MutationObserver. The hook observes the same Mirror IDs
 * and serialization/mutation boundaries as rrweb. Upstream equivalent: expose
 * onSerialize and pre-transform attribute hooks in record options. */
export function instrumentRecorder(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== RRWEB_216_SHA256) throw new Error('Unverified rrweb recorder distribution');
  for (const [before, after] of [
    ['onSerialize: (currentN) => {', 'onSerialize: (currentN) => { globalThis.__besSourceHook(currentN, this.mirror);'],
    ['onSerialize: (n2) => {', 'onSerialize: (n2) => { globalThis.__besSourceHook(n2, mirror);'],
    ['let item = this.attributeMap.get(m.target);', 'globalThis.__besSourceHook(m.target, this.mirror); let item = this.attributeMap.get(m.target);'],
  ]) {
    if (source.split(before).length !== 2) throw new Error('rrweb source hook boundary changed');
    source = source.replace(before, after);
  }
  return source;
}
