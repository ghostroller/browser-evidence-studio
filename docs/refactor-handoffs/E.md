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

## 第三包：审查返修与明确负例

- ReplayHost 从 open 入口开始限制 lifetime，初始化与 selection 每个异步边界检查，关闭期间 ready 失败被明确消费；seek/selection 独立代际防迟到焦点和蒙版操作。回放加载时隐藏 native view，资源等候结束才显示。
- bes-resource 缺失为 404，读取/完整性失败为 500；保留有界脱敏 resource/generation/code/name/message，并在 ReplayHostState.resources 显示 partial。资源等候覆盖 stylesheet、image、font，最大 5 秒，未就绪明确诊断。
- 选择递归同源 frame/open shadow，按每层缩放映射矩形，未知 iframe 返回不可解析。新单元仅证明 helper 和 Electron stub 生命周期，真实 native/frame 仍由根专项验证。
- Host scope 首次 running 追加保存，合法 awaiting-human→running 与 prior 复跑只核对既存 identity，原起点不覆盖。JSON 来源按所有曾 running 的真实 host attempt 判断歧义，固定使用 source.responseObservedAt，缺该字段的历史材料不足，不用 body 落盘 createdAt 猜归属。等待 A 对新 response-body 写入观测时间。
- 只有 ENOENT/ARTIFACT_NOT_FOUND 是缺失；读取权限/损坏错误到 F，报告仍区分 Original-source read failed。recordSample 在每次 await 后核查 active/abort，克隆目标；报告 discovery 的 returnedBytes 包含自身字段，固定点计量。

`npm.cmd run typecheck` 通过（repair-typecheck.log）。首次新增模块测试失败 2 项，原因合成 awaiting-human 缺 C 必需的 result identity；原日志保留，补合法协议后 `npm.cmd test -- test/unit/task-authorization.test.ts test/unit/refactor-agent-api.test.ts test/unit/project-executions.test.ts test/unit/replay-host.test.ts` **4 文件/14 项通过，3.96 s**（repair-module-tests-2.log）。证明实际 Node worker 合法恢复、少选 dataset 仍保持并发歧义、元数据读取故障传递、报告精确预算，及 stub replay 迟到打开/关闭/选择、损坏与缺失分离、frame/shadow 命中。未启动 Electron。

## 第四包：生产 checkpoint 的固定资料显示值采样

依赖映射 `b99a1ac→b0faf73`、`26a3a69→499f77d`。Studio 的既有 runner checkpoint hook 读取 manager 第四参数 CheckpointHostScope；固定资料的 requirementIds 仅用作选择，未知 ID 拒绝。字段 nodeAttribute/sourceUrl/pageParameter 匹配当前 SourceModel 的全部节点，最多 64 个；不选择首个，不使用示例常量，也不接受脚本 observed/值声明。逐节点调用 A.samplePresentation(signal)，把新的耐久 full identity 与实际 execution/attempt/recording 保存为 host sampleRef，回执 sourceRefs。每次 await 后检查 signal、执行/页面/文档/控制权，取消不能返回成功。无 DOM proof 的固定资料无需源节点采样。

`npm.cmd run typecheck` 通过；`npm.cmd test -- test/unit/checkpoint-sources.test.ts test/unit/project-executions.test.ts test/unit/workflow-manager.test.ts` 实际 **2 文件/5 项通过，3.37 s**；最后一个不存在的文件没有产生测试，按实际计数。日志 sample-module-tests.log、sample-typecheck-2.log。新增三项覆盖多个匹配节点、完整身份、未知需求、源元数据不足、64/65预算及错误URL。真实 G 双实体 + wrong-value + evidence-partial 尚待根 Electron 集成；不能据模块测试宣称已过。

## 第五包：Electron 导航与 Puppeteer observer 同文档边界

Studio.navigate 调用专用 navigateObserved。先安装 Puppeteer load watcher 再调用 WebContents.loadURL；完成后实际 CDP frame/loader/URL、两侧 document.readyState/timeOrigin 相同才返回。旧 Execution context destroyed 类错误在 15 秒总期限内重试，其他异常不吞；再次导航的 loader 改变拒绝，target/page/lease 每个异步边界核对。超时停止仍属于原 owner 的导航并保留最后原始 cause，监听器/临时CDPSession清理，晚到 session 也 detach。

`npm.cmd run typecheck` 通过；`npm.cmd test -- test/unit/navigation-readiness.test.ts` **1 文件/4 项通过**，navigation-typecheck-2.log/navigation-tests-2.log。验证 watcher 先行、短暂旧context、同URL不同loader拒绝、真实协议异常保留、target更换和超时cause；此为协议stub模块，根既有 desktop runner 导航回归尚待重跑。
