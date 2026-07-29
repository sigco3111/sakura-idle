import * as THREE from 'three';
import { makeRng } from '../lib/rng.js';
import { fbm3 } from '../lib/noise.js';
import { WIND } from '../lib/wind.js';
import {
  PROPS_STONE_VERT, PROPS_STONE_FRAG,
  PROPS_WOOD_VERT, PROPS_WOOD_FRAG,
  PROPS_WINDOW_VERT, PROPS_WINDOW_FRAG,
  PROPS_HALO_VERT, PROPS_HALO_FRAG,
  PROPS_BASIN_VERT, PROPS_BASIN_FRAG,
} from '../lib/props-shaders.js';

/**
 * 35-props.js — the built environment. What turns a field into a PLACE.
 *
 *   a weathered vermilion myojin TORII straddling the stone path,
 *   four granite ISHIDORO along the approach whose fire boxes light at dusk,
 *   a low mossy STONE WALL part-enclosing the rise, contour-following,
 *   mossy BOULDERS, a TSUKUBAI water basin with a bamboo spout,
 *   and an EMA plaque rack whose boards swing in the global wind.
 *
 * Publishes  ctx.assets.props = {
 *   group      the root THREE.Group (world space, identity transform)
 *   torii      { mesh, position:Vector3, rotationY, width, height, pathT }
 *   lanterns   [ { position, flameY, flame:Vector3(world flame centre), scale } ]
 *   wall       { mesh, radius, azFrom, azTo, count }
 *   basin, boulders, ema, glow(0..1)
 * }
 *
 * PLACEMENT IS COMPOSITION, not decoration. Every position below was chosen by
 * back-projecting src/core/cameras.js:
 *
 *  - `hero` (14,6.5,21)->(0,7.5,0): its bottom edge meets the ground ~18.8 m out,
 *    so the visible ground all lies BEYOND the trunk. The torii sits at 74% of the
 *    way to the right edge and the three approach lanterns march 0.14 -> 0.56 ->
 *    0.84 across the same half, each one deeper than the last: that is the leading
 *    line. A fourth lantern, the basin and a big boulder hold the lower LEFT so
 *    the frame balances, and the wall arc crosses behind the trunk from 48% left
 *    to 63% right — the horizontal that separates the rise from the field.
 *  - `lantern` (5,1.6,7)->(1.4,1.3,1.6) shares the hero sight line, so its subject
 *    is a lantern at (3.02, 1.59) whose fire box sits at y = ground + 1.33 — the
 *    preset's own target height. It reads 40% right of centre there and only 4.2 deg
 *    off axis in `hero`, which is exactly enough to clear the trunk silhouette.
 *  - `wide` (30,11,38): torii at 57% right, the whole wall arc and every lantern in
 *    frame, the path threading them together.
 *  - `pond` (-3,2.2,14)->(-9,0.4,6): a shoreline boulder 4.7 m from the lens.
 *
 * Nothing casts a shadow that would inflate 08-lighting's fitted ortho box past
 * ~12 m of caster radius: the wall and the far boulders receive only. Contact
 * darkening is baked AO on the last 300 mm of every ground-meeting member plus
 * the post chain's SSAO — never a painted dark blob.
 *
 * ------------------------------------------------------------------------------
 * MEASURED — shots/props-p4-r9 (1920x1080, warm 420, q ultra, --ui 0).
 *
 * The post chain's transfer, calibrated in one shot with `--scenario props-bands`
 * (five horizontal bands of linear #9E9A92 at 1, 1/2, 1/4, 1/8, 1/16 written
 * straight to the framebuffer): scene-linear 0.333 prints display L 0.560 and
 * 0.0208 prints 0.051, i.e.
 *
 *     display L  ~=  0.560 * (scene_luma / 0.333) ^ 0.864
 *
 * Use it before tuning anything here. It is what turned "the stone looks wrong"
 * into "the albedo is 2.4x too dark", which was the actual defect.
 *
 * lantern preset, granite patches (mean L / luminance sd), r1 -> r9:
 *   kasa dome          0.293 -> 0.546   sd 0.031 -> 0.123
 *   kasa eave soffit   0.120 -> 0.303   sd 0.019 -> 0.073
 *   fire-box post      0.231 -> 0.325   sd 0.070 -> 0.083
 *   chudai top         0.120 -> 0.330   sd 0.073 -> 0.077
 *   chudai underside   0.204 -> 0.325   sd 0.087 -> 0.106
 *   sao shaft          0.937 -> 0.293   sd 0.014 -> 0.070
 *   sao collar         0.274 -> 0.341   sd 0.106 -> 0.064
 *   warabite tip       0.738 -> 0.334   sd 0.187 -> 0.135
 * Whole prop now inside the review's [0.24, 0.72] band with 8 of 10 patches at
 * sd >= 0.070 (lowest 0.064). Nothing on it is a flat solid and nothing is blown.
 *
 * CAVEAT for whoever measures next: patch sd at the lantern preset is DOF-limited,
 * not albedo-limited. Between r10 and r11 90-postfx widened the CoC and the same
 * eight patches fell to sd 0.057-0.140 with their means unchanged — the lantern sits
 * 0.7 m in front of the focus plane at 6.5 m. Re-measure sd on `bark` or `wide`, or
 * after 90-postfx lands its "nothing in frame is sharp" fix, before concluding the
 * granite is flat. `--scenario props-albedo` shows what the material actually has.
 *
 * hero preset: torii pillar (shade side) 0.160, min 0.116 — legitimately dark,
 * ART_BIBLE's #C4322B is only L 0.316 LIT and the gate's camera-facing width is
 * all shade in a backlit composition. kasagi 0.685. wall blocks 0.443 sd 0.189.
 * 62 draw calls whole scene, 15.1 ms/frame steady state of which props are 1.25 ms
 * (A/B'd by toggling group.visible). stats.mjs: all gates pass on hero/wide/pond,
 * crushed 0, blown 0, flatBlocks 0.049-0.084.
 *
 * Verified at --q low (58 calls, zero module errors) and through the full clock via
 * `--scenario lamptest-dusk` / `lamptest-night`: night granite 0.209-0.375 with the
 * fire-box emission and halo untouched, dusk 0.227-0.356.
 */

/* ------------------------------------------------------------------ *
 * Palette (ART_BIBLE §3) + tuning
 * ------------------------------------------------------------------ */
const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const PAL = {
  /**
   * ART_BIBLE §3, authored exactly as written. r6 authored these 21% darker
   * because a 0xC4322B pillar printed at sRGB (234,187,167) — pastel pink. The
   * cause was not the key's magnitude: it was the inside-out `tube()` winding
   * (see the note there), which shaded every pillar as fully sunlit AND fired
   * both rim terms at full strength across its whole width. With the winding
   * fixed the authored values are the right ones again.
   */
  vermilion: 0xC4322B,
  vermWorn: 0x8E3A32,
  /* Bare weathered cryptomeria. MEASURED why these are warmer and lighter than
   * r9's #877662 / #4E4034: nprShadowHue multiplies a shadowed albedo by
   * uShadowTint renormalised to unit luminance, which is (0.81, 0.95, 2.06), so
   * any albedo whose linear R/B is below ~2.2 comes out BLUE-dominant. #877662 is
   * 2.03 and printed the exposed timber on the torii as saturated navy
   * (rgb(38,30,66) measured on the kasagi). #9A8365 is 2.55 and #5A4838 is 2.44:
   * both cool toward the tint without ever flipping channel dominance, which is
   * what ART_BIBLE §2 asks for and §8.4 forbids the alternative of. */
  woodLite: 0x9A8365,      // sun-bleached bare cryptomeria
  woodDark: 0x5A4838,
  stoneLite: 0x9E9A92,
  stoneDark: 0x6E6A62,
  mossLite: 0x77934F,
  mossDark: 0x4A6636,
  moss: 0x5C7A3E,
  lichen: 0x9AA88C,
  bambooLite: 0xB6BC7A,
  bambooDark: 0x6E7A3E,
  emaWood: 0xD8C6A4,
  // the gaku name-board's limewash. Deliberately near-white: it is the only
  // near-neutral albedo on the gate, and only a HIGH value survives the shade
  // multiply as a light cool grey instead of the navy a mid grey lands on.
  plaster: 0xE4D8BE,
  ink: 0x8E2A24,
  paper: 0xFFD9A0,
  paperCold: 0x3A3630,
  /* Washi seen by DAYLIGHT with a dark iron burner behind it — the fire box's
   * albedo when there is no fire. CALIBRATED against the measurement the brief
   * asks for: at #C8B08A (linear luma 0.448) with ao 0.72 the fire box printed
   * display luma 0.376 against the lantern's own granite at 0.487-0.515, i.e.
   * four dark holes. Display L ~= 0.56*(scene/0.333)^0.864 here, so landing the
   * box on ~0.66 needs 2.05x the scene value: ao 0.72 -> 1.00 (a sheet of paper
   * spanning an opening is not an occluded crevice) supplies 1.39x and this
   * albedo's 0.673 linear luma the remaining 1.50x. r3 measured 0.515 against
   * stone 0.481-0.503 — above it, but by too little to read as the lantern's
   * focal point, so this is one more step to 0.759 linear luma. It stays WARM
   * rather than going toward white on purpose: lightening a colour toward white
   * lowers its R/B ratio, and below ~1.81 the shade multiply flips the sheet blue
   * (see the window material's NPR_SHADOW_TINT). #F4E0B4 is 1.98. */
  paperDay: 0xF4E0B4,
  flame: 0xFFE7B4,
  halo: 0xFFA85C,
};

const SEED = 0x5A4B12;

/** Diagnostic-only shader defines, driven by ?propsdbg=albedo|norim in the URL.
 *  Empty in every normal run; the harness never sets it. */
const PROPS_DBG = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('propsdbg');
    if (q === 'albedo') return { PROPS_DBG_ALBEDO: '' };
    if (q === 'norim') return { PROPS_DBG_NORIM: '' };
  } catch { /* no window */ }
  return {};
})();

/** Where the torii stands, as a parameter along the terrain's path curve. */
const TORII_T = 0.320;
const TORII_SPAN = 4.40;        // pillar centre to pillar centre
const TORII_H = 4.85;           // ground to the underside of the shimaki
/**
 * Extra yaw, in radians, on top of "square to the path".
 *
 * MEASURED, not a whim. At TORII_T the path's tangent is (-0.868, 0.496) and the
 * hero camera's view axis is (-0.557, -0.836) — 86 deg apart, i.e. the approach
 * runs almost exactly ACROSS the frame. A gate square to that approach therefore
 * presents its span almost along the view axis and projects to about 40% of its
 * true width: r3 put a 3.44 m torii on screen 1.4 m wide, a sliver. Rotating the
 * gate 38 deg roughly doubles the projected span (measured 1.4 m -> 2.9 m in
 * `hero`) while still reading as a gate ON the path, because the path curves
 * through here anyway. Real shrine torii are set square to the SHRINE axis rather
 * than to a meandering approach, which is the same licence.
 */
const TORII_SKEW = 0.663;       // 38 deg

/** Lantern stations: [pathT, lateral offset in metres (+ = camera side)].
 *
 * SCALE, MEASURED rather than eyeballed. The lantern geometry below is 2.29 m
 * from the buried kiso to the top of the hoju at scale 1. Projected into `hero`
 * (probe, 1920x1080): the 14 m tree is 922 px, the 5.60 m torii 390 px, and the
 * two lanterns nearest the lens were 181 / 156 px — dimensionally coherent
 * (69.7 px/m on the torii at 26.6 m against 75.9 px/m on a lantern at 23.0 m), so
 * they were never actually toy-sized. They did however read light next to a
 * 922 px tree, so the ones that can afford it are up to 2.5-2.7 m, ordinary for a
 * kasuga-style ishidoro on a shrine approach.
 *
 * STATION 0 IS PINNED AT 1.00 AND MUST STAY THERE. It is the `lantern` preset's
 * subject, and that camera has almost no headroom over it: MEASURED, at the
 * effective 1.044 the seeded jitter gives it the hoju finial sits 25 px below the
 * top of a 1080-line frame with the prop 425+ px tall, i.e. 1.2% of slack. A
 * round that tried 1.14 here cut the finial and the near half of the kasa clean
 * off the top of shots/props-p5-r5/lantern.png. The foreground read is bought on
 * station 3 instead — it is the one closest to the `hero` lens (23.7 m) and it
 * has open sky above it in every preset. */
const LANTERN_STATIONS = [
  { t: 0.462, lateral: 2.62, scale: 1.00 },   // the `lantern` preset's subject
  { t: 0.375, lateral: 2.10, scale: 1.02 },
  { t: 0.290, lateral: 2.10, scale: 1.06 },
  { t: 0.545, lateral: 2.35, scale: 1.10 },   // west of the trunk, balances hero
];

/** Wall arc: degrees of world azimuth (atan2(z,x)), radius in metres. */
// r = 14.5, not 12.5: at 12.5 the whole arc sat inside the canopy's cast-shadow
// ellipse and the wall printed at lum 0.10 — a dark ditch rather than masonry.
const WALL_AZ0 = 178, WALL_AZ1 = 316, WALL_R = 14.5;

const TIER = {
  ultra: { blockSeg: 2, wallRows: 3, blockStep: 0.72, ema: 14, lights: 4, rock: 2 },
  high: { blockSeg: 2, wallRows: 3, blockStep: 0.76, ema: 12, lights: 4, rock: 2 },
  medium: { blockSeg: 1, wallRows: 3, blockStep: 0.88, ema: 9, lights: 2, rock: 1 },
  low: { blockSeg: 1, wallRows: 3, blockStep: 1.02, ema: 7, lights: 0, rock: 1 },
};

/* ------------------------------------------------------------------ *
 * A tiny mesher. Accumulates quads and whole geometries into one
 * BufferGeometry carrying arbitrary extra float attributes, so a prop can bake
 * its own wear / moss / AO fields instead of relying on a texture.
 * ------------------------------------------------------------------ */
class Mesher {
  /** @param {Object<string,number>} spec extra attribute name -> itemSize */
  constructor(spec = {}) {
    this.spec = spec;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
    this.ex = {};
    for (const k of Object.keys(spec)) this.ex[k] = [];
    this.n = 0;
  }

  _attrs(vals, world, local) {
    for (const k of Object.keys(this.spec)) {
      const size = this.spec[k];
      let v = vals ? vals[k] : 0;
      if (typeof v === 'function') v = v(world, local);
      if (v == null) v = 0;
      if (typeof v === 'number') { for (let s = 0; s < size; s++) this.ex[k].push(v); }
      else { for (let s = 0; s < size; s++) this.ex[k].push(v[s] ?? 0); }
    }
  }

  _vert(p, n, u, vals, local) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u[0], u[1]);
    this._attrs(vals, p, local ?? p);
    return this.n++;
  }

  /**
   * One flat quad. `ref` is a point KNOWN to be inside the solid; the winding is
   * flipped if needed so the face normal points away from it. That makes every
   * builder below immune to me getting a corner order backwards.
   */
  quad(p0, p1, p2, p3, ref, vals, uvs) {
    const e1 = _v1.subVectors(p1, p0);
    const e2 = _v2.subVectors(p2, p0);
    const nn = _v3.crossVectors(e1, e2);
    if (nn.lengthSq() < 1e-12) return;
    nn.normalize();
    const cen = _v4.copy(p0).add(p1).add(p2).add(p3).multiplyScalar(0.25);
    let a = p0, b = p1, c = p2, d = p3;
    let uu = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    if (ref && nn.dot(_v5.subVectors(cen, ref)) < 0) {
      nn.negate();
      a = p3; b = p2; c = p1; d = p0;
      uu = [uu[3], uu[2], uu[1], uu[0]];
    }
    const i0 = this._vert(a, nn, uu[0], vals);
    const i1 = this._vert(b, nn, uu[1], vals);
    const i2 = this._vert(c, nn, uu[2], vals);
    const i3 = this._vert(d, nn, uu[3], vals);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** One triangle, wound so its normal points away from `ref`. Used for the
   *  end caps of a chamfered beam, which are no longer quads. */
  tri(p0, p1, p2, ref, vals) {
    const nn = _v3.crossVectors(_v1.subVectors(p1, p0), _v2.subVectors(p2, p0));
    if (nn.lengthSq() < 1e-14) return;
    nn.normalize();
    const cen = _v4.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3);
    let a = p0, b = p1, c = p2;
    if (ref && nn.dot(_v5.subVectors(cen, ref)) < 0) { nn.negate(); a = p2; c = p0; }
    const i0 = this._vert(a, nn, [0.5, 0.0], vals);
    const i1 = this._vert(b, nn, [1.0, 1.0], vals);
    const i2 = this._vert(c, nn, [0.0, 1.0], vals);
    this.idx.push(i0, i1, i2);
  }

  /** Splice in an existing indexed/non-indexed geometry, transformed. */
  addGeo(geo, mtx, vals) {
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    const u = geo.attributes.uv;
    const nm = _m3.getNormalMatrix(mtx);
    const base = this.n;
    for (let i = 0; i < p.count; i++) {
      _lv.fromBufferAttribute(p, i);
      _wv.copy(_lv).applyMatrix4(mtx);
      if (n) _nv.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      else _nv.set(0, 1, 0);
      this.pos.push(_wv.x, _wv.y, _wv.z);
      this.nrm.push(_nv.x, _nv.y, _nv.z);
      if (u) this.uv.push(u.getX(i), u.getY(i)); else this.uv.push(0, 0);
      this._attrs(vals, _wv, _lv);
      this.n++;
    }
    const gi = geo.index;
    if (gi) for (let i = 0; i < gi.count; i++) this.idx.push(base + gi.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(name = 'props') {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k of Object.keys(this.spec)) {
      g.setAttribute(k, new THREE.Float32BufferAttribute(this.ex[k], this.spec[k]));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _lv = new THREE.Vector3(), _wv = new THREE.Vector3(), _nv = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

/* ------------------------------------------------------------------ *
 * Primitive builders (all world-space, all fed through Mesher)
 * ------------------------------------------------------------------ */

/**
 * A faceted solid of revolution. `profile` is [[radius, height], ...] traced
 * along the silhouette; 6 segments gives the hexagonal granite look a real
 * ishidoro has (ART_BIBLE §8.5 forbids faceting on ORGANIC shapes — cut stone
 * is meant to be faceted).
 */
function lathe(M, profile, segs, origin, yaw, vals, refY) {
  latheN(M, profile, segs, origin, yaw, vals, refY, 0, 0);
}

/**
 * `lathe` with a CHAMFERED regular-polygon cross-section.
 *
 *   sides  0 = a plain circle (use segs >= 20 so no silhouette facet reads);
 *          n = an n-sided cut-stone prism whose corners are cut back.
 *   chamf  fraction of each corner's angular half-width taken by the bevel.
 *
 * WHY. shots/critic-p4-r1/lantern-f0.png measured "5 hard unbeveled facets" on
 * the kasa and "a visible hexagonal frustum" on the chudai — both were plain
 * 6-segment lathes, so their silhouettes showed 6 straight edges and their faces
 * showed a single flat shading value each. A real ishidoro IS hexagonal (ART_BIBLE
 * §8.5 forbids faceting on ORGANIC shapes, and cut granite is not organic), so the
 * fix is not to make it round: it is to cut the arrises, which is what a mason
 * actually does. r(theta) = 1/cos(clamp(d, -dc, dc)) with dc = (pi/n)(1-chamf)
 * gives n faces plus n flat bevel strips = 2n silhouette segments — 12 for a
 * hexagon, which is the reviewer's floor — and each bevel catches its own light
 * value, which is what makes cut stone read as cut stone.
 */
function latheN(M, profile, segs, origin, yaw, vals, refY, sides = 0, chamf = 0.28) {
  const ref = _rv.set(origin.x, origin.y + (refY ?? 0), origin.z);
  const step = sides > 2 ? (Math.PI * 2) / sides : 0;
  const dc = sides > 2 ? (step * 0.5) * (1 - Math.min(0.9, Math.max(0, chamf))) : 0;
  /** radius multiplier for the chamfered prism at absolute angle `a` */
  const rMul = (a) => {
    if (sides <= 2) return 1;
    let d = ((a % step) + step) % step - step * 0.5;
    return 1 / Math.cos(Math.min(dc, Math.max(-dc, d)));
  };
  /**
   * AZIMUTH SAMPLING. This is the fix for "the lantern roof is a fuzzy blob with
   * no lit/shadow facet separation".
   *
   * MEASURED, shots/props-r1/lantern.png: the kasa's six roof facets are 60 deg
   * apart in azimuth and the key sits at roughly (-0.15, 0.60, -0.77), so their
   * half-Lambert values SHOULD differ by ~0.25. They measured 0.05 apart
   * (roofL 0.327 / roofC 0.499 / roofR 0.379). Two causes: the shader was
   * randomising the shading normal (fixed in props-shaders.js), and the uniform
   * `segs` sampling below cut every facet into 6 quads whose boundaries did not
   * line up with the chamfer boundaries — so no quad was the facet, each was a
   * mongrel of face and bevel and the flat-shaded normal of each was a different
   * average. Sampling the face EXACTLY at its two chamfer boundaries makes the
   * face one planar quad per profile row with one true normal, and the bevel two
   * narrow arc strips that catch their own value. A hexagon then presents
   * 6 x (1 face + 2 bevels) = 18 silhouette segments, above the review's 12 floor.
   */
  let ang;
  if (sides > 2) {
    ang = [];
    const bev = 2;
    for (let i = 0; i < sides; i++) {
      const c = i * step + step * 0.5;
      ang.push(c - dc, c + dc);
      for (let k = 1; k < bev; k++) ang.push(c + dc + ((step - 2 * dc) * k) / bev);
    }
    ang.push(ang[0] + Math.PI * 2);
  } else {
    ang = [];
    for (let s = 0; s <= segs; s++) ang.push((s / segs) * Math.PI * 2);
  }
  const NS = ang.length - 1;
  const pt = (ri, si) => {
    const a = ang[si];
    const [r, y] = profile[ri];
    const rr = r * rMul(a);
    const aw = yaw + a;
    return new THREE.Vector3(origin.x + Math.cos(aw) * rr, origin.y + y, origin.z + Math.sin(aw) * rr);
  };
  for (let i = 0; i < profile.length - 1; i++) {
    if (profile[i][0] < 1e-5 && profile[i + 1][0] < 1e-5) continue;
    for (let s = 0; s < NS; s++) {
      M.quad(pt(i, s), pt(i, s + 1), pt(i + 1, s + 1), pt(i + 1, s), ref, vals,
        [[s / NS, i / profile.length], [(s + 1) / NS, i / profile.length],
          [(s + 1) / NS, (i + 1) / profile.length], [s / NS, (i + 1) / profile.length]]);
    }
  }
}
const _rv = new THREE.Vector3();

/**
 * Insert a 2-3% bevel ring at every sharp corner of a lathe profile.
 * `profile` is [[r,y],...]; each interior vertex whose incoming and outgoing
 * directions differ by more than `minAngle` is replaced by a pair of vertices
 * pulled `b` metres back along each leg. That is the "chamfer ring" the review
 * asked for on the cap and the collar: it turns a hard arris into a narrow strip
 * with its own shading value, so the silhouette gains two segments per corner
 * and the surface gains a highlight line instead of a black seam.
 */
function bevelProfile(profile, b = 0.014, minAngle = 0.35) {
  if (profile.length < 3) return profile;
  const out = [profile[0].slice()];
  for (let i = 1; i < profile.length - 1; i++) {
    const [pr, py] = profile[i - 1], [cr, cy] = profile[i], [nr, ny] = profile[i + 1];
    let ax = cr - pr, ay = cy - py; const al = Math.hypot(ax, ay) || 1e-6;
    let bx = nr - cr, by = ny - cy; const bl = Math.hypot(bx, by) || 1e-6;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    const turn = Math.acos(Math.min(1, Math.max(-1, ax * bx + ay * by)));
    if (turn < minAngle) { out.push([cr, cy]); continue; }
    const k = Math.min(b, al * 0.42, bl * 0.42);
    out.push([cr - ax * k, cy - ay * k]);
    out.push([cr + bx * k, cy + by * k]);
  }
  out.push(profile[profile.length - 1].slice());
  return out;
}

/** A smooth tapered tube from a to b — pillars, bamboo, rails. */
function tube(M, a, b, r0, r1, segs, vals, cap = true) {
  const T = _tv.subVectors(b, a);
  const len = T.length() || 1e-5;
  T.divideScalar(len);
  let up = _uv0.set(0, 1, 0);
  if (Math.abs(T.dot(up)) > 0.97) up = _uv0.set(1, 0, 0);
  const R = _rv2.crossVectors(T, up).normalize();
  const U = _uv1.crossVectors(R, T).normalize();
  const ringPt = (which, s) => {
    const ang = (s / segs) * Math.PI * 2;
    const r = which === 0 ? r0 : r1;
    const base = which === 0 ? a : b;
    return new THREE.Vector3(
      base.x + (R.x * Math.cos(ang) + U.x * Math.sin(ang)) * r,
      base.y + (R.y * Math.cos(ang) + U.y * Math.sin(ang)) * r,
      base.z + (R.z * Math.cos(ang) + U.z * Math.sin(ang)) * r,
    );
  };
  // side wall, smooth-shaded (radial normals) so a pillar reads as a cylinder
  const rows = [[], []];
  const nrm = [[], []];
  for (let w = 0; w < 2; w++) {
    for (let s = 0; s <= segs; s++) {
      const p = ringPt(w, s % segs);
      rows[w].push(p);
      const base = w === 0 ? a : b;
      nrm[w].push(new THREE.Vector3().subVectors(p, base).normalize());
    }
  }
  /* WINDING. Both loops below used to run the other way round, and it was the
   * single worst bug in this file.
   *
   * MEASURED. ringPt() traces the ring CLOCKWISE seen from +T (R = T x up, then
   * U = R x T), so (rows[0][s], rows[0][s+1], rows[1][s+1]) has a geometric
   * normal pointing INWARD: for the sao at r 0.14 the cross product came out
   * (-0.174, 0, 0.985) where outward is (0.17, 0, -0.97). Under the default
   * FrontSide culling three therefore threw away the near wall and drew the FAR
   * one — whose vertex normal (correctly computed as outward from the axis)
   * points away from the camera and straight at the backlight. Every tube in the
   * scene was consequently shaded as if fully sunlit, with rimRaw = 1 - dot(N,V)
   * clamped to its maximum over the entire surface, so both rim terms fired at
   * full strength everywhere.
   *
   * Proof, `lantern` preset, warm 420, scene-linear via the measured post-chain
   * transfer: the sao printed display L 0.805 against an albedo of 0.518 (a
   * shading factor of ~1.0) while the chudai — identical material, identical
   * albedo, built by latheN which winds correctly — printed 0.229 (factor 0.45).
   * `--scenario props-norim` split it: 0.512 of the sao's 0.805 was body, 0.29
   * was rim+spec. Same story on the six warabite tips (0.738).
   *
   * The knock-on: a previous round "fixed" the torii's pastel-pink pillars by
   * authoring the vermilion 21% darker than ART_BIBLE §3. That was compensating
   * for this, and it is reverted below now that the cause is gone. */
  for (let s = 0; s < segs; s++) {
    const i0 = M._vert(rows[0][s], nrm[0][s], [s / segs, 0], vals);
    const i1 = M._vert(rows[0][s + 1], nrm[0][s + 1], [(s + 1) / segs, 0], vals);
    const i2 = M._vert(rows[1][s + 1], nrm[1][s + 1], [(s + 1) / segs, 1], vals);
    const i3 = M._vert(rows[1][s], nrm[1][s], [s / segs, 1], vals);
    M.idx.push(i0, i3, i2, i0, i2, i1);
  }
  if (cap) {
    for (const [w, base, dir] of [[0, a, -1], [1, b, 1]]) {
      const nn = _cv.copy(T).multiplyScalar(dir);
      const ci = M._vert(base, nn, [0.5, 0.5], vals);
      const ring = [];
      for (let s = 0; s <= segs; s++) ring.push(M._vert(rows[w][s], nn, [s / segs, 0], vals));
      for (let s = 0; s < segs; s++) {
        if (dir > 0) M.idx.push(ci, ring[s + 1], ring[s]);
        else M.idx.push(ci, ring[s], ring[s + 1]);
      }
    }
  }
}
const _tv = new THREE.Vector3(), _uv0 = new THREE.Vector3(), _uv1 = new THREE.Vector3();
const _rv2 = new THREE.Vector3(), _cv = new THREE.Vector3();

/**
 * A rectangular-section beam swept along a polyline. This is how the kasagi gets
 * its upward sweep: the profile follows the curve, so the end caps come out
 * correctly slanted without any special-casing.
 */
/**
 * A beam swept along a polyline.
 *
 * `ch` > 0 cuts every arris back by that many metres, so the section is an
 * OCTAGON rather than a rectangle. This is the "give the kasagi real section"
 * fix, and the chamfer is the load-bearing part of it, not the extra depth.
 *
 * WHY. shots/props-r1/hero.png x 1560-1740 y 585-660: the kasagi + shimaki read
 * as one flat maroon ribbon with a 1 px pale rim, and the reviewer called it a
 * "two-plane ribbon with open ends". The mistake in the earlier diagnosis was
 * assuming the top face was missing. It is not — it is 0.345 m deep and it is
 * simply INVISIBLE from `hero`, which sits 1.4 m above a lintel 25 m away, i.e.
 * 3.3 deg off the beam's own plane, so the top face projects to 1.5 px. A
 * 45-degree chamfer strip projects several times that at the same grazing angle
 * AND carries its own shading value between the top and the front, which is
 * exactly the cue that makes a beam read as a solid rather than a card.
 */
function beam(M, pts, wFn, hFn, vals, cap = true, ch = 0) {
  const n = pts.length;
  const frames = [];
  const centre = new THREE.Vector3();
  for (const p of pts) centre.add(p);
  centre.multiplyScalar(1 / n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const T = new THREE.Vector3().subVectors(b, a).normalize();
    let up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(T.dot(up)) > 0.97) up = new THREE.Vector3(0, 0, 1);
    const R = new THREE.Vector3().crossVectors(T, up).normalize();
    const U = new THREE.Vector3().crossVectors(R, T).normalize();
    const hw = (typeof wFn === 'function' ? wFn(t) : wFn) * 0.5;
    const hh = (typeof hFn === 'function' ? hFn(t) : hFn) * 0.5;
    const cx = Math.min(ch, hw * 0.55);
    const cy = Math.min(ch, hh * 0.55);
    const sec = ch > 1e-4
      ? [[-hw + cx, -hh], [hw - cx, -hh], [hw, -hh + cy], [hw, hh - cy],
        [hw - cx, hh], [-hw + cx, hh], [-hw, hh - cy], [-hw, -hh + cy]]
      : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const c = [];
    for (const [sr, su] of sec) {
      c.push(pts[i].clone().addScaledVector(R, sr).addScaledVector(U, su));
    }
    frames.push(c);
  }
  const K = frames[0].length;
  /* aEdge — WHICH QUADS ARE THE ARRISES.
   *
   * The octagonal section above is ordered [bottom, bevel, side, bevel, top,
   * bevel, side, bevel], so quad k runs from vertex k to k+1 and every ODD k is
   * one of the four chamfer strips that replace a square corner. Tagging them
   * lets the wood shader take the paint off the EDGES of a beam, which is where
   * paint on a real gate actually goes, instead of in the random 50 cm patches
   * that made the kasagi read as damaged (see PROPS_WOOD_FRAG's wear block).
   * A rectangular section (ch = 0) has no bevel strips and gets 0 everywhere. */
  const bev = ch > 1e-4 && K === 8;
  const kv = [];
  for (let k = 0; k < K; k++) kv.push(bev && k % 2 === 1 ? { ...vals, aEdge: 1 } : vals);
  for (let i = 0; i < n - 1; i++) {
    const A = frames[i], B = frames[i + 1];
    const mid = new THREE.Vector3().addVectors(pts[i], pts[i + 1]).multiplyScalar(0.5);
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      M.quad(A[k], A[k2], B[k2], B[k], mid, kv[k],
        [[i / n, k / K], [i / n, (k + 1) / K], [(i + 1) / n, (k + 1) / K], [(i + 1) / n, k / K]]);
    }
  }
  if (cap) {
    // end grain: the most exposed surface on any beam, so it wears — but only
    // partly, because a fully bare end is what printed as a navy block before.
    const capVals = bev ? { ...vals, aEdge: 0.38 } : vals;
    for (const [F, inner] of [[frames[0], pts[1]], [frames[n - 1], pts[n - 2]]]) {
      const cen = new THREE.Vector3();
      for (const q of F) cen.add(q);
      cen.multiplyScalar(1 / K);
      for (let k = 0; k < K; k++) M.tri(cen, F[k], F[(k + 1) % K], inner, capVals);
    }
  }
}

/** An axis-aligned-then-rotated box. */
function boxAt(M, centre, size, yaw, pitch, vals) {
  const g = _boxGeo;
  _mtx.compose(centre, _q.setFromEuler(_e.set(pitch ?? 0, yaw ?? 0, 0, 'YXZ')),
    _s.set(size[0], size[1], size[2]));
  M.addGeo(g, _mtx, vals);
}
const _boxGeo = new THREE.BoxGeometry(1, 1, 1);
const _mtx = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** An irregular boulder / wall block: an icosphere pushed around by noise. */
function rockGeometry(detail, seed, squash = 0.82) {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // r3's boulders read as smooth potatoes: 0.44 of noise on a sphere is still a
    // sphere. 0.72 + a hard flat underside is what makes a rock read as QUARRIED
    // and bedded rather than dropped.
    const n = 1 + fbm3(x * 2.6 + seed, y * 2.6, z * 2.6, 3) * 0.72
      + fbm3(x * 6.4, y * 6.4, z * 6.4 + seed, 2) * 0.24;
    const flat = y < -0.14 ? -0.14 - (y + 0.14) * 0.28 : y;
    p.setXYZ(i, x * n, flat * n * squash, z * n);
  }
  g.computeVertexNormals();
  return g;
}

/** A blocky, quarried wall stone: a subdivided box, noise-roughened. */
function blockGeometry(seg, seed) {
  const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = fbm3(x * 4.2 + seed, y * 4.2, z * 4.2, 3) * 0.13
      + fbm3(x * 11.0, y * 11.0, z * 11.0 + seed, 2) * 0.05;
    p.setXYZ(i, x * (1 + n), y * (1 + n * 0.8), z * (1 + n));
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */
export default {
  name: 'props',
  order: 35,

  async setup(ctx) {
    const group = new THREE.Group();
    group.name = 'props';
    const L = ctx.assets.lightUniforms ?? {};
    const WU = WIND?.uniforms ?? {};
    const tier = TIER[ctx.quality?.tier] ?? TIER.high;
    const rng = makeRng(SEED);
    const disposables = [];
    const terrain = ctx.assets.terrain ?? null;

    const groundAt = (x, z) => (terrain?.heightAt ? terrain.heightAt(x, z) : 0);
    const normAt = (x, z) => (terrain?.normalAt ? terrain.normalAt(x, z) : new THREE.Vector3(0, 1, 0));
    const waterY = terrain?.pond?.waterY ?? -99;
    const pondC = terrain?.pond ? new THREE.Vector2(terrain.pond.x, terrain.pond.z) : new THREE.Vector2(-9, 6);

    /** Push a placement radially out of the pond until it is honestly dry land. */
    function dryLand(x, z, clearance = 0.20) {
      let px = x, pz = z;
      for (let i = 0; i < 14; i++) {
        if (groundAt(px, pz) > waterY + clearance) break;
        const dx = px - pondC.x, dz = pz - pondC.y;
        const dl = Math.hypot(dx, dz) || 1;
        px += (dx / dl) * 0.55; pz += (dz / dl) * 0.55;
      }
      return [px, pz];
    }

    /** A point `lateral` metres to the side of the stone path at parameter t. */
    function besidePath(t, lateral) {
      if (!terrain?.pathAt) {
        return { x: 6 * t, z: -3 * t + lateral, tan: new THREE.Vector2(1, 0) };
      }
      const a = terrain.pathAt(Math.max(0, t - 0.008));
      const b = terrain.pathAt(Math.min(1, t + 0.008));
      const tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = tz / tl, nz = -tx / tl;          // right-hand normal of travel
      const c = terrain.pathAt(t);
      return { x: c.x + nx * lateral, z: c.z + nz * lateral, tan: new THREE.Vector2(tx / tl, tz / tl) };
    }

    /* ================================================================ *
     * Materials
     * ================================================================ */
    const uTime = { value: 0 };
    const uGlow = { value: 0 };

    /**
     * Per-material NPR tuning (the mechanism createNprMaterial exposes as
     * shadowLevel/ambientShadow; a hand-written GLSL_NPR shader gets it by
     * #define, because the library guards every knob with #ifndef).
     *
     * WHY: props are the only surfaces in the scene made of a BRIGHT albedo
     * (granite 0.333 linear luma, vermilion 0.55 in R) presented as large FLAT
     * faces, and the library's defaults are tuned on organic masses. Two of them
     * misfire badly here:
     *
     *  - NPR_SHADOW_CORE / _CORE_HI open a fourth, deeper plateau over the whole
     *    of a face turned away from the key. On a leaf cluster that is the
     *    palette's "deep interior"; on the flat flank of a granite collar it is
     *    just a dark slab. r1 measured the chudai at display L 0.12 with sd 0.017.
     *  - NPR_CANOPY_SHADE takes 41% of the sky ambient from anything under the
     *    crown. Correct for the ground; wrong for a 1.9 m vertical prop whose
     *    faces mostly see the bright horizon, not the leaves.
     *
     * CALIBRATED against the measured post-chain transfer (a flat linear #9E9A92
     * written straight to the framebuffer prints display L 0.56 through this
     * grade; 1/16 of it prints 0.051 — so display ≈ 0.56·(scene/0.333)^0.864).
     * With these values the model puts shadowed granite at 0.61 of the lit value,
     * inside ART_BIBLE §2's 0.55-0.60 window and nowhere near the "shadows 99% as
     * bright as lit surfaces" failure this project has already shipped once.
     */
    const NPR_TUNE = {
      // NOT "shadows at 100% of the lit value". nprShadowLevel() multiplies this
      // by mix(2.20, 0.66, ...) and granite's albedo luma (0.333) puts it at the
      // 0.66 end, then NPR_SHADOW_CORE (0.88) and the AO factor (0.96) take
      // another 15%: 1.00 x 0.66 x 0.88 x 0.96 = 0.558 of the lit value, which is
      // ART_BIBLE §2's number. MEASURED before this change: 0.452.
      NPR_SHADOW_LEVEL: '1.00',
      NPR_AMBIENT_CAST: '0.96',
      NPR_AMBIENT_SHADOW: '0.90',
      NPR_SHADOW_AO: '0.70',
      NPR_SHADOW_CORE: '0.94',
      NPR_SHADOW_CORE_HI: '0.200',
      /* 0.045 -> 0.070 was a mistake and is now 0.030. nprShadowFloor() is 55%
       * PURE uShadowTint (chroma 0.77) and is NOT scaled by the albedo, so on the
       * darkest granite pixels — the worley pits, scene-linear ~0.09 — it was 9% of
       * the total at full violet chroma. The grade's shadow split-tone toward
       * #2A2438 then amplified it and the whole kasa printed as magenta mottling.
       * PROVED with `--scenario props-albedo`: the albedo itself is clean mossy
       * granite with no violet anywhere in it. NPR_SHADOW_CHROMA (0.62 -> 0.16 ->
       * 0.22) barely moved the blotching, which is what pointed at the floor. */
      NPR_SHADOW_FLOOR: '0.030',
      /* Granite is near-neutral (#9E9A92 is 7.6% saturated), so the library's
       * `neutral` term treats it as having no hue to protect: it lets the albedo take
       * uShadowTint's hue OUTRIGHT (bypassing the 30 deg rotation limiter) and lifts
       * its saturation toward the tint's 0.77. Correct for a grey ball; on a stone
       * lantern it printed the kasa and the chudai as violet-magenta mottling, which
       * the grade's shadow split-tone (toward #2A2438) plus its 1.14 saturation then
       * amplified.
       *
       * A/B'd, not guessed: `--scenario props-albedo` proved the albedo itself is
       * clean mossy granite with no violet in it; CHROMA 0.62 -> 0.28 -> 0.22 barely
       * moved the blotching (sat only falls 0.35 -> 0.20 -> 0.17, and 0.17 at violet
       * hue still reads as paint); setting BOTH to 0 removed it completely. So the
       * settled values are small but non-zero — ART_BIBLE §2 does want a cool shadow,
       * and on granite it should come from uSkyColor's blue ambient (the real reason)
       * rather than from repainting the albedo violet. At 0.06/0.22 shadowed granite
       * lands on HSV sat 0.10 with a 22% hue lean. */
      NPR_SHADOW_CHROMA: '0.06',
      NPR_SHADOW_HUE: '0.22',
      /* Under the CURRENT (multiply) tint model the two legacy dampers above are
       * only honoured as a 0.78x trim, so granite's actual cool shift is set by
       * this: how much of the multiply a NEAR-NEUTRAL albedo takes. The library
       * default 0.45 was calibrated to land stone at "hue 238 deg, display
       * saturation 0.10". MEASURED on shots/props-p5-r3/hero.png it is now landing
       * at hue 207-218 and display saturation 0.23-0.28 — nearly 3x that, i.e.
       * blue-painted stone, and the moss and lichen the shader does put on it are
       * no longer readable through it. 0.34 is a trim back toward the number the
       * library already agreed on, not an opt-out: granite still cools clearly. */
      NPR_SHADOW_TINT_NEUTRAL: '0.34',
      NPR_CANOPY_SHADE: '0.32',
      NPR_CANOPY_KEY: '0.18',
    };

    const stoneUniforms = () => ({
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
      uStoneLite: { value: C(PAL.stoneLite) },
      uStoneDark: { value: C(PAL.stoneDark) },
      uMossLite: { value: C(PAL.mossLite) },
      uMossDark: { value: C(PAL.mossDark) },
      uLichen: { value: C(PAL.lichen) },
      uMossAmt: { value: 0.56 },
      // 1.0 = the shader's calibrated per-metre frequency basis (0.55 / 2.6 / 11 /
      // 34 cycles per metre). A lantern wants it at 1; a 1.4 m boulder wants the
      // same features spread over more surface, so it goes below 1.
      uGrainScale: { value: 1.0 },
      // The flank the sun's arc never reaches — uSunDir sits around (-0.15,+0.6,
      // -0.77) all day, so the permanently shaded side faces (+x,+z) and slightly
      // down. A FIXED world direction, because moss is a fact about the place and
      // must not swing with the sun. It also happens to be the camera-facing side
      // in `hero`/`lantern`, which is where the flat dark faces needed breaking up.
      uShadeDir: { value: new THREE.Vector3(0.55, -0.30, 0.78).normalize() },
      ...L,
    });
    const mkStone = (name) => {
      const m = new THREE.ShaderMaterial({
        name,
        uniforms: stoneUniforms(),
        vertexShader: PROPS_STONE_VERT,
        fragmentShader: PROPS_STONE_FRAG,
        lights: true,
        defines: { NPR_HAS_SHADOWMAP: '', ...NPR_TUNE, ...PROPS_DBG },
        fog: false,
      });
      disposables.push(m);
      return m;
    };
    // Separate instances for instanced / non-instanced use so three never has to
    // swap a program on one material mid-frame.
    const stoneMatSolid = mkStone('props-stone');
    const stoneMatInst = mkStone('props-stone-inst');
    const stoneMatWall = mkStone('props-stone-wall');
    // r3 measured: moss 1.25 x the block's own 0.85 top bias saturated the moss
    // term over most of the wall and printed a black-green band behind the tree.
    // 0.72 keeps moss in the joints and on the copes and lets granite be granite.
    stoneMatWall.uniforms.uMossAmt.value = 0.42;
    stoneMatWall.uniforms.uGrainScale.value = 1.15;
    const stoneMatRock = mkStone('props-stone-rock');
    stoneMatRock.uniforms.uMossAmt.value = 0.58;
    stoneMatRock.uniforms.uGrainScale.value = 0.52;

    const woodUniforms = () => ({
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
      uVermilion: { value: C(PAL.vermilion) },
      uVermWorn: { value: C(PAL.vermWorn) },
      uWoodLite: { value: C(PAL.woodLite) },
      uWoodDark: { value: C(PAL.woodDark) },
      uLichen: { value: C(PAL.lichen) },
      uMoss: { value: C(PAL.moss) },
      uInk: { value: C(PAL.ink) },
      uPlaster: { value: C(PAL.plaster) },
      ...WU,
      ...L,
    });
    /* Painted timber needs its own tune. Vermilion is a DARK colour by luminance
     * (#C4322B is sRGB L 0.316 lit, a fifth of granite's), and the torii's whole
     * camera-facing width is the shade side in a backlit composition, so the
     * granite settings put both pillars at display L 0.141 in a magenta-red — the
     * gate stopped reading as vermilion at all. Two changes: the sky ambient is not
     * occluded on it (a 4.85 m gate standing clear of the crown sees the whole
     * dome, not a canopy interior), and the shadow chroma is left nearer the
     * library default because a saturated red has a real hue to protect and the
     * hue-limiter already caps its rotation at 23 deg. */
    const WOOD_TUNE = {
      ...NPR_TUNE,
      /* A saturated red DOES have a hue to protect, so the library's limiter already
       * caps its rotation at 23 deg and it can carry more chroma transfer than
       * granite. Do NOT take these toward zero: A/B'd at 0.08/0.14 the shaded pillar
       * went from #7F093A L 0.149 (min 0.045) to #610A25 L 0.119 with a min of 0.0
       * and hard black speckle in the wear pattern — the violet chroma was the only
       * thing holding the darkest paint pixels off the §8.4 floor. */
      NPR_SHADOW_CHROMA: '0.20',
      NPR_SHADOW_HUE: '0.38',
      /* The shade multiply, trimmed from 1.00 — NOT switched off. ART_BIBLE §2's
       * cool shade stays; what goes is the last 22%, which is what carried the
       * exposed timber past channel-dominance inversion. nprShadowHue multiplies
       * by uShadowTint at unit luminance, (0.81, 0.95, 2.06); nprTintStrength()
       * currently returns 0.795 for this material, giving an effective multiplier
       * of (0.85, 0.96, 1.84) — so bare wood needs linear R/B >= 2.17 to stay
       * warm. At 0.78 the requirement drops to 1.88 and PAL.woodLite's 2.55 has
       * real margin, so a WORN ARRIS reads as pale grey-brown timber in cool
       * light instead of as navy damage. Vermilion (R/B 20.6) is unaffected
       * either way. */
      NPR_SHADOW_TINT: '0.78',
      NPR_AMBIENT_SHADOW: '1.00',
      NPR_CANOPY_SHADE: '0.18',
      NPR_CANOPY_KEY: '0.12',
    };
    const mkWood = (name, defines = {}) => {
      const m = new THREE.ShaderMaterial({
        name,
        uniforms: woodUniforms(),
        vertexShader: PROPS_WOOD_VERT,
        fragmentShader: PROPS_WOOD_FRAG,
        lights: true,
        defines: { NPR_HAS_SHADOWMAP: '', ...WOOD_TUNE, ...defines },
        fog: false,
      });
      disposables.push(m);
      return m;
    };
    const woodMat = mkWood('props-wood');
    const bambooMat = mkWood('props-bamboo', { PROPS_BAMBOO: '' });
    bambooMat.uniforms.uWoodLite.value = C(PAL.bambooLite);
    bambooMat.uniforms.uWoodDark.value = C(PAL.bambooDark);
    const emaMat = mkWood('props-ema', { PROPS_EMA: '', PROPS_SWAY: '', PROPS_DOUBLE: '' });
    emaMat.uniforms.uWoodLite.value = C(PAL.emaWood);
    emaMat.uniforms.uWoodDark.value = C(0x8E7A5E);
    emaMat.side = THREE.DoubleSide;

    const windowMat = new THREE.ShaderMaterial({
      name: 'props-window',
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
        uPaper: { value: C(PAL.paper) },
        uPaperCold: { value: C(PAL.paperCold) },
        uPaperDay: { value: C(PAL.paperDay) },
        uFlameCore: { value: C(PAL.flame) },
        uGlow: uGlow,
        uTime: uTime,
        ...L,
      },
      vertexShader: PROPS_WINDOW_VERT,
      fragmentShader: PROPS_WINDOW_FRAG,
      lights: true,
      /* The washi keeps its warmth in shade. MEASURED: at the library default the
       * daytime panel printed rgb(101,136,169) — hue 209 deg, sat 0.28, i.e. blue
       * paper against blue-grey granite, which is both wrong for paper and the
       * worst possible value/hue separation from the stone it sits in. #F4E0B4 has
       * linear R/B 1.98 and nprShadowHue's unit-luminance tint is
       * (0.81, 0.95, 2.06), so it needs the multiply held under ~0.60 to stay
       * red-dominant. 0.58 leaves margin and still cools the sheet clearly. */
      defines: { NPR_HAS_SHADOWMAP: '', NPR_SHADOW_TINT: '0.58' },
      side: THREE.DoubleSide,
      fog: false,
    });
    disposables.push(windowMat);

    const haloMat = new THREE.ShaderMaterial({
      name: 'props-halo',
      uniforms: {
        uHaloColor: { value: C(PAL.halo) },
        uHaloCore: { value: C(PAL.flame) },
        uGlow: uGlow,
        uSize: { value: 1.0 },
      },
      vertexShader: PROPS_HALO_VERT,
      fragmentShader: PROPS_HALO_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    disposables.push(haloMat);

    const basinMat = new THREE.ShaderMaterial({
      name: 'props-basin',
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights]),
        uDeep: { value: C(0x2A3A38) },
        uTime: uTime,
        ...L,
      },
      vertexShader: PROPS_BASIN_VERT,
      fragmentShader: PROPS_BASIN_FRAG,
      lights: true,
      defines: { NPR_HAS_SHADOWMAP: '' },
      fog: false,
    });
    disposables.push(basinMat);

    /* ================================================================ *
     * 1. The torii
     * ================================================================ */
    // aEdge defaults to 0 for every builder that does not set it (Mesher._attrs
    // treats a missing key as 0), so only beam() with a chamfer ever raises it.
    const woodSpec = { aWood: 4, aGrain: 2, aVar: 4, aEdge: 1 };
    const WM = new Mesher(woodSpec);

    const toriiSpot = besidePath(TORII_T, 0);
    const toriiYaw = Math.atan2(toriiSpot.tan.x, toriiSpot.tan.y) + TORII_SKEW;
    // walk-through axis (local +Z) and span axis (local +X), skewed per above
    const SZ = new THREE.Vector3(Math.sin(toriiYaw), 0, Math.cos(toriiYaw));
    const SX = new THREE.Vector3(Math.cos(toriiYaw), 0, -Math.sin(toriiYaw));
    const footA = [toriiSpot.x + SX.x * TORII_SPAN * 0.5, toriiSpot.z + SX.z * TORII_SPAN * 0.5];
    const footB = [toriiSpot.x - SX.x * TORII_SPAN * 0.5, toriiSpot.z - SX.z * TORII_SPAN * 0.5];
    const toriiY = Math.min(groundAt(footA[0], footA[1]), groundAt(footB[0], footB[1])) - 0.02;
    const O = new THREE.Vector3(toriiSpot.x, toriiY, toriiSpot.z);

    /** local (across, up, along) -> world */
    const TP = (u, y, v = 0) => new THREE.Vector3(
      O.x + SX.x * u + SZ.x * v,
      O.y + y,
      O.z + SX.z * u + SZ.z * v,
    );
    const aboveGround = (w) => w.y - toriiY;
    const grainY = (w, l) => [w.y - toriiY, (w.x - O.x) * 0.7 + (w.z - O.z) * 0.7];
    const grainX = (w) => [(w.x - O.x) * SX.x + (w.z - O.z) * SX.z, (w.y - toriiY) * 0.8];

    const half = TORII_SPAN * 0.5;
    const pillarLean = 0.055;
    for (const sgn of [-1, 1]) {
      const bx = sgn * half;
      const tx = sgn * (half - pillarLean);
      tube(WM, TP(bx, -0.62), TP(tx, TORII_H), 0.244, 0.196, 14, {
        aWood: (w) => [
          // Paint wears from the bottom up: rain splash, feet, strimmer. Ends at
          // 0.14 above 0.9 m so the pillar stays VERMILION for its whole visible
          // length — r3 ran the wear to 2.05 m and printed two bare-wood posts.
          0.90 - 0.82 * Math.min(1, Math.max(0, (w.y - toriiY) / 0.78)), 1.0,
          aboveGround(w),
          0.52 + 0.48 * Math.min(1, Math.max(0, (w.y - toriiY) / 0.42)),
        ],
        aGrain: grainY,
        aVar: [0, 0, 3.1 + sgn, 0],
      });
      // kusabi wedge where the nuki passes through
      boxAt(WM, TP(sgn * (half - 0.02), TORII_H * 0.665, 0), [0.10, 0.13, 0.42],
        toriiYaw, 0, {
          aWood: (w) => [0.52, 1.0, aboveGround(w), 0.82],
          aGrain: grainX, aVar: [0, 0, 9.4, 0],
        });
    }

    // nuki — the straight crossbeam, protruding past both pillars
    const nukiY = TORII_H * 0.665;
    beam(WM, [TP(-half - 0.30, nukiY), TP(0, nukiY), TP(half + 0.30, nukiY)],
      0.300, 0.345, {
        aWood: (w) => [
          0.30 + 0.52 * Math.min(1, Math.max(0, (Math.abs((w.x - O.x) * SX.x + (w.z - O.z) * SX.z) - 1.45) / 0.60)),
          1.0, aboveGround(w), 0.92,
        ],
        aGrain: grainX, aVar: [0, 0, 17.2, 0],
      }, true, 0.045);

    // gakuzuka — the central strut, and the plaque it carries
    const shimakiY = TORII_H + 0.075;
    boxAt(WM, TP(0, (nukiY + shimakiY) * 0.5 + 0.06, 0),
      [0.175, shimakiY - nukiY - 0.10, 0.20], toriiYaw, 0, {
        aWood: (w) => [0.34, 1.0, aboveGround(w), 0.74],
        aGrain: grainY, aVar: [0, 0, 23.5, 0],
      });
    // gaku (the plaque): a LIMEWASHED name-board in a vermilion frame, facing the
    // walk. aVar.x = 1 is the shader's flag for it — see uPlaster there. As bare
    // timber it measured 43,45,71 (hue 237 deg), the last navy slab on the gate.
    const plaqueY = (nukiY + shimakiY) * 0.5 + 0.06;
    boxAt(WM, TP(0, plaqueY, 0.135), [0.72, 0.46, 0.05], toriiYaw, 0, {
      aWood: (w) => [0.58, 0.0, aboveGround(w), 0.95],
      aGrain: grainX, aVar: [1, 0, 31.7, 0],
    });
    for (const [oy, ox, sw, sh] of [[0.255, 0, 0.80, 0.075], [-0.255, 0, 0.80, 0.075],
      [0, 0.395, 0.075, 0.60], [0, -0.395, 0.075, 0.60]]) {
      boxAt(WM, TP(ox, plaqueY + oy, 0.16), [sw, sh, 0.055], toriiYaw, 0, {
        aWood: (w) => [0.30, 1.0, aboveGround(w), 0.88],
        aGrain: grainX, aVar: [0, 0, 37.1, 0],
      });
    }

    // shimaki — the thin beam directly under the kasagi, same sweep
    const sweep = (u) => 0.40 * Math.pow(u / (half + 1.06), 2);
    const kasagiPts = [];
    const shimakiPts = [];
    const KN = 11;
    for (let i = 0; i < KN; i++) {
      const f = (i / (KN - 1)) * 2 - 1;
      const u = f * (half + 1.06);
      // the kasagi's underside must land exactly on the shimaki's top face
      // (kasagi half-height 0.180 + shimaki half-height 0.0775 = 0.2575)
      kasagiPts.push(TP(u, shimakiY + 0.2575 + sweep(u)));
      shimakiPts.push(TP(u * 0.955, shimakiY + sweep(u * 0.955)));
    }
    /* SHIMAKI (the reviewer's "shimogi") — the flat board under the kasagi.
     * It is deliberately 0.16 m SHALLOWER than the kasagi in depth, so the
     * kasagi's underside overhangs it on both faces. That downward-facing soffit
     * strip is the second half of "the beam reads as solid": from `hero` you get
     * chamfer-lit top edge, front face, dark reveal, shimaki front face — four
     * values down the section instead of one flat ribbon. */
    beam(WM, shimakiPts, (t) => 0.360 - 0.040 * Math.abs(t * 2 - 1), 0.155, {
      aWood: (w) => [0.40, 1.0, aboveGround(w), 0.90],
      aGrain: grainX, aVar: [0, 0, 43.3, 0],
    }, true, 0.030);
    /* KASAGI — the crowning lintel. 0.52 x 0.36 m at the centre (was 0.345 x
     * 0.285) with a 55 mm chamfer on every arris. Proportions checked against a
     * real myojin gate: on a 4.85 m torii the kasagi is the heaviest member, about
     * 1/13 of the height in depth, and reading light next to the 0.49 m pillars is
     * exactly what made it look like a ribbon.
     *
     * WEAR. The exposure ramp is 0.44 -> 0.78 across the last 1.10 m: deliberately
     * BELOW the shader's 0.74..1.06 paint-loss window at the centre and only just
     * inside it at the tips, so the ends of the kasagi read as sun-faded, chalky
     * vermilion rather than as bare timber. r9 ran it to 0.90, which put the tips
     * clear of the old 0.30..0.90 window and printed two solid navy blocks — bare
     * near-neutral wood cannot defend itself against the shade tint (see
     * PAL.woodLite). The visible paint loss now lives on the ARRISES instead, via
     * aEdge, which is where a gate actually wears. */
    beam(WM, kasagiPts,
      (t) => 0.520 - 0.075 * Math.abs(t * 2 - 1),
      (t) => 0.360 - 0.090 * Math.abs(t * 2 - 1), {
        aWood: (w) => {
          const u = Math.abs((w.x - O.x) * SX.x + (w.z - O.z) * SX.z);
          return [0.44 + 0.34 * Math.min(1, Math.max(0, (u - 1.55) / 1.10)), 1.0,
            aboveGround(w), 0.94];
        },
        aGrain: grainX, aVar: [0, 0, 51.9, 0],
      }, true, 0.055);

    /* ================================================================ *
     * 2. The ema plaque rack (same wood mesh: one draw call for all joinery)
     * ================================================================ */
    const emaSpot = besidePath(0.345, -3.55);
    const emaYaw = Math.atan2(emaSpot.tan.x, emaSpot.tan.y);
    const emaEX = new THREE.Vector3(emaSpot.tan.y, 0, -emaSpot.tan.x);
    const emaY = Math.min(
      groundAt(emaSpot.x + emaEX.x * 0.85, emaSpot.z + emaEX.z * 0.85),
      groundAt(emaSpot.x - emaEX.x * 0.85, emaSpot.z - emaEX.z * 0.85)) - 0.02;
    const EP = (u, y, v = 0) => new THREE.Vector3(
      emaSpot.x + emaEX.x * u + emaSpot.tan.x * v,
      emaY + y,
      emaSpot.z + emaEX.z * u + emaSpot.tan.y * v,
    );
    // Scaled up from r3: at 29 m a 0.075 m post is 5 px wide and a 0.17 m plaque
    // is one pixel, i.e. it cost two draw calls and contributed nothing.
    const emaRailY = 1.78;
    const emaGrainY = (w) => [w.y - emaY, (w.x - emaSpot.x) * 0.7 + (w.z - emaSpot.z) * 0.7];
    const emaGrainX = (w) => [
      (w.x - emaSpot.x) * emaEX.x + (w.z - emaSpot.z) * emaEX.z, (w.y - emaY) * 0.8];
    for (const sgn of [-1, 1]) {
      tube(WM, EP(sgn * 1.28, -0.42), EP(sgn * 1.25, 2.02), 0.105, 0.086, 8, {
        aWood: (w) => [0.85, 0.0, w.y - emaY,
          0.55 + 0.45 * Math.min(1, Math.max(0, (w.y - emaY) / 0.38))],
        aGrain: emaGrainY,
        aVar: [0, 0, 61.3, 0],
      });
    }
    // the rail the plaques hang from
    beam(WM, [EP(-1.44, emaRailY), EP(1.44, emaRailY)], 0.115, 0.105, {
      aWood: (w) => [0.72, 0.0, w.y - emaY, 0.92],
      aGrain: emaGrainX, aVar: [0, 0, 67.1, 0],
    });
    // a little shingled cap so the plaques stay dry: ridge + two slopes
    beam(WM, [EP(-1.62, 2.185, 0), EP(1.62, 2.185, 0)], 0.075, 0.07, {
      aWood: (w) => [0.60, 0.0, w.y - emaY, 0.88], aGrain: emaGrainX, aVar: [0, 0, 71.9, 0],
    });
    for (const sgn of [-1, 1]) {
      const a = EP(-1.62, 2.160, 0), b = EP(1.62, 2.160, 0);
      const c = EP(-1.62, 1.930, sgn * 0.52), d = EP(1.62, 1.930, sgn * 0.52);
      const mid = EP(0, 2.05, sgn * 0.26);
      WM.quad(a, b, d, c, EP(0, 1.40, 0), {
        aWood: (w) => [0.68, 0.0, w.y - emaY, 0.90], aGrain: emaGrainX, aVar: [0, 0, 73.3, 0],
      });
      // underside, so the eave is not a one-sided sliver from below
      WM.quad(a.clone().setY(a.y - 0.035), b.clone().setY(b.y - 0.035),
        d.clone().setY(d.y - 0.035), c.clone().setY(c.y - 0.035), mid, {
          aWood: (w) => [0.62, 0.0, w.y - emaY, 0.62], aGrain: emaGrainX, aVar: [0, 0, 74.1, 0],
        });
    }

    const woodGeo = WM.build('props-woodwork');
    disposables.push(woodGeo);
    const woodMesh = new THREE.Mesh(woodGeo, woodMat);
    woodMesh.name = 'torii';
    woodMesh.castShadow = true;
    woodMesh.receiveShadow = true;
    group.add(woodMesh);

    /* ================================================================ *
     * 3. Stone lanterns (ishidoro) — one instanced granite mesh, one
     *    instanced paper-window mesh, one instanced additive halo.
     * ================================================================ */
    const stoneSpec = { aStone: 3 };
    const LM = new Mesher(stoneSpec);
    const WPM = new Mesher({});          // paper panels (uv only)

    const ao = (y, k = 0.30) => 0.46 + 0.54 * Math.min(1, Math.max(0, y / k));
    const mossLow = (y) => Math.max(0, 1 - y / 0.90) * 0.85;
    const LO = new THREE.Vector3(0, 0, 0);
    const sVals = (crev) => ({
      aStone: (w) => [mossLow(w.y) + 0.10, ao(w.y), crev],
    });

    /* Every hexagonal member is now cut as a CHAMFERED hexagon (latheN with
     * sides 6) sampled at 36 segments, and every profile arris carries a 12-16 mm
     * bevel ring (bevelProfile). Round members are sampled at 22-24. That puts a
     * minimum of 12 straight segments in every silhouette and gives each arris its
     * own narrow shading value — the two things shots/critic-p4-r1/lantern-f0.png
     * called out ("5 hard unbeveled facets", "a visible hexagonal frustum"). */
    const HEXSEG = 36, HEXCH = 0.30, RNDSEG = 22;

    // kiso — the buried footing block
    latheN(LM, bevelProfile([[0.00, -0.10], [0.455, -0.10], [0.470, 0.045], [0.415, 0.150],
      [0.360, 0.205], [0.150, 0.205]], 0.016), HEXSEG, LO, 0.12, sVals(0.85), 0.05, 6, HEXCH);
    // sao — the shaft, with two collars. 18 segments, not 10: at the `lantern`
    // preset's 256 px/m a 0.28 m shaft is 72 px wide, so a 10-segment cylinder put
    // its whole grazing band (where the rim term piles up) inside two quads and
    // printed the post at L 0.937 — brighter than the sky behind it.
    tube(LM, new THREE.Vector3(0, 0.19, 0), new THREE.Vector3(0, 0.985, 0),
      0.140, 0.116, 18, sVals(0.55));
    latheN(LM, bevelProfile([[0.128, 0.00], [0.166, 0.028], [0.166, 0.070], [0.126, 0.098]], 0.009),
      RNDSEG, new THREE.Vector3(0, 0.30, 0), 0, sVals(0.9), 0.05, 0, 0);
    latheN(LM, bevelProfile([[0.120, 0.00], [0.158, 0.028], [0.158, 0.070], [0.118, 0.098]], 0.009),
      RNDSEG, new THREE.Vector3(0, 0.74, 0), 0, sVals(0.9), 0.05, 0, 0);
    // chudai — the flared mid platform the fire box stands on
    latheN(LM, bevelProfile([[0.118, 0.00], [0.205, 0.028], [0.255, 0.082], [0.330, 0.120],
      [0.330, 0.162], [0.272, 0.186], [0.140, 0.186]], 0.014), HEXSEG,
    new THREE.Vector3(0, 0.965, 0), 0.12, sVals(0.8), 0.09, 6, HEXCH);

    // hibukuro — the fire box. Hexagonal, four faces opened, two solid.
    const FB_Y0 = 1.148, FB_H = 0.395, FB_R = 0.258;
    const FB_MID = new THREE.Vector3(0, FB_Y0 + FB_H * 0.5, 0);
    /* The corner arrises are cut back by FB_CH of a side (18 mm on a 258 mm
     * circumradius), so the box presents 6 faces PLUS 6 bevel strips = 12
     * silhouette segments, and the strips catch their own light value. */
    const FB_CH = 0.07;
    const hexV = (i, r, y) => {
      const a = 0.12 + (i / 6) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    };
    /** the chamfered face corner: 0 = start of face i, 1 = end of face i */
    const hex = (i, r, y, end) => {
      const v0 = hexV(i, r, y), v1 = hexV(i + 1, r, y);
      return v0.lerp(v1, end ? 1 - FB_CH : FB_CH);
    };
    const OPEN = [true, false, true, true, false, true];
    for (let i = 0; i < 6; i++) {
      // the bevel strip that replaces the arris at the shared vertex i+1
      LM.quad(hex(i, FB_R, FB_Y0, true), hex(i + 1, FB_R, FB_Y0, false),
        hex(i + 1, FB_R, FB_Y0 + FB_H, false), hex(i, FB_R, FB_Y0 + FB_H, true),
        FB_MID, sVals(0.55));
      const a0 = hex(i, FB_R, FB_Y0, false), a1 = hex(i, FB_R, FB_Y0, true);
      const b0 = hex(i, FB_R, FB_Y0 + FB_H, false), b1 = hex(i, FB_R, FB_Y0 + FB_H, true);
      if (!OPEN[i]) {
        LM.quad(a0, a1, b1, b0, FB_MID, sVals(0.7));
        continue;
      }
      // a frame around a rectangular opening: sill, head, two jambs
      const lerp3 = (p, q, t) => new THREE.Vector3().lerpVectors(p, q, t);
      const jamb = 0.225;                       // fraction of the face width
      const yb = FB_Y0 + 0.078;                 // sill height
      const ya = FB_Y0 + FB_H - 0.072;          // head height
      const bl = hex(i, FB_R, yb, false), br = hex(i, FB_R, yb, true);
      const tl = hex(i, FB_R, ya, false), tr = hex(i, FB_R, ya, true);
      LM.quad(a0, a1, br, bl, FB_MID, sVals(0.7));                       // sill
      LM.quad(tl, tr, b1, b0, FB_MID, sVals(0.7));                       // head
      LM.quad(bl, lerp3(bl, br, jamb), lerp3(tl, tr, jamb), tl, FB_MID, sVals(0.7));
      LM.quad(lerp3(br, bl, jamb), br, tr, lerp3(tr, tl, jamb), FB_MID, sVals(0.7));
      // the washi panel, recessed inside the opening
      const k = 0.955;
      const w0 = lerp3(bl, br, jamb);
      const w1 = lerp3(br, bl, jamb);
      const w2 = lerp3(tr, tl, jamb);
      const w3 = lerp3(tl, tr, jamb);
      for (const w of [w0, w1, w2, w3]) { w.x *= k; w.z *= k; }
      WPM.quad(w0, w1, w2, w3, FB_MID, null,
        [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    // a lid so no daylight comes through the top of the box
    latheN(LM, [[0.00, 0], [0.262, 0]], HEXSEG, new THREE.Vector3(0, FB_Y0 + FB_H, 0), 0.12,
      sVals(0.5), -0.05, 6, HEXCH);

    /* kasa — the roof. The profile now carries an extra row at the eave crown and
     * a 16 mm bevel at every arris, and the hexagon's corners are cut back, so
     * where r1 measured 5 hard facets the silhouette now runs 12 segments with a
     * lit bevel line along each. */
    const ROOF_Y = FB_Y0 + FB_H;
    latheN(LM, bevelProfile([[0.022, 0.315], [0.105, 0.288], [0.215, 0.222], [0.330, 0.128],
      [0.418, 0.048], [0.452, 0.006], [0.462, -0.060], [0.395, -0.088], [0.150, -0.078]], 0.016),
    HEXSEG, new THREE.Vector3(0, ROOF_Y, 0), 0.12, {
      aStone: (w) => [mossLow(w.y) + 0.10, 0.90, 0.62],
    }, 0.12, 6, 0.26);
    /* warabite — the six curled corner tips. They now sit on the roof's HIP
     * CORNERS (local azimuth i*60 deg) rather than at the middle of each facet,
     * which is both where a mason puts them and where they break the silhouette.
     * The corner radius is the chamfered hexagon's own: 0.452 / cos(dc). */
    for (let i = 0; i < 6; i++) {
      const a = 0.12 + (i / 6) * Math.PI * 2;
      const cr = 0.452 / Math.cos((Math.PI / 6) * (1 - 0.26));
      const p = new THREE.Vector3(Math.cos(a) * cr, ROOF_Y + 0.014, Math.sin(a) * cr);
      const tipD = new THREE.Vector3(Math.cos(a), 0.85, Math.sin(a)).normalize();
      tube(LM, p, p.clone().addScaledVector(tipD, 0.115), 0.048, 0.022, 9, {
        aStone: [0.30, 0.80, 0.6],
      });
    }
    // hoju — the finial
    latheN(LM, bevelProfile([[0.00, 0.118], [0.055, 0.098], [0.072, 0.048], [0.058, 0.006],
      [0.086, -0.006], [0.086, -0.030], [0.030, -0.030]], 0.006),
    RNDSEG, new THREE.Vector3(0, ROOF_Y + 0.312, 0), 0, { aStone: [0.16, 0.92, 0.5] }, 0.03, 0, 0);

    const lanternGeo = LM.build('ishidoro');
    const windowGeo = WPM.build('ishidoro-window');
    disposables.push(lanternGeo, windowGeo);
    const FLAME_Y = FB_Y0 + FB_H * 0.46;

    /* ---- placements ---- */
    const lanterns = [];
    for (let i = 0; i < LANTERN_STATIONS.length; i++) {
      const st = LANTERN_STATIONS[i];
      const p = besidePath(st.t, st.lateral);
      const [x, z] = dryLand(p.x, p.z, 0.26);
      const y = groundAt(x, z);
      const s = st.scale * rng.range(0.965, 1.045);
      lanterns.push({
        position: new THREE.Vector3(x, y - 0.06 * s, z),
        yaw: Math.atan2(p.tan.x, p.tan.y) + rng.range(-0.42, 0.42),
        scale: s,
        flame: new THREE.Vector3(x, y - 0.06 * s + FLAME_Y * s, z),
        flameY: FLAME_Y * s,
        tone: rng.range(-1, 1),
        moss: rng.range(0.0, 0.34),
        seed: rng.range(0, 40),
        phase: rng.range(0, 6.283),
      });
    }
    // Nearest-to-the-camera-side first: the flame uniform array is capped, and
    // the lantern beside the trunk must never be the one that gets dropped.
    const nL = lanterns.length;

    const mkInstAttr = (list, fn) => {
      const a = new Float32Array(list.length * 4);
      for (let i = 0; i < list.length; i++) {
        const v = fn(list[i], i);
        a[i * 4] = v[0]; a[i * 4 + 1] = v[1]; a[i * 4 + 2] = v[2]; a[i * 4 + 3] = v[3];
      }
      return new THREE.InstancedBufferAttribute(a, 4);
    };

    /* One matrix per lantern, reused by the granite, the washi and the halo. */
    const lanternMatrices = [];
    {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const sv = new THREE.Vector3();
      for (const l of lanterns) {
        const n = normAt(l.position.x, l.position.z);
        // sit the whole lantern on the local slope, but only 55% of the way —
        // a stone lantern is set upright by a gardener, not dropped on a hill
        e.set(n.z * 0.55, l.yaw, -n.x * 0.55, 'YXZ');
        q.setFromEuler(e);
        sv.set(l.scale, l.scale, l.scale);
        lanternMatrices.push(m.compose(l.position, q, sv).clone());
      }
    }

    /* The granite goes into TWO instanced meshes, split by distance from the
     * trunk, and only the NEAR one casts.
     *
     * MEASURED: 08-lighting fits its shadow ortho box to the union bounding
     * sphere of every visible caster. One mesh holding all four lanterns has a
     * 13 m span, so its sphere (r ~8, centred 5 m off the trunk) unioned with the
     * tree's (r 9 at y 6) and pushed the fitted half-extent from 17 m to 33 m —
     * `rig.shadowTexel` went 8.3 mm -> 16.4 mm, i.e. the tree's own hard-won
     * cast shadow lost half its resolution. Splitting the set costs one draw call
     * and puts it back to ~10 mm while the two lanterns you can actually see up
     * close keep their shadows. */
    const NEAR_CAST_R = 5.0;
    const nearIdx = [], farIdx = [];
    for (let i = 0; i < nL; i++) {
      (Math.hypot(lanterns[i].position.x, lanterns[i].position.z) < NEAR_CAST_R ? nearIdx : farIdx)
        .push(i);
    }
    const lanternMeshes = [];
    for (const [idxs, near] of [[nearIdx, true], [farIdx, false]]) {
      if (!idxs.length) continue;
      const geo = lanternGeo.clone();
      disposables.push(geo);
      geo.setAttribute('aVar', mkInstAttr(idxs.map((i) => lanterns[i]),
        (l) => [l.moss, l.tone, l.seed, l.phase]));
      const mesh = new THREE.InstancedMesh(geo, stoneMatInst, idxs.length);
      mesh.name = near ? 'stone-lanterns-near' : 'stone-lanterns-far';
      mesh.castShadow = near;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let k = 0; k < idxs.length; k++) mesh.setMatrixAt(k, lanternMatrices[idxs[k]]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      lanternMeshes.push(mesh);
      group.add(mesh);
    }

    windowGeo.setAttribute('aVar', mkInstAttr(lanterns, (l) => [0, 0, l.seed, l.phase]));
    const windowMesh = new THREE.InstancedMesh(windowGeo, windowMat, nL);
    windowMesh.name = 'lantern-windows';
    windowMesh.castShadow = false;
    windowMesh.receiveShadow = false;
    {
      const col = new THREE.Color(1, 1, 1);
      for (let i = 0; i < nL; i++) {
        windowMesh.setMatrixAt(i, lanternMatrices[i]);
        windowMesh.setColorAt(i, col);
      }
      windowMesh.instanceMatrix.needsUpdate = true;
      if (windowMesh.instanceColor) windowMesh.instanceColor.needsUpdate = true;
      windowMesh.computeBoundingSphere();
    }
    group.add(windowMesh);

    /* ---- the additive halo billboards ---- */
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    disposables.push(haloGeo);
    const haloMesh = new THREE.InstancedMesh(haloGeo, haloMat, nL);
    haloMesh.name = 'lantern-halo';
    haloMesh.castShadow = false;
    haloMesh.receiveShadow = false;
    haloMesh.frustumCulled = false;
    haloMesh.renderOrder = 6;
    {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
      const col = new THREE.Color();
      for (let i = 0; i < nL; i++) {
        const l = lanterns[i];
        sv.set(l.scale, l.scale, l.scale);
        m.compose(l.flame, q, sv);
        haloMesh.setMatrixAt(i, m);
        col.setRGB(1, 1, 1);
        haloMesh.setColorAt(i, col);
      }
      haloMesh.instanceMatrix.needsUpdate = true;
      if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
    }
    group.add(haloMesh);

    /* ---- the flames themselves ----
     * A point light per fire box. It goes through 08-lighting's lamp registry
     * rather than being a bare THREE.PointLight, because every surface in this
     * project is NPR-shaded and therefore invisible to three's own light loop:
     * the rig's `nprLamps()` (called inside nprShadeN) is what actually spends a
     * lamp, and it spends it on the lantern's granite, the path slabs, the grass,
     * the trunk and the pond alike. A registered lamp also does NOT raise
     * NUM_POINT_LIGHTS, so it cannot force every other module's shader to
     * recompile with an extra uniform array it will never read.
     *
     * The bare-PointLight path is kept as the fallback for the case where the rig
     * has not published addLamp() — the rig adopts scene PointLights too.
     *
     * Intensity: the rig normalises by flux at half range,
     *   level = intensity / (0.25 * range^2 + 1)
     * so LAMP_I / LAMP_RANGE below land a lit fire box at 5.6 / (0.25*56.25+1) =
     * 0.37 linear — about a third of the golden-hour key (uSunColor ~ 1.12) and
     * roughly 2.5x the night key (~0.15). Computed, not guessed.
     *
     * `low` gets no lamp at all: the emissive washi panel and the additive halo
     * still read, which is the cheap fake the brief asks for. */
    /* r3: 5.6 -> 7.6 at the same 7.5 m range, i.e. level 0.372 -> 0.505. The
     * review wanted the night ground pool to read >= 0.10 display L above the
     * surrounding grass; MEASURED on shots/critic-p4-r2-night/hero.png it was
     * +0.147 over open grass but the sample was contaminated by near-field petal
     * bokeh, and the pool visibly stopped at the path slabs. The windowed falloff
     * (1 - d/R)^2 concentrates 64% of the level inside 1.5 m, so raising the level
     * widens the READABLE pool without lengthening its reach past 7.5 m — which
     * matters, because the lamps must not start lighting the far wall. */
    const LAMP_RANGE = 7.5;
    const LAMP_I = 7.6;
    const lampSlots = Math.min(nL, tier.lights);
    const lamps = [];              // { set(intensity) }
    const addLamp = ctx.assets.lighting?.addLamp;
    for (let i = 0; i < lampSlots; i++) {
      const flame = lanterns[i].flame;
      if (typeof addLamp === 'function') {
        const h = addLamp({ position: flame, color: 0xFFB25E, intensity: 0, range: LAMP_RANGE });
        lamps.push({ set: (v) => { h.intensity = v; h.enabled = v > 0.004; }, handle: h });
      } else {
        const pl = new THREE.PointLight(C(0xFFB25E), 0, LAMP_RANGE, 2.0);
        pl.castShadow = false;
        pl.position.copy(flame);
        pl.visible = false;
        group.add(pl);
        lamps.push({ set: (v) => { pl.intensity = v; pl.visible = v > 0.004; }, light: pl });
      }
    }

    /* ================================================================ *
     * 4. The stone wall — instanced irregular blocks on the contour
     * ================================================================ */
    const blockGeo = blockGeometry(tier.blockSeg, 4.7);
    disposables.push(blockGeo);
    {
      // bake per-vertex moss/AO onto the block: moss on the top, AO at the foot
      const p = blockGeo.attributes.position;
      const st = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        st[i * 3] = 0.14 + 0.34 * Math.max(0, y);          // moss bias, top-heavy
        st[i * 3 + 1] = 0.70 + 0.30 * Math.min(1, (y + 0.5) / 0.45);   // baked AO
        st[i * 3 + 2] = 0.85;                              // crevice weight
      }
      blockGeo.setAttribute('aStone', new THREE.Float32BufferAttribute(st, 3));
    }

    const wallBlocks = [];
    const arcLen = ((WALL_AZ1 - WALL_AZ0) * Math.PI / 180) * WALL_R;
    const perRow = Math.max(6, Math.round(arcLen / tier.blockStep));
    const GAPS = [[196, 203], [262, 269]];   // where the wall has come down
    const inGap = (az) => GAPS.some(([a, b]) => az > a && az < b);
    const wrng = makeRng(0x9911);
    for (let row = 0; row < tier.wallRows + 1; row++) {
      const cap = row === tier.wallRows;
      const count = cap ? Math.round(perRow * 0.92) : perRow;
      for (let i = 0; i < count; i++) {
        const f = (i + (row % 2) * 0.5 + 0.5) / count;
        const az = WALL_AZ0 + f * (WALL_AZ1 - WALL_AZ0);
        if (inGap(az)) continue;
        if (!cap && row >= tier.wallRows - 1 && wrng.next() < 0.10) continue;
        if (cap && wrng.next() < 0.16) continue;
        const ar = az * Math.PI / 180;
        const r = WALL_R + 0.95 * Math.sin(az * 0.055) + 0.55 * Math.sin(az * 0.19 + 1.3)
          + wrng.range(-0.10, 0.10);
        const x = Math.cos(ar) * r, z = Math.sin(ar) * r;
        const gy = groundAt(x, z);
        const rowH = cap ? 0.215 : 0.300;
        const y = gy - 0.12 + row * 0.268 + (cap ? 0.03 : 0) + wrng.range(-0.025, 0.025);
        // yaw that lays the block's LONG (local x) axis along the arc tangent
        const along = Math.atan2(-Math.cos(ar), -Math.sin(ar));
        const n = normAt(x, z);
        wallBlocks.push({
          x, y: y + rowH * 0.5, z,
          w: cap ? wrng.range(0.82, 1.12) : wrng.range(0.62, 0.96),
          h: rowH * wrng.range(0.90, 1.10),
          d: cap ? wrng.range(0.64, 0.80) : wrng.range(0.54, 0.74),
          yaw: along + wrng.range(-0.16, 0.16),
          tiltX: n.z * 0.5 + wrng.range(-0.07, 0.07),
          tiltZ: -n.x * 0.5 + wrng.range(-0.07, 0.07),
          moss: wrng.range(0.0, 0.42) + (cap ? 0.16 : 0),
          tone: wrng.range(-1, 1),
          seed: wrng.range(0, 40),
        });
      }
    }
    // tumbled stones at the foot of the collapsed sections
    for (const [a, b] of GAPS) {
      for (let i = 0; i < 4; i++) {
        const az = a + (b - a) * wrng.range(-0.3, 1.3);
        const ar = az * Math.PI / 180;
        const r = WALL_R + 0.95 * Math.sin(az * 0.055) + wrng.range(-1.5, 1.4);
        const x = Math.cos(ar) * r, z = Math.sin(ar) * r;
        const gy = groundAt(x, z);
        const h = wrng.range(0.20, 0.30);
        wallBlocks.push({
          x, y: gy + h * 0.28, z,
          w: wrng.range(0.48, 0.76), h, d: wrng.range(0.42, 0.62),
          yaw: wrng.range(0, 6.283), tiltX: wrng.range(-0.5, 0.5), tiltZ: wrng.range(-0.5, 0.5),
          moss: wrng.range(0.3, 0.85), tone: wrng.range(-1, 1), seed: wrng.range(0, 40),
        });
      }
    }

    const wallGeoInst = blockGeo;
    const wallMesh = new THREE.InstancedMesh(wallGeoInst, stoneMatWall, Math.max(1, wallBlocks.length));
    wallMesh.name = 'stone-wall';
    // Deliberately NOT a shadow caster: 08-lighting fits its ortho box to the
    // union of visible casters, and a 24 m arc of wall would inflate it by a
    // third and cost the tree's own shadow its texel density.
    wallMesh.castShadow = false;
    wallMesh.receiveShadow = true;
    wallMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), sv = new THREE.Vector3();
      const av = new Float32Array(wallBlocks.length * 4);
      for (let i = 0; i < wallBlocks.length; i++) {
        const b = wallBlocks[i];
        e.set(b.tiltX, b.yaw, b.tiltZ, 'YXZ');
        q.setFromEuler(e);
        p.set(b.x, b.y, b.z);
        sv.set(b.w, b.h, b.d);
        wallMesh.setMatrixAt(i, m.compose(p, q, sv));
        av[i * 4] = b.moss; av[i * 4 + 1] = b.tone; av[i * 4 + 2] = b.seed; av[i * 4 + 3] = 0;
      }
      wallGeoInst.setAttribute('aVar', new THREE.InstancedBufferAttribute(av, 4));
      wallMesh.instanceMatrix.needsUpdate = true;
      wallMesh.computeBoundingSphere();
    }
    group.add(wallMesh);

    /* ================================================================ *
     * 5. Boulders — near ones cast, far ones only receive
     * ================================================================ */
    const rockGeo = rockGeometry(tier.rock, 5.3, 0.80);
    disposables.push(rockGeo);
    {
      const p = rockGeo.attributes.position;
      const st = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        st[i * 3] = 0.34 + 0.62 * Math.max(0, y * 2);
        st[i * 3 + 1] = 0.42 + 0.58 * Math.min(1, (y + 0.42) / 0.40);
        st[i * 3 + 2] = 0.9;
      }
      rockGeo.setAttribute('aStone', new THREE.Float32BufferAttribute(st, 3));
    }

    const BOULDERS = [
      // hero's lower-LEFT anchor — the foreground element ART_BIBLE §5 asks for
      { x: -2.17, z: 7.62, r: 1.18, near: true },
      // the pond's east shoreline stone, 4.7 m from the `pond` lens
      { x: -4.60, z: 9.60, r: 1.34, near: false, wet: true },
      { x: -5.60, z: -1.20, r: 0.78, near: true },
      { x: -2.90, z: -10.82, r: 0.98, near: false },
      { x: -8.35, z: -5.85, r: 0.86, near: false },
      { x: 6.40, z: 5.90, r: 0.62, near: true },
      { x: -11.6, z: 2.10, r: 0.74, near: false, wet: true },
    ];
    const rockGroups = [];
    for (const near of [true, false]) {
      const list = BOULDERS.filter((b) => !!b.near === near);
      if (!list.length) continue;
      // Two meshes off one geometry so the NEAR set can cast while the far set
      // only receives — 08-lighting fits its ortho box to the union of visible
      // casters, and a boulder out at r = 12 would inflate it for no gain.
      const geo = rockGeo.clone();
      disposables.push(geo);
      const mesh = new THREE.InstancedMesh(geo, stoneMatRock, list.length);
      mesh.name = near ? 'boulders-near' : 'boulders-far';
      mesh.castShadow = near;
      mesh.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), sv = new THREE.Vector3();
      const av = new Float32Array(list.length * 4);
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        let bx = b.x, bz = b.z;
        if (!b.wet) [bx, bz] = dryLand(bx, bz, 0.05);
        const gy = groundAt(bx, bz);
        e.set(rng.range(-0.25, 0.25), rng.range(0, 6.283), rng.range(-0.25, 0.25), 'YXZ');
        q.setFromEuler(e);
        // sunk a third of the way in: a boulder is bedded, never balanced
        p.set(bx, gy - b.r * 0.30, bz);
        sv.set(b.r * rng.range(1.0, 1.25), b.r * rng.range(0.86, 1.06), b.r * rng.range(1.0, 1.25));
        mesh.setMatrixAt(i, m.compose(p, q, sv));
        av[i * 4] = rng.range(0.10, 0.55); av[i * 4 + 1] = rng.range(-1, 1);
        av[i * 4 + 2] = rng.range(0, 40); av[i * 4 + 3] = 0;
      }
      geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(av, 4));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      rockGroups.push(mesh);
      group.add(mesh);
    }

    /* ================================================================ *
     * 6. Tsukubai — the water basin, its bamboo spout and flanking stones
     * ================================================================ */
    const BASIN = { x: 0.45, z: 3.42 };
    const [bx0, bz0] = dryLand(BASIN.x, BASIN.z, 0.30);
    const basinY = groundAt(bx0, bz0);
    const SM = new Mesher(stoneSpec);
    const BO = new THREE.Vector3(bx0, basinY, bz0);
    const bVals = (crev, mossAdd = 0) => ({
      aStone: (w) => [Math.max(0, 1 - (w.y - basinY) / 0.8) * 0.8 + 0.18 + mossAdd,
        0.44 + 0.56 * Math.min(1, (w.y - basinY + 0.12) / 0.34), crev],
    });
    // the chozubachi: a squat drum with a hollowed rim
    latheN(SM, bevelProfile([[0.00, -0.14], [0.400, -0.12], [0.415, 0.10], [0.395, 0.30],
      [0.360, 0.365], [0.300, 0.375], [0.290, 0.320], [0.150, 0.300], [0.00, 0.292]], 0.014),
    24, BO, 0, bVals(0.9), 0.10, 0, 0);
    // two flanking stones (yuoke-ishi / teshoku-ishi) — the classic trio
    for (const [dx, dz, r, h] of [[0.62, 0.16, 0.34, 0.20], [-0.34, 0.60, 0.28, 0.15]]) {
      const sx = bx0 + dx, sz = bz0 + dz;
      const sy = groundAt(sx, sz);
      _mtx.compose(new THREE.Vector3(sx, sy - r * 0.34, sz),
        _q.setFromEuler(_e.set(rng.range(-0.2, 0.2), rng.range(0, 6.28), rng.range(-0.2, 0.2), 'YXZ')),
        _s.set(r * 2.1, h * 2.4, r * 1.8));
      SM.addGeo(rockGeo, _mtx, {
        aStone: (w) => [0.55, 0.5 + 0.5 * Math.min(1, (w.y - sy + 0.1) / 0.3), 0.9],
      });
    }
    // the torii's own footing collars, in the same one-draw-call stone mesh
    for (const foot of [footA, footB]) {
      const fy = groundAt(foot[0], foot[1]);
      latheN(SM, bevelProfile([[0.00, -0.16], [0.345, -0.16], [0.355, 0.02], [0.315, 0.115],
        [0.255, 0.135], [0.00, 0.135]], 0.014), 30, new THREE.Vector3(foot[0], fy, foot[1]),
      rng.range(0, 1), {
        aStone: (w) => [0.62, 0.42 + 0.58 * Math.min(1, (w.y - fy + 0.16) / 0.30), 0.95],
      }, 0.02);
    }
    const basinStoneGeo = SM.build('tsukubai-stone');
    disposables.push(basinStoneGeo);
    {
      const av = new Float32Array(basinStoneGeo.attributes.position.count * 4);
      for (let i = 0; i < av.length; i += 4) { av[i] = 0.12; av[i + 1] = 0.1; av[i + 2] = 12.7; }
      basinStoneGeo.setAttribute('aVar', new THREE.Float32BufferAttribute(av, 4));
    }
    const basinStone = new THREE.Mesh(basinStoneGeo, stoneMatSolid);
    basinStone.name = 'tsukubai';
    basinStone.castShadow = true;
    basinStone.receiveShadow = true;
    group.add(basinStone);

    // the bamboo spout (kakei) — a split culm on a forked post
    const BM = new Mesher(woodSpec);
    const spoutBase = new THREE.Vector3(bx0 - 0.62, groundAt(bx0 - 0.62, bz0 - 0.42) - 0.25, bz0 - 0.42);
    const spoutTop = new THREE.Vector3(spoutBase.x, basinY + 0.92, spoutBase.z);
    const bGrain = (w) => [w.y - basinY, (w.x - bx0) * 0.7 + (w.z - bz0) * 0.7];
    tube(BM, spoutBase, spoutTop, 0.062, 0.052, 8, {
      aWood: (w) => [0.5, 0.0, w.y - spoutBase.y, 0.5 + 0.5 * Math.min(1, (w.y - spoutBase.y) / 0.4)],
      aGrain: bGrain, aVar: [0, 0, 5.5, 0],
    });
    const spoutTip = new THREE.Vector3(bx0 - 0.02, basinY + 0.70, bz0 - 0.05);
    tube(BM, spoutTop.clone().setY(basinY + 0.84), spoutTip, 0.050, 0.044, 8, {
      aWood: (w) => [0.42, 0.0, 0.9, 0.94],
      aGrain: (w) => [(w.x - bx0) * 0.8 + (w.z - bz0) * 0.8, (w.y - basinY) * 0.7],
      aVar: [0, 0, 6.6, 0],
    });
    const bambooGeo = BM.build('kakei');
    disposables.push(bambooGeo);
    const bambooMesh = new THREE.Mesh(bambooGeo, bambooMat);
    bambooMesh.name = 'bamboo-spout';
    bambooMesh.castShadow = true;
    bambooMesh.receiveShadow = true;
    group.add(bambooMesh);

    // the water surface inside the basin
    const basinWaterGeo = new THREE.CircleGeometry(0.292, 24);
    basinWaterGeo.rotateX(-Math.PI / 2);
    disposables.push(basinWaterGeo);
    const basinWater = new THREE.Mesh(basinWaterGeo, basinMat);
    basinWater.name = 'tsukubai-water';
    basinWater.position.set(bx0, basinY + 0.306, bz0);
    basinWater.receiveShadow = true;
    group.add(basinWater);

    /* ================================================================ *
     * 7. Ema plaques — instanced, swinging in the ONE global wind
     * ================================================================ */
    const EM = new Mesher({ aWood: 4, aGrain: 2, aEdge: 1 });
    {
      // One votive plaque, hanging from a pivot at the local origin. aWood.z is
      // SIGNED height relative to that pivot, so the vertex shader knows how far
      // below the rail each vertex hangs and swings it by that much.
      const HW = 0.112, TOP = -0.062, BOT = -0.256, APEX = 0.016, th = 0.011;
      const pv = (x, y, z) => new THREE.Vector3(x, y, z);
      const ref = pv(0, -0.15, 0);
      const wVals = {
        aWood: (w) => [0.4, 0.0, w.y, 0.94],
        aGrain: (w) => [w.x, w.y],
      };
      // the pentagon outline, traced clockwise in the local xy plane
      const outline = [
        pv(-HW, TOP, 0), pv(0, APEX, 0), pv(HW, TOP, 0), pv(HW, BOT, 0), pv(-HW, BOT, 0),
      ];
      for (const sgn of [-1, 1]) {
        // body
        EM.quad(pv(-HW, TOP, sgn * th), pv(HW, TOP, sgn * th),
          pv(HW, BOT, sgn * th), pv(-HW, BOT, sgn * th), ref, wVals,
          [[0, 0.75], [1, 0.75], [1, 0], [0, 0]]);
        // gable, as a kite quad so nothing is degenerate
        EM.quad(pv(-HW, TOP, sgn * th), pv(0, APEX, sgn * th),
          pv(HW, TOP, sgn * th), pv(0, TOP, sgn * th), ref, wVals,
          [[0, 0.75], [0.5, 1], [1, 0.75], [0.5, 0.75]]);
      }
      // the sawn edge band round the outline
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        EM.quad(a.clone().setZ(-th), b.clone().setZ(-th), b.clone().setZ(th), a.clone().setZ(th),
          ref, wVals, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      }
      // the cord it hangs by
      tube(EM, pv(0, 0.006, 0), pv(0, -0.056, 0), 0.006, 0.006, 4, {
        aWood: (w) => [0.2, 0.0, w.y, 1.0], aGrain: (w) => [w.y, 0],
      }, false);
    }
    const emaGeo = EM.build('ema');
    disposables.push(emaGeo);
    const emaCount = tier.ema;
    {
      const av = new Float32Array(emaCount * 4);
      for (let i = 0; i < emaCount; i++) {
        av[i * 4] = 0; av[i * 4 + 1] = rng.range(-1, 1);
        av[i * 4 + 2] = rng.range(0, 40); av[i * 4 + 3] = rng.next();
      }
      emaGeo.setAttribute('aVar', new THREE.InstancedBufferAttribute(av, 4));
    }
    const emaMesh = new THREE.InstancedMesh(emaGeo, emaMat, emaCount);
    emaMesh.name = 'ema-plaques';
    emaMesh.castShadow = false;     // it sways in the vertex shader; the depth
    emaMesh.receiveShadow = true;   // pass would not follow it
    {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const p = new THREE.Vector3(), sv = new THREE.Vector3();
      for (let i = 0; i < emaCount; i++) {
        const u = -1.24 + (i + 0.5) / emaCount * 2.48 + rng.range(-0.03, 0.03);
        const v = rng.range(-0.13, 0.13);
        p.copy(EP(u, emaRailY - 0.075, v));
        e.set(rng.range(-0.10, 0.10), emaYaw + rng.range(-0.30, 0.30), rng.range(-0.14, 0.14), 'YXZ');
        q.setFromEuler(e);
        const s = rng.range(0.88, 1.12);
        sv.set(s, s, s);
        emaMesh.setMatrixAt(i, m.compose(p, q, sv));
      }
      emaMesh.instanceMatrix.needsUpdate = true;
      emaMesh.computeBoundingSphere();
      if (emaMesh.boundingSphere) emaMesh.boundingSphere.radius += 0.6;
    }
    group.add(emaMesh);

    /* ================================================================ *
     * 8. Publish + wire the dusk/dawn glow
     * ================================================================ */
    const props = {
      group,
      torii: {
        mesh: woodMesh,
        position: O.clone(),
        rotationY: toriiYaw,
        width: TORII_SPAN,
        height: TORII_H + 0.75,
        pathT: TORII_T,
        feet: [footA, footB],
      },
      lanternMeshes,
      lanterns: lanterns.map((l) => ({
        position: l.position.clone(),
        flame: l.flame.clone(),
        flameY: l.flameY,
        scale: l.scale,
      })),
      wall: {
        mesh: wallMesh, radius: WALL_R,
        azFrom: WALL_AZ0, azTo: WALL_AZ1, count: wallBlocks.length,
      },
      boulders: rockGroups,
      basin: { mesh: basinStone, water: basinWater, position: new THREE.Vector3(bx0, basinY, bz0) },
      ema: { mesh: emaMesh, count: emaCount },
      glow: 0,
    };
    ctx.assets.props = props;

    /* ---- glow target from the time of day ----
     * `time:phase` is the contract's event, so it is what decides on/off. The
     * rig's continuous dayT (when it exists) then shapes the ramp inside the
     * phase, so lighting-up is a slow blue-hour swell rather than a step. */
    let phase = 'day';
    let phaseT = 0;
    const phaseGlow = (name, t) => {
      switch (name) {
        case 'dusk': return THREE.MathUtils.smoothstep(t, -0.06, 0.46);
        case 'night': return 1;
        case 'dawn': return 1 - THREE.MathUtils.smoothstep(t, 0.06, 0.62);
        default: return 0;
      }
    };
    ctx.bus.on('time:phase', (p) => {
      if (!p) return;
      phase = p.phase ?? phase;
      phaseT = p.t ?? 0;
    });

    let forcedGlow = null;
    const sc = (typeof window !== 'undefined' && window.__game && window.__game.scenarios) || null;
    if (sc) {
      sc['lanterns-on'] = () => { forcedGlow = 1; };
      sc['lanterns-off'] = () => { forcedGlow = 0; };
      sc['lanterns-auto'] = () => { forcedGlow = null; };
      /* Granite diagnostics. Recompiles the stone programs with one debug branch
       * enabled so a shot can isolate albedo from shading — this is how the r1
       * "albedo was 2.4x too dark" and "rim+spec was adding scene-linear 0.37"
       * numbers in this file were obtained. Zero cost when unused. */
      const dbg = (key) => () => {
        for (const m of [stoneMatSolid, stoneMatInst, stoneMatWall, stoneMatRock]) {
          delete m.defines.PROPS_DBG_ALBEDO;
          delete m.defines.PROPS_DBG_NORIM;
          delete m.defines.PROPS_DBG_FLAT;
          if (key) m.defines[key] = '';
          m.needsUpdate = true;
        }
      };
      sc['props-albedo'] = dbg('PROPS_DBG_ALBEDO');
      sc['props-norim'] = dbg('PROPS_DBG_NORIM');
      sc['props-bands'] = dbg('PROPS_DBG_FLAT');
      sc['props-normal'] = dbg(null);
    }

    let glow = 0;
    let lastFm = 1;                 // forces one write on the first frame
    const flick = new Float32Array(nL).fill(1);
    const _fc = new THREE.Color();
    const _rig = () => ctx.assets.lightRig ?? null;
    const phaseOfFn = ctx.assets.lighting?.phaseOf;

    /* ================================================================ */
    return {
      object3D: group,

      update(dt, time) {
        uTime.value = time;

        // ---- phase -> target glow
        const rig = _rig();
        let target;
        if (forcedGlow != null) target = forcedGlow;
        else if (rig && typeof rig.dayT === 'number' && typeof phaseOfFn === 'function') {
          /* THE AUTHORITATIVE PHASE, never a local copy of its bounds.
           *
           * THIS WAS THE DAYLIGHT-BLOWOUT BUG, and it was not in the shaders at
           * all. r9 inlined 08-lighting's phase bounds here (`dusk` from 0.625)
           * to get a continuous ramp out of the discrete `time:phase` event.
           * src/lib/lighting.js then moved the day/dusk boundary to 0.690 so a
           * fresh save opens on a golden-hour DAY sky — and this copy did not
           * move with it. MEASURED at the default clock (dayT 0.6754, warm 300):
           * rig.phase 'day', uNightMix 0.005, and this function returning
           * glow = 0.666, i.e. every fire box burning at 66% in full daylight.
           * That is the "flat saturated yellow blob" in shots/dbg-nopost/hero.png
           * and the 245,233,210 panel in shots/props-p5-r0/hero.png.
           *
           * ctx.assets.lighting.phaseOf() is the same function 08-lighting emits
           * `time:phase` from, so this cannot drift again. */
          const po = phaseOfFn(rig.dayT);
          target = phaseGlow(po.phase, po.t);
        } else target = phaseGlow(phase, phaseT);

        const k = 1 - Math.exp(-dt * 1.6);
        glow += (target - glow) * (dt > 0 ? k : 1);
        if (dt === 0) glow = target;
        props.glow = glow;
        uGlow.value = glow;

        // ---- per-flame flicker: two detuned oscillators plus a rare guttering.
        // Faded to a flat 1 as the fire dies so the DAYTIME panel is a still
        // surface: nothing in an unlit stone box has any business pulsing.
        const fm = Math.min(1, glow * 2.0);
        for (let i = 0; i < nL; i++) {
          const ph = lanterns[i].phase;
          const a = Math.sin(time * 5.7 + ph) * 0.5 + Math.sin(time * 11.3 + ph * 2.1) * 0.28;
          const gutter = Math.max(0, Math.sin(time * 0.83 + ph * 3.7) - 0.86) * 2.6;
          const f = THREE.MathUtils.clamp(1 + a * 0.085 - gutter, 0.42, 1.12);
          flick[i] = 1 + (f - 1) * fm;
        }

        if (fm > 0.001 || lastFm > 0.001) {
          for (let i = 0; i < nL; i++) {
            _fc.setRGB(flick[i], flick[i], flick[i]);
            windowMesh.setColorAt(i, _fc);
            haloMesh.setColorAt(i, _fc);
          }
          if (windowMesh.instanceColor) windowMesh.instanceColor.needsUpdate = true;
          if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
        }
        lastFm = fm;
        haloMesh.visible = glow > 0.004;
        // 1.55 + 0.35 -> 2.30 + 0.85: the skirt lobe now covers the 2.5 m warm
        // falloff the review asked for. Its per-pixel strength was cut in
        // props-shaders.js to keep the total additive energy about where it was.
        haloMat.uniforms.uSize.value = 2.30 + 0.85 * glow;

        for (let i = 0; i < lamps.length; i++) lamps[i].set(glow * flick[i] * LAMP_I);
      },

      dispose() {
        for (const l of lamps) l.handle?.release?.();
        group.clear();
        for (const d of disposables) d.dispose?.();
        if (ctx.assets.props === props) ctx.assets.props = null;
      },
    };
  },
};
