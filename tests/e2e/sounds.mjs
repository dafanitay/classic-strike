// Browser checks for the pre-rendered weapon and impact sounds
// (src/audio/soundBank.ts): the bank renders, every sound has a sharp
// attack, heavier guns carry more low end, headshots ring brighter than
// body hits, variants differ, and distance dulls a shot. Optionally writes
// every sound as a WAV so a person can listen to them.
// Run against `npm run dev`:
//   node tests/e2e/sounds.mjs http://127.0.0.1:5180 [wavDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const wavDir = process.argv[3];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/?debug=1');
await page.waitForFunction(() => !!window.__buildSoundBank);

const r = await page.evaluate(async (wantWav) => {
  const t0 = performance.now();
  const bank = await window.__buildSoundBank(44100);
  const ms = performance.now() - t0;
  const stats = (buf) => {
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    let peak = 0;
    let at = 0;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) (peak = Math.abs(d[i])), (at = i);
    // Low share: energy of a ~250 Hz one-pole low-pass; high share: first difference.
    let lp = 0;
    let low = 0;
    let hi = 0;
    let all = 0;
    const a = Math.exp((-2 * Math.PI * 250) / sr);
    for (let i = 0; i < d.length; i++) {
      lp = (1 - a) * d[i] + a * lp;
      low += lp * lp;
      all += d[i] * d[i];
      if (i) hi += (d[i] - d[i - 1]) ** 2;
    }
    return { peak, peakMs: (at / sr) * 1000, low: low / all, hi: hi / all / 4, dur: buf.duration };
  };
  const out = { ms, gun: {}, impact: {}, differ: true, wav: {} };
  for (const [id, vs] of Object.entries(bank.gun)) {
    out.gun[id] = { n: vs.length, ...stats(vs[0]) };
    const a = vs[0].getChannelData(0);
    const b = vs[1].getChannelData(0);
    let diff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff += Math.abs(a[i] - b[i]);
    if (diff < 1) out.differ = false;
  }
  for (const [k, vs] of Object.entries(bank.impact)) out.impact[k] = { n: vs.length, ...stats(vs[0]) };

  // Through the real GameAudio graph: a near and a far rifle shot.
  async function shot(distance) {
    const ctx = new OfflineAudioContext(2, 44100 * 1.2, 44100);
    const ga = window.__GameAudio.offline(ctx);
    await ga.loadBank();
    ga.setVolumes(1, 1);
    ga.setListener({ x: 0, y: 1.6, z: 0 }, 0);
    ga.gunshot('rifle', 'ar7', { x: 0, y: 1.6, z: -distance }, distance);
    const buf = await ctx.startRendering();
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < 2; c++) buf.getChannelData(c).forEach((v, i) => (mono[i] += v / 2));
    const b = ctx.createBuffer(1, mono.length, 44100);
    b.copyToChannel(mono, 0);
    return { ready: ga.bankReady, ...stats(b) };
  }
  out.near = await shot(4);
  out.far = await shot(45);

  if (wantWav) {
    const wav = (buf) => {
      const d = buf.getChannelData(0);
      const bytes = new DataView(new ArrayBuffer(44 + d.length * 2));
      const str = (o, s) => [...s].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
      str(0, 'RIFF');
      bytes.setUint32(4, 36 + d.length * 2, true);
      str(8, 'WAVEfmt ');
      bytes.setUint32(16, 16, true);
      bytes.setUint16(20, 1, true);
      bytes.setUint16(22, 1, true);
      bytes.setUint32(24, buf.sampleRate, true);
      bytes.setUint32(28, buf.sampleRate * 2, true);
      bytes.setUint16(32, 2, true);
      bytes.setUint16(34, 16, true);
      str(36, 'data');
      bytes.setUint32(40, d.length * 2, true);
      d.forEach((v, i) => bytes.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
      return Array.from(new Uint8Array(bytes.buffer));
    };
    for (const [id, vs] of Object.entries(bank.gun)) out.wav[`gun-${id}`] = wav(vs[0]);
    for (const [k, vs] of Object.entries(bank.impact)) out.wav[`impact-${k}`] = wav(vs[0]);
  }
  return out;
}, !!wavDir);

check('the bank renders (6 guns, 5 impact kinds, 3 variants each)', Object.keys(r.gun).length === 6 && Object.keys(r.impact).length === 5 && [...Object.values(r.gun), ...Object.values(r.impact)].every((s) => s.n === 3 && s.peak > 0.5), `${r.ms.toFixed(0)} ms`);
check('every gunshot hits its peak within the first 15 ms (a sharp report, not a swell)', Object.values(r.gun).every((s) => s.peakMs < 15), Object.entries(r.gun).map(([k, s]) => `${k} ${s.peakMs.toFixed(1)} ms`).join(', '));
check('heavier guns carry more low end: sniper and shotgun > rifle > pistol', r.gun.longbow.low > r.gun.ar7.low && r.gun.pump12.low > r.gun.ar7.low && r.gun.ar7.low > r.gun.p9.low, Object.entries(r.gun).map(([k, s]) => `${k} ${s.low.toFixed(3)}`).join(', '));
check('heavier guns ring out longer', r.gun.longbow.dur > r.gun.ar7.dur && r.gun.ar7.dur > r.gun.mk5.dur);
check('a headshot rings brighter than a body hit (helmet ping vs. thud)', r.impact.head.hi > r.impact.flesh.hi * 2, `head ${r.impact.head.hi.toFixed(3)} vs flesh ${r.impact.flesh.hi.toFixed(3)}`);
check('a body hit is dominated by low end', r.impact.flesh.low > r.impact.concrete.low, `flesh ${r.impact.flesh.low.toFixed(3)} vs concrete ${r.impact.concrete.low.toFixed(3)}`);
check('variants of the same gun differ (no machine-gun sample repeat)', r.differ);
check('GameAudio plays the bank once loaded', r.near.ready && r.near.peak > 0.05, `near peak ${r.near.peak.toFixed(3)}`);
check('a distant shot is quieter and duller than a near one', r.far.peak < r.near.peak && r.far.hi < r.near.hi, `near hi ${r.near.hi.toFixed(4)}, far hi ${r.far.hi.toFixed(4)}`);
check('no page errors', errors.length === 0, errors.join(' | '));

if (wavDir) {
  mkdirSync(wavDir, { recursive: true });
  for (const [name, bytes] of Object.entries(r.wav)) writeFileSync(`${wavDir}/${name}.wav`, Buffer.from(bytes));
  console.log(`wrote ${Object.keys(r.wav).length} WAV files to ${wavDir}`);
}
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
