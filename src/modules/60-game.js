import * as THREE from 'three';
import { WIND } from '../lib/wind.js';
import { mulberry32 } from '../lib/rng.js';
import * as E from '../lib/economy.js';

/**
 * 60-game — the whole idle simulation. Owner: game agent.
 *
 * This module owns STATE ONLY. It never touches the scene graph, never creates
 * a material, never writes DOM. `65-ui.js` renders it, `45-vfx.js` animates it,
 * `70-audio.js` sounds it — all through `ctx.bus` and `ctx.assets.game`.
 *
 * Simulation runs on a FIXED 20 Hz accumulator, so it is frame-rate independent
 * and bit-identical in shot mode (where dt is exactly 1/60).
 *
 * Emits:  state:changed, petals:gain, petals:burst, upgrade:bought, bloom:stage,
 *         sfx, and the game-prefixed set:
 *         game:event {id,active,remain,dur}     — Storm / Rain / Moon / Golden Hour
 *         game:golden {id,ttl,seed}             — spawn a Golden Petal (VFX owns the mesh)
 *         game:golden:end {id,caught,boon}
 *         game:stageup {stage,name,kanji,blossoms}
 *         game:offline {awayS,cappedS,gained,stages}
 *         game:prestige {season,essence,gain}
 *         game:toast {kind,title,body,rarity}   — achievements / codex / boons
 *         game:reset
 *
 * Listens: world:click, tree:clicked, time:phase.
 */

const STEP = 1 / E.TUNING.SIM_HZ;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Semantic game moment → the id 70-audio's SFX table actually synthesises.
 * Unknown ids fall through audio's `default: break`, so the old semantic names
 * ('buy', 'milestone', 'prestige', …) were silent: buying — the entire loop of
 * a clicker — made no sound at all. Two moments are deliberately absent
 * (`stage-up`, `golden-catch`): 45-vfx already emits 'stageup' / 'golden' from
 * its own set pieces, and emitting them here as well double-triggers them.
 */
const SFX_ID = {
  milestone: 'achievement',
  codex: 'achievement',
  achievement: 'achievement',
  'storm-start': 'storm',
  prestige: 'stageup',
};

/**
 * `upgrade:bought.tier` is a NUMBER, 1..5. It used to be the family string
 * ('tender' / 'shake' / 'heartwood' / …) and both consumers compare it
 * numerically — 70-audio picks its sound with `(e.tier ?? 0) >= 2` and 45-vfx
 * fires an extra petal burst on `>= 4`. `'tender' >= 2` is false for every
 * string, so every purchase in the game, from a 15-petal Wind Sprite to a
 * 120-Essence Constellation node, produced the identical small `purchase` tok
 * and never the burst. Numbers here, family name in `family` for anyone who
 * wants the word.
 *
 * The ranks are chosen so the two thresholds already in those modules mean
 * something: 2 crosses into audio's bigger `upgrade` sound, 4 crosses into
 * VFX's petal burst — i.e. the two permanent currencies.
 */
const BUY_RANK = {
  tender: 1,        // a Tender, bought with petals
  milestone: 3,     // a Tender purchase that crossed a ×2 milestone
  shake: 2,         // petal Upgrades
  grove: 2,
  tenderUp: 2,
  heartwood: 4,     // Blossoms — permanent, survives the Season
  constellation: 5, // Essence — the deepest thing money can buy
};

export default {
  name: 'game',
  order: 60,

  async setup(ctx) {
    const bus = ctx.bus;
    const persist = !ctx.shotMode && typeof localStorage !== 'undefined';

    /**
     * One sound, once, under a name 70-audio can synthesise — and at most one of
     * each synth per frame.
     *
     * Unlocks arrive in clumps: taking a Tender to 10 owned crosses a milestone
     * AND unlocks 'Round Number' AND 'A Helping Hand' in the same frame, so the
     * same `achievement` synth fired three times a fraction of a millisecond
     * apart. Identical short transients stacked like that comb-filter into a
     * metallic flam instead of getting louder — the same defect the shake fix
     * removed. First one in the frame wins, with a small lift so a clump still
     * reads as bigger than a single unlock. The toast queue in 65-ui already
     * does the visual half of this ("queued so they never overlap").
     */
    let sfxFrame = -1;
    const sfxThisFrame = new Set();
    function snd(id, gain = 1) {
      const mapped = SFX_ID[id];
      if (!mapped) return;
      if (sfxFrame !== ctx.frame) { sfxFrame = ctx.frame; sfxThisFrame.clear(); }
      if (sfxThisFrame.has(mapped)) return;
      sfxThisFrame.add(mapped);
      bus.emit('sfx', { id: mapped, gain: Math.min(1.2, gain * 1.08), tag: id });
    }

    /* ---------------------------------------------------------------- *
     * state
     * ---------------------------------------------------------------- */
    /**
     * A fresh save gets its own RNG seed — except under the screenshot harness.
     *
     * `E.newState()` defaults to a single hard-coded seed, and 60-game used it
     * unconditionally, so EVERY new player got a bit-identical stream: the same
     * storm times, the same Golden Petal boons in the same order, the same crit
     * rolls. Two problems with that. It is not a random event schedule in any
     * meaningful sense — two players comparing notes would see the same run.
     * And it pinned the shipped pacing to one sample of the RNG: measured across
     * 40 seeds, that particular one sits at the 10th percentile for speed
     * (初咲 First Bloom 312 s against a 563 s median, 満開 1242 s against 1824 s),
     * so the balance every real player experienced was the fastest tenth of the
     * distribution while the simulator was being tuned on the middle of it.
     *
     * `ctx.shotMode` keeps the fixed seed, so every screenshot and every probe
     * stays byte-comparable (CONTRACT §5) — the critics depend on that. Only a
     * real browser session rolls its own, and it is persisted in the save, so a
     * player's grove behaves consistently for them across sessions.
     */
    const freshSeed = () => (ctx.shotMode
      ? undefined
      : ((Date.now() >>> 0) ^ 0x9e3779b9) >>> 0);

    let state = E.newState(freshSeed());
    let loadedSave = null;
    if (persist) {
      try {
        const raw = localStorage.getItem(E.SAVE_KEY);
        if (raw) loadedSave = E.migrate(JSON.parse(raw));
      } catch { loadedSave = null; }
      if (loadedSave) state = loadedSave;
    }

    /** Seeded stream for crits, event timing and Golden Petal drops. */
    let rng = mulberry32((state.seed | 0) ^ 0x5a4b12);
    const rand = () => rng();

    /* live (non-persisted) runtime -------------------------------------- */
    const timers = { storm: 0, rain: 0, frenzy: 0, clickFrenzy: 0, bloomfall: 0 };
    let bloomfallRate = 0;
    let bloomfallBurst = 0;
    let phase = 'day';

    /**
     * Event countdowns. Restored from the save when it has them (v4+), rolled
     * fresh when it does not — see economy.newSchedule(). The FIRST storm of a
     * save uses the short STORM_FIRST grace so a new player meets the set piece
     * inside two minutes; every later one uses the spec'd 420 ± 120.
     */
    const rollStorm = (first) => (first
      ? E.TUNING.STORM_FIRST + (rand() * 2 - 1) * E.TUNING.STORM_FIRST_JITTER
      : E.TUNING.STORM_PERIOD + (rand() * 2 - 1) * E.TUNING.STORM_JITTER);
    const rollGolden = () => E.TUNING.GOLDEN_MIN
      + rand() * (E.TUNING.GOLDEN_MAX - E.TUNING.GOLDEN_MIN);

    let nextStorm = 0;
    let nextGolden = 0;
    let rainRoll = 0;
    /** Adopt `state.sched`, rolling anything it does not carry. */
    function loadSchedule() {
      nextStorm = state.sched?.storm ?? rollStorm((state.stats?.storms || 0) === 0);
      nextGolden = state.sched?.golden ?? rollGolden();
      rainRoll = state.sched?.rain ?? 0;
    }
    loadSchedule();
    let golden = null;              // { id, ttl }
    let goldenSeq = 1;
    let autoAcc = 0;
    let idleFor = 0;
    let windBase = null;            // wind strength before a storm grabbed it
    let acc = 0;
    let saveAcc = 0;
    let emitAcc = 0;
    let wallLast = typeof Date !== 'undefined' ? Date.now() : 0;
    let offlineReport = null;

    const live = { storm: false, rain: false, moon: false, goldenHour: false, frenzy: false, clickFrenzy: false };

    /* derived cache ----------------------------------------------------- */
    let D = E.computeDerived(state, live);
    let dirty = false;
    const invalidate = () => { dirty = true; };
    function derived() {
      if (dirty) { D = E.computeDerived(state, live); dirty = false; }
      return D;
    }

    /* scratch vectors — never allocate per click in a hot path */
    const _v = new THREE.Vector3();

    function treePoint() {
      const tree = ctx.assets.tree;
      if (tree?.sampleBranchPoint) {
        try { return tree.sampleBranchPoint(rand()).point; } catch { /* fallthrough */ }
      }
      return _v.set(0, 8.5, 0).clone();
    }

    /* ---------------------------------------------------------------- *
     * currency
     * ---------------------------------------------------------------- */
    function credit(amount) {
      if (!(amount > 0)) return;
      state.petals += amount;
      state.totalThisSeason += amount;
      state.totalAllTime += amount;
      if (state.petals > state.stats.bestBank) state.stats.bestBank = state.petals;
      invalidate();
    }

    function spend(cost) {
      if (!(state.petals >= cost)) return false;
      state.petals -= cost;
      invalidate();
      return true;
    }

    /* ---------------------------------------------------------------- *
     * clicking
     * ---------------------------------------------------------------- */
    /**
     * Re-entrancy latch. `shake()` broadcasts `tree:clicked` so VFX/audio can
     * react to a Space-bar or auto shake, and this module ALSO listens to
     * `tree:clicked` (that is how a click on the trunk mesh becomes income).
     * Without a latch the broadcast walks straight back into shake() and the
     * click pays twice — one shake used to net 2 petals while the HUD read
     * "1 / shake", and it fired two bursts and two overlapping click sounds.
     * The `__fromGame` tag on the emitted event is the first line of defence;
     * this latch is the second, so no third-party echo of `tree:clicked` can
     * ever reintroduce the double-pay.
     */
    let inShake = false;

    function shake(point, opts = {}) {
      if (inShake) return { amount: 0, crit: false, reentrant: true };
      inShake = true;
      try { return shakeOnce(point, opts); } finally { inShake = false; }
    }

    function shakeOnce(point, opts = {}) {
      const d = derived();
      const auto = !!opts.auto;
      const power = auto ? (d.grove.autoFull ? 1 : 0.5) : 1;
      let amount = d.clickValue * power;

      let crit = false;
      if (!auto || d.grove.autoFull) {
        crit = rand() < d.critChance;
        if (crit) amount *= d.critMult;
      }
      // Constellation "Second Hand" — one shake in four lands twice.
      let twice = false;
      if (d.grove.doubleShake > 0 && rand() < d.grove.doubleShake) { amount *= 2; twice = true; }

      credit(amount);
      state.stats.clicks += 1;
      state.stats.seasonClicks += 1;
      if (crit) state.stats.crits += 1;
      if (!auto) idleFor = 0;

      const p = point || treePoint();
      if (opts.emitTreeClick !== false) {
        // __fromGame: this is the game telling the world a shake happened, NOT
        // a fresh click to be scored. Our own listener skips it.
        bus.emit('tree:clicked', {
          point: p.clone ? p.clone() : p, worldNormal: null,
          power: crit ? 2 : 1, __fromGame: true,
        });
      }
      bus.emit('petals:gain', { amount, point: p, crit });
      bus.emit('petals:burst', {
        point: p,
        count: Math.round((crit ? 46 : 14) * (twice ? 1.4 : 1) * (auto ? 0.5 : 1)),
        power: crit ? 1.8 : twice ? 1.25 : 1,
      });
      // No `sfx` for the shake itself. 70-audio already derives BOTH sounds
      // from events that exist exactly once per shake — the leaf-rustle/tok
      // from `tree:clicked` and the crit chime from `petals:gain.crit`. Adding
      // an `sfx` on top layered a second rustle a few ms late on every click,
      // which is the comb-filtered "phasing" the review heard.
      pushState();
      return { amount, crit };
    }

    /* ---------------------------------------------------------------- *
     * purchasing
     * ---------------------------------------------------------------- */
    function tenderPrice(id, count = 1) {
      const d = derived();
      const owned = state.tenders[id] || 0;
      return E.tenderBulkCost(id, owned, count, d.costMul);
    }

    function resolveCount(id, count) {
      if (count === 'max' || count === -1) {
        const d = derived();
        return Math.max(1, E.tenderMaxAffordable(id, state.tenders[id] || 0, state.petals, d.costMul));
      }
      return Math.max(1, Math.floor(count || 1));
    }

    function canAfford(id, count = 1) {
      if (E.TENDER_BY_ID[id]) return state.petals >= tenderPrice(id, resolveCount(id, count));
      const u = E.UPGRADE_BY_ID[id];
      if (u) return state.petals >= upgradePrice(u) && E.upgradeUnlocked(u, state) && !state.upgrades[id];
      const n = E.NODE_BY_ID[id];
      if (n) return state.essence >= n.cost && nodeUnlocked(n) && !state.nodes[id];
      const h = E.HEARTWOOD_BY_ID[id];
      if (h) return state.blossoms >= h.cost && !state.heartwood[id];
      return false;
    }

    /** Buy a Tender. `count` may be a number or 'max'. Returns how many landed. */
    function buy(id, count = 1) {
      const t = E.TENDER_BY_ID[id];
      if (!t) return 0;
      const d = derived();
      const n = resolveCount(id, count);
      const cost = E.tenderBulkCost(id, state.tenders[id] || 0, n, d.costMul);
      if (!spend(cost)) return 0;
      const before = state.tenders[id] || 0;
      state.tenders[id] = before + n;
      if (state.tenders[id] > state.stats.maxTender) state.stats.maxTender = state.tenders[id];
      invalidate();
      const crossed = E.MILESTONES.some((m) => before < m && state.tenders[id] >= m);
      bus.emit('upgrade:bought', {
        id, level: state.tenders[id], count: n, milestone: crossed,
        tier: crossed ? BUY_RANK.milestone : BUY_RANK.tender, family: 'tender',
      });
      // No `sfx` for the purchase itself — 70-audio derives one `purchase` tok
      // straight from `upgrade:bought`. Emitting one here as well layered a
      // second identical tok a few ms late, which is the same comb-filter
      // phasing the shake fix removed. Only the milestone chime is additional.
      if (crossed) snd('milestone', 1);
      if (crossed) {
        bus.emit('petals:burst', { point: treePoint(), count: 60, power: 1.4 });
        bus.emit('game:toast', {
          kind: 'milestone', title: `${t.nameKo ?? t.name} ×${E.milestoneMult(state.tenders[id])}`,
          body: `${state.tenders[id]}명이 숲을 돌봅니다. 산출량이 두 배가 되었습니다.`, rarity: 4,
        });
      }
      checkUnlocks();
      pushState(true);
      return n;
    }

    function upgradePrice(u) {
      const d = derived();
      return u.family === 'grove' ? u.cost : u.cost * d.upCostMul;
    }

    function buyUpgrade(id) {
      const u = E.UPGRADE_BY_ID[id];
      if (!u || state.upgrades[id] || !E.upgradeUnlocked(u, state)) return false;
      if (!spend(upgradePrice(u))) return false;
      state.upgrades[id] = 1;
      state.stats.upgrades = Object.keys(state.upgrades).length;
      invalidate();
      bus.emit('upgrade:bought', { id, level: 1, tier: BUY_RANK[u.family] ?? 2, family: u.family });
      bus.emit('game:toast', { kind: 'upgrade', title: u.nameKo ?? u.name, body: u.flavour, rarity: 3 });
      checkUnlocks();
      pushState(true);
      return true;
    }

    function nodeUnlocked(n) {
      return !n.req || !!state.nodes[n.req];
    }

    function buyNode(id) {
      const n = E.NODE_BY_ID[id];
      if (!n || state.nodes[id] || !nodeUnlocked(n)) return false;
      if (state.essence < n.cost) return false;
      state.essence -= n.cost;         // essenceEarned is untouched: spent Essence still pays out
      state.nodes[id] = 1;
      invalidate();
      bus.emit('upgrade:bought', { id, level: 1, tier: BUY_RANK.constellation, family: 'constellation' });
      bus.emit('game:toast', { kind: 'node', title: `${n.branchNameKo ?? n.branchName} · ${n.nameKo ?? n.name}`, body: n.flavour, rarity: 5 });
      pushState(true);
      return true;
    }

    function buyHeartwood(id) {
      const h = E.HEARTWOOD_BY_ID[id];
      if (!h || state.heartwood[id] || state.blossoms < h.cost) return false;
      state.blossoms -= h.cost;
      state.heartwood[id] = 1;
      invalidate();
      bus.emit('upgrade:bought', { id, level: 1, tier: BUY_RANK.heartwood, family: 'heartwood' });
      bus.emit('game:toast', { kind: 'heartwood', title: h.nameKo ?? h.name, body: h.flavour, rarity: 5 });
      pushState(true);
      return true;
    }

    /* ---------------------------------------------------------------- *
     * bloom stages
     * ---------------------------------------------------------------- */
    /**
     * Recompute the bloom stage from total-petals-this-season and push it.
     *
     * `state.stageFloor` is passed on EVERY derive (see economy.stageFor). A
     * fresh save floors at 1 蕾 Budding, so no recompute — boot, offline, import,
     * scenario rebuild — can ever snap a new player back to bare branches. After
     * a Season turn the floor drops to 0 and stage 0 is reachable again.
     */
    function applyStage(quiet = false) {
      const d = derived();
      const s = E.stageFor(state.totalThisSeason, d.grove.bloomThreshold, state.stageFloor | 0);
      if (s === state.stage) return null;
      const up = s > state.stage;
      const from = state.stage;
      state.stage = s;
      bus.emit('bloom:stage', { stage: s });
      if (up) {
        let blossoms = 0;
        for (let i = from + 1; i <= s; i++) blossoms += i * 3;
        state.blossoms += blossoms;
        const info = E.BLOOM_STAGES[s];
        if (!quiet) {
          bus.emit('game:stageup', { stage: s, name: info.name, kanji: info.kanji, blurb: info.blurb, blossoms });
          bus.emit('petals:burst', { point: treePoint(), count: 220, power: 2.4 });
          // 45-vfx's stageUp set piece emits 'stageup' itself — one only.
        }
      }
      invalidate();
      return s;
    }

    /* ---------------------------------------------------------------- *
     * codex + achievements
     * ---------------------------------------------------------------- */
    function reqMet(r) {
      const st = state.stats;
      if (!r) return false;
      if (r.clicks !== undefined) return st.clicks >= r.clicks;
      if (r.crits !== undefined) return st.crits >= r.crits;
      if (r.seasonTotal !== undefined) return state.totalThisSeason >= r.seasonTotal;
      if (r.allTime !== undefined) return state.totalAllTime >= r.allTime;
      if (r.stage !== undefined) return state.stage >= r.stage;
      if (r.seasons !== undefined) return state.season >= r.seasons;
      if (r.golden !== undefined) return st.golden >= r.golden;
      if (r.storms !== undefined) return st.storms >= r.storms;
      if (r.offlineH !== undefined) return st.offlineH >= r.offlineH;
      if (r.codex !== undefined) return Object.keys(state.codex).length >= r.codex;
      if (r.upgrades !== undefined) return Object.keys(state.upgrades).length >= r.upgrades;
      if (r.anyMilestone !== undefined) return st.maxTender >= r.anyMilestone;
      if (r.night !== undefined) return st.night >= r.night;
      if (r.idle !== undefined) return st.idle >= r.idle;
      if (r.frugal !== undefined) {
        return state.totalThisSeason >= 1e6 && Object.keys(state.upgrades).length < 8;
      }
      if (r.tenderExact !== undefined) {
        for (const id of E.TENDER_IDS) if (state.tenders[id] === r.tenderExact) return true;
        return false;
      }
      if (r.tenderOwned) return (state.tenders[r.tenderOwned[0]] || 0) >= r.tenderOwned[1];
      if (r.totalTenders !== undefined) {
        let tot = 0; for (const id of E.TENDER_IDS) tot += state.tenders[id] || 0;
        return tot >= r.totalTenders;
      }
      if (r.oneOfEach !== undefined) return E.TENDER_IDS.every((id) => (state.tenders[id] || 0) > 0);
      return false;
    }

    function checkUnlocks(quiet = false) {
      // Codex first, then achievements: "Botanist" counts Codex entries, so the
      // other order unlocks it one pass late — which leaks a toast out of a
      // scenario that was meant to be silent. Repeat until nothing new lands.
      let changed = false;
      for (let pass = 0; pass < 3; pass++) if (!unlockPass(quiet)) break; else changed = true;
      if (changed) invalidate();
      return changed;
    }

    function unlockPass(quiet) {
      let changed = false;
      for (const c of E.CODEX) {
        if (state.codex[c.id] || !reqMet(c.req)) continue;
        state.codex[c.id] = 1;
        state.blossoms += 2;
        changed = true;
        if (!quiet) {
          bus.emit('game:codex', { id: c.id, ...c });
          bus.emit('game:toast', { kind: 'codex', title: `${c.kanji} ${c.nameKo ?? c.name}`, body: c.desc, rarity: c.rarity });
          snd('codex', 1);
        }
      }
      for (const a of E.ACHIEVEMENTS) {
        if (state.achievements[a.id] || !reqMet(a.req)) continue;
        state.achievements[a.id] = 1;
        state.blossoms += 1;
        changed = true;
        if (!quiet) {
          bus.emit('game:toast', { kind: 'achievement', title: a.nameKo ?? a.name, body: a.desc, rarity: a.secret ? 5 : 4 });
          snd('achievement', 0.9);
        }
      }
      return changed;
    }

    /* ---------------------------------------------------------------- *
     * live events
     * ---------------------------------------------------------------- */
    function setLive() {
      const before = live.storm + live.rain * 2 + live.moon * 4 + live.goldenHour * 8
        + live.frenzy * 16 + live.clickFrenzy * 32;
      live.storm = timers.storm > 0;
      live.rain = timers.rain > 0;
      live.frenzy = timers.frenzy > 0;
      live.clickFrenzy = timers.clickFrenzy > 0;
      live.moon = phase === 'night';
      live.goldenHour = phase === 'dusk';
      const after = live.storm + live.rain * 2 + live.moon * 4 + live.goldenHour * 8
        + live.frenzy * 16 + live.clickFrenzy * 32;
      if (before !== after) invalidate();
      return before !== after;
    }

    function startStorm() {
      const d = derived();
      timers.storm = E.TUNING.STORM_DURATION * d.grove.stormDur;
      state.stats.storms += 1;
      if (windBase === null) windBase = WIND.uniforms.uWindStrength.value;
      WIND.uniforms.uWindStrength.value = windBase * E.TUNING.STORM_WIND;
      setLive();
      bus.emit('game:event', { id: 'storm', active: true, dur: timers.storm, remain: timers.storm, mult: d.grove.stormMult });
      bus.emit('petals:burst', { point: treePoint(), count: 300, power: 2.6 });
      snd('storm-start', 1);
      bus.emit('game:toast', {
        kind: 'event', title: '花嵐  꽃보라 폭풍', rarity: 5,
        body: `언덕 전체가 공기 중에 떠 있습니다. ${Math.round(timers.storm)}초 동안 ×${E.format(d.grove.stormMult)}.`,
      });
      checkUnlocks();
    }

    function endStorm() {
      timers.storm = 0;
      if (windBase !== null) { WIND.uniforms.uWindStrength.value = windBase; windBase = null; }
      setLive();
      bus.emit('game:event', { id: 'storm', active: false, remain: 0 });
      snd('storm-end', 0.6);
    }

    function startRain() {
      timers.rain = E.TUNING.RAIN_DURATION;
      setLive();
      bus.emit('game:event', { id: 'rain', active: true, dur: timers.rain, remain: timers.rain });
      snd('rain-start', 0.7);
      bus.emit('game:toast', { kind: 'event', title: '春雨  봄비', body: '낙화가 천천히 흘러내립니다. 지속되는 동안 +10%.', rarity: 3 });
    }

    /* ---- Golden Petal ---------------------------------------------- */
    function spawnGolden() {
      const d = derived();
      const ttl = E.TUNING.GOLDEN_TTL * d.grove.goldTtl;
      golden = { id: goldenSeq++, ttl };
      bus.emit('game:golden', { id: golden.id, ttl, seed: Math.floor(rand() * 1e9) });
      snd('golden-appear', 0.8);
    }

    function rollBoon() {
      let tot = 0;
      for (const b of E.GOLDEN_BOONS) tot += b.weight;
      let r = rand() * tot;
      for (const b of E.GOLDEN_BOONS) { r -= b.weight; if (r <= 0) return b; }
      return E.GOLDEN_BOONS[0];
    }

    function applyBoon(b) {
      const d = derived();
      if (b.id === 'frenzy') timers.frenzy = Math.max(timers.frenzy, b.dur);
      else if (b.id === 'clickfrenzy') timers.clickFrenzy = Math.max(timers.clickFrenzy, b.dur);
      else if (b.id === 'lucky') {
        const cap = d.baseRate * 1200;                    // 20 minutes of passive
        const amt = Math.max(Math.min(state.petals * 0.13, cap), d.clickValue * 20);
        credit(amt);
        bus.emit('petals:gain', { amount: amt, point: treePoint(), crit: true });
      } else if (b.id === 'bloomfall') {
        bloomfallRate = (d.baseRate * 60) / b.dur;
        timers.bloomfall = b.dur;
      }
      setLive();
      bus.emit('game:toast', { kind: 'boon', title: `${b.kanji}  ${b.nameKo ?? b.name}`, body: b.desc, rarity: 5 });
      snd('golden-catch', 1);
    }

    /**
     * A caught Golden Petal pays out here and nowhere else.
     *
     * Guarded by frame, not by the logical petal, because the visible petal and
     * the logical one are owned by different modules: 45-vfx renders its own
     * drifting mesh on its own schedule and reports the catch as `vfx:golden`
     * {kind:'caught'}, while `world:click` on a mesh tagged `userData.goldenId`
     * is the other route in. Whichever arrives first pays; anything else in the
     * same frame is the same catch seen twice.
     */
    let goldenPaidFrame = -1;

    function grantGolden(gid) {
      if (goldenPaidFrame === ctx.frame) return false;
      goldenPaidFrame = ctx.frame;
      const d = derived();
      state.stats.golden += 1;
      const boons = [rollBoon()];
      if (d.grove.goldDouble) {
        let alt = rollBoon();
        for (let i = 0; i < 4 && alt.id === boons[0].id; i++) alt = rollBoon();
        boons.push(alt);
      }
      for (const b of boons) applyBoon(b);
      bus.emit('petals:burst', { point: treePoint(), count: 120, power: 2 });
      golden = null;
      bus.emit('game:golden:end', { id: gid, caught: true, boons: boons.map((b) => b.id) });
      checkUnlocks();
      pushState(true);
      return true;
    }

    function catchGolden(id) {
      if (!golden || (id !== undefined && id !== golden.id)) return false;
      return grantGolden(golden.id);
    }

    /* ---------------------------------------------------------------- *
     * prestige
     * ---------------------------------------------------------------- */
    function essencePreview() {
      const d = derived();
      return E.essenceGain(state.totalThisSeason, d.grove.essenceMul);
    }
    const canPrestige = () => essencePreview() > 0;

    function prestige() {
      const gain = essencePreview();
      if (gain <= 0) return false;
      const d = derived();
      const keepFirst = d.grove.keepFirstTierUps;

      state.essence += gain;
      state.essenceEarned += gain;
      state.season += 1;
      state.petals = 0;
      state.totalThisSeason = 0;
      // Turning the Season is the ONE thing that unlocks the bare-wood look:
      // drop the first-run Budding floor, then reset to 0 冬芽 Winter Bud.
      state.stageFloor = E.POST_PRESTIGE_STAGE;
      state.stage = E.POST_PRESTIGE_STAGE;
      for (const id of E.TENDER_IDS) state.tenders[id] = 0;
      const kept = {};
      if (keepFirst) for (const id in state.upgrades) if (/^up_[a-z]+_1$/.test(id)) kept[id] = 1;
      state.upgrades = kept;
      state.stats.upgrades = Object.keys(kept).length;
      state.stats.seasonTime = 0;
      state.stats.seasonClicks = 0;
      invalidate();

      // Constellation / Heartwood "starting Tenders" are granted after the wipe.
      const d2 = derived();
      for (const id in d2.grove.startTenders) {
        state.tenders[id] = Math.max(state.tenders[id] || 0, d2.grove.startTenders[id]);
      }
      invalidate();

      timers.storm = timers.rain = timers.frenzy = timers.clickFrenzy = timers.bloomfall = 0;
      if (windBase !== null) { WIND.uniforms.uWindStrength.value = windBase; windBase = null; }
      golden = null;
      setLive();

      bus.emit('bloom:stage', { stage: state.stage });   // 0 — the bare-wood reset
      bus.emit('game:prestige', { season: state.season, gain, essence: state.essence, essenceEarned: state.essenceEarned });
      snd('prestige', 1);
      bus.emit('petals:burst', { point: treePoint(), count: 320, power: 3 });
      checkUnlocks();
      save();
      pushState(true);
      return true;
    }

    /* ---------------------------------------------------------------- *
     * save / load
     * ---------------------------------------------------------------- */
    function snapshot() {
      state.lastSeen = Date.now();
      // Write the live countdowns back so a reload resumes the storm clock
      // instead of restarting it. Storm/Golden are re-rolled on load only when
      // these are absent (a pre-v4 save).
      state.sched = { storm: nextStorm, golden: nextGolden, rain: rainRoll };
      return state;
    }

    function save() {
      if (!persist) return false;
      try {
        localStorage.setItem(E.SAVE_KEY, JSON.stringify(snapshot()));
        return true;
      } catch { return false; }
    }

    function hardReset() {
      // A hard reset is a new game, so it gets a new event stream too — except
      // under the harness, where every run must stay byte-comparable.
      const seed = ctx.shotMode ? state.seed : freshSeed();
      state = E.newState(seed);
      rng = mulberry32((seed | 0) ^ 0x5a4b12);
      timers.storm = timers.rain = timers.frenzy = timers.clickFrenzy = timers.bloomfall = 0;
      loadSchedule();          // fresh save → fresh first-storm grace
      golden = null; offlineReport = null;
      if (windBase !== null) { WIND.uniforms.uWindStrength.value = windBase; windBase = null; }
      invalidate(); setLive();
      if (persist) { try { localStorage.removeItem(E.SAVE_KEY); } catch { /* ignore */ } }
      // A hard reset IS a fresh save, so it opens budded (stage 1), not bare.
      // Emitting a literal 0 here used to strip the canopy off a brand-new game.
      bus.emit('bloom:stage', { stage: state.stage });
      bus.emit('game:reset', {});
      pushState(true);
      return true;
    }

    function importSave(b64) {
      const s = E.decodeSave(b64);
      if (!s) return false;
      state = s;
      rng = mulberry32((state.seed | 0) ^ 0x5a4b12);
      loadSchedule();          // adopt the imported save's storm clock
      invalidate(); setLive();
      applyStage(true);
      bus.emit('bloom:stage', { stage: state.stage });
      save();
      pushState(true);
      return true;
    }

    /* ---- offline accrual ------------------------------------------- */
    function applyOffline() {
      if (!persist || !loadedSave || !loadedSave.lastSeen) return;
      const now = Date.now();
      let dtMs = now - loadedSave.lastSeen;
      // Never trust the clock: negative (DST / manual change) and absurd deltas → 0.
      if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0;
      if (dtMs > E.TUNING.OFFLINE_MAX_MS) dtMs = E.TUNING.OFFLINE_MAX_MS;
      const awayS = dtMs / 1000;
      if (awayS < 60) return;

      const d = derived();
      const cappedS = Math.min(awayS, d.offlineCapS);
      const gained = d.baseRate * d.offlineRate * cappedS;
      state.stats.offlineH = Math.max(state.stats.offlineH, awayS / 3600);

      const before = state.stage;
      if (gained > 0) credit(gained);
      const stages = [];
      const after = E.stageFor(state.totalThisSeason, derived().grove.bloomThreshold, state.stageFloor | 0);
      if (after > before) {
        for (let i = before + 1; i <= after; i++) stages.push(E.BLOOM_STAGES[i]);
      }
      applyStage(true);
      checkUnlocks(true);
      offlineReport = {
        awayS, cappedS, gained, stages,
        capped: awayS > d.offlineCapS,
        rate: d.offlineRate, capH: d.grove.dewH,
      };
    }

    /* ---------------------------------------------------------------- *
     * state:changed
     * ---------------------------------------------------------------- */
    /**
     * `now` = emit this frame (a purchase, a catch — the player did something and
     * must see it immediately). Otherwise the 5 Hz heartbeat in tick() carries
     * it: the bank grows continuously, so the UI needs that heartbeat regardless
     * and a per-shake emit on top would just be a third of a frame's work wasted.
     */
    function pushState(now = false) {
      if (now) { emitAcc = 0; bus.emit('state:changed', state); }
    }

    /* ---------------------------------------------------------------- *
     * fixed-step simulation
     * ---------------------------------------------------------------- */
    function simStep(dt) {
      const d = derived();

      // passive income
      if (d.passiveRate > 0) credit(d.passiveRate * dt);

      // Bloomfall — a minute of passive, delivered as physical petals you catch
      if (timers.bloomfall > 0) {
        timers.bloomfall -= dt;
        credit(bloomfallRate * dt);
        bloomfallBurst += dt;
        if (bloomfallBurst >= 0.25) {
          bloomfallBurst = 0;
          bus.emit('petals:burst', { point: treePoint(), count: 28, power: 1.5 });
        }
        if (timers.bloomfall <= 0) { timers.bloomfall = 0; bloomfallRate = 0; bloomfallBurst = 0; }
      }

      // timers
      if (timers.storm > 0) { timers.storm -= dt; if (timers.storm <= 0) endStorm(); }
      if (timers.rain > 0) {
        timers.rain -= dt;
        if (timers.rain <= 0) { timers.rain = 0; setLive(); bus.emit('game:event', { id: 'rain', active: false, remain: 0 }); }
      }
      if (timers.frenzy > 0) {
        timers.frenzy -= dt;
        if (timers.frenzy <= 0) { timers.frenzy = 0; setLive(); bus.emit('game:event', { id: 'frenzy', active: false, remain: 0 }); }
      }
      if (timers.clickFrenzy > 0) {
        timers.clickFrenzy -= dt;
        if (timers.clickFrenzy <= 0) { timers.clickFrenzy = 0; setLive(); bus.emit('game:event', { id: 'clickfrenzy', active: false, remain: 0 }); }
      }

      // storm schedule
      nextStorm -= dt * (1 / Math.max(0.1, d.grove.stormRate));
      if (nextStorm <= 0 && !live.storm) {
        nextStorm = rollStorm(false);
        startStorm();
      }

      // spring rain — 4% per minute
      rainRoll += dt;
      if (rainRoll >= 60) {
        rainRoll -= 60;
        if (!live.rain && rand() < E.TUNING.RAIN_CHANCE_PER_MIN * d.grove.rainChance) startRain();
      }

      // golden petal
      if (golden) {
        golden.ttl -= dt;
        if (golden.ttl <= 0) {
          const gid = golden.id; golden = null;
          bus.emit('game:golden:end', { id: gid, caught: false });
        }
      } else {
        nextGolden -= dt;
        if (nextGolden <= 0) {
          nextGolden = rollGolden() * d.grove.goldRate;
          spawnGolden();
        }
      }

      // auto-shake
      if (d.grove.auto > 0) {
        autoAcc += dt;
        const iv = d.grove.auto;
        while (autoAcc >= iv) { autoAcc -= iv; shake(null, { auto: true }); }
      }

      // stats
      state.stats.playTime += dt;
      state.stats.seasonTime += dt;
      idleFor += dt;
      if (idleFor > state.stats.idle) state.stats.idle = idleFor;
      if (d.baseRate > state.stats.bestRate) state.stats.bestRate = d.baseRate;
      if (state.totalThisSeason > state.stats.bestSeasonTotal) state.stats.bestSeasonTotal = state.totalThisSeason;

      applyStage();
    }

    /** Credit a long gap (background tab) without running thousands of steps. */
    function fastForward(sec) {
      const capped = Math.min(Math.max(0, sec), 4 * 3600);
      if (capped <= 0) return;
      const d = derived();
      credit(d.baseRate * capped);          // tab open but unfocused → full rate
      state.stats.playTime += capped;
      state.stats.seasonTime += capped;
      // Schedules advance but never fire retroactively — a storm you did not see
      // did not happen. Both are re-rolled so nothing bunches up on return.
      if (nextStorm - capped <= 0) nextStorm = E.TUNING.STORM_PERIOD * 0.35 + rand() * 60;
      else nextStorm -= capped;
      if (nextGolden - capped <= 0) nextGolden = 12 + rand() * 30;
      else nextGolden -= capped;
      applyStage();
      checkUnlocks();
      pushState(true);
    }

    let unlockAcc = 0;
    function tick(dt) {
      acc += dt;
      let guard = 0;
      while (acc >= STEP && guard < 240) { acc -= STEP; simStep(STEP); guard++; }
      if (guard >= 240) acc = 0;

      unlockAcc += dt;
      if (unlockAcc >= 0.5) { unlockAcc = 0; checkUnlocks(); }

      emitAcc += dt;
      if (emitAcc >= 0.2) { emitAcc = 0; bus.emit('state:changed', state); }

      saveAcc += dt;
      if (saveAcc >= E.TUNING.AUTOSAVE) { saveAcc = 0; save(); }
    }

    /* ---------------------------------------------------------------- *
     * bus wiring
     * ---------------------------------------------------------------- */
    const offs = [];

    offs.push(bus.on('tree:clicked', (e) => {
      if (e && e.__fromGame) return;
      shake(e?.point ?? null, { emitTreeClick: false });
    }));

    offs.push(bus.on('world:click', (e) => {
      // The Golden Petal is a real 3D object: VFX tags its mesh with
      // userData.goldenId and pushes it to ctx.clickTargets.
      let o = e?.hit?.object;
      while (o) {
        const gid = o.userData?.goldenId;
        if (gid !== undefined) { grantGolden(gid); return; }
        o = o.parent;
      }
    }));

    /* 45-vfx flies its OWN golden-petal mesh on its own schedule and does not
     * tag it with `userData.goldenId`, so the world:click route above never
     * fires for it — the headline mechanic looked right and paid nothing. Trust
     * its catch report; grantGolden() is frame-guarded, so if the tag is ever
     * added the two routes still pay exactly one boon. */
    offs.push(bus.on('vfx:golden', (e) => {
      if (e?.kind !== 'caught') return;
      grantGolden(golden ? golden.id : 0);
    }));

    /**
     * Announce the phase-gated events once every module is listening.
     *
     * `applyOffline()` and the first `setLive()` both run inside setup(), i.e.
     * before 65-ui (order 65), 70-audio (70) or 45-vfx (45) exist — anything
     * emitted there is emitted into an empty room. Two consequences that this
     * fixes: the documented `game:offline` event was NEVER emitted on a real
     * return (only by the debug scenario; the UI happened to survive by polling
     * `api.offlineReport` every frame instead), and a boot that lands in `night`
     * or `dusk` left the Full Moon / Golden Hour banner unlit until the NEXT
     * phase change, up to a full phase later, while the multiplier was already
     * being applied to the rate.
     */
    offs.push(bus.on('game:ready', () => {
      setLive();
      bus.emit('game:event', { id: 'moon', active: live.moon, remain: -1 });
      bus.emit('game:event', { id: 'goldenHour', active: live.goldenHour, remain: -1 });
      if (offlineReport) bus.emit('game:offline', offlineReport);
    }));

    offs.push(bus.on('time:phase', (e) => {
      phase = e?.phase ?? 'day';
      if (phase === 'night') state.stats.night = 1;
      const changed = setLive();
      if (changed) {
        bus.emit('game:event', { id: 'moon', active: live.moon, remain: -1 });
        bus.emit('game:event', { id: 'goldenHour', active: live.goldenHour, remain: -1 });
      }
    }));

    /* keyboard: Space shakes, 1–9 buy Tender n. Panels belong to the UI. */
    function onKey(ev) {
      const tgt = ev.target;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!ev.repeat) shake(null);
        return;
      }
      if (ev.code >= 'Digit1' && ev.code <= 'Digit9') {
        const i = Number(ev.code.slice(5)) - 1;
        const id = E.TENDER_IDS[i];
        if (id) { ev.preventDefault(); buy(id, state.ui.bulk || 1); }
      }
      if (ev.code === 'Digit0') { const id = E.TENDER_IDS[9]; if (id) buy(id, state.ui.bulk || 1); }
    }
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

    function onVisibility() { if (document.visibilityState === 'hidden') save(); }
    function onUnload() { save(); }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', onUnload);

    /* ---------------------------------------------------------------- *
     * public API
     * ---------------------------------------------------------------- */
    const api = {
      get state() { return state; },
      get derived() { return derived(); },
      rates() {
        const d = derived();
        return {
          perSecond: d.passiveRate,
          baseRate: d.baseRate,
          rawRate: d.rawRate,
          perShake: d.clickValue,
          perShakeExpected: d.clickValue * (1 + d.critChance * (d.critMult - 1)),
          critChance: d.critChance,
          critMult: d.critMult,
          eventPassive: d.eventPassive,
          eventClick: d.eventClick,
          totalTenders: d.totalTenders,
          offlineRate: d.offlineRate,
          offlineCapH: d.grove.dewH,
        };
      },
      // actions
      shake, buy, buyUpgrade, buyNode, buyHeartwood, prestige, catchGolden,
      /** VFX hook: force a Golden Petal now (debug / scripted moments). */
      spawnGolden: () => { if (!golden) spawnGolden(); return golden ? golden.id : null; },
      canAfford, canPrestige, essencePreview,
      cost: (id, count = 1) => (E.TENDER_BY_ID[id]
        ? tenderPrice(id, resolveCount(id, count))
        : E.UPGRADE_BY_ID[id] ? upgradePrice(E.UPGRADE_BY_ID[id])
          : E.NODE_BY_ID[id] ? E.NODE_BY_ID[id].cost
            : E.HEARTWOOD_BY_ID[id] ? E.HEARTWOOD_BY_ID[id].cost : Infinity),
      maxAffordable: (id) => E.tenderMaxAffordable(id, state.tenders[id] || 0, state.petals, derived().costMul),
      setBulk(n) { state.ui.bulk = n; pushState(true); },
      // formatting — the UI must use exactly these
      format: E.format, formatRate: E.formatRate, formatInt: E.formatInt,
      formatTime: E.formatTime, formatClock: E.formatClock,
      // save
      save, hardReset, importSave,
      exportSave: () => E.encodeSave(snapshot()),
      get offlineReport() { return offlineReport; },
      clearOfflineReport() { offlineReport = null; },
      // live state for HUD
      get events() {
        const d = derived();
        return {
          storm: { active: live.storm, remain: timers.storm, mult: d.grove.stormMult },
          rain: { active: live.rain, remain: timers.rain },
          moon: { active: live.moon, remain: -1 },
          goldenHour: { active: live.goldenHour, remain: -1 },
          frenzy: { active: live.frenzy, remain: timers.frenzy },
          clickFrenzy: { active: live.clickFrenzy, remain: timers.clickFrenzy },
          bloomfall: { active: timers.bloomfall > 0, remain: timers.bloomfall },
        };
      },
      get golden() { return golden ? { ...golden } : null; },
      get phase() { return phase; },
      get bloom() { return E.BLOOM_STAGES[state.stage]; },
      /**
       * Lowest stage this save can fall to. 1 蕾 Budding on a first run (the tree
       * never reads as dead), 0 冬芽 Winter Bud once a Season has been turned.
       * UI: use this to decide whether to describe stage 0 as reachable.
       */
      get bloomFloor() { return state.stageFloor | 0; },
      nextBloom() {
        const d = derived();
        if (state.stage >= 5) return null;
        const nxt = E.BLOOM_STAGES[state.stage + 1];
        const need = nxt.threshold * d.grove.bloomThreshold;
        return { ...nxt, need, progress: clamp(state.totalThisSeason / need, 0, 1) };
      },
      // views the UI renders straight from
      views: {
        tenders() {
          const d = derived();
          return E.TENDERS.map((t) => {
            const v = E.tenderView(state, d, t.id);
            // Spec: revealed once you can afford 40% of base cost. The very
            // first Tender is always shown — an empty panel on a new save is a
            // worse sin than one row you cannot afford yet.
            v.revealed = t.id === E.TENDER_IDS[0]
              || (state.tenders[t.id] || 0) > 0
              || state.stats.bestBank >= t.baseCost * 0.4;
            v.affordable = state.petals >= v.cost;
            v.bulkCost = tenderPrice(t.id, resolveCount(t.id, state.ui.bulk || 1));
            v.bulkCount = resolveCount(t.id, state.ui.bulk || 1);
            return v;
          });
        },
        upgrades(family) {
          const d = derived();
          const out = [];
          for (const u of E.UPGRADES) {
            if (family && u.family !== family) continue;
            if (state.upgrades[u.id]) continue;
            if (!E.upgradeUnlocked(u, state)) continue;
            const cost = u.family === 'grove' ? u.cost : u.cost * d.upCostMul;
            out.push({ ...u, cost, affordable: state.petals >= cost });
          }
          out.sort((a, b) => a.cost - b.cost);
          return out;
        },
        boughtUpgrades: () => E.UPGRADES.filter((u) => state.upgrades[u.id]),
        heartwood: () => E.HEARTWOOD_LIST.map((h) => ({
          ...h, owned: !!state.heartwood[h.id], affordable: state.blossoms >= h.cost,
        })),
        nodes: () => E.CONSTELLATION.map((n) => ({
          ...n,
          owned: !!state.nodes[n.id],
          available: !state.nodes[n.id] && nodeUnlocked(n),
          affordable: state.essence >= n.cost && nodeUnlocked(n),
        })),
        codex: () => E.CODEX.map((c) => ({ ...c, found: !!state.codex[c.id] })),
        achievements: () => E.ACHIEVEMENTS.map((a) => ({ ...a, got: !!state.achievements[a.id] })),
      },
      data: {
        TENDERS: E.TENDERS, UPGRADES: E.UPGRADES, CONSTELLATION: E.CONSTELLATION,
        CONSTELLATION_BRANCHES: E.CONSTELLATION_BRANCHES, CODEX: E.CODEX,
        ACHIEVEMENTS: E.ACHIEVEMENTS, HEARTWOOD: E.HEARTWOOD_LIST,
        BLOOM_STAGES: E.BLOOM_STAGES, LIVE_EVENTS: E.LIVE_EVENTS,
        GOLDEN_BOONS: E.GOLDEN_BOONS, TUNING: E.TUNING, MILESTONES: E.MILESTONES,
      },
      /** 60-game already binds Space and 1–0. UI: do not bind them again. */
      keyboard: true,
    };
    ctx.assets.game = api;

    /* ---------------------------------------------------------------- *
     * boot: offline, first stage push, debug scenarios
     * ---------------------------------------------------------------- */
    if (!ctx.shotMode) applyOffline();
    // Re-derive before the first push so a save written by an older build (or one
    // whose Constellation threshold discount changed) agrees with stageFor(),
    // and so the first-run floor is applied. Quiet: no set piece on boot.
    applyStage(true);
    checkUnlocks(true);
    invalidate();
    bus.emit('bloom:stage', { stage: state.stage });
    setLive();
    pushState(true);

    /* ---- debug scenarios: the UI agent and the critics shoot these --- */
    if (typeof window !== 'undefined' && window.__game) {
      const sc = window.__game.scenarios;

      const rebuild = (mutate) => {
        state = E.newState(state.seed);
        mutate(state);
        state = E.sanitizeState(state);
        rng = mulberry32((state.seed | 0) ^ 0x5a4b12);
        timers.storm = timers.rain = timers.frenzy = timers.clickFrenzy = timers.bloomfall = 0;
        loadSchedule();        // deterministic: a scenario is a reproducible state
        golden = null; offlineReport = null;
        invalidate(); setLive();
        applyStage(true);
        checkUnlocks(true);
        invalidate();
        bus.emit('bloom:stage', { stage: state.stage });
        bus.emit('game:scenario', { state });
        pushState(true);
      };

      /**
       * A brand-new save: nothing bought, no currency, and stage 1 蕾 Budding —
       * the first-run floor. This is literally what a new player boots into, so
       * it is the scenario the marketing/critic shots should use.
       */
      sc.fresh = () => rebuild(() => {});

      /**
       * Straight after a Season turn: stage 0 冬芽 Winter Bud (bare wood), the
       * only state in which that look is reachable. Essence has been earned and
       * mostly spent, Blossoms and Codex survived, the grove is empty again
       * except for the Constellation's starting Sprites.
       */
      sc.prestiged = () => rebuild((s) => {
        s.season = 2;
        s.stageFloor = 0;                 // earned: this player has turned a Season
        s.stage = 0;
        s.petals = 0;
        s.totalThisSeason = 0;
        s.totalAllTime = 1.9e8;
        s.essenceEarned = 41;
        s.essence = 5;                    // 36 spent on the nine nodes below
        for (const id of ['wind1', 'wind2', 'wind3', 'water1', 'water2',
          'moon1', 'moon2', 'stone1', 'blossom1']) s.nodes[id] = 1;
        s.blossoms = 4;
        s.heartwood.hw_prod1 = 1;         // 3 Blossoms spent
        for (const id of ['somei', 'shidare', 'yama', 'oshima']) s.codex[id] = 1;
        s.stats.clicks = 2600; s.stats.crits = 141; s.stats.storms = 5;
        s.stats.golden = 3; s.stats.bestBank = 3.1e7; s.stats.playTime = 7400;
        s.stats.seasonTime = 4; s.stats.seasonClicks = 0; s.stats.maxTender = 68;
        s.stats.bestSeasonTotal = 1.2e8;
        // 'Following Wind' (wind3) grants 15 starting Sprites — the rebuild()
        // path does not run prestige(), so grant them here to match.
        s.tenders.sprite = 15;
      });

      /** Mid-game: ~25 minutes in. Stage 3, real Tender spread, panels populated. */
      sc.rich = () => rebuild((s) => {
        Object.assign(s.tenders, { sprite: 47, gatherer: 52, miko: 38, lantern: 26, koi: 14, rabbit: 4 });
        for (const id of ['shake_f1', 'shake_m1', 'shake_f2', 'shake_m2', 'shake_c1', 'shake_f3',
          'shake_x1', 'shake_m3', 'shake_c2', 'shake_f4', 'shake_x2', 'shake_m4', 'all_1', 'all_2', 'grove_bulk', 'grove_magnet', 'grove_auto1',
          'up_sprite_1', 'up_sprite_2', 'up_sprite_3', 'up_gatherer_1', 'up_gatherer_2',
          'up_gatherer_3', 'up_miko_1', 'up_miko_2', 'up_lantern_1', 'up_koi_1']) s.upgrades[id] = 1;
        s.heartwood.hw_prod1 = 1;
        s.season = 1;
        s.stageFloor = 0;                  // has turned a Season — floor earned away
        s.essence = 22;
        s.essenceEarned = 31;              // 9 spent on the four branch roots below
        for (const id of ['wind1', 'water1', 'moon1', 'stone1', 'blossom1']) s.nodes[id] = 1;
        s.petals = 9.4e6;
        s.totalThisSeason = 6.4e7;
        s.totalAllTime = 9.6e7;
        s.blossoms = 11;
        s.stats.clicks = 1840; s.stats.crits = 96; s.stats.storms = 3; s.stats.golden = 2;
        s.stats.bestBank = 9.4e6; s.stats.playTime = 3300; s.stats.seasonTime = 1680;
        s.stats.maxTender = 52;
      });

      /** Late game: Everblossom, deep Constellation, full Codex, every panel busy. */
      sc.lategame = () => rebuild((s) => {
        Object.assign(s.tenders, {
          sprite: 216, gatherer: 208, miko: 197, lantern: 183, koi: 171,
          rabbit: 158, kitsune: 141, envoy: 118, heart: 96, bough: 71,
        });
        for (const u of E.UPGRADES) s.upgrades[u.id] = 1;
        for (const h of E.HEARTWOOD_LIST) s.heartwood[h.id] = 1;
        for (const n of E.CONSTELLATION) if (n.tier <= 3) s.nodes[n.id] = 1;
        s.season = 9;
        s.stageFloor = 0;
        s.essence = 640;
        s.essenceEarned = 851;   // 211 spent on the 20 nodes above
        s.blossoms = 96;
        s.petals = 8.4e14;
        s.totalThisSeason = 4.6e15;
        s.totalAllTime = 9.2e15;
        s.stats.clicks = 148000; s.stats.crits = 24100; s.stats.storms = 62;
        s.stats.golden = 71; s.stats.bestBank = 8.4e14; s.stats.playTime = 41000;
        s.stats.seasonTime = 5400; s.stats.maxTender = 216; s.stats.offlineH = 14;
        s.stats.night = 1; s.stats.idle = 400;
      });

      /* ---- stage0..stage5: keep the GAME STATE with the tree ------------ *
       * 30-tree.js owns those six scenario names and uses them to force the
       * canopy's visual stage, which is right for judging the tree. On their
       * own they leave this module untouched, so `--scenario stage5` rendered
       * an Everblossom canopy over a HUD reading 蕾 Budding / 0.00 per second,
       * and `--scenario stage3` left whatever state the previous scenario had
       * (measured: stage 0, 15 Tenders, 5.73/s). Wrap them so the state that
       * would have grown that canopy is loaded too.
       *
       * Every loadout below is MEASURED, not invented: `.tmp-game/sim.mjs
       * --dump` snapshots the reference player the moment they cross each
       * threshold (95 s / 494 s / 1755 s / 6462 s). Stage 0 is the
       * post-Season reset and stage 5 is a fourth-Season player who has just
       * reached 常桜 — the one state `lategame` (everything maxed) does not
       * cover.
       */
      const STAGE_STATES = {
        0: (s) => {
          s.season = 1; s.stageFloor = 0;
          s.totalAllTime = 1.1e7;
          s.essenceEarned = 3; s.essence = 3;
          s.blossoms = 43;
          for (const id of ['somei', 'yoko', 'yae', 'shidare', 'oshima', 'yama']) s.codex[id] = 1;
          s.stats.clicks = 1815; s.stats.crits = 256; s.stats.playTime = 1800;
          s.stats.seasonTime = 3; s.stats.storms = 4; s.stats.golden = 2;
          s.stats.bestSeasonTotal = 1e7; s.stats.bestBank = 7.3e5; s.stats.maxTender = 44;
        },
        1: (s) => {
          Object.assign(s.tenders, { sprite: 6, gatherer: 4 });
          for (const id of ['shake_f1', 'shake_m1']) s.upgrades[id] = 1;
          s.petals = 256; s.totalThisSeason = 1e3; s.totalAllTime = 1e3;
          s.blossoms = 6;
          s.stats.clicks = 237; s.stats.crits = 24; s.stats.playTime = 95;
          s.stats.seasonTime = 95; s.stats.seasonClicks = 237;
          s.stats.bestBank = 256; s.stats.maxTender = 6;
        },
        2: (s) => {
          Object.assign(s.tenders, { sprite: 32, gatherer: 26, miko: 13 });
          for (const id of ['shake_f1', 'shake_m1', 'shake_f2', 'shake_m2', 'shake_c1',
            'up_sprite_1', 'up_gatherer_1']) s.upgrades[id] = 1;
          s.petals = 1.36e4; s.totalThisSeason = 1e5; s.totalAllTime = 1e5;
          s.blossoms = 24;
          for (const id of ['somei', 'yoko', 'yae', 'shidare']) s.codex[id] = 1;
          s.stats.clicks = 963; s.stats.crits = 127; s.stats.playTime = 494;
          s.stats.seasonTime = 494; s.stats.seasonClicks = 963;
          s.stats.bestBank = 1.4e4; s.stats.maxTender = 32; s.stats.golden = 1;
        },
        3: (s) => {
          Object.assign(s.tenders, { sprite: 41, gatherer: 44, miko: 38, lantern: 22, koi: 13 });
          for (const id of ['shake_f1', 'shake_m1', 'shake_f2', 'shake_m2', 'shake_c1',
            'shake_f3', 'shake_x1', 'shake_m3', 'up_sprite_1', 'up_sprite_2',
            'up_gatherer_1', 'up_gatherer_2', 'up_miko_1', 'up_miko_2']) s.upgrades[id] = 1;
          s.petals = 7.31e5; s.totalThisSeason = 1e7; s.totalAllTime = 1e7;
          s.blossoms = 43;
          for (const id of ['somei', 'yoko', 'yae', 'shidare', 'oshima', 'yama']) s.codex[id] = 1;
          s.stats.clicks = 1815; s.stats.crits = 256; s.stats.playTime = 1755;
          s.stats.seasonTime = 1755; s.stats.seasonClicks = 1815;
          s.stats.bestBank = 7.4e5; s.stats.maxTender = 44; s.stats.storms = 4; s.stats.golden = 2;
        },
        4: (s) => {
          Object.assign(s.tenders, {
            sprite: 58, gatherer: 61, miko: 58, lantern: 44, koi: 39, rabbit: 34, kitsune: 8,
          });
          for (const id of ['shake_f1', 'shake_m1', 'shake_f2', 'shake_m2', 'shake_c1',
            'shake_f3', 'shake_x1', 'shake_m3', 'shake_c2', 'shake_f4', 'shake_x2',
            'shake_m4', 'shake_c3', 'up_sprite_1', 'up_sprite_2', 'up_sprite_3',
            'up_gatherer_1', 'up_gatherer_2', 'up_gatherer_3', 'up_miko_1', 'up_miko_2',
            'up_miko_3', 'up_lantern_1', 'up_lantern_2', 'up_koi_1', 'up_koi_2',
            'up_rabbit_1', 'up_rabbit_2', 'all_1', 'all_2']) s.upgrades[id] = 1;
          s.petals = 6.92e9; s.totalThisSeason = 1.04e10; s.totalAllTime = 1.04e10;
          s.blossoms = 60;
          for (const id of ['somei', 'yoko', 'yae', 'shidare', 'oshima', 'yama', 'gyoiko']) s.codex[id] = 1;
          s.stats.clicks = 4639; s.stats.crits = 848; s.stats.playTime = 6462;
          s.stats.seasonTime = 6462; s.stats.seasonClicks = 4639;
          s.stats.bestBank = 7e9; s.stats.maxTender = 61; s.stats.storms = 14; s.stats.golden = 9;
        },
        5: (s) => {
          Object.assign(s.tenders, {
            sprite: 128, gatherer: 131, miko: 126, lantern: 118, koi: 109,
            rabbit: 101, kitsune: 84, envoy: 61, heart: 33, bough: 11,
          });
          for (const u of E.UPGRADES) {
            if (u.family === 'shake' || /^up_[a-z]+_[123]$/.test(u.id)
              || ['all_1', 'all_2', 'all_3', 'all_4'].includes(u.id)
              || ['grove_bulk', 'grove_magnet', 'grove_auto1', 'grove_gold1',
                'grove_dew1', 'grove_storm1', 'grove_gold2', 'grove_off1'].includes(u.id)) {
              s.upgrades[u.id] = 1;
            }
          }
          s.season = 3; s.stageFloor = 0;
          s.essenceEarned = 384; s.essence = 96;
          for (const n of E.CONSTELLATION) if (n.tier <= 2) s.nodes[n.id] = 1;
          for (const h of ['hw_prod1', 'hw_click1', 'hw_start1', 'hw_prod2', 'hw_crit1']) s.heartwood[h] = 1;
          s.petals = 3.1e12; s.totalThisSeason = 2.4e13; s.totalAllTime = 5.8e13;
          s.blossoms = 21;
          for (const c of E.CODEX) if (c.id !== 'everblossom' && c.id !== 'jugatsu') s.codex[c.id] = 1;
          s.stats.clicks = 26400; s.stats.crits = 5100; s.stats.playTime = 21800;
          s.stats.seasonTime = 6300; s.stats.seasonClicks = 8100;
          s.stats.bestBank = 3.1e12; s.stats.maxTender = 131; s.stats.storms = 31;
          s.stats.golden = 24; s.stats.offlineH = 6; s.stats.night = 1;
        },
      };

      /* 30-tree re-registers stage0..5 on `game:ready`; this module's listener
       * is added later (order 60 > 30) so it runs after and wraps the final
       * version. Guarded so a second game:ready cannot double-wrap. */
      let stagesWrapped = false;
      const wrapStageScenarios = () => {
        if (stagesWrapped) return;
        stagesWrapped = true;
        for (let s = 0; s <= 5; s++) {
          const visual = sc[`stage${s}`];
          const mutate = STAGE_STATES[s];
          sc[`stage${s}`] = () => {
            rebuild(mutate);
            // ...then let the tree's own override have the last word, so the
            // canopy snaps instead of growing into place during a shot.
            if (visual) visual();
          };
        }
      };
      offs.push(bus.on('game:ready', wrapStageScenarios));

      sc['game-storm'] = () => { startStorm(); pushState(true); };
      sc['game-golden'] = () => { if (!golden) spawnGolden(); };
      sc['game-frenzy'] = () => { applyBoon(E.GOLDEN_BOONS[0]); applyBoon(E.GOLDEN_BOONS[2]); pushState(true); };
      sc['game-offline'] = () => {
        const d = derived();
        offlineReport = {
          awayS: 7.4 * 3600, cappedS: Math.min(7.4 * 3600, d.offlineCapS),
          gained: d.baseRate * d.offlineRate * Math.min(7.4 * 3600, d.offlineCapS),
          stages: [], capped: 7.4 * 3600 > d.offlineCapS, rate: d.offlineRate, capH: d.grove.dewH,
        };
        bus.emit('game:offline', offlineReport);
      };
      sc['game-prestige'] = () => { prestige(); };
      sc['game-stageup'] = () => {
        const s = Math.min(5, state.stage + 1);
        const info = E.BLOOM_STAGES[s];
        state.stage = s; invalidate();
        bus.emit('bloom:stage', { stage: s });
        bus.emit('game:stageup', { stage: s, name: info.name, kanji: info.kanji, blurb: info.blurb, blossoms: s * 3 });
        pushState(true);
      };
      sc['game-shake'] = () => { for (let i = 0; i < 8; i++) shake(null); };
    }

    /* ---------------------------------------------------------------- *
     * update
     * ---------------------------------------------------------------- */
    return {
      update(dt) {
        // Background tabs stop RAF; main.js clamps dt to 1/20 so the sim would
        // lose the missing minutes. Credit them at full rate from the wall clock.
        if (!ctx.shotMode) {
          const now = Date.now();
          let gap = (now - wallLast) / 1000;
          wallLast = now;
          if (Number.isFinite(gap) && gap > 1.5) {
            fastForward(gap - 1);
            gap = 1;
          }
        }
        tick(dt);
      },
      dispose() {
        save();
        for (const off of offs) off();
        if (typeof window !== 'undefined') {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('beforeunload', onUnload);
        }
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        if (windBase !== null) { WIND.uniforms.uWindStrength.value = windBase; windBase = null; }
        ctx.assets.game = null;
      },
    };
  },
};
