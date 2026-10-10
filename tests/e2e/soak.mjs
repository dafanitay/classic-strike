// Soak test: a solo match with 4v4 bots played for many rounds in the real
// client (rendering every few ticks), checking that nothing grows without
// bound round after round: JS heap, GPU geometries/textures, scene objects,
// effects, positional audio voices and HUD DOM nodes.
// Run against `npm run dev`:
//   node tests/e2e/soak.mjs http://127.0.0.1:5180 [rounds]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const rounds = Number(process.argv[3] ?? 12);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'medium' })));
await page.goto(base + '/?debug=1');
await page.click('text=Play Solo'); // also unlocks audio (a real click)
await page.click('.seg button:has-text("Attackers")');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
await page.evaluate(() => {
  const s = window.__cs;
  s.input.testMode = true;
  s.onLockChange(true);
  s.paused = true;
  s.sim.config.roundsToWin = 99; // keep the match going
});

const sample = () =>
  page.evaluate(() => {
    if (window.gc) window.gc();
    const s = window.__cs;
    const r = s.renderer;
    let objects = 0;
    r.scene.traverse(() => objects++);
    return {
      round: s.sim.round,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0,
      geometries: r.renderer.info.memory.geometries,
      textures: r.renderer.info.memory.textures,
      programs: r.renderer.info.programs?.length ?? 0,
      objects,
      effects: r.effects.group.children.length,
      voices: s.audio.activeVoices,
      dom: document.getElementsByTagName('*').length,
    };
  });

const samples = [];
await page.evaluate(() => window.__cs.render?.());
samples.push(await sample());
const t0 = Date.now();
for (let i = 0; i < rounds; i++) {
  // Play until the round number changes, rendering every 6th tick.
  await page.evaluate(async () => {
    const s = window.__cs;
    const start = s.sim.round;
    for (let t = 0; t < 60 * 200 && s.sim.round === start && s.sim.phase !== 'matchEnd'; t++) {
      s.me.health = Math.max(s.me.health, 100); // the player survives; bots play the round
      s.step();
      if (t % 6 === 0) s.renderer.render(true);
      if (t % 600 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  });
  samples.push(await sample());
}
const secs = (Date.now() - t0) / 1000;
console.log('round  heapMB  geo  tex  prog  objects  effects  voices  dom');
for (const s of samples) console.log(`${String(s.round).padStart(5)}  ${s.heapMB.toFixed(1).padStart(6)}  ${String(s.geometries).padStart(3)}  ${String(s.textures).padStart(3)}  ${String(s.programs).padStart(4)}  ${String(s.objects).padStart(7)}  ${String(s.effects).padStart(7)}  ${String(s.voices).padStart(6)}  ${String(s.dom).padStart(4)}`);

// Compare the second half against the first: a leak keeps climbing.
const early = samples[2] ?? samples[1];
const last = samples[samples.length - 1];
const played = last.round - samples[0].round;
check(`${played} rounds played in ${secs.toFixed(0)} s`, played >= rounds - 1);
check('GPU geometries do not grow round over round', last.geometries <= early.geometries + 10, `${early.geometries} → ${last.geometries}`);
check('GPU textures do not grow', last.textures <= early.textures + 2, `${early.textures} → ${last.textures}`);
check('scene objects stay bounded', last.objects <= early.objects + 60, `${early.objects} → ${last.objects}`);
check('effects (tracers, decals, puffs) stay bounded', last.effects <= 400, `${last.effects}`);
check('audio voices stay under the cap', samples.every((s) => s.voices <= 40), samples.map((s) => s.voices).join(','));
check('HUD DOM stays bounded', last.dom <= early.dom + 40, `${early.dom} → ${last.dom}`);
if (last.heapMB) check('JS heap (after GC) does not keep climbing', last.heapMB <= early.heapMB * 1.35 + 5, `${early.heapMB.toFixed(1)} → ${last.heapMB.toFixed(1)} MB`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
