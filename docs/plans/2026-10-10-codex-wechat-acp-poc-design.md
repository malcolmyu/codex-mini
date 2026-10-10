# Codex–Weixin ACP POC design

## Goal

Prove that a local bridge can receive a text message from Weixin iLink, submit it to Codex through ACP, and return the final text response. The bridge must also be usable without a Weixin account through an interactive mock channel.

## Considered approaches

1. **ACP bridge (chosen):** run `codex-acp` as a child process and implement an ACP Client. This uses a public protocol, supports prompts, streamed events, cancellation, session listing/loading, and permission requests. It does not require patching the Codex desktop application.
2. **Codex App Server directly:** fewer layers but couples the POC to the larger, faster-changing Codex JSON-RPC API. ACP already performs this translation.
3. **Desktop UI automation:** could type into the visible app, but is brittle, cannot reliably correlate streamed events or approvals, and is unsuitable for a background bridge.

## Architecture and data flow

`WeixinChannel` long-polls the iLink API and emits normalized inbound text. `Bridge` enforces owner-only access, handles `/new`, `/tasks`, `/use`, and `/stop`, and maps each conversation to a Codex session in a local JSON state file. `CodexAcpClient` starts the bundled `codex-acp` executable over stdio, initializes ACP, creates or loads a session, accumulates `agent_message_chunk` updates, and exposes permission requests to the channel. Replies are split at 1,800 characters before being sent to Weixin.

The mock CLI channel exercises the same `Bridge` and ACP path. This separates transport correctness from account availability and is the primary automated/manual smoke-test surface.

## Safety and limitations

Real Weixin mode requires an explicit owner iLink user id. Unknown senders are ignored before their text reaches Codex. Credentials and cursors are written under `.data` with file mode `0600`; this is acceptable for a POC but should move to Keychain in a product. Permissions default to rejection unless a live channel reply selects an advertised option. A Codex task already loaded by another App Server, including the desktop app, may return `thread_active_writer`; the POC reports that conflict rather than attempting to break the lock.

## Verification

Unit tests cover text extraction, message splitting, state persistence, command routing, and approval selection. TypeScript compilation is mandatory. A live smoke command sends one harmless prompt through the actual `codex-acp` process using the existing local Codex login.
