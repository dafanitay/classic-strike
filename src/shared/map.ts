import type { AABB } from './collision';
import { CollisionWorld } from './collision';
import type { Vec3 } from './vec';

/**
 * Maps are authored on a coarse grid: everything starts solid and walkable
 * space is carved out with rectangles. This guarantees there are no gaps in
 * the outer shell, makes every map automatically navigable by bots (the grid
 * IS the navigation graph), and keeps collision an exact set of boxes.
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
  kind: 'wall' | 'crate' | 'roof' | 'floor';
}

export interface MapData {
  def: MapDef;
  grid: Uint8Array;
  areaIndex: Int16Array;
  boxes: BuiltBox[];
  world: CollisionWorld;
  /** World-space centre of a cell (y = 0). */
  cellCenter(x: number, z: number): Vec3;
  cellOf(p: { x: number; z: number }): { x: number; z: number };
  cell(x: number, z: number): number;
  walkable(x: number, z: number): boolean;
  areaNameAt(p: { x: number; z: number }): string;
  inRect(p: { x: number; z: number }, r: CellRect): boolean;
  rectCenter(r: CellRect): Vec3;
}

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

  // Crates are slightly inset from the cell so two players can't get wedged.
  const inset = cs * 0.1;
  for (const c of def.crates) {
    boxes.push({
      kind: 'crate',
      min: { x: c.x * cs + inset, y: 0, z: c.z * cs + inset },
      max: { x: (c.x + 1) * cs - inset, y: c.tall ? CRATE_TALL_H : CRATE_LOW_H, z: (c.z + 1) * cs - inset },
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

  return {
    def,
    grid,
    areaIndex,
    boxes,
    world,
    cellCenter: (x, z) => ({ x: (x + 0.5) * cs, y: 0, z: (z + 0.5) * cs }),
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
    rectCenter: (r) => ({ x: ((r.x0 + r.x1 + 1) / 2) * cs, y: 0, z: ((r.z0 + r.z1 + 1) / 2) * cs }),
  };
}
