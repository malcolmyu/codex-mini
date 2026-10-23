import { describe, expect, it } from 'vitest';
import {
  collapsedWidgetBounds,
  COMPACT_ORB_SIZE,
  COMPACT_WIDGET_SIZE,
  easeOutCubic,
  expandedWidgetBounds,
  exceedsDragThreshold,
  fitExpandedWidgetHeight,
  interpolateSize,
  orbDragOrigin,
  orbOriginFromWindow,
  ORB_CHROME_INSET,
  ORB_COLLAPSE_DELAY_MS,
  WIDGET_MOTION_DURATION_MS,
} from '../apps/desktop/src/widget-motion.js';

describe('floating widget motion', () => {
  it('reserves a small square window around the compact orb halo', () => {
    expect(COMPACT_ORB_SIZE).toBe(72);
    expect(ORB_CHROME_INSET).toBe(12);
    expect(COMPACT_WIDGET_SIZE).toBe(96);
    expect(COMPACT_WIDGET_SIZE - COMPACT_ORB_SIZE).toBe(ORB_CHROME_INSET * 2);
  });

  it('matches the dsh orb expand and collapse timing', () => {
    expect(WIDGET_MOTION_DURATION_MS).toBe(300);
    expect(ORB_COLLAPSE_DELAY_MS).toBe(180);
  });

  it('keeps the orb origin fixed while expanding toward available space', () => {
    const orb = { x: 1644, y: 800 };
    const workArea = { x: 0, y: 0, width: 1728, height: 1117 };
    const panel = { width: 360, height: 440 };
    const expanded = expandedWidgetBounds(orb, workArea, panel);

    expect(expanded).toEqual({
      x: 1344,
      y: 420,
      width: 384,
      height: 464,
      horizontal: 'left',
      vertical: 'up',
    });
    expect(orbOriginFromWindow(expanded, expanded)).toEqual(orb);
    expect(collapsedWidgetBounds(orb)).toEqual({ x: 1632, y: 788, width: 96, height: 96 });
  });

  it('distinguishes a click from an intentional orb drag', () => {
    expect(exceedsDragThreshold({ x: 20, y: 20 }, { x: 22, y: 22 })).toBe(false);
    expect(exceedsDragThreshold({ x: 20, y: 20 }, { x: 25, y: 20 })).toBe(true);
  });

  it('keeps the grabbed point under the pointer while dragging', () => {
    expect(orbDragOrigin({ x: 31, y: 28 }, { x: 920, y: 610 })).toEqual({
      x: 889,
      y: 582,
    });
  });

  it('uses a brief non-zero transition', () => {
    expect(WIDGET_MOTION_DURATION_MS).toBeGreaterThanOrEqual(200);
    expect(WIDGET_MOTION_DURATION_MS).toBeLessThanOrEqual(350);
  });

  it('interpolates monotonically between expanded and compact sizes', () => {
    const from = { width: 384, height: 464 };
    const to = { width: COMPACT_WIDGET_SIZE, height: COMPACT_WIDGET_SIZE };
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

  it('grows the expanded window to fit dynamic content without exceeding the screen', () => {
    expect(fitExpandedWidgetHeight(410, 900)).toBe(440);
    expect(fitExpandedWidgetHeight(478, 900)).toBe(478);
    expect(fitExpandedWidgetHeight(720, 600)).toBe(600);
  });
});
