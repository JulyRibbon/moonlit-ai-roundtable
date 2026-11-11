# Bridge v1 与房间事件表

> 可执行常量：`adapters/contract.mjs`、`core/events.mjs`
> 原则：`send()` 的接收回执不是最终回复；正文、取消和失败全部由事件确认。

## 1. Bridge → Core

共同信封：

```json
{
  "schemaVersion": 1,
  "eventId": "be_...",
  "type": "AttemptCompleted",
  "seatId": "deepseek",
  "attemptId": "a_...",
  "occurredAt": "ISO-8601",
  "payload": {}
}
```

| 事件 | payload 必要字段 | Core 行为 |
| --- | --- | --- |
| `AttemptStarted` | `nativeTurnRef` | 写 attempt，发 `MemberThinking` |
| `AttemptCompleted` | `nativeTurnRef`、`nativeMessageRef`、`text`；可选 `usage` | 只发布一次正文；精确 `[PASS]` 转为 `MemberPassed`，否则发 `MemberResponded` + `MessagePosted` |
| `AttemptAborted` | `nativeTurnRef`、`partialText`；可选 `usage` | 只写 attempts 和状态，部分正文不进入字幕 |
| `AttemptFailed` | `error:{code,message,retryable}`；可选 `nativeTurnRef`、`usage` | 写 attempts，发 `MemberFailed` |
| `ForeignTurn` | `nativeTurnRef`、`reason` | 原生会话中的非房间回合只记录，不进入房间字幕 |
| `UsageReported` | `usage`；可选 `nativeTurnRef` | 合并用量，不生成正文 |
| `SpeechStarted` | 可选 `nativeMessageRef` | 仅展示语音状态，不影响排程 |
| `SpeechFinished` | 可选 `nativeMessageRef` | 仅展示语音状态，不触发下一棒 |
| `SpeechFailed` | `error`；可选 `nativeMessageRef` | 仅展示语音失败，不把文本回合判为失败 |
| `BridgeError` | `error:{code,message,retryable}` | 更新 Bridge 健康状态 |
| `BridgeClosed` | `reason` | 标记连接关闭，禁止继续投递 |

约束：

- Bridge 负责原生事件去重、快照恢复、attempt 关联和 `ForeignTurn` 判定。
- Core 对 `eventId`、`nativeMessageRef` 再做防御性去重，但不按文本去重。
- 同一 `(seatId, attemptId)` 只能有一个终结事件：Completed、Aborted 或 Failed。
- 成员正文里的 `@seatId` 或 `@昵称` 由 Core 提取到 `MessagePosted.payload.mentions` 与 transcript，并加入普通直达队列；邮箱、自点名、未知席位和重复点名不产生目标。
- 每次派发携带 `settings.contextMessages` 条共享字幕（默认 8）。成员发言后其余可发言席位均 PASS，或机主新话题后全部可发言席位均 PASS，本轮结束；失败和中止不计作 PASS。
- `continueRound` 重置尝试、公平和沉默信息，但保留尚未派发的 `ownerPriority` 与 `directQueue`，避免机主点名或成员 `@` 在“再聊一轮”时丢失。
- `SettingsChanged` 携带房间显示与排程设置；`SeatSessionChanged` 表示同席位已切换到新原生 ID；`TranscriptCleared` 表示字幕已在备份后清空。三者均不改变 stop/halt 语义，也不自动 run。
- 语音事件可以并发、迟到、缺失或乱序，均不得阻塞文本回合。
- 没有语音能力的 Bridge 不产生 Speech 事件，并在 probe 中返回 `voiceMode:'none'`。

## 2. Core → UI / JSONL

共同信封：

```json
{
  "schemaVersion": 1,
  "eventId": "re_...",
  "type": "MessagePosted",
  "roomId": "r_main",
  "roomSeq": 42,
  "occurredAt": "ISO-8601",
  "actor": "seat:kimi",
  "payload": {}
}
```

| 事件 | 含义 |
| --- | --- |
| `RoomCreated` | 房间创建 |
| `RoomStateChanged` | draft / active / paused / review / confirmed / archived / halted 状态变化 |
| `MessagePosted` | 一条可见正文已追加到 transcript |
| `TurnRequested` | 机主或调度器请求一席回应 |
| `MemberThinking` | 原生 attempt 已开始 |
| `MemberResponded` | 席位最终回复已完成；正文由对应 MessagePosted 承载 |
| `MemberPassed` | 最终文本精确匹配 `[PASS]`，不生成正文泡泡 |
| `MemberFailed` | attempt 失败 |
| `SpeechStarted` / `SpeechFinished` / `SpeechFailed` | 原生语音展示状态，仅能力存在时出现 |
| `HaltRequested` | 已请求停止并落哨兵 |
| `HaltSettled` | 返回 halted 或 degraded 及逐席结果 |
| `ReviewRequested` | 一段闲聊结束，等待机主确认 |
| `ResultConfirmed` | 机主已确认结果，可导出或归档 |

## 3. DSH v1 映射约定

- `(sessionId, turn)` 映射为 `nativeTurnRef` / 原生去重键，不能用正文哈希替代。
- `sessions.prompt` 返回 `accepted:true` 只完成 `SendReceipt`。
- `turn/end reason.kind='completed'` 映射 `AttemptCompleted`。
- `turn/end reason.kind='aborted'` 映射 `AttemptAborted`，部分正文只写 attempts。
- collector 必须在 prompt 前就位；快照和断线恢复只重建有 start 无 end 的 turn。
- 无 pending attempt 的新 turn 映射 `ForeignTurn`，机主在 GUI 的手工聊天不进入房间。
- DSH 当前 `voiceTrigger=false`、`voiceStartedFinishedEvents=false`、`voiceStop=false`、`voiceMute=false`、`voiceMode='none'`。

## 4. Qwen Code（http-bridge）映射约定

- 去重键：`(sessionId, promptId)`；`promptId` 来自 `POST /session/:id/prompt` 的 202 回执。
- 正文：只累加 SSE `session_update` 里 `data.update.sessionUpdate === "agent_message_chunk"` 的 `content.text`；
  `thought` / `tool_call` / `user_message_chunk` 一律不进正文。
- 终态：`turn_complete`（`data.promptId` 匹配 + `stopReason === "end_turn"` → `AttemptCompleted`；
  其它 stopReason → `AttemptAborted`）；`turn_error` → `AttemptFailed`。
- 断线：用 `Last-Event-ID` + `X-Qwen-Event-Epoch` 续传；续不上就写 `AttemptFailed(unknown)`，不猜。
- `session_died` 或会话 404：发送与 SSE 共用恢复锁，按原 `nativeSessionRef` resume，并清空旧事件游标后重新订阅；不新建或替换会话。
- prompt 仅在明确收到 `session_not_found`（未获 202）时于恢复后按原 `attemptId` 重投一次；已获 202 后崩溃只记失败并恢复通道，绝不自动重放。
- 无在用 attempt 的 `turn_complete` → `ForeignTurn`（机主在 Qwen 客户端的手工回合）。
- `permission_request`：房间无法代答 → `AttemptFailed(QWEN_PERMISSION_REQUIRED)`，提示机主到客户端处理。
- 用量：`providerUsage = null`（待真实验收）；先不把任何猜测写进 attempts。
