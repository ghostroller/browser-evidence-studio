# Codex 执行指南：模型、工作包、独立会话与提示词

**日期：2026-09-26｜配套规范：`01-modification-plan.md`**

把这两份文件放入目标仓库的 `docs/refactor/`。本文件安排执行；产品目标、类型语义与 AT 验收以主文档为准。模型能力分工是针对此项目的工程判断，不是官方对该仓库的测试结果。

## 2026-09-26 主控协议更新（用户授权，替代手动启动安排）

S0 已完成，共同起点为 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`。保留本指南 §3.1 及 S0 handoff 的历史提示和当时事实；其中“用户另开会话”的安排自本次指令起由本节替代，不要求用户复制提示词或搬运结果，也不重做 S0。

- 当前主任务是完整重构的主控与集成 owner：自行启动、跟进、审查、返修、串行集成 A/B/C → D/E/F → G，直到已授权工作闭环。派发不等于交付，子任务完成不等于集成通过。
- 先检查主目录、工作树、分支、HEAD、未提交修改和已有任务。复用本次 `20260926-A/B/C`，不重复创建、不 reset 到共同起点；D/E/F 等仅从已验证的集成提交新建并记录具体 base。
- 优先原生 `collaboration.spawn_agent`，独立上下文 `fork_turns=none`，通过真实参数设置指南模型/effort（A/C Astra xhigh，B Sol high；后续同 §2.3）。每流先复核绝对 workdir/branch/base/status，再写入；原生 Agent 共享文件系统，所有命令显式工作目录，创建 Agent 本身不是文件隔离。
- 最多三条主要实施流；不自行嵌套新建可写实施流。根任务独写共享契约、根配置/锁文件、集成入口和调度状态；E 接入时由根明确转交 main/dispatch/preload 所有权，避免双写。其他流写自己的目录和 handoff；契约改动先报根，由根提交后通知依赖流。
- 每流独立安装 node_modules，并使用自己 BES_DATA/output/连接文件/profile。桌面、物理输入和长测须向根申请独占测试时段，根串行执行或授权；不以多 Electron 争抢环境的结果验收性能。
- 只有原生能力实际不适用时，才在核对本地版本/帮助后使用受控 `codex exec` 后备，显式 cwd/权限/日志并记录准确 session ID；禁止 `--last`、绕过安全检查、全局配置变更、额外付费 API 或另造通用调度平台。
- 每次接续先读 `docs/refactor-status.md` 和各流 handoff，再按记录的 canonical agent ID 查询原生状态；仍在运行的任务只发消息，不重复启动。原生上下文已消失时，核对现有分支/未提交修改/提交后，才以新 ID 在同树接续并记录替代关系。
- 根检查具体提交、差异和证据，仅串行集成已审查的小包，真实运行受影响测试和最终系统验收。保留原始失败记录，不删断言、不吞异常、不跳 UI、不改历史原件求通过；不自动 push、删除工作树/分支/录制。阻塞部分登记，其余继续推进；仅真实权限/登录/额度、必须人工场景或不可逆业务决策向用户提出最小请求。

实际任务 ID、启动参数、基线、提交、测试、阻塞及下一动作只由根记录在状态文件；此协议不降低功能目标、文件所有权、安全边界或 AT 验收标准。

## 1. 模型建议

### 1.1 已核实的官方选项

截至核对日，OpenAI 官方资料列有 `gpt-6-astra`、`gpt-6-sol` 和 `gpt-6-luna`；Sol/Luna 已进入 ChatGPT Work/Codex，区别于普通 Chat 对话的模型菜单。这里不推荐第三方模型、非官方路由或只能用 API 而无法通过 ChatGPT Codex 使用的选项。实际能否选择仍受账户、客户端、灰度和工作空间设置影响。[M1][M2]

Astra 定位于最难的端到端工作；Sol 面向复杂编码与 Agent 工作；Luna 面向边界清楚、可重复的任务。[M1][M3–M5] 推荐用法：

- **只选一个模型完成全部任务：GPT-6 Astra，High。** 在事件时序、frame 身份、取消与权限、最终审查阶段提高到 Extra High。
- **兼顾成本和可靠性：Astra 承担复杂核心，Sol 承担契约明确的功能实现，Luna 只承担小而明确的辅助任务。** 不把架构、数据迁移、源信息保真或权限设计交给低成本模型独立决定。
- **不默认全程 Max/Ultra。** 额外推理不是缺失代码、测试环境或权限的替代品。Ultra 涉及自动任务委派，不只是单 Agent 更长思考；已经手动分 worktree 时，应避免不受控的二次可写并行。[M1][M7]

本指南使用 `medium / high / xhigh`，其中 `xhigh` 对应 Extra High。Astra、Sol、Luna 的官方模型页支持这些 effort；Codex 使用当前模型/客户端实际列出的档位。[M3–M6] “GPT-6 Pro”是 Chat 中的产品显示名，本地 Codex 本方案使用 `gpt-6-astra`，不要自行拼造 `gpt-6-pro` 模型 ID。

### 1.2 每个修改点的默认分配

| 任务 | 推荐模型 | 思考强度 | 分配原因 |
|---|---|---|---|
| T00 基线、契约、风险贯通原型 | GPT-6 Astra | **xhigh** | 需要同时协调历史事实、新目标与跨模块不变量 |
| T01 浏览器/session 生命周期 | GPT-6 Sol | **high** | 目标明确，但需保留页面、租约与取消语义；S0 由 Astra 一并做亦可 |
| T02 录制、队列、耐久与缺口 | GPT-6 Astra | **xhigh** | 事件丢失、时序、恢复和真实性高度耦合 |
| T03 离线资源捕获与映射 | GPT-6 Sol | **high** | 可按清晰资源契约实现；复杂缓存/frame 问题升级 Astra high |
| T04 分段回放与随机定位 | GPT-6 Astra | **high** | 跨事件边界、重建竞态、安全与内存释放 |
| T05 原始 DOM、ID、CSS/XPath | GPT-6 Astra | **xhigh** | 回放结构与源结构不同，错误可能静默误导 Agent |
| T06 需求、资料草稿和版本 | GPT-6 Sol | **high** | 契约冻结后较明确，仍需并发与引用完整性 |
| T07 checkpoint 后编辑与注释 | GPT-6 Sol | **high** | 使用已验证历史定位服务；重点是交互状态与保存身份 |
| T08 字段、蒙版、移除元素 tab | GPT-6 Sol | **high** | 涉及跨视图命中、取消和可访问性，不只是布局表单 |
| T09 步骤隔离、真实取消、重试 | GPT-6 Astra | **xhigh** | 取消后仍执行、误判依赖与外部副作用风险较高 |
| T10 流式数据集与部分结果 | GPT-6 Sol | **high** | 状态与持久化契约明确后适合独立实现 |
| T11 验收、来源和版本绑定 | GPT-6 Astra | **high** | 需要识别“自报”与“独立验证”、避免需求被实现缩小 |
| T12 权限与 Agent API | GPT-6 Astra | **xhigh** | 放宽权限不能破坏人工确认、页面身份和撤销 |
| T13 任务交接、差异与订阅 | GPT-6 Sol | **high** | 依赖固定接口，适合交付导出/读取功能 |
| T14 旧缺陷回归、fixture、测试 | GPT-6 Sol | **high** | 系统回归不能只凭断言数量；窄范围 fixture 可交 Luna high |
| T15 集成、打包、独立交付 | GPT-6 Astra | **xhigh** | 验证跨层闭环与实际产物；机械文档整理可交 Luna high |

这不是要求每隔几十分钟换模型。一个工作包用默认模型完成即可；只在进入明显不同难度的子任务或发现可复现棘手错误时调整。需要节约额度时，优先缩小上下文和工作范围，而不是把高风险语义任务降成无验证的批量生成。

### 1.3 在本地设置

从对应 worktree 启动模型，例如：

```text
codex -m gpt-6-astra
codex -m gpt-6-sol
codex -m gpt-6-luna
```

再在会话内用 `/model` 选择所需 effort。官方支持 `--model/-m` 和模型/推理选择；保存配置使用 `model`、`model_reasoning_effort`。[M1][M6]

```toml
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
```

上面是配置字段示例，不要求修改全局配置。并行会话应分别设置，不要让多个 Agent 轮流改同一个 `~/.codex/config.toml`。提示词里写“用 xhigh”不等于模型设置已经生效；启动后确认实际模型与 effort。

新模型未出现在本地 `/model` 时，先核对客户端更新与账户可用性，不猜内部代号、不改非官方 provider。Astra 的官方说明要求 Codex CLI 至少 0.153.0；Sol/Luna 使用支持它们的当前客户端，不把 Astra 的最低版本误当成所有新模型的最低版本。[M8] 也可以暂用实际可选的 GPT-5.6 Sol high 做契约明确任务，待 Astra/新模型可用再做高风险审查；不能把回退当成已获得相同能力保证。

---

## 2. 推荐并行方式：一个集成 owner，最多三条主要实施流

### 2.1 先做 S0，不能直接开多会话各自设计

先让 **S0 / Astra xhigh** 完成 T00、T01 及关键旧缺陷复核，提交共享契约与风险原型。S0 不是只输出计划；它需要真实检查代码、运行基线测试并落下可测试的最小实现。

S0 产物：

1. `docs/refactor-baseline.md`：本地 HEAD、既有改动、已修复/待修复状态、真实命令结果。
2. `docs/refactor-contracts.md`：实际路径、共享类型/schema、状态转换、服务/资源端口、API/格式版本与 owner。
3. `docs/refactor-status.md`：T 编号、依赖、状态、接入顺序；只有集成 owner 写。
4. `docs/refactor-handoffs/S0.md`：契约 commit、工作树实际路径、每流测试数据目录、启动方式及子会话提示。
5. 可运行的 rrweb 源节点/回放选择/原始属性/定位器对照小测试；以及 session 停录不关页面的最小闭环。

不把测试替身标成生产集成完成。契约必须足够让 A/B/C 编译和写真实模块，但也不先设计一套宏大的通用框架。

### 2.2 处理仓库现有 AGENTS.md 约定

核对基线中 `AGENTS.md` 要求开发集中在主目录、不再使用旧 Codex worktree。[R2] 本次并行必须明确解决这项约定，不能让 Agent 偷偷换到旧目录。

本指南的“并行启动提示词”明确授权**为本次重构新建隔离 worktree，并仅据此修订相关协作约定**。S0 要保留主集成目录作为最终交付点，不复用废弃 worktree，不改无关工程/安全规则。如果用户只选择单会话方案，则不需要改该约定。

### 2.3 工作包与依赖

| 会话 | 范围 | 默认模型/强度 | 前置 | 主要所有权 |
|---|---|---|---|---|
| **S0** | T00/T01，基线与公共契约，初始风险原型 | Astra xhigh | 无 | 共享契约、初始 main/session 拆分、根配置、协作规则 |
| **A** | T02/T03/T04/T05，录制、资源、回放核心与原始定位 | Astra xhigh；T03 可切 Sol high、T04 可切 Astra high | S0 | capture、录放/资源/源结构模块、evidence 底层写入/索引；不写主 UI |
| **B** | T06，需求与资料版本领域 | Sol high | S0 | 独立资料领域与存储适配；不写 renderer 或底层原件 writer |
| **C** | T09/T10，执行隔离、取消与流式产物 | Astra xhigh；T10 可切 Sol high | S0 | runner、便携 helper、执行样例；不写最终验收 UI |
| **D** | T07/T08 + T11 的前端结果视图 | Sol high | A/B，结果视图接 F | renderer/选择 UI 唯一 owner；不改 recorder 源信息 |
| **E** | T12/T13，Agent 权限、API、交接/订阅 | Astra xhigh；T13 可切 Sol high | B/C；历史页接口接 A，完整交接接 F | main/dispatch/preload/授权/skill 集成唯一 owner |
| **F** | T11 后端验收与来源检查 | Astra high | B/C；节点来源接 A | validator/来源判定纯领域与测试；不写主 UI、dispatch |
| **G** | T14/T15，总集成、系统验证、发布 | Astra xhigh | 所有实际接入的前置 | 集成分支、共用入口/配置修正、真实系统验收与文档 |

A 的核心任务有共同采集入口与节点身份，不建议把“属性补充”和“回放 ID”交给两个互不沟通的会话分别发明。需要进一步拆 A 时，先在 A 内固定 recorder→archive→replayer 契约，再将资源处理拆成明确的子工作包；不要为了表面并行增加两套身份。

### 2.4 分波次启动

```text
S0：基线、契约、原型、session 最小重构
                    │
          ┌─────────┼─────────┐
          A         B         C          第一波，可并行
      录放与定位   资料版本   执行与数据
          │         │         │
          ├── A+B ──┴──> D                UI 编辑器
          │         └── B+C ──> E        权限与交接
          └──────────── B+C ──> F        验收
                         │
                         G                总集成与交付
```

这是依赖图，不表示 D/E/F 必须等 A 全部结束才可写纯模块。B/C 先完成时，可让 E/F 按冻结契约推进，并把尚未接入的 A 服务标为未验证；最终集成必须使用真实 A 实现。活跃主实施会话最多三个，避免同时运行大量 Electron 测试争用资源。G 作为最终审查可新开干净上下文，但必须读取真实交接和测试记录。

### 2.5 不依赖会话共享聊天记忆

每个会话只认自己的分支、契约 commit、工作包和已落盘交接记录。每个工作包独写 `docs/refactor-handoffs/<会话名>.md`，记录：

```text
工作包 / 分支 / base / 当前 commit
完成的 T 编号与 AT 测试
实际改动路径
接口与格式变化
真实测试命令、结果、产物路径
缺口、未测范围和 blocker
集成要求 / 下一个可执行步骤
```

不要所有会话同时编辑一份 progress/status；不要把“另一会话说已经完成”当成代码已合并。需要新上下文接续时，读取本工作包交接文件与代码，不要求用户重新口述整个需求。

### 2.6 合并与资源隔离规则

每个工作包一个新分支/新 worktree，从 S0 的公共契约提交建立；使用明确 commit 集成，不让多个会话写同一工作目录。官方也把 worktree 用作并行任务的隔离机制，但它不自动解决接口冲突。[M9]

每流使用独立 `BES_DATA`、输出目录、连接文件、浏览器 profile 和端口/instance ID。不能多个测试复用正式账号目录或同一个 `output/dev/latest.json`。先检查测试模式确实隔离，现有启动守卫不可删。

共享契约、package.json/lockfile、主 app/Studio/dispatcher 的跨领域变更，由指定 owner 收敛。工作包不得跨边界做全仓格式化或依赖升级；修改建议落小补丁或 contract-change 记录，再由 owner 合并。

S0/G 集成 owner 按依赖合并可验证的小提交；普通会话不自己 cherry-pick 别人的未确认 HEAD。已有用户改动不能 reset、覆盖、stash 后遗忘；真实记录不入 Git。只有集成完成且用户认可清理范围后，才删除工作树或分支，不默认清理全部。

---

## 3. 可直接复制的短提示词

### 3.1 推荐：并行方案的首个会话 S0

启动 `gpt-6-astra`，选择 **Extra High**，在主集成仓库中发送：

```text
阅读 docs/refactor/01-modification-plan.md、02-codex-execution-guide.md 和仓库 AGENTS.md，开始实施而不只输出计划。先完成 S0：核对现状、保留已有修复、冻结契约并跑通风险原型。允许为本次任务新建隔离 worktree（不复用旧目录），仅据此更新协作约定；随后给出 A/B/C 的实际目录与启动提示。保留未提交修改和录制原件，按工作包提交，真实运行测试并记录结果、限制和接续点。不得靠吞异常、改历史数据或降低验收标准换取通过。
```

这条提示让 S0 完成前置并准备并行，而不是要求一个会话同时替所有工作包宣布完成。随后在它输出的实际工作目录中开对应独立会话。

### 3.2 单会话方案

只用一个会话时选择 `gpt-6-astra` / **High**，在高风险阶段调 Extra High，发送：

```text
按 docs/refactor/01-modification-plan.md 实施全部修改，结合 02-codex-execution-guide.md 的依赖顺序和仓库 AGENTS.md 执行。先核对现状和已有修复，再按可验证闭环修改代码，不只给计划。保留原件、用户未提交修改与安全边界；先验证 rrweb 原始信息/节点/定位器链路，再扩展界面。按阶段提交并真实运行对应测试，维护状态和接续记录。无法验证的事项明确标未测，不以吞异常、改历史或降低验收要求代替实现。
```

### 3.3 A：录制、资源、回放与原始定位

默认 **Astra / Extra High**。使用 S0 创建的 A worktree：

```text
执行工作包 A（T02–T05）。先读主规范第 3、5–8、16–17 节，以及实际 contracts 和 S0 交接。复核锁定 rrweb 源码，完成连续录制/分段、资源归档、原始属性补充、历史节点映射和定位器验证，接出有界回放服务。你拥有 capture/录放/evidence 底层，不能改资料领域和主 UI，也不能私改共享契约。重点测试相对 URL、属性增量、frame ID、seek 竞态、离线资源和缺口。实际实现、测试、提交，更新 A 交接；不要用回放 DOM 自证原站定位器可靠。
```

### 3.4 B：需求与资料版本

默认 **Sol / High**：

```text
执行工作包 B（T06）。读取主规范第 3、9、16–17 节及 contracts/S0 交接，实现项目级需求、checkpoint/注释/字段关联、并发草稿、不可变资料版本、差异及旧材料只读投影。UI 可就地编辑，但需求不能只归属于一张卡片；复制不改原件，V1 不随 V2 改变。只改资料领域及适配测试，不改 renderer 或底层原件 writer。实际测试多示范关联、复制、并发冲突和版本绑定，提交并更新 B 交接。
```

### 3.5 C：执行隔离与部分结果

默认 **Astra / Extra High**；流式数据接口稳定后可用 Sol / High：

```text
执行工作包 C（T09/T10）。读取主规范第 4、10–11、16–17 节及 contracts/S0 交接。保留普通 Puppeteer，增加轻量业务步骤边界、依赖阻塞、真实取消、有条件重试/重跑和批次持久化。独立模块失败不拖死无关模块，辅助证据失败不吞数据；超时返回后不得残留浏览器动作。只改 runner/便携 helper/归属样例与测试。验证强杀后部分数据、批次幂等、原始错误及取消静默，提交并更新 C 交接，不新造 DSL。
```

### 3.6 D：存档编辑、注释与字段 UI

默认 **Sol / High**：

```text
执行工作包 D（T07/T08 及结果视图前端），先核对 A/B 已合并接口和 F 的结果契约。按主规范第 7–9、11 节实现时间轴工作区、任意可靠时刻新增 checkpoint、复制/版本编辑、历史元素注释与可选字段绑定。移除元素 tab；蒙版/焦点/取消/保存/停止与真实状态一致。你是 renderer 唯一 owner，不改 recorder/原始属性/权限语义。测试迟到 seek、旧档案选择、DPI/跨视图命中、无注释字段绑定和取消。真实运行交互测试并更新 D 交接，不能只交静态 UI。
```

### 3.7 E：Agent 权限、API 与交接

默认 **Astra / Extra High**；导出/订阅实现可切 Sol / High：

```text
执行工作包 E（T12/T13）。读取主规范第 4、12–13、16–17 节和 A/B/C 的实际交接。拆开权限、页面互斥和目标身份；实现项目/任务级授权、后台只读查询、草稿编辑、重复试跑、撤销及固定资料版本交接/订阅。你负责 main/dispatch/preload/skill 接入，不改核心领域语义或 renderer。不要把 click 当天然只读，不允许 Agent 冒充人工确认，不开放任意 eval/CDP。验证普通读取无需抢控制、人工占用保护、越界/撤销拒绝及新 Agent 接续，提交并更新 E 交接。
```

### 3.8 F：验收与来源

默认 **Astra / High**：

```text
执行工作包 F（T11 后端），读取主规范第 3、10–11、16 节及 B/C 和可用 A 接口。以固定用户资料版本而非脚本自报要求验收，区分 schema、引用存在、内容证明、脚本声明与人工确认；输出 partial/inconclusive 的明确原因。覆盖漏最后一页、脚本删需求、无关来源 ID、遮罩规则、代码版本变化和多 attempt 来源。不改主 UI/dispatch，按冻结契约返回有界数据；实际测试并更新 F 交接。
```

### 3.9 G：集成与最终审查

默认 **Astra / Extra High**，建议使用新的干净会话：

```text
负责 G（T14/T15）和总集成。读取两份规范、实际 contracts/status 及 A–F 交接，对照代码和测试而非他人完成声明。检查原件/版本不变、源属性真实性、frame/seek 身份、取消静默、权限撤销和独立脚本交付；修复跨模块问题后跑对应单测、桌面、离线回放、故障恢复、长测及安装包验证。不得降低断言或伪造已测。合并可验证提交，更新设计/API/进度/验证文档，最后列出完成范围、实际命令与产物、未测/阻塞项及接续动作，不自动删除工作树或推送远端。
```

### 3.10 可选辅助会话 H：只做小范围测试素材或文档

默认 **Luna / High**。仅由 owner 指定明确文件范围时使用，不让它自行扩张需求：

```text
只完成当前 owner 指定的 fixture/测试素材/文档任务，遵守其文件范围与冻结契约。读取对应 AT 标准，生成可重复的合成页面或整理真实已运行结果；不改生产逻辑、共享契约、依赖、安全策略或验收断言以求通过。发现设计问题写入本会话交接供 owner 判断。提交可核验产物，未运行测试明确标未运行。
```

---

## 4. 验证、集成和额度使用

### 4.1 已有命令优先

基线仓库已有以下入口，以本地 package.json 为准，不重复创建大量一次性脚本：[R4]

```text
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:startup
npm run test:soak
npm run test:example
npm run package
npm run make
```

Windows 根据执行环境使用 `npm.cmd`。需要新专项测试时优先纳入现有测试目录与聚合命令。合成站点可以自动验证；真实账号、物理鼠标和验证码场景需要实际执行证据，不能用 jsdom 或 mock 结果替代。

桌面矩阵和长测不要几个会话一起跑在同一 profile/显示会话；安排一个测试 owner，其他会话运行各自单元/模块测试。性能结果必须注明是否可见窗口、是否跳过 UI、环境和资源争用情况。

### 4.2 每次集成的门槛

读 diff → 核对契约 → 本模块测试 → 受影响回归 → 合并 → 使用真实其他模块重新跑集成。一个采用测试替身的模块可以标“模块测试通过、待集成”，不能标“端到端完成”。

出现共享契约变化时，由 S0/G 更新版本并通知相关工作包读取差异；不能多分支各有一个不兼容版本，最后靠 `any` 和额外兼容字段拼起来。

### 4.3 控制额度，不做虚假成本保证

同一个账户的独立会话不会自动获得彼此独立的无限额度；官方说明 Work/Codex 用量与模型、输入输出、推理、速度和多步骤任务有关，切模型不恢复共享额度。[M7]

因此默认最多三条主要实施流；高风险模块用 Astra，契约明确的模块用 Sol，Luna 只做辅助；不要把所有进度文档、完整 DOM 和长日志重复塞进每个提示词。优先按 T/AT 编号定向读取、按需开附件。用量不足时保存 commit/交接与真实状态，不能仓促把未测功能报完成。

---

## 5. 官方核对来源

模型与强度支持属于会变的信息；以下核对日为 2026-09-26。采用方案时以本地实际选择器和官方页面为准，推荐分配不是官方性能保证。

- **[M1] 官方模型选择、Codex 模型 ID、effort 与 Ultra**：https://developers.openai.com/codex/models （当前重定向到 https://learn.chatgpt.com/docs/models）
- **[M2] ChatGPT 2026-09-22 发布说明，Sol/Luna 在 Work/Codex**：https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- **[M3] GPT-6 Astra 模型与支持 effort**：https://developers.openai.com/api/docs/models/gpt-6-astra
- **[M4] GPT-6 Sol 模型与支持 effort**：https://developers.openai.com/api/docs/models/gpt-6-sol
- **[M5] GPT-6 Luna 模型与支持 effort**：https://developers.openai.com/api/docs/models/gpt-6-luna
- **[M6] Codex 配置参考**：https://developers.openai.com/codex/config-reference
- **[M7] Work/Codex 模型与推理用量说明**：https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex
- **[M8] ChatGPT/Codex 可用性和 Astra CLI 要求**：https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt
- **[M9] 官方 worktree 说明**：https://developers.openai.com/codex/app/worktrees

R 编号见主文档第 18 节。

**推荐落地顺序：先让 S0 真正验证身份和契约，再开 A/B/C；后续按依赖推进 D/E/F，最后由 G 检查整条用户闭环。并行的价值来自职责隔离，不是会话数量。**
