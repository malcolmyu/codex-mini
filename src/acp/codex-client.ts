import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { CodexAgent, CodexSessionSummary } from '../core/types.js';

type PermissionHandler = (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

class BridgeAcpClient implements acp.Client {
  readonly textBySession = new Map<string, string>();
  permissionHandler: PermissionHandler = async () => ({ outcome: { outcome: 'cancelled' } });

  async requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.permissionHandler(request);
  }

  async sessionUpdate(notification: acp.SessionNotification): Promise<void> {
    const update = notification.update;
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return;
    this.textBySession.set(
      notification.sessionId,
      `${this.textBySession.get(notification.sessionId) ?? ''}${update.content.text}`,
    );
  }
}

function defaultAcpBin(): string {
  const name = process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp';
  return join(process.cwd(), 'node_modules', '.bin', name);
}

export interface CodexAcpOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
}

export class CodexAcpClient implements CodexAgent {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private readonly client = new BridgeAcpClient();
  private readonly loaded = new Set<string>();

  constructor(private readonly options: CodexAcpOptions = {}) {}

  setPermissionHandler(handler: PermissionHandler): void {
    this.client.permissionHandler = handler;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    const command = this.options.command ?? process.env.CODEX_ACP_BIN ?? defaultAcpBin();
    if (!existsSync(command)) throw new Error(`codex-acp executable not found: ${command}. Run npm install.`);
    const child = spawn(command, [], {
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.pipe(this.options.stderr ?? process.stderr);
    child.once('exit', (code, signal) => {
      if (this.process === child) {
        this.process = null;
        this.connection = null;
      }
      if (code && code !== 0) console.error(`codex-acp exited with code ${code}${signal ? ` (${signal})` : ''}`);
    });
    const connection = new acp.ClientSideConnection(
      () => this.client,
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    this.process = child;
    this.connection = connection;
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'codex-wechat-acp-poc', version: '0.1.0' },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`ACP version mismatch: ${initialized.protocolVersion}`);
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.connection = null;
    this.process = null;
    this.loaded.clear();
    if (!child) return;
    // codex-acp publishes command metadata immediately after a completed turn.
    // Give that fire-and-forget update a moment to drain before closing stdio.
    await new Promise((done) => setTimeout(done, 250));
    child.stdin.end();
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolveExit();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  async createSession(cwd: string): Promise<string> {
    const connection = this.requireConnection();
    const response = await connection.newSession({ cwd: resolve(cwd), mcpServers: [] });
    this.loaded.add(response.sessionId);
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (this.loaded.has(sessionId)) return;
    await this.requireConnection().loadSession({
      sessionId,
      cwd: resolve(cwd),
      mcpServers: [],
    });
    this.loaded.add(sessionId);
  }

  async listSessions(cwd?: string): Promise<CodexSessionSummary[]> {
    const response = await this.requireConnection().listSessions({
      ...(cwd ? { cwd: resolve(cwd) } : {}),
    });
    return response.sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      updatedAt: session.updatedAt,
    }));
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    this.client.textBySession.set(sessionId, '');
    const response = await this.requireConnection().prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    if (response.stopReason === 'cancelled') throw new Error('Codex 回合已取消');
    return (this.client.textBySession.get(sessionId) ?? '').trim();
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requireConnection().cancel({ sessionId });
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) throw new Error('Codex ACP client is not started');
    return this.connection;
  }
}
