# UI 组件来源

2026-09-23 从 [shadcn/ui](https://ui.shadcn.com) 官方 `new-york-v4` registry 手动引入本目录 13 个组件（Radix 路线，shadcn/ui 上游为 MIT 许可）。来源格式：`https://ui.shadcn.com/r/styles/new-york-v4/<组件名>.json`。

此前尝试 `shadcn@4.21.0 add`，registry 阶段未完成；这里记录实际使用的手动方式。源码与依赖固定在仓库/lockfile，运行应用不访问 registry。

本项目调整：`cn` 和组件路径映射到 renderer alias；Button 默认使用 outline，主要操作显式使用 default；Dialog 关闭时立即卸载，避免退出动画期间原生浏览器穿过弹层；控件密度和亮暗语义 token 集中在 `../../style.css`。不引入 Card 或第二套控件基础。

新增/更新组件时保留 `components.json` 的 renderer 路径及 Forge/Vite 配置。Resizable 使用 v4 的 Group/Panel/Separator API，不能套用 v2 的 PanelGroup 属性。
