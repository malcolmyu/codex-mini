import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, MessageChannel, OutgoingMessage } from '../core/types.js';
import { extractWeixinText, WeixinApi, type WeixinCredentials } from './api.js';

interface RuntimeState {
  cursor: string;
  seen: string[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function saveCredentials(path: string, credentials: WeixinCredentials): Promise<void> {
  await writePrivateJson(path, credentials);
}

export async function quarantineCredentials(path: string, now = new Date()): Promise<string | null> {
  const suffix = now.toISOString().replace(/[:.]/g, '-');
  const quarantinePath = `${path}.stale-${suffix}`;
  try {
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadCredentials(path: string): Promise<WeixinCredentials> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid Weixin credentials');
  const candidate = value as Partial<WeixinCredentials>;
  if (![candidate.token, candidate.botId, candidate.ownerUserId, candidate.baseUrl]
    .every((field) => typeof field === 'string' && field.length > 0)) {
    throw new Error('Incomplete Weixin credentials');
  }
  return candidate as WeixinCredentials;
}

export class WeixinChannel implements MessageChannel {
  private readonly contexts = new Map<string, string>();
  private running = false;

  constructor(
    private readonly api: WeixinApi,
    readonly credentials: WeixinCredentials,
    private readonly runtimeStatePath: string,
  ) {}

  async send(message: OutgoingMessage): Promise<void> {
    const contextToken = message.contextToken ?? this.contexts.get(message.conversationId);
    await this.api.sendText(this.credentials, message.conversationId, message.text, contextToken);
  }

  async run(onMessage: (message: IncomingMessage) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error('Weixin channel is already running');
    this.running = true;
    const tasks = new Set<Promise<void>>();
    const state = await this.readRuntimeState();
    const seen = new Set(state.seen);
    try {
      await this.api.notifyStart(this.credentials, signal);
      while (!signal?.aborted) {
        let response: Record<string, unknown>;
        try {
          response = await this.api.getUpdates(this.credentials, state.cursor, signal);
        } catch (error) {
          if (signal?.aborted) break;
          if ((error as Error).name === 'TimeoutError') continue;
          throw error;
        }
        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const raw of messages) {
          if (!raw || typeof raw !== 'object') continue;
          const message = raw as Record<string, unknown>;
          if (message.message_type === 2) continue;
          const senderId = stringValue(message.from_user_id);
          const text = extractWeixinText(message);
          const messageId = stringValue(message.message_id) ?? stringValue(message.client_id)
            ?? `${String(message.seq ?? '')}:${senderId ?? ''}`;
          if (!senderId || !text || seen.has(messageId)) continue;
          seen.add(messageId);
          while (seen.size > 1_000) seen.delete(seen.values().next().value!);
          const contextToken = stringValue(message.context_token);
          if (contextToken) this.contexts.set(senderId, contextToken);
          let task: Promise<void>;
          task = onMessage({
            conversationId: senderId,
            senderId,
            text,
            contextToken,
            messageId,
          }).catch((error) => {
            console.error('Weixin message handling failed:', error);
          }).finally(() => tasks.delete(task));
          tasks.add(task);
        }
        const cursor = stringValue(response.get_updates_buf);
        if (cursor) state.cursor = cursor;
        state.seen = [...seen];
        await writePrivateJson(this.runtimeStatePath, state);
      }
    } finally {
      this.running = false;
      await Promise.allSettled([...tasks]);
      await this.api.notifyStop(this.credentials).catch(() => undefined);
    }
  }

  private async readRuntimeState(): Promise<RuntimeState> {
    try {
      const value = JSON.parse(await readFile(this.runtimeStatePath, 'utf8')) as Partial<RuntimeState>;
      return {
        cursor: typeof value.cursor === 'string' ? value.cursor : '',
        seen: Array.isArray(value.seen) ? value.seen.filter((item): item is string => typeof item === 'string') : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cursor: '', seen: [] };
      throw error;
    }
  }
}
