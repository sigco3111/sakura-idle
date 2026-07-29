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
// ---- Local warm lamps (stone lanterns, festival lights, click VFX).
// The NPR model throws three's own light accumulation away, so a THREE.PointLight
// is INVISIBLE to every surface in this project unless it comes through here.
// 08-lighting.js adopts up to NPR_MAX_LAMPS PointLights from the scene graph
// automatically each sweep, so a props module only has to add a PointLight and
// its lantern will light the ground, the bark and the water for free.
//   uLampPos[i].xyz  world position
//   uLampPos[i].w    range in metres; <= 0 means "slot unused"
//   uLampColor[i]    linear colour * intensity
// 4, MEASURED: the hero preset costs 12.3 ms/frame at 4 slots and 14.1 ms at 6,
// and the 16.6 ms budget still has water reflections and click VFX to absorb. The
// loop body runs per fragment on every NPR surface, so slots are not free. If a
// module genuinely needs more than four simultaneous lamps, raising this define
// and MAX_LAMPS below is the only change required — ask the lighting owner.
#ifndef NPR_MAX_LAMPS
  #define NPR_MAX_LAMPS 4
#endif
uniform vec4  uLampPos[NPR_MAX_LAMPS];
uniform vec3  uLampColor[NPR_MAX_LAMPS];
// ---- Canopy shade pool (ART_BIBLE §2: "a weak ambient-occlusion-driven
// darkening in canopy interiors and under props").
//   .xyz  world centre of the pool, ON THE GROUND
//   .w    radius in metres; <= 0 disables the term
// 08-lighting.js derives this from the tree's own bounding sphere and biases it
// a short way along the shadow direction. See nprCanopyShade().
uniform vec4  uCanopyOcc;
// ---- Global shading calibration, written by 08-lighting.js every frame.
// These are the four numbers that were previously baked in as #defines and
// therefore could only be calibrated by recompiling and re-shooting. As
// uniforms they can be swept live (see the cal-* debug scenarios) AND varied
// per phase, which is what the dusk fix needs.
//   .x  global scale on the open-shadow luminance ratio (1 = the shipped
//       ART_BIBLE 0.55 calibration; a material's own NPR_SHADOW_LEVEL still
//       scales on top of it)
//   .y  global scale on the deep-interior plateau depth (NPR_SHADOW_CORE)
//   .z  gain on the KEY rim / backlight term (ART_BIBLE 2, 3)
//   .w  how far the key's DIFFUSE MULTIPLY is neutralised at maximum key
//       chroma. 0 = physical (a #FF9E5E dusk sun multiplies every albedo in
//       frame to the same orange); ~0.45 = stylised, grass stays green and
//       vermilion stays red under a sunset key. Fades in with the key's own
//       chroma so full daylight is untouched.
uniform vec4  uShadowCal;
// ---- Aerial-perspective calibration, written by 08-lighting.js every frame.
// EVERY COMPONENT USES THE "0 MEANS DEFAULT" GUARD, so a shader that somehow
// receives this uniform unset (all zeros) renders the shipped look rather than a
// black fog. See nprAerialLevel() / nprAerialKeepMid() / … below.
//   .x  LEVEL of the haze target as a fraction of uFogColor. ART_BIBLE §8.3 wants
//       aerial perspective; §8.9 forbids the milky band it turns into when a LAND
//       plane converges on something BRIGHTER than the sky above it. uFogColor is
//       authored as the air's own colour seen against the zenith, so a receding
//       ground plane has to land under it. (15-sky.js applies exactly the same
//       correction to its hill bands, at 0.88.)
//   .y  fraction of a surface's own relative luminance kept at MID depth
//   .z  ...and at MAXIMUM depth. Non-zero on purpose: at f -> 1 a plane that keeps
//       none of its own value converges on ONE flat colour and every receding
//       band melts into it (§8.3 + §5's depth separation, both lost at once).
//   .w  exponent on the optical depth (NPR_AERIAL_POW)
uniform vec4  uAerial;
// ---- Occlusion calibration, written by 08-lighting.js every frame. Same
// "0 means default" guard as uAerial.
//   .x  exponent on the ambient's occlusion term (sky visibility inside a pocket)
//   .y  scale on NPR_SHADOW_AO — how much of the fake key fill survives at ao = 0
//   .z  fraction of the SKY ambient the canopy's shade pool takes at its core
//   .w  ...and of the KEY
uniform vec4  uShadeCal;
#endif
`;

/** Keep in lockstep with NPR_MAX_LAMPS in the GLSL above. */
export const MAX_LAMPS = 4;

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
#ifndef NPR_SHADOW_TINT
  // Strength of the shadow's chromatic operation: a LINEAR MULTIPLY of the
  // albedo by uShadowTint renormalised to unit luminance (see nprShadowHue).
  // 1 = the full ART_BIBLE §2 operation ("multiply shadowed albedo toward cool
  // violet-blue #6E76A8"), 0 = a plain darken, which §8.4 calls an instant fail.
  //
  // MEASURED, and this is the fix for the round-2 blocker. The previous model
  // rotated hue in HSV with a 30 deg cap and a further reduction the further the
  // albedo already was from the tint, which meant a warm surface was allowed to
  // move about 13 deg — and it took the SHORT arc, i.e. through red. Every
  // measured pair therefore moved AWAY from 232 deg and GAINED saturation (lit
  // path 31.2 -> shadow 43.7, lit bark 7.8 -> 28.1). A linear multiply is what
  // the bible actually specifies, it is what a real cool skylight does, and it
  // lands bark at 231 deg / dirt at ~207 deg with B >= R and LESS saturation
  // than the lit side, all without repainting green grass navy (grass lands
  // ~144 deg, i.e. it cools toward the tint without losing its identity).
  #define NPR_SHADOW_TINT 1.0
#endif
#ifndef NPR_SHADOW_TINT_NEUTRAL
  // How much of the multiply a NEAR-NEUTRAL albedo takes. MEASURED, and it is the
  // difference between "cool shade" and "navy paint": a saturated albedo fights
  // the multiply and merely cools (bark 20 deg -> 235 deg, grass 100 deg ->
  // 141 deg, both keeping their identity), but a neutral one has no hue to defend,
  // so the same multiply lands its shadow ON uShadowTint's hue at uShadowTint's
  // full linear chroma. At full strength the stone wall and the stone lanterns
  // printed as flat blue slabs (display saturation 0.35) — §8.4's "shadows that
  // are only a repaint". At 0.45 the same stone lands hue 238 deg at display
  // saturation 0.10: unmistakably cool, unmistakably still stone.
  #define NPR_SHADOW_TINT_NEUTRAL 0.45
#endif
#ifndef NPR_SHADOW_HUE
  // LEGACY damper, honoured as a mild trim only — see nprTintStrength(). Several
  // surface modules set this (and NPR_SHADOW_CHROMA) to small values against the
  // OLD hue-rotation semantics, where small meant "keep my own hue". Under the
  // multiply model those same numbers would opt a material out of the cool shift
  // entirely, which is the exact §8.4 defect this round exists to fix, so the
  // effective strength is floored: a material that asks for less violet gets
  // 0.78x of it, never 0.16x.
  #define NPR_SHADOW_HUE 0.95
#endif
#ifndef NPR_SHADOW_LEVEL
  // Linear HDR level of the shadow diffuse as a fraction of albedo*key, before
  // the albedo-luminance compensation in nprShadowLevel(). Calibrated against
  // the 0.50-grey ball measured in the COMPOSITED, GRADED png: ART_BIBLE §2
  // wants the shadow side at ~0.55 of the lit side's luminance.
  //
  // This is a FAKE FILL — a flat fraction of the key handed back to a surface
  // the key cannot reach. CALIBRATED, not guessed: the 'calib' scenario's
  // 0.50-grey ball, sampled in the final graded png, must sit at 0.50..0.60 of
  // its own lit side. The grade's S-curve (pivot 0.34, slope 1.38) makes the
  // DISPLAY ratio roughly (scene ratio)^1.19, so a display 0.55 needs a scene
  // ratio of 0.60 — which is why this number is much larger than it looks like
  // it should be. Measured: 0.55 -> display ratio 0.345 (too dark), 0.82 ->
  // 0.5x. It is not a brightness dial for the whole frame, because the fill is
  // occluded (NPR_SHADOW_AO) and plateau-deepened (NPR_SHADOW_CORE). It is deliberately back at its old value: cutting it
  // is NOT how the frame gets a low end (0.30 dropped open shadowed grass to
  // display 0.09, i.e. onto the grade's blue floor — the navy-paint failure).
  // The low end comes from NPR_SHADOW_AO below, which is the occlusion this
  // term used to ignore completely.
  //
  // r3: unchanged as the UNIT, but the albedo compensation curve underneath it in
  // nprShadowLevel() has been pulled in hard (see there) and the global scale now
  // lives in uShadowCal.x so it can be swept without a recompile.
  #define NPR_SHADOW_LEVEL 0.55
#endif
#ifndef NPR_SHADOW_AO
  // How much of the fake fill survives at zero ambient occlusion.
  //
  // THIS is the frame's dark anchor. The fill above used to be applied flat, so
  // a fully enclosed pocket — the far side of the trunk under the canopy, the
  // interior of a blossom cluster, the underside of a branch — was handed
  // exactly as much "shadow light" as open grass in the tree's ground shadow.
  // Nothing in frame could ever be dark, whatever the shadow level was set to
  // (hero lum p1 0.238 with nothing crushed). Scaling the fill by the surface's
  // own occlusion separates the two cases: an open shadow keeps its ART_BIBLE
  // 0.55 ratio, an enclosed one falls to a fifth of it and becomes the black
  // the histogram was missing.
  #define NPR_SHADOW_AO 0.16
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
  // Sky reaching a point in a FORM shadow. A surface turned away from the key
  // is usually also turned into the scene, so it sees materially less sky than
  // an open, up-facing one — that is what makes a turned surface read as solid
  // rather than as flatly-repainted albedo. Kept mild: a normal turned away
  // from the SUN is not the same fact as a normal that cannot see the SKY, and
  // over-driving this is what dropped every away-facing grass blade out of the
  // image (ART_BIBLE §3's grass rule, inverted). Real occlusion belongs in ao.
  #define NPR_AMBIENT_SHADOW 0.72
#endif
#ifndef NPR_AMBIENT_CAST
  // Sky reaching a point in a CAST shadow, which is a completely different
  // situation and used to share the number above. A patch of grass inside the
  // tree's ground shadow has lost the SUN and almost nothing else: it still
  // sees essentially the whole sky dome. Killing its ambient too is what forced
  // the fake NPR_SHADOW_LEVEL fill to be so large, which is what flattened the
  // frame. Keep the ambient, drop the key: that is what a cast shadow IS.
  //
  // 0.90 -> 0.74 (r3). "Almost nothing else" was too generous by exactly the
  // amount that made the tree not read as grounded: with the ambient at 0.90 AND
  // NPR_CAST_FILL at 1.34 the canopy's shadow on grass printed at 0.94 of the lit
  // grass beside it (measured), i.e. the tree cast no shadow at all. A patch of
  // ground under a canopy has in fact lost most of the sky as well — that is what
  // uCanopyOcc models for the tree specifically, and 0.74 is the generic case.
  #define NPR_AMBIENT_CAST 0.74
#endif
#ifndef NPR_CAST_FILL
  // Extra fill handed to an OPEN CAST shadow, and ONLY to a cast shadow (a form
  // shadow's castT is 1, so this term collapses to 1 there and the tree's own
  // banded terminator is untouched).
  //
  // MEASURED, and it is the number that makes ART_BIBLE §2's ratio true on the
  // GROUND rather than only on a calibration ball. The tree's ground shadow was
  // printing at 0.40 of comparable sunlit ground in the graded frame — below the
  // 0.50-0.60 window, i.e. reading as a dark decal rather than as shadowed grass,
  // and dragging the hero histogram's p1 down to 0.040. The fill needed 1.31x to
  // land mid-window; 1.34 here plus NPR_AMBIENT_CAST 0.86 -> 0.90 supplies it.
  //
  // 1.34 -> 1.00 (r3). That calibration overshot: the pair of numbers above put
  // the canopy's cast shadow at 0.94 of lit grass in the graded frame, against the
  // 0.55 target, so the tree floated. A cast shadow now takes the same open-shadow
  // ratio every other unlit surface takes; the ONLY thing that still separates it
  // from a form shadow is that it keeps more ambient (NPR_AMBIENT_CAST) and never
  // enters the deep-interior plateau.
  #define NPR_CAST_FILL 1.00
#endif
#ifndef NPR_SHADOW_CORE
  // Depth of the 4th "deep interior" plateau in the very core of a FORM shadow,
  // as a multiplier on the shadow level. Cast shadows never get it — that is
  // what turned the tree's ground shadow into an opaque lozenge.
  //
  // This plateau is the frame's DARK ANCHOR (ART_BIBLE §3 "deep interior"): the
  // far side of the trunk, branch undersides, canopy interiors. Everything else
  // in an open golden-hour garden is lit or sky, so if this band is shallow the
  // histogram has no bottom at all. 0.86 (14% darker than a plain shadow) was
  // no anchor whatsoever.
  //
  // 0.42 -> 0.62 (r3). 0.42 on top of an already-crushed fill is what printed the
  // 0.50-grey calibration ball's whole camera-facing hemisphere at rgb(13,24,62) /
  // L 0.098 against a lit 0.641 — a 0.15 ratio and the §8.4 "navy paint" tell,
  // measured on shots/light-r0-calib. The anchor is now carried by real occlusion
  // (NPR_SHADOW_AO x ao) and by uCanopyOcc, both of which are facts about the
  // geometry rather than about which way a surface happens to point.
  #define NPR_SHADOW_CORE 0.62
#endif
#ifndef NPR_SHADOW_CORE_OPEN
  // How much of the core plateau an UNOCCLUDED surface is allowed to take.
  //
  // MEASURED on the calib chart, and this is the fix for the near-black
  // back-facing surface. The core plateau above was gated on DIRECTION only, so
  // any surface merely turned away from the key — a sphere's front hemisphere
  // under this backlit sun arc, a blossom card facing the camera, the far flank
  // of a lantern — was treated as an enclosed interior pocket and handed
  // 0.42x on top of the shadow fill. The 0.50-grey calibration ball printed its
  // whole visible face at #060E36 / L 0.061 (raw scene ratio 0.29 of its own lit
  // band), i.e. the §8.4 tell, and the same mechanism is what makes away-facing
  // blossom cards read as dead maroon.
  //
  // "Deep interior" is an OCCLUSION fact, not an orientation fact: a canopy
  // interior or the underside of a branch has an ao well below 1 and still gets
  // the full plateau, which keeps the histogram's dark anchor. An open surface
  // that simply faces away takes a third of it. Measured: 1.0 -> ball front raw
  // ratio 0.29 / graded L 0.061; 0.34 -> 0.41 / 0.128.
  //
  // 0.34 -> 0.10 (r3). 0.34 was still enough to crush every open convex surface
  // whose normal turns away from this deliberately BACKLIT key, which under this
  // sun arc is most of the frame's foreground: re-measured on the calib chart, the
  // 0.50-grey ball's camera-facing hemisphere printed L 0.098 / lit 0.641 (ratio
  // 0.15) with saturation 0.64 — darker AND more saturated than the lit side, the
  // exact inverse of ART_BIBLE §2. An open surface facing away is a plain shadow
  // and takes the plain 0.55 ratio; only genuine occlusion gets the plateau.
  #define NPR_SHADOW_CORE_OPEN 0.10
#endif
#ifndef NPR_SHADOW_CORE_HI
  // Half-Lambert value at which the core plateau has fully faded out. The old
  // window (0.150..0.190) is 2.3 degrees wide at the very bottom of the
  // half-Lambert range, i.e. only a surface facing within 20 deg of DIRECTLY
  // away from the key ever saw it. Widening it to 0.335 (ndl -0.70 .. -0.33)
  // gives the far quarter of a trunk or a branch a real deep-interior value.
  #define NPR_SHADOW_CORE_HI 0.300
#endif
#ifndef NPR_SHADOW_FLOOR
  // Weight of the "never black" pedestal (nprShadowFloor) on the shadow diffuse.
  // It carries most of uShadowTint's own hue, so as the plateaus above get
  // deeper this term is what stops the deep core going neutral-black AND what
  // swings the darkest quartile of the frame cool (ART_BIBLE §2 / the
  // groundSplitTone metric).
  #define NPR_SHADOW_FLOOR 0.045
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
  // How much of a surface's own relative luminance survives aerial perspective
  // at MID range. 0 = every distant surface converges on one flat fog colour
  // (the milky white-out); 1 = no value compression at all. ART_BIBLE §5 needs
  // the receding hill bands to stay separable by value, which is what this buys.
  //
  // 0.45 -> 0.52 (r4). MEASURED on shots/light-r0/hero.png with the row scanner:
  // the terrain between 60 and 95 m printed L 0.39 -> 0.59 while the same grass at
  // 43 m printed 0.33, i.e. the near-mid field was climbing 0.26 of display value
  // for nothing but air and reading as a veil laid over the sward rather than as
  // grass (§8.9). Value preservation is the only term that pushes back on that
  // without also killing the far convergence, so it goes UP, not down.
  #define NPR_AERIAL_VALUE 0.52
#endif
#ifndef NPR_AERIAL_VALUE_FAR
  // ...and at MAXIMUM depth. This used to be a hard 0 (the fade below ran the
  // preservation out entirely by f = 0.96), which is what produced the r4 blocker:
  // every surface past ~150 m converged on EXACTLY uFogColor, so the far terrain
  // printed L 0.74-0.78 in the wide frame while the sky above the ridges printed
  // 0.60-0.64. A land plane brighter than the air in front of it is the milky
  // band, and no amount of density tuning can fix it because the convergence
  // TARGET was wrong, not the rate.
  //
  // Kept well below the mid value (air really does flatten value with depth) but
  // never zero, so the near ridge stays a readable step under the far one.
  #define NPR_AERIAL_VALUE_FAR 0.30
#endif
#ifndef NPR_AERIAL_LEVEL
  // LEVEL of the haze target as a fraction of uFogColor — see uAerial.x. 0.78,
  // MEASURED: uFogColor #BCD3EA is scene-linear luma 0.622 and prints at display
  // L 0.78 through the grade, but 15-sky.js's actual horizon gradient prints
  // 0.60-0.64 in the same frame. Converging a LAND plane on the authored fog
  // colour therefore lands it ~0.15 display ABOVE the sky it recedes into. The
  // hills use the same correction at 0.88; ours is stronger because our surfaces
  // are nearer and must stay the darkest plane of the three.
  #define NPR_AERIAL_LEVEL 0.72
#endif
#ifndef NPR_AERIAL_VALUE_FADE
  // (start, end) of the fog fraction over which the MID preservation is faded to
  // the FAR one. Kept wide and late so the playfield's own depth cues (the 40-100 m
  // band, which is most of the visible ground) sit entirely on the mid value.
  #define NPR_AERIAL_VALUE_FADE vec2(0.62, 0.95)
#endif
#ifndef NPR_AERIAL_POW
  // Exponent on the optical depth. A plain exp(-d*density) has to be dense
  // enough at 160 m to bury a distant ridge, and that same density then puts a
  // third of a veil over the garden at 60 m (ART_BIBLE §8.9, washed-out
  // midtones). Raising the optical depth to a power > 1 makes the curve
  // deliberately non-physical: nearly flat for the first stretch past
  // uFogParams.z, then saturating hard. Measured on the wide preset at the
  // shipped day density (0.0152): 60 m -> 14%, 80 m -> 37%, 100 m -> 58%,
  // 160 m -> 93%, 300 m -> 100%. One pow() per fragment.
  #define NPR_AERIAL_POW 1.6
#endif
#ifndef NPR_RIM_KEY
  // Amplitude of the KEY's rim / backlight line (ART_BIBLE §2, "rim light on every
  // silhouette", §3 axis 3). MEASURED, and the width is the part that mattered:
  // this term used to be gated by smoothstep(0.80, 0.965, 1-NdotV), a band 11 deg
  // wide about the silhouette. On a 0.35 m branch at 8 m that is HALF A PIXEL, so
  // a scanline crossing sky -> branch in the dusk canopy frame fell monotonically
  // 0.679 -> 0.123 with no overshoot anywhere and every branch read as a flat dark
  // cut-out. The gate is now the bible's own pow(1-NdotV, 3.2) with a soft shaping
  // step, which is a 2-4 px band at 1080p on the same geometry.
  #define NPR_RIM_KEY 0.60
#endif
#ifndef NPR_TRANS_SOFT
  // Soft-add strength for the wrapped transmission term. Transmission is what
  // makes a DARK backlit interior glow pink; a surface already at the top of the
  // range has nothing left to transmit into, and adding to it anyway is what
  // pushed the blossoms nearest the sun through white and let bloom smear them
  // (measured: that region clipped to rgb(255,255,255), zero saturation, i.e.
  // bloom substituting for transmission — the opposite of ART_BIBLE §2). Dividing
  // the added term by the surface's own level keeps the #FFE7EE chroma instead of
  // summing it out through the top of the gamut.
  #define NPR_TRANS_SOFT 2.6
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

/* --- live calibration accessors. Every one falls back to its compile-time
       default when the uniform is unset (or zero), so a shader that receives an
       all-zero uAerial/uShadeCal still renders the shipped look. That guard is
       not defensive decoration: these two uniforms were added after every
       surface module was written, and a module that builds its own uniform block
       without spreading the whole bag would otherwise get a black fog. */
float nprAerialLevel(){   return uAerial.x > 0.0 ? uAerial.x : NPR_AERIAL_LEVEL; }
float nprAerialKeepMid(){ return uAerial.y > 0.0 ? uAerial.y : NPR_AERIAL_VALUE; }
float nprAerialKeepFar(){ return uAerial.z > 0.0 ? uAerial.z : NPR_AERIAL_VALUE_FAR; }
float nprAerialPow(){     return uAerial.w > 0.0 ? uAerial.w : NPR_AERIAL_POW; }
// 1.35 -> 1.85 (r4). The frame's DARK ANCHOR. MEASURED on shots/light-r0/hero.png:
// the darkest pixel in the whole 1920x1080 frame was L 0.0786 and lum p1 was 0.164,
// i.e. the histogram had no bottom at all (ART_BIBLE §8.9). Every module already
// hands nprShadeN a real ao value (grass blade bases 0.46, bark crevices 0.65, canopy
// interiors 0.30), so the pockets that ought to carry the low end exist — the
// ambient was simply reading almost all of the sky inside them. 1.85 halves the
// ambient at ao 0.68 instead of quartering it at ao 0.35, and it touches nothing
// that is unoccluded (ao = 1 -> 1 at every exponent), so neither the terminator
// nor the rim can move.
float nprAmbOccPow(){     return uShadeCal.x > 0.0 ? uShadeCal.x : 1.85; }
float nprShadowAoLevel(){ return NPR_SHADOW_AO * (uShadeCal.y > 0.0 ? uShadeCal.y : 1.0); }

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

/* --- the canopy's shade pool -----------------------------------------
   A big tree does not darken the ground under it only by blocking the SUN. It
   blocks the SKY, which is most of the ambient light, and it blocks it over its
   whole footprint no matter where the sun is. ART_BIBLE §2 asks for exactly this
   ("a weak ambient-occlusion-driven darkening in canopy interiors and under
   props") and without it the ground under the tree is lit identically to open
   grass 20 m away — the tree floats.

   Why it is not the shadow map's job. The sun arc deliberately sits BEHIND the
   tree (the backlight is the signature look and the project owner settled it), so
   the geometric cast shadow runs toward the camera and leaves the frame within a
   couple of metres of the base. Measured: 6.8% of the hero frame is darkened by
   the shadow map at all, essentially all of it in the bottom 100 px. The pool is
   what actually grounds the tree, and it is a real physical term rather than a
   painted-on blob: the rig biases its centre a short way along the shadow
   direction, so it reads as shade that belongs to this sun.

   Occludes the AMBIENT strongly and the KEY weakly (a canopy is a volume of
   leaves with gaps, and our geometry only models the biggest of those gaps), and
   fades with the surface's up-facing-ness because a vertical surface under a tree
   still sees the bright horizon.                                           */
#ifndef NPR_CANOPY_SHADE
  // Fraction of the SKY ambient the canopy takes from an up-facing surface at the
  // pool's core. CALIBRATED: with 0.62/0.40 the ground just behind the trunk
  // printed at 0.425 of open sunlit grass 10 m out — under ART_BIBLE §2's
  // 0.50-0.60 window, i.e. the pool had become a dark blob. 0.50/0.28 lands it at
  // 0.51-0.55 (measured in the graded png, both values reported).
  #define NPR_CANOPY_SHADE 0.50
#endif
#ifndef NPR_CANOPY_KEY
  #define NPR_CANOPY_KEY 0.28
#endif
float nprCanopySky(){ return uShadeCal.z > 0.0 ? uShadeCal.z : NPR_CANOPY_SHADE; }
float nprCanopyKey(){ return uShadeCal.w > 0.0 ? uShadeCal.w : NPR_CANOPY_KEY; }
float nprCanopyShade(vec3 N, float weight){
  if (nprDappleWP.x > 1.0e8 || uCanopyOcc.w <= 0.0) return 1.0;
  vec3 d = nprDappleWP - uCanopyOcc.xyz;
  float R = uCanopyOcc.w;
  float rh = length(d.xz);
  // Only what is UNDER the canopy loses sky to it. Fades out over the top half
  // of the canopy so the blossom cards themselves darken toward their interior
  // instead of stopping at a hard height.
  float below = 1.0 - smoothstep(0.0, R * 1.25, max(d.y, 0.0));
  // Soft-edged disc: flat core out to 40% of the radius, then a long falloff, so
  // there is never a visible circular boundary on the grass.
  float radial = 1.0 - smoothstep(R * 0.40, R * 1.10, rh);
  radial *= radial;
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  return 1.0 - weight * below * radial * mix(0.42, 1.0, up);
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

/* --- Effective strength of the shadow tint multiply.
       NPR_SHADOW_HUE and NPR_SHADOW_CHROMA are LEGACY per-material dampers,
       authored against the old HSV-rotation model where a small number meant
       "keep my own hue". Under the multiply model the same numbers would opt a
       material out of the cool shift altogether — and "no cool shift" is the
       §8.4 instant-fail this round exists to remove, measured on bark
       (7.8 deg lit -> 28.1 deg shadow, i.e. WARMER) and on the dirt path
       (31.2 -> 43.7). So the dampers are honoured, but floored at 0.78: a
       material may ask for a little less violet, never for none. */
float nprTintStrength(){
  float damp = clamp(NPR_SHADOW_HUE, 0.0, 1.0) * clamp(NPR_SHADOW_CHROMA, 0.0, 1.0);
  return clamp(NPR_SHADOW_TINT, 0.0, 1.0) * mix(0.78, 1.0, damp);
}

/* --- level-preserving chromatic shift of albedo toward the shadow tint.
       ART_BIBLE §2, implemented literally: "MULTIPLY shadowed albedo toward cool
       violet-blue #6E76A8". A linear multiply by the tint renormalised to unit
       luminance is exactly that operation, and it behaves the way a cool skylight
       actually behaves:

         bark   #6A5344 -> 231 deg, B > R, saturation BELOW the lit side's
         dirt   #A08768 -> ~207 deg, B > R
         grass  #6E8F4A -> ~144 deg — it cools hard toward the tint without ever
                being repainted navy, because a multiply cannot take a surface
                past its own dominant channel.

       Renormalising to the albedo's own luminance keeps this a purely CHROMATIC
       operation; nprShadowLevel() owns the value. The previous HSV implementation
       rotated hue by at most ~13 deg for a warm albedo and took the SHORT arc,
       which runs through red — every measured pair came out darker AND warmer. */
vec3 nprShadowHue(vec3 albedo){
  float al = max(nprLuma(albedo), 1e-4);
  float tl = max(nprLuma(uShadowTint), 1e-4);
  vec3  tn = max(uShadowTint, vec3(0.0)) / tl;       // unit-luminance tint
  // A near-neutral albedo takes less of the multiply — see NPR_SHADOW_TINT_NEUTRAL.
  float mx = max(max(albedo.r, albedo.g), albedo.b);
  float asat = mx > 1e-5 ? (mx - min(min(albedo.r, albedo.g), albedo.b)) / mx : 0.0;
  float s = nprTintStrength() * mix(NPR_SHADOW_TINT_NEUTRAL, 1.0,
                                    smoothstep(0.10, 0.45, asat));
  vec3  sh = max(albedo, vec3(0.0)) * mix(vec3(1.0), tn, s);
  return sh * (al / max(nprLuma(sh), 1e-4));         // luminance-preserving
}

/* --- shadowed albedo: hue-shifted toward uShadowTint at a fixed fraction of
       the lit level, never toward black. */
/* A dark albedo's shadow needs a bigger fraction than a bright one: ACES + sRGB
   crush the bottom of the range, so a flat fraction turns bark into a black
   slab while grass still reads. This keeps the ON-SCREEN light:shadow ratio
   roughly constant across the palette. */
float nprShadowLevel(float al){
  // This curve is what makes ART_BIBLE §2's 0.55 ratio hold across the PALETTE
  // rather than only at mid grey, and the window was measured, not guessed. The
  // grade's S-curve (pivot 0.34, slope 1.38) is far steeper below the pivot than
  // at it: the same SCENE ratio prints as a DISPLAY ratio of ^1.36 at the 0.50
  // grey ball's level and ^2.07 at bark's, so a flat fill that reads 0.55 on
  // grey reads 0.28 on bark. Ending the window at 0.270 (just above the 0.50
  // grey's 0.216) gives bark 27% of the boost and grey 11%, and both land on
  // 0.55 in the graded png. Measured on the 'calib' balls: window 0.100 -> bark
  // 0.28 / grey 0.43; window 0.270 -> bark 0.55 / grey 0.56.
  //
  // r3: the ENDS were far too far apart. mix(2.20, 0.66, ...) returns 0.98 for
  // bark's albedo luminance (~0.10), i.e. bark's shadow was handed 98% of its lit
  // level and the whole trunk spanned L 0.353..0.440 in the graded frame — an
  // 0.087 range with no terminator anywhere on it. mix(1.30, 0.88, ...) keeps the
  // compensation's direction (a dark albedo does need a bigger fraction, because
  // the grade is steeper down there) without letting it collapse the ratio:
  // bark 0.66, grey 0.50, grass 0.48 at uShadowCal.x = 1.
  return NPR_SHADOW_LEVEL * mix(1.30, 0.88, smoothstep(0.010, 0.270, al))
       * max(uShadowCal.x, 0.02);
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
  sh += nprShadowFloor(shHue) * (NPR_SHADOW_FLOOR * kl);
  return max(sh, vec3(0.006));                         // never pure black
}
vec3 nprShadowAlbedo(vec3 albedo){ return nprShadowAlbedo(albedo, uSunColor); }

/* --- chroma-limited key for the DIFFUSE MULTIPLY only ----------------
   A multiply by a strongly chromatic key is a hue-destroying operation: it
   scales the albedo's channels so unequally that the surface's own dominant
   channel loses. At the shipped dusk key (#FFB683 x 2.25, linear red:blue
   4.4:1) that put grass, torii vermilion and sakura pink all inside hue
   13..32 deg — one sepia wash, ART_BIBLE §8.9 — even though the palette gives
   them 100 deg of separation. Stylised anime dusk does not do this; it keeps
   local colour and carries the sunset in the SKY, the RIM and the AIR.

   So the diffuse multiply neutralises the key toward its own luminance, by an
   amount that fades in with the key's chroma:

     day   #FFE6CE x 2.95  -> chroma 0.38 -> 0.00 neutralisation (untouched)
     dusk  #FFB683 x 2.25  -> chroma 0.77 -> ~0.43
     night #9FB6E8 x 0.88  -> chroma 0.54 -> ~0.13

   Every ADDITIVE term (specular, rim, transmission, lamps) keeps the full
   chroma key, so the frame still reads as lit by a sunset. */
float nprKeyChroma(vec3 k){
  float m = max(max(k.r, k.g), k.b);
  return m > 1e-5 ? (m - min(min(k.r, k.g), k.b)) / m : 0.0;
}
vec3 nprKeyDiffuse(vec3 k, float kl){
  float amt = clamp(uShadowCal.w, 0.0, 1.0) * smoothstep(0.42, 0.80, nprKeyChroma(k));
  return mix(k, vec3(kl), amt);
}

/* --- directional ambient: sky from above, bounce from below ----------
   The sky/bounce split is the cosine-weighted fraction of the hemisphere a
   surface can see, which for a VERTICAL surface is exactly half sky and half
   ground. The old curve (up*up*0.82 + up*0.18) returned 0.295 there, i.e. it
   handed a vertical surface 70% ground bounce, so every grass blade, every
   trunk flank and every leaf card was ambient-lit by the dark ground term and
   came out darker than the flat ground next to it (ART_BIBLE §3's grass rule,
   inverted). This curve passes through 0.45 at up = 0.5 — still slightly
   ground-biased, because a blade of grass really is surrounded by other grass,
   but no longer inventing occlusion that is not there. */
vec3 nprAmbient(vec3 N){
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(uGroundColor, uSkyColor, up * 0.72 + up * up * 0.28);
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
  // the canopy's own shade pool takes a bite out of the key as well as the sky
  float canopyK = nprCanopyShade(N, nprCanopyKey());
  t = clamp(t * dapple * nprKeyGust() * canopyK, 0.0, 1.12);

  float kl = clamp(nprLuma(kcol), 0.05, 1.15);
  vec3  shHue = nprShadowHue(albedo);
  // A deeper 4th plateau in the very core of the form shadow — the palette's
  // "deep interior" value, and the frame's dark anchor. Banded, so it stays a
  // flat plateau too, and keyed off the FORM value d only, so a cast shadow
  // lying on otherwise sunlit ground never drops into it.
  // The fake fill is OCCLUDED. An open cast shadow keeps all of it (ART_BIBLE's
  // 0.55 ratio); an enclosed pocket keeps a fifth. The "never black" pedestal
  // underneath is deliberately NOT occluded, so even the deepest interior keeps
  // uShadowTint's violet rather than going to zero.
  float occ = clamp(ao, 0.0, 1.0);
  // ...and the plateau itself is gated on OCCLUSION as well as direction — see
  // NPR_SHADOW_CORE_OPEN. Facing away from the key is not the same fact as being
  // buried inside the mass.
  float core = (1.0 - smoothstep(0.150, NPR_SHADOW_CORE_HI, d))
             * mix(NPR_SHADOW_CORE_OPEN, 1.0, 1.0 - occ);
  // ...and an OPEN cast shadow gets a little more of it than a form shadow does,
  // because it has lost only the sun (see NPR_CAST_FILL).
  float castFill = mix(NPR_CAST_FILL, 1.0, castT);
  float coreDepth = clamp(NPR_SHADOW_CORE * max(uShadowCal.y, 0.02), 0.05, 1.0);
  vec3  shDiff = shHue * (nprShadowLevel(nprLuma(albedo)) * kl
                          * mix(1.0, coreDepth, core)
                          * mix(nprShadowAoLevel(), 1.0, occ)
                          * castFill)
               + nprShadowFloor(shHue) * (NPR_SHADOW_FLOOR * kl);

  // ---- The DIFFUSE multiply uses a chroma-limited key. ART_BIBLE §8.9 forbids
  // muddy midtones and §3 gives grass, vermilion and sakura three different
  // hues; a physically-multiplied #FF9E5E dusk key (linear red:blue = 4.4:1)
  // destroys all three at once — measured on the dusk hero, grass printed
  // hue 15-32 deg everywhere, the torii 356 deg, i.e. one sepia wash. The
  // neutralisation fades in with the KEY's own chroma, so full daylight
  // (chroma 0.38) is untouched and only dusk/dawn/moonlight are stylised.
  // Additive terms below (spec, rim, transmission) keep the full-chroma key, so
  // the light still reads unmistakably warm.
  vec3 kdiff = nprKeyDiffuse(kcol, kl);
  vec3 col = mix(shDiff, albedo * kdiff, t);

  // Ambient. The albedo it multiplies is hue-shifted wherever the surface is
  // unlit, so the sky/bounce term reinforces the violet shadow instead of
  // dragging it back to the surface's own hue. Only partly, though: uSkyColor is
  // already strongly blue, and stacking a blue tint on a blue ambient overshoots
  // into an electric-blue shadow.
  //
  // FORM occlusion and CAST occlusion are separate factors because they are
  // separate physical facts. A surface turned away from the key is turned into
  // the scene and sees less sky (NPR_AMBIENT_SHADOW); a patch of ground inside
  // the tree's cast shadow is still staring straight up at the whole dome and
  // has only lost the sun (NPR_AMBIENT_CAST, near 1). Sharing one number here
  // is what made cast shadows read as painted-on decals and forced the fake
  // key fill to be large enough to flatten the whole frame.
  float formT = nprRamp(d);
  float ambOcc = mix(NPR_AMBIENT_SHADOW, 1.0, formT) * mix(NPR_AMBIENT_CAST, 1.0, castT);
  // The hue rotation on the AMBIENT albedo is keyed off the FORM factor, not the
  // combined one. A surface turned away from the key is turned into the scene and
  // genuinely picks up bounced violet; a patch of grass merely standing in the
  // tree's cast shadow has not changed material — it is still staring at the same
  // sky and it is still GREEN (ART_BIBLE §2: shadowed grass stays green, shadowed
  // bark stays brown). Sharing one factor here is what turned every cast shadow
  // on the lawn into violet-grey paint. A cast shadow still cools, but it cools
  // because uSkyColor is blue, which is the real reason.
  float ambHueRot = 0.46 * (1.0 - formT) + 0.16 * (1.0 - castT);
  vec3 ambA = mix(albedo, shHue, clamp(ambHueRot, 0.0, 0.62));
  // occ^1.35, not occ: sky visibility falls off faster than a linear AO term
  // suggests once a point is inside a pocket, and this is the second half of
  // the dark anchor (the first is NPR_SHADOW_AO on the fill above).
  col += ambA * nprAmbient(N) * pow(max(occ, 1e-4), nprAmbOccPow()) * ambOcc
       * nprCanopyShade(N, nprCanopySky());

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
  //
  // ...but the floor was 0.10, i.e. a single blade of grass or one petal card
  // seen FACE ON transmitted almost nothing, even though a blade is the same
  // fraction of a millimetre thick whichever way you look at it. That is why
  // every grass blade whose normal turned away from the key fell into the plain
  // form shadow and the lawn read darker than the bare ground under it. The
  // floor is 0.34 now and the grazing amplitude is trimmed to compensate, so
  // the silhouette glow is unchanged and the face-on bleed is 3x.
  //
  // AMPLITUDES ARE ARC-DEPENDENT and were re-measured after the sun arc moved
  // behind the tree (see the arc note under KEYS). With a front key the back
  // lobe is ~0 and these numbers were free; with a backlit key dot(-L,V) is 0.7-0.9
  // over the WHOLE frame, so at the old 0.95/0.50 every blade of translucent
  // grass in the garden transmitted at once and the hero frame's lum p50 went
  // 0.56 -> 0.73 with p1 at 0.12 (measured) — the washed-out midtones of
  // ART_BIBLE §8.9. Trimmed to 0.52/0.32, which keeps the petal glow (petals
  // carry translucency 1.0 AND thickness ~0.85, so they still take ~3x what a
  // grass blade does) and gives the frame its low end back.
  float thin = mix(0.34, 1.0, fres);
  // SOFT-ADDED, see NPR_TRANS_SOFT. The back lobe is ART_BIBLE §2's
  // pow(saturate(dot(-L,V)), 4) * thickness, tinted #FFE7EE; dividing by the
  // surface's own level is what turns it into a GLOW inside a dark backlit
  // cluster instead of one more addition on a blossom that is already clipping.
  float trans = (back * 0.60 + wrap * wrap * 0.32 * thin)
              * translucency * thickness * mix(0.22, 1.0, sm);
  col += tcol * trans / (1.0 + NPR_TRANS_SOFT * nprLuma(col));

  // ---- Rim, part 1: the KEY's hot silhouette line.
  //
  // ART_BIBLE §2's Fresnel verbatim — pow(1 - NdotV, 3.2) — gated on the key
  // being BEHIND the subject, tinted to the key colour. The old term multiplied
  // the same Fresnel by smoothstep(0.80, 0.965, rimRaw), which is an 11-degree
  // band about the silhouette; on a 0.35 m branch at 8 m that is half a pixel
  // wide, which is why the dusk canopy frame measured a monotonic sky -> branch
  // falloff (0.679 -> 0.539 -> 0.331 -> 0.123) with no overshoot anywhere on any
  // silhouette. The shaping step below only removes the wide skirt of the pow
  // (rimRaw < 0.26, i.e. more than 60 deg off the silhouette) so the term stays
  // a drawn EDGE — measured 2-4 px at 1080p — rather than a wash over every
  // grazing surface.
  float facing = clamp(dot(N, L) * 0.5 + 0.55, 0.16, 1.0);
  float bl     = clamp(-dot(L, V), 0.0, 1.0);           // key behind the subject
  float band   = fres * smoothstep(0.26, 0.78, rimRaw);
  // MEASURED, and this damping is not optional. A rim is a SILHOUETTE effect: it
  // exists where a surface curves away from the camera against something behind
  // it. A big up-facing ground plane seen from a 6 m eye height is grazing over
  // the entire lower half of frame — dot(N,V) ~ 0.1, i.e. rimRaw ~ 0.9 — and has
  // no silhouette at all, so an undamped Fresnel hands it a free doubling of its
  // own brightness. Measured on the hero frame with the rim on vs off: the dirt
  // path went 0.368 -> 0.673 and the lawn 0.477 -> 0.602. Branch, trunk flank and
  // blossom-card normals are near-horizontal and keep the term in full.
  float rimUpK = mix(1.0, 0.12, smoothstep(0.35, 0.95, clamp(N.y, 0.0, 1.0)));
  col += kcol * band * (0.30 + 1.30 * bl) * facing * (0.55 + 0.45 * sm) * rimUpK
       * NPR_RIM_KEY * rimScale * max(uShadowCal.z, 0.0);

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

/* --- local warm lamps -------------------------------------------------
   Stone-lantern / festival light contribution, in the same stylised language
   as the key: a WRAPPED half-Lambert pushed through the same three-plateau
   ramp, a hard windowed falloff (so a lamp has a definite reach instead of an
   inverse-square tail that never quite ends), one clipped specular bead, and a
   warm Fresnel bloom on grazing edges so a lantern also rims the grass and the
   petals around it.

   Uses the world position published by nprSetWorldPos() — every surface shader
   in the project already calls it for the canopy dapple — so no module has to
   change a line to receive lantern light. A shader that never calls it (the sky)
   simply gets nothing.

   translucency/thickness are honoured: a petal or a blade of grass in front of a
   lantern glows the way it does in front of the sun. */
vec3 nprLamps(vec3 albedo, vec3 N, vec3 V, float translucency, float thickness, float ao){
  if (nprDappleWP.x > 1.0e8) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float occ = clamp(ao, 0.0, 1.0);
  for (int i = 0; i < NPR_MAX_LAMPS; i++) {
    vec4 P = uLampPos[i];
    if (P.w <= 0.0) continue;
    vec3 d = P.xyz - nprDappleWP;
    float dist = length(d);
    float att = 1.0 - clamp(dist / P.w, 0.0, 1.0);
    if (att <= 0.0) continue;
    att *= att;                                        // soft, reaches exactly 0 at the range
    vec3 Lc = uLampColor[i];
    vec3 Ld = d / max(dist, 1e-4);
    // Wrapped so the falloff round a trunk or a rock is soft rather than a hard
    // half-lit line, then banded so it still reads as ramp shading.
    float w = clamp(dot(N, Ld) * 0.5 + 0.5, 0.0, 1.0);
    float band = nprRamp(w) * 0.68 + w * 0.32;
    acc += albedo * Lc * band * att * mix(0.35, 1.0, occ);
    // one small clipped bead of specular
    vec3  H = normalize(Ld + V);
    float ndh = max(dot(N, H), 0.0);
    acc += Lc * smoothstep(0.30, 0.62, pow(ndh, 90.0)) * 0.30 * att;
    // warm grazing rim + transmission through thin foliage in front of the lamp
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
    float back = pow(clamp(dot(-Ld, V), 0.0, 1.0), 4.0);
    acc += Lc * fres * 0.30 * att;
    acc += Lc * NPR_TRANSMIT_TINT * back * 0.75 * translucency * thickness * att;
  }
  return acc;
}

/* --- full entry point, geometric-normal aware ------------------------ */
vec3 nprShadeN(vec3 albedo, vec3 N, vec3 Ng, vec3 V, float shadowMask,
               float translucency, float thickness,
               float specScale, float rimScale, float ao){
  N = normalize(N); Ng = normalize(Ng); V = normalize(V);
  float wN = clamp(uNightMix, 0.0, 1.0);

  // Scotopic desaturation. Rods carry no colour, so a moonlit garden is not a
  // daylit garden with a blue light on it — it loses chroma. Without this the
  // night frame came back as vivid daylight-green grass under a navy sky, which
  // is the same class of failure as the daylight-green grass under the dusk sky
  // that this round had to fix. Grass keeps enough green to still read as grass.
  albedo = mix(albedo, vec3(nprLuma(albedo)), 0.42 * wN);

  vec3 day   = nprKeyG(albedo, N, Ng, V, normalize(uSunDir),  uSunColor,
                       shadowMask, translucency, thickness, specScale, rimScale, ao);
  vec3 night = nprKeyG(albedo, N, Ng, V, normalize(uMoonDir), uSunColor,
                       shadowMask, translucency, thickness, specScale, rimScale * 0.8, ao);
  return mix(day, night, wN)
       + nprLamps(albedo, N, V, translucency, thickness, ao);
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
  float tau = pow(max(d * density, 0.0), nprAerialPow()) * h;
  return clamp(1.0 - exp(-tau), 0.0, 1.0);
}
vec3 nprAerialTint(float f){
  // At range the haze takes on the sky's HUE — but not the sky's value. uSkyColor
  // is the zenith AMBIENT (a fairly dark blue), so the old uSkyColor * 1.25
  // target sat ~30% BELOW uFogColor in luminance: every surface at maximum depth
  // was driven darker than the air in front of it, which is the inverted aerial
  // perspective the review measured (hills 0.217 L under the sky). Renormalising
  // the sky's chroma onto the fog's own luminance keeps the cooling and drops the
  // darkening.
  vec3 skyHue = uSkyColor * (nprLuma(uFogColor) / max(nprLuma(uSkyColor), 1e-4));
  // 0.35 -> 0.52 (r4). ART_BIBLE §5 / the r4 brief: each receding plane must be
  // COOLER than the one in front of it and never more saturated than the sky. The
  // haze's own hue is what carries that, and uFogColor #BCD3EA is only mildly
  // cool; pulling the far end further onto the sky's chroma (at the fog's own
  // luminance, so no darkening comes with it) is what makes the far terrain read
  // as air rather than as pale ground.
  vec3 far = mix(uFogColor, skyHue, 0.52);
  // ...and the whole target sits BELOW uFogColor's authored value, because what
  // recedes here is LAND and it must stay under the sky. See NPR_AERIAL_LEVEL.
  return mix(uFogColor, far, smoothstep(0.28, 1.0, f)) * nprAerialLevel();
}
vec3 nprAerialMix(vec3 color, vec3 fogc, float f){
  float rel = clamp(nprLuma(color) / max(nprLuma(fogc), 1e-4), 0.0, 2.2);
  // Value preservation relaxes with depth but never to zero — see
  // NPR_AERIAL_VALUE_FAR. That floor is what keeps three receding bands three
  // separable values instead of one plate.
  float keep = mix(nprAerialKeepMid(), nprAerialKeepFar(),
                   smoothstep(NPR_AERIAL_VALUE_FADE.x, NPR_AERIAL_VALUE_FADE.y, f));
  return mix(color, fogc * mix(1.0, rel, keep), f);
}

vec3 applyAerial(vec3 color, float viewDist, float worldY){
  float f = nprAerialF(viewDist, worldY);
  return nprAerialMix(color, nprAerialTint(f), f);
}

/* 4-arg variant adds forward-scatter: haze brightens toward the sun. */
vec3 applyAerial(vec3 color, float viewDist, float worldY, vec3 V){
  float f = nprAerialF(viewDist, worldY);
  vec3 fogc = nprAerialTint(f);
  // Forward scatter. 0.07, not the 0.20 this carried while the sun sat behind the
  // camera: the arc now keeps the key in FRONT of the camera all day, so
  // dot(-V, sunDir) is 0.7+ across the entire frame instead of ~0, and 0.20 was
  // dumping a flat warm veil over every distant surface at once.
  float sc = pow(clamp(dot(-normalize(V), normalize(uSunDir)), 0.0, 1.0), 5.0);
  fogc += uSunColor * sc * 0.07 * (1.0 - uNightMix);
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

/* The DEFAULT view (DEFAULT_DAY_T = 0.665, the golden-hour mood anchor) has to
   fall inside the DAY band. Every phase-reactive module in the project — the sky
   gradient, the water, the props' lanterns, the audio bed — switches on the phase
   NAME, so while `dusk` began at 0.625 a brand-new save opened on a full sunset
   sky with the stone lanterns already burning. Day now runs to 0.690, which puts
   the anchor at t = 0.95 of `day`: late afternoon, warm, lanterns still out. */
const PHASE_BOUNDS = [
  ['dawn', 0.085, 0.200],
  ['day', 0.200, 0.690],
  ['dusk', 0.690, 0.815],
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
 *             back-tracks (and t=1 is exactly t=0 + 360 so midnight wraps
 *             continuously); dir = (cos(elev)cos(azim), sin(elev), cos(elev)sin(azim)).
 *
 *  THE SUN ARC — settled by the project owner: THE BACKLIGHT WINS.
 *
 *  The hero camera sits at (14, 6.5, 21) looking at (0, 7.5, 0), so the
 *  camera-to-tree axis has azimuth 56.3 deg and the camera's bottom edge hits
 *  the ground at (1.4, 0, 2.1) — right at the tree base. That geometry is what
 *  makes a LONG cast shadow impossible to show: a shadow long enough to cross
 *  visible ground has to run away from the camera, which puts the key behind
 *  the camera, which kills the backlit translucent canopy — the one thing
 *  reviewers consistently praised. So we do not chase shadow LENGTH at all.
 *
 *  The whole arc therefore lives on the FAR side of the tree: the sun rises at
 *  azimuth 196, passes 240 (almost exactly the 236.3 "directly behind the
 *  tree" bearing) at noon and sets at 272. dot(sunXZ, cameraXZ) is negative all
 *  day, i.e. the canopy is backlit from dawn to dusk, and the sun sits just
 *  outside the frame edge (21 deg right / above at the golden hour, 36 deg
 *  right at dusk) which is exactly where god rays through the canopy want it.
 *
 *  The cast shadow consequently runs TOWARD the camera and is SHORT in frame:
 *  it pools at the trunk base and across the near strip at the bottom of the
 *  hero composition, then leaves frame. That is intended. It reads through
 *  CONTRAST, not length — the ground beyond the tree stays in full sun, the
 *  ground at and in front of the base sits at 0.5-0.6 of that luminance
 *  (ART_BIBLE §2, and measured, not asserted).
 *
 *  ELEVATION is what decides whether that pool actually reaches the trunk.
 *  The canopy's shadow ellipse spans (cy/tan e) +/- (R/sin e) along the shadow
 *  direction, so it covers the base only while cos(e) <= R/cy. With the tree's
 *  canopy at cy ~ 7.5 and R ~ 8-9 that holds comfortably at the 40 deg
 *  golden-hour anchor and at everything below it; 52 deg at noon is the ceiling
 *  (above that the canopy's lit top and shaded underside converge and the trunk
 *  loses its terminator).
 *
 *  Azimuth stays monotonically increasing across the whole cycle and t=1 is
 *  exactly t=0 + 360, so midnight wraps without the sun ever back-tracking.
 */
const KEYS = [
  { t: 0.000, sun: 0x9FB6E8, sunInt: 0.88, sky: 0x46527C, skyInt: 0.70, ground: 0x24283C, groundInt: 0.64,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0120, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.62,
    elev: -52, azim: 126, night: 1.00, exp: 1.20, env: 0.35 },
  { t: 0.070, sun: 0xB6A6C8, sunInt: 1.08, sky: 0x4E5680, skyInt: 0.74, ground: 0x2A2838, groundInt: 0.66,
    shadow: 0x2A3358, fog: 0x2E3352, fogD: 0.0125, zenith: 0x152040, horizon: 0x53516E,
    fill: 0x5A6690, fillInt: 0.25, rim: 0xC0B6DE, rimInt: 0.55, hemi: 0.66,
    elev: -22, azim: 160, night: 0.82, exp: 1.16, env: 0.42 },
  { t: 0.135, sun: 0xFFDCC2, sunInt: 1.90, sky: 0x6E7FB8, skyInt: 0.84, ground: 0x3E3440, groundInt: 0.62,
    shadow: 0x5C6EA8, fog: 0xD9C3D2, fogD: 0.0165, zenith: 0x3E6BB0, horizon: 0xF3C4D0,
    fill: 0x8FA6D8, fillInt: 0.42, rim: 0xFFD2B4, rimInt: 0.85, hemi: 0.85,
    elev: 8, azim: 196, night: 0.10, exp: 1.06, env: 0.85 },
  { t: 0.240, sun: 0xFFF0DC, sunInt: 3.00, sky: 0x7EA0D8, skyInt: 0.95, ground: 0x4E5240, groundInt: 0.70,
    shadow: 0x687EB2, fog: 0xBCD3EA, fogD: 0.0152, zenith: 0x4E86D4, horizon: 0xCFE0F2,
    fill: 0x9FBCE8, fillInt: 0.50, rim: 0xFFF0D8, rimInt: 0.60, hemi: 1.00,
    elev: 27, azim: 212, night: 0.00, exp: 1.00, env: 1.00 },
  { t: 0.500, sun: 0xFFF8EE, sunInt: 3.30, sky: 0x8FB0E2, skyInt: 1.00, ground: 0x585C46, groundInt: 0.75,
    shadow: 0x748AB8, fog: 0xC1D7EC, fogD: 0.0136, zenith: 0x4E86D4, horizon: 0xD8E6F5,
    fill: 0xA8C4EE, fillInt: 0.50, rim: 0xFFF6E8, rimInt: 0.50, hemi: 1.05,
    elev: 52, azim: 240, night: 0.00, exp: 0.98, env: 1.05 },
  { t: 0.665, sun: 0xFFE6CE, sunInt: 2.95, sky: 0x7498D6, skyInt: 0.84, ground: 0x5A4A3C, groundInt: 0.75,
    shadow: 0x5C82B6, fog: 0xBCD3EA, fogD: 0.0152, zenith: 0x4574B8, horizon: 0xF2CBA0,
    fill: 0x92A8DE, fillInt: 0.42, rim: 0xFFD9A8, rimInt: 1.00, hemi: 0.92,
    elev: 40, azim: 258, night: 0.00, exp: 1.02, env: 0.95 },
  { t: 0.765, sun: 0xFFB683, sunInt: 2.25, sky: 0x6C7CAE, skyInt: 0.88, ground: 0x54382E, groundInt: 0.76,
    shadow: 0x565492, fog: 0xE8A57E, fogD: 0.0150, zenith: 0x3A4E86, horizon: 0xF5A86E,
    fill: 0x7A88C0, fillInt: 0.38, rim: 0xFFB070, rimInt: 1.05, hemi: 0.92,
    elev: 8.0, azim: 272, night: 0.16, exp: 1.06, env: 0.80 },
  { t: 0.840, sun: 0xD5A3B4, sunInt: 1.16, sky: 0x4C5A90, skyInt: 0.72, ground: 0x342C3C, groundInt: 0.64,
    shadow: 0x33405E, fog: 0x6B5A78, fogD: 0.0160, zenith: 0x22305C, horizon: 0x8A6A82,
    fill: 0x5E6A98, fillInt: 0.30, rim: 0xD8A0C0, rimInt: 0.70, hemi: 0.76,
    elev: -14, azim: 300, night: 0.62, exp: 1.12, env: 0.55 },
  { t: 0.920, sun: 0x9FB6E8, sunInt: 0.88, sky: 0x46527C, skyInt: 0.70, ground: 0x24283C, groundInt: 0.64,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0120, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.62,
    elev: -46, azim: 400, night: 1.00, exp: 1.20, env: 0.35 },
  { t: 1.000, sun: 0x9FB6E8, sunInt: 0.88, sky: 0x46527C, skyInt: 0.70, ground: 0x24283C, groundInt: 0.64,
    shadow: 0x1E2A4A, fog: 0x1B2440, fogD: 0.0120, zenith: 0x0C1530, horizon: 0x2A3355,
    fill: 0x4A5C8C, fillInt: 0.22, rim: 0xAFC4EE, rimInt: 0.50, hemi: 0.62,
    elev: -52, azim: 486, night: 1.00, exp: 1.20, env: 0.35 },
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

/**
 * Default `uShadowCal.w` — how far the key's DIFFUSE MULTIPLY is neutralised at
 * maximum key chroma (see nprKeyDiffuse in the GLSL). 0.45 measured: it is the
 * amount that brings the dusk lawn back from hue 15-32 deg (sepia) into the
 * yellow-green band while leaving the full-daylight frame bit-identical, because
 * the daylight key's chroma (0.38) sits below the smoothstep's 0.42 threshold.
 */
export const NPR_KEY_DESAT = 0.45;

/** Height/distance fog shaping constants (uFogParams.y/.z). */
export const FOG_HEIGHT_FALLOFF = 0.055;
export const FOG_START_DISTANCE = 40.0;

/**
 * Global scale on every keyframe's fog density.
 *
 * 0.82 (r4). It was 1.0 — "the fogD rows ARE the shipped densities" — and that
 * held while the aerial TARGET was uFogColor itself, because the only way to get
 * any convergence at all was to push the rate. Now that the target sits at
 * NPR_AERIAL_LEVEL of the fog colour and keeps a floor of the surface's own value
 * (NPR_AERIAL_VALUE_FAR), the far end converges on its own and the rate is free to
 * come down — which is what buys back the mid-ground.
 *
 * MEASURED on the hero frame, terrain at 91 m (the row the reviewer called a milky
 * band), display L and rgb:
 *   1.00  0.624  rgb(138,165,161)   grey-teal — haze, not grass
 *   0.82  0.514  rgb(115,138,109)   green, and 0.11 lower than the 43 m sward
 *   0.60  0.494  rgb(114,133, 92)   greener still, but the far edge at 130 m stops
 *                                   reading as AIR (0.603, chroma 0.09) — §8.3
 * 0.82 is the last value at which the 130 m edge is still recognisably cool air
 * (rgb(145,167,172)) while 91 m is recognisably grass.
 */
export const AERIAL_STRENGTH = 0.82;

/* ---------------------------------------------------------------------- *
 * The four aerial + four occlusion calibration numbers, mirrored on the JS
 * side so 08-lighting.js can write them per phase (and sweep them live via the
 * cal-* scenarios) without the GLSL #defines and these ever disagreeing.
 * KEEP IN LOCKSTEP with NPR_AERIAL_* / NPR_CANOPY_* in the GLSL above.
 * ---------------------------------------------------------------------- */
export const AERIAL_LEVEL = 0.72;      // haze target as a fraction of uFogColor
export const AERIAL_KEEP_MID = 0.52;   // own-value preservation at mid depth
export const AERIAL_KEEP_FAR = 0.30;   // ...and at maximum depth (never 0)
export const AERIAL_POW = 1.6;         // exponent on the optical depth
export const AMB_OCC_POW = 1.85;       // sky visibility falloff inside a pocket
export const CANOPY_SKY = 0.50;        // canopy shade pool: fraction of sky taken
export const CANOPY_KEY = 0.28;        // ...and of the key

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
    // Local warm lamps. Array LENGTH must equal NPR_MAX_LAMPS in the GLSL.
    // w <= 0 = slot unused; 08-lighting.js fills these from scene PointLights.
    uLampPos: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uLampColor: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Color(0, 0, 0)) },
    // Canopy shade pool (ground centre xyz, radius). w <= 0 = off.
    uCanopyOcc: { value: new THREE.Vector4(0, 0, 0, 0) },
    // Global shading calibration — (shadowRatioScale, coreDepthScale, keyRimGain,
    // keyDiffuseDesat). 08-lighting.js rewrites this every frame from the phase
    // palette; the defaults here are the shipped day values so a module that
    // falls back to createLightUniforms() still looks right.
    uShadowCal: { value: new THREE.Vector4(1, 1, 1, NPR_KEY_DESAT) },
    // Aerial calibration — (hazeLevel, keepMid, keepFar, depthPow). Every
    // component uses the "0 means the shipped default" guard in the GLSL, so
    // these defaults and the #defines can never disagree.
    uAerial: { value: new THREE.Vector4(AERIAL_LEVEL, AERIAL_KEEP_MID, AERIAL_KEEP_FAR, AERIAL_POW) },
    // Occlusion calibration — (ambOccPow, shadowAoScale, canopySky, canopyKey).
    uShadeCal: { value: new THREE.Vector4(AMB_OCC_POW, 1, CANOPY_SKY, CANOPY_KEY) },
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
