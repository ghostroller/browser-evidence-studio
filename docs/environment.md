# 环境与依赖策略

核对日期：2026-09-22。本机 Windows x64，已有 fnm/Git。只为新客户端选择当前受支持的稳定环境；不承担生成脚本向 Node14 或旧 Puppeteer 的适配。

## 1. 已实际完成

- 通过 fnm 安装 Node 24.21.0。
- 实际执行版本检查得到 node v24.21.0、npm 11.19.0。
- 新仓库 .node-version 固定 24.21.0，.npmrc 开启 engine-strict 和 save-exact。
- 新仓库 Git 初始化为 main。
- 仅准备文档及环境标记，尚未安装 Electron/React/rrweb 等项目依赖，也没有 package.json/锁文件或客户端源码。

在已初始化 fnm 的 PowerShell 中执行 fnm use，会按新项目 .node-version 切换；仅切换目录并不保证所有终端已切换。独立任务可使用 fnm exec --using 24.21.0 显式指定。旧项目和它们的版本文件没有改变。当前无需改系统 PATH、重新安装包管理器或安装全局 Electron/CLI。

## 2. 稳定基线与核实状态

| 组件 | 2026-09-22 核查基线 | 状态/用途 |
| --- | --- | --- |
| Node | 24.21.0 LTS | 本机已安装/运行；开发及独立脚本 |
| npm | 11.19.0 | 上述 Node 捆绑，已运行 |
| Electron | 44.4.3 stable | 官方发布信息已核对，M0 安装验证 |
| Electron 内置运行时 | Node 24.21.0 / Chromium 152.0.7977.130 | 跟随 Electron；不同于系统 Node 的安装 |
| Puppeteer | 25.11.0 stable | M0 选同版本 puppeteer-core；官方浏览器映射 Chrome 153 |
| Playwright | 1.63.0 stable | 可用于工具测试；不作为产品录制底座 |
| rrweb | 2.1.6 stable | M0 录制/播放器同版本锁定 |
| TypeScript / React / Forge / Webpack | 实现首日核对非预发布稳定版 | 按官方模板整合并提交精确锁文件 |

表中“核查”不是“已经在此项目运行通过”。若开工时发布已更新，选择当时受支持的稳定补丁，更新本表并做 M0；不永久坚持过时补丁，也不每次启动自动升级。

来源：[Node 官方分发索引](https://nodejs.org/dist/index.json)、[Node 发布政策](https://nodejs.org/en/about/previous-releases)、[Electron stable](https://releases.electronjs.org/release?channel=stable)、[Puppeteer 环境要求](https://pptr.dev/guides/system-requirements)、[浏览器映射](https://pptr.dev/supported-browsers)、[Playwright release](https://github.com/microsoft/playwright/releases/tag/v1.63.0)、[rrweb release](https://github.com/rrweb-io/rrweb/releases/tag/rrweb@2.1.6)。

Node 26 Current 不作为默认生产基线。采用 LTS 不是为旧代码兼容，而是选择当前稳定维护周期。Electron 和 Puppeteer 的浏览器不同版仍需能力验证；若失败，调整当前稳定组合，不新增旧环境适配层。

## 3. 构建选择

采用 Electron Forge 官方 TypeScript/Webpack 模板 + React。其 Forge/Vite 插件官方仍标 experimental，因此首版不把它作为“稳定默认”。本决定为降低初期不确定性，不禁止后续有测量依据时更换构建工具。

来源：[官方 TS/Webpack 模板](https://www.electronforge.io/templates/typescript-+-webpack-template)、[React 集成](https://www.electronforge.io/guides/framework-integration/react)、[Forge Vite 状态](https://www.electronforge.io/config/plugins/vite)。

不采用 prerelease/beta/alpha 作为基础依赖；latest 标签仍需核查实际版本。rrweb 的旧 alpha dist-tag 仍存在，不代表稳定版不存在。UI 所用依赖与传递依赖均由 package-lock 固定。

## 4. 当前可运行的环境命令

~~~powershell
Set-Location 'D:\workspace\browser-evidence-studio'
fnm use
node --version
npm.cmd --version
~~~

预期分别输出 v24.21.0 和 11.19.0。新机器首次需要：

~~~powershell
fnm install 24.21.0
fnm use 24.21.0
~~~

若 PowerShell 没有配置 fnm 自动切换，也可用明确版本执行一个会结束的开发命令：

~~~powershell
fnm exec --using 24.21.0 node --version
~~~

产品本身由 Electron 管理服务/worker 生命周期，不让普通用户通过 fnm 包装常驻进程并捕获输出。旧工具的管道等待问题不应进入客户端操作手册。

## 5. M0 要落实的包管理约定

生成 package.json 后设置：
- private=true，type=module（依据 Forge 模板的 main/preload 构建边界配置）。
- engines.node 为 >=24.21.0 <25，packageManager 为 npm@11.19.0；以后升级 LTS 时一起更新。
- npm 作为唯一包管理器，提交 package-lock.json，不混入 pnpm/yarn/bun 锁文件。
- 常规重现用 npm ci；升级是单独改锁文件并验证的动作。
- app runtime 使用 Electron 内置 Node；独立交付脚本记录自己的 Node/Puppeteer 环境。
- 不在全局安装 Puppeteer、Playwright CLI 或 Electron。测试浏览器由项目依赖管理。

原生依赖只有证明需要时再引入，并按 Electron ABI 重建验证；P0 文件存储方案无需先引入 native SQLite。不能为了方便安装降低 nodeIntegration 或关闭安全隔离。

## 6. 升级和验收记录

升级 Node/Electron/Puppeteer/rrweb 时至少复跑：内嵌 target、导航/弹窗、网络正文、rrweb 录制回放、checkpoint 输入锁、profile 持久化、人工交接、取消和关闭清理。

记录实际 Node/npm/Electron/Chromium/自动化库版本与 lockfile hash。稳定发布仅是选择前提，功能验收决定可宣称能力。正式分发还需独立安排签名/更新策略；本轮未创建发行包。
