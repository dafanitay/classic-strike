import * as THREE from 'three';
import type { Team } from '../shared/map';
import { WEAPONS, type WeaponId } from '../shared/weapons';
import { gunModel } from './guns';

/**
 * First-person weapon, rendered in its own scene with its own camera after
 * the world pass (depth cleared), so it never clips into walls and keeps a
 * fixed FOV regardless of the player's FOV setting.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  private readonly holder = new THREE.Group();
  private readonly sway = new THREE.Group();
  private gun: THREE.Group | null = null;
  private gunId: WeaponId | null = null;
  private readonly flash: THREE.Sprite;
  private readonly arm: THREE.Mesh;
  private kick = 0;
  private flashT = 0;
  private bob = 0;
  private swingT = 1;
  private lastYaw = 0;
  private lastPitch = 0;
  private swayX = 0;
  private swayY = 0;

  constructor(flashTex: THREE.Texture) {
    this.scene.add(new THREE.HemisphereLight(0xfff2dd, 0x5a4a3a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-1, 2, 1);
    this.scene.add(sun);
    this.scene.add(this.camera);
    this.camera.add(this.sway);
    this.sway.add(this.holder);
    // Held low on the right, barrel angled slightly toward the crosshair.
    this.holder.position.set(0.15, -0.165, -0.42);
    this.holder.rotation.set(0.02, 0.06, 0);
    this.arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.34), new THREE.MeshLambertMaterial({ color: 0x6d6044 }));
    this.arm.position.set(0.03, -0.085, 0.2);
    this.arm.rotation.set(0.35, 0.1, 0);
    this.holder.add(this.arm);
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.07), new THREE.MeshLambertMaterial({ color: 0x2a2620 }));
    glove.position.set(0.0, -0.045, 0.035);
    this.holder.add(glove);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffd28a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.visible = false;
    this.flash.scale.setScalar(0.18);
  }

  setTeam(team: Team): void {
    (this.arm.material as THREE.MeshLambertMaterial).color.setHex(team === 'A' ? 0x6d6044 : 0x2f4260);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(id: WeaponId): void {
    if (this.gunId === id) return;
    if (this.gun) {
      this.holder.remove(this.gun);
      this.gun.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    }
    this.gunId = id;
    this.gun = gunModel(id, WEAPONS[id].cls, true);
    this.gun.scale.setScalar(0.85);
    this.holder.add(this.gun);
    const m = this.gun.getObjectByName('muzzle')!;
    m.add(this.flash);
  }

  onFire(): void {
    if (!this.gunId) return;
    const cls = WEAPONS[this.gunId].cls;
    if (cls === 'melee') {
      this.swingT = 0;
      return;
    }
    this.kick = Math.min(1, this.kick + (cls === 'sniper' || cls === 'shotgun' ? 1 : 0.55));
    this.flashT = 0.045;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.scale.setScalar(cls === 'pistol' ? 0.14 : cls === 'smg' ? 0.16 : 0.22 + Math.random() * 0.06);
  }

  /**
   * reload: 0..1 progress or -1. draw: seconds since weapon was drawn.
   */
  update(dt: number, s: { speed: number; onGround: boolean; reload: number; draw: number; yaw: number; pitch: number; visible: boolean }): void {
    this.holder.visible = s.visible;
    if (!this.gun) return;
    this.kick = Math.max(0, this.kick - dt * 7);
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0 && s.visible;
    this.swingT = Math.min(1, this.swingT + dt * 3.2);

    // Walk bob.
    const moving = s.onGround ? Math.min(1, s.speed / 5) : 0;
    this.bob += dt * (6 + s.speed * 0.9);
    const bx = Math.sin(this.bob) * 0.012 * moving;
    const by = -Math.abs(Math.cos(this.bob)) * 0.014 * moving;

    // Lag behind fast mouse movement a little.
    const dyaw = s.yaw - this.lastYaw;
    const dpitch = s.pitch - this.lastPitch;
    this.lastYaw = s.yaw;
    this.lastPitch = s.pitch;
    this.swayX += (Math.max(-0.04, Math.min(0.04, dyaw * 0.4)) - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (Math.max(-0.04, Math.min(0.04, -dpitch * 0.4)) - this.swayY) * Math.min(1, dt * 10);
    this.sway.position.set(bx + this.swayX * 0.5, by + this.swayY * 0.5 + (s.onGround ? 0 : -0.01), 0);

    // Draw animation (raise from below).
    const draw = Math.min(1, s.draw / 0.4);
    const drawOff = (1 - draw) * (1 - draw);

    // Reload: dip and roll.
    let reloadDip = 0;
    let reloadRoll = 0;
    if (s.reload >= 0) {
      const k = Math.sin(Math.min(1, s.reload) * Math.PI);
      reloadDip = 0.1 * Math.min(1, k * 2.2);
      reloadRoll = 0.6 * Math.min(1, k * 2.2);
    }

    // Knife swing.
    const sw = this.swingT < 1 ? Math.sin(this.swingT * Math.PI) : 0;

    const g = this.gun;
    g.position.set(-0.05 * sw, -reloadDip - drawOff * 0.25, this.kick * 0.045 - 0.08 * sw);
    g.rotation.set(this.kick * 0.09 + drawOff * -0.8 - reloadDip * 1.5, 0.6 * sw, reloadRoll + 0.9 * sw);
  }
}

/** Soft star-shaped muzzle flash texture. */
export function flashTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = i % 2 ? s * 0.2 : s * 0.5;
    g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
  }
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Round soft particle texture (dust, blood, smoke). */
export function puffTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
