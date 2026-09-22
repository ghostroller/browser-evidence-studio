/**
 * Ordinary Puppeteer workflow. No Electron, client API, AI or Node-side HTTP is
 * required by the business code. The reporter is an optional execution observer.
 */
export async function run({ page, input, reporter }) {
  const baseUrl = new URL(input.baseUrl).origin;
  const variant = input.variant ?? 'normal';
  const sourceRefs = [];
  const progress = async message => reporter?.progress(message);
  const checkpoint = async (key, details) => {
    const result = await reporter?.checkpoint(key, details);
    if (result?.id) sourceRefs.push(result.id);
    return result?.id;
  };
  const source = async (name, data) => {
    const artifact = await reporter?.attachArtifact(name, JSON.stringify(data, null, 2), 'application/json');
    if (artifact?.id) sourceRefs.push(artifact.id);
  };
  const requireHuman = async request => {
    if (!reporter?.requestHuman) throw new Error('This input requires explicit human assistance; supply a reporter with requestHuman or use standalone.mjs.');
    await reporter.requestHuman(request);
  };
  const assertNotAborted = () => reporter?.signal?.throwIfAborted();

  if (input.requireLogin) {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-status');
    const loggedIn = await page.$eval('#login-status', element => element.dataset.authenticated === 'true');
    if (!loggedIn) await requireHuman({
      id: 'login',
      instructions: '请在合成页面点击“模拟手机确认”；二维码过期时明确点击“刷新二维码”。页面显示已登录后交还控制。',
      timeoutMs: 120000,
      completionCheck: { selector: '#login-status[data-authenticated="true"]' },
    });
    // Human reply alone is not proof: check the server through the browser.
    const session = await page.evaluate(async () => fetch('/api/session').then(response => response.json()));
    await source('verified-session.json', session);
    if (!session.authenticated) throw new Error('The synthetic server has not confirmed login.');
  }

  await progress('Reading SSR and all API pages from the synthetic order site.');
  const firstResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === baseUrl && url.pathname === '/api/orders' && url.searchParams.get('page') === '1';
  });
  await page.goto(`${baseUrl}/orders?variant=${encodeURIComponent(variant)}`, { waitUntil: 'domcontentloaded' });
  const firstResponse = await firstResponsePromise;
  if (!firstResponse.ok()) throw new Error(`Order API returned ${firstResponse.status()}`);
  const ssr = await page.$eval('#ssr-data', element => JSON.parse(element.textContent));
  await source('ssr-orders.json', ssr);

  const rawPages = [];
  let current = await firstResponse.json();
  const ordersById = new Map();
  const duplicateIds = new Set();
  const overlapConflicts = [];
  let terminated = false;
  for (let expectedPage = 1; expectedPage <= 20; expectedPage++) {
    assertNotAborted();
    if (current.page !== expectedPage || !Array.isArray(current.items)) throw new Error('Pagination returned an unexpected page or body shape.');
    await page.waitForFunction(expected => window.__ordersResponse?.page === expected && document.querySelector('#api-state')?.textContent === '已就绪', {}, expectedPage);
    rawPages.push(current);
    await source(`api-page-${current.page}.json`, current);
    for (const item of current.items) {
      const prior = ordersById.get(item.id);
      if (prior) {
        duplicateIds.add(item.id);
        if (JSON.stringify(prior) !== JSON.stringify(item)) overlapConflicts.push(item.id);
      }
      ordersById.set(item.id, item);
    }
    if (current.hasNext === false) { terminated = true; break; }
    const nextResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === baseUrl && url.pathname === '/api/orders' && url.searchParams.get('page') === String(expectedPage + 1);
    });
    await page.click('#next');
    const nextResponse = await nextResponsePromise;
    if (!nextResponse.ok()) throw new Error(`Order API returned ${nextResponse.status()}`);
    current = await nextResponse.json();
  }
  const orders = [...ordersById.values()];
  const ssrMatches = ssr.items.every(ssrOrder => {
    const apiOrder = ordersById.get(ssrOrder.id);
    return apiOrder && ['title', 'amountCents', 'status'].every(field => apiOrder[field] === ssrOrder[field]);
  });
  await checkpoint('orders-complete', { title: '全部订单与分页终止', requirementIds: ['orders-complete'], description: `${rawPages.length} pages; ${orders.length} unique orders; observed hasNext=${current.hasNext}` });
  await reporter?.emitData('orders', orders, {
    sourceRefs: [...sourceRefs], origin: 'browser',
    pagination: { complete: terminated, pages: rawPages.length, terminalReason: terminated ? 'API hasNext=false' : 'Safety limit reached without terminal evidence' },
  });
  await reporter?.assertion({ requirementId: 'orders-complete', name: 'SSR/API overlap and duplicate consistency', verdict: ssrMatches && overlapConflicts.length === 0 ? 'pass' : 'fail', sourceRefs: [...sourceRefs], message: `SSR overlap matches=${ssrMatches}; duplicate IDs=${[...duplicateIds].join(',') || 'none'}; conflicting duplicate IDs=${overlapConflicts.join(',') || 'none'}` });
  await reporter?.assertion({ requirementId: 'orders-complete', name: 'Advertised total equals unique collected orders', verdict: terminated && orders.length === current.total ? 'pass' : 'fail', sourceRefs: [...sourceRefs], message: `Collected ${orders.length}, API total=${current.total}, terminated=${terminated}` });

  const details = [];
  for (const order of orders) {
    assertNotAborted();
    await page.goto(`${baseUrl}/orders/${encodeURIComponent(order.id)}?variant=${encodeURIComponent(variant)}`, { waitUntil: 'domcontentloaded' });
    const detail = await page.$eval('#detail-data', element => JSON.parse(element.textContent));
    // Detail branches have different requirements: only shipped orders need a tracking ID.
    detail.trackingRequired = detail.status === 'shipped';
    details.push(detail);
    await source(`detail-${order.id}.json`, detail);
  }
  await checkpoint('details-complete', { title: '订单详情、图片身份及物流分支', requirementIds: ['details-linked'] });
  await reporter?.emitData('details', details, { sourceRefs: [...sourceRefs], origin: 'browser' });
  await reporter?.assertion({ requirementId: 'details-linked', name: 'Shipped orders have tracking; paid orders have explicit null', verdict: details.every(detail => detail.trackingRequired ? typeof detail.trackingId === 'string' && detail.trackingId.startsWith('SYN-TRACK-') : detail.trackingId === null) ? 'pass' : 'fail', sourceRefs: [...sourceRefs] });

  if (input.requireHumanReview) {
    await page.goto(`${baseUrl}/review`, { waitUntil: 'domcontentloaded' });
    await requireHuman({ id: 'confirm-scope', instructions: '请审阅合成范围并点击页面“确认合成范围”，再交还控制。此确认不替代结构化数据断言。', timeoutMs: 120000, completionCheck: { selector: '#scope-status[data-confirmed="true"]' } });
    await checkpoint('human-scope-confirmed', { title: '人工确认范围', description: 'This confirmation is separate from machine data assertions.' });
  }

  await progress(`Collected ${orders.length} unique orders and ${details.length} detail records.`);
  return { orders, details, pagination: { pages: rawPages.length, complete: terminated, expectedTotal: current.total }, duplicateIds: [...duplicateIds] };
}
