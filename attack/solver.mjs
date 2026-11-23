// "Code agent" attack on Shadow Sculptor: skip the UI, read the round data from
// the API, solve the pose offline by search, and POST the answer.
// Usage: node attack/solver.mjs <baseUrl> [name] [msPerRound]
import { randomQuat, normalizeQuat, rasterize, projectPolys, iou, unpackMask, mulberry32 } from '../public/shared.js';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const NAME = process.argv[3] ?? 'AI code solver';
const BUDGET = Number(process.argv[4] ?? 1200);
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const rand = mulberry32(Date.now() >>> 0);

function solve(round) {
  const target = unpackMask(round.mask);
  const f = (q) => iou(rasterize(projectPolys(round.cells, q), round.radius), target);
  const end = Date.now() + BUDGET;
  let best = null, bestS = -1;
  while (Date.now() < end) {                       // random restarts
    let q = randomQuat(rand), s = f(q), step = 0.5;
    while (step > 0.004 && Date.now() < end) {     // hill climb with shrinking steps
      const c = normalizeQuat(q.map((v) => v + (rand() * 2 - 1) * step));
      const cs = f(c);
      if (cs > s) { q = c; s = cs; } else step *= 0.97;
    }
    if (s > bestS) { best = q; bestS = s; }
    if (bestS > 0.97) break;
  }
  return { q: best, est: bestS };
}

const t0 = Date.now();
let data = await post('/api/start', { name: NAME });
const { sessionId } = data;
let round = data.round, log = [];
while (true) {
  const started = Date.now();
  const { q, est } = solve(round);
  const wait = 1050 - (Date.now() - started);       // stay above the 1 s "too fast" rule
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await post('/api/submit', { sessionId, round: round.index, q });
  if (res.done) { console.log(JSON.stringify({ final: res.score, rounds: log.length, log })); break; }
  log.push({ cubes: round.cells.length, est: +est.toFixed(3), match: res.match, points: res.points });
  console.error(`round ${round.index} cubes=${round.cells.length} est=${est.toFixed(3)} match=${res.match} +${res.points} total=${res.score}`);
  round = res.round;
  if (Date.now() - t0 > 92_000) { const f = await post('/api/submit', { sessionId, finish: true }); console.log(JSON.stringify({ final: f.score, rounds: log.length, log })); break; }
}
