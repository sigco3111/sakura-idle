/**
 * Sakura — gameplay VFX shader library.
 * Owner: the feel agent (45-vfx.js). Other modules may import, never edit.
 *
 * Everything here is pooled + instanced: one InstancedBufferGeometry per effect
 * family, all per-instance state written once at spawn time, all animation
 * evaluated closed-form in the vertex shader from `uTime`. The CPU never
 * touches an effect after it is fired, so a burst costs one small buffer
 * sub-upload and zero per-frame garbage.
 *
 * Families
 *   RING    expanding shockwave annulus, camera-facing      (shake / crit / stage-up)
 *   SPARK   additive motes with drag + gravity              (crit sparkle, gold puff, motes)
 *   SHAFT   tapered light shafts radiating from a point     (stage-up set piece)
 *   GOLD    the Golden Petal — a real lit surface, NPR-shaded with a hard glint
 *
 * All four fragment shaders include GLSL_NPR and end with applyAerial() so a VFX
 * element sits inside the same atmosphere as every other surface (CONTRACT.md).
 *
 * `uAgeOverride` (default -1) freezes every instance at a fixed normalised age.
 * The screenshot harness uses it so a one-shot effect can be photographed.
 */
import * as THREE from 'three';
import { GLSL_NPR } from './lighting.js';

/* ===================================================================== *
 * Shared GLSL preamble
 * ===================================================================== */

const FX_COMMON = /* glsl */`
#include <common>
${GLSL_NPR}
`;

/* Ease helpers used by more than one family. */
const FX_EASE = /* glsl */`
float fxOutQuad(float t){ return 1.0 - (1.0 - t) * (1.0 - t); }
float fxOutCubic(float t){ float u = 1.0 - t; return 1.0 - u * u * u; }
float fxPulse(float t, float a, float b){ return smoothstep(0.0, a, t) * (1.0 - smoothstep(b, 1.0, t)); }
`;

/* ===================================================================== *
 * 1. Shockwave rings
 * ===================================================================== */

export const RING_VERT = /* glsl */`
uniform float uTime;
uniform float uAgeOverride;
attribute vec3 aCenter;
attribute vec4 aRing;      // (startTime, duration, maxRadius, kind)
attribute vec3 aTint;
varying vec2  vQ;
varying float vT;
varying float vKind;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
${FX_EASE}
void main(){
  float age = uAgeOverride >= 0.0 ? uAgeOverride * aRing.y : (uTime - aRing.x);
  float t   = age / max(aRing.y, 1e-3);
  vT = t; vKind = aRing.w; vTint = aTint; vQ = position.xy;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float radius = aRing.z * (0.10 + 0.90 * fxOutCubic(t));
  vec4 mv = viewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * radius;
  vDist   = length(aCenter - cameraPosition);
  vWorldY = aCenter.y;
  gl_Position = projectionMatrix * mv;
}
`;

export const RING_FRAG = /* glsl */`
precision highp float;
varying vec2  vQ;
varying float vT;
varying float vKind;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
uniform float uGain;
${FX_COMMON}
${FX_EASE}
void main(){
  float r = length(vQ);
  float ang = atan(vQ.y, vQ.x);
  // Annulus that starts soft and narrows as it expands. The width is measured:
  // at 0.22 the band is ~1/9 of the disc, which reads as a ring rather than a
  // filled blob even at the first frame of the effect.
  //
  // Two things stop it reading as a cartoon donut: the width and the radius are
  // both modulated round the circumference (an air shock is not a perfect
  // circle), and the OUTER edge is 0.55x the width of the inner one, so the
  // wave has a leading edge and a trailing wake rather than a symmetric tube.
  float wob = 1.0 + 0.20 * sin(ang * 5.0 + vKind * 2.3) + 0.10 * sin(ang * 11.0 - 1.7);
  float w = mix(0.22, 0.045, fxOutQuad(vT)) * wob;
  float dd = r - 0.86 - 0.028 * sin(ang * 7.0 + 0.8);
  float d = dd / (dd > 0.0 ? w * 0.55 : w);
  float ring = exp(-d * d) * (0.80 + 0.26 * sin(ang * 3.0 + vKind * 1.7));
  // a small impact flash in the middle, only for the first quarter and never
  // hot enough on its own to clip
  float core = exp(-r * r * 9.0) * (1.0 - smoothstep(0.0, 0.28, vT)) * 0.30;
  // a second, faster inner ripple on the heavier kinds
  float d2 = (r - 0.40 - 0.40 * vT) / (w * 2.0);
  float ripple = exp(-d2 * d2) * 0.22 * step(0.5, vKind);

  float fade = (1.0 - smoothstep(0.35, 1.0, vT)) * smoothstep(0.0, 0.05, vT);
  float a = clamp((ring + core + ripple) * fade, 0.0, 2.0);
  if (a < 0.002) discard;

  // the light the ring throws is the scene's own key colour, tinted per kind —
  // an effect lit by a different sun than the world is the classic VFX tell.
  vec3 key = mix(nprKeyColor(), vec3(1.0), 0.45);
  vec3 col = vTint * key * uGain * a * 1.15;
  col = applyAerial(col, vDist, vWorldY);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 2. Sparks / motes
 * ===================================================================== */

export const SPARK_VERT = /* glsl */`
uniform float uTime;
uniform float uAgeOverride;
attribute vec3 aSpawn;
attribute vec3 aVel;
attribute vec4 aSpark;   // (startTime, life, size, gravity)
attribute vec3 aTint;
varying vec2  vQ;
varying float vT;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
varying float vTwinkle;
${FX_EASE}
void main(){
  float age = uAgeOverride >= 0.0 ? uAgeOverride * aSpark.y : (uTime - aSpark.x);
  float t   = age / max(aSpark.y, 1e-3);
  vT = t; vTint = aTint; vQ = position.xy;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // exponential drag, closed form:  x = v0 * (1 - e^-kt) / k
  const float K = 2.35;
  float drag = (1.0 - exp(-K * age)) / K;
  vec3 p = aSpawn + aVel * drag - vec3(0.0, 0.5 * aSpark.w * age * age, 0.0);

  float grow = smoothstep(0.0, 0.10, t);
  float die  = 1.0 - smoothstep(0.55, 1.0, t);
  float size = aSpark.z * grow * die;

  vTwinkle = 0.62 + 0.38 * sin(age * 21.0 + aSpawn.x * 7.3 + aSpawn.z * 4.1);

  vec4 mv = viewMatrix * vec4(p, 1.0);
  mv.xy += position.xy * size;
  vDist   = length(p - cameraPosition);
  vWorldY = p.y;
  gl_Position = projectionMatrix * mv;
}
`;

export const SPARK_FRAG = /* glsl */`
precision highp float;
varying vec2  vQ;
varying float vT;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
varying float vTwinkle;
uniform float uGain;
${FX_COMMON}
void main(){
  vec2 q = abs(vQ);
  float r = length(vQ);
  float core = exp(-r * r * 7.5);
  // a small anisotropic 4-point glint so a mote reads as a catch-light, not a dot
  float star = exp(-q.x * 26.0) * exp(-q.y * q.y * 3.0)
             + exp(-q.y * 26.0) * exp(-q.x * q.x * 3.0);
  float a = (core + star * 0.30) * vTwinkle * (1.0 - smoothstep(0.5, 1.0, vT));
  if (a < 0.003) discard;
  vec3 key = mix(nprKeyColor(), vec3(1.0), 0.45);
  vec3 col = vTint * key * uGain * a * 1.70;
  col = applyAerial(col, vDist, vWorldY);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 3. Light shafts (stage-up set piece)
 * ===================================================================== */

export const SHAFT_VERT = /* glsl */`
uniform float uTime;
uniform float uAgeOverride;
uniform vec3  uOrigin;
attribute vec3 aDir;
attribute vec4 aShaft;   // (startTime, duration, length, width)
attribute vec3 aTint;
varying vec2  vUvS;
varying float vT;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
varying float vFace;
${FX_EASE}
void main(){
  float age = uAgeOverride >= 0.0 ? uAgeOverride * aShaft.y : (uTime - aShaft.x);
  float t   = age / max(aShaft.y, 1e-3);
  vT = t; vTint = aTint;
  vUvS = vec2(position.x + 0.5, position.y);
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3 d = normalize(aDir);
  vec3 toCam = normalize(cameraPosition - uOrigin);
  // A billboarded shaft pointing at the lens projects as a giant slab. Fade one
  // out as its axis lines up with the view direction.
  vFace = 1.0 - abs(dot(d, toCam));
  vec3 right = cross(d, toCam);
  float rl = length(right);
  right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);

  float reach = aShaft.z * fxOutCubic(clamp(t * 1.9, 0.0, 1.0));
  float flare = aShaft.w * (0.30 + 1.25 * position.y);
  vec3 p = uOrigin + d * (position.y * reach) + right * (position.x * flare);

  vDist   = length(p - cameraPosition);
  vWorldY = p.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const SHAFT_FRAG = /* glsl */`
precision highp float;
varying vec2  vUvS;
varying float vT;
varying vec3  vTint;
varying float vDist;
varying float vWorldY;
varying float vFace;
uniform float uGain;
${FX_COMMON}
${FX_EASE}
void main(){
  float lat = (vUvS.x - 0.5) * 2.0;
  float body = exp(-lat * lat * 5.0);
  float along = smoothstep(0.0, 0.08, vUvS.y) * (1.0 - smoothstep(0.22, 1.0, vUvS.y));
  float env = fxPulse(vT, 0.14, 0.42);
  float a = body * along * env * 0.42 * smoothstep(0.14, 0.55, vFace);
  if (a < 0.002) discard;
  vec3 key = mix(nprKeyColor(), vec3(1.0), 0.40);
  vec3 col = vTint * key * uGain * a * 1.2;
  col = applyAerial(col, vDist, vWorldY);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 4. The Golden Petal — a genuine lit surface
 * ===================================================================== */

export const GOLD_VERT = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec2 vUvG;
void main(){
  vUvG = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GOLD_FRAG = /* glsl */`
precision highp float;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec2 vUvG;
uniform float uTime;
uniform float uGlow;
${FX_COMMON}
void main(){
  // #A8792C -> #E8C56A -> #FFF6D8 along the petal, ART_BIBLE section 3 gold ramp
  vec3 deep = vec3(0.1550, 0.0685, 0.0097);   // #6E4A18
  vec3 mid  = vec3(0.3930, 0.1900, 0.0250);   // #A8792C  (ART_BIBLE gold, deep end)
  vec3 hot  = vec3(0.8060, 0.5560, 0.1450);   // #E8C56A  (ART_BIBLE gold, light end)
  float v = clamp(vUvG.y, 0.0, 1.0);
  float u = vUvG.x * 2.0 - 1.0;
  vec3 albedo = mix(deep, mid, smoothstep(0.04, 0.62, v));
  albedo = mix(albedo, hot, smoothstep(0.55, 1.0, v) * 0.55);
  // radial veining + a darker curled rim so the surface is never a flat wash
  albedo *= 1.0 + 0.26 * sin(vUvG.x * 27.0) * v;
  albedo *= mix(1.0, 0.58, smoothstep(0.62, 1.0, abs(u)));

  vec3 N = normalize(vWNrm);
  N = gl_FrontFacing ? N : -N;
  vec3 toCam = cameraPosition - vWPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  nprSetWorldPos(vWPos);
  vec3 col = nprShadeN(albedo, N, N, V, 1.0, 0.12, 0.35, 0.35, 0.80, 1.0);

  // the catch: a hard, small, travelling glint. This is the thing that makes a
  // player's eye snap to it across a busy frame.
  vec3 L = nprKeyDir();
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float sweep = 0.55 + 0.45 * sin(uTime * 2.3 + vUvG.y * 5.4);
  col += nprKeyColor() * vec3(1.0, 0.84, 0.48) * pow(ndh, 260.0) * 0.85 * sweep;
  // a hard specular band sweeping base -> tip: this is the "shimmer" a player
  // catches out of the corner of the eye
  float bandPos = fract(uTime * 0.21) * 1.5 - 0.25;
  float band = exp(-pow((v - bandPos) * 7.5, 2.0));
  col += nprKeyColor() * vec3(1.0, 0.90, 0.62) * band * 0.42;
  col += vec3(1.0, 0.86, 0.52) * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0)
       * (0.10 + 0.08 * sin(uTime * 3.1)) * uGlow;
  col += vec3(1.0, 0.90, 0.60) * 0.030 * uGlow;

  col = applyAerial(col, dist, vWPos.y, V);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 5. Geometry builders
 * ===================================================================== */

/** A -1..1 quad turned into an InstancedBufferGeometry with `n` slots. */
export function makeQuadInstanced(n) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = n;
  return g;
}

/** A quad with x in -0.5..0.5 and y in 0..1 — the shaft's local frame. */
export function makeShaftInstanced(n) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = n;
  return g;
}

/**
 * A single sakura petal: cupped, bowed, with the notched tip the real flower
 * has. Silhouette is in the geometry (no alpha test) so it stays crisp under
 * SMAA at any distance.
 */
export function makePetalGeometry(cols = 9, rows = 12) {
  const pos = [], nrm = [], uvs = [], idx = [];
  const hw = (v) => 0.30 * Math.pow(Math.sin(Math.PI * Math.min(Math.pow(v, 1.4) * 0.90 + 0.045, 1)), 0.72);
  const notch = (u) => 1 - 0.16 * (1 - u * u);
  const zAt = (u, v) => -0.30 * u * u * (0.25 + 0.75 * v) + 0.10 * (v - 0.5) * (v - 0.5);

  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const u = (c / (cols - 1)) * 2 - 1;
      const w = hw(v);
      // carve the sakura tip notch into the last 14% of the length
      const yy = v > 0.86 ? v * (1 - (1 - notch(u)) * (v - 0.86) / 0.14) : v;
      pos.push(u * w, yy - 0.5, zAt(u, v));
      uvs.push(u * 0.5 + 0.5, v);
      // analytic-ish normal from the cup/bow surface
      const nx = 0.60 * u * (0.25 + 0.75 * v);
      const ny = -0.20 * (v - 0.5);
      const L = Math.hypot(nx, ny, 1);
      nrm.push(nx / L, ny / L, 1 / L);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* ===================================================================== *
 * 6. Material factories
 * ===================================================================== */

function additive(uniforms, vert, frag) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export function createRingMaterial(lightUniforms, own) {
  return additive({ ...lightUniforms, ...own }, RING_VERT, RING_FRAG);
}
export function createSparkMaterial(lightUniforms, own) {
  return additive({ ...lightUniforms, ...own }, SPARK_VERT, SPARK_FRAG);
}
export function createShaftMaterial(lightUniforms, own) {
  return additive({ ...lightUniforms, ...own }, SHAFT_VERT, SHAFT_FRAG);
}
export function createGoldMaterial(lightUniforms, own) {
  return new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms, ...own },
    vertexShader: GOLD_VERT,
    fragmentShader: GOLD_FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    fog: false,
  });
}
