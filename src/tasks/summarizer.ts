import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PendingTask } from '../ipc/protocol.js';
import { buildCodexUsageEnvironment, codexCommand } from '../usage/probe.js';

interface Analysis {
  sessionId: string;
  summary: string;
  recommendationReason: string;
  relevanceScore: number;
  worthContinuing: boolean;
}

interface AnalysisResponse {
  items: Analysis[];
}

interface CacheEntry extends Analysis {
  updatedAt: string;
}

interface SummaryCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface ConversationExcerpt {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  status: string;
  localReasons: string[];
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface CodexTaskSummarizerOptions {
  historyPath?: string;
  cachePath?: string;
  command?: string;
  model?: string;
  timeoutMs?: number;
  maxCandidates?: number;
  analyze?: (conversations: ConversationExcerpt[]) => Promise<AnalysisResponse>;
}

function messageText(itemType: string, itemJson: string): string | null {
  try {
    const value = JSON.parse(itemJson) as { text?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
    if (itemType === 'agentMessage' && typeof value.text === 'string') return value.text;
    if (itemType === 'userMessage' && Array.isArray(value.content)) {
      return value.content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text as string)
        .join('\n');
    }
  } catch {
    return null;
  }
  return null;
}

function compact(value: string, limit = 1_000): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function uniqueCandidates(tasks: PendingTask[], limit: number): PendingTask[] {
  const titles = new Set<string>();
  return tasks.filter((task) => {
    if (!task.title || task.title === '未命名 Codex 任务') return false;
    const key = task.title.toLocaleLowerCase().replace(/\W/gu, '').slice(0, 60);
    if (titles.has(key)) return false;
    titles.add(key);
    return true;
  }).slice(0, limit);
}

async function loadCache(path: string): Promise<SummaryCache> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SummaryCache;
    return parsed.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveCache(path: string, cache: SummaryCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export class CodexTaskSummarizer {
  constructor(private readonly options: CodexTaskSummarizerOptions = {}) {}

  async summarize(tasks: PendingTask[]): Promise<PendingTask[]> {
    const candidates = uniqueCandidates(tasks, this.options.maxCandidates ?? 8);
    if (candidates.length === 0) return [];
    const cachePath = this.options.cachePath ?? join(homedir(), '.codex', 'codex-wechat-summary-cache.json');
    const cache = await loadCache(cachePath);
    const missing = candidates.filter((task) => cache.entries[task.sessionId]?.updatedAt !== task.updatedAt);
    if (missing.length > 0) {
      const conversations = this.readExcerpts(missing);
      const response = await (this.options.analyze?.(conversations) ?? this.analyzeWithCodex(conversations));
      for (const item of response.items) {
        const task = missing.find((candidate) => candidate.sessionId === item.sessionId);
        if (!task) continue;
        cache.entries[item.sessionId] = {
          ...item,
          relevanceScore: Math.max(0, Math.min(100, Math.round(item.relevanceScore))),
          updatedAt: task.updatedAt,
        };
      }
      await saveCache(cachePath, cache);
    }

    return candidates
      .map((task) => ({ task, analysis: cache.entries[task.sessionId] }))
      .filter(({ analysis }) => analysis?.worthContinuing && analysis.relevanceScore >= 65)
      .sort((left, right) => right.analysis.relevanceScore - left.analysis.relevanceScore
        || right.task.score - left.task.score)
      .slice(0, 6)
      .map(({ task, analysis }) => ({
        ...task,
        summary: analysis.summary,
        recommendationReason: analysis.recommendationReason,
        relevanceScore: analysis.relevanceScore,
      }));
  }

  private readExcerpts(tasks: PendingTask[]): ConversationExcerpt[] {
    const historyPath = this.options.historyPath ?? join(homedir(), '.codex', 'thread_history_1.sqlite');
    const database = new DatabaseSync(historyPath, { readOnly: true });
    try {
      const statement = database.prepare(`
        SELECT item_type, item_json
        FROM thread_items
        WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage')
        ORDER BY rollout_ordinal DESC
        LIMIT 4
      `);
      return tasks.map((task) => {
        const rows = statement.all(task.sessionId) as unknown as Array<{ item_type: string; item_json: string }>;
        const messages = rows.reverse().flatMap((row) => {
          const text = messageText(row.item_type, row.item_json);
          if (!text) return [];
          return [{
            role: row.item_type === 'userMessage' ? 'user' as const : 'assistant' as const,
            text: compact(text),
          }];
        });
        return {
          sessionId: task.sessionId,
          title: task.title,
          cwd: task.cwd,
          updatedAt: task.updatedAt,
          status: task.status,
          localReasons: task.reasons,
          messages,
        };
      });
    } finally {
      database.close();
    }
  }

  private async analyzeWithCodex(conversations: ConversationExcerpt[]): Promise<AnalysisResponse> {
    if (conversations.length === 0) return { items: [] };
    const directory = await mkdtemp(join(tmpdir(), 'codex-wechat-summary-'));
    const schemaPath = join(directory, 'schema.json');
    const outputPath = join(directory, 'result.json');
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sessionId', 'summary', 'recommendationReason', 'relevanceScore', 'worthContinuing'],
            properties: {
              sessionId: { type: 'string' },
              summary: { type: 'string' },
              recommendationReason: { type: 'string' },
              relevanceScore: { type: 'integer', minimum: 0, maximum: 100 },
              worthContinuing: { type: 'boolean' },
            },
          },
        },
      },
    };
    await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    const prompt = [
      '你是 Codex 会话整理器。只分析给出的会话摘录，不调用工具，不继续执行原任务。',
      '请为每个会话写一句不超过 45 个汉字的现状摘要，并判断它现在是否值得用户继续关注。',
      '只有近期、目标具体、尚未真正解决且继续推进有明显价值的会话才给高分。',
      '已经基本回答、仅因技术状态被标记中断、陈旧、重复、宽泛探索或没有明确下一步的会话应低于 65 分。',
      'recommendationReason 用一句不超过 30 个汉字的话解释为什么值得继续或为什么不值得。',
      `当前时间：${new Date().toISOString()}`,
      `会话：${JSON.stringify(conversations)}`,
    ].join('\n');
    try {
      await new Promise<void>((resolve, reject) => {
        const command = this.options.command ?? codexCommand();
        const args = [
          'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
          '-s', 'read-only',
          ...(this.options.model ? ['-m', this.options.model] : []),
          '-c', 'model_reasoning_effort="low"', '--output-schema', schemaPath,
          '--output-last-message', outputPath, '--color', 'never', '-',
        ];
        const child = spawn(command, args, {
          cwd: process.cwd(),
          env: buildCodexUsageEnvironment(),
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('Codex 会话总结超时'));
        }, this.options.timeoutMs ?? 90_000);
        child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `Codex 会话总结失败（退出码 ${code}）`));
        });
        child.stdin.end(prompt);
      });
      if (!existsSync(outputPath)) throw new Error('Codex 未生成会话总结');
      return JSON.parse(await readFile(outputPath, 'utf8')) as AnalysisResponse;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
