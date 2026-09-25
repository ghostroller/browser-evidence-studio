# 重构状态（S0/G 独写）

更新：2026-09-26。总规范是 refactor/01-modification-plan.md；本表区分已验证原型与生产集成，不以提交数量计完成。

**当前按用户要求暂停（2026-09-26 06:14）**：暂停点是首轮真实 A/B/C/E/F 系统链通过、D/E 模块接入完成。主树实现/测试提交 `85a7eca`，最新暂停文档提交在其后。没有启动下一轮桌面或长测；完整重构尚未完成。恢复以 [暂停接续记录](refactor-handoffs/PAUSE-20260926.md) 的当前任务、目录、提交队列和未提交现场为准，不能按下面历史派发记录重复启动或重置工作树。

| T | 依赖 | owner | 状态 | 实际范围 / 接续 |
|---|---|---|---|---|
| T00 | 无 | S0 | verified | 基线/共享契约/协作规则已提交；真实 rrweb 源信息、选择、原始结构及定位器风险原型通过；生产能力由 A 接入 |
| T01 | T00 | S0 | verified | session 保留/续录、导航/显式关闭、两种执行模式真实专项通过；无关 busy 下停止与跨启动状态目标校验测试通过 |
| T02 | T00/T01 | A | implementing | 生产预算/分段/耐久 barrier 已集成，模块故障测试通过；新格式长录制仍待验证 |
| T03 | T00/T02 | A | implementing | 原站关闭、新进程恢复历史 CSS/图片/字体及同源 frame 专项通过；blob/data/redirect/SW/CSSOM 仍待闭环 |
| T04 | T02/T03 | A | implementing | 有界窗口与反向 seek 专项通过；最终 ReplayHost 界面、长档和 viewport/DPI 尚未验收 |
| T05 | T00/T02/T04 | A | implementing | 生产源属性、定位器、同源 frame/open shadow/SVG 与显示采样专项通过；能力边界仍待完整覆盖 |
| T06 | T00 | B | implementing | 固定资料、冲突、版本 hash 模块已集成；G 实际历史来源→卡片/无注释字段→执行绑定通过，最终编辑 UI 待验收 |
| T07 | T04/T05/T06 | D | implementing | 资料编辑/复制/移动 UI 已集成，模块通过；真实 UI fixture 已准备待审查接入 |
| T08 | T05/T06/T07 | D | implementing | 新隔离历史选择 UI 已集成，旧元素 tab 已移除；原生输入/蒙版/焦点完整闭环尚未实跑 |
| T09 | T00/T01 | C | implementing | partial/cancel/timeout 真桌面专项与 G 固定版本真实 worker 通过；最终业务及 UI 待验收 |
| T10 | T00/T09 | C | implementing | 耐久批次、复用、选择、快照/预算模块通过；E 崩溃发现返修待根审查集成；最终独立业务交付仍待验收 |
| T11 | T06/T09/T10 | F+D | implementing | JSON/逐页/复用来源模块通过；G 双实体显示值正确通过、错误值失败、附加证据 partial 保留数据通过；结果 UI 待实跑 |
| T12 | T01/T06/T09；历史读接 A | E | implementing | 真实任务授权及重复执行、撤销拒读通过；授权 UI 待集成，jobs/state/剩余接口边界仍待收紧 |
| T13 | T06/T11/T12 | E | implementing | 固定执行/报告门面已接入；完整交接导出、技能、差异与订阅尚未完成 |
| T14 | 持续 | S0/G | implementing | 最近全套为 D/E 接入前 38 文件/246 项；接入后模块与首轮系统链通过，新全套/完整桌面/长测待跑 |
| T15 | 全部接入 | G | implementing | 已开始真实系统集成；新安装包、独立交付、新 Agent/真人及完整长测尚未验收 |

接入顺序：S0 冻结 → A/B/C 分别提交可验证模块 → owner 按依赖合并 → D/E/F → G。2026-09-26 用户已将启动和接续授权给本主任务，替代此前由用户在各目录启动的安排；历史 S0 handoff 保持原样。主控持续审查、组织返修、串行验证与集成；每包独写自己的 handoff，不修改本表。

## 主控恢复记录（2026-09-26 接管）

主任务 `01a0d9f0-98bf-7bf2-bcf7-b392479480d4`，原生 canonical ID `/root`，集成目录 `D:\Workspace\browser-evidence-studio`，分支 `main`。接管时主树和 A/B/C 均 clean，HEAD 均为 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`；未覆盖后续提交。原生 S0 agents `/root/baseline_audit`、`/root/rrweb_prototype`、`/root/session_impl` 均 completed；Codex app 可见同仓其他任务 idle，未发现已有 A/B/C 实施任务。未停止无关 Node/Codex 进程；没有 Electron 进程。

本地实测 `codex-cli 0.155.0-alpha.16.4`，已读取 `codex --help`；原生多 Agent 工具满足独立上下文、显式模型/effort、按 ID 发消息/接续/状态查询，因此未启动 CLI 后备、未更改登录/全局配置。Node v24.21.0 / npm 11.19.0。根模型沿用当前会话（GPT-6；精确 model/effort 未由工具暴露，不推测）；下表为原生 spawn 实际传入且工具接受的配置，不是提示词声明；返回值只提供 canonical ID，未另外暴露底层 session ID 或运行时模型回显。

| 流 / 依赖 | worktree / branch | base | 原生任务 ID | 模型 / effort / 上下文 | 当前动作 / 提交 / 证据 |
|---|---|---|---|---|---|
| A / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-A` / `codex/refactor-a-20260926` | `4c4b293` | `/root/refactor_a` | `gpt-6-astra` / `xhigh` / `none` | `0d295c7 → 441eef9` 资源队列返修已集成；第二次桌面失败记录保留，第三次待新 build；继续隐私/显示值采样 |
| B / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-B` / `codex/refactor-b-20260926` | `4c4b293` | `/root/refactor_b` | `gpt-6-sol` / `high` / `none` | completed，HEAD `e65b774` clean；最终两包已集成 `b762786/7ee2ab0`；有返修时按原 ID 接续 |
| C / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-C` / `codex/refactor-c-20260926` | `4c4b293` | `/root/refactor_c` | `gpt-6-astra` / `xhigh` / `none` | completed，HEAD `19a6a321` clean；最后 `324e46a/19a6a321 → 604b52e/b143227`；有返修按原 ID 接续 |
| D / A+B；结果接 F | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-D` / `codex/refactor-d-20260926` | `2e2258ea6833860cf76c25cbc8fbc9a1e887e37c` | `/root/refactor_d` | `gpt-6-sol` / `high` / `none` | 原生已启动且 clean/分支/base/Node/npm 核实；独立依赖与 `output\data-D`，与 E 协调真实 UI API |
| E / B+C；历史接 A、交接接 F | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-E` / `codex/refactor-e-20260926` | `dd06e95bd5955902075d3d1f77af1240c8fe4d59` | `/root/refactor_e` | `gpt-6-astra` / `xhigh` / `none` | 原生已启动，clean/环境/独立 npm ci 682 包核实；主树 F 两包与 C 收尾获准接入为 `2f845aa/867f4b0/6cdc537/38e611c`，独立 `output\data-E` |
| F / B+C；来源接 A | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-F` / `codex/refactor-f-20260926` | `dedb272e6554a134236617e3a4033f0a3ab549ad` | `/root/refactor_f` | `gpt-6-astra` / `high` / `none` | completed，HEAD `d69a14a` clean；`cae5e6e/d69a14a → 060d7d9/0507b41` 已集成，17 项专属测试通过；显示值真实接入待 A |
| G / 实际 A–F | 主集成目录 | 逐提交记录 | `/root`（审查上下文按需另记） | 沿用根实际配置 | 持续集成；最终系统验收尚未开始 |

各流 BES_DATA 为自己的 worktree 下 `output\data-<流名>`，cache 为自己的 `output/npm-cache-<流名>`，不得共享 node_modules、profile、connection 或开发 latest。当前主要实施流 A/D/E。桌面/物理输入/长测独占锁由根预留给 A 第三次专项；各流均不得自行启动。根唯一写共享契约、配置/锁、`src/main/app.ts`、`test/desktop/launch.js` 和调度状态；E 独写其余 main/preload，D 独写 renderer。当前没有新重构功能被整体标为 verified。

恢复步骤：先 `collaboration.list_agents`，按上表 ID 发消息/接续，核对工作树 HEAD/status 与 handoff；仍 running 的流不重复派发。原生 ID 不存在时核对留存成果后原树接续并登记替代 ID。根仅审查已明确 SHA 的提交，再串行集成、测受影响范围。每个结果更新本记录的提交、测试路径、阻塞和下一动作；不将任务“完成”直接改成 T 项 verified。

### 接管后的实际集成日志

- `f46540a`：主控协议/启动状态提交，保留 S0 handoff 历史。A/B/C 都实际回报了正确目录/分支/clean 起点；三流独立安装依赖，默认 npm-cache 写权限错误保留，正常权限流程重试。A/C 已回报各安装 682 packages，B 已运行自身 typecheck。
- `e3088cf`：根唯一提交字段 `checkpointId` / `bindingStatus` 契约补充，主树 `npm.cmd run typecheck` 通过。B 获准仅接入此提交，其对应 SHA 为 `dc13f6f`；将来集成 B 代码时不重复应用等价契约提交。A/C 已通知，录放契约未改。
- 根在可审查提交前提前发现并通知：A Mirror 域 ID 含冒号与 B 路径 ID 校验冲突（B 已区分）；C abort 后业务 promise 先拒绝可能越过 quiescence 等待、批次排队总预算、回执身份验证；B 同草稿连续发布 parent 链和调用方可变对象风险。这些是返修检查项，尚不声明修复/测试通过。
- 本轮生产集成入口尚未改动；Electron/桌面/物理输入/长测锁仍空闲。下一动作：接收第一份明确实现 SHA + handoff，根读差异并运行相应模块测试，按依赖接入后再调度 D/E/F。
- 首批代码已收到并审查，尚未进入主树：B `687e8de2ec61df4d1c51b7631fa094a30458632a`（typecheck + 6 项定向测试通过），正在按根审查修复准确字节计量及旧投影截断信息；C `5b41291536e8cf9e9e88a6cb95957b73b98ffbf3`（typecheck + 14 项模块测试通过，包括真实 Node 子进程强杀），其取消/清理返修 `7feb229d172cc227bd3b6f744f1bc18e89425fc0`（8 项 steps 测试通过）。根已核对具体差异，C 新剩余阻塞是正常只读隐式读取全量批次正文，C 正改为有界元数据读和显式 rebuild。此处通过是子流模块证据，不能代替主树集成或真实 Electron。
- B 收尾完成后释放实施槽位；根计划在已验证的 B 集成提交上启动 F 的固定资料/来源领域实现，沿用已冻结的 C 接口和已审查步骤结果语义，明确 C 持久服务及 A 来源适配仍待最终真实接入。不会为了启动 F 合入已知有验收缺陷的 C 实现。A/C 继续其原任务，无重复派发。
- 已串行集成 B：`687e8de → 91e05d0`、`c3f8cb9 → 3897e9c`，C：`5b4129 → ceaa0a9`、`7feb229 → c82232c`、读取返修 `97fc384 → dedb272`。根审查确认取消包含非合作 evidence、清理失败隔离资源，常规数据读取不再扫全部正文，rebuild 显式执行。主树 `dedb272e6554a134236617e3a4033f0a3ab549ad` 的 `npm.cmd run typecheck` 通过；`npm.cmd test` **31 文件/187 项通过，78.89 s**，完整日志 `output/refactor-integration-20260926/BC-typecheck.log` 与 `BC-unit.log`。此前 B 定向 11 项通过另存 `B-module-tests.log`。这些是模块集成测试，production main/worker 及 A 来源仍待接入，未标端到端 verified。
- F 实际已从上述通过的精确提交新建（未复用/重置任何树），启动仍等待 B 释放槽位。桌面锁空闲，未同跑 Electron；单元测试期间 A/B/C 仍可编译/进行模块工作，此耗时不是性能验收。

当前未测项：跨源 frame、Shadow/Canvas、精确同毫秒回放、结构缺口恢复、离线资产、30 分钟新 session 连续分段内存、安装包及真人站点。既有资料原件没有迁移；生产 recorder 的 checkbox value 遮罩缺口由 A 按 S0 原型证据处理。

### 后续流启动与审查记录

- B 最终提交 `e48d982/e65b774` 串行集成为 `b762786/7ee2ab0`，`npm.cmd test -- test/unit/materials.test.ts test/unit/refactor-contracts.test.ts` 主树 **2 文件/13 项通过，3.48 s**；日志 `output/refactor-integration-20260926/B-final-module-tests.log`。B completed 后启动 `/root/refactor_f`，实际配置见表，当前主要流为 A/C/F。
- A `4bd3ad7` 已交付供审查，未合入主树；子流 typecheck、4 文件/34 项通过。根要求修正有界 timeline 发现顺序、索引运行时校验、过大最终事件的缺口持久、资源作用域匹配及真实浏览器定位器验证。C `f2b1351` 提供批次来源读取/步骤持久接口，根要求先修复日志缺段后潜在覆盖原件问题。未以子流通过声明代替集成门槛。
- A 请求 HTML 解析依赖，根唯一将已锁定的 `parse5@8.0.1` 从开发期传递依赖提升为显式 runtime dependency，无包版本漂移；parse5 MIT、ESM，transitive entities 8.1.0 的 Node 要求 >=20.19.0。实际 npm 包元数据版本无 prerelease 后缀、无 deprecated 字段、integrity 与 lock 一致，dist-tags latest=8.0.1/test=4.0.0-test。日志 `parse5-metadata.log/parse5-channel.log/parse5-install.log` 在同一集成日志目录。首次 npm view 默认外部 cache EPERM 已保留终端输出，改本树 `output/npm-cache-root` 后成功；没有改全局配置。使用 parser 的生产代码和安装包验证仍待 A/G。
- `3b93f08` 提交上述 parser 和 F 启动记录。`d9d77ab` 由根补齐固定用户资料中的输出路径、JSON 来源指针与逐页结束规则，同时适配已经完成 B 的严格输入校验；typecheck 与 3 文件/16 项通过（`source-contract-typecheck.log/source-contract-tests.log`），旧资料不追加字段或改 hash。F 获准接入此契约。
- C `f2b1351/8f20e129` 审查后集成为 `3054353/961aefc`：原件使用 create-if-absent，步骤文件缺段显式拒绝；有界 batchMetadata 校验真实批次哈希及完整位置。主树 2 文件/19 项通过，9.20 s（`C-metadata-immutable-tests.log`）；typecheck 通过（`C-metadata-typecheck.log`）。`npm.cmd run build` 通过（`BC-build.log`），现有 use-client 指令、chunk 大小和 Tailwind sourcemap 警告仍记录，未静音。生产 C worker/snapshot 与 A 仍未合入，此 build 不是新功能桌面验收。
- A `4bd3ad7/b65d485` 集成为 `6b126b4/59264f6`，5 文件/41 项通过、13.78 s（`A-production-module-tests.log`），typecheck/build 通过。根接入 `--refactor-recording` 两进程串行专项和 ready 前 `bes-resource` scheme，实际 handler 仅由隔离 replay partition 安装。首跑 PID 32736 在初始 document 注入失败：`crypto.randomUUID is not a function`；`output/desktop-1790368796190` 原件与 `A-desktop-attempt-1.log` 保留，offline 未跑。
- A 后续 `fc74fdc/87b1669` 集成为 `e0e9daa/c6a2a56`：测试按每个历史位置选择同 URL 不同 CSS 版本；crypto.getRandomValues 为每次文档注入生成独立 ID。第二次真实桌面正串行运行（`A-desktop-attempt-2.log`，工具 exec session 80793），恢复时先检查进程/日志，不重复启动。桌面锁此时由根持有。
- C `9c2650d` 集成为 `a200e0a`：实际 worker 增量 reporter、执行快照、导入字节 hash 校验，4 文件/26 项通过、11.44 s（`C-production-module-tests.log`）。根新增 `--refactor-runner` 专项入口，等待 A 桌面释放后启动。独立 `portable-runner.mjs` 由现有 `npm run build` 和 Forge build 生成，9.36 kB、仅 Node built-in runtime；本轮 AC typecheck/build 通过（`AC-typecheck.log/AC-build.log`），未以 bundle 生成代替独立安装运行验收。

### A 失败返修、C/F 集成与 D/E 实际启动

- A 第二次桌面已结束：PID 20444，`output/desktop-1790368992121`，录制 run `2044933f-4cae-413d-9100-ab71ff4822f8`。180 s launcher timeout，原始 CSS/image 已捕获，但 font/ttf 出现 `browser-cached-resource-unavailable`；finally 中活连接阻止测试退出。`A-desktop-attempt-2.log` 与原件保留，offline 阶段未执行。根将问题交回原 A 任务，未删 font 断言。A `0d295c7` 审查集成为 `441eef9`：1 MiB/256 个轻量描述符、串行真实 body 读取、保留原工作集 cap，并先保存断言错误再关自身 fixture；第三次真实专项待本轮 build。
- C 生产专项 `node test/desktop/launch.js --refactor-runner` **通过**，PID 40452，`output/desktop-1790369223309`，日志 `C-desktop-attempt-1.log`。partial 保留 5 条数据，cancelled/timeout 无迟到 Puppeteer 点击（再等 1.2 s 为 0）。该专项绑定合成 V1，尚非 B/F/权限/UI 端到端。主树 `dd06e95` 另运行完整 `npm.cmd test`，**35 文件/206 项通过，76.98 s**（`ABC-unit.log`）；并行流只做模块开发，耗时不是性能验收。
- F `cae5e6e/d69a14a → 060d7d9/0507b41` 审查集成：真实 EvidenceReader JSON 字节及 hash、URL/分页/实体内容验证，来源执行映射要求可信宿主提供；遮罩正文显式 redacted，不能变成内容已核验。RFC 6901 根指针和跨 16 KiB 页 UTF-8 解码已测；page-displayed/旧批次复用有效性仍不能独立证明，不标完成。
- C 收尾 `324e46a/19a6a321 → 604b52e/b143227`：业务选择按 step/entity 生效，总 worker 输出 64 KiB 上限，void 步骤原件明确 `resultValueState=undefined`、不冒充 null。根 `CF-final-typecheck.log` 通过；`CF-final-module-tests.log` **6 文件/46 项通过，20.02 s**。最后两包未重复跑桌面，后续 E 实际绑定再跑系统验证。
- 根唯一源显示值契约 `2e2258e`，`presentation-typecheck.log` 通过；A/E 获准只接该共享提交。它只是端口，A 明确选定节点源端取样和 F 核验尚待实现。
- E 从 `dd06e95bd5955902075d3d1f77af1240c8fe4d59` 新建；C/F 完成释放槽位后实际启动 `/root/refactor_e`。D 从 `2e2258ea6833860cf76c25cbc8fbc9a1e887e37c` 新建并实际启动 `/root/refactor_d`，均未复用/重置旧树。原生工具接受的模型/effort/base 见表；下一动作是根重跑 A 桌面、E/D 对齐实际门面并提交可审查包。没有要求用户创建会话或搬运结果。

### 用户暂停检查点

- 暂停前主树 `main` HEAD `2a1fe3119f42ca7ca990354611cacf4d0ac74a6a`，clean；本段单独作为调度文档提交，不继续实施代码。A 队列返修的根进程 session `91615` 已正常退出 0：`A-queue-typecheck.log`、`A-queue-module-tests.log` **1 文件/8 项通过，12.04 s**、`A-queue-build.log` 通过，portable runner 12.10 kB。第三次 A 桌面专项**未启动**。
- 原生 `/root/refactor_a`、`/root/refactor_d`、`/root/refactor_e` 已 interrupt，工具复查均 `interrupted`。进程只读核查首次 CIM 权限拒绝，正常申请权限后成功；未发现命令行属于本仓的遗留 Electron/Node/安装任务（只显示核查命令自身），未停止无关进程。桌面锁释放。
- A HEAD `0d295c7b6ad3bf8a56a3ff158d2dcf1ceecaa9da`。未提交修改完整保留：`src/capture/{coordinator,privacy,request-body,request-ledger,source-recorder}.ts`、`src/resources/archive.ts`、`test/desktop/refactor-recording.ts`、`test/unit/refactor-recording.test.ts`，未跟踪 `src/capture/url-privacy.ts`。这是正在写的 credential URL 隐私和请求身份保护包，未审查/未集成，不能当成已验证；显示值共享提交 `2e2258e` 已获准接入但 A HEAD 尚未包含。
- D HEAD `2e2258ea6833860cf76c25cbc8fbc9a1e887e37c`，clean；已完成 preflight 和开始接口协调，尚无 UI 实现提交。恢复使用原 ID/原树，不重复建任务或 worktree。
- E HEAD `2bafbb7bc0bcd6a8795b73543587af18e1cc71d0`。未提交 `src/main/services/{dispatch,studio}.ts`，未跟踪 `src/main/services/{project-dispatch,project-materials,task-authorization}.ts`；这些权限/材料/执行门面未完成、未审查、未集成。保留原树接续。
- B HEAD `e65b774e53ba7c0b28a185cc03719cde90ca1a71`、C HEAD `19a6a321b2367493143d0094b1c761fac9c57e04`、F HEAD `d69a14a5c995f13472df4d6707ce4cebb2c6680c`，均 clean。所有原树、分支、测试录制及失败日志保留，没有 push、删除或改写历史材料。
- 用户要求恢复后：先读本记录并核对 agents/process/status，按原 ID 接续 A/D/E；先串行运行 A 第三次录制/离线专项，再审查其未提交隐私包，E/D 继续真实门面/UI；随后 F 显示值与复用有效性、最终整机/打包/独立业务/30 分钟长测。未完成项是实施与验证接续，当前没有需要用户解决的权限/登录外部阻塞。

### 暂停后恢复（用户明确继续）

- 根 `collaboration.list_agents` 仅返回 `/root`；旧 A/D/E 上下文已不在当前列表，没有重复启动仍在运行的任务。所有工作树 branch/HEAD/status 与暂停记录一致，主树 `ed3615bdf644f7a600b99cf71d9cf815e2c9a27d` clean，Node v24.21.0/npm 11.19.0，未发现 Electron 进程。未重建工作树或重装现有依赖，A/E dirty 原样留存。
- 替代关系：`/root/refactor_a → /root/refactor_a_resume`（实际 spawn `gpt-6-astra/xhigh/fork none`），`/root/refactor_d → /root/refactor_d_resume`（`gpt-6-sol/high/fork none`），`/root/refactor_e → /root/refactor_e_resume`（`gpt-6-astra/xhigh/fork none`）。原生工具均接受配置，未暴露额外 session ID/模型回显；原 worktree/base/所有权不变。后续恢复优先新 ID。三流禁止自行开 Electron；共享配置/契约/入口仍根独写。
- 根第三次真实 `node test/desktop/launch.js --refactor-recording`：record **通过** PID 42660，offline **失败** PID 32900，8.12 s。`output/desktop-1790370699081`、run `89de7c9f-cb69-4675-9509-97fc51c568ec`、`output/refactor-integration-20260926/A-desktop-attempt-3.log` 全部保留。CSS/image/font 字节已捕获，历史位置已封存；offline 初始化 executeJavaScript 泛化错误，seeks/blocked 为空，不能声明离线已过。根发现 CSP 文本插入 JS 单引号字符串可能未转义，交 A 加阶段/console 诊断及修复，禁止放宽 CSP/sandbox。第三次已退出，桌面锁空闲。
- A 诊断修复 `23b1808 → cb237da`，root build 通过（`A-offline-build-4.log`）。第四次录制 **通过** PID 34260，离线 **失败** PID 10128（6.76 s），`output/desktop-1790371030791` / `A-desktop-attempt-4.log`。初始化已过，首次 updated seek 的历史 CSS 颜色仍是默认链接蓝色；mapping/真实协议请求/样式就绪由 A 继续定位，断言和 CSP/sandbox 不变。
- root `node test/desktop/launch.js` 既有回归第 1 次失败（PID 5252，`output/desktop-1790370887919`，`ABC-desktop-regression-attempt-1.log`）：先前 UI/控制/runner/人工合成场景通过，到 iframe 原件检查仍按旧 navigationGeneration 过滤。根修正测试为 format2 的 recording/page/document/epoch + 耐久 eventSeq/time，保留 full snapshot/只录顶层/体积上限断言；`format2-lifecycle-typecheck.log` 通过，实际重跑待 A/E 修复。E 的旧 Studio.replay 也已要求按完整 stream 边界分离导航，不能继续以全 undefined 的旧字段分组。
- E `e686e5f` 已收到，4 项子流授权测试和 typecheck 通过；根暂不合入：省略 authorizationId 时旧 API 仍可绕过新 grant 范围，要求同一 E 接续任务补强制授权/越域/撤销测试后审查集成。A `0ef6a37` 隐私/请求 ID 包已收到，子流 18 项通过，暂不合入：要求保留有界脱敏后的原错误原因，以及恢复已有 9 MiB JSON 明确截断为 8 MiB 的验收语义。未通过不标完成，不转交用户排查。
- 根接管已完成 F 的后续纯领域扩展：新增冻结 `dom-text` 来源约束及 `CapturedDomSourceReader` 宿主适配，按精确源显示采样、语义属性、同 frame/shadow 实体属性验证，拒隐藏/遮罩/跨 frame/过期/无关节点。`dom-proof-typecheck.log` 首次因旧 JSON 测试对 union 未收窄失败，明确 kind 后 `dom-proof-typecheck-2.log` 通过；`dom-proof-tests.log` **3 文件/23 项通过，6.56 s**。此处是契约/纯证明模块验证，A 源端采样和 E 持久引用映射仍待真实接入，不标页面显示值端到端已完成。
### 恢复后的源码证据与离线返修接续

- 当前实施任务仍为 `/root/refactor_a_resume`、`/root/refactor_d_resume`、`/root/refactor_e_resume`，原生列表均 running；原树复用，未重建、重置或启动额外流。
- A `0ef6a37/38c03cc/d29fa33 → a00dd3e/963b583/3f64241` 已审查接入：新证据的 credential URL 遮罩、延后 body 读取的请求身份、离线资产等待及 9 MiB 实测响应的 8 MiB 前缀/原始字节数。`A-prefix-typecheck.log/A-prefix-build.log` 通过，`A-prefix-tests.log` **3 文件/33 项，12.46 s**。原错误原因须保留有界脱敏身份，不吞持久化异常。
- A 第五次专项 `A-desktop-attempt-5.log`：record PID 42232 通过，offline PID 13936 失败，7.27 s；原件 `output/desktop-1790371821202`、run `ba3e9d3f-a3be-40da-84bd-531361d7c085` 保留。updated seek 的 CSS、图片、字体和 8 个源 CSS/XPath 对照通过；initial seek 的字体被同 seq 后到的失败 cache probe 覆盖。根定位后交 A；`5850f88` 修复已收到待集成复测，不能记离线整体通过。桌面进程均已退出，锁空闲。
- 根补 checkpoint 回执和 host scope：未知/已终止步骤拒绝，采样与步骤状态切换互斥，引用字节预算固定。首次 `checkpoint-scope-tests.log` 两项失败（负例错误地期待执行继续，且测试 hook 未响应 abort），保留原日志；按既有非法 reporter 致执行失败协议修正测试与合成 hook，`checkpoint-scope-tests-2.log` **2 文件/19 项通过，3.92 s**，typecheck 通过。未降低生产错误标准，A/E 真实采样链仍待集成。
- D `d245a88` 首个 UI 包收到，根审查要求修正资料读取错误被隐藏、跨 execution/attempt 迟到请求覆盖、native replay 迟到打开的清理及按 sourceTime 播放；尚未集成。E 强制授权和真实 B/C/F 门面仍在原任务实现；A `17ab383` 源显示值采样包已收到待审查。下一动作：依次集成已审查 A 包、重跑录制/离线专项，再接入 E/D 和最终系统验证。
### A 第六次真实通过与 F 复用核验

- A `5850f88/17ab383 → 27c8db0/e48b2df`：根 typecheck/build 通过，`A-sample-tests.log` 实际 **2 文件/17 项，5.10 s**（命令多列一个不存在的 response-privacy 文件，Vitest 实际只跑两个文件，按实际计数）。第六次 `node test/desktop/launch.js --refactor-recording` **record/offline 均通过**，PID 32660/28956、7.91 s，`output/desktop-1790372576006` / `A-desktop-attempt-6.log`。原站关闭、新进程离线恢复两个历史 CSS 版本、图片及字体，源定位器对照和显示文字 shown/隐藏文字区别实际通过。仅本专项范围，不代表跨 frame、最终 UI 或长测完成。
- 根 F 复用核验与 host identity snapshot 接续见 F handoff；typecheck + **3 文件/33 项，12.67 s** 通过。当前证据重新按固定字段/分页证明，旧 provenance 不重标、不改原件。
- E `c205d6f` 已交付但仍待返修审查：重复 running 的合法恢复、全部 scope 的歧义判断、资源读取错误保留、ReplayHost 迟到代际和释放、精确字节计量。根不接入已知会把错误隐藏的包，原 E 任务处理，其他工作继续。D 首包同样在原任务修复迟到请求/播放时间；三流均未自行开桌面。
### G 模块链专项准备与既有回归

- 主树 `26a3a69` 的 `npm.cmd test` 完整 **38 文件/246 项通过，91.90 s**；`AF-full-unit.log`。`AF-typecheck.log/AF-build.log` 通过。未同时运行 Electron；其他流仅模块实现，此耗时不作性能门槛。
- 旧完整桌面矩阵第 2 次 `ABC-desktop-regression-attempt-2.log`：PID 7392，`output/desktop-1790372952498`，前置 UI/M0/M1/环境通过，runner 启动在 `Studio.navigate` 的观察连接 `document.readyState` 读取抛 `Execution context was destroyed`；profile/recovery 后续阶段未启动。根已把具体栈交 E 修复真正的导航/观察就绪边界，不忽略原异常。进程已退出，桌面锁空闲。
- 根新增现有启动器 `--refactor-system` 专项：停录后从真实 A 历史位置建 B 卡片与字段，无注释的元素绑定；固定版本经 E 任务授权/HTTP 启动 C 实际 worker，宿主采样回执进入耐久批次，再由 F 核对 good / wrong-value / evidence-partial，最后授权撤销拒读。fixture 已 typecheck，E 返修/采样接口尚未合入，因此**尚未运行**，不是通过记录。UI 专项另由 D 准备，root 接入口后统一实跑。

### D/E 接入与 A frame 实跑（2026-09-26 06:10）

- 当前主树 `b77a017`。E `e686e5f/c205d6f/900f1f0/d08c71f → e48dcdd/5a9f216/a84e287/1954adf` 已按具体差异审查并串行接入：任务范围授权、固定 B/C/F 门面、隔离 ReplayHost、重复 running 原件、完整步骤归属及真实多节点 checkpoint 采样。D `d245a88/63acd46/5a0ff06 → d99fbe1/d00b247/78d3d66` 为资料/回放/结果 UI 和两轮时序返修。主树 `DE-typecheck-1.log` 通过；`DE-module-tests-1.log` **12 文件/40 项，25.70 s**。仍待真实新 UI 验收，不将模块通过记为全包 verified。
- A `23b3ff0 → 38a7740` 第七次录制失败：`output/desktop-1790373434512` / `A-desktop-attempt-7.log`，旧文档延迟资源任务被错误当作当前失败。`6480169 → f3adf7f` 将任务绑定 CDP loader 与触发快照的源位置，旧任务明确记录 skipped 诊断、保留原件。第八次在受限执行中 GPU 进程启动失败（exit -1073741515），`output/desktop-1790374046808` / `A-desktop-attempt-8.log`，未到功能断言。通过正常权限审批重跑第九次，**record/offline 均通过**，PID 13004/27804，6.34 s，`output/desktop-1790374061582` / `A-desktop-attempt-9.log`。实际包括同源 frame 的 CSS/图片与源定位器，原站关闭和新进程离线；跨源/其余资产/长档仍继续实施。
- 根 `de82e5c` 将复用来源不足归入 sourceVerdict，schemaVerdict 继续按真实格式判定；`F-verdict-separation-tests.log` **1 文件/18 项，6.31 s**。没有改变总体非通过结果或历史 provenance。
- E `ce13c20 → b77a017` 实际文档导航就绪边界接入，`G-system-build-1.log` 通过。根正运行 `--refactor-system` 第一次（`G-system-attempt-1.log`，工具 session 59080）；恢复时先核对日志/进程再启动，不能并跑 Electron。
- 旧 API fixture 尚未传任务授权，`DE-legacy-api-tests-1.log` **7 失败/4 通过，5.16 s**；根负责改成真实 TaskAuthorizations fixture，保留取消、目标、人工控制的原断言意图，不恢复裸 lease 访问。D 授权 UI/真实桌面 fixture、E 崩溃后 dataset 发现及导出、A 资产边界继续在原树原任务推进。D 曾一次模型容量错误，已按 `/root/refactor_d_resume` 接续，未换模型或新建重复任务。

### 按用户要求暂停复盘（2026-09-26 06:15）

- G 第一次真实系统专项 **通过**，`output/desktop-1790374154201/refactor-system-report.json`，PID 43312：固定版、多次授权执行、双实体显示采样、错误值拒绝、附加 evidence partial 保留业务数据与撤销拒读。工具 session 59080 已结束；关闭阶段 UI sender 被拒日志保留。新 UI、安装包、长测未跑，不能称最终验收完成。
- 根 `85a7eca` 完成手头旧 API fixture 适配；typecheck 与 **3 文件/14 项通过，1.82 s**，`DE-legacy-api-typecheck-2.log/DE-legacy-api-tests-2.log`。没有移除目标/取消/人类控制负例，使用真实 task grants。
- 三条原生实施任务均确认 completed（用户暂停收尾），当前无 Electron 进程。A 保留未提交 CSSOM fixture；D `7b772bf` 与 E `83aa396` 等下一包排队审查，未继续集成。全树 SHA、测试、模型、待合包、未提交现场和依赖接续见 [暂停接续记录](refactor-handoffs/PAUSE-20260926.md)。用户恢复前不自行继续实施。
