# M1 独立普通用户复走（2026-09-27 → 28）

状态：独立复走结束，M1 产品门未通过。普通 UI 创建、示范、保存点/字段、历史编辑、固定版本、导出、独立实现和映射确认均实际操作；同一 V3 的正确值、错误值、缺来源三次执行均完成，但机器验收全部 fail，未得到要求的 pass/fail/inconclusive。正常退出、同数据根重启回读及第二次正常退出已完成；桌面令牌已归还 root，数据保留，暂停等待用户确认。没有展开 M2/M3、长测或打包。

## 身份与隔离

- 独立上下文，工具实际配置 Astra/high；唯一桌面令牌由 root 交付。未阅读实施者测试脚本、报告或实现器，未使用 `--handoff`，未使用隐藏 dispatch、studio 方法或文件修改补任务。
- 测试源码/构建：`dc78b3d3dad2c12426cf43f86bba492d022bec06`；Node 24.21.0 / npm 11.19.0。
- 普通启动：`npm run demo:product -- --record-visible`。沙箱启动先发生 GPU `-1073741515` 失败，失败根保留 `output/product-demo-1790525083265`。按用户授权以 require_escalated 同命令启动成功；未改 GPU 或安全参数。
- 新数据根：`D:\Workspace\browser-evidence-studio\output\product-demo-1790525097044`；合成站点 `http://127.0.0.1:3428/orders`；初始实例 `cf21e9ce-e585-4292-8b1a-2a2dbbe11978`，PID 32532，专属窗口 855554。旧用户窗口和数据未操作。
- 窗口采样证据：本根 `visible-evidence-1790525097799`，已正常退出 finalize。动作观察记录：本根 `independent/actions.jsonl`。只保存目标 BES 图像；工具错配聊天图像未另存或传播。采样间隔和日志警告见下文，不声称无间隙逐帧录像。

## 本次普通用户资料

项目「秋季订单实付复核」，环境「秋季复核专用环境」。目标为核对合成账户每条订单及同次页面显示的实付金额，缺失来源须未核验。唯一需求要求两条订单与实付金额逐行对应，dataset 由 UI 保存为 `records`。

独立选择第二行 45.00 作为字段「实付元」例证，值类型 number、来源政策 page-displayed。字段与普通注释独立：普通注释指向第一行订单身份“订单一”。没有填写 sourceProof、XPath、内部 ID 或由实施者提供的 selector。

## 实际经过与边界

| 场景 | 实际观察 | 状态/边界 |
| --- | --- | --- |
| U01 | 从空应用创建项目和隔离环境，在尚未录制时打开合成站点，点击合成登录；保留环境并关闭/重开环境后仍见合成账户一和两条订单 | 页面持久登录观察成立。可选 CSS 检查为空时自动登录判定为 unknown，未声称 verified；失败/过期登录负例未测 |
| E04 | 首次录制前通过 UI 授予当前页读取/操作，公开 session snapshot 发现按钮，公开 action 点击“重绘订单”，页面计数 0→1；正常 UI 撤销后同授权读取返回 403 AUTHORIZATION_REVOKED | 成立。请求、实际 succeeded 与撤销结果见 independent/e04-*.json |
| U02 | 启动录制，点击“记录当前结果”产生单卡及收据；编辑标题/说明后切页再读保留；查看历史来源再返回 | 可见路径成立；正常重启后卡片/历史来源回读成立 |
| U03 | 原卡事件 #3；“添加所需字段（实时页面）”选第二行金额，另建“字段现场示例”事件 #20，绑定 node 33 | 新现场例证未回填旧卡。重启后同字段含义、number/page-displayed、node 33/event 20/span/45.00 均由 UI 回读 |
| U04 | 修改字段说明并导航保留；在另一卡给第一行身份 node 24 创建独立普通注释；取消历史选取仍保留原字段 node 33；仅改说明不换绑定；显式确认解除后显示无绑定 | 可见独立性/取消/保留/解除成立。为后续执行，再通过普通历史 UI 将同字段绑定回“字段现场示例”原第二行节点。解除截图 independent/u04-explicit-unbind.png |
| U05 | 正常结束并封存，实时登录页保留；从存档历史回放新增“停录后补充：订单范围”卡；补充字段示例卡说明；发布 V1；复制带注释的初始卡，独立改名说明，发布 V2 | 公开导出核对 V1→V2 parent；V2 共4卡2注释，副本卡与注释为独立 ID，derivedFrom 指原卡。root 中途只读原件/V1哈希对比未变；最终核对由 root 独立执行 |
| U06 | 普通导出 V2，核验交接 hash/实例，公开 API 读全资料；独立编写 Puppeteer 实现，UI 登记目录、派生草稿、读取映射、确认映射、发布 V3；同 V3 真实执行三输入 | 未通过：三份报告全部 exact-string 来源失败；错误值检测和缺来源 inconclusive 未成立。结果页看到了同需求与实际数据，但没有点通结果→同保存点定位，U06.4 该部分未测 |

## 固定版本与公开读取

- V1：`0577fbbb-b44d-45ba-a96e-f2b9c9ee5842`，3 卡，1 字段，1 注释。
- V2：`305f0628-3510-4980-be98-9527e693e680`，hash `cf67749ec96da7cc709fd4d2bbb6a271720d3b9ace9eb403df4ead6ef8d863f8`，4 卡，1 字段，2 注释。
- UI 返回交接目录：`projects/1fbc3366-20ef-48d1-8682-e71777520224/handoffs/f04e79d0-0bcd-4886-b395-4f65e0bbaaf1`。
- 独立读取程序：`independent/u06-read.mjs`、`public-query.mjs`；读取结果 `u06-public-materials.json`、`u06-source-summary.json`、`u06-source-artifacts.json`、`u06-example-dom.json`。
- 公开 summary → artifacts → 指定 DOM 正文读取1019字节合成示例，未读取原始截图像素。数据证明来自自己刚由 UI 创建的资料，不借其他 fixture。

## 已发现的普通路径问题

1. **公开协议说明不足（已由公共文档补齐后继续）**：原交接指向的 skill/validation.md 仅列 dom-text/json-record 名称，没有完整 sourceProof 形状。workflow.md 列 reporter 名称但部分参数仅概括；历史查询缺完整公共请求示例。报告 root 后，root 以文档提交 `be0dd1f133dee94f6288d2d09fe4572188c911b1` 补齐公共 API/skill。独立 Agent 从 access.skillFile 正常重读后继续，未读实现代码/实施者脚本，没有接收特定站点 selector。测试并非无需外部修复的一次顺畅闭环。运行时构建仍是 dc78b3d，没有重建。
2. **编辑长面板操作不便**：左栏滚轮多次无可见移动，使用正常 Tab 导航及切 tab 回顶完成；未注入滚动。点击后的 UIA 树有时短暂滞后于实际截图，需额外只读观察再操作。
3. **模式文字不一致**：实时字段选择时局部提示出现“正在历史页选择元素”，底部说明实时；实际选择产生新现场卡。只记录观察，不推断数据错误。
4. **工具目标瞬时错配**：早期两次 BES UIA 树与返回截图不一致，立即停输入，fresh 枚举并重取唯一目标后恢复；不是已证实人工干扰。未在错配图上点坐标、未保存他窗截图。
5. **工具自动审批一次拒绝**：U06 授权点击首次被拒，理由为可能含页面动作/执行且缺准确接收者和30分钟范围。只读重取截图确认仅 materials-read/history-read/results-read/handoff-export，全部页面、写入、执行能力未选；说明用户已授权本机独立复走 Agent 读取自建合成任务后，同一 UI 动作重试获准。不是产品授权失败，也未绕过审批。公开读取完成后已正常 UI 撤销此授权。

## 独立 U06 实现与真实失败

独立代码仅在本根 `independent/implementation/{collect.mjs,run.mjs,workflow.json,implementation.json}`。从本次公开历史 DOM 发现每行 `data-entity` 和金额 `data-field=amount`，普通 Puppeteer 读取每行身份及显示文本，再按用户固定 number 语义输出数值。技术证明为 dom-text；没有用示例常量代替观测，也未把 number 改成 string 或改来源政策凑 pass。两个 `.mjs` 的 `node --check` 通过。

UI 登记代码目录后，从 V2 正常派生新工作草稿 `446d2ac4-2a9d-4a36-a619-a5af36dc9166`，读取实现器映射、审阅 `/amount` 与来源证明、点击“确认映射并保存草稿”，随后发布 V3。V3：`e9bfc171-07e6-4b87-856f-ff6db68b3130`；contentHash `c68bf6861ae02160cfde34cef689b069193a1605312d13b86ec334b66fe4977a`。共同 codeFingerprint `b68550318abd2477deb25a57540a1d5e73dd028ba60c13160a946de4de886763`。

| 输入 | executionId | reportId | 实际数据与结论 |
| --- | --- | --- | --- |
| `{}`（observed） | `4ff26135-0222-4c10-b6f8-ed352ff10c88` | `fe803692-ada9-40d1-b015-91525e1b079d` | 实时 12/45，两个 DOM 来源引用；执行 completed，验收 fail |
| `{"variant":"wrong-value"}` | `69f2df55-885a-4c6d-b60f-f16aa3002142` | `2f026470-d428-4171-8f7d-03b93b68f230` | 12/46，原第二行 displayAmount 仍45.00，两个来源引用；执行 completed，验收 fail；不能据此算金额错配检测已验证 |
| `{"variant":"missing-source"}` | `4514b7ab-edb1-4a6a-ae8b-48d0b490f6f2` | `2b9ce476-7867-4364-a81f-71cdb9c0057c` | 12/45，sourceRefs 确实为空；执行 completed，验收 fail，未产生预期 inconclusive |

三份报告均 coverage=complete、格式 pass、来源 fail、版本 pass，各 2 条/1 批。相同实际原因：`Displayed text and its source entity attribute require exact string output; no implicit numeric or mask conversion`。类型规则接受 number，而 dom-text 来源规则拒绝 number；因此这份普通用户合法创建的任务在当前证明能力下无法得到 pass。没有声称错误值负例或缺来源三态成立。UI 的“快照校验通过”只对应代码/输入快照，不是资料验收通过；未提交人工接受判定。

三个验证录制 run 分别为 `1f8605b5-4eed-4d54-950c-91ddc1044b83`、`2ca0f22e-52fa-41f7-ac94-ba9fe2fbe6d8`、`644bfc71-22cd-4423-8865-240a47833287`。三个 dataset attempt 分别为 `ff00df2a-86b9-4a4b-8f79-3e5a7fcb009e`、`e807ca96-b83b-46c8-808a-d0c12fc2dc84`、`a438fc54-3005-4b52-b605-21c0d3cf0683`。失败后的只读诊断汇总 `independent/u06-final-executions.json` 包含完整 binding、输入指纹、attempt、批次实际数据、sourceRefs 和检查原因。原始报告在本根 `executions/<executionId>/report-<reportId>.json`。

## 正常重启回读、证据与交还

最后验证录制通过“结束并封存”完成。第一实例请求 Alt+F4 后因退出/编码过程仍显示窗口，随后标题栏关闭；未强杀，最终 shell exit 0，窗口消失。第一段视频 687 帧，精确源 `window:855554:1`，maxGap=6654ms，采样 missingFrames=0/captureErrors=[]、编码 exit 0。stderr 存在 WGC first-frame timeout/GetFrame failed 和关闭中的 UI sender 403；未据此推断任务证据丢失，也不能将采样 missing=0 写成无间隙录像。

同根重开 PID 10336、window 527418，未重启已关闭合成站点，没有启动新录制。UI 显示项目/环境、两份草稿、V1/V2/V3、四卡；选择“字段现场示例”→查看来源后恢复原 52 事件流与 #20 两订单页面；字段下拉回读完整说明、number、必须按页面显示值，以及 node33/event20/span/源文本45.00。打开 V3 只读视图再次核对同需求、字段、四卡和注释。重启时当前 Git HEAD 已含 root 的文档提交 fee53cd；实际构建仍为 dc78b3d，不将 HEAD 当成已重建版本。

第二实例正常标题栏关闭，shell exit 0，fresh 窗口枚举本 repo Electron 目标为空。第二段目录 `visible-evidence-1790528580052`：54 帧，源 `window:527418:1`，maxGap=6473ms，采样 missing=0/errors=[]、编码 exit 0。同样有 WGC stderr 警告。每段保留 `timeline.json`、`continuous-window.mp4`、帧图、`index.html` 和编码日志。普通 UI 阶段证据包括 `u06-mapping-review.png`、`u06-observed-data.png`、`u06-observed-failure.png`、`u06-wrong-data.png`、`u06-missing-failure.png` 与 `restart-*.png`。动作时间线是独立观察记录，不冒充逐次原生输入日志。

WGC 警告可复查 `independent/runtime-warning-excerpts.txt`：从 exec session 24134/60511 输出复制的有界原文摘录，注明输出 chunk；没有伪称保存完整 stderr。两段 `video-capture.log` 是编码日志，不是 WGC 日志。重启图中 12.00 的框不作为字段定位高亮通过证据；本次通过的是历史 #20 回读和左侧字段 node33/45.00 耐久绑定检查。

两次临时 API 授权均已普通 UI 撤销；第二次重开未新增授权。已归还桌面令牌给 root，所有数据保留，不再输入。root 的只读基线/最终核对入口为 `independent/root-original-hashes.before.json`、`root-fixed-versions.before.json`、`root-fixed-versions.v2-before.json`；唯一原示范 run 为 `16f27018-bdc0-4890-9606-fb7cca2e7adc`。root 最终审计 `independent/root-final-audit.{mjs,json}` 确认：8 原件逐字节 hash/大小及文件集合不变，V1/V2 文件 hash/contentHash 不变；V2→V3 除 outputPath/sourceProof 外任务语义不变；三执行各4个代码快照与独立代码 hash 一致、host snapshotVerified=true；两段7个源码 hash 与当前相同。此为 root 的独立只读核验，不冒充本检查者独立计算的结论。

同根重开命令（PowerShell，历史回读无需合成站点）：

```powershell
$env:BES_DATA='D:\Workspace\browser-evidence-studio\output\product-demo-1790525097044'
$env:BES_VISIBLE_EVIDENCE='1'
Remove-Item Env:BES_TEST -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& .\node_modules\.bin\electron.cmd .
```

未测边界：U01 登录失败/过期自动判定；U06.4 结果直接跳转同保存点；通用网站/真实账号；崩溃恢复；全面长测、打包和 M2/M3。独立复走没有代替用户对核心交互的确认。
