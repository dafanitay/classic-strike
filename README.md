# CLASSIC STRIKE

A browser tactical FPS inspired by the round-based shooters of the early 2000s:
bomb plant and defuse, buy phase, economy, learnable recoil, one life per
round. All code, the map,
models, textures and sounds are original (textures and audio are generated
procedurally at runtime). Not affiliated with Valve or any other publisher.

## Run it

```bash
npm install
npm run dev          # client: http://localhost:5180 (solo works with just this)
npm run dev:server   # game server on :8080 for "Play With a Friend" (vite proxies /ws to it)
```

Requirements: Node 20+, a desktop browser with WebGL (current Chrome, Edge or
Firefox), keyboard and mouse.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck + client build to `dist/` + server bundle to `dist-server/server.mjs` |
| `npm start` | Run the built server (serves `dist/` and the WebSocket endpoint `/ws`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests + headless bot-vs-bot matches (Vitest) |
| `npm run e2e` | Solo browser smoke test (needs `npm run dev` running; uses Playwright Chromium) |
| `npm run e2e:feedback` | Browser checks for crosshair settings, hit marker, damage direction (needs `npm run dev`) |
| `npm run e2e:audio` | Renders the real audio graph offline per ear: direction (time and level difference), turning, front/back, distance, walls, voice cap, clean-up (needs `npm run dev`) |
| `npm run e2e:controls` | Weapon selection: keys 1/2/3 and numpad only; simulated Magic Mouse and wheel scrolling must never switch (needs `npm run dev`) |
| `npm run e2e:elevation` | Walks up and down stairs with real key input and screenshots each raised area (needs `npm run dev`) |
| `npm run e2e:botai` | Bot overlay (`?botdebug`) and bots spreading out in a browser match (needs `npm run dev`) |
| `node --import ./scripts/register-ts.mjs scripts/bot-metrics.ts normal 5 8` | Headless bot behaviour metrics (spread, routes, stuck time) |
| `npm run e2e:bomb` | Plants with the E key, checks the HUD and fuse, defuses, and screenshots each step (needs `npm run dev`) |
| `npm run e2e:mp` | Two-browser online test (needs `npm run build && PORT=8090 CS_DEBUG=1 npm start`, then `node tests/e2e/multiplayer.mjs http://127.0.0.1:8090`) |

## Controls

WASD move · mouse aim · LMB fire · RMB scope / heavy stab · Space jump ·
Shift walk (silent) · C crouch · R reload · 1/2/3 weapons · 4 grenades (again: next kind) ·
B buy menu · E (hold) plant / defuse · G drop the bomb · Tab scoreboard · Esc pause (releases the mouse).

Crouch is on **C**, not Ctrl, because Ctrl+W closes the browser tab.
Weapons switch only with **1 / 2 / 3** (top row or numpad): the mouse wheel
does nothing, because touch-surface mice such as the Apple Magic Mouse send
wheel events whenever a finger moves on them.

## Sound

Other players' footsteps, shots, reloads and the bomb are positional. With
headphones and **3D audio** on (Settings, default on) they use an HRTF, so
you can tell left from right *and* in front from behind; turning your head
moves them. Each kind of sound has its own range: footsteps are a close
cue (clear within a few metres, gone past ~32 m), gunfire carries across
the map. A wall between you and a sound muffles it. Walking (Shift) is
silent to others, and crouch-walking makes no footsteps.

Gunshots and bullet impacts are designed in layers (crack, body, low
thump, the action cycling, a short echo off the walls), rendered once when
the game starts and played back with slight variation per shot. Each gun
has its own character; distant shots arrive duller with a separate echo.
Bullets are heard where they land: stone, wood, the occasional ricochet, a
dull thud on a body and a metallic ping on a headshot. Everything is
synthesised in code: there are no recorded or third-party sound files.

## Bomb defusal

One Attacker starts each round with the bomb. Standing inside site A or B,
holding **E** for 3.2 s plants it (you stand still while planting); the bomb
then explodes after 40 s. A Defender at the bomb holds **E** to defuse it:
10 s, or 5 s with a defuse kit ($400, Defenders only, lost on death).
Letting go cancels and the timer starts over.

- Attackers win by detonating the bomb or eliminating the Defenders.
- Defenders win by defusing, eliminating the Attackers before a plant, or
  running out the clock without a plant. Once the bomb is down, dead
  Attackers no longer end the round.
- If the carrier dies the bomb drops; any Attacker picks it up by walking
  over it. The carrier can also throw it a step ahead with **G** for a
  teammate. The bomb is visible on its carrier's back to everyone.
- Money: planter +$300, defuser +$300; Attackers who planted but lost still
  get +$800 each on top of the loss bonus. The blast hurts everyone,
  Attackers included: lethal within about 7–11 m (depending on armour),
  harmless beyond 20 m.

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
    tactics.ts     map reading for bots: alternative routes, scored positions
    sim.ts         authoritative fixed-tick simulation: players, shooting,
                   damage, rounds, economy, buying
    bot.ts         bot AI (perception, reaction, aim, cover, team plans, buying)
  game/          Browser runtime: input (pointer lock) and the game session loop
  render/        Three.js: world builder, procedural textures, avatars,
                 first-person viewmodel, effects
  audio/         Web Audio synthesised sound effects (positional)
    protocol.ts    client/server message types, snapshot encoding, input validation
  net/           Browser networking: WebSocket client (+ reconnect), NetMirror
                 (own-movement prediction + reconciliation, remote interpolation)
  ui/            Menus, lobby, HUD, buy menu, scoreboard (plain DOM + CSS)
server/          Node game server: HTTP (static client + /healthz) and WebSocket
                 rooms, each running the shared Simulation authoritatively
tests/e2e/       Playwright browser tests (solo + two-browser online)
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
  `MAPS`. Elevation is 2.5D: `levels` raise whole cells and `stairs` rise
  across a rectangle in 0.2 m steps (players climb up to 0.457 m without
  jumping, as in the classic games). Each cell has one floor, so there are no
  bridges or overpasses. Bots path up stairs and may drop off ledges, but
  never path up a ledge they would have to jump.
- **No infrastructure for single-player.** It is a static site; no account,
  database or server. Solo keeps working when the game server is down.
- **Authoritative server for online play.** Clients send only input commands
  (validated and clamped), buy requests, team choice and rematch requests.
  Movement, hits, damage, deaths, money and rounds are all computed by the
  server's `Simulation`. Networked players move only when one of their
  commands is processed, so client prediction replays exactly (unit-tested,
  including on stairs and ledges): each client's own position and velocity
  are sent unrounded for that reason.
  Shots are lag-compensated (others rewound by the shooter's RTT +
  interpolation delay, max 0.5 s). Snapshots go out at 20 Hz; remote players
  render 100 ms in the past.
- **Plain `ws`, not Colyseus.** Two-player rooms with a shared simulation need
  a few hundred lines of protocol, not a framework with its own state schema.
- **Rooms live in memory** in a single process: run exactly one instance.

## Online play

Play With a Friend → Create Room gives a 5-character code and an invitation
link (`/?room=CODE`). Opening the link joins directly; so does typing the code.
The second player is put on the other team and the match starts when both are
in. If a player drops, the round is lost for their team (elimination), and
they can rejoin the same slot — score, money and kit preserved — by reloading
the tab or reopening the link in the same tab within 2 minutes. Rematch is
available from the match-end screen without leaving the room.

## Deploy (Fly.io)

One Fly app serves the client and runs the game server (same origin, so the
invitation links and `wss://…/ws` just work).

```bash
fly auth login
fly launch --copy-config --no-deploy   # first time: choose a unique app name + region
fly deploy
fly scale count 1                      # rooms are in memory: exactly one machine
```

Then open `https://<app>.fly.dev`. `fly.toml` stops the machine when nobody is
connected and starts it on the next request (a few seconds' cold start).

Environment variables (see `.env.example`):

| Variable | Where | Purpose |
|---|---|---|
| `PORT` | server | Listen port (Fly: 8080, set in `fly.toml`) |
| `STATIC_DIR` | server | Built client directory (image: `/app/dist`) |
| `ALLOWED_ORIGINS` | server | Optional comma-separated allow-list of page origins for WebSockets |
| `CS_DEBUG` | server | Test-only teleport hook. **Never set in production.** |
| `VITE_SERVER_URL` | client build | Only if the server is on a different origin, e.g. `wss://host/ws` |

No secrets are required; nothing secret is shipped to the browser.

## Gameplay rules (current)

- Elimination mode, first to N rounds (3/5/8/16). Freeze time 4 s, round 1:55,
  buy time 20 s in your spawn zone. Defenders win when time runs out.
- Economy: start $800; win $3250; loss $1400 + $500 per consecutive loss (max
  +$2000); kill rewards per weapon class; cap $16000. Survivors keep their kit.
- Weapons: 22 guns plus the knife, one for every classic role. Names and
  numbers are original. (A) = Attackers only, (D) = Defenders only.

  | Category (buy key) | Guns |
  |---|---|
  | 1 Pistols | P9 Compact (default) · M45 Tactical · K-57 Duty (D) · HC-50 Hand Cannon |
  | 2 Shotguns | Pump-12 · Auto-12 (semi-auto) |
  | 3 SMGs | TP-9 (D) · R-10 Rattler (A) · MK-5 · U-45 · P-50 Hornet (50 rounds) |
  | 4 Rifles | GR-3 Galeo (A) · FM-2 Falcon (D) · AR-7 (A, $2700) · K4 (D, $2700) · SG-5 scoped (A) · AU-3 scoped (D) · Kestrel light sniper · Longbow .338 · RP-3 semi-auto sniper (A) · VG-5 semi-auto sniper (D) |
  | 5 Machine gun | MG-9 Bulldog (100 rounds) |
  | 6 Equipment | Kevlar · Kevlar + helmet · primary / secondary ammo · defuse kit (D) |

  - Bolt-action snipers drop out of the scope after each shot. Scoped
    rifles and semi-automatic snipers stay zoomed.
  - Damage falls off with range. Hit multipliers: head ×4, stomach ×1.25,
    legs ×0.75. Armour and helmet absorb damage per weapon.
- Buy menu (B): press a number to open a category, then a number to buy;
  0 goes back. Each team sees only what it can buy.
- Grenades (equipment, key 4; press 4 again to switch kind). Left click
  throws, right click lobs short. They bounce off walls and floors. You can
  carry one HE ($300), two flashbangs ($200) and one smoke ($300), and you
  lose them when you die.
  - HE: explodes after 1.6 s. It does up to 98 damage within 9.5 m, less
    further out, none through walls. Armour takes half.
  - Flashbang: goes off after 1.6 s and whites out the screen of anyone
    who sees it. It's worst for players looking straight at it up close
    (about 2 s fully blind, then fading); with your back turned, nothing.
    Your ears ring while you're blinded.
  - Smoke: pops once it stops rolling. A cloud about 8 m across blocks
    sight for 15 s, for players and bots alike. Bullets still go through.
- Bots buy grenades from round 2. Attackers flash or smoke a site as they
  go in, and turn away from a teammate's flash. Defenders throw an HE at
  attackers they spot near a site.
- Recoil is a **fixed spray pattern per weapon** (`recoilPattern` in
  `src/shared/weapons.ts`, expanded by `src/shared/recoil.ts`): the same
  spray lands in the same place every time, so it can be learned and pulled
  down. Recoil recovers within a fraction of a second once you stop firing,
  so taps and short bursts are accurate. Spread is small when standing and
  large when moving or airborne; crouching tightens it.
- Each weapon has its own draw time (`drawTime`) before it can fire.

## Status

See [`STATUS.md`](STATUS.md) for completed features, the test report, known
issues and the next milestone.
