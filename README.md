# Shadow Sculptor

A browser game built with Three.js. Rotate a sculpture of 3D cubes until the shadow it casts on the wall matches the target shadow. You have 90 seconds.

**Play:** https://shadow-sculptor.shadow-sculptor.workers.dev

## How to play
- **Goal:** Make your shadow (gold) cover as much of the dark target shadow as possible without spilling outside it (red).
- **Controls:** Drag with the mouse, or use `W A S D` / arrow keys, to tilt the sculpture. `Q E` or the scroll wheel spins it within the wall plane. Hold `Shift` for fine control. `Space` locks in an answer; `X` skips.
- **Scoring:** A match (IoU) below 80% scores 0. Matches from 80% to 100% map to 0–1000 points, plus a speed bonus of up to 50% (the faster you answer within 25 seconds, the bigger the bonus). Each sculpture can be submitted only once, and sculptures grow from 4 to 8 cubes.

## Files
| File | Purpose |
|---|---|
| `public/index.html`, `style.css` | Page layout and instructions |
| `public/game.js` | Three.js rendering, input, wall shadow compositing, HUD, input recording |
| `public/shared.js` | Geometry shared by browser and server: random polycubes, projection, rasterizing, IoU, move replay |
| `src/worker.js` | Cloudflare Worker: issues rounds, replays inputs, checks for human-like input, scores, leaderboard |
| `schema.sql` | D1 database tables |
| `attack/solver.mjs`, `attack/solver_v2.mjs` | AI attack scripts used to test the game |
| `report/` | Course report (PDF) and the script that builds it |

## Run locally
```bash
npm install
npm run db:local
npm run dev
```
Then open http://localhost:8787

## Deploy to Cloudflare (free tier)
```bash
npx wrangler login
npx wrangler d1 create shadow-sculptor-db
```
Put the printed `database_id` into `wrangler.jsonc`, then:
```bash
npm run db:remote
npm run deploy
```
You get a URL like `https://shadow-sculptor.<your-subdomain>.workers.dev`.

## Why it is hard for AI
1. **The answer never reaches the browser.** The target rotation is stored only in the server's D1 database. The browser gets the cube layout and a 128×128 bitmap of the target shadow. Reading the source or editing JavaScript variables does not reveal the answer.
2. **The server keeps score.** Scores are computed by the Worker. The score on screen is only drawn on a canvas, so editing it changes nothing on the leaderboard.
3. **One try per round.** A compare-and-set update ensures each round is submitted once, so the server cannot be used as a scoring oracle.
4. **No numeric feedback while playing.** Players see only color overlap, never a live percentage, so a screenshot agent must judge visually.
5. **Random guessing does not pay.** Random rotations match with a median of about 57% (99th percentile about 86%), so the threshold is 80% and guessing scores almost nothing.
6. **Time pressure.** The game lasts 90 seconds, and a round answered in under 2 seconds scores 0 ("too fast"). A screenshot-think-act loop loses a lot of time.
7. **3D mental rotation.** Humans do it intuitively; vision models are weak at inferring a 3D pose from a 2D screenshot.
8. **Input replay (added after testing).** The server picks each round's starting pose. The browser submits only its logged drag and key inputs, and the server replays them to get the final pose. Logs that are too short or turn faster than a human hand are rejected. Answers are judged against a hidden target at twice the resolution shown to the browser.

## AI challenge results (live site, one 90-second game each)
| Agent | Score |
|---|---|
| Screenshot agent (plays from screenshots only) | 8 |
| Code agent v1: submits answers straight to the API (before hardening) | 105,345 |
| Same script (after hardening) | 0 |
| Code agent v2: forges a human-looking drag log (`attack/solver_v2.mjs`) | 55,886 |

**Conclusion:** Hardening stops the simple script, but an agent that reads the front-end code can still forge inputs. Any puzzle a person can solve from what is on screen, an algorithm can solve too. The realistic goal is to make attacks take real effort.

## Known attack surface
- The trace-forging approach above: solve the pose offline from the cube layout and bitmap, then generate a plausible input log.
- `finish` can end a game early. This only lowers the player's own score, so it is harmless.
