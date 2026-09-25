# 重构状态（S0/G 独写）

更新：2026-09-26。总规范是 refactor/01-modification-plan.md；本表区分已验证原型与生产集成，不以提交数量计完成。

| T | 依赖 | owner | 状态 | 实际范围 / 接续 |
|---|---|---|---|---|
| T00 | 无 | S0 | verified | 基线/共享契约/协作规则已提交；真实 rrweb 源信息、选择、原始结构及定位器风险原型通过；生产能力由 A 接入 |
| T01 | T00 | S0 | verified | session 保留/续录、导航/显式关闭、两种执行模式真实专项通过；无关 busy 下停止与跨启动状态目标校验测试通过 |
| T02 | T00/T01 | A | not-started | 采集通道预算、分段、耐久 barrier、源序列与分类 gap |
| T03 | T00/T02 | A | not-started | 资源字节/manifest/blob/离线网络边界，先复用实际响应 |
| T04 | T02/T03 | A | not-started | 有界随机回放、eventSeq seek、释放/竞态、资源接入 |
| T05 | T00/T02/T04 | A | not-started | 生产原始属性 hook/隐私策略/frame mapping/定位器；S0 spike 不是生产功能 |
| T06 | T00 | B | not-started | 项目资料草稿、冲突、不可变 revision、差异、旧档只读投影 |
| T07 | T04/T05/T06 | D | not-started | 历史 checkpoint 创建、编辑、复制和注释 |
| T08 | T05/T06/T07 | D | not-started | 字段 UI、历史选择、去元素 tab、蒙版 |
| T09 | T00/T01 | C | not-started | step/attempt 依赖、独立失败、真实取消及有条件重试 |
| T10 | T00/T09 | C | not-started | 批次持久化、幂等、部分输出与分页声明 |
| T11 | T06/T09/T10 | F+D | not-started | 固定用户资料验收、独立来源证明和结果视图 |
| T12 | T01/T06/T09；历史读接 A | E | not-started | 任务授权、后台目标读取、撤销；保留人工确认边界 |
| T13 | T06/T11/T12 | E | not-started | 固定版本交接、差异和订阅 |
| T14 | 持续 | S0/G | implementing | 本轮 161 项、S0 专项、最终 19 进程矩阵通过；此前间歇 UI 风险记录保留；新架构长测仍待 A/G |
| T15 | 全部接入 | G | not-started | 安装包、独立交付、新 Agent/真人与完整长测 |

接入顺序：S0 冻结 → A/B/C 分别提交可验证模块 → owner 按依赖合并 → D/E/F → G。A/B/C 不由 S0 擅自开始实现，用户在实际目录启动；启动提示与数据根见 refactor-handoffs/S0.md。每包独写自己的 handoff，不修改本表。

当前未测项：跨源 frame、Shadow/Canvas、精确同毫秒回放、结构缺口恢复、离线资产、30 分钟新 session 连续分段内存、安装包及真人站点。既有资料原件没有迁移；生产 recorder 的 checkbox value 遮罩缺口由 A 按 S0 原型证据处理。
