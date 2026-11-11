# 客户端能力矩阵（M0）

> 版本：2026-11-09 第五版
> 规则：严格区分「实测」「文档」「待测」；没测的不得写成支持，测了不支持的不得写成未知。
> 开发与部署入口：`AI-GUIDE.md`；新客户端接入：`docs/adapter-development.md`；验收：`docs/acceptance-checklist.md`。
> 当前实测客户端只有 DSH、Kimi Code、ZCode、Qwen Code。其他客户端是“可按指南扩展”，不是“已经兼容”。
> DSH 一列来自 `docs/dsh-m0-probe-2026-11-08.md` 与 `docs/dsh-live-short-reply-2026-11-09.md`；Kimi Code 见 `docs/kimi-code-m0-zero-cost-2026-11-09.md` 与 `docs/kimi-live-short-reply-2026-11-09.md`；ZCode 见 `docs/zcode-m0-zero-cost-2026-11-09.md` 与 `docs/zcode-live-short-reply-2026-11-09.md`。

## 一、总表

| 能力位 | DSH | Kimi Code | ZCode |
| --- | --- | --- | --- |
| 客户端版本 | DSH Web `127.0.0.1:2955`（协议代次：Cookie 鉴权 / 斜杠 RPC / remote.mux） | 实测 CLI/server `2.5.2`；OpenAPI 3.0.3、AsyncAPI 3.1.0、WS protocol 2 | 实测桌面 3.17.2.9661、CLI 0.17.1、Protocol v1 NDJSON |
| `nativeSession` | ✅ 原生会话（`sessions.list` 可枚举，含 title / preset / cwd / running / 用量） | 已有专席的 WS 订阅与真实 prompt 均成功，返回 OK | resume/subscribe/send 已实测成功，返回 OK |
| `nativeIdentity` | ✅ 会话自带 `agentPreset` + 工作区 `AGENTS.md`；外部投递不改变人格 | 专席 cwd + 默认模型已实测；无人格指纹字段，未覆盖人格配置 | workspace/mode/settings 保持原值；人格来自全局与工作区 AGENTS.md |
| `sendToExistingSession` | ✅ `sessions.prompt({sessionId, mode:'queue', content})` → `{accepted:true}` | 实测 `POST /api/v1/sessions/{id}/prompts` 接受，prompt_id 与 turn 对齐 | 实测 `session/resume` + `session/send` accepted，inputId 对齐 |
| `finalMessageEvent` | ✅ `turn/end` 且 `reason.kind === 'completed'`，正文在 `assistant/message` 的 text 块 | 实测以 `transcript.ops` + assistant text frame 得到 OK；本机没有 turn.started/ended | 实测 `turn.completed.response=OK`、resultType=success |
| `messageDeduplication` | ✅ 以 `(sessionId, turn)` 为键；快照不重放 live 事件；重连需按未结束 turn 补 collector | 实测 prompt_id/turnId/frameId 各完成一次；断线恢复为离线契约覆盖 | 实测 Started/Completed 各一次；afterSeq 恢复为离线契约覆盖 |
| `requestAbort` | ✅ `session/cancel`（实测 29ms，`turn/end.reason.kind='aborted'`，会留下已生成的部分正文） | 文档支持 session/prompt 两级 `:abort`；真实取消仍待测 | 二进制有 `session/stop`，真实取消仍待测 |
| `queueClear` | ✅ `session/projections` 读 `values.inbox` → `session/updateQueue {action:{kind:'remove'}}` 逐项删 → 再 cancel | 文档可读队列；排队项能否单独移除待测 | 未找到队列移除 RPC |
| `voiceTrigger` | ❌ **未发现原生 TTS**：事件流无语音帧，设置只有 `speech-to-text`；外部语音另行评估 | **native 已实测**：Stop hook 排队并播放 OK，`played=true` | **external 已实测**：Stop hook 排队并播放 OK，`played=true` |
| `voiceStartedFinishedEvents` | ❌ 无对应事件 | 官方 Server API / ACP 未提供语音事件族 | 未找到语音事件族 |
| `voiceStop` / `voiceMute` | ❌ 无对应接口 | Server API 无按席位语音控制接口 | 未找到原生控制接口，不修改外部 hook 配置 |
| `providerUsage` | ✅ 会话投影 `projections.values.tokenUsage`（input/output/cacheRead/cacheWrite 四桶，精确） | 实测 transcript step usage 有效；session profile 累计值本机未可靠更新 | 实测 turn.completed usage：input/output/cacheRead 等字段 |

## 二、DSH 实测细节（可复现）

### 2.1 连接与鉴权

- 客户端：`qq-bridge/src/dsh-client.js` 的 `NodeApiClient`（`AbstractApiClient` 传输层 + 离线铸造 Cookie）。
- 离线铸造：从 `~/.dsh/.credentials.yaml` 的浏览器会话签名密钥本地 HMAC 铸 Cookie，**不依赖进程启动 token**；DSH 重启不掉线。
- 运行时要求 **Node ≥ 22.13**（本机 PATH 上的 `node` 是 v18.12.1，会报 `crypto is not defined`；实际用的是 DSH 自带 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` = v24.21.0）。

### 2.2 探测到的接口（全部只读或已验证）

| 用途 | 调用 | 返回形状（实测） |
| --- | --- | --- |
| 列会话 | `sessions.list({})` | `{items:[{sessionId, title, running, blank, cwd, projections:{values:{agentPreset, modelSelection, tokenUsage, inbox, title}}}]}`（本机数百条） |
| 建会话 | `sessions.create({workspaceId?, agentPreset})` | `{sessionId}`；**不传 workspaceId 也能建** |
| 建工作区 | `workspace.create({path})` | 失败码 `workspace/invalid-path`：**目录必须已存在**（走 realpath） |
| 订阅事件 | `events.mux({})` + `events.follow(sessionId)` | `session/snapshot`（历史，只喂账本）+ `session/event`（live） |
| 投递 | `sessions.prompt({sessionId, mode:'queue', content:[{type:'text',text}]})` | `{accepted:true}`，往返 **22ms**；**不返回 turn id** |
| 读队列 | `session/projections({sessionId})` | `values.inbox = {"next-turn":[], "next-step":[]}` |
| 取消 | `session/cancel({sessionId})` | `{ok:true}`，29ms |
| 归档 | `workspace.archiveSession({sessionId})` | OK |

### 2.3 一次回合的真实事件序列（实测，2026-11-08 23:47）

```
turn/start (turn=1)
step/start
system/message, user/message ×2
request/header (reason=initial), request/context
session/title, session/title-llm-request        ← DSH 自己还会跑一次「起标题」的模型调用
session-log-deepseek/delivery-accepted
assistant/message  blocks=[reasoning, text]      ← 正文在 text 块，reasoning 要丢掉
step/end
turn/end  reason={kind:'completed'}              ← 结束信号，text 完整
```

取消的那条：

```
turn/start (turn=2) … assistant/message(部分正文) … turn/end reason={kind:'aborted', reason:{kind:'user'}}
```

### 2.4 四个必须写进 Bridge 的坑

1. **`turn/start` 可能早于 `prompt` 的 HTTP 响应到达**（实测 turn/start 在 43.191，prompt 返回在 43.195）。
   所以 collector 必须在投递**之前**就位，且不能用「响应里带的 turn id」做关联——只能按「该会话上出现的下一个新 turn」关联。
   附带结论：**席位会话必须专席专用**，否则机主在 GUI 里手动聊出来的 turn 会被误当成房间的回复。
2. **取消会留下部分正文**（实测已生成 73 行数字才断）。房间侧必须规定：`aborted` 的 turn 正文**不进字幕**，
   只记 `attempts.jsonl`（`status: aborted` + 已产生文本 + 用量）。
3. **重连/重启不能重放快照**：`session/snapshot` 含历史 turn/end，只能喂账本；
   断线时正在跑的 turn 要按「有 start 无 end」重建 collector，否则这一轮回复会被静默丢弃（QQ 桥接踩过，注释在 `dsh-client.js:2664-2704`）。
4. **第一条 turn 的 `turn/start` 可能在开场快照里**（实测复现：follow 后立刻投递，`turn/start` 没走 live 通道，
   只好从快照的 `records` 里按「有 start 无 end」重建 collector 才拿到正文）。
   这就是「回复丢失但 token 照付」的真实成因，Bridge 必须实现快照重建，不能只跳过快照。

## 三、语音结论（计划 v0.3 已按并发播放与仅文本能力修订）

- DSH 侧**没有任何语音事件、没有 TTS/朗读设置项**；事件流里也从不出现 speech 相关帧。
- 因此「DSH 原生语音」在当前版本上**不成立**，除非：
  a) 机主在原客户端界面亲耳确认有朗读；或
  b) 有独立插件在做朗读（本机历史上存在过「文本转语音插件」会话，但那是外部 TTS 工具，不是 DSH 内置）。
- 建议：DSH 席位的 `voiceMode` 先标 `none`，UI 显示「仅文本」，**不显示 speaking 状态**。
  这正好符合 GLM 的新决定：房间不做语音排队/仲裁，所以 DSH 没有语音不阻塞任何流程。

## 四、Qwen Code（2026-11-10 实测，零成本）

| 能力位 | 实测 | 依据 |
| --- | --- | --- |
| 客户端版本 | 0.27.1，协议 v1 / http-bridge | `GET /capabilities` |
| `nativeSession` | ✅ `sessionId` 可枚举/可按 id 恢复 | `POST /session` / `GET /workspace/<ws>/sessions` |
| `nativeIdentity` | ✅ 人格来自用户级 `~/.qwen/QWEN.md`（房间只存引用与 hash） | 文件存在且 settings 里加载 |
| `sendToExistingSession` | ✅ `POST /session/:id/prompt` → 202 `{promptId,lastEventId,eventEpoch}` | 代码与探测 |
| `finalMessageEvent` | ✅ SSE `turn_complete`（`data.promptId` / `data.stopReason`）；正文取 `session_update.agent_message_chunk` | `chunk-5ZQUSI7H.js` + 探测 |
| `messageDeduplication` | ✅ 键为 `(sessionId, promptId)`；SSE 帧带自增 `id` 可续传 | 探测 |
| `snapshotRecovery` | ✅ `Last-Event-ID` + `X-Qwen-Event-Epoch` | 探测（SSE 头） |
| `foreignTurnDetection` | ✅ `promptId` 对不上在用 attempt 的 `turn_complete` | 代码 |
| `queueClear` | ❌ 只有 `pending-prompts` 单项，没有批量清队列语义 | 实测 |
| `requestAbort` | ✅ `POST /session/:id/cancel`（最终仍由 `turn_complete` 确认） | 代码 |
| `providerUsage` | ⚠️ 未知：事件可能带 `assistant.usage`，本轮未发 prompt 未验证 → 先标 `null` | 待真实验收 |
| `voiceTrigger/voiceStartedFinishedEvents/voiceStop/voiceMute` | ❌ 全 false；语音是外部 Stop hook（`~/.qwen/hooks/speak.ps1`） | 实测配置 |
| `voiceMode` | `external`（房间不仲裁、不等朗读） | 实测 |

模型/强度：新专席会话实测读回 `qwen3.8-flash(openai)` + `reasoning_effort = low`，与全局设置一致。
