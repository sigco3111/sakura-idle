/**
 * Player settings — scaffold-owned single source of truth. Do not fork this.
 *
 * Deliberately stored under its OWN localStorage key, separate from the save
 * game: a player who hard-resets their progress must not lose their audio and
 * accessibility preferences, and a corrupt save must not be able to trap someone
 * with motion effects they cannot tolerate.
 *
 * Usage from a module:
 *   import { SETTINGS } from '../lib/settings.js';
 *   if (SETTINGS.motion.shake) applyKick();          // read
 *   gain.gain.value = SETTINGS.musicGain();          // read a derived value
 *   SETTINGS.on('change', ({ key }) => { ... });     // react live
 *
 * Every consumer must react to changes immediately — a settings toggle that only
 * takes effect after a reload is a bug, especially for a motion setting someone
 * is turning off because it is making them feel unwell.
 */

const KEY = 'sakura.settings.v1';

/** `prefers-reduced-motion: reduce` is a real accessibility signal — honour it as
 *  the DEFAULT for motion effects rather than making people find the toggle after
 *  the damage is done. They can still switch effects back on explicitly. */
function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; }
  catch { return false; }
}

function defaults() {
  const rm = prefersReducedMotion();
  return {
    // ---- audio ----
    masterVolume: 0.5,      // 0..1, conservative so it never blasts on first load
    musicVolume: 0.7,       // 0..1, relative to master
    sfxVolume: 0.8,         // 0..1, relative to master
    muteAll: false,
    muteMusic: false,
    muteSfx: false,
    // ---- motion / accessibility ----
    screenShake: !rm,       // camera kick + screen shake on click, crit and stage-up
    cameraDrift: !rm,       // slow idle breathing drift and pointer parallax
    petalBursts: true,      // click petal bursts (kept separate: this is the game's core feedback)
    flashes: !rm,           // bright full-screen flashes on crit / stage-up
    // ---- misc ----
    reducedMotion: rm,      // convenience mirror; setting it true forces the motion flags off
  };
}

const NUMERIC = new Set(['masterVolume', 'musicVolume', 'sfxVolume']);
const BOOL = new Set(['muteAll', 'muteMusic', 'muteSfx', 'screenShake', 'cameraDrift',
  'petalBursts', 'flashes', 'reducedMotion']);

const clamp01 = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);

class Settings {
  constructor() {
    this._v = defaults();
    this._listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const [k, val] of Object.entries(saved ?? {})) {
        if (NUMERIC.has(k)) this._v[k] = clamp01(val);
        else if (BOOL.has(k)) this._v[k] = !!val;
        // unknown keys from a future version are dropped, not merged
      }
    } catch { /* corrupt settings must never block boot */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this._v)); } catch { /* private mode */ }
  }

  get all() { return { ...this._v }; }
  get(key) { return this._v[key]; }

  /** Set one setting, persist, and notify. Returns the coerced value. */
  set(key, value) {
    if (!NUMERIC.has(key) && !BOOL.has(key)) return undefined;
    const v = NUMERIC.has(key) ? clamp01(value) : !!value;
    if (this._v[key] === v) return v;
    this._v[key] = v;

    // reducedMotion is a convenience master switch over the motion flags
    if (key === 'reducedMotion') {
      this._v.screenShake = !v;
      this._v.cameraDrift = !v;
      this._v.flashes = !v;
    } else if (v && (key === 'screenShake' || key === 'cameraDrift' || key === 'flashes')) {
      // turning any motion effect back on means they are not in reduced-motion mode
      this._v.reducedMotion = false;
    }

    this.save();
    this._emit({ key, value: v, all: this.all });
    return v;
  }

  /** Bulk update (e.g. from a settings panel applying several at once). */
  patch(obj) {
    let changed = false;
    for (const [k, val] of Object.entries(obj ?? {})) {
      const before = this._v[k];
      this.set(k, val);
      if (this._v[k] !== before) changed = true;
    }
    return changed;
  }

  reset() {
    this._v = defaults();
    this.save();
    this._emit({ key: '*', value: null, all: this.all });
  }

  on(_evt, fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  off(_evt, fn) { this._listeners.delete(fn); }
  _emit(payload) {
    for (const fn of this._listeners) { try { fn(payload); } catch (e) { console.error('[settings]', e); } }
  }

  /* ---------------- derived values consumers should prefer ---------------- */

  /** Linear gain for the music bus, 0 when muted. */
  musicGain() {
    if (this._v.muteAll || this._v.muteMusic) return 0;
    return this._v.masterVolume * this._v.musicVolume;
  }

  /** Linear gain for the SFX bus, 0 when muted. */
  sfxGain() {
    if (this._v.muteAll || this._v.muteSfx) return 0;
    return this._v.masterVolume * this._v.sfxVolume;
  }

  /** Motion gates. Read these instead of the raw flags so reducedMotion is always respected. */
  get motion() {
    const rm = this._v.reducedMotion;
    return {
      shake: !rm && this._v.screenShake,
      drift: !rm && this._v.cameraDrift,
      flashes: !rm && this._v.flashes,
      bursts: this._v.petalBursts,
      /** Multiplier callers can apply to any shake/kick amplitude. */
      shakeScale: (!rm && this._v.screenShake) ? 1 : 0,
    };
  }
}

export const SETTINGS = new Settings();
export const SETTINGS_KEY = KEY;
