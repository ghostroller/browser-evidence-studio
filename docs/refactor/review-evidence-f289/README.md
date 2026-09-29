# 审查控制流实验

基线：f2894456e2a9364044067ddbdbd813300e5a8dde。

`control-flow-models.mjs` 独立建模 MaterialWorkbench 的四个流程：发布时旧闭包覆盖关系、失败重试保留过期选择、重试按钮遗失字段意图、迟到项目初始化使新加载失效。没有 import 仓库实现，没有加载 React/Electron，没有访问网站或用户数据。

运行：`node control-flow-models.mjs`。附带 `results.json` 是 Node v22.16.0 的实际模型输出，不是仓库规定环境下的回归成绩。修复前后都应在项目真实测试中覆盖相应交互；不能因附件输出“defectModeled=true”就声称 Electron 问题已端到端复现。
