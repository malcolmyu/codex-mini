import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATABASE_PREFIXES = ['state_5.sqlite', 'thread_history_1.sqlite'];

export function isCodexThreadDatabaseFile(filename: string | null): boolean {
  if (!filename) return false;
  return DATABASE_PREFIXES.some((prefix) => filename === prefix || filename.startsWith(`${prefix}-`));
}

export interface CodexTaskWatcherOptions {
  codexDir?: string;
  debounceMs?: number;
}

export class CodexTaskWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CodexTaskWatcherOptions = {}) {}

  start(onChange: () => void): boolean {
    if (this.watcher) return true;
    try {
      this.watcher = watch(
        this.options.codexDir ?? join(homedir(), '.codex'),
        { persistent: false },
        (_event, filename) => {
          const name = filename?.toString() ?? null;
          if (!isCodexThreadDatabaseFile(name)) return;
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            onChange();
          }, this.options.debounceMs ?? 2_000);
          this.debounceTimer.unref();
        },
      );
      this.watcher.on('error', () => this.stop());
      return true;
    } catch {
      this.watcher = null;
      return false;
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
