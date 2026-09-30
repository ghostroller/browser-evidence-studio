# B3：纯 Node 后端与独立 Chromium

## 状态与范围

2026-09-30，用户在 B2 交付后明确要求继续 B3。起点为 `e0e44dbc349619b3b3d6ac3b3c66535affc83599`。本轮在 dot 云端 Linux 桌面实施；本文记录实现、历史失败与独立验收。

**当前结论：B3 显式有头协作开发／测试模式已实现并通过指定真实纵向。** 这不提供物理输入独占、完整人工干扰识别或全部生产兼容性保证。最终代码节点与同构建验收见本文最后一节；前面的失败记录保留为历史，不重写为通过。

首个发布节点仅包含 provider 身份、共享 `StudioCore` 和保持行为的 Electron adapter。后续按 17:32 用户确认的协作式开发模式交付 Node 控制台与独立 Chromium；以下分别记录首节点、失败候选及最终新版验收，不将不同构建的结果混为一轮。

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
2. 初始强隔离方案要求等待 CDP 输入锁并证明原生输入受阻而 Puppeteer 可用；后续实测证明二者都被阻止。该失败保留。17:32 用户明确选择协作式开发模式，撤销“物理输入独占”这一 Node 开发模式要求，保留协议控制权及来源／取消检查；新验收见下文。
3. 运行时对象不能整体写入 page-registered 或关闭记录，避免 Page／View／Capture 对象循环引用。持久事件只保存明确的标量身份。
4. 首次环境启动与 owner 撤销／过期、进程退出可竞争。需要取消、启动完成屏障和逐项清理，不能先释放写锁，再留下迟到创建的浏览器或 HTTP 服务。
5. 页面消失后仍须能关闭会话。UI 与服务端现已采用页面命令／会话命令的显式身份边界。

## 验收记录

### 已完成的定向检查

- 冻结候选 `gate1`：类型检查、23 文件／202 项定向测试、完整 Electron 构建和独立 Node 构建全部退出 0。源码身份为上述 B2 HEAD 加本轮尚未提交的 B3 变更，保存构建前后 source manifest。此门禁于 2026-09-30 15:43 UTC 完成，尚未证明真实 GUI 链路。
- Node owner renderer 9 项模块测试通过：内存凭据、重复写入／丢回执、读取失败、迟到结果、明确选择数据集、启动中停止、无页面会话关闭、显式撤销和首次无会话时撤销入口。
- 以上是模块测试，不能当成真实 Chromium 录制、执行或原生输入锁的通过证据。
- `gate2` 再次通过类型检查、23 文件／202 项及 Electron／Node 构建。其实际 Electron `product-journey` 与重开均通过，测试实例 `desktop-1790785377834`、进程 102472／102862，各自退出 0 并完成 shutdown；581 文件 source/build manifest 在该次测试前后不变。此证据覆盖共享核心抽取后的指定 Electron 旅程，不把旧对话框缺陷或完整旧 profile 兼容矩阵改记为通过。

### 初始验收计划（完成范围见后续记录）

- 独立 Node 进程树与新 Chromium profile，导航前采集，真实示范／保存点／封存
- 原站关闭后的 B2 离线 DOM 回放、精确节点绑定、固定版本及刷新回读
- 同一固定版本的正确值、错误值和缺来源执行与核验，核对真实 dataset／attempt 身份
- 原生输入锁、受控输入、同文档路由、新页面、地址栏导航、停止／撤销、崩溃、写锁、关闭和重开
- 新构建 Electron 定向回归，旧对话框问题继续保留

下文记录真实失败、重试、最终构建范围和未测项；不把准备好的测试脚本计为测试已执行。

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

### 历史节点：强制输入隔离方案的阻塞

`lifecycle1` 已执行同根第二 writer 拒绝、受管新页面导航前采集、路由 generation、弹窗拒绝及下载尝试；之后因测试脚本等待原生操作屏障超时而停止。该超时属于测试协调失败，不是输入锁通过或产品失败的证据。

`lifecycle2` 实际执行原生鼠标／键盘与 Puppeteer 正反检查，发现：runner 控制期间，原生输入确实被拒绝，但 Puppeteer 点击和键盘输入同样没有效果，计数与文本均未改变。**因此该强制输入锁候选的有头交互式自动执行不成立。** 不能用前述只读采样／三态核验成功替代此项，也不能在命令前后临时解锁去绕过物理输入隔离。需另行确认受支持的隔离或显式能力边界，再真实复验。

独立审查结合 [Chromium InputHandler 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc)确认此接口未暴露按输入来源过滤的选项；[Puppeteer headless 模式](https://pptr.dev/guides/headless-modes)是启动模式，不是保持页面 JS 状态的实时开关。最小候选方案是显式区分有头人工示范与无头从入口执行：先正常关闭、排空并释放同一专用 profile，再重新打开，禁止同时使用或复制 Cookie。当前页面临时状态与执行中可视人工接管不随此方案成立。

2026-09-30 16:18 UTC 曾询问是否采用有头录制／无头执行分离；此方案未获采用。17:32 用户改为明确选择下文的有头协作式开发模式。OS 输入遮罩、窗口最小化或短时解锁没有被实现或算作通过。

### 独立权限、取消与崩溃恢复

- `security1`：24 项真实 owner／proxy 负测通过，包括缺失／错误凭据、错误 instance／Origin／Fetch Metadata、重复安全头、额外 source 字段、过时目标身份、其他项目、工作台 token 不能调用 owner，以及撤销后的拒绝。
- `startup1`：首次启动尚未取得会话时，正常 UI 仍可撤销；通过启动器正常重新授权后，同一 profile 可重试成功。不是通过隐藏接口补造会话。
- `recovery2`：普通停止执行完成，真实 Worker thread 的心跳停止，执行持久状态为 cancelled，控制权返回 human。此前 `recovery1` 把 Worker 的共享 process.pid 误认成独立进程，属于测试断言错误，已保留而非报为产品故障。
- 原生地址栏测试未能观察到有效导航或对应事件，因此不认定导航隔离通过，也不凭该次超时报为策略失效；该分支仍未验证。
- `crash2` 是真实产品问题：终止确认为本测试所有的 Chromium 后，等待停止并刷新，正常 seal 仍因失联 CDP 删除 recorder 脚本失败。录制保持 degraded，无法在同一后端中重开；整体后端退出仍可结束进程并保留中断状态。
- 随后仅在 Node 候选增加显式“结束中断会话”。必须由后端确认 provider 已断开，验证 owner／project／profile／session／lease；加入并确认受控进程结束后，追加恢复缺口和 interrupted 状态，再关闭 writer、回收宿主资源。不能调用 seal 伪造完整来源，持久失败不宣布结束。
- `crash-recovery5` 于 16:40:46 UTC 完成：真实进程终止 → 正常 UI 显式结束中断 → 原件字节保持 → 5 项误用请求被拒绝 → 同一后端／profile／storageRef 重新打开，取得新的 browser／session／target，人工控制下页面输入有效。该轮 source/build manifest 未变，最后正常退出。先前测试重跑修正了事件名、临时 writer.lock、旧测试 CDP 连接和 openedAt／revision 合法变化的错误假设，原现场均保留。

恢复候选 `gate3` 的类型检查与两种构建通过，新增 4 项真实 writer 上下文恢复单测通过；定向集合为 **206／207**，唯一失败是随机新根首次获取确定性端口锁时遇到已占用端口。该行为保守拒绝写入，不改变端口重试以绕过排他性，也不把此整轮写成全绿。当前 schema1 的端口算法保持不变，哈希冲突／无关监听占用可能导致假冲突；改变算法需要版本兼容方案，以免旧新二进制同时写同一根。

这些恢复结果不修复旧强制锁方案。后续交互式执行按用户新确认的非独占开发模式重新验收，不能复用只读执行结论。

### 16:49 关闭顺序修正与阶段停点

审查还发现 Node 先释放根目录租约、后写 `launch.json=closed` 的顺序错误，旧进程可能覆盖紧接着启动的后继实例身份。候选现先在持有租约时写入自己的最终状态，再释放租约；清理失败记录为 `shutdown-failed`，不冒称正常关闭，租约释放后不再写入该根。

`final-shutdown` 独立实测启动／退出／立即同根后继通过：并发根被拒绝，旧进程不迟到覆盖后继身份，每次正常退出保留自己的 closed identity，早期无效 executable 启动不改写此前 manifest。此项没有启动业务 Chromium 或 GUI，不能代替主链或输入测试。最终类型检查和 3 文件／19 项相关测试通过（含此前碰到端口冲突的 node-runtime 文件），但没有将 gate3 整套重跑，因此仍保留其 206／207 历史结果。

| 实际范围 | Node entry SHA-256 | 本次 source/build manifest SHA-256 |
| --- | --- | --- |
| attempt3 主链／当前页只读三态 | `acf2d63be8168584d9bdaa62e1fb99fe33a1ff252c6bc39722498c4b158f1e09` | `d5923de96602c6be5bc3dab70e003dd297651bb8d2bde82b29678d7c20070d71` |
| crash-recovery5 显式中断／重开 | `f7196e015714f0e99830407884102d871d2978174da2d738aaf89e7d4865d5ab` | `d67e551076e1c2ed53d700df7a7b9900df9c6c942c26711951f218b82f8ca8f7` |
| final-shutdown 最终入口顺序 | `31710326a7d8bc3879223a887fcde707c750876e86a5e0542c96161d13b9d9fc` | `3af2fc55aefc421ae8634d85b05a98bd11795a2c0c0ff69dc9265ba39cd826d9` |

最终 584 项源码／构建 hash 已由主任务逐项核对一致。三个构建范围不能合并宣称“最终构建所有场景全过”。测试合成实例已退出，历史端口不是仍可用的产品地址。

16:49 时的停点：共享核心与 Electron adapter 已单独发布，Node 候选保留在工作区。17:32 用户已作出下述运行模式选择并要求继续；没有自动切换、临时解锁、OS 遮罩或 webSecurity 等安全设置放宽。尚未覆盖完整旧 profile、全部 frame／shadow、长期运行和跨平台矩阵。owner 状态当前返回完整列表、客户端最多读取 2 MiB，不能称为服务端分页／有界投影；大目录规模仍有明确限制。该时点的旧 Electron-only 结果提示已在最终 Node 入口交付中校正。


## 17:32 新确认：有头协作式开发／测试模式

用户明确要求按“提示避让、不强制拦截”的开发模式继续 B3。该选择针对 Node 开发工具，不更改 Electron 的物理输入隔离，也不把网页或 HTTP 调用者变成可信 owner。

- Node 启动必须显式传入 `--dev-cooperative-input`，缺少标志在创建数据根、租约、监听器或浏览器前拒绝；本轮不接受与 `--headless` 组合，不做自动模式切换。
- 运行时能力明确记录 `executionMode=cooperative-dev-test`、`inputIsolation=none`、`physicalInputExclusive=false`、`interferenceDetection=partial`、`humanHandoff=unsupported`。策略由本地启动确定，普通请求不能提升。
- Puppeteer 和人工都可能向页面输入。owner UI 常驻提示此事实，执行中提示不要操作受控浏览器，并提供始终可用的停止入口。逻辑 locked／lease 用于流程和协议检查，不再标注为物理页面锁定。
- 现有身份、授权、目标 generation、取消、证据和固定版本核验继续执行。仅能检测部分目标／导航变化，不保证发现每次人工点击或输入；报告通过不意味着运行期间无人干扰。
- 当前页执行应保留真实页面及临时 JS 状态；从入口执行使用其真实新目标／采集来源。两种路径均须实测点击、键盘、取样与报告，不能用此前只读三态代替。
- 需要人工接管的 runner 请求在本 Node 切片明确失败，不冒称已经具备交接 UI；后续如需提供该能力另作实现与验证。

新版能力契约、可视提示、交互执行与中断已按下文真实场景复验。


## 最终交付与同构建验收（18:17 UTC）

代码分为三个可说明的提交：`8e01e4e` 专用 Chromium provider／生命周期与中断恢复，`6434f0d` 受保护 owner 协议与边界测试，`dc19f66` 显式启动器／开发控制台与共享工作台接入。共享核心早先已由 `5fb39e7` 交付；本轮没有再改动 Electron 的核心与对话框交互。

最终测试源码为 `4fdcc85` 加本轮变更；提交前主任务逐项核对 **588 项源码／测试／配置／构建文件** 与最终 manifest 全部一致。提交只改变 Git 元数据及说明文档，不改变已测代码字节：

- Node entry SHA-256：`0715fdef7559f8f9c505caf9f3365ee28a4a5a1f45fae0223b47b6f2f5160287`
- 最终 source/build manifest SHA-256：`5a84f976d2a111f163a3b92dbe0352ab23e50f4c2959ebfe4f3289873949e2cb`
- 排序后 files-map SHA-256：`f61cc5bf1aa49534f57566ebd08471ce25fe6beb687b9363b547062d291d1a9d`
- 类型检查、27 文件／233 项定向测试、Electron 构建和 Node 构建通过。不是全仓长测或 GitHub CI；历史 gate3 的失败仍保留，不通过相加多轮重叠测试扩大数字。

### 实际通过

1. **显式启用**：无 `--dev-cooperative-input` 或与 `--headless` 组合的实际 CLI 拒绝，指定新根仍不存在。
2. **完整 Node 主链**（`cooperative-main3`）：新项目／专用环境 → 导航前采集及最早内联请求 → 真实示范／保存点／封存 → 原站关闭后的隔离 DOM 回放 → 实际历史节点绑定 → 固定版本／刷新回读。原件和固定版 hash 保持。当前页的普通 Puppeteer 点击／输入有效，连续三次执行保留同一页面闭包 token，不能用同 URL 新页冒充。
3. **从入口执行**：真实新 page／target／document token，导航前 capture-ready，普通点击／输入、来源采样、实际 dataset attempt 与报告绑定通过。并非之前的只读 current-page 测试。
4. **非独占输入**（`cooperative-native-final`）：同一真实目标、同一活文档，原生鼠标／键盘输入能够进入，之后 Puppeteer 点击／输入也生效。owner 的提示和独立停止按钮在 1450×935 与 1100×760 检查；这验证的是协作开发模式，不是人工输入被阻止。
5. **执行与导航**（`cooperative-navigation4`）：普通 runner goto、链接点击、History API 路由、顶部停止及 Worker 心跳终止通过。未匹配的原生地址栏导航先撤销逻辑 lease／gate 并请求取消，然后继续本来已获允许的导航；复测进入正常页面，未再出现旧 `BAD_MESSAGE`，新目标可继续运行。实际 Ctrl+W 关闭精确执行目标会取消并移除该身份。仍不能识别所有人工动作。
6. **人工交接限制**：实际 runner requestHuman 快速明确失败并回到正常控制状态，没有挂在不可完成的等待 UI。旧 lifecycle1 对错误字段位置的错误断言保留，实际诊断从对应持久结果核对。
7. **renderer 崩溃恢复**（`cooperative-renderer1`）：真实 Page.crash 后，由后端确认 `renderer-failed`；新执行／封存提前拒绝。独立恢复入口关闭整个 owned 浏览器及所有页面，确认进程退出后排空并持久化 interrupted／缺口，原件保留，不造 sealed。七项身份／范围／预检反例拒绝；同 profile 重开后真实 worker 导航／点击／路由通过，第二次崩溃后的正常后端退出也通过。UI 在普通操作回执未返回时仍可轮询／刷新发现故障并进行恢复。
8. **生命周期／权限回归**：24 项真实 owner／proxy 负测、首次启动撤销／重新授权／同 profile 重试、整个 provider 终止后的五项误用反例与恢复、同根第二 writer 拒绝均通过。强制结束的持久化不确定性有审计／可见提示，不能把 kill 当成正常 profile flush；未确认进程结束时保留根租约。
9. **Electron 回归**：`desktop-1790791985879`，旅程进程 124742（18:13:06–18:14:30 UTC）及重开 125284（18:14:31–18:14:42 UTC）均退出 0，同轮 source/build 未变；既有 Electron 模态框问题未修改。

本轮正常测试启动器均退出、受控 provider 已结束，负测的预期拒绝单独记录。没有保留测试服务供用户误当成当前运行实例。

### 最终主链关键身份

| 项目 | 身份 |
| --- | --- |
| 来源录制 | `2a88169e-9aae-4abe-b33f-d74fd9a0b239` |
| 项目 | `b7fcb521-aa42-48cc-89cc-59b980366555` |
| 固定版本 | `c586ae27-2d0e-4684-a157-fd46f7a70cab` |
| 固定内容 Hash | `d3a85f8e25856fafe7380171a4e606a92acb58abcf9e81736b196ff8331fb7a0` |
| 正确值 execution / report | `cd563ce5-61b1-472b-8cd7-eb333aeb62f6` / `21503dc4-6c1a-4f6d-a1c5-061ecf51e699` |
| 错值 execution / report | `b832c206-243b-45f6-8ff6-713660181f31` / `8a7ae6ec-b02e-47f1-8a3e-f953b86f8f22` |
| 缺来源 execution / report | `71b09482-ad7b-48d4-90e4-899840728fc9` / `4c77d347-378f-4251-97bf-b4d5a689a8d2` |
| 从入口 execution / report | `2b4b9d71-4f19-44c6-8cf4-43344005b8bf` / `bf426d46-a22f-4af7-88f9-e23462a42402` |

### 已知限制与后续

- 本轮是用户明确接受的协作开发工具。没有物理独占输入、通用人工干扰识别或执行中可视人工交接，也不支持本入口 headless；未加入 OS 输入遮罩。
- 不宣称旧 Electron profile 迁移、完整跨平台／多来源 SPA／frame／ServiceWorker／权限／下载／长期运行矩阵通过。下载证据只是拒绝策略与实际尝试，不是完整原生下载取消事件证明。
- CSS 背景资源的严格来源证明缺口继续以 `unsupported/css-dependency-request-interval-unproven` 呈现；直接 PNG、CSS 颜色与文本的通过不覆盖该背景。
- owner 请求有头部／请求体／并发预算，但 state 响应没有服务端分页或完整字节上限；客户端 2 MiB 上限及 schema1 确定性端口假冲突限制保留。
- 历史干扰测试出现过 Chromium `RESULT_CODE_KILLED_BAD_MESSAGE` 和死 renderer 排空等待；没有足够浏览器内部证据断言唯一根因。最终导航路径和独立 renderer 故障均已复验，旧现场不删除。
- B4 可继续收口双端兼容、开发控制台体验及需要的额外能力；本轮不顺势实现新平台或扩大账号权限。

启动方法见 [环境](../environment.md#node--chromium-协作式开发入口b3)，协议边界见 [API](../api.md#node-本地-owner-控制b3-开发模式)。
