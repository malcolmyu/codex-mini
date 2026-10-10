# Codex ↔ 微信 ACP POC

一个本地运行的概念验证：通过微信 iLink Bot 收发消息，用 ACP 驱动本机 Codex，并让创建出来的会话继续出现在 Codex 桌面端的任务列表中。

> 这是非官方 POC。微信 iLink Bot 接口并非面向普通开发者稳定发布的公共 API，协议、准入和风控随时可能变化；请先用测试微信号验证，不要用于生产。

## 架构

```text
微信用户
   │  iLink Bot（扫码登录、长轮询）
   ▼
本地 bridge
   │  ACP / stdio
   ▼
codex-acp
   │  Codex app-server
   ▼
本机 Codex 账号与任务存储 ── Codex 桌面端可见
```

桥接层负责会话绑定、白名单、命令、审批转发和状态持久化。它不会操纵桌面端 UI，而是通过 Codex 协议栈创建/恢复同一套 Codex 任务。

## 环境与安装

- macOS（当前 POC 的验证环境）
- Node.js `>=22.19`
- 已登录并能正常使用的 Codex CLI/桌面端
- 能成功扫码登录 iLink Bot 的微信账号

```bash
cd /Users/yuminghao/work/other/codex-wechat-acp-poc
nvm use
npm install
npm run check
```

## 先用本地 Mock 验证 ACP

```bash
npm run dev -- mock --cwd /Users/yuminghao/work/other/codex-wechat-acp-poc
```

单次冒烟：

```bash
npm run dev -- mock --cwd /Users/yuminghao/work/other/codex-wechat-acp-poc --once "只回复 PONG"
```

## 接微信

扫码登录并保存凭据：

```bash
npm run dev -- weixin login
```

启动桥接：

```bash
npm run dev -- weixin run --cwd /Users/yuminghao/work/other/codex-wechat-acp-poc
```

登录成功后，程序会保存该 Bot 的 owner iLink ID。也可以显式锁定允许控制 Codex 的微信用户 ID：

```bash
export WEIXIN_OWNER_USER_ID='your-ilink-user-id'
npm run dev -- weixin run --cwd /Users/yuminghao/work/other/codex-wechat-acp-poc
```

## 微信命令

- `/help`：帮助
- `/new [cwd]`：创建 Codex 任务
- `/tasks`：列出 Codex 任务
- `/sessions`：列出本地绑定
- `/use <sessionId> [cwd]`：切换到已有 Codex 任务
- `/stop`：取消当前请求
- `/approve <编号>`：批准一次 Codex 工具调用
- `/reject <编号>`：拒绝一次工具调用

普通文本会发送给当前 Codex 任务；若尚未绑定任务，会自动创建。

`/new` 创建的空任务要在收到第一条普通消息后才会由 Codex 持久化；不要在两者之间重启 bridge。

## 数据与安全

- 微信凭据和会话绑定默认保存在 `.data/`，文件权限为 `0600`，且不会被 Git 跟踪。
- POC 暂未接入 macOS Keychain；真实长期使用前应把微信 token 迁移到系统密钥链。
- 白名单校验发生在消息进入 Codex 之前。
- Codex 的工具调用审批会经 ACP 转发到微信，等待 `/approve` 或 `/reject`。
- 同一个 Codex 任务若正在被桌面端或其他客户端写入，可能返回 `thread_active_writer`；切换到新任务或等待另一端结束即可。

可选环境变量见 [.env.example](.env.example)。

## 当前边界

- 仅实现文本消息；图片、文件、语音未接入。
- 微信侧协议是非稳定接口，未承诺兼容性。
- 未做守护进程、断线告警、多租户隔离和生产级审计。
- 扫码登录需要人工完成，自动化测试只覆盖协议解析与桥接逻辑。

## 参考

- [deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop)
- [dsh-im](https://github.com/dsh-tauri/dsh-im)
- [codex-acp](https://github.com/zed-industries/codex-acp)
- [Agent Client Protocol](https://agentclientprotocol.com/)

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
