# S0 共享契约 v1（2026-09-26）

本文件和 `src/contracts/{recording,materials,execution}.ts` 是 A/B/C 的编译边界，owner 为 S0/G。它们不是已接入 HTTP/生产录放的声明。工作包要改契约时在自身 handoff 记录变更提案，由集成 owner 提交，不用 `any` 绕过。

## 身份、格式与现有契约

- 复用 `src/contracts/workflow.ts` 的 JsonValue、DataRule、DataProvenance；保留普通 Puppeteer 和旧 reporter。`src/evidence/contracts.ts` 的 schema 1 原件、writer、读取预算与 HTTP `/v1` 不升级、不重写。
- 新录制格式号 `RECORDING_FORMAT_VERSION=2`，仅 A 完成 writer/reader 后按能力启用。S0 录制仍是 schema 1，不因常量存在宣称已有格式 2 数据。实际 `recordingId` 采用录制 run ID，不复制另一套原件。
- 历史位置必须携带 recording/page/document/streamEpoch/sourceTimeMs/eventSeq；同毫秒事件用源事件序号区分，不用主进程接收顺序伪造因果。document 在文档替换时更新；streamEpoch 在录制重新注入/重启时更新。frameId + mirrorScopeId + nodeId 只在这个位置对应的映射内有效。
- 历史 DOM 与 visual-region 是不同联合类型。属性 `present('')`、`absent`、`redacted`、`missing` 不等价；value/checked/selected properties 与 attributes 独立。源元数据不完整时不从回放 DOM 补造原值。
- 资料 `schemaVersion=1` 与用户 revision ID 分开。revision 内容及 hash 不变；作者 human/agent 不等于已批准。人工批准与 review 仅可信 UI 追加，A/B/C 不新增批准入口。
- execution 固定 material revision/hash、代码和输入指纹、环境、运行模式；无 `latest` 绑定。当前旧 workflow 验收在 B/C/F 接入前仍是旧契约，不能宣称固定用户资料验收已实现。

## 实际目录、服务端口与文件所有权

| 包 | 新模块目录 / 可改范围 | 入口契约 / 交接 |
|---|---|---|
| A | `src/capture`、`src/evidence`、`src/replay`、`src/resources`；对应测试 | recording.ts：ReplayService、SourceNode、LocatorCandidate、ResourceReference；`docs/refactor-handoffs/A.md` |
| B | `src/materials`；对应领域/适配测试 | materials.ts：MaterialService；`docs/refactor-handoffs/B.md` |
| C | `src/runner`、`examples` 中归属的 portable helper 与测试 | execution.ts：StepResult、DatasetService；保留旧 WorkflowReporter 适配；`docs/refactor-handoffs/C.md` |
| S0/G | contracts/shared、package/lock、main、dispatcher/preload、根测试入口、status | 其他包提交接入建议，不能并行改中央入口 |
| 后续 D/E/F | D renderer；E main/dispatch/preload/skill；F 验收领域 | 按 02 指南依赖接入；当前未启动 |

“服务端口”在 S0 是 TypeScript 进程内接口，不新增守护进程或公网服务。ReplayService 按明确位置获取状态/源节点/定位器；输入 budget 的 maxBytes/limit 必须是正整数并在实现侧校验上限，游标绑定查询和格式。返回超预算节点不能静默丢字段：明确 413 或分块。UI 的 seek 代际和 AbortSignal 由调用方拥有，迟到结果不能提交到较新的选择会话。

MaterialService 使用完整内容条件更新：`expectedDraftRevision` 冲突返回 current，不覆盖；发布时也检查预期版本。B 校验关联、ID、字段、内容限额、项目路径和 source 引用，原子落 manifest + hash。复制卡片及注释生成新 ID，保留 anchor/原采集时间，不复制业务需求定义。移动 anchor 后必须复核绑定。

DatasetService 的 append 完成意味着已持久保存；幂等键是 execution/attempt/dataset/batch。相同键同内容返回原回执，异内容拒绝。finish 不能覆盖已提交批次，失败保留之前的回执。批次 hash 覆盖 records、provenance、复用来源。取消在持久边界前后均检查；已持久保存后取消不能撤回原件。StepResult 分开业务错误、blocked、partial、awaiting-human；辅助截图失败不吞业务数据。

## 落盘与旧材料

根为每个实例的 `BES_DATA`，相对目录冻结如下：

```text
runs/<recordingId>/                 # 现有原件；新能力 manifest/segments 由 A 按格式启用
blobs/<sha256>                      # A 新资源字节；不改旧 run 内 blob
projects/<projectId>/materials/drafts/<draftId>.json
projects/<projectId>/materials/revisions/<revisionId>.json
executions/<executionId>/binding.json
executions/<executionId>/attempts/<attemptId>/
executions/<executionId>/datasets/<attemptId>/<datasetId>/
```

新目录中的 ID 必须先验证为单路径段，拒绝 traversal/符号链接逃逸。沿用 `evidence/files.ts` 的安全路径/原子写与 writer 所有权语义；不同领域不共享可变单例 writer。B 旧材料投影只读，不把旧时间线或缺失源属性写回历史；迁移用合成拷贝。A GC 首版不自动删除原件或历史版本仍引用的资源。

## 状态转换与失败

```text
session: closed -> open/no-recording -> recording -> sealing -> open/no-recording
                                              \-> seal-failed (保留现场和诊断，不能报成功)
open/no-recording -> explicit close -> closed
recording: starting -> recording/paused/degraded -> sealing -> sealed
draft: revision n -> conditional update -> n+1; conflict 保留 n 的当前内容
publish: draft n -> immutable revision/hash（不是批准）
step: pending -> running -> succeeded/partial/failed/cancelled/awaiting-human
      pending -> blocked（记录失败依赖身份）；重试创建新 attempt
```

停止优先通道不等待无关 read/global busy；确认连接/worker 静默后才交还人工。封存只收尾采集，关闭页/session 是显式操作。从起点验证创建新页面并记录起点，当前页试跑按 page/document 身份保留现场；两者不能互相冒充。session/profile 不等于跨标签完全隔离。

## 进程、端口和测试隔离

A/B/C 的实际路径与命令在 S0 handoff。每流独立 BES_DATA、output、连接文件、profile、node_modules 和 Vite cache；不要借用根目录 `output/dev/latest.json`。HTTP、CDP、Vite 均沿用系统分配端口 0，连接后校验 instanceId/project/profile，不固定猜端口。不增加第二套公共接口。桌面测试仍由一个 owner 串行运行，不能把多个可见 Electron 的争用结果用于性能验收。

## 性能门槛

沿用 `implementation-plan.md` §10 的固定负载：30 分钟每秒唯一点击 + 64 KiB JSON，每分钟 1 MiB + checkpoint，100 ms DOM 更新。checkpoint P95 ≤2 s、摘要 P95 ≤500 ms、job 提交 P95 ≤300 ms；主进程 RSS 1 GiB、页面 private 512 MiB 是测试保护上限；已确认原件零丢失。不得减少负载/flush 承诺换通过。

S0 小 fixture 的 rrweb 录制耗时、序列化字节、反复 seek 分位及 renderer/主进程内存记入原型报告；这是短原型的实测基线，不能外推 30 分钟增长趋势。分通道队列峰值、持久吞吐、replay worker 内存尚需 A 的真实流水线测量后由 owner 冻结新增门槛；本次不伪造通用零增长阈值。
