import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingTask, UsageSnapshot } from '../src/ipc/protocol.js';
import { evaluateReminder } from '../src/reminders/policy.js';
import { ReminderStore } from '../src/reminders/store.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const task: PendingTask = {
  sessionId: 'thread-1',
  title: '继续完成桌面端',
  cwd: '/work/project',
  updatedAt: '2026-10-12T01:00:00.000Z',
  status: 'interrupted',
  score: 60,
  reasons: ['上一轮被中断'],
};

function usage(now: Date, primaryRemaining: number): UsageSnapshot {
  return {
    primary: {
      usedPercent: 100 - primaryRemaining,
      remainingPercent: primaryRemaining,
      windowDurationMins: 300,
      resetsAt: Math.floor(now.getTime() / 1_000) + 60 * 60,
    },
    secondary: null,
    planType: 'plus',
    updatedAt: now.toISOString(),
    stale: false,
  };
}

describe('reminder policy and snapshot', () => {
  it('requires enough remaining quota close to reset', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    expect(evaluateReminder(usage(now, 50), [task], { now }).eligible).toBe(true);
    expect(evaluateReminder(usage(now, 39), [task], { now }).eligible).toBe(false);
  });

  it('maps a reply number and persists task decisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-reminder-'));
    directories.push(directory);
    const store = new ReminderStore(join(directory, 'state.json'));
    const now = new Date('2026-10-12T12:00:00.000Z');
    await store.recordDelivery('owner', [task], now);
    expect(await store.resolveReply('owner', '1', now)).toMatchObject({ kind: 'continue', task: { sessionId: 'thread-1' } });
    expect(await store.resolveReply('owner', '已解决 1', now)).toMatchObject({ kind: 'resolved' });
    expect(await store.filter([task], now)).toEqual([]);
  });
});
