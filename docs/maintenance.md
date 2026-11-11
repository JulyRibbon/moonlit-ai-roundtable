# Moonlit AI Roundtable 维护手册

> 适用版本：0.5.1（2026-11-11）
> 适用对象：在本机 `C:\KIMIW\ai-room` 维护聊天室、四个原生客户端席位和两类棋局的人。
> 本文只写可执行步骤和已确认事实；没有实测过的客户端行为一律写成“待测”，不写成“支持”。

## 0. 最短操作卡

```bat
cd /d C:\KIMIW\ai-room

:: 全量启动（自动选 Node、复用或拉起 Kimi/Qwen、起房间、开浏览器）
start-all.bat

:: 只起房间（Kimi web / Qwen 守护进程要已在独立终端启动）
start.bat

:: 停止派发（房间级 / 全局；不结束进程，不释放端口）
kill.bat --room r_main
kill.bat --all
```

成功标志：控制台出现 `[ai-room] start-all ready` 或 `live room ready`，并输出房间 URL；`http://127.0.0.1:2961/api/health` 返回 `{"ok":true,"version":"..."}`。

失败先看：`state\start-all.log`；有 Qwen 席位时再看 `state\qwen-serve.log`。

## 1. 运行环境与 Node 24 选择

### 1.1 为什么必须用 Node 24

- 项目要求 Node **≥ 22.13**；PATH 上的 `node` 可能是 18.x，会报 `crypto is not defined` 之类错误。
- 本机实测：PATH `node -v` = `v18.12.1`；DSH 自带 Node = `v24.21.0`。
- 所有 `.bat` 已内置选择顺序：`AIROOM_NODE` → DSH 自带 Node → PATH 上的 `node`，并在启动前检查版本。
- DSH 自带 Node 路径：

```text
%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

### 1.2 检查与覆盖

```bat
where node
node -v
echo %AIROOM_NODE%
```

需要强制指定时：

```bat
set "AIROOM_NODE=C:\完整路径\node.exe"
start-all.bat
```

其他相关覆盖变量：

| 变量 | 用途 |
| --- | --- |
| `AIROOM_NODE` | 三个 `.bat` 使用的 Node |
| `AIROOM_KIMI_EXE` | `kimi.exe` 路径 |
| `AIROOM_QWEN_NODE` + `AIROOM_QWEN_ENTRY` | Qwen Code 的 Node 与 CLI 入口 |
| `AIROOM_ZCODE_EXE` / `AIROOM_ZCODE_CLI` | ZCode 桌面程序 / CLI 路径 |
| `AIROOM_STATE_DIR` | `scripts/halt.mjs` 的哨兵目录，默认 `<项目>\state` |
| `AIROOM_PORT` / `AIROOM_TOKEN` | `server/live.mjs` 的端口 / Bearer 令牌 |

不要把 `AIROOM_NODE` 指到 18.x；不要为了绕过版本检查改 `.bat` 的检查逻辑。

### 1.3 用 Node 24 跑测试

DSH 自带 Node 没有配套 npm，直接调用 `node.exe` 最稳：

```bat
set "NODE24=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
"%NODE24%" -v
"%NODE24%" --test
```

只有确认 `node -v` 已是 22.13+ 时，才用 `npm test`；否则 npm 会用它自己的旧 Node 去跑测试。

依赖缺失或依赖变更时，用能识别 Node 24 的 npm 环境安装依赖，再跑测试；不要删除 `package-lock.json`，也不要手工改 `node_modules` 来“修”测试。

## 2. 启动

### 2.1 一键全量启动

```bat
cd /d C:\KIMIW\ai-room
start-all.bat
```

`start-all` 的顺序：

1. 预检房间端口（默认 2961）。
2. 探测 Kimi（默认 58690）：健康就复用；不健康且端口空闲才拉起 `kimi web --port 58690 --no-open`；最多等 60 秒，每 5 秒打印等待进度。
3. 配置里存在启用的 `qwen-code` 席位时，探测 Qwen（默认 58691）：健康就复用；否则拉起 `qwen serve --port 58691 --workspace <room>\qwen`，最多等 60 秒。
4. 启动 `server/live.mjs`，等待它输出 `[ai-room] open: ...` 后再打开浏览器。
5. 按 `Ctrl+C` 时：先停 live；只停本脚本自己拉起的 Kimi/Qwen；复用来的实例保持运行。

常用参数：

```bat
start-all.bat --no-open
start-all.bat --port 2962
start-all.bat --kimi-port 58692
start-all.bat --qwen-port 58692
start-all.bat --config config\members.local.json
```

- `--port 0` 允许系统分配端口；`--kimi-port` / `--qwen-port` 不能为 0。
- `--no-open` 只跳过浏览器，不改变服务。
- 正式使用默认开浏览器的方式；房间令牌在 URL fragment 中，不要把带令牌的 URL 贴到文档、聊天记录或截图里。

### 2.2 只启动房间

```bat
start.bat
```

或显式指定配置和端口：

```bat
start.bat --config config\members.local.json --port 2961
```

只跑 `start.bat` 时，Kimi web / Qwen 守护进程不会由它拉起。四个客户端里任何一个不可达，对应席位会连接失败或降级；不要用“房间起来了”推断“所有席位都可聊天”。

### 2.3 首次配置

```bat
copy config\members.example.json config\members.local.json
```

然后填写真实的 `nativeSessionRef`。注意：

- `config/members.local.json` 含真实原生会话 id，是本地文件，已在 `.gitignore` 中。
- 不要把该文件复制进 `docs/`、提交、截图或粘贴到公开位置。
- 配置里不允许出现 `persona`、`prompt`、`systemPrompt`、`agentsMd` 正文；人格和提示词只留在原客户端。加载时会直接报错。
- `seatId` / `roomId` 只能是字母数字开头、仅含字母数字下划线短横的裸标识符。

### 2.4 启动成功判据

按顺序核对：

- 控制台有 `Kimi is healthy`（或 `reusing healthy Kimi`）。
- 有启用的 Qwen 席位时，有 `Qwen daemon is healthy`（或 `reusing healthy Qwen daemon`）。
- 有 `[ai-room] start-all ready`。
- 浏览器能打开房间，席位卡显示连接状态和真实模型元数据。
- `http://127.0.0.1:2961/api/health` 返回 200 和版本号。

任何一条不满足，都按“启动未完成”处理，不要开始验收聊天。

## 3. 停止

### 3.1 停止命令

```bat
:: 只停指定房间（阻止新派发并取消可取消的在飞请求）
kill.bat --room r_main

:: 全局停止
kill.bat --all
```

`kill.bat` 不带参数时等同 `--all`。它实际调用 `scripts\halt.mjs`，写入 `state\HALT` 或 `state\HALT.<roomId>` 哨兵，并在下一个检查点生效：

- 停止新的派发。
- 取消可取消的在飞 attempt。
- 无法确认取消的客户端如实标 `degraded` / `pending`。
- 不删除字幕、attempt 审计或原生会话。
- 不自动续聊；恢复要机主明确操作（界面停止按钮的恢复态，或 `POST /api/halt/resume`）。
- 哨兵会留在磁盘上，不因 `Ctrl+C` 或重启自动清除；重启后仍按 halted 处理，直到明确恢复。

**重要：`kill.bat` 不是结束 node 进程，也不释放 2961 端口。** 它只写停止哨兵。要退出房间进程，使用启动窗口的 `Ctrl+C`；要释放被占端口，按下一节的进程排查处理。README 端口一节让你先 `kill.bat`，目的是先阻止继续派发；若端口仍然占用，再按 PID 结束进程。不要因为看到“停止成功”就认为端口已空。

### 3.2 重启语义

- 重启后不会自动继续上一轮聊天，也不会自动消耗 AI 回合。
- 游戏在重启后恢复存档；轮到 AI 时显示“轮到 AI，点击继续”，必须机主点击“继续”才会请求模型。
- 旧原生会话保留；房间只切换引用，不归档、不 fork、不复制会话。

## 4. 端口与占用

### 4.1 默认端口

| 端口 | 用途 | 说明 |
| --- | --- | --- |
| 2955 | DSH Web API | DSH 客户端自身 |
| 2960 | 已被 DSH Harness 占用 | 因此房间默认用 2961 |
| 2961 | ai-room HTTP/SSE | `server/live.mjs` 默认 |
| 58690 | Kimi Code Web | `start-all` 默认 |
| 58691 | Qwen Code `qwen serve` | `start-all` 默认 |
| 本机记录为 14306 | Qwen 桌面 App 现有实例 | **不要接管或修改**；其他机器的桌面端口无需一致 |

### 4.2 排查端口

```bat
netstat -ano | findstr ":2961"
netstat -ano | findstr ":58690"
netstat -ano | findstr ":58691"
```

找到 PID 后，先确认它确实是 ai-room / 卡住的 Kimi / 卡住的 Qwen，再结束：

```bat
taskkill /PID <PID> /T
```

不要按端口号猜进程；不要结束 DSH 的 2955/2960，除非你明确知道后果。`taskkill` 只用于确认过的目标。

### 4.3 常见启动错误

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| `房间端口 2961 已被占用` | 上一次房间进程还在 | 先 `Ctrl+C` 退出旧窗口；必要时按 PID 结束；或 `--port` 换端口 |
| `Kimi 端口 58690 已被占用，但健康检查没有通过` | 卡住的 `kimi web` | 确认 PID 后结束它，或 `--kimi-port` 换端口 |
| `Qwen 端口 58691 已被占用，但 /health 没有响应` | 卡住的 `qwen serve` | 确认 PID 后结束它，或 `--qwen-port` 换端口；同步改 Qwen 席位的 `client.baseUrl` |
| `KIMI_EXE_MISSING` | 找不到 `kimi.exe` | 设置 `AIROOM_KIMI_EXE`，或安装 Kimi Code |
| `KIMI_HEALTH_TIMEOUT` | 60 秒内 Kimi 未就绪 | 看 `state\start-all.log`；单独运行 `kimi web --port 58690 --no-open` 观察真实错误 |
| `QWEN_RUNTIME_MISSING` | 找不到 Qwen 运行时 | 设置 `AIROOM_QWEN_NODE` + `AIROOM_QWEN_ENTRY` |
| `CONFIG_MISSING` | 没有本地配置 | 复制示例并填写；不要提交真实文件 |

## 5. 日志与现场

### 5.1 日志文件

| 路径 | 内容 | 备注 |
| --- | --- | --- |
| `state\start-all.log` | 每次 start-all 的输出 | 超过 1 MB 自动转存为 `.1`；每次启动写分隔行 |
| `state\qwen-serve.log` | Qwen 守护进程 stdout/stderr | 启动失败、ACP 恢复失败的关键线索 |
| `state\qwen-setup-daemon.log` | `setup-qwen-seat.mjs` 临时守护进程日志 | 仅在脚本自拉守护进程时出现 |
| `state\audit.jsonl` | halt / resume 审计 | 不删除；用于说明停止是否真的生效 |
| `rooms\<roomId>\events.jsonl` | 房间事件 | 只追加 |
| `rooms\<roomId>\transcript.jsonl` | 可见字幕 | 清空会先备份 |
| `rooms\<roomId>\attempts.jsonl` | attempt 审计 | 含失败、中止、部分正文；不要当字幕 |
| `rooms\<roomId>\room.json` / `schedule.json` / `cursors.json` | 状态检查点 | 原子写 |
| `rooms\<roomId>\backups\` | 字幕/计数备份 | 含真实会话引用时同样不得入库 |
| `rooms\<roomId>\games\dots-and-boxes.json` | 点格棋存档 | 单文件 |
| `rooms\<roomId>\games\tabletop\<gameType>.json` | 五种双人对弈各自的存档 | 每类一个文件 |

查看示例：

```bat
type state\start-all.log
type state\qwen-serve.log
powershell -NoProfile -Command "Get-Content state\start-all.log -Tail 80"
powershell -NoProfile -Command "Get-Content rooms\r_main\attempts.jsonl -Tail 5"
```

### 5.2 看日志的顺序

1. `state\start-all.log` 的最后一段：先看启动失败在哪一步。
2. `state\qwen-serve.log`：Qwen 超时、ACP 崩溃、404 恢复。
3. `rooms\<roomId>\attempts.jsonl`：这一轮到底有没有成功、失败码、耗时。
4. `rooms\<roomId>\events.jsonl` / `transcript.jsonl`：房间看到的事件和最终字幕。
5. 浏览器 Network：SSE 是否 401、是否断开、是否一直只有心跳。

不要只看 UI 的“正在思考”；以 attempt 终态和事件落盘为准。

Kimi 冷启动横幅可能带 Bearer token，`start-all` 会丢弃它的输出；排查时不要为了“看日志”把横幅重新打印到终端或文档。需要日志时看 `state\start-all.log` 和 Qwen 日志，不要抓取带 token 的原始输出。

## 6. 测试

### 6.1 全量回归

```bat
set "NODE24=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
cd /d C:\KIMIW\ai-room
"%NODE24%" --test
```

当前基线：**692/692 通过**（2026-11-11 用 Node v24.21.0 实跑，约 16.2 秒）。测试数变化时，先确认是不是新增了用例；不要把“数字不同”直接当成通过。

测试不调用真实模型，也不应占用 2961/58690/58691。跑之前确认没有残留房间、Kimi、Qwen 进程，避免测试和真实服务抢端口。

### 6.2 定向测试

```bat
:: 单个文件
"%NODE24%" --test tests\core\engine.test.mjs
"%NODE24%" --test tests\integration\start-all.test.mjs
"%NODE24%" --test tests\contract\qwen-code.contract.test.mjs

:: 一组文件（Node 自己处理引号内的 glob）
"%NODE24%" --test "tests\games\*.test.mjs"
"%NODE24%" --test "tests\tabletop\*.test.mjs"
"%NODE24%" --test "tests\contract\*.test.mjs"
"%NODE24%" --test "tests\integration\*.test.mjs"

:: 按名称筛选
"%NODE24%" --test --test-name-pattern="PASS" tests\core\engine.test.mjs
"%NODE24%" --test --test-name-pattern="halt" tests\core\halt.test.mjs
```

常用对应关系：

| 改动区域 | 至少跑 |
| --- | --- |
| 房间状态、排程、PASS、停止 | `tests/core/*.test.mjs` + `tests/integration/http-sse.test.mjs` |
| 启动脚本、端口、Node 选择 | `tests/integration/start-all.test.mjs` |
| 单个客户端 Bridge | `tests/contract/<client>.contract.test.mjs` |
| 点格棋 | `tests/games/*.test.mjs` + `tests/integration/game-http.test.mjs` |
| 五种双人对弈 | `tests/tabletop/*.test.mjs` + `tests/integration/tabletop-http.test.mjs` |
| 管理台、SSE、游戏 UI | `tests/web/*.test.mjs` |
| 存档、JSONL | `tests/store/*.test.mjs` |

定向测试通过不等于全量通过；收尾必须再跑一次全量。

### 6.3 偶发失败处理

没有已登记的“已知偶发失败”。遇到偶发失败按下面顺序处理，不要用重跑把它糊过去：

1. 保存完整输出：命令、Node 版本、失败文件、失败断言、耗时。
2. 单独重跑失败文件 3 次；记录是否稳定失败。
3. 用 `--test-concurrency=1` 重跑同一文件，排除并行干扰：

   ```bat
   "%NODE24%" --test --test-concurrency=1 tests\core\engine.test.mjs
   ```

4. 检查环境：2961/58690/58691 是否被真实服务占用；是否设置了 `AIROOM_*`、`AIROOM_STATE_DIR`；是否有残留的测试临时目录。
5. 只有确认是测试等待窗口过短或测试之间共享状态，才改测试代码；改完要说明根因，并保留能覆盖该场景的断言。
6. 如果失败只在全量出现、单文件不出现，记录测试顺序和并发度；不要删测试、放宽断言或把等待时间无限加大来“修复”。

`--test-timeout` 只用于临时诊断，不作为长期修复：

```bat
"%NODE24%" --test --test-timeout=60000 tests\core\engine.test.mjs
```

## 7. 会话与模型

### 7.1 席位配置

- 正式配置：`config/members.local.json`。
- 示例配置：`config/members.example.json`。
- 每个席位必须有唯一的 `seatId`，并指向原客户端里**已存在**的原生会话。
- 房间不创建、不归档、不 fork 会话；只有机主在界面点击“新会话”时，才创建并切换。
- 一个原生会话只能给一个房间席位使用。机主在原客户端手动聊出的回合会被判为 `ForeignTurn`，只记录、不进字幕；如果席位被多个用途共用，就会互相抢回合。

### 7.2 DSH 复制纪律

`adapters/dsh/dsh-client.mjs` 是从上游 `qq-bridge/src/dsh-client.js` 复制的文件，文件头写明了来源、日期、上游提交和源文件 sha256。

纪律：

- 保持**逐字复制**，只允许改文件头来源信息。
- 不要在这个文件里改协议细节、字段名、重连逻辑；Bridge 的适配放在 `adapters/dsh/bridge.mjs`。
- 确实必须改复制文件时，按文件头约定在 `docs/dsh-client-diff.md` 记录“改了什么、为什么”；当前仓库没有该文件，需要时再建，不能默默改。
- 上游修 bug 后重新复制一次：更新复制日期、上游提交、源文件 sha256，然后跑 `tests/contract/dsh.contract.test.mjs`。
- 不要复制 DSH 的凭据、Cookie、`~/.dsh/.credentials.yaml`、启动 token 或任何会话正文到仓库、文档、日志示例。
- 不要复制人格、preset 正文、`AGENTS.md` 正文进房间配置；配置里只允许引用和元数据。

DSH 的 Cookie 是用本机凭据离线铸造的，不依赖进程启动 token；这属于本机秘密，排查时可以确认文件存在，不要把内容打印出来。

### 7.3 一键新会话

路径：界面成员卡“新会话”。

行为：

- 沿用原客户端的 cwd / preset / 模型设置创建新原生会话。
- 旧原生会话和房间字幕保留；不自动开始聊天，不自动续聊。
- 成功后写回 `config/members.local.json`；写入失败会返回 `persisted:false` 和错误，不能假装已保存。
- 聊天引擎只切换该席位的引用；旧 Bridge 关闭，不删除旧会话。

Kimi：

- 创建时使用当前会话的 `cwd` 和模型；创建请求带 `metadata.cwd` 与 `agent_config.model`，创建前刷新元数据缓存。
- 创建后通过 `/profile` 补设模型并读回确认；避免出现 `Model not set`。
- 如果当前会话没有可用模型，创建会报 `SESSION_MODEL_REQUIRED`；先到原客户端选模型，不要在房间配置里手写模型名。
- 新会话首次发言前如果界面显示“模型未知”，这是客户端尚未公开模型元数据，不要拿旧模型名冒充。

ZCode：

- 聊天新会话：在同一个 app-server 内 `session/create`，带 `workspace` 和 `persistence: immediate`，然后用同一 Bridge `adoptNativeSession` 接管。
- 游戏新会话：必须在**游戏自己的 app-server** 内 create + adopt。聊天 app-server 刚创建的 id，另一个 app-server 可能暂时看不到；不要跨 app-server 复用新 id。
- 只有模型和思考等级字段都可用时才继承；缺失时不要猜。
- ZCode 的会话匹配是精确匹配，不做前缀/模糊猜测；报 `SESSION_NOT_FOUND` 就回原客户端核对完整 id。

Qwen：

- Qwen 席位使用独立的 `qwen serve`（默认 58691），不接管桌面 App 的现有实例；本机记录桌面端口为 14306，其他机器无需一致。
- 首次建专席（用 1.3 节设置的 `NODE24`；不要用 PATH 上的 Node 18）：

  ```bat
  "%NODE24%" scripts\setup-qwen-seat.mjs --seed "只回复 OK" --allow-cost
  ```

  脚本只打印 sessionId 并写 `state\qwen-seat.json`，不修改 `~/.qwen/settings.json`，也不修改 `config/members.local.json`；由机主确认后自己填。
- 空会话在守护进程重启后可能不持久化；正式专席应先完成一次极短发言，再重启验证。
- 模型和思考强度沿用客户端全局设置，房间不改。

Qwen 的超时与恢复：

- 守护进程的 ACP initialize 默认只有 10 秒；`start-all` 启动时显式追加 `--initialize-timeout-ms 60000`，给机器忙时留出 60 秒。不要把这个值无依据地越调越大。
- 恢复会话的 HTTP 预算约 90 秒；`resume` 请求体不携带 `timeoutMs`，超时由客户端预算控制。
- 发送与 SSE 共用同一把恢复锁：遇到 `session_died` 或会话 404 时，按原 `nativeSessionRef` resume，清空旧事件游标后重新订阅；不新建、不替换会话。
- 只有明确收到 404 `session_not_found`、且请求从未拿到 202 时，才允许在恢复后按原 `attemptId` 重投一次；已经拿到 202 的请求绝不自动重放。
- OOM 的真实根因可能是 ACP 子进程报 `Zone Allocation failed - process out of memory`，随后守护进程拆除会话通道，后续 `/prompt`、`/events` 返回 404；专席 transcript 不因此丢失。
- 自动恢复不能预防内存不足再次造成 ACP 崩溃。频繁复发时先释放内存、排查其他占内存程序，再重启 Qwen/房间；不要擅自改系统虚拟内存或关闭无关程序。
- 现场顺序：`state\qwen-serve.log` → 物理/虚拟可用内存 → `state\start-all.log` → 专席 transcript。不要把 404 一律当成“会话丢了”。

### 7.4 会话故障

| 现象 | 先确认 | 处理 |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | 原客户端里该 id 是否还存在；是否复制完整 | 重新填写完整 id；不要用前缀猜；不要新建来“顶替”旧席位 |
| `IDENTITY_UNAVAILABLE` | 客户端是否启动；端口/凭据是否正常 | 先恢复客户端连接；不要改房间配置里的模型/人格 |
| Kimi `Model not set` | 原会话 `agent_config.model` 是否为空 | 在原客户端选模型；或重新创建会话让 Bridge 继承并读回 |
| 席位显示“模型未知” | 是否首次发言前 | 这是正常边界；不要编造模型名 |
| 新会话切换失败 | 是否有在飞回合；配置是否可写 | 结束当前回合再切；检查 `persisted` 与错误信息 |
| 会话被其他窗口共用 | 是否有人在同一原生会话手动聊天 | 停止共用；给房间专用会话；`ForeignTurn` 不进字幕 |

## 8. 事件流（SSE）

### 8.1 端点

| 端点 | 内容 | 认证 |
| --- | --- | --- |
| `GET /api/health` | 健康与版本 | 无 |
| `GET /api/events` | 聊天室事件 | Bearer |
| `GET /api/game/events` | 点格棋事件 | Bearer |
| `GET /api/tabletop/events` | 五种双人对弈事件 | Bearer |

认证头：

```text
Authorization: Bearer <TOKEN>
```

不要打印真实 token；示例里只写占位符。

### 8.2 行为

- 连接后先收到一条 `snapshot`（当前完整快照，不带 SSE id），再收增量事件。
- 增量事件带 `id: <eventId>`；断线重连带 `Last-Event-ID` 时，只补发缓冲区里该 id 之后的事件。
- 缓冲区默认 500 条；id 太旧或未知时不补发，避免重复。需要完整状态时重新取快照。
- 心跳默认 15 秒；长时间没有心跳、Network 显示连接关闭，按断线处理。
- 三个流彼此独立：聊天流不承载游戏状态，游戏流不写聊天字幕/attempt。

### 8.3 排查

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 401 | Bearer 是否带；token 是否过期/换过 | 重新从启动 URL 获取 token；刷新页面重新写入 |
| 只有 snapshot，没有增量 | 是否有事件发生；是否连错流 | 聊天看 `/api/events`，点格棋看 `/api/game/events`，桌面对弈看 `/api/tabletop/events` |
| 断线后重复/丢事件 | 是否带 `Last-Event-ID`；id 是否落在 500 条缓冲内 | 重新加载快照；不要手工拼接事件 |
| 游戏状态不动但聊天正常 | 是否连了聊天流 | 切到游戏流；游戏协调器与聊天引擎独立 |
| 页面一直转圈 | `/api/health` 是否 200；静态资源是否加载 | 先确认服务活着，再看浏览器控制台 |

不要用轮询 `/api/room` 代替 SSE 来做实时验收；轮询只能证明 REST 快照，不证明事件流通。

## 9. AI JSON 协议（棋局）

### 9.1 点格棋

请求要求只回一个 JSON 对象：

```json
{"edge":"h:x:y","comment":"一句简短公开理由"}
```

- `edge` 必须是当前可用边编号；横边 `h`，竖边 `v`。
- `comment` 是给机主看的公开短理由，入库最多 160 字；提示词要求不超过 80 字。
- 旧 `edge`-only 回复仍兼容，`comment` 为空。
- 纯 JSON、` ```json ` 围栏、“短说明 + 一个 JSON 对象”都可解析。
- 数组、多个 JSON 对象、缺 `edge`、非法边编号一律拒绝。

### 9.2 五种双人对弈

```json
{"action":{...合法动作对象...},"comment":"一句简短公开理由"}
```

- `action` 必须原样来自界面提示里的合法动作列表；也接受把动作对象直接放在顶层。
- `comment` 入库最多 160 字；提示词要求不超过 80 字。
- 解析成功后仍由棋类引擎 `normalizeAction` / `applyTurn` 做最终合法性校验。
- 非法动作、越界、占用点、非当前玩家都会拒绝，不会落子。

### 9.3 非法回复的处理

- 点格棋：`AI_MOVE_INVALID` / `AI_EDGE_OCCUPIED`，对局进入 error，等待机主点击“继续”。
- 桌面对弈：`AI_ACTION_INVALID` / `AI_ACTION_ILLEGAL`，同样进入 error，等待“继续”。
- 不自动换一手、不无限重试、不把 AI 的说明当合法动作。
- 不索取长篇分析或隐藏思维链；只保留公开短理由。
- 重试会带上一次的问题说明（`retryReason`），但仍只允许一个 JSON 对象。
- 连续失败时先看模型是否按协议回复、提示词是否被截断；不要靠放宽解析器来“兼容”任意文本。

## 10. 游戏维护

### 10.1 独立会话

- 每个 AI 玩家在每局游戏里使用独立原生游戏会话，`seatId` 形如 `game-<gameId>-<slot>`。
- 游戏会话沿用原客户端人格、模型、cwd，但**不复用聊天专席**。
- 游戏会话 id 只存在游戏存档里；公开 API 不返回它。
- 游戏协调器、存档、HTTP/SSE、界面均独立于聊天引擎；不写聊天字幕、attempt 或排程。
- 开始新局会关闭旧游戏 Bridge，但旧原生会话保留；房间不自动归档/删除。

### 10.2 还原

- 点格棋存档：`rooms\<roomId>\games\dots-and-boxes.json`，只保存 `{schemaVersion:1, game}`。
- 桌面对弈存档：`rooms\<roomId>\games\tabletop\<gameType>.json`，每类一个文件；只保存着法序列，不复制棋盘。
- 刷新页面：前端从 SSE snapshot 还原。
- 重启房间：协调器读取存档；桌面对弈按 `moves` 逐手重放重建棋盘；点格棋直接读游戏状态。
- 存档损坏、结构无效、着法无法重放：进入 error，显示原因，不自动覆盖原文件。
- 重启后如果轮到 AI，状态是 idle，必须机主点击“继续”才会请求模型；不会自动消耗回合。
- 手工修存档前先复制备份；不要在房间运行时直接改文件，原子写可能覆盖你的修改。

### 10.3 重置

- 点格棋界面“新棋局/再来一局”调用 `POST /api/game/new`。
- 五种双人对弈的“新对局”调用 `POST /api/tabletop/new`，只重置当前 `gameType`。
- 当前对局未结束时，界面会先确认；确认后：
  - generation 递增；
  - 旧 Bridge 关闭，旧 AI 结果失效；
  - 新存档写入当前棋种文件；
  - 其他棋种存档不动；
  - 旧原生会话保留。
- 重置不会清空聊天字幕、聊天 attempt 或排程；也不会自动开始聊天。
- 不要用删除 `rooms\...\games\` 的方式“重置”；那会丢掉可恢复记录，且不会清理内存中的协调器状态。

### 10.4 generation 与聊天隔离

- 点格棋协调器有一个 generation；桌面对弈每个棋种各有自己的 generation、存档、状态和 Bridge。
- 新局 / 重置 / 关闭会递增 generation；旧回调、旧 AI 结果、旧 waiter 在 generation 不匹配时直接丢弃。
- 切换棋种不会影响另一个棋种的存档或运行状态。
- 游戏事件、游戏会话、游戏 attempt 不进聊天；聊天事件也不进游戏。
- 验证隔离时，记录游戏操作前后的聊天 `transcript.jsonl` 行数和 `attempts.jsonl` 行数，必须不变；游戏存档应变化。

### 10.5 合法性与边界

- 点格棋：4×4 格子、5×5 点阵、40 条边；围格得分并连走；边用完最高分胜，可平局。
- 中国象棋 / 国际象棋：以吃掉将/王判胜，不含完整将军体系；国际象棋省略易位和过路兵，兵到底线自动升后。
- 围棋：9 路、提子、禁自杀、简单劫、双停后简单数地、无贴目。
- 五子棋：无禁手。
- 黑白棋：自动跳过无合法点的一方。
- 这些边界必须在界面和验收记录里保留；不要把简化规则写成完整规则。

## 11. 故障处理 playbook

| 症状 | 先查 | 处理 | 不要做 |
| --- | --- | --- | --- |
| 启动窗口一闪而过 | `state\start-all.log` | 在 cmd 里运行 `start-all.bat` 看完整错误；失败窗口会暂停 | 不要反复双击 |
| 2961 占用 | `netstat -ano` | 退出旧窗口；确认 PID 后结束；或换端口 | 不要直接 `taskkill /IM node.exe` |
| Kimi 58690 卡住 | `/api/v1/meta` 是否有响应 | 确认 PID 后结束卡住的 `kimi web` | 不要结束 DSH |
| Qwen 58691 卡住 | `/health` | 确认 PID 后结束；或换 `--qwen-port` 并同步 `client.baseUrl` | 不要接管桌面 App 的现有实例（本机记录为 14306） |
| Kimi 60 秒未就绪 | 单独启动 `kimi web` | 看真实错误；机器忙时等或释放资源 | 不要无限调大超时来掩盖 |
| Qwen ACP 超时 | `state\qwen-serve.log` | 确认内存；重启 Qwen/房间；恢复会按原 id resume | 不要改系统虚拟内存或擅关无关程序 |
| Qwen `session_not_found` | 是否 404；是否已获 202 | 共享恢复锁按原 id resume；仅未获 202 的 prompt 可重投一次 | 不要新建 id 顶替；不要重放已获 202 的请求 |
| Qwen OOM | 物理/虚拟可用内存；日志 `Zone Allocation failed` | 释放内存；重启守护进程；接受自动恢复不能预防再次 OOM | 不要伪装成已修复 |
| ZCode 新会话“会话不存在” | 是否跨 app-server | 在游戏自己的 app-server create + adopt | 不要拿聊天 app-server 的新 id 直接给游戏 |
| Kimi `Model not set` | 原会话模型是否为空 | 原客户端选模型；重建并读回确认 | 不要手写配置里的模型冒充 |
| 席位一直“思考” | `attempts.jsonl` 是否有 terminal | 看客户端事件/SSE；必要时停止并重试 | 不要重复点击造成多个回合 |
| SSE 401 | token | 重新获取 token；刷新页面 | 不要把 token 写进文档 |
| 游戏 AI 回复非法 | error 文本、模型输出 | 点击“继续”重试；检查协议 | 不要自动重试或接受任意文本 |
| 游戏存档损坏 | 错误信息、文件 JSON | 先备份；修复或开新局 | 不要在运行时直接改存档 |
| 测试偶发失败 | 失败文件、并发、端口 | 单文件 3 次、串行重跑、记录根因 | 不要删测试/放宽断言了事 |

## 12. 变更收尾：文档、版本、记忆、清理

每次功能或行为变更，按下面顺序收尾；只改代码不改这些，视为未完成。

### 12.1 版本与变更记录

- `package.json` 的 `version`、`server/version.mjs` 的 `AI_ROOM_VERSION`、`CHANGELOG.md` 顶部版本必须一致。
- `CHANGELOG.md` 写“用户可见变化 + 边界”，不写内部 TODO。
- 版本界面和 `/api/health` 会同步展示；`tests/integration/version.test.mjs` 会检查一致性。

### 12.2 文档

- `README.md`：启动/停止命令、测试基线、端口、已知限制。
- `docs/known-gaps.md`：新增缺口写清现象、根因、证据、是否本轮处理；修复后更新或移除对应条目。
- `docs/client-capabilities.md`：只按实测更新；未测写“待测”，不支持写“不支持”，不要把“文档写了”当“实测通过”。
- `docs/events.md`：事件契约、字段、去重、恢复语义变化时更新。
- `AGENTS.md`：只改席位行为/记忆路径等真正影响席位的规则；人格正文不写进房间。
- 新的实测报告放 `docs/`，文件名带日期；报告里的会话 id、token、Cookie 一律脱敏为占位符。

### 12.3 测试与证据

- 先跑定向测试，再跑全量；把命令、Node 版本、通过数、耗时写进交接。
- 真实场景验收单独记录：房间、席位、客户端版本、模型、操作、结果、证据文件。
- 没有真实运行证据，不写“兼容/支持/稳定”；一次成功只写“本机单次跑通”。

### 12.4 记忆

- 房间长期事实按 `AGENTS.md` 写入 `C:\DSHW\memory\圆桌\` 的对应文件；只写结论、约定、边界，不抄会话正文。
- 不写 token、Cookie、真实会话 id、私密信息、整段对话。
- 结论被新事实取代时，标注“被某日某条取代”，不要静默改历史。
- 阶段性收尾更新 `now.md` 一类当前状态文件；不要把一次性工具输出当记忆。

### 12.5 清理

- 删除本次产生的临时日志、临时房间、临时测试输出、未使用的备份；保留需要审计的 `attempts.jsonl`、`events.jsonl`、`audit.jsonl`。
- 确认 `state/`、`rooms/`、`config/members.local.json`、`*.log`、`*.tmp` 仍被 `.gitignore` 覆盖。
- `git status --ignored` 检查有没有真实 id 或备份被意外暂存；不要用 `git add -f` 硬塞。
- 旧原生会话、旧游戏会话默认保留；清理会话必须在原客户端由机主明确操作，房间不自动删除。
- 提交只在机主明确要求时做；提交前再核对一次没有真实 id/token。

## 13. 事实边界

- 本文的命令、端口、文件路径来自当前仓库代码和实测记录；不要凭记忆补不存在的参数。
- 已知用量缺口（DSH 不上报、GLM attemptId 为 null、Kimi 缺 cacheRead）见 `docs/known-gaps.md`；维护时不要顺手改坏，也不要假装已修。
- Qwen 的自动恢复只解决“会话通道 404/ACP 崩溃后的恢复”，不能预防内存不足再次崩溃。
- 游戏规则是简化版，界面和文档必须保留简化边界。
- 单次真实成功不能推出“永久稳定”；稳定性需要跨重启、重复回合和故障恢复的证据。
