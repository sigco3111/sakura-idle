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
uniform float uGrassR;         // radius the instanced blades cover
/* Contact occlusion. xy = world xz of a footing, z = its footprint radius,
 * w = strength (0 disables the slot). Slot 0 is the tree's root flare; the rest
 * are filled from ctx.assets.props once 35-props has booted. ART_BIBLE §2 asks
 * for "a weak ambient-occlusion-driven darkening under props" and the round-2
 * review measured the trunk contact at 0.64 of open ground falling off over 5 m
 * — a haze, not a contact. This is the tight version. */
#define GROUND_CONTACTS 10
uniform vec4 uContact[GROUND_CONTACTS];

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
  //
  // ...but WITHIN the instanced-blade radius this texture is the sward FLOOR, not
  // the sward. MEASURED r0: the ground between blades printed at L 0.332 against
  // blades at L 0.355, so the blades did not separate from it at all (blocker 2).
  // Looking down into grass you see the shaded base value; the bright bleached
  // tips are the job of the instanced geometry. Beyond the blade radius the
  // texture stands in for whole blades again and gets its bleach back.
  float sward = 1.0 - smoothstep( uGrassR * 0.80, uGrassR * 1.35, length( wxz ) );
  /* MEASURED r2: the sward floor still printed BRIGHTER than the blades standing
   * in it (ground L 0.43+ against blades ~0.36), so the whole meadow read as
   * dark needles on a pale plane — ART_BIBLE §3's tip gradient exactly inverted.
   * Looking down into grass you see the shaded base value and almost no sky, so
   * inside the blade radius this texture is darkened hard and de-bleached; the
   * bright sun-bleached value is the instanced geometry's job. */
  float bleach = clamp( fibre * 1.18 - 0.24 + hi * 0.16, 0.0, 1.0 )
               * mix( 1.0, 0.20, sward );
  vec3 grassC = mix( uGrassBase, uGrassTip, bleach );
  grassC = mix( grassC, uGrassTip * 1.10,
                pow( clamp( dC.r, 0.0, 1.0 ), 2.2 ) * 0.34 * mix( 1.0, 0.30, sward ) );
  grassC *= ( 0.94 + 0.14 * cell ) * mix( 1.0, 0.66, sward );

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
  // ...and a third octave at ~2 m, faded out by the PIXEL FOOTPRINT rather than
  // by distance, so it adds structure right up to the point where it would start
  // to alias and no further. MEASURED r0: the wide frame's bottom half had 200x30
  // regions at luminance sd 0.03 and flatBlocks 0.109; the two octaves above run
  // at 21 m and 6 m features, which is coarser than a 200 px band at 60 m.
  float fp = fwidth( wxz.x ) + fwidth( wxz.y );          // world metres / pixel
  float pC = snoise( vec3( wxz * 0.52, 41.1 ) ) * ( 1.0 - smoothstep( 0.06, 0.42, fp ) );
  float mead = pA * 0.56 + pB * 0.32 + pC * 0.30;
  albedo *= 1.0 + mead * 0.30;
  // the yellow arm trimmed 0.45 -> 0.30: stacked on the dry-grass layer it was
  // half the reason open meadow read khaki rather than green.
  albedo = mix( albedo, albedo * vec3( 1.10, 1.00, 0.84 ), clamp(  mead, 0.0, 1.0 ) * 0.30 );
  albedo = mix( albedo, albedo * vec3( 0.84, 1.00, 0.94 ), clamp( -mead, 0.0, 1.0 ) * 0.46 );

  /* ---- mid-scale layer SCARS (prescription 4c) -----------------------
   * The four-layer blend is driven by a 0.013-0.34 m^-1 noise set plus slope, so
   * on the flat knoll the weights barely move and any 300 px span of near ground
   * carried ONE albedo. These are worley patches at ~2.4 m and ~3.7 m: trodden
   * bare earth where the cells pack, moss flushes in the hollows between them.
   * Different frequency AND different generator from the meadow octaves below,
   * so they read as ground cover rather than as more of the same noise. */
  float scar  = smoothstep( 0.50, 0.88, 1.0 - worley( wxz * 0.42 + 4.7 ) );
  float flush = smoothstep( 0.46, 0.90, 1.0 - worley( wxz * 0.27 + 31.0 ) );
  float scarF = 1.0 - smoothstep( 26.0, 70.0, dist );   // near/mid field only
  albedo = mix( albedo, earthC * ( 0.90 + 0.22 * grain ),
                scar * 0.62 * scarF * ( 1.0 - wPath * 0.8 ) );
  albedo = mix( albedo, mossC * ( 0.88 + 0.26 * cell ), flush * 0.42 * scarF );

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

  /* ---- contact occlusion at every footing -----------------------------
   * TARGET (round-2 prescription): 0.55 x the open-ground luminance AT the
   * contact, back to 1.0 by 1.2 m from the footing edge, and hue-shifted COOL
   * (205-245 deg, B >= R) rather than warmer — the measured failure was a warm
   * 0.64-ratio haze spread over 5 m, which grounds nothing.
   *
   * The level drop and the hue push are separate operations, exactly as
   * nprShadowHue/nprShadowLevel keep them separate: multiplying alone would be
   * ART_BIBLE §8.4's "shadow that is only darker albedo".                   */
  {
    float ring = 0.0;
    for ( int i = 0; i < GROUND_CONTACTS; i++ ) {
      vec4 C = uContact[i];
      if ( C.w <= 0.0 ) continue;
      float dEdge = max( 0.0, length( wxz - C.xy ) - C.z );
      ring = max( ring, ( 1.0 - smoothstep( 0.0, 1.20, dEdge ) ) * C.w );
    }
    if ( ring > 0.001 ) {
      vec3 cool = uShadowTint * ( nprLuma( col ) / max( nprLuma( uShadowTint ), 1e-4 ) );
      col = mix( col, cool, ring * 0.55 ) * mix( 1.0, 0.55, ring );
    }
  }

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
uniform vec2  uUpBias;  // shading-normal blend toward +Y at (base, tip)

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
  rn = normalize( rn + vec3( disp.x, 0.0, disp.y ) * ( 1.7 * t ) );
  /* ---- and lift it toward the sky (blocker: the inverted tip gradient) ----
   * A blade is a near-VERTICAL card, so its true normal is horizontal and, with
   * the key at a real elevation, it collects far less key than the horizontal
   * ground it stands in — which is the arithmetic behind "dark green needles on
   * a bright yellow-green plane", the exact inverse of ART_BIBLE §3. Every
   * stylised grass shader cheats the same way: blend the shading normal toward
   * the terrain's up vector so a blade is lit like the sward it belongs to, and
   * let the ALBEDO ladder carry the tip highlight. Stronger at the tip, where a
   * real blade is also curling over and presenting its face to the sky. */
  rn = normalize( mix( rn, vec3( 0.0, 1.0, 0.0 ), mix( uUpBias.x, uUpBias.y, t ) ) );

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
  /* ---- the vertical albedo ladder (blocker 2) ------------------------
   * ART_BIBLE §3: "grass must be lighter and yellower at the tips". MEASURED r0
   * of this round: rendered blades sat at #5E5D39 (L 0.355) against ground at
   * #58563C (L 0.332) — a 0.023 separation, i.e. no gradient at all, and R ~= G
   * so the sward read khaki rather than green. Targets, in the graded frame:
   * mean tip L >= 0.62 (#8FB463) against base L 0.34 (#3E6134).
   *
   * At a low tier one blade stands in for several, so it is shaded like the
   * AGGREGATE it represents (tip-dominated) rather than like a single blade;
   * otherwise the sward turns into scattered dark needles on a bright plane.   */
  float t = clamp( vT * ( 1.0 + uTipBias * 0.85 ) + uTipBias * 0.22, 0.0, 1.0 );
  // MEASURED r5: with tv = t^0.78 the mid value had taken over by 20 % of blade
  // height, so a 200x20 near-field band averaged L 0.535 with sd 0.122 — one
  // mid-green mass rather than dark bases under bright tips (target: base 0.34,
  // tip >= 0.62, band sd >= 0.18). Linear in blade height, so the bottom third
  // actually stays at the base value, and the tip band is widened by the additive
  // highlight below instead of by warping the ramp.
  float tv = t;
  vec3 albedo = mix( uBaseCol, uMidCol, smoothstep( 0.02, 0.50, tv ) );
  albedo = mix( albedo, uTipCol, smoothstep( 0.46, 1.00, tv ) );
  albedo = mix( albedo, uDryCol, vDry * ( 0.12 + 0.38 * tv ) );
  albedo += uTipCol * pow( tv, 3.4 ) * 0.34;
  // ...and a further warm shift on the top 15 % only (prescription 3b): the very
  // tip of a sun-exposed blade is bleached toward straw, which is what carries
  // the band's hue into the 65-80 deg window without turning the whole sward khaki.
  albedo *= mix( vec3( 1.0 ), vec3( 1.075, 1.030, 0.905 ), smoothstep( 0.85, 1.0, tv ) );
  // deepen the bottom third so the band keeps a real value spread (target sd >= 0.18)
  albedo *= mix( 0.74, 1.0, smoothstep( 0.0, 0.34, tv ) );
  // ---- per-instance hue + value jitter -------------------------------
  // vJit is one seeded random; fract(vJit * 7.31) is a second, independent
  // enough for the hue swing without paying for another instanced attribute.
  float hj = fract( vJit * 7.31 ) * 2.0 - 1.0;                 // -1..1
  const vec3 G_YEL = vec3( 1.085, 1.000, 0.845 );               // ~ +8 deg
  const vec3 G_BLU = vec3( 0.915, 1.000, 1.115 );               // ~ -8 deg
  albedo *= mix( G_BLU, G_YEL, hj * 0.5 + 0.5 );
  albedo *= 0.87 + 0.28 * vJit;                                 // ~ +-0.06 L

  vec3 N = normalize( vWorldNormal );
  // Flip only the HORIZONTAL half on the back face. A full negation also flips
  // the sky-ward lift that GRASS_VERT just applied, so every back-facing blade
  // fragment ended up with a normal pointing at the GROUND — i.e. half of every
  // blade in the field was shaded as if it faced away from the sky. That is the
  // other half of the inverted tip gradient.
  if ( !gl_FrontFacing ) N = vec3( -N.x, N.y, -N.z );
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  float ao = clamp( vAO * ( 0.46 + 0.54 * tv ), 0.0, 1.0 );
  // thin at the tip => more light bleeds THROUGH => backlit blades glow
  vec3 col = nprShadeN( albedo, N, N, V, sm, 1.0, mix( 0.34, 1.00, tv ),
                        0.28, 1.30, ao );
  // ---- explicit wrapped transmission at the tip ----------------------
  // The key sits BEHIND the tree all day (a settled decision), so the near-field
  // sward is backlit and its top third should be the brightest green in frame.
  // The library's lobe is gated on Fresnel, which a blade seen face-on fails, so
  // this is the term that gets a backlit tip to L 0.72.
  {
    vec3 Lg = normalize( mix( uSunDir, uMoonDir, step( 0.5, uNightMix ) ) );
    float back = pow( clamp( dot( -Lg, V ), 0.0, 1.0 ), 3.0 );
    float awayN = clamp( -dot( N, Lg ) * 0.5 + 0.5, 0.0, 1.0 );
    // Tinted by uTipCol AND biased back toward green: uSunColor is #FFEBCB, so a
    // straight key-coloured transmission pushed the whole near sward to hue 54
    // (khaki — R == G, the exact tell blocker 2 names). This keeps the warmth in
    // the value and the hue in the grass.
    vec3 tcol = uTipCol * mix( uSunColor, vec3( nprLuma( uSunColor ) ), 0.78 );
    col += tcol * ( back * 0.80 + awayN * awayN * 0.34 )
         * pow( tv, 1.6 ) * mix( 0.30, 1.0, sm ) * 1.15;
  }
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
