// Geometry shared by the browser and the Worker.
// Quaternions are [x, y, z, w]. The "light" shines along -Z, so a shadow is
// the orthographic projection of the rotated shape onto the XY plane.

export const MASK_SIZE = 128; // target silhouette resolution (pixels per side)

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform random rotation (Shoemake).
export function randomQuat(rand) {
  const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

export function normalizeQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 0 ? q.map((v) => v / n) : [0, 0, 0, 1];
}

// Quaternion product a*b (apply b first, then a).
export function mulQuat(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// One player input: turn the sculpture by `angle` radians about world axis 0/1/2 (X/Y/Z).
// The browser and the server both use this, so replaying a move log gives the same pose.
export function applyMove(q, axis, angle) {
  const s = Math.sin(angle / 2), d = [0, 0, 0, Math.cos(angle / 2)];
  d[axis] = s;
  return normalizeQuat(mulQuat(d, q));
}

export function rotate(q, v) {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

// Random connected polycube of n unit cubes, centred on its centroid.
// Rejects flat / straight shapes so silhouettes stay interesting.
export function makeShape(rand, n) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const cells = [[0, 0, 0]];
    const key = (c) => c.join(',');
    const seen = new Set([key(cells[0])]);
    while (cells.length < n) {
      const base = cells[Math.floor(rand() * cells.length)];
      const d = DIRS[Math.floor(rand() * 6)];
      const c = [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
      if (!seen.has(key(c))) { seen.add(key(c)); cells.push(c); }
    }
    const spans = [0, 1, 2].map((k) => {
      const vals = cells.map((c) => c[k]);
      return Math.max(...vals) - Math.min(...vals);
    });
    const dims = spans.filter((s) => s > 0).length;
    if (dims < 2 || (n >= 5 && dims < 3)) continue;
    const cx = [0, 1, 2].map((k) => cells.reduce((s, c) => s + c[k], 0) / n);
    return cells.map((c) => [c[0] - cx[0], c[1] - cx[1], c[2] - cx[2]]);
  }
  throw new Error('could not build shape');
}

// Radius of the shape's bounding sphere (rotation invariant) + margin.
export function shapeRadius(cells) {
  let r = 0;
  for (const c of cells)
    for (const s of corners(c)) r = Math.max(r, Math.hypot(s[0], s[1], s[2]));
  return r + 0.25;
}

function corners(c) {
  const out = [];
  for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) for (const dz of [-0.5, 0.5])
    out.push([c[0] + dx, c[1] + dy, c[2] + dz]);
  return out;
}

// Convex hull, counter-clockwise (monotone chain).
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Shadow = union of each cube's projected convex hull.
export function projectPolys(cells, q) {
  return cells.map((c) => hull(corners(c).map((p) => rotate(q, p)).map((p) => [p[0], p[1]])));
}

// Rasterize polygons into an N×N mask covering [-R, R]². Row 0 is the top (y = +R).
export function rasterize(polys, R, N = MASK_SIZE) {
  const mask = new Uint8Array(N * N);
  const step = (2 * R) / N;
  for (const poly of polys) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const i0 = Math.max(0, Math.floor((minX + R) / step));
    const i1 = Math.min(N - 1, Math.ceil((maxX + R) / step));
    const j0 = Math.max(0, Math.floor((R - maxY) / step));
    const j1 = Math.min(N - 1, Math.ceil((R - minY) / step));
    for (let j = j0; j <= j1; j++) {
      const py = R - (j + 0.5) * step;
      for (let i = i0; i <= i1; i++) {
        const idx = j * N + i;
        if (mask[idx]) continue;
        const px = -R + (i + 0.5) * step;
        let inside = true;
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length];
          if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) { inside = false; break; }
        }
        if (inside) mask[idx] = 1;
      }
    }
  }
  return mask;
}

export function iou(maskA, maskB) {
  let inter = 0, uni = 0;
  for (let i = 0; i < maskA.length; i++) {
    const a = maskA[i], b = maskB[i];
    inter += a & b; uni += a | b;
  }
  return uni ? inter / uni : 0;
}

// Bit-pack a mask into base64 so it can travel as JSON.
export function packMask(mask) {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) if (mask[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unpackMask(b64, N = MASK_SIZE) {
  const s = atob(b64);
  const mask = new Uint8Array(N * N);
  for (let i = 0; i < mask.length; i++) mask[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return mask;
}
