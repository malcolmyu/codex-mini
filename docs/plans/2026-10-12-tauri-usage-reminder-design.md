# Codex 微信桥 macOS 菜单栏应用与用量提醒设计

日期：2026-10-12  
状态：已确认，待实施

## 1. 目标

在现有 Codex ↔ 微信 ACP POC 上增加两个能力：

1. 用 Tauri v2 封装为 macOS 菜单栏常驻应用，用户无需在终端长期运行 bridge。
2. 读取 Codex 剩余用量和本地任务状态，在额度即将重置且仍有高置信度未完成任务时，通过微信提醒用户；用户回复序号即可继续对应的 Codex 任务。

MVP 优先跑通完整链路。提醒阈值、提示文案、候选排序等细节做成配置，后续根据实际使用调整。

## 2. 非目标

- 不发布到 Mac App Store；首版采用 Developer ID 签名和公证分发。
- 不支持多微信账号、多 Codex 账号或多人共享 Bot。
- 不用模型判断任务是否完成，避免判断过程本身消耗额度。
- 不实现云端同步、远程数据库或服务端调度。
- 不在第一版支持图片、文件和语音消息。

## 3. 功能需求

### 3.1 macOS 菜单栏应用

- 应用启动后常驻菜单栏，关闭设置窗口不退出后台服务。
- 菜单栏显示：微信连接状态、Codex 登录状态、5 小时和周用量、候选任务数、最近提醒时间。
- 菜单提供：打开设置、立即检查、暂停提醒、重新登录微信、查看日志、退出。
- 设置窗口提供微信扫码登录、工作目录、提醒开关、静默时段、阈值和候选任务管理。
- 支持开机启动、单实例运行和 sidecar 崩溃自动重启。

### 3.2 用量与提醒

- 每 10 分钟调用 Codex app-server `account/rateLimits/read`。
- 每次成功刷新用量后，以只读方式扫描本地 Codex 任务数据库。
- 满足平衡型策略时，最多选三个候选任务发送到微信。
- 为每次提醒保存 24 小时有效的候选快照；回复 `1` 或 `/continue 1` 时绑定快照中的任务。
- 支持 `忽略 1`、`稍后 1`、`已解决 1`；用户决策写入本地状态，影响后续候选排序。
- 后续微信文本通过 ACP 发给已绑定任务，回复仍写入 Codex 本地任务存储并在桌面端显示。

## 4. 非功能需求

- **隐私**：对话正文不离开本机和微信/Codex 原有链路；日志默认不记录正文和 token。
- **安全**：微信凭据存入 macOS Keychain；只接受登录 owner 的消息；IPC 仅限本机进程。
- **可用性**：网络或 Codex 用量接口失败时停止提醒但保留微信对话；sidecar 崩溃后指数退避重启。
- **兼容性**：首版支持 macOS 14+，Apple Silicon 优先；Intel/universal 包作为后续发布项。
- **性能**：空闲 CPU 接近 0；常驻内存目标低于 200 MB；数据库扫描 p95 小于 500 ms。
- **可靠性**：提醒去重、微信消息去重和状态写入必须幂等；升级或重启后可恢复绑定。

## 5. 高层架构

```text
┌──────────────────────────────────────────────────────────┐
│ Tauri v2 主进程（Rust）                                  │
│ 菜单栏 / 设置窗口 / Keychain / Autostart / 单实例 / 更新 │
└──────────────────────────┬───────────────────────────────┘
                           │ 本机 IPC（stdio JSON lines）
┌──────────────────────────▼───────────────────────────────┐
│ Node Bridge Sidecar                                      │
│ IPC Gateway │ WeixinChannel │ AcpSessionService          │
│ UsageProbe  │ TaskScanner   │ ReminderEngine             │
│ SnapshotStore / Settings / Structured Logger             │
└───────────────┬────────────────┬─────────────────────────┘
                │                │
       ACP stdio│                │JSON-RPC + SQLite read-only
                ▼                ▼
         codex-acp       Codex app-server / ~/.codex/*.sqlite
                │
                ▼
       Codex 本地任务存储与模型服务
```

### 5.1 Tauri 主进程

Rust 主进程只负责系统集成与生命周期，不承载业务判断：

- 使用 Tauri tray API 创建菜单栏应用。
- 使用 Keychain 插件或 `security-framework` 保存微信凭据。
- 启动、健康检查和重启 bridge sidecar。
- 将 sidecar 状态广播给设置窗口。
- 实现开机启动、单实例、日志目录和退出清理。

设置 UI 建议使用 React + Vite + TypeScript。首版只有状态页、微信登录页、提醒设置页和诊断日志页。

### 5.2 Bridge sidecar

复用现有 TypeScript 代码，并把 CLI 重构为长期运行的 daemon：

- `WeixinChannel`：扫码登录、长轮询、发送消息、消息去重。
- `AcpSessionService`：创建、加载、提示和取消 Codex 任务，转发权限审批。
- `UsageProbe`：启动只读 Codex app-server 客户端，调用 `account/rateLimits/read`。
- `TaskScanner`：只读查询 `state_5.sqlite` 和 `thread_history_1.sqlite`。
- `ReminderEngine`：评分、冷却、静默时间、候选快照和回复路由。
- `SnapshotStore`：保存配置、绑定、提醒快照和用户抑制决策。

开发阶段继续使用项目 Node 22；发布阶段把固定 Node runtime、编译后的 bridge、`codex-acp` 和兼容的 Codex 二进制作为签名 sidecar/resource 放进 `.app`，用户不需要安装 Node。

## 6. 数据流

### 6.1 启动

1. Tauri 获取单实例锁，加载设置并从 Keychain 读取微信凭据。
2. Tauri 启动 bridge sidecar，通过 stdio JSON lines 完成版本握手。
3. sidecar 启动微信长轮询和 ACP 服务，执行一次用量与任务检查。
4. Tauri 根据健康事件更新菜单栏图标；设置窗口按需读取当前快照。

### 6.2 周期检查与提醒

1. `UsageProbe` 每 10 分钟读取 5 小时和周窗口。
2. 用量满足预筛选条件时才运行 `TaskScanner`。
3. `TaskScanner` 返回不包含完整正文的任务特征。
4. `ReminderEngine` 评分、过滤冷却与静默时段，选出最多三个任务。
5. 保存 reminder snapshot 后发送微信消息；发送失败不会写入成功冷却记录。

### 6.3 微信继续任务

1. 用户回复 `1` 或 `/continue 1`。
2. sidecar 根据当前聊天最近的未过期 snapshot 找到任务 ID 和 cwd。
3. 调用 ACP `loadSession`，更新微信聊天与 Codex 任务绑定。
4. 回复“已切换”；用户下一条普通文本直接成为该任务的新 prompt。
5. 如果任务正由另一个客户端写入，提示用户稍后重试或 `/new`。

## 7. 未完成任务判定

第一版使用确定性评分：

| 信号 | 分值/处理 |
|---|---:|
| 最后一轮 `failed` | +50 |
| 最后一轮 `interrupted` | +45 |
| `inProgress` 且 20 分钟无更新 | +40 |
| 助手结构化 `questions` 等待用户 | +45 |
| 用户消息后没有最终助手回复 | +50 |
| 7 天内更新 | +15 |
| 8–14 天内更新 | +5 |
| 已归档、显式已解决、超过 14 天 | 排除 |
| 当前活跃或 48 小时内已提醒 | 排除 |

得分至少 45 才进入候选集。扫描器只读取任务元数据、turn 状态和必要的结构化字段；不把对话正文交给新的模型分类。

本地用户覆盖状态包括 `resolved`、`snoozed_until` 和 `never_remind`。数据库结构变化或字段解析失败时，该任务跳过，不做猜测。

## 8. 平衡型提醒策略

以下任一额度条件成立才进入候选扫描：

- 5 小时窗口剩余不少于 40%，且 75 分钟内重置；
- 周窗口剩余不少于 35%，且 24 小时内重置。

同时要求：

- 至少一个任务得分达到 45；
- 当前时间在 08:30–22:30；
- 距离上次全局提醒至少 8 小时；
- 每个任务距离上次提醒至少 48 小时；
- 每天最多发送两条提醒。

所有阈值进入设置模型，首版 UI 只暴露总开关、静默时段和“平衡型”预设，高级配置暂不显示。

## 9. 本地状态模型

独立状态库不修改 Codex 数据库。MVP 可继续使用原子 JSON；进入签名发布前迁移到应用自己的 SQLite。

主要实体：

- `settings`：工作目录、轮询周期、策略和静默时段。
- `conversation_bindings`：微信聊天与 Codex 任务绑定。
- `reminder_snapshots`：提醒 ID、候选序号、任务 ID、发送时间和过期时间。
- `task_overrides`：已解决、稍后提醒、永不提醒。
- `delivery_log`：幂等键、发送状态和错误摘要。
- `health_state`：组件状态、最后成功时间和连续失败次数。

微信 token 不进入该数据库，只保存在 Keychain。

## 10. 故障处理与降级

| 故障 | 行为 |
|---|---|
| 微信 token 失效 | 停止轮询，菜单栏变红，要求重新扫码；不循环刷错误消息 |
| 用量 RPC 失败 | 保留最后成功快照并标记 stale；不发送新提醒 |
| Codex 数据库锁定 | 只读重试并退避，本轮跳过，不影响微信对话 |
| Codex schema 变化 | scanner fail closed，显示“任务扫描不兼容” |
| sidecar 崩溃 | Tauri 1s/2s/5s/30s 退避重启，10 分钟内超过 5 次则停机等待用户 |
| 微信重复消息 | 以 message ID 幂等去重 |
| 提醒发送结果未知 | 使用 reminder ID 去重，下一轮不立即重发 |
| `thread_active_writer` | 告知任务正在其他客户端运行，不自动复制任务 |
| app-server/ACP 版本不兼容 | 启动握手失败并展示明确版本，不静默降级 |

## 11. 安全设计

- 微信凭据使用 Keychain，迁移成功后删除旧 `.data/weixin-credentials.json`。
- owner ID 白名单在任何 Codex 调用前执行。
- IPC 使用父子进程 stdio，不开放 TCP 端口；消息带 schema version。
- 日志对 token、Authorization、微信内容和 Codex 正文做字段级脱敏。
- 只读扫描用 SQLite `mode=ro`，禁止向 Codex 自有数据库写入。
- 自动更新包必须签名；sidecar 和 Codex 二进制一并签名与公证。
- 设置中的“导出诊断”默认只导出状态、版本和错误码，不包含对话正文。

## 12. 测试策略

### 单元测试

- 用量阈值、时区、静默时段、夏令时和重置边界。
- 任务评分、排除规则、冷却和每日上限。
- reminder snapshot 序号解析、过期和幂等。
- 日志脱敏、owner 校验和 schema 兼容。

### 集成测试

- 使用临时 SQLite fixture 覆盖 completed/interrupted/failed/inProgress 与问题等待状态。
- 使用假的 app-server JSON-RPC 和微信 API 验证完整提醒链路。
- Tauri 启停 sidecar、崩溃重启和设置同步。
- ACP 创建、恢复和继续已有 Codex 任务。

### 手工验收

1. 不依赖终端启动 `.app`，扫码登录微信。
2. 菜单栏正确显示用量并能立即检查。
3. 构造一个中断任务和即将重置的高剩余额度，微信收到一次提醒。
4. 回复 `1` 后发送消息，Codex 桌面端同一任务出现新回合。
5. 重启应用后绑定、冷却和快照行为正确。
6. 断网、微信 token 失效和 app-server 不可用时不重复骚扰。

## 13. 实施阶段

### Phase 1：Tauri 壳与 daemon 化

- 创建 `apps/desktop` Tauri v2 工程和菜单栏。
- 把现有 CLI 重构为带版本化 IPC 的 daemon sidecar。
- 接入生命周期、状态页、日志、单实例和开机启动。
- 微信扫码先复用现有终端/文本 QR，再迁移到窗口二维码。

### Phase 2：用量、扫描与提醒闭环

- 实现 app-server JSON-RPC `UsageProbe`。
- 实现 Codex SQLite 只读 `TaskScanner` 和 fixture 测试。
- 实现 `ReminderEngine`、快照、微信序号回复和用户覆盖状态。
- 完成“提醒 → 回复 1 → ACP 恢复任务 → 继续对话”验收。

### Phase 3：macOS 产品化

- Keychain 迁移、设置 UI、菜单状态和系统通知。
- 打包固定运行时和 sidecar，完成 arm64 签名、公证与升级。
- 增加故障诊断、日志脱敏、schema 探测和版本兼容测试。

## 14. 成功标准

- 应用可连续运行 72 小时，无需终端介入。
- 用量展示与 Codex 桌面端一致，刷新延迟不超过 10 分钟。
- 提醒只在策略命中时发出，同一提醒不会重复发送。
- 用户回复序号后，能在 5 秒内切换并继续同一个 Codex 任务。
- 所有凭据存入 Keychain，日志和自有状态库无明文 token。
- Codex 数据库或用量接口不可用时，实时微信 ACP 对话仍可独立工作。

