import { describe, expect, it } from 'vitest';
import { formatCompactReset, formatOrbReset, isQuotaUrgent } from '../apps/desktop/src/usage-format.js';

describe('compact usage reset copy', () => {
  const now = 1_800_000_000_000;

  it.each([
    [null, '—'], [NaN, '—'], [0, '即将恢复'],
    [1, '1min'], [42, '42min'], [60, '1h'], [105, '1h45min'],
    [299, '4h59min'], [1440, '1d'], [1500, '1d1h'],
  ])('keeps the orb countdown compact for %s minutes', (minutes, expected) => {
    const resetsAt = minutes === null ? null : (now + minutes * 60_000) / 1_000;
    expect(formatOrbReset(resetsAt, now)).toBe(expected);
  });

  it('rounds a partial minute up without showing zero minutes', () => {
    expect(formatOrbReset((now + 1_000) / 1_000, now)).toBe('1min');
  });

  it('handles missing and elapsed reset times', () => {
    expect(formatCompactReset(null, now)).toBe('恢复时间未知');
    expect(formatCompactReset(now / 1_000, now)).toBe('即将恢复');
  });

  it('formats minute and hour countdowns', () => {
    expect(formatCompactReset((now + 42 * 60_000) / 1_000, now)).toBe('42 分钟后恢复');
    expect(formatCompactReset((now + (2 * 60 + 8) * 60_000) / 1_000, now)).toBe('2 小时 8 分后恢复');
  });

  it('marks quota urgent at the inclusive reset and remaining boundaries', () => {
    expect(isQuotaUrgent({
      remainingPercent: 40,
      resetsAt: (now + 30 * 60_000) / 1_000,
    }, now)).toBe(true);
  });

  it('does not mark quota urgent outside either boundary', () => {
    expect(isQuotaUrgent({
      remainingPercent: 39,
      resetsAt: (now + 30 * 60_000) / 1_000,
    }, now)).toBe(false);
    expect(isQuotaUrgent({
      remainingPercent: 80,
      resetsAt: (now + 31 * 60_000) / 1_000,
    }, now)).toBe(false);
  });

  it('does not mark elapsed or missing quota windows urgent', () => {
    expect(isQuotaUrgent({ remainingPercent: 80, resetsAt: now / 1_000 }, now)).toBe(false);
    expect(isQuotaUrgent(undefined, now)).toBe(false);
  });
});
