# B（T06）交接：项目资料、草稿和不可变版本

状态：B 模块实现与本工作树单测通过；A 的真实源定位、E 的 HTTP/UI 接入、F 的固定资料验收未在 B 工作树完成。日期：2026-09-26。

## 固定身份与提交

- 实施目录：`D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-B`；分支 `codex/refactor-b-20260926`；独立数据根 `output/data-B`。冻结起点 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`。
- 集成 owner 批准的字段绑定契约 `e3088cf` 精确 cherry-pick 为 `dc13f6f3842b26f60450338bfebbcb1c0e03bde7`。B 实现 `687e8de2ec61df4d1c51b7631fa094a30458632a`；有界读取修正 `c3f8cb92971d2931af84b82153b1437db0aeced6`；草稿/版本发现入口 `e48d98286e6b8a53fa62af98b3ce8acd7b4c084e`。最后一份 B 交接文档提交见本分支后续 commit。
- 只改 `src/materials/*`、`test/unit/materials.test.ts`、本文件。`src/contracts/materials.ts` 的两项字段通过 owner 契约提交进入；不修改原件 writer、main、renderer、根 package/lock 或共享状态文档。

## 可接入接口

入口 `src/materials/index.ts` 导出 `FileMaterialService`、`MaterialSourceVerifier`、`materialContentHash`、`copyCheckpoint`、`moveCheckpoint`、`removeCheckpoint`、`projectLegacyRecording` 及错误/摘要类型。

```ts
const materials = new FileMaterialService(dataRoot, sourceVerifier);
const draft = await materials.createDraft(projectId, 'human', baseRevisionId);
const result = await materials.updateDraft(projectId, draft.draftId, draft.draftRevision, content, 'human');
const revision = await materials.publish(projectId, draft.draftId, result.status === 'saved' ? result.draft.draftRevision : -1, 'human');
const fixed = await materials.revision(projectId, revision.revisionId, revision.contentHash);
```

`updateDraft` 在同项目材料 writer guard 下比较完整草稿版本，冲突返回 `{status:'conflict',current,expectedDraftRevision}`，不覆盖。`publish` 也检查版本，先独占创建不可变 manifest/hash，再将 draftRevision 加一并把 baseRevisionId 指向刚发布版本；同草稿连续发布 V1→V2 形成 parent 链。manifest 已保存但草稿推进失败时抛 `MaterialPartialPublishError`，包含仍可按 ID/hash 检查的 revision，不冒称完整成功。`revision` 重算内容 hash 并比对可选 expectedHash。发布者 human/agent 都不等于人工批准；B 不提供审批入口。

资料写入 `projects/<projectId>/materials/drafts/<draftId>.json` 与 `revisions/<revisionId>.json`。每项目 `materials/writer.lock` 使用既有内核 writer guard；原件 `runs/*` 只读。project/draft/revision/recording 等路径 ID 禁止 traversal、Windows 设备名、尾点与符号链接逃逸；document/frame/mirror 等逻辑源身份允许 A 的冒号格式但限制长度和控制字符。输入内容最大 2 MiB、每集合最大 2000 项，检查重复 ID、字段/需求/卡片/注释双向关联和完整目标身份。录制引用每次更新/发布均从实际 `runs/<recordingId>/manifest.json` 验证 ID、schema 和所属项目；合成 source verifier 无法绕过跨项目检查。

含 checkpoint 的新草稿更新需要 `MaterialSourceVerifier`。它的 `position` 必须查询 A 的 `ReplayService.state` 可靠性及精确 recording/page/document/streamEpoch/sourceTimeMs/eventSeq；`target` 必须核对原始 DOM 节点或 visual artifact 身份，不可仅看同 nodeId 或回放 DOM。没有 verifier 时拒绝含卡片更新（`SOURCE_VERIFIER_REQUIRED`）；缺口中的卡片不能带 `bound` 注释或字段。B 单测注入合成 verifier 仅验证服务边界，**不代表 A 的真实源定位已接入**。E 接入时仍需把 A 的真实 reader/资源验证器接上；跨 frame unsupported 必须保留为 unsupported。

`pageCollection(projectId,{kind:'draft'|'revision',id,expectedHash?},collection,budget)`、`diff`、`listDrafts`、`listRevisions` 是具体类的额外有界读取方法，尚未加入冻结 `MaterialService` 公共接口。预算 `maxBytes=1024..1048576`、`limit=1..500`；返回的 `returnedBytes` 等于整个 JSON 回执真实 UTF-8 字节数，单项超限明确 413。游标绑定查询/版本或目录代际，旧游标明确拒绝；list 按安全 ID 排序，只在内存保留下一页候选，摘要含修订/hash/作者/时间，损坏所选记录返回 `unavailable` 与原因。建议 E 默认 32 KiB、按 ID 再取有界 collection；不要把完整 `getDraft/revision` 直接序列化为 HTTP 默认响应。D 可从 list 找到重开的草稿和历史版本。

`copyCheckpoint` 生成新的卡片与注释 ID，保留原 anchor/capturedAt/target；不复制项目级要求和共享字段。`moveCheckpoint` 保留旧 target/position，对该卡片注释、显式字段绑定及同旧 anchor 的无归属字段标 `needs-rebind`。`removeCheckpoint` 保留项目需求和字段；仍有旧目标的字段变待复核。普通描述字段、字段+元素、字段+元素+注释三种路径均可保存；只有显式 `page-displayed` 来源策略才要求页面显示来源，样例不是固定值验收。

`projectLegacyRecording` 对现有 schema-1 `checkpoints.jsonl` 只读分页投影，输出 `anchorStatus:'unavailable'`，不制造新 `ReplayPosition`、源属性或资料 revision；裁剪文字/要求 ID 有 `truncatedFields`，缺失采集时间、缺失/损坏/读取失败分开显示。测试核对合成原件 hash 前后相同。旧材料要进入可绑定资料版本，须由 E/D 人工核对源能力并另建草稿；不能原位迁移真实存档。

## 实测与验收覆盖

Node `v24.21.0`、npm `11.19.0`，各命令在 B 独立工作树，`BES_DATA=...\output\data-B`；`npm.cmd ci --cache ...\output\npm-cache-B` 成功安装 682 包。默认全局 npm cache 在沙箱外 EPERM，改用本工作树独立 cache 后成功，未修改根配置。

| 命令 | 结果与日志 |
| --- | --- |
| `npm.cmd run typecheck` | 退出码 0；`output/refactor-b-20260926/typecheck.log` |
| `npm.cmd test -- test/unit/materials.test.ts` | 11/11；`output/refactor-b-20260926/materials-unit.log` |
| `npm.cmd test` | 发现接口提交后的 29 文件、172 项通过，64.85 s；`output/refactor-b-20260926/all-unit.log`。其后仅加了字段在 gap 时拒绝 bound 的领域检查与定向断言，最终源码的 typecheck/定向 11 项重新通过；未为这项领域修正重复全量测试 |

合成模块测试覆盖 AT26（移动后旧绑定需复核）、AT27（复制卡片/注释 ID 独立，原采集时间保留）、AT28（三种字段路径）、AT29（两示范共享一需求，删卡不删需求）、AT30（并发只存一方，V1 hash/内容不随 V2 改变，旧游标失效）。另覆盖跨项目录制拒绝、路径 ID、目标完整身份、发布 parent 链、读预算/精确字节、旧档不改原件。未跑 Electron/桌面或长测，留给集成 owner 串行执行。AT25 的真实可靠历史位置创建、AT26/28 的实际回放选择、AT30 的 Agent 固定 V1 读取与 E/F 验收仍待集成验证。

## 集成接续

E/D 使用具体类的发现与 collection 分页，不直接拼 materials 内部路径。E 提供真实 A source verifier，且仅可信 UI 可追加人工 review；E 的 API 错误映射保留 `DRAFT_CONFLICT`、`SOURCE_VERIFIER_REQUIRED`、`HASH_MISMATCH`、`READ_BUDGET_EXCEEDED` 和 `PUBLISH_DRAFT_ADVANCE_FAILED` 的具体语义。F 创建 execution 时固定 `revisionId/contentHash`，对发布之后的草稿变更与人工批准状态分别处理，旧执行不能随 latest 自动变为 V2 通过。B 的服务未改 HTTP/IPC 路由和执行绑定。
