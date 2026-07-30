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

/**
 * Periodic separable box blur, three passes ≈ gaussian. Used to build the field
 * the cumulus GRADIENT is taken from.
 *
 * Differentiation amplifies frequency: an octave at f=16 with amplitude 0.22
 * contributes MORE gradient energy than the f=2 base at amplitude 1.0. So a
 * normal built from the raw field follows the finest wrinkles, and the deck
 * renders as wormy crinkled foil instead of as billowing domes — measured, this
 * was the exact look of round 2. Blurring first (radius ≈ 0.04 uv kills every
 * octave above f≈8) leaves the relief following only the big lobes, while the
 * un-blurred field still supplies the crisp cauliflower silhouette.
 */
function blurPeriodic(field, N, radius) {
  const r = Math.max(1, radius | 0);
  let src = field, dst = new Float32Array(N * N);
  const inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < N; j++) {                       // horizontal
      const row = j * N;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + ((k % N) + N) % N];
      for (let i = 0; i < N; i++) {
        dst[row + i] = acc * inv;
        acc += src[row + ((i + r + 1) % N)] - src[row + ((i - r + N) % N)];
      }
    }
    const t = src === field ? new Float32Array(N * N) : src;
    src = dst; dst = t;
    for (let i = 0; i < N; i++) {                       // vertical
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(((k % N) + N) % N) * N + i];
      for (let j = 0; j < N; j++) {
        dst[j * N + i] = acc * inv;
        acc += src[((j + r + 1) % N) * N + i] - src[((j - r + N) % N) * N + i];
      }
    }
    const t2 = src; src = dst; dst = t2;
  }
  return src;
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
 *             texC: import('three').DataTexture, gradScale: [number, number, number] }}
 */
export function makeSkyNoiseTextures(THREE, N = 512) {
  /* Only 3 octaves, deliberately.  A 5-octave fbm puts ±3% detail at 1/64 uv,
     which lands right inside the alpha threshold window and shreds every cloud
     edge into fibres — the single worst artefact this shader can produce. */
  const hA = bakeField(N, 3, 3, 1201, 0.45, RIDGE_FBM);
  const hB = bakeField(N, 3, 3, 7717, 0.45, RIDGE_RIDGED);
  const warp = bakeField(N, 2, 2, 3313, 0.50, RIDGE_FBM);
  const det = bakeField(N, 8, 3, 5501, 0.50, RIDGE_RIDGED);
  /* ── the cumulus field ────────────────────────────────────────────────────
   * texA (plain fbm) has no preferred shape: thresholding it yields the flat,
   * ragged, filamentary blobs that made the day sky read as smeared cirrus at
   * every coverage setting. BILLOW (|n|) is the classic cumulus generator — its
   * level sets are ROUNDED LOBES, so a threshold carves cauliflower masses with
   * convex tops, which is exactly what a painted anime cumulus is.
   *
   * base 2 / 4 octaves / gain 0.60: one dominant mass scale (half the texture)
   * with three visible generations of lobes on it, i.e. a mass that has a shape
   * AND sub-form. The gradient baked next to it is the gradient of THAT field,
   * so the relief shading in cloudLayer() follows the lobes it can see. */
  const hC = bakeField(N, 2, 4, 9137, 0.60, RIDGE_BILLOW);
  const detC = bakeField(N, 9, 3, 4421, 0.52, RIDGE_BILLOW);
  const gA = gradientOf(hA, N);
  const gB = gradientOf(hB, N);
  const gC = gradientOf(blurPeriodic(hC, N, Math.max(2, Math.round(N / 24))), N);

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
    texC: mk(hC, gC, detC),
    gradScale: [gA.scale, gB.scale, gC.scale],
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
/* The SUN-SIDE horizon band only. uHaze is isotropic: at day it has to stay a
 * cool pale blue or it warms the entire 360 deg horizon ring, which is what
 * turned the late-afternoon frame into an acid-yellow band all the way round.
 * The golden-hour warmth belongs to the sun's own azimuth, so it is carried by
 * this second colour weighted by pow(dot(viewAz, sunAz), 2.2). */
uniform vec3  uHazeWarm;
/* Gain on that additive sun-side band. A uniform, not a constant, because it is
   the single term that decides whether the sun-side horizon at dusk reads as a
   glowing haze or as a blown cream plate with no hills in it — and that has to
   be MEASURED in the graded frame (sky-hw* scenarios), not guessed. */
uniform float uHazeWarmK;
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
/* ---- NaN/Inf guard ------------------------------------------------------
   clamp() does NOT remove NaN: clamp(NaN, 0, x) is implementation-defined and
   on ANGLE/Metal it propagates. A single non-finite sample from the cloud
   accumulator or a degenerate normalize() therefore survived the whole chain to
   be crushed to pure black by the grade's power law — the sparse black speckle
   field measured over the day sky (darkFrac 0.12 against 0.50 surrounding, and
   it vanished under postfx-no-curve, which is what identified it).
   NaN fails every comparison, so !(x >= 0.0) is a portable finite test.
   (No backticks in here — this GLSL lives inside a JS template literal.) */
vec3 skySanitize(vec3 c){
  bvec3 bad = bvec3(!(c.r >= 0.0), !(c.g >= 0.0), !(c.b >= 0.0));
  if (any(bad)) {
    // rebuild from whatever channels are finite; if none are, use a pale sky blue
    float n = 0.0, acc = 0.0;
    if (!bad.r) { acc += c.r; n += 1.0; }
    if (!bad.g) { acc += c.g; n += 1.0; }
    if (!bad.b) { acc += c.b; n += 1.0; }
    vec3 fb = n > 0.0 ? vec3(acc / n) : vec3(0.42, 0.52, 0.68);
    c = vec3(bad.r ? fb.r : c.r, bad.g ? fb.g : c.g, bad.b ? fb.b : c.b);
  }
  return clamp(c, vec3(0.0), vec3(90.0));
}

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
  c += uHazeWarm * hb * azi * uHazeAmt * uHazeWarmK;
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
  /* Both scatter lobes are re-weighted so their HIGH-SUN contribution is ~60 %
   * lower while their low-sun contribution is unchanged to within 0.5 %.
   * MEASURED: at the default anchor the sun sits at 39 deg, where lowSun = 0, and
   * the old constant terms (0.30 of the Mie lobe + 0.35 of the wide pow-4 lobe +
   * the sun veil) were laying ~0.10 linear of warm light across the whole upper
   * sky — enough to take a #7095D4 gradient to #B9BECE, i.e. to erase the blue.
   * A 39 deg sun has almost no forward-scatter path length; the wide warm lobes
   * belong to a sun near the horizon, and that is now what gates them. */
  float lw = pow(lowSun, 0.85);
  c += uGlowTint * hg * 0.055 * uMieAmt * (0.12 + 4.38 * lw)
       * (0.32 + 0.68 * min(am, 7.0) / 7.0) * sunUp;
  c += uGlowTint * pow(max(cosT, 0.0), 4.0) * 0.17 * (0.13 + 2.33 * lw) * sunUp;
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
uniform sampler2D uNoiseC;
uniform vec3  uGradScale;
uniform float uTime;

/* shared with 08-lighting when present, otherwise driven locally */
uniform vec3  uFogColor;
uniform vec3  uMoonDir;
/* Where the moon DISC is drawn. 08-lighting derives its moon key direction as
 * the sun's exact antipode, which at night puts it at ~48 deg elevation — above
 * the top edge of every shipped camera preset (the hero frame only reaches 20
 * deg), so the disc was always rendered outside the frustum: a FULL MOON event
 * banner over an empty sky. 15-sky.js therefore compresses the elevation into a
 * visible band while keeping the azimuth exactly, and the shading key stays on
 * uMoonDir. See the note on uMoonRender in 15-sky.js for why that trade is the
 * right one for a stylised frame. */
uniform vec3  uMoonRender;
uniform vec3  uShadowTint;

/* global wind field (src/lib/wind.js) */
uniform vec2  uWindDir;
uniform float uWindTime;
uniform float uWindGust;

uniform float uGroundFade;
/* radians of screen subtended by ONE vertical pixel — 2*tan(fov/2)/height.
   Lets the cloud shader express its alpha feather in pixels without needing
   fwidth() downstream of a divergent early-return. */
uniform float uPxRad;

/* sun */
uniform vec3  uSunTint;
uniform float uSunSize;
uniform float uSunI;

/* clouds — one component per layer, x = lowest/nearest … w = cirrus */
uniform vec4  uCovL;      /* density threshold: higher = fewer, more separate masses */
uniform vec4  uScaleL;    /* angular scale of the mass field */
uniform vec4  uSpeedL;    /* drift speed along the shared wind direction */
uniform vec4  uKfL;       /* horizon floor of the cloud-plane projection */
uniform vec4  uPwL;       /* radial pow-compression: <1 keeps horizon masses round */
uniform vec4  uBumpL;     /* relief strength (how domed the masses read) */
uniform vec4  uWarpL;     /* domain warp */
uniform vec4  uDetL;      /* fine edge nibble */
uniform vec4  uStretchL;  /* uv stretch along the wind (cirrus streaks) */
uniform vec4  uAmtL;
uniform vec4  uZenCovL;   /* coverage threshold ADDED at high elevation (less cloud) */
uniform vec4  uZenAmtL;   /* opacity multiplier at high elevation */
uniform vec4  uAerL;      /* how far the deck melts into the haze with distance */
uniform vec4  uRimL;      /* silver-lining / translucency strength */
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
uniform float uMoonBright;
uniform float uMoonMaria;   /* how deep the maria go, as a fraction of highland */
uniform float uMoonHalo;
uniform float uDither;

/* ── night cloud deck ──────────────────────────────────────────────────────
 * MEASURED (shots/sky-r1-nightstars/hero.png, cloud masses x 1500-1700 y 120-230
 * against the clear night zenith at x 760-860 y 60-140): the deck came back at
 * display L 0.150 over a sky of 0.091, i.e. every mass was a pale blue amoeba
 * stain 1.65x BRIGHTER than the sky it hangs in, with a lit outline all the way
 * round. A night cumulus is the opposite: an OCCLUDER that swallows the stars
 * behind it and only catches light on the flanks that face the moon. These two
 * knobs converge the body of a night mass onto a fraction of its own background
 * and thin its opacity, while the silver-lining terms (gated on the moon's own
 * screen direction) still survive to draw the moonlit edge. */
uniform float uNightCloudV;   /* body value as a fraction of the sky behind it */
uniform float uNightCloudA;   /* opacity multiplier at full night */
uniform float uNightCloudR;   /* rim / transmission multiplier at full night */

/* Cloud value-range calibration. The deck's lit/shade spread is the one thing
 * that decides whether a mass reads as a MASS or as vapour, and it has to be
 * measurable in the graded frame rather than guessed at — hence two uniforms
 * that the sky-cloud-* scenarios sweep. */
uniform float uCloudLitK;     /* gain on the lit-top ramp */
uniform float uCloudShadeK;   /* how far the shadow side falls below the lit side */
uniform float uCloudCoreK;    /* how dark an optically thick backlit core stays */
/* how far BELOW the transmission floor a flank turned away from the key sits.
   1.0 = the old behaviour (a flat floor, i.e. no interior); see the block
   comment at 'formK'. Swept by the sky-cloud-form* scenarios. */
uniform float uCloudFormK;

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

/* ---------------------------------------------------------------- clouds --
 *
 * Painted anime cumulus. Two things make or break this and both are about
 * SHAPE, not detail budget:
 *
 * 1. THE PROJECTION. A straight slab intersection compresses the deck by
 *    1/sin(elevation) toward the horizon. The hero frame only shows elevations
 *    0-20 degrees, so every mass in it was being squashed 15-25x vertically —
 *    which is precisely how readable cumulus turn into horizontal filament
 *    smears. Here the plane radius r = cos(e)/(y+kf) is bounded (no infinite
 *    ray, so no grazing-limit ring) and then pow-compressed, r' = R0*(r/R0)^pw
 *    with pw ~0.55. That restores vertical extent exactly where we look, so a
 *    mass keeps a convex top and a flat base — how a painted backdrop draws it.
 *
 * 2. THE SHADING FRAME. The old code lit a heightfield whose normal pointed at
 *    world +Y, i.e. it shaded the deck as a floor seen from below: no matter
 *    how much contrast you gave it, it could not produce a lit top over a
 *    shadowed underside. This shades a 2.5-D RELIEF in the SCREEN frame
 *    (right, up, toward-viewer) with the sun projected into the same frame, so
 *    tops catch the light, undersides fall into the hue-shifted shadow tint,
 *    and the sun-facing edge gets a silver lining wherever the sun happens to
 *    be — including directly behind the deck, which is the money-shot config.
 */
vec4 cloudLayer(vec3 d, float kf, float scl, float spd, float cov, float pw,
                float bump, float warpAmt, float detAmt, float stretch,
                float amt, float zenCov, float zenAmt, float aer, float rimA,
                vec3 sunD, vec3 skyC) {
  /* ── high-sky coverage budget ─────────────────────────────────────────
   * The upper sky is the largest single region of the frame and it must stay
   * SKY (ART_BIBLE §8.2). Above ~30° the coverage threshold is raised and the
   * layer's opacity scaled down — but only enough to keep the zenith blue
   * owning the top: the old 0.24 / 0.30 budget deleted the cumulus decks from
   * everything above 27° and left nothing but wisps, which is half of why the
   * day sky read as filaments. */
  float hi = smoothstep(0.30, 0.62, d.y);      /* 0 below 17°, 1 above 38° */
  cov += zenCov * hi;
  amt *= mix(1.0, zenAmt, hi);
  /* at night the deck thins to a veil (see uNightCloudA) */
  float nightA = SAT(uStars);
  amt *= mix(1.0, uNightCloudA, nightA);
  rimA *= mix(1.0, uNightCloudR, nightA);
  if (d.y < 0.003 || cov > 0.995 || amt < 0.003) return vec4(0.0);

  /* ── cloud-plane projection, radially de-compressed ─────────────────── */
  float y  = max(d.y, 0.004);
  float ss = sqrt(max(1.0 - y * y, 1e-4));         /* cos(elevation) = |d.xz| */
  /* AT THE ZENITH d.xz is exactly zero, and a normalize() of it downstream
     produced NaN — which the bloom mip chain then smeared into a black speckled
     hole across the whole upper canopy frame. An explicit fallback azimuth is
     the fix; the pole is a coordinate singularity, not a real one. */
  vec2  Ph = (ss > 1e-3) ? d.xz / ss : vec2(1.0, 0.0);
  vec2  Rt = vec2(Ph.y, -Ph.x);                    /* screen-right, in world xz */

  float r    = ss / (y + kf);                      /* bounded by 1/kf: no ring */
  float R0   = 1.0 / (0.55 + kf);
  float rp   = R0 * pow(max(r, 1e-4) / R0, pw);
  float rpMx = R0 * pow((1.0 / kf) / R0, pw);
  float tN   = clamp(rp / rpMx, 0.0, 1.0);         /* 0 = zenith … 1 = horizon */

  /* the last degree or so dissolves, so the deck never terminates on an edge */
  float slabFade = smoothstep(0.004, 0.038, d.y);
  if (slabFade <= 0.002) return vec4(0.0);

  /* d(uv)/d(screen radian). The mapping is anisotropic near the horizon and
     feeding that in is what keeps a squashed mass reading as a squashed MASS
     (steeper shading) instead of as a flat smear.
     Hoisted above the alpha test on purpose: the ALPHA EDGE needs a screen-space
     width too (see awP below), and deriving it analytically from these two
     coefficients is exact, whereas fwidth() here would sit downstream of three
     divergent early-returns. */
  float drdy = -(y / (ss * (y + kf)) + ss / ((y + kf) * (y + kf)));   /* < 0 */
  float dpdr = pw * pow(max(r, 1e-4) / R0, pw - 1.0);
  float cU = scl * abs(drdy * dpdr) * ss;      /* uv per radian of screen-up */
  float cR = scl * rp / max(ss, 0.10);         /* uv per radian of screen-right */
  /* uv travelled per SCREEN PIXEL, isotropic mean */
  float uvPx = sqrt(max(cU * cR, 1e-9)) * uPxRad;

  /* rotate into the wind frame: drift is then a pure scroll along +x, so every
     layer travels along the ONE shared wind direction (ART_BIBLE §6) */
  vec2 wd = uWindDir;
  vec2 wp = vec2(-wd.y, wd.x);
  vec2 P  = Ph * rp;
  vec2 W  = vec2(dot(P, wd), dot(P, wp)) * scl;
  vec2 Q  = vec2(W.x / stretch, W.y * stretch)
          - vec2(uWindTime * spd, uWindTime * spd * 0.06);

  /* domain warp — kills the "noise texture" look, bends the mass boundaries */
  vec2 wv = vec2(texture2D(uNoiseA, Q * 0.23 + 0.13).a,
                 texture2D(uNoiseC, Q * 0.19 + 0.61).a) - 0.5;
  Q += wv * warpAmt;

  vec4  Cf  = texture2D(uNoiseC, Q);
  float det = texture2D(uNoiseC, Q * 3.7 + vec2(2.9, 5.3)).a;
  float H   = Cf.r + (det - 0.5) * detAmt;

  /* Coverage measured as a normalised depth INTO the mass, so the same edge
     width in dens units gives the same crisp anime edge at every threshold,
     and the cores always reach full opacity instead of staying as haze. */
  float inv   = 1.0 / max(1.0 - cov, 1e-3);
  float dens  = (H - cov) * inv;
  float aw    = 0.065 * inv;
  /* ── screen-space floor on the edge width ──────────────────────────────
   * 0.065 in dens units is a fixed slice of the noise field, and where that
   * field is steep on screen — which is most of the deck, since a mass spans
   * only 0.1-0.2 rad — the ramp lands on well under one pixel. A sub-pixel
   * alpha ramp is a stencil cut, and that is exactly the hard curdled outline
   * the round-2 critic read as an oil slick. dens changes by (inv *
   * uGradScale.z * uvPx) per pixel, so 7 px of feather is that times 7. */
  float densPx = inv * uGradScale.z * uvPx;
  float awP   = max(aw, 7.0 * densPx);
  float alpha = smoothstep(0.0, awP, dens);
  if (alpha <= 0.004) return vec4(0.0);
  float thick = smoothstep(0.0, awP * 3.0, dens);

  /* ── relief gradient, expressed in the SCREEN frame ──────────────────── */
  vec2 gQ = (Cf.gb - 0.5) * 2.0 * uGradScale.z;
  vec2 gW = vec2(gQ.x / stretch, gQ.y * stretch);   /* undo the wind anisotropy */
  vec2 g  = wd * gW.x + wp * gW.y;                  /* back into world xz */

  float gU = -dot(g, Ph) * cU;                 /* up on screen = inward in r */
  float gR =  dot(g, Rt) * cR;

  /* NORMALISE the slope by the local characteristic one. dH/d(screen radian) is
     inherently huge — a mass 0.15 rad wide with unit amplitude has slope ~7 —
     so feeding it in raw saturates every relief normal sideways and the deck
     comes back as flat white stencil shapes with no interior at all. Dividing
     by uGradScale.z * sqrt(cU*cR) makes the relief SCALE-INVARIANT while the
     cU/cR ratio keeps the near-horizon anisotropy, so a squashed mass still
     shades like a squashed mass. */
  float sNorm = max(uGradScale.z * sqrt(max(cU * cR, 1e-6)), 1e-4);
  vec2 gs = vec2(gR, gU) * (bump / sNorm);
  gs /= 1.0 + 0.30 * length(gs);               /* soft saturate: no spikes */
  /* A cumulus is a VOLUME, not a bas-relief. A pure screen-space relief normal
     points at the VIEWER, so with the key behind the deck — Lr.z ≈ -0.87 in the
     shipped hero and canopy framings — every lobe on it comes out dark: measured
     hl ≈ 0.19 across the entire deck, which is why the sky read as slate-blue
     blotches with fuzzy white outlines. Biasing the normal toward world-up and
     easing off the front-facing component models the real shape: the mass
     presents a sunlit crown upward and a flat base downward. Toward the zenith
     we are looking at that base head-on, so the up-bias eases off. */
  float upB = mix(0.88, 0.18, smoothstep(0.35, 0.85, d.y));
  /* ── why the toward-viewer component has to SHRINK with elevation ────────
   * MEASURED (shots/sky-r2-day/canopy.png, upper sky x 1000-1900 y 0-500): the
   * high-sky decks came back as flat pale stains with no interior at all, and
   * the cause is here rather than in any colour. With a fixed +0.55 on the
   * toward-viewer axis and upB easing off to 0.18 near the zenith, BOTH of the
   * terms that vary across a mass (gs.x, gs.y) are small next to a constant, so
   * hl is very nearly the same number over the whole mass — the shading ramp,
   * the self-shadow and the three tone bands all collapse onto one value. Easing
   * nz down and lifting the relief gain over the same range lets the lobes drive
   * the normal again, which is what puts a bright crown and a shaded flank on a
   * mass seen from below. */
  float hiRel = smoothstep(0.35, 0.85, d.y);
  float nz = mix(0.55, 0.26, hiRel);
  gs *= mix(1.0, 1.45, hiRel);
  vec3 Nr = normalize(vec3(-gs.x, -gs.y + upB, nz));

  /* the sun in the same frame; Lr.z < 0 means the deck is backlit */
  vec3 R3 = vec3(Rt.x, 0.0, Rt.y);
  vec3 U3 = normalize(cross(d, R3));
  vec3 Lr = vec3(dot(sunD, R3), dot(sunD, U3), dot(sunD, -d));
  vec2 sScr = normalize(Lr.xy + vec2(1e-4, 1e-4));

  float hl = dot(Nr, normalize(Lr + vec3(1e-5))) * 0.5 + 0.5;
  /* three readable tone bands rather than a smooth gradient (§2) */
  /* Bands shifted down the range: a backlit deck only spans hl ≈ 0.25-0.55, so
     thresholds authored for a 0-1 span put the whole sky in the first band. */
  float band = smoothstep(0.18, 0.38, hl) * 0.30
             + smoothstep(0.34, 0.56, hl) * 0.36
             + smoothstep(0.52, 0.84, hl) * 0.34;

  /* Self-shadow: three taps marching along the sun's SCREEN direction, so a
     lobe throws its shadow across the lobes behind it the way a painter draws
     it. The step stays a small fraction of the feature size — a longer march
     samples uncorrelated noise and shreds the mass into fibres. */
  vec2 dqw = Rt * (cR * sScr.x) - Ph * (cU * sScr.y);
  vec2 sQ  = vec2(dot(dqw, wd) / stretch, dot(dqw, wp) * stretch);
  sQ = normalize(sQ + vec2(1e-5, 1e-5)) * 0.024;
  float occ = texture2D(uNoiseC, Q + sQ * 1.0).r * 0.42
            + texture2D(uNoiseC, Q + sQ * 2.2).r * 0.34
            + texture2D(uNoiseC, Q + sQ * 3.8).r * 0.24;
  float shadow = 1.0 - smoothstep(cov + 0.008, cov + 0.17, occ) * 0.58;

  /* surfaces that face DOWN are the flat shadowed base of the mass — this is
     the term the old world-Y heightfield normal could never produce. Faded out
     toward the zenith: straight overhead there is no "down" on screen, so the
     term would just darken random halves of the deck. */
  float down = SAT(gs.y * 0.85) * mix(1.0, 0.40, smoothstep(0.42, 0.86, d.y));

  /* ── TRANSMISSION (ART_BIBLE §2) ──────────────────────────────────────
   * The shipped hero/canopy framings put the key BEHIND the cloud deck: the
   * visible masses sit 20-30° below a 38° sun, so Lr.z ≈ -0.87 and a purely
   * reflective model puts every one of them at the bottom of the ramp — the
   * deck came back as dark slate smudges on a pale sky, i.e. depth inverted.
   * A backlit cumulus is LUMINOUS: light scatters through the whole mass, not
   * just its rim, so transmission lifts the body of the cloud and only the
   * thickest cores stay dark. Wide lobe (pow 2) on purpose — a tight one only
   * lights the few degrees around the sun. */
  float muS   = max(dot(d, sunD), 0.0);
  float back  = SAT(-Lr.z * 0.85 + 0.15);
  float trans = back * (0.30 + 0.70 * pow(muS, 2.0));
  trans *= mix(1.0, uNightCloudR, nightA);

  /* Per-mass value variation. Without it every mass in the deck lands on the
     same value and the whole sky reads as one paint colour; two masses side by
     side must not be the same white (§8.11). */
  float mv = texture2D(uNoiseA, Q * 0.115 + vec2(0.71, 0.29)).r;

  float lit = SAT(0.10 + band * 0.72 * uCloudLitK + shadow * 0.18) * mix(1.0, 0.56, down * 0.85);
  lit *= mix(0.86, 1.05, mv);
  /* Transmission floors the value, but STEEPLY graded by thickness — that
     gradient IS the backlit look: a thin edge transmits almost everything and
     goes brighter than a sunlit top, while the core of the mass blocks the light
     and stays a deep cool violet. A flat floor (measured at 0.50-0.96 across the
     whole mass) lifts the deck into one pale wash with no interior at all. */
  /* The core floor is a VALUE-CONTRAST decision, not a physical one: low in the
     frame the sky is pale (#CFE0F2 haze) so a dark core reads as mass, but at the
     zenith the sky is a deep saturated blue and a dark core reads as a hole — up
     there the mass has to be the LIGHT shape, as every painted anime sky draws
     it. Measured: with a flat 0.26 floor the canopy deck sat within 0.03 of the
     zenith's own luminance, i.e. invisible. */
  float coreF = mix(0.21, 0.52, smoothstep(0.30, 0.70, d.y)) * uCloudCoreK;
  /* ── the floor must not be FLAT across the mass ────────────────────────
   * MEASURED (shots/sky-r0-dayraw/canopy.png, upper sky): with the floor a pure
   * function of thickness, and coreF deliberately high near the zenith (a dark
   * core up there reads as a hole), the floor came out at 0.75+ over almost the
   * whole mass — so 'band', 'shadow' and 'down' were all being max()-ed away and
   * every cumulus in the canopy frame rendered as ONE flat white amoeba with no
   * interior at all (ART_BIBLE §8.2, §8.11). Grading the floor by the same
   * relief band the reflective term uses keeps the mass a LIGHT shape while
   * restoring a readable value spread inside it: the crown facing the key stays
   * at the floor, the flanks turned away sit uCloudFormK below it. */
  float formK = mix(uCloudFormK, 1.0, band);
  lit = max(lit, trans * (coreF + (1.04 - coreF) * pow(1.0 - thick, 1.35)) * formK);
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
  vec3  shadeC = col * uCloudShadeK * stChroma;
  float litMask = SAT(band * 1.35 + shadow * 0.40 - 0.32 - down * 0.55);
  /* a backlit mass is not "in shadow" — but its core still is, and the flanks
     turned away from the key keep a share of the shadow tint (same formK as the
     value floor above: without it the tint was max()'d away everywhere the
     transmission floor bit, i.e. over the entire upper-sky deck) */
  litMask = max(litMask, trans * (0.32 + 0.68 * (1.0 - thick)) * formK);
  col = mix(shadeC, col, litMask);

  /* ── night: the deck is an OCCLUDER ──────────────────────────────────
   * Converge the body of the mass onto a fraction of the sky radiance behind
   * it, so a night cumulus swallows the star field instead of glowing over it.
   * Deliberately BEFORE the silver-lining block: the rim terms below are gated
   * on the key's own screen direction (which at night is the drawn moon), so
   * the moon-facing flank still lights up while the body goes dark. */
  if (nightA > 0.002) {
    /* Even the THIN parts land a few percent under the sky, not on it: an
       occluder that exactly matches its background still has to dim the stars
       it covers, and MEASURED, a veil sitting at 1.00x the sky pushed the clear
       night zenith from L 0.099 to 0.111 once the high-sky opacity budget was
       relaxed (its edge rim rides on top of the sky value). */
    col = mix(col, skyC * mix(0.90, uNightCloudV, SAT(thick * 1.6)), nightA * 0.90);
  }

  /* ── low-sun relight (ART_BIBLE §2) ───────────────────────────────────
   * MEASURED on critic-p4-r2-dusk/canopy.png, cloud mass x 900-1250 y 120-330:
   * the deck came back DARKER than the sky behind it on every row (L 0.14-0.24
   * against a 0.16-0.28 gradient) with no warm edge anywhere — an oil slick in
   * front of a sunset. Two terms were missing, and both only exist when the key
   * is near the horizon, so day and night are untouched by construction
   * (lowK = 0 above ~22 deg of sun elevation and 0 when the sun is down).
   *
   * 1. A cloud is a SCATTERER lit by the whole sky dome. Its shadow side cannot
   *    fall far below the radiance of the sky it is silhouetted against; only
   *    optically thick cores can. Lift toward skyC up to 0.92 of the sky.
   * 2. A raking key lights the flanks that face it ON SCREEN — including the
   *    undersides, which is where a sunset actually puts its gold. */
  float sunUpC = smoothstep(-0.14, 0.05, sunD.y);
  float lowK   = pow(1.0 - SAT(sunD.y * 2.6), 2.0) * sunUpC;
  if (lowK > 0.002) {
    float lsky = skyLuma(skyC);
    float lcol = skyLuma(col);
    col += skyC * max(lsky * 0.92 - lcol, 0.0) * lowK * (0.35 + 0.65 * (1.0 - thick));
    vec2  eNr  = -normalize(gs + vec2(1e-5, 1e-5));
    float rake = pow(SAT(dot(eNr, sScr) * 0.5 + 0.5), 1.5);
    col += uCloudRim * lowK * rake * (0.10 + 0.40 * (1.0 - thick * 0.7))
         * rimA * uCloudRimAmt;
  }

  /* ── silver lining + translucency ─────────────────────────────────────
   * Only the edges that FACE the sun on screen get the silver rim; a rim on
   * every edge is a traced outline, which is the cheap-looking version. */
  float fwd = pow(muS, 12.0);
  vec2  en  = -normalize(gs + vec2(1e-5, 1e-5));      /* outward edge normal */
  float sunEdge = pow(SAT(dot(en, sScr) * 0.5 + 0.5), 1.7);
  float edge = smoothstep(0.03, 0.42, alpha) * (1.0 - smoothstep(0.42, 0.96, alpha));
  /* the 0.85*lowK term is the golden-hour silver lining: with the key raking the
     deck, the sun-facing boundary of every mass has to out-read the sky behind
     it (target: >= 1.35x the adjacent sky luminance), not merely tint it */
  col += uCloudRim * edge * (0.20 + 0.85 * lowK + 1.25 * fwd) * sunEdge * rimA * uCloudRimAmt;
  /* light bleeding through the thin parts of a backlit mass */
  col += uCloudRim * (1.0 - thick * 0.75) * trans * 0.20 * rimA * uCloudRimAmt;
  /* the deck immediately around the sun goes incandescent */
  col += uCloudRim * pow(muS, 40.0) * (1.0 - alpha * 0.75) * 0.65 * rimA * uCloudRimAmt;

  /* ── aerial perspective ───────────────────────────────────────────────
   * Distance melts the deck toward the sky it is silhouetted against (skyC
   * already carries the horizon haze band). The wash is deliberately MILD:
   * washing 86 % of every cloud into the sky is what left the deck at 0.010-
   * 0.035 luminance contrast, i.e. invisible. The last couple of degrees above
   * the horizon still wash out completely, so the deck sits IN the haze. */
  float far  = 1.0 - exp(-tN * 2.4);
  float wash = max(far * aer, smoothstep(0.075, 0.010, d.y) * 0.90);
  col = mix(col, skyC * 1.03 + uHaze * 0.04, SAT(wash));

  alpha *= slabFade * uCloudAmt * amt;
  /* Belt and braces against the NaN class of bug: a single poisoned pixel here
     is smeared across the frame by the bloom mip chain. NaN fails equality with
     itself, so this catches anything the guards above missed. */
  if (!all(equal(col, col)) || !(alpha == alpha)) return vec4(0.0);
  return vec4(max(col, vec3(0.0)), SAT(alpha));
}

/* ----------------------------------------------------------------- stars -- */
/*
 * One hashed point per cubic cell of the direction vector.  The dot must stay
 * FAR smaller than the cell (rad ~ 0.3 of a cell) and its falloff must be a
 * tight gaussian — a broad tail fills each cell and the whole field turns into
 * a visible lattice of square blobs.  It also means a star can never be bigger
 * than its own cell, so DENSITY and SIZE are coupled: a 620-cell grid gives
 * sub-pixel stars that TAA averages straight back into the background. That is
 * why the three layers below all sit within 140-168 cells (8.8-12.3 px cells at
 * the shipped fovs) and get their density from the THRESHOLD instead, with a
 * per-layer rotation so three near-equal lattices cannot align into a visible
 * grid.
 */
/*
 * Magnitude, authored as PEAK LINEAR RADIANCE so the distribution survives ACES
 * + the grade rather than being specified in a space the pipeline then crushes:
 *   5 %  bright  2.10-3.60  -> display L ~0.85
 *  25 %  medium  0.55-1.15  -> display L ~0.45
 *  70 %  faint   0.10-0.36  -> display L 0.15-0.28
 * MEASURED before this change: the whole field peaked at display L 0.139 over a
 * pure-sky box of the night pond frame — i.e. 95 % of it sat below the
 * background's own dither and the sky read as empty navy (ART_BIBLE §8.11).
 */
float starMag(float r) {
  if (r > 0.95) return mix(2.10, 3.60, (r - 0.95) / 0.05);
  if (r > 0.70) return mix(0.55, 1.15, (r - 0.70) / 0.25);
  return mix(0.10, 0.36, r / 0.70);
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
  /* Tight core + a very small tail. The old 0.13*exp(-dd*dd*1.4) tail put 3 % of
     a bright star's energy out at a full cell radius, which at display L 0.9
     still reads as a 7 px blob — the prescription caps a star at 3 px. */
  float core = exp(-dd * dd * 6.5) + 0.07 * exp(-dd * dd * 2.2);
  float mag = starMag(hash11(id * 1.317 + 19.3));
  /* ±12 % over a per-star 3-6 s period. A deeper modulation (the old ±44 %
     around a 0.56 mean) both dims the field and reads as a pulse. */
  float per = 3.0 + h.z * 3.0;
  float tw = 1.0 + 0.12 * sin(uTime * 6.2831853 / per + h.y * 47.0);
  /* colour temperature spread: most white, a few warm, a few blue */
  vec3 tint = mix(vec3(1.05, 0.84, 0.66), vec3(0.70, 0.84, 1.14), smoothstep(0.30, 0.75, h.x));
  tint = mix(vec3(1.0), tint, 0.8);
  return tint * (core * mag * tw);
}

/* Two fixed rotations, so the three star lattices are neither the same scale nor
   the same orientation. Rotations preserve |d| = 1, so the cell metric is
   unchanged. */
vec3 starRotA(vec3 d) { return vec3(d.x * 0.80 - d.z * 0.60, d.y, d.x * 0.60 + d.z * 0.80); }
vec3 starRotB(vec3 d) { return vec3(d.x, d.y * 0.75 - d.z * 0.66, d.y * 0.66 + d.z * 0.75); }

void main() {
  vec3 d = normalize(vDir);
  vec3 sunD = normalize(uSunDir);
  vec3 moonD = nrmSafe(uMoonRender, nrmSafe(uMoonDir, vec3(0.0, 1.0, 0.0)));

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
    /* Steeper than the old pow(x*1.55, 1.5), PLUS a separate knot term.
       MEASURED (round-2 critic, and again on shots/sky-r0-nightm/hero.png): the
       band came back as "soft grey cloud smudges" because its own structure was
       a single smooth lump — a galaxy is bright STAR CLOUDS separated by dark
       dust, so the contrast inside the band has to be higher than the contrast
       between the band and the sky. The knot term adds a few bright cores
       without lifting the mean (it is zero over ~70 % of the band). */
    clouds = pow(SAT(clouds * 1.62), 1.85) + 0.42 * pow(SAT(o2 * 1.20 - 0.42), 2.6);

    /* A WIDE gaussian band mask — nothing here has an edge — plus a narrow
       dark rift down the centre (the Great Rift) so the band is not a bar, and
       a second wandering dust lane off-centre: one perfectly central rift reads
       as a seam in a texture, two asymmetric ones read as dust. */
    float wide  = exp(-b * b * 24.0);
    float bandE = exp(-b * b * 34.0);
    float rift  = 1.0 - 0.46 * exp(-b * b * 700.0);
    float bl    = (b - 0.088 - 0.030 * (o1 - 0.5)) / 0.026;
    rift *= 1.0 - 0.30 * exp(-bl * bl);
    float dust  = snoise(mp * 4.10 + vec3(77.0, 13.0, 29.0)) * 0.5 + 0.5;
    float mw = wide * rift * clouds * (0.60 + 0.80 * (1.0 - dust));
    mw *= smoothstep(-0.05, 0.24, d.y);
    col += mix(vec3(0.72, 0.78, 1.0), vec3(1.0, 0.93, 0.84), 0.22 + 0.40 * o1)
         * mw * uMilky * uStars;

    /* Stars. Density is deliberately NOT starved toward the horizon — an empty
       lower sky is the classic tell. Extinction dims, it does not thin.
       Three near-equal grids (10.5 / 9.7 / 8.8 px cells at fov 36-42) each
       rotated onto a different axis; the thresholds put ~55 000 stars on the
       full sphere, which is ~1000 inside the sky region of the night pond frame
       — the prescription's 900-1400 band. */
    float dens = 1.0 + 1.6 * bandE;
    vec3 st = starLayer(d,             140.0, 0.075 * dens, 0.30, 0.0)
            + starLayer(starRotA(d),   152.0, 0.065 * dens, 0.30, 31.7)
            + starLayer(starRotB(d),   168.0, 0.050 * dens, 0.29, 77.3);
    /* The band itself is millions of unresolved stars: a very dense, very faint
       layer confined to it supplies the grain that makes it read as a star
       field rather than as a smear of fog. Denser than before (0.055 -> 0.10 of
       cells occupied): at 0.055 the grain was below the sky's own dither over
       most of the band, which is why the band still read as fog. */
    st += starLayer(d, 420.0, 0.100 * bandE, 0.26, 133.0) * 0.38 * bandE;
    /* ── extinction toward the horizon ─────────────────────────────────────
     * Air DIMS and REDDENS; it does not thin the field (a lower sky with fewer
     * stars is the classic procedural tell, so the density is deliberately
     * unchanged). The warm tint is the same physics as a red moon on the
     * horizon and it is what makes the low sky read as air rather than as a
     * uniform fade to black. */
    float ext = smoothstep(-0.006, 0.050, d.y) * mix(0.55, 1.0, smoothstep(0.0, 0.50, d.y));
    vec3 extTint = mix(vec3(1.10, 0.84, 0.62), vec3(1.0), smoothstep(0.015, 0.28, d.y));
    col += st * ext * extTint * uStars;

    /* ---- moon ----
     * It has to read as a BODY, not a lens flare. Three things do that and the
     * old code had none of them: a step-edged limb (the 0.93→1.05 * R window was
     * 3.6 px of gradient, and with a broad halo on top of it there was no edge
     * left to see), a nearly-flat full disc (the old Lambert terminator cut the
     * disc in half while the HUD announced FULL MOON), and a halo confined to a
     * few radii instead of the old exp(-ang*7.5), which was still at 1/e SEVEN
     * disc-radii out and is what made it a smear. */
    float cm = dot(d, moonD);
    float ang = acos(clamp(cm, -1.0, 1.0));
    vec3 T = nrmSafe(cross(moonD, refAxis(moonD)), vec3(1.0, 0.0, 0.0));
    vec3 Bv = cross(T, moonD);
    vec2 mUV = vec2(dot(d, T), dot(d, Bv)) / uMoonSize;
    float r2 = dot(mUV, mUV);
    /* maria: broad dark plains, deliberately low frequency so the LIMB stays the
       strongest edge on the disc. Target display L: 0.93 highland / 0.86 mare. */
    /* MEASURED before this change (shots/sky-r1-nightstars/hero.png, disc at
       1222,232): the highland came back at display L 0.964 and the maria at
       0.964 as well — a peak of 3.3 linear is so far up the ACES shoulder that a
       0.62 multiplier on it is worth 0.00 display luminance, so the disc was a
       flat white ball and every scrap of surface detail authored here was being
       compressed away. The disc's PEAK is therefore authored at the value where
       the shoulder still has slope (see uMoonBright), and the maria depth is a
       uniform so it can be swept and landed on (sky-moon-m*). Target: highland
       display L 0.92-0.95, maria 0.80-0.86, i.e. a spread the eye can read as
       markings on a body. */
    float maria = texture2D(uNoiseB, mUV * 0.34 + 0.5).r * 0.46
                + texture2D(uNoiseA, mUV * 0.85 + 0.2).r * 0.34
                + texture2D(uNoiseB, mUV * 2.10 + 0.8).r * 0.20;
    float mv = mix(1.0, uMoonMaria, smoothstep(0.30, 0.72, maria));
    /* a sparse crater speckle on the highlands only — breaks the "airbrushed
       ball" read at the 26-30 px the disc actually occupies */
    float crat = texture2D(uNoiseB, mUV * 4.30 + 0.31).a;
    mv *= 1.0 - smoothstep(0.68, 0.94, crat) * 0.13;
    /* a step limb: ~1.3 px of gradient, just enough that it does not alias */
    float disc = 1.0 - smoothstep(uMoonSize * 0.975, uMoonSize * 1.020, ang);
    /* very slight limb darkening — a full moon is nearly flat, and a strong
       falloff here is what reads as a soft ball of light */
    vec3 mc = uMoonCol * uMoonBright * mv * mix(1.0, 0.88, SAT(r2 * r2));
    col = mix(col, mc, disc * uStars);
    /* Mie halo: 1/e at 0.75 R, 0.018 of peak by 3 R — present, never a flare.
       A second, far wider and far fainter lobe reads as the moon lighting the
       air itself: it lifts the sky over ~8 disc radii by <0.02 linear, which is
       what stops the disc from looking pasted onto the gradient. */
    /* MEASURED: the wide lobe at 0.022 lifted the clear night zenith 400 px away
       from display L 0.094 to 0.112, i.e. it was pushing the ART_BIBLE 3 night
       row (#101A34, L 0.10) off its value — the one number this frame is already
       dead on. 0.011 keeps the "the moon is lighting the air" read at a tenth of
       that cost (measured back at 0.099). The near lobe is also trimmed: a wide
       bright skirt is the bloom pass's seed, and a fat seed is what dissolved the
       limb into a gradient. */
    /* MEASURED AGAIN (shots/_c_moon.png vs shots/_c_moonraw.png at 3x): with the
       post chain ON the limb dissolved into a 6-8 px gradient and the moon read
       as a ball of fog, while the SAME frame at postfx-off had a crisp limb and
       visible maria. Two things do that — bloom seeds from the bright skirt
       sitting right at the limb, and the DOF far band puts 5 px of CoC on
       anything at infinity — and neither is mine to switch off. What IS mine:
       (a) shrink the near skirt so bloom has far less to smear (0.105 -> 0.052)
       and push its 1/e out from 0.75 R to 1.10 R so what remains is a glow
       around the disc rather than a bright ring welded to its edge, and
       (b) grow the disc (uMoonSize) so a fixed 5 px of blur is a smaller
       fraction of the radius. */
    float halo = exp(-ang / max(uMoonSize * 1.10, 1e-4)) * 0.052
               + exp(-ang / max(uMoonSize * 6.0, 1e-4)) * 0.011;
    col += uMoonCol * halo * uMoonHalo * uStars;
  }

  /* ---- sun: Mie forward scatter, then the disc ---- */
  float sunUp = smoothstep(-0.12, 0.04, sunD.y);
  float lowSun = pow(1.0 - SAT(sunD.y * 1.85), 2.4);
  float cosT = dot(d, sunD);
  float gg = uMieG;
  float hg = (1.0 - gg * gg) / pow(max(1.0 + gg * gg - 2.0 * gg * cosT, 1e-4), 1.5);
  /* Same re-weighting as skyRadiance() — the two MUST agree term for term or a
     hazed ridge stops matching the sky it is silhouetted against. */
  float lw = pow(lowSun, 0.85);
  float mie = hg * 0.055 * uMieAmt * (0.12 + 4.38 * lw) * (0.32 + 0.68 * min(am, 7.0) / 7.0);
  col += uGlowTint * mie * sunUp;
  col += uGlowTint * pow(max(cosT, 0.0), 4.0) * 0.17 * (0.13 + 2.33 * lw) * sunUp;

  /* ── the sun itself ───────────────────────────────────────────────────
   * This is the money shot's backdrop: the hero/canopy framings put the key
   * BEHIND the tree, so the disc sits near or just inside the frustum and it
   * has to read as a glowing orb sitting in air rather than as a clipped white
   * hole. Three nested falloffs do that: a soft-limbed disc, a tight aureole
   * roughly two disc-radii wide, and a broad veil ~10 radii out. A single hard
   * disc + one exponential is what produces the flat white blob ART_BIBLE §8.12
   * calls out, and it is also what the god-ray pass in 90-postfx.js seeds from,
   * so the graded falloff feeds it a graded source.
   *
   * MEASURED: an aureole of 0.27*uSunI over 2.2 disc radii plus a veil of
   * 0.075*uSunI over 10 radii puts 1.3-4.6 linear units of light across a 20°
   * disc of sky whose own radiance is 0.2-0.5 — i.e. it white-outs a fifth of
   * the canopy frame and (at the ultra tier) drove the post chain into a black
   * speckled hole. The energies below are ~4x lower: the disc stays a hot core
   * for bloom and the god-ray pass to seed from, the aureole reads as a warm
   * halo out to ~4°, and the veil only LIFTS the sky (≈+0.2 at 5°, +0.09 at 15°)
   * instead of replacing it. */
  float ang = acos(clamp(cosT, -1.0, 1.0));
  float R = max(uSunSize, 1e-4);
  float core = 1.0 - smoothstep(R * 0.74, R * 1.20, ang);
  float aur  = exp(-ang / (R * 2.6)) * 0.085;
  /* ~10 sun-radii of veil is a low-sun phenomenon too: with the sun at 39 deg it
     was adding 0.05 linear right across the top of the hero frame. */
  /* ── why the veil is a SUPER-EXPONENTIAL now ────────────────────────────
   * MEASURED by A/B on the dusk hero (shots/r3-dusk vs r3-sky-sun-off, sun-side
   * sky box x 1700-1850 y 400-420): the sun-side sky sat at display L 0.936 with
   * all three hill bands at 0.933-0.936 — a cream plate with the depth ordering
   * gone. Attribution: killing uSunI drops that box by 0.249, scaling Mie to 60 %
   * drops it by 0.028, and cutting the warm horizon band nearly in half drops it
   * by 0.001. So it is this veil — the widest, flattest term the sun has — and at
   * dusk (R = 0.029 rad) a plain exp(-ang/11R) is still at 1/6 of peak TWENTY
   * disc-radii out. A super-exponential veil, exp(-pow(ang/9R, 1.35)), was tried
   * to cut that far tail — and MEASURED as a NO-OP: every sample in the dusk hero
   * frame moved by <= 0.005 display luma (shots r3-dusk vs r4-dusk), because the
   * bright sun-side region is only ~5-10 R from the disc, where the two profiles
   * agree by construction. So the sun-side brightness at dusk is the AUREOLE next
   * to an off-frame low sun, which is the money shot's backdrop and is meant to be
   * there; the veil is left exactly as it was rather than shipping an unmeasurable
   * reduction of the one term the brief asks to keep glorious. The hills on the
   * sun side do vanish into it — that is what looking into a 15 deg sun does — and
   * the ranges away from the sun still measure a clean 0.861 sky / 0.556 near-band
   * separation in the same frame. */
  float veilS = exp(-ang / (R * 11.0)) * 0.018 * (0.42 + 0.58 * sqrt(lowSun));
  /* the core desaturates toward white, the aureole keeps the palette's sun hue —
     that hue break at the limb is what makes a low sun read as hot */
  col += mix(uSunTint, vec3(1.0), 0.30) * core * uSunI * 0.60 * sunUp;
  col += uSunTint * (aur + veilS) * uSunI * sunUp;

  /* ---- below the horizon fades to the aerial colour (hills cover it) ---- */
  col = mix(col, uFogColor * 0.92, smoothstep(0.0, -0.14, d.y) * uGroundFade);

  /* ---- clouds, composited front-to-back with early-out ----
   * The deck is lit by whichever body is actually up. At night uSunDir points
   * well below the horizon, so every cloud came back on the bottom of its ramp
   * with no lit tops, no rims and no self-shadow direction — the "flat navy field
   * with no cloud lighting" of ART_BIBLE §8.2. Blending the key toward the moon
   * (the drawn one, so the silver linings point at the disc the player can see)
   * gives the night deck the same three-band read the day deck has. */
  vec3 cloudKey = normalize(mix(sunD, moonD, smoothstep(0.12, 0.72, uStars)) + vec3(1e-5));
  vec3 skyC = skyGradient(d);
  vec3 cAcc = vec3(0.0);
  float aAcc = 0.0;
  vec4 L;
  #define CLOUD_LAYER(i) cloudLayer(d, uKfL.i, uScaleL.i, uSpeedL.i, uCovL.i, uPwL.i, \
      uBumpL.i, uWarpL.i, uDetL.i, uStretchL.i, uAmtL.i, uZenCovL.i, uZenAmtL.i, \
      uAerL.i, uRimL.i, cloudKey, skyC)
  L = CLOUD_LAYER(x);
  cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  if (aAcc < 0.985) {
    L = CLOUD_LAYER(y);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  if (aAcc < 0.985) {
    L = CLOUD_LAYER(z);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  if (aAcc < 0.985) {
    L = CLOUD_LAYER(w);
    cAcc += (1.0 - aAcc) * L.rgb * L.a; aAcc += (1.0 - aAcc) * L.a;
  }
  /* Ceiling on how much of the HIGH sky cloud may replace, so the saturated
     zenith blue always survives in the top third no matter how the noise field
     lands. 0.72 (not 0.55) and starting at 38°: a cumulus mass must be allowed
     to be a solid mass where we actually look. */
  float aCap = mix(1.0, 0.80, smoothstep(0.38, 0.66, d.y));
  if (aAcc > aCap) { cAcc *= aCap / max(aAcc, 1e-4); aAcc = aCap; }
  col = cAcc + col * (1.0 - aAcc);

  /* 8-bit gradients band horribly on a sky — dither below the quantisation step.
     Scaled with luminance so the night sky is not overwhelmed by grain. */
  float dn = hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  col += dn * uDither * (0.30 + 1.8 * col);

  gl_FragColor = vec4(skySanitize(col), 1.0);

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
uniform float uNightAer;   /* how far the night bands converge on the night sky */
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
  /* 0.86, not 0.96 and not 1.05: a mist deck at or above the sky's own value
     blows out into a near-white bar that competes with the hero subject and
     inverts the depth ordering against the band's own crest. */
  col = mix(col, skyRadiance(vWPos - uCamPos) * 0.78, SAT(mist * uMistAmt));

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

  /* Same ground-vs-sky dimming as the valley floor: a hazed LAND plane converges
     to a value below the sky's own, and the 0.88 is what keeps each band a
     readable step darker than the sky it is silhouetted against instead of all
     three melting into one milky plate. */
  col = mix(col, vec3(skyLuma(col)), SAT(f * 0.70));
  col = mix(col, skyRadiance(rd) * 0.88, f);

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
  /* ...and the crest lift itself has to fall off with distance. MEASURED (row
     means, shots/sky-r2-night/hero.png x 1450-1800): every band peaked ON ITS
     OWN CREST — 0.159 at y 395, 0.152 at y 475, 0.165 at y 520, with 0.129-0.138
     troughs between — so the night horizon read as a stack of bright wavy paper
     edges. A crest 400 m away sits behind four times the air of one at 120 m and
     cannot be as bright as it; crestK is that, reusing the same f the aerial
     term uses. */
  float crestK = 1.0 - 0.72 * SAT(f);
  float ramp = mix(0.74, 0.99, smoothstep(0.0, 0.60, vr))
             + smoothstep(0.60, 1.0, vr) * 0.13 * crestK;
  vec3 nightCol = uNightFog * ramp;
  nightCol *= mix(0.90, 1.16, SAT(band));                 /* keep the spurs */
  vec3 V = nrmSafeV(vWPos - uCamPos);
  float fwd = pow(max(dot(V, nrmSafeM(uMoonDir)), 0.0), 6.0);
  nightCol += uMoonGlow * fwd * 0.35;
  /* crest catches the moonlit sky directly */
  /* a WIDE crest glow, not the 2 px rim line -- a hairline outline reads as a
     traced silhouette rather than as a moonlit ridge */
  float crest = smoothstep(0.58, 1.0, vr);
  nightCol += uMoonGlow * crest * 0.15 * crestK * SAT(dot(N, nrmSafeM(uMoonDir)) + 0.35);
  /* the same 60 px base cross-fade, into the floor's own night value */
  vec3 floorNight = uNightFog * (0.78 + 0.34 * smoothstep(35.0, 250.0, dist)
                                 + 0.30 * smoothstep(95.0, 430.0, dist));
  nightCol = mix(floorNight, nightCol, baseFade);
  /* ── night bands must RECEDE too ───────────────────────────────────────
   * MEASURED (shots/sky-r1-night/hero.png, x 1500-1900): the three ranges came
   * back at display L 0.121 / 0.126 / 0.124 — the same value, in the same order
   * as nothing, with hard crest edges between them. The cause is that the whole
   * night branch is built from uNightFog * ramp(vUv.y), which has no distance
   * term at all: the day branch has both a per-band albedo VALUE and the
   * exponential aerial lift, and the night branch had neither. Reusing the SAME
   * f the day branch computes puts them back in order by construction — near
   * band f≈0.39, mid 0.65, far 0.83 — so the far range sits closer to the sky it
   * is silhouetted against and the layered-paper read goes away. Deliberately
   * NOT extra global haze (08-lighting is reducing that): this is the hills'
   * own colour converging on the night sky's own radiance. */
  nightCol = mix(nightCol, skyRadiance(rd) * 0.92, SAT(f * uNightAer));
  col = mix(col, nightCol, uNight * 0.88);

  gl_FragColor = vec4(skySanitize(col), 1.0);

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

  /* The strip of this disc visible between the playable terrain edge and the
     first hill band spans roughly 55–125 world units. MEASURED (hero, row means
     over x 1200-1900): that strip came back at 0.60 luminance while the nearest
     hill band BEHIND it sat at 0.42-0.45 and the grass in FRONT of it at 0.50 —
     a receding plane brighter than everything either side of it, which is the
     milky white-out that flattened the whole mid-distance. The old +22 % near
     lift was most of it. A slight DARKENING is the correct sign: this strip is
     nearer than the hill band, so it must read darker than it. */
  col *= mix(0.90, 1.0, smoothstep(40.0, 150.0, dist));

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
  /* Aerial perspective on a GROUND plane converges to a DIMMER value than the
     sky itself: the haze in front of it is lit by half a sky and partly shadowed
     by the land, whereas the sky above the ridge is lit end to end. Without the
     0.78 the visible strip of this disc came back at 0.72-0.79 display luminance
     against a sky of 0.73-0.86 — numerically the same plane, which is exactly the
     milky white-out that swallowed the whole mid-distance. */
  col = mix(col, vec3(skyLuma(col)), SAT(f * 0.55));
  col = mix(col, skyRadiance(rd) * 0.78, f);

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

  gl_FragColor = vec4(skySanitize(col), 1.0);

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
/* ══════════════════════════════════════════════════════════════════════════
 *  The cycle palette.
 *
 *  `u` is this module's own 0..1 cycle position (see phaseToU below), NOT
 *  08-lighting's dayT. The mapping between them goes through the phase NAME +
 *  progress that the rig publishes on `ctx.assets.lightRig.palette`, so the two
 *  clocks cannot drift.
 *
 *  Which key belongs to which sun elevation (lib/lighting.js KEYS, for
 *  reference — do not duplicate its numbers here, just stay consistent with the
 *  ART_BIBLE §3 rows it also uses):
 *
 *    u 0.34  elev ~10 deg rising     u 0.74  elev ~22 deg  (golden hour)
 *    u 0.50  elev 27-52 deg  DAY     u 0.82  elev ~8 deg   (ART_BIBLE dusk row)
 *    u 0.64  elev ~40 deg  DAY       u 0.89  elev ~-10 deg (twilight)
 *
 *  u 0.50 AND u 0.64 are both inside the rig's `day` band, so both must read as
 *  a DAY sky — cool blue zenith over a pale horizon, ART_BIBLE §3 day column.
 *  The golden-hour warmth at u 0.64 is carried by `hazeWarm` (sun-azimuth only)
 *  and by the sun/glow rows, never by the isotropic horizon or haze colours.
 * ══════════════════════════════════════════════════════════════════════════ */
export const SKY_KEYS = [
  { u: 0.00, zenith: 0x101a34, mid: 0x18234a, horizon: 0x2a3355, haze: 0x33406a, hazeWarm: 0x3a4272, hazeAmt: 0.42,
    sun: 0x9fb6e8, glow: 0x54689e, fog: 0x1b2440, cloudLit: 0x39436b, cloudDark: 0x161c34,
    cloudAmb: 0x1e2745, cloudRim: 0x5d6b98, sunI: 0.0, sunSize: 0.030, mieAmt: 0.35, stars: 1.0,
    cov: [0.62, 0.60, 0.58, 0.66], hillLit: 0x2b3559, hillDark: 0x161e38, tree: 0x1a2440,
    floorNear: 0x1d2742, floorFar: 0x1b2440, exposure: 1.0 , zk: 0.36, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0030, gAer: 0.10 },

  { u: 0.15, zenith: 0x14203c, mid: 0x1d2b54, horizon: 0x3b3f62, haze: 0x50496f, hazeWarm: 0x6b5478, hazeAmt: 0.50,
    sun: 0xa9b8e0, glow: 0x6d6394, fog: 0x232c4a, cloudLit: 0x474a72, cloudDark: 0x1d2340,
    cloudAmb: 0x232b48, cloudRim: 0x6a6a9c, sunI: 0.0, sunSize: 0.030, mieAmt: 0.5, stars: 0.82,
    cov: [0.60, 0.58, 0.56, 0.64], hillLit: 0x323a5c, hillDark: 0x1b213c, tree: 0x1e2744,
    floorNear: 0x232c48, floorFar: 0x232c4a, exposure: 1.0 , zk: 0.38, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0032, gAer: 0.14 },

  { u: 0.26, zenith: 0x2a4a86, mid: 0x6a5a92, horizon: 0xe0917e, haze: 0xf0a882, hazeWarm: 0xffb488, hazeAmt: 0.72,
    sun: 0xffb488, glow: 0xff9e6e, fog: 0xd9a08c, cloudLit: 0xffd3b4, cloudDark: 0x4a3659,
    cloudAmb: 0xa2879e, cloudRim: 0xffc9a4, sunI: 7.0, sunSize: 0.026, mieAmt: 1.45, stars: 0.28,
    cov: [0.55, 0.53, 0.52, 0.60], hillLit: 0x6d6472, hillDark: 0x39364f, tree: 0x2f3040,
    floorNear: 0x615b72, floorFar: 0x9c7d7c, exposure: 1.0 , zk: 0.50, zdeep: 0.96, midAmt: 0.30, aerialK: 0.0038, gAer: 0.38 },

  { u: 0.34, zenith: 0x3f6fbc, mid: 0x8fa8d6, horizon: 0xeed3ba, haze: 0xf2dcc2, hazeWarm: 0xffc9a0, hazeAmt: 0.56,
    sun: 0xffdcb0, glow: 0xffc48e, fog: 0xd6cbc4, cloudLit: 0xfff0e2, cloudDark: 0x676293,
    cloudAmb: 0xb3bcd6, cloudRim: 0xffe4c8, sunI: 12.0, sunSize: 0.022, mieAmt: 1.05, stars: 0.0,
    cov: [0.52, 0.50, 0.50, 0.58], hillLit: 0x7c9070, hillDark: 0x455440, tree: 0x374a32,
    floorNear: 0x618148, floorFar: 0x91a4a2, exposure: 1.0 , zk: 0.46, zdeep: 0.82, midAmt: 0.26, aerialK: 0.0040, gAer: 0.34 },

  { u: 0.50, zenith: 0x4e86d4, mid: 0x8fbbe8, horizon: 0xcfe0f2, haze: 0xdfeaf6, hazeWarm: 0xffe8c6, hazeAmt: 0.50,
    sun: 0xffebcb, glow: 0xfff0dc, fog: 0xbcd3ea, cloudLit: 0xfffaf2, cloudDark: 0x6e76a8,
    cloudAmb: 0xbdc9e2, cloudRim: 0xfff4e2, sunI: 17.0, sunSize: 0.019, mieAmt: 0.80, stars: 0.0,
    cov: [0.50, 0.48, 0.49, 0.57], hillLit: 0x7f9a6e, hillDark: 0x435e3c, tree: 0x36502f,
    floorNear: 0x638148, floorFar: 0x81978f, exposure: 1.0 , zk: 0.42, zdeep: 0.74, midAmt: 0.16, aerialK: 0.0022, gAer: 0.12 },

  { u: 0.64, zenith: 0x4b82d0, mid: 0x8fb8e6, horizon: 0xd4dfee, haze: 0xdce6f2, hazeWarm: 0xffd9a8, hazeAmt: 0.42,
    sun: 0xffe0b0, glow: 0xffdcae, fog: 0xc2d6ea, cloudLit: 0xfff6ea, cloudDark: 0x6f78a2,
    cloudAmb: 0xbcc8dd, cloudRim: 0xffeacf, sunI: 15.0, sunSize: 0.020, mieAmt: 0.86, stars: 0.0,
    cov: [0.49, 0.47, 0.48, 0.56], hillLit: 0x7d9a6e, hillDark: 0x445c3c, tree: 0x37502e,
    floorNear: 0x66823f, floorFar: 0x8aa3a6, exposure: 1.0 , zk: 0.28, zdeep: 0.66, midAmt: 0.15, aerialK: 0.0026, gAer: 0.16 },

  { u: 0.74, zenith: 0x3f68b4, mid: 0x9d8fbe, horizon: 0xf7c489, haze: 0xffcf92, hazeWarm: 0xffc98c, hazeAmt: 0.60,
    sun: 0xffcf94, glow: 0xffb271, fog: 0xefc0a0, cloudLit: 0xffe8c8, cloudDark: 0x5f5081,
    cloudAmb: 0xd6b8ae, cloudRim: 0xffd9a8, sunI: 13.0, sunSize: 0.023, mieAmt: 1.55, stars: 0.0,
    cov: [0.48, 0.47, 0.47, 0.55], hillLit: 0x8a8a62, hillDark: 0x4b4a3c, tree: 0x3c4130,
    floorNear: 0x616f3e, floorFar: 0x8f8071, exposure: 1.0 , zk: 0.41, zdeep: 0.88, midAmt: 0.22, aerialK: 0.0034, gAer: 0.30 },

  { u: 0.82, zenith: 0x3a4e86, mid: 0x7d5f8c, horizon: 0xf5a86e, haze: 0xffa268, hazeWarm: 0xffa163, hazeAmt: 0.86,
    sun: 0xff9e5e, glow: 0xff8348, fog: 0xe8a57e, cloudLit: 0xffd0a2, cloudDark: 0x4a3457,
    cloudAmb: 0xc08d80, cloudRim: 0xffb787, sunI: 9.0, sunSize: 0.029, mieAmt: 2.10, stars: 0.10,
    cov: [0.47, 0.46, 0.46, 0.54], hillLit: 0x7a6558, hillDark: 0x3f3040, tree: 0x33283a,
    floorNear: 0x50483e, floorFar: 0x866453, exposure: 1.0 , zk: 0.52, zdeep: 0.92, midAmt: 0.32, aerialK: 0.0041, gAer: 0.42 },

  { u: 0.89, zenith: 0x25315e, mid: 0x4a3f70, horizon: 0xb46a72, haze: 0xc06f6a, hazeWarm: 0xc86e63, hazeAmt: 0.70,
    sun: 0xd4785e, glow: 0xb85a52, fog: 0x8a5f66, cloudLit: 0xb98a90, cloudDark: 0x2f2648,
    cloudAmb: 0x7d5a68, cloudRim: 0xdc8f7e, sunI: 2.0, sunSize: 0.032, mieAmt: 1.30, stars: 0.42,
    cov: [0.52, 0.50, 0.49, 0.58], hillLit: 0x453c50, hillDark: 0x211d36, tree: 0x1f1c32,
    floorNear: 0x312d49, floorFar: 0x4d3a49, exposure: 1.0 , zk: 0.46, zdeep: 0.94, midAmt: 0.28, aerialK: 0.0038, gAer: 0.34 },

  { u: 1.00, zenith: 0x101a34, mid: 0x18234a, horizon: 0x2a3355, haze: 0x33406a, hazeWarm: 0x3a4272, hazeAmt: 0.42,
    sun: 0x9fb6e8, glow: 0x54689e, fog: 0x1b2440, cloudLit: 0x39436b, cloudDark: 0x161c34,
    cloudAmb: 0x1e2745, cloudRim: 0x5d6b98, sunI: 0.0, sunSize: 0.030, mieAmt: 0.35, stars: 1.0,
    cov: [0.62, 0.60, 0.58, 0.66], hillLit: 0x2b3559, hillDark: 0x161e38, tree: 0x1a2440,
    floorNear: 0x1d2742, floorFar: 0x1b2440, exposure: 1.0 , zk: 0.36, zdeep: 0.94, midAmt: 0.22, aerialK: 0.0030, gAer: 0.10 },
];

/** phase name + t (0..1) → cycle position u (0..1). */
export function phaseToU(phase, t) {
  const c = Math.min(Math.max(t ?? 0, 0), 1);
  switch (phase) {
    case 'dawn': return 0.16 + c * 0.26;   // 0.16 → 0.42
    case 'day': return 0.42 + c * 0.24;    // 0.42 → 0.66
    /* NON-LINEAR on purpose. 08-lighting's dusk band drops the sun from 40 deg to
       8 deg over its first 60 %, so a linear palette advance leaves the sky two
       keys behind the sun: measured, the `dusk` anchor (dayT 0.735, sun at 14.9
       deg) landed on u 0.743, whose horizon row is authored for a 25 deg sun. The
       0.62 exponent puts that anchor on u 0.782, i.e. between the golden-hour and
       the ART_BIBLE dusk rows where a 15 deg sun belongs. Endpoints are exact, so
       the join with `day` at 0.66 and with `night` at 0.89 is still continuous. */
    case 'dusk': return 0.66 + Math.pow(c, 0.62) * 0.23;   // 0.66 → 0.89
    case 'night': { const u = 0.89 + c * 0.27; return u >= 1 ? u - 1 : u; }
    default: return 0.5;
  }
}
