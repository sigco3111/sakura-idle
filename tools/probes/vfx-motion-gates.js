/**
 * Behaviour probe for the 45-vfx accessibility gates.
 *
 * With reduced motion on: no full-screen wash, no time dilation on stage-up, and a
 * calm cue (the soft vignette) in its place. With it back on: dilation and wash
 * return in the same session, no reload.
 */
const game = window.__game;
const ctx = window.__ctx;
const sc = game.scenarios;
const vfx = ctx.assets.vfx;

const layer = () => document.getElementById('vfx-layer');
const opacityOf = (i) => {
  const el = layer()?.children?.[i];
  return el ? +(el.style.opacity || 0) : null;
};
const flashOpacity = () => opacityOf(0);
const vigOpacity = () => opacityOf(1);

function fireAll() {
  const p = { x: 1.0, y: 7.6, z: 2.0 };
  vfx.shake(p, 1.8);
  vfx.crit(p, 1234567);
  vfx.stageUp(4);
  game.warm(2);
}

// force the DOM layer to exist under the shot harness
sc['vfx-flash']();
game.warm(1);

sc['vfx-motion-on']();
fireAll();
const on = {
  motion: vfx.motion,
  timeScale: +vfx.timeScale.toFixed(4),
  flashOpacity: flashOpacity(),
  vignetteOpacity: vigOpacity(),
};

sc['vfx-motion-off']();
game.warm(1);
const rightAfterToggle = {
  timeScale: +vfx.timeScale.toFixed(4),      // the lurch must be cancelled at once
  flashOpacity: flashOpacity(),              // an in-flight wash must be cleared
};
fireAll();
const off = {
  motion: vfx.motion,
  timeScale: +vfx.timeScale.toFixed(4),
  flashOpacity: flashOpacity(),
  vignetteOpacity: vigOpacity(),
};

sc['vfx-motion-on']();
fireAll();
const backOn = {
  motion: vfx.motion,
  timeScale: +vfx.timeScale.toFixed(4),
  flashOpacity: flashOpacity(),
};

// bursts are independent of the motion flags and default ON
sc['vfx-motion-off']();
const burstsWithReducedMotion = vfx.motion.bursts;

return {
  on, rightAfterToggle, off, backOn, burstsWithReducedMotion,
  pass: {
    noWashWhenOff: off.flashOpacity === 0,
    noDilationWhenOff: off.timeScale === 1,
    washClearedOnToggle: rightAfterToggle.flashOpacity === 0,
    dilationClearedOnToggle: rightAfterToggle.timeScale === 1,
    calmCuePresentWhenOff: off.vignetteOpacity > 0,
    washReturnsWhenBackOn: backOn.flashOpacity > 0,
    dilationReturnsWhenBackOn: backOn.timeScale < 1,
    burstsSurviveReducedMotion: burstsWithReducedMotion === true,
  },
  moduleErrors: game.errors,
};
