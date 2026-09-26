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

入口导出 `async function run({ page, input, reporter })`。这里的 `page` 是受管的 Puppeteer Page；导航、分支、分页、等待和选择器属于普通 JavaScript，不另建 JSON 控制流。可用 reporter：

- `await reporter.checkpoint(key, { title?, description?, requirementIds? })` 返回 `{id,sourceRefs?}`。`id` 是 checkpoint 身份；只有返回的 `sourceRefs` 是固定 DOM 字段采样的独立来源引用，不能把 checkpoint ID 放入数据集来源。没有冻结 DOM 来源证明时 `sourceRefs` 可能为空。
- `await reporter.emitData(name, records, { sourceRefs, origin, pagination? })`，其中 `origin` 为 `browser`、`node` 或 `derived`；分页完成证据形如 `{ complete, pages, terminalReason }`。每个数据集完成后立即提交一次。
- `await reporter.assertion({ requirementId, name, verdict, sourceRefs, message? })`，verdict 为 `pass/fail/inconclusive`；不能用自报通过覆盖缺失来源或机器判定。
- `await reporter.attachArtifact(name, content, mediaType)`、`await reporter.progress(message)`；人工协助时用 `requestHuman({ id, instructions, timeoutMs, completionCheck })`，并遵守 `reporter.signal` 取消。

对于冻结的网络 JSON 来源证明，通过授权的 run artifacts 索引定位本次执行期间实际采集、状态为 `complete` 的 `response-body`，核对请求 URL、时间和 run，再把其 artifact ID 放入数据集 `sourceRefs`。`attachArtifact` 可保留脚本发现的辅助材料，其返回 ID 不等同于已捕获的网络或 DOM 原始来源。不要从 checkpoint 描述、网页文本或脚本自报内容编造来源 ID；评估器会按执行 attempt 和冻结 URL/字段路径重新读取原件。

固定资料规则和机器验证仍由 Studio 核对。脚本应保留原始缺失、重复、身份不一致与部分失败，不能生成未观察到的来源；失败后先读实际报告再修改代码和受影响 checkpoint。
