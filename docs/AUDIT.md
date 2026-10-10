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
