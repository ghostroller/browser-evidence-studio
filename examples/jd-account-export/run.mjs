/**
 * JD account evidence workflow. It reads rendered page content with ordinary
 * Puppeteer only; the Studio reporter is optional and does not drive the site.
 */
const LOGIN_URL = 'https://passport.jd.com/uc/login'; // dedicated login page observed in the supplied run
const PROFILE_URL = 'https://i.jd.com/user/info'; // observed as the personal-information link in the supplied run
const ORDER_CENTER_URL = 'https://order.jd.com/center/list.action'; // observed in the supplied run
const WAIT_MS = 20_000;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_HANDOFF_TIMEOUT_MS = 600_000;
const LABELS = {
  address: ['收货地址', '地址管理'],
  recycle: ['订单回收站'],
};

const present = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0);
const sourceRefs = [];

async function progress(reporter, message) { await reporter?.progress(message); }
function checkAbort(reporter) { reporter?.signal?.throwIfAborted(); }

async function checkpoint(reporter, key, title, description, requirementIds = []) {
  if (!reporter?.checkpoint) return undefined;
  const result = await reporter.checkpoint(key, { title, description, requirementIds });
  if (result?.id) sourceRefs.push(result.id);
  return result?.id;
}

async function assertion(reporter, requirementId, name, ok, message, refs = sourceRefs.slice(-128)) {
  await reporter?.assertion({
    requirementId,
    name,
    verdict: ok ? 'pass' : 'fail',
    sourceRefs: refs.slice(0, 128),
    message,
  });
  return ok;
}

function allowedJdUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'jd.com' || url.hostname.endsWith('.jd.com'));
  } catch { return false; }
}

async function visibleLink(page, terms) {
  return page.evaluate((needles) => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const anchors = [...document.querySelectorAll('a[href]')].filter(isVisible);
    const matches = anchors.map(anchor => ({ anchor, text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter(item => item.text && needles.some(term => item.text.includes(term)))
      .sort((a, b) => a.text.length - b.text.length);
    return matches[0]?.anchor.href || null;
  }, terms);
}

async function hoverVisibleText(page, terms) {
  const handle = await page.evaluateHandle((needles) => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll('a[href],button,[role="button"],[tabindex]')]
      .filter(isVisible)
      .map(element => ({ element, text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter(item => item.text && needles.some(term => item.text.includes(term)))
      .sort((a, b) => a.text.length - b.text.length)[0]?.element || null;
  }, terms);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); return false; }
  await element.hover().catch(() => {});
  await handle.dispose();
  await new Promise(resolve => setTimeout(resolve, 250));
  return true;
}

async function navigateViaVisibleLink(page, terms, { required = true } = {}) {
  let href = await visibleLink(page, terms);
  if (!href) {
    await hoverVisibleText(page, ['我的京东', ...terms]);
    href = await visibleLink(page, terms);
  }
  if (!href || !allowedJdUrl(href)) {
    if (!required) return false;
    throw new Error('A required JD navigation link was not found in the visible page.');
  }
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await waitForReady(page);
  return true;
}

async function clickVisibleControl(page, terms, complete) {
  const beforeUrl = page.url();
  const handle = await page.evaluateHandle(needles => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll('button,[role="button"],[tabindex],span,div')]
      .filter(visible)
      .map(element => ({ element, text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter(item => item.text && needles.some(term => item.text.includes(term)))
      .sort((a, b) => a.text.length - b.text.length)[0]?.element || null;
  }, terms);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); throw new Error('A required visible JD page control was not found.'); }
  const completion = page.waitForFunction(previousUrl =>
    location.href !== previousUrl || !!document.querySelector('table.td-void.order-tb') ||
    (document.body.innerText || '').includes('回收站暂时没有订单'), { timeout: WAIT_MS }, beforeUrl).catch(() => null);
  await element.click();
  await handle.dispose();
  if (!await completion) throw new Error('The visible JD page control did not reach its expected destination.');
  if (complete && !(await complete())) throw new Error('The destination page did not expose the expected visible content.');
  return true;
}

async function waitForReady(page) {
  await page.waitForFunction(() => document.readyState !== 'loading', { timeout: WAIT_MS });
}

async function hasVisibleLogout(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll('a[href]')].some(anchor => visible(anchor)
      && /logout|uc\/login/i.test(anchor.href)
      && /退出/.test(anchor.innerText || anchor.textContent || ''));
  });
}

async function hasVisibleProfileForm(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return ['#nickName', '[name="sex"]'].some(selector => [...document.querySelectorAll(selector)].some(visible));
  });
}

async function hasAuthenticatedSession(page) {
  if (await hasVisibleLogout(page)) return true;
  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await waitForReady(page);
  return (await hasVisibleLogout(page)) || (await hasVisibleProfileForm(page));
}

async function ensureLogin(page, reporter) {
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await waitForReady(page);
    if (await hasAuthenticatedSession(page)) return;
    if (!reporter?.requestHuman) throw new Error('JD login requires a human QR confirmation; no human handoff is available.');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await waitForReady(page);
    await reporter.requestHuman({
      id: attempt === 1 ? 'jd-login' : `jd-login-retry-${attempt}`,
      instructions: `京东专用登录页已打开（第 ${attempt}/${LOGIN_MAX_ATTEMPTS} 次）。扫码完成并返回京东页面后请立即交还控制；如果提示二维码过期，也立即交还，Agent 会先检查个人信息页的登录状态，再决定是否刷新二维码。不要浏览其他页面。`,
      timeoutMs: LOGIN_HANDOFF_TIMEOUT_MS,
      // Human return only confirms control was returned. Authentication is verified below.
      completionCheck: { selector: 'body' },
    });
    if (await hasAuthenticatedSession(page)) return;
  }
  throw new Error(`JD login was not confirmed after ${LOGIN_MAX_ATTEMPTS} QR attempts.`);
}

async function readPageFields(page, definitions) {
  return page.evaluate(fields => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const valueOf = element => {
      if (!element) return null;
      if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent?.trim() ?? element.value ?? '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value ?? '';
      return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const readByLabel = terms => {
      const labels = [...document.querySelectorAll('label,dt,th,span,div,p,strong,b,[class~="label"],[class*="label-"]')].filter(isVisible);
      for (const label of labels) {
        const labelText = (label.innerText || label.textContent || '').replace(/[：:]\s*$/, '').replace(/\s+/g, ' ').trim();
        if (!terms.some(term => labelText === term || labelText.startsWith(term))) continue;
        let row = label.closest('tr,li,dl,.item,.form-item,[class*="row"],[class*="info"]') || label.parentElement;
        for (let depth = 0; row && depth < 3; depth++, row = row.parentElement) {
          const control = row.querySelector('input:not([type="hidden"]),select,textarea');
          if (control && isVisible(control)) return valueOf(control);
          const content = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
          if (content.length > 0 && content.length <= 300) {
            const remaining = content.replace(labelText, '').replace(/^[：:\s]+/, '').trim();
            if (remaining) return remaining;
          }
        }
      }
      return null;
    };
    const result = {};
    for (const [name, definition] of Object.entries(fields)) {
      let value = null;
      for (const selector of definition.selectors || []) {
        const element = document.querySelector(selector);
        if (element && isVisible(element)) { value = valueOf(element); break; }
      }
      result[name] = value !== null && value !== undefined && !(typeof value === 'string' && !value.trim())
        ? value : readByLabel(definition.labels || []);
    }
    return result;
  }, definitions);
}

async function readProfile(page) {
  const fields = await readPageFields(page, {
    userId: { selectors: ['#userId', 'input[name="userVo.userId"]', '[name="userId"]'], labels: ['用户ID', '用户 Id', '京东ID', '用户编号'] },
    loginName: { selectors: ['#loginName', 'input[name*="loginName"]'], labels: ['登录名', '用户名', '登录账号', '京东账号', '账号'] },
    nickname: { selectors: ['#nickName', 'input[name="userVo.nickName"]'], labels: ['昵称'] },
    gender: { selectors: ['select[name="sex"]'], labels: [] },
    birthYear: { selectors: ['#birthdayYear'], labels: [] },
    birthMonth: { selectors: ['#birthdayMonth'], labels: [] },
    birthDay: { selectors: ['#birthdayDay'], labels: [] },
    email: { selectors: ['#email', 'input[name*="email" i]'], labels: ['邮箱', '电子邮箱'] },
  });
  const birthValues = [fields.birthYear, fields.birthMonth, fields.birthDay];
  const birthParts = birthValues.map(value => String(value ?? '').match(/\d+/)?.[0] || '');
  const birthday = birthValues.some(value => value === null) ? null : birthParts.every(Boolean)
    ? birthParts.map((part, index) => index === 0 ? part : part.padStart(2, '0')).join('-') : null;
  const gender = await page.evaluate(() => {
    const selected = document.querySelector('input[name="sex"]:checked');
    if (!selected) return null;
    const visibleText = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        ? (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() : '';
    };
    const normalized = text => (text || '').replace(/^性别\s*[：:]?\s*/, '').replace(/\s+/g, ' ').trim();
    const allowed = new Set(['男', '女', '保密']);
    let candidate = selected.closest('label');
    if (!candidate && selected.id) candidate = document.querySelector(`label[for="${CSS.escape(selected.id)}"]`);
    const candidateText = candidate ? normalized(visibleText(candidate)) : '';
    if (allowed.has(candidateText)) return candidateText;
    let parent = selected.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      const parentText = normalized(visibleText(parent));
      if (allowed.has(parentText)) return parentText;
    }
    return null;
  });
  return { userId: fields.userId, loginName: fields.loginName, nickname: fields.nickname, gender: gender || fields.gender, birthday, email: fields.email };
}

async function readSecurity(page) {
  return readPageFields(page, {
    realName: { selectors: ['#realName', 'input[name*="realName" i]'], labels: ['真实姓名', '姓名'] },
    boundPhone: { selectors: ['#mobile', 'input[name*="mobile" i]', 'input[name*="phone" i]'], labels: ['绑定手机号', '绑定手机', '手机号码', '手机号', '手机'] },
  });
}

async function readAddresses(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cards = [...document.querySelectorAll('[id^="addresssDiv-"]')].filter(visible);
    return cards.map((card, index) => {
      const fields = {};
      for (const item of card.querySelectorAll('.item')) {
        const labelElement = item.querySelector('.label');
        const valueElement = item.querySelector('.fl');
        if (!labelElement || !valueElement) continue;
        const labelRect = labelElement.getBoundingClientRect();
        const valueRect = valueElement.getBoundingClientRect();
        if (!labelRect.width || !labelRect.height || !valueRect.width || !valueRect.height) continue;
        const label = (labelElement.innerText || labelElement.textContent || '').replace(/[：:]\s*$/, '').trim();
        const value = (valueElement.innerText || valueElement.textContent || '').replace(/\s+/g, ' ').trim();
        if (label) fields[label] = value;
      }
      const field = terms => {
        const key = Object.keys(fields).find(label => terms.some(term => label.includes(term)));
        return key ? fields[key] : null;
      };
      return {
        addressOrdinal: index + 1,
        isDefault: Boolean(card.querySelector('.ftx-04.ml10') && /默认地址/.test(card.querySelector('.ftx-04.ml10').innerText || card.querySelector('.ftx-04.ml10').textContent || '')),
        recipient: field(['收货人', '收件人']),
        region: field(['所在地区', '地区']),
        streetAddress: field(['详细地址', '地址']),
        mobile: field(['手机', '移动电话']),
        telephone: field(['固定电话', '座机']),
        email: field(['邮箱', '电子邮箱']),
      };
    });
  });
}

async function selectYear(page, year, currentYear) {
  if (year === currentYear) {
    const current = await page.evaluate(() => [...document.querySelectorAll('button,a,[role="button"],[tabindex],span,div')]
      .some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && /今年内订单/.test(element.innerText || element.textContent || '');
      }));
    if (current) return;
  }
  const trigger = await page.evaluateHandle(() => [...document.querySelectorAll('button,a,[role="button"],[tabindex],span,div')]
    .filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && /今年内订单|近\s*\d+\s*(?:个月|年)订单|\d{4}年.*订单/.test(element.innerText || element.textContent || '');
    })
    .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length)[0] || null);
  const triggerElement = trigger.asElement();
  if (!triggerElement) { await trigger.dispose(); throw new Error('The visible order-year filter was not found.'); }
  await triggerElement.click();
  await trigger.dispose();
  await new Promise(resolve => setTimeout(resolve, 150));
  const option = await page.evaluateHandle(({ targetYear, currentYear }) => [...document.querySelectorAll('button,a,[role="option"],[role="menuitem"],li,div,span')]
    .filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
        (new RegExp(`(^|\\D)${targetYear}年?(?:内)?(?:订单)?$`).test(text) ||
          (targetYear === currentYear && /今年内订单/.test(text)));
    })
    .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length)[0] || null,
  { targetYear: year, currentYear });
  const optionElement = option.asElement();
  if (!optionElement) { await option.dispose(); throw new Error('The requested order-year option was not visible.'); }
  await optionElement.click();
  await option.dispose();
  await page.waitForFunction(({ targetYear, isCurrentYear }) => {
    const text = document.body.innerText || '';
    return text.includes(`${targetYear}年`) || (isCurrentYear && /今年内订单/.test(text));
  }, { timeout: WAIT_MS }, { targetYear: year, isCurrentYear: year === currentYear });
}

async function readOrderCards(page) {
  return page.$$eval('[class*="orderCard-"]', cards => cards
    .filter(card => !card.parentElement?.closest('[class*="orderCard-"]'))
    .map(card => {
      const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
      const firstText = selectors => {
        for (const selector of selectors) {
          const element = card.querySelector(selector);
          const value = (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
          if (value) return value;
        }
        return null;
      };
      const orderNumberText = firstText(['[class*="orderMetas-"]']) || text;
      const orderId = orderNumberText.match(/订单号\s*[：:]?\s*([A-Za-z0-9-]+)/)?.[1] || null;
      const placedAtText = firstText(['[class*="orderTime-"] [class*="metaValue-"]', '[class*="orderTime-"]']) || text;
      const placedAt = placedAtText.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/)?.[0] || null;
      const shopName = firstText(['[class*="shopNames-"]']);
      const status = firstText(['[class*="statusText-"]']);
      const moneyText = firstText(['[class*="priceColumn-"]', '[class*="amount-"]', '[class*="totalPrice-"]']) || text;
      const amountMatch = moneyText.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
      const paymentType = firstText(['[class*="paymentTypeName-"]']) || ['在线支付', '货到付款', '京东白条', '白条支付'].find(value => text.includes(value)) || null;
      const productArea = card.querySelector('[class*="listContent-"]') || card;
      const safeHttpUrl = raw => {
        if (typeof raw !== 'string' || !raw.trim()) return null;
        try { const url = new URL(raw, location.href); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
        catch { return null; }
      };
      const images = [...productArea.querySelectorAll('img')].map(image => ({
        imageUrl: safeHttpUrl(image.currentSrc || image.src || image.getAttribute('data-lazy-img') || image.getAttribute('data-src') || ''),
        alt: (image.alt || '').trim(),
        productUrl: safeHttpUrl(image.closest('a[href]')?.href || ''),
      })).filter(image => image.imageUrl);
      const productAnchors = [...productArea.querySelectorAll('a[href]')]
        .filter(anchor => safeHttpUrl(anchor.href) && !/订单详情|查看|发票|物流|删除订单|评价/.test(anchor.innerText || anchor.textContent || ''));
      const itemNames = productAnchors.map(anchor => (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim()).filter(value => value && value.length < 300);
      const items = images.map((image, index) => ({
        title: image.alt || itemNames[index] || itemNames[0] || null,
        imageUrl: image.imageUrl,
        productUrl: image.productUrl || productAnchors[index]?.href || null,
      }));
      const shippingCandidates = [...card.querySelectorAll('[class*="deliveryTextGroup-"],[class*="deliveryInfo-"],[class*="receiver" i],[class*="recipient" i],[class*="address" i],[class*="consignee" i],[class*="shipTo" i]')]
        .filter(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; })
        .map(element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(value => value.length >= 4 && value.length <= 400)
        .sort((a, b) => a.length - b.length);
      const detail = [...card.querySelectorAll('a[href]')].find(anchor => /订单详情/.test(anchor.innerText || anchor.textContent || ''));
      const detailHref = detail && /^https?:/i.test(detail.href) ? detail.href : null;
      const shippingSummary = shippingCandidates[0] || null;
      return {
        orderId,
        placedAt,
        items,
        shopName,
        shippingSummary,
        status,
        amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null,
        currency: amountMatch ? 'CNY' : null,
        paymentType,
        detailHref,
      };
    }));
}

async function pageFingerprint(page) {
  return page.$$eval('[class*="orderCard-"]', cards => cards.map(card => {
    const text = (card.innerText || card.textContent || '').replace(/\s+/g, ' ');
    return text.match(/订单号\s*[：:]?\s*([A-Za-z0-9-]+)/)?.[1] || '';
  }).join('|'));
}

async function nextPageState(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[class*="nextBtn-"]')];
    const element = candidates.find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!element) return { exists: false, disabled: false, href: null };
    const disabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' ||
      /disabled/i.test(element.className || '') || element.closest('[aria-disabled="true"]') !== null;
    const anchor = element.matches('a[href]') ? element : element.querySelector('a[href]');
    return { exists: true, disabled, href: anchor?.href || null };
  });
}

async function clickOrderDetail(page, order) {
  await page.goto(order.listUrl, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await page.waitForFunction(() => document.querySelector('[class*="orderCard-"]'), { timeout: WAIT_MS });
  const handle = await page.evaluateHandle(orderId => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cards = [...document.querySelectorAll('[class*="orderCard-"]')];
    const card = cards.find(element => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ');
      return text.match(/订单号\s*[：:]?\s*([A-Za-z0-9-]+)/)?.[1] === orderId;
    });
    return [...(card?.querySelectorAll('[class*="detailLink-"],button,[role="button"]') || [])]
      .filter(visible)
      .find(element => /detailLink-/.test(element.className || '') || /订单详情/.test(element.innerText || element.textContent || '')) || null;
  }, order.orderId);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); return false; }
  const beforeUrl = page.url();
  const beforeDetail = await page.evaluate(() => ({
    info: Boolean(document.querySelector('.order-info.order-info-new')),
    goods: Boolean(document.querySelector('.order-goods.m,.tb-order')),
  }));
  const completion = page.waitForFunction(({ url, beforeInfo, beforeGoods }) =>
    location.href !== url || (!beforeInfo && Boolean(document.querySelector('.order-info.order-info-new'))) ||
    (!beforeGoods && Boolean(document.querySelector('.order-goods.m,.tb-order'))),
  { timeout: WAIT_MS }, { url: beforeUrl, beforeInfo: beforeDetail.info, beforeGoods: beforeDetail.goods }).catch(() => null);
  await element.click();
  await handle.dispose();
  return Boolean(await completion);
}

async function readRecycleRows(page) {
  return page.evaluate(() => {
    const emptyText = (document.body.innerText || '').includes('回收站暂时没有订单');
    const safeHttpUrl = raw => {
      if (typeof raw !== 'string' || !raw.trim()) return null;
      try { const url = new URL(raw, location.href); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
      catch { return null; }
    };
    const tables = [...document.querySelectorAll('table.td-void.order-tb')].filter(table => {
      const rect = table.getBoundingClientRect();
      const style = getComputedStyle(table);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const rows = tables.flatMap(table => [...table.querySelectorAll('tbody tr')]).filter(row => row.querySelectorAll('td').length > 1);
    const records = rows.map((row, index) => {
      const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      const orderId = text.match(/订单号\s*[：:]?\s*([A-Za-z0-9-]+)/)?.[1] || null;
      const product = row.querySelector('[class*="goods-msg"],[class*="goods-msg"] a');
      const image = row.querySelector('img');
      const cells = [...row.querySelectorAll('td')].map(cell => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim());
      const amountMatch = text.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
      return {
        recycleOrdinal: index + 1,
        orderId,
        placedAt: text.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/)?.[0] || null,
        items: [{ title: (product?.innerText || product?.textContent || image?.alt || '').replace(/\s+/g, ' ').trim() || null, imageUrl: safeHttpUrl(image?.currentSrc || image?.src || ''), productUrl: safeHttpUrl(product?.closest('a[href]')?.href || '') }],
        shopName: row.querySelector('[class*="shop"]')?.textContent?.trim() || null,
        shippingSummary: cells.find(value => /收货|收件|地址/.test(value)) || null,
        status: text.match(/已删除|已取消|交易完成|已完成/)?.[0] || null,
        amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null,
        currency: amountMatch ? 'CNY' : null,
        paymentType: ['在线支付', '货到付款', '京东白条', '白条支付'].find(value => text.includes(value)) || null,
      };
    });
    return { emptyText, records };
  });
}

async function waitForRecycleContent(page) {
  await page.waitForFunction(() => {
    if ((document.body.innerText || '').includes('回收站暂时没有订单')) return true;
    return [...document.querySelectorAll('table.td-void.order-tb')].some(table => {
      const rect = table.getBoundingClientRect();
      const style = getComputedStyle(table);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  }, { timeout: WAIT_MS });
}

async function readDetail(page) {
  return page.evaluate(() => {
    const area = document.querySelector('.order-info.order-info-new') || document.body;
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const valueOf = element => {
      if (!element) return null;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value ?? '';
      if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent?.trim() ?? element.value ?? '';
      return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const field = terms => {
      const labels = [...area.querySelectorAll('dt,th,label,.label,.dt,[class*="label"]')].filter(isVisible);
      for (const label of labels) {
        const labelText = (label.innerText || label.textContent || '').replace(/[：:]\s*$/, '').replace(/\s+/g, ' ').trim();
        if (!terms.some(term => labelText === term || labelText.startsWith(term))) continue;
        let row = label.closest('tr,li,dl,.item,.info-rcol,[class*="row"]') || label.parentElement;
        for (let depth = 0; row && depth < 3; depth++, row = row.parentElement) {
          const control = row.querySelector('input:not([type="hidden"]),select,textarea');
          if (control && isVisible(control)) return valueOf(control);
          const sibling = label.nextElementSibling || row.querySelector('.dd,.fl,.info-rcol');
          const candidate = valueOf(sibling);
          if (candidate && candidate !== labelText && candidate.length <= 500) return candidate;
        }
      }
      return null;
    };
    return {
      recipient: field(['收货人', '收件人', '收件人姓名']),
      mobile: field(['手机号码', '手机号', '手机']),
      telephone: field(['固定电话', '座机']),
      email: field(['邮箱', '电子邮箱']),
      region: field(['所在地区', '地区']),
      streetAddress: field(['详细地址', '收货地址', '地址']),
      detailPageRecognized: Boolean(document.querySelector('.order-info.order-info-new') || document.querySelector('.order-goods.m,.tb-order')),
    };
  });
}

function dateInput(input) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const from = input.startDate || `${now.getFullYear()}-01-01`;
  const to = input.endDate || today;
  const validIsoDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validIsoDate(from) || !validIsoDate(to) || from > to) {
    throw new Error('Use an inclusive startDate/endDate range in YYYY-MM-DD order.');
  }
  const years = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) years.push(year);
  return { from, to, years, currentYear: now.getFullYear() };
}

function withinRange(date, from, to) {
  if (!date) return false;
  const parts = date.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!parts) return false;
  const normalized = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
  return normalized >= from && normalized <= to;
}

export async function run({ page, input = {}, reporter }) {
  sourceRefs.length = 0;
  const range = dateInput(input);
  const maxPages = Number(input.maxPages || 100);
  const maxOrders = Number(input.maxOrders || 2000);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500 || !Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 20_000) {
    throw new Error('maxPages must be 1–500 and maxOrders must be 1–20000.');
  }
  await progress(reporter, 'Checking the visible JD login state.');
  await ensureLogin(page, reporter);
  await checkpoint(reporter, 'login-confirmed', '京东登录状态已确认', '页面显示可见的退出链接或个人信息表单；没有从页面外读取账号状态。');

  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await waitForReady(page);
  const profileCheckpoint = await checkpoint(reporter, 'profile-complete', '个人信息页', '读取页面可见的用户 ID、登录名、昵称、性别、生日和邮箱。', ['profile-complete']);
  const profile = await readProfile(page);
  await reporter?.emitData('profile', [profile], { sourceRefs: [profileCheckpoint].filter(Boolean), origin: 'browser' });
  const profileComplete = ['userId', 'loginName', 'nickname', 'gender', 'birthday', 'email'].every(field => present(profile[field]));
  await assertion(reporter, 'profile-complete', '个人资料六个字段均有页面来源', profileComplete, `用户 ID、登录名、昵称、性别、生日、邮箱字段均已读取=${profileComplete}。`, [profileCheckpoint].filter(Boolean));

  if (!(await navigateViaVisibleLink(page, ['账户安全', '安全中心'], { required: false }))) {
    await navigateViaVisibleLink(page, ['实名认证']);
  }
  const identityCheckpoint = await checkpoint(reporter, 'identity-complete', '实名认证信息页', '读取页面可见的真实姓名与绑定手机号；保留网站显示的脱敏形式。', ['identity-complete']);
  const identityCheckpointIds = [identityCheckpoint].filter(Boolean);
  const identity = await readSecurity(page);
  const identityFallbacks = [
    { field: 'realName', linkTerms: ['实名认证'], key: 'identity-real-name', title: '实名认证详情' },
    { field: 'boundPhone', linkTerms: ['绑定手机', '绑定手机号'], key: 'identity-bound-phone', title: '绑定手机详情' },
  ];
  const fallbackLinks = new Map();
  for (const fallback of identityFallbacks) {
    if (!present(identity[fallback.field])) fallbackLinks.set(fallback.field, await visibleLink(page, fallback.linkTerms));
  }
  for (const fallback of identityFallbacks) {
    const href = fallbackLinks.get(fallback.field);
    if (present(identity[fallback.field]) || !href || !allowedJdUrl(href) || href === page.url()) continue;
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await waitForReady(page);
    const detailCheckpoint = await checkpoint(reporter, fallback.key, fallback.title, `从安全中心的可见链接打开${fallback.title}，仅读取页面展示值。`, ['identity-complete']);
    if (detailCheckpoint) identityCheckpointIds.push(detailCheckpoint);
    const detailFields = await readSecurity(page);
    for (const field of ['realName', 'boundPhone']) {
      if (!present(identity[field]) && present(detailFields[field])) identity[field] = detailFields[field];
    }
  }
  await reporter?.emitData('identity', [identity], { sourceRefs: identityCheckpointIds, origin: 'browser' });
  const identityComplete = present(identity.realName) && present(identity.boundPhone);
  await assertion(reporter, 'identity-complete', '实名认证姓名与绑定手机号均有页面来源', identityComplete, `姓名和手机号字段均已读取=${identityComplete}；保留网站展示的遮蔽形式。`, identityCheckpointIds);

  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await waitForReady(page);
  await navigateViaVisibleLink(page, LABELS.address);
  await page.waitForFunction(() => document.querySelector('[id^="addresssDiv-"]')
    || (location.hostname === 'www.jd.com' && location.pathname === '/'), { timeout: WAIT_MS });
  const addressPageReady = await page.evaluate(() => Boolean(document.querySelector('[id^="addresssDiv-"]')));
  if (!addressPageReady) throw new Error('The visible JD address link returned to the storefront without showing address cards.');
  const addressCheckpoint = await checkpoint(reporter, 'addresses-complete', '收货地址列表', '读取每条地址的默认状态、收件人、地区、详细地址、手机、固定电话和邮箱；保留页面原有脱敏。', ['addresses-complete']);
  const addresses = await readAddresses(page);
  await reporter?.emitData('addresses', addresses, { sourceRefs: [addressCheckpoint].filter(Boolean), origin: 'browser' });
  const addressComplete = addresses.length > 0 && addresses.every(address => ['recipient', 'region', 'streetAddress', 'mobile', 'telephone', 'email'].every(field => present(address[field])));
  await assertion(reporter, 'addresses-complete', '地址字段与默认状态完整', addressComplete, `已检查 ${addresses.length} 条地址；请求字段均有页面节点=${addressComplete}。`, [addressCheckpoint].filter(Boolean));

  const orders = [];
  const pageCounts = [];
  const orderCheckpointIds = [];
  const seenOrderIds = new Map();
  let paginationComplete = true;
  for (const year of range.years) {
    checkAbort(reporter);
    await page.goto(ORDER_CENTER_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await waitForReady(page);
    await page.waitForFunction(() => document.querySelector('[class*="orderCard-"]') || /没有订单|暂无订单/.test(document.body.innerText || ''), { timeout: WAIT_MS });
    await selectYear(page, year, range.currentYear);
    let pageNumber = 1;
    let yearComplete = false;
    for (; pageNumber <= maxPages; pageNumber++) {
      checkAbort(reporter);
      const listUrl = page.url();
      const cardRows = await readOrderCards(page);
      const listCheckpoint = await checkpoint(reporter, 'orders-list-page', `订单列表页 ${pageNumber}`, `年份 ${year}，页 ${pageNumber}；按页面筛选器和可见分页读取。`, ['orders-complete']);
      if (listCheckpoint) orderCheckpointIds.push(listCheckpoint);
      for (const row of cardRows) {
        if (!withinRange(row.placedAt, range.from, range.to)) continue;
        const prior = seenOrderIds.get(row.orderId);
        if (row.orderId && prior) {
          if (JSON.stringify({ ...prior, detailHref: undefined }) !== JSON.stringify({ ...row, detailHref: undefined })) {
            throw new Error('The same order appeared with conflicting visible fields across pages.');
          }
          continue;
        }
        if (row.orderId) seenOrderIds.set(row.orderId, row);
        orders.push({ ...row, listPage: pageNumber, selectedYear: year, listUrl, sourceCheckpointId: listCheckpoint ?? null });
        if (orders.length > maxOrders) throw new Error('The selected range exceeded maxOrders before pagination completed.');
      }
      pageCounts.push({ year, page: pageNumber, rows: cardRows.length });
      const next = await nextPageState(page);
      if (next.exists && next.disabled) { yearComplete = true; break; }
      if (!next.exists && cardRows.length === 0) {
        const explicitEmpty = await page.evaluate(() => /暂无订单|没有符合条件的订单|没有订单/.test(document.body.innerText || ''));
        if (explicitEmpty) { yearComplete = true; break; }
      }
      if (!next.exists) throw new Error('The visible order list did not expose a pagination end control.');
      if (pageNumber === maxPages) break;
      const before = await pageFingerprint(page);
      if (next.href) {
        if (!allowedJdUrl(next.href)) throw new Error('The visible order pagination link left the JD site; refusing to follow it.');
        await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
      } else {
        await page.click('[class*="nextBtn-"]');
      }
      await page.waitForFunction(previous => {
        const cards = [...document.querySelectorAll('[class*="orderCard-"]')];
        const current = cards.map(card => (card.innerText || card.textContent || '').match(/订单号\s*[：:]?\s*([A-Za-z0-9-]+)/)?.[1] || '').join('|');
        return current && current !== previous;
      }, { timeout: WAIT_MS }, before);
    }
    if (!yearComplete) paginationComplete = false;
  }

  await reporter?.emitData('orders', orders.map(({ detailHref, listUrl, ...record }) => record), {
    sourceRefs: orderCheckpointIds.slice(0, 128), origin: 'browser',
    pagination: { complete: paginationComplete, pages: pageCounts.length, terminalReason: paginationComplete ? 'Visible disabled next control or explicit empty list for each selected year' : 'Pagination safety limit reached without terminal evidence' },
  });
  const ordersValid = orders.length > 0 && orders.every(order => order.orderId && order.placedAt && Array.isArray(order.items) && order.items.length > 0 && order.items.every(item => item.title && item.imageUrl) && order.shopName && order.shippingSummary && order.status && Number.isFinite(order.amount) && order.paymentType);
  const uniqueOrders = new Set(orders.map(order => order.orderId)).size === orders.length;
  await assertion(reporter, 'orders-complete', '所选范围订单字段、图片链接和身份完整', ordersValid && uniqueOrders, `已检查 ${orders.length} 条订单；字段完整=${ordersValid}；订单号唯一=${uniqueOrders}。`, orderCheckpointIds);
  await assertion(reporter, 'orders-complete', '所有年份均到达可见分页终点', paginationComplete, `已读 ${pageCounts.length} 个列表页；终止状态来自可见的禁用“下一页”或明确空列表。`, orderCheckpointIds);

  const detailRecords = orders.map(order => ({
    orderId: order.orderId,
    sourceOrderId: order.orderId,
    sourceCheckpointId: order.sourceCheckpointId,
    shippingSummary: order.shippingSummary,
    items: order.items,
    shopName: order.shopName,
    status: order.status,
    amount: order.amount,
    paymentType: order.paymentType,
    detailSource: 'orders-list-derived',
  }));
  await reporter?.emitData('details', detailRecords, { sourceRefs: orderCheckpointIds.slice(0, 128), origin: 'derived' });
  const detailComplete = detailRecords.length === orders.length && detailRecords.every(detail =>
    detail.orderId && detail.orderId === detail.sourceOrderId && detail.sourceCheckpointId);
  await assertion(reporter, 'details-complete', '订单摘要均关联到来源列表保存点', detailComplete, `订单 ${orders.length} 条；派生摘要 ${detailRecords.length} 条；来源订单与列表保存点均可追溯=${detailComplete}。`, orderCheckpointIds);

  await page.goto(ORDER_CENTER_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  await waitForReady(page);
  if (!(await navigateViaVisibleLink(page, LABELS.recycle, { required: false }))) {
    await clickVisibleControl(page, LABELS.recycle);
  }
  await waitForRecycleContent(page);
  const recycleCheckpoint = await checkpoint(reporter, 'deleted-orders-complete', '订单回收站', '读取订单回收站；只有页面显示明确空状态时才把已删除订单记为零条，不从其他来源补充。', ['deleted-orders-complete']);
  const recycle = await readRecycleRows(page);
  const deletedOrders = recycle.records;
  await reporter?.emitData('deletedOrders', deletedOrders, { sourceRefs: [recycleCheckpoint].filter(Boolean), origin: 'browser' });
  const deletedUnique = deletedOrders.every(row => present(row.orderId)) && new Set(deletedOrders.map(row => row.orderId)).size === deletedOrders.length;
  const deletedValid = recycle.emptyText ? deletedOrders.length === 0 : deletedOrders.length > 0 && deletedUnique && deletedOrders.every(row => present(row.placedAt) && row.items?.some(item => present(item.title)) && row.amount !== null && present(row.shippingSummary));
  await assertion(reporter, 'deleted-orders-complete', '回收站列表或明确空状态已读取', deletedValid, recycle.emptyText ? '页面显示回收站暂时没有订单，记录为空列表。' : `已检查 ${deletedOrders.length} 条回收站记录。`, [recycleCheckpoint].filter(Boolean));

  await checkpoint(reporter, 'collection-complete', '京东账号数据采集完成', '保存各数据集、分页终止依据及从订单列表派生的订单摘要引用。', ['profile-complete', 'identity-complete', 'addresses-complete', 'orders-complete', 'deleted-orders-complete', 'details-complete']);
  await progress(reporter, `Completed visible-page collection: ${addresses.length} addresses, ${orders.length} orders, ${deletedOrders.length} deleted orders, ${detailRecords.length} details.`);

  return {
    selectedRange: { startDate: range.from, endDate: range.to },
    counts: { profileRows: 1, addressRows: addresses.length, orderRows: orders.length, deletedOrderRows: deletedOrders.length, detailRows: detailRecords.length },
    pagination: { pages: pageCounts.length, complete: paginationComplete },
    deletedOrdersState: recycle.emptyText ? 'explicit-empty' : 'rows-observed',
    assertions: { profileComplete, identityComplete, addressComplete, ordersValid, uniqueOrders, paginationComplete, deletedValid, detailComplete },
  };
}
