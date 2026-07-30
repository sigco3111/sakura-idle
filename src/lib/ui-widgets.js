/**
 * ui-widgets.js — DOM primitives, number formatting and the canonical content
 * tables the HUD needs. Owner: UI agent.
 *
 * The game module (60-game.js) owns all state. Everything here is either a pure
 * view helper or a *fallback* definition table transcribed from GAME_DESIGN.md,
 * used only when the game module has not published its own defs yet.
 */

import { mulberry32 } from './rng.js';

/* ------------------------------------------------------------------ *
 * Tiny hyperscript
 * ------------------------------------------------------------------ */
export function h(tag, props, ...kids) {
  const parts = String(tag).split(/(?=[.#])/);
  const el = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p[0] === '.') el.classList.add(p.slice(1));
    else el.id = p.slice(1);
  }
  if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) {
    kids.unshift(props); props = null;
  }
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'data' && typeof v === 'object') for (const d in v) el.dataset[d] = v[d];
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
/** Append children the same way h() does — nulls/false/arrays are skipped.
 *  Element.append(null) would insert the literal text "null". */
export const mount = (el, ...kids) => { add(el, kids); return el; };
/** Write text only when it actually changed — keeps per-frame DOM work near zero. */
export const setText = (el, s) => { if (el && el.__t !== s) { el.__t = s; el.textContent = s; } };
export const setClass = (el, cls, on) => { if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); };
export const setW = (el, pct) => { const s = pct.toFixed(2) + '%'; if (el && el.__w !== s) { el.__w = s; el.style.width = s; } };

/* ------------------------------------------------------------------ *
 * Number formatting — GAME_DESIGN.md "Number formatting"
 * ------------------------------------------------------------------ */
const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd'];

/** 4 significant figures, grouped below 10 000, suffixed above, exponent past Dd. */
export function formatNumber(n) {
  if (n == null || !isFinite(n)) return n === Infinity ? '∞' : '0';
  const neg = n < 0; n = Math.abs(n);
  let out;
  if (n < 1000) {
    out = n < 10 && n % 1 !== 0 ? trim(n.toFixed(2)) : String(Math.floor(n));
  } else if (n < 1e4) {
    out = Math.floor(n).toLocaleString('en-US');
  } else {
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier >= SUFFIX.length) {
      const e = Math.floor(Math.log10(n));
      out = trim((n / 10 ** e).toFixed(2)) + 'e' + e;
    } else {
      const m = n / 10 ** (tier * 3);
      const dp = m < 10 ? 3 : m < 100 ? 2 : 1;
      out = trim(m.toFixed(dp)) + SUFFIX[tier];
    }
  }
  return neg ? '-' + out : out;
}
const trim = (s) => (s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, ''));

/** Rates: 2 decimals below 100, otherwise the normal ladder. */
export function formatRate(n) {
  if (n == null || !isFinite(n)) return '0.00';
  return Math.abs(n) < 100 ? n.toFixed(2) : formatNumber(n);
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor(sec / 3600) % 24;
  const mm = Math.floor(sec / 60) % 60, ss = sec % 60;
  if (d) return `${d}d ${hh}h ${mm}m`;
  if (hh) return `${hh}h ${mm}m`;
  if (mm) return `${mm}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

/* ------------------------------------------------------------------ *
 * Canonical content tables (fallbacks — GAME_DESIGN.md is the spec)
 * ------------------------------------------------------------------ */
export const TENDER_DEFS = [
  { id: 'sprite',   name: 'Wind Sprite',      kanji: '風精',   glyph: '風', baseCost: 15,     rate: 0.1 },
  { id: 'gatherer', name: 'Petal Gatherer',   kanji: '花摘み', glyph: '摘', baseCost: 100,    rate: 1 },
  { id: 'miko',     name: 'Shrine Maiden',    kanji: '巫女',   glyph: '巫', baseCost: 1.1e3,  rate: 8 },
  { id: 'lantern',  name: 'Stone Lantern',    kanji: '石灯籠', glyph: '灯', baseCost: 1.2e4,  rate: 47 },
  { id: 'koi',      name: 'Koi Spirit',       kanji: '鯉霊',   glyph: '鯉', baseCost: 1.3e5,  rate: 260 },
  { id: 'rabbit',   name: 'Moon Rabbit',      kanji: '月兎',   glyph: '兎', baseCost: 1.4e6,  rate: 1.4e3 },
  { id: 'kitsune',  name: 'Kitsune Herald',   kanji: '狐使',   glyph: '狐', baseCost: 2.0e7,  rate: 7.8e3 },
  { id: 'envoy',    name: "Wind God's Envoy", kanji: '風神使', glyph: '神', baseCost: 3.3e8,  rate: 4.4e4 },
  { id: 'heart',    name: 'Everblossom Heart',kanji: '常桜心', glyph: '心', baseCost: 5.1e9,  rate: 2.6e5 },
  { id: 'bough',    name: 'Celestial Bough',  kanji: '天樹枝', glyph: '天', baseCost: 7.5e10, rate: 1.6e6 },
];

export const MILESTONES = [10, 25, 50, 100, 150, 200];

export const STAGE_DEFS = [
  { i: 0, kanji: '冬芽', name: 'Winter Bud',  threshold: 0 },
  { i: 1, kanji: '蕾',   name: 'Budding',     threshold: 1e3 },
  { i: 2, kanji: '初咲', name: 'First Bloom', threshold: 1e5 },
  { i: 3, kanji: '満開', name: 'Full Bloom',  threshold: 1e7 },
  { i: 4, kanji: '輝咲', name: 'Radiant',     threshold: 1e10 },
  { i: 5, kanji: '常桜', name: 'Everblossom', threshold: 1e13 },
];

export const EVENT_DEFS = {
  storm:  { kanji: '花嵐',   name: 'Petal Storm', desc: '×10 passive · the grove roars' },
  moon:   { kanji: '満月',   name: 'Full Moon',   desc: '+25% crit chance · moonlit palette' },
  golden: { kanji: '黄金時', name: 'Golden Hour', desc: '+15% click value' },
  rain:   { kanji: '春雨',   name: 'Spring Rain', desc: '+10% passive · petals fall slow' },
};

export const CODEX_DEFS = [
  { id: 'somei',    kanji: '染井吉野', name: 'Somei Yoshino',  rarity: 3, glyph: '染', desc: 'The nation\'s clock. Every one of them a clone of a single tree, blooming as one mind.' },
  { id: 'shidare',  kanji: '枝垂桜',   name: 'Shidarezakura',  rarity: 4, glyph: '垂', desc: 'Branches that bow like a woman letting down her hair. Grief made graceful.' },
  { id: 'yae',      kanji: '八重桜',   name: 'Yaezakura',      rarity: 4, glyph: '八', desc: 'Thirty petals to a flower. Extravagant, late, unbothered by the ones who left early.' },
  { id: 'kawazu',   kanji: '河津桜',   name: 'Kawazu-zakura',  rarity: 3, glyph: '河', desc: 'February\'s liar. Deep rose against a winter sky, a month before anyone is ready.' },
  { id: 'yama',     kanji: '山桜',     name: 'Yamazakura',     rarity: 3, glyph: '山', desc: 'Leaf and flower together — the old poets\' sakura, before we bred the leaves away.' },
  { id: 'oshima',   kanji: '大島桜',   name: 'Oshima-zakura',  rarity: 3, glyph: '島', desc: 'Salt-tolerant, fragrant. Its leaves wrap the mochi; nothing of it is wasted.' },
  { id: 'ukon',     kanji: '鬱金桜',   name: 'Ukon',           rarity: 4, glyph: '鬱', desc: 'Turmeric-yellow blossom. Colour of a robe no commoner was allowed to wear.' },
  { id: 'gyoiko',   kanji: '御衣黄',   name: 'Gyoiko',         rarity: 5, glyph: '衣', desc: 'Green sakura. Stand beneath it and you will argue with yourself about what you saw.' },
  { id: 'jugatsu',  kanji: '十月桜',   name: 'Jugatsu-zakura', rarity: 4, glyph: '十', desc: 'Blooms twice — autumn, then spring. It never quite believes the year is over.' },
  { id: 'fuyu',     kanji: '冬桜',     name: 'Fuyuzakura',     rarity: 4, glyph: '冬', desc: 'Small, sparse, and flowering in snow. Proof that stubbornness can be beautiful.' },
  { id: 'yoko',     kanji: '陽光桜',   name: 'Yoko',           rarity: 5, glyph: '陽', desc: 'Bred by a schoolmaster to mourn his students. Planted, now, on every continent.' },
  { id: 'ever',     kanji: '常桜',     name: 'Everblossom',    rarity: 5, glyph: '常', desc: 'The tree that refused the calendar. Petals fall and are replaced in the same breath.' },
];

/** Upgrade families — id, kanji glyph, and the accent class used for the sigil. */
export const UPGRADE_FAMILIES = [
  { id: 'shake',  kanji: '揺', name: 'Shake',  sub: 'the hand upon the branch' },
  { id: 'tender', kanji: '育', name: 'Tender', sub: 'those who keep the grove' },
  { id: 'grove',  kanji: '苑', name: 'Grove',  sub: 'the shape of the place itself' },
];

/** Fallback upgrade list — the real catalogue lives in 60-game.js. */
export const UPGRADE_DEFS = [
  { id: 's1', family: 'shake', name: 'Steady Hand',      cost: 100,   flavour: 'You stop grabbing at the branch and simply ask it.' },
  { id: 's2', family: 'shake', name: 'Wrist of the Wind', cost: 1.2e3, flavour: 'The gust does the work; you only suggest the timing.' },
  { id: 's3', family: 'shake', name: 'Falling Star Strike', cost: 1.4e4, flavour: 'Rarely, the tree gives back more than it was asked for.' },
  { id: 's4', family: 'shake', name: 'Ninefold Petalfall', cost: 2.6e5, flavour: 'One shake, nine breaths of falling. Nobody counts the ninth.' },
  { id: 't1', family: 'tender', name: 'Sprite Whistle',   cost: 480,   flavour: 'Two notes. They pretend not to have heard the first.' },
  { id: 't2', family: 'tender', name: 'Woven Baskets',    cost: 3.6e3, flavour: 'Bamboo, split thin. A gatherer with a good basket is worth two without.' },
  { id: 't3', family: 'tender', name: 'Morning Prayer',   cost: 4.4e4, flavour: 'The maidens sing before the sun. The tree seems to prefer it.' },
  { id: 't4', family: 'tender', name: 'All Hands to the Bough', cost: 6.5e5, flavour: 'Every tender ×1.5. Nobody is permitted to be a bystander.' },
  { id: 'g1', family: 'grove', name: 'Dew Reservoir',     cost: 2.2e3, flavour: 'A stone basin that holds the night for you while you are away.' },
  { id: 'g2', family: 'grove', name: 'Gilded Fortune',    cost: 2.8e4, flavour: 'Golden petals drift more often. Luck, it turns out, is landscaping.' },
  { id: 'g3', family: 'grove', name: 'Petal Magnet',      cost: 1.8e5, flavour: 'Fallen petals lean toward you, the way cats do when it suits them.' },
  { id: 'g4', family: 'grove', name: 'Windward Shrine',   cost: 3.1e6, flavour: 'Storms linger. The shrine gives them a reason to stay.' },
];

/** Constellation — 5 branches × ~6 nodes, laid out radially. */
export const CONSTEL_BRANCHES = [
  { id: 'wind',    kanji: '風', name: 'Wind',    hue: '#9FD4E8' },
  { id: 'water',   kanji: '水', name: 'Water',   hue: '#8FA8E8' },
  { id: 'moon',    kanji: '月', name: 'Moon',    hue: '#D8CBF0' },
  { id: 'stone',   kanji: '石', name: 'Stone',   hue: '#D8C29A' },
  { id: 'blossom', kanji: '桜', name: 'Blossom', hue: '#F2A8C6' },
];

/** Deterministic radial node layout: [{id,branch,x,y,ring,cost}] + edges. */
export function constellationLayout() {
  const rng = mulberry32(0x5c0f1a);
  const nodes = [];
  const edges = [];
  const cx = 50, cy = 50;
  nodes.push({ id: 'core', branch: 'core', x: cx, y: cy, ring: 0, cost: 0, kanji: '桜' });
  CONSTEL_BRANCHES.forEach((b, bi) => {
    const base = (bi / CONSTEL_BRANCHES.length) * Math.PI * 2 - Math.PI / 2;
    let prev = 'core';
    const n = 6;
    let a = base;
    for (let r = 1; r <= n; r++) {
      // small cumulative drift only — branches must never cross each other
      a += (rng() - 0.5) * 0.16;
      const rad = 6.5 + r * 6.4;
      const id = `${b.id}${r}`;
      nodes.push({
        id, branch: b.id, kanji: b.kanji, ring: r,
        x: cx + Math.cos(a) * rad * 1.34,
        y: cy + Math.sin(a) * rad,
        cost: [1, 2, 5, 12, 34, 120][r - 1],
      });
      edges.push([prev, id]);
      prev = id;
      if (r === 4) {                       // a side bud so branches are not pure chains
        const sid = `${b.id}b`;
        const sa = a + (bi % 2 ? -0.34 : 0.34);
        nodes.push({
          id: sid, branch: b.id, kanji: b.kanji, ring: r, cost: 18,
          x: cx + Math.cos(sa) * (rad + 3.4) * 1.34,
          y: cy + Math.sin(sa) * (rad + 3.4),
        });
        edges.push([id, sid]);
      }
    }
  });
  return { nodes, edges };
}

/** Background starfield for the constellation sky — deterministic. */
export function starfieldSvg(w = 100, h = 74, count = 150, seed = 0x2b17) {
  const rng = mulberry32(seed);
  let s = '';
  for (let i = 0; i < count; i++) {
    const x = rng() * w, y = rng() * h;
    const r = 0.12 + rng() * rng() * 0.42;
    const o = 0.18 + rng() * 0.72;
    s += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="#EAF0FF" opacity="${o.toFixed(2)}"/>`;
  }
  for (let i = 0; i < 5; i++) {           // a few soft nebula blooms
    const x = rng() * w, y = rng() * h, r = 8 + rng() * 16;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#neb)" opacity=".26"/>`;
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Smoothly ticking number — lerp toward the true value over ~180 ms
 * ------------------------------------------------------------------ */
export function makeTicker(el, fmt = formatNumber, tau = 0.18) {
  let shown = 0, target = 0, first = true;
  return {
    set(v) {
      if (!isFinite(v)) v = 0;
      target = v;
      if (first) { shown = v; first = false; setText(el, fmt(shown)); }
    },
    /** dt seconds. Exponential approach — frame-rate independent. */
    update(dt) {
      if (shown === target) return;
      const k = 1 - Math.exp(-dt / tau);
      shown += (target - shown) * k;
      // snap once we are inside display resolution so the text stops churning
      if (Math.abs(target - shown) < Math.max(1e-6, Math.abs(target) * 2e-4)) shown = target;
      setText(el, fmt(shown));
    },
    get value() { return shown; },
    snap() { shown = target; setText(el, fmt(shown)); },
  };
}

/* ------------------------------------------------------------------ *
 * Composite widgets
 * ------------------------------------------------------------------ */
export function corners(small = false) {
  const c = (p) => h('div.sk-c' + (small ? '.sm' : ''), { class: p });
  return [c('tl'), c('tr'), c('bl'), c('br')];
}

/** Parchment panel with filigree corners, title block and tapered rule. */
export function panel({ title, kanji, cls = '', foot = null, close = null }) {
  const body = h('div.sk-panel-body');
  const head = h('div.sk-panel-head',
    h('h2.sk-title', title),
    kanji ? h('div.kj', kanji) : null,
    h('div.fl'),
  );
  const root = h('div.sk-paper' + (cls ? '.' + cls.split(' ').join('.') : ''),
    corners(),
    close ? h('button.sk-x', { onclick: close, 'aria-label': 'close' }, '✕') : null,
    head,
    h('div.sk-rule'),
    body,
    foot,
  );
  return { root, body, head };
}

export function bar(cls = 'sk-bar', sheen = true) {
  const fill = h('i');
  const root = h('div', { class: cls }, fill, sheen ? h('u') : null);
  return { root, fill, set: (f) => setW(fill, Math.max(0, Math.min(1, f)) * 100) };
}

export function stars(n, of = 5, ink = false) {
  const row = h('div.sk-stars' + (ink ? '.ink' : ''));
  for (let i = 0; i < of; i++) row.append(h('i', { class: i < n ? '' : 'off' }));
  return row;
}

export function goldBtn(label, onclick, opts = {}) {
  return h('button.sk-btn' + (opts.cls ? '.' + opts.cls : ''), { onclick, title: opts.title }, label);
}

/* ------------------------------------------------------------------ *
 * Rarity — GAME_DESIGN's ten Tenders map onto Genshin's 3/4/5★ bands.
 * ------------------------------------------------------------------ */
export const TENDER_RARITY = [3, 3, 3, 3, 4, 4, 4, 5, 5, 5];
export const rarityOf = (i) => TENDER_RARITY[i] ?? (i >= 7 ? 5 : i >= 4 ? 4 : 3);

/**
 * Tapered hairline that breaks a long card list into bands. Ten identical rows
 * read as a spreadsheet; the rule + the extra gap it carries give the panel
 * rhythm. Placed at the rarity transitions so the grouping means something.
 */
export function groupRule() { return h('div.sk-gdiv'); }

/**
 * The next-unlock row, as a SEALED SCROLL — dimmed parchment, a gold wax-seal
 * medallion, and the requirement in the game's voice. The previous grey
 * diagonal-hatched version read as a disabled HTML fieldset (ART_BIBLE §8.10).
 * Returns the row plus the `need` span the caller keeps up to date.
 */
export function sealedRow() {
  const need = h('b.num', '40');
  const root = h('div.sk-teaser',
    h('div.seal'),
    h('h3', '封 sealed'),
    h('div.tx', 'Hold ', need, ' petals at once and another pair of hands steps out of the grove.'),
  );
  return { root, need };
}

/**
 * The purchase button (ART_BIBLE §7): gold vertical gradient, inner top
 * highlight, 1 px darker border, drop shadow, hover lift + glow, press-in.
 *
 * It carries a VERB, not just a price. A reviewer read the previous cost-only
 * pill as static text and concluded the game had no pressable control at all —
 * for a clicker that is fatal, so the label line ("TEND", "LEARN", "AWAKEN")
 * and the ＋ sigil are load-bearing, not decoration.
 *
 * `stopPropagation` matters — the row itself is also clickable and a bubbled
 * click would buy twice.
 */
export function buyBtn(onclick, title, verb = 'TEND') {
  const v = h('span.v.num', '0');
  const x = h('span.x.num', '×1');
  const act = h('span.act', verb);
  const root = h('button.sk-buy', {
    type: 'button',
    onclick: (e) => { e.stopPropagation(); onclick(e); },
    title: title ?? null,
  },
    h('span.gl'), h('span.pl'),
    h('span.tx', h('span.hd', act, x), v),
  );
  return {
    root, v, x, act,
    /** `badge` is shown verbatim in the pill — '×10' for bulk, a kanji for currency. */
    set(cost, badge) {
      setText(v, cost);
      setText(x, badge);
    },
    setVerb(s) { setText(act, s); },
    /** Affordability recolours the button and blocks the press; it never hides it. */
    setEnabled(on) {
      setClass(root, 'off', !on);
      const s = on ? 'false' : 'true';
      if (root.__ad !== s) { root.__ad = s; root.setAttribute('aria-disabled', s); }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Settings controls — sliders and toggles
 *
 * Hand-built rather than `<input type=range|checkbox>` on purpose: ART_BIBLE §7
 * forbids default form controls, and a native range input cannot be given the
 * gold track and keylined rhombus thumb the rest of this UI implies.
 *
 * Building them by hand means the keyboard and ARIA behaviour a native input
 * would have given us for free is now OUR job, and it is not optional — the
 * motion switches in this panel are the ones someone reaches for because the
 * screen shake is making them feel ill, possibly without a working mouse hand.
 * So: real `role`, real `aria-valuenow`/`aria-checked`, arrow keys, Home/End,
 * PageUp/PageDown, and pointer capture so a drag that leaves the track keeps
 * tracking instead of sticking.
 * ------------------------------------------------------------------ */

const clamp01 = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);

/**
 * Gold-filled slider over 0..1, displayed as a whole percentage with tabular
 * figures. `onInput` fires on every change — settings apply live, never on an
 * "apply" button.
 *
 * Returns `{ root, value, set(v), setDimmed(on) }`. `set()` is the quiet path
 * used when something else (another control, a SETTINGS change) moved the value,
 * so syncing the UI can never loop back into `onInput`.
 */
export function slider({
  label, kanji, value = 0, step = 0.05, page = 0.2, ariaLabel, onInput,
} = {}) {
  const val = h('span.val.num', '0%');
  const mu = h('span.mu', 'muted');
  const fil = h('i.fil');
  const thb = h('span.thb');
  const trk = h('div.trk', fil, thb);
  const root = h('div.sk-sld', {
    tabindex: '0',
    role: 'slider',
    'aria-label': ariaLabel ?? label ?? 'volume',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  },
    h('div.hd',
      h('span.lbl', label ?? '', kanji ? h('em', kanji) : null),
      h('span.rt', mu, val)),
    trk,
  );

  let v = clamp01(value);
  let dragging = false;

  function paint() {
    const pct = v * 100;
    setW(fil, pct);
    const left = pct.toFixed(2) + '%';
    if (thb.__l !== left) { thb.__l = left; thb.style.left = left; }
    setText(val, Math.round(pct) + '%');
    const now = String(Math.round(pct));
    if (root.__av !== now) {
      root.__av = now;
      root.setAttribute('aria-valuenow', now);
      root.setAttribute('aria-valuetext', now + '%');
    }
  }
  function commit(next, notify = true) {
    const nv = clamp01(next);
    const changed = nv !== v;
    v = nv;
    paint();
    if (changed && notify && onInput) onInput(v);
  }
  function fromPointer(e) {
    const r = trk.getBoundingClientRect();
    return r.width > 0 ? (e.clientX - r.left) / r.width : v;
  }

  trk.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    try { trk.setPointerCapture(e.pointerId); } catch { /* no capture: move still works */ }
    try { root.focus({ preventScroll: true }); } catch { /* ignore */ }
    commit(fromPointer(e));
  });
  trk.addEventListener('pointermove', (e) => { if (dragging) commit(fromPointer(e)); });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    try { trk.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  trk.addEventListener('pointerup', release);
  trk.addEventListener('pointercancel', release);

  root.addEventListener('keydown', (e) => {
    const s = e.shiftKey ? 0.01 : step;            // fine adjust with Shift held
    let next;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': next = v - s; break;
      case 'ArrowRight': case 'ArrowUp': next = v + s; break;
      case 'PageDown': next = v - page; break;
      case 'PageUp': next = v + page; break;
      case 'Home': next = 0; break;
      case 'End': next = 1; break;
      default: return;
    }
    e.preventDefault();
    /* stop it here: the game module listens for keys on window, and a slider
       nudge must not also be read as a gameplay input */
    e.stopPropagation();
    commit(next);
  });

  paint();
  return {
    root, trk,
    get value() { return v; },
    set(next) { commit(next, false); },
    /** Muted — dim the control but keep the number, so the level reads as
     *  remembered rather than lost. */
    setDimmed(on) { setClass(root, 'off', !!on); },
  };
}

/**
 * Parchment capsule toggle. A real `<button role="switch">`, so Enter and Space
 * work without us reimplementing them.
 *
 * `lockNote` is shown only while `setDisabled(true)` — it explains WHY the
 * control is inert (a master switch is holding it), which is the difference
 * between a clear relationship and a control that looks broken.
 */
export function toggleRow({
  label, kanji, desc, value = false, lockNote, ariaLabel, onChange,
} = {}) {
  const sw = h('span.sw', h('i'));
  const root = h('button.sk-tgl', {
    type: 'button',
    role: 'switch',
    'aria-label': ariaLabel ?? label ?? 'toggle',
  },
    h('span.tx',
      h('div.lbl', label ?? '', kanji ? h('em', kanji) : null),
      desc ? h('div.ds', desc) : null,
      lockNote ? h('div.lk', lockNote) : null),
    sw,
  );

  let v = !!value;
  let disabled = false;
  function paint() {
    setClass(root, 'on', v);
    const a = v ? 'true' : 'false';
    if (root.__ac !== a) { root.__ac = a; root.setAttribute('aria-checked', a); }
  }
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    v = !v;
    paint();
    if (onChange) onChange(v);
  });

  paint();
  return {
    root,
    get value() { return v; },
    set(next) { v = !!next; paint(); },
    setDisabled(on) {
      disabled = !!on;
      setClass(root, 'dis', disabled);
      const a = disabled ? 'true' : 'false';
      if (root.__ad !== a) { root.__ad = a; root.setAttribute('aria-disabled', a); }
    },
  };
}

/** Settings group heading: serif small-caps + kanji over a diamond-centred rule. */
export function groupHead(title, kanji) {
  return h('div.sk-sgrp',
    h('div.hd', h('h4', title), kanji ? h('span.kj', kanji) : null),
    h('div.fl'));
}

/** Gold-keylined parchment note — used to tell someone a preference was honoured. */
export function noteBox(text) {
  return h('div.sk-note', h('span.d'), h('p', text));
}

/** Gold segmented control — one bevelled shell, N inset segments, no flat rects. */
export function segmented(items, onpick) {
  const btns = new Map();
  const root = h('div.sk-seg');
  for (const [label, val] of items) {
    const b = h('button', { onclick: (e) => { e.stopPropagation(); onpick(val); } }, label);
    btns.set(val, b);
    root.append(b);
  }
  return { root, btns, set(v) { for (const [k, b] of btns) setClass(b, 'on', k === v); } };
}

/**
 * Bloom-progression capsule: a 10 px track carrying the whole 0 → 1e13 run in
 * log space, one tick per stage threshold (gold once passed), and a glowing head
 * on the fill. `thresholds` are absolute petal counts, ascending, > 0.
 */
export function stageCapsule(thresholds) {
  const fill = h('i');
  const ticks = thresholds.map(() => h('u'));
  const root = h('div.sk-sbar', fill, ticks);
  const top = Math.log10(Math.max(10, thresholds[thresholds.length - 1] || 1e13));
  ticks.forEach((t, i) => { t.style.left = ((Math.log10(Math.max(10, thresholds[i])) / top) * 100).toFixed(2) + '%'; });
  return {
    root,
    /** total = petals earned this season. Returns the 0..1 position used. */
    set(total) {
      const f = Math.max(0, Math.min(1, Math.log10(Math.max(1, total)) / top));
      setW(fill, f * 100);
      ticks.forEach((t, i) => setClass(t, 'done', total >= thresholds[i]));
      return f;
    },
  };
}
