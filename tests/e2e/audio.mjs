// Browser checks for positional audio. Renders the game's real audio graph
// (GameAudio, synthesised sounds, HRTF panner) with an OfflineAudioContext
// in Chromium and measures the result per ear: left/right placement, the
// effect of turning around, front vs behind, distance, walls, the voice cap
// and clean-up; then checks a live match plays positional sounds and frees
// them. Whether it *sounds* right on real headphones is a manual test.
// Run against `npm run dev`:
//   node tests/e2e/audio.mjs http://127.0.0.1:5180
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/?debug=1');
await page.waitForFunction(() => !!window.__GameAudio);

const probes = await page.evaluate(async () => {
  const GA = window.__GameAudio;
  const SR = 48000;
  async function probe({ listener = { x: 0, y: 1.6, z: 0 }, yaw = 0, src, kind = 'footstep', hrtf = true, occluded = false }) {
    const ctx = new OfflineAudioContext(2, SR * 0.5, SR);
    const a = GA.offline(ctx);
    a.setHrtf(hrtf);
    a.setVolumes(1, 1);
    if (occluded) a.occluder = () => true;
    a.setListener(listener, yaw);
    // Several steps/shots, so the random synthesis averages out.
    if (kind === 'footstep') for (let i = 0; i < 1; i++) a.footstep(src, 'hard');
    else a.gunshot('rifle', 'ar7', src, Math.hypot(src.x - listener.x, src.z - listener.z));
    const buf = await ctx.startRendering();
    const ch = (c) => buf.getChannelData(c);
    const rms = (d) => Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
    // Share of high-frequency energy (first difference), averaged over both ears.
    const hf = (d) => {
      let e = 0;
      let h = 0;
      for (let i = 1; i < d.length; i++) {
        e += d[i] * d[i];
        h += (d[i] - d[i - 1]) ** 2;
      }
      return e ? h / e : 0;
    };
    // Interaural time difference: the lag (samples) that best aligns the
    // ears; positive = the right ear hears it later (source on the left).
    const xcorrLag = (a, b) => {
      let best = 0;
      let bestV = -Infinity;
      for (let lag = -48; lag <= 48; lag++) {
        let v = 0;
        for (let i = 64; i < a.length - 64; i += 2) v += a[i] * b[i + lag];
        if (v > bestV) {
          bestV = v;
          best = lag;
        }
      }
      return best;
    };
    return { L: rms(ch(0)), R: rms(ch(1)), hf: (hf(ch(0)) + hf(ch(1))) / 2, itd: xcorrLag(ch(0), ch(1)) };
  }
  const avg = async (opts, n = 6) => {
    const rs = [];
    for (let i = 0; i < n; i++) rs.push(await probe(opts));
    const m = (k) => rs.reduce((s, r) => s + r[k], 0) / n;
    return { L: m('L'), R: m('R'), hf: m('hf'), itd: m('itd') };
  };
  const at = (x, z) => ({ x, y: 0, z }); // feet on the floor
  const out = {};
  out.left = await avg({ src: at(-4, 0) });
  out.right = await avg({ src: at(4, 0) });
  out.leftTurned = await avg({ src: at(-4, 0), yaw: Math.PI }); // turned around
  out.front = await avg({ src: at(0, -4) });
  out.back = await avg({ src: at(0, 4) });
  out.near = await avg({ src: at(3, -3) });
  out.mid = await avg({ src: at(10, -10) });
  out.far = await avg({ src: at(18, -18) });
  out.beyond = await avg({ src: at(30, -30) });
  out.open = await avg({ src: at(6, -6) });
  out.wall = await avg({ src: at(6, -6), occluded: true });
  out.gunFar = await avg({ src: at(30, -30), kind: 'gunshot' }, 3);
  // Voice cap and clean-up: 300 shots and steps in one burst.
  const ctx = new OfflineAudioContext(2, SR * 1.5, SR);
  const a = GA.offline(ctx);
  a.setListener({ x: 0, y: 1.6, z: 0 }, 0);
  for (let i = 0; i < 150; i++) {
    a.footstep(at(Math.sin(i) * 5, Math.cos(i) * 5));
    a.gunshot('smg', 'mk5', at(Math.cos(i) * 8, Math.sin(i) * 8), 8);
  }
  out.peakVoices = a.activeVoices;
  await ctx.startRendering();
  a.flushFinished();
  out.afterVoices = a.activeVoices;
  return out;
});
const db = (r) => (20 * Math.log10(r)).toFixed(1);
const lr = (p) => p.L / p.R;
const ms = (s) => ((s / 48) ).toFixed(2) + ' ms';
check('a footstep on the left reaches the left ear first and louder', probes.left.itd > 10 && lr(probes.left) > 1.15, `right ear later by ${ms(probes.left.itd)}, L/R ${db(lr(probes.left))} dB`);
check('a footstep on the right reaches the right ear first and louder', probes.right.itd < -10 && lr(probes.right) < 1 / 1.15, `left ear later by ${ms(-probes.right.itd)}, L/R ${db(lr(probes.right))} dB`);
check('turning around moves that same left source to the right', probes.leftTurned.itd < -10 && lr(probes.leftTurned) < 1 / 1.15, `ITD ${ms(probes.leftTurned.itd)}, L/R ${db(lr(probes.leftTurned))} dB`);
check('in front and behind are centred (same time and level in both ears)', Math.abs(probes.front.itd) <= 2 && Math.abs(probes.back.itd) <= 2 && Math.abs(Math.log(lr(probes.front))) < 0.2 && Math.abs(Math.log(lr(probes.back))) < 0.2, `front ${ms(probes.front.itd)} ${db(lr(probes.front))} dB, back ${ms(probes.back.itd)} ${db(lr(probes.back))} dB`);
check('HRTF makes behind sound different from in front (duller: less high-frequency energy)', probes.back.hf < probes.front.hf * 0.9, `high-freq share front ${probes.front.hf.toFixed(3)} vs back ${probes.back.hf.toFixed(3)}`);
const lvl = (p) => (p.L + p.R) / 2;
check('footsteps get quieter with distance: 4 m > 14 m > 25 m, silent at 42 m', lvl(probes.near) > lvl(probes.mid) * 1.8 && lvl(probes.mid) > lvl(probes.far) * 1.8 && lvl(probes.beyond) === 0, `${lvl(probes.near).toFixed(4)} > ${lvl(probes.mid).toFixed(4)} > ${lvl(probes.far).toFixed(4)} > ${lvl(probes.beyond)}`);
check('a wall in between muffles a footstep (quieter and duller), without silencing it', lvl(probes.wall) < lvl(probes.open) * 0.7 && lvl(probes.wall) > 0 && probes.wall.hf < probes.open.hf, `open ${lvl(probes.open).toFixed(4)} hf ${probes.open.hf.toFixed(3)}; wall ${lvl(probes.wall).toFixed(4)} hf ${probes.wall.hf.toFixed(3)}`);
check('gunfire 42 m away is still heard', lvl(probes.gunFar) > 0.002, `${lvl(probes.gunFar).toFixed(4)}`);
check('a burst of 300 sounds is capped, and every voice is freed when they end', probes.peakVoices <= 40 && probes.afterVoices === 0, `peak ${probes.peakVoices}, after ${probes.afterVoices}`);

// Live match: bots fighting make positional sounds; they're freed again.
await page.click('text=Play Solo');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
const live = await page.evaluate(async () => {
  const s = window.__cs;
  s.input.testMode = true;
  s.onLockChange(true);
  s.audio.unlock();
  s.paused = true;
  let peak = 0;
  for (let i = 0; i < 60 * 25; i++) {
    s.me.health = 1e6;
    s.step();
    if (i % 30 === 0) {
      s.audio.setListener(s.sim.eyePos(s.me), s.input.yaw);
      peak = Math.max(peak, s.audio.activeVoices);
    }
  }
  const state = s.audio.ctx?.state;
  await new Promise((r) => setTimeout(r, 3500)); // let the real context play everything out
  s.audio.setListener(s.sim.eyePos(s.me), s.input.yaw);
  return { peak, after: s.audio.activeVoices, state };
});
check('a live bot match plays positional sounds, within the cap', live.peak > 0 && live.peak <= 40, JSON.stringify(live));
check('…and frees them once they have played', live.after < 5, `${live.after} still connected`);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
