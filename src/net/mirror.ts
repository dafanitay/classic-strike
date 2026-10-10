import { stepMovement } from '../shared/movement';
import { applyPlayer, decodeBomb, type PlayerSnap, type Snapshot } from '../shared/protocol';
import { TICK_DT, type PlayerCmd, type SimPlayer, type Simulation } from '../shared/sim';
import { angleDiff, lerp, type Vec3 } from '../shared/vec';

/**
 * Client-side view of a server-run match.
 *
 *  - The local player is *predicted*: inputs are applied immediately with
 *    the same movement code the server runs, then corrected when a
 *    snapshot acknowledges them (server state + replay of unacknowledged
 *    inputs).
 *  - Everyone else is *interpolated* between snapshots, rendered a little
 *    in the past so motion is smooth despite 20 Hz updates and jitter.
 *
 * Kept free of DOM and rendering so it can be unit tested.
 */

export const INTERP_DELAY = 0.1;

interface Sample {
  t: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
  crouched: boolean;
}

export class NetMirror {
  readonly sim: Simulation;
  readonly meId: number;
  private readonly pending: { seq: number; cmd: PlayerCmd }[] = [];
  private seq = 0;
  private readonly samples = new Map<number, Sample[]>();
  /** serverTime ≈ performance.now()/1000 + offset */
  private offset: number | null = null;
  /** Visual smoothing of prediction corrections. */
  readonly correction = { x: 0, y: 0, z: 0 };
  lastAck = 0;
  /** The server's view yaw for us (used when it respawns us). */
  serverYaw = 0;

  constructor(sim: Simulation, meId: number) {
    this.sim = sim;
    this.meId = meId;
  }

  get me(): SimPlayer | undefined {
    return this.sim.getPlayer(this.meId);
  }

  /** Records and predicts one local input. Returns the seq to send. */
  predict(cmd: PlayerCmd): number {
    const seq = ++this.seq;
    this.pending.push({ seq, cmd });
    if (this.pending.length > 120) this.pending.shift();
    const me = this.me;
    if (me && me.alive) this.applyMove(me, cmd);
    return seq;
  }

  private applyMove(me: SimPlayer, cmd: PlayerCmd): void {
    me.yaw = cmd.yaw;
    me.pitch = cmd.pitch;
    // Same input rules as the server (freeze time, standing still while
    // planting / defusing), so prediction stays exact.
    stepMovement(this.sim.map.world, me.body, this.sim.movementInput(me, cmd), this.sim.maxSpeedOf(me), TICK_DT);
  }

  /** Applies an authoritative snapshot. Returns ids that appeared/disappeared. */
  applySnapshot(s: Snapshot, nowSec: number): { added: number[]; removed: number[] } {
    const sim = this.sim;
    const sample = s.time - nowSec;
    if (this.offset === null || Math.abs(sample - this.offset) > 0.5) this.offset = sample;
    else this.offset = this.offset * 0.9 + sample * 0.1;

    sim.time = s.time;
    sim.phase = s.phase;
    sim.phaseEnd = s.phaseEnd < 0 ? Infinity : s.phaseEnd;
    sim.round = s.round;
    sim.roundStartTime = s.roundStart;
    sim.score = { ...s.score };
    sim.bomb = decodeBomb(s.bomb);

    const added: number[] = [];
    const removed: number[] = [];
    const seen = new Set<number>();
    for (const ps of s.players) {
      seen.add(ps.id);
      let p = sim.getPlayer(ps.id);
      if (!p) {
        p = sim.addPlayer(ps.n, ps.tm, !!ps.b, ps.id);
        added.push(ps.id);
      }
      if (ps.id === this.meId) this.reconcile(p, ps, s.ack);
      else {
        applyPlayer(p, ps, true);
        this.pushSample(ps, s.time);
      }
    }
    for (const p of [...sim.players]) {
      if (!seen.has(p.id) && p.id !== this.meId) {
        sim.removePlayer(p.id);
        this.samples.delete(p.id);
        removed.push(p.id);
      }
    }
    return { added, removed };
  }

  private reconcile(me: SimPlayer, ps: PlayerSnap, ack: number): void {
    const before = { ...me.body.pos };
    const yaw = me.yaw;
    const pitch = me.pitch;
    applyPlayer(me, ps, true);
    this.serverYaw = ps.yw;
    // Keep the local view angles: they are always ahead of the server's.
    me.yaw = yaw;
    me.pitch = pitch;
    this.lastAck = ack;
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    if (me.alive) for (const p of this.pending) this.applyMove(me, p.cmd);
    const dx = before.x - me.body.pos.x;
    const dy = before.y - me.body.pos.y;
    const dz = before.z - me.body.pos.z;
    const err = Math.hypot(dx, dy, dz);
    if (err < 1.5) {
      // Small error: blend it out visually instead of snapping.
      this.correction.x += dx;
      this.correction.y += dy;
      this.correction.z += dz;
    } else {
      this.correction.x = this.correction.y = this.correction.z = 0;
    }
  }

  decayCorrection(dt: number): void {
    const k = Math.exp(-dt * 15);
    this.correction.x *= k;
    this.correction.y *= k;
    this.correction.z *= k;
  }

  private pushSample(ps: PlayerSnap, t: number): void {
    let list = this.samples.get(ps.id);
    if (!list) this.samples.set(ps.id, (list = []));
    const s: Sample = { t, pos: { x: ps.p[0], y: ps.p[1], z: ps.p[2] }, yaw: ps.yw, pitch: ps.pt, crouched: !!ps.c };
    // A teleport (respawn) must not be interpolated across.
    const last = list[list.length - 1];
    if (last && Math.hypot(last.pos.x - s.pos.x, last.pos.z - s.pos.z) > 4) list.length = 0;
    list.push(s);
    while (list.length > 30) list.shift();
  }

  /** Moves remote players to their interpolated positions for rendering. */
  interpolate(nowSec: number): void {
    if (this.offset === null) return;
    const t = nowSec + this.offset - INTERP_DELAY;
    for (const p of this.sim.players) {
      if (p.id === this.meId) continue;
      const list = this.samples.get(p.id);
      if (!list || !list.length) continue;
      let a = list[0];
      let b = list[list.length - 1];
      for (let i = 0; i < list.length - 1; i++) {
        if (list[i].t <= t && list[i + 1].t >= t) {
          a = list[i];
          b = list[i + 1];
          break;
        }
      }
      if (t <= list[0].t) b = a;
      if (t >= b.t) a = b; // no extrapolation past the newest sample
      const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
      p.body.pos = { x: lerp(a.pos.x, b.pos.x, k), y: lerp(a.pos.y, b.pos.y, k), z: lerp(a.pos.z, b.pos.z, k) };
      p.yaw = a.yaw + angleDiff(b.yaw, a.yaw) * k;
      p.pitch = lerp(a.pitch, b.pitch, k);
      p.body.crouched = k < 0.5 ? a.crouched : b.crouched;
    }
  }

  /** Estimated current server time. */
  serverTime(nowSec: number): number {
    return this.offset === null ? this.sim.time : nowSec + this.offset;
  }
}

