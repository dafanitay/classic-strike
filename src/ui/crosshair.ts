import { CROSSHAIR_COLORS, type CrosshairSettings } from '../settings';

/**
 * Crosshair geometry, shared by the in-game HUD and the settings preview so
 * both always draw exactly the same thing. Pure: no DOM, unit-testable.
 * Rects are in CSS pixels relative to the screen centre.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CrosshairLayout {
  lines: Rect[]; // top, bottom, left, right
  dot: Rect | null;
  color: string;
  outline: boolean;
}

/**
 * @param spreadPx extra gap from current weapon inaccuracy (only applied when
 *                 the crosshair is dynamic).
 */
export function crosshairLayout(c: CrosshairSettings, spreadPx = 0): CrosshairLayout {
  const t = c.thickness;
  const half = t / 2;
  const gap = Math.round(c.gap + (c.dynamic ? Math.max(0, spreadPx) : 0));
  const len = c.size;
  const lines: Rect[] =
    len > 0
      ? [
          { x: -half, y: -gap - len, w: t, h: len }, // top
          { x: -half, y: gap, w: t, h: len }, // bottom
          { x: -gap - len, y: -half, w: len, h: t }, // left
          { x: gap, y: -half, w: len, h: t }, // right
        ]
      : [];
  return {
    lines,
    dot: c.dot ? { x: -half, y: -half, w: t, h: t } : null,
    color: CROSSHAIR_COLORS[c.color],
    outline: c.outline,
  };
}

/** Converts a weapon cone (radians) into on-screen pixels for a vertical FOV. */
export function spreadToPixels(spread: number, verticalFovRad: number, viewportHeight: number): number {
  return (Math.tan(spread) / Math.tan(verticalFovRad / 2)) * (viewportHeight / 2);
}
