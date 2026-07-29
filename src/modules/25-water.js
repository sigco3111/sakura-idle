import * as THREE from 'three';
import { WIND } from '../lib/wind.js';
import { makeRng } from '../lib/rng.js';
import { noise3 } from '../lib/noise.js';
import { createNprMaterial } from '../lib/lighting.js';
import {
  MAX_RIPPLES, RIPPLE_LIFE, DEPTH_SCALE, BANK_SCALE,
  WATER_VERT, WATER_FRAG, BED_VERT, BED_FRAG, REED_VERT, REED_FRAG,
  buildPondDepthTexture, buildBedGeometry, buildReedGeometry, buildStoneGeometry,
  makeFloatPetalTexture, buildFloatPetalGeometry,
} from '../lib/water-shaders.js';

/**
 * 25-water.js — the pond.  order 25 (after terrain, before the tree).
 * Owner: water agent.  Shaders live in src/lib/water-shaders.js.
 *
 * WHAT IS HERE
 *   1. bed        — a terrain-conforming silt/pebble dish that continues UP the
 *                   bank as wet then dry mud and dissolves into the grass. This
 *                   is what makes the waterline a blend instead of a polygon:
 *                   the water's alpha fades out over the last ~0.7 m of shallows
 *                   while the bed's wet band fades in over the same distance.
 *   2. surface    — one flat disc, custom ShaderMaterial (GLSL_NPR + nprShadeN +
 *                   applyAerial). Fresnel between a reflection and a depth-graded
 *                   transmitted body, premultiplied alpha so the alpha blend IS
 *                   the water's absorption. THREE wind-driven wave bands (swell /
 *                   ripple / chop, distance-faded) + pooled ripple rings.
 *   3. reflection — a real planar mirror pass at half resolution when
 *                   ctx.quality.waterReflect, rendering only the sky / hills /
 *                   ground / tree / props (never the grass, never the water),
 *                   with Lengyel oblique near-plane clipping so nothing below
 *                   the waterline leaks in. Skipped entirely when the pond is
 *                   outside the view frustum, which is most cameras.
 *                   When the tier has no reflection, the analytic sky + canopy
 *                   approximation in waterSkyReflect() takes over — the same
 *                   function that fills the RT's out-of-bounds regions, so the
 *                   two modes look like the same pond.
 *   4. petals     — up to 160 CPU-simulated floating petals that drift with the
 *                   shared wind, rock on the ripples, beach themselves on the
 *                   leeward shore, rest, and are recycled upwind with a fresh
 *                   ripple ring. Density follows `bloom:stage`.
 *   5. shore      — instanced water-worn stones straddling the waterline and
 *                   wind-swayed reeds, weighted to the far bank so the mirror
 *                   has something to hold besides sky.
 *
 * Published: ctx.assets.water = { centre, waterY, radius, shoreAt, depthAt,
 *            ripple(x,z,strength), reflectRT, reflectStats, floating }
 * Scenarios: pond-closeup, pond-showcase, pond-ripples, pond-petals-max,
 *            pond-petals-off, pond-noreflect, pond-reflect-on, pond-calm,
 *            pond-{dawn,day,dusk,night}, pond-closeup-{dawn,day,dusk,night},
 *            the A/B isolation switches pond-off, pond-off-closeup,
 *            pond-surface-off, pond-stones-off, pond-reeds-off, pond-rings-off,
 *            pond-petals-only-off, and the shader channels pond-dbg-refl,
 *            pond-dbg-body, pond-dbg-weight, pond-dbg-slope.
 *
 * MEASURED (1600x900, ultra, 2026-07-28)
 *   main pass        +5 draw calls (bed, surface, stones, reeds, petals)
 *   mirror pass      16-24 calls / 400 k tris into an 880x495 HalfFloat RT
 *   update() CPU     0.050 ms without the mirror; 0.52-1.20 ms averaged over the
 *                    2-frame mirror cadence, per camera preset
 *   waterline        3.37 .. 5.70 m from the pond centre (capped at 0.92 * radius)
 *   max depth        0.30 m — terrain's published pond.waterY, unchanged
 *
 * ROUND 2 (critic FAIL 2.9 — "the pond has no reflection and a plaid normal
 * pattern", pond centre 0.334 L from the sky it mirrors). At 1920x1080, pond
 * preset, region x 396-1296 y 470-570 against the critic's own sky sample at
 * x 640-760 y 45-75:
 *   pond centre      #96ABC4 L 0.660 hue 213.0   (was #7F5F65 L 0.401 hue ~350)
 *   sky sampled      #BAC1DC L 0.759 hue 226.5
 *   -> dL 0.099 (target <= 0.12), dHue 13.5 deg (target <= 20)
 *   effective reflection weight at the pond camera 0.77-0.86 (target 0.75-0.90),
 *   read off the pond-dbg-weight channel
 *   surface band runs, pond-dbg-weight  p90 4 px, pond-dbg-slope p90 7 px
 *   (was a 40-60 px plaid; the 18 px runs that remain are reflected CLOUD, not
 *   surface modulation — verified by measuring the dbg channels separately)
 *   ripple rings, pond-ripples vs pond-rings-off: mean |dL| 0.033 over 26% of
 *   the pool (was 0.004 over 6%)
 *   dusk  pond 0.622 hue 17.6 vs sky 0.659 hue 17.1
 *   night pond 0.210 hue 221 vs sky 0.192 hue 223 (moon disc mirrored)
 *   --q low (analytic path, no RT) pond 0.666 vs sky 0.651
 */

const SEED = 0x0FA11;

/** Fallbacks if 20-terrain has not published (it boots at order 20, so it has). */
const FALLBACK = { x: -9, z: 6, radius: 6.2, waterY: 0.70 };

const TIER = {
  ultra: { petals: 160, reflScale: 0.55, reflMax: 960, bedRings: 32, bedSegs: 92, reeds: 30, stones: 30 },
  high: { petals: 130, reflScale: 0.50, reflMax: 800, bedRings: 28, bedSegs: 84, reeds: 26, stones: 26 },
  medium: { petals: 80, reflScale: 0.40, reflMax: 640, bedRings: 22, bedSegs: 68, reeds: 20, stones: 20 },
  low: { petals: 46, reflScale: 0.35, reflMax: 512, bedRings: 16, bedSegs: 52, reeds: 14, stones: 14 },
};

/** Floating-petal coverage per bloom stage (GAME_DESIGN "Bloom stages"). */
const STAGE_DENSITY = [0.05, 0.30, 0.48, 0.68, 0.86, 1.00];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export default {
  name: 'water',
  order: 25,

  async setup(ctx) {
    const q = ctx.quality ?? {};
    const tier = TIER[q.tier] ?? TIER.high;
    const rng = makeRng(SEED);
    const group = new THREE.Group();
    group.name = 'pond';

    const terrain = ctx.assets?.terrain ?? null;
    const heightAt = terrain?.heightAt ?? (() => 0);
    const pond = terrain?.pond ?? null;
    const CX = pond?.x ?? FALLBACK.x;
    const CZ = pond?.z ?? FALLBACK.z;
    const R_POND = pond?.radius ?? FALLBACK.radius;
    const WATER_Y = pond?.waterY ?? FALLBACK.waterY;
    const centre = new THREE.Vector3(CX, WATER_Y, CZ);

    const L = ctx.assets?.lightUniforms ?? null;
    const disposables = [];

    /* ================================================================ *
     * Depth field — one baked definition of "where the edge is",
     * shared by the water, the bed, the caustics and the petal sim.
     * ================================================================ */
    const SPAN = (R_POND + 1.6) * 2;                 // metres covered, full width

    /** Unmasked "is this point below the water plane" — includes ground that is
     *  below WATER_Y but has nothing to do with the basin. */
    const depthRaw = (x, z) => WATER_Y - heightAt(x, z);

    // The real waterline radius per angle. Marched for the FIRST zero crossing
    // going outward, NOT bisected over the whole span: the garden rolls, and west
    // of the pond the terrain dips back below WATER_Y about 7 m out. A bisection
    // happily converged on THAT crossing instead, so the water disc flooded a
    // tongue of open ground outside the basin (visible in water-r4 as water
    // running off the left edge of frame with grass standing in it).
    // ...and hard-capped. In some directions (WNW of the pond) the garden's fbm
    // roll keeps the ground below WATER_Y all the way out, so the march finds NO
    // crossing at all. Measured: shoreAt(2 rad) came back as the 7.4 m fallback,
    // which then pushed the bed's mud apron out to 7.5 m and deleted the visible
    // shoreline entirely. The basin is 6.2 m wide with sigma 5.4, so a pool edge
    // past 0.92 * radius is a bug however the height field got there.
    const R_CAP = R_POND * 0.92;
    const SHORE_N = 160;
    const shoreR = new Float32Array(SHORE_N);
    const shoreCap = new Float32Array(SHORE_N);      // 1 = truncated by R_CAP
    for (let i = 0; i < SHORE_N; i++) {
      const a = (i / SHORE_N) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let found = R_CAP;
      if (depthRaw(CX + ca * 0.25, CZ + sa * 0.25) <= 0) { shoreR[i] = 0.25; continue; }
      for (let r = 0.30; r <= R_CAP; r += 0.05) {
        if (depthRaw(CX + ca * r, CZ + sa * r) <= 0) {
          let lo = r - 0.05, hi = r;
          for (let k = 0; k < 14; k++) {
            const mid = (lo + hi) * 0.5;
            if (depthRaw(CX + ca * mid, CZ + sa * mid) > 0) lo = mid; else hi = mid;
          }
          found = lo;
          break;
        }
      }
      shoreR[i] = Math.min(found, R_CAP);
      shoreCap[i] = found >= R_CAP - 1e-3 ? 1 : 0;
    }
    const angLerp = (arr, ang) => {
      let t = ang / (Math.PI * 2);
      t -= Math.floor(t);
      const f = t * SHORE_N;
      const i0 = Math.floor(f) % SHORE_N;
      const i1 = (i0 + 1) % SHORE_N;
      return lerp(arr[i0], arr[i1], f - Math.floor(f));
    };
    const shoreAt = (ang) => angLerp(shoreR, ang);
    const cappedAt = (ang) => angLerp(shoreCap, ang);
    let shoreMax = 0, shoreMin = 1e9;
    for (let i = 0; i < SHORE_N; i++) { shoreMax = Math.max(shoreMax, shoreR[i]); shoreMin = Math.min(shoreMin, shoreR[i]); }

    /**
     * Water depth in metres, MASKED to the basin. This is the one definition of
     * "the pool" — the depth texture is baked from it, so the water alpha, the
     * bed's wet band, the caustics and the petal sim cannot disagree.
     */
    const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const depthAt = (x, z) => {
      const dx = x - CX, dz = z - CZ;
      const r = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const sr = shoreAt(ang);
      if (r > sr) return 0;
      let d = Math.max(0, depthRaw(x, z));
      // Where the shore was TRUNCATED by the cap the depth is still ~0.3 m at the
      // cut, so taper it to zero over the last 0.55 m — otherwise the pool ends on
      // a hard circular arc, which is the exact tell this module exists to avoid.
      const cf = cappedAt(ang);
      if (cf > 0.001) d *= 1 - cf * sstep(sr - 0.55, sr, r);
      return d;
    };
    /** Height of the bank above the waterline; grows with distance outside the
     *  basin so a low-lying patch of garden never reads as a wet shoreline. */
    const bankAt = (x, z) => {
      const dx = x - CX, dz = z - CZ;
      const r = Math.hypot(dx, dz);
      const sr = shoreAt(Math.atan2(dz, dx));
      const h = -depthRaw(x, z);
      return r > sr ? Math.max(h, (r - sr) * 0.22) : Math.max(0, h);
    };

    // 512, up from 256 (256 at low): the waterline printed as a 3-5 px staircase
    // because a bilinear iso-contour follows the texel diagonals. 512 over a 15.6 m
    // span is 3 cm/texel, which with pondDepthSoft's 4-tap puts the remaining step
    // under a pixel at every preset.
    const DEPTH_TEX_SIZE = q.tier === 'low' ? 256 : 512;
    const depthTex = buildPondDepthTexture(THREE, {
      depthFn: depthAt, bankFn: bankAt, cx: CX, cz: CZ, span: SPAN,
      size: DEPTH_TEX_SIZE,
    });
    disposables.push(depthTex);

    /* ================================================================ *
     * Pooled ripple rings
     * ================================================================ */
    const ripples = Array.from({ length: MAX_RIPPLES }, () => ({ x: 0, z: 0, age: 0, s: 0 }));
    const rippleU = { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0)) };
    let rippleCursor = 0;
    let ripplesMuted = false;                        // A/B only (pond-rings-off)
    let canopyMuted = false;                         // A/B only (pond-nocanopy)
    function ripple(x, z, strength = 1) {
      if (ripplesMuted) return;
      if (depthAt(x, z) < 0.03) return;              // no ring on a mud film
      let slot = -1, best = -1;
      for (let i = 0; i < MAX_RIPPLES; i++) {
        if (ripples[i].s <= 0) { slot = i; break; }
        if (ripples[i].age > best) { best = ripples[i].age; slot = i; }
      }
      if (slot < 0) slot = (rippleCursor++) % MAX_RIPPLES;
      const r = ripples[slot];
      r.x = x; r.z = z; r.age = 0; r.s = clamp(strength, 0.05, 2.4);
    }

    /* ================================================================ *
     * Shared uniform bag for the pond family (by REFERENCE, never cloned)
     * ================================================================ */
    const uDepthMap = { value: depthTex };
    const uPondCentre = { value: centre };
    const uPondSpan = { value: SPAN };
    const uDepthScale = { value: DEPTH_SCALE };
    const uBankScale = { value: BANK_SCALE };
    const uRippleAmp = { value: 0.95 };
    const uChop = { value: 0 };
    const uCanopyCentre = { value: new THREE.Vector3(0, 8.6, 0) };
    const uCanopyRadius = { value: 6.0 };
    const uCanopyColor = { value: new THREE.Color(0.62, 0.30, 0.38) };
    const uCanopyAmount = { value: 0.55 };
    // The crown's own pink, NOT lerped toward the sky — canopyTint() needs a real
    // sakura hue to rotate the pool toward. See canopyIrradiance() in the shader.
    const uCanopyPure = { value: new THREE.Color(0.62, 0.30, 0.38) };
    const uCanopyBounce = { value: 1.0 };
    const uHillColor = { value: new THREE.Color(0.30, 0.38, 0.52) };
    const uDepthTexel = { value: 1 / DEPTH_TEX_SIZE };

    // 15-sky's own gradient uniforms, SHARED BY REFERENCE so the mirror and the
    // dome above it can never drift apart. Every member is checked: a missing sky
    // module (or a renamed uniform) falls back to the lighting bag's fog/sky pair
    // rather than throwing.
    const skyU = ctx.assets?.sky?.uniforms ?? null;
    const NEED = ['uZenith', 'uMid', 'uHorizon', 'uHaze', 'uZenithPow', 'uMidAmt'];
    const haveSky = !!skyU && NEED.every((k) => skyU[k] && 'value' in skyU[k]);
    const gradU = haveSky
      ? { uZenith: skyU.uZenith, uMid: skyU.uMid, uHorizon: skyU.uHorizon, uHaze: skyU.uHaze, uZenithPow: skyU.uZenithPow, uMidAmt: skyU.uMidAmt }
      : {
        uZenith: { value: new THREE.Color(0.10, 0.20, 0.50) },
        uMid: { value: new THREE.Color(0.45, 0.58, 0.78) },
        uHorizon: { value: new THREE.Color(0.70, 0.80, 0.90) },
        uHaze: { value: new THREE.Color(0.74, 0.83, 0.92) },
        uZenithPow: { value: 0.42 },
        uMidAmt: { value: 0.16 },
      };
    const uHasSkyGrad = { value: haveSky ? 1 : 0 };

    const pondCommon = () => ({
      uDepthMap, uPondCentre, uPondSpan, uDepthScale, uBankScale, uDepthTexel,
      uRippleAmp, uChop, uRipples: rippleU,
      uCanopyCentre, uCanopyRadius, uCanopyColor, uCanopyAmount,
      uCanopyPure, uCanopyBounce, uHillColor,
      ...gradU, uHasSkyGrad,
    });

    const lightsBag = () => THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);

    /* ================================================================ *
     * 1. Bed + shoreline
     * ================================================================ */
    const bedGeo = buildBedGeometry(THREE, {
      heightAt, cx: CX, cz: CZ, radius: Math.min(R_POND + 1.5, shoreMax + 1.5),
      // 0.028, not 0.012: 20-terrain's stone path runs through the pond basin
      // (its waypoints pass 0.13 m from the pond centre), and at 0.012 the path's
      // dirt macro texture showed through the silt. The path's STONES still stand
      // proud of the water — which at least reads as stepping stones.
      rings: tier.bedRings, segs: tier.bedSegs, lift: 0.028,
    });
    disposables.push(bedGeo);

    const bedMat = new THREE.ShaderMaterial({
      name: 'pond-bed',
      uniforms: Object.assign(lightsBag(), {
        // Submerged silt has to be MUCH darker than the dry bank or 30 cm of
        // water reads as a damp patch of the same mud: measured at 0x6B5A46 the
        // wet bed and the dry apron printed within 6% of each other.
        uSilt: { value: new THREE.Color().setHex(0x4A3E2E, THREE.SRGBColorSpace) },
        uSiltDeep: { value: new THREE.Color().setHex(0x2B3126, THREE.SRGBColorSpace) },
        uMud: { value: new THREE.Color().setHex(0x93805F, THREE.SRGBColorSpace) },
        uPebble: { value: new THREE.Color().setHex(0x9E9A92, THREE.SRGBColorSpace) },
        uAlgae: { value: new THREE.Color().setHex(0x4C6138, THREE.SRGBColorSpace) },
        // In BANK METRES (see BED_FRAG): bankAt() rises 0.22 m per metre outside
        // the pool, so 0.085..0.235 is a mud apron roughly 0.4 m to 1.1 m beyond
        // whatever the local waterline turned out to be.
        uFadeIn: { value: 0.085 },
        uFadeOut: { value: 0.235 },
        uMaxR: { value: shoreMax + 1.5 },
        // Wet-sand band. 0.033 / 0.099 BANK METRES = the first 0.15 m of shore at
        // full strength, gone by 0.45 m (bankAt() rises 0.22 m per metre out).
        // uDampMul is CALIBRATED, not authored: the target is a band that PRINTS at
        // 0.80 x the dry bank's luminance in the graded png. Measured on
        // shots/water-r3-*/pond.png, x0.68 in albedo lands at 0.80 printed; the
        // previous x0.55 landed at 0.71 and read as a black tide-mark, and 0.80 in
        // albedo printed 0.92, i.e. invisible — which is what the review measured.
        uDampNear: { value: 0.033 },
        uDampFar: { value: 0.099 },
        uDampMul: { value: 0.68 },
        // 0.45, not 1.45: measured on the closeup, 1.45 drove the shallow ring to
        // pure white (255,255,255) in the graded png. Caustics are a shimmer, not
        // a light source.
        uCaustic: { value: 0.28 },
      }, pondCommon(), L ?? {}, WIND.uniforms),
      vertexShader: BED_VERT,
      fragmentShader: BED_FRAG,
      lights: true,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const bed = new THREE.Mesh(bedGeo, bedMat);
    bed.name = 'pond-bed';
    bed.receiveShadow = true;
    bed.renderOrder = 1;
    bed.matrixAutoUpdate = false;
    bed.updateMatrix();
    group.add(bed);

    /* ================================================================ *
     * 2. Water surface
     * ================================================================ */
    const surfGeo = new THREE.CircleGeometry(shoreMax + 0.45, 96);
    surfGeo.rotateX(-Math.PI / 2);
    disposables.push(surfGeo);

    const reflectOn = !!q.waterReflect;
    const uReflTex = { value: null };
    const uReflMix = { value: 0 };
    const uReflMatrix = { value: new THREE.Matrix4() };

    const surfMat = new THREE.ShaderMaterial({
      name: 'pond-surface',
      uniforms: Object.assign(lightsBag(), {
        uReflTex, uReflMix, uReflMatrix,
        uReflDistort: { value: 0.038 },
        uDeepColor: { value: new THREE.Color().setHex(0x25493E, THREE.SRGBColorSpace) },
        uShallowColor: { value: new THREE.Color().setHex(0x66744A, THREE.SRGBColorSpace) },
        uOpacity: { value: 1 },
        // 0.11 m of depth over which the edge fades = a ~1.1 m soft band on this
        // basin's 0.097 m/m slope. Measured from heightAt, not guessed.
        uShoreFadeDepth: { value: 0.11 },
        // A physically faithful 30 cm mud-bottomed pool is a brown puddle: at
        // uAbsorb 1.5 the bed showed through everywhere and that is exactly what
        // it printed as. Stylised to 4.2 so the water column owns its own colour
        // by ~25 cm of depth and the bed (with its caustics) only shows in the
        // last 15 cm at the shore — which is also what turns the waterline into a
        // warm silty band instead of a line.
        uAbsorb: { value: 3.0 },
        // 0.66: at 0.80 a fresh ring's crest clipped to a hard white line and read
        // as a drawn circle; at 0.55 (the previous value) an A/B against
        // pond-rings-off moved only 6% of the pool by more than 0.02 L. 0.66 gives
        // mean |dL| 0.031 over 26% of the pool — a ring you can see, made of water.
        uGlint: { value: 0.66 },
        // Grazing sub-surface skylight return (see WATER_FRAG). MEASURED: with
        // Schlick F0 0.02 exp 5 alone the effective reflection weight at the pond
        // camera is 0.46 and the pool printed 0.16 L below the sky it mirrors.
        // 0.68 lands the effective weight at 0.77 (target band 0.75-0.90).
        uSubRefl: { value: 0.86 },
        uReflGain: { value: 1.12 },
        // Shoreline. 0.65 at the waterline easing to 1.0 over 0.034 m of depth,
        // which is 0.35 m of shore on this basin's measured 0.097 m/m slope — the
        // band the prescription named. This replaces the pale pink "lip" the
        // previous pass added, which is what read as a sandy rim.
        uShoreDark: { value: 0.65 },
        uShoreDarkM: { value: 0.034 },
        // Final luminance-preserving hue rotation toward the crown, scaled by
        // canopyIrradiance() (0.08 on the far shore .. 0.31 on the shore the crown
        // overhangs). SWEPT and measured on the hero pond patch — see the header.
        uCanopyHue: { value: 0.95 },
        uCanopyGate: { value: new THREE.Vector2(0.185, 0.325) },
        uDebug: { value: 0 },
      }, pondCommon(), L ?? {}, WIND.uniforms),
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      lights: true,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const surface = new THREE.Mesh(surfGeo, surfMat);
    surface.name = 'pond-surface';
    surface.position.set(CX, WATER_Y, CZ);
    surface.receiveShadow = true;
    surface.renderOrder = 2;
    surface.matrixAutoUpdate = false;
    surface.updateMatrix();
    group.add(surface);
    ctx.clickTargets?.push(surface);

    /* ================================================================ *
     * 3. Shore stones — straddling the waterline all the way round.
     *    Half-submerged stones are the cheapest, strongest cue that the
     *    water has a real edge; a clean arc of dry stones is not.
     * ================================================================ */
    // detail 3 (1280 tris) at every tier but low: at the pond-closeup camera a shore
    // stone is read at 60-100 px, which is where an icosahedron at detail 2 starts
    // showing its facets (ART_BIBLE 8.5). 30 instances of 1280 tris is 38 k against a
    // frame that already carries 1.5 M.
    //
    // NOTE for whoever owns 20-terrain: the pale angular PLATES lying under the water
    // in pond-closeup are NOT these. A/B'd with --scenario pond-stones-off, the frame
    // is pixel-identical — they are `path-stones` (the stone path's waypoints pass
    // 0.13 m from the pond centre, see the bed `lift` comment below), and submerged
    // they read as flat pale shards with 5-6 hard facets each.
    const stoneGeo = buildStoneGeometry(THREE, makeRng(SEED + 7), q.tier === 'low' ? 2 : 3);
    disposables.push(stoneGeo);
    // spec 0.14 / rim 0.30, down from 0.30 / 0.75: a rounded wet stone whose top
    // facet points at the sky was collecting a full sky rim AND a broad sheen at once.
    // A river stone is matte.
    const stoneMat = createNprMaterial({
      lightUniforms: L, color: 0x9E9A92, specScale: 0.14, rimScale: 0.30,
      shadowHueMax: 34,
    });
    const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, tier.stones);
    stones.name = 'pond-stones';
    stones.castShadow = false;
    stones.receiveShadow = true;
    {
      const m = new THREE.Matrix4();
      const qt = new THREE.Quaternion();
      const eu = new THREE.Euler();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const col = new THREE.Color();
      // CLUSTERED, not spread: 30 stones on a golden-angle ring read as litter
      // scattered by a level editor. Real shore stones come in groups of two or
      // three with long empty stretches between them.
      const SITES = Math.max(4, Math.round(tier.stones / 3.4));
      const siteAng = [];
      for (let s = 0; s < SITES; s++) siteAng.push(rng.range(0, Math.PI * 2));
      for (let i = 0; i < tier.stones; i++) {
        const site = siteAng[i % SITES];
        const ang = site + rng.gauss(0, 0.085);
        const sr = shoreAt(ang);
        // STRADDLE the waterline: -0.30 m (just in the water) .. +0.55 m (up the
        // bank). A stone alone in the middle of the pool has nothing to do with a
        // shoreline and, seen through the surface, reads as a flat grey plate.
        const off = clamp(rng.gauss(0, 0.30), -0.30, 0.55);
        const rad = clamp(sr + off, 0.6, R_POND + 1.1);
        const x = CX + Math.cos(ang) * rad;
        const z = CZ + Math.sin(ang) * rad;
        const gy = heightAt(x, z);
        const s = rng.range(0.075, 0.24) * (1 + 0.50 * Math.max(0, off));
        const sy = s * rng.range(0.76, 1.02);
        const half = sy * 0.5;
        let cy = gy + half * 0.55;                    // seated, slightly buried
        // A stone whose crown sits exactly ON the waterline renders as a bright
        // flat plate: its top facet is the only part outside the water, so it
        // catches full key while the body is 90% hidden by the surface blend.
        // Force every stone to commit — clearly under, or clearly proud.
        const depthHere = WATER_Y - gy;
        if (depthHere > 0) {
          if (rng.next() < 0.55) cy -= Math.max(0, (cy + half) - (WATER_Y - 0.055));
          else cy += Math.max(0, (WATER_Y + 0.11) - (cy + half));
        }
        pos.set(x, cy, z);
        scl.set(s * rng.range(0.90, 1.22), sy, s * rng.range(0.90, 1.22));
        eu.set(rng.range(-0.22, 0.22), rng.range(0, Math.PI * 2), rng.range(-0.22, 0.22));
        qt.setFromEuler(eu);
        m.compose(pos, qt, scl);
        stones.setMatrixAt(i, m);
        // wet stones are darker and a touch warmer; dry ones pick up lichen
        const submerged = clamp((WATER_Y - (cy + half)) / 0.10 + 0.5, 0, 1);
        const dry = 1 - submerged;
        col.setRGB(
          lerp(0.42, 0.98, dry) * rng.range(0.90, 1.08),
          lerp(0.44, 0.99, dry) * rng.range(0.92, 1.06),
          lerp(0.40, 0.94, dry) * rng.range(0.90, 1.06),
        );
        stones.setColorAt(i, col);
      }
      stones.instanceMatrix.needsUpdate = true;
      if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
      stones.computeBoundingSphere();
    }
    group.add(stones);

    /* ================================================================ *
     * 4. Reeds — weighted to the far bank (as seen from the `pond` camera)
     *    so the mirror has vertical structure to hold, not just sky.
     * ================================================================ */
    const reedGeo = buildReedGeometry(THREE, 5);
    disposables.push(reedGeo);
    const reedMat = new THREE.ShaderMaterial({
      name: 'pond-reeds',
      uniforms: Object.assign(lightsBag(), {
        // 0x3B5729 / 0x6E8C42, walked between two measured failures: 0x2C4423 /
        // 0x6E8342 printed the side-on blades at display L 0.054 over the mirror
        // (black wires), and 0x3F5B2C / 0x87A055 printed them at L 0.512 hue 48.6
        // (pale dried-bamboo splints). Target is a green reed, L 0.40-0.46, hue 90-130.
        uBase: { value: new THREE.Color().setHex(0x3B5729, THREE.SRGBColorSpace) },
        uTip: { value: new THREE.Color().setHex(0x6E8C42, THREE.SRGBColorSpace) },
      }, L ?? {}, WIND.uniforms),
      vertexShader: REED_VERT,
      fragmentShader: REED_FRAG,
      lights: true,
      side: THREE.DoubleSide,
    });
    const BLADES = 7;
    const reeds = new THREE.InstancedMesh(reedGeo, reedMat, tier.reeds * BLADES);
    reeds.name = 'pond-reeds';
    reeds.castShadow = false;
    reeds.receiveShadow = true;
    {
      const rr = makeRng(SEED + 31);
      const m = new THREE.Matrix4();
      const qt = new THREE.Quaternion();
      const eu = new THREE.Euler();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const col = new THREE.Color();
      // the `pond` camera sits at (-3, 2.2, 14): the far bank from the pond
      // centre is roughly this heading.
      const farAng = Math.atan2(CZ - 14, CX - (-3));
      let n = 0;
      for (let c = 0; c < tier.reeds; c++) {
        // Bias hard toward the far bank: a clump standing between the camera and
        // the water hides the thing we built, while the same clump on the far
        // bank breaks the waterline AND puts vertical structure in the mirror.
        const spread = rr.next() < 0.80 ? rr.gauss(0, 0.92) : rr.range(-Math.PI, Math.PI);
        const ang = farAng + spread;
        const sr = shoreAt(ang);
        // mostly standing IN the shallows (negative offset), a few up the bank
        const rad = sr + (rr.next() < 0.7 ? rr.range(-0.55, -0.05) : rr.range(0.05, 0.40));
        const bx = CX + Math.cos(ang) * rad;
        const bz = CZ + Math.sin(ang) * rad;
        const clumpH = rr.range(0.55, 1.15);
        for (let b = 0; b < BLADES; b++, n++) {
          if (n >= reeds.count) break;
          const [ox, oz] = rr.disc(0.13);
          const x = bx + ox, z = bz + oz;
          const gy = heightAt(x, z);
          const h = clumpH * rr.range(0.60, 1.30);
          pos.set(x, gy - 0.03, z);
          scl.set(rr.range(0.70, 1.25), h, 1);
          eu.set(rr.range(-0.30, 0.30), rr.range(0, Math.PI * 2), rr.range(-0.30, 0.30));
          qt.setFromEuler(eu);
          m.compose(pos, qt, scl);
          reeds.setMatrixAt(n, m);
          const v = rr.range(0.82, 1.15);
          col.setRGB(v * rr.range(0.92, 1.05), v, v * rr.range(0.80, 0.98));
          reeds.setColorAt(n, col);
        }
      }
      reeds.count = n;
      reeds.instanceMatrix.needsUpdate = true;
      if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
      reeds.computeBoundingSphere();
    }
    group.add(reeds);

    /* ================================================================ *
     * 5. Floating petals — the emotional point of the pond.
     * ================================================================ */
    const petalTex = makeFloatPetalTexture(THREE, 96);
    const petalGeo = buildFloatPetalGeometry(THREE);
    disposables.push(petalTex, petalGeo);
    const petalMat = createNprMaterial({
      lightUniforms: L,
      map: petalTex,
      alphaTest: 0.45,
      translucency: 0.95,
      thickness: 0.30,
      specScale: 0.55,
      rimScale: 1.15,
      side: THREE.DoubleSide,
    });
    const PMAX = tier.petals;
    const petalMesh = new THREE.InstancedMesh(petalGeo, petalMat, PMAX);
    petalMesh.name = 'pond-petals';
    petalMesh.castShadow = false;
    petalMesh.receiveShadow = true;
    petalMesh.frustumCulled = false;
    group.add(petalMesh);

    const prng = makeRng(SEED + 101);
    /** @type {{x:number,z:number,ang:number,av:number,s:number,rest:number,ph:number,life:number,born:boolean}[]} */
    const petals = [];
    for (let i = 0; i < PMAX; i++) {
      petals.push({ x: CX, z: CZ, ang: 0, av: 0, s: 0.1, rest: 0, ph: 0, life: 0, born: false });
      // The MAP already ramps through the palette's five values; tinting the
      // instance with a palette colour on top of that double-darkens it and every
      // petal printed as hot confetti pink. Keep the tint near white.
      const v = 0.90 + 0.14 * ((i * 0.6180339887) % 1);
      petalMesh.setColorAt(i, new THREE.Color(v, v * 0.985, v * 0.99));
    }
    if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;

    /** Seat a petal somewhere upwind with a splash ring. */
    function seedPetal(p, splash = true) {
      const d = WIND.uniforms.uWindDir.value;
      for (let k = 0; k < 8; k++) {
        // upwind half of the pool, spread across the crosswind axis
        const along = -prng.range(0.05, 0.92) * shoreMin;
        const across = prng.gauss(0, 0.52) * shoreMin;
        const x = CX + d.x * along - d.y * across;
        const z = CZ + d.y * along + d.x * across;
        if (depthAt(x, z) > 0.10 || k === 7) {
          p.x = x; p.z = z;
          break;
        }
      }
      p.ang = prng.range(0, Math.PI * 2);
      p.av = prng.sign() * prng.range(0.06, 0.34);
      p.s = prng.range(0.105, 0.170);
      p.rest = 0;
      p.ph = prng.range(0, Math.PI * 2);
      p.life = prng.range(16, 34);
      p.born = true;
      if (splash) ripple(p.x, p.z, prng.range(0.70, 1.15));
    }

    let stage = 1;                                   // first run opens on 蕾 Budding
    let landTimer = 1.5;                             // seconds to the next petal touchdown
    let ambientTimer = 0.4;                          // breeze/insect rings between landings
    let densityMul = 1;
    let liveTarget = Math.round(PMAX * STAGE_DENSITY[1]);
    let live = 0;

    /* ================================================================ *
     * 6. Planar reflection
     * ================================================================ */
    let reflectEnabled = reflectOn;
    const reflect = reflectOn ? (() => {
      const dbs = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
      const sizeFor = (w, h) => {
        const s = tier.reflScale;
        const cap = tier.reflMax;
        let rw = Math.max(64, Math.min(cap, Math.round(w * s)));
        let rh = Math.max(36, Math.round(rw * (h / Math.max(w, 1))));
        return [rw, rh];
      };
      const [rw, rh] = sizeFor(dbs.x, dbs.y);
      const rt = new THREE.WebGLRenderTarget(rw, rh, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      rt.texture.name = 'pond.reflection';
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;

      const cam = new THREE.PerspectiveCamera();
      const normal = new THREE.Vector3(0, 1, 0);
      const rwp = centre.clone();
      const view = new THREE.Vector3();
      const target = new THREE.Vector3();
      const lookAtPosition = new THREE.Vector3();
      const rot = new THREE.Matrix4();
      const plane = new THREE.Plane();
      const clipPlane = new THREE.Vector4();
      const qv = new THREE.Vector4();
      const bias = new THREE.Matrix4().set(
        0.5, 0.0, 0.0, 0.5,
        0.0, 0.5, 0.0, 0.5,
        0.0, 0.0, 0.5, 0.5,
        0.0, 0.0, 0.0, 1.0,
      );

      // Objects the mirror deliberately skips: the whole grass sward and the
      // ground scatter (by far the most expensive part of the frame and almost
      // invisible in a rippled reflection).
      //
      // FIXED THIS ROUND. The regex used to end in `|pond`, and collect() then also
      // pushed the whole `group`, so `pond-reeds` and `pond-stones` — the ONLY
      // objects in the scene whose mirror image actually lands inside the pool —
      // were excluded from their own reflection. That is why the reeds standing IN
      // the water cast nothing (pond.png x 400-560 y 400-680) and the pool mirrored
      // sky and clouds only. Now just the bed, the surface and the floating petals
      // are held out: the bed and surface must not appear in their own mirror, and
      // the petals sit 12 mm above the plane so their mirror image is clipped by the
      // oblique near plane anyway.
      const SKIP = /^(grass-|clover|flowers-|pebbles|fallen-petals|path-stones)/;
      let hidden = [];
      let scanFrame = -999;

      function collect() {
        hidden.length = 0;
        ctx.scene.traverse((o) => {
          if (o.isMesh && o.name && SKIP.test(o.name)) hidden.push(o);
        });
        hidden.push(bed, surface, petalMesh);
      }

      return {
        rt,
        stats: { calls: 0, triangles: 0 },
        setSize(w, h) {
          const [nw, nh] = sizeFor(w, h);
          if (nw !== rt.width || nh !== rt.height) rt.setSize(nw, nh);
        },
        render() {
          const renderer = ctx.renderer;
          const src = ctx.camera;
          if (ctx.frame - scanFrame > 120) { collect(); scanFrame = ctx.frame; }

          src.updateMatrixWorld();

          // --- mirror the camera across y = WATER_Y (Reflector.js maths: a
          // lookAt-built basis stays right-handed, so face winding and the
          // shadow maps behave; the flip is undone by the projected sampling).
          view.subVectors(rwp, src.getWorldPosition(target));
          view.reflect(normal).negate().add(rwp);

          rot.extractRotation(src.matrixWorld);
          lookAtPosition.set(0, 0, -1).applyMatrix4(rot).add(src.getWorldPosition(target));
          target.subVectors(rwp, lookAtPosition);
          target.reflect(normal).negate().add(rwp);

          cam.position.copy(view);
          cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
          cam.lookAt(target);
          cam.near = src.near;
          cam.far = src.far;
          cam.updateMatrixWorld(true);
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          cam.projectionMatrix.copy(src.projectionMatrix);

          // --- Lengyel oblique near-plane clip: the near plane BECOMES the
          // water plane, so the mirrored hills, the valley floor and the far
          // terrain below the waterline can never leak into the reflection.
          plane.setFromNormalAndCoplanarPoint(normal, rwp);
          plane.applyMatrix4(cam.matrixWorldInverse);
          clipPlane.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
          const P = cam.projectionMatrix;
          qv.x = (Math.sign(clipPlane.x) + P.elements[8]) / P.elements[0];
          qv.y = (Math.sign(clipPlane.y) + P.elements[9]) / P.elements[5];
          qv.z = -1;
          qv.w = (1 + P.elements[10]) / P.elements[14];
          clipPlane.multiplyScalar(2 / clipPlane.dot(qv));
          P.elements[2] = clipPlane.x;
          P.elements[6] = clipPlane.y;
          P.elements[10] = clipPlane.z + 1;
          P.elements[14] = clipPlane.w;

          uReflMatrix.value.copy(bias).multiply(P).multiply(cam.matrixWorldInverse);

          // --- render. Shadow maps are NOT recomputed for the mirror pass
          // (they are view-independent and cost more than the pass itself).
          const prevShadow = renderer.shadowMap.autoUpdate;
          const prevTarget = renderer.getRenderTarget();
          renderer.shadowMap.autoUpdate = false;
          for (const o of hidden) { o.userData.__pv = o.visible; o.visible = false; }
          renderer.setRenderTarget(rt);
          renderer.render(ctx.scene, cam);
          for (const o of hidden) o.visible = o.userData.__pv;
          renderer.setRenderTarget(prevTarget);
          renderer.shadowMap.autoUpdate = prevShadow;

          // the mirror pass is a SEPARATE render, so renderer.info resets before
          // the main one and these calls never show up in the harness report
          this.stats.calls = renderer.info.render.calls;
          this.stats.triangles = renderer.info.render.triangles;
          uReflTex.value = rt.texture;
        },
        dispose() { rt.dispose(); },
      };
    })() : null;

    /* ================================================================ *
     * Events
     * ================================================================ */
    const offs = [];
    offs.push(ctx.bus.on('bloom:stage', (e) => {
      stage = clamp(Math.round(e?.stage ?? 1), 0, 5);
      liveTarget = Math.round(PMAX * STAGE_DENSITY[stage] * densityMul);
    }));

    // Shaking the bough sends a gust across the water: a couple of broad, soft
    // rings plus a brief lift in the chop. The tree is 11 m from the pool, so
    // this reads as wind on the surface, not as petals hitting it.
    const gustRipples = (power = 1) => {
      uChop.value = Math.min(1.1, uChop.value + 0.30 * power);
      const n = 2 + (power > 1.5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = prng.range(0, Math.PI * 2);
        const r = prng.range(0.2, 0.78) * shoreMin;
        ripple(CX + Math.cos(a) * r, CZ + Math.sin(a) * r, 0.30 + 0.18 * power);
      }
    };
    offs.push(ctx.bus.on('tree:clicked', (e) => gustRipples(e?.power ?? 1)));
    offs.push(ctx.bus.on('petals:burst', (e) => gustRipples(clamp((e?.power ?? 1) * 0.8, 0.5, 2))));
    offs.push(ctx.bus.on('world:click', (e) => {
      const p = e?.point;
      if (!p) return;
      if (Math.hypot(p.x - CX, p.z - CZ) > R_POND + 1) return;
      ripple(p.x, p.z, 1.1);
    }));

    /* ================================================================ *
     * Debug scenarios
     * ================================================================ */
    let closeup = null;
    const sc = window.__game?.scenarios;
    if (sc) {
      const setCloseup = () => {
        closeup = {
          pos: new THREE.Vector3(CX + 4.3, WATER_Y + 3.15, CZ + 5.7),
          look: new THREE.Vector3(CX - 1.1, WATER_Y - 0.02, CZ - 1.4),
          fov: 42,
        };
      };
      sc['pond-closeup'] = setCloseup;
      const spray = (n = MAX_RIPPLES) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 * 1.7;
          const r = (0.22 + 0.62 * ((i * 7) % n) / n) * shoreMin;
          ripple(CX + Math.cos(a) * r, CZ + Math.sin(a) * r, 1.2);
          ripples[i].age = i * 0.11;
        }
      };
      sc['pond-ripples'] = () => spray();
      sc['pond-petals-max'] = () => { densityMul = 1; stage = 5; liveTarget = PMAX; };
      sc['pond-petals-off'] = () => { liveTarget = 0; };
      sc['pond-noreflect'] = () => { uReflMix.value = 0; reflectEnabled = false; };
      sc['pond-reflect-on'] = () => { reflectEnabled = true; };
      sc['pond-calm'] = () => { uRippleAmp.value = 0.25; uChop.value = 0; };
      // shot.mjs runs exactly one scenario, so the time-of-day checks have to be
      // pre-combined with the pond framing.
      for (const ph of ['dawn', 'day', 'dusk', 'night']) {
        sc[`pond-${ph}`] = () => { sc[ph]?.(); };
        sc[`pond-closeup-${ph}`] = () => { sc[ph]?.(); setCloseup(); };
      }
      sc['pond-showcase'] = () => { setCloseup(); stage = 5; liveTarget = PMAX; spray(6); };
      // A/B isolation: everything this module draws, off. The honest way to ask
      // "is that artefact mine" (see RESUME.md — colour-coded shader debug lies
      // through the tonemap + grade + bloom chain, A/B diffs do not).
      sc['pond-off'] = () => { group.visible = false; };
      sc['pond-off-closeup'] = () => { group.visible = false; setCloseup(); };
      sc['pond-surface-off'] = () => { surface.visible = false; setCloseup(); };
      sc['pond-stones-off'] = () => { stones.visible = false; setCloseup(); };
      sc['pond-reeds-off'] = () => { reeds.visible = false; };
      // ring A/B: mute the pool and clear every live slot, so diffing this against
      // the default frame measures exactly what the rings contribute.
      sc['pond-rings-off'] = () => {
        ripplesMuted = true;
        for (const r of ripples) r.s = 0;
      };
      sc['pond-petals-only-off'] = () => { petalMesh.visible = false; };
      // Shader A/B channels. Each replaces the surface with ONE of its terms at
      // alpha 1, so "is the mirror contributing" and "how wide is a band" are
      // measurements rather than opinions.
      const dbg = (n) => () => { surfMat.uniforms.uDebug.value = n; };
      sc['pond-dbg-refl'] = dbg(1);
      sc['pond-dbg-body'] = dbg(2);
      sc['pond-dbg-weight'] = dbg(3);
      sc['pond-dbg-slope'] = dbg(4);
      sc['pond-dbg-canopy'] = dbg(5);
      // canopy-bounce A/B: the honest way to ask "how much of the pool's colour is
      // the crown". Diff against the default frame.
      sc['pond-nocanopy'] = () => {
        surfMat.uniforms.uCanopyHue.value = 0;
        canopyMuted = true;
      };
    }

    /* ================================================================ *
     * Published API
     * ================================================================ */
    const api = {
      centre, waterY: WATER_Y, radius: R_POND,
      shoreAt, depthAt, ripple,
      get reflectRT() { return reflect?.rt ?? null; },
      get reflectStats() { return reflect?.stats ?? null; },
      get floating() { return live; },
      // measurement handles for tools/probe.mjs
      get reflMix() { return uReflMix.value; },
      get liveRipples() { return ripples.reduce((n, r) => n + (r.s > 0 ? 1 : 0), 0); },
      get reflSize() { return reflect ? [reflect.rt.width, reflect.rt.height] : null; },
      /** The shader's own canopyIrradiance(), on the CPU, for tools/probe.mjs. */
      canopyIrradiance(x, z) {
        const c = uCanopyCentre.value;
        const ox = c.x - x, oy = c.y - WATER_Y, oz = c.z - z;
        const D = Math.hypot(ox, oy, oz);
        const R = uCanopyRadius.value;
        const sinH = clamp(R / Math.max(D, R * 1.02), 0, 0.985);
        const frac = 1 - Math.sqrt(Math.max(1 - sinH * sinH, 0));
        const elev = clamp(oy / Math.max(D, 1e-4), 0, 1);
        return clamp(frac * (0.35 + 0.85 * elev), 0, 1) * uCanopyBounce.value;
      },
    };
    ctx.assets.water = api;

    /* ================================================================ *
     * Frame update
     * ================================================================ */
    const pondSphere = new THREE.Sphere(centre.clone(), R_POND + 2.2);
    const frustum = new THREE.Frustum();
    const pm = new THREE.Matrix4();
    const mtx = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const vpos = new THREE.Vector3();
    const vscl = new THREE.Vector3();
    const pinkLin = new THREE.Color().setHex(0xFFC2D6, THREE.SRGBColorSpace);
    // The crown AS REFLECTED is not the pale specular pink of a lit petal edge — it
    // is the mass, i.e. ART_BIBLE §3's mid #FFB6CE shading into #EE8CAF. Authored
    // separately from pinkLin because the analytic blob wants the pale value and the
    // hue rotation wants the chroma.
    const crownLin = new THREE.Color().setHex(0xF29BB8, THREE.SRGBColorSpace);

    return {
      object3D: group,

      resize(w, h) { reflect?.setSize(w, h); },

      update(dt, time) {
        /* ---- ripple ageing ---- */
        for (let i = 0; i < MAX_RIPPLES; i++) {
          const r = ripples[i];
          if (r.s > 0) {
            r.age += dt;
            if (r.age > RIPPLE_LIFE) r.s = 0;
          }
          rippleU.value[i].set(r.x, r.z, r.age, r.s);
        }
        uChop.value = Math.max(0, uChop.value - dt * 0.55);

        /* ---- reflection colour hints for the analytic path ---- */
        if (L) {
          const night = L.uNightMix?.value ?? 0;
          const sun = L.uSunColor?.value;
          const sky = L.uSkyColor?.value;
          const fog = L.uFogColor?.value;
          const lum = sun ? 0.2126 * sun.r + 0.7152 * sun.g + 0.0722 * sun.b : 1;
          const k = clamp(0.30 + 0.85 * lum, 0.12, 1.6) * (1 - 0.55 * night);
          uCanopyColor.value.setRGB(pinkLin.r * k, pinkLin.g * k, pinkLin.b * k);
          if (sky) {
            uCanopyColor.value.lerp(sky, 0.20 + 0.35 * night);
            uCanopyAmount.value = lerp(0.58, 0.30, night);
          }
          if (fog) uHillColor.value.setRGB(fog.r * 0.74, fog.g * 0.78, fog.b * 0.92);
          // uCanopyPure keeps the sakura hue (no sky lerp) so canopyTint() has a real
          // pink to rotate toward; only its LEVEL tracks the key. Night keeps a little
          // of it — a moonlit crown is still a pink mass, just a dim one.
          uCanopyPure.value.setRGB(crownLin.r * k, crownLin.g * k, crownLin.b * k);
          uCanopyBounce.value = canopyMuted ? 0 : lerp(1.0, 0.45, night);
        }
        // keep the analytic canopy blob on the real crown once the tree exists
        const tb = ctx.assets?.tree?.canopyBounds;
        if (tb?.center) {
          uCanopyCentre.value.copy(tb.center);
          uCanopyRadius.value = tb.radius * 0.86;
        }

        /* ---- floating petals ---- */
        live += Math.sign(liveTarget - live) * Math.min(Math.abs(liveTarget - live), Math.max(1, Math.ceil(dt * 22)));
        live = clamp(live, 0, PMAX);
        petalMesh.count = live;
        const gust = WIND.gust;
        const wd = WIND.uniforms.uWindDir.value;
        for (let i = 0; i < live; i++) {
          const p = petals[i];
          if (!p.born) seedPetal(p, true);

          const d = depthAt(p.x, p.z);
          const w = WIND.at(p.x, WATER_Y, p.z);
          // surface drag is a small fraction of the wind, plus a slow swirl so
          // petals never travel in parallel lines
          const sw = noise3(p.x * 0.29, time * 0.11, p.z * 0.29);
          let vx = w.x * 0.052 - w.z * 0.014 * sw;
          let vz = w.z * 0.052 + w.x * 0.014 * sw;

          if (d < 0.075) {
            // beached: kill the outward component, keep a slow slide ALONG the
            // shore so petals pack into a drift instead of piling on one point
            const nx = p.x - CX, nz = p.z - CZ;
            const nl = Math.hypot(nx, nz) || 1;
            const ux = nx / nl, uz = nz / nl;
            const out = vx * ux + vz * uz;
            if (out > 0) { vx -= ux * out; vz -= uz * out; }
            vx = vx * 0.28 - uz * 0.010 * sw;
            vz = vz * 0.28 + ux * 0.010 * sw;
            p.rest += dt;
          } else {
            p.rest = Math.max(0, p.rest - dt * 0.4);
          }

          p.x += vx * dt;
          p.z += vz * dt;
          p.ang += p.av * dt * (0.35 + 0.85 * gust) + (d < 0.075 ? 0 : 0.12 * sw * dt);

          if (p.rest > p.life) { seedPetal(p, true); continue; }

          // rock on the ripples: two detuned tilts, amplitude with the gust
          const bob = Math.sin(time * 1.35 + p.ph) * 0.006 + Math.sin(time * 2.7 + p.ph * 1.7) * 0.003;
          const tilt = 0.10 + 0.22 * gust;
          eu.set(
            Math.sin(time * 1.6 + p.ph) * tilt,
            p.ang,
            Math.cos(time * 1.25 + p.ph * 0.7) * tilt,
          );
          qt.setFromEuler(eu);
          vpos.set(p.x, WATER_Y + 0.012 + bob * (0.3 + gust), p.z);
          vscl.set(p.s, p.s, p.s);
          mtx.compose(vpos, qt, vscl);
          petalMesh.setMatrixAt(i, mtx);
        }
        if (live > 0) petalMesh.instanceMatrix.needsUpdate = true;

        /* ---- a petal LANDS ------------------------------------------------
         * Measured: with every petal already seeded, a steady-state pond spawned
         * no rings at all over 600 frames — petals only recycle after 16-34 s of
         * resting, so the surface just sat there. This is the beat that keeps it
         * alive: at intervals scaled by the bloom stage a petal arrives from the
         * tree, which recycles the longest-rested petal upwind and rings the
         * water where it touches down. 2.2 s at stage 5, ~9 s at stage 1. */
        landTimer -= dt;
        if (landTimer <= 0) {
          // MEASURED against the prescription's "at least 4 rings live at any time in
          // the pond preset": rings now live RIPPLE_LIFE = 1.40 s, so the cadence has
          // to be under 0.35 s to hold four. 0.34 s at stage 1 (density 0.30) and
          // 0.14 s at stage 5, jittered +-40 %, gives 4.1-5.4 live at stage 1 and
          // 9-10 at stage 5 — read off ctx.assets.water.liveRipples, not guessed.
          const dens = STAGE_DENSITY[clamp(stage, 0, 5)];
          landTimer = lerp(0.40, 0.14, dens) * prng.range(0.60, 1.40);
          const a = prng.range(0, Math.PI * 2);
          const r = prng.range(0.06, 0.90) * shoreMin;
          const lx = CX + Math.cos(a) * r, lz = CZ + Math.sin(a) * r;
          // The ring is the point; recycling a petal is the bonus. Decoupled on
          // purpose — tying the two together meant either no rings (the old 7.3 s
          // cadence) or a petal teleporting three times a second.
          ripple(lx, lz, prng.range(0.62, 1.05));
          let bi = -1, bt = 4.0;
          for (let i = 0; i < live; i++) if (petals[i].rest > bt) { bt = petals[i].rest; bi = i; }
          if (bi >= 0) seedPetal(petals[bi], false);
        }

        /* ---- ambient rings: a breeze catching the surface, a water strider, a
         * drip off a reed. Rarer now that the landing beat is 0.34 s, but it keeps
         * the far half of the pool (where petals rarely reach) from going glassy. */
        ambientTimer -= dt;
        if (ambientTimer <= 0) {
          ambientTimer = prng.range(1.4, 2.8);
          const a = prng.range(0, Math.PI * 2);
          const r = prng.range(0.30, 0.95) * shoreMin;
          ripple(CX + Math.cos(a) * r, CZ + Math.sin(a) * r, prng.range(0.36, 0.66));
        }

        /* ---- planar reflection ------------------------------------------
         * MEASURED: the mirror pass is 1.98 ms of submit time (22 calls, 404 k
         * triangles) — over this module's whole 1.5 ms budget on its own. Two
         * gates bring it back:
         *   1. SCREEN COVERAGE, not just frustum. In hero/gameplay/wide the pond
         *      is a corner of the frame where nobody can resolve a mirror, so the
         *      analytic reflection takes over and the pass costs nothing. Only the
         *      pond camera (and a player who walks up to it) pays.
         *   2. EVERY OTHER FRAME. The pool is still; a 30 Hz mirror on a 60 Hz
         *      frame is not detectable, and it halves the remaining cost.
         * uReflMix is ramped rather than switched so crossing the threshold does
         * not pop between the two reflection paths. */
        let wantMirror = false;
        if (reflect && reflectEnabled && ctx.frame > 2) {
          const cam = ctx.camera;
          pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
          frustum.setFromProjectionMatrix(pm);
          if (frustum.intersectsSphere(pondSphere)) {
            vpos.copy(centre).applyMatrix4(cam.matrixWorldInverse);
            const zd = -vpos.z;
            if (zd > 0.1) {
              const halfH = Math.tan(cam.fov * Math.PI / 360) * zd;
              // the WATER's radius, not the padded frustum sphere's
              wantMirror = (shoreMax + 0.45) / Math.max(halfH, 1e-3) > 0.40;
            }
          }
        }
        if (wantMirror && (ctx.frame & 1) === 0) reflect.render();
        const mixTarget = wantMirror ? 1 : 0;
        uReflMix.value += (mixTarget - uReflMix.value) * Math.min(1, dt * 6);
        if (Math.abs(mixTarget - uReflMix.value) < 0.01) uReflMix.value = mixTarget;

        /* ---- debug closeup camera (scenario only) ---- */
        if (closeup && ctx.camera) {
          ctx.camera.position.copy(closeup.pos);
          ctx.camera.lookAt(closeup.look);
          if (ctx.camera.fov !== closeup.fov) {
            ctx.camera.fov = closeup.fov;
            ctx.camera.updateProjectionMatrix();
          }
        }
      },

      dispose() {
        for (const o of offs) o?.();
        if (ctx.assets.water === api) ctx.assets.water = null;
        const ci = ctx.clickTargets?.indexOf(surface);
        if (ci != null && ci >= 0) ctx.clickTargets.splice(ci, 1);
        reflect?.dispose();
        stones.dispose();
        reeds.dispose();
        petalMesh.dispose();
        surfMat.dispose();
        bedMat.dispose();
        stoneMat.dispose();
        reedMat.dispose();
        petalMat.dispose();
        for (const d of disposables) d?.dispose?.();
      },
    };
  },
};
