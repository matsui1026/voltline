// Track definitions + geometry sampling. World is flat: x/z plane, y up.
// Heading h: forward = (sin h, cos h). Positive lateral offset = left of travel direction.

export const TRACKS = [
  {
    name: 'NEON HARBOR', laps: 3, scale: 1.4, half: 10, wall: 15,
    colA: '#22e6ff', colB: '#ff2bd6', fog: 0x140a2c, skyTop: 0x04030f, skyHorizon: 0x5a1a7a,
    pts: [[0, 0], [120, 0], [220, -30], [280, -110], [250, -200], [160, -230], [90, -180], [20, -200],
      [-60, -260], [-160, -240], [-200, -150], [-150, -70], [-190, 10], [-140, 60], [-60, 30]],
  },
  {
    name: 'ORBITAL SPIRE', laps: 3, scale: 1.3, half: 9.5, wall: 14,
    colA: '#7cff4f', colB: '#ffc531', fog: 0x061a22, skyTop: 0x01060c, skyHorizon: 0x0e5a6a,
    pts: [[0, 0], [150, 0], [230, 40], [240, 130], [170, 170], [90, 130], [30, 170], [40, 260],
      [-50, 300], [-140, 250], [-120, 150], [-200, 90], [-210, -10], [-120, -50]],
  },
];

function cr(a, b, c, d, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function buildTrack(def) {
  const P = def.pts.map(p => [p[0] * def.scale, p[1] * def.scale]);
  const m = P.length;
  const dense = [];
  for (let i = 0; i < m; i++) {
    const a = P[(i - 1 + m) % m], b = P[i], c = P[(i + 1) % m], d = P[(i + 2) % m];
    for (let j = 0; j < 32; j++) {
      const t = j / 32;
      dense.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t)]);
    }
  }
  const dn = dense.length;
  const cum = [0];
  for (let i = 0; i < dn; i++) {
    const p = dense[i], q = dense[(i + 1) % dn];
    cum.push(cum[i] + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const len = cum[dn];
  const n = Math.round(len / 2);
  const step = len / n;
  const px = new Float32Array(n), pz = new Float32Array(n);
  const tx = new Float32Array(n), tz = new Float32Array(n);
  const nx = new Float32Array(n), nz = new Float32Array(n);
  const heading = new Float32Array(n), curv = new Float32Array(n);
  let di = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (di < dn - 1 && cum[di + 1] < s) di++;
    const p = dense[di], q = dense[(di + 1) % dn];
    const f = (s - cum[di]) / Math.max(1e-6, cum[di + 1] - cum[di]);
    px[i] = p[0] + (q[0] - p[0]) * f;
    pz[i] = p[1] + (q[1] - p[1]) * f;
  }
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let dx = px[b] - px[a], dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    tx[i] = dx; tz[i] = dz;
    nx[i] = dz; nz[i] = -dx;
    heading[i] = Math.atan2(dx, dz);
  }
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n, b = (i + 2) % n;
    curv[i] = wrapAngle(heading[b] - heading[a]) / (4 * step);
  }

  const track = { def, n, step, len, px, pz, tx, tz, nx, nz, heading, curv, half: def.half, wall: def.wall };

  // Nearest centreline sample. hint<0 => full search. Result written to out {i, lat, s}.
  track.locate = (x, z, hint, out) => {
    let best = 0, bd = 1e18;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const dx = x - px[i], dz = z - pz[i], d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let k = -16; k <= 40; k++) {
        const i = (hint + k + n) % n;
        const dx = x - px[i], dz = z - pz[i], d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    const dx = x - px[best], dz = z - pz[best];
    out.i = best;
    out.lat = dx * nx[best] + dz * nz[best];
    out.s = best * step + dx * tx[best] + dz * tz[best];
    return out;
  };

  // World position for distance s along the track and lateral offset.
  track.posAt = (s, lat) => {
    s = ((s % len) + len) % len;
    const i = Math.floor(s / step) % n, f = s - i * step;
    return {
      i, h: heading[i],
      x: px[i] + tx[i] * f + nx[i] * lat,
      z: pz[i] + tz[i] * f + nz[i] * lat,
    };
  };

  track.grid = k => track.posAt(-(9 + 7 * Math.floor(k / 2)) - (k % 2) * 3.5, (k % 2) ? -4.5 : 4.5);

  track.boxes = [];
  for (const f of [0.1, 0.34, 0.6, 0.84]) {
    for (const lat of [-6, -2, 2, 6]) {
      const p = track.posAt(f * len, lat * def.half / 10);
      track.boxes.push({ x: p.x, z: p.z });
    }
  }
  track.pads = [];
  [0.22, 0.47, 0.72, 0.93].forEach((f, k) => {
    const p = track.posAt(f * len, (k % 2 ? -1 : 1) * def.half * 0.45);
    track.pads.push({ x: p.x, z: p.z, h: p.h });
  });
  return track;
}
