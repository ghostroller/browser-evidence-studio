# API 使用

完整路由和字段见项目 [docs/api.md](../../../docs/api.md)。需要精确路由时读取它，不把整套设计文档加载进每个请求。首次使用先调用 `/v1/capabilities` 核对当前实例。

从客户端显示的 `connection/agent-connection.json` 读取 `address/token`，请求统一带 `Authorization: Bearer ...`。连接每次启动变化。不要打印连接对象、认证头或寻找内部 CDP 端口。401 时重读已知连接文件一次；连接失效时检查客户端是否启动，不改 profile 或锁文件。

写操作 JSON 不超过 64 KiB。设置稳定 `Idempotency-Key`，收到 202 后保存 jobId，再查询 `/v1/jobs/:jobId`。202 是受理；即使启动验收的 job 已 succeeded，也须继续读取返回 validationId 对应的实际执行结果。超时重试原 key 和原内容；改变请求应创建新 key。取消后查询实际状态，`cancellationRequested` 不是停止确认。

读取顺序为 run summary、gaps、选定 events/checkpoints、artifact。列表默认 8 KiB，正文默认 4 KiB；先用字段投影与 JSON path，确有需要才增加预算，跟随 nextCursor。不重复全量读取。`STALE_CURSOR` 表示索引代际变化，从原查询重开；不要修改或猜造游标。

`GET /runs/:runId/artifacts/:artifactId?jsonPath=/field/0` 返回 present/null、missing 或解析失败，不能合并为“无数据”。文本片段按 UTF-8 分页，binary 单独走 `/content`，不要请求或生成 base64。

409 的旧控制权/错误页面需要重新读取状态并重新判断当前授权；不能直接换成较新的 lease 继续盲目点击。未知 action/eval/CDP 路由不属于公共协议。
