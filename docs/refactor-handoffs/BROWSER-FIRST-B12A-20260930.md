# B1.2a：隔离工作台传输核心交接

日期：2026-09-30（UTC）。关联[阶段计划](../browser-first-refactor-plan.md)、[B1.1](BROWSER-FIRST-B11-20260930.md)。

## 范围

本切片新增独立 session／dispatch／HTTP／SSE 核心及纯内存合成测试，尚未接入 app、preload、renderer、Vite 或真实业务资源。创建 transport 对象不监听端口；只有测试显式 start 后才绑定动态 IPv4 loopback。**不代表真实工作台已联网，不代表现有 Agent API 获得 UI 权限。**

共新增 9 个 src/test 文件：`src/contracts/browser-workbench.ts`，`src/main/workbench/` 下 `session.ts`、`dispatch.ts`、`http.ts`、`validation.ts`、`errors.ts`，以及 `test/unit/workbench-{session,dispatch,http}.test.ts`。没有生产入口、数据格式、旧 profile 或 package 改动；本切片未 build、未做 GUI 验收。

最终修后候选已通过开发自测、整合检查及独立安全复验；本片无剩余已发现阻断项。代码分两提交：session／dispatch `19aac02`，HTTP／SSE `454e21e6ec704db92d1d49cfc8443ab03a4ce9a8`。9 个新增源码／测试文件前后 SHA-256 一致，manifest 汇总为 `949a29bf571a9734bf4201718eb31a1a30ea17f293aeaa73fe836f6404afc86c`；该摘要只覆盖本片 9 文件，不是整库或构建指纹。

## 接口与权限边界

- `WorkbenchSessions`：可信持有者调用 begin 签发一次性票据，exchange 绑定当前 instance/project；只存内存摘要，无磁盘、续期、公开签发或撤销路由。票据在容量拒绝时也已消费；epoch、撤销和到期使旧 context 失效
- `WorkbenchDispatcher`：仅接受 `state` 与项目 name/objective 更新，严格 envelope/body 字段白名单；不接受 `source:'ui'`、scriptDirectory、其他方法或跨项目请求；输出只投影 id/name/objective/revision
- `ProjectMetadataPort`：必须在实际业务队列执行边界同步调用一次 `permit.start`，再次检查身份与取消。尚未开始的操作可取消；已开始的原子写允许完成，不能伪报回滚。版本冲突与 operationId 的持久业务幂等仍由 port／既有事务负责，传输层不重试、不去重、不新增业务持久化
- 仅三个 POST 路径：`/workbench/session`、`/workbench/rpc`、`/workbench/events`。精确校验 Host、固定 loopback Origin、instance header/body、JSON 类型及重复安全头；不开放 OPTIONS、查询参数、静态文件或任意 RPC
- 必须有 Fetch Metadata：Site=same-origin、Mode=cors/same-origin、Dest=empty。RPC／事件先认证再分配 body；错误仅返回固定 code，不回显异常、请求或凭据。该条件面向后续受保护同源代理，尚未证明真实 Vite 代理可用
- SSE 使用认证 POST 流，只通知本 project 的 `{projectId}` 失效事件，无状态、凭据或事件积压回放。撤销、到期、断连、背压和 dispose 均清理；客户端重连后重新读状态的流程留给 B1.2b

## 已实现预算

| 项目 | 默认值／边界 |
| --- | --- |
| 票据／会话 TTL | 60 秒／5 分钟；会话可配置上限 15 分钟，无自动续期 |
| 票据／会话容量 | 各 8；可配置上限各 64 |
| exchange 尝试 | 60 秒窗口最多 32 次，包含无效尝试 |
| RPC／请求并发 | 8，可配置上限 32 |
| SSE 并发 | 全局 8、每会话 2；可配置上限 32／4 |
| 请求 body | 默认 16 KiB，可配置上限 64 KiB；另限 JSON 深度 6、节点 64 |
| header／socket | header 8 KiB，最多 48 个连接，keep-alive 1 秒 |
| body 接收／头时限 | 配置默认 5 秒、上限 30 秒；头过期按 `min(配置, 1000ms)` 周期检查，实际为配置时限加最多一个检查周期及事件循环调度延迟，默认约 6 秒而非严格 5 秒 |
| 字段／响应 | ID 最长 128，name 200，objective 4,000（JS 字符串长度）；结果投影且字段有界，**没有 16 KiB 响应硬上限** |

独立响应探针用合法边界字符串得到 25,268 字节 JSON，证实请求字节预算不能作为响应硬上限声明。上述接收时限不是业务执行总 deadline：若注入的 port 永久忽略 signal 且不 settle，相应并发槽仍占用，不放槽堆积新任务；真实业务 port 必须负责其队列清理。

## 审查发现与验证范围

1. 初始 start/dispose 竞态：立即 dispose 后 start 仍成功、listener 存活，计数却为 0。修为共享启动／销毁完成边界；独立复验 start 拒绝、listener=false、socket/request/stream 均 0
2. 初始缺 Fetch Metadata 检查；补齐必需值与重复头拒绝。独立 cross-site 请求 403，raw TCP 的 Host/Origin/Content-Type/Authorization/instance/Site/Mode/Dest 八类重复安全头均 403
3. 独立半截 header 反例：配置 150ms，但 400ms 后仍占 socket；原因是 Node 默认连接检查周期。已显式限制扫描周期，新增真实 TCP 半截头回归，在 150ms 时限 + 最多 150ms 扫描 + 300ms 调度容差内要求连接关闭且无业务写；独立旧反例重跑在 400ms 观察到 closed=true、socket=0
4. 独立纯内存 loopback 检查已覆盖缺认证、错误 authority/instance/scope、未知或多余字段、source 越权、过大／过深输入、私有输出投影、排队断连不写、已开始写不伪回滚，以及 SSE scope、撤销、自动到期、慢读背压和清理

最终复测：匹配 Node 24.21.0／npm 11.19.0；typecheck 退出 0，整合检查 7 文件 56 项通过（本片 session 10／dispatch 13／HTTP 14，共 37 项；既有 client、UI IPC、API boundary、test-mode 共 19 项）。独立审查 再跑本片 37 项通过，并复跑 3 个仓库外反例 harness；diff 检查通过。此前 36 项批次属于增加半截 header 回归前的历史结果，不覆盖最终候选。

整合复跑入口如下；本轮整合结果来自执行输出，未另保存日志附件。

```sh
npm run typecheck
npm test -- test/unit/workbench-session.test.ts test/unit/workbench-dispatch.test.ts test/unit/workbench-http.test.ts test/unit/workbench-client.test.ts test/unit/ui-ipc.test.ts test/unit/api-boundary.test.ts test/unit/test-mode.test.ts
git diff --check
```

尚未验证真实 Vite／React 配对、HTTP WorkbenchClient、持久业务 port、完整应用生命周期或 GUI。纯内存 fixture 的 operationId 对照不证明生产幂等已经实现。本切片不修改[Electron 对话框所有权问题](ELECTRON-DIALOG-LIFECYCLE-20260930.md)的策略；该产品取舍仍待用户决定。

## 后续与证据

下一切片 **B1.2b** 才将受保护的合成 companion、真实 UI 一次配对、同源代理与 client 接入应用。接入前明确真实 port 的队列 start 边界、版本／幂等、会话关闭、重连刷新和错误呈现，不把 fixture 的权限扩大为真实资源访问。

独立反例产物目录名为 `b12a-review-security-20260930`，含 `final-headers-sse-result.json`、`final-lifecycle-result.json`、`final-boundaries-result.json`、`final-unit-tests.log`、`final-before.sha256`。它位于本轮临时环境而非仓库附件，原始脚本／JSON 不入库，跨环境不保证可访问。后续只继承被验证内容，不继承旧批次通过。
