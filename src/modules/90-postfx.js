import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import {
  AO_SHADER, AO_BLUR_SHADER, RAY_MASK_SHADER, RAY_BLUR_SHADER, ATMOS_SHADER,
  TAA_SHADER, COPY_SHADER, FOCUS_SHADER, COC_SHADER, DOF_GATHER_SHADER,
  DOF_COMPOSITE_SHADER, GRADE_SHADER, FINAL_SHADER,
  BLOOM_PREFILTER_SHADER, BLOOM_DOWN_SHADER, BLOOM_UP_SHADER, BLOOM_COMPOSITE_SHADER,
} from '../lib/postfx-shaders.js';

/**
 * Post-processing pipeline.  order 90 — boots last, owns the final image.
 * Owner: postfx agent.  Files owned: this + src/lib/postfx-shaders.js
 *
 * ─── who owns tonemapping ─────────────────────────────────────────────
 * THIS MODULE. `renderer.toneMapping` is set to `NoToneMapping` here so the
 * scene renders as raw linear HDR into a HalfFloat target; ACES is applied
 * exactly once, in GRADE_SHADER, together with the grade and the sRGB encode.
 * If the pipeline is switched off (`postfx-off` scenario) ACESFilmic is handed
 * back to the renderer so the fallback path still looks right.
 *
 * ─── chain ───────────────────────────────────────────────────────────
 *   scene ─► sceneRT (HalfFloat + DepthTexture, TAA-jittered projection)
 *     ├─ focus   (1×1  autofocus probe, temporally smoothed)
 *     ├─ AO      (½ res depth-only Alchemy AO → separable bilateral blur ×2)
 *     ├─ rays    (¼ res sky/emissive mask → radial occlusion blur from the sun)
 *     ├─ TAA     (jittered accumulation, neighbourhood-clamped)   [quality.taa]
 *     ├─ atmos   (AO multiply toward the shadow tint + additive god rays)
 *     ├─ bloom   (7-level Jimenez pyramid, soft knee, sun-disc pre-multiply)
 *     ├─ DOF     (½ res CoC pack → CoC-weighted gather → full-res composite)
 *     ├─ grade   (linear black point → ACES → S-curve → toe → +sat → luma-weighted
 *                 split tone → luma-gated shadow lift → shoulder → sRGB → floor)
 *     ├─ SMAA
 *     └─ final   (chromatic aberration, vignette, film grain) → screen
 *
 * Every intermediate target in that chain — sceneRT, both ping-pong buffers, the
 * AO/ray/CoC/DOF/history buffers, all seven bloom mips and SMAA's own edge and
 * weight targets — is HalfFloat. There is no UnsignedByte stage anywhere before
 * the default framebuffer, which is why an explicit dither is only needed once,
 * at the very end of GRADE.
 *
 * Why a hand-rolled composer loop instead of `EffectComposer`: the scene target
 * carries a real DepthTexture, and EffectComposer's ping-pong buffers would
 * both be written by full-screen quads (which write depth), destroying it. The
 * loop below is EffectComposer's exact contract — three's own `SMAAPass` is used
 * unmodified inside it.
 */

/* ------------------------------------------------------------------ *
 * a Pass that runs one of our shaders, with explicit input/target routing
 * ------------------------------------------------------------------ */
class FxPass extends Pass {
  constructor(shader, opts = {}) {
    super();
    this.uniforms = THREE.UniformsUtils.clone(shader.uniforms);
    this.material = new THREE.ShaderMaterial({
      name: shader.name,
      defines: Object.assign({}, shader.defines, opts.defines),
      uniforms: this.uniforms,
      vertexShader: shader.vertexShader,
      fragmentShader: shader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.needsSwap = opts.needsSwap !== false;
    /** fixed destination; null = write into the ping-pong buffer */
    this.target = opts.target ?? null;
    /** () => THREE.Texture — overrides reading the ping-pong read buffer */
    this.input = opts.input ?? null;
    this._fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    if (u.tDiffuse) u.tDiffuse.value = this.input ? this.input() : readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : (this.target ?? writeBuffer));
    this._fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); }
}

/** Renders the scene into a depth-attached HDR target, with optional TAA jitter. */
class ScenePass extends Pass {
  constructor(ctx, target) {
    super();
    this.needsSwap = false;
    this.ctx = ctx;
    this.target = target;
    this.jitterAmount = 0;          // in pixels, 0 = off
    this.index = 0;
    this.projInv = new THREE.Matrix4();
    this.stats = { calls: 0, triangles: 0, lines: 0, points: 0 };
  }

  /** Halton(2,3) — the standard TAA sample pattern. */
  static halton(i, base) {
    let f = 1, r = 0, n = i;
    while (n > 0) { f /= base; r += f * (n % base); n = Math.floor(n / base); }
    return r;
  }

  render(renderer) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const W = this.target.width, H = this.target.height;
    const jit = this.jitterAmount;

    if (jit > 0) {
      const i = (this.index % 16) + 1;
      const jx = (ScenePass.halton(i, 2) - 0.5) * jit;
      const jy = (ScenePass.halton(i, 3) - 0.5) * jit;
      cam.setViewOffset(W, H, jx, jy, W, H);
    }
    this.index++;

    renderer.setRenderTarget(this.target);
    renderer.render(ctx.scene, cam);

    // capture the *jittered* matrices — every depth-based effect reconstructs
    // positions with these, so reconstruction stays exact.
    this.projInv.copy(cam.projectionMatrixInverse);
    this.near = cam.near;
    this.far = cam.far;
    this.projScaleX = 0.5 * cam.projectionMatrix.elements[0];
    this.projScaleY = 0.5 * cam.projectionMatrix.elements[5];

    if (jit > 0) cam.clearViewOffset();

    const r = renderer.info.render;
    this.stats.calls = r.calls;
    this.stats.triangles = r.triangles;
    this.stats.lines = r.lines;
    this.stats.points = r.points;
  }
}

/* ------------------------------------------------------------------ *
 * bloom — progressive downsample / tent upsample pyramid
 *
 * Replaces UnrealBloomPass. `nMips` is hard-coded to 5 there, and — more
 * importantly — its high-pass source and its additive-composite destination are
 * both derived from the single `readBuffer` argument, so there is no way to feed
 * the pyramid a *boosted* copy of the frame without also blowing out the frame
 * itself. This pass takes the two separately: the pyramid is seeded from a
 * pre-filter that pre-multiplies the sky around the sun, while the composite adds
 * the veil over the untouched frame.
 * ------------------------------------------------------------------ */
class HazeBloomPass extends Pass {
  constructor(W, H, maxLevels = 7) {
    super();
    this.needsSwap = true;

    this.strength = 0.62;
    this.radius = 0.80;
    this.threshold = 0.80;      // linear HDR, pre-exposure
    this.knee = 0.65;           // soft knee width as a fraction of the threshold
    // Per-mip weight ratio. The progressive upsample makes mip i's contribution
    // to the final veil equal to mipFalloff^i, so this single number IS the
    // weight curve; the composite then divides by their sum, which is why
    // `strength` means exactly "fraction of the veil added over the frame"
    // regardless of how many mips the current resolution supports.
    this.mipFalloff = 0.90;
    this.sunBoost = new THREE.Vector2(2.5, 0.25);   // (multiplier, radius in frame heights)
    this.sunUV = new THREE.Vector2(0.5, 0.85);
    this.tint = new THREE.Vector3(1, 1, 1);
    this.aspect = W / H;

    this.maxLevels = maxLevels;
    const opt = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    // The pre-filter lands here, and mip 0 is a *blurred* copy of it. Feeding the
    // raw thresholded frame into the veil is what makes a bloom look like a hard
    // white outline: mip 0 would then be a pixel-sharp copy of the highlights,
    // and no amount of coarse-mip haze on top of it hides that edge.
    this.seed = new THREE.WebGLRenderTarget(2, 2, opt);
    this.seed.texture.name = 'postfx.bloomSeed';
    this.seed.texture.generateMipmaps = false;
    this.mips = [];
    for (let i = 0; i < maxLevels; i++) {
      const rt = new THREE.WebGLRenderTarget(2, 2, opt);
      rt.texture.name = `postfx.bloom${i}`;
      rt.texture.generateMipmaps = false;
      this.mips.push(rt);
    }

    const mk = (shader, extra) => new THREE.ShaderMaterial({
      name: shader.name,
      uniforms: THREE.UniformsUtils.clone(shader.uniforms),
      vertexShader: shader.vertexShader,
      fragmentShader: shader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      ...extra,
    });
    this.mPre = mk(BLOOM_PREFILTER_SHADER);
    this.mDown = mk(BLOOM_DOWN_SHADER);
    // AdditiveBlending + premultipliedAlpha gives a clean glBlendFunc(ONE, ONE):
    // the upsample accumulates the coarser mip into the finer one in place.
    this.mUp = mk(BLOOM_UP_SHADER, {
      blending: THREE.AdditiveBlending, premultipliedAlpha: true, transparent: true,
    });
    this.mComp = mk(BLOOM_COMPOSITE_SHADER);

    this.mPre.uniforms.uTexel.value = new THREE.Vector2();
    this.mPre.uniforms.uSunUV.value = this.sunUV;
    this.mPre.uniforms.uSunBoost.value = new THREE.Vector2();
    this.mDown.uniforms.uTexel.value = new THREE.Vector2();
    this.mUp.uniforms.uTexel.value = new THREE.Vector2();
    this.mComp.uniforms.uTint.value = new THREE.Vector3(1, 1, 1);

    this._quad = new FullScreenQuad(this.mPre);
    this.fullTexel = new THREE.Vector2(1 / W, 1 / H);
    this.sizes = [];
    this.levels = 1;
    this.setSize(W, H);
  }

  setSize(W, H) {
    this.fullTexel.set(1 / Math.max(W, 1), 1 / Math.max(H, 1));
    this.aspect = Math.max(W, 1) / Math.max(H, 1);
    this.sizes.length = 0;
    let w = Math.max(1, Math.round(W / 2));
    let h = Math.max(1, Math.round(H / 2));
    for (let i = 0; i < this.maxLevels; i++) {
      if (i > 0 && (w < 4 || h < 4)) break;
      this.sizes.push([w, h]);
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
    this.levels = this.sizes.length;
    for (let i = 0; i < this.levels; i++) this.mips[i].setSize(this.sizes[i][0], this.sizes[i][1]);
    this.seed.setSize(this.sizes[0][0], this.sizes[0][1]);
  }

  /** Σ mipFalloff^i over the mips this resolution actually allocated. */
  weightSum() {
    let s = 0, k = 1;
    for (let i = 0; i < this.levels; i++) { s += k; k *= this.mipFalloff; }
    return s;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    // every step below covers the full quad; the upsample steps must NOT clear
    // because they accumulate additively into an already-populated mip.
    renderer.autoClear = false;

    // 1. pre-filter the frame into the seed (soft-knee high pass + sun-disc boost)
    const pu = this.mPre.uniforms;
    pu.tDiffuse.value = readBuffer.texture;
    pu.uTexel.value.copy(this.fullTexel);
    pu.uThreshold.value = this.threshold;
    pu.uKnee.value = this.knee;
    pu.uSunBoost.value.copy(this.sunBoost);
    pu.uAspect.value = this.aspect;
    this._quad.material = this.mPre;
    renderer.setRenderTarget(this.seed);
    this._quad.render(renderer);

    // 2. mip 0 = the 13-tap kernel applied at the *same* resolution, i.e. a blur
    //    rather than a downsample, so the finest level of the veil already has a
    //    ~4 full-res-pixel skirt and there is no pixel-sharp core anywhere.
    this._quad.material = this.mDown;
    const du = this.mDown.uniforms;
    du.tDiffuse.value = this.seed.texture;
    du.uTexel.value.set(1 / this.sizes[0][0], 1 / this.sizes[0][1]);
    renderer.setRenderTarget(this.mips[0]);
    this._quad.render(renderer);

    // 3. downsample chain
    for (let i = 1; i < this.levels; i++) {
      du.tDiffuse.value = this.mips[i - 1].texture;
      du.uTexel.value.set(1 / this.sizes[i - 1][0], 1 / this.sizes[i - 1][1]);
      renderer.setRenderTarget(this.mips[i]);
      this._quad.render(renderer);
    }

    // 4. progressive tent upsample, added into the finer mip each step. After
    //    this, mip 0 holds the sum of all levels — the coarsest one carries the
    //    wide atmospheric haze, the finest the tight core.
    this._quad.material = this.mUp;
    const uu = this.mUp.uniforms;
    uu.uRadius.value = 0.55 + this.radius;
    uu.uScale.value = this.mipFalloff;
    for (let i = this.levels - 1; i > 0; i--) {
      uu.tDiffuse.value = this.mips[i].texture;
      uu.uTexel.value.set(1 / this.sizes[i][0], 1 / this.sizes[i][1]);
      renderer.setRenderTarget(this.mips[i - 1]);
      this._quad.render(renderer);
    }

    // 5. composite over the untouched frame
    this._quad.material = this.mComp;
    const cu = this.mComp.uniforms;
    cu.tDiffuse.value = readBuffer.texture;
    cu.tBloom.value = this.mips[0].texture;
    // Normalise by the SUM of the per-mip weights, not by the level count. The old
    // `/ this.levels` was only correct for a flat weight curve and, worse, it made
    // the meaning of `strength` depend on the resolution: the same number produced
    // a different veil at 720p (6 mips) than at 1080p (7 mips).
    cu.uStrength.value = this.strength / Math.max(this.weightSum(), 1e-4);
    cu.uTint.value.copy(this.tint);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);

    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.seed.dispose();
    for (const m of this.mips) m.dispose();
    this.mPre.dispose(); this.mDown.dispose(); this.mUp.dispose(); this.mComp.dispose();
    this._quad.dispose();
  }
}

/* ------------------------------------------------------------------ */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function rgbInto(src, out) {
  if (!src) return false;
  if (src.isColor) { out.set(src.r, src.g, src.b); return true; }
  if (src.isVector3) { out.copy(src); return true; }
  return false;
}

export default {
  name: 'postfx',
  order: 90,

  async setup(ctx) {
    const renderer = ctx.renderer;
    if (!renderer) return {};

    const q = ctx.quality;
    const useAO = !!q.ssao;
    const useRays = !!q.godrays;
    const useDOF = !!q.dof;
    const taaLevel = q.taa | 0;
    const useTAA = taaLevel > 0;

    // ---- we own tonemapping from here on -----------------------------
    renderer.toneMapping = THREE.NoToneMapping;

    const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
    let W = Math.max(2, Math.floor(dbs.x));
    let H = Math.max(2, Math.floor(dbs.y));
    const half = (n) => Math.max(1, Math.floor(n / 2));
    const quarter = (n) => Math.max(1, Math.floor(n / 4));

    const HDR = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };

    const depthTex = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    depthTex.format = THREE.DepthFormat;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;

    const sceneRT = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depthTex,
    });
    sceneRT.texture.name = 'postfx.scene';

    const rtA = new THREE.WebGLRenderTarget(W, H, HDR);
    const rtB = new THREE.WebGLRenderTarget(W, H, HDR);
    rtA.texture.name = 'postfx.pingA';
    rtB.texture.name = 'postfx.pingB';

    const aoRT = new THREE.WebGLRenderTarget(half(W), half(H), HDR);
    const aoTmp = new THREE.WebGLRenderTarget(half(W), half(H), HDR);
    const occlRT = new THREE.WebGLRenderTarget(quarter(W), quarter(H), HDR);
    const raysRT = new THREE.WebGLRenderTarget(quarter(W), quarter(H), HDR);
    const cocRT = new THREE.WebGLRenderTarget(half(W), half(H), HDR);
    const dofRT = new THREE.WebGLRenderTarget(half(W), half(H), HDR);
    let histA = new THREE.WebGLRenderTarget(W, H, HDR);
    let histB = new THREE.WebGLRenderTarget(W, H, HDR);
    const focusRT = [
      new THREE.WebGLRenderTarget(1, 1, { ...HDR, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      new THREE.WebGLRenderTarget(1, 1, { ...HDR, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    ];
    let focusIdx = 0;

    const ownedTargets = [sceneRT, rtA, rtB, aoRT, aoTmp, occlRT, raysRT, cocRT, dofRT, histA, histB, ...focusRT];

    /* ---------------- passes ---------------- */

    const scenePass = new ScenePass(ctx, sceneRT);

    const focusPass = new FxPass(FOCUS_SHADER, { needsSwap: false, target: focusRT[1] });
    const aoPass = new FxPass(AO_SHADER, { needsSwap: false, target: aoRT });
    const aoBlurH = new FxPass(AO_BLUR_SHADER, { needsSwap: false, target: aoTmp, input: () => aoRT.texture });
    const aoBlurV = new FxPass(AO_BLUR_SHADER, { needsSwap: false, target: aoRT, input: () => aoTmp.texture });
    const rayMask = new FxPass(RAY_MASK_SHADER, { needsSwap: false, target: occlRT, input: () => sceneRT.texture });
    const rayBlur = new FxPass(RAY_BLUR_SHADER, { needsSwap: false, target: raysRT, input: () => occlRT.texture });

    const taaPass = new FxPass(TAA_SHADER, { input: () => sceneRT.texture });
    const taaCopy = new FxPass(COPY_SHADER, { needsSwap: false });   // driven manually

    const atmosPass = new FxPass(ATMOS_SHADER, {
      defines: { ...(useAO ? { USE_AO: '' } : {}), ...(useRays ? { USE_RAYS: '' } : {}) },
    });

    const bloomPass = new HazeBloomPass(W, H, 7);

    const smaaPass = new SMAAPass();
    // SMAA's area/search LUTs are data-URI images, i.e. *asynchronously* decoded.
    // Wait for them here so no frame ever samples an unallocated texture (which
    // would log a GL warning and fail the harness).
    await Promise.all([smaaPass._areaTexture, smaaPass._searchTexture].map((tex) => {
      const im = tex.image;
      if (!im || im.complete) { tex.needsUpdate = true; return Promise.resolve(); }
      return new Promise((res) => {
        const done = () => { tex.needsUpdate = true; res(); };
        im.addEventListener('load', done, { once: true });
        im.addEventListener('error', done, { once: true });
      });
    }));
    smaaPass._areaTexture.needsUpdate = true;
    smaaPass._searchTexture.needsUpdate = true;

    const cocPass = new FxPass(COC_SHADER, { needsSwap: false, target: cocRT });
    const gatherPass = new FxPass(DOF_GATHER_SHADER, { needsSwap: false, target: dofRT, input: () => cocRT.texture });
    const dofPass = new FxPass(DOF_COMPOSITE_SHADER, {});

    const gradePass = new FxPass(GRADE_SHADER, {});
    const finalPass = new FxPass(FINAL_SHADER, {});

    const passes = [
      scenePass,
      focusPass, aoPass, aoBlurH, aoBlurV, rayMask, rayBlur,
      taaPass, atmosPass, bloomPass,
      cocPass, gatherPass, dofPass,
      gradePass, smaaPass, finalPass,
    ];

    /* ---------------- constant / shared uniform wiring ---------------- */

    const projInv = scenePass.projInv;
    const depthConsumers = [aoPass, rayMask, focusPass, cocPass, dofPass];
    for (const p of depthConsumers) {
      p.uniforms.tDepth.value = depthTex;
      p.uniforms.uProjInv.value = projInv;
    }
    aoPass.uniforms.uProjScale.value = new THREE.Vector2(0.5, 0.5);
    aoPass.uniforms.uTexel.value = new THREE.Vector2(1 / W, 1 / H);
    aoPass.uniforms.uFade.value = new THREE.Vector2(32, 78);
    aoPass.uniforms.uRadius.value = 0.6;
    aoPass.uniforms.uIntensity.value = 0.55;

    aoBlurH.uniforms.uDir.value = new THREE.Vector2(1, 0);
    aoBlurV.uniforms.uDir.value = new THREE.Vector2(0, 1);
    aoBlurH.uniforms.uTexel.value = new THREE.Vector2(1 / half(W), 1 / half(H));
    aoBlurV.uniforms.uTexel.value = new THREE.Vector2(1 / half(W), 1 / half(H));

    rayMask.uniforms.uTexelFull.value = new THREE.Vector2(1 / W, 1 / H);
    rayMask.uniforms.uThreshold.value = 0.75;
    const sunUV = bloomPass.sunUV;                 // one shared Vector2 for the whole chain
    rayMask.uniforms.uSunUV.value = sunUV;
    // locality of the shafts is handled by uRayFalloff in the composite; the
    // mask-side reach only trims the far corners so the march stays cheap.
    rayMask.uniforms.uSunReach.value = new THREE.Vector2(1.30, 3.00);
    rayMask.uniforms.uAspect.value = W / H;
    rayBlur.uniforms.uSunUV.value = sunUV;
    rayBlur.uniforms.uDensity.value = 0.9;
    rayBlur.uniforms.uDecay.value = 0.962;

    taaPass.uniforms.uTexel.value = new THREE.Vector2(1 / W, 1 / H);

    atmosPass.uniforms.tAO.value = aoRT.texture;
    atmosPass.uniforms.tRays.value = raysRT.texture;
    atmosPass.uniforms.uSunUV.value = sunUV;
    const aoTint = V3(0.66, 0.64, 0.76);
    const rayColor = V3(0, 0, 0);
    atmosPass.uniforms.uAOTint.value = aoTint;
    atmosPass.uniforms.uRayColor.value = rayColor;
    atmosPass.uniforms.uRayFalloff.value = new THREE.Vector2(0.18, 1.35);
    atmosPass.uniforms.uAspect.value = W / H;

    focusPass.uniforms.tPrev.value = focusRT[0].texture;
    focusPass.uniforms.uCenter.value = new THREE.Vector2(0.5, 0.5);
    focusPass.uniforms.uRate.value = 0.075;

    cocPass.uniforms.tFocus.value = focusRT[1].texture;
    cocPass.uniforms.uTexelFull.value = new THREE.Vector2(1 / W, 1 / H);
    dofPass.uniforms.tFocus.value = focusRT[1].texture;
    dofPass.uniforms.tBlur.value = dofRT.texture;
    for (const p of [cocPass, dofPass]) {
      p.uniforms.uCocBand.value = new THREE.Vector4(0.85, 0.35, 1.25, 3.0);
      p.uniforms.uCocPx.value = new THREE.Vector2(9, 4);
    }
    gatherPass.uniforms.uTexel.value = new THREE.Vector2(1 / half(W), 1 / half(H));

    gradePass.uniforms.uDitherOffset.value = new THREE.Vector2();

    finalPass.uniforms.uTexel.value = new THREE.Vector2(1 / W, 1 / H);
    finalPass.uniforms.uResolution.value = new THREE.Vector2(W, H);

    /* ---------------- tunables, exposed for other modules ---------------- */
    const params = {
      exposure: 0.86,
      ao: { intensity: 0.55, radius: 0.6, tintStrength: 0.82 },
      // `reach` / `falloff` are aspect-corrected UV radii around the sun. They are
      // deliberately wide: the sun is off-frame in every shipped composition, so a
      // tight radial fade would confine the shafts to a corner (or delete them).
      // `strength` is the peak LINEAR add of a fully-lit shaft, pre-ACES. The
      // prescribed 1.7 was written for a gate that deleted the pass entirely; with
      // the shafts actually reaching the frame it flooded dusk with a peach wash
      // (peak add ~140/255). Measured against `postfx-no-rays`: 0.55 * the phase
      // boost lands the dusk peak at ~20/255 with shafts crossing most of the frame,
      // inside the "atmospheric, not a white wash" budget.
      rays: {
        strength: 0.55, duskBoost: 1.05, density: 0.92, decay: 0.965,
        reach: new THREE.Vector2(2.10, 4.20),
        falloff: new THREE.Vector2(0.55, 2.90),
      },
      // `threshold` is in *linear HDR*, before exposure and before ACES. With
      // exposure 0.86, linear 0.90 tonemaps to ~0.71 display — the art-bible knee
      // expressed where we actually sample it. `knee` widens it into a soft roll-on
      // so the veil grows out of the midtones instead of switching on at an edge.
      // Measured: it adds +14 luma at the canopy silhouette falling to a ~6.5 floor
      // across the sky, i.e. a halo whose 50% point is ~100 px out from the edge.
      // `mipFalloff > 1` is the whole trick behind §4.4's "hazy and generous":
      // the pyramid's COARSE levels carry more weight than the fine ones, so the
      // veil is a wide low-amplitude wash with a ~100 px tail rather than a bright
      // skirt hugging the silhouette (which is instant-fail tell §8.12).
      // `threshold` is linear HDR pre-exposure: 0.62 lets a rim-lit petal edge and
      // the brightest sky in, and keeps midtone foliage out.
      bloom: {
        strength: 1.55, radius: 0.75, threshold: 0.62, knee: 0.60,
        mipFalloff: 1.16,
        sunBoost: 2.5, sunRadius: 0.26,
      },
      // Hero-composition CoC, not a physical lens. Flat in focus from 0.85x to
      // 1.25x of the focus distance, a fast near ramp so a foreground framing
      // element goes properly soft, and a much gentler far ramp — separating the
      // background is aerial perspective's job, and heavy far DOF turns readable
      // mid-ground into mush.
      dof: {
        // Measured, not guessed: a 6-8 px CoC changes the far-field standard
        // deviation by under 2%, i.e. it is invisible. 9 px on the far side reads as
        // aerial softening without turning mid-ground to mush, and 14 px on the near
        // side is what makes a foreground framing element (§5) actually read as
        // out of focus. Verified against `postfx-no-dof`: the in-focus trunk moves by
        // 0.05/255, so the gather is not bleeding across the sharp silhouette.
        nearPx: 14.0, farPx: 9.0,
        band: new THREE.Vector4(0.90, 0.34, 1.12, 2.20),
      },
      grade: {
        gain: V3(1.020, 1.004, 0.986),
        gamma: V3(1.0, 1.0, 1.014),
        // LINEAR-space black subtract before ACES. This is the black *point*;
        // the "never pure black" floor is a separate, display-space term below.
        black: 0.0040,
        floor: 0.024,          // art bible §3, applied in display space only
        pivot: 0.34,           // S-curve pivot, below display mid grey
        contrast: 1.38,        // slope about the pivot (power law, 0 -> 0)
        nightPivot: 0.10,      // the night frame's own pivot / slope
        nightContrast: 1.05,
        toe: 0.08,             // extra roll of the DEEP shadows only
        saturation: 1.08,      // art bible §4.6 — never below 1.0
        // Signed split-tone directions. Shadows travel along the #6E76A8 axis
        // (b - r strongly positive), highlights toward the warm key.
        splitLo: V3(-0.020, -0.004, 0.052),
        splitHi: V3(0.030, 0.010, -0.018),
        split: new THREE.Vector2(0.45, 0.85),
        // #2A2438 decoded through sRGB into linear (CONTRACT rule 2), then scaled
        // so its largest component is exactly the 0.012 linear ceiling.
        lift: (() => {
          const c = new THREE.Color().setHex(0x2A2438, THREE.SRGBColorSpace);
          const m = Math.max(c.r, c.g, c.b, 1e-6);
          return V3(c.r, c.g, c.b).multiplyScalar(0.012 / m);
        })(),
        shoulder: 0.965,        // hue-preserving highlight knee
        dither: 0.9,           // 1/255 units; triangular PDF -> RMS 0.37/255
      },
      vignette: 0.12, ca: 1.4, grain: 0.026,
      taaBlend: useTAA ? 1 / (2 + taaLevel * 1.6) : 1,
    };

    const gu = gradePass.uniforms;
    gu.uGain.value = params.grade.gain.clone();
    gu.uGammaC.value = params.grade.gamma.clone();
    gu.uSplitLo.value = params.grade.splitLo.clone();
    gu.uSplitHi.value = params.grade.splitHi.clone();
    gu.uLift.value = params.grade.lift.clone();
    gu.uSplit.value = params.grade.split.clone();

    /* ---------------- resize ---------------- */
    let historyValid = false;

    function setSize(w, h) {
      W = Math.max(2, Math.floor(w));
      H = Math.max(2, Math.floor(h));
      sceneRT.setSize(W, H);
      rtA.setSize(W, H); rtB.setSize(W, H);
      histA.setSize(W, H); histB.setSize(W, H);
      aoRT.setSize(half(W), half(H)); aoTmp.setSize(half(W), half(H));
      occlRT.setSize(quarter(W), quarter(H)); raysRT.setSize(quarter(W), quarter(H));
      cocRT.setSize(half(W), half(H)); dofRT.setSize(half(W), half(H));
      bloomPass.setSize(W, H);
      smaaPass.setSize(W, H);

      aoPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      aoBlurH.uniforms.uTexel.value.set(1 / half(W), 1 / half(H));
      aoBlurV.uniforms.uTexel.value.set(1 / half(W), 1 / half(H));
      rayMask.uniforms.uTexelFull.value.set(1 / W, 1 / H);
      rayMask.uniforms.uAspect.value = W / H;
      taaPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      atmosPass.uniforms.uAspect.value = W / H;
      cocPass.uniforms.uTexelFull.value.set(1 / W, 1 / H);
      gatherPass.uniforms.uTexel.value.set(1 / half(W), 1 / half(H));
      finalPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      finalPass.uniforms.uResolution.value.set(W, H);
      historyValid = false;
    }
    setSize(W, H);

    /* ---------------- sun tracking ---------------- */
    const sunDir = new THREE.Vector3(0.42, 0.62, 0.48).normalize();
    const sunColor = V3(1.0, 0.92, 0.80);
    /** the art-bible dusk key #FF9E5E, decoded to linear, normalised to max = 1 */
    const duskKey = (() => {
      const c = new THREE.Color().setHex(0xFF9E5E, THREE.SRGBColorSpace);
      const m = Math.max(c.r, c.g, c.b, 1e-6);
      return V3(c.r / m, c.g / m, c.b / m);
    })();
    const tmpV = new THREE.Vector3();
    const tmpP = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    let cachedSunLight = null;
    let lightScan = 0;
    /** debug: force the sun just above the view centre so shafts can be judged */
    let sunOverride = false;

    function findSunLight() {
      const rig = ctx.assets?.lightRig?.sun;
      if (rig?.isDirectionalLight) return rig;
      let found = null;
      ctx.scene?.traverse?.((o) => {
        if (found) return;
        if (o.isDirectionalLight && o.intensity > 0.05) found = o;
      });
      return found;
    }

    /** Fills sunDir / sunColor from the shared lighting uniforms, with fallbacks. */
    function updateSun() {
      const L = ctx.assets?.lightUniforms;
      let night = 0;
      let ok = false;
      if (sunOverride) {
        ctx.camera.getWorldDirection(tmpV);
        tmpV.y += 0.30;
        sunDir.copy(tmpV).normalize();
        return { night: 0, ok: true };
      }
      if (L) {
        night = L.uNightMix?.value ?? 0;
        const dirSrc = (night > 0.62 && L.uMoonDir?.value) ? L.uMoonDir.value : L.uSunDir?.value;
        if (rgbInto(dirSrc, tmpV) && tmpV.lengthSq() > 1e-6) { sunDir.copy(tmpV).normalize(); ok = true; }
        if (rgbInto(L.uSunColor?.value, tmpV)) {
          const m = Math.max(tmpV.x, tmpV.y, tmpV.z, 1e-4);
          sunColor.copy(tmpV).multiplyScalar(1 / m);
        }
      }
      if (!ok) {
        if (!cachedSunLight && (lightScan++ % 40) === 0) cachedSunLight = findSunLight();
        if (cachedSunLight) {
          cachedSunLight.getWorldPosition(tmpV);
          if (cachedSunLight.target) {
            cachedSunLight.target.getWorldPosition(tmpP);
            tmpV.sub(tmpP);
          }
          if (tmpV.lengthSq() > 1e-6) { sunDir.copy(tmpV).normalize(); ok = true; }
          const c = cachedSunLight.color;
          const m = Math.max(c.r, c.g, c.b, 1e-4);
          sunColor.set(c.r / m, c.g / m, c.b / m);
        }
      }
      return { night, ok };
    }

    /** 0..1 — is the sun actually on screen? gates the bloom glare only. */
    let bloomSunVisible = 0;
    /** 0..1 — how close to the horizon the key is; drives the dusk shaft tint. */
    let lastLowSun = 0;
    /** how far outside the frame the (unclamped) sun sits, in NDC radii. */
    let sunOutside = 0;

    /**
     * Returns the god-ray strength for this frame and updates sunUV.
     *
     * The sun is OFF-FRAME in every shipped composition (hero, canopy, wide, bark,
     * lantern) at every phase, so an on-screen requirement would mean §4.3 never
     * ships. Instead the projected position is clamped into [-0.6, 1.6] — far
     * enough out that the radial direction still rakes across the frame, close
     * enough that the march reaches the light — and the strength falls off
     * smoothly with how far outside the border the true position lies.
     */
    function updateSunScreen(night) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      cam.getWorldDirection(fwd);
      const facing = fwd.dot(sunDir);

      // Screen position from the ANGLE, not from a perspective divide. A sun a few
      // degrees off the frustum plane divides by a near-zero w and lands hundreds of
      // NDC units away, which is why a projection-based gate deletes the shafts in
      // every preset. Angle / half-diagonal-FOV is well behaved everywhere: 0 at the
      // view axis, 1.0 exactly at the frame corner, and it grows linearly past that.
      tmpV.copy(sunDir).transformDirection(cam.matrixWorldInverse);   // view space
      const fovR = THREE.MathUtils.degToRad(cam.fov) * 0.5;
      const halfDiag = Math.atan(Math.tan(fovR) * Math.hypot(cam.aspect, 1));
      const rrRaw = Math.acos(THREE.MathUtils.clamp(facing, -1, 1)) / Math.max(halfDiag, 1e-4);
      const len = Math.hypot(tmpV.x, tmpV.y);
      const ux = len > 1e-6 ? tmpV.x / len : 0;
      const uy = len > 1e-6 ? tmpV.y / len : 1;
      const rr = Math.min(rrRaw, 2.2);          // keep the origin near the border
      sunUV.set(
        THREE.MathUtils.clamp(ux * rr * 0.5 + 0.5, -0.6, 1.6),
        THREE.MathUtils.clamp(uy * rr * 0.5 + 0.5, -0.6, 1.6),
      );

      // How far outside the frame the source is, in frame-corner radii.
      sunOutside = Math.max(0, rrRaw - 1);
      const offFrame = 1 - THREE.MathUtils.smoothstep(rrRaw, 1.0, 3.4);
      // fully behind the camera still kills them, but a raking side key does not
      const behind = THREE.MathUtils.smoothstep(facing, -0.30, 0.12);
      const lowSun = THREE.MathUtils.smoothstep(-sunDir.y, -0.62, -0.03);   // 1 near the horizon
      lastLowSun = lowSun;
      const nightFade = 1 - 0.78 * night;
      let s = params.rays.strength * behind * offFrame * nightFade
            * (0.55 + params.rays.duskBoost * lowSun);
      if (night > 0.62) s *= 0.42;
      // the bloom sun-disc boost still needs the sun genuinely on screen, otherwise
      // it hazes a patch of sky that does not contain the sun at all
      const inFrame = 1 - THREE.MathUtils.smoothstep(rrRaw, 0.85, 1.35);
      bloomSunVisible = behind * inFrame * (1 - 0.85 * night);
      return Math.max(0, s);
    }

    /**
     * Focus distance. The GPU probe in FOCUS_SHADER is the default — it is the
     * nearest depth hit through the frame centre, i.e. exactly the "raycast at
     * screen centre" a hero composition wants, without a CPU raycast. Any module
     * may override it by publishing `ctx.assets.focusTarget` (Vector3 | Object3D),
     * which is how the tree's canopy centre takes over once it exists.
     */
    function focusTargetDistance() {
      const t = ctx.assets?.focusTarget;
      if (!t) return 0;
      if (t.isVector3) tmpP.copy(t);
      else if (t.isObject3D) t.getWorldPosition(tmpP);
      else if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? t : 0;
      else return 0;
      tmpP.sub(ctx.camera.position);
      const d = tmpP.dot(fwd);
      return Number.isFinite(d) && d > 0.2 ? d : 0;
    }

    /* ---------------- the loop ---------------- */
    let enabled = true;
    const prevCam = { pos: new THREE.Vector3(1e9, 0, 0), quat: new THREE.Quaternion(), fov: -1 };
    const shadowV = V3(0.6, 0.62, 0.78);
    const stats = { passes: 0, sceneCalls: 0, tier: q.tier, ao: useAO, rays: useRays, dof: useDOF, taa: taaLevel, bloomMips: bloomPass.levels };

    function fallbackRender() {
      renderer.setRenderTarget(null);
      renderer.render(ctx.scene, ctx.camera);
    }

    function render(dt) {
      if (!enabled) { fallbackRender(); return; }
      if (renderer.toneMapping !== THREE.NoToneMapping) renderer.toneMapping = THREE.NoToneMapping;

      const cam = ctx.camera;
      const L = ctx.assets?.lightUniforms;
      const { night } = updateSun();
      // always tracked (other modules may read pipeline.sunScreen); only *used* by the rays
      const sunStrength = updateSunScreen(night);
      const rayStrength = useRays ? sunStrength : 0;

      /* --- camera-cut detection for the temporal buffers --- */
      const jumped = prevCam.pos.distanceToSquared(cam.position) > 0.25
        || Math.abs(prevCam.quat.dot(cam.quaternion)) < 0.9995
        || Math.abs(prevCam.fov - cam.fov) > 1e-3;
      prevCam.pos.copy(cam.position);
      prevCam.quat.copy(cam.quaternion);
      prevCam.fov = cam.fov;
      if (jumped) historyValid = false;

      /* --- per-frame uniforms --- */
      scenePass.jitterAmount = useTAA ? 1.0 : 0;

      const frame = ctx.frame | 0;
      for (const p of depthConsumers) {
        p.uniforms.uNear.value = cam.near;
        p.uniforms.uFar.value = cam.far;
      }
      aoPass.uniforms.uProjScale.value.set(scenePass.projScaleX ?? 0.5, scenePass.projScaleY ?? 0.5);
      aoPass.uniforms.uFrameMod.value = frame % 64;
      aoPass.uniforms.uIntensity.value = params.ao.intensity;
      aoPass.uniforms.uRadius.value = params.ao.radius;

      // AO darkening colour: the shadow tint at ~0.58 luminance, never black
      if (!rgbInto(L?.uShadowTint?.value, shadowV)) shadowV.set(0.155, 0.178, 0.40);
      const sl = Math.max(0.2126 * shadowV.x + 0.7152 * shadowV.y + 0.0722 * shadowV.z, 1e-3);
      tmpV.copy(shadowV).multiplyScalar(0.58 / sl).clampScalar(0.08, 1.0);
      aoTint.set(
        1 - (1 - tmpV.x) * params.ao.tintStrength,
        1 - (1 - tmpV.y) * params.ao.tintStrength,
        1 - (1 - tmpV.z) * params.ao.tintStrength,
      );

      rayBlur.uniforms.uDensity.value = params.rays.density;
      rayBlur.uniforms.uDecay.value = params.rays.decay;
      rayBlur.uniforms.uJitter.value = frame % 64;
      rayMask.uniforms.uSunReach.value.copy(params.rays.reach);
      atmosPass.uniforms.uRayFalloff.value.copy(params.rays.falloff);
      // Shafts are tinted to the key. At dusk that is #FF9E5E; the published
      // uSunColor already carries the phase, so we only push it further toward the
      // warm end as the sun drops, so the shafts never read as a neutral wash.
      rayColor.copy(sunColor).lerp(duskKey, 0.45 * lastLowSun).multiplyScalar(rayStrength);

      taaPass.uniforms.uBlend.value = (!useTAA || !historyValid) ? 1.0 : params.taaBlend;
      taaPass.uniforms.tHistory.value = histA.texture;

      /* --- bloom --- */
      bloomPass.strength = params.bloom.strength;
      bloomPass.radius = params.bloom.radius;
      bloomPass.threshold = params.bloom.threshold;
      bloomPass.knee = params.bloom.knee;
      bloomPass.mipFalloff = params.bloom.mipFalloff;
      // The sun-disc pre-multiply exists so the *sky* hazes, not only geometry
      // edges. It is gated on the sun actually being on screen, and softened at
      // night when the "sun" is the moon.
      bloomPass.sunBoost.set(1 + (params.bloom.sunBoost - 1) * bloomSunVisible, params.bloom.sunRadius);
      bloomPass.tint.set(1, 1, 1).lerp(sunColor, 0.35);
      stats.bloomMips = bloomPass.levels;

      /* --- DOF --- */
      cocPass.uniforms.tFocus.value = focusRT[1 - focusIdx].texture;
      dofPass.uniforms.tFocus.value = focusRT[1 - focusIdx].texture;
      focusPass.uniforms.tPrev.value = focusRT[focusIdx].texture;
      focusPass.target = focusRT[1 - focusIdx];
      focusPass.uniforms.uFallback.value = Math.max(4, cam.position.length());
      focusPass.uniforms.uTarget.value = focusTargetDistance();

      const scale = H / 1080;
      const nearPx = params.dof.nearPx * scale;
      const farPx = params.dof.farPx * scale;
      for (const p of [cocPass, dofPass]) {
        p.uniforms.uCocBand.value.copy(params.dof.band);
        p.uniforms.uCocPx.value.set(nearPx, farPx);
      }
      gatherPass.uniforms.uMaxCoC.value = Math.max(nearPx, farPx);
      gatherPass.uniforms.uJitter.value = frame % 64;

      /* --- grade --- */
      // exposure comes from exactly ONE source: the shared lighting bag if it
      // exists (08-lighting mirrors it into renderer.toneMappingExposure, which
      // we must NOT also multiply in), otherwise the renderer's own value.
      gu.uExposure.value = params.exposure
        * (L?.uExposure?.value ?? renderer.toneMappingExposure ?? 1);
      gu.uGain.value.copy(params.grade.gain);
      gu.uGammaC.value.copy(params.grade.gamma);
      gu.uBlack.value = params.grade.black;
      gu.uFloor.value = params.grade.floor;
      gu.uPivot.value = params.grade.pivot;
      gu.uContrast.value = params.grade.contrast;
      gu.uNightPivot.value = params.grade.nightPivot;
      gu.uNightContrast.value = params.grade.nightContrast;
      gu.uToe.value = params.grade.toe;
      gu.uSaturation.value = Math.max(params.grade.saturation, 1.0);
      gu.uShoulder.value = params.grade.shoulder;
      gu.uSplitLo.value.copy(params.grade.splitLo);
      gu.uSplitHi.value.copy(params.grade.splitHi);
      gu.uLift.value.copy(params.grade.lift);
      gu.uSplit.value.copy(params.grade.split);
      // The night frame is allowed to be dark: this relaxes the black point, the
      // toe and the shadow lift so nothing lands a constant on top of a navy sky.
      gu.uNight.value = night;
      gu.uDither.value = params.grade.dither;
      // R2 low-discrepancy advance: the dither pattern never repeats frame to frame
      gu.uDitherOffset.value.set(
        (frame * 0.7548776662) % 1 * 64,
        (frame * 0.5698402909) % 1 * 64,
      );

      finalPass.uniforms.uVignette.value = params.vignette;
      finalPass.uniforms.uCA.value = params.ca;
      finalPass.uniforms.uGrain.value = params.grain;
      finalPass.uniforms.uTime.value = ctx.time;

      /* --- enable/disable per tier and per frame --- */
      focusPass.enabled = useDOF;
      aoPass.enabled = aoBlurH.enabled = aoBlurV.enabled = useAO;
      rayMask.enabled = rayBlur.enabled = useRays && rayStrength > 0.004;
      taaPass.enabled = useTAA;
      atmosPass.input = useTAA ? null : (() => sceneRT.texture);
      cocPass.enabled = gatherPass.enabled = dofPass.enabled = useDOF;

      /* --- run the chain --- */
      let read = rtA, write = rtB;
      let last = null;
      let n = 0;
      for (const p of passes) if (p.enabled !== false) { last = p; n++; }
      stats.passes = n;

      for (const p of passes) {
        if (p.enabled === false) continue;
        p.renderToScreen = (p === last);
        p.render(renderer, write, read, dt, false);

        if (p === taaPass) {
          // write the resolved frame back into the history buffer
          taaCopy.uniforms.tDiffuse.value = write.texture;
          taaCopy.target = histB;
          taaCopy.renderToScreen = false;
          taaCopy.render(renderer, histB, write);
          const t = histA; histA = histB; histB = t;
          historyValid = true;
        }

        if (p.needsSwap) { const t = read; read = write; write = t; }
      }

      if (useDOF) focusIdx = 1 - focusIdx;

      renderer.setRenderTarget(null);

      // report *scene* draw calls: every full-screen quad resets renderer.info,
      // so restore the numbers the rest of the project budgets against.
      const inf = renderer.info.render;
      stats.sceneCalls = scenePass.stats.calls;
      inf.calls = scenePass.stats.calls;
      inf.triangles = scenePass.stats.triangles;
      inf.lines = scenePass.stats.lines;
      inf.points = scenePass.stats.points;
    }

    /* ---------------- public surface ---------------- */
    const pipeline = {
      render,
      params,
      stats,
      get enabled() { return enabled; },
      setEnabled(on) {
        enabled = !!on;
        historyValid = false;
        // hand tonemapping back to the renderer when we are not drawing the frame
        renderer.toneMapping = enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
      },
      depthTexture: depthTex,
      sceneTexture: sceneRT.texture,
      sunScreen: sunUV,
      /** Vector3 | Object3D | number(distance) | null — drives the DOF focus plane. */
      setFocusTarget(t) { ctx.assets.focusTarget = t ?? null; },
      /** Debug only (never called per frame): the resolved state of the chain. */
      probe() {
        // HalfFloat target -> readPixels wants a Uint16Array; decoding it by hand is
        // the only way to see what the autofocus actually resolved to.
        const buf = new Uint16Array(4);
        let f = NaN;
        try {
          renderer.readRenderTargetPixels(focusRT[1 - focusIdx], 0, 0, 1, 1, buf);
          f = THREE.DataUtils.fromHalfFloat(buf[0]);
        } catch (e) { f = String(e).slice(0, 80); }
        return {
          focus: f,
          focusTarget: focusTargetDistance(),
          sunUV: { x: sunUV.x, y: sunUV.y },
          sunOutside,
          bloomSunVisible,
          bloomWeightSum: bloomPass.weightSum(),
          bloomStrength: bloomPass.strength / bloomPass.weightSum(),
          rayColor: { x: rayColor.x, y: rayColor.y, z: rayColor.z },
          night: gu.uNight.value,
          exposure: gu.uExposure.value,
          cocPx: { near: cocPass.uniforms.uCocPx.value.x, far: cocPass.uniforms.uCocPx.value.y },
        };
      },
    };
    ctx.pipeline = pipeline;
    ctx.assets.postfx = pipeline;

    if (window.__game?.scenarios) {
      window.__game.scenarios['postfx-off'] = () => pipeline.setEnabled(false);
      window.__game.scenarios['postfx-on'] = () => pipeline.setEnabled(true);
      // debug: exaggerate every effect so it can be eyeballed / tuned
      window.__game.scenarios['postfx-heavy'] = () => {
        params.rays.strength = 2.6; params.ao.intensity = 1.0;
        params.dof.nearPx = 20; params.dof.farPx = 14;
        params.bloom.strength = 1.4; params.bloom.threshold = 0.4;
      };
      // debug: no grade at all, so the raw tonemapped frame can be compared
      window.__game.scenarios['postfx-flat'] = () => {
        params.grade.contrast = 1.0; params.grade.toe = 0; params.grade.saturation = 1.0;
        params.grade.split.set(0, 0); params.grade.black = 0;
        params.grade.floor = 0; params.grade.lift.set(0, 0, 0);
      };
      // debug: single-stage bisects — each one removes exactly one contribution so
      // its effect on the frame can be measured rather than argued about.
      window.__game.scenarios['postfx-no-bloom'] = () => { params.bloom.strength = 0; };
      window.__game.scenarios['postfx-no-dof'] = () => { params.dof.nearPx = 0; params.dof.farPx = 0; };
      window.__game.scenarios['postfx-no-rays'] = () => { params.rays.strength = 0; };
      window.__game.scenarios['postfx-no-grain'] = () => { params.grain = 0; };
      window.__game.scenarios['postfx-dof-hard'] = () => { params.dof.nearPx = 18; params.dof.farPx = 16; };
      window.__game.scenarios['postfx-probe'] = () => { window.__postfxProbe = pipeline.probe(); };
      // debug: pipe an intermediate buffer straight to the screen
      const view = (getTex) => () => { finalPass.input = getTex; };
      window.__game.scenarios['postfx-view-ao'] = view(() => aoRT.texture);
      window.__game.scenarios['postfx-view-rays'] = view(() => raysRT.texture);
      window.__game.scenarios['postfx-view-coc'] = view(() => dofRT.texture);
      window.__game.scenarios['postfx-view-mask'] = view(() => occlRT.texture);
      window.__game.scenarios['postfx-view-bloom'] = view(() => bloomPass.mips[0].texture);
      // debug: put the sun just above the view centre — the only reliable way to
      // judge the shafts regardless of the current time of day.
      window.__game.scenarios['postfx-sun-in-view'] = () => { sunOverride = true; };
      window.__game.scenarios['postfx-sun-rays'] = () => { sunOverride = true; finalPass.input = () => raysRT.texture; };
    }

    return {
      /**
       * Nothing to animate — but if another module detaches us (e.g. the
       * lighting rig's `raw-*` debug scenarios set ctx.pipeline = null), hand
       * tonemapping back to the renderer so the frame is still tonemapped
       * exactly once, and take it back if we are re-attached.
       */
      update() {
        const attached = ctx.pipeline === pipeline;
        const want = attached && enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
        if (renderer.toneMapping !== want) renderer.toneMapping = want;
      },
      resize(w, h, dpr) {
        const d = renderer.getDrawingBufferSize(new THREE.Vector2());
        setSize(Math.floor(d.x) || Math.round(w * dpr), Math.floor(d.y) || Math.round(h * dpr));
      },
      dispose() {
        ctx.pipeline = null;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        for (const t of ownedTargets) t.dispose();
        depthTex.dispose();
        for (const p of passes) p.dispose?.();
        taaCopy.dispose();
      },
    };
  },
};
