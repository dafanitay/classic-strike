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
    penalising corridors already used, and near-duplicates are dropped.
    Cells near the enemy spawn cost extra, and a route through the enemy
    buy zone is discarded (an attack "via Mid Doors" walked through the
    Defender Spawn). On Depot this gives Short A via Catwalk (64 m) and
    Long A (78 m) to A; Lower Tunnel (56 m) and Outside Tunnels (58 m, plus
    a 62 m variant on the other side of the 3-cell-wide tunnel) to B.
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
  gets two, chosen by distance and role; the rest only turn to look. The
  same enemy seen again within 4 s (by another teammate, or re-acquired)
  sends nobody further. Defenders rotate when a site is hit: the mid player
  first, then an anchor from the other site once two *different* enemies
  are seen there within 6 s (at most every 8 s per site).
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
seeds each, after the review fixes and the map fix below):

| Attackers, 5–25 s into a round | easy before → after | normal | hard |
|---|---|---|---|
| teammate within 3 m | 84% → 15% | 40% → 8% | 54% → 11% |
| nearest teammate | 1.8 → 13.6 m | 5.9 → 14.1 m | 5.1 → 14.6 m |
| map areas occupied | 1.39 → 2.90 | 1.98 → 3.03 | 2.09 → 3.04 |
| biggest group | 3.7 → 1.5 | 2.4 → 1.3 | 2.6 → 1.4 |
| lanes used per round | 1.51 → 2.74 | 1.59 → 2.71 | 1.41 → 2.76 |
| stuck, bot-seconds per match | 153 → 9.8 | 46 → 10.7 | 6.7 → 7.9 |

- **Defenders:** within 3 m 46% → 10% (easy), 31% → 6% (normal), 21% → 6%
  (hard).
- **Round length:** 18 s → 31 s at normal; Attackers now stage before
  pushing.
- **Bomb plants** (6 matches each, `roundsToWin` 8): easy 40 → 23, normal
  7 → 26, hard 2 → 20. Easy is the one regression: the old easy bots walked
  the shortest route as one group, and the easy Defenders lost that fight.
  The bomb carrier now stages with its team like everyone else.
- **Round outcomes** (8 matches each, first to 8): Defenders win 32/89
  (easy), 34/91 (normal) and 19/83 (hard). Measured with the old AI on a
  shorter harness: 22/58, 27/60 and 7/47.
- **Cost:** about 30–60 µs of AI per tick for 10–16 bots (headless Node).
  Spot lists are built once in the `BotDirector` constructor, so the first
  round no longer pays a 17–22 ms build.

### Review fixes (independent review of the M3 diff)

- The diagnostics overlay rebuilt its line geometry only when first shown,
  so paths with more points than the first one were cut short. It now
  recreates the geometry when the point count changes, and updates at most
  every 100 ms.
- Retreat to cover had no cooldown and could flip-flop every decision. It
  now waits 4–7 s (by caution) before retreating again.
- A bot guarding the planted bomb could be pulled away to support a
  sighting. Guards are no longer eligible.
- When only lurkers were left alive, the push condition never fired. It now
  pushes when nobody else is still staging.
- A bomb carrier stuck three times while staging now pushes the site
  instead of picking another staging point.
- Staging points of teammates on the same route are now at least 3.5 m
  apart (test A failed at 2 m on one seed).

### D4 (P1, fixed): spawn-to-spawn sightline through Middle

Found while explaining why, on hard, Attackers died *inside their own spawn*
0.1–3 s into the round. The Middle pillar blocks only the z = 14 row of the
two-cell-wide Mid Doors, so the z = 15 row was a straight 60 m line from
Attacker Spawn to Defender Spawn: 176 pairs of spawn-zone cells could see
each other at eye level. Hard bots, with fast reactions, killed through it at
round start. This was not new; it predates M3.

Fix: the pillar is now two cells (`{x: 21, z: 15}` added in
`src/shared/maps/depot.ts`); Middle stays passable north and south of it.
New test in `elevation.test.ts` checks every pair of spawn-zone cells and
fails on the old map. After the fix, the hard carriers' deaths in Attacker
Spawn went from 13 to 0, and hard Defender round wins from 4/68 to 19/83 (the
cheap spawn kills had gone both ways).

Tests:
- `src/shared/botAI.test.ts`, 12 tests covering A–G (test E caught the
  "one enemy counted as two contacts" bug). Run against the old AI,
  8 fail: B, C, F, F2, G 8v8 and E fail on behaviour; A and D can't run
  because the old AI had no `debugState()`.
- `tests/e2e/botai.mjs`, 5 checks: the overlay is shown only on request,
  and bots spread out in a real browser match.

Remaining:
- Every difficulty is Attacker-sided: Defenders win 36% (easy), 37%
  (normal) and 23% (hard) of rounds. Hard was already the worst before this
  work. Tuning it needs a decision on whether Defenders should get an edge
  through AI or through the map. It isn't tuned here.
- Bomb plants on easy dropped from 40 to 23 per 6 matches (see above).
- The bomb-objective test in `bot.test.ts` now runs 3 seeded matches instead
  of 1 with the same requirements (2 plants, 1 defuse, 1 pickup). A defuse is
  rare by nature (5 in 89 easy rounds), and seed 1 alone had none after the
  map fix.
- Stuck time at hard is slightly higher (6.7 → 7.9 bot-seconds per match,
  well under one second per round across 10 bots).
- With no player collision, crossing paths still overlap visually for a
  moment.
- Nobody has played against these bots yet. Whether they *feel* human is a
  manual test still to do.

## Defender balance: investigated, not changed (needs an owner decision)

Defenders win 30% of rounds at normal and 27% at hard (16 matches each,
5v5, first to 8). Measured on main after the M3 bot work.

How the kills happen (6 normal matches, 501 kills):

- About 70% of killers are moving when they fire, and so are most
  victims. Holding an angle buys a Defender nothing, because every bot
  strafes in a fight.
- 192 of 501 victims died while retreating to cover.
- Attackers' AR-7 has 221 kills against 150 for the Defenders' K4. More
  Defender kills come with the P9 and MK-5: the K4 costs $400 more, so
  Defenders buy rifles less often.

Three AI-only changes were tried and measured (Defender round wins, 16
matches each):

| Variant | normal | hard |
|---|---|---|
| main | 30% | 27% |
| retreat only to cover 2–6 m away (was 3–11 m) | 26% | 30% |
| that, plus Defenders hold an angle: no strafing, crouch at range | 23% | 34% |
| hold an angle, plus a pre-aim reaction bonus (×0.55 when the enemy appears within 25° of where the holder looks) | 24% | 27% |

None raises normal; some help hard and hurt normal. All were reverted,
since none is a clear improvement. The bot-side levers are exhausted.
What's left is a product decision, because weapon and economy balance
are not to be changed silently:

- Price the K4 like the AR-7 ($2700), or raise the Defender loss bonus.
- Map: give Defenders a little more time to reach the sites. Defender
  Spawn is already between them, so this is the smallest lever.

### Update after the arsenal and grenades: K4 priced like the AR-7

The full arsenal (bots buy SMGs and cheaper rifles when short of money)
and grenades changed the balance. They were re-measured on main before any
price change (Defender round wins, 16 matches each, 5v5, first to 8):

| | normal | hard |
|---|---|---|
| main after arsenal and grenades | 40% (71/179) | 26% (42/160) |
| K4 $3100 → $2700, same as the AR-7 | 38% (74/194) | 36% (65/182) |

At normal the two are within noise. At hard Defenders gain 10 points:
their main rifle now comes a round earlier, as often as the Attackers'
does. The owner left this decision to engineering ("do it however you
think serves me best"). This was the smallest economy change, and it
touches only the K4's price.

### Game pace: 80% movement speed, calmer bot dodging

The owner's first playtest found the game too fast: "players move too
fast, and that makes them very hard to hit". Movement had been the
classic speeds 1:1 (6.35 m/s running). Two changes:

- **All ground speeds × 0.8** (`PACE` in `src/shared/movement.ts`). Running
  is now 5.1 m/s. Ratios between weapons are unchanged: a knife still
  outruns a rifle by the same factor. Acceleration scales with the target
  speed, so reaching full speed takes the same time. The moving-spread
  penalty and footstep cadence are scaled to match: full penalty at a full
  run, about 3 steps a second.
- **Normal bots dodge at walking pace** (Shift) instead of a full run.
  Each dodge lasts 0.5–1.2 s (was 0.35–0.95 s), so their direction
  changes less often. Hard bots still strafe at a full run. Easy bots
  don't strafe.

Re-measured (Defender round wins, 8 matches each, 5v5, first to 8):

| | normal | hard |
|---|---|---|
| before (K4 at $2700) | 38% | 36% |
| pace 0.8 + walking dodge | 41% (35/86) | 43% (41/96) |

Both are closer to even than before.
