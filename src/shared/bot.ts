import type { Team } from './map';
import { NavGrid } from './nav';
import { emptyCmd, type PlayerCmd, type SimEvent, type SimPlayer, type Simulation } from './sim';
import { angleDiff, anglesFromDir, clamp, dist, dist2D, type Vec3 } from './vec';
import { WEAPONS, type WeaponId } from './weapons';

/**
 * Bot AI. Bots are ordinary simulation participants: they only ever act by
 * producing a PlayerCmd, exactly like a human's keyboard and mouse. They
 * perceive enemies through a view cone + line-of-sight test and by hearing
 * gunfire/footsteps — never by reading positions they could not know.
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

type Mode = 'objective' | 'hold' | 'hunt' | 'cover';

interface Brain {
  id: number;
  mode: Mode;
  goal: Vec3 | null;
  path: Vec3[];
  pathIdx: number;
  holdLook: number | null;
  holdUntil: number;
  targetId: number | null;
  targetSince: number;
  reactionAt: number;
  lastKnown: Vec3 | null;
  lastKnownAt: number;
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
  stuckCheckAt: number;
  stuckPos: Vec3;
  stuckCount: number;
  jumpUntil: number;
  nextPerceive: number;
  boughtRound: number;
  wantScope: boolean;
  site: 'A' | 'B';
}

interface TeamPlan {
  site: 'A' | 'B';
  intel: { pos: Vec3; time: number } | null;
}

export class BotDirector {
  private readonly sim: Simulation;
  readonly nav: NavGrid;
  difficulty: Difficulty;
  private readonly brains = new Map<number, Brain>();
  private readonly plans: Record<Team, TeamPlan> = { A: { site: 'A', intel: null }, D: { site: 'A', intel: null } };
  private planRound = -1;
  private readonly entryCache = new Map<string, Vec3>();

  constructor(sim: Simulation, difficulty: Difficulty) {
    this.sim = sim;
    this.difficulty = difficulty;
    this.nav = new NavGrid(sim.map);
  }

  private brain(p: SimPlayer): Brain {
    let b = this.brains.get(p.id);
    if (!b) {
      b = {
        id: p.id, mode: 'objective', goal: null, path: [], pathIdx: 0, holdLook: null, holdUntil: 0,
        targetId: null, targetSince: 0, reactionAt: 0, lastKnown: null, lastKnownAt: -99,
        aimYaw: p.yaw, aimPitch: 0, errYaw: 0, errPitch: 0, errAt: 0,
        strafeDir: 1, strafeUntil: 0, burstLeft: 0, burstPauseUntil: 0, semiToggle: false,
        stuckCheckAt: 0, stuckPos: { ...p.body.pos }, stuckCount: 0, jumpUntil: 0, nextPerceive: 0,
        boughtRound: -1, wantScope: false, site: 'A',
      };
      this.brains.set(p.id, b);
    }
    return b;
  }

  /** Must be called with the events of the tick that just ran (for hearing). */
  observe(events: readonly SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'roundStart') this.resetRound();
      let src: SimPlayer | undefined;
      let pos: Vec3 | undefined;
      let loud = 1;
      if (ev.type === 'shot') {
        src = this.sim.getPlayer(ev.shooter);
        pos = ev.origin;
      } else if (ev.type === 'step' && !ev.walk) {
        src = this.sim.getPlayer(ev.player);
        pos = ev.pos;
        loud = 0.45;
      } else if (ev.type === 'land' || ev.type === 'jump') {
        src = this.sim.getPlayer(ev.player);
        pos = ev.pos;
        loud = 0.4;
      } else if (ev.type === 'kill') {
        // A teammate's death is radioed: everyone learns roughly where it happened.
        const victim = this.sim.getPlayer(ev.victim);
        const killer = this.sim.getPlayer(ev.killer);
        if (victim && killer && killer.team !== victim.team) {
          this.plans[victim.team].intel = { pos: { ...victim.body.pos }, time: this.sim.time };
        }
        continue;
      } else continue;
      if (!src || !pos) continue;
      for (const p of this.sim.players) {
        if (!p.isBot || !p.alive || p.team === src.team) continue;
        const d = DIFFICULTY[this.difficulty];
        if (dist(p.body.pos, pos) > d.hearDist * loud) continue;
        const b = this.brain(p);
        if (b.targetId !== null) continue;
        b.lastKnown = { x: pos.x, y: this.sim.map.surfaceY(pos), z: pos.z };
        b.lastKnownAt = this.sim.time;
      }
    }
  }

  private resetRound(): void {
    this.planRound = this.sim.round;
    this.plans.A = { site: this.sim.random() < 0.5 ? 'A' : 'B', intel: null };
    this.plans.D = { site: 'A', intel: null };
    const defenders = this.sim.players.filter((p) => p.team === 'D' && p.isBot);
    defenders.forEach((p, i) => {
      const b = this.brain(p);
      b.mode = 'hold';
      b.goal = null;
      b.path = [];
      b.targetId = null;
      b.lastKnown = null;
      b.holdLook = null;
      // Split defenders between sites, alternating, starting at a random one.
      b.site = (i + (this.sim.random() < 0.5 ? 0 : 1)) % 2 === 0 ? 'A' : 'B';
    });
    for (const p of this.sim.players.filter((q) => q.team === 'A' && q.isBot)) {
      const b = this.brain(p);
      b.mode = 'objective';
      b.goal = null;
      b.path = [];
      b.targetId = null;
      b.lastKnown = null;
    }
  }

  /** Produces this tick's command for every living bot. */
  update(): void {
    if (this.planRound !== this.sim.round) this.resetRound();
    for (const p of this.sim.players) {
      if (!p.isBot) continue;
      if (!p.alive) {
        this.brains.delete(p.id);
        continue;
      }
      this.sim.setCmd(p, this.think(p));
    }
  }

  // ------------------------------------------------------------------ think

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
    if (p.current !== want && !sim.isReloading(p)) cmd.slot = want;

    // ---- perception (10 Hz)
    if (now >= b.nextPerceive) {
      b.nextPerceive = now + 0.1;
      this.perceive(p, b, d);
    }
    const target = b.targetId !== null ? sim.getPlayer(b.targetId) : undefined;

    let moveDir: Vec3 | null = null;
    let lookYaw: number | null = null;
    let lookPitch = 0;

    if (target && target.alive) {
      // ---- combat
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
      lookYaw = ang.yaw + b.errYaw - p.punchYaw * comp;
      lookPitch = ang.pitch + b.errPitch - p.punchPitch * comp;

      const range = dist(eye, aimPt);
      const def = sim.weaponOf(p);
      const w = p.weapons[p.current];
      const needReload = w && def.magSize > 0 && w.mag === 0;

      if (needReload && w!.reserve > 0) {
        cmd.reload = true;
        if (d.seekCover && b.mode !== 'cover') this.takeCover(p, b, target);
      }

      // Movement while fighting.
      if (b.mode === 'cover' && b.path.length) {
        moveDir = this.followPath(p, b);
      } else if (d.strafe && !(d.stopToShoot && range > 12)) {
        if (now >= b.strafeUntil) {
          b.strafeDir = sim.random() < 0.5 ? -1 : 1;
          b.strafeUntil = now + 0.35 + sim.random() * 0.6;
        }
        const yaw = ang.yaw;
        moveDir = { x: Math.cos(yaw) * b.strafeDir, y: 0, z: -Math.sin(yaw) * b.strafeDir };
        if (def.cls === 'melee' || (def.cls === 'shotgun' && range > 8)) {
          moveDir = { x: dir.x, y: 0, z: dir.z };
        }
      } else if (def.cls === 'melee' || range > d.viewDist * 0.5) {
        moveDir = { x: dir.x, y: 0, z: dir.z };
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
          // Burst at range, then let recoil settle.
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
      if (d.stopToShoot && cmd.fire && range > 12) moveDir = null;
      cmd.walk = false;
      cmd.crouch = this.difficulty !== 'easy' && cmd.fire && range > 25 && def.cls !== 'sniper';
    } else {
      // ---- no visible enemy
      b.targetId = null;
      if (b.mode === 'cover') b.mode = 'hunt';
      // With the bomb ticking, Defenders go for it instead of chasing noises.
      if (p.team === 'D' && sim.bomb.state === 'planted') {
        b.lastKnown = null;
        if (b.mode === 'hunt') b.mode = 'objective';
      }
      if (b.lastKnown && now - b.lastKnownAt < 7) {
        if (b.mode !== 'hunt' || !b.goal || dist2D(b.goal, b.lastKnown) > 3) this.setGoal(p, b, b.lastKnown, 'hunt');
      } else if (b.mode === 'hunt') {
        b.lastKnown = null;
        b.mode = p.team === 'D' ? 'hold' : 'objective';
        b.goal = null;
      }
      this.planObjective(p, b);
      if (b.path.length) {
        moveDir = this.followPath(p, b);
        if (moveDir) lookYaw = anglesFromDir(moveDir).yaw;
        if (b.mode === 'hunt' && b.lastKnown && dist2D(p.body.pos, b.lastKnown) < 12) {
          // Approaching a known threat: look at it and walk quietly.
          const eye = sim.eyePos(p);
          const a = anglesFromDir({ x: b.lastKnown.x - eye.x, y: b.lastKnown.y + 1.4 - eye.y, z: b.lastKnown.z - eye.z });
          lookYaw = a.yaw;
          lookPitch = a.pitch;
          cmd.walk = this.difficulty !== 'easy';
        }
      } else if (b.holdLook !== null) {
        lookYaw = b.holdLook + Math.sin(now * 0.7 + p.id) * 0.35;
      }
      // Fetching a dropped bomb: the path can end at a cell centre short of
      // the bomb (near walls), so cover the last few metres straight at it.
      const bomb = sim.bomb;
      if (p.team === 'A' && bomb.state === 'dropped' && !b.path.length && b.goal && dist2D(b.goal, bomb.pos) < 0.5) {
        const d = dist2D(p.body.pos, bomb.pos);
        if (d > 0.3 && d < 4) {
          moveDir = { x: bomb.pos.x - p.body.pos.x, y: 0, z: bomb.pos.z - p.body.pos.z };
          lookYaw = anglesFromDir(moveDir).yaw;
        }
      }
      // Plant or defuse when standing in the right place with nobody in view.
      if (sim.canPlant(p) !== null || sim.canDefuse(p)) {
        cmd.use = true;
        moveDir = null;
      }
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

    // ---- convert world move direction into forward/side relative to view
    if (moveDir) {
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
      this.checkStuck(p, b, cmd);
    }
    if (now < b.jumpUntil) cmd.jump = true;
    return cmd;
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
      // Recently hurt bots notice threats faster; prefer the closest.
      if (dd < bestD) {
        bestD = dd;
        best = q;
      }
    }
    if (best) {
      if (b.targetId !== best.id) {
        b.targetId = best.id;
        b.targetSince = sim.time;
        const surprised = sim.time - p.lastHurt < 0.5 ? 0.6 : 1;
        b.reactionAt = sim.time + d.reaction * (0.75 + sim.random() * 0.5) * surprised;
        b.errAt = 0;
      }
      b.lastKnown = { ...best.body.pos };
      b.lastKnownAt = sim.time;
      this.plans[p.team].intel = { pos: { ...best.body.pos }, time: sim.time };
    } else if (b.targetId !== null) {
      b.targetId = null;
    }
    // Being shot without seeing the shooter: turn around toward the noise.
    if (!best && sim.time - p.lastHurt < 0.15 && !b.lastKnown) {
      const enemy = sim.players.find((q) => q.alive && q.team !== p.team && sim.canSee(p, q));
      if (enemy) {
        b.lastKnown = { ...enemy.body.pos };
        b.lastKnownAt = sim.time;
      }
    }
  }

  // ------------------------------------------------------------- objectives

  private planObjective(p: SimPlayer, b: Brain): void {
    const sim = this.sim;
    if (b.mode === 'hunt' || b.mode === 'cover') return;
    if (sim.phase === 'freeze') return;
    const plan = this.plans[p.team];
    const now = sim.time;
    if (this.planBomb(p, b)) return;

    // Act on fresh team intel.
    if (plan.intel && now - plan.intel.time < 6 && (!b.goal || dist2D(b.goal, plan.intel.pos) > 6)) {
      const rotate = p.team === 'A' || this.sim.random() < 0.02;
      if (rotate && dist2D(p.body.pos, plan.intel.pos) < 45) {
        this.setGoal(p, b, plan.intel.pos, 'objective');
        return;
      }
    }

    if (b.path.length || now < b.holdUntil) return;

    if (p.team === 'D') {
      const site = b.site;
      const elapsed = now - sim.roundStartTime;
      if (elapsed > 50 && sim.random() < 0.5) {
        // Nothing happened for a long time: go looking.
        this.setGoal(p, b, this.randomCell(), 'objective');
        b.holdLook = null;
        return;
      }
      const spot = this.randomCellIn(sim.map.def.bombsites[site], 2);
      const entry = this.entryPoint(site, 'A');
      this.setGoal(p, b, spot, 'hold');
      b.holdLook = anglesFromDir({ x: entry.x - spot.x, y: 0, z: entry.z - spot.z }).yaw;
      b.holdUntil = now + 8 + sim.random() * 10;
    } else {
      const site = plan.site;
      const reached = sim.map.inRect(p.body.pos, sim.map.def.bombsites[site]);
      if (!reached) {
        this.setGoal(p, b, this.randomCellIn(sim.map.def.bombsites[site], 0), 'objective');
      } else {
        // Site taken: push toward the defenders' spawn / other site.
        const other = site === 'A' ? 'B' : 'A';
        const choice = sim.random() < 0.5 ? sim.map.rectCenter(sim.map.def.buyZones.D) : sim.map.rectCenter(sim.map.def.bombsites[other]);
        this.setGoal(p, b, choice, 'objective');
      }
    }
  }

  /**
   * Bomb-specific goals. Returns true when it set (or kept) this bot's goal:
   * the carrier heads for the planned site and stays there to plant; the
   * nearest Attacker fetches a dropped bomb; once planted, Attackers guard
   * it and Defenders go to it to defuse.
   */
  private planBomb(p: SimPlayer, b: Brain): boolean {
    const sim = this.sim;
    const bomb = sim.bomb;
    const now = sim.time;
    const near = (g: Vec3 | null, t: Vec3) => !!g && dist2D(g, t) < 0.5;
    if (bomb.state === 'planted' && bomb.site) {
      if (p.team === 'D') {
        if (!near(b.goal, bomb.pos)) this.setGoal(p, b, { ...bomb.pos }, 'objective');
        b.holdLook = null;
        return true;
      }
      if (b.path.length || now < b.holdUntil) return true;
      const spot = this.randomCellIn(sim.map.def.bombsites[bomb.site], 1);
      const entry = this.entryPoint(bomb.site, 'D');
      this.setGoal(p, b, spot, 'hold');
      b.holdLook = anglesFromDir({ x: entry.x - spot.x, y: 0, z: entry.z - spot.z }).yaw;
      b.holdUntil = now + 6 + sim.random() * 8;
      return true;
    }
    if (p.team !== 'A') return false;
    if (bomb.state === 'dropped') {
      let fetcher: SimPlayer | null = null;
      for (const q of sim.players) {
        if (q.team !== 'A' || !q.alive || !q.isBot) continue;
        if (!fetcher || dist2D(q.body.pos, bomb.pos) < dist2D(fetcher.body.pos, bomb.pos)) fetcher = q;
      }
      if (fetcher === p) {
        if (!near(b.goal, bomb.pos)) this.setGoal(p, b, { ...bomb.pos }, 'objective');
        return true;
      }
      return false;
    }
    if (bomb.state === 'carried' && bomb.carrier === p.id) {
      const site = sim.map.def.bombsites[this.plans.A.site];
      if (sim.map.inRect(p.body.pos, site)) return true; // there: think() plants
      if (!b.goal || !sim.map.inRect(b.goal, site) || !b.path.length) this.setGoal(p, b, this.randomCellIn(site, 0), 'objective');
      return true;
    }
    return false;
  }

  /** Where the given team's approach path enters a bombsite (cached). */
  private entryPoint(site: 'A' | 'B', fromTeam: Team): Vec3 {
    const key = site + fromTeam;
    const cached = this.entryCache.get(key);
    if (cached) return cached;
    const map = this.sim.map;
    const from = map.rectCenter(map.def.buyZones[fromTeam]);
    const to = map.rectCenter(map.def.bombsites[site]);
    const path = this.nav.findPath(from, to) ?? [to];
    // Walk back from the end until we're ~10 m outside the site.
    let entry = path[0];
    for (let i = path.length - 1; i >= 0; i--) {
      entry = path[i];
      if (dist2D(path[i], to) > 10) break;
    }
    this.entryCache.set(key, entry);
    return entry;
  }

  private takeCover(p: SimPlayer, b: Brain, threat: SimPlayer): void {
    const sim = this.sim;
    const threatEye = sim.eyePos(threat);
    const here = sim.map.cellOf(p.body.pos);
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (!sim.map.walkable(here.x + dx, here.z + dz)) continue;
        const c = sim.map.cellCenter(here.x + dx, here.z + dz);
        const eye = { x: c.x, y: c.y + 1.5, z: c.z };
        if (sim.map.world.lineOfSight(eye, threatEye)) continue;
        const dd = dist2D(c, p.body.pos);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
    }
    if (best) {
      this.setGoal(p, b, best, 'cover');
      b.mode = 'cover';
    }
  }

  // ------------------------------------------------------------- movement

  private setGoal(p: SimPlayer, b: Brain, goal: Vec3, mode: Mode): void {
    const path = this.nav.findPath(p.body.pos, goal);
    b.mode = mode;
    b.goal = { ...goal };
    b.path = path ?? [];
    b.pathIdx = 0;
  }

  private followPath(p: SimPlayer, b: Brain): Vec3 | null {
    while (b.pathIdx < b.path.length && dist2D(p.body.pos, b.path[b.pathIdx]) < 0.55) b.pathIdx++;
    if (b.pathIdx >= b.path.length) {
      b.path = [];
      b.pathIdx = 0;
      if (b.mode === 'hold') b.holdUntil = Math.max(b.holdUntil, this.sim.time + 4);
      if (b.mode === 'cover') b.mode = 'hunt';
      return null;
    }
    const wp = b.path[b.pathIdx];
    return { x: wp.x - p.body.pos.x, y: 0, z: wp.z - p.body.pos.z };
  }

  private checkStuck(p: SimPlayer, b: Brain, cmd: PlayerCmd): void {
    const now = this.sim.time;
    if (now < b.stuckCheckAt) return;
    b.stuckCheckAt = now + 1;
    const moved = dist2D(p.body.pos, b.stuckPos);
    b.stuckPos = { ...p.body.pos };
    if (moved < 0.4 && (cmd.forward || cmd.side) && b.targetId === null) {
      b.stuckCount++;
      b.jumpUntil = now + 0.1;
      if (b.stuckCount >= 2) {
        b.stuckCount = 0;
        if (b.goal) this.setGoal(p, b, b.goal, b.mode);
        else b.path = [];
      }
    } else {
      b.stuckCount = 0;
    }
  }

  private randomCell(): Vec3 {
    const cells = this.nav.cellsIn();
    return cells[Math.floor(this.sim.random() * cells.length)];
  }

  private randomCellIn(r: { x0: number; z0: number; x1: number; z1: number }, pad: number): Vec3 {
    const cells = this.nav.cellsIn({ x0: r.x0 - pad, z0: r.z0 - pad, x1: r.x1 + pad, z1: r.z1 + pad });
    return cells.length ? cells[Math.floor(this.sim.random() * cells.length)] : this.sim.map.rectCenter(r);
  }

  // -------------------------------------------------------------- economy

  private buy(p: SimPlayer, b: Brain): void {
    if (b.boughtRound === this.sim.round || !this.sim.canBuy(p)) return;
    b.boughtRound = this.sim.round;
    const rifle: WeaponId = p.team === 'A' ? 'ar7' : 'k4';
    const r = this.sim.random();
    const has = p.weapons[1]?.id;
    const order: string[] = [];
    if (!has) {
      if (this.difficulty === 'hard' && p.money >= 4750 + 1000 && r < 0.2) order.push('helmet', 'longbow');
      else if (p.money >= WEAPONS[rifle].price + 1000) order.push('helmet', rifle);
      else if (p.money >= WEAPONS[rifle].price + 650) order.push('kevlar', rifle);
      else if (p.money >= 2200 && this.sim.round > 1) order.push('kevlar', r < 0.65 ? 'mk5' : 'pump12');
      else if (p.money >= 650 && this.sim.round > 1) order.push('kevlar');
    } else if (p.armor < 50 && p.money >= 650) {
      order.push(p.money >= 1000 ? 'helmet' : 'kevlar');
    }
    // Defenders who can spare it carry a kit (it halves the defuse time).
    if (p.team === 'D' && !p.kit && this.difficulty !== 'easy') order.push('defuser');
    for (const item of order) this.sim.buy(p, item as Parameters<Simulation['buy']>[1]);
  }

  /** Default team name list for bots. */
  static botName(team: Team, i: number): string {
    const names = team === 'A'
      ? ['Rook', 'Vex', 'Gravel', 'Dune', 'Sable', 'Cinder', 'Kestrel', 'Flint', 'Ash', 'Moth']
      : ['Warden', 'Bishop', 'Halo', 'Ridge', 'Atlas', 'Granite', 'Echo', 'Harbor', 'Quill', 'Talon'];
    return names[i % names.length];
  }

}
