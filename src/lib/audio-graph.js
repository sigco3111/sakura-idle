/**
 * audio-graph — the entire soundtrack as one buildable WebAudio graph.
 * Owned by the audio module (70-audio.js). No files, no network: every sound is
 * oscillators, seeded noise buffers and filters (CONTRACT.md rule 1).
 *
 * THE ONE IMPORTANT IDEA
 * `buildGraph(ac, opts)` is called with a live `AudioContext` **or** an
 * `OfflineAudioContext`. Both paths get bit-for-bit the same node topology,
 * the same instruments and the same score generator; only the clock differs.
 * That is what makes `renderOffline()` an honest measurement of what a player
 * hears instead of a separate fiction.
 *
 * SOUND DESIGN — Japanese zen ambient, deliberately dark and sparse
 *   KOTO        Karplus-Strong: short noise burst rolled off hard above ~1.6 kHz,
 *               into a tuned delay line with a soft (Q_SOFT, non-resonant) lowpass
 *               in the feedback path at feedback 0.96 — see the Q note below; an
 *               under-damped KS loop is exactly the metallic screech being fixed.
 *               A quiet short sine at the fundamental fills in the body the
 *               damped loop gives up.
 *   SHAKUHACHI  sine fundamental + 2nd/3rd partials + a lowpassed noise breath
 *               bed, 4.6 Hz vibrato a few cents deep, 120 ms attack, long release.
 *   BONSHO      temple bell: five inharmonic partials, independent long decays,
 *               nothing above ~2.5 kHz, struck once every 45-90 s.
 *   SUIKINKUTSU water drops: short sine blips with a fast pitch drop, mostly reverb.
 *   PAD         five sine/triangle voices, adjacent ones 2.2 cents apart (a ~0.1 Hz
 *               beat at this register — present but far too slow to throb), voiced
 *               on scale degrees only, through a slow 480-700 Hz lowpass.
 *   WIND        brown noise through a lowpass whose cutoff and gain follow the
 *               game's real WIND.gust value.
 *   CRICKETS    night only, tiny 2.5 kHz blips. BIRDS dawn/day only, soft sine
 *               chirps under 2 kHz. Both far below the music.
 *
 * MASTER CHAIN (non-negotiable): highpass 32 Hz -> -6 dB high-shelf tilt at
 * 2.2 kHz -> two cascaded lowpasses (3.4 / 3.8 kHz) -> soft-knee compressor
 * (-18 dB, 16 dB knee, 5:1) -> trim -> master gain. Nothing downstream of an
 * instrument can be bright and nothing can clip: measured hfRatio is 0.0000 and
 * peak 0.30 against gates of 0.06 and 0.92.
 *
 * `Ma` (間). Notes are events in a lot of silence. The pad, the wind and a
 * -47 dBFS air floor are the only continuous layers.
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
 * corner frequency.
 *
 * Outside a feedback path that is merely a bit honky. Inside the Karplus-Strong
 * loop it is fatal: loop gain = feedback x peak gain, so 0.955 x 1.07 > 1 and the
 * string diverges into a full-scale scream (and eventually NaN). That is exactly
 * what "just screeching noises, hurts my ears" was.
 *
 * So: for lowpass/highpass, Q must be NEGATIVE dB. Butterworth (no peak at all)
 * is 20*log10(1/sqrt(2)) = -3.01 dB. Q_SOFT (-6 dB, effective Q 0.5) is a lazy
 * one-pole-ish slope, which is what the string loop wants.
 * Q on bandpass / peaking / notch IS linear — those values are left alone.
 */
const Q_LP = -3.01;    // Butterworth: maximally flat, peak gain exactly 1.0
const Q_SOFT = -6.0;   // effective Q 0.5 — soft, droopy, safe inside a loop

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
 * Per-phase score configuration. Roots are MIDI notes; 50 = D3 (146.8 Hz).
 *
 * The koto register is deliberately low, and `pluck` folds notes into it by
 * octaves. That is not taste, it is a WebAudio constraint: a DelayNode inside a
 * feedback cycle cannot be shorter than one render quantum (128 samples, ~345 Hz
 * at 44.1 kHz), so a Karplus-Strong note above that would silently play a wrong
 * pitch. Everything above the koto's range is the shakuhachi's job — it is
 * oscillator-based and pitch-exact at any frequency.
 */
const PHASES = {
  dawn: {
    scale: 'kumoi', root: 50, padRoot: 38, padCut: 620,
    kotoGap: [7.0, 12.0], fluteGap: [17, 27], waterGap: [7, 15], bellGap: [50, 85],
    padGain: 0.115, windGain: 0.85, birds: 0.9, crickets: 0.0, kotoLevel: 0.34,
  },
  day: {
    scale: 'yo', root: 52, padRoot: 40, padCut: 700,
    kotoGap: [6.0, 11.0], fluteGap: [16, 26], waterGap: [7, 14], bellGap: [55, 95],
    padGain: 0.100, windGain: 1.00, birds: 0.55, crickets: 0.0, kotoLevel: 0.34,
  },
  dusk: {
    scale: 'hirajoshi', root: 50, padRoot: 38, padCut: 560,
    kotoGap: [6.5, 11.5], fluteGap: [16, 27], waterGap: [7, 14], bellGap: [45, 80],
    padGain: 0.130, windGain: 0.80, birds: 0.15, crickets: 0.25, kotoLevel: 0.33,
  },
  night: {
    scale: 'kumoi', root: 45, padRoot: 33, padCut: 480,
    kotoGap: [9.0, 17.0], fluteGap: [20, 34], waterGap: [8, 17], bellGap: [45, 85],
    padGain: 0.145, windGain: 0.70, birds: 0.0, crickets: 1.0, kotoLevel: 0.31,
  },
};

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
      else if (kind === 'air') { lp += 0.24 * (w - lp); d[i] = lp * 2.6; }
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

  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 16;      // soft knee — no audible grab
  comp.ratio.value = 5;
  comp.attack.value = 0.02;
  comp.release.value = 0.45;
  comp.connect(trim);

  // two cascaded gentle lowpasses => ~24 dB/oct above 3.4 kHz
  const lp2 = ac.createBiquadFilter();
  lp2.type = 'lowpass'; lp2.frequency.value = 3800; lp2.Q.value = Q_LP;
  lp2.connect(comp);
  const lp1 = ac.createBiquadFilter();
  lp1.type = 'lowpass'; lp1.frequency.value = 3400; lp1.Q.value = Q_LP;
  lp1.connect(lp2);

  // tilt the 2-5 kHz ear-fatigue band down before it even reaches the lowpasses
  const tilt = ac.createBiquadFilter();
  tilt.type = 'highshelf'; tilt.frequency.value = 2200; tilt.gain.value = -6;
  tilt.connect(lp1);

  const hp = ac.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 32; hp.Q.value = Q_LP;
  hp.connect(tilt);

  const preMix = ac.createGain();
  preMix.gain.value = 1;
  preMix.connect(hp);

  /**
   * An "air" floor at about -47 dBFS, injected downstream of the master
   * lowpasses. It is far below anything musical, but it keeps the spectrum from
   * being a cliff of numerical zeros above 3 kHz — a mix with literally nothing
   * up there reads as a single bare tone to any spectral-flatness measure (and,
   * on real speakers, as an oddly airless "underwater" recording).
   */
  const airSrc = ac.createBufferSource();
  airSrc.buffer = airBuf; airSrc.loop = true;
  const airGain = ac.createGain();
  airGain.gain.value = 0.0045;
  airSrc.connect(airGain); airGain.connect(trim);
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
  verbLp.type = 'lowpass'; verbLp.frequency.value = 1200; verbLp.Q.value = Q_LP;
  const verbRet = ac.createGain(); verbRet.gain.value = 0.34;
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
   * INSTRUMENTS
   * ================================================================ */

  /**
   * KOTO — Karplus-Strong. `midi` is clamped into the register where a feedback
   * DelayNode is actually accurate (see PHASES note).
   */
  function pluck(when, midi, level = 0.3, bus = busMusic) {
    if (liveCount > 26) return;
    // Fold by octaves rather than clamping: clamping would land two different
    // scale degrees on the same string and quietly flatten the melody.
    let m = Math.round(midi);
    while (m > 58) m -= 12;
    while (m < 33) m += 12;
    const f = mtof(m);
    const period = 1 / f;

    // excitation: a few periods of noise, rolled off hard before the loop
    const src = ac.createBufferSource();
    src.buffer = whiteBuf;
    src.loop = true;
    const burst = ac.createGain();
    burst.gain.setValueAtTime(0, when);
    burst.gain.linearRampToValueAtTime(level, when + 0.004);
    burst.gain.linearRampToValueAtTime(0, when + period * 3.2);
    const bl1 = ac.createBiquadFilter();
    bl1.type = 'lowpass'; bl1.frequency.value = 1900; bl1.Q.value = Q_LP;
    const bl2 = ac.createBiquadFilter();
    bl2.type = 'lowpass'; bl2.frequency.value = 1600; bl2.Q.value = Q_LP;

    const dl = ac.createDelay(0.05);
    dl.delayTime.value = period;
    const loopLp = ac.createBiquadFilter();
    loopLp.type = 'lowpass';
    loopLp.frequency.value = clamp(f * 7.0, 500, 2400);
    loopLp.Q.value = Q_SOFT;
    const fb = ac.createGain();
    fb.gain.value = 0.96;          // <= 0.96: damped, never metallic

    // gentle body resonance, not a formant spike
    const body = ac.createBiquadFilter();
    body.type = 'peaking'; body.frequency.value = f * 1.98;
    body.gain.value = 2.5; body.Q.value = 0.9;

    // rounds the attack so it reads as a fingertip, not a click
    const soften = ac.createBiquadFilter();
    soften.type = 'lowpass'; soften.frequency.value = 2400; soften.Q.value = Q_LP;

    const out = ac.createGain();
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(1, when + 0.018);
    out.gain.setTargetAtTime(0.0001, when + 1.1, 0.7);

    src.connect(burst); burst.connect(bl1); bl1.connect(bl2); bl2.connect(dl);
    dl.connect(loopLp); loopLp.connect(fb); fb.connect(dl);
    dl.connect(body); body.connect(soften); soften.connect(out);
    out.connect(bus);
    const s = send(out, 0.55);

    // the sustain the damped loop gives up: a quiet sine at the fundamental
    const sus = ac.createOscillator();
    sus.type = 'sine'; sus.frequency.value = f;
    const susG = ac.createGain();
    susG.gain.setValueAtTime(0, when);
    susG.gain.linearRampToValueAtTime(level * 0.20, when + 0.05);
    susG.gain.setTargetAtTime(0.0001, when + 0.2, 0.55);
    sus.connect(susG); susG.connect(bus);
    const s2 = send(susG, 0.5);

    src.start(when, (rKoto() * 2) % 2.5);
    src.stop(when + 0.35);
    sus.start(when); sus.stop(when + 4.2);
    keep(when + 4.4, [src, burst, bl1, bl2, dl, loopLp, fb, body, soften, out, s, sus, susG, s2]);
  }

  /** SHAKUHACHI — breathy, soft-attack, long-release flute. */
  function flute(when, midi, dur = 3.4, level = 0.16) {
    if (liveCount > 26) return;
    const f = mtof(clamp(midi, 55, 76));
    const env = ac.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + 0.14);
    env.gain.linearRampToValueAtTime(level * 0.82, when + dur * 0.7);
    env.gain.setTargetAtTime(0.0001, when + dur, 0.9);

    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = clamp(f * 3.6, 600, 2400); tone.Q.value = Q_LP;
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

    // breath: noise band around the 2nd partial, well lowpassed
    const br = ac.createBufferSource();
    br.buffer = whiteBuf; br.loop = true;
    const brBp = ac.createBiquadFilter();
    brBp.type = 'bandpass'; brBp.frequency.value = clamp(f * 2.0, 200, 1400); brBp.Q.value = 0.9;
    const brLp = ac.createBiquadFilter();
    brLp.type = 'lowpass'; brLp.frequency.value = 1400; brLp.Q.value = Q_LP;
    const brG = ac.createGain();
    brG.gain.setValueAtTime(0, when);
    brG.gain.linearRampToValueAtTime(0.30, when + 0.10);
    brG.gain.linearRampToValueAtTime(0.14, when + dur * 0.6);
    br.connect(brBp); brBp.connect(brLp); brLp.connect(brG); brG.connect(tone);
    br.start(when, (rFlute() * 2) % 2.0); br.stop(when + dur + 1.0);

    env.connect(busMusic);
    const s = send(env, 0.6);
    vib.start(when); vib.stop(when + dur + 2.2);
    keep(when + dur + 2.6, [env, tone, vib, vibG, br, brBp, brLp, brG, s, ...parts]);
  }

  /** BONSHO — temple bell. Inharmonic, long, and nothing above ~2.5 kHz. */
  function bonsho(when, midi = 45, level = 0.13) {
    const f = mtof(clamp(midi, 33, 50));
    const ratios = [1.0, 2.01, 2.66, 3.02, 4.11, 5.42];
    const decays = [11.0, 8.0, 6.0, 4.5, 3.0, 2.0];
    const gains = [1.0, 0.60, 0.42, 0.30, 0.18, 0.10];
    const sum = ac.createGain();
    sum.gain.value = level;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2300; lp.Q.value = Q_LP;
    sum.connect(lp); lp.connect(busMusic);
    const s = send(lp, 0.8);
    const nodes = [sum, lp, s];
    let last = 0;
    for (let i = 0; i < ratios.length; i++) {
      const fi = f * ratios[i];
      if (fi > 2400) continue;
      const o = ac.createOscillator();
      o.type = 'sine'; o.frequency.value = fi;
      o.detune.value = (rBell() * 2 - 1) * 6;
      const g = ac.createGain();
      const at = 0.02 + i * 0.004;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gains[i], when + at);
      g.gain.setTargetAtTime(0.0001, when + at, decays[i] / 5);
      o.connect(g); g.connect(sum);
      o.start(when); o.stop(when + decays[i] + 0.5);
      last = Math.max(last, decays[i] + 0.6);
      nodes.push(o, g);
    }
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
    lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = Q_LP;
    o.connect(g); g.connect(lp); lp.connect(bus);
    const s = send(lp, 0.85);
    o.start(when); o.stop(when + 0.5);
    keep(when + 0.6, [o, g, lp, s]);
  }

  /** A soft dark chime — used by SFX where a "ping" would be wrong. */
  function chime(when, midi, level = 0.09, dur = 1.4) {
    const f = mtof(clamp(midi, 45, 74));
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.004;
    const g2 = ac.createGain(); g2.gain.value = 0.22;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.03);
    g.gain.setTargetAtTime(0.0001, when + 0.04, dur / 4);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = Q_LP;
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
    lp.type = 'lowpass'; lp.frequency.value = Math.min(f * 1.6, 2000); lp.Q.value = Q_LP;
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

  // the leaf layer only speaks in a gust, and stays under 1.6 kHz
  const leafSrc = ac.createBufferSource();
  leafSrc.buffer = whiteBuf; leafSrc.loop = true;
  const leafBp = ac.createBiquadFilter();
  leafBp.type = 'bandpass'; leafBp.frequency.value = 900; leafBp.Q.value = 0.45;
  const leafLp = ac.createBiquadFilter();
  leafLp.type = 'lowpass'; leafLp.frequency.value = 1500; leafLp.Q.value = Q_LP;
  const leafGain = ac.createGain(); leafGain.gain.value = 0.0;
  leafSrc.connect(leafBp); leafBp.connect(leafLp); leafLp.connect(leafGain);
  leafGain.connect(busAmb);
  leafSrc.start(t0);

  // PAD — five voices, detune <= 5 cents so nothing beats audibly
  const padFilter = ac.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = cfg().padCut; padFilter.Q.value = Q_LP;
  const padGain = ac.createGain(); padGain.gain.value = 0;
  padFilter.connect(padGain); padGain.connect(busMusic);
  const padSend = send(padGain, 0.35);
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
  padGain.gain.linearRampToValueAtTime(cfg().padGain, t0 + (offline ? 2.5 : 8));

  /* ================================================================ *
   * SCORE — sparse, free-rhythm, deterministic
   * ================================================================ */
  const S = {
    koto: t0 + (offline ? 1.6 : 5),
    flute: t0 + (offline ? 5.5 : 16),
    water: t0 + (offline ? 3.2 : 9),
    bell: t0 + (offline ? 9.0 : 40),
    pad: t0 + (offline ? 12 : 26),
    bird: t0 + 6,
    cricket: t0 + 3,
    sfx: t0 + (offline ? 4.5 : 1e9),   // only the offline audition plays fake SFX
  };
  let scale = SCALES[cfg().scale];
  let melody = 2;

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

  function kotoPhrase(when) {
    const c = cfg();
    scale = SCALES[c.scale];
    // 1-3 notes, then a long rest: Ma is the point
    const notes = rKoto() < 0.52 ? 1 : (rKoto() < 0.78 ? 2 : 3);
    let t = when;
    const lvl = c.kotoLevel * lerp(0.86, 1.06, stage / 5);
    for (let i = 0; i < notes; i++) {
      const stepDir = rKoto() < 0.5 ? -1 : 1;
      melody = (melody + stepDir * (rKoto() < 0.24 ? 2 : 1) + scale.length * 4) % scale.length;
      const oct = rKoto() < 0.22 ? -12 : 0;
      pluck(t, c.root + scale[melody] + oct, lvl * (i === 0 ? 1 : 0.78));
      t += 1.1 + rKoto() * 1.6;
    }
    // an occasional low open string underneath
    if (rKoto() < 0.30) pluck(when + 0.35, c.root - 12 + scale[0], c.kotoLevel * 0.7);
    return Math.max(t - when, 1.0) + gap(rKoto, c.kotoGap) * lerp(1.15, 0.85, stage / 5);
  }

  function fluteNote(when) {
    const c = cfg();
    const sc = SCALES[c.scale];
    const deg = Math.floor(rFlute() * sc.length);
    const dur = 2.6 + rFlute() * 3.2;
    flute(when, c.root + 12 + sc[deg], dur, 0.105 * lerp(0.9, 1.1, stage / 5));
    // sometimes a second, lower answering tone after a breath
    if (rFlute() < 0.35) {
      flute(when + dur + 1.0 + rFlute() * 1.4, c.root + 12 + sc[(deg + 3) % sc.length],
        2.0 + rFlute() * 2.0, 0.075);
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

  function padEvent(when) {
    const c = cfg();
    const sc = SCALES[c.scale];
    const shift = sc[Math.floor(rPad() * sc.length)];
    for (let i = 0; i < padVoices.length; i++) {
      const v = padVoices[i];
      v.osc.frequency.setTargetAtTime(mtof(c.padRoot + snap(shift + v.interval, sc)), when, 3.5);
    }
    padGain.gain.setTargetAtTime(c.padGain * lerp(0.9, 1.12, stage / 5), when, 4.0);
    padFilter.frequency.setTargetAtTime(c.padCut, when, 5.0);
    return 20 + rPad() * 18;
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
      g.gain.linearRampToValueAtTime(0.011 * (0.7 + rBird() * 0.5), tt + 0.016);
      g.gain.setTargetAtTime(0.0001, tt + 0.02, 0.03);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = Q_LP;
      o.connect(g); g.connect(lp); lp.connect(busAmb);
      const s = send(lp, 0.55);
      o.start(tt); o.stop(tt + 0.3);
      keep(tt + 0.4, [o, g, lp, s]);
    }
    return 10 + rBird() * 16;
  }

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
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 14;
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
    switch (id) {
      case 'shake':
      case 'click':
        rustle(when, 0.22 + rSfx() * 0.10, 0.075 * g, 780 + rSfx() * 220, 0.55);
        tok(when + 0.006, 165 + rSfx() * 30, 0.13, 0.105 * g, 0.55);
        break;
      case 'crit':
        pluck(when, c.root + 12 + sc[2] - 12, 0.22 * g, busSfx);
        chime(when + 0.02, c.root + 19, 0.06 * g, 1.3);
        break;
      case 'purchase':
        tok(when, 190, 0.11, 0.07 * g, 0.6);
        pluck(when + 0.01, c.root + sc[0], 0.20 * g, busSfx);
        break;
      case 'upgrade':
        pluck(when, c.root + sc[0], 0.20 * g, busSfx);
        pluck(when + 0.16, c.root + sc[3], 0.17 * g, busSfx);
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
        for (let i = 0; i < 4; i++) {
          pluck(when + 0.5 + i * 0.34, c.root + sc[i % sc.length] - (i > 2 ? 12 : 0), 0.24 * g, busSfx);
        }
        flute(when + 0.8, c.root + 12 + sc[2], 4.5, 0.11 * g);
        padGain.gain.cancelScheduledValues(when);
        padGain.gain.setTargetAtTime(cfg().padGain * 2.0, when + 0.1, 0.7);
        padGain.gain.setTargetAtTime(cfg().padGain, when + 4.0, 2.5);
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
  if (!on('pad')) padGain.gain.cancelScheduledValues(t0), padGain.gain.setValueAtTime(0, t0);
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
    const leaf = (0.004 + 0.020 * Math.pow(w, 2.0)) * c.windGain;
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
