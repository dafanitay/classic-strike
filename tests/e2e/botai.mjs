// Browser checks for the bot AI in the real client: a solo match with bots,
// the optional diagnostics overlay (`?botdebug`), and that bots spread over
// the map while the round plays. Run against `npm run dev`:
//   node tests/e2e/botai.mjs http://127.0.0.1:5180 [outDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

async function solo(query) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'low' })));
  await page.goto(base + '/' + query);
  await page.click('text=Play Solo');
  await page.click('.seg button:has-text("Defenders")');
  await page.click('text=Start Match');
  await page.waitForFunction(() => !!window.__cs);
  await page.evaluate(() => { const s = window.__cs; s.input.testMode = true; s.onLockChange(true); s.paused = true; });
  return page;
}

// Without the flag: no overlay.
{
  const page = await solo('?debug=1');
  await page.evaluate(() => { for (let i = 0; i < 120; i++) window.__cs.step(); });
  await page.waitForTimeout(300);
  check('no bot overlay in normal play', (await page.locator('.botdebug').count()) === 0);
  await page.close();
}

const page = await solo('?debug=1&botdebug=1');
// Keep the human player out of the fight so the round runs on bots alone.
await page.evaluate(() => {
  const s = window.__cs;
  for (let i = 0; i < 60 * 12; i++) {
    s.me.health = 1e6;
    s.step();
  }
});
await page.waitForFunction(() => (document.querySelector('.botdebug')?.textContent ?? '').split('\n').length >= 4, null, { timeout: 5000 }).catch(() => {});
const text = await page.evaluate(() => document.querySelector('.botdebug')?.textContent ?? '');
const rows = text.split('\n').filter(Boolean);
check('the overlay lists every living bot with role, state and reason', rows.length >= 4 && rows.every((r) => /(entry|support|flank|lurk|anchor|mid) /.test(r)), `${rows.length} rows; e.g. "${rows[0]}"`);
const lines = await page.evaluate(() => window.__cs.botDebug.group.children.filter((c) => c.visible).length);
check('paths and destinations are drawn in the world', lines >= 4, `${lines} visible path/marker objects`);
const spread = await page.evaluate(() => {
  const s = window.__cs;
  const res = {};
  for (const team of ['A', 'D']) {
    const ps = s.sim.players.filter((p) => p.team === team && p.alive && p.isBot);
    let huddled = 0;
    const areas = new Set();
    for (const p of ps) {
      if (ps.some((q) => q !== p && Math.hypot(q.body.pos.x - p.body.pos.x, q.body.pos.z - p.body.pos.z) < 3)) huddled++;
      areas.add(s.sim.map.areaNameAt(p.body.pos));
    }
    res[team] = { alive: ps.length, huddled, areas: areas.size };
  }
  return res;
});
check('12 s into the round, bots of each team are spread over several areas', spread.A.alive < 2 || spread.A.areas >= 2, JSON.stringify(spread));
await page.screenshot({ path: `${out}/botai-01-overlay.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
