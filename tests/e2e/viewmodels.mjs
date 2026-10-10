// Renders each weapon's first-person viewmodel to a screenshot for visual review.
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = process.argv[3] ?? 'test-results';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(base + '/?debug=1');
await page.click('text=Play Solo');
await page.click('text=Start Match');
await page.waitForFunction(() => !!window.__cs);
await page.evaluate(() => { const s = window.__cs; s.input.testMode = true; s.onLockChange(true); s.paused = true; });
const PISTOLS = ['p9', 'm45', 'k57', 'hc50'];
const ALL = ['knife', ...PISTOLS, 'tp9', 'r10', 'mk5', 'u45', 'p50', 'pump12', 'auto12', 'gr3', 'fm2', 'ar7', 'k4', 'sg5', 'au3', 'kestrel', 'longbow', 'rp3', 'vg5', 'mg9'];
for (const id of process.argv[4] ? process.argv[4].split(',') : ALL) {
  await page.evaluate(([id, pistols]) => {
    const s = window.__cs;
    const slot = id === 'knife' ? 3 : pistols.includes(id) ? 2 : 1;
    s.me.weapons[slot] = { id, mag: 10, reserve: 10 };
    s.sim.selectSlot(s.me, slot, true);
    s.drawTime = 5;
    for (let i = 0; i < 40; i++) s.step();
  }, [id, PISTOLS]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/vm-${id}.png` });
}
await browser.close();
