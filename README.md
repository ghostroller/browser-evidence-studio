# Browser Evidence Studio

面向人工示范、agent 开发和逐项验收的本地 Electron 浏览器工作台。

产品名：Browser Evidence Studio（浏览器证据工作台）。项目目录：D:/workspace/browser-evidence-studio。

**当前状态：设计与实施准备完成，客户端功能尚未实现。** 本轮只创建独立项目、Git 和设计文档，并准备现代 Node 环境；没有启动录制、修改旧项目或实现客户端。文档中的接口、目录和命令若标为目标设计，不能当作现成功能。

## 产品闭环

人工操作网页并描述 checkpoint → 保存动作、网络、DOM 和截图证据 → agent 定向读取材料并编写普通 Puppeteer 代码 → 在客户端复跑并按需交还人工 → 按 checkpoint、数据契约和代码版本验收。

工具负责证据、浏览器协作与验收，不承包站点业务逻辑，不维护旧 Node/Puppeteer 兼容层，也不承担业务插件向宿主的迁移和装配。

## 阅读顺序

1. [产品设计与范围](docs/design.md)：场景、交互、MVP 与非目标。
2. [技术架构与协议](docs/architecture.md)：进程、浏览器、证据、控制权、HTTP API 和执行契约。
3. [具体实现路径](docs/implementation-plan.md)：代码位置、里程碑、依赖顺序、验收和首个任务。
4. [调研与决策依据](docs/research.md)：开源源码结论、功能借鉴、已知边界。
5. [环境与依赖策略](docs/environment.md)：已验证环境、稳定版本选取、安装与升级规则。

实现任务先读前 3 份；讨论依赖或技术选型时再按需读后 2 份。不要每轮将全部原始材料放进模型上下文。

## 已确定的方向

- Windows 桌面优先，Electron WebContentsView 内嵌浏览器。
- 人主要使用客户端，agent 首版使用本机 HTTP API；不用 PowerShell 手工管理录制守护进程。
- checkpoint 是核心组织方式；不要求手工建立业务阶段，不内置拼多多站点模板。
- 原始证据、需求契约、执行代码、验收记录分开；JSON 负责记录和契约，代码负责执行逻辑。
- Puppeteer 为首个业务执行框架；采用当代稳定环境，不适配 Node 14 或旧版自动化库。
- 现代框架与 Electron Chromium 的互通仍须实际验证，不能用“都是最新版”代替验证。
- 普通交付脚本不依赖 Electron 客户端或运行时 LLM；扫码等已声明人工协助可以保留。
- agent/人工控制权唯一；暂停业务、暂停记录、结束录制含义分别明确。
- 浏览器观测不自动覆盖 Node HTTP/Axios、手机端或其他进程网络。
- 仅将 D:/workspace/agent-browser-evidence 作为参考；不依赖其代码、daemon、格式或安装路径。

## 当前环境

新项目固定 Node 24.21.0 LTS，使用其捆绑 npm 11.19.0。本机已安装并核对版本。进入目录后可执行：

~~~powershell
fnm use
node --version
npm.cmd --version
~~~

功能实现阶段才生成 package.json、package-lock.json 和客户端源码。本仓库现在没有 npm start 等可运行的客户端命令。详细技术栈及首日锁定规则见环境文档。
