import * as THREE from 'three';
import { makeRng } from '../lib/rng.js';
import { noise3 } from '../lib/noise.js';
import { WIND } from '../lib/wind.js';
import { createLightUniforms } from '../lib/lighting.js';
import {
  buildBarkTextures, buildBlossomAtlas,
  TRUNK_VERT, TRUNK_FRAG, TRUNK_DEPTH_VERT, DEPTH_FRAG,
  CANOPY_VERT, CANOPY_FRAG, CANOPY_DEPTH_VERT, CANOPY_DEPTH_FRAG,
  SHAFT_VERT, SHAFT_FRAG,
  ATLAS_COLS, ATLAS_BLOSSOM_COUNT, ATLAS_SPARSE_FIRST, ATLAS_SPARSE_COUNT,
} from '../lib/tree-shaders.js';

/**
 * 30-tree.js — the hero asset: one ancient sakura.
 *
 * Trunk base at the world origin, ~14 units tall, crown centred near y=10 with
 * a radius of ~7.5. Everything here is seeded (src/lib/rng.js) so screenshots
 * are byte-reproducible.
 *
 * Structure
 *   1. A recursive branch SKELETON (5 levels: trunk -> 5 primary limbs ->
 *      secondaries -> tertiaries -> drooping twigs) plus surface roots. Branch
 *      direction integrates a noise-driven gnarl term and a per-level gravity
 *      droop, so nothing repeats and nothing looks fractal.
 *   2. One merged tube BufferGeometry for the whole woody structure, carrying
 *      aStiff (normalised distance from the root, drives wind), aPhase (per
 *      branch lag) and aCav (junction AO).
 *   3. ONE InstancedMesh of alpha-tested blossom-cluster cards distributed over
 *      the outer skeleton in three depth layers, so the crown reads as a volume
 *      with a dark interior and a rim-lit, broken-up outer edge.
 *
 * Published for other modules:
 *   ctx.assets.tree = { group, trunkMesh, canopyMeshes, branchTips,
 *                       canopyBounds, sampleBranchPoint, stage }
 */

const SEED = 0xC5A11;

/* ------------------------------------------------------------------ *
 * Bloom-stage response curves (GAME_DESIGN.md "Bloom stages")
 * ------------------------------------------------------------------ */
/**
 * Stage 1 (蕾 Budding) is now the FIRST-RUN state, so it has to be a deliberate,
 * attractive look and not a way-station: swelling pink buds over the whole crown
 * plus a genuine scattering of open blossom. Stage 0 (冬芽 Winter Bud) is the
 * post-prestige reset — bare, cool, but never a dead brown skeleton.
 */
const STAGE = {
  /* Coverage runs PAST 1.0 at stages 4-5 on purpose. ~15 % of the cards are
   * seeded with a growth order above 1.0 (see `order` below), so stages 4 and 5
   * add card COUNT at constant card SIZE — which is how a real canopy thickens.
   * MEASURED r2: stages 3, 4 and 5 were geometrically identical and the mass had
   * smoothed into "one cauliflower"; growing the card scale instead (the obvious
   * alternative) is exactly what produces that. */
  coverage: [0.125, 0.330, 0.590, 1.000, 1.115, 1.235],
  budMix: [1.000, 0.560, 0.210, 0.045, 0.020, 0.000],
  // MEASURED r9: at 0.195 the stage-5 crown printed at mean display L 0.75, sd
  // 0.075 — blown to near-white, the opposite of "luminous". The glow has to be a
  // sheen on a crown that still has a value ladder, not a replacement for it.
  lumin: [0.000, 0.000, 0.000, 0.015, 0.070, 0.115],
  // 0.360 -> 0.260: see the vein block in TRUNK_FRAG. At 0.36 x the old broad
  // vein mask the trunk printed lime.
  gold: [0.000, 0.000, 0.000, 0.000, 0.038, 0.260],
  // "bare" greys + cools the bark. 1.0 at stage 0 used to crush it to near
  // black; the shader tint it drives is much lighter now (see TRUNK_FRAG).
  bare: [1.000, 0.300, 0.080, 0.000, 0.000, 0.000],
  moss: [0.520, 0.700, 0.860, 0.940, 0.940, 0.900],
  /* ---- stage 5 常桜 Everblossom, GAME_DESIGN.md line by line -------------
   * "gold-veined bark, aurora petals, light shafts, floating islands of blossom".
   * A review measured stage 5's crown at luminance sd 0.040 over 90x90 px —
   * FLATTER than stage 1 — and none of these four features present. This is the
   * game's long-term reward, so all four are here, and stage 4 gets a deliberate
   * foretaste of each so the jump reads as an escalation rather than a switch. */
  // MEASURED r5 at 0.500: the stage-5 crown printed HSL sat 0.24 with only 1.7 % of
  // its pixels outside the pink hue band — i.e. the aurora was not reading at all.
  // GAME_DESIGN.md names "aurora petals" as a headline Everblossom feature, so it
  // has to be visible; 0.90 is where the mint/violet/gold curtains resolve.
  // ...and the aurora is three ADDITIVE bands whose overlap is near-white, so at
  // 0.90 it was also lifting the crown's level rather than colouring it. 0.45 is
  // where the mint/violet/gold curtains read without bleaching the blossom.
  aurora: [0.000, 0.000, 0.000, 0.000, 0.080, 0.450],
  island: [0.000, 0.000, 0.000, 0.000, 0.130, 1.000],
  shafts: [0.000, 0.000, 0.000, 0.000, 0.160, 1.000],
};
const stageAt = (arr, s) => {
  const t = THREE.MathUtils.clamp(s, 0, 5);
  const i = Math.min(4, Math.floor(t));
  return THREE.MathUtils.lerp(arr[i], arr[i + 1], t - i);
};

/* ================================================================== *
 * 1. Skeleton
 * ================================================================== */

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * @param {number} groundY terrain height at the trunk, WORLD metres. The tree
 *   group carries a yaw only (no translation), so local y === world y and every
 *   root / flare height below is measured from this. MEASURED: with the roots
 *   authored at y = 0.18..0.52 and the terrain summit at y = 1.27, all six
 *   surface roots and 62 % of the flare were BURIED — which is the whole reason
 *   the trunk read as a straight lathe cone plunging into the grass.
 */
function buildSkeleton(groundY = 0) {
  const rng = makeRng(SEED);
  const branches = [];
  let maxDist = 1;

  /** Integrate one branch: gnarl + droop + a pull back toward its mean heading. */
  function grow(o) {
    const { start, dir, len, r0, r1, level, segs, droop, gnarl, keep } = o;
    const p = start.clone();
    const d = dir.clone().normalize();
    const mean = d.clone();
    const pts = [];
    let dist = o.dist0;
    const step = len / segs;
    const nSeed = rng.range(0, 60);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({
        p: p.clone(),
        // continuous taper with a slight bulge low down — real trunks are not cones
        r: THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.72)) * (1 + 0.055 * Math.sin(t * 7.3 + nSeed)),
        dist,
      });
      if (i === segs) break;
      // gnarl: a smooth 3D wander sampled along the branch path
      const gx = noise3(p.x * 0.42 + nSeed, p.y * 0.42, p.z * 0.42);
      const gy = noise3(p.x * 0.42 + 31.7, p.y * 0.42 + nSeed, p.z * 0.42);
      const gz = noise3(p.x * 0.42, p.y * 0.42 + 11.3, p.z * 0.42 + nSeed);
      d.x += gx * gnarl; d.y += gy * gnarl * 0.45; d.z += gz * gnarl;
      d.y -= droop * step;                       // gravity on the outer wood
      d.lerp(mean, 0.17).normalize();            // never wanders off entirely
      p.addScaledVector(d, step);
      dist += step;
    }
    const b = {
      pts, level,
      phase: rng.range(0, 1),
      dir: pts[pts.length - 1].p.clone().sub(pts[0].p).normalize(),
      rigid: !!o.rigid,
    };
    maxDist = Math.max(maxDist, dist);
    branches.push(b);
    if (keep) keep(b);
    return b;
  }

  /* ---- trunk: leaning, gnarled, taper 1.34 -> 0.50 ---------------- */
  const trunk = grow({
    start: V(0, -0.85, 0),
    dir: V(0.115, 1, -0.075),
    len: 7.62, r0: 1.34, r1: 0.50, level: 0, segs: 30,
    droop: 0, gnarl: 0.085, dist0: 0,
  });

  /* ---- buttress roots (ART_BIBLE §5 "visible root flare") -----------
   * Six lobes at DELIBERATELY unequal angular spacing (no two gaps within 0.06
   * rad of each other), each starting just above the terrain so it is actually
   * visible, and each diving far enough below it that its tapered end is always
   * underground — a root that surfaces again shows a tip and reads as a stick.
   * radius 0.47..0.74 = 35..55 % of the trunk's 1.34 base radius.            */
  const rootGaps = [0.72, 1.34, 0.86, 1.52, 0.98, 1.86];   // sums to 2*pi*1.0
  const gapNorm = (Math.PI * 2) / rootGaps.reduce((a, b) => a + b, 0);
  let rootAz = 0.42;
  for (let i = 0; i < rootGaps.length; i++) {
    rootAz += rootGaps[i] * gapNorm;
    const az = rootAz;
    const len = rng.range(1.15, 2.35);
    grow({
      start: V(Math.cos(az) * 0.50, groundY + rng.range(0.10, 0.40), Math.sin(az) * 0.50),
      // steep enough that the end sits >= 0.45 m under the surface over `len`
      dir: V(Math.cos(az), -(0.34 + 0.55 / len), Math.sin(az)),
      len, r0: 1.34 * rng.range(0.35, 0.55), r1: 0.10,
      level: -1, segs: 8, droop: 0.16, gnarl: 0.16, dist0: 0, rigid: true,
    });
  }

  /* ---- helper: pick a point + outward frame on a parent branch ----- */
  function attach(parent, t) {
    const pts = parent.pts;
    const f = THREE.MathUtils.clamp(t, 0, 0.999) * (pts.length - 1);
    const i = Math.floor(f), fr = f - i;
    const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
    return {
      p: a.p.clone().lerp(b.p, fr),
      r: THREE.MathUtils.lerp(a.r, b.r, fr),
      dist: THREE.MathUtils.lerp(a.dist, b.dist, fr),
      tan: b.p.clone().sub(a.p).normalize(),
    };
  }

  /** Minimum tip radius per level (metres). Index by branch level. */
  // Measured r8: at 0.042 a level-2 secondary is an 8 cm bar that, once the tip
  // taper gave it a point, read as a bright straw SPIKE inside the crown (17 k
  // warm pixels in the crown bbox). The taper plus the sub-pixel aerial dissolve
  // in TRUNK_FRAG now cover the thin-line case that MIN_R was inflated to avoid,
  // so these come back down toward real sakura twig gauges.
  const MIN_R = { 1: 0.062, 2: 0.030, 3: 0.019, 4: 0.0125, 5: 0.0085 };

  const LEVELS = [
    // level 1 — primary limbs
    { kids: 3, lenF: [0.62, 0.80], tilt: [0.60, 0.98], droop: 0.028, gnarl: 0.135, segs: 14, rF: [0.56, 0.70] },
    // level 2 — secondaries
    { kids: 3, lenF: [0.66, 0.88], tilt: [0.48, 0.86], droop: 0.055, gnarl: 0.175, segs: 11, rF: [0.52, 0.68] },
    // level 3 — tertiaries
    { kids: 4, lenF: [0.46, 0.66], tilt: [0.42, 0.82], droop: 0.145, gnarl: 0.215, segs: 8, rF: [0.48, 0.66] },
    // level 4 — drooping twigs (sakura hangs)
    { kids: 4, lenF: [0.28, 0.50], tilt: [0.34, 1.05], droop: 0.520, gnarl: 0.46, segs: 6, rF: [0.36, 0.54] },
    /* level 5 — the TIP SPRAY. ART_BIBLE §5: "every silhouette edge should have
     * something breaking it up." The reference frame (shots/pause-check) had
     * fine tapering twigs breaking the crown outline and the round-2 build had
     * lost them, so the outline read smoother and more synthetic than the
     * reference. 3-5 twigs per parent tip, diverging 15-35 deg (0.26-0.61 rad)
     * at 20-30 % of the parent's length, exactly as prescribed. They also hide
     * the parent's own tapered end, which is what read as a chisel cut.      */
    { kids: 3, lenF: [0.20, 0.30], tilt: [0.26, 0.61], droop: 0.74, gnarl: 0.58, segs: 4, rF: [0.30, 0.50] },
  ];
  const MAX_LEVEL = 5;

  const AXIS = new THREE.Vector3();
  const OUT = new THREE.Vector3();

  function spawnChildren(parent, level, parentLen) {
    const L = LEVELS[level - 1];
    if (!L) return;
    const kids = L.kids + (rng.next() < 0.42 ? 1 : 0) + (level === 5 ? 1 : 0);
    // stagger attachment heights so nothing reads as a Y-fork repeat. Level 5 is
    // a TIP spray, so its twigs cluster in the outer third of the parent.
    for (let k = 0; k < kids; k++) {
      const t = level === 5
        ? 0.62 + (k / Math.max(1, kids)) * 0.36 + rng.range(-0.05, 0.04)
        : 0.26 + (k / Math.max(1, kids)) * 0.64 + rng.range(-0.08, 0.09);
      const at = attach(parent, t);
      // outward = away from the trunk axis, so the crown opens up
      OUT.set(at.p.x, 0, at.p.z);
      if (OUT.lengthSq() < 1e-4) OUT.set(Math.cos(k * 2.4), 0, Math.sin(k * 2.4));
      OUT.normalize();
      const az = rng.range(0, Math.PI * 2);
      AXIS.set(Math.cos(az), rng.range(-0.25, 0.25), Math.sin(az)).normalize();
      const tilt = rng.range(L.tilt[0], L.tilt[1]);
      const d = at.tan.clone().applyAxisAngle(AXIS, tilt);
      // bias out and up, so limbs reach for the sky instead of collapsing inward.
      // A level-5 tip twig keeps its parent's heading (the prescribed 15-35 deg
      // divergence IS the whole shape), so it barely gets the outward bias.
      d.addScaledVector(OUT, level === 5 ? rng.range(0.04, 0.14) : rng.range(0.30, 0.62));
      d.y += rng.range(0.18, 0.56) * (level <= 2 ? 1 : (level === 5 ? 0.16 : 0.62));
      d.normalize();
      const len = parentLen * rng.range(L.lenF[0], L.lenF[1]);
      // MIN_R: a twig thinner than ~26 mm rasterises as a 1-px dashed line of
      // near-black bark and reads as dirt on the lens at the hero distance.
      // Real sakura twigs are 4-8 mm, but they are also 25 m away here; the
      // honest fix is width, not a thinner line.
      const r0 = Math.max(MIN_R[level] * 1.35, at.r * rng.range(L.rF[0], L.rF[1]));
      const child = grow({
        start: at.p, dir: d, len, r0,
        r1: Math.max(MIN_R[level], r0 * rng.range(0.30, 0.46) * (level >= 4 ? 0.62 : 1)),
        level, segs: L.segs, droop: L.droop, gnarl: L.gnarl, dist0: at.dist,
      });
      child.junction = true;
      if (level < MAX_LEVEL) spawnChildren(child, level + 1, len);
    }
  }

  /* ---- 5 primary limbs off the upper trunk ------------------------- */
  const primT = [0.485, 0.585, 0.685, 0.795, 0.905];
  let az = rng.range(0, Math.PI * 2);
  for (let i = 0; i < primT.length; i++) {
    az += 2.39996 + rng.range(-0.55, 0.55);          // golden angle + jitter
    const at = attach(trunk, primT[i]);
    const tilt = THREE.MathUtils.lerp(1.10, 0.55, i / (primT.length - 1)) + rng.range(-0.12, 0.12);
    const d = V(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt)).normalize();
    const len = rng.range(4.5, 5.5);
    const r0 = at.r * rng.range(0.60, 0.76);
    const limb = grow({
      start: at.p, dir: d, len, r0, r1: r0 * rng.range(0.30, 0.42),
      level: 1, segs: 15, droop: 0.022, gnarl: 0.12, dist0: at.dist,
    });
    spawnChildren(limb, 2, len);
  }
  // the trunk's own leader keeps going too — asymmetric, not a clean fork
  {
    const at = attach(trunk, 0.985);
    const leadLen = 2.9;
    const lead = grow({
      start: at.p, dir: V(0.16, 1, -0.10), len: leadLen, r0: at.r * 0.82, r1: at.r * 0.26,
      level: 1, segs: 10, droop: 0.02, gnarl: 0.14, dist0: at.dist,
    });
    spawnChildren(lead, 2, leadLen);
  }

  return { branches, maxDist, rng };
}

/* ================================================================== *
 * 2. Tube geometry
 * ================================================================== */

const SIDES = { '-1': 8, 0: 24, 1: 14, 2: 10, 3: 8, 4: 6, 5: 5 };

function buildWoodGeometry(skel, detail, groundY = 0) {
  const pos = [], nor = [], uvs = [], tan = [], sti = [], pha = [], cav = [], rad = [];
  const idx = [];
  const flareRng = makeRng(SEED ^ 0x5b1);
  // root buttresses: a handful of angular lobes on the flare, at unequal spacing
  const lobes = [];
  {
    let th = 0.9;
    const gaps = [0.78, 1.42, 0.92, 1.66, 1.04, 1.24, 1.94];
    const gn = (Math.PI * 2) / gaps.reduce((a, b) => a + b, 0);
    for (let i = 0; i < gaps.length; i++) {
      th += gaps[i] * gn;
      lobes.push({ th, amp: flareRng.range(0.22, 0.56) });
    }
  }
  /* Flare geometry, measured from the TERRAIN not from the trunk's own origin.
   * ART_BIBLE §5 wants a visible flare; the prescription wants the contact
   * radius at 1.55-1.75x the breast-height radius over a pow(...,2.2) curve.
   * The natural taper already supplies 1.18x of that between y = groundY + 1.4
   * and the contact, so FLARE_K = 0.40 lands the total at ~1.65x. */
  const FLARE_H = 1.80;
  const FLARE_K = 0.40;

  const N0 = new THREE.Vector3(), B0 = new THREE.Vector3(), T0 = new THREE.Vector3();
  const prevT = new THREE.Vector3(), rotAxis = new THREE.Vector3();
  const p = new THREE.Vector3(), dir = new THREE.Vector3();

  for (const br of skel.branches) {
    // A twig has to stay a ROUND tube at every tier. Dropping it to 4 sides
    // (what detail 0.62 used to do) turns it into a flat ribbon that renders
    // edge-on as a hard tan sliver — an LOD tier that changes the ART, not the
    // fidelity. Sides floor at 5 for anything level >= 3 and the ring stride is
    // gone: the outer wood is a rounding error in the triangle budget.
    const sides = Math.max(br.level >= 3 ? 5 : 6, Math.round(SIDES[br.level] * detail));
    const pts = br.pts;
    const stride = 1;
    const ring = [];
    for (let i = 0; i < pts.length; i += stride) ring.push(pts[i]);
    if (ring[ring.length - 1] !== pts[pts.length - 1]) ring.push(pts[pts.length - 1]);
    if (ring.length < 2) continue;

    /* ---- pointed tip -------------------------------------------------
     * A tube that simply STOPS shows the far wall of its own interior as a
     * flat pale ellipse: every free branch end read as a sawn log, which was
     * the loudest "unfinished asset" tell in the crown. Two extrapolated rings
     * plus an apex fan turn each end into a point — what real wood does — for
     * 2*(sides+1)+1 vertices per branch. MIN_R can stay where it is (it is
     * what keeps mid twigs off the sub-pixel sliver regime); only the last
     * ~2 radii of length taper away.                                         */
    let capped = false;
    {
      const a = ring[ring.length - 1], b = ring[ring.length - 2];
      const ed = a.p.clone().sub(b.p);
      if (ed.lengthSq() > 1e-12) {
        ed.normalize();
        const r0e = a.r;
        /* MEASURED r2: a straight 4-radius cone plus a 1.3-radius apex is a
         * 5.3-radius SPEAR, and on the thick level-1/2 wood that is an 80 cm
         * pale spike sticking out of the crown — the "angular flat polygon"
         * ends the critic named. A rounded ogive r = r0*sqrt(1-(s/S)^2) over
         * S radii reads as wood that ran out instead: no straight edge, no flat
         * facet, and the tangent goes vertical at the tip so the apex fan is
         * hidden. Thick wood gets a short blunt stub (real limbs end in a stub
         * or a break), fine wood a longer needle.
         *
         * The end is also bent, by a fixed fraction of the last segment's own
         * curvature, so no tip silhouette is a straight line.                */
        const S = br.level <= 2 ? 2.05 : 3.30;
        const bend = new THREE.Vector3(
          flareRng.range(-0.16, 0.16), flareRng.range(-0.20, 0.06), flareRng.range(-0.16, 0.16));
        for (let ti = 1; ti <= 4; ti++) {
          const s = S * (ti / 4.15);
          ring.push({
            p: a.p.clone().addScaledVector(ed, r0e * s)
              .addScaledVector(bend, r0e * s * (ti / 4)),
            r: r0e * Math.sqrt(Math.max(0.0025, 1 - (s / S) ** 2)),
            dist: a.dist + r0e * s,
          });
        }
        capped = true;
      }
    }

    // ---- parallel-transport frame -----------------------------------
    T0.copy(ring[1].p).sub(ring[0].p).normalize();
    N0.set(0, 1, 0);
    if (Math.abs(N0.dot(T0)) > 0.92) N0.set(1, 0, 0);
    N0.crossVectors(T0, N0).normalize();
    B0.crossVectors(T0, N0).normalize();
    prevT.copy(T0);

    const rMid = ring[Math.floor(ring.length / 2)].r;
    /* Per-branch UV randomisation. Every branch used to sample the SAME stretch
     * of the bark map at the same u phase, so the whole tree read as a bundle of
     * identically striped planks. An integer u repeat is still required (the map
     * has to wrap round the tube), but the PHASE and the v origin are free, and
     * the u repeat itself can be nudged one tile either way. */
    const uRepeat = Math.max(1, Math.round(2 * Math.PI * rMid * 0.45 * flareRng.range(0.80, 1.35)));
    const uPhase = flareRng.next();
    const vPhase = flareRng.range(0, 12);
    const start = pos.length / 3;

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[Math.min(ring.length - 1, i + 1)];
      const c = ring[Math.max(0, i - 1)];
      T0.copy(b.p).sub(c.p);
      if (T0.lengthSq() < 1e-10) T0.copy(prevT); else T0.normalize();
      // rotate the frame minimally from the previous tangent (no twist)
      rotAxis.crossVectors(prevT, T0);
      const s = rotAxis.length();
      if (s > 1e-6) {
        rotAxis.divideScalar(s);
        const ang = Math.atan2(s, prevT.dot(T0));
        N0.applyAxisAngle(rotAxis, ang).normalize();
      }
      B0.crossVectors(T0, N0).normalize();
      N0.crossVectors(B0, T0).normalize();
      prevT.copy(T0);

      const t = i / (ring.length - 1);
      const stiff = br.rigid ? 0 : THREE.MathUtils.clamp(a.dist / skel.maxDist, 0, 1);
      // junction AO: the first slice of a child branch sits in its own crotch
      const jc = br.junction ? THREE.MathUtils.smoothstep(t, 0.0, 0.16) * 0.55 + 0.45 : 1.0;

      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        dir.copy(N0).multiplyScalar(Math.cos(ang)).addScaledVector(B0, Math.sin(ang));
        let r = a.r;
        if (br.level === 0) {
          // pow(1 - h/1.8, 2.2), h measured from the TERRAIN surface
          const hAbove = (a.p.y - groundY) / FLARE_H;
          const fall = Math.pow(1 - THREE.MathUtils.clamp(hAbove, 0, 1), 2.2);
          const az = Math.atan2(dir.z, dir.x);
          let f = 1 + FLARE_K * fall;
          for (const lo of lobes) {
            const cd = Math.cos(az - lo.th);
            if (cd > 0) f += lo.amp * Math.pow(cd, 4.0) * fall;
          }
          r *= f;
        }
        /* Silhouette perturbation. The trunk's left and right edges were both
         * perfectly straight lines (measured over 680 px in the bark preset),
         * which is the single loudest "lathe-turned primitive" tell. +-7 % of
         * low-frequency noise around the circumference AND along the height
         * gives roughly one direction change per 1.5 m of height, i.e. 4-5 over
         * the visible trunk, on both edges independently. Level 1 gets half of
         * it so the big limbs are not straight tubes either. */
        if (br.level <= 1) {
          const wob = noise3(dir.x * 1.35 + 7.1, a.p.y * 0.62, dir.z * 1.35)
            * 0.62
            + noise3(dir.x * 3.1, a.p.y * 1.55 + 3.3, dir.z * 3.1) * 0.38;
          r *= 1 + wob * (br.level === 0 ? 0.07 : 0.035);
        }
        p.copy(a.p).addScaledVector(dir, r);
        pos.push(p.x, p.y, p.z);
        nor.push(dir.x, dir.y, dir.z);
        // circumferential tangent (needed for the tangent-space bark normal map)
        tan.push(-N0.x * Math.sin(ang) + B0.x * Math.cos(ang),
          -N0.y * Math.sin(ang) + B0.y * Math.cos(ang),
          -N0.z * Math.sin(ang) + B0.z * Math.cos(ang));
        uvs.push((k / sides) * uRepeat + uPhase, a.dist * 0.42 + vPhase);
        sti.push(stiff);
        pha.push(br.phase);
        cav.push(jc);
        rad.push(a.r);              // true wood radius: drives the thin-twig shading
      }
    }

    const cols = sides + 1;

    // apex vertex closing the tapered tip (see `capped` above)
    let apex = -1;
    if (capped) {
      const a = ring[ring.length - 1], b = ring[ring.length - 2];
      T0.copy(a.p).sub(b.p);
      if (T0.lengthSq() < 1e-12) T0.set(0, 1, 0); else T0.normalize();
      p.copy(a.p).addScaledVector(T0, a.r * 1.30);
      apex = pos.length / 3;
      pos.push(p.x, p.y, p.z);
      nor.push(T0.x, T0.y, T0.z);
      tan.push(N0.x, N0.y, N0.z);
      uvs.push(0.5 * uRepeat + uPhase, a.dist * 0.42 + vPhase);
      sti.push(br.rigid ? 0 : THREE.MathUtils.clamp(a.dist / skel.maxDist, 0, 1));
      pha.push(br.phase);
      cav.push(1.0);
      rad.push(a.r * 0.4);
    }

    for (let i = 0; i < ring.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = start + i * cols + k;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (apex >= 0) {
      const lastRow = start + (ring.length - 1) * cols;
      for (let k = 0; k < sides; k++) idx.push(lastRow + k, apex, lastRow + k + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aTangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aStiff', new THREE.Float32BufferAttribute(sti, 1));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(pha, 1));
  g.setAttribute('aCav', new THREE.Float32BufferAttribute(cav, 1));
  g.setAttribute('aRad', new THREE.Float32BufferAttribute(rad, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.08;      // wind sway headroom
  g.computeBoundingBox();
  return g;
}

/* ================================================================== *
 * 3. Blossom card geometry (a gently domed quad, not a flat plane)
 * ================================================================== */

function buildCardGeometry(res = 3) {
  const pos = [], nor = [], uvs = [], idx = [];
  const H = 0.5, BULGE = 0.185;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const u = i / res, v = j / res;
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;             // -1..1
      const z = BULGE * (1 - x * x) * (1 - y * y);
      pos.push(x * H, y * H, z);
      // analytic normal of z(x,y)
      const dzx = BULGE * (-2 * x) * (1 - y * y) / H;
      const dzy = BULGE * (1 - x * x) * (-2 * y) / H;
      const n = new THREE.Vector3(-dzx, -dzy, 1).normalize();
      nor.push(n.x, n.y, n.z);
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * (res + 1) + i, b = a + 1, c = a + res + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/* ================================================================== *
 * Module
 * ================================================================== */

export default {
  name: 'tree',
  order: 30,
  async setup(ctx) {
    const group = new THREE.Group();
    group.name = 'sakura-tree';
    group.rotation.y = 2.55;
    const L = ctx.assets.lightUniforms ?? createLightUniforms();
    const W = WIND.uniforms;
    const q = ctx.quality ?? {};
    const tier = q.tier ?? 'high';

    // Tier = fewer INSTANCES, never a coarser silhouette. The wood is ~4 % of
    // the frame's triangles, so its detail barely moves between tiers.
    const DETAIL = { ultra: 1.0, high: 1.0, medium: 0.92, low: 0.84 }[tier] ?? 0.90;
    const CARDS = { ultra: 4300, high: 3100, medium: 2200, low: 1600 }[tier] ?? 2600;
    const BARK_SIZE = { ultra: 1024, high: 768, medium: 512, low: 384 }[tier] ?? 768;
    const ATLAS_SIZE = { ultra: 2048, high: 2048, medium: 1024, low: 1024 }[tier] ?? 2048;
    const CARD_RES = tier === 'low' || tier === 'medium' ? 2 : 3;
    // A lower tier is the SAME TREE with fewer, bigger blossom clusters — never
    // a bare skeleton. Card area scales as 1/count so canopy COVERAGE is a
    // tier-invariant, which is what the eye actually reads.
    // Total card AREA (count * scale^2) is the tier invariant, because coverage
    // is what the eye reads. 4300*0.849^2 = 3100 = 1600*1.392^2.
    const CARD_SCALE = THREE.MathUtils.clamp(Math.sqrt(3100 / CARDS), 0.84, 1.55);

    /* ---- textures ------------------------------------------------- */
    const bark = buildBarkTextures({ size: BARK_SIZE, seed: SEED });
    const atlas = buildBlossomAtlas({ size: ATLAS_SIZE, seed: SEED ^ 0x9e11 });
    const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    for (const t of [bark.albedo, bark.normal, atlas]) t.anisotropy = Math.min(8, maxAniso);
    ctx.assets.textures.treeBark = bark.albedo;
    ctx.assets.textures.treeBarkNormal = bark.normal;
    ctx.assets.textures.sakuraBlossom = atlas;

    /* ---- skeleton + wood ------------------------------------------ *
     * The ground is NOT at y = 0 (20-terrain's knoll summit is ~1.27), and the
     * tree group carries a yaw only, so local y === world y. Every root, the
     * flare curve and the soil blend are measured from this number. */
    const GROUND_Y = ctx.assets.terrain?.heightAt?.(0, 0) ?? 0;
    const skel = buildSkeleton(GROUND_Y);
    const woodGeo = buildWoodGeometry(skel, DETAIL, GROUND_Y);

    const col = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    const trunkUniforms = {
      uBark: { value: bark.albedo },
      uBarkN: { value: bark.normal },
      uMossCol: { value: col(0x5C7A3E) },
      uGoldCol: { value: col(0xE8C56A) },
      uWetCol: { value: col(0x4A3B33) },
      uMossAmt: { value: STAGE.moss[3] },
      uGold: { value: 0 },
      uBare: { value: 0 },
      uDetailScale: { value: 4.3 },
      uMossDir: { value: new THREE.Vector3(-0.32, 0.14, -1.0).normalize() },
      uWindAmp: { value: 0.92 },
      // Young sakura twig wood: warm red-grey. MEASURED: at #7E5F52 (display
      // L 0.404) plus the twig's own rim/translucency/shadow-lift boosts the
      // rendered twigs came out at L 0.736 — brighter than the blossoms. Wood is
      // the darkest mass in a sakura crown; #5E463C (L 0.293) plus the trimmed
      // boosts lands the rendered twig at <= 0.40.
      uTwigCol: { value: col(0x5E463C) },
      // ART_BIBLE §5 root flare: the earth the buttresses dissolve into.
      uSoilCol: { value: col(0x4E3D2E) },
      // filled in below from ctx.assets.terrain (the ground is NOT at y = 0).
      uGroundY: { value: 0 },
      // pixels per world unit at 1 m — lets the fragment shader know when a twig
      // has collapsed to a 1-px line and must dissolve into the haze instead of
      // rasterising as a hard near-black dash.
      uPxScale: { value: 1600 },
      // A twig inside the crown is surrounded on all sides by backlit blossom,
      // and blossom bounce is by far the strongest light reaching it — far more
      // than the sky. Without this the outer wood renders as hard dark dashes
      // against L 0.89 petals: "dirt on the lens". Filled in below once the
      // crown bounds are known (shared BY REFERENCE with the canopy material).
      uCanopyCentre: { value: new THREE.Vector3(0, 8, 0) },
      uCanopyR: { value: 8 },
      uBlossomCol: { value: col(0xE9A8BE) },
      // Measured r2: at 0.95 the twigs came back as CREAM slivers — 59 k warm
      // pale pixels inside the crown bbox against 8 k before, i.e. the dark
      // "dirt on the lens" dashes were traded for straw. 0.34 puts outer wood at
      // roughly 0.7 of the surrounding petal luminance, which is where a twig
      // inside a backlit crown belongs: present, soft, never a hard edge.
      uBlossomAmt: { value: 0.11 },
      uCoverage: { value: 1 },
      /* Linear-luma floor on bark. MEASURED r1: the wood inside the trunk fork
       * printed rgb(18,23,59), display L 0.09, hue 233 — a navy void (ART_BIBLE §8
       * tell 4). Root cause and the paired NPR_SHADOW_TINT fix are documented at
       * the floor itself in TRUNK_FRAG. */
      // MEASURED: 0.026 linear still printed at display L 0.08 once the post grade's
      // shadow S-curve had been through it. 0.058 lands the deepest crotch shadow
      // at ~0.22 — the darkest mass in a sunlit frame, not a hole in it.
      uWoodFloor: { value: 0.058 },
    };
    trunkUniforms.uGroundY.value = GROUND_Y;

    // A ShaderMaterial with lights:true MUST carry the whole UniformsLib.lights
    // block — the renderer writes its own light state into those objects and
    // markUniformsLightsNeedsUpdate() throws if any of them is missing. The
    // shared bags (L, W) go in AFTER the merge so nothing clones them.
    const lightsBlock = () => THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);

    const trunkMat = new THREE.ShaderMaterial({
      uniforms: { ...lightsBlock(), ...L, ...W, ...trunkUniforms },
      vertexShader: TRUNK_VERT,
      fragmentShader: TRUNK_FRAG,
      lights: true,
      // DoubleSide, deliberately: an outer twig is a 4-6 sided tube barely one
      // pixel across, and with backface culling the rasteriser drops half its
      // fragments, so the branch arrives as a broken dashed line. Drawing the
      // far wall too (and flipping N for it) makes twigs continuous. The trunk
      // is a small part of the frame so the extra fill is free.
      side: THREE.DoubleSide,
    });
    trunkMat.userData.noNpr = true;

    const trunkDepthMat = new THREE.ShaderMaterial({
      uniforms: { ...W, uWindAmp: trunkUniforms.uWindAmp },
      vertexShader: TRUNK_DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
    });

    const trunkMesh = new THREE.Mesh(woodGeo, trunkMat);
    trunkMesh.name = 'sakura-trunk';
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    trunkMesh.customDepthMaterial = trunkDepthMat;
    group.add(trunkMesh);

    /* ---- canopy anchors ------------------------------------------- */
    const rng = makeRng(SEED ^ 0x2f10c);
    const anchors = { outer: [], mid: [], spur: [], inner: [] };
    const tips = [];
    /* ---- anchors: four buckets, by the KIND of wood the blossom sits on -----
     * MEASURED r1 of this round (shots/tree-r1/hero.png, wide.png): the crown was
     * a HALF tree. A dense saturated column of blossom hung around the trunk axis
     * while the three thick right-hand primaries ran 3-4 m of naked grey wood
     * through the middle of a flowering crown — "bare grey limbs read as dead
     * wood", blocker 2, still present.
     *
     * ROOT CAUSE, and it was one line: level 1-2 anchors went into the `inner`
     * layer, and that layer carries `lerpIn: [0.08, 0.64]` — every card assigned
     * to a primary limb was then LERPED UP TO 64 % OF THE WAY TO THE CROWN CENTRE.
     * So the 688 cards that were supposed to flower the old wood were physically
     * dragged off it into one ball in the middle. Both defects, one cause.
     *
     * So old wood gets its own bucket (`spur`) whose cards HUG the limb — offset
     * by the local wood radius plus a few centimetres, rotated freely about the
     * limb axis so spurs ring it instead of all sprouting one way — and the
     * interior-volume fill (`inner`) draws from the outer/mid anchors instead,
     * which is where a real crown's interior mass actually comes from. Ancient
     * sakura genuinely flower on spurs along old wood, so this is also the
     * botanically correct answer. */
    for (const br of skel.branches) {
      if (br.level < 1) continue;
      const pts = br.pts;
      const last = pts[pts.length - 1];
      if (br.level >= 3) tips.push(last.p.clone());
      const bucket = br.level >= 4 ? anchors.outer : (br.level === 3 ? anchors.mid : anchors.spur);
      // a primary limb is 4.5-5.5 m long, so it needs many more spur sites than a
      // 30 cm twig does, spread from just past the trunk out to the tip. 7 -> 11
      // on level 1 puts a site every ~45 cm of limb, which is what it takes for
      // the limb to read as flowering rather than as decorated at intervals.
      const from = br.level >= 4 ? 0.10 : (br.level === 1 ? 0.14 : 0.28);
      const n = br.level >= 4 ? 5 : (br.level === 3 ? 4 : (br.level === 1 ? 13 : 4));
      for (let i = 0; i < n; i++) {
        const t = from + (1 - from) * ((i + 0.5) / n);
        const f = t * (pts.length - 1);
        const j = Math.min(pts.length - 2, Math.floor(f));
        const fr = f - j;
        const tan = pts[j + 1].p.clone().sub(pts[j].p);
        if (tan.lengthSq() < 1e-10) tan.copy(br.dir); else tan.normalize();
        bucket.push({
          p: pts[j].p.clone().lerp(pts[j + 1].p, fr),
          d: br.dir,
          // LOCAL tangent + wood radius: a spur cluster has to sit just off the
          // bark of the segment it grows from, whatever the branch does elsewhere.
          tan,
          r: THREE.MathUtils.lerp(pts[j].r, pts[j + 1].r, fr),
          stiff: THREE.MathUtils.clamp(THREE.MathUtils.lerp(pts[j].dist, pts[j + 1].dist, fr) / skel.maxDist, 0, 1),
          phase: br.phase,
          // Low-discrepancy growth rank, assigned per bucket index. Anchors of one
          // branch are pushed consecutively, so the golden-ratio sequence spreads
          // their growth orders right across the range and every branch is
          // guaranteed an early-opening site. See the `order` block below.
          seq: 0,
          lvl: br.level,
        });
      }
    }
    const PHI = 0.61803398875;
    for (const key of ['outer', 'mid', 'spur', 'inner']) {
      const arr = anchors[key];
      for (let i = 0; i < arr.length; i++) arr[i].seq = (i * PHI) % 1;
    }

    /* crown bounds from the anchor cloud (the crown IS the branch cloud) */
    const cCentre = new THREE.Vector3();
    const all = [...anchors.outer, ...anchors.mid, ...anchors.spur];
    for (const a of all) cCentre.add(a.p);
    cCentre.divideScalar(Math.max(1, all.length));
    let cRadius = 1;
    for (const a of all) cRadius = Math.max(cRadius, a.p.distanceTo(cCentre));
    // Hand the crown volume to both shaders. BUG FIX: this has to be the WORLD
    // centre. cCentre is in the tree's LOCAL space and the group carries a 2.55
    // rad yaw, so the canopy shader has been comparing a world vWorldPos against
    // a local centre — a 3.7 m xz error on an 8.7 m radius, which skewed every
    // vShell / vCrownT reading (and therefore the whole interior) to one side.
    group.updateMatrix();
    const cCentreW0 = cCentre.clone().applyMatrix4(group.matrix);
    trunkUniforms.uCanopyCentre.value.copy(cCentreW0);
    trunkUniforms.uCanopyR.value = cRadius;

    /* ---- instances ------------------------------------------------ */
    const cardGeo = buildCardGeometry(CARD_RES);
    // the vertex shader scales cards by aInst2.z, so the geometry bound has to
    // cover the largest instance or the crown pops out of frustum at the edges
    cardGeo.computeBoundingSphere();
    cardGeo.boundingSphere.radius *= 2.2;
    /* Floating islands of blossom (常桜 Everblossom): extra cards in the SAME
     * InstancedMesh — one more draw call for a stage-5 hero feature is not worth
     * it, and they need the identical atlas, wind and shading path. They live at
     * the end of the buffer and are flagged with aIsle. */
    const ISLE_CLUSTERS = { ultra: 8, high: 7, medium: 5, low: 4 }[tier] ?? 6;
    const ISLE_PER = { ultra: 30, high: 26, medium: 20, low: 15 }[tier] ?? 22;
    const ISLES = ISLE_CLUSTERS * ISLE_PER;
    const COUNT = CARDS + ISLES;
    const inst = new THREE.InstancedMesh(cardGeo, null, COUNT);
    const aInst = new Float32Array(COUNT * 4);
    const aInst2 = new Float32Array(COUNT * 4);
    const aTint = new Float32Array(COUNT * 3);
    const aIsle = new Float32Array(COUNT);

    // ART_BIBLE §3 — all FIVE sakura values, edge to deep interior. A canopy
    // painted from two of them reads as one pale mass; the mid and deep values
    // are what give the crown a readable inside.
    const TINTS = [col(0xFFF2F6), col(0xFFD9E6), col(0xFFB6CE), col(0xEE8CAF), col(0xC25F86)];

    /* ---- the tint is a RATIO, not a multiplier ------------------------ *
     * THE bug behind the dead maroon patches. The atlas is already painted from
     * these five values, so multiplying an authored #C25F86 petal core by an
     * instance tint of #C25F86 SQUARES the pink: linear (0.541,0.115,0.238)^2 =
     * (0.293,0.013,0.057), luminance 0.076 — a fifth of the palette's own deep
     * value, and after the interior occlusion terms it measured L 0.01-0.047 in
     * the graded frame (blocker 1).
     *
     * So the shader takes VALUE from the atlas and CHROMA from here (see the
     * albedo block in CANOPY_FRAG): the tint below IS the card's colour, and the
     * texture only supplies a scalar value ratio about TINT_REF plus a minority
     * share of its own chroma. TINT_VALSPREAD compresses the palette's value
     * spread so the deepest tint lands ON #C25F86 rather than two stops under it:
     * compressed lumas 0.875 / 0.786 / 0.660 / 0.544 / 0.432 against a 0.786 ref.
     */
    const TINT_REF = col(0xFFD9E6);
    const TINT_VALSPREAD = 0.62;
    const lin = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const REF_L = lin(TINT_REF);
    /** the palette hue at its compressed value — the card's colour outright. */
    const TINT_RATIO = TINTS.map((c) => {
      const l = Math.max(1e-5, lin(c));
      const target = REF_L + TINT_VALSPREAD * (l - REF_L);
      const k = target / l;
      return new THREE.Vector3(c.r * k, c.g * k, c.b * k);
    });
    /** cumulative pick weights per layer, outer -> inner */
    // MEASURED: with the outer layer weighted 13/32/34/16/5 across those five
    // values, 79 % of the shell was painted from the top three (lightest) ones —
    // which is the arithmetic behind "the canopy reads as a uniformly pale pink
    // mass". Re-weighted so the mid and shadow values carry the shell and the
    // light values are the accents they are meant to be.
    // MEASURED r4: with 12 % of the OUTER shell drawing #C25F86 (the palette's
    // deep INTERIOR value), a dozen shell clusters per frame sat as dark plum
    // islands directly against the sky — a value that only makes sense with a
    // metre of blossom in front of it. The deep value is now reserved for the
    // layers that are actually inside the mass; the shell's spread runs
    // #FFF2F6 -> #EE8CAF, which is still 0.94 -> 0.40 in display L.
    /* MEASURED r2: `mid` still drew 14 % of its cards from #C25F86 and `inner`
     * 48 %, and because the mid layer sits only 0.20-0.22 inside the shell those
     * cards were VISIBLE from outside as large saturated dark-magenta patches —
     * they read as bruises or mould, not as shadowed blossom (blocker 2b). The
     * prescription is explicit: #EE8CAF is the shadow value and #C25F86 is
     * reserved for the innermost ~10 % of cluster depth. So the deep value is
     * gone from outer and mid entirely and is a minority even in `inner`; the
     * interior's darkness now comes from the shader's occlusion ladder (which is
     * gated on real crown depth) rather than from a painted-on albedo. */
    const TINT_CDF = {
      outer: [0.09, 0.32, 0.72, 1.00, 1.00],
      mid: [0.03, 0.18, 0.56, 1.00, 1.00],
      // A spur cluster on old wood sits in the middle of the crown's depth: it
      // sees sky through the gaps but has blossom above and outside it. Mid/shadow
      // values with a little of the light one, and none of the deep — the deep
      // value belongs to the shader's occlusion ladder, not to painted albedo.
      spur: [0.02, 0.16, 0.62, 1.00, 1.00],
      inner: [0.00, 0.05, 0.26, 0.86, 1.00],
    };
    // a small per-cluster temperature swing: real blossom varies warm (young,
    // yellow-pink) to cool (older, blue-pink) across one tree.
    const WARM = new THREE.Vector3(1.035, 0.982, 0.955);
    const COOL = new THREE.Vector3(0.962, 0.986, 1.048);
    const TC = new THREE.Color();

    const mat4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion(), qRoll = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const ZP = new THREE.Vector3(0, 0, 1);
    const nrm = new THREE.Vector3(), out = new THREE.Vector3(), jit = new THREE.Vector3();
    const pp = new THREE.Vector3();
    // spur frame: the limb's own tangent and two perpendiculars (see `hug` below)
    const tng = new THREE.Vector3(), bin = new THREE.Vector3();

    const LAYERS = [
      { key: 'outer', frac: 0.48, push: [0.06, 0.50], ao: [0.88, 1.00], size: [0.74, 1.46], jitter: 0.60, lerpIn: [0.00, 0.06] },
      { key: 'mid', frac: 0.21, push: [-0.20, 0.22], ao: [0.58, 0.84], size: [0.78, 1.34], jitter: 0.70, lerpIn: [0.06, 0.22] },
      /* SPUR — blossom growing straight off the old wood. `hug` switches the
       * placement frame from "radially out of the crown" to "radially off THIS
       * limb", which is the whole point: the offset is the local wood radius plus
       * 8-40 cm, the azimuth about the limb is free, and lerpIn is ZERO so nothing
       * drags the cluster off the branch it belongs to. AO stays fairly open —
       * a spur has sky above it through the gaps in the crown. */
      { key: 'spur', frac: 0.19, push: [0.08, 0.40], ao: [0.60, 0.90], size: [0.56, 1.08], jitter: 0.20, lerpIn: [0.00, 0.00], hug: true },
      // The crown must read as a VOLUME: interior cards are pulled toward the
      // crown centre rather than just pushed a little way down their own branch,
      // because the mid-height interior has almost no twigs to hang off.
      // ...but spread across the WHOLE radius range, not parked at one depth.
      // lerpIn 0.28-0.66 put every interior card in a shell around the crown
      // centre, which rendered as a single flat grey-mauve ball hanging in the
      // middle of the canopy. 0.08-0.64 fills the volume instead.
      // Source is the outer/mid anchor cloud (see the `all` fallback): the
      // interior of a real crown is filled by the twigs that pass through it, and
      // drawing it from level 1-2 anchors is what emptied the limbs in r1.
      { key: 'inner', frac: 0.12, push: [-0.30, 0.10], ao: [0.28, 0.58], size: [0.88, 1.48], jitter: 1.05, lerpIn: [0.08, 0.64] },
    ];

    /** largest stride < N that is coprime with N and near the golden fraction. */
    const coprimeStride = (N) => {
      const gcd = (x, y) => (y ? gcd(y, x % y) : x);
      if (N < 4) return 1;
      let s = Math.max(1, Math.round(N * 0.61803398875));
      for (let k = 0; k < N; k++) {
        const t = ((s + k) % N) || 1;
        if (gcd(t, N) === 1) return t;
      }
      return 1;
    };
    /* Where the growth front starts and ends. Solved against STAGE.coverage and
     * cardGrow()'s smoothstep(order-0.20, order+0.03, coverage) window so each
     * stage lands on a deliberate fraction of the crown:
     *   stage 0 (cov 0.125) ~5 % barely-swelling buds   stage 1 (0.330) ~15 % full
     *   stage 2 (0.590) ~50 %   stage 3 (1.000) all non-reserve. */
    const ORDER_LO = 0.22, ORDER_HI = 0.965;

    /* The interior-volume fill is drawn from the OUTER + MID anchor cloud, never
     * from the old-wood spur sites — see the `inner` entry in LAYERS. */
    const innerSrc = anchors.outer.concat(anchors.mid);

    let w = 0;
    for (let li = 0; li < LAYERS.length; li++) {
      const Ly = LAYERS[li];
      const src = Ly.key === 'inner'
        ? (innerSrc.length ? innerSrc : all)
        : (anchors[Ly.key].length ? anchors[Ly.key] : all);
      const n = li === LAYERS.length - 1 ? CARDS - w : Math.round(CARDS * Ly.frac);
      /* ---- STRATIFIED anchor assignment ---------------------------------
       * `src[floor(rng()*N)]`, repeated n times, is sampling WITH REPLACEMENT:
       * it leaves e^-(n/N) of the anchors with no card at all (37 % at n == N)
       * and hands others four. Combined with the old position-driven growth order
       * that is exactly how whole limbs ended up naked. Striding the list by a
       * value coprime with its length visits every anchor either floor(n/N) or
       * floor(n/N)+1 times — no gaps by construction — and because the stride is
       * ~0.618 N while the list is ordered by branch, consecutive cards land on
       * branches far apart in the crown. */
      const N = src.length;
      const stride = coprimeStride(N);
      const perAnchor = Math.max(1, Math.ceil(n / N));
      let ai = Math.floor(rng.next() * N) % N;
      for (let i = 0; i < n && w < CARDS; i++, w++) {
        const a = src[ai];
        const rank = Math.floor(i / N);        // this anchor's own card index
        ai = (ai + stride) % N;
        out.copy(a.p).sub(cCentre);
        const rLen = Math.max(0.001, out.length());
        out.divideScalar(rLen);
        if (Ly.hug) {
          /* ---- a spur cluster growing off the bark of THIS limb -------------
           * Frame: the limb's own tangent, plus two perpendiculars. The cluster
           * sits at (wood radius + 8..40 cm) from the axis at a free azimuth, so
           * spurs ring the limb the way real ones do instead of all sprouting on
           * the crown-outward side. Nothing here references the crown centre, so
           * nothing can drag the cluster off the limb (which is exactly what the
           * old `inner`-bucket routing did — see the anchor block above). */
          tng.copy(a.tan ?? a.d);
          if (tng.lengthSq() < 1e-8) tng.set(0, 1, 0); else tng.normalize();
          bin.copy(out).addScaledVector(tng, -out.dot(tng));
          if (bin.lengthSq() < 1e-6) {
            bin.set(-tng.y, tng.x, tng.z * 0.3);
            bin.addScaledVector(tng, -bin.dot(tng));
          }
          bin.normalize();
          nrm.crossVectors(tng, bin).normalize();      // second perpendicular
          const az = rng.range(0, Math.PI * 2);
          out.copy(bin).multiplyScalar(Math.cos(az)).addScaledVector(nrm, Math.sin(az));
          const off = (a.r ?? 0.10) + rng.range(Ly.push[0], Ly.push[1]);
          pp.copy(a.p).addScaledVector(out, off)
            // a little slide ALONG the limb so 11 sites do not read as 11 rings
            .addScaledVector(tng, rng.gauss(0, 0.16))
            .addScaledVector(jit.set(rng.gauss(0, 0.30), rng.gauss(0, 0.24), rng.gauss(0, 0.30)),
              Ly.jitter);
        } else {
          jit.set(rng.gauss(0, 0.42), rng.gauss(0, 0.34), rng.gauss(0, 0.42));
          pp.copy(a.p)
            .addScaledVector(out, rng.range(Ly.push[0], Ly.push[1]))
            .addScaledVector(jit, Ly.jitter);
          pp.lerp(cCentre, rng.range(Ly.lerpIn[0], Ly.lerpIn[1]));
        }

        // Strays live outside the shell so the silhouette is never a smooth
        // dome. ART_BIBLE §5: "every silhouette edge should have something
        // breaking it up." Only the outer/mid layers throw them — an interior
        // card flung outward would leave a hole in the middle of the crown, and
        // a spur flung outward is no longer a spur.
        const stray = (Ly.key === 'outer' || Ly.key === 'mid') && rng.next() < 0.135;
        if (stray) pp.addScaledVector(out, rng.range(0.55, 2.60))
          .addScaledVector(jit.set(rng.gauss(0, 0.55), rng.gauss(0, 0.75), rng.gauss(0, 0.55)), 1);

        // face outward, tilted by the host twig, plus a healthy random wobble
        nrm.copy(out).multiplyScalar(Ly.hug ? 0.86 : 0.68)
          .addScaledVector(a.d, rng.range(-0.34, 0.34))
          .add(jit.set(rng.gauss(0, 0.30), rng.gauss(0, 0.30), rng.gauss(0, 0.30)))
          .normalize();
        qt.setFromUnitVectors(ZP, nrm);
        qRoll.setFromAxisAngle(nrm, rng.range(0, Math.PI * 2));
        qt.premultiply(qRoll);

        // NOTE: the instance matrix stays unit-scaled. The card's size lives in
        // aInst2.z and is applied in the vertex shader, because the bloom-stage
        // growth animation has to scale it per frame without rewriting matrices.
        const size = rng.range(Ly.size[0], Ly.size[1]) * (stray ? rng.range(0.46, 0.86) : 1)
          * CARD_SCALE;
        scl.set(1, 1, 1);
        mat4.compose(pp, qt, scl);
        inst.setMatrixAt(w, mat4);

        /* ---- Growth order: the crown must THIN, never STRIP ----------------
         * The old formula was `rng()*0.74 + (1 - (radial*0.6 + height*0.4))*0.40`,
         * i.e. a random draw plus a 0.40-wide POSITIONAL pedestal. Any card deep
         * or low in the crown started at order >= 0.40 and therefore could not
         * open at all until coverage 0.43 — past stage 1 — so the fresh-save tree
         * flowered only on its outer top and every low limb was bare wood. Add
         * random-with-replacement anchor picking on top and whole branches drew
         * zero cards.
         *
         * Now the order is a LOW-DISCREPANCY sequence: `a.seq` is the golden-ratio
         * walk over the anchor's index within its bucket, and a branch's anchors
         * are consecutive in that bucket, so a branch with k >= 3 anchors always
         * owns an order in the lowest third of the range. Additional cards on the
         * same anchor are offset by rank so they open in succession. The
         * outside-in / top-down feel survives as a 0.12 nudge instead of the
         * dominant term.
         *
         * r2 STRENGTHENED to a GUARANTEE rather than a statistical tendency. A
         * golden-ratio walk spreads a branch's orders across the range on average,
         * but nothing stopped a given anchor's whole handful of cards landing in
         * the top half — and with the spur layer that would mean a naked primary
         * limb at stage 1, which is the exact blocker. So when an anchor gets
         * `perAnchor > 1` cards, the range is BANDED by rank: rank 0 always draws
         * from the lowest 1/perAnchor of the front, rank 1 from the next band, and
         * so on. Every spur site therefore owns a card that opens by stage 1 (spur
         * perAnchor = 5, so rank 0 lands on order 0.22-0.37, and cardGrow at
         * coverage 0.330 returns 0.80-1.00 there), and the later ranks fill in
         * through stages 2-3. Where perAnchor == 1 (the outer shell has ~4x more
         * anchors than cards) the seq walk stays, because banding a single card per
         * anchor would open the ENTIRE shell at stage 1. */
        const heightT = THREE.MathUtils.clamp((pp.y - (cCentre.y - cRadius)) / (2 * cRadius), 0, 1);
        const radialT = THREE.MathUtils.clamp(pp.distanceTo(cCentre) / cRadius, 0, 1);
        const jitU = ((a.seq ?? rng.next()) + rng.range(-0.11, 0.11) + 1) % 1;
        const bias = (1 - (radialT * 0.60 + heightT * 0.40)) - 0.5;
        // The outside-in nudge lives INSIDE the rank band, not on top of it —
        // added afterwards it could lift a rank-0 card clean out of its band and
        // break the guarantee the banding exists to make.
        const strat = perAnchor > 1
          ? (rank + THREE.MathUtils.clamp(jitU + bias * 0.34, 0, 0.999)) / perAnchor
          : jitU + bias * 0.16;
        let order = THREE.MathUtils.clamp(
          ORDER_LO + (ORDER_HI - ORDER_LO) * strat, 0.03, 0.985);
        /* the stage 4/5 reserve, taken from the TOP of the order range rather
         * than by a coin flip: a random 15.5 % chance could (and did) steal a
         * branch's only early-opening card, and the reserve then clumped. This
         * maps the last 14 % of the front onto 1.00-1.22, so stages 4 and 5 add
         * card COUNT at constant card SIZE, evenly, everywhere. */
        if (order > 0.845) order = 1.00 + (order - 0.845) * 1.57;

        aInst[w * 4 + 0] = a.phase;
        aInst[w * 4 + 1] = THREE.MathUtils.clamp(a.stiff * 1.06, 0, 1);
        aInst[w * 4 + 2] = order;
        aInst[w * 4 + 3] = rng.next();

        // tile: mostly full clusters, sparser ones on the silhouette edge. A
        // low tier has fewer cards, so it can afford fewer holey ones.
        const sparseP = 0.20 / CARD_SCALE;
        const tile = (stray || rng.next() < sparseP)
          ? ATLAS_SPARSE_FIRST + Math.floor(rng.next() * ATLAS_SPARSE_COUNT)
          : Math.floor(rng.next() * ATLAS_BLOSSOM_COUNT);
        aInst2[w * 4 + 0] = tile;
        aInst2[w * 4 + 1] = rng.range(Ly.ao[0], Ly.ao[1]);
        aInst2[w * 4 + 2] = size;
        aInst2[w * 4 + 3] = rng.next();

        // Tint: bright on the outside, deep in the interior, always coherent —
        // and now SPATIALLY COHERENT. A purely per-card random walk over the
        // five palette values averages out at hero distance and the crown reads
        // as one pale mass (ART_BIBLE §8 tell 5). A low-frequency field over the
        // crown pushes whole handfuls of neighbouring clusters up or down the
        // palette together, so the canopy resolves into readable light and
        // shadowed masses instead of noise.
        const patch = noise3(pp.x * 0.30 + 13.7, pp.y * 0.30, pp.z * 0.30 + 5.1) * 0.62
          + noise3(pp.x * 0.86, pp.y * 0.86 + 21.3, pp.z * 0.86) * 0.26;
        const cdf = TINT_CDF[Ly.key] ?? TINT_CDF.mid;
        const u = THREE.MathUtils.clamp(rng.next() * 0.62 + (patch * 0.5 + 0.5) * 0.38, 0, 0.999);
        let ti = 0; while (ti < 4 && u > cdf[ti]) ti++;
        const c = TINT_RATIO[ti];
        // value jitter: +-0.06 display L on a ~0.80 L palette value is +-7.5 %.
        const j2 = (1 + THREE.MathUtils.clamp(rng.gauss(0, 0.038) + patch * 0.030, -0.10, 0.10));
        // hue jitter +-10 deg, plus a temperature swing carried by the same
        // low-frequency patch field so neighbours agree (real blossom runs warm
        // yellow-pink to cool blue-pink in patches across one tree).
        const tw = THREE.MathUtils.clamp(rng.range(-0.7, 0.7) + patch * 0.8, -1, 1);
        const hx = tw > 0 ? WARM : COOL;
        const k = Math.abs(tw) * 0.55;
        TC.setRGB(c.x * j2 * (1 + (hx.x - 1) * k),
          c.y * j2 * (1 + (hx.y - 1) * k),
          c.z * j2 * (1 + (hx.z - 1) * k), THREE.LinearSRGBColorSpace);
        TC.offsetHSL(rng.range(-10, 10) / 360, 0, 0);
        aTint[w * 3 + 0] = TC.r;
        aTint[w * 3 + 1] = TC.g;
        aTint[w * 3 + 2] = TC.b;
      }
    }

    /* ---- 常桜 Everblossom: FLOATING ISLANDS OF BLOSSOM -------------------
     * Detached clusters suspended around and above the crown, revealed by
     * uIsland and animated by isleDrift() in the vertex shader (a slow orbit
     * about the crown axis plus a per-cluster bob). They are placed on a golden-
     * angle spiral over the upper hemisphere at 1.20-1.85 crown radii so they
     * break the silhouette in every direction instead of clumping, and they are
     * painted from the LIGHT end of the palette (#FFF2F6 / #FFD9E6 / #FFB6CE)
     * with a wide-open AO — an island has nothing above it to shade it. */
    {
      const isleC = new THREE.Vector3();
      for (let ci = 0; ci < ISLE_CLUSTERS; ci++) {
        const az = ci * 2.39996 + rng.range(-0.35, 0.35);
        /* MEASURED r5: at 1.20-1.85 crown radii these sat 11-17 m clear of the
         * crown and read as separate pink CLOUDS, not as islands of the tree's own
         * blossom. Pulled in so they hug the silhouette and break it, which is what
         * makes the relationship legible. */
        /* MEASURED r5 (shots/tree-r5-s5/hero.png): even at 1.02-1.34 radii the
         * islands sat 9-12 m clear of the crown and, at cluster spreads of up to
         * 1.10 m, read as two pink CUMULUS CLOUDS in the top corners of the frame —
         * nothing tied them to the tree. An "island of blossom" has to read as a
         * piece of THIS crown that has come loose, which means close enough to
         * overlap the silhouette and small enough not to be mistaken for weather. */
        const el = rng.range(0.04, 0.72);                       // mostly above the equator
        const rad = cRadius * rng.range(0.88, 1.12);
        isleC.set(Math.cos(az) * Math.cos(el * 1.35), Math.sin(el * 1.15), Math.sin(az) * Math.cos(el * 1.35))
          .multiplyScalar(rad).add(cCentre);
        const spread = rng.range(0.42, 0.76);
        const phase = rng.next();
        const seed = rng.next();
        for (let k = 0; k < ISLE_PER && w < COUNT; k++, w++) {
          pp.set(rng.gauss(0, spread), rng.gauss(0, spread * 0.55), rng.gauss(0, spread))
            .add(isleC);
          nrm.copy(pp).sub(isleC).normalize()
            .addScaledVector(jit.set(rng.gauss(0, 0.5), rng.gauss(0, 0.5), rng.gauss(0, 0.5)), 0.9)
            .normalize();
          qt.setFromUnitVectors(ZP, nrm);
          qRoll.setFromAxisAngle(nrm, rng.range(0, Math.PI * 2));
          qt.premultiply(qRoll);
          scl.set(1, 1, 1);
          mat4.compose(pp, qt, scl);
          inst.setMatrixAt(w, mat4);

          aInst[w * 4 + 0] = phase;              // one drift phase per cluster
          aInst[w * 4 + 1] = 0;                  // no host twig, so no sway
          aInst[w * 4 + 2] = 0;                  // grow comes from uIsland
          aInst[w * 4 + 3] = 1;                  // never a bud
          aInst2[w * 4 + 0] = rng.next() < 0.30
            ? ATLAS_SPARSE_FIRST + Math.floor(rng.next() * ATLAS_SPARSE_COUNT)
            : Math.floor(rng.next() * ATLAS_BLOSSOM_COUNT);
          aInst2[w * 4 + 1] = rng.range(0.92, 1.00);
          aInst2[w * 4 + 2] = rng.range(0.88, 1.52) * CARD_SCALE;
          aInst2[w * 4 + 3] = seed;              // shared, so a cluster moves as one
          const c = TINT_RATIO[Math.floor(rng.next() * 3)];
          const j2 = 1 + THREE.MathUtils.clamp(rng.gauss(0, 0.045), -0.11, 0.11);
          TC.setRGB(c.x * j2, c.y * j2, c.z * j2, THREE.LinearSRGBColorSpace);
          TC.offsetHSL(rng.range(-8, 8) / 360, 0, 0);
          aTint[w * 3 + 0] = TC.r;
          aTint[w * 3 + 1] = TC.g;
          aTint[w * 3 + 2] = TC.b;
          aIsle[w] = 1;
        }
      }
    }

    inst.count = w;
    cardGeo.setAttribute('aInst', new THREE.InstancedBufferAttribute(aInst, 4));
    cardGeo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(aInst2, 4));
    cardGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 3));
    cardGeo.setAttribute('aIsle', new THREE.InstancedBufferAttribute(aIsle, 1));

    const canopyUniforms = {
      uAtlas: { value: atlas },
      // the atlas's dominant painted value; see TINT_RATIO above.
      uTintRef: { value: new THREE.Vector3(TINT_REF.r, TINT_REF.g, TINT_REF.b) },
      // ART_BIBLE §2 "#FFE7EE": the colour light takes bleeding through a petal.
      uTransCol: { value: col(0xFFE7EE) },
      uTransAmt: { value: 0.30 },
      // Floor on the interior value ladder, as a fraction of the card's own
      // palette albedo. 0.48 keeps the deepest interior ON #C25F86 rather than
      // two stops under it.
      uDeepClamp: { value: 0.56 },
      uTranslucency: { value: 0.50 },
      uThickness: { value: 0.52 },
      uAlphaTest: { value: 0.42 },
      uLumin: { value: 0 },
      uLuminCol: { value: col(0xFFC9DC) },
      uGold: { value: 0 },
      uGoldCol: { value: col(0xE8C56A) },
      // DECISION: the backlit translucent canopy is the signature look, so this
      // is the single most important number in the file. 0.40 -> 0.66.
      uThroughGlow: { value: 0.38 },
      uGlowCol: { value: col(0xFFC3D6) },
      // Extra warm halo where the key grazes the outer shell from behind.
      uSunHalo: { value: 0.40 },
      uHaloCol: { value: col(0xFFE7EE) },
      // These three are the SAME uniform objects the trunk material holds, so
      // the wood's blossom-bounce term and the canopy always agree on where the
      // crown is and how much of it has opened.
      uCoverage: trunkUniforms.uCoverage,
      uBudMix: { value: STAGE.budMix[3] },
      uCanopyCentre: trunkUniforms.uCanopyCentre,
      // BUG FIX: CANOPY_COMMON has always declared uCanopyR and nobody supplied
      // it, so vCrownT/vShell were computed against a zero radius (div by ~0)
      // and the crown had no usable volume coordinates at all.
      uCanopyR: trunkUniforms.uCanopyR,
      // The BEAUTY camera position, shared by reference with the depth material
      // so the shadow pass billboards the cards exactly as the beauty pass does.
      // (`cameraPosition` would be the light's position during the shadow pass.)
      uEyePos: { value: new THREE.Vector3(0, 8, 24) },
      uAtlasCols: { value: ATLAS_COLS },
      // less blend toward the crown's own sphere normal => individual clusters
      // keep more of their own facing, which is where cluster-to-cluster
      // value variation comes from.
      // 0.44 -> 0.62: the more each card shades along the CROWN's own outward
      // normal, the more the whole mass reads as one lit sphere with a dark side,
      // which is where a canopy's sense of volume actually comes from. Individual
      // cluster facing still carries 38 % so the surface is not a smooth ball.
      uNormalBlend: { value: 0.62 },
      // Headroom. The atlas is authored bright, the key is warm and the post
      // chain lifts hard; measured, the crown's whole luminance histogram was
      // piling up at p25 0.87 / p95 0.95, i.e. clipping into one flat value.
      // Scaling the albedo is the only lever that survives an exposure lift.
      uAlbedoScale: { value: 0.88 },
      // Optical depth per crown RADIUS of blossom. 1.55 => one radius of crown
      // between a cluster and the key leaves 21 % of the transmission, two radii
      // leave 4.5 %. This is the knob that turns a uniformly glowing cloud into a
      // backlit mass with a blazing rim.
      uOpticalDepth: { value: 1.55 },
      // Linear-luminance floor for the deepest crown interior. #C25F86 sits at
      // ~0.155 linear luma, so this keeps the darkest blossom ON the palette's
      // deep-interior value instead of below it.
      // MEASURED: 0.150 linear prints at display L 0.40 through the ACES + grade
      // chain when it is reached; the reason it was not reached is documented at
      // the floor itself (the old 3.0x multiplier cap). 0.185 lands the darkest
      // authored blossom (#C25F86, display L 0.467) at 0.44-0.46 with headroom.
      // A/B MEASURED this round. The darkest surviving blossom cluster in the hero
      // frame (x 1057-1105 y 500-560) prints at display L 0.538 with this at 0.245
      // and L 0.841 with it at 0.900, so the floor does own those pixels. 0.265
      // lands that cluster at ~0.55 — just above ART_BIBLE's deepest authored
      // blossom #C25F86 (L 0.467) and above the prescribed 0.42 floor — while
      // leaving the crown a real value ladder (best 90x90 block sd 0.223). Going
      // higher to chase the last anti-aliased edge pixels below 0.40 would take the
      // whole deep value out of the palette, which is the opposite failure.
      uDeepFloor: { value: 0.265 },
      uInterior: { value: 1.0 },
      // Measured r3: the shadow-side crown came out rgb(150,103,120), HSL sat
      // 0.18 — grey mauve, the muddy midtone ART_BIBLE §8 tell 9 forbids. Cutting
      // green harder than red/blue walks the albedo down the palette's own
      // #FFB6CE -> #EE8CAF -> #C25F86 line instead of desaturating it.
      // 0.43 on green cut the interior 2.3 stops below the palette's deep value and
      // turned it aubergine. 0.60 walks the albedo down #FFB6CE -> #EE8CAF ->
      // #C25F86 without leaving the palette.
      // r3: (0.88,0.60,0.70) walked the interior below #C25F86's own saturation
      // (measured 0.60 HSL against the palette value's 0.45), which is what made
      // the interior read as a bruise. This lands ON the palette.
      /* ---- THE VIOLET CANOPY: root cause and fix -------------------------
       * Full derivation in the comment block above `#define NPR_SHADOW_TINT` in
       * tree-shaders.js. In one line: lighting.js's nprShadowHue() multiplies the
       * albedo by uShadowTint (#6E76A8) renormalised to unit luminance, which is
       * (0.507, 1.028, 2.182) — blue x2.18, red x0.51 — and that turns the
       * palette's own deep interior #C25F86 into linear (0.372, 0.135, 0.537),
       * i.e. BLUER than it is red. The legacy NPR_SHADOW_HUE / NPR_SHADOW_CHROMA
       * dampers cannot reach it because nprTintStrength() floors their product at
       * 0.78 on purpose. NPR_SHADOW_TINT is the knob that does.
       *
       * MEASURED, hero crown interior (x 790-1010, y 260-700 of 1920x1080),
       * mean over blossom pixels:
       *   uShTint 1.00 (was)  rgb(170,124,160)  B/R 0.939  hue 302  violet 53.1 %
       *   uShTint 0.22        see r1 numbers in the report
       * ART_BIBLE's #C25F86 is B/R 0.69; the whole-crown target is 0.72-0.80.
       *
       * Sakura is the one material in the scene that must NOT take the generic
       * violet: ART_BIBLE §3 gives the blossom its own shadow ramp (#FFB6CE ->
       * #EE8CAF -> #C25F86) and every value on it has blue below red, so the cool
       * shift is authored in the palette ladder instead. */
      uShTint: { value: 0.20 },
      // the "never black" pedestal is 55 % raw #6E76A8; on a crown whose darkest
      // value is already floored by uDeepFloor it buys nothing but lavender.
      uShFloor: { value: 0.016 },
      uRimSky: { value: 0.20 },
      // how far the interior albedo walks onto uDeepCol's own chroma (1.0 = all
      // the way at full occlusion) and how far its value drops. Two facts, two
      // numbers — the old single uDeepTint vector conflated them and got the
      // chroma direction wrong (it crushed green without gaining red, which walks
      // pink toward magenta).
      uDeepWalk: { value: 0.86 },
      uDeepValue: { value: 0.70 },
      // Sakura hue guard, as (slope, offset) on the CARD'S OWN authored albedo
      // blue:red ratio — the reference frame that actually works (see the guard
      // itself for the two keyings that measured inert). 1.10x + 0.04 allows a
      // real sky-ambient lift while capping the 2x blue gain that made the crown
      // violet: #C25F86 (0.437) -> 0.52, #FFB6CE (0.638) -> 0.74, #FFF2F6 -> 1.0.
      /* MEASURED r10, stage 3: the crown's dark quartile printed rgb(103,69,98) —
      // display B/R 0.955, hue 308, a crimson-violet column reading as a different
      // plant from the pale sides. The guard WAS enforcing its linear cap (0.526 at
      // the deep end); the post grade's shadow lift toward #2A2438 (B/R 1.33) then
      // put it back, because that lift is a fixed offset and dominates a pixel at
      // display L 0.31. A shader cannot out-argue a post-process offset, so the
      // linear cap has to be tight enough that the LIFTED pixel lands on the
      // palette: 0.88x + 0.01 gives 0.40 at #C25F86, 0.55 at #FFB6CE, 0.81 at
      // #FFF2F6 — still a real sky-ambient allowance on the light values, where the
      // lift is negligible, and a hard one where it is not. */
      uGuardCap: { value: new THREE.Vector2(0.88, 0.01) },
      uHueGuard: { value: 1.0 },
      // Measured r0 of this round: the crown's shaded interior came out
      // rgb(116,76,95), HSL sat 0.21 — grey mauve, the muddy midtone
      // ART_BIBLE §8 tell 9 forbids. uDeepTint alone cannot win, because the
      // blue sky ambient is added AFTER it. uChromaFix re-imposes the palette's
      // own #C25F86 hue on the interior at whatever luminance the shading
      // arrived at, so value structure survives and the chroma comes back.
      uDeepCol: { value: col(0xC25F86) },
      uMidCol: { value: col(0xFFB6CE) },
      // base palette lock (everywhere) + the extra the deep interior takes. Both
      // are luminance-preserving, so they buy chroma at zero cost to the value
      // ladder. Swept live via the `tree-lock*` scenarios.
      uChromaFix: { value: 0.34 },
      uChromaDeep: { value: 0.30 },
      /* The FINAL chroma resolve — see the big MEASURED block in CANOPY_FRAG.
       * The two locks above run before the through-glow, halo, transmission and
       * deep-floor terms, all of which add near-white on top; this one runs after
       * all of them, which is why it is the one that actually moves the printed
       * pixel. Swept live via the `tree-cf*` scenarios. */
      uChromaFinal: { value: 0.95 },
      /* ACES pre-compensation on the lock's target chroma — see the derivation in
       * CANOPY_FRAG. Swept live via the `tree-cg*` scenarios; land it so the
       * PRINTED interior sits on ART_BIBLE's ladder, not so the linear target
       * does. Luminance-neutral, so it cannot flatten the value structure. */
      /* MEASURED (value-indexed ladder, hero crown, uChromaGain 1.00/1.85/2.80):
       *   mean B/R 0.777 / 0.771 / 0.772
       *   dark-quartile B/R 0.755 / 0.733 / 0.726, HSL sat 0.369 / 0.476 / 0.543
       * The ratio saturates by 1.85 while the saturation keeps climbing, and the
       * PICTURE at 1.85+ is a hot fuchsia crown, not sakura. 1.30 is on the useful
       * part of the curve: it pre-compensates the ACES channel mix without buying
       * saturation the palette does not have. */
      uChromaGain: { value: 1.00 },
      // top of the ART_BIBLE §3 ladder — the specular / backlit-edge value
      uEdgeCol: { value: col(0xFFF2F6) },
      // ART_BIBLE §3's SHADOW value. The bottom of the ladder while the crown is
      // still thin — see the deepE walk in CANOPY_FRAG.
      uShadowCol: { value: col(0xEE8CAF) },
      uFlutter: { value: 0.035 },
      uWindAmp: { value: 1.05 },
      // stage 5 常桜 Everblossom
      uAurora: { value: 0 },
      uIsland: { value: 0 },
    };

    const canopyMat = new THREE.ShaderMaterial({
      uniforms: { ...lightsBlock(), ...L, ...W, ...canopyUniforms },
      vertexShader: CANOPY_VERT,
      fragmentShader: CANOPY_FRAG,
      lights: true,
      side: THREE.DoubleSide,
    });
    // NOT setting alphaToCoverage. It would be the right instrument for ART_BIBLE
    // §8.8 on an alpha-TESTED silhouette, but this shader writes alpha 1.0 (the
    // post chain owns the buffer's alpha) so coverage would always be full, and
    // 90-postfx allocates its targets without `samples`, so there is no multisample
    // buffer for coverage to dither into. Fixing the cutout edge properly is the
    // post chain's resolve, which is prescribed to that module this round.
    canopyMat.userData.noNpr = true;

    const canopyDepthMat = new THREE.ShaderMaterial({
      uniforms: {
        ...W,
        uAtlas: canopyUniforms.uAtlas,
        uAlphaTest: canopyUniforms.uAlphaTest,
        uCoverage: canopyUniforms.uCoverage,
        uBudMix: canopyUniforms.uBudMix,
        uCanopyCentre: canopyUniforms.uCanopyCentre,
        uCanopyR: canopyUniforms.uCanopyR,
        uEyePos: canopyUniforms.uEyePos,
        uAtlasCols: canopyUniforms.uAtlasCols,
        uFlutter: canopyUniforms.uFlutter,
        uWindAmp: canopyUniforms.uWindAmp,
        // shared BY REFERENCE, so the shadow pass sizes the island cards exactly
        // as the beauty pass does — otherwise stage 5 casts shadows from clusters
        // that are not there yet.
        uIsland: canopyUniforms.uIsland,
      },
      vertexShader: CANOPY_DEPTH_VERT,
      fragmentShader: CANOPY_DEPTH_FRAG,
      side: THREE.DoubleSide,
    });

    inst.material = canopyMat;
    inst.name = 'sakura-canopy';
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.customDepthMaterial = canopyDepthMat;
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    if (inst.boundingSphere) inst.boundingSphere.radius *= 1.22;
    group.add(inst);

    /* ---- 常桜 Everblossom: LIGHT SHAFTS ----------------------------------
     * 90-postfx owns the screen-space god rays; these are the object-space
     * complement, anchored INSIDE the crown's gaps and falling away from the key,
     * so they move with the tree instead of smearing off a sun sprite. One
     * instanced additive mesh — 1 draw call, and it is skipped entirely (visible
     * false) below stage 4, so nothing pays for it until the Everblossom.
     *
     * Pure emission: nprShadeN would be meaningless on a volume with no surface,
     * but the colour is the SHARED uSunColor and the result goes through
     * applyAerial, so the shafts sit in the same air as everything else. */
    const SHAFT_N = { ultra: 16, high: 14, medium: 10, low: 7 }[tier] ?? 12;
    const shaftGeo = new THREE.PlaneGeometry(1, 1, 1, 7);
    const shaftData = new Float32Array(SHAFT_N * 4);
    const shaftInst = new THREE.InstancedMesh(shaftGeo, null, SHAFT_N);
    {
      const rs = makeRng(SEED ^ 0x5A17F);
      for (let i = 0; i < SHAFT_N; i++) {
        // origin: inside the upper crown, where the gaps between clusters are
        const az = i * 2.39996 + rs.range(-0.4, 0.4);
        const rr = cRadius * rs.range(0.20, 0.86);
        pp.set(Math.cos(az) * rr, rs.range(-0.15, 0.72) * cRadius, Math.sin(az) * rr).add(cCentre);
        mat4.compose(pp, new THREE.Quaternion(), scl.set(1, 1, 1));
        shaftInst.setMatrixAt(i, mat4);
        shaftData[i * 4 + 0] = rs.next();                 // phase
        shaftData[i * 4 + 1] = rs.range(0.60, 1.35);      // length, in uShaftLen
        shaftData[i * 4 + 2] = rs.range(0.26, 0.80);      // half-width, metres
        shaftData[i * 4 + 3] = rs.next();                 // flicker seed
      }
    }
    shaftGeo.setAttribute('aShaft', new THREE.InstancedBufferAttribute(shaftData, 4));
    const shaftUniforms = {
      uEyePos: canopyUniforms.uEyePos,
      uShafts: { value: 0 },
      uShaftLen: { value: cRadius * 2.4 },
      uShaftCol: { value: col(0xFFE9CF) },
      uWindTime: W.uWindTime,
    };
    const shaftMat = new THREE.ShaderMaterial({
      uniforms: { ...L, ...shaftUniforms },
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Pure additive, independent of the fragment's alpha (THREE.AdditiveBlending
      // multiplies by src alpha, which would double-count the intensity the
      // shader already baked into the colour). Alpha itself is left alone so the
      // post chain still owns the buffer's alpha channel.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    shaftMat.userData.noNpr = true;
    shaftInst.material = shaftMat;
    shaftInst.name = 'sakura-shafts';
    shaftInst.castShadow = false;
    shaftInst.receiveShadow = false;
    shaftInst.frustumCulled = false;
    shaftInst.renderOrder = 4;
    shaftInst.visible = false;
    shaftInst.instanceMatrix.needsUpdate = true;
    group.add(shaftInst);

    /* ---- published surface --------------------------------------- *
     * Everything above is built in the tree's LOCAL space, and the group
     * carries a yaw. Consumers (petals, VFX, gameplay) want WORLD space, so the
     * group transform is baked into everything published from here on.        */
    group.updateMatrix();
    const M = group.matrix.clone();
    const NM = new THREE.Matrix3().getNormalMatrix(M);
    const cCentreW = cCentre.clone().applyMatrix4(M);

    const canopyBounds = new THREE.Sphere(cCentreW.clone(), cRadius);
    const canopyBox = new THREE.Box3().setFromCenterAndSize(
      cCentreW, new THREE.Vector3(cRadius * 2, cRadius * 1.7, cRadius * 2));
    const anchorPool = all;
    const tipsWorld = tips.map((p) => p.clone().applyMatrix4(M));

    /**
     * A point on the outer branch structure — where petals are born and where
     * shake VFX originate. Pass a 0..1 number or an rng function.
     */
    function sampleBranchPoint(r) {
      const u = typeof r === 'function' ? r() : (typeof r === 'number' ? r : Math.random());
      const a = anchorPool[Math.min(anchorPool.length - 1, Math.floor(u * anchorPool.length))];
      return {
        point: a.p.clone().applyMatrix4(M),
        dir: a.d.clone().applyMatrix3(NM).normalize(),
        stiff: a.stiff,
        phase: a.phase,
      };
    }

    let stage = 3;
    const tree = {
      group,
      trunkMesh,
      canopyMeshes: [inst],
      branchTips: tipsWorld,
      canopyBounds,
      canopyBox,
      sampleBranchPoint,
      get stage() { return stage; },
      cardCount: w,
      // published so tools/probe.mjs can mutate a single term and diff the
      // rendered pixels — far cheaper than reading shader source, and the way the
      // violet-canopy bug was finally localised.
      canopyUniforms,
      trunkUniforms,
    };
    ctx.assets.tree = tree;
    ctx.clickTargets.push(trunkMesh, inst);

    /* ---- bloom stages -------------------------------------------- */
    let stageT = 3;              // smoothed
    let stageTarget = 3;
    function writeStage(s) {
      canopyUniforms.uCoverage.value = stageAt(STAGE.coverage, s);
      canopyUniforms.uBudMix.value = stageAt(STAGE.budMix, s);
      canopyUniforms.uLumin.value = stageAt(STAGE.lumin, s);
      canopyUniforms.uGold.value = stageAt(STAGE.gold, s) * 0.34;
      trunkUniforms.uGold.value = stageAt(STAGE.gold, s);
      trunkUniforms.uBare.value = stageAt(STAGE.bare, s);
      trunkUniforms.uMossAmt.value = stageAt(STAGE.moss, s);
      // ---- stage 5 常桜 Everblossom -----------------------------------
      canopyUniforms.uAurora.value = stageAt(STAGE.aurora, s);
      canopyUniforms.uIsland.value = stageAt(STAGE.island, s);
      const sh = stageAt(STAGE.shafts, s);
      shaftUniforms.uShafts.value = sh * 1.05;
      // one draw call, but there is no reason to pay for it below stage 4
      shaftInst.visible = sh > 0.004;
    }
    writeStage(stageT);

    /**
     * The game module drives this. Be liberal in what we accept: a bare number,
     * `{stage}`, `{value}`, or a string — anything that is not a finite 0..5
     * leaves the current stage alone rather than snapping the tree to winter.
     */
    function requestStage(p) {
      const raw = (p && typeof p === 'object')
        ? (p.stage ?? p.value ?? p.index ?? p.n)
        : p;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const s = THREE.MathUtils.clamp(Math.round(n), 0, 5);
      stage = s; stageTarget = s;
    }
    ctx.bus.on('bloom:stage', requestStage);

    /** Debug scenarios. window.__game exists before boot(), but register again
     *  on game:ready so we survive any future re-ordering of main.js. */
    function registerScenarios() {
      const sc = (typeof window !== 'undefined' && window.__game?.scenarios) || null;
      if (!sc) return;
      for (let s = 0; s <= 5; s++) {
        sc[`stage${s}`] = () => { stage = s; stageTarget = s; stageT = s; writeStage(s); };
        // ...and the same stage with the post chain, petals and click VFX out of
        // the way. Judging the canopy's own value structure THROUGH a bloom +
        // grade + DOF chain that another module is actively retuning is how two
        // earlier rounds talked themselves into a regression; this is the
        // ground-truth view. One --scenario flag is all shot.mjs accepts, so the
        // stage and the clean-up have to travel together.
        sc[`tree-raw${s}`] = () => {
          sc['postfx-off']?.(); sc['petals-off']?.(); sc['vfx-off']?.();
          stage = s; stageTarget = s; stageT = s; writeStage(s);
        };
      }
      /* ---- violet-canopy A/B rig ----------------------------------------
       * `tree-violet-old` restores the exact pre-fix chain (full library shadow
       * tint, no hue guard) so the before/after can be measured from ONE build
       * with one --scenario flag, which is the only thing shot.mjs accepts. The
       * three `-t1 / -g0 / -w0` variants isolate the terms one at a time. */
      sc['tree-violet-old'] = () => {
        canopyUniforms.uShTint.value = 1.0;
        canopyUniforms.uShFloor.value = 0.045;
        canopyUniforms.uHueGuard.value = 0.0;
        canopyUniforms.uDeepWalk.value = 0.0;
        canopyUniforms.uDeepValue.value = 0.74;
      };
      sc['tree-violet-t1'] = () => { canopyUniforms.uShTint.value = 1.0; };
      /* uChromaFinal sweep — the r2 chroma knob. One --scenario flag is all
       * shot.mjs accepts, so each variant also forces stage 1 (the fresh-save
       * state the blocker was measured in). */
      for (const v of [0, 25, 40, 55, 70, 85, 95]) {
        sc[`tree-cf${v}`] = () => {
          canopyUniforms.uChromaFinal.value = v / 100;
          stage = 1; stageTarget = 1; stageT = 1; writeStage(1);
        };
        // ...and the same with the post chain out of the way, so the SHADER's own
        // chroma can be measured without the grade's violet shadow lift on top.
        sc[`tree-rawcf${v}`] = () => {
          sc['postfx-off']?.(); sc['petals-off']?.(); sc['vfx-off']?.();
          canopyUniforms.uChromaFinal.value = v / 100;
          stage = 1; stageTarget = 1; stageT = 1; writeStage(1);
        };
      }
      /* Does the final chroma resolve actually OWN these pixels? Paints the whole
       * palette ladder green: if the crown does not turn green, the term is not
       * reaching the fragments being measured, and no amount of tuning it will
       * help. (This is how the r4 "the lock barely moves the pixel" puzzle was
       * settled — cheaper than reading shader source.) */
      for (const v of [100, 145, 185, 230, 280]) {
        sc[`tree-cg${v}`] = () => {
          canopyUniforms.uChromaGain.value = v / 100;
          stage = 1; stageTarget = 1; stageT = 1; writeStage(1);
        };
      }
      sc['tree-locktest'] = () => {
        sc['postfx-off']?.(); sc['petals-off']?.(); sc['vfx-off']?.();
        canopyUniforms.uMidCol.value.setRGB(0.1, 1.0, 0.1);
        canopyUniforms.uDeepCol.value.setRGB(0.1, 1.0, 0.1);
        canopyUniforms.uEdgeCol.value.setRGB(0.1, 1.0, 0.1);
        canopyUniforms.uChromaFinal.value = 0.95;
        stage = 1; stageTarget = 1; stageT = 1; writeStage(1);
      };
      // Which mesh owns a pixel? Used to localise the near-black patches in the
      // trunk crotch (they turned out to be wood, not blossom).
      sc['tree-nocanopy'] = () => { inst.visible = false; };
      sc['tree-nowood'] = () => { trunkMesh.visible = false; };
      sc['tree-lock0'] = () => { canopyUniforms.uChromaFix.value = 0; canopyUniforms.uChromaDeep.value = 0; };
      sc['tree-g40'] = () => { canopyUniforms.uHueGuard.value = 0.40; };
      // stage 5 feature isolation: crank one term so it can be confirmed present
      sc['tree-shafts-max'] = () => { stage = 5; stageTarget = 5; stageT = 5; writeStage(5); shaftUniforms.uShafts.value = 4.0; shaftInst.visible = true; };
      sc['tree-s5-noextra'] = () => { stage = 5; stageTarget = 5; stageT = 5; writeStage(5); shaftUniforms.uShafts.value = 0; shaftInst.visible = false; canopyUniforms.uAurora.value = 0; canopyUniforms.uIsland.value = 0; };
      sc['tree-g65'] = () => { canopyUniforms.uHueGuard.value = 0.65; };
      sc['tree-lock-hi'] = () => { canopyUniforms.uChromaFix.value = 0.55; canopyUniforms.uChromaDeep.value = 0.30; };
      sc['tree-violet-g0'] = () => { canopyUniforms.uHueGuard.value = 0.0; };
      sc['tree-violet-w0'] = () => { canopyUniforms.uDeepWalk.value = 0.0; };
      sc.treeCalm = () => { WIND.uniforms.uWindStrength.value = 0.25; };
      sc.treeGust = () => { WIND.uniforms.uWindStrength.value = 1.9; };
      // Judging tree GEOMETRY through a heavy depth-of-field is guesswork, so
      // this scenario borrows the other modules' own debug switches (resolved
      // lazily — they register after this module boots).
      sc['tree-clean'] = () => { sc['petals-off']?.(); sc['postfx-no-dof']?.(); };
    }
    registerScenarios();
    ctx.bus.on('game:ready', registerScenarios);

    /* ---- clicks: keep it minimal, gameplay lives in 60-game.js ---- */
    ctx.bus.on('world:click', (e) => {
      const o = e?.hit?.object;
      if (!o || (o !== trunkMesh && o !== inst)) return;
      ctx.bus.emit('tree:clicked', {
        point: e.point.clone(),
        worldNormal: e.hit.face
          ? e.hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(o.matrixWorld))
          : e.point.clone().sub(cCentreW).normalize(),
        power: 1,
      });
    });

    return {
      object3D: group,
      update(dt) {
        // pixels per world unit at 1 m: height / (2 tan(fovY/2)). Recomputed
        // every frame because the camera rig animates the FOV.
        const cam = ctx.camera;
        if (cam) canopyUniforms.uEyePos.value.setFromMatrixPosition(cam.matrixWorld);
        if (cam?.isPerspectiveCamera) {
          const hPx = Math.max(1, (ctx.size?.h ?? 1080) * (ctx.size?.dpr ?? 1));
          const t = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
          trunkUniforms.uPxScale.value = hPx / (2 * Math.max(t, 1e-4));
        }
        if (stageT !== stageTarget) {
          const k = 1 - Math.exp(-dt * 2.2);
          stageT += (stageTarget - stageT) * k;
          if (Math.abs(stageTarget - stageT) < 0.002) stageT = stageTarget;
          writeStage(stageT);
        }
      },
      dispose() {
        woodGeo.dispose();
        cardGeo.dispose();
        shaftGeo.dispose(); shaftMat.dispose();
        trunkMat.dispose(); trunkDepthMat.dispose();
        canopyMat.dispose(); canopyDepthMat.dispose();
        bark.dispose(); atlas.dispose();
        ctx.assets.tree = null;
        const i1 = ctx.clickTargets.indexOf(trunkMesh); if (i1 >= 0) ctx.clickTargets.splice(i1, 1);
        const i2 = ctx.clickTargets.indexOf(inst); if (i2 >= 0) ctx.clickTargets.splice(i2, 1);
      },
    };
  },
};
