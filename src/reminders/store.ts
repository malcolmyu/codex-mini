import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PendingTask } from '../ipc/protocol.js';

export type TaskOverride = 'resolved' | 'never_remind';

interface ReminderSnapshot {
  conversationId: string;
  createdAt: string;
  expiresAt: string;
  tasks: PendingTask[];
}

interface ReminderState {
  lastGlobalReminderAt?: string;
  deliveriesByDay: Record<string, number>;
  lastTaskReminderAt: Record<string, string>;
  snapshots: ReminderSnapshot[];
  overrides: Record<string, { state?: TaskOverride; snoozedUntil?: string }>;
}

const EMPTY: ReminderState = {
  deliveriesByDay: {},
  lastTaskReminderAt: {},
  snapshots: [],
  overrides: {},
};

export type ReminderReply =
  | { kind: 'continue'; task: PendingTask }
  | { kind: 'ignored' | 'snoozed' | 'resolved'; task: PendingTask }
  | { kind: 'invalid' }
  | null;

export class ReminderStore {
  constructor(private readonly path: string) {}

  async deliveryContext(now = new Date()): Promise<{ lastGlobalReminderAt?: string; deliveriesToday: number }> {
    const state = await this.read();
    return {
      lastGlobalReminderAt: state.lastGlobalReminderAt,
      deliveriesToday: state.deliveriesByDay[now.toISOString().slice(0, 10)] ?? 0,
    };
  }

  async filter(tasks: PendingTask[], now = new Date()): Promise<PendingTask[]> {
    const state = await this.read();
    return tasks.filter((task) => {
      const override = state.overrides[task.sessionId];
      if (override?.state === 'resolved' || override?.state === 'never_remind') return false;
      if (override?.snoozedUntil && Date.parse(override.snoozedUntil) > now.getTime()) return false;
      const last = state.lastTaskReminderAt[task.sessionId];
      return !last || now.getTime() - Date.parse(last) >= 48 * 60 * 60 * 1_000;
    });
  }

  async recordDelivery(conversationId: string, tasks: PendingTask[], now = new Date()): Promise<void> {
    const state = await this.read();
    const createdAt = now.toISOString();
    const day = createdAt.slice(0, 10);
    state.lastGlobalReminderAt = createdAt;
    state.deliveriesByDay[day] = (state.deliveriesByDay[day] ?? 0) + 1;
    for (const task of tasks) state.lastTaskReminderAt[task.sessionId] = createdAt;
    state.snapshots = state.snapshots
      .filter((snapshot) => Date.parse(snapshot.expiresAt) > now.getTime())
      .concat({
        conversationId,
        createdAt,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        tasks: tasks.slice(0, 3),
      });
    await this.write(state);
  }

  async resolveReply(conversationId: string, text: string, now = new Date()): Promise<ReminderReply> {
    const match = /^(?:(\/continue)|忽略|稍后|已解决)?\s*(\d+)$/iu.exec(text.trim());
    if (!match) return null;
    const state = await this.read();
    const snapshot = [...state.snapshots].reverse().find((candidate) => (
      candidate.conversationId === conversationId && Date.parse(candidate.expiresAt) > now.getTime()
    ));
    const task = snapshot?.tasks[Number(match[2]) - 1];
    if (!task) return { kind: 'invalid' };
    if (/^忽略/iu.test(text)) {
      state.overrides[task.sessionId] = { state: 'never_remind' };
      await this.write(state);
      return { kind: 'ignored', task };
    }
    if (/^稍后/iu.test(text)) {
      state.overrides[task.sessionId] = { snoozedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString() };
      await this.write(state);
      return { kind: 'snoozed', task };
    }
    if (/^已解决/iu.test(text)) {
      state.overrides[task.sessionId] = { state: 'resolved' };
      await this.write(state);
      return { kind: 'resolved', task };
    }
    return { kind: 'continue', task };
  }

  private async read(): Promise<ReminderState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ReminderState>;
      return {
        lastGlobalReminderAt: value.lastGlobalReminderAt,
        deliveriesByDay: value.deliveriesByDay ?? {},
        lastTaskReminderAt: value.lastTaskReminderAt ?? {},
        snapshots: value.snapshots ?? [],
        overrides: value.overrides ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
  }

  private async write(state: ReminderState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
