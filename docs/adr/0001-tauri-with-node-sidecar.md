# ADR-0001: Tauri 主进程配合 Node bridge sidecar

## Status

Accepted

## Context

现有 POC 已用 TypeScript 验证微信 iLink、ACP、会话绑定和权限审批。新版本需要 macOS 菜单栏、Keychain、开机启动、签名和后台生命周期管理。完全重写为 Rust 会扩大首版范围并重新引入协议风险。

## Decision

采用 Tauri v2 作为 macOS 主进程和 UI 壳，现有 TypeScript bridge 重构为由 Tauri 管理的 Node sidecar。两者通过父子进程 stdio JSON lines 通信。

## Consequences

### Positive

- 最大化复用已验证代码，最快形成端到端 MVP。
- Rust 负责适合它的系统集成，TypeScript 负责协议和业务状态机。
- sidecar 可独立测试，微信/ACP 故障不会拖垮 UI。

### Negative

- 发布包需要包含并签名 Node runtime、bridge 和 Codex 相关二进制。
- 存在跨进程协议、版本握手和进程守护复杂度。
- 常驻内存高于纯 Rust 实现。

### Neutral

- 后续可以逐模块迁移到 Rust，但 MVP 不以此为目标。

## Alternatives Considered

- **全部重写为 Rust**：运行时更轻，但重写成本和协议回归风险过高。
- **Tauri UI + 用户自行安装 Node 服务**：实现快，但安装与运维体验不符合桌面应用目标。
- **Electron 单进程**：复用 TypeScript 最多，但包体和常驻资源更高，macOS 系统集成不如 Tauri 清晰。

## References

- `docs/plans/2026-10-12-tauri-usage-reminder-design.md`

