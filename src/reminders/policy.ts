import type { PendingTask, ReminderDecision, UsageSnapshot } from '../ipc/protocol.js';

export interface ReminderPolicyOptions {
  now?: Date;
  lastGlobalReminderAt?: string;
  deliveriesToday?: number;
}

function resetsWithin(resetsAt: number | null, nowSeconds: number, seconds: number): boolean {
  return resetsAt !== null && resetsAt >= nowSeconds && resetsAt - nowSeconds <= seconds;
}

export function evaluateReminder(
  usage: UsageSnapshot | undefined,
  tasks: PendingTask[],
  options: ReminderPolicyOptions = {},
): ReminderDecision {
  const now = options.now ?? new Date();
  const evaluatedAt = now.toISOString();
  if (!usage || usage.stale) return { eligible: false, reason: 'Codex 用量暂不可用', evaluatedAt };
  if (tasks.length === 0) return { eligible: false, reason: '没有达到提醒阈值的未完成任务', evaluatedAt };
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 8 * 60 + 30 || minutes > 22 * 60 + 30) {
    return { eligible: false, reason: '当前处于静默时段', evaluatedAt };
  }
  if (options.lastGlobalReminderAt
    && now.getTime() - Date.parse(options.lastGlobalReminderAt) < 8 * 60 * 60 * 1_000) {
    return { eligible: false, reason: '距离上次提醒不足 8 小时', evaluatedAt };
  }
  if ((options.deliveriesToday ?? 0) >= 2) {
    return { eligible: false, reason: '今天已经提醒两次', evaluatedAt };
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const primaryReady = Boolean(usage.primary
    && usage.primary.remainingPercent >= 40
    && resetsWithin(usage.primary.resetsAt, nowSeconds, 75 * 60));
  const secondaryReady = Boolean(usage.secondary
    && usage.secondary.remainingPercent >= 35
    && resetsWithin(usage.secondary.resetsAt, nowSeconds, 24 * 60 * 60));
  if (!primaryReady && !secondaryReady) {
    return { eligible: false, reason: '额度尚未进入提醒窗口', evaluatedAt };
  }
  return {
    eligible: true,
    reason: primaryReady ? '5 小时额度即将重置，仍有可继续任务' : '周额度即将重置，仍有可继续任务',
    evaluatedAt,
  };
}
