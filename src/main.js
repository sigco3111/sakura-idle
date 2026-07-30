import * as THREE from 'three';
import { createCtx } from './core/ctx.js';
import { applyPreset } from './core/cameras.js';
import { inject } from '@vercel/analytics';

/* ------------------------------------------------------------------ *
 * Module auto-registry.
 * Every file in src/modules/*.js is picked up automatically and must
 * default-export a module descriptor. See CONTRACT.md.
 * ------------------------------------------------------------------ */
const found = import.meta.glob('./modules/*.js', { eager: true });

const ctx = createCtx();
window.__ctx = ctx;
const errors = [];
window.__errors = errors;

// Initialize Vercel Web Analytics
inject();

const descriptors = Object.entries(found)
  .map(([path, mod]) => {
    const d = mod?.default;
    if (!d || typeof d.setup !== 'function') {
      errors.push({ where: path, message: 'module has no default export with setup()' });
      return null;
    }
    return { ...d, __path: path, name: d.name ?? path, order: d.order ?? 500 };
  })
  .filter(Boolean)
  .sort((a, b) => a.order - b.order);

const instances = [];

async function boot() {
  for (const d of descriptors) {
    try {
      const inst = (await d.setup(ctx)) ?? {};
      inst.__name = d.name;
      if (inst.object3D && ctx.scene) ctx.scene.add(inst.object3D);
      ctx.modules.set(d.name, inst);
      instances.push(inst);
    } catch (e) {
      errors.push({ where: d.name, message: String(e?.stack ?? e) });
      console.error(`[module:${d.name}] setup failed`, e);
    }
  }

  if (!ctx.renderer || !ctx.scene || !ctx.camera) {
    errors.push({ where: 'main', message: 'no renderer/scene/camera after boot — is 00-renderer.js present?' });
    document.getElementById('boot').textContent = 'renderer module missing';
    window.__READY = 'error';
    return;
  }

  window.addEventListener('resize', onResize);
  onResize();

  // Give textures/shaders one compile pass before we declare ready, so the
  // first screenshot is never a half-compiled frame.
  step(0);
  try { ctx.renderer.compile(ctx.scene, ctx.camera); } catch { /* non-fatal */ }

  const bootEl = document.getElementById('boot');
  if (ctx.shotMode) bootEl?.remove();          // no fade — screenshots must never catch the overlay
  else bootEl?.classList.add('hide');
  window.__READY = true;
  ctx.bus.emit('game:ready');

  if (!ctx.shotMode) requestAnimationFrame(loop);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, ctx.quality.pixelRatioCap);
  ctx.size = { w, h, dpr };
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.setPixelRatio(dpr);
  ctx.renderer.setSize(w, h, false);
  for (const i of instances) { try { i.resize?.(w, h, dpr); } catch (e) { console.error(e); } }
  ctx.bus.emit('resize', ctx.size);
}

function step(dt) {
  ctx.time += dt;
  ctx.frame++;
  for (const i of instances) {
    try { i.update?.(dt, ctx.time); }
    catch (e) {
      if (!i.__errored) { i.__errored = true; errors.push({ where: i.__name, message: 'update(): ' + String(e?.stack ?? e) }); console.error(`[module:${i.__name}] update`, e); }
    }
  }
  if (ctx.pipeline?.render) ctx.pipeline.render(dt);
  else ctx.renderer.render(ctx.scene, ctx.camera);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  step(dt);
  requestAnimationFrame(loop);
}

/* --------------- screenshot / automation surface ------------------ */
window.__game = {
  ctx,
  THREE,
  errors,
  /** Advance the sim deterministically: n fixed steps of dt seconds. */
  warm(n = 90, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); },
  /** Render one more frame without advancing physics. */
  redraw() { step(0); },
  /** Blocking GPU sync — required for any honest frame-time measurement. */
  syncGPU() { const gl = ctx.renderer.getContext(); gl.finish(); },
  setCamera(preset) { applyPreset(ctx.camera, preset); ctx.bus.emit('camera:preset', preset); },
  /** Toggle DOM UI for clean 3D-only comparison shots. */
  setUI(on) { const r = document.getElementById('ui-root'); if (r) r.style.display = on ? '' : 'none'; },
  /** Modules can register named debug states (e.g. 'night', 'bloom-stage'). */
  scenarios: {},
  info() {
    return {
      modules: [...ctx.modules.keys()],
      errors,
      drawCalls: ctx.renderer?.info.render.calls,
      triangles: ctx.renderer?.info.render.triangles,
      programs: ctx.renderer?.info.programs?.length,
      textures: ctx.renderer?.info.memory.textures,
      geometries: ctx.renderer?.info.memory.geometries,
    };
  },
};

boot();
