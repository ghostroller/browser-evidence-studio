# 调研归纳与设计决策

日期：2026-09-22。性质：设计依据，不是新客户端的功能验收报告。

## 1. 证据范围

本文件汇总本次讨论、旧项目经验、官方文档和定点源码核查。Replay、Workflow Use、Crawl4AI、Stagehand 的关键源码固定到下列提交；Anchor/Director 等闭源产品仅核对公开文档，没有验证服务端实现或脱平台导出。没有做跨工具成功率排行榜。

本轮未安装运行这些第三方产品，也未复制其业务源码。Node 安装与本地环境核对另见 environment.md。未来直接采用依赖或复制代码时核查对应版本 LICENSE 和维护状态，不把概念借鉴等同于代码可任意复制。

## 2. 人工示范为何保留

既定网页流程由人连续操作可以降低入口探索和无效尝试；checkpoint 的目的说明补足“为什么这样做”。agent 的价值在将样例推广为参数、条件分支、分页、字段语义和错误处理，并基于证据修复。

纯录制没有足够信息自动证明需求：两次翻页不等于全部分页；看见二维码不等于登录；出现数据不等于字段正确；同一数量不等于同一实体。记录与验收必须分开。

从零开发也采用同一流程：先说明目标/输出/范围，用人工示范提供入口和样例，agent 列出未知分支并定向补录，再实施和验证。没有旧代码时尤其需要输入输出契约和反例，而不是扩大盲目探索。

## 3. 开源源码核查

### 3.1 Chrome Recorder / Puppeteer Replay

固定提交：f1d6128631bf6aa08e705ecc9040f9df22d94de8。

实际结构是线性 UserFlow.steps，覆盖常见点击、输入、导航、滚动、等待和 selector 候选；框架提供执行前后钩子及步骤到生成代码的映射。没有内建完整采集循环、数据契约和人工协助。

值得借鉴动作 schema、定位候选和 source map。不能直接往第三方 step 塞 checkpoint 字段并假定保留：SchemaUtils 解析会重建已知字段；customStep 也需要自己实现执行/导出。原生 JavaScript 修改后不能承诺反向还原录制 JSON。

来源：[Schema](https://github.com/puppeteer/replay/blob/f1d6128631bf6aa08e705ecc9040f9df22d94de8/src/Schema.ts)、[Parser](https://github.com/puppeteer/replay/blob/f1d6128631bf6aa08e705ecc9040f9df22d94de8/src/SchemaUtils.ts)、[Runner](https://github.com/puppeteer/replay/blob/f1d6128631bf6aa08e705ecc9040f9df22d94de8/src/Runner.ts)、[Stringify](https://github.com/puppeteer/replay/blob/f1d6128631bf6aa08e705ecc9040f9df22d94de8/src/stringify.ts)、[官方导入导出说明](https://developer.chrome.com/docs/devtools/recorder/reference)。

此前与 Node14/Puppeteer10 的冲突不再是本项目选型约束。我们仍不直接采用 Replay 作全部运行时，因为业务表达与人工协作边界不同。

### 3.2 Workflow Use

固定核心提交：5d2d19fe8835cc86f1bf3e04302a5000d590f249。

工作流 JSON 由自有 Python/browser-use 运行时解释执行；schema 主要是有序动作，包含参数和输出，未见原生条件/循环/人工接管步骤。它提供“演示/历史→增强步骤”的思路，但不是独立 Puppeteer 脚本导出器。

no-AI 入口仍可能把提取模型交给执行器；未提供模型的某路径只返回部分文本。失败 fallback 部分调用被注释或抛错。因此借鉴生成与执行分离、目的说明和定位候选，不把宣传直接当成熟实现证明。

来源：[Schema](https://github.com/browser-use/workflow-use/blob/5d2d19fe8835cc86f1bf3e04302a5000d590f249/workflows/workflow_use/schema/views.py)、[Workflow service](https://github.com/browser-use/workflow-use/blob/5d2d19fe8835cc86f1bf3e04302a5000d590f249/workflows/workflow_use/workflow/service.py)、[Semantic executor](https://github.com/browser-use/workflow-use/blob/5d2d19fe8835cc86f1bf3e04302a5000d590f249/workflows/workflow_use/workflow/semantic_executor.py)、[History converter](https://github.com/browser-use/workflow-use/blob/5d2d19fe8835cc86f1bf3e04302a5000d590f249/workflows/workflow_use/healing/deterministic_converter.py)。
人工录制/builder 路径另读过 main，未将其全部文件视为已固定审计：[Recorder](https://github.com/browser-use/workflow-use/tree/main/workflows/workflow_use/recorder)、[Builder](https://github.com/browser-use/workflow-use/tree/main/workflows/workflow_use/builder)。

### 3.3 Crawl4AI

固定提交：862f6bccb9c063f49b9d42701baa0eea17a4993f。

模型生成 baseSelector/fields，CSS/XPath 解析器随后确定性执行；可以在保存 HTML 上校验并把错误反馈给生成阶段。这适合借鉴为 agent 离线编写字段规则的流程，不要求每页推理或引入 Python 运行时。

其成功判据并非全数据业务验收：字段在部分记录中非空即可满足某些检查，修订耗尽仍可能返回 best-effort schema。我们的验收应额外检查覆盖、类型、身份和分页。

来源：[规则执行、生成与校验](https://github.com/unclecode/crawl4ai/blob/862f6bccb9c063f49b9d42701baa0eea17a4993f/crawl4ai/extraction_strategy.py)。

### 3.4 Stagehand

固定提交：4146eeaf1b3ecf73a8bc29c9bb97dbe0633c01f2。

observe 使用页面快照/元素映射生成 Action，包括 selector、description、method、arguments；结构化 action 可走确定性执行，但 selfHeal 仍可能回到 LLM。extract 是推理当前页面的值，不等于生成永久选择器规则。

借鉴真实元素映射、观察与执行分离、推理/缓存计量。当前产品不采用 Stagehand 作为插件运行依赖。v4 文档说明自身 CDP 执行层和本地缓存限制，不能从“可导出源码”推导“独立无模型执行”。

来源：[observe](https://github.com/browserbase/stagehand/blob/4146eeaf1b3ecf73a8bc29c9bb97dbe0633c01f2/packages/extension/services/observeService.ts)、[act](https://github.com/browserbase/stagehand/blob/4146eeaf1b3ecf73a8bc29c9bb97dbe0633c01f2/packages/extension/services/actService.ts)、[extract](https://github.com/browserbase/stagehand/blob/4146eeaf1b3ecf73a8bc29c9bb97dbe0633c01f2/packages/extension/services/extractService.ts)、[v4 迁移](https://docs.stagehand.dev/v4/migrations/playwright)、[缓存](https://docs.stagehand.dev/v4/best-practices/caching)。

## 4. 可直接借鉴的产品功能

Anchor 的文档描述了人工演示、参数/输出定义、UI/Network/Logic/Agent 分工、代码段编辑、运行历史与步骤关联。值得参考：
- 演示时同时标记元素和数据含义。
- 演示结束后确认参数，避免硬编码样例值。
- checkpoint 一处查看材料、代码和实际运行结果。
- 失败修复形成新草稿/版本，再测试。
- 将 AI fallback 显式标记，允许确定性运行。

其 JSON 可包含代码段，证明结构化描述与代码可以共存；独立脱平台完整导出未确认。我们采用薄 manifest+代码引用，不照搬代码字符串和完整图引擎。

来源：[创建流程](https://docs.anchorbrowser.io/tasks/creating-a-task)、[运行与评审](https://docs.anchorbrowser.io/tasks/overview)、[工作流 schema](https://docs.anchorbrowser.io/advanced/legacy-tasks)。

Director、Skyvern 的代码生成/缓存属于相关思路，生成源码、平台缓存和本地独立脚本是不同交付物。ScrapeGraphAI/Playwriter/Playwright Codegen 属于补充研究线索，本轮未全部定点源码复核，不以报告中所有描述作为已验证事实。

## 5. 录制基础组件的取舍

| 工具 | 可参考或复用 | 本项目边界 |
| --- | --- | --- |
| rrweb | DOM 序列、页面回看和时间线 | 采用当前稳定版做基础回放；网络正文/业务验收另建 |
| browser-recorder | 调试信息打包和自包含查看体验 | 不直接把浏览器扩展当 Electron 客户端架构 |
| OpenJam | console/network/截图/回放聚合 | 学习交互与证据组合，不继承未经本项目验证的完整性承诺 |
| Chrome Recorder | 动作语义和代码骨架 | 可借鉴/后续互导，不是全部业务运行时 |
| Playwright 工具链 | 合成测试和观察体验 | 不继承旧 CLI daemon/trace 私有格式或 alpha 依赖 |

rrweb 已核实稳定版本 2.1.6（2026-09-18），不是只有旧版或 alpha。录制器/播放器同版本锁定，M0 验证跨导航、frame、资源和分块。未验证的高保真场景不能宣称支持。

来源：[rrweb release](https://github.com/rrweb-io/rrweb/releases/tag/rrweb@2.1.6)、[npm 元数据](https://registry.npmjs.org/rrweb)、[browser-recorder](https://github.com/HabitatHQ/browser-recorder)、[OpenJam](https://github.com/SaintPepsi/openjam)。

旧研究发现过正文限制与来源关联问题，但这属于旧版本观察，不直接套用到这些工具的当前版本。新客户端对原件完整性按自己的夹具验收。

## 6. 旧项目经验

参考 D:/workspace/agent-browser-evidence；另有实现工作树 C:/Users/Administrator/.codex/worktrees/6d5b/agent-browser-evidence。只读文档与相关实现，没有读取真实账号 raw。旧项目不是新仓库运行依赖。

保留：
- 稳定证据 ID、来源、captureStatus、查询预算和可重建索引。
- 控制权/执行/采集三个维度。
- 探索与验证分离，指纹绑定，未覆盖和证据不足不可通过。
- 先索引后正文、可换会话的交接包、实测成本。

改进：
- 对开发终端或版本管理器包装的运行依赖、残留进程/锁由客户端生命周期管理消除。
- 不让普通用户输入元素 ref 或人工管理浏览器 daemon。
- checkpoint 立即反馈、图/DOM 快路径、索引后台增量处理。
- 最新旧 UI 已去除站点模板/阶段推进，新客户端继续以 checkpoint 为中心。
- 蒙版只锁输入，不伪称冻结动态网页。
- 旧依赖链曾含 Playwright alpha；新项目重新锁稳定版，不整体搬代码或锁文件。

可按需参考：[旧需求](D:/workspace/agent-browser-evidence/docs/requirements.md)、[旧证据约定](D:/workspace/agent-browser-evidence/docs/evidence-contract.md)、[旧经验](D:/workspace/agent-browser-evidence/docs/lessons-and-sources.md)。缺少这些目录也应能根据新文档开发。

## 7. 决策记录

| 决策 | 采用 | 原因与代价 |
| --- | --- | --- |
| D01 独立客户端 | 新仓库、Electron | 获得输入控制、持久状态、统一交互；需维护桌面生命周期 |
| D02 稳定现代环境 | Node LTS、稳定 Electron/自动化库 | 减少历史兼容负担；当前稳定组合仍需联通测试 |
| D03 执行表示 | 薄 JSON 契约 + 原生代码 | 元数据可展示/查询，复杂逻辑可维护；不提供任意代码反编译成流程图 |
| D04 框架 | Puppeteer 先行 | 与目标代码习惯一致；Playwright 业务适配按需求后置 |
| D05 录制 | rrweb + CDP + checkpoint | 复用 DOM 回放基础设施，独立保证网络/截图证据 |
| D06 接口 | 一个本机 HTTP API | 避免 CLI 人机使用障碍和多套协议维护 |
| D07 协作 | 显式控制权/人工请求/完成检查 | 降低脱节和长期等待；扫码仍依赖人可用 |
| D08 登录 | 命名持久 profile | 本机复用简单；不保证跨机器/任意内存状态迁移 |
| D09 验收 | 需求/数据/证据/版本一起绑定 | 避免截图像、非空或旧 pass 造成误判 |
| D10 范围 | 不做旧环境、旧格式、插件装配 | 限制首版规模，外部项目自行迁移 |
| D11 模型 | 开发和诊断时用，运行默认不用 | 成本更可控；异常要修代码并重新验收 |
| D12 成本 | 分块证据和有界读取 | 录制长不等于上下文长；不声称 JSON 天然省 token |

## 8. Electron 的现实边界

WebContentsView 提供原生视图，但宿主普通 DOM 遮罩不天然覆盖它；需要真正的视图层控制。远程页面关闭 Node 集成并隔离可信 UI。CDP 目标范围、DevTools detach、稳定 Chromium 版本差异和登录持久化列为 M0/M3 验收，不通过文档推导替代实验。

来源：[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[Electron 安全边界](https://www.electronjs.org/docs/latest/tutorial/security)、[Debugger](https://www.electronjs.org/docs/latest/api/debugger)、[Session](https://www.electronjs.org/docs/latest/api/session)、[Puppeteer 支持浏览器](https://pptr.dev/supported-browsers)。

Playwright 的 CDP 连接保真度低于其自有协议，Electron 自动化入口仍有实验性质，故不承诺首版与 Puppeteer 全量对等。[CDP 说明](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)、[Electron 自动化测试](https://www.electronjs.org/docs/latest/tutorial/automated-testing#using-playwright)。

## 9. 成本与推广

JSON 更易索引和校验，但冗长 JSON、重复 DOM、截图和反复失败同样耗上下文。客户端需要让 agent 一次取得摘要/缺口，再按 checkpoint/字段取证；离线规则验证减少重复扫码。实际 token 只在有供应商计量时记录，其他仅记字节/时间，估算另标。

推广到其他采集器依赖稳定的证据/人工交接/reporter/验收合同，不依赖拼多多字段和页面。新站点先声明输出/范围/代表变体，复用同一夹具与工具能力验收，业务断言由各脚本维护。
