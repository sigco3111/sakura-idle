/**
 * Sakura — petal geometry, procedural petal texture and the GPU petal shader.
 * Owner: the petal agent (src/modules/40-petals.js). Nothing else writes this file.
 *
 * Everything about a petal's motion is a CLOSED-FORM function of
 *   (per-instance constants, uTime, the shared wind field)
 * evaluated in the vertex shader. There is no CPU per-petal work per frame and no
 * GPGPU ping-pong: the only per-frame CPU cost is one Vector3 accumulation and a
 * 128-texel float texture upload.
 *
 * The wind-advection trick
 * ------------------------
 * Naively closed-form advection (`drift = windVelocityNow * age`) teleports every
 * petal whenever the gust envelope changes, because the whole history is
 * retroactively rewritten. Instead the module integrates the shared wind field on
 * the CPU into a running displacement D(t) and keeps the last ~38 s of it in a
 * 128x1 RGBA-float texture (a ring buffer). The shader can then evaluate
 *   D(now - a)              for any age a
 * and build the petal's displacement out of exact definite integrals:
 *   airborne fall   D(t_land) - D(t_birth)     (frozen once it has landed)
 *   gust pick-up    D(now)    - D(t_lift)
 * so gusts sweep every airborne petal together, exactly in step with the grass and
 * the branches, and a petal resting on the ground is genuinely, provably still.
 *
 * Exports
 *   makePetalTexture(THREE)          procedural alpha-tested petal, canvas-drawn
 *   createPetalGeometry(THREE, n)    curved petal patch as an InstancedBufferGeometry
 *   petalShape(u, v)                 the outline field (shared with the texture)
 *   PETAL_VERT / PETAL_FRAG          the GLSL
 *   HIST_N / HIST_DT                 drift ring-buffer shape (module builds the texture)
 */
import { GLSL_NOISE } from './noise.js';
import { GLSL_WIND } from './wind.js';
import { GLSL_NPR } from './lighting.js';

/** Drift history ring buffer: 128 samples x 0.30 s = 38.4 s of lookback. */
export const HIST_N = 128;
export const HIST_DT = 0.30;
/** Longest petal cycle the shader may ask about. Must stay < HIST_N * HIST_DT. */
export const MAX_CYCLE = 34.0;

/* ===================================================================== *
 * 1. Petal outline — one function, used by both the texture and the mesh
 * ===================================================================== */

/**
 * Signed "insideness" of a sakura petal.
 * @param {number} u  -1..1 across the width
 * @param {number} v   0..1 base -> tip
 * @returns {number} > 0 inside, 0 on the outline. Roughly 1 unit ~ 1/3 of the width.
 */
export function petalShape(u, v) {
  const vv = Math.min(Math.max(v, 0), 1);
  const hw = petalHalfWidth(vv);
  const au = Math.abs(u);
  // The notch: a shallow central nick in the domed tip. Measured against the
  // render — at 0.165 deep and 0.30 wide over a nearly flat tip it produced two
  // fat lobes and every large petal read as a valentine HEART. 0.088 over an
  // elliptical cap reads as sakura.
  const notch = 0.088 * Math.exp(-(u / 0.20) * (u / 0.20));
  const dSide = (hw - au) / Math.max(hw, 0.05);
  const dTop = (1.0 - notch - vv) * 3.4;
  const dBase = vv * 11.0;
  return Math.min(dSide, dTop, dBase);
}

/**
 * Half-width of the outline at v (0..1): a tapering base up to v = 0.60, then an
 * elliptical cap that is still 0.4 wide at the tip, so `petalShape` can nick a
 * notch into a DOME rather than cleave a flat top in two.
 */
export function petalHalfWidth(v) {
  const vv = Math.min(Math.max(v, 0), 1);
  if (vv < 0.60) return 0.15 + 0.79 * Math.sin(Math.PI * 0.5 * (vv / 0.60));
  const t = (vv - 0.60) / 0.44;                  // cap reaches zero at v = 1.04
  return 0.94 * Math.sqrt(Math.max(0, 1 - t * t));
}

/* ===================================================================== *
 * 2. Procedural petal texture (canvas -> sRGB RGBA8, mipmapped)
 * ===================================================================== */

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** Deterministic 2D value noise for the petal's papery mottle. No RNG state. */
const hash2 = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash2(ix, iy), hash2(ix + 1, iy), ux),
    mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy);
}

// ART_BIBLE section 3, the five sakura values, authored in sRGB 0..255.
const C_DEEP = [0xC2, 0x5F, 0x86];   // #C25F86 deep interior
const C_SHAD = [0xEE, 0x8C, 0xAF];   // #EE8CAF shadow
const C_MID = [0xFF, 0xB6, 0xCE];    // #FFB6CE mid
const C_LIGHT = [0xFF, 0xD9, 0xE6];  // #FFD9E6 light
const C_SPEC = [0xFF, 0xF2, 0xF6];   // #FFF2F6 specular / edge

const lerp3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Angles (radians, from the base, 0 = straight up the midrib) of the three veins. */
const VEIN_ANG = [-0.58, 0.0, 0.58];
/** Gaussian half-width of a vein in the same angular measure. */
const VEIN_W = 0.058;
/** Luminance multiplier inside a vein. ART_BIBLE §3 wants them faint. */
const VEIN_MUL = 0.92;

/**
 * Draws the petal into a canvas: RGB = albedo, A = the outline mask with a ~2 px
 * soft edge so alpha-test silhouettes stay clean under SMAA.
 *
 * The gradient runs ACROSS THE SHORT AXIS, which is the fix for §8.6 "petals as
 * untextured quads". A real sakura petal is cupped and folded, so the light
 * crosses it: one flank catches the key (#FFD9E6 -> #FFF2F6 at the rim), a soft
 * valley just off centre sits in the fold's own shadow (#EE8CAF, going to
 * #C25F86 where the fold meets the stem), and the far flank sits at the palette
 * mid (#FFB6CE). Three faint radial veins fan out of the base at a 0.92
 * luminance multiplier.
 *
 * MEASURED, and this is the number the round-2 review named: the previous ramp
 * ran base -> tip only and over the visible body of a petal it spanned sRGB
 * luminance 0.78..0.89, which printed in the graded frame as an interior range of
 * 0.056 (p5..p95) — a flat pale-pink blob at any size. This profile spans
 * 0.60..0.96 across the width, i.e. all five §3 values in every petal.
 */
export function makePetalTexture(THREE, S = 192) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;

  for (let row = 0; row < S; row++) {
    // flipY is on for canvas textures, so canvas row S-1 is uv.v = 0 (the base).
    const v = 1 - (row + 0.5) / S;
    for (let col = 0; col < S; col++) {
      const u = ((col + 0.5) / S) * 2 - 1;
      const sd = petalShape(u, v);
      const a = smoothstep(0.0, 0.075, sd);

      const hw = petalHalfWidth(v);
      // signed position across the SHORT axis: -1 far flank .. +1 lit flank
      const s = u / Math.max(hw, 0.16);
      const t = Math.min(Math.abs(s), 1.4);

      // 1. the body: palette mid on the far flank -> palette light on the lit one
      let c = lerp3(C_MID, C_LIGHT, smoothstep(-0.60, 0.74, s));

      // 2. the fold. A petal is a curled sheet, so the shading has a valley a
      //    little off centre rather than a symmetric crease down the middle —
      //    that asymmetry is most of what stops it reading as a printed decal.
      const fold = Math.exp(-Math.pow((s + 0.16) / 0.30, 2));
      c = lerp3(c, C_SHAD, fold * 0.86);
      // 3. ...and the deepest interior value where the fold meets the stem
      c = lerp3(c, C_DEEP, fold * smoothstep(0.36, 0.03, v) * 0.72);
      // 4. the seat at the base
      c = lerp3(c, C_SHAD, smoothstep(0.20, 0.0, v) * 0.55);
      // 5. sun-bleached tip, mild
      c = lerp3(c, C_LIGHT, smoothstep(0.58, 1.02, v) * 0.26);

      // 6. three radial veins fanning out of the base
      const ang = Math.atan2(u, Math.max(v, 0.02));
      let vein = 0;
      for (let k = 0; k < VEIN_ANG.length; k++) {
        vein = Math.max(vein, Math.exp(-Math.pow((ang - VEIN_ANG[k]) / VEIN_W, 2)));
      }
      vein *= smoothstep(0.05, 0.28, v) * (1 - smoothstep(0.82, 1.02, v));
      const vk = mix(1, VEIN_MUL, vein);
      c = [c[0] * vk, c[1] * vk, c[2] * vk];

      // 6b. papery mottle. Two octaves of value noise at +-1.8% value: without it
      //     the profile above is a perfect airbrush and at `bark` range a 200 px
      //     petal reads as vector art. Mips average it away by mid-field, so it
      //     costs nothing at distance.
      //     DARKENING ONLY: the pinks all sit at R = 255, so a mottle that could
      //     brighten would clip the red channel and desaturate wherever it did.
      const mot = 1 - 0.030 * vnoise(u * 13.0, v * 13.0)
                    - 0.016 * vnoise(u * 31.0 + 7.7, v * 31.0 - 3.1);
      c = [c[0] * mot, c[1] * mot, c[2] * mot];

      // 7. the specular edge, narrow, on the LIT flank only — #FFF2F6 is the
      //    palette's brightest value and a petal that carries it everywhere is
      //    the white flake the previous round shipped.
      c = lerp3(c, C_SPEC, smoothstep(0.74, 1.00, s) * (1 - smoothstep(1.00, 1.16, t)) * 0.88);
      // 8. and a much fainter light edge on the far flank so the silhouette still
      //    separates from a dark background
      c = lerp3(c, C_LIGHT, smoothstep(0.82, 1.02, -s) * 0.42);

      const p = (row * S + col) * 4;
      d[p] = Math.round(Math.min(255, Math.max(0, c[0])));
      d[p + 1] = Math.round(Math.min(255, Math.max(0, c[1])));
      d[p + 2] = Math.round(Math.min(255, Math.max(0, c[2])));
      d[p + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;   // -> SRGB8_ALPHA8, decoded in hardware
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ===================================================================== *
 * 3. Petal geometry — a tapered, cupped patch (8 triangles)
 * ===================================================================== */

/**
 * A curved petal patch in local space: length along +Y in [-0.5, 0.5], width
 * along X, normal roughly +Z. Cupped across the width and bowed along the length
 * so it never reads as a flat billboard.
 *
 * Deliberately NOT tapered to the outline: with only three columns a tapered mesh
 * silhouette is a coarse hexagon and the alpha never gets to clip anything, so
 * the notch disappears and every petal reads as a torn blob. The patch stays
 * rectangular and the alpha owns the silhouette; the discarded fragments cost a
 * texture fetch each, which is far cheaper than losing the petal shape.
 *
 * XS sets the aspect: visible half-width = 0.94 * XS, so 0.40 gives a
 * width:length of ~0.75, which is what a real sakura petal reads as.
 */
export function createPetalGeometry(THREE, cols = 3, rows = 4) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const XS = 0.40;         // half-width of the patch
  const CUP = 0.15;        // cup depth across the width
  const BOW = 0.10;        // bow along the length

  // z = f(u, v) with u in [-1,1] across the patch, v in [0,1] base -> tip
  const f = (u, v) => -CUP * u * u * (0.30 + 0.70 * v) + BOW * (v - 0.45) * (v - 0.45) - BOW * 0.09;
  const dfdu = (u, v) => -2 * CUP * u * (0.30 + 0.70 * v);
  const dfdv = (u, v) => -CUP * u * u * 0.70 + 2 * BOW * (v - 0.45);

  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const un = (c / (cols - 1)) * 2 - 1;                  // -1..1
      pos.push(un * XS, v - 0.5, f(un, v));
      const nx = -dfdu(un, v) / XS;
      const ny = -dfdv(un, v);
      const L = Math.hypot(nx, ny, 1);
      nrm.push(nx / L, ny / L, 1 / L);
      uvs.push(un * 0.5 + 0.5, v);
    }
  }

  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d0 = a + cols, e = d0 + 1;
      idx.push(a, d0, b, b, d0, e);
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/* ===================================================================== *
 * 4. GLSL
 * ===================================================================== */

export const PETAL_VERT = /* glsl */`
attribute vec3 aSpawn;     // spawn position, world space
attribute vec4 aTiming;    // birth, cycle, tFall, tRest
attribute vec4 aMotion;    // terminalVel, flutterFreq, flutterAmp, driftMul
attribute vec4 aTumble;    // spin rate x/y/z, phase
attribute vec4 aLook;      // size, widthMul, mode(0 loop | 1 one-shot), glint
attribute vec3 aTint;
attribute vec3 aImpulse;   // initial velocity (detach kick / burst)

uniform float uTime;
uniform float uSizeMul;
uniform float uDriftScale;
uniform float uSwirl;
uniform float uLiftAmp;
uniform float uFlutterMul;

// --- CPU-integrated wind displacement history (see the file header)
uniform sampler2D uDriftTex;
uniform vec3  uDriftNow;
uniform float uHeadIdx;
uniform float uHeadAge;

// --- ground height field (0 everywhere until the terrain module publishes one)
uniform sampler2D uGroundTex;
uniform vec4  uGroundArea;    // minX, minZ, 1/spanX, 1/spanZ
uniform vec2  uGroundRange;   // hMin, hSpan
uniform float uGroundFlat;
uniform vec3  uCenter;
uniform float uFadeRadius;

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec2  vUv;
varying vec3  vTint;
varying float vGlint;
varying float vFace;

${GLSL_NOISE}
${GLSL_WIND}

#include <common>
#include <shadowmap_pars_vertex>

const float HIST_N  = ${HIST_N.toFixed(1)};
const float HIST_DT = ${HIST_DT.toFixed(4)};

vec3 histFetch(float i){
  float k = mod(uHeadIdx - i, HIST_N);
  return texture2D(uDriftTex, vec2((k + 0.5) / HIST_N, 0.5)).xyz;
}

/** D(now - age): the CPU-integrated wind displacement, "age" seconds ago. */
vec3 driftAt(float age){
  float x = (age - uHeadAge) / HIST_DT;      // samples back from the ring head
  if (x < 0.0) {
    // between "now" and the newest stored sample
    float f = clamp(age / max(uHeadAge, 1e-5), 0.0, 1.0);
    return mix(uDriftNow, histFetch(0.0), f);
  }
  float i0 = floor(min(x, HIST_N - 2.0));
  return mix(histFetch(i0), histFetch(i0 + 1.0), x - i0);
}

float groundAt(vec2 xz){
  vec2 uv = (xz - uGroundArea.xy) * uGroundArea.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return uGroundFlat;
  return uGroundRange.x + texture2D(uGroundTex, clamp(uv, 0.002, 0.998)).r * uGroundRange.y;
}

vec3 rot3(vec3 p, vec3 s, vec3 c){
  p = vec3(p.x, c.x * p.y - s.x * p.z, s.x * p.y + c.x * p.z);
  p = vec3(c.y * p.x + s.y * p.z, p.y, -s.y * p.x + c.y * p.z);
  return vec3(c.z * p.x - s.z * p.y, s.z * p.x + c.z * p.y, p.z);
}

void main(){
  float cyc   = max(aTiming.y, 0.75);
  float tFall = aTiming.z;
  float tRest = aTiming.w;
  float tLift = max(cyc - tFall - tRest, 0.4);
  float oneShot = aLook.z;

  float rawAge = uTime - aTiming.x;
  float age    = mix(mod(rawAge, cyc), rawAge, oneShot);
  float alive  = mix(1.0, step(0.0, rawAge) * step(rawAge, cyc), oneShot);

  float sinceLand = max(age - tFall, 0.0);
  float liftT     = max(age - tFall - tRest, 0.0);
  float lp        = clamp(liftT / tLift, 0.0, 1.0);

  // ---- wind advection as exact definite integrals of the shared wind field
  vec3 dFall = driftAt(sinceLand) - driftAt(sinceLand + min(age, tFall));
  vec3 dLift = driftAt(0.0) - driftAt(liftT);
  vec3 drift = (dFall + dLift) * (uDriftScale * aMotion.w);
  drift.y *= 0.28;

  float landW = smoothstep(tFall - 0.55, tFall + 0.05, age);
  float liftW = smoothstep(0.0, 0.40, liftT);
  float airborne = clamp(max(1.0 - landW, liftW), 0.0, 1.0);
  float resting  = 1.0 - airborne;

  vec2 wd = normalize(uWindDir + vec2(1e-5));
  vec2 pp = vec2(-wd.y, wd.x);
  float ff = aMotion.y;
  float ph = aTumble.w;
  float fa = aMotion.z * uFlutterMul;

  // ---- lateral flutter: the side-to-side scything a falling petal does
  float s1 = sin(age * ff + ph);
  float s2 = sin(age * ff * 0.61 + ph * 2.3);
  vec3 flutter = vec3(pp.x, 0.0, pp.y) * (s1 * fa)
               + vec3(wd.x, 0.0, wd.y) * (s2 * fa * 0.55);
  flutter.y = sin(age * ff * 1.7 + ph * 0.7) * fa * 0.22;

  // ---- divergence-free swirl, sampled in WORLD space so neighbours agree
  vec3 base = aSpawn + vec3(drift.x, 0.0, drift.z);
  vec3 swirl = curlNoise(base * 0.072 + vec3(0.0, uWindTime * 0.055, 0.0))
             * (uSwirl * (0.40 + 0.85 * uWindGust));

  // ---- detach kick / burst impulse, exponentially damped
  vec3 imp = aImpulse * ((1.0 - exp(-1.7 * age)) / 1.7);

  // ---- per-petal glide: every petal keeps its own slight heading bias, so a
  // population falling through one wind field lands in a broad ellipse instead
  // of a single downwind streak. Direction and rate are derived from existing
  // per-instance values, so this costs no extra attribute.
  float gAng = ph * 2.718;
  float gMag = 0.055 + 0.30 * fract(aTumble.x * 3.13 + 0.37);
  float airTime = min(age, tFall) + liftT;
  vec2 glide = vec2(cos(gAng), sin(gAng)) * (gMag * airTime);

  vec2 hxz = aSpawn.xz + drift.xz + glide + (flutter.xz + swirl.xz) * airborne + imp.xz;
  // resting petals skitter a little when a gust comes through
  hxz += wd * (uWindGust * uWindGust * 0.11 * sin(uWindTime * 2.7 + ph * 5.1)) * resting;

  float rad = length(hxz - uCenter.xz);
  float radFade = 1.0 - smoothstep(uFadeRadius, uFadeRadius + 9.0, rad);

  // ---- vertical: eased-in terminal-velocity fall, then the ground, then gusts
  float fallEase = age - (1.0 - exp(-age / 0.5)) * 0.5;
  float yFall = aSpawn.y + imp.y - aMotion.x * fallEase
              + (flutter.y + swirl.y) * (1.0 - landW);
  float gy = groundAt(hxz);
  float yGround = gy + 0.014 + aLook.x * 0.05;
  float y = max(yFall, yGround);

  // A resting petal only leaves the ground when the shared gust envelope is
  // genuinely strong — in calm air the carpet just shivers.
  float lv = 0.55 + 0.95 * fract(aTumble.z * 7.31);
  float liftH = (0.09 + 3.0 * smoothstep(0.30, 0.86, uWindGust))
              * uLiftAmp * lv * pow(lp, 0.72);
  y += liftH + (flutter.y + swirl.y) * liftW * 0.6;

  // ---- tumble on three axes + the edge-on "flip" that makes petals flash
  float flip = sin(age * ff * 1.35 + ph * 1.1) * 1.22;
  vec3 ang = vec3(aTumble.x * age + ph + flip,
                  aTumble.y * age + ph * 1.7,
                  aTumble.z * age + ph * 2.9);
  vec3 restAng = vec3(-1.5708 + 0.20 * sin(ph * 3.0),
                      ph * 6.2832,
                      0.14 * sin(ph * 5.0)
                      + uWindGust * 0.16 * sin(uWindTime * 3.6 + ph * 9.0));
  // Wrapping into [-PI, PI] is an identity for the rotation but keeps the
  // tumble -> flat blend from spinning through many turns as a petal settles.
  ang = mod(ang + PI, 2.0 * PI) - PI;
  restAng = mod(restAng + PI, 2.0 * PI) - PI;
  ang = mix(ang, restAng, resting);
  vec3 sa = sin(ang), ca = cos(ang);

  // ---- per-instance curvature + a slow flex so the petal is never a rigid card
  float bend = 0.32 + 0.62 * fract(ph * 3.77);
  float flex = bend * (0.55 + 0.55 * sin(age * ff * 1.9 + ph * 2.1));
  vec3 lpos = position;
  lpos.x *= aLook.y;
  lpos.z += flex * (lpos.y * lpos.y * 0.9 - 0.11) * 0.6;
  vec3 lnrm = normalize(vec3(normal.x, normal.y - flex * lpos.y * 1.08, normal.z));

  vec3 centre = vec3(hxz.x, y, hxz.y);

  float grow   = smoothstep(0.0, 0.45, age);
  float vanish = 1.0 - smoothstep(0.70, 1.0, lp);
  // A rare large petal that happens to sit 30 cm from the lens is a white slab
  // across a third of the frame, not a bokeh element. Fade anything inside 1.6 m
  // so the near field still frames the shot (ART_BIBLE section 5) without one
  // petal eating the composition.
  float nearFade = smoothstep(0.30, 1.60, distance(centre, cameraPosition));
  float sz = aLook.x * uSizeMul * grow * vanish * alive * radFade * nearFade;
  vec4 worldPosition = vec4(centre + rot3(lpos * sz, sa, ca), 1.0);

  vWorldPos = worldPosition.xyz;
  vNormal   = rot3(lnrm, sa, ca);
  vUv       = uv;
  vTint     = aTint;
  vGlint    = aLook.w;
  vFace     = airborne;

  vec3 shadowWorldNormal = vNormal;
  #if defined( USE_SHADOWMAP )
    #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
    #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * ( worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
  #endif
  #if NUM_SPOT_LIGHT_COORDS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vSpotLightCoord[ i ] = spotLightMatrix[ i ] * worldPosition;
  }
  #pragma unroll_loop_end
  #endif

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const PETAL_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uAlphaTest;
uniform float uTranslucency;
uniform float uThickness;
uniform float uSpecScale;
uniform float uRimScale;
// --- §3 / §8.6 petal-colour controls. All four were MEASURED against the
// composited png, not guessed; see the comment block on each in 40-petals.js.
uniform float uAlbedoCeil;   // hard ceiling on petal albedo luminance (linear)
uniform float uWrapAmp;      // #FFE7EE wrapped-light transmission amplitude
uniform float uLevel;        // petal exposure — see the comment in 40-petals.js
uniform float uChromaHold;   // how far shaded colour is rotated back onto the petal's chroma
uniform float uLumCeil;      // soft ceiling on output luminance outside a specular core
uniform float uNearSat;      // saturation multiplier where the near-field CoC > 8 px
uniform float uFocusDist;    // metres; mirrors 90-postfx's DOF subject distance
uniform vec2  uCocBand;      // (blurEnd, blurStart) as ratios of uFocusDist

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec2  vUv;
varying vec3  vTint;
varying float vGlint;
varying float vFace;

#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

${GLSL_NPR}

// #FFE7EE — ART_BIBLE §2's "backlit transmission" value, in LINEAR space. Light
// that has been through a petal is this colour; it is never white.
const vec3 PETAL_TRANSMIT = vec3( 1.0, 0.7994, 0.8550 );

void main(){
  vec4 tx = texture2D( uMap, vUv );
  if ( tx.a < uAlphaTest ) discard;

  vec3 albedo = tx.rgb * vTint;
  // §3: "never pure white except specular cores and bloom". vTint's near-white
  // entry times the texture's specular edge can otherwise hand the shading model
  // an albedo brighter than the palette's brightest value.
  float al = nprLuma( albedo );
  albedo *= min( 1.0, uAlbedoCeil / max( al, 1e-4 ) );
  // unit-luminance chroma of THIS petal — the hue the shaded result is held to.
  vec3 petalChroma = albedo / max( nprLuma( albedo ), 1e-4 );

  vec3 N = normalize( vNormal );
  N = gl_FrontFacing ? N : -N;
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float sm = getShadowMask();
  nprSetWorldPos( vWorldPos );
  vec3 col = nprShadeN( albedo, N, N, V, sm,
                        uTranslucency, uThickness,
                        uSpecScale * vGlint, uRimScale, 1.0 );

  // ---- ART_BIBLE §2 wrapped light, in the PETAL's transmitted colour.
  // nprShadeN's own transmission is tinted by the key, which at this sun
  // (#FFEBCB) has B below G — so a strongly backlit petal came out cream. This
  // term carries the key's LEVEL only and spends it on #FFE7EE, so a back-facing
  // petal transmits pink instead of going white.
  vec3  Ld = normalize( mix( uSunDir, uMoonDir, step( 0.5, uNightMix ) ) );
  float kl = clamp( nprLuma( uSunColor ), 0.05, 1.15 );
  float wrap = clamp( dot( N, -Ld ) * 0.5 + 0.5, 0.0, 1.0 );
  float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.2 );
  // a petal is the same fraction of a millimetre thick face-on as edge-on, so the
  // floor here is high; the grazing silhouette just gets the longer path length.
  float thin = mix( 0.55, 1.0, fres );
  col += PETAL_TRANSMIT * ( kl * uWrapAmp * wrap * wrap * thin
                            * uThickness * uTranslucency * mix( 0.30, 1.0, sm ) );

  // ---- petal exposure. At this key a near-white albedo lands well past 1.0 in
  // linear HDR, i.e. on the tone curve's shoulder, and the shoulder is what was
  // destroying the interior gradient: the texture's 2.1x albedo ratio across a
  // petal printed as a 0.09 display-luminance range. Pulling the petal's own
  // response back into the curve's linear region is the only place that ratio can
  // be recovered — it is not a brightness taste dial, and the value is MEASURED
  // against the target in 40-petals.js.
  col *= uLevel;

  // ---- hold the hero colour. albedo * key cancels the pink (the key's B sits
  // below its G), and the additive rim/spec/transmission stack is close to
  // neutral, so a lit petal drifted to hue ~5 deg salmon-white. Rotating the
  // shaded colour partway back onto the petal's own chroma AT ITS OWN LUMINANCE
  // is a purely chromatic operation: the ramp shading and the interior gradient
  // both survive it untouched. The specular core is exempt (§3 allows white there).
  float specCore = smoothstep( 0.34, 0.62,
                    pow( max( dot( N, normalize( Ld + V ) ), 0.0 ), 170.0 ) );
  float sl = nprLuma( col );
  // ...and eased off at night, where nprShadeN deliberately desaturates every
  // albedo (rods carry no colour). Holding the full daylight chroma there would
  // put vivid daylight pink under a moon, which is the same class of error.
  float hold = uChromaHold * ( 1.0 - specCore ) * mix( 1.0, 0.45, clamp( uNightMix, 0.0, 1.0 ) );
  col = mix( col, sl * petalChroma, hold );

  // ---- soft luminance ceiling, so no petal can print as pure white outside a
  // specular core. A knee rather than a clamp: the shoulder keeps relative order
  // (a lit petal still reads brighter than a shaded one) instead of flattening
  // every bright petal onto one value, which is the failure it is fixing.
  float lm = nprLuma( col );
  float cap = mix( uLumCeil, uLumCeil * 2.6, specCore );
  if ( lm > cap ) col *= ( cap + ( lm - cap ) / ( 1.0 + ( lm - cap ) * 3.0 ) ) / lm;

  // ---- near-field CoC pre-saturation. Mirrors COC_SHADER's near ramp:
  // cocPx = ( 1 - smoothstep( band.y, band.x, dist / focus ) ) * nearPx, so with
  // nearPx 8.5 a CoC over 8 px means dist / focus below ~0.36. The gather then
  // averages the petal with whatever is behind it, which pulls a pale petal to
  // grey; pre-multiplying its saturation is what keeps the bokeh reading pink.
  float rf = dist / max( uFocusDist, 0.5 );
  float blur = 1.0 - smoothstep( uCocBand.x, uCocBand.y, rf );
  float satMul = mix( 1.0, uNearSat, blur );
  float lb = nprLuma( col );
  col = max( vec3( lb ) + ( col - vec3( lb ) ) * satMul, vec3( 0.0 ) );

  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
