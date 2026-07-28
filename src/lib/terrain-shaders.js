/**
 * Terrain / grass / ground-scatter shaders + procedural texture bakery.
 * Owner: the terrain agent (src/modules/20-terrain.js). Nothing else writes here.
 *
 * Exports
 *   GROUND_VERT / GROUND_FRAG   multi-layer blended ground (grass / dry grass /
 *                               earth+gravel path / moss + fallen-petal carpet)
 *   GRASS_VERT  / GRASS_FRAG    instanced, curved, tapered, wind-BENT blades
 *   STONE_VERT  / STONE_FRAG    instanced rock/path-stone with moss on the up faces
 *   makeGroundTextures()        the macro (world-mapped) + detail (tiling) maps
 *   makeSpriteTextures()        clover / wildflower / fallen-petal alpha sprites
 *
 * Every fragment shader here goes through nprShade / applyAerial from
 * src/lib/lighting.js — ART_BIBLE §2 is not re-implemented locally.
 */
import * as THREE from 'three';
import { GLSL_NOISE, fbm3, worley2 } from './noise.js';
import { GLSL_NPR } from './lighting.js';
import { GLSL_WIND } from './wind.js';

/* ===================================================================== *
 * 0. Shared GLSL fragments
 * ===================================================================== */

/** The shadow-coordinate write-out, byte-identical in intent to lighting.js's
 *  NPR_VERT so a terrain surface receives exactly the same shadows the tree and
 *  props do. `WPOS` must be a vec4 world position in scope, `WNRM` a vec3. */
const SHADOW_VERT = (WPOS, WNRM) => /* glsl */`
  #if defined( USE_SHADOWMAP )
    #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * ( ${WPOS} + vec4( ${WNRM} * directionalLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
    #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * ( ${WPOS} + vec4( ${WNRM} * pointLightShadows[ i ].shadowNormalBias, 0.0 ) );
    }
    #pragma unroll_loop_end
    #endif
  #endif
  #if NUM_SPOT_LIGHT_COORDS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vSpotLightCoord[ i ] = spotLightMatrix[ i ] * ${WPOS};
  }
  #pragma unroll_loop_end
  #endif
`;

const FRAG_SHADOW_PARS = /* glsl */`
#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
`;

/* ===================================================================== *
 * 1. Ground
 * ===================================================================== */

export const GROUND_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
#include <common>
#include <shadowmap_pars_vertex>
void main(){
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * normal );
  vWorldNormal = wn;
${SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GROUND_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

uniform sampler2D uMacro;      // (lushGrass, dryGrass, earth, moss) weights
uniform sampler2D uMacro2;     // (path, petalBias, rockiness, largeVariation)
uniform sampler2D uDetail;     // tiling (fibre, grain, cell, bump)
uniform sampler2D uDetailN;    // tiling tangent-space normal of the bump field
uniform vec2  uMacroXf;        // (1/(2*extent), 0.5)
uniform vec2  uDetailTile;     // (1/fineMetres, 1/coarseMetres)
uniform vec3  uGrassBase;      // #3E6134 cooler, at the base of the sward
uniform vec3  uGrassTip;       // #8FB463 warm, sun-bleached
uniform vec3  uGrassDry;       // sun-killed straw
uniform vec3  uEarth;
uniform vec3  uEarthDark;
uniform vec3  uMoss;
uniform vec3  uStone;
uniform vec3  uPathEarth;   // packed gravel of the trodden path
uniform vec3  uPetalLo;
uniform vec3  uPetalHi;
uniform float uPetalAmt;       // 0..1, driven by bloom:stage
uniform float uBump;

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}

void main(){
  vec3 N0 = normalize( vWorldNormal );
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  vec2 wxz = vWorldPos.xz;
  vec2 mUv = wxz * uMacroXf.x + uMacroXf.y;
  vec4 M1 = texture2D( uMacro,  mUv );
  vec4 M2 = texture2D( uMacro2, mUv );
  vec4 dF = texture2D( uDetail, wxz * uDetailTile.x );
  vec4 dC = texture2D( uDetail, wxz * uDetailTile.y + vec2( 0.317, 0.643 ) );

  float slope = 1.0 - clamp( N0.y, 0.0, 1.0 );
  // a third, shader-side octave so the near field never runs out of detail
  float hi = snoise( vec3( wxz * 2.35, 3.1 ) ) * 0.5 + 0.5;
  float fibre = dF.r * 0.70 + dC.r * 0.30;
  float grain = dF.g * 0.75 + hi * 0.25;
  float cell  = dF.b * 0.62 + dC.b * 0.38;

  /* ---- layer weights ------------------------------------------------ */
  float wPath = smoothstep( 0.16, 0.70, M2.r );
  float wLush = M1.r * ( 1.0 - wPath * 0.88 );
  float wDry  = M1.g * ( 1.0 - wPath * 0.55 ) + slope * 0.42;
  float wEar  = M1.b + wPath * 2.05 + slope * 1.35;
  float wMos  = M1.a * ( 1.0 - wPath * 0.30 );
  // Beyond the reach of the instanced blades the ground has to CARRY the meadow
  // on its own: bias it back toward lush green so the grass edge does not read as
  // a horizontal seam with a khaki band above it.
  float far = smoothstep( 52.0, 96.0, dist );
  wLush *= 1.0 + far * 0.55;
  wDry  *= 1.0 - far * 0.45;
  wEar  *= 1.0 - far * 0.30;
  float sum   = wLush + wDry + wEar + wMos + 1e-4;

  /* ---- per-layer albedo -------------------------------------------- */
  // ART_BIBLE §3: grass is lighter + yellower where the sun has bleached the
  // fibre tips, cooler and darker down in the sward.
  float bleach = clamp( fibre * 1.18 - 0.24 + hi * 0.16, 0.0, 1.0 );
  vec3 grassC = mix( uGrassBase, uGrassTip, bleach );
  grassC = mix( grassC, uGrassTip * 1.10, pow( clamp( dC.r, 0.0, 1.0 ), 2.2 ) * 0.34 );
  grassC *= 0.94 + 0.14 * cell;

  vec3 dryC  = mix( uGrassDry * 0.80, uGrassDry * 1.14, clamp( fibre * 1.2, 0.0, 1.0 ) );
  vec3 earthC = mix( uEarthDark, uEarth, clamp( grain * 1.35 + cell * 0.30, 0.0, 1.0 ) );
  // the trodden path is packed pale gravel, not wet chocolate loam
  float pathCol = smoothstep( 0.03, 0.44, M2.r );
  earthC = mix( earthC, uPathEarth * ( 0.86 + 0.30 * grain ), pathCol * 0.90 );
  // gravel: bright stone chips wherever a worley cell centre lands
  earthC = mix( earthC, uStone, pathCol * smoothstep( 0.50, 0.86, 1.0 - cell ) * 0.55
                              + M2.b * smoothstep( 0.70, 0.95, 1.0 - cell ) * 0.30 );
  vec3 mossC = mix( uMoss * 0.74, uMoss * 1.16, clamp( cell * 1.5, 0.0, 1.0 ) );

  vec3 albedo = ( grassC * wLush + dryC * wDry + earthC * wEar + mossC * wMos ) / sum;

  // Mid-scale meadow patchwork, computed IN THE SHADER so it survives every
  // quality tier. The baked macro map is 384..768 px over 244 m, so past ~40 m
  // it mips down to a single value and the far meadow collapses to one flat
  // lime — which is exactly what the low tier was showing. Two shader octaves keep
  // meadow-patch structure at any distance and at any macro resolution.
  float pA = snoise( vec3( wxz * 0.047, 11.3 ) );
  float pB = snoise( vec3( wxz * 0.163, 27.9 ) );
  float mead = pA * 0.64 + pB * 0.36;
  albedo *= 1.0 + mead * 0.22;
  albedo = mix( albedo, albedo * vec3( 1.12, 0.99, 0.79 ), clamp(  mead, 0.0, 1.0 ) * 0.45 );
  albedo = mix( albedo, albedo * vec3( 0.86, 1.00, 0.95 ), clamp( -mead, 0.0, 1.0 ) * 0.42 );

  // large-scale value + temperature drift: the ground must never be one colour
  float lv = M2.a * 2.0 - 1.0;
  albedo *= 1.0 + lv * 0.25;
  albedo = mix( albedo, albedo * vec3( 1.09, 1.00, 0.88 ), clamp( lv, 0.0, 1.0 ) * 0.55 );
  albedo = mix( albedo, albedo * vec3( 0.92, 1.00, 1.10 ), clamp( -lv, 0.0, 1.0 ) * 0.45 );

  /* ---- fallen-petal accumulation, thickest under the tree ----------- */
  float pr = clamp( 1.0 - length( wxz ) / 15.0, 0.0, 1.0 );
  float cov = uPetalAmt * ( 0.14 + 0.88 * pr * pr ) * ( 0.35 + 1.05 * M2.g );
  float pm  = smoothstep( 0.52, 0.84, cell * 0.55 + dF.a * 0.30 + hi * 0.32 );
  float pet = clamp( cov, 0.0, 1.0 ) * pm * ( 1.0 - wPath * 0.30 );
  vec3 petC = mix( uPetalLo, uPetalHi, clamp( dF.g * 1.3 - 0.1, 0.0, 1.0 ) );
  albedo = mix( albedo, petC, pet * 0.68 );

  /* ---- micro normal ------------------------------------------------- */
  float bumpFade = 1.0 - smoothstep( 10.0, 44.0, dist );
  vec3 nF = texture2D( uDetailN, wxz * uDetailTile.x ).xyz * 2.0 - 1.0;
  vec3 nC = texture2D( uDetailN, wxz * uDetailTile.y + vec2( 0.317, 0.643 ) ).xyz * 2.0 - 1.0;
  vec3 pert = vec3( nF.x * 0.95 + nC.x * 0.55, 0.0, nF.y * 0.95 + nC.y * 0.55 );
  vec3 N = normalize( N0 + pert * uBump * ( 0.22 + 0.78 * bumpFade ) );

  float ao = 1.0 - 0.26 * ( 1.0 - dF.a ) * bumpFade - 0.10 * ( wMos / sum );
  float spec = ( 0.14 * wLush + 0.16 * wDry + 0.34 * wEar + 0.20 * wMos ) / sum
             + pet * 0.20;

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  vec3 Ng = nprGeoNormal( vWorldPos, N0 );
  vec3 col = nprShadeN( albedo, N, Ng, V, sm,
                        0.30 + pet * 0.35, 0.30 + pet * 0.25,
                        spec, 0.80, clamp( ao, 0.0, 1.0 ) );
  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 2. Instanced grass
 * ===================================================================== */

export const GRASS_VERT = /* glsl */`
attribute vec4 aOff;   // xyz = base position, w = yaw
attribute vec4 aPar;   // x = height, y = width, z = phase, w = bendBias
attribute vec4 aVar;   // x = rank(0..1), y = dryness, z = ao, w = tintJitter

varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vT;
varying float vDry;
varying float vAO;
varying float vJit;

uniform vec3  uCamPos;
uniform vec3  uFade;    // (fadeNear, fadeFar, farDensity)
uniform vec3  uNear;    // (nearFadeStart, nearFadeEnd, strength) metres
uniform float uWidthComp; // density compensation: fewer blades => wider blades
uniform float uBend;
uniform float uGrow;    // global 0..1 spawn-in, lets quality changes not pop

#include <common>
#include <shadowmap_pars_vertex>
${GLSL_NOISE}
${GLSL_WIND}

void main(){
  float t = position.y;
  vT = t; vDry = aVar.y; vAO = aVar.z; vJit = aVar.w;

  // ---- distance density: fewer blades far away, but never zero -------
  float dcam = length( uCamPos.xz - aOff.xz );
  float dens = mix( 1.0, uFade.z, smoothstep( uFade.x, uFade.y, dcam ) );
  float live = 1.0 - smoothstep( dens - 0.14, dens + 0.01, aVar.x );
  // distant survivors get taller so they still cover a pixel or two
  float H = aPar.x * live * uGrow * ( 1.0 + 0.55 * smoothstep( uFade.x, uFade.y, dcam ) );
  float W = aPar.y * ( 1.0 + 0.35 * smoothstep( uFade.x, uFade.y, dcam ) ) * uWidthComp;

  // ---- near-camera fade ----------------------------------------------
  // A blade 40 cm from the lens is 130 px wide and hides the whole shot; the
  // 'canopy' preset puts the eye at 1.2 m, i.e. INSIDE the sward. Shrink (never
  // hard-clip) blades that are both close AND tall enough to rise into the eye,
  // so a high camera like 'hero' keeps every blade of its foreground framing.
  float dNear = length( uCamPos - ( aOff.xyz + vec3( 0.0, H * 0.5, 0.0 ) ) );
  float nearK = smoothstep( uNear.x, uNear.y, dNear );
  float eyeK  = smoothstep( -0.55, 0.20, aOff.y + H - uCamPos.y ) * uNear.z;
  float nearF = mix( 1.0, nearK, eyeK );
  H *= nearF;
  W *= mix( 1.0, nearK, eyeK * 0.85 );

  float c = cos( aOff.w ), s = sin( aOff.w );
  // position.z carries the static droop as a FRACTION OF HEIGHT
  vec3 lp = vec3( position.x * W, position.y * H, position.z * H );
  vec3 rp = vec3( lp.x * c - lp.z * s, lp.y, lp.x * s + lp.z * c );
  vec3 nl = normal;
  vec3 rn = vec3( nl.x * c - nl.z * s, nl.y, nl.x * s + nl.z * c );

  // ---- wind: the blade BENDS about its base (t^2), it never slides ----
  vec3 base = aOff.xyz;
  vec3 wv = windOffset( base + vec3( 0.0, H, 0.0 ), 0.0 );
  float flut = sin( uWindTime * ( 4.6 + aPar.z * 3.4 ) + aPar.z * 25.13 ) * 0.060
             + sin( uWindTime * ( 9.7 + aPar.z * 2.1 ) + aPar.z * 11.71 ) * 0.024;
  vec2 wd = normalize( uWindDir + vec2( 1e-5, 1e-5 ) );
  vec2 disp = ( wv.xz * 1.35 + wd * flut * ( 0.55 + uWindGust ) ) * aPar.w * uBend;
  float bend = t * t;

  vec3 wpos = base + rp;
  wpos.xz += disp * bend * H;
  wpos.y  -= min( length( disp ) * 0.42, 0.9 ) * bend * H;   // arc-length-ish

  // tilt the shading normal with the bend so backlit tips catch transmission
  rn = normalize( rn + vec3( disp.x, 0.0, disp.y ) * ( 1.7 * t ) + vec3( 0.0, 0.22, 0.0 ) );

  vec4 wp = modelMatrix * vec4( wpos, 1.0 );
  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * rn );
  vWorldNormal = wn;
${SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GRASS_FRAG = /* glsl */`
varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying float vT;
varying float vDry;
varying float vAO;
varying float vJit;

uniform vec3 uBaseCol;   // #3E6134 cool, at the root
uniform vec3 uMidCol;
uniform vec3 uTipCol;    // #8FB463 warm, sun-bleached
uniform vec3 uDryCol;
uniform float uTipBias;  // LOD: 0 at authored density, 1 when blades are scarce

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}

void main(){
  // lighter AND yellower toward the tip — the single biggest grass tell.
  // At a low tier one blade stands in for several, so it has to be shaded like
  // the AGGREGATE it represents (tip-dominated) rather than like a single blade;
  // otherwise the sward turns into scattered dark needles on a bright plane.
  float t = clamp( vT * ( 1.0 + uTipBias * 0.85 ) + uTipBias * 0.22, 0.0, 1.0 );
  vec3 albedo = mix( uBaseCol, uMidCol, smoothstep( 0.0, 0.55, t ) );
  albedo = mix( albedo, uTipCol, smoothstep( 0.42, 1.0, t ) );
  albedo = mix( albedo, uDryCol, vDry * ( 0.30 + 0.70 * t ) );
  albedo += uTipCol * pow( t, 5.0 ) * 0.20;
  albedo *= 0.86 + 0.30 * vJit;

  vec3 N = normalize( vWorldNormal );
  if ( !gl_FrontFacing ) N = -N;
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  float ao = clamp( vAO * ( 0.52 + 0.48 * t ), 0.0, 1.0 );
  // thin at the tip => more light bleeds THROUGH => backlit blades glow
  vec3 col = nprShadeN( albedo, N, N, V, sm, 1.0, mix( 0.40, 1.00, t ),
                        0.28, 1.30, ao );
  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 3. Instanced stone (path slabs, pebbles, boulders)
 * ===================================================================== */

export const STONE_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vTint;
#include <common>
#include <shadowmap_pars_vertex>
void main(){
  vec3 tp = position;
  vec3 tn = normal;
  #ifdef USE_INSTANCING
    tp = ( instanceMatrix * vec4( tp, 1.0 ) ).xyz;
    tn = mat3( instanceMatrix ) * tn;
  #endif
  vTint = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vec4 wp = modelMatrix * vec4( tp, 1.0 );
  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * tn );
  vWorldNormal = wn;
${SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const STONE_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vTint;

uniform vec3  uStoneLite;
uniform vec3  uStoneDark;
uniform vec3  uMossLite;
uniform vec3  uMossDark;
uniform float uMossAmt;
uniform float uNoiseScale;

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}

void main(){
  vec3 N0 = normalize( vWorldNormal );
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  vec3 p = vWorldPos * uNoiseScale;
  float n1 = fbm( p, 4 ) * 0.5 + 0.5;
  float n2 = fbm( p * 4.3 + 11.7, 3 ) * 0.5 + 0.5;
  float cr = worley( vWorldPos.xz * uNoiseScale * 2.4 + vWorldPos.y * 0.7 );

  vec3 stone = mix( uStoneDark, uStoneLite, clamp( n1 * 1.25 - 0.06, 0.0, 1.0 ) );
  stone = mix( stone, uStoneLite * 1.12, pow( n2, 3.0 ) * 0.45 );          // mica flecks
  float crev = smoothstep( 0.32, 0.02, cr );
  stone = mix( stone, uStoneDark * 0.62, crev * 0.75 );                    // crevices

  float up = clamp( N0.y, 0.0, 1.0 );
  float moss = smoothstep( 0.30, 0.78, up * 0.85 + n1 * 0.70 - 0.28 ) * uMossAmt;
  moss = max( moss, crev * uMossAmt * 0.55 );                              // moss in cracks
  vec3 albedo = mix( stone, mix( uMossDark, uMossLite, n2 ), moss ) * vTint;

  vec3 N = normalize( N0 + vec3( ( n2 - 0.5 ) * 0.7, 0.0, ( n1 - 0.5 ) * 0.7 )
                          * ( 1.0 - smoothstep( 6.0, 30.0, dist ) ) * 0.45 );

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  float ao = 1.0 - crev * 0.35;
  vec3 col = nprShadeN( albedo, N, nprGeoNormal( vWorldPos, N0 ), V, sm,
                        moss * 0.35, 0.30, mix( 0.55, 0.16, moss ), 0.95, ao );
  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 4. Procedural textures
 * ===================================================================== */

/* ---- periodic (exactly tileable) value noise + worley ---------------- */
function ph(ix, iy, px, py, seed) {
  ix = ((ix % px) + px) % px;
  iy = ((iy % py) + py) % py;
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function pv(u, v, px, py, seed) {
  const x = u * px, y = v * py;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = ph(ix, iy, px, py, seed), b = ph(ix + 1, iy, px, py, seed);
  const c = ph(ix, iy + 1, px, py, seed), d = ph(ix + 1, iy + 1, px, py, seed);
  const ab = a + (b - a) * sx, cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}
/** Tileable fbm. `px/py` are the base cell counts across the tile. */
function pfbm(u, v, px, py, oct, seed) {
  let s = 0, a = 0.5, n = 0, m = 1;
  for (let i = 0; i < oct; i++) {
    s += a * pv(u, v, px * m, py * m, seed + i * 131);
    n += a; a *= 0.5; m *= 2;
  }
  return s / n;
}
/** Tileable worley F1 in [0,1]. */
function pworley(u, v, cx, cy, seed) {
  const x = u * cx, y = v * cy;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 8;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = ix + dx, gy = iy + dy;
      const rx = ph(gx, gy, cx, cy, seed);
      const ry = ph(gx, gy, cx, cy, seed + 9917);
      const d = (gx + rx - x) ** 2 + (gy + ry - y) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) / 1.1);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };

/**
 * The tiling DETAIL map. One tile = `metres` of world.
 *   R fibre  streaky grass-blade direction field
 *   G grain  soil / sand speckle
 *   B cell   worley clumping (moss, pebble chips, petal blobs)
 *   A bump   composite height, used for the derived normal map + AO
 */
function bakeDetail(size, seed) {
  const px = new Uint8Array(size * size * 4);
  const bump = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      // anisotropic streaks — many cycles across x, few across y => fibres
      const f1 = pfbm(u, v, 64, 8, 3, seed);
      const f2 = pfbm(u + 0.37, v, 128, 16, 2, seed + 71);
      let fibre = clamp01(f1 * 0.68 + f2 * 0.42 - 0.06);
      // rotate a second fibre system in so the sward is not combed one way
      const f3 = pfbm(v, u, 48, 8, 3, seed + 211);
      fibre = clamp01(fibre * 0.62 + f3 * 0.52);
      fibre = clamp01(Math.pow(fibre, 0.82));

      const grain = clamp01(pfbm(u, v, 96, 96, 4, seed + 401) * 1.15 - 0.06);
      const w1 = pworley(u, v, 32, 32, seed + 601);
      const w2 = pworley(u + 0.5, v + 0.25, 12, 12, seed + 733);
      const cell = clamp01(1.0 - (w1 * 0.72 + w2 * 0.38));

      const b = clamp01(fibre * 0.44 + grain * 0.26 + cell * 0.30);
      const o = (j * size + i);
      px[o * 4 + 0] = (fibre * 255) | 0;
      px[o * 4 + 1] = (grain * 255) | 0;
      px[o * 4 + 2] = (cell * 255) | 0;
      px[o * 4 + 3] = (b * 255) | 0;
      bump[o] = b;
    }
  }
  // ---- derive a tangent-space normal from `bump` (wrapped sobel)
  const nrm = new Uint8Array(size * size * 4);
  const at = (i, j) => bump[((j + size) % size) * size + ((i + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const gx = (at(i + 1, j) - at(i - 1, j)) * 2.4;
      const gy = (at(i, j + 1) - at(i, j - 1)) * 2.4;
      let nx = -gx, ny = -gy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (j * size + i) * 4;
      nrm[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      nrm[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      nrm[o + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
      nrm[o + 3] = 255;
    }
  }
  return { px, nrm };
}

/**
 * The world-mapped MACRO maps. Baked once from the real height field so the
 * layer blend agrees with the mesh: earth on the steep bits, moss in the damp
 * hollows, dry grass on the exposed rises.
 *
 * @param {object} o
 * @param {number} o.extent    macro covers [-extent, +extent] in x and z
 * @param {function} o.heightAt
 * @param {number[][]} o.path  polyline (already sampled) of the stone path, XZ
 */
function bakeMacro({ size, extent, heightAt, path, pathWidth, seed }) {
  const m1 = new Uint8Array(size * size * 4);
  const m2 = new Uint8Array(size * size * 4);
  const step = (2 * extent) / size;

  // slope from a cheap height grid (4x coarser than the macro map)
  const HS = size >> 1;
  const hg = new Float32Array(HS * HS);
  const hstep = (2 * extent) / HS;
  for (let j = 0; j < HS; j++) {
    for (let i = 0; i < HS; i++) {
      hg[j * HS + i] = heightAt(-extent + (i + 0.5) * hstep, -extent + (j + 0.5) * hstep);
    }
  }
  const hAt = (i, j) => hg[Math.min(HS - 1, Math.max(0, j)) * HS + Math.min(HS - 1, Math.max(0, i))];

  for (let j = 0; j < size; j++) {
    const z = -extent + (j + 0.5) * step;
    const hj = (j * HS / size) | 0;
    for (let i = 0; i < size; i++) {
      const x = -extent + (i + 0.5) * step;
      const hi = (i * HS / size) | 0;
      const h = hAt(hi, hj);
      const dhx = (hAt(hi + 1, hj) - hAt(hi - 1, hj)) / (2 * hstep);
      const dhz = (hAt(hi, hj + 1) - hAt(hi, hj - 1)) / (2 * hstep);
      const slope = clamp01(Math.hypot(dhx, dhz) * 1.7);

      const nL = fbm3(x * 0.0135, 0.5, z * 0.0135, 4);
      const nM = fbm3(x * 0.082, 5.1, z * 0.082, 4);
      const nF = fbm3(x * 0.34, 9.7, z * 0.34, 3);
      const wo = worley2(x * 0.22, z * 0.22, 1);

      // path distance (polyline min distance)
      let pd = 1e9, pt = 0;
      for (let k = 0; k < path.length - 1; k++) {
        const ax = path[k][0], az = path[k][1], bx = path[k + 1][0], bz = path[k + 1][1];
        const ex = bx - ax, ez = bz - az;
        const el = ex * ex + ez * ez || 1e-6;
        let t = ((x - ax) * ex + (z - az) * ez) / el;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (ax + ex * t), dz = z - (az + ez * t);
        const d = dx * dx + dz * dz;
        if (d < pd) { pd = d; pt = (k + t) / (path.length - 1); }
      }
      pd = Math.sqrt(pd);
      const halfW = pathWidth * (0.5 + 0.22 * fbm3(pt * 9.3, 21.7, 0, 3));
      const pathM = sstep(halfW * 1.55, halfW * 0.55, pd);

      let lush = clamp01(0.76 + nL * 0.85 + nM * 0.34 - slope * 1.9 - nF * 0.12);
      let dry = clamp01(0.16 - nL * 0.78 + nM * 0.62 + (h - 0.9) * 0.26 + nF * 0.20);
      let earth = clamp01(slope * 2.3 - 0.22 + nF * 0.40 + nM * 0.32 - 0.24 + wo * 0.18);
      let moss = clamp01(0.20 + (0.48 - wo) * 1.45 + nM * 0.40 - slope * 0.5 - (h - 0.7) * 0.55);
      const s = lush + dry + earth + moss + 1e-4;
      lush /= s; dry /= s; earth /= s; moss /= s;

      const petalBias = clamp01(0.5 + fbm3(x * 0.16, 31.4, z * 0.16, 3) * 1.05);
      const rocky = clamp01(slope * 1.4 + (0.42 - wo) * 1.1 + nF * 0.3 - 0.15);
      const large = clamp01(0.5 + (fbm3(x * 0.031 + 17.1, 3.3, z * 0.031, 3) * 0.90
        + fbm3(x * 0.0092 + 41.7, 8.8, z * 0.0092, 3) * 0.85) * 0.82);

      const o = (j * size + i) * 4;
      m1[o] = (lush * 255) | 0;
      m1[o + 1] = (dry * 255) | 0;
      m1[o + 2] = (earth * 255) | 0;
      m1[o + 3] = (moss * 255) | 0;
      m2[o] = (pathM * 255) | 0;
      m2[o + 1] = (petalBias * 255) | 0;
      m2[o + 2] = (rocky * 255) | 0;
      m2[o + 3] = (large * 255) | 0;
    }
  }
  return { m1, m2 };
}

function dataTex(data, size, { colorSpace = THREE.NoColorSpace, repeat = false, aniso = 1 } = {}) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Bake every ground texture. Returns THREE textures ready to bind.
 * @param {object} o { extent, heightAt, path, pathWidth, macroSize, detailSize, aniso, seed }
 */
export function makeGroundTextures(o) {
  const {
    extent, heightAt, path, pathWidth = 1.9,
    macroSize = 768, detailSize = 512, aniso = 1, seed = 4211,
  } = o;
  const { m1, m2 } = bakeMacro({ size: macroSize, extent, heightAt, path, pathWidth, seed });
  const { px, nrm } = bakeDetail(detailSize, seed + 77);
  return {
    macro: dataTex(m1, macroSize, { aniso }),
    macro2: dataTex(m2, macroSize, { aniso }),
    detail: dataTex(px, detailSize, { repeat: true, aniso }),
    detailN: dataTex(nrm, detailSize, { repeat: true, aniso }),
  };
}

/* ---- alpha sprites: clover, wildflower, fallen petal ----------------- */

/**
 * Sprite bakery. `paint` fills the WHOLE canvas with colour and `mask` draws the
 * silhouette; the mask is then applied with destination-in. Painting edge to
 * edge means the transparent texels still carry the sprite's own colour, so
 * mipmapping and bilinear filtering can never produce the dark halo that a
 * clearRect-then-draw sprite gets around every alpha-tested edge.
 */
function spriteCanvas(size, paint, mask) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  paint(g, size);
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = '#000';
  mask(g, size);
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* ---- clover: three round leaflets with a paler central vein ---------- */
function cloverLeaflets(g, S) {
  const cx = S * 0.5, cy = S * 0.60;
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + (k - 1) * 1.05;
    const lx = cx + Math.cos(a) * S * 0.20;
    const ly = cy + Math.sin(a) * S * 0.20;
    const r = S * 0.195;
    g.beginPath();
    g.moveTo(lx, ly + r * 0.9);
    g.bezierCurveTo(lx - r * 1.25, ly + r * 0.2, lx - r * 0.95, ly - r * 1.05, lx, ly - r * 0.42);
    g.bezierCurveTo(lx + r * 0.95, ly - r * 1.05, lx + r * 1.25, ly + r * 0.2, lx, ly + r * 0.9);
    g.fill();
  }
  g.fillRect(cx - S * 0.014, cy, S * 0.028, S * 0.40);
}
function paintClover(g, S) {
  const grd = g.createLinearGradient(0, S * 0.15, 0, S);
  grd.addColorStop(0, '#A6C273');
  grd.addColorStop(0.45, '#6E9448');
  grd.addColorStop(1, '#39592F');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // leaf veins + a lighter chevron so a clump is not three flat discs
  g.strokeStyle = 'rgba(190,214,140,0.42)';
  g.lineWidth = Math.max(1, S * 0.014);
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + (k - 1) * 1.05;
    const lx = S * 0.5 + Math.cos(a) * S * 0.20;
    const ly = S * 0.60 + Math.sin(a) * S * 0.20;
    g.beginPath(); g.moveTo(S * 0.5, S * 0.60); g.lineTo(lx, ly - S * 0.10); g.stroke();
  }
}

/* ---- wildflower head ------------------------------------------------- */
function flowerShape(g, S) {
  const cx = S * 0.5, cy = S * 0.5, R = S * 0.36;
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (Math.PI * 2 / 5);
    const px = cx + Math.cos(a) * R * 0.60, py = cy + Math.sin(a) * R * 0.60;
    g.beginPath();
    g.ellipse(px, py, R * 0.42, R * 0.58, a + Math.PI / 2, 0, Math.PI * 2);
    g.fill();
  }
  g.beginPath(); g.arc(cx, cy, R * 0.30, 0, Math.PI * 2); g.fill();
}
function paintFlower(g, S, petal, core) {
  g.fillStyle = petal;
  g.fillRect(0, 0, S, S);
  const cx = S * 0.5, cy = S * 0.5, R = S * 0.36;
  const grd = g.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 0.85);
  grd.addColorStop(0, core);
  grd.addColorStop(0.34, core);
  grd.addColorStop(0.46, petal);
  grd.addColorStop(1, '#FFFFFF');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
}

/* ---- a single sakura petal, notched tip ------------------------------ */
function petalShape(g, S) {
  const cx = S * 0.5;
  g.beginPath();
  g.moveTo(cx, S * 0.94);
  g.bezierCurveTo(S * 0.08, S * 0.74, S * 0.09, S * 0.24, S * 0.41, S * 0.11);
  g.bezierCurveTo(S * 0.46, S * 0.23, S * 0.54, S * 0.23, S * 0.59, S * 0.11);
  g.bezierCurveTo(S * 0.91, S * 0.24, S * 0.92, S * 0.74, cx, S * 0.94);
  g.fill();
}
function paintPetal(g, S) {
  const cx = S * 0.5;
  const grd = g.createLinearGradient(0, S * 0.08, 0, S * 0.98);
  grd.addColorStop(0, '#FFE7EE');
  grd.addColorStop(0.34, '#FFD9E6');
  grd.addColorStop(0.72, '#FFB6CE');
  grd.addColorStop(1, '#DE7CA0');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(194,95,134,0.26)';
  g.lineWidth = Math.max(1, S * 0.009);
  for (let k = -1; k <= 1; k++) {
    g.beginPath();
    g.moveTo(cx, S * 0.92);
    g.quadraticCurveTo(cx + k * S * 0.13, S * 0.55, cx + k * S * 0.16, S * 0.22);
    g.stroke();
  }
}

export function makeSpriteTextures(size = 128) {
  return {
    clover: spriteCanvas(size, paintClover, cloverLeaflets),
    flowerWhite: spriteCanvas(size, (g, S) => paintFlower(g, S, '#F4EBDA', '#E8C56A'), flowerShape),
    flowerYellow: spriteCanvas(size, (g, S) => paintFlower(g, S, '#EEDA93', '#C79A34'), flowerShape),
    petal: spriteCanvas(size, paintPetal, petalShape),
  };
}
