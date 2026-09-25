// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instrumentRrweb216ForSourcePrototype, prototypeLocators } from '@/capture/source-prototype';

describe('S0 source adapter failure boundaries', () => {
  it('patches exactly the installed serializer/mutation boundaries and refuses drift or double patching', async () => {
    const source = await readFile(new URL('rrweb.umd.cjs', import.meta.resolve('rrweb')), 'utf8');
    const patched = instrumentRrweb216ForSourcePrototype(source);
    expect(patched.match(/globalThis\.__besS0SourceHook\(/g)).toHaveLength(3);
    expect(() => instrumentRrweb216ForSourcePrototype(source.replace('onSerialize: (currentN) => {', 'changedSerializer: (currentN) => {'))).toThrow(/Unsupported rrweb distribution/);
    // Double-patching is rejected by the exact marker guard, before evaluation.
    expect(() => instrumentRrweb216ForSourcePrototype(patched)).toThrow(/already instrumented/);
  });

  it('validates quoted Unicode source href selectors on an independently built original document', () => {
    const doc = document.implementation.createHTMLDocument('independent original');
    doc.body.innerHTML = '<a></a><a href="/unrelated">Other</a>';
    const node = doc.querySelector('a')!;
    const href = `/订单/她说"it's"/42\\part`;
    node.setAttribute('href', href);
    const locators = prototypeLocators({ id: 7, type: 2, tagName: 'a', namespaceURI: node.namespaceURI, attributes: { href }, children: [] });
    expect([...doc.querySelectorAll(locators.css)]).toEqual([node]);
    const result = doc.evaluate(locators.xpath, doc, null, 7, null);
    expect(result.snapshotLength).toBe(1);
    expect(result.snapshotItem(0)).toBe(node);
    expect(() => prototypeLocators({ id: 8, type: 2, tagName: 'path', namespaceURI: 'http://www.w3.org/2000/svg', attributes: { href }, children: [] })).toThrow(/No supported original-source locator basis/);
  });
});
