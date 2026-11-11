# Qwen Code M0 探测报告（2026-11-10，零成本）

> 结论：**协议可用**。本机 Qwen Code Desktop 自带 `serve`（http-bridge，官方标 Stage 1 experimental），
> 回环 + 不开 `--require-auth` 时免 token；房间用独立实例即可，不接管本机桌面 App 的 14306 实例；其他机器的桌面端口无需一致。
> 本轮只做只读/建会话/挂接探测，**没有发 prompt、没有产生任何模型调用**。

## 1. 运行时与进程事实

| 项 | 值 |
| --- | --- |
| 桌面进程 | `qwen-code-desktop.exe` + `runtime\qwen-code\node\node.exe lib\cli-entry.js serve --port 0 --require-auth --workspace C:\Users\YL2018\Documents\Qwen`，监听 `127.0.0.1:14306` |
| 版本 | `qwenCodeVersion: 0.27.1`（`GET /capabilities` 返回） |
| 协议 | `v1`，`mode: http-bridge`，transports `["rest"]` |
| features | `health / daemon_status / daemon_update / capabilities / session_create / session_startup_config / session_id_override / session_scope_override` |
| 鉴权 | 回环且未开 `--require-auth` → 免 token；桌面实例开了 require-auth，所以房间**不复用它**，另起独立实例（默认端口 58691） |
| 人格 | `~/.qwen/QWEN.md`（用户级全局上下文，“千问古风大小姐”）；房间只存引用与 hash，不复制正文 |
| 模型/强度 | `~/.qwen/settings.json` 的 `model = qwen3.8-flash / reasoningEffort=low`；新会话实测继承 |
| 语音 | 外部 Stop hook → `~/.qwen/hooks/speak.ps1`（日志 `%TEMP%\qwen_tts_debug.log`），房间视为 `voiceMode: external` |

## 2. 实测接口（全部只读或建/挂会话）

```
GET  /health                                   → {status:'ok'}
GET  /capabilities                             → {v:1, qwenCodeVersion, features[], limits…}
GET  /workspace/models                         → {models:[{modelId, name, baseUrl…}]}
GET  /standalone/sessions                      → {sessions:[]}
POST /session {cwd}                            → 200 {sessionId, workspaceCwd, attached:false, clientId, createdAt}
POST /session {cwd, sessionId}                  → 200 同 id，attached:false（= 按 id 恢复/新建）
POST /session {cwd}（会话已 live）               → 200 同 id，attached:true（= 挂成另一个 client）
GET  /session/:id/status                       → {hasActivePrompt, activeWorkState, pendingInteractionCount…}；未知 id → 404 session_not_found
GET  /session/:id/context                      → state.models.currentModelId + state.configOptions[]（含 reasoning_effort / mode）
GET  /session/:id/transcript | turn-index      → 无历史时 404 session_not_found
GET  /session/:id/pending-prompts              → {pendingPrompts:[]}（需要该会话注册过的 clientId）
GET  /session/:id/events                       → SSE；content-type: text/event-stream；首帧 `retry: 3000`
POST /session/:id/prompt {prompt:[{type:'text',text}], idempotencyKey?} → 202 {promptId,lastEventId,eventEpoch}
POST /session/:id/cancel                       → 204
```

SSE 帧形如 `data: {"v":1,"id":<n>,"type":"session_update"|"turn_complete"|"turn_error"|…,"data":{…}}`；
断线可用 `Last-Event-ID` + `X-Qwen-Event-Epoch` 续传（响应头还有 `X-Qwen-SSE-Stream-Id`）。
正文在 `session_update` 的 `data.update.sessionUpdate === "agent_message_chunk"` 的 `content.text`；
终态是 `turn_complete`（`data.promptId`、`data.stopReason`）或 `turn_error`。

## 3. 模型/强度读回（关键验收）

`GET /session/:id/context` 实测：

```json
"models": { "currentModelId": "qwen3.8-flash(openai)" },
"configOptions": [
  { "id": "reasoning_effort", "currentValue": "low", "options": ["none","low","medium","xhigh"] },
  { "id": "mode", "currentValue": "auto" }
]
```

即：新建专席会话**自动继承** `qwen3.8-flash` + `low`，不需要脚本改设置。

## 4. 挂接语义（决定 Bridge 的 connect）

- 会话已 live：`POST /session {cwd}` 返回同 id + `attached:true` + 新 clientId；
- 会话不在内存：`POST /session {cwd, sessionId}` 返回同 id + `attached:false`；
- 空会话（从未 prompt）在守护进程重启后**不持久化**（workspace sessions 列表为空），
  所以正式专席要先用 `scripts/setup-qwen-seat.mjs --seed "…" --allow-cost` 打一次极短回合落到磁盘。
- 带 sessionId 撞上 live 会话会返回 `409 session_id_conflict`，Bridge 必须先查 status 再决定挂接方式。

## 5. 风险与注意

1. 协议标着 experimental，**Qwen Code 升级后必须重跑 `npm run probe:qwen:meta`**。
2. `--require-auth` 实例需要 Bearer；房间只连自己拉起的免 token 回环实例。
3. 会话权限模式默认是 `mode: auto`（不是 yolo）；若回合请求审批，Bridge 会判失败并提示机主到客户端处理。
4. 用量：事件里可能带 `assistant.usage`（`_meta` 路径），本轮未发 prompt 因而未验证；Bridge 先把 `providerUsage` 标为 `null`，真实验收后再定。
5. `clientId` 由服务端分配，会话级接口（pending-prompts/cancel/prompt）必须带它。

## 6. 复现

```powershell
$node = 'C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd C:\KIMIW\ai-room
& $node probes\qwen-code\probe-meta.mjs    # 建临时会话 + 挂接语义（零成本）
& $node probes\qwen-code\probe-api.mjs     # clientId / 模型字段 / SSE 形状（零成本）
```
