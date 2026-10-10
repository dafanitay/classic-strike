import * as THREE from 'three';
import type { BotDebug } from '../shared/bot';

/**
 * Developer overlay for the bot AI (enabled with `?botdebug` in the URL;
 * never on otherwise). Draws each bot's remaining path and destination in
 * the world and lists role, state, destination and the reason for it.
 */
export class BotDebugView {
  readonly group = new THREE.Group();
  private readonly panel: HTMLElement;
  private readonly lines: THREE.Line[] = [];
  private readonly markers: THREE.Mesh[] = [];
  private readonly markerGeo = new THREE.OctahedronGeometry(0.25);
  private readonly mats = {
    A: new THREE.LineBasicMaterial({ color: 0xffb040, depthTest: false, transparent: true, opacity: 0.85 }),
    D: new THREE.LineBasicMaterial({ color: 0x60a8ff, depthTest: false, transparent: true, opacity: 0.85 }),
  };
  private readonly markerMats = {
    A: new THREE.MeshBasicMaterial({ color: 0xffb040, depthTest: false }),
    D: new THREE.MeshBasicMaterial({ color: 0x60a8ff, depthTest: false }),
  };
  private nextUpdate = 0;

  constructor(parent: HTMLElement) {
    this.panel = document.createElement('pre');
    this.panel.className = 'botdebug';
    parent.appendChild(this.panel);
    this.group.renderOrder = 10;
  }

  update(bots: BotDebug[], now: number): void {
    if (now < this.nextUpdate) return;
    this.nextUpdate = now + 0.25;
    while (this.lines.length < bots.length) {
      const l = new THREE.Line(new THREE.BufferGeometry(), this.mats.A);
      l.frustumCulled = false;
      this.lines.push(l);
      this.group.add(l);
      const m = new THREE.Mesh(this.markerGeo, this.markerMats.A);
      this.markers.push(m);
      this.group.add(m);
    }
    this.lines.forEach((l, i) => {
      const b = bots[i];
      l.visible = !!b && b.path.length > 0;
      this.markers[i].visible = !!b?.dest;
      if (!b) return;
      l.material = this.mats[b.team];
      (this.markers[i].material as THREE.Material) = this.markerMats[b.team];
      const pts = [b.pos, ...b.path].map((p) => new THREE.Vector3(p.x, p.y + 0.15, p.z));
      l.geometry.setFromPoints(pts);
      if (b.dest) this.markers[i].position.set(b.dest.x, b.dest.y + 0.6, b.dest.z);
    });
    const f = (n: number) => n.toFixed(0).padStart(3);
    this.panel.textContent = bots
      .map((b) => `${b.team} ${b.name.padEnd(8)} ${b.role.padEnd(7)} ${b.state.padEnd(7)} → ${b.dest ? `${f(b.dest.x / 2)},${f(b.dest.z / 2)}` : '   -   '}${b.stuckTime ? ` stuck ${b.stuckTime.toFixed(1)}s` : ''}${b.target !== null ? ' [fighting]' : ''}  ${b.reason}`)
      .join('\n');
  }

  dispose(): void {
    for (const l of this.lines) l.geometry.dispose();
    this.markerGeo.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
    Object.values(this.markerMats).forEach((m) => m.dispose());
    this.panel.remove();
  }
}
