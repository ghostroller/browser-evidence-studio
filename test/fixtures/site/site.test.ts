import { test } from 'vitest';
import assert from 'node:assert/strict';
import { startFixture } from './index';

test('synthetic fixture has complete pagination, deliberate faults, body boundaries and real login expiry', async () => {
  const fixture = await startFixture({ qrTtlMs: 60 });
  try {
    const pages = await Promise.all([1, 2, 3].map(page => fetch(`${fixture.url}/api/orders?page=${page}`).then(response => response.json())));
    assert.deepEqual(pages.map(page => page.items.length), [3, 3, 1]);
    assert.deepEqual(pages.map(page => page.hasNext), [true, true, false]);
    assert.equal(new Set(pages.flatMap(page => page.items.map((order: { id: string }) => order.id))).size, 7);
    const duplicate = await fetch(`${fixture.url}/api/orders?page=2&variant=duplicate`).then(response => response.json());
    assert.equal(duplicate.items[0].id, pages[0].items[2].id);
    const missing = await fetch(`${fixture.url}/api/orders?page=2&variant=missing`).then(response => response.json());
    assert.equal(Object.hasOwn(missing.items[0], 'title'), false);
    const wrong = await fetch(`${fixture.url}/api/orders/SYN-004?variant=wrong-image`).then(response => response.json());
    assert.notEqual(wrong.id, wrong.imageOrderId);
    for (const bytes of [1024 * 1024, 9 * 1024 * 1024]) {
      const body = await fetch(`${fixture.url}/api/large?bytes=${bytes}`).then(response => response.text());
      assert.equal(Buffer.byteLength(body), bytes);
      assert.equal(JSON.parse(body).tailMarker, 'END');
    }
    assert.equal(await fetch(`${fixture.url}/empty`).then(response => response.text()), '');
    await assert.rejects(fetch(`${fixture.url}/fail`).then(response => response.text()));
    const start = await fetch(`${fixture.url}/api/login/start`, { method: 'POST' }).then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 100));
    const expired = await fetch(`${fixture.url}/api/login/confirm`, { method: 'POST', body: JSON.stringify({ nonce: start.nonce }) });
    assert.equal(expired.status, 409);
    assert.equal((await fetch(`${fixture.url}/api/session`).then(response => response.json())).authenticated, false);
    const fresh = await fetch(`${fixture.url}/api/login/start`, { method: 'POST' }).then(response => response.json());
    const confirmation = await fetch(`${fixture.url}/api/login/confirm`, { method: 'POST', body: JSON.stringify({ nonce: fresh.nonce }) });
    assert.equal(confirmation.status, 200);
    const cookie = confirmation.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${fixture.url}/api/session`, { headers: { cookie } }).then(response => response.json())).authenticated, true);
  } finally { await fixture.close(); }
});
