// Browser checks for combat feedback: configurable crosshair, hit marker,
// damage-direction indicator. Run against `npm run dev`:
//   node tests/e2e/feedback.mjs http://127.0.0.1:5180 [outDir]
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

// Saved settings from a previous visit: a cyan, static, dotted crosshair.
await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'low', crosshair: { size: 12, gap: 5, thickness: 2, color: 'cyan', dynamic: false, dot: true, outline: true } })));
await page.goto(base + '/?debug=1');
await page.click('text=Settings');
await page.waitForSelector('.xhair-preview');
const previewLines = await page.locator('.xhair-centre i').count();
check('settings show a crosshair preview (4 lines + dot)', previewLines === 5, `${previewLines} elements`);
await page.screenshot({ path: `${out}/fb-01-settings.png`, fullPage: true });
// Change the length via the slider and check it persists.
await page.locator('.row', { hasText: 'Length' }).locator('input[type=range]').fill('20');
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('classic-strike.settings.v1')).crosshair);
check('changing a crosshair setting is saved immediately', saved.size === 20 && saved.color === 'cyan', JSON.stringify(saved));
await page.click('text=Back');

await page.click('text=Play Solo');
await page.click('.seg button:has-text("Attackers")');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
await page.evaluate(() => { const s = window.__cs; s.input.testMode = true; s.onLockChange(true); s.paused = true; for (let i = 0; i < 300; i++) s.step(); });
await page.waitForTimeout(400);
const xh = await page.evaluate(() => [...document.querySelectorAll('.crosshair i')].map((e) => ({ l: e.style.left, t: e.style.top, w: e.style.width, h: e.style.height, bg: getComputedStyle(e).backgroundColor, d: e.style.display })));
check('in-game crosshair uses the saved settings (static gap 5, length 20, cyan, dot)', xh[3].l === '5px' && xh[3].w === '20px' && xh[4].d === 'block' && xh[0].bg === 'rgb(77, 242, 255)', JSON.stringify(xh[3]));

// Hit marker: shoot an enemy placed in front of us.
const hit = await page.evaluate(() => {
  const s = window.__cs;
  s.me.weapons[1] = { id: 'ar7', mag: 30, reserve: 90 };
  s.input.queueSlotExternal(1);
  for (let i = 0; i < 45; i++) s.step(); // draw the rifle first
  const enemy = s.sim.players.find((p) => p.team !== s.me.team && p.alive);
  const a = s.sim.map.cellCenter(6, 3), b = s.sim.map.cellCenter(10, 3);
  s.me.body.pos = { x: a.x, y: 0, z: a.z };
  s.me.body.vel = { x: 0, y: 0, z: 0 };
  enemy.body.pos = { x: b.x, y: 0, z: b.z + 1.5 };
  enemy.body.vel = { x: 0, y: 0, z: 0 };
  const eye = s.sim.eyePos(s.me);
  const dx = enemy.body.pos.x - eye.x, dy = enemy.body.pos.y + 1.2 - eye.y, dz = enemy.body.pos.z - eye.z;
  s.input.yaw = Math.atan2(-dx, -dz);
  s.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  s.input.setMouse(0, true);
  s.step();
  s.input.setMouse(0, false);
  // Read the marker immediately: it is only shown for ~0.2 s.
  return { hp: enemy.health, marker: document.querySelector('.hitmarker').className };
});
const marker = hit.marker;
check('hitting an enemy shows the hit marker', hit.hp < 100 && /show/.test(marker), `${marker}, enemy hp ${hit.hp}`);
await page.screenshot({ path: `${out}/fb-02-hitmarker.png` });

// Damage direction: an enemy to our left shoots us.
const dir = await page.evaluate(() => {
  const s = window.__cs;
  const me = s.me;
  const enemy = s.sim.players.find((p) => p.team !== me.team && p.alive);
  s.input.yaw = 0; // facing -Z; an attacker at -X is on our LEFT
  me.yaw = 0;
  s.sim.events.length = 0;
  s.sim.damage(me, enemy, 5, 'chest', me.body.pos, 'ar7');
  enemy.body.pos = { x: me.body.pos.x - 6, y: 0, z: me.body.pos.z };
  s.handleEvents(s.sim.events.splice(0));
  const el = [...document.querySelectorAll('.dmgdir')].find((e) => e.classList.contains('show'));
  return el ? el.style.transform : null;
});
// Left = +90° in sim yaw -> rotate(-1.5708rad) on screen (counter-clockwise, i.e. pointing left).
check('taking damage shows an arc pointing toward the attacker', !!dir && /rotate\(-1\.57/.test(dir), String(dir));
await page.waitForTimeout(100);
await page.screenshot({ path: `${out}/fb-03-damage-dir.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
