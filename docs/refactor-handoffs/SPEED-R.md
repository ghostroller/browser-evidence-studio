# R：恢复、索引与长测准备（2026-09-26）

- 基线：`046a52e7432fdcebb9524b661ebf4166b80acba1`；工作树 `C:\Users\Ghost\.codex\worktrees\finish-recovery\browser-evidence-studio`，分支 `codex/finish-recovery-20260926`。本包提交 SHA 以 Git 记录为准。
- C03：format2 replay 与 URL 资源索引按 run 定向重建。写入独立 generation，完成校验后以原子 pointer 发布；pointer 绑定 manifest SHA256，URL 文件另逐项校验 hash。读取固定一次 generation。失败 generation 不删除，旧 pointer 保留。
- 原件层：raw rrweb、已确认的 `resource-reference` event、resource manifest、blob/hash。重建不会请求历史网站；缺失/损坏/读取失败/索引写失败分别报错。损坏原件只报告并保留；活跃 writer 拒绝重建。
- 查询读取先核对 pointer/manifest/URL 文件/census 字节上限，再载入内存；超限报 `*_INDEX_BUDGET`，不把超限或读取失败当资源未观察到。
- URL legacy 索引增加有界 URL hash census，在确认资源事件前写入。已观察 URL 的索引文件丢失返回恢复状态；未知 URL 可返回空。旧无 census 的 archive 标 `unverified`，需要定向恢复建立完整 generation。
- 可信服务：`inspectRunRecovery` 额外返回 `canRecoverIndexes` 与 `indexDiagnostics.{replay,resources}`（state/reason）；原 `canRecover` 不变。`recoverRunIndexes(studio,{runId,expectedFingerprint})` 只接受登记的单 run、无活跃 writer、当前 fingerprint。公开 HTTP 未增接口。
- C06：`test/desktop/launch.js` 增 `--refactor-recovery`、`--refactor-soak --soak=1|30`、`--native-input`。`test/desktop/refactor-recovery.ts` 导出 `runRefactorRecoveryScenario(studio,phase)`，支持 `refactor-recovery`、`refactor-recovery-soak`、`refactor-recovery-verify` 三个 phase；由集成 owner 在 `app.ts` 加唯一 hook。
- 新架构长测复用固定 1 Hz 点击/64 KiB JSON、1 MiB/min、100 ms DOM、HTTP checkpoint 负载，另采生产 format2/真实 CSS，队列峰值、文件/字节增长、首中尾加 12 个固定随机位置、URL 索引恢复、原件 hash 与独立 Electron PID 回读。Replay renderer 的真实 PID/private bytes 用 `webContents` 与 `app.getAppMetrics()` 在 15 次 seek 期间采样。
- 原有门槛不变：checkpoint P95 ≤2 s，summary P95 ≤500 ms，HTTP submit P95 ≤300 ms，零跳过调度槽，主 RSS ≤1 GiB，源页 private ≤512 MiB。`--soak=1` 只是初始化预检。Node runner 用 `worker_threads`，与 main 同 PID；固定录制负载不启动 runner worker，故其独立 OS RSS 不存在、worker heap 增长未测。若需活跃 worker heap，集成 owner 可对 `WorkflowHandle` 暴露窄 `Worker.getHeapStatistics()` 采样。
- 已在本树验证：Node 24.21.0/npm 11.19.0；`npm.cmd ci`；`npm.cmd run typecheck`；`npm.cmd test -- test/unit/directed-index-recovery.test.ts test/unit/refactor-recording.test.ts test/unit/run-recovery.test.ts`。测试覆盖 URL 丢失/污染、positions 截断、原件尾部损坏、写失败、旧 generation 保留、writer lock 和服务身份。最终计数见本包消息/日志。
- 仍待 G2 冻结候选：集成 app phase、可信 dispatch/资料 UI 修复入口；桌面令牌下短 Electron 预检、1 分钟机制预检、安静负载 30 分钟与跨 PID 读回。同一候选完整矩阵由集成 owner 调度。此处不把未运行的桌面/长测写成通过。

## 集成短测发现与修正

- 集成 `410be41` 首次沙箱 Electron 启动在产品代码前因 GPU 子进程 DLL 缺失退出；保留 `output/finish-r-refactor-recovery.log`。获准正常宿主重试后进入真实 fixture，发现同一 CSS URL 有两次合法 captured 请求（source eventSeq 3、5）；fixture 从 `list()` 随机顺序拿第一个 ID，却把它与按历史时间选择的最新 `resolve()` ID 强行相等，导致断言失败。保留 `output/finish-r-refactor-recovery-host.log` 和数据根。
- 已将短测与长测 fixture 都改为在移除索引前锁定 `resolve()` 返回的实际版本，重建后核对相同 ID/bytes。新增两个同 URL 版本的独立模块回归。`npm.cmd run typecheck` 与 `npm.cmd test -- test/unit/directed-index-recovery.test.ts`（11/11）通过。此修正仍需合并、重建并复跑 Electron；不把此前失败改记通过。
- 集成 `1a2d992` 的宿主 Electron 短测再次进入 fixture，发现 `streams()[0]` 是较早的 2-event document stream，而 CSS 的保存位置属于稍后的 10-event stream；原选择使 CSS 版本解析断言失败。保留 `output/finish-r-recovery-1a2d992.log` 与 `output/desktop-1790424655521`，Electron PID 28088 已退出。
- fixture 现按 CSS 保存位置的 recording/page/document/epoch 身份选择 stream，并在 seek 前断言该 stream 的 eventSeq 范围包含 CSS 位置。短测和长测共用这一约束；这是 fixture 选流修正，尚无证据表明产品恢复算法错误。此修正仍需合并、重建并复跑 Electron。
