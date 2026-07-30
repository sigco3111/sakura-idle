# Module contract — read this fully before writing a line

`Sakura — Petals of the Everblossom`. Three.js r0.185, Vite, plain JS (no TS), ESM.
Target: 60 fps at 1920×1080 on an Apple M1 Pro.

## The one rule that matters

**You own exactly one file.** Write only the file(s) named in your brief. Never edit
another module, never edit `src/main.js`, `src/core/*`, `index.html`, `vite.config.js`,
`tools/*`, or another agent's `src/lib/*` file. Other agents are editing this repo at
the same moment; touching a shared file corrupts their work and yours.

Need something from another module? Get it through `ctx` (below) and code defensively
for it being absent — modules boot in `order` sequence and yours must not throw if a
later one hasn't run yet.

## Module shape

Every file in `src/modules/*.js` is auto-discovered by `src/main.js` via `import.meta.glob`.
No registration step. Default-export this descriptor:

```js
import * as THREE from 'three';

export default {
  name: 'tree',          // unique, short, lowercase
  order: 30,             // boot + update order, ascending
  async setup(ctx) {
    const group = new THREE.Group();
    // ...build everything here; await any async asset work
    return {
      object3D: group,                     // optional — auto-added to ctx.scene
      update(dt, time) {},                 // optional — dt seconds, time = total sim seconds
      resize(w, h, dpr) {},                // optional
      dispose() {},                        // optional
    };
  },
};
```

`order` slots (do not squat on someone else's):

| order | module | file |
|---|---|---|
| 0 | renderer/scene/camera/input | `00-renderer.js` |
| 5 | procedural texture + material library | `05-textures.js` |
| 8 | lighting & time-of-day rig | `08-lighting.js` |
| 10 | camera rig / player camera motion | `10-camera.js` |
| 15 | sky, atmosphere, clouds, fog | `15-sky.js` |
| 20 | terrain, grass, ground scatter | `20-terrain.js` |
| 25 | water / pond | `25-water.js` |
| 30 | the sakura tree | `30-tree.js` |
| 35 | props — torii, lanterns, rocks, shrine | `35-props.js` |
| 40 | petal particle system | `40-petals.js` |
| 45 | click / gameplay VFX | `45-vfx.js` |
| 60 | game state, economy, save/load | `60-game.js` |
| 65 | UI / HUD (DOM) | `65-ui.js` |
| 70 | audio | `70-audio.js` |
| 90 | post-processing pipeline (**last**) | `90-postfx.js` |

## `ctx` — the shared context (`src/core/ctx.js`)

```
ctx.renderer      THREE.WebGLRenderer      (exists from order 0 on)
ctx.scene         THREE.Scene
ctx.camera        THREE.PerspectiveCamera
ctx.pipeline      null | { render(dt) }    set ONLY by 90-postfx; if set, main.js calls it
                                           instead of renderer.render
ctx.assets        { textures:{}, materials:{}, geometries:{}, envMap }
                                           publish reusable assets here under your own key
ctx.time          seconds of simulated time (deterministic in shot mode)
ctx.frame         frame counter
ctx.quality       { tier, petals, shadowMap, ssao, taa, dof, godrays, pixelRatioCap,
                    waterReflect, grass }  — RESPECT THESE BUDGETS
ctx.shotMode      true when running under the screenshot harness (RAF loop disabled)
ctx.size          { w, h, dpr }
ctx.bus           .on(evt, fn) / .emit(evt, payload)
ctx.modules        Map name -> instance
ctx.pointer       { x, y, ndc:{x,y}, down }
ctx.clickTargets  push meshes here to make them clickable
```

### Event bus contract

Emit and listen only for these names; add new ones with a `yourmodule:` prefix.

| event | payload | emitted by | consumed by |
|---|---|---|---|
| `game:ready` | — | main | anyone |
| `resize` | `{w,h,dpr}` | main | anyone |
| `world:click` | `{hit, point, screen:{x,y}, ndc:{x,y}}` | renderer | game, vfx |
| `tree:clicked` | `{point, worldNormal, power}` | tree | vfx, game, audio |
| `petals:gain` | `{amount, point, crit:boolean}` | game | vfx, ui, audio |
| `petals:burst` | `{point, count, power}` | game/vfx | petals |
| `state:changed` | full serialisable game state | game | ui |
| `upgrade:bought` | `{id, level, tier}` | game | ui, vfx, tree, audio |
| `bloom:stage` | `{stage:0..5}` tree growth stage | game | tree, sky, lighting, audio |
| `time:phase` | `{phase:'dawn'\|'day'\|'dusk'\|'night', t:0..1}` | lighting | sky, water, props, ui |
| `sfx` | `{id, gain?, pan?}` | anyone | audio |

## Shared lighting uniforms — every custom shader must use these

`08-lighting.js` owns and per-frame updates a single uniform bag published at
`ctx.assets.lightUniforms`. Any module writing a custom NPR shader **spreads these same
uniform objects** into its material so all surfaces agree on sun direction, colour and fog:

```js
const L = ctx.assets.lightUniforms;          // may be undefined if lighting hasn't booted
material.uniforms = { ...L, ...WIND.uniforms, ...myOwnUniforms };
```

Guaranteed members (all `{ value }` objects, shared by reference — never replace them):

```
uSunDir        vec3   normalised, world space, pointing FROM surface TO sun
uSunColor      vec3   linear-space key light colour * intensity
uSkyColor      vec3   linear zenith ambient
uGroundColor   vec3   linear bounce ambient from below
uShadowTint    vec3   linear colour shadowed albedo is pushed toward (hue-shifted, never black)
uFogColor      vec3   linear aerial-perspective colour
uFogParams     vec3   (density, heightFalloff, startDistance)
uMoonDir       vec3   night key direction
uNightMix      float  0 = full day, 1 = full night
uPhaseT        float  0..1 progress through the current phase
uExposure      float  scene exposure multiplier
```

And `ctx.assets.lightRig = { sun, hemi, fill, phase }` for direct THREE.Light access.

Companion GLSL helper (`src/lib/lighting.js`, owned by the lighting agent) must export
`GLSL_LIGHT_UNIFORMS` (the `uniform` declarations) and `GLSL_NPR` providing at least:

```
vec3  nprShade(vec3 albedo, vec3 N, vec3 V, float shadowMask, float translucency, float thickness)
float rimTerm(vec3 N, vec3 V, float power)
vec3  applyAerial(vec3 color, float viewDist, float worldY)
```

Every surface module calls `nprShade` + `applyAerial` rather than rolling its own lighting.

## Player settings — read them, never fork them

`src/lib/settings.js` is the scaffold-owned single source of truth for audio levels and
motion/accessibility preferences. It persists to its own localStorage key (`sakura.settings.v1`),
separate from the save game on purpose: a hard reset must not wipe someone's accessibility
preferences, and a corrupt save must not trap them with motion they cannot tolerate.

```js
import { SETTINGS } from '../lib/settings.js';

// audio buses — apply these, do not invent your own volume maths
musicBus.gain.value = SETTINGS.musicGain();   // 0 when muteMusic or muteAll
sfxBus.gain.value   = SETTINGS.sfxGain();

// motion gates — always read SETTINGS.motion, never the raw flags
if (SETTINGS.motion.shake)   applyCameraKick(amp * SETTINGS.motion.shakeScale);
if (SETTINGS.motion.drift)   applyIdleDrift();
if (SETTINGS.motion.flashes) flashScreen();

// react live — a setting that needs a reload to take effect is a bug
SETTINGS.on('change', ({ key, all }) => { /* re-apply immediately */ });
```

Keys: `masterVolume`, `musicVolume`, `sfxVolume` (0..1), `muteAll`, `muteMusic`, `muteSfx`,
`screenShake`, `cameraDrift`, `flashes`, `petalBursts`, `reducedMotion`.

`reducedMotion` defaults to the OS `prefers-reduced-motion` media query and acts as a master
switch over the motion flags. `SETTINGS.set(k, v)` clamps, persists and notifies; `SETTINGS.patch({…})`
does several at once; `SETTINGS.reset()` restores defaults.

Two hard rules: **no module may keep its own copy of a volume or motion flag**, and every consumer
must apply changes on the `change` event immediately rather than at next boot.

## Non-negotiable technical rules

1. **No network requests.** No CDN, no external textures/fonts/HDRIs/audio files.
   Everything procedural or generated at runtime (canvas, noise, DataTexture, WebAudio).
   The harness will flag any request. Fonts: system stack only.
2. **Colour management.** Renderer is `SRGBColorSpace` output + `ACESFilmicToneMapping`.
   Any colour you author for display goes through `new THREE.Color().setHex(0x..., THREE.SRGBColorSpace)`
   or `setStyle`. Canvas-generated colour textures need `texture.colorSpace = THREE.SRGBColorSpace`;
   data/normal/roughness maps must stay `NoColorSpace`.
3. **Instance everything repeated.** `InstancedMesh` / instanced attributes for grass,
   petals, leaves, rocks. Budget: **< 420 draw calls** in the `hero` preset.
4. **Custom shaders** as JS template strings in `src/lib/<yourname>-shaders.js`
   (a file you own) or inline. Use `onBeforeCompile` patching or raw `ShaderMaterial`.
   Any `ShaderMaterial` that must receive shadows/fog needs the relevant `#include`s.
5. **Determinism.** No `Math.random()` at module scope for anything that affects layout —
   use the seeded RNG from `src/lib/rng.js` (`mulberry32`). Screenshots must be
   byte-comparable between runs; the critics rely on it.
6. **`dt` is clamped** to 1/20 s max. Never assume 60 Hz. In shot mode `dt` is exactly 1/60.
7. **Dispose** geometries/materials/textures you create in `dispose()`.
8. **Never `console.log` per-frame.** The harness treats console errors/warnings as failures.

## Verifying your own work — you MUST do this

```bash
cd /Users/dan/Projects/claude-experiments/sakura-idle
node tools/shot.mjs --out shots/<yourname>-r1 --presets hero,canopy --w 1920 --h 1080
```

Runs its own Vite server on a free port, so it is safe to run while other agents run it.
Exit code 0 = clean. Non-zero = your module threw; `shots/<...>/report.json` has the stack.
**Then `Read` the PNG and look at it.** Never report success on a screenshot you have not
looked at. Check `report.json` for `msPerFrame`, `drawCalls`, `triangles`.

Useful presets: `hero canopy bark wide pond petals lantern gameplay` (see `src/core/cameras.js`).
Extra flags: `--ui 0` (hide DOM UI), `--q high|medium|low`, `--warm 600` (advance sim),
`--scenario <name>` (calls `window.__game.scenarios[name]()` before shooting — register
your own debug scenarios there, e.g. night, stage-5 bloom).

## Definition of done

- Harness exits 0 at `--q ultra` **and** `--q low`.
- `hero` preset ≥ 60 fps equivalent (`msPerFrame` ≤ 16.6) with all modules present.
- You have looked at the PNG and it matches `ART_BIBLE.md`.
- Your file has no TODOs and no placeholder art.
