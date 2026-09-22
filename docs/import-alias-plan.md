# 源码导入别名方案与验证

日期：2026-09-23。先完成只读研究；收到前端重构完成交接后，按用户要求实施隔离 CLI 实验和源码迁移。固定配置与实验结果如下，最终桌面、开发和打包运行记录集中在 [verification.md](verification.md)。本次没有迁移测试框架。

## 1. 已采用的定调

根 `tsconfig.json` 使用单一映射 `@/* -> ./src/*`，跨职责导入写成 `@/main/...`、`@/renderer/...`、`@/runner/...`、`@/capture/...`、`@/evidence/...`、`@/contracts/...`、`@/shared/...`。同一职责目录内的紧邻模块可以继续使用相对导入。

迁移前只有 renderer 使用 `@/* -> ./src/renderer/*`，Vite 另有对应 `resolve.alias`。本轮同时调整 TypeScript、三个 Vite 构建入口、已有导入及 `components.json` 的五个 aliases，避免编辑器、CLI 与构建器各用不同含义。

components、ui、lib、hooks、utils 分别设为 `@/renderer/components`、`@/renderer/components/ui`、`@/renderer/lib`、`@/renderer/hooks`、`@/renderer/lib/utils`。CSS 文件位置仍由 `tailwind.css` 的项目相对路径指定。

三个 Vite 入口均启用 Vite 8 原生 `resolve.tsconfigPaths: true`，读取同一份 TS paths；移除旧 renderer `resolve.alias`，没有增加路径解析插件。[Vite 官方说明](https://v8.vite.dev/config/shared-options#resolve-tsconfigpaths)

`paths` 不会改写 TypeScript 输出，也不提供进程隔离。运行时 worker/preload 文件位置、原生 Node JS 入口及外部业务脚本仍按文件路径/URL 加载。renderer 跨层复用应受 contracts 与浏览器安全 shared 的边界约束。[TypeScript 官方说明](https://www.typescriptlang.org/tsconfig/paths.html)

## 2. 官方实现与测试依据

审阅 shadcn-ui/ui 固定提交 `98a1fe67b439324ddc857f47fbdce056600a4329`，该提交的 CLI 包版本为 4.21.0。以下是上游源码与测试证据，不代表已经在本机执行这些测试。

- [resolve-import.test.ts](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/packages/shadcn/src/utils/resolve-import.test.ts)：覆盖 `@/* -> ./src/*` 下的 `@/foo/bar`、更深层的别名解析，以及不设 baseUrl 的情况。
- [without-base-url/tsconfig.json](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/packages/shadcn/test/fixtures/without-base-url/tsconfig.json)：只有 paths，没有 baseUrl。因此不能把增加 baseUrl 当作所有路径问题的通用修复。
- [transform-import.test.ts](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/packages/shadcn/src/utils/transformers/transform-import.test.ts)：覆盖带嵌套目录的 components/ui 前缀及生成导入的重写。
- [get-config.ts](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/packages/shadcn/src/utils/get-config.ts) 与 [transform-import.ts](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/packages/shadcn/src/utils/transformers/transform-import.ts)：分别负责配置路径解析和组件导入重写。官方 [components.json 文档](https://ui.shadcn.com/docs/components-json#aliases) 也说明 aliases 用于决定文件位置及改写导入。

这些上游证据表明嵌套前缀有明确实现与测试；本机组合的实验结果见第 5 节，不用上游测试替代本地运行。

## 3. 开源项目参考

| 项目与固定提交 | 核查内容 | 参考边界 |
| --- | --- | --- |
| capty-app/capty，`9da6f36f7104019682ce72d06afacec890407e1b` | [tsconfig](https://github.com/capty-app/capty/blob/9da6f36f7104019682ce72d06afacec890407e1b/tsconfig.json) 使用 `@/* -> ./src/*`；[components.json](https://github.com/capty-app/capty/blob/9da6f36f7104019682ce72d06afacec890407e1b/components.json) 的五个 aliases 都指向 `@/renderer/...`；[button.tsx](https://github.com/capty-app/capty/blob/9da6f36f7104019682ce72d06afacec890407e1b/src/renderer/components/ui/button.tsx) 实际导入 `@/renderer/lib/utils`。 | Electron/React/shadcn 实例；使用 Vite 5 与 electron-builder，不能代替本项目 Forge/Vite 8 验证。 |
| liruifengv/amon-agent，`e8ca2925f8e6f8ef0aad72b559f22aff6306f790` | [components.json](https://github.com/liruifengv/amon-agent/blob/e8ca2925f8e6f8ef0aad72b559f22aff6306f790/components.json) 同样配置五个 `@/renderer/...` aliases；[renderer Vite](https://github.com/liruifengv/amon-agent/blob/e8ca2925f8e6f8ef0aad72b559f22aff6306f790/vite.renderer.config.ts) 将 `@` 指向 src；[button.tsx](https://github.com/liruifengv/amon-agent/blob/e8ca2925f8e6f8ef0aad72b559f22aff6306f790/src/renderer/components/ui/button.tsx) 使用该 utils 路径。 | Electron Forge + Vite + React，构建组织更接近本项目；但使用 Vite 5，且 tsconfig 还有重复的 renderer 映射，不照抄整份配置。 |

这些证据确认了公开项目中的实际写法；本轮没有克隆、构建这些项目，也没有确认其组件最初由哪次 CLI 命令生成，因此不把它们称为本项目已验证的最佳实践。

## 4. 错误线索与当前证据缺口

- 上游 [Windows 生成实体 @ 目录问题 #11044](https://github.com/shadcn-ui/ui/issues/11044) 报告 CLI 4.11/4.12 下组件写入错误位置；报告者后续表示补齐根 tsconfig 的 paths 后解决。这提示需要分别核对 CLI 读取的 tsconfig 和构建使用的配置，不能只看编辑器是否能跳转。本项目当前根 tsconfig 已直接配置 paths，不能据此认定与该报告同因。
- 用户以前的错误尚无具体版本和日志，无法判断是路径解析、导入重写、Vite 解析还是 registry 获取问题。
- 本项目 [前端重构记录](frontend-refactor.md#9-当前完成状态) 写明：shadcn CLI 4.21.0 的 add 曾在 registry 阶段长时间未返回；停止后从官方 registry 手动引入 13 个组件并调整导入。因此现有前端构建通过不能作为 shadcn CLI 生成路径通过的证据，也没有证据将当时的等待归因为别名。

## 5. Windows 隔离 CLI 实验

前端交接后，先在 `output/alias-validation-1790104668534/fixture` 准备同样的 src/renderer 布局、根 paths、五个 components aliases 和 Vite 8.3.0 / TypeScript 7.0.2 / Tailwind 4.3.3。使用固定 CLI 4.21.0，未改根项目的 package.json、锁文件或现有组件；实验材料不提交 Git。

| 实际命令 / 检查 | 结果 |
| --- | --- |
| `shadcn info --json`，指定 fixture cwd | 五个 resolvedPaths 均指向预期 src/renderer 子目录，不需要 baseUrl。只有在不存在 components/ui 目录时，此命令才未触发 registry 请求；不能将 info 一概视为离线检查。 |
| `shadcn add button dialog sidebar --dry-run` | 预览为 renderer 下 9 个组件/Hook 文件，覆盖组件间依赖和 use-mobile。 |
| `shadcn add button dialog sidebar --yes` | 实际创建 9 个文件；8 处生成的别名导入均使用 `@/renderer/...`，没有实体 @ 目录或重复 renderer 层。 |
| fixture 的 TypeScript 检查与 Vite renderer build | 通过；入口实际导入生成的 Button、Dialog、SidebarProvider 与 Sidebar，构建遍历其组件依赖。 |

上述 add 成功使用了 CLI 支持的 `REGISTRY_URL`：指向临时 loopback 转发服务，由 Node fetch 取得 `https://ui.shadcn.com/r/...` 的官方响应，逐字节转发并记录状态、大小与 SHA-256，没有改写 registry 内容或关闭 TLS 校验。CLI 子进程临时移除 ALL_PROXY/all_proxy 并对 loopback 设置 NO_PROXY；未修改全局代理、npm 配置或系统设置。

直接 CLI 请求在本机代理环境中等待至超时；追踪发现 SOCKS 路径未绕过 loopback 的 NO_PROXY，转发服务最初没有收到请求。独立 Node fetch 同一官方站点成功。这验证了通过受控传输后的真实 CLI 路径与生成行为，**不代表直接联网问题已修复**，也不能确定用户历史报错或此前前端 add 等待的原因。

另有两个需要区分的观察：

- CLI 4.21.0 的 tooltip 终端提示仍给出 `@/components/ui/tooltip`，生成文件则正确使用配置前缀；照抄该提示到本项目会出错。
- 当前 registry 生成文件直接依赖 `cn` 包；utils 的 resolvedPath 已确认，但本轮新生成组件没有实际使用 utils alias，不能将其写成该导入重写的运行证明。根项目已有的 utils 导入随迁移改为 `@/renderer/lib/utils`，由项目类型检查及构建覆盖。

实验中首次 npm 安装超时留下 fixture 的不完整依赖，后用根锁文件作为解析基线，再在 fixture 执行 `npm ci --ignore-scripts` 完整恢复；首次 typecheck 还缺少根项目已有的 CSS 声明，补入后通过。均仅涉及隔离夹具，没有借此改动产品依赖。

路径断言见 `fixture-paths.json`；CLI 命令及退出状态见 `info-empty-result.json`、`loopback-preview-result.json`、`loopback-add-locked-result.json`，官方响应摘要见同目录 `*-transport.json`，最终类型与构建日志为 `fixture-typecheck.log`、`fixture-build.log`。

## 6. 项目迁移范围与验收边界

在前端完成快照上修改 55 个源码/测试文件的 125 处模块路径，以及根 tsconfig、components 和三份 Vite 配置。独立复核逐一确认新旧路径指向同一源文件，模块字面量之外的源码保持原样；package.json 与锁文件字节未变。没有改前端业务逻辑、测试断言、运行时文件定位或外部 workflow 的原生导入。

`npm.cmd run typecheck` 和 `npm.cmd test` 102/102 通过。生产构建、19 进程桌面矩阵、Forge 开发/HMR 和打包运行的具体报告与首轮失败均见 [verification.md](verification.md)。preload 当前仅导入 electron，没有本地别名；其配置与构建已覆盖，但没有单独新增一个虚构业务导入来宣称该场景已实测。CSS 内暂未使用 `@/` 导入，未来引入时须复核 Vite 的 tsconfig include 范围。
