import * as THREE from 'three';
import type { WeaponClass } from '../shared/weapons';

/**
 * Procedural low-poly weapon models. The barrel points along -Z, the grip
 * sits at the origin, and a child named "muzzle" marks the barrel tip.
 */

const METAL = 0x2a2b2d;
const METAL_LIGHT = 0x45474b;
const WOOD = 0x6a4524;
const POLY = 0x3b3a33;

function part(g: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, color: number, lit: boolean): THREE.Mesh {
  const mat = lit ? new THREE.MeshLambertMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

export function gunModel(id: string, cls: WeaponClass, firstPerson: boolean): THREE.Group {
  const g = new THREE.Group();
  const lit = firstPerson;
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  switch (cls) {
    case 'melee':
      part(g, 0.03, 0.04, 0.12, 0, 0, 0.02, 0x1b1b1b, lit); // handle
      part(g, 0.05, 0.05, 0.02, 0, 0, -0.05, METAL_LIGHT, lit); // guard
      part(g, 0.008, 0.035, 0.2, 0, 0.005, -0.16, 0xb8bcc2, lit); // blade
      muzzle.position.set(0, 0, -0.26);
      break;
    case 'pistol':
      part(g, 0.035, 0.1, 0.05, 0, -0.04, 0.01, POLY, lit);
      part(g, 0.04, 0.045, 0.2, 0, 0.03, -0.06, METAL, lit);
      part(g, 0.02, 0.02, 0.02, 0, 0.06, -0.15, METAL_LIGHT, lit);
      muzzle.position.set(0, 0.03, -0.17);
      break;
    case 'smg':
      part(g, 0.035, 0.1, 0.05, 0, -0.05, 0.02, POLY, lit);
      part(g, 0.05, 0.07, 0.36, 0, 0.02, -0.1, METAL, lit);
      part(g, 0.03, 0.14, 0.04, 0, -0.07, -0.12, METAL_LIGHT, lit); // mag
      part(g, 0.025, 0.025, 0.1, 0, 0.025, -0.32, METAL, lit);
      part(g, 0.03, 0.05, 0.16, 0, 0.0, 0.16, POLY, lit); // stock
      muzzle.position.set(0, 0.025, -0.38);
      break;
    case 'shotgun':
      part(g, 0.04, 0.1, 0.06, 0, -0.05, 0.02, WOOD, lit);
      part(g, 0.05, 0.06, 0.3, 0, 0.02, -0.08, METAL, lit);
      part(g, 0.03, 0.03, 0.42, 0, 0.045, -0.4, METAL_LIGHT, lit); // barrel
      part(g, 0.045, 0.045, 0.16, 0, 0.0, -0.36, WOOD, lit); // pump
      part(g, 0.045, 0.08, 0.26, 0, -0.01, 0.2, WOOD, lit); // stock
      muzzle.position.set(0, 0.045, -0.62);
      break;
    case 'rifle':
      part(g, 0.035, 0.11, 0.05, 0, -0.05, 0.02, id === 'ar7' ? WOOD : POLY, lit);
      part(g, 0.05, 0.075, 0.42, 0, 0.02, -0.12, METAL, lit);
      part(g, 0.035, 0.16, 0.06, 0, -0.08, -0.13, METAL_LIGHT, lit).rotation.x = id === 'ar7' ? -0.35 : -0.1; // mag
      part(g, 0.05, 0.055, 0.2, 0, 0.015, -0.38, id === 'ar7' ? WOOD : POLY, lit); // handguard
      part(g, 0.022, 0.022, 0.16, 0, 0.03, -0.56, METAL, lit);
      part(g, 0.045, 0.085, 0.24, 0, -0.005, 0.22, id === 'ar7' ? WOOD : POLY, lit); // stock
      if (id === 'k4') part(g, 0.02, 0.05, 0.08, 0, 0.08, -0.05, METAL, lit); // carry handle
      muzzle.position.set(0, 0.03, -0.65);
      break;
    case 'sniper':
      part(g, 0.035, 0.11, 0.05, 0, -0.05, 0.02, POLY, lit);
      part(g, 0.055, 0.08, 0.5, 0, 0.02, -0.14, 0x3d4a32, lit);
      part(g, 0.026, 0.026, 0.42, 0, 0.035, -0.6, METAL, lit);
      part(g, 0.05, 0.05, 0.26, 0, 0.1, -0.1, METAL, lit); // scope
      part(g, 0.06, 0.06, 0.04, 0, 0.1, -0.24, METAL_LIGHT, lit);
      part(g, 0.05, 0.1, 0.3, 0, -0.01, 0.26, 0x3d4a32, lit);
      muzzle.position.set(0, 0.035, -0.82);
      break;
  }
  g.add(muzzle);
  return g;
}
