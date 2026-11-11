# probes/zcode — ZCode 侧最小 M0 探测

> 这些脚本只做 M0 探测，不属于 Room Core，也不被 Core 导入。
> **全部零成本 / 零模型调用**：只调用 `runtime/capabilities` 与 `session/list`，
> 不 `resume`、不 `send`、不 `stop`、不 `close` 任何会话，不读消息正文。
> title 默认不打印（可能含用户输入），只有显式 `--title` 才显示。

## 零成本边界

| 操作 | 会不会调用模型 | 说明 |
| --- | --- | --- |
| `--version` / `--help` | 不会 | 纯本地 CLI 输出 |
| `runtime/capabilities` | 不会 | 只返回 7 个能力布尔值 |
| `session/list` | 不会 | 只返回会话元数据，不读 transcript / messages |
| `resume` / `send` / `stop` / `close` | **本目录不实现** | 需要机主另行授权后才能做 |

探针启动的是本次专用、短命的 `app-server` 子进程；stdin 关闭后等待其自行退出，
超时才只结束本次 spawn 的进程树。不会留下常驻服务。

## 运行环境

- Node **≥ 18** 即可运行探针本身（只用 `node:child_process` / `node:fs`）。
- ZCode 子进程必须以 Electron 的 Node 模式启动：
  `ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs ...`。
  不要用 PATH 上的 Node 18 直接跑 `zcode.cjs`（缺少 `node:sqlite`）。
- 默认路径（可用环境变量覆盖）：

  | 名称 | 默认值 | 覆盖变量 |
  | --- | --- | --- |
  | ZCode.exe | `C:\Program Files\ZCode\ZCode.exe` | `AIROOM_ZCODE_EXE` |
  | CLI 入口 | `C:\Program Files\ZCode\resources\glm\zcode.cjs` | `AIROOM_ZCODE_CLI` |
  | 内置 provider 配置 | `C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json` | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` |
  | 个人 provider 配置 | `~\.zcode\v2\provider_config.json` | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` |

  `lib.mjs` 只把 provider 配置的**路径**放进子进程环境；不读取、不打印其内容，
  也不读取 `credentials.json`。

## 文件

| 文件 | 会不会花钱 | 做什么 |
| --- | --- | --- |
| `lib.mjs` | 不会 | `spawn(shell:false)`、NDJSON 请求/通知解析、id 匹配、每请求超时、错误脱敏、优雅关闭与进程树兜底 |
| `probe-version.mjs` | 不会 | 跑 `--version` / `--help`，校验版本与 `app-server` 入口，只打印非敏感摘要 |
| `probe-meta.mjs` | 不会 | 启动短命 app-server，依次 `runtime/capabilities {}`、`session/list {limit}`，校验形状后关闭 |

## 跑法

```powershell
cd C:\KIMIW\ai-room
node probes\zcode\probe-version.mjs
node probes\zcode\probe-meta.mjs
node probes\zcode\probe-meta.mjs --limit 5 --json
node probes\zcode\probe-meta.mjs --title        # 显式要求才显示标题
```

`probe-meta` 参数：

- `--limit N`：`session/list` 的 `limit`，默认 5。
- `--prefix N`：sessionId 显示前缀长度，默认 12；`0` 表示完整。
- `--title`：显示标题（默认关闭）。
- `--json`：输出机器可读摘要。
- `--timeout ms`：单请求超时，默认 20000。

## 实测结果（2026-11-09，ZCode 0.17.1）

`probe-version.mjs`：

```
ZCode CLI: 0.17.1
  app-server: 存在
  --surface:  存在（terminal / desktop）
所有检查 PASS，退出码 0
```

`probe-meta.mjs`：

```
能力: 7 个布尔值，全部 true
  sessionLifecycleWorkspace / sessionWorkspaceRouting / independentPlanState
  historyFirst / sessionDirectorySource / residentRowsRange / genUiContext
会话: 5 条，mode=build，status=idle
通知: startup/storageState × 5
关闭: 已退出=是 code=0（未强杀）
所有检查 PASS，退出码 0
```

运行后核对 ZCode 进程：本次 spawn 的 app-server 已退出，未新增残留；
机器上原有的 3 个 ZCode app-server 进程创建时间均为 2026-11-08，与本次探测无关。

## 协议（0.17.1 实测）

- 传输：stdin/stdout，一行一个 JSON（NDJSON）。
- 请求：`{"id": <number>, "method": "...", "params": {...}}`。
- 响应：`{"id": <number>, "result": {...}}` 或 `{"id": <number>, "error": {...}}`。
  **没有** `{ ok, value }` 业务信封；`result` 就是业务对象。
- 通知：`{"method": "...", "params": {...}}`，无 `id`；启动阶段会先发
  `startup/storageState`（其中含 `attemptId`、`databaseId` 等数据库元数据，本探针只计数）。
- `runtime/capabilities {}` → `result` 为 7 个布尔键。
- `session/list {"limit":N}` → `result.sessions[]`，每项常见字段：
  `sessionId`（`sess_...`）、`sessionKind`、`mode`、`status`、`title`、`titleSource`、
  `traceId`、`createdAt`、`updatedAt`、`workspace.workspaceKey/workspacePath`。
  **实测没有 `model` 字段**；探针保留 `model` 输出位，缺省显示 `-`。
- 会话的 `workspacePath` 有时是自动生成的目录名（如 `draft-...`），探针只显示 basename。

## 协议版本漂移警告

上述形状只对 **ZCode 0.17.1** 实测成立。升级 ZCode 后，先重跑：

```powershell
node probes\zcode\probe-version.mjs
node probes\zcode\probe-meta.mjs --json
```

若响应从顶层 `result` 变成信封、字段改名（例如出现 `model`）、或
`session/list` 分页/形状变化，以真实返回为准更新探针与后续 Bridge，
**不要凭旧结论猜**。`probe-meta` 的形状校验会直接 FAIL 并给出实际类型。

## 下一步（需机主另行授权）

`resume` / `send` / `stop` / `close` 会改变真实会话状态，可能触发模型调用与费用。
本目录**没有**实现这些方法。后续若要接入，必须先取得机主对具体会话的显式授权，
并单独增加探针；不得复用本目录脚本自动执行。
