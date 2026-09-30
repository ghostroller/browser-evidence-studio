# 项目管理与存档交互重设计

日期：2026-09-30 UTC。基线 `5b4cc219e99c3ffaa0206925eb6d502f6a4e5205`，开局工作树干净。用户指出项目与环境管理、存档的交互和布局存在明显问题，要求重新设计、实际测试，并替换导航和关闭的字符按钮。

## 当前状态

重设计实现已完成并冻结，最终冻结候选的实际桌面上下文typecheck及48文件396项（renderer全目录与指定管理／资料／workbench边界）通过；Electron／Node双构建、新完整桌面旅程、既有workspace-layout和完整双宿主纵向均通过。以下旧界面实测是问题证据，B4通过不自动覆盖本轮UI变更。

## 已实际观察的问题

旧构建 Electron entry SHA256 `0e5391490fa3384208025a6237aab2fc56bdba9d4dc0be8c9a2e64629acfb258`，合成实例 `02318b9a-fdef-4ca4-b195-9bf1848f2832`，PID135846。UI为本地构建的main_window/index.html，未配对的独立Vite浏览器收到源码HMR不属于此次旧界面操作。

- 改项目名称但未保存，点击“返回工作台”后直接关闭，重新进入时输入丢失。旧组件内部切换有dirty检查，但外层关闭绕过了它
- 新建项目中的“撤销项目输入”只清空输入，仍停留创建表单，没有真正取消创建
- 管理页目录、多组表单、项目动作与环境动作纵向堆叠，全宽保存按钮和分离的复选框／标签缺乏清楚层级，大窗口仍浪费空间
- 源码确认版本标签／备注、工作副本名称和录制目录metadata在onBlur写入；用户只点别处就可能保存，且并发／失效状态反馈不统一。真实存档走查另补
- 基线快速交互：开始录制后约130ms点击新增保存点，active尚未刷新，触发第二个“开始录制并创建保存点”原生确认。准确窗口实际取消后继续诊断，不把它错误归因为永久录制死锁。保留时间边界失败，不修改原生对话框交互求通过

证据保存在 `../ui-management-proof/baseline/`，含截图、准确入口、操作报告和失败记录。基线初次命中背景同名按钮也是测试定位错误，保留并改用当前对话框作用域。

## 设计约束与预期

### 项目与环境管理

项目目录与选中对象详情分区；任一时刻只展示清楚的项目详情、环境详情或创建状态。分别显示“正在管理”“当前浏览”“正在使用”，查看别的项目不转移已有session。搜索／过滤不把正在编辑的对象偷偷换成另一条。

创建、保存、取消、返回具有一致语义。取消创建回到上一级，不写入空对象；保存失败保留输入。切对象、返回、关闭、Escape和快捷入口均经过统一离开检查，不能从外层绕过dirty或pending状态。生命周期动作与普通编辑分层，检查依赖／可恢复归档不与永久清理混淆。

### 存档

资料版本、原始录制、工作副本保持独立清楚单位，使用目录／选中详情结构；打开只读固定版不把它堆在仍可编辑的工作副本上。目录名称与备注明确为sidecar，使用显式保存／取消；不改原始录制、固定内容或hash。重命名、隐藏／恢复、比较、派生和设当前保留原有CAS与身份语义。

异步动作按项目编辑会话及选中对象关联，离开后旧成功／错误不能覆盖新上下文。保存期间禁止重复动作；冲突保留本地输入并提供权威重读。缺失、损坏、隐藏和空列表分别反馈。详情滚动不让主要导航和保存／返回消失，也不产生横向溢出。

### 图标

现有依赖已含 `lucide-react`，直接复用，不新增图标库。统一导航后退／前进、刷新／停止、关闭标签／提示等图标按钮，保留明确aria-label/title、焦点样式、disabled和原动作作用域。图标不代替必要的业务文字。

## 验收计划

- 管理：创建／真正取消、改名／保存／取消、dirty关闭及Escape、对象和项目切换、selected与live归属、错误／重复动作／迟到响应
- 存档：版本只读、显式sidecar保存与取消、对象／子页切换、隐藏／恢复、工作副本派生和当前副本、原始录制引用／诊断边界
- 图标：可访问名称、可见焦点、禁用状态、前后导航和关闭不串目标
- 布局：1450与1100宽度、长名称／目录、空／加载／错误、独立滚动、双宿主共享界面
- 数据：原始录制和固定版hash保持，旧profile身份不迁移，权限／来源语义不放宽

真实业务资料用正常UI产生；单元fixture与桌面证据分开。先定向测试，再最终源码实际双端回归；未跑的完整平台和长测不宣称通过。不跑Docker或GitHub CI，不修改旧Electron alert/confirm生命周期行为。

## 实现收口与保留的早期失败

- 快捷新建项目／环境复用管理表单，保留未改变上下文时成功即选中并回工作台的行为；手动导航到其他项目后取消quick intent，防止跨项目选中错误profile
- 管理外层关闭、Escape与内部导航同一dirty保护，继续编辑或明确放弃；提交中同步互斥，失败保留输入
- MaterialArchivePanel共享目录/详情，RecordingArchive显式保存并按项目generation隔离迟到响应；当前目录和发布确认状态不跨项目编辑会话继承
- Electron存档布局临时扩大，不重挂载工作区；普通workspace与workspace-archive分别保存用户布局，返回/打开来源恢复原比例，后端白名单同步允许新偏好键
- 版本标签保存与UI基线使用同一名称规范化，避免服务端trim后界面误报相同；发布确认必须完成或明确取消后再离开
- 使用既有Lucide IconButton，aria-label/title/focus/disabled保持；新desktop phase仅在既有BES_TEST机制内使用，不新增生产控制接口

命令执行命名空间的首轮67项26过/41失败，多数为已知OS writer guard不可用，不能作为产品失败统计；保留原始记录。实际桌面首轮75项68过/7失败，分别为旧mock缺少真实summary.status、异步准备尚未完成即断言、共享错误文案前缀变化。补齐fixture契约与等待，不移除业务断言；随后扩大集合48文件392项全部通过，证据 `../ui-management-proof/gate-round2/result.json`。

## 当前桌面验证与视觉修正

前三轮新旅程分别保留在 `output/desktop-1790798165630`、`output/desktop-1790798449511`、`output/desktop-1790798785303`。这些是不同实际构建／测试身份，不能拼成同一轮无失败通过。管理dirty关闭/Escape、正常UI创建取消、提交前一次性拒绝和重复点击、renderer真实reload后的迟到失败隔离、19项目长目录、环境编辑／无效URL恢复／停用恢复／storageRef保持，以及浏览其他项目不换live归属已实际成立。

- 首轮中断：测试误把已导航的入口页当作无后退历史。修正为核对真实canGoBack/Forward，并在新建空标签检验两个按钮禁用；随后真实同profile/page/target前后导航、键盘焦点和关闭恢复通过
- 第二轮中断：测试自行要求存档宽度超过70%，与已选66/34和右侧min400不符。改为实际宽度扩大且满足两侧约束，不改变产品布局凑测试
- 第三轮记录：正常UI发布V1、显式metadata保存、隐藏reload恢复、派生、12次副本复制、移除恢复及录制提交前拒绝/重试通过；最后reload后未等bootstrap完成就点击分类，测试漏等待导致超时，保留并补准备状态判断
- 实际存档拖拽只写workspace-archive比例，workspace未变化；进入/返回不重建编辑器，普通比例恢复；取消发布不新增版本
- 独立视觉复查发现分类切换沿用旧外层scrollTop，分类导航存在滚出视野的可达状态。该1450截图具体发生在1100原生滚到底部检查保存/取消后再调宽；初到1100时分类nav可见，但存档标题处于旧滚动位置上方，不能宣称每次切分类必然截断。管理新建最后一项目时选中目录行也可能不可见。已作为真实交互缺陷集中修正，不把截图无水平溢出等同完整UX通过

人工故障注入严格限定BES_TEST现有方法的一次性提交前拒绝/延迟，正常UI仍是所有业务写入的发起者，finally恢复。记录该机制不等于自然生产故障。真实录制/固定原件保持，最终hash与完整结果待下一冻结候选核验。

## 第五候选的门禁收口

滚动修正后新增回归曾先因测试未定义变量停止typecheck，再得到395项中393过／2失败，原输出保留。两项暴露初始化可操作性边界：项目bootstrap状态在effect后才更新，外层tab存在短暂可点窗口；浏览器来源下拉只含placeholder时亦可能短暂可点。最终按project归属同步推导初始化状态、pre-paint报告busy，来源目录未具备实际选项时禁用选择并明确空态，既有grant与来源身份不放宽。

`../ui-management-proof/gate-round5/result.json`：48个实际testResults文件、396项全部通过，typecheck通过。文件数按testResults计数，不把含嵌套suite的numTotalTestSuites当文件数；早期392项同样是48文件，不是51文件。最后候选还包含不在输入／背景刷新时抢滚动、可见上下文复位、目录选中项可见、原生tab加载反馈等断言。

## 最终新旅程实际结果

`output/desktop-1790799713390/management-archive-detail.json`：passed=true，PID143900，20:21:53.990–20:24:43.901 UTC，15阶段完成并正常exit0。原始录制和固定V1文件hash均不变。具体身份：

```json
{"projectId": "45d0db38-f83e-4ca4-97b3-f788b272241d", "profileId": "ff08c283-0cb4-4c56-bffd-f5d0346061b8", "recordingId": "a3702e10-7b05-49c0-ad2b-588f5e14d9ff", "fixedRevisionId": "d00ddb42-aeb2-4650-8703-c78925c962db", "fixedHash": "e4ecda5905a2bab24982d2d67861779f371ae1015eb1e69c35b3a5f7dc600009", "dataRootRelative": "output/desktop-1790799713390", "uiFileRelative": ".vite/renderer/main_window/index.html"}
```

完整包括：管理dirty关闭／Escape／放弃、取消创建无落盘、提交前拒绝与pending重复点击、真实reload迟到错误不泄漏、19项目长目录与新建选中项可见；环境取消／改名／非法URL／停用恢复、浏览和live归属隔离；SVG导航真实back/forward、空标签禁用、键盘焦点、关闭恢复；正常示范→保存点→封存→固定版，sidecar显式保存、隐藏reload恢复、只读／派生和12份UI复制副本；录制目录pending/拒绝恢复、隐藏reload恢复、使用位置和真实native回放ready。

1100×760与1450×935原生窗口检查无水平溢出；CUA原生滚到底时分类nav仍可见且按钮真实hit-test可点，切分类复位。拖动仅写 `workspace-archive=[62.879,37.121]`（该轮观察值），`workspace`未变，返回的原比例与同一编辑器DOM保持。人工故障注入与真正UI操作分别记录，pageErrors/dialogs为空。

根目视核对最终管理和固定版本截图并向用户交付原始renderer图片。它们不是原生整窗合成：独立live网页surface不在renderer截图中，实际可见桌面另有CUA观察；未将媒体整窗捕获超时说成成功。

## 最终结果

限定范围验收完成。最终实际源码/测试/构建647项逐文件核对零差异，清单文件SHA256 `98c4bdd16692f7c300228850c8e65c7b7189fd315505d1c3289b6469a965c03f`，证据 `../ui-management-proof/dual-host-round1/source-manifest-after.json`。运行时HEAD为基线加本轮dirty候选，提交不改变已验文件字节；当前源码身份不能误写成旧基线已运行新功能。

| 最终检查 | 结果与证据 |
| --- | --- |
| typecheck / 相关回归 | exit0；48文件396项通过，`../ui-management-proof/gate-round5/` |
| Electron / Node构建 | exit0，`../ui-management-proof/build-round7/` |
| 新管理／存档真实旅程 | 15阶段通过、exit0，`output/desktop-1790799713390/` |
| 既有workspace-layout | exit0，`output/desktop-1790799944757/`；quick创建、录制／回放、编辑／复制、1100/1450/2100布局及原生焦点／Tab |
| 完整双宿主 | `../ui-management-proof/dual-host-round1/result.json` passed=true，语义comparison=true，源码/构建前后不变 |

双宿主实际20:27:20–20:28:13 UTC。Electron instance `f585a64c-7bf9-4559-afeb-f3bf7e5e5bc1`，entry SHA256 `dc0afa495e67d7b121abb0e723277b1200c9f4c950085cdb4198019aae589f60`；Node instance `b5107ef4-5a2e-4d08-b19f-bce1b44a6116`，entry SHA256 `49bf07794ef3a4b307b231d91dea3ff15cd121c9867fc0b59b5daf8b801a840d`。Node后端入口字节与前轮相同不代表UI未变，共享renderer变化由完整647项清单绑定。

两端正常UI造资料、原始历史13.00精确节点绑定、固定版与刷新回读、实际live14.00工作流和明确dataset attempt核验均通过，正确／错值／缺来源的overall和source都分别pass／fail／inconclusive。保留独立source/target/固定hash身份，仅对已验证生成ID作语义比较，未拿历史例值代替新运行原件。各自launcher exit0、provider退出，原件与固定版保持。

工作区媒体整窗截图后端仍存在超时，按既有fallback保存renderer和native surface；真实CUA整窗观察不等于生成了可下载整窗合成。已交付两张明确标记的renderer截图。旧Electron alert/confirm生命周期未改；本轮不声称完整workspace-browser旧矩阵、长测、跨平台、真实账号、全部网站、Docker或GitHub CI通过。product-journey/ui-scenarios/workspace-browser的本轮修改是共享quick-create定位适配，未完整重跑这些入口；所运行入口以本表为准。

UI路径和视觉检查通过不代替用户对体验的认可。后续只在用户反馈或实际新问题范围内继续，不自动扩展重构阶段。


## 可复验命令与提交节点

```sh
npm run typecheck
npm test -- test/renderer test/unit/workspace-management.test.ts test/unit/workspace-catalog.test.ts test/unit/materials.test.ts test/unit/material-source-contracts.test.ts test/unit/material-enum-validation.test.ts test/unit/ui-preferences.test.ts test/unit/managed-browser-controls.test.ts test/unit/workbench-*.test.ts test/unit/browser-*-client.test.ts
npm run build
npm run build:node
node test/desktop/launch.js --management-archive
node test/desktop/launch.js --workspace-layout
npm run test:dual-host -- --chromium=/absolute/path/to/chromium
```

代码与可执行测试节点 `77e0489`，与最终已验文件字节一致；随后仅文档整理。分包为 `b6c1b09` 共享图标／布局、`d906771` 管理组件、`cfbecc8` 存档与入口集成、`77e0489` 真实桌面回归／定位兼容。最后通过既有HTTPS Git非强制发布并独立读远端SHA核验，工作树状态以实际交付记录为准。

证据总览 `../ui-management-proof/final-validation-summary.json`。所有本轮自有测试进程／窗口已退出，旧demo及无关Chromium未触碰。未提交合成profile、原始录制、日志、构建或截图到Git。
