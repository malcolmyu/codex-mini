import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingTask } from '../src/ipc/protocol.js';
import { CodexTaskSummarizer, recencyWeight } from '../src/tasks/summarizer.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex task summarizer', () => {
  it('gives recent conversations a bounded ranking weight', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    expect(recencyWeight('2026-10-16T00:00:00.000Z', now)).toBe(30);
    expect(recencyWeight('2026-10-14T12:00:00.000Z', now)).toBe(18);
    expect(recencyWeight('2026-10-10T12:00:00.000Z', now)).toBe(8);
    expect(recencyWeight('2026-10-01T12:00:00.000Z', now)).toBe(0);
  });

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
    expect(await summarizer.summarize([{ ...task, updatedAt: '2026-10-14T01:01:00.000Z' }])).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('re-summarizes immediately when the conversation excerpt changes', async () => {
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
    const insert = database.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(
      'thread-changing-12345678901234567890', 'turn-1', 'item-1', 1,
      JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: '先分析登录问题' }] }),
      'userMessage',
    );
    database.close();

    const task: PendingTask = {
      sessionId: 'thread-changing-12345678901234567890',
      title: '分析登录问题',
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
      analyze: async () => {
        calls += 1;
        return {
          items: [{
            sessionId: task.sessionId,
            summary: calls === 1 ? '初次摘要' : '更新后的摘要',
            recommendationReason: '目标尚未完成',
            relevanceScore: 88,
            worthContinuing: true,
          }],
        };
      },
    });

    expect((await summarizer.summarize([task]))[0]?.summary).toBe('初次摘要');
    const changedDatabase = new DatabaseSync(historyPath);
    changedDatabase.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)').run(
      task.sessionId, 'turn-2', 'item-2', 2,
      JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: '登录已完成，继续检查扫码' }] }),
      'userMessage',
    );
    changedDatabase.close();
    const changedTask = { ...task, updatedAt: '2026-10-14T01:01:00.000Z' };

    expect((await summarizer.summarize([changedTask]))[0]?.summary).toBe('更新后的摘要');
    expect(calls).toBe(2);
  });

  it('limits the default Codex summary batch to eight conversations', async () => {
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
    database.close();
    const tasks = Array.from({ length: 9 }, (_, index): PendingTask => ({
      sessionId: `thread-${index}-12345678901234567890`,
      title: `待处理任务 ${index}`,
      cwd: directory,
      updatedAt: '2026-10-14T01:00:00.000Z',
      status: 'interrupted',
      score: 100 - index,
      reasons: ['上一轮被中断'],
    }));
    let analyzed = 0;
    const summarizer = new CodexTaskSummarizer({
      historyPath,
      cachePath: join(directory, 'cache.json'),
      analyze: async (conversations) => {
        analyzed = conversations.length;
        return {
          items: conversations.map((conversation) => ({
            sessionId: conversation.sessionId,
            summary: conversation.title,
            recommendationReason: '尚未完成',
            relevanceScore: 80,
            worthContinuing: true,
          })),
        };
      },
    });

    expect(await summarizer.summarize(tasks)).toHaveLength(8);
    expect(analyzed).toBe(8);
  });

  it('keeps a recent independent conversation as a display-only alternative', async () => {
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
    const tasks: PendingTask[] = [
      {
        sessionId: 'thread-project-12345678901234567890', title: '旧项目未完成', cwd: directory,
        projectName: 'project', updatedAt: '2026-10-08T12:00:00.000Z', status: 'interrupted',
        score: 100, reasons: ['上一轮被中断'],
      },
      {
        sessionId: 'thread-independent-1234567890123456', title: '今天的独立讨论', cwd: directory,
        updatedAt: '2026-10-16T08:00:00.000Z', status: 'completed', score: 90, reasons: ['今天有更新'],
      },
    ];
    const summarizer = new CodexTaskSummarizer({
      historyPath,
      cachePath: join(directory, 'cache.json'),
      now: () => new Date('2026-10-16T12:00:00.000Z'),
      analyze: async (conversations) => ({
        items: conversations.map((conversation) => conversation.sessionId === tasks[0]?.sessionId ? {
          sessionId: conversation.sessionId,
          summary: '项目仍需收尾',
          recommendationReason: '尚未完成',
          relevanceScore: 80,
          worthContinuing: true,
        } : {
          sessionId: conversation.sessionId,
          summary: '今天讨论过的新方向',
          recommendationReason: '最近更新，可换一换查看',
          relevanceScore: 24,
          worthContinuing: false,
        }),
      }),
    });

    const result = await summarizer.summarize(tasks);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      sessionId: tasks[1]?.sessionId,
      reminderEligible: false,
    });
    expect(result[1]?.projectName).toBeUndefined();
  });

  it('uses local candidates without calling Codex when analysis is disabled', async () => {
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
    database.close();
    const task: PendingTask = {
      sessionId: 'thread-local-12345678901234567890',
      title: '今天完成的独立讨论',
      cwd: directory,
      updatedAt: '2026-10-15T12:00:00.000Z',
      status: 'completed',
      score: 90,
      reasons: ['今天有更新'],
    };
    let calls = 0;
    const summarizer = new CodexTaskSummarizer({
      historyPath,
      cachePath: join(directory, 'cache.json'),
      analyze: async () => {
        calls += 1;
        return { items: [] };
      },
    });

    const result = await summarizer.summarize([task], { allowAnalysis: false });

    expect(calls).toBe(0);
    expect(result).toEqual([{ ...task, reminderEligible: false }]);
  });
});
