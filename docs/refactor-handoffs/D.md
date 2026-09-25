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
