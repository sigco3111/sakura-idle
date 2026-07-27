/**
 * Seeded RNG — scaffold-owned, do not edit.
 * All layout/placement randomness must come from here so screenshots are
 * byte-reproducible between harness runs (the critics diff frames).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper with the helpers you actually reach for. */
export function makeRng(seed = 1337) {
  const r = mulberry32(seed);
  return {
    next: r,
    range: (a, b) => a + r() * (b - a),
    int: (a, b) => Math.floor(a + r() * (b - a + 1)),
    /** Gaussian-ish via sum of 3 uniforms — good for natural scatter. */
    gauss: (mu = 0, sigma = 1) => mu + ((r() + r() + r()) / 3 - 0.5) * 3.464 * sigma,
    sign: () => (r() < 0.5 ? -1 : 1),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    /** Uniform point in a disc of radius R, optionally with an inner hole. */
    disc: (R, inner = 0) => {
      const t = r() * Math.PI * 2;
      const rad = Math.sqrt(inner * inner + r() * (R * R - inner * inner));
      return [Math.cos(t) * rad, Math.sin(t) * rad];
    },
    /** Uniform direction on the unit sphere. */
    sphere: () => {
      const u = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      return [s * Math.cos(t), u, s * Math.sin(t)];
    },
  };
}

/**
 * Poisson-disc-ish scatter in a disc (Bridson-lite via dart throwing on a grid).
 * Returns [[x,z], ...]. Use for grass clumps, rocks, flowers — regular grids and
 * pure uniform random both read as fake; this reads natural.
 */
export function scatterDisc({ radius, minDist, count, seed = 7, inner = 0 }) {
  const rng = makeRng(seed);
  const cell = minDist / Math.SQRT2;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const pts = [];
  const maxTries = count * 30;
  for (let i = 0; i < maxTries && pts.length < count; i++) {
    const [x, z] = rng.disc(radius, inner);
    let ok = true;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
    for (let dx = -2; dx <= 2 && ok; dx++)
      for (let dz = -2; dz <= 2 && ok; dz++) {
        const b = grid.get(`${gx + dx},${gz + dz}`);
        if (!b) continue;
        for (const [px, pz] of b) {
          if ((px - x) ** 2 + (pz - z) ** 2 < minDist * minDist) { ok = false; break; }
        }
      }
    if (!ok) continue;
    const k = key(x, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, z]);
    pts.push([x, z]);
  }
  return pts;
}
