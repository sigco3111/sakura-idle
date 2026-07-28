/**
 * Sakura — shared NPR lighting library.
 * Owner: lighting agent (08-lighting.js). Other modules IMPORT from here; never edit.
 *
 * What lives here
 *   GLSL_LIGHT_UNIFORMS   the uniform declarations for the shared bag (CONTRACT.md)
 *   GLSL_NPR              nprShade / rimTerm / applyAerial + helpers  (ART_BIBLE §2)
 *   createLightUniforms() the JS uniform bag (objects are shared BY REFERENCE)
 *   samplePalette(dayT)   the ART_BIBLE dawn/day/dusk/night palette, interpolated
 *   writePhaseColors()    writes a sampled palette into the uniform bag (mutates .value)
 *   createNprMaterial()   a ready-made ramp-shaded ShaderMaterial (shadow-receiving,
 *                         instancing-aware) so surface modules get the look for free
 *   createSkyMaterial()   the procedural gradient sky used for IBL + the fallback dome
 *
 * Animated key breakup (ART_BIBLE §6). The rig publishes `uDapple` in the shared
 * bag; nprShade folds it into the key automatically. If you write your own GLSL
 * and want the SPATIAL dapple (not just the global gust), call
 * `nprSetWorldPos(worldPos)` in your fragment shader before nprShade*. Both
 * createNprMaterial() and applyNPR() already do this for you.
 *
 * Usage in a surface module:
 *   import { GLSL_NPR } from '../lib/lighting.js';
 *   const L = ctx.assets.lightUniforms;
 *   material.uniforms = { ...L, ...WIND.uniforms, ...mine };   // SHARED objects
 *   fragmentShader = `${GLSL_NPR}\n ... nprShade(albedo,N,V,sm,transl,thick) ...`
 *
 * Or simply:
 *   const m = createNprMaterial({ lightUniforms: L, color: 0xffb6ce, translucency: 1 });
 *
 * SHADOWS. createNprMaterial() and applyNprToStandard() automatically use
 * nprShadowMaskSoft() — a 16-tap Vogel filter whose radius grows with the
 * receiver-to-blocker distance, so a cast shadow has a real penumbra that is
 * tight at the contact point and wide out under the canopy. If you write your
 * own ShaderMaterial and include three's <shadowmap_pars_fragment> +
 * <shadowmask_pars_fragment>, add `defines: { NPR_HAS_SHADOWMAP: '' }` and call
 * `nprShadowMaskSoft(worldPos)` instead of `getShadowMask()` to get the same
 * penumbra. Plain getShadowMask() still works and still composites correctly —
 * it is just a narrower filter.
 *
 * DEBUG. `window.__game.scenarios.calib` (and `calib-raw` / `calib-dawn` / …)
 * shows the lighting rig's own grey/white/pink/bark calibration balls on a
 * shadow-catcher slab in front of the tree. Use it to MEASURE the model rather
 * than eyeball it; ART_BIBLE §2 wants the shadow side of the 0.50 grey ball at
 * ~0.55 of the lit side's luminance in the FINAL graded frame.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './noise.js';

/* ===================================================================== *
 * 1. GLSL — the shared uniform block
 * ===================================================================== */

export const GLSL_LIGHT_UNIFORMS = /* glsl */`
#ifndef SAKURA_LIGHT_UNIFORMS_INCLUDED
#define SAKURA_LIGHT_UNIFORMS_INCLUDED
uniform vec3  uSunDir;        // normalised, world space, surface -> sun
uniform vec3  uSunColor;      // linear key colour * intensity
uniform vec3  uSkyColor;      // linear zenith ambient
uniform vec3  uGroundColor;   // linear bounce ambient from below
uniform vec3  uShadowTint;    // linear colour shadowed albedo is pushed toward
uniform vec3  uFogColor;      // linear aerial-perspective colour
uniform vec3  uFogParams;     // (density, heightFalloff, startDistance)
uniform vec3  uMoonDir;       // night key direction
uniform float uNightMix;      // 0 = full day, 1 = full night
uniform float uPhaseT;        // 0..1 progress through the current phase
uniform float uExposure;      // scene exposure multiplier
// Animated key breakup (ART_BIBLE §6 "light dapples through the canopy").
//   .xy = world-XZ scroll offset of the dapple field, already in noise units
//   .z  = dapple amplitude (0 = off)
//   .w  = global gust multiplier on the key, ~0.94..1.06  (0 => treated as 1)
uniform vec4  uDapple;
// Soft-shadow / penumbra control, written by 08-lighting.js every frame.
//   .xyz = world-space centre of the shadow-CASTING set (the tree, props, …)
//   .w   = shadow-map UV units per world unit  (1 / ortho box extent)
// A receiver's distance to .xyz measured ALONG the key is a cheap stand-in for
// "how far is the blocker", which is what sets penumbra width. See
// nprShadowMaskSoft().
uniform vec4  uShadowSoft;
#endif
`;

/* ===================================================================== *
 * 2. GLSL — the NPR shading model (ART_BIBLE §2, implemented literally)
 * ===================================================================== */

export const GLSL_NPR = /* glsl */`
${GLSL_LIGHT_UNIFORMS}
#ifndef SAKURA_NPR_INCLUDED
#define SAKURA_NPR_INCLUDED

const vec3 NPR_LUMA = vec3(0.2126, 0.7152, 0.0722);
// #FFE3EC / #FFE7EE converted to linear — the warm tint light takes on when it
// bleeds THROUGH a petal. This is the colour that makes backlit sakura glow.
const vec3 NPR_TRANSMIT_TINT = vec3(1.000, 0.768, 0.838);

/* ---- per-material tuning, compile-time so a module never has to supply an
        extra uniform just to get the house look. Override with defines:
          defines: { NPR_SHADOW_HUE: '0.30' }                                */
#ifndef NPR_SHADOW_HUE
  // How much of the ALLOWED hue rotation toward uShadowTint is taken (0..1).
  // The rotation itself is hard-capped at NPR_SHADOW_HUE_MAX degrees, so this
  // dial can sit near 1 without a shadow ever losing its own hue identity.
  #define NPR_SHADOW_HUE 0.95
#endif
#ifndef NPR_SHADOW_HUE_MAX
  // Hard cap, in DEGREES, on how far a shadowed albedo's hue may rotate toward
  // uShadowTint. This is the fix for the old model: it rotated the hue all the
  // way onto the tint, so shadowed grass became navy and shadowed bark became
  // navy — ART_BIBLE §2 requires the surface to stay recognisably its own
  // colour while shifting cool. A near-NEUTRAL albedo is exempt (it has no hue
  // of its own to protect) and takes the tint's hue outright.
  #define NPR_SHADOW_HUE_MAX 22.0
#endif
#ifndef NPR_SHADOW_LEVEL
  // Linear HDR level of the shadow diffuse as a fraction of albedo*key, before
  // the albedo-luminance compensation in nprShadowLevel(). Calibrated against
  // the 0.50-grey ball in 50-smoke.js measured in the COMPOSITED, GRADED png:
  // ART_BIBLE §2 wants the shadow side at ~0.55 of the lit side's luminance.
  #define NPR_SHADOW_LEVEL 0.55
#endif
#ifndef NPR_SHADOW_CHROMA
  // How far the shadowed albedo's SATURATION is pulled toward the tint's. Not a
  // gain: a vivid albedo desaturates slightly, a neutral one picks up the
  // tint's chroma, and nothing is pushed past the tint's own (fairly modest)
  // saturation. Over-driving this is what collapsed the red channel of every
  // shadow into an electric navy under ACES.
  #define NPR_SHADOW_CHROMA 0.62
#endif
#ifndef NPR_AMBIENT_SHADOW
  // an occluded point sees less sky. Below ~0.45 the cast shadow stops reading
  // as shadowed GROUND and starts reading as a painted-on dark decal.
  #define NPR_AMBIENT_SHADOW 0.38
#endif
#ifndef NPR_SHADOW_CORE
  // Depth of the 4th "deep interior" plateau in the very core of a FORM shadow,
  // as a multiplier on the shadow level. Cast shadows never get it — that is
  // what turned the tree's ground shadow into an opaque lozenge.
  #define NPR_SHADOW_CORE 0.86
#endif
#ifndef NPR_PENUMBRA_SLOPE
  // World metres of penumbra per metre of blocker distance — i.e. the key's
  // apparent angular size. The real sun is 0.0093; a stylised soft key reads
  // better and hides shadow-map resolution.
  #define NPR_PENUMBRA_SLOPE 0.0065
#endif
#ifndef NPR_PENUMBRA_MIN
  #define NPR_PENUMBRA_MIN 0.040
#endif
#ifndef NPR_PENUMBRA_MAX
  // 94 mm. This is a HARD budget, not a taste dial: nprShadowMaskSoft converts
  // it to shadow-map texels, and on the fitted 24 m box at 2048 that is 8 texels
  // — the widest a 16-tap Vogel disk can span before the taps stop overlapping
  // and the penumbra dissolves the shadow instead of softening it. The old 0.34
  // (29 texels, clamped to the 26 ceiling) is exactly why no cast shadow landed
  // on the terrain: the disk was averaging lit ground back into every sample.
  #define NPR_PENUMBRA_MAX 0.094
#endif
#ifndef NPR_AERIAL_VALUE
  // How much of a surface's own relative luminance survives full aerial
  // perspective. 0 = every distant surface converges on one flat fog colour
  // (the milky white-out); 1 = no value compression at all. ART_BIBLE §5 needs
  // the three distant hill bands to stay separable by value.
  #define NPR_AERIAL_VALUE 0.45
#endif
#ifndef NPR_RIM_SKY
  // Amplitude of the PHASE-INDEPENDENT Fresnel rim. ART_BIBLE §2 lists "rim light
  // on every silhouette" as the thing that reads as anime, and a rim that only
  // exists when the key happens to sit behind the subject is not "every
  // silhouette" — at a high sun the whole canopy loses its edge against the sky.
  // This term is the sky itself grazing off the silhouette, so it fires at noon.
  #define NPR_RIM_SKY 0.26
#endif
#ifndef NPR_DAPPLE_FREQ
  // world metres -> dapple-noise units. MUST match DAPPLE_FREQ on the JS side.
  #define NPR_DAPPLE_FREQ 0.42
#endif

float nprLuma(vec3 c){ return dot(c, NPR_LUMA); }

/* --- animated key breakup ------------------------------------------------
   A 2-octave, curl-warped value-noise field in world XZ, scrolled by the
   lighting rig along the global wind direction. Self-contained on purpose:
   GLSL_NPR is injected into every surface shader in the project, so it must
   not drag GLSL_NOISE's 200 lines (or a full curlNoise's 12 simplex taps)
   in with it. nprSetWorldPos() opts a shader into the SPATIAL dapple; a
   shader that never calls it still gets the temporal gust breathing. */
vec3 nprDappleWP = vec3(1.0e9);          // sentinel: "world position unknown"
void nprSetWorldPos(vec3 p){ nprDappleWP = p; }

float nprHash2(vec2 p){
  p = fract(p * vec2(127.34, 311.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float nprNoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(nprHash2(i),               nprHash2(i + vec2(1.0, 0.0)), u.x),
             mix(nprHash2(i + vec2(0.0, 1.0)), nprHash2(i + vec2(1.0, 1.0)), u.x), u.y);
}

/** Global slow gust on the key. 1.0 when nobody is driving uDapple. */
float nprKeyGust(){ return uDapple.w > 0.0 ? uDapple.w : 1.0; }

/** 1 = full sun through a gap, (1 - amplitude) = under a leaf clump. */
float nprDappleMask(){
  float amp = clamp(uDapple.z, 0.0, 0.9);
  if (amp <= 0.0) return 1.0;
  vec2 q = nprDappleWP.x > 1.0e8 ? uDapple.xy
                                 : nprDappleWP.xz * NPR_DAPPLE_FREQ + uDapple.xy;
  float a = nprNoise2(q);
  // warp the second octave by the first -> swirled, divergence-free-looking
  // filaments instead of the tell-tale blobby fbm lattice.
  vec2  w = vec2(a, nprNoise2(q + 19.73)) - 0.5;
  float b = nprNoise2(q * 2.37 + w * 1.30 + 7.31);
  float n = a * 0.62 + b * 0.38;
  return 1.0 - amp * (1.0 - smoothstep(0.24, 0.82, n));
}

/* --- Fresnel rim ---------------------------------------------------- */
float rimTerm(vec3 N, vec3 V, float power){
  float f = 1.0 - clamp(dot(normalize(N), normalize(V)), 0.0, 1.0);
  return pow(clamp(f, 0.0, 1.0), power);
}

/* --- the ramp: THREE flat plateaus (0 / 0.5 / 1) separated by two 0.04-wide
       smoothsteps. Deliberately not one wide smoothstep — the whole point is
       that each band is measurably flat so the terminator reads as a drawn
       edge, ART_BIBLE §2: shadow below 0.42, mid band 0.42..0.52, lit above. */
float nprRamp(float d){
  return smoothstep(0.40, 0.44, d) * 0.5 + smoothstep(0.50, 0.54, d) * 0.5;
}

/* --- HSV helpers (Sam Hocevar / iq's branchless pair). Used only by the shadow
       tint, so the cost is one conversion per fragment.                     */
vec3 nprRgb2Hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);
}
vec3 nprHsv2Rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

/* --- level-preserving, HUE-LIMITED shift of albedo toward the shadow tint.
       ART_BIBLE §2: shadowed albedo is "pushed toward cool violet-blue", not
       repainted with it. So: rotate the albedo's hue toward the tint's hue but
       never by more than NPR_SHADOW_HUE_MAX degrees, blend its saturation
       partway to the tint's, and restore the original luminance so this stays a
       pure chromatic operation (nprShadowLevel owns the value).

       The previous implementation mixed albedo toward luma(albedo)*chroma at
       0.84, which is a FULL hue replacement: green grass landed on 232 deg and
       brown bark on 232 deg too. Both then read as navy paint. */
vec3 nprShadowHue(vec3 albedo){
  float al = max(nprLuma(albedo), 1e-4);
  vec3 a = nprRgb2Hsv(max(albedo, vec3(0.0)));
  vec3 t = nprRgb2Hsv(max(uShadowTint, vec3(0.0)));

  float dh = t.x - a.x;
  dh -= floor(dh + 0.5);                             // shortest way round, -0.5..0.5

  // The further an albedo's hue already is from the tint, the LESS it may
  // rotate. Without this, a warm brown takes the short arc toward violet, which
  // runs through red and magenta: the placeholder trunk came out plum. A warm
  // surface in cool shade should mostly just cool and desaturate.
  float away   = clamp(abs(dh) * 2.0, 0.0, 1.0);     // 0 = same hue, 1 = opposite
  float maxRot = NPR_SHADOW_HUE_MAX * (1.0 / 360.0) * mix(1.0, 0.35, away);

  // A near-neutral albedo has no hue to protect (and rgb2hsv reports 0 = red
  // for it), so let it take the tint's hue outright.
  float neutral = 1.0 - smoothstep(0.03, 0.20, a.y);
  a.x = fract(a.x + mix(clamp(dh, -maxRot, maxRot), dh, neutral) * NPR_SHADOW_HUE);

  // Saturation moves toward the tint's, but a surface that is ALREADY more
  // saturated than the tint must not gain chroma in shadow — that is how the
  // old model produced electric navy grass and plum bark. Only a near-neutral
  // albedo is allowed to pick the tint's chroma up.
  float satTarget = mix(min(a.y, t.y), t.y, neutral);
  a.y = clamp(mix(a.y, satTarget, NPR_SHADOW_CHROMA), 0.0, 1.0);

  vec3 sh = nprHsv2Rgb(a);
  return sh * (al / max(nprLuma(sh), 1e-4));         // luminance-preserving
}

/* --- shadowed albedo: hue-shifted toward uShadowTint at a fixed fraction of
       the lit level, never toward black. */
/* A dark albedo's shadow needs a bigger fraction than a bright one: ACES + sRGB
   crush the bottom of the range, so a flat fraction turns bark into a black
   slab while grass still reads. This keeps the ON-SCREEN light:shadow ratio
   roughly constant across the palette. */
float nprShadowLevel(float al){
  // The transition is over albedo luma 0.01..0.10, NOT 0.03..0.24. Measured on
  // the calibration chart: with the wider window a bark-dark albedo (luma 0.10)
  // sat halfway up the boost curve and its shadow came out at 0.91 of its lit
  // side while the 0.50 grey next to it sat at 0.55. Only genuinely near-black
  // albedos need the lift (ACES + sRGB crush the bottom of the range); anything
  // from bark upward wants the same flat fraction.
  return NPR_SHADOW_LEVEL * mix(2.20, 0.66, smoothstep(0.010, 0.100, al));
}

/* The "never black" floor. It keeps the tint's LEVEL but takes 45% of its HUE
   from the shadowed surface: a pure blue-violet pedestal under a dark warm
   albedo is what tipped bark's deepest shadow into purple. */
vec3 nprShadowFloor(vec3 shHue){
  float lt = nprLuma(uShadowTint);
  return mix(uShadowTint, shHue * (lt / max(nprLuma(shHue), 1e-4)), 0.45);
}
vec3 nprShadowAlbedo(vec3 albedo, vec3 kcol){
  float kl = clamp(nprLuma(kcol), 0.05, 1.15);
  vec3 shHue = nprShadowHue(albedo);
  vec3 sh = shHue * (nprShadowLevel(nprLuma(albedo)) * kl);
  sh += nprShadowFloor(shHue) * (0.040 * kl);
  return max(sh, vec3(0.006));                         // never pure black
}
vec3 nprShadowAlbedo(vec3 albedo){ return nprShadowAlbedo(albedo, uSunColor); }

/* --- directional ambient: sky from above, bounce from below ---------- */
vec3 nprAmbient(vec3 N){
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(uGroundColor, uSkyColor, up * up * 0.82 + up * 0.18);
}

/* --- true faceted normal from screen-space derivatives.
       Interpolated vertex normals lie about the surface the shadow map actually
       rasterised: a smooth-shaded icosahedron canopy has facets whose real
       normal can face away from the light while the shading normal still faces
       it, and those facets then self-shadow as hard-edged triangular wedges.
       Gating the shadow lookup on THIS normal removes them.               */
vec3 nprGeoNormal(vec3 worldPos, vec3 N){
  vec3 g = cross(dFdx(worldPos), dFdy(worldPos));
  float l = length(g);
  if (l < 1e-9) return N;
  g /= l;
  return dot(g, N) < 0.0 ? -g : g;
}

/* --- Shadow-map credibility.
       At a surface's own terminator the depth gradient seen from the light is
       near-infinite, so the map speckles and normalBias cannot help (the
       normal is perpendicular to the light there, so offsetting along it moves
       nothing in depth). Fade the map out as NdotL approaches zero: the ramp is
       already putting that region in shadow, so nothing is lost and all
       terminator acne disappears. */
float nprShadowFade(float ndl, float shadowMask){
  return mix(1.0, clamp(shadowMask, 0.0, 1.0), smoothstep(0.0, 0.38, ndl));
}

/* --- the cast-shadow factor.
       This is the single most important line for making a cast shadow read as
       shadowed GROUND rather than a dark decal stuck to it. The old model did
       min(halfLambert, mix(0.205, 1.0, sm)), which squeezed the whole
       penumbra into shadowMask 0.245..0.42 — a 0.175-wide window out of 1.0 —
       so every shadow edge in the frame was effectively a binary step with a
       hard geometric outline. Using the FULL range of the mask instead turns
       the filter's own falloff into a real, soft, anti-aliased penumbra. */
float nprCast(float sm){
  return smoothstep(0.015, 0.985, clamp(sm, 0.0, 1.0));
}

/* --- wide, distance-aware soft shadow lookup.
       Opt in with a #define NPR_HAS_SHADOWMAP in a material that also includes
       <shadowmap_pars_fragment> (createNprMaterial and applyNprToStandard both
       do). Anything else keeps using three's 5-tap getShadowMask() and simply
       gets a slightly tighter penumbra — the shading maths is identical.

       Penumbra width grows with the receiver-to-blocker distance, which is what
       ART_BIBLE §2's "soft shadow" actually means physically: hard at the
       contact point under the trunk, wide out under the canopy. A
       sampler2DShadow cannot report blocker depth, so the rig publishes the
       shadow-casting set's bounding centre in uShadowSoft.xyz and we use the
       distance to it ALONG the key as the proxy. The tap radius is additionally
       capped in TEXELS so the disk never has to span more map than it can
       resolve. */
#if defined( NPR_HAS_SHADOWMAP ) && defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && NUM_DIR_LIGHT_SHADOWS > 0
  #define NPR_SOFT_SHADOW
#endif

/* Only declared when the material opted in — a shader that includes GLSL_NPR
   without three's shadow chunks must not see a reference to getShadowMask(). */
#ifdef NPR_HAS_SHADOWMAP
#ifdef NPR_SOFT_SHADOW
float nprShadowMaskSoft(vec3 worldPos){
  if ( ! receiveShadow ) return 1.0;
  DirectionalLightShadow dls = directionalLightShadows[ 0 ];
  vec4 sc = vDirectionalShadowCoord[ 0 ];
  sc.xyz /= sc.w;
  sc.z += dls.shadowBias;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;

  vec3 L = normalize( mix( uSunDir, uMoonDir, step( 0.5, uNightMix ) ) );
  float h = max( dot( uShadowSoft.xyz - worldPos, L ), 0.0 );
  float wWorld = clamp( h * NPR_PENUMBRA_SLOPE, NPR_PENUMBRA_MIN, NPR_PENUMBRA_MAX );
  // 8.5-texel ceiling: past that the 16 taps no longer overlap and the filter
  // averages surrounding lit ground back into the shadow (see NPR_PENUMBRA_MAX).
  float texels = clamp( wWorld * uShadowSoft.w * dls.shadowMapSize.x, 1.0, 8.5 );
  float radius = texels / dls.shadowMapSize.x;

  float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
  float s = 0.0;
  // two concentric Vogel rings (8 + 8 taps, hardware-PCF filtered = 64
  // effective) weighted 0.6 / 0.4, so the kernel is centre-heavy instead of
  // box-flat and the penumbra ramps smoothly rather than in visible steps.
  for ( int i = 0; i < 8; i ++ ) {
    s += texture( directionalShadowMap[ 0 ],
                  vec3( sc.xy + vogelDiskSample( i, 8, phi ) * radius * 0.52, sc.z ) ) * 0.075;
    s += texture( directionalShadowMap[ 0 ],
                  vec3( sc.xy + vogelDiskSample( i, 8, phi + 0.61 ) * radius, sc.z ) ) * 0.050;
  }
  return mix( 1.0, clamp( s, 0.0, 1.0 ), dls.shadowIntensity );
}
#else
float nprShadowMaskSoft(vec3 worldPos){ return getShadowMask(); }
#endif
#endif

/* --- how "lit" a point is: the FORM ramp times the SOFT cast-shadow factor.
       shadowMask: 1 = fully lit, 0 = fully occluded. The form shadow keeps its
       banded terminator (ART_BIBLE §2); the cast shadow contributes a smooth
       penumbra on top of it instead of snapping the band edge. */
float nprLit(vec3 N, vec3 L, float shadowMask){
  N = normalize(N);
  float ndl = dot(N, normalize(L));
  float sm  = nprShadowFade(ndl, shadowMask);
  float t   = nprRamp(clamp(ndl * 0.5 + 0.5, 0.0, 1.0)) * nprCast(sm);
  // same animated key breakup nprKeyG applies, so a module that only wants the
  // lit fraction still agrees with the rest of the scene frame to frame.
  float dapple = 1.0 - (1.0 - nprDappleMask())
               * mix(0.45, 1.0, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  return clamp(t * dapple * nprKeyGust(), 0.0, 1.12);
}

/* --- one key light, fully shaded (diffuse ramp + ambient + spec + rim).
       Ng is the GEOMETRIC normal — pass N again if you have nothing better. */
vec3 nprKeyG(vec3 albedo, vec3 N, vec3 Ng, vec3 V, vec3 L, vec3 kcol,
             float shadowMask, float translucency, float thickness,
             float specScale, float rimScale, float ao){
  L = normalize(L);
  float ndl  = dot(N, L);
  float gate = min(ndl, dot(Ng, L));
  float sm   = nprShadowFade(gate, shadowMask);
  // FORM shadow (the banded terminator) and CAST shadow (the soft penumbra) are
  // deliberately separate factors now. Folding the shadow mask into the
  // half-Lambert value, as this used to, made every cast shadow edge a hard
  // step and dropped cast shadows into the deepest core-shadow plateau — the
  // navy lozenge on the grass.
  float d    = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  float castT = nprCast(sm);
  float t    = nprRamp(d) * castT;

  // ---- animated breakup of the KEY only (never the ambient): canopy dapple
  // scrolling with the wind, plus a slow global gust so the whole key breathes.
  // Applied after the ramp so the terminator stays exactly where the ramp put
  // it — a dapple that moved the terminator would read as a wobbling edge.
  // Up-facing surfaces get the full pattern (this is light through a canopy
  // landing on the GROUND); near-vertical ones get less, so trunks and canopy
  // interiors do not turn blotchy.
  float dapple = 1.0 - (1.0 - nprDappleMask())
               * mix(0.45, 1.0, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  t = clamp(t * dapple * nprKeyGust(), 0.0, 1.12);

  float kl = clamp(nprLuma(kcol), 0.05, 1.15);
  vec3  shHue = nprShadowHue(albedo);
  // A deeper 4th plateau in the very core of the form shadow — the palette's
  // "deep interior" value. Banded, so it stays a flat plateau too.
  // ...and it is keyed off the FORM value d only, so a cast shadow lying on
  // otherwise sunlit ground never drops into it.
  float core = 1.0 - smoothstep(0.150, 0.190, d);
  vec3  shDiff = shHue * (nprShadowLevel(nprLuma(albedo)) * kl * mix(1.0, NPR_SHADOW_CORE, core))
               + nprShadowFloor(shHue) * (0.040 * kl);

  vec3 col = mix(shDiff, albedo * kcol, t);

  // Ambient. The albedo it multiplies is hue-shifted wherever the surface is
  // unlit, so the sky/bounce term reinforces the violet shadow instead of
  // dragging it back to the surface's own hue. Only partly, though: uSkyColor is
  // already strongly blue, and stacking a blue tint on a blue ambient overshoots
  // into an electric-blue shadow.
  vec3 ambA = mix(mix(albedo, shHue, 0.35), albedo, t);
  col += ambA * nprAmbient(N) * clamp(ao, 0.0, 1.0)
       * mix(NPR_AMBIENT_SHADOW, 1.0, max(t, clamp(sm, 0.0, 1.0) * 0.58));

  // one sharp CLIPPED specular core + a BANDED broad sheen. Neither is a PBR
  // roughness lobe, and the sheen is stepped so it does not smear a glossy
  // gradient down the length of a cylinder (that read as wet plastic).
  vec3  H   = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float sharp = smoothstep(0.32, 0.55, pow(ndh, 170.0));
  float sheen = smoothstep(0.50, 0.60, pow(ndh, 4.0)) * 0.085;
  col += kcol * (sharp * 0.45 + sheen) * t * specScale;

  // ---- Fresnel, computed once: drives both the rim and the "thin edge" that
  // light is able to bleed through.
  float rimRaw = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float fres   = pow(rimRaw, 3.2);                      // ART_BIBLE §2 exponent

  // Wrapped transmission — light bleeding THROUGH thin foliage. ART_BIBLE §2
  // says backlit petal edges glow pink (#FFE7EE), so the transmitted colour
  // keeps the key light's LEVEL but is pulled most of the way onto that pink:
  // multiplying by the raw key made the whole canopy go tomato-orange at dusk.
  vec3 tcol = mix(kcol * NPR_TRANSMIT_TINT,
                  vec3(kl) * NPR_TRANSMIT_TINT * 1.20, 0.58);
  float back = pow(clamp(dot(-L, V), 0.0, 1.0), 4.0);   // key directly behind
  float wrap = clamp(dot(N, -L) * 0.5 + 0.5, 0.0, 1.0); // normal turned away
  // The wrapped lobe is gated on Fresnel: you see through the THIN part of a
  // leaf/petal cluster, which from any camera is its grazing silhouette. Without
  // that gate a strong wrap lifts the whole shadow side into flat pink soup and
  // the form shadow disappears.
  float thin = mix(0.10, 1.0, fres);
  col += tcol * (back * 0.95 + wrap * wrap * 0.62 * thin)
       * translucency * thickness * mix(0.30, 1.0, sm);

  // ---- Rim, part 1: the KEY's hot silhouette line. Narrow band so it reads as
  // a drawn light edge rather than a wash over every grazing surface.
  float edge   = smoothstep(0.80, 0.965, rimRaw);
  float facing = clamp(dot(N, L) * 0.5 + 0.55, 0.16, 1.0);
  float bl     = clamp(-dot(L, V), 0.0, 1.0);           // key behind the subject
  col += kcol * edge * (0.55 + 0.90 * bl) * facing * (0.55 + 0.45 * sm) * 0.80 * rimScale;

  // ---- Rim, part 2: the PHASE-INDEPENDENT sky Fresnel. This is the term that
  // separates a silhouette from the sky when the key is nowhere near behind the
  // subject (i.e. most of the day) — it is the sky's own light grazing off the
  // edge, so it does not care where the sun is and is never gated on NdotL or
  // on the shadow mask. Tinted mix(sky, sun, 0.4): sky-coloured but carrying
  // enough of the key's warmth to stay inside one coherent light temperature.
  vec3 skyRim = mix(uSkyColor, kcol, 0.40);
  // damped on up-facing surfaces: a ground plane is grazing across half the
  // frame and would otherwise fog over with a free glow.
  float rimUp = mix(1.0, 0.45, clamp(N.y, 0.0, 1.0));
  col += skyRim * fres * rimUp * NPR_RIM_SKY * rimScale;

  return col;
}

/* --- full entry point, geometric-normal aware ------------------------ */
vec3 nprShadeN(vec3 albedo, vec3 N, vec3 Ng, vec3 V, float shadowMask,
               float translucency, float thickness,
               float specScale, float rimScale, float ao){
  N = normalize(N); Ng = normalize(Ng); V = normalize(V);
  float wN = clamp(uNightMix, 0.0, 1.0);

  vec3 day   = nprKeyG(albedo, N, Ng, V, normalize(uSunDir),  uSunColor,
                       shadowMask, translucency, thickness, specScale, rimScale, ao);
  vec3 night = nprKeyG(albedo, N, Ng, V, normalize(uMoonDir), uSunColor,
                       shadowMask, translucency, thickness, specScale, rimScale * 0.8, ao);
  return mix(day, night, wN);
}

/* --- the entry point every surface module calls ---------------------- */
vec3 nprShadeEx(vec3 albedo, vec3 N, vec3 V, float shadowMask,
                float translucency, float thickness,
                float specScale, float rimScale, float ao){
  return nprShadeN(albedo, N, N, V, shadowMask, translucency, thickness,
                   specScale, rimScale, ao);
}

vec3 nprShade(vec3 albedo, vec3 N, vec3 V, float shadowMask, float translucency, float thickness){
  return nprShadeEx(albedo, N, V, shadowMask, translucency, thickness, 1.0, 1.0, 1.0);
}
vec3 nprShade(vec3 albedo, vec3 N, vec3 V, float shadowMask){
  return nprShadeEx(albedo, N, V, shadowMask, 0.0, 0.0, 1.0, 1.0, 1.0);
}

/* --- aerial perspective: height + distance haze, hue-shifted to sky.
 *
 * Two things stop this being the milky white-out it used to be:
 *
 *  1. the density keyframes are roughly half what they were, so the near
 *     mid-ground stays the colour it was painted; and
 *  2. the haze target is MODULATED BY THE SURFACE'S OWN RELATIVE LUMINANCE
 *     (NPR_AERIAL_VALUE). A straight lerp toward one flat fog colour destroys
 *     value separation: three receding hill bands all converge on the same
 *     grey and the depth cue dies with them. Scaling the target by how bright
 *     the surface was keeps a dark ridge darker than a pale one at every
 *     distance, while still desaturating it and lifting it toward the sky.
 */
float nprAerialF(float viewDist, float worldY){
  float density = uFogParams.x, hf = uFogParams.y, start = uFogParams.z;
  float d = max(viewDist - start, 0.0);
  float h = exp(-max(worldY, 0.0) * hf);
  return clamp(1.0 - exp(-d * density * h), 0.0, 1.0);
}
vec3 nprAerialTint(float f){
  // at range the haze cools/blues toward the sky rather than staying one flat tint
  vec3 far = mix(uFogColor, uSkyColor * 1.25 + uFogColor * 0.20, 0.55);
  return mix(uFogColor, far, smoothstep(0.28, 1.0, f));
}
vec3 nprAerialMix(vec3 color, vec3 fogc, float f){
  float rel = clamp(nprLuma(color) / max(nprLuma(fogc), 1e-4), 0.0, 2.2);
  return mix(color, fogc * mix(1.0, rel, NPR_AERIAL_VALUE), f);
}

vec3 applyAerial(vec3 color, float viewDist, float worldY){
  float f = nprAerialF(viewDist, worldY);
  return nprAerialMix(color, nprAerialTint(f), f);
}

/* 4-arg variant adds forward-scatter: haze brightens toward the sun. */
vec3 applyAerial(vec3 color, float viewDist, float worldY, vec3 V){
  float f = nprAerialF(viewDist, worldY);
  vec3 fogc = nprAerialTint(f);
  float sc = pow(clamp(dot(-normalize(V), normalize(uSunDir)), 0.0, 1.0), 5.0);
  fogc += uSunColor * sc * 0.20 * (1.0 - uNightMix);
  return nprAerialMix(color, fogc, f);
}

/* Handy for modules that need the key direction/colour without full shading. */
vec3  nprKeyDir(){ return normalize(mix(uSunDir, uMoonDir, step(0.5, uNightMix))); }
vec3  nprKeyColor(){ return uSunColor; }
#endif
`;

/* ===================================================================== *
 * 3. Palette — ART_BIBLE §3 rows, keyframed round the clock
 * ===================================================================== */

/** Seconds for one full dawn -> day -> dusk -> night cycle. */
export const DAY_LENGTH = 480;

/** dayT of each named phase's "signature" moment (used by debug scenarios). */
export const PHASE_ANCHORS = { dawn: 0.135, day: 0.42, dusk: 0.735, night: 0.955 };

/** The mood target: late-afternoon golden hour. */
export const DEFAULT_DAY_T = 0.665;

const PHASE_BOUNDS = [
  ['dawn', 0.085, 0.200],
  ['day', 0.200, 0.625],
  ['dusk', 0.625, 0.815],
];

/** phase name + 0..1 progress inside it, for the `time:phase` event. */
export function phaseOf(dayT) {
  const t = ((dayT % 1) + 1) % 1;
  for (const [name, a, b] of PHASE_BOUNDS) {
    if (t >= a && t < b) return { phase: name, t: (t - a) / (b - a) };
  }
  // night wraps the end of the day into the start of the next
  const span = 1 - 0.815 + 0.085;
  const p = t >= 0.815 ? (t - 0.815) / span : (t + (1 - 0.815)) / span;
  return { phase: 'night', t: p };
}

/*
 * Keyframes. Colours authored in sRGB hex exactly as ART_BIBLE §3 specifies for
 * the day / dusk / night columns; the dawn and transition rows are derived from
 * the same family so the whole cycle reads as one film.
 *
 *  elev/azim  degrees. azim is monotonically increasing so the sun never
 *             back-tracks; dir = (cos(elev)cos(azim), sin(elev), cos(elev)sin(azim)).
 *             azim 166 @ golden hour puts the key ~110 deg off the hero camera:
 *             lit left edge, hue-shifted right side, long shadow to frame-right.
 *
 *             ELEVATION CEILING 38 deg. The day rows used to peak at 66 deg,
 *             which is a near-top-lit key: the tree's shadow collapsed inside
 *             its own ground footprint (nothing to compose with), the canopy's
 *             lit top and shaded underside came within 5% of each other, and
 *             the trunk had no readable terminator. Ground shadow length is
 *             height/tan(elev), so 26 deg at the golden-hour anchor throws
 *             ~2.05x the tree's height and 34 deg at the `day` anchor ~1.5x —
 *             both long enough to cross open grass and read as a cast shadow.
 */
const KEYS = [
  { t: 0.000, sun: 0x9FB6E8, sunInt: 0.82, sky: 0x33456F, skyInt: 0.62, ground: 0x1E2438, groundInt: 0.62,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0075, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.55,
    elev: -52, azim: -60, night: 1.00, exp: 1.20, env: 0.35 },
  { t: 0.070, sun: 0xB6A6C8, sunInt: 0.98, sky: 0x424D78, skyInt: 0.62, ground: 0x262436, groundInt: 0.62,
    shadow: 0x2A3358, fog: 0x2E3352, fogD: 0.0072, zenith: 0x152040, horizon: 0x53516E,
    fill: 0x5A6690, fillInt: 0.25, rim: 0xC0B6DE, rimInt: 0.55, hemi: 0.60,
    elev: -22, azim: -15, night: 0.82, exp: 1.16, env: 0.42 },
  { t: 0.135, sun: 0xFFDCC2, sunInt: 1.90, sky: 0x6E7FB8, skyInt: 0.80, ground: 0x3E3440, groundInt: 0.60,
    shadow: 0x5E6A9E, fog: 0xD9C3D2, fogD: 0.0058, zenith: 0x3E6BB0, horizon: 0xF3C4D0,
    fill: 0x8FA6D8, fillInt: 0.42, rim: 0xFFD2B4, rimInt: 0.85, hemi: 0.85,
    elev: 8, azim: 25, night: 0.10, exp: 1.06, env: 0.85 },
  { t: 0.240, sun: 0xFFF0DC, sunInt: 3.00, sky: 0x7EA0D8, skyInt: 0.95, ground: 0x4E5240, groundInt: 0.70,
    shadow: 0x6E76A8, fog: 0xBCD3EA, fogD: 0.0038, zenith: 0x4E86D4, horizon: 0xCFE0F2,
    fill: 0x9FBCE8, fillInt: 0.50, rim: 0xFFF0D8, rimInt: 0.60, hemi: 1.00,
    elev: 34, azim: 70, night: 0.00, exp: 1.00, env: 1.00 },
  { t: 0.500, sun: 0xFFF8EE, sunInt: 3.30, sky: 0x8FB0E2, skyInt: 1.00, ground: 0x585C46, groundInt: 0.75,
    shadow: 0x7A82AE, fog: 0xC6DAEE, fogD: 0.0030, zenith: 0x4E86D4, horizon: 0xD8E6F5,
    fill: 0xA8C4EE, fillInt: 0.50, rim: 0xFFF6E8, rimInt: 0.50, hemi: 1.05,
    elev: 58, azim: 115, night: 0.00, exp: 0.98, env: 1.05 },
  { t: 0.665, sun: 0xFFE6CE, sunInt: 2.95, sky: 0x7C96CE, skyInt: 0.82, ground: 0x5A4A3C, groundInt: 0.75,
    shadow: 0x6470A8, fog: 0xDCBFA6, fogD: 0.0048, zenith: 0x4574B8, horizon: 0xF2CBA0,
    fill: 0x92A8DE, fillInt: 0.42, rim: 0xFFD9A8, rimInt: 1.00, hemi: 0.92,
    elev: 46, azim: 152, night: 0.00, exp: 1.02, env: 0.95 },
  { t: 0.765, sun: 0xFFB683, sunInt: 2.05, sky: 0x64709E, skyInt: 0.70, ground: 0x54382E, groundInt: 0.70,
    shadow: 0x5A4A78, fog: 0xE8A57E, fogD: 0.0062, zenith: 0x3A4E86, horizon: 0xF5A86E,
    fill: 0x7A88C0, fillInt: 0.38, rim: 0xFFB070, rimInt: 1.05, hemi: 0.85,
    elev: 8.0, azim: 182, night: 0.16, exp: 1.06, env: 0.80 },
  { t: 0.840, sun: 0xD5A3B4, sunInt: 1.00, sky: 0x424E80, skyInt: 0.55, ground: 0x2E2836, groundInt: 0.60,
    shadow: 0x35375E, fog: 0x6B5A78, fogD: 0.0070, zenith: 0x22305C, horizon: 0x8A6A82,
    fill: 0x5E6A98, fillInt: 0.30, rim: 0xD8A0C0, rimInt: 0.70, hemi: 0.70,
    elev: -14, azim: 205, night: 0.62, exp: 1.12, env: 0.55 },
  { t: 0.920, sun: 0x9FB6E8, sunInt: 0.82, sky: 0x33456F, skyInt: 0.62, ground: 0x1E2438, groundInt: 0.62,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0075, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.55,
    elev: -46, azim: 250, night: 1.00, exp: 1.20, env: 0.35 },
  { t: 1.000, sun: 0x9FB6E8, sunInt: 0.82, sky: 0x33456F, skyInt: 0.62, ground: 0x1E2438, groundInt: 0.62,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0075, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.55,
    elev: -52, azim: 300, night: 1.00, exp: 1.20, env: 0.35 },
];

const COLOUR_FIELDS = ['sun', 'sky', 'ground', 'shadow', 'fog', 'zenith', 'horizon', 'fill', 'rim'];
const SCALAR_FIELDS = ['sunInt', 'skyInt', 'groundInt', 'fogD', 'fillInt', 'rimInt', 'hemi',
  'elev', 'azim', 'night', 'exp', 'env'];

// Pre-resolve every hex to a linear-working-space Color once, at module load.
const KEY_COLOURS = KEYS.map((k) => {
  const o = {};
  for (const f of COLOUR_FIELDS) o[f] = new THREE.Color().setHex(k[f], THREE.SRGBColorSpace);
  return o;
});

const smooth = (x) => x * x * (3 - 2 * x);

/**
 * nprShade multiplies albedo by uSunColor directly (no 1/PI Lambert divide, by
 * design — this is a stylised model). THREE.DirectionalLight.intensity keeps the
 * physical value for any MeshStandardMaterial in the scene; uSunColor gets this
 * scale so an authored ART_BIBLE hex reads back roughly as authored under full
 * light rather than clipping to white.
 */
export const NPR_KEY_SCALE = 0.38;

/** Height/distance fog shaping constants (uFogParams.y/.z). */
export const FOG_HEIGHT_FALLOFF = 0.055;
export const FOG_START_DISTANCE = 40.0;

/**
 * Global scale on every keyframe's fog density. The authored `fogD` values are
 * the "full atmosphere" art direction; at 1.0 they whited-out the whole
 * mid-ground (ART_BIBLE §8.9, washed-out midtones) because the fog colour is
 * far brighter than the sunlit grass it was mixing into. Halving the density and
 * letting nprAerialMix() preserve relative value gives an atmosphere that is
 * clearly present at range and invisible at 30 m, which is what §5 asks for.
 */
export const AERIAL_STRENGTH = 0.55;

/**
 * The colour light actually takes on bouncing off a sunlit grass garden
 * (#5C6A4A). The palette's `ground` row is the *ground plane's own* dark value,
 * which is the wrong thing to feed the upward-facing bounce term: it made the
 * bounce read as brown sludge instead of green light. Blended in by daylight.
 */
export const GROUND_BOUNCE = new THREE.Color().setHex(0x5C6A4A, THREE.SRGBColorSpace);
const _bounce = new THREE.Color();

/**
 * Sample the palette at dayT (0..1, 0 = midnight). Returns a reusable object —
 * pass `out` to avoid allocation in the update loop.
 */
export function samplePalette(dayT, out) {
  const t = ((dayT % 1) + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 2 && t >= KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = smooth(THREE.MathUtils.clamp((t - a.t) / Math.max(b.t - a.t, 1e-6), 0, 1));
  const ca = KEY_COLOURS[i], cb = KEY_COLOURS[i + 1];

  const p = out ?? {
    sun: new THREE.Color(), sky: new THREE.Color(), ground: new THREE.Color(),
    shadow: new THREE.Color(), fog: new THREE.Color(), zenith: new THREE.Color(),
    horizon: new THREE.Color(), fill: new THREE.Color(), rim: new THREE.Color(),
    sunDir: new THREE.Vector3(), moonDir: new THREE.Vector3(),
  };
  for (const k of COLOUR_FIELDS) p[k].copy(ca[k]).lerp(cb[k], f);
  for (const k of SCALAR_FIELDS) p[k] = a[k] + (b[k] - a[k]) * f;

  const el = THREE.MathUtils.degToRad(p.elev);
  const az = THREE.MathUtils.degToRad(p.azim);
  const ce = Math.cos(el);
  p.sunDir.set(ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)).normalize();
  p.moonDir.copy(p.sunDir).negate();      // the moon is the sun's antipode
  // The active key is whichever body is above the horizon. Cast shadows fade
  // out as it grazes the horizon, which also hides the sun -> moon handover.
  p.keyAboveHorizon = p.elev >= 0;
  p.keyElev = Math.abs(p.elev);
  p.shadowIntensity = THREE.MathUtils.clamp(smooth(THREE.MathUtils.clamp((p.keyElev + 0.2) / 4.7, 0, 1)), 0, 1);
  const ph = phaseOf(t);
  p.phase = ph.phase; p.phaseT = ph.t; p.dayT = t;
  return p;
}

/** The shared uniform bag. Objects here are shared BY REFERENCE — mutate .value only. */
export function createLightUniforms() {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyColor: { value: new THREE.Color(0.3, 0.4, 0.6) },
    uGroundColor: { value: new THREE.Color(0.1, 0.1, 0.08) },
    uShadowTint: { value: new THREE.Color(0.16, 0.18, 0.34) },
    uFogColor: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uFogParams: { value: new THREE.Vector3(0.012, FOG_HEIGHT_FALLOFF, FOG_START_DISTANCE) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uNightMix: { value: 0 },
    uPhaseT: { value: 0 },
    uExposure: { value: 1 },
    uDapple: { value: new THREE.Vector4(0, 0, 0, 1) },
    // (caster centre xyz, shadow-map UV per world unit) — see nprShadowMaskSoft
    uShadowSoft: { value: new THREE.Vector4(0, 6, 0, 1 / 24) },
  };
}

/**
 * World metres -> dapple-noise units. Kept in lockstep with NPR_DAPPLE_FREQ in
 * the GLSL above; 08-lighting.js multiplies its metres-per-second scroll by this
 * before writing uDapple.xy.
 */
export const DAPPLE_FREQ = 0.42;

/**
 * Write a sampled palette row into the shared bag. NEVER reassigns a .value
 * object — every consumer holds the same Vector3/Color instances.
 */
export function writePhaseColors(u, p) {
  u.uSunDir.value.copy(p.sunDir);
  u.uMoonDir.value.copy(p.moonDir);
  u.uSunColor.value.copy(p.sun).multiplyScalar(p.sunInt * NPR_KEY_SCALE);
  u.uSkyColor.value.copy(p.sky).multiplyScalar(p.skyInt * 0.52);
  // bounce ambient: hue-shifted toward real sunlit-grass bounce, level preserved
  u.uGroundColor.value.copy(p.ground).multiplyScalar(p.groundInt * 0.45);
  {
    const g = u.uGroundColor.value;
    const gl = Math.max(g.r * 0.2126 + g.g * 0.7152 + g.b * 0.0722, 1e-5);
    const bl = GROUND_BOUNCE.r * 0.2126 + GROUND_BOUNCE.g * 0.7152 + GROUND_BOUNCE.b * 0.0722;
    _bounce.copy(GROUND_BOUNCE).multiplyScalar(gl / bl);
    g.lerp(_bounce, 0.62 * (1 - p.night));
  }
  u.uShadowTint.value.copy(p.shadow);
  u.uFogColor.value.copy(p.fog);
  u.uFogParams.value.set(p.fogD * AERIAL_STRENGTH, FOG_HEIGHT_FALLOFF, FOG_START_DISTANCE);
  u.uNightMix.value = p.night;
  u.uPhaseT.value = p.phaseT;
  u.uExposure.value = p.exp;
  return u;
}

/* ===================================================================== *
 * 4. A ready-made NPR material
 * ===================================================================== */

const NPR_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vNprUv;
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  varying vec3 vNprColor;
#endif
uniform float uNormalBlend;
uniform vec3  uNormalOrigin;

#include <common>
#include <shadowmap_pars_vertex>

void main(){
  vNprUv = uv;
  vec3 transformed = position;
  vec3 objNormal = normal;

  #ifdef USE_INSTANCING
    transformed = ( instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
    objNormal   = mat3( instanceMatrix ) * objNormal;
  #endif

  vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
  vWorldPos = worldPosition.xyz;

  vec3 wn = normalize( mat3( modelMatrix ) * objNormal );
  if ( uNormalBlend > 0.0 ) {
    vec3 sph = normalize( vWorldPos - uNormalOrigin );
    wn = normalize( mix( wn, sph, uNormalBlend ) );
  }
  vWorldNormal = wn;
  vec3 shadowWorldNormal = wn;

  #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    vNprColor = vec3( 1.0 );
    #ifdef USE_COLOR
      vNprColor *= color;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vNprColor *= instanceColor;
    #endif
  #endif

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

const NPR_FRAG = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vNprUv;
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  varying vec3 vNprColor;
#endif

uniform vec3  uColor;
uniform vec2  uUvScale;
uniform float uTranslucency;
uniform float uThickness;
uniform float uSpecScale;
uniform float uRimScale;
uniform float uOpacity;
#ifdef NPR_USE_MAP
  uniform sampler2D uMap;
#endif

#include <common>
#include <packing>
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

${GLSL_NPR}

void main(){
  vec3 albedo = uColor;
  float alpha = uOpacity;

  #ifdef NPR_USE_MAP
    vec4 tx = texture2D( uMap, vNprUv * uUvScale );
    albedo *= tx.rgb;
    alpha  *= tx.a;
  #endif
  #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    albedo *= vNprColor;
  #endif
  #ifdef NPR_ALPHATEST
    if ( alpha < NPR_ALPHATEST ) discard;
  #endif

  vec3 N = normalize( vWorldNormal );
  #ifdef NPR_DOUBLE_SIDED
    N = gl_FrontFacing ? N : -N;
  #endif
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );

  #ifdef NPR_SOFT_SHADOW
    float sm = nprShadowMaskSoft( vWorldPos );
  #else
    float sm = getShadowMask();
  #endif
  nprSetWorldPos( vWorldPos );            // opt in to the spatial canopy dapple
  vec3 Ng = nprGeoNormal( vWorldPos, N );
  vec3 col = nprShadeN( albedo, N, Ng, V, sm, uTranslucency, uThickness, uSpecScale, uRimScale, 1.0 );
  col = applyAerial( col, dist, vWorldPos.y, V );

  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Turn the tuning knobs into #define strings (only when overridden). */
function nprTuningDefines({ shadowHue = null, shadowLevel = null, shadowChroma = null,
  ambientShadow = null, shadowHueMax = null, aerialValue = null } = {}) {
  const d = {};
  if (shadowHue != null) d.NPR_SHADOW_HUE = Number(shadowHue).toFixed(4);
  if (shadowHueMax != null) d.NPR_SHADOW_HUE_MAX = Number(shadowHueMax).toFixed(3);
  if (shadowLevel != null) d.NPR_SHADOW_LEVEL = Number(shadowLevel).toFixed(4);
  if (shadowChroma != null) d.NPR_SHADOW_CHROMA = Number(shadowChroma).toFixed(4);
  if (ambientShadow != null) d.NPR_AMBIENT_SHADOW = Number(ambientShadow).toFixed(4);
  if (aerialValue != null) d.NPR_AERIAL_VALUE = Number(aerialValue).toFixed(4);
  return d;
}

/**
 * Retro-fit the house NPR model onto a stock MeshStandardMaterial /
 * MeshPhysicalMaterial via onBeforeCompile, so a module that never wrote a line
 * of GLSL still obeys ART_BIBLE §2. `diffuseColor.rgb` (colour * map * vertex
 * colour) becomes the albedo; the PBR light accumulation is discarded wholesale.
 *
 * The shared lighting uniform OBJECTS are spread in by reference, so this
 * material tracks the time of day for free.
 *
 * Idempotent — marks the material with `__npr` and returns early on a re-visit.
 *
 * @param {THREE.Material} material
 * @param {object} o  { lightUniforms, translucency, thickness, specScale,
 *                      rimScale, shadowHue, shadowLevel, ambientShadow, aerial }
 */
export function applyNprToStandard(material, o = {}) {
  if (!material || material.__npr) return material;
  if (!(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return material;

  const {
    lightUniforms = null,
    translucency = 0,
    thickness = 0.5,
    specScale = 0.35,
    rimScale = 0.8,
    aerial = true,
  } = o;

  material.__npr = true;
  // applyAerial does the height + distance haze itself; letting three's fog run
  // as well would double-composite it.
  if (aerial) material.fog = false;

  const own = {
    uTranslucency: { value: translucency },
    uThickness: { value: thickness },
    uSpecScale: { value: specScale },
    uRimScale: { value: rimScale },
  };
  material.userData.nprUniforms = own;

  const tuning = nprTuningDefines(o);
  const tuneSrc = Object.entries(tuning).map(([k, v]) => `#define ${k} ${v}`).join('\n');

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);

    // shared-by-reference lighting bag + this material's own knobs
    if (lightUniforms) Object.assign(shader.uniforms, lightUniforms);
    Object.assign(shader.uniforms, own);

    // getShadowMask() lives in a chunk meshphysical does not pull in; the NPR
    // library and our uniform declarations have to land at global scope, which
    // is what shadowmap_pars_fragment guarantees.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <shadowmap_pars_fragment>',
      `#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform float uTranslucency;
uniform float uThickness;
uniform float uSpecScale;
uniform float uRimScale;
#define NPR_HAS_SHADOWMAP
${tuneSrc}
${GLSL_NPR}`,
    );

    // Everything three accumulated into reflectedLight is thrown away; the NPR
    // model owns outgoingLight outright. Patched at opaque_fragment because
    // that is the first point where outgoingLight exists.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
  vec3 nprVpos = -vViewPosition;                      // view-space position
  float nprDist = max( length( nprVpos ), 1e-4 );
  vec3 nprWdir = transformNormalByInverseViewMatrix( nprVpos / nprDist, viewMatrix );
  vec3 nprWpos = cameraPosition + nprWdir * nprDist;
  vec3 nprN  = transformNormalByInverseViewMatrix( normal, viewMatrix );
  vec3 nprNg = nprGeoNormal( nprWpos, nprN );
  vec3 nprV  = -nprWdir;
  nprSetWorldPos( nprWpos );                          // spatial canopy dapple
  #ifdef NPR_SOFT_SHADOW
    float nprSm = nprShadowMaskSoft( nprWpos );
  #else
    float nprSm = getShadowMask();
  #endif
  outgoingLight = nprShadeN( diffuseColor.rgb, nprN, nprNg, nprV, nprSm,
                             uTranslucency, uThickness, uSpecScale, uRimScale, 1.0 );
${aerial ? '  outgoingLight = applyAerial( outgoingLight, nprDist, nprWpos.y, nprV );' : ''}
}
#include <opaque_fragment>`,
    );
  };

  const key = `npr|${translucency}|${thickness}|${specScale}|${rimScale}|${JSON.stringify(tuning)}`;
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return (typeof prevKey === 'function' ? prevKey.call(this) : '') + key;
  };

  material.needsUpdate = true;
  return material;
}

/**
 * A ramp-shaded, shadow-receiving, instancing-aware material.
 * @param {object} o
 * @param {object} o.lightUniforms  ctx.assets.lightUniforms — REQUIRED for correct look
 */
export function createNprMaterial(o = {}) {
  const {
    lightUniforms = null,
    color = 0xffffff,
    map = null,
    uvScale = [1, 1],
    translucency = 0,
    thickness = 0.5,
    specScale = 1,
    rimScale = 1,
    opacity = 1,
    normalBlend = 0,
    normalOrigin = [0, 0, 0],
    side = THREE.FrontSide,
    transparent = false,
    depthWrite,
    alphaTest = 0,
    vertexColors = false,
    extraUniforms = {},
    defines = {},
    shadowHue = null,          // 0..1 — how much of the allowed hue rotation is taken
    shadowHueMax = null,       // DEGREES — hard cap on that rotation (default 30)
    shadowLevel = null,        // linear shadow level as a fraction of albedo*key
    shadowChroma = null,       // how far shadow saturation moves toward the tint's
    ambientShadow = null,      // ambient reaching an occluded point
    aerialValue = null,        // 0..1 — value separation kept under full aerial haze
  } = o;

  const u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
  Object.assign(u, {
    uColor: { value: new THREE.Color().setHex(color, THREE.SRGBColorSpace) },
    uUvScale: { value: new THREE.Vector2(uvScale[0], uvScale[1]) },
    uTranslucency: { value: translucency },
    uThickness: { value: thickness },
    uSpecScale: { value: specScale },
    uRimScale: { value: rimScale },
    uOpacity: { value: opacity },
    uNormalBlend: { value: normalBlend },
    uNormalOrigin: { value: new THREE.Vector3(...normalOrigin) },
  });
  if (map) u.uMap = { value: map };
  // Shared-by-reference lighting bag goes in LAST so nothing clones it.
  if (lightUniforms) Object.assign(u, lightUniforms);
  Object.assign(u, extraUniforms);

  const d = {
    NPR_HAS_SHADOWMAP: '',          // NPR_FRAG includes three's shadow chunks
    ...defines,
    ...nprTuningDefines({ shadowHue, shadowHueMax, shadowLevel, shadowChroma, ambientShadow, aerialValue }),
  };
  if (map) d.NPR_USE_MAP = '';
  if (alphaTest > 0) d.NPR_ALPHATEST = alphaTest.toFixed(4);
  if (side === THREE.DoubleSide) d.NPR_DOUBLE_SIDED = '';

  const m = new THREE.ShaderMaterial({
    uniforms: u,
    defines: d,
    vertexShader: NPR_VERT,
    fragmentShader: NPR_FRAG,
    lights: true,
    side,
    transparent,
    vertexColors,
    depthWrite: depthWrite ?? !transparent,
  });
  m.userData.isNpr = true;
  return m;
}

/* ===================================================================== *
 * 5. Procedural gradient sky (IBL source + fallback dome)
 * ===================================================================== */

const SKY_VERT = /* glsl */`
varying vec3 vSkyDir;
void main(){
  vSkyDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */`
varying vec3 vSkyDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundHaze;
uniform float uStars;
${GLSL_NOISE}
${GLSL_LIGHT_UNIFORMS}
void main(){
  vec3 dir = normalize( vSkyDir );
  float h = dir.y;

  float au = smoothstep( 0.0, 0.62, h );
  vec3 upper = mix( uHorizon, uZenith, pow( au, 0.78 ) );
  vec3 lower = mix( uHorizon, uGroundHaze, smoothstep( 0.0, -0.30, h ) );
  vec3 col = mix( lower, upper, step( 0.0, h ) );

  // gentle horizon banding break so the gradient never posterises
  col *= 1.0 + 0.020 * snoise( dir * 2.6 );

  vec3 S = normalize( uSunDir );
  float sd = max( dot( dir, S ), 0.0 );
  col += uSunColor * pow( sd, 260.0 ) * 1.30;                       // disc
  col += uSunColor * pow( sd, 7.0 ) * 0.15 * ( 1.0 - uNightMix );    // halo
  col += uSunColor * pow( sd, 1.6 ) * 0.05;                          // wide bloom

  if ( uStars > 0.001 ) {
    float sp = pow( clamp( snoise( dir * 190.0 ), 0.0, 1.0 ), 22.0 );
    col += vec3( 0.85, 0.90, 1.0 ) * sp * 2.6 * uStars * smoothstep( 0.02, 0.30, h );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The sky gradient uniforms, shared between the IBL sphere and the dome. */
export function createSkyUniforms() {
  return {
    uZenith: { value: new THREE.Color(0.1, 0.2, 0.5) },
    uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
    uGroundHaze: { value: new THREE.Color(0.2, 0.2, 0.2) },
    uStars: { value: 0 },
  };
}

export function createSkyMaterial(lightUniforms, skyUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...skyUniforms, ...lightUniforms },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
}
