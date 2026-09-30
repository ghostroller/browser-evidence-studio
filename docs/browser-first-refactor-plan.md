# 浏览器优先、双宿主与多后端重构计划

日期：2026-09-30（UTC）。规划基线为 `19a17c4`，实施后逐切片记录新的源码与构建身份。

依据：[共享设计页面正文](sources/browser-first-shared-design-body.md)、[来源与原附件缺失说明](sources/browser-first-shared-design-source-notes.md)、[dot 工具链实测](dot-environment-toolchain-validation.md)。三个声明的原附件尚未取得，因此本计划是基于可见设计和当前代码的可执行补充，不能冒称原附件的全部要求或 F01–F14 原始验收清单。原件取得后做差异复核，不从记忆补造条款；已明确、可逆且保持行为的首切片无需因缺件停下。

## 1. 当前目标和推进顺序

以同一 React 工作台、共享业务服务和共享回放模块支持浏览器／Electron 两种宿主。先改善真实 UI 的开发反馈，再根据已取得的收益抽取纯 Node 服务与外部 Chromium provider。保留现有 Electron 可运行路径，不以完成 B3 为 B1 的前提。

用户已要求在整理文档后开始实际重构。**B1.1：类型化 WorkbenchClient 边界与 Electron adapter 已实现**，代码节点为 `1918012`；详见[实际验收交接](refactor-handoffs/BROWSER-FIRST-B11-20260930.md)。它不是 B1 全部完成，也不等于浏览器版已经可用。B0 已有工具链证据，但仍需为当前候选建立可重复启动、身份与关键界面的开发基线。

### 当前阶段状态（2026-09-30）

- B0：工具链可观察性已证明；完整产品／视觉基线未全部验收
- B1.1：90 方法契约、唯一 bridge adapter、React 注入、native capability 和缺桥诊断落地；typecheck/build、19 文件110项定向测试、blur-copy正反3轮及真实 Electron 工作区封存回放通过。workspace-browser 候选两次与旧基线一次同点 focus 断言失败，根因未定、后半段未测，不宣布全部桌面验收通过
- B1.2：开始独立的传输核心与纯内存 fixture 验证，尚未接入应用；B1.3 尚未实现。现有 Agent 权限不放宽
- 原生 focus 后续定位：已证实 Electron alert/confirm 的 CDP 回应未释放原生模态框，见[对话框生命周期问题](refactor-handoffs/ELECTRON-DIALOG-LIFECYCLE-20260930.md)。修复策略涉及回应所有权与自动化能力，待用户选择；不阻塞独立传输核心实施
- B2–B4：仍为后续计划；旧 profile、字段语义和数据格式未迁移

依赖主线：

```text
B0 工具与当前产品基线
  → B1.1 client/IPC 行为保持切片
  → B1.2 受保护的合成工作台 HTTP/SSE 连接
  → B1.3 同一真实工作台编辑、复制、版本与刷新回读
  → B2 共享隔离 Web 回放与历史元素选取
  → B3 纯 Node 服务与 Chromium provider 的完整纵向
  → B4 双端共同回归与发布收敛
```

B2 隔离设计可在 B1 期间准备；B4 的 Electron 冒烟从 B1 开始持续执行。避免同一次提交混入 client 搬迁、认证方案、数据迁移和播放器重写。阶段推进依据可观察结果与实际风险，不用目录数量或测试总数代替。

## 2. 不变的产品与安全约束

- [13：对象归属和管理](refactor/13-workspace-archives-and-management.md)与[14：交互规格](refactor/14-interaction-spec-and-acceptance.md)继续规定业务行为；此次架构重构不自行改变字段语义、保存点归属、固定版本或验收结论
- 原件、工作副本、固定资料、执行与核验保持分离；缺失、损坏、排除和真实空值不折叠
- 保留项目／profile／session／page／target／generation／lease／operationId 等现有身份、幂等、版本冲突和取消边界；搬层不是放宽检查的理由
- 旧 Electron profile 继续使用原 `partition/storageRef`，不移动、不改名、不交由 Chromium 直接复用。新增 provider 元数据及兼容读取须先定义，账号迁移是单独决策
- 工作台、业务 Agent、隔离回放是不同权限主体。浏览器不可通过请求字段自行声明 `source: 'ui'`，现有 Agent API 的 trusted-only 限制不能删除
- 保留 sandbox、contextIsolation、webSecurity、离线资源白名单与回放来源验证，不以扩大 CORS、注入真实网页 HTML 到管理 DOM 或公开原始 CDP 获得便利
- 不在此计划中引入远程画面串流、云端多用户、monorepo、新自动化平台或 Codex Cloud 迁移

## 3. 当前代码落点与拆分风险

以下为当前文件抽样核验，不是对整库完成新架构审计的声明。

| 当前落点 | 现状 | 对实施的含义 |
| --- | --- | --- |
| [preload/ui.ts](../src/preload/ui.ts) | 暴露 `call/onChanged/bounds` | 现有 IPC adapter 可以很薄；先保持 channel 与调用语义 |
| [renderer/app.tsx](../src/renderer/app.tsx)、[index.tsx](../src/renderer/index.tsx)及多个组件 | 直接访问 `window.studio`；global 类型在 app 中；大量 string/any 调用 | client 需集中注入与类型化，不能仅把同名全局对象搬到浏览器 |
| [client-types.ts](../src/main/services/client-types.ts) | 已有部分 type-only 端口类型 | 复用现有 DTO，补足共享契约，避免前端运行时依赖 main/Electron |
| [app.ts](../src/main/app.ts)、[ui-ipc.ts](../src/main/ui-ipc.ts) | 精确可信窗口检查后 dispatch `ui`；有 `studio:changed` 推送 | 不更改可信主体语义；事件订阅与销毁必须保真 |
| [api/server.ts](../src/main/api/server.ts)、[dispatch.ts](../src/main/services/dispatch.ts) | Agent API 有边界和任务授权；部分管理/展示操作仅 UI 可用 | B1 的浏览器工作台认证应独立建模，不能复用全权 Agent token 或放宽全部路由 |
| [browser-presentation.tsx](../src/renderer/lib/browser-presentation.tsx)、[window.ts](../src/main/window.ts) | DOM bounds、遮罩、拖动与原生 view 同步 | 原生呈现是 host capability；不让业务组件散落 `isElectron`，也不虚报浏览器具备原生能力 |
| [studio.ts](../src/main/services/studio.ts) | 同时依赖 Electron Session、WebContentsView、StudioWindow、菜单、剪贴板及服务 | 不是可直接由 Node 启动的纯后端；按用例和 provider 边界逐步解耦 |
| [replay-host.ts](../src/main/services/replay-host.ts) | 原生隔离 session/view、资源协议、播放器与选择桥 | B2 提取播放器／选择逻辑时保留代际、来源与资源约束 |
| [capture/coordinator.ts](../src/capture/coordinator.ts) | 核心围绕 Puppeteer/CDP，未直接导入 Electron；PageIdentity 必填 webContentsId | 有复用基础，但身份结构和构建注入资源仍须设计；不能伪造一个 webContentsId 适配 Chromium |
| [workspace-management.ts](../src/main/services/workspace-management.ts) | profile 含 storageRef／partition | provider 扩展必须保守兼容旧数据，不把新目录策略强加于旧 profile |
| [browser-baseline.mjs](../scripts/browser-baseline.mjs) | 现有对照脚本仍使用 Electron | 不能作为独立 Chromium provider 或纯 Node 已完成的证据 |

## 4. B0：先证明当前工具能够观察

**范围与依赖**：当前 dot 桌面、匹配 Node/npm、现有构建与隔离合成数据根。复用普通 Puppeteer；不新增 Agent 平台。

**已经取得**：loopback HTTP/SSE/WS/CDP、真实 Electron UI/live/replay target、UI 到封存回放、临时拆分探针、公开 SPA 观察。详见工具链补充。生产 renderer 在普通 Vite 下缺桥白屏、整窗合成图超时、回放 SVG 图标缺失均已保留，不能抹掉或包装为全通过。

**剩余交付**：
1. 参数化开发启动／观察入口：从 repo 与当前环境解析路径，生成独立数据根、动态端口、实例身份和明确退出清理；不复用本次含绝对路径的临时脚本
2. 记录前端改动至可见结果的实际步骤和耗时；保存默认保存点页、旧存档只读／派生页、字段选择与错误结果页的当前真实截图，标清缺失或尚未覆盖状态
3. 明确如何取得 console/pageerror/requestfailed、DOM/style、UI/live/replay 分 target 图；原生视觉另留验证入口

**验收**：一个新的合成实例可被准确识别并关闭；能观察当前修改而非旧构建；同 URL 替身不能计入；工具链与产品状态分别报告。不要求等待全新基础设施才开始 B1.1，但不得宣布 B0 产品基线已全部验收。

## 5. B1：同一工作台在浏览器连接真实服务

### B1.1 首个可交付切片：WorkbenchClient 与 Electron adapter

**实际状态**：实现及定向／工作区纵向验证已完成，保留 workspace-browser 未通过项；精确源码／构建、失败对照和状态 DTO 的嵌套 any 债务见[交接](refactor-handoffs/BROWSER-FIRST-B11-20260930.md)。以下保留原切片范围与验收要求，不把计划中的全部退出条件自动标为已通过。

**范围**：先只重构客户端边界，生产 Electron UI 行为保持，暂不新增 HTTP 信任主体、不移动业务服务、不改数据格式。

**建议改动位置**（新增名称可由实施者按仓库风格调整）：
- `src/contracts/`：应用 client 的方法／输入／输出映射与可序列化 DTO；复用现有 contracts 和 type-only 定义，避免复制不同语义的同名类型
- `src/renderer/lib/`：WorkbenchClient 注入点与 Electron adapter；明确 native presentation 能力以及未支持能力的失败方式
- `src/renderer/index.tsx`、`app.tsx`、`lib/browser-presentation.tsx`、现有直接调用桥的组件：通过同一 client 使用现有调用；将全局桥声明收敛到桥边界
- `src/preload/ui.ts`：仅在保持兼容确有必要时改类型；channel、可信 IPC sender 校验与后端 dispatch 保持不变

**实现约束**：
1. 不以 `call(method: string): Promise<any>` 改名后冒称完成类型化。优先建立可枚举方法契约，覆盖此次迁移调用；未覆盖项必须明列，不能隐藏在万能 fallback 中
2. 保留 body 缺省值、operationId、请求排序、错误传播、onChanged 退订与现有刷新行为；不把 host capability 缺失处理成无声成功
3. renderer 不导入 main 的运行时实现或 Electron API；仅必要的 type-only 依赖可以暂留并列入后续清理
4. 缺 bridge 时有明确启动错误，不注入生产 fake `window.studio` 伪造成功。契约单测允许 mock transport，产品验收仍走实际 UI
5. 保留 native bounds／presentation 与现有恢复行为，浏览器 adapter 尚未实现时不声称支持原生嵌入

**交付物**：共享 client contract、Electron adapter、实际组件迁移、定向契约测试、真实 Electron 回归结果和本切片变更说明。

**退出条件**：
- 通过 TypeScript 检查；方法输入／结果有类型校验，adapter 不改写业务数据
- 单测覆盖调用／默认 body／异步结果／拒绝错误／订阅和退订／缺 bridge／不支持 capability
- `window.studio` 的运行时访问仅存在于明确的桥 adapter，组件不再直连；测试可通过注入替身检验契约
- 既有 renderer 测试通过，`ui-ipc` 与 API 边界负测不退化
- 新构建真实 Electron 的工作区、保存点与历史回放路径仍成立；原生布局／遮挡受影响时增加桌面验证

此切片可独立提交并回退到原 adapter，不涉及用户数据迁移。它完成后应立即展示真实 Electron 证据，再进入浏览器传输实现。

### B1.2 受保护的本地工作台传输

**依赖**：B1.1 契约、B0 可重复启动。可暂时保留 Electron companion 承载 Studio；不声称纯 Node 已成立。

**范围与交付**：先仅对明确的隔离合成实例实现工作台配对／短期会话、绑定当前 instance 的 HTTP adapter 和有界变更通知。服务端根据已验证会话决定权限，不接受客户端指定调用主体。正式实现前写清配对入口、允许 Origin/Host、会话过期／退出销毁、操作白名单与事件重连策略。

**验收**：
- 同一 client 的最小读写用例实际到达伴随服务，并在断线后准确显示状态；严格认证，不把 Agent 连接文件/token打包进 Vite
- 未认证、过期、错误 instance、错误 Origin/Host、跨项目／越权操作均失败；事件流也需认证，不把凭据放 URL 查询或日志
- 重复提交沿用 operationId／版本冲突；请求取消、迟到响应、SSE 重连不导致重复写入或旧状态覆盖新状态
- Electron IPC 路径保留并通过冒烟。临时探针的 401/403 仅作设计参考，不能替代这些生产负测

### B1.3 同一真实工作台的浏览器纵向

**依赖**：B1.2 的受保护真实服务。使用同一 React 组件和业务模型，由入口注入 HTTP client；Vite 热更新必须反映本地改动。

**交付与验收场景**：从真实服务创建／读取合成工作副本，完成保存点资料编辑、复制／派生、查看存档版本，再刷新回读。验证版本身份与内容，不仅看成功通知。重复点击、取消、切换项目／版本、失败恢复和页面重连均不得串写。

浏览器尚不具备的实时嵌入或旧原生回放能力明确呈现为 capability 限制，保留 Electron 入口；不要把空白框或 mock 内容当成已实现。浏览器端完整的历史选取闭环在 B2 验收。B1 退出时提供真实持久结果、DOM/style/console/network 证据，并记录反馈循环是否较基线更快；若仍需大量窗口操作，应先修入口而非扩大迁移。

## 6. B2：把历史回放与元素选取变成共享 Web 模块

**依赖**：B1 同一工作台、client 能力与资源访问身份；提前设计隔离，不能等页面搬完再补安全。

**范围与交付**：从 ReplayHost 分离可信播放器控制器、隔离回放文档与选择桥；复用 `src/replay/` 的 SourceModel、精确 ReplayPosition、已有 rrweb 数据准备和 `src/resources/` 的资源验证／重写。Electron 和浏览器调用同一回放模块，宿主只负责容器和安全资源传输。

**必须定义**：回放 document 的 origin/sandbox/CSP；请求资源与消息的 replayId、generation、source/frame 绑定；最大读取预算、取消与销毁；历史节点选择返回的来源身份。不能把录制 HTML 注入管理 DOM，不能让回放读取管理凭据或任意网络。新方案若改变现有安全边界，先单独审查，不能在搬层提交中悄悄放宽。

**验收纵向**：打开历史 → 播放／暂停 → 精确定位 → 点选节点 → 绑定字段 → 固定版本 → 刷新回读。双宿主结果应指向同一来源和固定版本。

**负测／恢复**：快速连续 seek、关闭后迟到资源或选取消息、重复选择、旧 generation、跨回放消息、外链／下载／权限请求、缺失与损坏资源、离线情况下回读。回放不可偷用实时页或新页面补全历史。当前两类 SVG 图标问题作为已知保真缺口单列；保持安全规则时可明确 partial，不可静默降低安全以变成绿色。

## 7. B3：再提取纯 Node 后端与 Chromium provider

**依赖**：B1 已改善反馈、B2 共享回放可运行、provider 数据契约与兼容策略明确。先提接口并维持 Electron 行为，再加 provider，不整体重写现有领域模块。

**建议顺序**：
1. 将 Studio 中的领域用例、宿主呈现、浏览器 session/page 生命周期、菜单／剪贴板／外链等职责分离。已有 evidence/materials/runner/validator 能复用的保持不动
2. 明确 BrowserRuntime／HostCapabilities 契约；ElectronRuntime 保持当前 WebContentsView 与 profile 归属
3. 为新建合成环境加入 ChromiumRuntime，独立 user-data-dir 与可执行文件解析；provider 信息有显式兼容读取规则，不改写旧 partition/storageRef
4. 在纯 Node 启动入口组装服务、HTTP UI、证据与 runner；处理构建中的 raw 资源注入、启动诊断、关机排空和写锁，避免隐性依赖 Electron 进程

**身份与迁移边界**：PageIdentity 中 `webContentsId` 当前必填；需把 provider 专属身份与通用 page/target/generation 区分并检查所有消费者，不能填假值或直接可选化后忽略验证。provider 选择不得把旧 profile 自动迁走；Cookie／登录兼容另提方案。数据格式一旦要变，先说明旧读取、失败、回退与写入兼容，不能顺手改字段意义。

**完整验收链**：没有 Electron 进程 → 专用 Chromium 环境 → 导航前安装采集 → 人工示范／录制 → 源节点取样与保存点 → 停录封存 → 离线回放 → 受控执行 → 核验与退出后恢复。检查新页面、导航与同文档路由、进程崩溃、停止／取消、写锁、profile 重开、下载和销毁。

**完成判据**：无 Electron 仍可完成上述真实链路且身份／权限一致，才称纯 Node 后端成立。仅能打开 Chromium 或落盘一次不够；现有 Electron 启动脚本也不能冒充独立 provider 测试。

## 8. B4：保持双端，但不维护两套产品

**贯穿执行**：从 B1 起保留小型 Electron 冒烟；最终以同一领域服务、client 契约、React 工作台和回放模块运行两种宿主。差异集中在 adapter 与显式能力报告。

**交付物**：双宿主启动说明、共用契约测试、可重复的真实纵向、按影响选择的回归矩阵、旧 profile／旧存档兼容报告及已知限制。前端不得长期保留两套字段解释、复制逻辑或播放器分支。

**验收**：相同合成输入在双端产生同语义的资料、固定版本与核验结果；支持／不支持能力在 UI 可理解；旧 Electron profile、文件路径、下载、原生窗口关闭和退出排空继续受保护。涉及资源、安全或持久化的改动运行相应完整回归与长测；纯 CSS 不机械重跑无关半小时测试。

**停止扩张条件**：如果 B1/B2 未明显改善界面可观察性或出现业务语义、安全、旧数据兼容回退，先收敛该阶段，不为了“双端架构完成”继续搬更多文件。

## 9. 实施检查与交接

每个切片开始先核对 Git 根目录、HEAD、未提交改动和正在运行的测试；单一文件单一写入者。实际提交与推送按当前用户授权及项目约定执行，文档计划本身不覆盖发布权限。

首切片推荐检查（测试名称基于当前仓库；新增 client 测试由实施者补充）：

```sh
npm run typecheck
npm test -- test/renderer test/unit/ui-ipc.test.ts test/unit/api-boundary.test.ts test/unit/test-mode.test.ts
npm run build
node test/desktop/launch.js --workspace-layout
node test/desktop/launch.js --workspace-browser
git diff --check
```

版本／显示准备与证据范围见[工具链补充](dot-environment-toolchain-validation.md#6-可复用执行入口)。新增真实场景要记录当前 build/PID/instance/target/时间及结果，不能靠旧 fixture 或旧报告求通过。仅文档变更检查链接、差异与敏感信息，无须重跑功能测试。

每次交付至少说明：本切片实现了什么、没实现什么、实际构建和通过／失败／未测范围、是否改变契约或数据，以及下一切片的依赖。后续实施者在本文件维护阶段摘要，详细证据进入专门交接；原设计转载与旧历史报告不追写成“本轮全部通过”。
