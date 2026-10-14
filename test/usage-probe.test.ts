import { describe, expect, it } from 'vitest';
import { buildCodexUsageEnvironment, normalizeUsageResponse, normalizeWindow } from '../src/usage/probe.js';

describe('Codex usage normalization', () => {
  it('converts used quota into remaining quota', () => {
    expect(normalizeWindow({ usedPercent: 62, windowDurationMins: 300, resetsAt: 1_800_000_000 })).toEqual({
      usedPercent: 62,
      remainingPercent: 38,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    });
  });

  it('prefers the codex bucket and timestamps the snapshot', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    const result = normalizeUsageResponse({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
          planType: 'plus',
        },
      },
    }, now);
    expect(result.primary?.remainingPercent).toBe(75);
    expect(result.secondary?.remainingPercent).toBe(90);
    expect(result.updatedAt).toBe(now.toISOString());
  });

  it('isolates the usage probe from host Codex credentials', () => {
    expect(buildCodexUsageEnvironment({
      CODEX_HOME: '/tmp/host-codex',
      CODEX_API_KEY: 'host-api-key',
      CODEX_ACCESS_TOKEN: 'host-access-token',
      OPENAI_API_KEY: 'host-openai-key',
      PATH: '/usr/bin',
    }, '/Users/tester')).toEqual({
      CODEX_HOME: '/Users/tester/.codex',
      PATH: '/usr/bin',
    });
  });
});
