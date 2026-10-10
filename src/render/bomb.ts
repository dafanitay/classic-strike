import * as THREE from 'three';
import type { BombState } from '../shared/sim';

/**
 * The bomb as it lies in the world (dropped or planted), with a blinking
 * light once planted, and the flash of the explosion. Carried bombs are not
 * drawn; teammates see the carrier on the scoreboard.
 */
export class BombModel {
  readonly group = new THREE.Group();
  private readonly body: THREE.Group;
  private readonly led: THREE.Mesh;
  private readonly ledMat: THREE.MeshBasicMaterial;
  private readonly glow = new THREE.PointLight(0xff2a1a, 0, 1.6, 2);
  private readonly blast = new THREE.PointLight(0xffa040, 0, 45, 1.6);
  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.body = new THREE.Group();
    const mat = (c: number) => {
      const m = new THREE.MeshLambertMaterial({ color: c });
      this.disposables.push(m);
      return m;
    };
    const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.disposables.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.body.add(mesh);
      return mesh;
    };
    box(0.36, 0.12, 0.24, mat(0x4a4f36), 0, 0.06, 0); // casing
    box(0.16, 0.02, 0.12, mat(0x1c1c1c), -0.06, 0.13, 0); // keypad
    box(0.1, 0.03, 0.05, mat(0x2f6b3a), 0.1, 0.13, 0.05); // display
    for (const z of [-0.07, 0.07]) box(0.38, 0.03, 0.025, mat(0x2a2620), 0, 0.06, z); // straps
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x400000 });
    this.disposables.push(this.ledMat);
    const ledGeo = new THREE.SphereGeometry(0.018, 8, 6);
    this.disposables.push(ledGeo);
    this.led = new THREE.Mesh(ledGeo, this.ledMat);
    this.led.position.set(0.12, 0.15, -0.06);
    this.body.add(this.led);
    this.glow.position.set(0.12, 0.3, -0.06);
    this.body.add(this.glow);
    this.group.add(this.body, this.blast);
    this.group.visible = false;
  }

  /**
   * @param time  simulation time (s)
   * @param beepAt time of the most recent beep, for the blink
   */
  update(bomb: BombState, time: number, lastBeep: number, dt: number): void {
    const visible = bomb.state === 'dropped' || bomb.state === 'planted' || bomb.state === 'defused';
    this.body.visible = visible;
    this.group.visible = visible || this.blast.intensity > 0.01;
    if (visible) {
      this.body.position.set(bomb.pos.x, bomb.pos.y, bomb.pos.z);
      const on = bomb.state === 'planted' && time - lastBeep < 0.12;
      this.ledMat.color.setHex(on ? 0xff2a1a : bomb.state === 'defused' ? 0x1a4a1a : 0x400000);
      this.glow.intensity = on ? 0.6 : 0;
    }
    this.blast.intensity = Math.max(0, this.blast.intensity - dt * 160);
  }

  explode(pos: { x: number; y: number; z: number }): void {
    this.blast.position.set(pos.x, pos.y + 1.5, pos.z);
    this.blast.intensity = 160;
    this.group.visible = true;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
