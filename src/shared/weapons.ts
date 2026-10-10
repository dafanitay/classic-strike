/**
 * Weapon roster. Names and numbers are original, tuned to echo the roles and
 * pacing of classic tactical-shooter weapons (not copied from any game file).
 * Distances are metres, times seconds, angles radians.
 */

export type WeaponId =
  | 'knife'
  // pistols
  | 'p9' | 'm45' | 'k57' | 'hc50'
  // SMGs
  | 'tp9' | 'r10' | 'mk5' | 'u45' | 'p50'
  // shotguns
  | 'pump12' | 'auto12'
  // rifles
  | 'gr3' | 'fm2' | 'ar7' | 'k4' | 'sg5' | 'au3'
  // snipers
  | 'kestrel' | 'longbow' | 'rp3' | 'vg5'
  // machine gun
  | 'mg9'
  // grenades (slot 4)
  | 'he' | 'flash' | 'smoke';
export type WeaponSlot = 1 | 2 | 3 | 4;
export type WeaponClass = 'melee' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'mg' | 'grenade';

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
  /** Seconds after drawing the weapon before it can fire. */
  drawTime: number;
  /**
   * Inaccuracy (cone half-angle, radians). Spread is deliberately small when
   * standing still: where a spray goes is decided by the recoil pattern, and
   * spread only adds a little scatter on top. Movement and jumping dominate.
   */
  spreadBase: number;
  spreadMove: number;
  spreadAir: number;
  /** Extra spread per shot of a spray ("bloom"), capped at spreadMax. */
  spreadPerShot: number;
  spreadMax: number;
  spreadRecovery: number; // per second
  crouchFactor: number;
  /**
   * Fixed spray pattern keyframes [shot, right°, up°] (see shared/recoil.ts).
   * Deterministic: the same spray always lands in the same place.
   */
  recoilPattern: readonly PatternKey[];
  /** Time constant (s) of recoil recovery once the trigger is released. */
  recoilTau: number;
  /**
   * Zoom levels. Bolt-action rifles drop out of the scope after each shot
   * and come back once the bolt has cycled; `keepScope` weapons (scoped
   * assault rifles, semi-automatic snipers) stay zoomed while firing.
   */
  scope?: { fovs: number[]; scopedSpread: number; scopedSpeed: number; keepScope?: boolean };
  killReward: number;
}

import type { PatternKey } from './recoil';

const DEG = Math.PI / 180;

export const RANGE_UNIT = 12.7; // ≈500 Hammer units

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife', name: 'Combat Knife', slot: 3, cls: 'melee', price: 0,
    damage: 34, pellets: 1, cycle: 0.4, automatic: true, magSize: 0, reserve: 0, reloadTime: 0,
    rangeModifier: 1, range: 1.7, armorPen: 0.85, maxSpeed: 250 * 0.0254,
    drawTime: 0.35, spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1, crouchFactor: 1,
    recoilPattern: [], recoilTau: 0.1, killReward: 1500,
  },
  p9: {
    id: 'p9', name: 'P9 Compact', slot: 2, cls: 'pistol', price: 200,
    damage: 26, pellets: 1, cycle: 0.15, automatic: false, magSize: 15, reserve: 90, reloadTime: 2.1,
    rangeModifier: 0.8, range: 120, armorPen: 0.55, maxSpeed: 250 * 0.0254,
    drawTime: 0.4, spreadBase: 0.3 * DEG, spreadMove: 2.2 * DEG, spreadAir: 6 * DEG, spreadPerShot: 0.35 * DEG, spreadMax: 1.6 * DEG, spreadRecovery: 6 * DEG, crouchFactor: 0.75,
    recoilPattern: [[0, 0, 0], [1, 0, 1.3], [3, 0.3, 3.2], [6, -0.4, 4.6], [10, 0.3, 5.4], [14, -0.2, 5.8]], recoilTau: 0.09, killReward: 300,
  },
  mk5: {
    id: 'mk5', name: 'MK-5 SMG', slot: 1, cls: 'smg', price: 1500,
    damage: 26, pellets: 1, cycle: 60 / 800, automatic: true, magSize: 30, reserve: 120, reloadTime: 2.6,
    rangeModifier: 0.84, range: 120, armorPen: 0.6, maxSpeed: 240 * 0.0254,
    drawTime: 0.5, spreadBase: 0.45 * DEG, spreadMove: 1.6 * DEG, spreadAir: 5 * DEG, spreadPerShot: 0.04 * DEG, spreadMax: 1.0 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 0.8,
    recoilPattern: [[0, 0, 0], [1, 0, 0.45], [5, 0.2, 2.0], [10, -0.6, 3.0], [15, 0.7, 3.5], [20, -0.5, 3.8], [25, 0.6, 4.0], [29, 0, 4.1]], recoilTau: 0.1, killReward: 600,
  },
  pump12: {
    id: 'pump12', name: 'Pump-12 Shotgun', slot: 1, cls: 'shotgun', price: 1700,
    damage: 20, pellets: 9, cycle: 0.88, automatic: false, magSize: 8, reserve: 32, reloadTime: 3.2,
    rangeModifier: 0.7, range: 40, armorPen: 0.5, maxSpeed: 220 * 0.0254,
    drawTime: 0.6, spreadBase: 3.6 * DEG, spreadMove: 0.6 * DEG, spreadAir: 2 * DEG, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 5 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 3.2], [7, 0, 5.5]], recoilTau: 0.18, killReward: 900,
  },
  ar7: {
    id: 'ar7', name: 'AR-7 Rifle', slot: 1, cls: 'rifle', price: 2700, team: 'A',
    damage: 36, pellets: 1, cycle: 0.1, automatic: true, magSize: 30, reserve: 90, reloadTime: 2.5,
    rangeModifier: 0.98, range: 200, armorPen: 0.775, maxSpeed: 221 * 0.0254,
    drawTime: 0.6, spreadBase: 0.22 * DEG, spreadMove: 3.2 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.03 * DEG, spreadMax: 0.6 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.8], [4, 0.1, 3.4], [8, -0.3, 6.2], [11, -1.7, 7.0], [15, -2.5, 7.4], [18, -0.8, 7.7], [22, 1.8, 7.9], [25, 2.7, 8.1], [29, 1.2, 8.3]], recoilTau: 0.12, killReward: 300,
  },
  k4: {
    id: 'k4', name: 'K4 Carbine', slot: 1, cls: 'rifle', price: 2700, team: 'D',
    damage: 33, pellets: 1, cycle: 0.09, automatic: true, magSize: 30, reserve: 90, reloadTime: 3.0,
    rangeModifier: 0.97, range: 200, armorPen: 0.7, maxSpeed: 230 * 0.0254,
    drawTime: 0.6, spreadBase: 0.18 * DEG, spreadMove: 2.8 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.025 * DEG, spreadMax: 0.5 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.6], [5, 0.25, 2.8], [9, -0.2, 4.7], [13, 1.3, 5.3], [17, 1.9, 5.6], [21, 0.3, 5.8], [25, -1.4, 5.9], [29, -0.7, 6.0]], recoilTau: 0.11, killReward: 300,
  },
  longbow: {
    id: 'longbow', name: 'Longbow .338', slot: 1, cls: 'sniper', price: 4750,
    damage: 115, pellets: 1, cycle: 1.45, automatic: false, magSize: 10, reserve: 30, reloadTime: 3.6,
    rangeModifier: 0.99, range: 300, armorPen: 0.97, maxSpeed: 210 * 0.0254,
    drawTime: 0.9, spreadBase: 7 * DEG, spreadMove: 8 * DEG, spreadAir: 14 * DEG, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 20 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 2.8], [9, 0, 3.0]], recoilTau: 0.25,
    scope: { fovs: [40, 15], scopedSpread: 0.05 * DEG, scopedSpeed: 150 * 0.0254 }, killReward: 100,
  },
  // ---------------------------------------------------------------- pistols
  m45: {
    id: 'm45', name: 'M45 Tactical', slot: 2, cls: 'pistol', price: 500,
    damage: 34, pellets: 1, cycle: 0.17, automatic: false, magSize: 12, reserve: 72, reloadTime: 2.7,
    rangeModifier: 0.79, range: 120, armorPen: 0.5, maxSpeed: 250 * 0.0254,
    drawTime: 0.4, spreadBase: 0.25 * DEG, spreadMove: 2.0 * DEG, spreadAir: 6 * DEG, spreadPerShot: 0.4 * DEG, spreadMax: 1.6 * DEG, spreadRecovery: 6 * DEG, crouchFactor: 0.75,
    recoilPattern: [[0, 0, 0], [1, 0, 1.6], [3, 0.3, 3.6], [6, -0.4, 5.0], [11, 0.2, 5.8]], recoilTau: 0.1, killReward: 300,
  },
  k57: {
    id: 'k57', name: 'K-57 Duty', slot: 2, cls: 'pistol', price: 750, team: 'D',
    damage: 25, pellets: 1, cycle: 0.15, automatic: false, magSize: 20, reserve: 100, reloadTime: 2.7,
    rangeModifier: 0.885, range: 120, armorPen: 0.75, maxSpeed: 250 * 0.0254,
    drawTime: 0.4, spreadBase: 0.28 * DEG, spreadMove: 1.9 * DEG, spreadAir: 6 * DEG, spreadPerShot: 0.3 * DEG, spreadMax: 1.4 * DEG, spreadRecovery: 6 * DEG, crouchFactor: 0.75,
    recoilPattern: [[0, 0, 0], [1, 0, 1.1], [4, -0.3, 3.0], [9, 0.4, 4.4], [19, -0.2, 5.4]], recoilTau: 0.09, killReward: 300,
  },
  hc50: {
    id: 'hc50', name: 'HC-50 Hand Cannon', slot: 2, cls: 'pistol', price: 650,
    damage: 54, pellets: 1, cycle: 0.225, automatic: false, magSize: 7, reserve: 35, reloadTime: 2.2,
    rangeModifier: 0.81, range: 160, armorPen: 0.93, maxSpeed: 250 * 0.0254,
    drawTime: 0.5, spreadBase: 0.2 * DEG, spreadMove: 3.0 * DEG, spreadAir: 9 * DEG, spreadPerShot: 1.2 * DEG, spreadMax: 3.0 * DEG, spreadRecovery: 5 * DEG, crouchFactor: 0.8,
    recoilPattern: [[0, 0, 0], [1, 0, 3.2], [3, 0.5, 6.8], [6, -0.4, 8.5]], recoilTau: 0.16, killReward: 300,
  },
  // ------------------------------------------------------------------- SMGs
  tp9: {
    id: 'tp9', name: 'TP-9 Machine Pistol', slot: 1, cls: 'smg', price: 1250, team: 'D',
    damage: 20, pellets: 1, cycle: 0.07, automatic: true, magSize: 30, reserve: 120, reloadTime: 2.1,
    rangeModifier: 0.85, range: 100, armorPen: 0.6, maxSpeed: 250 * 0.0254,
    drawTime: 0.4, spreadBase: 0.5 * DEG, spreadMove: 1.4 * DEG, spreadAir: 5 * DEG, spreadPerShot: 0.05 * DEG, spreadMax: 1.2 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 0.8,
    recoilPattern: [[0, 0, 0], [1, 0, 0.4], [6, 0.3, 1.9], [12, -0.5, 2.7], [20, 0.5, 3.2], [29, -0.2, 3.5]], recoilTau: 0.09, killReward: 600,
  },
  r10: {
    id: 'r10', name: 'R-10 Rattler', slot: 1, cls: 'smg', price: 1400, team: 'A',
    damage: 28, pellets: 1, cycle: 0.07, automatic: true, magSize: 30, reserve: 100, reloadTime: 3.0,
    rangeModifier: 0.82, range: 90, armorPen: 0.6, maxSpeed: 250 * 0.0254,
    drawTime: 0.4, spreadBase: 0.7 * DEG, spreadMove: 1.8 * DEG, spreadAir: 6 * DEG, spreadPerShot: 0.08 * DEG, spreadMax: 1.6 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 0.85,
    recoilPattern: [[0, 0, 0], [1, 0, 0.6], [5, -0.4, 2.6], [10, 0.6, 3.8], [18, -0.8, 4.6], [29, 0.4, 5.0]], recoilTau: 0.1, killReward: 600,
  },
  u45: {
    id: 'u45', name: 'U-45 Carbine SMG', slot: 1, cls: 'smg', price: 1700,
    damage: 30, pellets: 1, cycle: 0.105, automatic: true, magSize: 25, reserve: 100, reloadTime: 3.5,
    rangeModifier: 0.82, range: 120, armorPen: 0.65, maxSpeed: 250 * 0.0254,
    drawTime: 0.5, spreadBase: 0.4 * DEG, spreadMove: 1.6 * DEG, spreadAir: 5 * DEG, spreadPerShot: 0.04 * DEG, spreadMax: 1.0 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 0.8,
    recoilPattern: [[0, 0, 0], [1, 0, 0.6], [5, 0.3, 2.4], [10, -0.5, 3.3], [17, 0.6, 3.8], [24, -0.2, 4.1]], recoilTau: 0.1, killReward: 600,
  },
  p50: {
    id: 'p50', name: 'P-50 Hornet', slot: 1, cls: 'smg', price: 2350,
    damage: 23, pellets: 1, cycle: 0.066, automatic: true, magSize: 50, reserve: 100, reloadTime: 3.3,
    rangeModifier: 0.885, range: 120, armorPen: 0.75, maxSpeed: 245 * 0.0254,
    drawTime: 0.5, spreadBase: 0.45 * DEG, spreadMove: 1.5 * DEG, spreadAir: 5 * DEG, spreadPerShot: 0.03 * DEG, spreadMax: 1.0 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 0.8,
    recoilPattern: [[0, 0, 0], [1, 0, 0.35], [8, 0.4, 1.8], [16, -0.6, 2.6], [26, 0.7, 3.1], [36, -0.4, 3.4], [49, 0.2, 3.6]], recoilTau: 0.09, killReward: 600,
  },
  // --------------------------------------------------------------- shotguns
  auto12: {
    id: 'auto12', name: 'Auto-12 Combat Shotgun', slot: 1, cls: 'shotgun', price: 3000,
    damage: 18, pellets: 6, cycle: 0.25, automatic: false, magSize: 7, reserve: 32, reloadTime: 3.0,
    rangeModifier: 0.7, range: 40, armorPen: 0.5, maxSpeed: 240 * 0.0254,
    drawTime: 0.6, spreadBase: 3.4 * DEG, spreadMove: 0.6 * DEG, spreadAir: 2 * DEG, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 5 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 2.2], [3, 0.4, 4.0], [6, -0.3, 5.2]], recoilTau: 0.16, killReward: 900,
  },
  // ----------------------------------------------------------------- rifles
  gr3: {
    id: 'gr3', name: 'GR-3 Galeo', slot: 1, cls: 'rifle', price: 2000, team: 'A',
    damage: 30, pellets: 1, cycle: 0.0875, automatic: true, magSize: 35, reserve: 90, reloadTime: 2.95,
    rangeModifier: 0.98, range: 200, armorPen: 0.775, maxSpeed: 240 * 0.0254,
    drawTime: 0.6, spreadBase: 0.3 * DEG, spreadMove: 2.8 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.04 * DEG, spreadMax: 0.8 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.7], [4, 0.2, 2.9], [8, -0.5, 5.0], [13, 1.0, 5.8], [19, -1.2, 6.3], [26, 0.8, 6.7], [34, 0, 7.0]], recoilTau: 0.12, killReward: 300,
  },
  fm2: {
    id: 'fm2', name: 'FM-2 Falcon', slot: 1, cls: 'rifle', price: 2250, team: 'D',
    damage: 30, pellets: 1, cycle: 0.09, automatic: true, magSize: 25, reserve: 90, reloadTime: 3.3,
    rangeModifier: 0.96, range: 200, armorPen: 0.7, maxSpeed: 220 * 0.0254,
    drawTime: 0.6, spreadBase: 0.25 * DEG, spreadMove: 2.8 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.03 * DEG, spreadMax: 0.7 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.6], [4, -0.2, 2.6], [8, 0.4, 4.4], [13, -0.9, 5.2], [18, 1.0, 5.6], [24, 0, 5.9]], recoilTau: 0.11, killReward: 300,
  },
  sg5: {
    id: 'sg5', name: 'SG-5 Scout Rifle', slot: 1, cls: 'rifle', price: 3500, team: 'A',
    damage: 33, pellets: 1, cycle: 0.0825, automatic: true, magSize: 30, reserve: 90, reloadTime: 3.0,
    rangeModifier: 0.955, range: 220, armorPen: 0.8, maxSpeed: 235 * 0.0254,
    drawTime: 0.6, spreadBase: 0.2 * DEG, spreadMove: 3.0 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.03 * DEG, spreadMax: 0.6 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.7], [5, 0.2, 3.0], [9, -0.4, 5.3], [14, 1.4, 6.0], [20, -1.6, 6.5], [29, 0.8, 7.0]], recoilTau: 0.12,
    scope: { fovs: [55], scopedSpread: 0.12 * DEG, scopedSpeed: 200 * 0.0254, keepScope: true }, killReward: 300,
  },
  au3: {
    id: 'au3', name: 'AU-3 Bullpup', slot: 1, cls: 'rifle', price: 3500, team: 'D',
    damage: 32, pellets: 1, cycle: 0.09, automatic: true, magSize: 30, reserve: 90, reloadTime: 3.3,
    rangeModifier: 0.96, range: 220, armorPen: 0.7, maxSpeed: 221 * 0.0254,
    drawTime: 0.6, spreadBase: 0.18 * DEG, spreadMove: 2.8 * DEG, spreadAir: 8 * DEG, spreadPerShot: 0.025 * DEG, spreadMax: 0.5 * DEG, spreadRecovery: 3 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.6], [5, 0.3, 2.7], [9, -0.3, 4.6], [14, 1.1, 5.3], [20, -1.0, 5.7], [29, 0.4, 6.1]], recoilTau: 0.11,
    scope: { fovs: [55], scopedSpread: 0.1 * DEG, scopedSpeed: 190 * 0.0254, keepScope: true }, killReward: 300,
  },
  // ---------------------------------------------------------------- snipers
  kestrel: {
    id: 'kestrel', name: 'Kestrel Light Sniper', slot: 1, cls: 'sniper', price: 2750,
    damage: 75, pellets: 1, cycle: 1.25, automatic: false, magSize: 10, reserve: 90, reloadTime: 2.0,
    rangeModifier: 0.98, range: 300, armorPen: 0.85, maxSpeed: 260 * 0.0254,
    drawTime: 0.7, spreadBase: 3.5 * DEG, spreadMove: 5 * DEG, spreadAir: 10 * DEG, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 20 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 2.2], [9, 0, 2.4]], recoilTau: 0.2,
    scope: { fovs: [40, 15], scopedSpread: 0.07 * DEG, scopedSpeed: 220 * 0.0254 }, killReward: 300,
  },
  rp3: {
    id: 'rp3', name: 'RP-3 Marksman (semi-auto)', slot: 1, cls: 'sniper', price: 5000, team: 'A',
    damage: 80, pellets: 1, cycle: 0.25, automatic: false, magSize: 20, reserve: 90, reloadTime: 4.6,
    rangeModifier: 0.98, range: 300, armorPen: 0.83, maxSpeed: 210 * 0.0254,
    drawTime: 0.8, spreadBase: 4 * DEG, spreadMove: 6 * DEG, spreadAir: 12 * DEG, spreadPerShot: 0.15 * DEG, spreadMax: 0.6 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 1.8], [4, 0.3, 4.0], [9, -0.2, 5.0]], recoilTau: 0.18,
    scope: { fovs: [40, 15], scopedSpread: 0.1 * DEG, scopedSpeed: 150 * 0.0254, keepScope: true }, killReward: 300,
  },
  vg5: {
    id: 'vg5', name: 'VG-5 Vanguard (semi-auto)', slot: 1, cls: 'sniper', price: 4200, team: 'D',
    damage: 70, pellets: 1, cycle: 0.25, automatic: false, magSize: 30, reserve: 90, reloadTime: 3.8,
    rangeModifier: 0.98, range: 300, armorPen: 0.83, maxSpeed: 210 * 0.0254,
    drawTime: 0.8, spreadBase: 4 * DEG, spreadMove: 6 * DEG, spreadAir: 12 * DEG, spreadPerShot: 0.15 * DEG, spreadMax: 0.6 * DEG, spreadRecovery: 4 * DEG, crouchFactor: 1,
    recoilPattern: [[0, 0, 0], [1, 0, 1.6], [4, -0.3, 3.6], [9, 0.2, 4.6]], recoilTau: 0.18,
    scope: { fovs: [40, 15], scopedSpread: 0.1 * DEG, scopedSpeed: 150 * 0.0254, keepScope: true }, killReward: 300,
  },
  // ------------------------------------------------------------ machine gun
  mg9: {
    id: 'mg9', name: 'MG-9 Bulldog', slot: 1, cls: 'mg', price: 5750,
    damage: 32, pellets: 1, cycle: 0.08, automatic: true, magSize: 100, reserve: 200, reloadTime: 4.7,
    rangeModifier: 0.97, range: 200, armorPen: 0.8, maxSpeed: 220 * 0.0254,
    drawTime: 1.0, spreadBase: 0.6 * DEG, spreadMove: 3.6 * DEG, spreadAir: 9 * DEG, spreadPerShot: 0.05 * DEG, spreadMax: 1.6 * DEG, spreadRecovery: 2.5 * DEG, crouchFactor: 0.7,
    recoilPattern: [[0, 0, 0], [1, 0, 0.8], [5, 0.3, 3.2], [10, -0.8, 5.4], [18, 1.4, 6.6], [30, -1.6, 7.4], [50, 1.0, 8.0], [99, 0, 8.4]], recoilTau: 0.14, killReward: 300,
  },
  // --------------------------------------------------------------- grenades
  he: {
    id: 'he', name: 'HE Grenade', slot: 4, cls: 'grenade', price: 300,
    damage: 0, pellets: 1, cycle: 0.9, automatic: false, magSize: 1, reserve: 0, reloadTime: 0,
    rangeModifier: 1, range: 0, armorPen: 1, maxSpeed: 250 * 0.0254,
    drawTime: 0.5, spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1, crouchFactor: 1,
    recoilPattern: [], recoilTau: 0.1, killReward: 300,
  },
  flash: {
    id: 'flash', name: 'Flashbang', slot: 4, cls: 'grenade', price: 200,
    damage: 0, pellets: 1, cycle: 0.9, automatic: false, magSize: 1, reserve: 0, reloadTime: 0,
    rangeModifier: 1, range: 0, armorPen: 1, maxSpeed: 250 * 0.0254,
    drawTime: 0.5, spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1, crouchFactor: 1,
    recoilPattern: [], recoilTau: 0.1, killReward: 300,
  },
  smoke: {
    id: 'smoke', name: 'Smoke Grenade', slot: 4, cls: 'grenade', price: 300,
    damage: 0, pellets: 1, cycle: 0.9, automatic: false, magSize: 1, reserve: 0, reloadTime: 0,
    rangeModifier: 1, range: 0, armorPen: 1, maxSpeed: 250 * 0.0254,
    drawTime: 0.5, spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 1, crouchFactor: 1,
    recoilPattern: [], recoilTau: 0.1, killReward: 300,
  },
};

export type NadeType = 'he' | 'flash' | 'smoke';
export const NADE_TYPES: NadeType[] = ['he', 'flash', 'smoke'];
export const isNade = (id: WeaponId): id is NadeType => id === 'he' || id === 'flash' || id === 'smoke';

/**
 * Grenade behaviour (metres, seconds). Carry limits as in the classic game:
 * one HE, two flashbangs, one smoke.
 */
export const NADE = {
  max: { he: 1, flash: 2, smoke: 1 } as Record<NadeType, number>,
  throwSpeed: 15,
  /** Right click: a short underhand lob. */
  lobSpeed: 7,
  gravity: 13,
  bounce: 0.45,
  fuse: { he: 1.6, flash: 1.6, smoke: 3 } as Record<NadeType, number>,
  heRadius: 9.5,
  heDamage: 98,
  flashRadius: 30,
  /** Longest full blindness (s), when the flash goes off right in front of you. */
  flashFull: 2.2,
  /** Plus this long fading back (s). */
  flashFade: 2.6,
  smokeRadius: 4.2,
  smokeDuration: 15,
  /** Seconds for a smoke to reach full size, and to thin out at the end. */
  smokeGrow: 1.2,
  smokeFade: 2,
} as const;

/** Buy-menu order, grouped like the classic menu (1 pistols … 5 machine gun). */
export const BUYABLE: WeaponId[] = [
  'p9', 'm45', 'k57', 'hc50',
  'pump12', 'auto12',
  'tp9', 'r10', 'mk5', 'u45', 'p50',
  'gr3', 'fm2', 'ar7', 'k4', 'sg5', 'au3', 'kestrel', 'longbow', 'rp3', 'vg5',
  'mg9',
];

/** Buy-menu categories (number keys), in the classic order. */
export const BUY_CATEGORIES: { key: string; name: string; classes: WeaponClass[] }[] = [
  { key: '1', name: 'Pistols', classes: ['pistol'] },
  { key: '2', name: 'Shotguns', classes: ['shotgun'] },
  { key: '3', name: 'SMGs', classes: ['smg'] },
  { key: '4', name: 'Rifles', classes: ['rifle', 'sniper'] },
  { key: '5', name: 'Machine gun', classes: ['mg'] },
];

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
