# 独立控制流证据

`repro-first-rebuild.mjs` 按审查基线 `237d778bebf99dce74f3f4929eb320f17e10c7ff` 中 indexPrefix 的 no-pointer 分支建立临时目录，验证“首次未发布 staging 目录会改变 legacy 读取决定”。

运行：`node repro-first-rebuild.mjs`。

本次执行环境 Node v22.16.0，结果见 `result.json`。没有导入/运行项目的 RecordingArchive，没有在 Windows/Electron 或项目指定 Node 版本复跑；它只确认局部目录决策机制。本地仍须用真实项目类、故障注入和跨进程场景完成回归。脚本只清理自身创建的系统临时目录，不接触用户录制。
