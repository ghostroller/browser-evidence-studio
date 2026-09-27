# 从示范到可复跑逻辑

先读取固定版本的目标/范围、需求、数据集、字段与保存点卡片。卡片的 anchor 和 sourceReceiptRef 指向历史位置与原始收据，后者的 artifactRefs/时间范围用于读取网络与 DOM；两者不是两个需要用户重复创建的保存点。页面上消失的元素只能引用已保存材料；没有采集到的内容保持缺失。

优先读取已有 JSON 字段、内嵌 JSON 和已保存 DOM 片段。区分请求跳转 hop、page/frame、导航代际。HTML 与 API 都可作为来源，不预先假设某一种一定完整。时间邻近只能标注 temporal 关联，不推断因果。脚本侧 Node fetch/Axios 不是浏览器网络记录器的自动覆盖范围。

需要有限浏览器探索时，先从 state 获取实际 session/profile/page/generation/lease 与当前能力。按 capabilities 的 pageCommands 使用 `/v1/sessions/:sessionId/pages`、`snapshot`、`actions`；创建后台页用 `POST .../pages`。这些操作无需 active run，读取与写操作分别要求 page-read 和相应写能力；人工控制时仍拒绝写操作。旧 run 路由只接受当前活动 run，不能用封存 runId 代替 session，也不为补齐 ID 开始人工示范。通过受支持的 actions 操作，不访问内部 CDP 或任意 eval。不把 snapshot 的短期 ref/坐标当成最终可迁移定位器。

实时选取的可靠依据是客户端已耐久固化的 HistoricalElementRef，不是 active.selection 中的描述文字。实时当下不能回填到旧 anchor；请求补例证时新增现场保存点并保留旧来源。无录制只能普通检查，绑定需用户明确开始录制或受支持的单次取样。取消选取或浏览卡片不意味着解除旧字段绑定；资料编辑保留/替换/解除必须明确。

人工控制时不得导航、点击、注入或刷新二维码。若需扫码等已授权协助，发起 handoff，给出具体目标和 completionCheck；由客户端排空操作闸门后交人。交还后检查实际完成结果再继续。到期进入待关注，不能自动算登录成功，也不能无限重试真实站点操作。

需要补录时，说明缺口、影响哪些字段/变体，以及最小补录范围。封存 run 不追加原件；新 run 与来源 run 保持引用。新的 checkpoint 保存后核对图/DOM各自状态及采集时间范围；consistent 不表示页面被冻结或采集完全原子。

探索结束时产出代码所需事实：实体主键、分页停止条件、分支、稳定定位器、输出来源和待验证点。分支与循环写入普通 Puppeteer 代码，不再在 JSON 中维护第二套流程。
