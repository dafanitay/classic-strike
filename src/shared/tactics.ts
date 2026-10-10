import { type MapData, type Team } from './map';
import { NavGrid } from './nav';
import type { BombSite } from './sim';
import type { Vec3 } from './vec';

/**
 * Tactical reading of a map, derived from its geometry (nothing here is
 * hand-placed): alternative routes from each spawn to each bombsite, and
 * scored positions for holding a site, controlling the middle of the map,
 * lurking, and guarding a planted bomb. Built once per map and cached.
 *
 * A "route" is a corridor of cells; routes to the same site are made to
 * differ by penalising cells near earlier routes during A* (so on Depot the
 * Attackers get, e.g., Long A and Short A to A, Tunnels and Lower Tunnel to
 * B), and a route that would mostly repeat an earlier one is dropped.
 */

export interface Route {
  /** Cell indices from spawn to the site. */
  cells: number[];
  /** String-pulled waypoints (world space) along the corridor. */
  waypoints: Vec3[];
  /** Area names the route passes through, in order (for labels / debugging). */
  areas: string[];
  /** Walking length (m). */
  length: number;
}

export interface Spot {
  pos: Vec3;
  cell: number;
  area: string;
  /** Solid or crate cells among the 8 neighbours (0–8). */
  cover: number;
  /** Combined tactical value for its purpose (higher is better). */
  value: number;
  /** Direction (yaw) to watch from here. */
  look: number;
}

export interface TacticalMap {
  map: MapData;
  nav: NavGrid;
  spawn: Record<Team, Vec3>;
  site: Record<BombSite, Vec3>;
  /** Walking distance from each spawn to every cell. */
  fromSpawn: Record<Team, Float32Array>;
  routes(team: Team, site: BombSite): Route[];
  /** Defender positions around a site, facing the Attackers' ways in. */
  holdSpots(site: BombSite): Spot[];
  /** Defender positions in the contested middle of the map. */
  midSpots(): Spot[];
  /** Attacker lurk positions part-way along a route. */
  lurkSpots(site: BombSite): Spot[];
  /** Positions overlooking a planted bomb (for either team). */
  bombSpots(bomb: Vec3, from: Team): Spot[];
  /** Where a route reaches the edge of its site: the "entry" point. */
  entryOf(route: Route): Vec3;
  coverAt(cell: number): number;
}

const EYE = 1.6;
const cache = new WeakMap<MapData, TacticalMap>();

export function tacticalMap(map: MapData): TacticalMap {
  let t = cache.get(map);
  if (!t) {
    t = build(map);
    cache.set(map, t);
  }
  return t;
}

function build(map: MapData): TacticalMap {
  const nav = new NavGrid(map);
  const { cols, rows, cellSize: cs } = map.def;
  const center = (i: number) => map.cellCenter(i % cols, Math.floor(i / cols));
  const spawn = { A: map.rectCenter(map.def.buyZones.A), D: map.rectCenter(map.def.buyZones.D) };
  const site = { A: map.rectCenter(map.def.bombsites.A), B: map.rectCenter(map.def.bombsites.B) };
  const fromSpawn = { A: nav.distanceField(spawn.A), D: nav.distanceField(spawn.D) };
  const fromSite = { A: nav.distanceField(site.A), B: nav.distanceField(site.B) };

  const cover = new Uint8Array(cols * rows);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      if (!map.walkable(x, z)) continue;
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && !map.walkable(x + dx, z + dz)) n++;
      cover[z * cols + x] = n;
    }
  }
  const eye = (p: Vec3): Vec3 => ({ x: p.x, y: p.y + EYE, z: p.z });
  const sees = (a: Vec3, b: Vec3) => map.world.lineOfSight(eye(a), eye(b));
  const yawTo = (a: Vec3, b: Vec3) => Math.atan2(-(b.x - a.x), -(b.z - a.z));

  // --------------------------------------------------------------- routes
  const routeCache = new Map<string, Route[]>();
  const routes = (team: Team, s: BombSite): Route[] => {
    const key = team + s;
    const hit = routeCache.get(key);
    if (hit) return hit;
    const out: Route[] = [];
    const cost = new Float32Array(cols * rows);
    const used = new Uint8Array(cols * rows);
    const nearEnds = (i: number) => fromSpawn[team][i] < 10 || map.inRect(center(i), padRect(map.def.bombsites[s], 2));
    for (let k = 0; k < 4 && out.length < 3; k++) {
      const cells = nav.findCells(spawn[team], site[s], cost);
      if (!cells) break;
      // How much of this route runs through corridors earlier routes used?
      const middle = cells.filter((i) => !nearEnds(i));
      const shared = middle.filter((i) => used[i]).length;
      const fresh = middle.length ? shared / middle.length < 0.6 : out.length === 0;
      if (fresh) {
        const pts = cells.map(center);
        out.push({
          cells,
          waypoints: nav.smoothPoints(spawn[team], pts),
          areas: dedupe(cells.map((i) => map.areaNameAt(center(i))).filter(Boolean)),
          length: cells.length * cs,
        });
      }
      // Discourage this corridor (and its immediate surroundings) next time.
      for (const i of cells) {
        if (nearEnds(i)) continue;
        const x = i % cols;
        const z = Math.floor(i / cols);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (z + dz) * cols + x + dx;
            if (x + dx < 0 || x + dx >= cols || z + dz < 0 || z + dz >= rows) continue;
            used[j] = 1;
            cost[j] += 4;
          }
        }
      }
    }
    // Shortest first; drop routes absurdly longer than the shortest.
    out.sort((a, b) => a.length - b.length);
    const best = out[0]?.length ?? 0;
    const kept = out.filter((r) => r.length <= best * 1.9);
    routeCache.set(key, kept);
    return kept;
  };

  const entryOf = (r: Route): Vec3 => {
    // The last route cell that is still ~8 m short of the site rect.
    const rect = r.cells.length ? siteOfRoute(r) : null;
    for (let k = r.cells.length - 1; k >= 0; k--) {
      const c = center(r.cells[k]);
      if (!rect || !map.inRect(c, padRect(rect, 3))) return c;
    }
    return center(r.cells[0]);
  };
  const siteOfRoute = (r: Route) => {
    const last = center(r.cells[r.cells.length - 1]);
    return map.inRect(last, padRect(map.def.bombsites.A, 3)) ? map.def.bombsites.A : map.def.bombsites.B;
  };

  // ---------------------------------------------------------------- spots
  const cellsWhere = (pred: (i: number) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < cols * rows; i++) {
      const x = i % cols;
      const z = Math.floor(i / cols);
      if (map.walkable(x, z) && map.stairAt(x, z) < 0 && pred(i)) out.push(i);
    }
    return out;
  };
  const spotCache = new Map<string, Spot[]>();
  const memo = (key: string, f: () => Spot[]) => {
    let v = spotCache.get(key);
    if (!v) spotCache.set(key, (v = f()));
    return v;
  };
  /** Scores cells by cover and by how many of `watch` points they see. */
  const score = (cells: number[], watch: Vec3[], extra: (i: number) => number): Spot[] =>
    cells
      .map((i) => {
        const pos = center(i);
        const seen = watch.filter((w) => sees(pos, w));
        const look = seen.length ? yawTo(pos, avg(seen)) : watch.length ? yawTo(pos, avg(watch)) : 0;
        return {
          pos,
          cell: i,
          area: map.areaNameAt(pos),
          cover: cover[i],
          value: Math.min(cover[i], 4) * 0.6 + (watch.length ? (seen.length / watch.length) * 4 : 0) + extra(i),
          look,
        };
      })
      .filter((s) => s.value > 0.5)
      .sort((a, b) => b.value - a.value);

  const holdSpots = (s: BombSite) =>
    memo('hold' + s, () => {
      const entries = routes('A', s).map(entryOf);
      const rect = map.def.bombsites[s];
      // Within ~16 m walking of the site, on the Defenders' side of it.
      const cells = cellsWhere((i) => fromSite[s][i] <= 16 && fromSpawn.D[i] <= fromSpawn.A[i] + 10);
      return score(cells, entries, (i) => (map.inRect(center(i), padRect(rect, 1)) ? 0.8 : 0) - fromSite[s][i] * 0.03);
    });

  const midSpots = () =>
    memo('mid', () => {
      // The contested middle: about equally far from both spawns, away from
      // both sites, on the Defenders' half. Watch the Attackers' routes there.
      const watch: Vec3[] = [];
      for (const s of ['A', 'B'] as const) {
        for (const r of routes('A', s)) {
          for (const i of r.cells) {
            const a = fromSpawn.A[i];
            const d = fromSpawn.D[i];
            if (Math.abs(a - d) < 8) watch.push(center(i));
          }
        }
      }
      const cells = cellsWhere((i) => {
        const a = fromSpawn.A[i];
        const d = fromSpawn.D[i];
        const c = center(i);
        const inSite = map.inRect(c, padRect(map.def.bombsites.A, 3)) || map.inRect(c, padRect(map.def.bombsites.B, 3));
        return !inSite && d < a && a - d < 18 && fromSite.A[i] > 12 && fromSite.B[i] > 12;
      });
      const sample = watch.filter((_, k) => k % 3 === 0);
      return score(cells, sample, () => 0);
    });

  const lurkSpots = (s: BombSite) =>
    memo('lurk' + s, () => {
      // Along the Attackers' routes to site `s`, 40–75% of the way, in cover:
      // close enough to threaten, far enough to stay unseen early.
      const out: number[] = [];
      for (const r of routes('A', s)) {
        const n = r.cells.length;
        for (let k = Math.floor(n * 0.4); k < Math.floor(n * 0.75); k++) out.push(r.cells[k]);
      }
      const entries = routes('A', s).map(entryOf);
      return score(dedupe(out), entries, () => 0.3);
    });

  const bombSpots = (bomb: Vec3, from: Team): Spot[] => {
    const bc = map.cellOf(bomb);
    const key = `bomb${bc.x},${bc.z}${from}`;
    return memo(key, () => {
      const field = nav.distanceField(bomb);
      const cells = cellsWhere((i) => field[i] >= 4 && field[i] <= 16);
      // Attackers guard facing where Defenders come from, and vice versa.
      const threat = from === 'A' ? spawn.D : spawn.A;
      const path = nav.findPath(bomb, threat) ?? [];
      const watch = [bomb, ...path.slice(0, 3)];
      return score(cells, watch, (i) => (sees(center(i), bomb) ? 1.2 : -1) - Math.abs(field[i] - 9) * 0.05);
    });
  };

  return {
    map,
    nav,
    spawn,
    site,
    fromSpawn,
    routes,
    holdSpots,
    midSpots,
    lurkSpots,
    bombSpots,
    entryOf,
    coverAt: (i) => cover[i],
  };
}

/**
 * Picks the best spot for one bot given where its teammates already are or
 * are going: spots near a teammate's claim are penalised (and spots in an
 * area already claimed, less so), so a team spreads over distinct places.
 * `jitter` adds controlled variety between bots and rounds.
 */
export function chooseSpot(spots: Spot[], claims: Vec3[], claimedAreas: string[], rand: () => number, opts: { minSep?: number; jitter?: number; from?: Vec3; maxTravel?: number } = {}): Spot | null {
  const minSep = opts.minSep ?? 7;
  const jitter = opts.jitter ?? 0.8;
  let best: Spot | null = null;
  let bestScore = -Infinity;
  for (const s of spots.slice(0, 60)) {
    let sc = s.value + rand() * jitter;
    for (const c of claims) {
      const d = Math.hypot(s.pos.x - c.x, s.pos.z - c.z);
      if (d < minSep) sc -= (minSep - d) * 0.9;
    }
    for (const a of claimedAreas) if (a === s.area) sc -= 0.6;
    if (opts.from && opts.maxTravel) {
      const d = Math.hypot(s.pos.x - opts.from.x, s.pos.z - opts.from.z);
      if (d > opts.maxTravel) sc -= (d - opts.maxTravel) * 0.1;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

function padRect(r: { x0: number; z0: number; x1: number; z1: number }, p: number) {
  return { x0: r.x0 - p, z0: r.z0 - p, x1: r.x1 + p, z1: r.z1 + p };
}

function dedupe<T>(a: T[]): T[] {
  const out: T[] = [];
  for (const v of a) if (out[out.length - 1] !== v && !out.includes(v)) out.push(v);
  return out;
}

function avg(ps: Vec3[]): Vec3 {
  const s = ps.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / ps.length, y: s.y / ps.length, z: s.z / ps.length };
}
