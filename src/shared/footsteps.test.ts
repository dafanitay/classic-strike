import { describe, expect, it } from 'vitest';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { Simulation, TICK_DT, emptyCmd, type PlayerCmd, type SimEvent } from './sim';

/** Footstep sounds are driven by simulation `step` events, so test those. */
describe('footsteps come from actual movement', () => {
  const run = (cmd: (yaw: number) => PlayerCmd, seconds: number, kill = false) => {
    const sim = new Simulation(buildMap(DEPOT), { freezeTime: 0.05, roundTime: 600 }, 1);
    const p = sim.addPlayer('p', 'A', false);
    sim.addPlayer('d', 'D', false);
    while (sim.phase !== 'live') sim.tick();
    const c = sim.map.cellCenter(10, 3); // Long A, open ground
    p.body.pos = { x: c.x, y: c.y, z: c.z };
    if (kill) sim.damage(p, null, 500, 'chest', p.body.pos, 'knife');
    const steps: SimEvent[] = [];
    for (let i = 0; i < seconds / TICK_DT; i++) {
      sim.setCmd(p, cmd(-Math.PI / 2)); // face +X along Long A
      sim.events.length = 0;
      sim.tick();
      steps.push(...sim.events.filter((e) => e.type === 'step' && e.player === p.id));
    }
    return steps as Extract<SimEvent, { type: 'step' }>[];
  };

  it('none while standing still, crouch-walking, or dead', () => {
    expect(run((y) => emptyCmd(y, 0), 3)).toHaveLength(0);
    expect(run((y) => ({ ...emptyCmd(y, 0), forward: 1, crouch: true }), 3)).toHaveLength(0);
    expect(run((y) => ({ ...emptyCmd(y, 0), forward: 1 }), 3, true)).toHaveLength(0);
  });

  it('running: a step about every 1.7 m (~3 per second), audible to others', () => {
    const steps = run((y) => ({ ...emptyCmd(y, 0), forward: 1 }), 3);
    expect(steps.length).toBeGreaterThanOrEqual(7);
    expect(steps.length).toBeLessThanOrEqual(10);
    expect(steps.every((s) => !s.walk)).toBe(true);
  });

  it('walking (Shift): fewer steps, flagged as quiet (others do not hear them)', () => {
    const steps = run((y) => ({ ...emptyCmd(y, 0), forward: 1, walk: true }), 3);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThan(6);
    expect(steps.every((s) => s.walk)).toBe(true);
  });
});
