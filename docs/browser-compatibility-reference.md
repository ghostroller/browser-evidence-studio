# Codex 与原型浏览器参考及兼容性判断

日期：2026-09-23。范围为本机 Windows 安装包、旧原型源码与运行元数据的只读检查，以及 OpenAI 官方说明；不是完整源码审计，也没有操控参考浏览器页面或读取其 Cookie/profile。本轮只做评估和文档维护，没有替换项目浏览器实现。

## 已确认的本机实现线索

检查对象为运行中的 `C:/Program Files/WindowsApps/OpenAI.Codex_26.917.6896.0_x64__2p2nqsd0c76g0/app/ChatGPT.exe` 所属安装目录。

- `resources/owl-electron-app.json` 明确记录 `runtimeName: owl`；`resources/owl-app.ini` 的 AppVersion 为 `26.917.51856`。MSIX 包版本与内部应用版本分别记录，不混为一谈。
- 随包 `chrome.dll` 的 ProductName 为 Codex，FileVersion/ProductVersion 为 **153.0.8010.53**。这是安装文件版本；本轮没有通过网页 navigator 或 CDP 读取实际运行时版本。
- `resources/app.asar` 的包名是 `openai-codex-electron`，构建脚本包含 Owl 类型准备和 shell 启动流程。package 中的 Electron 开发依赖为 42.3.0，不能因此把实际 Owl 运行时当成原版 Electron 42，更不能视为本项目的标准 Electron 44。
- 只读检索 `.vite/build/main-Bx5zswAj.js`：业务浏览器存在 `persist:codex-browser-` 持久分区；`session.fromPartition` 使用 `permissionHandling: browser`，并设置 `setPermissionPromptHandler`。这表明存在浏览器式原生权限处理能力，不意味着所有权限默认允许。
- 同一 bundle 中有 `webContents.debugger.attach`、target attach/detach，以及用于原生弹窗接管的 `_createWebViewAdoptionLease`；后者的错误描述明确指向 Owl browser sidebar webview。浏览器 preload 也包含 IPC、DOM 观察等逻辑，不能宣称参考浏览器完全无注入。
- 本轮未在所检索 main bundle 中找到 `setUserAgent`、`userAgentFallback` 或 `setProxy` 字面量。这个负结果不覆盖其他模块、压缩后的代码或原生层，不证明没有 UA/代理配置，更不是可直接复制的完整浏览器指纹。

这些证据支持的结论是：**本机版本使用自标识为 Owl、具有定制浏览器能力的运行时，不能按普通 Electron WebContentsView 的全部行为推断。** 本轮未取得 Owl 原生层实现，不能据此说明其 Client Hints、TLS、权限或自动化特征的全部细节。

## 代理对照

在实际用户上下文通过 `Get-NetTCPConnection` 只读检查，Codex 进程 PID **23164** 当时有 **18 条 Established** 连接到 **127.0.0.1:7897**。`Get-CimInstance Win32_Process` 确认该 PID 是上述安装目录的 ChatGPT.exe，角色为 `network.mojom.NetworkService`，父 PID **20296**。仅输出进程角色和相关参数是否存在，没有保存完整命令行或请求内容。

因此可以确认 Codex 桌面应用的 Chromium 网络服务也使用了该本机代理端口。结合本项目真实京东响应也经此端口，不能把“使用系统代理”本身当作异常原因。连接表没有 URL，尚不能证明具体京东请求使用相同代理规则、协议和最终出口；这些仍属于未完成的对照。

## 旧原型的实际浏览器与采集对照

用户反馈 `D:/workspace/agent-browser-evidence` 启动的浏览器也能正常登录、加载京东，并提供控制服务端口 **65134** 和 `output` 目录。该页面是本地录制控制台，业务浏览器由 Playwright CLI 另外启动。没有调用控制页接口或使用其 URL 中的凭据；原型仍由 human 控制，未修改旧仓库。

只读取最新运行目录 `output/ui-2026-09-23T06-22-47-907Z-66c91215` 中的 manifest、provider 状态和启动配置的必要字段，并关联进程身份：

- run ID 为 `run-d36b25b6-bc29-4897-a594-69ef24b22a78`，创建时间为 `2026-09-23T06:22:49.154Z`；读取时未封存，状态为 `human / recording / waiting-human`，provider 同时记录 `recording: true`、`tracing: true`。
- 实际配置为 `browserName: chromium`、`isolated: true`、`channel: chrome`、`headless: false`。manifest 中通过运行时 `browser.version()` 保存的版本为 **153.0.8010.53**。CLI 未指定 browser 时回退到 Edge，但网页下拉框首项为 Chrome；本次以实际配置为准。
- provider PID **31512** 与 Chrome 根进程 PID **30428** 的父子关系吻合。实际可执行文件是 `C:/Program Files (x86)/Google/Chrome/Application/chrome.exe`，文件版本同为 **153.0.8010.53**。因此本次使用完整的本机 Chrome，未使用 Electron WebContentsView。
- Chrome 根进程有 `--remote-debugging-pipe` 和 `--disable-blink-features=AutomationControlled`，没有观察到 `--enable-automation` 或显式代理开关。本项目兼容策略已经包含相同的 AutomationControlled 开关，继续重复添加它不能消除现有差异。
- Chrome 的 NetworkService PID **27644** 当时有 **7 条 Established** 连接到 **127.0.0.1:7897**。原型也经过这个代理端口，但连接表仍不能证明具体京东请求的最终出口一致。

启动依据为旧原型 `src/providers/playwright-cli.ts:75` 的 channel 配置和 `src/session.ts:19` 起的调用链：先 prepare，再 `tracing-start`、`recording-start`，最后 `goto`。项目锁定 `@playwright/cli 0.1.21`，本机安装的 Playwright/core 为 `1.64.0-alpha-1789764292000`，运行 Node 为 `24.15.0`；这些是对照环境记录，不是本项目依赖迁移建议。

采集实现也不是“无 CDP、无注入”：原型安装的 `node_modules/playwright-core/lib/coreBundle.js:68871` 明确开启 trace 的 screenshots/snapshots/live；`:36763` 启用 CDP Network，`:35104` 起注册 recorder bindings 和脚本，`:15549` 起通过 addInitScript/main-world evaluate 注入 trace snapshotter。原型业务源码未配置 route/interception，依赖默认不启用请求拦截；本项目采集同样没有使用 Fetch.enable 或 request interception。

| 差异 | 原型本次运行 | 当前客户端 |
| --- | --- | --- |
| 浏览器 | 完整 Google Chrome 153.0.8010.53 | Electron 44.4.3 / Chromium 152.0.7977.130 |
| 会话 | Playwright 配置 isolated context | 按项目/profile 的持久 session partition |
| 采集 | Playwright recorder、trace DOM snapshots、Network CDP | 独立 Puppeteer 观察连接、isolated-world rrweb 连续采集、Network CDP |
| 调试通道 | remote-debugging-pipe | loopback remote-debugging-port，独立操作/观察连接 |
| 页面权限 | Chrome/Playwright context 的行为；本轮未逐权限探测 | session 的权限 request/check 统一拒绝 |

**用户报告原型京东正常；本轮独立核验了浏览器和录制环境，没有重新完成京东业务验收。** 这使完整 Chrome 成为更直接的对照，也说明“有自动化、CDP、录制、页面注入或使用代理”本身不足以解释客户端异常。仍不能排除本项目特有 rrweb/CDP 行为、Electron 原生能力、session/profile 或具体代理请求路径；不能将主版本差异或 pipe/port 差异直接写成根因。

## 官方公开范围

[OpenAI Browser 文档](https://learn.chatgpt.com/docs/browser) 确认：桌面内嵌浏览器有独立于常用浏览器的 profile，可直接登录网站；Developer mode 提供受控 CDP 调试。[浏览器扩展文档](https://learn.chatgpt.com/docs/chrome-extension) 描述的 Chrome/Edge 现有标签和登录态接入是另一条路径。不能把桌面内嵌浏览器、浏览器扩展和云端 Work 浏览器视为同一个实现。

本轮查询的官方说明没有提供 Owl 原生源码、桌面 UA/UA-CH 配置、内核精确版本或系统代理继承细节；上节安装包发现属于本机实证，不冒充官方架构承诺。

## 对本项目的参考价值

| 维度 | 本机 Codex 的已见证据 | Browser Evidence Studio 当前实现 |
| --- | --- | --- |
| 运行时 | Owl 标识；随包 chrome.dll 153.0.8010.53 | 标准 Electron 44.4.3；实际 Chromium 152.0.7977.130 |
| 会话 | 持久浏览器分区，官方确认独立 profile | 按项目/profile 的持久 session 分区 |
| 权限 | Owl 浏览器式权限模式及提示入口 | 请求/check 统一拒绝 |
| 页面与控制 | 自定义 webview 接管、原生 debugger/CDP 通道、浏览器 preload | WebContentsView、启动时内部调试端口、独立 Puppeteer 观察连接和 rrweb 连续采集 |
| 代理 | 网络服务连接 127.0.0.1:7897 | 实际京东响应连接 127.0.0.1:7897 |

适合借鉴的是原生浏览器会话与权限处理、明确的页面生命周期和受控调试通道。不能仅把 UA 改为相同文本就推断两者环境相同；也没有证据将当前问题单独归因于 Chromium 主版本差一代。

最小对照与当前执行状态：

1. 将已确认的完整 Chrome 原型作为对照，在同一代理配置下建立完全不启用 CDP 观察和 rrweb 的纯 Electron 页面基线，与当前录制模式比较。该实验用于隔离本项目具体采集实现，不是重新证明泛指的 CDP/录制是否可行。`src/capture/coordinator.ts` 的 pause 仅停止接收记录，stop 仅 detach，均不卸载已运行的 rrweb；必须在新文档首次导航前跳过采集初始化。真实 profile 不复制、不与另一活跃进程并发打开；账号步骤仍由用户参与。
2. 先用同一无账号合成探测页对比完整 Chrome、纯 Electron 和录制模式的 UA/UA-CH、语言、权限、页面可见性及请求头，再依据差异选择修改。特别区分 DOM UAData 与导航/fetch 请求头，不能只看 UA。
3. 若纯 Electron 仍存在站点兼容问题，优先评估设计中已有的 P1 标准 Chrome/Edge 执行模式。原型提供了用户报告可用的参考，但还需验证本项目证据和控制权协议在此模式下的闭环。此项是架构评估方向，尚未决定迁移或新增第二套公共控制接口。

2026-09-23 用户授权后已实现第 1 项的独立入口 `npm.cmd run browser:baseline`，类型检查、独立构建及 5 个合成文档上下文/关闭清理通过。启动器隐藏窗口问题修正后，用户明确反馈无采集窗口的 **首页和订单均正常**。随后 `--recording` 启动全新工作区的普通客户端，用户也确认正常登录、查看订单；agent 检查了当前订单截图，固定区间 841 条已记录响应均为 200/304，两页均有 rrweb 快照。详见 [普通录制新环境实测](verification.md#全新-profile-的普通录制京东访问确认2026-09-23) 和 [运行方法](environment.md#无采集浏览器对照)。

| 已执行对照 | 京东结果及证据 |
| --- | --- |
| 旧 profile / 普通录制 / 当前兼容策略 | 异常截图及核心接口 403 |
| 全新 profile / 无调试和采集 | 用户确认首页、订单正常 |
| 全新工作区与 profile / 普通录制 | 用户确认正常；订单 checkpoint 完整，采到的响应未见 403，rrweb/CDP 正在运行 |

该结果不支持把 Electron、CDP 或 rrweb 作为必然触发原因。优先保留可用的新环境，在默认客户端以新命名 profile 复验旧会话因素；不删除旧 profile、不复制登录态。仍未隔离具体站点存储、登录历史、进程或时间变化，不能宣称旧 profile 已损坏。普通录制的队列预算触顶和活跃 manifest 健康字段缓存问题另行处理，不与网站是否可用混为一谈。第 2 项完整跨浏览器探测与第 3 项执行模式评估尚未实施，当前不需要因此立即迁移内核。

### 归因强度与下一组鉴别对照

目前能确认的是旧环境中“界面已有登录信息，但核心业务请求返回 403”；不能将其直接写成登录凭据错误、账号封禁或已证实的京东风控。空正文 403 不解释拒绝的具体策略，也不足以单独确认拒绝由源站还是中间网络环节产生。

新旧普通录制对照并非仅改变一个 profile：`scripts/browser-baseline.mjs --recording` 同时使用新的 userData 根、新进程和重新登录，并将宿主 UI 固定为独立构建的 file renderer；旧客户端为 Forge/Vite dev 宿主。时间与具体请求出口也没有严格控制。因此当前最强结论仍是“旧运行环境/会话相关状态优先可疑”，不是“已证明旧 profile 损坏”。

下一组最小鉴别实验是在原开发客户端保持版本、账号、代理配置和采集设置一致，在短时间内依次检查旧 profile、同一数据根中新建的 profile、再旧 profile，不先清除旧数据。若稳定旧失败/新成功，可较强归因为 profile/会话相关状态；若两者均正常，则旧故障暂不可复现；若均失败而独立实例仍正常，应检查 userData 根、进程及 dev/file 宿主差异。只有第一种结果成立后，才值得进一步验证“仅在旧 profile 重新登录是否足以恢复”；这仍不等于已定位到某一个 Cookie。

上述对照不能预先承诺解除京东接口拒绝。此前有采集模式的真实京东复测仍为失败，详见 [受控实测](verification.md#京东兼容调整后的受控实测2026-09-23)。
