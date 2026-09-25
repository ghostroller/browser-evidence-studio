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

领域模块已接入 production worker/manager 可选 fixed execution 入口；main、UI、B 实际资料尚由 E/root 接入。不能宣称端到端固定资料验收已完成。Node worker 测试不代替 Electron 原生输入。真实 Puppeteer fixture 已在 `test/desktop/refactor-runner.ts`，由 root 接统一 phase 并串行执行；C 未自行启动桌面。

最终接入口：`startWorkflow({ execution: { binding, datasets, saveStep }, snapshotDirectory?, ...existing })`，saveStep 显式必需。E 从 B 实际不可变 revision 构造 binding，校验 codeFingerprint/inputFingerprint，负责 service.close；使用 `event => service.saveStep(event)`。旧 reporter 保留，fixed execution 下 emitData 适配为单批耐久输出，不调用旧全量 hooks.emitData。

结果新增 executionBinding、workflowAttemptId、datasetSummaries（每个真实 attempt/dataset）、steps（生命周期摘要，无 value 全量数据）、snapshot、originalError、evidenceErrors。一个 workflow 的 dataset 可属于不同 step attempt；F/E 必须读取本次持久报告中的真实身份，不按 latest 混合。step 完整原件在 attempts/attemptId 下；未完成 step 在实际 worker exit 后补 failed/cancelled 终态。

快照：注册业务目录及项目内 node_modules 复制为独立目录，拒绝链接；最多 20,000 文件/256 MiB、20,000 目录，启动取消检查贯穿复制。加载时执行同一份校验后的字节，动态 import 也拒绝副本篡改和越出快照的模块。快照留存，不自动清理；main 应传执行归档目录。项目仅在祖先目录安装的依赖须装入业务项目；原生 addon/没有可校验 source 的格式拒绝。此为代码加载边界，普通可信 Node 业务脚本仍有自身文件/网络权限，不宣称文件/网络沙箱。

实际 `npm.cmd test -- test/unit/validation.test.ts test/unit/runner-incremental.test.ts test/unit/runner-snapshot.test.ts test/unit/runner-steps.test.ts`：4 文件/30 项通过，6.30 s；typecheck 通过；npm.cmd run build 通过（保留现有 use-client、chunk size、tailwind sourcemap 警告）。新增 snapshot 子进程证明后期动态 import 和项目内依赖使用副本原值，修改源不换代码，修改副本/越目录 import 被拒；incremental 真实 worker 测试证明失败截图保留数据和 cause、取消前耐久数据保留、退出后才写终态、延迟命令不发送、旧 emitData 适配和绑定不匹配拒绝。主树另已复验早期 187 项，root 记录为准。

portable runtime entry 是 `src/runner/portable.ts`，仅 Node built-ins 和步骤/错误包装，由 root 纳入现有构建为单文件 ESM；安装版不需要运行时 Vite。尚需选择性跨执行重跑的普通代码示例/前置再验证说明，不能将 helper 内自动 retry 当成该流程已交付。

有效性 evidenceRefs 是显式记录，不自动等于内容核验，后续 F 判定。完整 JSON schema/主键语义来自用户资料，当前冻结 DatasetBatch 无 step/schema 字段；本服务按批追加，拒绝同 batchId 异内容，不自动按实体覆盖旧行。finish complete 是脚本声明，不能独立证明分页完整。
