import { join, resolve } from 'node:path';
import { CodexAcpClient } from './acp/codex-client.js';
import { Bridge } from './core/bridge.js';
import { StateStore } from './core/state-store.js';
import type { BridgeStatus, TaskSnapshot, UsageSnapshot, WeixinLoginStatus } from './ipc/protocol.js';
import { IPC_VERSION } from './ipc/protocol.js';
import { evaluateReminder } from './reminders/policy.js';
import { ReminderStore } from './reminders/store.js';
import { CodexTaskScanner } from './tasks/scanner.js';
import { CodexTaskSummarizer } from './tasks/summarizer.js';
import { CodexTaskWatcher } from './tasks/watcher.js';
import { CodexUsageProbe } from './usage/probe.js';
import { isStaleWeixinTokenError, WeixinApi } from './weixin/api.js';
import {
  loadCredentials,
  quarantineCredentials,
  saveCredentials,
  WeixinChannel,
} from './weixin/channel.js';

type StatusListener = (status: BridgeStatus) => void;
export const WEIXIN_LOGIN_POLL_INTERVAL_MS = 400;
export const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 30_000;
export const ACTIVE_USAGE_REFRESH_MIN_INTERVAL_MS = 10_000;

function canAnalyzeTasks(usage: UsageSnapshot | undefined): boolean {
  return Boolean(usage && !usage.stale && usage.primary && usage.primary.remainingPercent > 0);
}

export interface BridgeRuntimeOptions {
  projectRoot: string;
  defaultCwd: string;
  usageProbe?: CodexUsageProbe;
  taskScanner?: CodexTaskScanner;
  taskSummarizer?: CodexTaskSummarizer;
  taskWatcher?: CodexTaskWatcher;
  weixinApi?: WeixinApi;
  refreshIntervalMs?: number;
}

export class BridgeRuntime {
  private bridge: Bridge | null = null;
  private channel: WeixinChannel | null = null;
  private controller: AbortController | null = null;
  private channelTask: Promise<void> | null = null;
  private loginController: AbortController | null = null;
  private loginTask: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshTask: Promise<BridgeStatus> | null = null;
  private usageRefreshPending = false;
  private taskRefreshPending = false;
  private lastUsageRefreshStartedAt = 0;
  private readonly listeners = new Set<StatusListener>();
  private readonly usageProbe: CodexUsageProbe;
  private readonly taskScanner: CodexTaskScanner;
  private readonly taskSummarizer: CodexTaskSummarizer;
  private readonly taskWatcher: CodexTaskWatcher;
  private readonly weixinApi: WeixinApi;
  private readonly reminderStore: ReminderStore;
  private status: BridgeStatus;

  constructor(private readonly options: BridgeRuntimeOptions) {
    this.usageProbe = options.usageProbe ?? new CodexUsageProbe();
    this.taskScanner = options.taskScanner ?? new CodexTaskScanner();
    this.taskSummarizer = options.taskSummarizer ?? new CodexTaskSummarizer({
      cachePath: join(options.projectRoot, '.data', 'task-summary-cache.json'),
    });
    this.taskWatcher = options.taskWatcher ?? new CodexTaskWatcher();
    this.weixinApi = options.weixinApi ?? new WeixinApi();
    this.reminderStore = new ReminderStore(join(options.projectRoot, '.data', 'reminder-state.json'));
    this.status = this.makeStatus('stopped', 'disconnected', 'disconnected');
  }

  currentStatus(): BridgeStatus {
    return structuredClone(this.status);
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(cwd = this.options.defaultCwd): Promise<BridgeStatus> {
    if (['starting', 'running'].includes(this.status.lifecycle)) return this.currentStatus();
    const resolvedCwd = resolve(cwd);
    this.ensureRefreshTimer();
    this.ensureTaskWatcher();
    void this.refreshInsights();
    this.update({ ...this.status, ...this.connectionStatus('starting', 'connecting', 'connecting', resolvedCwd) });

    const dataDir = join(this.options.projectRoot, '.data');
    let credentials;
    try {
      credentials = await loadCredentials(join(dataDir, 'weixin-credentials.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.update({ ...this.status, ...this.connectionStatus('needs_login', 'needs_login', 'disconnected', resolvedCwd) });
        return this.currentStatus();
      }
      return this.fail(error, resolvedCwd);
    }

    const channel = new WeixinChannel(
      this.weixinApi,
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
    this.channel = channel;
    this.controller = controller;
    this.update({ ...this.status, ...this.connectionStatus('running', 'connected', 'connected', resolvedCwd) });
    this.channelTask = channel.run(async (message) => {
      const reminderReply = await this.reminderStore.resolveReply(message.conversationId, message.text);
      if (reminderReply?.kind === 'continue') {
        await bridge.accept({ ...message, text: `/use ${reminderReply.task.sessionId} ${reminderReply.task.cwd}` });
        return;
      }
      if (reminderReply) {
        const replies = {
          invalid: '这个序号不在最近一次提醒里，或提醒已经过期。',
          ignored: `以后不再提醒：${reminderReply.kind === 'ignored' ? reminderReply.task.title : ''}`,
          snoozed: `已暂停提醒 24 小时：${reminderReply.kind === 'snoozed' ? reminderReply.task.title : ''}`,
          resolved: `已标记解决：${reminderReply.kind === 'resolved' ? reminderReply.task.title : ''}`,
        } as const;
        await channel.send({ conversationId: message.conversationId, text: replies[reminderReply.kind], contextToken: message.contextToken });
        return;
      }
      await bridge.accept(message);
    }, controller.signal)
      .catch(async (error) => {
        if (controller.signal.aborted) return;
        if (isStaleWeixinTokenError(error)) {
          const credentialsPath = join(dataDir, 'weixin-credentials.json');
          try {
            await quarantineCredentials(credentialsPath);
            this.setLogin({
              state: 'error',
              updatedAt: new Date().toISOString(),
              error: '微信登录已过期，请重新扫码。',
            });
          } catch (quarantineError) {
            this.fail(new Error(
              `微信登录已过期，但旧凭据无法隔离：${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
            ), resolvedCwd);
          }
          return;
        }
        this.fail(error, resolvedCwd);
      })
      .finally(() => {
        if (this.controller === controller && !controller.signal.aborted) {
          this.bridge = null;
          this.channel = null;
          this.controller = null;
          this.channelTask = null;
        }
      });
    void this.refreshInsights();
    return this.currentStatus();
  }

  async stop(): Promise<BridgeStatus> {
    this.loginController?.abort();
    this.loginController = null;
    this.loginTask = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.taskWatcher.stop();
    const bridge = this.bridge;
    const controller = this.controller;
    const task = this.channelTask;
    if (!bridge && !controller) {
      this.update({ ...this.status, ...this.connectionStatus('stopped', 'disconnected', 'disconnected', this.status.cwd) });
      return this.currentStatus();
    }
    this.update({ ...this.status, ...this.connectionStatus('stopping', 'disconnected', 'connected', this.status.cwd) });
    controller?.abort();
    if (task) await task.catch(() => undefined);
    await bridge?.stop();
    this.bridge = null;
    this.channel = null;
    this.controller = null;
    this.channelTask = null;
    this.update({ ...this.status, ...this.connectionStatus('stopped', 'disconnected', 'disconnected', this.status.cwd) });
    return this.currentStatus();
  }

  refreshInsights(): Promise<BridgeStatus> {
    this.usageRefreshPending = true;
    this.taskRefreshPending = true;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.drainInsightRefreshes();
    return this.refreshTask;
  }

  refreshTasks(): Promise<BridgeStatus> {
    this.taskRefreshPending = true;
    if (Date.now() - this.lastUsageRefreshStartedAt >= ACTIVE_USAGE_REFRESH_MIN_INTERVAL_MS) {
      this.usageRefreshPending = true;
    }
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.drainInsightRefreshes();
    return this.refreshTask;
  }

  private async drainInsightRefreshes(): Promise<BridgeStatus> {
    let status = this.currentStatus();
    try {
      while (this.usageRefreshPending || this.taskRefreshPending) {
        const includeUsage = this.usageRefreshPending;
        this.usageRefreshPending = false;
        this.taskRefreshPending = false;
        status = await this.performRefreshInsights(includeUsage);
      }
      return status;
    } finally {
      this.refreshTask = null;
    }
  }

  private async performRefreshInsights(includeUsage: boolean): Promise<BridgeStatus> {
    let usage: UsageSnapshot | undefined = this.status.usage;
    if (includeUsage) {
      this.lastUsageRefreshStartedAt = Date.now();
      try {
        usage = await this.usageProbe.read();
      } catch (error) {
        usage = {
          ...(usage ?? { primary: null, secondary: null, planType: null, updatedAt: new Date().toISOString() }),
          stale: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    let tasks: TaskSnapshot;
    try {
      tasks = this.taskScanner.scan();
      if (tasks.candidates.length > 0) {
        const scannedAt = tasks.scannedAt;
        tasks = {
          ...tasks,
          candidates: await this.taskSummarizer.summarize(tasks.candidates, {
            allowAnalysis: canAnalyzeTasks(usage),
            onAnalyzeStart: () => this.update({
              ...this.status,
              usage,
              tasks: {
                candidates: this.status.tasks?.candidates ?? [],
                scannedAt,
                analyzing: true,
              },
              updatedAt: new Date().toISOString(),
            }),
          }),
          analyzing: false,
        };
      }
    } catch (error) {
      tasks = {
        candidates: [],
        scannedAt: new Date().toISOString(),
        analyzing: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const candidatesForReminder = await this.reminderStore.filter(
      tasks.candidates.filter((task) => task.reminderEligible !== false),
    );
    const context = await this.reminderStore.deliveryContext();
    let reminder = evaluateReminder(usage, candidatesForReminder, context);
    if (reminder.eligible && this.channel && this.status.weixin === 'connected') {
      const selected = candidatesForReminder.slice(0, 3);
      const text = [
        `Codex 还有额度可用，${reminder.reason}：`,
        '',
        ...selected.map(
          (task, index) =>
            `${index + 1}. ${task.projectName ? `[${task.projectName}] ` : ''}${task.summary ?? task.title}\n   ${task.recommendationReason ?? task.reasons.join('、')}`,
        ),
        '',
        '回复序号继续任务，例如：1',
        '也可以回复：稍后 1 / 已解决 1 / 忽略 1',
      ].join('\n');
      try {
        await this.channel.send({ conversationId: this.channel.credentials.ownerUserId, text });
        await this.reminderStore.recordDelivery(this.channel.credentials.ownerUserId, selected);
        reminder = { eligible: false, reason: '本轮提醒已发送到微信', evaluatedAt: new Date().toISOString() };
      } catch (error) {
        reminder = {
          eligible: false,
          reason: `微信提醒发送失败：${error instanceof Error ? error.message : String(error)}`,
          evaluatedAt: new Date().toISOString(),
        };
      }
    } else if (reminder.eligible && !this.channel) {
      reminder = { ...reminder, reason: '发现可继续任务，连接微信后发送提醒' };
    }
    this.update({ ...this.status, usage, tasks, reminder, updatedAt: new Date().toISOString() });
    return this.currentStatus();
  }

  async startWeixinLogin(): Promise<BridgeStatus> {
    if (this.loginTask) return this.currentStatus();
    if (this.bridge || this.controller) await this.stopConnectionOnly();
    const controller = new AbortController();
    this.loginController = controller;
    this.setLogin({ state: 'starting', updatedAt: new Date().toISOString() });
    try {
      const login = await this.weixinApi.beginLogin(controller.signal);
      this.setLogin({ state: 'waiting_scan', qrCodeUrl: login.qrcodeUrl, updatedAt: new Date().toISOString() });
      this.loginTask = this.pollWeixinLogin(login.qrcode, controller);
    } catch (error) {
      this.setLogin({
        state: 'error',
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.loginController = null;
    }
    return this.currentStatus();
  }

  private async pollWeixinLogin(qrcode: string, controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        let response;
        try {
          response = await this.weixinApi.pollLogin(qrcode, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === 'TimeoutError') continue;
          throw error;
        }
        const state = String(response.status ?? 'waiting_scan');
        const credentials = this.weixinApi.credentialsFromLogin(response);
        if (credentials) {
          await saveCredentials(join(this.options.projectRoot, '.data', 'weixin-credentials.json'), credentials);
          this.setLogin({ state: 'confirmed', updatedAt: new Date().toISOString() });
          this.status = { ...this.status, ...this.connectionStatus('stopped', 'disconnected', 'disconnected', this.status.cwd) };
          await this.start(this.status.cwd);
          return;
        }
        if (state === 'scanned') {
          this.setLogin({ ...this.status.weixinLogin!, state: 'scanned', updatedAt: new Date().toISOString() });
        }
        if (['expired', 'binded_redirect'].includes(state)) {
          this.setLogin({ state: 'expired', updatedAt: new Date().toISOString() });
          return;
        }
        if (['need_verifycode', 'verify_code_blocked'].includes(state)) {
          throw new Error('本次登录需要验证码，请重新生成二维码');
        }
        await new Promise((done) => setTimeout(done, WEIXIN_LOGIN_POLL_INTERVAL_MS));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.setLogin({
          state: 'error',
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.loginController === controller) this.loginController = null;
      this.loginTask = null;
    }
  }

  private async stopConnectionOnly(): Promise<void> {
    const bridge = this.bridge;
    const controller = this.controller;
    const task = this.channelTask;
    controller?.abort();
    if (task) await task.catch(() => undefined);
    await bridge?.stop();
    this.bridge = null;
    this.channel = null;
    this.controller = null;
    this.channelTask = null;
    this.update({ ...this.status, ...this.connectionStatus('needs_login', 'needs_login', 'disconnected', this.status.cwd) });
  }

  private ensureRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(
      () => { void this.refreshInsights(); },
      this.options.refreshIntervalMs ?? DEFAULT_USAGE_REFRESH_INTERVAL_MS,
    );
    this.refreshTimer.unref();
  }

  private ensureTaskWatcher(): void {
    this.taskWatcher.start(() => { void this.refreshTasks(); });
  }

  private fail(error: unknown, cwd = this.status.cwd): BridgeStatus {
    const message = error instanceof Error ? error.message : String(error);
    this.update({ ...this.status, ...this.connectionStatus('error', 'error', 'error', cwd), lastError: message });
    return this.currentStatus();
  }

  private setLogin(weixinLogin: WeixinLoginStatus): void {
    const needsLogin = ['starting', 'waiting_scan', 'scanned', 'expired', 'error'].includes(weixinLogin.state);
    this.update({
      ...this.status,
      weixinLogin,
      ...(needsLogin ? this.connectionStatus('needs_login', 'needs_login', 'disconnected', this.status.cwd) : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  private update(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(this.currentStatus());
  }

  private connectionStatus(
    lifecycle: BridgeStatus['lifecycle'],
    weixin: BridgeStatus['weixin'],
    codex: BridgeStatus['codex'],
    cwd = resolve(this.options.defaultCwd),
  ): Pick<BridgeStatus, 'protocolVersion' | 'lifecycle' | 'weixin' | 'codex' | 'cwd' | 'updatedAt'> {
    return { protocolVersion: IPC_VERSION, lifecycle, weixin, codex, cwd, updatedAt: new Date().toISOString() };
  }

  private makeStatus(
    lifecycle: BridgeStatus['lifecycle'],
    weixin: BridgeStatus['weixin'],
    codex: BridgeStatus['codex'],
    cwd = resolve(this.options.defaultCwd),
  ): BridgeStatus {
    return {
      ...this.connectionStatus(lifecycle, weixin, codex, cwd),
      weixinLogin: { state: 'idle', updatedAt: new Date().toISOString() },
    };
  }
}
