import * as THREE from 'three';
import { makeRng } from '../lib/rng.js';
import { SETTINGS } from '../lib/settings.js';
import { createLightUniforms } from '../lib/lighting.js';
import {
  makeQuadInstanced, makeShaftInstanced, makePetalGeometry,
  createRingMaterial, createSparkMaterial, createShaftMaterial, createGoldMaterial,
} from '../lib/vfx-shaders.js';

/**
 * 45-vfx — the feel layer: click feedback, reward set pieces, the Golden Petal.
 *
 * Everything is pooled and instanced. Four extra draw calls exist at most
 * (rings / sparks / shafts / golden petal) and each mesh is `visible = false`
 * while its pool is empty, so an idle frame costs nothing. Per-instance state is
 * written once at spawn into a ring buffer and animated closed-form in the
 * vertex shader — no CPU work and no allocation per frame.
 *
 * Screen-space elements (floating gain numbers, crit flash, stage-up wash) live
 * in their own DOM layers, deliberately OUTSIDE `#ui-root` so 65-ui owns that
 * subtree exclusively. There are two, because they need to sit on opposite sides
 * of the HUD in the z stack:
 *   #vfx-layer    z 9  — the full-screen wash and the calm vignette, UNDER the
 *                        HUD plate so a stage-up flash never bleaches the ink.
 *   #vfx-numbers  z 11 — the floating gain numbers, OVER the HUD plate, because
 *                        they fly INTO the bank counter and would otherwise be
 *                        clipped by the parchment on the last fifth of the arc.
 * Both mirror #ui-root's display so `--ui 0` hides everything.
 *
 * SHOT MODE vs CAPTURE MODE. Neither layer is created in shot mode (a screenshot
 * must not catch a half-faded number) unless a debug scenario asks for it — with
 * one exception: `window.__CAPTURE`, set by tools/capture.mjs, means "we are in
 * deterministic shot mode but live DOM feedback should render normally". Video
 * needs the click reward on camera; a still frame does not. See `suppressDom()`.
 * Everything the numbers animate from is the SIMULATION clock (`fxTime`, fed by
 * update(dt)), never Date.now() — under capture the page advances by one fixed
 * 1/30 s step per frame, so a wall-clock animation would freeze at a fixed age.
 *
 * Published:
 *   ctx.assets.vfx = {
 *     ring(point, opts), sparks(point, n, opts), shafts(origin, n, opts),
 *     number(amount, point, opts), flash(strength, warm, decay),
 *     shake(point, power), crit(point, amount), stageUp(stage),
 *     golden: { spawn(), catch(), hide(), active, position },
 *     timeScale, setHudAnchor(x, y), setMuted(m), format(n)
 *   }
 * Consumes: world:click, tree:clicked, petals:gain, petals:burst,
 *           upgrade:bought, bloom:stage.
 * Emits:    sfx {id}, vfx:golden {point, kind}.
 *
 * Accessibility — every motion and flash effect here is gated on the shared
 * `SETTINGS.motion` store (src/lib/settings.js), read FRESH at each call site so a
 * toggle lands on the next frame and never needs a reload. Camera kicks, the
 * stage-up push and the time-dilation lurch require `motion.shake`; the
 * full-screen washes require `motion.flashes`; petal bursts require
 * `motion.bursts`.
 *
 * Turning motion off must not turn the game into a corpse, so the physical kick
 * is *replaced* rather than deleted: `calmCue()` breathes a soft vignette inward
 * (edge opacity only — nothing translates or scales), the shockwave ring runs a
 * touch wider and longer, the spark count goes up and the floating gain number
 * scales up. Stage-up keeps its shockwave, shafts and title card and loses only
 * the push and the lurch.
 *
 * Debug scenarios: vfx-demo, vfx-crit, vfx-stage, vfx-golden, vfx-off,
 *                  vfx-motion-off, vfx-motion-on, vfx-shake-calm.
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function budgets(tier) {
  if (tier === 'low') return { rings: 10, sparks: 96, shafts: 8, numbers: 14 };
  if (tier === 'medium') return { rings: 16, sparks: 192, shafts: 10, numbers: 20 };
  return { rings: 24, sparks: 384, shafts: 14, numbers: 28 };
}

/* GAME_DESIGN "Number formatting": 4 significant figures, short suffixes. */
const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd'];
function fmt(n) {
  const v = Math.abs(Number(n) || 0);
  if (v < 1000) return v < 10 ? String(+v.toFixed(2)) : String(Math.round(v));
  const e = Math.floor(Math.log10(v) / 3);
  if (e >= SUFFIX.length) return v.toExponential(3).replace('e+', 'e');
  const m = v / Math.pow(1000, e);
  return (m >= 100 ? m.toFixed(1) : m >= 10 ? m.toFixed(2) : m.toFixed(3)) + SUFFIX[e];
}

/* Tints multiply the scene key colour inside the additive shaders, so these are
   relative temperatures, not absolute colours (ART_BIBLE section 3 families). */
const TINT = {
  petal: [1.00, 0.72, 0.82],    // #FFB6CE
  pale: [1.00, 0.92, 0.95],     // #FFF2F6
  gold: [1.00, 0.78, 0.36],     // #E8C56A
  goldHot: [1.00, 0.92, 0.68],
};

export default {
  name: 'vfx',
  order: 45,

  async setup(ctx) {
    const B = budgets(ctx.quality?.tier ?? 'high');
    const L = ctx.assets.lightUniforms ?? createLightUniforms();
    const rng = makeRng(0x5A47);
    const r = rng.next;

    /* ---------------- clock ---------------- */
    // Effects run on their own clock so the stage-up set piece can dilate time
    // without touching anybody else's dt.
    let fxTime = 0;
    let timeScale = 1;
    let dilateT = -1, dilateDur = 0;
    const uTime = { value: 0 };
    const uAgeOverride = { value: -1 };     // >=0 freezes every effect at a phase

    /* ---------------- accessibility gates ---------------- *
     * SETTINGS.motion is read at the moment of use, never captured here: a player
     * who is being made unwell by camera shake has to be free of it on the very
     * next click, and caching the flag at setup would make that a reload. */

    /**
     * Camera impulse, gated and scaled by the player's motion preference.
     * Returns false when nothing was applied, which is the caller's cue to pay the
     * feedback back some other way (see calmCue).
     */
    function kickCam(strength, opts) {
      const m = SETTINGS.motion;
      if (!m.shake) return false;
      const s = (Number(strength) || 0) * m.shakeScale;
      if (s <= 0) return false;
      ctx.assets.cameraRig?.kick?.(s, opts);
      return true;
    }

    /**
     * Petal burst — the game's core click feedback, so it survives reduced motion
     * unless `petalBursts` is switched off explicitly. With the camera kick gone it
     * also carries a little more of the hit.
     */
    function burst(point, count, power = 1) {
      if (!point) return false;
      const m = SETTINGS.motion;
      if (!m.bursts) return false;
      const k = m.shake ? 1 : 1.35;
      ctx.assets.petals?.burst?.(point, Math.round((count || 40) * k), power);
      return true;
    }

    /* ---------------- rings ---------------- */
    const ringGeo = makeQuadInstanced(B.rings);
    const aRingCenter = new Float32Array(B.rings * 3);
    const aRingData = new Float32Array(B.rings * 4);
    const aRingTint = new Float32Array(B.rings * 3);
    for (let i = 0; i < B.rings; i++) {
      aRingData[i * 4] = -1e6; aRingData[i * 4 + 1] = 1; aRingData[i * 4 + 2] = 1;
      aRingTint[i * 3] = aRingTint[i * 3 + 1] = aRingTint[i * 3 + 2] = 1;
    }
    const ringAttrs = {
      aCenter: new THREE.InstancedBufferAttribute(aRingCenter, 3),
      aRing: new THREE.InstancedBufferAttribute(aRingData, 4),
      aTint: new THREE.InstancedBufferAttribute(aRingTint, 3),
    };
    for (const k in ringAttrs) { ringAttrs[k].setUsage(THREE.DynamicDrawUsage); ringGeo.setAttribute(k, ringAttrs[k]); }
    const ringMat = createRingMaterial(L, { uTime, uAgeOverride, uGain: { value: 1 } });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.frustumCulled = false; ringMesh.renderOrder = 12;

    /* ---------------- sparks ---------------- */
    const sparkGeo = makeQuadInstanced(B.sparks);
    const aSpSpawn = new Float32Array(B.sparks * 3);
    const aSpVel = new Float32Array(B.sparks * 3);
    const aSpData = new Float32Array(B.sparks * 4);
    const aSpTint = new Float32Array(B.sparks * 3);
    for (let i = 0; i < B.sparks; i++) {
      aSpData[i * 4] = -1e6; aSpData[i * 4 + 1] = 1; aSpData[i * 4 + 2] = 0.05; aSpData[i * 4 + 3] = 1;
      aSpTint[i * 3] = aSpTint[i * 3 + 1] = aSpTint[i * 3 + 2] = 1;
    }
    const sparkAttrs = {
      aSpawn: new THREE.InstancedBufferAttribute(aSpSpawn, 3),
      aVel: new THREE.InstancedBufferAttribute(aSpVel, 3),
      aSpark: new THREE.InstancedBufferAttribute(aSpData, 4),
      aTint: new THREE.InstancedBufferAttribute(aSpTint, 3),
    };
    for (const k in sparkAttrs) { sparkAttrs[k].setUsage(THREE.DynamicDrawUsage); sparkGeo.setAttribute(k, sparkAttrs[k]); }
    const sparkMat = createSparkMaterial(L, { uTime, uAgeOverride, uGain: { value: 1 } });
    const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
    sparkMesh.frustumCulled = false; sparkMesh.renderOrder = 13;

    /* ---------------- light shafts ---------------- */
    const shaftGeo = makeShaftInstanced(B.shafts);
    const aShDir = new Float32Array(B.shafts * 3);
    const aShData = new Float32Array(B.shafts * 4);
    const aShTint = new Float32Array(B.shafts * 3);
    for (let i = 0; i < B.shafts; i++) {
      aShData[i * 4] = -1e6; aShData[i * 4 + 1] = 1; aShData[i * 4 + 2] = 1; aShData[i * 4 + 3] = 0.2;
      aShDir[i * 3 + 1] = 1;
      aShTint[i * 3] = aShTint[i * 3 + 1] = aShTint[i * 3 + 2] = 1;
    }
    const shaftAttrs = {
      aDir: new THREE.InstancedBufferAttribute(aShDir, 3),
      aShaft: new THREE.InstancedBufferAttribute(aShData, 4),
      aTint: new THREE.InstancedBufferAttribute(aShTint, 3),
    };
    for (const k in shaftAttrs) { shaftAttrs[k].setUsage(THREE.DynamicDrawUsage); shaftGeo.setAttribute(k, shaftAttrs[k]); }
    const uShaftOrigin = { value: new THREE.Vector3(0, 9, 0) };
    const shaftMat = createShaftMaterial(L, { uTime, uAgeOverride, uOrigin: uShaftOrigin, uGain: { value: 1 } });
    const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
    shaftMesh.frustumCulled = false; shaftMesh.renderOrder = 11;

    /* ---------------- the Golden Petal ---------------- */
    const goldGeo = makePetalGeometry();
    const uGoldGlow = { value: 1 };
    const goldMat = createGoldMaterial(L, { uTime, uGlow: uGoldGlow });
    const goldMesh = new THREE.Mesh(goldGeo, goldMat);
    goldMesh.scale.setScalar(1.05);
    goldMesh.position.set(0, 8, 0);
    goldMesh.frustumCulled = false; goldMesh.renderOrder = 6;
    // starts visible for exactly two frames so main.js's boot compile() builds
    // its program; the update loop hides it immediately afterwards.

    // A 0.66 m petal seen edge-on is impossible to hit: raycast a generous sphere.
    const hitSphere = new THREE.Sphere(new THREE.Vector3(), 1.05);
    const hitPoint = new THREE.Vector3();
    goldMesh.raycast = function (raycaster, intersects) {
      if (!this.visible) return;
      hitSphere.center.setFromMatrixPosition(this.matrixWorld);
      if (raycaster.ray.intersectSphere(hitSphere, hitPoint)) {
        intersects.push({
          distance: raycaster.ray.origin.distanceTo(hitPoint),
          point: hitPoint.clone(), object: this,
        });
      }
    };

    const group = new THREE.Group();
    group.name = 'vfx';
    group.add(ringMesh, sparkMesh, shaftMesh, goldMesh);
    ctx.clickTargets.push(goldMesh);

    /* ---------------- spawners ---------------- */
    let ringCur = 0, sparkCur = 0, shaftCur = 0;
    let ringUntil = -1, sparkUntil = -1, shaftUntil = -1;
    let muted = false;

    function ring(p, o = {}) {
      if (muted || !p) return;
      const i = ringCur; ringCur = (ringCur + 1) % B.rings;
      aRingCenter[i * 3] = p.x; aRingCenter[i * 3 + 1] = p.y; aRingCenter[i * 3 + 2] = p.z;
      const dur = o.dur ?? 0.62;
      // Energy normalisation. A ring's emissive output scales with its
      // circumference, and the post chain's wide multi-mip bloom turns a big
      // bright annulus into a filled white dome (measured: an 8.3 m stage-up ring
      // at gain 1.25 lifted the whole 650 px interior to R=248). Fade the gain
      // with radius so a 1.8 m shake ring and an 11 m stage-up ring put roughly
      // the same amount of light into the frame.
      const rad = o.radius ?? 1.8;
      aRingData[i * 4] = fxTime;
      aRingData[i * 4 + 1] = dur;
      aRingData[i * 4 + 2] = rad;
      aRingData[i * 4 + 3] = o.kind ?? 0;
      const t = o.tint ?? TINT.pale;
      const g = (o.gain ?? 1) * clamp(2.6 / (1.4 + rad), 0.22, 1.0);
      aRingTint[i * 3] = t[0] * g; aRingTint[i * 3 + 1] = t[1] * g; aRingTint[i * 3 + 2] = t[2] * g;
      ringAttrs.aCenter.addUpdateRange(i * 3, 3); ringAttrs.aCenter.needsUpdate = true;
      ringAttrs.aRing.addUpdateRange(i * 4, 4); ringAttrs.aRing.needsUpdate = true;
      ringAttrs.aTint.addUpdateRange(i * 3, 3); ringAttrs.aTint.needsUpdate = true;
      ringUntil = Math.max(ringUntil, fxTime + dur);
      ringMesh.visible = true;
    }

    const SPARK_STRIDE = [['aSpawn', 3], ['aVel', 3], ['aSpark', 4], ['aTint', 3]];
    function sparks(p, n = 8, o = {}) {
      if (muted || !p) return;
      const count = Math.min(n | 0, B.sparks);
      if (count <= 0) return;
      const spd = o.speed ?? 2.4, life = o.life ?? 0.85, size = o.size ?? 0.12;
      const grav = o.gravity ?? 3.2, up = o.up ?? 0.45, jit = o.jitter ?? 0.12;
      const t = o.tint ?? TINT.goldHot;
      const start = sparkCur;
      for (let k = 0; k < count; k++) {
        const i = (sparkCur + k) % B.sparks;
        const [ux, uy, uz] = rng.sphere();
        const s = spd * (0.45 + r() * 0.85);
        aSpSpawn[i * 3] = p.x + ux * jit;
        aSpSpawn[i * 3 + 1] = p.y + uy * jit;
        aSpSpawn[i * 3 + 2] = p.z + uz * jit;
        aSpVel[i * 3] = ux * s;
        aSpVel[i * 3 + 1] = Math.abs(uy) * s * 0.7 + up * (0.5 + r());
        aSpVel[i * 3 + 2] = uz * s;
        aSpData[i * 4] = fxTime + r() * (o.stagger ?? 0.05);
        aSpData[i * 4 + 1] = life * (0.7 + r() * 0.6);
        aSpData[i * 4 + 2] = size * (0.6 + r() * 0.9);
        aSpData[i * 4 + 3] = grav;
        const vm = 0.75 + r() * 0.5;
        aSpTint[i * 3] = t[0] * vm; aSpTint[i * 3 + 1] = t[1] * vm; aSpTint[i * 3 + 2] = t[2] * vm;
      }
      sparkCur = (sparkCur + count) % B.sparks;
      const first = Math.min(count, B.sparks - start);
      for (let a = 0; a < SPARK_STRIDE.length; a++) {
        const [key, stride] = SPARK_STRIDE[a];
        const at = sparkAttrs[key];
        at.addUpdateRange(start * stride, first * stride);
        if (count > first) at.addUpdateRange(0, (count - first) * stride);
        at.needsUpdate = true;
      }
      sparkUntil = Math.max(sparkUntil, fxTime + life * 1.6 + (o.stagger ?? 0.05) + 0.1);
      sparkMesh.visible = true;
    }

    const shaftDir = new THREE.Vector3();
    function shafts(origin, n = 9, o = {}) {
      if (muted || !origin) return;
      uShaftOrigin.value.copy(origin);
      const count = Math.min(n | 0, B.shafts);
      const dur = o.dur ?? 2.4;
      for (let k = 0; k < count; k++) {
        const i = (shaftCur + k) % B.shafts;
        const a = (k / count) * TAU + r() * 0.4;
        // steeply upward: a god-ray fan, never a sideways slab through the camera
        shaftDir.set(Math.cos(a), 1.15 + r() * 2.05, Math.sin(a)).normalize();
        aShDir[i * 3] = shaftDir.x; aShDir[i * 3 + 1] = shaftDir.y; aShDir[i * 3 + 2] = shaftDir.z;
        aShData[i * 4] = fxTime + r() * 0.22;
        aShData[i * 4 + 1] = dur * (0.8 + r() * 0.4);
        aShData[i * 4 + 2] = (o.length ?? 12) * (0.7 + r() * 0.6);
        aShData[i * 4 + 3] = (o.width ?? 0.36) * (0.6 + r() * 0.8);
        const t = o.tint ?? TINT.goldHot;
        aShTint[i * 3] = t[0]; aShTint[i * 3 + 1] = t[1]; aShTint[i * 3 + 2] = t[2];
      }
      shaftCur = (shaftCur + count) % B.shafts;
      for (const k in shaftAttrs) shaftAttrs[k].needsUpdate = true;
      shaftUntil = Math.max(shaftUntil, fxTime + dur * 1.4 + 0.3);
      shaftMesh.visible = true;
    }

    /* ---------------- DOM layer ---------------- */
    let dom = null, domForced = false, holdNumbers = -1;
    const NUM = [];
    let numCur = 0;
    let hudAnchor = null;
    let flashA = 0, flashDecay = 4, flashWarm = 0;
    let vigA = 0, vigDecay = 4.2;

    /**
     * Where a gain flies to. 65-ui owns the HUD, so find its bank counter in the
     * DOM rather than hard-coding a corner; cached and re-measured lazily so a
     * gain spawn never forces a layout more than once every couple of seconds.
     */
    const hudCache = { x: 0, y: 0, at: -1e9 };
    function resolveHud(w, h) {
      if (hudAnchor) return hudAnchor;
      if (fxTime - hudCache.at < 2) return hudCache;
      hudCache.at = fxTime;
      let el = null;
      try {
        // `.sk-bank-val` first: the gain flies to the TOTAL, so it should land on
        // the digits themselves, not on the centre of the whole bank block (which
        // sits a row and a half lower, under the rate/shake/crit line).
        el = document.querySelector('#ui-root [data-hud-anchor], #ui-root .sk-bank-val, #ui-root .sk-bank');
      } catch { /* selector unsupported */ }
      const rc = el?.getBoundingClientRect?.();
      if (rc && rc.width > 0) { hudCache.x = rc.left + rc.width * 0.5; hudCache.y = rc.top + rc.height * 0.5; }
      else { hudCache.x = Math.min(150, w * 0.1); hudCache.y = Math.min(48, h * 0.06); }
      return hudCache;
    }

    /**
     * True when transient DOM feedback must be withheld. A still screenshot must
     * never catch a number mid-flight, so shot mode drops the layer entirely —
     * but a VIDEO capture is shot mode too, and there the click reward is the
     * whole point. tools/capture.mjs sets `window.__CAPTURE` to say so.
     */
    /** Read live, never cached: capture.mjs sets the flag AFTER boot. */
    const captureMode = () => typeof window !== 'undefined' && !!window.__CAPTURE;
    function suppressDom() {
      if (!ctx.shotMode || domForced) return false;
      return !captureMode();
    }

    function ensureDom() {
      if (dom) return dom;
      if (typeof document === 'undefined') return null;
      if (suppressDom()) return null;
      const el = document.createElement('div');
      el.id = 'vfx-layer';
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9;' +
        'overflow:hidden;contain:layout paint';
      const flash = document.createElement('div');
      flash.style.cssText = 'position:absolute;inset:0;opacity:0;' +
        'background:radial-gradient(125% 95% at 50% 46%,' +
        'rgba(255,241,214,.92) 0%,rgba(255,199,224,.46) 36%,rgba(255,214,180,0) 74%)';
      el.appendChild(flash);
      // The calm cue. Sits UNDER the numbers so a gain never dims, and darkens
      // only the outer frame — a luminance change at the periphery reads as
      // impact without a bright flash and without a single pixel of movement.
      // Radii are 52% of each axis, so the gradient's 100% stop lands ON the frame
      // edge (a larger ellipse puts its dark end outside the viewport and the cue
      // becomes invisible — measured: 118% radii darkened the edge by 0.5%).
      const vig = document.createElement('div');
      vig.style.cssText = 'position:absolute;inset:-2px;opacity:0;' +
        'background:radial-gradient(52% 52% at 50% 50%,' +
        'rgba(38,22,30,0) 58%,rgba(34,20,28,.46) 86%,rgba(26,14,22,.80) 100%)';
      el.appendChild(vig);
      // Numbers get their own layer ABOVE #ui-root (z 11 vs the HUD's 10): they
      // fly into the bank counter, and at z 9 the last fifth of every arc
      // vanished behind the opaque parchment plate instead of landing on it.
      const nums = document.createElement('div');
      nums.id = 'vfx-numbers';
      nums.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:11;' +
        'overflow:hidden;contain:layout paint';
      for (let i = 0; i < B.numbers; i++) {
        const s = document.createElement('div');
        // clamp() rather than a fixed px so a 1440p master and a 720p test clip
        // read the same; tabular-nums so a counting digit never jitters the width
        s.style.cssText = 'position:absolute;left:0;top:0;opacity:0;white-space:nowrap;' +
          'transform-origin:50% 50%;text-align:center;' +
          'font:600 clamp(21px,2.4vh,34px)/1 "Hiragino Mincho ProN","Songti SC",Georgia,serif;' +
          'letter-spacing:.03em;font-variant-numeric:tabular-nums;' +
          'transform:translate3d(-9999px,-9999px,0)';
        // Two children so a crit can be labelled without re-parsing innerHTML on
        // every spawn: a tag line above (hidden for ordinary gains) and the value.
        const tag = document.createElement('div');
        tag.textContent = 'CRIT';
        tag.style.cssText = 'display:none;font-size:.46em;font-weight:700;' +
          'letter-spacing:.34em;text-indent:.34em;margin-bottom:.18em;color:#FFD98A';
        const val = document.createElement('div');
        s.append(tag, val);
        nums.appendChild(s);
        NUM.push({
          el: s, tag, val, active: false, t0: 0, dur: 1,
          x0: 0, y0: 0, x1: 0, y1: 0, cx: 0, cy: 0, scale: 1, crit: false,
        });
      }
      document.body.appendChild(el);
      document.body.appendChild(nums);
      dom = { el, nums, flash, vig };
      return dom;
    }

    const projV = new THREE.Vector3();
    const screenP = { x: 0, y: 0, behind: false };
    function toScreen(p) {
      projV.set(p.x, p.y, p.z).project(ctx.camera);
      const w = ctx.size?.w ?? window.innerWidth;
      const h = ctx.size?.h ?? window.innerHeight;
      screenP.x = (projV.x * 0.5 + 0.5) * w;
      screenP.y = (-projV.y * 0.5 + 0.5) * h;
      screenP.behind = projV.z > 1;
      return screenP;
    }

    function number(amount, point, o = {}) {
      if (muted) return;
      const d = ensureDom();
      if (!d) return;
      const w = ctx.size?.w ?? window.innerWidth;
      const h = ctx.size?.h ?? window.innerHeight;
      let sx = w * 0.5, sy = h * 0.45;
      if (point) {
        const s = toScreen(point);
        if (s.behind) return;
        sx = s.x; sy = s.y;
      }
      const slot = NUM[numCur]; numCur = (numCur + 1) % NUM.length;
      const crit = !!o.crit;
      const ua = resolveHud(w, h);
      const hx = ua.x, hy = ua.y;
      slot.active = true;
      slot.t0 = fxTime;                  // SIM clock — see the module header
      slot.dur = crit ? 1.5 : 1.1;
      slot.crit = crit;
      slot.x0 = sx + (r() - 0.5) * 26;
      slot.y0 = sy + (r() - 0.5) * 18;
      slot.x1 = hx; slot.y1 = hy;
      // Quadratic-bezier control point: pulled toward the HUD and lifted above
      // both ends, so the gain leaves the branch on an upward curve and comes
      // DOWN into the counter. A straight lerp reads as a UI tooltip.
      // The lift is clamped into the viewport: the bank plate sits ~40 px from
      // the top, so an unclamped 150 px lift put the control point ABOVE the
      // frame and the whole apex of the arc — the most legible part of it — was
      // cropped by the top edge. Measured at 720p: apex y went from -12 to 109.
      slot.cx = slot.x0 * 0.55 + hx * 0.45 + (r() - 0.5) * 60;
      slot.cy = Math.max(h * 0.045, Math.min(slot.y0, hy) - (crit ? 150 : 92));
      // With the kick gone the number carries more of the punch (brief §3).
      slot.scale = (crit ? 1.75 : 1) * (SETTINGS.motion.shake ? 1 : 1.16);
      slot.val.textContent = o.text ?? ('+' + fmt(amount));
      slot.tag.style.display = crit && !o.text ? 'block' : 'none';
      slot.el.style.color = crit ? '#FFF6DA' : '#FFEAF2';
      slot.el.style.fontWeight = crit ? '700' : '600';
      slot.el.style.textShadow = crit
        ? '0 0 14px rgba(255,214,126,.98),0 0 40px rgba(255,168,60,.72),0 2px 0 rgba(74,64,52,.85)'
        : '0 0 9px rgba(255,178,206,.85),0 2px 0 rgba(74,64,52,.7)';
    }

    /** Full-screen bright wash. Exactly what `flashes: false` exists to stop. */
    function flash(strength = 0.35, warm = 0, decay = 4) {
      if (!SETTINGS.motion.flashes) return false;
      const d = ensureDom(); if (!d) return false;
      flashA = Math.max(flashA, clamp(strength, 0, 1));
      flashWarm = warm; flashDecay = decay;
      return true;
    }

    /**
     * A soft inward vignette breath. Darkens the frame edge for a moment: no
     * translation, no scale, no bright pulse, so it is safe both for vestibular
     * sensitivity and for photosensitivity. Capped low on purpose.
     */
    function vignette(strength = 0.10, decay = 4.2) {
      const d = ensureDom(); if (!d) return;
      vigA = Math.max(vigA, clamp(strength, 0, 0.30));
      vigDecay = decay;
    }

    /**
     * The stand-in for a camera kick when screen shake is off. A player who turns
     * shake off must still get an answer to their click — a calm game, not a dead
     * one — so the impact is paid back in light and scale rather than movement.
     * Callers pair this with a wider ring, more sparks and a larger number.
     */
    function calmCue(power = 1) {
      vignette(0.07 + 0.032 * clamp(power, 0.25, 4), 4.2);
    }

    /* ---------------- composite effects ---------------- */
    const tmpP = new THREE.Vector3();
    const centreV = new THREE.Vector3();

    function canopyCentre() {
      const c = ctx.assets.tree?.canopyBounds?.center;
      return c ? centreV.set(c.x, c.y, c.z) : centreV.set(0, 9, 0);
    }

    function nearestBranch(p) {
      const tips = ctx.assets.tree?.branchTips;
      if (tips?.length) {
        let best = null, bd = Infinity;
        for (let i = 0; i < tips.length; i++) {
          const t = tips[i];
          const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bd) { bd = d2; best = t; }
        }
        if (best) return tmpP.copy(best);
      }
      try {
        const b = ctx.assets.tree?.sampleBranchPoint?.(r);
        if (b?.point) return tmpP.copy(b.point);
      } catch { /* the tree may not be built yet */ }
      return null;
    }

    /**
     * A shake: petals off the nearest branch, a shockwave, a camera nudge.
     * With `screenShake` off the nudge is dropped and the ring / sparks / number
     * grow to carry the hit instead — the click still lands, it just no longer
     * moves the horizon.
     */
    function shakeFx(point, power = 1) {
      if (muted || !point) return;
      const m = SETTINGS.motion;
      const calm = !m.shake;
      const pw = clamp(power, 0.25, 4);
      ring(point, {
        radius: (1.5 + 0.6 * pw) * (calm ? 1.15 : 1),
        dur: calm ? 0.62 : 0.55,
        kind: 0, tint: TINT.pale,
        // brightness only goes up if bright pulses are still welcome; the size
        // and duration boost above is geometry, not luminance, so it always applies
        gain: 0.95 * (calm && m.flashes ? 1.18 : 1),
      });
      sparks(point, Math.round((5 + 3 * pw) * (calm ? 1.5 : 1)), {
        speed: 1.7 * pw, life: calm ? 0.68 : 0.6, size: calm ? 0.10 : 0.085,
        gravity: 4.0, tint: TINT.petal, jitter: 0.18,
      });
      const src = nearestBranch(point) ?? point;
      burst(src, Math.round(10 + 8 * pw), 0.85 + 0.3 * pw);
      if (!kickCam(0.20 + 0.10 * pw, { sign: r() < 0.5 ? -1 : 1 })) calmCue(pw);
    }

    /** A crit: bigger burst, brighter number, a distinct gold flash. */
    function critFx(point, amount) {
      if (muted) return;
      const m = SETTINGS.motion;
      const p = point ?? canopyCentre();
      ring(p, { radius: 3.4, dur: 0.78, kind: 1, tint: TINT.goldHot, gain: 1.5 });
      ring(p, { radius: 2.0, dur: 0.46, kind: 0, tint: TINT.pale, gain: 1.2 });
      // no wash and no kick available => spend it on motes, which are small and
      // local and read as sparkle rather than as a pulse
      sparks(p, m.flashes && m.shake ? 26 : 36, {
        speed: 4.2, life: 1.0, size: 0.155, gravity: 3.6, tint: TINT.gold, up: 0.9,
      });
      burst(p, 34, 1.7);
      flash(0.17, 1, 5.5);                        // no-ops when flashes are off
      if (!m.shake || !m.flashes) calmCue(1.7);
      number(amount, p, { crit: true });
    }

    /**
     * Stage-up — the reward moment: dilation, shockwave, shafts, wash.
     * With motion off it must still read as a celebration, so the shockwave, the
     * shafts, the petal storm and 65-ui's title card all stay; only the camera
     * push and the time-dilation lurch are dropped.
     */
    function stageUp(stage) {
      const m = SETTINGS.motion;
      const c = canopyCentre();
      const rad = ctx.assets.tree?.canopyBounds?.radius ?? 6;
      if (m.shake) { dilateT = 0; dilateDur = 2.6; }
      else { dilateT = -1; timeScale = 1; }
      ring(c, { radius: rad * 1.15, dur: 1.5, kind: 2, tint: TINT.goldHot, gain: 1.7 });
      ring(c, { radius: rad * 0.72, dur: 1.0, kind: 1, tint: TINT.pale, gain: 1.5 });
      sparks(c, Math.min(B.sparks, 80), {
        speed: 6.5, life: 2.2, size: 0.115, gravity: 1.6,
        tint: TINT.goldHot, up: 1.4, jitter: rad * 0.5, stagger: 0.35,
      });
      shafts(c, B.shafts, { dur: 2.6, length: 11, width: 0.34, tint: TINT.goldHot });
      burst(c, 220, 2.6);
      flash(0.20, 0, 0.9);
      if (m.shake) ctx.assets.cameraRig?.pushIn?.(0.85 * m.shakeScale, 1.3);
      else vignette(0.15, 1.15);        // one slow inward breath instead of the push
      ctx.bus.emit('sfx', { id: 'stageup', gain: 1 });
      if (Number.isFinite(stage)) uGoldGlow.value = 1 + stage * 0.06;
    }

    /* ---------------- the Golden Petal ---------------- */
    const gold = {
      active: false, freeze: false, t: 0, dur: 26, next: 0, trail: 0,
      a: new THREE.Vector3(-13.5, 6.0, 7.5),
      b: new THREE.Vector3(13.0, 9.6, 0.5),
    };
    const goldPos = new THREE.Vector3(0, 8, 0);

    function goldenSpawn() {
      if (gold.active) return;
      const flip = r() < 0.5;
      gold.a.set(flip ? -13.5 : 13.5, 5.4 + r() * 2.4, 6.0 + r() * 4.0);
      gold.b.set(flip ? 13.5 : -13.5, 7.6 + r() * 3.0, -1.0 + r() * 4.0);
      gold.dur = 22 + r() * 10;
      gold.t = 0; gold.trail = 0; gold.freeze = false;
      gold.active = true;
      goldMesh.visible = true;
      ctx.bus.emit('sfx', { id: 'goldenAppear', gain: 0.6 });
    }

    function goldenHide() {
      gold.active = false;
      goldMesh.visible = false;
      gold.next = ctx.shotMode ? Infinity : fxTime + 90 + r() * 150;
    }

    function goldenCatch() {
      if (!gold.active) return;
      const p = tmpP.copy(goldPos);
      ring(p, { radius: 4.2, dur: 0.95, kind: 1, tint: TINT.goldHot, gain: 2.0 });
      sparks(p, Math.min(64, B.sparks), { speed: 5.0, life: 1.5, size: 0.20, gravity: 2.2, tint: TINT.gold, up: 1.0 });
      burst(p, 90, 2.0);
      flash(0.20, 1, 3.2);
      number(0, p, { crit: true, text: '金 !' });
      if (!kickCam(0.7)) calmCue(2.0);
      ctx.bus.emit('sfx', { id: 'golden', gain: 1 });
      ctx.bus.emit('vfx:golden', { point: p.clone(), kind: 'caught' });
      goldenHide();
    }

    const gEuler = new THREE.Euler();
    function updateGolden(dt) {
      if (!gold.active) return;
      if (!gold.freeze) {
        gold.t += dt / gold.dur;
        if (gold.t >= 1) { goldenHide(); return; }
      }
      const u = gold.t;
      goldPos.copy(gold.a).lerp(gold.b, u);
      goldPos.y += Math.sin(u * Math.PI) * 1.6 + Math.sin(fxTime * 0.7 + u * 5.0) * 0.35;
      goldPos.z += Math.sin(u * TAU * 0.8) * 1.3;
      goldPos.x += Math.sin(fxTime * 0.53) * 0.22;
      goldMesh.position.copy(goldPos);
      gEuler.set(Math.sin(fxTime * 0.9) * 0.7, fxTime * 0.85, Math.sin(fxTime * 1.27) * 0.5 + 0.4, 'YXZ');
      goldMesh.quaternion.setFromEuler(gEuler);
      goldMesh.updateMatrixWorld();
      gold.trail -= dt;
      if (gold.trail <= 0 && uAgeOverride.value < 0) {
        gold.trail = 0.20;
        sparks(goldPos, 2, { speed: 0.5, life: 1.1, size: 0.085, gravity: 0.6, tint: TINT.goldHot, up: -0.1, jitter: 0.14 });
      }
    }

    /* ---------------- events ---------------- */
    const offs = [];
    offs.push(ctx.bus.on('tree:clicked', (e) => { if (e?.point) shakeFx(e.point, e.power ?? 1); }));
    offs.push(ctx.bus.on('world:click', (e) => { if (e?.hit?.object === goldMesh) goldenCatch(); }));
    offs.push(ctx.bus.on('petals:gain', (e) => {
      if (!e) return;
      const p = e.point ?? canopyCentre();
      if (e.crit) critFx(p, e.amount);
      else {
        sparks(p, 4, { speed: 1.4, life: 0.55, size: 0.075, gravity: 3.5, tint: TINT.petal });
        number(e.amount, p);
      }
    }));
    offs.push(ctx.bus.on('petals:burst', (e) => {
      if ((e?.count ?? 0) >= 60 && e.point) {
        ring(e.point, { radius: 3.0, dur: 0.8, kind: 1, tint: TINT.petal, gain: 1.0 });
      }
    }));
    offs.push(ctx.bus.on('upgrade:bought', (e) => {
      const c = canopyCentre();
      const p = tmpP.set(c.x, c.y * 0.42, c.z);
      ring(p, { radius: 2.2, dur: 0.7, kind: 3, tint: TINT.gold, gain: 1.2 });
      sparks(p, 22, { speed: 3.0, life: 1.1, size: 0.14, gravity: 2.4, tint: TINT.goldHot, up: 1.1, jitter: 0.5 });
      flash(0.075, 1, 6);
      if (!kickCam(0.22)) calmCue(0.7);
      if ((e?.tier ?? 0) >= 4) burst(p, 40, 1.2);
    }));
    /* Live settings. Someone reaching for the shake toggle is often reaching for it
     * because they already feel unwell, so anything already in flight is cancelled
     * here rather than allowed to play out: the dilation snaps back to real time and
     * a wash that is mid-decay is cleared on the spot. */
    offs.push(SETTINGS.on('change', () => {
      const m = SETTINGS.motion;
      if (!m.shake && dilateT >= 0) { dilateT = -1; timeScale = 1; }
      if (!m.flashes && flashA > 0) {
        flashA = 0;
        if (dom) { dom.flash.style.opacity = '0'; dom.flash.style.filter = 'none'; }
      }
    }));

    let lastStage = -1;
    offs.push(ctx.bus.on('bloom:stage', (e) => {
      const s = Number(e?.stage);
      if (!Number.isFinite(s)) return;
      if (lastStage >= 0 && s > lastStage) stageUp(s);
      lastStage = s;
    }));

    /* ---------------- debug scenarios ---------------- */
    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      const sc = window.__game.scenarios;
      const forceDom = () => { domForced = true; return ensureDom(); };
      sc['vfx-off'] = () => {
        muted = true;
        ringMesh.visible = sparkMesh.visible = shaftMesh.visible = goldMesh.visible = false;
      };
      sc['vfx-golden'] = () => {
        gold.a.set(-13.5, 6.4, 7.0); gold.b.set(13.5, 9.4, 0.0);
        gold.dur = 26; gold.t = 0.16; gold.freeze = true; gold.active = true;
        goldMesh.visible = true;
        updateGolden(0);
      };
      // 5 m in front of the hero camera — for judging the petal's shading, not
      // its placement.
      sc['vfx-golden-near'] = () => {
        sc['postfx-no-dof']?.();
        gold.a.set(11.2, 6.7, 16.85); gold.b.copy(gold.a);
        gold.dur = 26; gold.t = 0.0; gold.freeze = true; gold.active = true;
        goldMesh.visible = true;
        updateGolden(0);
      };
      sc['vfx-demo'] = () => {
        forceDom();
        const c = canopyCentre().clone();
        uAgeOverride.value = 0.42;
        ring(new THREE.Vector3(c.x - 1.6, c.y - 1.4, c.z + 2.4), { radius: 2.6, kind: 0, tint: TINT.pale, gain: 1.1 });
        ring(new THREE.Vector3(c.x + 2.8, c.y + 0.9, c.z - 1.0), { radius: 3.6, kind: 1, tint: TINT.goldHot, gain: 1.6 });
        ring(new THREE.Vector3(0.6, 2.4, 1.2), { radius: 2.2, kind: 3, tint: TINT.gold, gain: 1.2 });
        sparks(new THREE.Vector3(c.x + 2.8, c.y + 0.9, c.z - 1.0), 40, { speed: 4.2, life: 1.0, size: 0.185, gravity: 3.4, tint: TINT.gold, up: 0.9 });
        sparks(new THREE.Vector3(0.6, 2.4, 1.2), 22, { speed: 3.0, life: 1.1, size: 0.14, gravity: 2.4, tint: TINT.goldHot, up: 1.1, jitter: 0.5 });
        sc['vfx-golden']();
        number(1234, new THREE.Vector3(c.x - 1.6, c.y - 1.2, c.z + 2.4));
        number(98765, new THREE.Vector3(c.x + 2.8, c.y + 1.3, c.z - 1.0), { crit: true });
        holdNumbers = 0.30;
      };
      sc['vfx-stage'] = () => { forceDom(); uAgeOverride.value = 0.30; stageUp(4); holdNumbers = 0.28; };
      // isolation scenarios — each family alone, for attributing a defect
      sc['vfx-shafts'] = () => {
        uAgeOverride.value = 0.30;
        shafts(canopyCentre(), B.shafts, { dur: 2.6, length: 11, width: 0.34, tint: TINT.goldHot });
      };
      sc['vfx-flash'] = () => { forceDom(); flash(0.20, 0, 0.9); holdNumbers = 0.28; };
      sc['vfx-crit'] = () => {
        forceDom(); uAgeOverride.value = 0.40;
        const c = canopyCentre();
        critFx(new THREE.Vector3(c.x + 1.2, c.y - 0.8, c.z + 1.8), 1.234e6);
        holdNumbers = 0.34;
      };
      // accessibility harness: flip the shared store so a probe or a critic can
      // photograph the calm path without a settings panel.
      /** The calm cue alone, over an otherwise untouched frame — an A/B against the
       *  plain preset shot is the only honest way to check it is actually visible. */
      sc['vfx-vignette'] = () => { forceDom(); calmCue(1.6); holdNumbers = 0.28; };
      /** Stage-up on the reduced-motion path: shockwave, shafts and storm intact,
       *  no push and no lurch. Compare against `vfx-stage`. */
      sc['vfx-stage-calm'] = () => {
        forceDom(); SETTINGS.patch({ reducedMotion: true });
        uAgeOverride.value = 0.30; stageUp(4); holdNumbers = 0.28;
      };
      sc['vfx-motion-off'] = () => SETTINGS.patch({ reducedMotion: true });
      sc['vfx-motion-on'] = () => SETTINGS.patch({ reducedMotion: false });
      /** The reduced-motion answer to a click: no kick, wider ring, soft vignette. */
      sc['vfx-shake-calm'] = () => {
        forceDom(); SETTINGS.patch({ reducedMotion: true });
        uAgeOverride.value = 0.34;
        const c = canopyCentre();
        shakeFx(new THREE.Vector3(c.x + 1.0, c.y - 1.2, c.z + 2.0), 1.6);
        number(4321, new THREE.Vector3(c.x + 1.0, c.y - 1.0, c.z + 2.0));
        holdNumbers = 0.30;
      };
    }

    /* ---------------- public API ---------------- */
    ctx.assets.vfx = {
      ring, sparks, shafts, number, flash, vignette,
      shake: shakeFx, crit: critFx, stageUp,
      /** Live view of the shared motion gates — a read-through, never a copy. */
      get motion() { return SETTINGS.motion; },
      golden: {
        spawn: goldenSpawn, catch: goldenCatch, hide: goldenHide,
        get active() { return gold.active; },
        get position() { return goldPos; },
      },
      get timeScale() { return timeScale; },
      setHudAnchor(x, y) { hudAnchor = { x, y }; },
      setMuted(m) { muted = !!m; },
      format: fmt,
    };

    /* ---------------- per-frame ---------------- */
    const uiRoot = typeof document !== 'undefined' ? document.getElementById('ui-root') : null;
    let domSync = 0;

    function updateNumbers() {
      if (!dom) return;
      // `holdNumbers` pins every number at one phase so a STILL can be composed.
      // Under video capture that would be the v1 bug — numbers frozen at a fixed
      // age — so a storyboard that pokes a vfx-* scenario for its rings still gets
      // moving numbers.
      const hold = holdNumbers >= 0 && !captureMode() ? holdNumbers : -1;
      for (let i = 0; i < NUM.length; i++) {
        const n = NUM[i];
        if (!n.active) continue;
        const t = hold >= 0 ? hold : (fxTime - n.t0) / n.dur;
        if (t >= 1) {
          n.active = false;
          n.el.style.opacity = '0';
          n.el.style.transform = 'translate3d(-9999px,-9999px,0)';
          continue;
        }
        const e = t * t * (3 - 2 * t);
        const iv = 1 - e;
        const x = iv * iv * n.x0 + 2 * iv * e * n.cx + e * e * n.x1;
        const y = iv * iv * n.y0 + 2 * iv * e * n.cy + e * e * n.y1;
        // Birth pop, then shrink into the counter so the arrival reads as the
        // gain being absorbed by the total rather than as a label switching off.
        // A crit gets a visible overshoot on top of its larger base scale.
        const born = Math.min(1, t * 6);
        const pop = n.crit ? 0.22 * Math.sin(Math.PI * Math.min(1, t * 3.2)) : 0;
        const s = n.scale * (0.55 + 0.65 * born + pop - 0.42 * e);
        const fade = t < 0.62 ? 1 : 1 - Math.pow((t - 0.62) / 0.38, 1.6);
        const o = Math.min(1, t * 8) * Math.max(0, fade);
        n.el.style.opacity = o.toFixed(3);
        // trailing translate(-50%,-50%) centres the glyphs ON the arc point (it
        // is inside the scale, so it stays centred as the number grows/shrinks)
        n.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) ` +
          `scale(${s.toFixed(3)}) translate(-50%,-50%)`;
      }
    }

    return {
      object3D: group,

      update(dt) {
        // --- stage-up time dilation (motion; belt-and-braces with the change
        // listener so no code path can leave someone stuck in a lurch)
        if (dilateT >= 0 && !SETTINGS.motion.shake) { dilateT = -1; timeScale = 1; }
        if (dilateT >= 0) {
          dilateT += dt;
          const u = dilateT / dilateDur;
          if (u >= 1) { dilateT = -1; timeScale = 1; }
          else if (u < 0.10) timeScale = 1 - 0.62 * (u / 0.10);
          else if (u < 0.55) timeScale = 0.38;
          else timeScale = 0.38 + 0.62 * ((u - 0.55) / 0.45);
        }
        const fdt = dt * timeScale;
        fxTime += fdt;
        uTime.value = fxTime;

        // --- retire empty pools. Frames 0-2 keep every mesh visible so
        // main.js's boot compile() pass builds all four programs up front and a
        // first click never hitches on a shader compile.
        if (uAgeOverride.value < 0 && ctx.frame > 2) {
          if (ringMesh.visible && fxTime > ringUntil) ringMesh.visible = false;
          if (sparkMesh.visible && fxTime > sparkUntil) sparkMesh.visible = false;
          if (shaftMesh.visible && fxTime > shaftUntil) shaftMesh.visible = false;
          if (goldMesh.visible && !gold.active) goldMesh.visible = false;
        }

        // --- golden petal scheduling (never in shot mode)
        if (!ctx.shotMode && !gold.active) {
          if (gold.next === 0) gold.next = fxTime + 55 + r() * 60;
          else if (fxTime >= gold.next) goldenSpawn();
        }
        updateGolden(fdt);

        // --- DOM layer
        if (dom) {
          if ((domSync++ & 15) === 0 && uiRoot) {
            const want = uiRoot.style.display === 'none' ? 'none' : '';
            if (dom.el.style.display !== want) dom.el.style.display = want;
            if (dom.nums.style.display !== want) dom.nums.style.display = want;
          }
          updateNumbers();
          if (flashA > 0.001) {
            dom.flash.style.opacity = flashA.toFixed(3);
            dom.flash.style.filter = flashWarm > 0.5 ? 'hue-rotate(-16deg) saturate(1.25)' : 'none';
            if (holdNumbers < 0) flashA = Math.max(0, flashA - flashDecay * dt);
          } else if (dom.flash.style.opacity !== '0') {
            dom.flash.style.opacity = '0';
          }
          if (vigA > 0.001) {
            dom.vig.style.opacity = vigA.toFixed(3);
            if (holdNumbers < 0) vigA = Math.max(0, vigA - vigDecay * dt);
          } else if (dom.vig.style.opacity !== '0') {
            dom.vig.style.opacity = '0';
          }
        }
      },

      dispose() {
        for (const o of offs) { try { o?.(); } catch { /* ignore */ } }
        ringGeo.dispose(); sparkGeo.dispose(); shaftGeo.dispose(); goldGeo.dispose();
        ringMat.dispose(); sparkMat.dispose(); shaftMat.dispose(); goldMat.dispose();
        const i = ctx.clickTargets.indexOf(goldMesh);
        if (i >= 0) ctx.clickTargets.splice(i, 1);
        dom?.el.remove();
        dom?.nums.remove();
        ctx.assets.vfx = null;
      },
    };
  },
};
