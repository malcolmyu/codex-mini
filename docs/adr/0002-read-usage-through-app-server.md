# ADR-0002: 通过 Codex app-server RPC 读取用量

## Status

Accepted

## Context

提醒器需要知道 5 小时和周用量窗口。解析 Codex 桌面 UI 或本地认证文件脆弱且有安全风险；通过模型询问用量会消耗额度。已验证 Codex app-server 提供 `account/rateLimits/read`，并推送 `account/rateLimits/updated`。

## Decision

由 sidecar 的 `UsageProbe` 使用版本锁定的 Codex app-server JSON-RPC 调用 `account/rateLimits/read`。每 10 分钟刷新；失败时保留 stale 快照但禁止发送新提醒。

## Consequences

### Positive

- 使用结构化协议，不依赖 UI 和文本解析。
- 不产生模型请求，不需要读取或复制认证 token。
- 可获得窗口长度、已用比例和准确重置时间。

### Negative

- app-server 目前属于实验性接口，需要锁定和测试兼容版本。
- bridge 同时维护 ACP 和一个只读 app-server 通道。

### Neutral

- 后续 ACP 若正式暴露结构化用量能力，可以替换实现而不改变 ReminderEngine。

## Alternatives Considered

- **解析 codex-acp `/status` 文本**：可以工作，但格式和本地化变化会破坏解析。
- **读取桌面端 UI/缓存**：耦合实现细节，且容易碰到认证数据。
- **直接调用云端接口**：需要自行处理认证，增加安全和兼容风险。

## References

- Codex app-server method: `account/rateLimits/read`
- `docs/plans/2026-10-12-tauri-usage-reminder-design.md`

