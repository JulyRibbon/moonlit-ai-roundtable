# Kimi Code M0 接入调查

> 日期：2026-11-09
> 状态：调查与实测均已完成（2026-11-09 复核）；真实回合结果见 `kimi-live-short-reply-2026-11-09.md`
> 规则：文档确认不等于本机实测；语音 hook 是否触发不得提前写成支持

## 1. 路线结论

主路线采用 `kimi web` 的 REST + WebSocket，ACP 作为备用。

原因：

- 支持枚举和连接已有原生会话。
- `POST /api/v1/sessions/{id}/prompts` 支持客户端指定 `prompt_id`，可用于房间 attempt 关联和幂等。
- 支持读取队列、取消轮次、读取 snapshot、transcript 和用量。
- ACP 虽支持 `session/new/load/resume/prompt/cancel`，但没有同等的队列和 `prompt_id` 语义。

官方依据：

- [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [Using Kimi Code in the browser](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html)
- [kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [kimi command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)

## 2. 文档确认的接口

| 用途 | 接口 |
| --- | --- |
| 服务元数据 | `GET /api/v1/meta` |
| 列会话 | `GET /api/v1/sessions` |
| 读会话 | `GET /api/v1/sessions/{id}` |
| 建会话 | `POST /api/v1/sessions` |
| 投递 | `POST /api/v1/sessions/{id}/prompts`，带 `content` 和客户端 `prompt_id` |
| 读队列 | `GET /api/v1/sessions/{id}/prompts` |
| 中止提示词 | `POST /api/v1/sessions/{id}/prompts/{prompt_id}:abort` |
| 取消当前轮次 | `POST /api/v1/sessions/{id}:abort` |
| 快照 | `GET /api/v1/sessions/{id}/snapshot` |
| 消息历史 | `GET /api/v1/sessions/{id}/messages` |
| 事件流 | `ws://127.0.0.1:<port>/api/v1/ws` |
| 版本化协议 | `GET /openapi.json`、`GET /asyncapi.json`，均以本机实例为准 |

REST 使用 Bearer 鉴权，WebSocket 使用相同 header 或官方 bearer 子协议。凭据只由客户端内部读取，不打印、不写入报告、不进入 argv。

Server API 当前仍属实验接口。Bridge 的 `probe()` 必须读取本机 `/openapi.json` 与 `/asyncapi.json`，不能只依赖静态文档。

## 3. 事件与恢复

- 文档走查示例使用 `subscribe`，控制帧参考使用 `subscribe_v2`；实现必须以本机 AsyncAPI 为准。
- 最终正文不能只依赖 volatile delta；使用 `turn.ended` 后按 `prompt_id` 从 messages/transcript 对账。
- 重连使用 snapshot 的 `as_of_seq`、`epoch` 和 transcript 续传位置恢复。
- `40931` / `40932` 表示会话被其他客户端占用或更新；不得用 `takeover` 强行接管专席会话。
- 无房间 pending attempt 的原生 turn 标记 `ForeignTurn`，不进入字幕。

## 4. 人格边界

- Web 与 CLI 共用配置和会话数据。
- agent 在会话创建时绑定，续接时恢复；房间不改 cwd、不 fork、不切换 agent。
- 官方接口没有 agent/preset 名称或人格指纹字段。
- `getIdentity()` 只能返回 `sessionId + cwd + model + 会话版本` 等元数据，并标记 `identityLevel:'session+cwd'`。
- 人格是否按预期生效需要固定口令的行为实测，不能从 API 元数据推断。

## 5. 语音边界

本机 `C:\KIMIW\voice` 依赖 `PreToolUse` / `Stop` hook，从会话 `wire.jsonl` 读取最终可见文本并朗读。

官方 Server API 和 ACP 文档没有说明 web/ACP 驱动的回合是否执行这些 hook，因此：

- `voiceTrigger`：待实测。
- `voiceStartedFinishedEvents`：官方事件表未提供。
- `voiceStop` / `voiceMute`：Server API 未提供按席位控制。
- 若 Stop hook 不触发，可评估收到最终文本后调用现有 `voice-hook.mjs --say`，此时必须标 `voiceMode:'external'`，不能冒充原生触发。

## 6. 下一步探测

零成本：

1. `probe-list.mjs`：用官方 CLI 的会话列表或 REST 列会话，选择专席候选。
2. `probe-meta.mjs`：读取 meta、OpenAPI、AsyncAPI，只输出端点和事件名，不输出凭据。
3. `probe-ws.mjs`：连接房间自己的独立端口，完成握手、订阅、退订，不发模型消息。

需要机主另行授权的一次短回复：

1. 新建一次性专席会话。
2. 投递 5～10 字纯文本，不调用工具。
3. 验证 `prompt_id`、最终正文、turn 结束和去重。
4. 观察 voice log / queue 是否出现该会话的新事件，判定 native 或 external。
5. 归档探测会话，不删除用户会话。

任何真实调用前都记录费用副作用；不得默认连续重试。
