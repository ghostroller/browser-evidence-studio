import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/** All identities and content in this fixture are invented. No external service is used. */
export const fixtureOrders = Array.from({ length: 7 }, (_, index) => ({
  id: `SYN-${String(index + 1).padStart(3, '0')}`,
  title: ['青色马克杯', '合成笔记本', '黄色收纳盒', '测试茶壶', '演示书签', '蓝色文件夹', '虚构桌垫'][index],
  amountCents: [1290, 2500, 3499, 8800, 900, 1500, 4700][index],
  status: index % 2 === 0 ? 'paid' : 'shipped',
  imageOrderId: `SYN-${String(index + 1).padStart(3, '0')}`,
}));

const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function document(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 合成站点</title><style>
    *{box-sizing:border-box}body{margin:0;font:16px system-ui;color:#23354b;background:#f1f5f9}header{background:#152d47;color:white;padding:22px 32px}header p{margin:5px 0 0;color:#c8d8e8}nav{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0}a{color:#145ea3}header a{color:#daeaff}main{max-width:1020px;margin:auto;padding:24px}section,.card{background:white;border:1px solid #d2dfeb;border-radius:10px;padding:18px;margin:14px 0}button,input,select{font:inherit;padding:9px 12px;border:1px solid #7891ac;border-radius:6px}button{cursor:pointer;background:#e9f2fb}button:disabled{opacity:.5;cursor:default}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #dce4ed}.muted{color:#607186}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.badge{padding:4px 8px;border-radius:5px;background:#e0f3ed}pre{overflow:auto;max-height:260px;background:#edf3fa;padding:12px}#qr{width:150px;height:150px;display:grid;grid-template-columns:repeat(9,1fr);background:white;padding:8px;border:1px solid #567}#qr span{background:#102d40}#qr.expired{opacity:.3}.alert{background:#fff2d2;padding:12px;border-radius:6px}iframe{width:100%;height:160px;border:1px solid #aabac9}
    </style></head><body><header><strong>Browser Evidence Studio · 合成验收站点</strong><p>全部订单、账号、二维码均为本地假数据</p><nav><a href="/orders">订单</a><a href="/login">人工登录</a><a href="/lab">证据实验</a><a href="/storage">持久状态</a></nav></header><main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;
}

function ordersPage(url: URL): string {
  const page = Math.max(1, Math.min(3, Number(url.searchParams.get('page')) || 1));
  const variant = url.searchParams.get('variant') || 'normal';
  const first = fixtureOrders.slice(0, 3);
  return document('合成订单', `<p class="muted">首屏 SSR 数据与 API 返回重叠；完整范围包含 7 条订单、3 页及各自详情。</p>
    <section><div class="actions"><label>筛选文字 <input id="filter" aria-label="筛选文字"></label><button id="increment">测试点击</button><span>点击次数 <output id="action-count">0</output></span><span>后台计时 <output id="tick">0</output></span></div></section>
    <section><h2>订单列表 <span id="page-label">第 ${page} 页</span></h2><table><thead><tr><th>订单 ID</th><th>商品</th><th>金额（分）</th><th>状态</th><th>操作</th></tr></thead><tbody id="orders">${first.map((order) => `<tr data-order-id="${order.id}"><td>${order.id}</td><td>${order.title}</td><td>${order.amountCents}</td><td>${order.status}</td><td><a href="/orders/${order.id}">详情</a></td></tr>`).join('')}</tbody></table><div class="actions"><button id="previous">上一页</button><button id="next">下一页</button><output id="pagination" data-total="7"></output></div><p id="api-state" role="status">加载中</p></section>
    <section><h2>时间相关证据</h2><button id="flash">显示短暂弹层（800ms）</button><button id="open-popup">打开业务弹窗</button><a id="download" href="/download">下载合成 CSV</a><div id="transient-root"></div></section>
    <script id="ssr-data" type="application/json">${scriptJson({ source: 'ssr', items: first, total: fixtureOrders.length })}</script>`, `
      let page = ${page}, count = 0, tick = 0;
      const variant = ${scriptJson(variant)};
      setInterval(() => document.querySelector('#tick').textContent = String(++tick), 100);
      document.querySelector('#increment').onclick = () => document.querySelector('#action-count').textContent = String(++count);
      async function load() {
        document.querySelector('#api-state').textContent = '加载中';
        const data = await fetch('/api/orders?page=' + page + '&variant=' + encodeURIComponent(variant)).then(r => r.json());
        window.__ordersResponse = data;
        document.querySelector('#orders').innerHTML = data.items.map(o => '<tr data-order-id="' + o.id + '"><td>' + o.id + '</td><td>' + (o.title || '') + '</td><td>' + o.amountCents + '</td><td>' + o.status + '</td><td><a href="/orders/' + o.id + '?variant=' + encodeURIComponent(variant) + '">详情</a></td></tr>').join('');
        document.querySelector('#page-label').textContent = '第 ' + page + ' 页';
        document.querySelector('#pagination').textContent = page + ' / 3，共 ' + data.total + ' 条';
        document.querySelector('#pagination').dataset.hasNext = String(data.hasNext);
        document.querySelector('#previous').disabled = page === 1;
        document.querySelector('#next').disabled = !data.hasNext;
        document.querySelector('#api-state').textContent = '已就绪';
      }
      document.querySelector('#previous').onclick = () => { page--; load(); };
      document.querySelector('#next').onclick = () => { page++; load(); };
      document.querySelector('#flash').onclick = () => { const element = document.createElement('div'); element.id = 'transient-dialog'; element.setAttribute('role', 'dialog'); element.textContent = '短暂详情 SYN-004：仅存在 800ms'; document.querySelector('#transient-root').append(element); setTimeout(() => element.remove(), 800); };
      document.querySelector('#open-popup').onclick = () => window.open('/popup', '_blank', 'width=600,height=420');
      load().catch(error => document.querySelector('#api-state').textContent = String(error));
    `);
}

function loginPage(): string {
  return document('人工登录演示', `<p>此页面不联系真实登录服务。点击“模拟手机确认”属于显式人工操作；等待或超时不会登录。</p><section><div id="qr" aria-label="合成二维码"></div><p id="qr-state" role="status">准备中</p><div class="actions"><button id="confirm-login" disabled>模拟手机确认</button><button id="refresh-qr">刷新二维码</button><button id="logout">使登录过期</button><a href="/orders">返回订单</a></div><output id="login-status" data-authenticated="false">未登录</output></section>`, `
    let attempt = null;
    async function readSession() { const session = await fetch('/api/session').then(r => r.json()); const status = document.querySelector('#login-status'); status.dataset.authenticated = String(session.authenticated); status.textContent = session.authenticated ? '已登录：' + session.accountId : '未登录'; return session; }
    async function refresh() { attempt = await fetch('/api/login/start', { method: 'POST' }).then(r => r.json()); document.querySelector('#confirm-login').disabled = false; document.querySelector('#qr').classList.remove('expired'); document.querySelector('#qr').innerHTML = Array.from({length:81}, (_,i) => '<span style="opacity:' + (((i * 13 + attempt.attempt) % 7) < 3 ? 0 : 1) + '"></span>').join(''); }
    document.querySelector('#refresh-qr').onclick = refresh;
    document.querySelector('#confirm-login').onclick = async () => { const response = await fetch('/api/login/confirm', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ nonce: attempt.nonce }) }); const result = await response.json(); if (!response.ok) { document.querySelector('#qr-state').textContent = result.error; return; } localStorage.setItem('synthetic-account', result.accountId); sessionStorage.setItem('synthetic-session-only', 'not-a-snapshot'); window.syntheticMemoryToken = 'volatile-synthetic'; await new Promise((resolve, reject) => { const request = indexedDB.open('synthetic-login', 1); request.onupgradeneeded = () => request.result.createObjectStore('account'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const transaction = db.transaction('account', 'readwrite'); transaction.objectStore('account').put(result.accountId, 'id'); transaction.oncomplete = () => { db.close(); resolve(); }; }; }); await readSession(); document.querySelector('#confirm-login').disabled = true; document.querySelector('#qr-state').textContent = '人工确认已完成，服务端已验证'; };
    document.querySelector('#logout').onclick = async () => { await fetch('/api/logout', {method:'POST'}); await readSession(); };
    setInterval(() => { if (!attempt || document.querySelector('#login-status').dataset.authenticated === 'true') return; const remaining = Math.max(0, attempt.expiresAt - Date.now()); document.querySelector('#qr-state').textContent = remaining ? '第 ' + attempt.attempt + ' 次尝试，还剩 ' + Math.ceil(remaining / 1000) + ' 秒' : '二维码已过期；请明确刷新后重试'; if (!remaining) { document.querySelector('#confirm-login').disabled = true; document.querySelector('#qr').classList.add('expired'); } }, 200);
    refresh(); readSession();
  `);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) { bytes += part.length; if (bytes > 4096) throw new Error('body too large'); chunks.push(part); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export interface FixtureServer { url: string; close(): Promise<void> }
export async function startFixture(options: { port?: number; qrTtlMs?: number } = {}): Promise<FixtureServer> {
  const attempts = new Map<string, number>();
  // Persistent cookies remain verifiable when the local fixture is restarted.
  // This intentionally insecure fixed token belongs only to the fake service.
  let sessionRevoked = false;
  let attemptCount = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const send = (response: ServerResponse, code: number, body: string | Buffer, type = 'text/html; charset=utf-8') => {
    response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body);
  };
  const json = (response: ServerResponse, body: unknown, code = 200) => send(response, code, JSON.stringify(body), 'application/json; charset=utf-8');
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      const session = !sessionRevoked && /(?:^|;\s*)synthetic_session=fake-account-001(?:;|$)/.test(request.headers.cookie || '');
      if (path === '/health') return json(response, { ready: true, synthetic: true });
      if (path === '/soak') return send(response, 200, document('连续录制负载', '<section><button id="soak-click-1">合成点击 1</button><output id="action-count">0</output><p>100 ms DOM 更新：<output id="tick">0</output></p></section>', `
        let count = 0, tick = 0;
        const button = document.querySelector('button'), output = document.querySelector('#action-count');
        button.onclick = () => { output.textContent = String(++count); button.id = 'soak-click-' + (count + 1); button.textContent = '合成点击 ' + (count + 1); };
        setInterval(() => document.querySelector('#tick').textContent = String(++tick), 100);
      `));
      if (path === '/api/soak') {
        const runId = url.searchParams.get('runId') || '', sequence = url.searchParams.get('sequence') || '', bytes = Number(url.searchParams.get('bytes'));
        if (!/^[a-f0-9-]{36}$/.test(runId) || !/^(?:regular|large)-\d+$/.test(sequence) || ![65536, 1048576].includes(bytes)) return json(response, { error: 'Invalid synthetic soak identity or byte size' }, 400);
        const body = { source: 'soak-fixture', runId, sequence, payload: '', tailMarker: 'SOAK-END' };
        body.payload = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
        return json(response, body);
      }
      if (path === '/api/request-body') {
        if (request.method !== 'POST' && request.method !== 'GET') return json(response, { error: 'Only synthetic GET and POST are supported' }, 405);
        const limitBytes = 10 * 1024 * 1024;
        let receivedBytes = 0;
        // Drain without buffering, parsing or echoing request content, including synthetic credentials.
        for await (const part of request) receivedBytes += part.length;
        if (receivedBytes > limitBytes) return json(response, { marker: 'request-body-sink', error: 'request-body-limit', receivedBytes, limitBytes }, 413);
        return json(response, { marker: 'request-body-sink', receivedBytes, limitBytes });
      }
      if (path === '/' || path === '/orders') return send(response, 200, ordersPage(url));
      if (path === '/api/orders') {
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const variant = url.searchParams.get('variant');
        let items: Array<Record<string, unknown>> = fixtureOrders.slice((page - 1) * 3, page * 3).map(order => ({ ...order, imageUrl: `/image/${order.imageOrderId}.svg` }));
        if (variant === 'duplicate' && page === 2) items.unshift({ ...fixtureOrders[2], imageUrl: `/image/${fixtureOrders[2].id}.svg` });
        if (variant === 'missing' && page === 2 && items[0]) delete items[0].title;
        if (variant === 'wrong-image' && page === 2 && items[0]) { items[0].imageOrderId = 'SYN-001'; items[0].imageUrl = '/image/SYN-001.svg'; }
        if (variant === 'empty-middle' && page === 2) items = [];
        return json(response, { source: 'api', page, total: 7, pageSize: 3, hasNext: page < 3, items });
      }
      const detail = path.match(/^\/(api\/)?orders\/(SYN-\d{3})$/);
      if (detail) {
        const order = fixtureOrders.find(item => item.id === detail[2]);
        if (!order) return json(response, { error: 'unknown synthetic order' }, 404);
        const imageOrderId = url.searchParams.get('variant') === 'wrong-image' && order.id === 'SYN-004' ? 'SYN-001' : order.id;
        const data = { ...order, imageOrderId, imageUrl: `/image/${imageOrderId}.svg`, recipient: '合成收件人', address: '演示城市 · 虚构街道 001 号', trackingId: order.status === 'shipped' ? `SYN-TRACK-${order.id}` : null };
        if (detail[1]) return json(response, data);
        return send(response, 200, document(`订单 ${order.id}`, `<section id="order-detail" data-order-id="${order.id}"><img src="${data.imageUrl}" data-image-order-id="${imageOrderId}" width="160" height="100" alt="订单 ${imageOrderId} 的合成图片"><h2>${order.title}</h2><p>金额：<span id="amount">${order.amountCents}</span> 分</p><p id="recipient">${data.recipient}</p><p id="tracking">${data.trackingId ?? '尚未发货'}</p><a href="/orders">返回列表</a></section><script id="detail-data" type="application/json">${scriptJson(data)}</script>`));
      }
      if (/^\/image\/SYN-\d{3}\.svg$/.test(path)) return send(response, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#cde5ed"/><text x="30" y="105" font-family="sans-serif" font-size="32" fill="#183a55">${path.slice(7, -4)}</text></svg>`, 'image/svg+xml');
      if (path === '/api/large') {
        const bytes = Math.max(64, Math.min(12 * 1024 * 1024, Number(url.searchParams.get('bytes')) || 1024 * 1024));
        const envelope = { source: 'large-fixture', payload: '', tailMarker: 'END' };
        envelope.payload = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(envelope)));
        return json(response, envelope);
      }
      if (path === '/ssr-large') return send(response, 200, document('375 KiB SSR JSON', `<p>JSON 尾部字段应可定向读取。</p><script id="large-data" type="application/json">${scriptJson({ payload: 's'.repeat(375 * 1024), nested: { target: 'SSR-END', explicitNull: null } })}</script>`));
      if (path === '/redirect') { response.writeHead(302, { location: '/redirect-final' }); return response.end('redirect-one'); }
      if (path === '/redirect-final') { response.writeHead(307, { location: '/orders' }); return response.end('redirect-two'); }
      if (path === '/slow') {
        const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) json(response, { slow: true, complete: true }); }, Math.max(1, Math.min(30000, Number(url.searchParams.get('ms')) || 1200)));
        timers.add(timer); return;
      }
      if (path === '/fail') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000' }); response.write('{"partial":'); const timer = setTimeout(() => { timers.delete(timer); response.destroy(); }, 30); timers.add(timer); return; }
      if (path === '/error') return json(response, { error: 'deliberate synthetic HTTP failure' }, 503);
      if (path === '/empty') return send(response, 200, '', 'text/plain');
      if (path === '/binary') return send(response, 200, Buffer.from([0, 1, 2, 3, 255, 254]), 'application/octet-stream');
      if (path === '/download') { response.setHeader('content-disposition', 'attachment; filename="synthetic-orders.csv"'); return send(response, 200, 'id,amountCents\n' + fixtureOrders.map(order => `${order.id},${order.amountCents}`).join('\n'), 'text/csv; charset=utf-8'); }
      if (path === '/frame') return send(response, 200, document('合成 iframe', '<button id="frame-button">frame 内按钮</button><output id="frame-count">0</output>', "let count=0; document.querySelector('#frame-button').onclick=()=>document.querySelector('#frame-count').textContent=String(++count);"));
      if (path === '/iframe') return send(response, 200, document('iframe 证据', '<iframe id="same-origin-frame" src="/frame" title="同源合成 frame"></iframe><p>frame 身份必须与顶层页面区分。</p>'));
      if (path === '/popup') return send(response, 200, document('合成业务弹窗', '<section data-popup="true">此 target 是独立业务弹窗，应保存 opener 关系。<button id="popup-button">弹窗操作</button><output id="popup-count">0</output></section>', "let count=0; document.querySelector('#popup-button').onclick=()=>document.querySelector('#popup-count').textContent=String(++count);"));
      if (path === '/login') return send(response, 200, loginPage());
      if (path === '/review') return send(response, 200, document('人工范围确认', '<section><p>确认本次范围为合成站点全部 7 条订单、3 页和详情关联。</p><button id="confirm-scope">确认合成范围</button><output id="scope-status" data-confirmed="false">等待明确人工确认</output></section>', "document.querySelector('#confirm-scope').onclick=()=>{document.querySelector('#scope-status').dataset.confirmed='true';document.querySelector('#scope-status').textContent='人工已确认范围';};"));
      if (path === '/api/login/start' && request.method === 'POST') { const nonce = randomUUID(); const expiresAt = Date.now() + (options.qrTtlMs ?? 15000); attempts.set(nonce, expiresAt); for (const [key, expiry] of attempts) if (expiry < Date.now()) attempts.delete(key); return json(response, { nonce, expiresAt, attempt: ++attemptCount }); }
      if (path === '/api/login/confirm' && request.method === 'POST') {
        const body = await readJson(request); const nonce = String(body.nonce || ''); const expiry = attempts.get(nonce);
        if (!expiry || expiry <= Date.now()) return json(response, { error: '二维码已过期或尝试无效；尚未登录' }, 409);
        attempts.delete(nonce); sessionRevoked = false;
        response.setHeader('set-cookie', 'synthetic_session=fake-account-001; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800');
        return json(response, { authenticated: true, accountId: 'fake-account-001' });
      }
      if (path === '/api/session') return json(response, { authenticated: session, accountId: session ? 'fake-account-001' : null });
      if (path === '/api/logout' && request.method === 'POST') { sessionRevoked = true; response.setHeader('set-cookie', 'synthetic_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); return json(response, { authenticated: false }); }
      if (path === '/storage') return send(response, 200, document('持久状态检查', '<p>cookie/localStorage/IndexedDB 可被命名 profile 持久化；sessionStorage 和内存字段只作边界观察。</p><pre id="storage-result">读取中</pre>', `async function inspect(){ const session=await fetch('/api/session').then(r=>r.json());const indexedDbAccount=await new Promise(resolve=>{const req=indexedDB.open('synthetic-login',1);req.onupgradeneeded=()=>req.result.createObjectStore('account');req.onerror=()=>resolve('read-failed');req.onsuccess=()=>{const db=req.result;const get=db.transaction('account').objectStore('account').get('id');get.onsuccess=()=>{resolve(get.result??null);db.close();};};});const data={session,localStorageAccount:localStorage.getItem('synthetic-account'),indexedDbAccount,sessionStorage:sessionStorage.getItem('synthetic-session-only'),memoryToken:window.syntheticMemoryToken??null};window.__storageResult=data;document.querySelector('#storage-result').textContent=JSON.stringify(data,null,2);}inspect();`));
      if (path === '/lab') return send(response, 200, document('证据实验', `<section><div class="actions">${['/api/large?bytes=1048576', '/api/large?bytes=9437184', '/ssr-large', '/redirect', '/slow', '/fail', '/error', '/empty', '/binary'].map(route => `<button data-fetch="${htmlEscape(route)}">${htmlEscape(route)}</button>`).join('')}</div><pre id="lab-result">点击触发采集</pre></section><a href="/iframe">iframe</a> · <a href="/popup" target="_blank">popup</a> · <a href="/download">download</a><section><button id="console-error">控制台错误</button><button id="runtime-error">运行时错误</button></section>`, `document.querySelectorAll('[data-fetch]').forEach(button=>button.onclick=async()=>{try{const response=await fetch(button.dataset.fetch);const body=await response.text();document.querySelector('#lab-result').textContent=JSON.stringify({url:response.url,status:response.status,bytes:new TextEncoder().encode(body).length,preview:body.slice(0,120)},null,2);}catch(error){document.querySelector('#lab-result').textContent=String(error);}});document.querySelector('#console-error').onclick=()=>console.error('synthetic console error');document.querySelector('#runtime-error').onclick=()=>{throw new Error('synthetic runtime error');};`));
      return json(response, { error: 'fixture route not found', path }, 404);
    })().catch(error => { if (!response.headersSent) json(response, { error: String(error) }, 400); else response.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: async () => { for (const timer of timers) clearTimeout(timer); timers.clear(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
