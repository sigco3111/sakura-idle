/**
 * Canonical camera presets. The screenshot harness references these by name,
 * and the visual-critic agents compare renders across identical presets.
 * Owned by the scaffold — add presets, never renumber or remove existing ones.
 *
 * World convention: tree trunk base sits at origin (0,0,0), +Y up, tree ~14 units tall.
 * Ground plane is y = 0. Pond centre approx (-9, 0, 6).
 */
export const CAMERA_PRESETS = {
  // The money shot: the composition every critic scores. 3/4 view, whole tree
  // plus ground context, horizon on the lower third.
  hero:      { pos: [14.0, 6.5, 21.0], target: [0.0, 7.5, 0.0], fov: 36 },
  // Low, upward — canopy against sky, tests petal density + rim light + god rays.
  canopy:    { pos: [4.5, 1.2, 6.5],  target: [-0.5, 11.0, -1.0], fov: 52 },
  // Trunk close-up — bark texture, moss, root blending, contact shadows.
  bark:      { pos: [2.2, 1.9, 3.0],  target: [0.0, 2.4, 0.0], fov: 34 },
  // Wide establishing — silhouette, terrain, props, fog, distant hills.
  wide:      { pos: [30.0, 11.0, 38.0], target: [-2.0, 6.0, 0.0], fov: 28 },
  // Pond — water shading, reflections, floating petals.
  pond:      { pos: [-3.0, 2.2, 14.0], target: [-9.0, 0.4, 6.0], fov: 42 },
  // Petal-storm framing — mid-air particles, DOF bokeh.
  petals:    { pos: [-3.0, 3.6, 7.0],  target: [2.0, 6.0, -1.5], fov: 46 },
  // Night/lantern lighting check.
  lantern:   { pos: [5.0, 1.6, 7.0],  target: [1.4, 1.3, 1.6], fov: 40 },
  // Gameplay framing exactly as the player sees it — tree pushed left so the
  // right third stays clear for the HUD.
  gameplay:  { pos: [15.0, 6.8, 22.0], target: [-2.5, 7.2, 0.0], fov: 34 },
};

export function applyPreset(camera, name) {
  const p = CAMERA_PRESETS[name] ?? CAMERA_PRESETS.hero;
  camera.position.set(...p.pos);
  camera.lookAt(...p.target);
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
  return p;
}
