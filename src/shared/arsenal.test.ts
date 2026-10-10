import { describe, expect, it } from 'vitest';
import { GUN_RECIPES } from '../audio/soundBank';
import { gunModel } from '../render/guns';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { Simulation, TICK_DT, emptyCmd } from './sim';
import { weaponStats } from '../ui/hud';
import { BUYABLE, BUY_CATEGORIES, WEAPONS, computeDamage, type WeaponId } from './weapons';

/** The full arsenal: every gun is complete, buyable by the right team, and fills its role. */

const guns = BUYABLE;
const shotsToKill = (id: WeaponId, group: 'head' | 'chest', dist: number, armored: boolean) => {
  const def = WEAPONS[id];
  let hp = 100;
  let armor = armored ? 100 : 0;
  let n = 0;
  while (hp > 0 && n < 50) {
    const r = computeDamage(def, dist, group, armor, armored);
    hp -= r.health * def.pellets;
    armor = Math.max(0, armor - r.armor * def.pellets);
    n++;
  }
  return n;
};

describe('arsenal: completeness', () => {
  it('has a gun for every classic role, and every gun is in exactly one buy category', () => {
    const byCls = (c: string) => guns.filter((id) => WEAPONS[id].cls === c).length;
    expect(byCls('pistol')).toBeGreaterThanOrEqual(4);
    expect(byCls('smg')).toBeGreaterThanOrEqual(5);
    expect(byCls('shotgun')).toBeGreaterThanOrEqual(2);
    expect(byCls('rifle')).toBeGreaterThanOrEqual(6);
    expect(byCls('sniper')).toBeGreaterThanOrEqual(4);
    expect(byCls('mg')).toBeGreaterThanOrEqual(1);
    for (const id of guns) {
      expect(BUY_CATEGORIES.filter((c) => c.classes.includes(WEAPONS[id].cls)).length, id).toBe(1);
    }
  });

  it('every gun has a sound recipe, a model with a muzzle, and a recoil pattern', () => {
    for (const id of guns) {
      expect(GUN_RECIPES[id as keyof typeof GUN_RECIPES], id).toBeTruthy();
      const g = gunModel(id, WEAPONS[id].cls, true);
      expect(g.getObjectByName('muzzle'), id).toBeTruthy();
      expect(WEAPONS[id].recoilPattern.length, id).toBeGreaterThan(1);
      expect(WEAPONS[id].id).toBe(id);
    }
  });

  it('each team gets its own exclusive guns and both get the shared ones', () => {
    const forTeam = (t: 'A' | 'D') => guns.filter((id) => !WEAPONS[id].team || WEAPONS[id].team === t);
    expect(forTeam('A')).toContain('ar7');
    expect(forTeam('A')).not.toContain('k4');
    expect(forTeam('D')).toContain('k4');
    expect(forTeam('D')).not.toContain('ar7');
    // Comparable variety on both sides.
    expect(Math.abs(forTeam('A').length - forTeam('D').length)).toBeLessThanOrEqual(1);
  });
});

describe('arsenal: roles', () => {
  it('the hand cannon and the snipers kill an unarmoured player with one headshot; light pistols do not', () => {
    expect(shotsToKill('hc50', 'head', 10, false)).toBe(1);
    for (const id of ['kestrel', 'longbow', 'rp3', 'vg5'] as WeaponId[]) expect(shotsToKill(id, 'head', 30, true), id).toBe(1);
    expect(shotsToKill('p9', 'head', 10, true)).toBeGreaterThan(1);
  });

  it('only the heavy sniper kills an armoured player with one body shot', () => {
    expect(shotsToKill('longbow', 'chest', 30, true)).toBe(1);
    for (const id of ['kestrel', 'rp3', 'vg5'] as WeaponId[]) expect(shotsToKill(id, 'chest', 30, true), id).toBeGreaterThan(1);
  });

  it('rifles out-range SMGs: at 40 m an SMG needs clearly more body shots than a rifle', () => {
    const smg = Math.min(...['tp9', 'r10', 'mk5', 'u45', 'p50'].map((id) => shotsToKill(id as WeaponId, 'chest', 40, true)));
    const rifle = Math.max(...['gr3', 'fm2', 'ar7', 'k4', 'sg5', 'au3'].map((id) => shotsToKill(id as WeaponId, 'chest', 40, true)));
    expect(smg).toBeGreaterThan(rifle);
  });

  it('cheaper guns in a class are weaker per second than the expensive ones (no free upgrades)', () => {
    const dps = (id: WeaponId) => (WEAPONS[id].damage * WEAPONS[id].pellets * WEAPONS[id].armorPen) / WEAPONS[id].cycle;
    expect(dps('gr3')).toBeLessThan(dps('ar7'));
    expect(dps('fm2')).toBeLessThan(dps('k4'));
    expect(dps('tp9')).toBeLessThan(dps('p50'));
  });

  it('the light sniper is the fastest gun to run with; the machine gun and heavy sniper the slowest', () => {
    const speeds = guns.map((id) => WEAPONS[id].maxSpeed);
    expect(WEAPONS.kestrel.maxSpeed).toBe(Math.max(...speeds));
    expect(WEAPONS.longbow.maxSpeed).toBe(Math.min(...speeds));
    expect(WEAPONS.mg9.maxSpeed).toBeLessThan(WEAPONS.ar7.maxSpeed);
  });
});

describe('arsenal: buying and scopes in the simulation', () => {
  const map = buildMap(DEPOT);
  function live() {
    const sim = new Simulation(map, { freezeTime: 5 }, 3);
    const a = sim.addPlayer('a', 'A', false);
    const d = sim.addPlayer('d', 'D', false);
    sim.tick();
    a.money = d.money = 16000;
    return { sim, a, d };
  }

  it('every gun can be bought by its team, refused to the other, and lands in the right slot', () => {
    for (const id of guns) {
      const { sim, a, d } = live();
      const def = WEAPONS[id];
      for (const p of [a, d]) {
        const err = sim.buy(p, id);
        const allowed = !def.team || def.team === p.team;
        if (!allowed) expect(err, `${id} for ${p.team}`).toMatch(/not available/);
        else if (id === 'p9') expect(err).toMatch(/already carry/); // the default pistol
        else {
          expect(err, `${id} for ${p.team}`).toBeNull();
          expect(p.weapons[def.slot]?.id).toBe(id);
        }
      }
    }
  });

  it('scoped rifles and semi-automatic snipers stay zoomed while firing; bolt-action ones drop out', () => {
    for (const [id, stays] of [['sg5', true], ['vg5', true], ['kestrel', false], ['longbow', false]] as [WeaponId, boolean][]) {
      const { sim, a: att, d: def } = live();
      const a = WEAPONS[id].team === 'D' ? def : att;
      expect(sim.buy(a, id), id).toBeNull();
      while (sim.phase !== 'live') sim.tick();
      for (let i = 0; i < 60; i++) {
        sim.setCmd(a, emptyCmd(a.yaw));
        sim.tick();
      }
      sim.setCmd(a, { ...emptyCmd(a.yaw), altFire: true });
      sim.tick();
      expect(a.scope, id).toBe(1);
      sim.setCmd(a, { ...emptyCmd(a.yaw), fire: true });
      sim.tick();
      expect(a.scope > 0, `${id} after a shot`).toBe(stays);
      for (let t = 0; t < 2 / TICK_DT; t++) {
        sim.setCmd(a, emptyCmd(a.yaw));
        sim.tick();
      }
      expect(a.scope, `${id} after the bolt cycles`).toBe(1);
    }
  });
});

describe('scoreboard damage', () => {
  it('counts damage dealt to enemies, capped at what the victim had left; none for teammates', () => {
    const map = buildMap(DEPOT);
    const sim = new Simulation(map, { freezeTime: 0.05, friendlyFire: true }, 2);
    const a = sim.addPlayer('a', 'A', false);
    const a2 = sim.addPlayer('a2', 'A', false);
    const d = sim.addPlayer('d', 'D', false);
    while (sim.phase !== 'live') sim.tick();
    sim.damage(d, a, 40, 'chest', d.body.pos, 'ar7');
    sim.damage(d, a, 500, 'head', d.body.pos, 'ar7'); // only 60 were left
    sim.damage(a2, a, 30, 'chest', a2.body.pos, 'ar7'); // a teammate
    expect(a.damageDealt).toBe(100);
  });
});

describe('buy menu stats', () => {
  it('shows damage, rate, magazine and armour penetration for guns; nothing for grenades', () => {
    expect(weaponStats(WEAPONS.ar7)).toBe('36 dmg · 600 rpm · 30 rounds · 78% vs armour');
    expect(weaponStats(WEAPONS.pump12)).toMatch(/^20×9 dmg/);
    expect(weaponStats(WEAPONS.sg5)).toMatch(/scope$/);
    expect(weaponStats(WEAPONS.he)).toBe('');
  });
});
