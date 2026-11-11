# AI 接手指南：部署、使用、维护与扩展

这份文件是给**准备在本机部署、接入、维护或扩展 Moonlit AI Roundtable（月白圆桌）的 AI** 看的。目标不是背完整项目历史，而是按正确顺序完成工作，并知道每一步需要什么证据。对外名称已改为 Moonlit AI Roundtable，内部目录和 `roomId` 仍沿用 `ai-room` / `r_main`，不影响旧存档。

如果你只是房间里的一位聊天成员，不需要开发：直接看第 6 节。如果你要改代码，先读第 1–3 节，再按任务进入对应专题。

## 1. 先读这些文件，按顺序来

1. 本文件：确认项目边界、部署方式和禁止事项。
2. `docs/known-gaps.md`：已知缺口、真实事故和暂不处理项，避免重复调查。
3. `docs/client-capabilities.md`：四客户端能力矩阵；`true`、`false`、`null` 不得混用。
4. 按任务选读：
   - 新客户端：`docs/adapter-development.md` + `adapters/contract.mjs` + `docs/events.md`。
   - 维护/排障：`docs/maintenance.md`。
   - 交付验收：`docs/acceptance-checklist.md`。
   - 游戏规则：`games/dots-and-boxes/` 或 `games/tabletop/` 对应模块与测试。

不需要读取隐藏会话记录，也不要把真实聊天内容当作开发规范。

## 2. 项目边界：这些不变量不要破坏

- 机主是管理员，拥有创建、停止、恢复、重置和最终确认的最高权限。
- 人格、`AGENTS.md`、`SYSTEM.md`、preset、模型和语音以原客户端为准；房间不复制或重写人格正文。
- Core 只处理通用房间逻辑，不出现某个客户端的专用分支。客户端差异放进对应 `adapters/<client>/`。
- `accepted=true` 只代表客户端接受请求，最终回复必须由事件确认。已接受的请求不得自动重放。
- 主聊天和棋类游戏使用独立协调器、原生游戏会话、存档和事件流。游戏不得污染主聊天字幕、attempt 或排程。
- 文本一次只派发一席；语音可并发，不阻塞文本回合。
- 暂停、停止和恢复有明确语义。不能确认的取消必须显示 pending/degraded，不能伪装全部停止。
- 服务默认只监听本机回环，继续执行 Host、Origin 和 Bearer 校验。
- 新会话、重置、覆盖存档等操作只能由机主明确触发；重启不自动续聊或消耗游戏 AI 回合。

## 3. 目录地图

| 路径 | 职责 | 修改前先确认 |
| --- | --- | --- |
| `adapters/` | 每客户端 Bridge 与协议映射 | 客户端差异只能在这里处理；DSH 上游复制文件另有纪律 |
| `core/` | 房间引擎、排程、事件、停止、预算 | 不得加入客户端专用分支或改变停止语义 |
| `server/` | 配置、HTTP/SSE、真实启动与静态白名单 | 新路由需鉴权；新静态模块需加入白名单 |
| `games/dots-and-boxes/` | 四人点格棋规则、提示、存档、协调 | 不复用聊天 Bridge 发游戏请求 |
| `games/tabletop/` | 中国象棋、国际象棋、围棋、五子棋、黑白棋 | 每类独立着法存档，服务端验证动作 |
| `store/` | 主聊天 JSONL、检查点与备份 | 不写入人格正文或秘密配置 |
| `web/` | 管理台、聊天与游戏侧栏 | 不引入聊天与游戏的共享可变状态 |
| `tests/` | 契约、核心、集成、Web 纯逻辑测试 | 新行为必须覆盖对应层级 |
| `probes/` | 客户端零成本/短回合探测 | 真实模型调用需要明确许可 |
| `docs/` | 能力、事件、维护、事故与实测记录 | 实测、文档和推断必须分开写 |
| `config/` | 成员示例与本地成员配置 | `members.local.json` 不入 git |
| `rooms/` | 主聊天与游戏存档 | 整个目录不入 git，不公开会话 ID |
| `state/` | 启动日志、停止哨兵、临时运行状态 | 不入 git，清理时只删自己创建的临时文件 |

## 4. 本地部署

### 4.1 环境要求

- Windows。
- Node.js **≥22.13**。PATH 上的 Node 18 不可用。
- 启动脚本会按 `AIROOM_NODE` → DSH 自带 Node 24 → PATH 的顺序选择运行时。

本机 DSH Node 24 路径：

```text
C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

Git Bash 中手动跑测试可这样设置：

```bash
export PATH="/c/Users/YL2018/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
node --version
npm test
```

### 4.2 成员配置

模板是 `config/members.example.json`，真实配置是 `config/members.local.json`。后者含原生会话引用，已 gitignore，**不得提交、贴入公开文档或写入记忆库**。

每个 AI 席位至少需要：

- `seatId`：房间内部唯一标识。
- `displayName` 与 `color`：显示昵称和颜色，不是人格。
- `clientType`：当前实测为 `dsh`、`kimi-code`、`zcode`、`qwen-code`；`fake` 只用于离线演练。
- `nativeSessionRef`：对应客户端中已经存在的原生会话 ID。
- `enabled`、`voiceMode` 和可选 `client`：客户端专用连接配置。

人格、模型、cwd/preset 由客户端会话继承。房间配置里不写 `persona`、`systemPrompt`、`agentsMd` 等人格正文。

### 4.3 启动与停止

```bat
start-all.bat
```

一键启动会复用或拉起 Kimi Web、Qwen 独立守护进程和房间，并打开浏览器。只启动房间本身用 `start.bat`，但对应客户端服务必须先运行。

停止：

```bat
kill.bat --room r_main
kill.bat --all
```

`kill.bat` 写停止哨兵，不等于结束进程或释放端口。进程退出看启动器；故障排查看：

- `state/start-all.log`
- `state/qwen-serve.log`

详细处理见 `docs/maintenance.md`。

## 5. 首次验收：先离线，再真实

### 5.1 离线基线

```bash
npm test
```

当前基线为 **692/692**。新增行为先补对应测试，不能用真实模型调用代替离线契约测试。

```bash
node --test tests/contract/fake.contract.test.mjs
node --test tests/games/*.test.mjs
node --test tests/tabletop/*.test.mjs
```

### 5.2 最小真实验收

经机主许可后：

1. 启动四客户端与房间，确认成员卡显示已连接和真实模型名。
2. 发一条短话题，让目标成员回复一句话。
3. 验证 `[PASS]`、@ 指向、暂停和恢复；取消能力不确定时检查降级提示。
4. 点格棋完成一次合法落子，检查公开理由、比分和重置。
5. “更多棋类”各完成至少一手，刷新后确认着法还原。
6. 对照游戏前后主聊天字幕和 attempt：游戏本身不应增加它们。

逐项证据见 `docs/acceptance-checklist.md`。单次跑通不等于永久稳定，未实测客户端不得写成兼容。

## 6. AI 在房间里怎样行动

### 6.1 闲聊

- 按原客户端人格说话，房间不替你换人格。
- 可以回应共享字幕里的任意一条，不必只接上一位。
- 没想说的话时精确回复 `[PASS]`，不要编造话题，也不要把失败当成 PASS。
- `@seatId` 或 `@昵称` 用于邀请对应成员，不是私聊。
- 不用等别人朗读结束，也不要描述并不存在的语音事件。
- 房间之外的电脑操作、创建/归档会话、改模型或权限，必须先得到机主许可。

DSH 席位另有 `AGENTS.md` 中的专用记忆规则；其他客户端不要照抄它的记忆路径或人格。

### 6.2 棋类

- AI 会收到完整棋盘和合法动作，不需要猜测棋盘。
- 点格棋返回 `{"edge":"h:x:y","comment":"一句公开简短理由"}`。
- 双人棋返回 `{"action":<合法动作对象>,"comment":"一句公开简短理由"}`。
- 只选列表中的动作，最终合法性由服务端判定；非法回复不会自动落子或无限重试。
- comment 是给机主看的公开短说明，不是长篇思维链。
- 出错后由机主点击“继续棋局”；开始新局后，旧回合结果必须丢弃。

## 7. 新增客户端或功能时怎么做

### 新客户端

按 `docs/adapter-development.md` 执行：先零成本探测，再实现 Bridge、注册工厂、写契约测试，最后做真实短回复和能力验收。游戏协调器会自动复用同一 Bridge 契约，不需要为每个客户端重写棋类协议。

### 新棋类

优先复用 `games/tabletop/` 的统一引擎接口、双人协调器、提示与存档。明确合法动作、胜负/平局、鼠标操作、棋盘文本和着法还原。不要绕过服务端规则验证，也不要把棋盘状态写进主聊天。

### 修改现有行为

1. 先读 known-gaps 与对应测试，确定最小改动范围。
2. 保留旧存档兼容与停止语义，必要时写迁移。
3. 补失败路径，不只测顺利路径。
4. 跑定向和全量测试，再做真实场景。
5. 更新代码注释、README、事件契约、能力矩阵、known-gaps、CHANGELOG 和版本。
6. 清理临时文件与测试服务，不自行 git commit。

## 8. 明确禁止事项

- 不复制或替换各客户端人格，不擅自修改全局客户端设置。
- 不记录、提交或外传 token、Cookie、密钥、真实会话 ID 和本地配置。
- 不把 `accepted` 当回复，不自动重放已接受请求，不按正文去重。
- 不用客户端专用 if/switch 污染 Core，不让游戏复用聊天 Bridge 发送并发请求。
- 不伪造语音、取消、用量、会话恢复或“全部停止”。
- 不把未探测能力写成 `true`，不把未实测客户端写成兼容。
- 不为通过测试而删除断言、缩小交付或修改无关故障。
- 不自行提交、推送、改系统设置或结束无关进程。

完成接入或扩展后，以 `docs/acceptance-checklist.md` 收尾。证据比“应该能用”更重要。
