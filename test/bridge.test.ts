import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { Bridge } from '../src/core/bridge.js';
import { StateStore } from '../src/core/state-store.js';
import type { CodexAgent, CodexSessionSummary, MessageChannel, OutgoingMessage } from '../src/core/types.js';

class FakeCodex implements CodexAgent {
  prompts: Array<[string, string]> = [];
  loads: Array<[string, string]> = [];
  permissionHandler: ((request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>) | null = null;
  async start() {}
  async stop() {}
  async createSession(_cwd: string) { return 'session-new'; }
  async loadSession(sessionId: string, cwd: string) { this.loads.push([sessionId, cwd]); }
  async listSessions(): Promise<CodexSessionSummary[]> { return [{ sessionId: 'session-new', cwd: '/project', title: 'POC' }]; }
  async prompt(sessionId: string, text: string) { this.prompts.push([sessionId, text]); return `answer:${text}`; }
  async cancel(_sessionId: string) {}
  setPermissionHandler(handler: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>) { this.permissionHandler = handler; }
}

class RecordingChannel implements MessageChannel {
  messages: OutgoingMessage[] = [];
  async send(message: OutgoingMessage) { this.messages.push(message); }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-wechat-bridge-'));
  roots.push(root);
  const codex = new FakeCodex();
  const channel = new RecordingChannel();
  const bridge = new Bridge({ codex, channel, state: new StateStore(join(root, 'state.json')), defaultCwd: '/project', ownerId: 'owner' });
  await bridge.start();
  return { bridge, codex, channel };
}

describe('Bridge', () => {
  it('creates a session on first normal message and returns the answer', async () => {
    const { bridge, codex, channel } = await fixture();
    await bridge.accept({ conversationId: 'chat', senderId: 'owner', text: 'hello' });
    expect(codex.loads).toEqual([['session-new', '/project']]);
    expect(codex.prompts).toEqual([['session-new', 'hello']]);
    expect(channel.messages.at(-1)?.text).toBe('answer:hello');
  });

  it('drops an unauthorized sender before Codex', async () => {
    const { bridge, codex, channel } = await fixture();
    await bridge.accept({ conversationId: 'attacker', senderId: 'attacker', text: 'run command' });
    expect(codex.prompts).toEqual([]);
    expect(channel.messages).toEqual([]);
  });

  it('lists sessions through the command router', async () => {
    const { bridge, channel } = await fixture();
    await bridge.accept({ conversationId: 'chat', senderId: 'owner', text: '/tasks' });
    expect(channel.messages[0].text).toContain('POC');
    expect(channel.messages[0].text).toContain('session-new');
  });
});
