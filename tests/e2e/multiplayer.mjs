// Two independent browser sessions play an online match through the real
// server. Needs the built server running with CS_DEBUG=1 (for the teleport
// hook used to line players up deterministically):
//   npm run build && PORT=8090 CS_DEBUG=1 npm start
//   node tests/e2e/multiplayer.mjs http://127.0.0.1:8090
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8090';
const out = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
// Two separate browser contexts = two independent sessions (no shared storage).
const ctxA = await browser.newContext({ viewport: { width: 960, height: 540 } });
const ctxB = await browser.newContext({ viewport: { width: 960, height: 540 } });
const A = await ctxA.newPage();
let B = await ctxB.newPage();
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
};
watch(A, 'A');
watch(B, 'B');

// --- A creates a room
await A.goto(base + '/?debug=1');
await A.click('text=Play With a Friend');
await A.waitForSelector('text=Game server online', { timeout: 5000 });
check('friend screen reports the server online', true);
await A.locator('.row', { hasText: 'Your name' }).locator('input').fill('Alice');
await A.click('text=Create Room');
await A.waitForSelector('text=Invitation link');
const link = await A.locator('.row', { hasText: 'Invitation link' }).locator('input').inputValue();
const code = link.split('room=')[1];
check('creating a room shows a room code and an invitation link', /^[A-Z2-9]{5}$/.test(code), link);
await A.screenshot({ path: `${out}/mp-01-lobby-host.png` });

// --- B opens the invitation link
await B.goto(link.replace(/^https?:\/\/[^/]+/, base) + '&debug=1');
await B.waitForSelector('text=Invitation link', { timeout: 8000 });
check('opening the invitation link joins the room', true);
await A.waitForSelector('text=Both players are here', { timeout: 5000 });
const rosterA = await A.locator('.row', { hasText: 'Players' }).innerText();
check('host lobby lists both players on opposite teams', /Alice.*Attackers|Alice.*Defenders/s.test(rosterA) && rosterA.includes('Player'), rosterA.replace(/\n/g, ' | '));
await B.screenshot({ path: `${out}/mp-02-lobby-guest.png` });

// --- both enter the match
for (const P of [A, B]) {
  await P.click('text=Enter Match');
  await P.waitForFunction(() => !!window.__cs);
  await P.waitForTimeout(300);
  if (await P.locator('.clickplay').isVisible()) await P.click('.clickplay');
}
await A.waitForTimeout(500);
const locked = await Promise.all([A, B].map((P) => P.evaluate(() => document.pointerLockElement?.id === 'game')));
check('both players capture the mouse', locked.every(Boolean), JSON.stringify(locked));
for (const P of [A, B]) if (!(await P.evaluate(() => document.pointerLockElement?.id === 'game'))) await P.evaluate(() => { window.__cs.input.testMode = true; window.__cs.onLockChange(true); });

const state = (P) => P.evaluate(() => {
  const s = window.__cs;
  return {
    me: s.me.id, team: s.me.team, phase: s.sim.phase, round: s.sim.round, score: s.sim.score,
    players: s.sim.players.map((p) => ({ id: p.id, name: p.name, team: p.team, alive: p.alive, hp: p.health, pos: p.body.pos })),
  };
});
await A.waitForFunction(() => window.__cs.sim.players.length === 2 && window.__cs.sim.round >= 1, null, { timeout: 8000 });
const sA = await state(A);
const sB = await state(B);
check('both clients see the same two players and round', sA.players.length === 2 && sB.players.length === 2 && sA.round === sB.round, `A sees ${sA.players.map((p) => p.name + ':' + p.team).join(',')}; round ${sA.round}/${sB.round}`);
const aId = sA.me, bId = sB.me;
await A.screenshot({ path: `${out}/mp-03-in-game-A.png` });

// --- movement sync: B walks forward; A must see it move
await A.waitForFunction(() => window.__cs.sim.phase === 'live', null, { timeout: 8000 });
const bStartOnA = (await state(A)).players.find((p) => p.id === bId).pos;
await B.keyboard.down('KeyW');
await B.waitForTimeout(1500);
await B.keyboard.up('KeyW');
await A.waitForTimeout(400);
// Remote positions are applied when a frame is drawn (only a few fps under
// software rendering here), so poll until the two views converge.
let bEndOnA, bEndOnB, agree = Infinity;
for (let i = 0; i < 20 && agree > 0.05; i++) {
  bEndOnA = (await state(A)).players.find((p) => p.id === bId).pos;
  bEndOnB = (await state(B)).players.find((p) => p.id === bId).pos;
  agree = Math.hypot(bEndOnA.x - bEndOnB.x, bEndOnA.z - bEndOnB.z);
  if (agree > 0.05) await A.waitForTimeout(150);
}
const movedSeenByA = Math.hypot(bEndOnA.x - bStartOnA.x, bEndOnA.z - bStartOnA.z);
check('a player’s movement is seen by the other player', movedSeenByA > 1, `A saw B move ${movedSeenByA.toFixed(2)} m`);
check('both clients agree on that position once settled', agree < 0.3, `difference ${agree.toFixed(3)} m`);

// --- combat: line up in Long A (debug teleport, test server only), A shoots B
await A.evaluate(() => window.__cs.net.send({ t: 'debug', op: 'teleport', x: 13, z: 7, yaw: -Math.PI / 2 }));
await B.evaluate(() => window.__cs.net.send({ t: 'debug', op: 'teleport', x: 21, z: 7, yaw: Math.PI / 2 }));
await A.waitForTimeout(400);
await A.evaluate(() => { const s = window.__cs; s.input.yaw = -Math.PI / 2; s.input.pitch = -0.05; });
const dom = (P, type) => P.evaluate((t) => document.dispatchEvent(new MouseEvent(t, { button: 0 })), type);
let bHp = 100;
// Pistol: 15-round magazine, so allow for a reload between bursts.
for (let i = 0; i < 60 && bHp > 0; i++) {
  await dom(A, 'mousedown');
  await A.waitForTimeout(60);
  await dom(A, 'mouseup');
  await A.waitForTimeout(140);
  bHp = (await state(B)).players.find((p) => p.id === bId).hp;
}
check('shots damage the other player (server-validated, seen by the victim)', bHp < 100, `B hp on B's screen: ${bHp}`);
// Each client learns of the death from its own next snapshot (<= 50 ms
// apart), so wait for it rather than sampling once.
const aSeesDead = await A.waitForFunction((id) => window.__cs.sim.getPlayer(id)?.alive === false, bId, { timeout: 2000 }).then(() => true, () => false);
check('the kill is agreed by both clients', bHp === 0 && aSeesDead, `B dead on A's screen: ${aSeesDead}`);
await B.waitForFunction(() => [...document.querySelectorAll('.kf')].some((e) => e.textContent.includes('Alice')), null, { timeout: 2000 }).catch(() => {});
const feedB = await B.locator('.kf').allTextContents();
check('the victim sees the kill in the kill feed', feedB.some((t) => t.includes('Alice')), feedB.join(' / '));
await B.screenshot({ path: `${out}/mp-04-victim-view.png` });

// --- round transition
await A.waitForFunction((r) => window.__cs.sim.round > r, sA.round, { timeout: 12000 });
const sA2 = await state(A);
const sB2 = await state(B);
const aTeam = sA2.players.find((p) => p.id === aId).team;
check('the round ends, the winner scores, and a new round starts for both', sA2.score[aTeam] === 1 && sB2.score[aTeam] === 1 && sA2.round === sB2.round, `score ${JSON.stringify(sA2.score)} round ${sA2.round}`);
check('the dead player respawns for the next round', sB2.players.find((p) => p.id === bId).alive);

// --- bomb: the Attacker plants online; the server decides, both clients see it
const atkPage = aTeam === 'A' ? A : B;
const defPage = atkPage === A ? B : A;
await atkPage.waitForFunction(() => window.__cs.sim.phase === 'live', null, { timeout: 12000 });
const carrierOk = await atkPage.evaluate(() => window.__cs.sim.bomb.state === 'carried' && window.__cs.sim.bomb.carrier === window.__cs.me.id);
check('the (only) Attacker starts the round with the bomb', carrierOk);
await atkPage.evaluate(() => window.__cs.net.send({ t: 'debug', op: 'teleport', x: 63, z: 11, yaw: Math.PI / 2 })); // bombsite A
await atkPage.waitForTimeout(400);
await atkPage.evaluate(() => window.__cs.input.setKey('KeyE', true));
const plantedBoth = await Promise.all([atkPage, defPage].map((P) => P.waitForFunction(() => window.__cs.sim.bomb.state === 'planted', null, { timeout: 8000 }).then(() => true, () => false)));
await atkPage.evaluate(() => window.__cs.input.setKey('KeyE', false));
check('holding E in site A plants the bomb, seen by both clients', plantedBoth.every(Boolean), JSON.stringify(plantedBoth));
const defTimer = await defPage.waitForFunction(() => document.querySelector('.hud-top .timer')?.textContent === 'BOMB A', null, { timeout: 3000 }).then(() => true, () => false);
check('the Defender\'s HUD shows the bomb at A', defTimer);
await defPage.screenshot({ path: `${out}/mp-05-defender-bomb-planted.png` });

// --- disconnect + reconnect (B reloads its tab: same session storage, same token)
await B.reload();
await A.waitForFunction(() => [...document.querySelectorAll('.kf')].some((e) => /disconnected|reconnected/.test(e.textContent)), null, { timeout: 10000 }).then(() => check('host is told when the friend drops / comes back', true)).catch(() => check('host is told when the friend drops / comes back', false));
await B.waitForSelector('text=Invitation link', { timeout: 8000 });
await B.click('text=Enter Match');
await B.waitForFunction(() => !!window.__cs && window.__cs.sim.players.length === 2, null, { timeout: 8000 });
const sB3 = await state(B);
const sA3 = await state(A);
check('reconnecting restores the same player and the match score', sB3.me === bId && sB3.score[aTeam] >= 1, `id ${sB3.me} (was ${bId}), score ${JSON.stringify(sB3.score)}`);
check('host sees the friend back in the match', sA3.players.some((p) => p.id === bId));

check('no console errors or page exceptions in either browser', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
