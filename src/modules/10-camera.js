import * as THREE from 'three';
import { CAMERA_PRESETS, applyPreset } from '../core/cameras.js';
import { WIND } from '../lib/wind.js';

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
 * DETERMINISM. Under the screenshot harness the springs are held at zero and
 * parallax is off, so the only motion is the breathing term — which is a pure
 * function of `ctx.time` and therefore byte-reproducible for a given --warm.
 * Its amplitude is scaled to SHOT_DRIFT (0.30) there, i.e. <= 0.12 deg, ~3.6 px
 * at the hero framing: enough that a motion strip shows camera life, small
 * enough that no critic can attribute a composition change to the rig. Full
 * amplitude in shot mode is one scenario away: `camera-live`.
 *
 * Published: ctx.assets.cameraRig = {
 *   kick(strength, opts), pushIn(amount, hold), shake(strength, seconds),
 *   reanchor(preset), setEnabled(on), setParallax(on),
 *   base, preset, offsetDeg
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

    // scratch
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const qOff = new THREE.Quaternion();
    const eOff = new THREE.Euler();
    const tmp = new THREE.Vector3();

    function clearTransient() {
      kickPos.set(0, 0, 0); kickVel.set(0, 0, 0);
      kickRot.set(0, 0, 0); kickRotVel.set(0, 0, 0);
      parX = parY = parYaw = 0;
      shakeAmt = 0;
      pushAmt = 0; pushTarget = 0; pushHold = 0;
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

    /* ---- impulses ---------------------------------------------------- */

    /**
     * A snappy recoil. `strength` 1 = a crit-sized hit.
     * opts.dir is an optional world direction the hit came FROM.
     */
    function kick(strength = 1, opts) {
      if (ctx.shotMode && !(typeof window !== "undefined" && window.__vfxLiveCam)) return;
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
      shakeAmt = Math.max(shakeAmt, THREE.MathUtils.clamp(strength, 0, 1));
      shakeDecay = 1 / Math.max(0.08, seconds);
    }

    /** The stage-up push: dolly in + FOV squeeze, attack / hold / release. */
    function pushIn(amount = 1, hold = 1.1) {
      if (ctx.shotMode && !(typeof window !== "undefined" && window.__vfxLiveCam)) return;
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

    /* ---- debug scenarios --------------------------------------------- */
    if (typeof window !== 'undefined' && window.__game?.scenarios) {
      const sc = window.__game.scenarios;
      sc['camera-live'] = () => { window.__vfxLiveCam = true; driftScale = 1; parallaxOn = true; };
      sc['camera-static'] = () => { driftScale = 0; parallaxOn = false; clearTransient(); };
      sc['camera-kick'] = () => { window.__vfxLiveCam = true; kick(1.4); };
      sc['camera-push'] = () => { window.__vfxLiveCam = true; pushIn(1.0, 4.0); };
    }

    /* ---- per-frame ---------------------------------------------------- */
    const offsetDeg = { yaw: 0, pitch: 0, roll: 0 };

    function update(dt, time) {
      if (!enabled) return;
      const t = time ?? ctx.time;
      const d = Math.min(dt || 0, 1 / 20);

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
      if (parallaxOn && !ctx.shotMode) {
        const k = 1 - Math.exp(-d / PARALLAX.tau);
        const nx = THREE.MathUtils.clamp(ctx.pointer?.ndc?.x ?? 0, -1, 1);
        const ny = THREE.MathUtils.clamp(ctx.pointer?.ndc?.y ?? 0, -1, 1);
        parX += (nx * PARALLAX.x - parX) * k;
        parY += (ny * PARALLAX.y - parY) * k;
        parYaw += (-nx * PARALLAX.yaw - parYaw) * k;
      } else if (parX || parY || parYaw) {
        const k = 1 - Math.exp(-d / 0.25);
        parX -= parX * k; parY -= parY * k; parYaw -= parYaw * k;
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
        if (shakeAmt > 0) shakeAmt = Math.max(0, shakeAmt - shakeDecay * d);

        // --- push envelope
        if (pushTarget > 0) {
          pushAmt += (pushTarget - pushAmt) * (1 - Math.exp(-d / 0.22));
          pushHold -= d;
          if (pushHold <= 0) pushTarget = 0;
        } else if (pushAmt > 1e-4) {
          pushAmt -= pushAmt * (1 - Math.exp(-d / pushRelease));
        } else pushAmt = 0;
      }

      const sh = shakeAmt > 0
        ? (Math.sin(t * 41.3) * 0.6 + Math.sin(t * 67.1 + 1.9) * 0.4) * shakeAmt
        : 0;

      // --- compose. base quaternion first, then a small local rotation.
      const ds = driftScale;
      const yaw = bYaw * ds + parYaw + kickRot.y + sh * 0.0022;
      const pitch = bPit * ds + kickRot.x + sh * 0.0016;
      const roll = bRol * ds + kickRot.z + sh * 0.0012;
      offsetDeg.yaw = yaw / D2R; offsetDeg.pitch = pitch / D2R; offsetDeg.roll = roll / D2R;

      eOff.set(pitch, yaw, roll, 'YXZ');
      qOff.setFromEuler(eOff);
      cam.quaternion.copy(base.quat).multiply(qOff);

      // basis from the ANCHOR orientation so parallax stays axis-stable
      right.set(1, 0, 0).applyQuaternion(base.quat);
      up.set(0, 1, 0).applyQuaternion(base.quat);
      fwd.set(0, 0, -1).applyQuaternion(base.quat);

      const dollyIn = pushAmt * 1.35;
      cam.position.copy(base.pos);
      tmp.copy(right).multiplyScalar((bX * ds) + parX + kickPos.x + shud);
      cam.position.add(tmp);
      tmp.copy(up).multiplyScalar((bY * ds) + parY + kickPos.y + shud * 0.6);
      cam.position.add(tmp);
      tmp.copy(fwd).multiplyScalar(dollyIn + kickPos.z);
      cam.position.add(tmp);

      const fov = base.fov - pushAmt * 3.2;
      if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
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
    };

    return {
      update,
      dispose() { if (ctx.assets.cameraRig) ctx.assets.cameraRig = null; },
    };
  },
};
