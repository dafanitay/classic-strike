import { describe, expect, it } from 'vitest';
import { buildMap } from '../shared/map';
import { DEPOT } from '../shared/maps/depot';
import { encodeSnapshot } from '../shared/protocol';
import { Simulation, emptyCmd, type PlayerCmd } from '../shared/sim';
import { makeRng } from '../shared/vec';
import { NetMirror } from './mirror';

describe('client prediction', () => {
  it('predicts every input exactly where the server puts it, despite latency and jitter', () => {
    const map = buildMap(DEPOT);
    const server = new Simulation(map, { freezeTime: 0.05 }, 1);
    const me = server.addPlayer('me', 'A', false);
    me.external = true;
    server.addPlayer('them', 'D', false);
    for (let i = 0; i < 10; i++) server.tick();
    const mirror = new NetMirror(new Simulation(map), me.id);
    mirror.applySnapshot(encodeSnapshot(server, 0, []), 0);

    const rng = makeRng(5);
    const inFlight: { arrive: number; seq: number; cmd: PlayerCmd }[] = [];
    const snaps: { arrive: number; snap: ReturnType<typeof encodeSnapshot> }[] = [];
    let yaw = -Math.PI / 2;
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
      // Wiggly input: run, strafe, jump, crouch, turn.
      yaw += Math.sin(tick / 30) * 0.03;
      const cmd: PlayerCmd = {
        ...emptyCmd(yaw, 0),
        forward: tick % 200 < 150 ? 1 : -1,
        side: Math.sin(tick / 17) > 0.3 ? 1 : 0,
        jump: tick % 90 < 3,
        crouch: tick % 240 > 220,
      };
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
      if (ack && tick % 3 === 0) snaps.push({ arrive: tick + 3, snap: encodeSnapshot(server, ack, []) });
      for (const s of snaps.filter((x) => x.arrive === tick)) mirror.applySnapshot(s.snap, tick / 60);
    }
    // Drain: no new input; let the server process everything and send a final snapshot.
    while (inFlight.length) {
      const c = inFlight.sort((a, b) => a.seq - b.seq).shift()!;
      server.tick();
      server.runCmd(me, c.cmd);
      compare(c.seq);
      mirror.applySnapshot(encodeSnapshot(server, c.seq, []), 0);
    }
    // Every input the client predicted lands exactly where the server put it
    // (snapshots round positions to 1 mm, hence the tolerance).
    expect(compared).toBeGreaterThan(500);
    expect(maxErr).toBeLessThan(0.02);
  });
});
