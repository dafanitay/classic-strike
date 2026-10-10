import type { WeaponClass, WeaponId } from '../shared/weapons';
import type { Vec3 } from '../shared/vec';

/**
 * Every sound is synthesised at runtime with the Web Audio API (filtered
 * noise + oscillators), so there are no third-party audio assets and
 * nothing to license. The AudioContext is only created after a user
 * gesture, per browser autoplay rules.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private noise!: AudioBuffer;
  private masterVol = 0.7;
  private sfxVol = 0.8;

  /** Call from a click/keydown handler. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return; // no audio support: game stays silent
      }
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
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(master: number, sfx: number): void {
    this.masterVol = master;
    this.sfxVol = sfx;
    if (!this.ctx) return;
    this.master.gain.value = master;
    this.sfx.gain.value = sfx;
  }

  /** Update the listener from the camera each frame. */
  setListener(pos: Vec3, yaw: number): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
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

  /** Output node: positional when `pos` is given, otherwise straight to the mix. */
  private out(pos?: Vec3): AudioNode {
    const ctx = this.ctx!;
    if (!pos) return this.sfx;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 2.5;
    p.rolloffFactor = 1.1;
    p.maxDistance = 200;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.sfx);
    return p;
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
    const dest = this.out(pos);
    // Distant shots lose their crack (high end) and keep the boom.
    const far = Math.min(1, distance / 50);
    const crack = 1 - far * 0.85;
    const P: Record<Exclude<WeaponClass, 'melee'>, [number, number, number, number, number]> = {
      // [crack freq, crack dur, boom freq, boom dur, gain]
      pistol: [2600, 0.11, 140, 0.12, 0.9],
      smg: [2200, 0.09, 120, 0.1, 0.75],
      rifle: [1800, 0.16, 95, 0.18, 1.0],
      shotgun: [1200, 0.25, 70, 0.3, 1.2],
      sniper: [1400, 0.4, 55, 0.5, 1.4],
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
    const dest = this.out(pos);
    if (surface === 'sand') this.noiseBurst(dest, t, 0.09, 0.35, 'lowpass', 900, 0.7, 300);
    else {
      this.noiseBurst(dest, t, 0.05, 0.35, 'bandpass', 1300 + Math.random() * 400, 1.2, 600);
      this.tone(dest, t, 0.05, 0.15, 'sine', 160, 90);
    }
  }

  land(pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos);
    this.noiseBurst(dest, t, 0.12, 0.5, 'lowpass', 700, 0.7, 150);
  }

  reload(duration: number, pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos);
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
    const dest = this.out(pos);
    this.noiseBurst(dest, t, 0.18, 0.3, 'bandpass', 1200, 1.5, 4000);
    if (hit) this.noiseBurst(dest, t + 0.06, 0.08, 0.5, 'lowpass', 600, 1, 200);
  }

  /** Feedback when *you* hit someone (also played for a headshot "tink"). */
  hitConfirm(headshot: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (headshot) this.tone(this.sfx, t, 0.12, 0.25, 'triangle', 2600, 1800);
    else this.noiseBurst(this.sfx, t, 0.06, 0.25, 'lowpass', 500, 1, 200);
  }

  hurt(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, 0.12, 0.6, 'lowpass', 400, 1, 120);
    this.tone(this.sfx, t, 0.15, 0.25, 'sine', 120, 70);
  }

  death(pos?: Vec3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.out(pos);
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

  /** Radio-style announcement chirp. */
  radio(kind: 'start' | 'win' | 'lose' | 'go'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, 0.08, 0.15, 'bandpass', 2000, 2);
    const seq: Record<typeof kind, number[]> = {
      start: [660, 880],
      go: [880, 880, 1320],
      win: [523, 659, 784, 1047],
      lose: [392, 330, 262],
    };
    seq[kind].forEach((f, i) => this.tone(this.sfx, t + 0.1 + i * 0.13, 0.16, 0.18, 'square', f, f));
  }
}
