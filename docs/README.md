# 文档入口

本文件是当前规范与进度的索引，不复制全部实现历史。每次接续只读取当前任务需要的文档。

## 当前任务：浏览器优先工作台与双宿主渐进重构

- [共享设计页面正文](sources/browser-first-shared-design-body.md)与[来源说明](sources/browser-first-shared-design-source-notes.md)：导入可见设计原文；页面声明的三个原附件尚未取得，正文转载不能替代原件。
- [dot 环境工具链验证补充](dot-environment-toolchain-validation.md)：当前 Electron 集成路径、临时 HTTP/SSE 拆分探针、真实公开 SPA、版本身份、安全边界和可复用测试入口。工具链可行不等于浏览器版已实现或产品验收通过。
- [浏览器优先重构计划](browser-first-refactor-plan.md)：当前阶段与下一步的规划入口，细化 B0–B4 的依赖、交付、验收与迁移边界；首个实施切片为类型化 WorkbenchClient 与保持行为的 Electron adapter。
- [B1.1 实现与实际验收](refactor-handoffs/BROWSER-FIRST-B11-20260930.md)：类型化 client／Electron adapter 的源码、构建与通过范围；同时保留原生 focus 失败及未测部分，B1.2 尚未实现。

本轮先让共享工作台具备低成本的真实 UI 反馈，再按阶段证据扩展受保护的浏览器连接、共享回放与独立 Node/Chromium provider。保留现有 Electron 路径，不因架构重构擅自更改下列产品语义或旧 profile 数据。

## 既有产品基线：工作区、存档与管理交互

- [13：源码审查、对象归属与实施计划](refactor/13-workspace-archives-and-management.md)：工作区与管理的产品目标、代码问题、数据/服务修改、兼容及实施边界。
- [14：交互规格与验收](refactor/14-interaction-spec-and-acceptance.md)：界面归属、动作结果、工作区状态、管理/浏览器行为及验收清单。
- [工作区实施与分层验收](refactor-handoffs/WORKSPACE-UX-20260929.md)：该轮历史进度入口；顶部是9月30日截图反馈后的布局/CSS与字体补修，含实际源码/构建、IA01–IA30、失败记录和启动方法，不是新重构已通过的证据。

13/14 继续作为产品行为基线：替代旧方案中将草稿/版本直接混在保存点编辑器里的呈现，以及旧轮次“只收口旧 M1、不得做管理”的范围限制。原件、隐私、权限、来源核验和固定版本约束继续有效。

## 已有成果与技术约定

- [T1–T3 交接](refactor-handoffs/PRODUCT-T1-T3-20260928.md)及[独立报告](refactor-handoffs/PRODUCT-T1-T3-INDEPENDENT-20260928.md)：旧候选的实际功能验证，不等于新交互已验收。
- [产品设计](design.md)、[架构](architecture.md)、[接口](api.md)、[环境](environment.md)：实施受影响行为时同步修订相应章节，不能长期保留互相冲突的现行描述。
- [进度](progress.md)、[验证](verification.md)：顶部仅保持当前候选/测试摘要，详细证据链接到对应交接，不反复抄写历史。
- [08 产品纠偏](refactor/08-product-realignment.md)、[09 用户旅程](refactor/09-user-journey-acceptance.md)：保留仍适用的任务、来源与交付原则；展示和管理细节以13/14为准。

## 文档完整性

本地存在且由用户提供的 `refactor/11-m1-semantics-and-editing-closeout.md`、`refactor/12-new-session-handoff.md` 等任务输入，检查后按原文纳入提交；不要仅因开始时未跟踪而排除。远端缺少的旧文件不从记忆伪造，也不强制补齐编号空缺。确实不在本机则记录缺失；13/14仍是对应历史产品任务的基线，新重构另按上方来源与计划复核。

新的主规范不要无限叠加编号。本次架构与开发反馈使用上方固定名称的计划及工具链补充；涉及产品行为的修订仍应核对13/14，不能借搬层静默改变。历史审查保留原意，进度和证据另写。每个通过结论必须能追到实际源码/构建与测试范围。
