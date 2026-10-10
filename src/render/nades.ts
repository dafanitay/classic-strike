import * as THREE from 'three';
import type { Nade, Simulation, Smoke } from '../shared/sim';
import { NADE, type NadeType } from '../shared/weapons';

/**
 * Grenades in flight and smoke clouds.
 *
 * Thrown grenades are small meshes that follow the simulation; online,
 * where positions arrive 20 times a second, they are carried forward
 * between snapshots with the same velocity and gravity. A smoke cloud is a
 * cluster of soft grey sprites around the cloud's centre, sized from the
 * simulation's own radius (the one that blocks sight), so what you see
 * matches what bots and players can see through.
 */

const NADE_COLOR: Record<NadeType, number> = { he: 0x4b5a32, flash: 0x9aa3a8, smoke: 0x5d6266 };
const PUFFS_PER_CLOUD = 18;

export class NadeView {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<number, { mesh: THREE.Mesh; base: THREE.Vector3; vel: THREE.Vector3; at: number; resting: boolean }>();
  private readonly clouds = new Map<number, { group: THREE.Group; offsets: THREE.Vector3[]; seed: number }>();
  private readonly geo = new THREE.BoxGeometry(0.09, 0.11, 0.09);
  private readonly mats: Record<NadeType, THREE.MeshLambertMaterial>;
  private readonly smokeMat: THREE.SpriteMaterial;
  private clock = 0;

  constructor(puffTex: THREE.Texture) {
    this.mats = {
      he: new THREE.MeshLambertMaterial({ color: NADE_COLOR.he }),
      flash: new THREE.MeshLambertMaterial({ color: NADE_COLOR.flash }),
      smoke: new THREE.MeshLambertMaterial({ color: NADE_COLOR.smoke }),
    };
    this.smokeMat = new THREE.SpriteMaterial({ map: puffTex, color: 0xb8b8b2, transparent: true, depthWrite: false, opacity: 0.95, fog: true });
  }

  /** @param simTime the simulation time the grenade states belong to. */
  update(sim: Simulation, dt: number): void {
    this.clock += dt;
    this.syncNades(sim.nadesInFlight);
    this.syncClouds(sim, sim.smokes);
  }

  private syncNades(list: Nade[]): void {
    const seen = new Set<number>();
    for (const n of list) {
      seen.add(n.id);
      let e = this.meshes.get(n.id);
      if (!e) {
        const mesh = new THREE.Mesh(this.geo, this.mats[n.type]);
        mesh.castShadow = true;
        this.group.add(mesh);
        e = { mesh, base: new THREE.Vector3(), vel: new THREE.Vector3(), at: this.clock, resting: false };
        this.meshes.set(n.id, e);
      }
      // New data: restart the extrapolation from it.
      if (e.base.x !== n.pos.x || e.base.y !== n.pos.y || e.base.z !== n.pos.z) {
        e.base.set(n.pos.x, n.pos.y, n.pos.z);
        e.vel.set(n.vel.x, n.vel.y, n.vel.z);
        e.at = this.clock;
        e.resting = n.resting;
      }
      const t = Math.min(0.1, this.clock - e.at);
      e.mesh.position.set(e.base.x + e.vel.x * t, e.base.y + (e.resting ? 0 : e.vel.y * t - 0.5 * NADE.gravity * t * t), e.base.z + e.vel.z * t);
      e.mesh.position.y = Math.max(e.mesh.position.y, e.base.y - 1);
      if (!e.resting) e.mesh.rotation.x += 12 * (1 / 60);
    }
    for (const [id, e] of this.meshes) {
      if (seen.has(id)) continue;
      this.group.remove(e.mesh);
      this.meshes.delete(id);
    }
  }

  private syncClouds(sim: Simulation, smokes: Smoke[]): void {
    const seen = new Set<number>();
    for (const s of smokes) {
      seen.add(s.id);
      let c = this.clouds.get(s.id);
      if (!c) {
        const group = new THREE.Group();
        const offsets: THREE.Vector3[] = [];
        let seed = s.id * 9301 + 49297;
        const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        for (let i = 0; i < PUFFS_PER_CLOUD; i++) {
          const sp = new THREE.Sprite(this.smokeMat.clone());
          group.add(sp);
          // Spread inside the sphere, flatter at the bottom (smoke pools).
          const a = rnd() * Math.PI * 2;
          const r = Math.sqrt(rnd()) * 0.75;
          offsets.push(new THREE.Vector3(Math.cos(a) * r, (rnd() - 0.35) * 0.8, Math.sin(a) * r));
        }
        group.position.set(s.pos.x, s.pos.y, s.pos.z);
        this.group.add(group);
        c = { group, offsets, seed: s.id };
        this.clouds.set(s.id, c);
      }
      const radius = sim.smokeRadius(s);
      const fade = Math.min(1, (s.end - sim.time) / NADE.smokeFade);
      c.group.visible = radius > 0;
      c.group.children.forEach((child, i) => {
        const sp = child as THREE.Sprite;
        const o = c!.offsets[i];
        const drift = Math.sin(this.clock * 0.3 + i) * 0.15;
        sp.position.set(o.x * radius + drift, o.y * radius, o.z * radius - drift);
        sp.scale.setScalar(radius * (1.1 + (i % 3) * 0.2));
        (sp.material as THREE.SpriteMaterial).opacity = 0.9 * Math.max(0, fade);
        sp.material.rotation = i + this.clock * 0.05 * ((i % 2) * 2 - 1);
      });
    }
    for (const [id, c] of this.clouds) {
      if (seen.has(id)) continue;
      c.group.children.forEach((ch) => ((ch as THREE.Sprite).material as THREE.Material).dispose());
      this.group.remove(c.group);
      this.clouds.delete(id);
    }
  }

  /** How deep the camera is inside a cloud (0 = outside, 1 = centre), for a screen haze. */
  insideSmoke(sim: Simulation, eye: { x: number; y: number; z: number }): number {
    let k = 0;
    for (const s of sim.smokes) {
      const r = sim.smokeRadius(s);
      if (r <= 0) continue;
      const d = Math.hypot(eye.x - s.pos.x, eye.y - s.pos.y, eye.z - s.pos.z);
      k = Math.max(k, Math.min(1, (1 - d / r) * 2.2));
    }
    return Math.max(0, k);
  }

  dispose(): void {
    this.geo.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
    for (const c of this.clouds.values()) c.group.children.forEach((ch) => ((ch as THREE.Sprite).material as THREE.Material).dispose());
    this.smokeMat.dispose();
  }
}
