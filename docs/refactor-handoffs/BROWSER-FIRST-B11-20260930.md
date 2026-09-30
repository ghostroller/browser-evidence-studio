# B1.1：WorkbenchClient 与 Electron adapter 交接

日期：2026-09-30（UTC）。关联[阶段计划](../browser-first-refactor-plan.md)与[dot 工具链说明](../dot-environment-toolchain-validation.md)。

## 结论与边界

B1.1 已实现：90 个方法的类型化应用契约、唯一 Electron bridge adapter、React client 注入、显式 native presentation 能力和缺桥启动诊断。最终类型检查、构建、定向测试与真实 Electron 工作区／录制／保存点／封存／回放路径通过。

**不能宣布全部桌面浏览器验收通过**：`workspace-browser` 两次候选运行和一次隔离旧基线均在 alert → confirm 前的原生输入焦点断言失败，后半段未执行。该失败不是 B1.1 候选独有，但根因尚未确认；不能直接归因为环境或截图，也未放宽断言求通过。

B1.2 的受保护 HTTP/SSE 工作台连接尚未实现，普通浏览器缺桥时显示明确错误，不提供 fake 工作台。main、preload、dispatch、权限、数据格式与 package/lock 均未修改。

## 实现与审查

- 新增 `src/contracts/workbench.ts`、`workbench-project.ts`，方法名／输入／结果可枚举，不提供任意 string/any 方法 fallback
- 新增 `electron-workbench-client.ts` 与 React `WorkbenchClientProvider`；生产 renderer 的 `window.studio` 运行时访问集中在 adapter
- 保留 body 身份／缺省值、调用顺序、Promise 拒绝和 onChanged 订阅／退订；bounds／presentation 通过 native capability，缺失能力明确失败
- renderer 和测试使用注入 client；新增 11 个契约／启动测试。独立审查修正来源联合类型、合法 null 和 schema 字段的类型保真，未改变后端语义
- 已知债务：`state` 复用旧 Studio DTO，`runs`、`connection`、`active.handoff` 仍有嵌套 any；部分 DTO 仍是 main 的 type-only 引用。此次不是领域 DTO 完全抽离或运行时 schema 校验完成

## 源码和构建身份

测试时为基线 `e785907ad009ab60a1bc115f26c1fc86ecf9f8c3` 加冻结候选工作树；随后原内容分两提交：契约 `2d44fd7`，adapter／renderer／tests `1918012123227655c696c1003c8d2c0c05b0c07f`。提交未改变候选源码，也未重新构建。本交接之后的纯文档提交不改变被测代码身份。

| 身份 | SHA-256 |
| --- | --- |
| 275 个源码／测试／构建配置文件的 manifest 汇总 | `af609a9d3c4c6e03e050601f2caeadc565586488b5524ec6a71549b7e4b0711b` |
| `.vite/build/index.js` | `f4a81113467e18e791f4844fb30fff19b8c664b66d5bc038712350e5e4a7b80a` |
| `.vite/renderer/main_window/index.html` | `607af046f1741aa16a4f71a87876044e9541d7fab7c2ce8eb024a8d64e808940` |
| `.vite/renderer/main_window/assets/index-CrDZDjey.js` | `5823159d7ebd4ea6659d03bbfab26ab9c7ab6fa2b2dc8920c90450a4df2b93d3` |

最终核对代码提交 `1918012` 的 275 个输入文件与被测 manifest 一致，89 个构建文件均未漂移；11 个自有 launcher／Electron PID 均已退出。运行版本：Node 24.21.0、Electron 44.4.3、内嵌 Chromium 152.0.7977.130、Puppeteer 25.11.0、rrweb 2.1.6。

## 实际验证

| 检查 | 最终结果 |
| --- | --- |
| typecheck / build | 均退出 0 |
| 定向 renderer 与边界／client 测试 | 19 个文件、110 项通过；不是全仓库完整回归 |
| blur rename → copy 正反用例 | 成功及失败用例连续 3 轮通过，每轮 2 项；保留 gate、副本数量和指针断言 |
| startup | cold／warm／reload 各退出 0；故障模块阶段按预期退出 1，验证 shutdown-complete；总启动检查通过 |
| workspace-layout | 实际生产 UI 新建项目／环境 → 录制 → 保存点编辑 → 封存 → 历史回放 → 注释 → 复制 → 事件 seek；进程 36521 退出 0 |
| 独立 CDP 观察 | UI/live/replay 为三个不同 target；live/replay 无 UI bridge；业务／回放 viewport 与 UI 容器尺寸相符。证据为分 target 观察，不等于完整原生视觉验收 |
| 退出后磁盘回读 | 1 项目、1 profile、workspace revision 3、draft revision 6、3 个保存点、2 条未绑定元素的注释、1 个 sealed 录制；不把注释数量当作元素绑定已验收 |
| workspace-browser | 候选两次和 e785907 隔离基线一次均失败，见下节；desktop aggregate `passed: false` 保留 |

### 保留的失败与未测范围

1. `workspace-browser` 断言为 `The BrowserWindow must own focus before sendInputEvent`，发生于 alert 已关闭、点击 confirm 前。候选目录为 `output/desktop-1790765222758`、`output/desktop-1790765325343`；隔离基线目录为 `b11-browser-baseline-e785907/output/desktop-1790765484475`，均退出 1。第二次候选无 CUA/CDP 观察也失败，不能归因首轮截图。已确认导航、前进／后退、刷新、失败重试、查找／缩放、标签恢复与 popup；confirm、prompt、定位权限拒绝、下载／取消、allocator 故障及后续实时选择未覆盖，根因仍待调查。
2. 首次普通 shell 测试有 30 个 writer-guard 相关失败；随后在真实桌面执行上下文重跑，最终定向 110 项通过。旧失败日志保留，不能以失败批次替代最终候选结果，也不声称从未失败。
3. blur-copy 首次失败定位为测试初始化时序；测试增加初始 enabled 等待后再验证原有 gate／写入／复制断言。不能声称旧基线原测试因此失败，亦未删除失败历史。
4. 工作区独立观察记录过退出阶段的 `TargetCloseError`，业务测试退出 0；原生焦点失败另记，二者不混为一因。layout 整窗捕获仅首个 empty 状态成功，其余 7 张超时并标记 separate-surfaces；分 target 图及 browser 的 `01-session` 原生整窗图已目视，不代表完整原生视觉覆盖。本轮未运行完整长测、B1.2 或新 provider 验收。

## 证据与后续

后续诊断更新：原生焦点失败已定位为 alert/confirm 的 CDP 回应与 Electron 原生模态框生命周期冲突，详见[独立问题记录](ELECTRON-DIALOG-LIFECYCLE-20260930.md)。本报告保留当时的验收边界；新诊断不将未执行场景改为通过。

完整产物留在本任务仓库同级临时目录，未提交、跨环境不保证仍可访问：

- 最终：`b11-regression-20260930-104350`，含 `source-before.json`、`build-identity.json`、`final-integrity.json`、`desktop-result.json`、`persistence-readback.json`、定向／重复／基线结果与分 target 图
- 早期失败：`b11-regression-20260930-103440`
- 旧基线：`b11-browser-baseline-e785907`，独立构建和数据根，不覆盖候选构建

后续按阶段计划进入 B1.2 前明确配对／会话身份、最小工作台权限与事件重连契约，不能直接把现有 Agent API 改为高权限 UI API。同时保留并定位原生 focus 失败；未查明前不取消断言或将未执行半段标绿。新代码修改后重新核对源码、构建和受影响路径，本报告的通过只对应上述冻结内容。
