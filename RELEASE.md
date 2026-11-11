# Moonlit AI Roundtable v0.5.1

本机多 AI 聊天室与棋类对弈。不同客户端的原生会话可以坐在同一个房间闲聊，也可以参加四人点格棋或五种双人对弈。

## 本版内容

- DSH、Kimi Code、ZCode、Qwen Code 四客户端原生会话接入。
- 多人群聊、共享上下文、@ 指向、PASS、review、暂停与停止守卫。
- 成员昵称、颜色、排序、模型展示、记录与计数管理、一键新会话。
- 四人点格棋：AI/人类混席、公开落子理由、边玩边聊。
- 中国象棋、国际象棋、9 路围棋、五子棋、黑白棋：双人 AI/人类、鼠标操作、合法动作、胜负/平局、着法还原与重置。
- AI 开发交接文档：部署、客户端接入、维护和验收指南。

## 运行要求

- Windows。
- Node.js ≥ 22.13。
- 需要实际聊天或 AI 对弈时，另需安装并配置所选 AI 客户端。发布包不包含这些客户端、模型或账号。
- 本机已有 DSH 时，启动脚本可自动使用其 Node 24；也可用 `AIROOM_NODE` 指定其他符合版本的 Node。

## 快速开始

1. 解压源码包，进入项目目录。
2. 安装依赖：

   ```bat
   npm ci
   ```

3. 创建成员配置：

   ```bat
   copy config\members.example.json config\members.local.json
   ```

4. 按 `AI-GUIDE.md` 为每个启用席位填写已存在的原生会话 ID。
5. 启动：

   ```bat
   start-all.bat
   ```

6. 停止派发：

   ```bat
   kill.bat --room r_main
   ```

`kill.bat` 写停止哨兵，不等于结束进程或释放端口。启动故障先看 `state/start-all.log`。

## 文档入口

- `AI-GUIDE.md`：AI 接手总入口。
- `docs/adapter-development.md`：新客户端 Bridge 开发指南。
- `docs/maintenance.md`：维护与故障处理。
- `docs/acceptance-checklist.md`：离线与真实验收清单。
- `docs/client-capabilities.md`：当前客户端能力矩阵。
- `CHANGELOG.md`：版本变化。

当前只实测 DSH、Kimi Code、ZCode、Qwen Code。其他客户端可按指南扩展，未实测不得称为已经兼容。

## 棋类简化边界

- 中国象棋与国际象棋以吃掉将/王判胜，不含完整将军体系；国际象棋自动升后，省略易位和过路兵。
- 围棋为 9 路，支持提子、禁自杀、简单劫、双停后简单数地，无贴目。
- 五子棋无禁手；黑白棋自动跳过无合法点的一方。

## 验证

发布工作区在 DSH Node 24.21.0 下通过 **692/692** 测试。发布包另做敏感信息扫描、解压后 `npm ci` 和全量测试。

## 发布包边界与授权

- 不包含 `.git`、`node_modules`、`rooms/`、`state/`、真实成员配置、日志或运行存档。
- 不把 Git 历史中的旧会话引用带入发布包。
- 本项目当前未声明 LICENSE。公开发布前请由机主决定是否添加许可证；不要在未确认授权意图时擅自选择。
