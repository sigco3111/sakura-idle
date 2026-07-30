/**
 * storyboards/demo2.mjs — the 35.5-second demo, second cut.
 *
 *   node tools/capture.mjs --storyboard storyboards/demo2.mjs \
 *        --out .tmp-orch/video/demo2 --w 1920 --h 1080 --fps 30 --master --keep-frames
 *
 * v1 (storyboards/demo.mjs, 28 s) shipped and was reviewed. Five things came
 * back; this file is the answer to each of them, and the reasoning is written
 * down here so the next cut does not have to rediscover it.
 *
 * ── What v1 got wrong, and what this file does instead ──────────────────────
 *
 * 1. AUDIO WAS HARSH. Three compounding causes, none of them "the codec":
 *      a) v1 declared `audio = { phase: 'dusk', stage: 4 }`. The dusk bed is the
 *         bright one — more bell/pluck transient energy than the day bed.
 *      b) it passed `volume: 0.9`, and the game's own master default is 0.5.
 *      c) the manual mux then added `volume=2.5dB` on top, and encoded aac 128k.
 *    Net: roughly +7.5 dB hotter than any player hears, in the brightest mix, at
 *    the bitrate where sparse plucks and bell transients smear first. Here the
 *    declaration is `{ phase: 'day', stage: 4 }` with NO volume override (so
 *    renderGraphOffline uses its 0.5 default = the game's own master level) and
 *    `--master` encodes aac 320k. capture.mjs no longer applies gain at all.
 *    NEVER add a `volume` above the default and NEVER re-gain in ffmpeg: if the
 *    result is quiet, leave it quiet and normalise deliberately, once, later.
 *    Measured on the shipped master: -24.1 LUFS integrated, full-band RMS
 *    -24.8 dB, peak -9.1 dBFS, energy above 5 kHz -55.5 dB — i.e. 30.7 dB below
 *    the full band, against v1's 29.5 dB, and 5.7 LU quieter overall (v1 was
 *    -18.4 LUFS). Quiet and soft, which was the whole point: quiet is
 *    recoverable with one normalise pass, harsh is not.
 *    ONE post-mux step, and it is not a gain: the wav runs 0.5 s past the video
 *    and `-shortest` truncates it, which cut the ambient bed off at -19.7 dB RMS
 *    / -9.4 dB peak — an audible stop. The shipped file re-muxes the SAME video
 *    bitstream with `-c:v copy` and re-encodes only the audio from the same wav
 *    with a 1.4 s `afade` tail. No level change, no video re-encode.
 *
 * 2. VIDEO QUALITY WAS BAD. v1 was two-pass ABR'd to 4000k / 13.8 MB for social.
 *    Petals + grass + film grain is exactly the content that falls apart at that
 *    bitrate. This one is a DELIVERY MASTER: `--master` (crf 12, veryslow, high
 *    profile) and `--keep-frames` — 562 MB / 126 Mbps for 35.5 s, to be
 *    compressed by hand afterwards. Do not target a byte size here. Kept on disk
 *    so a re-encode never has to re-render (~13 min: 1065 frames at 0.15 s each,
 *    then a veryslow x264 pass at ~2 fps):
 *      .tmp-orch/video/demo2-frames/%05d.png   1065 PNGs, 4.0 GB
 *      .tmp-orch/video/demo2.wav               36.0 s stereo 44.1k
 *      .tmp-orch/video/demo2.mp4               the un-faded master
 *      .tmp-orch/finish-master.sh              the ship step (audio fade remux)
 *
 * 3. THE GAMEPLAY SHOT SHOWED NO FLOATING NUMBERS. Two reasons, both fixed:
 *      a) 45-vfx.js dropped its DOM layer in shot mode. It now honours
 *         `window.__CAPTURE` (set by capture.mjs) — "shot mode, but render live
 *         UI feedback normally". Verified in this cut's own frames: the +gain
 *         numbers arc from the branch that was clicked, up over the canopy, and
 *         DOWN into the HUD bank counter at top-left.
 *      b) v1 drove the shot with `G.shake(null)`, which credits a click at a
 *         random branch point. This cut uses `g.clickWorld(nx, ny)` — the real
 *         input path: raycast -> `world:click` -> 30-tree emits `tree:clicked`
 *         -> 60-game scores it. So every number leaves the pixel that was
 *         "clicked", which is what makes the arc read as cause and effect.
 *    Click coords must land on the canopy or nothing happens at all. Measured
 *    hit map for the `gameplay` preset at 16:9 (probe: .tmp-orch/probe-clicks2.mjs):
 *    the canopy covers roughly nx -0.30..+0.60, ny -0.05..+0.50, so every click
 *    in CLICKS below is kept inside nx -0.10..+0.45, ny +0.08..+0.36 — comfortably
 *    inside, with margin for the crown's ragged silhouette.
 *
 * 4. THE GAMEPLAY SHOT WAS A CINEMATIC ANGLE, AND TOO SHORT. It is now the
 *    `gameplay` camera preset, re-applied every single frame (`g.setCamera`),
 *    dead still: the exact framing the game is played at, tree left, HUD right.
 *    No dolly, no wobble, no easing — a held shot, 12.2 s (v1: 9.4 s). Two bursts
 *    of rapid tapping at a click every 0.10 s (a plausible fast human ~10/s) put
 *    up to ten numbers in the air at once and reliably land crits.
 *    Crits are made reliable by BUYING THE FORTUNE LINE, not by faking a crit:
 *    `rich` already owns shake_c1/c2 (0.03 base + 0.04 + 0.05, plus the moon1
 *    Constellation node's 0.03 = 0.15). This adds shake_c3 and shake_c4, which
 *    takes it to the 26% the HUD then displays, at x22. Those are real upgrades a
 *    real save can own, so the crits that land are the game's own seeded RNG —
 *    identical on every render. Measured in this cut: 33 taps, 12 crits, first at
 *    t=13.60 s, 3 inside burst 1 and 5 inside burst 2, so both bursts show one.
 *    (An earlier pass also bought shake_c5 + hw_crit1: 0.38 chance made HALF the
 *    numbers gold, which read as a cheat rather than as a crit. 26% is the right
 *    ratio — mostly small pink numbers, punctuated by a big gold one.)
 *    NOTE the derived-stat cache: mutating `G.state.upgrades` does not itself
 *    invalidate it. One `G.shake(null)` during setup does (credit -> invalidate),
 *    which is why setup ends with a throwaway shake before the 600-frame warm.
 *
 * 5. DAY -> DUSK -> NIGHT WAS TOO FAST. v1 ramped dayT 0.560 -> 0.955 in 3.4 s.
 *    This ramp is 6.6 s and is NOT a single ease — it is a keyframe list, on
 *    purpose, so it can loiter in the dusk band. Phase bounds (src/lib/lighting.js)
 *    are day 0.200-0.690, dusk 0.690-0.815, night 0.815+. The ramp spends 1.4 s
 *    crossing 0.712 -> 0.755, i.e. it holds inside dusk while the stone lanterns
 *    ignite and the horizon is at its warmest, and only then climbs to 0.955 for
 *    the moon and stars. Then 2.6 s of held night under the end card.
 *
 * ── Inherited from v1 (all of it still true, all of it re-verified) ──────────
 * - The camera rig is switched off; every non-gameplay shot is an eased
 *   interpolation between two keyframes (cubic in/out: zero velocity at both
 *   ends, which is why a hard cut never reads as a snap), plus a ~4 cm / ~11 s
 *   wobble so nothing is mechanically dead.
 * - The time-of-day rig is paused and dayT is driven from `t`.
 * - Shot 2 aims within a couple of degrees of `uSunDir` with the crown between
 *   camera and sun; that is what fans the volumetric shafts out instead of
 *   leaving a faint wash. Measured sun dirs: (-0.23, 0.66, -0.71) at dayT 0.60,
 *   (-0.18, 0.65, -0.74) at 0.64.
 * - capture.mjs warms only 240 frames, which leaves the fallen-petal carpet and
 *   the water bare, so setup() warms 600 more.
 * - 65-ui.js only retires the bloom-stage card when `!ctx.shotMode`, so we remove
 *   it by hand on roughly the clock the live game would, and before the cut.
 * - Compositions ruled out by rendering them: anything nearer than ~8 m under the
 *   canopy (near blossom cards fall in the DOF near field and the frame goes to
 *   mush); a tight trunk shot at 7 m (bark sits in front of the focal plane);
 *   holding on the tree's east side, where several major limbs carry no blossom
 *   and read as dead wood — shot 1 arcs those limbs behind the crown.
 *
 * ── Traps found while making this cut (read before iterating) ───────────────
 * - DO NOT JUDGE THE LOOK AT 960x540. Iterating at --w 960 --h 540 --fps 15 is
 *   the right way to check timing, camera paths and whether the numbers appear —
 *   it renders 35 s in about a minute — but the LOOK is wrong at that size: the
 *   gameplay shot came back milky and low-contrast, the tree small and veiled,
 *   and the burst looked bleached white. The identical frame at 1920x1080 is
 *   crisp and saturated. The post chain (god rays, bloom, DOF) is resolution
 *   dependent, so contrast/haze/flash judgements have to be made at 1080p. A
 *   1080p spot-check of a few marked frames costs ~2 minutes
 *   (.tmp-orch/probe-beats.mjs --marks 15.7,16.1,...) — do that instead of
 *   re-rendering the whole thing.
 * - 45-vfx's number layer is its OWN fixed element (#vfx-numbers), NOT a child
 *   of #ui-root. `g.setUI(false)` does not hide it. `rich` owns grove_auto1, so
 *   the game shakes the tree by itself every ~3 s, and those auto-gains were
 *   drawing "+4.2K" over the cinematic shots. frame() hides the layer with the HUD.
 * - 65-ui only schedules toast removal when `!ctx.shotMode`, so purchase /
 *   achievement / new-variety toasts pile up five-deep over the tree. frame()
 *   retires each one after 4.6 s, which is the lifetime the live game gives it.
 * - Backticks are illegal inside `pageScript` (it is itself a template literal).
 *   A backtick in a comment there is a syntax error at import time.
 * - Probes used, all in .tmp-orch/ (kept, they are cheap to re-run):
 *   probe-clicks2.mjs (canopy hit map + HUD anchor), probe-beats.mjs (dry-run the
 *   sim with no screenshots: crit times, taps landed, numbers in flight, bank
 *   readout, optional 1080p marked frames), probe-look.mjs (one frame per dayT).
 *
 * ── The cut ─────────────────────────────────────────────────────────────────
 *   1  0.00 – 4.60   day hero: arcs 3/4 -> frontal while pushing in
 *   2  4.60 – 9.30   low, up through the canopy into the sun: god rays
 *   3  9.30 – 13.20  the pond: sky, cloud, reeds, blossom in the mirror
 *   4 13.20 – 25.40  GAMEPLAY, locked `gameplay` preset, HUD on: taps, burst,
 *                    Tender purchase, burst, 花嵐 Petal Storm, 輝咲 stage-up
 *   5 25.40 – 35.50  HUD off: day -> dusk -> night over 6.6 s, then the end
 *                    card fades up over 2.6 s of held moonlit night
 */

export const duration = 35.5;
export const fps = 30;
/* DAY bed at the game's own master level (0.5). Do not add `volume`. */
export const audio = { phase: 'day', stage: 4 };
export const ui = true;          // toggled per shot from inside frame()
export const quality = 'ultra';

export const pageScript = `
/* ------------------------------------------------------------------ *
 * shot table
 *   preset: 'gameplay'  -> locked-off preset, re-applied every frame
 *   dayKeys: [[dtFromT0, dayT], ...] -> piecewise eased ramp (shot 5)
 * ------------------------------------------------------------------ */
const SHOTS = [
  // Arcs 14 degrees from the 3/4 view round to frontal while pushing in. The
  // frontal axis is deliberate: the tree's bare east limbs read as dead wood
  // from the 3/4 side, and swing behind the crown as the camera comes round.
  { t0: 0.00,  t1: 4.60,  ui: false,
    posA: [ 9.20, 5.60, 24.20], tgtA: [-0.40, 7.50, -1.00], fovA: 32.0, dayA: 0.500,
    posB: [ 2.20, 4.90, 21.80], tgtB: [-0.40, 7.10, -1.00], fovB: 34.0, dayB: 0.520 },

  // Low on the south side, looking up past the trunk into the sun. The crown
  // occludes the disc, so the shafts fan through the blossom and the petal cards
  // go translucent-pink from behind. Trucks left and rises 0.6 m so the shafts
  // sweep the canopy. Stays at 9-11 m: closer and the near cards enter the DOF
  // near field. camSpan < span on purpose — the dolly finishes at 7.90 and the
  // last 1.4 s hold on the frame where the disc has just broken through.
  { t0: 4.60,  t1: 9.30,  ui: false, camSpan: 3.30,
    posA: [ 3.10, 1.42, 10.60], tgtA: [-0.40, 9.00, -1.00], fovA: 47.0, dayA: 0.600,
    posB: [ 0.20, 2.05,  8.90], tgtB: [-1.40, 10.30, -1.80], fovB: 49.0, dayB: 0.640 },

  // Down onto the water: sky and cloud in the mirror, reeds, ripple rings, and
  // the canopy's reflection coming in at the right.
  { t0: 9.30,  t1: 13.20, ui: false,
    posA: [-5.00, 1.25, 12.00], tgtA: [-9.00, 0.90,  4.80], fovA: 44.0, dayA: 0.620,
    posB: [-6.90, 1.75, 10.00], tgtB: [-9.50, 0.70,  3.60], fovB: 42.0, dayB: 0.640 },

  // GAMEPLAY. The player's own framing, held dead still for 12.2 s. dayT creeps
  // 0.545 -> 0.590 (late afternoon, still inside the day band) so the shot is not
  // frozen in time, but nothing moves in frame except the game.
  { t0: 13.20, t1: 25.40, ui: true, preset: 'gameplay',
    dayA: 0.545, dayB: 0.590 },

  // Day -> dusk -> night, then hold. camSpan 8.0 over a 10.1 s shot: the camera
  // finishes its rise while the sky is still changing and the last 2.1 s are a
  // held frame for the card to sit on.
  { t0: 25.40, t1: 35.50, ui: false, camSpan: 8.00,
    posA: [12.40, 4.40, 17.40], tgtA: [ 0.60, 5.60, -1.60], fovA: 40.0,
    posB: [16.50, 7.20, 23.50], tgtB: [-0.50, 7.00, -1.00], fovB: 34.0,
    dayA: 0.560, dayB: 0.955,
    // Loiter in the dusk band (0.690-0.815) — the warm horizon is the thing the
    // review liked, so it gets 1.4 s to move 0.043 before the climb to night.
    dayKeys: [[0.00, 0.560], [1.50, 0.665], [2.90, 0.712], [4.30, 0.755],
              [5.40, 0.855], [6.60, 0.955]] },
];

/* ------------------------------------------------------------------ *
 * clicks — NDC coords, all inside the measured canopy hit region
 * (nx -0.30..+0.60, ny -0.05..+0.50 for the gameplay preset at 16:9).
 * A player's taps wander across the crown rather than repeating one pixel, so
 * the numbers fan out instead of stacking into one illegible column.
 * ------------------------------------------------------------------ */
const CLICKS = [
  [ 0.06, 0.30], [ 0.20, 0.22], [-0.02, 0.18], [ 0.30, 0.31], [ 0.14, 0.12],
  [ 0.36, 0.24], [ 0.02, 0.26], [ 0.24, 0.34], [ 0.10, 0.20], [ 0.32, 0.15],
  [-0.06, 0.24], [ 0.18, 0.29], [ 0.28, 0.20], [ 0.08, 0.34], [ 0.40, 0.28],
  [ 0.16, 0.16], [ 0.00, 0.32], [ 0.26, 0.26], [ 0.12, 0.24], [ 0.34, 0.33],
];
let clickI = 0;
function tap(g) {
  const c = CLICKS[clickI % CLICKS.length]; clickI++;
  try { g.clickWorld(c[0], c[1]); } catch (e) { /* never kill the render */ }
}

/* Rapid tapping. every: 0.10 s = ~10 taps/s, which is a fast human on a
 * trackpad, not a macro. Two windows so the shot has two crescendos. */
const BURSTS = [
  { t0: 15.35, t1: 16.45, every: 0.10 },
  { t0: 19.00, t1: 20.10, every: 0.10 },
];
let burstNext = BURSTS.map((b) => b.t0);

/* ------------------------------- beats ---------------------------- */
const BEATS = [
  // three unhurried establishing taps: one number in the air at a time, so the
  // arc into the HUD counter is legible before the bursts crowd the frame
  [13.60, (g) => tap(g)],
  [14.25, (g) => tap(g)],
  [14.90, (g) => tap(g)],
  // a real Tender purchase: gold ring, sparks, the panel row and the /s both tick
  [17.10, (g, G) => G.buy('rabbit', 2)],
  [17.90, (g) => tap(g)],
  [18.45, (g) => tap(g)],
  // 花嵐 Petal Storm — the game's own live event, via its debug entry point
  [20.55, (g) => g.scenarios['game-storm'] && g.scenarios['game-storm']()],
  [21.20, (g) => tap(g)],
  [21.80, (g) => tap(g)],
  [22.35, (g) => tap(g)],
  // Cross the 輝咲 Radiant threshold FOR REAL rather than calling the
  // 'game-stageup' debug scenario. That scenario assigns state.stage by hand and
  // 60-game's applyStage() then recomputes it from totalThisSeason and puts it
  // straight back — so the card announced a stage the HUD did not agree with.
  // Pushing the season total past 1e10 makes the game itself run applyStage():
  // same card, same +Blossoms, same shockwave, and the HUD stage row, progress
  // bar and card all agree.
  [23.00, (g, G) => { if (G && G.state) G.state.totalThisSeason = Math.max(G.state.totalThisSeason, 1.02e10); }],
  [23.90, (g) => tap(g)],
  [24.45, (g) => tap(g)],
  // 65-ui.js holds the bloom-stage card in shot mode. Retire it on roughly the
  // clock the player would see, and before the cut rather than after it.
  [25.30, () => { const c = document.querySelector('#ui-root .sk-stageup'); if (c) c.remove(); }],
];

/* ------------------------------- easing --------------------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// cubic in/out — zero velocity at both ends, so a cut never lands mid-whip
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const mix = (a, b, e) => a + (b - a) * e;

/** Piecewise eased ramp through a keyframe list. */
function rampKeys(keys, dt) {
  if (dt <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (dt <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      return mix(a[1], b[1], ease(clamp01((dt - a[0]) / (b[0] - a[0]))));
    }
  }
  return keys[keys.length - 1][1];
}

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
    '<div style="font-size:1.34vw;letter-spacing:.17em;text-indent:.17em;color:#FFF3F7;',
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
    clickI = 0;
    burstNext = BURSTS.map((b) => b.t0);
    // Own the camera outright: the rig's idle drift and pointer parallax would
    // fight both a keyframed dolly and a locked-off preset.
    if (ctx.assets.cameraRig && ctx.assets.cameraRig.setEnabled) ctx.assets.cameraRig.setEnabled(false);
    // Own the clock too: dayT is driven from t so shot 5 can run day -> night.
    if (ctx.assets.lighting && ctx.assets.lighting.pause) ctx.assets.lighting.pause(true);
    if (ctx.assets.lighting && ctx.assets.lighting.setDayT) ctx.assets.lighting.setDayT(0.50);
    // Mid-game save: 満開 Full Bloom, seven kinds of Tender, every panel populated.
    if (g.scenarios.rich) g.scenarios.rich();

    /* Crits, made reliable the honest way — by owning the upgrades that grant
     * them. rich() already has shake_c1 + shake_c2 (0.12 with the 0.03 base);
     * the rest of the Fortune line plus the Windfall Charm take it to 0.35 at
     * x28, so a 11-tap burst lands 3-4 crits. The RNG is seeded, so which taps
     * crit is identical on every render. */
    const G = ctx.assets.game;
    if (G && G.state) {
      for (const id of ['shake_c3', 'shake_c4']) G.state.upgrades[id] = 1;
      // The derived-stat cache only recomputes when something invalidates it;
      // a shake credits petals, which does. Without this the new crit chance
      // would not be live until the first tap of the burst.
      try { G.shake(null); } catch (e) { /* ignore */ }
    }

    g.setUI(false);
    card = endCard();
    // Let the petal carpet, the grass and the water settle before frame 0 —
    // capture only warms 4 s on its own, which leaves the ground bare and the
    // click VFX from the setup shake still on screen.
    g.warm(600);
  },

  frame(t, g, ctx) {
    const G = ctx.assets.game;

    /* ---- which shot are we in ---- */
    let s = SHOTS[0];
    for (let i = 0; i < SHOTS.length; i++) if (t >= SHOTS[i].t0) s = SHOTS[i];

    if (uiState !== s.ui) {
      uiState = s.ui;
      g.setUI(s.ui);
      /* 45-vfx's number layer is its OWN fixed element, not a child of #ui-root,
       * so setUI(false) does not hide it. rich() owns grove_auto1, which shakes
       * the tree by itself every ~3 s, and those gains were drawing "+4.2K" over
       * the cinematic shots. HUD off means numbers off. */
      const nl = document.getElementById('vfx-numbers');
      if (nl) nl.style.display = s.ui ? '' : 'none';
    }

    const span = s.t1 - s.t0;
    const dt0 = t - s.t0;
    const uCam = ease(clamp01(dt0 / (s.camSpan || span)));
    const uDay = ease(clamp01(dt0 / (s.daySpan || span)));

    if (ctx.assets.lighting && ctx.assets.lighting.setDayT) {
      ctx.assets.lighting.setDayT(s.dayKeys ? rampKeys(s.dayKeys, dt0) : mix(s.dayA, s.dayB, uDay));
    }

    /* ---- camera ---- *
     * The gameplay shot is the preset and nothing but the preset, re-applied
     * every frame: this is the framing the game is played at, and the point of
     * the shot is that it is the player's own view. Everything else is a dolly. */
    if (s.preset) {
      g.setCamera(s.preset);
    } else {
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
    }

    /* ---- beats + taps, AFTER the camera is placed ---- *
     * clickWorld() raycasts through the CURRENT camera and 45-vfx projects the
     * gain number through it too, so the camera must already be where this
     * frame will be photographed from. */
    for (let i = 0; i < BEATS.length; i++) {
      const b = BEATS[i];
      if (t >= b[0] && !fired[i]) {
        fired[i] = 1;
        try { b[1](g, G, ctx); } catch (e) { /* never let a beat kill the render */ }
      }
    }
    for (let i = 0; i < BURSTS.length; i++) {
      const b = BURSTS[i];
      if (t >= b.t0 && t < b.t1) {
        while (t >= burstNext[i] && burstNext[i] < b.t1) { tap(g); burstNext[i] += b.every; }
      }
    }

    /* ---- toasts: retire them on the live game's clock ---- *
     * 65-ui.js only schedules a toast's removal when !ctx.shotMode, so the
     * purchase / achievement / new-variety toasts would pile up five-deep over
     * the tree for the rest of the gameplay shot. The live game gives each one
     * 4.6 s, so give them 4.6 s of storyboard time. */
    if (s.ui) {
      const ts = document.querySelectorAll('#ui-root .sk-toast');
      for (let i = 0; i < ts.length; i++) {
        const el = ts[i];
        if (el.__t0 === undefined) el.__t0 = t;
        else if (t - el.__t0 > 4.6) el.remove();
      }
    }

    /* ---- end card: fades up over the held night frame ---- */
    if (card) {
      const a = clamp01((t - 32.10) / 1.20);
      card.style.opacity = String(a * a * (3 - 2 * a));
    }
  },
};
`;
