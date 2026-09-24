# 实际验证记录

更新日期：2026-09-24，Windows x64。本页记录实际执行结果；设计文档中的其余目标不自动视为完成。自动化回归仅面向本机合成数据。未修改旧仓库，未把任何运行材料、Cookie 或 profile 放入 Git。

## 一次性授权 Agent 启动验收（2026-09-24）

已实现可信 UI 的“允许 Agent 启动一次”与“撤销启动授权”。grant 在内存中保留 120 秒，绑定当前 run/project/profile/workflow/lease、目录、代码与锁文件指纹、规范化输入及页面/target/导航代际。HTTP 仅认证读取 grant，并在原 `/v1/runs/:runId/validations` 中通过 `startGrantId` 一次消费；不能从 HTTP 签发授权、传任意脚本目录，或借 grant 绕过普通 actions/control 的 human guard。具体请求及当前实例发现步骤见 [API 契约](api.md#人工控制下授权-agent-启动验收)。

同时修复启动取消的范围：每个 HTTP 启动 job 独立 abort，排队取消不调用全局 stopRunner；整个 seal/startRun/control/worker 准备过程有启动身份。消费后输入锁定，再次检查来源身份；worker 创建前核对版本、输入和固定 target。UI 撤销绕开长任务队列，尚未消费时立即失效；消费后失败或取消不恢复授权。发行/重启不会从历史事件复活 grant。

实际环境为 Node 24.21.0 / npm 11.19.0，依赖版本未调整。

| 命令或证据 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck`、`npm.cmd run build` | 通过，保留现有依赖指令、sourcemap/chunk 构建提示；后续索引刷新修复再经类型检查与 main/worker 构建 |
| `node --import tsx --test --test-concurrency=1 test/unit/*.test.ts test/fixtures/site/site.test.ts` | **134/134** 通过，日志 `output/validation-start-unit.log`；新增 grant 的时钟/TTL、每字段绑定、一次消费、撤销、替换及返回值隔离，以及真实 HTTP 的任务专属取消和权限边界测试 |
| `$env:BES_SKIP_UI='1'; node test/desktop/launch.js` | 最终 **19 进程矩阵整体通过**，报告 `output/desktop-1790235629049/desktop-summary.json`；main、跨进程 profile、五阶段崩溃/重开及退出生命周期检查通过 |
| `output/desktop-1790235629049/validation-start-result.json` | 授权专项 **20 项检查通过**：可信 renderer 按钮经 preload 签发/撤销；绑定/代码/输入/lease/页面变化拒绝；普通动作仍拒绝；同 key 幂等、不同 key 并发仅启动一次；输入对象换键序仍通过；成功后交还人工；失败证据可立即查询；消费中目标变化、指纹检查中撤销、队列取消和 seal 后无 active 取消均阻止后续 worker |

首轮 `output/desktop-1790235091006` 因测试误要求 HTTP 的 500 响应包含完整 schema 错误而失败，已改为保持 API 脱敏、从有界证据核对原因。第二轮 `output/desktop-1790235472292` 暴露实际可读性缺陷：`validation-start-failed` 已在 journal 原件中，但 index/state 的一秒批量发布尚未发生，job 返回后立即查询看不到失败。已在签发、撤销和失败结果发布前 flush 索引；第三轮保留原断言并通过。未以等待或放宽断言掩盖该问题。

`BES_SKIP_UI` 跳过既有窗口拖动/布局专项；新增授权按钮、输入 JSON 与撤销按钮仍通过真实 React/preload 测试，不代表 Windows 物理鼠标体验验收。TTL 使用单测受控时钟验证，没有让真实账号等待两分钟。最后仅补充“无活跃 run 时先开始录制”的提示文案，再经类型检查和 renderer 构建，不重复整个桌面矩阵。技能按 skill-creator 指导只更新验收引用；`quick_validate.py` 在当前 Python 缺少 PyYAML（`ModuleNotFoundError: yaml`），未通过该工具校验，frontmatter 未改、引用已人工核对。本轮未启动用户的真实客户端、执行京东流程、改业务示例或生成发行包。

## 操作连接关闭与原始错误保留（2026-09-24）

收到新诊断后，只读核对默认开发数据根的 run `eb862014-114b-41d8-8d79-fb3d3b2a10f7` / validation `1bb7d4ed-a052-4ae8-85d2-d14f3b7acbcc`，没有读取订单正文、导航、点击或封存。快照 lastSequence=5523：人工交还事件 `evt-000000002832` 于 03:41:15.235Z 保存，四个 consistent checkpoint 为 login-confirmed、profile-complete、identity-complete、addresses-complete；03:41:23.223Z 的 validation-complete 为 failed。报告 `art-000000005069` 定向字段为 `Operation transport disconnected`、30270ms、versionVerdict=pass。新启动日志入口为 `output/dev/2026-09-24T03-38-18-353Z-36688-e1c43fff`，检查时有29个控制台块，没有匹配的 WebSocket/异常错误行；日志没有记录事件不等于证明远端没有断线。

源码和确定性负例确认：workflow 抛错 → worker finally 执行 browser.disconnect → `cdp.close` 先到主进程 → Gate.close 同步触发 onclose → manager 报通用断线并终止 worker → 稍后的原始 failed 消息被忽略。`connectManagedPage` 的失败清理也可能走同一路径。修复前 `worker cleanup before its failure message...` 用 `cdp.close → failed('synthetic original failure')` 实际得到通用断线，测试失败。该复现证明错误掩盖缺陷；旧真实报告没有原始错误或关闭来源，无法倒推其中必定是选择器超时或真正网络中断，约30秒耗时本身也不能定因。

修复后的行为：

- 本地 worker 关闭立即关闸，但最多等待1秒接收原始失败或退出；没有终态明确失败，不能恢复执行或产生通过。成功完成清理、取消、真正远端关闭分别处理。迟到 worker error 不覆盖已确定的取消或首次传输故障。
- SocketTransport 区分 local / remote / error，记录时间、可取得的关闭码/原因及错误标识；error 后的 close 不重复通知或覆盖首个错误，握手和 abort 的迟到 error 也被消费。原因/消息有界并处理常见 URL、地址和凭据字符串，不记录 endpoint、页面正文或 CDP 参数。
- Gate 保存关闭前状态、在途数及至多16个方法名；追加 `operation-transport-closed` 事件，报告增加 `errorSource`、有界 `errorStack` 和 `operationTransportClose`。异常关闭摘要也写到控制台，`start:agent` 可直接回读。
- 京东示例的 profile、identity、addresses、orders、details、deletedOrders 各阶段完成后立即 await emitData，并在对应阶段发断言。同名仍只发一次，字段/来源/分页规则未改。后续错误保留此前完成材料，未完成阶段不补空占位；已有部分数据不代表整个执行通过。

验证环境仍为 Node 24.21.0 / npm 11.19.0、Electron 44.4.3 / Chromium 152.0.7977.130。

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck`、`npm.cmd run build` | 通过；最后的迟到 error 保护后再通过类型检查并重建 main/worker |
| `node --import tsx --test test/unit/gate.test.ts test/unit/validation.test.ts test/unit/connection.test.ts examples/jd-account-export/run.test.mjs` | 32/32 通过；包含7项真实 loopback WebSocket 测试和6项纯合成示例故障场景 |
| `npm.cmd test` | 首轮 **121/123**：evidence、request-body 各一项因 `WRITER_IDENTITY_UNAVAILABLE` 失败，其他项通过；日志 `output/transport-unit.log`。未修改 writer 锁或放宽身份检查 |
| `node --import tsx --test --test-concurrency=1 test/unit/*.test.ts test/fixtures/site/site.test.ts` | 加入迟到 worker error 回归后 **124/124** 通过；日志 `output/transport-unit-serial.log`。该串行通过不抹去首轮默认并发失败，也不证明其环境原因 |
| `$env:BES_SKIP_UI='1'; node test/desktop/launch.js` | 19进程矩阵整体通过，`output/desktop-1790222346829/desktop-summary.json`；真实 worker 短时 waitForSelector 超时保留原始异常和 worker 关闭来源，主动 disconnect 不返回仍失败；两者均保留先前的数据/checkpoint、页面及人工控制，正常完成/取消/崩溃恢复继续通过 |

桌面矩阵之后补的迟到 error 优先级保护由真实 Worker 注入终止期 error 的单测覆盖，未重复跑完整矩阵。示例测试直接运行入口，在 Puppeteer 边界使用合成值，覆盖订单阶段、第二笔详情、回收站和最终 checkpoint 的故障，以及成功和分页上限语义，不代表京东页面解析或真实账号通过。只读旧 run 期间没有读取数据集/订单 DOM 或截图正文。本轮未主动重启当前用户客户端、重跑真实流程或生成发行包；原始真实异常仍需在新实现生效后的授权复验中获取。

随后 run `c149aa9b-38ef-4bb3-ab7f-abd9f824ea7d` 使用新错误保留逻辑，人工登录无须触发；执行错误被准确记录为 `The visible order-year filter was not found`，栈定位到示例 `selectYear`。该运行含登录、个人信息、身份和地址 checkpoint；profile/identity/address 数据已按阶段提交，但字段断言失败且地址列表返回 0 条；订单阶段没有开始。此前页面材料中订单范围触发器显示“近3个月订单”，示例定位器只识别“今年内订单”或具体年份标签，现加入“近 N 个月/年订单”触发器匹配。尚未在真实页面验证菜单选项能否选择目标年份，也未重跑验证；个人资料字段缺失和地址列表为空是独立的解析问题，不能因订单筛选修复而判为通过。

随后 run `19c62128-4e78-491f-9819-43b89b5df45a` / validation `722fca4f-4e18-4888-8b6a-fcc16e5b0893` 的结构化报告将原始错误保留为 worker 异常 `The requested order-year option was not visible`；`operationTransportClose.trigger=worker`、source=`local`、`inFlight=0`、`rejectedCommands=0`，不是人工交接或操作传输断线。当前版本匹配。4 个 consistent checkpoint（login-confirmed、profile-complete、identity-complete、addresses-complete）保留；订单列表尚未形成 checkpoint，覆盖未运行。机器断言另显示 profile、identity、addresses 不通过，为独立字段/列表解析缺口。基于此前已见的“近3个月订单”触发器和当年默认日期范围，推断菜单打开后当年选项可能标成“今年内订单”；修正 `selectYear` 让当年也能匹配该标签，并在选择后接受该标签作为页面确认。此修正尚未在真实页面复验；其他字段缺失仍未修复，不能视为端到端通过。

## Agent 开发入口与人工交接修复（2026-09-24）

新增 `npm run start:agent`，直接包装现有 Forge CLI，保留终端输出和 stdin。每次启动在 `output/dev/<launchId>` 保存原始 stdout/stderr、带接收时间与流名称的 console.jsonl 和 launch.json；固定 `output/dev/latest.json` 只在新启动时发布，旧启动退出不会覆盖新入口。摘要记录 Forge 与 launcher 的 PID、数据根、连接文件和应用生命周期路径，不读取 token/profile、不把 Forge 存活或退出 0 当作 Electron 就绪。项目技能和环境文档补充入口、旧实例识别及 health 核对；普通 `npm start` 的历史控制台无法补录。

交接诊断只读核对 run `1285decd-3446-4834-a3d2-cf0ed3b50298` / validation `82409605-02e4-4a9e-b1da-acc3fee40e54`：`jd-login` 人工等待从 03:11:44.346Z 开始，03:11:47.205Z 失败；报告错误为 `Workflow attempted a browser operation while control was revoked`。固定快照内没有 handoff-completed，也没有具体拒绝方法。源码确认 runner gate 当时未设置 onConflict，因此缺少冲突事件不能证明没有协议冲突。运行前后业务代码指纹还发生变化，这是独立的版本验收失败因素。本轮未修改业务脚本或操作真实页面，不能把该失败归因为用户扫码未完成。

合成复现 `output/desktop-1790220316661/desktop-summary.json` 明确记录 **Runtime.runIfWaitingForDebugger / quiesced** 被误拒。`await requestHuman` 的正常恢复顺序原本正确；Puppeteer 在收到 target 事件后会自行发送维护命令，原 gate 拒绝全部新命令，manager 又将所有拒绝归为业务越权。修复只允许当前连接已观察 session 上的有限维护，参数及父子关系受约束；输入、导航、任意 Runtime 执行和未知命令仍拒绝，failed/closed 不放行。runner 冲突新增 method/state/validationId 持久记录，错误文本也含方法名，不记录协议参数。合成发现证明这条框架路径有缺陷，但真实旧报告未记录方法，无法追溯证明每次均为同因。

`releaseHuman` 按 run/handoffId 合并并发检查，成功响应在本 run 内可重放，旧 ID 不释放下一人工窗口；UI 携带 ID 并在检查锁定时禁用按钮。选择器缺失仍失败，明确的导航上下文错误最多重试三次，其余检查错误保留原因。声明 `selector: body` 只证明 body 存在，不等于登录验收通过。

实际运行环境：Node 24.21.0、npm 11.19.0、Electron 44.4.3、Chromium 152.0.7977.130。

| 命令/入口 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd test` | **112/112** 通过，包含新启动入口的四项合成子进程测试及 gate 维护边界测试 |
| `node --import tsx --test test/unit/gate.test.ts test/unit/validation.test.ts test/unit/agent-dev-launch.test.ts` | 最后收紧 failed/closed 与参数边界后 **19/19** 通过；原有人工期间定时器写入仍导致失败 |
| `npm.cmd run build` | 通过，保留原有 bundle/source map 提示；末次 gate 收紧后另重建 main/worker |
| 独立 `BES_DATA=output/agent-start-verify-1790220610815`、`BES_TEST=1`、`BES_TEST_PHASE=startup-cold` 下 `npm.cmd run start:agent` | 真实 Forge 冷启动和正常退出通过；`startup-cold-result.json` passed=true、应用 PID 37180，生命周期 shutdown-complete/0；控制台中的 Forge 构建输出、警告、Electron DevTools 行在本次日志中可回读 |
| `$env:BES_SKIP_UI='1'; node test/desktop/launch.js` | **19 进程矩阵整体通过**，报告 `output/desktop-1790220748183/desktop-summary.json`；人工窗口内原生点击触发 dedicated worker 后跨文档导航、同 ID 并发/迟到重放、旧 ID 隔离、两处人工协作、取消及五个崩溃恢复位置通过 |

启动日志样本：`output/dev/2026-09-24T03-30-11-946Z-42884-170649c9/launch.json`、stdout.log、stderr.log、console.jsonl。合成子进程另覆盖 UTF-8 拆块、非零退出、启动失败、自定义 BES_DATA 和旧启动退出不覆盖新入口。真实终端 Ctrl+C 与 `rs` 人工交互本轮未单独验收；实现保留 stdin 并限定终止本次 Forge 子进程树。

保留中间失败：沙箱内 Electron GPU/文件页加载失败为 `output/desktop-1790220298289`，正常桌面执行后复现上述 gate 错误；修复后 `output/desktop-1790220537476` 的人工流程已完成，但测试错误假定一次过滤查询能读完所有事件而失败，随后改为固定 sequence 上界并按 nextCursor 有界续读，最终矩阵通过。技能 quick_validate.py 因两套 Python 均缺少 PyYAML 未能运行；仅正文发现规则有改动，frontmatter 保持原样并人工核对本地引用。

本轮未重跑 UI 拖动专项、30 分钟长测、真实京东流程或发行包装；没有停止/重启当前用户客户端，需下次正常启动后使用新实现。日志属于本地诊断材料，不能当作脱敏公开材料。

## 开发启动布局超时修复（2026-09-24）

用户报告 `npm run start` 偶发 `Trusted UI did not report a usable browser layout within 20 seconds`。仅只读核对原数据根的生命周期：PID 15948 于北京时间 09:23:56 启动，工作区读取在 09:24:51 完成，09:25:12 以 startup-failed / 1 退出，没有 ui-ready。工作区读取约 55 秒与随后约 20 秒的布局等待是两个阶段，不能合并解释为布局定时器过短。该次日志没有 renderer 模块错误，原事件的具体首次失败原因仍不能确定。

代码及合成复现发现：可信窗口的 `will-navigate` 一律 `preventDefault()`，也拦截 `location.reload()`；锁定的 Forge Vite 插件在 preload 构建完成时发送 full-reload，Vite 将无客户端时的消息留至首次 HMR 连接。首次 renderer 模块加载失败时，这个恢复刷新被拒绝，React 不会挂载，最终报同样的 20 秒超时。修复前的确定性注入（取消首次 `index.tsx` 请求并发起刷新）日志为 `output/startup-reload-before-1790213931528/forge.log`，记录 `STARTUP RELOAD: prevented=true` 和原始同文超时。修复后的最终开发回归取消首次模块请求后直接使用真实 Vite full-reload，没有手工补刷新，观察 **1 次刷新请求、2 次文档提交**，有效布局恢复。

修复仅放行与 `uiUrl` 完全相同的目标。新文档提交后仍隐藏原生 view，等新边界再恢复；同源不同路径、额外查询参数与外部导航继续拒绝且保留旧文档/布局。没有调整依赖、超时期限、sandbox 或 contextIsolation。加载失败新增有界 `ui-startup-failed` 生命周期状态，便于区分文档已提交但无边界、preload 失败、renderer 退出；不保存 URL、页面内容或凭据。

实际环境为 Node **24.21.0** / npm **11.19.0**；Electron **44.4.3** / Chromium **152.0.7977.130**。全部新测试使用独立合成数据根，Vite 缓存也隔离在测试数据根。

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过，包含新启动回归 TS 与 Vite 配置 |
| `npm.cmd test` | **107/107** 通过 |
| `npm.cmd run test:startup` | Forge 冷启动、热启动、首次模块失败恢复三项通过；持续模块失败负例按原 20 秒期限退出 1、没有 ui-ready 且诊断正确。报告 `output/desktop-1790214359798/startup-summary.json` |
| `npm.cmd run build` | main、worker、sandbox preload 和 renderer 构建通过 |
| `node test/desktop/launch.js --startup-only` | 构建文件入口同样三项通过及一个正确失败负例，报告 `output/desktop-1790214426083/startup-summary.json` |

成功场景还检查 preload 桥接、非零浏览器布局、三类拒绝导航不替换文档、可信刷新提交时原生 view 隐藏及新边界恢复。开发负例的诊断为 commits=2、domReady=2、boundsReports=0、documentReady=true、needsBounds=true，且 shutdown exitCode=1；Forge 外层返回 0 不作为成功依据。新入口复用 `test/desktop/launch.js`，持续故障的 `passed:false` 与 `expectedFailureVerified:true` 是预期结果，不能将其称为 UI 启动成功。

排查时另有两项非产品通过记录：沙箱内首轮 Electron renderer/GPU launch-failed（`output/startup-before-1790213711009`），随后在正常桌面环境验证；中间测试 `output/desktop-1790214302601` 的热启动文档身份断言失败，原因是测试尚未等待 Forge 首次 HMR 真实提交，后改为观察提交及有效边界后才开始拒绝导航断言，最终矩阵通过。没有通过固定睡眠跳过断言。

范围：修复并验证的是上述导航拦截路径，不能用合成注入证明用户原始模块为何失败。`inlineDynamicImports` 警告在成功和失败场景均存在，没有证据将其作为这次超时原因；构建原有指令/source map/chunk 提示仍在。未重跑完整 19 进程业务矩阵、长测、真实账号流程或生成新发行 ZIP；本轮构建文件专项不代替发行验收。

## Luna 首次任务交接的连接观察（2026-09-23）

用户要求以最少提示检验人工录制后直接交接 agent 的使用场景。新任务“京东示范交接：可重复逻辑编写与复现验证”（`01a0cd4d-f04d-7af2-97e1-18bf011d8478`）使用 **gpt-6-luna / max**，初始提示只给项目技能入口、目标 run、业务编写/复现目标及用户认可推断和脱敏值的范围，没有给具体业务接口或定位规则，也没有提供连接文件绝对路径。

用户反馈似乎不会连接后，只读检查该任务消息和工具调用：它已明确理解本机 HTTP、连接文件、token 和有界读取，但转去用桌面工具寻找客户端展示的路径；`cua.listWindows()`、`cua.listApps()` 两次调用失败，`Get-CimInstance` 拒绝访问，随后向用户询问连接文件完整路径。截至本次检查，尚未尝试读取连接文件或调用 `/v1/health`，因此不能据此判断其 HTTP 协议理解、证据还原或业务编写能力失败，也没有证据说明 token ACL 已阻断它。

当前 SKILL、API 引用和主 API 文档均要求“从客户端显示的位置读取”，没有提供 UI 不可用时的连接发现方式；仅应用源码定义了默认数据根与 `BES_DATA` 规则。这是首次交接入口信息缺口，窗口工具选用错误和进程权限失败又增加了绕行。原任务使用已知路径独立调用 health，实际 **HTTP 200 / ready / PID 35448**，应用服务仍可连接。

此外，新任务执行了读取 `docs/progress.md`、`docs/verification.md` 的命令，两份文档包含此前人工存档审查摘要。输出有截断，无法断言模型实际接收了其中所有内容，但本轮已不能作为严格隔离既有分析的盲测。项目开发约定使其同时阅读大量客户端工程文档，后续应区分业务技能使用者与客户端开发任务的入口。

建议的最小改进为交接连接文件绝对路径（不传 token）或在技能中提供确定的发现规则，再核验实例与目标 run；连接基础信息不等于业务解题提示。本轮只检查、记录，没有向新任务发送纠正提示、修改技能、重启应用或接管其业务实现。

## 京东主流程封存录制检查（2026-09-23）

按用户要求只读检查 `efc0c4e5-e9b0-470a-8f0b-0ec5636f1c4f`，未开始业务 agent 编写。全局 17,848 条保存记录编号连续，44 份源 JSONL、索引、引用及封存清单 743 个文件的 hash 核验通过；14 个 checkpoint 的截图/DOM 均 complete、consistent。但 68 个 gap 中明确包含共 **5,939 个采集任务丢弃**，因此保存完整不等于无缺口采集。

登录、个人信息、实名认证、地址、普通订单筛选/翻页、空回收站和单笔详情具备线索，足以开始主流程初版编写；末页/历史年份、非空回收站、详情变体和身份字段语义仍待补充。新 profile 在同一 Forge 实例完成本次主线；已记录响应未见 403，但不外推为无遗漏网络成功。范围、证据 ID、字段空值/遮罩和后续最小补录见 [存档评估](recording-review-efc0c4e5.md)。

## 再次异常后的启动方式核对（2026-09-23）

用户再次反馈异常，要求核对当前启动方式。本轮仅查询进程父链、客户端 health/state 及已知 run 的 manifest 元数据，没有导航、刷新、点击或读取 Cookie；本次页面异常为用户观察，未重新核验截图或 HTTP 403。

当前客户端主进程为 **PID 35448**，北京时间 **15:16:57** 启动。Windows 进程父链明确为 `npm-cli.js run start` → `electron-forge.js start` → `electron-forge-start.js` → 项目 `node_modules/electron/dist/electron.exe .`，因此当前是 **`npm run start` 的 Forge 开发模式**。HTTP health 的 processId 与此一致，连接文件和当前 run 位于 `%APPDATA%/BrowserEvidenceStudio-dev`。

当前 run `0c8002d1-2f3e-450b-a68c-f0cc104bec18` 于北京时间 **15:18:02** 创建，沿用项目 `0b86d029-b4e0-4e8e-8951-3c3314dedfce`、profile `1a88eaa6-2ebf-452e-95b1-bea37c287413`。该项目/profile 与此前异常的 `dcab5b41-dae4-4cb0-a126-f84f49c4816b`、`c3307a02-6522-4eca-9d45-05fcc7139602`、`4a5799a0-d01f-4811-bbed-37d03acb6a15` 一致。新建 run 会复用同项目/profile 的持久 session，不会自动生成全新登录环境。当前 manifest 已记录 **chrome-compatible-v1 / Chrome 152 缩减 UA / AutomationControlled disabled-at-startup**，兼容策略已启用。

此前成功的普通录制对照由 `npm run browser:baseline -- --recording` 启动，使用 `output/browser-recording-1790146574793-28576/data` 和另一个全新 profile `aad09e61-f05b-4a47-bad6-9744d07deb17`。代码对照确认两种方式运行同一 app/Studio、业务 WebContentsView、持久分区及 CDP/Puppeteer/rrweb；独立入口主要改变数据根、进程环境和宿主 UI 加载方式（构建文件而非 Vite 开发服务）。因此当前观察是回到原开发环境并复用旧 profile 后再次报告异常，尚不能证明 Forge 或旧 profile 是唯一原因。下一步有效对照仍是在同一个开发客户端使用新命名 profile，再与旧 profile 比较。

当前 capture=degraded，磁盘 manifest 原因为 `Capture queue reached its bounded budget`；与此前成功对照同样存在的采集问题分开记录。本轮没有修改代码、重跑测试、重启客户端或变更控制权。

## 全新 profile 的普通录制：京东访问确认（2026-09-23）

用户在上一节对照客户端中完成登录，反馈可查看订单并交出控制。通过该独立实例的 HTTP API 核对 PID **17540**、run `c797689d-8a86-4f46-b812-75ee472ebd94`、初始 controller=agent / leaseEpoch=2 / execution=ready。首页 page `b0758e17-6ad7-4c08-b2c1-71c2e37d3206` generation=2，当前订单 page `4b21d35c-d8ec-48a4-ab2c-a6503d729d11` generation=0；版本和 `chrome-compatible-v1` 与本轮兼容配置一致。全程未导航、刷新或点击订单操作。

两页 HTTP snapshot 的前 80 个语义元素不足以覆盖订单正文，不能因返回 outputTruncated=false 就推断完整页面已检查。随后对当前订单页保存 checkpoint **`cp-000000007518`**，采集时间 **2026-09-23T07:03:57.985Z–07:03:58.058Z**，结果为 **complete / consistent**：截图 `art-000000007515`（198,427 字节）和 DOM `art-000000007517`（154,204 字节）均完整。实际查看已保存截图，确认订单中心、列表、金额和订单详情入口正常呈现，当前视口未出现先前异常浮层。未在文档中复制订单号、收件信息或账号内容；原件仍在 Git 忽略的运行目录。

网络检查固定 **sequence 0–7518**，只投影 pageId、navigationGeneration 和状态码，有界续读完成。共 **841 条已记录的 network-response：828 个 HTTP 200、13 个 304、没有观察到 403**。首页 generation=2 为 261 个 200 和 6 个 304，订单页为 98 个 200。两页各有 capture-ready，且均有 rrweb-full-snapshot，说明普通采集确实运行；不是仅把 UI 标成录制。统计只覆盖已采到的响应，不承诺丢弃或接入前请求也完整。诊断摘要保存在 `output/browser-recording-1790146574793-28576/inspection.json` 和 `network-inspection.json`。

采集健康仍为 **degraded**，与业务页面可用分开判定：

- 固定区间有 5 条 gap：2 条 request-body-read-failed，以及弹窗的 response/completion-without-observed-request 和 popup-before-capture-ready。这些 gap 并不直接设置 degraded；请求正文副本读取失败也不等于请求发送失败。
- 公开 GET run 返回的 captureHealthReason 缺失。只读代码确认该路由取 `studio.runs` 初始缓存，而 `EvidenceStore.updateManifest()` 替换了 store.manifest 对象，缓存未同步；summary/active state 也未暴露原因。这是独立的 API 元数据可见性缺口，本轮未修改代码。
- 在已知 run 的磁盘 manifest 中仅读取健康元数据，确认 `captureHealthReason` 为 **`Capture queue reached its bounded budget`**。该标记由队列的条数或估算字节上限触发，首次置位后不会自动恢复；现有字段不足以分辨是哪项预算先触发或给出累计丢弃数。不能宣称本段录制完整，也不能把队列触顶当成旧京东 403 的已证实原因。

结论：**当前 Electron + 正常 CDP/Puppeteer/rrweb 采集，在新工作区和新 profile 的这次会话中可正常登录、展示首页和订单。** 与旧环境失败、无采集新环境成功对照后，旧 profile/会话及当时运行状态更值得优先排查；不能断言旧 profile 已损坏或具体哪项站点存储导致拒绝，也没有依据据此停用 rrweb 或立即迁移浏览器。新旧实验还改变了进程、登录会话与时间，下一步在默认客户端使用新命名 profile 复验，不删除或复制旧 profile；采集预算和健康字段另行修复。

检查收尾时控制代际已被更新，最初按 leaseEpoch=2 的交回操作在本地核验阶段停止，未发写请求。重新核对同一 run、订单页、agent / ready / leaseEpoch=5 后，仅交回 human，确认 **leaseEpoch=6**。保留页面、登录状态和正在录制的 run，未封存或关闭。本轮为实时核验与文档维护，没有执行代码回归或修改运行实现。

## 独立无采集 Electron 对照（2026-09-23）

用户授权执行前述最小对照。新增 `npm.cmd run browser:baseline`，在单独的构建输出和全新 userData/sessionData 中启动 WebContentsView；共享 `chrome-compatible-v1`、原生安全和权限策略，但不初始化 Studio、调试端口、Puppeteer、rrweb、业务 preload 或 agent API。未覆盖 Forge 主产物，也未接管原客户端或旧原型的页面。

本批 Node **24.21.0** / npm **11.19.0**，Electron **44.4.3** / Chromium **152.0.7977.130**，依赖和锁文件未变。`node --check scripts/browser-baseline.mjs`、`npm.cmd run typecheck` 及 `git diff --check` 通过；首次类型检查发现 WebContents 没有公开 `close` 事件，已去掉该监听，使用 `destroyed` 清理宿主并覆盖 guest 主动关闭场景。

`npm.cmd run browser:baseline -- --verify` 首次在执行沙箱中失败：GPU 子进程多次以 **-1073741515** 退出，合成主页面 `ERR_FAILED (-2)`；失败报告保留在 `output/browser-baseline-1790145914347-46808/verification.json`。未更改 GPU/安全参数，在正常桌面环境用相同命令重跑通过，报告为 `output/browser-baseline-1790145960606-21540/verification.json`，Electron PID **34456**，进程正常退出码 **0**。

通过范围：

- 页面自身通过 loopback HTTP 上报首次主文档、同源 iframe、原生弹窗、主文档刷新和 iframe 刷新共 **5 个上下文**；测试不使用 CDP、evaluate 或 executeJavaScript。合成服务器限制来源、随机路径、请求数、正文预算和等待期限。
- 初始导航/早期脚本/fetch 的 UA 一致、webdriver=false、getter 保持原生、页面无 Node 能力；弹窗保留 opener，共享该独立 session 内的合成 cookie/localStorage。首次导航仍没有 UA-CH，fetch 携带 Chromium 152 原生提示，与前次有采集基线观察一致。
- 两个业务视图保持 sandbox/contextIsolation/webSecurity，nodeIntegration=false，无 preload，debugger 未 attached。启动没有 remote-debugging-port/pipe，也未生成 DevToolsActivePort。构建模块清单只有 baseline、environment 和合成验证模块，无 Studio/采集/自动化库；主世界 recorder 属性检查仅是补充，不能单凭它证明不存在隔离世界代码。
- 从 popup WebContents 发起关闭后，其宿主销毁且 opener 保留；随后关闭主宿主，两个业务 WebContents 均销毁。新 profile/sessionData 位于本次独立目录。

随后第一次用 `npm.cmd run browser:baseline` 启动真实对照，输出 `output/browser-baseline-1790145989190-43940`，Electron PID **10224**。`ready.json` 确认无采集、human 控制和独立目录；`initial-load.json` 于 **2026-09-23T06:46:38.018Z** 记录初始 loadURL 完成。只读进程检查确认没有调试开关，NetworkService PID **35536** 当时有 **42 条 Established** 连接到 `127.0.0.1:7897`；这仍不证明每个京东请求的最终出口。

用户反馈看不到窗口。该进程与桌面同属 Session 1，但 MainWindowHandle=0，Computer Use 也未列出该窗口，故不能将前述 ready/loaded 当作可操作交付。定位到启动器错误使用 `windowsHide: true`；改为交互浏览器的 `windowsHide: false`，核验进程路径与本次输出参数后只关闭 PID 10224，再次启动。新输出为 `output/browser-baseline-1790146250134-40572`，Electron PID **38996**，初始页面于 **2026-09-23T06:50:53.428Z** 加载完成。Computer Use 随后唯一定位到标题“Electron 无采集对照 · 京东…”的原生窗口并成功置前，未点击网页或操作登录。此修复后重新进行了独立构建及实际窗口显示检查，未在用户登录期间再打开合成窗口干扰操作。

窗口可见后，用户明确反馈 **“首页和订单均正常”**。这是本次全新 profile、无调试/采集入口的人工验收观察；没有读取真实页面正文或自行判定接口全部通过。它证明该 Electron 组合在此条件下可以完成用户检查的登录后访问，不能笼统认定 Electron 必然不兼容京东。

后续新增 `npm.cmd run browser:baseline -- --recording`，复用现有三份 Vite 配置独立构建普通客户端，不覆盖 `.vite`，创建全新数据目录。实际输出 `output/browser-recording-1790146574793-28576`，Electron PID **17540**；main/preload/renderer 构建完成，生命周期已到 ui-ready，版本为相同 Electron/Chromium、Puppeteer **25.11.0**、rrweb **2.1.6**。构建有既有 use-client、chunk 大小和 sourcemap 警告，未阻止启动；`node --check` 和 `git diff --check` 通过。

依据项目技能，通过该新实例的 HTTP health/capabilities/state 确认空工作区后，创建项目 `ac3f112c-5bf4-4295-ac73-fcca02f51ca8`（JD fresh-profile recording comparison）、全新 profile `aad09e61-f05b-4a47-bad6-9744d07deb17`、run `c797689d-8a86-4f46-b812-75ee472ebd94` 并打开京东。返回 human / ready / leaseEpoch=1，未取得 agent 控制。初始 summary 已有采集事件和原件，但 active capture 标记 **degraded**，有界 gaps 当时为空，具体采集缺口尚未定位；不得宣称录制完整。

定位正常录制窗口时，Computer Use 报告用户按物理 Escape 停止操作，已立即停止后续桌面输入。该普通录制对照的人工登录/首页/订单结果仍未知；无采集成功窗口保持用户控制。接续只读此新 run 的摘要/健康，真实页面写操作仍须遵守 human 控制边界。

本批只新增诊断入口，没有重跑完整 19 进程回归、长测或生成新发行包。新 profile 与移除调试/采集同时变化；即使人工复测正常，也必须与新 profile 的普通录制模式再比较，不能直接将 rrweb/CDP 判为根因。真实 profile 只保存在 Git 忽略的本地输出中。

## 京东兼容调整后的受控实测（2026-09-23）

用户反馈新版仍异常，在客户端点击“交由 agent 控制”并授权测试。依据项目内 `skills/browser-evidence-studio/SKILL.md` 和 HTTP 协议，从原开发客户端连接文件读取凭据，仅在进程内使用；没有访问内部 CDP、注入任意脚本、复制 profile 或调整系统网络。实际客户端 PID **37360**，run `4a5799a0-d01f-4811-bbed-37d03acb6a15`，页面 `27b7c086-8454-4ee8-a3c2-ead5cd1c238f`。初始 controller=agent、leaseEpoch=2、generation=5、execution=ready；manifest 已记录 `chrome-compatible-v1`，实际请求 UA 也已是缩减 Chrome 格式，排除“仍在运行旧策略”这一解释。

先读取 summary/gaps 和有限 snapshot。snapshot 中保留登录用户区域，但其前 80 个语义元素的范围没有覆盖异常浮层；不能据此判断页面正常。保存 checkpoint `cp-000000006205`，截图 `art-000000006203` 明确为“当前页面异常 / 请刷新或切换账户试试”。截至 sequence **6264** 的有界索引读取包含 **70 次 HTTP 403**；首页核心 GET 与 OPTIONS 200 分开统计，不能将预检成功算作业务成功。初始 capture=degraded，已见请求正文读取失败 gap；本轮不宣称整个录制无缺失。

北京时间 **14:11:42.879** 经受控 action 对同一 `https://www.jd.com/` 执行一次 navigate，成功后的 generation=6；没有清缓存、切换账号或循环刷新。等待约 6 秒后保存 checkpoint `cp-000000007484`，截图 `art-000000007482` 与前一截图 SHA-256 相同，两份 checkpoint 都是 complete/consistent。读取固定区间 **6318–8363**：响应 **197 次 200、45 次 304、25 次 403**；核心 `qryCompositeMaterials`、`pchome_horizontalnav`、`pc_home_background`、`pchome_firstScreenSoa`、`pctradesoa_getStation`、`pc_home_feed` 的 GET 仍失败。该范围包含页面自身重试，只有一次 agent 导航。

代表响应 `evt-000000006518` 与请求 `evt-000000006908` 按 requestKey 对齐：实际 UA 为 `Chrome/152.0.0.0` 格式，无 Electron/应用标记；请求携带原生 Chromium 152 低熵 UA-CH。响应为 **HTTP/2 403、TLS 1.3、securityState=secure、content-length=0**。另一个 `pc_home_feed` 响应 `evt-000000007023` 的正文事件 `evt-000000007139` 引用 `art-000000007026`，有界回读确认 **captureStatus=empty、0 字节、完整空串 SHA-256**，不是读取失败。部分其他请求后续为 ERR_ABORTED，其正文状态不能据该样本外推。

与用户控制台日志分开核对：全 run 截至本轮网络失败读取，共 **39 条**（36 ERR_ABORTED、1 ERR_CONNECTION_CLOSED、2 ERR_BLOCKED_BY_ORB）。唯一连接关闭 `evt-000000005075`，北京时间 **14:06:09.268**，关联请求 `evt-000000004755` 的 `GET https://sso.jingbantong.com/sign`；无法把控制台所有握手日志都映射为这一个事件。首页已收到 HTTPS 403 的请求不是同一次握手失败。Chromium [错误枚举](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h) 中 -105 为 NAME_NOT_RESOLVED，-100 为 CONNECTION_CLOSED；STUN 域名解析失败不等于京东 API 域名解析失败。Forge/Vite 的 `inlineDynamicImports` 警告来自插件默认内联参数和 preload 的 `codeSplitting:false` 重复，构建和应用启动已成功，不是京东 HTTP 403 的证据。

实际响应连接地址为 **127.0.0.1:7897**；在与客户端同一实际用户上下文只读核对，系统 ProxyEnable=1、ProxyServer=127.0.0.1:7897，监听程序为 **verge-mihomo**。沙箱进程的 HKCU 曾显示不同设置，未将其当作宿主配置。没有修改代理；普通 Chrome/参考内置浏览器的实际出口和代理规则尚未对照，不能直接认定代理导致拒绝。

结论：第一轮 UA/AutomationControlled 调整确已应用，但未解决真实京东首页兼容性；用户区域存在与核心接口被拒同时发生，不能判断账号被封禁。后续有效对照应优先明确各浏览器实际网络路径，并区分录制器存在与否；仅暂停采集仍保留连接/注入，不能作为完全无录制器对照。本轮只测试和记录，没有修改运行中的产品源码、系统代理或证书策略。结束时通过 HTTP control 成功交还 human，leaseEpoch=3；保留正在录制的 run 和两份诊断 checkpoint，没有封存或退出用户客户端。

## 浏览器兼容策略与原生环境对照（2026-09-23）

用户要求先让客户端环境尽量靠近 Chrome，并补充 ChatGPT 内置浏览器可正常登录、访问京东的截图。该截图支持“内嵌浏览器不必然异常”，不能提供其底层完整配置；参考浏览器的只读接口未暴露 navigator，未取得可用于逐字段复制的环境数据。本轮未自动操作京东登录或复制账号/profile。

新增 `src/main/browser/environment.ts`，在创建 session/WebContents 前使用 Electron 原生 `app.userAgentFallback` 配置实际 Chromium 主版本的缩减桌面 UA，并在启动时禁用 Blink `AutomationControlled`。实测 UA 为 `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`。保持动态 loopback CDP、普通 Puppeteer、原生 getter、语言/UAData、profile 分区和安全隔离；不增加请求头改写或页面属性补丁。新 run 的 `browserEnvironment` 保存配置快照，包含 `clientHintsPolicy`，该字段描述策略，不表示 HTTP 各类 Client Hints 均受支持。

实际环境为 Node **24.21.0** / npm **11.19.0** / Electron **44.4.3** / Chromium **152.0.7977.130** / Puppeteer **25.11.0**。日志目录 `output/chrome-compat-20260923`；`npm.cmd run typecheck`、`npm.cmd test` **107/107** 和 `npm.cmd run build` 通过；最终类型检查与构建日志为 `typecheck-final.log`、`build-final.log`。

首轮合成桌面回归 `output/desktop-1790139265908`（PID **35056**）在“导航请求应带低熵 Client Hints”断言失败。页面 UA、原生 getter、webdriver=false、DOM 低/高熵 UAData 和安全隔离已符合预期，fetch 请求也有原生低熵提示；只有导航头缺失。该失败报告保留，未将其覆盖为通过。

随后以同一 Electron、`remote-debugging-port=0`、相同安全参数、独立合成 profile 启动两个原生 WebContentsView 进程，对比未设置 UA 的基线（PID **2224**）与兼容配置（PID **2764**）。仅访问 loopback，两次连续导航均不携带低熵 UA-CH；fetch 低熵头和 JS 高熵信息完全一致，fetch 未随 `Accept-CH` 增加高熵头；`navigator.webdriver` 由 true 变为 false。报告为 `native-environment-baseline.json`、`native-environment-compatible.json`，可丢弃诊断脚本为同目录 `native-environment-probe.mjs`，两个进程均正常退出。由此确认导航提示缺失是该 Electron 基线行为，不是本次 UA 覆盖造成的退化。

源码佐证：[Electron 44.4.3 BrowserContext](https://github.com/electron/electron/blob/v44.4.3/shell/browser/electron_browser_context.cc#L634-L637) 的 `GetClientHintsControllerDelegate()` 返回 nullptr；[WebContents UA 设置](https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_web_contents.cc#L3136-L3142) 已提供原生 metadata。依据独立对照结果，回归断言改为强校验导航/请求/DOM UA 一致、fetch 低熵及 JS 高熵提示保留，并显式登记导航头缺失限制。未通过全局补造请求头来声称已等同 Chrome；升级 Electron 时须重新核验此边界。

兼容专项在 `output/desktop-1790139655977/browser-environment-result.json` 中通过，主进程 PID **42872**。分别核验首个主文档、同源 iframe、普通 Puppeteer 刷新和原生 `window.open` 弹窗的首个请求，HTTP/DOM UA 一致，页面首段脚本读到 webdriver=false；getter 无实例补丁，Node 全局不可见，sandbox/contextIsolation/webSecurity 均为 true，nodeIntegration=false；原生 fetch 低熵和 JS 高熵提示保留，采集仍处于 recording。独立读回该 run 的 `manifest.json`，环境配置与报告一致。尚未单独验证 worker、跨域 iframe、HTTPS 提示协商或第三方网站的全部环境特征。

最终临时设置现有 `BES_SKIP_UI=1` 执行 `node test/desktop/launch.js`，退出码 **0**，`output/desktop-1790139655977/desktop-summary.json` 的 **19 进程矩阵通过**，日志 `desktop-final.log`。主阶段 PID **42872**、profile 重启 PID **3608**；普通 Puppeteer 操作/脚本、控制交接、采集/checkpoint、HTTP、五种强杀边界的两次重开和两个退出场景通过。该命令跳过 UI 专项且没有运行长测；导航 Client Hints 限制仍明确保留在兼容专项报告中。

本轮仅重新构建开发客户端，没有重新打包 EXE/ZIP；先前产物不包含该策略。完全退出旧开发客户端后运行 `npm.cmd start`，继续选择原项目/profile 即可进行人工京东对照。真实京东接口是否恢复仍未验证，30 分钟长测和 UI 拖动的历史失败也没有被本次兼容专项覆盖。

## 京东人工录制的只读诊断（2026-09-23）

用户提供两段已封存的本地录制 `dcab5b41-dae4-4cb0-a126-f84f49c4816b`、`c3307a02-6522-4eca-9d45-05fcc7139602`，并反馈同机、同网络的常用 Chrome 正常，只有客户端异常。这是用户已有对照观察，未由 agent 重新登录验证。本批仅用 EvidenceReader 摘要/索引定位后读取有界证据及 checkpoint，未操作网站、重试登录、修改浏览器配置或运行测试。原件保留在本机开发数据目录，本节只登记脱敏诊断和引用，不复制真实录制、账号标识或登录数据到仓库。

- 两段 run 均记录 Electron **44.4.3**、Chromium **152.0.7977.130**、Puppeteer **25.11.0**，来自 `BrowserEvidenceStudio-dev`。第一段的实际请求 User-Agent 包含 `BrowserEvidenceStudio/0.1.0` 与 `Electron/44.4.3`，UA-CH 含 `Chromium/152`；这是已观察到的环境差异，不单独证明拒绝原因。
- 第一段扫码检查正文 `art-000000005916` 在北京时间 **11:53:12.950** 返回业务 `code=200`；`cp-000000010293` 的截图显示京东首页已出现登录用户区域。说明登录流程至少曾进入已登录界面，不能将后续异常直接等同于扫码始终未成功。
- 第二段 `cp-000000006951`（北京时间 **11:59:30**；截图 `art-000000006949`、DOM `art-000000006950`）明确显示“当前页面异常 / 请刷新或切换账户试试”。对应 DOM 使用 `jd-main-risk-fallback` / `jd-main-risk-title` 类名；页面并未明确宣布账号被封禁。
- 第二段首页接口实际返回 HTTP **403**，包括 `qryCompositeMaterials`、`pchome_horizontalnav`、`pc_home_background`、`pc_home_feed`、`pchome_firstScreenSoa` 等。首个已定位 403 为 `evt-000000000284`，北京时间 **11:57:59.896**，早于本次跳转登录页（11:58:05.489）；登录后及刷新后也再次出现。因此问题不应限定为登录完成瞬间。
- 第二段已记录响应中共有 **64 次 403**（另有 715 次 200、78 次 304）；部分同名接口的 200 来自 OPTIONS 预检，不能算 GET 业务成功。`pchome_horizontalnav` 的代表响应 `evt-000000001215` / `evt-000000003621` / `evt-000000005628`，关联正文 `art-000000001232` / `art-000000003641` / `art-000000005632`：均有 `content-length: 0`，按 ID 核验为 `empty`、0 字节及正确空内容 hash，而非采集读取失败。正文没有业务错误码或具体拒绝原因。事件为 host-received 时间，异步请求正文落盘可能改变事件序号先后，不能用序号推导精确网络时序。
- 首页脚本 `jd_home/0.0.190/static/js/index.chunk.js` 在 `evt-000000001225`、`evt-000000003623`、`evt-000000005627` 报 `AxiosError: Request failed with status code 403`；随后还有 `Timeout and no data return`。403 与风险兜底页面支持“客户端环境下首页请求被限制”的判断，但仅凭时间相关和 DOM 类名尚不能确定具体风控规则或唯一触发因素。

采集限制单独记录：第二段有 9 条 gap，其中 `evt-000000006954` 于北京时间 **11:59:32.581** 记录背压丢弃计数 **1,485**，另有 1 条请求正文读取失败及 7 条停止时在途。上述具体 GET 403 的正文已单独核验，但不能将全部录制宣称完整；也没有证据证明采集背压导致京东拒绝请求。

录制时的源码存在独立持久 profile（`studio.ts` 的 `session.fromPartition`）、始终建立的观察 CDP/Puppeteer 连接、`remote-debugging-port=0` 以及全部拒绝的站点权限处理；没有 UA 覆盖、请求改写或代理设置。UA、自动化相关特征、profile/站点存储和录制行为都属于待拆分的环境差异，不能把所有因素归为 UA。尚未实测这两段页面的 `navigator.webdriver`，也未证明站点曾请求被拒绝的权限。暂停录制保留观察连接/注入，不能充当无录制器对照。

诊断判断：结合用户的普通 Chrome 正常对照，客户端环境或其独立会话更值得优先排查；账号本身被封禁没有证据。该只读诊断阶段未实施修复；用户随后授权的浏览器兼容调整另行记录，不能将真实京东兼容性标为通过。

## 本地重新打包与长测推进（2026-09-23）

用户说明本地尚未重新编译打包，并要求先打包再推进长测。本批使用 Node **24.21.0** / npm **11.19.0**，没有升级依赖；锁文件 SHA-256 为 `aaeca20cd2ca57f8d6bbac8c9e67a03c35bbfacc8d49b5acfe6d39de445b2c9c`。日志汇总目录为 `output/package-soak-20260923`。

- 初始源码 `npm.cmd run typecheck` 与 `npm.cmd test` 通过，**102/102，0 失败、0 跳过**；日志 `typecheck-initial.log`、`unit-initial.log`。
- 首次 `npm.cmd run make` 完成 Vite 编译，但写入 `%LOCALAPPDATA%/electron/Cache` 被沙箱以 EPERM 拒绝；`make-initial.log` 保留失败。经批准在沙箱外重跑同一命令成功，生成 Windows 应用目录和 ZIP，日志 `make-elevated.log`。没有更改系统防火墙或依赖版本。
- 对新包执行 `node test/desktop/launch.js '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe'`，**19 进程矩阵通过**。报告 `output/desktop-1790127375834/desktop-summary.json`，主阶段 PID **24536**、profile 重启 PID **28176**，五种强杀边界的两次重开和两个退出场景均通过。
- 初始包 `app.asar` SHA-256 为 `7d13f64dd6907581e9e2d8f80c6bfd9b1d51ed518ebe1508ab04395731113de1`；ZIP 为 **173,852,328 字节**，SHA-256 `f1a0c2276bd340916685aa4e9a784d1a361b343aed230ce35fe0ebe2c5432ec0`，元数据保存于 `package-initial.json`。这是长测增强前的产物，后续测试代码变化需要重新构建。

本批长测负载与阈值已在 implementation-plan.md 预先登记。增强内容包括唯一动作/请求序列、浏览器确认正文与落盘 hash 比较、HTTP checkpoint 持久完成计时、固定预算查询、进程内存采样、独立原件 hash 与索引重建，以及第二进程对同一长 run 的显式核验。采集与产品协议没有变更；main 的调整仅位于桌面测试分支。`npm.cmd run typecheck`、`npm.cmd test` **107/107** 通过，包含新增分页/篡改/缺失原件测试，日志 `typecheck-final.log`、`unit-enhanced.log`。

`npm.cmd run test:soak -- --soak=1` 完成 **60 次点击、61 个响应、1 个 checkpoint**，无跳过调度槽；checkpoint 完成 **110.33 ms**、摘要 P95 **34.34 ms**、HTTP 提交 **7.47 ms**。这里 checkpoint 与提交各只有一个样本，仅用于机制预检。报告 `output/desktop-1790127902654/desktop-summary.json` 的 19 进程矩阵通过；主进程 **26656**，新进程 **29048** 复核 **69 个文件 / 5,910,471 字节**和索引，重建 **532.73 ms**。预检构建之后补强了 response/body 事件 URL 与同 requestKey 请求 URL 的一致性断言，最终包包含该断言，类型检查通过。

最终 `npm.cmd run make` 成功，日志 `make-final.log`。`app.asar` 为 **107,377,915 字节**，SHA-256 `24730d51417ad8dab335b2a30f397b608d20a75146f353abc26e3bbba6d1093d`；ZIP 为 **173,873,306 字节**，SHA-256 `fcb89b0c10b1108f447311cf87fd592db3874e73e138a20cd3473667dd36302d`。`package-final.json` 和 `source-final.json` 记录包与源码摘要；已从 ASAR 核对响应身份断言、耐久计时及内存检查确实存在。全部诊断结束后复核 **98 个源码/配置文件摘要，0 差异**，ASAR/ZIP 摘要也仍一致；后续只更新了文档。

对最终包执行 `node test/desktop/launch.js '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe' --soak=30` 的前两次尝试均在 UI 拖动断言失败，长测尚未开始：`output/desktop-1790128231817`（PID **3792**）、`output/desktop-1790128259261`（PID **19932**）。两次 pointerdown 后都插入了 `buttons=0` 的额外 pointermove，分栏未移动；与此前记录的现象相同，来源未确认。本轮没有修改或放宽拖动断言，两次保留为失败。

随后以同一最终包、同一命令，临时设置现有 `BES_SKIP_UI=1` 执行长测专项，跳过主阶段 UI 专项。报告目录为 `output/desktop-1790128308349`，日志 `soak-30min-focused.log`；主进程 PID **28776**，runId `f8782c11-11d2-4ba4-8e0a-42472ec9f8a2`。本轮达到 30 分钟且没有提前退出，但因固定负载节奏不达标，**整体失败、退出码 1**。启动器按现有断言停止，因此自动 profile/长 run 重开、强杀矩阵和退出专项均未运行；不能把前述短矩阵的通过外推到本轮。

| 核验项 | 本轮实测与判定 |
| --- | --- |
| 持续负载 | 最后负载内存样本为 **1,801,115 ms**；完成 **1,799 / 1,800** 轮，漏 **1** 个调度槽，**363** 轮处理超过 1 秒，单轮最大 **1,564.57 ms**。严格节奏判定失败。最终 `elapsedMs=1,834,113` 包含尾部核验，不能作为纯负载时长。 |
| 点击与网络 | **1,799** 次已确认点击、**1,830** 个唯一请求/响应正文全部匹配身份、次数、字节数和 SHA-256；正文合计 **150,405,120 字节**。其中有 31 次 1 MiB 请求：首轮保存一次，末轮跨过 30 分钟边界又触发一次。gap **0**；仅对这些受核对集合成立，不证明每个 DOM tick 都被 rrweb 收录。 |
| checkpoint 完成 | **31** 个，HTTP 提交到 succeeded job 的 P95 **260.36 ms**，小于 2 s；包含耐久完成与最多 50 ms 查询轮询等待。100 ms 界面可见反馈没有测量。 |
| HTTP 与摘要 | job 提交 **31** 个样本，P95 **9.73 ms**；运行期间摘要 **182** 个样本，P95 **26.72 ms**。分别低于本次 300/500 ms 阈值；摘要是不同历史规模的混合样本，不证明“已积累完整 30 分钟历史”的重复查询 P95。 |
| 有界字段回读 | 初期/末期读取同一正文 `tailMarker`，预算均为 **1,024 字节**，实际均 **336 字节**，耗时 **12.66 / 17.80 ms**，值一致、无截断。 |
| 原件与索引 | **1,919** 个封存文件，**178,146,522 字节**；事件 **10,991**、artifact **3,724**、checkpoint **31**、raw **28,968**，lastSequence **43,714**。本进程独立 hash 与索引重建通过，尾部核验共 **32,947.48 ms**。 |
| 内存 | **182** 个样本；主进程 RSS 峰值 **246.23 MiB**，页面私有内存 **52.65 → 488.61 MiB**，未触及 1 GiB / 512 MiB 保护上限。去掉前 5 分钟后，主进程 RSS 斜率 **2.30 MiB/min**，页面私有内存 **13.30 MiB/min**；尚未证明增长受控或无泄漏。 |

内存窗口（中位数，MiB）为：0–5 / 5–10 / 10–20 / 20–30 分钟，页面私有内存 **92.56 / 180.54 / 301.02 / 418.17**；主进程 RSS **170.18 / 184.15 / 199.25 / 227.37**。页面 JS heap 在约 3.7–7.2 MiB 间波动，没有同量级增长；主进程含夹具服务和测试逻辑，不能把其数值直接当纯产品开销。最后 30–60 分钟统计桶只有边界附近 2 个样本，不代表又运行了 30 分钟。

只读分析将漏槽定位到第 1,080 轮（约 18 分钟）：command 到 rrweb 原始 click timestamp 等待约 **944 ms**，click 后约 **30 ms** 已保存 action；该轮的大正文/checkpoint 使下一轮跨过计划槽位。各 5 分钟窗口前 1,280 轮 command→action P95 约 **949–968 ms**。Puppeteer 点击前的可见性检查/页面调度是待验证候选，当前缺少各阶段计时及焦点、visibility、遮挡记录，不能确认因果或归因用户操作。采集 backlog、页面私有内存增长的根因也没有确认；多个 CDP Network 会话的缓冲值得单独对照验证，尚未修改其行为。

原 `soak-result.json` 与 `desktop-summary.json` 保留失败。随后独立诊断启动同一 EXE，设置 `BES_TEST=1`、`BES_TEST_PHASE=profile-restart`、`BES_DATA` 为上述目录，且不传 `BES_EXPECT_SOAK`：新 Electron PID **6904** 的 profile 持久化/隔离检查通过并正常退出。再由新 Node PID **4140**（`node --import tsx --input-type=module`）执行 `verifySoakEvidenceSnapshot`，将长 run 与第一进程保存的 snapshot 比较；**1,919 个文件 / 178,146,522 字节 / 31 个 checkpoint** 全部通过，核验 **15,556.35 ms**，其中重建 **11,885.55 ms**。结果保存在同目录 `soak-diagnostic-reopen.json`，日志 `output/package-soak-20260923/soak-diagnostic-reopen.log`。这是“Electron 重启后由新 Node 进程独立复核长档案”的诊断，不是原自动第二阶段通过；原自动阶段仍为 `not-run`。

本次明确遗留：严格每秒负载未达标；页面私有内存持续上升；最终包 UI 拖动两次失败；完整 30 分钟存量摘要 P95、100 ms 可见反馈和所有 rrweb 变更完整性尚未证明。下一轮先补点击分段计时、独立的负载结束时间，以及失败后仍可开展证据重开诊断的报告结构，再按实证定位瓶颈，不能降低原有阈值。启动器精简诊断仍读取旧 `saved.cycles` 字段，当前轮数以 schema 2 的 `load.completedCycles` 为准；本轮产物冻结后没有改写代码。

## 进度核查与本地材料状态（2026-09-23）

按进度总结请求，在 `main` / `7d011c8` 上读取设计、架构、实施计划、进度记录及现有源码；开始核查时工作树干净。`node --version` / `npm --version` 实际为 **24.21.0 / 11.19.0**。本轮没有运行类型检查、测试、构建或桌面应用，没有重新验收历史通过结果。

- `Get-ChildItem output` 当前只列出 `desktop-1790079502939`、`desktop-1790079600870`。已读取这两份 `desktop-summary.json`，均为 `passed: true`，仅对应下方主目录迁移后的历史两进程回归。
- 下节引用的 `output/desktop-1790105788982/desktop-summary.json` 及 `output/alias-validation-1790104668534` 不在当前目录，前端批报告目录也不在。最新 **102/102**、**19 进程**和打包主阶段通过保留为当时的文档记录，本轮无法从这些原始报告独立复核；未推断文件缺失原因，也不据此推翻历史记录。
- `Get-FileHash -Algorithm SHA256` 核对现存 `out/Browser Evidence Studio-win32-x64/resources/app.asar` 为 `48c874871706afb770bec0beb9b0dd0320def477bcda3d14bcc423847e5a7daf`，不同于下节最新包的 `7a6b1381dd3cf6c1f0ccd0175961f9e041b771b1ccc529995de5d086ee637639`。
- 现存 `out/make/zip/win32/x64/Browser Evidence Studio-win32-x64-0.1.0.zip` 为 **167,341,123 字节**，SHA-256 `ccde7da6f66467e4dd44820c69178be079f24a685f43830246b24b94542fb3fa`，与下方 `f8e6eb8` 历史 ZIP 完全一致。现存包不能作为当前源码交付物，发行前需重新建立源码、产物与报告的对应。
- 静态核对长历史边界：`Studio.state()` 返回全部 run，前 100 条限制实际位于 dispatch 的 `runs` 列表接口；已修正 progress 的旧表述。checkpoint/gap 的 UI 续页、回放定位与示范基线持久关联仍未实现。

本轮仅同步说明文档，没有修改功能或生成新的通过结论。

## 统一源码别名（2026-09-23）

收到前端完成交接后，将根 paths 统一为 `@/* -> ./src/*`，三份 Vite 配置启用原生 `resolve.tsconfigPaths: true`，shadcn 五个 aliases 使用 `@/renderer/...`。源码/测试共 55 文件、125 处导入字面量改变，另外调整 5 份配置；独立复核确认每处仍指向原文件，其余源码逻辑、运行时路径及前端改动保持原样。package.json 和锁文件字节未变，后者 SHA-256 仍为 `aaeca20cd2ca57f8d6bbac8c9e67a03c35bbfacc8d49b5acfe6d39de445b2c9c`。未迁移 Vitest。

实际环境为 Node **24.21.0** / npm **11.19.0** / Vite **8.3.0** / TypeScript **7.0.2** / Electron **44.4.3**。统一实验目录为 `output/alias-validation-1790104668534`，以下日志均位于该目录，除非另列完整相对路径。

| 命令 / 场景 | 实际结果与材料 |
| --- | --- |
| 隔离目录内固定 shadcn CLI 4.21.0：`info --json`、`add button dialog sidebar --dry-run`、`add button dialog sidebar --yes` | 配置解析、预览、实际生成通过；9 个组件/Hook 文件和 8 处 `@/renderer/...` 导入符合预期。`fixture-paths.json` 与 `*-result.json` 记录结果；CLI 直接联网未通过，成功依赖下述受控 registry 转发。 |
| fixture 中 `npm.cmd run typecheck`、`npm.cmd run build` | 实际导入生成组件后类型检查与 Vite 构建通过；`fixture-typecheck.log`、`fixture-build.log`。只在 fixture 安装依赖，没有把这些新增依赖加入产品。 |
| 根项目 `npm.cmd run typecheck`、`npm.cmd test` | 类型检查通过，**102/102 测试通过，0 失败、0 跳过**；`typecheck.log`、`unit.log`。 |
| `npm.cmd run test:integration` | 三个 Vite 产物构建成功；首轮主进程 PID **20424** 在布局拖动断言失败，`output/desktop-1790105742693/desktop-summary.json` 为 passed=false，后续进程未运行。 |
| 同一构建执行 `node test/desktop/launch.js` | **19 个 Electron 进程完整矩阵通过**，`output/desktop-1790105788982/desktop-summary.json` 为 passed=true；主阶段 PID **30696**，profile 重启 PID **27828**，五种强杀边界的重开/重复重开及两个退出场景均通过。日志 `integration-recheck.log`。 |
| `npm.cmd run start`，独立 `BES_DATA` / `BES_TEST=1`，清除 `ELECTRON_RUN_AS_NODE` | Forge 开发模式完整主阶段通过，Electron PID **22716**，退出 0；`forge-1790105985597/test-result.json` 与 `runtime-check.json`。实际 URL `http://localhost:8246`，HTML、`/@vite/client` 均为 200，同端口 HMR WebSocket 收到 connected；只验证连接，没有通过改源码触发一次热更新。 |
| `npm.cmd run package` | 成功生成当前源码的应用目录，日志 `package.log`。使用既有 Electron ZIP，已重新核对 SHA-256 为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`；该值与此前核验的官方清单一致。未运行 make 生成分发 ZIP。 |
| 新包 `out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe`，独立 `BES_DATA` / `BES_TEST=1` | **打包主阶段通过**，实际 PID **28016**、退出 0、shutdown-complete；`packaged-1790106170900/test-result.json` 与 `runtime-check.json`。覆盖真实 renderer/preload、runner 五变体、人工交接、HTTP、checkpoint 与恢复界面；此轮包未单独复跑 profile-restart 或强杀矩阵。app.asar SHA-256 为 `7a6b1381dd3cf6c1f0ccd0175961f9e041b771b1ccc529995de5d086ee637639`。 |

首轮拖动失败保留为失败：事件记录在 pointerdown 与后续按住移动之间插入一个 `(601.714, 302.286)`、`buttons=0` 的 pointermove；这不属于测试主动发送的横向序列。react-resizable-panels 4.13.2 收到无按键移动会将拖动状态设为 inactive，解释了布局未改变。同一构建、未改源码或断言的重跑及后续 Forge 主阶段通过。额外事件来源未确认，不能宣称该偶发问题已修复，也不能归因为别名解析。

shadcn 的成功实验使用其支持的 REGISTRY_URL 指向本机转发服务，逐字节转发官方 `ui.shadcn.com/r/...` 响应并记录 SHA-256；只临时调整 CLI 子进程的 loopback 代理环境，没有改写响应、全局代理或 TLS 校验。CLI 直接访问 registry 的等待问题仍未解决。tooltip 终端帮助中的 `@/components/ui/tooltip` 没有跟随配置改写，生成文件则正确；详见 [路径方案与实验](import-alias-plan.md)。

preload 当前没有本地别名导入，其构建与真实桥接通过不等于额外验证了该导入场景。CSS 内也没有使用 `@/`。本轮未重跑 20 分钟长测、独立 Edge 示例或真实账号流程；Windows 物理鼠标跨原生视图的命中路由仍未验收。构建存在既有上游指令、source map、chunk 大小及 Forge 旧选项提示，未借本次路径迁移调整依赖或优化包体。

## 前端重构与窗口 IPC 修复（2026-09-23）

先完成 [frontend-refactor.md](frontend-refactor.md)，再实施紧凑左右布局、默认亮色/可切暗色、可拖动主分界与保存点/元素/执行/证据分界。项目/profile 创建、存档恢复与完整证据阅读使用 Dialog；移除首字装饰图标和多层卡片。主题与布局保存在独立 `userData/ui-preferences.json`，不写入 run 证据。录制、控制权、部分采集、回放、验收、人工评审和恢复继续使用既有业务接口。

实际执行环境为 **Node 24.21.0 / npm 11.19.0 / Electron 44.4.3**，不限 Node 版本管理工具。shadcn CLI 4.21.0 `add` 未完成且原因未确认，停止后改从官方 `new-york-v4` registry 手动引入 13 个组件源码，并保留 MIT 许可与来源说明。没有把 CLI 尝试计为安装成功。实际新增组合为 Tailwind / Vite 插件 **4.3.3**、Radix UI **1.6.7**、react-resizable-panels **4.13.2**、Lucide **1.47.0**、class-variance-authority **0.7.1**、clsx **2.1.1**、tailwind-merge **3.7.0**、tw-animate-css **1.4.0**；原 Electron/React/Vite 版本未升级。本次锁文件实际字节 SHA-256 为 `aaeca20cd2ca57f8d6bbac8c9e67a03c35bbfacc8d49b5acfe6d39de445b2c9c`。

| 命令 / 场景 | 实际结果与材料 |
| --- | --- |
| `npm.cmd run typecheck` | 通过，日志 `output/frontend-typecheck-final.log` |
| `npm.cmd test` | **102/102 通过，0 失败、0 跳过**；日志 `output/frontend-unit-final.log`。新增可信 IPC 销毁/身份边界、偏好校验/写失败恢复及 UI 专用接口隔离检查 |
| `npm.cmd run test:integration` | Vite 构建及 **19 个 Electron 进程**矩阵通过，`output/desktop-1790104067949/desktop-summary.json` 为 passed=true；主阶段 PID **6540**、profile 重启 PID **31992** |
| `npm.cmd run start`，独立 `BES_DATA` / `BES_TEST=1` | Forge 开发模式完整主阶段通过，PID **42952**，报告 `output/frontend-forge-verified-1790103892599/test-result.json`；包括此前失败的首次截图/普通点击、被拒 UI 导航、布局、业务与恢复场景。随后尺寸观察器重绑修复另由最终生产矩阵覆盖 |
| `npm.cmd run start`，另设 `BES_TEST_PHASE=exit-app-quit` | 最终源码的开发启动、首次完整 checkpoint 和连续退出专项通过；`output/frontend-forge-exit-final-1790104259777`，PID **37036**，`exit-reentry-verified` 确认两份材料与一次清理，`shutdown-complete` / exitCode 0 |
| `npm.cmd run build` | 开发模式专项结束后重新生成生产产物成功，日志 `output/frontend-build-final.log`；无后续源代码修改 |

19 进程保留原主阶段/profile 重启、五种强杀边界各三进程、连续关窗与 app.quit 两项。布局场景增加默认亮色、亮暗切换与偏好重载、真实 Electron `sendInputEvent` 的指针/键盘调整、已确认发生的原生失焦、1100 × 760/最大化、恢复默认布局后内容自身改变尺寸，以及被拒导航保留原文档。原生视图与蒙版对 DOM 边界误差不超过 2 CSS px；布局/主题不改变页面身份、controller 或 lease。弹层/拖动遮挡分开合成，采集中仍能取消；普通 Puppeteer 点击在设置弹层打开时继续执行，关闭弹层不会解除 agent/checkpoint 输入锁。新项目/profile 由真实 React 表单创建，新项目不再显示旧项目的保存点或启用旧证据入口。

本轮定位与修复：

- 用户报告的 `Object has been destroyed` 来自 `studio:bounds` 对已失效 window/frame 的访问。可信 IPC 检查先核对存活，再读取精确 sender/mainFrame/URL，并捕获销毁访问异常；退出期间忽略迟到 bounds。最终矩阵包括窗口重载、业务 renderer 崩溃、页面销毁及连续退出，未再出现该主进程异常。
- 开发尝试曾出现首次截图 `UnknownVizError`（DOM 已保存）及普通点击超时，不能因 Forge 外层返回 0 而算通过。`output/frontend-forge-navigation-1790103744543/exit-capture-diagnostics.json` 记录 `did-start-navigation → will-navigate → did-stop-loading`、无提交，旧 UI 仍在，但提前清空的就绪状态令浏览器持续隐藏。现仅在 `did-navigate` 实际提交后重置，拒绝导航保留旧布局；完整开发主阶段及最终退出专项均通过。诊断中重试截图成功不抵消首轮失败，临时重试代码已删除。
- 恢复布局会重建 DOM 占位，现同时重绑 ResizeObserver；布局恢复后工具栏内容改变高度的回归通过。清除重复原生 bounds/visibility 设置，避免逐帧不必要的原生更新；拖动失焦后不会通过迟到消息抢回焦点。

最终截图目录为 `output/desktop-1790104067949`，已视检亮/暗录制、最小窗口、空项目、材料阅读与恢复界面。`ui-light.png`、`ui-dark.png`、`ui-minimum-dark.png`、`ui-evidence.png` 是限定当前测试窗口的真实媒体帧，包含原生视图；该方式后续取帧超时时，保存明确标注的 `*.renderer.png` 与可用的 `*.browser.png`，`*.capture.json` 记录 `separate-surfaces` / `compositeAvailable:false`，不将分层图片拼接冒充整窗截图。空项目、暗色材料和亮/暗恢复截图可按这些文件名查看。

**范围限制：** `sendInputEvent` 直接投递到 Electron renderer，不等同于 Windows 物理鼠标从分隔条跨入原生视图的命中路由，后者仍待人工体验检查。未重跑 20 分钟长测、独立 Edge 五变体、重新打包/生成 ZIP 或真实账号流程。构建仍有上游 `use client`、source map、chunk >500 kB 与 Forge `inlineDynamicImports` 提示，未据此声明体积优化完成。历史 ESM 专项和历史包的验证结果不替代本节的新界面验收。

## ESM 模块迁移（2026-09-23）

根包改为 `"type": "module"`，Forge 与 Vite 配置迁至 `.ts` 并纳入类型检查；main、runner worker 和 renderer 输出 ESM。Electron sandboxed preload 仍从 TS ESM 源码打包为单文件 `preload.cjs`。运行时资源/worker 位置使用 `import.meta.dirname`，登记脚本使用原生动态 `import()`；桌面启动器和故障测试子进程也改用 ESM。未降低 sandbox/contextIsolation。

迁移实际运行环境仍为 **Node 24.21.0 / npm 11.19.0 / Electron 44.4.3**。本次模块变更本身没有调整依赖版本。开发启动记录是在同时应用动态端口修复的工作树上取得，模块格式迁移与端口修复为独立变更。

- `npm.cmd run typecheck` 通过，含四个根配置；`npm.cmd test` **94/94 通过，0 失败、0 跳过**。
- `npm.cmd run test:integration` 的 Vite 构建及 **19 个 Electron 进程**完整矩阵通过，报告 `output/desktop-1790101014732/desktop-summary.json`。主场景 PID **37720**、profile 重启 PID **28576**，均退出 0；五种强杀边界的两次重开/新 run 复跑和两个退出清理场景均通过。
- 该次构建的 SHA-256：`index.js` 为 `ea7778b2016d5ecefe4c441bfb1fc7662674b08fcb88c78ec220b7aba06a4a11`，`runner-worker.js` 为 `1af5acfb48e309d35ef063dfa584f17bb1a8392f1fc4df8a6ed8ca2bf88a0dc4`，`preload.cjs` 为 `313be288f1dae26ecd0bef48c0bae9e1e8c2e1069099b98c29cc478598ba3418`。

随后完成模块专项开发/打包验证：

- 设置独立 `BES_DATA=output/forge-esm-1790101319212`、`BES_TEST=1`、`BES_TEST_PHASE=exit-app-quit`，清除 `ELECTRON_RUN_AS_NODE` 后执行 `npm.cmd run start`。Forge 加载 TS 配置并完成开发构建；Electron PID **30308** 保存 `ui-ready`、`exit-reentry-verified`（两份 checkpoint 材料）和 `shutdown-complete` / exitCode 0。这是开发启动与退出场景通过，不标为完整主阶段测试报告。
- 核验本机 Electron ZIP 的 SHA-256 仍与安装包官方清单一致（`790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`），将 `ELECTRON_ZIP_DIR` 指向 `output/electron-cache/97c4824d52fa18e59ceb86513ea4d84a0cb0a407b42cff72f0fdb998616bb008`，执行 `npm.cmd run package` 成功。
- `node test/desktop/launch.js '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe' --recovery-only` **17 进程专项矩阵通过**，报告 `output/desktop-1790101407643/desktop-summary.json`。覆盖五种强杀位置的重开、新 ESM worker 实跑、重复重开，以及两种完整退出清理；此命令明确没有运行 packaged main/profile-restart 阶段。
- ASAR 内核对 `package.json` 的 `type=module`、主入口、ESM main/worker 和 `preload.cjs`；摘要保存于 `output/forge-esm-1790101319212/package-modules.json`。该次 `app.asar` SHA-256 为 `c5f969366ec052661a8cd3fef59fc94352afcb2efbe346a8f6cebc0f63d82d0a`。未生成新分发 ZIP。

验证期间同目录另一项前端重构开始加入依赖、界面和测试改动。94 项及 19 进程结果对应前一实际 ESM 构建；随后共享树类型检查曾因尚未生成的 UI 组件及未就绪依赖失败，不能把当前前端中间状态算作全量通过。开发/打包专项只验收当次产物的模块加载与恢复，未验收新界面；后续前端任务负责最终源码/依赖/产物一致性及全量复验。未复跑长测与真实业务。Forge 上游 `inlineDynamicImports` 与 `codeSplitting:false` 同时存在时有忽略旧选项的提示，产物仍为单文件 preload；未修改 node_modules。

## 开发启动端口修复（2026-09-23）

用户执行 `npm run start` 在 Vite renderer 启动时报 `listen EACCES: permission denied 127.0.0.1:5173`。本机 `netsh interface ipv4 show excludedportrange protocol=tcp` 输出包含 **5141–5240**；Node `net.createServer().listen(5173, '127.0.0.1')` 实测同样返回 EACCES，改用端口 0 成功取得系统分配端口。未确认是哪项系统服务创建了排除范围。

当时的 `vite.renderer.config.mjs`（ESM 迁移后为 `vite.renderer.config.ts`）保留 loopback 监听，并设置 `server.port: 0`。本地锁定版本的 Vite 保留 0，Forge 在监听成功后使用实际端口生成 renderer URL；无需修改系统排除范围或防火墙，该次修复未改变依赖及锁文件。

- 实际 Node/npm 为 **24.21.0 / 11.19.0**；`npm.cmd run typecheck` 与 `git diff --check` 通过。
- `BES_DATA` 设置为独立合成目录 `output/forge-start-1790099842887`、`BES_TEST=1`，清除 `ELECTRON_RUN_AS_NODE` 后执行 **`npm.cmd run start`**。Forge 完成 main/preload 构建，真实 Electron PID **32420** 完成主阶段场景，`test-result.json` 为 `passed: true`；进程退出 0，`diagnostics/latest.json` 为 `shutdown-complete` / `test-completed`。
- Forge 注入的实际地址为 `http://localhost:11529`；HTML 和 `/@vite/client` 均返回 200，使用该客户端令牌连接同端口 WebSocket 收到 HMR `connected`。结果保存于同目录 `dev-server-check.json`，日志为 `forge-start.log`；没有将令牌写入报告。
- 主阶段包括真实 React/IPC、回放、受控 runner、人工交接、HTTP、checkpoint、请求正文与恢复界面。此次只验证开发启动主阶段，未运行第二进程 profile 重启、19 进程强杀矩阵、长测或重新打包。

此前沙箱尝试 `output/forge-start-1790099803196` 已越过端口错误并完成构建，但 Electron GPU 子进程以 `-1073741515` 崩溃，缺少完成报告；即使 Forge 外层返回 0，也不计为通过。随后在正常桌面执行环境完成上述成功复验，未修改 GPU 或 Chromium 安全配置。

## 退出诊断与最终强杀重开矩阵（2026-09-23）

在 `7a6ef3f` / `9946a4b` 上完成退出诊断、连续退出保护、验收目录保存与控制交还的时序修复，以及统一桌面强杀回归。最终 `npm.cmd run typecheck`、`npm.cmd test` **94/94**、`npm.cmd run test:integration` 均通过；后者包含 Vite 构建和 **19 个真实 Electron 进程**，报告 `output/desktop-1790095701394/desktop-summary.json`。`git diff --check` 通过。Node 24.21.0 / npm 11.19.0、Electron 44.4.3 及锁文件 SHA-256 未变。

主场景 PID **36472**、profile 重启 PID **40276** 均退出 0，覆盖原有 UI、HTTP、控制权、五个脚本变体、checkpoint 取消/失败、请求正文及新的恢复界面。每个恢复案例使用独立合成数据根：收到耐久边界标记后由父启动器 SIGKILL 自己的子进程，再启动两个新 Electron 进程；下表各项均通过。

| 强杀边界 | 强杀 / 首次重开 / 再次重开 PID | 核验结果 |
| --- | --- | --- |
| worker 创建前已登记 | 41816 / 17044 / 42432 | 恢复为 interrupted，无结果；checkpoint 原 ID/hash 保留 |
| worker 已运行 | 32688 / 4840 / 30596 | 不恢复旧 worker 或控制权；恢复为 interrupted |
| 等待人工 | 35484 / 14608 / 42432 | 不把未回复当成功，不恢复人工等待；恢复为 interrupted |
| 报告保存后、终态前 | 41020 / 39064 / 34256 | 孤立报告仍按原 hash/字节可读，但不成为执行结果或 pass |
| 终态后、目录保存前 | 27724 / 17480 / 42416 | 故意破坏目录后仍由终态与报告重建 completed/pass |

五种案例均成功创建新 run 复跑，再次重开时验收记录不重复、原 run 原件字节不变、成功复跑结果仍可验证。新 run 的目录写入 barrier 验证：保存期间对外保持 finalizing/locked，无提前暴露的 result/artifact，重复验收返回 409；释放写入后结果与人工控制同时可用。

连续关窗 PID **38712**、连续 app.quit PID **39460** 均在已有 run 和已保存 checkpoint 下执行。测试阻塞 Studio 关闭，再次请求退出，确认窗口仍在、同一次清理只执行一次；释放后核验两份材料的 hash/字节、writer lock 消失及 active 清空。诊断记录 `exit-reentry-verified` 和对应 `shutdown-complete`，实际退出 0。由于没有完整普通测试报告，这两个进程的普通 `passed` 仍为 false；父启动器按专门的退出诊断断言判定场景通过，五个被强杀进程也不冒充普通测试通过。

生命周期诊断保存在各数据根的 `diagnostics/lifecycle-<实例 ID>.jsonl` 与 `latest.json`，记录 PID、启动时间、renderer/child 退出原因和清理阶段。强杀没有结束记录时只保留最后已确认阶段，不推断具体外部退出原因。首轮恢复界面截图已视检，最终同类截图位于上述报告目录。

本批未重跑 20 分钟长测、独立 Edge 示例或发行 ZIP；此前长测在 18.19 分钟后退出的具体原因仍未知。退出诊断和短合成恢复通过不能外推为长负载、30 分钟全负载、性能阈值或真实账号业务通过。

## 验收记录持久化与恢复界面（2026-09-23）

writer 修复已提交为 `7a6ef3f`。随后实现 worker 前登记、报告/终态提交与启动重建，增加可信 UI 存档检查、安全重开和中断验收查看。`npm.cmd run typecheck` 与 `npm.cmd test` **94/94 通过，0 失败、0 跳过**；其中验收恢复 12 项、存档恢复 4 项、Windows 原子替换故障注入 3 项。

恢复单测覆盖孤立报告、目录丢失/损坏、报告 hash/身份/输入/版本不一致、checkpoint 材料不完整及正文缺失/修改、旧报告核验、目录写入失败、坏字段容错和启动期间取消。只有完整终态及对应材料通过检查才恢复原结论，目录中的 pass 不具备独立效力。

真实 React/IPC 场景已通过：损坏锁保持原字节且无强制按钮；已退出 writer 可安全恢复；中断记录无 `result` 时仍显示原因与 checkpoint，并可准备新 run。截图 `output/desktop-1790095126782/ui-recovery-refused.png` 与 `ui-recovery-interrupted.png` 已视检，文本与操作入口可读。该目录的 `desktop-summary.json` 是首轮完整 19 进程通过报告；最终补强复验见上方记录。

首轮桌面尝试 `output/desktop-1790094903971/desktop-summary.json` 因替换 `manifest.json` 返回 `EPERM` 而失败，随后正常清理写入同一文件成功；没有证据确认具体占用来源。`atomicFile` 现仅对 Windows 的 EPERM/EACCES/EBUSY 有界重试：最多 7 次、总等待 1175 ms，重复 rename 同一已 sync 临时文件，不删除旧目标。永久失败保留旧目标并抛错；故障注入及后续桌面运行通过。

补强复验 `output/desktop-1790095351901/desktop-summary.json` 在新 run 结束时发现完成状态早于人工控制交还，判为失败。原因是目录写入前已发布终态；现保存 terminal 候选快照，对外保持 finalizing，最终同步交还控制并发布结果。新增目录写入 barrier 稳定检查此窗口，包含保存期间拒绝下一次验收；最终运行结果见本页最新记录。

## writer 所有权与异常恢复（2026-09-23）

在 `10f8f5d` 之后补齐 writer 锁。`npm.cmd run typecheck` 通过；`node --import tsx --test test/unit/writer-lock.test.ts test/unit/evidence.test.ts` **21/21 通过，0 失败、0 跳过**。运行组合仍为 Node 24.21.0 / npm 11.19.0，Node 内置 libuv 1.52.1；未修改依赖和锁文件。

- 真实进程并发回收同一已强杀 writer，仅一个能持有 guard；旧锁原样保存在 `recovery/`，另一进程被拒绝。目录别名共用同一内核 guard。Windows 系统启动 FILETIME 区分同 PID 的不同进程；无法查询、存活的旧格式近似身份或损坏锁均不授权回收。PID 重用分类用可控 OS 查询结果测试，未声称实际促使 Windows 重用了某个 PID。
- `writer.lock` 以完整、已 sync 的临时文件经不覆盖的硬链接发布。真实子进程分别在发布前/后被强杀，重开只看到无标记或完整标记；发布时外来标记冲突保留外来内容。迟到 release 只认自己的 owner token，不能删除新 writer 的锁。
- 已确认保存的 checkpoint 经强杀后仍可按原 ID/hash 读取。普通中断和已报告损坏尾部重复重开不重复追加恢复 gap，不改变原件字节；坏尾后不再追加新记录。原件尾部有新损坏时仍重新保留并报告。

Windows 进程身份通过系统自带 Windows PowerShell 的 `Process.StartTime` 查询，与 Node 的安装/版本管理工具无关。权限不足或系统组件不可用时明确拒绝写入或恢复，不推断死亡；本批没有验证其他桌面平台。

## 审查后的首批实现与复验（2026-09-22）

文档审查已提交为 `14f64fb`，随后按用户要求继续实现。本轮终端直接核对 `node --version` / `npm.cmd --version` 为 **24.21.0 / 11.19.0**；项目继续仅限制这两个运行时版本，不限制安装或版本管理工具。锁文件 SHA-256 仍为 `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e`。

- `npm.cmd ci --no-audit --no-fund --cache output/npm-cache` 安装 521 包。Electron 官方下载尝试超时后，使用 `@electron/get` 从镜像获取 44.4.3，按已安装包中的 `checksums.json` 核验，再解压至本地依赖目录；没有改依赖版本或锁文件。
- 修改前基线：`npm.cmd run typecheck`、`npm.cmd test`（42/42）和 `npm.cmd run build` 均通过。
- 最终源码：`npm.cmd run typecheck` 通过，`npm.cmd test` **65/65 通过，0 失败、0 跳过**；`npm.cmd run test:integration` 的 Vite 构建和两个真实 Electron 进程均通过，报告 `output/desktop-1790092245546/desktop-summary.json`，PID **19088 / 1056**，均退出 0。覆盖原有五个脚本变体、UI/IPC、控制权、HTTP、页面生命周期及跨进程 profile，并增加下述场景。`git diff --check` 通过。
- `ui.png`、`ui-evidence.png`、新增 `ui-reviews.png` 保存在同一目录；已视检 checkpoint 状态及重开的完整人工判定。首轮实现报告为 `output/desktop-1790091857958/desktop-summary.json`（PID 3464 / 38680），最终报告还包括独立审查后补充的页面关闭恢复与不完整 checkpoint 验收拒绝。

| 本轮补齐项 | 验证范围与限制 |
| --- | --- |
| 请求正文 | 独立 artifact 与 requestKey/source 关联；真实 UTF-8 JSON/null、1 MiB 完整、9 MiB 经 `getRequestPostData` 补采并在 8 MiB 截断，分页读取遵守预算；凭据关键词命中、二进制、multipart 被明确排除，无正文为 not-applicable；扫描合成 CDP/事件原件确认不内嵌正文或凭据哨兵。补采超时、晚到值、redirect/ID 重用/暂停/淘汰等另有单测。 |
| checkpoint 限时与取消 | 真实服务中分别挂起 DOM 或原生截图，通过 React 按钮取消或 10 秒采集期限后保存已有材料与缺失原因、释放安全输入锁；晚到 DOM 不改原 checkpoint，新采集正常。人工/agent 页面关闭后等待旧采集和 disconnect 才恢复替代页面，延迟 disconnect 不提前解锁。HTTP 队列中的取消绑定自身 job，不影响前一任务；保存期间的取消等待实际落盘成功或失败。真实 worker 挂起时可取消，报告队列收敛且不恢复已撤销闸门；另以 partial/failed/timed-out 三种实际采集故障确认材料保留、覆盖不计入、验收 fail。 |
| 人工评审 | 保持追加式文件，单测验证新 Node 进程读取、固定分页边界、UTF-8 整体响应预算、坏尾部错误及完整理由/范围。真实 React/IPC 验证保存后可见、下一页、关闭重开，并确认人工例外不改变机器失败。 |
| 示范隔离 | 真实 UI 中为两个项目创建同 key 示范，候选和实际对照只包含验收所属项目。基线选择仍未持久关联到验收记录。 |

所有新材料均在被 Git 忽略的合成 `output/` 下。本轮未复跑 20 分钟长测、独立 Edge 示例或重新生成发行 ZIP；这些不继承为新源码通过记录。10 秒仅限制采集阶段，不保证磁盘写入期限；操作静默失败时保持关闭，需要显式停止。请求正文排除规则不等同于完整个人信息识别或上传文件捕获。

## 后续工作区审查（2026-09-22，非测试复跑）

在 `main` / `1c3c3b1` 上读取设计、实施计划、源码与测试代码；审查开始时工作树干净，实现仍为 `f8e6eb8`。`Get-FileHash package-lock.json -Algorithm SHA256` 输出 `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e`，与下方历史记录一致。

审查时开发机通过 Node 版本管理工具维护多个运行时。直接调用已安装目标版本的 Node 和 npm CLI 核对，输出 **24.21.0 / 11.19.0**；当时终端默认 `node --version` / `npm --version` 为 **14.21.3 / 6.14.18**。审查未改变默认运行时。项目仅约束 Node/npm 版本，开发者可自行选择安装方式或版本管理工具；本文统一记录实际版本与通用命令，不绑定工具名称、专用环境变量或安装路径。

`Test-Path` 检查确认此检出没有 `node_modules/`、`.vite/`、`output/`、`out/` 或历史 ZIP。因而本轮没有重跑 typecheck、42 项测试、Electron、打包或长测，也未重新核验历史产物；这不否定历史记录，但不能将其作为本次环境的通过结果。版本管理工具的版本列表查询未及时返回，可用版本通过安装目录和直接执行核对。

当时静态检查列出长历史续读/回放定位、checkpoint 限时取消、请求正文状态、采集/索引进程分工、人工评审回读、示范基线身份和异常恢复等未完成项。其中本轮已收尾的项目以上方新记录为准；剩余边界见 [progress.md 的本次核查](progress.md#本次代码与工作区核查)。下方“已执行命令”和“合成验收覆盖”保留历史口径。

## 环境与构建

| 项目 | 实际组合 |
| --- | --- |
| 开发 Node / npm | 24.21.0 LTS / 11.19.0，执行命令时显式选择目标运行时 |
| Electron 内置 Node / Chromium | Electron 44.4.3 / Node 24.21.0 / Chromium 152.0.7977.130 |
| 执行与录制 | puppeteer-core 25.11.0 / rrweb 2.1.6 |
| 构建与界面 | Forge 7.11.2、Vite 8.3.0、TypeScript 7.0.2、React 19.3.0 |
| 独立示例浏览器 | 本机 Edge 153.0.4234.48，新临时 profile；不读取已有账号环境 |
| package-lock SHA-256（D: 实际文件） | `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e` |

D: Git 检出使用 CRLF，锁文件标准化为 LF 后的 SHA-256 仍为迁移前的 `c47ffd6ab57b3fc1b93629b28a01f52da48fd3041389c95e227534dcffb185e9`；依赖内容未变。

`npm ls webpack @electron-forge/plugin-webpack vite --depth=1` 仅列出 Vite。main/worker 与 preload 输出 CommonJS，renderer 输出浏览器 ESM，类型检查独立于 Vite 转译。

Electron ZIP 158,247,567 字节，SHA-256 为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，与安装包内官方校验清单一致。镜像和随后完成的官方下载均核验了同一摘要。

## 已执行命令

以下命令在仓库根目录、Node 24.21.0 / npm 11.19.0 环境中执行。表中统一列出通用命令，省略版本管理工具的专用启动前缀；复现时用自行选择的方式准备相同版本，并先核对 `node --version` 与 `npm --version`。

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd test` | `f8e6eb8` 在迁移前后均为 42 项通过，0 失败、0 跳过，含合成站点、真实 worker 和新增并发分页预算回归 |
| `npm.cmd run build` | Vite main/preload/renderer 构建通过 |
| `node test/desktop/launch.cjs` | 两个真实 Electron 进程的桌面和 profile 重启场景通过 |
| `npm.cmd start`，设置独立 `BES_DATA` 与 `BES_TEST=1` | Forge/Vite 开发模式主阶段全部通过，客户端正常退出 |
| `npm.cmd run test:example`，显式设置 `BROWSER_EXECUTABLE_PATH` | 5 个独立浏览器变体实际执行，1 个组合测试通过，0 跳过 |
| `npm.cmd run test:soak` | 未通过：第二次最后保存到 18.19 分钟后进程提前退出，缺少完成报告；详见下文 |
| `npm.cmd run make`，使用已校验的 `ELECTRON_ZIP_DIR` | D: 主目录重新生成 `f8e6eb8` 的 Windows 应用目录与 ZIP，包含最后的 reader 预算修复 |
| `node test/desktop/launch.cjs '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe'` | D: 新包的两个真实进程完整通过；输出 `output/desktop-1790079600870` |

普通 Vite 构建提示 rrweb/React renderer chunk 大于 500 kB；Forge/Vite 组合提示上游 `inlineDynamicImports` 配置弃用。两者未导致上述构建失败，不代表已经完成体积优化。

首次完整桌面通过证据：`output/desktop-1790077424921/desktop-summary.json`，主进程 PID 40644，重启进程 PID 14700，二者退出码 0。Forge 开发模式证据：`output/forge-start-1790077723581/test-result.json`。截图保存为各目录下的 `ui.png` 与 `ui-evidence.png`。这些运行目录被 Git 忽略，复跑会生成新目录。上述迁移前证据位于旧根目录 `C:/Users/Administrator/.codex/worktrees/c22c/browser-evidence-studio/`，Git 合并不会搬运这些本地材料。

最近迁移前源码桌面结果：`output/desktop-1790078296913/desktop-summary.json`，PID 50604/50452；打包 EXE 结果：`output/desktop-1790078710305/desktop-summary.json`，PID 49080/44476。两者都包含空闲时直接验收、封存后重跑及 popup 自关闭；打包场景还验证实际 rrweb 播放/暂停和 iframe 桥接隔离。迁移前 ZIP 为 168,163,792 字节，SHA-256 `3a93de36bf1f5a2949ea7bee2abbd4904c37d892a8c438d7e0a64900a7959180`。此包不包含最后的 reader 并发预算修复，不应标为当前源码重新生成的发行包。

独立示例最近一次结果位置：`C:/Users/ADMINI~1/AppData/Local/Temp/bes-independent-Otoa9s`，包含每个变体的报告、截图和来源附件。

## 主目录迁移后的复验

2026-09-22，`f8e6eb8` 已快进合并至 `D:/workspace/browser-evidence-studio` 的 `main`，后续开发使用该目录。以下路径相对此主目录。

- 独立依赖安装：Node 24.21.0 / npm 11.19.0，`npm ci --offline --ignore-scripts --no-audit --no-fund` 从缓存安装 521 包；Electron 从已核对包内官方校验值的 ZIP 解压到本目录，并执行本地 esbuild 安装检查。未共享旧 `node_modules` 链接，未复制 profile/录制。
- `npm run typecheck`、`npm test`（42/42）、`npm run build` 与 `npm ls --depth=0` 均通过，锁文件未改变依赖内容。
- 最新源码两进程报告：`output/desktop-1790079502939/desktop-summary.json`，PID 9964/37584，两个退出码均为 0。
- 最新打包 EXE 两进程报告：`output/desktop-1790079600870/desktop-summary.json`，PID 32472/45096，两个退出码均为 0。包含 UI/回放、五个脚本变体、空闲验收、人工交接、取消、popup 自关闭、正文边界、HTTP 和 profile 重启。
- 当前 EXE：`out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe`；ZIP：`out/make/zip/win32/x64/Browser Evidence Studio-win32-x64-0.1.0.zip`，167,341,123 字节，SHA-256 `ccde7da6f66467e4dd44820c69178be079f24a685f43830246b24b94542fb3fa`。包含 reader 修复，未签名。

## 合成验收覆盖

| 需求 | 实际证据与边界 |
| --- | --- |
| R01 桌面与目标身份 | WebContentsView、普通 Puppeteer 点击和导航、独立捕获连接、弹窗/opener、切页后操作目标、刷新与 DevTools 打开关闭均通过。按 CDP targetId 匹配，未按 URL 猜测。 |
| R02 存储与恢复 | OS writer 身份、内核独占、并发回收、原子标记发布两侧强杀、owner token、损坏尾部保留、hash 校验、重复重开与稳定 ID 单测通过。真实 Electron 强杀后确认过的 checkpoint 仍可读；renderer 强制崩溃记录 gap 后仍可封存。unknown/corrupt 不强制回收。 |
| R03 连续证据 | CDP 请求/响应、两跳重定向、1 MiB 完整 JSON、9 MiB 在 8 MiB 明确截断、rrweb 顶层与 iframe 场景通过。跨域 iframe/Canvas/媒体及 WebSocket/SSE 完整正文不作保证。 |
| R04 checkpoint 与检查 | 原生视图蒙版、截图/DOM 落盘、有界回读、实际 UI 显示保存截图通过。检查点击只选元素，不执行站点按钮；采集期间页面定时器继续。 |
| R05 控制与人工交接 | 并发 Promise/定时器命令在闸门关闭后拒绝；连接建立中停止不能晚到点击；两处人工窗口经真实原生输入和状态检查后恢复；未满足检查、超时和取消不通过。 |
| R06 登录环境 | 同一 profile 新 run 及新 Electron 进程中的合成 Cookie/localStorage/IndexedDB 均保留，另一个 profile 保持为空。保存仍标记登录状态 unknown，不承诺 sessionStorage、内存态或跨机器迁移。 |
| R07 HTTP | loopback、token ACL、Host/Origin、幂等 job、取消确认、身份与预算相关单测通过；真实 HTTP 场景完成 8 个 job、6 个控制权/身份拒绝，幂等点击只发生一次，键盘 fill 实际值正确，截图和 HTML 下载响应安全头通过。 |
| R08 普通脚本 | 同一 `examples/orders/run.mjs` 在受管 worker 和独立 Edge 中运行；普通分页、去重和详情分支，无运行时 LLM 或 Electron 必需依赖。 |
| R09 验收 | normal/duplicate 输出 7 条订单及关联详情并通过；wrong-image、missing、empty-middle 确实判失败。新增启动登记与终态证据重建；报告 hash/身份/输入/版本及 checkpoint 材料校验，未提交完整终态不恢复 pass。保留来源、实体 ID、覆盖和字段验收。 |
| R10 项目技能 | 入口技能与按需引用的 HTTP/探索/验收说明已建立，skill-creator 的 quick_validate 已通过；未全局安装。独立接续检查只完成 capabilities/health/state 读取；进一步读取被自动审批拒绝，因此来源级接续未通过，未执行修改/复跑。 |
| R11 长流程 | 两次 20 分钟尝试均未完成，最后一次仅有 18.19 分钟的阶段快照；无完整长测、最终封存/重建或该次重启通过结论。reader 的字节预算单测通过，但不能替代长负载验收。 |
| R12 分发与真实验收 | 历史 `f8e6eb8` 的 Windows ZIP、打包 EXE 两进程桌面与 profile 重启通过。最新别名批文档记录了 package 与新包主阶段通过，但本次核查的本地包仍较旧，最新报告不在当前目录；未生成新分发 ZIP、未签名。真实拼多多演示、扫码及业务需求验收未执行。 |

## 本轮发现并修复的问题

- 原生输入蒙版与 Windows 窗口遮挡会影响 Chromium 的 IntersectionObserver，普通 Puppeteer 点击可能等待超时。业务视图关闭后台节流，蒙版保持透明合成，并添加 `disable-backgrounding-occluded-windows`；五个普通脚本变体及人工交接已复跑通过。此设置保持绘制，不关闭浏览器安全隔离。
- Electron `window.open()` 的 createWindow 回调已给出 guest WebContents。旧代码重建另一份会抛 `Invalid webContents` 主进程异常；改为 `new WebContentsView(options)` 接管原对象，安全偏好在 overrideBrowserWindowOptions 中设定。真实 popup/opener/切页和退出已通过。
- Puppeteer 25 在 Chromium 152 下需要发现结构性 tab target 才能找到其 page。适配器允许结构 tab，最终 Page 仍绑定并通过 CDP 复核明确登记的 targetId。
- 对每个 iframe 注入独立 rrweb 会递归记录 rrweb 自己的辅助 iframe。现在只在顶层注入，暂停恢复只调用已就绪的主文档 recorder；跨 iframe 能力明确为部分支持。
- Forge 的 preload 构建使用入口名 `ui.js`，与普通 Vite 构建原来的 `preload.js` 不同。输出文件名现已统一；开发启动和生产构建使用同一路径。
- 操作连接建立/停止、人工完成检查/取消、封存/晚到 popup 的竞态已加失效检查和清理。不能在等待结束后恢复已经撤销的控制权。
- 证据列表在索引并发追加时，原先会在装满页面后补入 cursor，触发 `BUDGET_TOO_SMALL`。现按读取开始时索引边界查询，并按完整 cursor/元数据的实际序列化大小预留预算；追加竞态和长元数据分页回归通过，指定纯合成目录 56 项历史查询均在预算内。
- 保存的 HTML 等原件不内联执行。截图协议限定完整 PNG、大小预算与安全响应头，IPC 仅信任准确 UI 文档 URL；HTTP 二进制附件使用下载响应及禁脚本 CSP。

## 网络与防火墙排查

只观察到已有的 Public 配置 Node 入站阻止规则，未修改防火墙。本机 HTTP、CDP 和夹具互通已实测；`Get-NetTCPConnection` 核对实际 CDP 监听为 `127.0.0.1`。本次 npm 出站失败与代理 TLS reset/执行沙箱限制有关，给 registry 设置进程级 NO_PROXY 后可安装；无法据此把失败归因于入站规则。

本工具不需要对局域网或公网监听。无需禁用防火墙或给 Node 广泛开放入站。图形测试在允许的进程执行环境中运行；没有关闭 Chromium sandbox、contextIsolation 或 webSecurity。

长录制第一次尝试 `output/desktop-1790077578498` 在约 11 分钟时被导航到非合成站点，夹具检查中断，该次不算通过。材料保留在本地且被 Git 忽略，未据此推断真实站点登录或业务成功。长测随后改为保持自动化控制、明确测试窗口标题，每轮先校验控制权及合成 origin；人工显式接管会停止测试，不继续操作真实页面。

第二次 `output/desktop-1790078604560`（旧 worktree）最后阶段快照为 1,091,475 ms（18.19 分钟）、18 个 checkpoint、cycles=102。主 Electron PID 13156 在完成报告生成前以退出码 0 退出；没有 `test-result.json` 或 `soak-result.json`，启动器最终返回 1，`desktop-summary.json` 为 passed=false，profileRestart 为 not-run。日志没有足够信息确认退出原因，不能推定由用户关窗、崩溃或防火墙导致。`soak-progress.json` 的 running 是陈旧快照，进程已经退出；该次不计通过，也不发布最终 P95/零丢失结论。后续在 D: 主目录排查并复验。

## 尚未验收的范围

真实账号与拼多多业务闭环需要用户完成演示和扫码，不能以合成测试代替。自动更新、代码签名、多机 profile 迁移、外部浏览器接管、完整跨域 iframe/Canvas/媒体回放不在本次通过声明中。

性能目标中的 100 ms 界面反馈、30 分钟全负载、HTTP P95 300 ms 等需各自实测；不能从一次短路径或命令成功外推。长期内存和数据损失结论以指定合成负载与保存边界为限。

## 京东参考插件提交前检查（2026-09-24）

环境为 Node 24.21.0 / npm 11.19.0。执行 `node --import tsx --test examples/jd-account-export/run.test.mjs`，结果 **4/6 通过、2 项失败**，退出码 1。当前实现从列表行派生订单摘要；旧测试的 `details` 故障依赖第二笔详情导航，而实现已不再访问详情页，因此没有触发预期失败；成功路径测试仍要求 `screenshotCheckpointId` 和 `telephone`，也与当前摘要字段不一致。此前逐笔详情版本的六项通过记录不适用于当前版本。提交保留该已知测试缺口，未改业务或放宽断言。

`node --check examples/jd-account-export/run.mjs` 与 `node --check examples/jd-account-export/standalone.mjs` 均通过，`git diff --check` 通过。测试只使用合成 Puppeteer 边界，没有启动浏览器或访问真实账号；没有重跑客户端整套回归或确认真实主流程通过。

提交前静态核对另发现：入口第 2、3 次登录交接使用 `jd-login-retry-2` / `jd-login-retry-3`，workflow 仅声明 `jd-login`；受管 runner 的声明检查会拒绝这两次重试。该确定的契约不匹配已记入示例 README，尚未修改或实跑验证。文件内容核对未发现真实录制正文、Cookie、凭据或真实账号个人信息；存档 UUID、证据 ID、统计及公开页面结构仅用作诊断引用。

## 一次性授权启动后的京东地址导航失败（2026-09-24）

受管 run `0435ff23-307f-4ec7-8c6f-c77a1abebf27` 经 UI 一次性授权成功启动，validation `f247f25a-9c5d-45a9-863b-9ff2978d6c8d` 返回 worker 失败。run 导航事件显示页面从个人信息页到达 `https://www.jd.com/`；脚本随后等待 `[id^="addresssDiv-"]` 20 秒超时，地址及后续数据集没有发出。此前 run `19c62128-4e78-491f-9819-43b89b5df45a` 也出现主页导航和空地址数据。该证据将本次失败定位在京东地址路由/页面解析阶段；授权获取、校验、消费和 validation 启动本身成功。

脚本现从个人信息页解析可见的“收货地址 / 地址管理”链接，并在识别到首页落点时立即报错，避免再空等 20 秒或把首页保存为地址 checkpoint。Node `v24.21.0` 的入口语法检查通过；没有使用已消费的一次性授权重跑，因此动态链接修正及真实地址字段解析仍未验收。复跑需要用户在可信界面重新点击一次性授权。
