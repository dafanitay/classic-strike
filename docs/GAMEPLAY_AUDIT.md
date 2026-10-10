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

## M3: what changed for the bots (implemented and tested)

Architecture (`src/shared/tactics.ts`, `src/shared/bot.ts`):

- **Tactical map, derived from the geometry** (nothing hand-placed; 55 ms
  once per map):
  - Alternative routes from each spawn to each site: A* is re-run while
    penalising corridors already used, and near-duplicates are dropped. On
    Depot this gives Short A (Catwalk), Mid Doors and Long A to A; Lower
    Tunnel, Outside Tunnels and Mid Doors to B.
  - Scored positions: site holds facing the Attackers' entries, mid control,
    lurk spots, post-plant spots. Scores combine cover from neighbouring
    walls and crates with line of sight to what should be watched.
- **Team plans:**
  - Attackers get roles (entry, flank, support, lurk) matched to personality,
    each with its own route and a staging point spaced along it. They wait
    outside the site and push together when half have staged, when a fight
    starts at the site, or when time runs short. The lurker holds the other
    site's approach. The bomb carrier never takes the entry or lurk role.
  - Defenders split into anchors at A, anchors at B and mid. Each picks a
    position away from teammates' claims and areas, and repositions on its
    own timer.
- **Spreading.** Destinations penalise teammates' positions, destinations and
  areas. A crowding check (two bots within 2.5 m for 1.5 s, outside combat)
  moves the lower-priority bot, with the reason recorded. Local avoidance
  stops bots walking through each other.
- **Information.** Each bot has its own memory: what it saw, what it heard,
  what it was told. A sighting gets one responder and a teammate's death
  gets two, chosen by distance and role; the rest only turn to look.
  Defenders rotate when a site is hit: the mid player first, then an anchor
  from the other site once contacts repeat (at most every 8 s per site).
- **Combat.**
  - Closing distance follows the nav grid, which fixes D3.
  - Strafing probes for walls before moving.
  - A bot retreats to cover when outnumbered, hurt or reloading, and cautious
    bots reposition after a fight.
  - Preferred range depends on the weapon class and the bot's personality.
- **Recovery in every state.** No progress for 0.5 s: sidestep toward the
  open side and hop. Again: re-plan the path. A third time: pick a new
  destination.
- **Variation without randomness for its own sake.** Each bot has a
  personality (aggression, caution, flank tendency, patience, reaction,
  decision interval) that biases choices. Decisions run every 0.35–0.8 s per
  bot and are staggered, not every frame.
- **Diagnostics.** `?botdebug` in the URL (solo) shows role, state,
  destination, stuck time and reason per bot, and draws paths in the world.
  It is off unless requested. `BotDirector.debugState()` exposes the same
  data for tests.

Results (`docs/measurements/bots-after.txt`, same harness and window, 8
seeds each):

| Attackers, 5–25 s into a round | easy before → after | normal | hard |
|---|---|---|---|
| teammate within 3 m | 84% → 29% | 40% → 10% | 54% → 10% |
| nearest teammate | 1.8 → 8.4 m | 5.9 → 12.3 m | 5.1 → 12.7 m |
| map areas occupied | 1.39 → 2.28 | 1.98 → 2.75 | 2.09 → 3.12 |
| biggest group | 3.7 → 1.9 | 2.4 → 1.4 | 2.6 → 1.5 |
| lanes used per round | 1.51 → 2.05 | 1.59 → 2.05 | 1.41 → 2.16 |
| stuck, bot-seconds per match | 153 → 10 | 46 → 13 | 6.7 → 9.6 |

- **Defenders:** within 3 m 46% → 12% (easy) and 31% → 11% (normal).
- **Round length:** 18 s → 34 s at normal; Attackers now stage before
  pushing.
- **Round outcomes:** Defenders win 30/58 rounds (easy), 31/58 (normal) and
  7/47 (hard), against 22/58, 27/60 and 7/47 before. The first version
  without rotations dropped Defender wins to 15/52 at normal, which is why
  rotations were added.
- **Cost:** about 30 µs of AI per tick for 10 bots (headless Node).

Tests:
- `src/shared/botAI.test.ts`, 12 tests covering A–G. Run against the old AI,
  8 fail: B, C, F, F2, G 8v8 and E fail on behaviour; A and D can't run
  because the old AI had no `debugState()`.
- `tests/e2e/botai.mjs`, 5 checks: the overlay is shown only on request,
  and bots spread out in a real browser match.

Remaining:
- Hard is still Attacker-sided (7/47), as it was before this work.
- Stuck time at hard is slightly higher (6.7 → 9.6 bot-seconds per match,
  about one second per round across 10 bots).
- With no player collision, crossing paths still overlap visually for a
  moment.
- Nobody has played against these bots yet. Whether they *feel* human is a
  manual test still to do.
