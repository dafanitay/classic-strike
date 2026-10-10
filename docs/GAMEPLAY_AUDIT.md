# Gameplay quality audit (bots focus)

_Branch `overhaul/m4-bots`, based on `overhaul/m3-bomb` (`c9a73b2`, not yet
merged). Audited 2026-10-10. Classification: **PASS** implemented and
verified · **DEFECT** observable problem · **RISK** plausible weakness ·
**NOT IMPLEMENTED** absent · **UNVERIFIED** not enough evidence._

## Baseline

- `npm test`: 77/77 (8 files). Build passes. The "26 tests" in the original
  brief was the M1 baseline; the count grew with each milestone since.
- Local browser suites on the bomb branch: smoke 21/21, feedback 6/6,
  elevation 5/5, bomb 14/14, two-browser online (local server) 20/20.
- Bot metrics: `scripts/bot-metrics.ts` and `docs/measurements/bots-before.txt`.

## Subsystems

| Subsystem | Status | Evidence |
|---|---|---|
| Movement / physics | PASS | Fixed 60 Hz tick, independent of frame rate (`session.ts` accumulator, max 8 steps per frame); unit tests for acceleration, friction, jumping, steps and stairs; wish direction normalised, so diagonals aren't faster |
| Mouse / camera | PASS (code) · UNVERIFIED (feel) | Raw pointer-lock deltas accumulated per event; never tested by a human on real hardware |
| Shooting / hit registration | PASS | Hitscan; the server is the authority online, with lag compensation; the tracer is drawn to the same `trace().end` the damage uses; unit and server tests |
| Weapons / ammo / reload | PASS | Data table; `take = min(need, reserve)`; no firing while reloading; switching cancels a reload (classic behaviour); recoil tests |
| Collision / map geometry | PASS | AABB world, step-up, ground snap, fuzz-reviewed in the map pass; 0 ticks of bots off the map in 24 matches |
| Spawns | PASS | 10 per team on open flat floor; spawns on stairs are rejected at map build |
| Player–player collision | NOT IMPLEMENTED | Bodies pass through each other (roadmap item 5); clustered bots therefore overlap visually |
| Round lifecycle / win conditions / bomb | PASS | Bomb and bot tests; reviewed twice |
| Online bots | NOT IMPLEMENTED | Rooms hold 2 humans and run no bots (`server/room.ts`), so there's no question of which side controls a bot |
| Bot perception | PASS with a RISK | View cone, line-of-sight test, hearing by distance, reaction delay. RISK: any sighting goes to `plans[team].intel` and every teammate within 45 m switches its goal to it (see D2) |
| Bot navigation | DEFECT (D1, D2) | Below |
| Bot combat movement | DEFECT (D3) | Below |
| Bot reloading | RISK | A bot reloads only when its magazine is empty, never topping up between fights (P3) |
| Rendering performance | UNVERIFIED | Never measured on a real GPU; headless SwiftShader numbers (5–13 fps) are not representative |
| Memory over many rounds | UNVERIFIED | To be measured in the browser (M5) |
| AI cost | PASS | 8 headless 5v5 matches (~60 rounds) simulate in 1.8–2.9 s in Node, so the AI is a negligible share of a 16 ms frame |
| Security (network) | PASS | Strict message parsing, 4 KB maximum payload, per-socket rate limit, `CS_DEBUG` checked off in production by the public checks |

## Confirmed defects (ranked)

### D1 (P2): a whole team walks one route to one spot

- **Symptom.** In the first 25 s of a round, 5 attacker bots occupy 1.5–2.0
  map areas on average and use 1.4–1.6 of Depot's 5 lanes per round. On easy,
  80% of the time a bot has a teammate within 3 m, and the biggest group
  averages 3.8 of 5 (`docs/measurements/bots-before.txt`).
- **Cause** (`src/shared/bot.ts`):
  - **One site for the team.** `resetRound` picks one site (`plans.A.site`)
    for the whole team, and `planObjective` sends every Attacker to
    `randomCellIn(that site)`.
  - **One route.** A* from the same spawn to cells a few metres apart returns
    the same shortest route. A trace of round 1 for 3 seeds shows all 5
    attackers' paths through B Tunnels, with goals 1–4 cells apart.
  - **Synchronised timing.** Every bot gets its goal on the same tick at the
    end of the freeze.
  - **No knowledge of teammates.** Nothing in goal selection considers where
    teammates are or are going.
- **Fix.** Per-bot roles and routes, destination assignment that penalises
  overlap, staggered decision times (M3).
- **Test.** The bot spatial tests (A–D) in `src/shared/botAI.test.ts`.

### D2 (P2): every sighting pulls the whole team to one point

- **Symptom.** 12–21 goal changes per round in round 1, all to the same
  "intel" position.
- **Cause.** `perceive()` writes `plans[team].intel`. `planObjective` then
  sends every Attacker within 45 m there (and 2% of Defenders per tick).
  `kill` events do the same with the death position.
- **Fix.** Intel becomes per-bot memory plus team reports that only one or
  two well-placed bots act on, according to their role (support, trade,
  flank), instead of all of them (M3).
- **Test.** Test E.

### D3 (P1): bots in combat stand pressed into crates or the pillar for minutes

- **Symptom.** Bots press movement keys without moving: 153 bot-seconds per
  match on easy, 46 on normal and 7 on hard (8 seeds each). Almost all of it
  (over 97% in seeds 5–8) happens with a target in view, at four cells either
  side of the Middle pillar and the Defender Spawn crate. In one episode a
  Defender pressed into the crate at (34,15) for over 10 s while trading
  pistol shots at 30 m.
- **Cause.** In combat, `think()` moves straight at the target
  (`moveDir = dir`) when out of range, or on easy, ignoring geometry; and
  `checkStuck()` only runs when `targetId === null`, so a bot in combat never
  hops, re-paths or sidesteps.
- **Fix.** Combat approach and repositioning go through the nav grid; progress
  monitoring applies in every mode, with a sidestep, then a re-plan, then a
  new position (M3).
- **Test.** Test F, plus stuck-seconds in the bot metrics.

## Root cause of the clustering, in one line

Every Attacker got the *same objective* (one site), the *same route* (the
deterministic shortest path from a shared spawn), at the *same moment*, and
was re-targeted to the *same point* whenever anyone saw anything. Nothing in
the AI knew where its teammates were going.
