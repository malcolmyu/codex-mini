import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingTask, UsageSnapshot } from '../src/ipc/protocol.js';
import { BridgeRuntime, WEIXIN_LOGIN_POLL_INTERVAL_MS } from '../src/runtime.js';
import { CodexTaskScanner } from '../src/tasks/scanner.js';
import { CodexTaskSummarizer } from '../src/tasks/summarizer.js';
import { CodexUsageProbe } from '../src/usage/probe.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function usage(): UsageSnapshot {
  return {
    primary: null,
    secondary: null,
    planType: 'plus',
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}

function exhaustedUsage(): UsageSnapshot {
  return {
    primary: {
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    },
    secondary: null,
    planType: 'plus',
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}

function reminderReadyUsage(): UsageSnapshot {
  return {
    primary: {
      usedPercent: 45,
      remainingPercent: 55,
      windowDurationMins: 300,
      resetsAt: Math.floor(Date.now() / 1_000) + 60 * 60,
    },
    secondary: null,
    planType: 'plus',
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}

describe('BridgeRuntime insight refresh', () => {
  it('polls QR login status without a one-second delay', () => {
    expect(WEIXIN_LOGIN_POLL_INTERVAL_MS).toBe(400);
  });

  it('runs one task-only follow-up when a database change arrives during a usage refresh', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codex-runtime-refresh-'));
    directories.push(projectRoot);
    const usageProbe = new CodexUsageProbe();
    const taskScanner = new CodexTaskScanner();
    let releaseFirst: ((snapshot: UsageSnapshot) => void) | undefined;
    const firstUsage = new Promise<UsageSnapshot>((resolve) => { releaseFirst = resolve; });
    const read = vi.spyOn(usageProbe, 'read')
      .mockImplementationOnce(() => firstUsage)
      .mockResolvedValue(usage());
    const scan = vi.spyOn(taskScanner, 'scan').mockReturnValue({
      candidates: [],
      scannedAt: new Date().toISOString(),
    });
    const runtime = new BridgeRuntime({
      projectRoot,
      defaultCwd: projectRoot,
      usageProbe,
      taskScanner,
    });

    const firstRefresh = runtime.refreshInsights();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const queuedRefresh = runtime.refreshTasks();
    releaseFirst?.(usage());
    await Promise.all([firstRefresh, queuedRefresh]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not enter the analyzing state when the five-hour quota is exhausted', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codex-runtime-refresh-'));
    directories.push(projectRoot);
    const usageProbe = new CodexUsageProbe();
    vi.spyOn(usageProbe, 'read').mockResolvedValue(exhaustedUsage());
    const task: PendingTask = {
      sessionId: 'thread-local-12345678901234567890',
      title: '今天完成的独立讨论',
      cwd: projectRoot,
      updatedAt: '2026-10-15T12:00:00.000Z',
      status: 'completed',
      score: 90,
      reasons: ['今天有更新'],
    };
    const taskScanner = new CodexTaskScanner();
    vi.spyOn(taskScanner, 'scan').mockReturnValue({
      candidates: [task],
      scannedAt: '2026-10-15T13:00:00.000Z',
    });
    const taskSummarizer = new CodexTaskSummarizer();
    const summarize = vi.spyOn(taskSummarizer, 'summarize').mockResolvedValue([task]);
    const runtime = new BridgeRuntime({
      projectRoot,
      defaultCwd: projectRoot,
      usageProbe,
      taskScanner,
      taskSummarizer,
    });
    const updates: boolean[] = [];
    runtime.onStatus((status) => updates.push(Boolean(status.tasks?.analyzing)));

    await runtime.refreshInsights();

    expect(summarize).toHaveBeenCalledWith([task], expect.objectContaining({ allowAnalysis: false }));
    expect(updates).not.toContain(true);
    expect(runtime.currentStatus().tasks?.candidates).toEqual([task]);
  });

  it('does not use display-only alternatives for WeChat reminders', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codex-runtime-refresh-'));
    directories.push(projectRoot);
    const usageProbe = new CodexUsageProbe();
    vi.spyOn(usageProbe, 'read').mockResolvedValue(reminderReadyUsage());
    const task: PendingTask = {
      sessionId: 'thread-display-only-1234567890123456',
      title: '今天的独立讨论',
      cwd: projectRoot,
      updatedAt: new Date().toISOString(),
      status: 'completed',
      score: 90,
      reasons: ['今天有更新'],
      reminderEligible: false,
    };
    const taskScanner = new CodexTaskScanner();
    vi.spyOn(taskScanner, 'scan').mockReturnValue({ candidates: [task], scannedAt: new Date().toISOString() });
    const taskSummarizer = new CodexTaskSummarizer();
    vi.spyOn(taskSummarizer, 'summarize').mockResolvedValue([task]);
    const runtime = new BridgeRuntime({
      projectRoot,
      defaultCwd: projectRoot,
      usageProbe,
      taskScanner,
      taskSummarizer,
    });

    await runtime.refreshInsights();

    expect(runtime.currentStatus().tasks?.candidates).toEqual([task]);
    expect(runtime.currentStatus().reminder).toMatchObject({
      eligible: false,
      reason: '没有达到提醒阈值的未完成任务',
    });
  });
});
