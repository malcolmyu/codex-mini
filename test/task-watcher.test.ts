import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTaskWatcher, isCodexThreadDatabaseFile } from '../src/tasks/watcher.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('Codex task database watcher', () => {
  it('recognizes the state, history, WAL and shared-memory files', () => {
    expect(isCodexThreadDatabaseFile('state_5.sqlite')).toBe(true);
    expect(isCodexThreadDatabaseFile('state_5.sqlite-wal')).toBe(true);
    expect(isCodexThreadDatabaseFile('thread_history_1.sqlite-shm')).toBe(true);
    expect(isCodexThreadDatabaseFile('config.toml')).toBe(false);
    expect(isCodexThreadDatabaseFile(null)).toBe(false);
  });

  it('debounces real Codex database writes and ignores unrelated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-task-watcher-'));
    directories.push(directory);
    const database = join(directory, 'state_5.sqlite-wal');
    const unrelated = join(directory, 'config.toml');
    await writeFile(database, 'initial');
    await writeFile(unrelated, 'initial');
    const watcher = new CodexTaskWatcher({ codexDir: directory, debounceMs: 100 });
    let changes = 0;
    let resolveChange: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => { resolveChange = resolve; });

    expect(watcher.start(() => {
      changes += 1;
      resolveChange?.();
    })).toBe(true);
    await Promise.all([appendFile(database, 'one'), appendFile(database, 'two')]);
    await Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('watcher did not fire')), 2_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes).toBe(1);

    await appendFile(unrelated, 'ignored');
    await new Promise((resolve) => setTimeout(resolve, 150));
    watcher.stop();

    expect(changes).toBe(1);
  });
});
