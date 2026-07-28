import * as THREE from 'three';
import { makeRng } from '../lib/rng.js';
import { WIND } from '../lib/wind.js';
import { createLightUniforms } from '../lib/lighting.js';
import {
  HIST_N, HIST_DT, MAX_CYCLE,
  makePetalTexture, createPetalGeometry,
  PETAL_VERT, PETAL_FRAG,
} from '../lib/petal-shaders.js';

/**
 * 40-petals — the falling petal system. ART_BIBLE section 6.
 *
 * One draw call. Every petal's position, orientation, flex, size and life is a
 * closed-form function evaluated in the vertex shader; the CPU touches a petal
 * only when a burst is fired. Per frame the CPU does exactly one wind-vector
 * accumulation plus (every 0.30 s) a 128-texel float upload.
 *
 * Published for other modules:
 *   ctx.assets.petals = {
 *     burst(point, count, power),   // spawn a one-shot burst at a world point
 *     setDensity(mul),              // 0..1 multiplier on the ambient population
 *     count, capacity, mesh, material, texture,
 *   }
 * Consumed events: 'petals:burst' {point,count,power}, 'bloom:stage' {stage}.
 *
 * Debug scenarios (window.__game.scenarios): 'petals-off', 'petals-burst',
 * 'petals-storm'.
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* Per-instance albedo multipliers. The texture already carries the five
 * ART_BIBLE petal values as a base->tip ramp; these nudge each petal's
 * temperature and value so no two are identical without leaving the palette. */
const TINTS = [
  [1.00, 1.00, 1.00],   // as authored — the mid/light ramp
  [1.02, 0.955, 0.980], // a touch warmer
  [0.92, 0.890, 0.975], // cooler, reads as further away / in shade
  [1.00, 0.870, 0.925], // more saturated pink  (toward #FFB6CE / #EE8CAF)
  [0.80, 0.700, 0.790], // deep interior value  (toward #C25F86)
  [1.02, 1.010, 1.005], // near-white, the specular/edge value
];
const TINT_W = [0.22, 0.16, 0.16, 0.22, 0.16, 0.08];

function pickTint(r) {
  let acc = 0;
  const x = r();
  for (let i = 0; i < TINTS.length; i++) { acc += TINT_W[i]; if (x <= acc) return TINTS[i]; }
  return TINTS[0];
}

function toVec(p, out) {
  if (!p) return null;
  if (Array.isArray(p)) return out.set(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  if (typeof p.x === 'number') return out.set(p.x, p.y ?? 0, p.z ?? 0);
  // 30-tree's sampleBranchPoint() returns { point, dir, stiff, phase }
  if (p.point) return toVec(p.point, out);
  return null;
}

export default {
  name: 'petals',
  order: 40,

  async setup(ctx) {
    const L = ctx.assets.lightUniforms ?? createLightUniforms();
    const rng = makeRng(0x5A6C7A);
    const r = rng.next;

    const CAP = Math.max(120, Math.floor(ctx.quality.petals ?? 2400));
    const BURST_CAP = clamp(Math.round(CAP * 0.11), 60, 700);
    const AMBIENT = CAP - BURST_CAP;

    /* ---------------- geometry + per-instance attributes ---------------- */
    const geo = createPetalGeometry(THREE, 3, 4);

    const aSpawn = new Float32Array(CAP * 3);
    const aTiming = new Float32Array(CAP * 4);
    const aMotion = new Float32Array(CAP * 4);
    const aTumble = new Float32Array(CAP * 4);
    const aLook = new Float32Array(CAP * 4);
    const aTint = new Float32Array(CAP * 3);
    const aImpulse = new Float32Array(CAP * 3);

    /* ---------------- ground height field ---------------- */
    // Sampled from the terrain module if it has published heightAt(); otherwise a
    // flat y = 0 plane. Encoded 8-bit over [H_MIN, H_MIN + H_SPAN] so linear
    // filtering is core-guaranteed (no float-linear extension needed).
    const G_N = 96, G_HALF = 46, H_MIN = -2, H_SPAN = 10;
    const gData = new Uint8Array(G_N * G_N * 4);
    const groundTex = new THREE.DataTexture(gData, G_N, G_N, THREE.RGBAFormat);
    groundTex.colorSpace = THREE.NoColorSpace;
    groundTex.minFilter = groundTex.magFilter = THREE.LinearFilter;
    groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping;
    groundTex.generateMipmaps = false;
    let groundSampled = false;

    const encodeH = (h) => clamp(Math.round(((h - H_MIN) / H_SPAN) * 255), 0, 255);
    const fillFlatGround = () => {
      const b = encodeH(0);
      for (let i = 0; i < G_N * G_N; i++) { gData[i * 4] = b; gData[i * 4 + 3] = 255; }
      groundTex.needsUpdate = true;
    };
    fillFlatGround();

    const heightAt = () => ctx.assets.terrain?.heightAt ?? ctx.assets.terrain?.getHeight ?? null;
    function sampleGround() {
      const fn = heightAt();
      if (typeof fn !== 'function') return false;
      const step = (G_HALF * 2) / (G_N - 1);
      try {
        for (let j = 0; j < G_N; j++) {
          const z = -G_HALF + j * step;
          for (let i = 0; i < G_N; i++) {
            const x = -G_HALF + i * step;
            const h = fn(x, z);
            gData[(j * G_N + i) * 4] = encodeH(Number.isFinite(h) ? h : 0);
            gData[(j * G_N + i) * 4 + 3] = 255;
          }
        }
      } catch { fillFlatGround(); return false; }
      groundTex.needsUpdate = true;
      return true;
    }
    // CPU mirror, used when laying petals out at boot.
    const groundAt = (x, z) => {
      const fn = heightAt();
      if (typeof fn !== 'function') return 0;
      try { const h = fn(x, z); return Number.isFinite(h) ? h : 0; } catch { return 0; }
    };
    groundSampled = sampleGround();

    /* ---------------- where petals are born ---------------- */
    const tree = ctx.assets.tree ?? null;
    const _tmp = new THREE.Vector3();
    const canopyCentre = new THREE.Vector3(0, 10.0, 0);
    let canopyRx = 5.8, canopyRy = 3.3;
    if (tree) {
      // 30-tree publishes canopyBounds as a THREE.Sphere and canopyBox as a Box3
      const c = toVec(tree.canopyBounds?.center ?? tree.canopyCenter ?? tree.canopyCentre, _tmp);
      if (c) canopyCentre.copy(c);
      const cr = tree.canopyBounds?.radius ?? tree.canopyRadius;
      if (Number.isFinite(cr) && cr > 1) { canopyRx = cr * 0.94; canopyRy = cr * 0.56; }
    }
    const tips = Array.isArray(tree?.branchTips) && tree.branchTips.length ? tree.branchTips : null;
    const sampleFn = typeof tree?.sampleBranchPoint === 'function' ? tree.sampleBranchPoint : null;

    const out = new THREE.Vector3();
    function canopyPoint() {
      // 1. the tree module's own branch sampler
      if (sampleFn) {
        try { const p = toVec(sampleFn(rng), out); if (p) return p; } catch { /* fall through */ }
      }
      // 2. its published branch tips, jittered
      if (tips) {
        const p = toVec(tips[Math.floor(r() * tips.length)], out);
        if (p) return p.set(p.x + rng.gauss(0, 0.42), p.y + rng.gauss(0, 0.34), p.z + rng.gauss(0, 0.42));
      }
      // 3. a canopy-shaped shell (biased outward — petals detach from the edges)
      const [dx, dy, dz] = rng.sphere();
      const k = Math.pow(r(), 0.40);
      return out.set(canopyCentre.x + dx * canopyRx * k,
        canopyCentre.y + dy * canopyRy * k,
        canopyCentre.z + dz * canopyRx * k);
    }

    function driftPoint() {
      // Petals blowing through from off-stage: keeps every depth of the frame
      // populated instead of a single column of confetti over the tree.
      const [px, pz] = rng.disc(36, 6.0);
      return out.set(px, rng.range(2.4, 17.5), pz);
    }

    /* ---------------- lay out the population ---------------- */
    function writeAmbient(i) {
      // 30% of the population is not shed by this tree at all — it blows through
      // from off-stage. Measured: 22% left the mid-field bare, 42% built a veil
      // of near-camera bokeh across the hero frame. 30% fills every depth without
      // fogging the composition.
      const drifter = r() < 0.30;
      const p = drifter ? driftPoint() : canopyPoint();

      const big = r() < 0.020;
      const size = big ? rng.range(0.21, 0.33) : rng.range(0.088, 0.165);
      const vTerm = clamp(0.58 + r() * 0.42 + size * 0.90, 0.55, 1.28);
      const g0 = groundAt(p.x, p.z);
      const tFall = clamp((p.y - g0) / vTerm, 1.5, 20.0);
      // Short rests: 20-terrain already paints a fallen-petal carpet into the
      // ground material, so the 3D resting population only has to sell the
      // land -> rest -> gust pick-up beat, not carpet the knoll.
      let tRest = 1.2 + r() * 2.4;
      const tLift = 2.4 + r() * 2.6;
      if (tFall + tRest + tLift > MAX_CYCLE) tRest = Math.max(1.0, MAX_CYCLE - tFall - tLift);
      const cyc = tFall + tRest + tLift;

      aSpawn[i * 3] = p.x; aSpawn[i * 3 + 1] = p.y; aSpawn[i * 3 + 2] = p.z;
      aTiming[i * 4] = -r() * cyc;      // negative birth -> already mid-cycle at t=0
      aTiming[i * 4 + 1] = cyc;
      aTiming[i * 4 + 2] = tFall;
      aTiming[i * 4 + 3] = tRest;

      aMotion[i * 4] = vTerm;
      aMotion[i * 4 + 1] = rng.range(1.55, 3.5);                 // flutter frequency
      aMotion[i * 4 + 2] = rng.range(0.20, 0.50) + size * 0.90;  // flutter amplitude
      aMotion[i * 4 + 3] = rng.range(0.35, 1.7);                 // wind coupling

      aTumble[i * 4] = rng.sign() * rng.range(0.85, 2.7);
      aTumble[i * 4 + 1] = rng.sign() * rng.range(0.45, 2.0);
      aTumble[i * 4 + 2] = rng.sign() * rng.range(0.30, 1.5);
      aTumble[i * 4 + 3] = r() * TAU;

      aLook[i * 4] = size;
      aLook[i * 4 + 1] = rng.range(0.86, 1.20);                  // width variety
      aLook[i * 4 + 2] = 0;                                      // looping
      aLook[i * 4 + 3] = r() < 0.09 ? rng.range(2.0, 3.4) : rng.range(0.78, 1.28);

      // A discrete palette pick times a continuous value spread. Without the
      // value spread the airborne mass reads as one pale tone even though every
      // individual petal measures on-palette; ART_BIBLE section 3 wants all five
      // sakura values present in the frame at once.
      const t = pickTint(r);
      const vm = rng.range(0.80, 1.06);
      aTint[i * 3] = t[0] * vm; aTint[i * 3 + 1] = t[1] * vm; aTint[i * 3 + 2] = t[2] * vm;

      // a small detach kick away from the trunk axis
      const hl = Math.hypot(p.x - canopyCentre.x, p.z - canopyCentre.z) || 1;
      const kick = drifter ? 0 : rng.range(0.05, 0.45);
      aImpulse[i * 3] = ((p.x - canopyCentre.x) / hl) * kick;
      aImpulse[i * 3 + 1] = drifter ? 0 : rng.range(-0.10, 0.22);
      aImpulse[i * 3 + 2] = ((p.z - canopyCentre.z) / hl) * kick;
    }

    for (let i = 0; i < BURST_CAP; i++) {
      // dead one-shot slots: birth far in the past so alive() is 0
      aTiming[i * 4] = -1e6; aTiming[i * 4 + 1] = 1; aTiming[i * 4 + 2] = 0.5; aTiming[i * 4 + 3] = 0.2;
      aMotion[i * 4] = 0.8; aMotion[i * 4 + 1] = 2; aMotion[i * 4 + 2] = 0.2; aMotion[i * 4 + 3] = 1;
      aLook[i * 4] = 0.16; aLook[i * 4 + 1] = 1; aLook[i * 4 + 2] = 1; aLook[i * 4 + 3] = 1;
      aTint[i * 3] = aTint[i * 3 + 1] = aTint[i * 3 + 2] = 1;
    }
    for (let i = BURST_CAP; i < CAP; i++) writeAmbient(i);

    const attrs = {
      aSpawn: new THREE.InstancedBufferAttribute(aSpawn, 3),
      aTiming: new THREE.InstancedBufferAttribute(aTiming, 4),
      aMotion: new THREE.InstancedBufferAttribute(aMotion, 4),
      aTumble: new THREE.InstancedBufferAttribute(aTumble, 4),
      aLook: new THREE.InstancedBufferAttribute(aLook, 4),
      aTint: new THREE.InstancedBufferAttribute(aTint, 3),
      aImpulse: new THREE.InstancedBufferAttribute(aImpulse, 3),
    };
    for (const [k, v] of Object.entries(attrs)) { v.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, v); }
    geo.instanceCount = CAP;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 60);

    /* ---------------- wind displacement history ---------------- */
    // D(t) = integral of the shared wind field. The last HIST_N * HIST_DT seconds
    // live in a ring buffer so the vertex shader can take exact definite
    // integrals over any petal's airborne intervals (see petal-shaders.js).
    const hist = new Float32Array(HIST_N * 4);
    const driftTex = new THREE.DataTexture(hist, HIST_N, 1, THREE.RGBAFormat, THREE.FloatType);
    driftTex.colorSpace = THREE.NoColorSpace;
    driftTex.minFilter = driftTex.magFilter = THREE.NearestFilter;
    driftTex.wrapS = driftTex.wrapT = THREE.ClampToEdgeWrapping;
    driftTex.generateMipmaps = false;
    driftTex.needsUpdate = true;

    const drift = new THREE.Vector3();
    let head = 0, headAge = 0;
    {
      // Seed the history with a plausible past so petals that are already old at
      // t = 0 are not all sitting exactly under their spawn point.
      const w0 = WIND.at(0, 7, 0);
      for (let i = 0; i < HIST_N; i++) {
        const k = ((0 - i) % HIST_N + HIST_N) % HIST_N;
        hist[k * 4] = -w0.x * i * HIST_DT;
        hist[k * 4 + 1] = -w0.y * i * HIST_DT;
        hist[k * 4 + 2] = -w0.z * i * HIST_DT;
      }
    }

    /* ---------------- material ---------------- */
    const petalTex = makePetalTexture(THREE, 128);

    const own = {
      uMap: { value: petalTex },
      uAlphaTest: { value: 0.42 },
      uTime: { value: 0 },
      uSizeMul: { value: 1.0 },
      uDriftScale: { value: 0.42 },
      uSwirl: { value: 0.22 },
      uLiftAmp: { value: 0.55 },
      uFlutterMul: { value: 1.0 },
      // Translucency stays high (backlit sakura MUST glow — ART_BIBLE section 2)
      // but the additive rim/spec were what washed petals to (253,238,232) white.
      uTranslucency: { value: 0.90 },
      uThickness: { value: 0.32 },
      uSpecScale: { value: 0.45 },
      uRimScale: { value: 0.70 },
      uDriftTex: { value: driftTex },
      uDriftNow: { value: drift },
      uHeadIdx: { value: 0 },
      uHeadAge: { value: 0 },
      uGroundTex: { value: groundTex },
      uGroundArea: { value: groundSampled
        ? new THREE.Vector4(-G_HALF, -G_HALF, 1 / (G_HALF * 2), 1 / (G_HALF * 2))
        : new THREE.Vector4(1e7, 1e7, 1, 1) },
      uGroundRange: { value: new THREE.Vector2(H_MIN, H_SPAN) },
      uGroundFlat: { value: 0 },
      uCenter: { value: new THREE.Vector3(0, 0, 0) },
      uFadeRadius: { value: 38 },
    };

    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
    Object.assign(uniforms, own);
    // Shared bags last and by reference — never cloned, never reassigned.
    Object.assign(uniforms, L, WIND.uniforms);

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PETAL_VERT,
      fragmentShader: PETAL_FRAG,
      lights: true,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      fog: false,
    });
    material.userData.isNpr = true;

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'petals';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    /* ---------------- density ---------------- */
    let stageMul = 1.0, userMul = 1.0;
    const recount = () => {
      geo.instanceCount = BURST_CAP + Math.round(AMBIENT * clamp(stageMul * userMul, 0, 1));
    };

    /* ---------------- bursts ---------------- */
    let cursor = 0;
    const bp = new THREE.Vector3();

    function writeBurst(i, px, py, pz, power) {
      const [ux, uy, uz] = rng.sphere();
      const size = r() < 0.10 ? rng.range(0.20, 0.31) : rng.range(0.080, 0.165);
      const vTerm = clamp(0.60 + r() * 0.45 + size * 0.55, 0.55, 1.30);
      const spd = rng.range(1.1, 3.6) * power;
      const ix = ux * spd, iz = uz * spd;
      const iy = Math.abs(uy) * spd * 0.75 + rng.range(0.5, 2.1) * power;

      const g0 = groundAt(px, pz);
      const apex = py + iy / 1.7;
      const tFall = clamp((apex - g0) / vTerm + 0.7, 1.2, 19.0);
      let tRest = 2.6 + r() * 4.4;
      const tLift = 2.2 + r() * 2.4;
      if (tFall + tRest + tLift > MAX_CYCLE) tRest = Math.max(0.8, MAX_CYCLE - tFall - tLift);

      aSpawn[i * 3] = px + rng.gauss(0, 0.13);
      aSpawn[i * 3 + 1] = py + rng.gauss(0, 0.13);
      aSpawn[i * 3 + 2] = pz + rng.gauss(0, 0.13);

      aTiming[i * 4] = ctx.time;
      aTiming[i * 4 + 1] = tFall + tRest + tLift;
      aTiming[i * 4 + 2] = tFall;
      aTiming[i * 4 + 3] = tRest;

      aMotion[i * 4] = vTerm;
      aMotion[i * 4 + 1] = rng.range(1.9, 4.0);
      aMotion[i * 4 + 2] = rng.range(0.18, 0.46) + size * 0.5;
      aMotion[i * 4 + 3] = rng.range(0.7, 1.5);

      aTumble[i * 4] = rng.sign() * rng.range(1.4, 4.2);
      aTumble[i * 4 + 1] = rng.sign() * rng.range(0.8, 2.8);
      aTumble[i * 4 + 2] = rng.sign() * rng.range(0.5, 2.0);
      aTumble[i * 4 + 3] = r() * TAU;

      aLook[i * 4] = size;
      aLook[i * 4 + 1] = rng.range(0.86, 1.2);
      aLook[i * 4 + 2] = 1;                                  // one-shot
      aLook[i * 4 + 3] = r() < 0.16 ? rng.range(2.0, 3.4) : rng.range(0.8, 1.35);

      const t = pickTint(r);
      const vm = rng.range(0.82, 1.06);
      aTint[i * 3] = t[0] * vm; aTint[i * 3 + 1] = t[1] * vm; aTint[i * 3 + 2] = t[2] * vm;

      aImpulse[i * 3] = ix; aImpulse[i * 3 + 1] = iy; aImpulse[i * 3 + 2] = iz;
    }

    function flushRange(start, count) {
      if (count <= 0) return;
      attrs.aSpawn.addUpdateRange(start * 3, count * 3);
      attrs.aTiming.addUpdateRange(start * 4, count * 4);
      attrs.aMotion.addUpdateRange(start * 4, count * 4);
      attrs.aTumble.addUpdateRange(start * 4, count * 4);
      attrs.aLook.addUpdateRange(start * 4, count * 4);
      attrs.aTint.addUpdateRange(start * 3, count * 3);
      attrs.aImpulse.addUpdateRange(start * 3, count * 3);
    }

    function burst(point, count = 40, power = 1) {
      const p = toVec(point, bp);
      if (!p) return 0;
      const n = clamp(Math.round(count || 40), 1, BURST_CAP);
      const pw = clamp(Number.isFinite(power) ? power : 1, 0.25, 4);
      const start = cursor;
      for (let k = 0; k < n; k++) writeBurst((cursor + k) % BURST_CAP, p.x, p.y, p.z, pw);
      cursor = (cursor + n) % BURST_CAP;
      // up to two contiguous runs when the ring wraps
      const first = Math.min(n, BURST_CAP - start);
      flushRange(start, first);
      flushRange(0, n - first);
      for (const a of Object.values(attrs)) a.needsUpdate = true;
      return n;
    }

    /* ---------------- events + published API ---------------- */
    const offBurst = ctx.bus.on('petals:burst', (e) => {
      if (e?.point) burst(e.point, e.count ?? 40, e.power ?? 1);
    });
    const offStage = ctx.bus.on('bloom:stage', (e) => {
      const s = clamp(Number(e?.stage) || 0, 0, 5);
      stageMul = 0.42 + 0.58 * (s / 5);
      recount();
    });
    const offReady = ctx.bus.on('game:ready', () => {
      // the terrain module may only publish heightAt() late
      if (!groundSampled && sampleGround()) {
        groundSampled = true;
        own.uGroundArea.value.set(-G_HALF, -G_HALF, 1 / (G_HALF * 2), 1 / (G_HALF * 2));
      }
    });

    ctx.assets.petals = {
      burst,
      setDensity(mul) { userMul = clamp(Number(mul) || 0, 0, 1); recount(); },
      get count() { return geo.instanceCount; },
      capacity: CAP,
      burstCapacity: BURST_CAP,
      mesh, material, texture: petalTex,
    };

    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      window.__game.scenarios['petals-off'] = () => { userMul = 0; recount(); };
      window.__game.scenarios['petals-burst'] = () => burst({ x: 0.6, y: 8.4, z: 0.4 }, BURST_CAP, 1.6);
      window.__game.scenarios['petals-storm'] = () => {
        own.uSwirl.value = 0.42; own.uFlutterMul.value = 1.5; own.uDriftScale.value = 0.46;
      };
    }

    /* ---------------- per-frame: one vector add, one small upload ---------------- */
    const wv = new THREE.Vector3();
    return {
      object3D: mesh,
      update(dt, time) {
        own.uTime.value = time;

        // integrate the shared wind field once for the whole system
        wv.copy(WIND.at(0, 7, 0));
        drift.addScaledVector(wv, dt);
        headAge += dt;
        let pushed = false;
        while (headAge >= HIST_DT) {
          head = (head + 1) % HIST_N;
          hist[head * 4] = drift.x;
          hist[head * 4 + 1] = drift.y;
          hist[head * 4 + 2] = drift.z;
          hist[head * 4 + 3] = WIND.gust;
          headAge -= HIST_DT;
          pushed = true;
        }
        if (pushed) driftTex.needsUpdate = true;
        own.uHeadIdx.value = head;
        own.uHeadAge.value = headAge;
      },
      dispose() {
        offBurst(); offStage(); offReady();
        geo.dispose(); material.dispose();
        petalTex.dispose(); driftTex.dispose(); groundTex.dispose();
        if (ctx.assets.petals?.mesh === mesh) ctx.assets.petals = null;
      },
    };
  },
};
