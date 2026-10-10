import { randomBytes, randomInt } from 'node:crypto';
import type { WebSocket } from 'ws';
import { buildMap, type Team } from '../src/shared/map';
import { MAPS } from '../src/shared/maps/depot';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SNAPSHOT_RATE,
  encodeSnapshot,
  type ClientMsg,
  type RoomInfo,
  type ServerMsg,
} from '../src/shared/protocol';
import { Simulation, TICK_RATE, emptyCmd, type PlayerCmd, type SimEvent, type SimPlayer } from '../src/shared/sim';
import type { Vec3 } from '../src/shared/vec';
import type { WeaponSlot, WeaponState } from '../src/shared/weapons';

/**
 * One private match. The room owns an authoritative Simulation and is the
 * only place where game state changes; clients just send commands.
 */

export const MAX_HUMANS_PER_ROOM = 2;
const RECONNECT_GRACE_S = 120;
export const EMPTY_ROOM_TTL_S = 90;
const HISTORY_S = 1;
const INTERP_DELAY_S = 0.1;
const MAX_REWIND_S = 0.5;
const MAX_QUEUE = 8;

export interface Conn {
  ws: WebSocket;
  playerId: number;
  token: string;
  queue: { seq: number; cmd: PlayerCmd }[];
  lastCmd: PlayerCmd;
  ack: number;
  rtt: number;
}

interface Departed {
  playerId: number;
  name: string;
  team: Team;
  money: number;
  kills: number;
  deaths: number;
  armor: number;
  helmet: boolean;
  weapons: Partial<Record<WeaponSlot, WeaponState>>;
  until: number;
}

export function makeRoomCode(taken: (code: string) => boolean): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
}

export class Room {
  readonly code: string;
  readonly sim: Simulation;
  readonly conns = new Map<number, Conn>();
  private readonly departed = new Map<string, Departed>();
  private readonly history: { time: number; pos: Map<number, { pos: Vec3; crouched: boolean }> }[] = [];
  private pendingEvents: SimEvent[] = [];
  private tickCount = 0;
  emptySince: number | null = null;
  private readonly debug: boolean;

  constructor(code: string, debug = false) {
    this.code = code;
    this.debug = debug;
    this.sim = new Simulation(buildMap(MAPS[0]), { roundsToWin: 8 });
    this.sim.rewind = (shooter) => this.rewind(shooter);
  }

  get humanCount(): number {
    return this.conns.size;
  }

  /** Wall-clock age of the room in simulation seconds (for expiry). */
  get now(): number {
    return this.sim.time;
  }

  // ------------------------------------------------------------ membership

  join(ws: WebSocket, name: string, teamPref: Team | 'auto', token?: string): Conn | { error: 'room_full' } {
    // Reconnect with a valid token: take the old player slot back.
    const back = token ? this.departed.get(token) : undefined;
    if (back && back.until >= this.now) {
      this.departed.delete(token!);
      const p = this.sim.addPlayer(back.name, back.team, false, back.playerId);
      Object.assign(p, { money: back.money, kills: back.kills, deaths: back.deaths, armor: back.armor, helmet: back.helmet });
      p.weapons = back.weapons;
      p.current = p.weapons[1] ? 1 : 2;
      return this.attach(ws, p, token!, `${p.name} reconnected`);
    }
    // Same token while the old socket still looks open (fast reload, network
    // switch before the server noticed the drop): the new connection takes
    // over the slot and the stale socket is closed.
    const stale = token ? [...this.conns.values()].find((c) => c.token === token) : undefined;
    if (stale) {
      const p = this.sim.getPlayer(stale.playerId);
      this.conns.delete(stale.playerId); // its later 'close' is then ignored by leave()
      stale.ws.terminate();
      if (p) return this.attach(ws, p, token!, `${p.name} reconnected`);
    }
    if (this.conns.size >= MAX_HUMANS_PER_ROOM) return { error: 'room_full' };
    // Second player goes to the other team so a match can start.
    const taken = [...this.conns.values()].map((c) => this.sim.getPlayer(c.playerId)?.team);
    let team: Team = teamPref === 'auto' ? 'A' : teamPref;
    if (taken.length === 1) team = taken[0] === 'A' ? 'D' : 'A';
    const p = this.sim.addPlayer(name, team, false);
    return this.attach(ws, p, randomBytes(16).toString('hex'), `${p.name} joined`);
  }

  private attach(ws: WebSocket, p: SimPlayer, token: string, notice: string): Conn {
    const conn: Conn = { ws, playerId: p.id, token, queue: [], lastCmd: emptyCmd(p.yaw, 0), ack: 0, rtt: 0.1 };
    this.conns.set(p.id, conn);
    this.emptySince = null;
    this.send(conn, { t: 'welcome', room: this.code, you: p.id, token, mapId: this.sim.map.def.id, roundsToWin: this.sim.config.roundsToWin });
    this.broadcast({ t: 'notice', text: notice });
    this.broadcastInfo();
    return conn;
  }

  leave(conn: Conn): void {
    if (this.conns.get(conn.playerId) !== conn) return;
    this.conns.delete(conn.playerId);
    const p = this.sim.getPlayer(conn.playerId);
    if (p) {
      this.departed.set(conn.token, {
        playerId: p.id, name: p.name, team: p.team, money: p.money, kills: p.kills, deaths: p.deaths,
        armor: p.armor, helmet: p.helmet, weapons: p.weapons, until: this.now + RECONNECT_GRACE_S,
      });
      this.sim.removePlayer(p.id);
      this.broadcast({ t: 'notice', text: `${p.name} disconnected — they can rejoin with the same link` });
    }
    if (this.conns.size === 0) this.emptySince = Date.now();
    this.broadcastInfo();
  }

  info(): RoomInfo {
    const players: RoomInfo['players'] = this.sim.players.map((p) => ({ id: p.id, name: p.name, team: p.team, connected: this.conns.has(p.id) }));
    for (const d of this.departed.values()) players.push({ id: d.playerId, name: d.name, team: d.team, connected: false });
    return { code: this.code, players };
  }

  private broadcastInfo(): void {
    this.broadcast({ t: 'room', info: this.info() });
  }

  // -------------------------------------------------------------- messages

  handle(conn: Conn, msg: ClientMsg): void {
    const p = this.sim.getPlayer(conn.playerId);
    if (!p) return;
    switch (msg.t) {
      case 'cmd':
        if (msg.seq <= conn.ack || conn.queue.some((q) => q.seq === msg.seq)) return; // replay / duplicate
        conn.queue.push({ seq: msg.seq, cmd: msg.cmd });
        if (conn.queue.length > MAX_QUEUE) {
          // Too far behind: keep the newest few, carrying one-shot actions over.
          const dropped = conn.queue.splice(0, conn.queue.length - 4);
          const head = conn.queue[0].cmd;
          for (const d of dropped) {
            head.reload ||= d.cmd.reload;
            if (!head.slot && d.cmd.slot) head.slot = d.cmd.slot;
          }
        }
        break;
      case 'buy': {
        const error = this.sim.buy(p, msg.item);
        this.send(conn, { t: 'buyResult', item: msg.item, error });
        break;
      }
      case 'team':
        if (this.sim.phase === 'warmup' || this.sim.phase === 'matchEnd') {
          this.sim.setTeam(p, msg.team);
          this.broadcastInfo();
        }
        break;
      case 'rematch':
        if (this.sim.phase === 'matchEnd') {
          this.sim.startMatch();
          this.broadcast({ t: 'notice', text: `${p.name} started a rematch` });
        }
        break;
      case 'ping':
        this.send(conn, { t: 'pong', c: msg.c, s: this.sim.time });
        break;
      case 'debug':
        // Test-only hook (CS_DEBUG=1). Never enabled in deployment config.
        if (this.debug) {
          p.body.pos = { x: msg.x, y: 0, z: msg.z };
          p.body.vel = { x: 0, y: 0, z: 0 };
          p.yaw = msg.yaw;
        }
        break;
      default:
        break;
    }
  }

  noteRtt(conn: Conn, rtt: number): void {
    conn.rtt = conn.rtt * 0.8 + Math.min(1, Math.max(0, rtt)) * 0.2;
  }

  // ------------------------------------------------------------------ tick

  tick(): void {
    this.sim.events.length = 0;
    this.sim.tick();
    // Humans move only by their own commands (see SimPlayer.external): one
    // per tick normally, two when catching up after network jitter. No input
    // means no movement — never extrapolated, so prediction stays exact.
    for (const conn of this.conns.values()) {
      const p = this.sim.getPlayer(conn.playerId);
      if (!p) continue;
      p.external = true;
      const n = conn.queue.length > 2 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const next = conn.queue.shift();
        if (!next) break;
        conn.ack = next.seq;
        conn.lastCmd = next.cmd;
        this.sim.runCmd(p, next.cmd);
      }
    }
    this.pendingEvents.push(...this.sim.events);
    this.record();

    this.tickCount++;
    if (this.tickCount % Math.round(TICK_RATE / SNAPSHOT_RATE) === 0) {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      for (const conn of this.conns.values()) {
        this.send(conn, { t: 'snap', s: encodeSnapshot(this.sim, conn.ack, events) });
      }
    }
    for (const [token, d] of this.departed) if (d.until < this.now) this.departed.delete(token);
  }

  private record(): void {
    const pos = new Map<number, { pos: Vec3; crouched: boolean }>();
    for (const p of this.sim.players) pos.set(p.id, { pos: { ...p.body.pos }, crouched: p.body.crouched });
    this.history.push({ time: this.sim.time, pos });
    while (this.history.length > HISTORY_S * TICK_RATE) this.history.shift();
  }

  /**
   * Lag compensation: put everyone else back where the shooter's screen
   * showed them (shooter's round trip + the client's interpolation delay),
   * so hits are judged on what the shooter could actually aim at.
   */
  private rewind(shooter: SimPlayer): (() => void) | null {
    const conn = this.conns.get(shooter.id);
    if (!conn || !this.history.length) return null;
    const lag = Math.min(MAX_REWIND_S, conn.rtt + INTERP_DELAY_S + conn.queue.length / TICK_RATE);
    const target = this.sim.time - lag;
    let frame = this.history[0];
    for (const h of this.history) {
      if (h.time <= target) frame = h;
      else break;
    }
    const saved: { p: SimPlayer; pos: Vec3; crouched: boolean }[] = [];
    for (const p of this.sim.players) {
      if (p === shooter) continue;
      const past = frame.pos.get(p.id);
      if (!past) continue;
      saved.push({ p, pos: p.body.pos, crouched: p.body.crouched });
      p.body.pos = { ...past.pos };
      p.body.crouched = past.crouched;
    }
    return () => {
      for (const s of saved) {
        s.p.body.pos = s.pos;
        s.p.body.crouched = s.crouched;
      }
    };
  }

  // --------------------------------------------------------------- sending

  send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}
