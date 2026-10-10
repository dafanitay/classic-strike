// Records bot spatial-behaviour metrics over several headless matches.
//   node --import ./scripts/register-ts.mjs scripts/bot-metrics.ts [difficulty] [perTeam] [matches]
import type { Difficulty } from '../src/shared/bot';
import { measureMatch, summarize } from '../src/shared/botMetrics';

const diff = (process.argv[2] ?? 'normal') as Difficulty;
const perTeam = Number(process.argv[3] ?? 5);
const matches = Number(process.argv[4] ?? 4);
const all = [];
const t0 = performance.now();
for (let seed = 1; seed <= matches; seed++) all.push(measureMatch(diff, seed, perTeam));
console.log(`${diff}, ${perTeam}v${perTeam}, seeds 1..${matches} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
console.log(summarize(all));
