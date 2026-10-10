import { BotDirector, type Difficulty } from './bot';
import { buildMap, type MapData, type Team } from './map';
import { DEPOT } from './maps/depot';
import { Simulation, TICK_RATE, type SimPlayer } from './sim';
import { dist2D } from './vec';

/**
 * Headless measurement of how bots use the map: used by the bot behaviour
 * tests and by scripts that record before/after numbers. Not shipped in the
 * game bundle (nothing in the client imports it).
 */

/** Which lane of Depot an area belongs to (for route-diversity counts). */
export const DEPOT_LANES: Record<string, string> = {
  'Outside Long': 'long', 'Long A': 'long',
  Catwalk: 'short', 'Short A': 'short',
  Mid: 'mid', 'Mid Doors': 'mid',
  'Outside Tunnels': 'tunnels', 'B Tunnels': 'tunnels',
  'Lower Tunnel': 'lower',
};

export interface RoundStats {
  /** Mean distance from each living bot to its nearest living teammate (m). */
  meanNearest: number;
  /** Fraction of samples in which a bot had a teammate within 3 m. */
  huddled: number;
  /** Mean number of distinct map areas a team's living bots occupy. */
  areas: number;
  /** Largest number of teammates within 5 m of one bot (incl. itself), averaged. */
  biggestGroup: number;
  /** Attackers: distinct lanes used per round (first lane each attacker entered). */
  lanes: number;
}

export interface MatchStats {
  rounds: number;
  kills: number;
  timeouts: number;
  reasons: Record<string, number>;
  early: Record<Team, RoundStats>; // first 25 s of each live round
  whole: Record<Team, RoundStats>; // whole live rounds
  /** Ticks bots spent pressing movement keys without moving (>1 s windows). */
  stuckSeconds: number;
  /** Bots that left the map's open floor (should always be 0). */
  outOfMap: number;
  /** Mean length of the live phase of a round (s). */
  roundLength: number;
}

interface Acc {
  n: number;
  nearest: number;
  huddled: number;
  areaSamples: number;
  areas: number;
  groupSamples: number;
  group: number;
  laneRounds: number;
  lanes: number;
}

const emptyAcc = (): Acc => ({ n: 0, nearest: 0, huddled: 0, areaSamples: 0, areas: 0, groupSamples: 0, group: 0, laneRounds: 0, lanes: 0 });

function finish(a: Acc): RoundStats {
  return {
    meanNearest: a.n ? a.nearest / a.n : 0,
    huddled: a.n ? a.huddled / a.n : 0,
    areas: a.areaSamples ? a.areas / a.areaSamples : 0,
    biggestGroup: a.groupSamples ? a.group / a.groupSamples : 0,
    lanes: a.laneRounds ? a.lanes / a.laneRounds : 0,
  };
}

function sample(map: MapData, team: SimPlayer[], acc: Acc): void {
  if (team.length < 2) return;
  const areas = new Set<string>();
  let biggest = 0;
  for (const p of team) {
    let best = Infinity;
    let near = 1;
    for (const q of team) {
      if (q === p) continue;
      const d = dist2D(p.body.pos, q.body.pos);
      best = Math.min(best, d);
      if (d < 5) near++;
    }
    acc.n++;
    acc.nearest += best;
    if (best < 3) acc.huddled++;
    biggest = Math.max(biggest, near);
    areas.add(map.areaNameAt(p.body.pos));
  }
  acc.areaSamples++;
  acc.areas += areas.size;
  acc.groupSamples++;
  acc.group += biggest;
}

export function measureMatch(difficulty: Difficulty, seed: number, perTeam: number, roundsToWin = 5, maxMinutes = 30): MatchStats {
  const map = buildMap(DEPOT);
  const sim = new Simulation(map, { roundsToWin }, seed);
  const bots = new BotDirector(sim, difficulty);
  for (let i = 0; i < perTeam; i++) {
    sim.addPlayer(BotDirector.botName('A', i), 'A', true);
    sim.addPlayer(BotDirector.botName('D', i), 'D', true);
  }
  const early = { A: emptyAcc(), D: emptyAcc() };
  const whole = { A: emptyAcc(), D: emptyAcc() };
  const firstLane = new Map<number, string>();
  let rounds = 0;
  let kills = 0;
  let timeouts = 0;
  const reasons: Record<string, number> = {};
  let stuckSeconds = 0;
  let outOfMap = 0;
  let liveTicks = 0;
  const lastPos = new Map<number, { x: number; z: number; pressing: number }>();
  const every = Math.round(TICK_RATE / 2);
  for (let t = 0; t < TICK_RATE * 60 * maxMinutes && sim.phase !== 'matchEnd'; t++) {
    bots.update();
    sim.events.length = 0;
    sim.tick();
    bots.observe(sim.events);
    for (const e of sim.events) {
      if (e.type === 'kill') kills++;
      if (e.type === 'roundStart') firstLane.clear();
      if (e.type === 'roundEnd') {
        rounds++;
        reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
        if (e.reason.startsWith('Time')) timeouts++;
        const lanes = new Set(firstLane.values());
        if (firstLane.size) {
          early.A.laneRounds++;
          early.A.lanes += lanes.size;
          whole.A.laneRounds++;
          whole.A.lanes += lanes.size;
        }
      }
    }
    if (sim.phase !== 'live') continue;
    liveTicks++;
    for (const p of sim.players) {
      if (!p.alive) continue;
      const c = map.cellOf(p.body.pos);
      if (!map.walkable(c.x, c.z) && map.cell(c.x, c.z) === 0) outOfMap++;
      if (p.team === 'A' && !firstLane.has(p.id)) {
        const lane = DEPOT_LANES[map.areaNameAt(p.body.pos)];
        if (lane) firstLane.set(p.id, lane);
      }
    }
    if (t % every) continue;
    const sinceStart = sim.time - sim.roundStartTime;
    for (const team of ['A', 'D'] as Team[]) {
      const alive = sim.players.filter((p) => p.team === team && p.alive);
      sample(map, alive, whole[team]);
      if (sinceStart < 25) sample(map, alive, early[team]);
    }
    // Stuck: pressing movement keys while not moving, sampled every 0.5 s.
    for (const p of sim.players) {
      if (!p.alive) continue;
      const pressing = p.cmd.forward !== 0 || p.cmd.side !== 0;
      const prev = lastPos.get(p.id);
      if (prev && pressing && Math.hypot(prev.x - p.body.pos.x, prev.z - p.body.pos.z) < 0.1) stuckSeconds += 0.5;
      lastPos.set(p.id, { x: p.body.pos.x, z: p.body.pos.z, pressing: pressing ? 1 : 0 });
    }
  }
  return {
    rounds,
    kills,
    timeouts,
    reasons,
    early: { A: finish(early.A), D: finish(early.D) },
    whole: { A: finish(whole.A), D: finish(whole.D) },
    stuckSeconds,
    outOfMap,
    roundLength: liveTicks / TICK_RATE / Math.max(1, rounds),
  };
}

/** Averages several matches into one line per metric (for reports). */
export function summarize(all: MatchStats[]): string {
  const avg = (f: (m: MatchStats) => number) => all.reduce((s, m) => s + f(m), 0) / all.length;
  const r = (v: number, d = 2) => v.toFixed(d);
  const lines = [
    `matches ${all.length}, rounds ${r(avg((m) => m.rounds), 1)}, round length ${r(avg((m) => m.roundLength), 0)} s, kills/round ${r(avg((m) => m.kills / Math.max(1, m.rounds)), 1)}, timeouts ${r(avg((m) => m.timeouts), 1)}`,
  ];
  for (const span of ['early', 'whole'] as const) {
    for (const team of ['A', 'D'] as Team[]) {
      lines.push(
        `${span.padEnd(5)} ${team}: nearest teammate ${r(avg((m) => m[span][team].meanNearest), 1)} m, within 3 m ${r(avg((m) => m[span][team].huddled) * 100, 0)}%, areas ${r(avg((m) => m[span][team].areas), 2)}, biggest group ${r(avg((m) => m[span][team].biggestGroup), 2)}` +
          (team === 'A' ? `, lanes/round ${r(avg((m) => m[span].A.lanes), 2)}` : ''),
      );
    }
  }
  lines.push(`stuck (pressing keys, not moving) ${r(avg((m) => m.stuckSeconds), 1)} bot-seconds/match, left the map ${r(avg((m) => m.outOfMap), 0)} ticks`);
  return lines.join('\n');
}
