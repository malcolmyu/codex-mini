import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PendingTask, TaskSnapshot } from '../ipc/protocol.js';

export interface TaskScannerOptions {
  statePath?: string;
  historyPath?: string;
  now?: () => Date;
  limit?: number;
}

interface ThreadRow {
  id: string;
  title: string;
  cwd: string;
  project_id: string | null;
  project_name: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  updated_at: number;
  updated_at_ms: number | null;
}

interface TurnRow {
  turn_id: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

interface ItemRow {
  rollout_ordinal: number;
  item_type: string;
  item_json: string;
}

function timestampMs(row: ThreadRow): number {
  return row.updated_at_ms && row.updated_at_ms > 0 ? row.updated_at_ms : row.updated_at * 1_000;
}

function hasQuestions(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { questions?: unknown };
    return Array.isArray(parsed.questions) && parsed.questions.length > 0;
  } catch {
    return false;
  }
}

function compactTitle(value: string): string {
  const title = value.replace(/\s+/gu, ' ').trim() || '未命名 Codex 任务';
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function repositoryName(origin: string | null): string | undefined {
  if (!origin) return undefined;
  const normalized = origin.replace(/\/+$/u, '');
  const name = normalized.slice(Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(':')) + 1)
    .replace(/\.git$/u, '')
    .trim();
  return name || undefined;
}

export class CodexTaskScanner {
  constructor(private readonly options: TaskScannerOptions = {}) {}

  scan(): TaskSnapshot {
    const now = this.options.now?.() ?? new Date();
    const codexHome = homedir();
    const state = new DatabaseSync(this.options.statePath ?? join(codexHome, '.codex', 'state_5.sqlite'), { readOnly: true });
    const history = new DatabaseSync(this.options.historyPath ?? join(codexHome, '.codex', 'thread_history_1.sqlite'), { readOnly: true });
    try {
      const cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1_000;
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const threads = state.prepare(`
        SELECT threads.id, threads.title, threads.cwd, threads.project_id,
          projects.name AS project_name, threads.git_branch, threads.git_origin_url,
          threads.updated_at, threads.updated_at_ms
        FROM threads
        LEFT JOIN projects ON projects.id = threads.project_id
        WHERE threads.archived = 0
          AND threads.title NOT LIKE 'Automation:%'
          AND COALESCE(threads.updated_at_ms, threads.updated_at * 1000) >= ?
        ORDER BY COALESCE(threads.updated_at_ms, threads.updated_at * 1000) DESC
      `).all(cutoff) as unknown as ThreadRow[];
      const latestTurn = history.prepare(`
        SELECT turn_id, status, started_at, completed_at
        FROM thread_turns
        WHERE thread_id = ?
        ORDER BY rollout_ordinal DESC
        LIMIT 1
      `);
      const turnItems = history.prepare(`
        SELECT rollout_ordinal, item_type, item_json
        FROM thread_items
        WHERE thread_id = ? AND turn_id = ?
        ORDER BY rollout_ordinal ASC
      `);
      const candidates: PendingTask[] = [];
      for (const thread of threads) {
        const turn = latestTurn.get(thread.id) as unknown as TurnRow | undefined;
        if (!turn) continue;
        const updatedMs = timestampMs(thread);
        const ageMs = now.getTime() - updatedMs;
        if (turn.status === 'inProgress' && ageMs < 20 * 60 * 1_000) continue;
        const items = turnItems.all(thread.id, turn.turn_id) as unknown as ItemRow[];
        let lastUser = -1;
        let lastAgent = -1;
        let waitingForAnswer = false;
        for (const item of items) {
          if (item.item_type === 'userMessage') lastUser = item.rollout_ordinal;
          if (item.item_type === 'agentMessage') {
            lastAgent = item.rollout_ordinal;
            waitingForAnswer ||= hasQuestions(item.item_json);
          }
        }

        let score = 0;
        const reasons: string[] = [];
        if (turn.status === 'failed') { score += 50; reasons.push('上一轮执行失败'); }
        if (turn.status === 'interrupted') { score += 45; reasons.push('上一轮被中断'); }
        if (turn.status === 'inProgress') { score += 40; reasons.push('任务长时间未继续'); }
        if (waitingForAnswer) { score += 45; reasons.push('Codex 正在等待你的回答'); }
        if (lastUser > lastAgent) { score += 50; reasons.push('最后一条用户消息尚未得到回复'); }
        if (updatedMs >= startOfToday.getTime()) { score += 75; reasons.push('今天有更新'); }
        if (ageMs <= 7 * 24 * 60 * 60 * 1_000) score += 15;
        else score += 5;
        if (score < 45) continue;
        candidates.push({
          sessionId: thread.id,
          title: compactTitle(thread.title),
          cwd: thread.cwd,
          projectName: thread.project_name?.trim() || repositoryName(thread.git_origin_url),
          gitBranch: thread.git_branch?.trim() || undefined,
          updatedAt: new Date(updatedMs).toISOString(),
          status: turn.status,
          score,
          reasons,
        });
      }
      candidates.sort((left, right) => right.score - left.score
        || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      return {
        candidates: candidates.slice(0, this.options.limit ?? 20),
        scannedAt: now.toISOString(),
      };
    } finally {
      history.close();
      state.close();
    }
  }
}
