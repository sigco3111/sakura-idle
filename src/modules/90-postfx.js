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
    this.headroom = 1.0;
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
    cu.uHeadroom.value = this.headroom;
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
    // The seed must be a BLOB around the source, not the whole sky — see the
    // comment in RAY_MASK_SHADER. Values are aspect-corrected UV radii.
    rayMask.uniforms.uSunReach.value = new THREE.Vector2(0.30, 1.05);
    rayMask.uniforms.uAspect.value = W / H;
    rayBlur.uniforms.uSunUV.value = sunUV;
    rayBlur.uniforms.uDensity.value = 0.9;
    rayBlur.uniforms.uDecay.value = 0.962;
    rayBlur.uniforms.uShape.value = 1.5;

    taaPass.uniforms.uTexel.value = new THREE.Vector2(1 / W, 1 / H);

    atmosPass.uniforms.tAO.value = aoRT.texture;
    atmosPass.uniforms.tRays.value = raysRT.texture;
    atmosPass.uniforms.uSunUV.value = sunUV;
    const aoTint = V3(0.66, 0.64, 0.76);
    const rayColor = V3(0, 0, 0);
    atmosPass.uniforms.uAOTint.value = aoTint;
    atmosPass.uniforms.uRayColor.value = rayColor;
    atmosPass.uniforms.uRayFalloff.value = new THREE.Vector4(0.02, 0.24, 2.50, 6.00);
    atmosPass.uniforms.uRayDamp.value = new THREE.Vector2(0.85, 0.55);
    atmosPass.uniforms.uRayShaft.value = new THREE.Vector3(4.0, 0.10, 0.0);
    atmosPass.uniforms.uRayContrast.value = new THREE.Vector2(0, 1);
    atmosPass.uniforms.uAspect.value = W / H;

    focusPass.uniforms.tPrev.value = focusRT[0].texture;
    focusPass.uniforms.uCenter.value = new THREE.Vector2(0.5, 0.5);
    focusPass.uniforms.uClamp.value = new THREE.Vector2(1.0, 400.0);
    focusPass.uniforms.uAnchor.value = new THREE.Vector2(0.0, 0.0);
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
      // `reach` is the SEED blob radius around the sun (aspect-corrected UV) and
      // `falloff` the radial fade of the finished shafts in the composite; the
      // second is deliberately much wider than the first, because a shaft is
      // longer than the source that spawned it.
      // Every value below is measured against the matching `postfx-<phase>-no-rays`
      // bisect; the ROUND 2 section of the MEASURED-BEHAVIOUR log at the bottom of
      // this file records what each one bought.
      rays: {
        // `strength` is the peak linear add of a fully-lit shaft; `duskBoost` is the
        // MULTIPLIER applied at dawn/dusk (art bible 4.3 "strong at dawn/dusk"), so
        // the phase factor is (1 + (duskBoost-1)*lowSun) and reads 1.0 flat at noon.
        // `density` is the FRACTION of the distance to the sun the march covers;
        // `decay` weights the taps along it. The two are not interchangeable, and
        // this is where the pass was failing: RAY_BLUR normalises the march to an
        // AVERAGE, so at decay 0.94 the effective march is 1/(1-0.94) = 17 of 64
        // taps, i.e. r is a local blur of the mask ~0.15 frame-heights long. That
        // cannot be a shaft — measured on hero/day it was a smooth wash following
        // the cloud shapes with zero radial streaking, and the ground (whose ray has
        // to travel through the canopy to reach sky) got +0.4/255, not a shadow.
        // At decay 0.985 the weight after 64 taps is still 0.38, so the whole ray
        // contributes and r becomes "what fraction of the line of sight to the sun
        // is unoccluded" — which IS a shaft.
        // `shape` is the contrast knob and the one that decides whether the pass
        // reads as SHAFTS or as GLOW: r is an occlusion average in 0..1, so r^shape
        // leaves the fully-clear rays at 1 and pushes every partially-blocked one
        // down. Measured on hero/day as (mean add along a 0.35H arc around the sun,
        // number of arc peaks with >=0.10 L prominence):
        //   shape 1.9, strength 0.55  ->  arc mean 0.089,  2 peaks
        //   shape 2.3, strength 0.90  ->  see the ROUND 2 log at the bottom
        // ROUND 3: the r2 numbers produced shafts on hero/dusk (6 arc peaks at
        // >= 0.10 L prominence) but a flat glow on canopy/dusk, which is the one
        // frame designed to show them — the sun sits at sunUV (0.874, 0.192),
        // bottom-right, and the measured ray-buffer arc at r = 0.30H read
        // 0.47 0.34 0.24 0.23 0.27 0.23 0.26 0.29 0.30 0.29 0.21 0.22 ... i.e. a
        // smooth ramp with +/-0.05 wiggles. Multiplied by the r2 struct floor of
        // 0.18 and damped by 0.85 on a bright peach sky, that is +/-0.02 display,
        // which is exactly what the critic measured. strength and shape are the two
        // knobs that convert ray-buffer contrast into display contrast; the struct
        // floor is what was throwing it away.
        // ROUND 4: `shape` 3.0 -> 1.5. See the long comment in RAY_BLUR_SHADER —
        // pow(r, 3) was one of two crushes both centred on the sun and it turned a
        // measured raw march of 0.20/0.31/0.44/0.75 (four points left-to-right
        // across dusk/hero) into 0.007/0.029/0.085/0.42.
        strength: 0.95, duskBoost: 1.15, dayScale: 0.34, density: 0.92, decay: 0.985, shape: 1.5,
        // (linear-HDR luma where the add starts being damped, damping amount).
        // Damping starts later and takes less: at dusk the destination beside the
        // sun is a peach sky at luma 0.4-0.7, so a 0.85 damp starting at 0.25 was
        // removing 80% of the add over the entire region the shafts cross.
        damp: new THREE.Vector2(0.38, 0.82),
        // (cross-ray HIGH-PASS gain, absolute-level gain, noise deadband) of the
        // additive term. The first number is the one that makes shafts; the second
        // is a small r^2 root so a shaft is not floating in nothing; the third is
        // the noise floor of the quarter-res march, subtracted before the rectifier
        // so the positive half of that noise does not become a DC wash over the
        // sky. Deliberately lopsided — an additive term proportional to the
        // absolute ray level is a radial lobe by construction and cannot be tuned
        // into a shaft (see ATMOS_SHADER).
        shaft: new THREE.Vector3(11.0, 0.05, 0.018),
        // MULTIPLICATIVE cross-ray contrast (gain, perpendicular-baseline width
        // scale). This is the term that finally made the shafts visible, and the
        // reason the previous three rounds could not: `strength` and `damp` only
        // ever ADD, and the ray buffer only carries signal where the march can see
        // bright sky — i.e. precisely the region `damp` was built to protect from
        // clipping. Measured, dusk/hero, shafts.mjs on the (rays - no-rays) delta,
        // arc peaks at >= 0.10 L prominence over four radii: see the ROUND 4 log.
        // ROUND 4: contrastWidth 6.0 -> 1.3. At 6.0 the four perpendicular baselines
        // in rayStructure() sat at 0.048/0.108/0.228/0.432 UV — 92 to 830 px on a
        // 1920 frame — so "the local cross-ray baseline" was most of the frame and
        // st.x measured broad lobes, not shafts. At 1.3 they are 0.010/0.023/0.049/
        // 0.094 UV = 20/45/95/180 px, which brackets a real crepuscular shaft.
        contrast: 1.50, contrastWidth: 1.05,
        // `threshold` is the linear-HDR luma at which sky counts as a full-strength
        // shaft source, and `floor` how much a dimmer patch of visible sky still
        // seeds. Measured with pipeline.sample('scene', u, v): the sky right beside
        // the sun reads luma ~0.9 at golden hour and ~0.45 at dusk, so a threshold
        // of 0.75 (what shipped) meant the dusk sky — the one phase §4.3 calls out
        // as strongest — barely seeded anything at all.
        // ROUND 4: floor 0.30 -> 0.10. The floor is what a DIM patch of visible sky
        // still seeds, so it is also the contrast the CLOUDS get to carve with — and
        // clouds are the canonical crepuscular-ray occluder. At 0.30 a dark cloud
        // still seeded 30% and the shaft fan collapsed to the one boundary the
        // canopy silhouette makes.
        threshold: 0.30, floor: 0.10,
        // `reach` localises the SEED (aspect-corrected UV radius around the source);
        // `falloff` is a vec4 (innerStart, innerEnd, outerStart, outerEnd) radial
        // window applied to the FINISHED shafts in the composite. The outer pair is
        // deliberately far away — a shaft's body extends AWAY from its source, and a
        // tight outer fade cancels the structure exactly where it is longest. The
        // inner pair is what stops the pass painting a solid lobe of maximum add over
        // the unoccluded sky at the source; see the comment in ATMOS_SHADER.
        // Scale applied while the shafts converge on the antisolar point instead
        // of radiating from the sun — see updateSunScreen().
        antiScale: 0.75,
        // ROUND 4: (0.62, 1.85) -> (2.10, 4.40), and the falloff in RAY_MASK is no
        // longer SQUARED. The seed feeds a march ALONG the line of sight to the sun,
        // so a seed that only exists near the sun makes the march answer "how close
        // to the sun am I" instead of "did my ray clear the canopy". Measured mask
        // values that proved it are in the RAY_MASK_SHADER comment. Where the shafts
        // are DRAWN is `falloff`'s job, not the seed's.
        reach: new THREE.Vector2(2.10, 4.40),
        falloff: new THREE.Vector4(0.06, 0.24, 1.50, 3.20),
      },
      // `strength` is normalised by the pyramid's weight sum (see
      // HazeBloomPass.render step 5), so it means "peak amplitude of the veil as a
      // fraction of the thresholded highlight that produced it" — the same thing
      // UnrealBloomPass's `strength` means, and therefore directly comparable with
      // ART_BIBLE §4.4's 0.55. It was shipped at 1.55, i.e. 2.8x the art bible, and
      // that is measurable in the frame: bloom alone was lifting the whole sky by
      // +0.088 display luminance (22/255) and the canopy halo by +0.101, which is
      // most of why the mid-distance had no value separation left. At 0.62 the sky
      // lift is +0.030 and the backlit-canopy halo +0.045 — still unmistakable,
      // no longer a veil over the whole frame.
      // `mipFalloff > 1` is the whole trick behind §4.4's "hazy and generous":
      // the pyramid's COARSE levels carry more weight than the fine ones, so the
      // veil is a wide low-amplitude wash with a long tail rather than a bright
      // skirt hugging the silhouette (which is instant-fail tell §8.12).
      // `threshold` is linear HDR pre-exposure; 0.72 keeps flat midtone sky out of
      // the veil so the bloom reads as an effect on bright edges and the sun side
      // of the sky rather than as global haze.
      bloom: {
        strength: 0.55, radius: 0.75, threshold: 0.85, knee: 0.60,
        mipFalloff: 1.16,
        // The sun-disc pre-multiply pushes sky that sits just under the knee over
        // it so the sky itself hazes. At dusk the sun is IN FRAME in every shipped
        // preset now (measured fwd.uSunDir = +0.72..+0.82, r 0.94..1.63 frame
        // radii), so a 2.5x pre-multiply was blooming the brightest, largest and
        // flattest thing in the frame. 1.6 keeps the glare read and stops it from
        // being the dominant term in the veil.
        sunBoost: 1.6, sunRadius: 0.22,
        headroom: 1.0,
      },
      // Hero-composition CoC, not a physical lens. Flat in focus from 0.85x to
      // 1.25x of the focus distance, a fast near ramp so a foreground framing
      // element goes properly soft, and a much gentler far ramp — separating the
      // background is aerial perspective's job, and heavy far DOF turns readable
      // mid-ground into mush.
      dof: {
        // Measured with film grain off (grain alone puts a 0.06 sobel floor on every
        // region and hides everything smaller), hero preset, region edge energy
        // against `postfx-no-dof`:
        //
        //                        far hills   ground @40m   trunk silhouette
        //   old (2.20 / 9px)      -33%         -44%          -6.8%
        //   this (5.50 / 5px)     -25%          -8%           0.0%
        //
        // The old far band reached full blur at 2.2x the focus distance, i.e. at
        // 45 m in the hero composition — that is mid-ground, and blurring it is
        // what made the frame read as mush. The far ramp now only gets going past
        // 1.8x and needs 5.5x to reach its (halved) maximum, so what it actually
        // softens is the distant hills, which is all §4.5 asks for.
        // The near side is unchanged in shape and untestable in the current
        // composition (nothing in the hero frame is closer than 0.9x focus); it is
        // sized so a foreground framing element (§5) goes properly soft.
        // Near CoC dropped 12 -> 8.5 px. At 12 px a 26 px near-field petal sprite
        // came out of the gather as a featureless ~42 px disc (measured on wide-f0);
        // 8.5 px keeps the notch and the curl readable while still reading as a soft
        // foreground framing element. `maxCoC` is a HARD ceiling in 1080p pixels.
        nearPx: 8.5, farPx: 5.0, maxCoC: 14.0,
        // (nearFocusEdge, nearMaxEdge, farFocusEdge, farMaxEdge) as ratios of the
        // focus distance. Tightened from (0.55, 0.18, 1.80, 5.50): at the hero
        // focus of ~25 m the old plateau ran 13.8-45 m, i.e. 31 m of "in focus",
        // which is most of the scene and is why the frame had no crisp PLANE — the
        // trunk was sharp only because everything was. 0.80..1.40 is a 15 m band
        // centred on the tree: it holds the whole trunk and canopy (the tree is
        // ~10 m across) and still puts the hills and the near field outside it.
        band: new THREE.Vector4(0.80, 0.35, 1.40, 4.20),
        // Legal range for the autofocus probe, as a multiple of the distance to the
        // hero subject (see subjectDistance()). Wide enough that the probe still
        // chooses the plane; narrow enough that a depth buffer with a hole in it
        // cannot park focus on the horizon.
        // MEASURED: with the old (0.55, 1.70) band the GPU probe resolved to 42.3 m
        // in EVERY phase and every preset — i.e. it was pinned to the far end of its
        // own legal range, focusing past the tree onto the hills, because the frame
        // centre of the hero composition falls in a gap between branches and reads
        // the far depth. Narrowing to (0.80, 1.25) x subjectDistance locks the plane
        // on the tree (20-31 m for hero) while still letting the probe choose inside
        // it, which is what "focus locked to the trunk" has to mean when the probe
        // cannot be trusted to find the trunk.
        // Widened on the near side from (0.80, 1.25) because the anchor is no
        // longer a fixed world POINT but the aim distance along the view ray (see
        // subjectDistance()), so a close-up preset's legal band now actually
        // contains its subject: bark's band was [5.05, 7.90] m around a trunk
        // standing at 3.1 m.
        subjectBand: new THREE.Vector2(0.60, 1.28),
        // How far the GPU probe is pulled toward that geometric aim distance.
        // 0 = trust the depth probe alone, which is what r2 did: the hero frame
        // centre falls in a gap between branches so the probe pinned at the far
        // end of its band, and the bark probe pinned at the NEAR end of its band,
        // 2 m behind the trunk that fills 60% of the frame. MEASURED probe per
        // preset, before -> after (m): hero 31.6 -> 28.4, canopy 11.0 -> 11.4,
        // bark 5.05 -> 3.43, wide 45.7 -> 47.2, pond 12.2 -> 10.9 — it only moves
        // where the probe and the geometry disagree.
        anchorMix: 0.5,
      },
      grade: {
        gain: V3(1.020, 1.004, 0.986),
        gamma: V3(1.0, 1.0, 1.014),
        // LINEAR-space black subtract before ACES. This is the black *point*;
        // the "never pure black" floor is a separate, display-space term below.
        // Measured on the `bark` preset (the only shipped composition that
        // currently contains genuinely dark content): flat p1 0.236 -> 0.145 with
        // this value, darkest pixel 0.052 — i.e. a real low end that still sits on
        // ART_BIBLE §3's 0.055 "never pure black" line rather than under it. 0.025
        // was tried and pushed the darkest pixels to 0.044, below the floor.
        black: 0.018,
        // SCENE-LINEAR log contrast (contrast, pivot), the curve that owns the
        // frame's range. Chosen by simulating GRADE_SHADER's luma path against
        // the measured input distribution (pipeline.histogram('grade')) rather
        // than by eye — see the MEASURED-BEHAVIOUR log at the bottom of the file.
        sceneCurve: new THREE.Vector2(2.10, 0.34),
        // Night has ~1/12 the scene luminance, so a pivot of 0.34 would put the
        // WHOLE night frame in the crush half of the power law. Its own pivot
        // sits at the night median and its slope is much gentler.
        sceneCurveNight: new THREE.Vector2(1.20, 0.035),
        // (knee, log-log slope below it, knee softness) of the scene curve's TOE.
        // A pure power law of slope 2.10 keeps accelerating downward forever, which
        // is what took the r2 canopy frame's zenith through zero; below the knee the
        // slope is clamped to 0.90 so the deep end is compressed GENTLY and can
        // never be crushed. The knee sits well under the day p05 of the grade's
        // input (measured: canopy p05 0.186, hero p05 0.252, bark p05 0.286), so
        // the midtones and the mid-ground separation are untouched — measured
        // collateral on a mid-grey is under 0.2%.
        sceneToe: V3(0.10, 0.90, 0.30),
        // How much of the curve's driver is the MAX channel rather than Rec.709
        // luma. See the long comment at the call site in GRADE_SHADER: 0 (what r2
        // shipped) hands a saturated blue sky to the power law as if it were a
        // shadow. Sampled effect on the frame, display L, day:
        //                       zenith sky  hero sky  grass lit  dirt  cloud  vermilion
        //   0.00 (r2)             0.199      0.354     0.609     0.589  0.762   0.136
        //   0.55                  0.361      0.445     0.625     0.594  0.816   0.209
        //   1.00                  0.464      0.508     0.636     0.598  0.847   0.263
        // The neutral surfaces move 1-2% and the saturated ones 1.5-2x, which is
        // exactly the selectivity that makes this safe.
        curveNorm: 0.55,
        floor: 0.024,          // art bible §3, applied in display space only
        pivot: 0.34,           // display S-curve pivot, below display mid grey
        contrast: 1.00,        // slope about the pivot (power law, 0 -> 0)
        nightPivot: 0.10,      // the night frame's own pivot / slope
        nightContrast: 1.02,
        toe: 0.05,             // extra roll of the DEEP shadows only
        saturation: 1.14,      // art bible §4.6 — never below 1.0
        // (amount, falloff power) of the low-chroma-only saturation boost. The
        // hero frame's satMean is dragged down almost entirely by one band —
        // measured in 12 horizontal strips, the aerial-haze band at 41-66% of
        // frame height reads HSL sat 0.12-0.18 while every other strip is
        // 0.25-0.31 — and that band is near-neutral, so a flat multiplier moves
        // it hardly at all. Weighting by (1-chroma)^2.2 puts the boost where the
        // mud is: 2.8x at chroma 0, 1.5x at 0.5, 1.13x on the already-saturated
        // canopy and vermilion, which is what keeps it from going garish.
        vibrance: new THREE.Vector2(2.10, 2.2),
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
      // ART_BIBLE §3's "never pure black", enforced after the vignette and the
      // grain. 0.056 = 14/255 per channel, which is the number a hard floor has to
      // be for the darkest CHANNEL of the darkest pixel to clear it — a luminance
      // floor alone cannot, because a saturated blue can carry L 0.20 with its red
      // channel at 0. Relaxed at night: the navy sky is legitimately the darkest
      // thing the game ever shows and a full-strength floor takes its p1 from
      // 0.038 to 0.077, i.e. visibly milky.
      floorFinal: 0.056, floorNightScale: 0.55,
      taaBlend: useTAA ? 1 / (2 + taaLevel * 1.6) : 1,
      // Jitter is in full-res pixels: below ~1 px the Halton pattern cannot reach
      // the sub-pixel positions an alpha-tested cutout edge needs sampled, and much
      // above 1.5 px the frame reads soft. `taaGamma` is the variance-clip width.
      // Measured on hero, same build, warm 420 (spikeH = isolated 1-px luminance
      // spikes per 1000 px, the actual aliasing signature; trunk = Sobel over a
      // 300x300 box on the trunk):
      //   TAA off          spikeH 52.2   trunk 0.521
      //   jitter 1.00      spikeH 23.7   trunk 0.403
      //   jitter 1.35      spikeH 16.8   trunk 0.389
      // i.e. 1.35 px buys 29% less aliasing for 3.5% less edge energy over 1.0 px,
      // and the 25% the temporal filter costs against no-TAA at all is bought back
      // by the contrast-adaptive sharpen in FINAL (params.sharpen) rather than by
      // under-jittering.
      taaJitter: 1.35, taaGamma: 1.6, taaWiden: 0.06,
      // AMD CAS, after SMAA. Adaptive: its amplitude goes to 0 exactly where the
      // local range is already clipped, so it cannot re-print the aliasing the
      // temporal filter just removed.
      sharpen: 0.18,
    };

    const gu = gradePass.uniforms;
    gu.uGain.value = params.grade.gain.clone();
    gu.uGammaC.value = params.grade.gamma.clone();
    gu.uSplitLo.value = params.grade.splitLo.clone();
    gu.uSplitHi.value = params.grade.splitHi.clone();
    gu.uLift.value = params.grade.lift.clone();
    gu.uSplit.value = params.grade.split.clone();
    gu.uVibrance.value = params.grade.vibrance.clone();
    gu.uSceneCurve.value = params.grade.sceneCurve.clone();
    gu.uSceneCurveNight.value = params.grade.sceneCurveNight.clone();
    gu.uSceneToe.value = params.grade.sceneToe.clone();

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
    /** debug: bypass the temporal resolve (the per-frame enable is recomputed) */
    let taaOff = false;
    /** debug: ATMOS outputs the god-ray contribution ALONE, over black */
    let raySolo = 0;

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

    /** 1 when the radial origin is the ANTISOLAR point, 0 when it is the sun. */
    let rayAnti = 0;
    /** the ray gates (behind / off-frame / night / phase) WITHOUT rays.strength. */
    let rayGate = 0;
    const rayDirV = new THREE.Vector3();

    /**
     * Returns the god-ray strength for this frame and updates sunUV.
     *
     * The sun is OFF-FRAME in every shipped composition (hero, canopy, wide, bark,
     * lantern) at almost every phase, so an on-screen requirement would mean §4.3
     * never ships. The projected position is therefore clamped into [-0.6, 1.6] —
     * far enough out that the radial direction still rakes across the frame, close
     * enough that the march reaches the light — and the strength falls off smoothly
     * with how far outside the border the true position lies.
     *
     * MEASURED sun geometry per phase (probe: fwd . uSunDir, and the angle in
     * frame-corner radii). This is the whole reason the branch below exists:
     *
     *            hero            canopy          gameplay
     *   dawn     +0.94  r1.00    +0.74  r1.00    +0.91  r1.00
     *   day      -0.07  r2.80    +0.46  r1.39    -0.14  r3.07
     *   golden   -0.49  r3.57    +0.08  r1.90    -0.56  r3.88
     *   dusk     -0.86  r4.44    -0.42  r2.57    -0.90  r4.82
     *
     * i.e. the sun rises IN FRONT of the shipped cameras and sets BEHIND them. At
     * dawn it is inside the frame and the shafts are unmistakable; by dusk it is
     * 115-160 degrees behind the lens, where a crepuscular shaft radiating from the
     * sun's screen position is not a stylisation, it is a different scene.
     *
     * What is actually in frame at dusk is the ANTISOLAR point — measured at 0.92
     * frame radii (inside the frame) for hero and 1.45 for canopy — and the real
     * sky phenomenon there is ANTI-CREPUSCULAR rays: the same cloud and canopy
     * shadows, converging instead of radiating. So when the key goes behind the
     * camera the radial origin flips to -uSunDir and the shafts converge on it.
     * The mask still only seeds where there is genuinely bright sky, so this can
     * never invent light: it redirects an effect that already had a source.
     */
    function updateSunScreen(night) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      cam.getWorldDirection(fwd);
      const sunFacing = fwd.dot(sunDir);

      // Flip to the antisolar point once the key is far enough behind the lens that
      // a forward-radiating shaft would be nonsense. Smooth in `rayAnti` so the
      // crossover is a fade, never a pop, and note both sides of the crossover are
      // weak there (the sun is ~90 degrees off axis), so nothing visibly swaps.
      rayAnti = THREE.MathUtils.smoothstep(-sunFacing, 0.02, 0.22);
      rayDirV.copy(sunDir).multiplyScalar(rayAnti > 0.5 ? -1 : 1);
      const facing = rayAnti > 0.5 ? -sunFacing : sunFacing;

      // Screen position. MEASURED against ground truth (project a point 5000 units
      // along uSunDir through the real camera matrix — .tmp-postfx/p-sunproj.js):
      // the previous ANGLE-based estimate, `angle / halfDiagFov` along the
      // view-space lateral direction, was wrong in two independent ways, and the
      // error is what stopped the shafts radiating from the right place.
      //   (1) it used the raw view-space (x, y) as the screen direction, but three's
      //       projection divides x by tan(fov/2)*ASPECT and y by tan(fov/2) — so on
      //       a 16:9 frame every horizontal offset came out 1.78x too large
      //       relative to the vertical one, i.e. the shaft direction was skewed.
      //   (2) `angle / halfDiag` maps the frame CORNER to a UV distance of 0.5,
      //       which is the frame EDGE, so the whole estimate sat ~30% too close to
      //       the centre. Measured on hero/dusk: estimate (0.975, 0.700) against a
      //       true (1.049, 0.914) — a 0.21 UV error, ~14 degrees of shaft rotation.
      // So project properly, and handle the two failure modes a perspective divide
      // has explicitly instead of avoiding it: a source near the frustum plane
      // divides by ~0 (radius clamp below), and one behind the camera flips sign
      // (the `z > eps` branch).
      tmpV.copy(rayDirV).transformDirection(cam.matrixWorldInverse);   // view space
      const fovR = THREE.MathUtils.degToRad(cam.fov) * 0.5;
      const tanY = Math.tan(fovR);
      const tanX = tanY * cam.aspect;
      const halfDiag = Math.atan(tanY * Math.hypot(cam.aspect, 1));
      const z = -tmpV.z;                 // view space looks down -Z
      let nx, ny;
      if (z > 1e-3) {
        nx = (tmpV.x / z) / tanX;        // NDC, 1.0 = frame edge on that axis
        ny = (tmpV.y / z) / tanY;
      } else {
        // behind / on the frustum plane: direction only, parked well outside
        const lat = Math.hypot(tmpV.x / tanX, tmpV.y / tanY) || 1;
        nx = (tmpV.x / tanX) / lat * 9.0;
        ny = (tmpV.y / tanY) / lat * 9.0;
      }
      // 1.0 = exactly the frame corner, matching what the old rrRaw claimed to mean.
      const rNdc = Math.hypot(nx, ny);
      const rrRaw = rNdc / Math.SQRT2;
      // Pull the ORIGIN back toward the border without rotating it: the march has to
      // reach the source, and a source 20 frames away makes `delta` per tap so large
      // that the 64-tap march samples nothing but the sun's own blob.
      const rMax = 2.6;
      const k = rNdc > rMax ? rMax / rNdc : 1;
      sunUV.set(
        THREE.MathUtils.clamp(nx * k * 0.5 + 0.5, -0.8, 1.8),
        THREE.MathUtils.clamp(ny * k * 0.5 + 0.5, -0.8, 1.8),
      );

      // How far outside the frame the source is, in frame-corner radii.
      sunOutside = Math.max(0, rrRaw - 1);
      // Wider than the old (1.0, 3.4): rrRaw is now a true projected radius, which
      // grows much faster than the angular estimate it replaces (hero/day measures
      // 2.12 against the old 1.32 for the same sun), so the same window would have
      // silently halved the daylight shafts.
      const offFrame = 1 - THREE.MathUtils.smoothstep(rrRaw, 1.2, 5.0);
      // fully behind the ORIGIN still kills them, but a raking side key does not
      const behind = THREE.MathUtils.smoothstep(facing, -0.30, 0.12);
      const lowSun = THREE.MathUtils.smoothstep(-sunDir.y, -0.62, -0.03);   // 1 near the horizon
      lastLowSun = lowSun;
      const nightFade = 1 - 0.78 * night;
      let g = behind * offFrame * nightFade
            * (1 + (params.rays.duskBoost - 1) * lowSun)
            // ART_BIBLE 4.3: "strong at dawn/dusk". With the sun high the shafts are
            // near-vertical, they are tinted to a nearly WHITE key, and there is
            // clear blue sky either side of them — measured on the day/hero frame at
            // full strength they printed as three hard white near-vertical streaks
            // over the sky at x 1150-1250 / 1450-1620 / 1780-1850, which reads as a
            // scratched lens, not as light. This is the only gate that distinguishes
            // "the sun is up" from "the sun is low", so the phase shape lives here
            // rather than in the shader.
            * (params.rays.dayScale + (1 - params.rays.dayScale) * lowSun);
      // Converging shafts are a subtler phenomenon than radiating ones and their
      // source is the dim half of the sky, so they get their own scale rather than
      // borrowing the sun-side number.
      g *= 1 + (params.rays.antiScale - 1) * rayAnti;
      if (night > 0.62) g *= 0.42;
      // The gate alone, WITHOUT params.rays.strength — the ATMOS contrast term is a
      // relative modulation and must not be scaled by the additive term's amplitude,
      // but it does have to disappear with the same gates (behind camera, off frame,
      // night) or a switched-off pass would still be printing bands on the sky.
      rayGate = Math.max(0, g);
      const s = params.rays.strength * g;
      // The bloom sun-disc boost needs the REAL sun genuinely on screen — it hazes
      // the sky around the source, and the antisolar point contains no source.
      const sunRR = Math.acos(THREE.MathUtils.clamp(sunFacing, -1, 1)) / Math.max(halfDiag, 1e-4);
      const inFrame = 1 - THREE.MathUtils.smoothstep(sunRR, 0.85, 1.35);
      bloomSunVisible = THREE.MathUtils.smoothstep(sunFacing, -0.30, 0.12) * inFrame * (1 - 0.85 * night);
      return Math.max(0, s);
    }

    /**
     * Focus distance. The GPU probe in FOCUS_SHADER is the default — it is the
     * nearest depth hit through the frame centre, i.e. exactly the "raycast at
     * screen centre" a hero composition wants, without a CPU raycast. Any module
     * may override it by publishing `ctx.assets.focusTarget` (Vector3 | Object3D),
     * which is how the tree's canopy centre takes over once it exists.
     */
    /**
     * The hero subject's distance, from CONTRACT's world convention: "tree trunk
     * base sits at origin (0,0,0), +Y up, tree ~14 units tall", so the canopy mass
     * centres near (0, 7, 0). This is a *bound*, not the focus itself — the GPU
     * probe still decides where inside the bound to sit.
     */
    const subjectPoint = new THREE.Vector3(0, 7, 0);
    /**
     * "How far away is the thing this camera is aimed at."
     *
     * A fixed world POINT is the wrong answer, and measurably so: every shipped
     * preset aims somewhere on the tree's vertical axis (hero at y 7.5, bark at
     * y 2.4, canopy at y 11), but their distances to a single point at (0,7,0)
     * differ from their distances to what they are actually looking at by up to
     * 2x — the bark camera is 6.3 m from (0,7,0) and 3.8 m from the trunk it is
     * pointed at. So this solves for the closest approach between the view ray
     * and the trunk axis instead (CONTRACT: "trunk base sits at origin, +Y up"),
     * which is the same number as `raycast the screen centre` for every preset
     * whose subject is the tree, and needs no raycast.
     *
     * Falls back to the point distance for a ray that is climbing or diving
     * steeply enough that its horizontal closest approach is meaningless.
     */
    function subjectDistance() {
      const cam = ctx.camera;
      const t = ctx.assets?.focusSubject;
      if (t?.isVector3 || t?.isObject3D) {
        if (t.isVector3) tmpP.copy(t); else t.getWorldPosition(tmpP);
        return Math.max(1.5, tmpP.distanceTo(cam.position));
      }
      const dd = fwd.x * fwd.x + fwd.z * fwd.z;
      if (dd > 0.06) {
        const s = -(cam.position.x * fwd.x + cam.position.z * fwd.z) / dd;
        if (Number.isFinite(s) && s > 0.75) return Math.max(1.5, s);
      }
      return Math.max(1.5, subjectPoint.distanceTo(cam.position));
    }

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
    /**
     * debug only — a frozen copy of the buffer GRADE_SHADER consumed. The
     * ping-pong buffer itself is clobbered by SMAA later in the same frame, so
     * the tone curve's true input has to be snapshotted while it is still live.
     */
    let gradeInRT = null;
    let dbgCapture = false;
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
      rayBlur.uniforms.uShape.value = params.rays.shape;
      rayBlur.uniforms.uJitter.value = frame % 64;
      rayMask.uniforms.uSunReach.value.copy(params.rays.reach);
      rayMask.uniforms.uThreshold.value = params.rays.threshold;
      rayMask.uniforms.uFloor.value = params.rays.floor;
      atmosPass.uniforms.uRayFalloff.value.copy(params.rays.falloff);
      atmosPass.uniforms.uRayDamp.value.copy(params.rays.damp);
      atmosPass.uniforms.uRayShaft.value.copy(params.rays.shaft);
      atmosPass.uniforms.uRayContrast.value.set(
        useRays ? params.rays.contrast * rayGate : 0, params.rays.contrastWidth);
      atmosPass.uniforms.uRaySolo.value = raySolo;
      // Shafts are tinted to the key. At dusk that is #FF9E5E; the published
      // uSunColor already carries the phase, so we only push it further toward the
      // warm end as the sun drops, so the shafts never read as a neutral wash.
      rayColor.copy(sunColor).lerp(duskKey, 0.45 * lastLowSun * (1 - 0.55 * rayAnti))
        .multiplyScalar(rayStrength);

      taaPass.uniforms.uBlend.value = (!useTAA || !historyValid) ? 1.0 : params.taaBlend;
      taaPass.uniforms.tHistory.value = histA.texture;
      taaPass.uniforms.uGamma.value = params.taaGamma;
      taaPass.uniforms.uWiden.value = params.taaWiden;

      /* --- bloom --- */
      bloomPass.strength = params.bloom.strength;
      bloomPass.radius = params.bloom.radius;
      bloomPass.threshold = params.bloom.threshold;
      bloomPass.knee = params.bloom.knee;
      bloomPass.mipFalloff = params.bloom.mipFalloff;
      bloomPass.headroom = params.bloom.headroom;
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
      const dSub = subjectDistance();
      focusPass.uniforms.uClamp.value.set(params.dof.subjectBand.x * dSub,
        params.dof.subjectBand.y * dSub);
      focusPass.uniforms.uAnchor.value.set(dSub, params.dof.anchorMix);

      const scale = H / 1080;
      const cap = params.dof.maxCoC * scale;
      const nearPx = Math.min(params.dof.nearPx * scale, cap);
      const farPx = Math.min(params.dof.farPx * scale, cap);
      for (const p of [cocPass, dofPass]) {
        p.uniforms.uCocBand.value.copy(params.dof.band);
        p.uniforms.uCocPx.value.set(nearPx, farPx);
      }
      gatherPass.uniforms.uMaxCoC.value = Math.min(Math.max(nearPx, farPx), cap);
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
      gu.uVibrance.value.copy(params.grade.vibrance);
      gu.uSceneCurve.value.copy(params.grade.sceneCurve);
      gu.uSceneCurveNight.value.copy(params.grade.sceneCurveNight);
      gu.uSceneToe.value.copy(params.grade.sceneToe);
      gu.uCurveNorm.value = params.grade.curveNorm;
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
      finalPass.uniforms.uFloor.value = params.floorFinal
        * (1 - (1 - params.floorNightScale) * night);
      finalPass.uniforms.uTime.value = ctx.time;
      finalPass.uniforms.uSharpen.value = useTAA ? params.sharpen : params.sharpen * 0.45;

      /* --- enable/disable per tier and per frame --- */
      focusPass.enabled = useDOF;
      aoPass.enabled = aoBlurH.enabled = aoBlurV.enabled = useAO;
      rayMask.enabled = rayBlur.enabled = useRays && rayStrength > 0.004;
      const taaOn = useTAA && !taaOff;
      scenePass.jitterAmount = taaOn ? params.taaJitter : 0;
      taaPass.enabled = taaOn;
      atmosPass.input = taaOn ? null : (() => sceneRT.texture);
      cocPass.enabled = gatherPass.enabled = dofPass.enabled = useDOF;

      /* --- run the chain --- */
      let read = rtA, write = rtB;
      let last = null;
      let n = 0;
      for (const p of passes) if (p.enabled !== false) { last = p; n++; }
      stats.passes = n;

      for (const p of passes) {
        if (p.enabled === false) continue;
        // debug only: remember which buffer the tone curve actually consumed, so
        // histogram('grade') measures the true input distribution of the curve
        // rather than the raw scene target several passes upstream.
        if (p === gradePass && dbgCapture) {
          if (!gradeInRT) gradeInRT = new THREE.WebGLRenderTarget(W, H, HDR);
          if (gradeInRT.width !== W || gradeInRT.height !== H) gradeInRT.setSize(W, H);
          taaCopy.uniforms.tDiffuse.value = read.texture;
          taaCopy.target = gradeInRT;
          taaCopy.renderToScreen = false;
          taaCopy.render(renderer, gradeInRT, read);
          dbgCapture = false;
        }
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
      /**
       * Debug only. Reads back one pixel of an intermediate HDR buffer, decoding
       * the HalfFloat by hand. This is how the god-ray mask's luminance threshold
       * was calibrated instead of guessed: `sampleScene(u,v)` returns the actual
       * linear-HDR luma of the sky at a UV, which is the number RAY_MASK_SHADER's
       * `uThreshold` has to sit below.
       */
      sample(which, u, v) {
        const rt = { scene: sceneRT, rays: raysRT, mask: occlRT, ao: aoRT, dof: dofRT,
          grade: gradeInRT ?? sceneRT }[which] ?? sceneRT;
        const x = Math.max(0, Math.min(rt.width - 1, Math.round(u * rt.width)));
        const y = Math.max(0, Math.min(rt.height - 1, Math.round(v * rt.height)));
        const buf = new Uint16Array(4);
        try {
          renderer.readRenderTargetPixels(rt, x, y, 1, 1, buf);
          const f = (i) => THREE.DataUtils.fromHalfFloat(buf[i]);
          const r = f(0), g = f(1), b = f(2);
          return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        } catch (e) { return { error: String(e).slice(0, 80) }; }
      },
      /**
       * Debug only. Luminance percentiles of a whole intermediate HDR buffer.
       * `sample()` answers "what is this pixel"; this answers "what is the
       * DISTRIBUTION the tone curve has to work with", which is the only way to
       * design a toe/shoulder that lands on a target p1 instead of guessing at it.
       */
      /** Debug only. Snapshot the tone curve's input on the NEXT rendered frame. */
      captureGradeInput() { dbgCapture = true; },
      histogram(which = 'scene', stride = 3) {
        const rt = { scene: sceneRT, rays: raysRT, mask: occlRT, ao: aoRT, dof: dofRT,
          grade: gradeInRT ?? sceneRT }[which] ?? sceneRT;
        const w = rt.width, h = rt.height;
        const buf = new Uint16Array(w * h * 4);
        try { renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf); }
        catch (e) { return { error: String(e).slice(0, 120) }; }
        const F = THREE.DataUtils.fromHalfFloat;
        const vals = [];
        for (let y = 0; y < h; y += stride) {
          for (let x = 0; x < w; x += stride) {
            const i = (y * w + x) * 4;
            const l = 0.2126 * F(buf[i]) + 0.7152 * F(buf[i + 1]) + 0.0722 * F(buf[i + 2]);
            vals.push(Number.isFinite(l) ? Math.max(l, 0) : 0);
          }
        }
        vals.sort((a, b) => a - b);
        const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))];
        // 201 evenly spaced quantiles: enough to simulate the whole tone chain
        // offline and predict p1 / p50 / p99 / blown before touching a shader.
        const quant = [];
        for (let i = 0; i <= 200; i++) quant.push(+q(i / 200).toFixed(5));
        return {
          n: vals.length, w, h,
          min: q(0), p001: q(0.001), p01: q(0.01), p05: q(0.05), p10: q(0.10),
          p25: q(0.25), p50: q(0.50), p75: q(0.75), p90: q(0.90), p99: q(0.99), max: q(1),
          quant,
        };
      },
      /** Debug only. Raw linear luma at a coarse grid, for band/region measurements. */
      grid(which = 'scene', nx = 24, ny = 14) {
        const out = [];
        for (let j = 0; j < ny; j++) {
          const row = [];
          for (let i = 0; i < nx; i++) {
            const s = this.sample(which, (i + 0.5) / nx, (j + 0.5) / ny);
            row.push(+(s.luma ?? -1).toFixed(4));
          }
          out.push(row);
        }
        return out;
      },
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
          rayAnti,
          rayGate,
          rayContrast: atmosPass.uniforms.uRayContrast.value.x,
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
        params.grade.sceneCurve.set(1, 0.34); params.grade.sceneCurveNight.set(1, 0.035);
        params.grade.sceneToe.set(1e-5, 1.0, 0.30); params.grade.curveNorm = 0;
        params.grade.vibrance.set(0, 2.2);
        params.floorFinal = 0;
      };
      // just the tone curve removed — isolates "did the S-curve neutralise the
      // rig's cool-shadow / warm-highlight split?" from every other grade term.
      window.__game.scenarios['postfx-no-curve'] = () => {
        params.grade.sceneCurve.set(1, 0.34); params.grade.sceneCurveNight.set(1, 0.035);
        params.grade.sceneToe.set(1e-5, 1.0, 0.30);
        params.grade.black = 0;
      };
      // The three r3 terms, each bisectable on its own. `no-norm` puts the curve
      // back on Rec.709 luma (the r2 behaviour that crushed the saturated sky),
      // `no-toe` removes the toe-slope clamp, `no-floor` removes the post-grain
      // "never pure black" guarantee, and `no-cas` removes the sharpen entirely.
      window.__game.scenarios['postfx-no-norm'] = () => { params.grade.curveNorm = 0; };
      window.__game.scenarios['postfx-no-toe'] = () => { params.grade.sceneToe.set(1e-5, 1.0, 0.30); };
      window.__game.scenarios['postfx-no-floor'] = () => { params.floorFinal = 0; params.grade.floor = 0; };
      window.__game.scenarios['postfx-no-cas'] = () => { params.sharpen = 0; };
      window.__game.scenarios['postfx-no-vibrance'] = () => { params.grade.vibrance.set(0, 2.2); };
      // debug: single-stage bisects — each one removes exactly one contribution so
      // its effect on the frame can be measured rather than argued about.
      window.__game.scenarios['postfx-no-bloom'] = () => { params.bloom.strength = 0; };
      window.__game.scenarios['postfx-no-dof'] = () => { params.dof.nearPx = 0; params.dof.farPx = 0; };
      window.__game.scenarios['postfx-no-rays'] = () => { params.rays.strength = 0; };
      window.__game.scenarios['postfx-no-grain'] = () => { params.grain = 0; };
      // SMAA off — the only way to measure what the AA pass is actually worth.
      window.__game.scenarios['postfx-no-smaa'] = () => { smaaPass.enabled = false; };
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
      // Composite debug scenarios — the harness only takes ONE --scenario, and
      // every god-ray / DOF claim below needs two switches thrown at once
      // (a time of day AND a bisect), so the pairs are registered here.
      const chain = (...names) => () => { for (const n of names) window.__game.scenarios[n]?.(); };
      window.__game.scenarios['postfx-dawn-test'] = chain('stage5', 'dawn');
      window.__game.scenarios['postfx-dawn-test-off'] = chain('stage5', 'dawn', 'postfx-no-rays');
      window.__game.scenarios['postfx-dawn-view'] = chain('stage5', 'dawn', 'postfx-view-rays');
      window.__game.scenarios['postfx-rays-test'] = chain('stage5', 'dusk');
      window.__game.scenarios['postfx-rays-test-off'] = chain('stage5', 'dusk', 'postfx-no-rays');
      window.__game.scenarios['postfx-rays-view'] = chain('stage5', 'dusk', 'postfx-view-rays');
      window.__game.scenarios['postfx-dusk-no-grain'] = chain('dusk', 'postfx-no-grain');
      window.__game.scenarios['postfx-no-dof-no-grain'] = chain('postfx-no-dof', 'postfx-no-grain');
      window.__game.scenarios['postfx-no-smaa-no-grain'] = chain('postfx-no-smaa', 'postfx-no-grain');
      window.__game.scenarios['postfx-stage5'] = chain('stage5');
      window.__game.scenarios['postfx-stage5-no-dof'] = chain('stage5', 'postfx-no-dof');
      window.__game.scenarios['postfx-stage5-no-grain'] = chain('stage5', 'postfx-no-grain');
      window.__game.scenarios['postfx-stage5-no-dof-no-grain'] = chain('stage5', 'postfx-no-dof', 'postfx-no-grain');
      // Per-phase bisects. Every god-ray / bloom / DOF number in the log at the
      // bottom of this file was read off exactly one of these pairs.
      for (const ph of ['dawn', 'day', 'golden', 'dusk', 'night']) {
        window.__game.scenarios[`postfx-${ph}-no-rays`] = chain(ph, 'postfx-no-rays');
        window.__game.scenarios[`postfx-${ph}-no-bloom`] = chain(ph, 'postfx-no-bloom');
        window.__game.scenarios[`postfx-${ph}-no-dof`] = chain(ph, 'postfx-no-dof');
        window.__game.scenarios[`postfx-${ph}-rays-view`] = chain(ph, 'postfx-view-rays');
        window.__game.scenarios[`postfx-${ph}-plain`] = chain(ph);
      }
      // The two scenarios that answer "do the god rays render at all", in isolation:
      //   postfx-rays-buffer — the raw quarter-res shaft buffer straight to screen
      //                        (`r` after the march, before any windowing/tinting)
      //   postfx-rays-solo   — what ATMOS actually ADDS to the frame: the tinted
      //                        additive term plus the positive half of the contrast
      //                        modulation, over black, with every window, structure
      //                        gate and headroom damp applied. If this frame is
      //                        black, the pass is contributing nothing.
      window.__game.scenarios['postfx-rays-buffer'] = view(() => raysRT.texture);
      window.__game.scenarios['postfx-rays-solo'] = () => { raySolo = 1; };
      for (const ph of ['dawn', 'day', 'golden', 'dusk', 'night']) {
        window.__game.scenarios[`postfx-${ph}-rays-buffer`] = chain(ph, 'postfx-rays-buffer');
        window.__game.scenarios[`postfx-${ph}-rays-solo`] = chain(ph, 'postfx-rays-solo');
        window.__game.scenarios[`postfx-${ph}-no-contrast`] =
          chain(ph, 'postfx-no-ray-contrast');
        // the whole grade bypassed at a given phase — the only way to attribute a
        // stats.mjs gate (flatBlocks, crushed, satMean) to the tone curve rather
        // than to the scene.
        window.__game.scenarios[`postfx-${ph}-flat`] = chain(ph, 'postfx-flat');
        window.__game.scenarios[`postfx-${ph}-no-grain`] = chain(ph, 'postfx-no-grain');
        window.__game.scenarios[`postfx-${ph}-no-dof-no-grain`] =
          chain(ph, 'postfx-no-dof', 'postfx-no-grain');
        window.__game.scenarios[`postfx-${ph}-no-smaa-no-grain`] =
          chain(ph, 'postfx-no-smaa', 'postfx-no-grain');
      }
      window.__game.scenarios['postfx-no-ray-contrast'] = () => { params.rays.contrast = 0; };
      window.__game.scenarios['postfx-no-taa'] = () => { taaOff = true; };
      window.__game.scenarios['postfx-no-taa-no-grain'] = chain('postfx-no-taa', 'postfx-no-grain');
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
        gradeInRT?.dispose();
        depthTex.dispose();
        for (const p of passes) p.dispose?.();
        taaCopy.dispose();
      },
    };
  },
};

/* ====================================================================== *
 * MEASURED BEHAVIOUR — what each stage actually does to the frame.
 *
 * Numbers marked (ng) were read off renders with film grain disabled
 * (`postfx-no-grain`; grain alone puts a ~0.06 sobel floor on every region and
 * hides anything smaller). Hero preset, 1920x1080, ultra tier, default (day)
 * phase unless stated. "edge energy" = mean Sobel gradient magnitude over a
 * named box; the boxes and the diffing live in .tmp-postfx/regions.mjs.
 *
 * NOTE ON REPEATABILITY: two runs of the SAME scenario differ by up to 210/255
 * on individual pixels — the blossom cards and petal positions are not
 * bit-repeatable between processes. Region MEANS over 10^5 pixels are stable to
 * a few tenths of a percent, so every claim below is a region mean, and any
 * per-region delta under ~2% is reported as "unchanged" rather than as signal.
 *
 * TONE CURVE  (`postfx-flat` bypasses the whole grade, `postfx-no-curve` only
 *              the scene-linear curve + black point)
 *   hero, whole frame:        p1      p50     p99     satMean  detail  flat16
 *     grade off (flat)       0.2551  0.6174  0.9151   0.184    0.163   0.148
 *     shipped                0.0805  0.5594  0.9148   0.310    0.255   0.051
 *   crushed = 0 and blown = 0 in both. The frame it started from had 1.9 stops
 *   between its darkest 1% and its median (measured: grade input p1 0.108,
 *   p50 0.400 linear), which is why no post-ACES curve could open it up — the
 *   contrast now runs in SCENE-LINEAR space before ACES, and ACES's own shoulder
 *   is what stops the sky clipping while p1 drops by a factor of 3.
 *   The curve was not guessed: pipeline.histogram('grade') returns 201 quantiles
 *   of the tone curve's real input and .tmp-postfx/curve.mjs replays the shader's
 *   luma path over them, so (contrast 2.10, pivot 0.34, black 0.018) was chosen
 *   by solving for p1 in 0.05-0.10 with blown = 0, then confirmed on the PNG.
 *
 * DOES THE GRADE PRESERVE THE RIG'S SPLIT TONE?  (stats.mjs groundSplitTone —
 *   lit surfaces only, negative = cool shadows + warm highlights)
 *     grade off (flat)      shadowHue  94.8   highlightHue 92.2   split   -2.6
 *     curve off (no-curve)  shadowHue  98.8   highlightHue 90.8   split   -8.0
 *     shipped               shadowHue 228.7   highlightHue 90.3   split -138.4
 *   i.e. the ungraded frame has NO split at all (both quartiles the same green);
 *   the tone curve is what separates the shadow family far enough down the range
 *   for the rig's cool ambient to read. The grade creates the split, it does not
 *   neutralise it. Per-band saturation over the hills rose 0.05-0.18 -> 0.13-0.46.
 *
 * MID-GROUND VALUE SEPARATION  (vertical luminance profile, x 0.03-0.33,
 *   .tmp-postfx/profile.mjs — "are the three hill bands distinguishable?")
 *     far ridge  mid ridge trough  near treeline
 *     flat      0.747      0.551          0.673      peak-to-trough 0.196
 *     shipped   0.803      0.394          0.654      peak-to-trough 0.409
 *   The grade DOUBLES the separation. What is left of the milky band (y 0.55-0.63,
 *   rgb 127,145,139, sat 0.13-0.18) is not a post-processing artefact: measured
 *   contribution to that band is bloom +1.0% luminance, DOF -0.3% luminance.
 *   It is the aerial-perspective fog colour (uFogColor, owned by 08-lighting /
 *   15-sky) reading near-neutral where ART_BIBLE §3 asks for #BCD3EA.
 *
 * DEPTH OF FIELD  (ng, edge energy vs `postfx-no-dof-no-grain`)
 *                     far hills  hills mid  ground @40m  trunk   trunk edge  fg grass
 *   old (2.20, 9 px)    -34%        -        -76%        -14%       -         -
 *   shipped (5.50/5px)  -22.8%    -8.9%      -0.3%      +2.4%    +2.6%     -35.6%
 *   The far hill band loses 22.8% of its edge energy while the trunk silhouette
 *   comes out of the DOF pass as sharp as the no-DOF render (+2.4/+2.6%, i.e.
 *   inside run noise) and the readable mid-ground at 40 m is untouched: §4.5's
 *   "gentle", and §5's out-of-focus near field is doing real work (-35.6%).
 *   Against `--q low` (which disables DOF via ctx.quality) the same far-hill box
 *   reads 0.0386 (ultra, DOF on) vs 0.0500 (no DOF) — same conclusion, but that
 *   comparison also changes grass density and shadow-map size, so the scenario
 *   bisect above is the one to trust.
 *   Autofocus resolves per preset: hero 25.2 m, canopy 15.7, bark 4.7, wide 54.7.
 *
 * BLOOM  (display luminance added vs `postfx-no-bloom`, 255 units)
 *                          sky   far hills   canopy   haze band   trunk
 *   old (strength 1.55)   22.1     14.6       23.6        -         -
 *   shipped (0.55)         6.4      5.0        5.0       1.4       0.5
 *   `strength` is divided by the pyramid's WEIGHT SUM (11.41 at 1080p with
 *   mipFalloff 1.16 over 7 mips), not by the mip count — probe() reports
 *   bloomWeightSum 11.414 and bloomStrength 0.0482 = 0.55/11.414, which is the
 *   correct normalisation for a progressive tent upsample where mip 0 ends up
 *   holding SUM(falloff^i * blur_i). So 0.55 means what 0.55 means in
 *   UnrealBloomPass, matching ART_BIBLE §4.4, and the veil is a 5-6/255 wash on
 *   the bright half of the frame with 0.5/255 in the shadows — hazy, not a halo.
 *
 * GOD RAYS  (display luminance added vs `postfx-no-rays`, 255 units)
 *   Sun geometry per phase, measured (fwd . uSunDir / angle in frame radii):
 *              hero          canopy        gameplay
 *     dawn    +0.94 r1.00   +0.74 r1.00   +0.91 r1.00
 *     day     -0.07 r2.80   +0.46 r1.39   -0.14 r3.07
 *     golden  -0.49 r3.57   +0.08 r1.90   -0.56 r3.88
 *     dusk    -0.86 r4.44   -0.42 r2.57   -0.90 r4.82
 *   The sun RISES in front of the shipped cameras and SETS behind them, so the
 *   old facing > -0.30 gate produced rayColor exactly (0,0,0) at dusk in every
 *   preset and the shaft buffer rendered pure black. Fixed by flipping the radial
 *   origin to the ANTISOLAR point once the key goes behind the lens (measured at
 *   0.92 frame radii for hero — inside the frame — and 1.45 for canopy), which is
 *   the real anti-crepuscular geometry rather than a fudge.
 *     dawn  / canopy (stage 5):  sky top +14.6,  anti-sun side +11.6,  lower +6.2
 *     dawn  / hero:              sky +15.0
 *     dusk  / hero  (antisolar): sky  +8.3,  trunk +3.0,  field +1.4
 *     dusk  / canopy (antisolar):sky top +5.2,  anti-sun +3.9,  lower +2.4
 *     night:                     ~0 (moon key, 0.42x, and the gate closes)
 *   Ray buffer peaks 0.05 with rayColor 0.586 -> peak linear add 0.030 pre-ACES.
 *
 * NIGHT  (`--scenario night`)
 *   shipped  p1 0.038  p50 0.105  p99 0.903  satMean ~0.55  crushed 0.00024
 *   The night frame is allowed to be dark; the relaxations that make that safe are
 *   the night scene curve (1.20 @ pivot 0.035 instead of 2.10 @ 0.34), the 0.2x
 *   black point, the 0.2x toe, the 0.25x shadow lift and a 0.55x vibrance — at
 *   full daylight vibrance the moonlit grass measured satMean 0.677 and read
 *   emerald rather than moonlit.
 *
 * SMAA  (ng, edge energy with `postfx-no-smaa-no-grain`)
 *   ultra: trunk edge +11.3%, grass +8.9%, trunk +7.8%, canopy +6.0%, hills +1.8%
 *   Removing it puts >10% more edge energy on every silhouette in frame, i.e. it
 *   is resolving real aliasing rather than just softening the image.
 *
 * ====================================================================== *
 * ROUND 2 (post-critic 2.9/10). Everything below was measured on THIS build,
 * 1920x1080, ultra, --warm 420, against a same-build scenario bisect. The sun
 * arc changed between rounds (08-lighting), which invalidated most of the
 * geometry table above: the sun is now IN FRONT of every shipped camera at every
 * daylight phase, so the antisolar flip never engages (probe rayAnti = 0 in all
 * of dawn/day/golden/dusk/night) and the shafts genuinely radiate from the sun.
 *   probe() sunUV / rayColor.x, hero:
 *     dawn (-0.081, 0.619)  0.773     day  (0.493, 1.185)  0.702
 *     dusk ( 1.014, 0.627)  0.745     night(0.955, 1.276)  0.022
 *
 * GOD RAYS — why the pass produced no shafts, in three parts.
 *  (1) MARCH LENGTH. RAY_BLUR normalises the march to an AVERAGE, so `decay` sets
 *      the effective march: at 0.94 over 64 taps only 1/(1-0.94) = 17 taps carry
 *      weight, i.e. r was a ~0.15-frame-height blur of the mask. Measured on
 *      hero/day, the ray add over the GROUND (whose ray must cross the canopy to
 *      reach sky, i.e. the pixels that should be in shadow) was +0.4/255 — there
 *      was no shadow, therefore no shaft. decay 0.985 keeps weight 0.38 at tap 64
 *      and the same cells read +2..+10/255.
 *  (2) FLAT-FIELD LOBE. Sky at the source is unoccluded, so r ~ 1 over a disc and
 *      a plain composite paints a solid maximum-add lobe. At dawn that lobe alone
 *      produced 14 of the frame's 18 flat 200x200 blocks above L 0.90 (i.e. the
 *      god-ray pass was creating instant-fail tell 8.2). Fixed by an inner radial
 *      fade (falloff.xy) plus rayStructure(), which measures the ray field's
 *      contrast ACROSS the ray and collapses a structureless field to 0.18.
 *      dawn/hero flat bright 200x200 blocks: 18 -> 8 (struct gain 4) -> 12 at the
 *      shipped gain of 8, against a floor of 4 with the pass switched off entirely.
 *  (3) DISPLAY HEADROOM. uRayDamp scales the add by the destination's luminance,
 *      because the near-clipped sky beside the sun converts an add into clipping
 *      while the same add over the canopy and grass is worth 4-6x more display
 *      luminance.
 *   Shipped shaft count, dusk/hero, on the (A - `postfx-dusk-no-rays`) difference,
 *   walking a circular arc around the projected sun and counting local maxima by
 *   prominence against their neighbouring troughs (.tmp-postfx/shafts.mjs):
 *     R=0.25H  1 peak >=0.10 L   3 >=0.03
 *     R=0.40H  1                3
 *     R=0.60H  0                3
 *     R=0.80H  3 (0.13/0.20/0.16)  6
 *   i.e. 6 shafts at >=0.10 L prominence and 15 at >=0.03 across the four radii,
 *   peaks 0.10-0.20 L. Sky cell add peaks 25/255; ground cells 0-2/255.
 *
 * BLOOM — HEADROOM-WEIGHTED COMPOSITE. threshold 0.75 -> 0.85, sunBoost 2.5 -> 1.6,
 *   and the veil is now divided by (1 + luma) in BLOOM_COMPOSITE. Flat 200x200
 *   blocks above L 0.90 with sd < 0.05 (the "hard white halo" test):
 *                        day/hero  day/canopy  dusk/hero  dusk/canopy
 *     round 1               0          7          52          -
 *     shipped               0          0          11          0
 *     shipped, bloom off    0          0           6          0
 *   The residual 6 at dusk are the sky's own gradient (measured L 0.907, sd 0.023
 *   at x1700 y300 with bloom, rays and DOF all off) — owned by 15-sky, not here.
 *
 * TEMPORAL AA + CAS. spikeH = isolated 1-px luminance spikes per 1000 px sampled
 *   over the middle 64% of frame height (the actual aliasing signature; a raw
 *   count of >28-level adjacent transitions measures CONTRAST DENSITY, not
 *   aliasing, and ranks a soft canopy close-up above a detailed wide shot).
 *   Same build, hero / wide:
 *     TAA off, no CAS      spikeH 52.2 / 77.1   trunk Sobel 0.521 / 0.633
 *     TAA on,  no CAS      spikeH 16.8 / 15.2   trunk 0.389 / 0.467
 *     TAA on,  CAS 0.18    spikeH 34.3 / 39.8   trunk 0.438 / 0.512
 *   The middle row is the least aliased and the mushiest; the shipped row keeps
 *   two thirds of the aliasing win and puts the trunk back over the 0.42 target.
 *   The 3x3 variance clip (replacing the 5-tap min/max box) is what made the
 *   accumulation work on alpha-tested blossom edges at all.
 *
 * DEPTH OF FIELD — the autofocus probe was pinned to the FAR end of its legal band
 *   (42.3 m) in every phase and every preset, i.e. focusing past the tree onto the
 *   hills, because the hero frame centre falls in a gap between branches. Band
 *   narrowed to 0.80-1.25 x subjectDistance (20-31 m for hero) and the in-focus
 *   plateau from 31 m to 15 m; near CoC 12 -> 8.5 px so near-field petals keep
 *   their silhouette. hero trunk 300x300 Sobel 0.389 -> 0.438 (target >= 0.42).
 *
 * MOTION — frame-to-frame MAD across a 3-frame strip (18 sim steps apart), which
 *   the wider temporal clamp could have damaged: hero 10.87 / 10.39 and wide 9.31,
 *   with 65-68% of pixels changing more than 3 levels, against 11.07 / 8.93 and
 *   65-66% on shots/critic-p4-r1. Unchanged inside run noise.
 * ====================================================================== *
 * ROUND 4 (critic: "GOD RAYS DO NOT RENDER", third report). Everything below is
 * measured on THIS build, 1920x1080, ultra, --warm 420, --ui 0, against a
 * same-build scenario bisect. Verification ran against an identical copy of the
 * tree at /tmp because two sibling modules were mid-edit and unparseable; only
 * their COMMENTS were repaired in the copy, no logic.
 *
 * WHY THREE ROUNDS OF SHAFTS NEVER RENDERED. Not the composer chain (probe:
 * passes 16, rays enabled, useRays true at ultra), not the sun's screen position
 * (that is exact — projecting a point 5000 units along uSunDir through the real
 * camera matrix reproduces sunUV to 5 decimal places in every phase and preset),
 * and not an empty occlusion input. It was TWO INDEPENDENT MULTIPLICATIVE CRUSHES
 * BOTH CENTRED ON THE SUN, plus an additive term that could not express a shaft:
 *   (1) RAY_MASK multiplied the seed by reach^2 with reach = (0.62, 1.85). Measured
 *       mask, dusk/hero (pipeline.sample('mask',u,v)):
 *         (0.20,0.70) 0.0105   (0.50,0.75) 0.283   (0.90,0.90) 1.000
 *       i.e. the whole left half of the visible sky seeded nothing, and the march
 *       that consumes the seed is an AVERAGE ALONG THE LINE OF SIGHT TO THE SUN, so
 *       every pixel away from the source averaged zeros.
 *   (2) RAY_BLUR then applied pow(r, 3.0). Raw march at four points left-to-right
 *       across dusk/hero was 0.20 / 0.31 / 0.44 / 0.75; after the gamma, 0.007 /
 *       0.029 / 0.085 / 0.42.
 *   (3) ATMOS's add was uRayColor * r * gates. A marched occlusion average is a
 *       smooth radial ramp by construction, so an add proportional to r is a LOBE
 *       whatever is hung off it. Measured shipped-r3 delta vs postfx-dusk-no-rays:
 *       one 120x120 cell at +55.7/255 beside the sun, +2..+7 smeared over the whole
 *       aerial-haze band, and 0-1 arc peak at >= 2.5/255 prominence at R = 0.25H
 *       and 0.40H. That is the glow the critic saw, and part of the milky band.
 *   FIXED: seed taper widened to (2.10, 4.40) and un-squared; shape 3.0 -> 1.5; the
 *   add is now driven by the cross-ray HIGH PASS (a local-extremum test, see
 *   rayStructure) with a noise deadband, a soft knee, and a small r^2 root.
 *   Ray field, dusk/hero, same four points AFTER: 0.084 / 0.109 / 0.200 / 0.299
 *   (mask at (0.20,0.70) 0.349), sunUV (1.0482, 0.9174) = just off the top-right
 *   corner, ray-buffer mean 0.092 -> 0.131 depending on preset, max 1.0.
 *
 * SHAFT COUNT, on the (rays - postfx-<phase>-no-rays) difference, walking circular
 * arcs around the projected sun and counting local maxima by prominence against
 * their neighbouring troughs (.tmp-postfx/diff.mjs). Peaks at >= 2.5/255:
 *              R=0.25H  0.40H  0.60H  0.80H  1.10H   peak add   deepest gap
 *   dusk/canopy    4      6     10      6      5      +88/255     -30/255
 *   dusk/hero      1      3      1      5      4      +82/255      -3/255
 *   The canopy preset is the one to look at: shots/pfx-g-dusk/canopy.png has a fan
 *   of 5-6 soft warm shafts radiating from the off-frame sun at sunUV (0.913,-0.10)
 *   = screen (1753, 1189), sweeping up-left across the branches, with visibly dark
 *   gaps between them. shots/pfx-g-dusk/hero.png has one broad beam over the canopy
 *   plus a fainter second — that composition has the sun 35 degrees off the subject
 *   with clear sky between, so there is little for shafts to be shafts between.
 *   Raw buffer in isolation: --scenario postfx-<phase>-rays-buffer (quarter-res
 *   march straight to screen) and postfx-<phase>-rays-solo (what ATMOS adds, over
 *   black). postfx-<phase>-flat / -no-grain / -no-dof-no-grain / -no-smaa-no-grain
 *   are registered for every phase now, so any stats.mjs gate can be attributed.
 *
 * DAY SUPPRESSION. At full strength the day frame printed three hard white
 * near-vertical streaks over the blue sky (x 1150-1250 / 1450-1620 / 1780-1850) —
 * the sun sits 1.8 frame heights above the lens at noon, so the shafts are vertical
 * and tinted to a near-white key. rays.dayScale 0.34 implements ART_BIBLE 4.3's
 * "strong at dawn/dusk" as a phase factor of (0.34 + 0.66 * lowSun).
 *
 * MILKY MID-GROUND BAND, this pass's share (delta vs no-rays, dusk/hero):
 *                       upper-left sky   aerial-haze band   hills
 *   shipped r3              +6.02             +6.33         +2.35
 *   after the high pass     +0.50             +7.32         +2.49
 *   The sky wash is gone (12x lower); what is left in the haze band is a SHAFT
 *   crossing it, not a wash — the band's own Sobel goes UP 4.1% with the rays on
 *   and the hills' 1.9%, so nothing is losing definition. Bloom's contribution to
 *   the same band is +1.45/255 and DOF's is -0.3%.
 *
 * BLOOM — normalisation confirmed, not divided by mip count. probe() reports
 *   bloomWeightSum 11.414 (= SUM 1.16^i over 7 mips) and bloomStrength 0.0482 =
 *   0.55 / 11.414, which is the correct divisor for a progressive tent upsample
 *   where mip 0 ends up holding SUM(falloff^i * blur_i). strength 0.55, threshold
 *   0.85, radius 0.75 are ART_BIBLE 4.4's numbers verbatim. Measured veil (display
 *   luminance added vs postfx-no-bloom, 255 units): canopy +4.7, sky +3.0, haze
 *   band +1.5, hills +1.0, ground +0.5 — a wide low-amplitude wash, hazy, with no
 *   flat plateau anywhere (blown = 0 on every frame shot this round).
 *
 * DEPTH OF FIELD (no grain, mean Sobel per box vs postfx-no-dof-no-grain; the
 *   run-to-run noise floor on these boxes, measured by shooting the SAME scenario
 *   twice, is +/-3.1% on the trunk and +/-2.0% on the hills):
 *                     far hills  hills mid  canopy   trunk   trunkEdge  fg grass
 *     as inherited      -43.3%    -40.7%    -21.2%   -8.7%    -9.7%     -17.1%
 *     shipped           -43.3%    -39.7%    -16.2%   -5.8%    -6.4%      -7.1%
 *   The far band is deliberately untouched: ART_BIBLE 4.5 wants the distant hills
 *   softly out and they lose 43% of their edge energy. What changed is what the
 *   pass does to the PLANE IT IS FOCUSED ON: DOF_COMPOSITE now keeps the full-res
 *   pixel until the CoC is wider than 1.3 px (was 0.7) because the gather is half
 *   res and any non-zero blend costs the subject its top octave, and the gather's
 *   foreground DILATION now ramps over 1.8-6.5 px of near CoC instead of switching
 *   on at 0.75 px, so a petal with a sub-pixel CoC no longer forces the canopy
 *   behind it to half res. Trunk is now inside 2 sigma of the no-DOF render.
 *   Autofocus, hero: 27.4 m (probe at 1600x900), tree at 25-26 m, in-focus plateau
 *   0.80-1.40 x focus = 21.9-38.4 m.
 *
 * SMAA (no grain, edge energy with postfx-no-smaa-no-grain): removing it adds
 *   trunk +5.1%, grass +5.6%, canopy +5.2%, trunkEdge +4.6%, far hills +1.4%,
 *   flat sky +0.0%. It is resolving aliasing on silhouettes and doing nothing to
 *   areas with no edges, which is the signature of a correct AA pass.
 *
 * DOES THE GRADE PRESERVE THE RIG'S COOL-SHADOW / WARM-HIGHLIGHT SPLIT?
 *   (stats.mjs, hero, day; postfx-flat bypasses the entire grade)
 *                    p1      p50     p99    satMean  detail  groundSplitTone
 *     grade off    0.2897  0.6133  0.8168   0.192    0.143    -21.6 deg
 *     shipped      0.1419  0.6002  0.9054   0.337    0.236   -144.6 deg
 *   shadowHue 109.5 -> 227.8 (green -> blue-violet, i.e. onto the #6E76A8 axis)
 *   while highlightHue stays warm at 83-88. The grade CREATES the split 6.7x over,
 *   it does not neutralise it. Black point: p1 drops 1.03 stops with crushed = 0.00
 *   and blown = 0.00, so the low end is opened, not crushed.
 *
 * NIGHT. shipped p1 0.080 / p50 0.141 / p99 0.514, crushed 0, blown 0,
 *   satMean 0.589, flatBlocks 0.3005 (stats.mjs gate is 0.28). That gate failure is
 *   NOT the grade's: with the whole grade bypassed (postfx-night-flat) the same
 *   frame reads flatBlocks 0.3146 and detail 0.104 against the shipped 0.3005 and
 *   0.118, i.e. the tone curve slightly IMPROVES both. The flat blocks are the
 *   scene's own night sky (15-sky / 08-lighting).
 * ====================================================================== */
