// Browser checks for weapon selection: only keys 1/2/3 (top row or numpad)
// change weapons; the mouse wheel never does. Touch-surface mice like the
// Apple Magic Mouse send streams of small pixel-mode wheel events (with
// momentum, in both axes) whenever a finger moves; those are simulated here.
// Physical Magic Mouse testing is still a manual step.
// Run against `npm run dev`:
//   node tests/e2e/controls.mjs http://127.0.0.1:5180 [outDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'low' })));
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
  // Count weapon switches and shots from here on.
  window.__ev = { switch: 0, shot: 0 };
  const orig = s.handleEvents.bind(s);
  s.handleEvents = (evs) => {
    for (const e of evs) if (e.player === s.me.id || e.shooter === s.me.id) if (e.type in window.__ev) window.__ev[e.type]++;
    orig(evs);
  };
});
const steps = (n = 3) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__cs.step(); }, n);
const cur = () => page.evaluate(() => window.__cs.me.current);
const ev = () => page.evaluate(() => ({ ...window.__ev }));

check('starts on the pistol (slot 2)', (await cur()) === 2);

// --- Magic-Mouse-like scrolling: many small pixel deltas, momentum tail, both axes.
await page.evaluate(() => {
  const targets = [document.getElementById('game'), document, window, document.body];
  for (let k = 0; k < 240; k++) {
    const dy = Math.round(Math.sin(k / 9) * 40 * Math.exp(-k / 120)) || (k % 2 ? 1 : -1);
    const dx = Math.round(Math.cos(k / 7) * 12);
    for (const t of targets) t?.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
    if (k % 8 === 0) window.__cs.step();
  }
  // A classic notched wheel too (line mode, big deltas).
  for (let k = 0; k < 20; k++) document.dispatchEvent(new WheelEvent('wheel', { deltaY: k % 2 ? 3 : -3, deltaMode: 1, bubbles: true }));
});
await page.mouse.move(480, 270);
for (let k = 0; k < 15; k++) await page.mouse.wheel(k % 3 === 0 ? -120 : 53, 7);
await steps(5);
let e = await ev();
check('Magic-Mouse-style and notched wheel scrolling never changes the weapon', (await cur()) === 2 && e.switch === 0, `current ${await cur()}, switches ${e.switch}`);

// --- keys 1/2/3
await page.keyboard.press('Digit3');
await steps();
check('key 3 selects the knife (slot 3)', (await cur()) === 3);
await page.keyboard.press('Digit1');
await steps();
check('key 1 with no primary weapon is ignored safely', (await cur()) === 3);
await page.evaluate(() => { window.__cs.me.weapons[1] = { id: 'ar7', mag: 30, reserve: 90 }; });
await page.keyboard.press('Digit1');
await steps();
check('key 1 selects the primary (slot 1)', (await cur()) === 1);
await page.keyboard.press('Digit2');
await steps();
check('key 2 selects the pistol (slot 2)', (await cur()) === 2);
await page.keyboard.press('Numpad3');
await steps();
await page.keyboard.press('Numpad1');
await steps();
check('numpad 3 and 1 work the same', (await cur()) === 1);
await page.keyboard.press('KeyQ');
await steps();
check('Q no longer switches weapons', (await cur()) === 1);
e = await ev();
check('switching never fired a shot', e.shot === 0, `shots ${e.shot}`);

// --- holding a key: one switch, not a stream
const before = (await ev()).switch;
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }));
  for (let k = 0; k < 20; k++) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', repeat: true, bubbles: true }));
  for (let i = 0; i < 10; i++) window.__cs.step();
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2', bubbles: true }));
});
await steps();
check('holding 2 switches once', (await cur()) === 2 && (await ev()).switch - before === 1, `${(await ev()).switch - before} switches`);

// --- reload interplay (classic: switching weapons cancels a reload)
const reload = await page.evaluate(() => {
  const s = window.__cs;
  s.me.weapons[2].mag = 5;
  s.input.queueSlotExternal(2);
  for (let i = 0; i < 40; i++) s.step(); // finish drawing
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
  for (let i = 0; i < 10; i++) s.step();
  const reloading = s.sim.isReloading(s.me);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit3', bubbles: true }));
  for (let i = 0; i < 5; i++) s.step();
  const cancelled = !s.sim.isReloading(s.me) && s.me.weapons[2].mag === 5;
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2', bubbles: true }));
  for (let i = 0; i < 40; i++) s.step();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
  for (let i = 0; i < 60 * 3; i++) s.step();
  return { reloading, cancelled, mag: s.me.weapons[2].mag };
});
check('R reloads; switching away cancels it; reloading again fills the magazine', reload.reloading && reload.cancelled && reload.mag === 15, JSON.stringify(reload));

// --- typing into a text field never drives the game
const typed = await page.evaluate(() => {
  const inp = document.createElement('input');
  inp.type = 'text';
  document.body.appendChild(inp);
  inp.focus();
  return true;
});
const curBefore = await cur();
await page.keyboard.type('31 r23');
await steps();
const value = await page.evaluate(() => document.querySelector('body > input[type=text]').value);
check('typing digits into a text field does not switch weapons', typed && (await cur()) === curBefore && value === '31 r23', `weapon ${await cur()}, field "${value}"`);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
