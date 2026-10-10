import { describe, expect, it } from 'vitest';
import { buildMap, STAIR_RISE, type MapData, type MapDef } from './map';
import { DEPOT } from './maps/depot';
import { PHYS, makeBody, stepMovement, type MoveBody, type MoveInput } from './movement';
import { NAV_CLIMB, NavGrid } from './nav';
import { TICK_DT } from './sim';
import { anglesFromDir, dist2D, type Vec3 } from './vec';

const map = buildMap(DEPOT);
const nav = new NavGrid(map);

const walk = (yaw: number): MoveInput => ({ forward: 1, side: 0, jump: false, crouch: false, walk: false, yaw });

function bodyAt(m: MapData, cx: number, cz: number): MoveBody {
  const c = m.cellCenter(cx, cz);
  const b = makeBody({ x: c.x, y: c.y + 0.02, z: c.z });
  for (let i = 0; i < 10; i++) stepMovement(m.world, b, { ...walk(0), forward: 0 }, PHYS.maxSpeed, TICK_DT);
  return b;
}

/**
 * Walks a body to `goal` like a bot does: follow the planned waypoints and,
 * like BotDirector.checkStuck, re-plan from where it is if it stops making
 * progress for a second. Returns the ticks used, or -1 if it never arrives.
 */
function followPath(m: MapData, b: MoveBody, goal: Vec3, maxTicks = 60 * 40): number {
  let path = nav.findPath(b.pos, goal) ?? [];
  let i = 0;
  let check = { ...b.pos };
  for (let t = 0; t < maxTicks; t++) {
    while (i < path.length && dist2D(b.pos, path[i]) < 0.55) i++;
    if (i >= path.length) return t;
    if (t % 60 === 59) {
      if (dist2D(b.pos, check) < 0.4) {
        path = nav.findPath(b.pos, goal) ?? [];
        i = 0;
      }
      check = { ...b.pos };
    }
    const wp = path[i];
    const yaw = anglesFromDir({ x: wp.x - b.pos.x, y: 0, z: wp.z - b.pos.z }).yaw;
    stepMovement(m.world, b, walk(yaw), PHYS.maxSpeed, TICK_DT);
  }
  return -1;
}

describe('elevation: map data', () => {
  it('raised floors and stairs give the expected surface heights', () => {
    expect(map.cellCenter(31, 4).y).toBe(1); // A Site platform
    expect(map.cellCenter(24, 6).y).toBe(1); // Short A
    expect(map.cellCenter(27, 3).y).toBe(0); // Long A pocket below the site
    expect(map.cellCenter(5, 14).y).toBe(0); // Attacker Spawn
    // A staircase climbs monotonically in its direction, a step at a time.
    for (const st of DEPOT.stairs ?? []) {
      const cs = DEPOT.cellSize;
      const lo = { x: ((st.x0 + st.x1 + 1) / 2) * cs, z: ((st.z0 + st.z1 + 1) / 2) * cs };
      const along = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[st.dir];
      const run = (st.dir === 'E' || st.dir === 'W' ? st.x1 - st.x0 + 1 : st.z1 - st.z0 + 1) * cs;
      let prev = -Infinity;
      for (let s = -run / 2 + 0.01; s < run / 2; s += 0.05) {
        const h = map.surfaceY({ x: lo.x + along[0] * s, z: lo.z + along[1] * s });
        expect(h).toBeGreaterThanOrEqual(prev);
        if (prev > -Infinity) expect(h - prev).toBeLessThanOrEqual(STAIR_RISE + 1e-9);
        prev = h;
      }
      expect(prev).toBeCloseTo(st.to, 9);
    }
  });

  it('crates on a raised floor stand on it', () => {
    const crate = map.boxes.find((b) => b.kind === 'crate' && b.min.x < 30 * 2 && b.max.x > 29 * 2 && b.min.z < 5 * 2 && b.max.z > 4 * 2)!;
    expect(crate.min.y).toBe(1);
    expect(crate.max.y).toBe(2);
  });

  it('rejects stairs or crates that do not fit the grid', () => {
    const bad: MapDef = { ...DEPOT, stairs: [{ x0: 0, z0: 0, x1: 0, z1: 0, dir: 'E', from: 0, to: 1 }] };
    expect(() => buildMap(bad)).toThrow(/open floor/);
    const crateOnStairs: MapDef = { ...DEPOT, crates: [...DEPOT.crates, { x: 22, z: 9 }] };
    expect(() => buildMap(crateOnStairs)).toThrow(/stairs/i);
    const spawnOnStairs: MapDef = { ...DEPOT, spawns: { ...DEPOT.spawns, D: [{ x: 32, z: 20 }] } };
    expect(() => buildMap(spawnOnStairs)).toThrow(/Spawn D/);
  });
});

describe('map: sightlines', () => {
  it('no point of one spawn zone can see any point of the other at eye level', () => {
    // The Mid -> Middle -> Mid Doors row once ran straight from spawn to spawn.
    const eye = (x: number, z: number): Vec3 => {
      const c = map.cellCenter(x, z);
      return { x: c.x, y: c.y + PHYS.standEye, z: c.z };
    };
    const a = DEPOT.buyZones.A;
    const d = DEPOT.buyZones.D;
    const seen: string[] = [];
    for (let ax = a.x0; ax <= a.x1; ax++)
      for (let az = a.z0; az <= a.z1; az++)
        for (let dx = d.x0; dx <= d.x1; dx++)
          for (let dz = d.z0; dz <= d.z1; dz++)
            if (map.world.lineOfSight(eye(ax, az), eye(dx, dz))) seen.push(`(${ax},${az})-(${dx},${dz})`);
    expect(seen.slice(0, 5).join(' ')).toBe('');
  });
});

describe('elevation: movement', () => {
  it('every Depot staircase can be walked up and back down without jumping', () => {
    for (const st of DEPOT.stairs ?? []) {
      const climb = { E: -Math.PI / 2, W: Math.PI / 2, S: Math.PI, N: 0 }[st.dir];
      const mid = { x: Math.floor((st.x0 + st.x1) / 2), z: Math.floor((st.z0 + st.z1) / 2) };
      const [dx, dz] = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[st.dir];
      const lenX = st.x1 - st.x0 + 1;
      const lenZ = st.z1 - st.z0 + 1;
      // Start one cell before the low end, finish one cell past the top.
      const start = dx ? { x: dx > 0 ? st.x0 - 1 : st.x1 + 1, z: mid.z } : { x: mid.x, z: dz > 0 ? st.z0 - 1 : st.z1 + 1 };
      const end = { x: start.x + dx * (lenX * Math.abs(dx) + 1), z: start.z + dz * (lenZ * Math.abs(dz) + 1) };
      const b = bodyAt(map, start.x, start.z);
      expect(b.pos.y).toBeCloseTo(st.from, 1);
      const goal = map.cellCenter(end.x, end.z);
      let airborne = 0;
      for (let t = 0; t < 120 && dist2D(b.pos, goal) > 0.4; t++) {
        stepMovement(map.world, b, walk(climb), PHYS.maxSpeed, TICK_DT);
        if (!b.onGround) airborne++;
      }
      expect(b.pos.y, `up ${st.dir} @${st.x0},${st.z0}`).toBeCloseTo(st.to, 2);
      expect(airborne).toBe(0);
      // And back down: ground snapping keeps the player on the steps.
      airborne = 0;
      const back = map.cellCenter(start.x, start.z);
      for (let t = 0; t < 120 && dist2D(b.pos, back) > 0.4; t++) {
        stepMovement(map.world, b, walk(climb + Math.PI), PHYS.maxSpeed, TICK_DT);
        if (!b.onGround) airborne++;
      }
      expect(b.pos.y, `down ${st.dir} @${st.x0},${st.z0}`).toBeCloseTo(st.from, 2);
      expect(airborne).toBe(0);
    }
  });

  it('a 1 m ledge cannot be walked up, can be jumped up, and can be dropped off', () => {
    // A Site's west edge: lower pocket (28,5) next to the platform (29,5).
    const b = bodyAt(map, 28, 5);
    expect(b.pos.y).toBeCloseTo(0, 2);
    for (let t = 0; t < 90; t++) stepMovement(map.world, b, walk(-Math.PI / 2), PHYS.maxSpeed, TICK_DT);
    expect(b.pos.y).toBeCloseTo(0, 2);
    expect(b.pos.x).toBeLessThan(29 * 2);
    // Jump while pressing into it.
    for (let t = 0; t < 90; t++) stepMovement(map.world, b, { ...walk(-Math.PI / 2), jump: t < 2 }, PHYS.maxSpeed, TICK_DT);
    expect(b.pos.y).toBeCloseTo(1, 2);
    expect(b.pos.x).toBeGreaterThan(29 * 2);
    // Walk back off the edge: falls to the lower floor.
    for (let t = 0; t < 150; t++) stepMovement(map.world, b, walk(Math.PI / 2), PHYS.maxSpeed, TICK_DT);
    expect(b.pos.y).toBeCloseTo(0, 2);
    expect(b.onGround).toBe(true);
  });
});

describe('elevation: navigation', () => {
  it('never paths straight up a ledge, but may drop down one', () => {
    // Pocket (28,5) -> platform (29,5): must not be a direct step.
    expect(nav.canStep(28, 5, 29, 5, false)).toBe(false);
    expect(nav.canStep(29, 5, 28, 5, false)).toBe(true);
    // Stairs connect along their run.
    expect(nav.canStep(27, 3, 28, 3, false)).toBe(true);
    expect(nav.canStep(28, 3, 29, 3, false)).toBe(true);
  });

  it('string pulling never cuts across a ledge', () => {
    // Straight line from the lower pocket across the platform edge.
    expect(nav.walkableLine(map.cellCenter(28, 5), map.cellCenter(31, 5))).toBe(false);
    // Up the Long A stairs is a valid straight line.
    expect(nav.walkableLine(map.cellCenter(27, 3), map.cellCenter(30, 3))).toBe(true);
  });

  it('every planned route between spawns, sites and raised areas is physically walkable', () => {
    const points: Record<string, Vec3> = {
      'A spawn': map.rectCenter(DEPOT.buyZones.A),
      'D spawn': map.rectCenter(DEPOT.buyZones.D),
      'A site': map.rectCenter(DEPOT.bombsites.A),
      'B site': map.rectCenter(DEPOT.bombsites.B),
      'Short A': map.cellCenter(24, 6),
      'B Doors': map.cellCenter(32, 22),
      'A pocket': map.cellCenter(27, 4),
    };
    const names = Object.keys(points);
    for (const from of names) {
      for (const to of names) {
        if (from === to) continue;
        const path = nav.findPath(points[from], points[to]);
        expect(path, `${from} -> ${to}`).not.toBeNull();
        const c = map.cellOf(points[from]);
        const b = bodyAt(map, c.x, c.z);
        const ticks = followPath(map, b, points[to]);
        expect(ticks, `${from} -> ${to} reachable by walking`).toBeGreaterThan(0);
        expect(b.pos.y, `${from} -> ${to} arrives at the right height`).toBeCloseTo(points[to].y, 1);
      }
    }
  });

  it('the navigation climb limit is below the physical step height', () => {
    expect(STAIR_RISE).toBeLessThan(NAV_CLIMB);
    expect(NAV_CLIMB).toBeLessThan(PHYS.stepHeight);
  });
});
