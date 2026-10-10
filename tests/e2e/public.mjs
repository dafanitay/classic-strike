// Production-safe checks against a deployed URL. Uses no debug hooks, so it
// works with CS_DEBUG off (and verifies that it IS off).
//   node tests/e2e/public.mjs https://<app>.fly.dev [outDir]
// What this proves: the public site serves the game, solo mode starts and
// runs, and two independent browser sessions can create/join a room over the
// internet and see each other move. Both browsers run on the same machine
// (e.g. a CI runner) — this is NOT a test between two separate computers.
import { chromium } from 'playwright';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const out = process.argv[3] ?? 'test-results';
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node tests/e2e/public.mjs <base url>');
  process.exit(2);
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// --- plain HTTP checks
const health = await fetch(`${base}/healthz`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
check('GET /healthz answers ok', health.ok === true, JSON.stringify(health));
const page0 = await fetch(`${base}/`);
const html = await page0.text();
check('GET / serves the game page over HTTPS', page0.ok && html.includes('<title>Classic Strike</title>') && base.startsWith('https://'), `${page0.status}`);
check('security headers present', !!page0.headers.get('content-security-policy') && page0.headers.get('x-frame-options') === 'DENY');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const newPage = async (who) => {
  // Small window + low graphics: CI runners render in software.
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'low' })); } catch {}
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
  return p;
};

// --- solo
const S = await newPage('solo');
await S.goto(`${base}/?debug=1`);
await S.click('text=Play Solo');
await S.click('text=Start Match');
await S.waitForFunction(() => !!window.__cs, null, { timeout: 15000 });
if (await S.locator('.clickplay').isVisible()) await S.click('.clickplay');
const solo = await S.evaluate(() => {
  const s = window.__cs;
  s.paused = true;
  for (let i = 0; i < 60 * 30; i++) s.step(); // 30 s of game time with bots
  return { players: s.sim.players.length, bots: s.sim.players.filter((p) => p.isBot).length, round: s.sim.round, phase: s.sim.phase };
});
check('solo match starts with bots and rounds progress', solo.bots >= 1 && solo.round >= 1, JSON.stringify(solo));
await S.screenshot({ path: `${out}/public-solo.png` });
// Close it: three software-rendered game pages at once starve a CI runner.
await S.context().close();

// --- online: two independent browser sessions through the public server
const A = await newPage('A');
const B = await newPage('B');
await A.goto(`${base}/?debug=1`);
await A.click('text=Play With a Friend');
await A.waitForSelector('text=Game server online', { timeout: 15000 });
await A.click('text=Create Room');
await A.waitForSelector('text=Invitation link', { timeout: 15000 });
const link = await A.locator('.row', { hasText: 'Invitation link' }).locator('input').inputValue();
check('room created with a public invitation link', link.startsWith(base) && /room=[A-Z2-9]{5}$/.test(link), link);
await B.goto(`${link}&debug=1`);
await B.waitForSelector('text=Invitation link', { timeout: 15000 });
await A.waitForSelector('text=Both players are here', { timeout: 15000 });
check('second browser joins through the link', true);
for (const P of [A, B]) {
  await P.click('text=Enter Match');
  await P.waitForFunction(() => !!window.__cs, null, { timeout: 15000 });
  await P.waitForTimeout(300);
  if (await P.locator('.clickplay').isVisible()) await P.click('.clickplay');
}
// Headless browsers may refuse real mouse capture; fall back to the client's
// test input mode (client-side only — the server still validates everything).
for (const P of [A, B]) {
  await P.evaluate(() => {
    if (document.pointerLockElement?.id !== 'game') {
      window.__cs.input.testMode = true;
      window.__cs.onLockChange(true);
    }
  });
}
await A.waitForFunction(() => window.__cs.sim.players.length === 2 && window.__cs.sim.phase === 'live', null, { timeout: 20000 });
const bId = await B.evaluate(() => window.__cs.me.id);
const before = await A.evaluate((id) => ({ ...window.__cs.sim.getPlayer(id).body.pos }), bId);
// Hold W until B has really moved on its own screen (software rendering can
// make the client loop slow), then check that A sees it.
await B.keyboard.down('KeyW');
await B.waitForFunction((p0) => { const p = window.__cs.me.body.pos; return Math.hypot(p.x - p0.x, p.z - p0.z) > 3; }, before, { timeout: 15000 }).catch(() => {});
await B.keyboard.up('KeyW');
let moved = 0;
for (let i = 0; i < 50 && moved < 1; i++) {
  await A.waitForTimeout(200);
  const after = await A.evaluate((id) => ({ ...window.__cs.sim.getPlayer(id).body.pos }), bId);
  moved = Math.hypot(after.x - before.x, after.z - before.z);
}
check('player B’s movement reaches player A through the server', moved > 1, `${moved.toFixed(2)} m`);
const rtt = await A.evaluate(() => Math.round(window.__cs.net.rtt * 1000));
console.log(`INFO  measured round trip from the test machine: ~${rtt} ms`);

// The test-only teleport hook must be disabled in production.
const posB = await B.evaluate(() => ({ ...window.__cs.me.body.pos }));
await B.evaluate(() => window.__cs.net.send({ t: 'debug', op: 'teleport', x: 13, z: 7, yaw: 0 }));
await B.waitForTimeout(800);
const posB2 = await B.evaluate(() => ({ ...window.__cs.me.body.pos }));
check('debug hooks are OFF on the public server', Math.hypot(posB2.x - 13, posB2.z - 7) > 1 || Math.hypot(posB2.x - posB.x, posB2.z - posB.z) < 0.5);
await A.screenshot({ path: `${out}/public-online-A.png` });

check('no page errors in any browser', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
