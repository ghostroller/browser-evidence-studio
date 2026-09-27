# Browser Evidence Studio：产品主线纠偏、代码审查与实现契约

日期：2026-09-27。审查基线：`97d6623d8028bdef9008a52a0f965e8d82187c74`。

**性质：产品层整改规范，不是又一份“全部完成”报告。** 代码位置均指上述固定版本；后续实现应先核对最新 HEAD，不回退合法成果。本轮为远端源码、设计与测试代码审查，没有运行用户的 Windows 应用或检查其未提供的实际录制。附带两个控制流实验只演示已检查的局部逻辑，不冒充项目测试。

## 0. 执行摘要：先读本节，再按当前工作读取相应章节

核心判断：现有项目已经具备较多可靠的录放、存储、隔离执行、来源核验与分发基础，但普通用户的创作流程未闭合。旧“保存点”界面与新“任务资料”编辑器同时存在；实时元素采样没有进入资料绑定；登录环境只能经录制创建浏览器；UI 生成的需求还存在进入验证器后找不到数据集的确定路径。377 项测试、循环回放和上一候选的长测，不能替代这些产品路径。

**本轮唯一主目标：普通用户从空环境开始，不输入内部 ID、sourceProof JSON 或调用隐藏 API，能够准备登录环境、示范、创建统一保存点、实时/历史绑定字段、保存版本，最后让 Agent 根据这些由 UI 创建的资料完成实现和结果检查。**

保留：Electron/React/rrweb、原始事件与资源、历史节点身份、来源校验、Gate/取消、耐久批次、封存哈希、已有测试与工作树。不换框架、不重写录放器、不削弱校验，不恢复旧一次性授权。

改变：应用层对象关系、创建入口、编辑事务、环境生命周期、任务定义与实现映射、产品验收方式。不要仅新增按钮、帮助段落或“此功能不代表绑定”的提示后结案。

本文件 §3–§8 与 `09-user-journey-acceptance.md` 是本轮产品行为的规范来源，取代旧文档中冲突的 UI/完成口径；01–07 的历史事实及安全、真实性要求保留。实施时同步修订 `docs/design.md`、`architecture.md`、`implementation-plan.md`、`api.md` 和 AGENTS 的阅读入口，不让新旧规范继续并列生效。

**先完成一条真实纵向流程，再并行扩展。** 第一条流程由 Astra/high 负责设计取舍并直接实施，不只是主持 Git/review；Sol/high 在接口和用户行为已落实后实现独立模块。不能一开始按旧 A–G 再拆十个“完成的子系统”。

---

## 1. 证据范围与问题分级

这里的阻塞指普通用户任务阻塞，不等同于安全漏洞等级。下表中“确定路径”来自代码，仍要求本地增加生产路径回归；“风险”不写成用户现场已经发生。

| 编号 | 结论与证据 | 分类 | 处理 |
|---|---|---|---|
| P01 | `app.tsx` 的实时选择只切 `inspect`、显示 `active.selection`；MaterialWorkbench 只接 historicalTarget。界面还明确提示实时采样不自动绑定卡片。 | 确认产品断点 [S02,S03] | 实时与历史选择使用同一绑定意图和提交入口，实时先固化来源再绑定 |
| P02 | 保存点 tab 调旧 `checkpoint` 写原始截图/DOM；资料 tab 独立创建 CheckpointCard，无正常用户的自动关联/提升路径。 | 确认双轨创作流程 [S02,S04,S05] | 用户只操作一种保存点；原始采集收据与可编辑卡片在服务端关联 |
| P03 | Profile 仅 id/projectId/name/savedAt/loginStatus；browser 由 startRun 创建，BrowserSessionLifecycle 包着 ActiveRun。环境保存按钮放在执行区且要求 active。 | 确认独立性不完整；详细环境配置是补充契约 [S02,S06,S07,S08] | 独立打开/准备环境，不为登录强制录制；配置、profile 与临时 session 分离 |
| P04 | UI 创建 requirement 不写 dataset；保存 field 只补 fieldIds；Validator 仅按 requirement.dataset 装载数据。 | 确认 producer→consumer 缺陷 [S04,S05,S09,S10] | 服务端规范化数据集关联，拒绝矛盾；验证 UI 刚创建的 revision |
| P05 | selectCard 清空 fieldTarget/fieldAnnotationId 却保留 fieldId 与字段表单；saveField 在 null target 时删除原有绑定。 | 确认隐式解除绑定路径 [S04] | keep/set/clear 三种显式命令；浏览卡片不改变字段定义 |
| P06 | MaterialWorkbench 随 tab 条件卸载；表单/当前草稿只有局部 state。刷新/冲突处理也直接 resetEditor。 | 确认未保存内容丢失风险 [S02,S03] | 项目级编辑状态及保存协议，切换/退出/发布先处理 dirty，不静默重置 |
| P07 | 注释重绑/删除只修复当前已加载 pages.fields；每次保存后集合回到第一页。 | 确认分页与关系维护不匹配 [S03,S04,S10] | 后端针对全图的关系命令；分页不影响完整性；定位 ID 与列表页解耦 |
| P08 | UI 要填规则 JSON、输出 JSON Pointer、sourceProof；无自然的实现映射审查流程；默认仍有“旧流程试跑”。 | 确认产品负担/正常路径不完整 [S02,S05,S09] | 用户表达语义，Agent 生成实现映射；未建立验证规则就明确未核验，不放宽成 pass |
| P09 | MaterialContent 没有任务目标/范围；Project.objective 可变；所有资料都只标 candidate，任务确认与结果人工评审未明确分层。 | 确认版本内容边界缺口 [S06,S11] | 固定任务 brief 和义务，独立记录需求确认；技术映射、环境与结果分层 |
| P10 | authorizeTask/authorizedOperation 仍要求 active run；录制结束虽然留页，但正常授权/执行接续受 run 前置限制。 | 确认流程耦合 [S06] | session 是操作主体；执行按需生成执行记录，不要求重新录人工示范 |
| P11 | 每次 updateDraft/publish 都重新验证全部历史卡片与 bound 目标；无关旧来源读失败会阻断普通说明编辑。 | 确认阻断路径；性能量级未测 [S12] | 编辑结构合法性与来源可用性分开；只验证新绑定，持续报告旧来源状态 |
| P12 | 实时高亮通过设置并删除业务元素 inline outline；原有 outline 会丢失，自身视觉改动可能进入记录；live 模式没复用历史选择的全工作区蒙版/取消协议。 | 确认实现及风险 [S13,S02] | 非侵入选择层、明确 Esc/取消、原生视图协调和来源排除 |
| P13 | workbench 测试按预设 recording/position/target 操作，再查看 fixture.executionId；AT39 事先直接 dispatch 建需求、dataset 和 proof。 | 确认验收范围缺口 [S14,S15,S16] | 新增“空数据根→可见 UI 创建任务→同一版本执行”验收，旧模块测试保留 |

### 1.1 P04 的最短解释

当前生产关系是：

```text
UI 新建 requirement：{id, description, fieldIds: [], rules: []}
UI 保存 field：{dataset: "orders", ...}
更新 requirement：仅追加 fieldIds
Validator：没有 requirement.dataset → 不装载 orders → not-run / inconclusive
```

`validateContent()` 仅在 requirement.dataset 已存在时检查字段的数据集是否一致，因此未挡住这条路径。修复不能只是测试中预填 dataset。纯说明型要求可没有 dataset，但带数据字段的要求必须具有明确且唯一的数据集归属，或使用明确定义的跨数据集规则。[S04,S09,S10]

### 1.2 P05/P07/P06 不是“用户操作复杂”的泛泛评价

已选字段 F → 点击/重新点击卡片 → fieldTarget 清空而 F 的 ID 未清空 → 改字段描述并保存，会走删除 target 的分支。注释删除/重绑又只更新首批或已加载字段，未加载字段的反向引用可能让后端拒绝保存。切换 tab 还会卸载整个资料编辑器。这些要由独立 regression 固定，不依赖操作者记住特定操作顺序。[S02,S03,S04,S10]

另一个关联问题：`copyCheckpoint()` 写入 derivedFrom，但 UI `saveCard()` 重新组装整张卡片时没有保留这个字段。复制卡片再改标题会丢失派生来源。服务端说明编辑应使用白名单 patch，保留不属于本次编辑的出处字段；回归检查复制→改标题→V2 的来源仍在。[S04,S20]

### 1.3 哪些东西不应被推翻

上一发行候选确有封存完整性、长测、打包、独立脚本和新 Agent 的具体记录。不能把产品失败等同于这些结果全部无效；也不能由这些结果推出用户会用。白屏修复针对原生回放呈现，不解决资料组织和登录准备。[S01,S17]

---

## 2. 需求缺口、实现偏差与文档责任

| 事项 | 旧规范真实表达 | 本轮如何处理 |
|---|---|---|
| 需求/观察分离 | 数据语义分离，但在 checkpoint 就地编辑；不要求独立需求管理系统 | 当前两套保存点编辑链偏离。统一创作 UI，底层继续分层 |
| 浏览器独立于录制 | 明确应当独立 | 仅“停录不关页”不充分；必须支持首次打开时也不录制 |
| 历史节点可绑定 | 明确要求来源与历史位置一致 | 不能把这条原则解释成“实时选择没有绑定功能” |
| 实时选择旧卡片 | 没有充分规定实时时刻与已有历史 anchor 冲突如何处理 | 本轮规定：固化当下为新例证/新卡片，不偷偷回填旧位置 |
| 环境配置抽离 | 旧 design 更接近项目内命名 profile；没有完整管理/准备合同 | 本轮明确配置、持久存储、登录准备、检查记录和 session，不能假称都已原文规定 |
| 跨项目复用环境 | 未充分确认；原文强调项目隔离 | 环境可独立管理；默认仅原项目可用，跨项目关联需显式授权。绝不默认共享 Cookie |
| 自动工作草稿/未保存输入 | 以前偏重不可变版本，未充分规定日常编辑 | 自动工作草稿、切换保存与冲突处理进入本轮必需行为 |
| 任务确认 vs 机器通过 | 原文不能让 Agent 冒充人工批准，但细分未落实 | 确认任务目标、允许实现试跑、接受执行结果是不同动作 |
| 完成定义 | 旧 AT 有不少正确的不变量，但前端输入闭环不足 | 新旅程与旧 AT 并列，前者任何核心路径失败都不能宣称产品完成 |

之前审查过度集中在单项风险与合成系统接入，没有在“可以开始验收交付”前证实用户如何从空项目形成任务。把回放作为存档入口是正确方向，但不应强迫录制中每次选字段都手动切去回放并重建一套资料。

---

## 3. 本轮目标产品：少量入口，唯一创作流程

### 3.1 面向用户的对象

- **任务（沿用 Project，不再额外造一套同义 Task 实体）**：我要取得哪些数据、范围与例外是什么。
- **登录环境**：到哪里登录、使用哪个持久浏览器状态、当前准备情况如何。任务引用环境，登录步骤不是业务字段需求。
- **录制/存档**：一次连续现场记录。原始字节、资源、时间与缺口不改写。
- **保存点**：用户对某个现场状态的说明卡片；能关联原始采集收据、字段示例和需求。
- **任务版本**：交给 Agent 的确定目标与材料；用 V1/V2 等显示序号，底层 UUID/hash 隐藏在高级信息。
- **执行与结果**：用指定任务版本、指定实现和环境完成的尝试，包含部分数据、证据与判断。

“任务资料”可以是任务详情中的总览，不再与“保存点”形成两套互不关联的创建流程。原始证据查看器保留为保存点的“查看来源/诊断”，不能是用户保存后唯一到达的地方。

### 3.2 建议布局，不要求换组件库

```text
任务标题 / 当前资料保存状态 / 登录环境 / 开发授权状态
左：保存点列表 + 当前卡片的说明、关联需求和字段
右：实时页面或历史页面；清晰的模式与录制指示
下：历史时间轴（历史模式）或简洁浏览器控制（实时模式）
任务动作：准备环境 / 开始或停止录制 / 记录当前结果 / 交给 Agent
结果入口：当前执行、失败项、数据与来源
```

按目标整合现有组件即可。不要因为减少 tab 就把源码移进另一个巨型组件。`App` 只组合视图与意图；编辑会话、选取、环境和执行分别有明确状态所有者。

### 3.3 必须成立的常用路径

1. 创建任务或先准备环境 → 打开登录页，不开始录制 → 完成人工登录 → 检查/保留环境。
2. 开始示范 → 在页面点“记录当前结果” → 一张保存点立即出现 → 补写说明或添加字段。
3. 点当前保存点的“添加字段/注释” → 点页面元素 → 小型编辑浮层/边栏确认 → 保存；不用填 ID 或切进独立资料管理器。
4. 停止录制 → 页面保留；重新打开存档 → 拖动时间 → 新增/修改/复制保存点，使用同一编辑器。
5. 点“交给 Agent” → 自动处理未保存输入，展示任务摘要和待补项 → 固定资料版本并发出范围授权。
6. Agent 实现 → 用户看到结果数据、覆盖/未核验原因和来源；不是必须自行填写 proof JSON 才能继续。

---

## 4. 登录环境：真正抽离配置与生命周期

### 4.1 拆开三层，不把 Cookie 变成版本内容

| 层 | 必要信息 | 不应承载 |
|---|---|---|
| EnvironmentDefinition | 稳定 ID、名称、登录/进入 URL、允许域、人工登录说明、可选只读完成检查、非敏感配置修订、授权项目关联、storageRef | Cookie、密码、Bearer、任务业务字段 |
| Profile storage | Electron 持久 partition、Cookie/localStorage/IndexedDB 等实际可持久状态 | 任务资料版本、登录成功的永久保证 |
| BrowserSession | environmentId/configRevision、页面、导航代际、当前控制者、临时运行状态 | 必需的 Recording/EvidenceStore 构造前置 |

首批不建设防指纹浏览器、代理管理中心或跨机器会话复制。预留非敏感配置扩展即可。跨项目共享不是默认；同一环境跨项目使用必须显式关联，并且不允许绕过原项目授权读取历史资料。

### 4.2 登录准备是可复用的过程

环境页至少提供：创建/编辑名称、进入 URL、登录说明、打开环境、检查当前状态、保留持久状态、关闭环境。可选完成检查优先复用已有可读页面检查机制，结果包含 checkedAt、scope/origin 与依据。人工标记与独立检查分开；savedAt 只表示保存动作，不表示网站必然仍登录。

更复杂的登录自动化继续用普通代码或既有人工协作，不引入一套新的流程 DSL。默认不把人工登录过程录入业务示范；点击“开始录制”后才形成 Recording，且明确说明此前历史未录制。

### 4.3 必须重构的依赖方向

```text
EnvironmentService → SessionService.open → 页面与人工操作
                                      ↘ RecordingService.start/stop（可选）
                                      ↘ ExecutionService.start（产生自己的执行证据）
```

现在的 `BrowserSessionLifecycle<ActiveRun>` 不足以满足上述方向。先抽出无需 store/capture 的 SessionRuntime/ManagedPage，采集器成为可选附件；不要通过假 recording/store 满足旧接口。

授权针对 project + environment/session + page + capability；需要原件时再明确 recording。停人工录制不等于关闭 session 或撤销所有仍有效的任务授权；人工/Agent 的写控制交接仍受 lease、撤销和取消边界管理。执行应自己建立验证记录，不能要求用户重启人工示范来取得授权。

### 4.4 迁移保护

当前 partition 名是 `persist:bes-${projectId}-${profileId}`。迁移时为旧 profile 建立 EnvironmentDefinition，**storageRef 继续指向原 partition/key/path**；不可换 ID 后拼新 partition 导致用户看起来被登出。默认关联原项目，不自动扩权。升级前记录映射与元数据备份，不复制正在使用的数据库，不移动/上传真实 profile。

环境配置发生变化后记录新非敏感 revision；本次执行记录所用配置 ID/revision，而不是把秘密或全部浏览器数据库塞进 task material hash。

---

## 5. 保存点与实时/历史元素绑定

### 5.1 一种用户保存点，分层存储

保留原始 capture receipt/checkpoint，不原地编辑。新增/复用一个用户层 CheckpointCard 作为说明与关联的唯一编辑对象，保存 `sourceReceiptRef` 或相当的来源关联。

`记录当前结果` 是编排命令，不只是 `appendCheckpoint`：

```text
验证 session/page/generation
→ 在当前 recorder 获取精确且已持久的 source position（必要时建立完整基线）
→ 保存原始采集收据/附件
→ 获取或自动创建本任务工作草稿
→ 创建/返回关联该来源的资料卡片
→ UI 定位到这张卡片的编辑区
```

原件已成功但资料写入失败：返回可恢复的部分成功，保留 receipt 和 operationId，允许幂等重试关联，不删除原件，不重复创建卡片。每一步真实存储边界明确，不能跨两个文件写入假装原子事务。

旧原始保存点首次进入编辑器时按需创建只读映射/派生卡片。只有能依据原始材料确定精确 ReplayPosition 才绑定；只有采集时间区间时标明未定位，允许编辑说明，不能把最近 eventSeq 伪造成原始精确位置。用户可选择一段可还原历史作为新例证，保留派生来源。

### 5.2 实时选取和历史选取共用目的，不共用时间假设

统一 SelectionIntent，至少包括 selectionId、projectId、draftId/expectedRevision、目的（注释/字段）、目标对象 ID、模式（live/history）、session/page 或 ReplayPosition、交互代际。

**实时入口：** 从卡片/字段触发；点击后固化“该次点击的源节点与源位置”，等待 recorder/存储确认，再把 HistoricalElementRef 提交到工作草稿。现有 `__besSampleSelectedNode` 与 `PresentationSample` 已提供基础，优先复用；不能仅将 describe/selectors 文本当成来源。

没有 active Recording 时，允许普通只读检查，但若用户要保存绑定，必须提供明确的“保存当前页面快照作为例证”操作：创建标记为单次取样的最小记录，保存 DOM/必要资源/来源边界；或明确启动录制再采样。不能悄悄录下登录准备全过程，不能在没有原件时显示“已可靠绑定”。

**历史入口：** 点击卡片“注释/字段”后自动暂停并定位 anchor，再在该历史 DOM 上选择，选中后弹出应用拥有的输入框/编辑面板。无需再次让用户从几十个 event ID 找回位置。

### 5.3 当“当前现场”和“旧卡片”不同

旧卡片的 anchor 不自动变化。用户从旧卡片请求实时选取时，默认行为是“用当前页面新增一个示例保存点，并关联同一需求/字段”；也可取消或明确执行“移动卡片”，后者必须标记全部受影响旧绑定待复核。

一个字段定义可有多个示例引用；相同字段的第二次示范不是覆盖第一次。建议新增 FieldExampleBinding（fieldId、checkpointId、target、annotationId?、状态）；旧单 target 作为一条例证读入。来源验收使用实现映射，不能把其中一个示例误当所有行的固定输出。

### 5.4 非侵入式选择与保存

使用应用拥有的透明选择层/高亮层；不要改写业务节点 inline style，避免抹去站点原有 outline 或将工具高亮录成业务变化。overlay 在原生 WebContentsView 上需要统一呈现管理，不能只靠 React z-index。

选择时禁止无关表单/导航操作，保留取消、Esc、保存及紧急停止；实时与历史行为一致。监听单次选择会话，快速多点/导航/切页/过期回执只接收当前合法结果。取消新选择不清掉已有字段绑定，失败不吞已输入说明。

用户可直接：字段说明无元素；元素绑定无注释；元素绑定加注释。字段名默认可由样例提出候选，但需用户确认语义；样例值不是验收常量。

---

## 6. 任务定义、实现映射与可用的编辑器

### 6.1 每个任务有自动工作草稿

用户创建任务/第一次记录资料即拥有工作草稿，无需先理解 draft UUID。默认恢复上次编辑的卡片/字段/滚动位置。版本用 V1/V2 展示，UUID/hash 保留高级视图。

编辑状态独立于 tab 组件生命期。采用自动保存或明确的显式保存协议都可，但本轮建议：输入在任务编辑会话中保持、有限 debounce 保存，切 tab/选卡/发布前 flush；显示“保存中/已保存/冲突/失败”。不得未保存就卸载并丢失值。冲突保留本地 patch 与服务器状态，用户选择重试/合并，不直接 openDraft 清空。

尚不完整的字段/标题可保存在草稿本地编辑会话；不能为了通过最终严格 schema 而丢弃未完成输入。发布/交接再呈现可操作的就绪检查。

### 6.2 修复关联与数据集

给 UI 用的领域命令补齐：`createRequirementWithField`、`linkField`、`annotateCheckpoint`、`rebindExample`、`removeAnnotation`、`promoteCapture`（命名可复用现有服务，不另造平行 API）。

- 关联第一个数据字段时：若 requirement.dataset 未设、全部字段只涉及一个 dataset，可一致地设置它；多个候选不能任意选择，显示需要用户/Agent解释的关联冲突。
- 纯说明型需求可无 dataset，不能误分类成可数据验收的要求。
- field.dataSet、requirement.dataset 和输出映射的关系由服务端校验，UI与Agent接口相同。
- 显式区分 `binding: keep | set(target) | clear`。浏览卡片/重载列表不等于 clear。
- 删除/重绑注释的反向字段关系在服务器全图事务中维护，而不是由当前页列表决定。
- 保存后返回受影响实体与新 revision；保留当前定位。通过 ID 查询详情，不把“未在第一页”当实体不存在。
- 自动草稿与领域命令保持可取消/幂等/冲突提示，不通过吞异常模拟保存。

### 6.3 固定的应该是“任务是什么”，不只是字段集合

给新资料 schema 增加 TaskBrief：目标、数据范围、输出组织、空值/遮罩/去重/完整性要求等。Project.objective 仍可作目录摘要，但 Agent 的规范依据来自固定版本中的 brief。旧 run 可以保留当时 objective 的观察，但它不自动成为任务资料版本的规范 brief。旧 revision 的 hash 不变；旧目标无历史记录时标记未固定，用户确认后生成新版本，不回填成历史事实。

“用户确认此任务版本”“授权 Agent 执行”“人工接受某次结果”分开。确认任务可留一条引用 revision/hash 的人工确认记录，不必重写版本；Agent candidate 可以试跑，但不能冒充用户已确认。机器 pass 继续与结果人工评审分离。

### 6.4 不要求用户编写 sourceProof JSON

采用薄的、可版本化的 TaskImplementationBinding：引用 materialRevision/hash 和实际实现版本，保存 field→输出路径、定位器/网络路径、实体关联、分页终止验证方法等。它是实现映射/验证配置，不是第二套执行 DSL。

用户定义“需要实付金额、要全部订单”；Agent 根据资料生成普通代码和映射；应用显示可读的映射摘要及样例供检查。映射不能删减要求、降低完整性或将 page-displayed 改成任意来源；语义要求变化需新任务候选版本和明确确认。

第一条纵向实现可先使用已有 sourceProof 类型，增加正常的映射准备与确认入口；随后再迁移到独立映射记录。旧内嵌 proof 可以读入映射，不改原 hash。不得为了较易通过就自动补虚假 proof。

验证仍必须解析真实来源、检查实体/范围/时序。未能自动判定显示“未核验/需要人工”，并保留数据及原因，不能把脚本声明当独立通过。让 UI 新建的字段具备数据集身份，不等于未经依据自动判为业务正确。

### 6.5 编辑能力不以“所有历史材料永远可读”为前提

把资料结构合法性、引用身份和来源可用性分层。普通标题/说明编辑可以保留不可用引用并记录状态；新建或更换绑定需要验证新来源；发布和验证报告准确列出不可用项。不能因某个旧图片/录制索引坏了，就阻断另一需求的说明编辑。

来源未验证或坏了时禁止借新版本重新宣称 bound/reliable。可缓存只读固定来源核验结果并按真实版本/哈希失效；不要每次按键重新重建全部历史。先测典型 100/500 卡片的编辑开销，不承诺未经测量的延迟。

---

## 7. 代码落地边界与兼容方案

### 7.1 先抽取必要职责，保留薄 Studio 门面

| 模块职责 | 从当前哪里拆 | 对外保证 |
|---|---|---|
| Environment/Session | Studio Profile、startRun、BrowserSessionLifecycle<ActiveRun> | 无 Recording 也可打开/保存/关闭环境；不产生伪录制 |
| AuthoringCoordinator | 原 saveCheckpoint、material CRUD、实时 sample 接续 | 一个用户命令贯通 receipt→card→example；部分成功可恢复 |
| MaterialEditingSession | App/MaterialWorkbench 局部 state | tab切换不丢输入；当前草稿/卡片/选择意图稳定 |
| SelectionCoordinator | App history intent + coordinator.observe live inspect | 两种来源模式，一个回执目的；非侵入、代际/取消正确 |
| TaskImplementationBinding | workflow proof/验证前置 | 语义版本不可降格，技术映射有版本可核验 |
| Journey runner | 现有 desktop 测试体系的新增场景 | 空数据根、可见 UI 建立任务，用同一 revision 验证 |

不为拆文件追求层数或抽象类。一个调用图与清晰类型即可；同一功能不要保留两套正式创建 API。旧入口可做只读检查/迁移适配，命名为原始采集，不继续作为默认创作入口。

### 7.2 需要更新的文档，而非再堆一层补丁说明

- design：替换项目内只命名 profile、双保存点创建、默认元素页等过期描述；明确本规范的用户路径。
- architecture：更新依赖方向、source receipt/card/example、TaskBrief/ImplementationBinding、session授权。
- implementation-plan：以用户纵向闭环拆里程碑，旧完成记录保留来源和范围。
- api/skill：实时选择固化后的引用、正常资料创建命令、环境准备、固定任务与映射读取；清除相矛盾的旧默认路线。
- status/verification：分别记录低层测试通过、产品旅程通过、真实资料验证、用户确认。旧 377 项记录不删除，也不能继续作为新产品完成证明。

### 7.3 迁移必须可撤回

1. 只盘点存在的格式，不支持假想的全部历史版本。先备份 workspace/material 元数据与原始 hash清单。
2. profile→environment 采用映射；不改变现有 storageRef，不共享秘密，不复制运行中 DB。
3. 老 raw checkpoint→用户卡片只做派生；未知 anchor 有明确状态，禁止造精准时刻。
4. 老 field.target→一条 example；重复迁移幂等。旧 revision 永久只读、旧 hash仍可校验。
5. TaskBrief/新dataSet关联由新的草稿/版本补齐；旧不确定关系不得静默解释为唯一正确含义。
6. 迁移输出计数、转换/未转换理由和回滚入口。实际录制只读测试或副本中测试，未授权不修改用户真实档案。

---

## 8. 实施次序与模型职责

### M0：先形成完整的最小用户流程，而不是再次仅冻结类型

Astra/high 为本轮产品/架构负责人，并直接实施下面 M1。先复核 P01–P13、写一页状态/命令对照与新验收失败点，纠正不成立的发现，不重复全仓历史审查。

M0 不应消耗成多小时文档工程。更新最小设计并写关键 regression 后马上进入 M1。初期允许一个只读检查者审产品路径与迁移边界；不同时放三个实现者各造一套对象。

### M1：第一条必须真实可用的纵向路径

空应用 → 创建/打开独立登录环境（未录制）→ 普通 UI 开始示范 → 记录当前保存点 → 实时选择元素添加字段（无注释）→ 同一保存点列表可见 → 停录 → 存档中仍可定位原节点 → 修改说明 → 固定任务版本 → 根据这份 UI 资料实施/验证两条合成记录。

同时修 P04/P05/P06；测试要验证刚从 UI 新建的数据关系，不从另一 fixture 借成功结果。M1 完成必须演示真实窗口路径并由独立检查者重复；在这一产品门未过之前，不跑多轮发布打包/长测来积累“完成证据”。

### M2：纵向骨架通过后再并行

- E流（Sol/high）：环境管理完整交互、旧 profile 映射、登录检查与会话授权；独立文件所有权。
- A流（Sol/high）：资料编辑/关系事务/分页/dirty恢复/旧保存点派生，沿 M1 唯一对象而非另建 UI。
- V流（Sol/high）：实现映射、结果解释、新任务交接与普通代码试跑；不修改需求语义获取通过。
- Astra负责人：共享契约与首条流程完整性、跨边界高风险修改，不逐个转发日志/代跑 Git。若只有一两个独立包就不用填满三槽。

初步骨架与模糊产品取舍用 Astra/high；清晰实现包用 Sol/high；特别困难的状态/迁移问题才临时 xhigh。不要默认用 Ultra 增加层级，也不要在子任务启动时把全部旧会话复制过去。模型与effort在实际工具生效并记录，不靠提示词自称。

### M3：用户路径、代表性页面与发行验证

执行 09 的所有阻塞旅程；原用户录制须本地只读检查并经授权，不得未查就归为站点特殊。随后受影响底层回归、完整桌面与实际包；更改采集/资源/执行稳定性时重跑相应长测，并按确切候选关联证据。

**本轮默认执行到 M1 产品门后给出可运行成果和演示，等待用户确认核心交互。** 这是避免再次自动跑十小时但方向仍偏的明确产品检查点，不是把每个 Git 提交交给用户确认。用户明确授权后再自动完成 M2/M3。

---

## 9. 主要来源（均为已读取的原始代码/文档）

下列仓库 URL 全部固定到本次审查基线；行号可变时以函数名定位。它们不是要求 Agent 每次全量读取。

- **[S01]** `docs/progress.md`：当前回放/实时采样补丁的测试与未测范围。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/docs/progress.md
- **[S02]** `src/renderer/app.tsx`：App；panel conditions、实时选择状态条、保存点/资料分区、执行/环境入口。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/renderer/app.tsx
- **[S03]** `src/renderer/components/material-workbench.tsx`：组件 state、beginSelection、mutate、openDraft。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/renderer/components/material-workbench.tsx
- **[S04]** `src/renderer/components/material-workbench.tsx`：selectCard、saveCard、saveRequirement、saveField、saveAnnotation、removeAnnotation。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/renderer/components/material-workbench.tsx
- **[S05]** `src/renderer/components/material-workbench.tsx`：表单 JSX、历史绑定说明、JSON rules/sourceProof 及发布入口。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/renderer/components/material-workbench.tsx
- **[S06]** `src/main/services/studio.ts`：Profile、authorizeTask、authorizedOperation、Project.objective。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/main/services/studio.ts
- **[S07]** `src/main/services/studio.ts`：createProfile、startRun、saveProfile 及 session 构造。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/main/services/studio.ts
- **[S08]** `src/main/services/browser-session.ts`：BrowserSessionLifecycle<Runtime> constructor/attach/detach。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/main/services/browser-session.ts
- **[S09]** `src/validator/service.ts`：ValidatorService.validate：names、requirement.dataset、per-row outputPath。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/validator/service.ts
- **[S10]** `src/materials/validate.ts`：validateContent：field/requirement数据集、注释和卡片反向引用。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/materials/validate.ts
- **[S11]** `src/contracts/materials.ts`：MaterialContent、TaskMaterialDraft、TaskMaterialRevision。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/contracts/materials.ts
- **[S12]** `src/materials/service.ts`：checkRecordingRefs、updateDraft、publish、pageCollection。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/materials/service.ts
- **[S13]** `src/capture/coordinator.ts`：observe、pointermove、__besSampleSelectedNode、实时选择。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/capture/coordinator.ts
- **[S14]** `test/desktop/refactor-workbench.ts`：预设 WorkbenchFixture、UI新增字段与fixture.executionId结果读取。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/test/desktop/refactor-workbench.ts
- **[S15]** `test/desktop/refactor-handoff.ts`：runLiveHandoffScenario 通过dispatch预建dataset、sourceProof及分页proof。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/test/desktop/refactor-handoff.ts
- **[S16]** `docs/refactor/01-modification-plan.md`：设计意图、数据/用户UI分层、BrowserSession独立和旧AT。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/docs/refactor/01-modification-plan.md
- **[S17]** `docs/refactor-handoffs/G4-20260926.md`：D07/ee904cd真实候选测试与新Agent验收范围。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/docs/refactor-handoffs/G4-20260926.md
- **[S18]** `docs/design.md`：原始项目/profile范围与产品目的；独立环境配置的描述不足。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/docs/design.md
- **[S19]** `src/main/services/project-materials.ts`：ProjectMaterials.edit为upsert传递，不补requirement.dataset；MaterialSummary始终candidate。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/main/services/project-materials.ts

- **[S20]** `src/materials/edit.ts`：copyCheckpoint/moveCheckpoint/removeCheckpoint 的来源与关联语义。https://github.com/ghostroller/browser-evidence-studio/blob/97d6623d8028bdef9008a52a0f965e8d82187c74/src/materials/edit.ts

官方模型资料（2026-09-27核对）：

- [O1] Astra 定位与支持的 effort：https://developers.openai.com/api/docs/models/gpt-6-astra
- [O2] Sol 定位与支持的 effort：https://developers.openai.com/api/docs/models/gpt-6-sol
- [O3] Codex模型/Ultra：https://developers.openai.com/codex/models
- [O4] 子任务模型/effort与用量边界：https://developers.openai.com/codex/subagents

模型分工是针对本项目的工程建议，不是模型对比实验。更强模型不能替代明确用户行为与独立产品验收；本次失败也不证明 Sol 无法写复杂代码。
