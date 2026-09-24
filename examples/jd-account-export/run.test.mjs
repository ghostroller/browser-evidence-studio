import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { validateExecution } from '../../src/runner/validation.ts';
import { run } from './run.mjs';

const manifest = JSON.parse(await readFile(new URL('./workflow.json', import.meta.url), 'utf8'));
const year = new Date().getFullYear();
const input = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
const datasetNames = ['profile', 'identity', 'addresses', 'orders', 'details', 'deletedOrders'];

// This double supplies only synthetic values at Puppeteer's read/navigation
// boundary. It tests workflow reporting and failure propagation, not DOM parsers
// or live JD compatibility. No URL is fetched and no browser is launched.
class SyntheticPage {
  currentUrl = 'about:blank';
  detailVisits = 0;
  orderReads = 0;
  loginConfirmed = true;
  constructor(failAt, paginationLimit = false) {
    this.failAt = failAt;
    this.paginationLimit = paginationLimit;
  }
  url() { return this.currentUrl; }
  async goto(url) {
    const pathname = new URL(url).pathname;
    if (pathname === '/center/list.action') {
      if (this.failAt === 'orders') throw new Error('Synthetic orders navigation failure');
      this.orderReads = 0;
    }
    if (pathname.startsWith('/synthetic/detail/')) {
      this.detailVisits++;
      if (this.failAt === 'details' && this.detailVisits === 2) throw new Error('Synthetic second detail navigation failure');
    }
    this.currentUrl = url;
  }
  async waitForFunction() { return true; }
  async evaluate(_reader, argument) {
    if (Array.isArray(argument)) {
      if (argument.includes('账户安全')) return 'https://i.jd.com/synthetic/security';
      if (argument.includes('收货地址')) return 'https://i.jd.com/synthetic/addresses';
      if (argument.includes('订单回收站')) return 'https://order.jd.com/synthetic/recycle';
      throw new Error('Unexpected synthetic link request');
    }
    if (argument && typeof argument === 'object') {
      const fields = {
        userId: 'synthetic-user', loginName: 'synthetic-login', nickname: '合成昵称', gender: '保密',
        birthYear: '2000', birthMonth: '1', birthDay: '2', email: 'synthetic@example.invalid',
        realName: '合*', boundPhone: '138****0000',
      };
      return Object.fromEntries(Object.keys(argument).map(key => [key, fields[key] ?? null]));
    }
    const pathname = new URL(this.currentUrl).pathname;
    if (!this.loginConfirmed && (pathname === '/uc/login' || pathname === '/user/info')) return false;
    if (pathname === '/uc/login') return true;
    if (pathname === '/user/info') return '保密';
    if (pathname === '/synthetic/addresses') return [{
      addressOrdinal: 1, isDefault: true, recipient: '合成收件人', region: '合成地区', streetAddress: '合成地址',
      mobile: '138****0000', telephone: '000-0000000', email: 'synthetic@example.invalid',
    }];
    if (pathname === '/center/list.action') {
      if (this.orderReads++ === 0) return true; // Visible current-year filter.
      return { exists: true, disabled: !this.paginationLimit, href: null };
    }
    if (pathname.startsWith('/synthetic/detail/')) return {
      recipient: '合成收件人', mobile: '138****0000', telephone: null, email: null,
      region: '合成地区', streetAddress: '合成地址', detailPageRecognized: true,
    };
    if (pathname === '/synthetic/recycle') {
      if (this.failAt === 'recycle') throw new Error('Synthetic recycle read failure');
      return { emptyText: true, records: [] };
    }
    throw new Error(`Unexpected synthetic read at ${pathname}`);
  }
  async $$eval(selector) {
    assert.equal(selector, '[class*="orderCard-"]');
    return ['SYN-001', 'SYN-002'].map(orderId => ({
      orderId, placedAt: `${year}-01-02`, items: [{ title: '合成商品', imageUrl: 'https://img.jd.com/synthetic.png' }],
      shopName: '合成商店', shippingSummary: '合成收件地址', status: '已完成', amount: 12.34, currency: 'CNY',
      paymentType: '在线支付', detailHref: `https://order.jd.com/synthetic/detail/${orderId}`,
    }));
  }
}

async function executeSynthetic(failAt, paginationLimit = false) {
  const datasets = [], checkpoints = [], assertions = [];
  const page = new SyntheticPage(failAt, paginationLimit);
  const reporter = {
    async checkpoint(key) {
      if (key === 'collection-complete' && failAt === 'final-checkpoint') throw new Error('Synthetic final checkpoint failure');
      const checkpoint = { id: `synthetic-cp-${checkpoints.length + 1}`, key };
      checkpoints.push(checkpoint);
      return { id: checkpoint.id };
    },
    async emitData(name, records, provenance) {
      // Acknowledgement is asynchronous, as in the real reporter. The workflow
      // must await it before moving on to another potentially failing stage.
      await setImmediate();
      if (name === 'details' && failAt === 'details') throw new Error('Synthetic details emission failure');
      assert(!datasets.some(dataset => dataset.name === name), `Dataset ${name} was emitted twice`);
      assert(provenance.sourceRefs.length > 0);
      assert(provenance.sourceRefs.every(id => checkpoints.some(checkpoint => checkpoint.id === id)));
      datasets.push(structuredClone({ name, records, ...provenance }));
    },
    async assertion(value) { assertions.push(structuredClone(value)); },
    async progress() {},
  };
  let execution = 'completed', output, error;
  try { output = await run({ page, input: { ...input, ...(paginationLimit ? { maxPages: 1 } : {}) }, reporter }); }
  catch (cause) { execution = 'failed'; error = cause; }
  const fingerprint = { sha256: 'synthetic-unchanged', dependencyLockSha256: 'synthetic-lock', files: [] };
  const validation = validateExecution({ manifest, execution, checkpoints, datasets, assertions,
    fingerprintBefore: fingerprint, fingerprintAfter: fingerprint, knownSourceRefs: checkpoints.map(checkpoint => checkpoint.id) });
  return { page, execution, output, error, datasets, checkpoints, assertions, validation };
}

for (const [failAt, retained] of [['orders', 3], ['details', 4], ['recycle', 5], ['final-checkpoint', 6]]) {
  test(`completed datasets survive a later ${failAt} failure without accepting the execution`, async () => {
    const result = await executeSynthetic(failAt);
    assert.equal(result.execution, 'failed');
    assert.match(result.error?.message ?? '', /^Synthetic .+ failure$/);
    assert.equal(result.output, undefined, 'A failed stage cannot produce a completed workflow output');
    assert.equal(result.validation.executionVerdict, 'fail');
    assert.equal(result.validation.overall, 'fail');
    assert.deepEqual(result.datasets.map(dataset => dataset.name), datasetNames.slice(0, retained));
    assert.deepEqual([...new Set(result.assertions.map(assertion => assertion.requirementId))],
      ['profile-complete', 'identity-complete', 'addresses-complete', 'orders-complete', 'details-complete', 'deleted-orders-complete'].slice(0, retained));
    assert.equal(result.datasets.find(dataset => dataset.name === 'identity').records[0].boundPhone, '138****0000');
    assert.equal(result.checkpoints.some(checkpoint => checkpoint.key === 'collection-complete'), false);
    if (failAt === 'details') {
      assert.equal(result.page.detailVisits, 0, 'List-derived summaries do not visit detail pages');
      assert.equal(result.checkpoints.filter(checkpoint => checkpoint.key === 'orders-list-page').length, 1);
      assert.equal(result.datasets.some(dataset => dataset.name === 'details'), false, 'An unacknowledged detail dataset is not counted as completed');
    }
    if (failAt === 'recycle') {
      assert(result.checkpoints.some(checkpoint => checkpoint.key === 'deleted-orders-complete'));
      assert.equal(result.datasets.some(dataset => dataset.name === 'deletedOrders'), false, 'A checkpoint alone does not prove an empty recycle bin');
    }
  });
}

test('successful staged reporting retains existing provenance, fields and pagination semantics', async () => {
  const result = await executeSynthetic();
  assert.equal(result.error, undefined);
  assert.equal(result.validation.overall, 'pass');
  assert.deepEqual(result.datasets.map(dataset => dataset.name), datasetNames);
  const orders = result.datasets.find(dataset => dataset.name === 'orders');
  assert.deepEqual(orders.pagination, { complete: true, pages: 1, terminalReason: 'Visible disabled next control or explicit empty list for each selected year' });
  assert(orders.records.every(record => !Object.hasOwn(record, 'detailHref') && !Object.hasOwn(record, 'listUrl')));
  const details = result.datasets.find(dataset => dataset.name === 'details');
  assert.equal(details.origin, 'derived');
  assert(details.records.every(record => record.orderId === record.sourceOrderId && record.sourceCheckpointId && record.detailSource === 'orders-list-derived'));
  assert.equal(result.page.detailVisits, 0);
  assert.deepEqual(result.datasets.find(dataset => dataset.name === 'deletedOrders').records, []);
  assert.equal(result.output.deletedOrdersState, 'explicit-empty');
});

test('a pagination safety limit still reports an incomplete dataset and fails acceptance', async () => {
  const result = await executeSynthetic(undefined, true);
  assert.equal(result.execution, 'completed');
  assert.equal(result.validation.overall, 'fail');
  assert.deepEqual(result.datasets.find(dataset => dataset.name === 'orders').pagination,
    { complete: false, pages: 1, terminalReason: 'Pagination safety limit reached without terminal evidence' });
  assert.equal(result.output.pagination.complete, false);
});

test('all QR retries use declared human handoff points and verify authentication after return', async () => {
  const page = new SyntheticPage();
  page.loginConfirmed = false;
  const requested = [];
  await run({ page, input, reporter: {
    async progress() {},
    async emitData() {},
    async assertion() {},
    async requestHuman({ id }) {
      requested.push(id);
      page.loginConfirmed = requested.length === 3;
    },
  } });
  assert.deepEqual(requested, ['jd-login', 'jd-login-retry-2', 'jd-login-retry-3']);
  assert(requested.every(id => manifest.humanPoints.some(point => point.id === id)));
});
