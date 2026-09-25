# F 交接：T11 固定资料验收后端（2026-09-26）

当前是独立领域与真实文件服务集成包，**尚未接入生产 main/HTTP/renderer、真实 Electron 运行或人工验收入口**。不得把下述 Node 模块测试写成端到端完成。

## 所有权与实际基线

- 原生任务 `/root/refactor_f`，启动配置由 root 实际传入 `gpt-6-astra/high`，fork none；本任务未创建子 Agent。
- 工作树 `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-F`，分支 `codex/refactor-f-20260926`，初始 HEAD `dedb272e6554a134236617e3a4033f0a3ab549ad`，初始 clean。未建第二工作树，未重置 S0。
- 本包独写 `src/validator/**`、`test/unit/validator-materials.test.ts` 和本文件；未修改 runner/validation、共享契约、main/preload/renderer、package/lock 或共享进度文档。
- 实测 Node `v24.21.0` / npm `11.19.0`。`BES_DATA` 为本树 `output\data-F`，独立 node_modules/cache，无真实账号、profile 或原件进入 Git。
- root 明确授权接入 B：`b762786→4f20933`、`7ee2ab0→8a3a482`；后续共享来源契约 `d9d77ab→29a1c81`；C 原件有界读与不可覆盖修复 `3054353→a6fc4be`、`961aefc→4bb5f4b`。主集成不要重复应用这些等价依赖提交。
- Git 写元数据最初因 sandbox permission denied 失败，使用正常 `require_escalated` 获准执行以上 cherry-pick；只用命令级 exact safe.directory，未改全局配置。基线缺 B.md，获 root 接入 B handoff 后已读取。一次本地编辑脚本因 Windows 默认 GBK 解码失败，改显式 UTF-8 后执行；没有测试失败被掩盖。

## 实际实现

`ValidatorService(materials, datasets, sources?, reviews?).validate(request, budget)` 从真实 `PersistentDatasetService.binding` 定位 B 不可变 revision/hash，并再次核对内容 hash。脚本不能传入替代 requirement 集合；新发布 V2 不影响旧 execution 的 V1 目标。

`ValidationRequest.attemptId` 是 workflow attempt。`datasetIdentities?` 由可信宿主从持久结果选择，支持 orders/list、details 等不同 step attempt；同 dataset 只能明确选择一个 attempt，禁止跨 execution 或重复选择，显式集合缺少某个需求数据集时保留 unselected，不猜 latest/合并历史。未提供集合时只查询明确的 workflow attempt（旧 emitData 路径）。来源记录始终校验实际 dataset attempt，而不是用 workflow attempt 覆盖。

数据通过 C 的 `summary/batches/batchMetadata/records` 有界读；batchMetadata 校验真正原件内容/hash/reusedFrom。无私有路径读取、无隐式 rebuild。失败和预算耗尽保留已读记录统计及错误原因；partial/unfinished/cancelled 不升级完整验收。显式复用保留 prior attempt，当前尚无冻结的有效性规则，因此不能升级为当前内容核验通过。

结果分为 `schemaVerdict`、`sourceVerdict`、脚本 assertions、可信 UI reviews、实际 snapshot/input 版本检查及整体 verdict。只检查格式不等于业务通过，reference-exists 不等于 content-verified；脚本 complete/pages/terminalReason 只记录为声明。人工接受/例外不覆盖机器失败；版本/执行/attempt 不匹配的 review 不应用。当前没有人工资料批准端口，报告明确 `materialStatus: candidate`，不因作者 human/agent 推测批准。

冻结字段 `name` 仅显示名，`outputPath` 用 RFC6901。`sourceProof=json-record` 比较真实请求 URL、实体键和字段值，不采信脚本任选的 JSON Pointer。`sourceUrl` 仅移除冻结的 pageParameter；filter/variant/其他 query/路径/origin 不忽略，带 hash/凭据拒绝。源字段索引按实体复用，避免每行重新扫描全量来源。

分页 `numbered-pages` 检查请求页参数与响应页号、从第一页开始连续覆盖、各页总量一致、明确 total-pages 或 has-next-and-total 终态、捕获实体集合与输出实体集合完全一致。漏最后一页/total 改变/重复实体保留不足或失败原因；只要固定分页内容证明完整，即使没有字段卡也可通过该范围。无冻结 proof 不伪造业务终态规则。

`page-displayed` 不能由网络 JSON 或节点存在升级证明。当前冻结 sourceProof 只有 JSON，DOM 可见性及遮罩原样显示的独立证明尚未接入，因此该策略保守 inconclusive。collector `redacted/missing/unsupported` 与 null/空字符串分开；不会补全遮罩敏感值。历史字段 target 是样例，不作为固定常量。

## 生产来源适配端口

`CapturedJsonSourceReader(locate)` 已使用真实 `EvidenceReader.artifactMetadata/artifact`，只接受 captured `response-body` JSON；请求 URL/requestKey 来自原件 metadata，正文使用现有 hash 校验和 16 KiB 续读。缺失、截断、读取失败、非 JSON、错误 byte count 均明确报告；不会调用 sourceRefs 内 URL 上网补取。

`locate(ref)` 必须由 E 的可信持久 execution/step attempt→recording 映射返回 `{reader,scope:{executionId,attemptId,recordingId}}`。此映射不是脚本可提交的“known refs”数组。`SourceReader.read()` 产出的 `requestUrl/content/capturedAt/scope/display` 都只能来自宿主读原件；不能将 HTTP 参数反序列化为 SourceDocument。SourceDocument 的 DOM display observed 也不能由脚本 flag 或回放节点存在合成。

E 还应从 C 实际结果的 `snapshot.sourceFingerprint`、输入指纹、snapshot 校验结果构造 `executedCodeFingerprint/executedInputFingerprint/snapshotVerified`。字段是 host attestations，不能直接从脚本或 API request 透传。F 检测 mismatch/未校验；冻结实际代码与阻止 TOCTOU 由 C snapshot 实现和 root 真实运行验收。

## 预算和报告

单次内部读取 ≤1 MiB，总读取 ≤16 MiB，≤10,000 输出行、≤500 bounded reads、≤64 数据集。材料 B 本身具有固定内容上限；F 报告最多 2000 requirements（默认 limit 500），最终 UTF-8 envelope 精确计量 ≤maxBytes（1 KiB–1 MiB）。报告不足时明确 413，绝不静默删需求。大执行达到读取预算时报告 partial/inconclusive 与已检查数量；当前不提供跨请求增量聚合验收协议。

## 实测

所有命令显式在 F 工作树执行，测试合成原件保留在 F 的 `output/data-F/validator-*` 以便审查；没有删除真实历史。

- `npm.cmd ci --cache output/npm-cache-F`：成功安装 682 packages，未升级依赖。
- `npm.cmd run typecheck`：多次退出码 0，最终记录 `output/refactor-f-20260926/typecheck-3.log`。
- `npm.cmd test -- test/unit/validator-materials.test.ts`：15/15，通过日志 `output/refactor-f-20260926/validator-tests-2.log`，5.39 秒。
- 受影响组合 `npm.cmd test -- test/unit/validator-materials.test.ts test/unit/runner-datasets.test.ts test/unit/material-source-contracts.test.ts`：3 文件、29/29 通过，13.07 秒；`output/refactor-f-20260926/affected-tests.log`。

测试覆盖：真实 B 发布/后续 V2 与 C 数据批；删脚本 requirement 不能缩小用户目标；第一页伪造 complete；捕获末页但漏输出；无关 filter、值不符、跨 attempt；page-displayed 与 redacted；display label 不冒充 output path；codehash 改变/未核 snapshot；partial/来源异常；人工 review 不覆盖失败；旧 attempt 显式复用不冒认；报告预算；真实 EvidenceStore/EvidenceReader 20 KiB 跨片正文且篡改哈希拒绝；实际 step attempt selection；无字段卡的分页证明。

## 集成与接续

root 接入本包后按上述窄端口连接实际 C WorkflowRunResult（workflowAttemptId/datasetSummaries/snapshot）与真实录制 reader，再跑真实 A/C synthetic workflow。尚未运行 Electron/物理输入/soak，不占用桌面槽位。E/D 结果 UI、任务授权、资料批准/人工 review store、报告持久化与发现端口仍由主控接入；本包不新增共享/HTTP 公共接口。F 持续参与 root 审查返修，直到真实模块组合验收接收。

## root 首轮审查返修（cae5e6e 之后）

首包提交 `cae5e6e77417049fa481c4850ed3410fc60877d8`；本次从该 clean HEAD 原树接续，没有重建工作树。

- A 生产响应的 `artifact.metadata.privacyRedacted=true` 或 `representation=privacy-redacted-response` 任一标记存在时，CapturedJsonSourceReader 将整正文表示为 `redacted`。保存的 `[redacted]` 是采集器替换结果，不能因输出相同而声称观察到原始值；当前采取整正文保守不足，不猜测未遮罩字段。
- `outputPath=''` 是合法 RFC6901 根指针，只有 undefined 才是未配置；字段来源与类型检查统一。类型不匹配仍失败，不跳过根输出检查。
- 增加真实 EvidenceStore 两类隐私 marker 测试、根指针来源通过/类型错误失败测试；原生产 reader fixture 改为中文与 emoji 混排的约40 KiB正文，明确核对跨16 KiB续读完整值，继续保留篡改 hash 检测。
- `npm.cmd run typecheck` 通过；`npm.cmd test -- test/unit/validator-materials.test.ts` 17/17，通过耗时5.69秒。日志：`output/refactor-f-20260926/typecheck-review-fix.log`、`validator-review-fix.log`。未启动 Electron；生产端口接入边界不变。
