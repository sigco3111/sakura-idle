import * as THREE from 'three';
import { createNprMaterial } from '../lib/lighting.js';

/**
 * NPR REFERENCE / CALIBRATION SCENE — scaffold-owned. TEMPORARY.
 *
 * This is not art. It exists so the lighting rig can be judged on surfaces that
 * actually go through nprShade(), rather than on default MeshStandardMaterial.
 * Judging NPR lighting on a PBR placeholder is what produced the navy paint-fill
 * shadow bug, so every surface here is a real createNprMaterial().
 *
 * The five spheres on the left are shading calibration balls, exactly like the
 * chrome/grey/white balls a VFX lighter shoots on set:
 *   1. mid grey 0.18   — read the ramp bands and terminator width here
 *   2. mid grey 0.50   — read the shadow luminance ratio here (target ~0.55 of lit)
 *   3. near white      — read specular shape and highlight clipping
 *   4. saturated pink  — read hue behaviour of albedo through the ramp
 *   5. thin/translucent — read wrapped transmission and backlit glow
 *
 * The tree stand-in (cylinder + icosphere) is deliberately crude geometry: it is
 * a light-shaping test, not a model. The tree module (30-tree.js) replaces it and
 * its owner is the ONLY agent permitted to delete this file.
 */
export default {
  name: 'smoke',
  order: 50,
  async setup(ctx) {
    const g = new THREE.Group();
    const L = ctx.assets.lightUniforms ?? null;

    const npr = (o) => createNprMaterial({ lightUniforms: L, ...o });

    // --- ground -------------------------------------------------------
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 96).rotateX(-Math.PI / 2),
      npr({ color: 0x6E8C4A, specScale: 0.25, rimScale: 0.3 }),
    );
    ground.receiveShadow = true;
    g.add(ground);

    // --- tree stand-in ------------------------------------------------
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 1.05, 8.4, 24, 3),
      npr({ color: 0x6A5344, specScale: 0.4 }),
    );
    trunk.position.y = 4.2;
    trunk.castShadow = trunk.receiveShadow = true;

    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(5.4, 4),
      npr({ color: 0xFFB6CE, translucency: 0.85, thickness: 0.55, rimScale: 1.4, specScale: 0.5 }),
    );
    canopy.position.y = 10.2;
    canopy.castShadow = canopy.receiveShadow = true;
    g.add(trunk, canopy);

    // --- calibration balls --------------------------------------------
    const balls = [
      { color: 0x2E2E2E, o: {} },                                             // 0.18 grey
      { color: 0x7F7F7F, o: {} },                                             // 0.50 grey
      { color: 0xF2F2F2, o: { specScale: 1.4 } },                             // near white
      { color: 0xEE4C86, o: {} },                                             // saturated
      { color: 0xFFD9E6, o: { translucency: 1.0, thickness: 0.18, rimScale: 1.6 } },
    ];
    const ballGeo = new THREE.SphereGeometry(0.95, 48, 32);
    balls.forEach((b, i) => {
      const m = new THREE.Mesh(ballGeo, npr({ color: b.color, ...b.o }));
      m.position.set(-9.5 + i * 2.4, 0.95, 9.5);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    });

    // A shadow-catcher slab beside the balls: makes contact shadows, shadow
    // colour and AO immediately legible instead of guessing off curved ground.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(13.5, 0.35, 3.2),
      npr({ color: 0xBFB8AA, specScale: 0.3 }),
    );
    slab.position.set(-4.7, 0.17, 9.5);
    slab.receiveShadow = slab.castShadow = true;
    g.add(slab);

    return {
      object3D: g,
      update(dt, t) { canopy.rotation.y = t * 0.03; },
      dispose() {
        g.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      },
    };
  },
};
