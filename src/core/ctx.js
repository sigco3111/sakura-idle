/**
 * Shared runtime context. Owned by the scaffold — read freely, do not restructure.
 * Every module receives this object in setup(ctx).
 */

class Bus {
  constructor() { this.m = new Map(); }
  on(k, fn) { (this.m.get(k) ?? this.m.set(k, new Set()).get(k)).add(fn); return () => this.off(k, fn); }
  off(k, fn) { this.m.get(k)?.delete(fn); }
  emit(k, payload) {
    const s = this.m.get(k); if (!s) return;
    for (const fn of s) { try { fn(payload); } catch (e) { console.error(`[bus:${k}]`, e); } }
  }
}

export const QUALITY_TIERS = {
  ultra: { petals: 9000, shadowMap: 4096, ssao: true, taa: 4, dof: true, godrays: true, pixelRatioCap: 2.0, waterReflect: true, grass: 260000 },
  high:  { petals: 5000, shadowMap: 2048, ssao: true, taa: 2, dof: true, godrays: true, pixelRatioCap: 1.75, waterReflect: true, grass: 140000 },
  medium:{ petals: 2400, shadowMap: 1024, ssao: false, taa: 0, dof: true, godrays: false, pixelRatioCap: 1.25, waterReflect: false, grass: 60000 },
  low:   { petals: 900,  shadowMap: 512,  ssao: false, taa: 0, dof: false, godrays: false, pixelRatioCap: 1.0, waterReflect: false, grass: 18000 },
};

export function createCtx() {
  const params = new URLSearchParams(location.search);
  const shotMode = params.has('shot');
  const tier = params.get('q') || (shotMode ? 'ultra' : 'high');

  return {
    /** @type {import('three').WebGLRenderer|null} set by 00-renderer */
    renderer: null,
    /** @type {import('three').Scene|null} */
    scene: null,
    /** @type {import('three').PerspectiveCamera|null} */
    camera: null,
    /** Set by the post-processing module: { render(dt) } — if present main.js uses it instead of renderer.render */
    pipeline: null,
    /** Modules may publish reusable assets here, keyed by owner. e.g. ctx.assets.textures.bark */
    assets: { textures: {}, materials: {}, geometries: {}, envMap: null },
    /** Simulation time in seconds (deterministic in shot mode). */
    time: 0,
    frame: 0,
    /** Wall-clock-independent quality settings. */
    quality: { tier, ...QUALITY_TIERS[tier] ?? QUALITY_TIERS.high },
    shotMode,
    /** Viewport in CSS pixels. */
    size: { w: window.innerWidth, h: window.innerHeight, dpr: 1 },
    bus: new Bus(),
    /** Populated by main.js: name -> module instance */
    modules: new Map(),
    /** Convenience: set by 00-renderer for raycasting against clickables. */
    pointer: { x: 0, y: 0, ndc: { x: 0, y: 0 }, down: false },
    /** Modules push meshes here to receive click events via bus 'world:click'. */
    clickTargets: [],
  };
}
