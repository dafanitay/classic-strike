import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuiltBox, FloorKind, MapData } from '../shared/map';
import { makeBaker } from './bake';
import { labelTexture, surface } from './textures';

/**
 * Builds static map geometry. Boxes sharing a material are merged into a
 * single mesh (a handful of draw calls for the whole map). UVs are derived
 * from world position so textures line up seamlessly across boxes.
 */

function boxGeometry(
  b: { min: THREE.Vector3Like; max: THREE.Vector3Like },
  texWorld: number,
  faces?: ('px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz')[],
  seg = 0,
  rowsAt: number[] = [],
): THREE.BufferGeometry {
  const w = b.max.x - b.min.x;
  const h = b.max.y - b.min.y;
  const d = b.max.z - b.min.z;
  // Optional subdivision gives baked lighting vertices to live on: about
  // `seg` metres across, plus vertex rows at the given heights (where the
  // contact shadow fades out, where a roof starts) between bottom and top.
  const n = (len: number) => (seg > 0 ? Math.max(1, Math.round(len / seg)) : 1);
  const rows = [...new Set(rowsAt.filter((y) => y > b.min.y + 0.05 && y < b.max.y - 0.05))].sort((a, c) => a - c);
  let geo: THREE.BufferGeometry = new THREE.BoxGeometry(w, h, d, n(w), rows.length + 1, n(d));
  geo.translate(b.min.x + w / 2, b.min.y + h / 2, b.min.z + d / 2);
  const pos = geo.getAttribute('position');
  if (rows.length) {
    // BoxGeometry spaces rows evenly; move each to its requested height.
    const step = h / (rows.length + 1);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round((pos.getY(i) - b.min.y) / step);
      if (k > 0 && k <= rows.length) pos.setY(i, rows[k - 1]);
    }
  }
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
  const baker = makeBaker(map);

  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, cast: boolean, receive: boolean, baked = true) => {
    if (!geos.length) return;
    if (baked) geos.forEach((g) => baker.apply(g));
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
  // Relief: the colour texture doubles as a bump map (mortar, grout and
  // cracks are darker, so they read as recessed). High quality only.
  const mat = (name: Parameters<typeof surface>[0], tint = 0xffffff) => {
    const tex = surface(name, aniso).map;
    return new THREE.MeshLambertMaterial({ map: tex, color: tint, vertexColors: true, bumpMap: quality === 'high' ? tex : null, bumpScale: 1.5 });
  };

  // ---- floors: one quad per area, grouped by floor kind
  const floorGeos: Record<FloorKind, THREE.BufferGeometry[]> = { sand: [], concrete: [], tile: [], dirt: [] };
  const floorTex: Record<FloorKind, Parameters<typeof surface>[0]> = { sand: 'sand', concrete: 'concrete', tile: 'tile', dirt: 'dirt' };
  // Paint floors per cell (at the cell's floor height) so overlapping areas
  // don't z-fight. Stair cells are drawn by their step boxes instead.
  for (let z = 0; z < map.def.rows; z++) {
    for (let x = 0; x < map.def.cols; x++) {
      const ai = map.areaIndex[z * map.def.cols + x];
      if (ai < 0 || map.stairAt(x, z) >= 0) continue;
      const kind = map.def.areas[ai].floor;
      const h = map.cellCenter(x, z).y;
      floorGeos[kind].push(boxGeometry({ min: { x: x * cs, y: h - 0.1, z: z * cs }, max: { x: (x + 1) * cs, y: h, z: (z + 1) * cs } }, surface(floorTex[kind]).worldSize, ['py'], 1));
    }
  }
  for (const kind of Object.keys(floorGeos) as FloorKind[]) addMerged(floorGeos[kind], mat(floorTex[kind]), false, true);

  // ---- walls: sandstone outside, plaster on walls bordering concrete interiors
  const wallGeos: THREE.BufferGeometry[] = [];
  const crateGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  const platformGeos: THREE.BufferGeometry[] = [];
  const stepGeos: THREE.BufferGeometry[] = [];
  const wallTex = surface('wall').worldSize;
  // Heights where the light changes along a vertical face: just above each
  // floor level (contact shadow) and at each roof's underside.
  const roofYs = map.def.roofs.flatMap((r) => [r.height - 0.08, r.height + 0.03]);
  const floorYs = [0, ...(map.def.levels ?? []).map((l) => l.height)];
  const rowsFor = (b: BuiltBox) => [...floorYs.filter((y) => y >= b.min.y - 0.01).map((y) => y + 0.9), ...roofYs];
  for (const b of map.boxes as BuiltBox[]) {
    if (b.kind === 'wall') wallGeos.push(boxGeometry(b, wallTex, ['px', 'nx', 'pz', 'nz', 'py'], 2, rowsFor(b)));
    else if (b.kind === 'crate') crateGeos.push(boxGeometry(b, surface('crate').worldSize, undefined, 0.5, [b.min.y + 0.5]));
    else if (b.kind === 'roof') roofGeos.push(boxGeometry(b, surface('roof').worldSize, undefined, 2));
    // Raised floors: only the sides (the top is the painted floor above).
    else if (b.kind === 'platform') platformGeos.push(boxGeometry(b, wallTex, ['px', 'nx', 'pz', 'nz'], 2));
    else if (b.kind === 'step') stepGeos.push(boxGeometry(b, surface('concrete').worldSize, ['px', 'nx', 'pz', 'nz', 'py']));
  }
  addMerged(wallGeos, mat('wall'), true, true);
  addMerged(crateGeos, mat('crate'), true, true);
  addMerged(roofGeos, mat('roof', 0xbbbbbb), true, true);
  // Darker than the floors so ledge edges read clearly from above and below.
  addMerged(platformGeos, mat('wall', 0x9c8a70), true, true);
  addMerged(stepGeos, mat('concrete', 0xd6d0c4), true, true);

  // Ledge lips: a thin dark band along every raised edge, so a drop is
  // visible at a glance (stair edges are left plain).
  const lipGeos: THREE.BufferGeometry[] = [];
  for (const b of map.boxes as BuiltBox[]) {
    if (b.kind !== 'platform') continue;
    lipGeos.push(boxGeometry({ min: { x: b.min.x - 0.02, y: b.max.y - 0.06, z: b.min.z - 0.02 }, max: { x: b.max.x + 0.02, y: b.max.y + 0.005, z: b.max.z + 0.02 } }, 2, ['px', 'nx', 'pz', 'nz']));
  }
  addMerged(lipGeos, new THREE.MeshLambertMaterial({ color: 0x5a4a36 }), false, false, false);

  // ---- wall trim: a darker band at the top edge of every wall for readability
  const trimGeos: THREE.BufferGeometry[] = [];
  for (const b of map.boxes) {
    if (b.kind !== 'wall') continue;
    trimGeos.push(boxGeometry({ min: { x: b.min.x - 0.05, y: b.max.y - 0.35, z: b.min.z - 0.05 }, max: { x: b.max.x + 0.05, y: b.max.y, z: b.max.z + 0.05 } }, 2, ['px', 'nx', 'pz', 'nz', 'py']));
  }
  addMerged(trimGeos, new THREE.MeshLambertMaterial({ color: 0x6e5a40 }), false, false, false);

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
    decal(labelTexture(site), 5, new THREE.Vector3(c.x, c.y + 0.02, c.z), -Math.PI / 2);
  }
  // Signs are placed on the wall face nearest to junction cells.
  const addSign = (text: string, cx: number, cz: number) => {
    // Find an adjacent wall to stick the sign on.
    const dirs: [number, number, number][] = [[0, -1, 0], [0, 1, Math.PI], [1, 0, -Math.PI / 2], [-1, 0, Math.PI / 2]];
    for (const [dx, dz, rot] of dirs) {
      if (map.cell(cx + dx, cz + dz) !== 0) continue;
      const c = map.cellCenter(cx, cz);
      const pos = new THREE.Vector3(c.x + dx * (cs / 2 - 0.02), c.y + 2.4, c.z + dz * (cs / 2 - 0.02));
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

/**
 * Vertex-coloured sky dome (no textures, no shaders): a dusty horizon, a
 * deeper blue overhead and a warm glow around the sun, so the light in the
 * scene has a visible source.
 */
export function buildSky(sunDir?: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 48, 24);
  const colors: number[] = [];
  const top = new THREE.Color(0x5a86bd);
  const horizon = new THREE.Color(0xe0cfa8);
  const glow = new THREE.Color(0xfff1d0);
  const sun = sunDir?.clone().normalize();
  const pos = geo.getAttribute('position');
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 400);
    const c = horizon.clone().lerp(top, Math.pow(t, 0.55));
    if (sun) {
      const a = Math.max(0, p.fromBufferAttribute(pos, i).normalize().dot(sun));
      c.lerp(glow, Math.min(1, Math.pow(a, 6) * 0.45 + Math.pow(a, 40) * 0.6));
    }
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  mesh.renderOrder = -1;
  return mesh;
}
