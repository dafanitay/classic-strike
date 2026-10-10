import { describe, expect, it } from 'vitest';
import { buildMap } from '../shared/map';
import { DEPOT } from '../shared/maps/depot';
import { encodeSnapshot } from '../shared/protocol';
import { Simulation, emptyCmd, type PlayerCmd } from '../shared/sim';
import { makeRng } from '../shared/vec';
import { NetMirror } from './mirror';

type Scenario = {
  /** Optional start cell (else the normal spawn). */
  start?: { x: number; z: number };
  yaw0: number;
  input: (tick: number, yaw: number) => PlayerCmd;
};

/** Max distance between where the client predicted each input and where the server put it. */
function predictionError(sc: Scenario): { maxErr: number; compared: number; maxY: number } {
  const map = buildMap(DEPOT);
  const server = new Simulation(map, { freezeTime: 0.05 }, 1);
  const me = server.addPlayer('me', 'A', false);
  me.external = true;
  server.addPlayer('them', 'D', false);
  for (let i = 0; i < 10; i++) server.tick();
  if (sc.start) {
    const c = map.cellCenter(sc.start.x, sc.start.z);
    me.body.pos = { x: c.x, y: c.y, z: c.z };
    me.body.onGround = true;
  }
  let maxY = 0;
  const mirror = new NetMirror(new Simulation(map), me.id);
  mirror.applySnapshot(encodeSnapshot(server, 0, [], me.id), 0);

  const rng = makeRng(5);
  const inFlight: { arrive: number; seq: number; cmd: PlayerCmd }[] = [];
  const snaps: { arrive: number; snap: ReturnType<typeof encodeSnapshot> }[] = [];
  let yaw = sc.yaw0;
  let lastArrive = 0;
  const predictedAt = new Map<number, { x: number; y: number; z: number }>();
  let maxErr = 0;
  let compared = 0;
  const compare = (seq: number) => {
    const p = predictedAt.get(seq)!;
    const e = Math.hypot(p.x - me.body.pos.x, p.y - me.body.pos.y, p.z - me.body.pos.z);
    maxErr = Math.max(maxErr, e);
    compared++;
  };
  for (let tick = 0; tick < 600; tick++) {
    const cmd = sc.input(tick, yaw);
    yaw = cmd.yaw;
    maxY = Math.max(maxY, me.body.pos.y);
    const seq = mirror.predict(cmd);
    predictedAt.set(seq, { ...mirror.me!.body.pos });
    // Jittery but in-order delivery (WebSocket runs over TCP).
    lastArrive = Math.max(lastArrive, tick + 3 + Math.floor(rng() * 4));
    inFlight.push({ arrive: lastArrive, seq, cmd });
    // Server consumes commands that have arrived, one per tick, in order.
    const ready = inFlight.filter((c) => c.arrive <= tick).sort((a, b) => a.seq - b.seq);
    let ack = 0;
    server.tick();
    if (ready.length) {
      const c = ready[0];
      inFlight.splice(inFlight.indexOf(c), 1);
      server.runCmd(me, c.cmd);
      ack = c.seq;
    }
    if (ack) compare(ack);
    if (ack && tick % 3 === 0) snaps.push({ arrive: tick + 3, snap: encodeSnapshot(server, ack, [], me.id) });
    for (const s of snaps.filter((x) => x.arrive === tick)) mirror.applySnapshot(s.snap, tick / 60);
  }
  // Drain: no new input; let the server process everything and send a final snapshot.
  while (inFlight.length) {
    const c = inFlight.sort((a, b) => a.seq - b.seq).shift()!;
    server.tick();
    server.runCmd(me, c.cmd);
    compare(c.seq);
    mirror.applySnapshot(encodeSnapshot(server, c.seq, [], me.id), 0);
  }
  return { maxErr, compared, maxY };
}

describe('client prediction', () => {
  // Every input the client predicted lands exactly where the server put it.
  // The receiving player's own body is sent unrounded, so replays are exact;
  // the tolerance only allows for floating-point noise.
  it('predicts every input exactly where the server puts it, despite latency and jitter', () => {
    const r = predictionError({
      yaw0: -Math.PI / 2,
      // Wiggly input: run, strafe, jump, crouch, turn.
      input: (tick, yaw) => ({
        ...emptyCmd(yaw + Math.sin(tick / 30) * 0.03, 0),
        forward: tick % 200 < 150 ? 1 : -1,
        side: Math.sin(tick / 17) > 0.3 ? 1 : 0,
        jump: tick % 90 < 3,
        crouch: tick % 240 > 220,
      }),
    });
    expect(r.compared).toBeGreaterThan(500);
    expect(r.maxErr).toBeLessThan(1e-6);
  });

  it('stays exact running up and down stairs (step-up and ground snapping)', () => {
    // Long A, just below the stairs onto the A Site platform; run east and back.
    const r = predictionError({
      start: { x: 25, z: 3 },
      yaw0: -Math.PI / 2,
      input: (tick, yaw) => ({
        ...emptyCmd(yaw, 0),
        forward: tick % 120 < 60 ? 1 : -1,
        side: Math.sin(tick / 11) > 0.6 ? 1 : 0,
        walk: tick % 240 > 200,
        jump: tick % 170 === 30,
      }),
    });
    expect(r.maxY).toBeGreaterThan(0.99); // really did climb onto the platform (and jumped on it)
    expect(r.compared).toBeGreaterThan(500);
    expect(r.maxErr).toBeLessThan(1e-6);
  });

  it('stays exact on every Depot staircase and ledge, with mixed input', () => {
    const starts = [
      { start: { x: 25, z: 3 }, yaw0: -Math.PI / 2 }, // Long A stairs (east)
      { start: { x: 33, z: 10 }, yaw0: 0 }, // A Ramp stairs (north)
      { start: { x: 22, z: 12 }, yaw0: 0 }, // Catwalk (north)
      { start: { x: 32, z: 17 }, yaw0: Math.PI }, // B Ramp (south)
      { start: { x: 27, z: 23 }, yaw0: -Math.PI / 2 }, // B Site -> B Doors (east)
    ];
    for (const st of starts) {
      for (const seed of [1, 2, 3]) {
        const r = predictionError({
          ...st,
          input: (tick, yaw) => ({
            ...emptyCmd(yaw + Math.sin((tick + seed * 40) / 25) * 0.02, 0),
            forward: (tick + seed * 17) % 140 < 80 ? 1 : -1,
            side: Math.sin((tick + seed * 9) / 13) > 0.5 ? 1 : Math.sin(tick / 7) < -0.8 ? -1 : 0,
            walk: (tick + seed * 31) % 200 > 170,
            crouch: (tick + seed * 23) % 260 > 240,
            jump: (tick + seed * 11) % 150 === 20,
          }),
        });
        expect(r.compared).toBeGreaterThan(500);
        expect(r.maxErr, `${JSON.stringify(st.start)} seed ${seed}`).toBeLessThan(1e-6);
      }
    }
  });
});
