// Visual baseline / comparison: screenshots from fixed camera positions and
// render cost (draw calls, triangles, CPU time per frame under software GL).
// Run against `npm run dev`:
//   node tests/e2e/visual.mjs http://127.0.0.1:5180 outDir label [quality]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const label = process.argv[4] ?? 'shot';
const quality = process.argv[5] ?? 'high';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript((q) => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: q })), quality);
await page.goto(base + '/?debug=1');
await page.click('text=Play Solo');
await page.click('.seg button:has-text("Attackers")');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
await page.evaluate(() => {
  const s = window.__cs;
  s.input.testMode = true;
  s.onLockChange(true);
  s.paused = true;
  for (let i = 0; i < 300; i++) s.step();
  s.bots = null; // freeze everyone where they are
  for (const p of s.sim.players) if (p !== s.me) p.cmd = { forward: 0, side: 0, jump: false, crouch: false, walk: false, yaw: p.yaw, pitch: 0, fire: false, altFire: false, reload: false, slot: 0, use: false };
  document.querySelector('.hud-center')?.classList.add('hidden');
});

const views = [
  ['long-a', 6, 3, -Math.PI / 2, -0.02],
  ['a-site', 33, 8, 0.35, -0.12],
  ['mid', 9, 14, -Math.PI / 2, 0],
  ['middle-catwalk', 22, 13, 0.1, 0.05],
  ['b-site', 19, 24, -Math.PI / 2 + 0.3, -0.05],
  ['b-tunnels', 4, 25, -Math.PI / 2, 0],
  ['def-spawn', 31, 16, -0.6, -0.05],
];
const stats = [];
for (const [name, cx, cz, yaw, pitch] of views) {
  const r = await page.evaluate(([cx, cz, yaw, pitch]) => {
    const s = window.__cs;
    const c = s.sim.map.cellCenter(cx, cz);
    s.me.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
    s.me.body.vel = { x: 0, y: 0, z: 0 };
    s.input.yaw = yaw;
    s.input.pitch = pitch;
    for (let i = 0; i < 3; i++) s.step();
    // Put an enemy in view for readability checks.
    const enemy = s.sim.players.find((p) => p.team !== s.me.team && p.alive);
    if (enemy) {
      const d = 7;
      enemy.body.pos = { x: c.x - Math.sin(yaw) * d + 1.2, y: s.sim.map.surfaceY({ x: c.x - Math.sin(yaw) * d + 1.2, z: c.z - Math.cos(yaw) * d }), z: c.z - Math.cos(yaw) * d };
    }
    return true;
  }, [cx, cz, yaw, pitch]);
  await page.waitForTimeout(400);
  const perf = await page.evaluate(() => {
    const s = window.__cs;
    const r = s.renderer;
    // Scene and viewmodel are two render() calls; count both (three.js
    // otherwise resets the counters per call and reports only the last).
    const info = r.renderer.info;
    info.autoReset = false;
    info.reset();
    r.render(true);
    const calls = info.render.calls;
    const tris = info.render.triangles;
    info.autoReset = true;
    return { calls, tris, geos: info.memory.geometries, tex: info.memory.textures };
  });
  // Frame time: readPixels blocks until the GPU (here SwiftShader) has drawn
  // the frame. Measured in short batches: one long blocking loop trips
  // Chrome's GPU watchdog and crashes the page under software rendering.
  const batch = (n) => page.evaluate((n) => {
    const r = window.__cs.renderer;
    const gl = r.renderer.getContext();
    const px = new Uint8Array(4);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { r.render(true); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return performance.now() - t0;
  }, n);
  await batch(2);
  let total = 0;
  for (let i = 0; i < 5; i++) total += await batch(4);
  perf.ms = total / 20;
  stats.push({ name, ...perf });
  await page.screenshot({ path: `${out}/${label}-${name}.png`, timeout: 120000 });
  void r;
}
for (const s of stats) console.log(`${s.name.padEnd(15)} ${s.ms.toFixed(1).padStart(6)} ms/frame (software GL)  ${String(s.calls).padStart(4)} draw calls  ${String(s.tris).padStart(7)} triangles`);
const avg = stats.reduce((a, s) => a + s.ms, 0) / stats.length;
console.log(`average ${avg.toFixed(1)} ms/frame; geometries ${stats[0].geos}, textures ${stats[0].tex}; errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await browser.close();
