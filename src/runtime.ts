import { join, resolve } from 'node:path';
import { CodexAcpClient } from './acp/codex-client.js';
import { Bridge } from './core/bridge.js';
import { StateStore } from './core/state-store.js';
import type { BridgeStatus } from './ipc/protocol.js';
import { IPC_VERSION } from './ipc/protocol.js';
import { WeixinApi } from './weixin/api.js';
import { loadCredentials, WeixinChannel } from './weixin/channel.js';

type StatusListener = (status: BridgeStatus) => void;

export interface BridgeRuntimeOptions {
  projectRoot: string;
  defaultCwd: string;
}

export class BridgeRuntime {
  private bridge: Bridge | null = null;
  private controller: AbortController | null = null;
  private channelTask: Promise<void> | null = null;
  private readonly listeners = new Set<StatusListener>();
  private status: BridgeStatus;

  constructor(private readonly options: BridgeRuntimeOptions) {
    this.status = this.makeStatus('stopped', 'disconnected', 'disconnected');
  }

  currentStatus(): BridgeStatus {
    return { ...this.status };
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(cwd = this.options.defaultCwd): Promise<BridgeStatus> {
    if (['starting', 'running'].includes(this.status.lifecycle)) return this.currentStatus();
    const resolvedCwd = resolve(cwd);
    this.update(this.makeStatus('starting', 'connecting', 'connecting', resolvedCwd));

    const dataDir = join(this.options.projectRoot, '.data');
    let credentials;
    try {
      credentials = await loadCredentials(join(dataDir, 'weixin-credentials.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.update(this.makeStatus('needs_login', 'needs_login', 'disconnected', resolvedCwd));
        return this.currentStatus();
      }
      return this.fail(error, resolvedCwd);
    }

    const channel = new WeixinChannel(
      new WeixinApi(),
      credentials,
      join(dataDir, 'weixin-runtime-state.json'),
    );
    const bridge = new Bridge({
      codex: new CodexAcpClient(),
      channel,
      state: new StateStore(join(dataDir, 'weixin-bridge-state.json')),
      defaultCwd: resolvedCwd,
      ownerId: process.env.WEIXIN_OWNER_USER_ID ?? credentials.ownerUserId,
    });
    const controller = new AbortController();
    try {
      await bridge.start();
    } catch (error) {
      return this.fail(error, resolvedCwd);
    }

    this.bridge = bridge;
    this.controller = controller;
    this.update(this.makeStatus('running', 'connected', 'connected', resolvedCwd));
    this.channelTask = channel.run((message) => bridge.accept(message), controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) this.fail(error, resolvedCwd);
      })
      .finally(() => {
        if (this.controller === controller && !controller.signal.aborted) {
          this.bridge = null;
          this.controller = null;
          this.channelTask = null;
        }
      });
    return this.currentStatus();
  }

  async stop(): Promise<BridgeStatus> {
    const bridge = this.bridge;
    const controller = this.controller;
    const task = this.channelTask;
    if (!bridge && !controller) {
      this.update(this.makeStatus('stopped', 'disconnected', 'disconnected', this.status.cwd));
      return this.currentStatus();
    }
    this.update(this.makeStatus('stopping', 'disconnected', 'connected', this.status.cwd));
    controller?.abort();
    if (task) await task.catch(() => undefined);
    await bridge?.stop();
    this.bridge = null;
    this.controller = null;
    this.channelTask = null;
    this.update(this.makeStatus('stopped', 'disconnected', 'disconnected', this.status.cwd));
    return this.currentStatus();
  }

  private fail(error: unknown, cwd = this.status.cwd): BridgeStatus {
    const message = error instanceof Error ? error.message : String(error);
    this.update({ ...this.makeStatus('error', 'error', 'error', cwd), lastError: message });
    return this.currentStatus();
  }

  private update(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(this.currentStatus());
  }

  private makeStatus(
    lifecycle: BridgeStatus['lifecycle'],
    weixin: BridgeStatus['weixin'],
    codex: BridgeStatus['codex'],
    cwd = resolve(this.options.defaultCwd),
  ): BridgeStatus {
    return { protocolVersion: IPC_VERSION, lifecycle, weixin, codex, cwd, updatedAt: new Date().toISOString() };
  }
}
