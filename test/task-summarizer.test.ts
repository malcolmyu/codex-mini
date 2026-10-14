import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingTask } from '../src/ipc/protocol.js';
import { CodexTaskSummarizer } from '../src/tasks/summarizer.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('Codex task summarizer', () => {
  it('uses Codex analysis, filters low-value work and caches unchanged sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
    directories.push(directory);
    const historyPath = join(directory, 'history.sqlite');
    const database = new DatabaseSync(historyPath);
    database.exec(`
      CREATE TABLE thread_items (
        thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
        item_json TEXT, item_type TEXT
      )
    `);
    database.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)').run(
      'thread-valuable-12345678901234567890', 'turn-1', 'item-1', 1,
      JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: '把剩余的登录流程做完' }] }),
      'userMessage',
    );
    database.close();

    const task: PendingTask = {
      sessionId: 'thread-valuable-12345678901234567890',
      title: '完成登录流程',
      cwd: directory,
      updatedAt: '2026-10-14T01:00:00.000Z',
      status: 'interrupted',
      score: 100,
      reasons: ['上一轮被中断'],
    };
    let calls = 0;
    const summarizer = new CodexTaskSummarizer({
      historyPath,
      cachePath: join(directory, 'cache.json'),
      analyze: async (conversations) => {
        calls += 1;
        expect(conversations[0]?.messages[0]?.text).toContain('登录流程');
        return {
          items: [{
            sessionId: task.sessionId,
            summary: '登录流程只差最后的确认步骤',
            recommendationReason: '目标具体且尚未完成',
            relevanceScore: 88,
            worthContinuing: true,
          }],
        };
      },
    });

    expect(await summarizer.summarize([task])).toMatchObject([{
      summary: '登录流程只差最后的确认步骤',
      relevanceScore: 88,
    }]);
    expect(await summarizer.summarize([task])).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
