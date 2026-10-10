import type { AABB } from './collision';
import { CollisionWorld } from './collision';
import type { Vec3 } from './vec';

/**
 * Maps are authored on a coarse grid: everything starts solid and walkable
 * space is carved out with rectangles. This guarantees there are no gaps in
 * the outer shell, makes every map automatically navigable by bots (the grid
 * IS the navigation graph), and keeps collision an exact set of boxes.
 *
 * Elevation is 2.5D: every walkable cell has exactly one floor surface.
 * `levels` raise whole cells to a height; `stairs` rise across a rectangle
 * in one direction, built from steps low enough to walk up (see
 * PHYS.stepHeight). There are no overpasses (a cell can't be walked both
 * over and under).
 */

export type Team = 'A' | 'D';
export type FloorKind = 'sand' | 'concrete' | 'tile' | 'dirt';

export interface CellRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Area extends CellRect {
  name: string;
  floor: FloorKind;
}

/** Direction a staircase climbs toward (N = -z, S = +z, E = +x, W = -x). */
export type StairDir = 'N' | 'S' | 'E' | 'W';

export interface Stairs extends CellRect {
  dir: StairDir;
  /** Floor height where the stairs start and where they arrive. */
  from: number;
  to: number;
}

/** Highest rise of a single stair step (well under PHYS.stepHeight = 0.457 m). */
export const STAIR_RISE = 0.2;

export interface MapDef {
  id: string;
  name: string;
  description: string;
  cellSize: number;
  cols: number;
  rows: number;
  wallHeight: number;
  areas: Area[];
  /** Cells re-filled with wall after carving (door frames, pillars). */
  fills: { x: number; z: number }[];
  crates: { x: number; z: number; tall?: boolean }[];
  roofs: (CellRect & { height: number })[];
  /** Raised floors. Later entries override earlier ones. */
  levels?: (CellRect & { height: number })[];
  stairs?: Stairs[];
  spawns: Record<Team, { x: number; z: number }[]>;
  buyZones: Record<Team, CellRect>;
  bombsites: Record<'A' | 'B', CellRect>;
}

export const CELL_SOLID = 0;
export const CELL_FLOOR = 1;
export const CELL_CRATE_LOW = 2;
export const CELL_CRATE_TALL = 3;

export const CRATE_LOW_H = 1.0;
export const CRATE_TALL_H = 2.1;

export interface BuiltBox extends AABB {
  kind: 'wall' | 'crate' | 'roof' | 'floor' | 'platform' | 'step';
}

export interface MapData {
  def: MapDef;
  grid: Uint8Array;
  areaIndex: Int16Array;
  boxes: BuiltBox[];
  world: CollisionWorld;
  /** World-space centre of a cell, on its floor surface. */
  cellCenter(x: number, z: number): Vec3;
  /** Height of the walkable surface at a world X/Z (0 outside raised areas). */
  surfaceY(p: { x: number; z: number }): number;
  /** Index into def.stairs for a cell, or -1. */
  stairAt(x: number, z: number): number;
  cellOf(p: { x: number; z: number }): { x: number; z: number };
  cell(x: number, z: number): number;
  walkable(x: number, z: number): boolean;
  areaNameAt(p: { x: number; z: number }): string;
  inRect(p: { x: number; z: number }, r: CellRect): boolean;
  /** Centre of a rect, on the floor surface of its middle cell. */
  rectCenter(r: CellRect): Vec3;
}

interface StairGeom {
  def: Stairs;
  /** Run length (m) and step count/depth along the climbing direction. */
  run: number;
  steps: number;
  depth: number;
}

function stairGeom(def: Stairs, cs: number): StairGeom {
  const along = def.dir === 'N' || def.dir === 'S' ? def.z1 - def.z0 + 1 : def.x1 - def.x0 + 1;
  const run = along * cs;
  const steps = Math.max(1, Math.ceil(Math.abs(def.to - def.from) / STAIR_RISE - 1e-9));
  return { def, run, steps, depth: run / steps };
}

/** Distance (m) travelled up the stairs at world X/Z, from the low edge. */
function stairOffset(g: StairGeom, p: { x: number; z: number }, cs: number): number {
  const d = g.def;
  switch (d.dir) {
    case 'E': return p.x - d.x0 * cs;
    case 'W': return (d.x1 + 1) * cs - p.x;
    case 'S': return p.z - d.z0 * cs;
    case 'N': return (d.z1 + 1) * cs - p.z;
  }
}

/** Surface height of step k (1-based). */
const stepTop = (g: StairGeom, k: number): number => g.def.from + ((g.def.to - g.def.from) * k) / g.steps;

export function buildMap(def: MapDef): MapData {
  const { cols, rows, cellSize: cs } = def;
  const grid = new Uint8Array(cols * rows);
  const areaIndex = new Int16Array(cols * rows).fill(-1);
  def.areas.forEach((a, ai) => {
    for (let z = a.z0; z <= a.z1; z++) {
      for (let x = a.x0; x <= a.x1; x++) {
        if (x <= 0 || z <= 0 || x >= cols - 1 || z >= rows - 1) {
          throw new Error(`Area ${a.name} touches the map border at ${x},${z}`);
        }
        grid[z * cols + x] = CELL_FLOOR;
        areaIndex[z * cols + x] = ai;
      }
    }
  });
  for (const f of def.fills) grid[f.z * cols + f.x] = CELL_SOLID;
  for (const c of def.crates) {
    if (grid[c.z * cols + c.x] !== CELL_FLOOR) throw new Error(`Crate at ${c.x},${c.z} is not on floor`);
    grid[c.z * cols + c.x] = c.tall ? CELL_CRATE_TALL : CELL_CRATE_LOW;
  }

  // Floor heights (flat cells) and stair membership.
  const height = new Float32Array(cols * rows);
  for (const l of def.levels ?? []) {
    for (let z = l.z0; z <= l.z1; z++) for (let x = l.x0; x <= l.x1; x++) height[z * cols + x] = l.height;
  }
  const stairIdx = new Int16Array(cols * rows).fill(-1);
  const stairs = (def.stairs ?? []).map((st) => stairGeom(st, cs));
  stairs.forEach((g, si) => {
    const st = g.def;
    if (st.from < 0 || st.to < 0) throw new Error('Stairs cannot go below the ground floor');
    for (let z = st.z0; z <= st.z1; z++) {
      for (let x = st.x0; x <= st.x1; x++) {
        if (grid[z * cols + x] !== CELL_FLOOR) throw new Error(`Stairs at ${x},${z} must be on open floor`);
        stairIdx[z * cols + x] = si;
      }
    }
  });
  for (const l of def.levels ?? []) if (l.height < 0) throw new Error('Levels cannot go below the ground floor');
  // A stair cell's centre is under higher steps: a body spawned there would
  // start inside a step box.
  for (const team of ['A', 'D'] as const) {
    for (const sp of def.spawns[team]) {
      if (grid[sp.z * cols + sp.x] !== CELL_FLOOR || stairIdx[sp.z * cols + sp.x] >= 0) {
        throw new Error(`Spawn ${team} at ${sp.x},${sp.z} must be on open, flat floor`);
      }
    }
  }

  const boxes: BuiltBox[] = [];
  // Floor slab under the whole map.
  boxes.push({ kind: 'floor', min: { x: 0, y: -1, z: 0 }, max: { x: cols * cs, y: 0, z: rows * cs } });

  // Greedy rectangle merge of solid cells into as few wall boxes as possible.
  const used = new Uint8Array(cols * rows);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (grid[i] !== CELL_SOLID || used[i]) continue;
      let w = 1;
      while (x + w < cols && grid[z * cols + x + w] === CELL_SOLID && !used[z * cols + x + w]) w++;
      let h = 1;
      outer: while (z + h < rows) {
        for (let k = 0; k < w; k++) {
          const j = (z + h) * cols + x + k;
          if (grid[j] !== CELL_SOLID || used[j]) break outer;
        }
        h++;
      }
      for (let dz = 0; dz < h; dz++) for (let k = 0; k < w; k++) used[(z + dz) * cols + x + k] = 1;
      boxes.push({
        kind: 'wall',
        min: { x: x * cs, y: 0, z: z * cs },
        max: { x: (x + w) * cs, y: def.wallHeight, z: (z + h) * cs },
      });
    }
  }

  // Raised floors: greedy-merge open cells of equal height into blocks.
  const raised = (i: number) => grid[i] !== CELL_SOLID && stairIdx[i] < 0 && height[i] > 0;
  used.fill(0);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (!raised(i) || used[i]) continue;
      const h0 = height[i];
      const same = (j: number) => raised(j) && !used[j] && height[j] === h0;
      let w = 1;
      while (x + w < cols && same(z * cols + x + w)) w++;
      let h = 1;
      outer2: while (z + h < rows) {
        for (let k = 0; k < w; k++) if (!same((z + h) * cols + x + k)) break outer2;
        h++;
      }
      for (let dz = 0; dz < h; dz++) for (let k = 0; k < w; k++) used[(z + dz) * cols + x + k] = 1;
      boxes.push({ kind: 'platform', min: { x: x * cs, y: 0, z: z * cs }, max: { x: (x + w) * cs, y: h0, z: (z + h) * cs } });
    }
  }

  // Stairs: one box per step, each spanning the full width of the flight.
  for (const g of stairs) {
    const st = g.def;
    for (let k = 1; k <= g.steps; k++) {
      const top = stepTop(g, k);
      if (top <= 0) continue;
      const a = (k - 1) * g.depth;
      const b = k * g.depth;
      let min: Vec3;
      let max: Vec3;
      if (st.dir === 'E') { min = { x: st.x0 * cs + a, y: 0, z: st.z0 * cs }; max = { x: st.x0 * cs + b, y: top, z: (st.z1 + 1) * cs }; }
      else if (st.dir === 'W') { min = { x: (st.x1 + 1) * cs - b, y: 0, z: st.z0 * cs }; max = { x: (st.x1 + 1) * cs - a, y: top, z: (st.z1 + 1) * cs }; }
      else if (st.dir === 'S') { min = { x: st.x0 * cs, y: 0, z: st.z0 * cs + a }; max = { x: (st.x1 + 1) * cs, y: top, z: st.z0 * cs + b }; }
      else { min = { x: st.x0 * cs, y: 0, z: (st.z1 + 1) * cs - b }; max = { x: (st.x1 + 1) * cs, y: top, z: (st.z1 + 1) * cs - a }; }
      boxes.push({ kind: 'step', min, max });
    }
  }

  // Crates are slightly inset from the cell so two players can't get wedged.
  // They stand on whatever floor height their cell has.
  const inset = cs * 0.1;
  for (const c of def.crates) {
    const base = height[c.z * cols + c.x];
    boxes.push({
      kind: 'crate',
      min: { x: c.x * cs + inset, y: base, z: c.z * cs + inset },
      max: { x: (c.x + 1) * cs - inset, y: base + (c.tall ? CRATE_TALL_H : CRATE_LOW_H), z: (c.z + 1) * cs - inset },
    });
  }
  for (const r of def.roofs) {
    boxes.push({
      kind: 'roof',
      min: { x: r.x0 * cs, y: r.height, z: r.z0 * cs },
      max: { x: (r.x1 + 1) * cs, y: r.height + 0.4, z: (r.z1 + 1) * cs },
    });
  }

  const world = new CollisionWorld(boxes);
  const cell = (x: number, z: number): number =>
    x < 0 || z < 0 || x >= cols || z >= rows ? CELL_SOLID : grid[z * cols + x];
  const cellOf = (p: { x: number; z: number }) => ({ x: Math.floor(p.x / cs), z: Math.floor(p.z / cs) });
  const surfaceY = (p: { x: number; z: number }): number => {
    const cx = Math.floor(p.x / cs);
    const cz = Math.floor(p.z / cs);
    if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return 0;
    const i = cz * cols + cx;
    const si = stairIdx[i];
    if (si < 0) return height[i];
    const g = stairs[si];
    const k = Math.min(g.steps, Math.max(1, Math.floor(stairOffset(g, p, cs) / g.depth) + 1));
    return Math.max(0, stepTop(g, k));
  };
  const cellCenter = (x: number, z: number): Vec3 => {
    const c = { x: (x + 0.5) * cs, z: (z + 0.5) * cs };
    return { x: c.x, y: surfaceY(c), z: c.z };
  };

  return {
    def,
    grid,
    areaIndex,
    boxes,
    world,
    cellCenter,
    surfaceY,
    stairAt: (x, z) => (x < 0 || z < 0 || x >= cols || z >= rows ? -1 : stairIdx[z * cols + x]),
    cellOf,
    cell,
    walkable: (x, z) => cell(x, z) === CELL_FLOOR,
    areaNameAt: (p) => {
      const c = cellOf(p);
      if (c.x < 0 || c.z < 0 || c.x >= cols || c.z >= rows) return '';
      const ai = areaIndex[c.z * cols + c.x];
      return ai >= 0 ? def.areas[ai].name : '';
    },
    inRect: (p, r) => {
      const c = cellOf(p);
      return c.x >= r.x0 && c.x <= r.x1 && c.z >= r.z0 && c.z <= r.z1;
    },
    rectCenter: (r) => {
      const c = { x: ((r.x0 + r.x1 + 1) / 2) * cs, z: ((r.z0 + r.z1 + 1) / 2) * cs };
      return { x: c.x, y: surfaceY(c), z: c.z };
    },
  };
}
