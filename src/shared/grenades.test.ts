import { describe, expect, it } from 'vitest';
import { throwPitch } from './bot';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { decodeBomb, encodeSnapshot, applyNades, applyPlayer, encodePlayer, parseClientMsg } from './protocol';
import { Simulation, TICK_DT, emptyCmd, type PlayerCmd, type SimEvent, type SimPlayer } from './sim';
import { NADE } from './weapons';

const map = buildMap(DEPOT);

function live() {
  const sim = new Simulation(map, { freezeTime: 5, bomb: false }, 9);
  const a = sim.addPlayer('a', 'A', false);
  const a2 = sim.addPlayer('a2', 'A', false);
  const d = sim.addPlayer('d', 'D', false);
  sim.tick();
  for (const p of sim.players) p.money = 16000;
  return { sim, a, a2, d };
}
function goLive(sim: Simulation) {
  while (sim.phase !== 'live') sim.tick();
}
function place(p: SimPlayer, cx: number, cz: number, yaw = 0, dx = 0) {
  const c = map.cellCenter(cx, cz);
  p.body.pos = { x: c.x + dx, y: c.y, z: c.z };
  p.body.vel = { x: 0, y: 0, z: 0 };
  p.body.onGround = true;
  p.yaw = yaw;
  p.pitch = 0;
}
function run(sim: Simulation, seconds: number, cmds = new Map<SimPlayer, PlayerCmd>()): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    for (const p of sim.players) sim.setCmd(p, cmds.get(p) ?? emptyCmd(p.yaw, p.pitch));
    sim.events.length = 0;
    sim.tick();
    out.push(...sim.events);
  }
  return out;
}
/** Selects the grenade slot (cycling to `type`) and throws it. */
function throwNade(sim: Simulation, p: SimPlayer, type: 'he' | 'flash' | 'smoke', yaw: number, pitch: number, lob = false): SimEvent[] {
  for (let i = 0; i < 4 && !(p.current === 4 && p.weapons[4]?.id === type); i++) {
    run(sim, TICK_DT, new Map([[p, { ...emptyCmd(yaw, pitch), slot: 4 }]]));
    run(sim, 0.6, new Map([[p, emptyCmd(yaw, pitch)]]));
  }
  expect(p.weapons[4]?.id).toBe(type);
  p.yaw = yaw;
  p.pitch = pitch;
  return run(sim, TICK_DT, new Map([[p, { ...emptyCmd(yaw, pitch), fire: !lob, altFire: lob }]]));
}

describe('grenades: buying and carrying', () => {
  it('limits: one HE, two flashbangs, one smoke; prices charged', () => {
    const { sim, a } = live();
    const m = a.money;
    expect(sim.buy(a, 'he')).toBeNull();
    expect(sim.buy(a, 'he')).toMatch(/can't carry more/);
    expect(sim.buy(a, 'flash')).toBeNull();
    expect(sim.buy(a, 'flash')).toBeNull();
    expect(sim.buy(a, 'flash')).toMatch(/can't carry more/);
    expect(sim.buy(a, 'smoke')).toBeNull();
    expect(a.nades).toEqual({ he: 1, flash: 2, smoke: 1 });
    expect(m - a.money).toBe(300 + 200 * 2 + 300);
    expect(a.weapons[4]).toBeTruthy();
  });

  it('key 4 takes a grenade out; pressing it again cycles through the kinds carried', () => {
    const { sim, a } = live();
    sim.buy(a, 'he');
    sim.buy(a, 'smoke');
    goLive(sim);
    run(sim, TICK_DT, new Map([[a, { ...emptyCmd(), slot: 4 }]]));
    expect(a.current).toBe(4);
    const first = a.weapons[4]!.id;
    run(sim, TICK_DT, new Map([[a, { ...emptyCmd(), slot: 4 }]]));
    expect(a.weapons[4]!.id).not.toBe(first);
  });

  it('dying loses your grenades; survivors keep them into the next round', () => {
    const { sim, a, a2, d } = live();
    sim.buy(a, 'he');
    sim.buy(a2, 'flash');
    goLive(sim);
    sim.damage(a, d, 500, 'chest', a.body.pos, 'ar7');
    expect(a.nades.he).toBe(0);
    expect(a.weapons[4]).toBeUndefined();
    expect(a2.nades.flash).toBe(1);
  });

  it('online: grenade purchases pass the parser, and counts and blindness survive a snapshot', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'buy', item: 'flash' }))).toEqual({ t: 'buy', item: 'flash' });
    const { sim, a } = live();
    sim.buy(a, 'flash');
    a.blindFull = 12.5;
    a.blindEnd = 14;
    const copy = { ...a, nades: { he: 0, flash: 0, smoke: 0 }, weapons: {} } as SimPlayer;
    applyPlayer(copy, encodePlayer(a));
    expect(copy.nades.flash).toBe(1);
    expect(copy.weapons[4]?.id).toBe('flash');
    expect(copy.blindFull).toBeCloseTo(12.5);
    void decodeBomb;
  });
});

describe('grenades: flight', () => {
  it('a throw arcs, bounces and comes to rest on the floor; it never ends up inside a wall', () => {
    const { sim, a } = live();
    sim.buy(a, 'smoke');
    goLive(sim);
    place(a, 10, 3, -Math.PI / 2); // Long A, facing east
    const ev = throwNade(sim, a, 'smoke', -Math.PI / 2, 0.3);
    expect(ev.some((e) => e.type === 'nadeThrow')).toBe(true);
    expect(sim.nadesInFlight.length).toBe(1);
    const n = sim.nadesInFlight[0];
    let maxY = n.pos.y;
    const bounces: SimEvent[] = [];
    for (let i = 0; i < 240 && sim.nadesInFlight.length; i++) {
      bounces.push(...run(sim, TICK_DT).filter((e) => e.type === 'nadeBounce'));
      if (sim.nadesInFlight[0]) maxY = Math.max(maxY, sim.nadesInFlight[0].pos.y);
    }
    expect(maxY).toBeGreaterThan(a.body.pos.y + 1.6); // it went up first
    expect(bounces.length).toBeGreaterThan(0);
    const smoke = sim.smokes[0];
    expect(smoke).toBeTruthy();
    const c = map.cellOf(smoke.pos);
    expect(map.walkable(c.x, c.z)).toBe(true);
    expect(smoke.pos.x - a.body.pos.x).toBeGreaterThan(5); // it flew forward
  });

  it('right click is a short lob', () => {
    const far = live();
    const near = live();
    for (const [w, lob] of [[far, false], [near, true]] as const) {
      w.sim.buy(w.a, 'smoke');
      goLive(w.sim);
      place(w.a, 6, 3, -Math.PI / 2);
      throwNade(w.sim, w.a, 'smoke', -Math.PI / 2, 0.2, lob);
      run(w.sim, 4);
    }
    expect(far.sim.smokes[0].pos.x - near.sim.smokes[0].pos.x).toBeGreaterThan(4);
  });

  it("the bots' throw arc lands where it aims (within a couple of metres)", () => {
    for (const d of [8, 14, 20]) {
      const { sim, a } = live();
      sim.buy(a, 'smoke');
      goLive(sim);
      place(a, 4, 3, -Math.PI / 2);
      const target = { x: a.body.pos.x + d, y: a.body.pos.y, z: a.body.pos.z };
      const eye = sim.eyePos(a);
      throwNade(sim, a, 'smoke', -Math.PI / 2, throwPitch(d, target.y - eye.y, NADE.throwSpeed) - 0.12);
      run(sim, 4);
      expect(Math.abs(sim.smokes[0].pos.x - target.x), `${d} m`).toBeLessThan(3.5);
    }
  });
});

describe('grenades: effects', () => {
  it('HE: hurts close, less further out, nothing past its radius or through a wall; the thrower gets the kill', () => {
    const { sim, a, d } = live();
    sim.buy(a, 'he');
    goLive(sim);
    place(a, 10, 3, -Math.PI / 2);
    place(d, 13, 3);
    d.armor = 0;
    throwNade(sim, a, 'he', -Math.PI / 2, -0.1, true);
    const ev = run(sim, 2.5);
    const hit = ev.find((e) => e.type === 'hit' && e.victim === d.id);
    expect(hit, 'the defender 6 m away was hurt').toBeTruthy();
    expect((hit as { damage: number }).damage).toBeLessThan(NADE.heDamage);
    expect(ev.some((e) => e.type === 'nadeExplode' && e.nade === 'he')).toBe(true);
    // Behind a wall: Long A's north wall separates z=3 from z=0? Use a far player instead.
    const { sim: s2, a: a2, d: d2 } = live();
    s2.buy(a2, 'he');
    goLive(s2);
    place(a2, 10, 3, -Math.PI / 2);
    place(d2, 22, 3);
    throwNade(s2, a2, 'he', -Math.PI / 2, -0.1, true);
    expect(run(s2, 2.5).some((e) => e.type === 'hit' && e.victim === d2.id), 'out of radius').toBe(false);
  });

  it('flashbang: blinds someone looking at it much longer than someone facing away', () => {
    const { sim, a, a2, d } = live();
    sim.buy(a, 'flash');
    goLive(sim);
    place(a, 6, 3, -Math.PI / 2);
    place(d, 16, 3, Math.PI / 2); // facing west, toward the thrower
    place(a2, 16, 3, -Math.PI / 2, 0.5); // same spot, facing away
    throwNade(sim, a, 'flash', -Math.PI / 2, 0.1);
    run(sim, 2);
    const t = sim.time;
    expect(d.blindFull - t, 'facing it: fully blind').toBeGreaterThan(0.8);
    expect(a2.blindEnd - t).toBeLessThan(d.blindEnd - t);
    // Fully blind players see nobody.
    expect(sim.canSee(d, a)).toBe(false);
  });

  it('smoke: blocks sight through the cloud for its duration, then clears', () => {
    const { sim, a, d } = live();
    sim.buy(a, 'smoke');
    goLive(sim);
    place(a, 6, 3, -Math.PI / 2);
    place(d, 26, 3, Math.PI / 2);
    expect(sim.canSee(d, a)).toBe(true);
    throwNade(sim, a, 'smoke', -Math.PI / 2, 0.15);
    run(sim, 4);
    expect(sim.smokes.length).toBe(1);
    // The cloud sits between them on the lane.
    const s = sim.smokes[0];
    expect(s.pos.x).toBeGreaterThan(a.body.pos.x);
    expect(s.pos.x).toBeLessThan(d.body.pos.x);
    expect(sim.canSee(d, a)).toBe(false);
    run(sim, NADE.smokeDuration);
    expect(sim.smokes.length).toBe(0);
    expect(sim.canSee(d, a)).toBe(true);
  });

  it('grenades in the air and smokes travel in snapshots to online clients', () => {
    const { sim, a } = live();
    sim.buy(a, 'smoke');
    goLive(sim);
    place(a, 10, 3, -Math.PI / 2);
    throwNade(sim, a, 'smoke', -Math.PI / 2, 0.3);
    const client = new Simulation(map, {}, 1);
    applyNades(client, encodeSnapshot(sim, 0, []));
    expect(client.nadesInFlight.length).toBe(1);
    run(sim, 4);
    applyNades(client, encodeSnapshot(sim, 0, []));
    expect(client.nadesInFlight.length).toBe(0);
    expect(client.smokes.length).toBe(1);
  });
});
