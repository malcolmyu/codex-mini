export function splitText(text: string, maxChars = 1_800): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive integer');
  const remaining = text.trim();
  if (!remaining) return [];

  const chunks: string[] = [];
  let rest = remaining;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const boundary = Math.max(newline, space);
    const cut = boundary >= Math.floor(maxChars * 0.6) ? boundary : maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function visibleError(error: unknown): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { reason?: string } }).data;
    if (data?.reason === 'thread_active_writer') {
      return '这个任务正在 Codex 桌面端、CLI 或其他客户端中使用。请先在那里关闭任务，或在微信里发送 /new。';
    }
  }
  return error instanceof Error ? error.message : String(error);
}
