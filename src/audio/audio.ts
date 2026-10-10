import type { WeaponClass, WeaponId } from '../shared/weapons';
import type { Vec3 } from '../shared/vec';
import { buildSoundBank, offlineContextClass, type GunSoundId, type SoundBank } from './soundBank';
import { PROFILES, admit, attenuation, listenerAxes, type SoundKind } from './spatial';

/**
 * Every sound is synthesised at runtime with the Web Audio API (filtered
 * noise + oscillators), so there are no third-party audio assets and
 * nothing to license. The AudioContext is only created after a user
 * gesture, per browser autoplay rules.
 *
 * Positional sounds (other players' steps, shots, reloads, the bomb, ...)
 * go through an HRTF panner, so with headphones they come from the right
 * direction all around you, front and back included; the listener follows
 * the camera every frame. Loudness by distance is applied by us per kind
 * of sound (spatial.ts) rather than by the panner, a wall between you and
 * the source muffles it (quieter + low-passed, never silenced), finished
 * sounds are disconnected, and the number of simultaneous sounds is capped.
 */
export class GameAudio {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private noise!: AudioBuffer;
  private masterVol = 0.7;
  private sfxVol = 0.8;
  private hrtf = true;
  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly voices: { nodes: AudioNode[]; end: number }[] = [];
  /** Pre-rendered gunshots and impacts (soundBank.ts); null until rendered. */
  private bank: SoundBank | null = null;
  private bankLoading: Promise<void> | null = null;
  /** Why the sound bank isn't in use, if it failed (shown in Settings). */
  bankError = '';
  /** Returns true when something solid is between the two points (set by the session). */
  occluder: ((from: Vec3, to: Vec3) => boolean) | null = null;

  /** For tests: drive the same graph on an OfflineAudioContext. */
  static offline(ctx: BaseAudioContext): GameAudio {
    const a = new GameAudio();
    a.init(ctx);
    return a;
  }

  /** Call from a click/keydown handler. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      try {
        const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const AC = w.AudioContext ?? w.webkitAudioContext;
        if (!AC) return;
        this.init(new AC());
      } catch {
        return; // no audio support: game stays silent
      }
    }
    const live = this.ctx as AudioContext;
    if (live.state === 'suspended' && typeof live.resume === 'function') void live.resume();
    void this.loadBank();
  }

  /**
   * Renders the weapon and impact sounds once (in the background); until
   * they are ready, the simpler live-synthesised versions play instead.
   */
  loadBank(): Promise<void> {
    if (!this.ctx || !offlineContextClass()) return Promise.resolve();
    this.bankLoading ??= buildSoundBank(this.ctx.sampleRate)
      .then((b) => {
        this.bank = b;
      })
      .catch((e: unknown) => {
        // Keep the simpler synthesised sounds, but say why (Settings, console).
        this.bankError = e instanceof Error ? e.message : String(e);
        console.warn('Weapon sound bank unavailable, using basic sounds:', e);
      });
    return this.bankLoading;
  }

  /** A line for the Settings screen: which weapon sounds are playing. */
  get bankStatus(): string {
    if (this.bank) return 'Weapon sounds: enhanced (loaded).';
    if (this.bankError) return `Weapon sounds: basic — the enhanced set failed to load (${this.bankError}).`;
    if (!offlineContextClass()) return 'Weapon sounds: basic — this browser cannot render the enhanced set.';
    return this.bankLoading ? 'Weapon sounds: enhanced set loading…' : 'Weapon sounds: enhanced set loads on your first click.';
  }

  /** True once the pre-rendered sounds are in use (for tests). */
  get bankReady(): boolean {
    return this.bank !== null;
  }

  /** Plays one buffer (a random variant), optionally through a low-pass. */
  private playBuffer(variants: AudioBuffer[], dest: AudioNode, t: number, gain: number, lowpass = 0, rate = 0.97 + Math.random() * 0.06): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = variants[Math.floor(Math.random() * variants.length)];
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = src;
    if (lowpass > 0) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    node.connect(g).connect(dest);
    src.start(t);
  }

  private init(ctx: BaseAudioContext): void {
    {
      this.ctx = ctx;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.sfx.connect(this.master);
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.setVolumes(this.masterVol, this.sfxVol);
    }
  }

  /** Headphone 3D audio (HRTF). Off = plain left/right panning. */
  setHrtf(on: boolean): void {
    this.hrtf = on;
  }

  /** Positional sounds currently connected (for tests / diagnostics). */
  get activeVoices(): number {
    return this.voices.length;
  }

  setVolumes(master: number, sfx: number): void {
    this.masterVol = master;
    this.sfxVol = sfx;
    if (!this.ctx) return;
    this.master.gain.value = master;
    this.sfx.gain.value = sfx;
  }

  /** Update the listener from the camera each frame (also frees finished sounds). */
  setListener(pos: Vec3, yaw: number): void {
    if (!this.ctx) return;
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    this.sweep();
    const l = this.ctx.listener;
    const { forward } = listenerAxes(yaw);
    const fx = forward.x;
    const fz = forward.z;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  /**
   * Output node for one sound: straight to the mix for your own sounds (no
   * `pos`), otherwise panner -> distance gain -> (wall low-pass) -> mix.
   * Returns null when the sound is out of earshot or too many are playing.
   * `dur` is how long the sound lasts (s), after which its nodes are freed.
   */
  private out(pos: Vec3 | undefined, kind: SoundKind, dur: number): AudioNode | null {
    const ctx = this.ctx!;
    if (!pos) return this.sfx;
    const prof = PROFILES[kind];
    const d = Math.hypot(pos.x - this.listenerPos.x, pos.y - this.listenerPos.y, pos.z - this.listenerPos.z);
    let gain = attenuation(prof, d);
    if (gain < 0.002 || !admit(kind, this.voices.length)) return null;
    const occluded = d > 1.5 && !!this.occluder?.(this.listenerPos, pos);
    if (occluded) gain *= prof.occludedGain;
    const p = ctx.createPanner();
    p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0; // loudness by distance is ours (above), the panner only places it
    p.refDistance = 1;
    p.maxDistance = 10000;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    const g = ctx.createGain();
    g.gain.value = gain;
    p.connect(g);
    const nodes: AudioNode[] = [p, g];
    if (occluded) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = prof.occludedCutoff;
      g.connect(lp).connect(this.sfx);
      nodes.push(lp);
    } else {
      g.connect(this.sfx);
    }
    this.voices.push({ nodes, end: ctx.currentTime + dur + 0.25 });
    return p;
  }

  /** Disconnects the nodes of sounds that have finished. */
  private sweep(): void {
    const now = this.ctx!.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].end > now) continue;
      for (const n of this.voices[i].nodes) n.disconnect();
      this.voices.splice(i, 1);
    }
  }

  /** Test hook: free finished sounds now. */
  flushFinished(): void {
    if (this.ctx) this.sweep();
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.8, endFreq?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, dur: number, gain: number, type: OscillatorType, f0: number, f1: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  gunshot(cls: WeaponClass, id: WeaponId, pos?: Vec3, distance = 0): void {
    if (!this.ctx || cls === 'melee') return;
    const t = this.ctx.currentTime;
    const bank = this.bank?.gun[id as GunSoundId];
    const dest = this.out(pos, 'gunshot', bank ? bank[0].duration : cls === 'sniper' || cls === 'shotgun' ? 0.9 : 0.4);
    if (!dest) return;
    // Distant shots lose their crack (high end) and keep the boom.
    const far = Math.min(1, distance / 50);
    if (bank) {
      // Air takes the top end off with distance; far away, the slap back
      // off the buildings arrives as a separate, duller echo.
      const cutoff = far > 0 ? 18000 * (1 - far) ** 2 + 900 : 0;
      this.playBuffer(bank, dest, t, pos ? 1 : 0.85, cutoff);
      if (far > 0.35) this.playBuffer(bank, dest, t + 0.1 + far * 0.25, 0.3 * far, 900);
      return;
    }
    const crack = 1 - far * 0.85;
    const P: Record<Exclude<WeaponClass, 'melee'>, [number, number, number, number, number]> = {
      // [crack freq, crack dur, boom freq, boom dur, gain]
      pistol: [2600, 0.11, 140, 0.12, 0.9],
      smg: [2200, 0.09, 120, 0.1, 0.75],
      rifle: [1800, 0.16, 95, 0.18, 1.0],
      shotgun: [1200, 0.25, 70, 0.3, 1.2],
      sniper: [1400, 0.4, 55, 0.5, 1.4],
      mg: [1700, 0.15, 85, 0.17, 1.05],
    };
    const [cf, cd, bf, bd, gain] = P[cls];
    const v = id === 'k4' ? 0.85 : 1;
    this.noiseBurst(dest, t, cd, gain * crack * v, 'bandpass', cf * (0.9 + Math.random() * 0.2), 0.6, cf * 0.3);
    this.noiseBurst(dest, t, bd * 1.6, gain * 0.9, 'lowpass', 900 - far * 500, 0.5, 120);
    this.tone(dest, t, bd, gain * 0.8, 'sine', bf * 2.2, bf);
    if (cls === 'sniper' || cls === 'shotgun') {
      // Echo tail off the walls.
      this.noiseBurst(dest, t + 0.12, 0.5, gain * 0.25, 'lowpass', 500, 0.5, 100);
    }
  }

  footstep(pos?: Vec3, surface: 'sand' | 'hard' = 'hard'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'footstep', 0.12);
    if (!dest) return;
    if (surface === 'sand') this.noiseBurst(dest, t, 0.09, 0.35, 'lowpass', 900, 0.7, 300);
    else {
      this.noiseBurst(dest, t, 0.05, 0.35, 'bandpass', 1300 + Math.random() * 400, 1.2, 600);
      this.tone(dest, t, 0.05, 0.15, 'sine', 160, 90);
    }
    // A short high scuff on top: real footsteps have it, and it's what lets
    // the ears (and the HRTF) place a step left/right and front/back.
    this.noiseBurst(dest, t + 0.004, 0.025, surface === 'sand' ? 0.12 : 0.16, 'bandpass', 3600 + Math.random() * 1200, 1.4);
  }

  land(pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'land', 0.15);
    if (!dest) return;
    this.noiseBurst(dest, t, 0.12, 0.5, 'lowpass', 700, 0.7, 150);
  }

  reload(duration: number, pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'reload', duration + 0.1);
    if (!dest) return;
    const click = (at: number, f: number, g = 0.35) => {
      this.noiseBurst(dest, t + at, 0.04, g, 'bandpass', f, 3);
      this.tone(dest, t + at, 0.03, g * 0.4, 'square', f * 0.5, f * 0.4);
    };
    click(0.15, 1800); // mag out
    click(duration * 0.55, 1400, 0.45); // mag in
    click(Math.max(0.3, duration - 0.25), 2400, 0.4); // bolt
  }

  dryFire(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.sfx, this.ctx.currentTime, 0.03, 0.3, 'bandpass', 3000, 4);
  }

  draw(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, 0.05, 0.2, 'bandpass', 2200, 3);
    this.noiseBurst(this.sfx, t + 0.12, 0.04, 0.2, 'bandpass', 2800, 3);
  }

  knife(hit: boolean, pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'knife', 0.3);
    if (!dest) return;
    this.noiseBurst(dest, t, 0.18, 0.3, 'bandpass', 1200, 1.5, 4000);
    if (hit) this.noiseBurst(dest, t + 0.06, 0.08, 0.5, 'lowpass', 600, 1, 200);
  }

  /** A bullet hitting the world: positional, at the impact point. */
  impact(surface: 'concrete' | 'wood', pos: Vec3): void {
    if (!this.ctx || !this.bank) return;
    const t = this.ctx.currentTime;
    const ricochet = surface === 'concrete' && Math.random() < 0.12;
    const dest = this.out(pos, 'impact', ricochet ? 0.6 : 0.3);
    if (!dest) return;
    this.playBuffer(this.bank.impact[surface], dest, t, 0.8);
    if (ricochet) this.playBuffer(this.bank.impact.ricochet, dest, t + 0.01, 0.6);
  }

  /** A bullet hitting a player, heard by everyone nearby (not the shooter or victim). */
  bodyHit(headshot: boolean, pos: Vec3): void {
    if (!this.ctx || !this.bank) return;
    const dest = this.out(pos, 'impact', 0.5);
    if (!dest) return;
    this.playBuffer(this.bank.impact[headshot ? 'head' : 'flesh'], dest, this.ctx.currentTime, 0.9);
  }

  /** Feedback when *you* hit someone (also played for a headshot "tink"). */
  hitConfirm(headshot: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.bank) {
      this.playBuffer(this.bank.impact[headshot ? 'head' : 'flesh'], this.sfx, t, headshot ? 0.5 : 0.55, 0, 1);
      return;
    }
    if (headshot) this.tone(this.sfx, t, 0.12, 0.25, 'triangle', 2600, 1800);
    else this.noiseBurst(this.sfx, t, 0.06, 0.25, 'lowpass', 500, 1, 200);
  }

  hurt(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.bank) this.playBuffer(this.bank.impact.flesh, this.sfx, t, 0.6, 2500, 0.85);
    this.noiseBurst(this.sfx, t, 0.12, 0.6, 'lowpass', 400, 1, 120);
    this.tone(this.sfx, t, 0.15, 0.25, 'sine', 120, 70);
  }

  death(pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'death', 0.55);
    if (!dest) return;
    this.tone(dest, t, 0.35, 0.25, 'sawtooth', 220, 90);
    this.noiseBurst(dest, t + 0.3, 0.2, 0.5, 'lowpass', 300, 1, 80);
  }

  ui(kind: 'click' | 'buy' | 'deny'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'click') this.tone(this.sfx, t, 0.05, 0.12, 'square', 900, 900);
    else if (kind === 'buy') {
      this.noiseBurst(this.sfx, t, 0.05, 0.25, 'bandpass', 2600, 3);
      this.tone(this.sfx, t + 0.04, 0.12, 0.12, 'triangle', 1300, 1300);
    } else this.tone(this.sfx, t, 0.15, 0.15, 'square', 220, 180);
  }

  /** The planted bomb's beep (positional; it speeds up as the fuse runs out). */
  bombBeep(pos: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'bomb', 0.12);
    if (!dest) return;
    this.tone(dest, t, 0.09, 0.35, 'square', 1950, 1950);
  }

  /** Keypad presses while planting, or the clip being worked while defusing. */
  bombAction(kind: 'plant' | 'defuse', pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'action', kind === 'plant' ? 2.2 : 0.4);
    if (!dest) return;
    if (kind === 'plant') {
      [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1].forEach((at, i) => this.tone(dest, t + at, 0.07, 0.16, 'square', 1100 + (i % 3) * 180, 1100 + (i % 3) * 180));
    } else {
      this.noiseBurst(dest, t, 0.25, 0.3, 'bandpass', 2400, 2, 1200);
      this.noiseBurst(dest, t + 0.3, 0.06, 0.35, 'bandpass', 3200, 4);
    }
  }

  explosion(pos: Vec3, distance: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos, 'explosion', 2.8);
    if (!dest) return;
    const near = 1 - Math.min(1, distance / 80);
    this.noiseBurst(dest, t, 1.8, 1.6, 'lowpass', 1200 * (0.4 + near), 0.6, 60);
    this.tone(dest, t, 1.2, 1.2, 'sine', 90, 28);
    this.noiseBurst(dest, t + 0.25, 2.5, 0.5, 'lowpass', 400, 0.5, 50); // rumble / echo
  }

  /** Radio-style announcement chirp. */
  radio(kind: 'start' | 'win' | 'lose' | 'go' | 'planted' | 'defused'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, 0.08, 0.15, 'bandpass', 2000, 2);
    const seq: Record<typeof kind, number[]> = {
      start: [660, 880],
      go: [880, 880, 1320],
      win: [523, 659, 784, 1047],
      lose: [392, 330, 262],
      planted: [988, 740, 988, 740],
      defused: [659, 988, 1319],
    };
    seq[kind].forEach((f, i) => this.tone(this.sfx, t + 0.1 + i * 0.13, 0.16, 0.18, 'square', f, f));
  }
}
