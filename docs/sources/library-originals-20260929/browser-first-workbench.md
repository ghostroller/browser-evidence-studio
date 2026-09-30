# 架构决策：浏览器优先的工作台与可替换浏览器运行时

日期：2026-09-30  
状态：建议采纳方向；先实施 B0/B1 的观测验证，不授权一次性全量重写。  
审查基线：`63029811ce3485b4cdeeafc7f2105091432fc267`。  
相关资料：`docs/README.md`、现行产品规范 13/14、`WORKSPACE-UX-20260929.md`。

本文件讨论开发与运行边界，不重新定义项目、保存点、固定资料、登录环境或验收规则。13/14 仍管理产品语义；本文件获用户采纳后，只替代其中“必须在 Electron 中开发/操作前端”的实现前提。不要又启动旧 A–G/R/Q 全部工作包。

## 0. 决策摘要

**推荐解耦，但先让同一套工作台在普通浏览器中实际可用，随后才按收益提取纯 Node 核心和外部 Chromium 运行时。** 不要求所有后端代码都提取完成，才看到第一张真实页面。

建议目标：

```text
同一份 React 工作台（保存点 / 存档 / 管理 / 结果）
    ├─ 浏览器宿主：HTTP + 增量通知
    └─ Electron 宿主：IPC 或同一受保护本地 HTTP
                        ↓
              共享应用服务与持久存储
                        ↓
          BrowserRuntime 明确契约与能力报告
              ├─ ElectronRuntime：保留现有 profile 与嵌入模式
              └─ ChromiumRuntime：受控外部 Chromium、独立 profile
```

历史回放使用同一份标准 Web ReplaySurface，不因为客户端不同维护两个播放器。原始采集、资源验证、来源映射、固定版本、批次输出继续共用已有实现。

**本轮最优先解决的是低成本观察和修改循环，不是发布一个多用户远程浏览器服务。** 开发过渡期允许 Electron 仍作为本地后端/受控浏览器宿主，但界面由普通浏览器打开；必须标注“Web UI + Electron companion”，不能声称已经是纯 Node。

### 三个验收层级不能混同

| 层级 | 实际含义 |
|---|---|
| UI 可运行于 Web | 无 preload 也能使用同一组件和真实服务；可能仍需要 Electron companion |
| Node 独立后端 | 应用服务可由 `node` 启动，核心依赖图无 Electron 运行时导入 |
| 外部 Chromium 完整业务路径 | 独立运行时可以录制、读写、取消、恢复和执行，且有明确能力与 profile 边界 |

把 IPC 换成 fetch 只达到第一层的一部分，不自动达到后两层。

## 1. 本次审查确认的事实

### 1.1 已有成果要保留

最新远端 main 是 `63029811...`，提交为文档收尾；交接报告的实际最终源码/构建为 `7810f932...`，记录 77 文件/515 项测试、类型检查、生产构建、五种数值/完整性变体、正常重启及浏览器专项通过。它明确不等于所有 IA01–IA30 都由陌生用户独立盲测，也不代表用户已经接受交互。[R1][R2]

本次没有在 Windows/Electron 重新运行这些测试；没有读取被忽略的私有录制、profile、截图与完整失败日志。以下是定向源码审查和已提交记录对照，不是全仓无遗漏审计。

### 1.2 当前架构中值得调整的边界

| 位置 | 已确认情况 | 改造含义 |
|---|---|---|
| `src/preload/ui.ts` | 只有 call/onChanged/bounds 三类桥接能力 | 已有一个很小的传输切换入口，可先从这里取得收益 |
| `src/renderer/app.tsx` | 声明 `window.studio.call(string): Promise<any>`；业务视图直接调用；状态、页面选择、历史、执行集中 | 添加类型化客户端并注入；不要把 Electron 检测散布到每个按钮 |
| `src/renderer/lib/browser-presentation.tsx` | DOM bounds/overlay/drag 驱动原生 view 的隐藏和布局 | 这是桌面呈现适配，不应是所有前端宿主的必需业务机制 |
| `src/main/services/studio.ts` | 项目、session、采集、执行直接依赖 Electron Session、WebContentsView、StudioWindow、菜单和剪贴板 | 后端不是现成可独立 Node 服务；需要按依赖边界逐步提取 |
| `src/main/services/replay-host.ts` | 临时原生 view、定制协议、executeJavaScript 字符串构造 rrweb 和选择层 | 把播放与选择逻辑提成标准模块；保留隔离和来源验证 |
| `src/capture/coordinator.ts` | 主流程基于 Puppeteer Page/CDPSession，未直接导入 Electron；PageIdentity 仍要求 webContentsId | 很多采集能力可复用；去掉强制 native 身份依赖需明确迁移语义 |
| `src/main/api/server.ts` | 现有 HTTP 是 Agent API：有限路由、Bearer、任务授权、严格 Host/Origin | 不能直接当成拥有全部 UI 权限的浏览器后端 |
| `src/main/app.ts` | 已开启本机 CDP；生产入口还承担大量 BES_TEST 分支调度 | 当前并非只能 OS computer use；测试启动与应用装配应逐步分开 |

源文件见末尾 [R3–R10]。文件大不是单独的缺陷证据，但多种职责与状态所有权确实在同一组件/服务中交织。不要以“拆成更小文件”代替明确数据流和副作用边界。

### 1.3 本轮记录反映的反馈循环问题

- 实现映射区被分栏挤成零高，直到真实 Electron 数值旅程才暴露；随后才加入 elementFromPoint 命中检查。
- 独立复走全部使用 OS computer use；可访问树、坐标和截图有时不同步，滚动后需要重复观察，原生下拉操作退回键盘。
- 原生窗口采样有 GetFrame 警告与较长间隔，窗口缩放也需要 OS 操作。
- 例证仍以 UUID/bound 为主要解释；新增现场、再绑定到字段、保存字段分成多个步骤；字段和管理表单操作距离仍长。

这些来自交接记录。[R2][R11] 其中有些具体缺陷后续已修，不能继续把它们当现存失败；但它们证明了布局反馈很晚、工具摩擦较高。业务流程能到终点并不证明点击次数、信息层级和反馈足够好。

## 2. 分开理解三种“浏览器”

### 2.1 工作台浏览器

运行本项目 React UI，展示保存点、表单、管理、结果。应使用普通 HTML/CSS/DOM，可由 Codex 内置浏览器或受控浏览器测试工具读取 DOM、样式、网络和截图。

它无需拥有用户业务站点的登录状态，不负责在自己的 origin 中执行被采集网页。

### 2.2 受控目标浏览器

负责登录环境、人工示范、页面动作、rrweb/CDP 采集和脚本执行。可以是现有 Electron guest，也可以是专门启动的外部 Chromium。由服务端拥有，具有独立 profile、target 与租约身份。

它**不等于** Codex 当前展示工作台的浏览器。不能假定内置浏览器中的登录、tab 或 CDP 权限会自动传给目标运行时；必须验证现场工具确实能连接哪个目标。

### 2.3 历史回放浏览器文档

从已保存材料重建，用于时间轴、观察和标注，不执行原站业务逻辑。它可以在普通浏览器的隔离 frame 中运行，不必是另一个 Electron 原生 view。

这三者分开后，大部分工作台布局与历史选择能够用标准 Web 工具测试；网站登录与采集使用单独受控目标；剩余 OS 行为仍需要少量桌面检查。

## 3. 方案可行性与不成立的捷径

### 3.1 可行且优先做

- 同一 React 界面经注入客户端运行于 Electron 与浏览器。
- HTTP/通知层调用共享业务服务，不维护一套“Web 演示业务”。
- rrweb 播放、精确定位、选择层成为标准 Web 模块；来源与材料完整性仍在服务端验证。
- 通过已有 CDP/Puppeteer 自动化目标页面，并将必要 DOM/console/网络诊断交给开发 Agent。
- 由最终 Electron 包启动/停止服务，处理窗口、文件对话框、系统集成、必要嵌入视图。

### 3.2 任意网站不能简单嵌进工作台 iframe

第三方网站可能禁止被嵌入；即使允许嵌入，跨源也限制父页面读取内部 DOM。跨域代理、改响应头或关闭 webSecurity 不是可接受修复。[E1]

第一版 Web 开发模式让目标 Chromium 独立显示，并提供明确的“打开目标页面/进入选取”动作；实时选择由目标运行时产生带身份的回执。不能为了保持当前分栏外观先做通用远程桌面。

必须在单页内显示目标画面时，CDP screencast/WebRTC 是另一项独立工程：画面是像素，不会自动成为 Agent 可检索的 DOM；输入法、焦点、缩放、弹窗、拖放、文件选择、延迟与流控都要额外处理。它会增加恰好想减少的工作，不纳入本次最小改造。

### 3.3 Electron 不是只能通过坐标自动化

本项目现在已经开启本机 CDP 并使用 Puppeteer。开发驱动器可以识别 UI target 与目标页面，按 DOM 定位、读 console/网络、截图，减少 OS 操作。Playwright 也提供实验性 Electron 自动化，但引入它不是开始优化的先决条件。[R8][E2]

优先复用现有工具；若增加一个测试 runner 能明显减少定位/trace 维护，才在 devDependencies 中加最小实现。不要顺便把业务 Puppeteer 全部换掉。

### 3.4 “任意浏览器”是目标，不是第一提交的兼容承诺

先验证实际 Codex 内置浏览器和标准 Chromium/Edge。UI 只用标准 Web 能力，文件目录选择、剪贴板和下载等经 ShellCapabilities 声明并做可理解降级。Safari/Firefox 全矩阵不作为首批完成条件，受控业务运行时仍明确要求兼容 Chromium。

## 4. 推荐边界：只提取当前变化所需的接口

```text
src/renderer/                    同一 React 工作台与场景
  client/                        typed WorkbenchClient + HTTP/IPC adapters
  replay/                        共享回放/选择前端模块
  shell/                         browser 与 electron 的小型呈现能力

src/application/                 逐步迁入用例服务，不依赖 Electron
src/contracts/                   请求/回执/错误/身份/能力
src/evidence, materials, ...     现有存储与验证，尽量原位复用
src/runtime/                     BrowserRuntime + Electron/Chromium adapters
src/server/                      可独立启动的本地 Node 装配（后续阶段）
src/main/                        Electron 装配与桌面系统能力
```

路径为建议，不要求一次完成目录搬家或改成 monorepo。代码的运行时依赖图比路径名称更重要。

### 4.1 WorkbenchClient

- 首先将现有 call/onChanged 变为注入接口；只为首批读写定义精确请求与响应，再按迁入功能扩展。
- 统一错误码、请求 ID、当前实例、项目/版本身份、幂等 operationId 与取消语义。
- Electron adapter 可以保留 IPC；Web adapter 使用明确 HTTP 路由/命令 allowlist 和同源开发代理。不要提供无条件的任意 method 转发。
- onChanged 由 SSE/WebSocket 或已有有界变化接口实现；断线重连先核对实例/版本并获取权威状态，再恢复事件。HTTP 断连不自动表示后端操作已取消或失败。
- 禁止两套草稿、两套领域校验、两套业务实现。
- 不是第一天重写所有 DTO；也不能永远以 string→any 声称边界已经完成。

### 4.2 DesktopShell 与 BrowserSurface

窗口、系统文件选择、下载目录、打开外部链接、剪贴板、native view bounds 属于 shell；并非所有 shell 都支持全部方法。

Web 页面拖动布局不再调用 native presentation。Electron 使用 NativeBrowserSurface；Web 用 ExternalBrowserSurface 显示当前 target/状态和明确入口。暂不支持的能力显示 unavailable，不伪造成功。

后端拥有目标浏览器生命周期；工作台热更新或某个 tab 断连不能立刻关闭目标浏览器或封存记录。可重连状态与应用退出的最终清理分别处理。

### 4.3 ReplaySurface

从 ReplayHost 的 executeJavaScript 字符串提取标准构建模块，复用已有命令序列、pause/seek、资源版本、Mirror 选择与状态机，不从头写另一播放器。

服务端负责固定来源和资源上下文：recording/page/document/epoch/sequence、资源版本与恢复状态。回放端只持有有界播放窗口、派生 DOM 与选择交互；选择回执包含 replayId、generation、anchor、nodeId，服务端重验来源。不能把回放 DOM 改写属性当原站属性。

浏览器资源从受控 HTTP endpoint 读取；Electron 可使用同样 endpoint 或自定义协议 adapter，共用同一 resolver。改写只发生在展示层，旧原件不改。

回放 origin 无管理能力、无用户登录 profile、无真实站点网络 fallback。被归档的内容不能读写管理页面，也不能通过 script/on*/表单/链接发起权限提升。

跨源 sandbox 需要时使用带精确 schema 的 postMessage 或 MessageChannel，校验 source、会话/代际与配对通道；不能以 `event.origin === 'null'` 当唯一身份。若使用允许 same-origin 的外层播放器，仍将内部不可信回放文档放在无脚本权限的独立边界中。父 UI 不需任意读取整个回放文档的高权限。

注意 Cookie 不按端口隔离：不要只换一个 localhost 端口，就认为回放与工作台凭据天然隔开。管理认证、消息路由和资源授权需要实际安全测试。

### 4.4 BrowserRuntime

最小能力：启动/打开 profile、页面目录、导航/受控输入、上下文创建和销毁、CDP事件、截图/采样、对话框/下载、控制与取消、关闭及能力报告。业务步骤仍用普通 Puppeteer，不做新的 Page DSL。

- ElectronRuntime 保留现有 storageRef/partition，并拥有 WebContentsView、native dialogs、物理展示；核心只见平台无关身份。
- ChromiumRuntime 启动明确的专用浏览器与 userDataDir，Node 使用 puppeteer-core/connect 或受控连接。不要扫描/接管用户当前日常 Chrome。
- nativeWebContentsId 只做可选的 provider metadata；不伪造随机整数来满足旧代码。
- 启动顺序：获得 target→按支持范围 attach→安装 recorder/network 监听与初始状态→导航/宣布可录制。避免网站加载完才连 CDP，导致第一段现场缺失。
- 对多 tab、popup、OOPIF/frame、导航代际和响应正文做契约测试；“CDP方法同名”不能代替完整能力验证。
- 探索/执行取消依旧拒绝新命令并处理在途任务，不能简单关闭一个前端页面就宣布业务静默。

## 5. 最容易遗漏的安全和迁移问题

### 5.1 工作台 API 不等于现有 Agent API

现有 Electron 根据可信发送窗口进入 `source:'ui'`，Agent HTTP 走 `source:'api'` 和任务授权。[R8][R9]

Web 客户端不能自行提交 `source:'ui'`，也不能因为来自127.0.0.1就被认为是用户。采用服务端验证过的主体：本地配对工作台、受限 Agent 任务和只读回放资源分别授权。

首批只对显式开发实例开放 Web 工作台：独立合成 BES_DATA、绑定 loopback、严格 Host/Origin、CSRF/WS Origin 防护、短期当前实例配对。配对秘密放在受保护本地发现文件，完成一次明确连接；不放长期 token 到 URL、日志、Vite公开变量、HTML或仓库。前端不应读取 Agent连接文件取得全部能力。

以一次配对获得的工作台会话只能访问该实例/工作区的 allowlist。没有配对、恶意 origin、旧实例凭据、被撤销会话都被拒绝。Vite代理是开发传输，不是鉴权替代。普通 GET 不得有高权限变更副作用。

自动化合成实例的界面授权可以作为测试行为；真实任务的人工确认不因转换成 Web API 而自动授权给开发 Agent。不要用 event.isTrusted 或一个 JSON 字段伪造人类身份。

### 5.2 持久数据只能有一个写入者

Web tab 是同一服务的客户端，不是每个 tab 创建一个 EvidenceStore/Workspace writer。两个后端进程不得同时打开同一个可写数据根或同一个浏览器 profile。断连后通过 operationId 恢复，不因页面刷新重复建项目/卡片。

### 5.3 Electron profile 不等于 Chrome userDataDir

保留原记录的 provider 和 locator，禁止把 Electron partition 目录直接传给 Chrome 或移动/重命名。引入 provider 标签时旧配置默认 Electron，原样继续可读；新 Chromium 环境显式创建，必要时重新登录。跨引擎登录迁移单列，首批不做。

Chrome 官方对默认 profile 的远程调试已有额外限制，专用非默认目录及测试浏览器更合适。[E3] 不利用用户默认 profile 来省一次登录。

### 5.4 Electron 最终交付不是“最后一天才试套壳”

同一 UI 从第一阶段就跑一个最小 Electron 冒烟：载入、真实服务连接、旧资料读取、native surface切换、停止和退出。界面 Web 通过不证明旧 profile、WebContentsView层叠、系统文件对话框和进程清理正确。

目标可以是 Electron 只承担启动/窗口/系统能力；在保留嵌入 Chromium 的产品形态下，它仍需要 native运行时 adapter。不要承诺它完全没有浏览器专用逻辑。

若 Electron 包同时启动外部 Chromium，会有额外体积、进程和更新问题；首批不默认双份浏览器随包。选择系统/打包浏览器的策略必须显式验证，不能因能在开发机启动就认为发行完整。

## 6. 分阶段重构与退出门

### B0：验证工具能力，不先开发新架构

在当前机器上核对：内置浏览器能否访问 loopback开发页面；当前可用 browser tool 是否可看DOM、样式、console、请求和截图；需要何种明确许可。不能假定启用Developer mode就能接任意外部CDP endpoint。[E4]

同时验证已有 Electron CDP 的受控合成入口，明确 UI target、目标业务页、回放 target。试走三个代表操作，记录工具调用数、等待、失败重试与查看布局所需步骤。只汇总这几项，不另造用量观测系统。

若工具限制无法解决，先交付现有 Electron 的 DOM驱动测试/截图入口；不要花几天迁移到一个实际打不开的 Web 页面。

### B1：同一工作台的真实 Web 开发路径——首批必须交付

1. 最小客户端类型与 HTTP/IPC adapter，容器注入，同一份 React 页面。
2. 有实际鉴权的本地工作台服务；临时由现有 Electron companion承载真实业务允许，但在启动信息中如实标明。
3. 普通浏览器完成项目管理、工作副本、保存点编辑、固定版和结果查看，使用真实服务与磁盘，不是全部window.studio mock。
4. HMR 修改 CSS/组件可即时观察；热更新不重启 recorder/profile。前端刷新恢复正确实例和当前资料，不重复写入。
5. 先拆真正影响本批的视图控制：材料编辑会话、存档浏览、项目切换拥有明确状态。不要在迁移时顺手改变业务数据结构。
6. 实际打开至少两种窗口尺寸下的同一页面，检查关键控件尺寸、可点击性、滚动、焦点与截图；修本次可见问题。

**B1完成门：** Agent 在普通浏览器修改→观察→操作→确认持久数据至少三条流程，不依赖OS坐标；Electron仍能运行同一UI。输出实际源/构建、URL、实例、支持能力、剩余native边界。没有需要完整迁移才能得到的“空壳预览”。

### B2：历史回放进入标准 Web 组件

从现有安全ReplayHost迁出共享渲染模块，首个纵向是：已有合成存档→加载历史→暂停/seek→选中节点→绑定字段→固定版本→刷新重读。保留旧来源模型和资源缺口语义，正确/错值/无来源三态不退化。

跨站业务页此时仍可以由Electron companion或独立目标窗显示；B2不同时建设全量Chromium provider或视频传输。

**B2完成门：** 同一份回放组件在Web与Electron均可用，生成的历史引用被同一服务正确核验；攻击回放不能访问工作台权限；资源不联网补；同刻顺播/seek一致。

### B3：把应用核心提成纯 Node，增加外部 Chromium

仅在B1/B2确实改善开发反馈后实施。按用例逐步解开Studio中的window/session/menu等依赖，复用现有Node领域模块，保持每次提交可运行。

初次纵向：专用Chromium环境→启动前已准备采集→一次示范→字段源采样→保存→停止→离线回放→固定版本执行。无Electron进程仍成立，才叫Node独立后端。

记录能力矩阵，特别是CDP/frame、Cookie/存储、取消和对话框/下载差异。已有ElectronRuntime不删除，保留旧登录状态兼容；新旧runtime不得共享同一个可写profile。

### B4：双端回归与发行整合

选核心合同在两个runtime上运行，比较业务语义、来源身份自洽和错误分类，不要求跨不同浏览器版本原始字节/截图hash完全相同。旧原件仍按其原hash验证。

Web工作台跨浏览器兼容与CDP目标兼容分别验证。Electron包运行同一业务服务和UI，只保留必要shell smoke；现有长测按变更影响重跑，不无条件删除也不每次CSS修改都全跑。

## 7. 最小人力的验收与反馈方式

不让用户重新写几十页规格。保留现有13/14语义，只对三个关键状态建立可见基线：

1. 默认保存点工作区：用户能否立即识别当前对象与主动作。
2. 查看旧存档/派生编辑：只读与可写模式是否清楚，是否误改另一份资料。
3. 字段绑定/错误结果：选择目的、源例证、保存状态和返回路径是否直接可见。

Agent先在真实浏览器中做出这些页面，用固定合成数据展示，再由用户做一次聚焦反馈；之后由截图/DOM几何和场景回归保护。对齐的是实际界面，不是再用文字承诺“紧凑清晰”。

自动验收允许读DOM、role/name、样式、日志并通过正常点击/输入操作；禁止直接设置React state、隐藏dispatch预造业务资料、用force click穿过遮挡、修改原件或借其他任务的成功结果。

测试分层：

| 层 | 目标 | 何时运行 |
|---|---|---|
| 纯模块 | 规则、关系、幂等、来源/恢复 | 高频定向 |
| Web真实服务/UI | 大部分创作、管理、结果、布局/滚动 | 每个UI包，修改后立即 |
| runtime合同 | 采集、目标身份、控制权、cancel、profile | 对应运行时变更 |
| Electron smoke | native view、系统对话框/菜单/下载、DPI、退出 | 稳定集成点与发行 |
| 真人/真实站点 | 账号验证、代表性外部页面和最终易用性 | 明确授权的小范围，不代替合成回归 |

不用一次完整空根录制跑完所有领域来查一处CSS；可用已经存在的合法合成资料做定向布局场景。最终普通用户旅程仍从空根创建同一份任务并执行，不让fixture成为隐藏捷径。

## 8. 成本、收益与不该做的扩张

| 方案 | 开销/风险判断 | 本项目建议 |
|---|---|---|
| 补现有Electron DOM/截图调试入口 | 最小，直接复用现有CDP | 立即验证，作为保底 |
| 共享Web工作台+真实伴随服务 | 中等，主要在传输、配对、UI状态边界 | 首选首批 |
| Web历史播放器 | 中等，有资源隔离/消息身份要求 | 首批之后紧接着做 |
| 纯Node+外部Chromium全链路 | 较高，生命周期/profile/采集合同迁移 | 验证收益后逐步做 |
| 内嵌远程像素流、云端多人、任意站点透明代理 | 高且不直接解决DOM可观测性 | 本阶段不做 |

这是相对工程判断，不是已实测人日或模型耗时承诺。现有代码虽有可复用边界，也有明显耦合；不能说“改一行preload就能完全拆开”。

首次投入只应购买一个能用的反馈循环。如果先写了一大套抽象、移动很多文件、启了多个agent，却仍无法在浏览器里打开并操作真实工作台，就没有达到首批目标。

同样，不要为了追求Web纯度永久维护两套产品。B1伴随方案明确过渡，B3增加provider时有契约测试和移除临时接线的清单；抽取失败可以回退adapter，不回滚原始资料。

## 9. 主要问题来源的评估

以下是根据当前源码、交接和用户反馈作出的工程判断，没有任务日志统计支持的百分比分摊。

- **开发反馈环境：当前最高优先改进项。** 太多普通CSS/表单问题要到Electron/OS测试才显现，页面DOM/几何/console没有成为日常开发入口。
- **边界设计：同样重要。** 工作台展示、浏览器控制、录制、材料和授权在Studio及大型组件中相互影响；因此微小界面变化会触及native生命周期。
- **产品描述：早期有缺口，现阶段不应主要再归咎用户。** 草稿/卡片、版本和环境的约束在13/14已明确；还需少量视觉/状态实例，而不是再次要求用户扩写大需求。
- **功能复杂度：客观较高。** 这是录制器、离线浏览器回放、资料编辑、执行与证据验证的组合，不是普通CRUD；跨站保真和运行时差异仍要真实测试。
- **Agent行为：确实有责任。** 过度追求工作包/断言全部关闭、到后期才截图、把“能走通”当“好用”，不应全怪Electron。更强模型也可能在坏反馈环境里反复局部修补。
- **模型能力：可能影响整体判断，但当前不能用结果单独归因某型号。** 建议强模型负责边界决定与首条可运行纵向，明确的UI/测试实施用成本合适模型；不恢复昂贵主控长期做Git与传话。

## 10. 对照项目与可迁移经验

### OpenCode

当前官方仓库的桌面包使用 Electron，并依赖共享的 `@opencode-ai/app`；官方 Web/server 文档说明独立HTTP服务与网页客户端。`packages/app/AGENTS.md` 明确要求本地后端和UI服务分开启动，打开localhost验证UI，并给出agent-browser的snapshot/操作循环。[X1–X4]

可借鉴的是共享UI、独立服务和明确的Agent观察路径。不照搬其具体端口、Bun/Solid/monorepo，不把它当作处理第三方网页嵌入与证据保真的现成方案。

### VS Code

官方2022年文章描述browser/node/electron-sandbox等目标边界和渐进隔离。[X5] 它说明该分层是成熟桌面工程方法，不是本轮AI热潮才出现；不能据此声称所有Electron项目都因Agent做了相同重构。

### OpenAI 的 harness 实践

官方文章描述按worktree启动应用，向Agent提供CDP、DOM快照、截图、导航和可查询日志。[X6] 对本项目最相关的是让Agent直接看见产品，而不是仅收到测试结束摘要。没必要照搬整套日志查询基础设施或无限review循环。

本次未找到足够一手证据来证明普遍存在“Electron项目因AI而全面迁移Web”的趋势；已有双端项目和Agent-native实践足以支持本方案的局部可行性，而不是替你承担运行时特殊问题。

## 11. 仓库规则更新与来源

保持AGENTS短。获采纳后只增加/替换两条稳定约定：

- 工作台UI应能通过共享客户端运行于Web与Electron；平台能力经adapter隔离。业务、证据与身份契约只有一份，不为Web演示另造实现。
- 前端开发优先在获授权合成实例中用DOM/样式/截图和真实服务验证；禁止伪造业务状态。Electron专有能力另做小型native验收，不默认用OS坐标覆盖全部UI。

`docs/README.md` 链接本文件和 `docs/development/agent-ui-feedback-loop.md`。13/14保持产品主规范，历史交接不改写；不要再把模型/临时阶段列表塞进AGENTS。相关用户文档按现有规则纳入Git，本文件不授权push或修改真实数据。

### 固定源码

以下均是本次通过GitHub插件读取的版本：

- [R1] [main提交](https://github.com/ghostroller/browser-evidence-studio/commit/63029811ce3485b4cdeeafc7f2105091432fc267)
- [R2] [WORKSPACE-UX交接](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/docs/refactor-handoffs/WORKSPACE-UX-20260929.md)
- [R3] [preload桥接](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/preload/ui.ts)
- [R4] [App](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/renderer/app.tsx)
- [R5] [BrowserPresentation](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/renderer/lib/browser-presentation.tsx)
- [R6] [Studio](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/main/services/studio.ts)
- [R7] [ReplayHost](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/main/services/replay-host.ts)
- [R8] [Electron装配与测试入口](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/main/app.ts)
- [R9] [Agent API](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/main/api/server.ts)
- [R10] [CaptureCoordinator](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/src/capture/coordinator.ts)
- [R11] [独立复走及工具摩擦](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/docs/refactor-handoffs/WORKSPACE-INDEPENDENT-20260929.md)
- [R12] [依赖与启动入口](https://github.com/ghostroller/browser-evidence-studio/blob/63029811ce3485b4cdeeafc7f2105091432fc267/package.json)

### 官方技术来源（2026-09-30核对，文档可能继续变化）

- [E1] Electron Web Embeds：<https://www.electronjs.org/docs/latest/tutorial/web-embeds>
- [E2] Playwright Electron（实验性）：<https://playwright.dev/docs/api/class-electron>
- [E3] Chrome 远程调试与专用profile：<https://developer.chrome.com/blog/remote-debugging-port>
- [E4] Codex/ChatGPT内置浏览器与Developer mode：<https://developers.openai.com/codex/app/browser>
- [X1] OpenCode desktop package：<https://github.com/anomalyco/opencode/blob/dev/packages/desktop/package.json>
- [X2] OpenCode app开发约定：<https://github.com/anomalyco/opencode/blob/dev/packages/app/AGENTS.md>
- [X3] OpenCode Web：<https://opencode.ai/docs/web/>
- [X4] OpenCode Server：<https://opencode.ai/docs/server/>
- [X5] VS Code渐进sandbox分层：<https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox>
- [X6] OpenAI harness工程实践：<https://openai.com/index/harness-engineering/>
