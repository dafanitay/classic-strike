import { describe, expect, it } from 'vitest';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { parseClientMsg } from './protocol';
import { BOMB, Simulation, TICK_DT, emptyCmd, type MatchConfig, type PlayerCmd, type SimEvent, type SimPlayer } from './sim';

const map = buildMap(DEPOT);

/** A live round with two Attackers (the first carries the bomb) and two Defenders. */
function live(config: Partial<MatchConfig> = {}) {
  const sim = new Simulation(map, { freezeTime: 0.05, ...config }, 7);
  const a1 = sim.addPlayer('a1', 'A', false);
  const a2 = sim.addPlayer('a2', 'A', false);
  const d1 = sim.addPlayer('d1', 'D', false);
  const d2 = sim.addPlayer('d2', 'D', false);
  while (sim.phase !== 'live') sim.tick();
  if (sim.config.bomb) sim.bomb.carrier = a1.id; // deterministic carrier for the tests
  return { sim, a1, a2, d1, d2 };
}

function place(_sim: Simulation, p: SimPlayer, cx: number, cz: number, dx = 0, dz = 0): void {
  const c = map.cellCenter(cx, cz);
  p.body.pos = { x: c.x + dx, y: c.y, z: c.z + dz };
  p.body.vel = { x: 0, y: 0, z: 0 };
  p.body.onGround = true;
}

/** Ticks with fixed commands per player; returns every event. */
function run(sim: Simulation, seconds: number, cmds: Map<SimPlayer, PlayerCmd> = new Map()): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    for (const p of sim.players) sim.setCmd(p, cmds.get(p) ?? emptyCmd(p.yaw, 0));
    sim.events.length = 0;
    sim.tick();
    out.push(...sim.events);
  }
  return out;
}

const use = (extra: Partial<PlayerCmd> = {}): PlayerCmd => ({ ...emptyCmd(), use: true, ...extra });
const siteA = { x: 31, z: 5 }; // inside bombsite A
const plantAt = (sim: Simulation, p: SimPlayer) => {
  place(sim, p, siteA.x, siteA.z);
  return run(sim, BOMB.plantTime + 0.1, new Map([[p, use()]]));
};

describe('bomb: carrying and dropping', () => {
  it('one Attacker carries the bomb from the round start; none in elimination mode', () => {
    const sim = new Simulation(map, { freezeTime: 0.05 }, 3);
    const as = [sim.addPlayer('a1', 'A', false), sim.addPlayer('a2', 'A', false)];
    sim.addPlayer('d1', 'D', false);
    sim.tick();
    expect(sim.bomb.state).toBe('carried');
    expect(as.map((p) => p.id)).toContain(sim.bomb.carrier);
    const elim = live({ bomb: false }).sim;
    expect(elim.bomb.state).toBe('none');
  });

  it('drops where its carrier dies; only an Attacker picks it up by walking over it', () => {
    const { sim, a1, a2, d1 } = live();
    place(sim, a1, 10, 3);
    sim.damage(a1, d1, 500, 'chest', a1.body.pos, 'ar7');
    expect(sim.bomb.state).toBe('dropped');
    expect(Math.hypot(sim.bomb.pos.x - a1.body.pos.x, sim.bomb.pos.z - a1.body.pos.z)).toBeLessThan(1e-9);
    place(sim, d1, 10, 3);
    run(sim, 0.2);
    expect(sim.bomb.state).toBe('dropped');
    place(sim, a2, 10, 3, 0.5);
    const ev = run(sim, 0.2);
    expect(sim.bomb.state).toBe('carried');
    expect(sim.bomb.carrier).toBe(a2.id);
    expect(ev.some((e) => e.type === 'bombPickup' && e.player === a2.id)).toBe(true);
  });
});

describe('bomb: planting', () => {
  it('takes 3.2 s of holding use inside a site, standing still, and pays the planter', () => {
    const { sim, a1 } = live();
    const money = a1.money;
    place(sim, a1, siteA.x, siteA.z);
    const start = { ...a1.body.pos };
    // Holding use while pressing forward: the planter does not move.
    run(sim, BOMB.plantTime - 0.1, new Map([[a1, use({ forward: 1 })]]));
    expect(sim.bomb.state).toBe('carried');
    expect(Math.hypot(a1.body.pos.x - start.x, a1.body.pos.z - start.z)).toBeLessThan(1e-9);
    const ev = run(sim, 0.2, new Map([[a1, use()]]));
    expect(sim.bomb.state).toBe('planted');
    expect(sim.bomb.site).toBe('A');
    expect(ev.some((e) => e.type === 'planted')).toBe(true);
    expect(a1.money).toBe(money + BOMB.plantReward);
    expect(sim.phaseEnd).toBeCloseTo(sim.bomb.explodeAt, 9); // the round clock is now the fuse
  });

  it('letting go cancels, and the timer starts over', () => {
    const { sim, a1 } = live();
    place(sim, a1, siteA.x, siteA.z);
    run(sim, 2, new Map([[a1, use()]]));
    const ev = run(sim, 0.1);
    expect(ev.some((e) => e.type === 'actionAbort')).toBe(true);
    run(sim, 2, new Map([[a1, use()]]));
    expect(sim.bomb.state).toBe('carried');
    run(sim, 1.3, new Map([[a1, use()]]));
    expect(sim.bomb.state).toBe('planted');
  });

  it('is impossible outside a bombsite, during the freeze, or without the bomb', () => {
    const { sim, a1, a2 } = live();
    place(sim, a1, 10, 3); // Long A, not a site
    run(sim, 4, new Map([[a1, use()]]));
    expect(sim.bomb.state).toBe('carried');
    plantAt(sim, a2); // a2 isn't carrying
    expect(sim.bomb.state).toBe('carried');
    const fresh = new Simulation(map, { freezeTime: 10 }, 1);
    const c = fresh.addPlayer('a', 'A', false);
    fresh.addPlayer('d', 'D', false);
    fresh.tick();
    expect(fresh.phase).toBe('freeze');
    place(fresh, c, siteA.x, siteA.z);
    run(fresh, 4, new Map([[c, use()]]));
    expect(fresh.bomb.state).toBe('carried');
  });

  it("the planter can't shoot while planting", () => {
    const { sim, a1 } = live();
    place(sim, a1, siteA.x, siteA.z);
    const ev = run(sim, 1, new Map([[a1, use({ fire: true })]]));
    expect(ev.filter((e) => e.type === 'shot')).toHaveLength(0);
  });
});

describe('bomb: after the plant', () => {
  it('explodes after the fuse: Attackers win, nearby players die, distant ones are unhurt', () => {
    const { sim, a1, a2, d1, d2 } = live();
    plantAt(sim, a1);
    place(sim, d1, siteA.x + 2, siteA.z); // 4 m away
    place(sim, d2, 34, 16); // Defender Spawn, far away
    place(sim, a2, 5, 14); // Attacker Spawn
    place(sim, a1, siteA.x - 2, siteA.z);
    const ev = run(sim, BOMB.fuse + 0.1);
    expect(sim.bomb.state).toBe('exploded');
    expect(ev.some((e) => e.type === 'roundEnd' && e.winner === 'A' && e.reason === 'Target destroyed')).toBe(true);
    expect(d1.alive).toBe(false);
    expect(a1.alive).toBe(false); // the blast doesn't care whose bomb it was
    expect(d2.health).toBe(100);
    expect(a2.health).toBe(100);
    const kill = ev.find((e) => e.type === 'kill' && e.victim === d1.id);
    expect(kill && kill.type === 'kill' && kill.weapon).toBe('bomb');
  });

  it('dead Attackers do not end the round once the bomb is down; dead Defenders do', () => {
    const { sim, a1, a2, d1 } = live();
    plantAt(sim, a1);
    sim.damage(a1, d1, 500, 'chest', a1.body.pos, 'ar7');
    sim.damage(a2, d1, 500, 'chest', a2.body.pos, 'ar7');
    run(sim, 1);
    expect(sim.phase).toBe('live');
    const b = live();
    plantAt(b.sim, b.a1);
    b.sim.damage(b.d1, b.a2, 500, 'chest', b.d1.body.pos, 'ar7');
    b.sim.damage(b.d2, b.a2, 500, 'chest', b.d2.body.pos, 'ar7');
    const ev = run(b.sim, 0.1);
    expect(ev.some((e) => e.type === 'roundEnd' && e.winner === 'A')).toBe(true);
  });

  it('a Defender at the bomb defuses it in 10 s (5 s with a kit); Defenders win, Attackers get the plant bonus', () => {
    for (const kit of [false, true]) {
      const { sim, a1, a2, d1 } = live();
      plantAt(sim, a1);
      const bombAt = map.cellOf(sim.bomb.pos);
      d1.kit = kit;
      place(sim, d1, bombAt.x, bombAt.z, 0.6);
      const moneyA = a2.money;
      const t = kit ? BOMB.kitDefuseTime : BOMB.defuseTime;
      run(sim, t - 0.1, new Map([[d1, use()]]));
      expect(sim.bomb.state, `kit ${kit}`).toBe('planted');
      const ev = run(sim, 0.2, new Map([[d1, use()]]));
      expect(sim.bomb.state).toBe('defused');
      expect(ev.some((e) => e.type === 'roundEnd' && e.winner === 'D')).toBe(true);
      const lossBonus = sim.config.lossBase;
      expect(a2.money).toBe(moneyA + lossBonus + BOMB.plantedLossBonus);
    }
  });

  it('out of reach, two at once, or a killed defuser: no defuse', () => {
    const { sim, a1, a2, d1, d2 } = live();
    plantAt(sim, a1);
    const at = map.cellOf(sim.bomb.pos);
    place(sim, d1, at.x + 2, at.z); // ~4 m away
    run(sim, BOMB.defuseTime + 0.5, new Map([[d1, use()]]));
    expect(sim.bomb.state).toBe('planted');
    // d1 starts defusing; d2 can't take over at the same time.
    place(sim, d1, at.x, at.z, 0.5);
    place(sim, d2, at.x, at.z, -0.5);
    run(sim, 1, new Map([[d1, use()], [d2, use()]]));
    expect(sim.bomb.defuser).toBe(d1.id);
    expect(d2.action).toBeNull();
    // Killing the defuser frees the bomb, and d2's timer starts from zero.
    sim.damage(d1, a2, 500, 'head', d1.body.pos, 'ar7');
    expect(sim.bomb.defuser).toBe(0);
    run(sim, BOMB.defuseTime - 0.5, new Map([[d2, use()]]));
    expect(sim.bomb.state).toBe('planted');
    run(sim, 0.7, new Map([[d2, use()]]));
    expect(sim.bomb.state).toBe('defused');
  });
});

describe('bomb: players leaving mid-round', () => {
  it('a defuser who disconnects or switches team frees the bomb for the next Defender', () => {
    for (const how of ['leave', 'team'] as const) {
      const { sim, a1, d1, d2 } = live();
      plantAt(sim, a1);
      const at = map.cellOf(sim.bomb.pos);
      place(sim, d1, at.x, at.z, 0.5);
      place(sim, d2, at.x, at.z, -0.5);
      run(sim, 1, new Map([[d1, use()]]));
      expect(sim.bomb.defuser).toBe(d1.id);
      if (how === 'leave') sim.removePlayer(d1.id);
      else sim.setTeam(d1, 'A');
      expect(sim.bomb.defuser, how).toBe(0);
      run(sim, BOMB.defuseTime + 0.2, new Map([[d2, use()]]));
      expect(sim.bomb.state, how).toBe('defused');
    }
  });

  it('a team emptying out sends the game back to warmup without a leftover bomb', () => {
    const { sim, a1, d1, d2 } = live();
    plantAt(sim, a1);
    sim.removePlayer(d1.id);
    sim.removePlayer(d2.id);
    run(sim, 6); // round ends, the next one can't start without Defenders
    expect(sim.phase).toBe('warmup');
    expect(sim.bomb.state).toBe('none');
  });

  it('switching to the Attackers drops a defuse kit', () => {
    const { sim, d1 } = live();
    d1.kit = true;
    sim.setTeam(d1, 'A');
    expect(d1.kit).toBe(false);
  });
});

describe('bomb: rules and economy', () => {
  it('no plant before the clock runs out: Defenders win', () => {
    const { sim } = live({ roundTime: 2 });
    const ev = run(sim, 2.2);
    expect(ev.some((e) => e.type === 'roundEnd' && e.winner === 'D' && /not planted/.test(e.reason))).toBe(true);
  });

  it('only Defenders can buy a defuse kit, once; it is lost on death', () => {
    const sim = new Simulation(map, { freezeTime: 5 }, 1);
    const a = sim.addPlayer('a', 'A', false);
    const d = sim.addPlayer('d', 'D', false);
    sim.tick();
    expect(sim.buy(a, 'defuser')).toMatch(/Defenders/);
    expect(sim.buy(d, 'defuser')).toBeNull();
    expect(d.kit).toBe(true);
    expect(sim.buy(d, 'defuser')).toMatch(/already/);
    sim.damage(d, a, 500, 'chest', d.body.pos, 'p9');
    expect(d.kit).toBe(false);
  });

  it('the network command carries `use`, and the kit is a valid purchase', () => {
    const m = parseClientMsg(JSON.stringify({ t: 'cmd', seq: 1, cmd: { ...emptyCmd(), use: true } }));
    expect(m && m.t === 'cmd' && m.cmd.use).toBe(true);
    const n = parseClientMsg(JSON.stringify({ t: 'cmd', seq: 1, cmd: { ...emptyCmd(), use: 'yes' } }));
    expect(n && n.t === 'cmd' && n.cmd.use).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'buy', item: 'defuser' }))).toEqual({ t: 'buy', item: 'defuser' });
  });
});
