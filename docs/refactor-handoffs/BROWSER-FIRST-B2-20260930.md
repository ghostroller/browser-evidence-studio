# B2：共享 Web 回放与历史节点选择

日期：2026-09-30（UTC）。实施基线 `853cccda511889e46cc50526d8b779da9da8b75c`。B2指定的共享回放／节点绑定核心纵向已完成，最终主链为attempt9；保留分项证据与失败，不外推完整跨浏览器／旧profile矩阵。

代码分包：`6c14b7f`共享controller／呈现／资源重写；`99713b3`显式回放授权／有界包／独立origin；`dce378c`浏览器选取与资料绑定UI。

## 最小纵向与不变约束

同一共享播放／控制／选择模块用于浏览器与Electron：同项目sealed存档→真实DOM回放→暂停／精确seek→历史节点选择→绑定字段→固定版本→刷新回读。保留SourceModel、原始ReplayPosition、来源核验、资源hash及缺失／损坏／排除语义；不能借新页面或网络补回历史。

不扩展B3纯Node/provider，不迁移旧profile，不改变旧Electron原生对话框。管理DOM、可信回放壳、脚本禁用的录制document是不同信任层；管理凭据不得进入录制层。共享范围是controller、呈现／命中与词法资源处理；Web另有跨源消息桥，Native保留自身IPC／独立session容器，未维护两套字段或播放器核心语义。

## 先行探针与隔离选择

首个方案为外层srcdoc使用 `sandbox="allow-scripts"`、可信nonce脚本，保留opaque origin；rrweb内部仍按既有实现创建 `sandbox="allow-same-origin"` 子iframe。

真实Chrome151／rrweb2.1.6探针失败：子iframe.contentDocument为null，访问contentWindow.document触发SecurityError（origin null跨源），rrweb构造／DOM重建不能完成。失败保存在本地 `b2-proof/opaque-probe`。未为通过而给管理同源iframe同时增加脚本和同源权限。

最终采用**独立loopback回放origin**，先以固定资产小探针证明兼容性与隔离，再接入产品：

- 回放端口与管理UI不同origin，只提供内嵌固定可信JS／CSS的 `/replay.html`（GET／HEAD），精确Host，禁止业务API、代理、任意文件路径、重定向和用户资源URL
- 不同port不能隔离按host匹配的Cookie；当前B1使用内存Bearer而非Cookie认证。回放server不解析／返回／记录Cookie或Authorization，也不传ticket/token。若未来切换Cookie认证，须重新审查此边界，不能宣称端口隔离等于Cookie隔离
- 外层回放iframe可同时允许scripts／same-origin，仅因其与管理端跨源；录制子iframe继续无脚本权限。CSP、无表单／顶层导航权限和事件处理各自验证，不把sandbox属性名称当作全部安全证明
- 回放壳限制网络与资源类型，固定nonce／hash执行可信脚本，no-store／nosniff／no-referrer及最小Permissions-Policy；最终frame-src none、connect/default/object/media/form/base均拒绝，样式只允许inline／blob，img/font只允许data／blob
- 管理端只向精确targetOrigin、当前iframe发送有界已验证归档包；不传token或Agent连接文件。两端校验event.source、精确origin、instance/replayId/generation/command／selection序号；origin本身不替代当前实例身份
- 录制数据以结构化消息传入，不把不可信JSON拼入script模板；可信脚本生成亦防止script终止注入

### 独立origin可行性探针

Chrome151／rrweb2.1.6实际双loopback origin测试已完成：重建真实录制DOM至 `13.00`，replayHit／mirror返回与源一致的nodeId10；管理端与回放端相互访问DOM／localStorage均被SecurityError拒绝。保留既有rewriteReplayEvent后，合成script／handler／meta-refresh／form／iframe／SVG／CSS外链没有执行脚本，canary HTTP请求为0。

最初CSP `frame-src about:` 完成上述正反例；进一步 `frame-src 'none'` 仍可重建默认空白rrweb子iframe并取得相同节点。后者此探针只运行重建／命中／跨源访问正反例，不能把前者的恶意内容用例重复计为后者已测。产品优先使用更严格none，最终仍须重新跑产品消息／资源安全负例。探针恶意动作后改写为about:blank的链接还能使回放自身变空白（无外部请求）；该末帧截图不是正向视觉通过，产品须验证正常交互不能导航丢失回放，选取应通过可信overlay而非放开录制document交互。证据为本地 `b2-proof/origin-probe`，它是隔离可行性，不是B2产品通过。

## 受保护的数据与选取合同

已新增可信UI显式配对的 `project-replay`；旧metadata／materials／workbench grant不静默升级。读取只限当前project的sealed录制；已有ProjectMaterials.replay只验归属，不足以替代封存检查。

回放包沿已有prepareArchivedReplay／prepareReplayEvents及OfflineResourceService读取，资源必须来自该准备过程签出的id与position，不开放任意id资源读取端点。总输出、base64开销、资源数量、递归CSS及DOM事件各有预算；超预算明确error／partial，不联网回退。IO之后仍核session、撤销及取消；丢弃迟到响应不冒称已经取消全部磁盘工作。

节点选择在服务端重新核SourceModel／frame／mirror scope／精确position；沿用MaterialWorkbench的selectionId、draftRevision与editor-owner保护。快速seek、关闭、换草稿后的迟到选取不能绑定到新对象，取消不能伪装成成功。

## 实施期独立审查记录

以下是已实现的定向修复，不替代最终产品GUI验收：

- `SourceModel.node` 返回完整性信息，选择端现在拒绝metadata不完整、structure／metadata gap；完整合法节点作为正对照。不能在选取阶段先宣告可靠来源，再仅依赖发布阶段拦截
- 新包最多16 MiB总输出、8 MiB事件窗、8 MiB归档字节和128唯一资源，超预算显式失败；旧metadata／materials／results响应上限不因新增回放路由扩大
- 归档外部CSS转blob URL，回放壳 `style-src` 仅增加blob:，不开放外部网络；真正CSS／图片已由产品GUI核computedStyle与像素，见下文
- 占位资源URL替换复用词法事件／CSS重写，仅处理资源字段与CSS URL token，普通正文及普通属性包含相同文本时保持原字节语义
- 断线销毁iframe后，新壳boot重置接收序号并失效旧generation；不能因父序号高于新壳ready导致永久加载
- Native ReplayHost实际调用抽出的共享controller，不把未使用模块当作双宿主复用；原partition与权限路径保留

独立第二轮5文件37项与额外四个SourceModel完整性反例通过；尚未运行本轮build／GUI时，不将该结果写成真实回放或固定版纵向通过。

### 当前播放范围

Web播放范围是最近完整快照至所选来源事件的既有有界窗口，非整份录制无缝串流；起点与精确滑块只覆盖这个窗口。窗口内seek递增command，换源／重载递增generation，两者均参与消息身份。Native继续独立WebContentsView与bes-resource资源输送，但调用同一controller核心。已知SVG保真缺口未因B2迁移自动修复。

### 首轮整合门禁

冻结后桌面真实writer上下文42文件268项为267通过／1失败：browser-materials旧fixture仍期待按钮“需Electron”，新旧grant提示为“需回放授权”，disabled与权限行为未变。保留失败记录，仅更新该测试字符串，不放宽disabled、纯文字注释target缺席或无新RPC断言；该文件桌面定向9/9、typecheck与完整build随后通过；未变的267项不重复计数。

## 首轮真实产品失败与修复

attempt1正常UI录制／封存、显式新scope、精确事件#8卡片成立，`webReplayBundle`返回HTTP200，但回放持续“正在读取已封存历史窗口”30秒、data-ready未就绪，后续选取／绑定／发布未测。0 pageerror，源码／构建未变，自有实例正常退出。证据保存在本地 `b2-proof/attempt1`。

同构建diagnostic2已证实离屏呈现等待：保持离屏8秒时controller／player／DOM13.00已经存在，但双requestAnimationFrame未完成，父页面无ready；正常scrollIntoView后47ms收到同gen3／command1的ready。CSS／PNG／普通bes-inline正文在该轮均成立。随后实现有界等待与打开视图定位，修复后的产品重测见下文；诊断本身不计修复通过。diagnostic1和attempt6被严格来源／anchor断言截住。初判选项时序，后确定harness通用select把value与text模糊匹配混在同一findIndex，目标“8”被更早的时间文本抢先命中；修为先全表精确value、无匹配才按文本，保留正常控件change和持久anchor断言，未改业务。

### 修复后实际重测进度

离屏修复后桌面9文件60项、typecheck／build通过；独立reviewer重跑其中3文件25项，不与前述数量相加。实际产品无需harness预滚动即进入ready；原5秒资源等待保留，双rAF只限1秒，未观察绘制有明确诊断。

同构建分项已实测离线CSS／PNG／普通占位字符串、禁链接／表单／录制按钮、精确#1↔#8与DOM12.00↔13.00、播放暂停、断线读取触发stale销frame及恢复、取消读取不复活、缺失资源诊断、旧generation／跨replay／错误source消息不触发核验。正常点击发出精确node22／事件#8的核验请求并得到200和字段绑定控件；完整保存／发布与三态在最终attempt9通过，见下节。

保留测试假设问题：attempt2点击range中点先触发seek并disabled，随后End无效；改正常focus与Home/End并核value。attempt3仅CDP offline但既有SSE未断且无新请求，不能视为产品已感知离线；改离线时正常刷新触发实际失败。attempt4释放已取消截留响应得到Invalid InterceptionId，后续记录Network取消与不复活，不声称已送达迟到payload。attempt5等待瞬态成功notice，但随后正常state覆盖；改看持久绑定控件及完整source身份。它们不计新增产品修复。

## 最终主链 attempt9 与独立回读

2026-09-30 14:52:02–14:52:31 UTC，使用正常Native UI创建合成项目、录制并封存来源；封存后关闭本地来源server，再由浏览器正常明确配对、建立保存点、打开离线历史。没有预造被测字段／固定版／执行报告。

1. 实际浏览器DOM显示历史 `13.00`，归档CSS颜色 `rgb(12,67,89)`、PNG与普通 `bes-inline:` 文本正确，来源关闭后无额外Web网络请求
2. 正常点击选到node22／top frame／原mirror scope／精确eventSeq8，后端SourceModel核验后由资料编辑器保存完整target；字段保持string／exact-text，不修改语义取得通过
3. 唯一固定revision `281a7e03-2cb0-41c9-92f4-fd700201f7bb`，contentHash `51f123c7a1799d20e262ece6a45373d7a98fcc17209100fc5f448d8f45bbbf74`；独立重算hash、刷新／重新配对回读一致
4. Native读取同一历史13.00／node22／归档CSS／PNG，实际使用共享controller；正常点击“读取修订4并处理冲突”处理旧本机输入保护，领域draft没有被此步骤改写，再回读同一固定版本
5. 同一固定字段和登记脚本通过Native正常选择真实dataset attempt再验收：good输出14.00、真实当前采样14.00 → pass；wrong输出15.00、采样14.00 → fail；no-source输出14.00但无sourceRefs → inconclusive。历史示范13.00仅作为例证，未混当运行期14.00的证据

对应执行／报告：

- good：`055080fe-1c33-4e1c-bd60-736fda88722e`／`574e6324-b22e-4a93-826f-f677329ccbdf`
- wrong：`61376921-4512-45f3-aae9-13266178c500`／`a6106758-b14a-4a82-9cd8-7b4b2c30b276`
- no-source：`5c699805-59cc-483f-921f-d58dfb19ed4a`／`83811861-1947-475f-b624-07ff68847c4f`

三者均核execution／workflowAttemptId／dataset attempt／固定binding／实际source sample，不仅查toast或报告颜色。0 pageerror；1450×935与1100×760的回放、选取字段、固定版无横向溢出，关键控件实际命中。退出后原录制12个原件文件与固定版hash复核未变；生成的index／replay-index排除在原件hash清单外，不把可重建索引写入误判为原件变化。

attempt7已通过浏览器主链与Native同源回放，后遇旧本机输入保护；attempt8按正常UI读取修订后通过两端回读，但harness漏选“用于验收”使good报告真实inconclusive。attempt9显式选择真实attempt后完成三态；旧inconclusive报告保留，不覆盖或改字段求通过。

### 分项覆盖与旧路径回归

播放暂停／精确seek、断线恢复、关闭取消、缺失资源与旧消息负测来自同一最终产品构建的attempt2–5／diagnostic证据，主链attempt9未机械重跑全部负例；分项与完整单次通过不能混写。被取消的截留HTTP以实际ERR_ABORTED／不复活证明，不宣称已释放旧payload。录制按钮／链接／表单不可交互及额外网络为0已实测；探针恶意内容不是产品全部攻击矩阵。

最后运行既有 `node test/desktop/launch.js --refactor-replay`，`output/desktop-1790780107262` PASS／exit0，PID85504正常shutdown-complete。该flag实际运行S0 prototype的真实record/replay、6次seek、Mirror／CSS-XPath／metadata gap，不冒称它覆盖共享ReplayHost所有连续播放生命周期；共享controller实际证据来自attempt9双宿主与replay-host定向回归。

## 最终源码、构建与启动

验收时HEAD是基线加未提交源码，sourceDirty=true。main SHA-256 `9094bcf4d7e8a49316e28497e8b67a5b940424deeb28787a357d78df141635c9`；Native renderer `index-CLeA5htU.js` SHA-256 `ec9cb16d11b5cf44060d4f312c351b1c6b124d863e8f0caa3ec8249fdc92e3df`。

552文件源码／测试／脚本／config／构建清单为本地 `b2-proof/attempt9/source-manifest-after.json`，SHA-256 `2af34bfd295ba04eaec727073b26f20b35db4ef1f4cea8ca99824b11d99db72a`，root独立逐项核对无差异。提交收尾仅删除新 `shared-web-replay.tsx:91` 的一个行尾空格，之后typecheck、3文件25项和diff-check通过；未因此重建或冒称最终提交与实测source逐字节相同，业务代码语义和实测构建未变。

匹配Node24.21／npm11.19后 `npm run build && npm run start:workbench`，从当次终端取得browser URL，正常创建合成项目／封存，再显式选择回放权限配对。attempt9历史实例 `d45167a1-9796-442d-bb88-6b581626aae9` 的UI为 `http://127.0.0.1:40449/browser.html`、独立replay origin为 `http://127.0.0.1:46719`，已正常退出，不把历史URL当作仍在线。全程不触碰既有demo／用户浏览器；所有自有实例已关闭。

## 边界与下一阶段

B2指定合成纵向已成立；后端仍是electron-companion，Web回放只覆盖有界历史窗口。完整多浏览器／iframe／shadow／权限矩阵、全部恶意归档组合、旧profile兼容与已知SVG保真缺口未全验。部分底层归档IO仍不可抢占，过期输出不会交给新回放。旧Electron alert/confirm问题按用户决定保留，未改变交互。

B3纯Node后端／独立Chromium provider尚未开始。下一步应基于当前B1/B2可观察收益、旧profile兼容和生命周期风险决定是否推进，不把此阶段称为已完成两种完整后端。
