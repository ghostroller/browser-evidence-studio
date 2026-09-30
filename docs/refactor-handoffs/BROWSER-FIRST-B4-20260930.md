# B4 双宿主一致性与兼容收口

日期：2026-09-30 UTC。基线 `c69adf7fc0767985fe724de4cb38165275920abe`。用户明确要求继续 B4；沿用显式有头协作开发模式、普通 Puppeteer + Chromium 和按节点提交推送。当前限定范围已通过实际验收：共享语义、真实双宿主三态、旧存档只读和新造旧格式profile跨进程持久化均成立；不等于完整平台矩阵或M1最终产品验收。

## 实现范围

- 共享宿主能力与 provider 判别，区分 backend 支持和当前 browser surface；旧省略 provider 仍为 Electron，不兼容／未知／停用环境不可启动
- 修复 Node 漏接资料变更通知；把 browser 与 IPC 的资料编辑／发布提交事件收敛到同一领域服务。CAS、作者权限、固定版幂等及观察者异常语义保持
- 结果／封存诊断使用对应宿主说明，不再误导 Node 用户去 Electron 页面
- 提交可重复的 `test:dual-host` 正常 UI 纵向和独立旧格式 profile 合成回归；不复制第二套业务领域逻辑

未改持久化 schema、旧原件、旧固定版或旧 profile storageRef/partition；旧 Electron alert/confirm 模态问题继续仅记录。能力展示不是新增授权，Node 仍不保证物理输入独占、通用干扰检测或正式人工交接。

## 验证身份与证据分层

初始冻结源码清单含 200 项，SHA256 `a4cd4040738b3fd847b4f13dd9f45738ea5d3efed576527c3c0444de11026361`，独立静态审查逐项核对通过。若后续修复改变文件，最终运行以新清单为准。docs/目录和根README不在运行源码／构建清单中；test/下README仍在其中，后续说明或测试修订须单列身份，不能改写原清单。

1. 纯契约／组件：typecheck、11 文件80项纯 client/renderer 测试通过；golden JSON 是明确新造的旧 schema 合成字节，不能算历史账号或 GUI 验收
2. 命令上下文 writer 限制：初次六文件34过／20失败，原始工具输出截断，未伪造完整日志；扩充测试后的同入口复跑38过／20因 OS writer guard 不可用而失败，原失败保留。随后在实际桌面上下文的42文件326项定向测试全部通过，typecheck、Electron及Node构建exit0；证据 `../b4-proof/gate1`，没有绕过锁
3. 真正保留的旧存档：B2 47文件、B3 146文件及固定版／workspace 在当前 reader 的只读检查前后不变；真实旧来源12→13→14、固定内容hash和错误scope拒绝通过。首次读取使用 Node24.19.0，不能冒充匹配24.21.0的最终验收；最终使用匹配 Node24.21.0 对同一冻结源码复验通过，完整47／146文件、固定版和workspace再次全量hash不变；证据 `../b4-proof/legacy-readers-final`
4. 当前构建真实双端：`../b4-proof/main1/result.json` 首轮通过，同输入资料／固定版语义及三态报告一致；原件、固定版及622项源码／构建清单不变，两端自有launcher退出0、provider退出。Electron原生回放／固定版回读和Node真实SSE失效后权威回读通过；不承诺通知恰好一次
5. 新造旧格式 profile 实际持久化：`../b4-proof/legacy-profile2/result.json` 通过，合成表单仅1次登录，同进程重开／另一profile隔离／不同Electron进程重开均成立；两次原生窗口关闭均排空完成exit0，与第3项真正旧归档证据分开，与第3项真实旧归档证据分开

## 当前构建的真实双端记录

主纵向时间 18:54:13–18:55:07 UTC。冻结源码上构建，运行时 git HEAD 仍为基线、dirty=true；不能把基线 SHA 说成本轮新代码提交。完整源码／构建清单622项，文件 SHA256 `327c4fb0c335cc1307ad2f98523e5c34f17ae8624008cf0bcc81fc2c8de46f27`，结果和两份清单位于 `../b4-proof/main1/`。

两端共用同一合成 origin、页面内容与 `run.mjs` 字节，工作流 SHA256 `2c3e9057f2cf5e80471c1e97d6d1de587c9701290cf7d4053227062741fc49a3`。各自正常UI生成的 requirementId 写入各自 manifest，因此完整 codeFingerprint 不同；每端三次执行内部 fingerprint 保持一致。不同录制/固定版ID与内容hash也符合独立来源身份，不声称两份固定JSON字节相同。

| 宿主 | instanceId | 实际构建SHA256 | 原始示范 | 固定版 / contentHash |
| --- | --- | --- | --- | --- |
| electron | `5656b2a3-7495-4d36-ad4c-3b7a596173a1` | `0e5391490fa3384208025a6237aab2fc56bdba9d4dc0be8c9a2e64629acfb258` | `1a281084-0233-44e3-81d1-10ab0f8e7447` | `df4645c1-55e7-43b2-b86b-55d4bf1ead71` / `301a3beb77fdc2c61abecc5aa5394e3351601277d1c0a181cd968bddf4090916` |
| node | `582c00a2-0141-429c-9112-2fa2b040a594` | `49bf07794ef3a4b307b231d91dea3ff15cd121c9867fc0b59b5daf8b801a840d` | `14dd953c-d4de-4cd3-9329-72565c7b680e` | `9aa3d1b5-b699-4709-92e5-2945925b5d5a` / `e1e0f0f71fb061951b9e98af281087928f8b6e2f35c119a5fbbe6cb4879289ab` |

| 宿主 / 输入 | executionId | reportId | overall / source |
| --- | --- | --- | --- |
| electron / good | `751d0ae4-6c32-4fad-8e51-f1caf5a36979` | `a188845a-05ac-4229-b1f3-c3739a835073` | pass / pass |
| electron / wrong | `04da510f-6769-4728-b5a1-af701f5fffb4` | `7c08065d-0a20-4198-ac7f-133221c2d6d0` | fail / fail |
| electron / no-source | `9d2d585e-fc8b-44b6-ba8d-e06ddc6b4f53` | `e206846b-522b-4dbd-86ff-6fb38e0928a3` | inconclusive / inconclusive |
| node / good | `55f6a428-c99c-4f3b-8b17-f848e407d1f8` | `49091c60-9109-4d89-a1d1-d0dba7ba0716` | pass / pass |
| node / wrong | `368935cd-ef80-42c4-b270-e43be4856910` | `eadac979-a30f-4bea-bb93-b35ff8fcbd4f` | fail / fail |
| node / no-source | `af142265-da8f-479a-8f1c-5992a5c65639` | `0d50f3d7-7df3-4b17-97d9-a9473df9b923` | inconclusive / inconclusive |

报告独立核对本次执行的 rrweb 原始文本14.00及target/scope，不以历史例值13.00代替当前来源。good输出14.00、wrong输出15.00、no-source输出14.00但无来源，三态分别成立。Electron和Node该轮CSS背景均为captured；这不消除B3某次归档的CSS时间区间证明缺口，也不保证任意网站保真。

两端离线回放、字段编辑和固定版在1450×935及1100×760测得无水平溢出；根抽看字段绑定及固定版实际截图。回放使用原封存来源，fixture server先关闭；没有实时网页补历史。Node观察到61条scope失效通知，只断言至少一次正确projectId与回读，不将数量当吞吐指标。所有桌面活动串行，原有无关窗口未作测试目标。

## 最终复验与旧格式持久化

修正测试断言和README限定后，`../b4-proof/main2/result.json` 在19:00:15–19:01:09 UTC再次完成双宿主全部主链。最终622项清单文件SHA256 `7552056af5b5f62b4a6ae5a00075363da16a48ce2d8df62b51b53afb713e130f`；根独立逐文件核对当前内容，零差异。产品构建与gate1/main1相同，新增实际宿主／浏览器能力文案断言和截图；源码、测试、构建在本轮前后均不变。main1仍保留自己的原清单，不追写身份。

| 最终宿主 | instanceId | 原始示范 | 固定版 / contentHash |
| --- | --- | --- | --- |
| electron | `f78b7235-ab55-4028-970c-96bfc666933d` | `c512164c-ad39-4e24-ab22-577940aba056` | `04cde020-e4ed-4c44-8d54-f77457b36234` / `bff90aefcb2ed393f2df12a4135466d5938b1494e7e82e02311d3f439f7a1587` |
| node | `d6c74bbe-82da-4d84-9e02-150ccd0e381d` | `782c4d69-507c-4153-8e40-fb891b52ef3f` | `a3dcebd4-a8d2-4e75-80e0-ee5d9fd2c871` / `5611a8429cbc1772c43ab3ba2b2a3ccc0b92bbc3bd399b4acbab39cf4d8ff656` |

| 最终宿主 / 输入 | executionId | reportId | overall / source |
| --- | --- | --- | --- |
| electron / good | `f8aadf2b-c04f-4140-bab3-2d0e0b774185` | `b1f907a0-dbb2-419c-9bfe-7afc81d2dfe4` | pass / pass |
| electron / wrong | `24a1b5c3-eaec-4d84-a8cd-ead2caa156db` | `e342e0fa-253c-43d6-9062-8570cf2bc3e0` | fail / fail |
| electron / no-source | `6e78291c-fb81-436b-abdf-59ccaf08e3f8` | `243b2fa8-0210-442f-9e24-e17469ae62dc` | inconclusive / inconclusive |
| node / good | `c5d88c73-be6b-4eb6-89f5-677b3178e9b3` | `38e94eab-f87e-4b3d-a3a4-f95de91830a6` | pass / pass |
| node / wrong | `8a88f432-a6b9-4522-96f7-a53ed7efb8df` | `661db3d8-5a24-46fb-8317-9e8a9fbb11b6` | fail / fail |
| node / no-source | `a36d2e6c-f73b-4321-a6d9-6059cd1de469` | `ab9fb973-b028-42ed-9364-9a30eb4f5027` | inconclusive / inconclusive |

两宿主launcher/provider分别为133723/133734、134113/134322，launcher均exit0、provider均已退出。最终保留正确profile、live target、document token、原始采样和报告绑定；根抽看Node宿主及Electron companion浏览器能力截图，明确当前页面不嵌入实时浏览器和各端限制。

旧格式持久化实际时间18:57:22–18:58:49 UTC，Electron PID133240→133483，分别instance `d801672f-e85c-4a37-8881-108af64f9c48`、`6405101d-3ed4-4a34-9741-cb238af92706`。仅本轮新造的 `persist:b4-synthetic-custom-partition`，实际相对路径 `Partitions/b4-synthetic-custom-partition` 不变，provider继续省略、未知扩展保留。站点登录POST总数1，重启后登录可见；同origin第二profile未登录。两次点击已核对合成窗口的原生关闭按钮，生命周期均为 `reason=window-close / shutdown-complete / exitCode=0`。工具Alt+F4未生效，改用可见关闭钮；不记为产品失败。

legacy-profile2结束后仅test README文字限定变化，产品与可执行测试字节未变；最终main2已包含该README变化。各轮16个harness文件快照另存并核对当轮清单，不用当前文件覆盖旧证据。测试合成profile保留在忽略目录，无真实账号数据迁移。

## 实际定向门禁命令

在匹配Node24.21.0/npm11.19.0、能正常取得OS writer guard的桌面上下文运行；无Docker或GitHub CI。此次42文件326项来自以下显式集合，不是整库全量测试：

```sh
npm run typecheck
npm test -- test/unit/node-*.test.ts test/unit/runtime-provider.test.ts test/unit/workspace-management.test.ts test/renderer/node-owner.test.tsx test/renderer/managed-browser-toolbar.test.tsx test/unit/gate.test.ts test/unit/managed-browser-controls.test.ts test/unit/capture.test.ts test/unit/capture-navigation.test.ts test/unit/workbench-*.test.ts test/unit/replay-foreground.test.ts test/renderer/browser-workbench.test.tsx test/renderer/browser-materials.test.tsx test/renderer/browser-results.test.tsx test/unit/host-capabilities.test.ts test/unit/dual-host-compatibility.test.ts test/unit/browser-workbench-client.test.ts test/unit/browser-material-client.test.ts test/unit/browser-result-client.test.ts test/unit/product-authoring.test.ts test/unit/task-authorization.test.ts test/unit/refactor-agent-api.test.ts test/renderer/host-capabilities.test.tsx test/renderer/browser-workbench-startup.test.tsx test/renderer/workspace-management.test.tsx test/renderer/material-browser-refresh.test.tsx test/renderer/shared-web-replay.test.tsx
npm run build
npm run build:node
```

最终外部证据索引 `../b4-proof/final-index.md`、审计 `../b4-proof/final-audit.json`；sorted files map SHA256 `52a318dfe85c34aec2a8e46982623d81309303c6330d9e4c80da6ba1b5542361`。gate1到最终仅test/dual-host/README.md、host.mjs、legacy-profile.mjs变化，均是测试断言／能力观察／表述修正，产品及单元测试未变；最终main2覆盖这些可执行测试变化。

## 可重复入口与验收边界

启动与参数见 [环境](../environment.md#双宿主兼容回归入口b4) 和 [测试入口](../../test/dual-host/README.md)。主回归复用同一合成 HTTP origin／内容和 run.mjs 实现脚本字节（manifest绑定各自生成的需求ID），通过正常 UI 建项目、profile、录制、绑定历史13.00、固定资料，基于实际受控 live14.00 目标执行。独立读取原始 rrweb 节点、来源身份和报告；仅在关系已验证后映射正常生成的 ID／时间，不归一化失败；未知字段保留结论仅针对固定资料content及被比较的diagnostics／records，不声称整个报告所有外层字段逐项相等。三个结果必须分别 pass／fail／inconclusive，CSS等明确 partial 不隐藏。

旧资料兼容用当前 ArchiveReplayService、SourceModel、FileMaterialService 的只读路径，保持原来源URL／target／固定hash；不启动旧站点补全历史，不在旧根上初始化／修补catalog。真正旧数据缺失时必须报告 unavailable，不重建替身冒充。旧 no-anchor 场景由明确合成 fixture 检查，不推断缺 index 一定是旧格式。

旧格式 profile 测试只新造 metadata，自定义 partition、省略 provider、保留未知字段。合成登录表单而非 cookies.set 建立持久化；同进程关闭／重开、第二环境隔离、原生窗口关闭排空和不同进程重开分开核对。没有读取、复制或迁移真实账号 Cookie，也不宣称跨 Electron 版本数据库迁移成立。

## 测试修正与保留失败

`../b4-proof/legacy-profile1` 首次失败为测试错误：正常“检查登录状态”写入verified，而既有“保留环境”按约定回到unknown（保存不保证仍然登录），测试误要求保存后仍verified。未改产品语义求通过，失败现场保留，自有Electron正常退出0；后续修正测试断言并用新根重跑，最终主链亦复跑以绑定新测试源码。

## 已知限制与回归取舍

- 两端录制初始时机不同：Electron 此纵向在初始加载后开始，Node 在导航前安装采集；不声称初始网络覆盖完全相同
- Node 协作开发限制、旧原生 modal、CSS资源证明缺口及下载完整行为矩阵继续以各自证据标记，不由双端语义一致推定全部通过
- 本轮针对资料通知、共享 client/UI、旧格式和存储身份运行定向及实际回归；未改变资源截获／写入格式，不机械重跑无关全部长测，历史长测不能覆盖当前构建
- 单签发器新的正常配对撤销旧会话；本轮不得为了同时两次配对测试放宽会话模型
- 同发布 operationId 不新增固定版，但提交通知允许重复；SSE仅失效提示，不是 exactly-once 收据

## 最终交付状态

代码及可执行回归节点为 `16ad490`，其源码／测试文件与main2最终622项清单一致，随后仅整理文档。分包：`eddd46d` 宿主能力与provider UI、`78c72da` 共享资料事件和旧资料契约、`16ad490` 可重复真实双端／profile回归。

限定B4验收完成，全部本轮自有测试进程已退出，无关旧窗口保留。按宿主能力、共享资料事件／旧数据契约、可重复真实回归、文档分包提交；发布后以实际远端SHA核验，不将只读查询或dry-run当成功推送。后续仍需按具体功能风险扩展下载／权限、跨平台、真实账号升级、长运行与广泛网页矩阵；不默认开启新的重构阶段。
