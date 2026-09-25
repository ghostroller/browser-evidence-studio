# 重构状态（S0/G 独写）

更新：2026-09-26。总规范是 refactor/01-modification-plan.md；本表区分已验证原型与生产集成，不以提交数量计完成。

| T | 依赖 | owner | 状态 | 实际范围 / 接续 |
|---|---|---|---|---|
| T00 | 无 | S0 | verified | 基线/共享契约/协作规则已提交；真实 rrweb 源信息、选择、原始结构及定位器风险原型通过；生产能力由 A 接入 |
| T01 | T00 | S0 | verified | session 保留/续录、导航/显式关闭、两种执行模式真实专项通过；无关 busy 下停止与跨启动状态目标校验测试通过 |
| T02 | T00/T01 | A | implementing | 原生 A 已启动；采集通道预算、分段、耐久 barrier、源序列与分类 gap |
| T03 | T00/T02 | A | implementing | A 包内按依赖推进；资源字节/manifest/blob/离线边界待实现验证 |
| T04 | T02/T03 | A | implementing | A 包内按依赖推进；有界随机回放/eventSeq/释放待实现验证 |
| T05 | T00/T02/T04 | A | implementing | A 包内按依赖推进；生产源属性/隐私/frame mapping 待验证，S0 spike 不是生产功能 |
| T06 | T00 | B | implementing | 原生 B 已启动；草稿、revision、差异、旧档只读投影待审查集成 |
| T07 | T04/T05/T06 | D | not-started | 历史 checkpoint 创建、编辑、复制和注释 |
| T08 | T05/T06/T07 | D | not-started | 字段 UI、历史选择、去元素 tab、蒙版 |
| T09 | T00/T01 | C | implementing | 原生 C 已启动；step/attempt 依赖、独立失败、真实取消与重试待验证 |
| T10 | T00/T09 | C | implementing | C 包内推进；批次持久化、幂等、部分输出与分页声明待验证 |
| T11 | T06/T09/T10 | F+D | not-started | 固定用户资料验收、独立来源证明和结果视图 |
| T12 | T01/T06/T09；历史读接 A | E | not-started | 任务授权、后台目标读取、撤销；保留人工确认边界 |
| T13 | T06/T11/T12 | E | not-started | 固定版本交接、差异和订阅 |
| T14 | 持续 | S0/G | implementing | 本轮 161 项、S0 专项、最终 19 进程矩阵通过；此前间歇 UI 风险记录保留；新架构长测仍待 A/G |
| T15 | 全部接入 | G | not-started | 安装包、独立交付、新 Agent/真人与完整长测 |

接入顺序：S0 冻结 → A/B/C 分别提交可验证模块 → owner 按依赖合并 → D/E/F → G。2026-09-26 用户已将启动和接续授权给本主任务，替代此前由用户在各目录启动的安排；历史 S0 handoff 保持原样。主控持续审查、组织返修、串行验证与集成；每包独写自己的 handoff，不修改本表。

## 主控恢复记录（2026-09-26 接管）

主任务 `01a0d9f0-98bf-7bf2-bcf7-b392479480d4`，原生 canonical ID `/root`，集成目录 `D:\Workspace\browser-evidence-studio`，分支 `main`。接管时主树和 A/B/C 均 clean，HEAD 均为 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`；未覆盖后续提交。原生 S0 agents `/root/baseline_audit`、`/root/rrweb_prototype`、`/root/session_impl` 均 completed；Codex app 可见同仓其他任务 idle，未发现已有 A/B/C 实施任务。未停止无关 Node/Codex 进程；没有 Electron 进程。

本地实测 `codex-cli 0.155.0-alpha.16.4`，已读取 `codex --help`；原生多 Agent 工具满足独立上下文、显式模型/effort、按 ID 发消息/接续/状态查询，因此未启动 CLI 后备、未更改登录/全局配置。Node v24.21.0 / npm 11.19.0。根模型沿用当前会话（GPT-6；精确 model/effort 未由工具暴露，不推测）；下表为原生 spawn 实际传入且工具接受的配置，不是提示词声明；返回值只提供 canonical ID，未另外暴露底层 session ID 或运行时模型回显。

| 流 / 依赖 | worktree / branch | base | 原生任务 ID | 模型 / effort / 上下文 | 当前动作 / 提交 / 证据 |
|---|---|---|---|---|---|
| A / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-A` / `codex/refactor-a-20260926` | `4c4b293` | `/root/refactor_a` | `gpt-6-astra` / `xhigh` / `none` | 已实际启动并回报目录校验通过；独立依赖初始化和 A 实施；无新提交获集成批准 |
| B / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-B` / `codex/refactor-b-20260926` | `4c4b293` | `/root/refactor_b` | `gpt-6-sol` / `high` / `none` | 已实际启动；核对目录、独立安装及 B 实施；待首个提交/测试证据 |
| C / S0 | `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-C` / `codex/refactor-c-20260926` | `4c4b293` | `/root/refactor_c` | `gpt-6-astra` / `xhigh` / `none` | 已实际启动；核对目录、独立安装及 C 实施；待首个提交/测试证据 |
| D / A+B；结果接 F | 未建树 | 待已验证集成提交 | 未启动 | 计划 Sol high，尚未配置 | A/B 接口可用后由根创建；不要求用户操作 |
| E / B+C；历史接 A、交接接 F | 未建树 | 待已验证集成提交 | 未启动 | 计划 Astra xhigh，尚未配置 | B/C 接口可用后在三流额度内启动 |
| F / B+C；来源接 A | 未建树 | 待已验证集成提交 | 未启动 | 计划 Astra high，尚未配置 | B/C 接口可用后在三流额度内启动 |
| G / 实际 A–F | 主集成目录 | 逐提交记录 | `/root`（审查上下文按需另记） | 沿用根实际配置 | 持续集成；最终系统验收尚未开始 |

各流 BES_DATA 为自己的 worktree 下 `output\data-A` / `data-B` / `data-C`，不得共享 node_modules、profile、connection 或开发 latest。桌面/物理输入/长测独占锁当前 **空闲**，仅根可分配；三条实施流均已收到不得自行启动的指令。当前没有新重构功能被标为 verified。

恢复步骤：先 `collaboration.list_agents`，按上表 ID 发消息/接续，核对工作树 HEAD/status 与 handoff；仍 running 的流不重复派发。原生 ID 不存在时核对留存成果后原树接续并登记替代 ID。根仅审查已明确 SHA 的提交，再串行集成、测受影响范围。每个结果更新本记录的提交、测试路径、阻塞和下一动作；不将任务“完成”直接改成 T 项 verified。

### 接管后的实际集成日志

- `f46540a`：主控协议/启动状态提交，保留 S0 handoff 历史。A/B/C 都实际回报了正确目录/分支/clean 起点；三流独立安装依赖，默认 npm-cache 写权限错误保留，正常权限流程重试。A/C 已回报各安装 682 packages，B 已运行自身 typecheck。
- `e3088cf`：根唯一提交字段 `checkpointId` / `bindingStatus` 契约补充，主树 `npm.cmd run typecheck` 通过。B 获准仅接入此提交，其对应 SHA 为 `dc13f6f`；将来集成 B 代码时不重复应用等价契约提交。A/C 已通知，录放契约未改。
- 根在可审查提交前提前发现并通知：A Mirror 域 ID 含冒号与 B 路径 ID 校验冲突（B 已区分）；C abort 后业务 promise 先拒绝可能越过 quiescence 等待、批次排队总预算、回执身份验证；B 同草稿连续发布 parent 链和调用方可变对象风险。这些是返修检查项，尚不声明修复/测试通过。
- 本轮生产集成入口尚未改动；Electron/桌面/物理输入/长测锁仍空闲。下一动作：接收第一份明确实现 SHA + handoff，根读差异并运行相应模块测试，按依赖接入后再调度 D/E/F。

当前未测项：跨源 frame、Shadow/Canvas、精确同毫秒回放、结构缺口恢复、离线资产、30 分钟新 session 连续分段内存、安装包及真人站点。既有资料原件没有迁移；生产 recorder 的 checkbox value 遮罩缺口由 A 按 S0 原型证据处理。
