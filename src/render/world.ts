import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuiltBox, FloorKind, MapData } from '../shared/map';
import { labelTexture, surface } from './textures';

/**
 * Builds static map geometry. Boxes sharing a material are merged into a
 * single mesh (a handful of draw calls for the whole map). UVs are derived
 * from world position so textures line up seamlessly across boxes.
 */

function boxGeometry(b: { min: THREE.Vector3Like; max: THREE.Vector3Like }, texWorld: number, faces?: ('px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz')[]): THREE.BufferGeometry {
  const w = b.max.x - b.min.x;
  const h = b.max.y - b.min.y;
  const d = b.max.z - b.min.z;
  let geo: THREE.BufferGeometry = new THREE.BoxGeometry(w, h, d);
  geo.translate(b.min.x + w / 2, b.min.y + h / 2, b.min.z + d / 2);
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    if (nx > 0.5) uv.setXY(i, z / texWorld, y / texWorld);
    else if (ny > 0.5) uv.setXY(i, x / texWorld, z / texWorld);
    else uv.setXY(i, x / texWorld, y / texWorld);
  }
  if (faces) {
    // Keep only requested faces (BoxGeometry groups are px,nx,py,ny,pz,nz).
    const order = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const idx = geo.getIndex()!;
    const keep: number[] = [];
    geo.groups.forEach((g, gi) => {
      if (!faces.includes(order[gi] as never)) return;
      for (let k = g.start; k < g.start + g.count; k++) keep.push(idx.getX(k));
    });
    geo.setIndex(keep);
    geo.clearGroups();
  }
  geo = geo.toNonIndexed();
  return geo;
}

export interface WorldMeshes {
  group: THREE.Group;
  dispose(): void;
}

export function buildWorld(map: MapData, quality: 'low' | 'medium' | 'high'): WorldMeshes {
  const group = new THREE.Group();
  const aniso = quality === 'high' ? 8 : quality === 'medium' ? 4 : 1;
  const shadows = quality !== 'low';
  const disposables: { dispose(): void }[] = [];
  const cs = map.def.cellSize;

  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, cast: boolean, receive: boolean) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast && shadows;
    mesh.receiveShadow = receive && shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    disposables.push(merged, mat);
  };
  const mat = (name: Parameters<typeof surface>[0], tint = 0xffffff) =>
    new THREE.MeshLambertMaterial({ map: surface(name, aniso).map, color: tint });

  // ---- floors: one quad per area, grouped by floor kind
  const floorGeos: Record<FloorKind, THREE.BufferGeometry[]> = { sand: [], concrete: [], tile: [], dirt: [] };
  const floorTex: Record<FloorKind, Parameters<typeof surface>[0]> = { sand: 'sand', concrete: 'concrete', tile: 'tile', dirt: 'dirt' };
  // Paint floors per cell so overlapping areas don't z-fight.
  for (let z = 0; z < map.def.rows; z++) {
    for (let x = 0; x < map.def.cols; x++) {
      const ai = map.areaIndex[z * map.def.cols + x];
      if (ai < 0) continue;
      const kind = map.def.areas[ai].floor;
      floorGeos[kind].push(boxGeometry({ min: { x: x * cs, y: -0.1, z: z * cs }, max: { x: (x + 1) * cs, y: 0, z: (z + 1) * cs } }, surface(floorTex[kind]).worldSize, ['py']));
    }
  }
  for (const kind of Object.keys(floorGeos) as FloorKind[]) addMerged(floorGeos[kind], mat(floorTex[kind]), false, true);

  // ---- walls: sandstone outside, plaster on walls bordering concrete interiors
  const wallGeos: THREE.BufferGeometry[] = [];
  const crateGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  const wallTex = surface('wall').worldSize;
  for (const b of map.boxes as BuiltBox[]) {
    if (b.kind === 'wall') wallGeos.push(boxGeometry(b, wallTex, ['px', 'nx', 'pz', 'nz', 'py']));
    else if (b.kind === 'crate') crateGeos.push(boxGeometry(b, surface('crate').worldSize));
    else if (b.kind === 'roof') roofGeos.push(boxGeometry(b, surface('roof').worldSize));
  }
  addMerged(wallGeos, mat('wall'), true, true);
  addMerged(crateGeos, mat('crate'), true, true);
  addMerged(roofGeos, mat('roof', 0xbbbbbb), true, true);

  // ---- wall trim: a darker band at the top edge of every wall for readability
  const trimGeos: THREE.BufferGeometry[] = [];
  for (const b of map.boxes) {
    if (b.kind !== 'wall') continue;
    trimGeos.push(boxGeometry({ min: { x: b.min.x - 0.05, y: b.max.y - 0.35, z: b.min.z - 0.05 }, max: { x: b.max.x + 0.05, y: b.max.y, z: b.max.z + 0.05 } }, 2, ['px', 'nx', 'pz', 'nz', 'py']));
  }
  addMerged(trimGeos, new THREE.MeshLambertMaterial({ color: 0x6e5a40 }), false, false);

  // ---- landmarks: painted bombsite letters + direction signs
  const decal = (tex: THREE.Texture, size: number, pos: THREE.Vector3, rotX: number, rotY = 0) => {
    const m = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
    mesh.position.copy(pos);
    mesh.rotation.set(rotX, rotY, 0, 'YXZ');
    mesh.receiveShadow = shadows;
    group.add(mesh);
    disposables.push(mesh.geometry, m, tex);
  };
  for (const site of ['A', 'B'] as const) {
    const c = map.rectCenter(map.def.bombsites[site]);
    decal(labelTexture(site), 5, new THREE.Vector3(c.x, 0.02, c.z), -Math.PI / 2);
  }
  // Signs are placed on the wall face nearest to junction cells.
  const addSign = (text: string, cx: number, cz: number) => {
    // Find an adjacent wall to stick the sign on.
    const dirs: [number, number, number][] = [[0, -1, 0], [0, 1, Math.PI], [1, 0, -Math.PI / 2], [-1, 0, Math.PI / 2]];
    for (const [dx, dz, rot] of dirs) {
      if (map.cell(cx + dx, cz + dz) !== 0) continue;
      const c = map.cellCenter(cx, cz);
      const pos = new THREE.Vector3(c.x + dx * (cs / 2 - 0.02), 2.4, c.z + dz * (cs / 2 - 0.02));
      decal(labelTexture(text, '#f2e3c0', 'rgba(40,30,20,0.85)'), 1.4, pos, 0, rot);
      return;
    }
  };
  addSign('A →', 7, 4);
  addSign('A', 20, 8);
  addSign('B', 7, 23);
  addSign('MID', 17, 13);
  addSign('A', 33, 11);
  addSign('B', 33, 19);

  return {
    group,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/** Simple vertex-coloured sky dome (no textures, no shaders). */
export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 24, 12);
  const colors: number[] = [];
  const top = new THREE.Color(0x6f95c2);
  const horizon = new THREE.Color(0xe0cfa8);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 400);
    const c = horizon.clone().lerp(top, Math.pow(t, 0.6));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  mesh.renderOrder = -1;
  return mesh;
}
