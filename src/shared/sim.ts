import { rayAabb } from './collision';
import type { MapData, Team } from './map';
import { PHYS, bodyHeight, eyeHeight, makeBody, stepMovement, type MoveBody, type MoveInput } from './movement';
import { expandPattern, patternStep, type RecoilOffset } from './recoil';
import { add, clamp, dirFromAngles, dist, makeRng, scale, type Vec3 } from './vec';
import {
  BUYABLE,
  NADE,
  NADE_TYPES,
  WEAPONS,
  computeDamage,
  freshWeapon,
  isNade,
  type NadeType,
  type HitGroup,
  type WeaponDef,
  type WeaponId,
  type WeaponSlot,
  type WeaponState,
} from './weapons';

/**
 * The authoritative game simulation. It is pure (no DOM, no rendering, no
 * timers of its own) and runs on a fixed tick, so the very same code drives
 * single-player in the browser and, later, the multiplayer server. Every
 * participant — human or bot — is driven only through a PlayerCmd.
 */

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

export interface PlayerCmd {
  forward: number;
  side: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  yaw: number;
  pitch: number;
  fire: boolean;
  altFire: boolean;
  reload: boolean;
  slot: WeaponSlot | 0;
  /** Hold to plant (bomb carrier in a site) or defuse (defender at the bomb). */
  use: boolean;
  /** Press (one tick) to throw the bomb a step ahead, if you carry it. */
  drop?: boolean;
}

export const emptyCmd = (yaw = 0, pitch = 0): PlayerCmd => ({
  forward: 0, side: 0, jump: false, crouch: false, walk: false, yaw, pitch,
  fire: false, altFire: false, reload: false, slot: 0, use: false,
});

export interface SimPlayer {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;
  body: MoveBody;
  yaw: number;
  pitch: number;
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  money: number;
  kills: number;
  deaths: number;
  weapons: Partial<Record<WeaponSlot, WeaponState>>;
  current: WeaponSlot;
  nextFire: number;
  reloadEnd: number;
  switchEnd: number;
  spreadAccum: number;
  shotsFired: number;
  punchPitch: number;
  punchYaw: number;
  fireHeld: boolean;
  altHeld: boolean;
  scope: number;
  rescopeAt: number;
  rescopeLevel: number;
  stepAccum: number;
  lastHurt: number;
  respawnAt: number;
  /** Owns a defuse kit (Defenders only; lost on death). */
  kit: boolean;
  /** Grenades carried (slot 4 holds the selected kind). */
  nades: Record<NadeType, number>;
  nadeSel: NadeType;
  /** Flashed: fully blind until `blindFull`, then fading out until `blindEnd`. */
  blindAt: number;
  blindFull: number;
  blindEnd: number;
  /** Plant or defuse in progress, and when it completes. */
  action: 'plant' | 'defuse' | null;
  actionEnd: number;
  /**
   * Set when a plant/defuse completes; keeps movement locked until use is
   * released. Without it the server would free the player the tick the bomb
   * is planted while the client, which learns of the plant a snapshot later,
   * still holds them, and prediction would drift.
   */
  useLatch: boolean;
  cmd: PlayerCmd;
  /**
   * Network-driven player: moves only when one of its commands is run via
   * runCmd(), never on its own during tick(). This keeps the server in lock
   * step with the client's prediction regardless of packet timing.
   */
  external: boolean;
}

/** What a kill was made with: a weapon, or the bomb's explosion. */
export type KillSource = WeaponId | 'bomb';

export type BombSite = 'A' | 'B';

/** A thrown grenade (in the air or rolling). */
export interface Nade {
  id: number;
  type: NadeType;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  thrownAt: number;
  resting: boolean;
}

/** A smoke cloud: a sphere that blocks sight from `start` to `end`. */
export interface Smoke {
  id: number;
  pos: Vec3;
  start: number;
  end: number;
}

/**
 * The bomb ("the charge"). One per round; given to a random Attacker at the
 * round start, dropped where its carrier dies, picked up by walking over it.
 */
export interface BombState {
  state: 'none' | 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  carrier: number; // player id, 0 = nobody
  pos: Vec3; // where it lies (dropped / planted)
  site: BombSite | null;
  plantedAt: number;
  explodeAt: number;
  defuser: number; // player id currently defusing, 0 = nobody
}

export const BOMB = {
  plantTime: 3.2,
  fuse: 40,
  defuseTime: 10,
  kitDefuseTime: 5,
  /** Horizontal reach to defuse or pick up. */
  defuseReach: 1.5,
  pickupReach: 1.0,
  /** Explosion: lethal near the bomb, falling to 0 at this radius. */
  blastRadius: 20,
  blastDamage: 500,
  plantReward: 300,
  defuseReward: 300,
  /** Extra money for every Attacker if the bomb was planted but they lost. */
  plantedLossBonus: 800,
} as const;

export type SimEvent =
  | { type: 'shot'; shooter: number; weapon: WeaponId; origin: Vec3; end: Vec3; hitWorld: boolean; normal?: Vec3 }
  | { type: 'melee'; shooter: number; hit: boolean; pos: Vec3 }
  | { type: 'hit'; attacker: number; victim: number; damage: number; group: HitGroup; pos: Vec3 }
  | { type: 'kill'; killer: number; victim: number; weapon: KillSource; headshot: boolean }
  | { type: 'reload'; player: number; weapon: WeaponId }
  | { type: 'dryfire'; player: number }
  | { type: 'switch'; player: number; weapon: WeaponId }
  | { type: 'scope'; player: number; level: number }
  | { type: 'step'; player: number; pos: Vec3; walk: boolean }
  | { type: 'jump'; player: number; pos: Vec3 }
  | { type: 'land'; player: number; pos: Vec3 }
  | { type: 'buy'; player: number; item: string }
  | { type: 'bombPickup'; player: number }
  | { type: 'bombDrop'; player: number; pos: Vec3 }
  | { type: 'plantStart'; player: number; site: BombSite }
  | { type: 'defuseStart'; player: number; kit: boolean }
  | { type: 'actionAbort'; player: number; action: 'plant' | 'defuse' }
  | { type: 'planted'; player: number; site: BombSite; pos: Vec3 }
  | { type: 'defused'; player: number }
  | { type: 'exploded'; pos: Vec3 }
  | { type: 'nadeThrow'; player: number; nade: NadeType }
  | { type: 'nadeBounce'; nade: NadeType; pos: Vec3 }
  | { type: 'nadeExplode'; nade: NadeType; pos: Vec3 }
  | { type: 'roundStart'; round: number }
  | { type: 'freezeEnd' }
  | { type: 'roundEnd'; winner: Team | null; reason: string }
  | { type: 'matchEnd'; winner: Team | null };

export type Phase = 'warmup' | 'freeze' | 'live' | 'roundEnd' | 'matchEnd';

export interface MatchConfig {
  roundsToWin: number;
  freezeTime: number;
  roundTime: number;
  buyTime: number;
  roundEndTime: number;
  startMoney: number;
  maxMoney: number;
  winReward: number;
  lossBase: number;
  lossStep: number;
  friendlyFire: boolean;
  /** Bomb defusal (true) or plain elimination (false). */
  bomb: boolean;
}

export const DEFAULT_MATCH: MatchConfig = {
  roundsToWin: 8,
  freezeTime: 4,
  roundTime: 115,
  buyTime: 20,
  roundEndTime: 5,
  startMoney: 800,
  maxMoney: 16000,
  winReward: 3250,
  lossBase: 1400,
  lossStep: 500,
  friendlyFire: false,
  bomb: true,
};

export const TEAM_NAME: Record<Team, string> = { A: 'Attackers', D: 'Defenders' };
export const otherTeam = (t: Team): Team => (t === 'A' ? 'D' : 'A');

export const EQUIPMENT = {
  kevlar: { name: 'Kevlar Vest', price: 650 },
  helmet: { name: 'Kevlar + Helmet', price: 1000 },
  ammo1: { name: 'Primary Ammo', price: 80 },
  ammo2: { name: 'Secondary Ammo', price: 40 },
  defuser: { name: 'Defuse Kit', price: 400 },
} as const;
export type EquipmentId = keyof typeof EQUIPMENT;
export type BuyItem = WeaponId | EquipmentId;

const patternCache = new Map<WeaponId, RecoilOffset[]>();
/** The expanded, per-shot spray pattern of a weapon (cached). */
export function sprayPattern(def: WeaponDef): RecoilOffset[] {
  let p = patternCache.get(def.id);
  if (!p) {
    p = expandPattern(def.recoilPattern, Math.max(1, def.magSize));
    patternCache.set(def.id, p);
  }
  return p;
}

function cloneWeapons(w: SimPlayer['weapons']): SimPlayer['weapons'] {
  const out: SimPlayer['weapons'] = {};
  for (const k of [1, 2, 3, 4] as WeaponSlot[]) if (w[k]) out[k] = { ...w[k]! };
  return out;
}

export interface Hitbox {
  group: HitGroup;
  min: Vec3;
  max: Vec3;
}

/** Hitboxes scale with stance; they are narrower than the movement hull. */
export function hitboxes(p: SimPlayer): Hitbox[] {
  const h = bodyHeight(p.body);
  const { x, y, z } = p.body.pos;
  const box = (group: HitGroup, y0: number, y1: number, hw: number): Hitbox => ({
    group,
    min: { x: x - hw, y: y + y0, z: z - hw },
    max: { x: x + hw, y: y + y1, z: z + hw },
  });
  return [
    box('head', h * 0.83, h * 1.0, 0.13),
    box('chest', h * 0.6, h * 0.83, 0.26),
    box('stomach', h * 0.42, h * 0.6, 0.24),
    box('legs', 0, h * 0.42, 0.2),
  ];
}

export class Simulation {
  readonly map: MapData;
  readonly config: MatchConfig;
  readonly players: SimPlayer[] = [];
  readonly events: SimEvent[] = [];
  time = 0;
  phase: Phase = 'warmup';
  phaseEnd = 0;
  round = 0;
  roundStartTime = 0;
  score: Record<Team, number> = { A: 0, D: 0 };
  lossStreak: Record<Team, number> = { A: 0, D: 0 };
  lastWinner: Team | null = null;
  lastReason = '';
  bomb: BombState = { state: 'none', carrier: 0, pos: { x: 0, y: 0, z: 0 }, site: null, plantedAt: 0, explodeAt: 0, defuser: 0 };
  /** Grenades in the air or rolling, and smoke clouds. */
  nadesInFlight: Nade[] = [];
  smokes: Smoke[] = [];
  private nadeSeq = 0;
  /** Who last threw the bomb, and until when they can't pick it back up. */
  private dropGuard = { id: 0, until: 0 };
  private nextId = 1;
  private readonly rng: () => number;
  /**
   * Lag compensation (server only). Called before a shot is traced; may move
   * other players back to where the shooter saw them, returning a function
   * that restores them afterwards.
   */
  rewind: ((shooter: SimPlayer) => (() => void) | null) | null = null;

  constructor(map: MapData, config: Partial<MatchConfig> = {}, seed = Date.now()) {
    this.map = map;
    this.config = { ...DEFAULT_MATCH, ...config };
    this.rng = makeRng(seed);
  }

  random(): number {
    return this.rng();
  }

  // ---------------------------------------------------------------- players

  /** `id` is only passed by network clients mirroring the server's ids. */
  addPlayer(name: string, team: Team, isBot: boolean, id?: number): SimPlayer {
    if (id !== undefined) this.nextId = Math.max(this.nextId, id + 1);
    const p: SimPlayer = {
      id: id ?? this.nextId++,
      name,
      team,
      isBot,
      body: makeBody({ x: 0, y: 0, z: 0 }),
      yaw: 0,
      pitch: 0,
      alive: false,
      health: 100,
      armor: 0,
      helmet: false,
      money: this.config.startMoney,
      kills: 0,
      deaths: 0,
      weapons: {},
      current: 2,
      nextFire: 0,
      reloadEnd: 0,
      switchEnd: 0,
      spreadAccum: 0,
      shotsFired: 0,
      punchPitch: 0,
      punchYaw: 0,
      fireHeld: false,
      altHeld: false,
      scope: 0,
      rescopeAt: 0,
      rescopeLevel: 0,
      stepAccum: 0,
      lastHurt: -10,
      respawnAt: 0,
      kit: false,
      nades: { he: 0, flash: 0, smoke: 0 },
      nadeSel: 'he',
      blindAt: -10,
      blindFull: -10,
      blindEnd: -10,
      action: null,
      actionEnd: 0,
      useLatch: false,
      cmd: emptyCmd(),
      external: false,
    };
    this.players.push(p);
    this.giveDefaultLoadout(p);
    if (this.phase === 'warmup') this.spawn(p, this.players.filter((q) => q.team === team).length - 1);
    return p;
  }

  removePlayer(id: number): void {
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.stopAction(this.players[i]);
    this.dropBomb(this.players[i]);
    this.players.splice(i, 1);
  }

  setTeam(p: SimPlayer, team: Team): void {
    if (p.team === team) return;
    this.stopAction(p);
    this.dropBomb(p);
    p.kit = false;
    p.team = team;
    p.alive = false;
    p.respawnAt = this.time + 1;
  }

  getPlayer(id: number): SimPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  private giveDefaultLoadout(p: SimPlayer): void {
    p.weapons = { 2: freshWeapon('p9'), 3: freshWeapon('knife') };
    p.current = 2;
    p.nades = { he: 0, flash: 0, smoke: 0 };
  }

  /**
   * Slot 4 mirrors the grenade belt: it holds the selected kind (with how
   * many are left as its "magazine"), moves on to another kind when one runs
   * out, and disappears when none are left.
   */
  private syncNadeSlot(p: SimPlayer): void {
    if (p.nades[p.nadeSel] <= 0) p.nadeSel = NADE_TYPES.find((t) => p.nades[t] > 0) ?? p.nadeSel;
    if (p.nades[p.nadeSel] > 0) {
      p.weapons[4] = { id: p.nadeSel, mag: p.nades[p.nadeSel], reserve: 0 };
      if (p.current === 4 && p.weapons[4].id !== p.nadeSel) p.weapons[4].id = p.nadeSel;
      return;
    }
    delete p.weapons[4];
    if (p.current === 4) this.selectSlot(p, p.weapons[1] ? 1 : p.weapons[2] ? 2 : 3, true);
  }

  private spawn(p: SimPlayer, index: number): void {
    const spots = this.map.def.spawns[p.team];
    const s = spots[((index % spots.length) + spots.length) % spots.length];
    const c = this.map.cellCenter(s.x, s.z);
    p.body = makeBody({ x: c.x, y: c.y + 0.02, z: c.z });
    p.body.onGround = true;
    p.yaw = p.team === 'A' ? -Math.PI / 2 : Math.PI / 2;
    p.pitch = 0;
    p.alive = true;
    p.health = 100;
    p.nextFire = 0;
    p.reloadEnd = 0;
    p.switchEnd = this.time + 0.3;
    p.spreadAccum = 0;
    p.shotsFired = 0;
    p.punchPitch = 0;
    p.punchYaw = 0;
    p.scope = 0;
    p.rescopeAt = 0;
    p.fireHeld = true; // avoid firing from a held button the instant you spawn
    p.action = null;
    p.actionEnd = 0;
    p.useLatch = false;
    p.blindAt = p.blindFull = p.blindEnd = -10;
    p.cmd = emptyCmd(p.yaw, 0);
    if (!p.weapons[p.current]) p.current = p.weapons[1] ? 1 : 2;
  }

  weaponOf(p: SimPlayer): WeaponDef {
    const w = p.weapons[p.current];
    return WEAPONS[w ? w.id : 'knife'];
  }

  eyePos(p: SimPlayer): Vec3 {
    return { x: p.body.pos.x, y: p.body.pos.y + eyeHeight(p.body), z: p.body.pos.z };
  }

  maxSpeedOf(p: SimPlayer): number {
    const def = this.weaponOf(p);
    if (p.scope > 0 && def.scope) return def.scope.scopedSpeed;
    return def.maxSpeed;
  }

  /** Current cone half-angle for the active weapon. */
  spreadOf(p: SimPlayer): number {
    const def = this.weaponOf(p);
    const speed = Math.hypot(p.body.vel.x, p.body.vel.z);
    const moveFrac = clamp((speed - 0.8) / (PHYS.maxSpeed - 0.8), 0, 1);
    let s: number;
    if (def.scope && p.scope > 0) s = def.scope.scopedSpread + def.spreadMove * moveFrac * 1.5;
    else s = def.spreadBase + def.spreadMove * moveFrac + Math.min(p.spreadAccum, def.spreadMax);
    if (!p.body.onGround) s += def.spreadAir;
    if (p.body.crouched && p.body.onGround) s *= def.crouchFactor;
    return s;
  }

  isReloading(p: SimPlayer): boolean {
    return p.reloadEnd > 0;
  }

  canBuy(p: SimPlayer): boolean {
    if (!p.alive) return false;
    const inTime =
      this.phase === 'warmup' || this.phase === 'freeze' ||
      (this.phase === 'live' && this.time - this.roundStartTime < this.config.buyTime);
    return inTime && this.map.inRect(p.body.pos, this.map.def.buyZones[p.team]);
  }

  priceOf(item: BuyItem): number {
    if (item in EQUIPMENT) return EQUIPMENT[item as EquipmentId].price;
    return WEAPONS[item as WeaponId].price;
  }

  /** Validates and applies a purchase. Returns an error string or null. */
  buy(p: SimPlayer, item: BuyItem): string | null {
    if (!this.canBuy(p)) return 'You can only buy in your spawn zone during buy time.';
    let price = this.priceOf(item);
    if (item === 'helmet') {
      if (p.helmet && p.armor >= 100) return 'You already have full armour and a helmet.';
      if (p.armor >= 100) price = 350; // helmet only
    } else if (item === 'kevlar') {
      if (p.armor >= 100) return 'You already have full armour.';
    } else if (item === 'defuser') {
      if (p.team !== 'D') return 'Only Defenders can carry a defuse kit.';
      if (p.kit) return 'You already have a defuse kit.';
    } else if (item === 'ammo1' || item === 'ammo2') {
      const w = p.weapons[item === 'ammo1' ? 1 : 2];
      if (!w) return 'No weapon in that slot.';
      if (w.reserve >= WEAPONS[w.id].reserve) return 'Ammo is already full.';
    } else if (isNade(item as WeaponId)) {
      const t = item as NadeType;
      if (p.nades[t] >= NADE.max[t]) return `You can't carry more ${WEAPONS[t].name}s.`;
    } else {
      const def = WEAPONS[item as WeaponId];
      if (!def || !BUYABLE.includes(def.id)) return 'Unknown item.';
      if (def.team && def.team !== p.team) return `${def.name} is not available to your team.`;
      if (p.weapons[def.slot]?.id === def.id) return `You already carry the ${def.name}.`;
    }
    if (p.money < price) return 'Not enough money.';
    p.money -= price;
    if (item === 'kevlar') p.armor = 100;
    else if (item === 'defuser') p.kit = true;
    else if (item === 'helmet') {
      p.armor = 100;
      p.helmet = true;
    } else if (item === 'ammo1' || item === 'ammo2') {
      const w = p.weapons[item === 'ammo1' ? 1 : 2]!;
      w.reserve = WEAPONS[w.id].reserve;
    } else if (isNade(item as WeaponId)) {
      const t = item as NadeType;
      p.nades[t]++;
      if (!p.weapons[4]) p.nadeSel = t;
      this.syncNadeSlot(p);
    } else {
      const def = WEAPONS[item as WeaponId];
      p.weapons[def.slot] = freshWeapon(def.id);
      this.selectSlot(p, def.slot, true);
    }
    this.events.push({ type: 'buy', player: p.id, item });
    return null;
  }

  // ------------------------------------------------------------------ rounds

  aliveCount(team: Team): number {
    return this.players.filter((p) => p.team === team && p.alive).length;
  }

  teamSize(team: Team): number {
    return this.players.filter((p) => p.team === team).length;
  }

  timeLeft(): number {
    return Math.max(0, this.phaseEnd - this.time);
  }

  /** Starts round 1 from scratch (also used for rematch / restart match). */
  startMatch(): void {
    this.score = { A: 0, D: 0 };
    this.lossStreak = { A: 0, D: 0 };
    this.round = 0;
    for (const p of this.players) {
      p.money = this.config.startMoney;
      p.kills = 0;
      p.deaths = 0;
      p.armor = 0;
      p.helmet = false;
      p.kit = false;
      this.giveDefaultLoadout(p);
    }
    this.startRound();
  }

  /** Restarts the current round with everyone's state as it was at its start. */
  restartRound(): void {
    const snap = this.roundSnapshot;
    if (!snap) return this.startMatch();
    this.score = { ...snap.score };
    this.lossStreak = { ...snap.lossStreak };
    for (const p of this.players) {
      const s = snap.players.get(p.id);
      if (s) {
        p.money = s.money;
        p.armor = s.armor;
        p.helmet = s.helmet;
        p.kit = s.kit;
        p.kills = s.kills;
        p.deaths = s.deaths;
        p.weapons = cloneWeapons(s.weapons);
        p.current = s.current;
        p.nades = { ...s.nades };
        p.alive = true; // keep the restored kit instead of the default one
      } else {
        p.alive = false;
      }
    }
    this.round = Math.max(0, this.round - 1);
    this.startRound();
  }

  private roundSnapshot: {
    score: Record<Team, number>;
    lossStreak: Record<Team, number>;
    players: Map<number, { money: number; armor: number; helmet: boolean; kit: boolean; kills: number; deaths: number; weapons: SimPlayer['weapons']; current: WeaponSlot; nades: Record<NadeType, number> }>;
  } | null = null;

  startRound(): void {
    if (this.teamSize('A') === 0 || this.teamSize('D') === 0) {
      this.phase = 'warmup';
      this.bomb = { state: 'none', carrier: 0, pos: { x: 0, y: 0, z: 0 }, site: null, plantedAt: 0, explodeAt: 0, defuser: 0 };
      for (const p of this.players) if (!p.alive) p.respawnAt = this.time;
      return;
    }
    this.round++;
    const counters: Record<Team, number> = { A: 0, D: 0 };
    const order = [...this.players].sort(() => this.rng() - 0.5);
    for (const p of order) {
      if (!p.alive) {
        p.armor = 0;
        p.helmet = false;
        p.kit = false;
        this.giveDefaultLoadout(p);
      }
      this.spawn(p, counters[p.team]++);
    }
    this.bomb = { state: 'none', carrier: 0, pos: { x: 0, y: 0, z: 0 }, site: null, plantedAt: 0, explodeAt: 0, defuser: 0 };
    this.dropGuard = { id: 0, until: 0 };
    this.nadesInFlight = [];
    this.smokes = [];
    if (this.config.bomb) {
      const attackers = order.filter((p) => p.team === 'A');
      if (attackers.length) {
        this.bomb.state = 'carried';
        this.bomb.carrier = attackers[Math.floor(this.rng() * attackers.length)].id;
      }
    }
    this.roundSnapshot = {
      score: { ...this.score },
      lossStreak: { ...this.lossStreak },
      players: new Map(
        this.players.map((p) => [
          p.id,
          { money: p.money, armor: p.armor, helmet: p.helmet, kit: p.kit, kills: p.kills, deaths: p.deaths, weapons: cloneWeapons(p.weapons), current: p.current, nades: { ...p.nades } },
        ]),
      ),
    };
    this.phase = 'freeze';
    this.phaseEnd = this.time + this.config.freezeTime;
    this.roundStartTime = this.phaseEnd;
    this.events.push({ type: 'roundStart', round: this.round });
  }

  private endRound(winner: Team | null, reason: string): void {
    this.phase = 'roundEnd';
    this.phaseEnd = this.time + this.config.roundEndTime;
    this.lastWinner = winner;
    this.lastReason = reason;
    if (winner) {
      const loser = otherTeam(winner);
      this.score[winner]++;
      this.lossStreak[winner] = 0;
      const lossBonus = this.config.lossBase + this.config.lossStep * Math.min(this.lossStreak[loser], 4);
      this.lossStreak[loser]++;
      const plantedBonus = winner === 'D' && (this.bomb.state === 'planted' || this.bomb.state === 'defused') ? BOMB.plantedLossBonus : 0;
      for (const p of this.players) {
        const add = p.team === winner ? this.config.winReward : lossBonus + (p.team === 'A' ? plantedBonus : 0);
        p.money = Math.min(this.config.maxMoney, p.money + add);
      }
    }
    for (const p of this.players) {
      p.action = null;
      p.actionEnd = 0;
    }
    this.bomb.defuser = 0;
    this.events.push({ type: 'roundEnd', winner, reason });
    if (winner && this.score[winner] >= this.config.roundsToWin) {
      this.phase = 'matchEnd';
      this.phaseEnd = Infinity;
      this.events.push({ type: 'matchEnd', winner });
    }
  }

  private updatePhase(): void {
    switch (this.phase) {
      case 'warmup': {
        for (const p of this.players) {
          if (!p.alive && this.time >= p.respawnAt) {
            this.spawn(p, Math.floor(this.rng() * 10));
          }
        }
        // Both teams present: start a match, or carry on the current one if a
        // player rejoined after a disconnect.
        if (this.teamSize('A') > 0 && this.teamSize('D') > 0) {
          if (this.round === 0) this.startMatch();
          else this.startRound();
        }
        break;
      }
      case 'freeze':
        if (this.time >= this.phaseEnd) {
          this.phase = 'live';
          this.phaseEnd = this.time + this.config.roundTime;
          this.events.push({ type: 'freezeEnd' });
        }
        break;
      case 'live': {
        const a = this.aliveCount('A');
        const d = this.aliveCount('D');
        if (this.bomb.state === 'planted') {
          // Once planted, only the bomb or the Defenders being wiped out end
          // the round: dead Attackers no longer matter.
          if (this.time >= this.bomb.explodeAt) this.explode();
          else if (d === 0) this.endRound('A', `${TEAM_NAME.A} eliminated the enemy`);
        } else if (a === 0 && d === 0) this.endRound(null, 'Round draw');
        else if (a === 0) this.endRound('D', `${TEAM_NAME.D} eliminated the enemy`);
        else if (d === 0) this.endRound('A', `${TEAM_NAME.A} eliminated the enemy`);
        else if (this.time >= this.phaseEnd) this.endRound('D', this.config.bomb ? 'Time ran out — the bomb was not planted' : 'Time ran out — Defenders hold');
        break;
      }
      case 'roundEnd':
        if (this.time >= this.phaseEnd) this.startRound();
        break;
      case 'matchEnd':
        break;
    }
  }

  // -------------------------------------------------------------------- tick

  /** Advances the world by one fixed tick using each player's latest cmd. */
  tick(): void {
    this.time += TICK_DT;
    this.updatePhase();
    for (const p of this.players) {
      if (!p.alive || p.external) continue;
      this.tickPlayer(p);
    }
    this.tickNades();
  }

  /** Runs one command for an external (networked) player within the current tick. */
  runCmd(p: SimPlayer, cmd: PlayerCmd): void {
    p.cmd = cmd;
    if (p.alive) this.tickPlayer(p);
  }

  setCmd(p: SimPlayer, cmd: PlayerCmd): void {
    p.cmd = cmd;
  }

  /**
   * The movement input a command produces this tick. Shared with client
   * prediction (NetMirror) so both apply the same locks: nobody moves during
   * the freeze, and a player planting or defusing stands still. Call once per
   * command, first: it also releases the use latch when use is let go.
   */
  movementInput(p: SimPlayer, cmd: PlayerCmd): MoveInput {
    if (!cmd.use) p.useLatch = false;
    const frozen = this.phase === 'freeze' || this.phase === 'matchEnd';
    if (frozen || this.actionLocked(p, cmd)) return { forward: 0, side: 0, jump: false, crouch: cmd.crouch, walk: false, yaw: cmd.yaw };
    return { forward: cmd.forward, side: cmd.side, jump: cmd.jump, crouch: cmd.crouch, walk: cmd.walk, yaw: cmd.yaw };
  }

  /** True while holding use plants or defuses, or still holds after finishing (locks movement). */
  actionLocked(p: SimPlayer, cmd: PlayerCmd): boolean {
    return cmd.use && (p.useLatch || this.canPlant(p) !== null || this.canDefuse(p));
  }

  /** The site the player could plant at right now, or null. */
  canPlant(p: SimPlayer): BombSite | null {
    if (this.phase !== 'live' || !p.alive || !p.body.onGround) return null;
    if (this.bomb.state !== 'carried' || this.bomb.carrier !== p.id) return null;
    for (const site of ['A', 'B'] as const) if (this.map.inRect(p.body.pos, this.map.def.bombsites[site])) return site;
    return null;
  }

  canDefuse(p: SimPlayer): boolean {
    if (this.phase !== 'live' || !p.alive || p.team !== 'D' || !p.body.onGround) return false;
    if (this.bomb.state !== 'planted' || (this.bomb.defuser !== 0 && this.bomb.defuser !== p.id)) return false;
    const b = this.bomb.pos;
    return Math.hypot(p.body.pos.x - b.x, p.body.pos.z - b.z) <= BOMB.defuseReach && Math.abs(p.body.pos.y - b.y) < 1.2;
  }

  private tickPlayer(p: SimPlayer): void {
    const cmd = p.cmd;
    p.yaw = cmd.yaw;
    p.pitch = clamp(cmd.pitch, -1.55, 1.55);
    const frozen = this.phase === 'freeze' || this.phase === 'matchEnd';

    const moveIn = this.movementInput(p, cmd);
    const locked = this.actionLocked(p, cmd);
    const before = { ...p.body.pos };
    const mv = stepMovement(this.map.world, p.body, moveIn, this.maxSpeedOf(p), TICK_DT);
    if (mv.jumped) this.events.push({ type: 'jump', player: p.id, pos: { ...p.body.pos } });
    if (mv.landed) this.events.push({ type: 'land', player: p.id, pos: { ...p.body.pos } });
    if (p.body.onGround) {
      const moved = Math.hypot(p.body.pos.x - before.x, p.body.pos.z - before.z);
      const speed = moved / TICK_DT;
      if (speed > 1.5) {
        p.stepAccum += moved;
        if (p.stepAccum > 2.1) {
          p.stepAccum = 0;
          this.events.push({ type: 'step', player: p.id, pos: { ...p.body.pos }, walk: speed < 150 * 0.0254 });
        }
      }
    }
    if (p.body.pos.y < -20) this.damage(p, null, 1000, 'chest', p.body.pos, 'knife');
    if (!p.alive) return;

    this.tickAction(p, cmd);
    if (cmd.drop && !p.action) this.throwBomb(p);
    if (this.bomb.state === 'dropped' && p.team === 'A' && this.phase === 'live') {
      const b = this.bomb.pos;
      const justThrown = this.dropGuard.id === p.id && this.time < this.dropGuard.until;
      if (!justThrown && Math.hypot(p.body.pos.x - b.x, p.body.pos.z - b.z) <= BOMB.pickupReach && Math.abs(p.body.pos.y - b.y) < 1.5) {
        this.bomb.state = 'carried';
        this.bomb.carrier = p.id;
        this.events.push({ type: 'bombPickup', player: p.id });
      }
    }
    // Planting and defusing occupy your hands.
    this.tickWeapon(p, locked ? { ...cmd, fire: false, altFire: false, reload: false } : cmd, frozen);
  }

  /** Progress, completion or cancellation of a plant / defuse. */
  private tickAction(p: SimPlayer, cmd: PlayerCmd): void {
    const site = cmd.use ? this.canPlant(p) : null;
    const kind = !cmd.use ? null : site ? 'plant' : this.canDefuse(p) ? 'defuse' : null;
    if (p.action && p.action !== kind) {
      this.events.push({ type: 'actionAbort', player: p.id, action: p.action });
      if (p.action === 'defuse' && this.bomb.defuser === p.id) this.bomb.defuser = 0;
      p.action = null;
      p.actionEnd = 0;
    }
    if (!kind) return;
    if (!p.action) {
      p.action = kind;
      if (kind === 'plant') {
        p.actionEnd = this.time + BOMB.plantTime;
        this.events.push({ type: 'plantStart', player: p.id, site: site! });
      } else {
        p.actionEnd = this.time + (p.kit ? BOMB.kitDefuseTime : BOMB.defuseTime);
        this.bomb.defuser = p.id;
        this.events.push({ type: 'defuseStart', player: p.id, kit: p.kit });
      }
    }
    if (this.time + 1e-9 < p.actionEnd) return;
    p.action = null;
    p.actionEnd = 0;
    p.useLatch = true;
    if (kind === 'plant') {
      const pos = { x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z };
      this.bomb = { state: 'planted', carrier: 0, pos, site: site!, plantedAt: this.time, explodeAt: this.time + BOMB.fuse, defuser: 0 };
      this.phaseEnd = this.bomb.explodeAt; // the round clock becomes the fuse
      p.money = Math.min(this.config.maxMoney, p.money + BOMB.plantReward);
      this.events.push({ type: 'planted', player: p.id, site: site!, pos: { ...pos } });
    } else {
      this.bomb.state = 'defused';
      this.bomb.defuser = 0;
      p.money = Math.min(this.config.maxMoney, p.money + BOMB.defuseReward);
      this.events.push({ type: 'defused', player: p.id });
      this.endRound('D', 'The bomb has been defused');
    }
  }

  /** Cancels a plant/defuse in progress, freeing the bomb for another defuser. */
  private stopAction(p: SimPlayer): void {
    if (this.bomb.defuser === p.id) this.bomb.defuser = 0;
    p.action = null;
    p.actionEnd = 0;
    p.useLatch = false;
  }

  /**
   * The carrier throws the bomb about a metre ahead (G), for a teammate to
   * pick up. It never lands inside a wall or crate: if the way ahead is
   * blocked it drops at the carrier's feet. The thrower can't take it back
   * for a second, so walking forward doesn't pick it straight up again.
   */
  private throwBomb(p: SimPlayer): void {
    if (this.bomb.state !== 'carried' || this.bomb.carrier !== p.id) return;
    const dir = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
    const from = { x: p.body.pos.x, y: p.body.pos.y + 0.5, z: p.body.pos.z };
    let pos = { x: p.body.pos.x, y: this.map.surfaceY(p.body.pos), z: p.body.pos.z };
    for (const reach of [1.3, 0.8]) {
      const at = { x: from.x + dir.x * reach, z: from.z + dir.z * reach };
      const c = this.map.cellOf(at);
      if (!this.map.walkable(c.x, c.z)) continue;
      // Clear of walls and crates at knee height, with a body's width of margin.
      const probe = { x: at.x + dir.x * 0.25, y: from.y, z: at.z + dir.z * 0.25 };
      if (!this.map.world.lineOfSight(from, probe)) continue;
      pos = { x: at.x, y: this.map.surfaceY(at), z: at.z };
      break;
    }
    this.bomb.state = 'dropped';
    this.bomb.carrier = 0;
    this.bomb.pos = pos;
    this.dropGuard = { id: p.id, until: this.time + 1 };
    this.events.push({ type: 'bombDrop', player: p.id, pos: { ...pos } });
  }

  /** Drops the bomb where its carrier stands (on death, leaving, team change). */
  private dropBomb(p: SimPlayer): void {
    if (this.bomb.state !== 'carried' || this.bomb.carrier !== p.id) return;
    const pos = { x: p.body.pos.x, y: this.map.surfaceY(p.body.pos), z: p.body.pos.z };
    this.bomb.state = 'dropped';
    this.bomb.carrier = 0;
    this.bomb.pos = pos;
    this.events.push({ type: 'bombDrop', player: p.id, pos: { ...pos } });
  }

  private explode(): void {
    const b = this.bomb.pos;
    this.bomb.state = 'exploded';
    this.bomb.defuser = 0;
    this.events.push({ type: 'exploded', pos: { ...b } });
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.body.pos.x - b.x, p.body.pos.y + 1 - b.y, p.body.pos.z - b.z);
      if (d >= BOMB.blastRadius) continue;
      const k = 1 - d / BOMB.blastRadius;
      let dmg = BOMB.blastDamage * k * k;
      // Armour absorbs part of the blast, as it does a bullet to the chest.
      if (p.armor > 0) {
        const absorbed = Math.min(p.armor * 2, dmg * 0.5);
        p.armor = Math.max(0, Math.round(p.armor - absorbed / 2));
        dmg -= absorbed;
      }
      if (dmg >= 1) this.damage(p, null, Math.round(dmg), 'chest', { ...p.body.pos }, 'bomb');
    }
    this.endRound('A', 'Target destroyed');
  }

  selectSlot(p: SimPlayer, slot: WeaponSlot, force = false): void {
    if (slot === 4 && p.current === 4 && !force && p.weapons[4]) {
      // Pressing the grenade key again cycles through the kinds you carry.
      const i = NADE_TYPES.indexOf(p.nadeSel);
      const next = [1, 2].map((k) => NADE_TYPES[(i + k) % 3]).find((t) => p.nades[t] > 0);
      if (!next) return;
      p.nadeSel = next;
      this.syncNadeSlot(p);
      p.switchEnd = this.time + WEAPONS[next].drawTime;
      this.events.push({ type: 'switch', player: p.id, weapon: next });
      return;
    }
    if ((!force && slot === p.current) || !p.weapons[slot]) return;
    p.current = slot;
    p.reloadEnd = 0;
    p.scope = 0;
    p.rescopeAt = 0;
    p.switchEnd = this.time + WEAPONS[p.weapons[slot]!.id].drawTime;
    p.shotsFired = 0;
    p.punchPitch = 0;
    p.punchYaw = 0;
    p.spreadAccum = 0;
    this.events.push({ type: 'switch', player: p.id, weapon: p.weapons[slot]!.id });
  }

  private tickWeapon(p: SimPlayer, cmd: PlayerCmd, frozen: boolean): void {
    const dt = TICK_DT;
    if (cmd.slot) this.selectSlot(p, cmd.slot);
    const w = p.weapons[p.current];
    const def = this.weaponOf(p);

    // Recoil recovery. While a spray continues (the next shot comes as soon
    // as the weapon cycles) recoil is held exactly on the pattern; once the
    // shooter pauses, punch and pattern position decay together toward the
    // start, so tapping and short bursts stay accurate. Deterministic: it
    // depends only on timing, never on the RNG.
    const spraying = p.shotsFired > 0 && this.time <= p.nextFire + 2 * TICK_DT;
    if (!spraying && p.shotsFired > 0) {
      const k = Math.exp(-dt / def.recoilTau);
      p.punchPitch *= k;
      p.punchYaw *= k;
      p.shotsFired *= k;
      if (p.shotsFired < 0.05) {
        p.shotsFired = 0;
        p.punchPitch = 0;
        p.punchYaw = 0;
      }
    }
    p.spreadAccum = Math.max(0, p.spreadAccum - def.spreadRecovery * dt);

    // Reload completion.
    if (p.reloadEnd > 0 && this.time >= p.reloadEnd && w) {
      const need = def.magSize - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take;
      w.reserve -= take;
      p.reloadEnd = 0;
    }
    if (p.rescopeAt > 0 && this.time >= p.rescopeAt) {
      if (p.reloadEnd === 0 && w && w.mag > 0) p.scope = p.rescopeLevel;
      p.rescopeAt = 0;
    }

    const startReload = () => {
      if (!w || def.magSize === 0 || p.reloadEnd > 0 || w.mag >= def.magSize || w.reserve <= 0) return;
      p.reloadEnd = this.time + def.reloadTime;
      p.scope = 0;
      p.rescopeAt = 0;
      p.shotsFired = 0;
      this.events.push({ type: 'reload', player: p.id, weapon: def.id });
    };
    if (cmd.reload && !frozen) startReload();

    // Alt fire: scope cycling / heavy knife stab.
    const altPressed = cmd.altFire && !p.altHeld;
    p.altHeld = cmd.altFire;
    if (altPressed && def.scope && p.reloadEnd === 0 && this.time >= p.switchEnd) {
      p.scope = (p.scope + 1) % (def.scope.fovs.length + 1);
      p.rescopeAt = 0;
      this.events.push({ type: 'scope', player: p.id, level: p.scope });
    }

    const firePressed = cmd.fire && !p.fireHeld;
    p.fireHeld = cmd.fire;
    if (frozen || this.time < p.switchEnd || p.reloadEnd > 0 || this.time < p.nextFire) return;

    if (def.cls === 'grenade') {
      if ((firePressed || altPressed) && w && isNade(w.id) && p.nades[w.id] > 0) this.throwNade(p, w.id, altPressed && !firePressed);
      return;
    }
    if (def.cls === 'melee') {
      if (cmd.fire) this.melee(p, def, def.damage, def.cycle);
      else if (altPressed) this.melee(p, def, 65, 1.0);
      return;
    }
    if (!w) return;
    const wantsFire = def.automatic ? cmd.fire : firePressed;
    if (!wantsFire) return;
    if (w.mag <= 0) {
      if (firePressed) this.events.push({ type: 'dryfire', player: p.id });
      startReload();
      p.nextFire = this.time + 0.2;
      return;
    }
    this.fire(p, def, w);
  }

  private melee(p: SimPlayer, def: WeaponDef, damage: number, cycle: number): void {
    p.nextFire = this.time + cycle;
    const restore = this.rewind?.(p) ?? null;
    try {
      this.meleeTrace(p, def, damage);
    } finally {
      restore?.();
    }
  }

  private meleeTrace(p: SimPlayer, def: WeaponDef, damage: number): void {
    const eye = this.eyePos(p);
    const dir = dirFromAngles(p.yaw, p.pitch);
    const tr = this.trace(p, eye, dir, def.range);
    if (tr.victim) {
      this.damageFrom(p, tr.victim, damage, tr.group!, tr.end, def);
    }
    this.events.push({ type: 'melee', shooter: p.id, hit: !!tr.victim || tr.hitWorld, pos: tr.end });
  }

  private fire(p: SimPlayer, def: WeaponDef, w: WeaponState): void {
    w.mag--;
    p.nextFire = this.time + def.cycle;
    const restore = this.rewind?.(p) ?? null;
    try {
      this.fireTraces(p, def);
    } finally {
      restore?.();
    }
    this.applyRecoil(p, def);
  }

  private fireTraces(p: SimPlayer, def: WeaponDef): void {
    const eye = this.eyePos(p);
    const spread = this.spreadOf(p);
    // Aim direction includes the current recoil punch (as in the classics,
    // recoil moves both the view and the bullets).
    const baseYaw = p.yaw + p.punchYaw;
    const basePitch = p.pitch + p.punchPitch;
    for (let i = 0; i < def.pellets; i++) {
      const r = spread * Math.sqrt(this.rng()) * (def.pellets > 1 ? 1 : this.rng() * 0.5 + 0.5);
      const a = this.rng() * Math.PI * 2;
      const dir = dirFromAngles(baseYaw + Math.cos(a) * r, basePitch + Math.sin(a) * r);
      const tr = this.trace(p, eye, dir, def.range);
      this.events.push({ type: 'shot', shooter: p.id, weapon: def.id, origin: eye, end: tr.end, hitWorld: tr.hitWorld, normal: tr.normal });
      if (tr.victim) {
        this.damageFrom(p, tr.victim, def.damage, tr.group!, tr.end, def, dist(eye, tr.end));
      }
    }
  }

  private applyRecoil(p: SimPlayer, def: WeaponDef): void {
    // Move the view to the next point of the weapon's fixed spray pattern.
    const step = patternStep(sprayPattern(def), p.shotsFired);
    p.punchYaw += step.yaw;
    p.punchPitch += step.pitch;
    p.shotsFired = Math.floor(p.shotsFired) + 1;
    p.spreadAccum = Math.min(def.spreadMax, p.spreadAccum + def.spreadPerShot);
    if (def.scope && !def.scope.keepScope && p.scope > 0) {
      p.rescopeLevel = p.scope;
      p.scope = 0;
      p.rescopeAt = p.nextFire;
    }
  }

  /** Hitscan trace against world and every other living player. */
  trace(
    shooter: SimPlayer,
    origin: Vec3,
    dir: Vec3,
    range: number,
  ): { end: Vec3; hitWorld: boolean; normal?: Vec3; victim?: SimPlayer; group?: HitGroup } {
    const wall = this.map.world.raycast(origin, dir, range);
    let bestT = wall ? wall.t : range;
    let victim: SimPlayer | undefined;
    let group: HitGroup | undefined;
    for (const q of this.players) {
      if (q === shooter || !q.alive) continue;
      if (!this.config.friendlyFire && q.team === shooter.team) continue;
      // Cheap reject: distance from ray to player centre.
      const c = { x: q.body.pos.x - origin.x, y: q.body.pos.y + 1 - origin.y, z: q.body.pos.z - origin.z };
      const along = c.x * dir.x + c.y * dir.y + c.z * dir.z;
      if (along < 0 || along > bestT + 1.5) continue;
      for (const hb of hitboxes(q)) {
        const hit = rayAabb(origin, dir, hb, bestT);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          victim = q;
          group = hb.group;
        }
      }
    }
    const end = add(origin, scale(dir, bestT));
    if (victim) return { end, hitWorld: false, victim, group };
    return { end, hitWorld: !!wall, normal: wall?.normal };
  }

  private damageFrom(attacker: SimPlayer, victim: SimPlayer, _base: number, group: HitGroup, pos: Vec3, def: WeaponDef, distance = 0): void {
    const scaled = def.cls === 'melee' ? { ...def, damage: _base } : def;
    const res = computeDamage(scaled, distance, group, victim.armor, victim.helmet);
    victim.armor = Math.max(0, victim.armor - res.armor);
    this.damage(victim, attacker, res.health, group, pos, def.id);
  }

  /** Applies final health damage and handles death bookkeeping. */
  damage(victim: SimPlayer, attacker: SimPlayer | null, amount: number, group: HitGroup, pos: Vec3, weapon: KillSource): void {
    if (!victim.alive) return;
    victim.health -= amount;
    victim.lastHurt = this.time;
    // Getting shot slows you down ("tagging").
    victim.body.vel.x *= 0.5;
    victim.body.vel.z *= 0.5;
    this.events.push({ type: 'hit', attacker: attacker?.id ?? 0, victim: victim.id, damage: amount, group, pos });
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = this.time + 2;
      victim.scope = 0;
      victim.kit = false;
      victim.nades = { he: 0, flash: 0, smoke: 0 };
      delete victim.weapons[4];
      this.stopAction(victim);
      this.dropBomb(victim);
      if (attacker && attacker !== victim) {
        if (attacker.team !== victim.team) {
          attacker.kills++;
          const reward = weapon === 'bomb' ? 0 : WEAPONS[weapon].killReward;
          attacker.money = Math.min(this.config.maxMoney, attacker.money + reward);
        } else {
          attacker.kills--;
        }
      }
      this.events.push({ type: 'kill', killer: attacker?.id ?? 0, victim: victim.id, weapon, headshot: group === 'head' });
    }
  }

  /** Line of sight between two players' eyes (used by bots and audio). */
  canSee(a: SimPlayer, b: SimPlayer): boolean {
    if (this.time < a.blindFull) return false; // flashed
    const ea = this.eyePos(a);
    const targets = [this.eyePos(b), { x: b.body.pos.x, y: b.body.pos.y + bodyHeight(b.body) * 0.55, z: b.body.pos.z }];
    return targets.some((t) => this.map.world.lineOfSight(ea, t) && !this.smokeBlocks(ea, t));
  }

  // --------------------------------------------------------------- grenades

  /** Current radius of a smoke cloud (grows in, thins out at the end); 0 once gone. */
  smokeRadius(s: Smoke, time = this.time): number {
    if (time < s.start || time >= s.end) return 0;
    const grow = Math.min(1, (time - s.start) / NADE.smokeGrow);
    const fade = Math.min(1, (s.end - time) / NADE.smokeFade);
    return NADE.smokeRadius * Math.sqrt(grow) * (0.55 + 0.45 * fade);
  }

  /** True when a smoke cloud lies across the line from a to b. */
  smokeBlocks(a: Vec3, b: Vec3): boolean {
    for (const s of this.smokes) {
      const r = this.smokeRadius(s) * 0.9;
      if (r <= 0) continue;
      // Closest point of the segment to the cloud's centre.
      const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const len2 = d.x * d.x + d.y * d.y + d.z * d.z || 1;
      const t = clamp(((s.pos.x - a.x) * d.x + (s.pos.y - a.y) * d.y + (s.pos.z - a.z) * d.z) / len2, 0, 1);
      const c = { x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t };
      if (dist(c, s.pos) < r) return true;
    }
    return false;
  }

  private throwNade(p: SimPlayer, type: NadeType, lob: boolean): void {
    const dir = dirFromAngles(p.yaw, Math.min(1.4, p.pitch + 0.12));
    const eye = this.eyePos(p);
    const speed = lob ? NADE.lobSpeed : NADE.throwSpeed;
    let pos = add(eye, scale(dir, 0.35));
    if (!this.map.world.lineOfSight(eye, pos)) pos = { ...eye };
    this.nadesInFlight.push({
      id: ++this.nadeSeq,
      type,
      owner: p.id,
      pos,
      vel: { x: dir.x * speed + p.body.vel.x * 0.6, y: dir.y * speed + (lob ? 1.5 : 0), z: dir.z * speed + p.body.vel.z * 0.6 },
      thrownAt: this.time,
      resting: false,
    });
    p.nades[type]--;
    p.nextFire = this.time + 0.9;
    this.events.push({ type: 'nadeThrow', player: p.id, nade: type });
    this.syncNadeSlot(p);
  }

  private tickNades(): void {
    const dt = TICK_DT;
    for (let i = this.nadesInFlight.length - 1; i >= 0; i--) {
      const n = this.nadesInFlight[i];
      if (!n.resting) {
        n.vel.y -= NADE.gravity * dt;
        const delta = scale(n.vel, dt);
        const hit = this.map.world.raycast(n.pos, delta, 1);
        if (hit) {
          n.pos = add(add(n.pos, scale(delta, hit.t)), scale(hit.normal, 0.02));
          const vn = n.vel.x * hit.normal.x + n.vel.y * hit.normal.y + n.vel.z * hit.normal.z;
          const speed = Math.hypot(n.vel.x, n.vel.y, n.vel.z);
          n.vel = {
            x: (n.vel.x - 2 * vn * hit.normal.x) * NADE.bounce,
            y: (n.vel.y - 2 * vn * hit.normal.y) * NADE.bounce,
            z: (n.vel.z - 2 * vn * hit.normal.z) * NADE.bounce,
          };
          if (hit.normal.y > 0.7) {
            // Floor: lose most of the roll (dirt, tiles and concrete grip).
            n.vel.x *= 0.5;
            n.vel.z *= 0.5;
            if (Math.hypot(n.vel.x, n.vel.y, n.vel.z) < 0.6) {
              n.resting = true;
              n.vel = { x: 0, y: 0, z: 0 };
            }
          }
          if (speed > 2.5) this.events.push({ type: 'nadeBounce', nade: n.type, pos: { ...n.pos } });
        } else {
          n.pos = add(n.pos, delta);
        }
      }
      const age = this.time - n.thrownAt;
      const due = n.type === 'smoke' ? (n.resting && age > 0.6) || age >= NADE.fuse.smoke : age >= NADE.fuse[n.type];
      if (n.pos.y < -10) {
        this.nadesInFlight.splice(i, 1);
      } else if (due) {
        this.nadesInFlight.splice(i, 1);
        this.detonate(n);
      }
    }
    if (this.smokes.length) this.smokes = this.smokes.filter((s) => this.time < s.end);
  }

  private detonate(n: Nade): void {
    const pos = n.pos;
    this.events.push({ type: 'nadeExplode', nade: n.type, pos: { ...pos } });
    const owner = this.getPlayer(n.owner) ?? null;
    const from = { x: pos.x, y: pos.y + 0.15, z: pos.z };
    if (n.type === 'smoke') {
      this.smokes.push({ id: n.id, pos: { x: pos.x, y: pos.y + 1.2, z: pos.z }, start: this.time, end: this.time + NADE.smokeDuration });
      return;
    }
    for (const p of this.players) {
      if (!p.alive) continue;
      if (n.type === 'he') {
        const chest = { x: p.body.pos.x, y: p.body.pos.y + bodyHeight(p.body) * 0.55, z: p.body.pos.z };
        const d = dist(from, chest);
        if (d >= NADE.heRadius || !this.map.world.lineOfSight(from, chest)) continue;
        if (owner && p !== owner && p.team === owner.team && !this.config.friendlyFire) continue;
        let dmg = NADE.heDamage * Math.pow(1 - d / NADE.heRadius, 1.5);
        if (p.armor > 0) {
          // Armour takes half of the blast and wears down by as much.
          const absorbed = Math.min(p.armor, dmg * 0.5);
          p.armor = Math.max(0, Math.round(p.armor - absorbed));
          dmg -= absorbed;
        }
        if (dmg >= 1) this.damage(p, owner, Math.round(dmg), 'chest', { ...p.body.pos }, 'he');
      } else {
        // Flashbang: how blinding depends on distance and where you look.
        const eye = this.eyePos(p);
        const d = dist(from, eye);
        if (d >= NADE.flashRadius || !this.map.world.lineOfSight(from, eye) || this.smokeBlocks(from, eye)) continue;
        const view = dirFromAngles(p.yaw, p.pitch);
        const to = scale({ x: from.x - eye.x, y: from.y - eye.y, z: from.z - eye.z }, 1 / Math.max(d, 0.01));
        const dot = view.x * to.x + view.y * to.y + view.z * to.z;
        // Looking at it: full effect; side-on: partial; back turned: nothing.
        const facing = dot > 0.5 ? 1 : dot > 0 ? 0.6 : dot > -0.3 ? 0.25 : 0;
        const k = facing * Math.pow(1 - d / NADE.flashRadius, 0.7);
        if (k < 0.05) continue;
        const full = NADE.flashFull * k;
        // A second flash only ever makes it worse.
        p.blindAt = this.time;
        p.blindFull = Math.max(p.blindFull, this.time + full);
        p.blindEnd = Math.max(p.blindEnd, this.time + full + NADE.flashFade * k);
      }
    }
  }
}
