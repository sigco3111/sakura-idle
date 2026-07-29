/**
 * Props shaders — the built environment's materials.
 * Owner: the props agent (src/modules/35-props.js). Nothing else writes here.
 *
 * Exports
 *   PROPS_STONE_VERT / _FRAG      weathered granite: crevices, mica, moss, lichen
 *   PROPS_WOOD_VERT  / _FRAG      weathered vermilion paint over grey wood
 *                                 (defines: PROPS_EMA, PROPS_BAMBOO, PROPS_SWAY)
 *   PROPS_WINDOW_VERT / _FRAG     lantern fire-box paper panels (dark -> emissive)
 *   PROPS_HALO_VERT   / _FRAG     additive camera-facing flame halo billboards
 *   PROPS_BASIN_VERT  / _FRAG     the tsukubai's water disc
 *
 * Every surface goes through nprShadeN + applyAerial from src/lib/lighting.js —
 * ART_BIBLE §2 is never re-implemented locally, and that includes the lantern
 * light (see the note below).
 *
 * Vertex attribute contract (baked by the module's geometry builder):
 *   aStone  vec3   (mossBias, bakedAo, crevBias)          — stone geometries
 *   aWood   vec4   (paintWear, isPainted, localY, bakedAo) — wood geometries
 *   aGrain  vec2   (metres along the grain, metres across) — wood geometries
 *   aVar    vec4   per-INSTANCE on instanced meshes, per-vertex constant
 *                  otherwise: (variation, tone, seed, phase)
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './noise.js';
import { GLSL_NPR } from './lighting.js';
import { GLSL_WIND } from './wind.js';

/* ===================================================================== *
 * 0. Shared GLSL scaffolding
 * ===================================================================== */

/** Shadow-coordinate write-out. Same maths as lighting.js's NPR_VERT so a prop
 *  receives exactly the shadows the tree and the terrain do. */
export const PROPS_SHADOW_VERT = (WPOS, WNRM) => /* glsl */`
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

/**
 * ART_BIBLE §3's "never pure black" floor, as a hue-preserving LIFT.
 *
 * WHY IT EXISTS. shots/props-r1/hero.png x 1770-1800 y 795-835 held two
 * near-#000 blobs on the right torii pillar (min L exactly 0.000) that the
 * reviewer read as "pure-black glyph specks / rendering garbage". They were the
 * wood shader's `split` term: split reaches 1.0 only where the ring and fine
 * grain noises peak together, which happens as isolated 4x6 px islands, and it
 * both painted uWoodDark*0.62 AND pushed `wear` past the paint-stripping
 * threshold, so those islands rendered as unlit bare dark timber. The albedo is
 * fixed at source below, and this is the belt-and-braces guarantee for every
 * props surface: scale the colour up (never add grey, never add a tint) until its
 * luma clears the floor.
 *
 * CALIBRATION. The post chain's measured transfer is
 * display L ~= 0.560*(scene/0.333)^0.864, so display 0.055 <=> scene-linear
 * 0.0227. PROPS_MIN_LUMA sits a hair above at 0.0240 to leave room for the
 * grade's shadow lift pulling the other way. It is a floor, not a fill: 99.9% of
 * pixels are untouched, so it cannot flatten a shadow the way a paint-fill would.
 */
export const PROPS_FLOOR = /* glsl */`
#define PROPS_MIN_LUMA 0.0240
vec3 propsFloor( vec3 c ){
  float l = nprLuma( max( c, vec3( 0.0 ) ) );
  return max( c, vec3( 0.0 ) ) * max( 1.0, PROPS_MIN_LUMA / max( l, 1.0e-5 ) );
}
`;

/**
 * NOTE ON THE LANTERN GLOW. There is deliberately no local light code here.
 * 08-lighting.js owns the project's lamp system: it adopts visible
 * THREE.PointLights into `uLampPos` / `uLampColor` in the shared bag, and
 * `nprLamps()` inside `nprShadeN` spends them on EVERY npr surface — the
 * lantern's own granite, the path, the grass, the bark, the pond. A props-local
 * copy would light the props and nothing else, which is the wrong picture. So
 * 35-props.js just adds a PointLight per fire box and the rest is free.
 */

/* ===================================================================== *
 * 1. Stone — lanterns, wall, boulders, basin, pillar footings
 * ===================================================================== */

export const PROPS_STONE_VERT = /* glsl */`
attribute vec3 aStone;
attribute vec4 aVar;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vStone;
varying vec4 vVar;
#include <common>
#include <shadowmap_pars_vertex>
void main(){
  vec3 tp = position;
  vec3 tn = normal;
  #ifdef USE_INSTANCING
    tp = ( instanceMatrix * vec4( tp, 1.0 ) ).xyz;
    tn = mat3( instanceMatrix ) * tn;
  #endif
  vStone = aStone;
  vVar = aVar;
  vec4 wp = modelMatrix * vec4( tp, 1.0 );
  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * tn );
  vWorldNormal = wn;
${PROPS_SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PROPS_STONE_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vStone;
varying vec4 vVar;

uniform vec3  uStoneLite;      // #9E9A92 — the MEAN value of every granite surface
uniform vec3  uStoneDark;      // #6E6A62 — crevices, and the value floor
uniform vec3  uMossLite;
uniform vec3  uMossDark;
uniform vec3  uLichen;
uniform float uMossAmt;
uniform float uGrainScale;     // 1.0 = the calibrated per-metre frequency basis
uniform vec3  uShadeDir;       // world dir the moss favours (the damp, sunless flank)

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}
${PROPS_FLOOR}

/**
 * TRIPLANAR worley. worley() in noise.js is 2D, and the r7 shader projected it
 * on xz + y, which meant every vertical face of a wall block or a lantern collar
 * sampled the SAME cell column and printed a constant: measured luminance sd
 * 0.017 over a 90x20 px collar patch, i.e. a flat solid. Blending the three
 * axis-aligned projections by the squared normal gives a seamless cavity field
 * on any orientation, so a horizontal cope and a vertical jamb are equally
 * pitted.
 */
float pWorley3( vec3 p, vec3 n ){
  vec3 w = n * n; w *= w;                       // ^4: a hard, almost-single-plane pick
  w /= ( w.x + w.y + w.z + 1e-5 );
  return worley( p.yz ) * w.x + worley( p.zx ) * w.y + worley( p.xy ) * w.z;
}

void main(){
  vec3 N0 = normalize( vWorldNormal );
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float seed = vVar.z;
  float gs = max( uGrainScale, 0.05 );
  vec3 p = vWorldPos * gs + seed * 2.7;

  /* ---- granite, as FOUR fixed-metre bands.
   * Frequencies are absolute (cycles per metre x gs) rather than relative to the
   * object, so a 30 px patch of a 0.28 m lantern shaft carries as much texture as
   * a 1.4 m boulder — that is what the flat-collar measurement was really about.
   *   0.55/m  bedding tone      ~1.8 m
   *   2.6/m   feldspar blotches ~38 cm
   *   11/m    grit              ~9 cm
   *   34/m    mica              ~3 cm
   */
  float bed  = fbm( p * 0.55, 2 ) * 0.5 + 0.5;
  float blot = fbm( p * 2.60, 3 ) * 0.5 + 0.5;
  float grit = fbm( p * 11.0, 3 ) * 0.5 + 0.5;
  float mica = fbm( p * 34.0, 2 ) * 0.5 + 0.5;
  float near = 1.0 - smoothstep( 6.0, 40.0, dist );

  /* ---- CAVITY STRUCTURE, not speckle.
   *
   * MEASURED (shots/props-r1/lantern.png, the kasa at 3.4x): r2 read as
   * camouflage — an isotropic pale/dark mottle with no readable form. Two causes,
   * both fixed here. (1) The tone stack below summed to +-1.8 against a
   * clamp window of +-0.29, so most pixels sat ON one clamp or the other: a
   * two-tone dither, i.e. camo. (2) The high-frequency bands (9 cm grit, 3 cm
   * mica, 4 cm speckle) carried more amplitude than the 1.8 m bedding and the
   * 38 cm blotches, so nothing at object scale read at all.
   *
   * The cavity field is now the PRIMARY structure: a 60 cm joint/cleavage
   * network (the crack pattern a mason leaves) with a secondary 12 cm pit band,
   * both narrow — smoothstep windows tightened so they draw LINES rather than
   * broad stains. That is the review's "cavity/crevice mask at #6E6A62 against
   * #9E9A92 faces".
   */
  float joint = smoothstep( 0.28, 0.02, pWorley3( p * 1.70, N0 ) );
  float pit   = smoothstep( 0.17, 0.015, pWorley3( p * 8.50, N0 ) );
  float crev  = clamp( ( joint * 0.92 + pit * 0.46 ) * ( 0.45 + 0.55 * vStone.z ), 0.0, 1.0 );
  /* A 4 cm quarry-tooling speckle, kept ONLY as a small within-patch variance
   * term. It used to also drive the shading normal at full strength, which is
   * what actually destroyed the facets (see the normal block below). */
  float fp0 = pWorley3( p * 26.0 + 9.3, N0 );
  float fp1 = pWorley3( p * 26.0 - 9.3, N0 );
  float micro = ( fp0 - 0.5 ) * near;

  /* ---- VALUE. #9E9A92 is the MEAN of the surface, not its ceiling.
   *
   * MEASURED, and it is the whole prescription: the r7 shader built its albedo
   * by stacking five multiplicative darkeners on mix(#6E6A62,#9E9A92,..), and a
   * debug render of the albedo alone (PROPS_DBG_ALBEDO) printed the lantern at
   * display L 0.264-0.298 where a flat linear #9E9A92 straight to the
   * framebuffer prints 0.545-0.578 through this same post chain — the albedo was
   * 2.4x too dark before a single light touched it. Everything downstream then
   * read as either a navy silhouette (L 0.12) or, on the grazing band of a
   * 10-segment cylinder where the rim term piled up, blown cream (L 0.94).
   *
   * So: one symmetric tone swing about uStoneLite, clamped, and crevices as the
   * ONLY thing allowed to reach uStoneDark. The clamp window 0.62..1.20 keeps
   * a fully lit patch under L 0.72 and the surface mean on the authored value.
   */
  /* Amplitudes REBALANCED toward object scale, and the total kept INSIDE the
   * clamp so the clamp is a safety rail rather than the thing that draws the
   * pattern. Typical |tone| is now ~0.13 and the worst case 0.44 against a
   * +-0.28 window, so a face reads as one stone with mottling on it. */
  float tone = ( bed - 0.5 ) * 0.44 + ( blot - 0.5 ) * 0.36 + ( grit - 0.5 ) * 0.20
             + ( mica - 0.5 ) * 0.11 + micro * 0.15 + vVar.y * 0.07;
  // Centred at 1.06, not 1.0: the crevice, moss and pit fields are all one-sided
  // darkeners, so a tone centred on 1.0 landed the SURFACE MEAN at display L 0.50
  // where a flat linear #9E9A92 prints 0.56. 1.06 puts the mean back on the
  // authored palette value, which is what ART_BIBLE §3 specifies.
  vec3 stone = uStoneLite * clamp( 1.06 + tone, 0.72, 1.22 );
  // Crevices are the ONE thing allowed to reach #6E6A62, and they now reach it
  // properly (0.56 -> 0.86) so a crack reads as a crack instead of a grey stain.
  stone = mix( stone, uStoneDark, crev * 0.86 );
  /* ---- the lit top edge ART_BIBLE §4 / the review both ask for. Every
   * up-facing surface on cut stone is rain-washed and dust-bleached: it is
   * genuinely a lighter, chalkier, less saturated value than the flanks, and on
   * a chamfered arris that lands as a bright 1-3 px line along the top of every
   * cope, eave and collar. Crevices are excluded so a mossy joint on a cope does
   * not get lifted with it. */
  float up0 = clamp( N0.y, 0.0, 1.0 );
  stone *= 1.0 + 0.17 * up0 * up0 * ( 1.0 - crev );
  // hard floor: no cavity, joint or pit may take granite under 0.86 x #6E6A62.
  stone = max( stone, uStoneDark * 0.86 );

  /* ---- moss on the DAMP flank and the UNDERSIDES, lichen on the dry exposed
   * faces. uShadeDir is a fixed world direction (the flank the sun's arc never
   * reaches) because moss is a fact about the place, not about the time of day.
   * Down-facing surfaces get it too — the underside of a kasa eave and the
   * bedding joint of a wall block are where water actually sits. */
  float up    = up0;
  float down  = clamp( -N0.y, 0.0, 1.0 );
  float shade = clamp( dot( N0, normalize( uShadeDir ) ), 0.0, 1.0 );
  float mAmt  = uMossAmt * clamp( vStone.x + vVar.x, 0.0, 1.25 );
  /* MOSS LIVES IN THE CREVICES. r2 drove it from blot (a 38 cm noise band)
   * across the whole surface, which is what put green camo blotches on the middle
   * of every flat face. Water sits in joints, pits and on soffits — so that is
   * where #5C7A3E goes, with only a weak blot modulation to break the outline. */
  float mossMask = crev * 1.05 + down * 0.42 + shade * 0.20 + ( blot - 0.5 ) * 0.26;
  float moss  = smoothstep( 0.26, 0.74, mossMask ) * mAmt;
  moss = clamp( moss, 0.0, 0.62 );                 // never a solid green repaint
  // Biased toward the LIGHTER moss, and hard toward it on down-facing surfaces: a
  // soffit already loses almost all of its sky ambient (nprAmbient hands a
  // down-facing normal the ground bounce, luma 0.024), so laying the dark moss on
  // it too was what put the kasa's eave underside at display L 0.18 — the darkest
  // patch on the prop — and any granite that dark gets pulled violet by the
  // grade's shadow split-tone, which is where r2's magenta blotching came from.
  vec3 mossCol = mix( uMossDark, uMossLite, clamp( 0.30 + blot * 0.55 + down * 0.45, 0.0, 1.0 ) );
  vec3 albedo = mix( stone, mossCol, moss );

  /* Lichen: pale grey-green rosettes (#9AA88C is LIGHTER than granite, so this is
   * a value lift as well as a hue break) on the dry, exposed, up-facing stone.
   * Driven by the 38 cm blotch band, NOT by the 9 cm grit: grit-driven lichen was
   * the pale half of the camouflage. A rosette is 5-15 cm of continuous patch. */
  float ros  = fbm( p * 4.20 + 21.7, 2 ) * 0.5 + 0.5;
  float lich = smoothstep( 0.62, 0.88, ros * 0.60 + blot * 0.30 + up * 0.22 )
             * ( 1.0 - moss ) * 0.44 * clamp( mAmt + 0.35, 0.0, 1.0 );
  albedo = mix( albedo, uLichen, clamp( lich, 0.0, 1.0 ) );

  /* ---- micro-relief.
   *
   * THIS WAS THE BUG that made every stone surface a fuzzy blob. r2 added
   * vec3( (mica-0.5)*1.20 + pitG*1.00, ... ) * near * 0.90 to a unit normal:
   * a worst case of +-1.44 on x and z, i.e. the shading normal was effectively
   * RANDOMISED per pixel at close range. Two consequences, both of them
   * reviewer findings: the granite read as camouflage noise, and the kasa's six
   * roof facets — which the geometry does provide, 60 deg apart — lost their
   * value separation entirely (measured 0.05 between facets against a 0.20
   * target) because the facet's own normal no longer survived to the ramp.
   *
   * MEASURED after: 0.16 total amplitude is ~5 deg of wobble, enough for the pits
   * to dimple and not enough to touch the facet read. */
  float pitG = fp0 - fp1;
  vec3 N = normalize( N0 + vec3( ( mica - 0.5 ) * 0.55 + pitG * 0.45, ( grit - 0.5 ) * 0.30,
                                 ( mica - 0.5 ) * 0.55 - pitG * 0.45 ) * near * 0.16
                         - N0 * crev * near * 0.18 );

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  float ao = clamp( vStone.y * ( 1.0 - crev * 0.34 ), 0.10, 1.0 );
  // rimScale 0.92 -> 0.32 and specScale 0.50 -> 0.19: MEASURED, the rim+spec pair
  // was adding scene-linear 0.37 on the grazing band of the sao (display 0.404
  // with both zeroed vs 0.937 with them on) — a stone post brighter than the sky.
  vec3 col = nprShadeN( albedo, N, nprGeoNormal( vWorldPos, N0 ), V, sm,
                        moss * 0.30, 0.28, mix( 0.19, 0.09, moss ), 0.32, ao );

  col = applyAerial( propsFloor( col ), dist, vWorldPos.y, V );
#ifdef PROPS_DBG_ALBEDO
  col = albedo;
#endif
#ifdef PROPS_DBG_FLAT
  // Five horizontal 1/6 m bands at 1, 1/2, 1/4, 1/8, 1/16 of linear #9E9A92 —
  // one shot gives the whole scene-linear -> display transfer of the post chain.
  col = uStoneLite * exp2( -floor( mod( vWorldPos.y * 6.0, 5.0 ) ) );
#endif
#ifdef PROPS_DBG_NORIM
  col = nprShadeN( albedo, N, nprGeoNormal( vWorldPos, N0 ), V, sm,
                   0.0, 0.0, 0.0, 0.0, ao );
#endif
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 2. Wood — vermilion torii, ema rack, plaques, bamboo
 * ===================================================================== */

export const PROPS_WOOD_VERT = /* glsl */`
attribute vec4 aWood;
attribute vec2 aGrain;
attribute vec4 aVar;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vWood;
varying vec2 vGrain;
varying vec4 vVar;
#include <common>
${GLSL_NOISE}
${GLSL_WIND}
#include <shadowmap_pars_vertex>
void main(){
  vec3 tp = position;
  vec3 tn = normal;
  #ifdef USE_INSTANCING
    tp = ( instanceMatrix * vec4( tp, 1.0 ) ).xyz;
    tn = mat3( instanceMatrix ) * tn;
  #endif
  vWood = aWood;
  vGrain = aGrain;
  vVar = aVar;
  vec4 wp = modelMatrix * vec4( tp, 1.0 );

  #ifdef PROPS_SWAY
    // Hanging plaques: pendulum swing about the rail they hang from, driven by
    // the ONE global wind field so they gust with the grass and the canopy.
    // aWood.z is the distance BELOW the pivot, so the top edge never moves.
    float ph = vVar.w * 6.2831853;
    vec3  w  = windVec( wp.xyz );
    float sw = ( sin( uWindTime * 1.85 + ph ) * 0.55 + sin( uWindTime * 3.10 + ph * 2.3 ) * 0.25 )
             * ( 0.20 + 0.85 * uWindGust );
    float drop = max( -aWood.z, 0.0 );
    wp.xz += ( normalize( vec2( w.x, w.z ) + 1e-5 ) * sw * 0.22 + vec2( w.x, w.z ) * 0.035 ) * drop;
    wp.y  -= drop * drop * sw * sw * 0.14;
  #endif

  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * tn );
  vWorldNormal = wn;
${PROPS_SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PROPS_WOOD_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vWood;
varying vec2 vGrain;
varying vec4 vVar;

uniform vec3  uVermilion;      // #C4322B
uniform vec3  uVermWorn;       // #8E3A32
uniform vec3  uWoodLite;       // sun-bleached bare wood
uniform vec3  uWoodDark;       // grain
uniform vec3  uLichen;         // #9AA88C
uniform vec3  uMoss;           // #5C7A3E
uniform vec3  uInk;

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}
${PROPS_FLOOR}

void main(){
  vec3 N0 = normalize( vWorldNormal );
  #ifdef PROPS_DOUBLE
    N0 = gl_FrontFacing ? N0 : -N0;
  #endif
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float seed = vVar.z;
  // grain space: x runs ALONG the timber, y across it, both in metres
  float rings = snoise( vec3( vGrain.y * 34.0, vGrain.x * 1.10 + seed, 2.7 ) ) * 0.5 + 0.5;
  float fine  = snoise( vec3( vGrain.y * 145.0, vGrain.x * 5.2 + seed, 8.1 ) ) * 0.5 + 0.5;
  float blot  = fbm( vWorldPos * 1.9 + seed, 3 ) * 0.5 + 0.5;
  /* Splits that run WITH the grain — the tell that this is sawn timber.
   *
   * MEASURED / FIXED: the old window (0.86..0.995 on rings*0.55 + fine*0.50,
   * whose maximum is 1.05) only closed where BOTH noise fields peaked together,
   * which happens as isolated 4x6 px islands rather than as lines — and each
   * island then got uWoodDark*0.62 AND enough wear to strip the paint, so it
   * rendered as an unlit near-#000 blob. shots/props-r1/hero.png x 1770-1800
   * y 795-835 had two of them on the right pillar at min L 0.000; the reviewer
   * read them as rendering garbage, and §3 forbids them outright. The window is
   * now anisotropic — narrow ACROSS the grain (145/m fine) and long ALONG it —
   * so it draws hairline checks, and the value it reaches is bounded well above
   * the floor. */
  float split = smoothstep( 0.62, 0.86, fine ) * smoothstep( 0.34, 0.62, rings );

  vec3 wood = mix( uWoodDark, uWoodLite, clamp( rings * 0.74 + fine * 0.30, 0.0, 1.0 ) );
  wood = mix( wood, uWoodDark * 0.88, split * 0.70 );

#ifdef PROPS_BAMBOO
  // green culm: pale internodes, darker rings at each node, vertical striations
  float nodeT = fract( vGrain.x * 3.1 );
  float node  = smoothstep( 0.90, 0.99, nodeT ) + smoothstep( 0.10, 0.01, nodeT );
  vec3 albedo = mix( uWoodLite, uWoodDark, clamp( fine * 0.55 + blot * 0.45, 0.0, 1.0 ) );
  albedo = mix( albedo, uWoodDark * 0.72, clamp( node, 0.0, 1.0 ) * 0.85 );
  albedo = mix( albedo, uMoss, smoothstep( 0.55, 0.95, blot ) * 0.28 );
  float specS = 0.62, rimS = 1.0, transl = 0.10;
#elif defined( PROPS_EMA )
  // votive plaque: pale planed cedar, a red ink stroke, a grubby thumbed edge
  vec3 albedo = mix( uWoodLite, uWoodLite * 0.88, rings * 0.7 );
  albedo = mix( albedo, uWoodDark, split * 0.5 );
  vec2 g = vGrain * vec2( 1.0, 1.0 );
  float ink = smoothstep( 0.55, 0.80, snoise( vec3( g * 22.0 + vVar.z * 9.0, 1.3 ) ) * 0.5 + 0.5 )
            * smoothstep( 0.42, 0.30, abs( g.y ) );
  albedo = mix( albedo, uInk, clamp( ink, 0.0, 1.0 ) * 0.80 );
  albedo *= 0.92 + 0.16 * vVar.y;
  float specS = 0.30, rimS = 1.05, transl = 0.34;
#else
  // ---- vermilion paint, worn back to grey wood.
  // vWood.x is the BAKED exposure (edges, arrises, the bottom of a pillar); the
  // noise only breaks its outline up, so the wear pattern is authored, not random.
  /* RAIN-WASHED TOP FACES. Every up-facing surface of an outdoor painted beam
   * chalks and bleaches years before its flanks do — the kasagi's top is the
   * classic example, which is exactly the "does the beam read as solid?" cue the
   * review asked for.
   *
   * It is expressed as CHALKING (a lighter, less saturated vermilion) and only
   * barely as paint LOSS. MEASURED why: at upW^2*0.24 of wear the kasagi's top
   * went 58% bare timber, and bare weathered wood is near-neutral (#877662 is 27%
   * saturated) — so nprShadowHue's multiply, which a saturated albedo can defend
   * against but a neutral one cannot, printed it as a saturated navy strip
   * (shots/props-r2/hero.png x 1440-1560 y 598-612 measured rgb(38,30,66)).
   * Keeping the top PAINTED keeps a red albedo that survives the tint multiply,
   * and the top-vs-front value separation then comes from the key, where it
   * belongs: 0.74 on the lit top against 0.13-0.25 on the backlit front face. */
  float upW = clamp( N0.y, 0.0, 1.0 );
  float wear = clamp( vWood.x + ( blot - 0.5 ) * 0.80 + split * 0.20 + upW * upW * 0.08,
                      0.0, 1.4 );
  float paintCov = vWood.y * ( 1.0 - smoothstep( 0.30, 0.90, wear ) );

  vec3 paint = mix( uVermilion, uVermWorn,
                    clamp( wear * 0.78 + ( blot - 0.5 ) * 0.55, 0.0, 1.0 ) );
  // chalking: UV-bleached blooms where the paint has gone powdery, strongest on
  // the faces the rain sits on
  paint = mix( paint, paint * 1.10 + vec3( 0.040, 0.028, 0.024 ),
               clamp( pow( fine, 2.4 ) * 0.40 + upW * upW * 0.42, 0.0, 1.0 ) );
  // hairline crazing
  paint *= 1.0 - smoothstep( 0.72, 0.98, worley( vGrain * 22.0 + seed ) ) * 0.16;

  vec3 albedo = mix( wood, paint, clamp( paintCov, 0.0, 1.0 ) );
  // r5 measured a vermilion pillar at sRGB 240,215,200 — the paint was there
  // (paintCov ~0.4 confirmed off the attribute) but the specular + rim on a
  // CYLINDER, which is grazing over most of its width, blew the red channel out
  // and desaturated the whole post to cream. Both terms roughly halved.
  // rimScale 0.34 -> 0.62 now that tube() winds the right way: r7's pillars fired
  // both rim terms at full strength across their entire width (rimRaw was pinned
  // at 1 because the far wall's normal faced away from the camera), so the rim had
  // to be dialled almost off. With the winding fixed the rim is confined to the
  // grazing band where ART_BIBLE §2 wants it, and the pillar needs it back to
  // separate from the sky.
  float specS = mix( 0.14, 0.26, paintCov );
  float rimS = 0.62, transl = 0.0;
#endif

#ifndef PROPS_EMA
  // ---- lichen + moss creeping up from the ground contact. vWood.z is metres
  // above the foot of the member, so this cannot smear up a horizontal beam.
  float low  = 1.0 - smoothstep( 0.05, 0.95, vWood.z );
  float damp = 1.0 - smoothstep( 0.0, 0.34, vWood.z );
  albedo = mix( albedo, uLichen, smoothstep( 0.42, 0.90, low * 0.72 + blot * 0.52 ) * 0.50 );
  albedo = mix( albedo, uMoss, smoothstep( 0.50, 0.95, damp * 0.80 + blot * 0.42 ) * 0.72 );
#endif

  float near = 1.0 - smoothstep( 4.0, 30.0, dist );
  vec3 N = normalize( N0 + vec3( ( fine - 0.5 ) * 0.42, ( rings - 0.5 ) * 0.18, ( fine - 0.5 ) * 0.42 )
                          * near * 0.34 );

  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  float ao = clamp( vWood.w * ( 1.0 - split * 0.30 ), 0.06, 1.0 );
  vec3 col = nprShadeN( albedo, N, nprGeoNormal( vWorldPos, N0 ), V, sm,
                        transl, 0.42, specS, rimS, ao );

  col = applyAerial( propsFloor( col ), dist, vWorldPos.y, V );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 3. Lantern fire-box paper panels
 * ===================================================================== */

export const PROPS_WINDOW_VERT = /* glsl */`
attribute vec4 aVar;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vPUv;
varying vec4 vVar;
varying vec3 vFlame;
#include <common>
#include <shadowmap_pars_vertex>
void main(){
  vec3 tp = position;
  vec3 tn = normal;
  #ifdef USE_INSTANCING
    tp = ( instanceMatrix * vec4( tp, 1.0 ) ).xyz;
    tn = mat3( instanceMatrix ) * tn;
  #endif
  vVar = aVar;
  vPUv = uv;
  vFlame = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vFlame = instanceColor;      // per-lantern flicker, written each frame
  #endif
  vec4 wp = modelMatrix * vec4( tp, 1.0 );
  vWorldPos = wp.xyz;
  vec3 wn = normalize( mat3( modelMatrix ) * tn );
  vWorldNormal = wn;
${PROPS_SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PROPS_WINDOW_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vPUv;
varying vec4 vVar;
varying vec3 vFlame;

uniform vec3  uPaper;          // lit washi
uniform vec3  uPaperCold;      // the same panel, unlit — a dark recess
uniform vec3  uFlameCore;
uniform float uGlow;
uniform float uTime;

${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}
${PROPS_FLOOR}

void main(){
  vec3 N0 = normalize( vWorldNormal );
  N0 = gl_FrontFacing ? N0 : -N0;
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  float glow = clamp( uGlow * vFlame.r, 0.0, 2.0 );

  // washi: visible fibres, and a hot centre where the flame sits behind it
  vec2 uv = vPUv * 2.0 - 1.0;
  float fib = snoise( vec3( vPUv * vec2( 26.0, 90.0 ), 4.3 ) ) * 0.5 + 0.5;
  // laid-paper cross ribs, so the panel is never a flat fill even at 25 px
  float rib = ( snoise( vec3( vPUv * vec2( 3.0, 12.0 ), 1.9 ) ) * 0.5 + 0.5 ) * 0.5
            + ( snoise( vec3( vPUv * vec2( 11.0, 2.0 ), 5.4 ) ) * 0.5 + 0.5 ) * 0.5;
  float centre = 1.0 - smoothstep( 0.10, 1.15, length( uv * vec2( 1.0, 0.86 ) ) );
  float flick = 0.86 + 0.14 * ( snoise( vec3( vPUv * 3.0, uTime * 2.6 ) ) * 0.5 + 0.5 );
  // the iron burner sits low and centre and is opaque — a dark bar against the
  // glow, which is the single cue that says "there is a flame BEHIND paper"
  float burner = ( 1.0 - smoothstep( 0.10, 0.34, abs( uv.x ) ) )
               * ( 1.0 - smoothstep( -0.86, -0.44, uv.y ) );

  /* UNLIT PANEL. MEASURED: shots/props-r1/lantern.png x 1320-1345 y 155-215 read
   * display L 0.903 in BROAD DAYLIGHT with uGlow = 0 — a blown cream slab, which
   * is the reviewer's "flat pale-yellow rectangles that cast no light". The cause
   * was translucency 0.85 x thickness 0.55 on a BACKLIT thin panel: nprKeyG's
   * wrapped transmission lobe fired at full strength and turned a #3A3630 recess
   * into white. Washi over a dark fire box transmits a little, not a lot: 0.16 x
   * 0.22 lands it at a dim warm recess, which is what a daytime ishidoro is. */
  vec3 cold = mix( uPaperCold, uPaperCold * 1.45, fib * 0.55 + rib * 0.25 );
  cold *= 1.0 - 0.30 * smoothstep( 0.35, 1.0, abs( uv.y ) );   // frame shading
  vec3 sm0 = nprShadeN( cold, N0, N0, V, 1.0, 0.16, 0.22, 0.08, 0.40, 0.22 );

  /* LIT PANEL. Emissive — it is the light source, not a lit surface — so it
   * bypasses the NPR key and lands above the bloom threshold. Peak exposure at
   * the flame centre is (1.65 + 2.05) = 3.70x the paper albedo, i.e. the 3.5x the
   * review asked for once the fibre term's 0.55..1.30 swing is averaged in. */
  vec3 hotCol = mix( uPaper, uFlameCore, centre * 0.72 ) * ( 0.55 + 0.75 * fib );
  hotCol *= flick * glow * ( 1.65 + 2.05 * centre ) * ( 0.82 + 0.30 * rib );
  hotCol *= 1.0 - burner * 0.72;

  vec3 col = sm0 + hotCol;
  col = applyAerial( propsFloor( col ), dist, vWorldPos.y, V );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 4. Additive flame halo (camera-facing, instanced)
 * ===================================================================== */

export const PROPS_HALO_VERT = /* glsl */`
varying vec2 vQ;
varying vec3 vFlame;
uniform float uSize;
#include <common>
void main(){
  vQ = position.xy * 2.0;
  vFlame = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vFlame = instanceColor;
  #endif
  vec4 centre = vec4( 0.0, 0.0, 0.0, 1.0 );
  float sc = 1.0;
  #ifdef USE_INSTANCING
    centre = instanceMatrix * centre;
    sc = length( vec3( instanceMatrix[ 0 ][ 0 ], instanceMatrix[ 0 ][ 1 ], instanceMatrix[ 0 ][ 2 ] ) );
  #endif
  vec4 mv = viewMatrix * modelMatrix * centre;
  mv.xy += position.xy * uSize * sc;
  gl_Position = projectionMatrix * mv;
}
`;

export const PROPS_HALO_FRAG = /* glsl */`
varying vec2 vQ;
varying vec3 vFlame;
uniform vec3  uHaloColor;
uniform vec3  uHaloCore;
uniform float uGlow;
#include <common>
void main(){
  float r = length( vQ );
  if ( r > 1.0 ) discard;
  float glow = clamp( uGlow * vFlame.r, 0.0, 2.0 );
  // two lobes: a small hot core the bloom pass latches onto, and a wide hazy
  // skirt so the lantern sits in a pool of air rather than wearing a hard disc
  /* Three lobes now, not two. The quad is 3.15 m across at full glow (was 1.9),
   * so the skirt covers the 2.5 m warm falloff the review asked for; its per-pixel
   * strength is cut from 0.62 to 0.40 and a mid lobe added, so the TOTAL additive
   * energy is close to r2's while the pool of air round the fire box is twice as
   * wide. A wide soft skirt is what stops the bloom pass reading as a hard white
   * halo (ART_BIBLE §8.12). */
  float core = pow( 1.0 - smoothstep( 0.0, 0.26, r ), 2.4 );
  float mid  = pow( 1.0 - smoothstep( 0.0, 0.58, r ), 2.2 );
  float skirt = pow( 1.0 - smoothstep( 0.0, 1.0, r ), 2.0 );
  vec3 col = uHaloCore * core * 2.05 + uHaloColor * ( mid * 0.44 + skirt * 0.40 );
  gl_FragColor = vec4( col * glow, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ===================================================================== *
 * 5. The tsukubai's water disc
 * ===================================================================== */

export const PROPS_BASIN_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec2 vBUv;
#include <common>
#include <shadowmap_pars_vertex>
void main(){
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vBUv = uv;
  vec3 wn = vec3( 0.0, 1.0, 0.0 );
${PROPS_SHADOW_VERT('wp', 'wn')}
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PROPS_BASIN_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec2 vBUv;
uniform vec3  uDeep;
uniform float uTime;
${GLSL_NOISE}
${FRAG_SHADOW_PARS}
${GLSL_NPR}
${PROPS_FLOOR}
void main(){
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  // concentric ripple rings from the spout's drip, plus a slow slosh
  vec2 c = vBUv * 2.0 - 1.0;
  float r = length( c );
  float ring = sin( r * 46.0 - uTime * 4.2 ) * exp( -r * 2.2 ) * 0.5
             + sin( r * 22.0 - uTime * 2.1 + 1.7 ) * 0.5;
  float n = snoise( vec3( vBUv * 12.0, uTime * 0.55 ) );
  vec3 N = normalize( vec3( ( ring * 0.9 + n * 0.5 ) * c.x * 0.55 + n * 0.10, 1.0,
                            ( ring * 0.9 + n * 0.5 ) * c.y * 0.55 - n * 0.10 ) );

  float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.6 );
  vec3 albedo = mix( uDeep, uSkyColor * 1.5 + uFogColor * 0.35, clamp( fres * 1.25 + 0.16, 0.0, 1.0 ) );
  float sm = nprShadowMaskSoft( vWorldPos );
  nprSetWorldPos( vWorldPos );
  vec3 col = nprShadeN( albedo, N, vec3( 0.0, 1.0, 0.0 ), V, sm, 0.0, 0.0, 2.6, 1.3, 0.72 );
  col = applyAerial( propsFloor( col ), dist, vWorldPos.y, V );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
