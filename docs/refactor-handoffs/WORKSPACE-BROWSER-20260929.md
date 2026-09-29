# W2 浏览器实施与集成记录

日期：2026-09-29。起点：W0 `32ec24406096c322005c544521f3ec957aa41809`。独立受管工作树：`managed-browser`。本包没有启动 Electron 桌面，没有触碰用户真实环境或登录状态。

## 实现

- 可信 UI `browserCommand` 将 session、lease、page、target、generation 一并校验；人工新建/恢复不使用 Agent 授权入口。关闭最后一页保留人工控制和录制状态，保留“新标签”入口。最近关闭记录仅在当前会话内保留最多 20 个网址，不承诺网页 JS/表单恢复。
- PageState 投影 Electron 的历史、加载、缩放、错误与查找状态。人工导航异步启动，不占用命令队列直到网络完成，停止加载只停止该页导航。网址、网络/证书、授权拒绝分开显示，重试保留 target 和环境。
- 业务 WebContents 处理 Ctrl+L/T/W/Shift+T/R/F、缩放与 Esc。可信工具栏对工作区表单不抢 Ctrl+W/R/F；Ctrl+L/T 为明确全局浏览器动作。Ctrl+S/Esc 从业务页转交 AppShell 回调。右键复制文字/链接、粘贴、新受管标签使用原生菜单；延迟点击校验页面代际和控制权。没有外部程序执行入口。
- alert/confirm/prompt 及导航 beforeunload 显示消息和明确确认/取消；授权/自动化拥有页面时要求先停止接管。关闭页面时的 beforeunload 继续使用已有安全关闭观察流程，不代人确认关闭。文件上传保留 Electron 原生文件选择器，没有新增隐藏文件选择接口。站点权限仍默认拒绝，拒绝原因进入可信工具栏。
- 下载监听属于 session，未录制时也可下载、查看进度/结果、取消和显示文件位置。文件不会自动打开执行。录制开始时绑定下载证据 writer；超过 64 MiB 标记排除、保留本地文件。停录只结束证据关联，未完成下载继续运行，之后不能写进旧已封存 writer。
- `addPage` 在 native 注册、target 等待、capture 启动与授权登记失败时清除本次资源，恢复旧选择；掩罩按最新 controller/locked 恢复。Agent 页初始化纳入 try，授权最后登记，失败不能留下获授权的孤儿页。openEnvironment 内部失败撤销本次 session/下载监听和 view；真实网站加载失败保留可重试错误页。

## 主任务集成合同

本分支不改 `dispatch.ts`、`app.tsx`、公共 schema 或项目/环境 CRUD。

1. dispatch 的 `browserCommand` 限可信 UI；普通动作进现有 serialized 队列，`stop`、`dialog`、`download-cancel` 绕过队列以保持安全响应。仍由 Studio 校验完整身份。
2. `ManagedBrowserToolbar` props：`session={state.session}`、`call={window.studio.call}`、`refresh`；历史/遮挡/选择中传 `disabled`。`onSave` 指向当前工作副本保存，`onCancel` 指向已有选择/Esc取消。工具栏只调用 browserCommand；不将动作回执整份覆盖当前 App 上下文。
3. 替换旧 live 标签、地址和历史按钮区，以免出现两套入口；录制/控制/全局停止继续由 AppShell 管理。全局停止必须在浏览器工具栏之外始终可达。
4. 新增类型在 `src/main/browser/browser-controls.ts`，组件只 type-import。PageState 新字段 loading、loadError、zoomFactor、find、dialog；session 新字段 downloads、closedPageCount、notice、uiAction。uiAction 带随机 ID，组件只消费一次。

## 实际验证层级

- `npm run typecheck`：通过。
- `npm run build`：通过；存在原有依赖 `use client` 和 Tailwind sourcemap 提示，没有依赖升级。该构建尚未接入主任务 AppShell，不能充当 W3 集成构建证据。
- 浏览器命令、分配回滚、下载 service、toolbar component、既有 session 命令：36 项通过。最后复核修正了“已停止录制仍有 capture 对象”的检查状态范围，并将对应测试设为实际正在录制的检查状态；补测导航 beforeunload 不被静默忽略。
- 既有 product-session-boundaries、navigation-readiness、capture-navigation、capture：18 项通过。
- 初次受限运行因 worktree 的合成 output 写权限得到 EPERM，未发生业务断言失败；之后以限定目录提升执行，保留原测试输出，没有删除失败证据。

| 验收 | 本包已验证 | 待主任务 W3 |
|---|---|---|
| IA19 | Studio 身份、异步加载/停止独立性；组件历史禁用和地址 buffer | 真实 Electron 后退/前进/网络与证书故障 |
| IA20 | 空会话再建页、Agent 旧回归、分配回滚 | 真实标签创建/关闭/恢复和原生父子 target |
| IA21 | 服务查找/缩放范围、缩放审计、快捷键解析与组件上下文 | 原生键盘、右键、历史页不联网/检查模式 |
| IA22 | session 下载、取消、停录后继续、64 MiB 排除和写入边界 | 真实站点下载进度/取消、原生文件选择器 |
| IA23 | 站点对话框精确 ID 与显式取消；权限拒绝实现 | 原生 alert/confirm/prompt 与权限请求 |
| IA24 | 不接管 AppShell，mask Esc 路由到现有取消 | modal/选择/历史中的全局停止及静默边界 |
| IA25 | native 注册、target 等待、capture、授权登记注入；导航失败保留错误页 | 五处对应真实 Electron 注入、窗口/原页可用性 |

上述故障测试运行真实 Studio 方法，对 Electron 资源边界使用模拟对象；不能据此宣称物理 Electron 故障已经发生。独立用户可发现性、T1–T3 新构建复验和窗口尺寸验收由集成主任务完成。本包没有更改旧录制、版本 hash、storageRef 或 partition。
