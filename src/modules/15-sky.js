import * as THREE from 'three';
import { WIND } from '../lib/wind.js';
import {
  makeSkyNoiseTextures, pfbm2, RIDGE_RIDGED,
  SKY_VERT, SKY_FRAG, HILL_VERT, HILL_FRAG, FLOOR_VERT, FLOOR_FRAG,
  SKY_KEYS, phaseToU,
} from '../lib/sky-shaders.js';

/**
 * 15-sky — sky dome, atmosphere, painted clouds, night sky, distant hills.
 * Owner: sky agent.  Owns exactly src/modules/15-sky.js + src/lib/sky-shaders.js.
 *
 * What the rest of the scene can use (published on ctx.assets.sky):
 *   uniforms   the whole sky uniform bag (shared by reference — read, never replace)
 *   colors     { zenith, mid, horizon, haze, hazeWarm, fog, cloudLit, cloudDark, sun, moon }
 *              live THREE.Color objects in LINEAR space, re-lerped every frame from
 *              the ART_BIBLE palette rows. Water/props can tint reflections with these.
 *   noiseA/B/C the baked tiling noise (R = height, GB = ∂H, A = warp/detail). C is the
 *              cumulus field: a billow fbm whose GB gradient is taken from a BLURRED
 *              copy, so a relief normal built from it follows the big lobes and not
 *              the finest wrinkles (that is what stops clouds reading as foil).
 *   gradScale  decode scale for the GB gradient channels
 *   u          current 0..1 position in the day cycle
 *   phase      last `time:phase` payload
 *   sunDir     the direction the sky believes the sun is in (shared with lighting if present)
 *   moonDir    the shading moon direction (08-lighting's, when present). NOTE the moon
 *              DISC is drawn along uniforms.uMoonRender instead — see placeMoonDisc().
 *   nightMix   0 day … 1 night
 *   sample(dir) CPU evaluation of the sky gradient — cheap ambient/reflection lookup
 */

const SRGB = THREE.SRGBColorSpace;
const C = (hex) => new THREE.Color().setHex(hex, SRGB);

/* pre-convert the palette to linear-space colours once */
const KEYS = SKY_KEYS.map((k) => ({
  u: k.u,
  col: {
    zenith: C(k.zenith), mid: C(k.mid), horizon: C(k.horizon), haze: C(k.haze),
    hazeWarm: C(k.hazeWarm ?? k.haze),
    sun: C(k.sun), glow: C(k.glow), fog: C(k.fog),
    cloudLit: C(k.cloudLit), cloudDark: C(k.cloudDark),
    cloudAmb: C(k.cloudAmb), cloudRim: C(k.cloudRim),
    hillLit: C(k.hillLit), hillDark: C(k.hillDark), tree: C(k.tree),
    floorNear: C(k.floorNear), floorFar: C(k.floorFar),
  },
  num: {
    hazeAmt: k.hazeAmt, sunI: k.sunI, sunSize: k.sunSize, mieAmt: k.mieAmt,
    stars: k.stars, exposure: k.exposure,
    zk: k.zk, zdeep: k.zdeep, midAmt: k.midAmt,
    aerialK: k.aerialK, gAer: k.gAer,
  },
  cov: k.cov,
}));

/* ── per-layer cloud constants: x = lowest / nearest … w = cirrus ──────────
 *
 * The deck is a pow-compressed cloud-plane projection (see cloudLayer in
 * sky-shaders.js), so the two shape knobs are:
 *
 *   CLOUD_KF  the projection's horizon floor. LOW kf = the plane is far and its
 *             features crowd hard into the last few degrees (cirrus); HIGH kf =
 *             a near, low deck whose masses stay large right down to the ridge
 *             line, which is where the hero frame actually looks (its visible
 *             sky is only elevations ~6-20°).
 *   CLOUD_PW  radial de-compression exponent. 1.0 = raw perspective (and raw
 *             perspective at 6-20° elevation is exactly what shredded the old
 *             masses into horizontal filaments); ~0.55 restores enough vertical
 *             extent for a convex top and a flat base to be visible.
 *
 * CLOUD_S is then chosen so one mass ≈ 8-12° of arc: with kf 0.30 / pw 0.55 the
 * plane radius runs 1.80 (at 3°) → 1.21 (at 24°), so scale 1.05 puts ~1.7 mass
 * generations across the hero's visible sky band. */
const CLOUD_KF = [0.300, 0.220, 0.150, 0.090];
const CLOUD_S = [1.05, 1.55, 2.60, 3.60];
const CLOUD_PW = [0.55, 0.58, 0.62, 0.72];
const CLOUD_V = [0.0135, 0.0115, 0.0090, 0.0062];
const CLOUD_B = [1.60, 1.40, 0.95, 0.45];   // relief strength (domed vs flat)
const CLOUD_W = [0.150, 0.130, 0.100, 0.070];
const CLOUD_D = [0.075, 0.090, 0.115, 0.130];   // fine edge nibble
const CLOUD_T = [1.00, 1.10, 1.30, 1.70];   // uv stretch along the wind (streaks)
const CLOUD_A = [1.00, 0.62, 0.36, 0.15];   // per-layer opacity
const CLOUD_AER = [0.55, 0.52, 0.46, 0.40]; // how far the deck melts into haze
const CLOUD_RIM = [1.00, 0.90, 0.72, 0.55];
/* Coverage. Deliberately HIGH for a cumulus field: fewer, more separate,
 * fully-opaque masses read as cumulus, whereas a low threshold produces a
 * connected sheet whose only visible structure is its own thin filaments. */
const COV_BASE = [0.605, 0.668, 0.712, 0.762];
/* High-sky budget: above ~38° each layer's threshold is raised and its opacity
 * scaled down so the saturated zenith blue keeps the top of the frame (§8.2).
 * Much gentler than before — the old budget deleted the cumulus decks outright
 * everywhere above 27° and left the cirrus smear as the only cloud in frame. */
/* MEASURED (shots/sky-r2-day/canopy.png, sky x 1000-1900 y 0-500): with the old
 * budget the upper-sky decks came back as pale ragged wisps — lumP50 0.53 with
 * masses whose alpha never reached opacity, i.e. torn tissue paper rather than
 * cumulus (ART_BIBLE §8.2). Both the threshold penalty and the opacity penalty
 * were doing the same job twice: a raised threshold ALREADY makes the masses
 * smaller and more separate, and scaling their opacity on top of that is what
 * stops the survivors from ever reading as solid. The threshold penalty is now
 * the only one that bites hard; opacity stays near full so a mass that does
 * survive is a MASS. The zenith blue still owns the top of frame because aCap
 * (below, in the compositor) is the real guarantee of that, not these. */
const CLOUD_ZC = [0.030, 0.048, 0.078, 0.115];
const CLOUD_ZA = [0.96, 0.92, 0.80, 0.64];

/* Per-band minimum haze fraction. The exponential law alone leaves the nearest
 * band at f≈0.24 at 122 m, which is not enough to kill its chroma — a fully
 * saturated tree line silhouetted against a cool sky is the single most
 * depth-destroying thing in the frame. */
const FOG_FLOOR = [0.24, 0.44, 0.62];

/* Per-band albedo VALUE. Distant hills must be a genuinely darker plane than the
 * sky they sit against, and each band must be a step lighter than the one in
 * front of it — with the bands all sharing one albedo the aerial term alone left
 * the whole horizon inside a 3/255 band, i.e. no depth ordering at all. */
const HILL_VALUE = [0.72, 0.80, 0.88];

/* Strength of the mist deck tucked into each range's foot.
 *
 * MEASURED (round-2 critic): 0.18 on the nearest band put a 0.205 mix toward
 * skyRadiance across the 60 screen rows immediately above the grass field, i.e.
 * a soft pale bar sitting on the horizon. The nearest band's foot is the one
 * place a mist deck must stay almost invisible, because it is the join with the
 * playable ground. 0.08 keeps the horizontal variation without the bar. */
const MIST_AMT = [0.08, 0.26, 0.20];

/* Turning 08-lighting's clock into this module's cycle position.
 *
 * MEASURED: `time:phase` arrives at most once (the rig emits on phase CHANGE and
 * order 8 runs before order 15 subscribes), so in shot mode the sky never
 * received one at all — it fell back to inferring the cycle from the sun's
 * elevation, which cannot tell morning from evening and rendered every dawn with
 * the dusk palette. The rig's own palette IS the authoritative clock.
 *
 * REGRESSION FIXED HERE (round 1 critic, "the day sky has been pushed to
 * magenta"): this used to re-derive the phase from a HARDCODED COPY of
 * lib/lighting.js's PHASE_BOUNDS. Lighting later moved the end of `day` from
 * 0.625 to 0.690 so that DEFAULT_DAY_T = 0.665 would land inside day, and the
 * copy here was never updated — so the default frame, whose sun sits at 39 deg
 * elevation and whose rig reports `day` t=0.97, was being painted at cycle
 * u=0.721: a full golden-hour palette (horizon #F5C690, haze #FED097, Mie 1.50).
 * A 39 deg sun under a sunset gradient is what produced the magenta zenith, the
 * acid horizon band and the warm hills the critic measured. `palette.phase` +
 * `palette.phaseT` are published every frame by the rig, so read those and never
 * duplicate its bounds again. `uFromDayT` survives only as a fallback for a rig
 * that publishes dayT but no phase. */
const LIGHT_BOUNDS = [['dawn', 0.085, 0.200], ['day', 0.200, 0.690], ['dusk', 0.690, 0.815]];
function uFromDayT(t) {
  const x = ((t % 1) + 1) % 1;
  for (const [name, a, b] of LIGHT_BOUNDS) {
    if (x >= a && x < b) return phaseToU(name, (x - a) / (b - a));
  }
  const nt = x >= 0.815 ? (x - 0.815) / 0.27 : (x + 0.185) / 0.27;
  return phaseToU('night', Math.min(1, Math.max(0, nt)));
}

/* ------------------------------------------------------------------ hills -- */
/**
 * A ring "curtain": a real noise-carved ridge line closed on itself, with a
 * skirt that reaches well below the horizon so no gap can ever open under it.
 */
function makeRidgeGeometry({
  radius, segments, rows, baseY, hMin, hMax, seed, ridgeBase, ridgeOct,
  treeAmp, radiusJitter, phase,
}) {
  const cols = segments + 1;
  const ridge = new Float32Array(cols);
  const rr = new Float32Array(cols);
  let rMin = 1e9, rMax = -1e9;

  for (let i = 0; i < cols; i++) {
    const u = (i % segments) / segments;
    // main ridge: ridged multifractal → rounded summits, sharp valleys
    // Low gain + a pow keeps distinct summits instead of a smooth arc.
    const a = pfbm2(u + phase, 0.37, ridgeBase, ridgeOct, seed, 0.42, RIDGE_RIDGED) * 0.5 + 0.5;
    // a second, finer ridge system breaks the arc into separate spurs
    const b = pfbm2(u + phase * 1.7, 5.11, ridgeBase * 4, 3, seed + 311, 0.44, RIDGE_RIDGED) * 0.5 + 0.5;
    let h = Math.pow(a, 1.7) * 0.74 + Math.pow(b, 1.45) * 0.26;
    if (treeAmp > 0) {
      // tree-line serration on the silhouette itself
      const t1 = pfbm2(u + phase, 9.3, 96, 3, seed + 77, 0.58, RIDGE_RIDGED) * 0.5 + 0.5;
      const t2 = pfbm2(u + phase, 3.1, 192, 2, seed + 131, 0.5, RIDGE_RIDGED) * 0.5 + 0.5;
      h += (t1 * 0.65 + t2 * 0.35) * treeAmp;
    }
    ridge[i] = hMin + h * (hMax - hMin);
    if (ridge[i] < rMin) rMin = ridge[i];
    if (ridge[i] > rMax) rMax = ridge[i];
    rr[i] = radius * (1 + pfbm2(u + phase, 2.2, 2, 2, seed + 13) * radiusJitter);
  }

  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const aR = new Float32Array(n);
  const invSpan = 1 / Math.max(1e-4, rMax - rMin);

  for (let j = 0; j < rows; j++) {
    // bias rows toward the top so the serrated crest gets the vertex budget
    const v = Math.pow(j / (rows - 1), 0.72);
    for (let i = 0; i < cols; i++) {
      const th = (i / segments) * Math.PI * 2;
      const r = rr[i];
      const y = baseY + (ridge[i] - baseY) * v;
      const o = (j * cols + i) * 3;
      pos[o] = Math.cos(th) * r;
      pos[o + 1] = y;
      pos[o + 2] = Math.sin(th) * r;
      uvs[(j * cols + i) * 2] = i / segments;
      uvs[(j * cols + i) * 2 + 1] = v;
      aR[j * cols + i] = (ridge[i] - rMin) * invSpan;
    }
  }

  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a0 = j * cols + i, b0 = a0 + 1, c0 = a0 + cols, d0 = c0 + 1;
      idx.push(a0, c0, b0, b0, c0, d0);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aRidge', new THREE.BufferAttribute(aR, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export default {
  name: 'sky',
  order: 15,

  async setup(ctx) {
    const group = new THREE.Group();
    group.name = 'sky';
    const disposables = [];

    /* ---------- baked procedural noise (no network, deterministic) -------- */
    const N = (ctx.quality.tier === 'low' || ctx.quality.tier === 'medium') ? 256 : 512;
    const { texA, texB, texC, gradScale } = makeSkyNoiseTextures(THREE, N);
    disposables.push(texA, texB, texC);
    ctx.assets.textures.skyNoiseA = texA;
    ctx.assets.textures.skyNoiseB = texB;
    ctx.assets.textures.skyNoiseC = texC;

    /* ---------- shared lighting uniforms, with local fallbacks ----------- */
    const L = ctx.assets.lightUniforms || {};
    const owned = {};
    const share = (name, fallback) => {
      if (L[name] && L[name].value !== undefined) { owned[name] = false; return L[name]; }
      owned[name] = true; return { value: fallback };
    };

    const uSunDir = share('uSunDir', new THREE.Vector3(-0.62, 0.62, -0.48).normalize());
    const uMoonDir = share('uMoonDir', new THREE.Vector3(0.42, 0.68, 0.60).normalize());
    const uFogColor = share('uFogColor', C(0xbcd3ea));
    const uNightMix = share('uNightMix', 0.0);
    const uShadowTint = share('uShadowTint', C(0x6e76a8));

    // live palette colours — published so water/props can match the sky
    const colors = {
      zenith: C(0x4e86d4), mid: C(0x8fbbe8), horizon: C(0xcfe0f2), haze: C(0xdfeaf6),
      hazeWarm: C(0xffe8c6),
      sun: C(0xffebcb), glow: C(0xfff0dc), fog: C(0xbcd3ea),
      cloudLit: C(0xfffaf2), cloudDark: C(0x9aa8cc), cloudAmb: C(0xb4c8e8), cloudRim: C(0xfff4e2),
      hillLit: C(0x8fa8b8), hillDark: C(0x556880), tree: C(0x4a6060),
      floorNear: C(0x7e9068), floorFar: C(0xa8c0cc), moon: C(0x9fb6e8),
    };

    /* The gradient block. These exact uniform OBJECTS are shared into the hill
     * and floor materials so `skyRadiance()` evaluates identically everywhere —
     * one sky, one aerial-perspective temperature, no per-material drift. */
    const gradU = {
      uZenith: { value: colors.zenith },
      uMid: { value: colors.mid },
      uHorizon: { value: colors.horizon },
      uHaze: { value: colors.haze },
      uHazeWarm: { value: colors.hazeWarm },
      /* Gain on the additive sun-side horizon band (see GLSL_SKY_UNIFORMS).
       * The sun-side dusk sky measured display L 0.936 with all three hill bands
       * inside 0.933-0.936 — one cream plate, no depth ordering at all. This
       * uniform exists because that had to be ATTRIBUTED rather than guessed at,
       * and the A/B says it is NOT this term: sky-hw35 (0.62 -> 0.35) moved the
       * sun-side sky by 0.001, sky-mie60 by 0.028, and sky-sun-off by 0.249 —
       * i.e. the wash is the sun's own veil, and it is fixed at its source in
       * SKY_FRAG (see veilS) instead of here. Left at the original 0.80 on
       * purpose: trimming a term that measures as irrelevant is how a frame ends
       * up quietly under-lit two rounds later. */
      uHazeWarmK: { value: 0.80 },
      uHazeAmt: { value: 0.46 },
      uHazeH: { value: 0.055 },
      uZenithPow: { value: 0.42 },   // exponent on elevation, <1 → blue owns the top
      uMidAmt: { value: 0.16 },
      uZenDeep: { value: 0.80 },
      uSunDir,
      uGlowTint: { value: colors.glow },
      uMieG: { value: 0.775 },
      uMieAmt: { value: 0.8 },
    };
    const uAerialK = { value: 0.0022 };
    const uGroundAerial = { value: 0.12 };

    const uni = {
      uNoiseA: { value: texA },
      uNoiseB: { value: texB },
      uNoiseC: { value: texC },
      uGradScale: { value: new THREE.Vector3(gradScale[0], gradScale[1], gradScale[2]) },
      uTime: { value: 0 },

      uMoonDir, uFogColor, uShadowTint,

      ...WIND.uniforms,
      ...gradU,

      uGroundFade: { value: 1.0 },
      /* radians per vertical pixel; refreshed every frame from the live camera */
      uPxRad: { value: 0.0012 },

      uSunTint: { value: colors.sun },
      uSunSize: { value: 0.019 },
      uSunI: { value: 17.0 },

      uCovL: { value: new THREE.Vector4(...COV_BASE) },
      uScaleL: { value: new THREE.Vector4(...CLOUD_S) },
      uSpeedL: { value: new THREE.Vector4(...CLOUD_V) },
      uKfL: { value: new THREE.Vector4(...CLOUD_KF) },
      uPwL: { value: new THREE.Vector4(...CLOUD_PW) },
      uBumpL: { value: new THREE.Vector4(...CLOUD_B) },
      uWarpL: { value: new THREE.Vector4(...CLOUD_W) },
      uDetL: { value: new THREE.Vector4(...CLOUD_D) },
      uStretchL: { value: new THREE.Vector4(...CLOUD_T) },
      uAmtL: { value: new THREE.Vector4(...CLOUD_A) },
      uZenCovL: { value: new THREE.Vector4(...CLOUD_ZC) },
      uZenAmtL: { value: new THREE.Vector4(...CLOUD_ZA) },
      uAerL: { value: new THREE.Vector4(...CLOUD_AER) },
      uRimL: { value: new THREE.Vector4(...CLOUD_RIM) },
      uCloudLit: { value: colors.cloudLit },
      uCloudDark: { value: colors.cloudDark },
      uCloudAmb: { value: colors.cloudAmb },
      uCloudRim: { value: colors.cloudRim },
      uCloudAmt: { value: 1.0 },
      uCloudRimAmt: { value: 1.0 },

      uMoonRender: { value: new THREE.Vector3(0.42, 0.30, 0.60).normalize() },
      uStars: { value: 0.0 },
      /* MEASURED: 0.30 lifted the upper-40 % of the night hero frame from
       * lumP50 0.096 to 0.280 — the band alone can add 0.4 LINEAR against a
       * night sky whose own radiance is ~0.02, so it whites out the sky long
       * before it reads as a galaxy. 0.17 keeps the band clearly visible while
       * the base value stays on the 0.10 spec (ART_BIBLE §3 night zenith). */
      /* 0.12, not 0.17: with the star field now carrying real magnitudes the
       * band no longer has to be bright to be seen, and at 0.17 the round-2
       * critic read it as "soft grey cloud smudges" rather than as a galaxy. */
      uMilky: { value: 0.12 },
      uMoonCol: { value: colors.moon },
      /* 0.0175 rad ≈ 30 px radius at the hero fov, 26 px at pond — the
       * prescription's 26 px, and small enough that the limb reads as a limb.
       * At 0.030 it was a 44-52 px soft ball. */
      /* MEASURED AGAIN this round: at 0.0192 (25 px radius in the hero frame) the
       * graded disc's limb spans 6-8 px because the DOF far band puts 5 px of CoC
       * on anything at infinity and bloom smears the skirt — so the moon read as
       * a ball of fog while the SAME frame at postfx-off had a crisp limb (see
       * shots/_c_moon.png vs _c_moonraw.png). The blur is a fixed pixel count, so
       * the fix available to this file is a bigger body: 0.0234 rad = 39 px radius
       * at fov 36, where the same 5 px is 13 % of the radius instead of 20 %. */
      uMoonSize: { value: 0.0234 },
      /* Peak linear radiance multiplier on uMoonCol.
       * MEASURED: at 3.3 the disc rendered at display L 0.964 with the maria at
       * 0.964 too — ACES's shoulder has effectively zero slope up there, so the
       * whole surface collapsed onto one flat white and the moon read as a lens
       * flare rather than as a body. Swept with `sky-moon-b*` (see below) and
       * landed on the value that puts the highlands at 0.93 and the maria at
       * 0.84 — a spread of 0.09, which is what makes the markings visible. */
      uMoonBright: { value: 1.35 },
      /* maria value as a fraction of the highlands (swept: `sky-moon-m*`) */
      uMoonMaria: { value: 0.42 },
      uMoonHalo: { value: 1.0 },
      /* night cloud deck — see the block comment in sky-shaders.js */
      uNightCloudV: { value: 0.66 },
      uNightCloudA: { value: 0.72 },
      uNightCloudR: { value: 0.34 },
      /* cloud value-range calibration (swept: `sky-cloud-lit*` / `-shade*`) */
      uCloudLitK: { value: 1.0 },
      uCloudShadeK: { value: 0.50 },
      uCloudCoreK: { value: 0.88 },
      /* How far below the transmission floor a flank turned away from the key
       * sits. 1.0 reproduces the old flat floor, which MEASURED as a single
       * value across an entire upper-sky mass (canopy preset) — flat white
       * amoebas, no lit top, no shaded underside. Swept: sky-cloud-form*.
       * MEASURED at 0.70 (shots/sky-r2-day/canopy.png vs sky-r0-day, mass box
       * x 1380-1750 y 150-360, pixels above L 0.62): interior spread 0.215 ->
       * 0.196 but the mass COVERAGE fell 0.412 -> 0.368, i.e. 0.70 was mostly
       * eating the mass rather than shaping it. 0.80 keeps the body value and
       * still breaks the flat floor. */
      uCloudFormK: { value: 0.80 },
      uDither: { value: 0.0125 },
    };

    /* ---------------------------- sky dome ------------------------------- */
    const domeGeo = new THREE.SphereGeometry(600, 96, 48);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.name = 'sky-dome';
    dome.frustumCulled = false;
    dome.renderOrder = -10000;
    dome.castShadow = false;
    dome.receiveShadow = false;
    group.add(dome);
    disposables.push(domeGeo, domeMat);

    /* -------------------- distant hills — three bands -------------------- */
    const uCamPos = { value: new THREE.Vector3() };
    /* ── why every baseY is at or below the valley floor's own plane ─────────
     *
     * BLOCKING BUG FIXED HERE (round-2 critic: "a ~60 px desaturated grey-cyan
     * stripe edge to edge across the grass field in every daylight frame").
     *
     * A band is a ring "curtain" of radius R whose bottom edge sits at baseY.
     * The far valley floor is a disc at y = -0.55. For any view ray descending
     * at angle θ the floor is hit at t = (camY + 0.55)/θ, so the floor is NEARER
     * than the curtain — and therefore occludes it — exactly when
     * t < D, i.e. when the curtain's world height there falls below -0.55.
     * The curtain's visible lower edge is thus pinned to the floor's plane by
     * construction, at the curtain's OWN distance, whenever baseY <= -0.55: the
     * join is seamless and both sides carry the same aerial haze.
     *
     * With baseY = 2.2 (the old value) the curtain stopped 2.75 units ABOVE the
     * floor, so between its bottom edge and the floor's grazing line the far
     * floor showed through — MEASURED at 163-226 m, sandwiched between the
     * curtain at 141 m above it and the playable terrain at 103 m below it.
     * A farther, hazier, paler strip between two nearer surfaces is a
     * saturation trough that dips AND recovers, which no distance fog can do:
     * that was the stripe. Raycast at gameplay x=400 confirmed it exactly —
     * y 560-624 hills-0-0 @141 m, y 632-648 valley-floor @201-163 m, y>=656
     * ground @103 m.
     *
     * Bands 1 and 2 get the same treatment for the same reason one range back:
     * band 1's old base (y=5) projected ABOVE band 0's ridge minima, so a
     * 14-row sliver of 330-470 m floor showed in band 0's deepest valleys.
     * Band 2's base only has to clear band 1's ridge minima (~y 17 at 480 m
     * from the highest shipped camera), so 4.0 is both hidden and keeps its
     * card from growing pointlessly tall. */
    const BANDS = [
      { // nearest — tree-lined crest
        radius: 122, segments: 1024, rows: 8, baseY: -1.0, hMin: 5.0, hMax: 21.0,
        ridgeBase: 20, ridgeOct: 4, treeAmp: 0.055, radiusJitter: 0.11,
        treeAmt: 1.0, ridgeFreq: 22.0, litMix: 0.0, seed: 91,
        phases: [0.0, 0.53], radMul: [1.0, 1.16], hMul: [1.0, 0.72],
      },
      { // middle
        radius: 252, segments: 640, rows: 7, baseY: -1.0, hMin: 15.0, hMax: 44.0,
        ridgeBase: 14, ridgeOct: 4, treeAmp: 0.018, radiusJitter: 0.10,
        treeAmt: 0.24, ridgeFreq: 16.0, litMix: 0.34, seed: 517,
        phases: [0.19, 0.74], radMul: [1.0, 1.12], hMul: [1.0, 0.78],
      },
      { // farthest — reaches the sky's own value almost completely
        radius: 432, segments: 512, rows: 6, baseY: 4.0, hMin: 30.0, hMax: 82.0,
        ridgeBase: 10, ridgeOct: 4, treeAmp: 0.0, radiusJitter: 0.08,
        treeAmt: 0.0, ridgeFreq: 11.0, litMix: 0.62, seed: 1223,
        phases: [0.41, 0.88], radMul: [1.0, 1.07], hMul: [1.0, 0.82],
      },
    ];

    const hillMats = [];
    BANDS.forEach((b, bi) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...gradU,
          uNoiseA: { value: texA },
          uNoiseB: { value: texB },
          uFogColor, uMoonDir,
          uCamPos, uAerialK,
          uMoonGlow: { value: new THREE.Color() },
          uHillLit: { value: new THREE.Color() },
          uHillDark: { value: new THREE.Color() },
          uHillRim: { value: new THREE.Color() },
          uTreeCol: { value: new THREE.Color() },
          uFloorNear: { value: new THREE.Color() },
          uFloorFar: { value: new THREE.Color() },
          uFogFloor: { value: FOG_FLOOR[bi] },
          uMistAmt: { value: MIST_AMT[bi] },
          uRidgeFreq: { value: b.ridgeFreq },
          // matches the horizontal cycle length in world units → isotropic detail
          uVScale: { value: b.ridgeFreq / (2 * Math.PI * b.radius) },
          uTreeAmt: { value: b.treeAmt },
          uSeed: { value: bi * 0.317 },
          uNight: { value: 0 },
          /* per-band night aerial gain — see the night block in HILL_FRAG.
           * Swept by sky-naer*. */
          uNightAer: { value: 0.62 },
          uNightFog: { value: colors.fog },
        },
        vertexShader: HILL_VERT,
        fragmentShader: HILL_FRAG,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: true,
      });
      mat.__litMix = b.litMix;
      mat.__val = HILL_VALUE[bi];
      hillMats.push(mat);
      disposables.push(mat);

      for (let s = 0; s < b.phases.length; s++) {
        const g = makeRidgeGeometry({
          radius: b.radius * b.radMul[s],
          segments: s === 0 ? b.segments : Math.max(256, b.segments >> 1),
          rows: b.rows,
          baseY: b.baseY,
          hMin: b.hMin * b.hMul[s],
          hMax: b.hMax * b.hMul[s],
          seed: b.seed + s * 733,
          ridgeBase: b.ridgeBase,
          ridgeOct: b.ridgeOct,
          treeAmp: s === 0 ? b.treeAmp : b.treeAmp * 0.6,
          radiusJitter: b.radiusJitter,
          phase: b.phases[s],
        });
        const m = new THREE.Mesh(g, mat);
        m.name = `hills-${bi}-${s}`;
        m.frustumCulled = false;
        m.renderOrder = -50 + bi * 2 - s;
        group.add(m);
        disposables.push(g);
      }
    });

    /* ----- far valley floor: nothing may ever show sky below the horizon -- */
    const floorGeo = new THREE.CircleGeometry(470, 128).rotateX(-Math.PI / 2);
    const floorMat = new THREE.ShaderMaterial({
      uniforms: {
        ...gradU,
        uNoiseA: { value: texA },
        uNoiseB: { value: texB },
        uFogColor, uCamPos, uMoonDir, uAerialK, uGroundAerial,
        uMoonGlow: { value: new THREE.Color() },
        uNearCol: { value: new THREE.Color() },
        uFarCol: { value: new THREE.Color() },
        uNight: { value: 0 },
        uNightFog: { value: colors.fog },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.name = 'valley-floor';
    floor.position.y = -0.55;
    floor.frustumCulled = false;
    floor.renderOrder = -60;
    group.add(floor);
    disposables.push(floorGeo, floorMat);

    /* ---------------------------- palette eval --------------------------- */
    const tmpA = new THREE.Color();
    const state = {
      u: phaseToU('dusk', 0.30),   // a golden-hour default until lighting speaks
      phase: null,
      cloudAmt: 1.0,
      covBias: 0.0,
      night: 0.0,
      override: null,               // scenario lock
      sunMul: 1.0,                  // isolation switches (sky-sun-dim / sky-sun-off)
      sunSizeMul: 1.0,
      mieMul: 1.0,                  // calibration sweep only (sky-mie*)
    };

    function evalPalette(u) {
      const uu = ((u % 1) + 1) % 1;
      let i = 0;
      while (i < KEYS.length - 2 && KEYS[i + 1].u <= uu) i++;
      const k0 = KEYS[i], k1 = KEYS[i + 1];
      const span = Math.max(1e-5, k1.u - k0.u);
      const t = Math.min(1, Math.max(0, (uu - k0.u) / span));
      const s = t * t * (3 - 2 * t);   // smooth so phase boundaries never pop

      for (const key of Object.keys(colors)) {
        if (key === 'moon') continue;
        colors[key].copy(k0.col[key]).lerp(k1.col[key], s);
      }
      colors.moon.copy(k0.col.sun).lerp(k1.col.sun, s);

      const n0 = k0.num, n1 = k1.num;
      const lp = (a, b) => a + (b - a) * s;
      gradU.uHazeAmt.value = lp(n0.hazeAmt, n1.hazeAmt);
      gradU.uZenithPow.value = lp(n0.zk, n1.zk);
      gradU.uZenDeep.value = lp(n0.zdeep, n1.zdeep);
      gradU.uMidAmt.value = lp(n0.midAmt, n1.midAmt);
      gradU.uMieAmt.value = lp(n0.mieAmt, n1.mieAmt) * state.mieMul;
      uAerialK.value = lp(n0.aerialK, n1.aerialK);
      uGroundAerial.value = lp(n0.gAer, n1.gAer);
      uni.uSunSize.value = lp(n0.sunSize, n1.sunSize) * state.sunSizeMul;
      uni.uSunI.value = lp(n0.sunI, n1.sunI) * state.sunMul;
      const palStars = lp(n0.stars, n1.stars);

      for (let c = 0; c < 4; c++) {
        const v = COV_BASE[c] + (lp(k0.cov[c], k1.cov[c]) - 0.50) + state.covBias;
        uni.uCovL.value.setComponent(c, Math.min(0.93, Math.max(0.34, v)));
      }
      uni.uCloudAmt.value = state.cloudAmt;

      // the sky's own idea of night, blended with lighting's authoritative value
      const nm = owned.uNightMix ? palStars : Math.max(palStars, uNightMix.value);
      state.night = nm;
      uni.uStars.value = Math.min(1, nm);

      // Moon-side forward-scatter tint. The night fog colour alone (#1B2440) is
      // far too dark to lift a ridge, so the scatter is carried by a moon-tinted
      // colour whose strength tracks nightMix.
      tmpA.copy(colors.moon).lerp(colors.fog, 0.42).multiplyScalar(0.55 * nm);

      // Bands flatten in VALUE with distance, but their aerial *colour* now comes
      // from skyRadiance() inside the shader, so the pre-lerp toward the scalar
      // fog colour is kept small — it used to be the thing dragging the far
      // range warm at dusk while the sky behind it stayed cool.
      hillMats.forEach((m) => {
        const k = m.__litMix, v = m.__val;
        m.uniforms.uHillLit.value.copy(colors.hillLit).lerp(colors.fog, k * 0.26).multiplyScalar(v);
        m.uniforms.uHillDark.value.copy(colors.hillDark).lerp(colors.fog, k * 0.22).multiplyScalar(v);
        m.uniforms.uHillRim.value.copy(colors.haze).multiplyScalar(0.55 - k * 0.22);
        m.uniforms.uTreeCol.value.copy(colors.tree).multiplyScalar(v);
        m.uniforms.uFloorNear.value.copy(colors.floorNear);
        m.uniforms.uFloorFar.value.copy(colors.floorFar);
        m.uniforms.uNight.value = nm;
        m.uniforms.uMoonGlow.value.copy(tmpA).multiplyScalar(1.0 - k * 0.45);
      });
      floorMat.uniforms.uNearCol.value.copy(colors.floorNear);
      floorMat.uniforms.uFarCol.value.copy(colors.floorFar);
      floorMat.uniforms.uNight.value = nm;
      floorMat.uniforms.uMoonGlow.value.copy(tmpA).multiplyScalar(0.85);

      if (owned.uFogColor) uFogColor.value.copy(colors.fog);
      if (fog) {
        fog.color.copy(colors.fog);
        /* Keep three's own fog on the SAME law as skyRadiance/applySkyAerial.
         * A linear fog with far = 1/k matches 1-exp(-k*d) closely over the range
         * the playfield occupies, so any stock (non-NPR) material in the scene
         * lands on the same aerial value my surfaces do — which is what stops the
         * lower third from staying a neutral plate under a #FF9E5E key.
         * NPR materials opt out of three's fog entirely (they call applyAerial),
         * so this can only ever affect surfaces that have no aerial term at all. */
        if (fog.isFog) {
          fog.near = 0;
          fog.far = Math.min(560, Math.max(120,
            1 / (uAerialK.value * (1 + uGroundAerial.value) * 1.35)));
        }
      }
    }

    /* ── where the moon DISC goes ──────────────────────────────────────────
     * 08-lighting sets its moon key to the sun's exact antipode, so at the night
     * anchor the moon sits at ~48 deg elevation / 254 deg azimuth. Every shipped
     * camera preset tops out around 20 deg of elevation, so the disc was always
     * rendered off the top of the frame — which is why the night frame had a
     * FULL MOON banner and no moon. The azimuth is kept exactly (the moon stays
     * behind the tree, where the settled backlight decision wants it) and only
     * the elevation is compressed into 3-14 deg, i.e. into the visible band. The
     * SHADING key stays on uMoonDir, so nothing else in the scene moves; the
     * cost is that the disc sits lower than its own light direction, which is a
     * trade every painted night sky makes and no viewer can measure. */
    const _mr = new THREE.Vector3();
    /* -34 deg of azimuth as well as the elevation squash. Measured on the night
     * hero frame: the un-rotated antipode projects to (1489, 238), which is
     * underneath the TENDERS panel — the disc rendered correctly and the player
     * still could not see it. -34 deg puts it at (470, 240), clear of both the
     * top-left HUD block (ends x 390) and the panel, just outside the canopy's
     * upper-left silhouette. The azimuth still advances with the rig's clock, so
     * the moon travels across the night rather than sitting on a mark. */
    const MOON_AZ = -34 * Math.PI / 180;
    const MOON_CA = Math.cos(MOON_AZ), MOON_SA = Math.sin(MOON_AZ);
    function placeMoonDisc() {
      const md = uMoonDir.value;
      const hz = Math.hypot(md.x, md.z);
      const y = Math.min(1, Math.max(0, md.y));
      const yr = 0.055 + 0.190 * Math.pow(y, 0.75);
      const c = Math.sqrt(Math.max(1e-4, 1 - yr * yr));
      if (hz > 1e-5) {
        const dx = md.x / hz, dz = md.z / hz;
        _mr.set((dx * MOON_CA - dz * MOON_SA) * c, yr, (dx * MOON_SA + dz * MOON_CA) * c);
      } else _mr.set(c, yr, 0);
      uni.uMoonRender.value.copy(_mr).normalize();
    }

    /* Sun / moon placement when 08-lighting is not driving them. */
    const AZ = new THREE.Vector2(-0.62, -0.48).normalize();
    function placeCelestials(u) {
      const theta = ((u - 0.22) / 0.60) * Math.PI;
      const el = Math.sin(theta) * 0.80;
      if (owned.uSunDir) {
        const h = Math.sqrt(Math.max(1e-4, 1 - el * el));
        uSunDir.value.set(AZ.x * h, el, AZ.y * h).normalize();
      }
      if (owned.uMoonDir) {
        // 40° off the sun's azimuth so it actually lands inside the hero and
        // canopy framings rather than behind the camera, lifted into the sky.
        const ca = 0.766, sa = 0.643;
        const mx = AZ.x * ca - AZ.y * sa;
        const mz = AZ.x * sa + AZ.y * ca;
        const mel = 0.33 + Math.max(0, -el) * 0.10;
        const h = Math.sqrt(Math.max(1e-4, 1 - mel * mel));
        uMoonDir.value.set(mx * h, mel, mz * h).normalize();
      }
    }

    /* --------------------------- scene fog -------------------------------
     * Order 15 owns fog (CONTRACT module table). 08-lighting installs a
     * FogExp2 placeholder and explicitly expects a later module to swap in its
     * own instance — a *linear* Fog is the right shape here because it can be
     * put on exactly the same curve as `applySkyAerial` (see evalPalette), and
     * because lighting only re-writes `.density` on an isFogExp2 instance, so
     * near/far stay ours while the colour keeps tracking uFogColor. */
    const prevFog = ctx.scene.fog;
    const fog = new THREE.Fog(colors.fog.getHex(), 0, 400);
    if (prevFog?.color) fog.color.copy(prevFog.color);
    ctx.scene.fog = fog;

    evalPalette(state.u);
    placeCelestials(state.u);
    placeMoonDisc();

    /* ------------------------------ events ------------------------------- */
    const offPhase = ctx.bus.on('time:phase', (p) => {
      if (!p || state.override) return;
      state.phase = p;
      state.u = phaseToU(p.phase, p.t);
    });

    /* --------------------------- debug scenarios ------------------------- */
    const S = window.__game?.scenarios;
    if (S) {
      const lock = (u, opts = {}) => () => {
        state.override = true;
        state.u = u;
        state.cloudAmt = opts.cloudAmt ?? 1.0;
        state.covBias = opts.covBias ?? 0.0;
        evalPalette(state.u);
        placeCelestials(state.u);
        // courtesy: let the rest of the scene follow if it listens
        ctx.bus.emit('time:phase', { phase: opts.phase ?? 'day', t: opts.t ?? 0.5 });
      };
      S['sky-dawn'] = lock(phaseToU('dawn', 0.55), { phase: 'dawn', t: 0.55 });
      S['sky-day'] = lock(phaseToU('day', 0.25), { phase: 'day', t: 0.25 });
      S['sky-golden'] = lock(phaseToU('dusk', 0.32), { phase: 'dusk', t: 0.32 });
      S['sky-dusk'] = lock(phaseToU('dusk', 0.72), { phase: 'dusk', t: 0.72 });
      S['sky-night'] = lock(phaseToU('night', 0.35), { phase: 'night', t: 0.35 });
      S['sky-clear'] = lock(phaseToU('day', 0.35), { phase: 'day', t: 0.35, covBias: 0.14, cloudAmt: 0.85 });
      S['sky-overcast'] = lock(phaseToU('dusk', 0.30), { phase: 'dusk', t: 0.30, covBias: -0.11 });
      S['sky-release'] = () => { state.override = null; };
      /* measurement helpers: the falling petals read as bright specks all over
       * the frame, so any "how many stars are there" count has to be taken with
       * them off. Chaining other modules' scenarios by NAME (never by importing
       * them) keeps this inside this file. */
      S['sky-night-stars'] = () => { S['night']?.(); S['petals-off']?.(); };
      S['sky-night-raw'] = () => { S['night']?.(); S['petals-off']?.(); S['postfx-off']?.(); };
      S['sky-day-raw'] = () => { S['postfx-off']?.(); S['petals-off']?.(); };
      /* isolation switches — used to attribute a sky artefact to the right layer */
      S['sky-noclouds'] = () => { state.cloudAmt = 0.0; uni.uCloudAmt.value = 0.0; };
      /* A/B pair for "is the deck brighter or darker than the sky behind it".
       * Shoot `dusk` and `sky-dusk-nc` at the same warm and diff the two PNGs:
       * every pixel where they differ is cloud, and the second frame IS the sky
       * radiance behind it. That is the only honest way to measure the §2
       * backlit-cloud requirement through a bloom + grade chain. */
      S['sky-dusk-nc'] = () => { S['dusk']?.(); state.cloudAmt = 0.0; uni.uCloudAmt.value = 0.0; };
      S['sky-petals-off'] = () => { S['petals-off']?.(); };
      S['sky-sun-dim'] = () => { state.sunMul = 0.08; evalPalette(state.u); };
      S['sky-sun-off'] = () => { state.sunMul = 0.0; evalPalette(state.u); };
      S['sky-hide'] = () => { group.visible = false; };
      /* ── calibration sweeps ────────────────────────────────────────────
       * Every one of these is a single uniform mutated on a night/day lock, so
       * a target display luminance can be MEASURED in the finished graded png
       * and landed on instead of guessed at through ACES + bloom + grade. */
      const nightLock = () => { S['night']?.(); S['petals-off']?.(); };
      for (const v of [80, 100, 115, 130, 150, 180, 220, 330]) {
        S[`sky-moon-b${v}`] = () => { nightLock(); uni.uMoonBright.value = v / 100; };
      }
      for (const v of [22, 28, 34, 40, 50, 60, 70, 80]) {
        S[`sky-moon-m${v}`] = () => { nightLock(); uni.uMoonMaria.value = v / 100; };
      }
      for (const v of [0, 25, 50, 100, 175]) {
        S[`sky-moon-h${v}`] = () => { nightLock(); uni.uMoonHalo.value = v / 100; };
      }
      S['sky-moon-nohalo'] = () => { nightLock(); uni.uMoonHalo.value = 0; };
      for (const v of [0, 45, 66, 85, 100]) {
        S[`sky-ncloud${v}`] = () => { nightLock(); uni.uNightCloudV.value = v / 100; };
      }
      S['sky-ncloud-off'] = () => { nightLock(); uni.uCloudAmt.value = 0; state.cloudAmt = 0; };
      for (const v of [80, 100, 120, 140]) {
        S[`sky-cloud-lit${v}`] = () => { uni.uCloudLitK.value = v / 100; };
      }
      for (const v of [40, 48, 55, 62]) {
        S[`sky-cloud-shade${v}`] = () => { uni.uCloudShadeK.value = v / 100; };
      }
      for (const v of [55, 70, 85, 100]) {
        S[`sky-cloud-core${v}`] = () => { uni.uCloudCoreK.value = v / 100; };
      }
      for (const v of [55, 62, 70, 80, 100]) {
        S[`sky-cloud-form${v}`] = () => { uni.uCloudFormK.value = v / 100; };
      }
      /* moon disc size, in units of 1e-4 rad — 234 = 39 px radius at fov 36 */
      for (const v of [192, 210, 234, 260, 300]) {
        S[`sky-moon-s${v}`] = () => { nightLock(); uni.uMoonSize.value = v / 10000; };
      }
      for (const v of [0, 6, 12, 18, 26]) {
        S[`sky-milky${v}`] = () => { nightLock(); uni.uMilky.value = v / 100; };
      }
      for (const v of [0, 40, 62, 85]) {
        S[`sky-naer${v}`] = () => {
          nightLock();
          hillMats.forEach((m) => { m.uniforms.uNightAer.value = v / 100; });
        };
      }
      /* sun-side horizon band gain, swept on the dusk lock — this is the term
       * that blew the right half of the dusk frame to a flat cream plate */
      for (const v of [35, 50, 62, 80]) {
        S[`sky-hw${v}`] = () => { S['dusk']?.(); gradU.uHazeWarmK.value = v / 100; };
        S[`sky-hw${v}-day`] = () => { gradU.uHazeWarmK.value = v / 100; };
      }
      for (const v of [60, 75, 88, 100]) {
        S[`sky-mie${v}`] = () => {
          S['dusk']?.();
          state.mieMul = v / 100;
          evalPalette(state.u);
        };
      }
      for (let i = 0; i < 4; i++) {
        S['sky-layer' + i] = () => {
          uni.uAmtL.value.set(i === 0 ? CLOUD_A[0] : 0, i === 1 ? CLOUD_A[1] : 0,
            i === 2 ? CLOUD_A[2] : 0, i === 3 ? CLOUD_A[3] : 0);
        };
      }
    }

    /* ------------------------ published surface -------------------------- */
    ctx.assets.sky = {
      uniforms: uni,
      colors,
      noiseA: texA,
      noiseB: texB,
      noiseC: texC,
      gradScale,
      get u() { return state.u; },
      get phase() { return state.phase; },
      get nightMix() { return state.night; },
      sunDir: uSunDir.value,
      moonDir: uMoonDir.value,
      /** Live 1/world-unit extinction coefficient — match it and your module's
       *  aerial perspective agrees with the sky's by construction. */
      get aerialK() { return uAerialK.value; },
      /** Extra ground-level haze a low sun adds (0 at noon, ~0.62 at dusk). */
      get groundAerial() { return uGroundAerial.value; },
      /** Haze fraction at a distance, same law the hills and valley floor use. */
      aerialAt(dist) { return 1 - Math.exp(-dist * uAerialK.value); },
      /** Cheap CPU mirror of skyGradient() — for ambient / reflection tints. */
      sample(dir, out = new THREE.Color()) {
        const y = Math.max(0, Math.min(1, dir.y ?? 0));
        const t = Math.pow(y, gradU.uZenithPow.value);
        out.copy(colors.horizon).lerp(colors.zenith, t);
        out.lerp(colors.mid, (1 - Math.abs(t * 2 - 1)) * gradU.uMidAmt.value);
        out.multiplyScalar(1 + (gradU.uZenDeep.value - 1) * t);
        const hb = Math.exp(-Math.max(y, -0.06) / gradU.uHazeH.value);
        return out.lerp(colors.haze, Math.min(1, hb * gradU.uHazeAmt.value));
      },
    };

    let acc = 0;
    return {
      object3D: group,

      update(dt, time) {
        uni.uTime.value = time;
        dome.position.copy(ctx.camera.position);
        uCamPos.value.copy(ctx.camera.position);
        /* the cloud shader's alpha feather is authored in screen pixels, so it
         * needs the live angular pixel size — fov and height both change */
        const camH = Math.max(1, ctx.size?.h || 1080);
        const fovR = (ctx.camera.fov || 40) * Math.PI / 180;
        uni.uPxRad.value = 2 * Math.tan(fovR * 0.5) / camH;

        /* Authoritative clock first: the lighting rig publishes the phase NAME
         * and the progress inside it, which (unlike the sun's elevation) knows
         * whether a low sun is rising or setting — and, unlike a local copy of
         * its phase bounds, cannot drift out of step with the rig. */
        const pal = ctx.assets.lightRig?.palette;
        const dayT = pal?.dayT;
        if (!state.override && pal && typeof pal.phaseT === 'number' && pal.phase) {
          state.u = phaseToU(pal.phase, pal.phaseT);
        } else if (!state.override && typeof dayT === 'number') {
          state.u = uFromDayT(dayT);
        } else if (!state.phase && !state.override && !owned.uSunDir) {
          const el = uSunDir.value.y;
          const nm = owned.uNightMix ? 0 : uNightMix.value;
          let u;
          if (nm > 0.72) u = 0.97;
          else if (el < 0.02) u = nm > 0.35 ? 0.885 : 0.845;
          else u = 0.66 - Math.min(0.24, el * 0.30);   // higher sun → nearer midday
          state.u += (u - state.u) * Math.min(1, dt * 2.0);
        }

        acc += dt;
        if (acc > 0.05 || ctx.shotMode) {   // palette lerp is cheap but not free
          acc = 0;
          evalPalette(state.u);
          placeCelestials(state.u);
          placeMoonDisc();
        }
      },

      dispose() {
        offPhase?.();
        for (const d of disposables) d.dispose?.();
        if (ctx.assets.sky) delete ctx.assets.sky;
      },
    };
  },
};
