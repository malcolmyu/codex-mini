import { describe, expect, it } from 'vitest';
import { easeOutCubic, interpolateSize, WIDGET_MOTION_DURATION_MS } from '../apps/desktop/src/widget-motion.js';

describe('floating widget motion', () => {
  it('uses a brief non-zero transition', () => {
    expect(WIDGET_MOTION_DURATION_MS).toBeGreaterThanOrEqual(200);
    expect(WIDGET_MOTION_DURATION_MS).toBeLessThanOrEqual(350);
  });

  it('interpolates monotonically between expanded and compact sizes', () => {
    const from = { width: 360, height: 440 };
    const to = { width: 204, height: 80 };
    expect(interpolateSize(from, to, 0)).toEqual(from);
    const middle = interpolateSize(from, to, 0.5);
    expect(middle.width).toBeLessThan(from.width);
    expect(middle.width).toBeGreaterThan(to.width);
    expect(middle.height).toBeLessThan(from.height);
    expect(middle.height).toBeGreaterThan(to.height);
    expect(interpolateSize(from, to, 1)).toEqual(to);
  });

  it('clamps easing progress to avoid overshoot', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});
