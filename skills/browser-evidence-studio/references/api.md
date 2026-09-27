# API 使用

本参考随安装包保存，所需常用路由和字段在此可直接读取。开发仓库另有完整 `docs/api.md`；安装包不要求能访问开发目录。固定交接先按 [handoff.md](handoff.md) 核对实例与授权，再调用 `/v1/capabilities`。

| 用途 | 方法与最小请求 |
| --- | --- |
| 发现 | `GET /v1/health`、`GET /v1/capabilities` 只需当前连接 Bearer；`GET /v1/state?authorizationId=...` 返回授权裁剪后的 session、可选活动 run、页面、generation 与 lease |
| 固定资料 | `POST /v1/projects/:projectId/query/materialRevision` 传 `authorizationId/revisionId/contentHash`；`materialCollection` 另传 `kind:"revision"/collection/limit/maxBytes` 和本次分页 `cursor` |
| 现场页面 | `GET /v1/sessions/:sessionId/pages?authorizationId=...`；`GET /v1/sessions/:sessionId/snapshot?authorizationId=...&pageId=...&generation=...`。无录制可用；只读 GET 可省略 project/profile，若提供必须匹配。核对授权的 page/target/origin 与撤销状态，不要求写 lease。旧 `/runs/:runId/...` 对应路由仅接受当前活动 run |
| 历史证据 | `GET /v1/runs/:runId/summary?authorizationId=...`、`gaps`、`events`、`checkpoints`、`artifacts`，随后按 ID 有界读正文；须有 `history-read` |
| 页面动作 | `POST /v1/sessions/:sessionId/actions` 传 `authorizationId/projectId/profileId/pageId/generation/leaseEpoch/type` 和受支持参数；需 `page-act`，人工持有控制权时拒绝；无录制时写 session audit，旧 run 对应路由仍要求精确活动身份 |
| 后台页面 | `POST /v1/sessions/:sessionId/pages` 传 `authorizationId/projectId/profileId/pageId/generation/leaseEpoch/startUrl`；需 page-create 及目标来源域授权。返回新 page/target/generation，不切换前台，不开启示范 |
| 固定版验收 | `POST /v1/validations` 传 `authorizationId/projectId/sessionId/profileId/pageId/leaseEpoch/materialRevisionId/materialContentHash/input`，当前页模式另传 generation；停录后的 session 可独立启动。已有活动 run 可用 `/v1/runs/:runId/validations`。保存 jobId，查询终态后读实际 validationId 结果 |
| 独立资料评估 | 执行结束后，`POST /v1/projects/:projectId/query/executionItems` 传 `authorizationId/executionId/collection:"datasets"/limit/maxBytes`，从持久结果取得 `executionId/attemptId/datasetId`；`POST /v1/projects/:projectId/operations/assessExecution` 传 `authorizationId/executionId/datasetIdentities:[{executionId,attemptId,datasetId}]`，轮询 job，保存返回的 `reportId/overall` |
| 评估报告 | `POST /v1/projects/:projectId/query/executionReport` 传 `authorizationId/executionId/reportId`；`executionReportItems` 另传 `collection:"requirements"` 或 `"datasets"`、`limit/maxBytes`，逐项核对机器结论和来源状态 |

普通 Puppeteer 工作流的文件形状与 reporter 接口见 [workflow.md](workflow.md)，验收顺序见 [validation.md](validation.md)。路径 `/v1` 已写入上表；不要重复附加此前废弃的一次性启动授权字段。

## 固定示范节点与历史定位

以下是同步只读 `POST /v1/projects/:projectId/query/<operation>`，直接返回结果，不返回 jobId。需本项目 `history-read` 授权；不要求实时 session、写 lease 或活动录制。请求公共部分为 `{authorizationId,maxBytes:24576,limit:10}`；路径中的 projectId 为准。

| operation | 另传的请求字段 | 返回 |
| --- | --- | --- |
| `historicalState` | `position`：直接使用固定卡片 `anchor` 或字段 `target.position` | `{position,reliability,gaps,viewport}`；状态摘要，不是完整 DOM |
| `historicalNode` | `target`：直接使用固定字段或注释的完整 `target` | SourceNode：`ref/tagName/namespaceURI/documentUrl/baseURI/attributes/properties/text/metadataComplete`，可能含 `presentation` |
| `historicalLocators` | 相同 `target`，续页传上次 `nextCursor` 为 `cursor` | `{items,nextCursor?,returnedBytes,outputTruncated}`；每项有 `steps/source/historical/live/warnings` |

`position` 完整形状为 `{recordingId,pageId,documentId,streamEpoch,sourceTimeMs,eventSeq}`；DOM `target` 为 `{kind:"dom-node",position,frameId,mirrorScopeId,nodeId}`。直接传从固定资料读到的对象，不从 nodeId、时间、当前 live 页或文件路径拼造身份。`historicalNode` 不接受 visual-region。

SourceNode 的属性、文本和源 URL 使用 `{status:"present",value:...}`、`{status:"absent"}` 或 `{status:"redacted"|"missing"|"unsupported",reason}`。缺失与空字符串不同。`presentation` 若 present，其 value 含 `text/visibility/sampledAt/rect/basis`；只有该事件边界上的真实可见采样才表示显示值。定位器 `steps` 为 `{kind:"frame"|"shadow"|"target",strategy:"css"|"xpath",expression}` 数组；`historical.status` 说明历史唯一性，`live.status:"not-live-checked"` 不证明当前页面仍有效。

节点/状态超过预算明确返回 413，不能当作空节点；定位器按 cursor 分页。源不可用、结构有 gap 或元数据不完整时保留实际状态，不从变形回放 DOM 或当前页面回填过去。来源证明结构与这些历史引用是不同协议，见 [workflow.md](workflow.md#来源证明的完整形状)。

从客户端显示的 `connection/agent-connection.json` 读取 `address/token`，请求统一带 `Authorization: Bearer ...`。连接每次启动变化。不要打印连接对象、认证头或寻找内部 CDP 端口。401 时重读已知连接文件一次；连接失效时检查客户端是否启动，不改 profile 或锁文件。

开发诊断入口 `output/dev/latest.json` 的 `summary` 指向本次 `launch.json`；其中有日志、数据根、`connection` 和 `lifecycleLatest` 的绝对路径（路径位于 `files`）。先读摘要和日志末尾。Forge 的 `running` / 退出码 0 不证明应用就绪；应用需由 health 确认。连接文件的 `createdAt`、生命周期的 `startedAt` 应不早于 launch.startedAt，连接与 health 的 `instanceId` / `processId` 应相同，生命周期 `processId` 也应匹配。时间或身份不符表示旧实例或关联未确认，不把它报告为本次启动成功；不可为查连接自动重启用户客户端。此入口不含 token，历史 `npm start` 的控制台不能补录。默认 Windows 开发连接路径为 `%APPDATA%/BrowserEvidenceStudio-dev/connection/agent-connection.json`，自定义 `BES_DATA` 优先以启动摘要或用户提供路径为准。

写操作 JSON 不超过 64 KiB。业务发现和读取带当前 `authorizationId`，按项目与能力裁剪；health/capabilities 只需实例 Bearer。设置稳定 `Idempotency-Key`，收到 202 后保存 jobId，再用 `/v1/jobs/:jobId?authorizationId=<原任务授权>` 查询。202 是受理；即使启动验收的 job 已 succeeded，也须继续读取返回 validationId 对应的实际执行结果。超时重试原 key 和原内容；改变请求应创建新 key。取消 job 的 JSON 体带原 `authorizationId`；`cancellationRequested` 不是停止确认。授权撤销或过期后不能从 job 缓存读取结果。

读取顺序为 run summary、gaps、选定 events/checkpoints、artifact。列表默认 8 KiB，正文默认 4 KiB；先用字段投影与 JSON path，确有需要才增加预算，跟随 nextCursor。不重复全量读取。`STALE_CURSOR` 表示索引代际变化，从原查询重开；不要修改或猜造游标。

`GET /runs/:runId/artifacts/:artifactId?jsonPath=/field/0` 返回 present/null、missing 或解析失败，不能合并为“无数据”。文本片段按 UTF-8 分页，binary 单独走 `/content`，不要请求或生成 base64。

capabilities 的 `pageCommands.session.requiresRecording=false` 明确无录制入口，`pageCommands.run.requiresCurrentRecording=true` 明确旧 run 实时路由的限制。409 的旧控制权/错误页面需要重新读取状态并重新判断当前授权；不能直接换成较新的 lease 继续盲目点击，也不能改用封存 runId。未知 action/eval/CDP 路由不属于公共协议。
