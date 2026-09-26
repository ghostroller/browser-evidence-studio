# SPEED-P 交接、发行资源与独立脚本

日期：2026-09-26。工作树：`C:\Users\Ghost\.codex\worktrees\finish-delivery\browser-evidence-studio`；基线 `046a52e7432fdcebb9524b661ebf4166b80acba1`；分支 `codex/finish-delivery-20260926`。本文件只记录 P 流实测，最终集成与发布候选由主控确定。

## C04 固定资料交接

- `manifest.json` 升为 `schemaVersion: 2`，只存 `projectId/revisionId/contentHash`、`counts`（requirements、fields、checkpoints、annotations、recordingRefs、unboundFields）、`read`、`sourcePolicy/excluded/taskSha256`。不把资料缩到 64 KiB，也不将单个分页 cursor 固定进交接。
- `access.json` 独立存当前 `instanceId`、`authorization`（ID、有效期、capabilities、session/profile/pages）、`connectionFile`、发行版可直接读取的 `skillFile` 和可选 `scriptDirectory`。`task.md`、`manifest.json` 可在新实例重新导出时保持逐字相同；access envelope 必须重新获取，不从旧实例推断有效授权。三文件在同一临时目录写入并原子公布。
- 固定读取：`POST /v1/projects/:projectId/query/materialRevision` 请求体含 `{authorizationId, revisionId, contentHash}`；然后 `POST /v1/projects/:projectId/query/materialCollection` 请求体含 `{authorizationId, kind:"revision", revisionId, contentHash, collection, limit, maxBytes, cursor?}`。`collection` 依次取 `manifest.read.collections`，以本次 `nextCursor` 逐页读到终点并核对计数。cursor 失效时按固定 revision/hash 重新开始该集合。`history-read` 是历史证据的独立能力，只有资料权限不宣称已验证历史。
- ID 隐私检查保留安全字符与已知凭据值形态过滤；名称含 `token`/`credential` 的合法字段或 dataset 不因此视作秘密值。大量资料 ID 按授权 API 读取；描述、源正文、Bearer、Cookie、截图和 profile 不进入交接文件。

## C05 发行与独立运行

- Forge `extraResource` 将 `skills/browser-evidence-studio` 复制到 `resources/browser-evidence-studio`，将 `examples/orders` 复制到 `resources/orders`，并将已构建的 `portable-runner.mjs` 放在 `resources`；它们留在 asar 外，供 Studio 关闭后的普通 Node/Agent 读取。发布路径由 `app.isPackaged`、`process.resourcesPath` 解析；开发路径由 `app.getAppPath()` 解析。应用归档仍只收 `.vite`、运行依赖和根 package/lock。
- `resources/orders` 自有 `package.json`/`package-lock.json`，声明 `puppeteer-core` 与 Ajv；独立入口继续使用普通 Puppeteer、原结果/部分失败语义。测试将目录复制到仓库外临时目录并在那里 `npm ci`，不复用仓库 node_modules。只使用本地合成站点和新浏览器 profile。
- `npm run test:release-assets -- PATH_TO_APP_ASAR` 检查 asar 的 main/preload/worker/portable helper 和外置 skill/reference/example，且排除 docs/output/test、账号示例。`npm run test:example` 是外部目录安装与 Chrome 合成流程入口。

## 当前证据与待完成门

- Node `v24.21.0`、npm `11.19.0`；本树 `npm ci --no-audit --no-fund` 成功（682 packages）。
- `npm exec vitest run test/unit/fixed-task-handoff.test.ts test/unit/task-authorization.test.ts`：2 文件、11 项通过；包含 250/1000 checkpoint 全页读回、V1 不随 V2 改写、不同实例 envelope、撤销与隐私。`npm run typecheck` 通过。
- `PYTHONUTF8=1` 运行 skill-creator `quick_validate.py skills/browser-evidence-studio`：有效。Windows 默认 GBK 直接运行会因 UTF-8 中文解码失败；这不是 skill 内容错误。
- 获独占桌面令牌后，早期 P 候选 `npm run package` 成功（`output/p-package-precheck.log`）；`npm run test:release-assets -- out/.../resources/app.asar` 检查内部 main/preload/worker/helper 与外置 skill/reference/example/helper 通过。Windows asar 列举/读取需要使用本机路径分隔符，检查脚本在首次预检失败后已修正并复跑通过。
- `BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` 下 `npm run test:example`：2/2 通过。测试在仓库外临时目录执行自己的 `npm ci`，Studio 未运行；normal/duplicate 为预期 pass，missing/wrong-image/empty-middle 为预期 fail，结果由测试回读。日志 `output/p-standalone-precheck.log`。Node 对测试中 `shell:true` 的静态 npm 参数发出弃用/风险提示，未改变本次结果。
- 早期安装版 `--refactor-handoff`、`--refactor-system`、`--refactor-recording` 均通过；录制专项含 record 与 offline 两个进程阶段。日志 `output/p-packaged-handoff-precheck.log`、`p-packaged-system-precheck.log`、`p-packaged-recording-precheck.log`；结果目录分别为 `output/desktop-1790423479032`、`output/desktop-1790423531897`、`output/desktop-1790423639162`。system 日志出现关窗期间 `Untrusted or closing UI sender` 403，但阶段报告为 pass；最终候选应保留该诊断并核对退出路径。
- 早期 `npm run make` 成功，ZIP 为 `out/make/zip/win32/x64/Browser Evidence Studio-win32-x64-0.1.0.zip`，大小 172,777,585 bytes，SHA-256 `9590AC461FCE5058A4E7546DC851EF012A471FCFAB756E737599DF10E68399C0`。解压至 `output/p-zip-extracted-1790423771518` 后静态资源检查通过，解压 exe 的 `--refactor-handoff` 通过（`output/p-extracted-zip-handoff-precheck.log`、`output/desktop-1790423795452`）；其 `access.skillFile` 指向解压目录 `resources/browser-evidence-studio/SKILL.md`。这些都是 `004e422` 加本树未提交的外置 helper 收尾改动上的**早期预检**，不是 G2/G3 冻结集成提交。最终 AT39 尚未执行。

## G3/AT39 接续

1. 用最终冻结候选执行 typecheck/build/package/make；对实际 `resources/app.asar` 执行 `test:release-assets`，核对 ZIP 中同一资源，再持桌面令牌从发行版 exe 跑 `--refactor-handoff`，检查 `access.skillFile` 可由普通文件读取。
2. 从 `resources/orders` 复制独立项目到仓库外空目录，用自身 lock `npm ci`，在 Studio 关闭后以独立 Chrome 和合成站点跑正常及失败变体，保留输出目录与命令/退出码。
3. AT39 必须另起全新模型上下文，只提供真实导出三文件、安装版技能入口、必要授权环境与合成任务目标；不提供实现历史、标准答案、fixture 业务脚本。让新 Agent 根据固定资料产出普通 Puppeteer 实现，解释一次失败并修复；记录身份、候选 SHA、输入和结果。P 的预演不能替代该验收。

### AT39 实时交接夹具（待桌面令牌实测）

- 发行版 exe 从最终 ZIP 解压后，设置父进程环境 `BES_HANDOFF_LIVE=1`，执行 `node test/desktop/launch.js --refactor-handoff --executable="ABSOLUTE_EXTRACTED_EXE"`。入口沿用既有 `refactor-handoff` phase；live 模式只在 P 所有的测试场景分支中，不更改产品接口。主控需将 launcher 的 live 超时延到大于场景的 45 分钟等待期限；普通 handoff 仍是 4 分钟。
- 场景通过 Studio 建立合成订单 project/profile/run、录制位置、固定材料修订，并由受信 UI 发放精确 origin/page/目录授权与点击“准备交给 Agent”。它在系统临时目录生成新的空白工作流目录和交接目录，不写 `workflow.json`、`run.mjs` 或答案。交接目录严格只有 `task.md`、`manifest.json`、`access.json`、`ready.json`；ready 中只有标识、路径、nonce、期限，没有 Bearer。`BES_AT39_READY {...}` 从运行中日志给出这些路径。`access.json` 指向已安装技能、空白工作流目录和当前用户连接文件；连接 token 不复制进交接。
- 新模型输入边界：只给交接三文件、`access.skillFile` 所指技能及引用、该授权连接路径、合成目标（收集全部订单和详情、分页结束证据、图像身份一致性，解释并修复一次失败）。不给本仓库源码、fixture 源码、既有手写业务脚本、之前 Agent 的实现历史或 `ready.json` 内容作为任务说明。新 Agent 必须在 `access.scriptDirectory` 写自己的普通 Puppeteer 工作流，用受限 API 验证。
- 主控在 Agent 完成后向 `ready.json` 中 `completionFile` 写入小 JSON `{"nonce":"<ready.nonce>","status":"completed"}`；Agent 失败则写 `status:"failed"`。该信号位于交接目录之外，只代表验收流程结束，不代表业务需求通过。场景只接受匹配 nonce 的显式信号，最多等待 45 分钟，授权 50 分钟；超时、撤销或失败均不能报成功。退出前撤销授权、关闭 Studio，并写 `at39-live-result.json`。最终业务结论仍由独立 Agent 产物与 Studio 验证记录判定。当前只做 `npm run typecheck`，未运行 Electron live 夹具。

### 解压 ZIP 的独立样例测试入口

- `BES_ORDERS_SOURCE_DIR` 可设为绝对路径 `EXTRACTED_ZIP/resources/orders`，`npm run test:example` 会从该目录复制六个发布样例文件到新的系统临时目录，执行其自己的 `npm ci`；占用输出目录断言与 normal、duplicate、missing、wrong-image、empty-middle 五个合成 Chrome 变体共用这份安装副本。未设置时仍以仓库 `examples/orders` 为来源。测试打印实际来源，避免把源码样例误记为 ZIP 验收。
- 在早期 ZIP `output/p-zip-extracted-1790423771518/resources/orders` 上验证：`node --check test/release/orders-standalone.test.mjs`、`npm run typecheck` 通过；设置 `BES_ORDERS_SOURCE_DIR` 和 `BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` 后 `npm run test:example` 2/2 通过。该结果只证明早期 ZIP 的独立样例，不替代冻结集成候选的最终 G3 复测。
