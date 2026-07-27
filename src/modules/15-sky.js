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
 *   colors     { zenith, mid, horizon, haze, fog, cloudLit, cloudDark, sun, moon }
 *              live THREE.Color objects in LINEAR space, re-lerped every frame from
 *              the ART_BIBLE palette rows. Water/props can tint reflections with these.
 *   noiseA/B   the baked tiling fbm textures (R = height, GB = ∂H, A = warp/detail)
 *   gradScale  decode scale for the GB gradient channels
 *   u          current 0..1 position in the day cycle
 *   phase      last `time:phase` payload
 *   sunDir     the direction the sky believes the sun is in (shared with lighting if present)
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

/* per-layer cloud constants: x = lowest / nearest … w = cirrus
 *
 * The slab now uses a real 1/sin(elevation) ray length (see cloudLayer), so uv
 * per unit angle scales with hgt on its own — which is physically right: a
 * higher deck is further away, so its features subtend a smaller angle. The
 * scale therefore stays roughly CONSTANT across layers instead of shrinking
 * with height; shrinking it fought the perspective and flattened the deck. */
const CLOUD_H = [1.00, 1.75, 2.90, 6.20];
const CLOUD_S = [0.200, 0.140, 0.098, 0.052];
const CLOUD_V = [0.0210, 0.0165, 0.0125, 0.0085];
const CLOUD_P = [0.72, 0.58, 0.38, 0.10];
const CLOUD_B = [0.28, 0.23, 0.17, 0.09];
const CLOUD_W = [0.135, 0.110, 0.085, 0.055];
const CLOUD_T = [1.00, 1.10, 1.28, 1.95];   // uv stretch along the wind (cirrus streaks)
const CLOUD_A = [1.00, 0.82, 0.52, 0.26];   // per-layer opacity
const COV_BASE = [0.575, 0.622, 0.672, 0.748];
/* High-sky budget. The upper third of the frame must read as saturated sky, not
 * as a uniform cirrus smear (§8.2 / §8.11): above ~25° elevation each layer's
 * coverage threshold is RAISED (less of the noise field crosses it) and its
 * opacity scaled down, hardest on the cirrus deck. */
const CLOUD_ZC = [0.030, 0.080, 0.150, 0.240];
const CLOUD_ZA = [0.90, 0.72, 0.46, 0.30];

/* Per-band minimum haze fraction. The exponential law alone leaves the nearest
 * band at f≈0.24 at 122 m, which is not enough to kill its chroma — a fully
 * saturated tree line silhouetted against a cool sky is the single most
 * depth-destroying thing in the frame. */
const FOG_FLOOR = [0.30, 0.48, 0.64];

/* Per-band albedo VALUE. Distant hills must be a genuinely darker plane than the
 * sky they sit against, and each band must be a step lighter than the one in
 * front of it — with the bands all sharing one albedo the aerial term alone left
 * the whole horizon inside a 3/255 band, i.e. no depth ordering at all. */
const HILL_VALUE = [0.72, 0.80, 0.88];

/* Strength of the mist deck tucked into each range's foot. */
const MIST_AMT = [0.44, 0.38, 0.26];

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
    const { texA, texB, gradScale } = makeSkyNoiseTextures(THREE, N);
    disposables.push(texA, texB);
    ctx.assets.textures.skyNoiseA = texA;
    ctx.assets.textures.skyNoiseB = texB;

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
      uGradScale: { value: new THREE.Vector2(gradScale[0], gradScale[1]) },
      uTime: { value: 0 },

      uMoonDir, uFogColor, uShadowTint,

      ...WIND.uniforms,
      ...gradU,

      uGroundFade: { value: 1.0 },

      uSunTint: { value: colors.sun },
      uSunSize: { value: 0.019 },
      uSunI: { value: 17.0 },

      uCovL: { value: new THREE.Vector4(...COV_BASE) },
      uScaleL: { value: new THREE.Vector4(...CLOUD_S) },
      uSpeedL: { value: new THREE.Vector4(...CLOUD_V) },
      uHeightL: { value: new THREE.Vector4(...CLOUD_H) },
      uPuffL: { value: new THREE.Vector4(...CLOUD_P) },
      uBumpL: { value: new THREE.Vector4(...CLOUD_B) },
      uWarpL: { value: new THREE.Vector4(...CLOUD_W) },
      uStretchL: { value: new THREE.Vector4(...CLOUD_T) },
      uAmtL: { value: new THREE.Vector4(...CLOUD_A) },
      uZenCovL: { value: new THREE.Vector4(...CLOUD_ZC) },
      uZenAmtL: { value: new THREE.Vector4(...CLOUD_ZA) },
      uCloudLit: { value: colors.cloudLit },
      uCloudDark: { value: colors.cloudDark },
      uCloudAmb: { value: colors.cloudAmb },
      uCloudRim: { value: colors.cloudRim },
      uCloudAmt: { value: 1.0 },
      uCloudRimAmt: { value: 1.0 },

      uStars: { value: 0.0 },
      uMilky: { value: 0.19 },
      uMoonCol: { value: colors.moon },
      uMoonSize: { value: 0.030 },
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
    const BANDS = [
      // baseY sits just under the valley floor: a tall skirt would read as a
      // flat painted stripe, so each band only shows its ridge above the land.
      { // nearest — tree-lined crest
        radius: 122, segments: 1024, rows: 8, baseY: 2.2, hMin: 5.0, hMax: 21.0,
        ridgeBase: 20, ridgeOct: 4, treeAmp: 0.055, radiusJitter: 0.11,
        treeAmt: 1.0, ridgeFreq: 22.0, litMix: 0.0, seed: 91,
        phases: [0.0, 0.53], radMul: [1.0, 1.16], hMul: [1.0, 0.72],
      },
      { // middle
        radius: 252, segments: 640, rows: 7, baseY: 5.0, hMin: 15.0, hMax: 44.0,
        ridgeBase: 14, ridgeOct: 4, treeAmp: 0.018, radiusJitter: 0.10,
        treeAmt: 0.24, ridgeFreq: 16.0, litMix: 0.34, seed: 517,
        phases: [0.19, 0.74], radMul: [1.0, 1.12], hMul: [1.0, 0.78],
      },
      { // farthest — reaches the sky's own value almost completely
        radius: 432, segments: 512, rows: 6, baseY: 9.0, hMin: 30.0, hMax: 82.0,
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
      gradU.uMieAmt.value = lp(n0.mieAmt, n1.mieAmt);
      uAerialK.value = lp(n0.aerialK, n1.aerialK);
      uGroundAerial.value = lp(n0.gAer, n1.gAer);
      uni.uSunSize.value = lp(n0.sunSize, n1.sunSize);
      uni.uSunI.value = lp(n0.sunI, n1.sunI);
      const palStars = lp(n0.stars, n1.stars);

      for (let c = 0; c < 4; c++) {
        const v = COV_BASE[c] + (lp(k0.cov[c], k1.cov[c]) - 0.50) + state.covBias;
        uni.uCovL.value.setComponent(c, Math.min(0.995, Math.max(0.20, v)));
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
      /* isolation switches — used to attribute a sky artefact to the right layer */
      S['sky-noclouds'] = () => { state.cloudAmt = 0.0; uni.uCloudAmt.value = 0.0; };
      S['sky-hide'] = () => { group.visible = false; };
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

        // If lighting never emitted a phase but does own the sun, follow the sun
        // so the sky can never disagree with the key light.
        if (!state.phase && !state.override && !owned.uSunDir) {
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
