# 给本机多 AI 聊天室新增客户端：Bridge 开发指南

> 读者：准备给 ai-room 增加一个 `clientType` 的开发者。
> 范围：只写 Bridge 适配层与注册步骤，不新增运行时协议，不改 `core/` 的排程语义。
> 文中所有会话 ID、token、路径都使用占位符；不要把真实值写进仓库或本文档。

## 0. 先建立正确预期

- 房间负责传话、排程、字幕、记录和停止；人格、模型、语音以原客户端为准。配置里出现 `persona`、`prompt`、`systemPrompt`、`agentsMd` 正文会被 `server/config.mjs` 直接拒绝。
- 一个客户端一个 Bridge。`core/` 不出现客户端分支；不要把某个客户端的字段、重连逻辑或特殊命令塞进 `core/` 或 `server/http.mjs`。
- Bridge 只做三件事：把房间的 `ContextPacket` 投进原生会话；把原生会话里发生的事翻译成 Bridge v1 事件；如实报告能力。
- 能力必须实测。没测过填 `null`，确认不支持填 `false`，只有实现并测过才填 `true`。不要为了“看起来完整”编造通用兼容。
- 无法观察原生回合终态、无法给回合建立稳定引用的客户端，不适合作为生产席位。不要用轮询正文、文本哈希或“等几秒”假装支持。

## 1. 必读文件与各自职责

| 文件 | 你要从这里得到什么 |
| --- | --- |
| `adapters/contract.mjs` | 8 个必需方法、能力名、`ContextPacket` / `SendReceipt` / `CancelReceipt` 形状、生命周期注释 |
| `core/events.mjs` | 唯一合法的 Bridge 事件类型与事件信封 |
| `docs/events.md` | 每种事件进入房间后的行为，以及各客户端现有映射约定 |
| `adapters/fake/bridge.mjs` | 可运行的契约参考实现：缓冲、去重、取消回执、订阅唤醒 |
| `server/config.mjs` | `CLIENT_TYPES`、座位字段、禁用人格键、`nativeSessionRef` 规则 |
| `server/live.mjs` | `DEFAULT_FACTORIES`、Bridge 构造参数、新会话与游戏专席的特殊分支 |
| `core/engine.mjs` | Core 实际如何调用 `connect` / `subscribe` / `send` / `cancel` / `close`，以及何时等待终态 |
| `games/dots-and-boxes/coordinator.mjs`、`games/tabletop/coordinator.mjs` | 游戏如何复用 Bridge 工厂、如何验证 AI 动作 |
| `config/members.example.json` | 座位配置模板（不要照抄其中的占位 ID） |

四个现有实现的参考价值见第 12 节，不要整段照搬。

## 2. 零成本探测

零成本指：不投递 prompt、不触发模型调用。默认也不创建/归档/取消/删除原生会话，只读会话列表、状态、元数据、能力声明、协议文档。个别现有探针会创建临时 scratch 会话（Qwen），但同样不发 prompt、不产生模型调用，并在收尾时关闭自己拉起的进程；写自己的探针时优先连既有会话，不要建新会话。

### 2.1 探测红线

1. **不要用 `subscribe()` 的 ACK 证明会话存在。** Kimi 的 `subscribe_v2` 对不存在的会话也可能回 `ack code=0`；必须先通过 REST / `session/list` / `session/status` 正向确认会话存在。
2. **不要用“收到一帧事件”证明能投递。** 事件流正常不等于 prompt 会被接受。
3. **不要在 `probe()` 里创建会话。** 创建是 `createNativeSession()` 的职责，只能由机主点“新会话”或开始含 AI 的棋局时调用。
4. **不要把 `connect()` 当探测。** `connect()` 可以 resume / attach，但绝不能 prompt。更严格的零成本探测只调用 `probe()`。
5. **不要打印正文、token、Cookie、完整 session ID。** 探测输出只保留类型、数量、字段名、版本号；会话 ID 只显示前缀。
6. **记录证据。** 每项能力写“命令、观察到的字段、结论”，不要只写“支持”。

### 2.2 先跑仓库现有探针

在 `C:\KIMIW\ai-room` 下：

```bash
node probes/dsh/probe-list.mjs --limit 5
node probes/kimi-code/probe-meta.mjs
node probes/zcode/probe-meta.mjs --limit 5
node probes/qwen-code/probe-meta.mjs
```

说明：

- DSH 探针只列会话；Kimi / ZCode / Qwen 探针只读版本、能力、协议与会话元数据。它们不会发 prompt。
- Kimi 探针需要本机已有 `kimi web`；找不到可执行文件时用 `AIROOM_KIMI_EXE` 指定，不要在文档里写死个人路径。
- ZCode 探针会临时拉起自己的 app-server 再关闭，不 resume / send / stop / close 任何真实会话。
- Qwen 探针会拉起一次性 `qwen serve`、建 scratch 会话并读元数据，但不发 prompt、不产生模型调用；收尾会杀掉自己拉起的进程。

### 2.3 给自己的客户端写一个只读探针

放在 `probes/<client>/probe-meta.mjs`，只做：读版本/能力 → 确认目标会话存在 → 打字段名和计数。核心形状：

```js
import { createYourBridge } from '../../adapters/your-client/bridge.mjs';

const bridge = createYourBridge({
  seatId: 'demo-seat',
  nativeSessionRef: process.env.YOUR_CLIENT_SESSION,
});

try {
  const result = await bridge.probe();
  // 只打印能力键、版本、identity.metadata 的键名，不打印正文或凭据。
  console.log(Object.keys(result.capabilities));
  console.log(result.clientVersion, result.voiceMode, result.warnings);
} finally {
  await bridge.close();
}
```

探测要回答的问题：

| 问题 | 合格证据 |
| --- | --- |
| 实例是否可达 | `/health`、`meta`、`session/list` 等只读调用成功 |
| 目标会话是否存在 | 列表/状态按 ID 命中；不是订阅 ACK |
| 会话是否专席专用 | 该 ID 只给这个房间席位用，机主不在同一会话里手工聊天 |
| 能否观察回合开始/结束 | 协议文档或一次经授权的短回合；零成本阶段只能标 `null` |
| 最终正文从哪里来 | 明确到具体事件/字段；不能靠“最后一条 assistant 消息”猜 |
| 去重键是什么 | `(sessionId, turn)`、`(sessionId, promptId)`、`eventId`+`seq` 等稳定引用 |
| 断线后能否恢复 | 有快照/游标/按 ID resume 之一；没有就填 `snapshotRecovery: null` |
| 语音能力 | 没有事件族就填 `false` / `null`，`voiceMode` 填 `none` 或 `external` |

### 2.4 专席专用

为房间席位单独准备一个原生会话，不要让房间和机主共用同一个会话。

DSH 的实测已经证明原因：`turn/start` 可能早于 `prompt` 的 HTTP 响应到达，Bridge 只能把“发送后出现的下一个新 turn”绑定给 attempt。如果机主同时在 GUI 里聊天，他的回合会被误绑成房间回复，房间回复也可能被当成 `ForeignTurn`。Kimi、Qwen、ZCode 同理：没有 pending attempt 的原生回合只能报 `ForeignTurn`，一旦混用就永远无法可靠区分。

## 3. Bridge 方法签名与生命周期

### 3.1 必需方法

`assertBridge()` 要求以下 8 个方法全部存在且可调用（`adapters/contract.mjs:3-12`）：

```text
probe(config)             -> Promise<{capabilities, identity?, clientVersion?, voiceMode, warnings?}>
connect(config)           -> Promise<void>
getIdentity()             -> Promise<Identity>
send(contextPacket)       -> Promise<SendReceipt>
subscribe()               -> AsyncIterable<BridgeEvent>
cancel(attemptId)         -> Promise<CancelReceipt>
setMuted(muted)           -> Promise<{supported, muted?, capability?}>
close()                   -> Promise<void>
```

两个可选方法，不要求实现：

```text
createNativeSession?(config)        -> Promise<{nativeSessionRef}>
adoptNativeSession?(nativeSessionRef) -> Promise<Identity>
```

### 3.2 每个方法的硬约束

| 方法 | 必须 | 禁止 |
| --- | --- | --- |
| `probe` | 只读确认会话存在；返回归一化能力、身份、版本、`voiceMode`、`warnings` | 投递 prompt、创建/归档会话、启动长期事件泵 |
| `connect` | 连接 `config.nativeSessionRef`；等首个基线就位再返回；缓冲 subscribe 前的事件 | 未显式允许时创建、归档、替换会话；prompt |
| `getIdentity` | 返回 `sourceRef`、`revision`、`nativeSessionRef`、少量元数据 | 返回 `AGENTS.md` / `SYSTEM.md` / preset 正文副本 |
| `send` | 先登记 attempt / collector，再投递；返回 `accepted` 回执 | 把 accepted 当最终回复；同一席并发第二个 attempt；复用 attemptId |
| `subscribe` | 返回持续事件流；先缓冲后补发；不重放已终结的历史 attempt | 因订阅者退出而关闭原生会话；丢事件 |
| `cancel` | 幂等；返回 RPC 层回执；最终状态由事件确认 | 伪造 `AttemptAborted`；把 accepted 当已终结 |
| `setMuted` | 不支持时返回 `{supported:false, capability:'voiceMute'}` | 抛未处理异常；修改客户端全局设置 |
| `close` | 幂等；结束订阅迭代器；只释放 Bridge 资源 | 归档、删除或关闭原生会话；伪造终态 |

`connect()` 返回前必须让“发送基线”就位。DSH 会等首个 `session/snapshot`（`adapters/dsh/bridge.mjs:210-265`）；ZCode 会先 resume、seed 快照、subscribe 带 `includeSnapshot`，再等基线（`adapters/zcode/bridge.mjs:621-719`）。没有基线概念的客户端也要在 `connect()` 返回前完成订阅握手和历史锚点读取。

### 3.3 Core 的调用顺序

`core/engine.mjs:268-283` 在 `init()` 时对每个席位依次执行：

```text
bridge.connect()
bridge.getIdentity()        // 失败只记 health.identityError，不阻断
bridge.subscribe()
```

之后 `run()` 的每个回合（`core/engine.mjs:487-545`）是：

```text
_build ContextPacket
bridge.send(packet)         // 只等投递回执
_waitForTerminal(attemptId) // 等 Completed / Aborted / Failed
```

所以：

- `send()` 不能等到模型回复才 resolve；否则整个房间会被一席卡住。
- 每个 `accepted:true` 的 attempt 最终必须有一个终结事件，否则 `_waitForTerminal()` 永久挂起。
- `close()` 是引擎卸载时的例外：引擎会自行把等待中的 attempt 结算为 aborted，不要求 Bridge 在关闭时补发终态。

### 3.4 生命周期

```text
工厂函数(config)
  -> probe()                    只读，可跳过
  -> connect()                  连接既有会话，等基线
  -> subscribe()                订阅一次，持续消费
  -> send() ...                 每席最多一个 active attempt
  -> cancel() ...               幂等；终态由事件确认
  -> close()                    幂等；不删除原生会话
```

构造参数由 `server/live.mjs:142-168` 传入：

```js
factory({
  ...seat.client,       // 客户端专用配置，如 baseUrl / cwd / exe
  seatId,
  nativeSessionRef,
  voiceMode,
});
```

`nativeSessionRef` 对生产客户端必填；只有 `fake` 会在缺省时自动补一个假 ID。

## 4. ContextPacket、SendReceipt、CancelReceipt

### 4.1 ContextPacket

```js
{
  roomId: 'r_main',            // 非空字符串
  roomSeq: 42,                  // 安全整数，>= 1
  turnId: 'turn_a_...',        // 非空字符串
  attemptId: 'a_...',          // 非空字符串
  seatId: 'your-seat',         // 必须等于本 Bridge 的 seatId
  contextEpoch: 'epoch_r_main',// 非空字符串
  text: '【本机群聊 ...】',      // 已渲染的房间增量
  mentions: ['other-seat'],     // 可选
  replyTo: 'm_...',             // 可选
}
```

规则：

- 用 `assertContextPacket(packet)` 校验；再校验 `packet.seatId === config.seatId`，否则抛 `CONTEXT_SEAT_MISMATCH`。
- `text` 已经由 Core 渲染，包含最近 `contextMessages` 条共享字幕和 `[PASS]` 规则。Bridge 不要重写、追加人格、保存副本或做二次摘要。
- 房间的 `text` 里出现 `@seatId` 只影响 Core 排程；Bridge 原样投递。
- 游戏回合的 packet 形状不同：`roomId: 'game:<gameId>'`、`contextEpoch: gameId`、`turnId: gameId`、`roomSeq: moves.length + 1`（`games/dots-and-boxes/coordinator.mjs:687-697`）。所以 **不要假设 `turnId` 全局唯一，也不要拿 `turnId` 当 attempt 键**；唯一键是本次 `attemptId`。
- 不要从 packet 推断人格或模型。模型、cwd、preset 都来自原生会话。

### 4.2 SendReceipt

```js
{ attemptId: 'a_...', accepted: true, nativeRequestRef: '...' }
```

- `accepted` 只表示“客户端接收了投递”，不表示已经生成最终回复。
- `nativeRequestRef` 可选，放客户端的 promptId / inputId / requestId / rpcId，便于诊断，不要放 token。
- `send()` 抛错时，Core 会写 `MEMBER_FAILED` 并继续排程（`core/engine.mjs:526-532`、`649-680`）。因此：
  - 只有确认“没有被接受”时才抛错（例如明确的 4xx、`session_not_found`、连接建立失败）。
  - 如果 HTTP 超时/连接中断导致“可能已接受、也可能没接受”，不要抛错后让 Core 重试。按已接受返回回执，再用快照/游标恢复并最终给出一个终态。
- 投递前必须完成：事件收集器就位、attempt 登记、基线记录。否则原生 `turn/start` 可能早于 HTTP 响应，事件会被丢掉或误绑。

### 4.3 忙与重复

- 同一席位同时最多一个 active attempt；忙时抛 `BridgeError('BRIDGE_BUSY', ..., { retryable: true })`。
- 同一个 `attemptId` 在**已接受后**不能再次投递；新的 `send()` 复用已存在的 attemptId 时抛 `ATTEMPT_ID_REUSED`。这是防止“已接受后重放”的第一道闸。若投递明确未被接受（例如没拿到 202、明确的 `session_not_found`），可在恢复会话后按原 attemptId 重试一次，见 5.5。
- `cancel()` 和 `send()` 都要先查本地 attempt 表，再发 RPC。

### 4.4 CancelReceipt

```js
{
  attemptId: 'a_...',
  accepted: true,
  settlement: 'pending',        // confirmed | pending | failed | unsupported
  nativeTurnRef: '...',        // 可选
  error: { code, message, retryable }, // 可选
}
```

- `cancel()` 必须幂等：重复调用返回同一结果，不重复发取消 RPC，不重复发事件。
- `settlement: 'pending'` 表示取消请求已被接受，但 attempt 尚未终结；最终状态仍由 `AttemptAborted` / `AttemptCompleted` / `AttemptFailed` 确认。
- `settlement: 'confirmed'` 只应在你已从事件/快照确认终结后返回。
- 未知 attempt 返回 `accepted:false, settlement:'failed'` 和 `ATTEMPT_NOT_FOUND`，不要抛异常。
- 已完成的 attempt 再取消，返回 `ATTEMPT_ALREADY_FINISHED`，不要补发第二个终态事件。

## 5. Attempt 事件：回执不是正文，取消不是终态

事件必须用 `core/events.mjs` 的 `createBridgeEvent()` 生成，类型只能取自 `BRIDGE_EVENT_TYPES`。信封：

```js
{
  schemaVersion: 1,
  eventId: 'be_...',
  type: 'AttemptCompleted',
  seatId: 'your-seat',
  attemptId: 'a_...',       // 席位级事件可为 null
  occurredAt: 'ISO-8601',
  payload: {},
}
```

### 5.1 事件与 payload

| 事件 | 必要 payload | 可选 payload | Core 行为 |
| --- | --- | --- | --- |
| `AttemptStarted` | `nativeTurnRef` | — | 写 attempt，发 `MemberThinking` |
| `AttemptCompleted` | `nativeTurnRef`、`nativeMessageRef`、`text` | `usage` | 只发布一次正文；精确 `[PASS]` 转 `MemberPassed`，否则 `MemberResponded` + `MessagePosted` |
| `AttemptAborted` | `nativeTurnRef`、`partialText` | `usage` | 只写 attempts 和状态；部分正文不进字幕 |
| `AttemptFailed` | `error:{code,message,retryable}` | `nativeTurnRef`、`partialText`、`usage` | 写 attempts，发 `MemberFailed` |
| `ForeignTurn` | `nativeTurnRef`、`reason` | — | 只记录，不进字幕 |
| `UsageReported` | `usage` | `nativeTurnRef` | 合并用量，不生成正文 |
| `SpeechStarted` | — | `nativeMessageRef` | 只展示语音状态 |
| `SpeechFinished` | — | `nativeMessageRef` | 只展示语音状态 |
| `SpeechFailed` | `error` | `nativeMessageRef` | 只展示语音失败 |
| `BridgeError` | `error:{code,message,retryable}` | — | 更新健康状态 |
| `BridgeClosed` | `reason` | — | 标记关闭，禁止继续投递 |

### 5.2 一个 attempt 只能有一个终态

`AttemptCompleted`、`AttemptAborted`、`AttemptFailed` 三者互斥，每个 `(seatId, attemptId)` 最多一个。Core 会防御性去重 `eventId` 和 `nativeMessageRef`，但 **Bridge 必须自己先去重**，且只能按原生引用去重，不能按正文：

- DSH：`(sessionId, turn)`（`adapters/dsh/dedupe.mjs`）。
- Kimi：`prompt_id`、`turnRef`、`messageId`、`eventId`（`adapters/kimi-code/bridge.mjs` 中的 `_settledPromptIds` / `_deliveredMessageRefs`）。
- ZCode：`eventId` + `seq`，终结时按 `inputId` / `turnId` 绑定（`adapters/zcode/bridge.mjs:1171-1193`）。
- Qwen：`(sessionId, promptId)`，SSE `id` 用于续传。

两轮正文完全相同但原生引用不同，必须两次都交付；同一终态消息重复到达，只能交付一次。

### 5.3 accepted 不是终态

`SendReceipt.accepted:true` 之后，正文只能来自 `AttemptCompleted`。不要在 `send()` 里读“最后一条 assistant 消息”然后顺手发 Completed；那会把历史消息、机主手工回合或上一轮回复当成这一轮。

### 5.4 取消残留

- `cancel()` 接受后，原生端可能还会吐出已生成的部分正文。把部分正文放进 `AttemptAborted.partialText`，不要发 `AttemptCompleted`，也不要让部分正文进字幕。
- 取消后仍可能先收到 `turn/end` 的 completed；以“该 attempt 已经 aborted”为准，忽略迟到的 completed，保证只有一个终态。
- 如果协议支持移除排队项（DSH 的 `session/updateQueue`），先逐项移除再发 `session/cancel`；不支持就如实把 `queueClear` 填 `false`，不要声称清队列。
- `close()` 不是取消。Qwen 在 `close()` 时把仍在运行的 attempt 标成 `unknown`，不伪造 aborted（`adapters/qwen-code/bridge.mjs:891-896`）。Core 会在引擎关闭时自行结算。
- 取消 RPC 失败时返回 `settlement:'failed'` 和结构化错误，但 attempt 可能仍在运行；不要因此发 `AttemptFailed`，继续等原生终态或后续恢复。

### 5.5 已接受不重放

这是最容易造成双回复的地方。

- 一旦收到 `accepted:true`，崩溃、断线、重连都只能“对账”，不能自动重投。
- 重连后只重建“有开始、无结束”的 attempt；已完成的 attempt 从快照/历史里静默跳过。
- 只有在明确“未被接受”时才可以重投一次，且必须复用同一个 `attemptId`，并在恢复会话之后：
  - Qwen：prompt 未获 202 且明确 `session_not_found`，恢复后按原 `attemptId` 重投一次；已获 202 后崩溃只记失败并恢复通道（`docs/events.md:100`）。
  - Kimi：`prompt_id = attemptId`，同一 attemptId 不二次 POST；服务端按 prompt_id 幂等。
  - ZCode：`inputId = attemptId`；同一 inputId 不重发。
  - DSH：`sessions.prompt` 没有幂等键，所以更不能自动重投；只能等 turn/end 或用快照对账。

### 5.6 断线恢复

合格的重连必须满足：

1. 先恢复通道，再拿基线/快照/游标，再对账在途 attempt。
2. 只处理“start 有、end 无”的 attempt；旧的 completed / aborted / failed 历史一律沉默。
3. 用原生引用去重，已经交付过的 `nativeMessageRef` / `promptId` / `turn` 不再交付。
4. 恢复失败时可重试；仍无法确认时，给该 attempt 一个 `AttemptFailed`（明确 `unknown` / `FINAL_TEXT_UNAVAILABLE` 之类的错误），不要让它永远挂着，也不要猜正文。
5. 重连期间新到的 live 事件不能丢；先缓冲，再按顺序消费（ZCode 的 `_buffered`、Kimi 的 `_preSubscribeFrames`、FakeBridge 的 `_pending`）。

### 5.7 快照首回合

连接后第一轮很容易丢回复，因为 `turn/start` 可能只出现在开场快照里，没有走 live 通道（DSH 实测复现）。

必须做到：

- `connect()` 等首个快照/基线就位再返回；`send()` 也等基线。
- 从快照里按“有 start 无 end”重建该 attempt 的收集器与已有消息，而不是整体跳过快照。
- 快照里已经结束的旧 turn 只记账，不重放、不报 ForeignTurn。
- 快照里的未结束且不属于本 Bridge 的 turn，才可能是机主的回合，报 `ForeignTurn`。
- 连接时收到的快照和订阅时收到的快照可能重复；用指纹/序号去重。

DSH 的 `_handleSnapshot()`（`adapters/dsh/bridge.mjs:602-665`）和 ZCode 的 `_seedSnapshot()`（`adapters/zcode/bridge.mjs:1403-1420`）是这条规则的直接参考。

## 6. ForeignTurn、Usage、Speech

### 6.1 ForeignTurn

用途：告诉房间“原生会话里发生了一个不属于房间的回合”，只记录，不投字幕、不绑定 attempt。

```js
{
  nativeTurnRef: 'native-ref',
  reason: 'foreign-turn' // 或 foreign-turn-open / prompt-not-ours / no-pending-attempt
}
```

规则：

- 没有 pending attempt 的新原生回合 → 发一次 `ForeignTurn`，按原生引用去重。
- 恢复时只把“仍未结束、且未被历史账本认领”的回合报为 foreign；已结束的历史回合保持沉默。
- 有 pending attempt 但引用对不上时，也要谨慎：宁可不交付，也不要把别人的正文绑到房间 attempt 上；无法确认时让该 attempt 失败。
- `attemptId` 为 `null`；事件必须带 `seatId`。
- 这正是“专席专用”的原因；不要试图把机主手工回合也纳入房间。

### 6.2 Usage

`UsageReported` 是可选能力。典型 payload：

```js
{
  usage: {
    inputTokens: 123,
    outputTokens: 45,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 168
  },
  nativeTurnRef: '...',       // 可选
  usageQuality: 'exact',      // 可选，Kimi 使用
  usageKnown: true,           // 可选
  usageSource: 'snapshot'     // 可选
}
```

规则：

- 只认 token 数；缺字段填 `null`，不要用 0 冒充“没有用量”。
- 同一条用量只发一次（按 `nativeTurnRef` + 内容或快照序号去重）。
- `providerUsage` 只有在你确实能读到并发出用量时才填 `true`；否则 `null`（未测）或 `false`（确认没有）。
- 不要把估算值写成精确 usage。预算模块会把 `null` 当 unknown，这是正确行为。
- 注意：现有 DSH 的 `probe()` 声明 `providerUsage: true`，但 `adapters/dsh/bridge.mjs` 本版没有发 `UsageReported`。这说明能力位必须由实际事件路径支撑，不能只照抄能力矩阵。接新客户端时请自己核对“声明”和“事件”是否一致。

### 6.3 Speech

只有客户端确实有可观察的语音事件时才实现：

- `SpeechStarted` / `SpeechFinished` 的 payload 可选 `nativeMessageRef`；`SpeechFailed` 必须带 `error`。
- 语音可以并发、迟到、缺失、乱序；**绝不能阻塞文本回合**。不要等 `SpeechFinished` 才发 `AttemptCompleted`，也不要把语音失败判成文本失败。
- 没有语音事件族就填 `voiceStartedFinishedEvents: false`，并且不产生 Speech 事件；`voiceMode` 用 `none`（没有语音）或 `external`（外部 hook，房间只展示状态，不仲裁）。
- `setMuted()` 不支持时返回 `unsupportedCapability('voiceMute')`，即 `{supported:false, capability:'voiceMute'}`；不要抛异常。
- 当前四个真实适配器都没有发 Speech 事件；`FakeBridge` 的 `injectSpeech*()` 只用于契约测试。不要因为测试里有语音，就在生产 Bridge 里假装有。

## 7. 能力声明：null / false / true

`normalizeCapabilities()` 会把缺失的能力补成 `null`。可声明的键固定为（`adapters/contract.mjs:14-29`）：

```text
nativeSession, nativeIdentity, sendToExistingSession, finalMessageEvent,
messageDeduplication, snapshotRecovery, foreignTurnDetection, queueClear,
requestAbort, providerUsage, voiceTrigger, voiceStartedFinishedEvents,
voiceStop, voiceMute
```

| 值 | 含义 | 使用规则 |
| --- | --- | --- |
| `true` | 已实现并实测通过 | 代码里必须有对应事件/方法路径；契约测试覆盖 |
| `false` | 已确认不支持 | 不要假装支持；UI/调用方会据此降级 |
| `null` | 未测 / 未知 | 不能被当成支持；先保持 `null`，测完再改 |

按能力给出最低证据：

| 能力 | 填 `true` 的最低条件 |
| --- | --- |
| `nativeSession` | 能按 `nativeSessionRef` 连接一个既有会话 |
| `nativeIdentity` | `getIdentity()` 能返回稳定引用和版本，且不含人格正文 |
| `sendToExistingSession` | 能向该会话投递并拿到明确的接受/拒绝结果 |
| `finalMessageEvent` | 有明确的终态事件和正文来源，能区分完成/中止/失败 |
| `messageDeduplication` | 有稳定的原生引用去重键，且能处理重复终态 |
| `snapshotRecovery` | 断线后能只重建未结束 attempt，不重放已完成消息 |
| `foreignTurnDetection` | 无 pending attempt 的原生回合能报 `ForeignTurn` |
| `queueClear` | 能逐项移除已排队但未开始的 prompt；只是“能取消当前回合”不算 |
| `requestAbort` | 能发出取消请求，并由事件确认中止 |
| `providerUsage` | 能读到并发出用量；估算值不能标成精确 |
| `voiceTrigger` | 房间/客户端有可调用的原生 TTS 触发；仅外部 hook 不算 |
| `voiceStartedFinishedEvents` | 能收到开始/结束/失败事件；只有播放器日志不算 |
| `voiceStop` | 能停止正在播放的语音 |
| `voiceMute` | 能按席位静音且可恢复 |

另外：

- `voiceMode` 只能是 `native` / `external` / `none`（`VOICE_MODES`）。它描述展示方式，不代表房间会仲裁语音。
- `warnings` 是字符串数组，用于版本漂移、协议形状变化、会话不在内存等提示；不要放正文、ID 全量或凭据。
- `createNativeSession` / `adoptNativeSession` 是**可选方法**，不是能力位。不要因为实现了它们就改 `nativeSession` 的语义。
- `probe()` 的 `identity` 在会话不存在时可以省略；生产环境建议只要能连就返回，供成员卡显示模型/workspace 元数据。

## 8. 注册 clientType 与配置

### 8.1 代码注册（两处）

1. `server/config.mjs:12-13`

```js
export const CLIENT_TYPES = Object.freeze([
  'dsh', 'kimi-code', 'zcode', 'qwen-code', 'fake', 'your-client',
]);
export const PRODUCTION_CLIENT_TYPES = Object.freeze([
  'dsh', 'kimi-code', 'zcode', 'qwen-code', 'your-client',
]);
```

- 加到 `CLIENT_TYPES` 才能通过配置校验。
- 加到 `PRODUCTION_CLIENT_TYPES` 后，`nativeSessionRef` 变为必填；生产客户端必须加，否则缺 ID 会静默变成 `null`，直到 `connect()` 才报错。
- 纯测试客户端可以只加 `CLIENT_TYPES`，但 Bridge 仍要自己处理缺失 ID。

2. `server/live.mjs`

```js
import { createYourBridge } from '../adapters/your-client/bridge.mjs';

export const DEFAULT_FACTORIES = Object.freeze({
  // ...
  'your-client': createYourBridge,
});
```

注意：`resolveFactories()` 只接受已经存在于 `DEFAULT_FACTORIES` 的键（`server/live.mjs:112-136`）。测试里想注入假工厂，也必须先把这个键加进 `DEFAULT_FACTORIES`，否则会得到 `FACTORY_UNKNOWN`。

### 8.2 配置席位

复制 `config/members.example.json` 为 `config/members.local.json`（本地文件，不入 git），增加：

```json
{
  "seatId": "your-seat",
  "displayName": "Your Client",
  "color": "#6ea8ff",
  "clientType": "your-client",
  "nativeSessionRef": "REPLACE_WITH_EXISTING_SESSION_ID",
  "enabled": true,
  "voiceMode": "none",
  "client": {
    "baseUrl": "http://127.0.0.1:PORT"
  }
}
```

允许的座位字段只有：`seatId`、`displayName`、`color`、`clientType`、`nativeSessionRef`、`enabled`、`voiceMode`、`client`；`_` 开头的键视为注释。`client` 是自由对象，但任意层级出现 `persona` / `prompt` / `systemPrompt` / `agentsMd`（忽略大小写和分隔符）都会被拒绝。不要把 token 写进 `client`；如果客户端必须读 token，从环境变量或客户端自己的配置读取。

### 8.3 可选：启动脚本

只有你的客户端需要独立守护进程时才改 `scripts/start-all.mjs`：

- 按 `clientType` 判断是否需要启动；不影响已有 DSH / Kimi / Qwen 的复用和停止逻辑。
- 不要自动启动、重启或结束用户的桌面 GUI。
- 不要抢占已有端口；提供 `--<client>-port` 或环境变量覆盖。
- 起不来时给出“先在独立终端启动客户端”的提示，而不是偷偷换会话。

### 8.4 可选：游戏专席分支

`server/live.mjs:231-253` 的 `createGameNativeSession()` 目前只为 `zcode` 特判“同进程 create + adopt 后返回已连接 Bridge”。如果你的客户端也要求同一进程内接管新会话，必须在这里加显式分支；不要假设它会通用地调用 `adoptNativeSession()`。不需要同进程接管的客户端走默认路径：创建新 ID，由协调器用工厂新建 Bridge 并 `connect()`。

## 9. 契约测试

### 9.1 测试文件

新增 `tests/contract/<client>.contract.test.mjs`，使用 `node:test` + `node:assert/strict`，并注入一个脚本化的假原生客户端（参考各适配器的 `client` / `apiFactory` / `clientFactory` 注入点）。测试不连真实客户端、不发网络请求、不 sleep。

最低导入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_METHODS, CAPABILITIES, BridgeError, assertBridge, assertContextPacket,
} from '../../adapters/contract.mjs';
import { createBridgeEvent } from '../../core/events.mjs';
```

### 9.2 必测用例

1. `assertBridge()` 通过，8 个方法都存在。
2. `probe()` 只读：只调用列表/状态/元数据，不创建会话、不发 prompt、不启动事件泵。
3. 目标会话不存在时 `probe()` / `connect()` 给出明确错误，绝不自动建会话。
4. `connect()` 不创建/归档/替换；返回前基线就位。
5. subscribe 前产生的事件被缓冲，subscribe 后按顺序补发。
6. `getIdentity()` 只含白名单元数据，没有 `AGENTS.md` / prompt / persona 正文。
7. `send()` 校验 packet、seatId、attemptId 复用和 `BRIDGE_BUSY`。
8. `send()` 在投递前登记 attempt；原生 `turn/start` 早于 HTTP 响应也能正确绑定。
9. `accepted:true` 后只有事件能交付正文；不产生第二次正文。
10. 重复终态（同 `nativeMessageRef` / `eventId` / `seq`）只交付一次；不同原生引用的相同文本交付两次。
11. 无 pending attempt 的原生回合只产生 `ForeignTurn`，不产生 attempt。
12. `cancel()` 幂等；`accepted` 后 `settlement:'pending'`；事件到达后只产生一个 `AttemptAborted`。
13. 取消留下的部分正文只进 `AttemptAborted.partialText`，不进 `AttemptCompleted`。
14. 断线期间完成的 attempt 重连后恰好结算一次；历史 foreign 不重放。
15. 断线期间被取消/失败的 attempt 恢复为 `AttemptAborted` / `AttemptFailed`。
16. `createNativeSession()` 沿用 cwd / preset / 模型，不产生模型调用，不归档旧会话，返回并确认新 ID。
17. 若实现 `adoptNativeSession()`：同进程切换、清空旧 attempt 关联、不重放旧尝试、忙时拒绝。
18. `UsageReported` 只发一次，字段归一化，不生成正文。
19. 无语音能力时不产生 Speech 事件；`setMuted()` 返回 `supported:false` 而不抛错。
20. `close()` 幂等、结束订阅迭代器、不删除原生会话。
21. 错误和日志脱敏：不出现 token / Cookie / 完整凭据。

事件形状要能原样交给 `createBridgeEvent()`：

```js
const event = await nextEvent(iterator);
assert.doesNotThrow(() => createBridgeEvent({
  type: event.type,
  seatId: event.seatId,
  attemptId: event.attemptId,
  payload: event.payload,
}));
```

### 9.3 命令

```bash
node --test tests/contract/fake.contract.test.mjs
node --test tests/contract/your-client.contract.test.mjs
npm test
```

`FakeBridge` 的契约测试是最小参照；先让 `tests/contract/fake.contract.test.mjs` 通过，再写自己的。新增测试后以 `npm test` 的实际全量输出为准，不引用旧基线数字。

## 10. createNativeSession / adoptNativeSession

### 10.1 什么时候调用

只在两种明确动作下调用：

- 机主在成员卡点“新会话” → `server/live.mjs:334-386` 的 `onResetSeat()`。
- 开始含 AI 的棋局 → `server/live.mjs:231-253` 的 `createGameNativeSession()`。

`connect()`、`probe()`、`getIdentity()` 都不得创建会话。`createNativeSession()` 本身也不得触发模型回合，不得归档/删除旧会话，不得改变当前 Bridge 的连接对象；由调用方验证新 ID 并接入。

### 10.2 共同规则

- 沿用原会话的 cwd、workspace、preset / agent、模型与思考等级，不要凭空选一个默认模型。
- 创建前刷新当前会话元数据，避免继承过期缓存。
- 创建后按 ID 再读一次，确认会话存在且模型可用，再返回 `{nativeSessionRef}`。
- 返回值只放新 ID，不放 token、不放完整响应。
- 旧会话保留；房间字幕和 attempts 不清空。
- 新 ID 写回配置由 `onResetSeat()` 负责；Bridge 不要自己改 `config/members.local.json`。

### 10.3 Kimi Code：模型补设

Kimi 的创建路径（`adapters/kimi-code/bridge.mjs:781-820`）值得完整照抄思路：

1. 读当前会话，拿 `cwd` 和模型；模型可以是 `cfg.model` 或 identity 里的 `metadata.model.id`。
2. 没有可继承模型就抛 `SESSION_MODEL_REQUIRED`，提示先在原客户端选择模型；不要创建“没有模型”的会话。
3. `createSession({ cwd, model })`。
4. 新会话再 `updateSessionModel(nativeSessionRef, { model })`（实际是 `POST /api/v1/sessions/:id/profile`，见 `adapters/kimi-code/client.mjs:243-257`）。这是为了避免创建后出现 `Model not set`。
5. 再 `GET` 新会话，读回 `agent_config.model`；仍为空就抛 `SESSION_MODEL_REQUIRED`，拒绝接入。

其他客户端如果也有“创建后模型未落盘”的坑，按同样顺序：继承 → 创建 → 补设 → 读回确认。

### 10.4 ZCode：同进程 create + adopt

ZCode 的新 ID 在另一个 app-server 进程里可能不可见，所以它的做法是（`adapters/zcode/bridge.mjs:745-840`）：

- `session/create` 带原 workspace、`persistence:'immediate'`，并在可用时继承 `model` / `thoughtLevel`。
- 用**同一个 app-server** `adoptNativeSession(newId)`：`session/resume` + `session/subscribe(includeSnapshot)`。
- adopt 时清空旧 attempt、turn 映射、去重集合、快照缓存、游标，重建基线；不重放旧尝试。
- 忙时（有 running attempt）拒绝 adopt，抛 `BRIDGE_BUSY`。
- 返回 `getIdentity()`。

`server/live.mjs` 为游戏专席新建一个 Bridge，先 `createNativeSession()` 再 `adoptNativeSession()`，把已连接的 Bridge 直接交给协调器；聊天席位的“新会话”则由 `engine.replaceSeatBridge()` 检测到 `adoptNativeSession` 后原地接管，不新建 Bridge（`core/engine.mjs:1135-1150`）。

如果你的客户端能跨进程立即看到新会话，不需要 adopt：返回新 ID，让引擎新建 Bridge 并 `connect()`。不要为了“统一”强行实现 adopt。

### 10.5 Qwen Code：ACP 与恢复

Qwen 走 `qwen serve` 的 http-bridge / ACP：

- 先 `/health` 等守护进程就绪；再按 ID `resume`，**绝不** `createOrAttachSession({cwd})` 让服务端挑会话（`adapters/qwen-code/bridge.mjs:292-357`）。
- 恢复返回的 ID 必须与配置一致，否则 `SESSION_MISMATCH`。
- ACP `initialize` 在宿主机忙时可能超时；瞬态失败先 `workspaceAcpPreheat`，再原样 resume 一次（`adapters/qwen-code/bridge.mjs:370-397`）。非瞬态失败保持 `SESSION_NOT_FOUND`，不重试。
- `session_died` / 404：发送与 SSE 共用恢复锁，按原 ID resume，清空 `lastEventId` / epoch 后重新订阅；不新建、不替换会话。
- `permission_request` 无法由房间代答：让当前 attempt `AttemptFailed(QWEN_PERMISSION_REQUIRED)`，提示机主到客户端处理。
- 空会话可能不落盘；正式使用前先完成一次发言再重启，否则按 ID 恢复可能找不到。

### 10.6 DSH 上游复制纪律

DSH 的 `adapters/dsh/dsh-client.mjs` 是从上游 `qq-bridge/src/dsh-client.js`（MIT）逐字复制的，文件头记录了来源仓库、提交、源文件 sha256 与规则（`adapters/dsh/dsh-client.mjs:1-11`）：

- 本文件保持逐字复制，只允许在文件头记录来源；不要在这里改协议细节。
- 真需要改时，在 `docs/dsh-client-diff.md` 记一条“改了什么、为什么”，方便上游修 bug 后干净地重新复制。当前仓库还没有这个 diff 文件；第一次改动时再创建。
- 业务逻辑写在 `adapters/dsh/bridge.mjs`，不要写进上游客户端。
- 这个客户端依赖独立的旧版 `@deepseek-ai/dsh-host-apiproxy` 包，DSH 升级不一定影响它；升级后仍要重新跑探针。

接新客户端时同理：如果必须复制第三方客户端代码，保留来源头、锁定提交/哈希、把修改隔离在独立 diff 记录里；不要把复制来的协议代码和 Bridge 业务逻辑混在一个文件。

## 11. 游戏：复用协调器，服务端验证动作

游戏不经过聊天引擎，但复用同一套 Bridge 工厂和契约：

- 协调器 `createGameCoordinator()` / `createTabletopManager()` 接收 `config`、`factories`、`createNativeSession`、独立 store。
- 每个 AI 玩家使用独立原生会话，`seatId` 形如 `game-<gameId>-<slot>`，`voiceMode:'none'`；不复用聊天专席，不写主聊天字幕或 attempts。
- 只有玩家还没有 `nativeSessionRef` 时才创建；创建后写回游戏存档，旧局未返回的结果由 generation 失效，旧会话保留。
- packet：`roomId: 'game:<gameId>'`、`contextEpoch: gameId`、`turnId: gameId`、`roomSeq: moves.length + 1`、`attemptId: 'game-attempt-...'`，`text` 由游戏 prompt 构造（只描述棋盘/合法动作，不含人格或聊天上下文）。
- 只接受 `accepted:true` 的回执，然后等该 attempt 的终态事件；不要读历史消息当本手。

**动作必须服务端验证**：

- 点格棋：`parseAiResponse()` 只接受恰好一个 JSON 对象里的合法 `edge`；`EDGE_SET` 之外的边、数组、多个对象、缺字段都返回 `null`（`games/dots-and-boxes/prompt.mjs:156-161`）。然后 `rules.applyMove()` 再验证轮次、边是否已占、是否合法。
- 桌面对弈：`parseTabletopResponse()` 只提取 `action` 与 `comment`；动作最终仍由对应引擎的 `normalizeAction()` / `applyTurn()` 验证合法性（`games/tabletop/prompt.mjs:207-233`）。
- 非法回复不落子、不猜测坐标；按协调器策略暂停或带 `retryReason` 重试。
- 公开 HTTP/SSE 不返回游戏原生会话 ID，也不把游戏 attempt 写进聊天记录。
- 新局/悔棋/切换棋种会使旧 generation 失效；迟到的 AI 结果必须丢弃，并关闭不再需要的 Bridge。

新增客户端只要满足 Bridge v1，游戏就能复用；但如果它需要同进程 adopt，记得在 `server/live.mjs` 的 `createGameNativeSession()` 加显式分支（见 8.4）。

## 12. 现有实现适合参考哪方面

| 实现 | 适合参考 | 不要照搬 |
| --- | --- | --- |
| `adapters/fake/bridge.mjs` | 契约骨架、事件缓冲、订阅唤醒、取消回执、按原生引用去重、确定性测试驱动 | 它不是真实协议；`completeAttempt()` 等测试控制方法不是生产接口 |
| `adapters/dsh/bridge.mjs` + `dedupe.mjs` | 发送基线、首快照重建、`(sessionId, turn)` 账本、`ForeignTurn` 判定、队列清理后取消、上游复制纪律 | DSH 的 RPC 形状与 Cookie 鉴权；其 `providerUsage` 声明与事件不一致，不要照抄 |
| `adapters/kimi-code/bridge.mjs` | WS 帧解析、`prompt_id = attemptId`、快照 + profile fallback、断线对账、创建后模型补设与读回确认 | 不要假设 `turn.started/ended` 一定存在（本机实测没有，需要 transcript.ops 等路径） |
| `adapters/zcode/bridge.mjs` | app-server NDJSON、`eventId`+`seq` 去重、`includeSnapshot` 基线、`session/create` + 同进程 `adoptNativeSession`、版本漂移警告 | 不要把未公开的 app-server 协议当成稳定 API；升级后必须重探 |
| `adapters/qwen-code/bridge.mjs` | HTTP+SSE、202 `promptId`、`Last-Event-ID` + epoch 续传、按 ID resume、ACP 预热、权限请求失败语义、`close` 不伪造终态 | 不要 `createOrAttachSession({cwd})` 让服务端挑会话；不要把未测的 `providerUsage` 写成 true |
| `games/dots-and-boxes/*` | 独立游戏会话、prompt 构造、JSON 解析、服务端规则验证、generation 失效 | 不要复用聊天 attempt 或字幕 |
| `games/tabletop/*` | 多种棋共用的合法动作列表、解析后交给引擎验证 | 不要信任模型返回的坐标/动作 |

## 13. 最小实施顺序

1. 读 `contract.mjs`、`events.mjs`、`events.md`、`fake/bridge.mjs`，把 8 个方法和事件表抄成自己的检查表。
2. 跑第 2 节的零成本探针，确认实例可达、目标会话存在、专席专用；写一页能力矩阵，未测项全部 `null`。
3. 写一个只实现 `probe` / `connect` / `getIdentity` / `subscribe` / `close` 的最小 Bridge；先只读事件，不发 prompt。
4. 接入 `send`：先登记 attempt 和收集器，再投递；只返回 `accepted` 回执；把原生终态映射成 Attempt 事件。
5. 加原生引用去重和“一个 attempt 一个终态”；用假客户端写契约测试。
6. 加 `cancel`：幂等、回执 `pending`、终态由事件确认；部分正文只进 Aborted。
7. 加基线/快照恢复：只重建“start 有、end 无”的 attempt；历史静默；无 pending 回合报 ForeignTurn。
8. 加 `UsageReported`（能测才加）和语音能力（有事件才加）；`setMuted` 不支持时返回 unsupported。
9. 实现 `createNativeSession`，按需实现 `adoptNativeSession`；先跑通“机主点新会话”的路径，再接游戏。
10. 注册 `CLIENT_TYPES` / `PRODUCTION_CLIENT_TYPES` / `DEFAULT_FACTORIES`，用本地配置启动真实房间。
11. 在机主明确授权、独立临时房间、`maxAttempts:1` 的条件下做一次短回复实测，确认只产生一次正文、一次用量、一个终态。
12. 跑全量测试和游戏冒烟；把实测证据补进你自己的文档，不要写真实 ID / token。

## 14. 交付前测试清单

### 静态与单元

- [ ] `assertBridge(bridge)` 通过。
- [ ] `probe()` 不创建、不投递、不启动长期泵；缺会话时报明确错误。
- [ ] capability 键恰好属于 `CAPABILITIES`；缺失项是 `null`，不是 `undefined` 或 `false` 的混用。
- [ ] `getIdentity()` 不含人格/提示词正文。
- [ ] packet 校验：缺字段、`roomSeq` 非法、seatId 不匹配都抛结构化 `BridgeError`。
- [ ] `attemptId` 复用、第二路并发 send 被拒绝。

### 契约与事件

- [ ] `node --test tests/contract/fake.contract.test.mjs` 通过。
- [ ] `node --test tests/contract/your-client.contract.test.mjs` 通过。
- [ ] 每个 accepted attempt 都能在测试里等到唯一终态。
- [ ] 重复终态、不同引用的相同文本、历史快照三类去重用例都覆盖。
- [ ] cancel 幂等、pending → confirmed、已完成后取消不产生第二终态。
- [ ] 断线恢复：完成/中止/失败三种在途结果都恰好结算一次。
- [ ] 语音缺失/迟到/乱序不阻塞文本；无语音时不产生 Speech 事件。
- [ ] `close()` 幂等，迭代器结束，原生会话未被删除。

### 集成与真实客户端

- [ ] `npm test` 全绿；新增测试不依赖真实网络和真实会话。
- [ ] `node server/live.mjs --config config/members.local.json` 能起房间，成员卡显示模型/身份元数据。
- [ ] 机主点“新会话”后新 ID 写入配置，旧会话与字幕保留；重启后仍能连接。
- [ ] 若支持 adopt：新会话在同进程接管，旧 attempt 不重放；游戏专席也能接管。
- [ ] 游戏：非法动作被服务端拒绝；合法动作落子；新局后旧 AI 结果不生效。
- [ ] 一次经授权的短回复实测：只调用一次模型、只产生一个 `MessagePosted`、用量与终态各一次。
- [ ] `git status` 中没有真实会话 ID、token、日志或临时文件。

## 15. 红线速查

- 不复制人格、提示词、`AGENTS.md`、preset 正文进配置或 Bridge。
- 不在 `connect()` / `probe()` 里创建会话；不在 `send()` 里等模型回复。
- 不把 `accepted` 当最终回复；不把 `cancel` 的 accepted 当终态。
- 不按正文去重；不重放已接受的 prompt；不重放已完成的历史消息。
- 不在 `close()` 里删除/归档原生会话，也不伪造终态。
- 不用 `null` 冒充支持；不把未测能力写成 `true`。
- 不让语音、游戏或某个客户端的特殊分支进入 `core/`。
- 不在仓库里写真实 ID、token、Cookie 或个人绝对路径。
