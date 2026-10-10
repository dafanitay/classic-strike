// Browser checks for grenades in the real client: buy through the menu with
// keys, take them out with 4, throw a smoke (the cloud renders and hazes the
// screen from inside), and flash yourself (the screen whites out, then
// fades). Run against `npm run dev`:
//   node tests/e2e/grenades.mjs http://127.0.0.1:5180 [outDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'low' })));
await page.goto(base + '/?debug=1');
await page.click('text=Play Solo');
await page.click('.seg button:has-text("Attackers")');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
// Drop any real pointer lock the clicks took: with test input on top of it,
// releasing it (as the buy menu does) would read as "back in the game".
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(200);
await page.evaluate(() => {
  const s = window.__cs;
  s.input.testMode = true;
  s.onLockChange(true);
  s.paused = false; // the buy menu only opens while the game runs
  s.me.money = 16000;
  s.bots = null; // nobody else moves
  for (const p of s.sim.players) if (p !== s.me) p.cmd = { forward: 0, side: 0, jump: false, crouch: false, walk: false, yaw: p.yaw, pitch: 0, fire: false, altFire: false, reload: false, slot: 0, use: false };
});
const steps = (n) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__cs.step(); }, n);
const key = async (k) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(80);
};

// Buy during the freeze: B, 6 = equipment, then the flash / HE / smoke rows.
await key('KeyB');
await page.waitForSelector('.buymenu:not(.hidden)', { timeout: 5000 });
await key('Digit6');
await page.waitForFunction(() => /Equipment/.test(document.querySelector('.buymenu h2')?.textContent ?? ''), null, { timeout: 5000 });
const rows = await page.$$eval('.buymenu .buy-item:not(.hidden)', (els) => els.map((e) => e.textContent));
const idx = (name) => rows.findIndex((r) => r.includes(name)) + 1;
await key(`Digit${idx('Smoke Grenade')}`);
await key(`Digit${idx('Flashbang')}`);
await key(`Digit${idx('HE Grenade')}`);
const nades = await page.evaluate(() => ({ ...window.__cs.me.nades }));
check('grenades are bought from the equipment menu with number keys', nades.smoke === 1 && nades.flash === 1 && nades.he === 1, JSON.stringify(nades));
await key('KeyB');
await page.evaluate(() => {
  window.__cs.onLockChange(true);
  window.__cs.paused = true; // from here on the test steps the game itself
});

// Live round; stand in Long A facing east.
await page.evaluate(() => {
  const s = window.__cs;
  while (s.sim.phase !== 'live') s.step();
  const c = s.sim.map.cellCenter(8, 3);
  s.me.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
  s.me.body.vel = { x: 0, y: 0, z: 0 };
  s.input.yaw = -Math.PI / 2;
  s.input.pitch = 0.15;
});
await key('Digit4');
await steps(40);
let held = await page.evaluate(() => window.__cs.me.weapons[window.__cs.me.current]?.id);
// Cycle to the smoke.
for (let i = 0; i < 3 && held !== 'smoke'; i++) {
  await key('Digit4');
  await steps(40);
  held = await page.evaluate(() => window.__cs.me.weapons[window.__cs.me.current]?.id);
}
check('key 4 takes out a grenade and cycles to the smoke', held === 'smoke', held);
await page.evaluate(() => window.__cs.input.setMouse(0, true));
await steps(2);
await page.evaluate(() => window.__cs.input.setMouse(0, false));
const flying = await page.evaluate(() => window.__cs.sim.nadesInFlight.map((n) => ({ ...n.pos })));
await steps(60 * 4);
// A rendered frame builds the cloud (slow under software GL).
await page.waitForFunction(() => window.__cs.renderer.nades.group.children.length > 0, null, { timeout: 8000 }).catch(() => {});
const smoke = await page.evaluate(() => ({ n: window.__cs.sim.smokes.length, cloud: window.__cs.renderer.nades.group.children.length }));
check('the smoke lands and a cloud is drawn', smoke.n === 1 && smoke.cloud >= 1, JSON.stringify({ ...smoke, flying }));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/nade-01-smoke.png` });

// Walk into the cloud: the screen hazes over.
await page.evaluate(() => {
  const s = window.__cs;
  const sm = s.sim.smokes[0];
  s.me.body.pos = { x: sm.pos.x, y: sm.pos.y - 1.2, z: sm.pos.z };
});
await steps(3);
await page.waitForTimeout(400);
const haze = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.screen-smoke')).opacity));
check('standing inside the smoke hazes the screen', haze > 0.5, `opacity ${haze}`);
await page.screenshot({ path: `${out}/nade-02-inside-smoke.png` });

// Flash yourself: throw it at the wall in front and keep looking.
await page.evaluate(() => {
  const s = window.__cs;
  const c = s.sim.map.cellCenter(20, 3);
  s.me.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
  s.input.yaw = -Math.PI / 2;
  s.input.pitch = 0.05;
});
await key('Digit4');
await steps(40);
held = await page.evaluate(() => window.__cs.me.weapons[window.__cs.me.current]?.id);
for (let i = 0; i < 3 && held !== 'flash'; i++) {
  await key('Digit4');
  await steps(40);
  held = await page.evaluate(() => window.__cs.me.weapons[window.__cs.me.current]?.id);
}
await page.evaluate(() => window.__cs.input.setMouse(0, true));
await steps(2);
await page.evaluate(() => window.__cs.input.setMouse(0, false));
await page.evaluate(() => {
  const s = window.__cs;
  for (let i = 0; i < 60 * 1.7; i++) s.step();
});
await page.waitForTimeout(300);
const white = await page.evaluate(() => ({ o: Number(getComputedStyle(document.querySelector('.screen-flash')).opacity), full: window.__cs.me.blindFull - window.__cs.sim.time }));
check('a flashbang in front of you whites the screen out', white.o > 0.9 && white.full > 0, JSON.stringify(white));
await page.screenshot({ path: `${out}/nade-03-flashed.png` });
await steps(60 * 5);
await page.waitForTimeout(300);
const after = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.screen-flash')).opacity));
check('…and it fades back to normal', after < 0.05, `opacity ${after}`);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
