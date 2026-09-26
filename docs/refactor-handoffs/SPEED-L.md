# SPEED-L — C01/C02 原生生命周期与输入

- 基线 `046a52e7432fdcebb9524b661ebf4166b80acba1`；分支 `codex/finish-lifecycle-20260926`；工作树 `C:\Users\Ghost\.codex\worktrees\finish-lifecycle\browser-evidence-studio`，本轮新建，未复用旧树。提交 SHA 由集成记录引用。
- C01：ReplayHost 先用具体 UUID 标识 pending open；stale/current view close 不取消其他 pending；全局关闭才取消全部 pending。UI 卸载立即关闭其 pending ID，迟到响应无权替换新 owner；非 stale Escape 选择错误保留在 selectionError。
- 最小共享契约：ReplayOpenInput 可选 replayId（未提供仍由服务端生成；格式/当前重复 ID 拒绝）；可信 closeReplay 要求具体 ID。没有新增 HTTP 回放入口。
- C02：前台/后台共用 Puppeteer ElementHandle 滚动、坐标和 mouse.click；目标保持参与原生呈现直到动作释放，popup 不会使原目标在清理中途消失，前台选择和蒙版不被绕过。
- 动作在异步边界及 Gate 的后续非维护命令前重验页面、target、导航代际、操作连接文档代际、lease、AbortSignal、原生输入状态；安全连接清理仍可执行。API 排队起算 15 秒总期限，取消/超时关闭操作连接并等待清理；过期排队项不会迟到执行。
- 成功结果保留 commandId/generation，增加 completion=command-completed；不代表业务断言成功。input_not_ready=409，action_cancelled=409，action_deadline=408；错误标注 queue/connection/preparation/input/navigation 阶段。
- 原生窗口最小化时实测 contentSize=[0,0]，getVisible 仍可为 true；旧布局随后生成 1×1 隐藏状态。现保留有效 bounds，minimize 隐藏、restore/show 重算；presentationStatus 增加 epoch/minimized/contentSize。合成人类输入先核验控制权，再恢复测试窗口后检查可见性，保留 mask/目标/真实点击断言。
- 三份原始 Q3 日志均从主树 output/q3-desktop-full{,2,3}.log 定向读取。旧日志未记录 minimized/contentSize，不能证明前两条历史失败一定由最小化触发，更不能声称全部同因。
- 本轮真实失败证据（以下相对路径均在本工作树）：`output/speed-l-stale-repro.log` 确认 delayed C 被 A/B close 取消；`output/speed-l-full-repro2.log` 确认旧 UI 夹具要求覆盖层内隐藏点击，已改为拒绝且计数不变；`output/speed-l-native-human-repro.log` 通过 minimize→control→human-input 复现与 Q3 第一条相同的 native-visible 断言；中间 full3 的 popup 清理 guard 过严已修正，日志保留。
- 环境：Node 24.21.0 / npm 11.19.0 / Electron 44.4.3 / Chromium 152.0.7977.130 / Puppeteer 25.11.0 / rrweb 2.1.6。npm ci 独立安装 682 包；首次 Electron 下载停滞，仅终止经检查的本测试 launcher/install PID，复制主树同版本只读 dist 到本树独立目录，未共享可写 node_modules。electron.exe SHA256 `BF0FE749904CA9F713CCFB2427C519FA39D0BBD0337BA411BA08785802E8D548`。
- 窄测试：`npm test -- test/unit/replay-host.test.ts test/unit/gate.test.ts test/renderer/refactor-replay.test.tsx`，最终 3 文件/33 项通过，`output/speed-l-unit-delivery.log`；`npm run typecheck` 最终通过，`output/speed-l-typecheck-delivery.log`；核心候选 `npm run build` 通过，`output/speed-l-build-final2.log`。
- 原生专项：BES_TEST=1、BES_TEST_PHASE=native-input、独立 BES_DATA=output/native-input-final，`node node_modules/electron/cli.js .` 退出0；11案例实际通过，`output/native-input-final/native-input-report.json` / `output/speed-l-native-final.log`。包含3次 live/archive/live、前后台按钮计数、overlay/mask、坐标后 abort/deadline/navigation、无迟到输入、恢复、人类输入、排队期限。
- 完整未跳 UI 保序矩阵：`node test/desktop/launch.js` 退出0，`output/speed-l-full-final.log` / `output/desktop-1790422834205/desktop-summary.json`。主流程、原 origin/profile 跨 PID、5处强杀+各两次重开、两种退出均通过；前一核心候选 full4 也通过，未删除失败或移用 Q2 成绩。
- Q3生产专项：`node test/desktop/launch.js --refactor-system` 与 `--refactor-handoff` 均退出0；对应 `output/speed-l-system-final.log` / `output/desktop-1790423030678/refactor-system-report.json`，`output/speed-l-handoff-final.log` / `output/desktop-1790423086712/refactor-handoff-report.json`。
- 验证范围：桌面/构建冻结期间未修改源码；完成上述桌面后只补 Escape 非 stale 错误记录及其单测，最终33项与typecheck覆盖此最后窄改动。集成候选仍需按 G2 做全仓单测、build及最终组合验收；本包不替代 R 的恢复/30分钟、P 的包/独立产物或 AT39/真人验收。
- app.ts 本包只接 native-input；R 集成后增加 allowedPhases 的 refactor-recovery，分支内动态 import('../../test/desktop/refactor-recovery')，Object.assign(identity,await runRefactorRecoveryScenario(studio,phase))。launcher 由 R 唯一维护，本包未改。
- 文件仅涉及 app phase、ReplayHost/本地类型、Studio/dispatch、window、Gate/managed-input、ReplayWorkspace及相应测试。本树 output 为合成证据，未加入Git；未改恢复索引、导出、package/lock、打包、旧树、真实profile或录制原件。
- 桌面令牌已于 2026-09-26 19:45 +08:00 释放到共享 output/finish-desktop-token.json；检查无 Electron 残留。不自动推送、不删除树/分支。外部仍未测：物理鼠标/多屏、真实账号；历史两条原生失败的原始 OS 状态仍无法从旧日志追认。
