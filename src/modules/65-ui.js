/**
 * 65-ui.js — the whole HUD and panel system, as DOM inside #ui-root.
 * Owner: UI agent.  Visual language: ART_BIBLE §7 (Genshin Impact's UI).
 *
 * All state belongs to 60-game.js. This module reads it through
 * `ctx.assets.game` — its `views.*`, `rates()`, `data.*` and `format*` helpers —
 * and never mutates state directly; every purchase goes back through the game
 * module's own API. 60-game already binds Space and 1–0, so the UI only binds
 * those when the game module is absent. If the game module never appears the
 * HUD degrades to a quiet, correct, empty state rather than throwing.
 */

import * as THREE from 'three';
import { injectUiStyle } from '../lib/ui-style.js';
import {
  h, clear, mount, setText, setClass, setW,
  formatNumber, formatRate, formatTime,
  TENDER_DEFS, MILESTONES, STAGE_DEFS, EVENT_DEFS, CODEX_DEFS,
  UPGRADE_FAMILIES, CONSTEL_BRANCHES,
  makeTicker, panel, bar, stars, corners, goldBtn,
  buyBtn, segmented, stageCapsule, rarityOf, groupRule, sealedRow,
} from '../lib/ui-widgets.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  return e;
};
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const EVENT_PRIORITY = ['storm', 'clickFrenzy', 'frenzy', 'bloomfall', 'rain', 'moon', 'goldenHour'];
/**
 * Time-of-day chip. dusk/night are also the Golden Hour / Full Moon windows, so
 * the note carries the live buff. Notes stay SHORT: at "黄金時 · +15% per shake"
 * the chip forced 花びら to wrap and the HUD plate grew 30 px on dusk alone.
 */
const PHASE_META = {
  dawn: { kanji: '朝', name: 'DAWN', note: 'first light' },
  day: { kanji: '昼', name: 'DAY', note: 'full sun' },
  dusk: { kanji: '夕', name: 'DUSK', note: '黄金時 +15%' },
  night: { kanji: '夜', name: 'NIGHT', note: '満月 +25%' },
};
const EVENT_META = {
  storm: { kanji: '花嵐', name: 'Petal Storm', desc: '×10 petals per second · the whole hillside is in the air' },
  rain: { kanji: '春雨', name: 'Spring Rain', desc: '+10% petals per second · the fall slows to a drift' },
  moon: { kanji: '満月', name: 'Full Moon', desc: '+25% critical chance while the moon is up' },
  goldenHour: { kanji: '黄金時', name: 'Golden Hour', desc: '+15% to every shake while the light holds' },
  frenzy: { kanji: '狂咲', name: 'Frenzy', desc: '×7 petals per second' },
  clickFrenzy: { kanji: '乱打', name: 'Click Frenzy', desc: '×77 to every shake' },
  bloomfall: { kanji: '花降', name: 'Bloomfall', desc: 'a minute of the grove, falling all at once' },
};

export default {
  name: 'ui',
  order: 65,

  async setup(ctx) {
    const root = document.getElementById('ui-root');
    if (!root) return {};
    injectUiStyle();
    if (ctx.shotMode) root.classList.add('is-shot');

    /* ============================================================== *
     * 1.  Game adapter
     * ============================================================== */
    const G = () => ctx.assets?.game ?? null;
    const call = (fn, fallback) => { try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; } };

    const A = {
      fmt(n) { const g = G(); return call(() => (g?.format ? g.format(n) : formatNumber(n)), formatNumber(n)); },
      rate(n) { const g = G(); return call(() => (g?.formatRate ? g.formatRate(n) : formatRate(n)), formatRate(n)); },
      time(s) { const g = G(); return call(() => (g?.formatTime ? g.formatTime(s) : formatTime(s)), formatTime(s)); },
      state() { return G()?.state ?? EMPTY_STATE; },
      rates() { return call(() => G()?.rates?.() ?? null, null) ?? EMPTY_RATES; },
      data() { return G()?.data ?? null; },
      tenderDefs() { return this.data()?.TENDERS ?? TENDER_DEFS; },
      stages() { return this.data()?.BLOOM_STAGES ?? STAGE_DEFS; },
      milestones() { return this.data()?.MILESTONES ?? MILESTONES; },
      tenderViews() {
        const v = call(() => G()?.views?.tenders?.(), null);
        if (Array.isArray(v)) return v;
        // no game module: describe the pristine opening state honestly
        return this.tenderDefs().map((t, i) => ({
          ...t, owned: 0, cost: t.baseCost, each: t.rate, total: 0,
          milestone: 10, milestoneMult: 1, affordable: false, revealed: i === 0,
        }));
      },
      upgradeViews() { return call(() => G()?.views?.upgrades?.(), null) ?? []; },
      boughtUpgrades() { return call(() => G()?.views?.boughtUpgrades?.(), null) ?? []; },
      heartwood() { return call(() => G()?.views?.heartwood?.(), null) ?? []; },
      codexViews() {
        const v = call(() => G()?.views?.codex?.(), null);
        if (Array.isArray(v)) return v;
        return CODEX_DEFS.map((c) => ({ ...c, found: false }));
      },
      achievements() { return call(() => G()?.views?.achievements?.(), null) ?? []; },
      nodeViews() { return call(() => G()?.views?.nodes?.(), null) ?? []; },
      branches() { return this.data()?.CONSTELLATION_BRANCHES ?? CONSTEL_BRANCHES; },
      petals() { return num(this.state().petals); },
      blossoms() { return num(this.state().blossoms); },
      essence() { return num(this.state().essence); },
      totalSeason() { return num(this.state().totalThisSeason); },
      stage() { return Math.max(0, Math.min(5, num(this.state().stage) | 0)); },
      bloom() { return G()?.bloom ?? this.stages()[this.stage()]; },
      nextBloom() { return call(() => G()?.nextBloom?.(), null); },
      events() { return G()?.events ?? null; },
      golden() { return G()?.golden ?? null; },
      canPrestige() { return call(() => !!G()?.canPrestige?.(), false); },
      essencePreview() { return call(() => num(G()?.essencePreview?.()), 0); },
      bulk() { return num(this.state()?.ui?.bulk) || 1; },
      setBulk(n) { try { G()?.setBulk?.(n); } catch { /* ignore */ } },
      buy(id, n) { try { return !!G()?.buy?.(id, n); } catch { return false; } },
      buyUpgrade(id) { try { return !!G()?.buyUpgrade?.(id); } catch { return false; } },
      buyNode(id) { try { return !!G()?.buyNode?.(id); } catch { return false; } },
      buyHeartwood(id) { try { return !!G()?.buyHeartwood?.(id); } catch { return false; } },
      prestige() { try { return !!G()?.prestige?.(); } catch { return false; } },
      shake() {
        const g = G();
        if (typeof g?.shake === 'function') { try { g.shake(null); return true; } catch { /* fall through */ } }
        try { window.__game?.clickWorld?.(-0.06, 0.22); return true; } catch { return false; }
      },
      ownsKeyboard() { return !!G()?.keyboard; },
      exportSave() { return call(() => G()?.exportSave?.(), '') || ''; },
      importSave(t) { try { return !!G()?.importSave?.(t); } catch { return false; } },
      hardReset() { try { G()?.hardReset?.(); return true; } catch { return false; } },
      offlineReport() { return G()?.offlineReport ?? null; },
      clearOffline() { try { G()?.clearOfflineReport?.(); } catch { /* ignore */ } },
    };
    const EMPTY_STATE = { petals: 0, blossoms: 0, essence: 0, totalThisSeason: 0, stage: 0, ui: { bulk: 1 } };
    const EMPTY_RATES = { perSecond: 0, perShake: 1, critChance: 0.03, critMult: 8, totalTenders: 0 };

    /* ============================================================== *
     * 2.  DOM skeleton — HUD
     * ============================================================== */
    const ui = h('div.sk-ui', { style: { position: 'absolute', inset: '0' } });
    root.append(ui);

    const elBank = h('span.sk-bank-val.num', '0');
    const elRate = h('b.num', '0.00');
    const elShake = h('b.num', '1');
    const elShake2 = h('b.num', '1');
    const elCrit = h('span.num', '3%');
    const elBlossom = h('span.num', '0');
    const elEssence = h('span.num', '0');
    const elStageK = h('div.sk-stage-k', '冬芽');
    const elStageN = h('div.sk-stage-n', 'Winter Bud');
    const elStageI = h('div.sk-stage-i', 'I / VI');
    const elStageA = h('span.num', '0');
    const elStageB = h('span.num', '1,000');

    const seasonChip = h('button.sk-chip.season', { onclick: () => selectTab('star'), title: 'Turn the Season' },
      h('i'), h('span', 'SEASON READY'));
    seasonChip.style.display = 'none';

    /* Bloom capsule: the whole 0 → 常桜 run in log space, one tick per stage
       threshold, glowing head. Built from the game's own thresholds when it
       has published them; STAGE_DEFS is the fallback. */
    const stageThresholds = (A.stages() ?? STAGE_DEFS)
      .map((s) => num(s.threshold))
      .filter((v) => v > 0);
    if (!stageThresholds.length) stageThresholds.push(1e3, 1e5, 1e7, 1e10, 1e13);
    const stageBar = stageCapsule(stageThresholds);

    /* Everything legibility-critical lives on one parchment plate (§7): the old
       HUD was 13 px grey text floating over a lit sky at ~2:1 contrast. */
    /* Time-of-day chip. The bank row's right third was dead parchment, and the
       phase is load-bearing information: dusk is Golden Hour and night is Full
       Moon, so the player needs to see which window they are in. */
    const elPhaseK = h('i.sk-kanji', '昼');
    const elPhaseN = h('b', 'DAY');
    const elPhaseNote = h('span', 'full sun');
    const phaseChip = h('div.sk-phase', { title: 'Time of day' }, elPhaseK,
      h('div', elPhaseN, elPhaseNote));

    const hud = h('div.sk-hud',
      h('div.sk-vig.tl'), h('div.sk-vig.bt'),
      h('div.sk-plate.sk-paper', corners(true),
        h('div.sk-bank',
          h('div.sk-bank-row', h('div.sk-bank-icon'), elBank, h('span.sk-bank-unit', '花びら'), phaseChip),
          h('div.sk-bank-sub',
            h('span', null, elRate, h('em', '/ sec')),
            h('div.sep'),
            h('span', null, elShake, h('em', '/ shake')),
            h('div.sep'),
            h('span', null, elCrit, h('em', 'crit')),
          ),
        ),
        h('div.sk-chips',
          h('div.sk-chip.blossom', { title: 'Blossoms 桜花 — permanent, never reset' }, h('i'), elBlossom),
          h('div.sk-chip.essence', { title: 'Sakura Essence 桜精 — earned by turning the Season' }, h('i'), elEssence),
          seasonChip,
        ),
        h('div.sk-stage',
          h('div.sk-stage-head', elStageK, elStageN, elStageI),
          stageBar.root,
          h('div.sk-stage-foot', h('span', null, elStageA), h('span', null, elStageB)),
        ),
      ),
    );
    ui.append(hud);

    const shakeBtn = h('div.sk-shake', { onclick: () => doShake(), title: 'Shake the bough' },
      h('div.tip', 'start here — the bough drops petals when you shake it'),
      h('kbd', 'SPACE'),
      h('span', 'shake the bough'),
      h('div.bar'),
      elShake2,
      h('span', { style: { opacity: '.66', letterSpacing: '.16em' } }, '花びら'));
    ui.append(shakeBtn);

    const goldenHint = h('div.sk-golden', h('i'), h('span', '金花弁 — catch it'));
    goldenHint.style.display = 'none';
    ui.append(goldenHint);

    let eventEl = null, eventFill = null, eventId = null;
    const eventDur = Object.create(null);

    const toasts = h('div.sk-toasts');
    const flyLayer = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' } });
    ui.append(toasts, flyLayer);

    /* ============================================================== *
     * 3.  Right rail + tabs
     * ============================================================== */
    const TABS = [
      { id: 'tenders', kanji: '世', title: 'Tenders', jp: '世話' },
      { id: 'upgrades', kanji: '強', title: 'Upgrades', jp: '強化' },
      { id: 'codex', kanji: '図', title: 'Codex', jp: '桜図鑑' },
      { id: 'star', kanji: '星', title: 'Constellation', jp: '星屑ノ樹' },
      { id: 'set', kanji: '設', title: 'Settings', jp: '設定' },
    ];
    const tabEls = new Map();
    const tabStrip = h('div.sk-tabs');
    for (const t of TABS) {
      const b = h('button.sk-tab', { onclick: () => selectTab(t.id, true), title: `${t.title} ${t.jp}` }, t.kanji);
      tabEls.set(t.id, b);
      tabStrip.append(b);
    }
    const railHost = h('div', { style: { flex: '1 1 auto', display: 'flex', minWidth: '0', maxHeight: '100%', pointerEvents: 'auto' } });
    ui.append(h('div.sk-rail', railHost, tabStrip));

    let scrim = null;
    function openModal(node, tag) {
      closeModal();
      scrim = h('div.sk-scrim', { onclick: (e) => { if (e.target === scrim) closeModal(); } }, node);
      scrim.__tab = tag;
      ui.append(scrim);
      /* same bottom-fade cue the rail panels use — a modal list that ends in a
         sliced row reads as a clipping bug */
      const body = node.querySelector?.('.sk-panel-body');
      if (body) {
        scrim.__body = body;
        body.addEventListener('scroll', () => markScroll(body), { passive: true });
        markScroll(body);
      }
      syncTabs();
      return scrim;
    }
    function closeModal() { if (scrim) { scrim.remove(); scrim = null; syncTabs(); } }

    /* ============================================================== *
     * 4.  Tender panel
     * ============================================================== */
    const TENDER_GLYPH = {
      sprite: '風', gatherer: '摘', miko: '巫', lantern: '灯', koi: '鯉',
      rabbit: '兎', kitsune: '狐', envoy: '神', heart: '心', bough: '天',
    };
    const tenderRows = new Map();
    const tenderPanel = panel({ title: 'TENDERS', kanji: '世 話', cls: 'sk-panel' });
    let bulkSeg = null, tenderTotalEl = null, teaser = null, teaserNeed = null;
    /** One tapered rule per rarity transition, keyed by the row that follows it. */
    const bandRules = new Map();
    {
      const defs = A.tenderDefs();
      defs.forEach((d, i) => {
        const rarity = rarityOf(i);
        if (i > 0 && rarity !== rarityOf(i - 1)) {
          const rule = groupRule();
          rule.style.display = 'none';
          tenderPanel.body.append(rule);
          bandRules.set(d.id, rule);
        }
        const cnt = h('b', '0');
        const outEach = h('i', '0.00');
        const outTotal = h('u', '0.00');
        const mBar = bar('track', false);
        const mLbl = h('b', '10');
        const mPre = h('span', 'next ×2 at ');
        const btn = buyBtn(() => buyTender(d.id), `Buy ${d.name}`, 'TEND');
        const row = h('div.sk-card', {
          class: 'r' + rarity,
          onclick: () => buyTender(d.id),
          title: `${d.name} ${d.kanji}\n${d.blurb ?? ''}`,
        },
          h('div.ico', TENDER_GLYPH[d.id] ?? d.glyph ?? d.kanji?.[0] ?? '花', cnt),
          h('div.nm', h('h3', d.name), h('em', d.kanji ?? ''), stars(rarity, 5, true)),
          btn.root,
          h('span.out', outEach, ' /s each · ', outTotal, ' total'),
          h('div.sk-mini', mBar.root, h('span.lb', mPre, mLbl)),
        );
        row.style.display = 'none';
        tenderPanel.body.append(row);
        tenderRows.set(d.id, { d, row, cnt, outEach, outTotal, btn, mBar, mLbl, mPre, revealed: false, idx: i, rarity });
      });

      /* Next-unlock row: a sealed scroll with a gold wax seal. Keeps the body
         full so a one-row fresh save never shows dead parchment (§8.11), and
         reads as in-world rather than as a disabled form control. */
      const sealed = sealedRow();
      teaser = sealed.root;
      teaserNeed = sealed.need;
      tenderPanel.body.append(teaser);

      bulkSeg = segmented([['×1', 1], ['×10', 10], ['×25', 25], ['MAX', -1]],
        (v) => { A.setBulk(v); refresh(); });
      tenderTotalEl = h('span.sk-hint.num', '');
      tenderPanel.root.append(h('div.sk-panel-foot', bulkSeg.root, tenderTotalEl));
    }
    function buyTender(id) { A.buy(id, A.bulk()); refresh(); }

    /* ============================================================== *
     * 5.  Upgrade panel (dynamic — the available set changes)
     * ============================================================== */
    const upgradePanel = panel({ title: 'UPGRADES', kanji: '強 化', cls: 'sk-panel' });
    const upgradeFootL = h('span.sk-hint', 'one-shot purchases · they never expire');
    const upgradeFootR = h('span.sk-hint.num', '');
    upgradePanel.root.append(h('div.sk-panel-foot', upgradeFootL, upgradeFootR));
    let upgradeKey = '';
    const upgradeRows = [];

    const HEART_FAM = { id: 'heart', kanji: '心', name: 'Heartwood', sub: 'bought with Blossoms · survives every Season' };
    function famMeta(id) {
      if (id === 'heart') return HEART_FAM;
      return UPGRADE_FAMILIES.find((f) => f.id === id) ?? { id, kanji: '強', name: id, sub: '' };
    }

    function buildUpgrades() {
      const avail = A.upgradeViews();
      const hw = A.heartwood().filter((x) => !x.owned);
      const bought = A.boughtUpgrades();
      /* canPrestige is in the key because the completion card's only control is
         the Season button, and that flips without the available set changing. */
      const key = avail.map((u) => u.id).join(',') + '|' + hw.map((x) => x.id).join(',')
        + '|' + bought.length + '|' + (avail.length || hw.length ? '' : A.canPrestige());
      if (key === upgradeKey) return;
      upgradeKey = key;
      upgradeRows.length = 0;
      clear(upgradePanel.body);

      for (const fam of UPGRADE_FAMILIES) {
        const mine = avail.filter((u) => u.family === fam.id).slice(0, 9);
        if (!mine.length) continue;
        upgradePanel.body.append(famHeader(fam));
        for (const u of mine) {
          upgradeRows.push(mkUpgradeRow({
            id: u.id, family: fam.id, name: u.name, flavour: u.flavour, cost: u.cost,
            currency: 'petals', buy: () => { A.buyUpgrade(u.id); refresh(); },
          }));
        }
      }
      if (hw.length) {
        upgradePanel.body.append(famHeader(HEART_FAM));
        for (const x of hw.slice(0, 4)) {
          upgradeRows.push(mkUpgradeRow({
            id: x.id, family: 'heart', name: x.name, flavour: x.flavour, cost: x.cost,
            currency: 'blossoms', buy: () => { A.buyHeartwood(x.id); refresh(); },
          }));
        }
      }
      /* Nothing available is a real late-game state. The first version answered
         it with fourteen full-width rows each carrying an identical 済 LEARNED
         pill and no pressable control anywhere — a dead screen. It is now a
         sealed certificate that carries the ONE action left (turn the Season)
         plus a dense two-column index of what was learned. */
      if (!upgradeRows.length) {
        const canP = A.canPrestige();
        upgradePanel.body.append(h('div.sk-done',
          h('div.sl'),
          h('div.cap', bought.length ? 'Nothing left to learn' : 'Nothing to learn yet'),
          h('h3', bought.length ? '強化 完 · ALL LESSONS TAKEN' : '強化 未 · THE GROVE IS YOUNG'),
          h('div.fv', bought.length
            ? `All ${A.fmt(bought.length)} of them are yours. They keep until the Season turns — and the next Season starts with everything you have earned since the first.`
            : 'Buy a Tender or two and the grove will start suggesting things.'),
          bought.length
            ? h('div.act', canP
              ? goldBtn(`TURN THE SEASON  +${A.fmt(A.essencePreview())} 桜精`, () => { A.prestige(); refresh(); })
              : goldBtn('OPEN THE CONSTELLATION', () => selectTab('star'), { cls: 'ghost' }))
            : null));
        if (bought.length) {
          upgradePanel.body.append(famHeader({ id: 'done', kanji: '済', name: 'Learned', sub: `${bought.length} kept until the Season turns` }));
          const grid = h('div.sk-learned');
          for (const u of bought.slice().reverse()) {
            grid.append(h('div.sk-lchip', { class: 'fam-' + (u.family ?? 'grove'), title: `${u.name ?? u.id}\n${u.flavour ?? ''}` },
              h('i', famMeta(u.family).kanji), h('span', u.name ?? u.id)));
          }
          upgradePanel.body.append(grid);
        }
      }
      upgradeFootR.textContent = `${bought.length} learned`;
    }
    function famHeader(fam) {
      return h('div.sk-fam', h('div.d'), h('h4', fam.name), h('div.ln'),
        h('span.sk-hint', { style: { fontStyle: 'italic' } }, fam.sub ?? ''));
    }
    function mkUpgradeRow({ id, family, name, flavour, cost, currency, buy }) {
      const btn = buyBtn(buy, `${currency === 'blossoms' ? 'Engrave' : 'Learn'} ${name}`,
        currency === 'blossoms' ? 'ENGRAVE' : 'LEARN');
      btn.root.classList.add('sm');
      btn.set(A.fmt(cost), currency === 'blossoms' ? '桜花' : '花');
      const row = h('div.sk-up', { class: 'fam-' + family, onclick: buy },
        h('div.g', famMeta(family).kanji),
        h('h3', name),
        btn.root,
        h('div.fv', flavour ?? ''));
      upgradePanel.body.append(row);
      return { id, row, btn, cost, currency };
    }

    /* ============================================================== *
     * 6.  Codex modal — rarity cards with flip + shine
     * ============================================================== */
    function buildCodex(view = 'varieties') {
      /* `codexw`: twelve rarity cards at 6x2. Four across x three rows never fit
         inside an 82vh modal at any size we ship — the bottom row sat under the
         fold. See the .sk-codex block in ui-style.js for the measurements. */
      const p = panel({ title: 'SAKURA CODEX', kanji: '桜 図 鑑', cls: 'sk-modal codexw', close: closeModal });
      const list = A.codexViews();
      const detail = h('div.sk-detail',
        h('div.sk-title', { style: { fontSize: 'calc(var(--u)*1.0)' } }, '十二の桜'),
        h('div.sk-flavour', 'Twelve varieties answer to the Everblossom. Select one to read it.'));
      const grid = h('div.sk-codex');
      list.forEach((d, i) => {
        const r = d.rarity ?? 3;
        const found = !!(d.found ?? d.unlocked);
        const card = h('div.sk-rc', {
          class: 'r' + r + (found ? '' : ' locked'),
          style: { animationDelay: (i * 35) + 'ms' },
          onclick: () => {
            clear(detail).append(
              h('div.sk-title', { style: { fontSize: 'calc(var(--u)*1.05)' } }, found ? `${d.kanji}  ${d.name}` : '？？？'),
              h('div.sk-flavour', found ? d.desc : 'Not yet found. The grove keeps its own counsel.'));
            card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip');
          },
        },
          h('div.art', { style: found && d.tint ? { color: d.tint, textShadow: `0 2px 8px rgba(0,0,0,.45), 0 0 calc(var(--u)*1.6) ${d.tint}` } : null },
            found ? (d.kanji?.[0] ?? '桜') : '？', h('div.shine')),
          h('div.nameplate', stars(found ? r : 0, r),
            h('div.jp', found ? d.kanji : '？？？'),
            h('div.en', found ? d.name : 'undiscovered')));
        if (found) card.classList.add('flip');
        grid.append(card);
      });

      const achs = A.achievements();
      const got = achs.filter((a) => a.got).length;
      const achWrap = h('div.sk-achs');
      for (const a of achs) {
        achWrap.append(h('div.sk-ach', { class: a.got ? 'got' : '', title: a.desc },
          h('i'), h('span', a.got ? a.name : (a.secret ? '???' : a.name))));
      }

      /* Two views behind a segmented control. Stacked, the 48-row achievement
         grid sat below the modal's 82vh fold and read as unbuilt. */
      const nav = segmented([['桜 図鑑', 'varieties'], [`実績 ${got}/${achs.length}`, 'achievements']],
        (v) => openModal(buildCodex(v), 'codex'));
      nav.set(view);

      if (view === 'achievements' && achs.length) {
        mount(p.body, h('div.sk-mnav', nav.root),
          h('div.sk-flavour', { style: { textAlign: 'center', marginBottom: 'calc(var(--u)*.5)' } },
            'Every one of them is worth +1% of everything, forever.'),
          achWrap);
        p.root.append(h('div.sk-panel-foot',
          h('span.sk-hint', 'each one adds +1% to all production'),
          h('span.sk-hint.num', `${got} / ${achs.length} earned`)));
        return p.root;
      }

      /* the reading pane sits outside the scroll: at 1280x800 the card grid fills
         the modal, and a description that updates below the fold is invisible */
      mount(p.body, achs.length ? h('div.sk-mnav', nav.root) : null, grid);
      p.root.append(h('div.sk-nodebar', detail));
      p.root.append(h('div.sk-panel-foot',
        h('span.sk-hint', 'each variety tints the petals of the world'),
        h('span.sk-hint.num', `${list.filter((d) => d.found).length} / ${list.length} found`)));
      return p.root;
    }

    /* ============================================================== *
     * 7.  Constellation modal — radial star tree over a night sky
     * ============================================================== */
    function buildConstellation(preselect = null) {
      const p = panel({ title: 'CONSTELLATION', kanji: '星 屑 ノ 樹', cls: 'sk-modal wide', close: closeModal });
      const nodes = A.nodeViews();
      const branches = A.branches();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const hueOf = (n) => n.color ?? branches.find((b) => b.id === n.branch)?.color ?? '#CFD8F0';
      const pos = (n) => {
        const a = ((n.a ?? 0) * Math.PI) / 180;
        const r = n.r ?? 0.5;
        return [50 + Math.cos(a) * r * 45, 37 + Math.sin(a) * r * 33];
      };

      const sky = h('div.sk-sky');
      const s = svg('svg', { viewBox: '0 0 100 74', preserveAspectRatio: 'xMidYMid meet' });
      const grads = branches.map((b) =>
        `<radialGradient id="n_${b.id}"><stop offset="0" stop-color="#FFFFFF"/>` +
        `<stop offset=".45" stop-color="${b.color}"/><stop offset="1" stop-color="${b.color}" stop-opacity=".6"/></radialGradient>`).join('');
      s.innerHTML = `<defs>
          <radialGradient id="neb"><stop offset="0" stop-color="#9A7FD8"/><stop offset="1" stop-color="#9A7FD8" stop-opacity="0"/></radialGradient>
          <radialGradient id="nodeCore"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".4" stop-color="#FFE8B8"/><stop offset="1" stop-color="#D9A63C"/></radialGradient>
          <radialGradient id="nodeOff"><stop offset="0" stop-color="#79809F"/><stop offset="1" stop-color="#2A3050"/></radialGradient>
          ${grads}
          <filter id="glow" x="-140%" y="-140%" width="380%" height="380%">
            <feGaussianBlur stdDeviation="1.3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs><g opacity=".9">${STARFIELD}</g>`;
      const gEdge = svg('g', {}); const gNode = svg('g', {});
      s.append(gEdge, gNode);

      // core
      gNode.append(svg('circle', { cx: 50, cy: 37, r: 8, fill: 'url(#neb)', opacity: '.55' }));
      gNode.append(svg('circle', { cx: 50, cy: 37, r: 3.1, fill: 'url(#nodeCore)', stroke: '#FFF6DC', 'stroke-width': 0.3, filter: 'url(#glow)' }));
      const coreT = svg('text', { x: 50, y: 38.3, 'text-anchor': 'middle', 'font-size': 3.1, fill: '#3A2A08', 'font-family': '"Hiragino Mincho ProN","Yu Mincho","Songti SC",Georgia,serif' });
      coreT.textContent = '桜';
      gNode.append(coreT);

      for (const n of nodes) {
        const [x, y] = pos(n);
        const parent = n.req ? byId.get(n.req) : null;
        const [px, py] = parent ? pos(parent) : [50, 37];
        const lit = n.owned && (!parent || parent.owned);
        gEdge.append(svg('line', {
          x1: px, y1: py, x2: x, y2: y,
          stroke: lit ? hueOf(n) : 'rgba(150,164,210,.22)',
          'stroke-width': lit ? 0.42 : 0.24, 'stroke-linecap': 'round',
          filter: lit ? 'url(#glow)' : null,
        }));
      }

      /* The star map on its own left a player nothing to press — a node was a
         1.5%-of-width SVG circle. Selecting a star now fills a real card with a
         real AWAKEN button, which is also the only way to read what a node does. */
      const nodeHost = h('div');
      const detail = h('div.sk-detail', { style: { minHeight: '0' } },
        h('div.sk-flavour', 'Pick a star. Essence spent here still counts toward the +2% it grants — spend freely.'));
      const showNode = (n) => {
        if (!n) return;
        const hue = hueOf(n);
        let action;
        if (n.owned) {
          action = h('div.sk-taken', '刻 TAKEN');
        } else {
          const b = buyBtn(() => {
            if (!n.affordable) return;
            A.buyNode(n.id);
            openModal(buildConstellation(n.id), 'star');
            refresh();
          }, n.available ? `Awaken ${n.name}` : 'Take the star before it first', n.available ? 'AWAKEN' : 'SEALED');
          b.set(A.fmt(n.cost), '桜精');
          b.setEnabled(!!n.affordable);
          action = b.root;
        }
        clear(nodeHost).append(h('div.sk-nodecard',
          h('div.em', { style: { color: hue, borderColor: hue } }, n.kanji ?? '星'),
          h('div.br', `${n.branchName ?? ''} · ${ROMAN[Math.max(0, num(n.tier))] ?? ''}`),
          h('h3', n.name ?? ''),
          h('div.fv', n.flavour ?? ''),
          action));
      };

      for (const n of nodes) {
        const [x, y] = pos(n);
        const rr = n.tier >= 4 ? 1.9 : n.tier >= 2 ? 1.5 : 1.2;
        const g = svg('g', { style: 'cursor:pointer' });
        /* halos were rr*3.0 / rr*2.6 — on a 100-unit viewBox a tier-4 node threw
           a 5.7-unit smudge that swallowed its neighbours. Tight glow plus a
           crisp ring reads as "available" instead of as a blur artefact. */
        if (n.owned) g.append(svg('circle', { cx: x, cy: y, r: rr * 1.95, fill: hueOf(n), opacity: '.26' }));
        else if (n.affordable) {
          g.append(svg('circle', { cx: x, cy: y, r: rr * 1.8, fill: '#FFE6A8', opacity: '.2' }));
          g.append(svg('circle', {
            cx: x, cy: y, r: rr * 1.72, fill: 'none',
            stroke: '#FFDC92', 'stroke-width': 0.2, opacity: '.85',
            'stroke-dasharray': (rr * 0.5).toFixed(2) + ' ' + (rr * 0.34).toFixed(2),
          }));
        }
        g.append(svg('circle', {
          cx: x, cy: y, r: rr,
          fill: n.owned ? `url(#n_${n.branch})` : 'url(#nodeOff)',
          stroke: n.owned ? '#FFFFFF' : n.affordable ? '#FFE08A' : 'rgba(178,190,230,.4)',
          'stroke-width': n.owned ? 0.26 : n.affordable ? 0.3 : 0.16,
          filter: n.owned ? 'url(#glow)' : null,
        }));
        if (n.tier >= 3) {
          const t = svg('text', {
            x, y: y + rr * 0.42, 'text-anchor': 'middle', 'font-size': 1.6,
            fill: n.owned ? '#33240A' : 'rgba(226,232,255,.7)',
            'font-family': '"Hiragino Mincho ProN","Yu Mincho","Songti SC",Georgia,serif',
          });
          t.textContent = n.kanji ?? '';
          g.append(t);
        }
        /* select, never buy-on-touch: the card's AWAKEN button is the single
           purchase affordance, so a mis-aimed click can't spend Essence. */
        g.addEventListener('click', () => showNode(n));
        g.addEventListener('mouseenter', () => showNode(n));
        gNode.append(g);
      }
      sky.append(s);

      const legend = h('div.sk-legend', branches.map((b) =>
        h('span', h('i', { style: { background: b.color, boxShadow: '0 0 6px ' + b.color } }),
          h('span.sk-kanji', b.kanji), b.name)));

      const owned = nodes.filter((n) => n.owned).length;
      const canP = A.canPrestige();
      const gain = A.essencePreview();
      const cheapest = (list) => list.slice().sort((a, b) => num(a.cost) - num(b.cost))[0];
      showNode(
        (preselect && nodes.find((n) => n.id === preselect))
        ?? cheapest(nodes.filter((n) => n.affordable && !n.owned))
        ?? cheapest(nodes.filter((n) => n.available))
        ?? nodes.filter((n) => n.owned).pop()
        ?? nodes[0]);
      mount(p.body, sky, legend, detail);
      /* The card lives OUTSIDE the scrolling body: at 82vh the star map alone
         filled the modal and pushed the AWAKEN button below the fold. */
      p.root.append(h('div.sk-nodebar', nodeHost));
      p.root.append(h('div.sk-panel-foot',
        h('span.sk-hint.num', `${owned} / ${nodes.length} nodes · ${A.fmt(A.essence())} 桜精 held`),
        canP
          ? goldBtn(`TURN THE SEASON  +${A.fmt(gain)}`, () => { A.prestige(); closeModal(); refresh(); })
          : h('span.sk-hint', `Season turns at ${A.fmt(1e6)} petals earned`)));
      return p.root;
    }

    /* ============================================================== *
     * 8.  Settings modal
     * ============================================================== */
    function buildSettings() {
      const p = panel({ title: 'SETTINGS', kanji: '設 定', cls: 'sk-modal', close: closeModal });
      const io = h('textarea.sk-io', { spellcheck: 'false', placeholder: 'paste a save here, or press EXPORT to read yours out' });
      const confirmIn = h('input.sk-in', { type: 'text', placeholder: 'type ERASE' });
      const status = h('div.sk-hint', { style: { textAlign: 'right', minHeight: '1.3em' } }, '');
      const say = (m) => { status.textContent = m; };
      const st = A.state();
      mount(p.body,
        h('div.sk-row', h('div', h('div.lbl', 'Export save'), h('div.sub', 'base64 · copy it somewhere safe')),
          goldBtn('EXPORT', () => { io.value = A.exportSave(); io.select?.(); say('written into the box below'); })),
        h('div.sk-row', h('div', h('div.lbl', 'Import save'), h('div.sub', 'overwrites everything you have now')),
          goldBtn('IMPORT', () => say(A.importSave(io.value.trim()) ? 'save restored' : 'that string was refused'), { cls: 'ghost' })),
        io,
        h('div.sk-row', { style: { marginTop: 'calc(var(--u)*.7)' } },
          h('div', h('div.lbl', 'Hard reset'), h('div.sub', 'type ERASE to arm · everything is lost, including Blossoms')),
          h('div', { style: { display: 'flex', gap: 'calc(var(--u)*.4)', alignItems: 'center' } }, confirmIn,
            goldBtn('ERASE', () => {
              if (confirmIn.value.trim().toUpperCase() !== 'ERASE') { say('type ERASE first'); return; }
              A.hardReset(); say('the grove has been returned to winter'); closeModal(); refresh();
            }, { cls: 'danger' }))),
        status,
        h('div.sk-rule', { style: { margin: 'calc(var(--u)*.6) 0' } }),
        h('div.sk-row', h('div.lbl', 'Seasons turned'), h('b.num', A.fmt(num(st.season)))),
        h('div.sk-row', h('div.lbl', 'Shakes'), h('b.num', A.fmt(num(st.stats?.clicks)))),
        h('div.sk-row', h('div.lbl', 'Critical shakes'), h('b.num', A.fmt(num(st.stats?.crits)))),
        h('div.sk-row', h('div.lbl', 'Petals, all time'), h('b.num', A.fmt(num(st.totalAllTime)))),
        h('div.sk-row', h('div.lbl', 'Time in the grove'), h('b.num', A.time(num(st.stats?.playTime)))),
        h('div.sk-flavour', { style: { marginTop: 'calc(var(--u)*.9)', textAlign: 'center' } },
          'Autosaves every ten seconds and whenever you look away.'),
      );
      return p.root;
    }

    /* ============================================================== *
     * 9.  Tabs
     * ============================================================== */
    let activeTab = 'tenders';
    /** `toggle` is true only for a real click on the tab button, so a
     *  programmatic selectTab() never collapses the panel it was asked to open. */
    function selectTab(id, toggle = false) {
      if (id === 'codex' || id === 'star' || id === 'set') {
        if (toggle && scrim && scrim.__tab === id) { closeModal(); return; }
        openModal(id === 'codex' ? buildCodex() : id === 'star' ? buildConstellation() : buildSettings(), id);
        return;
      }
      const hadModal = !!scrim;
      closeModal();
      activeTab = (toggle && !hadModal && activeTab === id && railHost.firstChild) ? null : id;
      clear(railHost);
      if (activeTab === 'tenders') railHost.append(tenderPanel.root);
      else if (activeTab === 'upgrades') { buildUpgrades(); railHost.append(upgradePanel.root); }
      syncTabs();
      refresh();
    }
    function syncTabs() {
      for (const [id, el] of tabEls) setClass(el, 'on', id === activeTab || !!(scrim && scrim.__tab === id));
    }
    railHost.append(tenderPanel.root);
    syncTabs();

    /* ============================================================== *
     * 10.  Toasts / fly numbers / set pieces
     * ============================================================== */
    const toastQ = [];
    let toastTimer = 0;
    function toast(t) {
      toastQ.push(t);
      if (toastQ.length > 24) toastQ.shift();
    }
    const KIND_CAP = {
      achievement: 'Achievement', codex: 'New Variety', upgrade: 'Upgrade',
      node: 'Constellation', heartwood: 'Heartwood', event: 'Live Event',
      boon: 'Golden Petal', milestone: 'Milestone',
    };
    function pumpToasts(dt) {
      toastTimer -= dt;
      if (toastTimer > 0 || !toastQ.length) return;
      const t = toastQ.shift();
      const el = h('div.sk-toast.sk-paper', { class: 'r' + (t.rarity ?? 4) }, corners(true),
        h('div.glyph'),
        h('div', { style: { minWidth: '0' } },
          h('div.cap', KIND_CAP[t.kind] ?? 'Unlocked'),
          h('div.nm', t.title ?? ''),
          t.body ? h('div.rw', t.body) : null));
      toasts.append(el);
      toastTimer = 0.8;
      if (!ctx.shotMode) {
        setTimeout(() => {
          el.style.transition = 'opacity .4s ease, transform .4s ease';
          el.style.opacity = '0'; el.style.transform = 'translateX(30%)';
          setTimeout(() => el.remove(), 460);
        }, 4600);
      }
      while (toasts.childElementCount > 5) toasts.firstChild.remove();
    }

    const _v3 = new THREE.Vector3();
    let flyCount = 0;
    let bankPt = null;                       // cached; layout reads never happen per frame
    const bankAnchor = () => {
      if (bankPt) return bankPt;
      const r = elBank.getBoundingClientRect();
      bankPt = r.width ? { x: r.left + r.width * 0.5, y: r.top + r.height * 0.55 } : { x: 90, y: 40 };
      return bankPt;
    };
    const offResize = ctx.bus.on('resize', () => { bankPt = null; });

    /** Gain numbers pop at the hit, hang, then fly to the HUD counter (ART_BIBLE §7). */
    function flyNumber(amount, worldPoint, crit) {
      if (flyCount > 14 || ctx.shotMode) return;
      let x = ctx.size.w * 0.42, y = ctx.size.h * 0.42;
      if (worldPoint && ctx.camera) {
        _v3.set(num(worldPoint.x), num(worldPoint.y), num(worldPoint.z)).project(ctx.camera);
        x = (_v3.x * 0.5 + 0.5) * ctx.size.w;
        y = (-_v3.y * 0.5 + 0.5) * ctx.size.h;
      }
      const el = h('div.sk-fly' + (crit ? '.crit' : ''), { style: { left: x + 'px', top: y + 'px' } },
        '+' + A.fmt(amount) + (crit ? ' ✦' : ''));
      flyLayer.append(el); flyCount++;
      const kill = () => { if (el.isConnected) { el.remove(); flyCount--; } };
      const b = bankAnchor();
      const dx = b.x - x, dy = b.y - y;
      const rise = crit ? -64 : -40;
      const anim = el.animate?.([
        { transform: 'translate(-50%,0) scale(.65)', opacity: 0, offset: 0 },
        { transform: `translate(-50%,${rise * 0.45}px) scale(${crit ? 1.22 : 1.1})`, opacity: 1, offset: 0.14 },
        { transform: `translate(-50%,${rise}px) scale(1)`, opacity: 1, offset: 0.42 },
        { transform: `translate(-50%,${rise}px) scale(1)`, opacity: 1, offset: 0.5 },
        { transform: `translate(calc(-50% + ${dx * 0.45}px),${dy * 0.28 + rise}px) scale(.8)`, opacity: .95, offset: 0.74 },
        { transform: `translate(calc(-50% + ${dx}px),${dy}px) scale(.42)`, opacity: 0, offset: 1 },
      ], { duration: crit ? 1250 : 1050, easing: 'cubic-bezier(.3,.05,.25,1)', fill: 'forwards' });
      if (anim) anim.onfinish = kill; else setTimeout(kill, 1200);
      setTimeout(kill, 1800);
    }

    let stageCard = null, stageCardT = 0;
    function stageUp(info) {
      const stages = A.stages();
      const i = Math.max(0, Math.min(5, num(info?.stage)));
      const s = stages[i] ?? STAGE_DEFS[i];
      stageCard?.remove();
      stageCard = h('div.sk-stageup',
        h('div.dim'), h('div.glow'),
        h('div.card',
          h('div.bars.t'), h('div.bars.b'),
          h('div.eyebrow', 'Bloom Stage ' + ROMAN[i]),
          h('div.kj', info?.kanji ?? s.kanji),
          h('div.en', String(info?.name ?? s.name).toUpperCase()),
          h('div.blurb', info?.blurb ?? s.blurb ?? ''),
          h('div.reward', `+${A.fmt(num(info?.blossoms ?? i * 3))} Blossoms 桜花`)));
      ui.append(stageCard);
      stageCardT = 4.6;
    }

    let welcomeShown = false;
    function welcomeBack(r) {
      if (!r) return;
      const away = num(r.awayS ?? r.seconds);
      const gained = num(r.gained ?? r.petals);
      const p = panel({ title: 'WELCOME BACK', kanji: 'お か え り', cls: 'sk-modal sk-wb', close: dismiss });
      function dismiss() { A.clearOffline(); closeModal(); }
      const stages = A.stages();
      mount(p.body,
        h('div.band'),
        h('div.lead', 'The grove kept working while you were gone.'),
        h('div.big.num', '+' + A.fmt(gained)),
        h('div.cap', 'petals gathered'),
        h('div.stat', h('span', 'Time away'), h('b.num', A.time(away))),
        h('div.stat', h('span', 'Counted'), h('b.num', A.time(num(r.cappedS ?? away)))),
        h('div.stat', h('span', 'Idle rate'), h('b.num', Math.round(num(r.rate ?? 0.55) * 100) + '% of live')),
        h('div.stat', h('span', 'Dew Reservoir'), h('b.num', r.capped ? `FULL — ${A.fmt(num(r.capH ?? 3))} h` : `${A.fmt(num(r.capH ?? 3))} h`)),
        Array.isArray(r.stages) && r.stages.length
          ? h('div.stat', h('span', 'Bloom advanced to'),
            h('b', `${stages[r.stages[r.stages.length - 1]]?.kanji ?? ''} ${stages[r.stages[r.stages.length - 1]]?.name ?? ''}`))
          : null,
        h('div.note', '“The petals do not wait for anyone, and they do not hold it against you.”'),
      );
      p.root.append(h('div.sk-panel-foot', { style: { justifyContent: 'center' } }, goldBtn('GATHER THEM', dismiss)));
      openModal(p.root, 'welcome');
    }

    function doShake() {
      A.shake();
      shakeBtn.animate?.(
        [{ transform: 'translateX(-50%) scale(1)' }, { transform: 'translateX(-50%) scale(.95)' }, { transform: 'translateX(-50%) scale(1)' }],
        { duration: 150, easing: 'cubic-bezier(.2,.9,.25,1.15)' });
    }

    /* ============================================================== *
     * 11.  Per-frame sync
     * ============================================================== */
    const tickBank = makeTicker(elBank, (v) => A.fmt(v));
    const tickRate = makeTicker(elRate, (v) => A.rate(v), 0.24);
    const tickShake = makeTicker(elShake, (v) => A.fmt(v), 0.24);
    const tickShake2 = makeTicker(elShake2, (v) => A.fmt(v), 0.24);
    const tickBloss = makeTicker(elBlossom, (v) => A.fmt(v), 0.2);
    const tickEss = makeTicker(elEssence, (v) => A.fmt(v), 0.2);

    let dirty = true;
    function refresh() { dirty = true; }

    /** Bottom fade while there is more list below. One layout read per 125 ms. */
    function markScroll(body) {
      if (!body) return;
      setClass(body, 'more', body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    }
    for (const b of [tenderPanel.body, upgradePanel.body]) {
      b.addEventListener('scroll', () => markScroll(b), { passive: true });
    }

    function syncStage() {
      const st = A.stage();
      const cur = A.bloom() ?? STAGE_DEFS[st];
      const nxt = A.nextBloom();
      setText(elStageK, cur.kanji ?? '');
      setText(elStageN, cur.name ?? '');
      setText(elStageI, ROMAN[st] + ' / VI');
      const total = A.totalSeason();
      setText(elStageA, A.fmt(total) + ' 花びら');
      // the capsule carries the whole run in log space; ticks mark the thresholds
      stageBar.set(nxt ? total : Infinity);
      if (!nxt) { setText(elStageB, '常桜 · ETERNAL'); return; }
      const hi = num(nxt.need ?? nxt.threshold);
      setText(elStageB, A.fmt(hi) + ' → ' + (nxt.kanji ?? ''));
    }

    function syncTenders() {
      const views = A.tenderViews();
      const bulk = A.bulk();
      const petals = A.petals();
      let shown = 0, live = 0, nextHidden = null;
      for (const v of views) {
        const r = tenderRows.get(v.id);
        if (!r) continue;
        /* a scenario switch (lategame -> fresh) must be able to take rows away
           again, or the sealed row disappears and the bands lie */
        if (r.revealed && !v.revealed) {
          r.revealed = false;
          r.row.style.display = 'none';
          const rule = bandRules.get(v.id);
          if (rule) rule.style.display = 'none';
        }
        if (!r.revealed && !v.revealed && !nextHidden) nextHidden = { v, r };
        if (!r.revealed && v.revealed) {
          r.revealed = true;
          r.row.style.display = '';
          const rule = bandRules.get(v.id);
          if (rule) rule.style.display = '';
          if (!ctx.shotMode) { r.row.classList.add('reveal'); setTimeout(() => r.row.classList.remove('reveal'), 720); }
        }
        if (!r.revealed) continue;
        shown++;
        /* MAX with nothing affordable resolves to 0 of them, whose price is 0 —
           showing "0" as a cost is a lie, so fall back to the single unit. */
        let cnt = num(v.bulkCount ?? 1);
        let cost = num(v.bulkCost ?? v.cost);
        if (cnt <= 0 || !(cost > 0)) { cnt = 1; cost = num(v.cost); }
        setText(r.cnt, String(num(v.owned)));
        setText(r.outEach, A.rate(num(v.each)));
        setText(r.outTotal, A.rate(num(v.total)));
        r.btn.set(A.fmt(cost), '×' + cnt);
        const can = petals >= cost && cnt > 0;
        r.btn.setEnabled(can);
        setClass(r.row, 'buy', can);
        setClass(r.row, 'poor', !can);
        const owned = num(v.owned);
        const nextM = num(v.milestone) || A.milestones().find((m) => m > owned);
        if (nextM) {
          const ms = A.milestones();
          const prevM = ms.filter((m) => m <= owned).pop() ?? 0;
          r.mBar.set((owned - prevM) / Math.max(1, nextM - prevM));
          setText(r.mPre, 'next ×2 at ');
          setText(r.mLbl, String(nextM));
        } else {
          r.mBar.set(1);
          setText(r.mPre, 'all milestones · ');
          setText(r.mLbl, '×' + (num(v.milestoneMult) || 64));
        }
        live += num(v.total);
      }
      bulkSeg?.set(bulk);
      if (tenderTotalEl) setText(tenderTotalEl, shown ? `${A.rate(live)} /s base · ${shown} kinds` : '');

      if (teaser) {
        const want = !!nextHidden;
        if ((teaser.style.display !== 'none') !== want) teaser.style.display = want ? '' : 'none';
        if (want) {
          // reveal rule (60-game): bestBank >= baseCost * 0.4
          setText(teaserNeed, A.fmt(num(nextHidden.v.baseCost ?? nextHidden.r.d.baseCost) * 0.4));
        }
      }
    }

    function syncUpgrades() {
      buildUpgrades();
      const petals = A.petals(), bloss = A.blossoms();
      for (const r of upgradeRows) {
        const have = r.currency === 'blossoms' ? bloss : petals;
        const can = have >= r.cost;
        r.btn.setEnabled(can);
        setClass(r.row, 'buy', can);
        setClass(r.row, 'poor', !can);
      }
    }

    function syncEvent() {
      const evs = A.events();
      let pick = null;
      if (evs) {
        for (const id of EVENT_PRIORITY) {
          const e = evs[id];
          if (e && e.active) { pick = { id, remain: num(e.remain) }; break; }
        }
      }
      if (!pick) { if (eventEl) { eventEl.remove(); eventEl = null; eventId = null; } return; }
      if (pick.remain > (eventDur[pick.id] ?? 0)) eventDur[pick.id] = pick.remain;
      if (pick.id !== eventId) {
        eventEl?.remove();
        const m = EVENT_META[pick.id] ?? EVENT_DEFS[pick.id] ?? { kanji: '祭', name: 'Live Event', desc: '' };
        eventFill = h('i', { style: { width: '100%' } });
        eventEl = h('div.sk-event',
          h('div.sk-event-t', h('em', { class: 'sk-kanji' }, m.kanji), String(m.name).toUpperCase()),
          h('div.sk-event-d', m.desc),
          h('div.sk-event-bar', eventFill));
        ui.append(eventEl);
        eventId = pick.id;
        if (pick.remain <= 0) eventDur[pick.id] = 0;
      }
      const dur = eventDur[pick.id] ?? 0;
      if (eventFill) setW(eventFill, dur > 0 ? Math.max(0, Math.min(1, pick.remain / dur)) * 100 : 100);
    }

    function syncMisc() {
      const gp = A.golden();
      const want = !!gp;
      if ((goldenHint.style.display !== 'none') !== want) goldenHint.style.display = want ? '' : 'none';
      const can = A.canPrestige();
      if ((seasonChip.style.display !== 'none') !== can) seasonChip.style.display = can ? '' : 'none';
      /* First run: the one Tender row on screen costs 15 and the player holds 0,
         so every buy button in the frame is correctly disabled. Promote the shake
         control to the hero affordance until the first Tender is standing, or the
         game presents itself as unclickable. */
      const r = A.rates();
      const first = num(r.totalTenders) <= 0 && num(r.perSecond) <= 0;
      setClass(shakeBtn, 'first', first);

      /* the bus event may have fired before we subscribed (lighting is order 8) */
      const pid = PHASE_META[G()?.phase] ? G().phase : phaseId;
      if (pid !== phaseId) phaseId = pid;
      const ph = PHASE_META[phaseId] ?? PHASE_META.day;
      setText(elPhaseK, ph.kanji);
      setText(elPhaseN, ph.name);
      setText(elPhaseNote, ph.note);
      for (const k in PHASE_META) setClass(phaseChip, 'p-' + k, k === phaseId);
    }

    /* 08-lighting owns the phase and announces it; ctx.assets.game mirrors it, so
       read whichever is available and fall back to day. */
    let phaseId = 'day';
    let slow = 0;
    function update(dt) {
      const r = A.rates();
      tickBank.set(A.petals());
      tickRate.set(num(r.perSecond));
      const cv = num(r.perShake) || 1;
      tickShake.set(cv); tickShake2.set(cv);
      tickBloss.set(A.blossoms()); tickEss.set(A.essence());
      tickBank.update(dt); tickRate.update(dt); tickShake.update(dt); tickShake2.update(dt);
      tickBloss.update(dt); tickEss.update(dt);
      setText(elCrit, Math.round(num(r.critChance) * 100) + '%');

      pumpToasts(dt);
      /* In shot mode the harness warms hundreds of frames after the scenario
         runs, which used to expire the set piece before the shutter opened. */
      if (stageCard && !ctx.shotMode) {
        stageCardT -= dt;
        if (stageCardT <= 0) { stageCard.remove(); stageCard = null; }
      }

      slow -= dt;
      if (slow <= 0 || dirty) {
        slow = 0.125; dirty = false;
        syncStage();
        syncTenders();
        if (activeTab === 'upgrades') syncUpgrades();
        syncEvent();
        syncMisc();
        markScroll(activeTab === 'upgrades' ? upgradePanel.body : tenderPanel.body);
        if (scrim?.__body) markScroll(scrim.__body);
      }

      if (!welcomeShown) {
        const rep = A.offlineReport();
        if (rep) { welcomeShown = true; welcomeBack(rep); }
      }
    }

    /* ============================================================== *
     * 12.  Bus wiring
     * ============================================================== */
    const offs = [
      ctx.bus.on('state:changed', refresh),
      ctx.bus.on('upgrade:bought', refresh),
      ctx.bus.on('game:toast', (p) => toast(p ?? {})),
      ctx.bus.on('game:stageup', (p) => { stageUp(p); refresh(); }),
      ctx.bus.on('game:offline', (p) => { welcomeShown = true; welcomeBack(p); }),
      ctx.bus.on('game:event', refresh),
      ctx.bus.on('game:golden', refresh),
      ctx.bus.on('game:scenario', () => { upgradeKey = ''; welcomeShown = false; refresh(); }),
      ctx.bus.on('petals:gain', (p) => { if (p && p.amount > 0 && p.point) flyNumber(p.amount, p.point, !!p.crit); }),
      ctx.bus.on('bloom:stage', refresh),
      ctx.bus.on('time:phase', (p) => { phaseId = p?.phase ?? phaseId; refresh(); }),
      offResize,
    ];

    /* ============================================================== *
     * 13.  Keyboard — 60-game owns Space and 1–0; we own the panels.
     * ============================================================== */
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { if (scrim) closeModal(); else if (activeTab) selectTab(activeTab, true); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const order = TABS.map((x) => x.id);
        const cur = (scrim && scrim.__tab) || activeTab || order[order.length - 1];
        const i = order.indexOf(cur);
        selectTab(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
        return;
      }
      if (A.ownsKeyboard()) return;              // game module already handles these
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) doShake(); return; }
      if (/^[1-9]$/.test(e.key)) {
        const v = A.tenderViews()[+e.key - 1];
        if (v && v.revealed) buyTender(v.id);
      }
    };
    window.addEventListener('keydown', onKey);

    /* ============================================================== *
     * 14.  Debug scenarios — layered on top of the game's own
     * ============================================================== */
    const S = window.__game?.scenarios;
    if (S) {
      const base = (name) => { try { S[name]?.(); } catch { /* ignore */ } upgradeKey = ''; refresh(); update(0); update(0.5); update(0.5); };
      S['ui-fresh'] = () => { base('fresh'); selectTab('tenders'); };
      S['ui-rich'] = () => { base('rich'); selectTab('tenders'); };
      S['ui-lategame'] = () => { base('lategame'); selectTab('tenders'); };
      S['ui-upgrades'] = () => { base('rich'); selectTab('upgrades'); };
      S['ui-upgrades-late'] = () => { base('lategame'); selectTab('upgrades'); };
      S['ui-codex'] = () => { base('rich'); selectTab('codex'); };
      S['ui-codex-full'] = () => { base('lategame'); selectTab('codex'); };
      S['ui-achievements'] = () => { base('rich'); openModal(buildCodex('achievements'), 'codex'); };
      S['ui-star'] = () => { base('rich'); selectTab('star'); };
      S['ui-star-late'] = () => { base('lategame'); selectTab('star'); };
      S['ui-settings'] = () => { base('rich'); selectTab('set'); };
      S['ui-storm'] = () => { base('rich'); try { S['game-storm']?.(); } catch { /* ignore */ } refresh(); update(0.2); };
      /* `game-stageup` bumps state.stage by hand, but the harness then warms 420
         frames and 60-game's applyStage() recomputes the stage from
         totalThisSeason and puts it back — so the frame showed a 輝咲 STAGE V
         card over a HUD reading 満開 IV / VI. Load the measured stage-4 state
         instead, so the announcement and the readout agree. */
      S['ui-stageup'] = () => {
        base('stage4');
        const s = (A.stages()[4] ?? STAGE_DEFS[4]) ?? {};
        stageUp({ stage: 4, kanji: s.kanji, name: s.name, blurb: s.blurb, blossoms: 12 });
        update(0.2);
      };
      S['ui-welcome'] = () => { base('rich'); welcomeShown = false; try { S['game-offline']?.(); } catch { /* ignore */ } };
      S['ui-toasts'] = () => {
        base('rich');
        toast({ kind: 'achievement', title: 'One With The Branch', body: 'Shake the tree a million times.', rarity: 4 });
        toast({ kind: 'codex', title: '御衣黄  Gyoiko', body: 'Green sakura. You will argue with yourself about what you saw.', rarity: 5 });
        toast({ kind: 'upgrade', title: 'Windward Shrine', body: 'Storms linger. The shrine gives them a reason to stay.', rarity: 3 });
        for (let i = 0; i < 3; i++) pumpToasts(1);
      };
    }

    window.__ui = { toast, stageUp, welcomeBack, selectTab, closeModal, refresh, adapter: A };

    update(0);
    update(0.4);

    return {
      update,
      resize() { /* pure CSS layout */ },
      dispose() {
        for (const off of offs) { try { off(); } catch { /* ignore */ } }
        window.removeEventListener('keydown', onKey);
        ui.remove();
        document.getElementById('sakura-ui-style')?.remove();
      },
    };
  },
};

/* Deterministic starfield markup for the constellation sky (built once). */
const STARFIELD = (() => {
  let a = 0x2b17 >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let s = '';
  for (let i = 0; i < 5; i++) s += `<circle cx="${(r() * 100).toFixed(1)}" cy="${(r() * 74).toFixed(1)}" r="${(8 + r() * 16).toFixed(1)}" fill="url(#neb)" opacity=".24"/>`;
  for (let i = 0; i < 190; i++) {
    s += `<circle cx="${(r() * 100).toFixed(2)}" cy="${(r() * 74).toFixed(2)}" r="${(0.1 + r() * r() * 0.44).toFixed(2)}" fill="#EAF0FF" opacity="${(0.16 + r() * 0.74).toFixed(2)}"/>`;
  }
  return s;
})();
