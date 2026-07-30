/**
 * Sakura — economy tables, pure maths and number formatting.
 * Owner: game agent (paired with src/modules/60-game.js).
 *
 * HARD RULE for this file: **no THREE, no DOM, no browser globals**. It is
 * imported by the browser module *and* by the balance simulator that runs in
 * plain node. Keep it pure so the balance you tune offline is the balance the
 * player gets.
 *
 * Everything in GAME_DESIGN.md that is a number lives here.
 */

/* ==================================================================== *
 * 1. Number formatting  (GAME_DESIGN "Number formatting")
 * ==================================================================== */

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd'];

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimZeros(s) {
  return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, '');
}

/**
 * 4 significant figures, `1,234` → `12.34K` → `1.234M` → … → `1.234e45`.
 * The single formatter — the UI must import this one, never roll its own.
 */
export function format(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
  const neg = n < 0;
  let v = Math.abs(n);
  let out;
  if (v === 0) out = '0';
  else if (v < 0.001) out = trimZeros(v.toExponential(3).replace('e-', 'e-'));
  else if (v < 1) out = trimZeros(v.toFixed(4));
  else if (v < 1000) {
    const d = v < 10 ? 3 : v < 100 ? 2 : 1;
    out = trimZeros(v.toFixed(d));
  } else if (v < 1e4) out = group(String(Math.round(v)));
  else {
    let t = Math.floor(Math.log10(v) / 3);
    if (t >= SUFFIX.length) {
      const e = Math.floor(Math.log10(v));
      out = trimZeros((v / 10 ** e).toFixed(3)) + 'e' + e;
    } else {
      let m = v / 1000 ** t;
      let d = m < 10 ? 3 : m < 100 ? 2 : 1;
      // rounding can push 999.95 -> 1000; re-normalise so we never print "1000K"
      if (Number(m.toFixed(d)) >= 1000) { m /= 1000; t += 1; d = 3; }
      out = (t >= SUFFIX.length)
        ? trimZeros(v.toExponential(3))
        : m.toFixed(d) + SUFFIX[t];
    }
  }
  return neg ? '-' + out : out;
}

/** Rates: 2 decimals below 100, then the standard format. "Rates show 2 decimals below 100." */
export function formatRate(n) {
  if (!Number.isFinite(n)) return '0.00';
  const v = Math.abs(n);
  if (v < 100) return (n < 0 ? '-' : '') + v.toFixed(2);
  return format(n);
}

/** Whole counts with thousands separators (owned counts, click counts). */
export function formatInt(n) {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1e6) return group(String(Math.round(n)));
  return format(n);
}

/** "4h 12m", "45s", "2d 6h" — used by the offline panel and event timers. */
export function formatTime(seconds) {
  let s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); s -= m * 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60); const mm = m - h * 60;
  if (h < 24) return h + 'h ' + mm + 'm';
  const d = Math.floor(h / 24); const hh = h - d * 24;
  return d + 'd ' + hh + 'h';
}

/** Compact clock for buff pips: "0:07", "1:23". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s - m * 60).padStart(2, '0');
}

/* ==================================================================== *
 * 2. Tuning constants
 * ==================================================================== */

export const TUNING = {
  COST_GROWTH: 1.15,          // cost(n) = baseCost * 1.15^n            (spec)
  BASE_CRIT_CHANCE: 0.03,     // 3%                                      (spec)
  MAX_CRIT_CHANCE: 0.60,      // 60% cap                                 (spec)
  BASE_CRIT_MULT: 8,          // ×8                                      (spec)
  CLICK_PASSIVE_TERM: 0.0002, // (1 + 0.0002 * passiveRate)              (spec)
  ESSENCE_PER_POINT: 0.02,    // +2% production per Essence earned       (spec)
  ACH_BONUS: 0.01,            // +1% production per achievement          (spec)
  PRESTIGE_MIN: 1e6,          // Season available at 1e6 this season     (spec)
  ESSENCE_EXP: 0.55,          // floor((total/1e6) ** 0.55)              (spec, tune)
  OFFLINE_RATE: 0.55,         // 55% of passive while away               (spec)
  OFFLINE_CAP_H: 3,           // Dew Reservoir default 3 h               (spec)
  OFFLINE_MAX_MS: 30 * 24 * 3600e3, // anti-clock-cheat hard clamp
  STORM_PERIOD: 420,          // 7 min                                   (spec)
  STORM_JITTER: 120,          // ±2 min                                  (spec)
  /**
   * The FIRST storm of a save only. GAME_DESIGN marks the storm cadence
   * *(tune)*, and at the spec'd 420 ± 120 the first one lands at 300–540 s —
   * measured median 536 s. That is the game's marquee set piece (×10 income,
   * the whole hillside in the air, wind ×2.5) held back for nine minutes, and
   * it also gates content: the `storms: 1` requirement on Storm Glass and the
   * 'Rode the Storm' achievement cannot even appear until it fires. Against
   * "a meaningful decision or a new unlock at least every ~40 seconds early
   * on", nine minutes is the longest dead beat in the opening.
   *
   * 110 ± 30 s puts it just after the first Tender purchases and the first
   * Codex card, so the opening reads: shake → buy → card → storm. Every
   * SUBSEQUENT storm uses the spec'd 420 ± 120, so steady-state cadence is
   * untouched (8 storms in 60 min, measured, unchanged).
   *
   * MEASURED COST, 40 seeds each (`sim.mjs --seeds 40 --dials '{"sf":…}'`),
   * medians: grace off → 初咲 527s, 満開 1819s, 25 Essence 3599s, score 0.517.
   * Grace 110 → 初咲 563s, 満開 1824s, 25 Essence 3438s, score 0.586. So the
   * mid-game does not move at all (満開 1819 vs 1824 s) and the whole price is
   * 4.5% off "the Season is worth turning", 60 → 57 min, still inside
   * GAME_DESIGN's 50–70 min window. The 初咲 difference is inside the seed
   * spread (p10–p90 spans 312–652 s) and is not a real effect. 160 ± 30 was
   * also measured (初咲 544s, 満開 1829s, 25 Essence 3501s, score 0.579) and is
   * the option to reach for if that 3 min ever needs buying back — but 110
   * is what puts the storm inside the first two minutes, which is the point.
   */
  STORM_FIRST: 110,
  STORM_FIRST_JITTER: 30,
  STORM_DURATION: 20,         // 20 s                                    (spec)
  STORM_MULT: 10,             // ×10 passive                             (spec)
  STORM_WIND: 2.5,            // wind strength ×2.5                      (spec)
  MOON_CRIT: 0.25,            // Full Moon +25% crit chance              (spec)
  GOLDEN_HOUR_CLICK: 0.15,    // Golden Hour +15% click                  (spec)
  RAIN_CHANCE_PER_MIN: 0.04,  // 4% per minute                           (spec)
  RAIN_DURATION: 45,          // 45 s                                    (spec)
  RAIN_PASSIVE: 0.10,         // +10% passive                            (spec)
  GOLDEN_MIN: 90,             // Golden Petal every 90–240 s             (spec)
  GOLDEN_MAX: 240,
  GOLDEN_TTL: 15,             // seconds it stays catchable
  SIM_HZ: 20,                 // fixed simulation step — frame-rate independent
  AUTOSAVE: 10,               // autosave every 10 s                     (spec)
  /**
   * Global production scalar — the primary balance dial for the GAME_DESIGN
   * pacing table. Measured in `.tmp-game/sim.mjs`; do not change casually.
   *
   * ── 2026-07-29 re-measure, and the state of the curve as it ships ────────
   * The pacing numbers below used to be single-seed anecdotes. Storm timing,
   * Spring Rain rolls and which Golden Petal boon lands are all RNG, and one
   * sample of them moved 初咲 First Bloom between 410 s and 750 s on an
   * UNCHANGED curve — wider than any tuning change being argued about. So the
   * simulator now reports a distribution (`sim.mjs --seeds 24`) and the curve is
   * tuned on the MEDIAN. As shipped, 24 seeds, reference player (3 clicks/s
   * tapering, catches 75% of Golden Petals), against GAME_DESIGN's table:
   *
   *   moment                          target    p10   median   p90   in band
   *   first Tender bought                20s     18s     18s    18s    24/24
   *   1e3 petals / first Codex card      90s     95s     95s    95s    24/24
   *   Bloom 2 初咲 First Bloom          480s    421s    548s   667s    21/24
   *   Bloom 3 満開 Full Bloom          2100s   1533s   1911s  2142s    22/24
   *   Season worth turning (25 Ess)    3600s   3264s   3706s  3937s    24/24
   *
   * As shipped WITH the first-storm grace (STORM_FIRST, below), 40 seeds:
   * 初咲 563s (30/40 in band), 満開 1824s (34/40), 25 Essence 3438s (40/40),
   * first Tender 18s and the first Codex card 95s both 40/40. Median score
   * 0.586. Longest gap between purchases inside the first 35 min: 67 s median,
   * 85 s p90, against the spec's 180 s ceiling.
   *
   * READ THIS BEFORE RE-TUNING. `sim.mjs` with no `--seeds` runs the one seed
   * `newState()` used to hand every player, and that seed is a p10 OUTLIER —
   * 初咲 312 s and 満開 1242 s, i.e. it reports FAIL on a curve whose median
   * passes. It also used to be the balance every real player got, because
   * 60-game.js called `newState()` with no argument: one hard-coded stream of
   * storm times and Golden Petal boons for everybody, and the fastest tenth of
   * the distribution at that. Fresh browser saves now roll their own seed
   * (shot mode keeps the fixed one so screenshots stay comparable), so the
   * median IS the player experience and `--seeds 40` is the honest instrument.
   *
   * Median score 0.517 without the storm grace, every mark inside the
   * 0.72×–1.35× band. The model is validated against the real module: with
   * `--policy scripted --catch 0` it reproduces 60-game.js driven live through
   * `.tmp-game/probe-live-pace.js` to within 8% at t = 60/150/300/450 s.
   *
   * Two residual biases — 初咲 +14%, 満開 −9% — are NOT worth chasing. Grid-
   * searched at 16 seeds each: cheaper tier-1 Tender upgrades (t1 ×0.7) scores
   * 0.471, stretched milestones (mspace ×1.3) 0.515, both together 0.469, all
   * against 0.509 for the shipping curve on the same seeds. Every candidate's
   * gain is smaller than the seed-to-seed noise, and each buys one mark by
   * losing another. The curve is at a local optimum; leave it.
   *
   * The curve is tuned FOR the reference player and degrades away from them,
   * which is inherent to a clicker with a spec'd ×7 buff in it:
   *   catch 0    stage2 749s  stage3 2370s  25 Essence never (in 75 min)
   *   catch 0.75 stage2 494s  stage3 1755s  25 Essence 3479s
   *   1 click/s  first Tender 36s  stage2 865s  stage3 2098s
   *   5 clicks/s first Tender 24s  stage2 350s  stage3 1641s
   * A player who never catches a Golden Petal runs ~1.4× slow. That is the
   * cost of the boon being worth catching, and it is the correct trade.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * 0.70, not 1.0, and the reason is measured: the earlier 1.0 was tuned by a
   * simulator that ran the economy in an EVENTLESS vacuum. The live game runs
   * Petal Storm (×10 for 20 s every 7 min ≈ +43% income), Golden Petal Frenzy
   * (×7 for 30 s, ~34% of catches ≈ +27%), Spring Rain, Golden Hour and Full
   * Moon crit continuously — together ≈ ×1.8 on income, and in a reinvestment
   * economy time-to-milestone goes as income^-1.67, so the whole first Season
   * ran 2.2–2.4× fast (満開 Full Bloom in 14.6 min against the ~35 min target).
   * 0.70 hands that back. Measured alternatives that CANNOT fix it, all in
   * .tmp-game/sim.mjs: upgrade prices alone saturate at 満開 = 1370 s (past ~×30
   * the player is cash-rich and the ladder, not income, is the constraint);
   * COST_GROWTH 1.15→1.22 reaches only 1113 s; halving the event cadence
   * (storm 25 min, Golden Petal 4.5–12 min) reaches only 1339 s and costs the
   * game its juice; CLICK_SCALE moves the first 3 minutes and nothing after.
   *
   * The visible cost of this dial: a Tender's card shows 0.70× the petals/s in
   * the GAME_DESIGN Tenders column (a lone Wind Sprite reads 0.07/s, not 0.10).
   * That column and the pacing table are not simultaneously satisfiable with the
   * spec'd events, and the spec calls the pacing table "the thing balance must
   * actually achieve", so pacing wins. Nothing in the rate MATH changed — every
   * baseCost, every per-second output and every bloom threshold is still the
   * literal spec value.
   */
  PROD_SCALE: 0.70,
  /**
   * Click scalar — multiplies clickValue and nothing else, so the opening
   * (click-dominated: the click:passive ratio is ~3 at t = 0 and ~0.1 by minute
   * ten) can be paced without touching passive income. Held at 1.0: measured in
   * .tmp-game/sim.mjs it has authority over the first three minutes only —
   * CLICK_SCALE 0.25 pushed "first Tender" from 18 s to 36 s and the first Codex
   * card from 95 s to 180 s while moving 満開 Full Bloom by 100 s out of 1755.
   * Kept as a dial because it is the ONLY one that can move the opening beats
   * without disturbing the rest of the curve.
   */
  CLICK_SCALE: 1.0,
};

/* ==================================================================== *
 * 3. Tenders  (GAME_DESIGN "Tenders")
 * ==================================================================== */

export const TENDERS = [
  {
    id: 'sprite', name: 'Wind Sprite', kanji: '風精', baseCost: 15, rate: 0.1,
    blurb: 'Too small to see, too loud to ignore. It shakes one branch at a time and is very proud of that.',
  },
  {
    id: 'gatherer', name: 'Petal Gatherer', kanji: '花摘み', baseCost: 100, rate: 1,
    blurb: 'Bare feet, wide basket, an eye for the ones that fell somewhere beautiful.',
  },
  {
    id: 'miko', name: 'Shrine Maiden', kanji: '巫女', baseCost: 1.1e3, rate: 8,
    blurb: 'She does not gather petals. She asks, politely, and they come.',
  },
  {
    id: 'lantern', name: 'Stone Lantern', kanji: '石灯籠', baseCost: 1.2e4, rate: 47,
    blurb: 'Petals drift toward light the way moths do. Nobody has told them they are not moths.',
  },
  {
    id: 'koi', name: 'Koi Spirit', kanji: '鯉霊', baseCost: 1.3e5, rate: 260,
    blurb: 'It swims the air above the pond and drinks the reflections of blossoms.',
  },
  {
    id: 'rabbit', name: 'Moon Rabbit', kanji: '月兎', baseCost: 1.4e6, rate: 1.4e3,
    blurb: 'Pounds petals in a stone mortar. Whatever it is making, it is not rice cake.',
  },
  {
    id: 'kitsune', name: 'Kitsune Herald', kanji: '狐使', baseCost: 2.0e7, rate: 7.8e3,
    blurb: 'Carries messages between the tree and something older. Never says which of them replies.',
  },
  {
    id: 'envoy', name: "Wind God's Envoy", kanji: '風神使', baseCost: 3.3e8, rate: 4.4e4,
    blurb: 'Arrives with a bag of unfinished weather and leaves the drawstring loose.',
  },
  {
    id: 'heart', name: 'Everblossom Heart', kanji: '常桜心', baseCost: 5.1e9, rate: 2.6e5,
    blurb: 'Buried where the roots cross. Every beat pushes one more spring through the wood.',
  },
  {
    id: 'bough', name: 'Celestial Bough', kanji: '天樹枝', baseCost: 7.5e10, rate: 1.6e6,
    blurb: 'A branch that grew past the sky, found more sky, and kept going out of politeness.',
  },
];

export const TENDER_BY_ID = Object.fromEntries(TENDERS.map((t) => [t.id, t]));
export const TENDER_IDS = TENDERS.map((t) => t.id);

/** cost(n) = baseCost * 1.15^n, n = number already owned. */
export function tenderCost(id, owned, costMul = 1) {
  const t = TENDER_BY_ID[id];
  if (!t) return Infinity;
  return t.baseCost * TUNING.COST_GROWTH ** owned * costMul;
}

/** Closed form for buying `count` in a row. */
export function tenderBulkCost(id, owned, count, costMul = 1) {
  const t = TENDER_BY_ID[id];
  if (!t || count <= 0) return 0;
  const g = TUNING.COST_GROWTH;
  return t.baseCost * costMul * g ** owned * (g ** count - 1) / (g - 1);
}

/** How many can be bought with `bank`. */
export function tenderMaxAffordable(id, owned, bank, costMul = 1) {
  const t = TENDER_BY_ID[id];
  if (!t) return 0;
  const g = TUNING.COST_GROWTH;
  const base = t.baseCost * costMul * g ** owned;
  if (bank < base) return 0;
  const n = Math.log(1 + (bank * (g - 1)) / base) / Math.log(g);
  return Math.max(0, Math.floor(n + 1e-9));
}

export const MILESTONES = [10, 25, 50, 100, 150, 200];

/** ×2 at each of 10/25/50/100/150/200 owned → ×64 at 200. */
export function milestoneMult(owned) {
  let m = 1;
  for (const k of MILESTONES) if (owned >= k) m *= 2;
  return m;
}

/** Next milestone count, or null when all six are banked. */
export function nextMilestone(owned) {
  for (const k of MILESTONES) if (owned < k) return k;
  return null;
}

/* ==================================================================== *
 * 4. Upgrades — three families, all authored, all with flavour
 * ==================================================================== */

/*  eff kinds:
 *    clickFlat  v          + flat petals per shake (before multipliers)
 *    clickMult  v          × click value
 *    crit       v          + crit chance (absolute)
 *    critMult   v          + crit multiplier
 *    tender     id, v      × that tender's output
 *    allTenders v          × every tender's output
 *    grove      key, v     grove utility flags/values
 */

/* The click ladder is deliberately shallow: `clickValue` already scales with the
 * whole economy through the (1 + 0.0002 · passiveRate) term, so the flat/mult
 * upgrades only have to carry the first few minutes and then stay out of the
 * way. Total end-state (1+flat)·mult ≈ 195, and crits multiply expected click
 * value by up to ×10 (×17 with the Moon branch). Because the passive term uses
 * the pre-seasonMult rate, the click:passive ratio is INDEPENDENT of prestige
 * depth — measured in .tmp-game/sim.mjs it sits near 0.5 through season 1 and
 * tops out near 3× only for a player who sustains 3 shakes/s with every click
 * and crit upgrade bought. */
const shakeUps = [
  ['shake_f1', 'Calloused Palms', 25, { clickFlat: 1 }, {},
    'Bark takes its toll. Then, quite suddenly, it stops taking anything at all.'],
  ['shake_m1', 'Practiced Rhythm', 90, { clickMult: 2 }, { clicks: 25 },
    'Not harder. On the beat. The tree very much prefers a beat.'],
  ['shake_f2', 'Two-Handed Shake', 300, { clickFlat: 2 }, { clicks: 60 },
    'You will need to put the tea down.'],
  ['shake_m2', 'Hanami Fervour', 1.8e3, { clickMult: 1.6 }, {},
    'Somebody starts singing. Everybody works faster. Nobody admits the two are related.'],
  ['shake_c1', 'Lucky Knot', 2.2e3, { crit: 0.04 }, { clicks: 150 },
    'Tied at the wrist by someone who meant it.'],
  ['shake_f3', 'Rooted Stance', 1.4e4, { clickFlat: 3 }, {},
    'Feet apart, weight low. The gardener watched you do it and said nothing, which is praise.'],
  ['shake_x1', 'Sharp Intent', 1.8e4, { critMult: 5 }, { crits: 10 },
    'The same shake, but you have decided something first.'],
  ['shake_m3', 'Breath Between Shakes', 9.0e4, { clickMult: 1.5 }, {},
    'The pause is the technique. The shake is only what the pause was for.'],
  ['shake_c2', "Fox's Wink", 1.4e5, { crit: 0.05 }, { crits: 40 },
    'Seen once, at dusk, at the edge of your eye. Your luck has been strange ever since.'],
  ['shake_f4', 'Weight of Winter', 6.0e5, { clickFlat: 5 }, {},
    'Every branch remembers the snow it carried. Remind it.'],
  ['shake_x2', 'Split-Second Bloom', 1.2e6, { critMult: 9 }, { crits: 200 },
    'For one frame the whole canopy opens at once. You have never seen it. It happens.'],
  ['shake_m4', 'The Long Draw', 3.0e6, { clickMult: 1.45 }, {},
    'Pull for four counts. Hold for one. The grove exhales on your behalf.'],
  ['shake_c3', 'Omikuji: Great Blessing', 4.0e7, { crit: 0.05 }, {},
    'You drew it fairly. You have checked the box twice. It was fair.'],
  ['shake_f5', 'Bough-Bender', 8.0e8, { clickFlat: 8 }, {},
    'The branch comes down to meet you now. It is no longer clear who is tending whom.'],
  ['shake_x3', 'Sakura Sever', 1.5e9, { critMult: 12 }, {},
    'A shake so clean the petals leave before the branch has finished moving.'],
  ['shake_m5', 'Hand of the Grove', 5.0e10, { clickMult: 1.4 }, {},
    'Somewhere in the last thousand springs, the grove started shaking back.'],
  ['shake_c4', 'Thousand-Fold Fortune', 2.0e11, { crit: 0.06 }, {},
    'Folded a thousand paper cranes. Kept one. Burned the rest. It worked.'],
  ['shake_c5', 'The Whole Sky Agrees', 2.0e14, { crit: 0.07 }, {},
    'Every omen in the valley is pointing the same way and none of them will say why.'],
];

const tenderUpNames = {
  sprite: [
    ['Whistling Lessons', 'Teach them to whistle. They work faster when they can hear each other.'],
    ['Paper Charms', "A slip of paper, a name written twice, and suddenly they can't wander off."],
    ['Sprite Choir', 'Forty voices, one gust. The hillside leans politely away.'],
    ['Names for the Wind', 'Give a wind a name and it comes back. Give it two and it never leaves.'],
  ],
  gatherer: [
    ['Wider Baskets', 'Twice the weave, half the trips, the same humming.'],
    ['Dawn Shift', 'They start before the mist lifts. Nobody asked them to.'],
    ['Guild of the Fallen Bloom', "They have a crest now. It's a petal. Of course it is."],
    ['Ten Thousand Sleeves', 'Every sleeve a pocket, every pocket a spring.'],
  ],
  miko: [
    ['Purified Bells', 'Rust dulls a bell, and a dull bell dulls a prayer.'],
    ['The Longer Dance', 'Nine turns instead of five. The tree noticed on the seventh.'],
    ['Kagura at Midnight', 'Danced for no audience but the branches. They applauded.'],
    ['Rite of the Standing Tree', 'The oldest rite in the valley: stand still, and mean it.'],
  ],
  lantern: [
    ['Trimmed Wicks', 'A clean flame gathers more than a bright one.'],
    ['Lacquered Caps', 'The rain no longer has an opinion.'],
    ['The Lit Path', 'Light the first and the rest light themselves. Nobody has explained this.'],
    ['Ever-Burning Oil', 'Pressed from petals. It smells like a year you were happy.'],
  ],
  koi: [
    ['Deeper Pool', 'Give a spirit room and it will grow into exactly that much room.'],
    ['Moonlit Feeding', 'They eat reflections. Feed them a full moon and watch.'],
    ['Upstream Vow', 'Every koi is swimming toward something. Point them at the tree.'],
    ["Dragon's Half-Step", 'One scale has turned gold. Only one. So far.'],
  ],
  rabbit: [
    ['Heavier Mallets', 'Pounding rice, pounding petals — the rhythm is identical.'],
    ['Lunar Mortar', "Carved from the crater's rim. Cold enough to sting through gloves."],
    ['The Eight-Day Week', 'They added a day. The moon allowed it.'],
    ['Elixir Shares', 'Immortality, distributed evenly. Morale improved dramatically.'],
  ],
  kitsune: [
    ['Second Tail', 'Each tail is a promise kept. Do ask what the first one was for.'],
    ['Foxfire Lanterns', 'Blue light, no heat, no shadow. Very efficient. Deeply unsettling.'],
    ['The Borrowed Face', 'It wears your face while it works. Output doubles. Do not watch.'],
    ['Nine and Counting', 'The ninth tail is the one that does the arithmetic.'],
  ],
  envoy: [
    ['Sealed Orders', 'Delivered on paper that has never once got wet.'],
    ['The Storm Satchel', 'Carries one typhoon, folded small, corners tucked in.'],
    ['Right of Way', 'All other winds must yield. Astonishingly, they do.'],
    ["Fūjin's Seal", 'The bag is open a finger-width now. Only a finger.'],
  ],
  heart: [
    ['Slower Beat', 'Fewer beats, deeper ones. The whole grove keeps that time.'],
    ['Grafted Chambers', 'Four became eight. The tree did this by itself, overnight.'],
    ['Blood of Spring', 'Sap, mostly. Mostly.'],
    ['The Undying Systole', 'It will still be beating when these hills are sand.'],
  ],
  bough: [
    ['Star-Grafting', 'A branch, a constellation, and a very steady hand.'],
    ['Orbit Pruning', 'Cut back the dead worlds. New ones bud by morning.'],
    ['The Long Branch', 'It reaches past the sky, finds more sky, and carries on.'],
    ['Root of Heaven', 'Down is only a direction. The bough disagreed with it.'],
  ],
};

/**
 * Per-Tender ×2 upgrades, unlocked at owned 1 / 5 / 25 / 50. Cost is
 * `baseCost × COSTF[tier]`.
 *
 * MEASURED against the pacing table in .tmp-game/sim.mjs (with live events on —
 * see PROD_SCALE). Tier 1 is the single most pacing-sensitive price in the game:
 * it is a ×2 on a whole Tender line, unlocked at owned = 1, so a payback-greedy
 * player buys it on every line the instant it appears. At the old 6× baseCost it
 * paid itself back in seconds and by itself pulled 満開 Full Bloom in by 26%
 * (sweep: t1 ×2 → 973 s, ×8 → 1060 s, ×16 → 1752 s, ×32 → 1864 s, everything
 * else held). 96× baseCost is the measured landing.
 *
 * Tiers 2–4 are deliberately NOT re-priced: the same sweep moved 満開 by under
 * 1% across ×1…×8 on them, because their gates (owned 5 / 25 / 50) arrive when
 * the player has better things to buy. Raising a price that buys no pacing only
 * kills content, so they keep the values the eventless round measured.
 *
 * Read literally, GAME_DESIGN's "10–25× the current cost of the thing it
 * improves" wants ≈12× / 25× / 500× / 16000× baseCost. Tier 1 at 96× is above
 * that band and knowingly so — that rule is a rule of thumb ("roughly"), the
 * pacing table is the spec.
 */
const TENDER_UP_GATES = [1, 5, 25, 50];
const TENDER_UP_COSTF = [96, 900, 30000, 900000];

const tenderUps = [];
for (const t of TENDERS) {
  for (let i = 0; i < 4; i++) {
    const [name, flavour] = tenderUpNames[t.id][i];
    tenderUps.push([
      `up_${t.id}_${i + 1}`, name,
      Math.round(t.baseCost * TENDER_UP_COSTF[i]),
      { tender: t.id, v: 2 },
      { tenderOwned: [t.id, TENDER_UP_GATES[i]] },
      flavour,
    ]);
  }
}

/* A ×1.5 on EVERY Tender at once is the single most powerful thing money can
 * buy, and it used to be the cheapest. `all_1` at 2.0e4 paid itself back in 30
 * seconds of income; measured in .tmp-game/sim.mjs that one price was pulling
 * 満開 Full Bloom (1e7) forward from the spec's ~35 min to 25 min, and the first
 * Season with it. Lifted ×50 to a ~6-minute payback, which also regularises the
 * ladder to a clean ~60× per rung (it used to widen from 60× to 167×). Only
 * all_1 / all_2 are inside the measured 75-minute window; the upper four are
 * priced to keep the ladder's shape and were checked against a 4-hour run.
 *
 * 2026-07-29, events-on re-measure: ×4 on all_1 / all_2 only. Those two are the
 * ones inside the first Season, and the raise is worth +264 s on "the Season is
 * worth turning" (3215 → 3479 s against a 3600 s target) while costing nothing
 * early — all_1's gate is 15 Tenders, which the reference player reaches around
 * minute 6.
 *
 * all_3…all_6 were raised ×4 too and then put back, because a 4-hour run
 * (ESS=164, i.e. a third Season) measured the cost: the last 40 minutes went
 * flat — rate pinned at 7.955B/s, 438T of bank with nothing left inside a
 * 50-minute payback, doubling time out past 16000 s. At the original prices the
 * same run keeps climbing (54/78 upgrades instead of 51, 629 → 674 Tenders,
 * 1.49× the Essence at the four-hour mark) and the 110-minute marks do not move
 * by a single second. Pricing the late ladder out of reach does not slow the
 * player down, it just gives them nothing to do. */
const globalUps = [
  ['all_1', 'A Word of Thanks', 4.0e6, 15, 'Said once, at dusk, to everyone at the same time.'],
  ['all_2', 'Shared Kettle', 2.4e8, 40, 'Nobody in the history of groves has ever worked well cold.'],
  ['all_3', 'The Rota', 3.5e9, 75, 'Written on the wall in a neat hand. Everyone obeys it. Nobody wrote it.'],
  ['all_4', 'Festival Wages', 2.5e11, 120, 'Paid in petals, spent on nothing, saved with enormous care.'],
  ['all_5', 'One Purpose', 1.5e13, 180, 'Ask any of them what they are doing. You will get the same answer.'],
  ['all_6', 'The Grove Remembers', 1.0e15, 260, 'It knows every name that has ever worked here, including yours.'],
].map(([id, name, cost, gate, flavour]) => [
  id, name, cost, { allTenders: 1.5 }, { totalTenders: gate }, flavour,
]);

const groveUps = [
  ['grove_bulk', 'Abacus of the Grove', 6.0e4, { grove: 'bulk', v: 1 }, { totalTenders: 12 },
    'Beads worn smooth. Buy in tens, in hundreds, in as-many-as-you-can-carry.'],
  ['grove_magnet', 'Petal Magnet', 2.0e5, { grove: 'magnet', v: 2 }, {},
    'A lodestone wrapped in red thread. Petals lean toward it like they have been asked nicely.'],
  ['grove_auto1', 'Idle Hands', 3.5e5, { grove: 'auto', v: 3 }, { clicks: 300 },
    'A rope, a counterweight, and one branch that has agreed to be shaken every few seconds.'],
  ['grove_gold1', 'Gilded Eye', 8.0e5, { grove: 'goldRate', v: 0.75 }, {},
    'You start noticing the gold ones sooner. They start arriving sooner. Cause unclear.'],
  ['grove_dew1', 'Dew Reservoir', 1.6e6, { grove: 'dewH', v: 6 }, {},
    'A stone basin under the roots. It keeps the hours you were not here.'],
  ['grove_storm1', 'Storm Glass', 8.0e6, { grove: 'stormDur', v: 1.5 }, { storms: 1 },
    'Crystals climb the glass an hour before the wind turns. You have learned to trust it.'],
  ['grove_gold2', 'Slow Gold', 2.4e7, { grove: 'goldTtl', v: 1.6 }, { golden: 2 },
    'The golden one drifts as if the air were syrup. Take your time. Not too much time.'],
  ['grove_off1', 'Sleeping Roots', 1.1e8, { grove: 'offRate', v: 0.70 }, {},
    'The grove works while you sleep. Slightly resentfully, but it works.'],
  ['grove_auto2', 'Restless Hands', 4.0e8, { grove: 'auto', v: 1 }, {},
    'The rope now runs over a wheel, and the wheel is never still.'],
  ['grove_dew2', 'Cistern of Quiet Hours', 2.0e9, { grove: 'dewH', v: 12 }, {},
    'Deeper than the well, colder than the pond, and it never once spilled.'],
  ['grove_gold3', "Fortune's Draft", 3.0e10, { grove: 'goldRate', v: 0.7 }, { golden: 8 },
    'A draught of wind that only ever carries one thing, and always carries it to you.'],
  ['grove_storm2', 'Eye of the Squall', 4.0e11, { grove: 'stormMult', v: 16 }, { storms: 6 },
    'Stand in the middle of it. Nothing moves. Everything else does.'],
  ['grove_dew3', "The Whole Night's Water", 8.0e12, { grove: 'dewH', v: 24 }, {},
    'A full turn of the world, held in a bowl, waiting for you to come back.'],
  ['grove_auto3', 'The Grove Shakes Itself', 2.0e14, { grove: 'autoFull', v: 1 }, {},
    'You may put your hands in your sleeves now. It has this.'],
];

function mkUpgrade(family, row) {
  const [id, name, cost, eff, req, flavour] = row;
  return { id, family, name, cost, eff, req: req || {}, flavour };
}

export const UPGRADES = [
  ...shakeUps.map((r) => mkUpgrade('shake', r)),
  ...tenderUps.map((r) => mkUpgrade('tender', r)),
  ...globalUps.map((r) => mkUpgrade('tender', r)),
  ...groveUps.map((r) => mkUpgrade('grove', r)),
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

/** Is this upgrade's unlock condition met? (Cost is checked separately.) */
export function upgradeUnlocked(u, state) {
  const r = u.req || {};
  const st = state.stats || {};
  if (r.clicks && (st.clicks || 0) < r.clicks) return false;
  if (r.crits && (st.crits || 0) < r.crits) return false;
  if (r.storms && (st.storms || 0) < r.storms) return false;
  if (r.golden && (st.golden || 0) < r.golden) return false;
  if (r.tenderOwned) {
    const [tid, n] = r.tenderOwned;
    if ((state.tenders?.[tid] || 0) < n) return false;
  }
  if (r.totalTenders) {
    let tot = 0;
    for (const id of TENDER_IDS) tot += state.tenders?.[id] || 0;
    if (tot < r.totalTenders) return false;
  }
  return true;
}

/* ==================================================================== *
 * 5. Heartwood — the permanent Blossom shop (Blossoms never reset)
 * ==================================================================== */

export const HEARTWOOD = [
  ['hw_prod1', 'Heartwood Ring', 3, { prod: 1.10 },
    'One more ring than the tree should have for its age. It counts double.'],
  ['hw_click1', 'Palmprint in the Bark', 5, { click: 1.25 },
    'Worn into the trunk at exactly your height. It was there before you were.'],
  ['hw_start1', 'Seedbed', 8, { startTender: ['sprite', 20] },
    'Twenty sprites are already awake when the Season turns. They remember you.'],
  ['hw_prod2', 'Deep Taproot', 14, { prod: 1.20 },
    'It has found water that has not seen the sky since the mountains were young.'],
  ['hw_crit1', 'Windfall Charm', 20, { crit: 0.05, critMult: 6 },
    'Hung from the lowest branch. It swings when there is no wind.'],
  ['hw_off1', 'Nightwatch Lantern', 28, { offRate: 0.12, dewH: 4 },
    'Left burning at the gate so the grove knows you intend to come back.'],
  ['hw_prod3', 'Crown of Years', 40, { prod: 1.35 },
    'Every Season you turn adds a leaf. It is getting heavy in a good way.'],
  ['hw_ess1', 'Essence Still', 60, { essence: 1.25 },
    'Distils the last of a Season into something you can carry to the next one.'],
];
export const HEARTWOOD_BY_ID = Object.fromEntries(HEARTWOOD.map((h) => [h[0], {
  id: h[0], name: h[1], cost: h[2], eff: h[3], flavour: h[4],
}]));
export const HEARTWOOD_LIST = HEARTWOOD.map((h) => HEARTWOOD_BY_ID[h[0]]);

/* ==================================================================== *
 * 6. Bloom stages
 * ==================================================================== */

export const BLOOM_STAGES = [
  { stage: 0, name: 'Winter Bud', kanji: '冬芽', threshold: 0, blurb: 'Bare dark branches, a handful of buds, and light with no warmth in it.' },
  { stage: 1, name: 'Budding', kanji: '蕾', threshold: 1e3, blurb: 'The buds swell pink overnight. The first blossoms open where nobody is looking.' },
  { stage: 2, name: 'First Bloom', kanji: '初咲', threshold: 1e5, blurb: 'A third of the canopy has turned. Petals begin to fall in ones and twos.' },
  { stage: 3, name: 'Full Bloom', kanji: '満開', threshold: 1e7, blurb: 'Full canopy, constant fall, a carpet on the path. This is what people walk here for.' },
  { stage: 4, name: 'Radiant', kanji: '輝咲', threshold: 1e10, blurb: 'The petals hold light after dusk. Motes drift up as often as down.' },
  { stage: 5, name: 'Everblossom', kanji: '常桜', threshold: 1e13, blurb: 'Gold runs in the bark. The blossom no longer waits for spring, and neither does anything near it.' },
];

/**
 * The stage a save opens on before it has earned anything.
 *
 * ART CALL (settled): a fresh save opens at 1 蕾 Budding, never at 0 冬芽 Winter
 * Bud. Frame one has to read as a sakura game — pink buds and the first
 * scattered blossoms — so stage 0's bare branches are the POST-SEASON reset
 * look only. The growth arc is untouched; we just never open on a dead tree.
 */
export const FIRST_RUN_STAGE = 1;
/** After a Season turn the tree really does go back to bare wood. */
export const POST_PRESTIGE_STAGE = 0;
/**
 * Blossoms owed for the stages the first-run floor hands out for free.
 * A stage-up pays `stageIndex × 3` Blossoms (GAME_DESIGN "Bloom stages"), so a
 * player who climbs 0 → 1 collects 3. Opening AT stage 1 must not silently eat
 * that, or a first-run save would be permanently 3 Blossoms behind a
 * post-prestige one. Paid up front in newState(); it also means the Heartwood
 * panel has exactly one affordable line on the very first screen, which is the
 * "meaningful decision every ~40 s early on" the design asks for.
 */
export const FIRST_RUN_BLOSSOMS = 3;

/**
 * Stage index for a season total, honouring the Constellation threshold
 * discount and the save's `stageFloor`.
 *
 * `floor` is authoritative: it is the reason a new player cannot be snapped
 * back to bare branches by a stage recompute. Never derive a stage without it —
 * 60-game.js always passes `state.stageFloor`.
 */
export function stageFor(totalThisSeason, thresholdMul = 1, floor = 0) {
  let s = 0;
  for (let i = BLOOM_STAGES.length - 1; i >= 0; i--) {
    if (totalThisSeason >= BLOOM_STAGES[i].threshold * thresholdMul) { s = i; break; }
  }
  const f = Math.min(5, Math.max(0, Math.floor(floor || 0)));
  return s < f ? f : s;
}

/* ==================================================================== *
 * 7. Seasons + Constellation
 * ==================================================================== */

/** essenceGain = floor((totalThisSeason / 1e6) ** 0.55) */
export function essenceGain(totalThisSeason, essenceMul = 1) {
  if (totalThisSeason < TUNING.PRESTIGE_MIN) return 0;
  return Math.floor((totalThisSeason / TUNING.PRESTIGE_MIN) ** TUNING.ESSENCE_EXP * essenceMul);
}

/* Five branches × six nodes. `a` = branch angle (deg), `r` = radial 0..1 —
 * the UI lays these out as a radial talent tree over a night sky. */
const BRANCHES = [
  { id: 'wind', name: 'Wind', kanji: '風', a: -90, color: '#BBD6E8' },
  { id: 'water', name: 'Water', kanji: '水', a: -18, color: '#8FC4D8' },
  { id: 'moon', name: 'Moon', kanji: '月', a: 54, color: '#C9C2E8' },
  { id: 'stone', name: 'Stone', kanji: '石', a: 126, color: '#CFC6B4' },
  { id: 'blossom', name: 'Blossom', kanji: '花', a: 198, color: '#FFB6CE' },
];
export const CONSTELLATION_BRANCHES = BRANCHES;

const NODE_ROWS = {
  wind: [
    ['First Breath', 1, { passive: 1.08 }, 'The grove takes one breath a day. Be there for it.'],
    ['Gustling', 3, { stormDur: 1.5 }, 'A small wind that has decided to become weather.'],
    ['Following Wind', 8, { startTender: ['sprite', 15] }, 'Fifteen sprites are waiting at the gate when the Season turns.'],
    ['Squall', 20, { stormMult: 16 }, 'Ten was a storm. Sixteen is an argument.'],
    ['Typhoon Heart', 50, { passive: 1.25 }, 'There is a stillness at the centre of it that produces everything.'],
    ['The Long Exhale', 120, { stormRate: 0.5 }, 'Storms come twice as often now. The grove has stopped holding its breath.'],
  ],
  water: [
    ['Still Pond', 1, { offRate: 0.10 }, 'Nothing moves on it. Everything under it does.'],
    ['Deep Well', 4, { dewH: 4 }, 'Four more hours of you being elsewhere, kept cold and safe.'],
    ['Spring Rain', 10, { rainChance: 2, rainPassive: 0.20 }, 'It falls straight down, and the petals take their time coming with it.'],
    ['Tide Memory', 24, { offRate: 0.10 }, 'Water remembers where it has been. So does the grove.'],
    ['Reservoir of Ages', 60, { dewH: 12 }, 'Half a day, held in stone, waiting without complaint.'],
    ['Everflow', 120, { offFull: 1 }, 'Away or here, the grove works at full strength. It stopped noticing the difference.'],
  ],
  moon: [
    ['Moonwake', 1, { crit: 0.03 }, 'Work by moonlight long enough and your hands learn where the good branches are.'],
    ['Silver Edge', 5, { critMult: 3 }, 'A shake with an edge on it.'],
    ["Hare's Luck", 12, { goldRate: 0.75 }, 'The golden one comes round sooner. It has always been coming round.'],
    ['Full Moon Rite', 28, { moonCrit: 0.45 }, 'Once a month the whole valley agrees to be lucky.'],
    ['Tidefall', 65, { crit: 0.08 }, 'Fortune arrives the way water does: all at once, from underneath.'],
    ['Lunar Mirror', 120, { goldDouble: 1 }, 'Catch one golden petal and its reflection grants a second boon.'],
  ],
  stone: [
    ['Set Stone', 2, { cost: 0.98 }, 'Laid true the first time. Everything after it is cheaper to build.'],
    ['Dry Wall', 6, { cost: 0.97 }, 'No mortar. It has stood for four hundred years out of sheer stubbornness.'],
    ['Old Path', 14, { startTender: ['gatherer', 10] }, 'Ten gatherers already walking it when the Season turns.'],
    ['Mason’s Ledger', 30, { upCost: 0.85 }, 'Every improvement, priced honestly, then discounted anyway.'],
    ['Foundation Rite', 70, { cost: 0.95 }, 'Bury a coin, a petal, and a promise. Costs fall. Nobody asks why.'],
    ['Bedrock', 120, { keepFirstTierUps: 1 }, 'The first improvement to each Tender survives the turning of the Season.'],
  ],
  blossom: [
    ['Open Hand', 1, { click: 1.20 }, 'You stopped grabbing at the branch and started asking it.'],
    ['Sympathetic Bloom', 4, { clickPassiveTerm: 0.0003 }, 'The bigger the grove grows, the more one shake is worth.'],
    ['Second Hand', 11, { doubleShake: 0.25 }, 'One shake in four lands twice. You have stopped trying to see how.'],
    ['Hastened Spring', 26, { bloomThreshold: 0.8 }, 'The tree stops waiting for permission to open.'],
    ['Blossomheart', 60, { click: 2 }, 'Your hand on the bark and the tree’s pulse in your wrist, matched.'],
    ['Everblossom Seed', 120, { prod: 1.5 }, 'Planted in the season you first turned. It has been paying for itself ever since.'],
  ],
};

export const CONSTELLATION = [];
for (const b of BRANCHES) {
  const rows = NODE_ROWS[b.id];
  rows.forEach((row, i) => {
    const [name, cost, eff, flavour] = row;
    // Gentle zig-zag so the constellation reads as stars, not spokes.
    const spread = [0, -9, 8, -6, 7, 0][i];
    CONSTELLATION.push({
      id: `${b.id}${i + 1}`,
      branch: b.id,
      branchName: b.name,
      kanji: b.kanji,
      color: b.color,
      tier: i,
      name, cost, eff, flavour,
      req: i === 0 ? null : `${b.id}${i}`,
      a: b.a + spread,
      r: 0.17 + i * 0.166,
    });
  });
}
export const NODE_BY_ID = Object.fromEntries(CONSTELLATION.map((n) => [n.id, n]));

/* ==================================================================== *
 * 8. Codex — 12 varieties
 * ==================================================================== */

export const CODEX = [
  /* Gated on the 1e3 petal mark, NOT `{stage:1}`: with the first-run Budding
   * floor every save is already stage 1, so a stage gate would hand this card
   * out on frame one, silently, during the quiet boot unlock pass. The petal
   * mark is the same moment the old stage-1 threshold described (~90 s) and it
   * gives that beat something to show now that the tree is already budded. */
  ['somei', 'Somei Yoshino', '染井吉野', 3, '#FFD9E6', { passive: 1.02 },
    { seasonTotal: 1e3 }, 'Five pale petals, almost white at the edge. Every avenue in the country is planted with clones of one tree, and every spring they all agree on the same day.'],
  ['shidare', 'Shidarezakura', '枝垂桜', 3, '#FFC6DC', { click: 1.03 },
    { tenderOwned: ['sprite', 25] }, 'The weeping cherry. Branches fall like water and blossom on the way down; the oldest in the north has been leaning for a thousand years.'],
  ['yae', 'Yaezakura', '八重桜', 3, '#FFB6CE', { passive: 1.03 },
    { tenderOwned: ['miko', 10] }, 'Layered — twenty, thirty, sometimes a hundred petals to a flower. Heavy enough that the branch nods. Blooms late, as if it needed the extra time.'],
  ['yama', 'Yamazakura', '山桜', 3, '#F6D3D8', { passive: 1.03 },
    { seasonTotal: 1e6 }, 'The mountain cherry, and the one the old poems mean. Copper leaves open with the flowers, so the whole hillside turns two colours at once.'],
  ['oshima', 'Oshima-zakura', '大島桜', 4, '#FFF2F6', { click: 1.04 },
    { clicks: 1000 }, 'White, broad-petalled, and faintly sweet. Its leaves are salted and wrapped around bean cakes; half the country tastes this tree every spring without seeing it.'],
  ['kawazu', 'Kawazu-zakura', '河津桜', 4, '#F79EBD', { click: 1.04 },
    { golden: 3 }, 'Deep rose, and impatient — it opens in February while the rest are still asleep, then holds the flower for a month as if daring the frost.'],
  ['ukon', 'Ukon', '鬱金桜', 4, '#E7E2B0', { passive: 1.04 },
    { storms: 3 }, 'Pale yellow-green, the colour of turmeric-dyed silk. Fades to pink at the centre as it ages, which is the wrong direction for a flower and it does not care.'],
  ['gyoiko', 'Gyoiko', '御衣黄', 4, '#C8D8A8', { passive: 1.05 },
    { stage: 3 }, 'Green. Genuinely green, with red streaks running up each petal. Named for the robes of the court, because nothing else was allowed to be that colour.'],
  ['jugatsu', 'Jugatsu-zakura', '十月桜', 4, '#FFE1EA', { click: 1.05 },
    { seasons: 1 }, 'Blooms twice: a scattering in October, the rest in spring. It has never explained the arrangement and nobody has managed to talk it out of it.'],
  ['fuyu', 'Fuyuzakura', '冬桜', 5, '#EAF0FF', { prod: 1.04 },
    { offlineH: 3 }, 'The winter cherry. Small, sparse, and flowering into the snow — proof that the grove keeps working during the hours you are not in it.'],
  ['yoko', 'Yoko', '陽光桜', 5, '#FF9FBE', { prod: 1.05 },
    { crits: 100 }, 'Bred after a war by a schoolteacher who wanted something that would grow anywhere, in memory of students who did not come home. Vivid pink, hardy, everywhere now.'],
  ['everblossom', 'Everblossom', '常桜', 5, '#FFEFC2', { prod: 1.25 },
    { stage: 5 }, 'Not in any botanical register. Gold in the grain, aurora in the fall, and no dormant season at all. You have been growing it this whole time.'],
].map(([id, name, kanji, rarity, tint, eff, req, desc]) => ({
  id, name, kanji, rarity, tint, eff, req, desc,
}));
export const CODEX_BY_ID = Object.fromEntries(CODEX.map((c) => [c.id, c]));

/* ==================================================================== *
 * 9. Achievements — 44, each +1% global production and +1 Blossom
 * ==================================================================== */

const ach = (id, name, desc, req) => ({ id, name, desc, req });

export const ACHIEVEMENTS = [
  // — clicking (6)
  ach('a_click1', 'First Shake', 'Shake the tree once.', { clicks: 1 }),
  ach('a_click2', 'Hanami Habit', 'Shake the tree 100 times.', { clicks: 100 }),
  ach('a_click3', 'Repetitive Strain', 'Shake the tree 1,000 times.', { clicks: 1000 }),
  ach('a_click4', 'The Gardener’s Wrist', 'Shake the tree 10,000 times.', { clicks: 1e4 }),
  ach('a_click5', 'Bark Polisher', 'Shake the tree 100,000 times.', { clicks: 1e5 }),
  ach('a_click6', 'One With The Branch', 'Shake the tree a million times.', { clicks: 1e6 }),
  // — crits (2)
  ach('a_crit1', 'Lucky Break', 'Land 100 critical shakes.', { crits: 100 }),
  ach('a_crit2', 'Fortune Favours', 'Land 5,000 critical shakes.', { crits: 5000 }),
  // — petals earned (7)
  ach('a_pet1', 'A Thousand Petals', 'Earn 1,000 petals in a Season.', { seasonTotal: 1e3 }),
  ach('a_pet2', 'Drift', 'Earn 100,000 petals in a Season.', { seasonTotal: 1e5 }),
  ach('a_pet3', 'Snowfall in Spring', 'Earn 1 million petals in a Season.', { seasonTotal: 1e6 }),
  ach('a_pet4', 'Petal Sea', 'Earn 100 million petals in a Season.', { seasonTotal: 1e8 }),
  ach('a_pet5', 'The Pink Tide', 'Earn 10 billion petals in a Season.', { seasonTotal: 1e10 }),
  ach('a_pet6', 'Weather System', 'Earn 1 trillion petals all-time.', { allTime: 1e12 }),
  ach('a_pet7', 'Cosmic Fall', 'Earn 1 quadrillion petals all-time.', { allTime: 1e15 }),
  // — tenders owned, total (6)
  ach('a_ten1', 'A Helping Hand', 'Own 10 Tenders.', { totalTenders: 10 }),
  ach('a_ten2', 'Small Staff', 'Own 50 Tenders.', { totalTenders: 50 }),
  ach('a_ten3', 'The Grove Employs', 'Own 100 Tenders.', { totalTenders: 100 }),
  ach('a_ten4', 'Full Roster', 'Own 200 Tenders.', { totalTenders: 200 }),
  ach('a_ten5', 'Standing Army of Spring', 'Own 400 Tenders.', { totalTenders: 400 }),
  ach('a_ten6', 'Everyone Is Here', 'Own at least one of every Tender.', { oneOfEach: 1 }),
  // — specific tenders (5)
  ach('a_sp1', 'Swarm', 'Own 100 Wind Sprites.', { tenderOwned: ['sprite', 100] }),
  ach('a_sp2', 'Basket Economy', 'Own 100 Petal Gatherers.', { tenderOwned: ['gatherer', 100] }),
  ach('a_sp3', 'Lit From Below', 'Own 50 Stone Lanterns.', { tenderOwned: ['lantern', 50] }),
  ach('a_sp4', 'Nine Tails Each', 'Own 25 Kitsune Heralds.', { tenderOwned: ['kitsune', 25] }),
  ach('a_sp5', 'Reaching', 'Own 10 Celestial Boughs.', { tenderOwned: ['bough', 10] }),
  // — milestones (2)
  ach('a_mil1', 'Round Number', 'Take any Tender to 10 owned.', { anyMilestone: 10 }),
  ach('a_mil2', 'Sixty-Four Times', 'Take any Tender to 200 owned.', { anyMilestone: 200 }),
  // — upgrades (3)
  ach('a_up1', 'Improvements', 'Buy 10 Upgrades.', { upgrades: 10 }),
  ach('a_up2', 'Renovation', 'Buy 40 Upgrades.', { upgrades: 40 }),
  ach('a_up3', 'Nothing Left To Fix', 'Buy 70 Upgrades.', { upgrades: 70 }),
  // — bloom stages (2)
  ach('a_bl1', 'Full Bloom', 'Reach 満開 Full Bloom.', { stage: 3 }),
  ach('a_bl2', 'Everblossom', 'Reach 常桜 Everblossom.', { stage: 5 }),
  // — seasons (4)
  ach('a_se1', 'Turn of the Season', 'Turn the Season once.', { seasons: 1 }),
  ach('a_se2', 'Three Springs', 'Turn the Season 3 times.', { seasons: 3 }),
  ach('a_se3', 'Decade of Blossom', 'Turn the Season 10 times.', { seasons: 10 }),
  ach('a_se4', 'The Long Cycle', 'Turn the Season 25 times.', { seasons: 25 }),
  // — golden petals / storms / varieties (6)
  ach('a_go1', 'Caught One', 'Catch a Golden Petal.', { golden: 1 }),
  ach('a_go2', 'Sharp Eyes', 'Catch 10 Golden Petals.', { golden: 10 }),
  ach('a_go3', 'Nothing Escapes You', 'Catch 50 Golden Petals.', { golden: 50 }),
  ach('a_st1', 'Rode the Storm', 'Live through a Petal Storm.', { storms: 1 }),
  ach('a_st2', 'Storm Season', 'Live through 10 Petal Storms.', { storms: 10 }),
  ach('a_cx1', 'Botanist', 'Record 6 varieties in the Codex.', { codex: 6 }),
  // — secret / joke (5)
  ach('a_sx1', 'Patience', 'Let five whole minutes pass without shaking the tree.', { idle: 300 }, true),
  ach('a_sx2', 'The Long Way Home', 'Return after more than twelve hours away.', { offlineH: 12 }, true),
  ach('a_sx3', 'Frugal', 'Reach a million petals in a Season having bought fewer than 8 Upgrades.', { frugal: 1 }, true),
  ach('a_sx4', 'Insomnia', 'Be in the grove at night.', { night: 1 }, true),
  ach('a_sx5', 'Ninety-Nine', 'Hold exactly 99 of a single Tender. On purpose.', { tenderExact: 99 }, true),
].map((a, i) => ({ ...a, secret: a.id.startsWith('a_sx'), index: i }));

/* ==================================================================== *
 * 10. Live events + Golden Petal boons
 * ==================================================================== */

export const LIVE_EVENTS = {
  storm: { id: 'storm', name: 'Petal Storm', kanji: '花嵐', color: '#FFC2D6', desc: '×10 petals per second. The whole hillside is in the air.' },
  moon: { id: 'moon', name: 'Full Moon', kanji: '満月', color: '#C9D6FF', desc: '+25% critical chance while the moon is up.' },
  golden: { id: 'golden', name: 'Golden Hour', kanji: '黄金時', color: '#FFD08A', desc: '+15% to every shake while the light holds.' },
  rain: { id: 'rain', name: 'Spring Rain', kanji: '春雨', color: '#A8C8E0', desc: '+10% petals per second, and the fall slows to a drift.' },
};

export const GOLDEN_BOONS = [
  { id: 'frenzy', name: 'Frenzy', kanji: '狂咲', weight: 34, dur: 30, color: '#FFD46A',
    desc: '×7 petals per second for 30 seconds.' },
  { id: 'lucky', name: 'Lucky', kanji: '幸', weight: 34, dur: 0, color: '#FFE9A8',
    desc: '+13% of your bank, instantly.' },
  { id: 'clickfrenzy', name: 'Click Frenzy', kanji: '乱打', weight: 20, dur: 13, color: '#FFC0D8',
    desc: '×77 per shake for 13 seconds.' },
  { id: 'bloomfall', name: 'Bloomfall', kanji: '花降', weight: 12, dur: 6, color: '#FFF0C8',
    desc: 'A minute of petals, all at once, falling where you can catch them.' },
];

/* ==================================================================== *
 * 11. State: creation, sanitising, migration
 * ==================================================================== */

export const SAVE_KEY = 'sakura.save.v1';
/**
 * v3 added `stageFloor` (the first-run Budding floor).
 * v4 added `sched` — the live-event countdowns (see below).
 */
export const SAVE_VERSION = 4;

/**
 * Live-event schedule, persisted.
 *
 * It used to live only in module-scope variables, which meant every page load
 * re-rolled `nextStorm` from a full 420 ± 120 s. A player who reloads, or who
 * plays in short sessions — exactly the audience for an idle game — could
 * therefore never see a Petal Storm at all, and never unlock the two pieces of
 * content gated behind `storms: 1`. Persisting the countdowns makes the storm
 * clock a property of the SAVE rather than of the tab.
 *
 * `null` means "not written yet — roll a fresh one", which is what every v1–v3
 * save and every fresh state gets.
 */
export function newSchedule() {
  return { storm: null, golden: null, rain: 0 };
}

export function newState(seed = 20260728) {
  const tenders = {};
  for (const id of TENDER_IDS) tenders[id] = 0;
  return {
    v: SAVE_VERSION,
    seed,
    petals: 0,
    blossoms: FIRST_RUN_BLOSSOMS,       // the 蕾 Budding grant the floor gave away
    essence: 0,
    essenceEarned: 0,
    totalThisSeason: 0,
    totalAllTime: 0,
    season: 0,
    // Fresh save opens budded (see FIRST_RUN_STAGE). `stageFloor` is what makes
    // it stick: every recompute goes through stageFor(total, mul, stageFloor).
    stage: FIRST_RUN_STAGE,
    stageFloor: FIRST_RUN_STAGE,
    tenders,
    upgrades: {},
    heartwood: {},
    nodes: {},
    codex: {},
    achievements: {},
    stats: {
      clicks: 0, crits: 0, storms: 0, golden: 0, upgrades: 0,
      playTime: 0, seasonTime: 0, bestSeasonTotal: 0, bestRate: 0,
      bestBank: 0, offlineH: 0, night: 0, idle: 0, maxTender: 0,
      seasonClicks: 0,
    },
    lastSeen: 0,
    sched: newSchedule(),
    ui: { panel: 'tenders', bulk: 1 },
  };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

/** Coerce anything that came out of localStorage into a state we can run. */
export function sanitizeState(s) {
  const base = newState(num(s?.seed, 20260728) || 20260728);
  if (!s || typeof s !== 'object') return base;
  base.petals = num(s.petals);
  base.blossoms = num(s.blossoms);
  base.essence = num(s.essence);
  base.essenceEarned = Math.max(num(s.essenceEarned), num(s.essence));
  base.totalThisSeason = num(s.totalThisSeason);
  base.totalAllTime = Math.max(num(s.totalAllTime), base.totalThisSeason);
  base.season = Math.floor(num(s.season));
  /* stageFloor: absent means "not written by a v3 save". A player who has
   * turned a Season has legitimately seen bare branches and keeps floor 0;
   * anyone else gets the first-run Budding floor. `migrate()` decides this for
   * real saves — this branch only covers hand-built states (debug scenarios). */
  base.stageFloor = s.stageFloor === undefined
    ? (base.season > 0 ? POST_PRESTIGE_STAGE : FIRST_RUN_STAGE)
    : Math.min(5, Math.max(0, Math.floor(num(s.stageFloor))));
  base.stage = Math.min(5, Math.max(base.stageFloor, Math.floor(num(s.stage))));
  for (const id of TENDER_IDS) base.tenders[id] = Math.floor(num(s.tenders?.[id]));
  for (const u of UPGRADES) if (s.upgrades?.[u.id]) base.upgrades[u.id] = 1;
  for (const h of HEARTWOOD_LIST) if (s.heartwood?.[h.id]) base.heartwood[h.id] = 1;
  for (const n of CONSTELLATION) if (s.nodes?.[n.id]) base.nodes[n.id] = 1;
  for (const c of CODEX) if (s.codex?.[c.id]) base.codex[c.id] = 1;
  for (const a of ACHIEVEMENTS) if (s.achievements?.[a.id]) base.achievements[a.id] = 1;
  for (const k of Object.keys(base.stats)) base.stats[k] = num(s.stats?.[k]);
  base.stats.upgrades = Object.keys(base.upgrades).length;
  base.lastSeen = num(s.lastSeen);
  /* Countdowns are clamped to a sane window rather than trusted: a hand-edited
   * or corrupt save must not be able to park the storm 400 days out (which
   * would silently disable the event) or park it at 0 (a storm every frame). */
  {
    const sc = s.sched;
    const span = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v > 0
      ? Math.min(v, max) : null);
    base.sched = {
      storm: span(sc?.storm, TUNING.STORM_PERIOD + TUNING.STORM_JITTER),
      golden: span(sc?.golden, TUNING.GOLDEN_MAX * 3),
      rain: Math.min(60, num(sc?.rain)),
    };
  }
  base.ui = { panel: String(s.ui?.panel ?? 'tenders'), bulk: num(s.ui?.bulk, 1) || 1 };
  return base;
}

/**
 * Versioned migration. v1 was the early-access layout (tenders as a parallel
 * array, `total` instead of `totalThisSeason`, no Heartwood/Constellation).
 * v2 → v3 introduces `stageFloor`.
 * Unversioned blobs are treated as v1.
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let s = { ...raw };
  let v = Math.floor(num(s.v, 1)) || 1;

  if (v < 2) {
    if (Array.isArray(s.tenders)) {
      const t = {};
      TENDER_IDS.forEach((id, i) => { t[id] = num(s.tenders[i]); });
      s.tenders = t;
    }
    if (s.total !== undefined && s.totalThisSeason === undefined) s.totalThisSeason = s.total;
    if (Array.isArray(s.upgrades)) {
      s.upgrades = Object.fromEntries(s.upgrades.map((id) => [id, 1]));
    }
    s.heartwood = s.heartwood || {};
    s.nodes = s.nodes || s.constellation || {};
    s.essenceEarned = num(s.essenceEarned, num(s.essence));
    v = 2;
  }

  if (v < 3) {
    /* The first-run Budding floor. Two kinds of old save reach this line at
     * stage 0 and they must NOT be treated alike:
     *   - never prestiged (season 0): they are effectively a new player who has
     *     been staring at a bare tree because of the old default. Give them the
     *     floor so their grove finally buds.
     *   - has turned at least one Season: stage 0 is the state they earned. It
     *     is the post-prestige look by design, so no floor — lifting them would
     *     erase the reset they just paid for.
     * Either way stageFor() re-derives the real stage from totalThisSeason, so
     * nobody LOSES a stage; the floor can only ever raise a bare tree. */
    s.stageFloor = Math.floor(num(s.season)) > 0 ? POST_PRESTIGE_STAGE : FIRST_RUN_STAGE;
    /* If the floor is what lifts this save to 蕾 Budding, pay the stage grant it
     * skipped — but only when the save had genuinely never earned it. A save
     * already past 1e3 petals either collected it or will when boot re-derives
     * the stage, and double-paying a permanent currency is not recoverable. */
    if (s.stageFloor === FIRST_RUN_STAGE
        && Math.floor(num(s.stage)) < FIRST_RUN_STAGE
        && num(s.totalThisSeason) < BLOOM_STAGES[FIRST_RUN_STAGE].threshold) {
      s.blossoms = num(s.blossoms) + FIRST_RUN_BLOSSOMS;
    }
    v = 3;
  }

  if (v < 4) {
    /* Persisted event schedule. Nothing to carry across — an older save has no
     * countdowns to preserve — so leave `sched` absent and let sanitizeState
     * install the nulls that mean "roll fresh". A player mid-Season keeps their
     * storm cadence from the moment they load this build onward.
     *
     * One deliberate consequence: a v1–v3 save gets STORM_FIRST rather than the
     * full period, i.e. its next storm arrives in ~110 s. That is the right way
     * round — the returning player is the one who has been most cheated by the
     * timer resetting on every load. */
    delete s.sched;
    v = 4;
  }
  // future: if (v < 5) { ... v = 5; }

  s.v = SAVE_VERSION;
  return sanitizeState(s);
}

/* base64 export/import — UTF-8 safe without depending on browser globals. */
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}
function fromB64(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(clean, 'base64').toString('utf8');
}

export function encodeSave(state) { return toB64(JSON.stringify(state)); }
export function decodeSave(b64) {
  try { return migrate(JSON.parse(fromB64(b64))); } catch { return null; }
}

/* ==================================================================== *
 * 12. computeDerived — the single source of truth for every rate
 * ==================================================================== */

/**
 * Turn a state (+ the currently-running events/buffs) into every number the
 * simulation and the UI need. Pure: no side effects, safe to call per frame.
 *
 * @param {object} state
 * @param {object} [live] { storm, rain, moon, goldenHour, frenzy, clickFrenzy }
 */
export function computeDerived(state, live = {}) {
  const up = state.upgrades || {};
  const nodes = state.nodes || {};
  const hw = state.heartwood || {};
  const codex = state.codex || {};

  let clickFlat = 0;
  let clickMult = 1;
  let crit = TUNING.BASE_CRIT_CHANCE;
  let critMult = TUNING.BASE_CRIT_MULT;
  let allTenders = 1;
  let prod = TUNING.PROD_SCALE;
  const tenderMul = {};
  for (const id of TENDER_IDS) tenderMul[id] = 1;

  const grove = {
    bulk: 0, magnet: 1, auto: 0, autoFull: 0,
    goldRate: 1, goldTtl: 1, dewH: TUNING.OFFLINE_CAP_H,
    offRate: TUNING.OFFLINE_RATE, stormDur: 1, stormMult: TUNING.STORM_MULT,
    stormRate: 1, rainChance: 1, rainPassive: TUNING.RAIN_PASSIVE,
    moonCrit: TUNING.MOON_CRIT, upCost: 1, cost: 1,
    clickPassiveTerm: TUNING.CLICK_PASSIVE_TERM, doubleShake: 0,
    bloomThreshold: 1, goldDouble: 0, essenceMul: 1, keepFirstTierUps: 0,
    startTenders: {},
  };

  /* ---- petal upgrades ---- */
  for (const id in up) {
    const u = UPGRADE_BY_ID[id];
    if (!u) continue;
    const e = u.eff;
    if (e.clickFlat) clickFlat += e.clickFlat;
    if (e.clickMult) clickMult *= e.clickMult;
    if (e.crit) crit += e.crit;
    if (e.critMult) critMult += e.critMult;
    if (e.tender) tenderMul[e.tender] *= e.v;
    if (e.allTenders) allTenders *= e.allTenders;
    if (e.grove) {
      const k = e.grove; const v = e.v;
      if (k === 'dewH' || k === 'offRate' || k === 'stormDur' || k === 'stormMult' ||
          k === 'magnet' || k === 'bulk' || k === 'autoFull') grove[k] = Math.max(grove[k], v);
      else if (k === 'auto') grove.auto = grove.auto === 0 ? v : Math.min(grove.auto, v);
      else if (k === 'goldRate' || k === 'goldTtl') grove[k] *= v;
      else grove[k] = v;
    }
  }

  /* ---- constellation ---- */
  for (const id in nodes) {
    const n = NODE_BY_ID[id];
    if (!n) continue;
    const e = n.eff;
    if (e.passive) allTenders *= e.passive;
    if (e.prod) prod *= e.prod;
    if (e.click) clickMult *= e.click;
    if (e.crit) crit += e.crit;
    if (e.critMult) critMult += e.critMult;
    if (e.stormDur) grove.stormDur = Math.max(grove.stormDur, e.stormDur);
    if (e.stormMult) grove.stormMult = Math.max(grove.stormMult, e.stormMult);
    if (e.stormRate) grove.stormRate *= e.stormRate;
    if (e.offRate) grove.offRate += e.offRate;
    if (e.offFull) grove.offRate = 1;
    if (e.dewH) grove.dewH += e.dewH;
    if (e.rainChance) grove.rainChance *= e.rainChance;
    if (e.rainPassive) grove.rainPassive = Math.max(grove.rainPassive, e.rainPassive);
    if (e.goldRate) grove.goldRate *= e.goldRate;
    if (e.goldDouble) grove.goldDouble = 1;
    if (e.moonCrit) grove.moonCrit = Math.max(grove.moonCrit, e.moonCrit);
    if (e.cost) grove.cost *= e.cost;
    if (e.upCost) grove.upCost *= e.upCost;
    if (e.clickPassiveTerm) grove.clickPassiveTerm = Math.max(grove.clickPassiveTerm, e.clickPassiveTerm);
    if (e.doubleShake) grove.doubleShake = Math.max(grove.doubleShake, e.doubleShake);
    if (e.bloomThreshold) grove.bloomThreshold = Math.min(grove.bloomThreshold, e.bloomThreshold);
    if (e.keepFirstTierUps) grove.keepFirstTierUps = 1;
    if (e.startTender) {
      const [tid, n2] = e.startTender;
      grove.startTenders[tid] = Math.max(grove.startTenders[tid] || 0, n2);
    }
  }

  /* ---- heartwood (permanent, Blossom-bought) ---- */
  for (const id in hw) {
    const h = HEARTWOOD_BY_ID[id];
    if (!h) continue;
    const e = h.eff;
    if (e.prod) prod *= e.prod;
    if (e.click) clickMult *= e.click;
    if (e.crit) crit += e.crit;
    if (e.critMult) critMult += e.critMult;
    if (e.offRate) grove.offRate += e.offRate;
    if (e.dewH) grove.dewH += e.dewH;
    if (e.essence) grove.essenceMul *= e.essence;
    if (e.startTender) {
      const [tid, n2] = e.startTender;
      grove.startTenders[tid] = Math.max(grove.startTenders[tid] || 0, n2);
    }
  }

  /* ---- codex ---- */
  let codexCount = 0;
  for (const id in codex) {
    const c = CODEX_BY_ID[id];
    if (!c) continue;
    codexCount++;
    if (c.eff.passive) allTenders *= c.eff.passive;
    if (c.eff.click) clickMult *= c.eff.click;
    if (c.eff.prod) prod *= c.eff.prod;
  }

  /* ---- global production multipliers ---- */
  const achCount = Object.keys(state.achievements || {}).length;
  const essenceBonus = 1 + TUNING.ESSENCE_PER_POINT * (state.essenceEarned || 0);
  const achBonus = 1 + TUNING.ACH_BONUS * achCount;
  const seasonMult = prod * essenceBonus * achBonus;

  /* ---- passive rate ---- */
  let rawRate = 0;                 // BEFORE the global season multiplier
  let totalTenders = 0;
  const perTender = {};
  for (const t of TENDERS) {
    const owned = state.tenders?.[t.id] || 0;
    totalTenders += owned;
    const r = owned * t.rate * tenderMul[t.id] * milestoneMult(owned);
    perTender[t.id] = r * allTenders * seasonMult;
    rawRate += r;
  }
  rawRate *= allTenders;
  const baseRate = rawRate * seasonMult;

  let eventPassive = 1;
  if (live.storm) eventPassive *= grove.stormMult;
  if (live.rain) eventPassive *= 1 + grove.rainPassive;
  if (live.frenzy) eventPassive *= 7;
  const passiveRate = baseRate * eventPassive;

  /* ---- click value (GAME_DESIGN "Clicking") ---- */
  let eventClick = 1;
  if (live.goldenHour) eventClick *= 1 + TUNING.GOLDEN_HOUR_CLICK;
  if (live.clickFrenzy) eventClick *= 77;
  // NOTE the passive term uses the PRE-seasonMult rate. Applying seasonMult on
  // both sides makes click value scale as seasonMult² while passive scales as
  // seasonMult¹, so clicking runs away by a factor of the prestige bonus (at
  // 851 Essence earned that measured 326× passive). One application only.
  const clickValue = TUNING.CLICK_SCALE * (1 + clickFlat) * clickMult * eventClick * seasonMult
    * (1 + grove.clickPassiveTerm * rawRate);

  /* ---- crit ---- */
  let critChance = crit + (live.moon ? grove.moonCrit : 0);
  critChance = Math.min(TUNING.MAX_CRIT_CHANCE, Math.max(0, critChance));

  return {
    clickValue, clickFlat, clickMult, critChance, critMult,
    baseRate, rawRate, passiveRate, perTender, eventPassive, eventClick,
    seasonMult, essenceBonus, achBonus, prod, allTenders, tenderMul,
    totalTenders, achCount, codexCount, grove,
    costMul: grove.cost, upCostMul: grove.upCost,
    offlineRate: Math.min(1, grove.offRate),
    offlineCapS: grove.dewH * 3600,
  };
}

/** Convenience for the UI: everything a Tender card needs, in one call. */
export function tenderView(state, derived, id) {
  const t = TENDER_BY_ID[id];
  const owned = state.tenders?.[id] || 0;
  const cost = tenderCost(id, owned, derived.costMul);
  const each = t.rate * derived.tenderMul[id] * milestoneMult(owned) * derived.allTenders * derived.seasonMult;
  return {
    ...t, owned, cost,
    each,
    total: derived.perTender[id] || 0,
    share: derived.baseRate > 0 ? (derived.perTender[id] || 0) / derived.baseRate : 0,
    milestone: nextMilestone(owned),
    milestoneMult: milestoneMult(owned),
    affordable: state.petals >= cost,
    /** Revealed once the player can afford 40% of base cost (GAME_DESIGN). */
    revealed: owned > 0 || (state.stats?.bestBank || state.petals) >= t.baseCost * 0.4,
  };
}
