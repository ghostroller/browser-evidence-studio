# S0 现状核对（2026-09-26）

起点：`8175d4b4d8fefeb37c463571f8cc4fa7ae689429`，main，唯一已有 worktree 是主集成目录 `D:\Workspace\browser-evidence-studio`。初始 `git status --short` 只有 `?? docs/refactor/`，两份用户规范未编辑；本次将其原样纳入工作包提交以便隔离会话读取。没有 stash/reset/删除录制或 profile。

输入 SHA256：01-modification-plan.md `9045a6b4b3ca7b4ee5dd1d35acbbc2734cf503b1bd222f566751852b9fecae0b`；02-codex-execution-guide.md `ae1ba1cad8903a26f5334afad067c9598b66d63d73df8263c7f201375c84cc5b`。锁文件 `1bc31ce0aa0da894c9bcba36dedd0061fad42503f83bea19d0f1449833a4b704`。

## 环境与命令

实际 Node `v24.21.0` / npm `11.19.0`。安装文件与 lock 一致：Electron 44.4.3、Puppeteer-core 25.11.0、rrweb 2.1.6、Forge 7.11.2、Vite 8.3.0、React 19.3.0、TypeScript 7.0.2、Vitest 5.0.1。本次不升级依赖；既有 30 分钟和 155 项旧记录不代替本轮复验。

Git 在受限账户报 dubious ownership；仅对本仓库/本次工作树逐命令使用 `-c safe.directory=<实际目录>`，不修改全局信任设置。Git 写入与 Electron 桌面运行使用获准的正常权限。测试数据均由 `test/desktop/launch.js` 在主目录 output 下新建，保留 BES_TEST 对正式 app data 的隔离守卫。

日志根：`output/refactor-s0-20260926/`（忽略目录，本地保留）。

| 命令 | 本轮起点结果 | 日志/产物 |
|---|---|---|
| `npm.cmd run typecheck` | 通过 | baseline-typecheck.log |
| `npm.cmd test` | 26 文件 / 155 项通过，67.89 s | baseline-test.log |
| `npm.cmd run test:desktop`（受限账户） | 构建成功；Electron GPU 子进程 -1073741515、renderer ERR_FAILED，未跑到场景 | baseline-desktop.log；output/desktop-1790362965758 |
| 同命令，正常权限 | M0/原件协议及 UI 布局通过；深色存档关闭后 native view 未恢复，12 s 原断言失败 | baseline-desktop-elevated.log；output/desktop-1790363029532 |
| 同命令，增加只读可见性失败诊断 | 上述 UI 路径本次通过；runner cancel 后一次 validation 启动身份校验失败（409） | baseline-desktop-diagnostics.log；output/desktop-1790363324628 |

两次正常权限失败不能算全套基线通过；没有降低断言、跳过 UI 或扩大超时。第一项 UI 问题在第二次未复现，不能据此宣称修复。后续修复/复验记入 S0 handoff。

## 旧修复与仍需实现的边界

下表源码位置均对应起点，后续行号会改变。

| 类别 | 已有行为和本轮证据 | 未满足的新目标 |
|---|---|---|
| UI 存档/检查 | app.tsx:56/93/127/157 的请求代际、目标身份；coordinator.ts:143 连续点击拦截；相关 renderer/capture 测试本轮通过 | app.tsx:206 全局 busy 禁用停止；缺后退/前进/刷新。原生界面恢复存在本轮间歇失败 |
| 浏览器/run | studio.ts:109–117 每 run 新页导航；302–304 seal 实际 remove/close | 停录保留页与不导航续录尚无；validate 406–409 自动重建，只保留 URL，不能称当前 DOM 原位试跑 |
| 采集预算 | coordinator.ts:32/34/89 默认 4096 B 估计、256 项/32 MiB 共用队列 | 大 response 真正 Buffer 未进入估值；丢弃只有计数，无 stream 区间及分类；结构缺口不自动 checkout，归 A/T02 |
| 原件/恢复 | store.ts:50/123/159/170/177 哈希、长度、缺失核验；222 每条 append sync；writer-lock OS 身份；相关测试本轮通过 | group commit/分段新格式尚无；不因优化撤销已确认耐久承诺 |
| 资源/回放 | 二进制正文 excluded；生产 replay 是主文档前缀，最多 16 MiB；CSP 阻外部资源 | 无资源字节 manifest、精确位置游标、历史源属性与定位器；归 A/T03–05 |
| 资料 | requirements 在 workflow.ts；示范基线只在 React demoId state；字段/卡片已有材料原件可读 | 无项目 draft/revision；B/T06 只能只读投影旧材料，不回填缺失事实 |
| 执行 | manager.ts:118/263 原始错误优先，emitData 已即时写 artifact；stop 等 worker terminate；cancel 原生场景在第二次桌面中通过 | 同名 dataset 不可批追加、全量 records 留内存、无 step/attempt 依赖隔离；验证启动存在本轮目标代际竞态，不能降低 guard |
| 权限 | snapshot 已在 READ，不要求 controller=agent；dispatch:31 目标校验、63/65 人工判定/交还只允许 UI；单测通过 | 后台页选择仍是写操作；任务级授权/资料确认尚待 E，不能扩 HTTP 人工入口 |
| 打包 | Vite 已构建 runner-worker；Forge 白名单未包含 skills/docs/examples | 安装版交接资源、独立产物及真人验收不在本轮通过范围 |

## 风险原型最初运行

`npm.cmd run test:integration -- --refactor-s0` 第一次因新阶段遗漏白名单失败，补齐白名单后第二次进入真实 rrweb，隐私断言发现 recording 含敏感 fixture 值（prototype-second.log）。原断言保留，不能删 fixture 值获得绿色结果；实际修正及最终结果见 handoff。

本次原型是短时合成页面，完整生产录制/离线资源/跨 frame/同毫秒 seek/30 分钟增长和安装包均须继续验收。受限执行账户启动失败、正常权限实际场景失败和新原型实现错误分别记录，不互相替代。
