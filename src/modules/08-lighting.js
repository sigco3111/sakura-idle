import * as THREE from 'three';
import { WIND } from '../lib/wind.js';
import {
  createLightUniforms, samplePalette, writePhaseColors, phaseOf,
  createNprMaterial, applyNprToStandard, createSkyUniforms, createSkyMaterial,
  DAY_LENGTH, DEFAULT_DAY_T, PHASE_ANCHORS, GROUND_BOUNCE, DAPPLE_FREQ, MAX_LAMPS,
  NPR_KEY_DESAT,
  AERIAL_LEVEL, AERIAL_KEEP_MID, AERIAL_KEEP_FAR, AERIAL_POW,
  AMB_OCC_POW, CANOPY_SKY, CANOPY_KEY,
} from '../lib/lighting.js';

/**
 * Lighting rig + time-of-day.  order 8 — after the renderer, before everything
 * that shades a surface.
 *
 * Publishes
 *   ctx.assets.lightUniforms  the shared uniform bag (CONTRACT.md). The Color /
 *                             Vector3 objects inside are shared BY REFERENCE with
 *                             every module that spreads them; we only ever mutate
 *                             `.value`, never reassign it.
 *   ctx.assets.lightRig       { sun, hemi, fill, back, phase, dayT, palette, shadowTexel }
 *   ctx.assets.envMap         PMREM environment from the procedural gradient sky
 *   ctx.assets.applyNPR       applyNPR(material, opts) — retro-fits ART_BIBLE §2 onto a
 *                             stock MeshStandard/MeshPhysical material (also auto-applied to
 *                             every such material in the scene; opt out with
 *                             material.userData.noNpr = true)
 *   ctx.assets.lighting       { createNprMaterial, applyNPR, setDayT, setPhase, palette, skyUniforms,
 *                               addLamp, maxLamps, lampCount, adoptedPointLights }
 *
 * POINT LIGHTS / LANTERNS. The NPR model throws three's own light accumulation
 * away, so a bare THREE.PointLight lights nothing. It reaches surfaces only
 * through `uLampPos` / `uLampColor` in the shared bag, which this rig fills two
 * ways: it ADOPTS up to `maxLamps` visible PointLights from the scene graph
 * automatically (set `light.distance` — it is the lamp's reach in metres), and it
 * accepts explicit registrations via `ctx.assets.lighting.addLamp({ position,
 * color, intensity, range })`. Either way the lamp lights ground, bark, petals
 * and water, casts a warm rim and transmits through thin foliage, because
 * nprShadeN folds it in for every shader that calls nprSetWorldPos() (all of
 * them). Opt a light out with `light.userData.noNprLamp = true`.
 *
 * The shared bag also carries `uShadowSoft` = (caster-set centre xyz, shadow-map
 * UV per world unit). nprShadowMaskSoft() in src/lib/lighting.js uses it to grow
 * the penumbra with the receiver-to-blocker distance; spread the bag as usual and
 * you get it for free.
 *
 * Debug scenarios registered here: dawn / day / dusk / night / golden / noon,
 * `raw-*` and `nopost` (bypass the post pipeline), and `calib` / `calib-raw` /
 * `calib-<phase>` which reveal this module's own calibration balls + shadow slab
 * so the shading model can be MEASURED instead of eyeballed.
 *
 * Emits `time:phase` { phase, t } whenever the named phase changes.
 */

/** World fit: the interesting garden is a ~60-unit disc, tree ~14 units tall.
 *  The pad is deliberately small: the ortho box only has to contain the
 *  CASTERS, and every metre of slack is texel resolution thrown away. With the
 *  tree + props caster set (union sphere r ~9) this lands a 24 m box, i.e.
 *  5.9 mm/texel at 4096 and 11.7 mm at 2048 — under the 12 mm target. */
const SHADOW_PAD = 3;            // world units of slack around the caster set
const SHADOW_HALF_MIN = 12;      // -> 24 m extent, the tight-fit floor
const SHADOW_HALF_MAX = 46;      // texel budget: 46 m half = 22 mm/texel at 4096
const SHADOW_THROW_MAX = 26;     // how much of a grazing shadow's throw to fit
const CASTER_RADIUS_MAX = 22;    // cap on the union caster sphere (props sprawl)
const SHADOW_DEPTH_TAIL = 80;    // extra far-plane depth so long grazing shadows land
const ENV_SIZE = 128;            // PMREM cube size — plenty for a gradient sky
const ENV_STEPS = 16;            // regenerate the IBL this many times per day
const NPR_RESCAN_FRAMES = 45;    // how often to sweep the scene for un-shaded materials

/* Animated key breakup (ART_BIBLE §6: "light dapples through the canopy onto
   the ground"). Amplitudes are the art-direction values; the pattern drifts
   with the ONE global wind field so the dapple, the grass and the petals all
   agree on which way the air is moving. */
const DAPPLE_AMP = 0.18;         // depth of the shade/gap modulation on the key
const DAPPLE_DRIFT = 0.06;       // m/s bulk drift of the field along the wind
const DAPPLE_SWAY = 0.42;        // m of extra sway advection (the canopy moving)
const DAPPLE_SWAY_HZ = 0.132;    // ...at this rate
const GUST_AMP = 0.06;           // global "the whole key breathes" amplitude
const GUST_HZ = 0.25;

/* ---------------------------------------------------------------------- *
 * Global shading calibration -> uShadowCal (see GLSL_LIGHT_UNIFORMS).
 *
 * These four numbers used to be #defines inside src/lib/lighting.js, so the only
 * way to calibrate them was to edit, rebuild and re-shoot. As uniforms they can
 * be swept live (the `cal-*` debug scenarios below) and, more importantly, they
 * can differ per PHASE — which is what ART_BIBLE §2 and §4 actually need, since
 * the rim is the whole point at dusk and almost irrelevant at noon.
 *
 * SHADOW_RATIO   scale on the open-shadow luminance ratio. 1.0 = the calibrated
 *                ART_BIBLE §2 "shadow at ~0.55 of the lit side" (MEASURED on the
 *                `calib` chart's 0.50-grey ball in the final graded png, and on
 *                the canopy's cast shadow on grass in the hero frame).
 * CORE_SCALE     scale on the deep-interior plateau depth. 1.0 = NPR_SHADOW_CORE.
 * RIM_GAIN       derived from the palette's own `rimInt` keyframe, so the rim
 *                strengthens through golden hour and dusk exactly where the
 *                art direction already asked for a hotter back light.
 * KEY_DESAT      how far the key's diffuse multiply is neutralised at maximum key
 *                chroma — the dusk "one sepia hue" fix. Fades in with the key's
 *                own chroma, so daylight is untouched.
 * ---------------------------------------------------------------------- */
const CAL_SHADOW_RATIO = 1.00;
const CAL_CORE_SCALE = 1.00;
const CAL_RIM_BASE = 0.75;
const CAL_RIM_PER_INT = 0.50;
const CAL_RIM_MAX = 1.60;

/* ---------------------------------------------------------------------- *
 * Aerial perspective -> uAerial  (see GLSL_LIGHT_UNIFORMS / nprAerialTint).
 *
 * ART_BIBLE §8.3 says "no aerial perspective on distance" is an instant fail and
 * §8.9 says "washed-out or muddy midtones" is another, and this uniform is the
 * only place both are decided. The numbers below are the shipped defaults from
 * src/lib/lighting.js; the per-phase deltas are the ones this rig adds on top.
 *
 * NIGHT gets a slightly HIGHER haze level and a lower far-value keep: the night
 * fog is #1B2440, which is already darker than every land surface in frame, so
 * pushing land further under it inverts the depth cue instead of creating it.
 * ---------------------------------------------------------------------- */
const CAL_AERIAL_NIGHT_LEVEL = 1.06;   // multiplier on AERIAL_LEVEL at full night
const CAL_AERIAL_NIGHT_KEEP = 0.72;    // multiplier on the keeps at full night

export default {
  name: 'lighting',
  order: 8,

  async setup(ctx) {
    const { scene, renderer } = ctx;
    const group = new THREE.Group();
    group.name = 'lighting-rig';

    /* ---------------------------------------------------------------- *
     * Shared uniform bag + palette state
     * ---------------------------------------------------------------- */
    const L = createLightUniforms();
    ctx.assets.lightUniforms = L;

    let dayT = DEFAULT_DAY_T;          // golden hour, the mood target
    let paused = false;
    const pal = samplePalette(dayT);   // reused every frame, no per-frame alloc

    /* ---------------------------------------------------------------- *
     * r185 quirk: PCFSoftShadowMap is no longer wired to a shader define,
     * so it silently falls back to hard BASIC shadows (aliased edges = an
     * instant-fail tell). PCFShadowMap is the Vogel-disk soft path and is
     * the only type that honours `shadow.radius` in this version.
     * ---------------------------------------------------------------- */
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    /* ---------------------------------------------------------------- *
     * Key light — tight, correctly fitted shadow camera
     * ---------------------------------------------------------------- */
    // The 2048 cap this used to carry existed because the terrain — the single
    // biggest receiver in frame — went through three's 5-tap getShadowMask(),
    // which cannot span a wide enough penumbra on a fine map. src/lib/
    // terrain-shaders.js now calls nprShadowMaskSoft() (16 taps, radius capped in
    // TEXELS, so the penumbra is the same world width whatever the resolution),
    // and the near-trunk contact shadow is the thing this round has to make read.
    // So the cap is raised — but to 3072, not the tier's 4096: measured on the
    // hero preset, 2048 -> 12.84 ms/frame and 4096 -> 13.64 ms, and with water,
    // props and VFX all still landing the 16.6 ms budget does not have 0.8 ms
    // spare. 3072 costs ~0.4 ms and halves the texel to 14 mm on the fitted box.
    const mapSize = Math.min(Math.max(512, ctx.quality.shadowMap | 0), 3072);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.bias = 0;
    sun.shadow.autoUpdate = true;
    group.add(sun, sun.target);

    /* ---------------------------------------------------------------- *
     * Shadow frustum fitting.
     *
     * A fixed extent wastes most of the map on empty ground and drifts as the
     * sun swings. Refit the ortho box to the actual shadow-casting set every
     * frame, snap the frustum centre to shadow-map texel increments (otherwise
     * the whole shadow crawls one texel at a time as the sun moves, which reads
     * as a shimmer on every contact edge), and keep the depth range long enough
     * that a grazing dusk sun's 100-unit shadows still land inside it.
     *
     * NOTE: only the CASTERS need to be inside the box. A receiver in a
     * caster's shadow shares that caster's light-space XY by construction, and
     * three's getShadow() returns "lit" outside the frustum (verified in
     * r185 shadowmap_pars_fragment), so nothing self-shadows on the boundary.
     * ---------------------------------------------------------------- */
    const UPV = new THREE.Vector3(0, 1, 0);
    const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3();
    const _snap = new THREE.Vector3(), _tmpSphere = new THREE.Sphere();
    const _land = new THREE.Vector3(), _mid = new THREE.Vector3();
    const casterCentre = new THREE.Vector3(0, 6, 0);
    let casterRadius = 12;
    let shadowTexel = (SHADOW_HALF_MIN * 2) / mapSize;

    /* ---- the canopy's shade pool (ART_BIBLE §2 / nprCanopyShade in lib).
       The tree's own bounding sphere, flattened onto the ground and biased a
       short way along the shadow direction so the pool belongs to this sun. The
       sphere's RADIUS is not usable directly (the canopy sphere comes back at
       ~14 m because it has to contain every stray twig, which would put a 14 m
       disc of shade on the lawn), so the horizontal extent is estimated from the
       canopy's own height instead — a sakura is about as wide as it is tall. */
    const canopySphere = new THREE.Sphere(new THREE.Vector3(0, 7.5, 0), -1);
    const CANOPY_BIAS = 0.34;        // fraction of the geometric offset to take
    /* r5, MEASURED. The bounding sphere the traversal hands back for
       `sakura-canopy` is r = 16.1 at centre y 8.5, because it has to contain every
       stray twig and every mid-air petal card. Feeding that straight in (the old
       min(radius, cy * 1.22) came out at 10.43) put a 21 m disc of shade on a
       lawn under a crown whose actual ground footprint is ~13 m across, and the
       skirt then reached 11.5 m from centre. That is exactly the ART_BIBLE §4.2
       "dirty smudge" the review called out (a shapeless dark mass several times
       the canopy width), AND it meant "sunlit ground ten metres from the trunk" —
       the reference the §2 ratio is measured against — was itself 14% darkened,
       so the ratio could never be read honestly. Measured on the A/B pair:
       lit_a 0.849, lit_b 0.926, lit_c 0.864 at 10-12 m out.
       0.62 x radius, capped by 0.90 x canopy height and hard-capped at 9 m, fits
       the crown's real drip line (-> 7.6 m here) and leaves 10 m out untouched. */
    const CANOPY_R_FRAC = 0.62;      // fraction of the caster sphere's radius
    const CANOPY_R_PER_HEIGHT = 0.90;
    const CANOPY_R_MAX = 9.0;
    let canopyFound = false;

    function writeCanopyOcc(keyDir) {
      const c = L.uCanopyOcc?.value;
      if (!c) return;
      if (poolOff || !canopyFound || !(canopySphere.radius > 0)) { c.set(0, 0, 0, 0); return; }
      const cy = Math.max(canopySphere.center.y, 0.5);
      const R = calOverride.poolR ?? THREE.MathUtils.clamp(
        Math.min(canopySphere.radius * CANOPY_R_FRAC, cy * CANOPY_R_PER_HEIGHT),
        3, CANOPY_R_MAX);
      // geometric ground offset of a blocker at height cy, then damped
      const ky = Math.max(keyDir.y, 0.18);
      // Clamped to a FIFTH of the radius, not a half. The sun sits behind the
      // tree by decision, so the offset slides the pool toward the camera — i.e.
      // toward the bottom edge of the hero frame, where the composition has only
      // ~2 m of visible ground. At the old R * 0.45 the centre sat 4.2 m off the
      // trunk (measured: uCanopyOcc = 0.33, 0, 4.23, 10.43), so the deepest part
      // of the shade was BELOW frame and what remained on screen was the flat
      // outer skirt — a smudge with no gradient. R * 0.20 keeps the lean (the
      // shade still belongs to this sun) with the core over the root flare.
      const off = THREE.MathUtils.clamp((cy / ky) * CANOPY_BIAS, 0, R * 0.20);
      c.set(canopySphere.center.x - keyDir.x * off, 0,
        canopySphere.center.z - keyDir.z * off, R);
    }

    /** Union bounding sphere of every visible shadow caster, in world space. */
    function measureCasters() {
      let found = false;
      canopyFound = false;
      const acc = new THREE.Sphere(new THREE.Vector3(), -1);
      scene.traverseVisible((o) => {
        if (!o.castShadow || !(o.isMesh || o.isLine || o.isPoints)) return;
        // InstancedMesh keeps its own instance-aware sphere; plain meshes use the
        // geometry's, transformed by the world matrix.
        let s = null;
        if (o.isInstancedMesh) {
          if (!o.boundingSphere) { try { o.computeBoundingSphere(); } catch { /* ignore */ } }
          s = o.boundingSphere;
        }
        if (!s) {
          const g = o.geometry;
          if (!g) return;
          if (!g.boundingSphere) g.computeBoundingSphere();
          s = g.boundingSphere;
        }
        if (!s || !(s.radius >= 0)) return;
        _tmpSphere.copy(s).applyMatrix4(o.matrixWorld);
        if (!found) { acc.copy(_tmpSphere); found = true; } else acc.union(_tmpSphere);
        // Read-only: pick out the tree so the shade pool sits under the CANOPY
        // rather than under the union of every prop in the garden. Matched by
        // name first (30-tree.js names its meshes sakura-*), else by "the tallest
        // big caster", so this keeps working if the tree is renamed.
        const named = typeof o.name === 'string' && /sakura|canopy|blossom|tree/i.test(o.name);
        if ((named || (_tmpSphere.radius > 4 && _tmpSphere.center.y > 3))
            && (!canopyFound || _tmpSphere.center.y > canopySphere.center.y)) {
          canopySphere.copy(_tmpSphere);
          canopyFound = true;
        }
      });
      if (!found || !(acc.radius > 0)) return;
      casterCentre.copy(acc.center);
      casterRadius = acc.radius;
      // Props (torii, wall, lanterns, path rocks) legitimately spread the caster
      // set across the whole garden, and a union sphere that grows with them
      // spends the hero subject's shadow-map resolution on a rock 25 m away. Cap
      // the fit and pull it back over the tree at the origin: distant props lose
      // their cast shadow (they are small, far, and mostly in the lower third)
      // rather than the trunk losing its contact shadow.
      if (casterRadius > CASTER_RADIUS_MAX) {
        const k = CASTER_RADIUS_MAX / casterRadius;
        casterCentre.x *= k; casterCentre.z *= k;
        casterRadius = CASTER_RADIUS_MAX;
      }
    }

    function fitShadow(keyDir) {
      // The frustum must cover not only the CASTERS but the ground their shadow
      // LANDS on. Fitted to the tree alone, a 14-unit canopy at a 26 deg sun threw
      // its shadow to x=+18.8 — outside a +/-16 box, so the receiving ground was
      // never in the shadow map and silently rendered fully lit. Extend the box
      // along the shadow direction and recentre on the caster/landing midpoint.
      const drop = Math.max(casterCentre.y, 0.001);
      // keyDir points from the scene TOWARD the key light, so the shadow runs -keyDir.
      const tHit = drop / Math.max(keyDir.y, 0.12);
      _land.copy(casterCentre).addScaledVector(keyDir, -tHit);
      _land.y = 0;
      // Clamped: at a grazing dawn/dusk sun (8 deg) the geometric throw is 50+ m,
      // and paying for all of it costs every receiver in the hero frame half its
      // shadow-map resolution. The far tail of a grazing shadow runs off the
      // bottom of the composition anyway (the sun sits behind the tree, so the
      // shadow comes toward the camera — see the arc note in lib/lighting.js), so
      // fit the box to the part that is actually on screen.
      const throwLen = Math.min(casterCentre.distanceTo(_land), SHADOW_THROW_MAX);

      const half = THREE.MathUtils.clamp(
        casterRadius + throwLen * 0.5 + SHADOW_PAD, SHADOW_HALF_MIN, SHADOW_HALF_MAX);
      const texel = (half * 2) / mapSize;
      shadowTexel = texel;

      _fwd.copy(keyDir).normalize();
      _right.crossVectors(UPV, _fwd);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0); else _right.normalize();
      _up.crossVectors(_fwd, _right).normalize();

      // centre between the casters and where their shadow falls
      _mid.copy(casterCentre).add(_land).multiplyScalar(0.5);
      // snap the frustum centre onto the texel grid in the light's own lateral basis
      const cx = _mid.dot(_right), cy = _mid.dot(_up);
      _snap.copy(_mid)
        .addScaledVector(_right, Math.round(cx / texel) * texel - cx)
        .addScaledVector(_up, Math.round(cy / texel) * texel - cy);

      const dist = half * 2 + 40;
      sun.target.position.copy(_snap);
      sun.target.updateMatrixWorld();
      sun.position.copy(_snap).addScaledVector(_fwd, dist);

      const sc = sun.shadow.camera;
      // 2 texels of slack so a border sample can never read the caster set's edge
      const ext = half + texel * 2;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.near = 1;
      sc.far = dist + half * 2 + SHADOW_DEPTH_TAIL;
      sc.updateProjectionMatrix();

      // texel footprint -> bias budget, both derived from world units per texel
      // so they track the fitted box instead of being magic numbers.
      //
      // normalBias is a FIXED 12 mm, deliberately NOT scaled off the texel.
      // texel*3 came out at 35 mm on the fitted box, which is the same order as
      // the width of a canopy gap's shadow on the grass: every dapple pool was
      // pushed off its own footprint (peter-panning) and the ground read as
      // unshadowed. 12 mm is one texel of slope allowance and still kills acne
      // because nprShadowFade() fades the map out at the terminator anyway.
      sun.shadow.normalBias = 0.012;
      // shadow.bias is added to shadowCoord.z, i.e. it is in NORMALISED ortho
      // depth, not metres. Author the offset in metres (a bit over one texel of
      // slope allowance) and convert, otherwise the same constant peter-pans by
      // 100 mm on a long frustum and does nothing at all on a short one.
      const depthRange = Math.max(sc.far - sc.near, 1);
      sun.shadow.bias = -Math.max(0.018, texel * 1.5) / depthRange;
      // Penumbra for anything still going through three's own 5-tap
      // getShadowMask(). HARD-CAPPED AT 4 TEXELS: three's PCF is five taps, so a
      // 20-texel radius spreads five samples over 234 mm of ground and every
      // one of them lands somewhere different — the filter stops being a
      // penumbra and becomes a 5-level dither that averages the shadow away
      // entirely. Four texels (~47 mm) is the widest a 5-tap kernel can carry
      // without holes. NPR materials use nprShadowMaskSoft() (16 taps) instead
      // and get a real, blocker-distance-driven penumbra on top of this.
      sun.shadow.radius = THREE.MathUtils.clamp(0.26 / texel, 1.5, 4.0);

      // Publish what nprShadowMaskSoft() needs: the caster set's centre (its
      // distance along the key is the blocker-distance proxy that sets penumbra
      // width) and shadow-map UV units per world unit.
      const ss = L.uShadowSoft?.value;
      if (ss) ss.set(casterCentre.x, casterCentre.y, casterCentre.z, 1 / (ext * 2));
    }

    /* Cool fill opposite the sun + a low warm back/rim graze.
       These only reach stock lit materials — every NPR surface derives its own
       fill from uSkyColor/uGroundColor — so they are deliberately weak. */
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    const back = new THREE.DirectionalLight(0xffffff, 0.6);
    group.add(fill, fill.target, back, back.target);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    group.add(hemi);
    const _bounce = new THREE.Color();

    /* ---------------------------------------------------------------- *
     * Local warm lamps — stone lanterns, festival lights, click VFX.
     *
     * IMPORTANT for other modules: the NPR model discards three's own light
     * accumulation wholesale (that is the point — ART_BIBLE §2 owns the shading),
     * so a bare THREE.PointLight lights NOTHING in this project. It has to reach
     * the shared uniform bag. Two ways in, both handled here:
     *
     *   1. Just add a THREE.PointLight to the scene. Every sweep this rig adopts
     *      up to MAX_LAMPS visible PointLights, ranked by brightness*reach and
     *      proximity to the camera, and publishes them as uLampPos/uLampColor.
     *      Set `light.distance` — it is the lamp's reach in metres and a lamp with
     *      distance 0 falls back to LAMP_RANGE_DEFAULT.
     *   2. ctx.assets.lighting.addLamp({ position, color, intensity, range }) for
     *      a lamp with no THREE.Light behind it (cheaper; nothing else needs one).
     *      Explicit lamps claim slots first. The handle is live — mutate
     *      handle.position / .color / .intensity / .range, or call release().
     *
     * Intensity mapping: three's PointLight.intensity is candela and our falloff
     * is a windowed linear one, so `intensity` is normalised by the flux at half
     * the lamp's range. A PointLight(0xffc073, 8, 9) lands at ~0.38 linear, i.e.
     * about a third of the day key and about 2.5x the night key — a lantern that
     * reads at dusk and dominates its own pool at night.
     * ---------------------------------------------------------------- */
    const LAMP_RANGE_DEFAULT = 12;
    const LAMP_GAIN = 1.0;
    const lampHandles = [];
    const _lampPos = new THREE.Vector3();
    const _adopted = [];

    function addLamp(o = {}) {
      const h = {
        position: new THREE.Vector3(),
        color: new THREE.Color(1, 0.78, 0.52),
        intensity: 1,
        range: LAMP_RANGE_DEFAULT,
        enabled: true,
        release() { const i = lampHandles.indexOf(h); if (i >= 0) lampHandles.splice(i, 1); },
      };
      if (o.position) {
        if (Array.isArray(o.position)) h.position.set(...o.position);
        else h.position.copy(o.position);
      }
      if (o.color != null) {
        if (typeof o.color === 'number') h.color.setHex(o.color, THREE.SRGBColorSpace);
        else h.color.copy(o.color);
      }
      if (o.intensity != null) h.intensity = o.intensity;
      if (o.range != null) h.range = o.range;
      lampHandles.push(h);
      return h;
    }

    /** Rank + copy up to MAX_LAMPS lamps into the shared uniform bag. */
    function writeLamps() {
      const pos = L.uLampPos?.value, col = L.uLampColor?.value;
      if (!pos || !col) return 0;
      let n = 0;
      const push = (p, c, intensity, range) => {
        if (n >= MAX_LAMPS || !(intensity > 0) || !(range > 0)) return;
        // flux at half range -> a stylised linear level, resolution independent
        const lvl = (intensity / (0.25 * range * range + 1)) * LAMP_GAIN;
        if (lvl < 1e-4) return;
        pos[n].set(p.x, p.y, p.z, range);
        col[n].copy(c).multiplyScalar(lvl);
        n++;
      };
      for (const h of lampHandles) {
        if (h.enabled) push(h.position, h.color, h.intensity, h.range);
      }
      // ...then adopted scene PointLights, nearest-to-camera first so a garden
      // with more lanterns than slots always lights the ones you can see.
      if (_adopted.length && n < MAX_LAMPS) {
        const cam = ctx.camera?.position;
        if (cam && _adopted.length > 1) {
          for (const l of _adopted) {
            l.getWorldPosition(_lampPos);
            // brightness/reach beats raw proximity, so a big lantern 12 m off
            // still wins a slot over a dim one at your feet.
            l.userData.__lampRank = _lampPos.distanceToSquared(cam)
              / Math.max(l.intensity * Math.max(l.distance || LAMP_RANGE_DEFAULT, 1), 1e-3);
          }
          _adopted.sort((a, b) => a.userData.__lampRank - b.userData.__lampRank);
        }
        for (const l of _adopted) {
          if (n >= MAX_LAMPS) break;
          // `.parent` guards a lamp that was removed from the graph between two
          // sweeps (a props module swapping its lantern set, a VFX light being
          // released): _adopted only refreshes every NPR_RESCAN_FRAMES, and a
          // detached light would otherwise keep lighting the garden from wherever
          // it last stood. `visible` alone does not cover it, and `visible` on the
          // light itself does not see an ancestor group being hidden either.
          if (!l.parent || !l.visible || !(l.intensity > 0)) continue;
          l.getWorldPosition(_lampPos);      // r185: does updateWorldMatrix itself
          push(_lampPos, l.color, l.intensity, l.distance > 0 ? l.distance : LAMP_RANGE_DEFAULT);
        }
      }
      for (let i = n; i < MAX_LAMPS; i++) { pos[i].w = 0; col[i].setRGB(0, 0, 0); }
      return n;
    }

    /** Refreshed by sweepScene(): visible PointLights that are not ours. */
    function collectPointLights() {
      _adopted.length = 0;
      scene.traverse((o) => {
        if (!o.isPointLight || !o.visible) return;
        if (o.parent === group || o.userData?.noNprLamp) return;
        _adopted.push(o);
      });
    }

    /* ---------------------------------------------------------------- *
     * Procedural gradient sky -> PMREM environment (no external HDRI)
     * ---------------------------------------------------------------- */
    const skyU = createSkyUniforms();
    const envScene = new THREE.Scene();
    const envSphereGeo = new THREE.SphereGeometry(40, 32, 20);
    const envSkyMat = createSkyMaterial(L, skyU);
    envScene.add(new THREE.Mesh(envSphereGeo, envSkyMat));

    const pmrem = new THREE.PMREMGenerator(renderer);
    let envRT = null;
    let envKey = -999;

    function buildEnv(force = false) {
      const key = Math.floor(pal.dayT * ENV_STEPS);
      if (!force && key === envKey) return;
      envKey = key;
      const prev = envRT;
      try {
        envRT = pmrem.fromScene(envScene, 0.0, 1, 200, { size: ENV_SIZE });
      } catch (e) {
        envRT = prev;
        return;
      }
      if (prev && prev !== envRT) prev.dispose();
      scene.environment = envRT.texture;
      ctx.assets.envMap = envRT.texture;
    }

    /* Fallback sky dome: only if nobody owns `sky`. 15-sky replaces this. */
    const domeGeo = new THREE.SphereGeometry(420, 40, 24);
    const domeMat = createSkyMaterial(L, skyU);
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.name = 'lighting-fallback-sky';
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.matrixAutoUpdate = false;
    group.add(dome);

    /* ---------------------------------------------------------------- *
     * Fog, from the phase palette, kept in sync with uFogColor.
     * A later module may legitimately swap in its own Fog instance; sync
     * whatever is actually on the scene rather than assuming ours is still
     * there, and never bolt a .density onto a linear THREE.Fog.
     * ---------------------------------------------------------------- */
    scene.fog = new THREE.FogExp2(0x000000, 0.012);

    /* ---------------------------------------------------------------- *
     * Apply a sampled palette to every consumer
     * ---------------------------------------------------------------- */
    const _v = new THREE.Vector3();
    let lastPhase = null;
    let bloomLift = 1;
    let lampCount = 0;
    let shadowOff = false;          // 'noshadow' debug A/B only
    let poolOff = false;            // 'nopool' / 'noshade' debug A/B only
    /* Live overrides for the calibration sweep — see the `cal-*` scenarios. */
    const calOverride = {
      ratio: null, core: null, rim: null, desat: null,
      aerLevel: null, aerKeep: null, aerPow: null, fogScale: null,
      occPow: null, aoScale: null, pool: null, poolR: null, fogStart: null,
    };

    /** Write the four global shading knobs into the shared bag. */
    function writeShadowCal() {
      const c = L.uShadowCal?.value;
      if (!c) return;
      const rim = Math.min(CAL_RIM_BASE + CAL_RIM_PER_INT * (pal.rimInt ?? 1), CAL_RIM_MAX);
      c.set(
        calOverride.ratio ?? CAL_SHADOW_RATIO,
        calOverride.core ?? CAL_CORE_SCALE,
        calOverride.rim ?? rim,
        calOverride.desat ?? NPR_KEY_DESAT,
      );
    }

    /** Aerial + occlusion calibration into the shared bag. */
    function writeAerialCal() {
      const n = THREE.MathUtils.clamp(pal.night ?? 0, 0, 1);
      const a = L.uAerial?.value;
      if (a) {
        const lvl = (calOverride.aerLevel ?? AERIAL_LEVEL)
                  * THREE.MathUtils.lerp(1, CAL_AERIAL_NIGHT_LEVEL, n);
        const kk = (calOverride.aerKeep ?? 1) * THREE.MathUtils.lerp(1, CAL_AERIAL_NIGHT_KEEP, n);
        a.set(
          Math.max(lvl, 0.02),
          Math.max(AERIAL_KEEP_MID * kk, 0.01),
          Math.max(AERIAL_KEEP_FAR * kk, 0.01),
          Math.max(calOverride.aerPow ?? AERIAL_POW, 0.2),
        );
      }
      const s = L.uShadeCal?.value;
      if (s) {
        const poolK = poolOff ? 0.0 : (calOverride.pool ?? 1);
        s.set(
          Math.max(calOverride.occPow ?? AMB_OCC_POW, 0.1),
          Math.max(calOverride.aoScale ?? 1, 0.01),
          Math.max(CANOPY_SKY * poolK, 0.0001),
          Math.max(CANOPY_KEY * poolK, 0.0001),
        );
      }
    }

    /* ---------------------------------------------------------------- *
     * Animated key breakup.
     *
     * ART_BIBLE §6 forbids a frozen frame, and half of any frame here is the
     * lighting. Two coupled terms, both published through `uDapple` so every
     * NPR surface in the project inherits them for free:
     *
     *   spatial  a curl-warped 2-octave field in world XZ that scrolls along the
     *            ONE global wind direction — canopy shade sliding over the
     *            ground. Bulk drift is slow (0.06 m/s, the sun moving); the sway
     *            term is what actually shimmers, because it is the canopy
     *            itself swinging in the gust.
     *   temporal a 0.25 Hz gust that scales the whole key, coupled to WIND.gust
     *            so the light breathes on the same beat the foliage bends.
     *
     * Drift is INTEGRATED rather than computed as speed*time so the wind field's
     * slowly wandering heading cannot teleport the pattern sideways.
     * ---------------------------------------------------------------- */
    let driftX = 0, driftZ = 0;
    const _dap = new THREE.Vector4(0, 0, 0, 1);

    function advanceDapple(dt) {
      const wd = WIND?.uniforms?.uWindDir?.value;
      const wx = wd ? wd.x : 0.86, wz = wd ? wd.y : 0.51;
      driftX -= wx * DAPPLE_DRIFT * DAPPLE_FREQ * dt;
      driftZ -= wz * DAPPLE_DRIFT * DAPPLE_FREQ * dt;
    }

    function writeDapple() {
      const t = ctx.time;
      const wd = WIND?.uniforms?.uWindDir?.value;
      const wx = wd ? wd.x : 0.86, wz = wd ? wd.y : 0.51;
      const gustEnv = WIND?.uniforms?.uWindGust?.value ?? 0.5;
      const sway = Math.sin(t * DAPPLE_SWAY_HZ * Math.PI * 2) * DAPPLE_SWAY * DAPPLE_FREQ;
      // dapple fades with the key: no sun through the canopy means no dapple.
      const amp = DAPPLE_AMP * (1 - 0.55 * pal.night) * pal.shadowIntensity;
      const gust = 1 + GUST_AMP * Math.sin(t * GUST_HZ * Math.PI * 2)
                 + 0.030 * (gustEnv - 0.5);
      _dap.set(driftX - wx * sway, driftZ - wz * sway, amp, Math.max(gust, 0.05));
      L.uDapple.value.copy(_dap);
    }

    function apply(emit = true) {
      samplePalette(dayT, pal);
      writePhaseColors(L, pal);
      // live density sweep (cal-fog* scenarios) — applied AFTER the palette write
      // so a sweep never has to fight the per-frame palette refresh.
      if (calOverride.fogScale != null && L.uFogParams?.value) {
        L.uFogParams.value.x *= calOverride.fogScale;
      }
      if (calOverride.fogStart != null && L.uFogParams?.value) {
        L.uFogParams.value.z = calOverride.fogStart;
      }

      // ---- key light: whichever body is above the horizon owns the shadow.
      const keyDir = pal.keyAboveHorizon ? pal.sunDir : pal.moonDir;
      fitShadow(keyDir);
      writeCanopyOcc(keyDir);
      sun.color.copy(pal.sun);
      sun.intensity = pal.sunInt;
      // shadow.intensity is NOT a brightness dial — the ramp owns how dark a
      // shadow is. It is used only for the two physically real fades: the cast
      // shadow dissolving as the key grazes the horizon (which also hides the
      // sun -> moon handover), and a moon key throwing a far softer, weaker
      // shadow than a noon sun.
      sun.shadow.intensity = pal.shadowIntensity * (1 - 0.55 * pal.night);
      sun.castShadow = !shadowOff && pal.shadowIntensity > 0.004;

      // ---- cool fill: the shadow-tint colour (#6E76A8 at day), from the
      // anti-sun direction. Only stock lit materials ever see it.
      _v.copy(keyDir).negate().normalize();
      fill.position.copy(_v).multiplyScalar(60);
      fill.color.copy(pal.shadow);
      fill.intensity = 0.35;

      // ---- low warm back/rim graze, swung off the key azimuth
      const a = Math.atan2(keyDir.z, keyDir.x) + 1.05;
      back.position.set(Math.cos(a) * 58, 9, Math.sin(a) * 58);
      back.color.copy(pal.rim);
      back.intensity = pal.rimInt;

      // ---- hemisphere ambient (bloom stage lifts the garden a touch).
      // groundColor is the colour light takes on bouncing OFF the garden, not
      // the ground's own dark value — same correction as uGroundColor.
      hemi.color.copy(pal.sky);
      _bounce.copy(GROUND_BOUNCE).multiplyScalar(0.55);
      hemi.groundColor.copy(pal.ground).lerp(_bounce, 0.62 * (1 - pal.night));
      hemi.intensity = pal.hemi * bloomLift;

      // ---- sky gradient (shared by the IBL sphere and the fallback dome)
      skyU.uZenith.value.copy(pal.zenith);
      skyU.uHorizon.value.copy(pal.horizon);
      skyU.uGroundHaze.value.copy(pal.fog).multiplyScalar(0.62);
      skyU.uStars.value = Math.max(0, pal.night * pal.night);

      // ---- fog stays locked to uFogColor / uFogParams
      const fg = scene.fog;
      if (fg) {
        if (fg.color) fg.color.copy(L.uFogColor.value);
        if (fg.isFogExp2) fg.density = L.uFogParams.value.x;
      }

      // ---- animated key breakup (dapple + gust), see writeDapple()
      writeDapple();

      // ---- global shading calibration (shadow ratio / core / rim / key desat)
      writeShadowCal();

      // ---- aerial perspective + occlusion calibration
      writeAerialCal();

      // ---- local warm lamps (stone lanterns) into the shared bag
      lampCount = writeLamps();

      // ---- exposure + IBL weight
      renderer.toneMappingExposure = pal.exp;
      scene.environmentIntensity = pal.env;

      const rig = ctx.assets.lightRig;
      if (rig) { rig.phase = pal.phase; rig.dayT = pal.dayT; }

      if (emit && pal.phase !== lastPhase) {
        lastPhase = pal.phase;
        ctx.bus.emit('time:phase', { phase: pal.phase, t: pal.phaseT });
      }
    }

    ctx.assets.lightRig = {
      sun, hemi, fill, back, phase: pal.phase, dayT, palette: pal,
      /** world-space size of one shadow-map texel — handy for contact-shadow tuning */
      get shadowTexel() { return shadowTexel; },
    };

    apply(false);
    buildEnv(true);
    lastPhase = pal.phase;

    /* ---------------------------------------------------------------- *
     * Public API + debug scenarios
     * ---------------------------------------------------------------- */
    function setDayT(t, { emit = true } = {}) {
      dayT = ((t % 1) + 1) % 1;
      apply(emit);
      buildEnv(true);
      lastPhase = pal.phase;
      ctx.bus.emit('time:phase', { phase: pal.phase, t: pal.phaseT });
    }

    ctx.assets.lighting = {
      createNprMaterial: (o = {}) => createNprMaterial({ lightUniforms: L, ...o }),
      /** Retro-fit ART_BIBLE §2 onto a stock MeshStandard/Physical material. */
      applyNPR,
      skyUniforms: skyU,
      palette: pal,
      samplePalette,
      phaseOf,
      setDayT,
      setPhase: (name) => setDayT(PHASE_ANCHORS[name] ?? DEFAULT_DAY_T),
      /* ---- local warm lamps. The NPR model ignores three's own light
         accumulation, so a PointLight only lights this world through here.
         Either add a THREE.PointLight to the scene (auto-adopted) or register
         one explicitly with addLamp(); see the block above measureCasters(). */
      addLamp,
      maxLamps: MAX_LAMPS,
      get lampCount() { return lampCount; },
      get adoptedPointLights() { return _adopted.length; },
      get dayT() { return dayT; },
      set dayT(v) { setDayT(v); },
      pause(v = true) { paused = !!v; },
      dayLength: DAY_LENGTH,
    };

    /* ---------------------------------------------------------------- *
     * Calibration chart — HIDDEN unless the `calib` debug scenario runs.
     *
     * A VFX lighter shoots grey/chrome balls on set for a reason: you cannot
     * tune a shading model by looking at art. 50-smoke.js used to carry this
     * chart; it has been deleted now that the real tree has landed, so the
     * lighting rig carries its own. Every ball is a real createNprMaterial()
     * going through exactly the code path the scene uses.
     *
     *   0.18 grey  read the ramp bands and terminator width
     *   0.50 grey  read the SHADOW LUMINANCE RATIO (ART_BIBLE 2: ~0.55 of lit)
     *   near white read specular shape and highlight clipping
     *   pink       read hue behaviour of a saturated albedo through the ramp
     *   bark brown read that a shadowed warm albedo stays warm, not plum
     *
     * Floated clear of the grass on a slab so contact/cast shadow colour is
     * legible, and positioned in front of the tree for the hero camera.
     * ---------------------------------------------------------------- */
    const calib = new THREE.Group();
    calib.name = 'lighting-calibration-chart';
    calib.visible = false;
    {
      const ballGeo = new THREE.SphereGeometry(1.0, 48, 32);
      const chart = [
        [0x2E2E2E, {}], [0x7F7F7F, {}], [0xF2F2F2, { specScale: 1.4 }],
        [0xEE4C86, {}], [0x6A5344, {}],
      ];
      // WHERE these sit is the whole measurement. Requirements:
      //   - in the hero frame and in FOCUS (a DOF-blurred ball is not a number),
      //   - completely OUTSIDE the tree's cast shadow, so each ball carries a
      //     clean lit / terminator / form-shadow sweep of its own. z = -14 is
      //     14 m BEHIND the trunk, so the golden-hour key (azimuth ~+7,
      //     elevation ~34) leaves the tree entirely before it could occlude
      //     them; at z = +3 four of the five balls sat under a branch and read
      //     brighter on their shadow flank than on their lit one.
      chart.forEach(([color, o], i) => {
        const m = new THREE.Mesh(ballGeo, createNprMaterial({ lightUniforms: L, color, ...o }));
        m.position.set(-2.0 + i * 2.05, 3.4, -14.0);
        m.castShadow = m.receiveShadow = true;
        calib.add(m);
      });
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(13.5, 0.4, 3.6),
        createNprMaterial({ lightUniforms: L, color: 0xBFB8AA, specScale: 0.3, rimScale: 0.35 }),
      );
      slab.position.set(2.1, 2.2, -14.0);
      slab.receiveShadow = true;          // a flat receiver must not self-cast
      calib.add(slab);
      calib.userData.dispose = () => {
        ballGeo.dispose();
        calib.traverse((o) => { o.material?.dispose?.(); if (o !== calib) o.geometry?.dispose?.(); });
      };
    }
    group.add(calib);

    const sc_ = (window.__game && window.__game.scenarios) || null;
    if (sc_) {
      sc_['calib'] = () => { calib.visible = true; measureCasters(); apply(false); };
      // ...and without the post pipeline, so the shading model can be measured
      // before bloom/DOF/grade rather than through them.
      sc_['calib-raw'] = () => {
        ctx.pipeline = null; calib.visible = true; measureCasters(); apply(false);
      };
      for (const name of ['dawn', 'day', 'dusk', 'night']) {
        sc_[`calib-${name}`] = () => {
          calib.visible = true; setDayT(PHASE_ANCHORS[name]); measureCasters(); apply(false);
        };
      }
      // `raw-*` bypasses the post pipeline so the lighting rig can be judged
      // (and regression-shot) without bloom/DOF/grade on top of it.
      const noPost = () => { ctx.pipeline = null; };
      for (const name of ['dawn', 'day', 'dusk', 'night']) {
        sc_[name] = () => { setDayT(PHASE_ANCHORS[name]); };
        sc_[`raw-${name}`] = () => { noPost(); setDayT(PHASE_ANCHORS[name]); };
      }
      // Two stand-in stone lanterns at the lantern-preset height, so the NPR
      // point-light path can be proven before 35-props.js ships its own. Uses
      // the public addLamp() API, i.e. exactly what a props module would call.
      sc_['lamptest'] = () => {
        addLamp({ position: [3.4, 1.35, 4.2], color: 0xFFC073, intensity: 9, range: 9 });
        addLamp({ position: [-4.6, 1.35, 2.0], color: 0xFFB25E, intensity: 7, range: 8 });
        apply(false);
      };
      sc_['lamptest-night'] = () => { sc_['lamptest'](); setDayT(PHASE_ANCHORS.night); };
      sc_['lamptest-dusk'] = () => { sc_['lamptest'](); setDayT(PHASE_ANCHORS.dusk); };
      // A/B switch for MEASURING the cast shadow. Colour-coded shader debug is
      // unreliable through the tonemap + grade + bloom chain, so the honest way
      // to ask "how much does the cast shadow darken this pixel" is to render the
      // same frame with the shadow map off and divide.
      sc_['noshadow'] = () => { sun.castShadow = false; shadowOff = true; apply(false); };
      // ...and the same with the canopy shade pool off too, so "how much darker is
      // this patch of ground because the tree is standing on it" is one division.
      sc_['noshade'] = () => {
        sun.castShadow = false; shadowOff = true; poolOff = true; apply(false);
      };
      sc_['nopool'] = () => { poolOff = true; apply(false); };
      /* ---- live calibration sweeps for uShadowCal. Shadow ratio, core depth,
         rim gain and key desaturation are uniforms precisely so that
         ART_BIBLE §2's numbers can be MEASURED in the final graded png instead
         of guessed at: shoot `--scenario calib-s60` etc. and divide.        */
      for (const v of [30, 40, 50, 60, 70, 80, 90, 100, 120, 140]) {
        sc_[`cal-s${v}`] = () => { calOverride.ratio = v / 100; apply(false); };
        sc_[`calib-s${v}`] = () => {
          calOverride.ratio = v / 100; calib.visible = true; measureCasters(); apply(false);
        };
      }
      for (const v of [0, 40, 70, 100, 130, 160, 200, 260]) {
        sc_[`cal-rim${v}`] = () => { calOverride.rim = v / 100; apply(false); };
        sc_[`cal-rim${v}-dusk`] = () => {
          calOverride.rim = v / 100; setDayT(PHASE_ANCHORS.dusk);
        };
      }
      for (const v of [0, 25, 45, 65, 85]) {
        sc_[`cal-desat${v}-dusk`] = () => {
          calOverride.desat = v / 100; setDayT(PHASE_ANCHORS.dusk);
        };
      }
      /* ---- aerial-perspective sweeps. ART_BIBLE §8.3 and §8.9 pull in opposite
         directions (no haze = no depth, too much haze = a milky band), so the
         only honest way to place these is to render the sweep and measure the
         luminance of each receding plane against the sky above it.
           cal-aer<N>   haze target LEVEL as a % of uFogColor
           cal-keep<N>  % scale on BOTH value-preservation keeps
           cal-fog<N>   % scale on the palette's own fog density
           cal-occ<N>   ambient occlusion exponent x100 (the frame's dark anchor)
           cal-pool<N>  % scale on the canopy shade pool (the tree's grounding) */
      for (const v of [50, 62, 70, 78, 86, 94, 100]) {
        sc_[`cal-aer${v}`] = () => { calOverride.aerLevel = v / 100; apply(false); };
      }
      for (const v of [0, 40, 70, 100, 130, 170]) {
        sc_[`cal-keep${v}`] = () => { calOverride.aerKeep = v / 100; apply(false); };
      }
      for (const v of [0, 40, 60, 80, 100, 130]) {
        sc_[`cal-fog${v}`] = () => { calOverride.fogScale = v / 100; apply(false); };
        sc_[`cal-fog${v}-wide`] = () => { calOverride.fogScale = v / 100; apply(false); };
      }
      /* ...and the DISTANCE at which the haze starts accumulating, in metres.
         This is a different lever from density and the pair have to be swept
         separately: `start` decides how much of the PLAYABLE field is hazed at
         all, `density`/`pow` decide how fast the far edge converges. Cutting
         density to clean up the mid-ground also stops the far edge reading as air
         (measured in r4); pushing the start out does not. */
      for (const v of [30, 40, 48, 55, 64, 76]) {
        sc_[`cal-start${v}`] = () => { calOverride.fogStart = v; apply(false); };
      }
      for (const v of [100, 135, 185, 220, 240, 260, 300]) {
        sc_[`cal-occ${v}`] = () => { calOverride.occPow = v / 100; apply(false); };
      }
      for (const v of [0, 60, 100, 140, 180, 220]) {
        sc_[`cal-pool${v}`] = () => { calOverride.pool = v / 100; apply(false); };
      }
      /* ...and how much fake key fill survives inside a genuinely ENCLOSED pocket
         (NPR_SHADOW_AO x this). The only lever in the model that can lower the
         frame's histogram floor WITHOUT touching the open cast shadow, so it is
         the one to sweep when a review asks for a lower lum p1. MEASURED in r5:
         the graded p1 barely responds (see the note on NPR_SHADOW_AO), because
         the post grade's shadow lift pins it — sweep this before assuming the
         shading model is at fault. */
      for (const v of [40, 60, 80, 100, 140]) {
        sc_[`cal-ao${v}`] = () => { calOverride.aoScale = v / 100; apply(false); };
      }
      /* ...and the pool's RADIUS in metres, which is the other half of the
         "contact shadow, not smudge" calibration: depth alone cannot both land
         ART_BIBLE §2's near-trunk ratio and stop the shade sprawling. */
      for (const v of [50, 62, 76, 90, 104, 120]) {
        sc_[`cal-poolr${v}`] = () => { calOverride.poolR = v / 10; measureCasters(); apply(false); };
      }
      /* ---- REAL THREE.PointLight adoption, as opposed to the addLamp() path
         above. 35-props.js lights its stone lanterns by adding PointLights to the
         scene graph and relying on this rig to adopt them into uLampPos /
         uLampColor (a bare PointLight is invisible to every NPR surface). This
         scenario adds five — one more than NPR_MAX_LAMPS — so the ranking, the
         slot cap and the per-fragment cost can all be measured without waiting
         on the props module. */
      sc_['lamptest-adopt'] = () => {
        const spots = [[3.4, 1.35, 4.2, 0xFFC073, 9, 9], [-4.6, 1.35, 2.0, 0xFFB25E, 7, 8],
          [6.2, 1.35, -1.4, 0xFFC073, 8, 9], [-1.2, 1.35, 6.4, 0xFFB25E, 7, 8],
          [-7.0, 1.35, -3.2, 0xFFC073, 6, 7]];
        for (const [x, y, z, hex, int, dist] of spots) {
          const pl = new THREE.PointLight(0xffffff, int, dist);
          pl.color.setHex(hex, THREE.SRGBColorSpace);
          pl.position.set(x, y, z);
          pl.name = 'lamptest-adopt';
          scene.add(pl);                      // scene root, NOT our group
        }
        sweepScene(true); apply(false);
      };
      sc_['lamptest-adopt-night'] = () => {
        sc_['lamptest-adopt'](); setDayT(PHASE_ANCHORS.night);
      };
      sc_['lamptest-adopt-dusk'] = () => {
        sc_['lamptest-adopt'](); setDayT(PHASE_ANCHORS.dusk);
      };
      sc_['golden'] = () => { setDayT(DEFAULT_DAY_T); };
      sc_['noon'] = () => { setDayT(0.5); };
      sc_['raw'] = () => { noPost(); setDayT(DEFAULT_DAY_T); };
      sc_['nopost'] = noPost;
    }

    /* ---------------------------------------------------------------- *
     * The NPR retro-fit, published for everyone.
     *
     * ART_BIBLE §2 is only shipped if it actually runs on visible pixels, so
     * this rig does not wait for surface modules to opt in: it hands out
     * `ctx.assets.applyNPR(material, opts)` and, on top of that, sweeps the
     * scene for any MeshStandard/MeshPhysical material that has not been
     * shaded yet and installs the model on it. Opt out with
     * `material.userData.noNpr = true`.
     * ---------------------------------------------------------------- */
    function applyNPR(material, opts = {}) {
      if (Array.isArray(material)) { for (const m of material) applyNPR(m, opts); return material; }
      if (!material || material.userData?.noNpr) return material;
      return applyNprToStandard(material, { lightUniforms: L, ...opts });
    }
    ctx.assets.applyNPR = applyNPR;

    /** Per-surface tuning guesses for materials nobody told us about.
        The knob that varies is how many DEGREES of hue rotation toward
        uShadowTint each family may take (ART_BIBLE §3): a petal's shadow is
        #EE8CAF and must stay unmistakably pink, bark goes to a cool brown, grass
        may swing furthest. None of them may land ON the tint's own hue. */
    function autoOpts(mesh, mat) {
      const c = mat.color;
      // pink-ish + translucent => foliage/petals; keep them PINK in shadow
      if (c && c.r > c.b && c.b > c.g * 0.9 && c.r > 0.25) {
        return {
          translucency: 1.0, thickness: 0.85, rimScale: 1.15, specScale: 0.22,
          shadowHueMax: 16, shadowChroma: 0.45,
        };
      }
      const geo = mesh.geometry;
      if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
      const r = geo?.boundingSphere?.radius ?? 1;
      // a huge ground plane grazes over half the frame — the rim must be almost off
      if (r > 20) {
        return { translucency: 0, thickness: 0.3, specScale: 0.16, rimScale: 0.06, shadowHueMax: 34 };
      }
      // bark / stone / small props: cool the shadow without repainting it blue
      return { specScale: 0.10, rimScale: 0.75, shadowHueMax: 26, shadowChroma: 0.55 };
    }

    let sweepChildren = -1;
    let sweepCountdown = 0;
    function sweepScene(force = false) {
      if (!force && scene.children.length === sweepChildren && sweepCountdown-- > 0) return;
      sweepChildren = scene.children.length;
      sweepCountdown = NPR_RESCAN_FRAMES;
      collectPointLights();
      scene.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m || m.__npr || m.userData?.noNpr) continue;
          if (!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) continue;
          applyNPR(m, autoOpts(o, m));
        }
      });
    }

    /* ---------------------------------------------------------------- *
     * Placeholder-scene adoption.
     *
     * 50-smoke.js is the temporary smoke-test tree. It ships its own sun and
     * hemisphere light, which would fight this rig and give a washed-out
     * double-lit frame, and ART_BIBLE-illegal albedos. While it is present we
     * mute its lights and recolour it; the NPR sweep above then shades it, so
     * the frame you judge is shaded by exactly the code path Phase 2 inherits.
     * Guarded by module name, so it becomes a no-op the moment the real world
     * modules land — and it never touches any other module's objects.
     * ---------------------------------------------------------------- */
    function adoptPlaceholder() {
      const smoke = ctx.modules.get('smoke');
      const root = smoke && smoke.object3D;
      if (!root || root.userData.__nprAdopted) return;
      root.userData.__nprAdopted = true;
      const kill = [];
      root.traverse((o) => {
        if (o.isLight) { kill.push(o); return; }
        if (!o.isMesh) return;
        const geo = o.geometry;
        if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
        const r = geo?.boundingSphere?.radius ?? 1;
        const mat = o.material;
        if (mat?.color) {
          if (geo?.type === 'IcosahedronGeometry') mat.color.setHex(0xffb6ce, THREE.SRGBColorSpace);
          else if (r > 20) mat.color.setHex(0x5E8040, THREE.SRGBColorSpace);
          else mat.color.setHex(0x6a5344, THREE.SRGBColorSpace);
        }
        o.receiveShadow = true;
        // A big flat receiver must not cast — it only self-shadows into acne.
        // A single convex blob cannot legitimately cast onto itself either.
        o.castShadow = r < 20;
        if (geo?.type === 'IcosahedronGeometry') o.receiveShadow = false;
      });
      for (const l of kill) { l.intensity = 0; l.visible = false; if (l.castShadow) l.castShadow = false; }
    }

    ctx.bus.on('game:ready', () => {
      adoptPlaceholder();
      sweepScene(true);
      measureCasters();
      apply(false);
      // A real sky module owns the background; drop the fallback dome for it.
      if (ctx.modules.has('sky')) { group.remove(dome); dome.visible = false; }
    });

    /* Growth stages brighten the tree's world a touch — cheap but it reads. */
    ctx.bus.on('bloom:stage', (p) => {
      const s = THREE.MathUtils.clamp((p?.stage ?? 0) / 5, 0, 1);
      bloomLift = 1 + 0.12 * s;
    });

    let envAccum = 0;
    let casterAccum = 99;
    return {
      object3D: group,
      update(dt) {
        if (!paused) dayT = (dayT + dt / DAY_LENGTH) % 1;
        advanceDapple(dt);
        // Late-booting modules inherit the shading model and the shadow fit.
        sweepScene(false);
        casterAccum += dt;
        if (casterAccum > 0.5) { casterAccum = 0; measureCasters(); }
        apply(true);
        // Border shadow samples must read "unoccluded", never wrap round.
        const sm = sun.shadow.map;
        if (sm?.texture && !sm.__sakuraClamped) {
          sm.__sakuraClamped = true;
          sm.texture.wrapS = sm.texture.wrapT = THREE.ClampToEdgeWrapping;
        }
        // Regenerate the IBL only when the phase has moved materially.
        envAccum += dt;
        if (envAccum > 1.0) { envAccum = 0; buildEnv(false); }
      },
      dispose() {
        calib.userData.dispose?.();
        pmrem.dispose();
        envRT?.dispose();
        envSphereGeo.dispose(); envSkyMat.dispose();
        domeGeo.dispose(); domeMat.dispose();
        scene.environment = null;
        ctx.assets.envMap = null;
        ctx.assets.applyNPR = null;
      },
    };
  },
};
