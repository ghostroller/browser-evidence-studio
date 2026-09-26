# Browser Evidence Studio：Q3 后 Review 与并行收尾计划

**日期：2026-09-26｜远端核对基线：`046a52e7432fdcebb9524b661ebf4166b80acba1`**  
性质：修改建议和执行授权范围说明，不是已实施或已通过的报告。配套短提示词为 `resume-prompt.txt`。

## 0. 执行摘要：主控先读本节，再按工作包读取

### 本次意图

用户认可上一轮较低的用量，但不能接受所有开发与验证都串行等待。本轮优化目标是：**降低最终交付的墙钟时间，保留低沟通、低重复审查的执行结构**。不是恢复 Astra 常驻管理、A–G 多层代理、逐小提交双向搬运的方式。

`05` 的 Q1→Q6 是完成目标的依赖框架，**不再解释成所有实现都必须按该顺序开始**。本文件更新调度和本轮已识别的修复要求；原 `01` 产品目标、AT01–AT40、安全边界继续有效。`03/04/05` 中“默认单实施者、最多一个额外实施者、只完成某一批就暂停”等与本次冲突的调度限制被本次明确请求替代。历史验证记录不改写。

### 已有成果与真实边界

- `5444ea5 → a0fbbd3 → 25b7baa → 046a52e` 分别推进了 Q1、Q2、Q3。不能用提交数量少推断工作量少。[S01][S02][S03]
- 保留网络 JSON 来源身份、隐私限制、播放命令代际、晚资源激活、前台流、固定交接与后台页等实现，不重做 R1–R8、Q1–Q3。[S02][S03]
- Q3 记录：54 文件／326 项单测、typecheck、build、handoff/system 专项通过；**最终 Q3 SHA 上完整旧桌面矩阵未通过**。Q2 的完整通过不能挪用到 Q3。[S02][S03]
- 现有旧 A/B/C/D/E/F 和 S0 工作树是保留成果，不是新开发基线。本轮从核对后的当前 main 建立新的 L/R/P 工作树；不 reset 旧树、不重复 cherry-pick 已集成的等价补丁。
- 本次 Review 是定向静态审查。没有运行项目依赖、Windows/Electron、真实账号；失败日志的具体内容以本地文件为准。交接包包含两个独立控制流／体积实验，不冒充项目测试。

### 立即启动的工作

| 工作流 | 首要任务 | 默认模型与强度 | 何时开始 |
|---|---|---|---|
| **L：原生生命周期与输入** | C01/C02，定位三条完整矩阵失败，修复并取得短闭环 | **GPT-6 Astra / high**，只承担这个高风险修复包 | 初始核对完成后立即 |
| **R：恢复、索引与长测** | C03，独立恢复夹具与新架构长测入口 | **GPT-6 Sol / high** | 与 L 同时，不等完整矩阵通过才写代码 |
| **P：交接、分发、独立运行** | C04/C05，修交接规模限制并完成 Q5 实现、Q6 准备 | **GPT-6 Sol / high** | 与 L/R 同时，不等 30 分钟长测结束 |
| **主控** | 维护短任务表、合并已完成包、安排独占测试 | **GPT-6 Sol / medium** | 持续；不重复三流根因分析 |

目标是**主控 + 三个直接实施任务**。先核实实际客户端允许的并发槽位；容量不足时运行可用的最多独立任务并候补，不能绕过运行时限制。模型/effort 在实际启动配置中设置，记录工具接受值，不能仅写在提示词中。L 做完本次生命周期包就交付并结束；不得把它变成新的 Astra 常驻管理者。

**只序列化独占资源，不序列化全部开发。** 一个操作桌面的 Electron 进程组同时运行；其他流仍可以改代码、读资料和做不争抢桌面的窄模块测试。正式性能测量期间暂停安装、打包及高负载并行测试，以免污染结果。

---

## 1. Review 结论与修正方向

| 编号 | 结论 | 状态／优先级 |
|---|---|---|
| C01 | stale `close(replayId)` 先递增全局 lifetime，可能取消另一个有效的 pending open | 确认控制流缺陷；抽取复现；P1 |
| C02 | 原生页可见、实际可交互、控制权及动作完成尚未形成一致协议；选中页/后台页使用不同点击路径 | 已确认路径差异和真实回归失败；三次失败的共同根因**未证实**；P1 |
| C03 | 资源索引缺失会被当成资源未采集；回放索引原地重建且将索引写失败混入原件损坏报告 | 确认恢复语义缺口，属于 Q4 待补能力；P1 |
| C04 | 固定交接把全部 checkpoint 引用展开到 64 KiB manifest，超限要求缩小资料版本 | 确认长资料交接限制；体积实验；P2，Q6 前修复 |
| C05 | 分发白名单仍不包含 skill/reference；开发版交接成功不代表安装版可接续 | 确认尚未接入的 Q5 项，不称为已承诺通过的回归；P1 发布门槛 |
| C06 | 完整矩阵的前置失败反复阻断后段验证；Q3 自动客户端不是全新模型验收 | 确认验证覆盖/排程问题；保留完整矩阵并补独立入口 |

### C01：关闭旧回放不能取消新回放

**位置**：`src/main/services/replay-host.ts` 的 `open()`、`close()`、`closeActive()`。[S04]

当前逻辑：

```text
open: request = ++lifetime → await materials.replay → request != lifetime 则返回 closed
close(id): ++lifetime → closeActive(id) → require(id) 才检查目标
```

错误顺序：当前 B 存在；C 正在打开；A 的迟到关闭到达。虽然 `require(A)` 抛出“view no longer active”，它已经推进了 lifetime。随后 C 的合法打开被判成过期。**拒绝旧请求不应先对其他任务产生副作用。**

独立控制流实验：无效 A close 后，C open 返回 `closed`，B 仍是 active。脚本在 `review-evidence-046/repro-close-and-budget.cjs`。这不是声称已证明它就是本地三次可见性失败的唯一根因。

**实现路径**：

1. 把具体 replay 的关闭、pending open 的取消、全局 shutdown 分为有明确目标的操作。具体 ID 必须先验证再修改状态；不能让未知 ID 改动全局打开代际。
2. pending open 自身也要有可识别的操作身份。处理 open-A/open-B、旧组件卸载、失败打开后的 cleanup，不能仅把递增语句移动一行后就结束。
3. 对已销毁对象的重复关闭可以幂等；若保留 409，至少不得修改新对象或新 open 的有效性。
4. 资源协议、source model、原生 view、可见性释放都绑定同一个 owner。只有当前 owner 的关闭可恢复 live view。
5. 所有错误保留：不能通过 `.catch(()=>{})` 全部吞掉 close/selection 错误，只有明确的 stale/已关闭结果可以忽略。

**验证**：延迟 C 打开 + A 迟到 close；合法 close 当前 B 不应误取消明确归属于 C 的 pending open；真正的全局 shutdown 应取消所有 pending opens；重复关闭、快速切档、UI 卸载后迟到打开、源 renderer 崩溃。用 deferred 模块测试确定顺序，再经真实 ReplayHost/UI 测试验证原生可见性恢复。

### C02：不要把 getVisible 当成输入就绪证明

**位置**：`src/main/window.ts`、`Studio.action()/operation()/assertOperationOwner()`、`src/runner/puppeteer.ts`、`src/renderer/lib/browser-presentation.tsx`。[S05][S06][S07][S08]

现状：

- 选中页点击走 `getVisible()` 后 `page.click()`。
- 后台页点击临时加入 `backgroundOperations`，走 scroll/geometry/mouse；它与选中页不是同一条输入准备路径。
- window 显示由 active/replay/overlay/layout/needsBounds/browserVisible/locked 等状态共同决定；遮罩可见和目标已参与合成不是同一件事。
- 单个 CDP 命令有 30 秒 protocolTimeout，但动作包含连接、滚动、坐标和输入等多次 await，没有因此自动获得同一个端到端动作期限。[S07]
- Q3 专项的实际按钮计数通过；完整矩阵却三次分别停在可见性、回放关闭后恢复和 API click 等待。**不能据此一概增加超时，也不能认定全是测试抖动。**[S02]

**实现路径**：

1. 先读取三次本地日志的首个有效失败及前后有限事件，按 `UI epoch → presentation owner → native view → page/document/lease → protocol command` 关联。已有 `presentationStatus()` 继续使用，增加必要事件，不再建立另一套通用监控系统。
2. 将“请求显示状态”与“当前原生输入前置条件”明确区分。表示目标已隐藏、被 overlay 覆盖、布局未就绪或已换文档时，返回具体状态；不要切走用户前台、不关闭安全遮罩来换测试通过。
3. 建立一个窄的目标页输入准备/释放 helper，选中页和后台页共享身份、取消、几何和可见性前置条件。仍保留普通 Puppeteer，不创建第二套 Page DSL。
4. 在每个会让目标状态改变的异步边界核对 page/target/document/generation/lease 与 AbortSignal；取消或撤销时停止后续协议命令，并等待该连接清理。不要仅以 Promise.race 返回超时而让旧任务继续点击。
5. 为整条动作明确总期限和失败分类：排队、连接、页面准备、输入、清理。期限是实际语义，不只是放宽测试的 40 秒轮询窗口。
6. 点击命令返回不等于业务成功。生产接口区分命令完成与可选的业务后置条件；测试必须回读实际变化。不要求任意 click 都能被框架自动证明语义成功。
7. 旧矩阵测试的前置若违反现在的契约，允许据实际契约修夹具并保留负例；不能删除可见性、目标身份或实际点击效果断言。

**验证**：live→archive→live 后真实 click；选中页与后台页相同动作；overlay/拖拽/失焦/恢复；后台导航后旧 ElementHandle；坐标取得后文档变化；撤销与超时后无迟到输入；mask 不被临时放开。先跑单场景，再跑保留相同顺序的组合回归，最终完整矩阵必须通过。

### C03：原件完整不能被可重建索引的丢失掩盖

**位置**：`ResourceArchive.resolve/history`、`RecordingArchive.rebuild()`、`run-recovery.ts`。[S09][S10][S11]

确定的路径：

- `resource-url-index/<hash>.jsonl` 不存在时，resolve 返回 undefined，history 返回空数组。不能区分“从未观察过该资源”和“资源 manifest/blob/event 已存在但索引丢了”。
- `RecordingArchive.rebuild()` 在当前 replay-index 原地写入；一个 try/catch 同时包住原件解析、读取和索引写入。索引写入权限或磁盘错误会进入 corrupt 报告，和原始字节损坏混在一起。
- 当前可信恢复入口主要调用 EvidenceStore.open；不能把旧 evidence index 恢复通过当作新 replay/resource 全链恢复通过。

**实现路径**：

1. 清楚定义 authoritative 层：已确认原始事件、资源 manifest、blob/hash。replay-index/resource-url-index 是可重建投影，缺失不应被呈现为原件从未采集。
2. 原件损坏、索引缺失、索引读失败和重建写失败分开错误码/诊断。I/O 失败立即停止当前重建并保留原因，不继续把全部正常原件计成 corrupt。
3. 新索引在新目录/代际构建、完整校验后原子发布；不在用户正读取的 generation 里边拆边建。保留失败临时物及诊断，按当前平台选择可验证的原子切换方式。
4. 提供定向恢复路径：按 recordingId 重建 replay 与资源 URL 索引，校验 frame、请求版本、可用时间和引用关系；重建不得改源 eventSeq、资源可用时间或原件哈希。
5. 为索引建立可验证的清单/版本或完整性信息。查询不能发现缺索引就无限扫全仓；返回明确恢复状态，恢复按需且有预算。
6. 区分旧档只读投影和新格式恢复，不开发无限历史兼容层。

**验证**：同一合成存档删除 URL index、截断 positions.bin、污染单项索引、重建到一半强杀、模拟 ENOSPC/EACCES；重新发布后原件哈希不变，正确资源及精确位置恢复，坏项保持可见；重复恢复幂等，不能出现旧代际条目残留冒充成功。进行中的原件 writer 不应被恢复流程接管。

### C04：固定交接不应因为资料变长而要求缩小需求

**位置**：`src/main/services/fixed-task-handoff.ts`。[S12]

当前将所有 requirements/fields/checkpoints/recordingRefs 展开写入 manifest，超过 64 KiB 直接拒绝并提示 narrow material revision。按当前 checkpoint 投影构造 250 张仅含 ID/anchor 的卡片，漂亮打印后的 checkpoint 部分已是 **116,916 bytes**，尚未加其他 manifest 字段。这个实验只是按当前结构的体积计算，不是完整 export 函数运行。

**实现路径**：

1. 固定小 manifest 只放 revisionId/contentHash、计数、能力、读取入口、必要 bootstrap 与有界摘要。大集合通过既有固定版分页接口读，不要求用户删字段或 checkpoint。
2. 不把易过期的分页 cursor 当永远有效身份。固定对象身份与查询参数为主，必要游标用到时重新获取。
3. 区分可写资料原件和运行期连接/授权 envelope。新实例/新授权不能无声改写旧的固定任务事实；可以生成新的运行 envelope 或新交接目录。
4. 缺少 history-read 的纯资料授权不应自称“已具备全部证据开发能力”。说明可做范围和缺失能力，不自动扩大授权。
5. 保留 references-only；不为补任务语义把全部原始 DOM、Bearer 或敏感自由文本嵌入文件。Agent 用已授权 API 按需读用户需求说明，这是有效设计，不必撤销。
6. `PRIVATE_ID` 只按单词拒绝逻辑 ID 也需用合法字段/数据集名验证。名字里含 token/credential 不自动等于秘密值；修复应遵守统一分类规则，不通过关闭隐私检查来恢复导出。

**验证**：250/1000 checkpoint、较多字段的同一固定 revision 可导出并逐页读回；V1 不随 V2 变化；只读/完整授权能力清楚；撤销后拒读；导出不含秘密；新实例下明确过期/重新授权而非猜测另一个任务。

### C05：分发要交付技能与可复现业务产物，不只是可启动 exe

**位置**：`forge.config.ts` 的白名单仍主要是 .vite、node_modules、package/lock；Q3 handoff 也明确将发行资源放在 Q5。[S13][S02]

**实现路径**：

- 保留 Forge/Vite，不迁移打包器、不趁机升级全套依赖。
- 用明确的应用资源目录随包交付 skill/reference、必要模板和便携 helper。运行时按 app resource/模块地址发现，不依赖源码绝对路径或 CWD。
- 只打包所需静态文件，不把全部 docs、output、worktree、账号/profile 一起带进去。
- 开发包与发布包都走真实 worker、离线资源协议、交接导出。asar 内外和子进程资源定位专项检查。
- 独立脚本在仓库外新目录按自身 package/lock 安装，关闭 Studio 后运行；保留普通 Puppeteer 和原输出/部分失败语义。不能靠主仓 node_modules 或 Studio 正在后台服务来通过。
- 按既定 Windows 应用/ZIP 交付；没有额外 MSI、签名证书、自动更新平台任务。无签名如实注明，不为完成 Q5 引入额外商业依赖。

**验证**：最终候选 ZIP 解压到另一路径后运行、空白隔离数据根、离线存档读取、固定交接与 revoke、worker 生命周期、独立目录输出。记录构建 SHA、依赖/平台、产物路径/hash 和实际使用命令。

### C06：完整回归不能被拆掉，但排查不必每次从第一步重走

`test/desktop/scenarios.ts` 把多场景串在一个主过程，launch.js 又要求主过程通过后才 profile-restart 和后续矩阵。这个综合顺序有价值，也会让前段失败遮住后段状态。[S14][S15]

**实现路径**：

1. 保留原综合入口；增加或复用定向入口来运行失败的 native visibility/replay close/API click 场景，不重复完整前置来诊断一个问题。
2. 可独立合成前置的恢复/数据场景先验证；有真实顺序依赖的 profile-restart 仍保持同一合成 origin 与数据根，不假造前置状态。
3. 修复后既跑单场景，也跑引发失败的相邻组合；最终同一候选提交再跑一次完整保序矩阵。
4. Q4 30 分钟专项加入 format2 分段、随机 seek、资源索引恢复、原件跨 PID 重开、内存分进程、队列峰值与已确认数据完整性。旧长测通过不自动覆盖这些新维度。
5. 测试超时先收集本测试进程诊断再终止本进程树，不能批量杀掉全部 Node/Electron。重试必须附新增证据，不用一次偶然通过掩盖未定位的回归。

---

## 2. 并行编排：立即开发，依赖满足后验收

### 2.1 为什么这次是三条实施流，而不是三个管理员

墙钟瓶颈可近似理解为：

```text
旧方式：生命周期排查 + 恢复/长测开发 + 分发开发 + 各项串行验证
新方式：max(生命周期修复, 恢复/长测开发, 分发开发) + 必须保序/独占的集成验证
```

这不是速度或额度保证。正式 30 分钟负载、依赖安装、磁盘/桌面独占时间不会因多 Agent 自动消失。不能为了显示三流并行而派发重复 review 或拆出 Git/传话 Agent。

### 2.2 L/R/P 的文件所有权

先核对当前代码真实路径；下表是首选边界。发现必须交叉的变更时，提交具体接口提案，一次协调完成，不各造一套接口。

| Owner | 唯一可写的主要范围 | 不做什么 |
|---|---|---|
| L | `src/main/window.ts`、`src/main/services/replay-host.ts`、`studio.ts` 中页面/动作/lifecycle、`src/runner/puppeteer.ts`、必要 gate 修正、renderer 的 browser-presentation/replay-workspace、对应生命周期/UI/API 输入测试 | 不改交接导出、资源索引算法和打包配置 |
| R | `src/replay/archive.ts`、`src/resources/archive.ts`、定向 evidence/recovery 代码、`src/main/services/run-recovery.ts`、新恢复/长测夹具、`test/desktop/launch.js` | 不重写 native presentation、任务 UI 或 runner 普通业务 DSL |
| P | `fixed-task-handoff.ts`、相关 project-dispatch 导出分支、任务授权导出 UI、skill/reference、`forge.config.ts`、Vite/package/lock、便携 helper/独立样例与发布测试 | 不接管原生可见性/输入和恢复算法 |
| 主控 | 公共契约增量决定、`docs/refactor-status.md`、集成分支、最终交付总表 | 不逐文件重做实施者已做的排查，不常态接管 L/R/P 编码 |

跨文件依赖细则：

- `src/main/app.ts` 生命周期/测试 phase 接线由 L 唯一写；R 的 launcher/fixture 接线要求与 L 一次对齐。P 优先复用现有 `--executable` 路径，资源定位提出窄适配，不各自编辑同一 app 文件。
- `src/main/services/dispatch.ts` 若输入调用需要变更由 L 写；P 只改 `project-dispatch.ts` 内导出能力。新的共享字段由主控定一次契约增量，完成后立即通知受影响流。
- P 唯一修改 package/lock。其他流需要脚本入口时给出精确变更，批量合并，不反复触发安装。
- 每流只写 `docs/refactor-handoffs/SPEED-L.md`、`SPEED-R.md`、`SPEED-P.md`；主控在集成节点统一更新 progress/verification，不让三流同时写大历史文件。

### 2.3 新 worktree 与调用隔离

- 核实 main 的 HEAD/dirty、现有任务和相关测试进程；保留用户改动。以当前确认的 `046a52e` 或合法后续 main 为共同基线，写入记录。它是**有已知失败的开发基线**，不是已通过发布候选。
- 为本轮新建三个隔离 worktree，名字与旧 A–F 区分，如 `codex/finish-lifecycle-*`、`codex/finish-recovery-*`、`codex/finish-delivery-*`。优先使用主仓之外已确认可写的目录，避免嵌套工作树参与源码扫描。已存在本轮有效工作树时复用，不重置。
- 每树独立 node_modules、.vite/build/output、BES_DATA、profile/connection。依赖相同不意味着可硬链接可写 node_modules；npm 只读/受锁的下载缓存按现有工具支持使用，不创建共享可写依赖树。
- 不要求每次恢复都 npm ci；只有依赖未初始化或 lock 改变才安装。首次安装并行限两路，避免磁盘争抢。
- 使用原生子 Agent 独立上下文，不复制整段主历史。实际绑定 cwd/分支/基线，开工第一步确认。没有工具能力时，验证本地 `codex exec` 的受控替代方案，不伪造子任务已启动。
- 本轮明确授权创建、派发、接续和本地集成，不要求用户分别启动会话；没有额外授权时不自动推送、删除分支/worktree或修改全局模型配置。

### 2.4 桌面互斥不是主控独占

**桌面令牌一次给负责复现的实施者。** L 应自己运行定向桌面复现并修复，避免“L 写代码→主控跑失败→主控传日志→L 猜问题”往返。

- 采用一个所有树共同可见的绝对路径锁/既有令牌，记录 owner、worktree、PID/进程启动身份、候选 SHA、测试及日志。不能每个树各建一把同名锁后都认为独占。
- 使用已有机制或很小的进程包装，不建设通用调度服务。异常退出后核对真实进程身份，不因锁文件旧就盲目释放。
- 第一阶段 L 优先拿令牌做关键短复现；R/P 同时写恢复测试、打包/独立目录。L 暂无桌面需求时交 R/P；不要让空闲令牌被持有数十分钟。
- Node 领域测试可以并行，但同时最多一套全量测试；大安装、打包最多一项，与交互/性能测量避免重叠。普通编辑、阅读和模型推理不必停。
- 正式 30 分钟基准期间，记录安静负载条件；不同时运行 build/npm ci/另一套 Electron/大规模测试。其他 Agent 可以代码审查、写文档或在独立树完成低负载编辑。
- 测试所用提交与构建保持冻结。测试运行期间不能在同一树合并、重编 .vite 或更新 lock。其他树可以继续开发。

### 2.5 用阶段门，而不是全局等待

| 门 | 条件 | 下一步 |
|---|---|---|
| **G0 派发完成** | 三树/身份/owner/任务启动已确认；一份短状态表 | L/R/P 并行，不等全部资料重新阅读 |
| **G1 原生短链恢复** | L 的 stale-close、live/archive/live、后台/前台点击和取消专项有证据 | L 包集成；R 可做合成短负载；P 可跑包预检 |
| **G2 核心候选冻结** | L/R 核心已集成、相关回归通过；P 必需 runtime 改动已纳入 | 冻结候选，完整保序矩阵 + 独立恢复 + 长测；P 同时只做不改变候选的交付整理 |
| **G3 发布与新 Agent** | 同一候选的源码验证完成，ZIP/独立运行路径可用 | 发布包 smoke、独立业务目录、全新 Agent AT39；重大 runtime 修复回 G2 的受影响验收 |
| **G4 最终交付** | AT01–AT40 全部分类，所有可执行项完成 | 交付产物/命令/hash；真实账号等外部未测清楚列出 |

G1 不是所有测试通过的假标记。P 可以在 G0 起开发与试打包，早期包只能叫预检包；最后仍要对 G2/G3 指定候选构建并验证。R 的恢复场景同理：早期独立通过可缩小问题，但不能冒充最终全仓通过。

Q6 的接口/文档可用性预演可以早做；**最终 AT39 必须是新的独立模型上下文**，不是参与 P 实现的 Agent，也不是 Q3 的预写 API 客户端。给它真实导出、必要技能与已授权环境，不给实现历史、标准答案和 fixture 业务脚本。它在仓库外目录根据资料产出普通 Puppeteer 实现、解释一次失败并修复。身份、版本和测试证据落盘，目标输入仍是不可信数据，不作为提权指令。

---

## 3. 每流具体完成路径

### L：修复真实阻塞，而不是继续堆等待时间

1. 定向读 Q3 三份日志和本轮 C01/C02 源码；为三条失败分别建立假设/证据，不先假定同因。
2. 写 C01 deferred 回归及最小修复；补 native owner 与 UI epoch 诊断。
3. 在本树取得桌面令牌，复现 live/archive/live 与 API 点击；统一输入准备/取消，验证真实状态变化。
4. 将可验收的 lifecycle 包一次交付，含源码、定向测试、失败证据和必要测试入口；不为每个很小修复都让主控搬提交。
5. 首包通过后 Astra 工作结束。后续普通矩阵维护可由 Sol/high 接续这个工作包；若客户端无法原地更换模型，记录实际配置，不长期用 Astra 做调度。

### R：在 L 排查时把 Q4 准备好

1. 构造索引缺失/损坏/磁盘写失败的合成用例，修 C03 的分类和原子发布。
2. 复用旧恢复矩阵，增加 format2、资源引用、资料 revision、耐久批次联合恢复的切点；独立场景应有自己的合法前置。
3. 加入新架构长测计量：捕获/持久队列峰值、丢失区间、文件/字节增长、首/中/尾随机 seek、主/源页/replay/worker 内存与增长、跨 PID hash/结果核验。
4. 与 L 对齐一次 launcher/phase 接线；先做 1–3 分钟预检，不用 30 分钟测试排查一个初始化错误。
5. G2 后做正式 30 分钟测量；门槛沿用已冻结约定，缺失指标先在预检里测量和记录目标，不能看了正式失败后再改门槛。

### P：立即推进 Q5 和 Q6 准备

1. 修 C04，让大资料版本仍能固定交接；补 capability、隐私、重授权 envelope 和分页边界测试。
2. 接 skill/reference 到最小发布资源集，给出开发/asar/外置 worker 的实际定位方式。
3. 将独立样例移到新目录验证自身依赖，清理对开发路径的依赖；不改原始录制。
4. 编写发布包 smoke 与 AT39 操作说明，在空白客户端上预演发现过程，但不把预演当独立新 Agent 验收。
5. G2 候选到位后构建最终 ZIP；拿到桌面令牌运行包 smoke，完成后把槽位交给新 evaluator。发现 runtime 问题按 owning stream 退回，不由 P 顺手改所有模块。

### 主控：保留全局责任，但缩小上下文

主控初始只需：本节摘要、Q3 交接、当前 HEAD 和三流清单。根因细节、完整日志、代码全貌留在实施任务内。主控处理依赖/冲突/集成和验收归属，不能再逐条重复 L/R/P 的技术分析。

每流交付格式（目标 10–20 行，必要细节另文件）：

```text
stream / base / head / 待集成提交
完成的 C/AT 与用户可观察行为
实际文件范围、接口变化
测试命令、退出码、日志、未验证项
当前阻塞、需要的唯一决定、下一可独立工作
```

只在交付、真实阻塞、共享契约变化、测试令牌需求时通信。长命令使用等待/完成通知；不得高频模型轮询或持续发送“收到”。工具输出默认摘要；失败定向读有限片段。

只对未知高风险变更追加一次独立定向 review，审查绑定 base/head。返修只复核具体问题与受影响范围。不得以节省成本为由丢掉真实阻塞，也不得以“再保险”不断新开全仓 reviewer。

---

## 4. 调度与成本的可观测性

无需建设新系统。状态表增加少量实际字段即可：

```text
任务/model/effort/worktree/base/head
状态：implementing / ready-for-test / waiting-desktop / verifying / delivered / blocked
开始/交付时间
等待桌面或接口的累计时间（能取到才记）
实际测试与候选 SHA
本轮新增调用/输入/缓存/输出（工具能提供才记）
```

判断加速是否有效，不再只看 token 或 commit 数，而看：

- L 排查期间 R/P 是否真正提交了可验收产物，而非空等。
- 桌面令牌空闲时是否有等待测试的任务；有则调度，不开新的管理层。
- 每个包是否只发生一次主要交接；重复返修必须带新的具体证据。
- 同一源码/构建的重复完整测试是否由实际变更需要，而非“每次提交都跑”。

326 项测试是已有基线的记录，不是新最终数量目标；七天 31% 是账户滚动窗口，不是本轮费用。不要为测 token 再让模型阅读全部聊天历史。

---

## 5. 最终验收与停止条件

### 必须保留的验收

- 当前最终候选的 typecheck、build、全量单元与有关 renderer 测试。
- Q1/Q2/Q3 生产专项回归，包含真实网络 JSON/DOM 来源、离线资源、固定交接、授权撤销。
- 完整未跳 UI 的旧桌面保序矩阵，profile 跨进程、强杀/重复重开和退出路径。
- 新架构恢复专项与 30 分钟负载；顺播/随机 seek 一致、索引恢复、原件/版本/部分结果保持。
- Windows 应用/ZIP 的实际 smoke，独立目录脚本在 Studio 关闭后运行。
- 新模型 Agent 仅凭固定交接完成 AT39；不拿自动 API fixture 或之前的实施 Agent 当替身。
- AT01–AT40 明确已验证、未测或外部阻塞，以及对应 SHA/证据，不用一行“Q4–Q6 完成”替代。

### 人工与环境

在 Windows 本机按实际受支持环境运行，不为了测试转入 Docker；未经明确要求不触发 GitHub CI。合成站点可自动执行，真实账号、验证码、物理鼠标/多屏等确需用户时，最后提出最小请求。没有权限就保留真实未测项；不能用关闭 sandbox、放宽 origin、自动提权或读取其他 profile 换通过。

通过一个阶段门即自动推进，不因“已给出下一步提示词”停工。只有用户暂停、实际权限/登录/额度阻塞、重要不可逆决策或全部可执行工作完成时安全停止。不受影响的工作继续。上下文即将不足时落盘接续，主控恢复先查现有任务，避免重复启动。

---

## 6. 派发消息模板（由主控实际发送，不要求用户手工开三个会话）

### 给 L

```text
执行本轮 L：先读 AGENTS.md、06-review-and-parallel-finish.md 的 C01/C02 与 L 所有权、Q3 handoff；其余按需。确认本 worktree/base。修复 stale close 污染新 open，定位三条 native visibility/replay-close/API-click 回归并统一目标输入的准备、身份、期限与取消。你持桌面令牌时直接运行本树的定向真实测试，不经主控逐次转述日志。不要改索引算法、导出或打包，不放宽锁/CSP/断言，不递归派发。交付可集成提交与短证据摘要；三次失败未证明同因前分别跟踪。
```

### 给 R

```text
执行本轮 R：先读 AGENTS.md、06 中 C03/C06 和 R 所有权、Q3 handoff。并行完成资源/回放索引的缺失识别、I/O与原件损坏分类、原子重建及恢复用例，准备新格式30分钟负载与指标。不要等L完整矩阵通过才开始编码。你唯一维护测试launcher；与L一次对齐app phase接口。未经桌面令牌不启Electron，正式长测在冻结候选和安静负载下运行。保留原件/失败输出，不全仓扫日志，不递归派发。按完整修复包交付。
```

### 给 P

```text
执行本轮 P：先读 AGENTS.md、06 中 C04/C05 与 P 所有权、Q3 handoff。修大资料固定交接，完成skill/reference的包资源定位、Windows ZIP和独立业务目录实现，并准备新Agent接续资料。现在就做，不等Q4长测结束。只改自己的导出/发布/便携代码与测试，不改原生输入和索引。早期包是预检，最终需从冻结候选重建/验证。真实桌面测试申请令牌；不使用真实账号、不自动推送或删树、不递归派发。交付提交、命令、产物/证据和AT39剩余接点。
```

---

## 7. 核对来源

来源为本轮读取到的固定源码与仓库记录。引用仓库中的测试结果仅代表记录，不代表本次已复跑。下面的链接供定向复核，不要求一次全部打开。

- [S01] 远端分支与改动范围：[branches](https://api.github.com/repos/ghostroller/browser-evidence-studio/branches?per_page=100)；[5444ea5...046a52e](https://github.com/ghostroller/browser-evidence-studio/compare/5444ea504f5d7cc6b285022890fba0369248e5d0...046a52e7432fdcebb9524b661ebf4166b80acba1)
- [S02] [Q3 handoff](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/docs/refactor-handoffs/Q3-20260926.md)
- [S03] [Q2 handoff](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/docs/refactor-handoffs/Q2-20260926.md)
- [S04] [replay-host.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/services/replay-host.ts)
- [S05] [window.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/window.ts)
- [S06] [studio.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/services/studio.ts)
- [S07] [puppeteer.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/runner/puppeteer.ts)；[gate.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/runner/gate.ts)
- [S08] [browser-presentation.tsx](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/renderer/lib/browser-presentation.tsx)
- [S09] [resources/archive.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/resources/archive.ts)
- [S10] [replay/archive.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/replay/archive.ts)
- [S11] [run-recovery.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/services/run-recovery.ts)
- [S12] [fixed-task-handoff.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/services/fixed-task-handoff.ts)；[project-dispatch.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/src/main/services/project-dispatch.ts)
- [S13] [forge.config.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/forge.config.ts)
- [S14] [scenarios.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/test/desktop/scenarios.ts)；[api-scenarios.ts](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/test/desktop/api-scenarios.ts)
- [S15] [launch.js](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/test/desktop/launch.js)
- [S16] [AGENTS.md](https://github.com/ghostroller/browser-evidence-studio/blob/046a52e7432fdcebb9524b661ebf4166b80acba1/AGENTS.md)
- [O1] OpenAI 官方 [Subagents](https://developers.openai.com/codex/subagents)：独立子任务、实际模型/强度配置、并发与额外用量。文档当前跳转至 ChatGPT Learn。
- [O2] OpenAI 官方 [Worktrees](https://developers.openai.com/codex/app/worktrees)：文件隔离不等于桌面/端口/测试数据自动隔离。

模型分工和三流数量是本项目的工程建议，不是官方对本仓的性能测试，也不是保证 token 不增加。这里用更充分的独立实施并行交换速度，严格避免管理层递归和重复 review。
