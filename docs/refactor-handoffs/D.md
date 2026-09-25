# D 交接：历史资料编辑、隔离回放控制与固定结果视图（2026-09-26）

## 所有权与基线

- 工作树 `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-D`，分支 `codex/refactor-d-20260926`，起点 `2e2258ea6833860cf76c25cbc8fbc9a1e887e37c`，接续时 clean；Node 24.21.0/npm 11.19.0。独立 `node_modules` 已存在，未重装；测试使用 `output/data-D`，没有启动 Electron、真实账号或复用其他树的 profile。
- 根批准的显示值/来源契约 `92e28ff` 等价 cherry-pick 为 `0c8ce9b`。仅两处共享文档冲突保持 D 起点版本；root main 已有新文档，集成时不重复应用此依赖提交。
- D 只编辑 renderer、D 专属 UI 测试和本文件。旧 UI 检查按钮的回归测试因 T08 删除独立 Elements 入口而移除；新测试覆盖冲突与字段路径。

## UI 实现

- `src/renderer/components/material-workbench.tsx` 使用 E 的实际 `materialDrafts/materialRevisions/materialCollection/createMaterialDraft/editMaterialDraft/publishMaterialDraft` 门面，列表和集合分页有界读取；每次修改携带 `expectedDraftRevision`。冲突显示当前修订并要求重读，不静默覆盖。历史卡片从精确 `ReplayPosition` 创建，可编辑、复制、移动、删除；移动旧绑定由 B 标为待复核，删除卡片不删共享需求。注释只在所选卡片同一精确历史位置保存。
- 需求与字段分开编辑，多示范可引用同一需求。字段支持说明、元素绑定但无注释、元素绑定加独立注释；可编辑 `outputPath`、值类型、`page-displayed` 来源策略、冻结 `json-record`/`dom-text` 证明及需求规则 JSON。原有证明/绑定状态不会因改说明自动丢失或升级。选定节点按 ID 读取 A 源 `historicalNode/historicalLocators`，展示原始属性、显示采样状态和候选 CSS/XPath；不使用回放 DOM 的 outerHTML 作为源。视觉区域明确与 DOM 节点不同。
- `src/renderer/components/replay-workspace.tsx` 调 E 的独立 ReplayHost：流与位置分页、精确 eventSeq seek、播放/暂停/速度、时间轴、步骤导航与状态/选择轮询。请求 token 和 host generation 防迟到回执覆盖。主 renderer 原 `Replayer` 弹窗已移除；进入历史页由 E 隐藏 live WebContentsView、退出恢复。检查时 sidebar/header inert、实时导航和资料提交不可用，右侧保留 Esc 取消和运行中的紧急停止。
- `src/renderer/components/result-center.tsx` 按真实 execution/step/dataset attempt 展示部分失败及已提交数据，C batch/record 有界读取；用户显式选一个 dataset attempt，再调用 F 固定资料验收。报告分页显示覆盖、格式、来源、脚本声明、版本和人工判定；人工 review 由可信 UI 调用并不覆盖机器报告。旧无固定资料验证仍保留旧只读视图。

## 验证与限制

- D 树 `npm.cmd run typecheck` 通过；`npm.cmd test -- test/renderer/refactor-materials.test.tsx test/renderer/app-archive.test.tsx test/renderer/validation-view.test.tsx`：3 文件、12 项通过。专属测试证明并发草稿冲突不重复提交、字段无元素到精确历史元素绑定不强制注释。未运行桌面（由 root 串行）。
- E 的 ReplayHost 与固定执行结果门面在 D 开发时仍在 E 树实施，D 通过 E 冻结方法名编译但尚无真实主进程连通测试；不能把类型检查称为桌面完成。root 集成 E 后需对照实际返回形状、跑专属 UI 合成场景和真实 Electron 的蒙版/焦点/协议安全。A 的离线 replay 与源显示采样仍由 A/root 验证。
- 当前资料规则/来源证明用 JSON 高级编辑，B 严格校验错误透传；未加入可视规则设计器。未在 D 树新增跨进程 IPC、原件写入或人类资料批准机制。固定版本存在不等于人工批准，F 仍以 `candidate` 表示。

## 审查返修（独立后续提交）

- 新固定验证从 `state.validations` 的 `executionId`/`executionBinding` 进入结果中心；旧记录仍从原只读验收入口打开。固定结果通过 E 的 `executionReports` 有界列表发现历史报告并重开。资料修订读取失败明确报错，已选版本不在当前列表时阻止悄然回退到旧流程。
- 结果中心所有深层读取按项目、执行、dataset attempt、batch、report 加请求代际约束。切换执行立即清除子状态；迟到批次、记录和报告不能覆盖新选择。分页按钮也通过同一身份检查，不直接写入旧闭包数据。
- 原生回放在打开响应晚于卸载时主动关闭返回的 replayId；选取回执和轮询错误按 host generation/请求代际筛掉。播放按相邻事件源时间差与速度调度，保留同毫秒 eventSeq 顺序，长空档上限 3 秒；无整段预载。
- 再次运行 `npm.cmd run typecheck` 通过；`npm.cmd test -- test/renderer/refactor-results.test.tsx test/renderer/refactor-replay.test.tsx test/renderer/refactor-materials.test.tsx test/renderer/app-archive.test.tsx`：4 文件 13 项通过，包括异步乱序、晚到 native host 清理与源时间播放。仍未运行 Electron；root 串行桌面测试。

## 资料与播放第二次审查返修

- 草稿列表、选中草稿、五种资料集合和分页各按项目/草稿/修订/请求代际提交。切项目或草稿会清空全部本地卡片、需求、字段编辑输入；旧写入或发布回执不可污染新草稿。保存卡片在异步读取录制引用后仍检查原草稿，避免把旧输入写到新项目。
- 回放速度严格以相邻事件的 `sourceTimeMs` 差计算。长空档只因浏览器 timer 限制按 60 秒分片，未隐式压缩；同毫秒事件仍逐个按 eventSeq seek。关闭 ReplayHost 仅对主进程明确的“view no longer active”视为已关闭，其余错误送工作台可见。
- `npm.cmd run typecheck` 和三组 D renderer 测试（9 项）通过；新增 deferred 旧集合、旧编辑在切草稿/切项目后完成的负例，以及 4 秒源时间间隔不会在 3 秒时跳转。Electron 仍由 root 独占运行。

## 暂停边界：可信任务授权与真实 UI fixture

- 接续 HEAD `5a0ff0645048de18293c1a110755f2ffd4426044`，本包修改均限定 D 所有权：`src/renderer/**`、`test/renderer/refactor-*`、`test/desktop/refactor-workbench.ts` 与本交接。完成提交后应为 clean；提交 SHA 由 D 向 root 单独报告。未触及主目录或其他工作树。
- `TaskAuthorizations` 经现有 `studio.call` 真实调用 E 的 `taskAuthorizations/authorizeTask/revokeTask`。显式选择能力、期限、预算；纯历史/资料/结果授权可离线创建；浏览器授权必须绑定当前 human active run 的 session/profile/lease、具体受管理页面及精确 HTTP(S) origin，执行还要求登记脚本目录。列表显示实例、剩余次数、到期及撤销状态。E 的主进程独占颁发和撤销；页面内容不能触发此 UI API。
- 历史回放展示 E 的资源部分缺失、失败详情和选取错误，不把结构 ready 当作归档资源完整。档案对话框增加“回放此存档”，使保留 active run 时仍能打开已封存录制。`saveCard` 录制引用读取失败在当前草稿可见，切换项目/草稿后旧失败不污染新编辑。
- 新建 `test/desktop/refactor-workbench.ts` 导出 `runRefactorWorkbenchUi(studio,{projectId,recordingId,replayPosition,executionId?,targetSelector?})`：经 React 控件操作 sealed 历史回放、创建/复制 checkpoint、真实原生 ReplayHost 选择与 Esc、绑定无注释字段、授权/撤销、固定结果页。该 fixture **只编译，尚未在 Electron 执行**；须由 root 持有桌面锁并在 G 的 active human run + sealed recording 链后接入。目标 selector 可使用 `[data-entity="o-1"] [data-field="amount"]`。真实界面断言和原生坐标仍待首轮运行修正，不能宣称验收通过。
- 本包 `npm.cmd run typecheck`、`npm.cmd test -- test/renderer/refactor-authorizations.test.tsx test/renderer/refactor-materials.test.tsx test/renderer/refactor-replay.test.tsx test/renderer/refactor-results.test.tsx test/renderer/app-archive.test.tsx`：5 文件 17 项通过；`git diff --check` 通过。新增离线与浏览器授权 UI 测试、录制引用读取失败不写入的负例。未启动 Electron；根报告 G 首轮真实 DOM 链通过并要求在此暂停复盘。
- 下一步由 root 审查本包并整合 E/A/B/C/F/G，串行运行 `runRefactorWorkbenchUi`。重点核对 sealed archive replay 的 target selector 坐标、原生 Esc、资料草稿持久结果以及 fixed result 的旧/新记录入口；失败应保留真实输出并修复，不将编译/单测视为桌面完成。
