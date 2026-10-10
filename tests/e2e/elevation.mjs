// Browser checks for map elevation: the local player walks up real stairs
// with real key input through the full client (prediction path included),
// and screenshots of each raised area for a visual check. Run against
// `npm run dev`:
//   node tests/e2e/elevation.mjs http://127.0.0.1:5180 [outDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'medium' })));
await page.goto(base + '/?debug=1');
await page.click('text=Play Solo');
await page.click('.seg button:has-text("Attackers")');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
await page.evaluate(() => { const s = window.__cs; s.input.testMode = true; s.onLockChange(true); s.paused = true; for (let i = 0; i < 300; i++) s.step(); });

/** Puts the local player on a cell, facing a yaw (radians, 0 = -Z) and pitch. */
const place = (cx, cz, yaw, pitch = 0) => page.evaluate(([cx, cz, yaw, pitch]) => {
  const s = window.__cs;
  const c = s.sim.map.cellCenter(cx, cz);
  s.me.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
  s.me.body.vel = { x: 0, y: 0, z: 0 };
  s.input.yaw = yaw;
  s.input.pitch = pitch;
  for (let i = 0; i < 5; i++) s.step();
  return s.me.body.pos.y;
}, [cx, cz, yaw, pitch]);

const E = -Math.PI / 2, W = Math.PI / 2, N = 0, S = Math.PI;

// 1. Walk up the Long A stairs with the W key.
const y0 = await place(26, 3, E);
const climb = await page.evaluate(() => {
  const s = window.__cs;
  s.input.setKey('KeyW', true);
  let air = 0;
  for (let i = 0; i < 70; i++) { s.step(); if (!s.me.body.onGround) air++; }
  s.input.setKey('KeyW', false);
  for (let i = 0; i < 20; i++) s.step();
  return { y: s.me.body.pos.y, x: s.me.body.pos.x, air, area: s.sim.map.areaNameAt(s.me.body.pos) };
});
check('walking forward up the Long A stairs reaches the A Site platform', y0 < 0.05 && Math.abs(climb.y - 1) < 0.01 && climb.x > 58, JSON.stringify(climb));
check('…without leaving the ground', climb.air === 0, `${climb.air} airborne ticks`);

// 2. Walk back down: stays grounded (ground snapping).
const down = await page.evaluate(() => {
  const s = window.__cs;
  s.input.yaw = Math.PI / 2;
  s.input.setKey('KeyW', true);
  let air = 0;
  for (let i = 0; i < 50; i++) { s.step(); if (!s.me.body.onGround) air++; }
  s.input.setKey('KeyW', false);
  for (let i = 0; i < 20; i++) s.step();
  return { y: s.me.body.pos.y, air };
});
check('walking back down the stairs stays on the ground', Math.abs(down.y) < 0.01 && down.air === 0, JSON.stringify(down));

// 3. Screenshots of every raised area.
const shots = [
  ['el-01-long-stairs', 25, 3, E, -0.05],
  ['el-02-a-ramp-stairs', 33, 10, N, -0.05],
  ['el-03-catwalk', 22, 12, N, 0.02],
  ['el-04-a-site-from-above', 33, 3, W + 0.4, -0.15],
  ['el-05-b-doors-balcony', 24, 23, E, 0.05],
  ['el-06-b-ramp-from-spawn', 33, 17, S, -0.05],
];
for (const [name, cx, cz, yaw, pitch] of shots) {
  await place(cx, cz, yaw, pitch);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
}
check('screenshots taken', true, shots.map((s) => s[0]).join(', '));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
