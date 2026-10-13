import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTaskScanner } from '../src/tasks/scanner.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('CodexTaskScanner', () => {
  it('scores unfinished metadata and excludes active or archived tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-task-scanner-'));
    directories.push(directory);
    const statePath = join(directory, 'state.sqlite');
    const historyPath = join(directory, 'history.sqlite');
    const state = new DatabaseSync(statePath);
    state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER)');
    const now = new Date('2026-10-12T12:00:00.000Z');
    const recent = now.getTime() - 60 * 60 * 1_000;
    const insertThread = state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)');
    insertThread.run('failed', '修复失败任务', '/work/a', Math.floor(recent / 1_000), recent, 0);
    insertThread.run('interrupted', '继续中断任务', '/work/b', Math.floor(recent / 1_000), recent, 0);
    insertThread.run('question', '回答设计问题', '/work/c', Math.floor(recent / 1_000), recent, 0);
    const activeAt = now.getTime() - 10 * 60 * 1_000;
    insertThread.run('active', '正在执行', '/work/d', Math.floor(activeAt / 1_000), activeAt, 0);
    insertThread.run('archived', '已归档', '/work/e', Math.floor(recent / 1_000), recent, 1);
    state.close();

    const history = new DatabaseSync(historyPath);
    history.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER)');
    history.exec('CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)');
    const insertTurn = history.prepare('INSERT INTO thread_turns VALUES (?, ?, 1, ?, ?, ?)');
    insertTurn.run('failed', 'turn-f', 'failed', 1, 2);
    insertTurn.run('interrupted', 'turn-i', 'interrupted', 1, 2);
    insertTurn.run('question', 'turn-q', 'completed', 1, 2);
    insertTurn.run('active', 'turn-a', 'inProgress', 1, null);
    insertTurn.run('archived', 'turn-r', 'failed', 1, 2);
    history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)')
      .run('question', 'turn-q', 1, 'agentMessage', JSON.stringify({ questions: ['继续使用哪种方案？'] }));
    history.close();

    const result = new CodexTaskScanner({ statePath, historyPath, now: () => now }).scan();
    expect(result.candidates.map((task) => task.sessionId)).toEqual(['failed', 'interrupted', 'question']);
    expect(result.candidates[0].score).toBe(65);
    expect(result.candidates[2].reasons).toContain('Codex 正在等待你的回答');
  });
});
