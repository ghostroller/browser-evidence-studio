# A：录制、资源与历史读取（2026-09-26）

本树 `output/refactor-worktrees/20260926-A`，分支 `codex/refactor-a-20260926`，基线 `4c4b293b21b4c027dec381e7382db6f14a8ce11c`。Node 24.21.0 / npm 11.19.0 实测；独立 npm ci 完成。仅修改 A 所有权目录、专属测试和此文件。

## 首个可审查里程碑

- 生产 CaptureCoordinator 使用锁定 SHA256 的 rrweb 2.1.6 窄源属性 hook 与统一表单值遮罩；源 eventSeq、文档/epoch 身份、属性/property、同源 frame 和 open-shadow 源范围进入 format2 payload。原件容器仍为 schema1，不重写旧录制。
- EvidenceStore 的 appendRaw 回执补充原始文件、offset、bytes、sha256；既有 durable fsync 完成语义保留。原件仅保存一份；replay-index 可重建。显式结构/metadata/sampling/resource 队列有独立字节及任务预算，响应读为字符串/解码/复制预留实际最大工作集，不再以4KiB估值代表大正文。
- RecordingArchive 从目标源序号定位 full snapshot，最多4096事件/64MiB窗口、单事件16MiB。索引仅定位；可靠性从校验hash后的原件重算，不能用修改index.gaps隐藏metadata缺口。重建损坏明细最多128条、另有总数，不删除损坏原件。
- SourceModel 消费原始结构与元数据，不从回放 DOM 反推 attributes。ArchiveReplayService 实现 state/node/locators；超预算完整节点返回413。候选保留历史命中和 not-live-checked，支持属性/顺序、CSS和XPath；特殊frame/shadow/SVG的浏览器验证仍待后续专项。
- ResourceCapture 消费已有 CDP 响应和浏览器缓存资源字节；没有 fetch 方法。不抓取原站补造过去。按内容hash保存至 BES_DATA/blobs、逐来源manifest；同URL不同内容不折叠。单资源8MiB、每run256MiB、10000引用硬上限。封存和重开核验资源manifest与blob。晚补取不会被默认read当原始captured资源。
- CSS URL lexical parser 与 srcset parser 为离线壳准备；prepareReplayEvents 使用派生presentation clock处理同毫秒源事件，原始时间/位置不改。ReplayViewSession 释放过期seek结果与当前视图。

## 接入接口

`new ArchiveReplayService(runDir)` 遵循冻结 ReplayService；额外 `window(position,signal?)` 返回 `{position,records,gaps,readBytes,baselineSeq}`。这是 UI 内部有界重建输入，不应原样经 HTTP 返回64MiB。

`service.archive.streams(limit=100,after?)` 返回 `{items:RecordingStream[],nextCursor?}`，descriptor 有 first/last/events/monotonicTime。`positions(streamPosition,limit=100,ordinal=0)` 以24字节定长索引读取位置，返回type/source/nextOrdinal；`resolveTime(streamPosition,sourceTimeMs)` 二分定位到不晚于目标的最后源事件。源时钟倒退明确拒绝时间seek并保留精确eventSeq入口。

`new ResourceArchive(runDir).reference(id)/read(id)/list(limit,after)/resolve(originalUrl,position,frameId='top')`；read 返回 `{reference,bytes}`，拒绝缺失、遮罩、late-fetched及hash失配，无网络fallback。专用协议/Electron partition/HTTP授权由E/G接入；不得给回放使用当前profile或放开外网。

`CaptureCoordinator.recordingPosition` 是最后耐久原件/索引完成的位置，`queueMetrics` 返回分通道活动/峰值/丢弃计数。

身份：recordingId=runId；pageId=既有页面ID；documentId、streamEpoch每次注入随机UUID；frameId top或`document-${rrwebDocumentId}`；mirrorScopeId=`${streamEpoch}:document-${rootId}`，逻辑身份包含冒号，不能按文件路径段正则验证。

## 已实际执行

`npm.cmd run typecheck` 通过。

`npm.cmd test -- test/unit/refactor-recording.test.ts` 5项通过：真实锁定rrweb在JSDOM采集动态结构/属性/表单遮罩；独立原站DOM的CSS/XPath查询；载入rrweb前冻结源时钟产生真正同毫秒事件，磁盘窗口重建分别读回两个文本状态；原件hash/索引重建；metadata缺口与篡改index.gaps；通道预算/迟到seek释放；离线资源版本/隐私/字节预算。

最初两次失败保留在测试终端记录：JSDOM namespace-uri XPath实现异常（HTML候选改为标准HTML路径，SVG留给真实Chromium验收）；rrweb会保存Date.now函数，加载后替换时钟不能制造同毫秒，改为加载前冻结。没有重写采集事件时间，没有删除有效断言。

## 明确未验收

尚未由本树启动Electron或桌面。生产CDP→seal→新进程断网回放、真实同源frame/open Shadow DOM、SVG/XPath、布局/字体/交互屏蔽、连续拖动/内存、强杀/磁盘满、30分钟固定负载仍须G串行执行。跨源plugin映射、closed Shadow DOM、Canvas/媒体不宣称支持。保留旧writer逐记录fsync，尚未按真实热点迁移group commit/worker；不得把有界模块测试当生产性能验收。

专属桌面场景和后续补丁仍在继续实施；完整AT05–24未宣称完成。
