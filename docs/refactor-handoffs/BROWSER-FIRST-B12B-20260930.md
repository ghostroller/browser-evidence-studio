# B1.2b：合成浏览器工作台最小纵向

日期：2026-09-30（UTC）。关联[阶段计划](../browser-first-refactor-plan.md)、[B1.2a 传输核心](BROWSER-FIRST-B12A-20260930.md)、[原始 F01–F14](../sources/library-originals-20260929/agent-ui-feedback-loop.md#6-首批验收清单)。

## 已交付与范围

真实 Electron companion、可信 UI 一次配对、同源 Vite 代理和浏览器 HTTP/SSE client 已接通。浏览器复用 React 入口、工作台 shell 与项目名称／业务目标表单；真实 UI 修改同一项目后，经既有事务落盘、事件失效通知和权威回读，Electron 可读取相同内容。**这是单项目元数据中间切片；F07 的保存点、字段、普通注释、复制和固定版本浏览器纵向尚未实现，不代表完整 B1。**

代码节点：
- `3ff4ff0`：真实项目 port、配对 IPC、窄代理、契约与边界测试
- `03cbab5`：浏览器 client、共享 shell／表单、能力与连接状态
- `7aafe72`：隔离启动器、app／preload／Vite 接入
- `81c01bb78b165cc7a3c9ac06c2e1fb9f787a4512`：仅桌面测试 helper 的原生焦点及键盘完成屏障

正常应用启动不新增工作台 listener。只有显式合成入口可启动；只接受当前用户拥有的全新空、私有、canonical 数据根，拒绝 symlink／非规范路径及原应用数据子树。没有旧数据／profile 迁移。

## 启动与权限

匹配仓库 Node/npm 后运行：

```sh
npm run build
npm run start:workbench
```

1. 启动器创建新的隔离合成根、动态 loopback 端口、Electron companion 和 Vite，输出实际浏览器 URL 与非密实例清单。`backendKind=electron-companion`、`runtimeProvider=electron`，不是纯 Node 后端
2. 在 Electron 正常 UI 创建合成项目，打开“浏览器配对”，核对项目／实例后点击“生成一次性配对票据”，将短时票据填入浏览器配对表单
3. 保持原生配对面板打开，在浏览器编辑名称／业务目标并保存。关闭／收起面板、原生窗口隐藏／最小化／重载／退出会撤销权限；刷新浏览器也会丢失其内存会话，需要重新配对
4. Ctrl+C 只结束本次启动器拥有的进程，等待 companion 正常退出；不关闭其他应用实例。每次启动都是新的合成根，不用于恢复真实工作区

票据一次性、60 秒有效；会话最长 5 分钟，无 remember、刷新凭据或自动续期。工作台票据／会话凭据仅在内存和必要的正常配对 UI 中流转，不进入 URL、bundle、环境变量、浏览器 storage 或日志。浏览器主题偏好也仅在会话内，不写 Electron 偏好。

浏览器权限只包含当前 instance／project 的 `state` 与 `updateProject`，DTO 为 `id/name/objective/revision`，只能改 name/objective。没有目录选择、profile、账号、录制、脚本执行、Agent API 或原生呈现能力；不会用伪完整 Studio.state 或假空值替代未授权状态。可信配对是独立 begin/status/revoke IPC，每次校验现有可信主 frame；不对通用 dispatch 放宽 `ui` 主体。

本次自动化配对仅操作本任务新空合成根、无 profile 的单项目元数据，属于可抛弃测试凭据，走真实 Electron 控件签发和浏览器表单。没有隐藏签发接口、预填被测项目或凭据截图／落盘。真实账号、旧目录、长期授权或更高权限不在此许可内，不能沿用本轮自动化范围。

## 事务、连接与审查修复

- port 复用 `WorkspaceManagement` 的串行事务、expectedRevision 和持久 operationId 收据；读也排队，在实际执行点通过 `permit.start` 再核权限／取消。排队撤销不写，已经开始的原子写可完成，不伪称回滚；只返回固定错误 code
- Vite 仅代理三个固定 POST 路径到指定 IPv4 loopback 目标，保留 Origin／Fetch Metadata 并精确检查 Host；无任意 upstream、CORS 扩权、Agent 转发或凭据注入
- stale 保留明确标记的旧投影并禁用保存；失效／到期清除数据。SSE 重连后权威读取，更新不自动重试；编辑器保留 operationId。预算继承 B1.2a，不把请求预算误称响应硬上限
- 独立检查推动修复：验证根与实际 Electron 根不一致的 symlink+`..` 路径；隐藏／最小化后迟到 begin；重复 instance meta；断连后旧 SSE 消息、连续失效覆盖在途读取等竞态。均有针对性回归

## 实际验证与构建身份

开发自测和独立检查均完成。实际工具链 Node 24.21.0／npm 11.19.0、Electron 44.4.3／Chromium 152.0.7977.130。验收运行时 HEAD 为 `daeadec` 加待提交代码；其 307 文件 manifest 与上述提交后的对应文件逐项一致，只有最后的测试 helper 相对首次 manifest 变化。不能把当时 `sourceDirty=true` 隐去。

| 候选 | `.vite/build/index.js` SHA-256 | 覆盖 |
| --- | --- | --- |
| 首次生产候选 | `9798588696a26d466600dcf4791f8eb648bb6d067fb65a8f4c7097f867b67031` | typecheck、33 文件240测试、完整 build、冷／热启动与重载／预期模块失败、真实 metadata、HMR、自然 TTL |
| 最终测试 helper 候选 | `e88c6de5db4f356f3950006dd388fa3b7a03b8d273af206d90baf4252b741037` | 最终 typecheck、受影响 main build、无 observer 的严格 layout 连续两轮、metadata 快验 |

最后一次变更只有 `test/desktop/workspace-layout.ts`，生产源码相同；240 项在最终 selection 屏障前已通过，最后仅重验受影响测试，不宣称整个测试库或旧长测全部通过。HMR／60 秒票据及 300 秒会话自然到期来自前候选，未改时钟或缩短 TTL，最终快验未重复等待。HMR 临时样式已恢复且 companion 未重启；这只证明当前元数据页面反馈入口，不证明三个资料场景的整体收益。

最终 metadata 快验：真实 UI 建项目 → 配对 → 浏览器保存 → HTTP／磁盘／SSE 回读 → 1450×935 与1100×760 无横溢、控件可命中 → 断网 stale 且禁止保存 → 重连回读 → 刷新清空会话后重配 → 原生关闭面板撤销 → Electron 管理表单回读同一 revision=2。未认证401、错误 Origin/Host403；报告无 pageerror。所有自有 launcher／companion／Vite／Chromium 均退出。

### 保留失败与测试可靠性修改

1. `output/desktop-1790768314803`：原 layout 的立即 Tab 断言失败，后续未测。真实建项目／环境、录制两保存点、封存／回放已在失败前执行
2. 同源码／构建被动观测原断言通过：三次 Tab 的 keydown／microtask 仍为同一 textarea，keyup／下一帧到按钮，节点未重挂载；当时 document.hasFocus=false。这不是产品修复，也不足以唯一确定首次失败原因
3. `output/desktop-1790769191888`：加入原生焦点准备后，较早 fill 将标题追加成“当前结果登录入口复核”；此前未观测 selection，保留失败，不冒称唯一根因
4. 最终 helper 仍做真实命中检查，普通 Electron window/UI focus 后检查两级原生焦点与 document.hasFocus；点击后确认准确 input active。一次 Ctrl+A 后有界等待确实全选，再 insertText；一次 Tab 后有界等待准确角色／名称按钮。不 DOM focus／set value、不重发输入、不放宽等值或旧 guard，超时保留 active／target／selection 诊断
5. 最终独立、无 observer 的两轮均通过：`output/desktop-1790769452605`、`output/desktop-1790769480478`。三个尺寸的原生／DOM 焦点均 true，textarea → “选择历史元素（可选）”正确；每轮10次输入准备、无 focusFailures，均 shutdown-complete

这与[旧 Electron alert/confirm 生命周期缺陷](ELECTRON-DIALOG-LIFECYCLE-20260930.md)分开。用户已选择暂不改变该交互；本轮未修复、未复验通过，也未删除失败门禁。整窗媒体截图仍可能超时，相关证据明确标为 renderer 与 native 分表面，不冒充合成整窗图。

### 可追溯证据与复跑

独立检查的本地证据目录名 `b12b-proof`（仓库外临时产物，不作为 Git 附件，跨环境不保证可访问）：
- `final-gate-summary.json`、`result.json`、`focus-observation-result.json`：初次 gate、自然 TTL／HMR、被动观测
- `final/final-summary.json`、`final/result.json`、`final/layout-{1,2}-final.log`：最终身份、快验、连续 layout
- `source-manifest.json` SHA-256 `5d8f0be4192cc03c7e5dce6051dce403423aafbbbfb11d350b01de3c1628f22d`；`final/source-manifest.json` SHA-256 `ca0732cba2c3b6e5d0680bec263ede60319546386443e0394dfa2ac255061cc2`
- `browser-1450.png`、`browser-1100.png`、`electron-metadata-readback.png` 及 `final/` 同名图，均在凭据清除后取得

```sh
npm run typecheck
npm test -- test/renderer test/unit/browser-workbench-client.test.ts test/unit/workbench-client.test.ts test/unit/workbench-dispatch.test.ts test/unit/workbench-http.test.ts test/unit/workbench-integration.test.ts test/unit/workbench-pairing.test.ts test/unit/workbench-session.test.ts test/unit/workbench-vite.test.ts test/unit/ui-ipc.test.ts test/unit/api-boundary.test.ts test/unit/api.test.ts test/unit/refactor-agent-api.test.ts test/unit/validation-start-api.test.ts test/unit/workspace-catalog.test.ts test/unit/workspace-management.test.ts
npm run build
node test/desktop/launch.js --workspace-layout
git diff --check
```

## 下一步

F01–F14 的逐项边界见[计划对照](../browser-first-refactor-plan.md#10-与原始-f01f14-的对照)。B1.3 优先复用真实 MaterialWorkbench 和既有领域服务，走 sealed 合成来源的保存点／字段／普通注释／复制／固定版／刷新／Electron 回读，不扩 B2/B3。资料权限需可信 UI 明确选择新的配对范围，不能静默扩展本轮 metadata 会话。

保留既有 CAS 与收据；没有 operationId 的编辑先不自动重试，丢响应显示结果待确认并权威回读，不能拿新 revision 重放复制。已有 workingMaterialDraft 的 ensure/create 或 catalog 修补若沿用，应在明确资料读写 grant、实际 UI 触发和领域锁内标明写语义；不伪装只读 state、不隐藏预造资料，也不为此先重做通用存储平台。
