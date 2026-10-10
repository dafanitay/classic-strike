# Milestone 0 — Technical and gameplay audit

_Baseline: commit `89c3c4b` (deployed as `classic-strike-itay` on Fly.io).
Audited 2026-10-10. Each item is **[V]** verified by reading code / running
it, or **[A]** an assumption (not yet measured)._

## Baseline results

| Check | Result |
|---|---|
| `npm ci`, `npm audit` | 0 vulnerabilities [V] |
| `npm run build` (tsc + Vite + esbuild server) | passes; client 604 kB raw / 161 kB gzip, server 188 kB [V] |
| `npm test` | 26/26 (4 files: core, bots, prediction, server) [V] |
| Browser smoke (`tests/e2e/smoke.mjs`, headless Chromium, SwiftShader) | 21/21 [V] |
| Live public checks (GitHub runner → Fly) | 9/9 on deploy run #1 [V] |
| Real GPU frame rate, human play test, two separate computers | **never measured** |

## A–Q: what exists today

- **A. Rendering** — Three.js r180, WebGLRenderer, Lambert materials,
  one directional sun (PCF soft shadows on medium/high), hemisphere light,
  fog, vertex-coloured sky dome. Pixel ratio by quality. [V]
- **B. Scene** — map geometry merged per material (≈10 draw calls),
  avatars as 15–20 box meshes each, effect pools (tracers, decals, puffs).
  First-person weapon in a separate scene/camera rendered after a depth
  clear. [V]
- **C. Camera / mouse look** — Pointer Lock with `unadjustedMovement`
  (raw input) and fallback; yaw/pitch accumulated per mouse event, so
  aiming is independent of frame rate. 0.022°/count × sensitivity. Lock
  loss → pause (solo). [V]
- **D. Movement / collision** — GoldSrc-style pmove (friction, stop speed,
  accel 5, air-accel 10 with 0.76 m/s air cap, 45-unit jump, crouch, walk),
  fixed 60 Hz. AABB world, axis-separated resolution against previous
  position. **No step-up**, so no stairs/ramps; map is a single flat floor.
  **No player–player collision.** [V]
- **E. Weapons / hit detection** — data-driven `WEAPONS` table (7 weapons),
  hitscan rays vs. AABB world and four AABB hitboxes per player
  (head/chest/stomach/legs). Hitboxes do not rotate with the model. No wall
  penetration. Shotgun = 9 pellets. [V]
- **F. Recoil / accuracy** — view punch + cone spread. **Recoil is random**:
  kick size ×(0.85–1.15) random and horizontal sway direction flips at
  random (18 %/shot). Measured: the same 30-round AR-7 spray diverges by
  **1.26° mean / 5.4° max** between RNG seeds, so it cannot be learned
  (see `docs/measurements/spray-baseline.txt`). [V]
- **G. Bots** — grid A* + string pulling, view-cone + LOS perception,
  hearing, reaction delay, aim error, partial recoil compensation, cover
  seeking on reload, team plans, buying. Three difficulty presets. [V]
- **H. Multiplayer transport** — Node `ws`, JSON, server-authoritative
  `Simulation`; clients send commands only (validated/clamped), 20 Hz
  snapshots, own-movement prediction + reconciliation (unit-tested exact),
  remote interpolation (100 ms), lag-compensated hitscan (≤0.5 s). [V]
- **I. Rooms** — 5-char codes, invite links, 2 humans max, opposite-team
  auto-assignment, rejoin tokens (incl. stale-socket takeover), rate limit,
  heartbeat, 90 s empty-room expiry. [V]
- **J. Match lifecycle** — warmup → freeze (4 s, buy) → live (1:55) →
  round end (5 s) → … → match end; elimination + timeout (Defenders);
  economy (start $800, win $3250, loss bonus ladder, kill rewards). **No
  objective mode.** [V]
- **K. Map** — one map (Depot), 40×30 grid of 2 m cells carved from solid;
  walls 5 m, low/tall crates, two roofs. Flat — no elevation. Floors are
  per-cell quads. [V]
- **L. Animation / models** — procedural box models; legs swing, crouch,
  fall-over death. Viewmodel: bob, sway, kick, reload dip, draw raise,
  knife swing. No skeletal animation, no imported assets. [V]
- **M. Sound** — Web Audio synthesis only (noise + oscillators), panner
  nodes for positional sounds, surface-dependent footsteps (2 surfaces).
  Volume settings. [V]
- **N. UI / HUD** — DOM HUD: health, armour, money, ammo, timer, score,
  kill feed, dynamic crosshair (fixed style), scoreboard, buy menu, scope
  overlay, damage vignette. Menus: solo setup, friend lobby, settings,
  controls. **No crosshair settings, no minimap, no hit marker.** [V]
- **O. Assets** — no external assets at all; textures are canvas-generated
  at startup. [V]
- **P. Tests** — see baseline table. [V]
- **Q. Deployment** — one Fly machine (`fra`), Docker image 67 MB, rooms in
  memory, manual GitHub Actions deploy with public checks. [V]

## Five largest gaps (ranked)

1. **Unlearnable recoil.** Random kick and random sway mean spray control
   can't be practised — the core of the genre's skill ceiling. Fix is
   contained in `shared/sim.ts` + weapon data, server and client share it.
2. **Flat, placeholder-looking map with no verticality.** Readability is
   fine but there is no elevation, no stairs/ramps (the movement code can't
   climb steps), and box-only art.
3. **No objective mode.** Elimination only; rounds lack the plant/defuse
   tension that drives positioning and rotations.
4. **Combat feedback is thin.** No hit marker, no crosshair customisation,
   no damage-direction indicator; kill confirmation is audio-only.
5. **Online is 2 humans, no bots, no player collision.** Small matches only;
   overlap through teammates/enemies breaks peeking and body-blocking.

## Can the current architecture support the target?

**Yes, incrementally.** The shared fixed-tick simulation already powers
solo, bots and an authoritative server with exact prediction, so gameplay
changes land in one place and are testable headlessly. Three.js is adequate
for a stylised early-2000s look; the limits are content (art, map, audio),
not the engine. No engine migration is justified by anything measured so
far. The things that would need real architectural work are: step-up
movement (for stairs/ramps), rotating hitboxes, and N-player rooms with
server-side bots — all additive to the current design.

## Roadmap (ranked by impact ÷ risk, with dependencies)

| # | Milestone | Gameplay | Visual | MP correctness | Perf | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| 1 | Deterministic, learnable recoil patterns + first-shot accuracy | ★★★ | – | ★ (shared) | – | low | – |
| 2 | Combat feedback: hit marker, crosshair settings, damage direction | ★★ | ★ | – | – | low | – |
| 3 | Step-up movement + ramps/stairs, then a map pass with elevation | ★★★ | ★★ | ★ | – | med | – |
| 4 | Bomb plant/defuse mode (server-authoritative) | ★★★ | ★ | ★★ | – | med | 3 helps |
| 5 | Player–player collision + rotating hitboxes | ★★ | – | ★★ | – | med | – |
| 6 | N-player rooms + server-side bots online | ★★ | – | ★★★ | ★ | med | 5 |
| 7 | Art pass: materials, lighting bake, models, audio | ★ | ★★★ | – | ★ | med | 3 |
| 8 | Performance measured on real hardware; long-session soak | – | – | ★ | ★★★ | low | needs a human with a GPU |

## First three concrete improvements

1. **Recoil patterns** (this milestone): per-weapon fixed spray patterns,
   recoil that resets on a weapon-specific recovery curve, spread kept only
   as a small, mostly-movement-driven cone. Acceptance criteria below.
2. **Hit marker + crosshair customisation** (size, gap, thickness, colour,
   dynamic/static), persisted in settings.
3. **Step-up movement** in `stepMovement` with tests, so the next map pass
   can have stairs and ramps without breaking prediction.

### Acceptance criteria — improvement 1 (recoil)

- Same inputs + different RNG seeds → identical recoil offsets for every
  shot (divergence comes only from the spread cone).
- A standing, stationary first shot lands within the weapon's base spread
  (≤ 0.25° for rifles).
- A player who pulls down along the published pattern keeps a full rifle
  magazine inside a small group (asserted in a test using the *pattern*,
  not the hidden live punch).
- Recoil fully recovers after a short pause; shot index resets.
- Moving/jumping accuracy penalties still apply and are larger than the
  pattern for running shots.
- Prediction, server and bot tests keep passing; build + browser smoke
  pass.

## Progress on branch `overhaul/m1-gunplay` (merged in PR #1, deployed 2026-10-10)

| Improvement | Status | Evidence |
|---|---|---|
| 1. Deterministic recoil patterns | Done | divergence 1.26°/5.39° → 0.15°/0.32° (`docs/measurements/`); 8 unit tests |
| 2. Crosshair settings, hit marker, damage direction | Done | 8 unit tests; `tests/e2e/feedback.mjs` 6/6 |
| 3. Step-up movement (stairs/ledges ≤ 0.457 m) | Done (engine only) | 3 unit tests; prediction exactness test still passes. The current Depot map has no ledges this low, so gameplay on it is unchanged until the map pass adds stairs. |

Not measured yet: feel and frame rate on real hardware; nothing on this
branch has been played by a human or deployed.

## Progress on branch `overhaul/m2-map` (roadmap item 3, second half)

| Change | Evidence |
|---|---|
| Map elevation: raised floors (`levels`) and stairs (`stairs`) in the map format; crates stand on raised floors | `src/shared/elevation.test.ts` (surface heights, monotone stairs, invalid layouts rejected) |
| Depot: raised A Site with three ways up (Long stairs, A Ramp stairs, Catwalk → Short A); B Doors balcony; lower pockets under ledges | screenshots from `tests/e2e/elevation.mjs` |
| Ground snapping: walking down stairs stays on the ground (no air inaccuracy, no missing footsteps) | every Depot staircase walked up and down with 0 airborne ticks (unit + browser) |
| Bots: height-aware A* and string pulling; drop down ledges, never path up one | every route between spawns, sites and raised areas walked by a bot-style follower; 5v5 bot matches spend 11–13 % of alive time on high ground, no timeouts (`docs/measurements/elevation-bots.txt`) |
| Netcode: the receiving player's own body is sent unrounded; landing slowdown rounding-safe; collision no longer shoves a hull across a wall when a rounded position grazes it | prediction error now < 1e-6 m in 17 scenarios incl. every staircase (was up to 6.4 m in one stairs case, 2–3 cm after landings) |

Two of the netcode bugs are older than this branch and affect online play in
the deployed build (solo is unaffected):

- **Wall touch.** A player pressed against a wall is exactly 0.4064 m from it;
  the snapshot rounded that to 1 mm, i.e. 0.4 mm *inside* the wall, and on
  replay the client's collision code resolved the overlap along the wall,
  moving the player to the wall's end. Reproduced against main's
  `collision.ts`: a rounded wall-touching position, standing still, ends up
  5.4 m away at the end of a 20 m wall. Each snapshot corrects it from the
  server, so online it would show as the view jumping while hugging walls.
  Not observed by a human; found by the new prediction test.
- **Landing tick.** A landing within 1 mm of the floor could be predicted a
  tick late (2–3 cm, blended out visually).

Not measured: how the new layout plays for humans, frame rate on real
hardware, and play between two separate computers.


## Progress on branch `overhaul/m3-bomb` (roadmap item 4)

| Change | Evidence |
|---|---|
| Bomb defusal: one Attacker carries the bomb; plant in a site (hold E, 3.2 s, standing still, can't shoot); 40 s fuse; defuse 10 s / 5 s with a kit; drop on death, pick up by walking over; explosion with distance falloff that hurts everyone; classic win conditions and money (plant/defuse +$300, +$800 planted-loss bonus) | `src/shared/bomb.test.ts` (13 tests) |
| Movement lock while planting/defusing is computed by the same function on server and client; after completing, the lock holds until E is released, so prediction never drifts at the moment the bomb is planted | prediction test while planting: error < 1e-6 m (was 0.29 m before the use latch) |
| HUD: plant/defuse progress bar, BOMB/KIT tag, planted indicator replaces the clock, hints, scoreboard gear; defuse kit in the buy menu; bomb model, beeps speeding up with the fuse, explosion | `tests/e2e/bomb.mjs` 14/14 with screenshots |
| Online: bomb state, kit and plant/defuse progress in snapshots (protocol v2); plant through the real server seen by both clients | `tests/e2e/multiplayer.mjs` 20/20 (local server) |
| Bots: carrier goes to the planned site and plants, nearest Attacker fetches a dropped bomb, Attackers guard a planted bomb, Defenders retake and defuse, Defenders buy kits | bot test; 9 headless matches in `docs/measurements/bomb-bots.txt` |

Known limits: a carried bomb isn't drawn on the carrier's model (teammates
see the carrier on the scoreboard); there's no way to drop or pass the bomb
on purpose; bots plant mostly at easy difficulty, because at normal and
hard the carrier usually dies on the way.
