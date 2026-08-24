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
  { id: 'sprite',   name: 'Wind Sprite',      nameKo: '바람 정령',   kanji: '風精',   glyph: '風', baseCost: 15,     rate: 0.1 },
  { id: 'gatherer', name: 'Petal Gatherer',   nameKo: '꽃잎 줍는 아이', kanji: '花摘み', glyph: '摘', baseCost: 100,    rate: 1 },
  { id: 'miko',     name: 'Shrine Maiden',    nameKo: '무녀',      kanji: '巫女',   glyph: '巫', baseCost: 1.1e3,  rate: 8 },
  { id: 'lantern',  name: 'Stone Lantern',    nameKo: '석등롱',    kanji: '石灯籠', glyph: '灯', baseCost: 1.2e4,  rate: 47 },
  { id: 'koi',      name: 'Koi Spirit',       nameKo: '잉어의 영혼', kanji: '鯉霊',   glyph: '鯉', baseCost: 1.3e5,  rate: 260 },
  { id: 'rabbit',   name: 'Moon Rabbit',      nameKo: '달 토끼',   kanji: '月兎',   glyph: '兎', baseCost: 1.4e6,  rate: 1.4e3 },
  { id: 'kitsune',  name: 'Kitsune Herald',   nameKo: '여우 사자', kanji: '狐使',   glyph: '狐', baseCost: 2.0e7,  rate: 7.8e3 },
  { id: 'envoy',    name: "Wind God's Envoy", nameKo: '풍신의 사자', kanji: '風神使', glyph: '神', baseCost: 3.3e8,  rate: 4.4e4 },
  { id: 'heart',    name: 'Everblossom Heart',nameKo: '영원한 꽃의 마음',kanji: '常桜心', glyph: '心', baseCost: 5.1e9,  rate: 2.6e5 },
  { id: 'bough',    name: 'Celestial Bough',  nameKo: '하늘의 가지', kanji: '天樹枝', glyph: '天', baseCost: 7.5e10, rate: 1.6e6 },
];

export const MILESTONES = [10, 25, 50, 100, 150, 200];

export const STAGE_DEFS = [
  { i: 0, kanji: '冬芽', name: 'Winter Bud',  nameKo: '겨울 눈봉우리', threshold: 0 },
  { i: 1, kanji: '蕾',   name: 'Budding',     nameKo: '봉우리',      threshold: 1e3 },
  { i: 2, kanji: '初咲', name: 'First Bloom', nameKo: '초咲',         threshold: 1e5 },
  { i: 3, kanji: '満開', name: 'Full Bloom',  nameKo: '만개',         threshold: 1e7 },
  { i: 4, kanji: '輝咲', name: 'Radiant',     nameKo: '찬란한 꽃',     threshold: 1e10 },
  { i: 5, kanji: '常桜', name: 'Everblossom', nameKo: '영원한 꽃',    threshold: 1e13 },
];

export const EVENT_DEFS = {
  storm:  { kanji: '花嵐',   name: 'Petal Storm', nameKo: '꽃보라 폭풍', desc: '×10 수동적 · 숲이 포효한다.' },
  moon:   { kanji: '満月',   name: 'Full Moon',   nameKo: '보름달',     desc: '+25% 치명타 · 달빛 팔레트.' },
  golden: { kanji: '黄金時', name: 'Golden Hour', nameKo: '황금빛 시간', desc: '+15% 클릭 가치.' },
  rain:   { kanji: '春雨',   name: 'Spring Rain', nameKo: '봄비',        desc: '+10% 수동적 · 꽃잎이 천천히 흐른다.' },
};

export const CODEX_DEFS = [
  { id: 'somei',    kanji: '染井吉野', name: 'Somei Yoshino',  nameKo: '소메이 요시노', rarity: 3, glyph: '染', desc: '다섯 장의 옅은 꽃잎, 가장자리에 거의 흰빛. 이 나라의 모든 가로수는 한 그루의 복제본으로 심어졌고, 모든 봄에 같은 날에 함께 핀다.' },
  { id: 'shidare',  kanji: '枝垂桜',   name: 'Shidarezakura',  nameKo: '시다레자쿠라', rarity: 4, glyph: '垂', desc: '가지가 물처럼 떨어지며 그 과정에서 꽃을 피운다. 북쪽에서 가장 오래된 것은 천 년 동안 기울어져 왔다.' },
  { id: 'yae',      kanji: '八重桜',   name: 'Yaezakura',      nameKo: '야에자쿠라', rarity: 4, glyph: '八', desc: '겹쳐 핀다 — 꽃 한 송이에 20, 30, 때로는 100장. 무거워서 가지가 끄덕인다. 더 많은 시간이 필요하다 듯이, 늦게 핀다.' },
  { id: 'kawazu',   kanji: '河津桜',   name: 'Kawazu-zakura',  nameKo: '카와즈자쿠라', rarity: 3, glyph: '河', desc: '짙은 장밋빛, 그리고 조급하다 — 다른 것들이 아직 잠들어 있는 2월에 피고, 그 뒤로 한 달을 서리에게 도전하듯 꽃을 붙잡고 있는다.' },
  { id: 'yama',     kanji: '山桜',     name: 'Yamazakura',     nameKo: '야마자쿠라', rarity: 3, glyph: '山', desc: '산벗꽃, 그리고 옛 시들이 의미하는 그것. 구릿빛 잎이 꽃과 함께 열리므로, 온 언덕이 두 색깔로 동시에 바뀐다.' },
  { id: 'oshima',   kanji: '大島桜',   name: 'Oshima-zakura',  nameKo: '오시마자쿠라', rarity: 3, glyph: '島', desc: '희고, 꽃잎이 넓고, 희미하게 달다. 잎은 소금에 절여 콩과자로 감싼다. 나라의 절반이 매 봄 이 나무를 보지 않고 맛본다.' },
  { id: 'ukon',     kanji: '鬱金桜',   name: 'Ukon',           nameKo: '우콘', rarity: 4, glyph: '鬱', desc: '옅은 황록색, 강황으로 들인 비단의 색. 나이를 먹으며 중앙이 분홍으로 바래진다. 꽃에게 잘못된 방향이지만 신경 쓰지 않는다.' },
  { id: 'gyoiko',   kanji: '御衣黄',   name: 'Gyoiko',         nameKo: '교이고', rarity: 5, glyph: '衣', desc: '초록이다. 진짜로 초록이다. 각 꽃잎 위로 붉은 줄무늬가 흐른다. 궁정의 법복 색이라서, 그 색을 가질 수 있는 게 그것밖에 없었다.' },
  { id: 'jugatsu',  kanji: '十月桜',   name: 'Jugatsu-zakura', nameKo: '쥬가쓰자쿠라', rarity: 4, glyph: '十', desc: '두 번 핀다: 10월에 한 차례 흩어지게, 봄에 나머지를. 이 배열을 설명한 적이 없고, 아무도 그것을 설득하지 못했다.' },
  { id: 'fuyu',     kanji: '冬桜',     name: 'Fuyuzakura',     nameKo: '후유자쿠라', rarity: 4, glyph: '冬', desc: '겨울의 벚꽃. 작고, 드문드문하며, 눈 속에서 꽃을 피운다 — 당신이 없는 동안에도 숲이 계속 일하고 있다는 증거.' },
  { id: 'yoko',     kanji: '陽光桜',   name: 'Yoko',           nameKo: '요코', rarity: 5, glyph: '陽', desc: '전쟁 후, 돌아오지 않은 학생들을 추모하기 위해 학교 선생님이 어디서든 자라날 무언가를 만들었다. 선명한 분홍, 강인함, 지금은 어디에나 있다.' },
  { id: 'ever',     kanji: '常桜',     name: 'Everblossom',    nameKo: '영원한 꽃', rarity: 5, glyph: '常', desc: '어느 식물 도감에도 없다. 나뭇결에 금이, 낙하에는 오로라가, 그리고 휴면기가 전혀 없다. 당신은 이 모든 시간 동안 그것을 키우고 있었다.' },
];

/** Upgrade families — id, kanji glyph, and the accent class used for the sigil. */
export const UPGRADE_FAMILIES = [
  { id: 'shake',  kanji: '揺', name: 'Shake',  nameKo: '손 흔들기', sub: '가지 위 손' },
  { id: 'tender', kanji: '育', name: 'Tender', nameKo: '정령 돌봄', sub: '숲을 지키는 자들' },
  { id: 'grove',  kanji: '苑', name: 'Grove',  nameKo: '숲 자체',  sub: '장소 자체의 형태' },
];

/** Fallback upgrade list — the real catalogue lives in 60-game.js. */
export const UPGRADE_DEFS = [
  { id: 's1', family: 'shake', name: 'Steady Hand',      nameKo: '단단한 손',       cost: 100,   flavour: '가지를 움켜잡는 것을 멈추고, 단순히 부탁하기 시작한다.' },
  { id: 's2', family: 'shake', name: 'Wrist of the Wind', nameKo: '바람의 손목',    cost: 1.2e3, flavour: '바람이 일을 하고, 당신은 타이밍만 알려준다.' },
  { id: 's3', family: 'shake', name: 'Falling Star Strike', nameKo: '별이 떨어지는 타격', cost: 1.4e4, flavour: '드물게, 나무가 요구한 것보다 더 많이 돌려준다.' },
  { id: 's4', family: 'shake', name: 'Ninefold Petalfall', nameKo: '아홉 겹 꽃낙하', cost: 2.6e5, flavour: '한 번 흔들어 아홉 호흡의 낙하. 아홉 번째는 아무도 세지 않는다.' },
  { id: 't1', family: 'tender', name: 'Sprite Whistle',   nameKo: '정령의 호루라기', cost: 480,   flavour: '두 음. 첫 번째는 못 들은 척한다.' },
  { id: 't2', family: 'tender', name: 'Woven Baskets',    nameKo: '짠 바구니',     cost: 3.6e3, flavour: '얇게 쪼갠 대나무. 좋은 바구니를 가진 줍는 아이 둘이 없는 아이 셋보다 낫다.' },
  { id: 't3', family: 'tender', name: 'Morning Prayer',   nameKo: '아침 기도',     cost: 4.4e4, flavour: '무녀들이 해 뜸 전에 노래한다. 나무가 그것을 좋아하는 것 같다.' },
  { id: 't4', family: 'tender', name: 'All Hands to the Bough', nameKo: '모두 가지로', cost: 6.5e5, flavour: '모든 정령 ×1.5. 아무도 구경할 수 없다.' },
  { id: 'g1', family: 'grove', name: 'Dew Reservoir',     nameKo: '이슬 저장고',   cost: 2.2e3, flavour: '밤 동안 당신을 위해 머무는 돌 그릇.' },
  { id: 'g2', family: 'grove', name: 'Gilded Fortune',    nameKo: '금빛 행운',     cost: 2.8e4, flavour: '황금 꽃잎이 더 자주 흘러온다. 결국, 행운은 조경이다.' },
  { id: 'g3', family: 'grove', name: 'Petal Magnet',      nameKo: '꽃잎 자석',     cost: 1.8e5, flavour: '떨어진 꽃잎이 당신 쪽으로 기울어진다. 고양이가 마음에 드는 것처럼.' },
  { id: 'g4', family: 'grove', name: 'Windward Shrine',   nameKo: '바람쪽 사당',   cost: 3.1e6, flavour: '폭풍이 머문다. 사당이 그것이 머무를 이유를 준다.' },
];

/** Constellation — 5 branches × ~6 nodes, laid out radially. */
export const CONSTEL_BRANCHES = [
  { id: 'wind',    kanji: '風', name: 'Wind',    nameKo: '바람', hue: '#9FD4E8' },
  { id: 'water',   kanji: '水', name: 'Water',   nameKo: '물',  hue: '#8FA8E8' },
  { id: 'moon',    kanji: '月', name: 'Moon',    nameKo: '달',  hue: '#D8CBF0' },
  { id: 'stone',   kanji: '石', name: 'Stone',   nameKo: '돌',  hue: '#D8C29A' },
  { id: 'blossom', kanji: '桜', name: 'Blossom', nameKo: '꽃',  hue: '#F2A8C6' },
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
  const c = (p) => h('div.sk-c' + (small ? '.sm' : ''), { class: p, 'aria-hidden': 'true' });
  return [c('tl'), c('tr'), c('bl'), c('br')];
}

/** Monotonic id source — ARIA relationships (aria-labelledby / describedby) need
 *  real ids, and a panel can be rebuilt many times in one session. */
let _uid = 0;
export const uid = (p = 'sk') => `${p}-${++_uid}`;

/**
 * Parchment panel with filigree corners, title block and tapered rule.
 *
 * Returns `titleId` so a caller mounting this as a modal can point
 * `aria-labelledby` at the real title instead of duplicating the string.
 */
export function panel({ title, kanji, cls = '', foot = null, close = null }) {
  const body = h('div.sk-panel-body');
  const titleId = uid('sk-title');
  const head = h('div.sk-panel-head',
    h('h2.sk-title', { id: titleId }, title),
    kanji ? h('div.kj', { 'aria-hidden': 'true' }, kanji) : null,
    h('div.fl', { 'aria-hidden': 'true' }),
  );
  const root = h('div.sk-paper' + (cls ? '.' + cls.split(' ').join('.') : ''),
    corners(),
    close
      ? h('button.sk-x', {
        type: 'button', onclick: close,
        'aria-label': 'Close ' + (title ?? 'panel') + ' — Esc',
        title: 'Close  (Esc)',
      }, '✕')
      : null,
    head,
    h('div.sk-rule', { 'aria-hidden': 'true' }),
    body,
    foot,
  );
  return { root, body, head, titleId };
}

/* ------------------------------------------------------------------ *
 * Focus plumbing
 *
 * Hand-built widgets mean the focus behaviour a native form would have given us
 * is our job. These two helpers are what makes a modal keyboard-safe: everything
 * reachable inside it, and nothing reachable behind it.
 * ------------------------------------------------------------------ */
const FOCUS_SEL = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[tabindex]', '[role="slider"]', '[role="switch"]', '[role="option"]',
].join(',');

/** Visible, enabled, tabbable descendants of `root`, in DOM order. */
export function focusables(root) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  for (const el of root.querySelectorAll(FOCUS_SEL)) {
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (Number(el.getAttribute('tabindex')) < 0) continue;
    /* offsetParent is null for display:none — cheap and correct here because
       nothing in this UI is position:fixed. SVG has no offsetParent, so fall
       back to a bbox test for the constellation nodes. */
    const box = el.getClientRects?.();
    if (!box || box.length === 0) continue;
    out.push(el);
  }
  return out;
}

/** Move focus without the browser scrolling a panel body out from under it. */
export function focusIt(el) {
  if (!el) return false;
  try { el.focus({ preventScroll: true }); return document.activeElement === el; }
  catch { return false; }
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
  return h('button.sk-btn' + (opts.cls ? '.' + opts.cls : ''), {
    type: 'button', onclick, title: opts.title,
    'aria-label': opts.ariaLabel ?? null,
  }, label);
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
  /* Affordability is NOT signalled by colour alone: `.sk-buy.off .pl::before`
     swaps the ＋ sigil for a 錠 padlock (shape), and this line spells it out for
     a screen reader and for anyone who cannot read the gold-vs-grey difference. */
  const whyId = uid('sk-why');
  const why = h('span.sk-sr', { id: whyId }, '');
  const root = h('button.sk-buy', {
    type: 'button',
    onclick: (e) => { e.stopPropagation(); onclick(e); },
    title: title ?? null,
    'aria-label': title ?? null,
    /* describedby, NOT the label: an aria-label overrides the subtree, so the
       "locked" line inside the button would never have been read out. */
    'aria-describedby': whyId,
  },
    h('span.gl', { 'aria-hidden': 'true' }), h('span.pl', { 'aria-hidden': 'true' }),
    h('span.tx', h('span.hd', act, x), v), why,
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
      if (root.__ad !== s) {
        root.__ad = s;
        root.setAttribute('aria-disabled', s);
        setText(why, on ? '' : ' — locked, you cannot afford this yet');
      }
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
    'aria-orientation': 'horizontal',
    /* the whole keyboard contract, spoken. A hand-rolled slider that does not
       say what its arrow keys do is a slider nobody discovers. */
    title: `${label ?? 'Volume'} — arrows adjust, PgUp/PgDn jumps, Home/End for min/max`,
  },
    h('div.hd',
      h('span.lbl', label ?? '', kanji ? h('em', { 'aria-hidden': 'true' }, kanji) : null),
      h('span.rt', mu, val)),
    trk,
  );

  let v = clamp01(value);
  let dragging = false;
  let dimmed = false;

  function paint() {
    const pct = v * 100;
    setW(fil, pct);
    const left = pct.toFixed(2) + '%';
    if (thb.__l !== left) { thb.__l = left; thb.style.left = left; }
    setText(val, Math.round(pct) + '%');
    const now = String(Math.round(pct));
    /* The dimmed-and-muted state must NOT be colour-only: the "MUTED" pill is
       the visible cue, and aria-valuetext is the spoken one. */
    const txt = now + '%' + (dimmed ? ' — muted, nothing is audible' : '');
    if (root.__av !== now + '|' + txt) {
      root.__av = now + '|' + txt;
      root.setAttribute('aria-valuenow', now);
      root.setAttribute('aria-valuetext', txt);
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
     *  remembered rather than lost. The "MUTED" pill (never colour alone) and
     *  aria-valuetext both come from here. */
    setDimmed(on) { dimmed = !!on; setClass(root, 'off', dimmed); paint(); },
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
  const sw = h('span.sw', { 'aria-hidden': 'true' }, h('i'));
  /* ON / OFF in words, beside the capsule. The gold fill and the knob position
     already say it, but "state by colour alone" is the failure mode this UI was
     pulled up on, and the switch that says "reduce motion" is exactly the one a
     colour-blind player must be able to read at a glance. */
  const stateTx = h('span.st', 'OFF');
  const descId = desc ? uid('sk-d') : null;
  const lockId = lockNote ? uid('sk-l') : null;
  const root = h('button.sk-tgl', {
    type: 'button',
    role: 'switch',
    'aria-label': ariaLabel ?? label ?? 'toggle',
    'aria-describedby': [descId, lockId].filter(Boolean).join(' ') || null,
    title: (label ?? 'Toggle') + ' — Enter or Space to flip',
  },
    h('span.tx',
      h('div.lbl', label ?? '', kanji ? h('em', { 'aria-hidden': 'true' }, kanji) : null),
      desc ? h('div.ds', { id: descId }, desc) : null,
      lockNote ? h('div.lk', { id: lockId }, lockNote) : null),
    h('span.swwrap', stateTx, sw),
  );

  let v = !!value;
  let disabled = false;
  function paint() {
    setClass(root, 'on', v);
    setText(stateTx, disabled ? 'HELD' : v ? 'ON' : 'OFF');
    const a = v ? 'true' : 'false';
    if (root.__ac !== a) { root.__ac = a; root.setAttribute('aria-checked', a); }
  }
  /* A real <button role="switch"> gets Enter and Space from the browser as a
     click — no key handler to reimplement, and none to get wrong. */
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
      /* aria-disabled, never the `disabled` attribute: a held switch must stay
         focusable so a screen-reader user can find it and hear WHY it is held. */
      paint();
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
export function segmented(items, onpick, opts = {}) {
  const btns = new Map();
  const root = h('div.sk-seg', { role: 'group', 'aria-label': opts.ariaLabel ?? null });
  for (const [label, val] of items) {
    const b = h('button', {
      type: 'button', 'aria-pressed': 'false',
      onclick: (e) => { e.stopPropagation(); onpick(val); },
    }, label);
    btns.set(val, b);
    root.append(b);
  }
  return {
    root, btns,
    /** `aria-pressed` alongside the gold fill — the selected segment must not be
     *  identifiable by colour alone. */
    set(v) {
      for (const [k, b] of btns) {
        setClass(b, 'on', k === v);
        const a = k === v ? 'true' : 'false';
        if (b.__ap !== a) { b.__ap = a; b.setAttribute('aria-pressed', a); }
      }
    },
  };
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
