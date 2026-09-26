# Review 实验边界

`repro-close-and-budget.cjs` 在 Node v22.16.0 中运行，输出见 `result.json`。

1. 关闭实验抽取了 `046a52e` ReplayHost 的 open/lifetime/closeActive 控制流，说明无效旧 close 在抛错前修改了全局 lifetime，因此能取消另一个合法 pending open。没有实例化 Electron 或执行项目真实 UI，不能据此证明它是本地桌面矩阵三次失败的共同根因。
2. 体积实验按当前导出的 checkpoint 投影结构生成 250 张卡片，只算这部分漂亮打印 JSON，已超过实际 manifest 的 64 KiB 上限。没有调用完整 export 服务；它证明体积约束问题，不能当作端到端导出测试。

本地 Agent 应在项目的真实依赖和环境中增加回归，再实施修复。脚本不修改任何用户仓库、原始录制或 profile。
