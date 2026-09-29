# Browser Evidence Studio：M1 阶段性审查与最小修正意见

日期：2026-09-27。审查基线：`f2894456e2a9364044067ddbdbd813300e5a8dde`。
对比起点：`97d6623d8028bdef9008a52a0f965e8d82187c74`。
性质：暂停期间的源码 Review，不是实施指令、测试通过证明或新的全项目重构计划。

## 0. 结论与执行边界

**当前产品主线比上一轮明显改善，应该保留并继续收敛，不建议再次推倒。主要剩余风险是：页面入口接通了，但保存、发布、重试和切换上下文还没有形成一致的应用层事务。**

本轮已经看到真实的结构进展：无录制环境/session；采集收据关联用户卡片；实时源节点进入字段编辑；服务端补齐唯一数据集；显式 keep/set/clear；工作区不再随 tab 卸载；taskBrief 固定进新资料；停录后固定版本执行。这些不是单纯增加按钮。[S02][S03][S04][S05]

仓库准确区分了验证范围：实施者两进程 U01–U06 旅程已有通过记录；此后又增加无录制/停录切页、popup 父视图恢复、审计失败后的撤销收尾修复，只有窄回归和类型检查，尚未重建并重跑旅程；独立普通用户复走因为外来输入中止，尚未完成。本 Review 不把这些未完成测试当作缺陷，也不把早期发行包/长测成绩归给当前源码。[S01][S02]

本次检查的是远端已提交代码、最新 handoff、08/09 产品约定。没有访问用户本机窗口、原录制或 profile；没有执行项目的 Windows/Electron 测试。附带四个纯 Node 控制流模型，只验证缩小后的逻辑，不是直接导入实际组件的测试。工作容器无法解析 GitHub 域名，未克隆/执行仓库；源码由已连接 GitHub 工具按固定 SHA 读取。

**下一次用户明确恢复时，先处理 E01–E03；E04 是会话脱离录制后必须明确处理的接入缺口。其余列为阶段债务，不借本 Review 自动展开 M2/M3、长测、打包或多流重构。** 保留原件、旧版本、旧 partition 与所有失败证据。暂停期间不得自动恢复桌面操作。

| 编号 | 结论 | 分类 | 优先级 |
|---|---|---|---|
| E01 | 发布前串行调用旧 render 的保存闭包，会覆盖新关系；还有未纳入 flush 的编辑 | 源码确认；关系覆盖有控制流模型 | P1 |
| E02 | 采集重试不区分未采集/已保存原件；旧选择可能锁住后续操作，关联成功又可能不装回字段目标 | 源码确认；两个控制流模型 | P1 |
| E03 | 旧项目初始化和采集回执可以先修改全局编辑状态，再检查归属；草稿/操作缓存的所有权不完整 | 初始化竞态有控制流模型；采集切草稿为源码路径 | P1 |
| E04 | 授权已按 session 签发，但普通实时读写仍要求 active run | 确认的跨层接入缺口；不是权限绕过 | P1（正式 Agent 接续前） |
| E05 | 编辑对象仍依赖当前分页；工作草稿和版本展示身份不是稳定实体 | 确认实现限制，主要属后续 U11/U12 范围 | P2 / 阶段债务 |
| E06 | 环境配置、多个例证和技术映射仍为第一纵向实现 | 已声明的阶段范围，不直接当作当前缺陷 | 保留边界，避免误报完成 |

---

## 1. E01：保存并发布没有使用一致的编辑快照

### 1.1 具体问题

位置：`src/renderer/components/material-workbench.tsx`：`publish`、`saveField`、`saveRequirement`、`saveCard`、`saveAnnotation`。[S04]

`publish()` 依次调用 `saveCard()`、`saveField()`、`saveRequirement()`。它们都是用户点击时那一次 render 产生的函数。`mutate()` 会更新 `draftRef.current` 和 React state，但不会更换已经执行中的 `publish()` 所持有的 `selectedRequirement` 等闭包值。React 官方也明确指出，异步事件处理仍看到创建该处理器时的状态快照。[S16]

可发生的路径：

1. 已有需求 R，`fieldIds=[]`。
2. 用户同时修改需求说明，并填写一个新字段 F，没有分别按保存。
3. 点击“发布候选版本”。
4. `saveField()` 保存 F，并把 R.fieldIds 更新为 `[F]`。
5. 随后的 `saveRequirement()` 使用旧 `selectedRequirement.fieldIds=[]`，但配合更新后的 `draftRef.current.draftRevision` 提交。
6. CAS 通过，R.fieldIds 又变成 `[]`；F 仍在 fields 中，但不再属于 R。

服务端目前检查“被需求引用的字段是否存在”，不要求每个字段都必须被需求引用。因此这种关系回退不一定被拒绝。[S05][S06] 附件模型确认该顺序能产生上述结果；还需实际 renderer 回归验证。

**CAS 只能阻止旧版本号的写入，不能识别“新版本号包着旧对象内容”。**

### 1.2 另外有未纳入发布 flush 的编辑

`publish()` 对卡片主要比较 title/notes，没有覆盖仅修改 kind 或关联需求；普通注释新增/修改没有统一进入发布 flush。`selectCard()` 也会清空 annotation 编辑状态。用户可能仍看到/恢复本机输入，却发布了没有这些输入的固定版本。

区别必须明确：**保存在 localStorage 的恢复输入，不等于已经保存到可供 Agent 读取的任务资料。**

### 1.3 最小修正路径

- 建立一个编辑会话对象，显式保存 card/requirement/field/annotation 的 dirty patch 和身份，不靠若干文本差异猜测全部未保存内容。
- 发布时冻结该会话的命令集合；从同一个预期草稿修订生成 edits，一次调用现有 `editMaterialDraft`。关系修改在服务端对同一份最新图上执行。
- 使用保存回执中的确切 draftRevision 发布。保存冲突/失败不得继续发布；发布后草稿推进失败仍按现有 partial-publish 语义处理。
- 若分两次持久提交，二者之间仍保留 CAS；不要对用户不可见地吸收其他写入。需要单一事务时复用服务内部锁，禁止在已有项目锁中再调用同一 `locked()` 公共方法造成重入等待。
- 发布/交接前纳入：卡片类型/关联、需求说明/规则、字段语义/绑定/注释关系、普通注释文本/对象、taskBrief。
- 切换对象：先保存相关 patch、留在按实体 ID 的编辑缓存中，或明确询问放弃。不能只保留最后一个全局输入框状态。

### 1.4 必须补的回归

- 同时修改需求说明和新增字段，直接发布：固定版本中 fieldIds 与 dataset 正确。
- 已绑定字段改说明与需求改说明一起发布，旧绑定和新增关系均保留。
- 只修改卡片 kind/关联需求后发布，版本包含该修改。
- 修改普通注释后直接发布或切卡：不静默丢弃，不发布旧值。
- 任一保存失败：不产生一个被 UI 称作最新成功资料的遗漏版本；旧固定版本/hash 不变。

---

## 2. E02：采集重试把不同阶段混在一起

### 2.1 旧 selection 会被无限重用

位置：MaterialWorkbench 的 `recordCurrent`、`beginLive`、`retryCapture`，以及 `Studio.captureAndAuthor`。[S04][S07]

前端在调用服务之前就设置 `retryCapture.current`。无论后端是否已经保存 intent 或 receipt，catch 都保留它；按钮随即显示“重试关联已保存原件”。

如果第一次因为页面导航导致 selectionId/generation 过期，后端可能在写入 intent 前就拒绝。此时并没有“已保存原件”。用户重新选择正确元素时，`retryCapture.current ?? freshRequest` 又选择旧请求，继续提交过期身份。附件模型确认：第二次正确选择仍提交第一次的 selectionId。

### 2.2 已保存原件的重试，可能成功关联卡片却没恢复字段绑定

重试按钮调用 `recordCurrent()`，其局部 `selection=false`。即使复用的 request.selection 为 true，且响应包含 target，`if(selection) setFieldTarget(...)` 也不会执行。

用户看到“关联成功”，但原来的“为字段选择元素”意图没有完成。不要以卡片存在代替字段绑定已回到编辑器。

### 2.3 前后场景混合的额外风险

intent 保存的是早先的 position/target；如果 intent 已存在但 receipt 尚未成功，重试只检查仍是同一 recording，而新 `checkpoint()` 默认从当前页面采集。当前页面可能已经导航或切换。

这不意味着必须要求原子冻结页面；原始 screenshot/DOM 本来就是采集区间。问题是：**旧 anchor 与后来其他页面取得的 receipt，不能没有明确关系和诊断就包装成同一次现场。** 必须记录/验证采集页面、文档代际、时间区间；不满足原意图时拒绝继续同一 acquisition，保留意图并让用户明确新取样。

### 2.4 最小修正路径

- 让 AuthoringOperation 返回可区分状态：`not-captured`、`acquiring`、`receipt-saved`、`associated`、`source-expired`，以及无法确认响应的状态。可以沿用现有 operation 文件，不另造后台平台。
- 只有确认 receipt 已保存，才显示“重试关联”。新选择失败在采集前时，允许创建新 operationId 和新 source identity。
- 对网络断开/未知响应，先按 operationId 查询状态。不能一遇到异常就清空并重采，否则会制造重复原件。
- operation 固定 project、draft、purpose、source identity 和请求指纹；重试必须恢复原来的业务意图，不能取决于本次按钮调用的默认参数。
- `receipt-saved → associated` 只重做关联，禁止再次采集。`not-captured → acquire` 必须重新验证来源是否仍是原意图。
- 关联成功后按 operation.purpose 将 target 交给对应字段/注释编辑会话；无法恢复原会话时显示待处理项，不悄悄丢弃。
- 操作取消/放弃只影响这次编辑意图，不删除已经保存的原件。

### 2.5 必须补的回归

- 导航使首次选择过期，然后选择新元素：新请求可成功，旧请求不会一直占用重试状态。
- receipt 保存成功但资料写失败：重试恰好关联一张卡片，并恢复该次字段目标。
- 响应丢失但后台已成功：重试不增加 receipt/card。
- intent 保存后、receipt 前切页或导航：旧 anchor 不被绑定到新页面材料。
- 明确取消，不删除旧卡片或旧字段绑定。

---

## 3. E03：上下文归属检查太晚，旧响应先破坏了新编辑会话

### 3.1 项目初始化竞态

位置：MaterialWorkbench 初始化 effect 与 `openDraft()`。[S04]

`workingMaterialDraft().then(value => openDraft(...))` 没有在调用 `openDraft` 前验证该请求仍属于当前项目。`openDraft` 的后续结果检查虽然有 scope guard，但它一进入就增加共享 token、清空 draftRef、清空列表。

可发生：A 的工作草稿读取迟到 → 用户已经切到 B 且 B 正在加载 → A 的回执调用旧 openDraft，先令 B 的 token 失效 → A 因 scope 不符丢弃，B 因 token 不符丢弃 → 当前项目 B 留下空编辑器。附件控制流模型复现了这个序列。

### 3.2 采集期间切草稿的类似路径

`recordCurrent()` 只设置 pending 文本，没有使用与 `mutate()` 相同的 pendingRef/write token。草稿列表按钮也不是统一按 pending 禁用。普通“记录当前结果”在等待期间仍可能切换草稿；旧回执回来后无条件 `openDraft(oldDraft,true)`，会抢回旧草稿并保留新草稿的输入状态。

另外 `resetEditor()` 没有统一重置 retryCapture、liveIntent、mapping、cardInputs、bindingAction 等跨请求状态。它们不应只是组件全局变量而没有 project/draft/operation 归属。

### 3.3 最小修正路径

- 每个异步请求带 owner：`projectId + draftId + editorSessionId + requestSequence`。
- **先核对 owner，再做任何清空、递增 token、切换选中对象等副作用。** 在 await 之后才拦结果不够。
- 将 bootstrap 与主动切草稿分别管理：旧 bootstrap 不得取消用户后来主动发起的读取。
- 所有写入（含 capture、mapping confirm）使用同一编辑事务边界；允许切换时必须隔离迟到回执，否则在写入阶段明确阻止切换。
- 待重试操作和未保存输入按项目/草稿保存，读取不到某个缓存时不保留前一个草稿的 operation。
- 后台已经完成的操作仍记录到正确草稿，不因前台切换而丢弃事实；只是不能再抢夺当前 UI。

### 3.4 必须补的回归

- 两个已有项目，无 live session，人为延迟 A 初始化，先完成 B 操作再释放 A：B 保持可编辑。
- 草稿 A 采集中切 B：A 的结果不得改变 B 的卡片、字段或选择态；或者切换被明确阻止。
- A 中失败重试后切 B：B 不显示/提交 A 的 retryCapture。
- 重载本机缓存，版本变动冲突明确显示，不把缓存当已保存的服务端资料。

---

## 4. E04：Session 授权已经独立，实时页读写仍绑在 active run

### 4.1 当前实现的准确范围

`authorizeTask()` 已使用 `live()` 建立 session 权限；`POST /v1/validations` 在没有 active run 时也有新路径。这是实际进展。[S03][S08]

但 `dispatch.ts` 对 pages/snapshot/action/createPage 等路径继续要求 `studio.required()` 和 active run；`Studio.action()`、`createTaskPage()`、`snapshot()` 及 `assertOperationOwner()` 也仍使用 active 假设。[S03][S08]

所以停录后的 Agent 可以得到 session 授权、读取固定资料并启动某些执行，却无法按该授权正常探索当前页面。当前演示实现器恰好已知站点选择器，不需要这种探索，因此 U06 的这条自动化路径没有暴露它。[S11]

这是接入缺口，不是让任意 Agent 绕过授权的理由。既有 `runId` 历史身份仍必须严格验证。

### 4.2 最小修正路径

- 内部使用一个清楚的 page command target：session、profile、page、target、navigationGeneration、lease。其主体是当前 BrowserSession，录制身份为可选附着信息。
- session 级 snapshot/action/createPage 都走同一页面服务；HTTP 历史 run 路由仅作为当前有效 run 的准确绑定，不能接收已封存 run 来代替 session。
- 不要只把所有 `required()` 改为 `live()`：还需处理原本无条件的 `store.appendEvent()`、capture、selection、页面关闭、控制权与取消收尾。
- 没有录制时，操作审计进入 session audit；真正执行按设计创建自己的 run；不要为了点击一下而偷偷重开人工示范。
- 读权限与页面写 lease 分离；过期/撤销/目标导航后仍然拒绝。背景页读取不抢用户前台。
- 在尚未接完前，capabilities 与 skill 明确区分“能启动执行”和“能无录制探索”，不得公布了操作却让 Agent 只能遇到 No active run。

### 4.3 回归

环境准备→示范→停录→UI签发授权→Agent读当前/后台页面并点击合成按钮→执行建立新 run→撤销后拒绝旧写请求。全程不重启人工示范、不修改旧 recording，也不接受旧 runId。

---

## 5. E05：稳定编辑身份仍受分页与本机缓存支配

这部分主要对应 U11/U12，当前停点尚未完成其全矩阵，不要求本轮把所有大规模能力补齐。但扩展前要确定修法，不能继续在列表上补临时判断。[S04][S05][S09]

- `mutate()` 保存后重载各集合第一页；`card`、`selectedField`、`selectedRequirement` 都从当前已加载 items 中查找。当前实体在后页时，读取范围变化可能令它暂时不存在；保存逻辑又可能把它解释为“新实体”，生成新 ID。
- `workingDraft()` 按 ID 字典序第一页内第一个 available human draft 选择，不是稳定的项目工作草稿指针。前端 localStorage 另维护 activeDraft；两套选择规则在缓存丢失、多个草稿或迟到请求时不一致。
- V 序号由已加载版本数量减 index 得到，加载更多后会改变；首批排序不能代表完整版本顺序。

最低约束：`editor.entityId` 不因分页变化改变；不存在于当前页应发 exact-ID 读取或明确 not-loaded，不作为新建；项目工作草稿由服务端持久指针/CAS决定；版本序号采用稳定可读身份，UUID/hash继续用于机器核验。

普通单页流程修好后，再用50+条目覆盖此边界，不以当前小资料通过声称完成。

---

## 6. E06：需要继续保持的产品边界，不急着再造系统

### 6.1 环境已能先打开，但完整配置尚未做完

当前 Profile 新增 entryUrl/instructions/storageRef/checkSelector 等，且 openEnvironment 不先创建 EvidenceStore，方向正确；旧 partition 回退仍存在，必须保留。[S03] 完整编辑、配置版本、明确的登录检查结果、跨项目显式复用是已声明后续范围。

不要仅凭 selector 存在就泛化成“账号一定正确”。后续检查结果应绑定配置版本、页面 origin/导航代际、检查时间与结果；检查失败不能留下像是刚验证成功的旧状态。保存浏览器持久数据与确认登录分开。不得为了抽离配置重建旧 partition 或移动活动数据库。[S17]

### 6.2 实时选择应是意图驱动，不要永久只剩“金额字段”一路

当前 live 入口固化新例证并交给 fieldTarget，普通 annotation 仍主要走历史选择。[S04] 这符合先做一条字段纵向的阶段策略，但不能宣称所有实时注释与多例证完成。

下一阶段复用同一 SelectionSession，目的区分 field / annotation / observation。旧卡片与当前页不同，新增来源例证而不偷偷移动旧 anchor。多个示范属于同一个字段时，应保留多个例证，不用一次替换 field.target 假装“追加”。避免扩大成视频编辑器或工作流DSL。

### 6.3 技术映射是可接受的 M1 过渡，不能成为永久产品架构

当前 implementation.json 基于资料 contentHash，UI可读确认后把outputPath/sourceProof写回字段并再发新资料版本。[S10] 作为第一纵向，这是 handoff 已声明的妥协，不是必须立即推倒的问题。

但未来要区分“用户改变要什么”和“实现者更换怎么提取/验证”；否则每换一次selector都变成用户需求新版本。保持技术映射绑定稳定任务版本、实现指纹，不能自动放宽原始要求。taskBrief当前虽已固定，新scope/brief的显式编辑入口也要留在后续计划，不从Project.objective自动覆盖旧版本。

### 6.4 本机编辑缓存是恢复层，不是另一份任务真相

localStorage用于崩溃后保留输入有帮助。但正式资料仍是服务端草稿及固定版本；“本机已恢复”“服务端已保存”“当前可发布”应有不同状态。不要靠重复增加缓存字段解决事务/身份问题。

---

## 7. 当前测试该怎样解读和补齐

### 已改善的地方

这次 U01–U06 不再借另一份 fixture.executionId，而是消费UI创建的资料，经过可读映射确认后执行同版，并有正确/错误/缺证据结果。这比上一轮预置资料的验收更有价值。[S01][S02]

### 还没被证明的地方

`product-implementer.ts` 明确是演示实现器：寻找名为“实付金额”的字段，预知 `data-field=amount`、`data-entity`、`/amount` 等。规范09允许明确标记的实现器，因此这不等于伪造；但它只能证明特定语义/站点路径，不能证明普通Agent已能理解任意选中字段或在停录后的session自行探索。[S11][S12]

本机独立复走因为外来输入暂停也不是产品bug，只能继续标记未完成。不能用“它还没测完”代替源码审查，也不能因为实施者旅程已过就关闭 E01–E04。

### 本轮建议的最小补测顺序

1. 先把附件模型移植成真实 renderer/service 回归，验证E01–E03；附件本身不能算项目测试通过。
2. 对当前SHA重新构建，回归三个暂停前的session修复，跑原U01–U06。
3. 加正常组合分支：两个未保存编辑直接发布；注释未保存直接发布；取样失效后重选；partial后关联；两个项目交错响应；无录制授权后的真实页面读取/动作。
4. 独立普通用户上下文复走。改变字段名称/选取对象或增加第二个字段，不给内部定位器和已成功executionId。可保留固定演示实现器作为回归，但泛化接续要另行验证。
5. 保存源SHA、构建身份、连续窗口证据和每一步使用的同一资料版本。未经用户确认，不自动进入M2/M3或全量发行门。

**目标不是再增加一批测试数量，而是让常见操作顺序与失败恢复真正成立。**

---

## 8. 下一批的实际边界

- **优先修E01–E03**：统一编辑事务、AuthoringOperation阶段和上下文身份，是同一个应用层一致性主题。
- **E04先补一条最小session读写闭环**，或在用户暂缓其实现时明确能力缺口；不能靠重开人工录制掩盖。
- E05/E06保持后续清单，不为了这次Review重启全部功能实现。
- 普通Git/日志直接用工具；不重新建设多Agent管理层。只有存在可独立验证的问题才委派范围明确的任务，主控不重复全包审查。
- 用户当前只要求审查，未授权本工具在其本机恢复实施/测试。接续提示词是以后明确恢复时使用。

## 9. 来源导航（固定到审查SHA）

以下按需阅读，不要求每次接续把所有历史文档重读。

- [S01] [当前状态与验证边界](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/docs/refactor-status.md)
- [S02] [产品M1实施交接](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/docs/refactor-handoffs/PRODUCT-M1-20260927.md)
- [S03] [环境/session/授权/动作/采集创作](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/main/services/studio.ts)
- [S04] [编辑、发布、重试与初始化](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/renderer/components/material-workbench.tsx)
- [S05] [资料写入、关系、workingDraft](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/main/services/project-materials.ts)
- [S06] [资料图校验](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/materials/validate.ts)
- [S07] [采集与关联操作](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/main/services/studio.ts)
- [S08] [dispatch与session/run范围](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/main/services/dispatch.ts)
- [S09] [资料分页、锁、发布与持久化](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/materials/service.ts)
- [S10] [实现映射校验与确认](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/main/services/implementation-mapping.ts)
- [S11] [明确标记的演示实现器](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/test/desktop/product-implementer.ts)
- [S12] [用户旅程与范围](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/docs/refactor/09-user-journey-acceptance.md)
- [S13] [产品主线规范](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/docs/refactor/08-product-realignment.md)
- [S14] [主界面与环境/实时选择入口](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/src/renderer/app.tsx)
- [S15] [现有资料窄回归](https://github.com/ghostroller/browser-evidence-studio/blob/f2894456e2a9364044067ddbdbd813300e5a8dde/test/unit/product-authoring.test.ts)
- [S16] [React：State as a Snapshot](https://react.dev/learn/state-as-a-snapshot)
- [S17] [Electron：Session/partition](https://www.electronjs.org/docs/latest/api/session)

附件 `review-evidence-f289/control-flow-models.mjs` 与 `results.json` 为四个独立控制流模型；运行环境 Node v22.16.0，与仓库规定的Node/npm组合不同，不计入项目验证记录。
