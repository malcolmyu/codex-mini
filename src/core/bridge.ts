import type * as acp from '@agentclientprotocol/sdk';
import { ApprovalBroker } from './approval-broker.js';
import { StateStore } from './state-store.js';
import { splitText, visibleError } from './text.js';
import type { CodexAgent, IncomingMessage, MessageChannel } from './types.js';

export interface BridgeOptions {
  codex: CodexAgent;
  channel: MessageChannel;
  state: StateStore;
  defaultCwd: string;
  ownerId?: string;
}

export class Bridge {
  private readonly approvals = new ApprovalBroker();
  private readonly sessionConversation = new Map<string, string>();

  constructor(private readonly options: BridgeOptions) {
    options.codex.setPermissionHandler((request) => this.requestPermission(request));
  }

  async start(): Promise<void> {
    await this.options.codex.start();
  }

  async stop(): Promise<void> {
    this.approvals.cancelAll();
    await this.options.codex.stop();
  }

  async accept(message: IncomingMessage): Promise<void> {
    if (this.options.ownerId && message.senderId !== this.options.ownerId) return;
    if (this.approvals.answer(message.conversationId, message.text)) {
      await this.reply(message, '审批决定已提交。');
      return;
    }

    try {
      const text = message.text.trim();
      if (!text) return;
      if (/^\/help$/iu.test(text)) {
        await this.reply(message, this.help());
        return;
      }
      if (/^\/new(?:\s+(.+))?$/iu.test(text)) {
        const cwd = /^\/new(?:\s+(.+))?$/iu.exec(text)?.[1]?.trim() || this.options.defaultCwd;
        const sessionId = await this.options.codex.createSession(cwd);
        await this.bind(message.conversationId, sessionId, cwd);
        await this.reply(message, `已创建 Codex 任务：${sessionId}\n工作区：${cwd}`);
        return;
      }
      if (/^\/(?:tasks|sessions)$/iu.test(text)) {
        const sessions = await this.options.codex.listSessions();
        const rendered = sessions.slice(0, 20).map((session, index) => (
          `${index + 1}. ${session.title || session.sessionId}\n   ${session.cwd}\n   ${session.sessionId}`
        )).join('\n');
        await this.reply(message, rendered || '暂时没有 Codex 任务。');
        return;
      }
      const use = /^\/use\s+([^\s]+)(?:\s+(.+))?$/iu.exec(text);
      if (use) {
        const sessionId = use[1];
        const cwd = use[2]?.trim() || this.options.defaultCwd;
        await this.options.codex.loadSession(sessionId, cwd);
        await this.bind(message.conversationId, sessionId, cwd);
        await this.reply(message, `已切换到任务：${sessionId}`);
        return;
      }
      if (/^\/stop$/iu.test(text)) {
        const binding = await this.options.state.binding(message.conversationId);
        if (!binding) {
          await this.reply(message, '当前聊天没有绑定 Codex 任务。');
          return;
        }
        await this.options.codex.cancel(binding.sessionId);
        await this.reply(message, '已请求停止当前回合。');
        return;
      }

      let binding = await this.options.state.binding(message.conversationId);
      if (!binding) {
        const sessionId = await this.options.codex.createSession(this.options.defaultCwd);
        binding = { sessionId, cwd: this.options.defaultCwd, updatedAt: new Date().toISOString() };
        await this.options.state.bind(message.conversationId, binding);
      }
      this.sessionConversation.set(binding.sessionId, message.conversationId);
      await this.options.codex.loadSession(binding.sessionId, binding.cwd);
      const answer = await this.options.codex.prompt(binding.sessionId, text);
      await this.options.state.bind(message.conversationId, {
        ...binding,
        updatedAt: new Date().toISOString(),
      });
      await this.reply(message, answer || 'Codex 已完成，但没有返回可见文字。');
    } catch (error) {
      await this.reply(message, `处理失败：${visibleError(error)}`);
    }
  }

  private async bind(conversationId: string, sessionId: string, cwd: string): Promise<void> {
    this.sessionConversation.set(sessionId, conversationId);
    await this.options.state.bind(conversationId, {
      sessionId,
      cwd,
      updatedAt: new Date().toISOString(),
    });
  }

  private async requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const conversationId = this.sessionConversation.get(request.sessionId);
    if (!conversationId) return { outcome: { outcome: 'cancelled' } };
    const response = this.approvals.wait(conversationId, request);
    const description = this.approvals.describe(conversationId);
    if (description) await this.options.channel.send({ conversationId, text: description });
    return response;
  }

  private async reply(message: IncomingMessage, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.options.channel.send({
        conversationId: message.conversationId,
        text: chunk,
        contextToken: message.contextToken,
      });
    }
  }

  private help(): string {
    return [
      '/new [绝对路径]  新建任务',
      '/tasks  列出最近任务',
      '/use <任务ID> [绝对路径]  切换任务',
      '/stop  停止当前回合',
      '/approve <序号>  批准权限请求',
      '/reject  拒绝权限请求',
      '/help  显示帮助',
    ].join('\n');
  }
}
