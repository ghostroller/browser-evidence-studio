# 普通 Puppeteer 合成订单示例

`run.mjs` 导出 `run({ page, input, reporter })`。分页、去重、详情分支均在普通 JavaScript 中；`workflow.json` 只声明数据和验收契约。无 Electron、客户端 HTTP 或 LLM 的业务运行依赖。`reporter` 可省略；需要人工协助时必须提供其 `requestHuman`。

## 客户端受管执行

在客户端创建并选择项目及命名登录环境，点击“合成站点”。在“执行 / 验收”登记本目录的绝对路径，并传入 `{ "baseUrl": "http://127.0.0.1:合成端口", "variant": "normal" }`；合成入口会自动填入实际地址。

直接点击“运行脚本并验收”即可创建独立验收 run，无需先“开始录制”。如果已有打开的示范，客户端会先自动封存，并沿用该示范的项目和登录环境；空闲时使用界面所选项目和环境。报告保存完成后可查看结果并封存验收 run，封存后仍可直接再次执行。执行、人工交接、报告保存或停止期间不接受新的验收。

输入 `variant` 可选 `normal`、`duplicate`（均应通过）、`missing`、`wrong-image`、`empty-middle`（均应暴露数据失败）。追加 `"requireLogin": true` 可触发合成登录检查，追加 `"requireHumanReview": true` 可触发范围确认；按客户端的等待提示操作页面并明确交还。已有登录状态时会先验证会话，不保证再次出现登录交接。

## 无需 Electron 的独立测试

确认当前终端使用 Node 24.21.0 / npm 11.19.0，安装或版本切换方式不限。仓库依赖安装完成后，在仓库根目录指定一个已安装的独立 Chrome：

```powershell
$env:BROWSER_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd run test:example
```

将路径替换为本机 Chrome 的实际位置。该命令自行启动 Node 合成站点、执行五个变体并关闭浏览器及站点，不需要运行客户端或连接其 HTTP API。未设置 `BROWSER_EXECUTABLE_PATH` 时测试会跳过，不能视为通过。每个变体的报告写入终端显示的临时目录；预期失败变体返回非零码，由测试核对结果。

## 独立交付入口

单次执行使用 `standalone.mjs`。它需要 Node、`puppeteer-core`、Ajv 和一个已运行的合成站点，以及同目录的 `run.mjs`、`input.schema.json`、`output.schema.json`；当前锁定版本见仓库 `package.json`。`workflow.json` 用于客户端登记，不是独立入口的执行依赖。浏览器由 `--executable-path` 或 `BROWSER_EXECUTABLE_PATH` 指定：

```powershell
node examples/orders/standalone.mjs --url http://127.0.0.1:合成端口 --executable-path 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

将 URL 替换为正在运行的合成站点地址。此单次入口不会启动站点：可使用客户端“合成站点”提供的地址，也可由 Node 调用 `test/fixtures/site/index.ts` 的 `startFixture()` 托管同一测试夹具；上面的 `test:example` 已自动完成后一种方式。脚本面向这套合成订单页面，不能把 URL 换成任意真实商城并期待通用采集。

`--login --review` 显示浏览器并在终端等待明确交还；`--headed` 可单独显示浏览器。超时或空闲不代表登录成功，交还后还会检查真实页面状态。所有浏览器状态均使用 Puppeteer 新建的临时 profile，不访问已有真实账号 profile。

`--output PATH` 指定输出目录（默认在被 Git 忽略的 `artifacts/` 下），包含普通 JSON 数据、截图、DOM、来源附件和事件。独立脚本的顺序截图/DOM不是原子快照，其人工等待也不提供客户端的传输连接闸门。客户端受控执行的版本指纹、需求覆盖和规则验收由客户端单独保存。

示例服务只监听 loopback，全部账号、cookie、二维码、图片与订单为假数据。固定合成 cookie 仅用于测试重启持久化，不能作为任何真实认证实现的参考。
