# Kimi Code 真实短回复探测报告

> 日期：2026-11-09
> 实例：独立 `kimi web --port 58690 --no-open`（server_version 2.5.2），用后已关闭
> 结论：**未完成真实回合**。探针在投递 prompt 之前因基线读取失败退出，未产生模型调用、token 费用或语音事件。按授权约束未重试、未改 Bridge。

## 1. 环境与会话

| 项目 | 值 |
| --- | --- |
| 启动命令 | `C:\Users\YL2018\.kimi-code\bin\kimi.exe web --port 58690 --no-open` |
| 启动输出 | stdout/stderr 丢弃，横幅与任何 token 未落盘 |
| 健康检查 | `GET /api/v1/meta` → 200（Bearer 鉴权通过，token 仅在进程内从 token 文件读取） |
| server_version | 2.5.2（`backend: v2`） |
| 建会话 | `POST /api/v1/sessions`，body `{"metadata":{"cwd":"C:/KIMIW"}}`，未传 `agent_config`/人格字段 |
| session id | `<KIMI_SEAT_SESSION_ID>` |
| cwd | `C:\KIMIW`（workspace_id `wd_kimiw_8ce16f07f6ea`） |
| model 元数据 | 会话 `agent_config.model` 为空字符串；本机 config `default_model = "Kimi For Coding/kimi-k3.1-pro"`。因没有实际回合，**实际调用模型未确认** |
| 其他 | `busy=false`，`message_count=0`，`archived=false` |

## 2. 探测调用（仅一次）

```
node probes/live-short-reply.mjs --client kimi-code \
  --session <KIMI_SEAT_SESSION_ID> --allow-cost --json
```

- 退出码：1，耗时 119ms
- attemptId：`live-kimi-code-mw87tgkb-8c814bd8`
- 结果：`ok:false`，`outcome.status=failed`，`error.code=BASELINE_FAILED`
- `sendReceipt: null`，`cancelReceipt: null`，`events: []`，`usage: null`
- 未使用 `--abort`，没有第二次调用

### 失败原因（已实测）

Bridge `connect()` 的第一步要求读取会话快照作为基线：

```
GET /api/v1/sessions/<id>/snapshot
```

本机该实例返回 **HTTP 404**：`Route GET:/api/v1/sessions/<id>/snapshot not found`。
本机 `/openapi.json` 的 path 列表里有 `/api/v1/sessions/{session_id}`、`/prompts`、`/messages`、`/transcript` 等，但**没有 `/snapshot`**；服务端 `backend` 为 `v2`，同时提供 `/api/v2/sessions` 路由。

因此这是「客户端 Bridge 依赖的快照端点在本机 2.5.2 实例上不存在」，不是会话或鉴权问题。按任务约束未修改 Bridge 适配 v2，也未换端点重跑。

### 无副作用证据（读取确认）

- `GET /api/v1/sessions/<id>/prompts` → `{"active":null,"queued":[]}`
- 会话 `message_count=0`，`busy=false`
- `usage` 全为 0：`input_tokens=0`、`output_tokens=0`、`turn_count=0`、`total_cost_usd=0`

## 3. 事件核查

| 核查项 | 结果 |
| --- | --- |
| `AttemptStarted` | 未出现 |
| `AttemptCompleted` / `Aborted` / `Failed` | 未出现 |
| `prompt_id` | 未生成（`send()` 未执行，无投递回执） |
| 正文 | 无 |
| usage | 无 |
| 事件流 | `events: []`，`close.ok: true`（Bridge 正常关闭，未关闭 web） |

## 4. 语音证据与 Stop hook 判断

基线（探测前，+08:00）：

- `C:\KIMIW\voice\voice.log` 大小 **237557** 字节，最后一行时间戳 `2026-11-08T19:18:22.028Z`（即 03:18:22）
- `queue/` 文件数 0；`seen/` 文件数 279；`recent.json` sha256 `93e9dcd6…33ff8c`

探测后（03:18:57 复查）：

- `voice.log` 大小 **238700** 字节，增长全部来自 `<OTHER_KIMI_SESSION_ID>` 的 `PreToolUse` 行（当前正在运行的另一个 Kimi Code 会话）
- 含 `<KIMI_SEAT_SESSION_ID>` 的行数：**0**
- `queue/` 仍为空；`seen/` 无 03:18 之后的新 marker；`recent.json` sha256 不变

判断：

- Stop hook 触发情况：**未确认（无触发，因未产生回合）**。本次没有可见 assistant 正文，不能区分 native / external / 不触发；不得据此推断 web/Server API 驱动会或不会触发语音 hook。
- `PreToolUse` 的持续写入说明 hook 安装本身是工作的，但那条链属于另一个会话，与本次专席无关。

## 5. 收尾

- 已关闭本次启动的 `kimi.exe`（PID 108576，命令行含 `web --port 58690`），58690 无监听；未触碰其他 Kimi Code 进程。
- Bridge 由探针自身 `close()` 释放；未启动 ai-room live server，无残留 Bridge。
- 新会话**未归档、未删除**，保持原样（`message_count=0`），供后续复用或人工检查。
- 未修改 Bridge/探针代码；未做第二次真实调用、未做取消测试。

## 6. 建议的后续（需另行授权）

1. 让 Kimi Code Bridge 对 2.5.2（backend v2）提供 fallback：`/snapshot` 404 时用 `GET /api/v1/sessions/{id}` + `/transcript` 建立基线，或适配 `/api/v2/sessions` 的快照端点。
2. 修好基线后再做一次单回合真实探测，届时才能确认 `prompt_id` 关联、最终正文、usage 与 Stop hook 行为。
3. 语音验证时用专席 session id 过滤 `voice.log`，避免被并行会话的 `PreToolUse` 噪音干扰。

---

## 7. 追加：模型修复后的真实成功回合（2026-11-09 晚）

> 本节为后续实测追加，不修改上面第 1～6 节的历史记录。
> 实例：`http://127.0.0.1:58690`（server_version 2.5.2）仍在运行；本次完成后未关闭。
> 本次只发一次 prompt，未重试、未取消、未改全局 config。

### 7.1 前置错误与模型修复

上一轮失败的根因已确认是**专席会话的 `agent_config.model` 为空**：

- 失败回合 `t0`：`state=failed`、`error="Model not set"`，step `endMessage="[model.not_configured] Model not set"`，耗时 118ms，无 assistant 正文。
- 只读确认默认模型：
  - `GET /api/v1/config` → `default_model = "Kimi For Coding/kimi-k3.1-pro"`
  - `GET /api/v1/models` 中存在同一 model，条目有效。
- 修复范围：
  - `POST /api/v1/sessions/{id}/profile`
  - body 仅包含 `agent_config`，其内容为读取到的原对象 + `model` 改为默认模型。
  - 没有改动 `title`、`metadata`、`permission_rules`、人格或全局 config。
  - 修复后读回：`agent_config.model = "Kimi For Coding/kimi-k3.1-pro"`，其他 agent_config 字段与修复前逐一相等。

### 7.2 真实短回复

命令（仅执行一次）：

```
node probes/live-short-reply.mjs --client kimi-code \
  --session <KIMI_SEAT_SESSION_ID> --allow-cost --json
```

结果：**成功**。

| 项目 | 值 |
| --- | --- |
| `ok` | `true` |
| attemptId | `live-kimi-code-mw88v77k-aa18e701` |
| `sendReceipt.accepted` | `true` |
| 事件 | `UsageReported` @153ms、`AttemptStarted` @154ms、`AttemptCompleted` @7877ms |
| 最终正文 | `OK` |
| nativeTurnRef | `<KIMI_SEAT_SESSION_ID>#turn:t1` |
| nativeMessageRef | `t1.1.f2` |
| usage（探针） | `inputTokens=11184`、`outputTokens=49`，cache 字段为 `null` |
| 错误 | 无 |
| elapsedMs | `7883` |
| cancelReceipt | `null`（未取消、未重试） |

### 7.3 真实 transcript / 关联

只读读取 `GET /api/v1/sessions/{id}/transcript?agent_id=main`：

```json
{
  "promptId": "live-kimi-code-mw88v77k-aa18e701",
  "status": "completed",
  "userMessageId": "live-kimi-code-mw88v77k-aa18e701",
  "createdAt": "2026-11-08T19:47:47.006Z",
  "finishedAt": "2026-11-08T19:47:54.738Z"
}
```

```json
{
  "kind": "turn",
  "turnId": "t1",
  "triggerPromptId": "live-kimi-code-mw88v77k-aa18e701",
  "state": "completed",
  "startedAt": "2026-11-08T19:47:47.027Z",
  "endedAt": "2026-11-08T19:47:54.736Z",
  "durationMs": 7713,
  "steps": [{
    "stepId": "t1.1",
    "state": "completed",
    "usage": {
      "inputOther": 11184,
      "output": 49,
      "inputCacheRead": 6656,
      "inputCacheCreation": 0
    },
    "frames": [
      { "kind": "thinking", "frameId": "t1.1.f1" },
      { "kind": "text", "frameId": "t1.1.f2", "role": "assistant", "text": "OK" }
    ]
  }]
}
```

- 本次服务端接受并回显了客户端 `prompt_id`：`promptId == triggerPromptId == attemptId`。
- 最终正文来自 transcript 的 assistant text frame `t1.1.f2`。
- `GET /messages` 中的 assistant 消息 id 为 `msg_<KIMI_SEAT_SESSION_ID>-..._000003`，该条没有 `prompt_id`/`turn_id` 字段；仅靠 messages 无法可靠关联 attempt，必须使用 transcript turn/frame。
- 会话 `last_turn_reason=completed`；但 profile 的累计 `usage` 仍为全 0（`turn_count=0`），说明该实例没有把本轮 usage 写回 session profile。本轮真实 usage 只能从 transcript step 读取，不能把 profile 的 0 当作精确用量。

### 7.4 语音（native，已确认）

- `C:\KIMIW\voice\recent.json` 在 `19:47:54.718` 更新，hash 为
  `565339bc4d33d72817b583024112eb7f5cdf3e5eef0252d6ec1b9c9a94e12bb3`，
  等于 `sha256("OK")`。
- `voice.log`：
  - `19:47:54.720Z queued chars=2`
  - `19:47:57.804Z said ms=2678 {"played": true, "chars": 2}`
- `seen/` 在 `19:47:54.714` 新增 marker；`queue/` 在播放后为空。
- 时间与 `t1` 结束（`19:47:54.736Z`）对齐，文本长度与最终正文 `OK` 一致。

结论：**Stop hook 原生触发并朗读了 `OK`**，属于 native，不是 external。日志中 `queued`/`said` 行不带 session id，但 hash、时间、2 字符文本三项证据足以确认。此前另一个会话的 `PreToolUse`/`Stop` 噪音不属于本次专席。

### 7.5 本轮未做的事

- 没有第二次 prompt，没有重试，没有 `--abort`。
- 没有修改全局 `config`、人格、权限、tools、system_prompt。
- 没有关闭 58690 实例；留给 Kimi 统一收尾。
- 没有读取或输出 token；本文所有错误与输出均经过脱敏。
