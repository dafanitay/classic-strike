import * as THREE from 'three';
import type { MapData, Team } from '../shared/map';
import type { Quality } from '../settings';
import { Avatar } from './characters';
import { Effects } from './effects';
import { ViewModel, flashTexture, puffTexture } from './viewmodel';
import { buildSky, buildWorld, type WorldMeshes } from './world';

/** Owns the Three.js renderer, the world scene and all visual objects. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(90, 1, 0.05, 600);
  readonly viewmodel: ViewModel;
  readonly effects: Effects;
  readonly muzzleLight = new THREE.PointLight(0xffc070, 0, 9, 2);
  private readonly sun = new THREE.DirectionalLight(0xfff0d6, 2.2);
  private readonly map: MapData;
  private world: WorldMeshes | null = null;
  private quality: Quality;
  private readonly avatars = new Map<number, { avatar: Avatar; team: Team }>();

  constructor(canvas: HTMLCanvasElement, map: MapData, quality: Quality) {
    this.map = map;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const w = map.def.cols * map.def.cellSize;
    const d = map.def.rows * map.def.cellSize;
    this.scene.fog = new THREE.Fog(0xd8c8a4, 60, 180);
    this.scene.background = new THREE.Color(0xd8c8a4);
    this.scene.add(buildSky());
    this.scene.add(new THREE.HemisphereLight(0xdfe6ef, 0x7a6248, 1.25));
    this.sun.position.set(w / 2 - 30, 60, d / 2 - 22);
    this.sun.target.position.set(w / 2, 0, d / 2);
    const cam = this.sun.shadow.camera;
    cam.left = -w * 0.62;
    cam.right = w * 0.62;
    cam.top = d * 0.75;
    cam.bottom = -d * 0.75;
    cam.near = 10;
    cam.far = 160;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.muzzleLight);
    this.scene.add(this.camera);
    this.camera.rotation.order = 'YXZ';

    const flash = flashTexture();
    this.viewmodel = new ViewModel(flash);
    this.effects = new Effects(puffTexture(), flash);
    this.scene.add(this.effects.group);
    this.applyQuality(quality);
    this.resize();
  }

  applyQuality(q: Quality): void {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1.25) : Math.min(dpr, 2));
    const shadows = q !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.setScalar(q === 'high' ? 4096 : 2048);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    if (this.world) {
      this.scene.remove(this.world.group);
      this.world.dispose();
    }
    this.world = buildWorld(this.map, q);
    this.scene.add(this.world.group);
    for (const { avatar } of this.avatars.values()) avatar.root.traverse((o) => ((o as THREE.Mesh).castShadow = shadows));
    this.resize();
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodel.setAspect(w / h);
  }

  setFov(horizontalDeg: number): void {
    // Settings use the classic horizontal FOV; Three.js wants vertical.
    const h = (horizontalDeg * Math.PI) / 180;
    const v = 2 * Math.atan(Math.tan(h / 2) / Math.max(this.camera.aspect, 0.1));
    const deg = (v * 180) / Math.PI;
    if (Math.abs(this.camera.fov - deg) > 0.01) {
      this.camera.fov = deg;
      this.camera.updateProjectionMatrix();
    }
  }

  avatar(id: number, team: Team): Avatar {
    let entry = this.avatars.get(id);
    if (!entry || entry.team !== team) {
      if (entry) this.removeAvatar(id);
      const avatar = new Avatar(team);
      if (this.quality === 'low') avatar.root.traverse((o) => ((o as THREE.Mesh).castShadow = false));
      this.scene.add(avatar.root);
      entry = { avatar, team };
      this.avatars.set(id, entry);
    }
    return entry.avatar;
  }

  removeAvatar(id: number): void {
    const entry = this.avatars.get(id);
    if (!entry) return;
    this.scene.remove(entry.avatar.root);
    entry.avatar.dispose();
    this.avatars.delete(id);
  }

  avatarIds(): number[] {
    return [...this.avatars.keys()];
  }

  render(showViewmodel: boolean): void {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (showViewmodel) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
    }
  }

  dispose(): void {
    for (const id of this.avatarIds()) this.removeAvatar(id);
    this.world?.dispose();
    this.renderer.dispose();
  }
}
