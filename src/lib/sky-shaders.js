/**
 * sky-shaders.js — owned by the sky agent (15-sky.js).
 *
 * Contents
 *   • a deterministic *periodic* Perlin fbm (CPU) used to bake tiling cloud noise
 *     and to carve mountain ridge lines,
 *   • the sky-dome shader (gradient + Mie forward scatter + sun disc + 4 layers of
 *     lit, self-shadowed painted clouds + stars + milky way + moon),
 *   • the distant-hill shader (3 aerial-perspective bands, tree-line band),
 *   • the far valley-floor shader that guarantees no sky ever leaks below the horizon.
 *
 * Everything here is procedural: no textures are fetched, all noise is baked at boot.
 */

import { GLSL_NOISE } from './noise.js';

/* ══════════════════════════════════════════════════════════════════════════
 *  CPU side — periodic Perlin / fbm.  Perfectly tiling so the baked cloud
 *  texture can be sampled with RepeatWrapping and mip-mapped without seams,
 *  and so a ridge line that wraps 360° around the scene closes on itself.
 * ══════════════════════════════════════════════════════════════════════════ */

function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const FADE = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function pgrad(ix, iy, per, s, dx, dy) {
  const a = ihash(((ix % per) + per) % per, ((iy % per) + per) % per, s) * 6.283185307179586;
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

/** Perlin noise with lattice period `per` on both axes. Output ≈ [-1,1]. */
function pnoise2(x, y, per, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = FADE(fx), v = FADE(fy);
  const n00 = pgrad(ix, iy, per, s, fx, fy);
  const n10 = pgrad(ix + 1, iy, per, s, fx - 1, fy);
  const n01 = pgrad(ix, iy + 1, per, s, fx, fy - 1);
  const n11 = pgrad(ix + 1, iy + 1, per, s, fx - 1, fy - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.42;
}

export const RIDGE_FBM = 0;   // plain fbm, output ≈ [-1,1]
export const RIDGE_RIDGED = 1; // 1-|n| — rounded tops, sharp valleys (mountains, cumulus)
export const RIDGE_BILLOW = 2; // |n| — puffy blobs

/**
 * Periodic fbm over the unit square. `base` must be an integer; each octave
 * doubles it, so every octave keeps the [0,1)² tiling.
 */
export function pfbm2(u, v, base = 4, oct = 5, seed = 0, gain = 0.5, mode = RIDGE_FBM) {
  let sum = 0, amp = 0.5, norm = 0, f = base;
  for (let i = 0; i < oct; i++) {
    let n = pnoise2(u * f, v * f, f, seed + i * 71 + 3);
    if (mode === RIDGE_RIDGED) n = (1.0 - Math.abs(n)) * 2.0 - 1.0;
    else if (mode === RIDGE_BILLOW) n = Math.abs(n) * 2.0 - 1.0;
    sum += amp * n; norm += amp; amp *= gain; f *= 2;
  }
  return sum / norm;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Bake the two cloud-noise textures.
 *
 *  texA : R = fbm height,   GB = ∂H/∂u,∂H/∂v,   A = low-freq warp field
 *  texB : R = ridged height, GB = ∂H/∂u,∂H/∂v,  A = high-freq detail
 *
 *  Packing the analytic-ish gradient next to the height means the cloud
 *  shader gets a surface normal for free — one fetch instead of five — which
 *  is what makes 4 lit, self-shadowing layers affordable.
 * ══════════════════════════════════════════════════════════════════════════ */

function bakeField(N, base, oct, seed, gain, mode) {
  const a = new Float32Array(N * N);
  let mn = 1e9, mx = -1e9;
  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const val = pfbm2(i / N, v, base, oct, seed, gain, mode);
      a[j * N + i] = val;
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
  }
  const inv = 1 / Math.max(1e-6, mx - mn);
  for (let k = 0; k < a.length; k++) a[k] = (a[k] - mn) * inv;
  return a;
}

function gradientOf(field, N) {
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  const at = (i, j) => field[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  const k = N * 0.5;              // d/du  (u spans the whole texture = 1.0)
  let acc = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) * k;
      const dy = (at(i, j + 1) - at(i, j - 1)) * k;
      gx[j * N + i] = dx; gy[j * N + i] = dy;
      acc += Math.abs(dx) + Math.abs(dy);
    }
  }
  // scale so the *typical* slope lands mid-range; 3.2× mean abs keeps the tail
  const scale = Math.max(0.25, (acc / (N * N * 2)) * 3.2);
  return { gx, gy, scale };
}

/**
 * @returns {{ texA: import('three').DataTexture, texB: import('three').DataTexture,
 *             gradScale: [number, number] }}
 */
export function makeSkyNoiseTextures(THREE, N = 512) {
  /* Only 3 octaves, deliberately.  A 5-octave fbm puts ±3% detail at 1/64 uv,
     which lands right inside the alpha threshold window and shreds every cloud
     edge into fibres — the single worst artefact this shader can produce. */
  const hA = bakeField(N, 3, 3, 1201, 0.45, RIDGE_FBM);
  const hB = bakeField(N, 3, 3, 7717, 0.45, RIDGE_RIDGED);
  const warp = bakeField(N, 2, 2, 3313, 0.50, RIDGE_FBM);
  const det = bakeField(N, 8, 3, 5501, 0.50, RIDGE_RIDGED);
  const gA = gradientOf(hA, N);
  const gB = gradientOf(hB, N);

  const mk = (h, g, extra) => {
    const d = new Uint8Array(N * N * 4);
    const is = 1 / g.scale;
    for (let k = 0; k < N * N; k++) {
      d[k * 4 + 0] = Math.max(0, Math.min(255, Math.round(h[k] * 255)));
      d[k * 4 + 1] = Math.max(0, Math.min(255, Math.round((0.5 + g.gx[k] * is * 0.5) * 255)));
      d[k * 4 + 2] = Math.max(0, Math.min(255, Math.round((0.5 + g.gy[k] * is * 0.5) * 255)));
      d[k * 4 + 3] = Math.max(0, Math.min(255, Math.round(extra[k] * 255)));
    }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 8;   // the cloud plane is viewed at grazing angles: aniso or smear
    t.needsUpdate = true;
    return t;
  };

  return {
    texA: mk(hA, gA, warp),
    texB: mk(hB, gB, det),
    gradScale: [gA.scale, gB.scale],
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Shared sky radiance
 *
 *  ONE function evaluates the sky's colour along an arbitrary view ray, and
 *  everything that needs an aerial-perspective colour — the dome itself, the
 *  hill bands, the far valley floor — calls it. That is the whole point: a
 *  distant surface must be fogged toward *the sky it is silhouetted against*,
 *  sampled along its own ray, not toward one global scalar `uFogColor`. Fogging
 *  toward a scalar is what makes a far ridge come out warmer and more saturated
 *  than the sky behind it, which reads as physically backwards and flattens the
 *  depth completely (ART_BIBLE §8.3).
 *
 *  The uniform block is exported separately so every consumer declares exactly
 *  the same set once and shares the same uniform objects by reference.
 * ══════════════════════════════════════════════════════════════════════════ */

export const GLSL_SKY_UNIFORMS = /* glsl */`
uniform vec3  uZenith;      /* ART_BIBLE §3 sky-zenith row  (#4E86D4 at day) */
uniform vec3  uMid;
uniform vec3  uHorizon;     /* ART_BIBLE §3 sky-horizon row (#CFE0F2 at day) */
uniform vec3  uHaze;
uniform float uHazeAmt;
uniform float uHazeH;
uniform float uZenithPow;   /* exponent on elevation: <1 → the blue owns the top */
uniform float uMidAmt;      /* weight of the optional third stop */
uniform float uZenDeep;     /* value falloff toward the zenith (structure, §8.2) */
uniform vec3  uSunDir;
uniform vec3  uGlowTint;
uniform float uMieG;
uniform float uMieAmt;
`;

export const GLSL_SKY_RADIANCE = /* glsl */`
#ifndef SAKURA_SKY_RADIANCE
#define SAKURA_SKY_RADIANCE
#define SKY_SAT(x) clamp(x, 0.0, 1.0)

float skyLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * The vertical gradient, authored straight off the ART_BIBLE §3 rows.
 *
 * t = pow(elevation, uZenithPow) with uZenithPow < 1 deliberately: it makes the
 * saturated zenith blue own the top third of the frame and keeps the pale
 * horizon colour pinned to the last few degrees, instead of the whole sky
 * living inside a 10 % luminance range around the mid stop.
 */
vec3 skyGradient(vec3 rd) {
  float ey = max(rd.y, 0.0);
  float t  = pow(ey, uZenithPow);

  vec3 c = mix(uHorizon, uZenith, t);
  /* optional third stop — shapes the transition, never flattens it */
  c = mix(c, uMid, (1.0 - abs(t * 2.0 - 1.0)) * uMidAmt);
  /* Real skies lose VALUE toward the zenith as well as gaining chroma, and that
     value drop is what gives the largest region of the frame a structure at all
     (§8.2). Darkening a colour also shrinks its absolute chroma, so the zenith is
     re-saturated by exactly as much as it is deepened — the top third has to come
     out both darker and bluer, not merely darker. */
  /* A smoothstep, not t and not a power of t. The weight has to be steep in the
     middle of the range: at ~8° elevation (just above the far ridge line, where
     the pale #CFE0F2 row belongs) it must be ~0, and by ~20° (the top of the hero
     frame) it must be nearly full, or the deepening drags the whole gradient down
     together and the sky collapses back into one narrow value band. */
  float td = smoothstep(0.36, 0.82, t);
  c *= mix(1.0, uZenDeep, td);
  float lz = skyLuma(c);
  c = mix(vec3(lz), c, 1.0 + td * (1.0 - uZenDeep) * 1.75);

  /* Rayleigh flavour: long wavelengths survive the long path near the horizon */
  float am = 1.0 / (ey + 0.10);
  vec3 ext = exp(-vec3(0.030, 0.072, 0.170) * (am - 1.0));
  c *= mix(vec3(1.0), ext / max(max(ext.r, ext.g), ext.b), 0.26);

  /* warm haze band hugging the horizon, hottest toward the sun */
  float hb = exp(-max(rd.y, -0.06) / uHazeH);
  vec2 dxz = normalize(vec2(rd.x, rd.z) + 1e-5);
  vec2 sxz = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float azi = pow(max(dot(dxz, sxz), 0.0), 2.2);
  c = mix(c, uHaze, SKY_SAT(hb * uHazeAmt));
  c += uHaze * hb * azi * uHazeAmt * 0.55;
  return c;
}

/**
 * Gradient + Mie forward scatter. This is the value a distant surface's aerial
 * term must converge to, so the haze in front of a ridge warms up toward the
 * sun exactly as the sky beside the ridge does — one sun, one temperature.
 */
vec3 skyRadiance(vec3 rayDir) {
  vec3 rd = normalize(rayDir);
  vec3 c = skyGradient(rd);
  vec3 sunD = normalize(uSunDir);
  float sunUp  = smoothstep(-0.12, 0.04, sunD.y);
  float lowSun = pow(1.0 - SKY_SAT(sunD.y * 1.85), 2.4);
  float cosT = dot(rd, sunD);
  float am = 1.0 / (max(rd.y, 0.0) + 0.10);
  float g = uMieG;
  float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
  c += uGlowTint * hg * 0.055 * uMieAmt * (0.30 + 4.2 * lowSun)
       * (0.32 + 0.68 * min(am, 7.0) / 7.0) * sunUp;
  c += uGlowTint * pow(max(cosT, 0.0), 4.0) * 0.17 * (0.35 + 2.1 * lowSun) * sunUp;
  return c;
}

/**
 * The one aerial-perspective operator. Distance → haze fraction, desaturate the
 * albedo FIRST (air destroys chroma before it adds its own), then lift toward
 * the sky radiance along this surface's own view ray.
 *
 * Desaturating after the mix would grey out the sky's blue as well and give a
 * dead neutral mountain; doing it first is what makes distance read cool.
 */
vec3 applySkyAerial(vec3 col, vec3 rayDir, float f, float desat) {
  f = SKY_SAT(f);
  col = mix(col, vec3(skyLuma(col)), SKY_SAT(f * desat));
  return mix(col, skyRadiance(rayDir), f);
}
#endif
`;

/* ══════════════════════════════════════════════════════════════════════════
 *  Sky dome
 * ══════════════════════════════════════════════════════════════════════════ */

export const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SKY_FRAG = /* glsl */`
precision highp float;

${GLSL_NOISE}
${GLSL_SKY_UNIFORMS}
${GLSL_SKY_RADIANCE}

varying vec3 vDir;

uniform sampler2D uNoiseA;
uniform sampler2D uNoiseB;
uniform vec2  uGradScale;
uniform float uTime;

/* shared with 08-lighting when present, otherwise driven locally */
uniform vec3  uFogColor;
uniform vec3  uMoonDir;
uniform vec3  uShadowTint;

/* global wind field (src/lib/wind.js) */
uniform vec2  uWindDir;
uniform float uWindTime;
uniform float uWindGust;

uniform float uGroundFade;

/* sun */
uniform vec3  uSunTint;
uniform float uSunSize;
uniform float uSunI;

/* clouds — one component per layer, x = lowest/nearest … w = cirrus */
uniform vec4  uCovL;
uniform vec4  uScaleL;
uniform vec4  uSpeedL;
uniform vec4  uHeightL;
uniform vec4  uPuffL;
uniform vec4  uBumpL;
uniform vec4  uWarpL;
uniform vec4  uStretchL;
uniform vec4  uAmtL;
uniform vec4  uZenCovL;   /* coverage threshold ADDED at high elevation (less cloud) */
uniform vec4  uZenAmtL;   /* opacity multiplier at high elevation */
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;
uniform vec3  uCloudAmb;
uniform vec3  uCloudRim;
uniform float uCloudAmt;
uniform float uCloudRimAmt;

/* night */
uniform float uStars;
uniform float uMilky;
uniform vec3  uMoonCol;
uniform float uMoonSize;
uniform float uDither;

#define SAT(x) clamp(x, 0.0, 1.0)

/* normalize() of a zero vector is NaN, and ONE NaN pixel poisons the whole
   bloom mip chain downstream — the frame comes back a flat grey wash. Every
   direction that can legitimately arrive as zero goes through this. */
vec3 nrmSafe(vec3 v, vec3 fallback) {
  float l = length(v);
  return l > 1e-5 ? v / l : fallback;
}
/* a basis reference axis that is never parallel to the input */
vec3 refAxis(vec3 a) { return abs(a.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.02); }

/* ---------------------------------------------------------------- clouds -- */
/*
 * Each layer is the view ray intersected with a horizontal slab at height
 * hgt (sky units).  1/dir.y gives real perspective compression toward the
 * horizon for free, so a flat noise field reads as a receding cloud deck.
 * The baked gradient turns that field into a heightfield with a normal, so we
 * can ramp-shade it: sunlit tops, shadow-tinted undersides, silver rims.
 */
vec4 cloudLayer(vec3 d, float hgt, float scl, float spd, float cov,
                float stretch, float puff, float warpAmt, float bump,
                float amt, float zenCov, float zenAmt, vec3 sunD, vec3 skyC) {
  /* ── high-sky coverage budget ─────────────────────────────────────────
   * The upper sky is the largest single region of the frame and it must be
   * SKY, not a uniform grey-white cirrus smear (ART_BIBLE §8.2, §8.11 read
   * together: no dead regions, but also no cheap flat cover). Above ~25° the
   * coverage threshold is raised (so less of the field crosses it) and the
   * layer's opacity is scaled down, per layer — hardest on the cirrus. */
  float hi = smoothstep(0.24, 0.46, d.y);      /* 0 below 14°, 1 above 27° */
  cov += zenCov * hi;
  amt *= mix(1.0, zenAmt, hi);
  if (d.y < 0.002 || cov > 0.995 || amt < 0.002) return vec4(0.0);

  /* ── slab parameterisation ────────────────────────────────────────────
   * kMin is the grazing elevation (≈3.3°) below which we stop tracing. It
   * gives a FINITE maximum ray length  tMax = hgt / kMin, and softening
   * with sqrt() rather than max() means there is no visible ring where the
   * limit engages.
   *
   * kMin MUST be a constant, not a fraction of hgt. Make it proportional
   * to hgt (the old  c = hgt * 0.16 ) and t becomes almost constant across
   * the whole visible sky for the high layers: the mapping degenerates from
   * a perspective slab intersection into a plain projection of the view
   * direction, so the pattern stops varying down a screen column and the
   * deck renders as hard-edged, parallel-sided vertical bars with a flat
   * terminus. That artefact was the single worst thing in the day hero. */
  const float kMin = 0.058;
  float tMax = hgt / kMin;
  float t = hgt / sqrt(d.y * d.y + kMin * kMin);
  float tN = clamp(t / tMax, 0.0, 1.0);      /* 0 = zenith … 1 = grazing limit */
  /* The last ~18 % of slab traversal ramps to zero, so the deck can never
     terminate on an edge — it dissolves into the horizon haze instead. */
  float slabFade = smoothstep(1.0, 0.82, tN) * smoothstep(0.004, 0.030, d.y);
  if (slabFade <= 0.002) return vec4(0.0);

  vec2  P = d.xz * t;

  /* rotate into the wind frame: drift is then a pure scroll along +x */
  vec2 wd = uWindDir;
  vec2 perp = vec2(-wd.y, wd.x);
  vec2 W  = vec2(dot(P, wd), dot(P, perp));
  vec2 q  = W * scl * vec2(1.0 / stretch, stretch) - vec2(uWindTime * spd, uWindTime * spd * 0.09);

  /* domain warp — kills the "noise texture" look, gives billowing lobes */
  vec2 wv = vec2(texture2D(uNoiseA, q * 0.34 + 0.11).a,
                 texture2D(uNoiseB, q * 0.30 + 0.53).a) - 0.5;
  q += wv * warpAmt;

  vec4 A = texture2D(uNoiseA, q);
  vec4 B = texture2D(uNoiseB, q * 1.35 + vec2(4.7, 2.3));
  float H = mix(A.r, A.r * 0.42 + B.r * 0.58, puff) + (B.a - 0.5) * 0.030;

  /* Narrow thresholds: with only 3 octaves in the field the finest scale is
     ~6° of arc, so a tight ramp carves cauliflower lobes rather than fibres,
     and the cores reach full opacity instead of staying as translucent haze. */
  float aSoft = smoothstep(cov - 0.055, cov + 0.055, H);
  float aCore = smoothstep(cov - 0.006, cov + 0.020, H);
  float alpha = mix(aSoft, aCore, 0.50);
  if (alpha <= 0.004) return vec4(0.0);

  /* heightfield normal — dominated by the LOW frequency field on purpose:
     a normal built from fine detail reads as crinkled foil, not as billows. */
  vec2 grad = (A.gb - 0.5) * 2.0 * uGradScale.x
            + (B.gb - 0.5) * 2.0 * uGradScale.y * 1.35 * puff * 0.30;
  vec2 gw = vec2(grad.x * wd.x - grad.y * perp.x, grad.x * wd.y - grad.y * perp.y);
  vec3 N = normalize(vec3(-gw.x * bump, 1.0, -gw.y * bump));

  float hl = dot(N, sunD) * 0.5 + 0.5;
  /* three readable tone bands rather than a smooth gradient */
  float band = smoothstep(0.28, 0.44, hl) * 0.32
             + smoothstep(0.42, 0.64, hl) * 0.36
             + smoothstep(0.60, 0.92, hl) * 0.32;

  /* Self-shadow: three taps marching toward the sun across the deck.  The step
     MUST stay a small fraction of the feature size (~0.25 uv) — a longer march
     samples uncorrelated noise and shreds the clouds into fibres. */
  vec2  sxz = sunD.xz;
  float sl  = length(sxz);
  vec2  sd  = (sl > 1e-3 ? sxz / sl : vec2(1.0, 0.0));
  vec2  sdq = vec2(dot(sd, wd), dot(sd, perp)) * vec2(1.0 / stretch, stretch) * 0.020;
  float occ = texture2D(uNoiseA, q + sdq * 1.0).r * 0.40
            + texture2D(uNoiseA, q + sdq * 2.1).r * 0.34
            + texture2D(uNoiseA, q + sdq * 3.6).r * 0.26;
  float shadow = 1.0 - smoothstep(cov + 0.01, cov + 0.16, occ) * 0.55;

  /* Thickness. We stand UNDER the deck, so a thick column reads as a dark flat
     base while a thin one glows: this single term carries the volumetric feel.
     Hard-clamped to 1 so a grazing-angle column can never accumulate into a
     solid bar of darkening. */
  float depth = min(smoothstep(cov - 0.050, cov + 0.090, H)
                    * (1.0 - tN * 0.45) * smoothstep(0.02, 0.22, d.y), 1.0);

  /* Sun-facing lobes dominate; the self-shadow only nudges. Weighting the
     shadow heavily turns every cloud interior into a violet bruise. */
  float lit = SAT(0.19 + band * 0.57 + shadow * 0.24) * mix(1.0, 0.35, depth);
  /* three-stop ramp: hue-shifted shadow → warm midtone → near-white top.
     A two-stop lerp is what makes procedural clouds read as grey mush. */
  vec3 col = mix(uCloudDark, uCloudAmb, SAT(lit * 2.0));
  col = mix(col, uCloudLit, SAT(lit * 2.0 - 1.0));

  /* ── an explicit lit/shadow VALUE ratio ───────────────────────────────
   * Everything above only moves the cloud along a ramp of three already-light
   * colours, so a deck can end up living inside a few percent of luminance and
   * read as one flat smear. The shadow side is therefore authored as a hard
   * 0.55 of the lit side (ART_BIBLE §2) and rotated onto uShadowTint's hue at
   * unit luminance, so it is genuinely darker AND cooler, never just darker. */
  float stL = max(skyLuma(uShadowTint), 1e-4);
  vec3  stChroma = mix(vec3(1.0), uShadowTint / stL, 0.45);
  vec3  shadeC = col * 0.55 * stChroma;
  float litMask = SAT(band * 1.30 + shadow * 0.42 - 0.30) * (1.0 - depth * 0.55);
  col = mix(shadeC, col, SAT(litMask));

  /* silver lining: thin translucent edges glow where they cross the sun */
  float mu  = max(dot(d, sunD), 0.0);
  float fwd = pow(mu, 13.0);
  float edge = smoothstep(0.05, 0.50, alpha) * (1.0 - smoothstep(0.50, 0.96, alpha));
  col += uCloudRim * edge * (0.05 + 1.05 * fwd) * uCloudRimAmt;
  col += uCloudRim * pow(mu, 44.0) * (1.0 - alpha * 0.82) * 0.75 * uCloudRimAmt;

  /* aerial perspective along the slab — distant deck melts into the haze.
     Driven by the NORMALISED slab parameter so every layer melts over the
     same angular range instead of the high layers saturating instantly. */
  float far = 1.0 - exp(-tN * 3.2);
  col = mix(col, skyC * 1.06 + uHaze * 0.06, far * 0.86);

  alpha *= slabFade * uCloudAmt * amt;
  return vec4(col, SAT(alpha));
}

/* ----------------------------------------------------------------- stars -- */
/*
 * One hashed point per cubic cell of the direction vector.  The dot must stay
 * FAR smaller than the cell (rad ~ 0.3 of a cell) and its falloff must be a
 * tight gaussian — a broad tail fills each cell and the whole field turns into
 * a visible lattice of square blobs.
 */
/*
 * Explicit magnitude distribution: 80 % faint (0.12–0.30), 15 % medium
 * (0.30–0.60), 5 % bright (0.60–1.00).  A pow() curve crushes ~95 % of the
 * field below the visible threshold, which is exactly why the old star field
 * read as a scatter of dots over an empty sky.
 */
float starMag(float r) {
  float a = mix(0.12, 0.30, clamp(r / 0.80, 0.0, 1.0));
  float b = mix(0.30, 0.60, clamp((r - 0.80) / 0.15, 0.0, 1.0));
  float c = mix(0.60, 1.00, clamp((r - 0.95) / 0.05, 0.0, 1.0));
  return r < 0.80 ? a : (r < 0.95 ? b : c);
}

vec3 starLayer(vec3 d, float grid, float thresh, float rad, float seed) {
  vec3 p = d * grid;
  vec3 c = floor(p);
  float id = dot(c, vec3(1.0, 113.7, 271.3)) + seed;
  float sel = hash11(id * 0.731 + 4.1);
  if (sel > thresh) return vec3(0.0);
  vec3 h = hash31(id + 1.7);
  vec3 sp = c + vec3(0.25) + h * 0.5;
  float dd = length(p - sp) / rad;
  float core = exp(-dd * dd * 6.5) + 0.13 * exp(-dd * dd * 1.4);
  float mag = starMag(hash11(id * 1.317 + 19.3));
  /* two detuned oscillators — a single sine reads as a synchronised pulse */
  float tw = 0.56 + 0.30 * sin(uTime * (1.05 + h.z * 2.9) + h.y * 47.0)
                  + 0.14 * sin(uTime * (2.70 + h.x * 4.1) + h.z * 91.0);
  /* colour temperature spread: most white, a few warm, a few blue */
  vec3 tint = mix(vec3(1.05, 0.84, 0.66), vec3(0.70, 0.84, 1.14), smoothstep(0.30, 0.75, h.x));
  tint = mix(vec3(1.0), tint, 0.8);
  return tint * (core * mag * tw);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 sunD = normalize(uSunDir);
  vec3 moonD = nrmSafe(uMoonDir, vec3(0.0, 1.0, 0.0));

  float mu = d.y;
  float am = 1.0 / (max(mu, 0.0) + 0.10);                 /* airmass proxy */

  /* ---- the vertical gradient, straight off the ART_BIBLE §3 rows ----
   * Exactly the same function every distant surface fogs toward, so a ridge can
   * never disagree with the sky it is silhouetted against. */
  vec3 col = skyGradient(d);
  float hb = exp(-max(d.y, -0.06) / uHazeH);

  /* Real sky is never a flat wash. Three octaves of very-low-amplitude
     variation in the Rayleigh column — a faint cirrostratus veil — keep the
     clear blue alive: the amplitude stays under ~6 % so it reads as air rather
     than as noise, but it is enough that no 32 px block of sky is ever
     perfectly flat (ART_BIBLE §5, "no empty pixel"). */
  float veil = snoise(d * 2.1  + vec3( 3.7,  8.1,  1.9)) * 0.40
             + snoise(d * 6.4  + vec3(19.3,  2.7, 24.1)) * 0.26
             + snoise(d * 17.0 + vec3(41.1, 33.7,  5.5)) * 0.20
             + snoise(d * 41.0 + vec3(13.9, 57.3, 71.7)) * 0.14;
  col *= 1.0 + veil * 0.105 * (0.40 + 0.60 * smoothstep(0.01, 0.32, d.y));

  /* The haze band's lower edge is pinned to where the aerial term is already
     effectively opaque, NOT to the dome's horizon line, and its luminance is
     held to 0.88 there: a receding plane must never be lighter than the plane
     in front of it, and a hot strip sitting right on the horizon inverts the
     depth read (it stops looking like sky and starts looking like water). */
  col *= mix(0.88, 1.0, smoothstep(0.0, 0.052, d.y));

  /* ---- night sky: milky way, stars, moon (all behind the clouds) ---- */
  if (uStars > 0.002) {
    vec3 mwAxis = normalize(vec3(0.46, 0.60, -0.66));
    float b = dot(d, mwAxis);
    /* Project onto the plane perpendicular to the band axis instead of using
       atan(): an angular coordinate wraps at ±π and leaves a hard seam plus a
       mip-level crack straight across the sky. */
    vec3 mT = nrmSafe(cross(mwAxis, refAxis(mwAxis)), vec3(1.0, 0.0, 0.0));
    vec3 mB = cross(mT, mwAxis);
    vec2 mwUV = vec2(dot(d, mT), dot(d, mB)) * 0.85 + vec2(0.31, 0.62);

    /* Four overlapping octaves at 1.0 / 2.7 / 6.3 / 14, evaluated in 3-D
       DIRECTION space rather than through a tangent-plane uv. The projection
       route turns the band's own radial falloff into a set of regular parallel
       streaks and it is the streaks the eye reads, not the noise; sampling the
       direction directly also removes the 8-bit terracing of the baked textures
       and cannot seam. */
    vec3 mp = d * 3.4;
    float o1 = snoise(mp * 1.00 + vec3(11.3,  4.1,  7.7)) * 0.5 + 0.5;
    float o2 = snoise(mp * 2.70 + vec3(23.1, 41.7,  3.3)) * 0.5 + 0.5;
    float o3 = snoise(mp * 6.30 + vec3( 5.9, 17.3, 31.1)) * 0.5 + 0.5;
    float o4 = snoise(mp * 14.0 + vec3(61.7,  9.3, 45.1)) * 0.5 + 0.5;
    float clouds = 0.35 * o1 + 0.18 * o2 + 0.09 * o3 + 0.05 * o4;
    clouds = pow(SAT(clouds * 1.55), 1.5);      /* brighter cores, darker gaps */

    /* A WIDE gaussian band mask — nothing here has an edge — plus a narrow
       dark rift down the centre (the Great Rift) so the band is not a bar. */
    float wide  = exp(-b * b * 22.0);
    float bandE = exp(-b * b * 34.0);
    float rift  = 1.0 - 0.46 * exp(-b * b * 700.0);
    float dust  = snoise(mp * 4.10 + vec3(77.0, 13.0, 29.0)) * 0.5 + 0.5;
    float mw = wide * rift * clouds * (0.60 + 0.80 * (1.0 - dust));
    mw *= smoothstep(-0.05, 0.24, d.y);
    col += mix(vec3(0.72, 0.78, 1.0), vec3(1.0, 0.93, 0.84), 0.22 + 0.40 * o1)
         * mw * uMilky * uStars;

    /* Stars. Density is deliberately NOT starved toward the horizon — an empty
       lower sky is the classic tell. Extinction dims, it does not thin. */
    float dens = 1.0 + 1.6 * bandE;
    vec3 st = starLayer(d, 140.0, 0.030 * dens, 0.32, 0.0)  * 1.00
            + starLayer(d, 300.0, 0.0060 * dens, 0.28, 31.7) * 0.80
            + starLayer(d, 620.0, 0.0012 * dens, 0.26, 77.3) * 0.55;
    /* The band itself is millions of unresolved stars: a very dense, very faint
       layer confined to it supplies the grain that makes it read as a star
       field rather than as a smear of fog. */
    st += starLayer(d, 1150.0, 0.0022 * bandE, 0.24, 133.0) * 0.45 * bandE;
    st *= smoothstep(-0.006, 0.050, d.y) * mix(0.60, 1.0, smoothstep(0.0, 0.50, d.y));
    col += st * uStars * 1.7;

    /* ---- moon ---- */
    float cm = dot(d, moonD);
    float ang = acos(clamp(cm, -1.0, 1.0));
    vec3 T = nrmSafe(cross(moonD, refAxis(moonD)), vec3(1.0, 0.0, 0.0));
    vec3 Bv = cross(T, moonD);
    vec2 mUV = vec2(dot(d, T), dot(d, Bv)) / uMoonSize;
    float r2 = dot(mUV, mUV);
    vec3 mnrm = vec3(mUV, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
    float lamM = dot(mnrm, normalize(vec3(-0.52, 0.20, 0.83)));
    float shade = smoothstep(-0.22, 0.55, lamM);
    float craters = texture2D(uNoiseB, mUV * 0.30 + 0.5).r * 0.6
                  + texture2D(uNoiseA, mUV * 0.9 + 0.2).r * 0.4;
    float disc = 1.0 - smoothstep(uMoonSize * 0.93, uMoonSize * 1.05, ang);
    vec3 mc = uMoonCol * (0.30 + 0.85 * shade) * (0.78 + 0.42 * craters);
    /* soft limb darkening */
    mc *= mix(1.0, 0.82, SAT(r2));
    col = mix(col, mc * 2.4, disc * uStars);
    float halo = pow(max(cm, 0.0), 1400.0) * 0.55
               + pow(max(cm, 0.0), 90.0) * 0.075
               + exp(-ang * 7.5) * 0.055;
    col += uMoonCol * halo * uStars * 1.25;
  }

  /* ---- sun: Mie forward scatter, then the disc ---- */
  float sunUp = smoothstep(-0.12, 0.04, sunD.y);
  float lowSun = pow(1.0 - SAT(sunD.y * 1.85), 2.4);
  float cosT = dot(d, sunD);
  float gg = uMieG;
  float hg = (1.0 - gg * gg) / pow(max(1.0 + gg * gg - 2.0 * gg * cosT, 1e-4), 1.5);
  float mie = hg * 0.055 * uMieAmt * (0.30 + 4.2 * lowSun) * (0.32 + 0.68 * min(am, 7.0) / 7.0);
  col += uGlowTint * mie * sunUp;
  col += uGlowTint * pow(max(cosT, 0.0), 4.0) * 0.17 * (0.35 + 2.1 * lowSun) * sunUp;

  float ang = acos(clamp(cosT, -1.0, 1.0));
  float core = 1.0 - smoothstep(uSunSize * 0.80, uSunSize * 1.30, ang);
  col += uSunTint * core * uSunI * sunUp;
  col += uSunTint * exp(-ang / (uSunSize * 5.0)) * uSunI * 0.085 * sunUp;

  /* ---- below the horizon fades to the aerial colour (hills cover it) ---- */
  col = mix(col, uFogColor * 0.92, smoothstep(0.0, -0.14, d.y) * uGroundFade);

  /* ---- clouds, composited front-to-back with early-out ---- */
  vec3 skyC = skyGradient(d);
  vec3 cAcc = vec3(0.0);
  float aAcc = 0.0;
  vec4 L;
  L = cloudLayer(d, uHeightL.x, uScaleL.x, uSpeedL.x, uCovL.x, uStretchL.x, uPuffL.x, uWarpL.x, uBumpL.x, uAmtL.x, uZenCovL.x, uZenAmtL.x, sunD, skyC);
  cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  if (aAcc < 0.985) {
    L = cloudLayer(d, uHeightL.y, uScaleL.y, uSpeedL.y, uCovL.y, uStretchL.y, uPuffL.y, uWarpL.y, uBumpL.y, uAmtL.y, uZenCovL.y, uZenAmtL.y, sunD, skyC);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  if (aAcc < 0.985) {
    L = cloudLayer(d, uHeightL.z, uScaleL.z, uSpeedL.z, uCovL.z, uStretchL.z, uPuffL.z, uWarpL.z, uBumpL.z, uAmtL.z, uZenCovL.z, uZenAmtL.z, sunD, skyC);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  if (aAcc < 0.985) {
    L = cloudLayer(d, uHeightL.w, uScaleL.w, uSpeedL.w, uCovL.w, uStretchL.w, uPuffL.w, uWarpL.w, uBumpL.w, uAmtL.w, uZenCovL.w, uZenAmtL.w, sunD, skyC);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  /* Hard ceiling on how much of the HIGH sky cloud is allowed to replace: above
     ~25° elevation at most 55 % of the frame's sky radiance can be cloud, so the
     saturated zenith blue always survives in the top third no matter how the
     noise field lands on a given frame. */
  float aCap = mix(1.0, 0.55, smoothstep(0.26, 0.46, d.y));
  if (aAcc > aCap) { cAcc *= aCap / max(aAcc, 1e-4); aAcc = aCap; }
  col = cAcc + col * (1.0 - aAcc);

  /* 8-bit gradients band horribly on a sky — dither below the quantisation step.
     Scaled with luminance so the night sky is not overwhelmed by grain. */
  float dn = hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  col += dn * uDither * (0.30 + 1.8 * col);

  gl_FragColor = vec4(clamp(col, vec3(0.0), vec3(90.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ══════════════════════════════════════════════════════════════════════════
 *  Distant hills — one shader, three instantiations with different
 *  aerial-perspective constants.
 * ══════════════════════════════════════════════════════════════════════════ */

export const HILL_VERT = /* glsl */`
attribute float aRidge;
varying vec2  vUv;
varying vec3  vWPos;
varying float vRidge;
void main() {
  vUv = uv;
  vRidge = aRidge;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const HILL_FRAG = /* glsl */`
precision highp float;

${GLSL_SKY_UNIFORMS}
${GLSL_SKY_RADIANCE}

varying vec2  vUv;
varying vec3  vWPos;
varying float vRidge;

uniform sampler2D uNoiseA;
uniform sampler2D uNoiseB;
uniform vec3  uFogColor;
uniform vec3  uHillLit;
uniform vec3  uHillDark;
uniform vec3  uHillRim;
uniform vec3  uTreeCol;
uniform float uAerialK;    /* shared extinction coefficient, 1/world-units */
uniform float uFogFloor;   /* per-band minimum haze fraction */
uniform float uRidgeFreq;
uniform float uVScale;
uniform float uTreeAmt;
uniform float uSeed;
uniform float uNight;
uniform vec3  uNightFog;
uniform vec3  uCamPos;
uniform vec3  uMoonDir;
uniform vec3  uMoonGlow;
/* the valley-floor albedo, so the band's base can dissolve into exactly the
   surface that continues behind it instead of terminating on a hard edge */
uniform vec3  uFloorNear;
uniform vec3  uFloorFar;
uniform float uMistAmt;

#define SAT(x) clamp(x, 0.0, 1.0)

/* normalize() of a zero vector is NaN and one NaN pixel poisons the downstream
   bloom mip chain (the frame returns as a flat grey wash), so every direction
   that could arrive as zero goes through this. */
vec3 nrmSafeM(vec3 v) { float l = length(v); return l > 1e-5 ? v / l : vec3(0.0, 1.0, 0.0); }
vec3 nrmSafeV(vec3 v) { float l = length(v); return l > 1e-5 ? v / l : vec3(0.0, 0.0, 1.0); }

void main() {
  vec3 sunD = normalize(uSunDir);
  vec2 t = vec2(vUv.x * uRidgeFreq + uSeed, vWPos.y * uVScale + uSeed * 0.37);

  vec4 A = texture2D(uNoiseA, t);
  vec4 B = texture2D(uNoiseB, t * 1.6 + 1.31);

  /* spurs and gullies: fake a normal from the noise gradient wrapped around
     the ring's outward direction, so the range has facets that catch the sun */
  vec2 g = (A.gb - 0.5) * 1.05 + (B.gb - 0.5) * 0.35;
  vec3 outw = normalize(vec3(vWPos.x, 0.0, vWPos.z) + 1e-4);
  vec3 tang = vec3(-outw.z, 0.0, outw.x);
  vec3 N = normalize(outw * 0.80 + vec3(0.0, 0.62, 0.0) + tang * g.x * 1.35 - outw * g.y * 0.35);

  float lam = dot(N, sunD) * 0.5 + 0.5;
  float band = smoothstep(0.34, 0.475, lam) * 0.42
             + smoothstep(0.46, 0.68, lam) * 0.34
             + smoothstep(0.64, 0.94, lam) * 0.24;

  vec3 col = mix(uHillDark, uHillLit, SAT(band));

  /* valleys hold darker vegetation, summits are drier and catch more light */
  col *= mix(0.80, 1.14, SAT(vRidge * 0.55 + vUv.y * 0.70));

  /* tree-line: only the nearest band gets it, and only near the crest */
  if (uTreeAmt > 0.001) {
    float mask = smoothstep(0.62, 0.99, vUv.y) * uTreeAmt;
    /* Sampling only on (vUv.x, worldY) shears with the ridge height and the
       result reads as vertical fur. A third tap on a WORLD-space xz coordinate
       is not sheared at all, so the crowns come out as rounded lumps. */
    vec2 wxz = vec2(vWPos.x, vWPos.z) * 0.085;
    float tn = texture2D(uNoiseB, vec2(vUv.x * 46.0, vWPos.y * uVScale * 2.1)).a * 0.42
             + texture2D(uNoiseA, vec2(vUv.x * 118.0, vWPos.y * uVScale * 5.4)).a * 0.20
             + texture2D(uNoiseB, wxz * 1.7 + 0.23).r * 0.24
             + texture2D(uNoiseA, wxz * 4.3 + 0.61).r * 0.14;
    float trees = smoothstep(0.42, 0.66, tn);
    /* The crowns must stay clearly DARKER than the hazed range behind them —
       a tree line at the same value as the far mountain destroys the depth
       ordering just as surely as one that is too saturated. */
    vec3 tc = mix(uTreeCol * 0.66, uTreeCol * 1.04, SAT(band + 0.20));
    col = mix(col, tc, mask * trees * 0.88);
    /* a few sun-caught crowns break up the flat band */
    col += uHillRim * mask * smoothstep(0.66, 0.86, tn) * SAT(band - 0.30) * 0.22;
  }

  /* Ridge rim: the top edge catches the sky / back light. The window has to be
     WIDE relative to the card — these cards only show their upper portion, so a
     0.965..1.0 window is ~2 px on screen and reads as a traced outline stroke
     rather than as a lit crest. */
  float rim = smoothstep(0.88, 1.0, vUv.y);
  col += uHillRim * rim * 0.20 * SAT(dot(N, sunD) + 0.10);

  /* ── valley mist ───────────────────────────────────────────────────────
   * Below its crest each band was a single flat plate of haze — the largest
   * dead region left in the frame. A low mist deck tucked into the foot of the
   * range fixes both problems at once: it is what separates one range from the
   * next in a hanami painting, and its horizontal variation (three octaves of
   * the baked field, sampled on vUv.x only so it lies FLAT) means the plate is
   * never uniform. Applied before the base cross-fade so the very bottom of the
   * card still lands on the floor albedo. */
  float mN = texture2D(uNoiseA, vec2(vUv.x * 2.30 + uSeed, 0.31)).r * 0.50
           + texture2D(uNoiseB, vec2(vUv.x * 6.10 + uSeed, 0.67)).r * 0.30
           + texture2D(uNoiseA, vec2(vUv.x * 15.0 + uSeed, 0.13)).a * 0.20;
  float mistTop = 0.30 + mN * 0.26;
  float mist = smoothstep(mistTop, 0.05, vUv.y) * (0.62 + 0.52 * mN);
  /* 0.96, not 1.05: a mist deck brighter than the sky above it blows out into a
     near-white bar that competes with the hero subject for the eye. */
  col = mix(col, skyRadiance(vWPos - uCamPos) * 0.96, SAT(mist * uMistAmt));

  /* ── aerial perspective ────────────────────────────────────────────────
   * One exponential extinction law shared with the valley floor, fogging toward
   * skyRadiance() sampled along THIS fragment's own view ray — not toward a
   * single scalar uFogColor. That is what stops the far range coming back warmer
   * and more saturated than the cool sky it is silhouetted against.
   *
   * The albedo is desaturated before the lift (air kills chroma first), so the
   * tree line loses its yellow-green long before it loses its value. */
  vec3 rd = vWPos - uCamPos;
  float dist = length(rd);
  float f = 1.0 - exp(-dist * uAerialK);
  f *= mix(1.10, 0.90, SAT(vUv.y));      /* base sits in more air than the crest */
  f = clamp(max(f, uFogFloor), 0.0, 0.92);

  /* ── the band's lower edge ─────────────────────────────────────────────
   * The card simply STOPPED here before, which left a 1 px horizontal step
   * against the valley floor behind it. Instead its albedo cross-fades into the
   * floor albedo at the same distance across a genuine 60 screen pixels
   * (fwidth turns the uv derivative into a per-pixel measure), and both sides
   * then run the identical aerial term — so the join agrees by construction. */
  float px = max(fwidth(vUv.y), 1e-6);
  float baseFade = smoothstep(0.0, 60.0 * px, vUv.y);
  vec3 groundAlb = mix(uFloorNear, uFloorFar, smoothstep(95.0, 430.0, dist));
  col = mix(groundAlb, col, baseFade);

  col = applySkyAerial(col, rd, f, 0.70);

  /* ── night ─────────────────────────────────────────────────────────────
   * A single flat fill reads as a cut-out. The range needs (a) a three-stop
   * vertical value ramp so the base sinks and the crest lifts toward the sky,
   * (b) the spur shading kept alive so the silhouette has internal form, and
   * (c) moon-side forward scatter so the ridge nearest the moon separates from
   * the ones behind it. Uses the sky's OWN palette fog, not the shared one, so
   * the hills can never stay sunlit under a night sky if the lighting rig is
   * on a different clock. */
  float vr = SAT(vUv.y);
  /* 0.74 → 1.12, not 0.62 → 1.38. The bands are cards that show only their upper
     portion, so the ramp is squeezed into far less screen height than it used to
     be; the old span turned into a hard bright edge along the crest — a traced
     silhouette instead of a moonlit range. */
  float ramp = mix(0.74, 0.99, smoothstep(0.0, 0.60, vr))
             + smoothstep(0.60, 1.0, vr) * 0.13;
  vec3 nightCol = uNightFog * ramp;
  nightCol *= mix(0.90, 1.16, SAT(band));                 /* keep the spurs */
  vec3 V = nrmSafeV(vWPos - uCamPos);
  float fwd = pow(max(dot(V, nrmSafeM(uMoonDir)), 0.0), 6.0);
  nightCol += uMoonGlow * fwd * 0.35;
  /* crest catches the moonlit sky directly */
  /* a WIDE crest glow, not the 2 px rim line -- a hairline outline reads as a
     traced silhouette rather than as a moonlit ridge */
  float crest = smoothstep(0.58, 1.0, vr);
  nightCol += uMoonGlow * crest * 0.15 * SAT(dot(N, nrmSafeM(uMoonDir)) + 0.35);
  /* the same 60 px base cross-fade, into the floor's own night value */
  vec3 floorNight = uNightFog * (0.78 + 0.34 * smoothstep(35.0, 250.0, dist)
                                 + 0.30 * smoothstep(95.0, 430.0, dist));
  nightCol = mix(floorNight, nightCol, baseFade);
  col = mix(col, nightCol, uNight * 0.88);

  gl_FragColor = vec4(clamp(col, vec3(0.0), vec3(90.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ══════════════════════════════════════════════════════════════════════════
 *  Far valley floor — a huge low disc that guarantees the region between the
 *  playable terrain and the hills never shows raw sky, and reads as hazed
 *  distant land.
 * ══════════════════════════════════════════════════════════════════════════ */

export const FLOOR_VERT = /* glsl */`
varying vec3 vWPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const FLOOR_FRAG = /* glsl */`
precision highp float;

${GLSL_SKY_UNIFORMS}
${GLSL_SKY_RADIANCE}

varying vec3 vWPos;

uniform sampler2D uNoiseA;
uniform sampler2D uNoiseB;
uniform vec3  uFogColor;
uniform vec3  uNearCol;
uniform vec3  uFarCol;
uniform vec3  uNightFog;
uniform vec3  uCamPos;
uniform vec3  uMoonDir;
uniform vec3  uMoonGlow;
uniform float uNight;
uniform float uAerialK;
uniform float uGroundAerial;   /* extra ground-level aerial lift (dusk haze) */

#define SAT(x) clamp(x, 0.0, 1.0)

/* normalize() of a zero vector is NaN and one NaN pixel poisons the downstream
   bloom mip chain (the frame returns as a flat grey wash), so every direction
   that could arrive as zero goes through this. */
vec3 nrmSafeM(vec3 v) { float l = length(v); return l > 1e-5 ? v / l : vec3(0.0, 1.0, 0.0); }
vec3 nrmSafeV(vec3 v) { float l = length(v); return l > 1e-5 ? v / l : vec3(0.0, 0.0, 1.0); }

void main() {
  vec2 p = vWPos.xz;
  vec3 rd = vWPos - uCamPos;
  float dist = length(rd);

  float n = texture2D(uNoiseA, p * 0.0032).r;
  float m = texture2D(uNoiseB, p * 0.0125 + 0.4).r;
  float f2 = texture2D(uNoiseA, p * 0.041 + 0.7).a;

  /* Near → far is driven by DISTANCE, with the noise only perturbing it.
     Letting the noise drive the blend (the old SAT(n*0.75 + m*0.35)) put the
     pale, desaturated FAR colour right up against the playable terrain, so the
     first thing past the terrain edge was the brightest band in the frame — it
     read as water, not as receding ground. */
  float dn = smoothstep(95.0, 430.0, dist);
  float mixF = SAT(dn + (n - 0.5) * 0.26 + (m - 0.5) * 0.14);
  vec3 col = mix(uNearCol, uFarCol, mixF);
  col *= mix(0.90, 1.10, f2);
  col *= mix(1.0, 0.90, smoothstep(0.45, 0.75, m));

  /* The strip of this disc that is visible between the playable terrain edge
     and the first hill band spans roughly 55–125 world units, and its value
     must land BETWEEN the terrain in front of it and the hill base behind it,
     with no step at either seam. Left alone the fog ramp alone makes that strip
     climb ~25 % across its width, which reads as a bright bar. Lifting the near
     end flattens it: the profile still rises with distance (correct aerial
     perspective) but only just. */
  col *= mix(1.22, 1.0, smoothstep(40.0, 132.0, dist));

  /* ── the SAME aerial operator the hill bands use ───────────────────────
   * Identical extinction coefficient, identical skyRadiance() sample along the
   * fragment's own ray. Both sides of the hill/floor join therefore land on the
   * same value at the same distance and the seam cannot exist.
   *
   * uGroundAerial adds the extra ground-level haze a low sun produces, so at
   * dusk the near valley genuinely picks up the #F5A86E horizon instead of
   * staying a neutral grey plate. */
  float f = 1.0 - exp(-dist * uAerialK * (1.0 + uGroundAerial));
  f = clamp(max(f, uGroundAerial * 0.22), 0.0, 0.94);
  col = applySkyAerial(col, rd, f, 0.55);

  /* night: a distance ramp plus moon-side forward scatter, so the valley is a
     receding volume rather than a flat navy fill */
  vec3 V = nrmSafeV(vWPos - uCamPos);
  float fwd = pow(max(dot(V, nrmSafeM(uMoonDir)), 0.0), 6.0);
  /* Two ramps: a near one across the strip that is actually visible between the
     terrain edge and the first hill band (≈40–260 units), and the far one for
     the rest of the disc. A single far ramp leaves the visible strip a flat
     navy fill, which is what made night read as a cut-out. */
  float nearR = smoothstep(35.0, 250.0, dist);
  vec3 nightCol = uNightFog * (0.78 + 0.34 * nearR + 0.30 * dn)
                + uMoonGlow * fwd * 0.30;
  col = mix(col, nightCol, uNight * 0.86);

  gl_FragColor = vec4(clamp(col, vec3(0.0), vec3(90.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ══════════════════════════════════════════════════════════════════════════
 *  Palette — ART_BIBLE §3 rows, expanded to a cycle of keys so dusk→night
 *  interpolates instead of snapping.  All colours authored in sRGB hex.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * u is a normalised position in the day cycle:
 *   0.00 deep night · 0.24 dawn · 0.46 day · 0.72 golden · 0.82 dusk · 0.94 night
 */
export const SKY_KEYS = [
  { u: 0.00, zenith: 0x101a34, mid: 0x18234a, horizon: 0x2a3355, haze: 0x33406a, hazeAmt: 0.42,
    sun: 0x9fb6e8, glow: 0x54689e, fog: 0x1b2440, cloudLit: 0x6e7aa8, cloudDark: 0x1d2542,
    cloudAmb: 0x222c4e, cloudRim: 0x8fa4d8, sunI: 0.0, sunSize: 0.030, mieAmt: 0.35, stars: 1.0,
    cov: [0.62, 0.60, 0.58, 0.66], hillLit: 0x2b3559, hillDark: 0x161e38, tree: 0x1a2440,
    floorNear: 0x1d2742, floorFar: 0x1b2440, exposure: 1.0 , zk: 0.36, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0030, gAer: 0.10 },

  { u: 0.15, zenith: 0x14203c, mid: 0x1d2b54, horizon: 0x3b3f62, haze: 0x50496f, hazeAmt: 0.50,
    sun: 0xa9b8e0, glow: 0x6d6394, fog: 0x232c4a, cloudLit: 0x7e7fa8, cloudDark: 0x232a48,
    cloudAmb: 0x2a3356, cloudRim: 0x9c9ad4, sunI: 0.0, sunSize: 0.030, mieAmt: 0.5, stars: 0.82,
    cov: [0.60, 0.58, 0.56, 0.64], hillLit: 0x323a5c, hillDark: 0x1b213c, tree: 0x1e2744,
    floorNear: 0x232c48, floorFar: 0x232c4a, exposure: 1.0 , zk: 0.38, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0032, gAer: 0.14 },

  { u: 0.26, zenith: 0x2a4a86, mid: 0x6a5a92, horizon: 0xe0917e, haze: 0xf0a882, hazeAmt: 0.72,
    sun: 0xffb488, glow: 0xff9e6e, fog: 0xd9a08c, cloudLit: 0xffd3b4, cloudDark: 0x4a3659,
    cloudAmb: 0xa2879e, cloudRim: 0xffc9a4, sunI: 7.0, sunSize: 0.026, mieAmt: 1.45, stars: 0.28,
    cov: [0.55, 0.53, 0.52, 0.60], hillLit: 0x6d6472, hillDark: 0x39364f, tree: 0x2f3040,
    floorNear: 0x615b72, floorFar: 0x9c7d7c, exposure: 1.0 , zk: 0.50, zdeep: 0.96, midAmt: 0.30, aerialK: 0.0038, gAer: 0.38 },

  { u: 0.34, zenith: 0x3f6fbc, mid: 0x8fa8d6, horizon: 0xf3c9a8, haze: 0xf7d3ac, hazeAmt: 0.60,
    sun: 0xffdcb0, glow: 0xffc48e, fog: 0xd6cbc4, cloudLit: 0xfff0e2, cloudDark: 0x676293,
    cloudAmb: 0xb3bcd6, cloudRim: 0xffe4c8, sunI: 12.0, sunSize: 0.022, mieAmt: 1.05, stars: 0.0,
    cov: [0.52, 0.50, 0.50, 0.58], hillLit: 0x7c9070, hillDark: 0x455440, tree: 0x374a32,
    floorNear: 0x618148, floorFar: 0x91a4a2, exposure: 1.0 , zk: 0.46, zdeep: 0.74, midAmt: 0.26, aerialK: 0.0040, gAer: 0.34 },

  { u: 0.50, zenith: 0x4e86d4, mid: 0x8fbbe8, horizon: 0xcfe0f2, haze: 0xdfeaf6, hazeAmt: 0.55,
    sun: 0xffebcb, glow: 0xfff0dc, fog: 0xbcd3ea, cloudLit: 0xfffaf2, cloudDark: 0x6e76a8,
    cloudAmb: 0xbdc9e2, cloudRim: 0xfff4e2, sunI: 17.0, sunSize: 0.019, mieAmt: 0.80, stars: 0.0,
    cov: [0.50, 0.48, 0.49, 0.57], hillLit: 0x7f9a6e, hillDark: 0x435e3c, tree: 0x36502f,
    floorNear: 0x638148, floorFar: 0x81978f, exposure: 1.0 , zk: 0.42, zdeep: 0.52, midAmt: 0.16, aerialK: 0.0022, gAer: 0.12 },

  { u: 0.64, zenith: 0x4a7cc8, mid: 0x9cbbdf, horizon: 0xe6d7c2, haze: 0xf2dcbc, hazeAmt: 0.52,
    sun: 0xffe0b0, glow: 0xffd8a4, fog: 0xcdd2d6, cloudLit: 0xfff2df, cloudDark: 0x6f78a2,
    cloudAmb: 0xbcc4d8, cloudRim: 0xffeacf, sunI: 15.0, sunSize: 0.020, mieAmt: 1.00, stars: 0.0,
    cov: [0.49, 0.47, 0.48, 0.56], hillLit: 0x84996c, hillDark: 0x475c3c, tree: 0x39502e,
    floorNear: 0x688245, floorFar: 0x86998b, exposure: 1.0 , zk: 0.43, zdeep: 0.58, midAmt: 0.19, aerialK: 0.0027, gAer: 0.20 },

  { u: 0.74, zenith: 0x3f68b4, mid: 0x9d8fbe, horizon: 0xf7c489, haze: 0xffcf92, hazeAmt: 0.70,
    sun: 0xffcf94, glow: 0xffb271, fog: 0xefc0a0, cloudLit: 0xffe8c8, cloudDark: 0x5f5081,
    cloudAmb: 0xd6b8ae, cloudRim: 0xffd9a8, sunI: 13.0, sunSize: 0.023, mieAmt: 1.55, stars: 0.0,
    cov: [0.48, 0.47, 0.47, 0.55], hillLit: 0x8a8a62, hillDark: 0x4b4a3c, tree: 0x3c4130,
    floorNear: 0x616f3e, floorFar: 0x8f8071, exposure: 1.0 , zk: 0.48, zdeep: 0.88, midAmt: 0.28, aerialK: 0.0034, gAer: 0.30 },

  { u: 0.82, zenith: 0x3a4e86, mid: 0x7d5f8c, horizon: 0xf5a86e, haze: 0xffa268, hazeAmt: 0.86,
    sun: 0xff9e5e, glow: 0xff8348, fog: 0xe8a57e, cloudLit: 0xffd0a2, cloudDark: 0x4a3457,
    cloudAmb: 0xc08d80, cloudRim: 0xffb787, sunI: 9.0, sunSize: 0.029, mieAmt: 2.10, stars: 0.10,
    cov: [0.47, 0.46, 0.46, 0.54], hillLit: 0x7a6558, hillDark: 0x3f3040, tree: 0x33283a,
    floorNear: 0x50483e, floorFar: 0x866453, exposure: 1.0 , zk: 0.52, zdeep: 0.92, midAmt: 0.32, aerialK: 0.0041, gAer: 0.42 },

  { u: 0.89, zenith: 0x25315e, mid: 0x4a3f70, horizon: 0xb46a72, haze: 0xc06f6a, hazeAmt: 0.70,
    sun: 0xd4785e, glow: 0xb85a52, fog: 0x8a5f66, cloudLit: 0xb98a90, cloudDark: 0x2f2648,
    cloudAmb: 0x7d5a68, cloudRim: 0xdc8f7e, sunI: 2.0, sunSize: 0.032, mieAmt: 1.30, stars: 0.42,
    cov: [0.52, 0.50, 0.49, 0.58], hillLit: 0x453c50, hillDark: 0x211d36, tree: 0x1f1c32,
    floorNear: 0x312d49, floorFar: 0x4d3a49, exposure: 1.0 , zk: 0.46, zdeep: 0.94, midAmt: 0.28, aerialK: 0.0038, gAer: 0.34 },

  { u: 1.00, zenith: 0x101a34, mid: 0x18234a, horizon: 0x2a3355, haze: 0x33406a, hazeAmt: 0.42,
    sun: 0x9fb6e8, glow: 0x54689e, fog: 0x1b2440, cloudLit: 0x6e7aa8, cloudDark: 0x1d2542,
    cloudAmb: 0x222c4e, cloudRim: 0x8fa4d8, sunI: 0.0, sunSize: 0.030, mieAmt: 0.35, stars: 1.0,
    cov: [0.62, 0.60, 0.58, 0.66], hillLit: 0x2b3559, hillDark: 0x161e38, tree: 0x1a2440,
    floorNear: 0x1d2742, floorFar: 0x1b2440, exposure: 1.0 , zk: 0.36, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0030, gAer: 0.10 },
];

/** phase name + t (0..1) → cycle position u (0..1). */
export function phaseToU(phase, t) {
  const c = Math.min(Math.max(t ?? 0, 0), 1);
  switch (phase) {
    case 'dawn': return 0.16 + c * 0.26;   // 0.16 → 0.42
    case 'day': return 0.42 + c * 0.24;    // 0.42 → 0.66
    case 'dusk': return 0.66 + c * 0.23;   // 0.66 → 0.89
    case 'night': { const u = 0.89 + c * 0.27; return u >= 1 ? u - 1 : u; }
    default: return 0.5;
  }
}
