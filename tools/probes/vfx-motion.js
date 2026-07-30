/**
 * Accessibility probe for 45-vfx: does a shake move the camera when the player
 * has turned screen shake off?
 *
 * Method: kill idle drift and parallax (`camera-static`) so the only thing that can
 * displace the camera is an impulse, allow impulses to apply in shot mode
 * (`__vfxLiveCam`, which 10-camera.js requires), record ctx.camera.position over
 * ~30 frames while firing vfx.shake() every 5th frame, and report the peak
 * displacement from the resting position. Run once with screenShake on and once
 * with it off.
 */
const game = window.__game;
const ctx = window.__ctx;
const sc = game.scenarios;

function measure(label, fire = true) {
  sc['camera-static']();                 // driftScale = 0, parallax off, springs cleared
  window.__vfxLiveCam = true;            // let kicks apply under the shot harness
  game.warm(4);
  const rest = ctx.camera.position.clone();
  const restQ = ctx.camera.quaternion.clone();
  const pt = { x: 1.0, y: 7.6, z: 2.0 };
  let peakPos = 0, peakAng = 0;
  const samples = [];
  for (let f = 0; f < 30; f++) {
    if (fire && f % 5 === 0) ctx.assets.vfx.shake(pt, 1.8);
    game.warm(1);
    const d = ctx.camera.position.distanceTo(rest);
    const a = 2 * Math.acos(Math.min(1, Math.abs(ctx.camera.quaternion.dot(restQ)))) * 180 / Math.PI;
    if (d > peakPos) peakPos = d;
    if (a > peakAng) peakAng = a;
    samples.push(+d.toFixed(6));
  }
  return {
    label,
    motion: ctx.assets.vfx.motion,
    peakPositionM: +peakPos.toFixed(6),
    peakRotationDeg: +peakAng.toFixed(4),
    samples,
  };
}

sc['vfx-motion-on']();
const on = measure('screenShake ON');
sc['vfx-motion-off']();
// control arm: identical 30 frames, no shakes fired at all. Anything this arm
// measures is the rig's own residual, not this module's effects.
const control = measure('screenShake OFF, no shakes fired (control)', false);
const off = measure('screenShake OFF');
// and back on again — a toggle must be reversible in the same session
sc['vfx-motion-on']();
const again = measure('screenShake ON again');

return {
  on, control, off, again,
  // what the brief asks for: the displacement attributable to 45-vfx with the
  // setting off, i.e. everything above the no-shakes-fired control arm
  vfxAttributableOffM: +Math.max(0, off.peakPositionM - control.peakPositionM).toFixed(6),
  vfxAttributableOffDeg: +Math.max(0, off.peakRotationDeg - control.peakRotationDeg).toFixed(4),
};
