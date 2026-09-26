import assert from 'node:assert/strict';
import { test } from 'vitest';
import { JSDOM } from 'jsdom';
import { redactHtml, snapshotElements } from '@/capture/privacy';
import { captureCheckpointMaterials } from '@/capture/checkpoint';

test('checkpoint DOM removes marked, form, token, and embedded frame sentinels but keeps public text', async () => {
  const html = '<!doctype html><html><body>' +
    '<h1 class="rr-mask" aria-label="secret-label">secret-heading</h1>' +
    '<section class="rr-block" data-token="secret-token"><p>secret-block</p></section>' +
    '<input value="secret-input"><textarea>secret-textarea</textarea>' +
    '<iframe srcdoc="&lt;h1 class=rr-mask&gt;secret-frame&lt;/h1&gt;"></iframe>' +
    '<script>window.bootstrapSecret="secret-inline-script"</script>' +
    '<h2>public-heading</h2></body></html>';
  const result = await captureCheckpointMaterials({
    screenshot: async () => new Uint8Array([137, 80, 78, 71]), dom: async () => html, timeoutMs: 1000,
  });
  const stored = String(result.materials[1].data);
  for (const sentinel of ['secret-heading', 'secret-label', 'secret-token', 'secret-block', 'secret-input', 'secret-textarea', 'secret-frame', 'secret-inline-script']) {
    assert.ok(!stored.includes(sentinel), `${sentinel} leaked from checkpoint DOM`);
  }
  assert.ok(stored.includes('public-heading'));
  assert.equal(result.materials[1].captureStatus, 'complete');
  assert.equal(result.materials[0].captureStatus, 'complete');
  assert.deepEqual(result.materials[0].metadata?.capturePrivacy, { policy: 'bes-capture-privacy-v1', access: 'restricted', reason: 'unredacted-pixels' });
  assert.deepEqual(result.materials[1].metadata?.capturePrivacy, { policy: 'bes-capture-privacy-v1', representation: 'redacted-dom' });
  assert.equal(redactHtml(html).redacted, true);
});

test('live snapshot does not read marked descendants, form properties, or shadow secrets', () => {
  const dom = new JSDOM('<!doctype html><body>' +
    '<h1 class="rr-mask" aria-label="secret-label">secret-heading</h1>' +
    '<section class="rr-block"><h2>secret-block</h2></section>' +
    '<button id="mixed">public-part<span class="rr-mask">secret-child</span></button>' +
    '<input value="secret-input" aria-label="public input">' +
    '<h2 id="public">public-heading</h2>' +
    '<a href="/safe" aria-label="https://private.invalid/?access_token=secret-url">safe link</a>');
  const host = dom.window.document.createElement('div');
  host.className = 'rr-mask';
  host.attachShadow({ mode: 'open' }).innerHTML = '<h1>secret-shadow</h1>';
  dom.window.document.body.append(host);
  const elements = snapshotElements(dom.window.document);
  const serialized = JSON.stringify(elements);
  for (const sentinel of ['secret-heading', 'secret-label', 'secret-block', 'secret-child', 'secret-input', 'secret-shadow', 'secret-url']) {
    assert.ok(!serialized.includes(sentinel), `${sentinel} leaked from live snapshot`);
  }
  assert.ok(serialized.includes('public-heading'));
  assert.ok(serialized.includes('public input'));
  dom.window.close();
});
