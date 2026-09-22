# 原生脚本与验收

脚本目录由客户端可信项目设置登记。HTTP 启动请求只传输入和已登记对象，不接受任意磁盘路径或代码字符串。维护 `workflow.json`、普通 JavaScript 入口、输入/输出 schema 与锁文件；具体字段以项目 `src/contracts/workflow.ts` 为准，参考 `examples/orders` 的实际目录内容后再复用。

入口为 `run({page,input,reporter})`，业务执行用原生 Puppeteer。分支、循环、分页和等待写在入口代码。reporter 仅承担 checkpoint、emitData、attachArtifact、assertion、requestHuman、progress 与取消信号；不另做 Page 抽象、不引入运行时 LLM 自愈、不创建绕过受管闸门的浏览器连接。

checkpointKey 与 requirementId 稳定对应。结构化输出声明 sourceRefs/origin 和分页完成依据。Node 请求的来源材料通过 reporter 附入；没有来源或未覆盖时应判证据不足。至少检查实体身份、必填/类型、重复、分页终止和跨记录关联；“非空”不能替代正确性。

需要人工协助的点在 manifest 中声明。requestHuman 在 transport 闸门静默后等待，完成条件由脚本给出。不要注入跨交接继续点击的定时器。强制接管会停止 runner，不承诺恢复原执行栈；从显式恢复入口或新 run 重试。

通过 `/runs/:runId/validations` 启动当前登记版本，跟踪返回 runId/validationId、实际执行状态和逐需求结果。检查运行前后指纹、实际入口、退出结果、需求覆盖、checkpoint 和数据来源。代码、构建、配置或锁文件变化后，旧 pass 只代表历史版本；受影响 checkpoint 必须重新验证。

机器结论与人工评审分开保存。评审使用 accept/reject/exception、原因和范围，不能覆写机器失败。交付报告明确通过、不通过、未覆盖、证据不足，以及真实场景尚未验证的项目。

工具验证先用合成站点。最终真实拼多多演示与扫码需事先与用户协调时间，且只能操作明确授权的账号环境。不要修改原 `agent-browser-evidence`、业务插件或宿主，不把真实录制/profile 放入代码仓库。最终业务脚本应另有普通 Node/Puppeteer 启动入口，可脱离客户端和 LLM 执行。
