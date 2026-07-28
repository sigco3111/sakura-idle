import * as THREE from 'three';
import { fbm3 } from '../lib/noise.js';
import { makeRng, scatterDisc } from '../lib/rng.js';
import { WIND } from '../lib/wind.js';
import { createNprMaterial } from '../lib/lighting.js';
import {
  GROUND_VERT, GROUND_FRAG,
  GRASS_VERT, GRASS_FRAG,
  STONE_VERT, STONE_FRAG,
  makeGroundTextures, makeSpriteTextures,
} from '../lib/terrain-shaders.js';

/**
 * 20-terrain — the ground the tree stands on.
 *
 * Publishes  ctx.assets.terrain = {
 *   heightAt(x, z)     -> world Y of the ground surface (metres)
 *   normalAt(x, z)     -> THREE.Vector3 unit surface normal (allocates)
 *   normalInto(x,z,v)  -> same, writes into `v`, no allocation
 *   mesh               -> the ground THREE.Mesh
 *   radius             -> 118, the outer edge of the terrain disc
 *   grassRadius        -> radius the instanced grass covers
 *   treeBaseY          -> heightAt(0,0); the knoll summit the tree sits on
 *   path               -> [[x,z], ...] polyline of the mossy stone path
 *   pathWidth          -> 2.7 metres
 *   pathAt(t)          -> {x, z, y} a point along the path, t in 0..1
 *   distToPath(x,z)    -> metres to the path centreline (keep props off it)
 *   pond               -> { x, z, centre:Vector2, radius, waterY, bottomY }
 *   petalCoverage      -> 0..1 current fallen-petal density (bloom-driven)
 * }
 *
 * NOTE FOR THE TREE / PROPS / WATER MODULES: the ground is NOT at y = 0.
 * heightAt(0,0) is about 1.27 (the knoll summit). Offset anything you place by
 * ctx.assets.terrain.heightAt(x, z) — or by `treeBaseY` at the origin. The pond
 * water surface should sit at `pond.waterY`.
 *
 * Debug scenarios: `petal-carpet` (full fallen-petal cover), `petal-bare`.
 *
 * ART_BIBLE §5 "no empty pixel": the ground is a four-layer procedural blend
 * (lush grass / sun-bleached dry grass / earth+gravel path / moss) plus a
 * fallen-petal carpet that thickens toward the trunk, instanced grass blades
 * that bend in the ONE global wind field, and Poisson-disc scatter of pebbles,
 * clover, wildflowers and petal patches.
 *
 * Shadow policy: the terrain RECEIVES shadows but never casts. 08-lighting fits
 * the shadow ortho box to the union of visible casters, so making a 118 m disc
 * (or scatter out at r = 40) a caster would inflate that box and throw away the
 * texel density the tree's own shadow needs.
 */

/* ------------------------------------------------------------------ *
 * Height field — one function, used by the mesh, the macro texture bake,
 * every scatter placement, and every other module via ctx.assets.terrain.
 * ------------------------------------------------------------------ */
const R_TERRAIN = 118;
/** Pond dish. Centre is fixed by the scaffold's `pond` camera preset target. */
const POND = { x: -9, z: 6, radius: 6.2, depth: 0.62, sigma: 5.4 };
const PATH_WIDTH = 2.7;

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Gently rolling garden with a knoll under the tree, a shallow pond dish to the
 * west, and a rim that lifts toward the distant hills then tucks under the far
 * valley floor (y = -0.55, owned by 15-sky) past r = 102.
 */
function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const base = 0.62 + 1.45 * sstep(16, 78, r);
  const rollAmp = 0.36 + 0.92 * sstep(14, 70, r);
  const roll = fbm3(x * 0.0165, 0.7, z * 0.0165, 4) * rollAmp;
  const med = fbm3(x * 0.062, 4.2, z * 0.062, 3) * (0.09 + 0.20 * sstep(10, 60, r));
  // the knoll, plus a shallow ring hollow at r ~ 27 so the rise READS from a
  // near-horizontal camera without burying the tree base any deeper
  const knoll = 0.46 * Math.exp(-((r / 15.5) ** 2)) + 0.20 * Math.exp(-((r / 34) ** 2))
    - 0.34 * Math.exp(-(((r - 27) / 12) ** 2));
  const pd = Math.hypot(x - POND.x, z - POND.z);
  const basin = -POND.depth * Math.exp(-((pd / POND.sigma) ** 2));
  const h = base + roll + med + knoll + basin;
  const outer = sstep(78, 112, r);
  return h * (1 - outer) - 0.45 * outer;
}

const NEPS = 0.5;
function normalInto(x, z, out) {
  const hx = heightAt(x + NEPS, z) - heightAt(x - NEPS, z);
  const hz = heightAt(x, z + NEPS) - heightAt(x, z - NEPS);
  return out.set(-hx, 2 * NEPS, -hz).normalize();
}
function normalAt(x, z) { return normalInto(x, z, new THREE.Vector3()); }

/* ------------------------------------------------------------------ *
 * The mossy stone path — a Catmull-Rom arc past the tree. This is the
 * composition's leading line (critic axis 1). The waypoints were chosen by
 * back-projecting the hero frustum onto the ground: it enters the bottom-right
 * corner of the `hero` frame, sweeps in front of the trunk about 4.5 m clear of
 * it, skirts the pond's east shore and exits frame-left.
 * ------------------------------------------------------------------ */
const PATH_WAYPOINTS = [
  [25.0, -19.0], [18.5, -11.5], [10.5, -5.5], [3.6, -1.8],
  [-4.5, 3.0], [-14.0, 9.0], [-27.0, 12.0], [-42.0, 11.0],
];
const PATH_CURVE = new THREE.CatmullRomCurve3(
  PATH_WAYPOINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  false, 'catmullrom', 0.5,
);
const _pcv = new THREE.Vector3();
function pathPoint(t) {
  PATH_CURVE.getPoint(Math.min(1, Math.max(0, t)), _pcv);
  return [_pcv.x, _pcv.z];
}
const PATH_POLY = Array.from({ length: 81 }, (_, i) => pathPoint(i / 80));

function distToPath(x, z) {
  let best = 1e9;
  for (let k = 0; k < PATH_POLY.length - 1; k++) {
    const a = PATH_POLY[k], b = PATH_POLY[k + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const el = ex * ex + ez * ez || 1e-6;
    let t = ((x - a[0]) * ex + (z - a[1]) * ez) / el;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (a[0] + ex * t), dz = z - (a[1] + ez * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/* ------------------------------------------------------------------ *
 * Quality budgets
 * ------------------------------------------------------------------ */
const TIER = {
  ultra: { grid: 257, macro: 768, detail: 512, grassR: 70, chunks: 7, scatter: 1.0 },
  high: { grid: 225, macro: 640, detail: 512, grassR: 58, chunks: 7, scatter: 0.85 },
  medium: { grid: 161, macro: 512, detail: 256, grassR: 42, chunks: 5, scatter: 0.6 },
  low: { grid: 113, macro: 384, detail: 256, grassR: 20, chunks: 4, scatter: 0.38 },
};

/* ------------------------------------------------------------------ *
 * Geometry builders
 * ------------------------------------------------------------------ */

/**
 * A disc mesh whose vertex density is concentrated at the origin: an NxN grid is
 * mapped square -> disc (elliptical grid mapping, no pole singularity) then
 * radially warped by r^WARP. Gives ~9 cm spacing under the tree and ~1.4 m at
 * the rim in one seamless, single-draw-call mesh.
 */
function buildGroundGeometry(N, R, warp = 1.55) {
  const vn = N * N;
  const pos = new Float32Array(vn * 3);
  const nrm = new Float32Array(vn * 3);
  const tmp = new THREE.Vector3();
  for (let j = 0; j < N; j++) {
    const v = (j / (N - 1)) * 2 - 1;
    for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1;
      let x = u * Math.sqrt(Math.max(0, 1 - (v * v) / 2));
      let z = v * Math.sqrt(Math.max(0, 1 - (u * u) / 2));
      const r0 = Math.hypot(x, z);
      if (r0 > 1e-7) {
        const k = Math.pow(r0, warp - 1);
        x *= k; z *= k;
      }
      x *= R; z *= R;
      const o = (j * N + i) * 3;
      pos[o] = x; pos[o + 1] = heightAt(x, z); pos[o + 2] = z;
      normalInto(x, z, tmp);
      nrm[o] = tmp.x; nrm[o + 1] = tmp.y; nrm[o + 2] = tmp.z;
    }
  }
  const qn = (N - 1) * (N - 1);
  const idx = vn > 65535 ? new Uint32Array(qn * 6) : new Uint16Array(qn * 6);
  let w = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[w++] = a; idx[w++] = c; idx[w++] = b;
      idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * One grass blade: curved (bows forward), tapered to a point, with normals
 * fanned sideways so the blade reads as a rounded ribbon rather than a flat
 * card. Local space: y in [0,1] (scaled by per-instance height), x in
 * [-0.5,0.5] (scaled by per-instance width).
 */
function buildBladeGeometry(seg = 3) {
  const rows = seg + 1;
  const vn = rows * 2;
  const pos = new Float32Array(vn * 3);
  const nrm = new Float32Array(vn * 3);
  for (let i = 0; i < rows; i++) {
    const t = i / seg;
    const wHalf = 0.5 * Math.pow(1 - t, 0.62) * (1 - 0.10 * t);
    const bow = 0.44 * t * t;                     // forward droop, in HEIGHT units
    for (let s = 0; s < 2; s++) {
      const o = (i * 2 + s) * 3;
      const sx = s === 0 ? -wHalf : wHalf;
      pos[o] = i === seg ? 0 : sx;                // pinch the tip
      pos[o + 1] = t;
      pos[o + 2] = bow;
      // fan the normal outward from the blade centreline
      const fan = (s === 0 ? -1 : 1) * 0.55 * (1 - t * 0.4);
      const n = new THREE.Vector3(fan, 0.10 * t, -1).normalize();
      nrm[o] = n.x; nrm[o + 1] = n.y; nrm[o + 2] = n.z;
    }
  }
  const idx = [];
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** n cards rotated evenly about Y, each tilted `tilt` radians off vertical. */
function buildCardGeometry(n, tilt, w, h, lift = 0) {
  const pos = [], nrm = [], uv = [], idx = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const yaw = (k / n) * Math.PI * 2 + 0.4;
    e.set(tilt, yaw, 0, 'YXZ');
    q.setFromEuler(e);
    const base = pos.length / 3;
    const corners = [[-w / 2, 0, 0], [w / 2, 0, 0], [-w / 2, h, 0], [w / 2, h, 0]];
    const uvs = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (let c = 0; c < 4; c++) {
      v.set(corners[c][0], corners[c][1], corners[c][2]).applyQuaternion(q);
      pos.push(v.x, v.y + lift, v.z);
      v.set(0, 0, 1).applyQuaternion(q);
      nrm.push(v.x, v.y, v.z);
      uv.push(uvs[c][0], uvs[c][1]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** An irregular rock: an icosphere pushed around by low-frequency noise. */
function buildRockGeometry(detail = 1, seed = 3) {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + fbm3(x * 3.1 + seed, y * 3.1, z * 3.1, 3) * 0.42
      + fbm3(x * 7.7, y * 7.7, z * 7.7 + seed, 2) * 0.16;
    p.setXYZ(i, x * n, y * n * 0.86, z * n);
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */

export default {
  name: 'terrain',
  order: 20,

  async setup(ctx) {
    const group = new THREE.Group();
    group.name = 'terrain';
    const L = ctx.assets.lightUniforms ?? {};
    const WU = WIND?.uniforms ?? {};
    const tier = TIER[ctx.quality?.tier] ?? TIER.high;
    const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    const aniso = Math.min(16, Math.max(1, maxAniso));
    const disposables = [];

    /* ---------------- procedural textures ---------------- */
    const tex = makeGroundTextures({
      extent: R_TERRAIN + 4,
      heightAt,
      path: PATH_POLY,
      pathWidth: PATH_WIDTH,
      macroSize: tier.macro,
      detailSize: tier.detail,
      aniso,
      seed: 4211,
    });
    const sprites = makeSpriteTextures(ctx.quality?.tier === 'low' ? 64 : 128);
    for (const t of Object.values(tex)) disposables.push(t);
    for (const t of Object.values(sprites)) { t.anisotropy = aniso; disposables.push(t); }
    ctx.assets.textures.groundMacro = tex.macro;
    ctx.assets.textures.groundDetail = tex.detail;

    const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

    /* ---------------- ground ---------------- */
    const uPetalAmt = { value: 0.42 };
    const uCamPos = { value: new THREE.Vector3() };

    const groundMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
        uMacro: { value: tex.macro },
        uMacro2: { value: tex.macro2 },
        uDetail: { value: tex.detail },
        uDetailN: { value: tex.detailN },
        uMacroXf: { value: new THREE.Vector2(1 / (2 * (R_TERRAIN + 4)), 0.5) },
        uDetailTile: { value: new THREE.Vector2(1 / 2.6, 1 / 21.0) },
        uGrassBase: { value: C(0x39602F) },
        uGrassTip: { value: C(0x8FB463) },
        uGrassDry: { value: C(0xA3985C) },
        uEarth: { value: C(0x8B6C4C) },
        uEarthDark: { value: C(0x5A4634) },
        uMoss: { value: C(0x5C7A3E) },
        uStone: { value: C(0x9E9A92) },
        uPathEarth: { value: C(0x8E8270) },
        uPetalLo: { value: C(0xEE8CAF) },
        uPetalHi: { value: C(0xFFD9E6) },
        uPetalAmt,
        uBump: { value: 0.55 },
        ...L,
      },
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      lights: true,
      defines: { NPR_HAS_SHADOWMAP: '' },
      fog: false,
    });
    const groundGeo = buildGroundGeometry(tier.grid, R_TERRAIN);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.name = 'ground';
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.frustumCulled = false;
    ground.renderOrder = -10;
    group.add(ground);
    disposables.push(groundGeo, groundMat);

    /* ---------------- instanced grass ---------------- */
    const grassBlades = Math.max(2000, (ctx.quality?.grass ?? 60000) | 0);
    const grassR = tier.grassR;
    const rng = makeRng(90210);
    const CLUMP = 7;
    const clumpCount = Math.ceil(grassBlades / CLUMP);

    // per-chunk accumulation so distant chunks frustum-cull away
    const CH = tier.chunks;
    const chSize = (grassR * 2) / CH;
    const chunkData = Array.from({ length: CH * CH }, () => []);
    const chunkOf = (x, z) => {
      const i = Math.min(CH - 1, Math.max(0, Math.floor((x + grassR) / chSize)));
      const j = Math.min(CH - 1, Math.max(0, Math.floor((z + grassR) / chSize)));
      return j * CH + i;
    };

    let placed = 0;
    const tmpN = new THREE.Vector3();
    for (let c = 0; c < clumpCount * 4 && placed < grassBlades; c++) {
      // radial density: concentrated on the knoll, thinning outward, never zero
      // 18 % of the blades are reserved for the r < 13 core so the `bark` and
      // `hero` close-ups stay thick no matter how far the meadow reaches
      const rr = rng.next() < 0.18
        ? 13 * Math.sqrt(rng.next())
        : grassR * Math.pow(rng.next(), 0.72);
      const ang = rng.next() * Math.PI * 2;
      const cx = Math.cos(ang) * rr, cz = Math.sin(ang) * rr;
      // keep grass off the path and out of the pond dish
      const pdist = distToPath(cx, cz);
      if (pdist < PATH_WIDTH * 0.62 && rng.next() < 0.96) continue;
      if (pdist < PATH_WIDTH * 1.05 && rng.next() < 0.55) continue;   // ragged verge
      const pondD = Math.hypot(cx - POND.x, cz - POND.z);
      if (pondD < POND.radius * 0.86) continue;
      // dry / lush balance, same frequencies the macro map uses so the blades
      // agree with the ground texture underneath them
      const nL = fbm3(cx * 0.0135, 0.5, cz * 0.0135, 3);
      const nM = fbm3(cx * 0.082, 5.1, cz * 0.082, 3);
      const nF = fbm3(cx * 0.34, 9.7, cz * 0.34, 3);
      const dryness = Math.min(1, Math.max(0, 0.30 - nL * 0.8 + nM * 0.7));
      const lush = Math.min(1, Math.max(0, 0.66 + nL * 0.85 + nM * 0.34));
      // bare earth / worn patches: the four-layer ground blend has to be VISIBLE,
      // so the sward opens up wherever the macro map says earth or steep slope.
      normalInto(cx, cz, tmpN);
      const slope = 1 - tmpN.y;
      const bare = Math.min(1, Math.max(0, slope * 6.5 + nF * 0.55 + nM * 0.45 - 0.34));
      if (rng.next() < bare * 0.85) continue;

      // clump archetype: mown sward / tall seed-head tuft / short sparse
      const kind = rng.next();
      let clumpH, spread, nWant, widthLo, widthHi;
      if (kind < 0.20) {                       // tall wispy tuft
        clumpH = 0.52 + 0.34 * lush; spread = 0.06 + rng.next() * 0.09;
        nWant = 3 + Math.floor(rng.next() * 5); widthLo = 0.014; widthHi = 0.024;
      } else if (kind < 0.34) {                // short, cropped
        clumpH = 0.14 + 0.12 * lush; spread = 0.13 + rng.next() * 0.20;
        nWant = 6 + Math.floor(rng.next() * 8); widthLo = 0.020; widthHi = 0.034;
      } else {                                  // the ordinary sward
        clumpH = 0.24 + 0.30 * lush; spread = 0.10 + rng.next() * 0.17;
        nWant = 5 + Math.floor(rng.next() * 8); widthLo = 0.018; widthHi = 0.031;
      }
      // uncut meadow: tufts get taller and coarser the further they are from the
      // tended ground around the tree, so one blade covers more of the far field
      const wildness = sstep(18, 58, rr);
      clumpH *= (1 + rng.range(-0.12, 0.16)) * (1 + 0.55 * wildness);
      spread *= 1 + 0.75 * wildness;
      // one lean direction per clump so tufts are not a field of vertical needles
      const leanBias = rng.range(0.65, 1.55);
      const nBlades = Math.min(grassBlades - placed, nWant);
      for (let b = 0; b < nBlades; b++) {
        const ox = rng.gauss(0, spread), oz = rng.gauss(0, spread);
        const x = cx + ox, z = cz + oz;
        const y = heightAt(x, z);
        const dCentre = Math.hypot(ox, oz) / (spread * 2.2 + 1e-4);
        const rec = chunkData[chunkOf(x, z)];
        rec.push(
          x, y - 0.015, z, rng.next() * Math.PI * 2,                       // aOff
          clumpH * rng.range(0.58, 1.26), rng.range(widthLo, widthHi),
          rng.next(), leanBias * rng.range(0.82, 1.20),                    // aPar
          rng.next(), dryness * rng.range(0.45, 1.20),
          0.62 + 0.38 * Math.min(1, dCentre), rng.next(),                  // aVar
        );
        placed++;
      }
    }

    const bladeGeo = buildBladeGeometry(3);
    disposables.push(bladeGeo);
    const grassMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
        uCamPos,
        uFade: { value: new THREE.Vector3(20, 76, 0.58) },
        uBend: { value: 0.85 },
        uGrow: { value: 1 },
        uBaseCol: { value: C(0x3A5C31) },
        uMidCol: { value: C(0x5C8340) },
        uTipCol: { value: C(0x9CBE68) },
        uDryCol: { value: C(0xC2B478) },
        ...L,
        ...WU,
      },
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
      lights: true,
      defines: { NPR_HAS_SHADOWMAP: '' },
      fog: false,
      side: THREE.DoubleSide,
    });
    disposables.push(grassMat);

    const grassMeshes = [];
    for (let k = 0; k < chunkData.length; k++) {
      const rec = chunkData[k];
      const n = rec.length / 12;
      if (n < 1) continue;
      const aOff = new Float32Array(n * 4);
      const aPar = new Float32Array(n * 4);
      const aVar = new Float32Array(n * 4);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const s = i * 12;
        for (let q = 0; q < 4; q++) {
          aOff[i * 4 + q] = rec[s + q];
          aPar[i * 4 + q] = rec[s + 4 + q];
          aVar[i * 4 + q] = rec[s + 8 + q];
        }
        const x = rec[s], y = rec[s + 1], z = rec[s + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const g = bladeGeo.clone();
      g.instanceCount = n;
      g.setAttribute('aOff', new THREE.InstancedBufferAttribute(aOff, 4));
      g.setAttribute('aPar', new THREE.InstancedBufferAttribute(aPar, 4));
      g.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 4));
      const cxm = (minX + maxX) / 2, czm = (minZ + maxZ) / 2, cym = (minY + maxY) / 2 + 0.4;
      g.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(cxm, cym, czm),
        Math.hypot(maxX - minX, maxZ - minZ) / 2 + 1.6,
      );
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3(minX - 0.8, minY - 0.3, minZ - 0.8),
        new THREE.Vector3(maxX + 0.8, maxY + 1.4, maxZ + 0.8),
      );
      const m = new THREE.Mesh(g, grassMat);
      m.name = `grass-${k}`;
      m.receiveShadow = true;
      m.castShadow = false;
      m.frustumCulled = true;
      grassMeshes.push(m);
      group.add(m);
      disposables.push(g);
    }

    /* ---------------- stone materials ---------------- */
    const stoneUniforms = (mossAmt, noiseScale) => ({
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
      uStoneLite: { value: C(0x9E9A92) },
      uStoneDark: { value: C(0x6E6A62) },
      uMossLite: { value: C(0x6E8C48) },
      uMossDark: { value: C(0x3F5A2C) },
      uMossAmt: { value: mossAmt },
      uNoiseScale: { value: noiseScale },
      ...L,
    });
    const mkStoneMat = (mossAmt, noiseScale) => {
      const m = new THREE.ShaderMaterial({
        uniforms: stoneUniforms(mossAmt, noiseScale),
        vertexShader: STONE_VERT,
        fragmentShader: STONE_FRAG,
        lights: true,
      defines: { NPR_HAS_SHADOWMAP: '' },
        fog: false,
      });
      disposables.push(m);
      return m;
    };
    const pathStoneMat = mkStoneMat(0.62, 1.9);
    const pebbleMat = mkStoneMat(0.26, 3.4);

    const rockGeo = buildRockGeometry(ctx.quality?.tier === 'low' ? 0 : 1, 3.1);
    const slabGeo = buildRockGeometry(ctx.quality?.tier === 'low' ? 0 : 1, 7.7);
    disposables.push(rockGeo, slabGeo);

    /* ---------------- the mossy stone path ---------------- */
    const pathRng = makeRng(5150);
    let pathLen = 0;
    for (let k = 0; k < PATH_POLY.length - 1; k++) {
      pathLen += Math.hypot(PATH_POLY[k + 1][0] - PATH_POLY[k][0],
        PATH_POLY[k + 1][1] - PATH_POLY[k][1]);
    }
    const stoneCount = Math.max(24, Math.round(pathLen * 2.15 * tier.scatter));
    const pathStones = new THREE.InstancedMesh(slabGeo, pathStoneMat, stoneCount);
    pathStones.name = 'path-stones';
    pathStones.receiveShadow = true;
    pathStones.castShadow = false;
    pathStones.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3();
      const col = new THREE.Color();
      for (let i = 0; i < stoneCount; i++) {
        const t = (i + 0.5) / stoneCount;
        const [px, pz] = pathPoint(t);
        const [nx, nz] = pathPoint(Math.min(1, t + 0.01));
        const tx = nx - px, tz = nz - pz;
        const tl = Math.hypot(tx, tz) || 1;
        // three staggered lanes across the path so it reads as LAID slabs, not
        // a line of pebbles down the middle of a dirt track
        const lane = (i % 3) - 1;
        const lat = lane * (PATH_WIDTH * 0.32) + pathRng.range(-0.26, 0.26);
        const x = px - (tz / tl) * lat, z = pz + (tx / tl) * lat;
        const y = heightAt(x, z);
        normalInto(x, z, up);
        e.set(up.z * 0.5 + pathRng.range(-0.06, 0.06), pathRng.next() * Math.PI * 2,
          -up.x * 0.5 + pathRng.range(-0.06, 0.06), 'YXZ');
        q.setFromEuler(e);
        const w = pathRng.range(0.92, 1.62);
        s.set(w, pathRng.range(0.22, 0.40), w * pathRng.range(0.72, 1.10));
        p.set(x, y - s.y * 0.34, z);
        pathStones.setMatrixAt(i, m.compose(p, q, s));
        const g = pathRng.range(0.84, 1.14);
        col.setRGB(g * pathRng.range(0.96, 1.04), g, g * pathRng.range(0.94, 1.02));
        pathStones.setColorAt(i, col);
      }
      pathStones.instanceMatrix.needsUpdate = true;
      if (pathStones.instanceColor) pathStones.instanceColor.needsUpdate = true;
      pathStones.computeBoundingSphere();
    }
    group.add(pathStones);

    /* ---------------- pebbles + boulders ---------------- */
    const pebblePts = scatterDisc({
      radius: grassR * 0.92, minDist: 1.9, count: Math.round(300 * tier.scatter), seed: 21,
    }).filter(([x, z]) => Math.hypot(x - POND.x, z - POND.z) > POND.radius * 0.72);
    const boulderPts = scatterDisc({
      radius: 32, minDist: 6.5, count: Math.round(20 * tier.scatter), seed: 87, inner: 5.5,
    });
    const rockTotal = pebblePts.length + boulderPts.length;
    const rocks = new THREE.InstancedMesh(rockGeo, pebbleMat, Math.max(1, rockTotal));
    rocks.name = 'pebbles';
    rocks.receiveShadow = true;
    rocks.castShadow = false;
    {
      const rrng = makeRng(6612);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), s = new THREE.Vector3();
      const col = new THREE.Color();
      let i = 0;
      const put = (x, z, sc, sink) => {
        const y = heightAt(x, z);
        e.set(rrng.range(-0.3, 0.3), rrng.next() * Math.PI * 2, rrng.range(-0.3, 0.3), 'YXZ');
        q.setFromEuler(e);
        s.set(sc * rrng.range(0.7, 1.3), sc * rrng.range(0.5, 0.95), sc * rrng.range(0.7, 1.3));
        p.set(x, y - s.y * sink, z);
        rocks.setMatrixAt(i, m.compose(p, q, s));
        const g = rrng.range(0.80, 1.16);
        col.setRGB(g * rrng.range(0.95, 1.05), g, g * rrng.range(0.92, 1.03));
        rocks.setColorAt(i, col);
        i++;
      };
      for (const [x, z] of pebblePts) {
        const near = distToPath(x, z) < PATH_WIDTH * 1.5;
        put(x, z, (near ? 0.13 : 0.22) * rrng.range(0.7, 1.6), 0.34);
      }
      for (const [x, z] of boulderPts) put(x, z, rrng.range(1.5, 3.1), 0.26);
      rocks.count = i;
      rocks.instanceMatrix.needsUpdate = true;
      if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
      rocks.computeBoundingSphere();
    }
    group.add(rocks);

    /* ---------------- clover / leaf clumps ---------------- */
    const cloverGeo = buildCardGeometry(3, 0.62, 0.30, 0.24);
    const cloverMat = createNprMaterial({
      lightUniforms: L, color: 0xffffff, map: sprites.clover,
      translucency: 1.0, thickness: 0.75, specScale: 0.22, rimScale: 1.15,
      alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: false,
      shadowHue: 0.68,
    });
    disposables.push(cloverGeo, cloverMat);
    const cloverPts = scatterDisc({
      radius: Math.min(36, grassR * 0.62), minDist: 0.95,
      count: Math.round(700 * tier.scatter), seed: 33,
    });
    const clover = new THREE.InstancedMesh(cloverGeo, cloverMat, Math.max(1, cloverPts.length));
    clover.name = 'clover';
    clover.receiveShadow = true;
    clover.castShadow = false;
    {
      const crng = makeRng(3141);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), s = new THREE.Vector3();
      const col = new THREE.Color();
      let i = 0;
      for (const [x, z] of cloverPts) {
        if (distToPath(x, z) < PATH_WIDTH * 0.7) continue;
        if (Math.hypot(x - POND.x, z - POND.z) < POND.radius * 0.82) continue;
        e.set(crng.range(-0.16, 0.16), crng.next() * Math.PI * 2, crng.range(-0.16, 0.16), 'YXZ');
        q.setFromEuler(e);
        const sc = crng.range(0.72, 1.55);
        s.set(sc, sc * crng.range(0.8, 1.2), sc);
        p.set(x, heightAt(x, z) - 0.01, z);
        clover.setMatrixAt(i, m.compose(p, q, s));
        const g = crng.range(0.74, 1.16);
        col.setRGB(g * crng.range(0.94, 1.10), g, g * crng.range(0.82, 1.0));
        clover.setColorAt(i, col);
        i++;
      }
      clover.count = i;
      clover.instanceMatrix.needsUpdate = true;
      if (clover.instanceColor) clover.instanceColor.needsUpdate = true;
      clover.computeBoundingSphere();
    }
    group.add(clover);

    /* ---------------- wildflowers (warm white + pale yellow) ---------------- */
    const flowerGeo = buildCardGeometry(2, 0.10, 0.085, 0.085, 0.055);
    const flowerMeshes = [];
    const flowerPts = scatterDisc({
      radius: Math.min(32, grassR * 0.55), minDist: 1.15,
      count: Math.round(460 * tier.scatter), seed: 44,
    });
    [['flowerWhite', 0], ['flowerYellow', 1]].forEach(([key, parity]) => {
      const mat = createNprMaterial({
        lightUniforms: L, color: 0xffffff, map: sprites[key],
        translucency: 1.0, thickness: 0.9, specScale: 0.35, rimScale: 1.5,
        alphaTest: 0.40, side: THREE.DoubleSide, shadowHue: 0.42,
      });
      disposables.push(mat);
      const pts = flowerPts.filter((_, i) => i % 2 === parity);
      const im = new THREE.InstancedMesh(flowerGeo, mat, Math.max(1, pts.length));
      im.name = `flowers-${key}`;
      im.receiveShadow = true;
      im.castShadow = false;
      const frng = makeRng(700 + parity * 31);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), s = new THREE.Vector3();
      const col = new THREE.Color();
      let i = 0;
      for (const [x, z] of pts) {
        if (distToPath(x, z) < PATH_WIDTH * 0.75) continue;
        if (Math.hypot(x - POND.x, z - POND.z) < POND.radius * 0.85) continue;
        e.set(frng.range(-0.3, 0.3), frng.next() * Math.PI * 2, frng.range(-0.3, 0.3), 'YXZ');
        q.setFromEuler(e);
        const sc = frng.range(0.7, 1.5);
        s.setScalar(sc);
        p.set(x, heightAt(x, z) + 0.02, z);
        im.setMatrixAt(i, m.compose(p, q, s));
        const g = frng.range(0.9, 1.12);
        col.setRGB(g, g * frng.range(0.96, 1.02), g * frng.range(0.86, 1.0));
        im.setColorAt(i, col);
        i++;
      }
      im.count = i;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      flowerMeshes.push(im);
      group.add(im);
    });
    disposables.push(flowerGeo);

    /* ---------------- fallen petal patches ---------------- */
    const petalGeo = buildCardGeometry(1, Math.PI / 2 - 0.14, 0.058, 0.072, 0.009);
    const petalMat = createNprMaterial({
      // a petal LYING ON THE GROUND is not backlit thin foliage: a full
      // translucency + rim treatment blew every near-camera card to white paper.
      lightUniforms: L, color: 0xffffff, map: sprites.petal,
      translucency: 0.45, thickness: 0.55, specScale: 0.30, rimScale: 0.75,
      alphaTest: 0.40, side: THREE.DoubleSide, shadowHue: 0.30, shadowChroma: 1.0,
    });
    disposables.push(petalGeo, petalMat);
    const petalPts = scatterDisc({
      radius: 17, minDist: 0.235, count: Math.round(3400 * tier.scatter), seed: 55,
    });
    const petals = new THREE.InstancedMesh(petalGeo, petalMat, Math.max(1, petalPts.length));
    petals.name = 'fallen-petals';
    petals.receiveShadow = true;
    petals.castShadow = false;
    let petalMax = 0;
    {
      const prng = makeRng(9091);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), s = new THREE.Vector3();
      const col = new THREE.Color();
      // ART_BIBLE §3 sakura values, weighted AWAY from the specular white so the
      // carpet reads as petals lying in grass rather than scattered confetti.
      const shades = [0xFFD9E6, 0xFFD9E6, 0xFFB6CE, 0xFFB6CE, 0xFFB6CE,
        0xEE8CAF, 0xEE8CAF, 0xC25F86, 0xFFE7EE];
      // density falls off with radius: the carpet thickens under the canopy
      const ordered = petalPts
        .filter(([x, z]) => Math.hypot(x - POND.x, z - POND.z) > POND.radius * 0.78)
        .map(([x, z]) => [x, z, Math.hypot(x, z)])
        .filter((p) => prng.next() < Math.max(0.03, 1.30 - p[2] / 9.5))
        .sort((a, b) => a[2] - b[2]);
      let i = 0;
      for (const [x, z] of ordered) {
        e.set(prng.range(-0.26, 0.26), prng.next() * Math.PI * 2, prng.range(-0.26, 0.26), 'YXZ');
        q.setFromEuler(e);
        const sc = prng.range(0.66, 1.24);
        s.set(sc, sc, sc);
        p.set(x, heightAt(x, z) + 0.012, z);
        petals.setMatrixAt(i, m.compose(p, q, s));
        col.setHex(shades[Math.floor(prng.next() * shades.length)], THREE.SRGBColorSpace);
        petals.setColorAt(i, col);
        i++;
      }
      petalMax = i;
      petals.count = i;
      petals.instanceMatrix.needsUpdate = true;
      if (petals.instanceColor) petals.instanceColor.needsUpdate = true;
      petals.computeBoundingSphere();
    }
    group.add(petals);

    /* ---------------- published API ---------------- */
    const treeBaseY = heightAt(0, 0);
    const terrain = {
      heightAt,
      normalAt,
      normalInto,
      mesh: ground,
      radius: R_TERRAIN,
      grassRadius: grassR,
      treeBaseY,
      path: PATH_POLY,
      pathWidth: PATH_WIDTH,
      pathAt(t) {
        const [x, z] = pathPoint(Math.min(1, Math.max(0, t)));
        return { x, z, y: heightAt(x, z) };
      },
      distToPath,
      pond: {
        x: POND.x, z: POND.z, radius: POND.radius,
        centre: new THREE.Vector2(POND.x, POND.z),
        bottomY: heightAt(POND.x, POND.z),
        waterY: heightAt(POND.x, POND.z) + 0.30,
      },
      get petalCoverage() { return uPetalAmt.value; },
    };
    ctx.assets.terrain = terrain;

    /* ---------------- bloom-stage driven petal carpet ---------------- */
    let petalTarget = uPetalAmt.value;
    const offStage = ctx.bus.on('bloom:stage', (p) => {
      const st = Math.min(5, Math.max(0, p?.stage ?? 2));
      petalTarget = 0.10 + 0.17 * st;                 // 0.10 .. 0.95
    });

    const sc = window.__game?.scenarios;
    if (sc) {
      sc['petal-carpet'] = () => { petalTarget = 0.95; uPetalAmt.value = 0.95; };
      sc['petal-bare'] = () => { petalTarget = 0.06; uPetalAmt.value = 0.06; };
    }

    /* ---------------- frame update ---------------- */
    const camPos = uCamPos.value;
    return {
      object3D: group,
      update(dt) {
        if (ctx.camera) camPos.copy(ctx.camera.position);
        const a = Math.min(1, dt * 1.6);
        uPetalAmt.value += (petalTarget - uPetalAmt.value) * a;
        const frac = 0.30 + 0.70 * Math.min(1, uPetalAmt.value / 0.9);
        petals.count = Math.max(1, Math.round(petalMax * frac));
      },
      dispose() {
        offStage?.();
        if (ctx.assets.terrain === terrain) ctx.assets.terrain = null;
        for (const m of grassMeshes) m.geometry?.dispose?.();
        for (const d of disposables) d?.dispose?.();
        pathStones.dispose?.();
        rocks.dispose?.();
        clover.dispose?.();
        petals.dispose?.();
        for (const f of flowerMeshes) f.dispose?.();
      },
    };
  },
};
