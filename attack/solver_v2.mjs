// Smarter "code agent" attack on the hardened game: solve the pose offline,
// then forge a human-looking input log that turns the server's start pose into it.
// Usage: node attack/solver_v2.mjs <baseUrl> [name] [msPerRound]
import { randomQuat, normalizeQuat, rasterize, projectPolys, iou, unpackMask, mulberry32, applyMove, mulQuat } from '../public/shared.js';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const NAME = process.argv[3] ?? 'AI code solver v2';
const BUDGET = Number(process.argv[4] ?? 900);
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const rand = mulberry32(Date.now() >>> 0);
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];

function solve(round) {
  const target = unpackMask(round.mask);
  const f = (q) => iou(rasterize(projectPolys(round.cells, q), round.radius), target);
  const end = Date.now() + BUDGET;
  let best = null, bestS = -1;
  while (Date.now() < end) {
    let q = randomQuat(rand), s = f(q), step = 0.5;
    while (step > 0.004 && Date.now() < end) {
      const c = normalizeQuat(q.map((v) => v + (rand() * 2 - 1) * step));
      const cs = f(c);
      if (cs > s) { q = c; s = cs; } else step *= 0.97;
    }
    if (s > bestS) { best = q; bestS = s; }
    if (bestS > 0.97) break;
  }
  return { q: best, est: bestS };
}

// Fake a drag: many small world-axis turns along the shortest rotation, ~60 fps, ~1.2 s.
function forgeMoves(start, goal) {
  const moves = []; let q = start, t = 40;
  for (let pass = 0; pass < 4; pass++) {
    let d = mulQuat(goal, conj(q)); if (d[3] < 0) d = d.map((v) => -v);
    const s = Math.hypot(d[0], d[1], d[2]); if (s < 1e-6) break;
    const theta = 2 * Math.atan2(s, d[3]), axis = [d[0] / s, d[1] / s, d[2] / s];
    const steps = pass === 0 ? 70 : 6;
    for (let i = 0; i < steps; i++) {
      for (let a = 0; a < 3; a++) {
        const ang = Math.round((axis[a] * theta / steps) * 1e4) / 1e4;
        if (ang) { moves.push(a, ang, t); q = applyMove(q, a, ang); }
      }
      t += 16 + Math.floor(rand() * 4);
    }
  }
  return moves;
}

const t0 = Date.now();
const data = await post('/api/start', { name: NAME });
let round = data.round, total = 0, log = [];
while (Date.now() - t0 < 90_000) {
  const started = Date.now();
  const { q, est } = solve(round);
  const moves = forgeMoves(round.start, q);
  const wait = 2050 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await post('/api/submit', { sessionId: data.sessionId, round: round.index, moves });
  if (res.done || !res.round) break;
  total = res.score;
  log.push({ est: +est.toFixed(3), match: res.match, points: res.points, note: res.note });
  console.error(`round ${round.index} est=${est.toFixed(3)} match=${res.match} note=${res.note} +${res.points} total=${res.score}`);
  round = res.round;
}
const fin = await post('/api/submit', { sessionId: data.sessionId, finish: true });
console.log(JSON.stringify({ final: fin.score, rounds: log.length }));
