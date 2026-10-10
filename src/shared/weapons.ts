/**
 * Weapon roster. Names and numbers are original, tuned to echo the roles and
 * pacing of classic tactical-shooter weapons (not copied from any game file).
 * Distances are metres, times seconds, angles radians.
 */

export type WeaponId = 'knife' | 'p9' | 'mk5' | 'pump12' | 'ar7' | 'k4' | 'longbow';
export type WeaponSlot = 1 | 2 | 3;
export type WeaponClass = 'melee' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: WeaponSlot;
  cls: WeaponClass;
  price: number;
  /** Team restriction, if any (A = attackers, D = defenders). */
  team?: 'A' | 'D';
  damage: number;
  pellets: number;
  /** Seconds between shots. */
  cycle: number;
  automatic: boolean;
  magSize: number;
  reserve: number;
  reloadTime: number;
  /** Damage multiplier applied per `rangeUnit` metres travelled. */
  rangeModifier: number;
  range: number;
  /** Fraction of damage that reaches health through armour. */
  armorPen: number;
  maxSpeed: number;
  /** Inaccuracy model (cone half-angle, radians). */
  spreadBase: number;
  spreadMove: number;
  spreadAir: number;
  spreadPerShot: number;
  spreadMax: number;
  spreadRecovery: number; // per second
  crouchFactor: number;
  /** Recoil: vertical kick per shot and horizontal sway after `swayAfter` shots. */
  kick: number;
  kickMax: number;
  sway: number;
  swayAfter: number;
  recoilRecovery: number; // per second
  scope?: { fovs: number[]; scopedSpread: number; scopedSpeed: number };
  killReward: number;
}

const DEG = Math.PI / 180;

export const RANGE_UNIT = 12.7; // ≈500 Hammer units

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife', name: 'Combat Knife', slot: 3, cls: 'melee', price: 0,
    damage: 34, pellets: 1, cycle: 0.4, automatic: true, magSize: 0, reserve: 0, reloadTime: 0,
    rangeModifier: 1, range: 1.7, armorPen: 0.85, maxSpeed: 250 * 0.0254,
    spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1, crouchFactor: 1,
    kick: 0, kickMax: 0, sway: 0, swayAfter: 99, recoilRecovery: 10, killReward: 1500,
  },
  p9: {
    id: 'p9', name: 'P9 Compact', slot: 2, cls: 'pistol', price: 200,
    damage: 26, pellets: 1, cycle: 0.15, automatic: false, magSize: 15, reserve: 90, reloadTime: 2.1,
    rangeModifier: 0.8, range: 120, armorPen: 0.55, maxSpeed: 250 * 0.0254,
    spreadBase: 0.35 * DEG, spreadMove: 2.2 * DEG, spreadAir: 6 * DEG, spreadPerShot: 0.9 * DEG, spreadMax: 4 * DEG, spreadRecovery: 9 * DEG, crouchFactor: 0.75,
    kick: 1.6 * DEG, kickMax: 6 * DEG, sway: 0.4 * DEG, swayAfter: 2, recoilRecovery: 14 * DEG, killReward: 300,
  },
  mk5: {
    id: 'mk5', name: 'MK-5 SMG', slot: 1, cls: 'smg', price: 1500,
    damage: 26, pellets: 1, cycle: 60 / 800, automatic: true, magSize: 30, reserve: 120, reloadTime: 2.6,
    rangeModifier: 0.84, range: 120, armorPen: 0.6, maxSpeed: 240 * 0.0254,
    spreadBase: 0.5 * DEG, spreadMove: 1.6 * DEG, spreadAir: 5 * DEG, spreadPerShot: 0.35 * DEG, spreadMax: 3.5 * DEG, spreadRecovery: 8 * DEG, crouchFactor: 0.8,
    kick: 0.55 * DEG, kickMax: 5 * DEG, sway: 0.45 * DEG, swayAfter: 5, recoilRecovery: 12 * DEG, killReward: 600,
  },
  pump12: {
    id: 'pump12', name: 'Pump-12 Shotgun', slot: 1, cls: 'shotgun', price: 1700,
    damage: 20, pellets: 9, cycle: 0.88, automatic: false, magSize: 8, reserve: 32, reloadTime: 3.2,
    rangeModifier: 0.7, range: 40, armorPen: 0.5, maxSpeed: 220 * 0.0254,
    spreadBase: 3.6 * DEG, spreadMove: 0.6 * DEG, spreadAir: 2 * DEG, spreadPerShot: 0, spreadMax: 5 * DEG, spreadRecovery: 5 * DEG, crouchFactor: 1,
    kick: 4.5 * DEG, kickMax: 8 * DEG, sway: 0.6 * DEG, swayAfter: 0, recoilRecovery: 10 * DEG, killReward: 900,
  },
  ar7: {
    id: 'ar7', name: 'AR-7 Rifle', slot: 1, cls: 'rifle', price: 2700, team: 'A',
    damage: 36, pellets: 1, cycle: 0.1, automatic: true, magSize: 30, reserve: 90, reloadTime: 2.5,
    rangeModifier: 0.98, range: 200, armorPen: 0.775, maxSpeed: 221 * 0.0254,
    spreadBase: 0.22 * DEG, spreadMove: 3.2 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.32 * DEG, spreadMax: 3.4 * DEG, spreadRecovery: 6 * DEG, crouchFactor: 0.7,
    kick: 0.95 * DEG, kickMax: 9 * DEG, sway: 0.75 * DEG, swayAfter: 4, recoilRecovery: 11 * DEG, killReward: 300,
  },
  k4: {
    id: 'k4', name: 'K4 Carbine', slot: 1, cls: 'rifle', price: 3100, team: 'D',
    damage: 33, pellets: 1, cycle: 0.09, automatic: true, magSize: 30, reserve: 90, reloadTime: 3.0,
    rangeModifier: 0.97, range: 200, armorPen: 0.7, maxSpeed: 230 * 0.0254,
    spreadBase: 0.18 * DEG, spreadMove: 2.8 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.26 * DEG, spreadMax: 2.8 * DEG, spreadRecovery: 6.5 * DEG, crouchFactor: 0.7,
    kick: 0.75 * DEG, kickMax: 7 * DEG, sway: 0.55 * DEG, swayAfter: 5, recoilRecovery: 12 * DEG, killReward: 300,
  },
  longbow: {
    id: 'longbow', name: 'Longbow .338', slot: 1, cls: 'sniper', price: 4750,
    damage: 115, pellets: 1, cycle: 1.45, automatic: false, magSize: 10, reserve: 30, reloadTime: 3.6,
    rangeModifier: 0.99, range: 300, armorPen: 0.97, maxSpeed: 210 * 0.0254,
    spreadBase: 7 * DEG, spreadMove: 8 * DEG, spreadAir: 14 * DEG, spreadPerShot: 0, spreadMax: 14 * DEG, spreadRecovery: 20 * DEG, crouchFactor: 1,
    kick: 3 * DEG, kickMax: 4 * DEG, sway: 0, swayAfter: 99, recoilRecovery: 8 * DEG,
    scope: { fovs: [40, 15], scopedSpread: 0.05 * DEG, scopedSpeed: 150 * 0.0254 }, killReward: 100,
  },
};

export const BUYABLE: WeaponId[] = ['p9', 'mk5', 'pump12', 'ar7', 'k4', 'longbow'];

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
}

export const freshWeapon = (id: WeaponId): WeaponState => ({ id, mag: WEAPONS[id].magSize, reserve: WEAPONS[id].reserve });

export const HITGROUP_MULT = { head: 4, chest: 1, stomach: 1.25, legs: 0.75 } as const;
export type HitGroup = keyof typeof HITGROUP_MULT;

/**
 * Applies range falloff, hitgroup and armour. Mirrors the classic rule that
 * armour absorbs part of the damage (helmet only protects the head) and loses
 * half of what it absorbs.
 */
export function computeDamage(
  def: WeaponDef,
  distance: number,
  group: HitGroup,
  armor: number,
  helmet: boolean,
): { health: number; armor: number } {
  let dmg = def.damage * Math.pow(def.rangeModifier, distance / RANGE_UNIT) * HITGROUP_MULT[group];
  let armorLoss = 0;
  const armored = armor > 0 && (group !== 'head' || helmet) && group !== 'legs';
  if (armored) {
    const toHealth = dmg * def.armorPen;
    armorLoss = (dmg - toHealth) * 0.5;
    if (armorLoss > armor) {
      // Armour ran out: the remainder goes to health.
      const absorbed = armor * 2;
      dmg = dmg - absorbed;
      armorLoss = armor;
    } else {
      dmg = toHealth;
    }
  }
  return { health: Math.max(1, Math.round(dmg)), armor: Math.round(armorLoss) };
}
