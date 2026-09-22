# 具体实现路径

状态：实现进行中。以下是里程碑目标；实际命令、通过结果及待验证范围见 verification.md。日期：2026-09-22。

## 1. 推进方式

当前 M0–M5 核心已实现并有合成通过证据，M6 仍有待验收项；逐项状态与后续工作见 [progress.md](progress.md)。本文各节路径表示职责规划，不要求与当前文件拆分一一对应。

按 M0 → M1 → M2 → M3 → M4 → M5 → M6 连续推进。每阶段都有可运行的纵向切片，不先搭建所有接口或空模块。测试、夹具、启动入口统一进 package.json；不增加大量外围辅助脚本。

技术验证代码优先留在最终模块和 test/integration，避免另建一套随后丢弃的原型工程。所有测试用合成页面和假数据；真实拼多多仅在工具闭环完成且用户方便时验收。

工作量按相对复杂度评估，不承诺未经验证的工期。最大不确定性是 Electron/CDP 共存、原生视图输入锁、rrweb 注入边界和进程恢复。

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

package.json 已提供常用入口：start、build、typecheck、test、test:integration、test:desktop、test:soak、test:example、package、make。命令实际运行结果见 verification.md。

初始性能目标（在指定 Windows 测试机、固定夹具和 30 分钟 run 上测量，尚未达成）：
- 保存 checkpoint 100 ms 内显示反馈；持久化图/DOM 的 P95 目标不超过 2 s。
- 超过 2 s 显示具体进度；10 s 到达部分结果/可取消状态，不无限转圈。
- 30 分钟历史摘要/索引查询 P95 目标不超过 500 ms，正文定向读取不扫描全部文件。
- 长任务 HTTP 提交 P95 目标 300 ms 内返回 jobId；执行时长另计。
- 录制应用内存不得随已封存块总量无界增长；区分业务页面内存与工具索引/队列内存。
- 合成负载下已确认保存的事件零丢失；所有丢弃/失败均有显式计数或 gap。
- 长 run 与短 run 的同一字段查询保持相同输出预算，不因录像变长而整体输出。

先记录实际基线和瓶颈，再优化；不得靠减少所需证据或静默截断达标。离线字段回归应独立于真人扫码，减少人机等待和成本。

## 11. 后续任务的交接文本

> 在 `D:\workspace\browser-evidence-studio` 中按 docs/design.md、docs/architecture.md 和本实施计划推进客户端。先读 docs/progress.md 与 docs/verification.md 确认当前已通过范围和代码/产物差异，不再在旧 Codex worktree 开发，使用 Forge + Vite + TypeScript + React 工程继续 M0–M6 的未完成验收，形成“人工示范→证据→原生脚本→逐 checkpoint 验收”闭环。所有功能使用新项目；agent-browser-evidence 只读参考。不要兼容 Node14/旧 Puppeteer，不做完整 DSL、站点模板或插件装配，不启动真实账号流程来代替工具回归。每阶段更新实际命令、版本、验收结果和限制；遇到关键技术失败先修订设计并给出证据。

这是一段可用于后续会话的任务说明；设计目标和已验证实现必须结合 verification.md 区分。
