/**
 * Deterministic recoil.
 *
 * Every automatic weapon has a fixed spray pattern: a list of cumulative view
 * offsets, one per shot of a continuous spray. Shot k of a spray goes to
 * (view + pattern[k]) plus a small spread cone — the *same* place every time —
 * so pulling the mouse against the pattern is a skill that can be learned and
 * practised. There is no randomness in recoil itself.
 *
 * Patterns are authored as a few keyframes `[shot, right°, up°]` and expanded
 * by linear interpolation. Sign convention: +right moves the aim to the right,
 * +up moves it up. The simulation stores recoil as view punch in radians with
 * the engine's yaw convention (positive yaw turns LEFT), handled here.
 */

const DEG = Math.PI / 180;

export type PatternKey = readonly [shot: number, rightDeg: number, upDeg: number];

export interface RecoilOffset {
  /** Added to view yaw (radians, +left). */
  yaw: number;
  /** Added to view pitch (radians, +up). */
  pitch: number;
}

/** Expands keyframes into one cumulative offset per shot (index 0 = first shot). */
export function expandPattern(keys: readonly PatternKey[], shots: number): RecoilOffset[] {
  if (!keys.length) return Array.from({ length: shots }, () => ({ yaw: 0, pitch: 0 }));
  const sorted = [...keys].sort((a, b) => a[0] - b[0]);
  const out: RecoilOffset[] = [];
  for (let i = 0; i < shots; i++) {
    let a = sorted[0];
    let b = sorted[sorted.length - 1];
    for (let k = 0; k < sorted.length - 1; k++) {
      if (sorted[k][0] <= i && sorted[k + 1][0] >= i) {
        a = sorted[k];
        b = sorted[k + 1];
        break;
      }
    }
    if (i <= sorted[0][0]) b = a = sorted[0];
    if (i >= sorted[sorted.length - 1][0]) a = b = sorted[sorted.length - 1];
    const t = b[0] > a[0] ? (i - a[0]) / (b[0] - a[0]) : 0;
    const right = a[1] + (b[1] - a[1]) * t;
    const up = a[2] + (b[2] - a[2]) * t;
    out.push({ yaw: -right * DEG, pitch: up * DEG });
  }
  return out;
}

/**
 * Offset change to apply after firing shot `index` of a spray (so the NEXT
 * shot lands on pattern[index + 1]). Past the end of the pattern the aim holds.
 */
export function patternStep(pattern: readonly RecoilOffset[], index: number): RecoilOffset {
  if (!pattern.length) return { yaw: 0, pitch: 0 };
  const i = Math.max(0, Math.min(Math.floor(index), pattern.length - 1));
  const j = Math.min(i + 1, pattern.length - 1);
  return { yaw: pattern[j].yaw - pattern[i].yaw, pitch: pattern[j].pitch - pattern[i].pitch };
}
