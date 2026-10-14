import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '../src/ipc/protocol.js';
import { BridgeRuntime } from '../src/runtime.js';
import { CodexTaskScanner } from '../src/tasks/scanner.js';
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

describe('BridgeRuntime insight refresh', () => {
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
});
