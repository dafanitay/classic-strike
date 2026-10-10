import { describe, expect, it } from 'vitest';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { expandPattern } from './recoil';
import { Simulation, TICK_DT, emptyCmd, sprayPattern, type SimPlayer } from './sim';
import { anglesFromDir, angleDiff } from './vec';
import { WEAPONS, type WeaponId } from './weapons';

const DEG = Math.PI / 180;
const AIM_YAW = -Math.PI / 2; // facing +X down Long A

function rig(seed: number, id: WeaponId) {
  const sim = new Simulation(buildMap(DEPOT), { freezeTime: 0.05 }, seed);
  const p = sim.addPlayer('shooter', 'A', false);
  sim.addPlayer('other', 'D', false);
  for (let i = 0; i < 10; i++) sim.tick();
  const c = sim.map.cellCenter(5, 3);
  p.body.pos = { x: c.x, y: 0, z: c.z };
  p.body.vel = { x: 0, y: 0, z: 0 };
  const slot = WEAPONS[id].slot;
  p.weapons[slot] = { id, mag: WEAPONS[id].magSize, reserve: 0 }; // one magazine, no auto-reload
  sim.selectSlot(p, slot, true);
  p.switchEnd = 0;
  p.fireHeld = false;
  return { sim, p };
}

/** Fires for `ticks` ticks with the given aim; returns each shot's angular error from the aim (radians). */
function fire(sim: Simulation, p: SimPlayer, ticks: number, aim: (shotIndex: number) => { yaw: number; pitch: number }, trigger: (t: number) => boolean = () => true) {
  const shots: { dYaw: number; dPitch: number; punch: [number, number] }[] = [];
  let n = 0;
  for (let t = 0; t < ticks; t++) {
    const a = aim(n);
    sim.setCmd(p, { ...emptyCmd(a.yaw, a.pitch), fire: trigger(t) });
    sim.events.length = 0;
    sim.tick();
    for (const e of sim.events) {
      if (e.type !== 'shot') continue;
      const d = anglesFromDir({ x: e.end.x - e.origin.x, y: e.end.y - e.origin.y, z: e.end.z - e.origin.z });
      shots.push({ dYaw: angleDiff(d.yaw, AIM_YAW), dPitch: d.pitch, punch: [p.punchYaw, p.punchPitch] });
      n++;
    }
  }
  return shots;
}

describe('recoil', () => {
  it('is deterministic: a spray follows the same pattern regardless of RNG seed', () => {
    const runs = [1, 2, 3].map((seed) => {
      const { sim, p } = rig(seed, 'ar7');
      return fire(sim, p, 400, () => ({ yaw: AIM_YAW, pitch: 0 })).map((s) => s.punch);
    });
    expect(runs[0]).toHaveLength(30);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it('the first shot from a standstill lands within the base spread', () => {
    for (const id of ['ar7', 'k4', 'mk5', 'p9'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const { sim, p } = rig(seed, id);
        const [first] = fire(sim, p, 1, () => ({ yaw: AIM_YAW, pitch: 0 }));
        expect(Math.hypot(first.dYaw, first.dPitch)).toBeLessThanOrEqual(WEAPONS[id].spreadBase + 1e-9);
      }
    }
  });

  it('is learnable: pulling down along the published pattern keeps a full spray tight', () => {
    for (const id of ['ar7', 'k4', 'mk5'] as const) {
      const pattern = sprayPattern(WEAPONS[id]);
      const { sim, p } = rig(7, id);
      // A "player" who has memorised the pattern counter-aims by it — using
      // only published data, not the hidden live state.
      const shots = fire(sim, p, 400, (k) => ({ yaw: AIM_YAW - pattern[Math.min(k, pattern.length - 1)].yaw, pitch: -pattern[Math.min(k, pattern.length - 1)].pitch }));
      expect(shots).toHaveLength(WEAPONS[id].magSize);
      const worst = Math.max(...shots.map((s) => Math.hypot(s.dYaw, s.dPitch)));
      // Only the spread cone + bloom remains.
      expect(worst).toBeLessThanOrEqual(WEAPONS[id].spreadBase + WEAPONS[id].spreadMax + 1e-9);
    }
  });

  it('without compensation a rifle spray climbs by the pattern (≈8° for the AR-7)', () => {
    const { sim, p } = rig(3, 'ar7');
    const shots = fire(sim, p, 400, () => ({ yaw: AIM_YAW, pitch: 0 }));
    const last = shots[shots.length - 1];
    expect(last.dPitch).toBeGreaterThan(7 * DEG);
  });

  it('recovers fully after a short pause, so taps stay accurate', () => {
    const { sim, p } = rig(4, 'ar7');
    fire(sim, p, 60, () => ({ yaw: AIM_YAW, pitch: 0 })); // ~10-shot burst
    expect(p.punchPitch).toBeGreaterThan(3 * DEG);
    fire(sim, p, Math.ceil(1.0 / TICK_DT), () => ({ yaw: AIM_YAW, pitch: 0 }), () => false);
    expect(p.shotsFired).toBe(0);
    expect(p.punchPitch).toBe(0);
    // Tapping every 0.4 s: every shot is a "first shot".
    const taps = fire(sim, p, Math.ceil(2.4 / TICK_DT), () => ({ yaw: AIM_YAW, pitch: 0 }), (t) => t % 24 === 0);
    expect(taps.length).toBeGreaterThanOrEqual(5);
    for (const s of taps) expect(Math.hypot(s.dYaw, s.dPitch)).toBeLessThanOrEqual(WEAPONS.ar7.spreadBase + WEAPONS.ar7.spreadMax);
  });

  it('switching weapons resets recoil', () => {
    const { sim, p } = rig(5, 'ar7');
    fire(sim, p, 30, () => ({ yaw: AIM_YAW, pitch: 0 }));
    expect(p.punchPitch).toBeGreaterThan(0);
    p.weapons[2] = { id: 'p9', mag: 15, reserve: 90 };
    sim.selectSlot(p, 2);
    expect(p.punchPitch).toBe(0);
    expect(p.shotsFired).toBe(0);
    expect(p.switchEnd - sim.time).toBeCloseTo(WEAPONS.p9.drawTime, 5);
  });

  it('moving and airborne shots are far less accurate than standing ones', () => {
    const { sim, p } = rig(6, 'ar7');
    const standing = sim.spreadOf(p);
    p.body.vel = { x: 5.5, y: 0, z: 0 };
    const running = sim.spreadOf(p);
    p.body.onGround = false;
    const airborne = sim.spreadOf(p);
    expect(running).toBeGreaterThan(standing * 8);
    expect(airborne).toBeGreaterThan(running);
  });

  it('every weapon has a well-formed pattern', () => {
    for (const def of Object.values(WEAPONS)) {
      const keys = def.recoilPattern;
      if (def.cls === 'melee' || def.cls === 'grenade') {
        expect(keys).toHaveLength(0); // no bullets, no spray
        continue;
      }
      expect(keys[0]).toEqual([0, 0, 0]); // first shot is not displaced
      for (let i = 1; i < keys.length; i++) expect(keys[i][0]).toBeGreaterThan(keys[i - 1][0]);
      expect(keys[keys.length - 1][0]).toBeLessThan(def.magSize);
      const expanded = expandPattern(keys, def.magSize);
      expect(expanded).toHaveLength(def.magSize);
      // Recoil always pushes the aim up, never down, over a spray.
      for (let i = 1; i < expanded.length; i++) expect(expanded[i].pitch).toBeGreaterThanOrEqual(expanded[i - 1].pitch - 1e-12);
      expect(def.drawTime).toBeGreaterThan(0);
    }
  });
});
