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
import { SETTINGS } from '../lib/settings.js';
import {
  h, clear, mount, setText, setClass, setW,
  formatNumber, formatRate, formatTime,
  TENDER_DEFS, MILESTONES, STAGE_DEFS, EVENT_DEFS, CODEX_DEFS,
  UPGRADE_FAMILIES, CONSTEL_BRANCHES,
  makeTicker, panel, bar, stars, corners, goldBtn,
  buyBtn, segmented, stageCapsule, rarityOf, groupRule, sealedRow,
  slider, toggleRow, groupHead, noteBox,
  focusables, focusIt, uid,
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
  dawn: { kanji: '朝', name: '새벽', note: '첫 빛' },
  day: { kanji: '昼', name: '낮', note: '온갖 햇살' },
  dusk: { kanji: '夕', name: '황혼', note: '황금시 +15%' },
  night: { kanji: '夜', name: '밤', note: '보름달 +25%' },
};
/**
 * Keyboard map — the whole of it, in one place, so a new binding cannot quietly
 * collide with an old one.
 *
 * Owned by 60-game.js:  Space (shake the bough), 1–9 / 0 (buy Tender n).
 * Owned here:           Esc (close / back), S or , (settings), [ and ] (cycle panels).
 *
 * Tab is owned by NOBODY. It used to be bound here to cycle panels, with
 * `preventDefault()` on a window listener — which meant the browser's own focus
 * navigation never ran and NOTHING in this UI could be reached without a mouse,
 * including the accessibility controls this panel exists for. Panel cycling moved
 * to [ and ]. Do not bind Tab, Shift+Tab, or the arrow keys at window level.
 */
const KEY_HELP = [
  ['Space', '나뭇가지 흔들기'],
  ['1–9', '정령 구매'],
  ['S', '이 설정'],
  ['[  ]', '패널 순환'],
  ['Esc', '닫기'],
  ['Tab', '컨트롤 사이 이동'],
];
const EVENT_META = {
  storm: { kanji: '花嵐', name: 'Petal Storm', desc: '초당 ×10 꽃잎 · 온 언덕이 공기 중에 떠 있다' },
  rain: { kanji: '春雨', name: 'Spring Rain', desc: '초당 +10% 꽃잎 · 낙화가 흘러내리듯 천천히' },
  moon: { kanji: '満月', name: 'Full Moon', desc: '달이 떠 있는 동안 +25% 치명타' },
  goldenHour: { kanji: '黄金時', name: 'Golden Hour', desc: '빛이 머무는 동안 매 흔들기 +15%' },
  frenzy: { kanji: '狂咲', name: 'Frenzy', desc: '초당 ×7 꽃잎' },
  clickFrenzy: { kanji: '乱打', name: 'Click Frenzy', desc: '매 흔들기 ×77' },
  bloomfall: { kanji: '花降', name: 'Bloomfall', desc: '숲의 1분이 한꺼번에 떨어진다' },
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
     * 1b.  Settings bridge
     *
     * SETTINGS (src/lib/settings.js) is the single source of truth — this
     * module keeps NO copy of a volume or a motion flag. It writes through
     * SETTINGS.set/patch, and re-reads SETTINGS.all whenever anything changes,
     * including changes made by somebody else.
     *
     * The extra `ctx.assets.audio` calls below are belt and braces. The audio
     * module has its own bus mix; until it applies SETTINGS itself, driving its
     * public API from here is what makes the master volume and the mutes do
     * something audible TODAY rather than at some later commit. Every call is
     * optional-chained: `ctx.assets.audio` does not exist in shot mode, and
     * boots at order 70 — after us.
     * ============================================================== */
    const AUDIO = () => ctx.assets?.audio ?? null;
    /** The graph's designed stem mix (70-audio: music/amb .9, sfx .8). The
     *  player's per-stem volume SCALES that mix instead of replacing it, so a
     *  slider at 100% restores the sound designer's balance and never exceeds it.
     *  Master is deliberately left out — `setVolume()` already owns it, and
     *  applying it twice would square it. */
    const STEM = { music: 0.9, amb: 0.9, sfx: 0.8 };
    /** Tracks the audio module's gesture-unlock so the mix can be re-applied. */
    let audioUnlocked = false;

    function applyAudioSettings() {
      const a = AUDIO();
      if (!a) return;
      const s = SETTINGS.all;
      try { a.setVolume?.(s.masterVolume); } catch { /* audio graph not up yet */ }
      try { a.setMuted?.(!!s.muteAll); } catch { /* ignore */ }
      /* Separate stems are the audio agent's next job; if the setters are
         already there, honour the music/sfx mutes now. Ambience rides with
         music — it is the same continuous bed, not an effect. */
      const music = (s.muteAll || s.muteMusic) ? 0 : s.musicVolume;
      const sfx = (s.muteAll || s.muteSfx) ? 0 : s.sfxVolume;
      try { a.setMusicVolume?.(STEM.music * music); } catch { /* ignore */ }
      try { a.setAmbientVolume?.(STEM.amb * music); } catch { /* ignore */ }
      try { a.setSfxVolume?.(STEM.sfx * sfx); } catch { /* ignore */ }
    }

    /** Controls currently on screen, so a live SETTINGS change repaints them. */
    let setCtl = null;
    /** The always-visible HUD mute button; built with the rest of the HUD below. */
    let muteBtn = null;

    function syncSettingsUi() {
      const s = SETTINGS.all;
      /* Reduce motion covers the HUD's own animation too — see ui-style.js
         `#ui-root.rm`. The camera flags cannot reach DOM keyframes. */
      setClass(root, 'rm', !!s.reducedMotion);
      if (muteBtn) {
        setClass(muteBtn, 'off', !!s.muteAll);
        muteBtn.setAttribute('aria-pressed', s.muteAll ? 'true' : 'false');
        muteBtn.setAttribute('aria-label', s.muteAll
          ? '소리가 꺼져 있습니다. 모든 소리를 켭니다'
          : '소리가 켜져 있습니다. 모든 소리를 끕니다');
        muteBtn.title = s.muteAll ? '소리 꺼짐 — 클릭하면 다시 켭니다' : '모든 소리 끄기  音';
      }
      /* Both states are announced, not just recoloured. One string covers both so
         `announce`'s de-dupe means the many no-change syncs cost nothing, and
         switching a state back OFF is spoken as clearly as switching it on. */
      announce(
        (s.muteAll ? '모든 소리가 음소거되었습니다.' : '소리가 켜졌습니다.') + ' '
        + (s.reducedMotion
          ? '동작 감소 켜짐 — 화면 흔들림, 카메라 흐름, 섬광이 억제됩니다.'
          : '동작 효과가 켜졌습니다.'));

      /* No isConnected test here: buildSoundAndMotion() paints its controls
         before they are mounted, and an isConnected check would drop the handle
         at build time and leave every control in the panel dead. closeModal()
         is what releases it. */
      if (!setCtl) return;
      setCtl.master.set(s.masterVolume);
      setCtl.music.set(s.musicVolume);
      setCtl.sfx.set(s.sfxVolume);
      setCtl.master.setDimmed(s.muteAll);
      setCtl.music.setDimmed(s.muteAll || s.muteMusic);
      setCtl.sfx.setDimmed(s.muteAll || s.muteSfx);
      setCtl.muteAll.set(s.muteAll);
      setCtl.muteMusic.set(s.muteMusic);
      setCtl.muteSfx.set(s.muteSfx);
      /* muteAll subsumes the per-stem mutes: showing them as still-settable
         while nothing can be heard is a lie about what the controls do */
      setCtl.muteMusic.setDisabled(s.muteAll);
      setCtl.muteSfx.setDisabled(s.muteAll);

      const rm = !!s.reducedMotion;
      setCtl.reduced.set(rm);
      setCtl.shake.set(rm ? false : s.screenShake);
      setCtl.drift.set(rm ? false : s.cameraDrift);
      setCtl.flashes.set(rm ? false : s.flashes);
      setCtl.shake.setDisabled(rm);
      setCtl.drift.setDisabled(rm);
      setCtl.flashes.setDisabled(rm);
    }

    const offSettings = SETTINGS.on('change', () => {
      applyAudioSettings();
      syncSettingsUi();
    });

    /* ============================================================== *
     * 2.  DOM skeleton — HUD
     * ============================================================== */
    const ui = h('div.sk-ui', { style: { position: 'absolute', inset: '0' } });
    root.append(ui);

    /* Polite live region. Mute and Reduce motion are the two states a player
       flips *because something is hurting*, and both used to be reported by
       colour alone (a dimmed slider, a gold capsule). Say them out loud. */
    const liveEl = h('div.sk-sr', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    ui.append(liveEl);
    let lastSaid = '';
    function announce(msg) {
      if (!msg || msg === lastSaid) return;
      lastSaid = msg;
      /* clear first: identical consecutive text is not re-announced */
      liveEl.textContent = '';
      liveEl.textContent = msg;
    }

    const elBank = h('span.sk-bank-val.num', '0');
    const elRate = h('b.num', '0.00');
    const elShake = h('b.num', '1');
    const elShake2 = h('b.num', '1');
    const elCrit = h('span.num', '3%');
    const elBlossom = h('span.num', '0');
    const elEssence = h('span.num', '0');
    const elStageK = h('div.sk-stage-k', '冬芽');
    const elStageN = h('div.sk-stage-n', '겨울 눈봉우리');
    const elStageI = h('div.sk-stage-i', 'I / VI');
    const elStageA = h('span.num', '0');
    const elStageB = h('span.num', '1,000');

    const seasonChip = h('button.sk-chip.season', {
      type: 'button', onclick: () => selectTab('star'),
      title: '계절을 돌립니다', 'aria-label': '계절 준비 완료 — 별자리(은하수)를 엽니다',
    }, h('i', { 'aria-hidden': 'true' }), h('span', '계절 준비 완료'));
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
    const elPhaseN = h('b', '낮');
    const elPhaseNote = h('span', '온갖 햇살');
    const phaseChip = h('div.sk-phase', { title: '시간대' }, elPhaseK,
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
          h('div.sk-chip.blossom', { title: '꽃송이 桜花 — 영구적, 절대 초기화되지 않음' }, h('i'), elBlossom),
          h('div.sk-chip.essence', { title: '벚꽃 정수 桜精 — 계절을 돌려서 획득' }, h('i'), elEssence),
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

    /* A real <button>, not a div with an onclick. It is the game's primary verb;
       a primary verb that only a mouse can press is not a verb. Enter and Space
       come free from the element, and the gate on `ui` (§13) stops the Space that
       activates it from ALSO reaching 60-game's window handler and double-shaking. */
    const shakeBtn = h('button.sk-shake', {
      type: 'button', onclick: () => doShake(),
      title: '가지 흔들기  (Space)',
      'aria-label': '가지 흔들기 — Space',
    },
      h('div.tip', { 'aria-hidden': 'true' }, '여기서 시작 — 가지를 흔들면 꽃잎이 떨어집니다'),
      h('kbd', { 'aria-hidden': 'true' }, '스페이스'),
      h('span', '가지 흔들기'),
      h('div.bar', { 'aria-hidden': 'true' }),
      elShake2,
      h('span', { style: { opacity: '.66', letterSpacing: '.16em' }, 'aria-hidden': 'true' }, '꽃잎'));
    ui.append(shakeBtn);

    /* One-click mute, bottom-left, always on screen. The full mix lives behind
       the 設 tab, but a sound that startles you needs a control you can hit in
       one click without hunting through a panel — so this is not a shortcut for
       the settings screen, it is the thing people actually reach for. */
    muteBtn = h('button.sk-mute', {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': '모든 소리 음소거',
      title: '모든 소리 음소거  音',
      onclick: (e) => { e.stopPropagation(); SETTINGS.set('muteAll', !SETTINGS.get('muteAll')); },
    }, h('i', { 'aria-hidden': 'true' }));
    ui.append(muteBtn);

    const helpBtn = h('button.sk-help', {
      type: 'button',
      'aria-label': '도움말 열기',
      title: '도움말 — ? 키',
      onclick: (e) => { e.stopPropagation(); openHelp(); },
    }, h('i', { 'aria-hidden': 'true' }, '?'));
    ui.append(helpBtn);

    /* 도움말 진입 버튼 — 좌측 하단 muteBtn 바로 위.
       사용자 발견성을 최우선으로, 큰 라벨 형태로 명확히 표시한다. */
    const helpEntry = h('button.sk-help-entry', {
      type: 'button',
      'aria-label': '도움말 열기',
      title: '도움말 — ? 키',
      onclick: (e) => { e.stopPropagation(); openHelp(); },
    },
      h('span.ico', '?'),
      h('span.label', '도움말'),
      h('span.kbd', '?'),
    );
    ui.append(helpEntry);

    const goldenHint = h('div.sk-golden', h('i'), h('span', '황금 꽃잎 — 잡아라'));
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
      { id: 'tenders', kanji: '世', title: 'Tenders', titleKo: '정령', jp: '世話', key: null },
      { id: 'upgrades', kanji: '強', title: 'Upgrades', titleKo: '업그레이드', jp: '強化', key: null },
      { id: 'codex', kanji: '図', title: 'Codex', titleKo: '벚꽃 도감', jp: '桜図鑑', key: null },
      { id: 'star', kanji: '星', title: 'Constellation', titleKo: '별자리', jp: '星屑ノ樹', key: null },
      { id: 'set', kanji: '設', title: 'Settings', titleKo: '설정', jp: '設定', key: 'S' },
    ];
    const TAB_ORDER = TABS.map((t) => t.id);
    const tabEls = new Map();
    /**
     * A real ARIA tablist, vertical, with the roving-tabindex pattern: ONE tab
     * stop for the whole rail, and Up/Down (or Left/Right, forgivingly) move
     * between the five tabs, Home/End jump to the ends, Enter/Space open.
     *
     * Each tab is a `<button>`, so activation is the browser's job, not ours.
     * The kanji is the visible glyph but a useless accessible name, hence the
     * explicit aria-label on every one.
     */
    const tabStrip = h('div.sk-tabs', {
      role: 'tablist', 'aria-label': '숲 패널', 'aria-orientation': 'vertical',
    });
    function railKey(e) {
      let d = 0;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': d = 1; break;
        case 'ArrowUp': case 'ArrowLeft': d = -1; break;
        case 'Home': d = -99; break;
        case 'End': d = 99; break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      const els = TAB_ORDER.map((id) => tabEls.get(id));
      const i = els.indexOf(document.activeElement);
      const n = els.length;
      const j = d === -99 ? 0 : d === 99 ? n - 1 : ((i < 0 ? 0 : i) + d + n) % n;
      /* focus only — following focus with activation would fling the player
         through four panels on the way to the fifth */
      els[j].setAttribute('tabindex', '0');
      focusIt(els[j]);
      syncTabs();
    }
    for (const t of TABS) {
      const b = h('button.sk-tab', {
        type: 'button',
        role: 'tab',
        id: 'sk-tab-' + t.id,
        tabindex: '-1',
        'aria-selected': 'false',
        'aria-label': `${t.titleKo ?? t.title} ${t.jp}` + (t.key ? ` — 단축키 ${t.key}` : ''),
        title: `${t.titleKo ?? t.title} ${t.jp}` + (t.key ? `  (${t.key})` : ''),
        onclick: () => selectTab(t.id, true),
        onkeydown: railKey,
      }, h('span', { 'aria-hidden': 'true' }, t.kanji));
      tabEls.set(t.id, b);
      tabStrip.append(b);
    }
    const railHost = h('div', { style: { flex: '1 1 auto', display: 'flex', minWidth: '0', maxHeight: '100%', pointerEvents: 'auto' } });
    ui.append(h('div.sk-rail', railHost, tabStrip));

    let scrim = null;
    /** The control that opened the current modal. Focus goes back to it on close —
     *  landing on `<body>` after Esc means a keyboard player has to start their
     *  whole Tab journey again. */
    let modalOpener = null;

    /**
     * Tab must cycle INSIDE an open dialog and never fall through to the 3D
     * canvas behind it. This wraps at both ends rather than blocking Tab, so the
     * browser's own chrome (address bar, F6, Ctrl-Tab) stays reachable — a trap
     * that eats every Tab is its own accessibility failure.
     */
    function trapTab(e) {
      if (e.key !== 'Tab' || !scrim) return;
      const list = focusables(scrim);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0], last = list[list.length - 1];
      const a = document.activeElement;
      if (!scrim.contains(a)) { e.preventDefault(); focusIt(e.shiftKey ? last : first); return; }
      /* the dialog SHELL holds focus on open (tabindex="-1", so it is not in
         `list`). Forward Tab from there falls into `first` by itself, but
         Shift+Tab would walk backwards straight out of the dialog — measured. */
      const onShell = !list.includes(a);
      if (e.shiftKey && (a === first || onShell)) { e.preventDefault(); focusIt(last); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); focusIt(first); }
    }

    function openModal(node, tag, opts = {}) {
      /* remember the opener BEFORE closeModal() tears the old dialog down and
         moves focus; `rebuild` is a same-dialog refresh, which must keep it */
      const prev = document.activeElement;
      const keep = opts.rebuild ? modalOpener : null;
      closeModal({ restore: false });
      modalOpener = keep
        ?? (prev && prev !== document.body && ui.contains(prev) && prev.isConnected ? prev : null)
        ?? tabEls.get(tag)
        ?? null;

      scrim = h('div.sk-scrim', { onclick: (e) => { if (e.target === scrim) closeModal(); } }, node);
      scrim.__tab = tag;
      /* a modal dialog, declared as one: role + aria-modal so a screen reader
         stops reading the HUD behind it, labelled by the panel's own title */
      node.setAttribute('role', 'dialog');
      node.setAttribute('aria-modal', 'true');
      node.setAttribute('tabindex', '-1');
      const tid = opts.titleId ?? node.__titleId;
      if (tid) node.setAttribute('aria-labelledby', tid);
      scrim.addEventListener('keydown', trapTab);
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
      /* focus the dialog itself, not its first control: the title is then the
         first thing announced, and Tab from here walks the panel in DOM order */
      if (!ctx.shotMode) focusIt(node);
      return scrim;
    }

    /* Help modal — wired to "?" key and the help button. Build is delegated
       to src/modules/66-help.js so the giant 65-ui.js file stays read-only
       at the top. We pass the same h, panel, closeModal helpers the other
       modal builders (buildCodex, buildConstellation, buildSettings) use. */
    async function openHelp() {
      const { buildHelp } = await import('./66-help.js');
      const node = buildHelp({ h, panel, closeModal });
      openModal(node, 'help', { rebuild: true });
    }

    function closeModal({ restore = true } = {}) {
      if (!scrim) return;
      const back = modalOpener;
      const had = scrim.contains(document.activeElement);
      scrim.removeEventListener('keydown', trapTab);
      scrim.remove(); scrim = null; setCtl = null;
      if (restore) {
        modalOpener = null;
        /* only steal focus back if it was ours to begin with */
        if (had && back?.isConnected) focusIt(back);
        else if (had) focusIt(tabEls.get(activeTab) ?? tabEls.get('tenders'));
      }
      syncTabs();
    }

    /* ============================================================== *
     * 4.  Tender panel
     * ============================================================== */
    const TENDER_GLYPH = {
      sprite: '風', gatherer: '摘', miko: '巫', lantern: '灯', koi: '鯉',
      rabbit: '兎', kitsune: '狐', envoy: '神', heart: '心', bough: '天',
    };
    const tenderRows = new Map();
    const tenderPanel = panel({ title: '정령', kanji: '世 話', cls: 'sk-panel' });
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
        const mPre = h('span', '다음 ×2 시점: ');
        const btn = buyBtn(() => buyTender(d.id), `${d.nameKo ?? d.name} 돌봄`, '돌봄');
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

      bulkSeg = segmented([['×1', 1], ['×10', 10], ['×25', 25], ['최대', -1]],
        (v) => { A.setBulk(v); refresh(); }, { ariaLabel: '한 번에 구매할 수량' });
      tenderTotalEl = h('span.sk-hint.num', '');
      tenderPanel.root.append(h('div.sk-panel-foot', bulkSeg.root, tenderTotalEl));
    }
    function buyTender(id) { A.buy(id, A.bulk()); refresh(); }

    /* ============================================================== *
     * 5.  Upgrade panel (dynamic — the available set changes)
     * ============================================================== */
    const upgradePanel = panel({ title: '업그레이드', kanji: '強 化', cls: 'sk-panel' });
    const upgradeFootL = h('span.sk-hint', '일회성 구매 · 만료되지 않음');
    const upgradeFootR = h('span.sk-hint.num', '');
    upgradePanel.root.append(h('div.sk-panel-foot', upgradeFootL, upgradeFootR));
    let upgradeKey = '';
    const upgradeRows = [];

    const HEART_FAM = { id: 'heart', kanji: '心', name: 'Heartwood', nameKo: '나무심장', sub: '꽃송이로 구매 · 매 계절을 살아남음' };
    function famMeta(id) {
      if (id === 'heart') return HEART_FAM;
      return UPGRADE_FAMILIES.find((f) => f.id === id) ?? { id, kanji: '強', name: id, nameKo: id, sub: '' };
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
          h('div.cap', bought.length ? '더 배울 게 없습니다' : '아직 배울 게 없습니다'),
          h('h3', bought.length ? '強化 完 · 모든 학습 완료' : '強化 未 · 숲은 어리다'),
          h('div.fv', bought.length
            ? `${A.fmt(bought.length)}개가 모두 당신의 것입니다. 계절이 돌아올 때까지 유지되며, 다음 계절은 첫 계절 이후로 모은 모든 것을 가지고 시작합니다.`
            : '정령을 한둘 사면, 숲이 제안하기 시작합니다.'),
          bought.length
            ? h('div.act', canP
              ? goldBtn(`계절 전환  +${A.fmt(A.essencePreview())} 정수`, () => { A.prestige(); refresh(); })
              : goldBtn('별자리 열기', () => selectTab('star'), { cls: 'ghost' }))
            : null));
        if (bought.length) {
          upgradePanel.body.append(famHeader({ id: 'done', kanji: '済', name: 'Learned', nameKo: '학습 완료', sub: `${bought.length}개, 계절이 돌아올 때까지 유지됨` }));
          const grid = h('div.sk-learned');
          for (const u of bought.slice().reverse()) {
            grid.append(h('div.sk-lchip', { class: 'fam-' + (u.family ?? 'grove'), title: `${u.name ?? u.id}\n${u.flavour ?? ''}` },
              h('i', famMeta(u.family).kanji), h('span', u.name ?? u.id)));
          }
          upgradePanel.body.append(grid);
        }
      }
      upgradeFootR.textContent = `${bought.length} 학습 완료`;
    }
    function famHeader(fam) {
      return h('div.sk-fam', h('div.d'), h('h4', fam.nameKo ?? fam.name), h('div.ln'),
        h('span.sk-hint', { style: { fontStyle: 'italic' } }, fam.sub ?? ''));
    }
    function mkUpgradeRow({ id, family, name, flavour, cost, currency, buy }) {
      const btn = buyBtn(buy, `${currency === 'blossoms' ? '조각하다' : '배우다'} ${name}`,
        currency === 'blossoms' ? '조각' : '배움');
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
      const p = panel({ title: '벚꽃 도감', kanji: '桜 図 鑑', cls: 'sk-modal codexw', close: closeModal });
      p.root.__titleId = p.titleId;
      const list = A.codexViews();
      /* the reading pane is a live region: selecting a card by keyboard updates
         text well away from the focus, which a screen reader would otherwise miss */
      const detail = h('div.sk-detail', { role: 'status', 'aria-live': 'polite' },
        h('div.sk-title', { style: { fontSize: 'calc(var(--u)*1.0)' } }, '열두 개의 벚꽃'),
        h('div.sk-flavour', '열두 종류가 영원한 꽃에 응답합니다. 하나를 골라 읽어보세요.'));
      const grid = h('div.sk-codex', { role: 'list' });
      list.forEach((d, i) => {
        const r = d.rarity ?? 3;
        const found = !!(d.found ?? d.unlocked);
        const pick = () => {
          clear(detail).append(
            h('div.sk-title', { style: { fontSize: 'calc(var(--u)*1.05)' } }, found ? `${d.kanji}  ${d.nameKo ?? d.name}` : '？？？'),
            h('div.sk-flavour', found ? d.desc : '아직 발견되지 않았습니다. 숲은 스스로의 의견을 가집니다.'));
          card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip');
        };
        /* role=button + tabindex=0 rather than a real <button>: .sk-rc is an
           aspect-ratio card with absolutely-positioned art, and reparenting it
           into a button element loses that layout. The Enter/Space a button
           would have given us is reimplemented below, because a collection screen
           you can only read with a mouse is not a collection screen. */
        const card = h('div.sk-rc', {
          class: 'r' + r + (found ? '' : ' locked'),
          style: { animationDelay: (i * 35) + 'ms' },
          role: 'button',
          tabindex: '0',
          'aria-label': found
            ? `${d.nameKo ?? d.name} ${d.kanji} — ${r}성, 발견됨`
            : `종류 ${i + 1}/${list.length} — 미발견`,
          onclick: pick,
          onkeydown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            e.preventDefault(); e.stopPropagation(); pick();
          },
        },
          h('div.art', { style: found && d.tint ? { color: d.tint, textShadow: `0 2px 8px rgba(0,0,0,.45), 0 0 calc(var(--u)*1.6) ${d.tint}` } : null },
            found ? (d.kanji?.[0] ?? '桜') : '？', h('div.shine')),
          h('div.nameplate', stars(found ? r : 0, r),
            h('div.jp', found ? d.kanji : '？？？'),
            h('div.en', found ? (d.nameKo ?? d.name) : '미발견')));
        if (found) card.classList.add('flip');
        grid.append(card);
      });

      const achs = A.achievements();
      const got = achs.filter((a) => a.got).length;
      const achWrap = h('div.sk-achs', { role: 'list' });
      for (const a of achs) {
        /* "earned" is a gold seal visually; the word has to be in the name too */
        achWrap.append(h('div.sk-ach', {
          class: a.got ? 'got' : '', title: a.desc, role: 'listitem',
          'aria-label': `성취 ${a.got ? (a.nameKo ?? a.name) : (a.secret ? '비밀 성취' : (a.nameKo ?? a.name))} — `
            + (a.got ? '달성' : '미달성') + (a.desc ? '. ' + a.desc : ''),
        },
          h('i', { 'aria-hidden': 'true' }), h('span', a.got ? (a.nameKo ?? a.name) : (a.secret ? '???' : (a.nameKo ?? a.name)))));
      }

      /* Two views behind a segmented control. Stacked, the 48-row achievement
         grid sat below the modal's 82vh fold and read as unbuilt. */
      const nav = segmented([['桜 図鑑', 'varieties'], [`성취 ${got}/${achs.length}`, 'achievements']],
        (v) => openModal(buildCodex(v), 'codex', { rebuild: true }),
        { ariaLabel: '도감 보기' });
      nav.set(view);

      if (view === 'achievements' && achs.length) {
        mount(p.body, h('div.sk-mnav', nav.root),
          h('div.sk-flavour', { style: { textAlign: 'center', marginBottom: 'calc(var(--u)*.5)' } },
            '모두 하나씩, 영원히 모든 것에 +1%를 부여합니다.'),
          achWrap);
        p.root.append(h('div.sk-panel-foot',
          h('span.sk-hint', '각 성취는 모든 생산에 +1%를 더한다'),
          h('span.sk-hint.num', `${got} / ${achs.length} 획득`)));
        return p.root;
      }

      /* the reading pane sits outside the scroll: at 1280x800 the card grid fills
         the modal, and a description that updates below the fold is invisible */
      mount(p.body, achs.length ? h('div.sk-mnav', nav.root) : null, grid);
      p.root.append(h('div.sk-nodebar', detail));
      p.root.append(h('div.sk-panel-foot',
        h('span.sk-hint', '각 종류는 세상의 꽃잎을 물들인다'),
        h('span.sk-hint.num', `${list.filter((d) => d.found).length} / ${list.length} 발견`)));
      return p.root;
    }

    /* ============================================================== *
     * 7.  Constellation modal — radial star tree over a night sky
     * ============================================================== */
    function buildConstellation(preselect = null) {
      const p = panel({ title: '별자리', kanji: '星 屑 ノ 樹', cls: 'sk-modal wide', close: closeModal });
      p.root.__titleId = p.titleId;
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
      const gEdge = svg('g', { 'aria-hidden': 'true' });
      /* The star map is a single-tab-stop listbox with a roving tabindex: thirty
         separate tab stops would make Tab useless inside this dialog, and arrow
         keys are what a star map wants anyway. */
      const gNode = svg('g', { role: 'listbox', 'aria-label': '별자리', tabindex: null });
      s.setAttribute('role', 'group');
      s.setAttribute('aria-label', '별지도');
      s.append(gEdge, gNode);
      const starEls = [];

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
      const nodeHost = h('div', { role: 'status', 'aria-live': 'polite' });
      const detail = h('div.sk-detail', { style: { minHeight: '0' } },
        h('div.sk-flavour', '방향키로 별을 고르고 Enter. 여기서 쓴 정수도 +2% 보너스에 포함되니, 거리낌 없이 쓰세요.'));
      let selectedNode = null;
      const showNode = (n) => {
        if (!n) return;
        selectedNode = n;
        for (const e of starEls) {
          const on = e.__n === n;
          e.setAttribute('aria-selected', on ? 'true' : 'false');
          e.setAttribute('tabindex', on ? '0' : '-1');
        }
        const hue = hueOf(n);
        let action;
        if (n.owned) {
          action = h('div.sk-taken', '刻 획득');
        } else {
          const b = buyBtn(() => {
            if (!n.affordable) return;
            A.buyNode(n.id);
            openModal(buildConstellation(n.id), 'star', { rebuild: true });
            refresh();
          }, n.available ? `각성 ${n.nameKo ?? n.name}` : '별을 먼저 따르라', n.available ? '각성' : '봉인됨');
          b.set(A.fmt(n.cost), '桜精');
          b.setEnabled(!!n.affordable);
          action = b.root;
        }
        clear(nodeHost).append(h('div.sk-nodecard',
          h('div.em', { style: { color: hue, borderColor: hue } }, n.kanji ?? '星'),
          h('div.br', `${n.branchNameKo ?? n.branchName ?? ''} · ${ROMAN[Math.max(0, num(n.tier))] ?? ''}`),
          h('h3', n.nameKo ?? n.name ?? ''),
          h('div.fv', n.flavour ?? ''),
          action));
      };

      for (const n of nodes) {
        const [x, y] = pos(n);
        const rr = n.tier >= 4 ? 1.9 : n.tier >= 2 ? 1.5 : 1.2;
        const g = svg('g', {
          style: 'cursor:pointer',
          role: 'option',
          tabindex: '-1',
          'aria-selected': 'false',
          /* the state a sighted player reads from the halo, spoken instead */
          'aria-label': `${n.nameKo ?? n.name ?? n.id} ${n.kanji ?? ''} — ${n.branchNameKo ?? n.branchName ?? ''} 단계 `
            + `${ROMAN[Math.max(0, num(n.tier))] ?? '?'}, `
            + (n.owned ? '각성됨' : n.affordable ? `정수 ${A.fmt(n.cost)}로 구매 가능`
              : n.available ? `정수 ${A.fmt(n.cost)} 필요, 부족` : '봉인됨'),
        });
        g.__n = n;
        starEls.push(g);
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
        g.addEventListener('focus', () => showNode(n));
        /* arrow keys walk the star list, Home/End jump to the ends, Enter/Space
           awakens the selected star through the SAME guarded path the AWAKEN
           button uses, so a mis-keyed press can no more spend Essence than a
           mis-aimed click can */
        g.addEventListener('keydown', (e) => {
          let d = 0;
          switch (e.key) {
            case 'ArrowRight': case 'ArrowDown': d = 1; break;
            case 'ArrowLeft': case 'ArrowUp': d = -1; break;
            case 'Home': d = -99; break;
            case 'End': d = 99; break;
            case 'Enter': case ' ': case 'Spacebar': {
              e.preventDefault(); e.stopPropagation();
              const btn = nodeHost.querySelector('button.sk-buy:not(.off)');
              btn?.click();
              return;
            }
            default: return;
          }
          e.preventDefault(); e.stopPropagation();
          const i = starEls.indexOf(g);
          const m = starEls.length;
          const j = d === -99 ? 0 : d === 99 ? m - 1 : (i + d + m) % m;
          showNode(starEls[j].__n);
          focusIt(starEls[j]);
        });
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
        h('span.sk-hint.num', `${owned} / ${nodes.length} 노드 · ${A.fmt(A.essence())} 정수 보유`),
        canP
          ? goldBtn(`계절 전환  +${A.fmt(gain)}`, () => { A.prestige(); closeModal(); refresh(); })
          : h('span.sk-hint', `계절 전환은 ${A.fmt(1e6)} 꽃잎 획득 시 가능`)));
      return p.root;
    }

    /* ============================================================== *
     * 8.  Settings modal
     * ============================================================== */
    /**
     * Sound 音 + Motion 動.
     *
     * The motion half is an ACCESSIBILITY control, not a taste preference:
     * camera shake can genuinely make people unwell, so every switch here takes
     * effect on the next frame, persists in its own localStorage key (survives a
     * hard reset of the save), and cannot be reached into by the game state.
     * Nothing in here is gated behind a confirm or an "apply".
     */
    function buildSoundAndMotion() {
      const s = SETTINGS.all;
      const write = (k) => (v) => { SETTINGS.set(k, v); syncSettingsUi(); };

      const master = slider({
        label: '마스터', kanji: '全体', ariaLabel: '마스터 볼륨',
        value: s.masterVolume, onInput: write('masterVolume'),
      });
      const music = slider({
        label: '음악', kanji: '音楽', ariaLabel: '음악 볼륨',
        value: s.musicVolume, onInput: write('musicVolume'),
      });
      const sfx = slider({
        label: '효과음', kanji: '効果音', ariaLabel: '효과음 볼륨',
        value: s.sfxVolume, onInput: write('sfxVolume'),
      });
      const muteAll = toggleRow({
        label: '전체 무음', kanji: '消音',
        desc: '숲 전체를 위한 하나의 스위치',
        value: s.muteAll, onChange: write('muteAll'),
      });
      const muteMusic = toggleRow({
        label: '음악 음소거', kanji: '音楽切',
        desc: '고토와 그 아래 깔린 바람 소리',
        lockNote: '이미 무음 — 모든 것이 음소거됨',
        value: s.muteMusic, onChange: write('muteMusic'),
      });
      const muteSfx = toggleRow({
        label: '효과음 음소거', kanji: '効果音切',
        desc: '가지, 떨어지는 꽃잎, 작은 종소리',
        lockNote: '이미 무음 — 모든 것이 음소거됨',
        value: s.muteSfx, onChange: write('muteSfx'),
      });

      const HELD = '동작 감소로 보류됨';
      const reduced = toggleRow({
        label: '동작 감소', kanji: '動きを控える',
        desc: '설정에 관계없이 아래 세 항목을 끕니다',
        value: s.reducedMotion, onChange: write('reducedMotion'),
      });
      const shake = toggleRow({
        label: '화면 흔들림', kanji: '揺れ',
        desc: '가지를 흔들 때의 작은 카메라 킥',
        lockNote: HELD, value: s.screenShake, onChange: write('screenShake'),
      });
      const drift = toggleRow({
        label: '카메라 흐름', kanji: '漂い',
        desc: '가만히 서 있을 때 시야의 느린 호흡',
        lockNote: HELD, value: s.cameraDrift, onChange: write('cameraDrift'),
      });
      const flashes = toggleRow({
        label: '섬광', kanji: '閃光',
        desc: '치명타 흔들기나 새 단계의 밝은 빛',
        lockNote: HELD, value: s.flashes, onChange: write('flashes'),
      });

      /* Someone who set prefers-reduced-motion system-wide should be TOLD it was
         honoured. Leaving them to find the toggle and wonder whether the damage
         was already done is the failure this note exists to prevent. */
      let osReduce = false;
      try { osReduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { /* ignore */ }

      const root = h('div',
        h('div.sk-sgrid',
          h('div',
            groupHead('소리', '音'),
            master.root, music.root, sfx.root,
            muteAll.root, muteMusic.root, muteSfx.root),
          h('div',
            groupHead('동작', '動'),
            reduced.root, shake.root, drift.root, flashes.root,
            osReduce
              ? noteBox('시스템이 동작 감소를 요청합니다. 숲은 당신이 도착하기 전에 알아차리고 이것들을 꺼뒀습니다 — 원할 때 다시 켜세요.')
              : h('div.sk-flavour', { style: { marginTop: 'calc(var(--u)*.7)', lineHeight: '1.5' } },
                '이 중 어떤 것도 게임을 바꾸지 않습니다 — 다만 화면이 얼마나 움직이느냐만. 당신이 얻는 어떤 것도 여기에 의존하지 않습니다.')),
        ),
      );

      setCtl = {
        root, master, music, sfx, muteAll, muteMusic, muteSfx,
        reduced, shake, drift, flashes,
      };
      syncSettingsUi();
      return root;
    }

    function buildSettings() {
      const p = panel({ title: '설정', kanji: '設 定', cls: 'sk-modal wide', close: closeModal });
      p.root.__titleId = p.titleId;
      const io = h('textarea.sk-io', {
        spellcheck: 'false',
        placeholder: '세이브 데이터를 여기에 붙여넣거나 EXPORT를 눌러 자신의 데이터를 채우세요',
        'aria-label': '세이브 데이터, base64. EXPORT를 눌러 이 칸을 채우거나, 세이브를 붙여넣고 IMPORT를 누르세요.',
      });
      const confirmIn = h('input.sk-in', {
        type: 'text', placeholder: 'ERASE 입력',
        'aria-label': 'ERASE라는 단어를 입력하여 완전 초기화를 준비합니다',
      });
      /* every EXPORT / IMPORT / ERASE outcome is a one-line message a long way
         from the button that caused it — live, or it may as well not be there */
      const status = h('div.sk-hint', {
        style: { textAlign: 'right', minHeight: '1.3em' },
        role: 'status', 'aria-live': 'polite',
      }, '');
      const say = (m) => { status.textContent = m; };
      const st = A.state();
      mount(p.body,
        /* Sound and Motion sit FIRST. Everything under them is save plumbing
           and statistics; the accessibility controls are what someone opens
           this panel in a hurry to find. */
        buildSoundAndMotion(),
        groupHead('숲 기록', '記録'),
        h('div.sk-row', h('div', h('div.lbl', '세이브 내보내기'), h('div.sub', 'base64 · 안전한 곳에 복사')),
          goldBtn('내보내기', () => { io.value = A.exportSave(); io.select?.(); say('아래 칸에 작성됨'); })),
        h('div.sk-row', h('div', h('div.lbl', '세이브 가져오기'), h('div.sub', '지금 가진 모든 것을 덮어씁니다')),
          goldBtn('가져오기', () => say(A.importSave(io.value.trim()) ? '세이브 복원됨' : '그 문자열은 거부되었습니다'), { cls: 'ghost' })),
        io,
        h('div.sk-row', { style: { marginTop: 'calc(var(--u)*.7)' } },
          h('div', h('div.lbl', '완전 초기화'), h('div.sub', '활성화하려면 ERASE 입력 · 모든 것이 사라짐, 꽃송이 포함')),
          h('div', { style: { display: 'flex', gap: 'calc(var(--u)*.4)', alignItems: 'center' } }, confirmIn,
            goldBtn('삭제', () => {
              if (confirmIn.value.trim().toUpperCase() !== 'ERASE') { say('먼저 ERASE를 입력하세요'); return; }
              A.hardReset(); say('숲이 겨울로 돌아왔습니다'); closeModal(); refresh();
            }, { cls: 'danger' }))),
        status,
        h('div.sk-rule', { style: { margin: 'calc(var(--u)*.6) 0' } }),
        h('div.sk-row', h('div.lbl', '돌린 계절 수'), h('b.num', A.fmt(num(st.season)))),
        h('div.sk-row', h('div.lbl', '흔든 횟수'), h('b.num', A.fmt(num(st.stats?.clicks)))),
        h('div.sk-row', h('div.lbl', '치명타 흔들기'), h('b.num', A.fmt(num(st.stats?.crits)))),
        h('div.sk-row', h('div.lbl', '꽃잎, 전 생애'), h('b.num', A.fmt(num(st.totalAllTime)))),
        h('div.sk-row', h('div.lbl', '숲에서의 시간'), h('b.num', A.time(num(st.stats?.playTime)))),
        h('div.sk-flavour', { style: { marginTop: 'calc(var(--u)*.9)', textAlign: 'center' } },
          '10초마다 그리고 다른 곳을 볼 때마다 자동 저장.'),
        /* The shortcut list lives HERE because this is the panel a keyboard
           player opens first, and a shortcut nobody wrote down is a shortcut
           nobody has. Kept last so it never pushes the audio controls down. */
        groupHead('단축키', '鍵'),
        h('div.sk-keys', KEY_HELP.map(([k, what]) =>
          h('span', h('kbd', k), what))),
      );
      return p.root;
    }

    /* ============================================================== *
     * 9.  Tabs
     * ============================================================== */
    let activeTab = 'tenders';
    const MODAL_TABS = new Set(['codex', 'star', 'set']);
    /** `toggle` is true only for a real click on the tab button, so a
     *  programmatic selectTab() never collapses the panel it was asked to open. */
    function selectTab(id, toggle = false) {
      if (MODAL_TABS.has(id)) {
        if (toggle && scrim && scrim.__tab === id) { closeModal(); return; }
        openModal(id === 'codex' ? buildCodex() : id === 'star' ? buildConstellation() : buildSettings(), id);
        return;
      }
      const hadModal = !!scrim;
      closeModal();
      /* if focus is standing in the panel we are about to tear out, it would land
         on <body> and a keyboard player would have to Tab in from the top again */
      const rescue = railHost.contains(document.activeElement);
      activeTab = (toggle && !hadModal && activeTab === id && railHost.firstChild) ? null : id;
      clear(railHost);
      if (activeTab === 'tenders') railHost.append(tenderPanel.root);
      else if (activeTab === 'upgrades') { buildUpgrades(); railHost.append(upgradePanel.root); }
      syncTabs();
      if (rescue) focusIt(tabEls.get(id));
      refresh();
    }
    function syncTabs() {
      const open = scrim && scrim.__tab;
      const current = open || activeTab;
      /* roving tabindex: exactly ONE tab stop for the rail, and it is whichever
         tab is showing. With no panel open at all the first tab holds the stop,
         so the rail is never unreachable. */
      const focusHolder = tabEls.has(current) ? current : TAB_ORDER[0];
      const railHas = tabStrip.contains(document.activeElement);
      for (const [id, el] of tabEls) {
        const on = id === current;
        setClass(el, 'on', on);
        const a = on ? 'true' : 'false';
        if (el.__as !== a) { el.__as = a; el.setAttribute('aria-selected', a); }
        /* never move the tab stop out from under a tab the player is standing on */
        const t = (railHas ? el === document.activeElement : id === focusHolder) ? '0' : '-1';
        if (el.getAttribute('tabindex') !== t) el.setAttribute('tabindex', t);
      }
    }
    /* the two rail tabs drive a real tabpanel; the other three open dialogs */
    tenderPanel.root.setAttribute('role', 'tabpanel');
    tenderPanel.root.setAttribute('aria-labelledby', 'sk-tab-tenders');
    tenderPanel.root.id = uid('sk-panel');
    upgradePanel.root.setAttribute('role', 'tabpanel');
    upgradePanel.root.setAttribute('aria-labelledby', 'sk-tab-upgrades');
    upgradePanel.root.id = uid('sk-panel');
    tabEls.get('tenders').setAttribute('aria-controls', tenderPanel.root.id);
    tabEls.get('upgrades').setAttribute('aria-controls', upgradePanel.root.id);
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
      achievement: '성취', codex: '새 종류', upgrade: '업그레이드',
      node: '별자리', heartwood: '나무심장', event: '실시간 이벤트',
      boon: '황금 꽃잎', milestone: '이정표',
    };
    function pumpToasts(dt) {
      toastTimer -= dt;
      if (toastTimer > 0 || !toastQ.length) return;
      const t = toastQ.shift();
      const el = h('div.sk-toast.sk-paper', { class: 'r' + (t.rarity ?? 4) }, corners(true),
        h('div.glyph'),
        h('div', { style: { minWidth: '0' } },
          h('div.cap', KIND_CAP[t.kind] ?? '해제됨'),
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
          h('div.eyebrow', '개화 단계 ' + ROMAN[i]),
          h('div.kj', info?.kanji ?? s.kanji),
          h('div.en', String(info?.name ?? s.name).toUpperCase()),
          h('div.blurb', info?.blurb ?? s.blurb ?? ''),
          h('div.reward', `+${A.fmt(num(info?.blossoms ?? i * 3))} 꽃송이 桜花`)));
      ui.append(stageCard);
      stageCardT = 4.6;
    }

    let welcomeShown = false;
    function welcomeBack(r) {
      if (!r) return;
      const away = num(r.awayS ?? r.seconds);
      const gained = num(r.gained ?? r.petals);
      const p = panel({ title: '다시 오신 걸 환영합니다', kanji: 'お か え り', cls: 'sk-modal sk-wb', close: dismiss });
      p.root.__titleId = p.titleId;
      function dismiss() { A.clearOffline(); closeModal(); }
      const stages = A.stages();
      mount(p.body,
        h('div.band'),
        h('div.lead', '당신이 없는 동안에도 숲은 계속 일했습니다.'),
        h('div.big.num', '+' + A.fmt(gained)),
        h('div.cap', '꽃잎 모음'),
        h('div.stat', h('span', '부재 시간'), h('b.num', A.time(away))),
        h('div.stat', h('span', '실측된 시간'), h('b.num', A.time(num(r.cappedS ?? away)))),
        h('div.stat', h('span', '유휴 비율'), h('b.num', Math.round(num(r.rate ?? 0.55) * 100) + '% 실시간')),
        h('div.stat', h('span', '이슬 저장고'), h('b.num', r.capped ? `가득 — ${A.fmt(num(r.capH ?? 3))} 시간` : `${A.fmt(num(r.capH ?? 3))} 시간`)),
        Array.isArray(r.stages) && r.stages.length
          ? h('div.stat', h('span', '개화 진행'),
            h('b', `${stages[r.stages[r.stages.length - 1]]?.kanji ?? ''} ${stages[r.stages[r.stages.length - 1]]?.nameKo ?? stages[r.stages[r.stages.length - 1]]?.name ?? ''}`))
          : null,
        h('div.note', '"꽃잎은 누구도 기다리지 않으며, 그것을 원망하지도 않는다."'),
      );
      p.root.append(h('div.sk-panel-foot', { style: { justifyContent: 'center' } }, goldBtn('모아두기', dismiss)));
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
      if (!nxt) { setText(elStageB, '常桜 · 영원히'); return; }
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
          setText(r.mPre, '다음 ×2 시점: ');
          setText(r.mLbl, String(nextM));
        } else {
          r.mBar.set(1);
          setText(r.mPre, '모든 이정표 · ');
          setText(r.mLbl, '×' + (num(v.milestoneMult) || 64));
        }
        live += num(v.total);
      }
      bulkSeg?.set(bulk);
      if (tenderTotalEl) setText(tenderTotalEl, shown ? `${A.rate(live)} /s 기본 · ${shown} 종류` : '');

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
          h('div.sk-event-t', h('em', { class: 'sk-kanji' }, m.kanji), String(m.nameKo ?? m.name).toUpperCase()),
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

      /* The audio graph only exists after the browser's first-gesture unlock, so
         the stem gains set before that landed on nothing. Re-apply the moment it
         comes up — one boolean compare a frame, and it means a player who muted
         during the title beat stays muted once sound is actually possible. */
      if (!ctx.shotMode) {
        const un = !!AUDIO()?.unlocked;
        if (un !== audioUnlocked) { audioUnlocked = un; if (un) applyAudioSettings(); }
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
      /* audio boots at order 70 — after us — so the saved mix is pushed once
         every module is up rather than at our own setup, when it would be lost */
      ctx.bus.on('game:ready', () => { applyAudioSettings(); syncSettingsUi(); }),
      offResize,
      offSettings,
    ];

    /* ============================================================== *
     * 13.  Keyboard
     *
     * 60-game owns Space and 1–0. We own Esc, S / , (settings) and [ ] (panels).
     *
     * TAB IS NOT BOUND. It used to be — `e.key === 'Tab'` with preventDefault()
     * on a window listener, cycling the panels. That single line meant the
     * browser's focus navigation never ran, so not one control in this UI could
     * be reached without a mouse: the sliders, the mute switches, the reduced-
     * motion toggles — the entire accessibility panel, unreachable by the players
     * it was built for. Panel cycling now lives on [ and ], which nothing else
     * uses. Never bind Tab, Shift+Tab or the arrow keys at window level; arrow
     * keys belong to whichever widget has focus (tab rail, slider, star map).
     * ============================================================== */

    /**
     * Gate. Space and the digits are gameplay keys on `window`, but while a
     * control has focus they belong to that control — Space on a focused toggle
     * must flip it, not shake the tree (and 60-game calls preventDefault() on
     * Space, which would have cancelled the button activation outright).
     *
     * Stopping propagation HERE, on our own container, is what makes that work:
     * the default action still runs on the target, and neither window listener
     * (60-game's or ours) ever sees the event. Escape is deliberately not gated —
     * it has to reach the window handler to close the panel.
     */
    const CTL_SEL = 'button,input,textarea,select,[role="slider"],[role="switch"],'
      + '[role="tab"],[role="option"],[role="dialog"],[tabindex]';
    /* ONLY the keys that would otherwise fight the focused control for the same
       press. S, ',', '[' and ']' are deliberately NOT here: they are panel
       navigation and must keep working wherever focus happens to be standing,
       which after any amount of tabbing is always some button. Gating them once
       cost us the settings shortcut entirely — measured, not guessed. Text fields
       are protected by the tagName check in onKey instead. */
    const GATED = new Set(['Space', 'Enter', 'NumpadEnter',
      'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
      'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']);
    const onUiKey = (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!GATED.has(e.code)) return;
      if (t.closest(CTL_SEL)) e.stopPropagation();
    };
    ui.addEventListener('keydown', onUiKey);

    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'Escape') {
        /* Esc closes and hands focus BACK to whatever opened the thing */
        if (scrim) closeModal();
        else if (activeTab) selectTab(activeTab, true);
        return;
      }

      /* modified keys belong to the browser and the OS — Cmd+S must still be
         Save Page, Alt+S must still reach a screen reader */
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      /* Settings, direct. S because it is mnemonic and unclaimed (60-game holds
         only Space and the digits), and ',' as the platform convention. Both are
         written down in the panel's own Keys row, so they are discoverable. */
      if (e.key === 's' || e.key === 'S' || e.key === ',') {
        e.preventDefault();
        selectTab('set', true);
        return;
      }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const cur = (scrim && scrim.__tab) || activeTab || TAB_ORDER[TAB_ORDER.length - 1];
        const i = TAB_ORDER.indexOf(cur);
        selectTab(TAB_ORDER[(i + (e.key === ']' ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length]);
        return;
      }

      /* Help modal — "?" key opens the in-game guide. ESC closes. */
      if (e.key === '?' || e.key === '/') {
        e.preventDefault();
        openHelp();
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
      /* Both of these WRITE to SETTINGS, which persists — debug-only, and named
         so nobody wires them into anything a player can reach. */
      S['ui-settings-reduced'] = () => {
        base('rich');
        SETTINGS.set('reducedMotion', true);
        selectTab('set');
      };
      S['ui-settings-muted'] = () => {
        base('rich');
        SETTINGS.patch({ muteAll: false, muteMusic: true, muteSfx: false, masterVolume: 0.8 });
        selectTab('set');
      };
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
        toast({ kind: 'achievement', title: '가지와 하나됨', body: '나무를 백만 번 흔든다.', rarity: 4 });
        toast({ kind: 'codex', title: '교이고', body: '초록 벚꽃. 본 것에 대해 스스로 논쟁하게 될 것이다.', rarity: 5 });
        toast({ kind: 'upgrade', title: '바람쪽 사당', body: '폭풍이 머문다. 사당이 그것이 머무를 이유를 준다.', rarity: 3 });
        for (let i = 0; i < 3; i++) pumpToasts(1);
      };
    }

    window.__ui = {
      toast, stageUp, welcomeBack, selectTab, closeModal, refresh, adapter: A,
      /** Exposed for probes and the audio agent: settings are read-only from
       *  here, SETTINGS itself is the place to write them. */
      settings: SETTINGS,
      applyAudioSettings,
    };

    applyAudioSettings();
    syncSettingsUi();
    update(0);
    update(0.4);

    return {
      update,
      resize() { /* pure CSS layout */ },
      dispose() {
        for (const off of offs) { try { off(); } catch { /* ignore */ } }
        window.removeEventListener('keydown', onKey);
        ui.removeEventListener('keydown', onUiKey);
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
