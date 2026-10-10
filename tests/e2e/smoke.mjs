// End-to-end smoke test: drives the real game in headless Chromium.
// Usage: start `npm run dev`, then `node tests/e2e/smoke.mjs [baseUrl] [outDir]`.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(base + '/?debug=1');
await page.waitForSelector('text=Play Solo');
await page.screenshot({ path: `${out}/01-main-menu.png` });
check('main menu renders all entries', await page.locator('.menu-btn').count() === 5);

await page.click('text=Play Solo');
await page.waitForSelector('text=Start Match');
// Deterministic setup: Attackers, 1 teammate, 2 opponents, normal.
await page.click('.seg button:has-text("Attackers")');
await page.locator('.row', { hasText: 'Teammate bots' }).locator('button', { hasText: /^1$/ }).click();
await page.locator('.row', { hasText: 'Opponent bots' }).locator('button', { hasText: /^2$/ }).click();
await page.screenshot({ path: `${out}/02-solo-setup.png` });
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);

// Real pointer lock: click the overlay and see if the browser grants it.
await page.waitForTimeout(400);
if (await page.locator('.clickplay').isVisible()) {
  await page.click('.clickplay');
  await page.waitForTimeout(400);
}
console.log('INFO  errors so far:', errors.join(' | ') || 'none');
const realLock = await page.evaluate(() => document.pointerLockElement?.id === 'game');
check('pointer lock acquired from click', realLock, realLock ? '' : 'headless browser refused; falling back to test input mode');
if (!realLock) {
  await page.evaluate(() => { window.__cs.input.testMode = true; window.__cs.onLockChange(true); });
}
await page.waitForTimeout(300);
const hudVisible = await page.locator('#hud').isVisible();
check('HUD visible in game', hudVisible);
await page.screenshot({ path: `${out}/03-spawn-freeze.png` });

// Buy during freeze: B opens menu, 7 = Kevlar ($650 of $800).
const st0 = await page.evaluate(() => ({ phase: window.__cs.sim.phase, money: window.__cs.me.money, armor: window.__cs.me.armor }));
await page.keyboard.press('KeyB');
await page.waitForTimeout(150);
const buyOpen = await page.locator('.buymenu').isVisible();
await page.screenshot({ path: `${out}/04-buy-menu.png` });
await page.keyboard.press('Digit7');
await page.waitForTimeout(100);
const st1 = await page.evaluate(() => ({ money: window.__cs.me.money, armor: window.__cs.me.armor }));
check('buy menu opens with B during freeze', buyOpen, `phase=${st0.phase}`);
check('buying Kevlar charges $650 and gives armour', st1.armor === 100 && st1.money === st0.money - 650, JSON.stringify(st1));
await page.keyboard.press('KeyB');
await page.waitForTimeout(100);
if (!realLock) await page.evaluate(() => window.__cs.onLockChange(true));
check('buy menu closes with B', !(await page.locator('.buymenu').isVisible()));

// Wait for freeze to end, then move forward with W.
await page.waitForFunction(() => window.__cs.sim.phase === 'live', null, { timeout: 8000 });
// Steps are driven tick-by-tick so the check doesn't depend on render speed.
const p0 = await page.evaluate(() => ({ ...window.__cs.me.body.pos }));
await page.keyboard.down('KeyW');
await page.evaluate(() => { for (let i = 0; i < 60; i++) window.__cs.step(); });
await page.keyboard.up('KeyW');
const p1 = await page.evaluate(() => ({ ...window.__cs.me.body.pos }));
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
check('W moves the player forward (east for Attackers)', moved > 4 && p1.x > p0.x, `moved ${moved.toFixed(2)} m in 1 s of game time`);

// Mouse look (synthetic movementX).
const yaw0 = await page.evaluate(() => window.__cs.input.yaw);
await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 0 })));
const yaw1 = await page.evaluate(() => window.__cs.input.yaw);
check('mouse movement turns the view', Math.abs(yaw1 - yaw0) > 0.05, `Δyaw=${(yaw1 - yaw0).toFixed(3)}`);

// Jump.
await page.keyboard.down('Space');
const air = await page.evaluate(() => { let m = 0; for (let i = 0; i < 20; i++) { window.__cs.step(); m = Math.max(m, window.__cs.me.body.pos.y); } return m; });
await page.keyboard.up('Space');
await page.evaluate(() => { for (let i = 0; i < 60; i++) window.__cs.step(); });
check('Space jumps', air > 0.3, `y=${air.toFixed(2)}`);
await page.waitForTimeout(800);

// Collision: stand in Long A facing the north wall and run into it.
const wallTest = await page.evaluate(async () => {
  const s = window.__cs;
  const c = s.sim.map.cellCenter(8, 3);
  s.me.body.pos = { x: c.x, y: 0, z: c.z };
  s.me.body.vel = { x: 0, y: 0, z: 0 };
  s.input.yaw = 0; // facing -Z = north; wall row z=1 is solid, z face at 4.0
  s.input.pitch = 0;
  return { start: c.z };
});
await page.keyboard.down('KeyW');
await page.evaluate(() => { for (let i = 0; i < 120; i++) window.__cs.step(); });
await page.keyboard.up('KeyW');
const zAfter = await page.evaluate(() => window.__cs.me.body.pos.z);
check('cannot walk through a wall', zAfter >= 4 + 0.40 - 0.01, `z=${zAfter.toFixed(3)} (wall face at 4.0)`);
await page.screenshot({ path: `${out}/05-against-wall.png` });

// Freeze the real-time loop so only our explicit ticks advance the game
// (bots would otherwise keep moving between our aim and our shot).
await page.evaluate(() => { window.__cs.paused = true; });
// Combat: give the player a rifle, put an enemy bot 8 m ahead in Long A, shoot.
const aimAt = () => page.evaluate(() => {
  const s = window.__cs;
  const enemy = s.sim.players.find((p) => p.team !== s.me.team && p.alive);
  const a = s.sim.map.cellCenter(6, 3);
  const b = s.sim.map.cellCenter(10, 3);
  s.me.body.pos = { x: a.x, y: 0, z: a.z };
  s.me.body.vel = { x: 0, y: 0, z: 0 };
  enemy.body.pos = { x: b.x, y: 0, z: b.z + 1.5 };
  enemy.body.vel = { x: 0, y: 0, z: 0 };
  const eye = s.sim.eyePos(s.me);
  const tgt = { x: enemy.body.pos.x, y: enemy.body.pos.y + 1.2, z: enemy.body.pos.z };
  const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
  s.input.yaw = Math.atan2(-dx, -dz);
  s.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { id: enemy.id, hp: enemy.health, name: enemy.name };
});
await page.evaluate(() => {
  const s = window.__cs;
  s.me.weapons[1] = { id: 'ar7', mag: 30, reserve: 90 };
  s.input.queueSlotExternal(1);
  for (let i = 0; i < 40; i++) s.step(); // switch + draw time
});
let target = await aimAt();
const mouse = (type) => page.evaluate((t) => document.dispatchEvent(new MouseEvent(t, { button: 0 })), type);
await mouse('mousedown');
const shotInfo = await page.evaluate(() => { window.__cs.step(); return window.__cs.sim.events.filter((e) => e.type === 'shot' || e.type === 'hit'); });
let hit = await page.evaluate((id) => { const e = window.__cs.sim.getPlayer(id); return { hp: e.health, alive: e.alive, mag: window.__cs.me.weapons[1].mag }; }, target.id);
check('shooting an enemy damages it', hit.hp < target.hp, `enemy hp ${target.hp} -> ${hit.hp}, rifle mag=${hit.mag}`);
if (!(hit.hp < target.hp)) console.log('DBG shot', JSON.stringify(shotInfo), JSON.stringify(await page.evaluate((id) => { const e = window.__cs.sim.getPlayer(id); return { pos: e.body.pos, crouched: e.body.crouched, me: window.__cs.me.body.pos, yaw: window.__cs.me.yaw, pitch: window.__cs.me.pitch }; }, target.id)));
for (let k = 0; k < 6 && hit.alive; k++) {
  await aimAt();
  await page.evaluate(() => { for (let i = 0; i < 12; i++) window.__cs.step(); });
  hit = await page.evaluate((id) => { const e = window.__cs.sim.getPlayer(id); return { hp: e.health, alive: e.alive, mag: window.__cs.me.weapons[1].mag }; }, target.id);
}
await mouse('mouseup');
await page.waitForTimeout(150);
const feed = await page.locator('.kf').allTextContents();
check('sustained fire kills the enemy and it appears in the kill feed', !hit.alive && feed.some((t) => t.includes(target.name)), feed.join(' / '));
await page.screenshot({ path: `${out}/06-combat.png` });

// Reload.
await page.keyboard.press('KeyR');
await page.evaluate(() => window.__cs.step());
const reloading = await page.evaluate(() => window.__cs.sim.isReloading(window.__cs.me));
check('R starts a reload', reloading);
const reloaded = await page.evaluate(() => { const s = window.__cs; for (let i = 0; i < 160; i++) s.step(); return s.me.weapons[1].mag; });
check('reload refills the magazine', reloaded === 30, `mag=${reloaded}`);

await page.evaluate(() => { window.__cs.paused = false; });

// Scoreboard.
await page.keyboard.down('Tab');
await page.waitForTimeout(350);
const sb = await page.locator('.scoreboard').isVisible();
await page.screenshot({ path: `${out}/07-scoreboard.png` });
await page.keyboard.up('Tab');
check('Tab shows the scoreboard', sb);

// Pause / resume.
await page.evaluate(() => window.__cs.onLockChange(false));
await page.waitForTimeout(100);
const paused = await page.evaluate(() => window.__cs.isPaused);
const pauseMenu = await page.locator('text=Paused').isVisible();
await page.screenshot({ path: `${out}/08-pause.png` });
const tPaused = await page.evaluate(() => window.__cs.sim.time);
await page.waitForTimeout(500);
const tPaused2 = await page.evaluate(() => window.__cs.sim.time);
check('losing mouse capture pauses the game and shows the pause menu', paused && pauseMenu && tPaused === tPaused2);
await page.evaluate(() => window.__cs.onLockChange(true));
await page.waitForTimeout(100);
check('resume hides the pause menu', !(await page.locator('text=Paused').isVisible()));

// Fast-forward the match: let bots play until the match ends (local player idle).
const ff = await page.evaluate(() => {
  const s = window.__cs;
  let rounds = 0, kills = 0;
  for (let i = 0; i < 60 * 60 * 25 && s.sim.phase !== 'matchEnd'; i++) {
    s.step();
    for (const e of s.sim.events) { if (e.type === 'roundEnd') rounds++; if (e.type === 'kill') kills++; }
  }
  return { phase: s.sim.phase, rounds, kills, score: s.sim.score, round: s.sim.round };
});
check('a full match plays to the end without manual state edits', ff.phase === 'matchEnd', JSON.stringify(ff));
await page.waitForTimeout(3200);
const endScreen = await page.locator('text=Rematch').isVisible();
await page.screenshot({ path: `${out}/09-match-end.png` });
check('match-end screen offers a rematch', endScreen);
if (endScreen) {
  await page.click('text=Rematch');
  if (!realLock) await page.evaluate(() => window.__cs.onLockChange(true));
  await page.waitForTimeout(300);
  const rm = await page.evaluate(() => ({ phase: window.__cs.sim.phase, round: window.__cs.sim.round, score: window.__cs.sim.score }));
  check('rematch restarts at round 1 with 0:0', rm.round === 1 && rm.score.A === 0 && rm.score.D === 0, JSON.stringify(rm));
}

// Performance sample.
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(Math.round(n / 2)); }; requestAnimationFrame(f); }));
console.log(`INFO  ~${fps} fps in headless software rendering (SwiftShader, not representative of a GPU)`);

check('no console errors or page exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
