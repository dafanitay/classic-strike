import type { Vec3 } from '../shared/vec';

/**
 * Pure spatial-audio rules (no Web Audio here, so they're unit-testable).
 *
 * Distances are metres (1 world unit = 1 m; a player is 1.83 m tall, Depot
 * is 80 m x 60 m, its longest sightline ~50 m). Each kind of sound has its
 * own reach: footsteps are a close-range cue (clear within a few metres,
 * gone beyond ~32 m — about the hearing range of a normal bot), gunfire
 * carries across the map, a reload is only heard up close.
 *
 * The curve is 1 inside `ref`, then falls as (ref/d)^rolloff and fades
 * smoothly to exactly 0 at `max` (no sudden cut-off).
 */
export type SoundKind = 'footstep' | 'land' | 'gunshot' | 'knife' | 'reload' | 'death' | 'bomb' | 'explosion' | 'action';

export interface Profile {
  ref: number;
  max: number;
  rolloff: number;
  /** Gain multiplier and low-pass cut-off when a wall is in the way. */
  occludedGain: number;
  occludedCutoff: number;
  /** Lower = dropped first when too many sounds play at once. */
  priority: number;
}

export const PROFILES: Record<SoundKind, Profile> = {
  footstep: { ref: 2, max: 32, rolloff: 1.15, occludedGain: 0.5, occludedCutoff: 900, priority: 1 },
  land: { ref: 2, max: 28, rolloff: 1.15, occludedGain: 0.5, occludedCutoff: 900, priority: 1 },
  reload: { ref: 1.5, max: 16, rolloff: 1.2, occludedGain: 0.45, occludedCutoff: 900, priority: 1 },
  knife: { ref: 1.5, max: 18, rolloff: 1.2, occludedGain: 0.45, occludedCutoff: 900, priority: 2 },
  action: { ref: 2, max: 22, rolloff: 1.1, occludedGain: 0.5, occludedCutoff: 1000, priority: 2 },
  death: { ref: 3, max: 40, rolloff: 1, occludedGain: 0.55, occludedCutoff: 1100, priority: 2 },
  bomb: { ref: 3, max: 55, rolloff: 0.9, occludedGain: 0.6, occludedCutoff: 1400, priority: 3 },
  gunshot: { ref: 5, max: 160, rolloff: 0.85, occludedGain: 0.6, occludedCutoff: 1500, priority: 3 },
  explosion: { ref: 10, max: 250, rolloff: 0.7, occludedGain: 0.7, occludedCutoff: 900, priority: 4 },
};

/** Gain (0..1) for a source `d` metres away. */
export function attenuation(p: Profile, d: number): number {
  if (d <= p.ref) return 1;
  if (d >= p.max) return 0;
  const g = Math.pow(p.ref / d, p.rolloff);
  // Smooth fade over the last 35% of the range so it reaches 0 at max.
  const fadeStart = p.max * 0.65;
  if (d <= fadeStart) return g;
  const t = (d - fadeStart) / (p.max - fadeStart);
  const s = 1 - t * t * (3 - 2 * t); // smoothstep 1 -> 0
  return g * s;
}

/**
 * Where a source is relative to the listener's facing, in radians:
 * 0 = straight ahead, +PI/2 = to the left, -PI/2 = to the right, ±PI behind.
 * Uses the game's yaw convention (yaw 0 faces -Z, yaw grows to the left).
 */
export function relativeAzimuth(listener: Vec3, yaw: number, src: Vec3): number {
  const toSrc = Math.atan2(-(src.x - listener.x), -(src.z - listener.z));
  let a = toSrc - yaw;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** The listener's forward and up vectors for the Web Audio listener (right-handed, like Three.js). */
export function listenerAxes(yaw: number): { forward: Vec3; up: Vec3 } {
  return { forward: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) }, up: { x: 0, y: 1, z: 0 } };
}

/** Maximum simultaneous positional sounds; lower-priority kinds are dropped first. */
export const MAX_VOICES = 40;

/** Should a new sound of `kind` play when `active` voices are already playing? */
export function admit(kind: SoundKind, active: number): boolean {
  if (active < MAX_VOICES * 0.6) return true;
  if (active >= MAX_VOICES) return PROFILES[kind].priority >= 4;
  return PROFILES[kind].priority >= 2;
}
