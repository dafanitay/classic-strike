import type { WeaponId } from '../shared/weapons';

/**
 * Pre-rendered one-shot sounds for gunfire and bullet impacts.
 *
 * Everything is synthesised (no recorded or third-party audio, nothing to
 * license), but instead of being assembled live from a couple of filtered
 * noise bursts each shot, every sound is designed as layers the way real
 * weapon recordings are built, rendered once at start-up on an
 * OfflineAudioContext, and played back as a buffer:
 *
 *   crack   — the supersonic/muzzle transient: very short, very bright
 *   body    — the mid-range punch, saturated so it reads as "loud"
 *   thump   — the low-frequency blast, a fast falling sine
 *   mech    — the action cycling (slide, bolt, pump), slightly after
 *   tail    — the slap back off walls: the dry mix through a generated
 *             room impulse response
 *
 * Each weapon gets three slightly different variants so automatic fire
 * doesn't sound like one sample on repeat.
 */

export type GunSoundId = Exclude<WeaponId, 'knife'>;
export type ImpactKind = 'flesh' | 'head' | 'concrete' | 'wood' | 'ricochet';

export interface SoundBank {
  gun: Record<GunSoundId, AudioBuffer[]>;
  impact: Record<ImpactKind, AudioBuffer[]>;
}

interface GunRecipe {
  crack: { hp: number; dur: number; gain: number };
  body: { freq: number; q: number; dur: number; gain: number; drive: number };
  thump: { f0: number; f1: number; dur: number; gain: number };
  mech: { at: number; freq: number; q: number; dur: number; gain: number; second?: number };
  tail: { dur: number; gain: number; lp: number };
  length: number;
}

/** Per weapon: heavier guns get more body and thump and a longer tail. */
export const GUN_RECIPES = {
  p9: {
    crack: { hp: 2400, dur: 0.035, gain: 0.9 },
    body: { freq: 1100, q: 0.9, dur: 0.09, gain: 0.9, drive: 3 },
    thump: { f0: 180, f1: 60, dur: 0.09, gain: 0.7 },
    mech: { at: 0.03, freq: 4200, q: 6, dur: 0.03, gain: 0.25 },
    tail: { dur: 0.6, gain: 0.32, lp: 3500 },
    length: 0.75,
  },
  mk5: {
    crack: { hp: 2800, dur: 0.03, gain: 0.85 },
    body: { freq: 1300, q: 1, dur: 0.07, gain: 0.8, drive: 3 },
    thump: { f0: 160, f1: 70, dur: 0.07, gain: 0.55 },
    mech: { at: 0.025, freq: 3600, q: 5, dur: 0.025, gain: 0.22 },
    tail: { dur: 0.5, gain: 0.28, lp: 3200 },
    length: 0.6,
  },
  pump12: {
    crack: { hp: 1600, dur: 0.05, gain: 1 },
    body: { freq: 650, q: 0.7, dur: 0.2, gain: 1, drive: 4 },
    thump: { f0: 130, f1: 38, dur: 0.22, gain: 1 },
    mech: { at: 0.32, freq: 1900, q: 4, dur: 0.06, gain: 0.35, second: 0.45 },
    tail: { dur: 1.1, gain: 0.34, lp: 2600 },
    length: 1.3,
  },
  ar7: {
    crack: { hp: 2000, dur: 0.045, gain: 1 },
    body: { freq: 850, q: 0.8, dur: 0.12, gain: 1, drive: 4 },
    thump: { f0: 150, f1: 45, dur: 0.13, gain: 0.9 },
    mech: { at: 0.035, freq: 3000, q: 5, dur: 0.03, gain: 0.25 },
    tail: { dur: 0.8, gain: 0.38, lp: 3000 },
    length: 0.95,
  },
  k4: {
    crack: { hp: 2600, dur: 0.04, gain: 0.95 },
    body: { freq: 1000, q: 0.9, dur: 0.1, gain: 0.9, drive: 3.5 },
    thump: { f0: 165, f1: 52, dur: 0.11, gain: 0.8 },
    mech: { at: 0.03, freq: 3400, q: 5, dur: 0.028, gain: 0.24 },
    tail: { dur: 0.75, gain: 0.35, lp: 3300 },
    length: 0.9,
  },
  longbow: {
    crack: { hp: 1800, dur: 0.06, gain: 1 },
    body: { freq: 600, q: 0.7, dur: 0.22, gain: 1, drive: 5 },
    thump: { f0: 120, f1: 32, dur: 0.3, gain: 1.1 },
    mech: { at: 0.55, freq: 2200, q: 5, dur: 0.05, gain: 0.3, second: 0.75 },
    tail: { dur: 1.6, gain: 0.28, lp: 2400 },
    length: 1.9,
  },
} as Record<GunSoundId, GunRecipe>;

/**
 * A new gun's sound from a reference gun of its kind: `pitch` scales every
 * frequency (smaller calibre / shorter barrel = higher), `weight` scales the
 * low thump and body, `tail` the echo length.
 */
function variant(base: GunRecipe, pitch: number, weight: number, tail: number, mechAt?: number): GunRecipe {
  return {
    crack: { ...base.crack, hp: base.crack.hp * pitch },
    body: { ...base.body, freq: base.body.freq * pitch, gain: Math.min(1.1, base.body.gain * weight), drive: base.body.drive * Math.sqrt(weight) },
    thump: { ...base.thump, f0: base.thump.f0 * pitch, f1: base.thump.f1 * pitch, gain: Math.min(1.2, base.thump.gain * weight), dur: base.thump.dur * Math.sqrt(weight) },
    mech: { ...base.mech, freq: base.mech.freq * pitch, at: mechAt ?? base.mech.at },
    tail: { ...base.tail, dur: base.tail.dur * tail },
    length: base.length * Math.max(1, tail),
  };
}

const R = GUN_RECIPES as Partial<Record<GunSoundId, GunRecipe>>;
Object.assign(GUN_RECIPES, {
  m45: variant(R.p9!, 0.85, 1.15, 1.05),
  k57: variant(R.p9!, 1.12, 0.9, 1),
  hc50: variant(R.p9!, 0.7, 1.6, 1.4),
  tp9: variant(R.mk5!, 1.15, 0.8, 0.9),
  r10: variant(R.mk5!, 0.9, 1.05, 0.95),
  u45: variant(R.mk5!, 0.85, 1.15, 1),
  p50: variant(R.mk5!, 1.1, 0.9, 1),
  auto12: variant(R.pump12!, 1.05, 0.9, 0.9, 0.12),
  gr3: variant(R.ar7!, 1.08, 0.92, 0.95),
  fm2: variant(R.k4!, 1.06, 0.9, 0.95),
  sg5: variant(R.ar7!, 1.02, 0.97, 1.05),
  au3: variant(R.k4!, 0.98, 1, 1.05),
  kestrel: variant(R.longbow!, 1.2, 0.75, 0.8, 0.45),
  rp3: variant(R.longbow!, 1.1, 0.85, 0.9, 0.12),
  vg5: variant(R.longbow!, 1.12, 0.8, 0.9, 0.12),
  mg9: variant(R.ar7!, 0.92, 1.12, 1.15),
});

const VARIANTS = 3;

type Make = (seconds: number, sampleRate: number) => OfflineAudioContext;
/** The offline renderer (older Safari only has the prefixed one). */
export function offlineContextClass(): typeof OfflineAudioContext | undefined {
  const w = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
}
const defaultMake: Make = (seconds, sr) => new (offlineContextClass()!)(1, Math.ceil(seconds * sr), sr);

/** Small seeded generator so variants differ but the bank is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, r: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

/** A small room/yard: noise with an exponential decay, darker as it fades. */
function impulse(ctx: BaseAudioContext, seconds: number, lp: number, r: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / ctx.sampleRate;
    const decay = Math.exp((-t * 6.9) / seconds); // -60 dB at the end
    // One-pole low-pass whose cut-off falls over time (air absorbs highs).
    const fc = lp * (1 - 0.7 * (t / seconds));
    const a = Math.exp((-2 * Math.PI * fc) / ctx.sampleRate);
    y = (1 - a) * (r() * 2 - 1) + a * y;
    // Sparse early reflections in the first 60 ms.
    const early = t < 0.06 && r() < 0.004 ? (r() < 0.5 ? -1 : 1) * 0.6 : 0;
    d[i] = (y * 2.2 + early) * decay;
  }
  return b;
}

function envelope(g: GainNode, t: number, peak: number, attack: number, dur: number): void {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0005, t + attack + dur);
}

function shaper(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

function noiseLayer(ctx: BaseAudioContext, noise: AudioBuffer, dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, dur: number, endFreq?: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + attack + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  envelope(g, t, peak, attack, dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t, 0, attack + dur + 0.02);
}

function sineLayer(ctx: BaseAudioContext, dest: AudioNode, t: number, f0: number, f1: number, peak: number, dur: number, type: OscillatorType = 'sine'): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  envelope(g, t, peak, 0.002, dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Scales a rendered buffer so its loudest sample sits at `peak`. */
export function normalize(buf: AudioBuffer, peak = 0.9): AudioBuffer {
  const d = buf.getChannelData(0);
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return buf;
}

async function renderGun(rec: GunRecipe, seed: number, sr: number, make: Make): Promise<AudioBuffer> {
  const ctx = make(rec.length, sr);
  const r = rng(seed);
  const v = () => 0.94 + r() * 0.12; // ±6 % per variant
  const noise = noiseBuffer(ctx, rec.length, r);
  const dry = ctx.createGain();
  dry.connect(ctx.destination);
  const verb = ctx.createConvolver();
  verb.normalize = true;
  verb.buffer = impulse(ctx, rec.tail.dur, rec.tail.lp, r);
  const wet = ctx.createGain();
  wet.gain.value = rec.tail.gain;
  dry.connect(verb).connect(wet).connect(ctx.destination);

  const t = 0.001;
  const { crack, body, thump, mech } = rec;
  noiseLayer(ctx, noise, dry, t, 'highpass', crack.hp * v(), 0.7, crack.gain, 0.0005, crack.dur);
  const sat = shaper(ctx, body.drive);
  sat.connect(dry);
  noiseLayer(ctx, noise, sat, t, 'bandpass', body.freq * v(), body.q, body.gain, 0.0015, body.dur, body.freq * 0.45);
  sineLayer(ctx, sat, t, thump.f0 * v(), thump.f1, thump.gain, thump.dur);
  noiseLayer(ctx, noise, dry, t + mech.at, 'bandpass', mech.freq * v(), mech.q, mech.gain, 0.001, mech.dur);
  if (mech.second) noiseLayer(ctx, noise, dry, t + mech.second, 'bandpass', mech.freq * 1.3 * v(), mech.q, mech.gain, 0.001, mech.dur);
  return normalize(await ctx.startRendering());
}

async function renderImpact(kind: ImpactKind, seed: number, sr: number, make: Make): Promise<AudioBuffer> {
  const len = kind === 'ricochet' ? 0.6 : kind === 'head' ? 0.5 : 0.3;
  const ctx = make(len, sr);
  const r = rng(seed);
  const v = () => 0.92 + r() * 0.16;
  const noise = noiseBuffer(ctx, len, r);
  const out = ctx.destination;
  const t = 0.001;
  switch (kind) {
    case 'flesh':
      // Dull, heavy "thwack": a low thud with a short wet slap on top.
      sineLayer(ctx, out, t, 170 * v(), 55, 1, 0.08);
      noiseLayer(ctx, noise, out, t, 'lowpass', 1100 * v(), 0.9, 0.9, 0.001, 0.07, 300);
      noiseLayer(ctx, noise, out, t, 'bandpass', 2000 * v(), 1.2, 0.35, 0.0005, 0.018);
      break;
    case 'head': {
      // Helmet ping: a few inharmonic metal partials ringing out, plus the thud.
      const partials = [2350, 3720, 5230, 7150];
      partials.forEach((f, i) => sineLayer(ctx, out, t, f * v(), f * 0.985, 0.45 / (i + 1) ** 0.5, 0.35 - i * 0.06));
      noiseLayer(ctx, noise, out, t, 'highpass', 5000, 0.7, 0.5, 0.0003, 0.01);
      sineLayer(ctx, out, t, 160 * v(), 60, 0.6, 0.07);
      break;
    }
    case 'concrete':
      // Sharp chip, then grit falling.
      noiseLayer(ctx, noise, out, t, 'bandpass', 2600 * v(), 1, 1, 0.0004, 0.035, 1400);
      sineLayer(ctx, out, t, 140 * v(), 70, 0.35, 0.04);
      for (let i = 0; i < 9; i++) {
        noiseLayer(ctx, noise, out, t + 0.015 + r() * 0.18, 'bandpass', 3500 + r() * 3500, 3, 0.12 + r() * 0.12, 0.0003, 0.008);
      }
      break;
    case 'wood':
      // Hollow knock and a splinter crackle.
      noiseLayer(ctx, noise, out, t, 'bandpass', 700 * v(), 5, 1.2, 0.0005, 0.06);
      noiseLayer(ctx, noise, out, t, 'bandpass', 1150 * v(), 6, 0.7, 0.0005, 0.045);
      noiseLayer(ctx, noise, out, t + 0.004, 'highpass', 3000, 0.7, 0.35, 0.0005, 0.03);
      break;
    case 'ricochet': {
      // The whine of a deflected bullet: a falling tone with a wobble.
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = 3300 * v();
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.45);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 26 + r() * 10;
      const depth = ctx.createGain();
      depth.gain.value = 90;
      lfo.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      envelope(g, t + 0.01, 0.5, 0.01, 0.45);
      o.connect(g).connect(out);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.5);
      lfo.stop(t + 0.5);
      noiseLayer(ctx, noise, out, t, 'bandpass', 3000, 1.2, 0.6, 0.0004, 0.02);
      break;
    }
  }
  return normalize(await ctx.startRendering(), kind === 'ricochet' ? 0.55 : 0.9);
}

/**
 * Renders the whole bank (about 0.1–0.3 s of CPU on a desktop, once).
 * `make` is injectable for tests.
 */
export async function buildSoundBank(sampleRate = 44100, make: Make = defaultMake): Promise<SoundBank> {
  const guns = Object.keys(GUN_RECIPES) as GunSoundId[];
  const gun = {} as Record<GunSoundId, AudioBuffer[]>;
  let seed = 1;
  for (const id of guns) {
    gun[id] = [];
    for (let k = 0; k < VARIANTS; k++) gun[id].push(await renderGun(GUN_RECIPES[id], seed++ * 7919, sampleRate, make));
  }
  const kinds: ImpactKind[] = ['flesh', 'head', 'concrete', 'wood', 'ricochet'];
  const impact = {} as Record<ImpactKind, AudioBuffer[]>;
  for (const k of kinds) {
    impact[k] = [];
    for (let i = 0; i < VARIANTS; i++) impact[k].push(await renderImpact(k, seed++ * 104729, sampleRate, make));
  }
  return { gun, impact };
}
