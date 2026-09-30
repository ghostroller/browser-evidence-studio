# B1.4：浏览器只读结果与剩余 B1 验收

日期：2026-09-30（UTC）。实施基线 `a7d3a13f3027d3d162426ec3314224c71a57fb16`。真实浏览器attempt5、可见HMR补验attempt6与最终Native冒烟完成以下限定范围。不能将功能通过外推为完整旧资料／原生对话框矩阵通过。

代码分包：`48ba574` scoped只读结果合同／后端／实际读盘回归；`d3f08bd`共享结果组件／浏览器入口／恢复测试。测试期间为基线加未提交源文件，提交后全源码及构建哈希逐项核对一致。

## 实现范围

浏览器复用现有 `ResultCenter`，由 `ResultWorkbenchClient` 提供七个只读方法，并通过独立的 `projectExecutions` 有界列表正常选择执行。真实 `ProjectExecutions` 读取执行、步骤、数据集／批次／记录与已保存报告；不允许浏览器启动执行、生成报告、保存人工判定或调用历史节点接口。Electron 原生委托继续提供原功能。

新增 `project-workbench` 由可信 UI 明确配对，包含既有资料权限与新只读结果；旧 metadata／materials 授权不静默扩大。结果区和资料编辑器并列呈现，浏览结果不重挂载丢弃未保存资料输入。首次读取失败有明确错误和重试，切换执行／报告／数据集时沿用身份与请求代际检查。

结果请求16 KiB／24层／8192节点；集合1–28 KiB、1–100项；单执行／报告摘要64 KiB。列表最多2000目录项／8 MiB描述，单binding16 KiB、host-state2 MiB；只读列表不建立目录或修补状态。结果投影省略环境路径、批次文件路径、原始异常及stack，保留业务JSON值、缺失字段语义和来源引用；不承诺任意业务值脱敏。原始异常详情仍在Electron端。

固定报告除hash外须核对完整host binding、workflow attempt和嵌套结果身份；步骤／数据集顶层须属于当前execution。blocked步骤的历史依赖引用可以合法指向旧execution，不把它误当当前结果行而拒绝。

## 已发现问题及修复记录

1. 初始诊断正则不能安全处理JSON引号凭据和Basic头。原始步骤异常改为浏览器固定安全提示；Validator三条异常reason路径在浏览器投影固定说明，未改共享Validator或Electron原始错误语义
2. 原report只核project／execution／reportId／hash，缺少完整固定binding与嵌套归属。补充拒绝自洽hash但错误material/code/attempt及混入其他execution的结果行；合法数据另需实际回归
3. 新renderer fixture按JSON文本查找，但组件默认表格。改为正常点击“查看完整JSON”，并修复结果／资料并列区域的重复React key；不降低业务值断言
4. 冻结后独立读盘发现真实非空批次入口失败：新port将含projectId／分页字段的完整body作为DatasetIdentity传递，底层receipt严格比较导致冲突；records下一页还因cursor混入查询身份导致失效。此前mock定向及报告回读测试没有覆盖此正路径。暂停GUI后已收窄为固定三字段身份并补真实批次／两页记录回归；独立纯读盘复验非空receipt、两页recordIndex0/1、fields／missingFields／null／entity通过，篡改批次仍拒绝。原失败候选不记为通过

独立报告三入口共15项错误binding／attempt／嵌套身份反例均被拒绝；正常业务reason、actual／expected和业务JSON值保留，Native原reason不变、报告文件读取前后字节不变。

## 验证状态

- 首候选typecheck、11文件107项定向通过；最终type-only Native委托收窄后typecheck／diff-check通过
- 桌面真实writer上下文2文件11项通过，含combined结果刷新保留dirty资料、真实workflow／Validator报告经port回读；该轮未覆盖非空批次port，不能抵消上面的独立失败
- 批次修复后typecheck、3纯模块33项、桌面真实writer上下文2文件11项及完整build重新通过。独立审查确认此前未变部分9文件96项与client4项，不将这些有重叠的测试数相加冒充全库总数

## 最终 attempt5：真实浏览器与双实例

2026-09-30 13:46:07–13:46:43 UTC，正常Native UI建立项目、录制并封存本地合成业务页。浏览器从sealed来源创建卡片／字段／普通注释、复制、发布固定版本并派生当前副本；同companion正常UI登记本任务脚本、执行两次并保存报告，再明确配对 `project-workbench` 从列表选择执行。没有预造被测执行／批次／报告，浏览器自身不执行或生成报告。

- 成功步骤执行 `b2946659-2ea4-4153-9bb3-72ed068ead28`，报告 `79517764-9c56-49ba-8756-edcccb396418`；真实orders批次读取到 `order-one`、`amount:"12.00"`、`optional:null`
- 失败步骤执行 `13e606ed-47ae-405e-ae77-13fa1526e3f9`，报告 `2a35882a-ac4e-44ba-96ff-62fc93ae7eb9`；浏览器显示failed步骤和安全说明，Native仍显示合成原始异常
- 两次执行的宿主状态都是completed，后者有failed步骤；两份报告总评都是inconclusive，不能把“结果读取通过”写成“业务验收pass”
- 两份报告均绑定固定资料 `87023416-d3af-4e53-b8ba-5c1612c7b6a6`，hash `d5bda7991680e493b7e598a4b34f28c2c66229e829ac696294108f87268e1887`；旧materials配对不提供结果入口
- 延迟旧execution响应，随后选择新execution，释放旧响应仍不抢新选择；网络中断进入stale并暂停读取，经“刷新授权项目”恢复；独立500注入显示读取失败，经正常重试恢复，不伪装为空列表
- 默认／字段／固定只读／结果与错误状态在1450×935、1100×760取证，无横向溢出；关键按钮经实际命中，包含滚动操作。0 pageerror
- 首次临时CSS自定义变量在165ms内观察到，performance.timeOrigin不变；随后观察默认保存点／固定只读／错误结果三状态，正常编辑保存点说明并磁盘回读。独立复查发现outline选择器未命中容器，因此165ms仅是变量探针，不能算可见样式验收；另补真正可见header样式。原字节恢复，没有旧同条件时长，不声称提速倍数或三次独立HMR计时
- 同一工作树同时启动两个全新实例，分别拥有数据根、前后端端口、instanceId、发现文件及隔离浏览器profile；两端正常UI写入互不串写，关闭A后B仍能保存。不声称两个工作树已测

### 保留的 GUI 测试失败

attempt1脚本requirements为空，被既有manifest检查拒绝；attempt2核对器误把report envelope当正文；attempt3仍期待浏览器显示已按安全契约移除的原始错误正文；attempt4将网络stale提示与局部500读错误混为一项。这四次记录保留，分别修正测试输入／读取假设／契约断言／故障分类后，同一产品构建运行attempt5。没有为此放宽产品安全或通过隐藏写补造结果。

### 可见 HMR 补验 attempt6

2026-09-30 13:49:27–13:50:02 UTC，以同一未改产品构建、fresh-root正常启动再走短合成流程。将实际主内容容器背景临时改为浅蓝 `rgb(232,246,250)`，computedStyle与截图均确认可见；单次修改到观察为96ms，timeOrigin不变。随后依次查看默认保存点／固定只读／错误结果三状态的两个尺寸，正常编辑与磁盘回读成立。测试结束原CSS逐字节恢复，不把一次测量外推为稳定性能指标。

该轮固定资料 `996e06a9-0a38-41be-95a6-b4834c09ff3e`；执行 `6e465de5-746f-4144-adab-a4fcd05590a6`／`79babe19-e501-4340-ba3d-0515a54078ca` 分别对应报告 `67ecc1ef-8e44-4e61-a4ab-8c9a9adf9945`／`affa0907-9bb7-41fa-8707-a2fc78a9b011`。独立核磁盘完整binding与workflowAttemptId一致，两报告仍inconclusive，双实例隔离再次通过。

A PID73441、B PID73808均正常app-quit／shutdown-complete／exit0；只关闭本任务实例，不触碰既有demo或用户浏览器。原录制仅核manifest／integrity／首journal文件hash与artifacts索引缺席状态未变，不声称遍历全录制资源树。

### 源码、构建和运行身份

验收时HEAD仍为基线加本轮未提交源码，sourceDirty=true，不能冒称干净提交；提交后核对源字节一致。

- main bundle SHA-256：`3fad49268d3bd335a1d13bdb07bfa81f75a96daf9c4481148a3998b4a4534486`
- Native renderer `index-cB57eFhm.js` SHA-256：`0ad079f960fef6daf5d5735787ecc5a318c0f9fb9e1d9b7c3cd0d415473b6032`
- Native CSS SHA-256：`8f3811ea0031c02f9f575a60417d4a0fe4b078c527f209b6db7a2f458fd9ff13`
- harness SHA-256：`08c6ca8fdfa27040b83190fb9ce27afc169f879274ce62907814f1a41f7c6ffa`
- A instance `eb993447-7c59-4fda-9771-859a2028b225`，当次浏览器URL `http://127.0.0.1:43863/browser.html`；B instance `467dbcb3-c92a-480b-b45c-fdbfbe92ece9`，URL `http://127.0.0.1:45457/browser.html`

两者均为electron-companion。这些是证据中的历史地址，退出后不可继续使用；重启 `npm run start:workbench` 获取新URL和新合成实例。临时 `b14-proof/attempt5` 保存结果、harness、截图和独立核对，不将测试输出或凭据纳入Git。

最终Native严格layout `output/desktop-1790776080452` PASS、exit0。全src／test／scripts／相关config最终清单为 `b14-proof/source-final.json`（SHA-256 `1a031c159b973d54d45905530fe0e2cc97b54850156aacbe7ddbcf36e90000de`），开始时源码清单为 `b14-proof/source-before.sha256`，包括新增result相关文件；result.json内旧四文件字段只是补充，不能当作完整源码清单。

## 收益、边界与下一步

当前浏览器能以真实DOM／样式／请求完成资料编辑、固定版本和结果读取，普通表单及只读页面无需OS坐标；独立实例可并发，Native仍负责初始录制／执行和旧历史回放。一次CSS热更新无需重建Electron或重复录制，已经形成可操作的B1反馈循环，不是空壳预览。

完整原生modal／旧资料兼容矩阵、长文本与所有故障组合尚未全验。结果页主要运行／报告身份仍以稳定ID呈现，无业务名称的数据不伪造名称；用户易用性认可不等同于功能测试通过。Electron旧对话框问题继续记录，本轮不改变交互。

B2为共享隔离Web回放与节点选择，B3为纯Node／外部Chromium完整链路，尚未实施。本节点先交付可用浏览器工作台、真实证据及收益判断，再按原设计扩展门决定是否进入B2；不把当前companion称为独立Node后端。
