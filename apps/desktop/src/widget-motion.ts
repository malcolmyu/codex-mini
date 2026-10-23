export const WIDGET_MOTION_DURATION_MS = 300;
export const EXPANDED_WIDGET_MIN_HEIGHT = 440;
export const COMPACT_ORB_SIZE = 72;
export const ORB_CHROME_INSET = 12;
export const COMPACT_WIDGET_SIZE = COMPACT_ORB_SIZE + ORB_CHROME_INSET * 2;
export const ORB_COLLAPSE_DELAY_MS = 180;
export const ORB_DRAG_THRESHOLD_PX = 4;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OrbHorizontalExpand = 'left' | 'right';
export type OrbVerticalExpand = 'up' | 'down';

export interface OrbExpandDirection {
  horizontal: OrbHorizontalExpand;
  vertical: OrbVerticalExpand;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function collapsedWidgetBounds(orb: { x: number; y: number }): Rect {
  return {
    x: orb.x - ORB_CHROME_INSET,
    y: orb.y - ORB_CHROME_INSET,
    width: COMPACT_WIDGET_SIZE,
    height: COMPACT_WIDGET_SIZE,
  };
}

export function orbExpansionDirection(
  orb: { x: number; y: number },
  workArea: Rect,
  panel: { width: number; height: number },
): OrbExpandDirection {
  return {
    horizontal: orb.x + COMPACT_ORB_SIZE / 2 - workArea.x > workArea.width / 2 ? 'left' : 'right',
    vertical: orb.y - workArea.y < panel.height - COMPACT_ORB_SIZE ? 'down' : 'up',
  };
}

export function expandedWidgetBounds(
  orb: { x: number; y: number },
  workArea: Rect,
  panel: { width: number; height: number },
): Rect & OrbExpandDirection {
  const direction = orbExpansionDirection(orb, workArea, panel);
  const width = panel.width + ORB_CHROME_INSET * 2;
  const height = panel.height + ORB_CHROME_INSET * 2;
  const rawX = direction.horizontal === 'left'
    ? orb.x - (panel.width - COMPACT_ORB_SIZE) - ORB_CHROME_INSET
    : orb.x - ORB_CHROME_INSET;
  const rawY = direction.vertical === 'up'
    ? orb.y - (panel.height - COMPACT_ORB_SIZE) - ORB_CHROME_INSET
    : orb.y - ORB_CHROME_INSET;
  return {
    x: clamp(rawX, workArea.x - ORB_CHROME_INSET, workArea.x + workArea.width - width + ORB_CHROME_INSET),
    y: clamp(rawY, workArea.y - ORB_CHROME_INSET, workArea.y + workArea.height - height + ORB_CHROME_INSET),
    width,
    height,
    ...direction,
  };
}

export function orbOriginFromWindow(
  bounds: Rect,
  direction: OrbExpandDirection,
): { x: number; y: number } {
  return {
    x: direction.horizontal === 'left'
      ? bounds.x + bounds.width - ORB_CHROME_INSET - COMPACT_ORB_SIZE
      : bounds.x + ORB_CHROME_INSET,
    y: direction.vertical === 'up'
      ? bounds.y + bounds.height - ORB_CHROME_INSET - COMPACT_ORB_SIZE
      : bounds.y + ORB_CHROME_INSET,
  };
}

export function exceedsDragThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > ORB_DRAG_THRESHOLD_PX;
}

export function orbDragOrigin(
  grabOffset: { x: number; y: number },
  pointer: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: pointer.x - grabOffset.x,
    y: pointer.y - grabOffset.y,
  };
}

export function fitExpandedWidgetHeight(contentHeight: number, availableHeight: number): number {
  return Math.min(Math.max(contentHeight, EXPANDED_WIDGET_MIN_HEIGHT), availableHeight);
}

export function easeOutCubic(progress: number): number {
  const bounded = Math.min(1, Math.max(0, progress));
  return 1 - (1 - bounded) ** 3;
}

export function interpolateSize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  progress: number,
): { width: number; height: number } {
  const eased = easeOutCubic(progress);
  return {
    width: from.width + (to.width - from.width) * eased,
    height: from.height + (to.height - from.height) * eased,
  };
}
