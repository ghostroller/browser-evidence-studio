# C 交接：T09/T10（2026-09-26，实施中）

工作树 `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-C`，分支 `codex/refactor-c-20260926`，冻结起点 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`。独立 `BES_DATA=...\output\data-C`、node_modules；Node 24.21.0/npm 11.19.0。未修改共享契约、主进程、renderer、package/lock、旧业务脚本和真实材料；不启动 Electron 或真实账号。

## 首个模块包

- `src/runner/datasets.ts`：固定 ExecutionBinding，不可变批次与完成标记；原子文件写入+sync 后回执；相同键/内容返回原回执，内容/来源/复用有差异拒绝。按执行持有现有 OS writer guard，强杀后重建元数据，未 finish 仍标 unfinished。
- receipt 与 records 分开有界读，游标绑定查询并冻结当前边界；投影记录 missingFields，保留真实 null；新 attempt 显式引用来源批次与有效性证据。复用只允许同 execution 的旧 attempt，跨 execution 未实现。
- 单批 1 MiB；排队最多 64 操作/16 MiB；单执行最多 128 活跃数据集摘要，单数据集 100,000 批次。元数据不常驻全部回执：summary 只读小 state，batches 只读所需 receipt 页，records 只读按 ID 指定的一批；拒绝超预算单记录。
- 提交协议：pending 标记 → 不可变 batch → receipt 元数据 → 小 state → 移除 pending → ack。强杀遗留 pending 会阻止继续写入，调用显式 `rebuild(identity)` 校验原件并重建元数据；普通只读查询绝不隐式全量扫描正文。rebuild 保留原件和 pending 诊断，损坏原件先失败，不把它视为空数据。
- `PersistentDatasetService.openReader(root, executionId)` 不取得 writer lease；执行中应优先复用已有 service，历史读可独立打开。close 只释放当前 owner，不删原件。
- `src/runner/steps.ts` 是普通 TS/JS 函数包装，分支和循环仍在业务代码。失败依赖明确 blocked，同页 resourceKey 串行，独立实体可逐项继续；每次 retry 新 attempt，只有显式只读/幂等且有次数/退避/总预算才重试。数据先 commit，辅助 evidence 失败返回 partial。
- timeout/abort 检测不等于停止；interrupt 回调必须实际撤销资源并等静默，所有 abort 路径等这个边界之后才 cleanup/终态/释放队列。不提供 interrupt 时一直等业务函数结束。worker 接入将把共享页取消交给现有主进程 gate+worker terminate，不把历史 DOM 当执行断点。

## 已运行验证

`npm.cmd ci` 首次普通沙箱因 npm-cache EPERM 失败；正常 `require_escalated` 重试成功，独立安装 682 packages，无依赖升级。

`npm.cmd run typecheck` 通过。`npm.cmd test -- test/unit/runner-datasets.test.ts test/unit/runner-steps.test.ts`：2 文件/14 项通过，4.41 s。

审查返修 `7feb229`：整个 run/commit/evidence 活动阶段受取消检测，永不 settle 的 evidence 也可在真实 interrupt 静默后结束；cleanup 失败隔离该 resourceKey，不允许重试或同资源后续步骤。typecheck/8 项 steps 测试通过（942 ms）。读路径返修：typecheck/9 项 datasets 测试通过（6.14 s），证明普通摘要/指定批正文不读取损坏的未选中 500 KiB 批次；显式重建检查到损坏，修复 fixture 后可重建；未完成 commit 标记不冒充空数据。

测试包含 AT31/AT32 模块失败、依赖 blocked、单实体失败、辅助截图失败；AT33 真 Node worker 延迟消息在 terminate 后不再到达，work 先拒绝和 evidence 阶段取消均等待延迟 quiescence；AT34 真 Node 子进程 SIGKILL、writer recovery、已确认批次字节不变、幂等、复用身份。还验证固定 binding 冲突、越目录/junction、队列预算、null/missing、正文投影与游标。

## 尚待接入与明确限制

当前是可独立验证的领域模块，尚未接入 production worker/manager、main、UI、B 实际资料。不能宣称端到端模块执行或固定资料验收已完成。取消测试中的 Node worker 消息是可执行调度测试，不代替 Electron 原生输入“无迟到点击”。尚需 root 分配串行桌面时段后验证真实 Puppeteer。

计划接入口：`startWorkflow({ execution: { binding, datasets, saveStep? }, ...existing })`；E 从 B 实际不可变 revision 构造 binding，负责 service.close 生命周期。旧 reporter 保留。接入新 reporter 时 manager 只保留批次摘要和文件引用。代码 hash→动态 import 的可修改窗口在下一包通过执行快照收敛；不将当前 fingerprint 检查当 AT36 已通过。

有效性 evidenceRefs 是显式记录，不自动等于内容核验，后续 F 判定。完整 JSON schema/主键语义来自用户资料，当前冻结 DatasetBatch 无 step/schema 字段；本服务按批追加，拒绝同 batchId 异内容，不自动按实体覆盖旧行。finish complete 是脚本声明，不能独立证明分页完整。
