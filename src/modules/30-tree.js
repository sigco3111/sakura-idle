import * as THREE from 'three';
import { makeRng } from '../lib/rng.js';
import { noise3 } from '../lib/noise.js';
import { WIND } from '../lib/wind.js';
import { createLightUniforms } from '../lib/lighting.js';
import {
  buildBarkTextures, buildBlossomAtlas,
  TRUNK_VERT, TRUNK_FRAG, TRUNK_DEPTH_VERT, DEPTH_FRAG,
  CANOPY_VERT, CANOPY_FRAG, CANOPY_DEPTH_VERT, CANOPY_DEPTH_FRAG,
  ATLAS_COLS, ATLAS_BLOSSOM_COUNT, ATLAS_SPARSE_FIRST, ATLAS_SPARSE_COUNT,
} from '../lib/tree-shaders.js';

/**
 * 30-tree.js — the hero asset: one ancient sakura.
 *
 * Trunk base at the world origin, ~14 units tall, crown centred near y=10 with
 * a radius of ~7.5. Everything here is seeded (src/lib/rng.js) so screenshots
 * are byte-reproducible.
 *
 * Structure
 *   1. A recursive branch SKELETON (5 levels: trunk -> 5 primary limbs ->
 *      secondaries -> tertiaries -> drooping twigs) plus surface roots. Branch
 *      direction integrates a noise-driven gnarl term and a per-level gravity
 *      droop, so nothing repeats and nothing looks fractal.
 *   2. One merged tube BufferGeometry for the whole woody structure, carrying
 *      aStiff (normalised distance from the root, drives wind), aPhase (per
 *      branch lag) and aCav (junction AO).
 *   3. ONE InstancedMesh of alpha-tested blossom-cluster cards distributed over
 *      the outer skeleton in three depth layers, so the crown reads as a volume
 *      with a dark interior and a rim-lit, broken-up outer edge.
 *
 * Published for other modules:
 *   ctx.assets.tree = { group, trunkMesh, canopyMeshes, branchTips,
 *                       canopyBounds, sampleBranchPoint, stage }
 */

const SEED = 0xC5A11;

/* ------------------------------------------------------------------ *
 * Bloom-stage response curves (GAME_DESIGN.md "Bloom stages")
 * ------------------------------------------------------------------ */
const STAGE = {
  coverage: [0.090, 0.245, 0.530, 1.000, 1.000, 1.000],
  budMix: [1.000, 0.620, 0.230, 0.045, 0.020, 0.000],
  lumin: [0.000, 0.000, 0.000, 0.015, 0.105, 0.195],
  gold: [0.000, 0.000, 0.000, 0.000, 0.045, 0.360],
  bare: [1.000, 0.480, 0.130, 0.000, 0.000, 0.000],
  moss: [0.520, 0.700, 0.860, 0.940, 0.940, 0.900],
};
const stageAt = (arr, s) => {
  const t = THREE.MathUtils.clamp(s, 0, 5);
  const i = Math.min(4, Math.floor(t));
  return THREE.MathUtils.lerp(arr[i], arr[i + 1], t - i);
};

/* ================================================================== *
 * 1. Skeleton
 * ================================================================== */

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function buildSkeleton() {
  const rng = makeRng(SEED);
  const branches = [];
  let maxDist = 1;

  /** Integrate one branch: gnarl + droop + a pull back toward its mean heading. */
  function grow(o) {
    const { start, dir, len, r0, r1, level, segs, droop, gnarl, keep } = o;
    const p = start.clone();
    const d = dir.clone().normalize();
    const mean = d.clone();
    const pts = [];
    let dist = o.dist0;
    const step = len / segs;
    const nSeed = rng.range(0, 60);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({
        p: p.clone(),
        // continuous taper with a slight bulge low down — real trunks are not cones
        r: THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.72)) * (1 + 0.055 * Math.sin(t * 7.3 + nSeed)),
        dist,
      });
      if (i === segs) break;
      // gnarl: a smooth 3D wander sampled along the branch path
      const gx = noise3(p.x * 0.42 + nSeed, p.y * 0.42, p.z * 0.42);
      const gy = noise3(p.x * 0.42 + 31.7, p.y * 0.42 + nSeed, p.z * 0.42);
      const gz = noise3(p.x * 0.42, p.y * 0.42 + 11.3, p.z * 0.42 + nSeed);
      d.x += gx * gnarl; d.y += gy * gnarl * 0.45; d.z += gz * gnarl;
      d.y -= droop * step;                       // gravity on the outer wood
      d.lerp(mean, 0.17).normalize();            // never wanders off entirely
      p.addScaledVector(d, step);
      dist += step;
    }
    const b = {
      pts, level,
      phase: rng.range(0, 1),
      dir: pts[pts.length - 1].p.clone().sub(pts[0].p).normalize(),
      rigid: !!o.rigid,
    };
    maxDist = Math.max(maxDist, dist);
    branches.push(b);
    if (keep) keep(b);
    return b;
  }

  /* ---- trunk: leaning, gnarled, taper 1.34 -> 0.50 ---------------- */
  const trunk = grow({
    start: V(0, -0.85, 0),
    dir: V(0.115, 1, -0.075),
    len: 7.62, r0: 1.34, r1: 0.50, level: 0, segs: 30,
    droop: 0, gnarl: 0.085, dist0: 0,
  });

  /* ---- surface roots: what makes the base read as ANCIENT ---------- */
  const rootAz = [0.35, 1.32, 2.30, 3.25, 4.15, 5.32];
  for (let i = 0; i < rootAz.length; i++) {
    const az = rootAz[i] + rng.range(-0.14, 0.14);
    grow({
      start: V(Math.cos(az) * 0.42, rng.range(0.18, 0.52), Math.sin(az) * 0.42),
      dir: V(Math.cos(az), rng.range(-0.34, -0.14), Math.sin(az)),
      len: rng.range(1.7, 3.1), r0: rng.range(0.40, 0.56), r1: 0.085,
      level: -1, segs: 8, droop: 0.10, gnarl: 0.14, dist0: 0, rigid: true,
    });
  }

  /* ---- helper: pick a point + outward frame on a parent branch ----- */
  function attach(parent, t) {
    const pts = parent.pts;
    const f = THREE.MathUtils.clamp(t, 0, 0.999) * (pts.length - 1);
    const i = Math.floor(f), fr = f - i;
    const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
    return {
      p: a.p.clone().lerp(b.p, fr),
      r: THREE.MathUtils.lerp(a.r, b.r, fr),
      dist: THREE.MathUtils.lerp(a.dist, b.dist, fr),
      tan: b.p.clone().sub(a.p).normalize(),
    };
  }

  const LEVELS = [
    // level 1 — primary limbs
    { kids: 3, lenF: [0.62, 0.80], tilt: [0.60, 0.98], droop: 0.028, gnarl: 0.135, segs: 14, rF: [0.56, 0.70] },
    // level 2 — secondaries
    { kids: 3, lenF: [0.66, 0.88], tilt: [0.48, 0.86], droop: 0.055, gnarl: 0.175, segs: 11, rF: [0.52, 0.68] },
    // level 3 — tertiaries
    { kids: 4, lenF: [0.46, 0.66], tilt: [0.42, 0.82], droop: 0.145, gnarl: 0.215, segs: 8, rF: [0.48, 0.66] },
    // level 4 — drooping twigs (sakura hangs)
    { kids: 4, lenF: [0.28, 0.50], tilt: [0.34, 1.05], droop: 0.520, gnarl: 0.46, segs: 6, rF: [0.36, 0.54] },
  ];

  const AXIS = new THREE.Vector3();
  const OUT = new THREE.Vector3();

  function spawnChildren(parent, level, parentLen) {
    const L = LEVELS[level - 1];
    if (!L) return;
    const kids = L.kids + (rng.next() < 0.42 ? 1 : 0);
    // stagger attachment heights so nothing reads as a Y-fork repeat
    for (let k = 0; k < kids; k++) {
      const t = 0.26 + (k / Math.max(1, kids)) * 0.64 + rng.range(-0.08, 0.09);
      const at = attach(parent, t);
      // outward = away from the trunk axis, so the crown opens up
      OUT.set(at.p.x, 0, at.p.z);
      if (OUT.lengthSq() < 1e-4) OUT.set(Math.cos(k * 2.4), 0, Math.sin(k * 2.4));
      OUT.normalize();
      const az = rng.range(0, Math.PI * 2);
      AXIS.set(Math.cos(az), rng.range(-0.25, 0.25), Math.sin(az)).normalize();
      const tilt = rng.range(L.tilt[0], L.tilt[1]);
      const d = at.tan.clone().applyAxisAngle(AXIS, tilt);
      // bias out and up, so limbs reach for the sky instead of collapsing inward
      d.addScaledVector(OUT, rng.range(0.30, 0.62));
      d.y += rng.range(0.18, 0.56) * (level <= 2 ? 1 : 0.62);
      d.normalize();
      const len = parentLen * rng.range(L.lenF[0], L.lenF[1]);
      const r0 = at.r * rng.range(L.rF[0], L.rF[1]);
      const child = grow({
        start: at.p, dir: d, len, r0,
        r1: Math.max(0.008, r0 * rng.range(0.24, 0.40) * (level >= 4 ? 0.45 : 1)),
        level, segs: L.segs, droop: L.droop, gnarl: L.gnarl, dist0: at.dist,
      });
      child.junction = true;
      if (level < 4) spawnChildren(child, level + 1, len);
    }
  }

  /* ---- 5 primary limbs off the upper trunk ------------------------- */
  const primT = [0.485, 0.585, 0.685, 0.795, 0.905];
  let az = rng.range(0, Math.PI * 2);
  for (let i = 0; i < primT.length; i++) {
    az += 2.39996 + rng.range(-0.55, 0.55);          // golden angle + jitter
    const at = attach(trunk, primT[i]);
    const tilt = THREE.MathUtils.lerp(1.10, 0.55, i / (primT.length - 1)) + rng.range(-0.12, 0.12);
    const d = V(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt)).normalize();
    const len = rng.range(4.5, 5.5);
    const r0 = at.r * rng.range(0.60, 0.76);
    const limb = grow({
      start: at.p, dir: d, len, r0, r1: r0 * rng.range(0.30, 0.42),
      level: 1, segs: 15, droop: 0.022, gnarl: 0.12, dist0: at.dist,
    });
    spawnChildren(limb, 2, len);
  }
  // the trunk's own leader keeps going too — asymmetric, not a clean fork
  {
    const at = attach(trunk, 0.985);
    const leadLen = 2.9;
    const lead = grow({
      start: at.p, dir: V(0.16, 1, -0.10), len: leadLen, r0: at.r * 0.82, r1: at.r * 0.26,
      level: 1, segs: 10, droop: 0.02, gnarl: 0.14, dist0: at.dist,
    });
    spawnChildren(lead, 2, leadLen);
  }

  return { branches, maxDist, rng };
}

/* ================================================================== *
 * 2. Tube geometry
 * ================================================================== */

const SIDES = { '-1': 7, 0: 22, 1: 14, 2: 10, 3: 8, 4: 6 };

function buildWoodGeometry(skel, detail) {
  const pos = [], nor = [], uvs = [], tan = [], sti = [], pha = [], cav = [];
  const idx = [];
  const flareRng = makeRng(SEED ^ 0x5b1);
  // root buttresses: a handful of angular lobes on the lowest 1.9 units
  const lobes = [];
  for (let i = 0; i < 7; i++) {
    lobes.push({ th: (i / 7) * Math.PI * 2 + flareRng.range(-0.30, 0.30), amp: flareRng.range(0.20, 0.50) });
  }
  const FLARE_H = 2.05;

  const N0 = new THREE.Vector3(), B0 = new THREE.Vector3(), T0 = new THREE.Vector3();
  const prevT = new THREE.Vector3(), rotAxis = new THREE.Vector3();
  const p = new THREE.Vector3(), dir = new THREE.Vector3();

  for (const br of skel.branches) {
    const sides = Math.max(4, Math.round(SIDES[br.level] * detail));
    const pts = br.pts;
    const stride = br.level >= 3 && detail < 0.85 ? 2 : 1;
    const ring = [];
    for (let i = 0; i < pts.length; i += stride) ring.push(pts[i]);
    if (ring[ring.length - 1] !== pts[pts.length - 1]) ring.push(pts[pts.length - 1]);
    if (ring.length < 2) continue;

    // ---- parallel-transport frame -----------------------------------
    T0.copy(ring[1].p).sub(ring[0].p).normalize();
    N0.set(0, 1, 0);
    if (Math.abs(N0.dot(T0)) > 0.92) N0.set(1, 0, 0);
    N0.crossVectors(T0, N0).normalize();
    B0.crossVectors(T0, N0).normalize();
    prevT.copy(T0);

    const rMid = ring[Math.floor(ring.length / 2)].r;
    const uRepeat = Math.max(1, Math.round(2 * Math.PI * rMid * 0.45));
    const start = pos.length / 3;

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[Math.min(ring.length - 1, i + 1)];
      const c = ring[Math.max(0, i - 1)];
      T0.copy(b.p).sub(c.p);
      if (T0.lengthSq() < 1e-10) T0.copy(prevT); else T0.normalize();
      // rotate the frame minimally from the previous tangent (no twist)
      rotAxis.crossVectors(prevT, T0);
      const s = rotAxis.length();
      if (s > 1e-6) {
        rotAxis.divideScalar(s);
        const ang = Math.atan2(s, prevT.dot(T0));
        N0.applyAxisAngle(rotAxis, ang).normalize();
      }
      B0.crossVectors(T0, N0).normalize();
      N0.crossVectors(B0, T0).normalize();
      prevT.copy(T0);

      const t = i / (ring.length - 1);
      const stiff = br.rigid ? 0 : THREE.MathUtils.clamp(a.dist / skel.maxDist, 0, 1);
      // junction AO: the first slice of a child branch sits in its own crotch
      const jc = br.junction ? THREE.MathUtils.smoothstep(t, 0.0, 0.16) * 0.55 + 0.45 : 1.0;

      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        dir.copy(N0).multiplyScalar(Math.cos(ang)).addScaledVector(B0, Math.sin(ang));
        let r = a.r;
        if (br.level === 0 && a.p.y < FLARE_H) {
          const fall = Math.pow(1 - THREE.MathUtils.clamp(a.p.y / FLARE_H, 0, 1), 1.75);
          const az = Math.atan2(dir.z, dir.x);
          let f = 1 + 0.30 * fall;
          for (const lo of lobes) {
            const cd = Math.cos(az - lo.th);
            if (cd > 0) f += lo.amp * Math.pow(cd, 4.0) * fall;
          }
          r *= f;
        }
        p.copy(a.p).addScaledVector(dir, r);
        pos.push(p.x, p.y, p.z);
        nor.push(dir.x, dir.y, dir.z);
        // circumferential tangent (needed for the tangent-space bark normal map)
        tan.push(-N0.x * Math.sin(ang) + B0.x * Math.cos(ang),
          -N0.y * Math.sin(ang) + B0.y * Math.cos(ang),
          -N0.z * Math.sin(ang) + B0.z * Math.cos(ang));
        uvs.push((k / sides) * uRepeat, a.dist * 0.42);
        sti.push(stiff);
        pha.push(br.phase);
        cav.push(jc);
      }
    }

    const cols = sides + 1;
    for (let i = 0; i < ring.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = start + i * cols + k;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aTangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aStiff', new THREE.Float32BufferAttribute(sti, 1));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(pha, 1));
  g.setAttribute('aCav', new THREE.Float32BufferAttribute(cav, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.08;      // wind sway headroom
  g.computeBoundingBox();
  return g;
}

/* ================================================================== *
 * 3. Blossom card geometry (a gently domed quad, not a flat plane)
 * ================================================================== */

function buildCardGeometry(res = 3) {
  const pos = [], nor = [], uvs = [], idx = [];
  const H = 0.5, BULGE = 0.185;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const u = i / res, v = j / res;
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;             // -1..1
      const z = BULGE * (1 - x * x) * (1 - y * y);
      pos.push(x * H, y * H, z);
      // analytic normal of z(x,y)
      const dzx = BULGE * (-2 * x) * (1 - y * y) / H;
      const dzy = BULGE * (1 - x * x) * (-2 * y) / H;
      const n = new THREE.Vector3(-dzx, -dzy, 1).normalize();
      nor.push(n.x, n.y, n.z);
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * (res + 1) + i, b = a + 1, c = a + res + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/* ================================================================== *
 * Module
 * ================================================================== */

export default {
  name: 'tree',
  order: 30,
  async setup(ctx) {
    const group = new THREE.Group();
    group.name = 'sakura-tree';
    group.rotation.y = 2.55;
    const L = ctx.assets.lightUniforms ?? createLightUniforms();
    const W = WIND.uniforms;
    const q = ctx.quality ?? {};
    const tier = q.tier ?? 'high';

    const DETAIL = { ultra: 1.0, high: 1.0, medium: 0.78, low: 0.58 }[tier] ?? 0.85;
    const CARDS = { ultra: 4300, high: 3100, medium: 1500, low: 560 }[tier] ?? 2600;
    const BARK_SIZE = { ultra: 1024, high: 768, medium: 512, low: 384 }[tier] ?? 768;
    const ATLAS_SIZE = { ultra: 2048, high: 2048, medium: 1024, low: 1024 }[tier] ?? 2048;
    const CARD_RES = tier === 'low' || tier === 'medium' ? 2 : 3;

    /* ---- textures ------------------------------------------------- */
    const bark = buildBarkTextures({ size: BARK_SIZE, seed: SEED });
    const atlas = buildBlossomAtlas({ size: ATLAS_SIZE, seed: SEED ^ 0x9e11 });
    const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    for (const t of [bark.albedo, bark.normal, atlas]) t.anisotropy = Math.min(8, maxAniso);
    ctx.assets.textures.treeBark = bark.albedo;
    ctx.assets.textures.treeBarkNormal = bark.normal;
    ctx.assets.textures.sakuraBlossom = atlas;

    /* ---- skeleton + wood ------------------------------------------ */
    const skel = buildSkeleton();
    const woodGeo = buildWoodGeometry(skel, DETAIL);

    const col = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    const trunkUniforms = {
      uBark: { value: bark.albedo },
      uBarkN: { value: bark.normal },
      uMossCol: { value: col(0x5C7A3E) },
      uGoldCol: { value: col(0xE8C56A) },
      uWetCol: { value: col(0x4A3B33) },
      uMossAmt: { value: STAGE.moss[3] },
      uGold: { value: 0 },
      uBare: { value: 0 },
      uDetailScale: { value: 4.3 },
      uMossDir: { value: new THREE.Vector3(-0.32, 0.14, -1.0).normalize() },
      uWindAmp: { value: 0.92 },
    };

    // A ShaderMaterial with lights:true MUST carry the whole UniformsLib.lights
    // block — the renderer writes its own light state into those objects and
    // markUniformsLightsNeedsUpdate() throws if any of them is missing. The
    // shared bags (L, W) go in AFTER the merge so nothing clones them.
    const lightsBlock = () => THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);

    const trunkMat = new THREE.ShaderMaterial({
      uniforms: { ...lightsBlock(), ...L, ...W, ...trunkUniforms },
      vertexShader: TRUNK_VERT,
      fragmentShader: TRUNK_FRAG,
      lights: true,
      side: THREE.FrontSide,
    });
    trunkMat.userData.noNpr = true;

    const trunkDepthMat = new THREE.ShaderMaterial({
      uniforms: { ...W, uWindAmp: trunkUniforms.uWindAmp },
      vertexShader: TRUNK_DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
    });

    const trunkMesh = new THREE.Mesh(woodGeo, trunkMat);
    trunkMesh.name = 'sakura-trunk';
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    trunkMesh.customDepthMaterial = trunkDepthMat;
    group.add(trunkMesh);

    /* ---- canopy anchors ------------------------------------------- */
    const rng = makeRng(SEED ^ 0x2f10c);
    const anchors = { outer: [], mid: [], inner: [] };
    const tips = [];
    for (const br of skel.branches) {
      if (br.level < 2) continue;
      const pts = br.pts;
      const last = pts[pts.length - 1];
      if (br.level >= 3) tips.push(last.p.clone());
      const bucket = br.level >= 4 ? anchors.outer : (br.level === 3 ? anchors.mid : anchors.inner);
      const from = br.level >= 4 ? 0.10 : 0.35;
      const n = br.level >= 4 ? 5 : (br.level === 3 ? 4 : 3);
      for (let i = 0; i < n; i++) {
        const t = from + (1 - from) * ((i + 0.5) / n);
        const f = t * (pts.length - 1);
        const j = Math.min(pts.length - 2, Math.floor(f));
        const fr = f - j;
        bucket.push({
          p: pts[j].p.clone().lerp(pts[j + 1].p, fr),
          d: br.dir,
          stiff: THREE.MathUtils.clamp(THREE.MathUtils.lerp(pts[j].dist, pts[j + 1].dist, fr) / skel.maxDist, 0, 1),
          phase: br.phase,
        });
      }
    }

    /* crown bounds from the anchor cloud (the crown IS the branch cloud) */
    const cCentre = new THREE.Vector3();
    const all = [...anchors.outer, ...anchors.mid, ...anchors.inner];
    for (const a of all) cCentre.add(a.p);
    cCentre.divideScalar(Math.max(1, all.length));
    let cRadius = 1;
    for (const a of all) cRadius = Math.max(cRadius, a.p.distanceTo(cCentre));

    /* ---- instances ------------------------------------------------ */
    const cardGeo = buildCardGeometry(CARD_RES);
    // the vertex shader scales cards by aInst2.z, so the geometry bound has to
    // cover the largest instance or the crown pops out of frustum at the edges
    cardGeo.computeBoundingSphere();
    cardGeo.boundingSphere.radius *= 2.2;
    const COUNT = CARDS;
    const inst = new THREE.InstancedMesh(cardGeo, null, COUNT);
    const aInst = new Float32Array(COUNT * 4);
    const aInst2 = new Float32Array(COUNT * 4);
    const aTint = new Float32Array(COUNT * 3);

    // three sakura tints; the deep one only appears in the crown interior
    const TINTS = [col(0xFFE6EF), col(0xFFD9E6), col(0xFFB6CE), col(0xEE8CAF), col(0xC25F86)];

    const mat4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion(), qRoll = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const ZP = new THREE.Vector3(0, 0, 1);
    const nrm = new THREE.Vector3(), out = new THREE.Vector3(), jit = new THREE.Vector3();
    const pp = new THREE.Vector3();

    const LAYERS = [
      { key: 'outer', frac: 0.62, push: [0.06, 0.50], ao: [0.88, 1.00], size: [0.74, 1.46], jitter: 0.60, lerpIn: [0.00, 0.06] },
      { key: 'mid', frac: 0.22, push: [-0.20, 0.22], ao: [0.58, 0.84], size: [0.78, 1.34], jitter: 0.70, lerpIn: [0.06, 0.22] },
      // The crown must read as a VOLUME: interior cards are pulled toward the
      // crown centre rather than just pushed a little way down their own branch,
      // because the mid-height interior has almost no twigs to hang off.
      { key: 'inner', frac: 0.16, push: [-0.30, 0.10], ao: [0.28, 0.54], size: [0.95, 1.62], jitter: 0.95, lerpIn: [0.28, 0.66] },
    ];

    let w = 0;
    for (let li = 0; li < LAYERS.length; li++) {
      const Ly = LAYERS[li];
      const src = anchors[Ly.key].length ? anchors[Ly.key] : all;
      const n = li === LAYERS.length - 1 ? COUNT - w : Math.round(COUNT * Ly.frac);
      for (let i = 0; i < n && w < COUNT; i++, w++) {
        const a = src[Math.floor(rng.next() * src.length)];
        out.copy(a.p).sub(cCentre);
        const rLen = Math.max(0.001, out.length());
        out.divideScalar(rLen);
        jit.set(rng.gauss(0, 0.42), rng.gauss(0, 0.34), rng.gauss(0, 0.42));
        pp.copy(a.p)
          .addScaledVector(out, rng.range(Ly.push[0], Ly.push[1]))
          .addScaledVector(jit, Ly.jitter);
        pp.lerp(cCentre, rng.range(Ly.lerpIn[0], Ly.lerpIn[1]));

        // a few strays live outside the shell so the silhouette is never smooth
        const stray = rng.next() < 0.045;
        if (stray) pp.addScaledVector(out, rng.range(0.5, 1.5));

        // face outward, tilted by the host twig, plus a healthy random wobble
        nrm.copy(out).multiplyScalar(0.68)
          .addScaledVector(a.d, rng.range(-0.34, 0.34))
          .add(jit.set(rng.gauss(0, 0.30), rng.gauss(0, 0.30), rng.gauss(0, 0.30)))
          .normalize();
        qt.setFromUnitVectors(ZP, nrm);
        qRoll.setFromAxisAngle(nrm, rng.range(0, Math.PI * 2));
        qt.premultiply(qRoll);

        // NOTE: the instance matrix stays unit-scaled. The card's size lives in
        // aInst2.z and is applied in the vertex shader, because the bloom-stage
        // growth animation has to scale it per frame without rewriting matrices.
        const size = rng.range(Ly.size[0], Ly.size[1]) * (stray ? 0.78 : 1);
        scl.set(1, 1, 1);
        mat4.compose(pp, qt, scl);
        inst.setMatrixAt(w, mat4);

        // growth order: the crown fills from the outside in and from the top
        // down, which is how a real tree opens (light reaches the tips first)
        const heightT = THREE.MathUtils.clamp((pp.y - (cCentre.y - cRadius)) / (2 * cRadius), 0, 1);
        const radialT = THREE.MathUtils.clamp(pp.distanceTo(cCentre) / cRadius, 0, 1);
        const order = THREE.MathUtils.clamp(
          0.80 - radialT * 0.52 - heightT * 0.26 + rng.range(-0.18, 0.18), 0.0, 0.99);

        aInst[w * 4 + 0] = a.phase;
        aInst[w * 4 + 1] = THREE.MathUtils.clamp(a.stiff * 1.06, 0, 1);
        aInst[w * 4 + 2] = order;
        aInst[w * 4 + 3] = rng.next();

        // tile: mostly full clusters, sparser ones on the silhouette edge
        const tile = (stray || rng.next() < 0.18)
          ? ATLAS_SPARSE_FIRST + Math.floor(rng.next() * ATLAS_SPARSE_COUNT)
          : Math.floor(rng.next() * ATLAS_BLOSSOM_COUNT);
        aInst2[w * 4 + 0] = tile;
        aInst2[w * 4 + 1] = rng.range(Ly.ao[0], Ly.ao[1]);
        aInst2[w * 4 + 2] = size;
        aInst2[w * 4 + 3] = rng.next();

        // tint: bright on the outside, deep in the interior, always coherent
        const ti = Ly.key === 'inner'
          ? 2 + Math.floor(rng.next() * 2)
          : (rng.next() < 0.10 ? 0 : (rng.next() < 0.50 ? 1 : (rng.next() < 0.88 ? 2 : 3)));
        const c = TINTS[ti];
        const j2 = rng.range(0.93, 1.06);
        aTint[w * 3 + 0] = c.r * j2;
        aTint[w * 3 + 1] = c.g * j2;
        aTint[w * 3 + 2] = c.b * j2;
      }
    }
    inst.count = w;
    cardGeo.setAttribute('aInst', new THREE.InstancedBufferAttribute(aInst, 4));
    cardGeo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(aInst2, 4));
    cardGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 3));

    const canopyUniforms = {
      uAtlas: { value: atlas },
      uTranslucency: { value: 0.50 },
      uThickness: { value: 0.52 },
      uAlphaTest: { value: 0.42 },
      uLumin: { value: 0 },
      uLuminCol: { value: col(0xFFC9DC) },
      uGold: { value: 0 },
      uGoldCol: { value: col(0xE8C56A) },
      uThroughGlow: { value: 0.40 },
      uGlowCol: { value: col(0xFFC3D6) },
      uCoverage: { value: 1 },
      uBudMix: { value: STAGE.budMix[3] },
      uCanopyCentre: { value: cCentre.clone() },
      uAtlasCols: { value: ATLAS_COLS },
      uNormalBlend: { value: 0.58 },
      uFlutter: { value: 0.035 },
      uWindAmp: { value: 1.05 },
    };

    const canopyMat = new THREE.ShaderMaterial({
      uniforms: { ...lightsBlock(), ...L, ...W, ...canopyUniforms },
      vertexShader: CANOPY_VERT,
      fragmentShader: CANOPY_FRAG,
      lights: true,
      side: THREE.DoubleSide,
    });
    canopyMat.userData.noNpr = true;

    const canopyDepthMat = new THREE.ShaderMaterial({
      uniforms: {
        ...W,
        uAtlas: canopyUniforms.uAtlas,
        uAlphaTest: canopyUniforms.uAlphaTest,
        uCoverage: canopyUniforms.uCoverage,
        uBudMix: canopyUniforms.uBudMix,
        uCanopyCentre: canopyUniforms.uCanopyCentre,
        uAtlasCols: canopyUniforms.uAtlasCols,
        uFlutter: canopyUniforms.uFlutter,
        uWindAmp: canopyUniforms.uWindAmp,
      },
      vertexShader: CANOPY_DEPTH_VERT,
      fragmentShader: CANOPY_DEPTH_FRAG,
      side: THREE.DoubleSide,
    });

    inst.material = canopyMat;
    inst.name = 'sakura-canopy';
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.customDepthMaterial = canopyDepthMat;
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius *= 1.22;
    group.add(inst);

    /* ---- published surface --------------------------------------- *
     * Everything above is built in the tree's LOCAL space, and the group
     * carries a yaw. Consumers (petals, VFX, gameplay) want WORLD space, so the
     * group transform is baked into everything published from here on.        */
    group.updateMatrix();
    const M = group.matrix.clone();
    const NM = new THREE.Matrix3().getNormalMatrix(M);
    const cCentreW = cCentre.clone().applyMatrix4(M);

    const canopyBounds = new THREE.Sphere(cCentreW.clone(), cRadius);
    const canopyBox = new THREE.Box3().setFromCenterAndSize(
      cCentreW, new THREE.Vector3(cRadius * 2, cRadius * 1.7, cRadius * 2));
    const anchorPool = all;
    const tipsWorld = tips.map((p) => p.clone().applyMatrix4(M));

    /**
     * A point on the outer branch structure — where petals are born and where
     * shake VFX originate. Pass a 0..1 number or an rng function.
     */
    function sampleBranchPoint(r) {
      const u = typeof r === 'function' ? r() : (typeof r === 'number' ? r : Math.random());
      const a = anchorPool[Math.min(anchorPool.length - 1, Math.floor(u * anchorPool.length))];
      return {
        point: a.p.clone().applyMatrix4(M),
        dir: a.d.clone().applyMatrix3(NM).normalize(),
        stiff: a.stiff,
        phase: a.phase,
      };
    }

    let stage = 3;
    const tree = {
      group,
      trunkMesh,
      canopyMeshes: [inst],
      branchTips: tipsWorld,
      canopyBounds,
      canopyBox,
      sampleBranchPoint,
      get stage() { return stage; },
      cardCount: w,
    };
    ctx.assets.tree = tree;
    ctx.clickTargets.push(trunkMesh, inst);

    /* ---- bloom stages -------------------------------------------- */
    let stageT = 3;              // smoothed
    let stageTarget = 3;
    function writeStage(s) {
      canopyUniforms.uCoverage.value = stageAt(STAGE.coverage, s);
      canopyUniforms.uBudMix.value = stageAt(STAGE.budMix, s);
      canopyUniforms.uLumin.value = stageAt(STAGE.lumin, s);
      canopyUniforms.uGold.value = stageAt(STAGE.gold, s) * 0.34;
      trunkUniforms.uGold.value = stageAt(STAGE.gold, s);
      trunkUniforms.uBare.value = stageAt(STAGE.bare, s);
      trunkUniforms.uMossAmt.value = stageAt(STAGE.moss, s);
    }
    writeStage(stageT);

    ctx.bus.on('bloom:stage', (p) => {
      const s = THREE.MathUtils.clamp(Math.round(p?.stage ?? 0), 0, 5);
      stage = s; stageTarget = s;
    });

    if (typeof window !== 'undefined' && window.__game) {
      const sc = window.__game.scenarios;
      for (let s = 0; s <= 5; s++) {
        sc[`stage${s}`] = () => { stage = s; stageTarget = s; stageT = s; writeStage(s); };
      }
      sc.treeCalm = () => { WIND.uniforms.uWindStrength.value = 0.25; };
      sc.treeGust = () => { WIND.uniforms.uWindStrength.value = 1.9; };
      // Judging tree GEOMETRY through a heavy depth-of-field is guesswork, so
      // this scenario borrows the other modules' own debug switches (resolved
      // lazily — they register after this module boots).
      sc['tree-clean'] = () => { sc['petals-off']?.(); sc['postfx-no-dof']?.(); };
    }

    /* ---- clicks: keep it minimal, gameplay lives in 60-game.js ---- */
    ctx.bus.on('world:click', (e) => {
      const o = e?.hit?.object;
      if (!o || (o !== trunkMesh && o !== inst)) return;
      ctx.bus.emit('tree:clicked', {
        point: e.point.clone(),
        worldNormal: e.hit.face
          ? e.hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(o.matrixWorld))
          : e.point.clone().sub(cCentreW).normalize(),
        power: 1,
      });
    });

    return {
      object3D: group,
      update(dt) {
        if (stageT !== stageTarget) {
          const k = 1 - Math.exp(-dt * 2.2);
          stageT += (stageTarget - stageT) * k;
          if (Math.abs(stageTarget - stageT) < 0.002) stageT = stageTarget;
          writeStage(stageT);
        }
      },
      dispose() {
        woodGeo.dispose();
        cardGeo.dispose();
        trunkMat.dispose(); trunkDepthMat.dispose();
        canopyMat.dispose(); canopyDepthMat.dispose();
        bark.dispose(); atlas.dispose();
        ctx.assets.tree = null;
        const i1 = ctx.clickTargets.indexOf(trunkMesh); if (i1 >= 0) ctx.clickTargets.splice(i1, 1);
        const i2 = ctx.clickTargets.indexOf(inst); if (i2 >= 0) ctx.clickTargets.splice(i2, 1);
      },
    };
  },
};
