# E 接续交接（2026-09-26，实施中）

唯一树 `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-E`，分支 `codex/refactor-e-20260926`，base `dd06e95bd5955902075d3d1f77af1240c8fe4d59`。接续现场 HEAD `2bafbb7bc0bcd6a8795b73543587af18e1cc71d0`；原有 2 个修改及 3 个未跟踪 services 文件保留续写。Node v24.21.0 / npm 11.19.0；独立 node_modules、`output/data-E` 与 `output/npm-cache-E`。没有启动 Electron/桌面/物理输入，没有修改 app.ts 或其他 owner 的文件。

## 首批类型、授权与资料适配

- `TaskAuthorizations` 支持项目离线只读授权，无需活 session/profile/pages；浏览器能力必须绑定 session/profile/page/target/origin，execute 额外绑定真实注册目录。操作数量/有效期/撤销，检查完成与操作注册之间再次同步核对，撤销先 abort 活动再发布事件。
- `ProjectMaterials` 接 B 的真实 FileMaterialService 和 A 的真实 ArchiveReplayService；资料编辑验证全部录制属于当前项目，历史源节点验证不访问实时页。API Agent 只能编辑/发布 Agent 草稿，作者由入口重写，资料修订仍 candidate，不能冒充人工验收。
- `project-dispatch` 提供资料草稿/固定版本摘要、有界 collections/diff、流/位置/历史节点/定位器，独立于 browser operation queue。
- D 使用类型-only `src/main/services/client-types.ts` 和现有 `studio.call`。回放类型约定已交付，隔离 ReplayHost 实现尚在后续包。无需扩大全局 preload 通道。

实际 `npm.cmd run typecheck` 通过；`npm.cmd test -- test/unit/task-authorization.test.ts` 1 文件/4 项通过，444 ms。证明离线授权、错误项目/page/target/origin、check→revoke→run 微任务竞态、活动中止和注册目录变化；不是 Electron 集成证据。

当前未完成：HTTP routes/全入口任务范围强制、实际固定 B/C/F 执行、持久 attempt→recording 映射、隔离原生回放、机器交接与 skill。首包只作为可审查模块/类型依赖，不把 T12/T13 标为完成。

## 第二包：生产门面与模块闭环（待根桌面验收）

已接入根批准依赖，映射：`92e28ff→5560c61`（仅两根文档冲突，完整采用根版本）、`441eef9→b8913fb`、`cb237da→b4a0187`、`a00dd3e→ab98c27`、`963b583→f26376f`、`3f64241→4566750`、`cfab0e5→8124d8d`。没有重置 E 改动，也不重复交付这些等价共享提交。

- HTTP 的 action/snapshot/checkpoint/execute/控制相关入口强制 task scope；省略 authorizationId 不能回退到裸 lease。旧 run/证据/结果读取同样按项目授权；control/startRun/seal/pause/profile/human reply/review 为 UI-only。HTTP 旧一次 startGrantId 明确拒绝，新执行统一任务授权。
- 业务 session 的导航请求与 redirect 检查当前授权 origin；人类拥有时保留实际操作控制。read-only snapshot 不进入写租约或改变 selectedPage。正常任务执行完成保留 agent 所有权，下一试跑仍使用该授权预算。
- `ProjectExecutions` 实际读取 B 固定资料，构造 C execution binding；真实 fingerprints/snapshot 来自 manager，实际 saveStep/datasets 持久化，并保存 host 采集时间区间的 attempt→recording/page 映射。F JSON 来源按真实 artifact metadata、页面、host 时间区间定位，模糊重叠不伪造 scope。
- 结果门面提供 execution/Items、datasetBatches/Records、assessExecution、executionReport/Items/Reports；所有长列表显式预算，报告固定 hash。选择 attempt 只能来自持久结果。人工 reviewExecution 只由 UI 写追加文件，原机器报告不改。
- `ReplayHost` 使用独立非持久 session + 原生 WebContentsView，没用业务 profile、preload 或主 renderer iframe。bes-resource handler 只在该 session 上，按完整 position/seek generation 读归档，禁止网络/file/权限/弹窗。原生区域保持 live view 后台运行；select/status 的 Mirror nodeId 通过完整源模型恢复 frame/mirror/position。Esc 退出选择并回焦。旧 replay format2 改用 A 单完整 source stream window，不混合缺失 navigationGeneration 的新文档。
- 新 main metadata 经 A captureMetadata 处理，putArtifact 明确拆开 byte payload。源显示值已有持久 sampleRef + F DOM reader 路由，等待 A.samplePresentation 精确提交后接 checkpoint hostScope；当前没有宣称显示值生产闭环已过。

模块实跑：`npm.cmd run typecheck` 通过。`npm.cmd test -- test/unit/project-executions.test.ts` 1 项通过，2.42 s；真实 Node worker、真实 B/C/EvidenceReader/F，重开后独立 JSON source 判 pass、固定hash/binding、错误project/伪attempt拒绝、批次读取、review不改原报告。`npm.cmd test -- test/unit/refactor-agent-api.test.ts` 3 项通过，820 ms：省略/撤销授权、human只读/拒写、旧证据入口范围、HTTP假人工操作和越域拒绝。4项 task-authorization 测试此前通过。最初 fixtures 缺 schemaVersion/workflow requirement 导致失败，及 control 先触发409而非明确UI403，均保留输出并修正，未降低拒绝断言。

此包尚未跑 Electron/真实网络跳转/原生选择；根负责串行 fixture。旧 API 单元 fixture 仍按旧裸 lease 结构，需要按新 task scope 更新 fixture 后回归，不保留绕过以迁就测试。后续包继续：真实 source sampling、机器 handoff/skill、桌面专项及权限返修。
