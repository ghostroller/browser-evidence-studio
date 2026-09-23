# 环境与依赖

更新日期：2026-09-23。开发与验收基线为 Windows x64、Node 24 LTS 和 npm。客户端源码、依赖、精确锁文件和构建入口已经落地；实际通过的场景与尚未完成的验收以 [验证记录](verification.md) 为准。

## 锁定的组合

| 组件 | 项目版本 | 用途 |
| --- | --- | --- |
| Node | 24.21.0 LTS | 开发工具、测试及独立脚本 |
| npm | 11.19.0 | 唯一包管理器 |
| Electron | 44.4.3 | 桌面窗口、WebContentsView 和内置浏览器 |
| puppeteer-core | 25.11.0 | 连接 Electron 内嵌浏览器及执行普通脚本 |
| rrweb | 2.1.6 | 页面录制与回放 |
| Electron Forge / Vite 插件 | 7.11.2 | 开发启动与分发包装 |
| Vite | 8.3.0 | main、preload、renderer 和 worker 构建 |
| TypeScript | 7.0.2 | 独立类型检查 |
| React / React DOM | 19.3.0 | 客户端界面 |
| Ajv | 8.20.0 | 输入和输出 schema 校验 |
| ws | 8.21.3 | CDP WebSocket 连接 |

[package.json](../package.json) 是直接依赖版本依据，[package-lock.json](../package-lock.json) 固定传递依赖。`.node-version` 固定 Node，`.npmrc` 启用 `engine-strict` 和 `save-exact`；`engines.node` 为 `>=24.21.0 <25`，`packageManager` 为 `npm@11.19.0`。

开发终端的 Node 与 Electron 内置 Node 是两个运行时。Electron 的 Node/Chromium 版本由应用实际报告并写入验证证据，不能从终端 `node --version` 推断。Puppeteer 与 Electron Chromium 的版本对应也不能代替实际能力验证；M0 关键路径已经运行，完整场景仍需逐项验收。

Windows writer 所有权检查调用系统自带 Windows PowerShell 查询进程启动 FILETIME，后台运行且不加载用户 profile；该系统组件与开发终端或 Node 版本管理器无关。查询无法确认身份时拒绝写入/回收并说明原因。writer 标记原子发布需要文件系统支持硬链接，当前已在本机 NTFS 验证；不支持时明确报错，不降级为覆盖已有锁。

## 安装和启动

固定开发目录为 `D:\workspace\browser-evidence-studio`。项目仅约束 Node/npm 版本，不指定安装方式、版本管理器或本机安装路径。准备好 Node 24.21.0 / npm 11.19.0 后，在 PowerShell 中核对版本并执行：

```powershell
Set-Location D:\workspace\browser-evidence-studio
node --version
npm.cmd --version
npm.cmd ci
npm.cmd start
```

版本检查应分别输出 `v24.21.0` 和 `11.19.0`。版本不符时，使用自行选择的安装或切换方式调整后重新检查。进入目录或存在 `.node-version` 本身不保证当前终端已使用正确版本。依赖安装完成后，常用验证命令为：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

不要混用其他包管理器锁文件。常规复现使用 `npm ci`；版本升级应作为独立变更修改锁文件并重跑相关验证。不需要全局安装 Electron、Puppeteer 或测试 CLI。`puppeteer-core` 不自带独立 Chrome：客户端使用 Electron，独立示例通过可执行文件路径选择测试浏览器。验证记录统一使用通用 Node/npm 命令，复现只需准备相同版本的运行时。

## ESM 与 Vite 构建边界

按用户的实施要求，项目已从最初的 Webpack 方案改为 Electron Forge + Vite；旧 Webpack 配置和依赖已移除。

2026-09-23 将根包定为 `"type": "module"`，项目源码、配置和直接执行的 Node 脚本统一使用 ESM 写法。`forge.config.ts` 使用带类型的默认导出，三个 Vite 配置使用 `defineConfig`。Forge 从 7.8.1 起内置通过 jiti 加载 TS 配置；Vite 8 支持 TS 配置并默认先用 Rolldown 打包加载，无需另加 `ts-node`，本项目不要求切换 `--configLoader native`。配置依据见 [Forge TypeScript 配置](https://www.electronforge.io/config/typescript-configuration) 和 [Vite 8 配置](https://v8.vite.dev/config/)。

开发服务器只监听 `127.0.0.1`，使用 `server.port: 0` 让系统分配可用端口；Forge 将实际地址注入 Electron，无需固定为 `5173`。Windows 的 TCP 排除范围可能覆盖默认端口，此时即使没有进程占用也会报 `listen EACCES`。可用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查；使用本配置后直接重新执行 `npm.cmd start`，无需修改系统端口排除项。

- `vite.main.config.ts` 构建 ESM 的 `.vite/build/index.js` 和 `runner-worker.js`。
- `vite.preload.config.ts` 将 TS ESM 源码打包为单文件 `.vite/build/preload.cjs`。
- `vite.renderer.config.ts` 构建浏览器 ESM 到 `.vite/renderer/main_window/`。
- `test/desktop/launch.js` 按根包 ESM 执行；普通独立示例保留 `.mjs`，仍是 ESM，无需为了统一扩展名改名。
- Vite 负责转译，`npm run typecheck` 单独运行 `tsc --noEmit`，覆盖源码、TS 测试以及根目录 Forge/Vite 配置。构建成功不等于类型检查通过。

preload 的 CJS 产物是 Electron sandbox 的运行边界。sandboxed preload 不支持 ESM imports，并且忽略包级 `"type": "module"`；本项目保留 `sandbox` 和 `contextIsolation`，不为了统一扩展名关闭它们。preload 源码照常使用 `import` / `export`，本地依赖由 Vite 打包；运行时不要求加载额外 ESM 文件。[Electron 官方说明](https://www.electronjs.org/docs/latest/tutorial/esm)

`tsconfig.json` 使用 `module: "preserve"` / `moduleResolution: "bundler"`：客户端由 Vite 构建，TS 测试由 `node --import tsx` 加载，不把所有 TS 文件都当作 Node 原生可执行入口。Node 内置模块使用 `node:`；运行时相邻文件通过 `import.meta.url` / `import.meta.dirname` 解析。模块迁移不改变上方锁定的依赖版本，迁移后实际验证结果及尚未重跑的范围见 [验证记录](verification.md)。

Forge Vite 插件为锁定的非预发布版本；其官方集成说明的成熟度提示仍需结合本项目开发启动、生产构建、桌面测试和包装结果判断。初期 TS7 与 ts-loader 的编译接口不兼容已通过改用 Vite 的构建方案消除，不保留双构建链。配置依据见 [Forge Vite 插件文档](https://www.electronforge.io/config/plugins/vite)。

## 源码导入别名与 shadcn

根 `tsconfig.json` 的 `@/*` 统一指向 `./src/*`；跨职责导入使用 `@/main/...`、`@/renderer/...` 等完整目录前缀。三份 Vite 配置启用原生 `resolve.tsconfigPaths: true`，tsx 测试读取同一根配置。shadcn 的五个 aliases 均配置为 `@/renderer/...`；CSS 路径仍相对项目根。不要恢复旧的 `@/* -> ./src/renderer/*` 映射，也不要只改编辑器 paths 而遗漏构建配置。

Windows 隔离实验已验证固定 shadcn CLI 4.21.0 的路径解析、实际生成组件及 Vite 构建。CLI 直接访问 registry 在本机代理环境下未通过；实验通过本机转发取得未经改写的官方响应，具体方法和限制见 [路径方案](import-alias-plan.md)。该版本 tooltip 的终端提示示例仍写 `@/components/ui/tooltip`，生成文件则遵循配置；使用提示示例时需调整为本项目的 `@/renderer/components/ui/tooltip`。这些观察不代表已经确认用户以前的报错原因。

## 安装网络与防火墙观察

本机安装时，npm registry 经现有代理访问出现 TLS reset；让 `registry.npmjs.org` 走 `NO_PROXY` 后安装恢复。该结论仅适用于此次观察：如果已有代理配置遇到同类错误，可在当前终端保留原值并临时追加该域名后重试；无需关闭 TLS 校验或改写全局代理。

```powershell
$previousNoProxy = $env:NO_PROXY
try {
  $env:NO_PROXY = (@($previousNoProxy, 'registry.npmjs.org') | Where-Object { $_ }) -join ','
  npm.cmd ci
} finally {
  $env:NO_PROXY = $previousNoProxy
}
```

Electron 二进制下载与 npm 包下载是独立步骤。本次使用镜像取得对应 Electron ZIP，并已对照官方 SHA-256 校验；镜像下载成功本身不作为完整性证明。常规安装优先沿用 Electron 官方安装流程，若环境需要镜像，应核对版本、平台、架构和官方校验值，具体下载验收记录见 [验证记录](verification.md)。

防火墙检查只发现既有的 **Public 配置文件下 Node 入站阻止规则**。本机 loopback HTTP/CDP 实测正常，未更改任何防火墙规则；没有证据把这些规则归因于 npm 的 TLS reset，也无需为本机工作台广泛开放入站端口。

## 运行数据和验证入口

开发客户端默认使用 `%APPDATA%\BrowserEvidenceStudio-dev`；打包应用使用 `%APPDATA%\BrowserEvidenceStudio`。环境变量 `BES_DATA` 可指定独立数据根目录。profile、run 和 HTTP 连接文件在数据根目录下管理，运行数据不随源码或发行包提交。

客户端启动时应用 `chrome-compatible-v1` 浏览器策略，详情见 [架构说明](architecture.md#34-内嵌浏览器兼容策略)。升级源码后需完全退出旧客户端，再用 `npm.cmd start` 启动；仅刷新页面无法更新启动配置。继续选择原项目/profile 即可保留客户端自己的登录环境。开发与打包应用的数据根不同，不能用旧 ZIP 验证新源码，也不要复制普通 Chrome 的 Cookie 或 profile。每次新录制的 manifest 会保存实际策略和 UA。

HTTP 服务只供本机访问，地址和连接文件路径可在客户端“连接与环境”查看。连接文件位于 `connection/agent-connection.json`，包含本次启动的访问令牌；协议见 [HTTP API](api.md)。

| 命令 | 检查范围 |
| --- | --- |
| `npm.cmd run typecheck` | 全项目类型检查 |
| `npm.cmd run browser:baseline` | 独立无采集 Electron 对照窗口，默认打开京东；每次使用全新 profile |
| `npm.cmd run browser:baseline -- --verify` | 仅访问本机合成站点，验证无调试端口的首次导航/刷新/iframe/弹窗、隔离和关闭 |
| `npm.cmd run browser:baseline -- --recording` | 独立构建普通客户端并使用全新数据目录，作为开启采集的对照；项目/profile/run 仍通过原 UI/HTTP 创建 |
| `npm.cmd test` | 单元测试和合成站点测试 |
| `npm.cmd run test:integration` | 构建后执行桌面/profile 重启、五种强杀与两次重开，以及重复退出诊断，共 19 个 Electron 进程 |
| `npm.cmd run test:desktop` | 与 `test:integration` 相同 |
| `npm.cmd run test:soak` | 同一桌面入口，增加 30 分钟固定合成负载、性能与证据重开检查；`-- --soak=1` 为短预检 |
| `npm.cmd run test:example` | 独立 Chrome 中执行示例；需设置 `BROWSER_EXECUTABLE_PATH`，缺少时跳过 |
| `npm.cmd run package` | Forge 生成应用目录 |
| `npm.cmd run make` | Forge 生成 Windows ZIP |

桌面测试自动使用 `output/desktop-<时间戳>/` 保存日志、run 和报告。`desktop-summary.json` 汇总各进程结果；首阶段失败时不会把未执行的重启检查算作通过。强杀/缺少完整报告的进程不会被标为普通测试通过，恢复案例由重开后的独立断言判定。诊断记录位于数据根目录 `diagnostics/`，含实例/PID、最后阶段和退出原因；20 分钟旧快照不证明进程仍在运行。Windows ZIP 与打包 EXE 两进程验证是历史记录，当前源码的最新通过范围与产物对应关系见 [验证记录](verification.md)。

### 无采集浏览器对照

`browser:baseline` 用相同 Electron、`chrome-compatible-v1`、WebContentsView、安全设置和权限拒绝策略，独立启动人工浏览窗口；不初始化 Studio、Puppeteer、CDP 调试端口、rrweb、业务 preload 或 HTTP 控制服务。菜单提供起始页、后退/前进、刷新和关闭；HTTP(S) 弹窗保留 opener 和同一 session。该入口用于诊断，不提供录制或 agent 接管。

默认访问 `https://www.jd.com/`，其他站点可用 `npm.cmd run browser:baseline -- --url=https://example.com/`。`--verify` 不接受外站 URL。构建入口为 `src/main/browser/baseline.ts`，启动器直接调用锁定的 Vite，输出到本次 `output/browser-baseline-<时间戳>-<PID>/build/`，不覆盖 Forge 的 `.vite/build`。当前客户端不需要退出。

`--recording` 与 `--verify`、`--url` 互斥，使用现有三份 Vite 配置另行构建正常客户端到 `output/browser-recording-<时间戳>-<PID>/`，全新数据根为其 `data/`。该模式包含正常调试/采集与原 HTTP 协议，需在 UI 或 HTTP 中创建项目、profile 和 run，不自动复制登录态，也不提供新的控制协议。

每次启动在上述独立目录创建新的 `profile/` 和 `session-data`，不继承 `BES_DATA` 或现有登录环境；真实登录需人工完成。目录已被 Git 忽略，可能包含本地登录态，不应提交或分享。`build-modules.json` 保存依赖图，普通运行仅保存启动元数据 `ready.json` 和首次加载结果 `initial-load.json`，不保存网页正文、网络内容或账号信息。首次加载完成不等于登录或业务验收成功。合成模式另写 `verification.json`。

这个对照同时去掉调试/采集初始化，并使用新 profile。若京东正常，还需与新 profile 的正常录制模式比较，不能直接宣布 rrweb 是根因；若仍异常，再评估 Electron 原生能力/session 和标准 Chrome/Edge 模式。详见 [对照记录](browser-compatibility-reference.md)。

## 升级要求

Node/Electron/Puppeteer/rrweb 升级至少复跑目标身份、导航/弹窗、网络正文、rrweb 录制回放、checkpoint 输入锁、profile 持久化、人工交接、取消和关闭清理。记录实际运行时版本及 lockfile hash，按失败范围调整当前受支持组合，不引入旧 Node/Puppeteer 兼容层。

依赖选择参考 [Node 发布政策](https://nodejs.org/en/about/previous-releases)、[Electron 稳定发布](https://releases.electronjs.org/release?channel=stable)、[Puppeteer 环境要求](https://pptr.dev/guides/system-requirements) 和 [浏览器映射](https://pptr.dev/supported-browsers)。不凭 `latest` 标签自动升级，也不采用 alpha/beta 作为基础依赖。Windows ZIP 是当前分发形式，签名、自动更新和真实账号场景验收仍须分别安排。
