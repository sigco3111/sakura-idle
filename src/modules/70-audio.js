import { WIND } from '../lib/wind.js';
import { makeRng } from '../lib/rng.js';

/**
 * 70-audio — the whole soundtrack, synthesised in WebAudio. No files, no
 * network, nothing but oscillators, noise buffers and filters (CONTRACT.md 1).
 *
 * Layers
 *   AMBIENT  wind noise whose band and level track the shared WIND gust value,
 *            a water shimmer, dawn/day birdsong and night crickets.
 *   MUSIC    a generative pentatonic bed: a Karplus-Strong plucked koto voice, a
 *            slow breathing pad and a taiko for stage-ups. Mode, root, tempo and
 *            density are driven by `time:phase` and `bloom:stage`, and every
 *            phrase is drawn from a seeded RNG walk, so it evolves and never
 *            loops audibly.
 *   SFX      shake (leaf rustle + wooden tok), crit chime, purchase, upgrade,
 *            achievement, stage-up swell, Golden Petal sparkle.
 *
 * Everything runs through a master limiter. Browsers block audio before a user
 * gesture, so the graph is not even built until the first pointer/key event.
 *
 * SHOT MODE. `ctx.shotMode` short-circuits setup entirely: no AudioContext, no
 * listeners, no per-frame work, no allocation. The screenshot harness is
 * unaffected and `ctx.assets.audio` still exists as a no-op.
 *
 * Published: ctx.assets.audio = {
 *   setMuted(b), setVolume(v), play(id, opts), get unlocked(), get muted(),
 *   get volume(), setMusicVolume(v), setAmbientVolume(v), setSfxVolume(v)
 * }
 * Consumes: 'sfx' {id,gain,pan}, tree:clicked, petals:gain, upgrade:bought,
 *           bloom:stage, time:phase, vfx:golden.
 */

/* ------------------------------------------------------------------ *
 * Scales. Japanese pentatonic modes as semitone offsets from the root.
 * ------------------------------------------------------------------ */
const MODES = {
  // bright, open — daytime
  ryo: [0, 2, 4, 7, 9],
  // "kumoi" — dawn, wistful but not dark
  kumoi: [0, 2, 3, 7, 9],
  // "hirajoshi" — dusk, the classic koto tuning
  hirajoshi: [0, 2, 3, 7, 8],
  // "in" / miyako-bushi — night, half-step colour
  in: [0, 1, 5, 7, 8],
};

const PHASE_MUSIC = {
  dawn: { mode: 'kumoi', root: 62, density: 0.42, padGain: 0.16, tempo: 1.05 },
  day: { mode: 'ryo', root: 64, density: 0.62, padGain: 0.12, tempo: 1.25 },
  dusk: { mode: 'hirajoshi', root: 59, density: 0.50, padGain: 0.20, tempo: 0.95 },
  night: { mode: 'in', root: 57, density: 0.30, padGain: 0.24, tempo: 0.78 },
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export default {
  name: 'audio',
  order: 70,

  async setup(ctx) {
    /* ---- shot mode: a no-op stub, zero cost ------------------------ */
    if (ctx.shotMode) {
      ctx.assets.audio = {
        setMuted() {}, setVolume() {}, play() {},
        setMusicVolume() {}, setAmbientVolume() {}, setSfxVolume() {},
        get unlocked() { return false; }, get muted() { return true; },
        get volume() { return 0; },
      };
      return {};
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    const rng = makeRng(0x50FA);
    const r = rng.next;

    let ac = null;                 // AudioContext, built on first gesture
    let unlocked = false;
    let muted = false;
    let masterVol = 0.72;
    let musicVol = 0.55, ambientVol = 0.60, sfxVol = 0.85;

    let master, limiter, busMusic, busAmb, busSfx, verb, verbSend;
    let noiseBuf = null, brownBuf = null;
    let windSrc, windFilt, windGain, windHi, windHiGain;
    let waterSrc, waterFilt, waterGain;
    let padVoices = [];
    let padGain, padFilter;

    let phase = 'day', phaseT = 0;
    let stage = 0;
    let musicParams = PHASE_MUSIC.day;
    let targetParams = PHASE_MUSIC.day;

    // scheduler
    let nextNote = 0;              // AudioContext time of the next koto event
    let nextBird = 0, nextCricket = 0, nextPadChange = 0;
    let step = 0;
    let melodyIdx = 2;             // random walk position inside the scale
    let voices = 0;                // live plucked voices, capped

    /* ================= graph construction ================= */

    function makeNoiseBuffer(seconds, brown) {
      const n = Math.floor(ac.sampleRate * seconds);
      const b = ac.createBuffer(1, n, ac.sampleRate);
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) {
        const w = r() * 2 - 1;
        if (brown) { last = (last + 0.021 * w) / 1.021; d[i] = last * 12; }
        else d[i] = w;
      }
      return b;
    }

    /** A cheap Schroeder-ish reverb impulse: exponentially decaying noise. */
    function makeVerbImpulse(seconds, decay) {
      const n = Math.floor(ac.sampleRate * seconds);
      const b = ac.createBuffer(2, n, ac.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < n; i++) {
          d[i] = (r() * 2 - 1) * Math.pow(1 - i / n, decay);
        }
      }
      return b;
    }

    function build() {
      master = ac.createGain();
      master.gain.value = muted ? 0 : masterVol;

      limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -7;
      limiter.knee.value = 2;
      limiter.ratio.value = 18;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.22;

      master.connect(limiter);
      limiter.connect(ac.destination);

      busMusic = ac.createGain(); busMusic.gain.value = musicVol;
      busAmb = ac.createGain(); busAmb.gain.value = ambientVol;
      busSfx = ac.createGain(); busSfx.gain.value = sfxVol;
      busMusic.connect(master); busAmb.connect(master); busSfx.connect(master);

      verb = ac.createConvolver();
      verb.buffer = makeVerbImpulse(2.6, 3.2);
      verbSend = ac.createGain(); verbSend.gain.value = 0.32;
      verbSend.connect(verb); verb.connect(master);

      noiseBuf = makeNoiseBuffer(4, false);
      brownBuf = makeNoiseBuffer(4, true);

      /* ---- wind bed: brown noise through a moving bandpass ---- */
      windSrc = ac.createBufferSource();
      windSrc.buffer = brownBuf; windSrc.loop = true;
      windFilt = ac.createBiquadFilter();
      windFilt.type = 'bandpass'; windFilt.frequency.value = 420; windFilt.Q.value = 0.7;
      windGain = ac.createGain(); windGain.gain.value = 0.10;
      windSrc.connect(windFilt); windFilt.connect(windGain); windGain.connect(busAmb);
      windSrc.start();

      // a second, brighter layer that only speaks in a gust — this is the
      // "leaves hissing" component and it is what makes the gust legible
      const hiSrc = ac.createBufferSource();
      hiSrc.buffer = noiseBuf; hiSrc.loop = true;
      windHi = ac.createBiquadFilter();
      windHi.type = 'bandpass'; windHi.frequency.value = 2600; windHi.Q.value = 0.55;
      windHiGain = ac.createGain(); windHiGain.gain.value = 0.0;
      hiSrc.connect(windHi); windHi.connect(windHiGain); windHiGain.connect(busAmb);
      hiSrc.start();

      /* ---- water: narrow high shimmer, barely there ---- */
      waterSrc = ac.createBufferSource();
      waterSrc.buffer = noiseBuf; waterSrc.loop = true;
      waterFilt = ac.createBiquadFilter();
      waterFilt.type = 'bandpass'; waterFilt.frequency.value = 5200; waterFilt.Q.value = 1.6;
      waterGain = ac.createGain(); waterGain.gain.value = 0.020;
      waterSrc.connect(waterFilt); waterFilt.connect(waterGain); waterGain.connect(busAmb);
      waterSrc.start();
      // slow LFO on the water band so it laps instead of hissing
      const wLfo = ac.createOscillator(); wLfo.frequency.value = 0.13;
      const wLfoG = ac.createGain(); wLfoG.gain.value = 900;
      wLfo.connect(wLfoG); wLfoG.connect(waterFilt.frequency); wLfo.start();

      /* ---- pad: three detuned triangles through a slow lowpass ---- */
      padFilter = ac.createBiquadFilter();
      padFilter.type = 'lowpass'; padFilter.frequency.value = 900; padFilter.Q.value = 0.4;
      padGain = ac.createGain(); padGain.gain.value = 0.0;
      padFilter.connect(padGain); padGain.connect(busMusic);
      padGain.connect(verbSend);
      for (let i = 0; i < 3; i++) {
        const o = ac.createOscillator();
        o.type = i === 2 ? 'sine' : 'triangle';
        o.frequency.value = 110;
        o.detune.value = (i - 1) * 7;
        const g = ac.createGain(); g.gain.value = i === 2 ? 0.5 : 0.32;
        o.connect(g); g.connect(padFilter);
        o.start();
        padVoices.push({ osc: o, gain: g });
      }
      const pLfo = ac.createOscillator(); pLfo.frequency.value = 0.055;
      const pLfoG = ac.createGain(); pLfoG.gain.value = 260;
      pLfo.connect(pLfoG); pLfoG.connect(padFilter.frequency); pLfo.start();

      const t = ac.currentTime;
      nextNote = t + 0.6;
      nextBird = t + 2.5;
      nextCricket = t + 1.5;
      nextPadChange = t + 0.2;
    }

    /* ================= voices ================= */

    /**
     * Karplus-Strong pluck: a short noise burst driving a tuned feedback delay
     * with a one-pole lowpass in the loop. Reads as a koto / shamisen string.
     */
    function pluck(freq, when, dur, level, bright) {
      if (voices > 12) return;
      voices++;
      const delayT = 1 / Math.max(freq, 40);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const burst = ac.createGain();
      burst.gain.setValueAtTime(0, when);
      burst.gain.linearRampToValueAtTime(level, when + 0.0015);
      burst.gain.linearRampToValueAtTime(0, when + delayT * 2.2);

      const dl = ac.createDelay(0.05);
      dl.delayTime.value = delayT;
      const fb = ac.createGain();
      fb.gain.value = clamp(0.930 + 0.045 * bright, 0.80, 0.988);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(freq * (7 + 9 * bright), 700, 12000);
      lp.Q.value = 0.2;

      const body = ac.createBiquadFilter();
      body.type = 'peaking'; body.frequency.value = freq * 2.02;
      body.gain.value = 4; body.Q.value = 1.4;

      const out = ac.createGain();
      out.gain.setValueAtTime(1, when);
      out.gain.setTargetAtTime(0.0001, when + dur * 0.55, dur * 0.30);

      src.connect(burst); burst.connect(dl);
      dl.connect(lp); lp.connect(fb); fb.connect(dl);
      dl.connect(body); body.connect(out);
      out.connect(busMusic);
      const send = ac.createGain(); send.gain.value = 0.45;
      out.connect(send); send.connect(verbSend);

      src.start(when);
      const stop = when + dur + 0.4;
      src.stop(stop);
      src.onended = () => {
        voices--;
        try { src.disconnect(); burst.disconnect(); dl.disconnect(); lp.disconnect(); fb.disconnect(); body.disconnect(); out.disconnect(); send.disconnect(); } catch { /* ignore */ }
      };
    }

    /** A small FM bell — crits, golden petal, achievements. */
    function bell(freq, when, dur, level, ratio = 2.76, index = 5) {
      const car = ac.createOscillator(); car.frequency.value = freq;
      const mod = ac.createOscillator(); mod.frequency.value = freq * ratio;
      const modG = ac.createGain();
      modG.gain.setValueAtTime(freq * index, when);
      modG.gain.exponentialRampToValueAtTime(Math.max(freq * 0.05, 1), when + dur * 0.7);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(level, when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      mod.connect(modG); modG.connect(car.frequency);
      car.connect(g); g.connect(busSfx);
      const send = ac.createGain(); send.gain.value = 0.5;
      g.connect(send); send.connect(verbSend);
      mod.start(when); car.start(when);
      mod.stop(when + dur + 0.05); car.stop(when + dur + 0.05);
      car.onended = () => { try { car.disconnect(); mod.disconnect(); modG.disconnect(); g.disconnect(); send.disconnect(); } catch { /* ignore */ } };
    }

    /** A filtered noise transient — rustles, clicks, sweeps. */
    function noiseHit(when, dur, level, f0, f1, Q, type = 'bandpass', bus) {
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = type; f.Q.value = Q;
      f.frequency.setValueAtTime(f0, when);
      f.frequency.exponentialRampToValueAtTime(Math.max(f1, 40), when + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(level, when + Math.min(0.012, dur * 0.2));
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(f); f.connect(g); g.connect(bus ?? busSfx);
      src.start(when); src.stop(when + dur + 0.05);
      src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    }

    /** A pitched body hit — the wooden tok, and the taiko when big. */
    function drum(when, freq, dur, level, drop = 0.45) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, when);
      o.frequency.exponentialRampToValueAtTime(Math.max(freq * drop, 20), when + dur * 0.65);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(level, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(busSfx);
      o.start(when); o.stop(when + dur + 0.05);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    }

    /* ================= SFX table ================= */
    function sfx(id, opts = {}) {
      if (!unlocked || !ac || muted) return;
      const t = ac.currentTime + 0.005;
      const g = clamp(opts.gain ?? 1, 0, 2);
      const sc = MODES[musicParams.mode];
      const root = musicParams.root;
      switch (id) {
        case 'shake':
        case 'click': {
          // leafy rustle + a wooden tok, slightly detuned each time
          noiseHit(t, 0.20 + r() * 0.10, 0.085 * g, 2400 + r() * 900, 900, 0.8);
          drum(t + 0.004, 190 + r() * 40, 0.13, 0.16 * g, 0.55);
          break;
        }
        case 'crit': {
          drum(t, 150, 0.20, 0.20 * g, 0.4);
          bell(mtof(root + 12 + sc[2]), t + 0.01, 0.9, 0.16 * g, 2.01, 6);
          bell(mtof(root + 19 + sc[1]), t + 0.055, 0.7, 0.10 * g, 3.02, 4);
          noiseHit(t, 0.28, 0.05 * g, 6200, 2400, 1.2);
          break;
        }
        case 'purchase': {
          drum(t, 220, 0.10, 0.13 * g, 0.6);
          pluck(mtof(root + sc[0] + 12), t + 0.005, 0.7, 0.28 * g, 0.5);
          pluck(mtof(root + sc[3] + 12), t + 0.085, 0.8, 0.24 * g, 0.6);
          break;
        }
        case 'upgrade': {
          for (let i = 0; i < 3; i++) {
            pluck(mtof(root + 12 + sc[i + 1]), t + i * 0.075, 0.9, 0.26 * g, 0.7);
          }
          noiseHit(t, 0.35, 0.035 * g, 3400, 8000, 0.9, 'bandpass');
          break;
        }
        case 'achievement': {
          const seq = [0, 2, 3, 4];
          for (let i = 0; i < seq.length; i++) {
            bell(mtof(root + 12 + sc[seq[i]]), t + i * 0.10, 0.85, 0.11 * g, 2.0, 4);
          }
          break;
        }
        case 'golden':
        case 'goldenAppear': {
          const n = id === 'golden' ? 6 : 3;
          const lvl = id === 'golden' ? 0.115 : 0.055;
          for (let i = 0; i < n; i++) {
            bell(mtof(root + 24 + sc[(i * 2) % sc.length] + (i > 3 ? 12 : 0)),
              t + i * 0.055, 0.75, lvl * g, 3.51, 3.4);
          }
          if (id === 'golden') noiseHit(t, 0.5, 0.05 * g, 9000, 3000, 1.4);
          break;
        }
        case 'stageup': {
          // taiko + rising sweep + a wide chord swell
          drum(t, 92, 1.15, 0.34 * g, 0.30);
          drum(t + 0.16, 74, 1.35, 0.24 * g, 0.30);
          noiseHit(t, 1.5, 0.055 * g, 260, 5200, 0.6, 'bandpass');
          for (let i = 0; i < 5; i++) {
            pluck(mtof(root + sc[i % sc.length] + (i > 2 ? 12 : 0)), t + 0.10 + i * 0.09, 2.4, 0.30 * g, 0.85);
          }
          if (padGain) {
            padGain.gain.cancelScheduledValues(t);
            padGain.gain.setValueAtTime(padGain.gain.value, t);
            padGain.gain.linearRampToValueAtTime(targetParams.padGain * 2.6, t + 0.35);
            padGain.gain.linearRampToValueAtTime(targetParams.padGain, t + 3.2);
          }
          break;
        }
        case 'storm': {
          noiseHit(t, 2.4, 0.08 * g, 300, 1800, 0.5, 'bandpass', busAmb);
          drum(t, 68, 1.6, 0.22 * g, 0.35);
          break;
        }
        default: break;
      }
    }

    /* ================= scheduler ================= */
    const LOOKAHEAD = 0.45;

    function scheduleMusic(now) {
      const p = musicParams;
      const sc = MODES[p.mode];
      const beat = 0.62 / p.tempo;

      while (nextNote < now + LOOKAHEAD) {
        const t = nextNote;
        step++;
        // density gate: more notes by day, sparse at night, denser at high bloom
        const dens = clamp(p.density + stage * 0.045, 0.15, 0.92);
        if (r() < dens) {
          // random walk with a pull back toward the middle of the scale
          melodyIdx += (r() < 0.5 ? -1 : 1) * (r() < 0.22 ? 2 : 1);
          if (melodyIdx < 0) melodyIdx += sc.length;
          if (melodyIdx >= sc.length) melodyIdx -= sc.length;
          const oct = r() < 0.20 ? 12 : (r() < 0.12 ? -12 : 0);
          const note = p.root + 12 + sc[melodyIdx] + oct;
          const accent = (step % 8 === 0) ? 1.35 : 1;
          pluck(mtof(note), t, 1.4 + r() * 1.4, 0.16 * accent, 0.35 + r() * 0.5);
          // an occasional grace note a scale step above
          if (r() < 0.16) {
            pluck(mtof(p.root + 12 + sc[(melodyIdx + 1) % sc.length] + oct),
              t + beat * 0.28, 0.9, 0.09, 0.5);
          }
        }
        // an occasional low drone plucked on the bass string
        if (step % 16 === 0 && r() < 0.7) {
          pluck(mtof(p.root - 12 + sc[0]), t, 3.2, 0.13, 0.12);
        }
        nextNote += beat * (r() < 0.30 ? 2 : 1);
      }

      // pad chord: root + fifth-ish from the mode, re-voiced slowly
      if (now >= nextPadChange) {
        nextPadChange = now + 9 + r() * 8;
        const base = p.root - 12 + sc[Math.floor(r() * sc.length)];
        const tones = [base, base + sc[2], base + 12 + sc[1]];
        for (let i = 0; i < padVoices.length; i++) {
          padVoices[i].osc.frequency.setTargetAtTime(mtof(tones[i]), now, 2.2);
        }
        padGain.gain.setTargetAtTime(p.padGain, now, 3.0);
      }
    }

    function scheduleAmbient(now, dayNight) {
      // birds: dawn and day only, in short 2-5 note phrases
      if (now >= nextBird) {
        const active = phase === 'dawn' || phase === 'day';
        nextBird = now + (active ? 2.5 + r() * 6.0 : 12 + r() * 20);
        if (active && r() < (phase === 'dawn' ? 0.85 : 0.5)) {
          const n = 2 + Math.floor(r() * 4);
          const f0 = 2200 + r() * 1800;
          for (let i = 0; i < n; i++) {
            const o = ac.createOscillator();
            const g = ac.createGain();
            const tt = now + 0.15 + i * (0.055 + r() * 0.05);
            const f = f0 * (0.86 + r() * 0.34);
            o.type = 'sine';
            o.frequency.setValueAtTime(f, tt);
            o.frequency.exponentialRampToValueAtTime(f * (0.7 + r() * 0.8), tt + 0.05);
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.exponentialRampToValueAtTime(0.030 * (0.6 + r() * 0.6), tt + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.055 + r() * 0.05);
            o.connect(g); g.connect(busAmb);
            const s = ac.createGain(); s.gain.value = 0.6; g.connect(s); s.connect(verbSend);
            o.start(tt); o.stop(tt + 0.14);
            o.onended = () => { try { o.disconnect(); g.disconnect(); s.disconnect(); } catch { /* ignore */ } };
          }
        }
      }

      // crickets: night only, a steady stridulating pulse train
      if (now >= nextCricket) {
        const active = dayNight > 0.5;
        nextCricket = now + (active ? 0.35 + r() * 0.9 : 6 + r() * 8);
        if (active) {
          const f = 4200 + r() * 1400;
          const reps = 3 + Math.floor(r() * 3);
          for (let i = 0; i < reps; i++) {
            noiseHit(now + 0.05 + i * 0.048, 0.030, 0.022 * (0.6 + r() * 0.6), f, f, 22, 'bandpass', busAmb);
          }
        }
      }
    }

    /* ================= unlock ================= */
    function unlock() {
      if (unlocked) return;
      try {
        ac = new AC({ latencyHint: 'interactive' });
        build();
        unlocked = true;
        if (ac.state === 'suspended') ac.resume();
      } catch (e) {
        unlocked = false;
      }
      removeUnlockListeners();
    }
    const onGesture = () => unlock();
    function addUnlockListeners() {
      window.addEventListener('pointerdown', onGesture, { passive: true });
      window.addEventListener('keydown', onGesture, { passive: true });
      window.addEventListener('touchstart', onGesture, { passive: true });
    }
    function removeUnlockListeners() {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
      window.removeEventListener('touchstart', onGesture);
    }
    if (AC) addUnlockListeners();

    /* ================= events ================= */
    const offs = [];
    offs.push(ctx.bus.on('sfx', (e) => { if (e?.id) sfx(e.id, e); }));
    offs.push(ctx.bus.on('tree:clicked', () => sfx('shake', { gain: 0.9 })));
    offs.push(ctx.bus.on('petals:gain', (e) => { if (e?.crit) sfx('crit'); }));
    offs.push(ctx.bus.on('upgrade:bought', (e) => sfx((e?.tier ?? 0) >= 2 ? 'upgrade' : 'purchase')));
    offs.push(ctx.bus.on('vfx:golden', () => sfx('golden')));
    let lastStage = -1;
    offs.push(ctx.bus.on('bloom:stage', (e) => {
      const s = Number(e?.stage);
      if (!Number.isFinite(s)) return;
      if (lastStage >= 0 && s > lastStage) sfx('stageup');
      lastStage = s; stage = s;
    }));
    offs.push(ctx.bus.on('time:phase', (e) => {
      if (!e?.phase) return;
      phase = e.phase; phaseT = e.t ?? 0;
      targetParams = PHASE_MUSIC[phase] ?? PHASE_MUSIC.day;
    }));

    /* ================= public API ================= */
    ctx.assets.audio = {
      setMuted(m) {
        muted = !!m;
        if (master && ac) master.gain.setTargetAtTime(muted ? 0 : masterVol, ac.currentTime, 0.06);
      },
      setVolume(v) {
        masterVol = clamp(Number(v) || 0, 0, 1);
        if (master && ac && !muted) master.gain.setTargetAtTime(masterVol, ac.currentTime, 0.06);
      },
      setMusicVolume(v) { musicVol = clamp(v, 0, 1); if (busMusic && ac) busMusic.gain.setTargetAtTime(musicVol, ac.currentTime, 0.1); },
      setAmbientVolume(v) { ambientVol = clamp(v, 0, 1); if (busAmb && ac) busAmb.gain.setTargetAtTime(ambientVol, ac.currentTime, 0.1); },
      setSfxVolume(v) { sfxVol = clamp(v, 0, 1); if (busSfx && ac) busSfx.gain.setTargetAtTime(sfxVol, ac.currentTime, 0.1); },
      play(id, opts) { sfx(id, opts ?? {}); },
      unlock,
      get unlocked() { return unlocked; },
      get muted() { return muted; },
      get volume() { return masterVol; },
      get context() { return ac; },
    };

    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      window.__game.scenarios['audio-mute'] = () => ctx.assets.audio.setMuted(true);
      window.__game.scenarios['audio-unmute'] = () => ctx.assets.audio.setMuted(false);
    }

    /* ================= per-frame ================= */
    // Smoothed parameter targets so a phase change is a fade, not a jump.
    let smDensity = musicParams.density, smTempo = musicParams.tempo,
      smPad = musicParams.padGain, smRoot = musicParams.root;
    let modeName = musicParams.mode;
    const live = { mode: modeName, root: smRoot, density: smDensity, padGain: smPad, tempo: smTempo };
    musicParams = live;

    let acc = 0;

    return {
      update(dt) {
        if (!unlocked || !ac) return;
        // the scheduler only needs to run a few times a second
        acc += dt;
        if (acc < 0.08) return;
        acc = 0;
        const now = ac.currentTime;

        // --- ambience follows the shared wind field
        const gust = WIND?.uniforms?.uWindGust?.value ?? 0;
        const strength = WIND?.uniforms?.uWindStrength?.value ?? 1;
        const w = clamp(gust * strength, 0, 2);
        if (windGain) {
          windGain.gain.setTargetAtTime(0.055 + 0.16 * w, now, 0.35);
          windFilt.frequency.setTargetAtTime(320 + 520 * w, now, 0.5);
          windHiGain.gain.setTargetAtTime(0.006 + 0.052 * Math.pow(w, 1.8), now, 0.30);
          windHi.frequency.setTargetAtTime(2200 + 1900 * w, now, 0.45);
        }

        // --- musical parameters ease toward the current phase
        const k = 0.035;
        smDensity += (targetParams.density - smDensity) * k;
        smTempo += (targetParams.tempo - smTempo) * k;
        smPad += (targetParams.padGain - smPad) * k;
        smRoot += (targetParams.root - smRoot) * k * 0.6;
        // the MODE snaps (a half-morphed pentatonic is just wrong notes), but
        // only at a phrase boundary so it never lands mid-figure
        if (targetParams.mode !== modeName && step % 8 === 0) modeName = targetParams.mode;
        live.mode = modeName;
        live.density = smDensity; live.tempo = smTempo;
        live.padGain = smPad; live.root = Math.round(smRoot);

        const dayNight = phase === 'night' ? 1 : (phase === 'dusk' && phaseT > 0.7 ? 0.6 : 0);
        scheduleMusic(now);
        scheduleAmbient(now, dayNight);
      },

      dispose() {
        for (const o of offs) { try { o?.(); } catch { /* ignore */ } }
        removeUnlockListeners();
        try { ac?.close(); } catch { /* ignore */ }
        ctx.assets.audio = null;
      },
    };
  },
};
