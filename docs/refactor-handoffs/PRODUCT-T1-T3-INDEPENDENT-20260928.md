# 2026-09-28 独立普通用户复走（修后功能闭环完成）

独立 owner：`independent_product_check`。独立步骤只记录该上下文自己的观察，不引用实施者测试结果；根对环境/原件的补充诊断与复核在末尾单独标注。最终结论：**修后合成范围内 U01–U06 功能闭环通过**，包含同版同代码三态、漏条/重复规则、双来源导航、正常退出重开回读。第一段U04阻塞、第二段最小化与530次缺帧及两次采集失败保留；恢复段零新增缺帧计数仍有14.249秒最大采样间隔。以下按时间保留进行中的原始判断，最终范围见末尾验收结论，不能解释为单一候选一次无中断或无间隙录像通过。

## 候选、隔离与驱动

- 第一段冻结候选：`8599ebdfef9d114824d53a0aa232681d66821cbb`；Node `v24.21.0`、npm `11.19.0`。
- 普通命令：`npm run demo:product -- --record-visible`。只为启动 shell 临时 prepend 根提供的 FFmpeg 9.0.2 目录，没有修改全局 PATH。
- 默认沙箱首次启动失败：空根 `output/product-demo-1790561388999`，PID 29984，GPU 子进程多次退出 `-1073741515`，随后 `ERR_FAILED` 加载 renderer；没有输入业务数据。
- 经批准以相同命令在非沙箱重试，成功新建空根 `output/product-demo-1790561412653`；本机合成站点 `http://127.0.0.1:54291/orders`。UI 增量枚举得到 BES 窗口 `134212`，随后公开 health 确认实例 `c9337f71-d1b5-4624-9ba8-afdb34b059d3`、PID `31432`。
- 没有操作默认数据根或旧 PID 24368，没有真实账号。没有读取实施者源码、`product-journey.ts`、`product-implementer.ts`、实施报告、旧独立资料或 selector 清单，没有调用 `--handoff` 实现器。
- 已阅读项目技能及其公开 references、computer-use 技能/指导/API/确认规则、公开旅程规范 09。sky 在子任务调用 `get_window_state` 时被 `root-only elicitation` 阻断；根的 screenshot 调用另报 `SetIsBorderRequired ... 0x80004002`。随后按根批准的备用方式，通过该新实例自己的 `DevToolsActivePort`，以仓库已有 Puppeteer 驱动可见 renderer、合成页面与历史回放页面。
- 备用驱动仅使用只读 DOM/截图、真实 mouse/keyboard。没有 `window.studio.call`、隐藏 dispatch、React/表单状态注入、业务数据文件修补。辅助文件只在新根 `independent/`。

## 已观察到的路径

1. 可见 UI 创建项目“青禾数值巡检”、环境“青禾合成环境”。环境先打开，显示“实时页面 · 未录制”。在本机站点点击“登录合成账户一”，然后“保留环境”、关闭浏览器会话、重新打开，仍显示登录及两条订单 `12.00 / 45.00`。环境未配置完成检查，应用状态保持 `unknown`；不能称机器已验证登录。明确的“检查登录状态”点击尚待补齐。
2. 开始录制后点击“记录当前结果”，出现统一卡片；命名“订单金额首样”，关联自然语言需求，类型改为需求示例。普通控件设置记录数 `2`、去重输出键 `orderKey`。
3. 实时选择订单二金额 `45.00`。UI 新建“字段现场示例”于事件 `#10`，旧卡仍 `#3`。保存字段“实收金额元”，数据集 `qinghe_orders`，值类型 `number`，来源 `page-displayed`，没有输入 proof、XPath 或注释。
4. 编辑字段含义并保存。再进入实时选择后，侧栏“取消选择”点击和对 renderer 的 Escape 未产生状态变化；底部“取消实时选择（Esc）”有效。原字段绑定与修订号保持。该差异仍需区分遮罩/焦点与真实产品行为，**不直接归因为产品缺陷**。原截图、控件边界和动作都已保存。
5. 在历史页选择注释对象。备用驱动的 iframe span 点击实际选中了 `body/node9`，UI 如实显示原始 body 文本及 `presentation:missing`。未将其冒报为金额节点；给整个页面添加观察性注释，再编辑并保存。此注释没有替换字段原来的 `span/node33`，字段未关联注释。
6. 停录后保留浏览器页面，发布 V1；再由封存历史时间轴选择 `#5`，新建“回看订单初态”卡并保存，发布 V2。V1/V2 均从 UI 打开。此阶段补点已完成，但规范要求的**复制卡片后改标题及 derivedFrom 不变**尚未完成，不能以历史补点代替。
7. 经普通任务授权 UI 授予 materials-read/history-read/results-read/handoff-export/page-read，并通过“准备交给 Agent”导出 V2。执行授权因尚未登记脚本未签发。
8. 从该导出三文件独立核对 task SHA、实例，并经公开 API 分页读齐需求、字段、卡片、注释、录制引用；进一步读 historicalNode、historicalLocators、原件索引与一个 1106-byte DOM 原件。没有读取 token 到输出。

## 固定资料与公开读取证据

- 项目：`3beefc9b-453c-46d5-87ed-1e40314b5474`；环境：`e84c70d6-d215-4f0e-a65f-9a3767a97819`。
- 示范录制：`79c8b6e9-e511-45b3-b57c-b28f284ecf17`。
- V1：`38773de3-dabb-4e03-9b87-c321463b73ac`，hash `d8ee60e96ca5c46ce17097c255566a20f1eb05f8234aaecb7ad5b41753426a07`。
- V2：`1e6bef18-66c2-4783-a7be-22a5a4306856`，hash `5ae36843159a8ba9675bc28e8c1c2692759111806ede70c0ee9a7a1df1910a91`，parent 为 V1。
- V2：1 requirement、1 field、3 checkpoints、1 annotation、1 recordingRef；field 与 requirement 的 dataset 均为 `qinghe_orders`。字段 ID `field-f4f8c703-0110-416c-8fba-614e0c429a83`，target `node33/event10`，`number/page-displayed`、`bindingStatus:bound`，未提供 sourceProof。字段 historicalNode 是真实 `span[data-field="amount"]`，显示采样 `visible / 45.00`。
- 公开原件 `art-000000000029` 为完整 HTML，sha256 `0d7df59f5b6ab00b83c8ede4af96790086878e3e5009978865eacfb1f0cbb767`。其两行实体祖先分别为 `data-entity="order-one" / "order-two"`，金额节点为 `data-field="amount"`。这些事实来自独立读取的原始材料。
- 初始项目目标使用了“应收金额”措辞，具体 requirement/field 根据页面明确为“实付金额”；该语义措辞差异保留在 V1/V2，不隐瞒为一致任务 brief。

公开读取记录：新根 `independent/material-v2-public.json`、`public-discovery.json`、`public-original-artifact-index.json`、`public-source-dom.json`。原导出位于 `projects/<projectId>/handoffs/42ffea21-31f0-4a83-9f6e-df1db196b381/`。应用退出后原授权失效，恢复时需普通 UI 新导出。

## U04 阻塞与保留现场

从 V2 点击“从此版本派生草稿”，得到 `d3a01867-0a05-4336-988b-4dae1c67d3c8`（r0）。先在字段下拉选已有 F，需求下拉仍为“新需求”。修改字段含义但未主动保存，切到存档再回来：编辑文本和 node33 仍在。

随后点击“解除绑定”，出现“解除该字段的绑定，保留说明？”及确认/保留按钮。点击“确认解除绑定”后，本地字段目标消失。尝试从需求下拉选择原需求，却先提示“先选择一个需求。”并返回新需求。保存字段与发布候选也不能完成。草稿保持 r0，因此不能宣称解除已经耐久保存。

根任务已接收此阻塞并要求停止产品输入。没有写文件或隐藏调用修补。第一段正常 `Browser.close` 退出，demo 和关闭脚本均退出 0，PID31432 已不存在；关闭期间控制台有多条 `403 Untrusted or closing UI sender`，未强杀。待新冻结候选用同一失败根恢复并继续，不能把第一段当作完整产品通过。

关键证据（均在新根 `independent/`）：

- `ui-1790562701556.json/png`：已有字段编辑；`ui-1790562706385.json/png`：切存档返回后保留文本与目标。
- `ui-1790562724193.json/png`：明确解除确认；`ui-1790562733340.json/png`：确认后目标消失。
- `ui-1790562742725.json/png`：需求下拉选择被循环拦住；`ui-1790562867941.json/png`：退出前保留现场。
- `ui-actions.jsonl`：完整可见驱动动作索引；每步 JSON 保存当时全部普通控件的 rect、值、标签，PNG 为分页面采样。部分 WebContents 页面隐藏时截图会为极小尺寸，因此不将它们当作全窗口证据。

## 第一段连续窗口证据与待办

`visible-evidence-1790561413957/continuous-window.mp4` 已正常编码，2,432,171 bytes，ffprobe 时长 1456.92 秒；1498 张原生窗口帧、`timeline.json`、`index.html` 均保留。它来自 demo 的实际窗口采样，与分页面 CDP 截图区别记录，不声称由 sky 完成。

后续必须继续：恢复未完成编辑并验证退出回读；显式解除的耐久结果；既有卡片查看来源与返回；复制卡片、改标题、derivedFrom 和旧版/原件不变；普通 UI 登记独立 Puppeteer 代码及映射确认，派生新固定版；同版正确值/错误值/真实空 sourceRefs 分别产生 pass/fail/inconclusive；结果页两类来源入口；最终真正退出并重开回读。必要时补漏条与重复数据执行。当前不报告这些事项通过。

归还桌面令牌后，已仅依据上述自己导出的 V2 和原始 DOM，在 `independent/workflow/` 编写普通 `run.mjs`、`workflow.json` 与技术提案 `implementation.json`；没有登记、确认或执行。`node --check .../run.mjs` 通过。提案使用 `/paidYuan`、真实 `data-field=amount` / `data-entity` 与显式 `plain-decimal/v1`，不修改 requirement、field 语义或数据规则。三个必测模式及漏条、重复模式由同一份代码的输入选择；`missing-source` 在持久提交中真实传递空数组。此准备工作不构成 U06 通过证据。

## 第二段：修后恢复、复制与数字执行（仍未完成）

2026-09-28 根冻结候选 `42ccf5486e0193b1b904b9e35aa1cf2935b7376d` 后交还桌面。使用公开命令 `npm run demo:product -- --resume=output/product-demo-1790561412653 --port=54291 --record-visible`，只在该 shell 临时添加相同 FFmpeg 目录。新窗口增量 `1771722`；公开 health 为实例 `bdcac427-a067-43fb-b2a4-b0a1c760cd1b`、PID `37076`。此前失败原根与录制原件保留。

原字段未保存编辑在恢复后仍在；重新选择原需求可以成功，保存字段并发布 V3 `060a305f-215f-44ad-96ce-8620f79303f7`（hash 前缀 `a079c31bb25e`）。V3 保留显式解除与新说明，未将它用于三态执行。完整公开字段核对仍待补齐。

为保留原来的示范绑定，普通 UI 从 V2 派生另一草稿 `ad818ebc-af29-477e-a05f-93411a36e649`。重启后该草稿选择原字段，UI 自动选中其需求，显示 `span/node33/event10`、源文本/可见值 `45.00`、number/page-displayed；刷新列表后不变（`ui-1790564084374`、`ui-1790564092776`）。这同时覆盖了真正退出重开后的字段回读。

复制操作存在一次真实使用摩擦：点击复制后仍选原卡；我把原卡 `aa7fb558...` 标题改成“订单金额首样·对照副本”，随后把新卡 `6e7637eb...` 的说明改成“首张结果卡：订单列表共两条，实付金额单位为元。”。跨页后该未保存说明保留，显式保存后经“查看来源”打开 event3 并返回同一卡（`ui-1790564069709`～`ui-1790564081238`）。公开 V4 揭示了标题身份判断错误，本报告保留该错误，不把它归因于复制覆盖原件。

随后另做精确复制核验：选“字段现场示例”原卡 `a02e7ac4-c6ef-472e-b091-84c81db21e67`，复制后直接发布 V5；公开读取确认新卡 `4cd092fa-55e2-4dca-8544-1ff7ca1692b0` 与新注释 `42807fe9-f745-42d5-873b-36ed5391c6bd`。再明确选中列表中该新卡，标题改为“字段现场示例·独立复制核验”，保存发布 V6。V4/V5/V7 的公开对象比较证明：原卡与原注释不变，副本 derivedFrom 保持原卡，副本 anchor 不变，新注释在改标题后不变；需求未变，字段语义与绑定未变。证据 `copy-and-semantic-verification.json`、`check-public-copy.mjs`、`material-v4-public.json`、`material-v5-public.json`、`material-v7-public.json`。封存录制原件索引再次公开读取，四个原件 ID/hash 与第一次一致（`public-original-artifact-index-after-copy.json`）；旧固定版完整回读比较尚待补齐。

| 版本 | 固定 ID | 内容 hash | 用途 |
|---|---|---|---|
| V4 | 99da9375-6c53-4044-b1b2-ed3b58a2f0ca | 4ca8e93b3b51fe112a2137f22ac34c909af47799beebf4f90f6ed0d37b085a94 | 第一复制及说明编辑，5集合计数1/1/4/1/1 |
| V5 | 12d2fcfc-b946-49f0-a462-1167ce5ef537 | 22b030b8962ddcdd91d5ce54cc496f546d1e3e97c1c66b5fab17b9d9b53908e2 | 第二复制，不编辑，1/1/5/2/1 |
| V6 | d5dc5eb7-cc2e-48fd-b5de-c9deae74e3bd | 25ef33e35911d623678b1b2915c24100d2fc4877a1d5f143da467949a49f4a86 | 明确改第二副本标题 |
| V7 | c59de619-da94-4179-8f39-c981509480d7 | 55a5997de33f273be4924a9280deb389e36df4cac62fb18960bb9704bdfe5d5e | 普通 UI 确认技术映射后执行版 |

UI 登记自己的 `independent/workflow`，读取 implementation.json，看到可读摘要：“例证原文45.00、number输出、纯十进制v1、固定URL、实体/orderKey、例证不是每次运行常量”（`ui-1790564309002`）。点击确认保存草稿，再发布 V7（`ui-1790564318481`、`ui-1790564320439`）。此时才有 outputPath/sourceProof；业务要求没有为通过而改变。普通 standalone.mjs 入口与受管入口共用 readOrders；standalone 只做语法检查，此轮受管入口才有真实运行证据。

重新打开环境仍显示已登录及12.00/45.00，且未录制；明确点击“检查登录状态”，出现“已执行只读检查；结果以当前页面为准”（`ui-1790564350877`、`ui-1790564352737`）。应用 loginStatus 仍 unknown，不能宣传机器已判断登录通过。

普通 UI 新签发 execute + read/export 授权，导出 V7 至 `handoffs/cb721185-e024-4052-a696-f6c89010ee28`。task SHA、实例及全部集合经公开 API 核对。正确输入实际执行如下：

- 执行 `4aafbbee-8af6-4ff1-ab4e-fc2fb13a77b1`，run `ae854f4d-2d0c-4a29-ac5c-a767adfece02`；dataset attempt `f1d02a83-899d-4778-8487-3703e8111606`，2条/1批。
- 同版代码指纹 `cdd7c18aa32ca37988952bfe8d75fd45eaffb7b13327f956d7a6d9847d0cbbfa`，输入指纹 `4d5ad0d5d762562998eb61af638d601ec08a15d5556720cbb27586a06ee72413`，前后匹配。
- 正式独立报告 `4c7c93c2-e9f9-4966-b136-54f26addf92c`，overall pass、coverage complete；2条规则、唯一键、number、来源均 pass，实际原文12.00/45.00分别解释为12/45。此结论来自公开 assessExecution，非脚本 assertion；worker旧摘要not-run被如实保留。
- 证据 `public-correct-validation-result.json`、`public-correct-datasets.json`、`public-correct-assess-job.json`、`public-correct-report-requirements.json`、`public-correct-report-datasets.json`。一次误用嵌套validation URL的404也保留，之后按公开文档正确入口读取。

错误值输入尚未得到目标值不一致结论：首跑 `a7ea72be-59ea-4e94-8445-76b035ef887e` / run `a29fe59e-9956-4d81-bb16-80fa51f24ef7` 的 checkpoint49 在10秒后报 host `timed-out/partial/consistent`；正常重试 `22237c77-fd6a-427d-8e42-2f5b02d2d5d2` / run `507a38cc-7865-44f7-9f6f-a545733c04d4` 的 checkpoint57 同错。未提交可评估数据，不将采集失败冒充数字错误 fail。代码/固定资料没有改变。两次结果完整保存于 `verification-wrong-26-validation-20.json` 与 `verification-wrong-retry-26-validation-20.json`。

首跑期间打开了正确结果中心，第二次已请求“返回工作台”；这两次 UI 截图命令也分别明显变慢。只有时间相关性，没有确立因果。2026-09-28 11:07 前后再次停止产品输入并将桌面令牌归还根诊断，保持 PID37076 打开，不强杀、不修资料。当前只读身份见 `public-state-at-capture-block.json`：session `ba41bed1-17be-4252-880c-21a48c9d9476`、lease13、选中 page `e9561d3f-69b3-4520-b1c2-1effb0d54450`。

尚待：采集恢复后的同版数字错误/真实空来源（必要时按最终候选重验三态）、漏条/重复、结果双来源入口、V3和旧版回读、最终正常退出重开。当前依然不报告完整 U01–U06 通过。


暂停期间进一步只读核对：`verify-old-material.mjs` 经当前授权按原始精确 hash 回读 V1 header、V2 header 及全部分页集合。V2与首次公开响应逐对象严格相等；四个原件索引元数据也严格相等。结果 `old-material-and-original-verification.json` 通过。此项现在已补齐，不改变任何固定版本或原件。

## 第三段：恢复可见性后的最终结论

根在独占诊断期间仅使用 sky 检查/激活同一窗口1771722，明确观察到窗口已最小化；恢复可见后只读截图恢复到毫秒级。由谁触发最小化**未核验**，不将结果中心认定为原因。源码和构建仍为 `42ccf5486e0193b1b904b9e35aa1cf2935b7376d`。两次 checkpoint 超时、驱动命令重叠条件及530次缺帧全部保留。功能恢复没有改工作流代码、资料、来源或数据批次。

恢复后完整串行重跑五种输入：启动前每次从公开 state 核对当前 agent 控制、session、原授权页面及租约；前一次 UI/截图命令全部结束，执行中不追加页面截图。全部沿公开 validations → 实际 execution/attempt → 持久 datasets → assessExecution → report 流程，没有使用别的 fixture 或补造 executionId。以下五行使用同一个 V7 与同一个代码指纹 `cdd7c18aa32ca37988952bfe8d75fd45eaffb7b13327f956d7a6d9847d0cbbfa`：

| 输入 | 实际执行 ID | 实际 dataset attempt | 保存报告 ID | 独立机器结论 |
|---|---|---|---|---|
| correct | 45acfa39-2866-4b1f-a30e-c2b28b79748c | af3bc95b-0c56-42cf-9a6f-b090ffa58251 | 44cb205f-e06c-44be-ac29-3d5b4db0dd2f | pass：原文12.00/45.00对应数值12/45 |
| wrong | c86a598d-147c-4625-a70e-1f561d9966e7 | a5b777d9-d100-4e7a-a56c-a79c02f51cfe | 06887d92-9529-489a-9cf3-b3a31287eebb | fail：order-one期望12、实际19，value-mismatch |
| missing-source | 3c6f20a4-73e2-4c2e-860b-d80fa8b206d0 | 95371965-d260-4fa2-9818-aea375f4558c | 5ce5082a-b994-4942-82c2-41803b63feec | inconclusive：数值/条数/唯一性正确，真实空sourceRefs导致source-insufficient |
| missing-row | 1b732caf-b334-413e-850b-203c9ce8df8a | ddfef6a3-f66b-4543-8f72-8a4152f593db | c73af3fe-ff52-41ba-b05d-8dfad0f97eb1 | fail：实际1条，固定要求2条 |
| duplicate | 8d5de1fa-580a-43dc-93ef-d5291fbc9b91 | caa86d63-b602-4ead-ae94-b21637d19b30 | b3e986c9-f5dc-4c52-b67a-5bd09068414c | fail：2条但orderKey重复，unique检查失败 |

各执行的 run、完整资料身份、代码/输入指纹、原始请求响应和报告均在 `independent/verification-*-summary.json` 与相邻逐次公开响应；统一机器核对在 `final-evidence-summary.json`。三种必测输入指纹依次为 `4d5ad0d5d762562998eb61af638d601ec08a15d5556720cbb27586a06ee72413`、`7168bf6c254ee8665267e0dd13f323dabb4350221a13b9cce6028a4184148e53`、`042d06e5635c1ea1395c9e1c8a4ad58b103244cdb2861ef2848892963a09af9f`。漏条执行曾被独立轮询脚本误把正常 finalizing 当作未完成；原返回保留，随后仅续读同一实际执行直至 completed，再按其真实 attempt 评估，未重跑或借别的结果。

U04 的固定 V3 现已独立公开回读，完整 hash `a079c31bb25e15e941b1a1ec6a4497d53fc58b479fd3e06ca90c149a4248d609`。字段仍存在且保留含义、number/page-displayed，不含 target/checkpointId/bindingStatus；原三张卡和普通注释记录仍在。证据 `public-v3-unbound-fields.json`、`public-v3-unbound-checkpoints.json`、`public-v3-unbound-annotations.json`。三态版V7是V2分支，未把V3解绑结果修回以掩盖事实。

结果界面已经实际完成双来源导航，不只是读报告 JSON：

- `ui-1790565498345`：打开重复输出正式报告，看到唯一规则失败与原文/期望/实际值；`ui-1790565510088`：回读实际两个order-one数据行。
- `ui-1790565513012`、`ui-1790565521922`、`ui-1790565524664`：点击“需求示例：字段现场示例”，回到原录制79c8…的event10/node33，回放页显示两条历史金额。
- `ui-1790565544831`、`ui-1790565547546`、`ui-1790565550057`：返回结果再点“本次验证来源”，回到本次run a765…的event6/node27。界面明确展示order-one、dom-712fa283…、plain-decimal-v1、原文12.00/期望12/实际12、实际attempt/batch/record0/outputPath。两入口身份明确不同。

## 最终正常退出与回读

先通过UI“结束并封存”结束最后一个验收run，等到“实时页面·未录制”，再正常 Browser.close。PID37076消失，关闭脚本和demo45312均退出0，第二段视频已完成编码；没有强杀。控制台退出边界仍可见403 closing UI sender，未导致回读资料丢失。

再次用相同公开resume命令与同端口重开，同样仅在启动shell添加FFmpeg PATH。先枚举再识别新窗口593434；health `04722f0f-36e9-4880-9973-08e4f72b6865`、PID13536。重开后：

- `ui-1790565757632`：工作草稿r10、复制后新标题和普通注释仍在；字段仍为number/page-displayed、/paidYuan、plain-decimal/v1、node33/event10及可见原文45.00。
- `ui-1790565765890`：打开V7，完整hash仍55a599…，V1–V7均可见。
- `ui-1790565767979`：九次运行全部封存，包含早期两次采集失败与此前正例，未删除旧失败。
- `ui-1790565790059`、`ui-1790565799169`：从存档选择真实3c6f20a4…执行，保存的5ce508…报告仍inconclusive，数值12/45且来源不足，没有可确认的期望值，也没有“本次验证来源”可用按钮。
- `ui-1790565814807`、`ui-1790565816654`：实际耐久批次两条记录12/45以表格及完整JSON回读；不是重新执行产生。

随后正常关闭PID13536，关闭脚本与demo82889均退出0，进程已不存在；未操作其他窗口。桌面令牌已归还根。最后一段视频编码成功343,686 bytes、94.4秒。

## 验收结论与证据边界

| 旅程 | 最终实际范围 |
|---|---|
| U01 | 空根创建项目/环境；登录未录制；保留环境和重开；明确只读登录检查。环境机器状态unknown如实保留，现场登录有效。 |
| U02 | 实时记录、统一卡片编辑、关联需求、未保存说明跨页保留、查看来源返回同一卡。第一次复制后名称误判作为使用摩擦保留。 |
| U03 | 实时选择页面金额，创建number字段且无需先写注释/proof；当前时刻新例证；编辑/刷新/真正退出重开仍有原绑定。 |
| U04 | 普通元素注释独立存在；选择取消未改原字段；dirty切页保留；显式解除有确认，修后V3耐久保存且保留字段、示例卡、注释记录。侧栏取消/历史选择驱动差异未证明产品缺陷。 |
| U05 | 旧历史event5补点；V1/V2保持；第二次卡片+注释复制后改副本标题，derivedFrom与anchor保留，原卡/注释不变；原件索引和旧V2全量公开读取不变。 |
| U06 | 普通导出与公开API独立实现代码/提案；UI登记及可读确认；V7同代码同版pass/fail/inconclusive；额外漏条/重复真实fail；结果双来源与退出回读完成。 |

本轮**修后合成范围内的 U01–U06 功能闭环通过**。这不等于第一候选从空根一次无中断通过，也不等于长时间连续录像每一帧完整，更不是人工接受所有业务结果。第一段真实产品阻塞、第二段最小化采集失败、驱动误用/轮询错误及中间版本全部保留。没有真实账号验收、全面长测、打包或M2/M3；独立standalone入口未做脱离宿主的运行测试。

原生窗口证据分三段（路径均相对隔离根）：

| 目录 | 实际帧数 | 采样边界 |
|---|---:|---|
| visible-evidence-1790561413957 | 1498 | 首段普通路径及真实U04阻塞；最大相邻采样间隔1684ms；已编码1456.92s |
| visible-evidence-1790563749929 | 1173 | 修后、最小化失败、恢复后五组与双来源；capture-progress记录530次缺帧，整段最大相邻间隔309278ms；不能宣传无缺口连续证据 |
| visible-evidence-1790565741857 | 96 | 最后重开回读；missingFrames0，最大相邻间隔1065ms；已编码94.4s |

恢复后五组证据取 `frame-00826.png`（1790565177634）至 `frame-01004.png`（1790565472729），179帧；missingFrames从530到530、没有新增“来源不可用”计数，但最大实际采样间隔14249ms。因此只能称**恢复后的采样范围无新增缺帧计数**，不能称逐帧无间隙视频。原始 `timeline.json`、`capture-progress.json`、PNG、MP4、UI动作JSON和公开HTTP原文共同保留。

根另外只读校验了原件blob字节hash并诊断最小化，其文件 `output/t1-t3/independent-original-baseline-comparison.json`、`independent-original-blob-hashes.json`、`capture-state.json`、`capture-state-restored.json` 属于**根集成复核**，与本独立上下文的公开索引/固定资料回读及UI操作证据区分，不冒报为独立完成。
