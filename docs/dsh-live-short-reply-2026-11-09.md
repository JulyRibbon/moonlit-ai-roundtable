# DSH 真实短回复探测报告（2026-11-09）

> 结论先行：**通过**。新建专席会话（`standard` preset、cwd 指向 `rooms/r_main/deepseek`、
> `deepseek-flash` / `effort=low`）后，用 `probes/live-short-reply.mjs` 做了一次「只回复 OK」的
> 真实探测：`AttemptStarted` → `AttemptCompleted` 各一次，正文 `OK`，usage 由会话投影核实，
> `voiceMode=none`，Bridge 正常关闭，会话**未归档**，留作正式席位。
> 本次只做**一次**真实模型调用，无重试、无取消测试。

## 一、环境与身份

| 项 | 值 |
| --- | --- |
| DSH Web API | `http://127.0.0.1:2955`（本机回环） |
| Node | 资源运行时 `v24.21.0`（PATH 上的 `v18.12.1` 不满足 ≥22.13 要求） |
| 会话 id | `<DSH_SEAT_SESSION_ID>` |
| agentPreset | `standard`（`agentPresets/list` 中 `isDefault: true`；未改任何 preset 定义） |
| cwd | `C:/KIMIW/ai-room/rooms/r_main/deepseek`（本次新建的目录） |
| modelSelection（投影 `next` / `lastUsed`） | `{provider:"deepseek-account", model:"deepseek-flash", reasoningEffort:"low"}` |
| 权限 | `danger-full-access`（DSH 原生默认，未做任何修改） |
| 会话标题 | `回复 OK 测试`（DSH 自动起标题，额外一次小额调用） |

身份确认方式：`session/create` 返回 `{sessionId, agentPreset:"standard"}`；`session/selectModel`
返回 `{selected:{provider:"deepseek-account", model:"deepseek-flash", reasoningEffort:"low"}}`；
随后 `session/list` 的 `projections.values.modelSelection.next` 与 `lastUsed` 均为该三元组，
`projections.values.agentPreset = "standard"`，`cwd` 与建会话时一致。型号与 effort 都是**读回确认**的，
不是推断。

## 二、实际执行的命令（脱敏）

建目录：

```bash
mkdir -p C:/KIMIW/ai-room/rooms/r_main/deepseek
```

建会话（用 `adapters/dsh/dsh-client.mjs` 的 `NodeApiClient.callUnary`，鉴权由客户端自己铸造/交换，
命令与输出中不含任何 token / Cookie）：

```js
const api = new NodeApiClient('http://127.0.0.1:2955', 30000, {});
const created = unwrap(await api.callUnary('session/create', {
  cwd: 'C:/KIMIW/ai-room/rooms/r_main/deepseek',
  agentPreset: 'standard',
}), 'session/create');
// → { sessionId: '<DSH_SEAT_SESSION_ID>', agentPreset: 'standard' }
```

选型：

```js
await api.callUnary('session/selectModel', {
  sessionId: '<DSH_SEAT_SESSION_ID>',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
});
// → { ok: true, value: { selected: { provider:'deepseek-account', model:'deepseek-flash', reasoningEffort:'low' } } }
```

真实探测（**仅此一次**，无 `--abort`）：

```bash
node probes/live-short-reply.mjs --client dsh \
  --session <DSH_SEAT_SESSION_ID> \
  --allow-cost --json
```

## 三、探测结果（`--json` 原样，已无凭据）

```json
{
  "ok": true,
  "client": "dsh",
  "mode": "short-reply",
  "sessionRef": "<DSH_SEAT_SESSION_ID>",
  "seatId": "live-short-reply-dsh",
  "attemptId": "live-dsh-mw87sbz4-b7da0e75",
  "prompt": "只回复 OK，不要调用任何工具。",
  "warnings": ["DSH 没有原生语音能力：本探针只产生文本，不会发声。"],
  "events": [
    { "type": "AttemptStarted",   "atMs": 1036, "attemptId": "live-dsh-mw87sbz4-b7da0e75" },
    { "type": "AttemptCompleted", "atMs": 1943, "attemptId": "live-dsh-mw87sbz4-b7da0e75" }
  ],
  "sendReceipt": {
    "attemptId": "live-dsh-mw87sbz4-b7da0e75",
    "accepted": true,
    "nativeRequestRef": "<DSH_REQUEST_ID>"
  },
  "cancelReceipt": null,
  "usage": null,
  "outcome": {
    "status": "completed",
    "text": "OK",
    "nativeTurnRef": "<DSH_SEAT_SESSION_ID>#turn:1",
    "nativeMessageRef": "<DSH_MESSAGE_ID>"
  },
  "close": { "ok": true },
  "elapsedMs": 1947
}
```

## 四、逐项核查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 投递被接受 | ✅ | `sendReceipt.accepted=true`，`nativeRequestRef` 有值 |
| `AttemptStarted` | ✅ 1 次 | `1036ms`，`nativeTurnRef` 绑定 `turn:1` |
| `AttemptCompleted` | ✅ 1 次 | `1943ms`，`outcome.status=completed` |
| 正文 | ✅ 精确 `OK` | `outcome.text="OK"`（流式 `assistant/chunk` 不累加，无「OKOK」） |
| 去重 | ✅ | 事件列表只有一对 Started/Completed；输出 token = 2，与单条 `OK` 一致，没有重复生成/重复发布 |
| usage | ⚠️ 探针未带出，已从投影核实 | 探针 `usage=null`（Bridge 的 `AttemptCompleted` 载荷目前不含 usage 字段）；会话投影 `tokenUsage={uncachedInputTokens:938, outputTokens:2, cacheReadTokens:24960, cacheWriteTokens:0}` |
| voiceMode | ✅ `none` | `bridge.probe().voiceMode="none"`；`voiceTrigger/voiceStartedFinishedEvents/voiceStop/voiceMute` 全为 `false` |
| Bridge 关闭 | ✅ | 探针 `close.ok=true`；另起的只读核查 Bridge 也正常关闭 |
| 会话未归档 | ✅ | 探测后 `session/list` 仍能找到该 id，`running=false`、`blank=false`、标题已生成 |
| 旧会话未被使用 | ✅ | 全程只投递到新建的 `<DSH_SEAT_SESSION_ID>…` |

**关于 usage**：`docs/events.md` 里 `AttemptCompleted` 的 `usage` 是「可选」，当前
`adapters/dsh/bridge.mjs` 没有把 DSH 的 `tokenUsage` 投影翻译成事件里的 `usage`，所以探针拿不到。
本次没有改 Bridge 代码，用量改为读 `session/list` 投影核实（同一会话的权威累计值）。

## 五、费用

- 会话投影（本会话累计，含这一轮短回复）：`uncachedInput=938`、`cacheRead=24960`、`output=2` tokens。
- 按 flash 非高峰量级估算 ≈ **¥0.01–0.02**（与 `docs/dsh-m0-probe-2026-11-08.md` 的单轮量级一致），
  **低于本次 ¥0.05 预算**；精确金额以 DSH 账单为准。
- 额外开销：DSH 自动起标题一次（`session/title-llm-request`，投影标题「回复 OK 测试」），小额。
- 只发生 **1 次**真实模型回合；没有 `--abort`、没有重试、没有第二次真实调用。

## 六、顺带观察（未改代码）

1. `session/models` 与 `session/history` 在本机 DSH 版本上返回 HTTP 404（`session/page` 返回空），
   所以型号/用量只能经 `session/list` 投影与 `session/selectModel` 返回值核对。
2. ~~`DshBridge._buildIdentity()` 读的是 `summary.projections.values.modelSelection.model`，而本机
   投影形状是 `{lastUsed, next}`，因此 `identity.metadata.model` / `provider` 为 `null`。~~
   **已修（2026-11-09 复核）**：`adapters/dsh/bridge.mjs` 的 `modelSelectionOf()` 现在按
   `lastUsed → next → 扁平结构` 依次读取，`tests/contract/dsh.contract.test.mjs` 有对应用例；
   当时的观测保留作历史记录。
3. 新建会话默认权限即 `danger-full-access`，本次未改动。

## 七、后续

- 该会话（`<DSH_SEAT_SESSION_ID>`）保留为 `rooms/r_main/deepseek` 的正式席位，
  未归档；需要清理时由机主另行决定。
