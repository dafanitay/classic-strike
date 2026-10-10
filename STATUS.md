# Status

_Last updated: 2026-10-10_

## Milestones

| Milestone | State |
|---|---|
| 1 — Playable FPS foundation | **Done** (see test report) |
| 2 — Classic gameplay (weapons, reload, teams, bots, difficulty, rounds, economy, buy menu, scoreboard) | **Done** (see test report) |
| 3 — Multiplayer (server, rooms, codes, invite links, sync, validation, rematch) | Not started |
| 4 — Bomb defusal, polish | Not started (bomb mode is shown as "coming soon" and cannot be selected) |

## Test report

Automated, run on 2026-10-10 in a Linux container:

- `npm run typecheck` — 0 errors.
- `npm test` — 16/16 pass:
  - movement: ground speed cap, friction stop, 1.14 m jump with re-press, wall
    slide without penetration, low crate climbable / tall crate not;
  - map: every walkable cell connected, spawns clear, nav paths from both
    spawns to both sites, walls block line of sight;
  - damage model (hitgroups, range falloff, armour/helmet);
  - simulation: hitscan hits a visible enemy and is stopped by walls; round end
    on elimination pays both teams correctly; purchase validation;
  - **headless bot-vs-bot matches** on easy/normal/hard each play to a
    complete match end, most rounds end by elimination (bots find and fight
    each other), and hard bots beat easy bots in ≥3 of 4 matches.
- `npm run e2e` (Playwright, headless Chromium, SwiftShader) — 21/21 pass:
  main menu; solo setup; real pointer lock from a click; HUD; B opens the buy
  menu in freeze time and buying Kevlar deducts $650; W moves the player; mouse
  movement turns the view; Space jumps (1.14 m); running into a wall does not
  pass through; shooting an enemy damages it and sustained fire kills it (kill
  feed entry); R reloads and refills; Tab scoreboard; losing mouse capture
  pauses the simulation and shows the pause menu; resume; a full match plays to
  the end with bots; match-end screen; rematch resets to round 1, 0:0; no
  console errors or page exceptions.

Not verified by a human:

- Nobody has played it with a real mouse and a GPU yet. The browser tests run
  on software rendering at ~4–15 fps, so they prove behaviour, not feel or
  frame rate. Simulation cost was measured at ~0.2 ms per tick with 6 players;
  GPU frame time on real hardware is unmeasured.
- Audio is synthesised and plays without errors, but nobody has listened to it.

### Manual test checklist (please run on a desktop)

1. `npm install && npm run dev`, open http://localhost:5180 in Chrome.
2. Play Solo → Start Match. Click to capture the mouse. Check aim feels
   1:1 and sensitivity (Settings) changes it.
3. During the 4 s freeze press B, buy something, press B again — the mouse
   should be captured again.
4. Walk (Shift), crouch (C), jump onto a low crate, try a tall crate (can't).
5. Spray a rifle at a wall: impacts climb, then sway. Tap-fire is accurate.
6. Press Esc: the game pauses and the pause menu appears; Resume recaptures.
7. Alt-tab away mid-round: the game pauses.
8. Die: death cam, then spectating teammates (click to switch).
9. Finish a match; Rematch; Main Menu.
10. Settings → Graphics Low/High and FOV apply live; reload the page —
    settings persist.

## Known issues / limitations

- No player-vs-player collision (players can overlap; bullets still hit the
  right person). Avoids bots wedging each other in doorways.
- No wall penetration; bullets stop at the first solid.
- Bots don't jump onto crates or use crouch-jumps; they navigate the floor
  grid only. They do not yet react to footsteps of walking (silent) players —
  intentional, as in the classics.
- Round restart restores money/kit/score from the start of the round, but
  decals and the kill feed are not rolled back.
- No halftime team swap.
- Hit registration is hitscan against axis-aligned hitboxes (they don't rotate
  with the model).
- Third-person animations are minimal (leg swing, crouch, fall-over death).

## Next milestone

Milestone 3 — online play with a friend: a Node + WebSocket authoritative
server reusing `src/shared/`, private rooms with codes and invite links,
client prediction + interpolation, server-validated combat, disconnect
handling and rematch. Needs a hosting decision for the persistent server.
