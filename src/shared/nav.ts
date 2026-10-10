import type { MapData } from './map';
import type { Vec3 } from './vec';

/**
 * Bot navigation over the map's cell grid (every walkable cell is a node,
 * 8-connected, diagonals only when both orthogonal neighbours are open so
 * paths never clip a wall corner). Paths are string-pulled afterwards so
 * bots walk straight lines across open areas instead of zig-zagging.
 */
export class NavGrid {
  private readonly map: MapData;
  private readonly cols: number;
  private readonly rows: number;
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly parent: Int32Array;
  private readonly state: Uint8Array; // 0 unseen, 1 open, 2 closed
  private readonly heap: number[] = [];

  constructor(map: MapData) {
    this.map = map;
    this.cols = map.def.cols;
    this.rows = map.def.rows;
    const n = this.cols * this.rows;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.state = new Uint8Array(n);
  }

  /** Nearest walkable cell to a world position (spiral search). */
  nearestWalkable(p: { x: number; z: number }): { x: number; z: number } | null {
    const c = this.map.cellOf(p);
    if (this.map.walkable(c.x, c.z)) return c;
    for (let r = 1; r < 6; r++) {
      let best: { x: number; z: number } | null = null;
      let bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!this.map.walkable(c.x + dx, c.z + dz)) continue;
          const cc = this.map.cellCenter(c.x + dx, c.z + dz);
          const d = Math.hypot(cc.x - p.x, cc.z - p.z);
          if (d < bestD) {
            bestD = d;
            best = { x: c.x + dx, z: c.z + dz };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** A* from world position to world position. Returns waypoints (excluding start). */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const s = this.nearestWalkable(from);
    const t = this.nearestWalkable(to);
    if (!s || !t) return null;
    const cols = this.cols;
    const start = s.z * cols + s.x;
    const goal = t.z * cols + t.x;
    this.state.fill(0);
    this.heap.length = 0;
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - t.x);
      const dz = Math.abs(Math.floor(i / cols) - t.z);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    this.g[start] = 0;
    this.f[start] = h(start);
    this.parent[start] = -1;
    this.state[start] = 1;
    this.push(start);
    let found = false;
    while (this.heap.length) {
      const cur = this.pop();
      if (this.state[cur] === 2) continue;
      if (cur === goal) {
        found = true;
        break;
      }
      this.state[cur] = 2;
      const cx = cur % cols;
      const cz = Math.floor(cur / cols);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.map.walkable(nx, nz)) continue;
          if (dx && dz && (!this.map.walkable(cx + dx, cz) || !this.map.walkable(cx, cz + dz))) continue;
          const ni = nz * cols + nx;
          if (this.state[ni] === 2) continue;
          const ng = this.g[cur] + (dx && dz ? 1.4142 : 1);
          if (this.state[ni] === 1 && ng >= this.g[ni]) continue;
          this.g[ni] = ng;
          this.f[ni] = ng + h(ni);
          this.parent[ni] = cur;
          this.state[ni] = 1;
          this.push(ni);
        }
      }
    }
    if (!found) return null;
    const cells: number[] = [];
    for (let i = goal; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this.map.cellCenter(i % cols, Math.floor(i / cols)));
    pts[pts.length - 1] = { x: to.x, y: 0, z: to.z };
    if (!this.walkableLine(pts[pts.length - 1], pts[Math.max(0, pts.length - 2)])) pts[pts.length - 1] = this.map.cellCenter(t.x, t.z);
    return this.smooth({ x: from.x, y: 0, z: from.z }, pts);
  }

  /** Greedy string pulling. */
  private smooth(start: Vec3, pts: Vec3[]): Vec3[] {
    const out: Vec3[] = [];
    let anchor = start;
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.walkableLine(anchor, pts[j])) j--;
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out;
  }

  /** True if a hull of `radius` can walk the straight segment a -> b. */
  walkableLine(a: { x: number; z: number }, b: { x: number; z: number }, radius = 0.5): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(d / 0.25));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      for (const [ox, oz] of OFFSETS) {
        const c = this.map.cellOf({ x: x + ox * radius, z: z + oz * radius });
        if (!this.map.walkable(c.x, c.z)) return false;
      }
    }
    return true;
  }

  /** All walkable cell centres, optionally filtered to a rect. */
  cellsIn(r?: { x0: number; z0: number; x1: number; z1: number }): Vec3[] {
    const out: Vec3[] = [];
    for (let z = 0; z < this.rows; z++) {
      for (let x = 0; x < this.cols; x++) {
        if (!this.map.walkable(x, z)) continue;
        if (r && (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1)) continue;
        out.push(this.map.cellCenter(x, z));
      }
    }
    return out;
  }

  private push(i: number): void {
    const hp = this.heap;
    hp.push(i);
    let k = hp.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[hp[p]] <= this.f[hp[k]]) break;
      [hp[p], hp[k]] = [hp[k], hp[p]];
      k = p;
    }
  }

  private pop(): number {
    const hp = this.heap;
    const top = hp[0];
    const last = hp.pop()!;
    if (hp.length) {
      hp[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < hp.length && this.f[hp[l]] < this.f[hp[m]]) m = l;
        if (r < hp.length && this.f[hp[r]] < this.f[hp[m]]) m = r;
        if (m === k) break;
        [hp[m], hp[k]] = [hp[k], hp[m]];
        k = m;
      }
    }
    return top;
  }
}

const OFFSETS: [number, number][] = [
  [0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
