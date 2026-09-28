# 普通 Puppeteer 工作流

在可信项目登记的空白脚本目录内创建 `workflow.json` 和普通 JavaScript 入口。HTTP 不能指定其他目录或直接提交代码。入口是相对脚本目录的 `.js`、`.cjs` 或 `.mjs` 文件；目录内源码、配置及 lock 文件在执行前整体指纹化，symlink 越界和执行前改动会被拒绝。

`workflow.json` 的最小形状如下；ID 使用字母或数字开头，后续只用字母、数字、下划线、点或连字符，最长 128 字符。真实需求 ID、字段和规则从交接的固定 revision 读取，不要照抄示意占位：

```json
{
  "schemaVersion": 1,
  "workflowId": "chosen-workflow-id",
  "entry": "run.mjs",
  "exportName": "run",
  "driver": "puppeteer",
  "requirements": [
    {
      "id": "fixed-requirement-id",
      "checkpointKey": "chosen-checkpoint-key",
      "description": "What this checkpoint proves",
      "dataset": "chosen-dataset",
      "rules": []
    }
  ]
}
```

`requirements` 至少一项；每项 `id/checkpointKey/description` 必需且 ID 不重复。数据规则需要命名 `dataset`；支持 `required`、`field-type`、`unique`、`min-rows`、`pagination-complete`、`same-entity`、`reference`。可选 `inputSchema/outputSchema` 为目录内 schema 文件名；有依赖时保留自己的 `package.json` 与锁文件。

固定资料执行入口导出 `async function run({ page, input, reporter, steps })`。这里的 page 是受管 Puppeteer Page；导航、分支、分页、等待和选择器属于普通 JavaScript，不另建 JSON 控制流。`steps.run({stepId,run,commit})` 调用 `run(ctx) → Promise<T>`，成功后调用可选 `commit(value,ctx) → Promise<void>`；ctx 为 `{identity:{executionId,stepId,attemptId,entityKey?},signal,awaitHuman}`。commit 的第一个参数是 run 的业务返回值，不是 ctx。使用宿主给出的身份，不自行伪造另一执行的 ID。返回的 StepResult 有 `status/identity`，成功另含 `value`；failed/cancelled/partial 等结果不能当作已完成。可用 reporter：

- `await reporter.checkpoint(key, {title?,description?,requirementIds?,stepAttemptId?})` 返回 `{id,sourceRefs?}`。步骤内传真实 stepAttemptId；只有 sourceRefs 是固定 DOM 采样的独立来源引用，不能用 checkpoint ID 顶替。没有冻结 DOM 来源证明时 sourceRefs 可为空，此时保持未核验。
- `await reporter.beginDataset({executionId,attemptId,datasetId})`，随后 `appendBatch({...identity,batchId,records,provenance:{sourceRefs,origin}})` 并保存返回的耐久回执；最后 `finishDataset({...identity,status,committedBatches,committedRecords,pagination?})`。datasetId 来自固定 requirement.dataset，attemptId 来自该次步骤身份。status 为 complete/partial/failed/cancelled；声明 complete 不等于独立覆盖通过。
- 旧 `emitData(name,records,provenance)` 仍可报告旧流程输出，但不能替代固定资料评估读取的持久批次。
- `await reporter.assertion({ requirementId, name, verdict, sourceRefs, message? })`，verdict 为 `pass/fail/inconclusive`；不能用自报通过覆盖缺失来源或机器判定。
- `await reporter.attachArtifact(name, content, mediaType)`、`await reporter.progress(message)`；人工协助时用 `requestHuman({ id, instructions, timeoutMs, completionCheck })`，并遵守 `reporter.signal` 取消。

批次 `provenance` 必填 `{sourceRefs:string[],origin:"browser"|"node"|"derived"}`，可另带 `pagination:{complete:boolean,pages:number,terminalReason:string}`；finishDataset 的可选 `pagination` 形状相同。浏览器观察使用 browser；来自 Node 或派生值须如实标记，不能为了来源判定改称 browser。`appendBatch` 返回 `{executionId,attemptId,datasetId,batchId,contentHash,recordCount,artifactId,durableAt,replayed}`。完成数量按成功回执统计，不能以计划数量代替；同一批次重试须同一身份、batchId 和内容。

下面是单次观察、单批落盘的通用接口片段，放在入口函数中。`readActualRows`、`stepId`、`checkpointKey`、`requirementIds` 和 `datasetId` 由实际实现依据固定任务定义；不需要用户手写这些 ID，也没有给出任何站点选择器：

```js
const result = await steps.run({
  stepId,
  async run(ctx) {
    ctx.signal.throwIfAborted();
    const records = await readActualRows(); // 普通 Puppeteer 读取，保留真实缺失/错误
    const sample = await reporter.checkpoint(checkpointKey, {
      requirementIds, stepAttemptId: ctx.identity.attemptId,
    });
    return { records, sourceRefs: sample.sourceRefs ?? [] };
  },
  async commit(value, ctx) {
    const identity = {
      executionId: ctx.identity.executionId,
      attemptId: ctx.identity.attemptId,
      datasetId, // 使用固定 requirement.dataset
    };
    await reporter.beginDataset(identity);
    const receipt = await reporter.appendBatch({
      ...identity, batchId: 'batch-1', records: value.records,
      provenance: { sourceRefs: value.sourceRefs, origin: 'browser' },
    });
    await reporter.finishDataset({
      ...identity, status: 'complete', committedBatches: 1,
      committedRecords: receipt.recordCount,
    });
  },
});
if (result.status !== 'succeeded') {
  throw new Error(`Step did not complete: ${result.status}`);
}
```

真实分页要在业务代码中逐页读取、及时追加耐久批次并按实际完成情况结束；上述单批片段不证明分页完整。失败时已确认批次保留，应使用真实累计数量和 error 记录 partial/failed/cancelled，不补空记录。`status:"complete"` 只是提交状态；缺 sourceRefs 仍保持来源不足，最终结论须再由宿主独立评估。

对于冻结的网络 JSON 来源证明，通过授权的 run artifacts 索引定位本次执行期间实际采集、状态为 `complete` 的 `response-body`，核对请求 URL、时间和 run，再把其 artifact ID 放入数据集 `sourceRefs`。`attachArtifact` 可保留脚本发现的辅助材料，其返回 ID 不等同于已捕获的网络或 DOM 原始来源。不要从 checkpoint 描述、网页文本或脚本自报内容编造来源 ID；评估器会按执行 attempt 和冻结 URL/字段路径重新读取原件。

实现目录还可包含 `implementation.json` 技术提案：`{materialContentHash,fields:[{fieldId,outputPath,sourceProof?}]}`。`materialContentHash` 与字段 ID 从真实固定资料取得；每个字段至多一项，`outputPath` 为必填 RFC 6901 JSON Pointer，指向每条输出记录的业务值。技术映射只能设置这三项字段，不能替换语义、数据集或值类型。按 [validation.md](validation.md) 经应用可读确认形成新的固定版，再运行该版。示范 target 是字段例证，不是每条输出都应相等的常量。

## 来源证明的完整形状

以下只演示协议结构，属性、URL 与 JSON 路径必须来自当前授权下实际读到的来源和自己的输出设计，不能直接套用示例。未知来源时省略 proof 并保留未核验，不猜造额外键。`sourceProof` 接受以下两个联合类型：

```json
{
  "kind": "dom-text",
  "sourceUrl": "https://example.invalid/catalog",
  "nodeAttribute": { "name": "data-measure", "value": "weight" },
  "entityAttribute": "data-item-key",
  "outputEntityPath": "/itemKey"
}
```

- 以上键均必填；可选 `pageParameter` 为允许变化的 URL 查询参数名；可选 `valueInterpretation` 见下文。
- `nodeAttribute` 用源元素上的确切属性名/值识别字段含义；它不是 CSS selector。`entityAttribute` 指源元素或最近祖先上的实体属性名，祖先查找不能跨 frame/shadow root。`outputEntityPath` 指每条输出记录中与该属性对应的实体键。
- 属性必须有真实来源，敏感属性名不接受。执行中的 `reporter.checkpoint` 才产生这次 attempt 的 DOM 显示采样；历史示范节点、定位器和旧 sourceRefs 不能当成本次执行证明。
- 未声明 `valueInterpretation` 的旧 DOM 显示证明要求业务值和实体键均为**字符串**，逐字相等；旧资料/报告/hash 不回填新规则。number 字段配旧精确文本 proof 会在映射预览中显示不相容，确认被拒绝；旧固定版仍可读，正式核验会报告配置不相容而不是业务值错误。
- 明确的 number 字段可以提出 `"valueInterpretation":{"kind":"plain-decimal","version":1}`，经用户阅读摘要并确认、发布新版本后使用。宿主从本次原始 display sample 独立解释，不信任脚本自报 normalizedValue。v1 语法为 `-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?`，总长至多 64 字符；不接受首尾空白、正号、前导零、指数、币种、百分号、千分位、小数逗号、单位或括号负数。绝对值至多 `Number.MAX_SAFE_INTEGER`；number 最短十进制表示往返必须与原文数值完全一致（忽略尾零和负零），否则未核验。不用 epsilon。`45.00→45`、`12.30→12.3` 合法；`0.10000000000000001` 不合法。只解释业务值，实体键始终是精确字符串，`0012` 与 `12` 不同。
- 显式数值映射下，正确值为 pass，真实值差异为 fail，合规数字但真实 sourceRefs 为空为 inconclusive；输出类型错误仍为 fail。遮罩/不支持语法不猜期望值。报告保留规则版本及有界的原文、期望/实际值和来源身份。

```json
{
  "kind": "json-record",
  "sourceUrl": "https://example.invalid/api/catalog",
  "rowsPointer": "/items",
  "entityPointer": "/key",
  "outputEntityPath": "/itemKey",
  "valuePointer": "/weight"
}
```

- 以上键均必填；同样只另有可选 `pageParameter`。
- `rowsPointer` 相对捕获响应的根，必须定位数组；`entityPointer`、`valuePointer` 相对其中每条记录。`outputEntityPath` 相对每条输出记录；源值和输出值按 JSON 类型和值比较。
- 来源须是本次执行真正采集的完整网络 JSON 响应，实体与字段值从原件独立核对。网络 JSON 不能单独证明 `page-displayed`，此种组合保持来源不足。

所有 pointer 的空字符串表示该根值，非空必须以 `/` 开始，键内 `~`/`/` 分别转义成 `~0`/`~1`，最长 1024 字符。URL 必须为 HTTP(S)，不含账号密码、fragment 或敏感凭据 query，最长 4096 字符；除显式 `pageParameter` 外，路径与全部查询条件都固定匹配。不能新增 `selector`、转换表达式或待执行代码到 proof。字段缺 outputPath/proof、来源缺失或超出能力时应保留真实未核验结论。

固定资料规则和机器验证仍由 Studio 核对。脚本应保留原始缺失、重复、身份不一致与部分失败，不能生成未观察到的来源；失败后先读实际报告再修改代码和受影响 checkpoint。
