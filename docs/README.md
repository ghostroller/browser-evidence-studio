# 文档入口

本文件是当前规范与进度的索引，不复制全部实现历史。每次接续只读取当前任务需要的文档。

## 当前任务：工作区、存档与管理交互收敛

- [13：源码审查、对象归属与实施计划](refactor/13-workspace-archives-and-management.md)：本轮目标、明确的代码问题、数据/服务修改、兼容及实施边界。
- [14：交互规格与验收](refactor/14-interaction-spec-and-acceptance.md)：界面归属、动作结果、工作区状态、管理/浏览器行为及验收清单。
- `refactor-handoffs/WORKSPACE-UX-20260929.md`：实施 Agent 在开始/交付时创建并维护的本轮短进度记录；未生成前不视为已有证据。

13/14 是本次用户要求的细化：替代旧方案中将草稿/版本直接混在保存点编辑器里的呈现，以及“本轮只收口旧 M1、不得做管理”的范围限制。原件、隐私、权限、来源核验和固定版本约束继续有效。

## 已有成果与技术约定

- [T1–T3 交接](refactor-handoffs/PRODUCT-T1-T3-20260928.md)及[独立报告](refactor-handoffs/PRODUCT-T1-T3-INDEPENDENT-20260928.md)：旧候选的实际功能验证，不等于新交互已验收。
- [产品设计](design.md)、[架构](architecture.md)、[接口](api.md)、[环境](environment.md)：实施受影响行为时同步修订相应章节，不能长期保留互相冲突的现行描述。
- [进度](progress.md)、[验证](verification.md)：顶部仅保持当前候选/测试摘要，详细证据链接到对应交接，不反复抄写历史。
- [08 产品纠偏](refactor/08-product-realignment.md)、[09 用户旅程](refactor/09-user-journey-acceptance.md)：保留仍适用的任务、来源与交付原则；展示和管理细节以13/14为准。

## 文档完整性

本地存在且由用户提供的 `refactor/11-m1-semantics-and-editing-closeout.md`、`refactor/12-new-session-handoff.md` 等任务输入，检查后按原文纳入提交；不要仅因开始时未跟踪而排除。远端缺少的旧文件不从记忆伪造，也不强制补齐编号空缺。确实不在本机则记录缺失，13/14已足以说明本轮任务。

新的主规范不要无限叠加编号。后续针对本轮的修订直接更新13/14；历史审查保留原意，进度和证据另写。每个通过结论必须能追到实际源码/构建与测试范围。
