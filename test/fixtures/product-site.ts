import { createServer } from 'node:http';

/** A synthetic website only. It cannot access Studio or create task materials. */
export async function startProductSite(port=0){
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Synthetic port must be an integer from 0 to 65535');
  const server=createServer((request,response)=>{
    if(request.url==='/browser-check'){
      response.setHeader('content-type','text/html; charset=utf-8');
      response.end('<!doctype html><title>合成浏览器输入检查</title><style>body{font:20px system-ui;padding:32px}input{margin:16px}</style><h1>本地附件与页面菜单</h1><p>这是本机合成页面；只显示所选文件名，不上传文件。</p><label>合成附件<input type="file" onchange="document.querySelector(\'#selected-file\').textContent=this.files[0]?.name||\'未选择\'"></label><p id="selected-file">未选择</p><label>可编辑文字<input value="synthetic editable text"></label><p><a href="/orders">返回订单后台</a></p>');return;
    }
    const logged=request.headers.cookie?.includes('bes_journey=account-one');
    if(request.url==='/login/fail'){response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><title>合成登录失败</title><h1>登录失败</h1><p>合成凭据不匹配，未创建登录状态。</p><a href="/orders">返回准备登录</a>');return;}
    if(request.url==='/session/expire'){response.writeHead(303,{'set-cookie':'bes_journey=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',location:'/orders'});response.end();return;}
    if(request.url==='/login/confirm'){response.writeHead(303,{'set-cookie':'bes_journey=account-one; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400',location:'/orders'});response.end();return;}
    if(request.url==='/details'&&logged){response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><title>合成订单详情</title><h1>订单详情</h1><p>订单一，实付12.00元。</p><button onclick="window.close()">关闭详情</button>');return;}
    if(request.url==='/orders'&&logged){response.setHeader('content-type','text/html; charset=utf-8');response.end(`<!doctype html><title>合成订单后台</title><style>body{font:20px system-ui;padding:32px}table{border-collapse:collapse}td,th{padding:18px;border:1px solid #aaa}</style><h1>订单后台</h1><p id="logged-in">合成账户一已登录</p><p>当前范围：两条订单，金额单位为元。</p><table><tr><th>订单</th><th>实付金额</th></tr><tr data-entity="order-one"><td>订单一</td><td><span data-field="amount" style="outline:1px dotted red">12.00</span></td></tr><tr data-entity="order-two"><td>订单二</td><td><span data-field="amount">45.00</span></td></tr></table><button id="redraw" onclick="document.querySelector('table').replaceWith(document.querySelector('table').cloneNode(true));document.querySelector('#redraw-count').textContent=String(Number(document.querySelector('#redraw-count').textContent)+1)">重绘订单</button><span id="redraw-count">0</span><form action="/session/expire" method="post"><button>模拟登录过期</button></form><button id="details" onclick="window.open('/details')">打开订单详情</button>`);return;}
    response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><title>合成登录</title><style>body{font:20px system-ui;padding:32px}</style><h1>准备登录环境</h1><p>仅合成账户，不联系真实服务。</p><input type="password" value="SYNTHETIC-PRIVATE-SENTINEL"><form action="/login/confirm" method="post"><button>登录合成账户一</button></form><form action="/login/fail" method="post"><button>尝试错误的合成凭据</button></form>');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Site did not start');
  return {url:`http://127.0.0.1:${address.port}`,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
