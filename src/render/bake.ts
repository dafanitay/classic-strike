import * as THREE from 'three';
import type { MapData } from '../shared/map';
import type { Vec3 } from '../shared/vec';

/**
 * Baked lighting for the static map, stored as vertex colours (the
 * equivalent of the lightmaps the classic games shipped with, computed at
 * load time instead of shipped). Two terms, both from the collision world,
 * so they follow the real geometry:
 *
 * - Sky visibility: the share of a hemisphere of short rays around the
 *   surface normal that escape. Corridors get darker toward the floor,
 *   tunnels under a roof much darker, open yards stay bright.
 * - Contact shadow: floors darken within about a metre of a wall, crate or
 *   ledge, and wall bases darken just above the floor.
 *
 * The result multiplies all lighting of the surface (ambient and sun), which
 * is what a lightmap does. Geometry is not changed, only coloured.
 */

const RAY_LEN = 14;
/** Brightness of a surface that sees no sky at all (relative to open sky). */
const SKY_FLOOR = 0.55;

/** Fixed, roughly cosine-weighted directions on the +Y hemisphere. */
const HEMI: Vec3[] = (() => {
  const out: Vec3[] = [];
  const n = 20;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const r = Math.sqrt(u);
    const a = i * golden;
    out.push({ x: r * Math.cos(a), y: Math.sqrt(1 - u), z: r * Math.sin(a) });
  }
  return out;
})();

/** Rotates a +Y hemisphere direction onto the hemisphere around `n` (an axis-aligned unit normal). */
function orient(d: Vec3, n: Vec3): Vec3 {
  if (n.y > 0.5) return d;
  if (n.y < -0.5) return { x: d.x, y: -d.y, z: d.z };
  // Horizontal normal: local Y becomes the normal, local X stays vertical-ish.
  if (Math.abs(n.x) > 0.5) return { x: n.x * d.y, y: d.x, z: d.z };
  return { x: d.z, y: d.x, z: n.z * d.y };
}

export interface Baker {
  /** Brightness factor (0..1) for a surface point with an axis-aligned normal. */
  light(p: Vec3, n: Vec3): number;
  /** Adds a `color` attribute to a (non-indexed) geometry from its positions and normals. */
  apply(geo: THREE.BufferGeometry): void;
}

export function makeBaker(map: MapData): Baker {
  const cache = new Map<string, number>();
  const occluders = map.boxes.filter((b) => b.kind === 'wall' || b.kind === 'crate' || b.kind === 'platform');

  const sky = (p: Vec3, n: Vec3): number => {
    // Start just off the surface, and (for vertical faces) just above a floor
    // they stand on, so rays toward the ground do hit it.
    const o = { x: p.x + n.x * 0.04, y: p.y + n.y * 0.04 + (Math.abs(n.y) < 0.5 ? 0.03 : 0), z: p.z + n.z * 0.04 };
    let open = 0;
    for (const d of HEMI) {
      const r = orient(d, n);
      if (!map.world.raycast(o, r, RAY_LEN)) open++;
    }
    return open / HEMI.length;
  };

  const contact = (p: Vec3, n: Vec3): number => {
    if (n.y > 0.5) {
      // Floor: darken near the foot of anything taller than the floor here.
      let k = 1;
      for (const b of occluders) {
        if (b.max.y < p.y + 0.3 || b.min.y > p.y + 0.2) continue;
        const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
        const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
        const d = Math.hypot(dx, dz);
        if (d > 1.1) continue;
        const f = 1 - d / 1.1;
        k *= 1 - (b.kind === 'crate' ? 0.3 : 0.38) * f * f;
      }
      return Math.max(k, 0.5);
    }
    if (Math.abs(n.y) < 0.5) {
      // Wall / crate side: darken just above the floor in front of it.
      const floor = map.surfaceY({ x: p.x + n.x * 0.3, z: p.z + n.z * 0.3 });
      const h = p.y - floor;
      if (h < -0.05 || h > 0.9) return 1;
      const f = 1 - Math.max(h, 0) / 0.9;
      return 1 - 0.32 * f * f;
    }
    return 1;
  };

  const light = (p: Vec3, n: Vec3): number => {
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${n.x},${n.y},${n.z}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // Faces looking down (roof undersides) only ever get light bounced off
    // the ground; give them a dim constant instead of black.
    if (n.y < -0.5) {
      cache.set(key, 0.55);
      return 0.55;
    }
    // A vertical face with nothing in front of it still loses the lower half
    // of its hemisphere to the ground, so it is measured against that.
    const expected = Math.abs(n.y) > 0.5 ? 1 : 0.5;
    const s = Math.min(1, (sky(p, n) / expected) * 1.15);
    const v = (SKY_FLOOR + (1 - SKY_FLOOR) * s) * contact(p, n);
    cache.set(key, v);
    return v;
  };

  return {
    light,
    apply(geo) {
      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const n = { x: Math.round(nrm.getX(i)), y: Math.round(nrm.getY(i)), z: Math.round(nrm.getZ(i)) };
        const v = light({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) }, n);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    },
  };
}
