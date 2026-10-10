import type { Team } from './map';
import type { BombState, BuyItem, Phase, PlayerCmd, SimEvent, SimPlayer, Simulation } from './sim';
import { EQUIPMENT } from './sim';
import { BUYABLE, WEAPONS, type WeaponId, type WeaponSlot } from './weapons';

/**
 * Client <-> server messages (JSON over WebSocket). The client only ever
 * sends *intent* (input commands, buy requests, team choice); every outcome
 * — movement, hits, damage, deaths, money, rounds — is decided by the
 * server's Simulation and sent back in snapshots and events.
 */

export const PROTOCOL_VERSION = 2;
export const SNAPSHOT_RATE = 20; // per second
export const MAX_MESSAGE_BYTES = 4096;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export type ClientMsg =
  | { t: 'create'; v: number; name: string; team: Team | 'auto' }
  | { t: 'join'; v: number; name: string; room: string; token?: string }
  | { t: 'cmd'; seq: number; cmd: PlayerCmd }
  | { t: 'buy'; item: BuyItem }
  | { t: 'team'; team: Team }
  | { t: 'rematch' }
  | { t: 'ping'; c: number }
  | { t: 'debug'; op: 'teleport'; x: number; z: number; yaw: number };

export interface RoomInfo {
  code: string;
  players: { id: number; name: string; team: Team; connected: boolean }[];
}

export type ServerMsg =
  | { t: 'welcome'; room: string; you: number; token: string; mapId: string; roundsToWin: number }
  | { t: 'room'; info: RoomInfo }
  | { t: 'snap'; s: Snapshot }
  | { t: 'buyResult'; item: BuyItem; error: string | null }
  | { t: 'notice'; text: string }
  | { t: 'error'; code: 'bad_room' | 'room_full' | 'bad_version' | 'bad_message' | 'server_full'; text: string }
  | { t: 'pong'; c: number; s: number };

// ------------------------------------------------------------- snapshots

/** Compact per-player state. Numbers are rounded to keep messages small. */
export interface PlayerSnap {
  id: number;
  n: string;
  tm: Team;
  b: 0 | 1; // bot
  a: 0 | 1; // alive
  p: [number, number, number];
  v: [number, number, number];
  g: 0 | 1; // on ground
  c: 0 | 1; // crouched
  j: 0 | 1; // jump held
  ls: number; // landing slow
  yw: number;
  pt: number;
  hp: number;
  ar: number;
  hm: 0 | 1;
  $: number;
  k: number;
  d: number;
  w: [WeaponSlot, WeaponId, number, number][];
  cu: WeaponSlot;
  nf: number; // next fire
  rl: number; // reload end (0 = not reloading)
  se: number; // switch end
  sc: number; // scope level
  pp: number;
  py: number;
  sa: number;
  lh: number; // last hurt
  kt: 0 | 1; // defuse kit
  ac: 0 | 1 | 2; // action: none / planting / defusing
  ae: number; // action end time
  ul: 0 | 1; // use latch
}

/** The bomb, as every client sees it (including its carrier). */
export interface BombSnap {
  s: BombState['state'];
  c: number;
  p: [number, number, number];
  st: BombState['site'];
  pa: number;
  ex: number;
  df: number;
}

export interface Snapshot {
  time: number;
  phase: Phase;
  phaseEnd: number; // -1 = infinite
  round: number;
  roundStart: number;
  score: Record<Team, number>;
  bomb: BombSnap;
  ack: number; // last cmd seq processed for the receiving player
  players: PlayerSnap[];
  events: SimEvent[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * @param exact send position and velocity unrounded. Used for the receiving
 *   player's own body: client prediction replays from it, and a 1 mm rounding
 *   can flip which tick a landing happens on (a visible 2–3 cm correction).
 */
export function encodePlayer(p: SimPlayer, exact = false): PlayerSnap {
  const w: PlayerSnap['w'] = [];
  for (const slot of [1, 2, 3] as WeaponSlot[]) {
    const ws = p.weapons[slot];
    if (ws) w.push([slot, ws.id, ws.mag, ws.reserve]);
  }
  const b = p.body;
  return {
    id: p.id, n: p.name, tm: p.team, b: p.isBot ? 1 : 0, a: p.alive ? 1 : 0,
    p: exact ? [b.pos.x, b.pos.y, b.pos.z] : [r3(b.pos.x), r3(b.pos.y), r3(b.pos.z)],
    v: exact ? [b.vel.x, b.vel.y, b.vel.z] : [r3(b.vel.x), r3(b.vel.y), r3(b.vel.z)],
    g: b.onGround ? 1 : 0, c: b.crouched ? 1 : 0, j: b.jumpHeld ? 1 : 0, ls: r3(b.landSlow),
    yw: r3(p.yaw), pt: r3(p.pitch),
    hp: p.health, ar: p.armor, hm: p.helmet ? 1 : 0, $: p.money, k: p.kills, d: p.deaths,
    w, cu: p.current, nf: r3(p.nextFire), rl: r3(p.reloadEnd), se: r3(p.switchEnd), sc: p.scope,
    pp: r3(p.punchPitch), py: r3(p.punchYaw), sa: r3(p.spreadAccum), lh: r2(p.lastHurt),
    kt: p.kit ? 1 : 0, ac: p.action === 'plant' ? 1 : p.action === 'defuse' ? 2 : 0, ae: r3(p.actionEnd), ul: p.useLatch ? 1 : 0,
  };
}

export function encodeBomb(b: BombState): BombSnap {
  return { s: b.state, c: b.carrier, p: [r3(b.pos.x), r3(b.pos.y), r3(b.pos.z)], st: b.site, pa: r3(b.plantedAt), ex: r3(b.explodeAt), df: b.defuser };
}

export function decodeBomb(s: BombSnap): BombState {
  return { state: s.s, carrier: s.c, pos: { x: s.p[0], y: s.p[1], z: s.p[2] }, site: s.st, plantedAt: s.pa, explodeAt: s.ex, defuser: s.df };
}

/** @param selfId the receiving player, whose own body is sent unrounded. */
export function encodeSnapshot(sim: Simulation, ack: number, events: SimEvent[], selfId = -1): Snapshot {
  return {
    time: r3(sim.time),
    phase: sim.phase,
    phaseEnd: Number.isFinite(sim.phaseEnd) ? r3(sim.phaseEnd) : -1,
    round: sim.round,
    roundStart: r3(sim.roundStartTime),
    score: { ...sim.score },
    bomb: encodeBomb(sim.bomb),
    ack,
    players: sim.players.map((p) => encodePlayer(p, p.id === selfId)),
    events,
  };
}

/** Applies a player snapshot onto a client-side mirror player. */
export function applyPlayer(p: SimPlayer, s: PlayerSnap, includeBody = true): void {
  p.name = s.n;
  p.team = s.tm;
  p.isBot = !!s.b;
  p.alive = !!s.a;
  if (includeBody) {
    p.body.pos = { x: s.p[0], y: s.p[1], z: s.p[2] };
    p.body.vel = { x: s.v[0], y: s.v[1], z: s.v[2] };
    p.body.onGround = !!s.g;
    p.body.crouched = !!s.c;
    p.body.jumpHeld = !!s.j;
    p.body.landSlow = s.ls;
    p.yaw = s.yw;
    p.pitch = s.pt;
  }
  p.health = s.hp;
  p.armor = s.ar;
  p.helmet = !!s.hm;
  p.money = s.$;
  p.kills = s.k;
  p.deaths = s.d;
  p.weapons = {};
  for (const [slot, id, mag, reserve] of s.w) p.weapons[slot] = { id, mag, reserve };
  p.current = s.cu;
  p.nextFire = s.nf;
  p.reloadEnd = s.rl;
  p.switchEnd = s.se;
  p.scope = s.sc;
  p.punchPitch = s.pp;
  p.punchYaw = s.py;
  p.spreadAccum = s.sa;
  p.lastHurt = s.lh;
  p.kit = !!s.kt;
  p.action = s.ac === 1 ? 'plant' : s.ac === 2 ? 'defuse' : null;
  p.actionEnd = s.ae;
  p.useLatch = !!s.ul;
}

// ------------------------------------------------------------ validation

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function sanitizeName(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  // Printable characters only; no control chars. Rendered via textContent anyway.
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  return clean || 'Player';
}

export function isRoomCode(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of v) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Strict parse of an untrusted client message. Returns null if invalid. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'create': {
      const team = m.team === 'A' || m.team === 'D' ? m.team : 'auto';
      if (!isNum(m.v)) return null;
      return { t: 'create', v: m.v, name: sanitizeName(m.name), team };
    }
    case 'join': {
      if (!isNum(m.v)) return null;
      const room = typeof m.room === 'string' ? m.room.toUpperCase() : '';
      if (!isRoomCode(room)) return null;
      const token = typeof m.token === 'string' && /^[a-f0-9]{32}$/.test(m.token) ? m.token : undefined;
      return { t: 'join', v: m.v, name: sanitizeName(m.name), room, token };
    }
    case 'cmd': {
      const c = m.cmd as Record<string, unknown> | undefined;
      if (!isNum(m.seq) || !c || typeof c !== 'object') return null;
      if (!isNum(c.yaw) || !isNum(c.pitch) || !isNum(c.forward) || !isNum(c.side)) return null;
      const slot = c.slot === 1 || c.slot === 2 || c.slot === 3 ? c.slot : 0;
      return {
        t: 'cmd',
        seq: Math.floor(m.seq),
        cmd: {
          forward: clamp(c.forward, -1, 1),
          side: clamp(c.side, -1, 1),
          jump: c.jump === true,
          crouch: c.crouch === true,
          walk: c.walk === true,
          yaw: c.yaw % (Math.PI * 2),
          pitch: clamp(c.pitch, -1.55, 1.55),
          fire: c.fire === true,
          altFire: c.altFire === true,
          reload: c.reload === true,
          slot,
          use: c.use === true,
          drop: c.drop === true,
        },
      };
    }
    case 'buy': {
      const item = m.item as string;
      const ok = (BUYABLE as string[]).includes(item) || item in EQUIPMENT;
      return ok && item in { ...WEAPONS, ...EQUIPMENT } ? { t: 'buy', item: item as BuyItem } : null;
    }
    case 'team':
      return m.team === 'A' || m.team === 'D' ? { t: 'team', team: m.team } : null;
    case 'rematch':
      return { t: 'rematch' };
    case 'ping':
      return isNum(m.c) ? { t: 'ping', c: m.c } : null;
    case 'debug':
      return m.op === 'teleport' && isNum(m.x) && isNum(m.z) && isNum(m.yaw) ? { t: 'debug', op: 'teleport', x: m.x, z: m.z, yaw: m.yaw } : null;
    default:
      return null;
  }
}
