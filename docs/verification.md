# 实际验证记录

日期：2026-09-22，Windows x64。本页记录实际执行结果；设计文档中的其余目标不自动视为完成。自动化回归仅面向本机合成数据。未修改旧仓库，未把任何运行材料、Cookie 或 profile 放入 Git。

## 环境与构建

| 项目 | 实际组合 |
| --- | --- |
| 开发 Node / npm | 24.21.0 LTS / 11.19.0，命令显式通过 fnm 选择 |
| Electron 内置 Node / Chromium | Electron 44.4.3 / Node 24.21.0 / Chromium 152.0.7977.130 |
| 执行与录制 | puppeteer-core 25.11.0 / rrweb 2.1.6 |
| 构建与界面 | Forge 7.11.2、Vite 8.3.0、TypeScript 7.0.2、React 19.3.0 |
| 独立示例浏览器 | 本机 Edge 153.0.4234.48，新临时 profile；不读取已有账号环境 |
| package-lock SHA-256 | `c47ffd6ab57b3fc1b93629b28a01f52da48fd3041389c95e227534dcffb185e9` |

`npm ls webpack @electron-forge/plugin-webpack vite --depth=1` 仅列出 Vite。main/worker 与 preload 输出 CommonJS，renderer 输出浏览器 ESM，类型检查独立于 Vite 转译。

Electron ZIP 158,247,567 字节，SHA-256 为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，与安装包内官方校验清单一致。镜像和随后完成的官方下载均核验了同一摘要。

## 已执行命令

以下命令在仓库根目录执行，均使用 `fnm exec --using 24.21.0` 前缀。

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd test` | 40 项通过，0 失败、0 跳过，含合成站点及真实 worker 子线程测试 |
| `npm.cmd run build` | Vite main/preload/renderer 构建通过 |
| `node test/desktop/launch.cjs` | 两个真实 Electron 进程的桌面和 profile 重启场景通过 |
| `npm.cmd start`，设置独立 `BES_DATA` 与 `BES_TEST=1` | Forge/Vite 开发模式主阶段全部通过，客户端正常退出 |
| `npm.cmd run test:example`，显式设置 `BROWSER_EXECUTABLE_PATH` | 5 个独立浏览器变体实际执行，1 个组合测试通过，0 跳过 |
| `npm.cmd run test:soak` | 20 分钟连续录制正在执行，完成后记录数据 |
| `npm.cmd run package`，使用已校验的 `ELECTRON_ZIP_DIR` | Windows 应用目录生成成功；最终代码的打包启动验收待补 |

普通 Vite 构建提示 rrweb/React renderer chunk 大于 500 kB；Forge/Vite 组合提示上游 `inlineDynamicImports` 配置弃用。两者未导致上述构建失败，不代表已经完成体积优化。

首次完整桌面通过证据：`output/desktop-1790077424921/desktop-summary.json`，主进程 PID 40644，重启进程 PID 14700，二者退出码 0。Forge 开发模式证据：`output/forge-start-1790077723581/test-result.json`。截图保存为各目录下的 `ui.png` 与 `ui-evidence.png`。这些运行目录被 Git 忽略，复跑会生成新目录。

独立示例最近一次结果位置：`C:/Users/ADMINI~1/AppData/Local/Temp/bes-independent-Otoa9s`，包含每个变体的报告、截图和来源附件。

## 合成验收覆盖

| 需求 | 实际证据与边界 |
| --- | --- |
| R01 桌面与目标身份 | WebContentsView、普通 Puppeteer 点击和导航、独立捕获连接、弹窗/opener、切页后操作目标、刷新与 DevTools 打开关闭均通过。按 CDP targetId 匹配，未按 URL 猜测。 |
| R02 存储与恢复 | 单写者、确认提交后强杀 writer、损坏尾部保留、hash 校验、索引重建和稳定 ID 单测通过。renderer 强制崩溃后记录 gap，仍可封存。 |
| R03 连续证据 | CDP 请求/响应、两跳重定向、1 MiB 完整 JSON、9 MiB 在 8 MiB 明确截断、rrweb 顶层与 iframe 场景通过。跨域 iframe/Canvas/媒体及 WebSocket/SSE 完整正文不作保证。 |
| R04 checkpoint 与检查 | 原生视图蒙版、截图/DOM 落盘、有界回读、实际 UI 显示保存截图通过。检查点击只选元素，不执行站点按钮；采集期间页面定时器继续。 |
| R05 控制与人工交接 | 并发 Promise/定时器命令在闸门关闭后拒绝；连接建立中停止不能晚到点击；两处人工窗口经真实原生输入和状态检查后恢复；未满足检查、超时和取消不通过。 |
| R06 登录环境 | 同一 profile 新 run 及新 Electron 进程中的合成 Cookie/localStorage/IndexedDB 均保留，另一个 profile 保持为空。保存仍标记登录状态 unknown，不承诺 sessionStorage、内存态或跨机器迁移。 |
| R07 HTTP | loopback、token ACL、Host/Origin、幂等 job、取消确认、身份与预算相关单测通过；真实 HTTP 场景完成 8 个 job、6 个控制权/身份拒绝，幂等点击只发生一次，键盘 fill 实际值正确，截图和 HTML 下载响应安全头通过。 |
| R08 普通脚本 | 同一 `examples/orders/run.mjs` 在受管 worker 和独立 Edge 中运行；普通分页、去重和详情分支，无运行时 LLM 或 Electron 必需依赖。 |
| R09 验收 | normal/duplicate 输出 7 条订单及关联详情并通过；wrong-image、missing、empty-middle 确实判失败。来源、实体 ID、覆盖、字段与版本指纹纳入验收。 |
| R10 项目技能 | 入口技能与按需引用的 HTTP/探索/验收说明已建立，skill-creator 的 quick_validate 已通过；未全局安装。仅靠技能接续新任务的真人协作验收尚未执行。 |
| R11 长流程 | 20 分钟实际录制正在执行，指标完成后补记。短/长 run 均采用有界 reader，不返回整段 DOM/base64。 |
| R12 分发与真实验收 | Windows 应用目录已生成，最终打包启动待补；未签名。真实拼多多演示、扫码及业务需求验收未执行。 |

## 本轮发现并修复的问题

- 原生输入蒙版与 Windows 窗口遮挡会影响 Chromium 的 IntersectionObserver，普通 Puppeteer 点击可能等待超时。业务视图关闭后台节流，蒙版保持透明合成，并添加 `disable-backgrounding-occluded-windows`；五个普通脚本变体及人工交接已复跑通过。此设置保持绘制，不关闭浏览器安全隔离。
- Electron `window.open()` 的 createWindow 回调已给出 guest WebContents。旧代码重建另一份会抛 `Invalid webContents` 主进程异常；改为 `new WebContentsView(options)` 接管原对象，安全偏好在 overrideBrowserWindowOptions 中设定。真实 popup/opener/切页和退出已通过。
- Puppeteer 25 在 Chromium 152 下需要发现结构性 tab target 才能找到其 page。适配器允许结构 tab，最终 Page 仍绑定并通过 CDP 复核明确登记的 targetId。
- 对每个 iframe 注入独立 rrweb 会递归记录 rrweb 自己的辅助 iframe。现在只在顶层注入，暂停恢复只调用已就绪的主文档 recorder；跨 iframe 能力明确为部分支持。
- Forge 的 preload 构建使用入口名 `ui.js`，与普通 Vite 构建原来的 `preload.js` 不同。输出文件名现已统一；开发启动和生产构建使用同一路径。
- 操作连接建立/停止、人工完成检查/取消、封存/晚到 popup 的竞态已加失效检查和清理。不能在等待结束后恢复已经撤销的控制权。
- 保存的 HTML 等原件不内联执行。截图协议限定完整 PNG、大小预算与安全响应头，IPC 仅信任准确 UI 文档 URL；HTTP 二进制附件使用下载响应及禁脚本 CSP。

## 网络与防火墙排查

只观察到已有的 Public 配置 Node 入站阻止规则，未修改防火墙。本机 HTTP、CDP 和夹具互通已实测；`Get-NetTCPConnection` 核对实际 CDP 监听为 `127.0.0.1`。本次 npm 出站失败与代理 TLS reset/执行沙箱限制有关，给 registry 设置进程级 NO_PROXY 后可安装；无法据此把失败归因于入站规则。

本工具不需要对局域网或公网监听。无需禁用防火墙或给 Node 广泛开放入站。图形测试在允许的进程执行环境中运行；没有关闭 Chromium sandbox、contextIsolation 或 webSecurity。

长录制第一次尝试 `output/desktop-1790077578498` 在约 11 分钟时被导航到非合成站点，夹具检查中断，该次不算通过。材料保留在本地且被 Git 忽略，未据此推断真实站点登录或业务成功。长测已改为保持自动化控制、明确测试窗口标题，每轮先校验控制权及合成 origin；人工显式接管会停止测试，不继续操作真实页面。

## 尚未验收的范围

真实账号与拼多多业务闭环需要用户完成演示和扫码，不能以合成测试代替。自动更新、代码签名、多机 profile 迁移、外部浏览器接管、完整跨域 iframe/Canvas/媒体回放不在本次通过声明中。

性能目标中的 100 ms 界面反馈、30 分钟全负载、HTTP P95 300 ms 等需各自实测；不能从一次短路径或命令成功外推。长期内存和数据损失结论以指定合成负载与保存边界为限。
