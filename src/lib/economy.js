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
    id: 'sprite', name: '바람 정령', nameKo: '바람 정령', kanji: '바람', baseCost: 15, rate: 0.1,
    blurb: '눈엔 안 보일 만큼 작지만, 무시하기엔 시끄럽다. 한 번에 나뭇가지 하나를 흔들고, 그것만으로 엄청나게 자랑한다.',
  },
  {
    id: 'gatherer', name: '꽃잎 줍는 아이', nameKo: '꽃잎 줍는 아이', kanji: '꽃', baseCost: 100, rate: 1,
    blurb: '맨발, 넓은 바구니, 어딘가 아름다운 곳에 떨어진 것만 골라 눈독 들인다.',
  },
  {
    id: 'miko', name: '무녀', nameKo: '무녀', kanji: '무', baseCost: 1.1e3, rate: 8,
    blurb: '꽃잎을 줍지 않는다. 정중히 부탁하면, 꽃잎이 스스로 온다.',
  },
  {
    id: 'lantern', name: '석등롱', nameKo: '석등롱', kanji: '등', baseCost: 1.2e4, rate: 47,
    blurb: '꽃잎은 나방처럼 빛을 따라 흘러간다. 꽃잎에게 나방이 아니라는 건 아무도 알려준 적 없다.',
  },
  {
    id: 'koi', name: '잉어의 영혼', nameKo: '잉어의 영혼', kanji: '비', baseCost: 1.3e5, rate: 260,
    blurb: '연못 위 공기 속을 헤엄치며 꽃의 반영을 마신다.',
  },
  {
    id: 'rabbit', name: '달 토끼', nameKo: '달 토끼', kanji: '달', baseCost: 1.4e6, rate: 1.4e3,
    blurb: '돌 절구에서 꽃잎을 찧는다. 무엇을 만드는지는 모르겠지만, 확실히 떡은 아니다.',
  },
  {
    id: 'kitsune', name: '여우 사자', nameKo: '여우 사자', kanji: '여', baseCost: 2.0e7, rate: 7.8e3,
    blurb: '나무와 더 오래된 것 사이의 메시지를 옮긴다. 어느 쪽이 답하는지는 말해주지 않는다.',
  },
  {
    id: 'envoy', name: '풍신의 사자', nameKo: '풍신의 사자', kanji: '신', baseCost: 3.3e8, rate: 4.4e4,
    blurb: '끝내지 못한 날씨를 한 주머니에 담아오고, 끈을 느슨하게 묶은 채 떠난다.',
  },
  {
    id: 'heart', name: '영원한 꽃의 마음', nameKo: '영원한 꽃의 마음', kanji: '마음', baseCost: 5.1e9, rate: 2.6e5,
    blurb: '뿌리가 엉키는 곳에 묻혀 있다. 한 번 뛸 때마다 하나의 봄이 나무를 통과한다.',
  },
  {
    id: 'bough', name: '하늘의 가지', nameKo: '하늘의 가지', kanji: '하늘', baseCost: 7.5e10, rate: 1.6e6,
    blurb: '하늘을 지나 더 많은 하늘을 만나고, 예의상 계속 자라난 가지.',
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
  ['shake_f1', 'Calloused Palms', '닳고 닳은 손바닥', 25, { clickFlat: 1 }, {},
    '나무껍질이 값을 요구한다. 그리고는, 갑자기, 더는 아무것도 요구하지 않는다.'],
  ['shake_m1', 'Practiced Rhythm', '익숙한 리듬', 90, { clickMult: 2 }, { clicks: 25 },
    '더 세게가 아니라, 박자에 맞춰서. 나무가 리듬을 매우 선호한다.'],
  ['shake_f2', 'Two-Handed Shake', '양손 흔들기', 300, { clickFlat: 2 }, { clicks: 60 },
    '찻잔을 내려놓아야 할 것이다.'],
  ['shake_m2', 'Hanami Fervour', '벚꽃 놀이의 열기', 1.8e3, { clickMult: 1.6 }, {},
    '누군가 노래를 시작한다. 모두 더 빨리 일한다. 그 두 가지가 관련 있다는 걸 아무도 인정하지 않는다.'],
  ['shake_c1', 'Lucky Knot', '행운의 매듭', 2.2e3, { crit: 0.04 }, { clicks: 150 },
    '진심으로 매듭지은 사람이 손목에 묶어주었다.'],
  ['shake_f3', 'Rooted Stance', '뿌리 박은 자세', 1.4e4, { clickFlat: 3 }, {},
    '발은 어깨 너비, 무게는 낮게. 정원사가 당신을 보며 아무 말도 하지 않았다 — 그것이 칭찬이다.'],
  ['shake_x1', 'Sharp Intent', '날카로운 의도', 1.8e4, { critMult: 5 }, { crits: 10 },
    '같은 흔들기, 다만 먼저 결심이 따른다.'],
  ['shake_m3', 'Breath Between Shakes', '흔들기 사이의 호흡', 9.0e4, { clickMult: 1.5 }, {},
    '멈춤이 진짜 기술이다. 흔들기는 그 멈춤이 향한 곳일 뿐이다.'],
  ['shake_c2', "Fox's Wink", '여우의 윙크', 1.4e5, { crit: 0.05 }, { crits: 40 },
    '황혼에 눈가장자리에서 한 번 본 적 있다. 그 뒤로 당신의 운은 묘해졌다.'],
  ['shake_f4', 'Weight of Winter', '겨울의 무게', 6.0e5, { clickFlat: 5 }, {},
    '모든 가지는 지탱했던 눈을 기억한다. 상기시켜라.'],
  ['shake_x2', 'Split-Second Bloom', '찰나의 만개', 1.2e6, { critMult: 9 }, { crits: 200 },
    '단 한 프레임 동안 캐노피 전체가 동시에 열린다. 당신은 본 적 없다. 하지만 벌어진다.'],
  ['shake_m4', 'The Long Draw', '긴 당김', 3.0e6, { clickMult: 1.45 }, {},
    '네 박자에 맞춰 당기고, 한 박자 멈춘다. 숲이 당신을 대신해 내쉰다.'],
  ['shake_c3', 'Omikuji: Great Blessing', '오미쿠지: 대길', 4.0e7, { crit: 0.05 }, {},
    '공정하게 뽑았다. 상자를 두 번 확인했다. 공정했다.'],
  ['shake_f5', 'Bough-Bender', '가지 꺾는 자', 8.0e8, { clickFlat: 8 }, {},
    '가지가 이제 당신을 만나러 내려온다. 누가 누구를 돌보는지 더는 분명하지 않다.'],
  ['shake_x3', 'Sakura Sever', '벚꽃 베기', 1.5e9, { critMult: 12 }, {},
    '가지가 다 움직이기도 전에 꽃잎이 떨어져 나갈 만큼 깨끗한 흔들기.'],
  ['shake_m5', 'Hand of the Grove', '숲의 손', 5.0e10, { clickMult: 1.4 }, {},
    '마지막 천 개의 봄 어딘가에서, 숲이 다시 흔들기 시작했다.'],
  ['shake_c4', 'Thousand-Fold Fortune', '천 갈래의 행운', 2.0e11, { crit: 0.06 }, {},
    '천 마리의 종이학을 접었다. 하나는 남기고, 나머지는 태웠다. 효과가 있었다.'],
  ['shake_c5', 'The Whole Sky Agrees', '온 하늘이 동의한다', 2.0e14, { crit: 0.07 }, {},
    '계곡의 모든 징조가 같은 방향을 가리키지만, 그 이유는 아무도 말해주지 않는다.'],
];

const tenderUpNames = {
  sprite: [
    ['Whistling Lessons', '휘파람 레슨', '휘파람을 불게 가르친다. 서로의 소리를 들을 수 있으면 더 빨리 일한다.'],
    ['Paper Charms', '종이 부적', '종이 한 장, 두 번 적힌 이름, 그러면 그들은 어디든 못 가게 된다.'],
    ['Sprite Choir', '정령 합창단', '마흔 목소리, 하나의 돌풍. 언덕이 정중히 비켜선다.'],
    ['Names for the Wind', '바람에게 이름을', '바람에 이름을 주면 돌아온다. 두 개 주면 영원히 머문다.'],
  ],
  gatherer: [
    ['Wider Baskets', '더 넓은 바구니', '두 배 짠, 절반의 횟수, 같은 콧노래.'],
    ['Dawn Shift', '새벽 교대', '안개가 걷히기도 전에 일을 시작한다. 아무도 시킨 적 없다.'],
    ['낙화 조합', '낙화 조합', '이제 휘장이 있다. 꽃잎이다. 당연히 그렇다.'],
    ['Ten Thousand Sleeves', '만 소매', '모든 소매에 주머니, 모든 주머니에 봄.'],
  ],
  miko: [
    ['Purified Bells', '정화된 종', '녹슨 종은 둔해지고, 둔한 종은 기도를 둔하게 한다.'],
    ['The Longer Dance', '더 긴 춤', '다섯 바퀴 대신 아홉. 나무가 일곱 번째에서 알아차렸다.'],
    ['Kagura at Midnight', '한밤중의 가구라', '관객 없는 가지들을 위해 춤을 춘다. 가지들이 박수를 쳤다.'],
    ['Rite of the Standing Tree', '서 있는 나무의 의식', '계곡에서 가장 오래된 의식: 가만히 서 있고, 진심으로.'],
  ],
  lantern: [
    ['Trimmed Wicks', '다듬은 심지', '밝은 불꽃보다 깨끗한 불꽃이 더 모은다.'],
    ['Lacquered Caps', '옻칠한 갓', '이제 비가 의견을 갖지 않는다.'],
    ['The Lit Path', '밝혀진 길', '첫 번째를 켜면 나머지는 스스로 켜진다. 아무도 이걸 설명하지 못했다.'],
    ['Ever-Burning Oil', '영원히 타는 기름', '꽃잎에서 짠다. 당신이 행복했던 해의 냈새가 난다.'],
  ],
  koi: [
    ['Deeper Pool', '더 깊은 연못', '영혼에 공간을 주면 정확히 그만큼 자라난다.'],
    ['Moonlit Feeding', '달빛 먹이', '그들은 반영을 먹는다. 보름달을 주고 지켜보라.'],
    ['Upstream Vow', '상류로의 서원', '모든 잉어는 무언가를 향해 헤엄친다. 그들을 나무 쪽으로 가리켜라.'],
    ["Dragon's Half-Step", '용의 반 걸음', '비늘 하나가 금이 됐다. 하나만. 아직은.'],
  ],
  rabbit: [
    ['Heavier Mallets', '더 무거운 공이', '찧는 것은 같고, 리듬도 같다. 그것은 떡이 아니다.'],
    ['Lunar Mortar', '달의 절구', '분화구 림에서 깎았다. 장갑 너머로도 시릴 만큼 차갑다.'],
    ['The Eight-Day Week', '여덟 날의 주', '하루를 더 만들었다. 달이 허락했다.'],
    ['Elixir Shares', '불로초의 분배', '불멸을 균등하게. 사기가 극적으로 올라갔다.'],
  ],
  kitsune: [
    ['Second Tail', '두 번째 꼬리', '각 꼬리는 지켜진 약속이다. 첫 번째가 무엇이었는지 물어봐도 좋다.'],
    ['Foxfire Lanterns', '여우불 등불', '파란 빛, 열기도 없고, 그림자도 없다. 매우 효율적이고, 매우 소름 끼친다.'],
    ['The Borrowed Face', '빌린 얼굴', '일하는 동안 당신의 얼굴을 쓴다. 산출량이 두 배가 된다. 보지 마라.'],
    ['Nine and Counting', '아홉 그리고 세는 중', '아홉 번째 꼬리가 셈을 한다.'],
  ],
  envoy: [
    ['Sealed Orders', '봉인된 명령', '한 번도 젖은 적 없는 종이에 배달된다.'],
    ['The Storm Satchel', '폭풍 주머니', '태풍 하나를 접어 넣는다. 모서리를 집어넣고.'],
    ['Right of Way', '통행권', '다른 모든 바람은 양보해야 한다. 놀랍게도, 양보한다.'],
    ["Fūjin's Seal", '풍신의 봉인', '주머니가 손가락 한 마디만큼 열려 있다. 손가락 한 마디만.'],
  ],
  heart: [
    ['Slower Beat', '느린 박동', '더 적은 박동, 더 깊은 박동. 숲 전체가 그 시간을 따른다.'],
    ['Grafted Chambers', '이식된 방실', '넷이 여덟이 됐다. 나무가 밤 사이에 스스로 했다.'],
    ['Blood of Spring', '봄의 피', '주로 수액. 주로.'],
    ['The Undying Systole', '죽지 않는 수축기', '이 언덕이 모래가 될 때까지 여전히 뛸 것이다.'],
  ],
  bough: [
    ['Star-Grafting', '별 접붙이기', '가지 하나, 별자리 하나, 그리고 매우 흔들림 없는 손.'],
    ['Orbit Pruning', '궤도 가지치기', '죽은 세계들을 잘라낸다. 새 세계들이 아침에 싹을 튼다.'],
    ['The Long Branch', '긴 가지', '하늘을 지나, 더 많은 하늘을 만나, 계속 뻗어나간다.'],
    ['Root of Heaven', '하늘의 뿌리', '아래는 방향일 뿐이다. 가지가 동의하지 않는다.'],
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
    const [name, nameKo, flavour] = tenderUpNames[t.id][i];
    tenderUps.push([
      `up_${t.id}_${i + 1}`, name, nameKo,
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
  ['all_1', 'A Word of Thanks', '한마디 감사', 4.0e6, 15, '황혼에, 모두에게, 동시에 한마디를 건넸다.'],
  ['all_2', 'Shared Kettle', '함께 쓰는 주전자', 2.4e8, 40, '숲의 역사 속에서 추위에 잘 일한 적은 한 번도 없다.'],
  ['all_3', 'The Rota', '당번표', 3.5e9, 75, '벽에 정갈한 손으로 적힌 당번표. 모두가 따른다. 아무도 쓰지 않았다.'],
  ['all_4', 'Festival Wages', '축제 임금', 2.5e11, 120, '꽃잎으로 지급되고, 아무것도 아닌 데 쓰이고, 정성껏 저축된다.'],
  ['all_5', 'One Purpose', '한 가지 목적', 1.5e13, 180, '그들 중 누구에게 무엇을 하느냐고 물어보라. 같은 답을 들을 것이다.'],
  ['all_6', 'The Grove Remembers', '숲은 기억한다', 1.0e15, 260, '이곳에서 한 번이라도 일한 모든 이름을, 당신의 이름까지, 기억한다.'],
].map(([id, name, nameKo, cost, gate, flavour]) => [
  id, name, nameKo, cost, { allTenders: 1.5 }, { totalTenders: gate }, flavour,
]);

const groveUps = [
  ['grove_bulk', 'Abacus of the Grove', '숲의 주판', 6.0e4, { grove: 'bulk', v: 1 }, { totalTenders: 12 },
    '닳아서 미끈해진 주판알. 열 개씩, 백 개씩, 들 수 있는 만큼.'],
  ['grove_magnet', 'Petal Magnet', '꽃잎 자석', 2.0e5, { grove: 'magnet', v: 2 }, {},
    '붉은 실로 감은 자석. 꽃잎이 정중히 부탁받은 듯 기울어진다.'],
  ['grove_auto1', 'Idle Hands', '한가한 손', 3.5e5, { grove: 'auto', v: 3 }, { clicks: 300 },
    '밧줄, 추, 그리고 몇 초마다 흔들리기로 동의한 가지 하나.'],
  ['grove_gold1', 'Gilded Eye', '금빛 눈', 8.0e5, { grove: 'goldRate', v: 0.75 }, {},
    '황금색을 더 일찍 알아차린다. 그것들도 더 일찍 도착한다. 원인은 불명.'],
  ['grove_dew1', 'Dew Reservoir', '이슬 저장고', 1.6e6, { grove: 'dewH', v: 6 }, {},
    '뿌리 아래의 돌 그릇. 당신이 없던 시간을 간직한다.'],
  ['grove_storm1', 'Storm Glass', '폭풍 유리', 8.0e6, { grove: 'stormDur', v: 1.5 }, { storms: 1 },
    '바람이 돌기 한 시간 전부터 유리가 올라간다. 당신은 그것을 신뢰하게 되었다.'],
  ['grove_gold2', 'Slow Gold', '느린 황금', 2.4e7, { grove: 'goldTtl', v: 1.6 }, { golden: 2 },
    '황금 꽃잎이 공기가 시럽인 양 흘러간다. 천천히. 너무 천천히 말고.'],
  ['grove_off1', 'Sleeping Roots', '잠자는 뿌리', 1.1e8, { grove: 'offRate', v: 0.70 }, {},
    '자는 동안에도 숲은 일한다. 약간 원망스럽지만, 일한다.'],
  ['grove_auto2', 'Restless Hands', '안절부절한 손', 4.0e8, { grove: 'auto', v: 1 }, {},
    '이제 밧줄이 바퀴 위로 지나가고, 바퀴는 쉬지 않는다.'],
  ['grove_dew2', 'Cistern of Quiet Hours', '조용한 시간의 저수지', 2.0e9, { grove: 'dewH', v: 12 }, {},
    '우물보다 깊고, 연못보다 차갑고, 한 번도 넘친 적 없다.'],
  ['grove_gold3', "Fortune's Draft", '행운의 바람', 3.0e10, { grove: 'goldRate', v: 0.7 }, { golden: 8 },
    '단 하나의 것만 나르는, 항상 당신에게로 가져다주는 바람 한 줄기.'],
  ['grove_storm2', 'Eye of the Squall', '폭풍의 눈', 4.0e11, { grove: 'stormMult', v: 16 }, { storms: 6 },
    '한가운데에 서라. 아무것도 움직이지 않는다. 나머지는 모두 움직인다.'],
  ['grove_dew3', "The Whole Night's Water", '온 밤의 물', 8.0e12, { grove: 'dewH', v: 24 }, {},
    '세상이 한 바퀴 도는 동안의 시간을, 그릇에 담아, 당신이 돌아오길 기다린다.'],
  ['grove_auto3', 'The Grove Shakes Itself', '숲이 스스로 흔든다', 2.0e14, { grove: 'autoFull', v: 1 }, {},
    '이제 손을 소매에 넣어도 된다. 숲이 알아서 한다.'],
];

function mkUpgrade(family, row) {
  const [id, name, nameKo, cost, eff, req, flavour] = row;
  return { id, family, name, nameKo, cost, eff, req: req || {}, flavour };
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
  ['hw_prod1', 'Heartwood Ring', '나무심장 반지', 3, { prod: 1.10 },
    '나무 나이보다 하나 더 많은 링. 두 배로 친다.'],
  ['hw_click1', 'Palmprint in the Bark', '나무껍질의 손자국', 5, { click: 1.25 },
    '정확히 내 키에 맞춰 줄기에 새겨졌다. 내가 있기 전부터 거기 있었다.'],
  ['hw_start1', 'Seedbed', '묘판', 8, { startTender: ['sprite', 20] },
    '계절이 돌아올 때 20마리의 정령이 이미 깨어 있다. 그들은 나를 기억한다.'],
  ['hw_prod2', 'Deep Taproot', '깊은 주뿌리', 14, { prod: 1.20 },
    '산이 젊었을 때부터 하늘을 보지 못한 물을 찾았다.'],
  ['hw_crit1', 'Windfall Charm', '낙과 부적', 20, { crit: 0.05, critMult: 6 },
    '가장 낮은 가지에 걸려 있다. 바람이 없을 때에도 흔들린다.'],
  ['hw_off1', 'Nightwatch Lantern', '야경 등불', 28, { offRate: 0.12, dewH: 4 },
    '문 앞에서 켜놓아서, 숲이 내가 돌아올 것을 알도록 한다.'],
  ['hw_prod3', 'Crown of Years', '세월의 왕관', 40, { prod: 1.35 },
    '돌린 계절마다 잎이 하나 더 달린다. 좋은 쪽으로 무거워지고 있다.'],
  ['hw_ess1', 'Essence Still', '정수 증류기', 60, { essence: 1.25 },
    '한 계절의 마지막을 다음 계절로 가지고 갈 수 있는 무언가로 증류한다.'],
];
export const HEARTWOOD_BY_ID = Object.fromEntries(HEARTWOOD.map((h) => [h[0], {
  id: h[0], name: h[1], nameKo: h[2], cost: h[3], eff: h[4], flavour: h[5],
}]));
export const HEARTWOOD_LIST = HEARTWOOD.map((h) => HEARTWOOD_BY_ID[h[0]]);

/* ==================================================================== *
 * 6. Bloom stages
 * ==================================================================== */

export const BLOOM_STAGES = [
  { stage: 0, name: '겨울 눈봉우리', nameKo: '겨울 눈봉우리', kanji: '한겨울', threshold: 0, blurb: '벌거벗은 어두운 가지, 손에 잡힐 듯한 꽃봉우리, 온기 없는 빛뿐이다.' },
  { stage: 1, name: '봉우리', nameKo: '봉우리', kanji: '봉오리', threshold: 1e3, blurb: '꽃봉우리가 하룻밤 사이에 분홍색으로 부푼다. 아무도 보지 않는 곳에서 첫 꽃이 핀다.' },
  { stage: 2, name: '초咲', nameKo: '초咲', kanji: '첫꽃', threshold: 1e5, blurb: '캐노피의 3분의 1이 색을 바꿨다. 꽃잎이 하나둘씩 떨어지기 시작한다.' },
  { stage: 3, name: '만개', nameKo: '만개', kanji: '만개', threshold: 1e7, blurb: '캐노피 가득, 끊임없는 낙화, 길 위의 꽃잎 카펫. 사람들이 여기 걸어오려는 이유가 이것이다.' },
  { stage: 4, name: '찬란한 꽃', nameKo: '찬란한 꽃', kanji: '찬란', threshold: 1e10, blurb: '꽃잎이 황혼 뒤에도 빛을 머금는다. 빛의 알갱이가 아래로보다 위로 더 자주 흘러간다.' },
  { stage: 5, name: '영원한 꽃', nameKo: '영원한 꽃', kanji: '영원', threshold: 1e13, blurb: '나무껍질 속으로 금이 흐른다. 꽃은 더 이상 봄을 기다리지 않고, 그 곁의 어떤 것도 기다리지 않는다.' },
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
  { id: 'wind', name: 'Wind', nameKo: '바람', kanji: '風', a: -90, color: '#BBD6E8' },
  { id: 'water', name: 'Water', nameKo: '물', kanji: '水', a: -18, color: '#8FC4D8' },
  { id: 'moon', name: 'Moon', nameKo: '달', kanji: '月', a: 54, color: '#C9C2E8' },
  { id: 'stone', name: 'Stone', nameKo: '돌', kanji: '石', a: 126, color: '#CFC6B4' },
  { id: 'blossom', name: 'Blossom', nameKo: '꽃', kanji: '花', a: 198, color: '#FFB6CE' },
];
export const CONSTELLATION_BRANCHES = BRANCHES;

const NODE_ROWS = {
  wind: [
    ['First Breath', '첫 숨결', 1, { passive: 1.08 }, '숲이 하루에 한 번 숨을 쉰다. 그 자리에 함께 있어라.'],
    ['Gustling', '잔바람 아이', 3, { stormDur: 1.5 }, '날씨가 되기로 작정한 작은 바람.'],
    ['Following Wind', '따르는 바람', 8, { startTender: ['sprite', 15] }, '계절이 바뀔 때 문 앞에 15마리의 정령이 기다린다.'],
    ['Squall', '돌풍', 20, { stormMult: 16 }, '10은 폭풍이었다. 16은 논쟁이다.'],
    ['Typhoon Heart', '태풍의 심장', 50, { passive: 1.25 }, '모든 것을 만들어내는 중심에 고요가 있다.'],
    ['The Long Exhale', '긴 내쉼', 120, { stormRate: 0.5 }, '이제 폭풍이 두 배 자주 온다. 숲은 더 이상 숨을 참고 있지 않다.'],
  ],
  water: [
    ['Still Pond', '고요한 연못', 1, { offRate: 0.10 }, '수면엔 아무것도 움직이지 않는다. 그 아래 모든 것이 움직인다.'],
    ['Deep Well', '깊은 우물', 4, { dewH: 4 }, '네 시간이 더, 차갑고 안전하게 보관된다.'],
    ['Spring Rain', '봄비', 10, { rainChance: 2, rainPassive: 0.20 }, '그냥 똑바로 떨어지고, 꽃잎은 천천히 함께 내려온다.'],
    ['Tide Memory', '조수의 기억', 24, { offRate: 0.10 }, '물은 자신이 있던 곳을 기억한다. 숲도 그렇다.'],
    ['Reservoir of Ages', '태고의 저수지', 60, { dewH: 12 }, '반나절, 돌에 담겨, 불평 없이 기다린다.'],
    ['Everflow', '끊임없는 흐름', 120, { offFull: 1 }, '떠나 있든 함께 있든, 숲은 온 힘을 다해 일한다. 차이를 알아차리지 못한다.'],
  ],
  moon: [
    ['Moonwake', '달빛 각성', 1, { crit: 0.03 }, '달빛 아래 오래 일하면, 손이 좋은 가지가 어디인지 알게 된다.'],
    ['Silver Edge', '은빛의 날', 5, { critMult: 3 }, '날이 서 있는 흔들기.'],
    ["Hare's Luck", '달 토끼의 행운', 12, { goldRate: 0.75 }, '황금 꽃잎이 더 빨리 온다. 늘 오고 있었다.'],
    ['Full Moon Rite', '보름달 의식', 28, { moonCrit: 0.45 }, '한 달에 한 번, 온 계곡이 함께 운이 좋기로 합의한다.'],
    ['Tidefall', '조수의 낙하', 65, { crit: 0.08 }, '행운이 물처럼 온다. 한꺼번에, 밑에서부터.'],
    ['Lunar Mirror', '달의 거울', 120, { goldDouble: 1 }, '황금 꽃잎을 잡으면, 그 반영이 두 번째 은총을 준다.'],
  ],
  stone: [
    ['Set Stone', '놓인 돌', 2, { cost: 0.98 }, '처음에 바로 바로 놓았다. 그 뒤의 모든 것은 더 싸게 세워진다.'],
    ['Dry Wall', '마른 담', 6, { cost: 0.97 }, '회반죽 없음. 400년을 고집 하나로 버텼다.'],
    ['Old Path', '오래된 길', 14, { startTender: ['gatherer', 10] }, '계절이 바뀔 때 10명의 줍는 아이가 이미 그 길을 걷고 있다.'],
    ['Mason\u2019s Ledger', '석공의 장부', 30, { upCost: 0.85 }, '모든 개선이 정직하게 가격 매겨지고, 어쨌든 할인된다.'],
    ['Foundation Rite', '기반 의식', 70, { cost: 0.95 }, '동전 하나, 꽃잎 하나, 약속 하나를 묻는다. 가격이 내려간다. 아무도 이유를 묻지 않는다.'],
    ['Bedrock', '바위바닥', 120, { keepFirstTierUps: 1 }, '각 정령에 대한 첫 번째 개선이 계절의 전환을 거친 뒤에도 살아남는다.'],
  ],
  blossom: [
    ['Open Hand', '열린 손', 1, { click: 1.20 }, '가지를 움켜쥐는 것을 멈추고, 그에게 부탁하기 시작했다.'],
    ['Sympathetic Bloom', '공감하는 꽃', 4, { clickPassiveTerm: 0.0003 }, '숲이 클수록, 한 번 흔들기의 가치가 더 커진다.'],
    ['Second Hand', '두 번째 손', 11, { doubleShake: 0.25 }, '네 번 중 한 번의 흔들기가 두 번 들어간다. 어떻게 그렇게 되는지는 보려 하지 않는다.'],
    ['Hastened Spring', '성급한 봄', 26, { bloomThreshold: 0.8 }, '나무가 열려도 되는지 허락을 기다리지 않는다.'],
    ['Blossomheart', '꽃의 마음', 60, { click: 2 }, '나무껍질 위 손, 손목 안 나무의 맥박, 일치한다.'],
    ['영원한 꽃의 씨앗', '영원한 꽃의 씨앗', 120, { prod: 1.5 }, '처음으로 계절을 돌린 그 계절에 심겼다. 그 이후로 스스로 값을 벌고 있다.'],
  ],
};

export const CONSTELLATION = [];
for (const b of BRANCHES) {
  const rows = NODE_ROWS[b.id];
  rows.forEach((row, i) => {
    const [name, nameKo, cost, eff, flavour] = row;
    // Gentle zig-zag so the constellation reads as stars, not spokes.
    const spread = [0, -9, 8, -6, 7, 0][i];
    CONSTELLATION.push({
      id: `${b.id}${i + 1}`,
      branch: b.id,
      branchName: b.name,
      branchNameKo: b.nameKo,
      kanji: b.kanji,
      color: b.color,
      tier: i,
      name, nameKo, cost, eff, flavour,
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
  ['somei', '소메이 요시노', '소메이 요시노', '소메이', 3, '#FFD9E6', { passive: 1.02 },
    { seasonTotal: 1e3 }, '다섯 장의 옅은 꽃잎, 가장자리에 거의 흰빛. 이 나라의 모든 가로수는 한 그루의 복제본으로 심어졌고, 모든 봄에 같은 날에 함께 핀다.'],
  ['shidare', '시다레자쿠라', '시다레자쿠라', '시다레', 3, '#FFC6DC', { click: 1.03 },
    { tenderOwned: ['sprite', 25] }, ' weeping cherry. 가지가 물처럼 떨어지며 그 과정에서 꽃을 피운다. 북쪽에서 가장 오래된 것은 천 년 동안 기울어져 왔다.'],
  ['yae', '야에자쿠라', '야에자쿠라', '야에', 3, '#FFB6CE', { passive: 1.03 },
    { tenderOwned: ['miko', 10] }, '겹쳐 핀다 — 꽃 한 송이에 20, 30, 때로는 100장. 무거워서 가지가 끄덕인다. 더 많은 시간이 필요하다 듯이, 늦게 핀다.'],
  ['yama', '야마자쿠라', '야마자쿠라', '야마', 3, '#F6D3D8', { passive: 1.03 },
    { seasonTotal: 1e6 }, '산벗꽃, 그리고 옛 시들이 의미하는 그것. 구릿빛 잎이 꽃과 함께 열리므로, 온 언덕이 두 색깔로 동시에 바뀐다.'],
  ['oshima', '오시마자쿠라', '오시마자쿠라', '오시마', 4, '#FFF2F6', { click: 1.04 },
    { clicks: 1000 }, '희고, 꽃잎이 넓고, 희미하게 달다. 잎은 소금에 절여 콩과자로 감싼다. 나라의 절반이 매 봄 이 나무를 보지 않고 맛본다.'],
  ['kawazu', '카와즈자쿠라', '카와즈자쿠라', '카와즈', 4, '#F79EBD', { click: 1.04 },
    { golden: 3 }, '짙은 장밋빛, 그리고 조급하다 — 다른 것들이 아직 잠들어 있는 2월에 피고, 그 뒤로 한 달을 서리에게 도전하듯 꽃을 붙잡고 있는다.'],
  ['ukon', '우콘', '우콘', '우콘', 4, '#E7E2B0', { passive: 1.04 },
    { storms: 3 }, '옅은 황록색, 강황으로 들인 비단의 색. 나이를 먹으며 중앙이 분홍으로 바래진다. 꽃에게 잘못된 방향이지만 신경 쓰지 않는다.'],
  ['gyoiko', '교이고', '교이고', '교이고', 4, '#C8D8A8', { passive: 1.05 },
    { stage: 3 }, '초록이다. 진짜로 초록이다. 각 꽃잎 위로 붉은 줄무늬가 흐른다. 궁정의 법복 색이라서, 그 색을 가질 수 있는 게 그것밖에 없었다.'],
  ['jugatsu', '쥬가쓰자쿠라', '쥬가쓰자쿠라', '쥬가쓰', 4, '#FFE1EA', { click: 1.05 },
    { seasons: 1 }, '두 번 핀다: 10월에 한 차례 흩어지게, 봄에 나머지를. 이 배열을 설명한 적이 없고, 아무도 그것을 설득하지 못했다.'],
  ['fuyu', '후유자쿠라', '후유자쿠라', '후유', 5, '#EAF0FF', { prod: 1.04 },
    { offlineH: 3 }, '겨울의 벚꽃. 작고, 드문드문하며, 눈 속에서 꽃을 피운다 — 당신이 없는 동안에도 숲이 계속 일하고 있다는 증거.'],
  ['yoko', '요코', '요코', '요코', 5, '#FF9FBE', { prod: 1.05 },
    { crits: 100 }, '전쟁 후, 돌아오지 않은 학생들을 추모하기 위해 학교 선생님이 어디서든 자라날 무언가를 만들었다. 선명한 분홍, 강인함, 지금은 어디에나 있다.'],
  ['everblossom', '영원한 꽃', '영원한 꽃', '영원', 5, '#FFEFC2', { prod: 1.25 },
    { stage: 5 }, '어느 식물 도감에도 없다. 나뭇결에 금이, 낙하에는 오로라가, 그리고 휴면기가 전혀 없다. 당신은 이 모든 시간 동안 그것을 키우고 있었다.'],
].map(([id, name, nameKo, kanji, rarity, tint, eff, req, desc]) => ({
  id, name, nameKo, kanji, rarity, tint, eff, req, desc,
}));
export const CODEX_BY_ID = Object.fromEntries(CODEX.map((c) => [c.id, c]));

/* ==================================================================== *
 * 9. Achievements — 44, each +1% global production and +1 Blossom
 * ==================================================================== */

const ach = (id, name, nameKo, desc, req) => ({ id, name, nameKo, desc, req });

export const ACHIEVEMENTS = [
  // — clicking (6)
  ach('a_click1', 'First Shake', '첫 흔들기', '나무를 한 번 흔든다.', { clicks: 1 }),
  ach('a_click2', 'Hanami Habit', '벚꽃 놀이 습관', '나무를 100번 흔든다.', { clicks: 100 }),
  ach('a_click3', 'Repetitive Strain', '반복성 손상', '나무를 1,000번 흔든다.', { clicks: 1000 }),
  ach('a_click4', 'The Gardener\u2019s Wrist', '정원사의 손목', '나무를 10,000번 흔든다.', { clicks: 1e4 }),
  ach('a_click5', 'Bark Polisher', '나무껍질 닦는 사람', '나무를 100,000번 흔든다.', { clicks: 1e5 }),
  ach('a_click6', 'One With The Branch', '가지와 하나됨', '나무를 백만 번 흔든다.', { clicks: 1e6 }),
  // — crits (2)
  ach('a_crit1', 'Lucky Break', '행운의 균기', '치명타 100회 성공.', { crits: 100 }),
  ach('a_crit2', 'Fortune Favours', '행운의 편', '치명타 5,000회 성공.', { crits: 5000 }),
  // — petals earned (7)
  ach('a_pet1', 'A Thousand Petals', '천 개의 꽃잎', '한 계절에 1,000 꽃잎 획득.', { seasonTotal: 1e3 }),
  ach('a_pet2', 'Drift', '흘러감', '한 계절에 100,000 꽃잎 획득.', { seasonTotal: 1e5 }),
  ach('a_pet3', 'Snowfall in Spring', '봄의 폭설', '한 계절에 백만 꽃잎 획득.', { seasonTotal: 1e6 }),
  ach('a_pet4', 'Petal Sea', '꽃잎의 바다', '한 계절에 1억 꽃잎 획득.', { seasonTotal: 1e8 }),
  ach('a_pet5', 'The Pink Tide', '분홍 밀물', '한 계절에 100억 꽃잎 획득.', { seasonTotal: 1e10 }),
  ach('a_pet6', 'Weather System', '기상 체계', '전 생애에 1조 꽃잎 획득.', { allTime: 1e12 }),
  ach('a_pet7', 'Cosmic Fall', '우주적 낙하', '전 생애에 1경 꽃잎 획득.', { allTime: 1e15 }),
  // — tenders owned, total (6)
  ach('a_ten1', 'A Helping Hand', '도우미 한 손', '정령 10명 보유.', { totalTenders: 10 }),
  ach('a_ten2', 'Small Staff', '작은 직원', '정령 50명 보유.', { totalTenders: 50 }),
  ach('a_ten3', 'The Grove Employs', '숲의 고용', '정령 100명 보유.', { totalTenders: 100 }),
  ach('a_ten4', 'Full Roster', '충원된 명부', '정령 200명 보유.', { totalTenders: 200 }),
  ach('a_ten5', 'Standing Army of Spring', '봄의 상비군', '정령 400명 보유.', { totalTenders: 400 }),
  ach('a_ten6', 'Everyone Is Here', '모두 여기 있다', '모든 정령을 최소 1명씩 보유.', { oneOfEach: 1 }),
  // — specific tenders (5)
  ach('a_sp1', 'Swarm', '떼', '바람 정령 100명 보유.', { tenderOwned: ['sprite', 100] }),
  ach('a_sp2', 'Basket Economy', '바구니 경제', '꽃잎 줍는 아이 100명 보유.', { tenderOwned: ['gatherer', 100] }),
  ach('a_sp3', 'Lit From Below', '아래에서 밝히다', '석등롱 50개 보유.', { tenderOwned: ['lantern', 50] }),
  ach('a_sp4', 'Nine Tails Each', '아홉 꼬리씩', '여우 사자 25명 보유.', { tenderOwned: ['kitsune', 25] }),
  ach('a_sp5', 'Reaching', '손 닿는 곳', '하늘의 가지 10개 보유.', { tenderOwned: ['bough', 10] }),
  // — milestones (2)
  ach('a_mil1', 'Round Number', '둥근 숫자', '어떤 정령이든 10명 보유에 도달.', { anyMilestone: 10 }),
  ach('a_mil2', 'Sixty-Four Times', '64배', '어떤 정령이든 200명 보유에 도달.', { anyMilestone: 200 }),
  // — upgrades (3)
  ach('a_up1', 'Improvements', '개선', '업그레이드 10개 구매.', { upgrades: 10 }),
  ach('a_up2', 'Renovation', '리모델링', '업그레이드 40개 구매.', { upgrades: 40 }),
  ach('a_up3', 'Nothing Left To Fix', '고칠 게 없다', '업그레이드 70개 구매.', { upgrades: 70 }),
  // — bloom stages (2)
  ach('a_bl1', 'Full Bloom', '만개', '만개에 도달.', { stage: 3 }),
  ach('a_bl2', '영원한 꽃', '영원한 꽃', '영원한 꽃에 도달.', { stage: 5 }),
  // — seasons (4)
  ach('a_se1', 'Turn of the Season', '계절의 전환', '계절을 1번 돌린다.', { seasons: 1 }),
  ach('a_se2', 'Three Springs', '세 개의 봄', '계절을 3번 돌린다.', { seasons: 3 }),
  ach('a_se3', 'Decade of Blossom', '꽃의 10년', '계절을 10번 돌린다.', { seasons: 10 }),
  ach('a_se4', 'The Long Cycle', '긴 순환', '계절을 25번 돌린다.', { seasons: 25 }),
  // — golden petals / storms / varieties (6)
  ach('a_go1', 'Caught One', '하나 잡았다', '황금 꽃잎을 잡는다.', { golden: 1 }),
  ach('a_go2', 'Sharp Eyes', '날카로운 눈', '황금 꽃잎 10개 잡기.', { golden: 10 }),
  ach('a_go3', 'Nothing Escapes You', '아무도 빠져나가지 못한다', '황금 꽃잎 50개 잡기.', { golden: 50 }),
  ach('a_st1', 'Rode the Storm', '폭풍을 탔다', '꽃보라 폭풍을 겪는다.', { storms: 1 }),
  ach('a_st2', 'Storm Season', '폭풍의 계절', '꽃보라 폭풍 10회 겪기.', { storms: 10 }),
  ach('a_cx1', 'Botanist', '식물학자', '도감에 6종류 기록.', { codex: 6 }),
  // — secret / joke (5)
  ach('a_sx1', 'Patience', '인내', '5분 동안 나무를 흔들지 않고 보낸다.', { idle: 300 }, true),
  ach('a_sx2', 'The Long Way Home', '집까지 먼 길', '12시간 넘게 떠난 후 돌아온다.', { offlineH: 12 }, true),
  ach('a_sx3', 'Frugal', '검약', '8개 미만의 업그레이드를 산 채, 한 계절에 백만 꽃잎에 도달.', { frugal: 1 }, true),
  ach('a_sx4', 'Insomnia', '불면증', '밤에 숲에 있다.', { night: 1 }, true),
  ach('a_sx5', 'Ninety-Nine', '아흔아홉', '어떤 정령이든 정확히 99명 보유. 일부러.', { tenderExact: 99 }, true),
].map((a, i) => ({ ...a, secret: a.id.startsWith('a_sx'), index: i }));

/* ==================================================================== *
 * 10. Live events + Golden Petal boons
 * ==================================================================== */

export const LIVE_EVENTS = {
  storm: { id: 'storm', name: '꽃보라 폭풍', nameKo: '꽃보라 폭풍', kanji: '꽃보라', color: '#FFC2D6', desc: '초당 ×10 꽃잎. 언덕 전체가 공기 중에 떠 있다.' },
  moon: { id: 'moon', name: '보름달', nameKo: '보름달', kanji: '보름', color: '#C9D6FF', desc: '달이 떠 있는 동안 +25% 치명타 확률.' },
  golden: { id: 'golden', name: '황금빛 시간', nameKo: '황금빛 시간', kanji: '황금', color: '#FFD08A', desc: '빛이 머무는 동안 모든 흔들기에 +15%.' },
  rain: { id: 'rain', name: '봄비', nameKo: '봄비', kanji: '봄비', color: '#A8C8E0', desc: '초당 꽃잎 +10%, 그리고 꽃잎은 천천히 흘러내린다.' },
};

export const GOLDEN_BOONS = [
  { id: 'frenzy', name: '광란의 꽃', nameKo: '광란의 꽃', kanji: '광란', weight: 34, dur: 30, color: '#FFD46A',
    desc: '30초 동안 초당 ×7 꽃잎.' },
  { id: 'lucky', name: '행운', nameKo: '행운', kanji: '행운', weight: 34, dur: 0, color: '#FFE9A8',
    desc: '현재 보유량의 +13%를 즉시 획득.' },
  { id: 'clickfrenzy', name: '연타 광란', nameKo: '연타 광란', kanji: '연타', weight: 20, dur: 13, color: '#FFC0D8',
    desc: '13초 동안 한 번 흔들기에 ×77.' },
  { id: 'bloomfall', name: '만개 강우', nameKo: '만개 강우', kanji: '만개비', weight: 12, dur: 6, color: '#FFF0C8',
    desc: '1분 동안의 꽃잎이 한꺼번에, 잡을 수 있는 곳으로 떨어진다.' },
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
