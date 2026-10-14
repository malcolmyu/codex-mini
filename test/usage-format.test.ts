import { describe, expect, it } from 'vitest';
import { formatCompactReset } from '../apps/desktop/src/usage-format.js';

describe('compact usage reset copy', () => {
  const now = 1_800_000_000_000;

  it('handles missing and elapsed reset times', () => {
    expect(formatCompactReset(null, now)).toBe('恢复时间未知');
    expect(formatCompactReset(now / 1_000, now)).toBe('即将恢复');
  });

  it('formats minute and hour countdowns', () => {
    expect(formatCompactReset((now + 42 * 60_000) / 1_000, now)).toBe('42 分钟后恢复');
    expect(formatCompactReset((now + (2 * 60 + 8) * 60_000) / 1_000, now)).toBe('2 小时 8 分后恢复');
  });
});
