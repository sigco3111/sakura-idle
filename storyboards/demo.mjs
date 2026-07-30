/**
 * storyboards/demo.mjs — the 28-second launch trailer for Twitter/X.
 *
 *   node tools/capture.mjs --storyboard storyboards/demo.mjs \
 *        --out .tmp-orch/video/demo --w 1920 --h 1080 --fps 30
 *
 * Five shots, cut on the slow sparse score — wide, up, down, game, night:
 *
 *   1  0.00 –  4.30   day hero: arcs round to frontal while pushing in
 *   2  4.30 –  8.90   low, looking up past the trunk into the sun — god rays
 *                     fanning through the crown, backlit petals
 *   3  8.90 – 12.80   down on the water — sky, reeds and blossom in the mirror
 *   4 12.80 – 22.20   HUD on, one 9.4 s take: shakes, a purchase, a Petal Storm,
 *                     then the 輝咲 RADIANT bloom-stage set piece
 *   5 22.20 – 28.00   HUD off: day runs to night, hold on the moonlit grove
 *
 * Camera notes
 * - The camera rig is switched off (`cameraRig.setEnabled(false)`) and every
 *   shot is written as an eased interpolation between two keyframes, so the
 *   motion is a deliberate dolly rather than the game's idle drift. Easing is
 *   cubic in/out: each move starts and ends at zero velocity, which is why the
 *   hard cuts never read as a snap. A tiny low-frequency wobble (≤ 4 cm, ~11 s
 *   period) is layered on top so no shot is mechanically dead.
 * - The time-of-day rig is paused and `dayT` is driven from `t` instead, so the
 *   day → dusk → night run in shot 5 is a timed 3.4 s ramp rather than the
 *   game's own multi-minute cycle.
 * - Shot 2 aims within a couple of degrees of `uSunDir` at its own `dayT`, with
 *   the crown between camera and sun. That is what makes the volumetric shafts
 *   fan out instead of reading as a faint wash; measured sun directions are
 *   (-0.23, 0.66, -0.71) at dayT 0.60 and (-0.18, 0.65, -0.74) at 0.64.
 *
 * Shot-mode quirks this file works around (none of them fake anything — each
 * one restores what the live game already does):
 * - `capture.mjs` only warms 240 frames, which leaves the fallen-petal carpet
 *   and the settled water empty, so `setup()` warms 600 more.
 * - 65-ui.js only retires the bloom-stage card when `!ctx.shotMode`, so it would
 *   otherwise sit on screen for the rest of the video. We remove it after the
 *   ~4 s the live game gives it.
 * - 45-vfx.js disables its DOM layer (the floating gain numbers) in shot mode,
 *   and every scenario that force-enables it also freezes the numbers at a fixed
 *   age. So the gain feedback in shot 4 is the real one that survives shot mode:
 *   the 3D shockwave rings, the petal burst, and the HUD bank counter ticking up.
 *
 * Shipping the file (docs/videos/demo.mp4, 13.8 MB). capture.mjs encodes CRF,
 * which lands at 135 MB for this content — most of the bitrate goes on petals,
 * grass and film grain. Render the frames once with --keep-frames, then two-pass
 * ABR them so the cheap shots keep their detail and only the Petal Storm gets
 * squeezed. Measured: CRF 31 = 21.0 MB, two-pass 4000k = 13.8 MB and visually
 * indistinguishable outside the storm. The audio comes out at -17.5 LUFS, so
 * +2.5 dB puts it at -14.9 LUFS / -0.9 dBTP, which is where social wants it.
 *
 *   node tools/capture.mjs --storyboard storyboards/demo.mjs \\
 *        --out .tmp-orch/video/f2 --w 1920 --h 1080 --fps 30 --keep-frames
 *   ffmpeg -y -framerate 30 -i .tmp-orch/video/f2-frames/%05d.png \\
 *     -c:v libx264 -preset veryslow -b:v 4000k -pass 1 \\
 *     -passlogfile .tmp-orch/video/x264-2p -pix_fmt yuv420p -an -f null /dev/null
 *   ffmpeg -y -framerate 30 -i .tmp-orch/video/f2-frames/%05d.png \\
 *     -i .tmp-orch/video/f2.wav \\
 *     -filter_complex "[1:a]volume=2.5dB,afade=t=out:st=26.9:d=1.1[a]" \\
 *     -map 0:v -map "[a]" -c:v libx264 -preset veryslow -b:v 4000k -pass 2 \\
 *     -passlogfile .tmp-orch/video/x264-2p -pix_fmt yuv420p -movflags +faststart \\
 *     -r 30 -c:a aac -b:a 128k -shortest docs/videos/demo.mp4
 *
 * Compositions deliberately avoided, each ruled out by rendering it:
 * - Anything closer than ~8 m under the canopy: the near blossom cards fall
 *   inside the DOF near field and the whole frame goes to mush.
 * - A tight trunk shot: at 7 m the bark sits in front of the focal plane.
 * - Holding on the tree's east side, where a few major limbs carry no blossom
 *   and read as dead wood. Shot 1 arcs those limbs behind the crown.
 */

export const duration = 28.0;
export const fps = 30;
export const audio = { phase: 'dusk', stage: 4, volume: 0.9 };
export const ui = true;          // toggled per shot from inside frame()
export const quality = 'ultra';

export const pageScript = `
/* ------------------------------------------------------------------ *
 * shot table — [t0, t1, posA, tgtA, fovA, posB, tgtB, fovB, dayA, dayB, ui]
 * ------------------------------------------------------------------ */
const SHOTS = [
  // Arcs 14 degrees from the 3/4 view round to frontal while pushing in. The
  // frontal axis is deliberate: the tree's bare east limbs read as dead wood
  // from the 3/4 side, and swing behind the crown as the camera comes round.
  { t0: 0.00,  t1: 4.30,  ui: false,
    posA: [ 9.20, 5.60, 24.20], tgtA: [-0.40, 7.50, -1.00], fovA: 32.0, dayA: 0.500,
    posB: [ 2.20, 4.90, 21.80], tgtB: [-0.40, 7.10, -1.00], fovB: 34.0, dayB: 0.520 },

  // Low on the south side, looking up past the trunk into the sun. The crown
  // occludes the disc, so the volumetric shafts fan through the blossom and the
  // petal cards go translucent-pink from behind — the one image the whole look
  // was built for. Trucks left and rises 0.6 m so the shafts sweep the canopy.
  // Stays at 9-11 m: any closer and the near cards enter the DOF near field.
  // camSpan < span on purpose: the dolly finishes at 7.60 and the last 1.3 s
  // hold on the frame where the disc has just broken through the crown. That
  // reveal is the payoff of the move, so it gets time to be looked at.
  { t0: 4.30,  t1: 8.90,  ui: false, camSpan: 3.30,
    posA: [ 3.10, 1.42, 10.60], tgtA: [-0.40, 9.00, -1.00], fovA: 47.0, dayA: 0.600,
    posB: [ 0.20, 2.05,  8.90], tgtB: [-1.40, 10.30, -1.80], fovB: 49.0, dayB: 0.640 },

  // Down onto the water. Reviewers rated the pond the best-looking thing in the
  // build, so it gets a whole shot: sky and cloud in the mirror, reeds, ripple
  // rings, and the canopy's reflection coming in at the right.
  { t0: 8.90,  t1: 12.80, ui: false,
    posA: [-5.00, 1.25, 12.00], tgtA: [-9.00, 0.90,  4.80], fovA: 44.0, dayA: 0.620,
    posB: [-6.90, 1.75, 10.00], tgtB: [-9.50, 0.70,  3.60], fovB: 42.0, dayB: 0.640 },

  // One unbroken 9.4 s gameplay take rather than two short ones: the shakes, the
  // purchase, the Petal Storm and the bloom-stage set piece all escalate inside
  // the same slow push-in, so nothing has to be re-established by a cut. Aimed
  // a little right of the trunk so the tree sits at ~36% of the width and the
  // Tenders panel never crosses it.
  { t0: 12.80, t1: 22.20, ui: true,
    posA: [ 3.00, 5.60, 26.40], tgtA: [ 3.40, 7.80, -1.00], fovA: 32.0, dayA: 0.520,
    posB: [ 1.60, 4.90, 21.40], tgtB: [ 3.40, 7.00, -1.00], fovB: 33.0, dayB: 0.560 },

  { t0: 22.20, t1: 28.00, ui: false, camSpan: 3.90, daySpan: 3.40,
    posA: [12.40, 4.40, 17.40], tgtA: [ 0.60, 5.60, -1.60], fovA: 40.0, dayA: 0.560,
    posB: [16.50, 7.20, 23.50], tgtB: [-0.50, 7.00, -1.00], fovB: 34.0, dayB: 0.955 },
];

/* ------------------------------- beats ---------------------------- */
const BEATS = [
  [13.15, (g, G) => G.shake(null)],
  [13.85, (g, G) => G.shake(null)],
  [14.55, (g, G) => G.shake(null)],
  [15.30, (g) => g.scenarios['game-storm'] && g.scenarios['game-storm']()],
  [16.30, (g, G) => G.buy('rabbit', 2)],
  [16.95, (g, G) => G.shake(null)],
  [17.65, (g, G) => G.shake(null)],
  // Cross the 輝咲 Radiant threshold for real rather than calling the
  // 'game-stageup' debug scenario. That scenario assigns state.stage by hand,
  // and 60-game's applyStage() then recomputes the stage from totalThisSeason
  // and puts it straight back — so the set-piece card announced BLOOM STAGE V
  // over a HUD that still read 満開 FULL BLOOM IV / VI. Pushing the season
  // total past the threshold makes the game itself run applyStage(): same card,
  // same +Blossoms, same petal shockwave, but now the HUD stage row, the
  // progress bar and the card all agree.
  [18.40, (g, G) => { if (G && G.state) G.state.totalThisSeason = Math.max(G.state.totalThisSeason, 1.02e10); }],
  // 65-ui.js holds the bloom-stage card and only retires it when not in shot
  // mode. Retire it on roughly the same clock the player would see, and before
  // the cut rather than after it.
  [22.10, () => { const c = document.querySelector('#ui-root .sk-stageup'); if (c) c.remove(); }],
];

/* ------------------------------- easing --------------------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// cubic in/out — zero velocity at both ends, so a cut never lands mid-whip
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const mix = (a, b, e) => a + (b - a) * e;

let fired = null;
let uiState = null;
let card = null;

function endCard() {
  const el = document.createElement('div');
  el.id = 'demo-endcard';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:60', 'pointer-events:none', 'opacity:0',
    'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:flex-end',
    'padding-bottom:9.4vh', 'text-align:center',
    "font-family:'Hiragino Mincho ProN','Yu Mincho','Songti SC',Georgia,serif",
  ].join(';');
  el.innerHTML = [
    '<div style="position:absolute;inset:0;background:linear-gradient(to top,',
    'rgba(9,12,26,.74) 0%,rgba(9,12,26,.40) 20%,rgba(9,12,26,0) 46%)"></div>',
    '<div style="position:relative">',
    '<div style="font-size:2.35vw;letter-spacing:.54em;text-indent:.54em;color:#F6EEDF;',
    'text-shadow:0 2px 20px rgba(8,10,24,.92)">SAKURA</div>',
    '<div style="font-size:.95vw;letter-spacing:.31em;text-indent:.31em;color:#E8C56A;',
    'margin-top:1.0vh;text-shadow:0 1px 12px rgba(8,10,24,.92)">PETALS OF THE EVERBLOSSOM</div>',
    '<div style="display:flex;align-items:center;justify-content:center;gap:.7vw;margin:1.9vh 0 1.6vh">',
    '<span style="display:block;width:5.4vw;height:1px;background:linear-gradient(to right,rgba(232,197,106,0),#E8C56A)"></span>',
    '<span style="display:block;width:.44vw;height:.44vw;background:#E8C56A;transform:rotate(45deg)"></span>',
    '<span style="display:block;width:5.4vw;height:1px;background:linear-gradient(to left,rgba(232,197,106,0),#E8C56A)"></span>',
    '</div>',
    '<div style="font-size:1.22vw;letter-spacing:.17em;text-indent:.17em;color:#FFF3F7;',
    'text-shadow:0 1px 14px rgba(8,10,24,.95)">sakura-idle.vercel.app</div>',
    '</div>',
  ].join('');
  document.body.appendChild(el);
  return el;
}

window.__STORY = {
  setup(g, ctx) {
    fired = {};
    uiState = null;
    // Own the camera outright: the rig's idle drift and pointer parallax would
    // fight a keyframed dolly.
    if (ctx.assets.cameraRig && ctx.assets.cameraRig.setEnabled) ctx.assets.cameraRig.setEnabled(false);
    // Own the clock too: dayT is driven from t so shot 5 can run day -> night.
    if (ctx.assets.lighting && ctx.assets.lighting.pause) ctx.assets.lighting.pause(true);
    if (ctx.assets.lighting && ctx.assets.lighting.setDayT) ctx.assets.lighting.setDayT(0.50);
    // Mid-game save: 満開 Full Bloom, seven kinds of Tender, every panel populated.
    if (g.scenarios.rich) g.scenarios.rich();
    g.setUI(false);
    card = endCard();
    // Let the petal carpet, the grass and the water settle before frame 0 —
    // capture only warms 4 s on its own, which leaves the ground bare.
    g.warm(600);
  },

  frame(t, g, ctx) {
    const G = ctx.assets.game;

    /* ---- beats (idempotent: each fires exactly once) ---- */
    for (let i = 0; i < BEATS.length; i++) {
      const b = BEATS[i];
      if (t >= b[0] && !fired[i]) {
        fired[i] = 1;
        try { b[1](g, G, ctx); } catch (e) { /* never let a beat kill the render */ }
      }
    }

    /* ---- which shot are we in ---- */
    let s = SHOTS[0];
    for (let i = 0; i < SHOTS.length; i++) if (t >= SHOTS[i].t0) s = SHOTS[i];

    if (uiState !== s.ui) { uiState = s.ui; g.setUI(s.ui); }

    const span = s.t1 - s.t0;
    const uCam = ease(clamp01((t - s.t0) / (s.camSpan || span)));
    const uDay = ease(clamp01((t - s.t0) / (s.daySpan || span)));

    if (ctx.assets.lighting && ctx.assets.lighting.setDayT) {
      ctx.assets.lighting.setDayT(mix(s.dayA, s.dayB, uDay));
    }

    // A whisper of handheld so no shot is perfectly locked off. Amplitude is
    // 3-4 cm at 12-18 m, i.e. well under a pixel of jitter per frame.
    const wx = Math.sin(t * 0.57 + 1.3) * 0.040;
    const wy = Math.sin(t * 0.41 + 0.4) * 0.028;

    ctx.camera.position.set(
      mix(s.posA[0], s.posB[0], uCam) + wx,
      mix(s.posA[1], s.posB[1], uCam) + wy,
      mix(s.posA[2], s.posB[2], uCam),
    );
    ctx.camera.lookAt(
      mix(s.tgtA[0], s.tgtB[0], uCam),
      mix(s.tgtA[1], s.tgtB[1], uCam),
      mix(s.tgtA[2], s.tgtB[2], uCam),
    );
    ctx.camera.fov = mix(s.fovA, s.fovB, uCam);
    ctx.camera.updateProjectionMatrix();

    /* ---- end card: fades up over the held night frame ---- */
    if (card) {
      const a = clamp01((t - 25.50) / 1.10);
      card.style.opacity = String(a * a * (3 - 2 * a));
    }
  },
};
`;
