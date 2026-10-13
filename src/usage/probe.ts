import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { UsageSnapshot, UsageWindow } from '../ipc/protocol.js';

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: unknown };
}

interface RawWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RawRateLimits {
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  planType?: unknown;
}

export interface UsageProbeOptions {
  command?: string;
  timeoutMs?: number;
  now?: () => Date;
}

function codexCommand(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const local = join(homedir(), '.local', 'bin', 'codex');
  return existsSync(local) ? local : 'codex';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeWindow(value: RawWindow | null | undefined): UsageWindow | null {
  const usedPercent = numberOrNull(value?.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins: numberOrNull(value?.windowDurationMins),
    resetsAt: numberOrNull(value?.resetsAt),
  };
}

export function normalizeUsageResponse(value: unknown, now = new Date()): UsageSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Codex returned an invalid usage response');
  const payload = value as { rateLimits?: RawRateLimits; rateLimitsByLimitId?: Record<string, RawRateLimits> | null };
  const limits = payload.rateLimitsByLimitId?.codex ?? payload.rateLimits;
  if (!limits) throw new Error('Codex usage response did not include rate limits');
  return {
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
    planType: typeof limits.planType === 'string' ? limits.planType : null,
    updatedAt: now.toISOString(),
    stale: false,
  };
}

export class CodexUsageProbe {
  constructor(private readonly options: UsageProbeOptions = {}) {}

  async read(): Promise<UsageSnapshot> {
    const child = spawn(this.options.command ?? codexCommand(), ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await this.rpc(child, 1, 'initialize', {
        clientInfo: { name: 'codex-wechat-bridge', title: 'Codex WeChat Bridge', version: '0.2.0' },
        capabilities: null,
      });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const result = await this.rpc(child, 2, 'account/rateLimits/read');
      return normalizeUsageResponse(result, this.options.now?.() ?? new Date());
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }

  private rpc(
    child: ChildProcessWithoutNullStreams,
    id: number,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), this.options.timeoutMs ?? 10_000);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let stderr = '';
      const onStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); };
      const onExit = () => finish(new Error(stderr.trim() || `Codex app-server exited during ${method}`));
      const onLine = (line: string) => {
        let message: RpcResponse;
        try { message = JSON.parse(line) as RpcResponse; } catch { return; }
        if (message.id !== id) return;
        if (message.error) finish(new Error(String(message.error.message ?? `Codex ${method} failed`)));
        else finish(undefined, message.result);
      };
      const finish = (error?: Error, result?: unknown) => {
        clearTimeout(timeout);
        lines.off('line', onLine);
        lines.close();
        child.stderr.off('data', onStderr);
        child.off('exit', onExit);
        if (error) reject(error); else resolve(result);
      };
      lines.on('line', onLine);
      child.stderr.on('data', onStderr);
      child.once('exit', onExit);
      child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }
}
