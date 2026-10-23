// Short enough to remain legible inside the 52px orb centre.
export function formatOrbReset(resetsAt: number | null | undefined, nowMs = Date.now()): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '—';
  const total = Math.ceil((resetsAt * 1_000 - nowMs) / 60_000);
  if (total <= 0) return '即将恢复';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
  }
  if (!hours) return `${minutes}min`;
  return `${hours}h${minutes ? `${minutes}min` : ''}`;
}

export function formatCompactReset(resetsAt: number | null | undefined, nowMs = Date.now()): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '恢复时间未知';
  const remainingMinutes = Math.ceil((resetsAt * 1_000 - nowMs) / 60_000);
  if (remainingMinutes <= 0) return '即将恢复';
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours === 0) return `${minutes} 分钟后恢复`;
  return minutes === 0 ? `${hours} 小时后恢复` : `${hours} 小时 ${minutes} 分后恢复`;
}
