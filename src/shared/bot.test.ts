import { describe, expect, it } from 'vitest';
import { BotDirector, type Difficulty } from './bot';
import { buildMap } from './map';
import { DEPOT } from './maps/depot';
import { Simulation, TICK_RATE } from './sim';

/**
 * Headless bot-vs-bot matches. These prove bots navigate the map, find each
 * other, fight, and that the round/economy loop runs a full match to the end
 * with nobody touching the game state.
 */
function runMatch(difficulty: Difficulty, seed: number, roundsToWin: number, perTeam: number) {
  const sim = new Simulation(buildMap(DEPOT), { roundsToWin }, seed);
  const bots = new BotDirector(sim, difficulty);
  for (let i = 0; i < perTeam; i++) {
    sim.addPlayer(BotDirector.botName('A', i), 'A', true);
    sim.addPlayer(BotDirector.botName('D', i), 'D', true);
  }
  let kills = 0;
  let rounds = 0;
  let timeouts = 0;
  const maxTicks = TICK_RATE * 60 * 30;
  for (let t = 0; t < maxTicks && sim.phase !== 'matchEnd'; t++) {
    bots.update();
    sim.events.length = 0;
    sim.tick();
    bots.observe(sim.events);
    for (const e of sim.events) {
      if (e.type === 'kill') kills++;
      if (e.type === 'roundEnd') {
        rounds++;
        if (e.reason.startsWith('Time')) timeouts++;
      }
    }
  }
  return { sim, kills, rounds, timeouts };
}

describe('bots', () => {
  for (const diff of ['easy', 'normal', 'hard'] as const) {
    it(`play a complete ${diff} match to the end`, () => {
      const { sim, kills, rounds, timeouts } = runMatch(diff, 7, 3, 3);
      expect(sim.phase).toBe('matchEnd');
      expect(Math.max(sim.score.A, sim.score.D)).toBe(3);
      expect(kills).toBeGreaterThanOrEqual(rounds * 2);
      // Bots must actually find each other: most rounds end by elimination.
      expect(timeouts).toBeLessThanOrEqual(Math.floor(rounds / 2));
    }, 60_000);
  }

  it('hard bots beat easy bots more often than not', () => {
    let hardWins = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const sim = new Simulation(buildMap(DEPOT), { roundsToWin: 3 }, seed);
      // Two directors share one sim: each only drives its own team.
      const hard = new BotDirector(sim, 'hard');
      const easy = new BotDirector(sim, 'easy');
      for (let i = 0; i < 3; i++) {
        sim.addPlayer('H' + i, 'A', true);
        sim.addPlayer('E' + i, 'D', true);
      }
      for (let t = 0; t < TICK_RATE * 60 * 20 && sim.phase !== 'matchEnd'; t++) {
        hard.update();
        const hardCmds = new Map(sim.players.filter((p) => p.team === 'A').map((p) => [p.id, p.cmd]));
        easy.update();
        for (const p of sim.players) if (p.team === 'A' && hardCmds.has(p.id)) p.cmd = hardCmds.get(p.id)!;
        sim.events.length = 0;
        sim.tick();
        hard.observe(sim.events);
        easy.observe(sim.events);
      }
      if (sim.score.A > sim.score.D) hardWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('play the bomb objective: carry it to a site, plant, fetch it when dropped, defuse', () => {
    const sim = new Simulation(buildMap(DEPOT), { roundsToWin: 8 }, 1);
    const bots = new BotDirector(sim, 'easy');
    for (let i = 0; i < 5; i++) {
      sim.addPlayer(BotDirector.botName('A', i), 'A', true);
      sim.addPlayer(BotDirector.botName('D', i), 'D', true);
    }
    const count: Record<string, number> = {};
    for (let t = 0; t < TICK_RATE * 60 * 40 && sim.phase !== 'matchEnd'; t++) {
      bots.update();
      sim.events.length = 0;
      sim.tick();
      bots.observe(sim.events);
      for (const e of sim.events) count[e.type] = (count[e.type] ?? 0) + 1;
    }
    expect(sim.phase).toBe('matchEnd');
    expect(count.planted ?? 0).toBeGreaterThanOrEqual(2);
    expect(count.defused ?? 0).toBeGreaterThanOrEqual(1);
    expect(count.bombPickup ?? 0).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
