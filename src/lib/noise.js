/**
 * Noise — scaffold-owned, do not edit.
 * JS and GLSL implementations of the SAME functions, so CPU-side placement and
 * GPU-side shading/animation agree. Import GLSL_NOISE into any shader that
 * needs snoise/fbm/curl.
 */

/* ------------------------------- JS side ------------------------------- */

const P = new Uint8Array(512);
(function initPerm() {
  // Deterministic permutation table (mulberry32 with a fixed seed).
  let a = 0x9e3779b9;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);
function grad3(h, x, y, z) {
  switch (h & 15) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
    case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
    case 12: return x + y; case 13: return -y + z; case 14: return y - x; default: return -y - z;
  }
}

/** Perlin noise, output roughly [-1,1]. */
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
  const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(
    lerp(lerp(grad3(P[AA], x, y, z), grad3(P[BA], x - 1, y, z), u),
      lerp(grad3(P[AB], x, y - 1, z), grad3(P[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad3(P[AA + 1], x, y, z - 1), grad3(P[BA + 1], x - 1, y, z - 1), u),
      lerp(grad3(P[AB + 1], x, y - 1, z - 1), grad3(P[BB + 1], x - 1, y - 1, z - 1), u), v),
    w);
}

export function fbm3(x, y, z, octaves = 5, lac = 2.02, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f, y * f, z * f);
    norm += amp; amp *= gain; f *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — good for bark cracks and rock strata. */
export function ridged3(x, y, z, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x * f, y * f, z * f));
    sum += amp * n * n; norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

/** Cellular / Worley F1 distance in [0,~1]. Use for lichen, stone, moss patches. */
export function worley2(x, y, freq = 1) {
  x *= freq; y *= freq;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy;
    const h = P[(P[cx & 255] + (cy & 255)) & 511];
    const px = cx + (h & 15) / 15, py = cy + ((h >> 4) & 15) / 15;
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}

/* ------------------------------ GLSL side ------------------------------ */
/**
 * Ashima / Stefan Gustavson simplex noise (MIT) + helpers.
 * Provides: snoise(vec3), snoise(vec2), fbm(vec3), ridged(vec3), curlNoise(vec3), hash..
 * Include once per shader program:  ${GLSL_NOISE}
 */
export const GLSL_NOISE = /* glsl */`
#ifndef SAKURA_NOISE_INCLUDED
#define SAKURA_NOISE_INCLUDED

vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute289(vec4 x){ return mod289(((x*34.0)+10.0)*x); }
vec3 permute289(vec3 x){ return mod289(((x*34.0)+10.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute289( permute289( i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * snoise(p); n += a; a *= 0.5; p *= 2.02;
  }
  return s / max(n, 1e-4);
}
float fbm(vec3 p){ return fbm(p, 5); }

float ridged(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    float v = 1.0 - abs(snoise(p));
    s += a * v * v; n += a; a *= 0.5; p *= 2.03;
  }
  return s / max(n, 1e-4);
}

/**
 * Divergence-free curl noise — the correct way to advect petals (no sources/sinks,
 * so petals never bunch into clumps or vanish into a point).
 * Potential field F is three decorrelated noise fields; we return curl(F) =
 * (dFz/dy - dFy/dz,  dFx/dz - dFz/dx,  dFy/dx - dFx/dy).
 */
vec3 curlNoise(vec3 p){
  const float e = 0.12;
  const vec3 o1 = vec3(  0.0,   0.0,  0.0);
  const vec3 o2 = vec3(31.41, 17.32, 11.7);
  const vec3 o3 = vec3(57.13, 73.19, 41.3);
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);

  float dFz_dy = (snoise(p + o3 + dy) - snoise(p + o3 - dy)) / (2.0 * e);
  float dFy_dz = (snoise(p + o2 + dz) - snoise(p + o2 - dz)) / (2.0 * e);
  float dFx_dz = (snoise(p + o1 + dz) - snoise(p + o1 - dz)) / (2.0 * e);
  float dFz_dx = (snoise(p + o3 + dx) - snoise(p + o3 - dx)) / (2.0 * e);
  float dFy_dx = (snoise(p + o2 + dx) - snoise(p + o2 - dx)) / (2.0 * e);
  float dFx_dy = (snoise(p + o1 + dy) - snoise(p + o1 - dy)) / (2.0 * e);

  return vec3(dFz_dy - dFy_dz, dFx_dz - dFz_dx, dFy_dx - dFx_dy);
}

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3  hash31(float p){ vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

/** Worley F1 in [0,1] — lichen, stone, moss, caustics. */
float worley(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 17.3));
    d = min(d, length(g + o - f));
  }
  return clamp(d, 0.0, 1.0);
}
#endif
`;
