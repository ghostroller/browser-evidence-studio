# API 使用

本参考随安装包保存，所需常用路由和字段在此可直接读取。开发仓库另有完整 `docs/api.md`；安装包不要求能访问开发目录。固定交接先按 [handoff.md](handoff.md) 核对实例与授权，再调用 `/v1/capabilities`。

| 用途 | 方法与最小请求 |
| --- | --- |
| 发现 | `GET /v1/health`、`GET /v1/capabilities` 只需当前连接 Bearer；`GET /v1/state?authorizationId=...` 返回授权裁剪后的活动 run、页面、generation 与 lease |
| 固定资料 | `POST /v1/projects/:projectId/query/materialRevision` 传 `authorizationId/revisionId/contentHash`；`materialCollection` 另传 `kind:"revision"/collection/limit/maxBytes` 和本次分页 `cursor` |
| 现场页面 | `GET /v1/runs/:runId/pages?authorizationId=...`；`GET /v1/runs/:runId/snapshot?authorizationId=...&pageId=...&generation=...`。只读 GET 可省略 `projectId/profileId/sessionId`；若提供，必须匹配当前身份。服务仍核对授权的 run、page、target、origin 与撤销状态 |
| 历史证据 | `GET /v1/runs/:runId/summary?authorizationId=...`、`gaps`、`events`、`checkpoints`、`artifacts`，随后按 ID 有界读正文；须有 `history-read` |
| 页面动作 | `POST /v1/runs/:runId/actions` 传 `authorizationId/projectId/profileId/sessionId/pageId/generation/leaseEpoch/type` 和该动作的受支持参数；需 `page-act`，人工持有控制权时拒绝 |
| 固定版验收 | `POST /v1/runs/:runId/validations` 传 `authorizationId/projectId/sessionId/profileId/pageId/leaseEpoch/materialRevisionId/materialContentHash/input`；保存返回的 jobId，经 `/v1/jobs/:jobId?authorizationId=...` 查询终态，再读实际 validationId 结果 |

普通 Puppeteer 工作流的文件形状与 reporter 接口见 [workflow.md](workflow.md)，验收顺序见 [validation.md](validation.md)。路径 `/v1` 已写入上表；不要重复附加此前废弃的一次性启动授权字段。

从客户端显示的 `connection/agent-connection.json` 读取 `address/token`，请求统一带 `Authorization: Bearer ...`。连接每次启动变化。不要打印连接对象、认证头或寻找内部 CDP 端口。401 时重读已知连接文件一次；连接失效时检查客户端是否启动，不改 profile 或锁文件。

开发诊断入口 `output/dev/latest.json` 的 `summary` 指向本次 `launch.json`；其中有日志、数据根、`connection` 和 `lifecycleLatest` 的绝对路径（路径位于 `files`）。先读摘要和日志末尾。Forge 的 `running` / 退出码 0 不证明应用就绪；应用需由 health 确认。连接文件的 `createdAt`、生命周期的 `startedAt` 应不早于 launch.startedAt，连接与 health 的 `instanceId` / `processId` 应相同，生命周期 `processId` 也应匹配。时间或身份不符表示旧实例或关联未确认，不把它报告为本次启动成功；不可为查连接自动重启用户客户端。此入口不含 token，历史 `npm start` 的控制台不能补录。默认 Windows 开发连接路径为 `%APPDATA%/BrowserEvidenceStudio-dev/connection/agent-connection.json`，自定义 `BES_DATA` 优先以启动摘要或用户提供路径为准。

写操作 JSON 不超过 64 KiB。业务发现和读取带当前 `authorizationId`，按项目与能力裁剪；health/capabilities 只需实例 Bearer。设置稳定 `Idempotency-Key`，收到 202 后保存 jobId，再用 `/v1/jobs/:jobId?authorizationId=<原任务授权>` 查询。202 是受理；即使启动验收的 job 已 succeeded，也须继续读取返回 validationId 对应的实际执行结果。超时重试原 key 和原内容；改变请求应创建新 key。取消 job 的 JSON 体带原 `authorizationId`；`cancellationRequested` 不是停止确认。授权撤销或过期后不能从 job 缓存读取结果。

读取顺序为 run summary、gaps、选定 events/checkpoints、artifact。列表默认 8 KiB，正文默认 4 KiB；先用字段投影与 JSON path，确有需要才增加预算，跟随 nextCursor。不重复全量读取。`STALE_CURSOR` 表示索引代际变化，从原查询重开；不要修改或猜造游标。

`GET /runs/:runId/artifacts/:artifactId?jsonPath=/field/0` 返回 present/null、missing 或解析失败，不能合并为“无数据”。文本片段按 UTF-8 分页，binary 单独走 `/content`，不要请求或生成 base64。

409 的旧控制权/错误页面需要重新读取状态并重新判断当前授权；不能直接换成较新的 lease 继续盲目点击。未知 action/eval/CDP 路由不属于公共协议。
