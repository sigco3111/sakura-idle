import { WIND } from '../lib/wind.js';
import { buildGraph, renderGraphOffline } from '../lib/audio-graph.js';

/**
 * 70-audio — Japanese zen ambient, synthesised in WebAudio. No files, no
 * network (CONTRACT.md rule 1).
 *
 * All of the sound design lives in `src/lib/audio-graph.js`; this module is the
 * thin part: the user-gesture unlock, the event wiring, the per-frame scheduler
 * pump, and the offline render hook.
 *
 * LIVE and OFFLINE are the same graph. `buildGraph(ac, opts)` is handed either
 * a real AudioContext or an OfflineAudioContext, so what the audio harness
 * measures (`tools/audio.mjs`) is literally what a player hears.
 *
 * COMFORT FIRST. The complaint that produced this rewrite was "screeching
 * noises, hurts my ears", so every layer is lowpassed at the source, the koto's
 * Karplus-Strong loop is heavily damped, the master bus tilts everything above
 * 2.2 kHz down by 6 dB before two cascaded lowpasses at 3.4/3.8 kHz, and a
 * soft-knee compressor sits in front of the master gain. Too quiet and too sparse is the
 * intended failure direction.
 *
 * SHOT MODE. `ctx.shotMode` means no AudioContext, no listeners, no per-frame
 * work and no allocation — but `renderOffline()` still works, because it builds
 * its own OfflineAudioContext and never touches live state.
 *
 * Published: ctx.assets.audio = {
 *   setMuted(b), setVolume(v), get unlocked, get muted, get volume,
 *   play(id, opts), unlock(), renderOffline(seconds, { phase, stage, sampleRate })
 * }
 * Consumes: 'sfx' {id,gain}, tree:clicked, petals:gain, upgrade:bought,
 *           bloom:stage, time:phase, vfx:golden.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Shared by every entry point, so shot mode and live mode audition the same score. */
function offlineRenderer() {
  return (seconds, opts = {}) => renderGraphOffline(seconds, opts);
}

export default {
  name: 'audio',
  order: 70,

  async setup(ctx) {
    /* ---- shot mode: silent, allocation-free, but still auditionable ---- */
    if (ctx.shotMode) {
      ctx.assets.audio = {
        setMuted() {}, setVolume() {}, play() {}, unlock() {},
        setMusicVolume() {}, setAmbientVolume() {}, setSfxVolume() {},
        get unlocked() { return false; },
        get muted() { return true; },
        get volume() { return 0; },
        renderOffline: offlineRenderer(),
      };
      return {};
    }

    const AC = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext) : null;

    let ac = null;
    let graph = null;
    let unlocked = false;
    let muted = false;
    let volume = 0.5;               // conservative default — never blast on load

    let phase = 'day';
    let stage = 0;
    let lastStage = -1;

    /* ================= unlock (browsers block pre-gesture audio) ======= */
    function unlock() {
      if (unlocked || !AC) return;
      try {
        ac = new AC({ latencyHint: 'interactive' });
        graph = buildGraph(ac, {
          phase, stage, offline: false, volume, muted, seed: 0x5A12CE,
        });
        graph.setWind(WIND?.gust ?? 0, ac.currentTime, 0.01);
        unlocked = true;
        if (ac.state === 'suspended') ac.resume();
      } catch {
        ac = null; graph = null; unlocked = false;
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
    function fire(id, gain = 1) {
      if (!unlocked || !graph || muted) return;
      graph.sfx(id, ac.currentTime + 0.02, { gain });
    }

    const offs = [];
    const on = (evt, fn) => { try { offs.push(ctx.bus?.on(evt, fn)); } catch { /* no bus */ } };

    on('sfx', (e) => { if (e?.id) fire(e.id, e.gain ?? 1); });
    on('tree:clicked', () => fire('shake', 0.85));
    on('petals:gain', (e) => { if (e?.crit) fire('crit', 0.9); });
    on('upgrade:bought', (e) => fire((e?.tier ?? 0) >= 2 ? 'upgrade' : 'purchase', 0.9));
    on('vfx:golden', () => fire('golden', 0.9));
    on('bloom:stage', (e) => {
      const s = Number(e?.stage);
      if (!Number.isFinite(s)) return;
      if (lastStage >= 0 && s > lastStage) fire('stageup', 1);
      lastStage = s;
      stage = clamp(s, 0, 5);
      graph?.setPhase(phase, stage);
    });
    on('time:phase', (e) => {
      if (!e?.phase) return;
      phase = e.phase;
      graph?.setPhase(phase, stage);
    });

    /* ================= public api ================= */
    ctx.assets.audio = {
      setMuted(m) {
        muted = !!m;
        graph?.setMuted(muted, ac?.currentTime ?? 0);
      },
      setVolume(v) {
        volume = clamp(Number(v) || 0, 0, 1);
        graph?.setVolume(volume, ac?.currentTime ?? 0);
      },
      // kept for callers that want stems; the buses exist either way
      setMusicVolume(v) { if (graph) graph.busMusic.gain.setTargetAtTime(clamp(v, 0, 1), ac.currentTime, 0.15); },
      setAmbientVolume(v) { if (graph) graph.busAmb.gain.setTargetAtTime(clamp(v, 0, 1), ac.currentTime, 0.15); },
      setSfxVolume(v) { if (graph) graph.busSfx.gain.setTargetAtTime(clamp(v, 0, 1), ac.currentTime, 0.15); },
      play(id, opts) { fire(id, opts?.gain ?? 1); },
      unlock,
      renderOffline: offlineRenderer(),
      get unlocked() { return unlocked; },
      get muted() { return muted; },
      get volume() { return volume; },
      get context() { return ac; },
      /** Live voice count — how you check the graph is not growing without bound. */
      get voices() { return graph ? graph.voices : 0; },
    };

    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      window.__game.scenarios['audio-mute'] = () => ctx.assets.audio.setMuted(true);
      window.__game.scenarios['audio-unmute'] = () => ctx.assets.audio.setMuted(false);
    }

    /* ================= per-frame pump ================= */
    // The scheduler only has to run a few times a second, and it allocates
    // nothing: note voices are built at note time (every few seconds) and their
    // nodes are disconnected by graph.reap() once they have rung out.
    const LOOKAHEAD = 0.6;
    let acc = 0;

    return {
      update(dt) {
        if (!unlocked || !graph) return;
        acc += dt;
        if (acc < 0.1) return;
        acc = 0;
        const now = ac.currentTime;
        graph.setWind(WIND?.gust ?? 0, now, 0.7);
        graph.scheduleWindow(now, now + LOOKAHEAD);
        graph.reap(now);
      },

      dispose() {
        for (const o of offs) { try { o?.(); } catch { /* ignore */ } }
        removeUnlockListeners();
        try { ac?.close(); } catch { /* ignore */ }
        ac = null; graph = null;
        if (ctx.assets) ctx.assets.audio = null;
      },
    };
  },
};
