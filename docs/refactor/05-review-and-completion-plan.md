# Browser Evidence Studio：R1–R8 后审查与剩余任务完成计划

日期：2026-09-26
性质：源码审查、修正意见和后续实施授权模板；不是新的测试通过报告。
适用仓库：`ghostroller/browser-evidence-studio`

## 0. 执行摘要：先读本节，再按当前批次定向阅读

**目标没有变：** 自然示范 → 停录不关闭现场 → 离线回放历史 → 后补 checkpoint、注释和字段 → 固定资料版本 → 新 Agent 接续实现 → 独立模块执行、保留部分结果 → 核验和独立交付。不要重新设计项目，不重做已完成的 R1–R8，也不重新开启完整 A–G 多路常驻实施。

**本次远端审查点为 `5444ea504f5d7cc6b285022890fba0369248e5d0`。** 它在实现提交 `f62e5f4de76e13b61fbdade300c195a6b6878e1a`、验证文档 `1968f2f6e784938b983e585c2d2c7552e182549d` 之后，仅保存前轮审查资料和复现文件。旧远端 A/D/E 分支仍停在较早提交，不代表 main 缺少已 cherry-pick 的成果。只核对实际现场，不 reset 到本文 SHA，不重复搬运等价补丁。[S01][S02]

**保留上轮有效成果：** 移动节点源元数据修复、原生连续 Replayer、生产 frame-aware 资源准备、选择会话身份、任务范围检查、旧一次授权公开入口移除、注释编辑和固定版本派生、损坏数据集逐项隔离。仓库记录当前 50 文件/298 项、类型检查/构建及两项真实 Electron 专项通过；这些是该提交、指定合成场景的验证，不是全部产品目标已通过。[S02]

### 本轮需处理的发现

| ID | 结论 | 性质 | 批次 |
|---|---|---|---|
| N01 | 正常生产 response-body 缺少独立 JSON 来源核验使用的 `pageId/responseObservedAt` | 已确认生产者—消费者契约断点；P1 | Q1 |
| N02 | 播放正在准备时，pause 提前返回，迟到准备仍可开始播放 | 已确认竞态路径；需延迟夹具复现；P1 | Q2 |
| N03 | 资源只按 DOM URL 使用事件解析，会漏掉稍后真正加载成功的资源 | 已确认可达时序缺口；需生产延迟资源夹具；P1 | Q2 |
| N04 | 旧 checkpoint DOM、实时 snapshot 与 rrweb/source 的隐私规则不一致 | 已确认不同通道的保护缺口；真实账号/导出前优先；P1 | Q1 |
| N05 | 增量 style 文本变化未经过相同资源改写；跨文档播放、DPI 等仍需收尾 | 前者是静态覆盖缺口，后者是未闭合目标；P2 | Q2 |
| N06 | 固定交接导出、授权发现、实际 capability 和安装版 skill 仍未形成完整交付链 | 已声明未完成的原需求，不是另起产品；P2 | Q3/Q5/Q6 |

**本文件审查边界：** 对照了主分支当前采集、请求台账、源模型、回放宿主/UI、资源归档、隐私入口、API/任务分派、结果来源读取和打包配置。未在此环境执行项目的 Windows/Electron 测试；没有把源码推导说成已实测故障，也不是全仓穷尽审计。每个 N 项先在本地当前代码上确认/复现，再修复；若本地更新已关闭问题，记录对应提交和证据后跳过，不为满足本文重复改动。

### 执行安排

| 批次 | 工作边界 | 完成门槛 |
|---|---|---|
| Q1 | 生产 JSON 来源闭环、跨通道隐私一致性 | 真实采集链正确值通过、错误值失败；隐私哨兵在允许读取/导出材料中不可泄露 |
| Q2 | 播放意图、晚加载资源、样式与既定资源/页面边界 | 生产 ReplayHost 连播/暂停/随机定位一致，离线资源时序和范围可解释 |
| Q3 | T13 固定交接、必要 API/capability 收尾、项目内 skill | 用户一次明确授权后，新任务能发现身份并按固定版本读资料和试跑 |
| Q4 | 故障恢复、完整旧桌面回归、新架构长测 | 当前代码的全套回归、30 分钟记录与多位置重开/恢复证据 |
| Q5 | Windows 分发包、独立业务目录 | 包内资源/worker/skill 不依赖源码目录；普通 Puppeteer 产物脱离 Studio 可运行 |
| Q6 | 全新 Agent 接续、最后系统验收、人类场景 | AT39/AT40 真实证据，AT01–AT40 覆盖表，以及明确的通过/未测/阻塞分类 |

**按 Q1→Q6 连续推进。** 每批完成真实验收和必要提交后自动进入下一批，不再把“写完交接，等用户再发继续”作为默认结束条件。阶段边界用于成本控制和接续，不是人为中断点。仅在用户暂停、真实权限/登录/额度限制、重要不可逆业务决策，或运行环境确实无法继续时安全停下；其余无依赖工作可以继续。最后报告真实边界，不把被阻塞的人类场景列为通过。

**工作方式继续采用上一轮：** 一个 Sol/high 实施兼集成会话；常规 Git/日志/沟通直接用工具。最多一个确有独立性的额外实施流，不递归派发。Astra/high 只做具体高风险问题的限范围 review，不常驻调度，不默认 xhigh，不要求每批都调用。模型由实际配置生效，不凭提示词声称切换。[S18]

---

## 1. 意图、保留项与范围控制

这一轮应从“多个模块拼成基本链”转为“把实际可用性、证据正确性和交付一起完成”。“本批无剩余阻塞”只描述上轮限定任务结束时的情况，不代表不存在其他代码缺口，也不代表只有打包待办。

保留并回归验证既有修复，而不是重写它们。特别是：不退回每个事件完整 seek 的播放方式；不从回放 DOM 伪造原始属性；不把损坏目录吞成空数据；不恢复裸 lease 或旧一次授权以迁就旧测试；不把失败证据改成成功。

原规范 `01-modification-plan.md` 仍定义产品目标、身份与 AT01–AT40。本文更新实施顺序和发现，不自动扩大为通用浏览器虚拟机、任意页面无损恢复、复杂任务调度平台、全自动突破验证码、跨机器 profile 迁移或更换构建器。

对历史数据采用只读/显式派生策略。新增事件、字段和索引要声明版本及缺失语义；不得从新网站内容或脚本自报补写旧录制的“原始事实”。已有不能恢复的信息仍报告不完整。

## 2. N01：补上生产网络 JSON 证据的来源身份

### 2.1 源码依据与失败路径

`ProjectExecutions.assess()` 给 `CapturedJsonSourceReader` 查找宿主 scope 时，要求 artifact 的 `source.responseObservedAt` 能解析为时间，并且 `source.pageId` 与真实 scope 相同。再按时间与 scope 的交集排除歧义。[S03]

当前 `CaptureCoordinator` 的正常 JSON response-body 写入却只有 `source: { requestKey, url, frameId }`；`artifact()` 只是隐私处理元数据并转交 EvidenceStore，不补齐上述字段。`RequestLedger.response()` 也只更新 MIME/streaming，没有保存响应观测时间。[S04][S05]

因此，正常生产路径取得的网络 JSON 可以有真实字节，却在 scope 解析中得到 `NaN` 时间/缺失页面身份，无法建立独立来源。这里不是说所有被手工构造的 JSON 测试都失败；恰恰需要防止测试替生产者填写必需字段，从而掩盖断点。上轮 DOM 显示值路径通过，并不能证明网络 JSON 路径通过。

### 2.2 修改路径

1. 在真实 CDP 回调进入宿主时同步记录响应观测时间及关联身份，不能等排队落盘后再取时间。明确时间基准和语义，保存 request key/occurrence/hop、managed page、frame/loader/document 和 recording 对应关系。
2. 在 request ledger 或明确的不可变响应描述中保留它们；在 loadingFinished 的延迟 body 读取、成功/截断/隐私排除/读取失败路径中一致传播适用元数据。页面跳转、request ID 重用和 redirect 不得改绑旧响应。
3. 消费方仍按真实 host scope 检查。缺失、跨页、范围重叠不唯一、旧版本无身份时返回来源不足，而不是使用 artifact.createdAt、当前选择页面或脚本提供的时间作回退。
4. 先检查旧 A 的相关差异是否已存在于当前 main；仅接入真正缺失的修复，不能为此整体重新合并 A 的旧分支。
5. 把“生产者必须写哪些来源字段”变成类型/校验及端到端 fixture 的共同约束。测试不得直接 `putArtifact` 填假来源再称其为生产采集测试。

### 2.3 本地验收

建立真实 Electron/Puppeteer 页面发出 JSON 请求，由当前 CaptureCoordinator 采集，经实际 ManagedExecution/host scope 到 F 判定：正确值通过，错误值失败；人为删除必要身份只导致来源不足而非通过；响应先到、正文延迟落盘仍归属原 scope；跨 step/跨页/重叠 scope 不被挑选部分 dataset 的方式洗成唯一来源；大正文截断和取消保持原有含义。

至少留一项普通页面 DOM 字段来源与一项网络 JSON 字段来源在同一生产系统链中。两条路径分别报告，不合并成“来源检查通过”一个笼统结果。

## 3. N02：暂停必须取消尚未开始的播放意图

### 3.1 源码依据

当前 `ReplayHost.play()` 需要新段时进入 `render(active,end,start,speed)`。render 先设置 loading、playing=false，再进行窗口读取和资源准备，最后在异步浏览器脚本中执行 `player.play()`。

但 `pause()` 在 `status !== ready` 或 `!playing` 时直接返回，既不取消准备，也不废止待启动的 play。UI 的播放准备并不等同于 seek 状态，用户可以点击暂停；仅在 React 丢掉晚到回执，不能阻止实际 Replayer 后来开始运行。[S06][S07]

### 3.2 修改路径

- 增加明确的播放意图/命令代际，区分“准备播放、播放中、暂停中、已暂停”。它与页面重建代际相关，但不能让 pause 在 loading 时变成无效操作。
- pause 要废止待启动意图，必要时取消准备；即使资源准备需要继续保留缓存，晚到完成也只允许保持暂停。浏览器脚本在资源等待结束后、调用 play 前，必须检查仍有效的意图，不能只在 executeJavaScript 返回后检查。
- play、pause、seek、切流、关闭和进入检查之间明确优先关系。UI 显示有效状态，不能出现按钮显示播放但实际正在动，或显示暂停成功但仍有待启动动作。
- 状态轮询不得让同一代际的迟到 playing=true 覆盖已完成的 pause；实际 API 可加入命令序列并定向拒绝过时回执。
- 保留原生增量播放；不要用此修复恢复为逐事件重建，也不要简单禁用暂停按钮直至所有工作做完。

### 3.3 本地验收

通过生产 ReplayHost 人为延迟 archive window/资源读取：点击播放→立即暂停→释放延迟，等待超过正常开始时间后仍无播放/位置推进。再测试 pause→play、seek→pause、关闭→旧准备返回、播放中进入元素选择以及边界重建时暂停。检验 DOM/位置、宿主状态、UI 文案一致，不只验证调用过 pause。

## 4. N03：将 DOM 使用时刻、资源观测与历史可用时刻分开

### 4.1 当前缺口

`prepareArchivedReplay()` 按“包含该 URL 的 rrweb 事件位置”调用 `archive.resolve()`；后者只接受不晚于该位置的 resource reference。[S08][S09]

但真实资源可能晚于 DOM 插入完成加载。正常 `loadingFinished` 归档使用当时的 source position。[S04] 可达序列：

```text
seq 5：插入 <img src="/slow.png">
seq 6：页面发生另一个已记录变化
seq 7：图片响应完成并归档
seq 9：用户暂停/创建 checkpoint，图片此时已经显示
```

若 seq 5 到 seq 9 之间没有重建完整快照，也没有再次改 src，回放准备仍按 seq 5 解析该 URL；seq 7 已保存的资源被排除，seq 9 也可能显示占位。这是现有解析算法的时间关系缺口，不是应该靠联网补取解决的资源缺失。

### 4.2 修改路径

1. 定义 URL 使用、具体请求/响应版本、实际可用观测及生效区间之间的关系。DOM 使用事件不是 resource bytes 已取得的证明；响应完成时刻也不是可以回填到此前任意状态的许可。
2. 使用已记录 request/version 关系，以及必要的资源可用事件/派生调度，在目标历史状态正确选择资源。相同 URL 多次返回内容时，保留请求与引用身份，不能简单从目标时间挑最后一个同名 URL，更不能取整个录制的 latest。
3. 顺序播放到资源变为可用时更新显示；直接 seek 到之后应与顺播相同。资源加载前的状态保留 pending/不可用观测，不展示未来字节。
4. CSS 的字体、背景图、@import 等依赖也采用一致时序和 frame。准备一个播放段时，不应把未来区间的缺失提前变成当前时刻已发生的错误。
5. 每个资源查找返回明确 captured/pending/missing/excluded/unsupported/read-failed 或兼容的现有分类。修改枚举时由当前单一负责人同步契约、producer/consumer/test，不能只改文案。
6. 缺乏必要原始时序的旧档只能明确降低精度或能力，不能事后编造网络时间。读档可重建索引，不能改变原件。

### 4.3 本地验收

生产录制两个源站端口模拟跨源资源，延迟 image/CSS/font，并在等待期间产生后续 rrweb 事件；在下一次 full snapshot 前设置 checkpoint。断网、新进程回放：加载前不展示未来版本，加载后可恢复真实资源；同 URL 先后两份字节、跨 frame 同 URL 不串用；每个目标位置的顺播与 seek 关键 DOM、源字段和资源版本一致。

## 5. N04：旧快照通道不能绕开录制隐私策略

### 5.1 当前源码差异

新 rrweb/source-recorder 对 `.rr-mask/.rr-block`、敏感属性、输入值等有显式策略。旧 `Studio.checkpoint()` 的 HTML clone 仅移除 input/textarea 的 value 并替换 textarea 文本；`Studio.snapshot()` 返回部分元素的 textContent，没有相同遮罩检查。EvidenceStore 保存 artifact bytes 时只限长，不进行同策略清理。[S10][S11][S12]

例如带 `.rr-mask` 的 h1、`.rr-block` 子树或含 `data-token` 的元素，在新录制通道中受保护，却仍可能出现在旧 DOM artifact/实时摘要。屏幕截图还有独立的视觉泄漏面，不能因为 DOM 已遮罩就宣称 PNG 也安全。

这是授权内的数据处理策略不一致，不等于有无鉴权互联网访问漏洞。修复优先于真实账号采集和交接导出。

### 5.2 修改路径

- 统一 CapturePrivacyPolicy 的适用范围和版本，覆盖新录制、源元数据、旧/新 DOM 快照、实时摘要、截图策略、资源和交接导出。不要把整个业务字段默认全部抹除；按明确隐私类别处理。
- 文本/属性在取得新材料时按同一规则处理，保留 redacted/excluded/restricted 等语义。字节完成不等于隐私审查通过；来源哈希应对应实际保存的表示，标清派生与原始采样关系。
- 截图需要真实遮罩或安全排除/受限保存策略。无法保证遮罩时默认不把图像作为可自动导出的安全材料。不得仅给 PNG 加一个“masked”标签而实际仍保存/分享敏感像素。
- 明确权限例外：用户确实需要受限原始证据时，使用显式通道和告知，不让普通 history-read 或默认任务导出隐含开放它。
- 对旧档不原地清洗，不删除证据。导出时按能力报告限制，必要时生成可追溯脱敏派生件。诊断中只显示脱敏位置和错误类型，不回显哨兵值。

### 5.3 本地验收

用纯合成隐私哨兵测试 `.rr-mask`、`.rr-block`、input/property、token 属性、URL、子 frame/open shadow，以及旧 checkpoint 和实时 snapshot。文本/JSON可用脚本扫描新产物和 API/交接输出；截图必须通过视觉/像素验证遮罩或确认被安全排除。旧档 hash 不变；正常公开业务字段仍可采集和核验；不要读取真实账号数据做第一轮隐私测试。

## 6. N05：完成生产回放与样式/页面边界，不回退已有修复

### 6.1 增量 style 文本

当前 `rewriteReplayEvent()` 对 Mutation 的 adds 和 attributes 做 URL 处理，对增量 texts 没有相同分支；`<style>` 既存文本节点变为带 `url(...)` 的内容，可能仍携带原 URL。CSSOM replace/replaceSync/adopted 现在已有处理，不能把它们又写成全部未实现。[S08]

按源节点的父类型/样式上下文识别需要改写的 text，区分普通文本与 CSS；携带正确 frame/baseURI/时序，复用 N03 资源关系。不能对所有可见文本做 CSS 正则替换。真实 fixture 修改 `style.firstChild.data`，断网回放验证历史背景资源，外部请求仍被阻止且诊断不假 ready。

### 6.2 连续录像体验的剩余接缝

当前 UI 在选中 stream 的最后一个事件结束，full snapshot 边界以 seek 跨过。对单流的 241 事件播放已有实际验证，但不能推断多次页面导航、标签切换、长空档和不同快照边界也按原时间完整呈现。[S07]

优先补最小“跟随录制中前台页面”的连贯播放顺序，底层仍按 document/stream 隔离。不需要复杂多轨视频剪辑器。跨 full snapshot/document 的源时间间隔不得被无提示省掉；“跳过空闲”必须是显式可切换选项，checkpoint 始终保存源位置而非压缩后的播放秒数。

同时验证 viewport、DPI、zoom、嵌套 frame/open shadow 命中。原尺寸布局后整体缩放展示，不能随侧栏宽度改变历史媒体查询结果。对不支持的 frame/Canvas/closed shadow 给能力报告；不能拿图像区域当 DOM 节点。

### 6.3 必须区分的资源边界

跨源图片/CSS/字体与跨源 iframe 的 DOM 录制是不同问题。Q2 覆盖常见跨源资源、同源 frame/open shadow、缓存命中、data/blob、重定向与 Service Worker 响应的既定需求；具体可用字节必须来自当时观察，不能二次普通 fetch 后称原件。要记录 redirect 最终资源 URL/CSS base，不把请求初始 URL 当所有相对依赖的基础。

跨源/OOPIF DOM 先做最小实际能力确认，只有同时证明注入覆盖、frame ID 映射、导航/回放和隐私隔离才能列支持。无法覆盖的部分如实保留；若用户任务依赖它，就是实际未完成项，不能一律标 unsupported 后宣布所有要求通过。Canvas 内部语义和 closed shadow 的通用无损恢复不因本轮自行成为新研发项目。

## 7. N06 / Q3：完成固定任务交接，减少真实 Agent 再次遇到的人工阻塞

当前公开 capability 列有 `page-create`、`handoff-export`，但已读取的生产路由/项目分派还未提供对应完整交付入口；仓库也承认 T13 和新 Agent 接续未完成。skill 入口仍主要面向开发目录；`forge.config.ts` 当前只允许 `.vite`、node_modules 和 package 文件，未将这些项目内 skill/doc 资源按运行时目录随包交付。[S13][S14][S15]

### 7.1 固定交接对象

“准备交给 Agent”生成可读 `task.md` 和机器索引（具体文件名由现有风格确定），固定：project、revisionId/contentHash、需求/字段/范围、checkpoint 引用及历史位置、证据入口、已知缺口、代码目录和运行约定、下一步。它不是视频导出，也不包含整段 DOM/响应正文。

区分用户确认的任务基线、Agent 候选资料和人工对执行结果的评审。发布不可变版本、授予执行权限、通过机器校验不相互等同；需要确认的基线由可信 UI 留下持久关联，Agent 不能自行缩小任务后冒充原要求已通过。

导出在允许目录内原子完成；必要相关资源按清单/内容哈希引用或显式包含。大小限制、缺失原件、隐私排除和取消可见。默认不导出 Cookie、profile、Bearer、签名 URL、无关项目、原始凭据和个人数据。包含 task authorization ID 时区分它与秘密，验证授权归属，不当作可跨实例永久使用的凭证。

### 7.2 身份发现与授权闭环

首次接续不要求 Agent 从被授权保护的 state 中猜出尚未得到的 authorizationId。可信 UI 提供明确的非秘密任务入口，定位当前连接文件、实例和任务授权；Agent 只在受保护本地位置读取 Bearer，不能写入交接文档或日志。

实际 state/query 返回 Agent 后续调用所需、且处于 scope 内的 session/profile/page/target/generation 等身份。保留最小 health/capabilities 发现，不以解决 bootstrap 为理由重新开放全部项目状态。

对必要的页面创建、后台页读取/操作、连续试跑，按原任务授权和明确页面所有权提供可用入口。对 page-act 等会产生外部副作用的操作，不能仅凭 API 名称宣称“绝对只读”。能力尚未实现时不广告可用；实现后做 task scope、越域、撤销、过期、预算、幂等回读和中止负例。普通读取不强迫切换前台页，也不强迫重新开始录制。

### 7.3 版本差异和事件通知

复用已有 materialDiff 和 taskChanges。提供有界摘要、游标和丢失游标的恢复方式；通知只携带已授权标识，不重复正文。资料 V1 已交接后发布 V2，不改变旧任务的读取依据；Agent 能取得差异并显式更新工作目标。

### 7.4 Skill 与 API 文档

维护一个项目级入口 skill 和按需引用说明。文档、`/capabilities`、路由和返回 schema 必须一致，去掉已退休一次授权指引；但不能为文档统一而保留兼容绕过。设计一个安装版可用的路径解析入口，后续 Q5 打包真实验证。禁止自动全局安装、修改用户全局 Codex 设置或硬编码这台开发机绝对路径。

### 7.5 Q3 的通过门槛

在一个合成项目上从 UI 固定版本交接，经明确授权启动一个空白任务，只用公开接口发现对应身份、分页读出目标节点/字段、创建候选改进、读取差异、试跑、读取结果并正确处理授权撤销。此处先用自动客户端 smoke；真正全新模型的 AT39 放在 Q6，避免每改接口都启动昂贵的新模型验收。

## 8. Q4：稳定性、恢复与新架构长测

### 8.1 先列覆盖差额，不重新发明测试体系

把原 AT01–AT40 映射到当前实际测试文件、最近通过的代码 SHA、产物路径、尚未证明的性质。298 项不是验收目标，也不能用测试数量增长证明风险关闭。[S02][S16]

包内先跑定向测试；进入稳定集成点再运行全量单元、typecheck/build、原有完整桌面/profile/恢复矩阵以及新的 refactor system/recording。只有运行时相关变更才扩大到对应矩阵，纯文档更新不反复重跑全部测试。

### 8.2 恢复验证

覆盖录制/批次已确认回执前后强杀、目录半初始化、索引截断/损坏、资源 manifest 与 blob 不一致、缺失可重建索引、磁盘满/慢、取消与关闭重入。普通读历史不能领取写锁或悄悄改原件；恢复动作显式记录，原始损坏字节保留。

健康数据继续可读，但整体正确性不足必须有诊断。证据缺口不能被一个正常页面截图掩盖；非法路径/链接继续拒绝，不因逐项错误隔离跟随目录逃逸。

### 8.3 新架构 30 分钟负载

沿用既有固定硬件和基础负载口径，加入 format2 的结构事件、间歇资源、分段完整快照、多文档导航、随机 seek 与关闭重开，不把旧录制器的长测算给新架构。生产 ReplayHost 必须参与，不另造宽松播放器完成测试。

测量并保存：按通道队列数量/字节/丢弃、body 工作集、磁盘写入、确认回执/缺口位置、Replayer 重建次数、seek P50/P95/最大值、主/业务页/回放进程内存和增长趋势，以及测试窗可见/隐藏与节流状态。先做短预检，再跑一次有意义的长测；失败定向诊断后再跑，避免在没有新信息时重复整段测试。

记录 warm-up、峰值、后半段斜率、反复 seek 后是否回落；不要用首尾两张内存快照宣称无泄漏，也不预设一个未经机器基线验证的“零增长”门槛。上轮可测门槛不能为了通过而偷偷放宽；若原门槛缺失，在短预检后冻结可解释门槛再进行正式测量。

桌面、物理输入和长测只允许一个 owner；其他非冲突单元任务可并行。不得为了省 token 关闭 CSP/sandbox、跳过 UI、忽略资源失败或丢结构事件。

## 9. Q5：分发包和独立业务产物

### 9.1 分发范围

继续采用当前 Forge/Vite/React/Node 组合，不在交付收尾顺手换 builder 或整仓升级依赖。核对实际安装版本与 lock；常用命令沿用 package.json，新增必要的验证选项即可。

显式列出包内所需：main/preload/renderer、rrweb 适配器、runner/portable helper、运行时依赖、入口 skill、精简 API/reference、业务模板和必要许可。只复制所需静态资源，不将整个 repo、测试记录、profile、连接秘密和 worktrees 入包。按打包后真实位置/`import.meta` 规则解析，不能依赖源码当前目录。

现有配置的 Windows maker 是 ZIP；先交付并验证已承诺的 Windows ZIP/应用。不要未经要求增加 MSI、自动更新、签名购买等另一个项目。签名若确需外部证书属于可单列的分发限制，不伪造已签名。

### 9.2 安装版测试

从实际 make 产物复制/解压到新的、含空格/中文路径，临时隔离开发目录访问并使用新的 BES_DATA；启动并验证录制、离线回放、注释/资料编辑、任务授权、执行/结果和退出重开。确认没有读取开发目录的 worker、node_modules、skill 或手工缓存文件。

发布前对 archive 清单做静态检查，确保没有真实录制、Bearer、Cookie、profile 或测试哨兵。报告记录源码 SHA、锁文件/构建摘要、实际产物路径/哈希和已验证平台，不把 build 成功当 make/安装版成功。

### 9.3 独立业务目录

复制最终业务脚本到 Studio 仓库外的新目录，使用自身 package/lock 和输入/输出目录，按声明命令安装并执行。关闭 Studio 后仍可以用普通 Puppeteer/可选便携 helper 完成该任务；不能靠 Studio 内部控制接口、录制动作 DSL、隐藏开发路径或运行时模型自愈。

认证状态的取得按真实站点要求处理，不把 profile 拷到 Git。合成站点可自动验收，真实账号需要人的部分最后请求。至少演示一项独立模块失败而后段无依赖模块继续，以及部分结果与重跑 attempt 可追溯。

## 10. Q6：全新 Agent 验收与完成定义

### 10.1 AT39 新 Agent

只在接口和分发稳定后启动一次真正独立上下文的任务；不要 fork 全部实施聊天。它只拿 Q3 生成的固定资料交接、入口 skill、当前合法授权入口和独立代码工作目录。

新 Agent 可通过目标网页和授权证据发现内容，但不给 fixture 源码、预制答案、上轮实现推理或隐藏测试期望。选择具有列表+详情/分页、动态值、一次可解释异常的合成业务；随机化数据以防直接复制示范样例值。

验收内容：定位字段与来源 → 实现普通脚本 → 受控试跑 → 看懂一项真实失败/来源不足 → 修正 → 独立运行交付。保留新任务 ID、实际配置、固定资料版本、调用和测试结果。出现平台缺陷时由实施 owner 修复，再定向确认；不是让一个 Astra 管理层全程代读材料并替新 Agent 写代码。

这次接受新 Agent 子任务是产品验收的必要工作，不意味着恢复多层并行管理。若当前原生能力不可用，使用实际支持且已授权的 CLI 独立任务；不替换为额外付费 API、不绕过权限、不造调度平台。

### 10.2 人类/真实账号场景

准备一份最小的操作请求，说明站点、动作、观察目标、隐私规则和输入保护。仅请求无法自动完成的登录/验证码/OS 物理鼠标等；不把所有集成排查交给用户。

用户尚未提供/允许真实账号时，不自行读取历史凭据，不推断登录成功。其余任务继续，最终分开报告“合成与分发已完成”和“指定真实站点/人类场景未测或被阻塞”。若该真实场景是交付必须项，整体状态仍是条件完成，不写全量通过。

### 10.3 最后集成关口

在最终运行时代码上完成受影响全量/桌面/安装回归，长测是否需重跑按最后变更是否涉及采集/回放/资源/生命周期判断。不得引用较早包的全量结果替代最终代码；也不因最后只有文档提交重复所有长测。

最终报告至少包含：

- 实施基线、最终代码提交与发布清单，哪些旧工作树只保留不再使用。
- AT01–AT40 的通过证据、明确未测/阻塞/不支持边界；不能只给总测试数。
- 真实生产 JSON 与 DOM 两条来源路径、隐私、播放时序、资源和恢复的关闭证据。
- ZIP/应用和独立脚本的实际路径、哈希、运行方法、限制。
- 可取得的本批用量事实；若只有账户滚动百分比，标“不能分解本批”，不推算零消耗或精确 token/费用。
- 需要用户处理的唯一剩余人工事项；没有则明确没有。

## 11. 低协调成本执行协议：沿用有效方式，扩大完成范围

### 11.1 不新增管理层

默认 Sol/high 会话自己实施、用工具处理 Git、测试和文档。即使六个批次均需完成，也不同时启动六个 Agent。Astra/high 仅在已经有具体代码/复现且需要高风险判断时使用；review 绑定 base/head、问题和影响范围，不重新全仓巡检。实施者不能再递归派发。

需要第二个实施任务时，独立工作目录和文件所有权明确；它不能与当前 owner 同时改同一入口/契约/lock。交付后一次收拢，不逐个小提交双向同步。已有工作树和成果全部保留，不自动清理/强推/重置。

### 11.2 Git 与通信

开始时核对当前主树、相关 worktree、未提交改动和实际任务。随后只有相关状态变化才重查，不每次扫描全部旧树。正常命令批量执行并保留错误处理；提交只纳入本任务明确路径。按独立逻辑保存必要 commit，但通信以可验收包为单位。

仅在交付、真实阻塞、契约决策时消息往返。测试成功回传命令、退出码、范围和日志路径；失败只先读有效错误及相邻上下文。完整输出落盘不等于必须放入模型历史。等待长测试使用工具等待/完成信号，不高频由模型轮询。

两次返修没有新增诊断证据时，先缩小复现或做定向 reviewer；不是两次后可以留下已知严重缺陷。修改测试必须说明断言为何不符合真实契约，不能只求绿色。

### 11.3 接续和上下文

当前会话上下文仍有效就继续，不为每个 Git 事务另开任务。上下文确实臃肿时，只在安全批次边界产生一页当前接续摘要：当前代码、完成批次、下一步、未解决问题和准确证据路径。用独立不继承全历史的任务接续，原任务不再重复审查或作为第二管理者持续等待。

不设置一个巨大的自定义上下文上限来代替整理，也不默认修改全局 Codex 配置。工具不支持自动换任务时如实停在已保存边界，不假装有后台持续运行能力。

### 11.4 预算与阶段结束

这份计划替代 `04` 的“R1–R8 完成后暂停”结束点。现在完成一个 Q 批次后继续下一个，直到剩余原要求的可执行部分验收完毕。阶段汇报保持短，不需要用户反复输入继续。

不保证固定 token/天数：上轮用户感受和相同 19% 账户窗口只支持继续有效工作方式，不能据此线性外推费用。用已有指标记录阶段差额即可，不新建监控系统，不让模型通读全部会话日志。达到真实额度限制或用户设定预算时安全保存，不绕过限制。

## 12. 补充回归清单（接到既有 AT，不机械追求测试数量）

| 编号 | 必须证明的性质 | 原 AT 关联 |
|---|---|---|
| NX01 | 真实 CaptureCoordinator 网络 JSON 在正确 scope 可独立核验 | AT35 |
| NX02 | 网络响应延迟落盘/跨页/重叠 scope 不伪造唯一来源 | AT06/35 |
| NX03 | 播放准备期间暂停会阻止后来自动开播 | AT14/15/18 |
| NX04 | 播放/暂停/seek/检查/关闭的迟到回执不能反转有效意图 | AT15/18 |
| NX05 | 慢资源在 full snapshot 之前的加载后 checkpoint 可离线还原 | AT11/12/14 |
| NX06 | 同 URL 多版本和 CSS 相对依赖不读取未来或其他 frame 内容 | AT12/22 |
| NX07 | style 文本、CSSOM/adopted、加载依赖均走生产资源策略 | AT11/12 |
| NX08 | 旧 DOM 快照、实时摘要、截图和导出不绕开隐私规则 | AT24 |
| NX09 | 多文档/页面及快照边界保持源时间，显式空闲跳过不改 anchor | AT06/14 |
| NX10 | DPI/zoom/viewport/侧栏变化下 DOM 命中与历史布局一致 | AT13/18 |
| NX11 | 新任务从固定交接发现正确实例与授权，过期/撤销/跨项目拒绝 | AT30/37/38 |
| NX12 | 缓存/blob/data/redirect/SW 的真实可用范围可解释且不联网补原件 | AT11/12 |
| NX13 | format2 强杀与资源/数据目录故障仍保留已确认材料 | AT07–10/34 |
| NX14 | 30 分钟长档、随机跳转、新进程重开有可复查性能/完整性数据 | AT09/16 |
| NX15 | 安装 ZIP 与独立业务目录不读取开发机依赖路径 | AT40 |
| NX16 | 全新 Agent 只靠固定资料完成发现、实现、排错与交付 | AT39 |

## 13. 核验来源（按当前问题阅读，不要求全部加载）

以下代码链接固定到本轮远端基线，文档观点与工程安排是本次建议；代码事实和仓库测试声明分别引用其来源。

[S01] 当前主分支及提交：
https://github.com/ghostroller/browser-evidence-studio/commit/5444ea504f5d7cc6b285022890fba0369248e5d0

[S02] 本轮实际交接与验证边界：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/docs/refactor-handoffs/G-R1-R8-20260926.md

[S03] JSON source scope 消费、真实 DOM sample：`src/main/services/project-executions.ts`，重点 assess()：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/services/project-executions.ts

[S04] 响应回调、body artifact producer、resource source position、artifact helper：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/capture/coordinator.ts

[S05] 请求身份台账与 response()：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/capture/request-ledger.ts

[S06] play/pause/render/status/select 生产宿主：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/services/replay-host.ts

[S07] 播放准备、暂停按钮、分段与切流：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/renderer/components/replay-workspace.tsx

[S08] URL use 源位置解析、Mutation texts 缺少 style 分支、CSS 依赖：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/resources/replay-resources.ts

[S09] 资源 manifest、resolve 的 eventSeq 上界与缓存 probe 策略：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/resources/archive.ts

[S10] checkpoint/snapshot 的旧采样和 protectCaptureMetadata：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/services/studio.ts

[S11] 新 source recorder 隐私策略与 input/attribute 处理：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/capture/source-recorder.ts

[S12] artifact byte 内容处理与保存：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/evidence/store.ts

[S13] API/capabilities 和项目门面：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/api/server.ts
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/services/project-dispatch.ts
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/main/services/dispatch.ts

[S14] Skill 入口与客户端发现：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/skills/browser-evidence-studio/SKILL.md
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/skills/browser-evidence-studio/references/api.md

[S15] 真实分发白名单和 portable 构建项：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/forge.config.ts

[S16] 原始产品实施要求、AT01–AT40 与范围：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/docs/refactor/01-modification-plan.md

[S17] 已修复的移动节点源模型，不重复实施：
https://github.com/ghostroller/browser-evidence-studio/blob/5444ea504f5d7cc6b285022890fba0369248e5d0/src/replay/source-model.ts

[S18] OpenAI 官方子 Agent 配置、模型/effort 及额外任务的上下文/用量边界（核对日 2026-09-26）：
https://learn.chatgpt.com/docs/agent-configuration/subagents
