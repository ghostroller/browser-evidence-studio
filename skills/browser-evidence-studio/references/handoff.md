# 固定任务接续

`task.md` 和 `manifest.json` 是同一次可信客户端导出的固定交接。manifest 的 `taskSha256` 必须匹配 task.md；`projectId/revisionId/contentHash` 必须与 API 返回的固定 revision 一致。manifest 保存结构化需求、字段、checkpoint 和录制 ID；自由文本、原始 DOM、响应、截图像素及凭据不随包复制。

授权 ID 是当前实例内的范围标识。连接文件是当前用户专用的本机秘密来源；只从交接或客户端显示的路径读取，Bearer 留在进程内。先用 `/v1/health` 核对 `instanceId`，再查 `/v1/capabilities`；授权不存在、过期、撤销、实例重启或项目不符时，停止依赖旧交接中的运行权限，请人在可信客户端续发授权。旧资料 revision 仍可作为历史基线，新的运行权限不得从旧文件推断。

用 `POST /v1/projects/:projectId/query/materialRevision`（请求体含 `authorizationId, revisionId, contentHash`）确认版本，再用 `materialCollection` 的 `kind:"revision"`、同一 revision/hash 和 `collection` 分页读取 `requirements`、`fields`、`checkpoints`、`recordingRefs`。每次保留 `nextCursor`；预算不足时缩小字段或在允许上限内增加预算，不重复输出大正文。录制源按 manifest 的位置及 API 的历史查询逐步定位；原件缺失、隐私排除、截断和历史位置不可靠时注明缺口。

可通过 `taskChanges` 的 `afterSequence`/`nextCursor` 关注有界事件。`CURSOR_EXPIRED` 时重新读取固定资料和任务索引；V2 发布不改变 V1 的工作依据。明确接受新目标后，用 `materialDiff` 对照两个 revision，再更新脚本与试跑输入。不要把 Agent 自己发布的候选 revision、机器报告 pass 或一次执行完成当作人工批准。

浏览器读写和试跑分别需要授权能力、页面/target/来源域范围及真实控制权。人工持有控制权时不发导航、点击或注入；收到 202 后从 job 读取结果，再从 execution/report 读取持久输出。授权撤销后停止读取 job 缓存或继续动作。
