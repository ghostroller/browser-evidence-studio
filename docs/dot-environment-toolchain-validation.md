# dot 环境工具链验证补充

日期：2026-09-30（UTC）。本文件记录已发生的环境验证，并说明后续如何取得可核验的开发反馈；它不是产品验收报告，也不宣布浏览器版或多后端重构已完成。

关联文档：
- [共享设计页面正文](sources/browser-first-shared-design-body.md)与[来源、原附件缺失说明](sources/browser-first-shared-design-source-notes.md)
- [浏览器优先重构阶段计划](browser-first-refactor-plan.md)
- [项目约定](../AGENTS.md)、[dot 环境约定](../.agent/dots-env.md)、[既有产品验证入口](verification.md)

## 1. 结论与范围

dot 云端桌面的现有工具足以继续开发和验证两条路径：

1. 当前实际 Electron 应用：UI → IPC → Studio 服务 → 连续录制／保存点／封存 → 实际历史回放 target。
2. 拆分所需基础设施：临时 React/Vite UI → 认证 Node HTTP → Puppeteer 操作独立 Chromium → SSE 更新 → 写盘及 UI 刷新回读。

第二条使用的是仓库外的一次性协议探针，不是生产工作台。当前生产 renderer 直接由 Vite 加载时缺少 `window.studio`，仍然白屏。该结果准确定位了需要实施的 client/transport 边界，不否定工具链可行性。完整 B0 的其余基线和 B1–B4 的产品实现仍见阶段计划。

本轮还用真实公开 React SPA 交叉检查了 DOM、样式、客户端路由、控制台、网络和截图。现有回放的文字及完成状态成立，资源视觉保真有明确缺口。不得把“有页面截图”“SSE 通了”“单元测试通过”升级为产品已可用或所有场景已验收。

## 2. 实测身份与环境

### 源码与构建

- 实测基线 HEAD：`19a17c404feeb4959dee6361c2abcb595fee988f`
- 实测时工作树另有 `.agent/dots-env.md` 文档改动；探针未修改生产代码
- `.vite/build/index.js` SHA-256：`f4a81113467e18e791f4844fb30fff19b8c664b66d5bc038712350e5e4a7b80a`
- `.vite/renderer/main_window/index.html` SHA-256：`a2cd4f89f6cff5d4e3cd2cd47e80b786cb024a3d60d1d758b844594530d2e375`

上述构建指纹与本轮留存文件核对一致；后续构建必须重新记录身份，不能继承本次通过结论。

### 版本与运行上下文

| 项目 | 已核验值 | 核验依据 |
| --- | --- | --- |
| 操作系统 | Linux x86_64；系统 Chromium 包来自 Debian 13 | 当前主机只读检查 |
| 测试 Node | 24.21.0 | readiness 与实际 Electron 测试报告 |
| 匹配工具链 npm | 11.19.0 | 已准备的 runtime 实际版本；与 packageManager 一致 |
| Electron | 44.4.3 | 运行报告与安装包 |
| Electron 内嵌 Chromium | 152.0.7977.130 | 实际 CDP version 与录制版本元数据 |
| 独立 Chromium | 151.0.7922.173 | readiness 与实际系统二进制 |
| puppeteer-core / rrweb | 25.11.0 / 2.1.6 | 运行报告与安装包 |
| React / React DOM | 19.3.0 / 19.3.0 | package/lock 与安装包 |
| Vite / Forge CLI | 8.3.0 / 7.11.2 | package/lock 与安装包 |
| TypeScript / Vitest | 7.0.2 / 5.0.1 | package/lock 与安装包 |
| 可见显示 | 实测子进程有可用显示，独立 Chromium 使用 `headless: false` | readiness 的 `display: true` 与启动参数 |

注意：写本文时普通执行 shell 默认是 Node 24.19.0 / npm 11.9.0，且未自动注入 `DISPLAY`。它与实际 GUI 测试子进程不是同一运行上下文。开始前显式选择满足 `package.json` 的已安装 runtime，并从当前桌面环境取得真实显示配置；不能猜一个显示号或假定任何 shell 都已经满足要求。两种 Chromium 的主版本也不同，本次兼容是实测结果，不能假定其行为完全一致。

## 3. 已完成的观察

| 路径 | 实际观察 | 可得结论与未覆盖范围 |
| --- | --- | --- |
| 基础 readiness | loopback HTTP、浏览器原生 SSE、WebSocket echo、Puppeteer CDP 均成功 | 传输和浏览器观察工具可用；不代表生产服务实现了浏览器 UI 协议 |
| 实际 Electron 启动 | cold、warm、reload 通过；故障注入阶段按预期失败且完成退出 | 启动诊断链可用；不能把日志中故障注入的错误直接当作总失败，也不能忽略非预期错误 |
| Electron 集成路径 | 从空合成数据根经生产 UI 形成项目、环境、录制和保存点；封存后读到实际历史回放；进程退出码 0 | 生产路径可由现有工具观察；不是新架构实现证明 |
| 数据封存 | 退出后文件回读得到 1 个项目、1 个 profile，workspace revision 3，录制为 sealed | 此次写盘及退出后读取成立；该证据本身未证明重启后所有页面重新打开 |
| 三类实际 target | UI、受控业务页、历史回放分别有不同 targetId；各自 DOM 与截图可读 | 能区分并观察实际对象；不是用相同 URL 的另一页面替代 |
| 临时拆分探针 | 两个独立 Chromium profile；UI 发控制请求，服务点击实际业务 target；观测计数 1 后写盘、SSE 推回并在 UI reload 后读到 1 | HTTP/SSE/浏览器控制／文件落盘可组合；未验证服务重启恢复、长连接重连或生产工作台 |
| 临时探针安全负测 | 缺认证 401，错误 Origin 403，错误 Host 403 | 仅覆盖这三个拒绝分支；不等于完整安全审查 |
| 生产 renderer 的 Vite 直开 | bridge 为 undefined，读取 `call` 报错，正文为空 | 缺 client adapter 与真实 UI 服务接入，不能以 fake bridge 宣称拆分成功 |

### 真实公开 SPA

目标为 [TodoMVC React 示例](https://todomvc.com/examples/react/dist/)，不登录，仅使用浏览器内合成待办内容。独立 Chromium 和 Electron 受控业务页均完成：新增两项、完成其中一项、切换 Active/Completed/All hash 路由。

- 路由变化前后 `performance.timeOrigin` 一致，证明测试操作没有整页重载
- 真实 DOM 的两条文本与完成计数、计算字体样式、脚本/样式资源、控制台、网络和分 target 截图可观察
- Electron 实际 UI 发起录制、保存点、封存并打开历史回放；回放有两条准确文本和一项 completed，计算 font-family 与实时页相同，不代表已验证所有字形的像素一致性
- 两类 checkbox 图标使用内联 SVG data URL，原字节已采集，但现有离线资源安全 allowlist 返回 `unsupported / inline-data-media-or-byte-budget`，图标缺失；未放宽规则
- 观察到 favicon 404 与第三方分析请求中断，业务 DOM 流程仍成立；不写成“控制台和网络全部无错”
- 未观察到远端 todo 修改 API。初始 `learn.json` XHR 和第三方分析请求不构成业务写 API 覆盖
- 示例刷新后待办为 0，未建立持久化承诺。早期探针曾错误假定该站应保留待办，最终报告已纠正；这不影响独立的临时拆分探针写盘回读结论

## 4. 工具选择与 target 身份

### 默认开发反馈

采用现有普通 `puppeteer-core` 与隔离 Chromium，复用 React/Vite、Electron/Forge 和单 npm 包。适用于本任务已授权的本地开发及项目测试：DOM、计算样式、真实输入、控制台、网络、截图、路由及刷新。无需另引入自动化平台，也不以 dot 的通用云浏览器工具能否访问 localhost 作为项目可测试性的前提。

启动独立浏览器时由当前环境解析可执行文件；每个角色使用本任务创建的独立临时 `userDataDir`，使用可见模式完成需要视觉确认的检查。观察 Electron 时连接本任务已启动的实例，使用该实例的数据根与 `DevToolsActivePort`，不扫描未知进程或复用真实登录 profile。

### 三类表面必须分别命名

| 表面 | 当前典型识别特征 | 不可替代的身份检查 |
| --- | --- | --- |
| 工作台 UI | 当前构建的 renderer URL；有 preload 的 `studio` bridge | 所属进程／实例、主 frame、构建身份；不能仅按标题 |
| 实时业务页 | 实际 profile/session 中的 page，独立 targetId；无 UI bridge | `sessionId/profileId/pageId/targetId/generation` 与当前控制权；同 URL 不等于同一个 target |
| 历史回放 | 当前为 `about:blank` 外层及回放 iframe；无 UI bridge | `replayId/generation/ReplayPosition`、录制来源与 iframe 内容；不能只读外层空 body |

窗口锁定遮罩等也可能出现在 target 列表。不能按数组下标取“第三页”，不能硬编码本次 targetId、端口、进程号；订阅 `targetcreated/targetdestroyed` 时还要处理关闭、切换与过期对象。用于定位控件的 DOM 读取可以辅助真实 UI 输入，不能通过隐藏接口补造资料以代替被测流程。

### 何时必须回到 Electron 原生视觉

涉及嵌入 `WebContentsView`、原生窗口、遮罩、焦点、快捷键、模态框、拖动布局、原生菜单、关闭／重启时，仍须运行当前源码的实际 Electron 并检查可见桌面。独立 Chromium 预览不能代替这部分验收。桌面操作串行，只作用于确认过的合成实例。

本次整窗合成截图发生 `Own-window screenshot frame timed out`；留存标记明确 `compositeAvailable: false`、`includesNativeViews: false`。分 UI/live/replay target 截图可用，但不能证明三者在整窗中的最终遮挡、位置和焦点。需要合成视觉证据的场景须另做原生桌面捕获或人工验收，不能拼接截图冒充整窗成功。工具不可用、访问拒绝或网络限制不能通过其他路线绕过。

## 5. 安全边界

1. Electron UI IPC 当前要求精确 live main frame、webContents 和可信 URL，见 [ui-ipc.ts](../src/main/ui-ipc.ts)；业务页与回放不获得该桥。未来浏览器 UI 身份应有独立明确认证路径，不能仅凭请求来自 loopback 就等同可信 UI。
2. 当前 [Agent HTTP API](../src/main/api/server.ts) 有 loopback 监听、Host/Origin/Sec-Fetch-Site、Bearer 和任务授权限制；[dispatch](../src/main/services/dispatch.ts) 区分 `api` 与 `ui`。现有 Agent token 不能作为全权工作台会话；不得为了 B1 移除 trusted-only 拒绝。
3. 临时 React 探针使用每次生成的短命内存凭据、固定允许 Origin 和 Host；认证事件流通过带 Authorization 的 fetch 读取。其临时前端模块会包含该探针凭据，因此只适用于隔离合成测试，运行后删除，不是生产凭据分发方案，不提交代码生成物或响应日志。正式 UI 认证／会话生命周期仍需设计与负测。
4. CDP 能力只用于本任务自有隔离实例的开发测试。工作台浏览器、受控浏览器和历史回放不能因此共享生产控制权；生产 Agent 继续走受控 transport gate、lease、task authorization 和取消边界。
5. 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，业务页／回放的 `webSecurity: true` 及离线 CSP、资源白名单、禁网络／下载／权限请求策略。不得用关闭 sandbox、关闭 webSecurity 或取消资源约束解决测试失败。
6. 真实 profile、Cookie、连接凭据、录制、未脱敏日志／截图留在受限测试产物目录，不随文档入库。独立 profile 不是自动证明安全隔离充分；后续仍需验证磁盘权限、跨会话、跨项目与销毁行为。

## 6. 可复用执行入口

以下命令从仓库运行，使用当前已安装、已授权且满足 package/lock 的工具链。`NODE_TOOLCHAIN_BIN` 是执行者设置的目录变量，不是项目新配置项；已经匹配则无需设置。不把本次临时 runtime 的绝对位置写入项目。

```sh
cd "$(git rev-parse --show-toplevel)"
# 如果当前版本不匹配，先把已安装的匹配 runtime/bin 加到 PATH
# export PATH="$NODE_TOOLCHAIN_BIN:$PATH"
node --version
npm --version
node -p "require('./package.json').engines.node"
node -p "require('./package.json').packageManager"
git rev-parse HEAD
git status --short
command -v chromium
chromium --version
node -e "console.log('display configured:', Boolean(process.env.DISPLAY))"
```

需要可见 Electron 的检查在确认桌面显示后再运行，且不与其他桌面测试并行。现有 `test/desktop/launch.js` 自己建立隔离 `output/desktop-*` 数据根，设置 `BES_TEST/BES_DATA`，记录 PID、phase、退出码与结果；不要改为真实用户数据根。

```sh
: "${DISPLAY:?请在当前任务的真实桌面显示环境中执行}"
npm run typecheck
npm test -- test/unit/ui-ipc.test.ts test/unit/api-boundary.test.ts test/unit/test-mode.test.ts
npm run build
node test/desktop/launch.js --startup-only
node test/desktop/launch.js --workspace-layout
node test/desktop/launch.js --workspace-browser
```

这些是后续可复用入口，并非宣称本文编辑期间重新运行了全部检查。应按修改影响选择定向回归，再运行真实用户路径。CLI 启动成功或一个 JSON 的 `passed` 字段不足以判定通过，须核对 phase、PID、起止时间、退出码、构建身份及持久化文件。

临时 readiness／拆分／TodoMVC 脚本不在仓库内，含本次环境路径，不能当作新 clone 可直接执行的正式命令。后续把需要重复的部分改造为有界、参数化、清理自有资源的正式测试入口，并同时保留失败诊断，再将其作为阶段验收依赖。切勿在文档里伪造尚不存在的 `npm run` 脚本。

## 7. 本轮证据定位与读取规则

原始产物位于本次工作目录的仓库同级 `path-proof/` 与 `readiness-probe/`，**不在 Git 仓库，也不保证后续环境仍可访问**。以下是相对于这两个目录的定位文字，不是提交到仓库的附件链接；本文件只保存脱敏结论、版本与指纹。

| 目录 | 文件 | 用途 |
| --- | --- | --- |
| readiness-probe | `result.json`、`electron-startup.log`、`electron-exit.txt` | HTTP/SSE/WS/CDP、版本、启动阶段与退出码 |
| readiness-probe | `actual-electron-targets.json` | 早期 Electron target 盘点；不是后续三 target 完整证明 |
| path-proof | `integrated-result.json`、`source-and-persistence.json` | 集成最终结果与退出后封存读取、源码构建身份 |
| path-proof | `integrated-observed.json` | 运行中间观察；其 `passed: false` 未由最终结果覆写，不能单独代表最终状态 |
| path-proof | `split-result.json`、`split-state.json`、`summary.json` | 临时拆分最终结果、认证负测、持久化、真实 renderer 缺桥结果 |
| path-proof | `split-first-attempt-failure.json`、`split-second-attempt-host-test-failure.json` | 保留早期探针失败，最终通过不删失败历史 |
| path-proof | `integrated-*.png`、`split-*.png`、`actual-vite-no-bridge.png` | 分表面观察和缺桥现象；不是整窗合成图 |
| path-proof | `integrated-data/*.capture!.json` | 整窗捕获超时及回退范围标记 |
| path-proof | `public-spa-attempt2/result.json`、`public-spa-attempt2/replay-resource-diagnostics.json`、同目录 PNG | 真实 SPA 最终观察与 SVG 资源缺口 |

不要复制 profile 目录、DevTools 连接地址或整份网络日志到文档。新实现的证据应另建目录，保留本次历史结果，使用新的源码／构建身份，不覆盖或借用旧通过。

## 8. 后续验证的完成条件

- 工具链可行：本次已建立上述两条路径与公开 SPA 观察证据
- 当前阶段完成：按[阶段计划](browser-first-refactor-plan.md)逐项核对真实产品范围、负测、恢复和证据，不以本次探针代替
- 用户体验认可：交互、视觉、工作流是否符合预期另行确认；分 target 可操作不自动等于整体体验通过

本文件和阶段计划都留在 dot 当前环境推进，不要求迁移到 Codex Cloud。后续如果权限、桌面、网络或凭据限制改变，应报告新的实际阻塞，不把历史成功当作当前环境仍可用的证据。
