# Vitest 选型评估

日期：2026-09-23。状态：Vitest 仅评估，不是已批准或已完成的迁移。评估阶段只读取源码和官方资料；没有为 Vitest 安装依赖、修改测试/构建配置或运行测试。随后按前端交接另行实施的[路径别名迁移](import-alias-plan.md)不改变这一状态。

## 1. 建议与适用范围

建议后续采用 Vitest 统一普通单元、模块级和 renderer 组件测试；真实 Electron 的启动、preload、WebContentsView、强杀恢复、打包和长测继续由现有桌面入口验收。项目初期尚适合定下这一方向，但当前后端测试没有必须立即换框架的问题。

主要收益是为 React 界面补充快速的行为测试层，以及统一日常 watch、过滤、mock 和报告体验。仅为了使用 Vite 或解决 paths 别名而迁移，收益不足。前端稳定、路径别名方案完成验证后，再将测试框架迁移作为独立变更评估和实施，不混入 UI/ESM/业务重构。

## 2. 当前仓库的实际情况

- 实际开发运行时为 Node 24.21.0 / npm 11.19.0；package.json 使用 `node --import tsx --test`。
- 当前工作区静态统计为 15 个 unit 文件、101 项顶层 test，加合成站点的 1 个文件、1 项 test，共 16 文件 / 102 项。这不是本轮执行结果，不能替代历史 94 项或前端后续验证记录。
- 所有这些测试使用 `node:assert/strict`；尚未发现 renderer 的 React 组件测试，UI 行为主要由真实 Electron 场景验证。ui-ipc/ui-preferences 测的是桥接边界和服务行为。
- 名称为 unit 的目录还包含真实 OS 集成：文件落盘、HTTP、子进程强杀、writer 锁竞态以及 worker 取消。
- `test/desktop/launch.js` 独立调度 19 个真实 Electron 进程的完整矩阵，并验证 PID、报告身份、退出与材料。更换单测框架不会消除这些测试的成本。

## 3. 优劣取舍

| 方面 | 现有 node:test + tsx | Vitest 的收益或代价 |
| --- | --- | --- |
| Node 后端测试 | 依赖少，直接按 Node 运行；当前契约测试已建立。 | 能承接这些测试，但增加 runner、模块转换及配置，单纯搬迁不会增强业务断言。 |
| TS、ESM 和别名 | tsx 已提供源码加载和 paths 支持。 | 可使用 Vite 解析/转换规则，减少测试与界面的配置差异；仍须显式配置，不会自动覆盖独立子进程。 |
| React 组件 | 当前未建立轻量组件测试层，需额外搭建 DOM 环境和工具。 | TSX、mock、DOM/浏览器测试生态更完整，适合验证表单、主题、状态和窄桥接调用。 |
| 开发反馈 | Node 已有 watch、mock、报告和覆盖率入口。 | 相关测试重跑、过滤、IDE/UI 和覆盖率工具更集中；不能把这些能力说成 Node 完全没有。 |
| 运行语义 | 更直接验证 Node 模块和进程行为。 | 模块 mock 会引入转换和加载时序变化，不能把测试通过等同于原生 ESM/打包通过。 |
| 性能与维护 | 基础工具链轻，现有配置少。 | watch 可能改善反馈，但冷启动、内存与整个测试套件速度需实测；新增依赖及版本配套成本。 |

依据：[Vitest 功能](https://vitest.dev/guide/features)、[测试环境](https://vitest.dev/guide/environment)、[模块 mock 的转换机制](https://vitest.dev/guide/mocking/modules#how-it-works)、[Node 24.21 测试文档](https://nodejs.org/docs/latest-v24.x/api/test.html)。Node 当前原生覆盖率接口仍标为 experimental；本轮没有进行两种 runner 的性能对比。

## 4. 本项目具体迁移成本

1. **保留已有断言。** Vitest Node 测试可以继续使用 node:assert/strict，无须为换框架重写全部业务断言。需要修改 runner 导入、测试选项和上下文用法，并保证测试没有在 Vitest 收集范围中仍注册给 node:test。
2. **mock 与恢复语义。** 7 个 context.mock.method/t.mock.method 调用分布在 atomic-files、evidence、validation 三个文件的五项测试；validation 还使用 Node 专属 mock.callCount()。writer-lock 直接替换 fs.link 后在 finally 恢复。迁移必须保持恢复时机、异常清理和文件隔离，不随意对这些用例启用 concurrent 或禁用隔离。
3. **不能顺手删除 tsx。** evidence、reviews、writer-lock 三个文件显式创建带 `--import tsx` 的原生 Node 子进程；test:example 也使用 tsx。Vitest 的转换、别名和 mock 不会自动应用到这些新进程。
4. **保留真实 worker/进程。** validation 系列生成临时 .mjs worker，runner manager 创建 Worker 时没有设置 execArgv；需检查新 runner 下继承的启动参数、环境、取消、退出和清理。持久化/强杀测试仍需真实文件与进程，不能为了迁移通过改成内存 mock。
5. **异常检测不可弱化。** checkpoint 等测试包含晚到 rejection、取消与限时逻辑，必须继续对未处理异常判失败。不能靠忽略异常、无限放宽 timeout 或默认重试隐藏退化。
6. **配置需要显式设计。** 本仓库有 vite.main/preload/renderer.config.ts，没有通用 vite.config.ts；Vitest 不会自动挑选这三份配置。拟使用独立 vitest.config.ts，只共享必要的源码解析设置，避免直接合并 renderer root 或 main/preload 的产物设置。测试配置也应纳入类型检查；Vitest 执行 TS 不代替现有 typecheck。[配置文档](https://vitest.dev/config/)

## 5. 拟采用的测试分工

| 层次 | 拟用方式 | 验证边界 |
| --- | --- | --- |
| contracts/shared、服务逻辑与现有模块测试 | Vitest Node 环境 | 保留原断言；真实文件/网络/进程用例继续真实执行。 |
| renderer 组件行为 | Vitest + React 测试工具，初期按需要采用 jsdom | 检查用户可见状态、操作与桥接参数；mock 窄 window.studio 接口，不借组件测试加载整个 Electron 主进程。 |
| 浏览器特定交互 | 确有需求时考虑 Vitest Browser Mode | 真实浏览器可补充焦点、CSS 和 Web API 验证，但不是 Electron runtime。 |
| 原生视图、preload、控制权、恢复、打包 | 现有 Electron desktop harness | 保留真实多进程与材料验收；DOM 模拟和普通 Chromium 均不能代替 WebContentsView 命中路由、安全桥接或 profile 恢复。 |
| 可独立交付示例 | 保留原生 Node 运行验收 | 继续证明没有 Electron 或 Vitest 的运行时必需依赖。 |

普通 Node 和 renderer 测试可以用同一个 Vitest 配置中的测试分组管理，不需要 npm workspace 或 monorepo。暂不同时引入 jsdom、happy-dom、Browser Mode 三套界面测试环境。测试目标是用户行为与契约，不给每个 shadcn 包装组件补 className 或大块 DOM 快照测试。[Vitest projects](https://vitest.dev/guide/projects)、[组件测试](https://vitest.dev/guide/browser/component-testing)

## 6. 版本与实施验证门槛

本次核对到官方 [v5.0.1 发布](https://github.com/vitest-dev/vitest/releases/tag/v5.0.1) 及该 tag 的 [package 元数据](https://github.com/vitest-dev/vitest/blob/v5.0.1/packages/vitest/package.json)：Node engines 包含 `^24.0.0`，Vite peer 范围包含 `^8.0.0`。当前 Node 24.21.0 / Vite 8.3.0 满足声明范围；这只是兼容性声明，不是本项目安装、TS 7 类型检查或运行通过的证明。实际实施时重新核对非预发布版本、包元数据并锁定验证组合，相关 Vitest 配套包使用匹配版本。

若后续决定实施，先用一个纯后端文件、一个 fs 故障注入文件、一个真实 worker/强杀用例和一个有价值的新组件测试作小范围验证，再迁移剩余普通测试。核对测试收集数量、skip/timeout/mock 清理、未处理异常、退出码、子进程身份和落盘证据；保留 typecheck、构建及真实桌面回归。记录冷启动和修改后的反馈时间，不预先宣称性能提升。

日常入口可以保持 npm test（一次性执行）并补一个 watch 入口；现有 test:integration/test:desktop/test:soak 保持真实桌面职责。这些只是提案，本轮没有修改命令。
