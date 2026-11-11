# 已知缺口与暂缓项（交接台账）

> 日期：2026-11-09
> 结论先行：下面这些**不是回归**，是并入时就知道的缺口。按机主要求本轮**不修**。
> 谁要动手，先看这页，别重新调查一遍。

## 1. 用量统计缺口（3 项，本轮不处理）

| 现象 | 根因（已定位） | 修复代价 | 数据证据 |
| --- | --- | --- | --- |
| GLM 每轮 `usage` 为空 | `adapters/zcode/bridge.mjs:1582 _emitUsage()` 固定 `_emit(UsageReported, null, payload)`，`attemptId` 永远是 null；而 `core/engine.mjs:1435 _handleUsageReported()` 开头 `if (!attemptId) return;` 直接丢弃 | ≈10 行 + 2 用例 | `rooms/r_main/attempts.jsonl`：18 条 completed 里 glm 6 条全 null；探针实测 `turn.completed` 本身带 usage（in 23286 / out 31）；`tests/contract/zcode.contract.test.mjs:1329` 目前还断言 `attemptId === null` |
| DSH 完全不上报用量 | `adapters/dsh/bridge.mjs` 全文只有 `providerUsage: true` 能力位，从未读取 `assistant/message` 的 `data.usage` | ≈30 行 + 3 用例 | deepseek 6 条 usage 全 null；qq-bridge 生产账本 `state/token-usage.jsonl` 的每条 turn 记录都来自该事件，证明 DSH 确实带桶用量；`docs/dsh-live-short-reply-2026-11-09.md:117` 亦记录 |
| Kimi `cacheRead` 缺失 | `adapters/kimi-code/bridge.mjs:466 normalizeUsage()` 只认 `cache_read_tokens/cacheRead…`，不认 Kimi 真实字段 `inputCacheRead`；且只读 `turn.usage`，没读 transcript 的 `steps[].usage` | ≈15 行 + 2 用例 | kimi 6 条 usage 有 input/output、`cacheReadTokens` 恒为 null；真实 transcript step 形状是 `{inputOther, output, inputCacheRead, inputCacheCreation}`（`docs/kimi-live-short-reply-2026-11-09.md:168-173`） |

**修的时候先定一条规则**：同一轮用量只能到账一次——要么 `UsageReported`（带 `attemptId`），要么终结事件 payload 里的 `usage`，两者不得重复携带同一批数字（Core 的 `mergeUsage` 是加法，双发会翻倍）。

## 2. 真实闲聊观察（只读历史记录，未调用模型）

数字取自 `rooms/r_main/attempts.jsonl` 的 18 条终结 attempt（耗时 = `endedAt - startedAt`）：

| 席位 | 轮数 | 平均字数 | 最长 | 平均耗时 | 最慢 | usage |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek | 6 | 55 | 78 | 2.5s | 5.1s | 无 |
| kimi | 6 | 131 | 178 | 25.7s | 40.4s | 有（无 cacheRead） |
| glm | 6 | 227 | 239 | 60.8s | 142.0s | 无 |

1. **速度差约 20 倍**：deepseek 秒回，glm 单轮最慢 142s。房间目前**不显示单条耗时**，机主只能自己掐表——这是「响应耗时观测」缺的那块，属观测不是修复，本轮不做。
2. **长度失衡**：glm 平均 227 字，固定「卷宗核讫 / 原样呈堂 + 括号旁白 + 大段转述他人」结构；kimi 常 131 字三段式；deepseek 55 字偏口语。整体更像「发言稿」，不像闲聊。
3. **18/18 全 completed**：没有 `[PASS]`、没有 failed / aborted / foreign turn——每轮三席都出场，没人主动沉默。
4. **顺序接龙已于 2026-11-11 修复**：Core 共享最近 8 条字幕，成员可 `[PASS]`，`@seatId` 进入直达队列；按席位记录沉默，新一轮保留未派发指向。本地 `maxAttempts` 从 4 调为 8，仅作硬上限。两轮真实四席验收出现跨消息接梗、Qwen → `@glm` → GLM 接话及真实 PASS；全量回归 **460/460 通过**。人格与各客户端配置未改。

## 3. 工程状态

- git 仓库：已于 2026-11-09 建立基线提交（`C:\KIMIW\ai-room` 在此之前没有版本控制，是交接时最大的维护风险）。
- `config/members.local.json` 含真实原生会话 id：已在 `.gitignore` 内，提交前核对过未入库。**不要**改这条忽略规则，也不要用 `git add -f` 硬塞。
- 2026-11-09 修了一轮启动问题：端口预检（房间 2961 / Kimi 58690）、Kimi 冷启动等待从 20s 放宽到 60s 并打印进度、`state/start-all.log` 日志、失败时窗口停住不闪退、`.bat` 强制 CRLF（cmd 对混合行尾会解析错乱）。
- 顺带发现：本机 `127.0.0.1:2960` 一直被 DeepSeek Harness 自己占用，所以 `server/live.mjs` / `server/demo.mjs` 的默认端口改为 2961，与 `start-all` 对齐。


## 4. 暂缓项（需机主明确批准才做）

1. 修上面 3 项用量统计（根因已写清，随时可做）。
2. `elapsedMs` 落 `attempts.jsonl` + UI 显示（观测增强，不是修复）。
3. 一次三席真实回合验收（几分钱，且会用到三个原生会话，需机主在场）。

## 5. 复核口径

- 基线测试：`npm test` → **408/408 通过**（2026-11-09 实跑 ~9.8s）。
- 本文数字来自 `rooms/r_main/attempts.jsonl` 与 `rooms/r_main/transcript.jsonl`，不来自记忆或推测。

## 6. 会话 id 与仓库卫生（2026-11-10 补）

- 真实专席 id 只应存在于 `config/members.local.json` 与 `state/`（两者都已 gitignore）。
- 2026-11-10 做 Qwen 接入时，一次误把本地配置备份（含真实 id）暂存进过一次提交，**已 amend + gc 清掉**；当前仓库里查不到 Qwen 专席 id。
- 早先的探测报告（dsh/kimi/zcode *-live-short-reply）里原本带着真实会话 id，现已把**当前文件**脱敏成 `<..._SEAT_SESSION_ID>`；
  但 **git 历史里仍能找到旧值**（仓库没有远端、也没发布）。若以后要开源/分享，先重建仓库历史或跑一次 filter-repo 再推。

## 7. Qwen ACP 崩溃导致 session_not_found（2026-11-11）

- 真实根因：ACP 子进程发生 `Zone Allocation failed - process out of memory`，守护进程随后拆除会话通道，后续 `/prompt` 与 `/events` 才返回 404；专席 transcript 未丢失。当时 Windows 物理与虚拟可用内存都约 0.3GB。
- Bridge 已改为发送与 SSE 共用恢复锁，按原 `nativeSessionRef` resume 并重置事件基线。仅明确被 404 拒绝的 prompt 在恢复后按原 `attemptId` 重投一次；已获 202 的请求绝不自动重放。
- 实机故障注入：仅结束 ACP 子进程，原专席状态从 404 恢复为 200，resume 约 15.8s；随后真实 Qwen 回合 completed、error=null。全量回归 **462/462 通过**。
- 边界：自动恢复不能预防内存不足再次造成 ACP 崩溃。若频繁复发，需要机主释放内存或排查其他占内存程序；不要擅自改系统虚拟内存或关闭无关程序。

## 8. 管理台与原生会话切换（2026-11-11）

- 设置已覆盖机主/成员昵称、颜色、顺序、每轮次数和共享上下文条数，配置原子写回；成员卡显示真实模型元数据。记录支持筛选、导出及备份后清空；界面内提供提及、指名、review 等说明。
- 一键新会话只在机主明确调用时发生，沿用原客户端 cwd / preset，旧会话和房间字幕保留。Kimi 请求体为 `metadata.cwd + agent_config.model`，创建前刷新缓存，创建后再经 `/profile` 补设并读回确认模型；ZCode 使用 `session/create + workspace + persistence=immediate`，并在同一 app-server 内 `adoptNativeSession`，避免新实例看不到新 ID。
- 真实临时房间验证：DSH / Kimi / GLM / Qwen 均创建并切换到新 ID，正式配置未改；GLM 模型与思考等级保留。随后机主主动切换四席，Kimi 曾出现 `Model not set`，现已修复并实测首发 completed。全量回归 **474/474 通过**。
- 边界：Qwen 空会话应先完成一次发言再重启，确保原生持久化；部分客户端的新会话在首次发言前不公开模型名，界面显示“模型未知”，不拿旧模型名冒充。

## 9. v0.2.0 成员扩容与计数管理（2026-11-11）

- 版本统一为 0.2.0，界面可查看更新日志；成员支持按昵称、seatId、模型搜索，超过 6 席自动紧凑显示，也可手动切换。
- 计数支持 JSON 导出与备份后重置；重置仅清零排程统计、各席结果、选择序号和本轮用量基线，不删除字幕、attempt 审计或原生会话，也不自动续聊。
- 旧排程缺少每席 `stats` 时按 `terminalAttempts` 自动迁移，避免升级后历史计数归零。真实房间验证四席各 2 次 completed；重置后消息 195、attempt 257 保留，重置前 completed=8 已备份。
- 当前全量回归 **476/476 通过**，并完成真实浏览器导出、搜索、迁移与重置验收。

## 10. v0.3.0 四人点格棋（2026-11-11）

- 游戏使用独立规则、协调器、原子存档、HTTP/SSE 与 Web 状态；AI 使用独立原生游戏会话，不写聊天字幕、attempt 或排程，重启不自动消耗 AI 回合。
- ZCode 初次实机曾在创建后报会话不存在：聊天 app-server 创建的新 ID 不会被另一个游戏 app-server 立即看到。现改为在游戏自己的 app-server 内 create + adopt，再将已连接 Bridge 交给协调器；不共享聊天客户端、不重复 connect。
- 四种客户端均完成真实合法落子并交还人类回合：DeepSeek `h:1:0`、Kimi `h:3:4`、GLM `h:3:4`、Qwen `v:2:2`。每轮聊天均保持 203 条字幕、265 个 attempt，聊天专席引用未变。
- 真实浏览器完成四手围格、比分与连走验证；细 SVG 线命中区不足的问题已改为有实际宽高的透明热区。全量回归 **532/532 通过**。
- 边界：AI 非法 JSON 或不可用边会进入 error，需机主点击继续；开始新局会使旧 AI 结果失效，旧原生会话保留。

## 11. v0.4.0 边玩边聊（2026-11-11）

- 点格棋改为非模态右侧栏，AI 每手附一句公开简短理由并随 moves 原子存档；旧 edge-only 回复兼容，附言不进主聊天。
- 初次仅改 show() 后侧栏仍遮住发送按钮，已改为主界面同步收窄；真实浏览器在棋盘打开时成功发送主聊天，消息落账且棋盘保持打开。
- 真实 DeepSeek 落子 `h:1:0` 并返回公开理由，聊天保持 203 条字幕、265 个 attempt；全量回归 **542/542 通过**。
- 小屏空间不足时侧栏全宽，关闭侧栏即可恢复主聊天；不强行在窄屏同时压缩两栏。

## 12. v0.5.0 五种双人对弈（2026-11-11）

- 新增中国象棋、国际象棋、9 路围棋、五子棋、黑白棋；双方 AI/人类可选，鼠标操作、合法动作校验、胜负/平局、附言、独立存档与重置均已落地。
- 简化边界在界面明示：象棋类吃将/王胜且无完整将军体系，国际象棋自动升后但无易位/过路兵，围棋简单劫、双停数地、无贴目。
- 每类只存着法并按序列重建棋盘。前端曾因 gameOf 把 game:null 的管理器快照当成已有棋局，导致首屏和首次重置误报，已修并加空值回归。
- DeepSeek 五种真实合法落子均带公开理由，聊天保持 203 字幕/265 attempt；浏览器验证五子棋刷新还原、国际象棋 e2→e4 和重置，全量回归 **692/692 通过**。

## 13. v0.5.1 AI 交接文档（2026-11-11）

- 新增 `AI-GUIDE.md`、`docs/adapter-development.md`、`docs/maintenance.md`、`docs/acceptance-checklist.md`，覆盖部署、客户端接入、维护、扩展与验收。
- 当前实测客户端仍只有 DSH、Kimi Code、ZCode、Qwen Code。其他客户端由接手 AI 按 Bridge 指南自行探测、实现和验收，不把“可扩展”写成“已兼容”。
- 本轮只改文档、配置注释与版本，不新增运行时协议或客户端 Bridge。
