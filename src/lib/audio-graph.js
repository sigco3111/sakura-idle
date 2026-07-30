/**
 * audio-graph — the entire soundtrack as one buildable WebAudio graph.
 * Owned by the audio module (70-audio.js). No files, no network: every sound is
 * oscillators, seeded noise buffers, JS-rendered buffers and filters
 * (CONTRACT.md rule 1).
 *
 * THE ONE IMPORTANT IDEA
 * `buildGraph(ac, opts)` is called with a live `AudioContext` **or** an
 * `OfflineAudioContext`. Both paths get bit-for-bit the same node topology,
 * the same instruments and the same score generator; only the clock differs.
 * That is what makes `renderOffline()` an honest measurement of what a player
 * hears instead of a separate fiction.
 *
 * SOUND DESIGN — Japanese zen ambient. The koto is the melody and the identity;
 * everything else is the room it sits in.
 *   KOTO        Karplus-Strong rendered sample-by-sample in plain JS into an
 *               AudioBuffer (see `ksRender`), played back with a plain
 *               AudioBufferSourceNode and cached per pitch. It is the loudest
 *               musical layer and lives in its real register, D4-D5-ish.
 *   SHAKUHACHI  sine fundamental + 2nd/3rd partials + two lowpassed noise breath
 *               bands, 4.4 Hz vibrato a few cents deep, 140 ms attack, long release.
 *   BONSHO      temple bell: eight inharmonic partials plus two very quiet fixed
 *               shimmer partials at 2.3/2.9 kHz, struck once every 45-95 s.
 *   SUIKINKUTSU water drops: short sine blips with a fast pitch drop, mostly reverb.
 *   PAD         five sine/triangle voices, adjacent ones 2.2 cents apart, voiced on
 *               scale degrees only, through a slow 480-700 Hz lowpass — and it
 *               BREATHES: swell, hold, fall, silence. It is not a drone and it sits
 *               ~8 dB below the koto.
 *   WIND        brown noise through a lowpass whose cutoff and gain follow the
 *               game's real WIND.gust value.
 *   CRICKETS    night only, tiny 2.4 kHz blips, Q 5 (never a narrow whistle).
 *               BIRDS dawn/day only, soft sine chirps under 2 kHz.
 *
 * MASTER CHAIN (non-negotiable): highpass 32 Hz -> high-shelf tilt at 2.2 kHz ->
 * two cascaded lowpasses (3.4 / 3.8 kHz) -> soft-knee compressor (-18 dB, 16 dB
 * knee, 5:1) -> fast brickwall-ish LIMITER (2 ms attack, 20:1, hard knee) ->
 * WaveShaper hard ceiling at 0.95 -> trim -> master gain. Nothing downstream of an
 * instrument can be bright, and nothing — not a stacked chord, not a burst of
 * SFX — can spike or clip: the shaper is linear below 0.5 and mathematically
 * cannot exceed 0.95.
 *
 * `Ma` (間). The koto speaks in short phrases of 3-5 notes and then stops for
 * several seconds. Notes are events in a lot of silence.
 */

import { makeRng } from './rng.js';
import { noise3 } from './noise.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * THE BUG THAT MADE THE OLD SOUNDTRACK SCREECH — read before touching a filter.
 *
 * For `lowpass` and `highpass`, WebAudio's `BiquadFilterNode.Q` is in **decibels**,
 * not linear: the spec computes `alpha = sin(w0) / (2 * 10^(Q/20))`, so the
 * effective Q is `10^(Q/20)`. The "reassuringly gentle" values everyone reaches
 * for — Q = 0.2, 0.4, 0.6 — are therefore effective Qs of 1.02 to 1.07, i.e.
 * every one of them is a RESONANT filter with up to +1.5 dB of peak gain at the
 * corner frequency. So: for lowpass/highpass, Q must be NEGATIVE dB.
 * Butterworth (no peak at all) is 20*log10(1/sqrt(2)) = -3.01 dB.
 * Q on bandpass / peaking / notch IS linear — those values are left alone, and
 * on bandpass they are kept LOW (<= 6) so no band can ring as a whistle.
 */
const Q_LP = -3.01;    // Butterworth: maximally flat, peak gain exactly 1.0

/* ------------------------------------------------------------------ *
 * Scales — genuine Japanese pentatonics. No chromatic runs, no tritones.
 * Semitone offsets from the root.
 * ------------------------------------------------------------------ */
const SCALES = {
  hirajoshi: [0, 2, 3, 7, 8],   // D E F A B-flat — the classic koto tuning
  kumoi: [0, 2, 3, 7, 9],       // D E F A B — wistful, not dark
  yo: [0, 2, 5, 7, 9],          // D E G A B — open, no semitones at all
};

/**
 * THE KOTO REGISTER. A real koto (13 strings, hirajoshi) is tuned so the melody
 * sits around D4-D5, 294-587 Hz. That is where it is; anything an octave down is
 * a cello. The previous version was pinned to midi 33-58 because it ran
 * Karplus-Strong through a WebAudio DelayNode, and a DelayNode inside a feedback
 * cycle has a floor of one render quantum (128 samples = 344 Hz at 44.1 kHz).
 * `ksRender` runs the same algorithm in plain JS instead, so there is no ceiling
 * and the notes now land where they are written (measured within ~2 cents).
 */
const KOTO_LO = 61;   // C#4 (277 Hz) — below this the low-register mud starts
const KOTO_HI = 78;   // F#5 (740 Hz)

/**
 * Per-phase score configuration. Roots are MIDI notes; 50 = D3 (146.8 Hz).
 * `kotoLevel` is now a real output gain (the note buffers are peak-normalised),
 * not an excitation amount, so it is directly comparable across phases.
 */
const PHASES = {
  dawn: {
    scale: 'kumoi', root: 50, padRoot: 38, padCut: 620,
    fluteGap: [17, 27], waterGap: [7, 15], bellGap: [50, 85],
    padGain: 0.105, windGain: 0.85, birds: 0.9, crickets: 0.0,
    kotoLevel: 0.40, kotoRest: [3.6, 7.6], fluteLevel: 0.062, kotoCentre: 64,
  },
  day: {
    scale: 'yo', root: 52, padRoot: 40, padCut: 700,
    fluteGap: [16, 26], waterGap: [7, 14], bellGap: [55, 95],
    padGain: 0.100, windGain: 1.00, birds: 0.55, crickets: 0.0,
    kotoLevel: 0.40, kotoRest: [3.2, 6.8], fluteLevel: 0.062, kotoCentre: 64,
  },
  dusk: {
    scale: 'hirajoshi', root: 50, padRoot: 38, padCut: 560,
    fluteGap: [16, 27], waterGap: [7, 14], bellGap: [45, 80],
    padGain: 0.110, windGain: 0.80, birds: 0.15, crickets: 0.25,
    kotoLevel: 0.39, kotoRest: [3.4, 7.2], fluteLevel: 0.060, kotoCentre: 64,
  },
  night: {
    scale: 'kumoi', root: 45, padRoot: 33, padCut: 480,
    fluteGap: [20, 34], waterGap: [8, 17], bellGap: [45, 85],
    padGain: 0.105, windGain: 0.70, birds: 0.0, crickets: 1.0,
    kotoLevel: 0.40, kotoRest: [4.0, 8.2], fluteLevel: 0.058, kotoCentre: 63,
  },
};

/** The pad is a bed, not the tune: this is the 5 dB it gave back to the koto. */
const PAD_TRIM = 0.52;

/**
 * KOTO PHRASES — scale-degree contours, not random walks.
 * Each entry is one phrase: degree offsets from the phrase anchor, played in
 * order. Almost every interval is +-1 pentatonic step; a handful of phrases
 * carry one expressive leap. Then the phrase STOPS and `kotoRest` seconds of
 * silence follow. This replaces the old "step randomly forever" melody, whose
 * measured contour (+5, +2, -5, +3, -10 semitones) read as noise.
 */
const KOTO_PHRASES = [
  [0, 1, 2, 1],
  [0, 1, 0, -1, 0],
  [0, -1, -2, -1],
  [0, 2, 1, 0],
  [0, 1, 2, 3, 2],
  [0, -1, 0, 1],
  [0, 3, 2, 1],        // one leap up, then walk home
  [0, 1, -1, 0],
  [0, -2, -1, 0, 1],
  [0, 1, 2, 1, 0],
  [0, -1, 1, 2],
  [0, 4, 3, 2],        // the biggest reach in the set, used sparingly
];

/** WIND's own gust envelope, evaluated at an arbitrary time.
 *  Mirrors WindField.update() in src/lib/wind.js so the offline render moves
 *  the wind exactly the way the live scene does. */
export function gustAt(t) {
  const g = 0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.113 + 1.7);
  const n = noise3(t * 0.21, 5.5, 2.2) * 0.5 + 0.5;
  return Math.pow(clamp(g * 0.55 + n * 0.65, 0, 1), 1.7);
}

/* ------------------------------------------------------------------ *
 * buildGraph
 * ------------------------------------------------------------------ */
/**
 * @param {BaseAudioContext} ac      live AudioContext or OfflineAudioContext
 * @param {object} opts
 *   phase   'dawn'|'day'|'dusk'|'night'
 *   stage   bloom stage 0..5
 *   offline true when rendering (time origin 0, no node reaping)
 *   volume  master volume 0..1
 *   muted   start silent
 *   seed    RNG seed
 *   only    array of stream keys to solo ('koto','pad','flute','wind','air',...)
 * @returns {object} api
 */
export function buildGraph(ac, opts = {}) {
  const offline = !!opts.offline;
  const t0 = offline ? 0 : ac.currentTime + 0.08;
  const sr = ac.sampleRate;

  let phase = PHASES[opts.phase] ? opts.phase : 'day';
  let stage = clamp(Number.isFinite(opts.stage) ? opts.stage : 2, 0, 5);
  let volume = clamp(Number.isFinite(opts.volume) ? opts.volume : 0.5, 0, 1);
  let muted = !!opts.muted;

  const seed = (opts.seed ?? 0x5A12CE) >>> 0;
  // One RNG per stream: the live scheduler advances in small chunks while the
  // offline one does the whole window at once, and per-stream RNGs make the two
  // consume their numbers in the same order regardless.
  const rBuf = makeRng(seed ^ 0x9e37).next;
  const rKoto = makeRng(seed ^ 0x1111).next;
  const rFlute = makeRng(seed ^ 0x2222).next;
  const rWater = makeRng(seed ^ 0x3333).next;
  const rBell = makeRng(seed ^ 0x4444).next;
  const rPad = makeRng(seed ^ 0x5555).next;
  const rCrit = makeRng(seed ^ 0x6666).next;
  const rBird = makeRng(seed ^ 0x7777).next;
  const rSfx = makeRng(seed ^ 0x8888).next;

  const cfg = () => PHASES[phase];

  /* ---------------- noise buffers (created once) ---------------- */
  function makeNoise(seconds, kind) {
    const n = Math.max(1, Math.floor(sr * seconds));
    const b = ac.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    let last = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const w = rBuf() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 11; }
      // 'air' is one-pole lowpassed at ~2.5 kHz: enough room tone to keep the
      // top octaves from being a cliff of numerical zeros, far too quiet to hear
      // as hiss.
      else if (kind === 'air') { lp += 0.23 * (w - lp); d[i] = lp * 2.6; }
      else d[i] = w;
    }
    // remove any DC the integrator introduced, then normalise
    let mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    let pk = 1e-9;
    for (let i = 0; i < n; i++) { d[i] -= mean; if (Math.abs(d[i]) > pk) pk = Math.abs(d[i]); }
    const s = 0.92 / pk;
    for (let i = 0; i < n; i++) d[i] *= s;
    return b;
  }

  const whiteBuf = makeNoise(3.0, 'white');
  const brownBuf = makeNoise(5.0, 'brown');
  const airBuf = makeNoise(4.0, 'air');

  /**
   * A dark reverb impulse: decaying stereo noise, one-pole lowpassed so the tail
   * is a warm room and not a cymbal. Energy-normalised so the convolver has
   * roughly unity gain and the send level means what it says.
   */
  function makeVerbIR(seconds, decay, lpCoef) {
    const n = Math.floor(sr * seconds);
    const b = ac.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const env = Math.pow(1 - i / n, decay);
        lp += lpCoef * ((rBuf() * 2 - 1) - lp);
        d[i] = lp * env;
      }
      // a soft onset so the reverb blooms rather than slaps
      const pre = Math.floor(sr * 0.02);
      for (let i = 0; i < pre && i < n; i++) d[i] *= i / pre;
      let e = 0;
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const g = 1 / Math.sqrt(Math.max(e, 1e-12));
      for (let i = 0; i < n; i++) d[i] *= g;
    }
    return b;
  }

  /* ---------------- master chain ---------------- */
  const masterGain = ac.createGain();
  masterGain.gain.value = muted ? 0 : volume;
  masterGain.connect(ac.destination);

  const trim = ac.createGain();
  trim.gain.value = 0.95;
  trim.connect(masterGain);

  /**
   * HARD CEILING. A compressor is not a limiter: 20 ms of attack is longer than
   * a pluck's attack, so a transient walks straight through it. This WaveShaper
   * is the actual guarantee — exactly linear below 0.5, and its output cannot
   * leave +-0.95 for any finite input, so no stacked chord or SFX pile-up can
   * ever produce a clipped sample. 2x oversampling keeps the (very gentle) knee
   * from folding aliases back down into the audible band.
   */
  const CEIL = 0.95, LIN = 0.5;
  const shaper = ac.createWaveShaper();
  {
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= LIN ? a : LIN + (CEIL - LIN) * Math.tanh((a - LIN) / (CEIL - LIN));
      curve[i] = Math.sign(x) * y;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
  }
  shaper.connect(trim);

  // brickwall-ish limiter: fast enough to catch an 18 ms pluck attack
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -7;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(shaper);

  // musical glue, well above the limiter's threshold so the two never fight
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 16;      // soft knee — no audible grab
  comp.ratio.value = 5;
  comp.attack.value = 0.02;
  comp.release.value = 0.45;
  comp.connect(limiter);

  // two cascaded gentle lowpasses => ~24 dB/oct above 3.4 kHz
  const lp2 = ac.createBiquadFilter();
  lp2.type = 'lowpass'; lp2.frequency.value = 3800; lp2.Q.value = Q_LP;
  lp2.connect(comp);
  const lp1 = ac.createBiquadFilter();
  lp1.type = 'lowpass'; lp1.frequency.value = 3400; lp1.Q.value = Q_LP;
  lp1.connect(lp2);

  // Tilt the 2-5 kHz ear-fatigue band down before it reaches the lowpasses.
  // -4.5 dB rather than -6: the mix was measured as OVER-darkened (nothing at
  // all above 2.2 kHz), and 1.5 dB of shelf is the cheapest honest air there is.
  const tilt = ac.createBiquadFilter();
  tilt.type = 'highshelf'; tilt.frequency.value = 2200; tilt.gain.value = -5.0;
  tilt.connect(lp1);

  const hp = ac.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 32; hp.Q.value = Q_LP;
  hp.connect(tilt);

  const preMix = ac.createGain();
  preMix.gain.value = 1;
  preMix.connect(hp);

  /** Room air floor, about -45 dBFS, injected into the hard ceiling. */
  const airSrc = ac.createBufferSource();
  airSrc.buffer = airBuf; airSrc.loop = true;
  const airGain = ac.createGain();
  airGain.gain.value = 0.0040;
  airSrc.connect(airGain); airGain.connect(shaper);
  airSrc.start(t0);

  /* ---------------- buses ---------------- */
  const busMusic = ac.createGain(); busMusic.gain.value = 0.9; busMusic.connect(preMix);
  const busAmb = ac.createGain(); busAmb.gain.value = 0.9; busAmb.connect(preMix);
  const busSfx = ac.createGain(); busSfx.gain.value = 0.8; busSfx.connect(preMix);

  /* ---------------- reverb ---------------- */
  const verb = ac.createConvolver();
  verb.normalize = false;
  verb.buffer = makeVerbIR(3.6, 2.6, 0.10);
  const verbLp = ac.createBiquadFilter();
  verbLp.type = 'lowpass'; verbLp.frequency.value = 1400; verbLp.Q.value = Q_LP;
  const verbRet = ac.createGain(); verbRet.gain.value = 0.32;
  const verbSend = ac.createGain(); verbSend.gain.value = 1.0;
  verbSend.connect(verb); verb.connect(verbLp); verbLp.connect(verbRet);
  verbRet.connect(preMix);

  /* ---------------- voice bookkeeping ---------------- */
  const live = [];   // { until, nodes[] } — reaped by reap(), live path only
  let liveCount = 0;
  function keep(until, nodes) {
    if (offline) return;              // offline context is thrown away wholesale
    live.push({ until, nodes });
    liveCount++;
  }
  function reap(now) {
    if (offline) return;
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].until > now) continue;
      const ns = live[i].nodes;
      for (let k = 0; k < ns.length; k++) { try { ns[k].disconnect(); } catch { /* gone */ } }
      live.splice(i, 1);
      liveCount--;
    }
  }

  function send(node, amount) {
    const g = ac.createGain();
    g.gain.value = amount;
    node.connect(g); g.connect(verbSend);
    return g;
  }

  /* ================================================================ *
   * KOTO — Karplus-Strong, in JS, no DelayNode, no pitch ceiling
   * ================================================================ */

  /**
   * Render one plucked string into a Float32Array, peak-normalised to 1.
   *
   * The loop is  line[n] = g * ((1-b)*d[n] + b*d[n-1])  where d is the line read
   * `D` samples back with linear interpolation. The two-tap averager has a phase
   * delay of exactly `b` samples at low frequency, so setting `D = sr/f - b`
   * makes the total loop delay exactly one period and the pitch exact — that is
   * the whole reason this is worth doing in JS. `b` also sets how fast the upper
   * partials die (its gain at Nyquist is |1-2b|), i.e. how bright the string is.
   *
   * `g` is derived from a target T60 rather than picked by feel:
   * g = 10^(-3/(T60*f)), because the loop is traversed f times a second.
   *
   * LOW-REGISTER MUD. Decay is deliberately short down low. Two adjacent
   * pentatonic steps at 120-140 Hz beat at ~15 Hz, which is the middle of the
   * roughness band; the fix is to not let the low notes still be ringing when
   * the next one lands.
   */
  function ksRender(f, variant) {
    const T60 = clamp(0.95 + (f - 110) * 0.0044, 0.80, 3.0);
    const tail = 0.06;
    const n = Math.ceil(sr * (T60 + tail));
    const out = new Float32Array(n);

    const b = variant ? 0.34 : 0.46;          // loop damping weight => brightness
    const D = sr / f - b;                     // exact-pitch delay line length
    const Di = Math.floor(D), fr = D - Di;
    const L = Di + 4;
    const line = new Float32Array(L);
    const g = Math.pow(10, -3 / (T60 * f));

    const r = makeRng(((Math.round(f * 16) * 2654435761) ^ (variant * 0x9e3779b9)) >>> 0).next;

    /* excitation: a lowpassed noise burst, plus a pick-position comb. Cancelling
     * one partial by subtracting a delayed copy is what makes a pluck sound
     * plucked rather than struck. */
    const exCut = clamp(f * 4.5, 700, 2400);
    const aEx = 1 - Math.exp((-2 * Math.PI * exCut) / sr);
    const NB = Math.max(12, Math.round(D * (variant ? 1.25 : 0.9)));
    const pick = Math.max(1, Math.round(D * (variant ? 0.24 : 0.17)));
    const ex = new Float32Array(NB + pick + 2);
    let lpEx = 0;
    for (let i = 0; i < NB; i++) {
      lpEx += aEx * ((r() * 2 - 1) - lpEx);
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / NB);
      const v = lpEx * w;
      ex[i] += v;
      ex[i + pick] -= v * 0.72;
    }

    let w = 0, prev = 0;
    const exN = ex.length;
    for (let i = 0; i < n; i++) {
      let r0 = w - Di; if (r0 < 0) r0 += L;
      let r1 = r0 - 1; if (r1 < 0) r1 += L;
      const d = line[r0] * (1 - fr) + line[r1] * fr;
      const filt = (1 - b) * d + b * prev;
      prev = d;
      line[w] = g * filt + (i < exN ? ex[i] : 0);
      if (++w >= L) w = 0;
      out[i] = filt;
    }

    /* STRING-BODY BRIGHTNESS. A koto has a paulownia box and the nail (tsume)
     * hits it: a short bright transient, 16-30 ms, well inside the master
     * lowpass. It is NOT in the feedback path, so it cannot ring — which is the
     * whole point. This is the "air" the mix was missing, spent where it reads
     * as an instrument rather than as hiss. */
    const fc = clamp(f * 4.0, 1150, 2350);
    const wc = 2 * Math.sin((Math.PI * fc) / sr);
    const qc = 1 / 1.15;
    const tau = sr * (variant ? 0.026 : 0.017);
    const amp = variant ? 0.100 : 0.130;
    let lo = 0, bp = 0;
    const tn = Math.min(n, Math.ceil(sr * 0.13));
    for (let i = 0; i < tn; i++) {
      const x = (r() * 2 - 1) * Math.exp(-i / tau);
      lo += wc * bp;
      const hi = x - lo - qc * bp;
      bp += wc * hi;
      out[i] += bp * amp;
    }

    /* normalise + guarantee both ends sit exactly on zero (no click, ever) */
    let pk = 1e-9;
    for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
    const s = 1 / pk;
    const fadeIn = Math.ceil(sr * 0.0015);
    const fadeOut = Math.ceil(sr * tail);
    for (let i = 0; i < n; i++) {
      let v = out[i] * s;
      if (i < fadeIn) v *= i / fadeIn;
      const k = n - 1 - i;
      if (k < fadeOut) v *= k / fadeOut;
      out[i] = v;
    }
    return out;
  }

  /** One AudioBuffer per (pitch, variant). ~20 buffers covers a whole session. */
  const ksCache = new Map();
  function ksBuffer(midi, variant) {
    const key = midi * 2 + variant;
    let b = ksCache.get(key);
    if (b) return b;
    const data = ksRender(mtof(midi), variant);
    b = ac.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    ksCache.set(key, b);
    return b;
  }

  /** Shared koto voicing: box resonance, a touch of presence, then the bus. */
  function kotoChain(bus, sendAmt) {
    const inG = ac.createGain(); inG.gain.value = 1;
    const body = ac.createBiquadFilter();
    body.type = 'peaking'; body.frequency.value = 330; body.gain.value = 2.2; body.Q.value = 0.8;
    const pres = ac.createBiquadFilter();
    pres.type = 'peaking'; pres.frequency.value = 1500; pres.gain.value = 1.6; pres.Q.value = 0.7;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = Q_LP;
    inG.connect(body); body.connect(pres); pres.connect(lp); lp.connect(bus);
    send(lp, sendAmt);
    return inG;
  }
  const kotoIn = kotoChain(busMusic, 0.50);
  const kotoSfxIn = kotoChain(busSfx, 0.45);
  let kotoVariant = 0;

  /**
   * Play one koto note. `damp` > 0 mutes the string after that many seconds,
   * the way a player's left hand does — that is how a phrase stays a phrase
   * instead of turning into a pile of overlapping decays.
   */
  function pluck(when, midi, level = 0.3, dest = kotoIn, damp = 0) {
    if (liveCount > 28) return;
    let m = Math.round(midi);
    // fold by whole octaves into the register — arithmetic, not a while loop,
    // so it terminates even if someone later narrows the window below an octave
    if (m > KOTO_HI) m -= 12 * Math.ceil((m - KOTO_HI) / 12);
    if (m < KOTO_LO) m += 12 * Math.ceil((KOTO_LO - m) / 12);
    m = clamp(m, KOTO_LO, KOTO_HI);
    const buf = ksBuffer(m, kotoVariant++ & 1);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.setValueAtTime(level, when);
    let until = when + buf.duration + 0.05;
    const early = damp > 0 && damp < buf.duration;
    if (early) {
      // exponential mute, then a final ramp to EXACTLY zero so stopping the
      // source can never truncate a non-zero sample
      g.gain.setTargetAtTime(0.0001, when + damp, 0.15);
      until = when + damp + 0.85;
      g.gain.linearRampToValueAtTime(0, until);
    }
    src.connect(g); g.connect(dest);
    src.start(when);                       // stop() is illegal before start()
    if (early) src.stop(until + 0.02);
    keep(until + 0.1, [src, g]);
  }

  /* ================================================================ *
   * OTHER INSTRUMENTS
   * ================================================================ */

  /** SHAKUHACHI — breathy, soft-attack, long-release flute. */
  function flute(when, midi, dur = 3.4, level = 0.16) {
    if (liveCount > 28) return;
    const f = mtof(clamp(midi, 55, 79));
    const env = ac.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + 0.14);
    env.gain.linearRampToValueAtTime(level * 0.82, when + dur * 0.7);
    env.gain.setTargetAtTime(0.0001, when + dur, 0.9);

    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = clamp(f * 3.8, 700, 2700); tone.Q.value = Q_LP;
    tone.connect(env);

    const vib = ac.createOscillator();
    vib.type = 'sine'; vib.frequency.value = 4.4 + rFlute() * 0.5;
    const vibG = ac.createGain();
    vibG.gain.setValueAtTime(0, when);
    vibG.gain.linearRampToValueAtTime(7 + rFlute() * 4, when + 0.9);   // cents

    const parts = [];
    const gains = [1.0, 0.13, 0.055];
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * (i + 1);
      vib.connect(vibG); vibG.connect(o.detune);
      const g = ac.createGain(); g.gain.value = gains[i];
      o.connect(g); g.connect(tone);
      o.start(when); o.stop(when + dur + 2.2);
      parts.push(o, g);
    }

    // BREATH. Two bands: the body of the tone, and a small amount of real air
    // up at 2.3 kHz. The upper band is what makes a shakuhachi sound like
    // someone blowing across an edge rather than a sine wave.
    const nodes = [env, tone, vib, vibG];
    const bands = [
      { f: clamp(f * 2.0, 200, 1500), q: 0.9, lp: 1500, a: 0.30, b: 0.14 },
      { f: 2300, q: 0.8, lp: 3000, a: 0.028, b: 0.011 },
    ];
    for (const bd of bands) {
      const br = ac.createBufferSource();
      br.buffer = whiteBuf; br.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = bd.f; bp.Q.value = bd.q;
      const blp = ac.createBiquadFilter();
      blp.type = 'lowpass'; blp.frequency.value = bd.lp; blp.Q.value = Q_LP;
      const bg = ac.createGain();
      bg.gain.setValueAtTime(0, when);
      bg.gain.linearRampToValueAtTime(bd.a, when + 0.10);
      bg.gain.linearRampToValueAtTime(bd.b, when + dur * 0.6);
      br.connect(bp); bp.connect(blp); blp.connect(bg); bg.connect(tone);
      br.start(when, (rFlute() * 2) % 2.0); br.stop(when + dur + 1.0);
      nodes.push(br, bp, blp, bg);
    }

    env.connect(busMusic);
    nodes.push(send(env, 0.6), ...parts);
    vib.start(when); vib.stop(when + dur + 2.2);
    keep(when + dur + 2.6, nodes);
  }

  /**
   * BONSHO — temple bell. Inharmonic and long. Two very quiet fixed partials at
   * 2.35/2.9 kHz give it the shimmer a real bronze bell has; they are 35 dB
   * under the fundamental and gone in two seconds, which is air, not glare.
   */
  function bonsho(when, midi = 45, level = 0.13) {
    const f = mtof(clamp(midi, 33, 50));
    const ratios = [1.0, 2.01, 2.66, 3.02, 4.11, 5.42, 7.10, 9.35];
    const decays = [11.0, 8.0, 6.0, 4.5, 3.0, 2.0, 1.4, 0.9];
    const gains = [1.0, 0.60, 0.42, 0.30, 0.18, 0.10, 0.05, 0.028];
    const sum = ac.createGain();
    sum.gain.value = level;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = Q_LP;
    sum.connect(lp); lp.connect(busMusic);
    const s = send(lp, 0.8);
    const nodes = [sum, lp, s];
    let last = 0;
    const partial = (fi, gi, dec, at) => {
      const o = ac.createOscillator();
      o.type = 'sine'; o.frequency.value = fi;
      o.detune.value = (rBell() * 2 - 1) * 6;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gi, when + at);
      g.gain.setTargetAtTime(0.0001, when + at, dec / 5);
      o.connect(g); g.connect(sum);
      o.start(when); o.stop(when + dec + 0.5);
      last = Math.max(last, dec + 0.6);
      nodes.push(o, g);
    };
    for (let i = 0; i < ratios.length; i++) {
      const fi = f * ratios[i];
      if (fi > 2900) continue;
      partial(fi, gains[i], decays[i], 0.02 + i * 0.004);
    }
    partial(2350, 0.018, 2.2, 0.03);
    partial(2900, 0.010, 1.6, 0.03);
    // the strike itself: a soft, dark thud, no click
    const st = ac.createBufferSource();
    st.buffer = whiteBuf; st.loop = true;
    const stLp = ac.createBiquadFilter();
    stLp.type = 'lowpass'; stLp.frequency.value = 1100; stLp.Q.value = Q_LP;
    const stG = ac.createGain();
    stG.gain.setValueAtTime(0, when);
    stG.gain.linearRampToValueAtTime(0.5, when + 0.012);
    stG.gain.setTargetAtTime(0.0001, when + 0.02, 0.07);
    st.connect(stLp); stLp.connect(stG); stG.connect(sum);
    st.start(when, (rBell() * 2) % 2.0); st.stop(when + 0.6);
    nodes.push(st, stLp, stG);
    keep(when + last, nodes);
  }

  /** SUIKINKUTSU — a water drop into the reverb. */
  function drop(when, f = 1150, level = 0.10, bus = busAmb) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, when);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, when + 0.075);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.006);
    g.gain.setTargetAtTime(0.0001, when + 0.02, 0.055);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = Q_LP;
    o.connect(g); g.connect(lp); lp.connect(bus);
    const s = send(lp, 0.85);
    o.start(when); o.stop(when + 0.5);
    keep(when + 0.6, [o, g, lp, s]);
  }

  /** A soft dark chime — used by SFX where a "ping" would be wrong. */
  function chime(when, midi, level = 0.09, dur = 1.4) {
    const f = mtof(clamp(midi, 45, 76));
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.004;
    const g2 = ac.createGain(); g2.gain.value = 0.22;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.03);
    g.gain.setTargetAtTime(0.0001, when + 0.04, dur / 4);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2800; lp.Q.value = Q_LP;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(busSfx);
    const s = send(lp, 0.7);
    o.start(when); o2.start(when);
    o.stop(when + dur + 0.4); o2.stop(when + dur + 0.4);
    keep(when + dur + 0.5, [o, o2, g, g2, lp, s]);
  }

  /** A filtered noise gesture — rustles and swells. Never above `f` Hz. */
  function rustle(when, dur, level, f, Q = 0.6, bus = busSfx) {
    const src = ac.createBufferSource();
    src.buffer = whiteBuf; src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = Q;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(f * 1.6, 2200); lp.Q.value = Q_LP;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + Math.min(0.05, dur * 0.3));
    g.gain.setTargetAtTime(0.0001, when + Math.min(0.05, dur * 0.3), dur / 3.2);
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(bus);
    const s = send(g, 0.35);
    src.start(when, (rSfx() * 2) % 2.0); src.stop(when + dur + 0.3);
    keep(when + dur + 0.4, [src, bp, lp, g, s]);
  }

  /** A low wooden body hit — the `tok`. Sine only, so it cannot be bright. */
  function tok(when, f, dur, level, drop2 = 0.5, bus = busSfx) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, when);
    o.frequency.exponentialRampToValueAtTime(Math.max(f * drop2, 25), when + dur * 0.7);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.008);
    g.gain.setTargetAtTime(0.0001, when + 0.012, dur / 3.5);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = Q_LP;
    o.connect(g); g.connect(lp); lp.connect(bus);
    const s = send(lp, 0.3);
    o.start(when); o.stop(when + dur + 0.3);
    keep(when + dur + 0.4, [o, g, lp, s]);
  }

  /* ---------------- continuous layers ---------------- */

  // WIND — brown noise, lowpass cutoff and level driven by WIND.gust
  const windSrc = ac.createBufferSource();
  windSrc.buffer = brownBuf; windSrc.loop = true;
  const windLp = ac.createBiquadFilter();
  windLp.type = 'lowpass'; windLp.frequency.value = 320; windLp.Q.value = Q_LP;
  const windGain = ac.createGain(); windGain.gain.value = 0.05;
  windSrc.connect(windLp); windLp.connect(windGain); windGain.connect(busAmb);
  windSrc.start(t0);

  // the leaf layer only speaks in a gust, and stays under 1.8 kHz
  const leafSrc = ac.createBufferSource();
  leafSrc.buffer = whiteBuf; leafSrc.loop = true;
  const leafBp = ac.createBiquadFilter();
  leafBp.type = 'bandpass'; leafBp.frequency.value = 1000; leafBp.Q.value = 0.45;
  const leafLp = ac.createBiquadFilter();
  leafLp.type = 'lowpass'; leafLp.frequency.value = 1800; leafLp.Q.value = Q_LP;
  const leafGain = ac.createGain(); leafGain.gain.value = 0.0;
  leafSrc.connect(leafBp); leafBp.connect(leafLp); leafLp.connect(leafGain);
  leafGain.connect(busAmb);
  leafSrc.start(t0);

  /**
   * PAD — five voices, detune <= 5 cents so nothing beats audibly.
   *
   * It BREATHES. The old pad was active 100% of the time at -31.6 dBFS, i.e. a
   * continuous drone louder than the melody, which is the single thing that made
   * the mix read as "dark drone with faint plucks behind it". Now `padEvent`
   * draws one swell -> hold -> fall -> silence cycle at a time with plain linear
   * ramps (they chain from whatever the previous ramp ended on, so the envelope
   * can never jump), and the level is trimmed by PAD_TRIM.
   */
  const padFilter = ac.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = cfg().padCut; padFilter.Q.value = Q_LP;
  const padGain = ac.createGain(); padGain.gain.value = 0;
  // a separate trim so one-off events (stageup) can lean on the pad without
  // touching — and thereby breaking — the breathing envelope's ramp chain
  const padBoost = ac.createGain(); padBoost.gain.value = 1;
  padFilter.connect(padGain); padGain.connect(padBoost); padBoost.connect(busMusic);
  send(padBoost, 0.35);
  const PAD_INTERVALS = [0, 0, 12, 19, 24];
  const padVoices = [];
  for (let i = 0; i < 5; i++) {
    const o = ac.createOscillator();
    o.type = i === 3 ? 'triangle' : 'sine';
    o.frequency.value = mtof(cfg().padRoot + PAD_INTERVALS[i]);
    o.detune.value = (i - 2) * 2.2;
    const g = ac.createGain();
    g.gain.value = [0.30, 0.24, 0.30, 0.16, 0.10][i];
    o.connect(g); g.connect(padFilter);
    o.start(t0);
    padVoices.push({ osc: o, gain: g, interval: PAD_INTERVALS[i] });
  }
  const padLfo = ac.createOscillator();
  padLfo.type = 'sine'; padLfo.frequency.value = 0.027;
  const padLfoG = ac.createGain(); padLfoG.gain.value = 90;
  padLfo.connect(padLfoG); padLfoG.connect(padFilter.frequency);
  padLfo.start(t0);
  padGain.gain.setValueAtTime(0, t0);

  /* ================================================================ *
   * SCORE — sparse, free-rhythm, deterministic
   * ================================================================ */
  const S = {
    koto: t0 + (offline ? 1.2 : 4),
    flute: t0 + (offline ? 6.5 : 17),
    water: t0 + (offline ? 3.2 : 9),
    bell: t0 + (offline ? 9.0 : 40),
    pad: t0 + (offline ? 0.2 : 1.0),
    bird: t0 + 6,
    cricket: t0 + 3,
    sfx: t0 + (offline ? 4.5 : 1e9),   // only the offline audition plays fake SFX
  };
  let scale = SCALES[cfg().scale];

  const lerp = (a, b, t) => a + (b - a) * t;
  /**
   * Snap an arbitrary semitone offset onto the current mode, keeping the octave.
   * Without this the pad's fifth lands outside the scale whenever the drone is
   * voiced off the root (a fifth above F in hirajoshi is C, which is not in
   * hirajoshi) and the whole bed quietly clashes with the melody.
   */
  const snap = (off, sc) => {
    const oct = Math.floor(off / 12) * 12;
    const pc = off - oct;
    let best = sc[0], bestD = 99;
    for (let i = 0; i < sc.length; i++) {
      const d = Math.abs(sc[i] - pc);
      if (d < bestD) { bestD = d; best = sc[i]; }
    }
    return oct + best;
  };
  const gap = (rr, range) => lerp(range[0], range[1], rr());

  /* ---- koto melody: degrees, not semitones ---- */
  /** Absolute scale-degree index -> MIDI. Handles negative degrees. */
  function degToMidi(root, sc, d) {
    const len = sc.length;
    const oct = Math.floor(d / len);
    return root + oct * 12 + sc[d - oct * len];
  }
  /** The degree window that keeps the koto inside its real register.
   *  degToMidi is monotonic in d, so one sweep finds both ends. */
  function degRange(root, sc) {
    let lo = null, hi = null;
    for (let d = -24; d <= 40; d++) {
      const m = degToMidi(root, sc, d);
      if (m >= KOTO_LO && lo === null) lo = d;
      if (m <= KOTO_HI) hi = d;
    }
    if (lo === null) lo = 0;
    if (hi === null || hi < lo) hi = lo;
    return [lo, hi];
  }
  let kotoAnchor = null;

  function kotoPhrase(when) {
    const c = cfg();
    scale = SCALES[c.scale];
    const sc = scale;
    const [dLo, dHi] = degRange(c.root, sc);
    // Home is the degree nearest `kotoCentre`, NOT the middle of the register:
    // most phrases rise, so the anchor has to sit near the bottom of the target
    // range for the phrase tops to land inside D4-D5 instead of above it.
    let home = dLo;
    for (let d = dLo; d <= dHi; d++) {
      if (Math.abs(degToMidi(c.root, sc, d) - c.kotoCentre)
        < Math.abs(degToMidi(c.root, sc, home) - c.kotoCentre)) home = d;
    }
    if (kotoAnchor === null) kotoAnchor = home;

    const ph = KOTO_PHRASES[Math.floor(rKoto() * KOTO_PHRASES.length) % KOTO_PHRASES.length];
    const nNotes = Math.max(3, ph.length - (rKoto() < 0.28 ? 1 : 0));

    // the anchor drifts, but is always pulled back toward home, so the melody
    // keeps a centre instead of wandering off like the old random walk
    kotoAnchor += (rKoto() < 0.5 ? -1 : 1) * (rKoto() < 0.28 ? 2 : 1);
    kotoAnchor = Math.round(kotoAnchor * 0.55 + home * 0.45);
    // Fit the WHOLE phrase inside the register before playing a note of it.
    // Clamping notes individually instead would collapse the top of a rising
    // figure onto one repeated pitch, which is worse than transposing it.
    let lo = 0, hi = 0;
    for (let i = 0; i < nNotes; i++) { lo = Math.min(lo, ph[i]); hi = Math.max(hi, ph[i]); }
    let aLo = Math.max(dLo - lo, home - 1);
    let aHi = Math.min(dHi - hi, home + 2);
    if (aHi < aLo) aLo = aHi = clamp(home, dLo - lo, dHi - hi);
    kotoAnchor = clamp(kotoAnchor, aLo, aHi);
    const lvl = c.kotoLevel * lerp(0.90, 1.06, stage / 5);

    let t = when;
    for (let i = 0; i < nNotes; i++) {
      const d = clamp(kotoAnchor + ph[i], dLo, dHi);
      const midi = degToMidi(c.root, sc, d);
      const f = mtof(midi);
      const last = i === nNotes - 1;
      // How low this note is, 0..1. Low notes are damped sooner and given more
      // room after them: that is the mud fix, in two lines.
      const low = clamp((330 - f) / 170, 0, 1);
      const damp = last ? (low > 0.35 ? 1.1 : 0) : lerp(1.6, 0.6, low);
      const vel = i === 0 ? 1 : (last ? 0.94 : lerp(0.74, 0.88, rKoto()));
      pluck(t, midi, lvl * vel, kotoIn, damp);
      t += lerp(0.60, 1.02, rKoto()) * lerp(1.0, 1.5, low);
    }
    // MA. Real silence, long enough to hear the room.
    return (t - when) + gap(rKoto, c.kotoRest) * lerp(1.15, 0.88, stage / 5);
  }

  function fluteNote(when) {
    const c = cfg();
    const sc = SCALES[c.scale];
    const deg = Math.floor(rFlute() * sc.length);
    const dur = 2.6 + rFlute() * 3.2;
    flute(when, c.root + 12 + sc[deg], dur, c.fluteLevel * lerp(0.9, 1.1, stage / 5));
    // sometimes a second, lower answering tone after a breath
    if (rFlute() < 0.35) {
      flute(when + dur + 1.0 + rFlute() * 1.4, c.root + 12 + sc[(deg + 3) % sc.length],
        2.0 + rFlute() * 2.0, c.fluteLevel * 0.7);
    }
    return dur + gap(rFlute, c.fluteGap);
  }

  function waterEvent(when) {
    const c = cfg();
    const f = 950 + rWater() * 620;
    drop(when, f, 0.075 + rWater() * 0.05);
    if (rWater() < 0.38) drop(when + 0.22 + rWater() * 0.3, f * 0.78, 0.045);
    return gap(rWater, c.waterGap);
  }

  function bellEvent(when) {
    const c = cfg();
    bonsho(when, 45 + Math.floor(rBell() * 3) - 1, 0.115 + rBell() * 0.03);
    return gap(rBell, c.bellGap);
  }

  /** One breath of the pad: swell, hold, fall, silence. */
  function padEvent(when) {
    const c = cfg();
    const sc = SCALES[c.scale];
    const shift = sc[Math.floor(rPad() * sc.length)];
    for (let i = 0; i < padVoices.length; i++) {
      const v = padVoices[i];
      v.osc.frequency.setTargetAtTime(mtof(c.padRoot + snap(shift + v.interval, sc)), when, 3.5);
    }
    padFilter.frequency.setTargetAtTime(c.padCut, when, 5.0);

    const swell = 5.0 + rPad() * 3.0;
    const hold = 7.0 + rPad() * 7.0;
    const fall = 6.0 + rPad() * 3.0;
    const rest = 6.0 + rPad() * 6.0;
    const target = c.padGain * PAD_TRIM * lerp(0.9, 1.12, stage / 5);
    // anchor at silence first: without this the next swell's ramp would start
    // rising from the moment the previous fall ended and eat the rest
    padGain.gain.setValueAtTime(0, when);
    padGain.gain.linearRampToValueAtTime(target, when + swell);
    padGain.gain.setValueAtTime(target, when + swell + hold);
    padGain.gain.linearRampToValueAtTime(0, when + swell + hold + fall);
    return swell + hold + fall + rest;
  }

  function birdEvent(when) {
    const c = cfg();
    if (c.birds <= 0.001 || rBird() > c.birds) return 9 + rBird() * 14;
    const n = 2 + Math.floor(rBird() * 3);
    const f0 = 1250 + rBird() * 520;
    for (let i = 0; i < n; i++) {
      const tt = when + i * (0.09 + rBird() * 0.08);
      const o = ac.createOscillator();
      o.type = 'sine';
      const f = f0 * (0.9 + rBird() * 0.25);
      o.frequency.setValueAtTime(f, tt);
      o.frequency.exponentialRampToValueAtTime(f * (0.82 + rBird() * 0.3), tt + 0.07);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.013 * (0.7 + rBird() * 0.5), tt + 0.016);
      g.gain.setTargetAtTime(0.0001, tt + 0.02, 0.03);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2800; lp.Q.value = Q_LP;
      o.connect(g); g.connect(lp); lp.connect(busAmb);
      const s = send(lp, 0.55);
      o.start(tt); o.stop(tt + 0.3);
      keep(tt + 0.4, [o, g, lp, s]);
    }
    return 10 + rBird() * 16;
  }

  /**
   * CRICKETS. Q is 5, not 14. At -63 dBFS a Q=14 band is inaudible either way,
   * but it is a landmine: the first person to raise the cricket level gets a
   * piercing narrow 2.4 kHz tone every few seconds, all night. A broad band
   * reads as an insect; a narrow one reads as a test tone.
   */
  function cricketEvent(when) {
    const c = cfg();
    if (c.crickets <= 0.001) return 8 + rCrit() * 8;
    if (rCrit() > c.crickets) return 1.5 + rCrit() * 2.5;
    const f = 2300 + rCrit() * 350;
    const reps = 2 + Math.floor(rCrit() * 3);
    for (let i = 0; i < reps; i++) {
      const tt = when + i * 0.055;
      const src = ac.createBufferSource();
      src.buffer = whiteBuf; src.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 5;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.010, tt + 0.006);
      g.gain.setTargetAtTime(0.0001, tt + 0.008, 0.006);
      src.connect(bp); bp.connect(g); g.connect(busAmb);
      src.start(tt, (rCrit() * 2) % 2.0); src.stop(tt + 0.12);
      keep(tt + 0.2, [src, bp, g]);
    }
    return 1.6 + rCrit() * 3.4;
  }

  /* ---------------- SFX ---------------- */
  function sfx(id, when, o = {}) {
    const g = clamp(o.gain ?? 1, 0, 1.4);
    const c = cfg();
    const sc = SCALES[c.scale];
    const kbase = c.root + 12;      // SFX plucks live in the same register as the melody
    switch (id) {
      case 'shake':
      case 'click':
        rustle(when, 0.22 + rSfx() * 0.10, 0.075 * g, 780 + rSfx() * 220, 0.55);
        tok(when + 0.006, 165 + rSfx() * 30, 0.13, 0.105 * g, 0.55);
        break;
      case 'crit':
        pluck(when, kbase + sc[2], 0.26 * g, kotoSfxIn, 1.2);
        chime(when + 0.02, c.root + 19, 0.06 * g, 1.3);
        break;
      case 'purchase':
        tok(when, 190, 0.11, 0.07 * g, 0.6);
        pluck(when + 0.01, kbase + sc[0], 0.24 * g, kotoSfxIn, 1.1);
        break;
      case 'upgrade':
        pluck(when, kbase + sc[0], 0.24 * g, kotoSfxIn, 0.9);
        pluck(when + 0.16, kbase + sc[3], 0.21 * g, kotoSfxIn, 1.3);
        chime(when + 0.30, c.root + 12 + sc[1], 0.05 * g, 1.6);
        break;
      case 'achievement':
        for (let i = 0; i < 3; i++) {
          chime(when + i * 0.20, c.root + 12 + sc[i + 1], 0.055 * g, 1.6);
        }
        break;
      case 'golden':
      case 'goldenAppear': {
        const n = id === 'golden' ? 4 : 2;
        for (let i = 0; i < n; i++) {
          drop(when + i * 0.13, 780 + i * 90, (id === 'golden' ? 0.055 : 0.04) * g, busSfx);
        }
        break;
      }
      case 'stageup':
        bonsho(when, 45, 0.13 * g);
        rustle(when, 2.6, 0.05 * g, 420, 0.4);
        // a rising pentatonic figure in the koto's own register
        for (let i = 0; i < 4; i++) {
          pluck(when + 0.5 + i * 0.34, kbase + sc[i % sc.length] + (i === 3 ? 12 : 0),
            0.26 * g, kotoSfxIn, i === 3 ? 0 : 1.1);
        }
        flute(when + 0.8, c.root + 12 + sc[2], 4.5, 0.11 * g);
        padBoost.gain.cancelScheduledValues(when);
        padBoost.gain.setTargetAtTime(2.0, when + 0.1, 0.7);
        padBoost.gain.setTargetAtTime(1.0, when + 4.0, 2.5);
        break;
      case 'storm':
        rustle(when, 3.2, 0.075 * g, 300, 0.35, busAmb);
        tok(when, 70, 1.4, 0.10 * g, 0.5);
        break;
      default:
        break;
    }
  }

  /** The offline audition plays representative gameplay SFX so the harness
   *  measures the mix a player actually hears, not just the music bed. */
  function sfxEvent(when) {
    const roll = rSfx();
    if (roll < 0.55) sfx('shake', when, { gain: 0.9 });
    else if (roll < 0.72) sfx('crit', when, { gain: 0.85 });
    else if (roll < 0.86) sfx('purchase', when, { gain: 0.9 });
    else sfx('achievement', when, { gain: 0.85 });
    return 5.0 + rSfx() * 7.0;
  }

  /* ---------------- scheduling ---------------- */
  const ALL_STREAMS = [
    ['koto', kotoPhrase], ['flute', fluteNote], ['water', waterEvent],
    ['bell', bellEvent], ['pad', padEvent], ['bird', birdEvent],
    ['cricket', cricketEvent], ['sfx', sfxEvent],
  ];
  // `opts.only` solos layers — how you audition one instrument at a time
  // (renderOffline({ only: ['koto'] })). Absent = the whole score, which is
  // what the harness and the game always use.
  const only = Array.isArray(opts.only) ? opts.only : null;
  const on = (k) => !only || only.indexOf(k) !== -1;
  const STREAMS = ALL_STREAMS.filter(([k]) => on(k));
  if (!on('wind')) { windGain.gain.value = 0; leafGain.gain.value = 0; }
  if (!on('air')) airGain.gain.value = 0;
  if (!on('verb')) verbRet.gain.value = 0;

  function scheduleWindow(from, to) {
    for (let i = 0; i < STREAMS.length; i++) {
      const [key, fn] = STREAMS[i];
      let guard = 0;
      while (S[key] < to && guard++ < 400) {
        const at = Math.max(S[key], from);
        const adv = fn(at);
        S[key] = at + Math.max(adv, 0.4);
      }
    }
  }

  /* ---------------- wind driving ---------------- */
  function setWind(g, when, smooth = 0.6) {
    const c = cfg();
    const w = clamp(g, 0, 1.4);
    const lvl = (0.032 + 0.075 * w) * c.windGain;
    const cut = 170 + 260 * w;
    const leaf = (0.005 + 0.024 * Math.pow(w, 2.0)) * c.windGain;
    if (smooth > 0) {
      windGain.gain.setTargetAtTime(lvl, when, smooth);
      windLp.frequency.setTargetAtTime(cut, when, smooth);
      leafGain.gain.setTargetAtTime(leaf, when, smooth * 0.8);
    } else {
      windGain.gain.linearRampToValueAtTime(lvl, when);
      windLp.frequency.linearRampToValueAtTime(cut, when);
      leafGain.gain.linearRampToValueAtTime(leaf, when);
    }
  }

  /** Pre-draw the whole wind envelope for an offline render. */
  function automateWind(seconds, timeOffset = 0) {
    if (!on('wind')) return;
    windGain.gain.setValueAtTime(windGain.gain.value, 0);
    windLp.frequency.setValueAtTime(windLp.frequency.value, 0);
    leafGain.gain.setValueAtTime(leafGain.gain.value, 0);
    for (let t = 0.25; t <= seconds + 0.25; t += 0.25) setWind(gustAt(timeOffset + t), t, 0);
  }

  /* ---------------- public api ---------------- */
  return {
    ac,
    t0,
    busMusic, busAmb, busSfx, masterGain,
    scheduleWindow,
    setWind,
    automateWind,
    sfx,
    reap,
    get voices() { return liveCount; },
    setPhase(p, st) {
      if (PHASES[p]) phase = p;
      if (Number.isFinite(st)) stage = clamp(st, 0, 5);
      scale = SCALES[cfg().scale];
      kotoAnchor = null;          // re-centre on the new mode's register
    },
    setVolume(v, when) {
      volume = clamp(Number(v) || 0, 0, 1);
      if (!muted) masterGain.gain.setTargetAtTime(volume, when ?? 0, 0.08);
    },
    setMuted(m, when) {
      muted = !!m;
      masterGain.gain.setTargetAtTime(muted ? 0 : volume, when ?? 0, 0.08);
    },
    get muted() { return muted; },
    get volume() { return volume; },
  };
}

/**
 * Render the live graph offline and hand back the AudioBuffer.
 * Same `buildGraph`, same instruments, same score — only the clock differs.
 */
export async function renderGraphOffline(seconds = 30, opts = {}) {
  const OAC = (typeof window !== 'undefined')
    ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
  if (!OAC) return null;
  const secs = clamp(Number(seconds) || 30, 1, 240);
  const rate = clamp(Number(opts.sampleRate) || 44100, 8000, 96000);
  const oac = new OAC(2, Math.ceil(secs * rate), rate);
  const g = buildGraph(oac, {
    phase: opts.phase, stage: opts.stage, offline: true,
    volume: Number.isFinite(opts.volume) ? opts.volume : 0.5,
    muted: false, seed: opts.seed, only: opts.only,
  });
  g.automateWind(secs, Number(opts.windOffset) || 0);
  g.scheduleWindow(0, secs);
  return oac.startRendering();
}
