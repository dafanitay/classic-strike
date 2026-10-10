# CLASSIC STRIKE

A browser tactical FPS inspired by the round-based shooters of the early 2000s:
buy phase, economy, learnable recoil, one life per round. All code, the map,
models, textures and sounds are original (textures and audio are generated
procedurally at runtime). Not affiliated with Valve or any other publisher.

> This directory is a **self-contained project**. It has its own `package.json`
> and lockfile and shares nothing with the NOX application in the parent
> repository. It can be split out into its own repository with
> `git subtree split --prefix classic-strike`.

## Run it

```bash
cd classic-strike
npm install
npm run dev          # http://localhost:5180
```

Requirements: Node 20+, a desktop browser with WebGL (current Chrome, Edge or
Firefox), keyboard and mouse.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck + production build to `dist/` (static files) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests + headless bot-vs-bot matches (Vitest) |
| `npm run e2e` | Browser smoke test (needs `npm run dev` running; uses Playwright Chromium) |

## Controls

WASD move · mouse aim · LMB fire · RMB scope / heavy stab · Space jump ·
Shift walk (silent) · C crouch · R reload · 1/2/3, wheel, Q weapons ·
B buy menu · Tab scoreboard · Esc pause (releases the mouse).

Crouch is on **C**, not Ctrl, because Ctrl+W closes the browser tab.

## Architecture

```
src/
  shared/        Pure simulation — no DOM, no Three.js. Runs unchanged in Node.
    vec.ts         plain-object vector math + seeded RNG
    collision.ts   AABB world, axis-separated hull movement, ray casts
    movement.ts    GoldSrc-style pmove (friction, accel, air control, jump, crouch)
    weapons.ts     weapon roster + damage/armour model
    map.ts         grid-carved map format -> collision boxes
    maps/depot.ts  the "Depot" map
    nav.ts         A* over the map grid + string pulling (bot navigation)
    sim.ts         authoritative fixed-tick simulation: players, shooting,
                   damage, rounds, economy, buying
    bot.ts         bot AI (perception, reaction, aim, cover, team plans, buying)
  game/          Browser runtime: input (pointer lock) and the game session loop
  render/        Three.js: world builder, procedural textures, avatars,
                 first-person viewmodel, effects
  audio/         Web Audio synthesised sound effects (positional)
  ui/            Menus, HUD, buy menu, scoreboard (plain DOM + CSS)
tests/e2e/       Playwright browser tests
```

Key decisions:

- **Fixed 60 Hz simulation driven only by `PlayerCmd`s.** Humans and bots are
  the same kind of participant; a bot just produces commands. Rendering
  interpolates between ticks. The same `Simulation` class is meant to run on
  the multiplayer server (server-authoritative hit validation).
- **Custom AABB physics instead of Rapier.** Every solid is an axis-aligned box,
  so exact collision is a few dozen lines, deterministic, dependency-free and
  identical on client and server.
- **Grid-carved maps.** A map starts solid; walkable areas are carved out as
  rectangles. No gaps in the shell are possible, and the grid doubles as the
  bot navigation graph. Add a map by writing another `MapDef` and listing it in
  `MAPS`.
- **No infrastructure for single-player.** It is a static site; no account,
  database or server.

## Gameplay rules (current)

- Elimination mode, first to N rounds (3/5/8/16). Freeze time 4 s, round 1:55,
  buy time 20 s in your spawn zone. Defenders win when time runs out.
- Economy: start $800; win $3250; loss $1400 + $500 per consecutive loss (max
  +$2000); kill rewards per weapon class; cap $16000. Survivors keep their kit.
- Weapons: knife, P9 pistol, MK-5 SMG, Pump-12 shotgun, AR-7 rifle (Attackers),
  K4 carbine (Defenders), Longbow sniper (2-level scope). Damage falls off with
  range; head ×4, stomach ×1.25, legs ×0.75; armour/helmet absorb per weapon.
- Accuracy suffers when moving or airborne and improves crouched; sustained
  fire climbs, then sways.

## Status

See [`STATUS.md`](STATUS.md) for completed features, the test report, known
issues and the next milestone.
