import { expect, test } from 'vitest';
import { materializeReplayEvents } from '@/replay/materialize';
import { rewriteReplayEvent } from '@/resources/replay-event-rewrite';
const key = 'bes-inline:11111111-1111-1111-1111-111111111111:1';
test('inline materialization changes resource uses and CSS URLs but preserves business text, attributes and CSS literals', () => {
  const event: any = { type: 2, timestamp: 1, data: { node: { type: 0, id: 0, childNodes: [
    { type: 2, id: 1, tagName: 'div', attributes: { title: key, 'data-value': key }, childNodes: [{ type: 3, id: 2, textContent: `Literal ${key}` }] },
    { type: 2, id: 3, tagName: 'img', attributes: { src: key }, childNodes: [] },
    { type: 2, id: 4, tagName: 'style', attributes: {}, childNodes: [{ type: 3, id: 5, textContent: `.a{content:"${key}";background:url("${key}")}` }] },
  ] } } };
  const mutation: any = { type: 3, timestamp: 2, data: { source: 0, adds: [], removes: [], attributes: [{ id: 3, attributes: { src: key } }], texts: [{ id: 5, value: `.a{content:"${key}";background:url("${key}")}` }, { id: 2, value: key }] } };
  const output: any[] = materializeReplayEvents([event, mutation], value => value === key ? 'blob:verified' : value, rewriteReplayEvent);
  const nodes = output[0].data.node.childNodes;
  expect(nodes[0].attributes.title).toBe(key); expect(nodes[0].attributes['data-value']).toBe(key); expect(nodes[0].childNodes[0].textContent).toBe(`Literal ${key}`);
  expect(nodes[1].attributes.src).toBe('blob:verified'); expect(nodes[2].childNodes[0].textContent).toContain(`content:"${key}"`); expect(nodes[2].childNodes[0].textContent).toContain('url("blob:verified")');
  expect(output[1].data.attributes[0].attributes.src).toBe('blob:verified'); expect(output[1].data.texts[1].value).toBe(key); expect(output[1].data.texts[0].value).toContain('url("blob:verified")');
  expect(event.data.node.childNodes[1].attributes.src).toBe(key);
});
