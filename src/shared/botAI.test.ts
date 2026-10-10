import { describe, expect, it } from 'vitest';
import { BotDirector, type BotDebug } from './bot';
import { measureMatch } from './botMetrics';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { Simulation, TICK_RATE, type SimPlayer } from './sim';
import { tacticalMap } from './tactics';
import { dist2D, type Vec3 } from './vec';

/**
 * Behavioural tests of the bot AI: do bots spread over the map, pick
 * independent destinations and routes, recover when stuck, and answer a
 * sighting without the whole team converging? Uses headless matches and
 * controlled scenarios (the bots only ever act through PlayerCmds).
 */

const map = buildMap(DEPOT);

function setup(perTeam: number | [number, number], seed = 1, difficulty: 'easy' | 'normal' | 'hard' = 'normal') {
  const [na, nd] = typeof perTeam === 'number' ? [perTeam, perTeam] : perTeam;
  const sim = new Simulation(map, { roundsToWin: 30, freezeTime: 0.5 }, seed);
  const bots = new BotDirector(sim, difficulty);
  for (let i = 0; i < na; i++) sim.addPlayer(BotDirector.botName('A', i), 'A', true);
  for (let i = 0; i < nd; i++) sim.addPlayer(BotDirector.botName('D', i), 'D', true);
  return { sim, bots };
}

function step(sim: Simulation, bots: BotDirector, seconds: number, until?: () => boolean): void {
  for (let t = 0; t < seconds * TICK_RATE && !until?.(); t++) {
    bots.update();
    sim.events.length = 0;
    sim.tick();
    bots.observe(sim.events);
  }
}

const pairwise = (ps: Vec3[]) => {
  const out: number[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.push(dist2D(ps[i], ps[j]));
  return out;
};

/** Removes the bot's enemies from view: moves them under the floor and never ticks them. */
function hideTeam(sim: Simulation, team: 'A' | 'D'): void {
  for (const p of sim.players.filter((q) => q.team === team)) {
    p.isBot = false;
    p.external = true;
    p.body.pos = { x: 40, y: -5, z: 30 };
  }
}

describe('bot AI: spreading out', () => {
  it('A: at the round start every bot has its own destination, and no two are on top of each other', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { sim, bots } = setup(5, seed);
      step(sim, bots, 0.6, () => sim.phase === 'live');
      const dbg = bots.debugState();
      for (const team of ['A', 'D'] as const) {
        const dests = dbg.filter((d) => d.team === team).map((d) => d.dest!);
        expect(dests.every(Boolean), `seed ${seed} ${team}`).toBe(true);
        const gaps = pairwise(dests);
        // Teammates staging on one route are spaced along it (>= 3.9 m).
        expect(Math.min(...gaps), `seed ${seed} ${team} closest destinations`).toBeGreaterThan(3.5);
      }
      // Defenders cover both sites (and the middle).
      const zones = new Set(dbg.filter((d) => d.team === 'D').map((d) => d.reason.split(':')[0]));
      expect([...zones].some((z) => z.includes(' A')) && [...zones].some((z) => z.includes(' B')), [...zones].join(',')).toBe(true);
    }
  });

  it('B: in real matches teammates occupy several areas instead of moving as one group', () => {
    const runs = [1, 2, 3].map((seed) => measureMatch('normal', seed, 5, 4));
    const avg = (f: (m: (typeof runs)[0]) => number) => runs.reduce((s, m) => s + f(m), 0) / runs.length;
    // Before this AI: within 3 m 40% (A) / 31% (D); areas 1.98 / 2.53; biggest group 2.4 (normal, 5–25 s).
    expect(avg((m) => m.early.A.huddled)).toBeLessThan(0.2);
    expect(avg((m) => m.early.D.huddled)).toBeLessThan(0.2);
    expect(avg((m) => m.early.A.areas)).toBeGreaterThan(2.3);
    expect(avg((m) => m.early.A.biggestGroup)).toBeLessThan(1.8);
    for (const m of runs) expect(m.outOfMap).toBe(0);
  }, 120_000);

  it('C: attackers take different routes to the site (not all the shortest one)', () => {
    let rounds = 0;
    let multiRoute = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { sim, bots } = setup(5, seed);
      step(sim, bots, 0.6, () => sim.phase === 'live');
      const t = tacticalMap(map);
      const atk = bots.debugState().filter((d) => d.team === 'A');
      // Which planned route does each attacker's path follow?
      const routeIds = new Set<string>();
      for (const d of atk) {
        for (const s of ['A', 'B'] as const) {
          t.routes('A', s).forEach((r, i) => {
            const cells = new Set(r.cells);
            const onIt = d.path.filter((w) => cells.has(map.cellOf(w).z * map.def.cols + map.cellOf(w).x)).length;
            if (d.path.length && onIt / d.path.length > 0.6) routeIds.add(s + i);
          });
        }
      }
      rounds++;
      if (routeIds.size >= 2) multiRoute++;
    }
    expect(multiRoute / rounds).toBeGreaterThanOrEqual(0.8);
    // And over whole matches, attackers use more lanes per round (old AI: 1.59).
    const m = [1, 2, 3, 4].map((s) => measureMatch('normal', s, 5, 5));
    expect(m.reduce((a, x) => a + x.early.A.lanes, 0) / m.length).toBeGreaterThan(1.85);
  }, 120_000);

  it('D: bots piled onto one spot spread out again on their own', () => {
    const { sim, bots } = setup(5, 3);
    step(sim, bots, 1, () => sim.phase === 'live');
    hideTeam(sim, 'A');
    const defenders = sim.players.filter((p) => p.team === 'D');
    const c = map.cellCenter(32, 4); // all five on one cell of A Site
    for (const p of defenders) {
      p.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
      p.body.vel = { x: 0, y: 0, z: 0 };
    }
    step(sim, bots, 8);
    const gaps = pairwise(defenders.map((p) => p.body.pos));
    const close = gaps.filter((g) => g < 2.5).length;
    expect(close, `pairs still within 2.5 m: ${close}`).toBeLessThanOrEqual(1);
    expect(bots.debugState().some((d) => /too close to/.test(d.reason) || d.reason.includes('round start'))).toBe(true);
  });
});

describe('bot AI: reacting', () => {
  it('E: a bot that sees an enemy fights it; at most two teammates come to help, the rest keep their positions', () => {
    const { sim, bots } = setup([1, 5], 2);
    step(sim, bots, 1, () => sim.phase === 'live');
    step(sim, bots, 6); // defenders spread to their positions
    const enemy = sim.players.find((p) => p.team === 'A')!;
    enemy.isBot = false;
    enemy.external = true; // stands still, never shoots
    enemy.health = 100000;
    const before = new Map(bots.debugState().map((d) => [d.id, d.dest]));
    // Put the enemy in front of the defender holding nearest to A Site.
    const holder = sim.players.filter((p) => p.team === 'D').sort((a, b) => dist2D(a.body.pos, tacticalMap(map).site.A) - dist2D(b.body.pos, tacticalMap(map).site.A))[0];
    const yaw = holder.yaw;
    enemy.body.pos = { x: holder.body.pos.x - Math.sin(yaw) * 6, y: holder.body.pos.y, z: holder.body.pos.z - Math.cos(yaw) * 6 };
    if (!sim.canSee(holder, enemy)) enemy.body.pos = { ...holder.body.pos, x: holder.body.pos.x + 0.5 };
    let shots = 0;
    for (let t = 0; t < 4 * TICK_RATE; t++) {
      bots.update();
      sim.events.length = 0;
      sim.tick();
      bots.observe(sim.events);
      shots += sim.events.filter((e) => e.type === 'shot' && e.shooter === holder.id).length;
    }
    const after = bots.debugState();
    expect(shots, 'the defender that saw the enemy fired at it').toBeGreaterThan(0);
    const moved = after.filter((d) => d.id !== holder.id && /support|trade|rotate/.test(d.reason) && before.get(d.id) !== d.dest);
    expect(moved.length, moved.map((d) => `${d.name}: ${d.reason}`).join('; ')).toBeLessThanOrEqual(2);
    // Nobody else's destination was pulled onto the enemy's position.
    const onEnemy = after.filter((d) => d.id !== holder.id && d.dest && dist2D(d.dest, enemy.body.pos) < 2);
    expect(onEnemy.length).toBe(0);
  });

  it('F: a bot whose way is blocked recovers (sidestep, re-plan, new destination) instead of pushing forever', () => {
    const { sim, bots } = setup([1, 1], 4);
    step(sim, bots, 1, () => sim.phase === 'live');
    hideTeam(sim, 'A');
    const bot = sim.players.find((p) => p.team === 'D')!;
    // Pin it against the low crate in Defender Spawn and give it a "path"
    // straight through the crate (what the old combat movement did).
    const c = map.cellCenter(35, 15);
    bot.body.pos = { x: c.x - 0.55, y: c.y + 0.02, z: c.z };
    const brain = (bots as unknown as { brains: Map<number, { path: Vec3[]; pathIdx: number; dest: Vec3 | null; state: string; startAt: number }> }).brains.get(bot.id)!;
    const through = map.cellCenter(32, 15);
    brain.path = [through];
    brain.pathIdx = 0;
    brain.dest = through;
    brain.state = 'move';
    brain.startAt = 0;
    const start = { ...bot.body.pos };
    step(sim, bots, 6);
    const dbg = bots.debugState().find((d) => d.id === bot.id) as BotDebug;
    expect(dist2D(bot.body.pos, start), 'it got moving again').toBeGreaterThan(1.5);
    expect(dbg.stuckTime, 'stuck for at most a couple of seconds').toBeLessThanOrEqual(2.5);
  });

  it('F2: in combat, closing the distance goes around obstacles (the old bots pressed into crates for minutes)', () => {
    // The scenario that produced 150+ stuck bot-seconds per easy match before.
    const runs = [5, 6, 7, 8].map((seed) => measureMatch('easy', seed, 5, 5));
    const stuck = runs.reduce((s, m) => s + m.stuckSeconds, 0) / runs.length;
    expect(stuck).toBeLessThan(30); // was 290 on these seeds
  }, 120_000);
});

describe('bot AI: team sizes', () => {
  for (const [na, nd] of [[1, 1], [2, 2], [3, 3], [8, 8], [2, 5]] as const) {
    it(`G: ${na}v${nd} matches run to the end with sensible spread`, () => {
      const m = measureMatch('normal', 11, 1, 3);
      expect(m).toBeTruthy();
      const sim = new Simulation(map, { roundsToWin: 3 }, 11);
      const bots = new BotDirector(sim, 'normal');
      for (let i = 0; i < na; i++) sim.addPlayer(BotDirector.botName('A', i), 'A', true);
      for (let i = 0; i < nd; i++) sim.addPlayer(BotDirector.botName('D', i), 'D', true);
      let worstGroup = 0;
      let samples = 0;
      let groupSum = 0;
      for (let t = 0; t < TICK_RATE * 60 * 20 && sim.phase !== 'matchEnd'; t++) {
        bots.update();
        sim.events.length = 0;
        sim.tick();
        bots.observe(sim.events);
        if (sim.phase !== 'live' || t % 30 || sim.time - sim.roundStartTime < 5 || sim.time - sim.roundStartTime > 25) continue;
        for (const team of ['A', 'D'] as const) {
          const alive = sim.players.filter((p: SimPlayer) => p.team === team && p.alive);
          for (const p of alive) {
            const g = alive.filter((q) => dist2D(q.body.pos, p.body.pos) < 5).length;
            worstGroup = Math.max(worstGroup, g);
            groupSum += g;
            samples++;
          }
        }
      }
      expect(sim.phase).toBe('matchEnd');
      if (samples) expect(groupSum / samples, 'average group size around a bot').toBeLessThan(na >= 8 ? 2.6 : 2);
    }, 120_000);
  }
});
