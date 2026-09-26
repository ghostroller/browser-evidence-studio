# Browser Evidence Studio：237d778 阶段审查与发布验收修正

日期：2026-09-27。性质：针对当前实现的修改意见与验收要求，不是已经实施的报告。

## 0. 执行摘要：初始只读本节，随后按负责项展开

**保留 06 的 L/R/P 工作树和协作边界，不重排 A–G、不重做 Q1–Q3、不重新建立调度系统。** 当前应当减少测试夹具返工、补齐恢复的可信性与验收判定，然后完成发布，而不是继续扩展产品范围。

本次锁定的远端：

| 分支 | SHA |
| --- | --- |
| main | `237d778bebf99dce74f3f4929eb320f17e10c7ff` |
| finish-lifecycle | `ba2690ed7ad1699647b3719986d3815683f59cac` |
| finish-recovery | `bb33f561d52b07cd5d99c5ffafc72214182348e9` |
| finish-delivery | `70a51e7ea7f78554fcd229d2efa842feb8a72b60` |

这些是审查参考点，不是 reset 目标。接续前核对实际新增提交、活动任务和测试进程；不要因收到本文中止仍有价值的在跑任务，不重复集成旧分支的等价补丁。

**已取得成果：** L 的原生输入/生命周期修复和完整桌面矩阵、P 的大资料交接和早期 ZIP/仓库外独立运行，都有具体交接记录。R 有新索引恢复实现和短恢复实测，但记录中的正式长测被测量器问题中断。尚未从已提交记录中确认“最终集成候选的完整 30 分钟、同一候选 ZIP 和真正 AT39”全部闭环。[S1][S2][S3]

| 编号 | 问题 | 证据等级 | 优先级 / 负责人建议 |
| --- | --- | --- | --- |
| D01 | 首次重建失败留下 staging 目录，会让原本可读的 legacy 索引也被拒读 | 源码确认分支；独立控制流实验复现，非项目端到端 | P1 / R |
| D02 | URL 索引重建跳过坏版本，使“已观察但损坏”从版本历史中消失 | 源码确认；回落旧版的具体展示需生产测试 | P1 / R |
| D03 | 原始录制重建直接给当前字节生成新 hash，未见对既有封存账本的先行核验 | 可信性边界缺口；需有效 JSON 改写负例验证 | P1 / R，定向只读复核 |
| D04 | 长测回放环节不检查 open/seek 的失败状态，进程活着即可继续采内存 | 确认验收假阳性路径，非宣称已发生一次假通过 | P1 发布门 / R 或移交后的测试负责人 |
| D05 | AT39 live 收到 completed 信号就写 passed，未独立关联 Agent 产物及业务结论 | 确认验收口径缺口；目前未指控已伪报 AT39 | P1 发布门 / P |

**本批完成条件：** D01–D03 的定向负例与修复 → D04/D05 的验收器可识别真正失败 → 短时完整流水线预检 → 合格候选的正式长测、分发和新 Agent 接续 → 按实际证据完成 AT 覆盖。完成后的旧成果不重复重写。

**审查边界：** 本次通过 GitHub 读取当前源码、分支与交接记录。没有在用户 Windows/Electron 环境重跑项目测试，没有访问忽略的本地 output 日志全文。本文对测试通过的描述来自仓库交接；独立实验只验证明确标注的局部控制流。它不是穷尽审计，也不承诺不存在其他问题。

---

## 1. 进度与近五小时速度的判断

### 1.1 按可交付结果看，不能说在空转

L 已处理具体 pending-open 身份、原生输入共同路径、命令 guard、超时，以及最小化窗口仍声称 visible 的问题。其交接记载 11 个原生案例、未跳 UI 的完整矩阵、系统/交接专项通过；最后一处窄修改与主树集成仍需对应回归，不能把子树成绩自动赋给 main。[S1]

P 已完成 counts/分页入口型 manifest、独立 access envelope、asar 外 skill/reference/helper、仓库外自有 lock 的示例运行；还产生并解压验证了早期 ZIP。它明确标注这些属于早期候选，不是最终集成 SHA 的发布证明。这是实质交付进展。[S3]

R 的原子代际恢复与故障诊断也是实质实现；但整条长测的首轮成功率偏低，已经成为剩余关键路径。[S2]

### 1.2 可见的主要损耗是夹具与测量，而非单纯模型写代码慢

R 交接记录了多次独立问题：任意选第一个 CSS/stream，未使用现行任务授权，首次失败缺少错误详情，把 prebaseline 事件当可回放位置，递归 stat 碰到已 rename 的 staging 文件，以及在 1 Hz 负载关键路径执行全目录扫描。[S2]

这些不能全部归为产品核心难题。尤其最后两项是测量器自身改变/破坏了被测流程。将扫描移到 cadence 外是正确方向，应保留；不能为追求零 skipped slot 抹去原始失败或降低负载。

结论：**实现产出有效，最终验收推进偏慢。下一步主要优化一次验收能走到终点的概率，而不是继续增加常驻 Agent 数量。** 没有每任务调用/等待/工具耗时轨迹，不能量化“浪费了多少小时/百分比”，也不能据此判定 Sol 比另一个模型慢多少。

### 1.3 Sol Ultra 的配置建议

以用户提供的“当前主控 6 Sol Ultra、子任务基本 Sol”为当前口径。仓库 G0 初始记录仍是 L=Astra/high，R/P=Sol/high；它只能说明最初启动配置，不能推断之后未切换。[S4]

官方说明 Ultra 结合最大推理与自动委派；其他强度也能显式使用子 Agent。较高推理强度通常增加响应时间与 token，用量与墙钟收益取决于任务。本文不把 Ultra 当成更快生成模式。[O1][O2]

建议在适当边界使用：主控 Sol/high（主要机械调度时 medium），实现者 Sol/high；复杂索引可信性问题可临时使用独立 Sol/xhigh 或 Astra/high 定向复核。**不强制重启会话，不为了降强度重复加载全部历史，不把所有子任务一律升级 Ultra。** 模型与 effort 按客户端实际支持配置，不把提示词中的名称当成已经生效。

---

## 2. D01：失败 staging 不应改变可见的已验证索引

### 2.1 意图

索引是派生数据。一次尚未公布的重建失败，不能使之前仍可读取的索引丧失可用性；另一方面，已经公布过的 pointer 真正丢失，也不能被静默回退掩盖。

### 2.2 当前路径

`src/replay/archive.ts#indexPrefix()`：当前 pointer 不存在时，只要发现 `replay-index-generations` 目录，就报 `REPLAY_INDEX_MISSING`，不再使用 legacy `replay-index`。[S5]

同文件 `rebuild()` 在读取和验证原件、写入新索引、发布 pointer **之前** 创建 `replay-index-generations/<uuid>`；失败目录会保留。[S6]

因此，首次重建若失败：旧 legacy 文件没变化，pointer 尚未创建，但父 generations 目录已经存在，下一次读取却失败。`ResourceArchive.urlEntries()` 对资源 generations 也有相同的发现规则，需一起覆盖。[S7][S8]

### 2.3 本次局部实验

`review-evidence-237/repro-first-rebuild.mjs` 按读路径的目录/pointer 决策建立临时目录：

```text
首次读取：replay-index
增加未发布 staging 目录后：REPLAY_INDEX_MISSING
原 legacy 目录：仍存在
```

实验环境 Node v22.16.0，仅执行独立控制流 probe，没有调用项目类，也不代表项目要求环境或 Windows 整体验证。结果见同目录 `result.json`。

### 2.4 修改路径

1. 明确区分 staged、published、previous-reader-generation。目录存在本身不能证明某代已发布。
2. 可先固定一个可验证的旧 reader 基线，再开始新代重建；或建立足以区分“从未发布”和“已发布但丢 pointer”的发布记录。选择最小实现，不建设多层迁移框架。
3. 失败新代不改变原 reader；保留失败文件和诊断。不能通过删除失败 staging 来隐藏这个问题。
4. 所有需要多个索引文件的读取固定一次已验证代际；不在一次读取中混合前后 pointer。
5. 不允许简单写成“pointer 不存在就总回退 legacy”，这会掩盖真实的已发布索引丢失。

### 2.5 必须证明

- 健康 legacy → 首次 staging 写失败/读失败/强杀 → 原 reader 仍可读。
- 已有 G1 → G2 失败 → G1 仍可读，新失败留痕。
- 已有已发布代际的 pointer 真正丢失 → 明确恢复状态，不自动冒认 legacy 最新。
- replay 与 resource 两种索引都通过，而不是只修一个。

---

## 3. D02：坏资源版本必须保留在历史关系里

### 3.1 意图

“未观察到”“观察到但读取失败”“观察到的新版字节损坏”是不同事实。不能因为重建只收录好数据，就让坏的新版消失，使旧版或无记录状态冒充历史事实。

### 3.2 当前路径

`src/resources/archive.ts#rebuildUrlIndex()` 对已确认 event 对应的坏 manifest、hash 不符或部分其他错误，增加 `corruptCount` 后直接 `continue`；只有好 reference 进入 `byUrl`。发布 manifest 保存总损坏数量，但不保存这些损坏项的逐 URL/version 位置。[S8]

读取 `urlEntries()` 在新 manifest 没有该 URL hash 时直接返回空。一个 URL 仅有坏版本时，会变成未列入历史；存在好 V1 和坏 V2 时，历史可能只剩 V1。具体回放是否错误回落取决于资源绑定条件，不能断言所有页面都会回落，但缺失这条事实本身已能从源码确认。[S7][S9]

### 3.3 修改路径

- 根据仍可信的原始 resource-reference 事件，保留不可用版本的 tombstone/diagnostic 引用，至少有原 ID、URL hash、frame/stream、可用的请求/时间身份、错误类别。
- metadata 本身不可信或缺失的字段不得补造。未确认的孤立 manifest 与已确认但坏掉的版本分开。
- lookup 能区分 observed-unavailable 与 unobserved；选择器不得跨过已确认的损坏新版而默默选旧版。
- 良好独立资源继续可读；不是任何一个坏资源都封锁整段存档。
- 复用原隐私策略，不因 tombstone 新增明文凭据/敏感 URL。

### 3.4 必须证明

同 URL V1 正常、V2 字节 hash 错误，重建后目标 V2 状态仍明确损坏；不得显示 V1 为已验证新版。仅有坏版本的 URL 仍可定位其损坏事实。无关好 URL 仍可读取。原件及封存哈希账本不被修订成“好”。

---

## 4. D03：新索引 hash 不能取代原件原有的可信依据

### 4.1 意图

重建索引可以重新计算 hash 来定位字节，但不能用这个新 hash 证明这些字节仍然是封存时的原件。语法正确并不等于历史真实。

### 4.2 当前路径与风险范围

`RecordingArchive.rebuild()` 从当前 raw 文件读取有效 JSON，为它计算新 receipt hash 并发布。当前 `recoverRunIndexes()` 的已检查调用链验证目标和 writer 状态后直接启动重建，未见先按既有 `integrity.json` 核对受影响 raw 原件的步骤。[S6][S10]

因此需要优先验证这个负例：**保留封存账本不变，将一条 raw 中的文本或属性改成另一个合法 JSON 值，然后重建索引。** 不能让“新 receipt 与当前文件一致”使它重新得到可靠历史身份。当前历史材料入口对项目/recording manifest 的检查，也不能替代封存内容核验。[S11]

这是源码可见的可信性边界缺口；本次未运行该项目负例。它不是声称项目具有抵抗能重写全部原件和全部账本的恶意本机管理员的能力，不要求引入签名服务器或远程信任基础设施。

### 4.3 修改路径

1. 将“仅索引坏了”和“原件已变化”分开。对 sealed run，在新 receipt 建立前复用原有封存账本，流式核对本次重建依赖的原件。
2. 有可信原 hash 且不符：保留损坏材料与诊断，不把新字节发布成同等可靠原件。未受影响部分可按原设计降级读取。
3. 没有可信封存基线的 interrupted/旧资料：可以有限重建，但必须标记验证依据不足；不能仅因 JSON 和节点关系合法就恢复为 fully reliable。
4. resource manifest 与原始 reference event 的核对要覆盖参与版本选择和身份判定的字段，不仅比较一个新算出的 blob hash。D02 的坏版本也必须保留。
5. 防止重建期间源身份或 writer 状态变化。利用现有恢复/所有权机制给单 run 的维护操作一个明确边界，不修改全局权限。

### 4.4 必须证明

- 原件不变、索引删除：恢复成功，历史身份保持。
- valid JSON 的源值改写而原 seal 不变：报告 integrity mismatch，不重新认证。
- 原件尾部真正损坏、读取被拒、索引磁盘写失败分别报告。
- 旧无 seal 的资料仅得到明确降级状态；不从当前网站或回放 DOM 补造。

---

## 5. D04：长测必须检验真实回放，而不仅是进程内存可读

### 5.1 当前路径

`test/desktop/refactor-recovery.ts#replayMemory()` 等待 `ReplayHost.open()` 和每次 `seek()`，但未检查返回 `status`、资源、位置；只要存在新的 WebContents/PID，便继续记录内存。最后主要断言内存值非 null。[S12]

生产 `ReplayHost.render()` 遇到失败会返回 `status:'failed'`，不是一律抛异常。因此 `await seek()` 没抛错不能证明成功。当前夹具存在“回放已失败但进程仍在，内存采样通过”的通路。[S13]

前面的 `RecordingArchive.window()` 校验原件和索引有价值，但不能替代实际 renderer 的视觉/DOM 还原。本文不否定负载循环的其他指标，也不指控已发生一次虚假的完整 30 分钟通过。

### 5.2 修改路径

每次 open/seek 都记录并检查：

- 返回 ready；position 与请求完整身份相同，回执代际正确；无 failed/closed 被忽略。
- 正例的源结构可靠；资源状态符合该夹具的已声明预期。缺资源负例应明确 partial，而非无条件要求所有场景 ready。
- 在实际回放文档回读少量确定的 fixture 文本、关键样式和目标节点 ID，和该历史位置的保存信息对照，不与实时页面当前值对照。
- 从请求发起到实际呈现完成测 seek 延迟，分别保存 bytes/events、renderer PID/private memory；PID 归属于对应回放视图，不仅是任意新增 WebContents。
- 主进程、源页、回放进程各自报告实际覆盖。固定录制长测不启动 runner 时，不能宣称已测执行 worker 内存。[S2]

### 5.3 预检应走完“整条短流水线”

短预检不只跑 60 个负载循环，还必须完成：seal → 首/中/尾及随机位置 → 索引故障/恢复 → 实际回放 → 新 PID 回读 → 最终报告。对 post-load 逻辑可先使用已有合法合成存档，避免每改一个断言都重新录一遍；这只复用结构验证材料，不把短录制冒充正式时长。

增加 host 返回 failed 的负例，确保夹具失败。新增长测测量器的单元测试先检验 UUID staging rename 和路径丢失行为；已经移出 cadence 的全目录扫描不要放回 1 Hz 关键路径。短流水线证明有效后，才启动安静负载的正式 30 分钟。

---

## 6. D05：AT39 completion 是协调信号，不是交付验收

### 6.1 当前路径

`test/desktop/refactor-handoff.ts#runLiveHandoffScenario()` 提供空白业务目录和固定交接，这是正确起点。但收到匹配 nonce 的 `{status:'completed'}` 后，就退出等待并设置 `report.passed=true`；这段路径不读取 Agent 产物或特定 execution/report 来确认业务交付。[S14]

P 文档已经写明“信号仅表示流程结束”，说明设计意图是谨慎的；最终报告结构也应体现该区别。不能让通用 launcher 的 passed 被当作 AT39 完成。当前仓库记录未宣称最终 AT39 已通过，本项是预防错误结案。[S3]

### 6.2 修改路径

至少分开：

```text
harnessCompleted：已建立授权环境，收到了匹配的结束信号
agentDelivered：新 Agent 确实产生了约定产物与实施记录
businessVerified：针对固定资料的执行/判定与任务要求相符
```

沿用现有执行和报告协议，不另写通用裁判系统：主控/验收器从真实宿主读取 exact executionId、reportId、资料 revision/hash、代码和输入指纹、数据/分页及既定来源约束，确认它们属于本次任务。信号可携带引用 ID，但不能把 Agent 自报 pass 当验证。

需要一次失败解释与修复时，保留真实失败/修复记录；不要为凑流程编造失败。资料 V1 不因为 Agent 修改为更简单的 V2 就自动视为已满足。独立运行属于另一个验收分项，使用实际交付项目、自身 lock 和合成环境验证。

缺产物、缺有效执行/判定或仅完成连接 smoke：结果必须是 incomplete/unverified 或失败，不是 AT39 passed。没有可全自动判断的部分可以明确列出人工/独立复核，而不是设一个“收到 done 即通过”的捷径。

### 6.3 必须证明

- 仅写合法 completed/nonce，但没有产物：不能通过 AT39。
- 有产物但执行关联错 revision/代码或仅报告试跑 not-run：不能冒认来源验收通过。
- 真实全新上下文仅凭固定交接和安装 skill 完成约定任务；不得注入仓库 fixture 源码、标准答案或上一 Agent 的解题历史。
- 发布候选/ZIP 与这次测试相同，业务正确性证据和 harness 完成状态分别报告。

---

## 7. 调度：不推倒现有并行方式，只修正关键路径

### 7.1 就当前剩余范围安排

- **R 保持唯一生产恢复/索引写入 owner**：D01–D03 与对应窄测试。D04 可由 R 一起处理，或明确转交独立测试负责人；转交后同一文件不并写。
- **P 同时处理 D05 和发布/新 Agent 验收准备**。不必等待 R 改代码完成后才写验收器、检查包路径。
- **L 不重新展开生命周期功能**：仅提供 D01–D03 的限范围只读复核或响应实际回归；完成的模块不再长期占据一条管理流。
- 主控只协调上述冲突和候选，不重新审全仓；安全/可信性 review 一份结论交 R 修改，修后只复核问题及影响范围。

有两项真实独立工作时保留两个并行实施槽；没有第三项独立工作，不为填槽而制造任务。原生桌面仍独占；长测安静负载规则不变。

### 7.2 验收成本控制

**不是每个小提交都跑完整矩阵。** 实现小包先跑负例与局部回归，整合点运行受影响的生产集成；候选稳定后执行正式长测和最终分发测试。

失败发生在 fixture/测量器时，先在现有录制或最小夹具复现再重跑。已有真实失败和日志保持；只修错误前置、诊断与计量，不删除原有安全、完整性或性能门槛。

测试使用冻结源码与构建，不在同一工作树边跑长测边 cherry-pick/重编。纯文档或报告格式变化的测试适用性单独说明；影响生产行为的修改则按实际影响重新验证。不要把“全都重跑”或“全部旧成绩照搬”任一极端当作规则。

如果正在执行有效长测/AT39，先核对任务与输入 SHA：能继续产生有效证据的任务让其完成；已能证明违反本轮关键验收条件的任务由原负责人在安全边界处理。不得不看现场强杀所有 Electron/Codex。

### 7.3 单一发布证据入口

更新已有 `docs/refactor-status.md` 的开头即可。当前其 headline 和 `docs/verification.md` 仍停在 Q3，但 SPEED handoff 已有新进展。[S15]

顶层只保留一张当前表：实现 SHA、测试 SHA/工作区 dirty 情况、关键命令/结果/日志、ZIP 来源/hash、AT39 分项、剩余阻塞。旧记录保留为历史；不再另建大量同义状态文件或把同一日志转述三遍。

**正式结案需要的是同一明确候选的可追溯证据，而不是更多 submitted/completed 消息。** 本文不根据滚动额度百分比估计当前批次 token 或费用。

---

## 8. 完成报告与适用边界

最终应准确给出：

1. D01–D05 各自：修复 / 原实现已满足且有回归证明 / 仍阻塞。
2. 已验证候选 SHA、生产/测试代码差异，正式 30 分钟及其 post-load/new-PID 流程结果。
3. 分发 ZIP/hash、实际解压路径下的资源检查、关闭 Studio 后的独立脚本结果。
4. AT39 的新 Agent 身份、固定资料与代码/输入指纹、harness 与业务验收分项。
5. 真人账户、物理多屏/DPI 等不可在本地自动完成的场景，标未测/待人类配合，不扩大宣称。

不修改现有原始录制，不联网补历史，不降低 CSP/sandbox/授权，不自动改全局配置。提交按工作包；是否推送遵守当前用户授权，不把过去一次 `push --all` 自动当永久写授权。

---

## 9. 审查来源（按固定 SHA，可定向打开）

所有源码链接均为本次固定基线；阅读时按当前负责项取必要片段，不把全部文件加载到每个子 Agent。

- [S1] L 当前 handoff：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/refactor-handoffs/SPEED-L.md
- [S2] R 当前 handoff（夹具/长测失败与改动记录）：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/refactor-handoffs/SPEED-R.md
- [S3] P 当前 handoff（早期包与独立运行，AT39 边界）：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/refactor-handoffs/SPEED-P.md
- [S4] G0 初始实际配置：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/refactor-handoffs/SPEED-G0-20260926.md
- [S5] indexPrefix / savedIndexFile：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/replay/archive.ts#L35-L61
- [S6] RecordingArchive.rebuild：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/replay/archive.ts#L237
- [S7] ResourceArchive.urlEntries：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/resources/archive.ts
- [S8] ResourceArchive.rebuildUrlIndex：同 S7，重建循环、corruptCount、byUrl 和发布段。
- [S9] 回放资源的版本选择：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/resources/replay-resources.ts
- [S10] recoverRunIndexes：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/main/services/run-recovery.ts
- [S11] 历史资料入口：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/main/services/project-materials.ts
- [S12] replayMemory 与长测后半段：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/test/desktop/refactor-recovery.ts
- [S13] ReplayHost.render 的返回型失败与状态：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/src/main/services/replay-host.ts
- [S14] runLiveHandoffScenario：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/test/desktop/refactor-handoff.ts
- [S15] 全局状态 / 验证：
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/refactor-status.md
  https://github.com/ghostroller/browser-evidence-studio/blob/237d778bebf99dce74f3f4929eb320f17e10c7ff/docs/verification.md
- [O1] OpenAI 官方子 Agent 与模型/effort 文档（2026-09-27 核对，网页可能变化）：
  https://developers.openai.com/codex/subagents
- [O2] OpenAI 官方模型与 Ultra 描述：
  https://developers.openai.com/codex/models
