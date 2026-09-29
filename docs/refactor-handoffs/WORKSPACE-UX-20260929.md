# 工作区、存档、管理与浏览器：当前进度

本轮入口为 [docs/README](../README.md)，契约为13/14；T1–T3历史结论不作为当前构建证据。

## 现场与文档

- 根目录 `D:\Workspace\browser-evidence-studio`；开始HEAD `85ad469aff92c444b8c5810e1710507558b8c77a`，分支main，无活动项目测试或Electron。未回退代码。
- 起始修改：短版AGENTS；未跟踪README、10/11/12/13/14及审查证据目录。只纳入普通任务Markdown，原件、截图、日志、profile和审查证据目录不纳入。
- 11/12均存在，内容为历史规范与交接，未发现凭据；保留原始字节。SHA256分别为 `3BB61396104D6981179A71AFBEB5C041FCA6A4166B5AE87EF0070E4A31DB5D97`、`63C38001E0B97A6716D9338D83412CE81BDDBBDCD22D5E3FF7FEF4B37120D9EC`。
- Git用命令级safe.directory，不修改全局配置。Node v24.21.0 / npm 11.19.0，与lock一致。

## W0 最小可运行契约

- 在现有资料writer锁中持久化目录、当前工作副本指针和稳定版本编号；旧版本按完整时间/ID集合建立编号，不改hash。
- 新增工作区view类型、按ID实体读取、taskBrief编辑/diff接口。保存点页与存档页分离；资料版本/原始录制/工作副本具有不同入口，固定版与编辑器互斥。
- 并发首次打开、61版分页重启、brief-only diff及既有材料/创作服务：17项通过；typecheck、生产build通过。
- 受限账户Electron启动失败（GPU子进程exit -1073741515），保留 `output/desktop-1790682133561`；正常桌面权限重跑 `output/desktop-1790682144829` 已通过冷启动、热启动、刷新恢复与预期失败验证。仅证明启动可运行，不代表交互矩阵通过。

## 接下来

W1由主任务负责资料领域和集中编辑；W2管理与浏览器可各一独立工作树，公共集成文件由主任务统一合入；桌面测试串行。W3在集成新构建上逐项标注IA01–IA30服务/组件/Electron/独立使用者层级，当前尚未宣称矩阵通过。


## W1 集成检查点（2026-09-29）

集中编辑器、三个存档子视图、只读固定版与明确派生已接入主入口；字段支持附加例证，注释可为纯文字。按 ID 读取、复制后定位、dirty 自动保存、迟到项目回执保护、taskBrief 编辑/差异与存档操作恢复已实现。管理和浏览器包已合并并接入真实 Studio 与 App。

实际定向组件回归 21/21，资料/作者服务回归 37/37，TypeScript 检查通过。初次旧界面测试失败保留在 output/workspace-renderer-first.log；重写后的异步交互测试曾失败，日志 workspace-components-*.log 保留，最终 fifth 为 21/21。此检查点尚不是 W3 桌面验收，也不替代新构建 T1–T3。

W3 前补强：工作副本/存档使用持久操作回执恢复，目录写失败不发布内存；副本差异、版本备注、撤销未保存输入、跨页字段归属和简单 schema 参数表单已加入。定向 28 项及参数表单 2 项通过；其余旧测试首轮 482/492，通过适配后继续全量复核。当前生产 build 已生成，开始串行真实 Electron 验收。


## W3 浏览器实际复核

498 项服务/组件回归全量通过（workspace-full-second.log）。真实 Electron 前两轮分别发现导航状态轮询迟到、findInPage 的首次/续查参数相反，已修复主进程变更通知和参数映射；第三轮确认 Electron 原生不支持 prompt()，现界面明确提示，不冒充成功输入。原失败目录分别为 output/desktop-1790684629345、1790684732288、1790684835208。

修后浏览器专项在 output/desktop-1790685008038 通过：原生历史/加载停止/网络失败重试，查找/缩放/快捷键，标签与 opener，alert/confirm、prompt 不支持提示及权限拒绝，无录制/录制中下载与取消，四处真实 view 初始化故障注入、第五处真实初始网络故障、检查模式拦截及停止可达。详细证据为 workspace-browser-detail.json；不是物理进程故障或独立可发现性证明。

prompt 限制来源：[Electron 原生对话框实现](https://github.com/electron/electron/blob/main/lib/browser/api/web-contents.ts)。本轮保留 sandbox/contextIsolation，不通过替换网站 prompt 或宿主私有对话框钩子制造支持。
