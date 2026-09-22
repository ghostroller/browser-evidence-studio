# 实际验证记录

更新日期：2026-09-23，Windows x64。本页记录实际执行结果；设计文档中的其余目标不自动视为完成。自动化回归仅面向本机合成数据。未修改旧仓库，未把任何运行材料、Cookie 或 profile 放入 Git。

## 统一源码别名（2026-09-23）

收到前端完成交接后，将根 paths 统一为 `@/* -> ./src/*`，三份 Vite 配置启用原生 `resolve.tsconfigPaths: true`，shadcn 五个 aliases 使用 `@/renderer/...`。源码/测试共 55 文件、125 处导入字面量改变，另外调整 5 份配置；独立复核确认每处仍指向原文件，其余源码逻辑、运行时路径及前端改动保持原样。package.json 和锁文件字节未变，后者 SHA-256 仍为 `aaeca20cd2ca57f8d6bbac8c9e67a03c35bbfacc8d49b5acfe6d39de445b2c9c`。未迁移 Vitest。

实际环境为 Node **24.21.0** / npm **11.19.0** / Vite **8.3.0** / TypeScript **7.0.2** / Electron **44.4.3**。统一实验目录为 `output/alias-validation-1790104668534`，以下日志均位于该目录，除非另列完整相对路径。

| 命令 / 场景 | 实际结果与材料 |
| --- | --- |
| 隔离目录内固定 shadcn CLI 4.21.0：`info --json`、`add button dialog sidebar --dry-run`、`add button dialog sidebar --yes` | 配置解析、预览、实际生成通过；9 个组件/Hook 文件和 8 处 `@/renderer/...` 导入符合预期。`fixture-paths.json` 与 `*-result.json` 记录结果；CLI 直接联网未通过，成功依赖下述受控 registry 转发。 |
| fixture 中 `npm.cmd run typecheck`、`npm.cmd run build` | 实际导入生成组件后类型检查与 Vite 构建通过；`fixture-typecheck.log`、`fixture-build.log`。只在 fixture 安装依赖，没有把这些新增依赖加入产品。 |
| 根项目 `npm.cmd run typecheck`、`npm.cmd test` | 类型检查通过，**102/102 测试通过，0 失败、0 跳过**；`typecheck.log`、`unit.log`。 |
| `npm.cmd run test:integration` | 三个 Vite 产物构建成功；首轮主进程 PID **20424** 在布局拖动断言失败，`output/desktop-1790105742693/desktop-summary.json` 为 passed=false，后续进程未运行。 |
| 同一构建执行 `node test/desktop/launch.js` | **19 个 Electron 进程完整矩阵通过**，`output/desktop-1790105788982/desktop-summary.json` 为 passed=true；主阶段 PID **30696**，profile 重启 PID **27828**，五种强杀边界的重开/重复重开及两个退出场景均通过。日志 `integration-recheck.log`。 |
| `npm.cmd run start`，独立 `BES_DATA` / `BES_TEST=1`，清除 `ELECTRON_RUN_AS_NODE` | Forge 开发模式完整主阶段通过，Electron PID **22716**，退出 0；`forge-1790105985597/test-result.json` 与 `runtime-check.json`。实际 URL `http://localhost:8246`，HTML、`/@vite/client` 均为 200，同端口 HMR WebSocket 收到 connected；只验证连接，没有通过改源码触发一次热更新。 |
| `npm.cmd run package` | 成功生成当前源码的应用目录，日志 `package.log`。使用既有 Electron ZIP，已重新核对 SHA-256 为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`；该值与此前核验的官方清单一致。未运行 make 生成分发 ZIP。 |
| 新包 `out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe`，独立 `BES_DATA` / `BES_TEST=1` | **打包主阶段通过**，实际 PID **28016**、退出 0、shutdown-complete；`packaged-1790106170900/test-result.json` 与 `runtime-check.json`。覆盖真实 renderer/preload、runner 五变体、人工交接、HTTP、checkpoint 与恢复界面；此轮包未单独复跑 profile-restart 或强杀矩阵。app.asar SHA-256 为 `7a6b1381dd3cf6c1f0ccd0175961f9e041b771b1ccc529995de5d086ee637639`。 |

首轮拖动失败保留为失败：事件记录在 pointerdown 与后续按住移动之间插入一个 `(601.714, 302.286)`、`buttons=0` 的 pointermove；这不属于测试主动发送的横向序列。react-resizable-panels 4.13.2 收到无按键移动会将拖动状态设为 inactive，解释了布局未改变。同一构建、未改源码或断言的重跑及后续 Forge 主阶段通过。额外事件来源未确认，不能宣称该偶发问题已修复，也不能归因为别名解析。

shadcn 的成功实验使用其支持的 REGISTRY_URL 指向本机转发服务，逐字节转发官方 `ui.shadcn.com/r/...` 响应并记录 SHA-256；只临时调整 CLI 子进程的 loopback 代理环境，没有改写响应、全局代理或 TLS 校验。CLI 直接访问 registry 的等待问题仍未解决。tooltip 终端帮助中的 `@/components/ui/tooltip` 没有跟随配置改写，生成文件则正确；详见 [路径方案与实验](import-alias-plan.md)。

preload 当前没有本地别名导入，其构建与真实桥接通过不等于额外验证了该导入场景。CSS 内也没有使用 `@/`。本轮未重跑 20 分钟长测、独立 Edge 示例或真实账号流程；Windows 物理鼠标跨原生视图的命中路由仍未验收。构建存在既有上游指令、source map、chunk 大小及 Forge 旧选项提示，未借本次路径迁移调整依赖或优化包体。

## 前端重构与窗口 IPC 修复（2026-09-23）

先完成 [frontend-refactor.md](frontend-refactor.md)，再实施紧凑左右布局、默认亮色/可切暗色、可拖动主分界与保存点/元素/执行/证据分界。项目/profile 创建、存档恢复与完整证据阅读使用 Dialog；移除首字装饰图标和多层卡片。主题与布局保存在独立 `userData/ui-preferences.json`，不写入 run 证据。录制、控制权、部分采集、回放、验收、人工评审和恢复继续使用既有业务接口。

实际执行环境为 **Node 24.21.0 / npm 11.19.0 / Electron 44.4.3**，不限 Node 版本管理工具。shadcn CLI 4.21.0 `add` 未完成且原因未确认，停止后改从官方 `new-york-v4` registry 手动引入 13 个组件源码，并保留 MIT 许可与来源说明。没有把 CLI 尝试计为安装成功。实际新增组合为 Tailwind / Vite 插件 **4.3.3**、Radix UI **1.6.7**、react-resizable-panels **4.13.2**、Lucide **1.47.0**、class-variance-authority **0.7.1**、clsx **2.1.1**、tailwind-merge **3.7.0**、tw-animate-css **1.4.0**；原 Electron/React/Vite 版本未升级。本次锁文件实际字节 SHA-256 为 `aaeca20cd2ca57f8d6bbac8c9e67a03c35bbfacc8d49b5acfe6d39de445b2c9c`。

| 命令 / 场景 | 实际结果与材料 |
| --- | --- |
| `npm.cmd run typecheck` | 通过，日志 `output/frontend-typecheck-final.log` |
| `npm.cmd test` | **102/102 通过，0 失败、0 跳过**；日志 `output/frontend-unit-final.log`。新增可信 IPC 销毁/身份边界、偏好校验/写失败恢复及 UI 专用接口隔离检查 |
| `npm.cmd run test:integration` | Vite 构建及 **19 个 Electron 进程**矩阵通过，`output/desktop-1790104067949/desktop-summary.json` 为 passed=true；主阶段 PID **6540**、profile 重启 PID **31992** |
| `npm.cmd run start`，独立 `BES_DATA` / `BES_TEST=1` | Forge 开发模式完整主阶段通过，PID **42952**，报告 `output/frontend-forge-verified-1790103892599/test-result.json`；包括此前失败的首次截图/普通点击、被拒 UI 导航、布局、业务与恢复场景。随后尺寸观察器重绑修复另由最终生产矩阵覆盖 |
| `npm.cmd run start`，另设 `BES_TEST_PHASE=exit-app-quit` | 最终源码的开发启动、首次完整 checkpoint 和连续退出专项通过；`output/frontend-forge-exit-final-1790104259777`，PID **37036**，`exit-reentry-verified` 确认两份材料与一次清理，`shutdown-complete` / exitCode 0 |
| `npm.cmd run build` | 开发模式专项结束后重新生成生产产物成功，日志 `output/frontend-build-final.log`；无后续源代码修改 |

19 进程保留原主阶段/profile 重启、五种强杀边界各三进程、连续关窗与 app.quit 两项。布局场景增加默认亮色、亮暗切换与偏好重载、真实 Electron `sendInputEvent` 的指针/键盘调整、已确认发生的原生失焦、1100 × 760/最大化、恢复默认布局后内容自身改变尺寸，以及被拒导航保留原文档。原生视图与蒙版对 DOM 边界误差不超过 2 CSS px；布局/主题不改变页面身份、controller 或 lease。弹层/拖动遮挡分开合成，采集中仍能取消；普通 Puppeteer 点击在设置弹层打开时继续执行，关闭弹层不会解除 agent/checkpoint 输入锁。新项目/profile 由真实 React 表单创建，新项目不再显示旧项目的保存点或启用旧证据入口。

本轮定位与修复：

- 用户报告的 `Object has been destroyed` 来自 `studio:bounds` 对已失效 window/frame 的访问。可信 IPC 检查先核对存活，再读取精确 sender/mainFrame/URL，并捕获销毁访问异常；退出期间忽略迟到 bounds。最终矩阵包括窗口重载、业务 renderer 崩溃、页面销毁及连续退出，未再出现该主进程异常。
- 开发尝试曾出现首次截图 `UnknownVizError`（DOM 已保存）及普通点击超时，不能因 Forge 外层返回 0 而算通过。`output/frontend-forge-navigation-1790103744543/exit-capture-diagnostics.json` 记录 `did-start-navigation → will-navigate → did-stop-loading`、无提交，旧 UI 仍在，但提前清空的就绪状态令浏览器持续隐藏。现仅在 `did-navigate` 实际提交后重置，拒绝导航保留旧布局；完整开发主阶段及最终退出专项均通过。诊断中重试截图成功不抵消首轮失败，临时重试代码已删除。
- 恢复布局会重建 DOM 占位，现同时重绑 ResizeObserver；布局恢复后工具栏内容改变高度的回归通过。清除重复原生 bounds/visibility 设置，避免逐帧不必要的原生更新；拖动失焦后不会通过迟到消息抢回焦点。

最终截图目录为 `output/desktop-1790104067949`，已视检亮/暗录制、最小窗口、空项目、材料阅读与恢复界面。`ui-light.png`、`ui-dark.png`、`ui-minimum-dark.png`、`ui-evidence.png` 是限定当前测试窗口的真实媒体帧，包含原生视图；该方式后续取帧超时时，保存明确标注的 `*.renderer.png` 与可用的 `*.browser.png`，`*.capture.json` 记录 `separate-surfaces` / `compositeAvailable:false`，不将分层图片拼接冒充整窗截图。空项目、暗色材料和亮/暗恢复截图可按这些文件名查看。

**范围限制：** `sendInputEvent` 直接投递到 Electron renderer，不等同于 Windows 物理鼠标从分隔条跨入原生视图的命中路由，后者仍待人工体验检查。未重跑 20 分钟长测、独立 Edge 五变体、重新打包/生成 ZIP 或真实账号流程。构建仍有上游 `use client`、source map、chunk >500 kB 与 Forge `inlineDynamicImports` 提示，未据此声明体积优化完成。历史 ESM 专项和历史包的验证结果不替代本节的新界面验收。

## ESM 模块迁移（2026-09-23）

根包改为 `"type": "module"`，Forge 与 Vite 配置迁至 `.ts` 并纳入类型检查；main、runner worker 和 renderer 输出 ESM。Electron sandboxed preload 仍从 TS ESM 源码打包为单文件 `preload.cjs`。运行时资源/worker 位置使用 `import.meta.dirname`，登记脚本使用原生动态 `import()`；桌面启动器和故障测试子进程也改用 ESM。未降低 sandbox/contextIsolation。

迁移实际运行环境仍为 **Node 24.21.0 / npm 11.19.0 / Electron 44.4.3**。本次模块变更本身没有调整依赖版本。开发启动记录是在同时应用动态端口修复的工作树上取得，模块格式迁移与端口修复为独立变更。

- `npm.cmd run typecheck` 通过，含四个根配置；`npm.cmd test` **94/94 通过，0 失败、0 跳过**。
- `npm.cmd run test:integration` 的 Vite 构建及 **19 个 Electron 进程**完整矩阵通过，报告 `output/desktop-1790101014732/desktop-summary.json`。主场景 PID **37720**、profile 重启 PID **28576**，均退出 0；五种强杀边界的两次重开/新 run 复跑和两个退出清理场景均通过。
- 该次构建的 SHA-256：`index.js` 为 `ea7778b2016d5ecefe4c441bfb1fc7662674b08fcb88c78ec220b7aba06a4a11`，`runner-worker.js` 为 `1af5acfb48e309d35ef063dfa584f17bb1a8392f1fc4df8a6ed8ca2bf88a0dc4`，`preload.cjs` 为 `313be288f1dae26ecd0bef48c0bae9e1e8c2e1069099b98c29cc478598ba3418`。

随后完成模块专项开发/打包验证：

- 设置独立 `BES_DATA=output/forge-esm-1790101319212`、`BES_TEST=1`、`BES_TEST_PHASE=exit-app-quit`，清除 `ELECTRON_RUN_AS_NODE` 后执行 `npm.cmd run start`。Forge 加载 TS 配置并完成开发构建；Electron PID **30308** 保存 `ui-ready`、`exit-reentry-verified`（两份 checkpoint 材料）和 `shutdown-complete` / exitCode 0。这是开发启动与退出场景通过，不标为完整主阶段测试报告。
- 核验本机 Electron ZIP 的 SHA-256 仍与安装包官方清单一致（`790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`），将 `ELECTRON_ZIP_DIR` 指向 `output/electron-cache/97c4824d52fa18e59ceb86513ea4d84a0cb0a407b42cff72f0fdb998616bb008`，执行 `npm.cmd run package` 成功。
- `node test/desktop/launch.js '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe' --recovery-only` **17 进程专项矩阵通过**，报告 `output/desktop-1790101407643/desktop-summary.json`。覆盖五种强杀位置的重开、新 ESM worker 实跑、重复重开，以及两种完整退出清理；此命令明确没有运行 packaged main/profile-restart 阶段。
- ASAR 内核对 `package.json` 的 `type=module`、主入口、ESM main/worker 和 `preload.cjs`；摘要保存于 `output/forge-esm-1790101319212/package-modules.json`。该次 `app.asar` SHA-256 为 `c5f969366ec052661a8cd3fef59fc94352afcb2efbe346a8f6cebc0f63d82d0a`。未生成新分发 ZIP。

验证期间同目录另一项前端重构开始加入依赖、界面和测试改动。94 项及 19 进程结果对应前一实际 ESM 构建；随后共享树类型检查曾因尚未生成的 UI 组件及未就绪依赖失败，不能把当前前端中间状态算作全量通过。开发/打包专项只验收当次产物的模块加载与恢复，未验收新界面；后续前端任务负责最终源码/依赖/产物一致性及全量复验。未复跑长测与真实业务。Forge 上游 `inlineDynamicImports` 与 `codeSplitting:false` 同时存在时有忽略旧选项的提示，产物仍为单文件 preload；未修改 node_modules。

## 开发启动端口修复（2026-09-23）

用户执行 `npm run start` 在 Vite renderer 启动时报 `listen EACCES: permission denied 127.0.0.1:5173`。本机 `netsh interface ipv4 show excludedportrange protocol=tcp` 输出包含 **5141–5240**；Node `net.createServer().listen(5173, '127.0.0.1')` 实测同样返回 EACCES，改用端口 0 成功取得系统分配端口。未确认是哪项系统服务创建了排除范围。

当时的 `vite.renderer.config.mjs`（ESM 迁移后为 `vite.renderer.config.ts`）保留 loopback 监听，并设置 `server.port: 0`。本地锁定版本的 Vite 保留 0，Forge 在监听成功后使用实际端口生成 renderer URL；无需修改系统排除范围或防火墙，该次修复未改变依赖及锁文件。

- 实际 Node/npm 为 **24.21.0 / 11.19.0**；`npm.cmd run typecheck` 与 `git diff --check` 通过。
- `BES_DATA` 设置为独立合成目录 `output/forge-start-1790099842887`、`BES_TEST=1`，清除 `ELECTRON_RUN_AS_NODE` 后执行 **`npm.cmd run start`**。Forge 完成 main/preload 构建，真实 Electron PID **32420** 完成主阶段场景，`test-result.json` 为 `passed: true`；进程退出 0，`diagnostics/latest.json` 为 `shutdown-complete` / `test-completed`。
- Forge 注入的实际地址为 `http://localhost:11529`；HTML 和 `/@vite/client` 均返回 200，使用该客户端令牌连接同端口 WebSocket 收到 HMR `connected`。结果保存于同目录 `dev-server-check.json`，日志为 `forge-start.log`；没有将令牌写入报告。
- 主阶段包括真实 React/IPC、回放、受控 runner、人工交接、HTTP、checkpoint、请求正文与恢复界面。此次只验证开发启动主阶段，未运行第二进程 profile 重启、19 进程强杀矩阵、长测或重新打包。

此前沙箱尝试 `output/forge-start-1790099803196` 已越过端口错误并完成构建，但 Electron GPU 子进程以 `-1073741515` 崩溃，缺少完成报告；即使 Forge 外层返回 0，也不计为通过。随后在正常桌面执行环境完成上述成功复验，未修改 GPU 或 Chromium 安全配置。

## 退出诊断与最终强杀重开矩阵（2026-09-23）

在 `7a6ef3f` / `9946a4b` 上完成退出诊断、连续退出保护、验收目录保存与控制交还的时序修复，以及统一桌面强杀回归。最终 `npm.cmd run typecheck`、`npm.cmd test` **94/94**、`npm.cmd run test:integration` 均通过；后者包含 Vite 构建和 **19 个真实 Electron 进程**，报告 `output/desktop-1790095701394/desktop-summary.json`。`git diff --check` 通过。Node 24.21.0 / npm 11.19.0、Electron 44.4.3 及锁文件 SHA-256 未变。

主场景 PID **36472**、profile 重启 PID **40276** 均退出 0，覆盖原有 UI、HTTP、控制权、五个脚本变体、checkpoint 取消/失败、请求正文及新的恢复界面。每个恢复案例使用独立合成数据根：收到耐久边界标记后由父启动器 SIGKILL 自己的子进程，再启动两个新 Electron 进程；下表各项均通过。

| 强杀边界 | 强杀 / 首次重开 / 再次重开 PID | 核验结果 |
| --- | --- | --- |
| worker 创建前已登记 | 41816 / 17044 / 42432 | 恢复为 interrupted，无结果；checkpoint 原 ID/hash 保留 |
| worker 已运行 | 32688 / 4840 / 30596 | 不恢复旧 worker 或控制权；恢复为 interrupted |
| 等待人工 | 35484 / 14608 / 42432 | 不把未回复当成功，不恢复人工等待；恢复为 interrupted |
| 报告保存后、终态前 | 41020 / 39064 / 34256 | 孤立报告仍按原 hash/字节可读，但不成为执行结果或 pass |
| 终态后、目录保存前 | 27724 / 17480 / 42416 | 故意破坏目录后仍由终态与报告重建 completed/pass |

五种案例均成功创建新 run 复跑，再次重开时验收记录不重复、原 run 原件字节不变、成功复跑结果仍可验证。新 run 的目录写入 barrier 验证：保存期间对外保持 finalizing/locked，无提前暴露的 result/artifact，重复验收返回 409；释放写入后结果与人工控制同时可用。

连续关窗 PID **38712**、连续 app.quit PID **39460** 均在已有 run 和已保存 checkpoint 下执行。测试阻塞 Studio 关闭，再次请求退出，确认窗口仍在、同一次清理只执行一次；释放后核验两份材料的 hash/字节、writer lock 消失及 active 清空。诊断记录 `exit-reentry-verified` 和对应 `shutdown-complete`，实际退出 0。由于没有完整普通测试报告，这两个进程的普通 `passed` 仍为 false；父启动器按专门的退出诊断断言判定场景通过，五个被强杀进程也不冒充普通测试通过。

生命周期诊断保存在各数据根的 `diagnostics/lifecycle-<实例 ID>.jsonl` 与 `latest.json`，记录 PID、启动时间、renderer/child 退出原因和清理阶段。强杀没有结束记录时只保留最后已确认阶段，不推断具体外部退出原因。首轮恢复界面截图已视检，最终同类截图位于上述报告目录。

本批未重跑 20 分钟长测、独立 Edge 示例或发行 ZIP；此前长测在 18.19 分钟后退出的具体原因仍未知。退出诊断和短合成恢复通过不能外推为长负载、30 分钟全负载、性能阈值或真实账号业务通过。

## 验收记录持久化与恢复界面（2026-09-23）

writer 修复已提交为 `7a6ef3f`。随后实现 worker 前登记、报告/终态提交与启动重建，增加可信 UI 存档检查、安全重开和中断验收查看。`npm.cmd run typecheck` 与 `npm.cmd test` **94/94 通过，0 失败、0 跳过**；其中验收恢复 12 项、存档恢复 4 项、Windows 原子替换故障注入 3 项。

恢复单测覆盖孤立报告、目录丢失/损坏、报告 hash/身份/输入/版本不一致、checkpoint 材料不完整及正文缺失/修改、旧报告核验、目录写入失败、坏字段容错和启动期间取消。只有完整终态及对应材料通过检查才恢复原结论，目录中的 pass 不具备独立效力。

真实 React/IPC 场景已通过：损坏锁保持原字节且无强制按钮；已退出 writer 可安全恢复；中断记录无 `result` 时仍显示原因与 checkpoint，并可准备新 run。截图 `output/desktop-1790095126782/ui-recovery-refused.png` 与 `ui-recovery-interrupted.png` 已视检，文本与操作入口可读。该目录的 `desktop-summary.json` 是首轮完整 19 进程通过报告；最终补强复验见上方记录。

首轮桌面尝试 `output/desktop-1790094903971/desktop-summary.json` 因替换 `manifest.json` 返回 `EPERM` 而失败，随后正常清理写入同一文件成功；没有证据确认具体占用来源。`atomicFile` 现仅对 Windows 的 EPERM/EACCES/EBUSY 有界重试：最多 7 次、总等待 1175 ms，重复 rename 同一已 sync 临时文件，不删除旧目标。永久失败保留旧目标并抛错；故障注入及后续桌面运行通过。

补强复验 `output/desktop-1790095351901/desktop-summary.json` 在新 run 结束时发现完成状态早于人工控制交还，判为失败。原因是目录写入前已发布终态；现保存 terminal 候选快照，对外保持 finalizing，最终同步交还控制并发布结果。新增目录写入 barrier 稳定检查此窗口，包含保存期间拒绝下一次验收；最终运行结果见本页最新记录。

## writer 所有权与异常恢复（2026-09-23）

在 `10f8f5d` 之后补齐 writer 锁。`npm.cmd run typecheck` 通过；`node --import tsx --test test/unit/writer-lock.test.ts test/unit/evidence.test.ts` **21/21 通过，0 失败、0 跳过**。运行组合仍为 Node 24.21.0 / npm 11.19.0，Node 内置 libuv 1.52.1；未修改依赖和锁文件。

- 真实进程并发回收同一已强杀 writer，仅一个能持有 guard；旧锁原样保存在 `recovery/`，另一进程被拒绝。目录别名共用同一内核 guard。Windows 系统启动 FILETIME 区分同 PID 的不同进程；无法查询、存活的旧格式近似身份或损坏锁均不授权回收。PID 重用分类用可控 OS 查询结果测试，未声称实际促使 Windows 重用了某个 PID。
- `writer.lock` 以完整、已 sync 的临时文件经不覆盖的硬链接发布。真实子进程分别在发布前/后被强杀，重开只看到无标记或完整标记；发布时外来标记冲突保留外来内容。迟到 release 只认自己的 owner token，不能删除新 writer 的锁。
- 已确认保存的 checkpoint 经强杀后仍可按原 ID/hash 读取。普通中断和已报告损坏尾部重复重开不重复追加恢复 gap，不改变原件字节；坏尾后不再追加新记录。原件尾部有新损坏时仍重新保留并报告。

Windows 进程身份通过系统自带 Windows PowerShell 的 `Process.StartTime` 查询，与 Node 的安装/版本管理工具无关。权限不足或系统组件不可用时明确拒绝写入或恢复，不推断死亡；本批没有验证其他桌面平台。

## 审查后的首批实现与复验（2026-09-22）

文档审查已提交为 `14f64fb`，随后按用户要求继续实现。本轮终端直接核对 `node --version` / `npm.cmd --version` 为 **24.21.0 / 11.19.0**；项目继续仅限制这两个运行时版本，不限制安装或版本管理工具。锁文件 SHA-256 仍为 `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e`。

- `npm.cmd ci --no-audit --no-fund --cache output/npm-cache` 安装 521 包。Electron 官方下载尝试超时后，使用 `@electron/get` 从镜像获取 44.4.3，按已安装包中的 `checksums.json` 核验，再解压至本地依赖目录；没有改依赖版本或锁文件。
- 修改前基线：`npm.cmd run typecheck`、`npm.cmd test`（42/42）和 `npm.cmd run build` 均通过。
- 最终源码：`npm.cmd run typecheck` 通过，`npm.cmd test` **65/65 通过，0 失败、0 跳过**；`npm.cmd run test:integration` 的 Vite 构建和两个真实 Electron 进程均通过，报告 `output/desktop-1790092245546/desktop-summary.json`，PID **19088 / 1056**，均退出 0。覆盖原有五个脚本变体、UI/IPC、控制权、HTTP、页面生命周期及跨进程 profile，并增加下述场景。`git diff --check` 通过。
- `ui.png`、`ui-evidence.png`、新增 `ui-reviews.png` 保存在同一目录；已视检 checkpoint 状态及重开的完整人工判定。首轮实现报告为 `output/desktop-1790091857958/desktop-summary.json`（PID 3464 / 38680），最终报告还包括独立审查后补充的页面关闭恢复与不完整 checkpoint 验收拒绝。

| 本轮补齐项 | 验证范围与限制 |
| --- | --- |
| 请求正文 | 独立 artifact 与 requestKey/source 关联；真实 UTF-8 JSON/null、1 MiB 完整、9 MiB 经 `getRequestPostData` 补采并在 8 MiB 截断，分页读取遵守预算；凭据关键词命中、二进制、multipart 被明确排除，无正文为 not-applicable；扫描合成 CDP/事件原件确认不内嵌正文或凭据哨兵。补采超时、晚到值、redirect/ID 重用/暂停/淘汰等另有单测。 |
| checkpoint 限时与取消 | 真实服务中分别挂起 DOM 或原生截图，通过 React 按钮取消或 10 秒采集期限后保存已有材料与缺失原因、释放安全输入锁；晚到 DOM 不改原 checkpoint，新采集正常。人工/agent 页面关闭后等待旧采集和 disconnect 才恢复替代页面，延迟 disconnect 不提前解锁。HTTP 队列中的取消绑定自身 job，不影响前一任务；保存期间的取消等待实际落盘成功或失败。真实 worker 挂起时可取消，报告队列收敛且不恢复已撤销闸门；另以 partial/failed/timed-out 三种实际采集故障确认材料保留、覆盖不计入、验收 fail。 |
| 人工评审 | 保持追加式文件，单测验证新 Node 进程读取、固定分页边界、UTF-8 整体响应预算、坏尾部错误及完整理由/范围。真实 React/IPC 验证保存后可见、下一页、关闭重开，并确认人工例外不改变机器失败。 |
| 示范隔离 | 真实 UI 中为两个项目创建同 key 示范，候选和实际对照只包含验收所属项目。基线选择仍未持久关联到验收记录。 |

所有新材料均在被 Git 忽略的合成 `output/` 下。本轮未复跑 20 分钟长测、独立 Edge 示例或重新生成发行 ZIP；这些不继承为新源码通过记录。10 秒仅限制采集阶段，不保证磁盘写入期限；操作静默失败时保持关闭，需要显式停止。请求正文排除规则不等同于完整个人信息识别或上传文件捕获。

## 后续工作区审查（2026-09-22，非测试复跑）

在 `main` / `1c3c3b1` 上读取设计、实施计划、源码与测试代码；审查开始时工作树干净，实现仍为 `f8e6eb8`。`Get-FileHash package-lock.json -Algorithm SHA256` 输出 `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e`，与下方历史记录一致。

审查时开发机通过 Node 版本管理工具维护多个运行时。直接调用已安装目标版本的 Node 和 npm CLI 核对，输出 **24.21.0 / 11.19.0**；当时终端默认 `node --version` / `npm --version` 为 **14.21.3 / 6.14.18**。审查未改变默认运行时。项目仅约束 Node/npm 版本，开发者可自行选择安装方式或版本管理工具；本文统一记录实际版本与通用命令，不绑定工具名称、专用环境变量或安装路径。

`Test-Path` 检查确认此检出没有 `node_modules/`、`.vite/`、`output/`、`out/` 或历史 ZIP。因而本轮没有重跑 typecheck、42 项测试、Electron、打包或长测，也未重新核验历史产物；这不否定历史记录，但不能将其作为本次环境的通过结果。版本管理工具的版本列表查询未及时返回，可用版本通过安装目录和直接执行核对。

当时静态检查列出长历史续读/回放定位、checkpoint 限时取消、请求正文状态、采集/索引进程分工、人工评审回读、示范基线身份和异常恢复等未完成项。其中本轮已收尾的项目以上方新记录为准；剩余边界见 [progress.md 的本次核查](progress.md#本次代码与工作区核查)。下方“已执行命令”和“合成验收覆盖”保留历史口径。

## 环境与构建

| 项目 | 实际组合 |
| --- | --- |
| 开发 Node / npm | 24.21.0 LTS / 11.19.0，执行命令时显式选择目标运行时 |
| Electron 内置 Node / Chromium | Electron 44.4.3 / Node 24.21.0 / Chromium 152.0.7977.130 |
| 执行与录制 | puppeteer-core 25.11.0 / rrweb 2.1.6 |
| 构建与界面 | Forge 7.11.2、Vite 8.3.0、TypeScript 7.0.2、React 19.3.0 |
| 独立示例浏览器 | 本机 Edge 153.0.4234.48，新临时 profile；不读取已有账号环境 |
| package-lock SHA-256（D: 实际文件） | `7b7b1100985eae2ad4952fd0987db386a840efc2cec3ab1e26e0e05c6261a93e` |

D: Git 检出使用 CRLF，锁文件标准化为 LF 后的 SHA-256 仍为迁移前的 `c47ffd6ab57b3fc1b93629b28a01f52da48fd3041389c95e227534dcffb185e9`；依赖内容未变。

`npm ls webpack @electron-forge/plugin-webpack vite --depth=1` 仅列出 Vite。main/worker 与 preload 输出 CommonJS，renderer 输出浏览器 ESM，类型检查独立于 Vite 转译。

Electron ZIP 158,247,567 字节，SHA-256 为 `790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`，与安装包内官方校验清单一致。镜像和随后完成的官方下载均核验了同一摘要。

## 已执行命令

以下命令在仓库根目录、Node 24.21.0 / npm 11.19.0 环境中执行。表中统一列出通用命令，省略版本管理工具的专用启动前缀；复现时用自行选择的方式准备相同版本，并先核对 `node --version` 与 `npm --version`。

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd test` | `f8e6eb8` 在迁移前后均为 42 项通过，0 失败、0 跳过，含合成站点、真实 worker 和新增并发分页预算回归 |
| `npm.cmd run build` | Vite main/preload/renderer 构建通过 |
| `node test/desktop/launch.cjs` | 两个真实 Electron 进程的桌面和 profile 重启场景通过 |
| `npm.cmd start`，设置独立 `BES_DATA` 与 `BES_TEST=1` | Forge/Vite 开发模式主阶段全部通过，客户端正常退出 |
| `npm.cmd run test:example`，显式设置 `BROWSER_EXECUTABLE_PATH` | 5 个独立浏览器变体实际执行，1 个组合测试通过，0 跳过 |
| `npm.cmd run test:soak` | 未通过：第二次最后保存到 18.19 分钟后进程提前退出，缺少完成报告；详见下文 |
| `npm.cmd run make`，使用已校验的 `ELECTRON_ZIP_DIR` | D: 主目录重新生成 `f8e6eb8` 的 Windows 应用目录与 ZIP，包含最后的 reader 预算修复 |
| `node test/desktop/launch.cjs '--executable=out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe'` | D: 新包的两个真实进程完整通过；输出 `output/desktop-1790079600870` |

普通 Vite 构建提示 rrweb/React renderer chunk 大于 500 kB；Forge/Vite 组合提示上游 `inlineDynamicImports` 配置弃用。两者未导致上述构建失败，不代表已经完成体积优化。

首次完整桌面通过证据：`output/desktop-1790077424921/desktop-summary.json`，主进程 PID 40644，重启进程 PID 14700，二者退出码 0。Forge 开发模式证据：`output/forge-start-1790077723581/test-result.json`。截图保存为各目录下的 `ui.png` 与 `ui-evidence.png`。这些运行目录被 Git 忽略，复跑会生成新目录。上述迁移前证据位于旧根目录 `C:/Users/Administrator/.codex/worktrees/c22c/browser-evidence-studio/`，Git 合并不会搬运这些本地材料。

最近迁移前源码桌面结果：`output/desktop-1790078296913/desktop-summary.json`，PID 50604/50452；打包 EXE 结果：`output/desktop-1790078710305/desktop-summary.json`，PID 49080/44476。两者都包含空闲时直接验收、封存后重跑及 popup 自关闭；打包场景还验证实际 rrweb 播放/暂停和 iframe 桥接隔离。迁移前 ZIP 为 168,163,792 字节，SHA-256 `3a93de36bf1f5a2949ea7bee2abbd4904c37d892a8c438d7e0a64900a7959180`。此包不包含最后的 reader 并发预算修复，不应标为当前源码重新生成的发行包。

独立示例最近一次结果位置：`C:/Users/ADMINI~1/AppData/Local/Temp/bes-independent-Otoa9s`，包含每个变体的报告、截图和来源附件。

## 主目录迁移后的复验

2026-09-22，`f8e6eb8` 已快进合并至 `D:/workspace/browser-evidence-studio` 的 `main`，后续开发使用该目录。以下路径相对此主目录。

- 独立依赖安装：Node 24.21.0 / npm 11.19.0，`npm ci --offline --ignore-scripts --no-audit --no-fund` 从缓存安装 521 包；Electron 从已核对包内官方校验值的 ZIP 解压到本目录，并执行本地 esbuild 安装检查。未共享旧 `node_modules` 链接，未复制 profile/录制。
- `npm run typecheck`、`npm test`（42/42）、`npm run build` 与 `npm ls --depth=0` 均通过，锁文件未改变依赖内容。
- 最新源码两进程报告：`output/desktop-1790079502939/desktop-summary.json`，PID 9964/37584，两个退出码均为 0。
- 最新打包 EXE 两进程报告：`output/desktop-1790079600870/desktop-summary.json`，PID 32472/45096，两个退出码均为 0。包含 UI/回放、五个脚本变体、空闲验收、人工交接、取消、popup 自关闭、正文边界、HTTP 和 profile 重启。
- 当前 EXE：`out/Browser Evidence Studio-win32-x64/BrowserEvidenceStudio.exe`；ZIP：`out/make/zip/win32/x64/Browser Evidence Studio-win32-x64-0.1.0.zip`，167,341,123 字节，SHA-256 `ccde7da6f66467e4dd44820c69178be079f24a685f43830246b24b94542fb3fa`。包含 reader 修复，未签名。

## 合成验收覆盖

| 需求 | 实际证据与边界 |
| --- | --- |
| R01 桌面与目标身份 | WebContentsView、普通 Puppeteer 点击和导航、独立捕获连接、弹窗/opener、切页后操作目标、刷新与 DevTools 打开关闭均通过。按 CDP targetId 匹配，未按 URL 猜测。 |
| R02 存储与恢复 | OS writer 身份、内核独占、并发回收、原子标记发布两侧强杀、owner token、损坏尾部保留、hash 校验、重复重开与稳定 ID 单测通过。真实 Electron 强杀后确认过的 checkpoint 仍可读；renderer 强制崩溃记录 gap 后仍可封存。unknown/corrupt 不强制回收。 |
| R03 连续证据 | CDP 请求/响应、两跳重定向、1 MiB 完整 JSON、9 MiB 在 8 MiB 明确截断、rrweb 顶层与 iframe 场景通过。跨域 iframe/Canvas/媒体及 WebSocket/SSE 完整正文不作保证。 |
| R04 checkpoint 与检查 | 原生视图蒙版、截图/DOM 落盘、有界回读、实际 UI 显示保存截图通过。检查点击只选元素，不执行站点按钮；采集期间页面定时器继续。 |
| R05 控制与人工交接 | 并发 Promise/定时器命令在闸门关闭后拒绝；连接建立中停止不能晚到点击；两处人工窗口经真实原生输入和状态检查后恢复；未满足检查、超时和取消不通过。 |
| R06 登录环境 | 同一 profile 新 run 及新 Electron 进程中的合成 Cookie/localStorage/IndexedDB 均保留，另一个 profile 保持为空。保存仍标记登录状态 unknown，不承诺 sessionStorage、内存态或跨机器迁移。 |
| R07 HTTP | loopback、token ACL、Host/Origin、幂等 job、取消确认、身份与预算相关单测通过；真实 HTTP 场景完成 8 个 job、6 个控制权/身份拒绝，幂等点击只发生一次，键盘 fill 实际值正确，截图和 HTML 下载响应安全头通过。 |
| R08 普通脚本 | 同一 `examples/orders/run.mjs` 在受管 worker 和独立 Edge 中运行；普通分页、去重和详情分支，无运行时 LLM 或 Electron 必需依赖。 |
| R09 验收 | normal/duplicate 输出 7 条订单及关联详情并通过；wrong-image、missing、empty-middle 确实判失败。新增启动登记与终态证据重建；报告 hash/身份/输入/版本及 checkpoint 材料校验，未提交完整终态不恢复 pass。保留来源、实体 ID、覆盖和字段验收。 |
| R10 项目技能 | 入口技能与按需引用的 HTTP/探索/验收说明已建立，skill-creator 的 quick_validate 已通过；未全局安装。独立接续检查只完成 capabilities/health/state 读取；进一步读取被自动审批拒绝，因此来源级接续未通过，未执行修改/复跑。 |
| R11 长流程 | 两次 20 分钟尝试均未完成，最后一次仅有 18.19 分钟的阶段快照；无完整长测、最终封存/重建或该次重启通过结论。reader 的字节预算单测通过，但不能替代长负载验收。 |
| R12 分发与真实验收 | 历史 `f8e6eb8` 在 D: 生成 Windows ZIP、打包 EXE 两进程桌面与 profile 重启通过，包含当时 reader 修复；当前源码未重新打包，未签名。真实拼多多演示、扫码及业务需求验收未执行。 |

## 本轮发现并修复的问题

- 原生输入蒙版与 Windows 窗口遮挡会影响 Chromium 的 IntersectionObserver，普通 Puppeteer 点击可能等待超时。业务视图关闭后台节流，蒙版保持透明合成，并添加 `disable-backgrounding-occluded-windows`；五个普通脚本变体及人工交接已复跑通过。此设置保持绘制，不关闭浏览器安全隔离。
- Electron `window.open()` 的 createWindow 回调已给出 guest WebContents。旧代码重建另一份会抛 `Invalid webContents` 主进程异常；改为 `new WebContentsView(options)` 接管原对象，安全偏好在 overrideBrowserWindowOptions 中设定。真实 popup/opener/切页和退出已通过。
- Puppeteer 25 在 Chromium 152 下需要发现结构性 tab target 才能找到其 page。适配器允许结构 tab，最终 Page 仍绑定并通过 CDP 复核明确登记的 targetId。
- 对每个 iframe 注入独立 rrweb 会递归记录 rrweb 自己的辅助 iframe。现在只在顶层注入，暂停恢复只调用已就绪的主文档 recorder；跨 iframe 能力明确为部分支持。
- Forge 的 preload 构建使用入口名 `ui.js`，与普通 Vite 构建原来的 `preload.js` 不同。输出文件名现已统一；开发启动和生产构建使用同一路径。
- 操作连接建立/停止、人工完成检查/取消、封存/晚到 popup 的竞态已加失效检查和清理。不能在等待结束后恢复已经撤销的控制权。
- 证据列表在索引并发追加时，原先会在装满页面后补入 cursor，触发 `BUDGET_TOO_SMALL`。现按读取开始时索引边界查询，并按完整 cursor/元数据的实际序列化大小预留预算；追加竞态和长元数据分页回归通过，指定纯合成目录 56 项历史查询均在预算内。
- 保存的 HTML 等原件不内联执行。截图协议限定完整 PNG、大小预算与安全响应头，IPC 仅信任准确 UI 文档 URL；HTTP 二进制附件使用下载响应及禁脚本 CSP。

## 网络与防火墙排查

只观察到已有的 Public 配置 Node 入站阻止规则，未修改防火墙。本机 HTTP、CDP 和夹具互通已实测；`Get-NetTCPConnection` 核对实际 CDP 监听为 `127.0.0.1`。本次 npm 出站失败与代理 TLS reset/执行沙箱限制有关，给 registry 设置进程级 NO_PROXY 后可安装；无法据此把失败归因于入站规则。

本工具不需要对局域网或公网监听。无需禁用防火墙或给 Node 广泛开放入站。图形测试在允许的进程执行环境中运行；没有关闭 Chromium sandbox、contextIsolation 或 webSecurity。

长录制第一次尝试 `output/desktop-1790077578498` 在约 11 分钟时被导航到非合成站点，夹具检查中断，该次不算通过。材料保留在本地且被 Git 忽略，未据此推断真实站点登录或业务成功。长测随后改为保持自动化控制、明确测试窗口标题，每轮先校验控制权及合成 origin；人工显式接管会停止测试，不继续操作真实页面。

第二次 `output/desktop-1790078604560`（旧 worktree）最后阶段快照为 1,091,475 ms（18.19 分钟）、18 个 checkpoint、cycles=102。主 Electron PID 13156 在完成报告生成前以退出码 0 退出；没有 `test-result.json` 或 `soak-result.json`，启动器最终返回 1，`desktop-summary.json` 为 passed=false，profileRestart 为 not-run。日志没有足够信息确认退出原因，不能推定由用户关窗、崩溃或防火墙导致。`soak-progress.json` 的 running 是陈旧快照，进程已经退出；该次不计通过，也不发布最终 P95/零丢失结论。后续在 D: 主目录排查并复验。

## 尚未验收的范围

真实账号与拼多多业务闭环需要用户完成演示和扫码，不能以合成测试代替。自动更新、代码签名、多机 profile 迁移、外部浏览器接管、完整跨域 iframe/Canvas/媒体回放不在本次通过声明中。

性能目标中的 100 ms 界面反馈、30 分钟全负载、HTTP P95 300 ms 等需各自实测；不能从一次短路径或命令成功外推。长期内存和数据损失结论以指定合成负载与保存边界为限。
