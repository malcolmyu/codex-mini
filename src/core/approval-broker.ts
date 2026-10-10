import type * as acp from '@agentclientprotocol/sdk';
import type { PermissionPrompt } from './types.js';

export class ApprovalBroker {
  private readonly pending = new Map<string, PermissionPrompt>();

  has(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  wait(conversationId: string, request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const previous = this.pending.get(conversationId);
    previous?.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise((resolve) => {
      this.pending.set(conversationId, { request, resolve });
    });
  }

  describe(conversationId: string): string | null {
    const pending = this.pending.get(conversationId);
    if (!pending) return null;
    const options = pending.request.options
      .map((option, index) => `${index + 1}. ${option.name}`)
      .join('\n');
    return `Codex 请求权限：${pending.request.toolCall.title}\n${options}\n\n回复 /approve <序号>，或 /reject。`;
  }

  answer(conversationId: string, text: string): boolean {
    const pending = this.pending.get(conversationId);
    if (!pending) return false;
    const normalized = text.trim();
    if (/^(?:\/reject|拒绝|不同意)$/iu.test(normalized)) {
      this.pending.delete(conversationId);
      const rejected = pending.request.options.find((option) => option.kind.startsWith('reject'));
      pending.resolve(rejected
        ? { outcome: { outcome: 'selected', optionId: rejected.optionId } }
        : { outcome: { outcome: 'cancelled' } });
      return true;
    }
    const match = /^(?:\/approve(?:\s+(\d+))?|批准|同意|yes)$/iu.exec(normalized);
    if (!match) return false;
    const allowed = pending.request.options.filter((option) => option.kind.startsWith('allow'));
    const index = match[1] ? Number(match[1]) - 1 : 0;
    const selected = pending.request.options[index] ?? allowed[0];
    if (!selected || !selected.kind.startsWith('allow')) return false;
    this.pending.delete(conversationId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: selected.optionId } });
    return true;
  }

  cancelAll(): void {
    for (const prompt of this.pending.values()) prompt.resolve({ outcome: { outcome: 'cancelled' } });
    this.pending.clear();
  }
}
