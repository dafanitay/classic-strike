import { describe, expect, it } from 'vitest';
import { MAX_VOICES, PROFILES, admit, attenuation, listenerAxes, relativeAzimuth, type SoundKind } from './spatial';

describe('spatial audio: distance', () => {
  it('every kind is full volume up close, fades smoothly and monotonically, and is silent beyond its range', () => {
    for (const [kind, p] of Object.entries(PROFILES)) {
      expect(attenuation(p, 0.5), kind).toBe(1);
      expect(attenuation(p, p.ref), kind).toBe(1);
      let prev = 1;
      for (let d = p.ref; d <= p.max + 5; d += 0.05) {
        const g = attenuation(p, d);
        expect(g, `${kind} at ${d} m`).toBeLessThanOrEqual(prev + 1e-12);
        // Continuous (no jumps): 5 cm never changes the gain by more than 5% of full scale.
        expect(prev - g, `${kind} step at ${d} m`).toBeLessThan(0.05);
        prev = g;
      }
      expect(attenuation(p, p.max)).toBe(0);
      expect(attenuation(p, p.max + 1)).toBe(0);
    }
  });

  it('footsteps are a close-range cue: clear nearby, faint at 25 m, gone past 32 m; gunfire carries much further', () => {
    const f = PROFILES.footstep;
    expect(attenuation(f, 4)).toBeGreaterThan(0.4);
    expect(attenuation(f, 12)).toBeGreaterThan(0.1);
    expect(attenuation(f, 25)).toBeLessThan(0.06);
    expect(attenuation(f, 33)).toBe(0);
    for (const d of [10, 30, 60]) expect(attenuation(PROFILES.gunshot, d)).toBeGreaterThan(attenuation(f, d));
    expect(attenuation(PROFILES.gunshot, 60)).toBeGreaterThan(0.05);
  });
});

describe('spatial audio: direction (game yaw convention)', () => {
  const L = { x: 0, y: 0, z: 0 };
  const deg = (r: number) => Math.round((r * 180) / Math.PI);
  it('front, left, right and behind come out where they are', () => {
    // yaw 0 faces -Z; +X is to the right.
    expect(Math.abs(deg(relativeAzimuth(L, 0, { x: 0, y: 0, z: -5 })))).toBe(0);
    expect(deg(relativeAzimuth(L, 0, { x: -5, y: 0, z: 0 }))).toBe(90); // left
    expect(deg(relativeAzimuth(L, 0, { x: 5, y: 0, z: 0 }))).toBe(-90); // right
    expect(Math.abs(deg(relativeAzimuth(L, 0, { x: 0, y: 0, z: 5 })))).toBe(180); // behind
  });

  it('turning around swaps left and right for a source that stays put', () => {
    const src = { x: -5, y: 0, z: 0 };
    expect(relativeAzimuth(L, 0, src)).toBeGreaterThan(0); // left
    expect(relativeAzimuth(L, Math.PI, src)).toBeLessThan(0); // now on the right
    expect(Math.abs(relativeAzimuth(L, Math.PI / 2, src))).toBeLessThan(1e-9); // turned to face it
  });

  it('the Web Audio listener faces where the camera faces', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -2]) {
      const { forward } = listenerAxes(yaw);
      // A source along "forward" is straight ahead by the game's own convention.
      expect(Math.abs(relativeAzimuth(L, yaw, { x: forward.x * 10, y: 0, z: forward.z * 10 }))).toBeLessThan(1e-9);
    }
  });
});

describe('spatial audio: voice limit', () => {
  it('drops footsteps first, keeps gunfire longer, and always lets an explosion through', () => {
    const kinds: SoundKind[] = ['footstep', 'gunshot', 'explosion'];
    expect(kinds.every((k) => admit(k, 0))).toBe(true);
    expect(admit('footstep', Math.ceil(MAX_VOICES * 0.7))).toBe(false);
    expect(admit('gunshot', Math.ceil(MAX_VOICES * 0.7))).toBe(true);
    expect(admit('gunshot', MAX_VOICES)).toBe(false);
    expect(admit('explosion', MAX_VOICES + 10)).toBe(true);
  });
});
