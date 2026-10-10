# Audio, graphics and input: what changed and how it was checked

This covers the weapon-input fix, positional audio, the weapon and impact
sound bank, and the graphics pass. Everything here is generated in code.
There are no recorded sounds, image files or third-party game assets.

## Input: weapons switch only from the keyboard

- **1 / 2 / 3** switch weapons, on the top row or the numpad.
- The mouse wheel does nothing in game. Touch-surface mice (Apple Magic
  Mouse) send wheel events whenever a finger moves on them, which used to
  change weapons mid-fight.
- **Q** (last weapon) is gone, and side and middle buttons are ignored.
- Typing digits into a text field doesn't switch weapons.
- **G** drops the bomb for a teammate.
- Check: `tests/e2e/controls.mjs`, 13 browser checks, including simulated
  Magic Mouse and notched-wheel scrolling.

## Positional audio (`src/audio/audio.ts`, `src/audio/spatial.ts`)

- **Placement:** an HRTF panner places every other player's sound, so
  with headphones you can tell left from right and front from back. It
  follows the camera each frame. A setting turns it off (plain panning).
- **Distance:** each kind of sound has its own range. Footsteps are clear
  within a few metres and silent past about 32 m. Gunfire carries across
  the map, and impacts carry about 40 m.
- **Walls:** a wall between you and a sound makes it quieter and duller,
  never silent.
- **Voice cap:** at most 40 sounds at once. Low-priority sounds are
  dropped first, and finished sounds are disconnected.
- **Checks:**
  - unit tests in `spatial.test.ts`;
  - `tests/e2e/audio.mjs`, which renders the real audio graph offline and
    measures each ear: interaural time and level difference, left/right
    flipping when you turn, front vs back, distance, walls, the cap and
    clean-up.

## Weapon and impact sounds (`src/audio/soundBank.ts`)

**Gunshots.** Each gun is built in layers, the way real weapon
recordings are:

- **crack:** a sharp transient;
- **body:** a mid-range punch, saturated;
- **thump:** a fast falling low sine;
- **mechanism:** a slide, bolt or pump click;
- **tail:** a short echo off the walls, from a generated room impulse
  response.

Heavier guns get more low end and a longer tail.

**Rendering.** Everything is rendered once when the game starts, on an
OfflineAudioContext (about 0.4 s in the background), with 3 variants per
sound. Playback varies the pitch slightly.

**Impacts,** heard where the bullet lands:

- stone: a chip with falling grit;
- wood (crates): a hollow knock;
- a ricochet whine on 12% of stone hits;
- a body hit: a dull thud;
- a headshot: a metallic ping.

**Who hears what:**

- the shooter's hit confirmation uses the same thud or ping;
- the victim hears a muffled thud;
- bystanders hear hits positionally;
- a shotgun's 8 pellets play one impact sound, not 8.

**Distance:** far shots lose their top end and arrive with a separate dull
echo.

**Fallback.** Until the bank is ready, or if a browser can't render it,
the older live-synthesised sounds play. Settings shows which set is in
use, and the reason if the enhanced one failed (also logged to the
console).

**Checks:**

- `tests/e2e/sounds.mjs`, 10 checks:
  - every shot peaks within 15 ms;
  - low end ranks sniper/shotgun > rifle > pistol;
  - a headshot is brighter than a body hit;
  - variants differ;
  - GameAudio uses the bank;
  - a far shot is quieter and duller.

  It can also write every sound to WAV for listening.
- Whether the sounds are *good* is a matter of listening. That was not
  done on real speakers or headphones.

## Graphics (`src/render/`)

Geometry and collision are unchanged.

- **Baked lighting (`bake.ts`):**
  - Light is traced from the collision world at load time and stored as
    vertex colours, like the lightmaps of the classic games.
  - Two parts: how much sky each surface sees (corridors and roofed
    tunnels darker), and contact shadows where floors meet walls and
    crates.
  - With shadow maps on, the bake is gentler, so tunnels aren't darkened
    twice.
  - It's computed once per map and setting, so switching quality doesn't
    redo it.
  - Low quality uses coarser detail.
- **Light:** filmic (ACES) tone mapping and a stronger sun against the
  ambient light. Muzzle flashes and painted signs skip tone mapping.
- **Sky:** a sun glow in the sky dome.
- **Textures:** bevelled sandstone blocks with mortar and cracks, sand
  ripples, concrete speckle and chipped tiles. On **High** only, the same
  textures double as bump maps.
- **First-person guns:** metal parts get a specular highlight.
- **Seams:** walls, crates and ledge sides are drawn 15 cm into the floor,
  so the hairline seam no longer shows sky-coloured specks (render only).

**Cost.** Measured with headless Chromium and SwiftShader, a CPU renderer,
at 1280×720. The times only compare before and after; a GPU is far
faster.

| Preset | before | after |
|---|---|---|
| Low | ~80 ms, ~3k triangles | ~85 ms, ~9k triangles |
| Medium (default) | ~273 ms, ~5k triangles | ~350 ms, ~27k triangles |
| High (bump maps) | ~270 ms, ~5k triangles | ~750 ms, ~27k triangles |

Runs that overlapped other jobs measured up to 2× slower and are not used
here.

**Checks:**

- `src/render/bake.test.ts`, 7 tests;
- `tests/e2e/visual.mjs`: screenshots of 7 views, plus draw calls,
  triangles and frame time;
- brightness measured in the screenshots, e.g. B Tunnels walls under the
  roof went from 70 to 35 on medium.

**Not done:** checking on real GPU hardware or across browsers. The look
is a judgement call; tuning is easy (`SKY_FLOOR`, tone mapping exposure,
texture painters).
