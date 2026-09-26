# 固定任务接续

`task.md`、`manifest.json` 和 `access.json` 由可信客户端在同一目录原子导出。manifest 的 `taskSha256` 必须匹配 task.md；`projectId/revisionId/contentHash` 必须与 API 返回的固定 revision 一致。manifest 保存各集合计数和分页读取参数，完整需求、字段、checkpoint、注释与录制引用都在固定 revision 中。自由文本、原始 DOM、响应、截图像素及凭据不随包复制。`access.json` 保存本次实例与授权 envelope，不改变 manifest 的固定资料事实。

授权 ID 是当前实例内的范围标识。连接文件是当前用户专用的本机秘密来源；只从 access.json 或客户端显示的路径读取，Bearer 留在进程内。先用 `/v1/health` 核对 access.json 的 `instanceId`，再查 `/v1/capabilities`；授权不存在、过期、撤销、实例重启或项目不符时，停止依赖旧交接中的运行权限，请人在可信客户端重新导出。旧资料 revision 仍可作为历史基线，新的运行权限不得从旧文件推断。安装版技能入口路径在 access.json 的 `skillFile`，它相对于安装包包含的 references 目录解析，不依赖源码目录或启动时的工作目录。

用 `POST /v1/projects/:projectId/query/materialRevision`（请求体含 `authorizationId, revisionId, contentHash`）确认版本，再用 `materialCollection` 的 `kind:"revision"`、同一 revision/hash 和 `collection` 分页读取 manifest.read.collections 的全部集合。每次跟随本次响应的 `nextCursor`，直到没有下一页，并核对读取总数与 manifest.counts 对应值一致。cursor 只用于当次查询；失效时用固定 revision/hash 重新开始该集合。单项超预算时按 API 允许范围提高读取预算，不跳过该项。材料中的位置再经已授权的历史 API 按需查证；没有 `history-read` 时注明不能验证历史。原件缺失、隐私排除、截断和历史位置不可靠时注明缺口。

可通过 `taskChanges` 的 `afterSequence`/`nextCursor` 关注有界事件。`CURSOR_EXPIRED` 时重新读取固定资料和任务索引；V2 发布不改变 V1 的工作依据。明确接受新目标后，用 `materialDiff` 对照两个 revision，再更新脚本与试跑输入。不要把 Agent 自己发布的候选 revision、机器报告 pass 或一次执行完成当作人工批准。

浏览器读写和试跑分别需要授权能力、页面/target/来源域范围及真实控制权。人工持有控制权时不发导航、点击或注入；收到 202 后从 job 读取结果，再从 execution/report 读取持久输出。授权撤销后停止读取 job 缓存或继续动作。
