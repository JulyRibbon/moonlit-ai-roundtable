# probes/dsh — DSH 侧最小探测脚本

> 这些脚本只做 M0 探测，不属于 Room Core，也不被 Core 导入。
> Node 版本：**必须 ≥ 22.13**。本机 PATH 上的 `node` 是 v18.12.1（会报 `crypto is not defined`），
> 实际用 DSH 自带的：
>
> ```powershell
> $node = 'C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
> ```

| 文件 | 会不会花钱 | 做什么 |
| --- | --- | --- |
| `probe-list.mjs` | 不会 | 列 DSH 原生会话（id / 标题 / preset / cwd / running / 队列 / 用量），给「选一个真实会话入座」用 |
| `probe-run.mjs` | 会（约 ¥0.02 起） | 端到端：投递 → 最终回复 → 去重 → 取消；默认新建一次性会话并自动归档 |

## 跑法

```powershell
cd C:\KIMIW\ai-room

# 列会话（只读）
& $node probes\dsh\probe-list.mjs --limit 20
& $node probes\dsh\probe-list.mjs --grep 本机 --json

# 端到端探针（新建一次性会话，跑完归档）
& $node probes\dsh\probe-run.mjs

# 指定原生会话（会真的投一条消息；加 --cancel 才测取消；不会归档）
& $node probes\dsh\probe-run.mjs --session session-xxxxxxxx --cancel
```

## 判什么算成功（和 docs/client-capabilities.md 一致）

1. **发送**：`sessions.prompt` 返回 `result.ok && value.accepted === true`（实测 20ms 左右）。
2. **最终回复**：收到 `turn/end` 且 `reason.kind === 'completed'`，正文 = `turn/start` 之后所有
   `assistant/message` 的 text 块拼接（`reasoning` 块与 `assistant/chunk` 一律丢弃）。
3. **去重**：`(sessionId, turn)` 唯一；快照历史不重放；快照里「有 start 无 end」的回合要重建 collector。
4. **取消**：`session/cancel` 返回 ok，并收到该 turn 的 `turn/end.reason.kind === 'aborted'`；
   `aborted` 的部分正文**不进房间字幕**，只进 attempts。
5. **语音**：只看事件流里有没有语音帧（当前结论：0 个，DSH 无原生 TTS）。

## 注意

- `probe-run.mjs` 会创建并归档临时会话；`--keep` 可保留它以便在 DSH GUI 里观察。
- 探针期间 DSH 会自动为会话跑一次「起标题」的模型调用（`session/title-llm-request`），这是额外的小额花费。
- `probe-list.mjs` 只读，但会读到会话标题——别把 `--json` 输出直接贴到公开地方。
