import * as THREE from 'three';
import { projectPolys, unpackMask, MASK_SIZE, applyMove } from './shared.js';

// Everything lives inside this closure: nothing useful is exposed on `window`,
// and the score is drawn on canvas rather than written into the DOM.
(() => {
  const COLORS = { plaster: '#d9cfbf', shadow: '#2b2730', gold: '#f2b84b', red: 'rgba(224,96,90,0.75)', ink: '#f1ece4', muted: '#a39c92' };
  const CUBE_COLORS = [0xe9a46a, 0x7fb3a6, 0xc98bb0, 0x9fb46a, 0x8ea2d8, 0xe6cd73, 0xd27d6b, 0x9e8fd1];

  const $ = (id) => document.getElementById(id);
  const viewEl = $('view'), wall = $('wall'), hud = $('hud');
  const wctx = wall.getContext('2d'), hctx = hud.getContext('2d');

  // ---------- Three.js scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x2a2630);
  viewEl.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x302838, 1.2));
  const lamp = new THREE.DirectionalLight(0xffffff, 1.6);
  lamp.position.set(2, 3, 10);
  scene.add(lamp);

  const sculpture = new THREE.Group();
  scene.add(sculpture);
  const cubeGeo = new THREE.BoxGeometry(0.97, 0.97, 0.97);
  const edgeGeo = new THREE.EdgesGeometry(cubeGeo);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1820 });

  // ---------- game state ----------
  const state = {
    sessionId: null, round: null, cells: [], radius: 1,
    endAt: 0, score: 0, busy: false, playing: false,
    flash: null, // {text, sub, color, until}
  };
  // Pose = server start pose + every input since. The server replays `moves` to judge the answer.
  let playerQ = [0, 0, 0, 1];
  let moves = [];           // flat [axis, angle, t] triples
  let roundT0 = 0;
  const pend = [0, 0, 0];   // this frame's turning per world axis
  const targetLayer = document.createElement('canvas');
  const playerLayer = document.createElement('canvas');
  const tmpLayer = document.createElement('canvas');

  function loadRound(r) {
    state.round = r.index; state.cells = r.cells; state.radius = r.radius;
    sculpture.clear();
    r.cells.forEach((c, i) => {
      const mesh = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({
        color: CUBE_COLORS[i % CUBE_COLORS.length], roughness: 0.55, metalness: 0.05,
      }));
      mesh.position.set(...c);
      mesh.add(new THREE.LineSegments(edgeGeo, edgeMat));
      sculpture.add(mesh);
    });
    // Fit the bounding sphere in view.
    const fov = THREE.MathUtils.degToRad(camera.fov);
    camera.position.set(0, 0, (r.radius / Math.sin(fov / 2)) * 1.02);
    camera.lookAt(0, 0, 0);

    // Target shadow bitmap -> soft dark shape on its own layer.
    const mask = unpackMask(r.mask);
    const small = document.createElement('canvas');
    small.width = small.height = MASK_SIZE;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(MASK_SIZE, MASK_SIZE);
    for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] = mask[i] ? 255 : 0;
    sctx.putImageData(img, 0, 0);
    const tctx = targetLayer.getContext('2d');
    tctx.clearRect(0, 0, targetLayer.width, targetLayer.height);
    tctx.imageSmoothingEnabled = true;
    tctx.filter = `blur(${Math.max(1, targetLayer.width / 220)}px)`; // soft shadow edge, hides pixel steps
    tctx.drawImage(small, 0, 0, targetLayer.width, targetLayer.height);
    tctx.filter = 'none';
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = COLORS.shadow;
    tctx.fillRect(0, 0, targetLayer.width, targetLayer.height);
    tctx.globalCompositeOperation = 'source-over';
    targetLayer.dataset.round = r.index;
    targetLayer._mask = r.mask;

    playerQ = r.start; moves = []; pend.fill(0);
    roundT0 = performance.now();
    state.start = r.start;
  }

  // ---------- sizing ----------
  function resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const vw = viewEl.clientWidth;
    renderer.setSize(vw, vw, false);
    camera.aspect = 1; camera.updateProjectionMatrix();
    const ww = Math.round(wall.clientWidth * dpr);
    for (const c of [wall, targetLayer, playerLayer, tmpLayer]) { c.width = c.height = ww; }
    hud.width = Math.round(hud.clientWidth * dpr); hud.height = Math.round(hud.clientHeight * dpr);
    if (targetLayer._mask) loadTargetOnly();
  }
  function loadTargetOnly() {
    // Re-render the target layer at the new size without touching the round.
    const keep = [playerQ, moves, roundT0];
    loadRound({ index: state.round, cells: state.cells, radius: state.radius, mask: targetLayer._mask, start: state.start });
    [playerQ, moves, roundT0] = keep;
  }
  addEventListener('resize', resize);

  // ---------- input ----------
  const keys = new Set();
  addEventListener('keydown', (e) => {
    if (!state.playing) return;
    keys.add(e.code);
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); submit(false); }
    if (e.code === 'KeyX') submit(true);
    if (e.code.startsWith('Arrow')) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const X = 0, Y = 1, Z = 2;
  function turn(axis, angle) { pend[axis] += angle; }
  // Once per frame: turn pending input into logged moves (rounded so the log replays exactly).
  function flushMoves(now) {
    const t = Math.round(now - roundT0);
    for (let axis = 0; axis < 3; axis++) {
      let left = pend[axis];
      while (Math.abs(left) > 1e-4) {
        const a = Math.round(Math.max(-0.75, Math.min(0.75, left)) * 1e4) / 1e4;
        if (!a) break;
        moves.push(axis, a, t);
        playerQ = applyMove(playerQ, axis, a);
        left -= a;
      }
      pend[axis] = 0;
    }
  }

  let drag = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!drag || !state.playing) return;
    const k = e.shiftKey ? 0.003 : 0.009;
    turn(Y, (e.clientX - drag.x) * k);
    turn(X, (e.clientY - drag.y) * k);
    drag = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointerup', () => (drag = null));
  renderer.domElement.addEventListener('wheel', (e) => {
    if (!state.playing) return;
    e.preventDefault();
    turn(Z, -e.deltaY * 0.002);
  }, { passive: false });

  function applyKeys(dt) {
    const rate = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 0.5 : 1.8) * dt;
    const on = (...codes) => codes.some((c) => keys.has(c));
    if (on('KeyA', 'ArrowLeft')) turn(Y, -rate);
    if (on('KeyD', 'ArrowRight')) turn(Y, rate);
    if (on('KeyW', 'ArrowUp')) turn(X, -rate);
    if (on('KeyS', 'ArrowDown')) turn(X, rate);
    if (on('KeyQ')) turn(Z, rate);
    if (on('KeyE')) turn(Z, -rate);
  }

  // ---------- drawing ----------
  function drawWall(now) {
    const W = wall.width, R = state.radius;
    const toPx = (x, y) => [((x + R) / (2 * R)) * W, ((R - y) / (2 * R)) * W];

    const pctx = playerLayer.getContext('2d');
    pctx.clearRect(0, 0, W, W);
    if (state.cells.length) {
      const q = playerQ;
      pctx.beginPath();
      for (const poly of projectPolys(state.cells, q)) {
        poly.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? pctx.lineTo(px, py) : pctx.moveTo(px, py); });
        pctx.closePath();
      }
      pctx.fillStyle = '#fff';
      pctx.fill('nonzero');
    }

    // Plaster wall with a lamp vignette.
    const g = wctx.createRadialGradient(W * 0.5, W * 0.45, W * 0.05, W * 0.5, W * 0.5, W * 0.75);
    g.addColorStop(0, '#e8dfd0'); g.addColorStop(1, '#a89d8c');
    wctx.globalCompositeOperation = 'source-over';
    wctx.fillStyle = g; wctx.fillRect(0, 0, W, W);
    wctx.drawImage(targetLayer, 0, 0);

    const tctx = tmpLayer.getContext('2d');
    // Overlap -> gold.
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, W, W);
    tctx.drawImage(playerLayer, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(targetLayer, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = COLORS.gold; tctx.fillRect(0, 0, W, W);
    wctx.drawImage(tmpLayer, 0, 0);
    // Spill -> red.
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, W, W);
    tctx.drawImage(playerLayer, 0, 0);
    tctx.globalCompositeOperation = 'destination-out';
    tctx.drawImage(targetLayer, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = COLORS.red; tctx.fillRect(0, 0, W, W);
    wctx.drawImage(tmpLayer, 0, 0);

    // Result flash after each lock-in.
    const f = state.flash;
    if (f && now < f.until) {
      const a = Math.min(1, (f.until - now) / 400);
      wctx.globalAlpha = a;
      wctx.fillStyle = 'rgba(23,21,26,0.78)';
      wctx.fillRect(0, W * 0.38, W, W * 0.24);
      wctx.textAlign = 'center';
      wctx.fillStyle = f.color;
      wctx.font = `600 ${Math.round(W * 0.09)}px Fraunces, Georgia, serif`;
      wctx.fillText(f.text, W / 2, W * 0.5);
      wctx.fillStyle = COLORS.ink;
      wctx.font = `${Math.round(W * 0.04)}px Inter, sans-serif`;
      wctx.fillText(f.sub, W / 2, W * 0.575);
      wctx.globalAlpha = 1;
    }
  }

  function drawHud(now) {
    const W = hud.width, H = hud.height, s = H / 56;
    hctx.clearRect(0, 0, W, H);
    const left = state.playing ? Math.max(0, state.endAt - now) : 0;
    hctx.textBaseline = 'middle';
    hctx.textAlign = 'left';
    hctx.fillStyle = left < 10_000 && state.playing ? COLORS.red : COLORS.ink;
    hctx.font = `600 ${30 * s}px Fraunces, Georgia, serif`;
    hctx.fillText(`${(left / 1000).toFixed(1)}s`, 0, H / 2);
    hctx.textAlign = 'center';
    hctx.fillStyle = COLORS.muted;
    hctx.font = `${14 * s}px Inter, sans-serif`;
    hctx.fillText(state.round != null ? `Sculpture ${state.round + 1} · ${state.cells.length} cubes` : '', W / 2, H / 2);
    hctx.textAlign = 'right';
    hctx.fillStyle = COLORS.gold;
    hctx.font = `600 ${30 * s}px Fraunces, Georgia, serif`;
    hctx.fillText(state.score.toLocaleString(), W, H / 2);
    // Time bar
    hctx.fillStyle = '#2f2a34';
    hctx.fillRect(0, H - 4 * s, W, 3 * s);
    hctx.fillStyle = COLORS.gold;
    hctx.fillRect(0, H - 4 * s, W * (left / 90_000), 3 * s);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (state.playing) {
      applyKeys(dt);
      flushMoves(now);
      if (now >= state.endAt && !state.busy) finish();
    }
    sculpture.quaternion.set(playerQ[0], playerQ[1], playerQ[2], playerQ[3]);
    renderer.render(scene, camera);
    drawWall(now);
    drawHud(now);
    requestAnimationFrame(frame);
  }

  // ---------- server ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async function start(name) {
    $('startBtn').disabled = true;
    try {
      const data = await api('/api/start', { name });
      state.sessionId = data.sessionId;
      state.score = 0;
      state.flash = null;
      loadRound(data.round);
      state.endAt = performance.now() + data.durationMs;
      state.playing = true;
      $('overlay').classList.add('hidden');
      $('endOverlay').classList.add('hidden');
    } catch {
      alert('Could not reach the server. Try again.');
    } finally {
      $('startBtn').disabled = false;
    }
  }

  async function submit(skip) {
    if (!state.playing || state.busy) return;
    state.busy = true;
    const sentAt = performance.now();
    try {
      const data = await api('/api/submit', {
        sessionId: state.sessionId, round: state.round, skip,
        moves,
      });
      if (data.done) return endGame(data);
      if (data.error) return;
      state.score = data.score;
      state.endAt = sentAt + data.timeLeftMs;
      const pct = Math.round(data.match * 100);
      state.flash = skip
        ? { text: 'Skipped', sub: 'next sculpture', color: COLORS.muted, until: performance.now() + 900 }
        : data.note === 'too fast'
          ? { text: 'Too fast', sub: 'take at least two seconds', color: COLORS.red, until: performance.now() + 1300 }
          : data.note
          ? { text: 'Not counted', sub: data.note === 'no input' ? 'turn the sculpture first' : 'input looked automated', color: COLORS.red, until: performance.now() + 1500 }
          : { text: data.points ? `+${data.points}` : 'Miss', sub: `${pct}% match`, color: data.points ? COLORS.gold : COLORS.red, until: performance.now() + 1300 };
      loadRound(data.round);
    } finally {
      state.busy = false;
    }
  }

  async function finish() {
    state.busy = true;
    try {
      const data = await api('/api/submit', { sessionId: state.sessionId, finish: true });
      endGame(data);
    } finally {
      state.busy = false;
    }
  }

  function renderBoard(el, rows) {
    el.innerHTML = '';
    if (!rows?.length) { el.innerHTML = '<li style="list-style:none;margin-left:-22px">No scores yet. Be the first.</li>'; return; }
    for (const r of rows) {
      const li = document.createElement('li');
      li.textContent = `${r.name} (${r.rounds} sculptures)`;
      const span = document.createElement('span');
      span.textContent = r.score.toLocaleString();
      li.appendChild(span);
      el.appendChild(li);
    }
  }

  function endGame(data) {
    state.playing = false;
    keys.clear();
    state.score = data.score;
    const c = $('final'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.muted; ctx.font = '22px Inter, sans-serif';
    ctx.fillText('Final score', c.width / 2, 30);
    ctx.fillStyle = COLORS.gold; ctx.font = '600 72px Fraunces, Georgia, serif';
    ctx.fillText(data.score.toLocaleString(), c.width / 2, 95);
    renderBoard($('board2'), data.leaderboard);
    $('endOverlay').classList.remove('hidden');
  }

  $('startForm').addEventListener('submit', (e) => { e.preventDefault(); start($('name').value); });
  $('againBtn').addEventListener('click', () => start($('name').value));
  api('/api/leaderboard').then((rows) => renderBoard($('board'), rows)).catch(() => {});

  resize();
  requestAnimationFrame(frame);
})();
