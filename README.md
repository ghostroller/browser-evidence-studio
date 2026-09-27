# Browser Evidence Studio

面向人工示范、agent 开发和逐项验收的本地 Electron 浏览器工作台，Windows 桌面优先。

先独立准备登录环境 → 人工示范并创建统一保存点 → 绑定字段、说明需求并固定任务版本 → Agent 读取该版资料、提出普通 Puppeteer 代码与实现映射 → 确认后执行并检查同版数据与来源。

**当前为可运行的开发版本。** 本轮按 [产品主线纠偏](docs/refactor/08-product-realignment.md) 与 [用户旅程验收](docs/refactor/09-user-journey-acceptance.md) 实施 M0/M1。历史录放、安全、执行与发布证据保留各自版本和范围，不能代替新产品路径。最新候选、独立复走结果与尚未完成项见 [验证记录](docs/verification.md) 和 [进度与接续](docs/progress.md)。核心交互确认前不自动展开后续全面长测与打包。

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

首次体验可在开发构建后运行 `npm.cmd run demo:product`，它启动可见应用和本机合成订单站点，并打印全新的隔离数据目录与登录入口；不会替你创建任务、环境或资料。不要用真实账号做工具测试。

1. 新建项目并填写目标；添加登录环境，填写名称和入口，点击“打开环境”。此时未录制，可以完成人工登录、检查并保留环境。
2. 准备好业务页面后开始录制，点击“记录当前结果”。保存点会立即出现在“保存点与字段”工作区，可编辑标题和说明；“查看来源”打开对应原件。
3. 关联需求，点击“添加所需字段（实时页面）”，选择页面元素，填写字段名称、含义与数据集。无需填写内部 ID、注释或 proof JSON。当前节点先固化为新的现场例证，旧卡片的历史位置不变。
4. 结束并封存后，页面和登录环境保留。通过保存点查看历史、补点或编辑说明，发布 V1；复制或继续修改后可发布 V2，旧固定版不被覆盖。
5. 从“任务授权”准备固定交接，Agent 读取该版资料并提供普通代码和实现映射。在“执行”登记目录，返回资料工作区读取并确认映射，再固定用于执行的版本。演示实现器的命令见 [M1 操作交接](docs/refactor-handoffs/PRODUCT-M1-20260927.md)。
6. 对准备好的环境执行该版本，在结果中心查看数据、需求判断和来源。正确数据、真实错误与证据不足分别处理，运行结束不等于需求通过。

### 从网页选取元素

**实时页：**从保存点的“添加所需字段（实时页面）”开始选取，点击目标后回到字段编辑并保存。工具不会改写业务元素原有样式；Esc 或取消退出，不删除已有绑定。浏览器下方的独立“选取元素（实时页）”用于观察当前对象；正式资料绑定由上述字段入口完成。

**历史页：**选择卡片并点击“查看来源”，在可靠历史位置点击“从历史页绑定元素”，选中节点并保存字段。普通注释使用独立的“在历史页选择元素”入口；注释不是字段绑定的必填条件。替换绑定需要重新选择，删除绑定必须点击“解除绑定”并确认；只改说明、切卡或切 tab 应保留原目标。

历史回放只使用保存的材料，来源缺失时显示缺口。候选定位器不代表已验证可复用。实时来源不会回填过去未记录的位置。

异常退出后，客户端从保存的证据重建验收记录。未提交完整终态的执行显示为中断，仍可查看已保存的 checkpoint，并准备新 run 重新验收。无法打开的存档可在恢复区域检查原因；只有确认旧 writer 已退出或 PID 已重用时才安全回收，身份未知或锁损坏时保留原件并说明原因。

合成站点的订单、账号和二维码都是假数据。订单示例包含分页、去重、详情关联和分页终止；`normal`、`duplicate` 应通过，`missing`、`wrong-image`、`empty-middle` 应产生验收失败。普通脚本也可由 Node + 独立 Chrome 执行，无需启动 Electron；环境、输入及独立测试命令见 [示例说明](examples/orders/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd start` | 启动开发客户端 |
| `npm.cmd run build` | 构建 main、preload、renderer 和 runner worker |
| `npm.cmd run demo:product` | 启动空隔离数据的可见合成演示（先 build） |
| `npm.cmd run test:journey` | 从空数据经可见 UI 完成同版任务与退出重开验证 |
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
