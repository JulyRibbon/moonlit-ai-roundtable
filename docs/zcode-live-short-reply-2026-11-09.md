# ZCode 真实短回复探测报告（单次授权）

> 日期：2026-11-09 03:16–03:40（Asia/Shanghai）
> 授权：机主授权一次 ZCode 真实短回复 + 外部语音观察；禁止额外重试、禁止 abort 测试
> 目标：`<ZCODE_SEAT_SESSION_ID>`（workspace=`roundtable-voice-test`）
>
> 结果分两次记录，均保留：
> - 第一次（03:16）：id 被截短，发送前失败 `SESSION_NOT_FOUND`，零费用、无语音 —— 见第 1–7 节。
> - 第二次（03:36，机主重新授权并用完整 id）：**成功**，`response=OK`，外部 Stop hook 实际发声 —— 见第 8 节。

## 1. 实际执行的命令

```text
node probes/live-short-reply.mjs --client zcode \
  --session <ZCODE_SEAT_SESSION_ID> \
  --allow-cost --json
```

未加 `--abort`，未改 workspace / model / thoughtLevel / mode / tool 权限，未创建、归档或 fork 会话。
唯一一次调用；失败后**未重跑**。

## 2. 探测结果

| 项目 | 实测 |
| --- | --- |
| `ok` | `false` |
| 耗时 | 2639 ms |
| 事件流 | 空（`events: []`） |
| `sendReceipt` | `null` — 从未发出 `session/send` |
| `usage` | `null` — 未产生 token |
| 错误 | `SESSION_NOT_FOUND`（`retryable: false`） |
| `close` | `ok: true` |
| 模型调用 / 费用 | 无 |

时间线（本地时间）：

1. `03:16:26` 记录语音日志基线，启动探针。
2. 探针拉起 app-server，`session/list` 成功返回 5 条会话。
3. `_fetchSession` 做 `sessionId` 精确匹配，未命中 → 抛 `SESSION_NOT_FOUND`。
4. `03:16:29` 探针退出（exit=1）；`close` 成功，未残留本次 app-server 子进程。

失败点在 connect 的第一步（会话确认），没有进入 `session/resume`、`session/subscribe`、`session/send`。

## 3. 根因：传入的会话 id 被截短了 5 个字符

`session/list` 返回的会话 id 是完整的 41 字符 UUID 形态。实测存在并匹配 workspace 的会话是：

```text
<ZCODE_SEAT_SESSION_ID>
```

而本次命令收到的是：

```text
<ZCODE_SEAT_SESSION_ID>
```

最后一段 `03096e6` 只有 7 个字符，正常应为 12 个字符（`03096e630719`）。前 36 个字符完全一致，
且 `session/list` 中该会话的 workspace 正是 `roundtable-voice-test`、`status=idle`、`mode=build`，
可以确认就是目标会话，只是 id 传参不完整。

Bridge 的精确匹配行为是**正确**的：它没有按前缀或模糊匹配去猜会话，避免了发错会话。
因此这不是生产协议差异，而是输入数据问题。

## 4. 生产协议字段核查（仅限已走到的路径）

| 字段 / 行为 | 状态 | 证据 |
| --- | --- | --- |
| `session/list` 返回 `result.sessions[]` | 已验证 | 5 条会话，字段含 sessionId/workspace/mode/status/updatedAt |
| `session/list` 返回完整（非截断）sessionId | 已验证 | 41 字符完整 UUID（`probe-meta` 自身默认截断显示，易造成误抄） |
| 会话精确匹配失败 → `SESSION_NOT_FOUND` | 已验证 | 本次结果，`retryable: false` |
| `session/resume` 生产形状 | 未验证 | 未走到 |
| `session/subscribe`（`desktop-continuous` + snapshot） | 未验证 | 未走到 |
| `session/send` 的 `accepted` 回执 | 未验证 | 未发送 |
| `turn.started` 的 `inputId` 关联 | 未验证 | 未发送 |
| `turn.completed` 的 `resultType` / `response` | 未验证 | 未发送 |
| `turn.completed` 的 `usage` | 未验证 | 未发送 |
| `close` 只结束本次 app-server | 已部分验证 | `close.ok=true`，本次未新增残留 app-server 进程 |

未发现与离线假设冲突的生产字段；但真正关键的发送/终态字段这次一条都没走到，不能据此宣称 Bridge 端到端可用。

## 5. 语音证据（外部 Stop hook）

基线（探测前）：

```text
C:\Users\YL2018\.zcode\voice\fox-voice.log
size   13382 bytes
lines  59
mtime  2026-11-08 23:37:32
sha256 81d28e4cc753826f09f96d9e89502d22452b6d9c5f7de116e5e4bd427ad362ba
最后两条事件：queued 23:37:17 / said 23:37:32（属于更早的回合）
```

探测后（03:18 检查）：size、行数、mtime、sha256 **完全一致**，`fox-voice.log` 中 `<ZCODE_SEAT_SESSION_ID>` 出现 0 次；
`queue/` 目录为空且 mtime 未变。

结论：本次没有任何 `said` / `queued` 新事件，外部 Stop hook **没有被触发**。
这与"没有产生回合"一致；真实回合下的行为随后由第 8 节实测补全（会触发并实际发声）。

## 6. 环境差异（重要，需机主知会）

机主确认"桌面端未打开"，但实测 ZCode 桌面进程树自 `2026-11-08 08:04:16` 起一直在运行：

```text
89904   ZCode.exe（主进程，无参数，启动 2026-11-08 08:04:16）
112360  ZCode.exe --type=utility (node)  ← 上述主进程的 node utility
111128  zcode.cjs app-server --stdio --surface desktop（08:04:26，父进程 112360）
115644  … app-server（2026-11-08 17:12:42，父进程 112360）
49868   … app-server（2026-11-08 23:30:51，父进程 112360）
```

- 这 3 个 app-server 都是桌面端自己拉起的，**创建时间早于本次探测**，不是本次探针残留。
- 桌面端实际在运行（有 renderer 与 audio service），可能窗口最小化/隐藏，与"未打开"的说法不符。
- 本次未结束、未清理这些既有进程，也未触碰既有会话。

这一差异会影响下一次真实探测：桌面端可能同时订阅同一会话，`deliveryKind: desktop-continuous`
下的并发消费与 Stop hook 行为都需在有窗口存在的前提下重新评估。

## 7. 未做的与遗留

1. 第一次失败探测后**没有第二次真实调用**（遵守"禁止额外重试"）；后续由机主重新授权并用完整 id
   完成了一次成功回合，见第 8 节。
2. 当时规划的复跑命令（后来由机主以完整 id 执行成功）：

```text
node probes/live-short-reply.mjs --client zcode \
  --session <ZCODE_SEAT_SESSION_ID> \
  --allow-cost --json
```

3. 复跑前建议先确认桌面端窗口状态（是否真的退出），避免两个 app-server 并发订阅同一会话。
4. 未改 Bridge，未改探针，未改任何配置文件。
5. ~~附带发现（未修复）：`probes/zcode/probe-meta.mjs` 的 `--prefix 0` 因 `Number(x) || 12` 逻辑
   会回落到 12，无法用 0 关闭截断；用大值（如 `--prefix 200`）可显示完整 id。该工具默认截断
   正是本次 id 被抄短的可能来源。~~
   **已修（2026-11-09 复核）**：`probes/zcode/probe-meta.mjs` 现在 `--prefix 0` 就表示完整 id；
   这次的 id 抄短事故保留作历史记录。

## 8. 第二次探测（成功，机主重新授权，完整 id）

### 8.1 结果

| 项目 | 实测 |
| --- | --- |
| 会话 | `<ZCODE_SEAT_SESSION_ID>`（workspace=`roundtable-voice-test`） |
| 事件 | `AttemptStarted` → `AttemptCompleted` |
| `response` | `OK` |
| `usage` | `inputTokens=23286`，`outputTokens=31` |
| `nativeTurnRef` | `<ZCODE_SEAT_SESSION_ID>#turn:<ZCODE_TURN_ID>` |
| 工具调用 | 0（`toolCallCount: 0`） |

本轮由机主侧执行；本节之后的核验**全部只读**，未再调用模型。

### 8.2 协议字段：由假设变为实测

| 字段 / 行为 | 状态 |
| --- | --- |
| `session/send` → `accepted` | 已确认（回合真实启动） |
| `turn.started` 的 `inputId` 关联 | 已确认（AttemptStarted 与 attempt 对齐） |
| `turn.completed` 的 `resultType=success` + `response` | 已确认（`response=OK`） |
| `turn.completed` 的 `usage` | 已确认（in 23286 / out 31） |
| `close` 只结束本次 app-server | 已确认（首次探测闭环；本次未产生残留进程） |

生产协议与离线假设一致，未发现需要改 Bridge 的差异。

### 8.3 外部 Stop hook 实际发声（关键证据）

语音日志 `C:\Users\YL2018\.zcode\voice\fox-voice.log` 在基线之后**恰好新增 2 行**：

```text
{"at": "2026-11-09 03:36:11", "event": "queued", "chars": 2, "text": "OK"}
{"at": "2026-11-09 03:36:15", "event": "said", "engine": "edge",
 "voice": "zh-CN-XiaoyiNeural", "chars": 2, "played": true, "ms": 3830, "text": "OK"}
```

文件变化（首次探测前 → 成功回合后）：

| 项目 | 基线 | 成功回合后 |
| --- | --- | --- |
| size | 13382 bytes | 13609 bytes（+227） |
| lines | 59 | 61 |
| mtime | 2026-11-08 23:37:32 | 2026-11-09 03:36:15 |
| sha256 | `81d28e4c…362ba` | `5b671571…d2476` |
| `queue/` | 空 | 空（文件已被消费，目录 mtime 03:36:15） |

`dump-last.json`（03:36:11 由 hook 覆盖写入）确认了该事件的归属，内容仅为元数据，不含其他会话正文：

```text
hookEventName / hook_event_name : Stop
sessionId / session_id          : <ZCODE_SEAT_SESSION_ID>
turnId                          : <ZCODE_TURN_ID>
responsePreview / responseText  : OK
last_assistant_message          : OK
cwd                             : C:\Users\YL2018\roundtable-voice-test
mode / permission_mode          : yolo
stopHookActive                  : false
toolCallCount                   : 0
timestamp                       : 2026-11-08T19:36:10.773Z（= 本地 03:36:10.773）
```

结论：

- 外部 Stop hook **在 turn.completed 后立即触发**（10.77s 完成 → 11s 入队，约 0.3s 内）。
- 实际**发声**：`played: true`，引擎 edge，音色 `zh-CN-XiaoyiNeural`，`ms=3830`（合成+播放总耗时，2 字）。
- 归属明确：`sessionId` 与 `turnId` 都与本次回合精确一致，不是其他会话的日志。
- 时序：turn 完成 → 约 0.3s hook queued → 约 4s 后朗读完毕。

### 8.4 对房间设计的观察

- 语音由 hook 在模型回合之外独立完成；房间用 `response` 做字幕时，需容忍语音约 4s 的尾部延迟。
- `mode=yolo`、`stopHookActive=false`，说明该 hook 在正常权限模式下会无条件朗读回复；
  房间若要抑制朗读，只能改 hook 配置或环境，Bridge 侧无接口。

## 9. 最终状态

1. 核心目标（真实短回复、协议字段、外部语音观察）**全部完成**，且未发生协议层意外。
2. 唯一遗留是环境差异：ZCode 桌面进程树自 2026-11-08 08:04 起常驻（见第 6 节），
   本次未影响结果，但并发订阅时的语义仍建议后续核对。
3. 未改 Bridge、未改探针、未改配置；本轮核验只读。
