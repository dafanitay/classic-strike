import * as THREE from 'three';
import type { Team } from '../shared/map';
import type { WeaponClass } from '../shared/weapons';
import { gunModel } from './guns';

/**
 * Low-poly third-person soldier built from boxes. Silhouettes are kept
 * distinct per team (Defenders wear a wide helmet; Attackers a head wrap
 * with a red scarf) so enemies read clearly at a distance.
 */

const PALETTE: Record<Team, { body: number; vest: number; legs: number; head: number; accent: number; skin: number }> = {
  A: { body: 0x6d6044, vest: 0x4a4130, legs: 0x5a5038, head: 0x2b2722, accent: 0x9b2a22, skin: 0xa77c5c },
  D: { body: 0x2f4260, vest: 0x1d2737, legs: 0x26344c, head: 0x34404e, accent: 0x6f7d8c, skin: 0xb48a6a },
};

const box = (w: number, h: number, d: number, color: number, y = 0): THREE.Mesh => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y, 0);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  return m;
};

export class Avatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly arms = new THREE.Group();
  private gun: THREE.Group | null = null;
  private gunCls: WeaponClass | null = null;
  readonly muzzle = new THREE.Object3D();
  /** The bomb strapped to the carrier's back (shown to everyone, as in the classic game). */
  private readonly pack: THREE.Group;
  private walkPhase = 0;
  private deathT = -1;
  private crouchBlend = 0;

  constructor(team: Team) {
    const c = PALETTE[team];
    this.root.add(this.body);
    // Legs pivot at the hip.
    for (const [leg, x] of [[this.legL, -0.11], [this.legR, 0.11]] as const) {
      leg.position.set(x, 0.85, 0);
      leg.add(box(0.17, 0.85, 0.2, c.legs, -0.425));
      const bootM = box(0.19, 0.12, 0.27, 0x1d1a16, -0.79);
      bootM.position.z = -0.03;
      leg.add(bootM);
      this.body.add(leg);
    }
    this.upper.position.y = 0.85;
    this.body.add(this.upper);
    this.upper.add(box(0.46, 0.6, 0.26, c.body, 0.3));
    this.upper.add(box(0.48, 0.42, 0.3, c.vest, 0.36));
    // Head.
    const head = box(0.24, 0.27, 0.26, c.skin, 0.8);
    this.upper.add(head);
    if (team === 'D') {
      this.upper.add(box(0.32, 0.14, 0.34, c.head, 0.96));
      this.upper.add(box(0.24, 0.06, 0.04, 0x111418, 0.84)).position.z = -0.13;
    } else {
      this.upper.add(box(0.26, 0.2, 0.28, c.head, 0.86));
      this.upper.add(box(0.27, 0.08, 0.29, c.accent, 0.68));
    }
    // Arms + weapon rotate with view pitch around the shoulder.
    this.arms.position.set(0, 0.5, 0);
    this.upper.add(this.arms);
    const armR = box(0.11, 0.11, 0.42, c.body, 0);
    armR.position.set(0.2, -0.05, -0.18);
    armR.rotation.y = 0.35;
    const armL = box(0.11, 0.11, 0.46, c.body, 0);
    armL.position.set(-0.12, -0.04, -0.27);
    armL.rotation.y = -0.45;
    this.arms.add(armR, armL);
    this.pack = new THREE.Group();
    const casing = box(0.3, 0.24, 0.12, 0x4a4f36, 0);
    const strap = box(0.32, 0.03, 0.13, 0x2a2620, 0.06);
    const display = box(0.09, 0.05, 0.02, 0x2f6b3a, 0.04);
    display.position.z = 0.065;
    this.pack.add(casing, strap, display);
    this.pack.position.set(0, 0.36, 0.2); // between the shoulder blades (the front is -z)
    this.pack.visible = false;
    this.upper.add(this.pack);
  }

  /** Shows or hides the bomb on this soldier's back. */
  setBomb(carrying: boolean): void {
    this.pack.visible = carrying;
  }

  setWeapon(cls: WeaponClass, id: string): void {
    if (this.gunCls === cls && this.gun?.userData.id === id) return;
    if (this.gun) {
      // Free the old model: every weapon change (each buy, pick-up and
      // switch, for every soldier) otherwise left its geometry on the GPU.
      this.arms.remove(this.gun);
      this.gun.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    }
    this.gun = gunModel(id, cls, false);
    this.gun.userData.id = id;
    this.gun.scale.setScalar(0.85);
    this.gun.position.set(0.06, -0.02, -0.38);
    this.gun.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    this.arms.add(this.gun);
    this.gunCls = cls;
    const m = this.gun.getObjectByName('muzzle');
    this.muzzle.position.copy(m ? m.position : new THREE.Vector3(0, 0, -0.6));
    this.gun.add(this.muzzle);
  }

  /** Called every frame with interpolated state. */
  update(dt: number, s: { x: number; y: number; z: number; yaw: number; pitch: number; speed: number; crouched: boolean; alive: boolean }): void {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;
    if (!s.alive) {
      if (this.deathT < 0) this.deathT = 0;
      this.deathT = Math.min(1, this.deathT + dt * 3);
      const k = 1 - Math.pow(1 - this.deathT, 3);
      this.body.rotation.x = (Math.PI / 2) * k * 0.98;
      this.body.position.y = 0.05 * k;
      this.legL.rotation.x = this.legR.rotation.x = 0;
      return;
    }
    this.deathT = -1;
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    this.crouchBlend += ((s.crouched ? 1 : 0) - this.crouchBlend) * Math.min(1, dt * 12);
    const cb = this.crouchBlend;
    this.upper.position.y = 0.85 - 0.42 * cb;
    this.legL.position.y = this.legR.position.y = 0.85 - 0.42 * cb;
    this.legL.scale.y = this.legR.scale.y = 1 - 0.5 * cb;
    this.walkPhase += dt * s.speed * 2.2;
    const swing = Math.min(1, s.speed / 4) * 0.6;
    this.legL.rotation.x = Math.sin(this.walkPhase) * swing;
    this.legR.rotation.x = -Math.sin(this.walkPhase) * swing;
    this.arms.rotation.x = s.pitch;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
