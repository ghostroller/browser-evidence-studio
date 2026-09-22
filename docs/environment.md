# 环境与依赖

更新日期：2026-09-22。开发与验收基线为 Windows x64、Node 24 LTS 和 npm。客户端源码、依赖、精确锁文件和构建入口已经落地；实际通过的场景与尚未完成的验收以 [验证记录](verification.md) 为准。

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

## 安装和启动

在仓库根目录、已经配置 fnm 的 PowerShell 中执行：

```powershell
fnm install 24.21.0
fnm use 24.21.0
node --version
npm.cmd --version
npm.cmd ci
npm.cmd start
```

版本检查应分别输出 `v24.21.0` 和 `11.19.0`。首次安装 Node 后，后续只需切换版本；进入目录本身不保证当前终端已切换。独立命令也可以显式指定：

```powershell
fnm exec --using 24.21.0 npm.cmd run typecheck
fnm exec --using 24.21.0 npm.cmd test
fnm exec --using 24.21.0 npm.cmd run build
```

不要混用其他包管理器锁文件。常规复现使用 `npm ci`；版本升级应作为独立变更修改锁文件并重跑相关验证。不需要全局安装 Electron、Puppeteer 或测试 CLI。`puppeteer-core` 不自带独立 Chrome：客户端使用 Electron，独立示例通过可执行文件路径选择测试浏览器。

## Vite 构建边界

按用户的实施要求，项目已从最初的 Webpack 方案改为 Electron Forge + Vite；旧 Webpack 配置和依赖已移除。

- `vite.main.config.mjs` 构建 `.vite/build/index.js` 和 `runner-worker.js`。
- `vite.preload.config.mjs` 构建 `.vite/build/preload.js`。
- `vite.renderer.config.mjs` 构建 `.vite/renderer/main_window/`。
- Electron main/preload 使用 CommonJS，renderer 使用 ESM；包根没有设置 `type: module`，普通独立示例使用 `.mjs`。
- Vite 负责转译，`npm run typecheck` 单独运行 `tsc --noEmit`。构建成功不等于类型检查通过。

Forge Vite 插件为锁定的非预发布版本；其官方集成说明的成熟度提示仍需结合本项目开发启动、生产构建、桌面测试和包装结果判断。初期 TS7 与 ts-loader 的编译接口不兼容已通过改用 Vite 的构建方案消除，不保留双构建链。配置依据见 [Forge Vite 插件文档](https://www.electronforge.io/config/plugins/vite)。

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

HTTP 服务只供本机访问，地址和连接文件路径可在客户端“连接与环境”查看。连接文件位于 `connection/agent-connection.json`，包含本次启动的访问令牌；协议见 [HTTP API](api.md)。

| 命令 | 检查范围 |
| --- | --- |
| `npm.cmd run typecheck` | 全项目类型检查 |
| `npm.cmd test` | 单元测试和合成站点测试 |
| `npm.cmd run test:integration` | 构建后启动真实 Electron，执行桌面场景并在第二个进程中验证 profile 重启 |
| `npm.cmd run test:desktop` | 与 `test:integration` 相同 |
| `npm.cmd run test:soak` | 同一桌面入口，增加 20 分钟持续录制检查 |
| `npm.cmd run test:example` | 独立 Chrome 中执行示例；需设置 `BROWSER_EXECUTABLE_PATH`，缺少时跳过 |
| `npm.cmd run package` | Forge 生成应用目录 |
| `npm.cmd run make` | Forge 生成 Windows ZIP |

桌面测试自动使用 `output/desktop-<时间戳>/` 保存日志、run 和报告。`desktop-summary.json` 汇总两个 Electron 进程的结果；首阶段失败时不会把未执行的重启检查算作通过。20 分钟检查和打包命令已提供入口，目前不能据此宣称持续运行或发行包验收通过。

## 升级要求

Node/Electron/Puppeteer/rrweb 升级至少复跑目标身份、导航/弹窗、网络正文、rrweb 录制回放、checkpoint 输入锁、profile 持久化、人工交接、取消和关闭清理。记录实际运行时版本及 lockfile hash，按失败范围调整当前受支持组合，不引入旧 Node/Puppeteer 兼容层。

依赖选择参考 [Node 发布政策](https://nodejs.org/en/about/previous-releases)、[Electron 稳定发布](https://releases.electronjs.org/release?channel=stable)、[Puppeteer 环境要求](https://pptr.dev/guides/system-requirements) 和 [浏览器映射](https://pptr.dev/supported-browsers)。不凭 `latest` 标签自动升级，也不采用 alpha/beta 作为基础依赖。Windows ZIP 是当前分发形式，签名、自动更新和真实账号场景验收仍须分别安排。
