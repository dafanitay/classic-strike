# CLASSIC STRIKE: engineering report (bots, systems audit, audio/visual/input)

This covers three missions:

- **A:** bots that play like people.
- **B:** a gameplay and systems audit.
- **C:** visuals, 3D audio and weapon input.

It also covers the follow-ups the owner asked for: the full arsenal,
grenades, deploys and the "make it like the real game" requests. Details
live in `docs/GAMEPLAY_AUDIT.md` (bots, balance) and
`docs/AUDIO_VISUAL.md` (audio, graphics, input).

**Everything below is on `main` and deployed to
https://classic-strike-itay.fly.dev.** Each deploy ran the workflow's own
checks against the live URL (solo, plus two browsers online), and they
passed.

**Apart from the owner's one short playtest, nobody has played it with a
human at the keyboard, on real GPU hardware or on real speakers.** Every
"verified" below means automated tests or headless measurements.

## What shipped

| PR | What |
|---|---|
| #3 | Bomb defusal: plant, defuse, kit, bots play the objective |
| #4 | Weapons switch only from the keyboard (fix for the Magic Mouse) |
| #5 | Bot AI: roles, routes, spreading, rotations, recovery; spawn-to-spawn sightline closed |
| #6 | 3D positional audio, baked lighting, filmic tone mapping, textures |
| #7 | Layered weapon and impact sounds; bullets heard where they land |
| #8 | Bomb on the carrier's back, G drops it; build label and sound status; wall-seam fix |
| #9 | 22 guns, one for every classic role; category buy menu |
| #10 | Grenades (HE, flashbang, smoke); bots use them |
| (this branch) | Slower pace (80% movement speed), calmer bot dodging; K4 price; damage column on the scoreboard; money pop-ups; buy-menu stats; distinct SMGs; fixes from the grenade review |

## Mission A: bots

- **Before**, a whole team walked one shortest route to one spot. Attackers
  were within 3 m of a teammate 40–84% of the time, and bots spent up to
  153 seconds per match pressed into crates.
- **Now:**
  - each bot has a role (entry, flank, support, lurk; anchor and mid);
  - routes and positions are derived from the map;
  - bots spread out, rotate on contact and recover from getting stuck;
  - they buy across the arsenal, and use grenades, including turning away
    from a teammate's flash.
- **Results** (8 matches per difficulty):
  - Attackers within 3 m of a teammate: 8–15%;
  - lanes used per round: about 2.7, up from 1.5;
  - stuck time: about 10 bot-seconds per match.
- Tests: `botAI.test.ts` (A–G), `tests/e2e/botai.mjs`.

## Mission B: systems audit

- **Real defects found and fixed:**
  - a 60 m spawn-to-spawn sightline: hard bots killed Attackers in their
    spawn at round start;
  - one enemy counted as two contacts, which made Defenders over-rotate;
  - a dropped-defuse edge case;
  - a client prediction drift at the end of a plant;
  - sky-coloured specks at wall bases;
  - several test-harness bugs that hid real numbers, such as a draw-call
    counter that saw only the gun.
- **Balance:** Defenders were weak. Three AI-only fixes were tried and
  rejected. The arsenal and grenades moved normal to 40% Defender wins.
  Pricing the K4 like the AR-7 then moved hard from 26% to 36%.
- **Leaks:** a soak test plays many rounds in a real browser and checks
  heap, GPU objects, effects, audio voices and HUD DOM
  (`tests/e2e/soak.mjs`).

## Mission C: input, audio, visuals

- **Input:** weapons switch with 1/2/3/4 only; the mouse wheel does
  nothing, so a Magic Mouse can't switch weapons by accident.
- **Audio:**
  - HRTF positional sound;
  - per-sound distance curves;
  - walls muffle sound;
  - a voice cap;
  - layered, pre-rendered weapon and impact sounds;
  - all synthesised: no recorded or copyrighted assets.
- **Visuals:**
  - baked lighting traced from the map;
  - tone mapping;
  - richer textures;
  - sun glow;
  - gun finishes.

  Collision is unchanged. Costs are measured in `docs/AUDIO_VISUAL.md`.

## Known gaps and suggestions

- **One short human playtest so far.** It found the game too fast and
  targets too hard to hit, and both are fixed (see "Game pace" in
  `docs/GAMEPLAY_AUDIT.md`). More play, and a list of whatever still feels
  off, is the most useful next step.
- **"I don't hear the new sounds":** Settings now shows whether the
  enhanced sound set loaded, or why not. The cause needs the player's
  browser and that line to pin down.
- **One map only.** A second map would add the most replay value. Bots,
  routes and lighting are all derived from the map automatically.
- **Software rendering exaggerates costs.** Frame times in the docs come
  from a CPU renderer and are only useful for comparison.
