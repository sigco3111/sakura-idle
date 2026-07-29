/**
 * water-shaders.js — GLSL + procedural asset builders for the pond (25-water.js).
 * Owner: water agent. Nothing else in the project may edit this file.
 *
 * Everything here obeys CONTRACT.md §"Shared lighting uniforms": every surface
 * includes GLSL_NPR and resolves its final colour through nprShadeN + applyAerial,
 * so the pond agrees with the terrain, the tree and the sky at every time of day.
 *
 * Contents
 *   1. GLSL_WATER_COMMON  — wave field, pooled ripple rings, depth lookup, the
 *                           analytic sky/canopy reflection used as the fallback
 *                           (and as the out-of-bounds filler for the real one).
 *   2. WATER_VERT / WATER_FRAG  — the surface. Fresnel between a reflected sky /
 *                           canopy and a depth-graded transmitted body colour,
 *                           premultiplied-alpha so the blend IS the absorption.
 *   3. BED_VERT / BED_FRAG      — silt/pebble bed + the muddy shoreline ring that
 *                           makes the waterline a soft blend, plus worley caustics.
 *   4. REED_VERT / REED_FRAG    — wind-swayed shore reeds (they are also what the
 *                           water has to reflect from most camera angles).
 *   5. Builders: pond depth texture, bed dish geometry, blade + stone geometry,
 *      and the floating-petal texture.
 *
 * The depth texture is the trick that keeps the waterline honest: 20-terrain owns
 * the height field, so we BAKE (waterDepth, bankHeight) over the pond footprint
 * from its published heightAt() and read it in every pond shader. Water, bed,
 * caustics and shore wetness therefore share one definition of "where the edge
 * is", and it is the real terrain's edge, wobbles and all — never a circle.
 */
import { GLSL_NOISE } from './noise.js';
import { GLSL_WIND } from './wind.js';
import { GLSL_NPR } from './lighting.js';

/** Pooled expanding-ring slots. Uniform array, so a ripple never allocates.
 *  16, up from 10: §6 wants a ring on every petal-water contact and the rings now
 *  only live 1.4 s (see RIPPLE_LIFE), so the pool has to be able to hold the
 *  4-6 that a blooming tree keeps in the air at once. */
export const MAX_RIPPLES = 16;

/** A petal ring reaches this radius (metres) at RIPPLE_LIFE seconds, then dies.
 *  Prescription: "radius 0 -> 0.55 m over 1.4 s, amplitude decaying to zero". */
export const RIPPLE_R = 0.55;
export const RIPPLE_LIFE = 1.40;
export const RIPPLE_SPEED = RIPPLE_R / RIPPLE_LIFE;   // 0.393 m/s

/** Metres of depth the R channel of the depth texture spans (0..1 -> 0..this). */
export const DEPTH_SCALE = 1.20;
/** Metres of bank height above the waterline the G channel spans. */
export const BANK_SCALE = 0.90;

/* ===================================================================== *
 * 1. Shared GLSL — waves, ripples, depth, analytic reflection
 * ===================================================================== */

export const GLSL_WATER_COMMON = /* glsl */`
#ifndef SAKURA_WATER_COMMON
#define SAKURA_WATER_COMMON

uniform sampler2D uDepthMap;    // R = depth / uDepthScale, G = bank / uBankScale
uniform vec3  uPondCentre;      // (x, waterY, z)
uniform float uPondSpan;        // metres covered by the depth texture (full width)
uniform float uDepthScale;
uniform float uBankScale;
uniform float uDepthTexel;      // 1 / depth-texture size
uniform float uRippleAmp;       // global slope multiplier on the wave field
uniform float uChop;            // transient extra chop (gust / tree shake)
uniform vec4  uRipples[ ${MAX_RIPPLES} ];   // (x, z, ageSeconds, strength)

vec2 pondUv( vec2 worldXZ ){
  return ( worldXZ - uPondCentre.xz ) / uPondSpan + 0.5;
}

/** Water depth in metres at a world XZ (0 outside the pool). */
float pondDepth( vec2 worldXZ ){
  vec2 uv = pondUv( worldXZ );
  if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 0.0;
  return texture2D( uDepthMap, uv ).r * uDepthScale;
}

/**
 * Four-tap depth, used by the SURFACE only.
 * MEASURED: the waterline printed as a 3-5 px stair-stepped arc (pond preset, the
 * right-hand shore at x 1180-1350 y 470-510). Bilinear filtering is C0 but not C1,
 * so an iso-contour of the depth map follows the TEXEL DIAGONALS — at a grazing
 * angle each texel is a few pixels tall and many wide, which is exactly a
 * staircase. Averaging four taps three quarters of a texel out makes the contour
 * C1 and the steps disappear; the texture also went 256 -> 512 (3 cm/texel), so
 * what remains is under a pixel.
 */
float pondDepthSoft( vec2 worldXZ ){
  float e = uPondSpan * uDepthTexel * 0.75;
  return 0.25 * ( pondDepth( worldXZ + vec2(  e,  e ) )
                + pondDepth( worldXZ + vec2( -e,  e ) )
                + pondDepth( worldXZ + vec2(  e, -e ) )
                + pondDepth( worldXZ + vec2( -e, -e ) ) );
}

/** Height of the bank ABOVE the waterline in metres (0 inside the pool). */
float pondBank( vec2 worldXZ ){
  vec2 uv = pondUv( worldXZ );
  if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return uBankScale;
  return texture2D( uDepthMap, uv ).g * uBankScale;
}

vec2 waterRot( vec2 v, float a ){
  float c = cos( a ), s = sin( a );
  return vec2( v.x * c - v.y * s, v.x * s + v.y * c );
}

/**
 * Three-band travelling wave field, all bands driven by the SHARED wind
 * direction so the ripples move with the same gusts as the grass and the petals.
 * Returns vec3( height, dh/dx, dh/dz ) — analytic gradients, so the normal is
 * exact and costs no extra taps.
 *
 * MEASURED, and the whole reason this is banded rather than two layers: the
 * previous field ran the SWELL at lambda 1.75 m with a full-strength gradient
 * (slope a*k = 0.054 per train, ~0.27 summed). Seen at the pond camera's 8 deg
 * grazing angle a 1.75 m wave train is 40-60 px tall on screen, so the Fresnel
 * term swung between reflection and body colour across bands that wide and the
 * pool printed as diagonal woven plaid (critic: "reads as woven fabric").
 *
 *   swell  lambda 1.75 .. 0.87 m — HEIGHT kept, gradient cut to 18%. Its job is
 *          the broad value variation in the body, not the normal.
 *   ripple lambda 0.35 .. 0.21 m — the band that carries the normal. 14 px at
 *          the near shore, so no band exceeds the 15 px ceiling.
 *   chop   lambda 0.11 .. 0.07 m — sparkle only, gust-scaled.
 *
 * slopeFade damps the two high bands with view distance: an analytic normal has
 * no mip chain, so undamped 0.1 m chop 15 m away is pure aliasing shimmer.
 */
vec3 waterWaves( vec2 p, float t, float gust, float slopeFade ){
  vec2 d = normalize( uWindDir + vec2( 1e-5 ) );
  vec3 acc = vec3( 0.0 );

  // low-frequency phase warp: without it nine sines read as a moiré grid
  float warp = snoise( vec2( p * 0.19 + d * t * 0.05 ) ) * 1.7;

  // --- swell: height for the body, almost no slope
  for ( int i = 0; i < 3; i ++ ) {
    float fi = float( i );
    // 0.86 rad of spread, not 0.44: three near-parallel wave trains seen at the
    // pond camera's grazing angle compressed into regular horizontal stripes
    // (a venetian blind across the pool). Crossing them breaks the banding.
    vec2  dir = waterRot( d, ( fi - 1.0 ) * 0.86 );
    float k = 3.6 + fi * 1.8;
    float w = 1.02 + fi * 0.31;
    float a = ( 0.0110 - fi * 0.0026 ) * uRippleAmp;
    float ph = dot( p, dir ) * k - t * w + warp * 0.95;
    acc.x  += a * sin( ph );
    acc.yz += dir * ( a * k * 0.18 * cos( ph ) );
  }

  // --- ripple: the band that actually shapes the surface
  float rf = uRippleAmp * mix( 0.30, 1.0, slopeFade );
  for ( int i = 0; i < 3; i ++ ) {
    float fi = float( i );
    vec2  dir = waterRot( d, ( fi - 1.0 ) * 1.05 + 0.21 );
    float k = 18.0 + fi * 6.0;
    float w = 2.15 + fi * 0.72;
    float a = ( 0.00130 - fi * 0.00035 ) * rf;
    float ph = dot( p, dir ) * k - t * w + warp * 1.35;
    acc.x  += a * sin( ph );
    acc.yz += dir * ( a * k * cos( ph ) );
  }

  // --- chop: sparkle, gust-scaled, hardest hit by the distance fade
  float gb = ( 0.34 + 0.80 * gust + uChop ) * uRippleAmp * slopeFade * slopeFade;
  for ( int i = 0; i < 3; i ++ ) {
    float fi = float( i );
    vec2  dir = waterRot( d, ( fi - 1.0 ) * 1.31 + 0.63 );
    float k = 56.0 + fi * 15.0;
    float w = 5.40 + fi * 1.90;
    float a = ( 0.000215 - fi * 0.000052 ) * gb;
    float ph = dot( p, dir ) * k - t * w + warp * 1.60;
    acc.x  += a * sin( ph );
    acc.yz += dir * ( a * k * cos( ph ) );
  }
  return acc;
}

/**
 * Pooled expanding rings. Each slot is (centreXZ, age, strength); the CPU ages
 * them and recycles the slot, so a ripple costs no allocation and no geometry.
 * Crest profile is a gaussian-windowed sine so a ring has one clear leading
 * crest and a shallow trailing trough, not a bullseye.
 */
vec3 waterRipples( vec2 p, out float crest ){
  vec3 acc = vec3( 0.0 );
  crest = 0.0;
  for ( int i = 0; i < ${MAX_RIPPLES}; i ++ ) {
    vec4 r = uRipples[ i ];
    if ( r.w <= 0.001 ) continue;
    vec2 dv = p - r.xy;
    float dist = length( dv ) + 1e-4;
    // A PETAL ring, not a boat wake: radius 0 -> ${RIPPLE_R.toFixed(2)} m over
    // ${RIPPLE_LIFE.toFixed(2)} s (${RIPPLE_SPEED.toFixed(3)} m/s), amplitude
    // decaying to exactly zero at the end of that life. The previous field ran at
    // 1.05 m/s for 3.4 s, i.e. a 3.6 m ring — three quarters of the pool wide, so
    // the pond read as one slow breathing bullseye instead of petal touchdowns.
    float rad = r.z * ${RIPPLE_SPEED.toFixed(4)};
    float wd  = 0.055 + 0.100 * r.z;
    float x   = ( dist - rad ) / wd;
    if ( abs( x ) > 2.6 ) continue;
    // Amplitude: a short attack (a ring is born as a crest, not as nothing) and a
    // decay that reaches zero AT the life so a slot never recycles on a visible
    // edge. The 1/(1+dist) term is what keeps a ring legible from 10 m away.
    float fade = ( 1.0 - smoothstep( 0.10, ${RIPPLE_LIFE.toFixed(2)}, r.z ) );
    float env = exp( -x * x ) * fade * r.w / ( 1.0 + dist * 0.55 );
    float ph  = x * 3.4;
    float amp = 0.017;
    acc.x  += amp * sin( ph ) * env;
    acc.yz += ( dv / dist ) * ( amp * cos( ph ) * ( 3.4 / wd ) * env );
    crest  += max( 0.0, cos( ph ) ) * env;
  }
  return acc;
}

/**
 * Analytic reflection: sky gradient + sun glitter + distant-hill band + a soft
 * blurred canopy blob where the reflected ray actually intersects the crown.
 * Used wholesale when ctx.quality.waterReflect is false, and as the filler where
 * the planar-reflection target has no data (behind the camera / off the edge), so
 * the two modes agree instead of the cheap one looking like a bug.
 */
uniform vec3  uCanopyCentre;
uniform float uCanopyRadius;
uniform vec3  uCanopyColor;
uniform float uCanopyAmount;
uniform vec3  uCanopyPure;      // the crown's own pink, undiluted by the sky lerp
uniform float uCanopyBounce;    // strength of the hemisphere-integrated crown term
uniform vec3  uHillColor;

/**
 * THE CROWN AS A LIGHT SOURCE, NOT AS A MIRROR IMAGE.
 *
 * Prescription [1a] asked for the tree to appear in the reflection pass. It is in
 * the pass — and it is geometrically absent anyway, which is why the pool printed
 * as a flat blue lens. MEASURED with tools/probe.mjs against the real
 * ctx.assets.tree.canopyBounds and the hero preset:
 *   crown sphere      centre (-1.76, 8.65, -0.62)  radius 8.71 m
 *   pond centre       (-9.00, 0.74, 6.00)          shore 3.54 .. 5.70 m
 *   mirror of crown crosses the water plane at (7.36, 0.74, 11.89)
 *                    = 17.4 m from the pond centre, i.e. out on the grass.
 * So a correct planar mirror shows this pond nothing but sky from hero, gameplay,
 * wide and pond alike, and no amount of "render the tree into the RT" changes it.
 *
 * What IS physical, and what the pool was missing, is the DIFFUSE half of the
 * water's response. From the pond the crown subtends a half-angle of 36-44 deg and
 * covers 8 % (far shore) to 31 % (the shore it overhangs) of the sky hemisphere.
 * The sub-surface skylight return integrates that whole hemisphere, so between a
 * twelfth and a third of the light coming back out of this water has been through
 * a backlit translucent pink canopy. Returning it as a cosine-weighted solid-angle
 * fraction also gives the pool a real spatial gradient — pink under the tree,
 * blue on the far side — which is what kills the §8.2 flat-region tell.
 */
float canopyIrradiance( vec3 origin ){
  vec3 oc = uCanopyCentre - origin;
  float D = length( oc );
  float sinH = clamp( uCanopyRadius / max( D, uCanopyRadius * 1.02 ), 0.0, 0.985 );
  float cosH = sqrt( max( 1.0 - sinH * sinH, 0.0 ) );
  float frac = 1.0 - cosH;                       // solid angle / hemisphere
  // a crown low on the horizon lights the water less than one overhead
  float elev = clamp( oc.y / max( D, 1e-4 ), 0.0, 1.0 );
  return clamp( frac * ( 0.35 + 0.85 * elev ), 0.0, 1.0 );
}

/** uCanopyPure's hue and chroma at the incoming colour's own luminance — a hue
 *  REPLACEMENT, so mixing toward it cannot disturb the pool-vs-sky value match.
 *  Only ever used at a high weight inside the gated crescent below: at 0.2-0.4 it
 *  lands a blue-grey pool halfway to its near-complement and greys it out
 *  (MEASURED: sat 0.25 -> 0.06 with no useful hue change). */
vec3 canopyTint( vec3 base ){
  const vec3 LW = vec3( 0.2126, 0.7152, 0.0722 );
  float lc = max( dot( uCanopyPure, LW ), 1e-4 );
  float lb = max( dot( base, LW ), 1e-4 );
  return uCanopyPure * ( lb / lc );
}

/** The crown's colour as a luminance-neutral MULTIPLIER. This is what a coloured
 *  light source does — it lifts the reds and pulls the greens down, so chroma goes
 *  UP. Safe at any weight, which is why the broad sub-surface term uses it and the
 *  narrow crescent uses canopyTint. */
vec3 canopyMul(){
  const vec3 LW = vec3( 0.2126, 0.7152, 0.0722 );
  return uCanopyPure / max( dot( uCanopyPure, LW ), 1e-4 );
}
// Picked up BY REFERENCE from ctx.assets.sky.uniforms when 15-sky is present, so
// the analytic mirror samples the same gradient the dome above it is drawing.
// uHasSkyGrad = 0 falls back to the fog/sky pair from the lighting bag.
uniform vec3  uZenith;
uniform vec3  uMid;
uniform vec3  uHorizon;
uniform vec3  uHaze;
uniform float uZenithPow;
uniform float uMidAmt;
uniform float uHasSkyGrad;

vec3 waterSkyReflect( vec3 R, vec3 origin ){
  float up = clamp( R.y, 0.0, 1.0 );
  // horizon -> zenith. Deriving this from uFogColor alone printed the pool as wet
  // SAND at the medium/low tiers: uFogColor is the aerial-perspective colour, and
  // at the pond camera's 10 deg grazing angle it dominated the whole mirror.
  vec3 col;
  if ( uHasSkyGrad > 0.5 ) {
    float au = pow( up, max( uZenithPow, 0.05 ) );
    col = mix( uHorizon, uZenith, au );
    col = mix( col, uMid, uMidAmt * ( 1.0 - abs( au * 2.0 - 1.0 ) ) );
    col = mix( col, uHaze, 0.46 * ( 1.0 - smoothstep( 0.0, 0.16, up ) ) );
  } else {
    col = mix( uFogColor * 1.04, uSkyColor, pow( up, 0.62 ) );
  }

  // TRIED AND REJECTED: a reflected cloud deck for the analytic path. At the pond
  // camera R.y is ~0.15 and jitters per-pixel with the wave normal, so every mapping
  // (flat 240 m deck, and an angular R.xz/(up+k) one) aliased into noise that
  // integrated to a flat +0.03 L lift and pushed the pool BRIGHTER than the sky it
  // mirrors — measured 0.744 against a sky of 0.735. The wave field already gives the
  // analytic pool sd 0.08 over the pool, well clear of the flat-block threshold, so
  // there is nothing here worth paying a value regression for.

  // The distant hill / treeline band. Widened to 9 deg: the planar-reflection
  // version fills the grazing band with dark hills, and without them the cheap
  // path is a flat sheet of pale sky and reads as sand.
  float band = ( 1.0 - smoothstep( 0.0, 0.16, up ) ) * smoothstep( -0.02, 0.006, R.y );
  col = mix( col, uHillColor, band * 0.62 );

  // sun / moon glitter
  vec3 S = normalize( mix( uSunDir, uMoonDir, step( 0.5, uNightMix ) ) );
  float sd = max( dot( R, S ), 0.0 );
  col += uSunColor * ( pow( sd, 220.0 ) * 1.35 + pow( sd, 12.0 ) * 0.10 );

  // canopy: ray/sphere, softened toward the limb so it reads as a blurred mass
  vec3 oc = origin - uCanopyCentre;
  float b = dot( oc, R );
  float c = dot( oc, oc ) - uCanopyRadius * uCanopyRadius;
  float disc = b * b - c;
  if ( disc > 0.0 && -b + sqrt( disc ) > 0.0 ) {
    float chord = sqrt( disc ) / max( uCanopyRadius, 1e-3 );   // 0 limb .. 1 centre
    float soft = smoothstep( 0.02, 0.62, chord );
    col = mix( col, uCanopyColor, soft * uCanopyAmount );
  }
  // A water surface is not a perfect mirror: it swallows a little of everything it
  // reflects and lends it the body's hue. Also clamped, so a blown-out HDR horizon
  // can never drag the pool to white.
  col = mix( col, col * vec3( 0.86, 0.94, 0.90 ), 0.55 );
  return min( col, vec3( 2.4 ) );
}
#endif
`;

/* ===================================================================== *
 * 2. The water surface
 * ===================================================================== */

const SHADOW_VERT_BLOCK = /* glsl */`
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
`;

/** Fragment preamble every pond shader shares: three's shadow chunks, then NPR. */
const FRAG_PREAMBLE = /* glsl */`
#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
#define NPR_HAS_SHADOWMAP
${GLSL_NOISE}
${GLSL_WIND}
${GLSL_NPR}
`;

export const WATER_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec4 vReflCoord;
uniform mat4 uReflMatrix;

#include <common>
#include <shadowmap_pars_vertex>

void main(){
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPos = worldPosition.xyz;
  vec3 shadowWorldNormal = vec3( 0.0, 1.0, 0.0 );
  vReflCoord = uReflMatrix * worldPosition;
${SHADOW_VERT_BLOCK}
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const WATER_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec4 vReflCoord;

uniform sampler2D uReflTex;
uniform float uReflMix;        // 0 = analytic only, 1 = planar RT available
uniform float uReflDistort;    // screen-space UV perturbation, in UV units per unit slope
uniform vec3  uDeepColor;
uniform vec3  uShallowColor;
uniform float uOpacity;
uniform float uShoreFadeDepth; // metres of depth over which the edge fades in
uniform float uAbsorb;         // 1/e absorption distance factor
uniform float uGlint;
uniform float uSubRefl;        // grazing sub-surface skylight return (see below)
uniform float uReflGain;       // post-grade calibration on the mirror RT
uniform float uShoreDark;      // multiplier ON the waterline (1 = off)
uniform float uShoreDarkM;     // metres of DEPTH over which it eases back to 1
uniform float uCanopyHue;      // strength of the gated crescent tint
uniform vec2  uCanopyGate;     // smoothstep window on the raw irradiance fraction
uniform float uDebug;          // 0 off, 1 refl, 2 body, 3 reflWeight, 4 slope, 5 canopy

${FRAG_PREAMBLE}
${GLSL_WATER_COMMON}

void main(){
  vec2 p = vWorldPos.xz;

  // ---- depth, with a noise wobble so the waterline is never a clean curve.
  // The 19.0 octave (5 cm) is what breaks up the depth texture's own texel
  // diagonals; pondDepthSoft removes the rest of the staircase.
  float dRaw = pondDepthSoft( p );
  float wob = snoise( p * 2.35 ) * 0.011 + snoise( p * 6.1 ) * 0.005
            + snoise( p * 19.0 + 41.0 ) * 0.0024;
  float depth = max( dRaw + wob, 0.0 );
  float shore = smoothstep( 0.0, uShoreFadeDepth, depth );
  if ( shore <= 0.0015 ) discard;

  // ---- surface normal: three wave bands + the pooled ripple rings
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float gust = windGustEnv();
  // analytic normals have no mip chain: fade the high bands out with distance or
  // the far half of the pool is pure aliasing shimmer (and, through bloom, a
  // sparkling grey haze).
  float slopeFade = 1.0 / ( 1.0 + dist * 0.16 );
  vec3 wv = waterWaves( p, uWindTime, gust, slopeFade );
  float crest;
  vec3 rp = waterRipples( p, crest );
  // ripples and chop both die in the last few cm of depth — a ring cannot form
  // where the water is a film over mud, and that is what keeps the shore quiet.
  float wet = smoothstep( 0.0, 0.10, depth );
  vec2 grad = ( wv.yz + rp.yz * wet * mix( 0.45, 1.0, slopeFade ) );
  vec3 N = normalize( vec3( -grad.x, 1.0, -grad.y ) );

  float ndv = clamp( dot( N, V ), 0.0, 1.0 );

  // ---- Fresnel: textbook Schlick, F0 0.02, exponent 5. At the pond and hero
  // cameras' 6-9 deg grazing angles this lands F at 0.46-0.60 — which is what
  // water actually does, and on its own it left the pool half olive body colour
  // (measured 0.16 L below the sky it mirrors). The missing term is below.
  float F0 = 0.02;
  float F = F0 + ( 1.0 - F0 ) * pow( 1.0 - ndv, 5.0 );
  F = clamp( F, 0.0, 1.0 );

  // ---- reflection
  vec3 R = reflect( -V, N );
  R.y = max( R.y, 0.004 );                        // never sample below the plane
  vec3 refl = waterSkyReflect( R, vWorldPos );
  if ( uReflMix > 0.001 ) {
    vec2 ruv = vReflCoord.xy / max( vReflCoord.w, 1e-4 );
    // perturb in screen space, damped with distance so far ripples do not smear
    ruv += grad * uReflDistort / ( 1.0 + dist * 0.10 );
    vec2 e = min( ruv, 1.0 - ruv );
    float valid = smoothstep( 0.0, 0.035, min( e.x, e.y ) );
    // uReflGain: the mirror pass is raw scene radiance, while the sky the player
    // compares it against has been through bloom + the grade's highlight warm and
    // S-curve. Measured on the pond preset, the same cloud reads 8% lower in the
    // reflection than in the sky above it purely from that asymmetry. This is the
    // calibration for it and nothing else — it is not a licence to brighten water.
    // uReflGain is on the MIRROR ONLY. The analytic path is built from the sky
    // uniforms and already carries its own absorption factor: measured, it lands at
    // 0.710 against a sky of 0.735, so it needs no lift, and applying the gain there
    // too pushed the low tier to 0.744 — brighter than the sky. The mirror needs it
    // because the RT is raw scene radiance while the sky the player compares it
    // against has been through bloom and the grade's S-curve.
    vec3 rt = texture2D( uReflTex, clamp( ruv, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb * uReflGain;
    refl = mix( refl, rt, uReflMix * valid );
  }

  // ---- the transmitted body: shallow silty warm -> deep cool green
  vec3 albedo = mix( uShallowColor, uDeepColor, smoothstep( 0.045, 0.42, depth ) );
  // A pond at sunset is not the colour of the sunset: it is a warm sky over a cold
  // green body. Without this the dusk key dragged the whole pool warm and it read
  // as wet sand again (measured at the dusk anchor). Pull the body toward the SKY
  // zenith, which is the one cool source in frame at every phase.
  albedo = mix( albedo, albedo * 0.55 + uSkyColor * 0.30, 0.45 );
  nprSetWorldPos( vWorldPos );
  float sm = getShadowMask();
  vec3 body = nprShadeN( albedo, N, vec3( 0.0, 1.0, 0.0 ), V, sm, 0.30, 0.55, 1.5, 0.55, 1.0 );
  // Where the water column is deep enough to hide the bed the body is one flat
  // colour and the pool reads as soup. Modulating it by the wave HEIGHT (already
  // computed, no extra taps) puts the swell back into the value: crests catch a
  // little more sky, troughs sit deeper in the body colour.
  body *= 1.0 + wv.x * 3.2 + rp.x * 2.0;

  // ---- The crown's share of the hemisphere (see canopyIrradiance above).
  // SHAPED with an exponent, and this is the one art decision in the term rather
  // than a physical one. MEASURED at uCanopyHue 1.30 on the raw linear fraction the
  // whole pool went mauve — hero hue 317 next to the tree but also 322 at the centre
  // and 290 on the far shore, i.e. a flat lavender lens, which trades one §8.2 tell
  // for another. The raw fraction only varies 0.083 -> 0.31 across this pond (a 3.7x
  // range) and hue is unstable at the pool's low chroma, so a linear weight cannot
  // separate the two ends. pow(.,1.8) turns that into a 10x range: pink where the
  // crown overhangs the water, water-blue on the far shore, and a real gradient
  // between them.
  float cRaw = clamp( canopyIrradiance( vWorldPos ) * uCanopyBounce, 0.0, 0.92 );
  // GATED, not ramped. The raw fraction only spans 0.083 (far shore) .. 0.31 (the
  // shore the crown overhangs), and a mix weight anywhere in 0.15-0.45 turns the
  // pool grey rather than pink. So the crescent the crown actually hangs over gets
  // a strong tint and everything else stays water — a legible gradient instead of
  // either a blue lens or a lavender one.
  float cIrr = smoothstep( uCanopyGate.x, uCanopyGate.y, cRaw );

  // ---- Grazing sub-surface return. Light that DOES refract into a 30 cm pool
  // over dark silt barely comes back: the bed swallows it, and what does return
  // at a grazing exit angle is overwhelmingly skylight scattered in the top few
  // centimetres — the same radiance the surface is reflecting. Folding that into
  // the body (weighted by 1-ndv, so a top-down view still shows the bed and the
  // caustics) is what takes the EFFECTIVE reflection weight from Schlick's 0.46
  // to the 0.75-0.90 a still Genshin pond reads at. It also halves the value gap
  // the Fresnel term can swing across, which is the other half of the plaid fix.
  // The diffuse return sees the crown, not just the sky above it. Multiplicative
  // (canopyMul) because a hemisphere integral is broad and applies everywhere: this
  // is the term that gives the whole pool a faint warmth without touching its value.
  vec3 diff = refl * mix( vec3( 1.0 ), canopyMul(), clamp( pow( cRaw, 1.35 ) * 1.55, 0.0, 0.85 ) );
  body = mix( body, diff, clamp( uSubRefl * ( 1.0 - ndv ), 0.0, 0.95 ) );

  // ---- absorption along the view path through the water column
  float path = depth / max( ndv, 0.16 );
  float A = 1.0 - exp( -path * uAbsorb );

  float aBase = F + ( 1.0 - F ) * A;
  vec3 col = ( refl * F + body * ( 1.0 - F ) * A ) / max( aBase, 1e-3 );

  // ---- surface-only highlights. These are deliberately OUTSIDE the Fresnel
  // weighting: looking down into 20 cm of water the Fresnel term is 0.025, so
  // everything reflective vanishes and the pool reads as wet mud. The specular
  // glitter off the wave field is what still says "this is a water surface" at a
  // steep angle, and it is the one cue no amount of body colour can replace.
  vec3 kcol = nprKeyColor();
  vec3 Lk = nprKeyDir();
  vec3 H = normalize( Lk + V );
  float spec = pow( max( dot( N, H ), 0.0 ), 320.0 );
  float sheen = pow( max( dot( N, H ), 0.0 ), 22.0 );
  // 1.8 / 0.045, measured down from 3.4 / 0.10: the broad sheen term is what
  // turns sun glitter into one continuous glare SHEET over the shallows (p99 hit
  // 0.92 across ~4% of frame). Sparkle wants the sharp lobe, not the wide one.
  col += kcol * ( spec * 1.8 + sheen * 0.045 ) * sm * ( 0.45 + 0.55 * wet );
  // An expanding ring has to be legible from 10 m away or the petal landings it
  // marks are invisible, which is exactly what the critic measured. The crest
  // gets a bright leading edge AND the trough behind it goes a touch darker, so
  // the ring reads as a ring rather than as a general brightening.
  col += kcol * crest * uGlint * ( 0.35 + 0.65 * sm ) * wet;
  col *= 1.0 - 0.13 * clamp( -rp.x * 26.0, 0.0, 1.0 ) * wet;

  // ---- The wet edge. The previous pass added a PALE, slightly pink lip here and
  // that is the "pale sandy rim" the review called out: the brightest thing at the
  // waterline was the waterline itself, so the pool ended on a highlight instead of
  // sinking into the bank. Water shelving over wet silt gets DARKER, not lighter.
  // uShoreDark / uShoreDarkM: multiplier at the waterline, easing to 1.0 over
  // uShoreDarkM metres of depth. 0.0340 m of depth is 0.35 m of shore on this
  // basin's measured 0.097 m/m slope, which is the band the prescription asked for.
  col *= mix( uShoreDark, 1.0, smoothstep( 0.0, uShoreDarkM, depth ) );
  // a hint of silt kicked up in the last few centimetres, no highlight
  float lip = ( 1.0 - smoothstep( 0.0, 0.045, depth ) ) * smoothstep( 0.002, 0.016, depth );
  col = mix( col, col * 0.86 + uShallowColor * 0.10, lip * 0.55 );

  // ---- and finally rotate the crescent's hue toward the crown. A flat lavender
  // wash is just §8.2 in a different colour, so the weight carries the crown's own
  // clumpiness: two octaves warped by the surface gradient, which is a blurred
  // RIPPLED reflection of a lumpy blossom mass rather than fog on the water. The
  // 0.88 value drop is there because a canopy is darker than the open sky it
  // replaces — without it the pink read as haze sitting on top of the pool.
  float cn = snoise( p * 0.85 + grad * 3.0 ) * 0.5 + 0.5;
  cn = cn * 0.66 + ( snoise( p * 2.10 - grad * 2.0 ) * 0.5 + 0.5 ) * 0.34;
  float cMask = clamp( cIrr * ( 0.42 + 1.16 * cn ), 0.0, 1.0 ) * uCanopyHue;
  col = mix( col, canopyTint( col ) * 0.88, cMask );

  col = applyAerial( col, dist, vWorldPos.y, V );

  float a = clamp( aBase * shore * uOpacity, 0.0, 1.0 );

  // ---- A/B isolation (scenarios pond-dbg-*). RESUME.md: colour-coded shader
  // debug lies through the tonemap chain, so these output real radiance at
  // alpha 1 and are only ever compared against the same region of the normal
  // render, never read as absolute colours.
  if ( uDebug > 0.5 ) {
    vec3 dbg = refl;
    if ( uDebug > 4.5 )      dbg = vec3( cIrr );
    else if ( uDebug > 3.5 ) dbg = vec3( length( grad ) * 6.0 );
    else if ( uDebug > 2.5 ) dbg = vec3( F + ( 1.0 - F ) * A * clamp( uSubRefl * ( 1.0 - ndv ), 0.0, 0.95 ) );
    else if ( uDebug > 1.5 ) dbg = body;
    gl_FragColor = vec4( dbg, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  gl_FragColor = vec4( col * a, a );          // premultipliedAlpha material
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 3. The bed + shoreline
 * ===================================================================== */

export const BED_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

#include <common>
#include <shadowmap_pars_vertex>

void main(){
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPos = worldPosition.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * normal );
  vWorldNormal = wn;
  vec3 shadowWorldNormal = wn;
${SHADOW_VERT_BLOCK}
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const BED_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

uniform vec3  uSilt;        // wet bed silt
uniform vec3  uSiltDeep;    // the deep centre
uniform vec3  uMud;         // dry bank mud
uniform vec3  uPebble;
uniform vec3  uAlgae;
uniform float uFadeIn;      // BANK METRES where the mud starts fading into grass
uniform float uFadeOut;     // BANK METRES where it is gone
uniform float uMaxR;        // absolute radius backstop
uniform float uCaustic;
uniform float uDampNear;    // BANK METRES of full wet-sand darkening
uniform float uDampFar;     // BANK METRES where the wet band is gone
uniform float uDampMul;     // albedo multiplier inside the wet band

${FRAG_PREAMBLE}
${GLSL_WATER_COMMON}

void main(){
  vec2 p = vWorldPos.xz;
  float depth = pondDepth( p );
  float bank  = pondBank( p );

  vec3 toCamEarly = cameraPosition - vWorldPos;
  float distEarly = length( toCamEarly );
  // High-frequency bed detail has no mip chain (it is procedural), so at the far
  // shore of a grazing shot every octave above ~10 cm integrates into a smear.
  // MEASURED: that smear is the "brown blob floating mid-pond" the review found at
  // pond.png x 930-1150 y 430-485 — it is the pebble/gravel worley net on the FAR
  // SHALLOWS, seen through 3-6 cm of water at 14 m, not a decal and not a reflection.
  float micro = 1.0 / ( 1.0 + distEarly * 0.16 );

  // ---- albedo. Three noise scales, because at 1 m from the camera a single
  // octave of 14 cm grain over a flat mud colour still reads as flat mud.
  float grain = snoise( p * 7.3 ) * 0.5 + 0.5;
  float fine  = snoise( p * 21.0 + 3.0 ) * 0.5 + 0.5;
  float blotch = snoise( p * 1.55 + 13.0 ) * 0.5 + 0.5;
  float streak = snoise( vec2( length( p - uPondCentre.xz ) * 2.4, atan( p.y - uPondCentre.z, p.x - uPondCentre.x ) * 3.2 ) ) * 0.5 + 0.5;
  grain = mix( 0.5, grain, micro );
  fine  = mix( 0.5, fine,  micro * micro );

  // Submerged silt is a pond bottom, not a beach: it goes cool and algal within a
  // few centimetres of the waterline. The old ramp held the WARM silt out to 8 cm
  // of depth, which over the whole far shelf is a wide brown band reading as mud.
  vec3 col = mix( uSilt, uSiltDeep, smoothstep( 0.015, 0.30, depth ) );
  col = mix( col, uAlgae, smoothstep( 0.03, 0.34, depth ) * ( 0.30 + 0.45 * blotch ) );

  // dry bank above the waterline, with a dark capillary band at the very edge
  float dry = smoothstep( 0.0, 0.14, bank );
  vec3 dryCol = uMud * mix( 0.80, 1.22, grain ) * mix( 0.93, 1.07, fine );
  // silt washed up the bank in radial streaks — the shore of a real pool is
  // banded, not a uniform apron
  dryCol *= mix( 0.86, 1.10, streak );
  col = mix( col, dryCol, dry );
  // Wet-sand band, in BANK METRES (bankAt() rises 0.22 m per metre outside the
  // pool). uDampNear = 0.033 = the first 0.15 m of shore the prescription named,
  // easing out over uDampFar = 0.099 = 0.45 m. The MULTIPLIER is calibrated so the
  // band PRINTS at 0.80 x the dry bank's luminance after NPR + aerial + the grade
  // (see 25-water.js uDampMul for the measurement) rather than being 0.80 in albedo,
  // which the tone curve would have compressed to ~0.93.
  float damp = 1.0 - smoothstep( uDampNear, uDampFar, bank );
  damp *= step( 0.0001, bank );
  damp *= damp * ( 3.0 - 2.0 * damp );
  col *= mix( 1.0, uDampMul, damp );
  col *= mix( 1.0, 0.88, smoothstep( 0.0, 0.04, depth ) );

  // pebbles AFTER the wet/dry mix (the first pass painted them before it, so the
  // dry bank — the only part of the bed the camera ever sees up close — had none).
  // Both nets are killed off UNDER water: a pebble net seen through even 5 cm of
  // rippled water is not resolvable, and pretending otherwise is what printed the
  // far shelf as a mottled brown mat.
  float sub = 1.0 - 0.86 * smoothstep( 0.008, 0.075, depth );
  float w = worley( p * 3.6 );
  float pebMask = ( 1.0 - smoothstep( 0.18, 0.40, w ) ) * smoothstep( 0.40, 0.60, blotch ) * micro;
  float w2 = worley( p * 8.2 + 31.0 );
  float gravel = ( 1.0 - smoothstep( 0.14, 0.34, w2 ) ) * smoothstep( 0.34, 0.66, fine ) * micro * micro;
  col = mix( col, uPebble * ( 0.72 + 0.50 * grain ) * mix( 1.0, 0.52, smoothstep( 0.0, 0.05, depth ) ), pebMask * 0.72 * sub );
  col = mix( col, uPebble * ( 0.55 + 0.40 * fine ) * mix( 1.0, 0.56, smoothstep( 0.0, 0.05, depth ) ), gravel * 0.34 * sub );

  vec3 N = normalize( vWorldNormal );
  // bumpy bed: perturb the normal with the grain so the bed is not a smooth dish
  vec3 bump = vec3(
    snoise( p * 9.1 + 4.0 ) - snoise( p * 9.1 - 4.0 ),
    0.0,
    snoise( p * 9.1 + 21.0 ) - snoise( p * 9.1 - 21.0 ) );
  N = normalize( N + bump * ( 0.075 * micro ) );

  vec3 toCam = toCamEarly;
  float dist = distEarly;
  vec3 V = toCam / max( dist, 1e-4 );

  nprSetWorldPos( vWorldPos );
  float sm = getShadowMask();
  vec3 Ng = nprGeoNormal( vWorldPos, N );
  col = nprShadeN( col, N, Ng, V, sm, 0.0, 0.0, 0.28, 0.55, 1.0 );

  // ---- caustics: two counter-scrolling worley fields warped by the wave field.
  // Only under water, strongest where it is shallow, and gated on the key so a
  // shadowed patch of bed does not glow.
  if ( depth > 0.004 ) {
    // Caustics are THE signature of a shallow sunlit pool — with the water only
    // 30 cm deep they carry more of the read than the reflection does. Two
    // counter-scrolling worley fields, warped by the surface wave gradient so the
    // net breathes with the same gusts as the ripples, multiplied (not added) so
    // the bright regions are thin intersecting filaments rather than blobs.
    vec3 wv = waterWaves( p, uWindTime, windGustEnv(), 1.0 / ( 1.0 + dist * 0.16 ) );
    float t = uWindTime * 0.14;
    // Two independent warps before the cells, or the worley lattice shows: the
    // first version printed a regular diagonal grid of light blobs, which is
    // ART_BIBLE §8.7 (perfectly regular placement) in a caustic's clothing.
    vec2 warp = vec2( snoise( p * 1.62 + t ), snoise( p * 1.62 + 19.0 - t ) ) * 0.19
              + wv.yz * 1.70;
    float c1 = worley( ( p + warp ) * 3.30 + vec2( t, -t * 0.62 ) );
    float c2 = worley( waterRot( p + warp * 1.45, 0.9 ) * 5.10 + vec2( -t * 0.7, t * 1.15 ) + 17.0 );
    float f1 = pow( 1.0 - c1, 4.0 );
    float f2 = pow( 1.0 - c2, 5.0 );
    // the PRODUCT is what makes a caustic net: bright only where two filaments
    // cross, dim along a single one
    float cau = clamp( f1 * f2 * 3.0 + ( f1 + f2 ) * 0.12, 0.0, 1.6 );
    cau *= 0.40 + 0.60 * ( snoise( p * 0.83 + 7.0 ) * 0.5 + 0.5 );
    float shallow = ( 1.0 - smoothstep( 0.10, 0.62, depth ) ) * smoothstep( 0.004, 0.045, depth );
    float lit = nprLit( vec3( 0.0, 1.0, 0.0 ), nprKeyDir(), sm );
    // HARD CEILING on the added light. Tuning the amplitude alone kept blowing the
    // shallow ring to 255,255,255 because cau, shallow, lit and the key colour all
    // peak in the same place; clamping the sum makes the shimmer impossible to
    // over-drive no matter what the dials say.
    col += nprKeyColor() * min( cau * shallow * lit * uCaustic, 0.30 );
    // and the shadow side of each filament: caustics take light FROM somewhere
    col *= 1.0 - 0.14 * ( 1.0 - smoothstep( 0.0, 0.26, cau ) ) * shallow * lit;
  }

  col = applyAerial( col, dist, vWorldPos.y, V );

  // ---- Fade into the terrain by BANK HEIGHT, not by radius. The pond's shore is
  // 3.4 m out on one side and 5.7 m on another, so a single radial ramp either
  // starts inside the water or (as measured: fadeIn 5.8 m against a grass line at
  // 5.33 m) puts the whole mud apron underneath the grass and deletes the
  // shoreline. bank comes from the baked depth map and already tracks the real
  // waterline, so an apron keyed to it is ~1 m wide everywhere.
  float edge = snoise( p * 1.9 + 55.0 ) * 0.055 + snoise( p * 5.3 + 11.0 ) * 0.022;
  float a = 1.0 - smoothstep( uFadeIn, uFadeOut + edge, bank );
  // absolute backstop so the bed can never sprawl across the garden
  float r = length( p - uPondCentre.xz );
  a *= 1.0 - smoothstep( uMaxR, uMaxR + 0.7, r );
  a = clamp( a, 0.0, 1.0 );

  gl_FragColor = vec4( col * a, a );          // premultipliedAlpha material
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 4. Shore reeds
 * ===================================================================== */

export const REED_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vTint;

#include <common>
${GLSL_NOISE}
${GLSL_WIND}
#include <shadowmap_pars_vertex>

void main(){
  vec3 local = position;
  #ifdef USE_INSTANCING
    vec4 inst = instanceMatrix * vec4( local, 1.0 );
    local = inst.xyz;
  #endif
  vec4 worldPosition = modelMatrix * vec4( local, 1.0 );

  // base of this instance in world space, for a per-clump wind phase
  vec3 baseLocal = vec3( 0.0 );
  #ifdef USE_INSTANCING
    baseLocal = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  #endif
  vec3 baseWorld = ( modelMatrix * vec4( baseLocal, 1.0 ) ).xyz;

  // uv.y is 0 at the root, 1 at the tip: bend, never slide
  float freedom = uv.y * uv.y;
  vec3 off = windOffset( baseWorld + vec3( 0.0, uv.y * 0.8, 0.0 ), 1.0 - freedom );
  worldPosition.xyz += off * 0.55;

  vWorldPos = worldPosition.xyz;
  vec3 n = normal;
  #ifdef USE_INSTANCING
    n = mat3( instanceMatrix ) * n;
  #endif
  vec3 wn = normalize( mat3( modelMatrix ) * n );
  vWorldNormal = wn;
  vUv = uv;
  vTint = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vec3 shadowWorldNormal = wn;
${SHADOW_VERT_BLOCK}
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const REED_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vTint;

uniform vec3 uBase;
uniform vec3 uTip;

${FRAG_PREAMBLE}

void main(){
  // base -> tip value ramp; reeds are darker and cooler at the waterline
  vec3 albedo = mix( uBase, uTip, smoothstep( 0.52, 1.0, vUv.y ) ) * vTint;
  // the top ~12% dries out to a straw brown — that break is what stops a clump
  // reading as a bundle of identical green sticks
  albedo = mix( albedo, vec3( 0.30, 0.22, 0.11 ), smoothstep( 0.93, 1.0, vUv.y ) * 0.34 );
  // a central rib so a blade is not one flat colour across its width
  float rib = 1.0 - smoothstep( 0.0, 0.32, abs( vUv.x - 0.5 ) );
  albedo *= mix( 0.76, 1.10, rib );

  vec3 N = normalize( vWorldNormal );
  N = gl_FrontFacing ? N : -N;
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  nprSetWorldPos( vWorldPos );
  float sm = getShadowMask();
  // Deliberately LOW translucency and rim for a reed. The first pass ran this at
  // 0.85 / 1.25 and every blade came out a white bone spike: a blade seen from
  // the side is all Fresnel, so the wrapped-transmission floor plus the sky rim
  // sat on top of an already pale tip colour and clipped. A reed is a dark
  // silhouette against water with only its edge lit.
  // 0.44 / 0.34, landed between the two failures: the original 0.85/1.25 printed
  // white bone spikes, 0.34/0.30 printed black wires, 0.55/0.42 printed dried
  // bamboo. A reed is a green blade with a lit edge and a dry tip.
  vec3 col = nprShadeN( albedo, N, N, V, sm, 0.36, 0.28, 0.50, 0.30, 0.95 );
  // MEASURED: side-on blades over the pond bottomed out at display L 0.054 — right
  // on ART_BIBLE's 0.055 floor — and read as black wires strung across the water.
  // A reed 3 cm wide IS mostly Fresnel and transmission, so the fix is a wrapped
  // floor keyed to the sky/key pair rather than a flat lift: the darkest a blade
  // gets is now its own albedo lit by ambient, never zero.
  vec3 amb = uSkyColor * 0.55 + uGroundColor * 0.35;
  col = max( col, albedo * amb * 1.05 );
  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 5. Procedural assets
 * ===================================================================== */

/**
 * Bake (waterDepth, bankHeight) over the pond footprint from the terrain's own
 * height field. RGBA8 so it is linearly filterable everywhere without relying on
 * OES_texture_float_linear.
 *
 *   R = clamp( (waterY - groundY) / DEPTH_SCALE, 0, 1 )
 *   G = clamp( (groundY - waterY) / BANK_SCALE,  0, 1 )
 *   B = 8-bit noise-free spare (bed variation seed), A = 255
 */
export function buildPondDepthTexture(THREE, { depthFn, bankFn, cx, cz, span, size = 512 }) {
  const data = new Uint8Array(size * size * 4);
  const step = span / size;
  const x0 = cx - span * 0.5 + step * 0.5;
  const z0 = cz - span * 0.5 + step * 0.5;
  for (let j = 0; j < size; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < size; i++) {
      const x = x0 + i * step;
      const depth = depthFn(x, z);
      const bank = bankFn(x, z);
      const o = (j * size + i) * 4;
      data[o] = Math.round(255 * Math.min(1, Math.max(0, depth / DEPTH_SCALE)));
      data[o + 1] = Math.round(255 * Math.min(1, Math.max(0, bank / BANK_SCALE)));
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;         // data, not colour
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Terrain-conforming dish for the bed: a radial grid whose ring spacing is
 * densest where the waterline is, because that is the only place the shader's
 * transitions are narrow enough for tessellation to matter.
 */
export function buildBedGeometry(THREE, { heightAt, cx, cz, radius, rings = 30, segs = 84, lift = 0.014 }) {
  const vn = rings * segs + 1;
  const pos = new Float32Array(vn * 3);
  const nrm = new Float32Array(vn * 3);
  const idx = [];
  const eps = 0.35;
  const H = (x, z) => heightAt(x, z) + lift;

  const setNormal = (o, x, z) => {
    const hx = H(x + eps, z) - H(x - eps, z);
    const hz = H(x, z + eps) - H(x, z - eps);
    let nx = -hx, ny = 2 * eps, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[o] = nx / l; nrm[o + 1] = ny / l; nrm[o + 2] = nz / l;
  };

  pos[0] = cx; pos[1] = H(cx, cz); pos[2] = cz;
  setNormal(0, cx, cz);

  for (let r = 0; r < rings; r++) {
    // t^0.78 packs rings toward the rim where the waterline lives
    const t = Math.pow((r + 1) / rings, 0.78);
    const rad = t * radius;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      const vi = 1 + r * segs + s;
      const o = vi * 3;
      pos[o] = x; pos[o + 1] = H(x, z); pos[o + 2] = z;
      setNormal(o, x, z);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = 1 + s, b = 1 + ((s + 1) % segs);
    idx.push(0, a, b);
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = 1 + r * segs + s;
      const b = 1 + r * segs + ((s + 1) % segs);
      const c = 1 + (r + 1) * segs + s;
      const d = 1 + (r + 1) * segs + ((s + 1) % segs);
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * One reed blade: a tapered, slightly cupped strip standing on +Y, 1 unit tall,
 * so the instance matrix can scale it. uv.y = 0 root, 1 tip; uv.x across.
 */
export function buildReedGeometry(THREE, rows = 5) {
  const pos = [], nrm = [], uvs = [], idx = [];
  // 0.036 m half-width tapering to 40%, up from 0.021 tapering to 20%. MEASURED:
  // at the pond camera 1 m subtends ~208 px, so the old blade was 1.7 px wide at
  // the base and well under 1 px for its top half. A/B'd against --scenario
  // postfx-off, that sub-pixel width is what made the post chain's TAA/CA resolve
  // print each blade as a BLACK core inside a correctly-coloured fringe (proved by
  // forcing the reed output to magenta: postfx-off gave solid magenta blades,
  // postfx-on gave magenta edges around black centres). A blade that covers 3-6 px
  // resolves. Flagged for 90-postfx as well — this is a mitigation, not the cure.
  const halfW = (v) => 0.036 * (1.0 - 0.60 * v) * (v < 0.06 ? 0.60 : 1.0);
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    const hw = halfW(v);
    // lean the blade forward a little and cup it across the width
    const bow = 0.10 * v * v;
    for (let c = 0; c < 3; c++) {
      const u = c - 1;                                // -1, 0, 1
      const cup = -0.020 * (1 - u * u) * (0.4 + 0.6 * v);
      pos.push(u * hw, v, bow + cup);
      const nx = u * 0.45;
      const l = Math.hypot(nx, 0.15, 1);
      nrm.push(nx / l, 0.15 / l, 1 / l);
      uvs.push(c * 0.5, v);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < 2; c++) {
      const a = r * 3 + c, b = a + 1, d = a + 3, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Weld duplicated vertices so computeVertexNormals() produces SMOOTH normals.
 * IcosahedronGeometry is non-indexed: every triangle owns its three vertices, so
 * recomputing normals after a displacement gives face normals and the result is
 * visibly faceted (ART_BIBLE §8.5). Hash-welding on the rounded position fixes it
 * without pulling in BufferGeometryUtils.
 */
function weld(THREE, geo, precision = 1e-4) {
  const src = geo.attributes.position;
  const map = new Map();
  const pos = [];
  const index = [];
  const inv = 1 / precision;
  for (let i = 0; i < src.count; i++) {
    const x = src.getX(i), y = src.getY(i), z = src.getZ(i);
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(x, y, z);
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(index);
  return out;
}

/**
 * A water-worn shore stone: an icosahedron pushed around by value noise and
 * flattened on Y, so instances read as rounded river stones rather than rocks.
 */
export function buildStoneGeometry(THREE, rng, detail = 2) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  const geo = weld(THREE, raw);
  raw.dispose();
  const p = geo.attributes.position;
  const seed = [rng.range(0, 20), rng.range(0, 20), rng.range(0, 20)];
  const h = (x, y, z) => {
    const s = Math.sin(x * 2.7 + seed[0]) * Math.sin(y * 3.1 + seed[1]) * Math.sin(z * 2.3 + seed[2]);
    const s2 = Math.sin(x * 5.3 + seed[1]) * Math.sin(z * 4.7 + seed[2]);
    return s * 0.16 + s2 * 0.07;
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + h(x, y, z);
    p.setXYZ(i, x * k, y * k * 0.86, z * k);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A floating sakura petal, seen from above: the outline in alpha, the palette's
 * five values in RGB. Self-contained so the pond never depends on another
 * agent's file staying put.
 */
export function makeFloatPetalTexture(THREE, S = 96) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;

  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const C_DEEP = [0xC2, 0x5F, 0x86];
  const C_SHAD = [0xEE, 0x8C, 0xAF];
  const C_MID = [0xFF, 0xB6, 0xCE];
  const C_LIGHT = [0xFF, 0xD9, 0xE6];

  // half-width of the outline at v (0 base .. 1 tip), domed cap with a notch
  const hwAt = (v) => (v < 0.60
    ? 0.16 + 0.78 * Math.sin(Math.PI * 0.5 * (v / 0.60))
    : 0.94 * Math.sqrt(Math.max(0, 1 - ((v - 0.60) / 0.44) ** 2)));

  for (let row = 0; row < S; row++) {
    const v = 1 - (row + 0.5) / S;                 // flipY on canvas textures
    for (let col = 0; col < S; col++) {
      const u = ((col + 0.5) / S) * 2 - 1;
      const hw = hwAt(v);
      const notch = 0.085 * Math.exp(-((u / 0.20) ** 2));
      const sd = Math.min((hw - Math.abs(u)) / Math.max(hw, 0.05),
        (1 - notch - v) * 3.4, v * 11);
      const a = sstep(0, 0.08, sd);

      const t = Math.abs(u) / Math.max(hw, 0.05);
      let c = mix3(C_DEEP, C_SHAD, sstep(0, 0.20, v));
      c = mix3(c, C_MID, sstep(0.10, 0.48, v));
      c = mix3(c, C_LIGHT, sstep(0.60, 1.02, v) * 0.66);
      const vein = Math.pow(Math.max(0, 1 - Math.abs(Math.sin(t * Math.PI * 2.4))), 9);
      c = mix3(c, C_SHAD, vein * 0.34 * sstep(0.04, 0.45, v));
      c = mix3(c, C_LIGHT, sstep(0.82, 1.0, t) * 0.45);

      const o = (row * S + col) * 4;
      d[o] = Math.round(c[0]); d[o + 1] = Math.round(c[1]); d[o + 2] = Math.round(c[2]);
      d[o + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A floating petal's mesh: a cupped quad lying in the XZ plane (so an instance
 * matrix only has to rotate it about Y and lift it to the surface). The cup is
 * what keeps a resting petal from reading as a decal — one edge catches the key.
 */
export function buildFloatPetalGeometry(THREE) {
  const pos = [], nrm = [], uvs = [], idx = [];
  const N = 3;                                  // 3x3 patch
  const cup = 0.10;
  for (let r = 0; r < N; r++) {
    const v = r / (N - 1);
    for (let c = 0; c < N; c++) {
      const u = (c / (N - 1)) * 2 - 1;
      const y = cup * (u * u * 0.55 + (v - 0.5) * (v - 0.5) * 1.10) - cup * 0.20;
      pos.push(u * 0.5, y, (v - 0.5));
      const dydu = cup * 2 * u * 0.55 / 0.5;
      const dydv = cup * 2 * (v - 0.5) * 1.10;
      const l = Math.hypot(-dydu, 1, -dydv);
      nrm.push(-dydu / l, 1 / l, -dydv / l);
      uvs.push(u * 0.5 + 0.5, v);
    }
  }
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
