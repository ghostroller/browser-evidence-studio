# 技术架构与协议

状态：首版实现进行中。日期：2026-09-22。本文保留目标与边界；实际已验证范围以 verification.md 为准，不能将所有目标当作已通过。

## 1. 技术决策

- 开发及独立交付脚本：当前 Node LTS + 捆绑 npm，初始 24.21.0 / 11.19.0。
- 桌面：Electron stable、TypeScript、React、Electron Forge + Vite。用户已明确将原 TypeScript/Webpack 选型改为 Vite；构建不再使用 Webpack。
- 嵌入网页：WebContentsView；宿主 UI 与业务网页分离，不使用已弃用的 BrowserView。
- 业务执行：puppeteer-core stable 连接客户端受管理的 Chromium target；独立交付脚本可用 puppeteer 管理受支持浏览器。
- 录制：CDP 网络/导航/错误 + rrweb 稳定版 DOM 过程 + 显式 checkpoint 截图/DOM。rrweb 不是执行器或网络正文记录器。
- 对外协议：仅本机 HTTP/JSON，长任务用 jobId；增量轮询带 cursor。首版不另建 CLI/MCP/WS 公共接口。
- 本地存储：原始分块文件 + JSONL 规范事件 + 可重建的轻量增量索引。P0 不引入数据库服务或 ORM；性能实测有必要时再采用 SQLite。
- 自动化测试：合成站点 + 核心契约测试；Playwright stable 可测 UI，但 Electron/CDP 支持边界先验证，不成为产品录制依赖。

现代 Electron/Puppeteer 的 Chromium 不一定完全同版。M0 验证当前稳定组合，仅调整当代稳定依赖；不实现旧版本兼容矩阵。

### 1.1 模块格式定调（2026-09-23）

根 `package.json` 设置 `"type": "module"`。项目源码、构建配置和 Node 启动脚本统一使用 `import` / `export`；不同时维护 CommonJS 与 ESM 两套入口。模块格式由实际加载位置决定：

| 层 | 源码/配置 | 构建与运行格式 |
| --- | --- | --- |
| Forge / Vite 配置 | `forge.config.ts`、`vite.*.config.ts`，默认导出；Vite 使用 `defineConfig` | 由 Forge / Vite 加载 TS 配置，纳入 `tsc --noEmit` |
| Electron main / runner worker | TypeScript ESM | `.vite/build/index.js`、`runner-worker.js`，ESM |
| 可信 renderer | TypeScript / React ESM | Vite 浏览器 ESM |
| 可信 UI preload | TypeScript ESM | `.vite/build/preload.cjs`，单文件 CommonJS |
| Node 桌面测试入口 / 独立示例 | ESM | `test/desktop/launch.js` 按根包 ESM 运行；独立示例保留显式 ESM 的 `.mjs` |

preload 是明确的运行时例外：Electron 的 sandboxed preload 没有 ESM 上下文，包级 `"type": "module"` 也不会改变其加载方式。因此保留 `sandbox: true`、`contextIsolation: true`，构建时将 ESM 源码及本地依赖打包为单文件 CJS，仅使用 Electron 提供的有限 `require` 能力；不能为了统一产物格式削弱隔离。[Electron 官方 ESM 边界](https://www.electronjs.org/docs/latest/tutorial/esm)

TypeScript 保持 `module: "preserve"` / `moduleResolution: "bundler"`，与 Vite 构建和 tsx 测试加载方式对应，不承诺全部 `.ts` 可由 Node 原生直接执行。Node 直接执行的 JS 入口使用完整相对路径扩展名；Node 内置模块带 `node:` 前缀。main / worker 的相邻资源基于 `import.meta.url` 或 `import.meta.dirname` 定位，不使用 `__dirname`、`require.resolve` 或工作目录猜测运行时位置。ESM 主进程中必须在 Electron `ready` 前完成的初始化应显式等待，不能依赖未等待的动态导入时序。

这次调整固定模块规范，不升级 Node/npm 或依赖版本。配置加载、开发启动、worker、preload 桥接及打包的实际通过范围仍以 [verification.md](verification.md) 为准，历史 CommonJS 构建的通过记录不能替代 ESM 版本验收。

### 1.2 源码导入路径定调（2026-09-23）

根 `tsconfig.json` 只维护 `@/* -> ./src/*`。跨职责导入写明目录，例如 `@/main/...`、`@/renderer/...`、`@/runner/...`、`@/contracts/...`；同一职责目录内的紧邻模块可继续相对导入。测试导入客户端源码也使用这一映射，不为每层另设一组前缀。

main、preload、renderer 三份 Vite 配置均启用 Vite 8 原生 `resolve.tsconfigPaths: true`，不再另写一份 renderer alias。shadcn 的 `components.json` 五个 aliases 全部位于 `@/renderer/...`，包括 components、ui、lib、hooks 和 utils；新增组件时也要同时核对落盘位置与实际生成的导入。具体配置、CLI 实验与开源参考见 [import-alias-plan.md](import-alias-plan.md)。

别名只负责源码解析，不提供进程或权限隔离。renderer 不得因此直接引入 main、capture、evidence 或 runner 的宿主能力；共享契约使用 type-only 导入，运行时 shared 模块须适用于浏览器。preload 的 sandbox 边界不变。worker/preload 产物、测试子进程入口、外部业务脚本仍使用真实文件路径或 URL，不能把 `@/` 放进 `new URL()` 或原生 Node 的运行时入口。

## 2. 模块与进程

~~~text
src/
  main/
    app.ts                       Electron 生命周期、单实例、工作区恢复
    window.ts                    UI/业务视图布局与窗口管理
    browser/                     页面登记、profile、视图输入锁
    services/                    project/run/checkpoint/handoff/validation 服务
    api/                         HTTP 路由、认证、job 与错误映射
    ipc/                         只面向可信 UI 的窄 IPC
  preload/
    ui.ts                        可信 UI 的最小桥接
    observer.ts                  业务页单向观察/检查模式（不暴露宿主 API）
  renderer/
    app/                         项目与运行导航
    components/                  浏览器框架、状态条等共享视图
    features/                    checkpoint、timeline、evidence、validation
  capture/
    coordinator.ts               ready、连接、flush、健康、故障范围
    cdp.ts                       请求/响应、frame/导航、控制台
    rrweb.ts                     注入、分块、时间映射与回放资源
    checkpoint.ts                截图/DOM 采集与一致性
  evidence/
    contracts.ts                 run/event/artifact/checkpoint
    store.ts                     单写者、文件原子提交、封存
    index.ts                     偏移索引与重建
    reader.ts                    预算、字段投影、游标、片段读取
  runner/
    worker.ts                    运行指定入口、退出/取消/错误
    context.ts                   reporter、checkpoint、人工协助
    puppeteer.ts                 只适配当前支持的 Puppeteer
  contracts/
    workflow.ts                  薄流程契约
    api.ts                       公共请求/响应校验
    runtime.ts                   运行上下文和结果事件
  shared/                        ID、时间、哈希、错误等小型纯逻辑
test/
  fixtures/site/                 一个可组合的合成网站
  unit/
  integration/
  desktop/
~~~

以上是职责规划，不是当前目录清单。首版将部分服务集中在 `src/main/services/studio.ts`、`src/main/services/dispatch.ts`，界面集中在 `src/renderer/app.tsx`；实际模块与进度见 [progress.md](progress.md)。

2026-09-23 界面改用 renderer 内的 shadcn/ui 源码组件与 Tailwind 4。证据/回放/评审阅读拆至 `components/evidence-view.tsx`；主题和分栏使用 `components/theme-provider.tsx`、`components/split-pane.tsx`。可信 UI 的 `uiPreferences` / `presentation` 请求绕开业务串行队列且不向 HTTP 开放：偏好单独保存到 `userData/ui-preferences.json`，弹层和拖动遮挡按原因合成，不改变业务输入锁或 lease。`browser-presentation.tsx` 将 DOM 边界同步到原生视图及输入蒙版，布局重置后重新绑定尺寸观察；文档真正提交或 renderer 崩溃时清理旧显示状态，等待新文档的有效边界。被拒绝的导航保留旧文档状态；失效 frame 的迟到 IPC 被忽略。详情见 [前端重构方案](frontend-refactor.md)。

Electron main 管生命周期、页面和控制权；可信 renderer 只管界面。捕获/索引重活和脚本执行放到独立 worker/utility process，防止堵塞主线程。写文件仅由 evidence store 负责，避免 CLI 多进程抢锁模型。

脚本 worker 与捕获职责隔离：脚本崩溃时仍应保留最后页面与已落盘证据。固定少量进程即可，不发展成本地微服务。

## 3. 浏览器与 CDP

### 3.1 页面身份

BrowserRegistry 保存 appInstanceId、browserSessionId、webContentsId、CDP targetId、pageId、frameId、navigationGeneration、openerPageId。导航不更换逻辑 pageId；新窗口建立新 pageId；frame 销毁后不能复用旧映射。

禁止通过“当前活动页”或 URL 相同来猜 target。业务 view、宿主 UI、回放 view 和 DevTools 各有角色；runner 只得到明确登记的业务页面。新业务弹窗在策略允许时纳入管理和录制，接入前存在盲区要记 gap。

### 3.2 连接方式和范围

优先标准 CDP 连接：捕获器用独立 CDP session 订阅，Puppeteer runner 用受管理连接操作。M0 检查并发订阅、导航、弹窗、DevTools 及 detach；不得假定多个客户端完全无冲突。

如采用 webContents.debugger，需要专门处理 DevTools 打开造成 detach。最终选定一种主要连接路径，避免同一功能重复维持两套记录器。

调试端口属于客户端内部设施，绑定 loopback、动态分配并实测监听范围；不在公共 HTTP 响应或技能里返回 browserWSEndpoint。若平台不能满足边界，M0 必须调整设计。

原生 Puppeteer 脚本是用户授权的本地代码，不是安全沙箱。targetFilter 是目标选择，不能宣传为抵御恶意脚本的权限隔离。公共 agent 接口不接受任意 CDP 命令或 Electron 主进程 eval。

### 3.3 受控输入

UI 操作、HTTP browser action、managed runner 共用控制权状态。HTTP 动作经过 leaseEpoch 校验；原生 Puppeteer 命令不会自动经过该校验，因此 managed runner 必须使用工具注入的可撤销操作连接/transport 闸门，采集连接独立。进入人工窗口前关闭操作闸门、清理或等待在途命令结束，确认后才开放输入。人工期间拒绝操作连接的写命令，未知方法默认拒绝，不能仅靠发现竞争后终止。M0 必须用并发 Promise/定时器验证这个边界；这是传输控制，不是重做 Puppeteer Page API。

requestHuman 在闸门确认关闭后进入 await，正常交还经真实状态检查再恢复连接并继续。强制接管无法安全暂停时，断开/终止 runner 并确认静默后才开放人工；此路径不承诺恢复原执行栈，应从显式恢复入口或新 run 重试。脚本不得另建绕过管理的连接，也不得向页面注入跨交接持续点击的定时器；客户端不能撤回已经启动的站点异步工作。被闸门拒绝的越权操作记录为冲突并使任务失败。对本地任意恶意脚本不提供沙箱级保证。

宿主视图必须真正覆盖或移开业务原生视图。锁定键盘/鼠标/滚轮/快捷导航，明确处理新窗口、拖放与系统对话框，不依赖网页自己实现的遮罩。

### 3.4 内嵌浏览器兼容策略

`src/main/browser/environment.ts` 在 app ready、session 和 WebContents 创建前设置 `chrome-compatible-v1`：通过 Electron 原生 `app.userAgentFallback` 使用实际 Chromium 主版本的桌面缩减 UA，保留原生操作系统信息，移除应用名与 Electron 产品标记。策略覆盖首次导航和原生弹窗，不等待 Puppeteer 接管后再修改 UA。启动时禁用 Blink `AutomationControlled`，避免内部动态调试端口使人工浏览页面的原生 `navigator.webdriver` 为 true；普通 Puppeteer/CDP 连接及其控制闸门继续工作。

保留原生 Chromium Client Hints、语言、时区和硬件属性，不注入 navigator 属性补丁，不声明 Google Chrome 品牌，也不拦截请求补造 Client Hints。Electron 与 Chrome 的网络提示支持仍有差异，实际验证及限制见 [验证记录](verification.md)。此策略不是完整 Chrome 环境，也不能证明真实站点已接受请求。

每个新 run 的 manifest 保存 `browserEnvironment`（策略名、session UA、实际 Chromium 版本、原生 Client Hints 策略、启动特性状态），用于前后对照；旧 run 不回填当前配置。profile 分区、权限处理和 `sandbox/contextIsolation/webSecurity` 边界保持原有策略。

兼容诊断另有独立 `src/main/browser/baseline.ts` 入口，通过 `npm run browser:baseline` 单独构建启动。仅共享上述原生环境策略，保持 WebContentsView 的安全和权限设置，使用全新 userData/sessionData；在首次导航前完全不初始化 Studio、调试端口、Puppeteer 或 rrweb。它不是普通 run 的“暂停采集”，也不提供第二套 agent 控制协议；实际用法及对照边界见 [运行环境](environment.md#无采集浏览器对照)。

## 4. 录制流水线

### 4.1 开始与连续性

创建 run → 打开独立 profile/页面 → 建立 CDP 与 rrweb → 写入能力探测结果 → ready → 开放操作。首次导航前尽量建立观察，注入不到的时间和 frame 明确记录。

rrweb 使用固定稳定版本，跨导航重新注入，保存完整快照和增量事件。定期产生可独立回放的块；checkpoint 引用所在块和偏移，不重新启动录制。回放器离线、不执行原站脚本，不任意请求原站资源。

P0 回看覆盖主文档 DOM、滚动、鼠标、输入、导航边界和关键帧；跨域 iframe、Canvas、视频、Shadow DOM 和资源缺失按实测能力展示。基础 DOM 回放不得因单个不支持区域导致整段不可读；增强保真度可延后。rrweb 回放不能替代真实截图或证明原程序执行。

### 4.2 网络和正文

保存请求、响应、各跳重定向、失败、来源 target/frame/loader、可获得的请求正文和响应正文。requestKey 使用 session/target/requestId/redirectHop 组合，不能仅用可重用的 CDP requestId。

正文尽早获取，避免导航后缓存淘汰。文本/JSON/HTML 默认保存；二进制网络资源默认记录元数据，下载另存为 artifact。政策排除用 excluded，不伪装成 empty 或 not-applicable。

当前请求正文以独立 `request-body` artifact 保存，网络事件只引用 artifact。CDP 事件缺失文本时在 5 秒内补采；请求 ID 重用、重定向、暂停或停止会使旧补采来源失效，晚到正文不得归给新请求。凭据关键词、二进制、multipart 和不支持字符集明确排除；空正文与无正文分开。这里的字节数是 CDP 文本转为 UTF-8 后的观察值，不等同于完整线上编码或文件上传内容。

初始可调预算：单个文本正文 8 MiB、单 run 提示阈值 2 GiB；到限不静默丢弃，记录 capturedBytes、limitBytes、reason 和缺口。HTML 内嵌 JSON 与 API JSON 都保留，不硬编码站点优先级。流式/SSE/WebSocket 不默认宣称已保存完整；P0 至少记录连接和 unsupported/partial 范围。

已覆盖浏览器流量不代表覆盖独立脚本的 Node fetch/Axios。脚本使用这类请求时必须通过 reporter 附入对应来源证据，或者将该字段验收标为证据不足。程序侧自动拦截另属 P1。

### 4.3 动作和定位

录制动作保存类型、输入摘要、DOM/选择器候选、frame、位置、时间和来源。密码输入默认掩蔽，不把 rrweb 原始输入当作凭据存储。

actor、controller、source 分开：当前处于人工控制不证明每个 DOM 事件都是人直接触发；isTrusted 也不能证明人工。工具发出的动作有 commandId，其余记录实际观察渠道和可知范围，未知标 unknown。

候选定位器优先语义/稳定属性，保存 role/name/text 与 DOM 依据、frame/shadow 路径。只保存 ref 或 x/y 不足以构成可迁移执行逻辑。

### 4.4 checkpoint

持有短暂输入锁 → 记录页面代际/时间并等待操作静默 → 并行采截图与 DOM → 在完成、10 秒总采集期限或显式取消时冻结材料 → 核对页面代际并安全释放输入 → 写入 artifact 和 checkpoint，确认耐久后返回保存结果。当前索引写入仍在主进程，进程分工属于后续工作。

取消仅作用于指定采集任务。截图或 DOM 无法真正中断时，消费其晚到结果但不再写入；保存阶段不取消已经排队的原件写入。10 秒限制是采集预算，不承诺磁盘持久化也在此期限内完成。操作静默失败时保持闸门关闭，由显式停止流程恢复控制。

只重试有限次数，默认一次；部分成功不丢弃。返回 captureConsistency=consistent/mixed/unknown，以及各 artifact 状态。页面动态更新可能仍导致同一导航下图像和 DOM 不完全同步，不能将 consistent 描述为原子快照。

人工保存允许保留不完整材料用于诊断；managed runner 只将已完成、材料完整且 consistent 的 checkpoint 计入需求覆盖。否则先保存实际证据，再让 reporter 调用失败，避免空材料仅凭 ID 满足验收。

## 5. 数据模型与落盘

~~~text
appData/
  workspace.json
  projects/<projectId>/project.json
  profiles/<profileId>/                  与证据目录分离
  runs/<runId>/
    manifest.json
    journal/events-000001.jsonl          分块追加
    checkpoints.jsonl
    artifacts.jsonl
    raw/cdp/
    raw/rrweb/
    raw/checkpoints/
    blobs/<sha256>                      本 run 内按内容引用
    index/                              可重建的偏移/字段索引
    reports/
    integrity.json                      封存时生成
  connection/agent-connection.json       仅当前用户可读，禁止提交
~~~

实际默认根使用 Electron userData；开发与正式发行分开。源码仓库不存用户证据。来源路径均为 run 内相对路径，导入/读取校验路径越界和符号链接逃逸。

核心对象：

| 对象 | 必需语义 |
| --- | --- |
| Run | schemaVersion、ID、kind/mode、objective、状态、实际工具/浏览器/依赖版本、能力、源运行引用 |
| Event | 稳定 ID/sequence、发生/接收时间及 timeBasis、source、页面/frame/导航、关联标识、artifactRefs |
| Artifact | kind、mediaType、path、sha256、capturedBytes、captureStatus、reason、limit、来源 |
| Checkpoint | key/ID、说明、需求版本、采集时间范围、页面代际、图/DOM/事件区间引用、一致性 |
| Requirement | 输入/输出 schema、范围、变体、完成条件、允许人工点、比较规则、修订版本 |
| Validation | 代码/构建/配置/依赖指纹、实际入口、执行事件、模式、断言、覆盖和人工评审 |
| Handoff | 对象/任务/完成检查/超时策略、控制权代际、恢复位置、attempt、等待状态 |

captureStatus：complete / empty / missing / truncated / read-failed / not-applicable / excluded / unknown。
query outputTruncated 与原件 captureStatus 独立；字段不存在与真实 null 分开。时间邻近的关联标 temporal，不声称是点击导致的请求。

存储规则：
- 单写者串行提交；确认持久化后才报告保存。更新小元数据用临时文件加替换。
- 大材料和 rrweb 流按块落盘；可查询已提交块，索引后台增量更新。
- 崩溃检测尾部未完成记录，保留损坏证据并报告 gap，不吞异常。
- 重建索引保持 ID；删除索引不影响原件和身份。
- seal 先 flush、校验引用/哈希，再提交 sealed；中断封存标 interrupted。
- 封存后原件不变。补录新建 run，以 supplements/continuationOf 关联；评审作为独立追加修订。
- 应用重启提供恢复界面，核对实例/PID 启动身份/真实采集状态；不让用户手工移动锁文件。
- 已显示“已保存”的 checkpoint 是耐久边界；尚未提交的数据窗口必须可测量并公开。

当前 writer 实现把操作系统独占句柄与磁盘身份标记分开：以 run 目录的设备/文件身份确定 guard，Windows 使用独占 named pipe，进程退出由内核释放；`writer.lock` 保存 PID、操作系统启动身份与随机 owner token。新标记先写入并 sync 临时文件，再以不覆盖目标的硬链接原子发布。Windows 通过系统自带 Windows PowerShell 查询 `Process.StartTime` 的 FILETIME，不依赖开发者使用哪种 Node 版本管理器；查询失败是 unknown，不推断进程已死。当前 Windows 是实际验证平台。

回收锁必须先取得 guard，再复核标记指纹和进程身份；只处理已退出进程或可证实的 PID 重用。旧格式仅有近似启动时间且 PID 仍活着、损坏标记、权限或查询错误均保留并显示原因。被回收的原锁和诊断保存到 run 内 `recovery/`，release 只删除匹配自身 token 的标记。界面的“检查恢复条件”提供检查和安全重开；此入口只供可信 UI 使用，没有强制清锁 HTTP 接口。界面检查是快照，实际重开仍须再次取得独占所有权。

## 6. 工作流描述与脚本契约

使用薄 manifest，不开发通用 DSL：

~~~json
{
  "schemaVersion": 1,
  "workflowId": "example-orders",
  "entry": "./dist/collect.js",
  "exportName": "run",
  "driver": "puppeteer",
  "inputSchema": "./schemas/input.json",
  "outputSchema": "./schemas/output.json",
  "requirements": [
    {
      "id": "orders-complete",
      "checkpointKey": "orders",
      "description": "获取约定范围内的订单并证明分页完成",
      "referenceEvidence": ["run-example/checkpoint-orders"]
    }
  ]
}
~~~

这只是建议格式和合成 ID，不是已有 API。分支、分页、循环、等待和计算写在 entry 代码里；manifest 不保存另一套 next/router。需求描述和证据原件分离，修改需求不改写原始 checkpoint。

managed entry 概念签名：run({page, input, reporter})。
reporter 只提供 checkpoint、emitData/attachArtifact、requestHuman、progress 和取消信号等窄能力，不包办 Page API。普通脚本可通过独立入口启动自己的 Puppeteer，并注入控制台/文件 reporter；生产执行无需启动客户端。

runner 接受已登记目录内的入口、锁定依赖和内容指纹；不提供 HTTP 任意字符串 eval/全机任意文件执行入口。源码、构建、配置和锁文件的 hash 一起保存；运行前后变化标记失配。工具实际启动 worker、接收退出和 checkpoint，避免仅凭外部一份“pass.json”证明执行。

二维码/CAPTCHA 由 requestHuman 进入显式协作，不内置通用破解或自动判定登录算法。具体成功条件由脚本定义；human reply 是交还请求，仍需检查真实页面。

## 7. 状态与取消

- execution：ready / running / waiting-human / paused / completed / failed / cancelled / interrupted。
- capture：starting / recording / paused / degraded / stopped / sealed。
- controller：human / agent / none；含递增 leaseEpoch 和 holder。
- job：queued / running / waiting-human / succeeded / failed / cancelled。

状态持久化不等于进程仍活着。恢复时重新检查页面、profile、采集和任务。不能因为倒计时结束从 waiting-human 自动变为 succeeded。

当前验收在创建 worker 前追加 `validation-started`，登记 validation/run/project/profile、输入摘要、执行版本和时间。结束时先保存带身份封套的完整 `validation-report` artifact，再追加引用其 ID/hash 的 `validation-complete` 终态；`validations.json` 仅为可重建目录。启动从各 run 原件重建记录，核对身份、顺序、报告 hash、输入和版本，并核验新协议所引用 checkpoint 的完整性与材料。仅完整且相符的终态可以恢复原结论；只有开始记录或孤立报告时标为 interrupted，不产生 pass。旧终态沿用原报告契约核验，明确标为 legacy-verified；旧目录里的 pass 本身不是证据。

保存目录投影期间，对外状态保持 `finalizing` 和输入锁；控制清理完成后同步发布终态并交还人工，避免界面已显示完成却仍不能复跑。目录写入失败单独报告，不抹除已经完整提交的 run 终态。重复关窗或 app.quit 复用同一次退出清理，所有普通退出请求在清理完成前保持拦截，最后由 app.exit 退出。

恢复不会恢复页面操作连接、旧 lease、worker 栈或人工等待；保留已保存的 checkpoint，复跑建立新 run。重复启动重建索引和目录，不重复登记同一次验收或追加相同恢复缺口。当前扫描仍在主进程，长历史成本和进程拆分另行评估。

应用生命周期写入 `diagnostics/lifecycle-<实例 ID>.jsonl`，`diagnostics/latest.json` 保存最近阶段，含 PID、启动时间、关窗/app.quit/测试完成或失败原因及清理阶段。主进程强杀可能来不及写结束记录，因此缺失终态只能视为未知；测试启动器结合实际退出码、完整测试报告、生命周期末态与旧 soak 快照判定结果，不能把退出 0 或陈旧 running 状态当作通过。

HTTP 写操作携带 leaseEpoch，旧控制权请求返回冲突；原生 Puppeteer 由第 3.3 节操作传输闸门实施同一控制权，不要求其协议凭空新增字段。幂等请求带 idempotencyKey，超时重试不重复创建 run/checkpoint。创建 job 后快速返回 202，查询和界面显示可取消状态。取消 worker 不强制关闭录制页面，便于排查；最终关闭由 run 生命周期统一处理。

请求重试只限安全动作；点击提交、下载触发等不盲目自动重复。崩溃后不直接重放最后一步，先显示页面状态和执行断点。

## 8. 本机 HTTP API 目标

路径均以 /v1 开始；下面是实现合同草案，不是现有命令。

| 能力 | 主要路由 |
| --- | --- |
| 状态/能力 | GET /health，GET /capabilities |
| 项目 | GET/POST /projects，GET/PATCH /projects/:id |
| 登录环境 | GET/POST /projects/:id/profiles，POST /profiles/:id/save |
| 录制 | POST /runs，GET /runs/:id，POST /runs/:id/pause、resume、seal |
| 页面/操作 | GET /runs/:id/pages，POST /runs/:id/actions，GET /runs/:id/snapshot |
| checkpoint | POST /runs/:id/checkpoints，GET /runs/:id/checkpoints |
| 证据 | GET /runs/:id/summary、gaps、events，GET /artifacts/:id/content |
| 协作 | POST /runs/:id/handoffs，POST /handoffs/:id/release |
| 执行/验收 | POST /validations，GET /validations/:id，GET/POST /validations/:id/reviews |
| 异步任务 | GET /jobs/:id，POST /jobs/:id/cancel |

actions 首版有限集合：navigate、click、fill、press、scroll、select；必须指定 run/page、定位依据和控制权。snapshot 返回 bounded DOM/可访问性摘要及带 generation 的短期元素 ref；ref 必须直接出现在响应里，过期拒绝执行，不要求人开 DevTools 找 ref。

如需读取页面变量，提供限定在业务 renderer 的只读提取入口，不能混入 Node/Electron 能力；无法保证用户表达式无副作用时按写操作授权和审计。P0 不开放任意主进程代码执行。

响应包含 requestId、items/result、sourceRefs、returnedBytes、outputTruncated、nextCursor、warnings 和结构化 error。错误用 HTTP 状态码，不能 200 内夹一个不可见错误字符串。409 表示控制权/状态冲突，422 表示参数/能力不满足。

读取默认 list 20 条、摘要输出目标 8 KiB、总预算上限 32 KiB；正文默认 4 KiB、单片上限 16 KiB。字段投影和 JSON path 先过滤再裁剪。游标绑定过滤条件和索引代际；图片用独立 artifact endpoint，不内嵌 base64 到 JSON。可配置提高预算，但 agent 需显式选择。

鉴权：loopback 动态端口 + 每次启动 token；连接文件仅当前用户可读，暴露地址和 token，不含业务凭据。拒绝非预期 Host/Origin，不开放通配 CORS；网页内容无法因位于同机而管理客户端。可信 UI 使用窄 IPC，校验 sender。

## 9. 验收、成本和恢复

断言采用 pass/fail/inconclusive/not-run，并分别给出 coverageVerdict、assertionVerdict。未覆盖需求阻止总评通过。failed 控制流和 failed 业务验收分别显示。

允许人工扫码不等于允许 agent 临时修脚本：验收运行禁用未声明的 AI fallback；修复产生新版本/新 run。报告记录每次人工协助和尝试，避免靠多次干预掩盖可复现性。

记录执行、等待、采集、索引和查询耗时、交接次数、正文/DOM/截图字节、读取结果大小、实际模型调用来源。无模型计量时 token=null；若提供字符估算必须标 estimated、算法和区间，不能称真实费用。客户端本身不强依赖模型供应商。

性能目标与测量方法见实施计划，作为目标而非当前成绩。长录制通过分块、增量索引、关键帧和按需查询处理，不把全部录制喂给 agent。

## 10. 信任边界

远程网页关闭 nodeIntegration、启用 contextIsolation/sandbox/webSecurity；不向远程页暴露宿主 IPC。记录器注入只有观察/选取需要的最小能力。权限请求、外部协议、下载路径和弹窗统一处理。

本地 raw 可能含业务敏感信息；凭据字段默认掩蔽读取，登录 profile 与证据分开，导出不带凭据。通用掩蔽不保证识别所有个人信息。用户手动附入的本地脚本与浏览器页面是两种信任级别，不混为一谈。

研究依据及官方 API 边界见 research.md；具体模块落地顺序见 implementation-plan.md。
