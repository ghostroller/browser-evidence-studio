# Browser Evidence Studio：源码 Review 与低协调成本接续修正

日期：2026-09-26。性质：接续修改意见，不是已实施报告。

## 0. 执行摘要（主控初始只读本节，再按任务读对应 R 项）

本次不是重做 S0 或重新展开 A–G。保留已有代码、工作树、原始录制、成功/失败日志；先把待合成果和明确缺陷收敛成真实用户闭环。

**已核对远端基线：** main=`f55e015127bc4e7c507fc225193c9ed4804cade5`；A=`550f30aab9721eb9136f6358e1b7836b9edd1190`；D=`7b772bff542cd4e960b344487876b9e150265099`；E=`c829777f794e57b703d02b3347c654e3afd7ce12`。B/C/F 已有集成成果，不重新派发完整工作包。A 的 CSSOM 夹具已提交，不能仍按 dirty 现场处理；E 待合功能包是 `83aa396`，不能把其共享依赖重复 cherry-pick。[S01][S02][S13][S15]

**本轮实际审查范围：** 历史源模型、生产回放宿主、D 最新播放器/资料编辑器、任务授权与 HTTP/dispatch、E 待合耐久结果目录，以及有关测试和暂停记录。不是穷尽全仓审计。未运行项目的完整测试或 Windows/Electron；对 SourceModel 的关键逻辑做了独立 Node 最小执行复现，其余为源码路径分析。仓库记录的 246 项测试是 D/E 接入前的结果，不当作当前 HEAD 全量通过。[S02]

| 编号 | 本轮结论 | 分类与优先级 |
|---|---|---|
| R1 | 同批 remove/add 移动节点会删除该批已提供的源元数据 | 确认逻辑缺陷；最小抽取复现；P1 |
| R2 | 播放对每个事件调用完整 seek，销毁并重建 Replayer | 确认实现偏离连续播放；P1 |
| R3 | 生产宿主仍按 top 解析资源，与 frame-aware 验证路径不同；缺失资源有静默替换 | 确认接入/完整性缺陷；P1 |
| R4 | 注释与字段共用选择结果；进入选择未建立目标会话/强制暂停并定位卡片 | 确认状态与归属缺陷；P1 |
| R5 | HTTP state/发现/job 路径尚未统一任务范围与撤销检查 | 确认授权闭合不足；不是未鉴权互联网漏洞；P1 |
| R6 | 旧“一次启动授权”仍由 UI/capabilities 提供，但 HTTP 执行明确拒绝该模式 | 确认公开契约自相矛盾；P2 |
| R7 | 需求 ID 仍手填；注释只增不改；固定版本仅列标识，资料整理闭环未完成 | 原需求未收敛，不是新增产品范围；P2 |
| R8 | E 的 dataset catalog 对单个损坏/未初始化数据集整体抛错，隐藏其他已提交结果 | 待合包的错误隔离缺口；P1 |

**执行方式：** 默认一个 Sol/high 实施者兼任轻量集成负责人；确需并行时才有 Sol/medium 主控，最多一个额外实施流。Git 与传话不各建一个 Agent。Astra/high 仅用于明确范围的源身份/回放/权限疑难审查，不长期承担 Git、轮询和记录。不要因一个高风险问题把整个长会话升级到 xhigh。

**完成边界：** 修复本表中影响当前闭环的问题 → 经真实生产 ReplayHost/React UI 完成离线回放、暂停/定位、checkpoint 注释增改、字段绑定、固定版本和任务授权/结果查看 → 当前整合代码的相关测试与一次完整单元/类型检查 → 保存本批结果并暂停复盘。完整安装包、新架构长测、新 Agent 独立交付等仍保留后续验收，不在本批无边界展开。

---

## 1. Git 和沟通：先减少事务，再按需降低模型

### 1.1 意图

Git 记录、测试证据和关键审查必须保留，但它们不应让一个带有全项目历史的 Astra 为每条状态变化重新推理。费用高不等于所有 review 都无价值；应去掉重复分析和无实质变化的沟通，保留能改变判断的检查。

已有暂停记录包含多次 root↔子流的等价提交映射，说明当前跨流同步确实存在较高的跟踪复杂度；本文件不从这些记录推算各类操作实际消耗了多少 token。[S02]

### 1.2 最小工作结构

- **默认：一个实施/集成会话，Sol/high。** 直接改代码、批量执行 Git、测试和保存进度，不额外常驻一个“管理者”。在等待长测试时使用工具等待，不不断向模型询问状态。
- **确有独立任务时：** Sol/medium 负责调度，实施流最多两个；每流不再派发可写下级任务。高风险专项可用一个限范围 reviewer，不与主控重复进行完整技术审查。
- **Luna/high：** 仅在确有足够批量、独立上下文价值时做只读变更摘要、日志分类、文档一致性检查。一次 `git status` 或转发几行消息不值得新建 Agent。
- **Astra/high：** 源节点时序、回放正确性、权限/取消、耐久语义等具体困难。提供 base/head、相关文件和待回答问题；不是“全仓再看一遍”。xhigh 仅在已有具体证据显示需要进一步推导时使用。

模型/effort 必须通过实际支持的工具配置生效。官方当前推荐 Sol 作为常规 Codex 起点，Luna 用于聚焦、重复任务；子 Agent 默认继承配置，高 effort 和额外子任务会增加用量。这些是官方能力/成本边界，以上分工是本项目的工程建议，不是性能保证。[S17][S18]

### 1.3 Git 批次协议

1. **开始一次核对。** 检查主树与本批涉及树的分支、HEAD、dirty、活动任务；保存短摘要。之后只有相关 HEAD/工作区/任务发生变化才重查，不每次沟通扫描全部旧分支。
2. **一次交付一个可验收包。** 允许实施者在自己分支做必要的逻辑提交；主控不逐个小提交重审、搬运、回复。交付时提供准确 base/head、仅本包提交清单和测试证据。
3. **先收拢旧队列。** 对 A/D/E 待合内容检查等价补丁/祖先关系和依赖；只合未集成的实质变更。不整体盲目 merge 长期落后的旧流，也不反向同步每个无关 root 小提交。
4. **本批收敛后单向流动。** 使用最新已验证集成点继续任务，减少双向 cherry-pick。共享契约修改集中一次审批/集成，相关适配跟随同一批。不能为减少 Git 操作而取消工作区隔离。
5. **普通 Git 由工具执行。** 在既有合法权限内批量查询、提交明确文件、集成审查过的准确提交。可做小型 Node/PowerShell 批处理，但不建设调度平台、不自动 push/force/reset/clean/delete。
6. **冲突不是机械任务。** 有语义冲突时看受影响契约和代码，必要时交原模块实施者；禁止自动 `ours/theirs` 或只求编译通过。不对同一个可写目录并发执行 Git 写命令。
7. **测试分层。** 包内跑针对性回归，批次整合点跑一次相关集成/全量检查；不是每个文档小提交重跑全矩阵。出现底层行为变化或真实失败则按影响扩大，不为省成本跳过必要验收。

### 1.4 沟通协议

仅在 **交付、真实阻塞、共享契约需要决策** 三种情况下主动向主控发送消息。无需反复回复“收到、继续、正在检查”。接收方可直接读准确 handoff，不让 root 逐字转述。

每个交付摘要使用以下字段，目标约 10–20 行；详细日志继续落盘：

```text
包 / base / head / 需要集成的提交
完成的 R 编号与用户行为
改动范围 / 是否影响共享契约
实际命令、退出码、测试范围、日志路径
未解决风险 / 待集成项
需要的唯一决策（没有则写无）
```

失败只回传首个有效错误、关键调用链和日志位置。成功只回传结果与路径。两次返修仍未增加新诊断证据时，先做最小复现或定向审查，而不是继续碰运气。

不把“轮次上限”当作允许留下已知缺陷的理由：只限制重复无效过程。原有验收要求仍然有效。

---

## 2. R1：SourceModel 节点移动导致源元数据丢失

### 意图与发现

节点在网页中移动后，历史定位和原始属性仍应对应同一个采集到的节点，而不是因为模型重建顺序人为制造缺口。

`src/replay/source-model.ts` 的 `apply()` 先把本批 `record.metadata` 写入 Map，随后处理 `removes`。`remove()` 同时删除节点和该 ID 的 metadata。若同批随后 `adds` 使用相同 ID（节点重挂载/移动），`restore()` 已取不到刚写入的源元数据。最后再次更新节点时仍从被删除的 Map 读取。main 与 A 最新文件 blob 相同。[S03]

### 最小执行验证

本次用该类关键方法的逻辑抽取，构造“完整快照 → 节点 4 从父节点 2 移到 3，且第二批明确提供节点 4 元数据”的输入：

```text
移动前 metadata 存在：true
移动后 parentId：3
移动后 metadata 存在：false
metadataComplete：false
```

脚本为交接包中的 `review-evidence/repro-source-move.cjs`，结果为同目录 JSON。Node v22.16.0 下执行；不是使用项目规定环境运行其测试，更不是实际 rrweb/Electron 录制测试。它确认的是重建顺序缺陷，不声称已实测所有网站的录制批次形式。

### 修改路径

- 保持“先删除旧结构，再构建新结构”的必要顺序，但将 **本批 authoritative metadata 与旧状态的清理分离**。例如先执行结构移除，再安装本批 metadata 后 restore；或让删除只清理旧状态且不清除已暂存的新批数据。不要从回放 DOM 补回源属性。
- 覆盖移动的全部子树，不只修目标根节点；考虑带属性更新、兄弟次序变化和跨已支持 scope 的情况。
- 元数据在输入中确实缺失时继续报告 gap；不能强行设 `metadataComplete=true`。
- 增加模块负例与真实 rrweb 录制的拖动/reparent fixture。验证顺序播放和直接 seek 到同一位置得到相同节点、原始属性、frame/mirror 身份及 CSS/XPath 结果。

---

## 3. R2：视频式播放被实现为每个事件完整重建

### 发现

D 的 `ReplayWorkspace` 在播放期间按相邻事件 `sourceTimeMs` 计算等待，然后对每个事件调用 `seekReplay`。生产 `ReplayHost.seek()` 每次销毁旧播放器、读取 bounded window、重算资源映射、new Replayer、pause，再等待资源和帧绘制。[S04][S05]

因此播放实际是：

```text
等待事件间隔 → 完整重建至该事件 → 再等待下一间隔 → 再完整重建
```

真实重建耗时会被不断加到播放时长上；重复处理完整快照和相同增量前缀也会放大开销。原生视图每次 seek 被暂时隐藏，进一步产生卡顿/闪烁风险。这里不提供未测量的实际 FPS、内存或 CPU 数值。

现有 UI 测试把 `seekReplay` mock 成立即成功，并断言依次调用 `[2,3]`；它验证了时间差与调用顺序，但没有验证真实重建成本、连续播放性能，甚至把当前昂贵结构固化进断言。[S16]

### 修改路径

- **顺序播放、随机 seek 分开。** 播放采用持久 Replayer 和 rrweb 的增量调度/播放时钟；只在初次加载、远距离跳转、必要分段切换、错误恢复时完整重建。
- 保持源时间与精确 `eventSeq` 的双重身份。同毫秒事件不能丢失/颠倒；时间轴显示不修改原始时间。暂停后的精确位置需要验证，不能为播放流畅牺牲节点身份。
- 资源地址与内容版本按历史来源定位；不得为整段未来事件统一绑定最终时刻的 URL 内容。
- UI 用状态事件或低频、有并发上限的采样显示进度；不以逐事件 IPC 驱动整个播放器。单次 seek 的取消仍然保留代际检查。
- 测试真实生产宿主：含几百个事件、明显空闲和同毫秒事件的固定时长录制。记录实际播放耗时、重建次数和资源读取次数；重建次数应与窗口/分段边界有关，不能与事件数量一一对应。
- 正常等待、暂停、变速、重新打开、向前/向后 seek 都要验证。门槛在测试前根据目标机器确定，不事后按结果放宽。

---

## 4. R3：资源验证路径与生产路径分叉，并有“空白但 ready”的情况

### 发现

A 的离线测试使用 `rewriteReplayRecords`，按每个节点对应的 frame 来解析资源。生产 `ReplayHost.seek()` 仍收集 URL 并对每项调用 `archive.resolve(url, position, 'top')`，用仅 URL 为 key 的 Map 重写。这两条路径不是同一资源语义，A 测试通过不能推出生产同源 frame 回放通过。[S05][S06][S15]

另外，找不到的资源在宿主和 CSS dependency 重写中替换为 `about:blank`，但并非每一次替换都记入失败/排除状态。`waitReplayPresentation()` 只看传入 document 的 link、image、font，不递归等待子 frame，也不完整覆盖 CSS 背景资源。因而有缺失资源未触发显式错误、最终显示 `resources.ready` 的路径；不是所有缺图都一定如此。[S05][S06][S07]

### 修改路径

- 抽取并复用已有 frame-aware 准备/解析实现，让离线测试和生产 ReplayHost 走同一服务。测试可独立验证预期，但不能维护另一套更完整的生产替身。
- 资源 key 至少包含逻辑 frame、历史位置/资源版本和 URL；同 URL 不等于同份内容。
- 每次解析产生明确结果：captured、missing、excluded/redacted、unsupported、read-failed。允许安全占位，但必须把原因纳入状态与有界诊断，不静默把 unavailable 转成 ready。
- 递归覆盖已声明支持的同源 frame/open shadow 资源；CSS 间接依赖也要进入完整性记录。root 结构 ready 和资源 complete 是不同指标。
- 接入 `550f30a` 的 CSSOM/adopted fixture，但先执行获得实际结果；`replace/replaceSync` 的 URL 改写等已知遗漏定向修复。隔离 world hook 的主 world 覆盖仍是待实测问题，不能直接宣称完整或直接改为 unsupported 结案。[S15]
- 新增生产宿主用例：顶层和 frame 的相同 URL 不同历史资源、缺失 CSS 背景、坏字体、断网重开、CSSOM 变化、分段切换。不得关闭 CSP、sandbox 或离线网络封锁换通过。

---

## 5. R4：元素选择尚未成为有明确目标的事务

### 发现

`App.beginHistoricalSelection(kind, checkpointId)` 用 kind 改提示，但没有保存 purpose/draft/field/checkpoint 组成的选择目标；checkpointId 也没有驱动重新定位到该卡片 anchor。`MaterialWorkbench` 收到任何 `selectedTarget` 都执行 `setFieldTarget(selectedTarget)`，普通注释选取也会影响字段编辑状态。[S08][S09]

可触发的逻辑例子：打开已绑定 A 元素的字段 → 为同一 checkpoint 给 B 元素添加普通注释 → 回来只改字段说明并保存。当前代码可能把字段 target 一并改成 B；它们在同一 anchor，因此位置校验挡不住这一错绑。

开始选择也没有强制停止正在播放的调度。播放中的自动 seek 可以继续清除宿主选择状态、改变节点。这与“点击卡片注释→到对应历史页面→点元素”的目标不同。

### 修改路径

建立短生命周期的 `SelectionSession`，由一个 owner 管理，至少记录：

```text
selectionId / projectId / draftId / expectedDraftRevision
checkpointId / anchor / purpose(annotation|field)
annotationId? / fieldId? / replayId / generation
```

- 从卡片/字段入口发起：先暂停播放，等待实际暂停确认，精确 seek 到卡片 anchor；确认对应 generation ready 后才允许选择。
- 回执必须匹配该选择会话，不根据全局“最后选中元素”猜保存位置。
- 注释选择只更新该注释编辑状态；字段选择只更新该字段。取消、切草稿/字段/项目、删除目标卡片、关闭回放都使会话失效。
- 保存前核对草稿 revision 与 target 的历史身份；发生冲突保留用户输入并明确重新读取，不静默覆盖。
- 蒙版/`inert` 保留；选择输入框、Esc、保存/取消与紧急停止始终可用。原站动作继续禁止。
- 测试：同一卡片 A 字段+B 注释不串绑；播放中发起注释；卡片 anchor 不等于当前播放位置；选择期间 draft 被另一操作更新；迟到回执不写入新目标。

---

## 6. R5：任务授权还没有覆盖整个 HTTP 可观察面

### 发现与边界

Bearer、loopback 与浏览器 Origin 检查仍然存在。本发现不是“任何网站可直接访问 API”，也不假设 Agent 看不到当前用户本地文件；它针对产品自己承诺的任务范围与撤销语义。

`server.ts` 的 jobs GET 直接返回 `job.public`，job cancel 在 server 层处理；未按当前任务 scope 对读取/取消作统一检查。`dispatch.ts` 的 state/projects/profiles/workflows 等发现入口也没有进入已有 history/results 的 task 检查。结果是只对部分业务读取做授权，不能视为完整的项目隔离与撤销。[S10][S11]

例如已经完成的 job result 可在原授权撤销后通过已知 jobId 回读；跨项目的可见范围和取消权限也缺少统一策略。暂停记录已列 E 的 state/jobs/read/cancel 为待收尾，本次代码检查确认这不是仅补文档即可解决。[S02]

### 修改路径

- 定义一份入口策略表，覆盖 route→operation→发现/读取/写入/取消/可信人工权限，而不是不断追加零散 allow/deny 列表。
- jobs 保存所属 project、原授权/主体、能力和可见范围；GET、幂等命中与 cancel 都使用明确策略。授权撤销后不得继续借 job cache 返回已撤销范围的数据。
- 健康和最小能力发现可只需实例认证；不要把发现授权所需的一切也锁在未知授权之后。项目详细元数据按授权裁剪，不能复用完整可信 UI state。
- 人工紧急停止保留独立可信路径。对发起者撤销自己任务、过期授权下安全停止的需要，做明确、窄范围例外；不能借“允许停止”获得其他任务的结果或任意取消权。
- 重查授权需覆盖异步边界和排队/缓存结果，不只校验最初提交。
- 测试两个项目、读/执行不同能力、已完成 job、排队 job、撤销与过期、已知其他 jobId、幂等重试、紧急停止。要求拒绝/裁剪的接口必须测到 HTTP 层。

---

## 7. R6：公开能力与 UI 仍指向被拒绝的旧启动协议

D 最新 `app.tsx` 仍有“允许 Agent 启动一次”和两分钟说明；`/v1/capabilities` 仍公布 `startGrantId` 的一次授权。可是 `dispatch.ts` 对 HTTP `startValidation` 带此字段明确拒绝，要求使用新任务授权。[S09][S10][S11]

这是会让 Agent 按应用说明走向失败的确定性矛盾，也会额外制造人为协助与沟通。

**修改：** 新任务执行只保留一条清晰的启动路径；UI、capabilities、API 文档、skill 示例与错误信息同批更新。旧历史结果可以保留只读，但不再提供已无法消费的操作入口。若确有旧客户端兼容要求，建立受控适配并测试，不能默认恢复裸 lease 或平行维护两种未统一授权。

**验收：** 新 Agent 仅按应用当前 capability/交接提示完成授权后的重复试跑，不需要用户再签发两分钟授权；旧请求得到明确迁移提示。测试也不能继续用已弃用协议绕过正式入口。

---

## 8. R7：资料编辑还没有实现“就地解释历史页面”的完整用户路径

此项是原需求尚未做完，不把已明确标记为基础 UI 的阶段说成欺骗或退化。

D 最新源码仍有“关联需求 ID”文本输入；普通注释 `saveAnnotation()` 每次创建新 ID，列表只显示文本，没有修改、删除、重新选择入口；固定版本列表只是 revision/hash 文本，未在该 UI 提供查看固定内容、从某版派生草稿的操作。[S08]

### 修改路径

- checkpoint 内选择已有需求或“新建并关联”，自动维护稳定 ID。技术 ID 可复制/查看，但不是日常填写工作。
- 注释有新增、编辑、删除、重新绑定；编辑复用 annotationId，只改变当前草稿，旧 published revision 不变。复制 checkpoint 后的注释独立。
- 字段无元素、绑定无注释、绑定且注释三种路径都可直接完成；避免把 JSON proof 当成基础用户必填项。
- 精确证明、数据规则 JSON 可以保留高级入口，Agent 可提议；基础 UI 用字段名称/含义/数据集范围等表达。不要为本项新造完整规则 DSL/流程图编辑器。
- 固定版本按人类可读版本/时间展示，允许查看与派生新草稿；hash 作为身份信息保留。复用 B 的现有资料领域，不重新设计存储格式。
- 用户未按录制时点创建 checkpoint 也能事后新增；移动卡片后旧绑定的重新确认继续保留。

**验收：** 从实际 React UI 完成一次无需手填 ID/JSON 的“卡片→新需求→字段→元素→注释→修改→发布 V1→派生 V2”，重开 V1 内容不变。保存过程不得触发真实网站操作。

---

## 9. R8：E 待合目录读取对单个坏数据集整体失败

`83aa396` 对“host finish 前崩溃仍能找到已提交 batch”作了正确方向的补充，但 `datasetCatalog()` 对所有目录逐个 `await reader.summary()`，没有逐项失败状态；`ProjectExecutions.state()` 直接等待整个 catalog。[S13]

`PersistentDatasetService.index()` 的创建是建目录、写 dataset.json、再写 state.json；目录初始化中间崩溃，或一个 state.json 损坏，都会产生 summary 错误。于是一个半初始化数据集会让整个 execution 的摘要/列表失败，其他已确认耐久的数据也失去正常入口。[S14]

### 修改路径

- 目录级枚举与单项读取分开；可读数据集保留，问题项返回明确 unavailable/corrupt/not-initialized 和有界诊断。不可把失败静默当空数据或成功。
- 根路径/绑定不可信可以整体拒绝；单个非法链接/异常 entry 不跟随，安全隔离并明确诊断，不让它污染其余已验证项目。
- 超过读取预算提供分页/可继续状态，不能把“有界”实现成历史规模达到阈值后全部不可读。只扩展真实需要的目录查询，不扫描 batch 正文来伪造恢复。
- 只读查询不领取 writer lease、不修原件、不删除 pending 或锁文件。需要修复的索引走显式恢复。
- 测试：dataset A 完成耐久 batch，dataset B 在目录/manifest/state 三个边界中断；重开后 A 仍可见可读，B 明确异常，原文件字节与锁不变。再测真实权限错误、损坏和合法并发初始化。

---

## 10. 建议实施顺序与一次性 Review 边界

### 收敛准备

核对 A/D/E 待合提交和等价依赖，只整合本批所需成果。保存源分支，不自动删除或重写。不要让主控全量重读从 S0 至今的所有失败史；相关风险按本文件和最新 handoff 定向读取。

### 修复包 1：源身份与可访问结果

完成 R1；评审/接入 E `83aa396` 同时修 R8。需要的 source/capture 类型对齐一次完成。由一个实施者提交可复现回归，不增加专门的 Git Agent。

### 修复包 2：真实回放与选择

联合完成 R2/R3/R4，避免播放器、ReplayHost 和选择 UI 分别修改却接口不一致。一次有限 Astra/high 复核仅关注历史身份、连续播放、资源隔离及选择事务。R7 的就地编辑基础随后由 Sol/high 完成。

### 修复包 3：统一授权和公开入口

完成 R5/R6；同步需要的 D/E API/类型/skill 说明。重点测试 scope、jobs 与撤销，不顺手做一套新的权限平台。R5 可以在文件确实独立时与修复包 1 并行，但最多两个实施者且公共契约仍唯一 owner。

### 本批最终验收

由同一个真实应用路径执行，不只直接调用领域服务：

```text
录制合成页面 → 停录保留现场 → 原站关闭/断网
→ 打开存档连续播放、暂停、前后跳转
→ 对移动过的源节点定位并验证原始属性
→ 从卡片进入注释/字段选择，不串绑
→ 修改注释与需求，发布并重开固定资料版本
→ 按当前公开任务授权执行与撤销
→ 查看完整/部分失败/含坏目录的已提交结果
```

整合后实际执行 typecheck、相关定向测试、一次当前代码的完整单元测试及需要的桌面/恢复专项。未执行的原有最终验收保留为未通过；不把本批替代整体安装包、新 Agent 和新架构长测验收。

review 输出只列可定位的问题、触发条件、影响及验证缺口。修复后只复查差异和影响范围；出现新共享契约变化才扩大审查。风格建议不作为本批 blocker；真实安全、源身份、资料错绑与数据丢失问题不能因费用压力略过。

---

## 11. 新的主会话提示词

建议实际选择 **Sol/high** 开一个不继承庞大旧上下文的接续会话；该会话兼任实施和集成，只有需要时才创建有边界的 reviewer/第二实施者。不要让原 Astra 主控继续同步审查同一批工作。

```text
接续 Browser Evidence Studio，但不按旧主控协议全面展开 A–G。

先读 AGENTS.md、docs/refactor/04-review-and-execution-correction.md 的执行摘要，核对当前 main 和本批涉及的 worktree/待合提交；按任务只读对应 R 项、冻结契约和最新 handoff，不重读全部历史。main 参考 f55e015，A 550f30a、D 7b772bf、E c829777；只核对不回退后续合法成果。

你默认作为单一实施/集成者工作。普通 Git、日志摘要和传话直接批量使用工具，不为它们创建 Agent；只在交付、真实阻塞、契约决策时沟通。最多一个额外实施流，禁止递归派发。高风险疑难才用独立 Astra/high reviewer，限定 base/head 与问题；你不再重复完整技术 review。模型/强度必须实际配置，不靠文字声称生效。

先收拢本批必要待合成果，按文档修复：R1 移动节点丢元数据；R2 逐事件重建冒充连续播放；R3 生产 frame 资源接入和缺失诊断；R4 注释/字段选择串状态；R5 state/jobs 等授权范围与撤销；R6 旧一次授权入口矛盾；R7 需求就地关联及注释增改/固定版本编辑；R8 坏数据集阻断其他已提交结果。先复现、再最小修改和回归，保留不完整状态，不从回放 DOM 伪造源数据。

保留原件、旧分支与失败日志，不重做已集成 B/C/F，不降低 CSP/权限/断言；Git 写入串行，等价补丁不重复搬运。桌面测试串行，正常结果仅回传摘要，失败定向读日志。

通过真实生产 ReplayHost 和 React UI 验证文档第10节闭环，运行当前整合代码的相关回归与完整单元/类型检查。完成这批后安全保存，报告提交、实际通过范围、剩余阻塞及可取得的增量用量，然后暂停；不要顺手展开全部资源研究、通用调度平台、安装包和长测。
```

---

## 12. 源码与官方参考

下面链接固定到本次审查版本；后续修改以实际 SHA 为准。引用是源码/文档依据，不表示已运行所有相关测试。

- [S01](https://api.github.com/repos/ghostroller/browser-evidence-studio/branches?per_page=100) 远端分支（读取日 2026-09-26；这是动态列表）。
- [S02](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/docs/refactor-handoffs/PAUSE-20260926.md) 暂停和后续推送记录。
- [S03](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/replay/source-model.ts) SourceModel；A 550f30a 同一 blob。
- [S04](https://github.com/ghostroller/browser-evidence-studio/blob/7b772bff542cd4e960b344487876b9e150265099/src/renderer/components/replay-workspace.tsx) D 最新回放工作区。
- [S05](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/main/services/replay-host.ts) 生产 ReplayHost。
- [S06](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/resources/replay-resources.ts) frame-aware 重写与离线资源响应。
- [S07](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/main/services/replay-presentation.ts) 选择命中和资源就绪。
- [S08](https://github.com/ghostroller/browser-evidence-studio/blob/7b772bff542cd4e960b344487876b9e150265099/src/renderer/components/material-workbench.tsx) D 最新资料编辑器。
- [S09](https://github.com/ghostroller/browser-evidence-studio/blob/7b772bff542cd4e960b344487876b9e150265099/src/renderer/app.tsx) D 最新 App 选择/授权入口。
- [S10](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/main/api/server.ts) HTTP 路由、能力和 jobs。
- [S11](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/main/services/dispatch.ts) UI/API 分派和任务授权覆盖。
- [S12](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/main/services/task-authorization.ts) 任务能力与授权生命周期。
- [S13](https://github.com/ghostroller/browser-evidence-studio/commit/83aa39671617f7ba46f59493043fae7c25fbfbaa) E 待合数据集发现功能。
- [S14](https://github.com/ghostroller/browser-evidence-studio/blob/f55e015127bc4e7c507fc225193c9ed4804cade5/src/runner/datasets.ts) 数据集目录初始化和读取。
- [S15](https://github.com/ghostroller/browser-evidence-studio/commit/550f30aab9721eb9136f6358e1b7836b9edd1190) A 保留的 CSSOM/adopted fixture。
- [S16](https://github.com/ghostroller/browser-evidence-studio/blob/7b772bff542cd4e960b344487876b9e150265099/test/renderer/refactor-replay.test.tsx) 当前播放器 UI mock 测试。
- [S17](https://developers.openai.com/codex/models) OpenAI 官方模型文档（读取日 2026-09-26）。
- [S18](https://developers.openai.com/codex/subagents) OpenAI 官方子 Agent 文档（读取日 2026-09-26）。
