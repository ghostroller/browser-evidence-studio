# B1.3：浏览器真实资料工作区与验收

日期：2026-09-30（UTC）。实施基线 `90e2a67`。最终 attempt3 通过本节限定的 F07 真实资料纵向；完整 B1、F08 故障矩阵及 B2/B3 尚未完成。

代码分包：`755f13d` 共享严格枚举校验；`c139f78` scoped material 合同／后端／测试；`688d7b3f62278fa8493172a4be799a21325d1d18` 浏览器资料 UI／client／回归。验收当时 HEAD 仍为 `90e2a67` 加这些未提交源文件（sourceDirty=true）；提交后源内容未变，不冒称当时是干净提交。

## 范围与运行

浏览器复用原 `MaterialWorkbench`、真实 `ProjectMaterials`／`FileMaterialService` 和同一个 writer，支持工作副本、任务说明、保存点、字段、纯文字注释、复制、固定版本、比较及派生编辑。新增窄资料 client，不伪造完整 Studio.state；Electron adapter 原90方法保留，采集恢复、原生来源检查、实现映射及封存仍由原生委托使用。

匹配 Node 24.21.0／npm 11.19.0 后执行 `npm run build`、`npm run start:workbench`。每次启动输出新的实际浏览器 URL 和全新合成根。先在 Electron 正常 UI 准备项目及 sealed 来源，再选“本项目资料编辑与发布”配对，浏览器点击“打开项目资料工作区”。本轮测试实例已正常退出，历史 URL／票据不能作为继续运行入口。后端仍是 **electron-companion**，不是独立 Node provider。

来源选择器只列同项目已封存录制，通过既有 streams／positions 取得真实文档流和事件位置；新增卡片冻结当时所选 anchor。历史回放、元素选择和节点预览明确需要 Electron。未开放原始资源、profile／目录、实时采集、seal 或 Agent 权限。

## 权限、预算与领域边界

- 默认 `project-metadata` 仍只读写项目名／简介，旧 grant 不能调用资料方法。新 `project-materials` 由可信 UI 明确选择，固定 instance／project，并说明初始化工作副本及目录修补的写语义
- 票据和会话沿用单次交换、短时和撤销边界；浏览器未提交输入及操作身份仅在会话内存，断开／失效清除。没有任意 `dispatch(source='ui')`，也没有放宽 Agent API
- 21方法固定 allowlist；材料请求64 KiB、24层／8192 JSON节点、响应256 KiB，集合仍1–28 KiB／1–100条。metadata 保留16 KiB原始请求限制，即使当前是资料 grant
- 包络／方法／编辑字段严格校验，实体关联复用原 validator。所有枚举须为合法字符串；共享 validator 七处旧 `String(enum)` 已修，非法旧数据校验失败但不转换／改写。数组 `['bound']` 不能跳过来源核验
- FileMaterialService 读入口及目录准备前检查权限，实际 writer 锁取得后、业务 operation 开始前再次检查。读后排队的编辑不能沿用早先授权；已开始原子写可完成，取消不冒称回滚。catalog／列表／working ensure 的返回资料仍在过期时扣留，即使已发生目录修补
- 内容引用和创建／复制／发布收据恢复快照均复核同项目 sealed 来源；恢复保留原 receipt、ID与hash。原始录制与固定版本不被改写
- 来源列表只读描述文件，最多2000目录项／8 MiB描述字节，单 manifest 最大1 MiB。预算不足或资料损坏返回错误，不能伪装为空数据

## 通知、输入和成功写的后续动作

实际领域落盘触发资料失效，不依赖 project.revision；正常 catalog／列表／ensure 无新写时不通知自己。稳定资料读取错误不触发 metadata→资料的循环读取。

stale、写入及回读期间禁用编辑／快捷键／外层导航／来源控件。外部更新先读取完整有界投影，再复核修订与编辑／选择代际，之后无 await 地一起采纳；途中输入保留原值与原 CAS baseline，不重挂载编辑器覆盖输入。

edit 没有 operationId，不自动重试。丢响应要求读取服务器结果并明确核验，不能拿新 revision 重放卡片复制。创建、工作副本复制和发布沿用既有 operationId／原参数收据。

attempt2 暴露 create 已确认后，自身 SSE 的短暂 stale 阻止 setWorking。修复只在真实成功 ack 后使用同 session generation／project 的5秒 ready 屏障：优先等已有权威读取，必要时最多一次 metadata 只读 preflight，再继续原动作。成功 ack 不因后续读失败改写；部分完成明确说明已创建／是否设为当前。未放宽 stale／离线／过期／撤销的新写，也不重发业务写。

## 分层验证与保留失败

- 后端真实领域17项、material dispatch12项、共享枚举7项及旧材料／传输回归通过。普通 shell 曾因既有 Unix writer guard 限制失败；改用已可用桌面上下文复验，没有修改锁
- 审查先复现再修复：收据恢复绕过 sealed scope、读取过期仍返回、伪枚举跳过 target verifier。合法 bound 正对照实际调用目标核验，缺失元数据返回不可绑定；伪数组在输入校验即拒绝
- GUI前完整整合最终为42文件328项、327通过，单一新 fixture 过早点击。保留此前两项同类失败；测试改为逐个等实际目标可见、无 disabled／inert，再单击，未放宽正确ID／同operationId断言。外层导航可点但动作被pending拒绝的真实反馈缺口另由 onBusyChange 修复
- bounded-ready修后：浏览器资料隔离8/8、全部 renderer 与三个 client 共23文件151项、typecheck及完整 build通过。没有重新冒称42文件全库、无变化后端大套或旧长测全部重跑
- attempt1 的派生判据仅看baseRevisionId，原草稿发布后也有该值，其通过判定撤回；Native旧输入保护也不能直接算服务端CAS
- attempt2 同构建严格复验是真失败：create HTTP200、新草稿落盘，之后0次setWorking；20秒后current仍旧，UI提示工作台暂不可用。未重复点击或用内部接口修指针

## 最终 attempt3：人工核实的真实纵向

2026-09-30 13:03:59–13:04:21 UTC，正常 Electron UI 建项目并录制／封存本地合成页面，没有预造被测卡片、字段或版本。真实浏览器完成：

1. metadata配对无资料能力；重新显式资料配对，从同项目sealed精确位置创建卡片、字段和纯文字注释
2. 卡片复制返回不同ID并聚焦副本，原卡不被改写
3. 发布丢响应后显式恢复：两次publish使用相同operationId和expectedDraftRevision=6，只有同一个固定revisionId／hash
4. 派生仅1次create、1次setWorking；新draftId不同于父工作副本，catalog.current／UI／刷新回读一致，后续正常UI编辑只落到新草稿
5. 浏览器刷新重配后固定版及派生回读一致；编辑丢响应不重放，读取核验后继续；断网保留输入，恢复后保存
6. Electron旧输入实际收到领域CAS冲突（本地r3／当前r4），未覆盖浏览器新值；Electron UI再回读同一固定hash、字段说明与注释

字段编辑、固定版只读、派生工作副本在1450×935和1100×760均无横向溢出，记录控件命中、滚动和截图。0 pageerror，自有进程 `shutdown-complete`。固定版本manifest/hash不变；录制仅核对 `manifest.json`、`integrity.json`、`journal/events-000001.jsonl` 的SHA-256，以及 `artifacts.jsonl` 仍不存在，不宣称对全部原件逐文件重验。

### 身份与证据

- main bundle SHA-256：`a113f7866da08f06cf5b290fc32c7234b12ab5974bbeceb01567cb5c4a5e7443`（最后修复仅renderer，main未变）
- 最终 Native renderer `index-Mep9nBeq.js` SHA-256：`500494cfa1789d7d8fc77f3890fa3977b3cfcd49863494db4962fc37f777119b`
- 最终 CSS SHA-256：`067a731c33f9ac0eb07ddd81ec512c1c3d17ab48d23fe785de04863a2e2fd2cd`
- `attempt3/source-manifest.json` SHA-256：`a4eb864d375d2b6acf5b5a1d86f86a388e919c97813b70c46687835d6e7f912a`

本地临时 `b13-proof` 保存三次尝试、源码／测试清单、安全method/status记录、截图与人工核验摘要；不作为Git附件。票据／会话凭据未进入这些报告或截图。startup cold／warm／reload及预期失败检查通过；修复前严格layout `desktop-1790772302135` 通过。最终ack修复后的同构建严格Native layout `desktop-1790774009626` 再次通过（exit0）：3尺寸无溢出，焦点／Tab严格断言通过，`shutdown-complete`；源文件／测试／scripts及整个 `.vite` 前后SHA未变。日志为 `attempt3/workspace-layout-final.log`。

## 尚未覆盖

F07仅上述scope通过；完整B1仍缺只读结果、F04并发实例完整隔离、资料三场景HMR与同条件反馈耗时证据。F08仅定向CAS、丢响应、收据恢复、断线及锁后撤销，不是全部物理故障矩阵。完整长文本／加载错误／modal Esc、跨浏览器和旧资料矩阵未全验。B2历史回放／元素选择仍需Electron，B3独立Node/provider未扩展。旧Electron alert/confirm问题继续记录并保留失败门禁，本切片未更改。
