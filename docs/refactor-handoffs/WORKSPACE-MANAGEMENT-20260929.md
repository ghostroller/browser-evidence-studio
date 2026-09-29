# W2 项目与环境管理实施交接 — 2026-09-29

## 身份与范围

- 起点：`32ec24406096c322005c544521f3ec957aa41809`，隔离工作树 `workspace-management`。
- 本包仅新增项目/登录环境管理服务、真实 UI 组件、定向回归和本交接。Studio/dispatch/App 集成由主任务唯一 owner 完成；没有编辑共享 schema、package/lock 或资料服务。
- Git 信任通过单次 `git -c safe.directory=...` 使用，没有改全局配置。复用根 checkout 的 node_modules junction，没有安装或更新依赖。
- 没有启动 Electron、合成站点、浏览器或桌面测试。没有操作账号、原件、登录 partition 或其他进程。

## 已实现

`src/main/services/workspace-management.ts` 导出 `WorkspaceManagement`、`Project`、`Profile`、`WorkspaceManagementHost`、`ManagementDependencies`。

- 单一 `workspace.json` 的 candidate → atomicJson → 发布数组事务；成功前不改变宿主数组。保留原 manifest 的其他字段和旧 profile storageRef。
- `createProject` / `updateProject` / `createProfile` / `updateProfile`，名称、目录简介、入口/说明/高级检查配置均实际持久化。
- `manageProject`：archive / restore / delete；`manageProfile`：disable / restore / delete。更新/生命周期使用 `expectedRevision`，UI 给每次逻辑命令稳定 operationId；已落盘但响应丢失时按原回执重试，不复制对象。
- 登录配置变更增加 configRevision、使当前 loginStatus 回到 unknown；上次检查时间、来源和 checkedConfigRevision 保留以明确旧结果。只改名保留登录状态/partition。
- `commitProfileState(profileId, expectedConfigRevision, patch, operationId?)` 供宿主检查/保存/打开结果落盘。检查的配置过期时拒绝，不用迟到结果覆盖新配置。允许 patch 的字段明确列举，不能经此方法改 storageRef 或配置。
- `managementDependencies` 区分活动 session/run/execution/authorization 与保留的历史引用。空删除扫描项目资料目录和完整 runs/executions/authoring/validations 元数据，不依赖前端第一页。文件缺失、损坏、归属未知不作为“空”的证明；旧环境无完整使用记录时只能停用而不能冒充未使用后删除。
- 路径身份校验、逐层目录符号链接拒绝、单文件读取预算。不存在任何物理清理或递归删除操作。

`WorkspaceManagementPanel` 提供搜索、停用/归档筛选、创建与改名、简介与配置编辑、设当前浏览、归档/停用/恢复、依赖预览及空删除二次确认。活动对象提供明确的停止/封存/关闭选择；普通管理不隐式结束现场。错误保留表单和 operationId；切换管理对象前要求保存或明确撤销输入，旧表单以原 revision 做 CAS。当前浏览项目与活动 session 项目不一致时显示归属提示。

## 主任务集成契约

1. Studio 删除本地 Project/Profile interface，改为 type import；初始化 `management = new WorkspaceManagement(this)`，并提供 `taskAuthorizations(projectId) { return this.tasks.list(projectId); }`。宿主已有 root/projects/profiles/state/onChanged 满足其余接口。
2. `init()` 在 root mkdir 后调用 `management.init()` 替换旧 workspace 手工读取。createProject/updateProject/createProfile 和新增的 updateProfile/manageProject/manageProfile/managementDependencies 委托模块。
3. 新管理命令只向可信 UI 开放。HTTP 的材料授权不能升级为项目/环境管理授权。管理生命周期与 browser open/start 需在 Studio.serialized 内执行；外部资料创建也应使用相同项目/主队列边界以免空删除扫描与新依赖创建相撞。
4. 已有脚本目录登记 `updateProject` 必须加入 `expectedRevision: project.revision ?? 0` 与 operationId。既有 create 调用建议携带稳定 operationId。
5. 所有 profile check/save/openedAt 落盘走 `commitProfileState`，停止使用会先改数组和覆盖整个 workspace 的旧 `save()`。打开成功记录 openedAt；落盘失败清理本次新 session。checkEnvironment 使用 expectedOrigin（配置）和 checkOrigin（实际检查来源）两个不同字段；确认可见元素和预期站点，错误/关闭/超时不得保留旧 verified。
6. 新 activity（openEnvironment/startRun/authorizeTask/validate）拒绝 archived project 和 disabled profile；旧历史读取仍允许。
7. 新增可信 UI 包装 `settleManagementDependencies({projectId,profileId?,expectedSessionId:string|null,authorizationIds:string[]})`：重读/核对受影响范围，拒绝陈旧 session/授权集，撤销这些授权，停止执行，显式封存活动录制，关闭匹配 session。不要停止别的项目的现场。该动作仅由依赖确认区的明确按钮调用。
8. 实际入口渲染 `<WorkspaceManagementPanel state={state} projectId={projectId} onSelectProject={dirtyAwareSwitch} onRefresh={refresh} onError={setError} />`。onSelectProject 可以返回 Promise，父层仍负责工作副本脏编辑的切换协议；管理组件内部只管理目录表单。

## 实际验证

2026-09-29，Node v24.21.0、已有依赖，执行：

```powershell
node node_modules/vitest/vitest.mjs run test/unit/workspace-management.test.ts test/renderer/workspace-management.test.tsx
node node_modules/typescript/bin/tsc --noEmit
```

结果：2 文件 / 30 测试全部通过，TypeScript 通过。测试使用真实临时目录、atomicJson 和真实管理服务；组件通过可见表单触发实际服务，故障注入位于持久化边界。临时目录全在忽略的 output 下，没有提交测试资料或日志。

| 矩阵 | 本包证据 | 尚需主任务 |
|---|---|---|
| IA14 | 服务及组件：创建即改名、归档/恢复、完整依赖检查、确认空删除、重启状态/固定内容不变 | 新构建 Electron / 独立使用者 |
| IA15 | 服务及组件：改名/配置/停用/恢复、partition 字符串保持、配置失效、陈旧检查拒绝、活动依赖明确确认 | 实际账号会话持久性、宿主 check/save 与新构建 UI |
| IA17 | 服务及组件：create/update/lifecycle 写失败、同 operationId 重试、响应丢失后重启、CAS、脏输入切换 | Electron 目录实际物理故障未注入 |
| IA18 | 服务及组件：A session 不阻止 B 浏览/改名，UI 归属横幅且不隐式关闭 A | App 实际入口与现场采集归属 |
| IA30 | 本包交接/源码/测试入同一可验收包 | 根任务文档与最终矩阵 |

未宣称 IA01–13、IA16、IA19–29 的本包通过；无独立使用者结论，无新构建身份。最终交付与新构建、窗口大小/可达性、T1–T3 和旧 hash/partition 实机证据由主任务合并后完成。
