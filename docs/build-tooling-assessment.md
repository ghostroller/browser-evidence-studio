# electron-builder + Vite 迁移评估

日期：2026-09-24。状态：仅评估，尚未实施迁移或安装候选依赖。启动修复已提交为 `b280b87`；当前构建基线仍是 Electron Forge + Vite。按用户要求修订评估依据：以本项目需求、Electron 的运行与安全边界、electron-builder 所选发布版本的声明和实现、Vite 自身 API 为准；社区集成项目仅供参考，不作为迁移前提或兼容性标准。不将源码核对或声明兼容视为本项目实测通过。

## 1. 建议

建议将 electron-builder + Vite 作为后续构建迁移方向，尤其是在继续完善 Windows 安装与分发的前提下。当前 Forge 耦合范围有限，迁移成本主要集中于开发进程调度、打包内容和桌面回归，属于中等规模的构建工程调整，无须改写 Electron 主进程、WebContentsView、采集、存储或 runner 架构。

如果目的只是消除本次启动超时，则没有必须迁移的理由。本次已复现的问题是应用拒绝可信 UI 自身刷新，导致首次模块失败后无法恢复；更换开发工具不替代这个修复。原始偶发日志没有足够信息证明全部事件同因，也不能将迁移收益外推到采集丢弃、内存增长或真实站点兼容性。

Forge 的 Vite 插件目前仍标为 experimental，官方允许后续 minor 包含破坏性调整。这是减少对该集成层依赖的合理理由，但不代表整个 Forge 不可用，也不证明其他插件必然更稳定。[Forge Vite 文档](https://www.electronforge.io/config/plugins/vite)

electron-builder 的直接价值是安装包与分发能力，例如 Windows NSIS、签名和更新配套；它本身不接管 Vite 开发服务器及 Electron 热重启。移除 Forge 时必须同时确定开发启动方案。Forge 也可以完成安装包分发，因此收益是工具职责和配置选择更符合后续需求，并非只有 builder 才能分发。[builder 文档](https://www.electron.build/)、[v26 NSIS](https://www.electron.build/v26/docs/nsis/)、[v26 自动更新](https://www.electron.build/v26/docs/features/auto-update/)

## 2. 本仓库的实际耦合范围

| 位置 | 当前行为 | 迁移涉及的工作 |
| --- | --- | --- |
| `package.json`、`forge.config.ts` | start/package/make 使用 Forge；build 已直接执行三份 Vite 配置；当前分发为 Windows ZIP。 | 替换开发调度、打包配置和命令，保留常用 npm 入口。 |
| 三份 `vite.*.config.ts` | main + runner worker 为 ESM，renderer 使用相对资源路径，preload 为单文件 CJS。 | 尽量复用配置与输出关系，不因套用模板改变模块边界。 |
| `src/main/window.ts` | 读取 Forge 注入的开发 URL，生产环境读取相邻 renderer 产物。 | 明确开发 URL 注入来源，继续精确校验可信入口与导航。 |
| `test/desktop/launch.js`、`startup.ts` | 开发专项调用 Forge，故障恢复用例利用其启动时的刷新时序。 | 改为新启动入口；保留冷/热缓存、模块失败、可信刷新和真正失败的行为断言，不能机械保留 Forge 特有提交次数。 |
| `scripts/browser-baseline.mjs` | 独立使用 Vite API 构建并启动隔离 Electron，未依赖 Forge 启动。 | 保留与普通客户端的构建身份、输出和数据根隔离，核对开发 URL 定义。 |

当前实际核对环境为 Node **24.21.0** / npm **11.19.0**；项目使用 Electron **44.4.3**、Vite **8.3.0**、Forge **7.11.2**。这里不建议为换构建工具同时升级 Electron、调整进程边界或更换测试框架。

## 3. 以 electron-builder 仓库为依据的集成边界

本次 npm registry 查询中，builder 最高非预发布版本为 **26.16.1**；`v26` 指向它，`latest` 仍为 26.15.3，`next` 为 27.0.0-alpha.8。优先评估固定 26.16.1，后续实施前重新核对。仓库默认分支的 README 已描述 v27 的 ESM/Node 变更，因此只用它确认项目定位；具体实现以 **electron-builder@26.16.1** tag 为准，不混用 master 与 v26 的配置行为。[26.16.1 发布](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.16.1)

| 仓库声明或实现 | 核对结果 | 对本项目的含义 |
| --- | --- | --- |
| [仓库 README](https://github.com/electron-userland/electron-builder#readme) | 定位为应用打包、分发、签名及更新配套；快速开始直接添加 builder，另将社区模板列入 Community Boilerplates。 | 社区模板可以参考，但不是 builder 的强制集成方式。单 npm 包可继续保留。 |
| [electron-builder 包声明](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/electron-builder/package.json)、[app-builder-lib 包声明](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/app-builder-lib/package.json) | 两个包均未将 Vite、electron-vite 或 vite-plugin-electron 声明为 dependency/peer；builder 的 Node engines 包含本项目 Node 24。 | 第三方集成包的 Vite peer 范围不能用来判断 builder 与 Vite 8 是否可组合。包声明不代替打包实测。 |
| [builder.ts](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/electron-builder/src/builder.ts) | build 入口规范化平台、架构、目标、配置等参数，调用 app-builder-lib 的 Packager；提供 dir/prepackaged 等打包选项。 | builder 负责打包阶段，开发服务与 Electron 重启由项目另行衔接。 |
| [platformPackager.ts](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/app-builder-lib/src/platformPackager.ts) | 普通应用路径准备 Electron、收集应用与依赖文件、生成 ASAR、复制额外资源，并按 metadata.main 检查应用入口。 | 可以接收现有 Vite 生成的文件；入口和资源布局是本项目应满足的契约。该检查不证明 preload、worker 或 UI 能实际运行。 |
| [fileMatcher.ts](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/app-builder-lib/src/fileMatcher.ts) | 应用文件匹配会加入默认排除项，包括 package-lock.json；资源映射另有处理路径。 | 打包文件清单和依赖指纹材料必须显式适配，不能直接照抄模板。 |

据此，优先验证的方案调整为 **electron-builder 26.16.1 + 现有 Vite 8.3.0 + 项目内少量开发启动代码**。这是依据源码边界作出的工程建议，不是 builder 对本项目的兼容认证。

建议分工如下：

- **Vite：** 复用现有配置构建 main、runner、preload 和 renderer；renderer 的开发服务及 HMR 使用 Vite 自身能力。
- **项目启动入口：** 使用 Vite 的 `createServer`、`build`/watch API 与 Node 子进程 API，等待首次构建和服务器就绪，传入实际 loopback URL 后启动 Electron；协调 main/runner 重启、preload 刷新或重启，以及正常/异常退出清理。只补必要的生命周期衔接，不扩展成通用工具框架。[Vite JavaScript API](https://vite.dev/guide/api-javascript)
- **electron-builder：** 读取产物、入口、生产依赖及必要资源，完成应用目录、ZIP 和后续安装包的构建。`package`/`make` 在调用 builder 前显式完成 Vite 构建。

`scripts/browser-baseline.mjs` 已有直接调用 Vite 构建和启动 Electron 的实践，可复用其经过验证的部分；它尚不具备完整开发 watch/HMR 调度，不能写成新开发入口已经完成。继续保留 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 与单文件 `preload.cjs`，这些由本项目及 Electron 的运行边界决定。

撤回前版优先采用 vite-plugin-electron 的建议。electron-vite 与 vite-plugin-electron 仅作为可选社区实现参考；它们的版本或默认行为不构成 builder + Vite 迁移的限制，也不据此降级 Vite、引入 beta 或调整安全边界。最终只维护一种日常开发路径。

## 4. 具体成本与容易遗漏的边界

- **开发生命周期。** 确保 renderer 服务和 main/preload 产物准备好再启动 Electron；main 修改重启、preload 修改刷新、renderer HMR、Ctrl+C 退出及异常退出都要清理子进程。继续使用 loopback 动态端口，避免回退到已遇到 Windows 排除范围的固定端口。
- **模块与 worker。** 保留根包 ESM、main/runner ESM、沙箱 preload 单文件 CJS；相邻文件继续基于 `import.meta` 定位。打包后的 worker、动态 chunk 和生产依赖必须真实执行通过，不仅检查开发模式。
- **锁文件属于运行时材料。** `src/main/services/studio.ts` 从 `app.getAppPath()/package-lock.json` 读取依赖指纹并传给 workflow；builder 26.16.1 默认排除 `package-lock.json`。需要显式资源映射或打包钩子，并统一读取位置，确保打包内材料与构建锁文件字节一致。不能假定在普通 `files` 中添加包含项就会覆盖默认排除。[v26.16.1 文件过滤源码](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.16.1/packages/app-builder-lib/src/fileMatcher.ts)
- **应用身份与数据根。** 保留可执行文件名和开发/发行环境的数据目录约定，避免迁移后误用其他 profile 或表现为数据丢失。安装器 appId、安装范围和卸载行为需要独立明确，不能让卸载清理录制/profile。
- **分发内容。** 显式限定构建产物、生产依赖和必要版本材料；检查 ASAR 实际内容，避免把 output、真实录制、账号或 profile 打入包。不能把现有 ZIP 启动通过等同于新 builder 包通过。

迁移不会自动降低启动耗时、内存或包体积；这些收益只能在同版本、同数据根、同场景下测量后成立。

## 5. 建议实施顺序与通过门槛

1. 固定验证版本，证明新的开发入口能启动现有应用，main/preload/renderer 的重载与退出行为正确。先保留既有产物布局，减少路径和构建工具同时变化。
2. 替换 Forge package/make，先产出等价的 Windows 应用目录与 ZIP；检查 ASAR、生产依赖、锁文件及真实 runner 执行。NSIS、签名和自动更新分别作为后续交付，不混成一次尚未验收的大迁移。
3. 适配既有桌面 harness，保留真正的 Electron 报告、生命周期、退出码和身份检查；类型检查、普通测试、build、开发启动专项及打包后的桌面矩阵通过后，才删除 Forge 依赖与配置。
4. 验证可信 UI 刷新、非可信导航拒绝、原生视图边界、preload 桥接、worker 取消/退出、强杀恢复以及重开后的证据/指纹回读。原有 19 进程矩阵的已知 UI 拖动不确定性需如实记录，不通过扩大 timeout 或忽略失败掩盖。
5. 更新 AGENTS、架构、环境、实现计划与验证文档，明确新的实测组合和未覆盖范围。只有完成这些验证，才能把本文件的候选方案升级为项目基线。

本轮仅新增评估记录，未修改构建命令、依赖、应用配置或安全边界，也未执行候选组合的构建/打包。启动修复的验证结果仍以 [verification.md](verification.md#开发启动布局超时修复2026-09-24) 为准。
