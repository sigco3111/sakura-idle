/**
 * Sakura — tree asset library.  Owner: 30-tree.js (tree agent).
 *
 * Everything the hero tree needs that is not scene graph:
 *
 *   buildBarkTextures()    procedural bark albedo(+cavity in A) and tangent-space
 *                          normal(+moss mask in A). Built from src/lib/noise.js
 *                          (ridged for the crack network, worley for lichen).
 *   buildBlossomAtlas()    4x4 atlas of hand-drawn-by-code sakura blossom
 *                          CLUSTERS: five notched petals, stamens, buds, sepals.
 *   TRUNK_VERT/FRAG        bark surface: wind sway by distance-from-trunk,
 *                          nprShade + applyAerial, moss on the north face,
 *                          gold veining at bloom stage 5.
 *   CANOPY_VERT/FRAG       instanced blossom cards: per-instance tint / tile /
 *                          growth order, translucency, interior AO.
 *   DEPTH_*                matching customDepthMaterial shaders so the shadow
 *                          map sees the SAME wind displacement and the SAME
 *                          alpha cut-out as the beauty pass.
 *
 * All lighting goes through GLSL_NPR (src/lib/lighting.js) and all motion
 * through GLSL_WIND (src/lib/wind.js). No second wind field, no PBR.
 */
import * as THREE from 'three';
import { GLSL_NOISE, ridged3, fbm3, worley2, noise3 } from './noise.js';
import { GLSL_WIND } from './wind.js';
import { GLSL_NPR } from './lighting.js';
import { makeRng } from './rng.js';

/* ===================================================================== *
 * 1. Bark — albedo + cavity + normal + moss mask
 * ===================================================================== */

/* ART_BIBLE §3: bark #6A5344 ridge -> #3F3029 crack, lichen #9AA88C. */
/* Measured on the hero frame, r3: the old palette bottomed out at rgb(14,19,55)
 * on the shaded trunk — i.e. the bark had gone so dark that all that survived
 * was the grade's own #2A2438 shadow lift, which reads as a NAVY trunk
 * (ART_BIBLE §8 tell 4). These values sit on the bible's #6A5344 -> #3F3029
 * instead of the old, much darker and much more orange set. */
const BARK_RIDGE = [0x8C, 0x73, 0x60];
const BARK_CRACK = [0x3F, 0x30, 0x29];
const BARK_WARM = [0x7C, 0x63, 0x50];
const BARK_GREY = [0x67, 0x53, 0x45];
const LICHEN = [0x8E, 0x9B, 0x80];
const LICHEN_DK = [0x62, 0x6E, 0x58];

const mixc = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Bark height field. Seamless around the trunk by construction (the noise is
 * sampled on a CYLINDER, so u wraps exactly) and seamless along the trunk via a
 * two-sample cross-fade whose contrast loss is compensated analytically.
 *
 * @returns {number} roughly 0..1, 1 = top of a ridge, 0 = bottom of a crack
 */
function barkH(u, v, ph) {
  const a = u * Math.PI * 2;
  const R = 2.35;
  const cx = Math.cos(a) * R + ph, cz = Math.sin(a) * R;
  const V = 7.0;                                   // noise units per tile in v
  const f = (yy) => {
    // vertical ridge network: y strongly compressed so cracks run UP the trunk
    let h = ridged3(cx * 1.30, yy * 0.22, cz * 1.30, 3);
    h = Math.pow(Math.min(1, Math.max(0, h)), 1.45);
    // plate break-up, and a coarse swelling so the ridges are not all one width
    h += fbm3(cx * 3.10, yy * 0.85, cz * 3.10, 2) * 0.15;
    h += fbm3(cx * 0.60, yy * 0.24, cz * 0.60, 2) * 0.15;
    return h;
  };
  const y = v * V;
  const w1 = v;
  const w0 = 1 - v;
  const h = f(y) * w0 + f(y - V) * w1;
  // the cross-fade halves the variance at v=0.5; put it back
  const g = 1 / Math.sqrt(w0 * w0 + w1 * w1);
  return 0.5 + (h - 0.5) * g;
}

function barkLichen(u, v, ph) {
  const a = u * Math.PI * 2;
  const R = 2.35;
  const cx = Math.cos(a) * R + ph, cz = Math.sin(a) * R;
  const V = 7.0;
  const f = (yy) => {
    const w = worley2(cx * 0.72, yy * 0.30 + 31.7, 1);
    const m = fbm3(cx * 1.15, yy * 0.42, cz * 1.15 + 11.0, 2);
    return (1 - w) * 1.15 + m * 0.55;
  };
  const y = v * V;
  return f(y) * (1 - v) + f(y - V) * v;
}

function barkMoss(u, v, ph) {
  const a = u * Math.PI * 2;
  const R = 2.35;
  const cx = Math.cos(a) * R + ph, cz = Math.sin(a) * R;
  const V = 7.0;
  const f = (yy) => fbm3(cx * 0.55, yy * 0.26 + 77.3, cz * 0.55, 3) * 1.35 + 0.5;
  const y = v * V;
  return f(y) * (1 - v) + f(y - V) * v;
}

/**
 * @param {object} o { size, seed }
 * @returns {{albedo: THREE.DataTexture, normal: THREE.DataTexture, dispose(): void}}
 */
export function buildBarkTextures({ size = 768, seed = 20477 } = {}) {
  const N = Math.max(128, size | 0);
  const rng = makeRng(seed);
  const ph = rng.range(0, 40);

  const H = new Float32Array(N * N);
  const alb = new Uint8Array(N * N * 4);

  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const k = j * N + i;
      let h = barkH(u, v, ph);
      h = Math.min(1, Math.max(0, h * 1.18 - 0.09));
      H[k] = h;

      // ---- albedo -------------------------------------------------
      // base bark: crack -> ridge, with a broad warm/grey drift so the trunk is
      // not one flat brown (ART_BIBLE §5 "colour variation along the trunk")
      const drift = fbm3(u * 3.1 + ph, v * 1.05, 5.5, 2) * 0.5 + 0.5;
      const base = mixc(BARK_GREY, BARK_WARM, Math.min(1, Math.max(0, drift * 1.25 - 0.12)));
      let c = mixc(BARK_CRACK, base, Math.pow(h, 0.72));
      c = mixc(c, BARK_RIDGE, Math.pow(h, 3.0) * 0.55);

      // ---- lichen: pale sage plaques, only on the ridges ----------
      const lic = barkLichen(u, v, ph);
      let lw = Math.min(1, Math.max(0, (lic - 0.86) * 4.6)) * Math.pow(h, 1.3);
      lw *= 0.62;
      if (lw > 0.001) {
        const grain = fbm3(u * 26.0, v * 9.0, 3.3, 2) * 0.5 + 0.5;
        c = mixc(c, mixc(LICHEN_DK, LICHEN, grain), Math.min(0.60, lw));
      }
      // fine speckle so no texel pair is identical (kills flat blocks)
      const sp = 1 + (noise3(u * 190.0, v * 62.0, 9.1)) * 0.075;

      alb[k * 4 + 0] = Math.min(255, Math.max(0, c[0] * sp));
      alb[k * 4 + 1] = Math.min(255, Math.max(0, c[1] * sp));
      alb[k * 4 + 2] = Math.min(255, Math.max(0, c[2] * sp));
      // cavity / AO in alpha: 1 on a ridge, dark in the crack floor
      alb[k * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, 0.14 + 0.86 * Math.pow(h, 0.85))));
    }
  }

  // ---- tangent-space normal from the height field (wrapping sobel) ----
  const nrm = new Uint8Array(N * N * 4);
  const at = (x, y) => H[((y + N) % N) * N + ((x + N) % N)];
  const STRENGTH = 1.55 * (N / 768);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const dx = (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1))
               - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
      const dy = (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1))
               - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
      let nx = -dx * STRENGTH, ny = -dy * STRENGTH, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      nrm[k * 4 + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      nrm[k * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nrm[k * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      const m = barkMoss(i / N, j / N, ph);
      nrm[k * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (m - 0.34) * 1.9)));
    }
  }

  const albedo = new THREE.DataTexture(alb, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  albedo.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.DataTexture(nrm, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  normal.colorSpace = THREE.NoColorSpace;
  for (const t of [albedo, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  return { albedo, normal, dispose() { albedo.dispose(); normal.dispose(); } };
}

/* ===================================================================== *
 * 2. Blossom cluster atlas
 * ===================================================================== */

/* the five sakura values from ART_BIBLE §3 */
const P_EDGE = '#FFF2F6';
const P_LIGHT = '#FFD9E6';
const P_MID = '#FFB6CE';
const P_SHADOW = '#EE8CAF';
const P_DEEP = '#C25F86';

/** One five-petal blossom, drawn in the current transform, radius R. */
function drawBlossom(g, R, rng, tone, openness = 1) {
  const petals = 5;
  const base = rng.range(-0.4, 0.4);
  // ---- petals ------------------------------------------------------
  for (let i = 0; i < petals; i++) {
    const a = base + (i / petals) * Math.PI * 2 + rng.range(-0.12, 0.12);
    const L = R * rng.range(0.88, 1.06) * openness;
    const w = L * rng.range(0.60, 0.74);
    g.save();
    g.rotate(a);
    // notched-tip petal: two outward lobes with a cleft between them
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(-w * 0.52, L * 0.24, -w * 0.66, L * 0.66, -w * 0.40, L * 0.93);
    g.quadraticCurveTo(-w * 0.24, L * 1.03, -w * 0.13, L * 0.86);   // outer lobe tip
    g.quadraticCurveTo(0, L * 0.74, w * 0.13, L * 0.86);            // the notch
    g.quadraticCurveTo(w * 0.24, L * 1.03, w * 0.40, L * 0.93);
    g.bezierCurveTo(w * 0.66, L * 0.66, w * 0.52, L * 0.24, 0, 0);
    g.closePath();

    const grd = g.createRadialGradient(0, 0, L * 0.04, 0, 0, L * 1.02);
    grd.addColorStop(0.00, tone < 0.5 ? P_DEEP : '#B8557A');
    grd.addColorStop(0.30, tone < 0.5 ? P_SHADOW : P_DEEP);
    grd.addColorStop(0.72, tone < 0.5 ? P_MID : P_SHADOW);
    grd.addColorStop(1.00, tone < 0.5 ? P_LIGHT : P_MID);
    g.fillStyle = grd;
    // soft rim so the alpha ramp has a couple of texels to anti-alias against
    g.shadowColor = 'rgba(238,140,175,0.78)';
    g.shadowBlur = Math.max(1.2, R * 0.045);
    g.fill();
    g.shadowBlur = 0;

    // veins
    g.strokeStyle = 'rgba(226,124,160,0.30)';
    g.lineWidth = Math.max(0.6, L * 0.016);
    for (let k = -1; k <= 1; k++) {
      g.beginPath();
      g.moveTo(0, L * 0.06);
      g.quadraticCurveTo(k * w * 0.16, L * 0.5, k * w * 0.27, L * 0.84);
      g.stroke();
    }
    // bright outer edge
    g.strokeStyle = 'rgba(255,235,244,0.34)';
    g.lineWidth = Math.max(0.7, L * 0.022);
    g.beginPath();
    g.moveTo(-w * 0.40, L * 0.93);
    g.quadraticCurveTo(-w * 0.24, L * 1.02, -w * 0.13, L * 0.86);
    g.quadraticCurveTo(0, L * 0.74, w * 0.13, L * 0.86);
    g.quadraticCurveTo(w * 0.24, L * 1.02, w * 0.40, L * 0.93);
    g.stroke();
    g.restore();
  }

  // ---- stamens -----------------------------------------------------
  const ns = Math.round(rng.range(13, 20));
  for (let i = 0; i < ns; i++) {
    const a = rng.range(0, Math.PI * 2);
    const l = R * rng.range(0.22, 0.46) * openness;
    const bend = rng.range(-0.22, 0.22);
    g.strokeStyle = 'rgba(255,236,222,0.92)';
    g.lineWidth = Math.max(0.55, R * 0.020);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(Math.cos(a + bend) * l * 0.6, Math.sin(a + bend) * l * 0.6,
      Math.cos(a) * l, Math.sin(a) * l);
    g.stroke();
    // anther
    g.fillStyle = i % 3 === 0 ? '#E8C56A' : '#FFF3C8';
    g.beginPath();
    g.arc(Math.cos(a) * l, Math.sin(a) * l, Math.max(0.6, R * 0.026), 0, Math.PI * 2);
    g.fill();
  }
  // pistil / throat
  g.fillStyle = P_DEEP;
  g.beginPath(); g.arc(0, 0, R * 0.11, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#A8496E';
  g.beginPath(); g.arc(0, 0, R * 0.055, 0, Math.PI * 2); g.fill();
}

/** An unopened bud: teardrop + sepals. */
function drawBud(g, R, rng) {
  const L = R * rng.range(0.9, 1.15);
  const w = L * 0.62;
  g.save();
  g.rotate(rng.range(0, Math.PI * 2));
  // sepal cup
  g.fillStyle = '#6E5A3C';
  g.beginPath();
  g.moveTo(-w * 0.42, 0);
  g.quadraticCurveTo(0, -L * 0.34, w * 0.42, 0);
  g.quadraticCurveTo(0, L * 0.22, -w * 0.42, 0);
  g.fill();
  // bud body
  const grd = g.createLinearGradient(0, L * 0.9, 0, -L * 0.1);
  grd.addColorStop(0, P_LIGHT);
  grd.addColorStop(0.55, P_SHADOW);
  grd.addColorStop(1, P_DEEP);
  g.fillStyle = grd;
  g.shadowColor = 'rgba(238,140,175,0.7)';
  g.shadowBlur = Math.max(1.0, R * 0.05);
  g.beginPath();
  g.moveTo(0, L * 0.98);
  g.bezierCurveTo(w * 0.66, L * 0.72, w * 0.52, L * 0.06, 0, 0);
  g.bezierCurveTo(-w * 0.52, L * 0.06, -w * 0.66, L * 0.72, 0, L * 0.98);
  g.fill();
  g.shadowBlur = 0;
  // seam
  g.strokeStyle = 'rgba(194,95,134,0.55)';
  g.lineWidth = Math.max(0.6, R * 0.03);
  g.beginPath(); g.moveTo(0, L * 0.92); g.lineTo(0, L * 0.1); g.stroke();
  g.restore();
}

/** A small young sakura leaf (they come out bronze-green). */
function drawLeaf(g, R, rng) {
  const L = R * rng.range(1.0, 1.5);
  const w = L * 0.40;
  g.save();
  g.rotate(rng.range(0, Math.PI * 2));
  const grd = g.createLinearGradient(0, 0, 0, L);
  grd.addColorStop(0, '#6C7C43');
  grd.addColorStop(0.6, '#8AA055');
  grd.addColorStop(1, '#A8B067');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(w, L * 0.28, w * 0.7, L * 0.86, 0, L);
  g.bezierCurveTo(-w * 0.7, L * 0.86, -w, L * 0.28, 0, 0);
  g.fill();
  g.strokeStyle = 'rgba(70,84,44,0.5)';
  g.lineWidth = Math.max(0.5, L * 0.02);
  g.beginPath(); g.moveTo(0, L * 0.03); g.lineTo(0, L * 0.95); g.stroke();
  g.restore();
}

const TILE_KINDS = [
  // 0..9 blossom clusters, 10..12 bud clusters, 13..15 sparse/leafy
  { blossoms: [4, 5], buds: [1, 2], leaves: [0, 0], tone: 0.15, spread: 0.62 },
  { blossoms: [4, 5], buds: [0, 2], leaves: [0, 0], tone: 0.35, spread: 0.70 },
  { blossoms: [3, 4], buds: [1, 3], leaves: [0, 0], tone: 0.10, spread: 0.58 },
  { blossoms: [5, 5], buds: [0, 1], leaves: [0, 0], tone: 0.55, spread: 0.74 },
  { blossoms: [3, 5], buds: [1, 2], leaves: [0, 0], tone: 0.25, spread: 0.66 },
  { blossoms: [4, 4], buds: [2, 3], leaves: [1, 1], tone: 0.45, spread: 0.60 },
  { blossoms: [5, 6], buds: [0, 1], leaves: [0, 0], tone: 0.05, spread: 0.78 },
  { blossoms: [3, 4], buds: [1, 2], leaves: [0, 0], tone: 0.60, spread: 0.64 },
  { blossoms: [4, 5], buds: [1, 1], leaves: [0, 0], tone: 0.20, spread: 0.68 },
  { blossoms: [2, 3], buds: [2, 4], leaves: [0, 0], tone: 0.30, spread: 0.55 },
  { blossoms: [0, 0], buds: [4, 6], leaves: [1, 2], tone: 0.9, spread: 0.52 },
  { blossoms: [0, 1], buds: [3, 5], leaves: [0, 2], tone: 0.9, spread: 0.46 },
  { blossoms: [0, 0], buds: [3, 5], leaves: [1, 1], tone: 0.9, spread: 0.58 },
  { blossoms: [3, 4], buds: [1, 2], leaves: [0, 1], tone: 0.4, spread: 0.74 },
  { blossoms: [3, 3], buds: [2, 3], leaves: [0, 1], tone: 0.5, spread: 0.70 },
  { blossoms: [3, 4], buds: [1, 3], leaves: [0, 1], tone: 0.2, spread: 0.64 },
];

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const ATLAS_BUD_FIRST = 10;
export const ATLAS_BUD_COUNT = 3;
export const ATLAS_BLOSSOM_COUNT = 10;
export const ATLAS_SPARSE_FIRST = 13;
export const ATLAS_SPARSE_COUNT = 3;

/**
 * Alpha-weighted colour dilation ("alpha bleed").
 *
 * THE reason the crown was peppered with hard black specks. A canvas cleared to
 * transparent stores rgb = 0 in every uncovered texel, and WebGL builds mipmaps
 * by averaging the UN-premultiplied texels — so at the hero distance (mip 2-3,
 * a 4-8 texel box) every blossom-edge texel is averaged with pure black and its
 * rgb is dragged toward zero while its alpha can still clear the alpha test. The
 * result is an opaque black fragment shaped like the blossom's own silhouette.
 *
 * Fix: flood the cluster's own colour outward into the transparent texels,
 * leaving alpha untouched. BFS from the covered texels so the total work is one
 * pass over the image rather than `rings` passes.
 *
 * (src/lib/terrain-shaders.js solves the same problem for its single-shape
 * sprites by painting edge-to-edge; a 16-cluster atlas cannot, so it dilates.)
 */
function bleedAlpha(g, S, rings = 20) {
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  const N = S * S;
  const known = new Uint8Array(N);
  let frontier = [];
  for (let i = 0; i < N; i++) {
    if (d[i * 4 + 3] > 0) { known[i] = 1; frontier.push(i); }
  }
  for (let ring = 0; ring < rings && frontier.length; ring++) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      const x = i % S, y = (i - x) / S;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= S || (dx === 0 && dy === 0)) continue;
          const j = yy * S + xx;
          if (known[j]) continue;
          // average every already-known neighbour of j, weighted by nothing —
          // these are hue samples, not coverage samples.
          let r = 0, gg = 0, b = 0, n = 0;
          for (let ey = -1; ey <= 1; ey++) {
            const vy = yy + ey;
            if (vy < 0 || vy >= S) continue;
            for (let ex = -1; ex <= 1; ex++) {
              const vx = xx + ex;
              if (vx < 0 || vx >= S) continue;
              const m = vy * S + vx;
              if (!known[m]) continue;
              r += d[m * 4]; gg += d[m * 4 + 1]; b += d[m * 4 + 2]; n++;
            }
          }
          if (!n) continue;
          d[j * 4] = r / n; d[j * 4 + 1] = gg / n; d[j * 4 + 2] = b / n;
          known[j] = 1;
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  g.putImageData(img, 0, 0);
}

/**
 * 4x4 atlas of blossom clusters. Each tile keeps a transparent margin so mip
 * levels never bleed one cluster into its neighbour.
 * @returns {THREE.CanvasTexture}
 */
export function buildBlossomAtlas({ size = 2048, seed = 90211 } = {}) {
  const S = Math.max(512, size | 0);
  const T = S / ATLAS_COLS;                 // tile edge
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.lineJoin = 'round';
  g.lineCap = 'round';

  for (let t = 0; t < TILE_KINDS.length; t++) {
    const kind = TILE_KINDS[t];
    const rng = makeRng(seed + t * 7717);
    const ox = (t % ATLAS_COLS) * T;
    const oy = Math.floor(t / ATLAS_COLS) * T;
    const cx = ox + T * 0.5, cy = oy + T * 0.5;
    const usable = T * 0.5 * 0.88;          // 12% transparent margin
    const R = usable * (0.40 - kind.spread * 0.06) + usable * 0.20;

    // --- twiglet the cluster hangs from --------------------------------
    const nb = rng.int(kind.blossoms[0], kind.blossoms[1]);
    const nd = rng.int(kind.buds[0], kind.buds[1]);
    const nl = rng.int(kind.leaves[0], kind.leaves[1]);
    const nodes = [];
    const total = nb + nd + nl;
    for (let i = 0; i < total; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = usable * kind.spread * Math.sqrt(rng.range(0.03, 1.0));
      nodes.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.86]);
    }
    const hub = [cx + rng.range(-T * 0.05, T * 0.05), cy + usable * 0.42];
    g.strokeStyle = 'rgba(134,102,80,0.55)';
    for (const n of nodes) {
      g.lineWidth = Math.max(0.8, T * rng.range(0.0035, 0.0065));
      g.beginPath();
      g.moveTo(hub[0], hub[1]);
      g.quadraticCurveTo((hub[0] + n[0]) * 0.5 + rng.range(-T * 0.04, T * 0.04),
        (hub[1] + n[1]) * 0.5 + rng.range(-T * 0.04, T * 0.04), n[0], n[1]);
      g.stroke();
    }

    // --- leaves behind, then buds, then blossoms on top ---------------
    let idx = 0;
    for (let i = 0; i < nl; i++, idx++) {
      g.save(); g.translate(nodes[idx][0], nodes[idx][1]);
      drawLeaf(g, R * rng.range(0.26, 0.42), rng); g.restore();
    }
    for (let i = 0; i < nd; i++, idx++) {
      g.save(); g.translate(nodes[idx][0], nodes[idx][1]);
      drawBud(g, R * rng.range(0.26, 0.40), rng); g.restore();
    }
    for (let i = 0; i < nb; i++, idx++) {
      g.save(); g.translate(nodes[idx][0], nodes[idx][1]);
      const sc = rng.range(0.62, 1.0);
      drawBlossom(g, R * sc, rng, kind.tone, rng.range(0.86, 1.0));
      g.restore();
    }
  }

  // must run BEFORE the texture is uploaded: mipmaps are generated from these
  // texels and the uncovered ones would otherwise be black (see bleedAlpha).
  bleedAlpha(g, S, Math.max(8, Math.round(S / 96)));

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* ===================================================================== *
 * 3. Shared GLSL — wind displacement used by beauty AND depth passes
 * ===================================================================== */

const WIND_BLOCK = /* glsl */`
uniform float uWindAmp;
/**
 * Hierarchical sway. st is 0 at the root flare and 1 at the outermost twig
 * tip, so stiffness = 1 - st^p makes the trunk almost rigid and the twig tips
 * free. The LAG is produced by sampling the ONE global wind field at a position
 * shifted along the wind direction — the gust wave travels along that axis, so a
 * shift is exactly a time delay and every branch inherits its parent's phase.
 */
vec3 treeSway(vec3 wp, float st, float phase){
  float stiff = 1.0 - pow(clamp(st, 0.0, 1.0), 1.30);
  vec3 lagP = wp + vec3(uWindDir.x, 0.0, uWindDir.y) * (phase * 3.4);
  return windOffset(lagP, stiff) * uWindAmp;
}
`;

/* ===================================================================== *
 * 4. Trunk / branch shader
 * ===================================================================== */

export const TRUNK_VERT = /* glsl */`
attribute vec3 aTangent;
attribute float aStiff;
attribute float aPhase;
attribute float aCav;
attribute float aRad;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec2 vUv;
varying float vCav;
varying float vStiff;
varying float vRad;

#include <common>
#include <shadowmap_pars_vertex>
${GLSL_NOISE}
${GLSL_WIND}
${WIND_BLOCK}

void main(){
  vUv = uv;
  vCav = aCav;
  vStiff = aStiff;
  vRad = aRad;

  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.xyz += treeSway(wp.xyz, aStiff, aPhase);

  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vWorldTangent = normalize(mat3(modelMatrix) * aTangent);
  vec3 shadowWorldNormal = vWorldNormal;

  #if defined( USE_SHADOWMAP )
    #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( wp + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
    #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * ( wp + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
  #endif
  #if NUM_SPOT_LIGHT_COORDS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vSpotLightCoord[ i ] = spotLightMatrix[ i ] * wp;
  }
  #pragma unroll_loop_end
  #endif

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const TRUNK_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec2 vUv;
varying float vCav;
varying float vStiff;
varying float vRad;

uniform sampler2D uBark;
uniform sampler2D uBarkN;
uniform vec3  uMossCol;
uniform vec3  uGoldCol;
uniform vec3  uWetCol;
uniform vec3  uTwigCol;
uniform float uMossAmt;
uniform float uGold;
uniform float uBare;
uniform float uDetailScale;
uniform float uPxScale;
uniform vec3  uMossDir;

#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
// ART_BIBLE §3: a shadowed trunk is a COOL BROWN, not a violet slab. Rotate the
// hue only part of the way onto uShadowTint (the library default 0.84 is tuned
// for grass, which really does go all the way to #6E76A8).
#define NPR_SHADOW_HUE 0.16
#define NPR_SHADOW_CHROMA 0.34
// The library's phase-independent SKY rim is tuned for silhouettes against the
// sky. Bark is never a silhouette and a 0.46 sky term was painting the whole
// trunk lavender: measured hue 6 deg where the albedo is authored at 27 deg.
#define NPR_RIM_SKY 0.14
${GLSL_NOISE}
${GLSL_NPR}

void main(){
  vec4 ba = texture2D(uBark, vUv);
  vec4 bn = texture2D(uBarkN, vUv);

  vec3 albedo = ba.rgb;
  float cav = ba.a;
  float mossMask = bn.a;

  // ---- how thin is this piece of wood? -------------------------------
  // vRad is the true wood radius in metres, and it is the only honest way to
  // tell trunk from twig on one merged mesh. Two overlapping ramps, because the
  // near-black slivers peppering the crown came from BOTH the 2 cm twigs and
  // the 8-15 cm secondaries behind the blossom:
  //   twig  r < 2 cm   light wraps right through it, no crack network, 1-2 px
  //   limb  r < 30 cm  a branch in a canopy: lichened, sky-lit, never a black bar
  // The trunk itself (r 0.5-1.34) gets neither and keeps its full bark look.
  float twig = smoothstep(0.075, 0.020, vRad);
  float limb = smoothstep(0.34, 0.075, vRad);

  vec3 N0 = normalize(vWorldNormal);
  if (!gl_FrontFacing) N0 = -N0;   // DoubleSide: the far wall of a 1-px tube
  vec3 T  = normalize(vWorldTangent - N0 * dot(N0, vWorldTangent));
  vec3 B  = cross(N0, T);

  // ---- mid-frequency tangent-space normal map -----------------------
  vec3 tn = bn.rgb * 2.0 - 1.0;
  // Softened for the same reason as the derivative bump below: the baked bark
  // normal is authored at STRENGTH 1.55, which tilts fragments up to ~83 deg and
  // sprays them across the ramp's terminator. Full strength = orange/navy comb.
  tn.xy *= 0.42;
  vec3 N = normalize(T * tn.x + B * tn.y + N0 * max(tn.z, 0.40));

  // ---- crisp high-frequency crack network, world space so it never seams
  //      and stays sharp at any zoom (the 'bark' preset lives here) -----
  // furrow WIDTH varies over the trunk — broad plates in places, fine cracks in
  // others. A single frequency reads as a combed texture, not as bark.
  float scaleVar = 0.66 + 0.62 * (snoise(vWorldPos * 0.185) * 0.5 + 0.5);
  vec3 bp = vec3(vWorldPos.x, vWorldPos.y * 0.115, vWorldPos.z) * uDetailScale * scaleVar;
  float fine = ridged(bp, 3);
  float fine2 = ridged(bp * 3.1 + 19.0, 2);
  float h = fine * 0.80 + fine2 * 0.20;
  // horizontal breaks: the ridges are chopped into plates rather than running
  // unbroken from root to crown
  float plate = ridged(vec3(vWorldPos.x * 0.55, vWorldPos.y * 3.2, vWorldPos.z * 0.55) * 1.25, 2);
  h *= mix(0.58, 1.0, smoothstep(0.20, 0.62, plate));

  // derivative-based bump: no extra noise taps, correct in tangent space
  float bumpFade = 1.0 - 0.72 * smoothstep(7.0, 26.0, length(cameraPosition - vWorldPos));
  vec3 dpdx = dFdx(vWorldPos), dpdy = dFdy(vWorldPos);
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  if (abs(det) > 1e-12) {
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    // Kept deliberately LOW. A ramp-shaded NPR terminator is a 2-3 band step, so
    // a strong high-frequency bump at a grazing light angle flips neighbouring
    // micro-facets across that step and the trunk renders as an orange/navy comb
    // (measured on the 'bark' preset). Genshin-style bark carries its furrows in
    // ALBEDO and keeps normals soft; so do we.
    N = normalize(abs(det) * N - 0.11 * bumpFade * grad);
  }

  // ---- crack darkening + cavity AO ----------------------------------
  float crack = smoothstep(0.62, 0.16, h) * (1.0 - twig * 0.80);   // twigs are smooth
  // AO floor matters far more than it used to: the library now scales its whole
  // shadow fill by ao (NPR_SHADOW_AO = 0.16), so an ao of 0.18 in a crack put the
  // crack floor onto the grade's violet shadow pedestal and the trunk rendered as
  // a navy comb (measured rgb(12,18,55) on the hero trunk). A bark crack is a
  // 5 mm groove that still sees most of the sky — not an enclosed pocket.
  float ao = clamp(mix(0.76, 1.0, smoothstep(0.05, 0.70, cav)) * (1.0 - crack * 0.24), 0.56, 1.0);
  albedo *= mix(1.0, 0.56, crack * 0.85);   // furrows live HERE, not in the normal
  albedo *= mix(0.80, 1.06, smoothstep(0.02, 0.55, cav));

  // Twig wood: warm red-grey, well above trunk-bark value. Thin wood also has
  // nothing above it to occlude it, so its AO opens right up.
  float wood = clamp(twig * 0.62 + limb * 0.34, 0.0, 0.92);
  albedo = mix(albedo, uTwigCol * (0.82 + 0.36 * cav), wood);
  ao = mix(ao, clamp(ao * 1.30 + 0.24, 0.0, 1.0), max(twig, limb * 0.70));

  // root flare and the lower trunk sit in their own ambient shadow
  ao *= mix(0.88, 1.0, smoothstep(-0.4, 2.2, vWorldPos.y));

  // ---- moss on the shadow (north) face, collecting in the cracks -----
  float northness = dot(N0, normalize(uMossDir));
  float mw = smoothstep(0.02, 0.80, northness)
           * (1.0 - smoothstep(0.5, 5.6, vWorldPos.y))
           * mossMask * uMossAmt * mix(0.55, 1.0, crack + 0.35);
  mw = clamp(mw, 0.0, 0.82);
  albedo = mix(albedo, uMossCol * (0.70 + 0.60 * mossMask), mw);

  // damp weathering + a hint of sap sheen low on the trunk
  albedo = mix(albedo, uWetCol, (1.0 - smoothstep(-0.6, 1.5, vWorldPos.y)) * 0.20);

  // ---- winter (stage 0) reads colder and greyer; stage 5 is gold-veined
  albedo = mix(albedo, mix(albedo, vec3(0.055, 0.050, 0.058), 0.42), uBare);

  vec3 N4 = N;
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  float sm = getShadowMask();
  // A 2 cm twig is far below the shadow map's texel footprint, so whatever the
  // map says about it is noise. Lift it toward lit and let the ramp do the work.
  sm = mix(sm, max(sm, 0.58), twig * 0.85 + limb * 0.25);
  nprSetWorldPos(vWorldPos);
  vec3 Ng = nprGeoNormal(vWorldPos, N4);
  // Thin wood: light wraps through it (translucency) and its whole surface is
  // grazing, so it carries a stronger rim. Trunk values are unchanged.
  vec3 col = nprShadeN(albedo, N4, Ng, V, sm,
                       twig * 0.55, twig * 0.70,
                       0.28, 0.42 + twig * 0.46 + limb * 0.22, ao);

  // ---- meadow bounce -------------------------------------------------
  // This trunk stands in a sunlit green field. The library's hemisphere ambient
  // is generic; a specific warm-green fill on the lower and downward-facing
  // wood is what stops a backlit trunk resolving to the grade's flat violet
  // shadow pedestal, and it is the single reason a real backlit trunk still
  // reads BROWN. Strongest at the root flare, gone by the first limbs.
  {
    float dn = 1.0 - clamp(N4.y * 0.5 + 0.5, 0.0, 1.0);
    float near = 1.0 - smoothstep(0.2, 6.5, vWorldPos.y);
    col += albedo * uGroundColor * ((0.35 + 0.75 * dn) * near * 1.25) * ao;
    // ...plus a small warm fill so bark keeps its own hue wherever the key
    // cannot reach it. Without it the furrow floors resolve to the sky ambient
    // alone, which is blue, and the trunk reads navy.
    col += albedo * uSunColor * (0.085 * ao);
  }

  // gold veining: light living IN the cracks, so it survives shadow
  float veinRun = ridged(vec3(vWorldPos.x * 1.9, vWorldPos.y * 0.30, vWorldPos.z * 1.9), 2);
  float vein = crack * smoothstep(0.34, 0.78, veinRun);
  col += uGoldCol * vein * uGold * (0.55 + 0.50 * rimTerm(N4, V, 2.0));

  // ---- sub-pixel twig dissolve ---------------------------------------
  // An opaque 1-px-wide dark line cannot be antialiased away by anything
  // downstream, so it lands as a hard black dash — "dirt on the lens". In the
  // real world a feature that thin only covers a fraction of the pixel and the
  // sky/blossom behind it shows through. We cannot sample the background, but
  // aerial perspective IS the colour of "not enough of this object in the
  // pixel", so pushing a thin twig further into the haze reproduces exactly the
  // right value and hue with the scene's own coherent fog.
  float px = 2.0 * vRad * uPxScale / max(dist, 1e-3);
  float thin = (1.0 - smoothstep(1.2, 5.0, px)) * max(twig, limb * 0.75);
  col = applyAerial(col, dist * (1.0 + 1.7 * thin), vWorldPos.y, V);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const TRUNK_DEPTH_VERT = /* glsl */`
attribute float aStiff;
attribute float aPhase;
varying vec2 vHighPrecisionZW;
#include <common>
${GLSL_NOISE}
${GLSL_WIND}
${WIND_BLOCK}
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.xyz += treeSway(wp.xyz, aStiff, aPhase);
  gl_Position = projectionMatrix * viewMatrix * wp;
  vHighPrecisionZW = gl_Position.zw;
}
`;

export const DEPTH_FRAG = /* glsl */`
#include <common>
#include <packing>
varying vec2 vHighPrecisionZW;
void main(){
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA( fragCoordZ );
}
`;

/* ===================================================================== *
 * 5. Canopy — instanced blossom-cluster cards
 * ===================================================================== */

/* aInst  = (phase, stiffness 0..1, growth order 0..1, bud roll 0..1)
   aInst2 = (tile index, interior AO 0..1, size, tilt seed)          */
const CANOPY_COMMON = /* glsl */`
attribute vec4 aInst;
attribute vec4 aInst2;
attribute vec3 aTint;

uniform float uCoverage;      // 0..1 how much of the canopy has opened
uniform float uBudMix;        // 0..1 fraction of open sites that are still buds
uniform vec3  uCanopyCentre;
uniform float uCanopyR;       // crown radius, for the vertical AO gradient
uniform float uAtlasCols;
uniform float uFlutter;
uniform vec3  uEyePos;        // the BEAUTY camera, in both passes (see cardFrame)

/** growth: each card opens when the coverage front passes its order value */
float cardGrow(float order){
  return smoothstep(order - 0.20, order + 0.03, uCoverage);
}

/**
 * Card frame with a partial billboard.
 *
 * A blossom card seen within ~25 degrees of edge-on collapses to a sliver, and
 * because the alpha test has to be raised for those fragments the only texels
 * that survive are the DENSEST ones — which in a sakura cluster are the deep
 * #C25F86 petal cores. The result was several hundred hard near-black dashes
 * peppering the crown in every frame. Culling them instead would throw away a
 * third of the canopy, so the card rotates toward the viewer *only* in the
 * regime where it was about to vanish, and keeps its authored orientation
 * everywhere else. Below ~0.62 facing the blend ramps in; at 0.12 it is fully
 * camera-facing.
 *
 * Both the beauty pass and the shadow pass call this with the SAME uEyePos, so
 * the depth map describes exactly the geometry the beauty pass drew.
 */
void cardFrame(out vec3 centre, out vec3 nx, out vec3 ny, out vec3 nz){
  mat3 IM = mat3(modelMatrix) * mat3(instanceMatrix);
  vec3 ay = IM * vec3(0.0, 1.0, 0.0);
  vec3 az = IM * vec3(0.0, 0.0, 1.0);
  ay = normalize(ay);
  az = normalize(az);
  centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 toEye = uEyePos - centre;
  toEye = normalize(toEye + vec3(0.0, 1e-5, 0.0));
  float facing = dot(az, toEye);
  az *= facing < 0.0 ? -1.0 : 1.0;             // always show the card's front
  float bb = 1.0 - smoothstep(0.12, 0.62, abs(facing));
  nz = normalize(mix(az, toEye, bb));
  nx = cross(ay, nz);
  float l = length(nx);
  nx = l > 1e-4 ? nx / l : normalize(cross(vec3(0.0, 1.0, 0.0), nz + vec3(1e-3, 0.0, 0.0)));
  ny = normalize(cross(nz, nx));
}
`;

export const CANOPY_VERT = /* glsl */`
${CANOPY_COMMON}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vCardN;
varying float vAo;
varying float vBud;
varying float vGrow;
varying float vCrownT;   // 0 at the bottom of the crown, 1 at the top
varying float vShell;    // 0 = deep interior, 1 = outer shell (radial)

uniform float uNormalBlend;

#include <common>
#include <shadowmap_pars_vertex>
${GLSL_NOISE}
${GLSL_WIND}
${WIND_BLOCK}

void main(){
  float order = aInst.z;
  float grow = cardGrow(order);
  float isBud = step(aInst.w, uBudMix);
  vBud = isBud;
  vGrow = grow;

  // atlas tile: blossom variant, or one of the bud tiles while still closed
  float tile = mix(aInst2.x, ${ATLAS_BUD_FIRST}.0 + mod(aInst2.x, ${ATLAS_BUD_COUNT}.0), isBud);
  float tx = mod(tile, uAtlasCols);
  float ty = floor(tile / uAtlasCols);
  vUv = (vec2(tx, ty) + uv) / uAtlasCols;

  // buds are small and tight; open clusters are full size
  float sizeMul = aInst2.z * mix(1.0, 0.46, isBud) * grow;

  vec3 centre, nx, ny, nz;
  cardFrame(centre, nx, ny, nz);
  vec3 local = position * sizeMul;
  vec4 wp = vec4(centre + nx * local.x + ny * local.y + nz * local.z, 1.0);
  vec3 nrm = normalize(nx * normal.x + ny * normal.y + nz * normal.z);

  // ---- wind: cards ride their host twig, then flutter individually ----
  wp.xyz += treeSway(wp.xyz, aInst.y, aInst.x);
  float f = sin(uWindTime * 2.35 + aInst.x * 24.0) * 0.5
          + sin(uWindTime * 3.71 + aInst.x * 51.0) * 0.5;
  wp.xyz += nrm * f * uFlutter * (0.35 + 0.85 * uWindGust) * aInst2.z;

  vWorldPos = wp.xyz;

  // read as VOLUME, not as a shell: blend the card normal toward the canopy's
  // own outward normal so the whole crown shades like one soft mass
  vec3 rel = vWorldPos - uCanopyCentre;
  vec3 sph = normalize(rel + vec3(0.0, 0.0001, 0.0));
  vWorldNormal = normalize(mix(nrm, sph, uNormalBlend));
  vCardN = nrm;
  // Where in the crown VOLUME this card sits. The lit mass / shaded underside
  // read (ART_BIBLE §2) comes from these two, not from the card normal: a card
  // hanging under the crown is occluded by a metre of blossom above it whatever
  // way it happens to face.
  vCrownT = clamp((rel.y + uCanopyR) / (2.0 * uCanopyR), 0.0, 1.0);
  vShell  = clamp(length(rel) / max(uCanopyR, 0.001), 0.0, 1.0);
  vec3 shadowWorldNormal = vWorldNormal;
  vTint = aTint;
  vAo = aInst2.y;

  #if defined( USE_SHADOWMAP )
    #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( wp + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
    #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * ( wp + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
  #endif
  #if NUM_SPOT_LIGHT_COORDS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vSpotLightCoord[ i ] = spotLightMatrix[ i ] * wp;
  }
  #pragma unroll_loop_end
  #endif

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const CANOPY_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vCardN;
varying float vAo;
varying float vBud;
varying float vGrow;
varying float vCrownT;   // 0 at the bottom of the crown, 1 at the top
varying float vShell;    // 0 = deep interior, 1 = outer shell (radial)

uniform sampler2D uAtlas;
uniform float uInterior;   // master strength of the crown-volume shading
uniform vec3  uDeepTint;   // multiplier that carries albedo toward #C25F86
uniform float uTranslucency;
uniform float uThickness;
uniform float uAlphaTest;
uniform float uLumin;
uniform vec3  uLuminCol;
uniform float uGold;
uniform vec3  uGoldCol;
uniform float uThroughGlow;
uniform vec3  uGlowCol;

#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
// A sakura petal in shadow is #EE8CAF — still unmistakably pink. Barely rotate
// the hue; the level drop does the work.
#define NPR_SHADOW_HUE 0.26
#define NPR_SHADOW_CHROMA 0.62
// Petals DO want a rim, but the sky-coloured half of it was washing #FFB6CE to
// #FAD6D7 (measured sat 0.14 against a 0.29 target). The warm KEY rim inside
// nprKeyG is untouched, so backlit edges still glow.
#define NPR_RIM_SKY 0.24
${GLSL_NOISE}
${GLSL_NPR}

void main(){
  vec4 tx = texture2D(uAtlas, vUv);

  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  // With the partial billboard in CANOPY_VERT no card is ever within 25 deg of
  // edge-on, so this only has to cover the mild grazing case now. A hard boost
  // here is actively harmful: raising the threshold keeps only the DENSEST
  // texels, and in a sakura cluster those are the deep #C25F86 petal cores.
  float face = abs(dot(normalize(vCardN), V));
  if (tx.a < uAlphaTest * mix(1.22, 1.0, smoothstep(0.10, 0.50, face))) discard;

  vec3 albedo = tx.rgb * vTint;

  // ---- the crown as a VOLUME, not a shell ----------------------------
  // Two independent occluders, both read from where the card sits inside the
  // crown rather than from how it happens to face:
  //   occR  radial  — a card near the centre has a metre of blossom outside it
  //   occY  vertical— a card under the crown is lit only by ground bounce
  // Together they give the self-shadowed inner layers ART_BIBLE §2 asks for.
  float occR = 1.0 - smoothstep(0.28, 0.94, vShell);
  float occY = 1.0 - smoothstep(0.16, 0.78, vCrownT);
  float occ = clamp((occR * 0.70 + occY * 0.55) * uInterior, 0.0, 1.0);

  // interior of the crown is genuinely darker (ART_BIBLE §2 "AO-driven
  // darkening in canopy interiors"), but stays PINK, never grey — and never a
  // bruise-coloured slash showing through the front face of the crown
  albedo *= mix(0.62, 1.0, vAo);
  // deeper INTO the palette, not just darker: #FFB6CE -> #EE8CAF -> #C25F86
  albedo = mix(albedo, albedo * uDeepTint, occ * 0.86);

  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;

  float sm = getShadowMask();
  // deep interior cards should not be re-lit by a shadow map that cannot
  // resolve them; fold the interior AO into the occlusion too
  sm = min(sm, mix(0.50, 1.0, vAo));
  sm *= 1.0 - occ * 0.55;

  nprSetWorldPos(vWorldPos);
  // Light bleeds through the OUTER shell (that is the backlit glow); an
  // interior card has a metre of blossom in the way and must not glow at all,
  // or the whole crown flattens back into one pale mass.
  float transl = uTranslucency * mix(0.55, 1.0, vAo) * mix(0.55, 1.0, 1.0 - vBud)
               * (1.0 - occ * 0.80);
  // floored: below ~0.3 the library's ao-scaled fill vanishes and the card
  // lands on the grade's violet pedestal, which measured as a grey-mauve
  // crown (sat 0.19). A shaded blossom must stay unmistakably pink.
  float aoC = clamp(vAo * (1.0 - occ * 0.50), 0.30, 1.0);
  vec3 col = nprShadeN(albedo, N, N, V, sm, transl, uThickness,
                       0.18, mix(0.85, 1.25, vShell), aoC);

  // ---- light coming THROUGH the petal, explicitly warm pink. The library's
  // transmission keeps the key light's own (near-white) level; this adds the
  // #FFE7EE hue on top so a backlit crown glows instead of going pale lavender.
  {
    vec3 Ls = normalize(uSunDir);
    float bk = pow(clamp(dot(-Ls, V), 0.0, 1.0), 1.6);
    float wr = clamp(dot(N, -Ls) * 0.5 + 0.5, 0.0, 1.0);
    col += uGlowCol * uThroughGlow * (bk * 0.80 + wr * wr * 0.44)
         * tx.a * mix(0.42, 1.0, vAo) * (1.0 - uNightMix)
         * mix(0.22, 1.18, vShell);      // the SHELL glows; the interior does not
  }

  // stage 4 "Radiant": the petals themselves carry a little light
  col += uLuminCol * uLumin * (0.35 + 0.65 * vAo) * tx.a;
  // stage 5 "Everblossom": gold along the petal edges
  float edge = smoothstep(0.55, 0.95, 1.0 - clamp(dot(N, V), 0.0, 1.0));
  col += uGoldCol * uGold * (edge * 0.9 + 0.25) * tx.a;

  col = applyAerial(col, dist, vWorldPos.y, V);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CANOPY_DEPTH_VERT = /* glsl */`
${CANOPY_COMMON}
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
#include <common>
${GLSL_NOISE}
${GLSL_WIND}
${WIND_BLOCK}
void main(){
  float grow = cardGrow(aInst.z);
  float isBud = step(aInst.w, uBudMix);
  float tile = mix(aInst2.x, ${ATLAS_BUD_FIRST}.0 + mod(aInst2.x, ${ATLAS_BUD_COUNT}.0), isBud);
  float tx = mod(tile, uAtlasCols);
  float ty = floor(tile / uAtlasCols);
  vUv = (vec2(tx, ty) + uv) / uAtlasCols;

  float sizeMul = aInst2.z * mix(1.0, 0.46, isBud) * grow;
  vec3 centre, nx, ny, nz;
  cardFrame(centre, nx, ny, nz);
  vec3 lp = position * sizeMul;
  vec4 wp = vec4(centre + nx * lp.x + ny * lp.y + nz * lp.z, 1.0);
  vec3 nrm = normalize(nx * normal.x + ny * normal.y + nz * normal.z);
  wp.xyz += treeSway(wp.xyz, aInst.y, aInst.x);
  float f = sin(uWindTime * 2.35 + aInst.x * 24.0) * 0.5
          + sin(uWindTime * 3.71 + aInst.x * 51.0) * 0.5;
  wp.xyz += nrm * f * uFlutter * (0.35 + 0.85 * uWindGust) * aInst2.z;
  gl_Position = projectionMatrix * viewMatrix * wp;
  vHighPrecisionZW = gl_Position.zw;
}
`;

export const CANOPY_DEPTH_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D uAtlas;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec2 vHighPrecisionZW;
void main(){
  if (texture2D(uAtlas, vUv).a < uAlphaTest) discard;
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA( fragCoordZ );
}
`;
