import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMsg, type Snapshot } from '../src/shared/protocol';
import { emptyCmd } from '../src/shared/sim';
import { startServer, type RunningServer } from './server';

/**
 * Integration tests: a real server on a random local port, real WebSocket
 * clients. (Loopback only — no external network.)
 */

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', staticDir: null, debug: true, log: () => {} });
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  await server.close();
});

class TestClient {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  seq = 0;
  constructor() {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open(): Promise<void> {
    return new Promise((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const start = Date.now();
    for (;;) {
      const hit = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (hit) return hit as Extract<ServerMsg, { t: T }>;
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  lastSnap(): Snapshot | null {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'snap') return m.s;
    }
    return null;
  }
  async snapWhere(pred: (s: Snapshot) => boolean, ms = 5000): Promise<Snapshot> {
    const m = await this.waitFor('snap', (x) => pred(x.s), ms);
    return m.s;
  }
  cmd(over: Partial<ReturnType<typeof emptyCmd>> = {}, yaw = 0): void {
    this.send({ t: 'cmd', seq: ++this.seq, cmd: { ...emptyCmd(yaw, 0), ...over } });
  }
  close(): void {
    this.ws.close();
  }
}

async function pair(): Promise<{ a: TestClient; b: TestClient; room: string; aId: number; bId: number }> {
  const a = new TestClient();
  await a.open();
  a.send({ t: 'create', v: PROTOCOL_VERSION, name: 'Alice', team: 'A' });
  const wa = await a.waitFor('welcome');
  const b = new TestClient();
  await b.open();
  b.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Bob', room: wa.room });
  const wb = await b.waitFor('welcome');
  return { a, b, room: wa.room, aId: wa.you, bId: wb.you };
}

describe('game server', () => {
  it('creates a room with a 5-character code and lets a friend join it on the other team', async () => {
    const { a, b, room, aId, bId } = await pair();
    expect(room).toMatch(/^[A-Z2-9]{5}$/);
    const info = await a.waitFor('room', (m) => m.info.players.length === 2);
    expect(info.info.players.find((p) => p.id === aId)?.team).toBe('A');
    expect(info.info.players.find((p) => p.id === bId)?.team).toBe('D');
    // Both teams present -> the server starts round 1.
    const s = await b.snapWhere((x) => x.round === 1);
    expect(s.players).toHaveLength(2);
    a.close();
    b.close();
  });

  it('rejects unknown rooms, a third player, bad versions and malformed messages', async () => {
    const { a, b, room } = await pair();
    const c = new TestClient();
    await c.open();
    c.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Eve', room });
    expect((await c.waitFor('error')).code).toBe('room_full');
    const d = new TestClient();
    await d.open();
    d.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Eve', room: 'ZZZZZ' });
    expect((await d.waitFor('error')).code).toBe('bad_room');
    const e = new TestClient();
    await e.open();
    e.send({ t: 'create', v: 999, name: 'Old', team: 'A' });
    expect((await e.waitFor('error')).code).toBe('bad_version');
    e.ws.send('{not json');
    expect((await e.waitFor('error', (m) => m.code === 'bad_message')).code).toBe('bad_message');
    for (const x of [a, b, c, d, e]) x.close();
  });

  it('moves players only through commands, and acknowledges them', async () => {
    const { a, b, aId } = await pair();
    const s0 = await a.snapWhere((s) => s.phase === 'live', 8000);
    const p0 = s0.players.find((p) => p.id === aId)!;
    // Attackers spawn facing east (yaw -PI/2). Walk forward for ~0.5 s.
    // Sent at the client's tick rate, as a real client does.
    for (let i = 0; i < 30; i++) {
      a.cmd({ forward: 1 }, -Math.PI / 2);
      await new Promise((r) => setTimeout(r, 16));
    }
    const s1 = await a.snapWhere((s) => s.ack >= 30);
    const p1 = s1.players.find((p) => p.id === aId)!;
    expect(p1.p[0] - p0.p[0]).toBeGreaterThan(1.5);
    a.close();
    b.close();
  }, 15000);

  it('ignores client attempts to claim state (only cmds are accepted)', async () => {
    const { a, b, aId } = await pair();
    await a.snapWhere((s) => s.round === 1);
    a.send({ t: 'snap', s: { players: [{ id: aId, hp: 999 }] } });
    a.send({ t: 'cmd', seq: 1, cmd: { forward: 50, side: 0, yaw: 0, pitch: 9, fire: 'yes' } });
    const s = await a.snapWhere((x) => x.ack >= 1);
    const me = s.players.find((p) => p.id === aId)!;
    expect(me.hp).toBe(100);
    expect(Math.abs(me.pt)).toBeLessThanOrEqual(1.55);
    a.close();
    b.close();
  });

  it('judges a shot server-side: it damages the friend and the kill is reported to both', async () => {
    const { a, b, aId, bId } = await pair();
    await a.snapWhere((s) => s.phase === 'live', 8000);
    // Debug hook (test server only): line both players up in Long A, 8 m apart.
    a.send({ t: 'debug', op: 'teleport', x: 13, z: 7, yaw: -Math.PI / 2 });
    b.send({ t: 'debug', op: 'teleport', x: 21, z: 7, yaw: Math.PI / 2 });
    await new Promise((r) => setTimeout(r, 100));
    // Hold fire with the pistol (semi-auto: alternate press/release), aiming at chest height.
    for (let i = 0; i < 40; i++) {
      a.send({ t: 'cmd', seq: ++a.seq, cmd: { ...emptyCmd(-Math.PI / 2, -0.05), fire: i % 2 === 0 } });
      b.cmd({}, Math.PI / 2);
      await new Promise((r) => setTimeout(r, 16));
    }
    const s = await a.snapWhere((x) => x.players.find((p) => p.id === bId)!.hp < 100, 4000);
    expect(s.players.find((p) => p.id === bId)!.hp).toBeLessThan(100);
    const bSeesHit = await b.waitFor('snap', (m) => m.s.events.some((e) => e.type === 'hit' && e.victim === bId && e.attacker === aId));
    expect(bSeesHit).toBeTruthy();
    a.close();
    b.close();
  }, 15000);

  it('keeps the match when a player disconnects and reconnects with their token', async () => {
    const { a, b, room, bId } = await pair();
    const wb = await b.waitFor('welcome');
    await a.snapWhere((s) => s.round === 1);
    b.close();
    await a.waitFor('notice', (m) => m.text.includes('disconnected'));
    const b2 = new TestClient();
    await b2.open();
    b2.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Bob', room, token: wb.token });
    const w2 = await b2.waitFor('welcome');
    expect(w2.you).toBe(bId);
    await a.waitFor('notice', (m) => m.text.includes('reconnected'));
    const s = await b2.snapWhere((x) => x.players.length === 2 && x.round >= 1);
    expect(s.players.some((p) => p.id === bId)).toBe(true);
    a.close();
    b2.close();
  }, 15000);

  it('rematch is only accepted after the match has ended', async () => {
    const { a, b, room } = await pair();
    await a.snapWhere((s) => s.round === 1);
    a.send({ t: 'rematch' });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.msgs.some((m) => m.t === 'notice' && m.text.includes('rematch'))).toBe(false);
    const r = server.rooms.get(room)!;
    r.sim.score.A = r.sim.config.roundsToWin - 1;
    const victim = r.sim.players.find((p) => p.team === 'D')!;
    r.sim.damage(victim, r.sim.players.find((p) => p.team === 'A')!, 500, 'chest', victim.body.pos, 'p9');
    await a.snapWhere((s) => s.phase === 'matchEnd', 5000);
    b.send({ t: 'rematch' });
    const s = await a.snapWhere((x) => x.round === 1 && x.score.A === 0 && x.phase === 'freeze', 5000);
    expect(s.score.D).toBe(0);
    a.close();
    b.close();
  }, 15000);
});
