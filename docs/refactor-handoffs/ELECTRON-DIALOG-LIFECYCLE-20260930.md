# Electron 网站对话框回应与原生焦点阻塞

日期：2026-09-30（UTC）。状态：已定位，尚未修复；不得将相关桌面回归记为通过。

## 结论

当前 Electron 路径同时呈现原生网站 alert/confirm 和工作台内的 CDP 回应按钮。CDP accept/dismiss 能让网页继续、产生 `Page.javascriptDialogClosed`，但本次 Electron 44.4.3 / Linux 实测中原生模态框仍然存在，宿主 `BrowserWindow.isEnabled()` 保持 false。下一次业务页输入无法获得宿主焦点。

这是已复现的对话框生命周期冲突。不是截图引起，也不是已证明的 B1.1 回归，更不能写成所有 Linux 桌面必然失败。`clickSyntheticHuman` 的宿主焦点断言正确地阻止了向失焦/禁用父窗继续发送业务输入；延长等待、移除断言或再次调用 focus 都不是修复。

## 证据与边界

- 候选源码 `1918012123227655c696c1003c8d2c0c05b0c07f`；既有两次独立候选实例和 `e785907` 独立旧构建均在 alert 后的下一次业务点击处失败
- 只读诊断 wrapper 加载同一已验证构建，没有修改源码或构建：PID 38962，UTC 起止为 10:56:09–10:56:20，退出码 1。alert 调用原生 `dialog.showMessageBox(parent)` 后父窗 enabled 变 false；自绘按钮处理后原生 promise 未返回，父窗至退出前仍 disabled
- 独立最小 Electron + WebContentsView + Puppeteer 对照，不装载 Studio，不产生产品验收结论：PID 39734 测 alert，PID 40076 测 confirm/beforeunload；输入通过可见原生控件，所有数据为本任务合成
- 原生 OK/Cancel：网页分别得到 alert 返回或 confirm=false，原生框关闭，父窗恢复 enabled/focus
- CDP accept/dismiss：网页已经返回，CDP closed 事件已到，但原生框仍可见、父窗 disabled。随后通过原生框完成回应才恢复宿主
- 因此 CDP closed、网页返回值、WebContents.isFocused() 任一单独成立，都不足以证明原生模态框已经消失或父窗可以接收输入
- 原生窗口及 4 个诊断 Electron PID 已核对退出；旧 demo 与既有 Chromium 未操作

构建 SHA-256：

- `.vite/build/index.js`：`f4a81113467e18e791f4844fb30fff19b8c664b66d5bc038712350e5e4a7b80a`
- `native-input` chunk：`ed1fc67fe3b7bb134e56957f6dd7d9366e44c62916438b47f71ffa6d5605fd96`
- `workspace-browser` chunk：`a44419e6c5f3248c7a35e7359b065615d9cec2746aed8863845926ba003fe007`

仓库外证据目录为本轮 `focus-diagnostic-20260930/`：`run1/focus-events.jsonl`、`run1.log`、`minimal2/events.jsonl`、`minimal3/events.jsonl`、`build-sha.txt`、`final-process-check.txt`。这是临时环境定位说明，不是仓库附件。首次最小探针因模块路径错误退出，保留于 `minimal/`；后续对照另建目录，没有覆写失败。原始日志、profile、连接地址和截图不随本文提交。

## beforeunload 不应与 alert/confirm 混为一谈

最小探针中，导航与 `webContents.close({waitForBeforeUnload:true})` 均触发 `will-prevent-unload`。Electron 默认取消后，观察连接仍可能依次收到 CDP opening/closed(false)，再次 dismiss 会得到 `No dialog is showing`；宿主始终 enabled/focused，没有同类原生 modal。

这与 Electron 的独立 beforeunload 实现一致。现有关闭路径已经等待 native outcome、保留 dismiss 拒绝诊断并检查页面可读性，不能简化成“CDP 回应成功即已关闭”。永久 `page.on('dialog')` 对导航 beforeunload 是否可能保留过期工具栏状态，还需真实产品路径定向验证；本次最小探针不是该路径验收，也不支持将 beforeunload 统一改成原生 alert/confirm 策略。

## 受支持方案及产品取舍

1. 保留已知问题与失败门禁，继续浏览器优先拆分；不在当前切片中改变 Electron 网站对话框交互。后续 provider 必须验收单一回应所有权、原生清理与取消边界。此方案本身不修复当前 Electron 缺陷
2. Electron alert/confirm 采用原生单一回应所有权，工作台只提示状态，完整观察关闭与页面/会话销毁；prompt 继续明确不支持。需同时收敛自动化的 CDP 回应能力，否则仅删除工具栏按钮仍会复现。原生 modal 会阻塞主窗操作，这改变 IA24 全局停止可达性，必须先确认产品取舍并补充独立停止入口或明确受支持范围

现有 `browserCommand('dialog')` 只允许可信 UI、当前会话与 human/unlocked 控制权；普通 Agent 不能直接调用它。但授权中的普通 Puppeteer 操作连接可发送 CDP dialog 回应，GateTransport 当前不对该方法作专门兼容处理。不能把“原生单一所有权”作为只改 UI 的小修。

不采用全局 monkey-patch、私有 `-run-dialog` 替换、`disableDialogs` 自动拒绝、强制 enable 父窗或测试替产品关闭原生框。这些都不能证明保留了现有产品语义。

## 后续修复的最低验证

- 明确唯一回应所有者；alert、confirm 的接受/取消、重复、连续触发均核对网页结果与原生关闭，不能只依赖 CDP closed
- 保留 session/recording/page/target/controller/lock/mask/visibility/focus/hit-test 断言；失败时可补充只读 enabled/focused/modal 诊断
- 覆盖外部原生回应后的工具栏清理、页面切换/销毁、导航 beforeunload、关闭被阻止、迟到/过期回应
- 验证自动化触发对话框时停止/取消/接管入口实际可达，并保留主窗与业务页身份隔离
- 用新构建重跑生产工作区浏览器场景；最小复现与单测不代替该验收

源码核对依据：[Electron 44.4.3 web-contents 对话框实现](https://github.com/electron/electron/blob/v44.4.3/lib/browser/api/web-contents.ts#L730-L782)、[native JS dialog 与 beforeunload 生命周期](https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_web_contents.cc#L4186-L4226)。
