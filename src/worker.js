// Shadow Sculptor backend (Cloudflare Worker + D1).
// The target rotation never leaves the server: the browser only receives the
// cube layout and a low-resolution bitmap of the target shadow. All scoring
// happens here, so editing variables in the browser cannot change the score.
import {
  mulberry32, randomQuat, makeShape, shapeRadius,
  projectPolys, rasterize, iou, packMask, applyMove,
} from '../public/shared.js';

const GAME_MS = 90_000;     // length of one game
const GRACE_MS = 1_500;     // network slack for the final submit
const MIN_ROUND_MS = 2_000; // faster than this is not a human
const JUDGE_RES = 256;      // server judges at 2x the resolution it shows the browser
// Input-trace limits. A human drag or key hold stays well inside these.
const MAX_MOVES = 20_000;   // [axis, angle, t] triples per round
const MAX_STEP = 0.8;       // radians in one frame
const SPEED_WINDOW_MS = 250;
const MAX_WINDOW_TURN = 4;  // radians per 250 ms (16 rad/s)
const MIN_DISTINCT_T = 5;   // input spread over at least this many frames
const MIN_ACTIVE_MS = 300;
const CUBES = [4, 5, 5, 6, 6, 7, 7, 8];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function newRound(index) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const rand = mulberry32(seed);
  const cells = makeShape(rand, CUBES[Math.min(index, CUBES.length - 1)]);
  const target = randomQuat(rand);
  const start = randomQuat(rand); // server picks the starting pose, so it can replay inputs
  return { cells, target, start };
}

function publicRound(index, cells, target, start) {
  const R = shapeRadius(cells);
  return { index, cells, radius: R, start, mask: packMask(rasterize(projectPolys(cells, target), R)) };
}

// Replays the browser's input log from the server-issued start pose.
// Returns the final rotation, or a reason the log does not look like a person playing.
function replay(start, moves, roundMs) {
  if (!Array.isArray(moves) || moves.length % 3 || moves.length > MAX_MOVES * 3) return { bad: 'bad input log' };
  let q = start, lastT = 0, windowStart = 0, windowTurn = 0;
  const times = new Set();
  const n = moves.length / 3;
  for (let i = 0; i < n; i++) {
    const axis = moves[3 * i], angle = moves[3 * i + 1], t = moves[3 * i + 2];
    if (![0, 1, 2].includes(axis) || !Number.isFinite(angle) || !Number.isFinite(t)) return { bad: 'bad input log' };
    if (Math.abs(angle) > MAX_STEP || t < lastT) return { bad: 'inhuman input' };
    windowTurn += Math.abs(angle);
    while (t - moves[3 * windowStart + 2] > SPEED_WINDOW_MS) windowTurn -= Math.abs(moves[3 * windowStart++ + 1]);
    if (windowTurn > MAX_WINDOW_TURN) return { bad: 'inhuman input' };
    times.add(t); lastT = t;
    q = applyMove(q, axis, angle);
  }
  if (lastT > roundMs + 300) return { bad: 'inhuman input' };
  const active = n ? lastT - moves[2] : 0;
  if (times.size < MIN_DISTINCT_T || active < MIN_ACTIVE_MS) return { bad: 'no input' };
  return { q };
}

function scoreFor(match, roundMs) {
  // A random rotation matches ~55-70%, so only above 80% counts.
  if (match < 0.8) return 0;
  const base = Math.round(1000 * ((match - 0.8) / 0.2) ** 1.5);
  const speed = Math.round(base * 0.5 * Math.max(0, 1 - roundMs / 25_000));
  return base + speed;
}

function cleanName(name) {
  return String(name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'anonymous';
}

async function finish(env, s) {
  const res = await env.DB.prepare('UPDATE sessions SET done = 1 WHERE id = ? AND done = 0')
    .bind(s.id).run();
  if (res.meta.changes)
    await env.DB.prepare('INSERT INTO scores (name, score, rounds, created_at) VALUES (?, ?, ?, ?)')
      .bind(s.name, s.score, s.round, Date.now()).run();
}

async function leaderboard(env) {
  const { results } = await env.DB.prepare(
    'SELECT name, score, rounds FROM scores ORDER BY score DESC, created_at ASC LIMIT 10').all();
  return results;
}

async function start(req, env) {
  const body = await req.json().catch(() => ({}));
  const id = crypto.randomUUID();
  const now = Date.now();
  const { cells, target, start: q0 } = newRound(0);
  await env.DB.prepare(
    `INSERT INTO sessions (id, name, started_at, round, round_started_at, score, cells, target, start, done)
     VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?, 0)`)
    .bind(id, cleanName(body.name), now, now, JSON.stringify(cells), JSON.stringify(target), JSON.stringify(q0)).run();
  return json({ sessionId: id, durationMs: GAME_MS, round: publicRound(0, cells, target, q0) });
}

async function submit(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== 'string') return json({ error: 'bad request' }, 400);
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(body.sessionId).first();
  if (!s) return json({ error: 'unknown session' }, 404);
  if (s.done) return json({ done: true, score: s.score, leaderboard: await leaderboard(env) });

  const now = Date.now();
  const elapsed = now - s.started_at;
  if (elapsed > GAME_MS + GRACE_MS || body.finish) {
    await finish(env, s);
    return json({ done: true, score: s.score, leaderboard: await leaderboard(env) });
  }
  if (body.round !== s.round) return json({ error: 'stale round' }, 409);

  const roundMs = now - s.round_started_at;
  const cells = JSON.parse(s.cells);
  const target = JSON.parse(s.target);
  let match = 0, points = 0, note = null;

  if (!body.skip) {
    // The browser never sends a final rotation: only the inputs, which the server replays.
    const result = replay(JSON.parse(s.start), body.moves, roundMs);
    if (roundMs < MIN_ROUND_MS) {
      note = 'too fast';
    } else if (result.bad) {
      note = result.bad;
    } else {
      const R = shapeRadius(cells);
      match = iou(rasterize(projectPolys(cells, result.q), R, JUDGE_RES),
                  rasterize(projectPolys(cells, target), R, JUDGE_RES));
      points = scoreFor(match, roundMs);
    }
  }

  const nextIndex = s.round + 1;
  const next = newRound(nextIndex);
  // Compare-and-set on `round` so a round can only be submitted once.
  const res = await env.DB.prepare(
    `UPDATE sessions SET round = ?, round_started_at = ?, score = score + ?, cells = ?, target = ?, start = ?
     WHERE id = ? AND round = ? AND done = 0`)
    .bind(nextIndex, now, points, JSON.stringify(next.cells), JSON.stringify(next.target),
          JSON.stringify(next.start), s.id, s.round)
    .run();
  if (!res.meta.changes) return json({ error: 'stale round' }, 409);

  return json({
    done: false,
    match: Math.round(match * 1000) / 1000,
    points, note,
    score: s.score + points,
    timeLeftMs: Math.max(0, GAME_MS - elapsed),
    round: publicRound(nextIndex, next.cells, next.target, next.start),
  });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/api/start' && req.method === 'POST') return await start(req, env);
      if (pathname === '/api/submit' && req.method === 'POST') return await submit(req, env);
      if (pathname === '/api/leaderboard') return json(await leaderboard(env));
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
    return json({ error: 'not found' }, 404);
  },
};
