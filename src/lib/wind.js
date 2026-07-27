import * as THREE from 'three';
import { noise3 } from './noise.js';

/**
 * THE global wind field — scaffold-owned, do not edit.
 *
 * Coherent wind is what makes a scene feel alive rather than "a bunch of things
 * wiggling". Grass, branches, petals, water ripples and cloth MUST all sample
 * this one field so gusts sweep across the whole scene together.
 *
 * Usage in a module:
 *   import { WIND, GLSL_WIND } from '../lib/wind.js';
 *   material.uniforms = { ...WIND.uniforms, ... }      // share the SAME uniform objects
 *   vertexShader = `${GLSL_NOISE}\n${GLSL_WIND}\n ... windOffset(worldPos, stiffness) ...`
 *
 * CPU side:  WIND.at(x, y, z) -> THREE.Vector3
 */
class WindField {
  constructor() {
    this.uniforms = {
      uWindDir: { value: new THREE.Vector2(0.86, 0.51).normalize() },
      uWindStrength: { value: 1.0 },   // 0..2 global multiplier, gameplay may raise it
      uWindGust: { value: 0.0 },       // 0..1 current gust envelope
      uWindTime: { value: 0.0 },
    };
    this._v = new THREE.Vector3();
    this._baseAngle = Math.atan2(0.51, 0.86);
  }

  update(dt, time) {
    const u = this.uniforms;
    u.uWindTime.value = time;
    // Direction wanders slowly — ±22° around the base heading.
    const a = this._baseAngle + noise3(time * 0.031, 11.3, 0) * 0.38;
    u.uWindDir.value.set(Math.cos(a), Math.sin(a));
    // Gust envelope: two detuned oscillators + noise, kept in 0..1, mostly calm
    // with occasional strong sweeps.
    const g = 0.5 + 0.5 * Math.sin(time * 0.37) * Math.sin(time * 0.113 + 1.7);
    const n = noise3(time * 0.21, 5.5, 2.2) * 0.5 + 0.5;
    u.uWindGust.value = Math.pow(THREE.MathUtils.clamp(g * 0.55 + n * 0.65, 0, 1), 1.7);
  }

  /** Wind velocity at a world position (m/s-ish). Matches windVec() in GLSL. */
  at(x, y, z) {
    const u = this.uniforms;
    const d = u.uWindDir.value;
    const t = u.uWindTime.value;
    // Travelling gust wave along the wind direction.
    const phase = (x * d.x + z * d.y) * 0.16 - t * 1.9;
    const wave = 0.55 + 0.45 * Math.sin(phase);
    const turb = noise3(x * 0.22 + t * 0.4, y * 0.22, z * 0.22) * 0.45;
    const s = u.uWindStrength.value * (0.35 + 1.25 * u.uWindGust.value) * wave;
    // Height gradient: wind is stronger higher up (canopy moves more than roots).
    const hg = 0.45 + 0.55 * Math.min(1, Math.max(0, y / 12));
    return this._v.set(
      (d.x * s + turb * 0.5) * hg,
      (turb * 0.35 + 0.06 * Math.sin(t * 1.3 + x)) * hg,
      (d.y * s + turb * 0.5) * hg,
    );
  }

  /** Current gust value, for gameplay/audio reactions. */
  get gust() { return this.uniforms.uWindGust.value; }
}

export const WIND = new WindField();

/**
 * GLSL counterpart. Requires GLSL_NOISE to be included first.
 * Exposes:
 *   vec3  windVec(vec3 worldPos)                  — velocity, matches WIND.at()
 *   vec3  windOffset(vec3 worldPos, float stiff)  — displacement for foliage/grass;
 *         `stiff` 0 = free (twig tip / grass tip), 1 = rigid (trunk / root)
 *   float windGustEnv()                           — 0..1 gust envelope
 */
export const GLSL_WIND = /* glsl */`
#ifndef SAKURA_WIND_INCLUDED
#define SAKURA_WIND_INCLUDED
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uWindGust;
uniform float uWindTime;

float windGustEnv(){ return uWindGust; }

vec3 windVec(vec3 wp){
  float phase = dot(wp.xz, uWindDir) * 0.16 - uWindTime * 1.9;
  float wave  = 0.55 + 0.45 * sin(phase);
  float turb  = snoise(vec3(wp.x * 0.22 + uWindTime * 0.4, wp.y * 0.22, wp.z * 0.22)) * 0.45;
  float s     = uWindStrength * (0.35 + 1.25 * uWindGust) * wave;
  float hg    = 0.45 + 0.55 * clamp(wp.y / 12.0, 0.0, 1.0);
  return vec3((uWindDir.x * s + turb * 0.5) * hg,
              (turb * 0.35 + 0.06 * sin(uWindTime * 1.3 + wp.x)) * hg,
              (uWindDir.y * s + turb * 0.5) * hg);
}

/**
 * Displacement for wind-affected geometry. Adds a fast, small-amplitude
 * "flutter" term on top of the slow bulk sway — the flutter is what sells
 * leaves and grass; bulk sway alone looks like rubber.
 */
vec3 windOffset(vec3 wp, float stiff){
  float freedom = 1.0 - clamp(stiff, 0.0, 1.0);
  vec3  w = windVec(wp);
  float flutter = snoise(vec3(wp.xz * 3.1, uWindTime * 3.7)) * 0.14
                + snoise(vec3(wp.xz * 7.9, uWindTime * 6.1)) * 0.06;
  vec3 lateral = vec3(uWindDir.x, 0.0, uWindDir.y) * flutter * (0.6 + uWindGust);
  return (w * 0.13 + lateral) * freedom * freedom;
}
#endif
`;
