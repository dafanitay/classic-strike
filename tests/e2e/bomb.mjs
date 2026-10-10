// Browser checks for bomb defusal through the full client: planting with the
// E key, the HUD (hint, progress bar, bomb tag, planted timer), the bomb in
// the world, the explosion, and defusing as a Defender with and without a
// kit. Bots are switched off after the round starts so the checks are
// deterministic. Run against `npm run dev`:
//   node tests/e2e/bomb.mjs http://127.0.0.1:5180 [outDir]
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

async function startSolo(team) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('classic-strike.settings.v1', JSON.stringify({ quality: 'medium' })));
  await page.goto(base + '/?debug=1');
  await page.click('text=Play Solo');
  await page.click(`.seg button:has-text("${team}")`);
  await page.click('text=Start Match');
  await page.waitForFunction(() => !!window.__cs);
  await page.evaluate(() => {
    const s = window.__cs;
    s.input.testMode = true;
    s.onLockChange(true);
    s.paused = true;
    for (let i = 0; i < 300; i++) s.step(); // past the freeze, round live
    // No bots from here on: everyone else stands still where they are.
    s.bots = null;
    for (const p of s.sim.players) if (p !== s.me) p.cmd = { forward: 0, side: 0, jump: false, crouch: false, walk: false, yaw: p.yaw, pitch: 0, fire: false, altFire: false, reload: false, slot: 0, use: false };
  });
  return page;
}

const steps = (page, n) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__cs.step(); }, n);
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', sel);
const hidden = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.classList.contains('hidden') ?? true, sel);
/** The HUD updates on the next rendered frame (slow with software GL): wait for it. */
const waitHud = (page, sel, re) =>
  page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent ?? ''), [sel, re.source], { timeout: 5000 }).then(() => true, () => false);

// ---------------------------------------------------------------- planting
{
  const page = await startSolo('Attackers');
  await page.evaluate(() => {
    const s = window.__cs;
    s.sim.bomb.carrier = s.me.id; // make sure we carry it
    const c = s.sim.map.cellCenter(31, 5); // inside bombsite A, on the platform
    s.me.body.pos = { x: c.x, y: c.y + 0.02, z: c.z };
    s.me.body.vel = { x: 0, y: 0, z: 0 };
    s.input.yaw = Math.PI / 2;
    s.input.pitch = -0.5;
  });
  await steps(page, 10);
  await waitHud(page, '.hud-hint', /Hold E to plant/);
  check('carrying the bomb shows the BOMB tag and the plant hint',
    (await text(page, '.hud-bomb')) === 'BOMB' && /Hold E to plant/.test(await text(page, '.hud-hint')),
    `${await text(page, '.hud-bomb')} / ${await text(page, '.hud-hint')}`);
  const start = await page.evaluate(() => ({ ...window.__cs.me.body.pos }));
  await page.evaluate(() => { const s = window.__cs; s.input.setKey('KeyE', true); s.input.setKey('KeyW', true); });
  await steps(page, 100); // ~1.7 s of the 3.2 s
  await waitHud(page, '.hud-progress .label', /Planting/);
  const mid = await page.evaluate(() => ({ pos: window.__cs.me.body.pos, w: document.querySelector('.hud-progress .fill').style.width }));
  check('holding E shows the planting progress bar', !(await hidden(page, '.hud-progress')) && /Planting/.test(await text(page, '.hud-progress .label')), mid.w);
  check('the planter stands still even with W held', Math.hypot(mid.pos.x - start.x, mid.pos.z - start.z) < 1e-6);
  await page.screenshot({ path: `${out}/bomb-01-planting.png` });
  await steps(page, 100);
  await page.evaluate(() => { const s = window.__cs; s.input.setKey('KeyE', false); s.input.setKey('KeyW', false); });
  await steps(page, 3);
  await waitHud(page, '.hud-top .timer', /BOMB A/);
  const planted = await page.evaluate(() => ({ state: window.__cs.sim.bomb.state, site: window.__cs.sim.bomb.site, visible: window.__cs.renderer.bomb.group.visible }));
  check('after 3.2 s the bomb is planted at A and drawn in the world', planted.state === 'planted' && planted.site === 'A' && planted.visible, JSON.stringify(planted));
  check('the round clock becomes the bomb indicator', (await text(page, '.hud-top .timer')) === 'BOMB A', await text(page, '.hud-top .timer'));
  // Step back and look at it.
  await page.evaluate(() => {
    const s = window.__cs;
    const b = s.sim.bomb.pos;
    s.me.body.pos = { x: b.x - 1.6, y: b.y + 0.02, z: b.z + 1.6 };
    s.input.yaw = Math.atan2(-(b.x - s.me.body.pos.x), -(b.z - s.me.body.pos.z));
    s.input.pitch = -0.6;
  });
  await steps(page, 2);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/bomb-02-planted.png` });
  // Let the fuse run out (nobody defuses: bots are off).
  const end = await page.evaluate(() => {
    const s = window.__cs;
    let ended = null;
    const orig = s.handleEvents.bind(s);
    s.handleEvents = (evs) => { for (const e of evs) if (e.type === 'roundEnd') ended = e; orig(evs); };
    for (let i = 0; i < 60 * 41 && !ended; i++) s.step();
    return { ended, state: s.sim.bomb.state, alive: s.me.alive };
  });
  check('after 40 s it explodes: Attackers win, "Target destroyed"', end.state === 'exploded' && end.ended?.winner === 'A' && end.ended?.reason === 'Target destroyed', JSON.stringify(end));
  check('standing 2 m from it is fatal', end.alive === false);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/bomb-03-exploded.png` });
  await page.close();
}

// ---------------------------------------------------------------- defusing
for (const kit of [false, true]) {
  const page = await startSolo('Defenders');
  await page.evaluate((kit) => {
    const s = window.__cs;
    const c = s.sim.map.cellCenter(23, 24); // B site
    s.sim.bomb = { state: 'planted', carrier: 0, pos: { x: c.x, y: c.y, z: c.z }, site: 'B', plantedAt: s.sim.time, explodeAt: s.sim.time + 40, defuser: 0 };
    s.sim.phaseEnd = s.sim.bomb.explodeAt;
    s.me.kit = kit;
    s.me.body.pos = { x: c.x + 0.8, y: c.y + 0.02, z: c.z };
    s.me.body.vel = { x: 0, y: 0, z: 0 };
    s.input.yaw = Math.PI / 2;
    s.input.pitch = -0.7;
  }, kit);
  await steps(page, 5);
  await waitHud(page, '.hud-hint', /Hold E to defuse/);
  check(`${kit ? 'with a kit' : 'no kit'}: standing at the bomb shows the defuse hint`, /Hold E to defuse/.test(await text(page, '.hud-hint')), await text(page, '.hud-hint'));
  await page.evaluate(() => window.__cs.input.setKey('KeyE', true));
  const need = kit ? 5 : 10;
  await steps(page, Math.round((need - 0.3) * 60));
  await waitHud(page, '.hud-progress .label', /Defusing/);
  const before = await page.evaluate(() => window.__cs.sim.bomb.state);
  check(`${kit ? 'kit' : 'no kit'}: still defusing just before ${need} s`, before === 'planted' && /Defusing/.test(await text(page, '.hud-progress .label')), `${before}, ${await text(page, '.hud-progress .label')}`);
  if (!kit) await page.screenshot({ path: `${out}/bomb-04-defusing.png` });
  await steps(page, 30);
  await waitHud(page, '.hud-center .small', /defused/);
  const after = await page.evaluate(() => ({ state: window.__cs.sim.bomb.state, phase: window.__cs.sim.phase, msg: document.querySelector('.hud-center .small')?.textContent }));
  check(`${kit ? 'kit' : 'no kit'}: defused at ${need} s, Defenders win`, after.state === 'defused' && after.phase === 'roundEnd' && /defused/.test(after.msg ?? ''), JSON.stringify(after));
  await page.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
