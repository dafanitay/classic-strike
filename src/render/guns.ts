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

/** First-person finish per colour: metal gets a tight highlight, wood and polymer a dull sheen. */
function finish(color: number): { specular: number; shininess: number } {
  if (color === WOOD) return { specular: 0x1a140e, shininess: 12 };
  if (color === POLY || color === 0x3d4a32 || color === 0x1b1b1b) return { specular: 0x202020, shininess: 18 };
  return { specular: 0x6a6a6a, shininess: 70 }; // metal, blade
}

function part(g: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, color: number, lit: boolean): THREE.Mesh {
  // Third-person guns are small on screen: plain Lambert is enough there.
  const mat = lit ? new THREE.MeshPhongMaterial({ color, ...finish(color) }) : new THREE.MeshLambertMaterial({ color });
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
    case 'mg':
      // Belt-fed: long receiver, box magazine underneath, bipod, carry handle.
      part(g, 0.035, 0.11, 0.05, 0, -0.05, 0.02, POLY, lit);
      part(g, 0.07, 0.09, 0.5, 0, 0.02, -0.14, METAL, lit);
      part(g, 0.08, 0.1, 0.12, 0, -0.06, -0.1, 0x3d4a32, lit); // ammo box
      part(g, 0.03, 0.03, 0.34, 0, 0.035, -0.55, METAL_LIGHT, lit); // barrel
      part(g, 0.02, 0.05, 0.12, 0, 0.09, -0.12, METAL, lit); // carry handle
      part(g, 0.06, 0.09, 0.24, 0, -0.005, 0.24, POLY, lit); // stock
      for (const x of [-0.04, 0.04]) part(g, 0.012, 0.12, 0.012, x, -0.05, -0.6, METAL, lit).rotation.z = x * 6; // bipod
      muzzle.position.set(0, 0.035, -0.73);
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
  extras(g, id, lit, muzzle);
  g.add(muzzle);
  return g;
}

/**
 * What makes each gun of a class look like itself: scopes, magazines,
 * grips, stocks, finish. Added on top of the class's base shape.
 */
function extras(g: THREE.Group, id: string, lit: boolean, muzzle: THREE.Object3D): void {
  const scope = (z: number, len: number, y = 0.085) => {
    part(g, 0.045, 0.045, len, 0, y, z, METAL, lit);
    part(g, 0.055, 0.055, 0.03, 0, y, z - len / 2, METAL_LIGHT, lit);
    part(g, 0.05, 0.05, 0.03, 0, y, z + len / 2, METAL_LIGHT, lit);
    part(g, 0.015, 0.03, 0.04, 0, y - 0.035, z, METAL, lit); // mount
  };
  switch (id) {
    case 'm45': // longer slide and a tactical light under the barrel
      part(g, 0.042, 0.047, 0.24, 0, 0.03, -0.08, 0x202224, lit);
      part(g, 0.03, 0.03, 0.06, 0, -0.005, -0.13, 0x111111, lit);
      break;
    case 'k57': // two-tone: dark frame, light slide
      part(g, 0.041, 0.04, 0.21, 0, 0.034, -0.065, 0x5a5d60, lit);
      break;
    case 'hc50': // big, chunky, bright slide
      part(g, 0.05, 0.06, 0.26, 0, 0.035, -0.08, 0x8a8d92, lit);
      part(g, 0.04, 0.12, 0.06, 0, -0.045, 0.01, 0x1c1c1c, lit);
      muzzle.position.z -= 0.04;
      break;
    case 'tp9': // compact with a vertical front grip
      part(g, 0.03, 0.09, 0.035, 0, -0.06, -0.24, POLY, lit);
      break;
    case 'r10': // boxy receiver, wire stock
      part(g, 0.06, 0.08, 0.2, 0, 0.02, -0.06, 0x2f2f2f, lit);
      part(g, 0.012, 0.012, 0.18, 0.025, 0.0, 0.18, METAL_LIGHT, lit);
      part(g, 0.012, 0.012, 0.18, -0.025, 0.0, 0.18, METAL_LIGHT, lit);
      break;
    case 'u45': // straight magazine and a full stock
      part(g, 0.035, 0.17, 0.05, 0, -0.09, -0.12, POLY, lit);
      part(g, 0.04, 0.07, 0.2, 0, 0.0, 0.17, POLY, lit);
      break;
    case 'p50': // magazine along the top, bullpup body
      part(g, 0.05, 0.03, 0.28, 0, 0.075, -0.1, 0x2c3a2c, lit);
      part(g, 0.06, 0.09, 0.26, 0, 0.0, 0.08, 0x2a2b2d, lit);
      break;
    case 'auto12': // black polymer, no wooden pump, ghost-ring sights
      part(g, 0.05, 0.05, 0.16, 0, 0.0, -0.36, POLY, lit);
      part(g, 0.04, 0.03, 0.04, 0, 0.08, -0.02, METAL, lit);
      break;
    case 'gr3': // wood furniture, long magazine
      part(g, 0.052, 0.058, 0.2, 0, 0.015, -0.38, 0x7a5030, lit);
      part(g, 0.035, 0.19, 0.06, 0, -0.09, -0.13, METAL_LIGHT, lit).rotation.x = -0.25;
      break;
    case 'fm2': // long carry handle over a bullpup body
      part(g, 0.025, 0.035, 0.3, 0, 0.09, -0.1, POLY, lit);
      break;
    case 'sg5':
      scope(-0.08, 0.16);
      break;
    case 'au3': // green bullpup with an integrated scope
      part(g, 0.06, 0.09, 0.3, 0, 0.0, 0.05, 0x3d4a32, lit);
      scope(-0.1, 0.14);
      break;
    case 'kestrel': // light: a slim olive stock (the class model has the scope)
      part(g, 0.04, 0.07, 0.26, 0, -0.01, 0.24, 0x5c6a44, lit);
      break;
    case 'rp3':
    case 'vg5': // semi-automatic: box magazine, heavy scope, black
      part(g, 0.04, 0.12, 0.08, 0, -0.07, -0.08, POLY, lit);
      part(g, 0.06, 0.09, 0.5, 0, 0.02, -0.14, id === 'rp3' ? 0x2a2b2d : 0x23272c, lit);
      break;
  }
}
