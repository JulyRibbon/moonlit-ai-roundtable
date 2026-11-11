# Kimi Code M0 零成本探测报告

> 日期：2026-11-09
> 实例：独立 `kimi web --port 58690 --no-open`，验收后已关闭
> 副作用：未投递 prompt，未调用模型，未新建、归档、取消或删除会话

## 结果

| 探测 | 结果 | 证据 |
| --- | --- | --- |
| CLI 会话枚举 | PASS | `kimi session list --all --json` 可解析；仅输出会话元数据 |
| 实例元数据 | PASS | `server_version=2.5.2`，WebSocket 等能力可用 |
| OpenAPI | PASS | 3.0.3，105 个 path、127 个操作 |
| AsyncAPI | PASS | 3.1.0，声明传输层控制帧和消息名 |
| WS 握手 | PASS | `server_hello.payload.protocol_version=2` |
| WS 订阅/退订 | PASS | `subscribe_v2` / `unsubscribe_v2` 均 `ack code=0` |
| WS 关闭 | PASS | 客户端主动 close，code 1000，无悬挂 |
| 凭据脱敏 | PASS | 子智能体分别验证正常与连接失败输出，未泄露 token |

## 实际收到的会话帧

- `agent`
- `goal`
- `task.list`
- `todo`
- `transcript.reset`
- `usage`

探针只记录类型、序号和 payload 键名，没有输出 assistant、thinking 或工具正文。

## 对 Bridge 的约束

1. `subscribe_v2` 对不存在的 session id 也可能返回 `ack code=0` 且没有会话帧，不能只凭 ACK 判定会话存在；必须结合 REST 或正向会话帧。
2. 本机 AsyncAPI 只列传输层消息名，不逐条列 `turn.started`、`assistant.delta` 等子事件，后续以真实回合实测补充。
3. `agent`、`usage`、`goal`、`todo`、`task.list` 的字段可直接挂在顶层；`transcript.reset` 使用 payload，解析器必须兼容。
4. CLI 会话列表没有 busy 字段，运行状态需要 REST snapshot 或 WS agent 帧。
5. 服务端不发送心跳，Bridge 负责保活、超时与重连。

## 尚未验证

- 向现有会话发送 prompt。
- `prompt_id` 与最终正文的真实关联和去重。
- abort、排队项移除和崩溃恢复。
- web 驱动是否触发当前 Stop 语音 hook。
- 专席会话中的人格行为。

这些项目需要另一次短回复授权，不在本次零成本探测范围内。
