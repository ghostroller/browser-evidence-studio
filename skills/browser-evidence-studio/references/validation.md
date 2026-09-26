# 原生脚本与验收

脚本目录由客户端可信项目设置登记。HTTP 启动请求只传输入和已登记对象，不接受任意磁盘路径或代码字符串。维护 `workflow.json`、普通 JavaScript 入口、输入/输出 schema 与锁文件；具体字段以项目 `src/contracts/workflow.ts` 为准，参考 `examples/orders` 的实际目录内容后再复用。

入口为 `run({page,input,reporter})`，业务执行用原生 Puppeteer。分支、循环、分页和等待写在入口代码。reporter 仅承担 checkpoint、emitData、attachArtifact、assertion、requestHuman、progress 与取消信号；不另做 Page 抽象、不引入运行时 LLM 自愈、不创建绕过受管闸门的浏览器连接。

checkpointKey 与 requirementId 稳定对应。结构化输出声明 sourceRefs/origin 和分页完成依据。Node 请求的来源材料通过 reporter 附入；没有来源或未覆盖时应判证据不足。至少检查实体身份、必填/类型、重复、分页终止和跨记录关联；“非空”不能替代正确性。

每个数据集完成并取得来源后立即 await emitData，同名只提交一次；不要等整个流程结束才保存所有数据。后续失败时保留已完成材料，未完成阶段不补空占位，执行失败仍不得验收通过。遇到断线报告先读 `errorSource`、`error` 与 `operationTransportClose`（必要时有界读取 `errorStack` / `operation-transport-closed` 事件）；worker 本地主动关闭可能是异常清理，不能直接推断网络、登录或租约失败。旧报告没有这些字段时保留未知。

需要人工协助的点在 manifest 中声明。requestHuman 在 transport 闸门静默后等待，完成条件由脚本给出。不要注入跨交接继续点击的定时器。强制接管会停止 runner，不承诺恢复原执行栈；从显式恢复入口或新 run 重试。

通过 `/runs/:runId/validations` 启动当前登记版本。用户先在可信客户端签发含 `execute` 能力的任务授权；agent 用 `authorizationId` 查询当前 `/state` 和固定资料版本，再提交 `authorizationId/projectId/sessionId/profileId/pageId/leaseEpoch/materialRevisionId/materialContentHash/input`。旧 `startGrantId` 和 `/validation-start-grant` 已退出 HTTP 协议；持久事件中的旧 grant 不能恢复为授权。没有任务授权时由用户在客户端明确授予，不能自行调用 UI 授权代替用户同意，也不能用 `/control` 或任意布尔参数绕过 human guard。

重试同一启动保留相同 Idempotency-Key；用原授权 ID 轮询 job，202 不是启动成功。取消仍在排队或准备的启动用该 job 的 `/cancel` 并传原 `authorizationId`，不会停止其他执行。授权撤销后不能再读取缓存结果；历史结果通过新的有效结果读取授权和固定执行身份查询。启动成功后跟踪返回的 **新 runId** 和 `id`（validationId）；继续停止脚本用该 run 的 `/stop`。检查实际执行状态、逐需求结果、前后指纹、入口、退出、checkpoint 和数据来源。代码、构建、配置或锁文件变化后，旧 pass 只代表历史版本；受影响 checkpoint 必须重新验证。详细说明见项目 `docs/api.md` 的“任务授权下启动验收”。

机器结论与人工评审分开保存。评审使用 accept/reject/exception、原因和范围，不能覆写机器失败。交付报告明确通过、不通过、未覆盖、证据不足，以及真实场景尚未验证的项目。

工具验证先用合成站点。最终真实拼多多演示与扫码需事先与用户协调时间，且只能操作明确授权的账号环境。不要修改原 `agent-browser-evidence`、业务插件或宿主，不把真实录制/profile 放入代码仓库。最终业务脚本应另有普通 Node/Puppeteer 启动入口，可脱离客户端和 LLM 执行。
