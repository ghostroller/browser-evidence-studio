# Browser Evidence Studio：E01–E04 后审查与 M1 收口计划

审查基线：`ac49fdedf2c1e5880ab8c9dc071801640f569c9f`（下称 ac49fde）。本地报告的实测构建为 `dc78b3d3dad2c12426cf43f86bba492d022bec06`，其后的差异仍需执行者核对，不因本文引用就回退后续提交。

本文件补充 `08-product-realignment.md`、`09-user-journey-acceptance.md` 与最新 E01–E04/独立复走报告。它不重启旧 A–G、Q1–Q6 工作流，不替代原有权限、隐私、取消、原件完整性规则。

## 0. 执行摘要

**结论：E01–E04 的修复方向应保留，M1 仍不应判为通过。当前最明显的阻塞是缺少“页面原始值—显式转换—输出类型—独立核验”的一致契约；同时还有采集前未处理 dirty 编辑、批量编辑目的混用和中断采集恢复的缺口。**

下一轮分三包，不按每个小提交唤醒一层主控：

1. **T1：类型与来源语义。** 修 J01；补明确的映射兼容检查、最小数值转换、三态判定和诊断。旧规则不暗改。
2. **T2：编辑与中断恢复。** 修 J02–J04；通过真实组件/服务的负例，不只测试抽象控制流。
3. **T3：产品收口。** 完成 J05，核实 J06；在同一 UI 创建的任务上复走数字字段、故障组合、登录失败/过期、结果回到来源，最后进行独立复走。

完成 T1–T3 后交付可运行的开发版本并暂停供用户确认核心交互。用户确认前不自动开展完整环境平台、通用转换 DSL、跨项目环境共享、全面长测和发行打包。

本文未在用户 Windows 上运行测试，没有访问其原录制、profile 或日志字节。已核对 GitHub 代码和交接文档；“源码确认”表示给定前置状态下存在具体控制流，不等于已经在 Electron 上复现。最新报告明确记载的独立 U06 失败与未测项，应保留原文。

## 1. 当前结果如何解释

| 范围 | 应保留的结论 | 不应外推的结论 |
|---|---|---|
| E01/E03 | 发布前使用 dirty 编辑快照和批量 CAS；旧项目初始化/回执增加归属检查 | 单批 CAS 不自动保证每个子编辑仍关联原本的业务对象；未覆盖所有触发入口 |
| E02 | 增加 authoring operation 身份、阶段与查询；重试保留目的和字段 ID | 有阶段名不等于重启后能够识别已经消失的执行者 |
| E04 | 普通 session 页面命令不再普遍依赖 active run；无录制审计已有独立路径 | 模块测试和一次重绘操作不替代登录失败、过期、关闭/取消组合 |
| 独立复走 | 保存点、字段、版本与重启回读获得真实证据；没有把字段改成字符串来求通过 | 三个变体都 fail 不能算“错误值被正确识别”，更不能宣布 M1 完成 |
| 原件与旧版 | 报告记录 8 个原件及 V1/V2 hash 未变 | 不代表本轮已测试所有原件、所有历史或所有账号环境 |

实际独立报告：`docs/refactor-handoffs/PRODUCT-M1-INDEPENDENT-20260927.md`。正确数值、错误数值和缺来源三组均为 schema pass/source fail，原因相同。数值核验缺口不是 E01–E04 新增的比较逻辑：相关 validator/proof 契约仍沿用旧的精确文本规则，本轮独立输入才暴露它与 UI 任务类型的冲突。

## 2. J01：数值字段与 DOM 来源映射不兼容，但仍可被确认和执行

**级别：M1 阻塞；独立报告与源码链路相互印证。**

### 2.1 事实与根因

代码：

- `src/contracts/workflow.ts`：`DomTextSourceProof` 只有来源 URL、语义属性、实体属性/路径，没有值转换契约。
- `src/main/services/implementation-mapping.ts`：`implementationMapping()` 解析 outputPath/sourceProof、检查资料 hash 和确认版本；没有检查 field.valueType 与 proof 输出语义是否相容。
- `src/validator/service.ts`：字段类型独立按 valueType 检查，所以数字输出可以通过 number 类型约束。
- `src/validator/proofs.ts`：`displayedFieldProof()` 在扫描任何来源之前要求输出值与实体 ID 都是字符串，否则直接 fail。

因此：字段设为 number、来源设为 page-displayed、映射是旧 dom-text 时，45 不满足字符串规则；即使来源是原样 `45.00`，也会失败。没有 sourceRefs 时仍先因同一类型规则失败。

这不是“把 === 改成 ==”能正确解决的问题。旧 dom-text 的精确文本语义本身有效：`￥12.30` 与 `12.30` 不应在没有声明转换时自动相等。项目现有 `test/unit/dom-source-proof.test.ts` 已明确检验这一点。

### 2.2 补齐的产品契约

区分四件事：

1. **源观察**：当时真实显示的字符串，例如 `45.00`，附带原节点/时间/实体身份，原件不改。
2. **字段语义**：用户需要实付金额，按元输出为数值。类型和单位不是为了测试通过而可被 Agent 任意更改的内容。
3. **实现映射**：提出明确的“原样文本”或“按已声明规则解析为数值”，由宿主识别并独立执行。
4. **核验结论**：输出类型合规、来源可用、转换适用、转换后的值一致，应分别说明。

`sourcePolicy=page-displayed` 应约束依据来自页面显示，不能单独被理解为“输出永远必须是字符串”；原样保留字符串由明确的值解释模式约束。历史未声明新模式的 dom-text 仍采用旧精确文本规则。

### 2.3 最小实现路径

A. 在现有 proof/mapping 上增加一个**可版本化、封闭集合**的值解释字段。名称由实施者与共享契约统一；例如可选 `valueConversion: { kind: 'plain-decimal', version: 1 }`。未设置时保留旧 exact-text，不进行读取时回填，避免旧资料 hash 变化。

B. 新增小型纯函数：映射兼容检查、纯十进制文本解析与比较。第一版覆盖本轮真实需求即可，不提供任意 JS、正则脚本、表达式链或运行时 LLM 判断。

C. 在映射预览/确认复用兼容检查：

- number + 旧 exact-text：明确提示缺少数值映射，不能显示为已就绪的可核验配置。
- number + plain-decimal v1：可进入后续取证核验。
- string + exact-text：继续严格原样比较。
- 尚未提供映射的普通任务草稿可以保存；不能因为缺实现就阻止用户描述需求。
- 启动正式核验前再检查实际固定版本。探索性试跑可以独立允许，但不能因此声明业务核验已可用。

D. 校验器使用**已采集的原始显示采样**重新解析，不信任脚本自报的 parsedValue/normalizedValue。继续验证来源所属执行/attempt、页面、frame、时间、可见性、实体和语义属性；不得从当前网站或回放 DOM 重取来替代原件。

E. 映射 UI 展示用户能理解的摘要：源示例 `45.00`、输出 number、纯十进制解析、保留源文本、不去除单位/千分位。普通用户不手写 proof JSON。

### 2.4 plain-decimal v1 的边界建议

- 只接受事先写明的完整十进制语法，例如可选正负号、整数及小数；明确是否允许首尾空白，不接受部分前缀。
- `45.00 → 45`、`12.30 → 12.3` 是数值解释，不是原件改写。
- 不使用 parseFloat 读一半字符串；不全局剥除非数字；不猜逗号是千分位还是小数点；不默认把百分比、币种、万/亿单位或括号负数转换。
- 空串、遮罩、`—`、混合多个值不得变成 0 或猜测数值。没有足够解释规则时保留未核验原因。
- 限制输入长度与数值范围；排除非有限值，保守拒绝超安全整数或十进制往返会丢失精度的值，不用 epsilon 掩盖差异。可通过有界十进制规范化检查源文本与输出数字的可逆表示，不必建设通用高精度运算平台。
- 实体 ID 与字段值分开处理。`"0012"` 不自动变为 `12`；默认实体仍按原身份精确匹配。
- 有格式化金额等额外明确需求时，再新增受限规则并测试；不靠放宽 v1 意义偷偷扩大支持范围。

### 2.5 三态与历史兼容

| 前置 | 输出/来源 | 应得结果 |
|---|---|---|
| 数值映射兼容且依据完整 | 来源 `45.00`，输出 45 | 类型 pass、来源 pass |
| 同上 | 来源 `45.00`，输出 46 | 类型 pass、来源 fail，指出真实值差异 |
| 同上 | 输出 45，真实 sourceRefs=[] | 类型 pass、来源 inconclusive |
| 同上 | 输出字符串 `"45"` 而任务要求 number | 类型 fail；来源原因另列，不因缺来源把已证实类型失败降为未知 |
| 未声明数值解释 | number + 旧 dom-text | 映射不兼容，不伪装成已观测到数值错误 |
| 旧 exact-text | 源 `￥12.30`、输出 `12.30` | 旧行为继续 fail |
| 数值映射 | 来源缺失/遮罩/不适用语法 | 不凭脚本值推断正确，报告明确未核验原因 |

已经保存的 V1/V2/V3 与旧报告不改。对现有失败任务，保留“数值字段”和原始目标，从当前固定版派生草稿，正常 UI 确认新映射形成新版本，再复跑。报告保留 validator/ruleset 标识或等价兼容信息；旧格式报告没有标识时明确 legacy，不假定新语义。

**禁止**：把 number 改 string、全局 `Number()`/宽松相等、缺证据自动 pass、修改原 sourceRefs/采样/旧报告、以全部 fail 当作负例成功。

## 3. J02：新增采集会覆盖未保存的卡片编辑

**级别：高；源码存在明确覆盖路径，尚未在 Electron 复现。**

`MaterialWorkbench` 的切卡通过 `changeEditor()` 保存 dirty 输入，`recordCurrent()` 和 `beginLive()` 却没有先处理 dirty 卡片。采集成功后，`recordCurrent()` 直接设置新的 cardId/title/notes/requirementIds。

复现序列：

1. 打开已保存卡片 A，修改标题或说明，不点保存。
2. 点击“记录当前结果”；也检查“添加所需字段（实时页面）”。
3. 采集返回卡片 B，编辑器切到 B，原 A 的未提交标题/说明已被覆盖。
4. 返回 A 或重启检查；新 localStorage 快照可能已经保存了 B 的表单，不能指望浏览器缓存恢复 A。

`pending` 只能阻止采集期间输入，不能保护采集开始前已有的 dirty 内容。不能把“新卡片成功保存”当成所有旧编辑都已保存。

### 修正路径

- 为采集开始前的编辑处理建立一个入口。旧卡片已完成且 dirty 的说明/关联先提交，失败就不切换上下文。
- 尚在创建的字段可能必须先选元素，不能一律强制保存所有未完成表单。保留其编辑缓冲和明确目的；不要因字段描述尚空就禁止选择。
- 分别保存 oldCheckpointId、fieldEditingIdentity、requirementId 与本次新样例身份；采集回执只更新本操作需要的部分。
- 进入选择、取消、采集失败、关联 partial、恢复重试均不能覆盖旧卡片缓冲。
- 桌面负例验证 A 的旧编辑、B 的新原件和 F 的新绑定各自正确，不只检查“已保存”提示。

## 4. J03：一批事务内仍混用了“字段所属需求”和“新建关联需求”

**级别：高；源码可确认目的覆盖，需真实组件/服务负例定界。**

`saveEditor()` 比旧版串行保存更好，但只有一个 `nextRequirement` 局部变量。

- `parts.has('link')` 时，将该变量替换成新建的卡片关联需求 R2。
- 同批 `parts.has('field')` 时，把当前编辑字段 F 放进这个变量的 fieldIds。

普通操作可以同时产生两种 dirty：在卡片“新需求含义”里输入 R2，再在当前选择的 R1 下编辑/填写 F，直接发布。事务虽然原子，F 却可能被关联到 R2，而不是用户在字段区域选择的 R1。对于已有字段，可能新增一个意外共享关系；对于新字段，则直接进入了错误的需求。

### 修正路径

- 使用不同对象：`fieldOwnerRequirementId`、`requirementEditorPatch`、`newLinkedRequirement`、`checkpointLinksPatch`。事务对象的归属先固定，不能由处理顺序推断。
- 如果用户选择把新字段放入“这次新需求”，应有明确 UI 选择并使用事务内临时身份；否则字段继续属于当时明确选择的 R1。
- 合并同 ID 的 patch 时，在服务端或单一事务 builder 中处理已知关系，不再由两个 upsert 的先后顺序决定最终结果。
- 发生数据集或关系歧义时拒绝本批并保留输入；不悄悄关联到别的需求来通过校验。

负例至少包括新/已有 F，R1 原来有其他字段，R2 只用于当前卡片，最后检查 R1/R2 与卡片的完整关系以及旧字段未被删除。

## 5. J04：应用中断后的 acquiring 操作可能永久阻塞编辑

**级别：高；真实崩溃组合未测，当前恢复路径缺少执行者存活判断。**

`Studio.captureAndAuthor()` 在实际 checkpoint 前将 operation 写为 `acquiring`。`authoringOperation()` 会搜索已落盘 receipt，但未发现时直接返回存储阶段，没有在该路径判定旧 app/session 的采集者是否还存在。

前端 `recordCurrent()` 查询到 `acquiring`/`unknown` 就不再采集；`beginLive()` 和 `changeEditor()` 又拒绝未完成旧操作，material-layout 进入 inert。

因此，在 acquiring 持久化之后、receipt 完成之前进程退出，重开后可能只有永远返回 acquiring 的旧操作，而没有任何能够使它完成的进程。

### 修正路径

1. 采集 operation 记录宿主 appInstance/session/operation 身份，并在内存登记实际执行任务；进度查询区分“原执行者仍在运行”与“仅磁盘阶段尚未收口”。不要只靠 PID，避免复用。
2. 先根据原始 receipt/operationId 查清是否已经保存，再作恢复决定。保存且身份一致则允许关联；明确没有 receipt 且旧执行者已结束，则标 source-expired/interrupted 等终态，允许新操作。
3. 原件读取失败不能被当作“肯定没保存”；保留 unknown 及错误，提供明确的保留旧操作、离开此恢复面板/编辑其他对象的路径，不把整个资料工作区永久封锁。
4. 真正仍在执行的操作不能因查询超时就当死掉重采；使用当前任务登记/取消回执决定。
5. 保留 journal、部分 artifact 和原件，不通过删除 journal 清除异常，也不在封存 run 中自动继续写入。

测试边界：意图写入后、acquiring 后、artifact 已写而 receipt 未落、receipt 已落而关联未落、关联已落而 journal 最终状态未落。能按同 ID 完成的重试不重复采集；不能恢复原现场的请求明确终止。

## 6. J05：结果页不能只输出内部 ID 和 fail；还需要定位与覆盖语义

**级别：M1 用户流程缺口；不是本轮新引入的回归。**

当前 `ResultCenter` 主要显示 requirementId、check.name/reason、evidence JSON。组件仅接 projectId/executionId，没有回到具体保存点/历史节点的导航契约。独立报告把“结果直接跳转保存点”列为未测；从当前代码看，它至少不只是缺一项测试，还需要补实际入口。

### 最小实现

- 读取该 execution binding 所固定的资料版本，显示需求描述和字段名；不要拿当前最新草稿冒充当时任务。
- 为有界诊断保留 fieldId、entity key、dataset/attempt/batch/recordIndex、outputPath、实际来源引用、解释模式与结果。
- 区分两类链接：**“需求示例”**回到该固定版本的 checkpoint；**“本次验证来源”**回到此次运行实际 source ref/节点。示例里的值不是本次结果的验收常量。
- 数值例子显示原始 `45.00`、规则 plain-decimal v1、期望 45、实际 46；缺来源则只显示不可比较，不伪造期望值。
- 失效/缺材料时解释具体位置和原因；分页按需取，不一次加载全部正文。普通输出按现有隐私策略处理。
- 报告原因使用稳定 code，UI 可读中文说明。不要要求用户先理解 source:<uuid> 或手工查 JSON。

### “覆盖 complete” 的限定

当前 `ValidatorService` 在 dataset.complete 且没有分页规则失败时可给 coverage=complete；没有分页规则时该检查集合为空。这可以说明已提交数据全部读完，不能一般性说明自然语言“全部订单”已经满足。

本轮不引入自动自然语言证明器。把“批次提交完整”“声明的字段/类型检查”“业务范围已核验/尚未配置”分开呈现。至少给已有 min-rows/unique/分页规则提供必要的普通 UI 配置或明确范围缺口，不能只靠脚本 complete 提升全量业务判断。

增加负例：明确要求两项的数据只返回一项，或两项重复；不能得到与全量正确输出同样的业务完整结论。真实全量条件未提供足够证据时应未核验，而不是自动猜测。

## 7. J06：已知未测体验应作为 M1 收口，不另开环境平台

- 登录检查失败、登录过期/被站点退回登录页尚未独立验证。先测当前支持的普通检查和重开流程；unknown 不能被界面写成 verified，检查失败不能抹掉已保存 profile，也不能误诊为抓取业务值不匹配。保留原 storageRef/partition。
- 独立报告出现长表单滚轮不动、需要 Tab 导航的观察。根因尚未确认，不按“已经证实 CSS 错误”修复。检查真实窗口 min-height/overflow/原生视图遮挡和滚动容器，在鼠标滚轮可用前不能把 Tab 绕行算普通交互通过。
- E02/E03 模块验证保留价值；至少补选择过期→重选、关联 partial→恢复、切项目迟到回执和中断恢复中的真实桌面代表场景。
- 连续窗口证据最大间隔约 6.7 秒和采集警告按原报告保留。证据视频只是观察材料，持久数据和来源身份仍要独立回读；不以更多录像时长代替正确断言。

## 8. 下一步工作包、所有权与完成门

### T1：先使数值业务成为一个受支持的普通路径

唯一 owner 覆盖 workflow proof 类型/解析、material 校验、implementation mapping、validator 与必要预览。先提交小型契约决策和测试表，再实现；禁止其他流同时另造转换模型。

通过条件：新数值映射在模块和 producer→consumer 测试中得到 pass/fail/inconclusive 三分；旧 exact-text 用例和旧 hash 保持；number+exact-text 提前给出映射错误而不是静默确认。

### T2：编辑和采集恢复收口

可与 T1 的纯验证核心并行，但 MaterialWorkbench、Studio authoring、result-center 等各文件保持单一写入 owner。先修 J02/J03 的真实组件服务测试，再修 J04 中断状态；共享契约在集成前统一。不新增 Git/传话 Agent，不递归委派。

通过条件：dirty 旧卡片不丢；F 的所属需求不依赖 patch 执行顺序；重启后的孤儿 acquiring 能明确收口；既有 E01–E04 负例继续通过。

### T3：诊断与独立复走

接 J05/J06，使用已冻结的当前构建。先对本轮独立失败材料只读定位，在隔离副本或新版本上修正映射；再从空 BES_DATA 进行一次普通 UI 旅程。

明确保留：字段“数值”的业务语义；同一任务的真实资料关联；非“实付金额”这个特定名字也能工作。不依赖 demo implementer 写死字段名/selector。独立执行者只读正式交接和公开 API/skill，不能读取实现答案。

通过后给用户可运行入口、短操作说明、当前源提交/构建指纹与连续证据。**不要求用户先认可失败的 M1 才能修这些已知缺陷；但完成后的核心交互仍需要用户确认。**

### 接下来才安排的工作

用户确认 M1 后再规划多例证实体、完整环境配置与显式复用、资料规模/迁移、生产分发及受影响长测。保留原有 U07–U24 未完成清单，本轮不借“后续任务”吞掉已经影响 U01–U06 的编辑或核验问题。

## 9. 回归清单（必须报告实际范围）

| ID | 用例 | 预期 |
|---|---|---|
| C01 | UI number + page-displayed；旧无转换 dom-text 预览 | 明确不兼容；不能确认成已可核验 |
| C02 | 明确 plain-decimal：45.00→45 | pass，原字符串仍可查看 |
| C03 | 同来源45.00，输出46 | fail，由值不一致触发 |
| C04 | 合规number输出，sourceRefs=[] | source inconclusive，不能因类型一律 fail |
| C05 | number任务实际输出string | schema fail，不以来源缺失掩盖 |
| C06 | 旧exact-text：￥12.30对12.30 | 保持旧fail，旧hash不变 |
| C07 | 空白/遮罩/千分位/单位/非有限/溢出 | 按声明边界未核验/映射不支持，无隐式0或部分解析 |
| C08 | 实体0012与12 | 默认不合并身份 |
| C09 | 编辑A说明未保存→记录B→返回A | A编辑保留/已保存，B独立 |
| C10 | 未完成新字段→选实时元素 | 不被无关强制保存阻断；目的和输入正确恢复 |
| C11 | R1下字段F dirty + R2新关联文本 dirty→发布 | F仍归明确选定的需求，不由nextRequirement覆盖 |
| C12 | 原本R1有F0，编辑F与新增R2 | F0、R1原关系、卡片新关系全部正确 |
| C13 | 来源过期→重新选择 | 新身份正常，旧未采集请求不反复使用 |
| C14 | receipt保存后关联失败→重试→重开 | 同receipt/同操作，无重复采集；保留field目的 |
| C15 | acquiring持久化后强杀且无receipt | 原执行者结束被识别，非永远inert |
| C16 | receipt已有但journal未收口强杀 | 发现原receipt、幂等关联，不重采 |
| C17 | 读取原件失败且无法判断receipt | 明确unknown，不当未采集；不永久锁住无关编辑 |
| C18 | 旧项目回执在新项目加载后到达 | 不清空、不串写、不抢回草稿 |
| C19 | 结果→固定任务示例→本次来源 | 各身份、版本、时间准确，未借最新草稿 |
| C20 | 明确两项要求只输出一项/两条重复 | 非业务全量通过；说明缺口/失败 |
| C21 | 登录失败、正常保留重开、过期重登录 | 状态真实、partition不变、可恢复工作 |
| C22 | 长字段表单鼠标滚动与键盘导航 | 控件可达，原生视图不吞掉应用滚动 |
| C23 | 新名数值字段完整U01–U06，正确/错误/缺来源 | 同一UI资料，真正三分结论 |
| C24 | 重启回读本轮固定版本、目标、原件 | 指向一致，旧版/旧原件hash不变 |

包内先定向测试；共享契约/集成点跑受影响全量单元与 typecheck/build。桌面和物理输入串行；完整日志落盘、只汇报摘要与有效错误。修复后各用例明确写 pass/fail/not-run/blocked，不能把模块通过写成独立产品验收通过。

## 10. 来源定位与证据限制

以下路径均以 ac49fde 为准，可在本地按函数核对。本文没有创建新的项目测试通过记录。

- `docs/refactor-handoffs/PRODUCT-M1-INDEPENDENT-20260927.md`：独立UI过程、数字类型、三次fail、未测与原件保护。
- `docs/refactor-handoffs/PRODUCT-M1-E01-E04-20260927.md`：E01–E04实现与已有模块/桌面证据范围。
- `src/contracts/workflow.ts`：DomTextSourceProof、FieldSourceProof、解析入口。
- `src/main/services/implementation-mapping.ts`：implementationMapping 的预览/确认与缺少兼容检查。
- `src/validator/proofs.ts`：fieldProof、displayedFieldProof。
- `src/validator/service.ts`：field-type、source检查与coverage计算。
- `test/unit/dom-source-proof.test.ts`：旧精确文本与来源身份安全用例。
- `src/renderer/components/material-workbench.tsx`：saveEditor、changeEditor、recordCurrent、beginLive、按钮dirty标记。
- `src/main/services/studio.ts`：authoringIdentity、recoverAuthoringReceipt、authoringOperation、captureAndAuthor、session action/snapshot。
- `src/renderer/components/result-center.tsx`：当前诊断展示、固定资料标识和导航缺口。
- `docs/refactor/08-product-realignment.md`、`09-user-journey-acceptance.md`：产品目的、同一UI资料验收和U01–U24边界。

若后续代码已经消除某问题，用新的准确提交和回归证据关闭，不重复修改。不得为了符合本文的猜测而新增无必要抽象；但本文给出的具体负例不能仅凭原happy path通过而忽略。
