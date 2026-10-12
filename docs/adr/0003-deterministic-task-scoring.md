# ADR-0003: 用确定性规则识别未完成任务

## Status

Accepted

## Context

提醒器必须从本地任务中找出值得继续的工作。使用模型总结或分类能提高语义理解，但会消耗用户希望节省/利用的额度，也会上传更多对话内容。Codex 本地数据库已经包含 turn 状态、消息方向、结构化问题、归档状态和更新时间。

## Decision

首版采用只读扫描和可解释评分。只读取完成判定所需的元数据与结构化字段，不用模型分类。用户可以将任务标记为已解决、稍后提醒或永不提醒。

## Consequences

### Positive

- 判断不消耗 token，结果可解释、可测试。
- 数据最小化，减少隐私风险。
- 阈值和规则可以在不改变协议的情况下迭代。

### Negative

- 不能准确理解所有自然语言中的“已经完成”。
- Codex 本地 schema 变化需要适配 scanner。
- 可能漏掉状态已完成但语义上仍有后续工作的任务。

### Neutral

- 规则保持保守；不确定时不提醒。

## Alternatives Considered

- **本地或云端 LLM 分类**：语义更强，但增加 token、隐私、延迟和失败面。
- **只看 turn status**：实现简单，但会漏掉等待用户回答的 completed turn。
- **只看最近活跃时间**：误报过多，无法满足平衡型提醒。

## References

- `docs/plans/2026-10-12-tauri-usage-reminder-design.md`
