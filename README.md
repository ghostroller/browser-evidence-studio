# Browser Evidence Studio

面向人工示范、agent 开发和逐项验收的本地 Electron 浏览器工作台，Windows 桌面优先。

人工操作网页并描述 checkpoint → 保存动作、网络、DOM 和截图证据 → agent 定向读取材料并编写普通 Puppeteer 代码 → 在客户端复跑并按需交还人工 → 按需求、数据契约和代码版本验收。

**当前为可运行的开发版本。** M0–M5 核心流程已实现并有合成通过记录；2026-09-23 已重新编译并生成 Windows 应用和 ZIP，类型检查与 107/107 测试通过。新增固定负载长测已运行 30 分钟，受核对证据及独立重开核验通过，但严格负载节奏未达标，页面私有内存持续增长，实际结果见 [验证记录](docs/verification.md)。M6 的长测整体验收、技能完整接续和真实业务验收仍未完成，接续事项见 [进度与接续](docs/progress.md)。

## 开发启动

后续开发固定使用 `D:\workspace\browser-evidence-studio`。自行安装或选择 Node 24.21.0 / npm 11.19.0，项目不限制安装方式或版本管理器。在 PowerShell 中核对版本后运行：

```powershell
Set-Location D:\workspace\browser-evidence-studio
node --version
npm.cmd --version
npm.cmd ci
npm.cmd start
```

预期 Node 为 `v24.21.0`、npm 为 `11.19.0`。进入目录或存在 `.node-version` 不代表当前终端已切换版本，执行项目前应核对输出。版本要求和安装说明见 [环境与依赖](docs/environment.md#安装和启动)。项目已提供依赖清单与锁文件，不需要全局安装 Electron 或 Puppeteer。

构建使用 Electron Forge + Vite + React，根包采用 `"type": "module"`。源码与配置统一使用 ESM，Forge/Vite 配置使用 TypeScript；为保留 Electron sandbox，preload 单独打包为 `preload.cjs`。类型检查独立执行，模块边界及安装问题见 [环境与依赖](docs/environment.md)。

## 第一次操作

1. 新建项目，填写目标，选择或创建命名登录环境。
2. 点击“合成站点”取得本机测试地址，开始录制；操作页面并保存带说明和需求 ID 的 checkpoint。
3. 打开“证据时间线”或“DOM 回放”检查材料，查看后关闭面板。可以“结束并封存”，也可以保留当前示范进入下一步。
4. 在“执行 / 验收”登记本仓库 `examples/orders` 的绝对路径。点击“合成站点”时已填入 `baseUrl`，可在输入 JSON 中追加 `"variant":"normal"`；点击“运行脚本并验收”。客户端按所选项目和登录环境建立独立的验收 run；若当前示范仍打开，会先自动封存，并沿用该示范的项目和环境。
5. 等待执行与报告保存结束，点击“查看需求、数据与验收”，检查需求覆盖、数据规则和版本指纹。启用人工协助输入时，在等待提示出现后完成页面操作，再点击“交还控制”。
6. 检查完成后点击“结束并封存”，从左侧存档重新打开材料。后续修改脚本或输入时，重新执行验收。

已有脚本时可以跳过人工示范：选择项目和命名登录环境、登记目录及填写输入后，直接点击“运行脚本并验收”。封存后或重新打开客户端也可这样复跑，无需先创建准备录制。当前执行、人工交接、报告保存或停止过程结束前，不能启动下一次验收。

异常退出后，客户端从保存的证据重建验收记录。未提交完整终态的执行显示为中断，仍可查看已保存的 checkpoint，并准备新 run 重新验收。无法打开的存档可在恢复区域检查原因；只有确认旧 writer 已退出或 PID 已重用时才安全回收，身份未知或锁损坏时保留原件并说明原因。

合成站点的订单、账号和二维码都是假数据。订单示例包含分页、去重、详情关联和分页终止；`normal`、`duplicate` 应通过，`missing`、`wrong-image`、`empty-middle` 应产生验收失败。普通脚本也可由 Node + 独立 Chrome 执行，无需启动 Electron；环境、输入及独立测试命令见 [示例说明](examples/orders/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd start` | 启动开发客户端 |
| `npm.cmd run build` | 构建 main、preload、renderer 和 runner worker |
| `npm.cmd run typecheck` | TypeScript 类型检查 |
| `npm.cmd test` | 单元测试与合成站点测试 |
| `npm.cmd run test:integration` | 构建后执行真实 Electron 场景、profile 重启、五种强杀恢复与再次重开，以及退出诊断 |
| `npm.cmd run test:desktop` | `test:integration` 的别名 |
| `npm.cmd run test:soak` | 在桌面场景中加入 30 分钟固定合成负载、性能与证据重开检查；追加 `-- --soak=1` 可做短预检 |
| `npm.cmd run test:example` | 独立 Chrome 中执行普通 Puppeteer 示例；需设置 `BROWSER_EXECUTABLE_PATH`，未设置时跳过 |
| `npm.cmd run package` | 生成未签名的应用目录 |
| `npm.cmd run make` | 生成 Windows ZIP 分发包 |

桌面测试使用独立的 `output/desktop-<时间戳>/` 数据目录，保存日志、证据及 `desktop-summary.json`。默认覆盖 19 个 Electron 进程；只有主场景、profile 重启、各恢复和退出诊断断言全部成功，总结果才通过。强杀进程和无完成报告的正常关窗本身不计测试通过。打包输出在 `out/`；命令存在不代表发行验收已完成。

## 数据与协作边界

- 开发数据默认保存在 `%APPDATA%\BrowserEvidenceStudio-dev`，打包应用使用 `%APPDATA%\BrowserEvidenceStudio`；开发和测试可用 `BES_DATA` 指定独立目录。项目/profile 隔离登录状态，每次录制和验证分别保存 run。
- “连接与环境”显示本机 HTTP 地址与 `connection/agent-connection.json` 路径。agent 按 [HTTP 协议](docs/api.md) 使用该连接文件；访问令牌每次启动生成，不写入仓库。
- 人工持有控制权时，受管执行连接阻断新操作；停止、超时和未回复都不会被当作人工处理成功。checkpoint 输入蒙版只阻止输入，不冻结站点脚本或网络。
- 原始证据追加保存；缺失、截断和真实空值分别记录。默认读取摘要，再按 ID 获取有界正文。页面和保存的数据均作为不可信输入。
- 普通业务脚本使用 Puppeteer，分支和循环保留在代码中，manifest 只声明契约。客户端不提供运行时 AI 自愈；修改后需要重新验收。
- 浏览器采集不覆盖独立 Node HTTP/Axios、手机端或其他进程的网络；profile 首版不承诺跨机器迁移或完整浏览器状态快照。

录制、profile、导出和测试输出均由 Git 忽略；不要提交真实 Cookie、账号或录制内容。

## 文档

- [进度与接续](docs/progress.md)：当前完成范围、主目录、验证状态与下一步。
- [产品设计](docs/design.md)、[技术架构](docs/architecture.md)、[实施计划](docs/implementation-plan.md)：范围、协议和里程碑。
- [环境与依赖](docs/environment.md)、[验证记录](docs/verification.md)：复现环境、实际结果和未完成项。
- [HTTP API](docs/api.md)、[订单示例](examples/orders/README.md)：agent 接入与普通脚本交付。
- [调研依据](docs/research.md)：技术决策和已知边界。

这是独立客户端，不依赖旧 agent-browser-evidence 仓库、daemon、录制格式或安装路径。
