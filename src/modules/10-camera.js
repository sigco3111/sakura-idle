import * as THREE from 'three';
import { CAMERA_PRESETS, applyPreset } from '../core/cameras.js';
import { WIND } from '../lib/wind.js';
import { SETTINGS } from '../lib/settings.js';

/**
 * 10-camera — the camera rig. ART_BIBLE section 6: "Camera: slow idle breathing
 * drift (<= 0.4 deg amplitude, ~14 s period) plus parallax on pointer. Never a
 * locked-off camera."
 *
 * The rig never owns the framing — `src/core/cameras.js` does. It anchors to a
 * preset and adds a strictly bounded offset on top:
 *
 *   breathing   3 incommensurate sines, <= 0.40 deg yaw / 0.26 deg pitch /
 *               0.10 deg roll, periods 14.0 / 19.4 / 23.6 s, plus a 55 mm
 *               positional bob and a wind-coupled micro-shudder
 *   parallax    <= 0.17 m of lateral dolly toward the pointer, critically
 *               damped (tau 0.55 s), zero when the pointer is centred
 *   kick        an underdamped spring impulse (crits, heavy shakes)
 *   push-in     an attack/hold/release dolly + FOV squeeze for stage-ups
 *
 * ACCESSIBILITY — the reason the "never a locked-off camera" rule has an
 * exception. Camera movement is a vestibular trigger; for some people it causes
 * real nausea. So every source of motion here is gated on the shared settings
 * store, read LIVE (never cached into a local flag):
 *
 *   SETTINGS.motion.drift  -> breathing + bob + wind shudder + pointer parallax
 *   SETTINGS.motion.shake  -> crit kick, sustained shake, stage-up push-in,
 *                             amplitude multiplied by SETTINGS.motion.shakeScale
 *
 * Two properties matter more than the effects themselves:
 *
 *  1. OFF MEANS OFF. With drift disabled the camera sits on the active preset
 *     *exactly* — bit-identical position/quaternion/fov every frame. Every
 *     contribution is multiplied by a blend that reaches exactly 0, the parallax
 *     and spring accumulators are hard-zeroed once it does, and the springs snap
 *     to zero inside a deadzone instead of decaying asymptotically forever. A
 *     camera that still creeps by a thousandth of a degree is precisely what a
 *     motion-sensitive player notices.
 *  2. TURNING IT OFF IS NOT ITSELF A LURCH. A hard snap back to the preset is a
 *     jarring movement — the exact thing being switched off. So the blend eases
 *     over MOTION_EASE seconds (smoothstep, zero velocity at both ends) in both
 *     directions. At boot the blend starts already at its target, so a player who
 *     has motion disabled never sees a single frame of it.
 *
 * DETERMINISM. Under the screenshot harness the springs are held at zero and
 * parallax is off, so the only motion is the breathing term — which is a pure
 * function of `ctx.time` and therefore byte-reproducible for a given --warm.
 * Its amplitude is scaled to SHOT_DRIFT (0.30) there, i.e. <= 0.12 deg, ~3.6 px
 * at the hero framing: enough that a motion strip shows camera life, small
 * enough that no critic can attribute a composition change to the rig. Full
 * amplitude in shot mode is one scenario away: `camera-live`. The settings blends
 * are initialised at their target and advance by a fixed dt under `warm()`, so
 * gating adds no non-determinism.
 *
 * Published: ctx.assets.cameraRig = {
 *   kick(strength, opts), pushIn(amount, hold), shake(strength, seconds),
 *   reanchor(preset), setEnabled(on), setParallax(on),
 *   base, preset, offsetDeg, motion
 * }
 * Consumes: 'camera:preset', 'bloom:stage' (push-in), 'petals:gain' (crit kick).
 */

const SHOT_DRIFT = 0.30;

// ART_BIBLE caps the idle drift at 0.4 deg. These are the amplitudes in radians.
const D2R = Math.PI / 180;
const BREATHE = {
  yaw: 0.40 * D2R, yawT: 14.0,
  pitch: 0.26 * D2R, pitchT: 19.4,
  roll: 0.10 * D2R, rollT: 23.6,
  bobY: 0.055, bobYT: 16.8,
  bobX: 0.045, bobXT: 21.3,
};

const PARALLAX = { x: 0.17, y: 0.10, yaw: 0.16 * D2R, tau: 0.55 };

/** Seconds to cross-fade a motion category on or off when the player toggles it. */
const MOTION_EASE = 0.40;
/** Below this the springs are snapped to exact zero rather than left decaying. */
const DEADZONE = 1e-7;

/** smoothstep — exactly 0 at 0 and exactly 1 at 1, zero velocity at both ends. */
const smooth = (s) => s * s * (3 - 2 * s);

export default {
  name: 'camera',
  order: 10,

  async setup(ctx) {
    const cam = ctx.camera;
    if (!cam) return {};

    /* ---- the anchor: a throwaway camera we run applyPreset() on, so the rig's
            idea of "the preset" is byte-identical to the harness's. ---------- */
    const anchorCam = new THREE.PerspectiveCamera();
    const base = {
      name: 'hero',
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      fov: 36,
    };

    // transient state
    const kickPos = new THREE.Vector3();
    const kickVel = new THREE.Vector3();
    const kickRot = new THREE.Vector3();      // (pitch, yaw, roll) radians
    const kickRotVel = new THREE.Vector3();
    let parX = 0, parY = 0, parYaw = 0;
    let shakeAmt = 0, shakeDecay = 1;
    // push-in envelope
    let pushAmt = 0, pushTarget = 0, pushHold = 0, pushRelease = 1.6;

    let enabled = true;
    let parallaxOn = !ctx.shotMode;
    let driftScale = ctx.shotMode ? SHOT_DRIFT : 1;

    /* ---- accessibility blends -----------------------------------------------
       `*Lin` is the linear 0..1 ease progress, `*Gain` the smoothstepped value
       actually multiplied into the offsets. Both start AT their target so a
       player with motion off gets a still camera from frame one. `shakeHeld`
       remembers the last active shakeScale so switching shake off eases out at
       the amplitude it was running at instead of collapsing instantly. */
    let driftLin = SETTINGS.motion.drift ? 1 : 0;
    let driftGain = driftLin;
    let shakeLin = SETTINGS.motion.shake ? 1 : 0;
    let shakeHeld = SETTINGS.motion.shakeScale || 1;
    let shakeGain = shakeLin * shakeHeld;

    /** Jump both toggle blends to their target, skipping the 400 ms ease. Used at
     *  boot (implicitly, via the initialisers above) and by the debug scenarios so
     *  a measurement does not have to warm through the cross-fade. */
    function settleBlends() {
      const m = SETTINGS.motion;
      driftLin = m.drift ? 1 : 0;
      driftGain = driftLin;
      if (!driftLin) parX = parY = parYaw = 0;
      shakeLin = (m.shake && m.shakeScale > 0) ? 1 : 0;
      if (shakeLin) shakeHeld = m.shakeScale;
      shakeGain = shakeLin ? shakeHeld : 0;
    }

    // scratch
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const qOff = new THREE.Quaternion();
    const eOff = new THREE.Euler();
    const tmp = new THREE.Vector3();

    /** Zero the shake family only — leaves the pointer-parallax accumulator alone,
     *  so disabling shake cannot yank a live parallax offset back to centre. */
    function clearShakeTransient() {
      kickPos.set(0, 0, 0); kickVel.set(0, 0, 0);
      kickRot.set(0, 0, 0); kickRotVel.set(0, 0, 0);
      shakeAmt = 0;
      pushAmt = 0; pushTarget = 0; pushHold = 0;
    }

    function clearTransient() {
      clearShakeTransient();
      parX = parY = parYaw = 0;
    }

    function reanchor(name) {
      const key = CAMERA_PRESETS[name] ? name : 'hero';
      applyPreset(anchorCam, key);
      base.name = key;
      base.pos.copy(anchorCam.position);
      base.quat.copy(anchorCam.quaternion);
      base.fov = anchorCam.fov;
      // A preset change is a hard cut (the harness re-frames between shots) —
      // never let a spring swing through it.
      clearTransient();
    }
    reanchor('hero');

    ctx.bus.on('camera:preset', (p) => reanchor(typeof p === 'string' ? p : p?.preset));

    /* ---- impulses ----------------------------------------------------
       Every impulse is refused outright when screen shake is off, so a module
       that forgets to check (45-vfx, 60-game, anything future) still cannot
       move a motion-sensitive player's camera. Amplitude scaling by
       SETTINGS.motion.shakeScale happens at compose time, not here, so dragging
       the slider rescales a kick that is already in flight. */

    const shakeAllowed = () => {
      const m = SETTINGS.motion;
      return m.shake && m.shakeScale > 0;
    };

    /**
     * A snappy recoil. `strength` 1 = a crit-sized hit.
     * opts.dir is an optional world direction the hit came FROM.
     */
    function kick(strength = 1, opts) {
      if (ctx.shotMode && !(typeof window !== "undefined" && window.__vfxLiveCam)) return;
      if (!shakeAllowed()) return;
      const s = THREE.MathUtils.clamp(Number(strength) || 0, 0, 3);
      if (s <= 0) return;
      // rotational recoil: mostly pitch-up with a little yaw so it never looks
      // like a mechanical elevator.
      const sign = opts?.sign ?? 1;
      kickRotVel.x += 0.85 * s * D2R * 62;
      kickRotVel.y += sign * 0.42 * s * D2R * 62;
      kickRotVel.z += sign * 0.22 * s * D2R * 62;
      // and a short dolly back along the view direction
      kickVel.z += -0.55 * s;
      kickVel.y += 0.16 * s;
    }

    /** Sustained high-frequency shake (storms, stage-up impact). */
    function shake(strength = 0.5, seconds = 0.6) {
      if (ctx.shotMode && !(typeof window !== "undefined" && window.__vfxLiveCam)) return;
      if (!shakeAllowed()) return;
      shakeAmt = Math.max(shakeAmt, THREE.MathUtils.clamp(strength, 0, 1));
      shakeDecay = 1 / Math.max(0.08, seconds);
    }

    /** The stage-up push: dolly in + FOV squeeze, attack / hold / release. */
    function pushIn(amount = 1, hold = 1.1) {
      if (ctx.shotMode && !(typeof window !== "undefined" && window.__vfxLiveCam)) return;
      if (!shakeAllowed()) return;
      pushTarget = THREE.MathUtils.clamp(amount, 0, 1.5);
      pushHold = Math.max(0.1, hold);
      pushRelease = 1.9;
    }

    ctx.bus.on('bloom:stage', (e) => {
      const s = Number(e?.stage);
      if (!Number.isFinite(s)) return;
      pushIn(0.85, 1.3);
      shake(0.35, 0.9);
    });
    ctx.bus.on('petals:gain', (e) => { if (e?.crit) kick(0.9, { sign: -1 }); });

    /* ---- live settings ------------------------------------------------
       Re-apply on the spot: a motion setting that waits for the next frame is
       already too slow in shot mode (no RAF loop) and reads as broken anywhere. */
    const offSettings = SETTINGS.on('change', () => {
      // dt 0 => blends hold, springs do not integrate; this only re-composes the
      // camera so the new gate/scale is reflected without waiting for a frame.
      try { update(0, ctx.time); } catch { /* never let a settings toggle throw */ }
    });

    /* ---- debug scenarios --------------------------------------------- */
    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      const sc = window.__game.scenarios;
      sc['camera-live'] = () => { window.__vfxLiveCam = true; driftScale = 1; parallaxOn = true; };
      sc['camera-static'] = () => { driftScale = 0; parallaxOn = false; clearTransient(); };
      sc['camera-kick'] = () => { window.__vfxLiveCam = true; kick(1.4); };
      sc['camera-push'] = () => { window.__vfxLiveCam = true; pushIn(1.0, 4.0); };
      // Accessibility verification hooks. `camera-settle` jumps the 400 ms
      // toggle blends straight to their target so a measurement does not have to
      // wait out the ease; the plain on/off ones leave the ease intact.
      sc['camera-settle'] = () => settleBlends();
      sc['camera-drift-off'] = () => { SETTINGS.set('cameraDrift', false); };
      sc['camera-drift-on'] = () => { SETTINGS.set('cameraDrift', true); };
      sc['camera-motion-off'] = () => {
        SETTINGS.patch({ cameraDrift: false, screenShake: false });
        settleBlends();
        clearTransient();
      };
      sc['camera-motion-on'] = () => {
        SETTINGS.patch({ cameraDrift: true, screenShake: true });
        settleBlends();
      };
    }

    /* ---- per-frame ---------------------------------------------------- */
    const offsetDeg = { yaw: 0, pitch: 0, roll: 0 };

    function update(dt, time) {
      if (!enabled) return;
      const t = time ?? ctx.time;
      const d = Math.min(dt || 0, 1 / 20);

      /* --- accessibility blends. Read the store fresh every frame: the contract
             forbids caching a motion flag, and a stale copy is how a player ends
             up stuck with motion they just switched off. */
      const M = SETTINGS.motion;

      const driftWant = M.drift ? 1 : 0;
      if (driftLin !== driftWant && d > 0) {
        const step = d / MOTION_EASE;
        driftLin = driftWant > driftLin
          ? Math.min(driftWant, driftLin + step)
          : Math.max(driftWant, driftLin - step);
        driftGain = smooth(driftLin);
      }
      if (driftLin === 0) {
        // Fully off: kill the parallax accumulators outright. Their exponential
        // decay would otherwise leave an ever-shrinking but never-zero creep.
        driftGain = 0;
        parX = parY = parYaw = 0;
      }

      const shakeWant = M.shake && M.shakeScale > 0 ? 1 : 0;
      if (shakeWant) shakeHeld = M.shakeScale;
      if (shakeLin !== shakeWant && d > 0) {
        const step = d / MOTION_EASE;
        shakeLin = shakeWant > shakeLin
          ? Math.min(shakeWant, shakeLin + step)
          : Math.max(shakeWant, shakeLin - step);
      }
      shakeGain = shakeLin === 0 ? 0 : smooth(shakeLin) * shakeHeld;
      if (shakeLin === 0 && (kickVel.lengthSq() || kickPos.lengthSq() || shakeAmt || pushAmt)) {
        // Eased all the way out — drop the in-flight impulse so nothing lingers.
        clearShakeTransient();
      }

      // --- breathing: three incommensurate sines, hard-capped amplitudes
      const g = WIND?.uniforms?.uWindGust?.value ?? 0;
      const bYaw = Math.sin((t / BREATHE.yawT) * Math.PI * 2) * BREATHE.yaw;
      const bPit = Math.sin((t / BREATHE.pitchT) * Math.PI * 2 + 1.31) * BREATHE.pitch;
      const bRol = Math.sin((t / BREATHE.rollT) * Math.PI * 2 + 2.44) * BREATHE.roll;
      const bY = Math.sin((t / BREATHE.bobYT) * Math.PI * 2 + 0.77) * BREATHE.bobY;
      const bX = Math.sin((t / BREATHE.bobXT) * Math.PI * 2 + 2.05) * BREATHE.bobX;
      // the air itself moving the operator: tiny, gust-coupled, never > 4 mm
      const shud = Math.sin(t * 3.7) * 0.0038 * g + Math.sin(t * 5.9 + 1.2) * 0.0022 * g;

      // --- pointer parallax, critically damped toward the pointer
      if (parallaxOn && !ctx.shotMode && driftLin > 0) {
        const k = 1 - Math.exp(-d / PARALLAX.tau);
        const nx = THREE.MathUtils.clamp(ctx.pointer?.ndc?.x ?? 0, -1, 1);
        const ny = THREE.MathUtils.clamp(ctx.pointer?.ndc?.y ?? 0, -1, 1);
        parX += (nx * PARALLAX.x - parX) * k;
        parY += (ny * PARALLAX.y - parY) * k;
        parYaw += (-nx * PARALLAX.yaw - parYaw) * k;
      } else if (parX || parY || parYaw) {
        const k = 1 - Math.exp(-d / 0.25);
        parX -= parX * k; parY -= parY * k; parYaw -= parYaw * k;
        if (Math.abs(parX) < DEADZONE) parX = 0;
        if (Math.abs(parY) < DEADZONE) parY = 0;
        if (Math.abs(parYaw) < DEADZONE) parYaw = 0;
      }

      // --- kick springs (underdamped, snappy, settles in ~0.5 s).
      // Sub-stepped at 240 Hz: K = 210 with dt = 1/20 would explode, and dt is
      // only clamped to 1/20 by main.js.
      if (d > 0) {
        const K = 210, C = 19;
        const n = Math.min(12, Math.max(1, Math.ceil(d * 240)));
        const h = d / n;
        for (let i = 0; i < n; i++) {
          kickRotVel.x += (-K * kickRot.x - C * kickRotVel.x) * h;
          kickRotVel.y += (-K * kickRot.y - C * kickRotVel.y) * h;
          kickRotVel.z += (-K * kickRot.z - C * kickRotVel.z) * h;
          kickRot.addScaledVector(kickRotVel, h);
          kickVel.x += (-K * kickPos.x - C * kickVel.x) * h;
          kickVel.y += (-K * kickPos.y - C * kickVel.y) * h;
          kickVel.z += (-K * kickPos.z - C * kickVel.z) * h;
          kickPos.addScaledVector(kickVel, h);
        }
        // Snap a settled spring to exact zero — an asymptote is still movement.
        if (kickRot.lengthSq() < DEADZONE * DEADZONE && kickRotVel.lengthSq() < DEADZONE) {
          kickRot.set(0, 0, 0); kickRotVel.set(0, 0, 0);
        }
        if (kickPos.lengthSq() < DEADZONE * DEADZONE && kickVel.lengthSq() < DEADZONE) {
          kickPos.set(0, 0, 0); kickVel.set(0, 0, 0);
        }
        if (shakeAmt > 0) shakeAmt = Math.max(0, shakeAmt - shakeDecay * d);

        // --- push envelope
        if (pushTarget > 0) {
          pushAmt += (pushTarget - pushAmt) * (1 - Math.exp(-d / 0.22));
          pushHold -= d;
          if (pushHold <= 0) pushTarget = 0;
        } else if (pushAmt > DEADZONE) {
          pushAmt -= pushAmt * (1 - Math.exp(-d / pushRelease));
        } else pushAmt = 0;
      }

      const sh = shakeAmt > 0
        ? (Math.sin(t * 41.3) * 0.6 + Math.sin(t * 67.1 + 1.9) * 0.4) * shakeAmt
        : 0;

      // --- compose. base quaternion first, then a small local rotation.
      // ds / sg are the accessibility gates: at 0 every term below is exactly 0,
      // so the camera lands bit-identically on the preset.
      const ds = driftScale * driftGain;
      const sg = shakeGain;
      const yaw = bYaw * ds + parYaw * driftGain + (kickRot.y + sh * 0.0022) * sg;
      const pitch = bPit * ds + (kickRot.x + sh * 0.0016) * sg;
      const roll = bRol * ds + (kickRot.z + sh * 0.0012) * sg;
      offsetDeg.yaw = yaw / D2R; offsetDeg.pitch = pitch / D2R; offsetDeg.roll = roll / D2R;

      if (yaw || pitch || roll) {
        eOff.set(pitch, yaw, roll, 'YXZ');
        qOff.setFromEuler(eOff);
        cam.quaternion.copy(base.quat).multiply(qOff);
      } else {
        cam.quaternion.copy(base.quat);
      }

      // basis from the ANCHOR orientation so parallax stays axis-stable
      right.set(1, 0, 0).applyQuaternion(base.quat);
      up.set(0, 1, 0).applyQuaternion(base.quat);
      fwd.set(0, 0, -1).applyQuaternion(base.quat);

      const dollyIn = pushAmt * 1.35 * sg;
      cam.position.copy(base.pos);
      tmp.copy(right).multiplyScalar((bX * ds) + (parX + shud) * driftGain + kickPos.x * sg);
      cam.position.add(tmp);
      tmp.copy(up).multiplyScalar((bY * ds) + (parY + shud * 0.6) * driftGain + kickPos.y * sg);
      cam.position.add(tmp);
      tmp.copy(fwd).multiplyScalar(dollyIn + kickPos.z * sg);
      cam.position.add(tmp);

      const fov = base.fov - pushAmt * 3.2 * sg;
      // The 1e-4 hysteresis avoids rebuilding the projection matrix every frame
      // during a push, but it must never leave the FOV parked a hair off the
      // preset once the push is gone — so an exact landing always commits.
      if (cam.fov !== fov && (fov === base.fov || Math.abs(cam.fov - fov) > 1e-4)) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld();
    }

    ctx.assets.cameraRig = {
      kick, shake, pushIn, reanchor,
      setEnabled(on) { enabled = !!on; if (!enabled) clearTransient(); },
      setParallax(on) { parallaxOn = !!on; },
      setDriftScale(s) { driftScale = THREE.MathUtils.clamp(Number(s) || 0, 0, 1); },
      base,
      offsetDeg,
      get preset() { return base.name; },
      get pushAmount() { return pushAmt; },
      /** Read-only view of the accessibility gates, for the UI and for probes. */
      get motion() { return { driftGain, shakeGain, driftLin, shakeLin }; },
    };

    return {
      update,
      dispose() {
        offSettings?.();
        if (ctx.assets.cameraRig) ctx.assets.cameraRig = null;
      },
    };
  },
};
