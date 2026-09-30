import React from 'react';
import type { WorkbenchHost } from '@/contracts/host-capabilities';

/** Reused on native and browser surfaces. Describes host support, not grants. */
export function HostCapabilitiesSummary({ host, embedded }: { host: WorkbenchHost; embedded: boolean }) {
  const node = host.backend === 'node';
  return <section aria-label="宿主能力" className="form-stack">
    <h3>宿主能力</h3>
    <p>{node ? 'Node · 独立 Chromium' : host.backend === 'electron-companion' ? 'Electron 伴随服务' : 'Electron 原生工作台'} · {embedded ? '原生页面嵌入' : '当前网页不嵌入实时浏览器'}</p>
    <ul>
      <li>{host.capabilities.downloads === 'managed' ? '下载与弹出页面由 Electron 工作台管理' : '下载与弹出窗口被拒绝，不能用于这类任务'}</li>
      <li>{node ? '执行仅支持显式启用的有头协作 DEV/TEST 模式；人工输入不被拦截，干扰识别不完整，执行中人工接管不支持' : '实时页面、运行控制与人工交接使用 Electron 工作台；浏览器配对不会取得这些权限'}</li>
      <li>旧 Electron 登录环境仍属于 Electron；Chromium 使用独立环境，不迁移 Cookie 或改写旧存储身份</li>
    </ul>
    <p className="hint">宿主支持不代表本连接已获授权。资料、固定版本、结果和历史回放使用同一领域规则。</p>
  </section>;
}
