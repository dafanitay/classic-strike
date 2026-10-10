import type { MapDef } from '../map';

/**
 * "Depot" — an original three-lane bomb-defusal layout.
 *
 *   Attackers spawn in the west yard. Defenders spawn east, between both
 *   bombsites, so they rotate faster (the classic asymmetry).
 *   - North lane: Long A, a long sightline broken by a one-cell door.
 *   - Centre:     Mid corridor -> Middle (with Catwalk up to Short A) -> Mid
 *                 Doors into Defender Spawn.
 *   - South lane: roofed B Tunnels (also reachable from Mid via the Lower
 *                 Tunnel) opening onto B Site.
 *
 * Grid: 40 x 30 cells of 2 m (80 m x 60 m). x grows east, z grows south.
 */
export const DEPOT: MapDef = {
  id: 'depot',
  name: 'Depot',
  description: 'Three-lane desert freight yard. Bomb defusal / elimination.',
  cellSize: 2,
  cols: 40,
  rows: 30,
  wallHeight: 5,
  areas: [
    { name: 'Attacker Spawn', floor: 'sand', x0: 1, z0: 11, x1: 6, z1: 18 },
    { name: 'Outside Long', floor: 'sand', x0: 3, z0: 4, x1: 6, z1: 10 },
    { name: 'Long A', floor: 'sand', x0: 3, z0: 2, x1: 26, z1: 4 },
    { name: 'A Site', floor: 'tile', x0: 27, z0: 2, x1: 36, z1: 9 },
    { name: 'Mid', floor: 'concrete', x0: 7, z0: 13, x1: 18, z1: 16 },
    { name: 'Middle', floor: 'dirt', x0: 18, z0: 11, x1: 24, z1: 18 },
    { name: 'Mid Doors', floor: 'concrete', x0: 25, z0: 14, x1: 30, z1: 15 },
    { name: 'Defender Spawn', floor: 'concrete', x0: 31, z0: 12, x1: 37, z1: 18 },
    { name: 'A Ramp', floor: 'concrete', x0: 32, z0: 10, x1: 35, z1: 11 },
    { name: 'Catwalk', floor: 'concrete', x0: 21, z0: 8, x1: 23, z1: 10 },
    { name: 'Short A', floor: 'concrete', x0: 21, z0: 6, x1: 26, z1: 7 },
    { name: 'Outside Tunnels', floor: 'sand', x0: 3, z0: 19, x1: 6, z1: 23 },
    { name: 'B Tunnels', floor: 'concrete', x0: 3, z0: 24, x1: 18, z1: 26 },
    { name: 'B Site', floor: 'tile', x0: 19, z0: 21, x1: 28, z1: 27 },
    { name: 'B Ramp', floor: 'concrete', x0: 31, z0: 19, x1: 34, z1: 21 },
    { name: 'B Doors', floor: 'concrete', x0: 29, z0: 22, x1: 34, z1: 23 },
    { name: 'Lower Tunnel', floor: 'concrete', x0: 15, z0: 17, x1: 16, z1: 23 },
  ],
  fills: [
    // Long A doors: leaves a single 2 m gap at z = 3.
    { x: 17, z: 2 },
    { x: 17, z: 4 },
    // Pillar in Middle breaks the Mid -> Mid Doors sightline.
    { x: 21, z: 14 },
  ],
  crates: [
    { x: 29, z: 4 }, { x: 30, z: 4 }, { x: 33, z: 7, tall: true }, { x: 28, z: 8 }, { x: 35, z: 3, tall: true },
    { x: 10, z: 2 }, { x: 22, z: 4 },
    { x: 20, z: 12, tall: true }, { x: 23, z: 17 }, { x: 19, z: 16 },
    { x: 21, z: 23 }, { x: 22, z: 23 }, { x: 25, z: 25, tall: true }, { x: 20, z: 26 }, { x: 27, z: 22 },
    { x: 34, z: 15 },
    { x: 1, z: 11 },
    { x: 12, z: 13 },
  ],
  roofs: [
    { x0: 7, z0: 24, x1: 18, z1: 26, height: 3.4 },
    { x0: 15, z0: 18, x1: 16, z1: 23, height: 3.4 },
  ],
  spawns: {
    A: [
      { x: 3, z: 13 }, { x: 4, z: 13 }, { x: 3, z: 15 }, { x: 4, z: 15 }, { x: 3, z: 17 },
      { x: 4, z: 17 }, { x: 5, z: 12 }, { x: 5, z: 14 }, { x: 5, z: 16 }, { x: 2, z: 14 },
    ],
    D: [
      { x: 33, z: 13 }, { x: 35, z: 13 }, { x: 33, z: 15 }, { x: 36, z: 15 }, { x: 33, z: 17 },
      { x: 35, z: 17 }, { x: 32, z: 14 }, { x: 36, z: 13 }, { x: 32, z: 16 }, { x: 36, z: 17 },
    ],
  },
  buyZones: {
    A: { x0: 1, z0: 11, x1: 6, z1: 18 },
    D: { x0: 31, z0: 12, x1: 37, z1: 18 },
  },
  bombsites: {
    A: { x0: 29, z0: 3, x1: 34, z1: 7 },
    B: { x0: 21, z0: 22, x1: 26, z1: 26 },
  },
};

export const MAPS: MapDef[] = [DEPOT];
