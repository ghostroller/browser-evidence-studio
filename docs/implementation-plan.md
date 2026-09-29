# 具体实现路径

状态：2026-09-29 本轮执行 W0 最小契约、W1 集中编辑与存档、W2 管理/浏览器、W3 当前构建验收，范围由13/14与用户本轮授权确定。唯一入口见 [README](README.md)，实际提交/测试见 [本轮交接](refactor-handoffs/WORKSPACE-UX-20260929.md)。以下 M0–M3 表格和旧暂停点保留为历史规划，不是本轮自动停止或指定模型的规则。

## 1. 推进方式

| 产品阶段 | 工作与退出标准 |
| --- | --- |
| M0 | Astra/high 直接核实 P01–P13，记录一页状态/命令与关键失败点，立即进入实现；保留版本、原件和 partition 映射 |
| M1 | 同一实施者接通空应用独立环境→可见示范→统一保存点→实时字段→停录→历史编辑→固定版本→同版执行。修复 dataset、keep/set/clear 和编辑丢失；U01–U06 全部真实通过并有连续窗口证据 |
| M1 产品门 | 独立上下文按普通用户路径复走，交付可运行成果与准确证据后暂停，请用户确认核心交互；确认前不展开 M2/M3、全面长测或打包 |
| M2（需后续授权） | 沿已通过纵向骨架完成环境管理/迁移、全图关系与分页恢复、独立实现映射等；接口明确后才拆 Sol/high 独立包 |
| M3（需后续授权） | 剩余阻塞用户旅程、代表性页面、受影响底层回归、确切候选发行与适用长测；真实账号仅经用户配合授权 |

产品旅程从空隔离 BES_DATA 开始，只用可见 UI 创建任务、环境、卡片、字段与版本；执行验证必须使用同一份 UI 资料。内部 dispatch 补 dataset/proof、另一个 fixture 的 executionId、按钮成功提示均不能替代验收。模块测试仍可直接调用服务，但报告其前置；不把旧组件/接续夹具重新命名为新旅程。

常用入口收敛到 package.json，产品纵向入口为 `npm run test:journey`。修改后运行受影响测试与实际 UI，保留失败日志；未经实际运行不写通过。Node/npm 在执行前核对，固定依赖不因纠偏而升级。安全、取消、来源真实性和耐久边界不降低。

2026-09-28 用户授权实施 T1–T3，接续 [E01–E04 交接](refactor-handoffs/PRODUCT-M1-E01-E04-20260927.md) 的已有成果。此前独立复走发现的 number/dom-text 冲突已用显式 plain-decimal v1 修复，旧精确文本和旧固定版不改；dirty 编辑、字段归属、孤儿采集及结果定位一并补齐。冻结开发构建 `42ccf54` 的实施者可见数值 U01–U06、正常重启通过，acquiring 强杀恢复在 `c601ffa` 上通过。独立空根复走发现的派生草稿需求选择循环已补修，原现场恢复成功；独立同版三态、覆盖负例、双来源和最终重启均完成，录像中断/失败仍按实保留。不能把分段证据称为独立全程无中断录像。其余故障逐项按真实验证层级记录，见 [T1–T3 交接](refactor-handoffs/PRODUCT-T1-T3-20260928.md)。现暂停核心交互确认，不宣布 M1 最终完成；E05/E06、M2/M3、全面长测和打包未展开。

以下 §2–§11 保留 2026-09-22/23 的历史需求追踪与技术里程碑，用于解释旧证据范围，不是本轮自动执行队列。其 M0–M6 编号与上表产品 M0–M3 含义不同；后续接续以本节与 progress.md 为准。

## 2. 需求追踪

| ID | 需求 | 实现阶段 | 主要验收 |
| --- | --- | --- | --- |
| R01 | 稳定环境、可启动桌面和内嵌浏览器 | M0 | 干净安装、窗口、导航、target 身份 |
| R02 | 项目/运行管理与落盘 | M1 | 重启后可查、ID 稳定、崩溃尾部处理 |
| R03 | 连续动作/网络/页面证据与回看 | M1/M2 | 请求正文、跳转、DOM 回放、缺口可见 |
| R04 | checkpoint、说明和元素选择 | M2 | 原生输入锁、截图/DOM、一致性、无需 ref |
| R05 | 人机交接与取消恢复 | M3 | 不并发操作、超时不误判、断线后状态真实 |
| R06 | 手动保存和复用登录环境 | M3 | profile 隔离、重启、过期与不支持状态 |
| R07 | Agent HTTP 控制与有界读取 | M4 | 正文预算、游标、目标/控制权、异步 job |
| R08 | 原生 Puppeteer 运行及独立脚本 | M5 | 无临时会话变量、独立启动、无 LLM 依赖 |
| R09 | checkpoint/数据/版本验收 | M5 | 需求覆盖、字段语义、版本变更失效 |
| R10 | agent skill 和交接说明 | M6 | 新任务仅靠入口+索引完成接续 |
| R11 | 长流程、成本和可靠性 | M1–M6 | 20–30 分钟录制、读取成本、故障恢复 |
| R12 | 包装发布和人类最终验收 | M6 | 可启动产物、真实流程、限制清单 |

可撤销 DOM 隐藏、跨浏览器导入、外部浏览器模式、程序侧观测等增强另列 P1，不阻塞 P0。元素检查与定位记录属于 P0。

## 3. M0：桌面和浏览器技术闭环（高不确定性）

目标：证明本地 Electron 内嵌页面可由人操作、可被 Puppeteer 控制、可被持续观察，并且不会连错宿主 UI。

实现：
1. 以 Forge + Vite + TypeScript 整合最小工程，保留已有文档和 .git；加入 React。用户已明确改用 Vite。锁定非预发布依赖、package-lock.json、engines 和 packageManager。
2. src/main/app.ts、window.ts 建立可信 UI 和一个 WebContentsView；实现 BrowserRegistry。
3. 建立内部 CDP 连接，puppeteer-core 连接指定 target；在合成页执行导航、点击和读取。
4. 实测 CDP 捕获与控制同时工作；验证新窗口、iframe、刷新、DevTools/detach。
5. 加入 rrweb 稳定版最小注入/回放，跨导航重新建立记录；同时保存一条独立响应正文。
6. 原生视图级输入锁原型：阻止鼠标和快捷键，期间页面异步更新仍可继续。同时验证 Puppeteer 操作连接的撤销/闸门：人工交接前排清在途命令，交接期间并发 Promise/定时器命令被拒绝；采集连接继续工作。无法安全暂停的强制接管须先断开/终止 runner，不能承诺续跑原栈。
7. 验证 profile 持久化及 utility/worker 生命周期，确定发行运行时不依赖开发机的 Node 安装方式或版本管理器。

交付与通过标准：
- npm start 可开窗口，npm run test:integration 可复跑本地夹具。
- 明确区分业务 target、UI target、新弹窗，绝不按 URL 猜测页面。
- Puppeteer 操作和网络记录同时存在；通过一次 reload 后仍可继续。
- rrweb 回放基础动作/滚动；不支持区域有记录，不宣称完整回放。
- 关闭窗口/取消任务不残留无主 worker，重启可识别上次异常。
- docs/verification.md 记录实际版本、命令、能力和失败项。

失败处理：先调整当前稳定组合/连接方式。若内嵌站点能力或原生输入锁不成立，记录 ADR 更新架构，再继续；不静默换成外置浏览器并宣称原需求已实现，也不回退旧 Node/Puppeteer。

## 4. M1：证据存储与连续录制（中高复杂度）

路径：src/evidence/*、src/capture/cdp.ts、coordinator.ts、rrweb.ts、main/services/run.ts。

实现：
- 固化 Run/Event/Artifact/Checkpoint schemaVersion，建立一个写入队列。
- 分块追加 CDP 和 rrweb 原始材料，保存请求/响应/各跳重定向身份。
- 文本正文预算、二进制排除、失败状态、hash 和来源引用。
- 轻量元数据索引包含文件/块/字节偏移，增量更新，不在每次 checkpoint 重扫全部 run。
- flush/seal、损坏尾部、恢复扫描、已提交边界。
- 项目列表、运行登记、历史运行只读浏览。

验收：
- 同一请求跨 checkpoint 不重复生成实体；重定向每一跳可区分。
- empty、missing、truncated、excluded、read-failed 可分别构造和读取。
- 375 KiB HTML/内嵌 JSON、至少 1 MiB JSON 夹具可完整捕获和定向读取；超过配置限制明确截断。
- 在原子提交各位置强制结束后，已确认保存材料仍在；索引重建不改 ID。
- 高速事件下有背压/丢弃计数或 gap，不能无限占用内存。

## 5. M2：人工录制工作台（中高复杂度）

路径：renderer/features/recording、checkpoint、timeline、evidence；capture/checkpoint.ts；preload/observer.ts。

实现：
- 项目创建、通用录制、地址栏和业务标签页。
- 保存 checkpoint 的标题/描述、截图、DOM、导航代际与部分失败状态。
- 页面检查模式高亮和选择；保存候选 selector/role/text/frame，不要求用户打开 DevTools。
- checkpoint 之间的时间线：动作、导航、网络、关键截图；接入 rrweb 回放并可跳转。
- checkpoint 小图和索引异步加载，正文/大图点击后读取。
- 结束封存、健康提示和历史材料浏览。
- 暂停操作/暂停录制的明确文案，原生覆盖和页面后台变化提示。

验收：
- 保存期间人工和 HTTP 写操作均不能扰动页面；系统/业务新窗口处理有明确结果。
- DOM 成功截图失败仍能保存部分 checkpoint；导航穿越会标 mixed。
- 关闭过的弹层可从已保存证据读取；没有保存的不伪造。
- 快速点击保存/结束不会生成互相冲突的状态或重复记录。
- 用户只在客户端完成主流程，不输入命令或元素 ref。

## 6. M3：登录环境与人机交接（中高复杂度）

路径：main/browser/profiles.ts、input-lock.ts；services/handoff.ts；runner/context.ts 的接口定义；renderer/features/profiles、handoff。

实现：
- 项目内命名 profile、独占 lease、save/reuse、实际保存范围说明。
- 控制权状态机、HTTP 代际检查、Puppeteer 传输闸门；停在等待点并确认闸门生效后才交还人工。
- QR 风格合成夹具：准备页、二维码过期、手动完成、服务端确认、刷新重试。
- 完成条件由调用方指定；人按“交还”后先只读验证。
- 暂停、取消、重启、进程失联后的解释性恢复入口。
- 本机保存的交接上下文包括目标、页面、attempt、下一步和未知项。

验收：
- 正常持久 cookie/localStorage/IndexedDB 在重新启动后可复用；sessionStorage/内存会话不支持时明确说明，不暗中宣称支持。
- 不同项目或 profile 不串账号，同一 profile 不并发。
- 等待期间录制继续；超时/无回复不成功；脚本在人工窗口无写操作。
- agent 任务退出或人离开后，浏览器仍有清楚状态和可恢复材料。
- 崩溃、PID 重用、残留状态文件不显示为健康运行，不要求用户手工 kill/移动锁。

## 7. M4：HTTP 和证据读取（中复杂度）

路径：main/api/*、contracts/api.ts、evidence/reader.ts、index.ts。

实现：
- /v1 能力发现、项目、运行、页面、checkpoint、证据、handoff、job 接口。
- 共享服务层驱动 UI/HTTP，避免两套业务状态机。
- token/loopback/Origin/Host 检查；异步 202、取消、幂等键。
- summary → gaps → events/find → 指定 artifact/JSON path/DOM 片段。
- 字段投影、字节预算、分页游标、generation ref 过期。
- 每次读取记录耗时和实际响应字节；无 token 来源时不捏造。
- connection 文件与短 API 使用说明，不在正文反复输出全部 schema。

验收：
- 一次摘要足以定位 run 范围、checkpoint 和缺口，无需读取全部 rrweb/CDP。
- 多字节字符切片、真实 null、缺字段、方向错误、越界路径、游标失效有明确结果。
- 错误 HTTP 状态与 JSON 一致；超过预算返回可继续读取的方法。
- 非授权网页无法管理客户端；agent 无法操作错误页面或过期控制权。
- 长任务启动快速返回，客户端关窗/断线不会让 HTTP 调用永久挂起。

## 8. M5：原生脚本复跑与验收（高复杂度）

路径：runner/*、contracts/workflow.ts、services/validation.ts、renderer/features/validation。

实现：
- 薄 workflow manifest、输入输出 schema、登记入口和允许目录。
- 在独立 worker 中运行普通 Puppeteer entry；提供窄 reporter，不重做 Page API。
- 绑定代码/构建/配置/锁文件指纹、启动命令和退出结果。
- checkpoint 报告、数据输出、附件、人工协助、取消和失败材料。
- 稳定 requirementId/checkpointKey 映射，不要求录制动作逐项等长。
- 示范/复跑截图及数据比较；主键、必填、类型、去重、分页终止、关联断言。
- 覆盖/断言/人工评审分别保存；版本变更后历史 pass 不自动应用。
- 一份普通 Node/Puppeteer 交付样例可脱离客户端启动，报告接口可选。

验收：
- 合成示例包括登录、分页、SSR/API 重叠、详情分支和一个需人工确认的点。
- 不借助 agent 临时点击修复，脚本独立完成声明流程；声明的人工登录协助允许且有记录。
- 图片误取另一实体、只读第一页、字段缺失等错误确实被断言发现，不能只检查非空。
- 业务逻辑使用 Node 请求时必须附入来源或显示观测缺口。
- 修改脚本或配置后重新验证；未运行构建/无证据/未覆盖需求不会标总评通过。
- 交付脚本没有 Electron 服务或 LLM 的必需运行依赖，也没有 Node 14 适配代码。

## 9. M6：长录制、技能、包装和真实验收（中复杂度）

路径：test/fixtures、test/integration、test/desktop、skills/browser-evidence-studio、docs/verification.md、Forge 打包配置。

实现：
- 统一合成站点覆盖网络失败、慢请求、快速消失 DOM、iframe、popup、下载及可控故障。
- 20–30 分钟录制与重开、索引重建、按需回读。
- skill：入口短说明 + 按需阅读 API/探索/补录/验收；使用 skill-creator，不自动全局安装。
- 保存最小 handoff：目标、当前版本、证据索引、缺口、下一步，不依赖完整聊天。
- Windows 可运行发行包；无签名时如实说明发行状态，不伪造正式发布。
- 在用户可配合的时段使用拼多多流程进行最后的真人演示→新脚本→验收。不修改既有 pinduoduo-plugin；它是业务参照。

通过标准：
- 新 agent 只读入口文档与摘要，可以定位证据并完成一个修改/复跑。
- 用户完成真实演示和扫码时无逐点击聊天确认，无无法解释的长等待。
- 真实验收报告注明站点、账号范围、变体、版本、数据来源与未覆盖项。
- 对应 R01–R12 有结果和材料；未完成事项不能包装成已验收。

## 10. 统一测试和性能目标

package.json 已提供常用入口：start、build、typecheck、test、test:watch、test:integration、test:desktop、test:soak、test:example、package、make。`test` 使用 Vitest 一次性运行普通测试，`test:watch` 用于本地持续反馈；桌面和独立示例入口仍执行真实进程。命令实际运行结果见 verification.md。

初始性能目标（在指定 Windows 测试机、固定夹具和 30 分钟 run 上测量；2026-09-23 已有部分实测，整体尚未达成，范围见 verification.md）：
- 保存 checkpoint 100 ms 内显示反馈；持久化图/DOM 的 P95 目标不超过 2 s。
- 超过 2 s 显示具体进度；10 s 到达部分结果/可取消状态，不无限转圈。
- 30 分钟历史摘要/索引查询 P95 目标不超过 500 ms，正文定向读取不扫描全部文件。
- 长任务 HTTP 提交 P95 目标 300 ms 内返回 jobId；执行时长另计。
- 录制应用内存不得随已封存块总量无界增长；区分业务页面内存与工具索引/队列内存。
- 合成负载下已确认保存的事件零丢失；所有丢弃/失败均有显式计数或 gap。
- 长 run 与短 run 的同一字段查询保持相同输出预算，不因录像变长而整体输出。

先记录实际基线和瓶颈，再优化；不得靠减少所需证据或静默截断达标。离线字段回归应独立于真人扫码，减少人机等待和成本。

2026-09-23 长测验收固定以下负载与判定，结果另记 verification.md：默认运行 30 分钟，每秒一轮唯一序列点击及 64 KiB JSON，每分钟追加 1 MiB JSON 和 HTTP checkpoint，页面持续 100 ms DOM 更新。记录实际轮数、调度延迟与超期，不能将慢处理后减少的轮数当作原负载达成。checkpoint 保存 P95 ≤2 s、摘要查询 P95 ≤500 ms、HTTP job 提交 P95 ≤300 ms；查询沿用固定字节预算。封存前后及新进程重开时独立核对动作/请求集合、正文和原件 hash、索引计数与 checkpoint 身份。此负载不代表任意站点的满负载，100 ms 界面可见反馈需单独测量。

内存同时记录主进程 RSS/heap 和业务页面进程私有内存/JS heap，主进程数值包含合成夹具与测试逻辑。运行保护上限预先设为主进程 RSS 1 GiB、页面私有内存 512 MiB；它们是本次测试边界，不是产品 SLA。报告预热后窗口统计和变化斜率，不用有限时长或一次首尾差值证明永不增长。`npm run test:soak` 默认 30 分钟，`npm run test:soak -- --soak=1` 只做机制预检，`--soak=20` 可复跑原时长。

## 11. 当前实施交接

> 在 `D:\Workspace\browser-evidence-studio` 中先按产品 08/09 推进 M0/M1。实际 Astra/high 直接实施，从空隔离数据根通过可见 UI 完成独立环境准备、示范、统一保存点、实时字段绑定、停录历史编辑、固定版本和同版执行。由独立上下文复走普通用户路径，交付可运行成果与连续实际窗口证据后，等待用户确认核心交互。保留原件、固定版、登录 profile 与安全/取消边界；不通过隐藏业务预置修场景，不提前扩大长测、打包或真实账号验收，不自动推送或清理工作树。

早期 M0–M6 技术里程碑仅作本文历史参考，不能替代本轮 U01–U06 产品门。后续 M2/M3 的启动须以用户确认后的范围为准。
