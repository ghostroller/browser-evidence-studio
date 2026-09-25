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

## 第二里程碑：审查加固与桌面交接

首批提交 `4bd3ad7`。第二批补充 parse5@8.0.1 的HTML响应/DOM checkpoint采集脱敏（root已在 `3b93f08` 提升显式runtime依赖，本树不改package/lock）。JSON响应凭据字段在采集时遮罩并标privacy-redacted representation；旧原件不回写。增加 OfflineResourceService/rewriteReplayEvent，专用协议返回已归档CSS/图片/字体；CSS依赖从当时manifest解析，没有联网补取。

review修正：最后oversize事件记录未知源范围且拒绝静默封存；stop前后读取observer健康，final full snapshot消费待发送metadata；index.gaps不可覆盖原件可靠性、window核对完整源位置；资源manifest与URL索引核对完整stream/frame/位置；每run资源预算由同一EvidenceStore作用域共享。stream分页按有界有序候选返回，续页限定sealed档案；descriptor和定长position行进行运行时验证。结构定位器从源树执行受限结构查询计算matches，已移除直接`[node]`自证唯一；Shadow只输出可跨开放root的CSS步骤，原生XPath不冒充可对ShadowRoot求值。

`npm.cmd test -- test/unit/refactor-recording.test.ts test/unit/evidence.test.ts test/unit/capture.test.ts test/unit/request-body.test.ts test/unit/checkpoint.test.ts`：5文件41项通过。新增桌面文件仅typecheck通过，尚未运行。

桌面交接入口：`runRefactorRecordingScenario(studio, 'record' | 'offline')`，文件`test/desktop/refactor-recording.ts`。root需调度两个不同Electron PID、同一合成BES_DATA，先record后offline。record自建本机临时源站、生产Studio/CaptureCoordinator录制、保存位置与源HTML测试快照、封存后关闭HTTP server；Windows系统Arial仅作为忽略输出中的合成字体fixture。offline读取`BES_DATA/refactor-recording-fixture.json`，断言不同PID、独立非持久session，拒绝全部http/https/ws/wss/file，按manifest重写rrweb事件与CSS依赖，真实Replayer重建并在独立保存的原站DOM验证CSS/XPath。报告为`refactor-recording-{record,offline}-report.json`。

root主入口须在ready之前为`bes-resource`注册standard/secure/corsEnabled/supportFetchAPI协议权限（仅专用隔离replay session安装handler，不给业务profile安装）。测试检查CSS、@import、图片、字体、Mirror节点、反复seek、脚本不运行、无原站请求、destroy释放iframe；失败保留报告，不降低断言。该场景尚不证明30分钟内存或跨源frame资源映射，子frame源逻辑ID与CDP资源ID尚未建立完整映射时应显示资源unavailable。

桌面资源时点审查补丁：source fixture在initial/updated两点使用**同一**`/assets/main.css` URL返回不同颜色；offline每次seek以当时position逐URL resolve，拒绝用final资源替代initial。协议URL携带seek代际，处理开始固定position，异步完成前复核代际；CSS嵌套依赖沿用该代际。`OfflineResourceService.response`新增可选`urlForResource(id)`以支持调用方的安全路由/代际。此补丁仍只有typecheck，等待root真实桌面结果。

root真实桌面attempt1：typecheck/41模块测试/build通过，但生产初始isolated world的`crypto.randomUUID`不可用，record启动失败、offline未开始。日志`output/refactor-integration-20260926/A-desktop-attempt-1.log`，合成原件`output/desktop-1790368796190`（root树）。修正为每次注入调用`crypto.getRandomValues`生成v4 UUID，保持每document/epoch独立，不从host传一个固定ID重复使用；模块fixture同时移除randomUUID以覆盖该缺失环境，仍需root真实重跑。

root真实attempt2：`output/desktop-1790368992121` 的run `2044933f-4cae-413d-9100-ab71ff4822f8`已封存但degraded；只读复核看到7次resource预算拒绝、1次network预算拒绝，font/ttf仅browser-cached-resource-unavailable，确认不能通过扩大内存上限掩盖。修改为最多256条/1MiB的轻量descriptor队列，实际response/CDP缓存正文一次仅读取一个并独立保留32MiB+4096工作集预约，直到解码/落盘全部完成才释放；新文档资源等真实source baseline提交，不能绑定旧about:blank。stop先禁止新增任务，再读完已接受descriptor并持久化，最后detach CDP。

测试finally先写原始异常报告，关闭其自身synthetic session，再关闭源站所有连接，避免断言被server.close等待隐藏。模块新增并发大正文descriptor顺序/限额测试及跨rrweb/HTML/JSON隐私、__proto__普通属性、CSS/srcset parser验证，typecheck与8项A测试通过。metadata变更丢失后受影响属性变为missing，不展示旧值冒充当时原值；动作摘要遵守rr-mask/rr-block及表单遮罩。

## 暂停后接续与第三次桌面结果

原 A 原生任务消失后，根于同一工作树接续 `/root/refactor_a_resume`；HEAD `0d295c7`、全部8个dirty及未跟踪url-privacy文件原样保留。Node v24.21.0/npm11.19.0核实；共享显示值契约 `2e2258e` 顺序接为 `9c1a1d6`，未覆盖dirty。

根第三次真实record通过（PID42660、font已捕获），offline新PID32900失败，原件和报告保留于根 `output/desktop-1790370699081`。静态复核定位首个executeJavaScript的CSP值内含单引号，却嵌入单引号JavaScript字符串，产生语法错误。改用DOM创建meta并以JSON.stringify传完整原政策；未放松CSP/sandbox。加入有界renderer console（100条、每条4000字符）及执行stage。`npm.cmd run typecheck`通过，日志 `output/refactor-a-resume/offline-diagnostic-typecheck.log`；真实offline重跑仍由根调度。本诊断提交不含尚未完成的隐私包。

隐私续包：`src/capture/url-privacy.ts`导出`credentialUrl`和`captureMetadata<T>(input:T):T`，供E在Studio新增元数据写路径复用；复制后只改凭据URL字符串并加capturePrivacy说明，不处理artifact二进制data、更不重写旧原件。生产raw CDP/event/artifact metadata、rrweb与源属性、HTML属性/文本、JSON根值/嵌套值统一URL策略。含凭据URL的CSS/SVG文本资源明确redacted且不保存原字节；普通URL原始拼写不变。rr-mask元数据属性及跨open-shadow祖先同样受遮罩。延迟response读取在loadingFinished同步取得身份租约，排队前/读取后均复核，ID复用和capture reset不能把新请求body记到旧request key；stop先排空已接收body再reset。

实际`npm.cmd run typecheck`和`npm.cmd test -- test/unit/refactor-recording.test.ts test/unit/request-body.test.ts`通过，2文件18项，5.14s；日志`output/refactor-a-resume/privacy-typecheck.log`和`privacy-tests.log`。桌面privacy fixture已加跨raw/CDP/journal/artifact原件断言但尚未运行。第4次根record仍通过，offline进入seek后CSS颜色为默认蓝色；资源加载/诊断返修接续中，不宣称离线验收通过。

第4次资源诊断返修：offline先等link load/sheet，再请求font并等image.decode；此前fonts.ready可能在样式表引入字体前已resolve。颜色断言不改，并新增各资源失败断言。每次seek在断言前写result、stylesheet状态和当时URL映射；protocol回调记录有界id/代际/status/错误，不吞404根因。console使用Electron当前event对象。仅typecheck通过（`offline-assets-typecheck.log`），根真实第5次尚待运行，不能据静态等待逻辑断言根因已解决。

隐私包审查返修：大JSON的旧9MiB验收不能退为read-failed。`prepareResponseBody`在现有40MiB资源工作集上限内，先分块检查完整观察文本，保留8MiB UTF8完整码点前缀及真实观察字节数；EvidenceStore.putArtifactPrefix只接受大于前缀的实测长度。CDP单资源缓冲调整为10MiB以容纳既有9MiB验收，未扩大64MiB总缓冲或40MiB工作集cap。过大base64/HTML等不支持的隐私表示明确excluded；观察字符串超过工作集范围明确失败。普通小响应仍走完整隐私策略。catch保留遮罩后4KiB cause；落盘错误移出读取catch，必须进入采集失败/耐久gap路径。

`npm.cmd test -- test/unit/refactor-recording.test.ts test/unit/evidence.test.ts test/unit/request-body.test.ts`通过3文件33项，13.51s；`response-prefix-tests-attempt2.log`。首次测试误把reader总返回预算当正文1024字节，失败日志保留；修正为验证真实返回前缀及落盘8MiB。typecheck修正测试unknown窄化后通过，`response-prefix-typecheck-attempt3.log`。真实9MiB CDP/desktop仍待根验收，不把模块准备器测试当真实采集已通过。

第5次根record通过，offline updated位置CSS/字体/图片/8个定位器通过，回initial字体失败。根原件`output/desktop-1790371821202`证明同seq缓存probe失败覆盖了已捕获font。resolve改为明确区分：fromCache且无requestId的failed/missing只代表probe失败，不是新资源版本；原manifest和诊断保留；真实后续request失败仍阻止使用旧captured版。查询按源seq/追加顺序找首个真实版本，只有probe时仍返回失败，没有盲目降级到任意旧字节。

同包隐私加固：畸形JSON无法可靠执行键级隐私策略时excluded，保存privacy-unverifiable与安全解析错误身份；新captureError保留name/code/4KiB普通message，credential URL或裸password/token等错误消息遮罩。真实原件不回写。新增probe/新请求失败和畸形JSON/错误秘密负例；typecheck、专属录制和request-body模块测试通过，日志`resource-probe-typecheck.log`和`resource-probe-tests.log`。源sample草稿仍未提交，不混入此返修。
