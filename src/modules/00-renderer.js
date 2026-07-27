import * as THREE from 'three';
import { applyPreset } from '../core/cameras.js';

/**
 * Renderer / scene / camera / input.  order 0 — always first.
 * Owner: engine agent.
 */
export default {
  name: 'renderer',
  order: 0,
  async setup(ctx) {
    const renderer = new THREE.WebGLRenderer({
      antialias: false,            // handled by the post pipeline (SMAA/TAA)
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: ctx.shotMode,
    });
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ctx.quality.pixelRatioCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = true;
    document.getElementById('app').appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 900);
    applyPreset(camera, 'hero');

    ctx.renderer = renderer;
    ctx.scene = scene;
    ctx.camera = camera;

    // ---- pointer + raycast -----------------------------------------
    const ray = new THREE.Raycaster();
    const el = renderer.domElement;
    const setPointer = (e) => {
      const r = el.getBoundingClientRect();
      ctx.pointer.x = e.clientX - r.left;
      ctx.pointer.y = e.clientY - r.top;
      ctx.pointer.ndc.x = (ctx.pointer.x / r.width) * 2 - 1;
      ctx.pointer.ndc.y = -(ctx.pointer.y / r.height) * 2 + 1;
    };
    el.addEventListener('pointermove', setPointer);
    el.addEventListener('pointerdown', (e) => { setPointer(e); ctx.pointer.down = true; });
    el.addEventListener('pointerup', (e) => {
      setPointer(e); ctx.pointer.down = false;
      ray.setFromCamera(ctx.pointer.ndc, camera);
      const hits = ctx.clickTargets.length ? ray.intersectObjects(ctx.clickTargets, true) : [];
      ctx.bus.emit('world:click', {
        hit: hits[0] ?? null,
        point: hits[0]?.point ?? null,
        screen: { x: ctx.pointer.x, y: ctx.pointer.y },
        ndc: { ...ctx.pointer.ndc },
      });
    });

    // Expose a synthetic click so the harness/tests can trigger gameplay.
    window.__game && (window.__game.click = null); // set below once __game exists
    ctx.bus.on('__noop', () => {});
    queueMicrotask(() => {
      if (!window.__game) return;
      window.__game.clickWorld = (nx = 0, ny = 0.2) => {
        const ndc = { x: nx, y: ny };
        ray.setFromCamera(ndc, camera);
        const hits = ctx.clickTargets.length ? ray.intersectObjects(ctx.clickTargets, true) : [];
        ctx.bus.emit('world:click', {
          hit: hits[0] ?? null, point: hits[0]?.point ?? null,
          screen: { x: (nx * 0.5 + 0.5) * ctx.size.w, y: (-ny * 0.5 + 0.5) * ctx.size.h }, ndc,
        });
      };
    });

    return {
      update() { /* camera rig module (10-camera.js) drives motion */ },
      dispose() { renderer.dispose(); el.remove(); },
    };
  },
};
