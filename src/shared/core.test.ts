import { describe, expect, it } from 'vitest';
import { CollisionWorld } from './collision';
import { buildMap, CELL_FLOOR } from './map';
import { DEPOT } from './maps/depot';
import { PHYS, makeBody, stepMovement, type MoveInput } from './movement';
import { NavGrid } from './nav';
import { Simulation, TICK_DT, emptyCmd } from './sim';
import { WEAPONS, computeDamage } from './weapons';

const idle = (yaw = 0): MoveInput => ({ forward: 0, side: 0, jump: false, crouch: false, walk: false, yaw });

function flatWorld(extra: CollisionWorld['boxes'] = []) {
  return new CollisionWorld([{ min: { x: -100, y: -1, z: -100 }, max: { x: 100, y: 0, z: 100 } }, ...extra]);
}

describe('movement', () => {
  it('accelerates to (but not beyond) max ground speed and stops with friction', () => {
    const w = flatWorld();
    const b = makeBody({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 120; i++) stepMovement(w, b, { ...idle(), forward: 1 }, PHYS.maxSpeed, TICK_DT);
    const speed = Math.hypot(b.vel.x, b.vel.z);
    expect(speed).toBeGreaterThan(PHYS.maxSpeed * 0.95);
    expect(speed).toBeLessThanOrEqual(PHYS.maxSpeed + 1e-6);
    expect(b.pos.z).toBeLessThan(-5); // yaw 0 moves toward -Z
    for (let i = 0; i < 60; i++) stepMovement(w, b, idle(), PHYS.maxSpeed, TICK_DT);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBe(0);
  });

  it('jumps about 1.14 m, lands, and needs a fresh press to jump again', () => {
    const w = flatWorld();
    const b = makeBody({ x: 0, y: 0, z: 0 });
    stepMovement(w, b, idle(), PHYS.maxSpeed, TICK_DT);
    expect(b.onGround).toBe(true);
    let apex = 0;
    let jumps = 0;
    for (let i = 0; i < 120; i++) {
      const r = stepMovement(w, b, { ...idle(), jump: true }, PHYS.maxSpeed, TICK_DT);
      if (r.jumped) jumps++;
      apex = Math.max(apex, b.pos.y);
    }
    expect(jumps).toBe(1);
    expect(apex).toBeGreaterThan(1.05);
    expect(apex).toBeLessThan(1.2);
    expect(b.onGround).toBe(true);
  });

  it('never passes through a wall, and slides along it', () => {
    const wall = { min: { x: -100, y: 0, z: -3 }, max: { x: 100, y: 5, z: -2 } };
    const w = flatWorld([wall]);
    const b = makeBody({ x: 0, y: 0, z: 0 });
    // Run diagonally into the wall for 3 s.
    for (let i = 0; i < 180; i++) stepMovement(w, b, { ...idle(Math.PI / 4), forward: 1 }, PHYS.maxSpeed, TICK_DT);
    expect(b.pos.z).toBeGreaterThanOrEqual(-2 + PHYS.halfWidth - 1e-6);
    expect(b.pos.x).toBeLessThan(-3); // slid sideways
  });

  it('pushes a hull that starts slightly inside a wall back out, never onto the wall top', () => {
    // Regression: network-rounded positions can overlap a wall by < 1 mm.
    const wall = { min: { x: 0, y: 0, z: -5 }, max: { x: 1, y: 5, z: 5 } };
    const w = flatWorld([wall]);
    const b = makeBody({ x: 1 + PHYS.halfWidth - 0.0004, y: 0, z: 0 });
    b.onGround = true;
    stepMovement(w, b, { ...idle(-Math.PI / 2), forward: 1 }, PHYS.maxSpeed, TICK_DT); // walking away (+X)
    expect(b.pos.y).toBeLessThan(0.01);
    expect(b.pos.x).toBeGreaterThanOrEqual(1 + PHYS.halfWidth);
    const c = makeBody({ x: 1 + PHYS.halfWidth - 0.0004, y: 0, z: 0 });
    stepMovement(w, c, { ...idle(Math.PI / 2), forward: 1 }, PHYS.maxSpeed, TICK_DT); // walking into it (-X)
    expect(c.pos.y).toBeLessThan(0.01);
    expect(c.pos.x).toBeGreaterThanOrEqual(1 + PHYS.halfWidth - 1e-9);
  });

  it('walks up a step no taller than the step height, without jumping', () => {
    for (const [h, ok] of [[0.3, true], [PHYS.stepHeight - 0.01, true], [0.6, false]] as const) {
      const step = { min: { x: -2, y: 0, z: -20 }, max: { x: 2, y: h, z: -1.5 } };
      const w = flatWorld([step]);
      const b = makeBody({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 90; i++) stepMovement(w, b, { ...idle(), forward: 1 }, PHYS.maxSpeed, TICK_DT);
      expect(b.pos.y > h - 0.01, `step ${h}`).toBe(ok);
      if (ok) expect(b.pos.z).toBeLessThan(-3); // kept walking on top
    }
  });

  it('climbs a staircase at nearly full speed and walks back down it', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({ min: { x: -2, y: 0, z: -2 - (i + 1) * 0.5 }, max: { x: 2, y: 0.3 * (i + 1), z: -2 - i * 0.5 } }));
    // A landing at the top.
    steps.push({ min: { x: -2, y: 0, z: -12 }, max: { x: 2, y: 1.8, z: -5 } });
    const w = flatWorld(steps);
    const b = makeBody({ x: 0, y: 0, z: 0 });
    let t = 0;
    while (b.pos.z > -6.5 && t < 300) {
      stepMovement(w, b, { ...idle(), forward: 1 }, PHYS.maxSpeed, TICK_DT);
      t++;
    }
    expect(b.pos.y).toBeCloseTo(1.8, 2);
    // 6.5 m at ~6.35 m/s plus acceleration: well under 2 s, i.e. not stuck on steps.
    expect(t / 60).toBeLessThan(1.6);
    for (let i = 0; i < 200; i++) stepMovement(w, b, { ...idle(), forward: -1 }, PHYS.maxSpeed, TICK_DT);
    expect(b.pos.y).toBeLessThan(0.01);
    expect(b.pos.z).toBeGreaterThan(-1);
  });

  it('does not step while jumping or into a ceiling-height gap', () => {
    // A low slot: step 0.3 m high but only 1.5 m of headroom above it.
    const step = { min: { x: -2, y: 0, z: -20 }, max: { x: 2, y: 0.3, z: -1.5 } };
    const ceiling = { min: { x: -2, y: 1.8, z: -20 }, max: { x: 2, y: 3, z: -1.5 } };
    const w = flatWorld([step, ceiling]);
    const b = makeBody({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 90; i++) stepMovement(w, b, { ...idle(), forward: 1 }, PHYS.maxSpeed, TICK_DT);
    expect(b.pos.y).toBeLessThan(0.01); // standing hull (1.83 m) can't fit
    expect(b.pos.z).toBeGreaterThanOrEqual(-1.5 + PHYS.halfWidth - 1e-6);
  });

  it('can jump onto a low crate but not a tall one', () => {
    for (const [h, ok] of [[1.0, true], [2.1, false]] as const) {
      const crate = { min: { x: -1, y: 0, z: -20 }, max: { x: 1, y: h, z: -1.5 } };
      const w = flatWorld([crate]);
      const b = makeBody({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 200; i++) {
        stepMovement(w, b, { ...idle(), forward: 1, jump: i % 40 < 20 }, PHYS.maxSpeed, TICK_DT);
      }
      expect(b.pos.y > h - 0.01).toBe(ok);
    }
  });
});

describe('Depot map', () => {
  const map = buildMap(DEPOT);
  const nav = new NavGrid(map);

  it('has every walkable cell in one connected region', () => {
    const { cols, rows } = DEPOT;
    const seen = new Uint8Array(cols * rows);
    const start = DEPOT.spawns.A[0];
    const stack = [start.z * cols + start.x];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cols;
      const z = Math.floor(i / cols);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = (z + dz) * cols + x + dx;
        if (map.walkable(x + dx, z + dz) && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    let unreachable = 0;
    for (let i = 0; i < cols * rows; i++) if (map.grid[i] === CELL_FLOOR && !seen[i]) unreachable++;
    expect(unreachable).toBe(0);
  });

  it('places every spawn on open floor with headroom', () => {
    for (const team of ['A', 'D'] as const) {
      for (const s of DEPOT.spawns[team]) {
        expect(map.walkable(s.x, s.z)).toBe(true);
        const c = map.cellCenter(s.x, s.z);
        expect(map.world.hullBlocked({ ...c, y: 0.01 }, PHYS.halfWidth, PHYS.standHeight)).toBe(false);
      }
    }
  });

  it('finds walkable paths from both spawns to both bombsites', () => {
    for (const team of ['A', 'D'] as const) {
      for (const site of ['A', 'B'] as const) {
        const s0 = DEPOT.spawns[team][0];
        const from = map.cellCenter(s0.x, s0.z);
        const path = nav.findPath(from, map.rectCenter(DEPOT.bombsites[site]));
        expect(path).not.toBeNull();
        let prev = from;
        for (const p of path!) {
          expect(nav.walkableLine(prev, p, 0.4)).toBe(true);
          prev = p;
        }
      }
    }
  });

  it('blocks line of sight through solid walls', () => {
    const a = { ...map.cellCenter(3, 14), y: 1.6 }; // attacker spawn
    const b = { ...map.cellCenter(34, 14), y: 1.6 }; // defender spawn — mid pillar + walls in between
    expect(map.world.lineOfSight(a, b)).toBe(false);
  });
});

describe('damage model', () => {
  it('applies hitgroup multipliers, range falloff and armour', () => {
    const rifle = WEAPONS.ar7;
    expect(computeDamage(rifle, 0, 'chest', 0, false).health).toBe(36);
    expect(computeDamage(rifle, 0, 'head', 0, false).health).toBe(144);
    expect(computeDamage(rifle, 0, 'legs', 0, false).health).toBe(27);
    const armored = computeDamage(rifle, 0, 'chest', 100, true);
    expect(armored.health).toBe(28);
    expect(armored.armor).toBeGreaterThan(0);
    // Helmetless head hits ignore armour.
    expect(computeDamage(rifle, 0, 'head', 100, false).health).toBe(144);
    expect(computeDamage(rifle, 50, 'chest', 0, false).health).toBeLessThan(36);
  });
});

describe('simulation', () => {
  function duel() {
    const map = buildMap(DEPOT);
    const sim = new Simulation(map, { freezeTime: 0.1 }, 42);
    const a = sim.addPlayer('A', 'A', false);
    const d = sim.addPlayer('D', 'D', false);
    sim.tick(); // warmup -> match start
    for (let i = 0; i < 12; i++) sim.tick(); // past freeze
    expect(sim.phase).toBe('live');
    return { sim, a, d };
  }

  function place(sim: Simulation, p: ReturnType<Simulation['addPlayer']>, cx: number, cz: number) {
    const c = sim.map.cellCenter(cx, cz);
    p.body.pos = { x: c.x, y: 0, z: c.z };
    p.body.vel = { x: 0, y: 0, z: 0 };
  }

  it('hitscan damages a visible enemy and is stopped by walls', () => {
    const { sim, a, d } = duel();
    // Both in Long A, 6 cells apart along +X.
    place(sim, a, 5, 3);
    place(sim, d, 11, 3);
    a.weapons[1] = { id: 'ar7', mag: 30, reserve: 90 };
    sim.selectSlot(a, 1, true);
    a.switchEnd = 0;
    a.fireHeld = false;
    sim.setCmd(a, { ...emptyCmd(-Math.PI / 2, -0.05), fire: true });
    for (let i = 0; i < 6; i++) sim.tick();
    expect(d.health).toBeLessThan(100);

    // Wall between: defender in A Site, attacker in Mid.
    const before = d.health;
    place(sim, d, 30, 6);
    place(sim, a, 10, 14);
    const dx = sim.eyePos(d).x - sim.eyePos(a).x;
    const dz = sim.eyePos(d).z - sim.eyePos(a).z;
    sim.setCmd(a, { ...emptyCmd(Math.atan2(-dx, -dz), 0), fire: true });
    for (let i = 0; i < 30; i++) sim.tick();
    expect(d.health).toBe(before);
  });

  it('ends the round on elimination and pays both teams', () => {
    const { sim, a, d } = duel();
    const moneyA = a.money;
    const moneyD = d.money;
    sim.damage(d, a, 500, 'chest', d.body.pos, 'ar7');
    sim.tick();
    expect(sim.phase).toBe('roundEnd');
    expect(sim.score.A).toBe(1);
    expect(a.money).toBe(moneyA + 300 + 3250);
    expect(d.money).toBe(moneyD + 1400);
  });

  it('validates purchases (zone, money, team restriction)', () => {
    const { sim, a } = duel();
    expect(sim.buy(a, 'k4')).toMatch(/not available/);
    expect(sim.buy(a, 'ar7')).toMatch(/money/);
    a.money = 5000;
    expect(sim.buy(a, 'ar7')).toBeNull();
    expect(a.weapons[1]?.id).toBe('ar7');
    place(sim, a, 30, 6);
    expect(sim.buy(a, 'kevlar')).toMatch(/spawn zone/);
  });
});
