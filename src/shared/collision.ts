import type { Vec3 } from './vec';

/** Axis-aligned box. Every solid in a map is one of these. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface RayHit {
  t: number;
  normal: Vec3;
  box: number;
}

export interface MoveResult {
  onGround: boolean;
  hitWall: boolean;
  hitCeiling: boolean;
}

const EPS = 1e-4;

/**
 * Static collision world made of axis-aligned boxes. A uniform 2D grid over
 * X/Z buckets the boxes so queries only test nearby solids.
 */
export class CollisionWorld {
  readonly boxes: AABB[];
  private readonly bucketSize = 4;
  private readonly buckets = new Map<number, number[]>();
  private stamp = 0;
  private readonly seen: Uint32Array;

  constructor(boxes: AABB[]) {
    this.boxes = boxes;
    this.seen = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      for (let bx = this.cell(b.min.x); bx <= this.cell(b.max.x); bx++) {
        for (let bz = this.cell(b.min.z); bz <= this.cell(b.max.z); bz++) {
          const k = this.key(bx, bz);
          let list = this.buckets.get(k);
          if (!list) this.buckets.set(k, (list = []));
          list.push(i);
        }
      }
    });
  }

  private cell(v: number): number {
    return Math.floor(v / this.bucketSize);
  }

  private key(bx: number, bz: number): number {
    return (bx + 4096) * 8192 + (bz + 4096);
  }

  /** Indices of boxes whose bucket overlaps the given X/Z range. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[] = []): number[] {
    out.length = 0;
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    for (let bx = this.cell(minX); bx <= this.cell(maxX); bx++) {
      for (let bz = this.cell(minZ); bz <= this.cell(maxZ); bz++) {
        const list = this.buckets.get(this.key(bx, bz));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === this.stamp) continue;
          this.seen[i] = this.stamp;
          out.push(i);
        }
      }
    }
    return out;
  }

  /** True if a player hull at `pos` (feet centre) intersects any solid. */
  hullBlocked(pos: Vec3, halfWidth: number, height: number): boolean {
    const near = this.query(pos.x - halfWidth, pos.z - halfWidth, pos.x + halfWidth, pos.z + halfWidth, scratch);
    for (const i of near) {
      const b = this.boxes[i];
      if (
        pos.x + halfWidth > b.min.x + EPS && pos.x - halfWidth < b.max.x - EPS &&
        pos.z + halfWidth > b.min.z + EPS && pos.z - halfWidth < b.max.z - EPS &&
        pos.y + height > b.min.y + EPS && pos.y < b.max.y - EPS
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Moves a hull by `delta`, resolving one axis at a time (Y, then X, then Z).
   * Axis-separated resolution is exact for an all-AABB world and never lets a
   * hull pass through a solid as long as a single step is thinner than the
   * thinnest wall (steps are ~0.1 m; walls are >= 1 m).
   * Mutates `pos`.
   */
  moveHull(pos: Vec3, halfWidth: number, height: number, delta: Vec3): MoveResult {
    const res: MoveResult = { onGround: false, hitWall: false, hitCeiling: false };
    const near = this.query(
      pos.x - halfWidth - Math.abs(delta.x) - 1,
      pos.z - halfWidth - Math.abs(delta.z) - 1,
      pos.x + halfWidth + Math.abs(delta.x) + 1,
      pos.z + halfWidth + Math.abs(delta.z) + 1,
      scratch,
    );

    // Each axis is resolved against where the hull was *before* that axis
    // moved: a box is only blocking from the side the hull came from. A hull
    // that already overlaps a box slightly (e.g. a position rounded by the
    // network) is nudged out the shortest way instead of being teleported
    // to the far side or onto the top of a wall.
    const TOL = 0.01;

    // --- Y ---
    const prevY = pos.y;
    pos.y += delta.y;
    for (const i of near) {
      const b = this.boxes[i];
      if (!(pos.x + halfWidth > b.min.x + EPS && pos.x - halfWidth < b.max.x - EPS &&
            pos.z + halfWidth > b.min.z + EPS && pos.z - halfWidth < b.max.z - EPS)) continue;
      if (!(pos.y + height > b.min.y && pos.y < b.max.y)) continue;
      if (prevY >= b.max.y - TOL) {
        pos.y = b.max.y;
        res.onGround = true;
      } else if (prevY + height <= b.min.y + TOL) {
        pos.y = b.min.y - height;
        res.hitCeiling = true;
      }
      // Otherwise we were already inside it horizontally: X/Z resolve it.
    }

    // --- X ---
    const prevX = pos.x;
    pos.x += delta.x;
    for (const i of near) {
      const b = this.boxes[i];
      if (!(pos.y + height > b.min.y + EPS && pos.y < b.max.y - EPS &&
            pos.z + halfWidth > b.min.z + EPS && pos.z - halfWidth < b.max.z - EPS)) continue;
      if (!(pos.x + halfWidth > b.min.x && pos.x - halfWidth < b.max.x)) continue;
      if (prevX + halfWidth <= b.min.x + TOL) pos.x = b.min.x - halfWidth;
      else if (prevX - halfWidth >= b.max.x - TOL) pos.x = b.max.x + halfWidth;
      else {
        // Already inside. If that is only a graze in Z (a position rounded
        // by the network snapshot sits up to 0.5 mm inside a wall), leave it
        // to the Z pass instead of shoving the hull out sideways, possibly
        // across the whole box.
        const penZ = Math.min(pos.z + halfWidth - b.min.z, b.max.z - (pos.z - halfWidth));
        if (penZ <= TOL) continue;
        pos.x = pos.x < (b.min.x + b.max.x) / 2 ? b.min.x - halfWidth : b.max.x + halfWidth;
      }
      res.hitWall = true;
    }

    // --- Z ---
    const prevZ = pos.z;
    pos.z += delta.z;
    for (const i of near) {
      const b = this.boxes[i];
      if (!(pos.y + height > b.min.y + EPS && pos.y < b.max.y - EPS &&
            pos.x + halfWidth > b.min.x + EPS && pos.x - halfWidth < b.max.x - EPS)) continue;
      if (!(pos.z + halfWidth > b.min.z && pos.z - halfWidth < b.max.z)) continue;
      if (prevZ + halfWidth <= b.min.z + TOL) pos.z = b.min.z - halfWidth;
      else if (prevZ - halfWidth >= b.max.z - TOL) pos.z = b.max.z + halfWidth;
      else {
        // Same for a graze in X: the next tick's X pass pushes it out.
        const penX = Math.min(pos.x + halfWidth - b.min.x, b.max.x - (pos.x - halfWidth));
        if (penX <= TOL) continue;
        pos.z = pos.z < (b.min.z + b.max.z) / 2 ? b.min.z - halfWidth : b.max.z + halfWidth;
      }
      res.hitWall = true;
    }
    return res;
  }

  /** Nearest solid hit along a ray (dir need not be normalised; t is in dir units). */
  raycast(origin: Vec3, dir: Vec3, maxT: number): RayHit | null {
    const ex = origin.x + dir.x * maxT;
    const ez = origin.z + dir.z * maxT;
    const near = this.query(Math.min(origin.x, ex), Math.min(origin.z, ez), Math.max(origin.x, ex), Math.max(origin.z, ez), scratch);
    let best: RayHit | null = null;
    for (const i of near) {
      const hit = rayAabb(origin, dir, this.boxes[i], best ? best.t : maxT);
      if (hit) best = { t: hit.t, normal: hit.normal, box: i };
    }
    return best;
  }

  /** True when nothing solid lies between a and b. */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    return this.raycast(a, d, 1) === null;
  }
}

const scratch: number[] = [];

/** Slab test. Returns entry distance and face normal, or null. */
export function rayAabb(o: Vec3, d: Vec3, b: AABB, maxT: number): { t: number; normal: Vec3 } | null {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  const mins = [b.min.x, b.min.y, b.min.z];
  const maxs = [b.max.x, b.max.y, b.max.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-12) {
      if (os[a] < mins[a] || os[a] > maxs[a]) return null;
      continue;
    }
    const inv = 1 / ds[a];
    let t1 = (mins[a] - os[a]) * inv;
    let t2 = (maxs[a] - os[a]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis === -1) return null; // origin inside box: ignore (never shoot out of a wall)
  const normal = { x: 0, y: 0, z: 0 };
  if (axis === 0) normal.x = sign;
  else if (axis === 1) normal.y = sign;
  else normal.z = sign;
  return { t: tmin, normal };
}
