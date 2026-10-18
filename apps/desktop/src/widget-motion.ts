export const WIDGET_MOTION_DURATION_MS = 260;

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

