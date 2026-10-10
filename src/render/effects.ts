import * as THREE from 'three';
import type { Vec3 } from '../shared/vec';

/**
 * Short-lived combat effects from fixed-size pools (no per-shot allocation):
 * tracers, bullet-hole decals, dust/blood puffs and third-person muzzle
 * flashes. Kept deliberately restrained so they never hide targets.
 */
export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: { line: THREE.Line; life: number }[] = [];
  private readonly decals: THREE.Mesh[] = [];
  private decalIdx = 0;
  private readonly puffs: { s: THREE.Sprite; life: number; max: number; grow: number; vy: number }[] = [];
  private readonly flashes: { s: THREE.Sprite; life: number }[] = [];
  private readonly decalGeo = new THREE.PlaneGeometry(0.09, 0.09);
  private readonly decalMat: THREE.MeshBasicMaterial;

  constructor(puffTex: THREE.Texture, flashTex: THREE.Texture) {
    for (let i = 0; i < 24; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.55 }));
      line.visible = false;
      line.frustumCulled = false;
      this.group.add(line);
      this.tracers.push({ line, life: 0 });
    }
    const hole = document.createElement('canvas');
    hole.width = hole.height = 32;
    const g = hole.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(10,8,6,1)');
    grad.addColorStop(0.45, 'rgba(25,20,15,0.85)');
    grad.addColorStop(1, 'rgba(40,30,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.decalMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(hole), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    for (let i = 0; i < 96; i++) {
      const m = new THREE.Mesh(this.decalGeo, this.decalMat);
      m.visible = false;
      this.group.add(m);
      this.decals.push(m);
    }
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false }));
      s.visible = false;
      this.group.add(s);
      this.puffs.push({ s, life: 0, max: 1, grow: 1, vy: 0 });
    }
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffd28a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
      s.visible = false;
      s.scale.setScalar(0.4);
      this.group.add(s);
      this.flashes.push({ s, life: 0 });
    }
  }

  tracer(from: THREE.Vector3, to: Vec3): void {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
    const pos = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Draw only a segment of the path (a streak, not a laser).
    const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = dir.length();
    dir.normalize();
    const a = from.clone().addScaledVector(dir, Math.min(len * 0.3, 2));
    const b = from.clone().addScaledVector(dir, len);
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    t.life = 0.05;
    t.line.visible = true;
  }

  impact(pos: Vec3, normal: Vec3): void {
    const m = this.decals[this.decalIdx++ % this.decals.length];
    m.position.set(pos.x + normal.x * 0.005, pos.y + normal.y * 0.005, pos.z + normal.z * 0.005);
    m.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
    m.rotateZ(Math.random() * Math.PI);
    m.visible = true;
    this.puff(pos, 0xb59c78, 0.35, 0.5);
  }

  puff(pos: Vec3, color: number, life: number, size: number): void {
    const p = this.puffs.find((x) => x.life <= 0) ?? this.puffs[0];
    p.s.position.set(pos.x, pos.y, pos.z);
    (p.s.material as THREE.SpriteMaterial).color.setHex(color);
    p.life = p.max = life;
    p.grow = size;
    p.vy = 0.4;
    p.s.scale.setScalar(size * 0.3);
    p.s.visible = true;
  }

  blood(pos: Vec3): void {
    this.puff(pos, 0x8a0f0a, 0.3, 0.45);
  }

  flash(pos: THREE.Vector3): void {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.s.position.copy(pos);
    f.s.material.rotation = Math.random() * Math.PI;
    f.life = 0.05;
    f.s.visible = true;
  }

  clearDecals(): void {
    for (const d of this.decals) d.visible = false;
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.line.visible = false;
    }
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = 1 - p.life / p.max;
      p.s.scale.setScalar(p.grow * (0.3 + k * 0.9));
      p.s.position.y += p.vy * dt;
      (p.s.material as THREE.SpriteMaterial).opacity = 0.75 * (1 - k);
      if (p.life <= 0) p.s.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) f.s.visible = false;
    }
  }
}
