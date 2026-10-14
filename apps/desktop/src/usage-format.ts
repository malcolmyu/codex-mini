export function formatCompactReset(resetsAt: number | null | undefined, nowMs = Date.now()): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '恢复时间未知';
  const remainingMinutes = Math.ceil((resetsAt * 1_000 - nowMs) / 60_000);
  if (remainingMinutes <= 0) return '即将恢复';
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours === 0) return `${minutes} 分钟后恢复`;
  return minutes === 0 ? `${hours} 小时后恢复` : `${hours} 小时 ${minutes} 分后恢复`;
}
