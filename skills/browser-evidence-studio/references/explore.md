# 从示范到可复跑逻辑

先明确用户目标、输出字段、实体身份和需求 checkpoint。读取 summary/gaps 后，按 checkpoint 的 artifactRefs、事件区间和页面身份定位网络/DOM 材料。页面上消失的元素只能引用已保存材料；没有采集到的内容保持缺失。

优先读取已有 JSON 字段、内嵌 JSON 和已保存 DOM 片段。区分请求跳转 hop、page/frame、导航代际。HTML 与 API 都可作为来源，不预先假设某一种一定完整。时间邻近只能标注 temporal 关联，不推断因果。脚本侧 Node fetch/Axios 不是浏览器网络记录器的自动覆盖范围。

需要有限浏览器探索时，先从 state/pages 获取实际 runId、pageId、generation、leaseEpoch，再根据用户授权申请 agent 控制。通过 actions 中受支持的 navigate/click/fill/press/scroll/select 操作；不访问内部 CDP、不使用任意 eval。不把 snapshot 的短期 ref 或坐标当成最终可迁移定位器，保存 selector、role/text、frame 和 DOM 依据。

人工控制时不得导航、点击、注入或刷新二维码。若需扫码等已授权协助，发起 handoff，给出具体目标和 completionCheck；由客户端排空操作闸门后交人。交还后检查实际完成结果再继续。到期进入待关注，不能自动算登录成功，也不能无限重试真实站点操作。

需要补录时，说明缺口、影响哪些字段/变体，以及最小补录范围。封存 run 不追加原件；新 run 与来源 run 保持引用。新的 checkpoint 保存后核对图/DOM各自状态及采集时间范围；consistent 不表示页面被冻结或采集完全原子。

探索结束时产出代码所需事实：实体主键、分页停止条件、分支、稳定定位器、输出来源和待验证点。分支与循环写入普通 Puppeteer 代码，不再在 JSON 中维护第二套流程。
