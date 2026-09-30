# B3：纯 Node 后端与独立 Chromium

## 状态与范围

2026-09-30，用户在 B2 交付后明确要求继续 B3。起点为 `e0e44dbc349619b3b3d6ac3b3c66535affc83599`。本轮在 dot 云端 Linux 桌面实施；本文在实现和独立测试期间持续更新。

**当前仍在验证，不应据本文宣布 B3 完成。** 类型检查、模块测试、Node 入口可启动，均不能替代没有 Electron 依赖的完整用户链路。最终源码、构建及实际证据将在下文记录。

本次首个发布节点只包含 provider 身份、共享 `StudioCore` 和保持行为的 Electron adapter，相关类型／门禁测试随代码提交。下文 Node 控制台与 Chromium 纵向是尚未发布候选的实施和问题记录；Node 入口仍需解决输入控制取舍及崩溃恢复验收，不把工作区中的未提交实现误认为远端可用功能。

共享核心代码提交：`5fb39e7cb385678228220abebfa03aebfc1a3aea`。提交前从暂存区单独导出只含此切片的仓库快照（没有未提交的 Node 文件），其 TypeScript、4 文件／35 项定向测试和完整 Electron 构建均通过。该检查证明首切片可独立构建；实际 Electron 旅程证据见下文 gate2，测试源码中的共享核心字节与该提交一致。

## 实现边界

- 把原 `Studio` 的领域编排提取为 `StudioCore`，继续复用采集、证据、资料、固定执行和核验服务。Electron 子类保留原生容器、菜单、对话框与 profile 行为；Node 子类实现独立 Chromium 生命周期。没有复制一整套业务模型。
- `PageIdentity` 区分通用 page／target／navigation generation 与 provider 专属身份。Chromium 使用实际 browser instance，不伪造 `webContentsId`；Electron 继续保留真实 `webContentsId`。
- profile 缺省 provider 仍表示旧 Electron。读取不重写旧 `storageRef`／partition，Node 拒绝打开不属于 Chromium 的环境。新建 Chromium profile 使用独立目录；本轮不迁移 Cookie 或既有登录状态。
- Node 控制台只提供明确的项目／环境、录制、执行与配对操作。资料编辑、历史 DOM 回放与结果展示继续使用同一个浏览器工作台和 B2 模块。
- Chromium 为独立窗口，没有 Electron 的嵌入呈现。当前 provider 对下载与弹出窗口采用拒绝策略；完整功能对等不作为已实现事实。

## 本地控制台与授权

启动器在本地终端产生一次性、短时有效的 owner 票据。票据手动输入控制台后交换为仅驻留页面和服务端内存的会话，不放在 URL、Web Storage、发现文件或版本控制中。启动终端输出不得原样保存到测试日志或截图。

控制请求仍验证精确 Host、Origin、Fetch Metadata 和 instance，使用独立白名单及字段检查。旧项目工作台授权不能调用 owner 控制；共享工作台的资料／结果／回放能力须由 owner 明确签发。撤销、到期和退出要使关联权限失效，并取消／排空受其控制的启动或执行。

页面命令使用真实 project／profile／session／lease／page／target／generation。关闭会话和新建页面允许使用会话级身份，使最后一个页面关闭或崩溃后仍可恢复，不通过虚构 page ID 绕过检查。

控制台不自动重试写入。回执丢失时显示待核对状态；读连接失效时暂停普通写入。停止执行、撤销授权和退出有独立控制入口，在首次启动尚未返回、尚无页面时仍可操作。核验必须显式选择实际数据集尝试，不自动挑选“可能正确”的结果。

## 本轮发现与验证要求

以下是实施审查中发现的问题，保留问题与修复的区别；修复是否有效以最终实际测试为准。

1. Puppeteer observer 若关闭 NetworkManager，`setRequestInterception(true)` 并不实际安装预期网络拦截。改为有效的拦截路径，并验证导航允许／拒绝行为。
2. CDP 输入锁异步，不能把发出命令等同于锁定完成。采样和 runner 启动需要等待锁定屏障。必须验证原生鼠标／键盘被阻止，同时受控 Puppeteer 输入仍可工作；浏览器地址栏另有导航身份约束。
3. 运行时对象不能整体写入 page-registered 或关闭记录，避免 Page／View／Capture 对象循环引用。持久事件只保存明确的标量身份。
4. 首次环境启动与 owner 撤销／过期、进程退出可竞争。需要取消、启动完成屏障和逐项清理，不能先释放写锁，再留下迟到创建的浏览器或 HTTP 服务。
5. 页面消失后仍须能关闭会话。UI 与服务端现已采用页面命令／会话命令的显式身份边界。

## 验收记录

### 已完成的定向检查

- 冻结候选 `gate1`：类型检查、23 文件／202 项定向测试、完整 Electron 构建和独立 Node 构建全部退出 0。源码身份为上述 B2 HEAD 加本轮尚未提交的 B3 变更，保存构建前后 source manifest。此门禁于 2026-09-30 15:43 UTC 完成，尚未证明真实 GUI 链路。
- Node owner renderer 9 项模块测试通过：内存凭据、重复写入／丢回执、读取失败、迟到结果、明确选择数据集、启动中停止、无页面会话关闭、显式撤销和首次无会话时撤销入口。
- 以上是模块测试，不能当成真实 Chromium 录制、执行或原生输入锁的通过证据。
- `gate2` 再次通过类型检查、23 文件／202 项及 Electron／Node 构建。其实际 Electron `product-journey` 与重开均通过，测试实例 `desktop-1790785377834`、进程 102472／102862，各自退出 0 并完成 shutdown；581 文件 source/build manifest 在该次测试前后不变。此证据覆盖共享核心抽取后的指定 Electron 旅程，不把旧对话框缺陷或完整旧 profile 兼容矩阵改记为通过。

### 待实际验证

- 独立 Node 进程树与新 Chromium profile，导航前采集，真实示范／保存点／封存
- 原站关闭后的 B2 离线 DOM 回放、精确节点绑定、固定版本及刷新回读
- 同一固定版本的正确值、错误值和缺来源执行与核验，核对真实 dataset／attempt 身份
- 原生输入锁、受控输入、同文档路由、新页面、地址栏导航、停止／撤销、崩溃、写锁、关闭和重开
- 新构建 Electron 定向回归，旧对话框问题继续保留

真实失败、重试、最终构建范围和未测项将在测试结束后补齐；不把准备好的测试脚本计为测试已执行。

### 首次真实运行失败

`attempt1` 从正常 owner UI 新建项目和 Chromium 环境成功；首次开始录制返回 HTTP 500，未建立 session／active run／recording。独立实际 Chromium 探针进一步确认：初始化阶段关闭最后一个启动空白页会让 headed Chromium 退出，随后 observer 无法接入。保留初始失败现场；修复需调整真实浏览器生命周期，并从新构建重新验证，不能把探针成功当成完整产品通过。

测试脚本另外遇到后台标签的 disclosure 操作等待，后续脚本先将目标 owner 标签带到前台；此项归为测试操作修正，与上述真实 HTTP 500 分开。

同次排查还发现两个独立问题：

- 独立 Vite dev server 注册了自己的信号／stdin-end 退出处理，可能在 Node 完成排空前退出。改为 Vite middleware，由 Node HTTP server 统一拥有生命周期；无活动 profile 的实际退出复验已得到进程退出 0 和 `launch.status=closed`，有活动 profile 的关闭仍须另测。
- 控制台成功的周期性状态读取会清掉刚刚显示的操作错误。现将连接错误与操作错误分开；操作错误保留到用户确认或下一次明确操作，并显示不含凭据的诊断编号。模块回归增加成功刷新后仍保留错误的断言。

### 第二次实际运行与资源限制

`attempt2` 在修复后的新构建中完成纯 Node 项目／环境创建、导航前安装采集（包括最早的内联脚本请求）、真实 Chromium 页面 13 → 保存点 → 14 → 封存。原站关闭后，历史正文、CSS 颜色与直接 PNG 离线重建成功；测试停止在 CSS 背景资源必须变为 blob 的断言。

精确封存来源回读显示该背景被明确标记为 `unsupported · css-dependency-request-interval-unproven`。CSS 与 PNG 请求起始时间落在同一毫秒，已有严格依赖规则无法证明父子关系；原件 hash 未改变。这里保留为部分资源不可恢复，不把空白背景算作保真通过，也不放宽来源匹配去补出图像。后续主链测试应同时检查缺口诊断以及正文／颜色／直接图片和离线边界。

### 第三次实际主链

`attempt3` 于 2026-09-30 16:00:06 UTC 完成，原件与 source/build manifest 核对未变：

- Node → 专用 Chromium 的真实进程树，不含本任务 Electron 进程依赖；原有其他桌面应用未关闭。
- 真实目标先出现 `capture-ready`，再出现首次导航请求和页面最早内联请求。没有用相同 URL 的替身页面代替受控 target。
- 页面示范、保存点和封存后关闭原站；共享 Web 回放重建历史正文、CSS 颜色与直接 PNG，同时保留背景资源缺口。
- 点击历史 node 32／top／event 10，绑定 `string`、`page-displayed`、`exact-text` 字段到真实保存点，再固定版本和刷新回读。
- 同一固定版本、同一工作流，分别实际运行正确值／错值／缺来源；从 owner UI 显式选定真实 dataset attempt 后生成报告。三次执行均为 `current-page-test`，不外推为从入口运行已通过。
- 正常退出得到 exit 0，受控 Chromium 进程已结束；同一数据根重开后固定版、profile 元数据与原件回读一致。profile 实际重新打开和 Cookie 持久性另属生命周期测试，不能仅凭元数据回读推断。
- 离线回放、字段绑定、固定版只读页在 1450×935 与 1100×760 均无横向溢出；这不是完整易用性矩阵。

关键身份：

| 项目 | 身份 |
| --- | --- |
| 来源录制 | `64ab7333-927c-461b-9d01-d666a7113eff` |
| 项目 | `1a8f9eda-7664-45fc-911b-9dc46c531335` |
| 固定版本 | `92562751-f163-47b3-b27c-af88d9d921c4` |
| 固定内容 Hash | `0883e894f54ac33e7200466aaf90ecfe9fd74ef9862a85eb1448d46eebf685b6` |
| 正确值 execution / report | `0017f650-4d66-487c-9b01-443f82cb9f44` / `7dba88ef-4814-4b24-a53e-4b8ff629082a` |
| 错值 execution / report | `97b0b5ae-9a55-45ac-b631-3a259e31e902` / `0e24c825-53e4-41df-b6f1-7dd260c28d34` |
| 缺来源 execution / report | `12554a15-25ae-4d34-b8d6-d9a79b2fa2ec` / `4f803213-c051-4654-bb01-1cf4969d301f` |

真实执行采样为 14.00，正确输出 14.00 得到 pass；错误输出 15.00 得到 fail；输出 14.00 但没有同次 sourceRef 得到 inconclusive。历史示例 13.00 不被当成执行时的采样值。

### 生命周期与输入控制：仍有阻塞

`lifecycle1` 已执行同根第二 writer 拒绝、受管新页面导航前采集、路由 generation、弹窗拒绝及下载尝试；之后因测试脚本等待原生操作屏障超时而停止。该超时属于测试协调失败，不是输入锁通过或产品失败的证据。

`lifecycle2` 实际执行原生鼠标／键盘与 Puppeteer 正反检查，发现：runner 控制期间，原生输入确实被拒绝，但 Puppeteer 点击和键盘输入同样没有效果，计数与文本均未改变。**因此有头 Chromium 的交互式自动执行当前不成立，B3 仍未完成。** 不能用前述只读采样／三态核验成功替代此项，也不能在命令前后临时解锁去绕过物理输入隔离。需另行确认受支持的隔离或显式能力边界，再真实复验。

独立审查结合 [Chromium InputHandler 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc)确认此接口未暴露按输入来源过滤的选项；[Puppeteer headless 模式](https://pptr.dev/guides/headless-modes)是启动模式，不是保持页面 JS 状态的实时开关。最小候选方案是显式区分有头人工示范与无头从入口执行：先正常关闭、排空并释放同一专用 profile，再重新打开，禁止同时使用或复制 Cookie。当前页面临时状态与执行中可视人工接管不随此方案成立。

2026-09-30 16:18 UTC 已向用户询问是否接受这一产品取舍；**尚未得到确认，不将该候选方案写成已实现功能**。OS 输入遮罩、窗口最小化或短时解锁不作为未经验证的替代方案。
