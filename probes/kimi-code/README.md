# probes/kimi-code — Kimi Code 侧最小 M0 探测

> 这些脚本只做 M0 探测，不属于 Room Core，也不被 Core 导入。
> **全部零模型调用**：不投递 `prompts`、不新建/归档会话、不取消轮次、不读会话正文。

## 运行环境

- Node **≥ 22**（需要内置 `fetch` 与全局 `WebSocket`）。
  本机 PATH 上的 `node` 当前是 v18.12.1，会直接报错；可用 DSH 自带的 Node 24：
  `C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`
- 服务地址默认 `http://127.0.0.1:58690`，可用 `AIROOM_KIMI_BASE` 覆盖。
- 鉴权 token 优先取 `AIROOM_KIMI_TOKEN`，否则由程序内部读取
  `~/.kimi-code/server.token`。token 不会出现在日志、错误、argv 或本 README 中。

## 启动独立实例（由机主 / Kimi 负责，不在本目录脚本内）

不要动用户现有的 Kimi 客户端。另起一个只用于探针的实例：

```powershell
& 'C:\Users\YL2018\.kimi-code\bin\kimi.exe' web --port 58690 --no-open
```

- `--no-open` 避免弹浏览器；`--port 58690` 与用户默认客户端（默认 58627）隔离。
- 多实例可共存，token 使用同一个持久文件；需要轮换时用 `kimi web rotate-token`。
- 探针跑完后由启动者自行结束该实例，不要执行 `POST /api/v1/shutdown` 去影响其他实例。

## 文件

| 文件 | 会不会花钱 | 做什么 |
| --- | --- | --- |
| `lib.mjs` | 不会 | 构造 REST 客户端、读 token、脱敏、拼 WS 地址与 bearer 子协议 |
| `probe-list.mjs` | 不会 | `spawn` 调用 `kimi session list --all --json`，列出候选会话元数据 |
| `probe-meta.mjs` | 不会 | 读 `/api/v1/meta`、`/openapi.json`、`/asyncapi.json`，只输出端点与事件名 |
| `probe-ws.mjs` | 不会 | 连 `/api/v1/ws`，校验 `server_hello` v2，对指定会话 `subscribe_v2` → `unsubscribe_v2` |

## 跑法

```powershell
cd C:\KIMIW\ai-room
$node = 'C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

# 1) 列会话（只读，不连服务）
& $node probes\kimi-code\probe-list.mjs --limit 20
& $node probes\kimi-code\probe-list.mjs --grep KIMIW --json

# 2) 读本机协议（需要 58690 实例已启动）
& $node probes\kimi-code\probe-meta.mjs
& $node probes\kimi-code\probe-meta.mjs --json

# 3) 只读订阅指定会话（必须显式给 --session；不会发消息）
& $node probes\kimi-code\probe-ws.mjs --session session_xxxxxxxx --watch 3000
```

`probe-ws` 也可以加 `--timeout 15000`（总超时）、`--since <seq>`（断点续传）、
`--grade turn|block|delta|off`（默认 `turn`，不给就不要 finer 正文事件）、`--json`。

## 判什么算成功

1. `probe-list`：CLI 退出码 0，输出可解析的 JSON 数组；只出现
   `id / title / workDir / archived / lastTurnReason / createdAt / updatedAt` 等元数据。
   `busy` 字段恒为 `null`：CLI 摘要不提供运行状态，只有 REST snapshot 才知道。
2. `probe-meta`：三个请求都返回信封 `code=0`；能列出本机 REST 路径与 AsyncAPI 事件名。
3. `probe-ws`：
   - 收到 `server_hello` 且 `payload.protocol_version === 2`；
   - `subscribe_v2` 的 ack `code=0`；
   - `unsubscribe_v2` 已发送且 ack `code=0`；
   - 观察窗口内至少收到一个会话帧（`agent` / `usage` / `transcript.reset` 等）；
   - 连接以 1000 正常关闭，进程不悬挂。
   - 本机实测：对不存在的 `session id`，`subscribe_v2` 仍回 `ack code=0` 且无报错，
     所以用「有没有会话帧」做正向信号；`--watch 0` 可跳过该判断。
4. 不打印 `assistant.delta`、thinking、tool 输出等正文；`transcript.ops` 只打印 op 类型计数。

## 本机协议要点（以 `/openapi.json`、`/asyncapi.json` 为准）

- REST 统一信封 `{ code, msg, data, request_id }`；HTTP 状态几乎总是 200，业务结果看 `code`。
- WS 升级可用 `Authorization: Bearer <token>` 或子协议 `kimi-code.bearer.<token>`；
  本目录使用后者，token 只存在于内存。
- 控制帧 `{ type, id?, payload }`，回执 `{ type:'ack', id, code, msg, payload }`。
- 会话订阅唯一形式是 `subscribe_v2`；`transcript` 是「agent_id → 级别」映射，
  `"*"` 设默认级别，级别为 `off / turn / block / delta`。
- 本机 AsyncAPI 3.1.0 只声明传输层消息名（`server_hello`、`session_event`、`agent`、
  `usage`、`goal`、`todo`、`task.*` 等），不逐条列出 `turn.started` / `assistant.delta`
  这类子事件；子事件名以实测为准，`probe-ws` 会按实际收到的 `type` 汇总。
- 会话级事件除 `transcript.reset` / `transcript.ops` 外还有 `turn.*`、`tool.*`、
  `assistant.delta`、`agent`、`usage`、`goal`、`todo`、`interaction` 等。
- 错误码：`40101` 鉴权失败，`40401` 会话不存在，`40931/40932` 会话被其他客户端占用或更新
  （不要用 takeover 强行接管专席会话）。

## 安全注意

- `probe-list` 会读到会话标题（可能含隐私），`--json` 输出不要直接贴到公开地方。
- 任何真实模型调用都不在本目录脚本内；需要短回复实测时另行授权并记录费用副作用。
- 不要把 `server.token`、`AIROOM_KIMI_TOKEN` 或完整请求头贴进报告。
