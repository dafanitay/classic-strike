import { CELL_FLOOR, type Team } from './map';
import { NavGrid } from './nav';
import { emptyCmd, type BombSite, type PlayerCmd, type SimEvent, type SimPlayer, type Simulation } from './sim';
import { chooseSpot, tacticalMap, type Route, type Spot, type TacticalMap } from './tactics';
import { angleDiff, anglesFromDir, clamp, dist, dist2D, type Vec3 } from './vec';
import { NADE, WEAPONS, type NadeType, type WeaponId } from './weapons';

/**
 * Bot AI. Bots are ordinary simulation participants: they only ever act by
 * producing a PlayerCmd, exactly like a human's keyboard and mouse. They
 * perceive enemies through a view cone + line-of-sight test and by hearing
 * gunfire/footsteps — never by reading positions they could not know.
 *
 * Structure (two layers):
 * - The director plans each round per team from a tactical reading of the
 *   map (tactics.ts): Attackers get roles (entry / support / flank / lurk)
 *   with their own routes to the target site, stage outside it and push
 *   together; Defenders spread over both sites and the middle (anchor /
 *   mid). Destinations are chosen so teammates don't pick the same place,
 *   a crowding check re-assigns bots that end up on top of each other, and
 *   a sighting or a death is answered by one or two well-placed bots, not
 *   the whole team.
 * - Each bot is an independent agent with a personality (aggression,
 *   caution, flank tendency, patience, reaction, decision rate), a state
 *   machine (move / wait / hold / search / support / retreat / fetch /
 *   guard / retake, plus combat), its own memory of enemies, and progress
 *   monitoring that sidesteps, re-plans or picks a new destination when it
 *   stops making headway — in combat too.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

interface DiffParams {
  reaction: number; // seconds before first shot after spotting
  aimError: number; // radians of initial aim error
  turnSpeed: number; // rad/s
  fov: number; // full view cone, radians
  viewDist: number;
  hearDist: number;
  headChance: number;
  strafe: boolean;
  stopToShoot: boolean;
  seekCover: boolean;
  burst: number; // shots per burst at range
}

const DEG = Math.PI / 180;

export const DIFFICULTY: Record<Difficulty, DiffParams> = {
  easy: { reaction: 0.8, aimError: 6 * DEG, turnSpeed: 3.2, fov: 100 * DEG, viewDist: 40, hearDist: 16, headChance: 0.05, strafe: false, stopToShoot: false, seekCover: false, burst: 4 },
  normal: { reaction: 0.45, aimError: 3 * DEG, turnSpeed: 6.5, fov: 115 * DEG, viewDist: 65, hearDist: 26, headChance: 0.2, strafe: true, stopToShoot: false, seekCover: true, burst: 6 },
  hard: { reaction: 0.25, aimError: 1.4 * DEG, turnSpeed: 11, fov: 130 * DEG, viewDist: 100, hearDist: 36, headChance: 0.4, strafe: true, stopToShoot: true, seekCover: true, burst: 9 },
};

export type Role = 'entry' | 'support' | 'flank' | 'lurk' | 'anchor' | 'mid';
export type State = 'move' | 'wait' | 'hold' | 'search' | 'support' | 'retreat' | 'fetch' | 'guard' | 'retake' | 'combat';

/** Stable per-bot tendencies. They bias decisions; they don't randomise them. */
export interface Personality {
  aggression: number; // 0..1: advance vs. hold
  caution: number; // 0..1: retreat / reposition readiness
  flank: number; // 0..1: preference for the other route
  patience: number; // 0..1: how long to hold / wait
  reaction: number; // multiplier on the difficulty's reaction time
  decision: number; // seconds between tactical re-evaluations
}

interface Memory {
  pos: Vec3;
  time: number;
  seen: boolean; // true = saw it, false = heard it / was told
}

interface Brain {
  id: number;
  pers: Personality;
  role: Role;
  state: State;
  /** Why the current destination was chosen (diagnostics). */
  reason: string;
  dest: Vec3 | null;
  route: Route | null;
  path: Vec3[];
  pathIdx: number;
  look: number | null;
  holdUntil: number;
  startAt: number;
  nextDecision: number;
  zone: BombSite | 'mid' | null;
  // perception & combat
  targetId: number | null;
  targetSince: number;
  reactionAt: number;
  visible: number; // enemies in view at the last perception
  memory: Memory | null;
  engagedUntil: number;
  aimYaw: number;
  aimPitch: number;
  errYaw: number;
  errPitch: number;
  errAt: number;
  strafeDir: number;
  strafeUntil: number;
  burstLeft: number;
  burstPauseUntil: number;
  semiToggle: boolean;
  wantScope: boolean;
  nextPerceive: number;
  boughtRound: number;
  combatPathAt: number;
  advanceBlockedUntil: number;
  /** No new retreat before this time (stops retreat <-> objective ping-pong). */
  retreatReadyAt: number;
  /** A grenade to throw at a point, until a deadline (dropped after it). */
  throwPlan: { type: NadeType; target: Vec3; until: number; fireToggle: boolean } | null;
  /** "Flash out": look away from a teammate's flashbang until then, toward `awayYaw`. */
  turnAwayUntil: number;
  awayYaw: number;
  // progress monitoring
  progAt: number;
  progPos: Vec3;
  stuckCount: number;
  stuckTime: number;
  sideUntil: number;
  sideDir: Vec3 | null;
  jumpUntil: number;
  crowdedSince: number;
}

interface TeamPlan {
  site: BombSite;
  /** When the Attackers stop waiting outside the site and go in. */
  pushAt: number;
  lastSite: BombSite | null;
  /** Defenders: recent contacts per site (which enemy, when), and when each site was last reinforced. */
  contacts: Record<BombSite, { time: number; enemy: number }[]>;
  rotatedAt: Record<BombSite, number>;
  /** When help was last sent for a sighting of each enemy (by player id). */
  sightings: Map<number, number>;
}

/** What the diagnostics overlay shows for one bot. */
export interface BotDebug {
  id: number;
  name: string;
  team: Team;
  role: Role;
  state: State;
  reason: string;
  pos: Vec3;
  dest: Vec3 | null;
  path: Vec3[];
  memory: Vec3 | null;
  stuckTime: number;
  target: number | null;
}

const ROLES_A: Role[] = ['entry', 'flank', 'support', 'lurk', 'support', 'flank', 'support', 'lurk'];
/**
 * Launch pitch (radians above horizontal) that lands a throw `dx` metres
 * away and `dy` metres higher, at speed `v`: the flatter of the two arcs.
 */
export function throwPitch(dx: number, dy: number, v: number): number {
  const g = NADE.gravity;
  const disc = v ** 4 - g * (g * dx * dx + 2 * dy * v * v);
  if (disc < 0 || dx < 0.5) return Math.PI / 4;
  return Math.atan((v * v - Math.sqrt(disc)) / (g * dx));
}

const PREFERRED_RANGE: Record<string, number> = { melee: 1, pistol: 12, smg: 10, shotgun: 6, rifle: 16, sniper: 30, mg: 14 };

export class BotDirector {
  private readonly sim: Simulation;
  readonly nav: NavGrid;
  readonly tactics: TacticalMap;
  difficulty: Difficulty;
  private readonly brains = new Map<number, Brain>();
  private readonly plans: Record<Team, TeamPlan> = {
    A: { site: 'A', pushAt: Infinity, lastSite: null, contacts: { A: [], B: [] }, rotatedAt: { A: -99, B: -99 }, sightings: new Map() },
    D: { site: 'A', pushAt: Infinity, lastSite: null, contacts: { A: [], B: [] }, rotatedAt: { A: -99, B: -99 }, sightings: new Map() },
  };
  private planRound = -1;
  private coordinateAt = 0;
  private readonly corridorCost = new WeakMap<Route, Float32Array>();

  constructor(sim: Simulation, difficulty: Difficulty) {
    this.sim = sim;
    this.difficulty = difficulty;
    this.tactics = tacticalMap(sim.map);
    this.nav = this.tactics.nav;
    // Build the position lists now (at map load), not on first use mid-round.
    for (const s of ['A', 'B'] as const) {
      this.tactics.holdSpots(s);
      this.tactics.lurkSpots(s);
    }
    this.tactics.midSpots();
  }

  // ---------------------------------------------------------------- brains

  private brain(p: SimPlayer): Brain {
    let b = this.brains.get(p.id);
    if (!b) {
      const r = () => this.sim.random();
      const aggression = 0.15 + r() * 0.75;
      b = {
        id: p.id,
        pers: {
          aggression,
          caution: clamp(1 - aggression + (r() - 0.5) * 0.4, 0.05, 0.95),
          flank: r(),
          patience: 0.2 + r() * 0.8,
          reaction: 0.85 + r() * 0.35,
          decision: 0.35 + r() * 0.45,
        },
        role: p.team === 'A' ? 'support' : 'anchor',
        state: 'move',
        reason: 'joined',
        dest: null, route: null, path: [], pathIdx: 0, look: null, holdUntil: 0, startAt: 0, nextDecision: 0, zone: null,
        targetId: null, targetSince: 0, reactionAt: 0, visible: 0, memory: null, engagedUntil: 0,
        aimYaw: p.yaw, aimPitch: 0, errYaw: 0, errPitch: 0, errAt: 0,
        strafeDir: 1, strafeUntil: 0, burstLeft: 0, burstPauseUntil: 0, semiToggle: false, wantScope: false,
        nextPerceive: 0, boughtRound: -1, combatPathAt: 0, advanceBlockedUntil: 0, retreatReadyAt: 0, throwPlan: null, turnAwayUntil: 0, awayYaw: 0,
        progAt: 0, progPos: { ...p.body.pos }, stuckCount: 0, stuckTime: 0, sideUntil: 0, sideDir: null, jumpUntil: 0, crowdedSince: -1,
      };
      this.brains.set(p.id, b);
      // A bot that joins mid-round gets a role now.
      if (this.planRound === this.sim.round && p.alive) this.assignLate(p, b);
    }
    return b;
  }

  /** Diagnostics: what every living bot is doing and why. */
  debugState(): BotDebug[] {
    const out: BotDebug[] = [];
    for (const p of this.sim.players) {
      const b = this.brains.get(p.id);
      if (!b || !p.isBot || !p.alive) continue;
      out.push({
        id: p.id, name: p.name, team: p.team, role: b.role, state: b.state, reason: b.reason,
        pos: { ...p.body.pos }, dest: b.dest ? { ...b.dest } : null, path: b.path.slice(b.pathIdx),
        memory: b.memory ? { ...b.memory.pos } : null, stuckTime: b.stuckTime, target: b.targetId,
      });
    }
    return out;
  }

  // ------------------------------------------------------------- per tick

  /** Must be called with the events of the tick that just ran (for hearing). */
  observe(events: readonly SimEvent[]): void {
    const sim = this.sim;
    for (const ev of events) {
      if (ev.type === 'roundStart') this.resetRound();
      if (ev.type === 'kill') {
        // A death is radioed: the victim's team learns roughly where it happened.
        const victim = sim.getPlayer(ev.victim);
        const killer = sim.getPlayer(ev.killer);
        if (victim && killer && killer.team !== victim.team) this.report(victim.team, victim.body.pos, 'death', victim.id, killer.id);
        continue;
      }
      if (ev.type === 'nadeThrow') {
        // That throw is done (a second grenade of the kind waits for a new plan).
        const tb = this.brains.get(ev.player);
        if (tb) tb.throwPlan = null;
      }
      if (ev.type === 'nadeThrow' && ev.nade === 'flash') {
        // "Flash out": the thrower and teammates who can see where it's going turn their backs.
        const thrower = sim.getPlayer(ev.player);
        if (thrower) {
          for (const q of this.alive(thrower.team)) {
            if (q !== thrower && dist2D(q.body.pos, thrower.body.pos) > 25) continue;
            const qb = this.brain(q);
            if (qb.targetId !== null) continue;
            qb.turnAwayUntil = sim.time + 1.9;
            qb.awayYaw = thrower.yaw + Math.PI;
          }
        }
        continue;
      }
      if (ev.type === 'planted') {
        for (const p of sim.players) {
          const b = this.brains.get(p.id);
          if (b) b.nextDecision = 0; // everyone re-thinks now
        }
        continue;
      }
      let src: SimPlayer | undefined;
      let pos: Vec3 | undefined;
      let loud = 1;
      if (ev.type === 'shot') {
        src = sim.getPlayer(ev.shooter);
        pos = ev.origin;
      } else if (ev.type === 'step' && !ev.walk) {
        src = sim.getPlayer(ev.player);
        pos = ev.pos;
        loud = 0.45;
      } else if (ev.type === 'land' || ev.type === 'jump') {
        src = sim.getPlayer(ev.player);
        pos = ev.pos;
        loud = 0.4;
      } else continue;
      if (!src || !pos) continue;
      const d = DIFFICULTY[this.difficulty];
      for (const p of sim.players) {
        if (!p.isBot || !p.alive || p.team === src.team) continue;
        if (dist(p.body.pos, pos) > d.hearDist * loud) continue;
        const b = this.brain(p);
        if (b.targetId !== null) continue;
        // Hearing gives an approximate position, and it's this bot's alone.
        b.memory = { pos: { x: pos.x, y: sim.map.surfaceY(pos), z: pos.z }, time: sim.time, seen: false };
      }
    }
  }

  /** Produces this tick's command for every living bot. */
  update(): void {
    if (this.planRound !== this.sim.round) this.resetRound();
    if (this.sim.time >= this.coordinateAt) {
      this.coordinateAt = this.sim.time + 0.5;
      this.coordinate();
    }
    for (const p of this.sim.players) {
      if (!p.isBot) continue;
      if (!p.alive) {
        this.brains.delete(p.id);
        continue;
      }
      this.sim.setCmd(p, this.think(p));
    }
  }

  // --------------------------------------------------------- round plans

  private resetRound(): void {
    const sim = this.sim;
    this.planRound = sim.round;
    const planA = this.plans.A;
    // Mix sites, but avoid hitting the same site many rounds in a row.
    const other = planA.lastSite === 'A' ? 'B' : 'A';
    planA.site = planA.lastSite && sim.random() < 0.65 ? other : sim.random() < 0.5 ? 'A' : 'B';
    planA.lastSite = planA.site;
    planA.pushAt = Infinity;
    this.plans.D.contacts = { A: [], B: [] };
    this.plans.D.rotatedAt = { A: -99, B: -99 };
    this.plans.A.sightings.clear();
    this.plans.D.sightings.clear();
    for (const p of sim.players) {
      if (!p.isBot) continue;
      const b = this.brain(p);
      b.targetId = null;
      b.memory = null;
      b.path = [];
      b.dest = null;
      b.route = null;
      b.look = null;
      b.stuckCount = 0;
      b.stuckTime = 0;
      b.crowdedSince = -1;
    }
    this.assignAttackers();
    this.assignDefenders();
  }

  private alive(team: Team, botsOnly = true): SimPlayer[] {
    return this.sim.players.filter((p) => p.team === team && p.alive && (!botsOnly || p.isBot));
  }

  private assignAttackers(): void {
    const sim = this.sim;
    const t = this.tactics;
    const bots = this.alive('A');
    if (!bots.length) return;
    const site = this.plans.A.site;
    const routes = t.routes('A', site);
    const n = bots.length;
    const roles = ROLES_A.slice(0, Math.min(n, ROLES_A.length));
    while (roles.length < n) roles.push(roles.length % 2 ? 'support' : 'flank');
    // Give each role to the bot whose personality fits it best.
    const fit = (r: Role, q: Personality) =>
      r === 'entry' ? q.aggression : r === 'flank' ? q.flank * 0.7 + q.aggression * 0.3 : r === 'lurk' ? q.patience * 0.6 + (1 - q.aggression) * 0.4 : 0.5;
    const free = [...bots];
    const assigned: { p: SimPlayer; role: Role }[] = [];
    for (const role of roles) {
      free.sort((a, b) => fit(role, this.brain(b).pers) - fit(role, this.brain(a).pers));
      assigned.push({ p: free.shift()!, role });
    }
    // The bomb carrier shouldn't be first through the door or off lurking.
    const carrier = assigned.find((a) => a.p.id === sim.bomb.carrier);
    const support = assigned.find((a) => a.role === 'support');
    if (carrier && support && (carrier.role === 'entry' || carrier.role === 'lurk')) [carrier.role, support.role] = [support.role, carrier.role];

    const entryRoute = routes.length > 1 && sim.random() < 0.35 ? routes[1] : routes[0];
    const flankRoute = routes.filter((r) => r !== entryRoute).sort((a, b) => overlap(a, entryRoute) - overlap(b, entryRoute))[0] ?? entryRoute;
    let supports = 0;
    for (const { p, role } of assigned) {
      const b = this.brain(p);
      b.role = role;
      b.zone = site;
      const now = sim.time;
      if (role === 'lurk') {
        const otherSite: BombSite = site === 'A' ? 'B' : 'A';
        const spot = chooseSpot(t.lurkSpots(otherSite), this.claims(p), [], () => sim.random(), { minSep: 8 });
        b.startAt = sim.roundStartTime + 0.3 + sim.random() * 1.2;
        this.setDest(p, b, spot ? spot.pos : t.site[otherSite], 'move', 'lurk: hold the other site\'s approach', spot?.look ?? null);
        continue;
      }
      const route = role === 'entry' ? entryRoute : role === 'flank' ? flankRoute : supports++ % 2 === 0 ? entryRoute : flankRoute;
      b.route = route;
      // Stage short of the site; teammates on the same route stage further back.
      const sameRoute = assigned.filter((a) => this.brain(a.p).route === route && a.p !== p).length;
      let back = role === 'support' ? 3 + sameRoute * 2 : sameRoute * 2;
      let stage = this.stagePoint(route, back);
      // Routes can end close together: don't stage on top of a teammate.
      const taken = assigned.filter((a) => a.p !== p).map((a) => this.brain(a.p).dest).filter((d): d is Vec3 => !!d);
      for (let k = 0; k < 5 && taken.some((d) => dist2D(d, stage) < 3.5); k++) stage = this.stagePoint(route, (back += 2));
      b.startAt = sim.roundStartTime + (role === 'entry' ? 0 : role === 'flank' ? 0.2 + sim.random() * 0.4 : 0.9 + sim.random() * 0.9) + (1 - b.pers.aggression) * 0.4;
      b.nextDecision = Math.max(b.nextDecision, now);
      this.setDest(p, b, stage, 'move', `${role}: stage at ${route.areas[route.areas.length - 2] ?? site}`, null, route);
    }
  }

  private assignDefenders(): void {
    const sim = this.sim;
    const bots = this.alive('D');
    const n = bots.length;
    if (!n) return;
    const zones: (BombSite | 'mid')[] = n === 1 ? [sim.random() < 0.5 ? 'A' : 'B'] : n === 2 ? ['A', 'B'] : [];
    for (let i = 0; zones.length < n; i++) zones.push((['A', 'B', 'mid'] as const)[i % 3]);
    // Cautious bots anchor sites; aggressive ones take the middle.
    const free = [...bots].sort((a, b) => this.brain(b).pers.caution - this.brain(a).pers.caution);
    const order = [...zones.filter((z) => z !== 'mid'), ...zones.filter((z) => z === 'mid')];
    for (const zone of order) {
      const p = zone === 'mid' ? free.pop()! : free.shift()!;
      const b = this.brain(p);
      b.zone = zone;
      b.role = zone === 'mid' ? 'mid' : 'anchor';
      b.startAt = sim.roundStartTime + sim.random() * 0.8;
      this.holdZone(p, b, 'round start');
    }
  }

  private assignLate(p: SimPlayer, b: Brain): void {
    if (p.team === 'A') {
      b.role = 'support';
      b.zone = this.plans.A.site;
      const routes = this.tactics.routes('A', b.zone);
      b.route = routes[Math.floor(this.sim.random() * routes.length)] ?? null;
      if (b.route) this.setDest(p, b, this.stagePoint(b.route, 4), 'move', 'joined: support', null, b.route);
    } else {
      b.zone = this.sim.random() < 0.5 ? 'A' : 'B';
      b.role = 'anchor';
      this.holdZone(p, b, 'joined');
    }
  }

  /** A point on the route `back` cells before it reaches the site. */
  private stagePoint(route: Route, back: number): Vec3 {
    const t = this.tactics;
    const entry = t.entryOf(route);
    const cols = this.sim.map.def.cols;
    let k = route.cells.findIndex((i) => {
      const c = this.sim.map.cellCenter(i % cols, Math.floor(i / cols));
      return Math.hypot(c.x - entry.x, c.z - entry.z) < 0.1;
    });
    if (k < 0) k = Math.floor(route.cells.length * 0.8);
    const i = route.cells[Math.max(0, k - back)];
    return this.sim.map.cellCenter(i % cols, Math.floor(i / cols));
  }

  /** Where teammates are and where they are going (for spreading out). */
  private claims(p: SimPlayer): Vec3[] {
    const out: Vec3[] = [];
    for (const q of this.sim.players) {
      if (q === p || q.team !== p.team || !q.alive) continue;
      const b = this.brains.get(q.id);
      if (b?.dest) out.push(b.dest);
      out.push(q.body.pos);
    }
    return out;
  }

  private claimedAreas(p: SimPlayer): string[] {
    const out: string[] = [];
    for (const q of this.sim.players) {
      if (q === p || q.team !== p.team || !q.alive) continue;
      const b = this.brains.get(q.id);
      if (b?.dest) out.push(this.sim.map.areaNameAt(b.dest));
    }
    return out;
  }

  private holdZone(p: SimPlayer, b: Brain, why: string, exclude?: Vec3): void {
    const t = this.tactics;
    const spots = b.zone === 'mid' ? t.midSpots() : t.holdSpots(b.zone ?? 'A');
    const claims = this.claims(p);
    if (exclude) claims.push(exclude, exclude);
    const spot = chooseSpot(spots, claims, this.claimedAreas(p), () => this.sim.random(), { minSep: 7 });
    if (!spot) return;
    this.setDest(p, b, spot.pos, 'move', `${b.role} ${b.zone}: ${why}`, spot.look);
    b.holdUntil = Infinity; // set on arrival
  }

  // ------------------------------------------------------- coordination

  /** Team-level checks twice a second: push timing and crowding. */
  private coordinate(): void {
    const sim = this.sim;
    if (sim.phase !== 'live') return;
    const now = sim.time;
    // Attackers: go in together once enough of the team has staged, a fight
    // has started near the site, or time is running short.
    const planA = this.plans.A;
    if (planA.pushAt === Infinity && sim.bomb.state !== 'planted') {
      const bots = this.alive('A');
      const goers = bots.filter((p) => this.brain(p).role !== 'lurk');
      const staged = goers.filter((p) => this.brain(p).state === 'wait').length;
      const fighting = goers.some((p) => this.brain(p).targetId !== null && dist2D(p.body.pos, this.tactics.site[planA.site]) < 25);
      const elapsed = now - sim.roundStartTime;
      const timeLeft = sim.timeLeft();
      // (Only lurkers left: they go in themselves.)
      if (bots.length && (!goers.length || staged >= Math.ceil(goers.length / 2) || fighting || elapsed > 30 || timeLeft < 45)) planA.pushAt = now;
    }
    // Crowding: two bots on top of each other for a while, neither fighting
    // nor doing a job that needs it -> the lower-priority one moves.
    for (const team of ['A', 'D'] as Team[]) {
      const bots = this.alive(team);
      for (const p of bots) {
        const b = this.brain(p);
        if (b.targetId !== null || b.state === 'fetch' || b.state === 'retake' || p.action) {
          b.crowdedSince = -1;
          continue;
        }
        let near: SimPlayer | null = null;
        for (const q of this.alive(team, false)) {
          if (q !== p && dist2D(p.body.pos, q.body.pos) < 2.5) near = q;
        }
        if (!near) {
          b.crowdedSince = -1;
          continue;
        }
        if (b.crowdedSince < 0) b.crowdedSince = now;
        const nb = near.isBot ? this.brain(near) : null;
        const lower = !nb || rank(b, p, sim) < rank(nb, near, sim) || (rank(b, p, sim) === rank(nb, near, sim) && p.id > near.id);
        if (now - b.crowdedSince > 1.5 && lower) {
          b.crowdedSince = -1;
          this.spreadFrom(p, b, near);
        }
      }
    }
  }

  /** Re-assigns a crowded bot to a position away from `near`. */
  private spreadFrom(p: SimPlayer, b: Brain, near: SimPlayer): void {
    const why = `too close to ${near.name}`;
    if (b.state === 'hold' || (b.state === 'move' && (b.role === 'anchor' || b.role === 'mid'))) return this.holdZone(p, b, why, near.body.pos);
    if (b.state === 'guard') return this.guardBomb(p, b, why, near.body.pos);
    // Moving or waiting along a route: fall back a few metres along it, or
    // switch to the other route if there is one.
    if (b.route && (b.state === 'move' || b.state === 'wait')) {
      const routes = this.tactics.routes(p.team, this.plans.A.site);
      const alt = routes.find((r) => r !== b.route && overlap(r, b.route!) < 0.5);
      if (alt && b.state === 'move' && b.pers.flank > 0.4) {
        b.route = alt;
        return this.setDest(p, b, this.stagePoint(alt, 2), 'move', `${why}: take ${alt.areas[1] ?? 'the other route'}`, null, alt);
      }
      return this.setDest(p, b, this.stagePoint(b.route, 4 + Math.floor(this.sim.random() * 3)), b.state, `${why}: stage further back`, b.look, b.route);
    }
    const spot = this.coverNear(p.body.pos, 3, 9, null, [near.body.pos]);
    if (spot) this.setDest(p, b, spot.pos, b.state, why, spot.look);
  }

  /**
   * A sighting or a teammate's death: one or two bots answer (the best
   * placed, whose role suits it); everyone else nearby only turns to look.
   * The same enemy seen again (by another teammate, or re-acquired after
   * losing sight) within 4 s sends no further help.
   */
  private report(team: Team, pos: Vec3, kind: 'seen' | 'death', by: number, enemy: number): void {
    const sim = this.sim;
    if (sim.phase !== 'live') return;
    const bots = this.alive(team).filter((p) => p.id !== by);
    const scored = bots
      .map((p) => {
        const b = this.brain(p);
        const d = dist2D(p.body.pos, pos);
        let s = d;
        if (b.targetId !== null || p.action || b.state === 'fetch' || b.state === 'retake' || b.state === 'guard') s = Infinity;
        if (b.state === 'support' && b.dest && dist2D(b.dest, pos) < 12) s = Infinity; // already on it
        if (b.role === 'support' || b.role === 'mid') s -= 8;
        if (b.role === 'anchor' && b.zone !== 'mid' && b.zone && dist2D(this.tactics.site[b.zone], pos) > 25) s += 15; // keep the other site
        if (b.role === 'lurk') s += 10;
        if (p.id === sim.bomb.carrier) s += 20;
        s -= b.pers.aggression * 6;
        return { p, b, s, d };
      })
      .filter((x) => x.s < Infinity && x.d < 45)
      .sort((a, b) => a.s - b.s);
    const sightings = this.plans[team].sightings;
    const repeat = kind === 'seen' && sim.time - (sightings.get(enemy) ?? -99) < 4;
    if (kind === 'seen' && !repeat) sightings.set(enemy, sim.time);
    const k = repeat ? 0 : kind === 'death' ? 2 : 1;
    // An HE at attackers bunched near a site, from a Defender who can reach them.
    if (team === 'D' && kind === 'seen' && !repeat) {
      const near = (['A', 'B'] as const).some((s) => dist2D(pos, this.tactics.site[s]) < 18);
      const thrower = near && bots.find((q) => q.nades.he > 0 && !this.brain(q).throwPlan && this.brain(q).targetId === null && dist2D(q.body.pos, pos) > 8 && dist2D(q.body.pos, pos) < 24);
      if (thrower) this.brain(thrower).throwPlan = { type: 'he', target: { ...pos }, until: sim.time + 2.5, fireToggle: false };
    }
    const responders = scored.slice(0, k);
    if (team === 'D') this.rotate(pos, enemy, responders.map((r) => r.p));
    for (const { p, b } of responders) {
      const spot = this.coverNear(pos, 4, 12, pos, this.claims(p));
      this.setDest(p, b, spot ? spot.pos : pos, 'support', `${kind === 'death' ? 'trade a teammate' : 'support a sighting'} near ${sim.map.areaNameAt(pos)}`, spot ? spot.look : null);
    }
    for (const { p, b } of scored.slice(k)) {
      if (dist2D(p.body.pos, pos) < 30 && b.state !== 'move') b.look = yawTo(p.body.pos, pos);
    }
  }

  /**
   * Defenders rotate to a site under attack: the mid player at the first
   * contact there, and one anchor from the other site once contacts pile up
   * (two or more different enemies within 6 s). Each site is reinforced at
   * most every 8 s, so a single attacker doesn't empty the other site.
   */
  private rotate(pos: Vec3, enemy: number, already: SimPlayer[]): void {
    const sim = this.sim;
    const now = sim.time;
    const t = this.tactics;
    const site = (['A', 'B'] as const).find((s) => dist2D(pos, t.site[s]) < 22);
    if (!site) return;
    const plan = this.plans.D;
    plan.contacts[site] = plan.contacts[site].filter((c) => now - c.time < 6 && c.enemy !== enemy);
    plan.contacts[site].push({ time: now, enemy });
    if (now - plan.rotatedAt[site] < 8) return;
    const other: BombSite = site === 'A' ? 'B' : 'A';
    const pick = (pred: (b: Brain) => boolean) =>
      this.alive('D')
        .filter((p) => !already.includes(p) && this.brain(p).targetId === null && pred(this.brain(p)))
        .sort((a, b) => dist2D(a.body.pos, t.site[site]) - dist2D(b.body.pos, t.site[site]))[0];
    const movers: SimPlayer[] = [];
    const mid = pick((b) => b.role === 'mid' && b.zone !== site);
    if (mid) movers.push(mid);
    if (plan.contacts[site].length >= 2) {
      const anchor = pick((b) => b.role === 'anchor' && b.zone === other);
      if (anchor) movers.push(anchor);
    }
    if (!movers.length) return;
    plan.rotatedAt[site] = now;
    for (const p of movers) {
      const b = this.brain(p);
      b.zone = site;
      this.holdZone(p, b, `rotate to ${site}: contact there`);
    }
  }

  // ---------------------------------------------------------------- think

  private think(p: SimPlayer): PlayerCmd {
    const sim = this.sim;
    const b = this.brain(p);
    const d = DIFFICULTY[this.difficulty];
    const cmd = emptyCmd(b.aimYaw, b.aimPitch);
    const now = sim.time;

    if (sim.phase === 'freeze' || sim.phase === 'warmup') this.buy(p, b);

    // Weapon management: primary if it has any ammo, else pistol.
    const prim = p.weapons[1];
    const sec = p.weapons[2];
    const want: 1 | 2 | 3 = prim && prim.mag + prim.reserve > 0 ? 1 : sec && sec.mag + sec.reserve > 0 ? 2 : 3;
    // A throw is abandoned once there is someone to shoot: with a grenade in
    // hand the bot would otherwise stand in the fight unable to fire back.
    if (b.throwPlan && (now > b.throwPlan.until || p.nades[b.throwPlan.type] <= 0 || sim.phase !== 'live' || b.targetId !== null)) b.throwPlan = null;
    if (p.current !== want && !sim.isReloading(p) && !b.throwPlan) cmd.slot = want;

    if (now >= b.nextPerceive) {
      b.nextPerceive = now + 0.1;
      this.perceive(p, b, d);
    }
    const target = b.targetId !== null ? sim.getPlayer(b.targetId) : undefined;

    let moveDir: Vec3 | null = null;
    let lookYaw: number | null = null;
    let lookPitch = 0;

    if (target && target.alive) {
      b.engagedUntil = now + 2;
      const r = this.combat(p, b, d, target, cmd);
      moveDir = r.moveDir;
      lookYaw = r.lookYaw;
      lookPitch = r.lookPitch;
    } else {
      b.targetId = null;
      if (sim.phase === 'live' && now >= b.nextDecision) {
        b.nextDecision = now + b.pers.decision * (0.8 + sim.random() * 0.4);
        this.decide(p, b);
      }
      if (sim.phase === 'live' && now >= b.startAt) {
        moveDir = this.followPath(p, b);
        if (moveDir) lookYaw = anglesFromDir(moveDir).yaw;
        // Walk quietly and look toward a fresh threat when closing in on it.
        const m = b.memory;
        if (m && now - m.time < 6 && dist2D(p.body.pos, m.pos) < 14) {
          const eye = sim.eyePos(p);
          const a = anglesFromDir({ x: m.pos.x - eye.x, y: m.pos.y + 1.4 - eye.y, z: m.pos.z - eye.z });
          lookYaw = a.yaw;
          lookPitch = a.pitch;
          cmd.walk = this.difficulty !== 'easy' && b.pers.caution > 0.35;
        }
        if (!moveDir && b.look !== null) lookYaw = b.look + Math.sin(now * 0.7 + p.id) * 0.3;
      }
      // Top up magazines in quiet moments.
      const w = p.weapons[p.current];
      const def = sim.weaponOf(p);
      if (w && def.magSize > 0 && w.mag < def.magSize * 0.4 && w.reserve > 0 && now > b.engagedUntil) cmd.reload = true;
      // Fetching a dropped bomb: the path can end at a cell centre short of
      // the bomb (near walls), so cover the last few metres straight at it.
      const bomb = sim.bomb;
      if (b.state === 'fetch' && bomb.state === 'dropped' && !moveDir) {
        const dd = dist2D(p.body.pos, bomb.pos);
        if (dd > 0.3 && dd < 4) {
          moveDir = { x: bomb.pos.x - p.body.pos.x, y: 0, z: bomb.pos.z - p.body.pos.z };
          lookYaw = anglesFromDir(moveDir).yaw;
        }
      }
      const thrown = this.tickThrow(p, b, cmd);
      if (thrown) {
        moveDir = null;
        lookYaw = thrown.yaw;
        lookPitch = thrown.pitch;
      }
      // Plant (once the team is going in, or late) or defuse when standing in
      // the right place with nobody in view.
      const plant = sim.canPlant(p) !== null && (this.plans.A.pushAt <= now || sim.timeLeft() < 30 || b.state === 'hold');
      if (plant || sim.canDefuse(p)) {
        cmd.use = true;
        moveDir = null;
      }
    }

    if (!target && now < b.turnAwayUntil && !b.throwPlan) {
      lookYaw = b.awayYaw;
      lookPitch = 0;
    }
    // ---- turn the view toward lookYaw at limited speed
    if (lookYaw !== null) {
      const maxTurn = d.turnSpeed * (1 / 60);
      const dy = angleDiff(lookYaw, b.aimYaw);
      b.aimYaw += clamp(dy, -maxTurn, maxTurn);
      const dp = lookPitch - b.aimPitch;
      b.aimPitch += clamp(dp, -maxTurn, maxTurn);
    } else {
      b.aimPitch *= 0.95;
    }
    cmd.yaw = b.aimYaw;
    cmd.pitch = b.aimPitch;

    // ---- local avoidance, sidestepping and progress monitoring
    if (moveDir) {
      moveDir = this.avoidTeammates(p, moveDir);
      if (now < b.sideUntil && b.sideDir) moveDir = b.sideDir;
      const l = Math.hypot(moveDir.x, moveDir.z);
      if (l > 1e-3) {
        const mx = moveDir.x / l;
        const mz = moveDir.z / l;
        const fx = -Math.sin(b.aimYaw);
        const fz = -Math.cos(b.aimYaw);
        const rx = Math.cos(b.aimYaw);
        const rz = -Math.sin(b.aimYaw);
        cmd.forward = mx * fx + mz * fz;
        cmd.side = mx * rx + mz * rz;
      }
    }
    this.checkProgress(p, b, cmd, moveDir);
    if (now < b.jumpUntil) cmd.jump = true;
    return cmd;
  }

  /**
   * Works through a throw plan with ordinary commands: take out the right
   * grenade (key 4, again to cycle), aim on a ballistic arc, throw.
   * Returns the view angles to hold while doing it, or null.
   */
  private tickThrow(p: SimPlayer, b: Brain, cmd: PlayerCmd): { yaw: number; pitch: number } | null {
    const plan = b.throwPlan;
    const sim = this.sim;
    if (!plan) return null;
    const held = p.weapons[4];
    if (p.current !== 4 || !held || held.id !== plan.type) {
      if (sim.time >= p.switchEnd) cmd.slot = 4;
      return null;
    }
    const eye = sim.eyePos(p);
    const dx = dist2D(eye, plan.target);
    const yaw = anglesFromDir({ x: plan.target.x - eye.x, y: 0, z: plan.target.z - eye.z }).yaw;
    const pitch = throwPitch(dx, plan.target.y - eye.y, NADE.throwSpeed) - 0.12;
    // Only with a clear start to the arc: thrown into a wall a few metres
    // away, a grenade bounces back onto your own team.
    const a = pitch + 0.12;
    const early = { x: eye.x - Math.sin(yaw) * Math.cos(a) * 5, y: eye.y + Math.sin(a) * 5, z: eye.z - Math.cos(yaw) * Math.cos(a) * 5 };
    if (!sim.map.world.lineOfSight(eye, early)) {
      b.throwPlan = null;
      return null;
    }
    const onAim = Math.abs(angleDiff(b.aimYaw, yaw)) < 0.08 && Math.abs(b.aimPitch - pitch) < 0.08;
    if (onAim && sim.time >= p.switchEnd && sim.time >= p.nextFire) {
      plan.fireToggle = !plan.fireToggle;
      cmd.fire = plan.fireToggle; // a press, not a hold
    }
    return { yaw, pitch };
  }

  /** Tactical decision for a bot with no enemy in view (runs every ~0.4–0.8 s). */
  private decide(p: SimPlayer, b: Brain): void {
    const sim = this.sim;
    const now = sim.time;
    const bomb = sim.bomb;

    // Bomb jobs come first.
    if (bomb.state === 'planted' && bomb.site) {
      if (p.team === 'D') return this.retake(p, b);
      if (b.state !== 'guard') this.guardBomb(p, b, 'bomb planted');
      return;
    }
    if (p.team === 'A' && bomb.state === 'dropped') {
      let fetcher: SimPlayer | null = null;
      for (const q of this.alive('A')) if (!fetcher || dist2D(q.body.pos, bomb.pos) < dist2D(fetcher.body.pos, bomb.pos)) fetcher = q;
      if (fetcher === p) {
        if (b.state !== 'fetch' || !b.dest || dist2D(b.dest, bomb.pos) > 0.5) this.setDest(p, b, { ...bomb.pos }, 'fetch', 'nearest to the dropped bomb', null);
        return;
      }
    }
    if (b.state === 'fetch' && bomb.state !== 'dropped') return this.resume(p, b, 'bomb picked up');

    // Own memory of an enemy: aggressive roles go and look; holders watch.
    if (b.memory && now - b.memory.time > 8) b.memory = null;
    if (b.memory && b.state !== 'search' && b.state !== 'support' && b.state !== 'retreat') {
      const goLook = (b.role === 'entry' || b.role === 'support' || b.role === 'mid') && b.pers.aggression > 0.4 && dist2D(p.body.pos, b.memory.pos) < 30;
      if (goLook && p.id !== bomb.carrier) {
        this.setDest(p, b, b.memory.pos, 'search', `${b.memory.seen ? 'saw' : 'heard'} an enemy near ${sim.map.areaNameAt(b.memory.pos)}`, null);
        return;
      }
      b.look = yawTo(p.body.pos, b.memory.pos);
    }

    const arrived = !b.path.length || b.pathIdx >= b.path.length;
    switch (b.state) {
      case 'move':
        if (!arrived) return;
        if (p.team === 'A' && b.role !== 'lurk' && b.route && this.plans.A.pushAt === Infinity) {
          b.state = 'wait';
          b.reason = 'staged; waiting for the team';
          b.look = yawTo(p.body.pos, this.tactics.site[this.plans.A.site]);
        } else {
          b.state = 'hold';
          b.holdUntil = now + 6 + b.pers.patience * 14;
        }
        return;
      case 'wait':
        if (this.plans.A.pushAt <= now - (b.role === 'entry' ? 0 : 0.4 + (1 - b.pers.aggression) * 0.8)) this.pushSite(p, b);
        return;
      case 'hold':
        if (p.team === 'A') {
          // Lurkers move up once the team has committed; others re-take a spot.
          if (b.role === 'lurk' && (this.plans.A.pushAt <= now || sim.timeLeft() < 40)) return this.pushSite(p, b);
          if (now > b.holdUntil) this.pushSite(p, b);
          return;
        }
        if (now > b.holdUntil) this.holdZone(p, b, 'reposition within the zone', p.body.pos);
        return;
      case 'search':
        if (arrived) {
          b.memory = null;
          this.resume(p, b, 'searched: nothing there');
        }
        return;
      case 'support':
      case 'retreat':
        if (arrived) {
          b.state = 'hold';
          b.holdUntil = now + 3 + b.pers.patience * 5;
          b.reason = `${b.reason} (holding)`;
        }
        return;
      case 'combat':
        this.resume(p, b, 'fight over');
        return;
      case 'retake':
      case 'fetch':
        if (arrived) this.resume(p, b, 'job done');
        return;
      default:
        return;
    }
  }

  /** Back to the role's plan after a detour. */
  private resume(p: SimPlayer, b: Brain, why: string): void {
    if (p.team === 'D') return this.holdZone(p, b, why);
    if (b.role === 'lurk' && this.plans.A.pushAt > this.sim.time) {
      const spot = chooseSpot(this.tactics.lurkSpots(this.plans.A.site === 'A' ? 'B' : 'A'), this.claims(p), [], () => this.sim.random(), { minSep: 8 });
      if (spot) return this.setDest(p, b, spot.pos, 'move', `lurk: ${why}`, spot.look);
    }
    if (this.plans.A.pushAt <= this.sim.time || !b.route) return this.pushSite(p, b);
    this.setDest(p, b, this.stagePoint(b.route, 2), 'move', why, null, b.route);
  }

  /** Attackers go into the site, each to a different position; the carrier to plant. */
  private pushSite(p: SimPlayer, b: Brain): void {
    const sim = this.sim;
    const site = this.plans.A.site;
    const r = sim.map.def.bombsites[site];
    if (p.id === sim.bomb.carrier && sim.bomb.state === 'carried') {
      const spots = this.tactics.holdSpots(site).filter((s) => sim.map.inRect(s.pos, r));
      const spot = chooseSpot(spots, this.claims(p), [], () => sim.random(), { minSep: 4, from: p.body.pos, maxTravel: 18 });
      this.setDest(p, b, spot ? spot.pos : sim.map.rectCenter(r), 'hold', `carrier: plant at ${site}`, spot?.look ?? null, b.route);
      b.holdUntil = Infinity;
      return;
    }
    // Going in: flash the site, or smoke off the way the Defenders come from.
    const c = this.tactics.site[site];
    if (p.nades.flash > 0 && sim.random() < 0.8) b.throwPlan = { type: 'flash', target: { x: c.x, y: c.y + 1.5, z: c.z }, until: sim.time + 3, fireToggle: false };
    else if (p.nades.smoke > 0) {
      const ds = this.tactics.spawn.D;
      const l = Math.max(1, dist2D(ds, c));
      b.throwPlan = { type: 'smoke', target: { x: c.x + ((ds.x - c.x) / l) * 6, y: c.y, z: c.z + ((ds.z - c.z) / l) * 6 }, until: sim.time + 3, fireToggle: false };
    }
    const inner = this.tactics.holdSpots(site).filter((s) => sim.map.inRect(s.pos, { x0: r.x0 - 3, z0: r.z0 - 3, x1: r.x1 + 3, z1: r.z1 + 3 }));
    const spot = chooseSpot(inner, this.claims(p), this.claimedAreas(p), () => sim.random(), { minSep: 6, from: p.body.pos, maxTravel: 25 });
    this.setDest(p, b, spot ? spot.pos : this.tactics.site[site], 'hold', `push into ${site}`, spot?.look ?? null, b.route);
    b.holdUntil = Infinity;
  }

  private guardBomb(p: SimPlayer, b: Brain, why: string, exclude?: Vec3): void {
    const bomb = this.sim.bomb;
    const claims = this.claims(p);
    if (exclude) claims.push(exclude, exclude);
    const spot = chooseSpot(this.tactics.bombSpots(bomb.pos, 'A'), claims, this.claimedAreas(p), () => this.sim.random(), { minSep: 6, from: p.body.pos, maxTravel: 30 });
    this.setDest(p, b, spot ? spot.pos : bomb.pos, 'guard', `guard the bomb: ${why}`, spot?.look ?? yawTo(p.body.pos, bomb.pos));
  }

  /** Defenders: the nearest goes for the bomb, the others cover from different spots. */
  private retake(p: SimPlayer, b: Brain): void {
    const bomb = this.sim.bomb;
    let closest: SimPlayer | null = null;
    for (const q of this.alive('D')) if (!closest || dist2D(q.body.pos, bomb.pos) < dist2D(closest.body.pos, bomb.pos)) closest = q;
    if (closest === p) {
      if (b.state !== 'retake' || !b.dest || dist2D(b.dest, bomb.pos) > 0.5) this.setDest(p, b, { ...bomb.pos }, 'retake', 'closest to the bomb: defuse', null);
      return;
    }
    if (b.state === 'retake' && b.dest && dist2D(b.dest, bomb.pos) > 0.5) return;
    const spot = chooseSpot(this.tactics.bombSpots(bomb.pos, 'D'), this.claims(p), this.claimedAreas(p), () => this.sim.random(), { minSep: 6 });
    this.setDest(p, b, spot ? spot.pos : bomb.pos, 'retake', 'cover the defuse', spot?.look ?? null);
  }

  // --------------------------------------------------------------- combat

  private combat(p: SimPlayer, b: Brain, d: DiffParams, target: SimPlayer, cmd: PlayerCmd): { moveDir: Vec3 | null; lookYaw: number; lookPitch: number } {
    const sim = this.sim;
    const now = sim.time;
    const eye = sim.eyePos(p);
    const aimPt = this.aimPoint(target, b, d);
    const dir = { x: aimPt.x - eye.x, y: aimPt.y - eye.y, z: aimPt.z - eye.z };
    const ang = anglesFromDir(dir);
    if (now >= b.errAt) {
      // Aim error shrinks the longer a bot has been tracking its target.
      const settle = clamp(1 - (now - b.targetSince) / 1.6, 0.25, 1);
      b.errYaw = (sim.random() * 2 - 1) * d.aimError * settle;
      b.errPitch = (sim.random() * 2 - 1) * d.aimError * 0.6 * settle;
      b.errAt = now + 0.35 + sim.random() * 0.3;
    }
    // Compensate part of the recoil (better bots control spray better).
    const comp = this.difficulty === 'hard' ? 0.8 : this.difficulty === 'normal' ? 0.5 : 0.15;
    const lookYaw = ang.yaw + b.errYaw - p.punchYaw * comp;
    const lookPitch = ang.pitch + b.errPitch - p.punchPitch * comp;

    const range = dist(eye, aimPt);
    const def = sim.weaponOf(p);
    const w = p.weapons[p.current];
    const needReload = !!w && def.magSize > 0 && w.mag === 0;
    let moveDir: Vec3 | null = null;
    let strafeMove: Vec3 | null = null;
    if (b.state !== 'retreat') b.state = 'combat';

    // Outnumbered, hurt, or reloading in the open: fall back to cover.
    const allies = this.alive(p.team, false).filter((q) => q !== p && dist2D(q.body.pos, p.body.pos) < 12).length;
    const outnumbered = b.visible >= 2 && b.visible > allies + 1;
    const hurt = p.health < 35 && b.pers.caution > 0.45;
    if (needReload && w!.reserve > 0) cmd.reload = true;
    if (d.seekCover && (outnumbered || hurt || (needReload && w!.reserve > 0)) && b.state !== 'retreat' && now >= b.retreatReadyAt) {
      const spot = this.coverNear(p.body.pos, 3, 11, null, this.claims(p), sim.eyePos(target));
      if (spot) {
        b.retreatReadyAt = now + 4 + b.pers.caution * 3;
        this.setDest(p, b, spot.pos, 'retreat', outnumbered ? `outnumbered ${b.visible} to ${allies + 1}` : hurt ? 'hurt: fall back' : 'reload in cover', null);
        b.advanceBlockedUntil = now + 2;
      }
    }

    if (b.state === 'retreat' && b.pathIdx < b.path.length) {
      moveDir = this.followPath(p, b);
    } else {
      if (b.state === 'retreat') b.state = 'combat';
      const pref = (PREFERRED_RANGE[def.cls] ?? 12) * (1 + b.pers.caution * 0.3 - b.pers.aggression * 0.3);
      const advance = ((range > pref * 1.6 && b.pers.aggression > 0.3 && def.cls !== 'sniper') || def.cls === 'melee') && now >= b.advanceBlockedUntil;
      if (advance) {
        // Close the distance through the map, not in a straight line into a crate.
        if (now >= b.combatPathAt) {
          b.combatPathAt = now + 0.6;
          b.path = this.nav.findPath(p.body.pos, target.body.pos) ?? [];
          b.pathIdx = 0;
        }
        moveDir = this.followPath(p, b);
      } else if (def.cls === 'sniper' && range < 8) {
        moveDir = { x: -dir.x, y: 0, z: -dir.z };
      } else if (d.strafe && !(d.stopToShoot && range > 12)) {
        if (now >= b.strafeUntil) {
          b.strafeDir = sim.random() < 0.5 ? -1 : 1;
          b.strafeUntil = now + 0.5 + sim.random() * 0.7;
        }
        const side = { x: Math.cos(ang.yaw) * b.strafeDir, y: 0, z: -Math.sin(ang.yaw) * b.strafeDir };
        // Don't strafe into a wall: flip if that side is blocked.
        const probe = { x: p.body.pos.x + side.x * 0.7, y: p.body.pos.y + 0.05, z: p.body.pos.z + side.z * 0.7 };
        if (sim.map.world.hullBlocked(probe, 0.4, 1.6)) {
          b.strafeDir *= -1;
          side.x = -side.x;
          side.z = -side.z;
        }
        moveDir = side;
        strafeMove = side;
      }
    }

    // Sniper: scope in before firing at range.
    if (def.scope && range > 8 && p.scope === 0 && now > b.reactionAt - 0.2) {
      cmd.altFire = !b.wantScope;
      b.wantScope = !b.wantScope;
    } else {
      b.wantScope = false;
    }

    // Fire when the reaction delay has passed and the aim is on target.
    const aimErr = Math.hypot(angleDiff(b.aimYaw, lookYaw), b.aimPitch - lookPitch);
    const tolerance = Math.atan2(0.35, Math.max(range, 1)) + 1.5 * DEG;
    if (now >= b.reactionAt && aimErr < tolerance * 2.2 && !sim.isReloading(p) && !needReload) {
      if (def.cls === 'melee') {
        cmd.fire = range < 2;
      } else if (!def.automatic) {
        b.semiToggle = !b.semiToggle;
        cmd.fire = b.semiToggle;
      } else if (range > 15) {
        if (now >= b.burstPauseUntil) {
          if (b.burstLeft <= 0) b.burstLeft = Math.max(2, Math.round(d.burst * (0.6 + sim.random() * 0.6)));
          cmd.fire = true;
          if (p.shotsFired >= b.burstLeft) {
            b.burstLeft = 0;
            b.burstPauseUntil = now + 0.25 + sim.random() * 0.25;
            cmd.fire = false;
          }
        }
      } else {
        cmd.fire = true;
      }
    }
    if (d.stopToShoot && cmd.fire && range > 12 && b.state !== 'retreat') moveDir = null;
    // Normal bots dodge at walking pace; only hard bots strafe at a full run.
    // Full-speed dodging made them too hard to hit (playtest feedback).
    cmd.walk = this.difficulty === 'normal' && moveDir !== null && moveDir === strafeMove;
    cmd.crouch = this.difficulty !== 'easy' && cmd.fire && range > 25 && def.cls !== 'sniper' && !moveDir;
    return { moveDir, lookYaw, lookPitch };
  }

  private aimPoint(t: SimPlayer, b: Brain, d: DiffParams): Vec3 {
    const head = (b.id * 7919 + Math.floor(this.sim.time * 0.5)) % 100 < d.headChance * 100;
    const eye = this.sim.eyePos(t);
    return head ? { x: eye.x, y: eye.y + 0.05, z: eye.z } : { x: eye.x, y: t.body.pos.y + (eye.y - t.body.pos.y) * 0.72, z: eye.z };
  }

  private perceive(p: SimPlayer, b: Brain, d: DiffParams): void {
    const sim = this.sim;
    const eye = sim.eyePos(p);
    let best: SimPlayer | null = null;
    let bestD = Infinity;
    let visible = 0;
    for (const q of sim.players) {
      if (!q.alive || q.team === p.team) continue;
      const qe = sim.eyePos(q);
      const dd = dist(eye, qe);
      if (dd > d.viewDist) continue;
      const a = anglesFromDir({ x: qe.x - eye.x, y: qe.y - eye.y, z: qe.z - eye.z });
      const inCone = Math.abs(angleDiff(a.yaw, b.aimYaw)) < d.fov / 2 || dd < 2.5;
      // Keep tracking a current target slightly outside the cone.
      const tracking = q.id === b.targetId && Math.abs(angleDiff(a.yaw, b.aimYaw)) < d.fov;
      if (!inCone && !tracking) continue;
      if (!sim.canSee(p, q)) continue;
      visible++;
      if (dd < bestD) {
        bestD = dd;
        best = q;
      }
    }
    b.visible = visible;
    if (best) {
      if (b.targetId !== best.id) {
        b.targetId = best.id;
        b.targetSince = sim.time;
        const surprised = sim.time - p.lastHurt < 0.5 ? 0.6 : 1;
        b.reactionAt = sim.time + d.reaction * b.pers.reaction * (0.75 + sim.random() * 0.5) * surprised;
        b.errAt = 0;
        this.report(p.team, best.body.pos, 'seen', p.id, best.id);
      }
      b.memory = { pos: { ...best.body.pos }, time: sim.time, seen: true };
    } else if (b.targetId !== null) {
      b.targetId = null;
      // Lost sight: re-think soon, and maybe reposition instead of re-peeking.
      b.nextDecision = Math.min(b.nextDecision, sim.time + 0.3);
      if (b.state === 'combat') this.resumeAfterFight(p, b);
    }
    // Being shot without seeing the shooter: turn around toward the noise.
    if (!best && sim.time - p.lastHurt < 0.15 && (!b.memory || sim.time - b.memory.time > 1)) {
      const enemy = sim.players.find((q) => q.alive && q.team !== p.team && sim.canSee(p, q));
      if (enemy) b.memory = { pos: { ...enemy.body.pos }, time: sim.time, seen: false };
    }
  }

  /** After a fight: cautious bots shift to a different spot, others carry on. */
  private resumeAfterFight(p: SimPlayer, b: Brain): void {
    const sim = this.sim;
    if (sim.random() < b.pers.caution * 0.7) {
      const spot = this.coverNear(p.body.pos, 2.5, 7, b.memory?.pos ?? null, this.claims(p));
      if (spot) return this.setDest(p, b, spot.pos, 'support', 'reposition after the fight', spot.look);
    }
    this.resume(p, b, 'fight over');
  }

  // ------------------------------------------------------------- movement

  private setDest(p: SimPlayer, b: Brain, dest: Vec3, state: State, reason: string, look: number | null, route?: Route | null): void {
    b.state = state;
    b.reason = reason;
    b.dest = { ...dest };
    b.look = look;
    const cost = route ? this.routeCost(route) : undefined;
    b.path = this.nav.findPath(p.body.pos, dest, cost) ?? this.nav.findPath(p.body.pos, dest) ?? [];
    b.pathIdx = 0;
    b.stuckCount = 0;
  }

  /** Per-cell extra cost that keeps a bot inside its route's corridor. */
  private routeCost(route: Route): Float32Array {
    let c = this.corridorCost.get(route);
    if (!c) {
      const { cols, rows } = this.sim.map.def;
      c = new Float32Array(cols * rows).fill(3);
      for (const i of route.cells) {
        const x = i % cols;
        const z = Math.floor(i / cols);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < cols && z + dz >= 0 && z + dz < rows) c[(z + dz) * cols + x + dx] = 0;
      }
      this.corridorCost.set(route, c);
    }
    return c;
  }

  private followPath(p: SimPlayer, b: Brain): Vec3 | null {
    while (b.pathIdx < b.path.length && dist2D(p.body.pos, b.path[b.pathIdx]) < 0.55) b.pathIdx++;
    if (b.pathIdx >= b.path.length) return null;
    const wp = b.path[b.pathIdx];
    return { x: wp.x - p.body.pos.x, y: 0, z: wp.z - p.body.pos.z };
  }

  /** Steer slightly sideways around a teammate directly in the way. */
  private avoidTeammates(p: SimPlayer, dir: Vec3): Vec3 {
    const l = Math.hypot(dir.x, dir.z) || 1;
    const fx = dir.x / l;
    const fz = dir.z / l;
    let ax = 0;
    let az = 0;
    for (const q of this.sim.players) {
      if (q === p || !q.alive || q.team !== p.team) continue;
      const dx = q.body.pos.x - p.body.pos.x;
      const dz = q.body.pos.z - p.body.pos.z;
      const dd = Math.hypot(dx, dz);
      if (dd > 1.3 || dd < 1e-3) continue;
      const ahead = (dx * fx + dz * fz) / dd;
      if (ahead < 0.2) continue;
      // Push away sideways from the teammate (whichever side it's not on).
      const sideSign = dx * -fz + dz * fx > 0 ? -1 : 1;
      const w = (1.3 - dd) / 1.3;
      ax += -fz * sideSign * w;
      az += fx * sideSign * w;
    }
    if (!ax && !az) return dir;
    return { x: fx + ax * 1.2, y: 0, z: fz + az * 1.2 };
  }

  /**
   * Progress monitoring in every state. Pressing movement keys without
   * getting anywhere: 1st time sidestep (and hop), 2nd time re-plan the
   * path, 3rd time pick a different destination.
   */
  private checkProgress(p: SimPlayer, b: Brain, cmd: PlayerCmd, moveDir: Vec3 | null): void {
    const sim = this.sim;
    const now = sim.time;
    if (now < b.progAt) return;
    b.progAt = now + 0.5;
    const moved = dist2D(p.body.pos, b.progPos);
    b.progPos = { ...p.body.pos };
    const pressing = cmd.forward !== 0 || cmd.side !== 0;
    if (!pressing || !moveDir || moved >= 0.2 || p.action) {
      if (moved >= 0.2) b.stuckCount = 0;
      return;
    }
    b.stuckCount++;
    b.stuckTime += 0.5;
    const l = Math.hypot(moveDir.x, moveDir.z) || 1;
    if (b.stuckCount === 1) {
      // Sidestep toward whichever side is open.
      const left = { x: -moveDir.z / l, y: 0, z: moveDir.x / l };
      const probe = { x: p.body.pos.x + left.x * 0.8, y: p.body.pos.y + 0.05, z: p.body.pos.z + left.z * 0.8 };
      const side = sim.map.world.hullBlocked(probe, 0.4, 1.6) ? { x: -left.x, y: 0, z: -left.z } : left;
      b.sideDir = { x: side.x + (moveDir.x / l) * 0.3, y: 0, z: side.z + (moveDir.z / l) * 0.3 };
      b.sideUntil = now + 0.45;
      b.jumpUntil = now + 0.1;
    } else if (b.stuckCount === 2) {
      if (b.state === 'combat') {
        b.advanceBlockedUntil = now + 1.5; // stop pushing toward the enemy for a moment
        b.path = [];
      } else if (b.dest) {
        b.path = this.nav.findPath(p.body.pos, b.dest) ?? [];
        b.pathIdx = 0;
        b.reason = `${b.reason} (re-planned: stuck)`;
      }
    } else {
      b.stuckCount = 0;
      if (b.state === 'fetch' || b.state === 'retake') {
        if (b.dest) {
          b.path = this.nav.findPath(p.body.pos, b.dest) ?? [];
          b.pathIdx = 0;
        }
        return;
      }
      if (p.id === sim.bomb.carrier && sim.bomb.state === 'carried' && b.state !== 'combat') return this.pushSite(p, b);
      const spot = this.coverNear(p.body.pos, 3, 10, null, this.claims(p));
      if (spot) this.setDest(p, b, spot.pos, b.state === 'combat' ? 'retreat' : b.state, 'stuck: new destination', spot.look);
    }
  }

  /**
   * A position with cover within [rMin, rMax] metres of `around`. With
   * `watch`, it should see that point; with `hideFrom`, it should NOT be
   * visible from that eye position. Avoids `claims`.
   */
  private coverNear(around: Vec3, rMin: number, rMax: number, watch: Vec3 | null, claims: Vec3[], hideFrom?: Vec3): Spot | null {
    const map = this.sim.map;
    const t = this.tactics;
    const cs = map.def.cellSize;
    const c0 = map.cellOf(around);
    const r = Math.ceil(rMax / cs);
    const spots: Spot[] = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = c0.x + dx;
        const z = c0.z + dz;
        if (map.cell(x, z) !== CELL_FLOOR || map.stairAt(x, z) >= 0) continue;
        const pos = map.cellCenter(x, z);
        const dd = Math.hypot(pos.x - around.x, pos.z - around.z);
        if (dd < rMin || dd > rMax) continue;
        const cover = t.coverAt(z * map.def.cols + x);
        let value = Math.min(cover, 4) * 0.6;
        const eye = { x: pos.x, y: pos.y + 1.6, z: pos.z };
        if (watch) value += map.world.lineOfSight(eye, { x: watch.x, y: watch.y + 1.4, z: watch.z }) ? 1.5 : -1;
        if (hideFrom) value += map.world.lineOfSight(eye, hideFrom) ? -4 : 3;
        spots.push({ pos, cell: z * map.def.cols + x, area: map.areaNameAt(pos), cover, value, look: watch ? yawTo(pos, watch) : 0 });
      }
    }
    spots.sort((a, b) => b.value - a.value);
    return chooseSpot(spots, claims, [], () => this.sim.random(), { minSep: 4, jitter: 0.4 });
  }

  // -------------------------------------------------------------- economy

  /**
   * Buys like a player would: a full buy when the money allows (mostly the
   * team's main rifle, sometimes a scoped rifle, a sniper or the machine
   * gun), an SMG / shotgun / cheap rifle when it doesn't, a better pistol on
   * a pistol round, armour whenever it can.
   */
  private buy(p: SimPlayer, b: Brain): void {
    if (b.boughtRound === this.sim.round || !this.sim.canBuy(p)) return;
    b.boughtRound = this.sim.round;
    const sim = this.sim;
    const r = sim.random();
    const mine = (id: WeaponId) => !WEAPONS[id].team || WEAPONS[id].team === p.team;
    const pick = (ids: WeaponId[]): WeaponId | null => {
      const ok = ids.filter(mine);
      return ok.length ? ok[Math.floor(sim.random() * ok.length)] : null;
    };
    const rifle: WeaponId = p.team === 'A' ? 'ar7' : 'k4';
    const has = p.weapons[1]?.id;
    const money = p.money;
    const order: string[] = [];
    if (!has) {
      let gun: WeaponId | null = null;
      if (money >= WEAPONS[rifle].price + 650) {
        // Full buy.
        if (this.difficulty !== 'easy' && money >= 4750 + 1000 && r < 0.12) gun = 'longbow';
        else if (money >= 5750 + 1000 && r < 0.15) gun = 'mg9';
        else if (money >= 5000 + 1000 && r < 0.18) gun = pick(['rp3', 'vg5']);
        else if (money >= 3500 + 1000 && r < 0.3) gun = pick(['sg5', 'au3']);
        else if (r < 0.38) gun = 'kestrel';
        else gun = rifle;
      } else if (money >= 2000 + 650 && sim.round > 1) {
        gun = r < 0.5 ? pick(['gr3', 'fm2']) : r < 0.75 ? pick(['p50', 'u45', 'mk5']) : pick(['pump12', 'auto12'].filter((id) => WEAPONS[id as WeaponId].price + 650 <= money) as WeaponId[]);
      } else if (money >= 1250 + 650 && sim.round > 1) {
        gun = r < 0.7 ? pick(['tp9', 'r10', 'mk5']) : 'pump12';
      }
      if (gun) {
        order.push(money - WEAPONS[gun].price >= 1000 ? 'helmet' : 'kevlar', gun);
      } else if (money >= 650 + 650 && sim.round > 1) {
        order.push('kevlar', pick(['hc50', 'k57', 'm45'])!);
      } else if (money >= 650 && r < 0.6) {
        order.push(pick(['hc50', 'k57', 'm45'])!);
      } else if (money >= 650 && sim.round > 1) {
        order.push('kevlar');
      }
    } else if (p.armor < 50 && money >= 650) {
      order.push(money >= 1000 ? 'helmet' : 'kevlar');
    }
    // Defenders who can spare it carry a kit (it halves the defuse time).
    if (p.team === 'D' && !p.kit && this.difficulty !== 'easy') order.push('defuser');
    for (const item of order) sim.buy(p, item as Parameters<Simulation['buy']>[1]);
    // Grenades with what's left (not on the pistol round).
    if (sim.round > 1 && this.difficulty !== 'easy') {
      const nades: NadeType[] = p.team === 'A' ? (sim.random() < 0.5 ? ['flash', 'smoke'] : ['flash', 'he']) : sim.random() < 0.6 ? ['he', 'flash'] : ['flash'];
      for (const t of nades) if (p.money >= WEAPONS[t].price + 200) sim.buy(p, t);
    }
  }

  /** Default team name list for bots. */
  static botName(team: Team, i: number): string {
    const names = team === 'A'
      ? ['Rook', 'Vex', 'Gravel', 'Dune', 'Sable', 'Cinder', 'Kestrel', 'Flint', 'Ash', 'Moth']
      : ['Warden', 'Bishop', 'Halo', 'Ridge', 'Atlas', 'Granite', 'Echo', 'Harbor', 'Quill', 'Talon'];
    return names[i % names.length];
  }
}

/** Fraction of route a's cells that route b also uses. */
function overlap(a: Route, b: Route): number {
  if (a === b) return 1;
  const set = new Set(b.cells);
  return a.cells.filter((i) => set.has(i)).length / Math.max(1, a.cells.length);
}

function yawTo(a: Vec3, b: Vec3): number {
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

/** Who keeps their place when two bots crowd each other (higher wins). */
function rank(b: Brain, p: SimPlayer, sim: Simulation): number {
  if (p.id === sim.bomb.carrier) return 5;
  return { entry: 4, anchor: 3, flank: 3, mid: 2, support: 1, lurk: 2 }[b.role];
}
