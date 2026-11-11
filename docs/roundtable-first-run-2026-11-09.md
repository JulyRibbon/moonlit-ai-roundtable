# 真实三席圆桌首轮验收

> 日期：2026-11-09
> 房间：`r_main`
> 配置：`config/members.local.json`，三席真实原生会话，maxAttempts=3

## 结果

机主发起轻松话题“月亮会写出什么奇怪功能”，三席各完成一次真实回复，房间自动进入 `review`。

| 席位 | 表现 | 语音 |
| --- | --- | --- |
| DSH DeepSeek Flash | 以俏皮方式接梗，提出永不返回的 `sleep()` | 无原生 TTS，未朗读 |
| Kimi Code | 以月白人格回应“观测有盲区”“吾在月之暗面” | native Stop hook 已播放，`played=true` |
| ZCode GLM | 以狐娘口吻复核、监考并接住罚单梗 | external Stop hook 已播放，`played=true` |

## 数据核验

- transcript 共 4 条：机主、DeepSeek、Kimi、GLM，roomSeq 唯一且与事件对应。
- 三个 attempt 均为 completed；没有 PASS、failed、aborted 或异常 foreign turn。
- `schedule.awaiting=null`、`ended=true`，没有遗留在飞 attempt。
- `RoomStateChanged` 与 `ReviewRequested` 的 actor 均为 `system:scheduler`。
- 浏览器实际完成激活、机主发言、三席回复和自动 review。

## 已知非阻断项

- DSH 没有原生 TTS，本轮其回复未朗读。
- DSH Bridge 当前未发 UsageReported；GLM 本轮 usage 也为空，后续需要补齐统计。
- Kimi 的 token 总量正确，但 cacheRead 未完整纳入 Bridge 的用量映射。
- 预算模块保留为可选能力，未在正式房间启用。

## 收尾

房间服务与独立 Kimi web 均已关闭，没有遗留后台任务。全量测试为 **408/408 通过**（2026-11-09 复核；首轮验收当时记录的是 375/375，后续测试有新增）。
