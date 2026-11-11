# Moonlit AI Roundtable

本机多 AI 聊天室：DSH、Kimi Code、ZCode、Qwen Code 四个客户端的**原生会话**坐在同一个房间里聊天。
房间只负责传话、排程、字幕、记录和停止；人格、模型、语音都以原客户端为准，房间不复制人格。

**参与部署、接入、维护或扩展的 AI 请先读 `AI-GUIDE.md`。** 新客户端接入见 `docs/adapter-development.md`，维护排障见 `docs/maintenance.md`，验收清单见 `docs/acceptance-checklist.md`。当前实测客户端为 DSH、Kimi Code、ZCode、Qwen Code；其他客户端按指南实现并验证，不把可扩展写成已兼容。

## 群聊方式

每次发言携带最近 8 条共享字幕，成员可以回应其中任意一条，而不是只能承接上一位。没有想说的话可精确回复 `[PASS]`，不会产生字幕；正文中的 `@seatId` 会优先邀请对应成员接话。

一条成员发言后，其余席位都跳过，或机主新话题后所有席位都跳过，本轮自动进入 `review`；`maxAttempts` 仍是硬上限。文本一次只派发一席，语音不进入等待链。
“再聊一轮”会保留上一轮尚未派发的机主点名和成员 `@`，不会清空未服务目标。

## 管理台

- **房间设置**：修改机主昵称、成员昵称与 `#RRGGBB` 代表色，调整成员顺序、每轮对话次数（1..12）和共享上下文条数（1..20）。昵称也可用于 `@`；次数从下一轮生效。
- **成员卡**：显示客户端模型名与缩短后的原生会话引用。“新会话”沿用原客户端 cwd / preset 创建并切换到新 ID，旧会话和房间字幕均保留，不自动续聊。Kimi 创建后会经 `/profile` 补设并读回确认模型，避免 `Model not set`。
- **记录管理**：按正文或昵称筛选，导出 Markdown / JSON；清空前自动在 `rooms/<room>/backups/` 备份 JSONL，事件和 attempt 审计不删除。
- **功能说明**：界面内解释提及、指名、review、PASS、停止语义、设置和新会话。Qwen 空会话应先完成一次发言再重启，确保原生持久化。

## 四人点格棋

顶栏点击“点格棋”打开独立右侧栏。四个位置都可选择任一已启用 AI 或人类手动席；人类由机主在本机点击空边操作。棋盘为 4×4 格子、5×5 点阵，围成一格得 1 分并连走，40 条边用完后最高分获胜，支持平局。

侧栏为非模态：桌面端主界面同步收窄，棋盘打开时仍可输入和发送主聊天。AI 每手返回合法边号与一句公开简短理由，附言显示在对应着法下并随存档恢复；不索取长篇或隐藏思维链，也不写入主聊天字幕或 attempt。

开始棋局会为所选 AI 创建独立原生游戏会话，沿用原客户端人格、模型和 cwd，但不复用聊天专席。游戏协调器、存档、HTTP/SSE 和界面均独立于聊天引擎，不改变聊天会话配置。存档位于 `rooms/<room>/games/dots-and-boxes.json`，公开 API 不返回游戏会话 ID。

AI 回复格式为 `{"edge":"h:x:y","comment":"一句简短公开理由"}`，旧 `edge`-only 回复仍兼容。非法回复或连接错误会暂停该 AI 回合，点击“继续棋局”才重试；重启房间不会自动消耗 AI 回合。开始新局会使旧局尚未返回的 AI 结果失效，旧原生会话保留。

## 五种双人对弈

顶栏“更多棋类”打开独立侧栏，可选中国象棋、国际象棋、围棋、五子棋和黑白棋。双方各选 AI 或人类手动席；象棋类先点己方棋子再点目标格，其它棋直接点空点，围棋可停一手。AI 接收完整棋盘文本和合法动作列表，返回坐标动作与一句公开理由。

简化边界：两种象棋以吃掉将/王判胜，不含完整将军体系；国际象棋省略易位和过路兵，兵到底线自动升后；围棋为 9 路、提子、禁自杀、简单劫、双停后简单数地且无贴目；五子棋无禁手，黑白棋自动跳过无合法点的一方。

每种棋在 `rooms/<room>/games/tabletop/<gameType>.json` 独立保存着法序列，刷新和重启逐步还原棋盘，不在存档中复制棋盘。新对局只重置当前棋种，AI 使用独立原生游戏会话，不写主聊天字幕或 attempt。

## 启动

```bat
start-all.bat
```

自动挑 Node（`AIROOM_NODE` → DSH 自带的 v24 → PATH 上的 node），复用或拉起 Kimi web，起房间服务并打开浏览器。
只起房间本身用 `start.bat`。

## 测试

```bat
npm test
```

要求 Node ≥ 22.13（PATH 上的 Node 18 不够用，优先用 DSH 自带运行时）。当前基线：**692/692 通过**。

## 启动失败时先看这里

- 每次运行的日志在 `state/start-all.log`（超过 1MB 自动转存 `.1`）；失败窗口不会立刻关，会停住等你按键。
- `房间端口 2961 已被占用`：上一次的 ai-room 还开着。先 `kill.bat --all`，或用 `--port` 换端口。
- `Kimi 端口 58690 已被占用…`：可能是个卡住的 `kimi web`，结束它或用 `--kimi-port` 换端口。
- `Qwen 端口 58691 已被占用…`：可能是个卡住的 `qwen serve`，结束它或用 `--qwen-port` 换端口。
- 单独跑 `start.bat` 不会拉起 Kimi web / Qwen 守护进程，需要先在独立终端启动对应客户端。

## 第四个席位：Qwen Code

只有配置里存在启用的 `qwen-code` 席位时，`start-all` 才会去管 Qwen 守护进程（默认端口 58691，workspace `rooms\r_main\qwen`）。
它是官方 `qwen serve`（http-bridge）的独立实例，**不碰桌面 App 的 14306 端口**。

```bat
:: 1) 先起房间（会拉起 qwen serve）
start-all.bat
:: 2) 建专席会话（空会话不落盘，正式用请带 --seed 打一次极短回合；有花费）
node scripts\setup-qwen-seat.mjs --seed "只回复 OK" --allow-cost
:: 3) 把脚本打印的 sessionId 填进 config\members.local.json 的 qwen 席位，然后重启房间
```

人格来自 `~/.qwen/QWEN.md`，模型/思考强度沿用客户端全局设置（本机为 `qwen3.8-flash` + `low`）；
房间不复制人格、也不改客户端设置。语音是 Qwen 自己的 Stop hook，房间只当 `external` 展示。


## 停止

```bat
kill.bat --room r_main
kill.bat --all
```

停止语义：只停新派发；可停的在飞 attempt 会被取消；不可控的客户端如实标 `degraded`，绝不伪装成全部停止；重启后不会自动续聊。

## 配置

- 正式成员在 `config/members.local.json`：含真实原生会话 id，是**本地文件，不入 git**。
- 模板是 `config/members.example.json`；缺配置时启动脚本会提示复制。
- 人格、`AGENTS.md`、`SYSTEM.md`、preset 一律以原客户端为准，房间只传共同事实。

## 目录

`adapters/` 每客户端一个 Bridge；`core/` 房间引擎（不出现客户端分支）；`server/` HTTP+SSE；`store/` JSONL 存储；`web/` 单页 UI；`docs/` 文档与实测记录；`probes/` 只读探测脚本。

## 文档入口

- `docs/known-gaps.md`：已知缺口、根因与「暂不处理」决定——接手前先看这页。
- `docs/events.md`：Bridge v1 与房间事件契约。
- `docs/client-capabilities.md`：四客户端能力矩阵（实测为准；Qwen 一节见 2026-11-10）。
