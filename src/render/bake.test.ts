import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildMap } from '../shared/map';
import { DEPOT } from '../shared/maps/depot';
import { makeBaker } from './bake';

const map = buildMap(DEPOT);
const baker = makeBaker(map);
const UP = { x: 0, y: 1, z: 0 };
const floorAt = (cx: number, cz: number, dx = 0, dz = 0) => {
  const c = map.cellCenter(cx, cz);
  return { x: c.x + dx, y: c.y, z: c.z + dz };
};

describe('baked lighting', () => {
  it('open ground is near full brightness; a roofed tunnel is much darker', () => {
    const open = baker.light(floorAt(31, 5), UP); // middle of A Site
    const tunnel = baker.light(floorAt(12, 25), UP); // under the B Tunnels roof
    const outside = baker.light(floorAt(5, 25), UP); // same lane, no roof
    expect(open).toBeGreaterThan(0.9);
    expect(tunnel).toBeLessThan(0.5);
    expect(outside).toBeGreaterThan(tunnel + 0.2);
  });

  it('floor at the foot of a wall is darker than the middle of the lane', () => {
    // Long A is cells z 2-4; the wall is the z = 1 row.
    const mid = baker.light(floorAt(12, 3), UP);
    const foot = baker.light(floorAt(12, 2, 0, -0.95), UP);
    expect(foot).toBeLessThan(mid - 0.05);
  });

  it('a tunnel wall is dark below the roof and bright above it', () => {
    const c = map.cellCenter(12, 24);
    const n = { x: 0, y: 0, z: 1 }; // north tunnel wall, facing into the tunnel
    const below = baker.light({ x: c.x, y: 2, z: c.z - 1 }, n);
    const above = baker.light({ x: c.x, y: 4.5, z: c.z - 1 }, n);
    expect(below).toBeLessThan(0.6);
    expect(above).toBeGreaterThan(0.9);
  });

  it('only colours geometry: positions are untouched and every value is in range', () => {
    const geo = new THREE.BoxGeometry(2, 5, 2, 2, 2, 2).toNonIndexed();
    geo.translate(map.cellCenter(12, 1).x, 2.5, map.cellCenter(12, 1).z);
    const before = Float32Array.from(geo.getAttribute('position').array as Float32Array);
    baker.apply(geo);
    expect(Array.from(geo.getAttribute('position').array as Float32Array)).toEqual(Array.from(before));
    const col = geo.getAttribute('color');
    expect(col.count).toBe(geo.getAttribute('position').count);
    for (let i = 0; i < col.count; i++) {
      expect(col.getX(i)).toBeGreaterThanOrEqual(0.2);
      expect(col.getX(i)).toBeLessThanOrEqual(1);
    }
  });

  it('every walkable floor cell gets a sensible value (no black holes)', () => {
    let min = 1;
    for (let z = 0; z < map.def.rows; z++)
      for (let x = 0; x < map.def.cols; x++) if (map.walkable(x, z)) min = Math.min(min, baker.light(floorAt(x, z), UP));
    expect(min).toBeGreaterThan(0.3);
  });
});
