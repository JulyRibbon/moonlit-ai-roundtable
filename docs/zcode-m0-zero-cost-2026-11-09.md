# ZCode M0 零成本探测报告

> 日期：2026-11-09
> 范围：CLI 版本、app-server 能力、会话元数据
> 副作用：未 resume/send/stop/close 会话，未读消息正文，未调用模型，未读取凭据

## 实测结果

| 项目 | 结果 |
| --- | --- |
| 桌面版本 | ZCode 3.17.2.9661（只读文件元数据） |
| CLI | `zcode 0.17.1` |
| app-server 入口 | 存在，支持 `--stdio --surface desktop` |
| 协议 | ZCode Protocol v1，stdin/stdout NDJSON |
| `runtime/capabilities` | 7 个能力键均为 true |
| `session/list` | 返回 5 条会话，均有 sessionId/mode/status/workspace/updatedAt |
| 子进程退出 | stdin 结束后 code=0，未强制结束，未留下本次新增进程 |

## 启动条件

必须使用：

```text
ELECTRON_RUN_AS_NODE=1
ZCode.exe resources/glm/zcode.cjs app-server --stdio --surface desktop
```

直接启动时还需要 provider 配置路径：

```text
C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json
```

个人 provider 配置存在时也可通过对应环境变量传入。探针只传路径，不读取配置内容。

## 真实协议形状

- 请求：`{id, method, params}`。
- 响应：`{id, result}` 或 `{id, error}`；没有 `{ok,value}` 业务信封。
- 通知：`{method,params}`；启动时收到 `startup/storageState`，只计数不展开。
- `session/list` 返回 `result.sessions[]`。
- 当前列表没有 model 字段，不能从列表推断模型。
- 默认不输出会话标题，sessionId 只显示前缀。

## 接入结论

主路线采用 ZCode 桌面端自带的 app-server。它是官方二进制提供但未公开文档化的内部协议，版本升级后必须重新探测。

已确认可进入离线 Bridge 设计；发送、最终回复、取消、快照恢复与人格保持仍需一次经机主授权的短回复实测。

语音为现有外部 Stop hook，不是原生 TTS；房间不仲裁并发语音，也不直接修改 hook 配置。
