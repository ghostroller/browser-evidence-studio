# E 接续交接（2026-09-26，实施中）

唯一树 `D:\Workspace\browser-evidence-studio\output\refactor-worktrees\20260926-E`，分支 `codex/refactor-e-20260926`，base `dd06e95bd5955902075d3d1f77af1240c8fe4d59`。接续现场 HEAD `2bafbb7bc0bcd6a8795b73543587af18e1cc71d0`；原有 2 个修改及 3 个未跟踪 services 文件保留续写。Node v24.21.0 / npm 11.19.0；独立 node_modules、`output/data-E` 与 `output/npm-cache-E`。没有启动 Electron/桌面/物理输入，没有修改 app.ts 或其他 owner 的文件。

## 首批类型、授权与资料适配

- `TaskAuthorizations` 支持项目离线只读授权，无需活 session/profile/pages；浏览器能力必须绑定 session/profile/page/target/origin，execute 额外绑定真实注册目录。操作数量/有效期/撤销，检查完成与操作注册之间再次同步核对，撤销先 abort 活动再发布事件。
- `ProjectMaterials` 接 B 的真实 FileMaterialService 和 A 的真实 ArchiveReplayService；资料编辑验证全部录制属于当前项目，历史源节点验证不访问实时页。API Agent 只能编辑/发布 Agent 草稿，作者由入口重写，资料修订仍 candidate，不能冒充人工验收。
- `project-dispatch` 提供资料草稿/固定版本摘要、有界 collections/diff、流/位置/历史节点/定位器，独立于 browser operation queue。
- D 使用类型-only `src/main/services/client-types.ts` 和现有 `studio.call`。回放类型约定已交付，隔离 ReplayHost 实现尚在后续包。无需扩大全局 preload 通道。

实际 `npm.cmd run typecheck` 通过；`npm.cmd test -- test/unit/task-authorization.test.ts` 1 文件/4 项通过，444 ms。证明离线授权、错误项目/page/target/origin、check→revoke→run 微任务竞态、活动中止和注册目录变化；不是 Electron 集成证据。

当前未完成：HTTP routes/全入口任务范围强制、实际固定 B/C/F 执行、持久 attempt→recording 映射、隔离原生回放、机器交接与 skill。首包只作为可审查模块/类型依赖，不把 T12/T13 标为完成。
