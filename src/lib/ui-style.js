/**
 * ui-style.js — the visual language of the HUD, as a JS template string.
 * Owner: UI agent. Nothing here touches Three.js.
 *
 * Everything ornamental is generated procedurally: inline SVG data URIs for the
 * gold filigree, canvas noise for the paper grain. No network requests, no icon
 * fonts, system font stacks only (ART_BIBLE §7).
 */

import { mulberry32 } from './rng.js';

/* ------------------------------------------------------------------ *
 * Tokens — authored straight out of ART_BIBLE §3 / §7.
 * ------------------------------------------------------------------ */
export const T = {
  parchment: '#F3EBDC',
  parchmentHi: '#FBF5E8',
  parchmentLo: '#E3D5BC',
  ink: '#3A322A',
  /* darkened from #6B5C49: measured 5.8:1 on the panel foot's shaded parchment,
     where the old value sat at 4.61:1 with no headroom. */
  inkSoft: '#5B4E3E',
  /* Measured on-screen (glyph core vs local background) at 5.2:1 even inside the
     panel foot, where the paper's bottom shading drops the ground to L 0.66.
     The old #94836C measured 3.1:1 and was why every secondary label failed. */
  inkFaint: '#5F5241',
  border: '#4A4034',
  gold: '#C9A227',
  goldHi: '#F0D68A',
  goldLo: '#B98B32',
  goldDeep: '#A8792C',
  goldPale: '#E8C56A',
  /* Gold used as TEXT on parchment. goldDeep is only 3.26:1; this is 5.39:1. */
  goldInk: '#74520E',
  petalLight: '#FFD9E6',
  petalMid: '#FFB6CE',
  petalShadow: '#EE8CAF',
  petalDeep: '#C25F86',
  vermilion: '#C4322B',
  r3: '#4C8BC9',
  r4: '#A277DD',
  r5: '#D5A54A',
  ok: '#4E7D42',
  no: '#9B4A3A',
};

const enc = (svg) => `url("data:image/svg+xml;charset=utf8,${encodeURIComponent(svg.replace(/\s{2,}/g, ' '))}")`;

/* ------------------------------------------------------------------ *
 * Procedural ornament
 * ------------------------------------------------------------------ */

const goldDefs = (id) => `
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FBEEC2"/>
      <stop offset=".38" stop-color="${T.goldPale}"/>
      <stop offset=".72" stop-color="#C79B3E"/>
      <stop offset="1" stop-color="${T.goldDeep}"/>
    </linearGradient>
  </defs>`;

/**
 * Gold filigree corner piece. Drawn once for the top-left orientation; the CSS
 * mirrors it with scaleX/scaleY for the other three corners.
 */
export function filigreeCorner(size = 42) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 42 42">
    ${goldDefs('fg')}
    <g fill="none" stroke="url(#fg)" stroke-width="1.5" stroke-linecap="round">
      <path d="M1.6 19 V6.4 A4.8 4.8 0 0 1 6.4 1.6 H19"/>
      <path d="M6.2 24.5 V9.6 A3.4 3.4 0 0 1 9.6 6.2 H24.5" stroke-width="1"/>
      <path d="M13.4 6.4 C 20.6 7.4 25.8 12.4 26.6 19.6" stroke-width=".9"/>
      <path d="M6.4 13.4 C 7.4 20.6 12.4 25.8 19.6 26.6" stroke-width=".9"/>
      <path d="M27.2 3.2 C 31.4 3.6 34.6 6 36 9.4" stroke-width=".85"/>
      <path d="M3.2 27.2 C 3.6 31.4 6 34.6 9.4 36" stroke-width=".85"/>
    </g>
    <g fill="url(#fg)">
      <circle cx="9.2" cy="9.2" r="1.9"/>
      <path d="M21.6 18.4 L24.6 21.4 L21.6 24.4 L18.6 21.4 Z" opacity=".92"/>
      <path d="M37.6 10.6 l1.5 2.2 -1.5 2.2 -1.5 -2.2 Z" opacity=".7"/>
      <path d="M10.6 37.6 l2.2 1.5 -2.2 1.5 -2.2 -1.5 Z" opacity=".7"/>
    </g>
  </svg>`;
  return enc(svg);
}

/** Small solid rhombus used at panel-title centre and as a bullet. */
export function diamond(px = 12, color = T.gold) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 12 12">
    <path d="M6 .6 L11.4 6 L6 11.4 L.6 6 Z" fill="${color}"/>
    <path d="M6 2.8 L9.2 6 L6 9.2 L2.8 6 Z" fill="#FBEEC2" opacity=".55"/>
  </svg>`;
  return enc(svg);
}

/** Symmetric title flourish: tapered rules meeting a central diamond. */
export function titleFlourish(w = 240) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="12" viewBox="0 0 240 12" preserveAspectRatio="none">
    <defs>
      <linearGradient id="tf" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="240" y2="0">
        <stop offset="0" stop-color="${T.goldDeep}" stop-opacity="0"/>
        <stop offset=".22" stop-color="${T.goldPale}" stop-opacity=".9"/>
        <stop offset=".44" stop-color="${T.goldDeep}" stop-opacity=".45"/>
        <stop offset=".56" stop-color="${T.goldDeep}" stop-opacity=".45"/>
        <stop offset=".78" stop-color="${T.goldPale}" stop-opacity=".9"/>
        <stop offset="1" stop-color="${T.goldDeep}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="5.45" width="240" height="1.1" fill="url(#tf)"/>
    <path d="M26 8.6 C 62 10.4 96 9.4 112 6.8" fill="none" stroke="url(#tf)" stroke-width=".7" opacity=".7"/>
    <path d="M214 8.6 C 178 10.4 144 9.4 128 6.8" fill="none" stroke="url(#tf)" stroke-width=".7" opacity=".7"/>
    <circle cx="106" cy="6" r="1.4" fill="${T.goldDeep}" opacity=".85"/>
    <circle cx="134" cy="6" r="1.4" fill="${T.goldDeep}" opacity=".85"/>
    <path d="M120 .9 L125.2 6 L120 11.1 L114.8 6 Z" fill="${T.goldDeep}"/>
    <path d="M120 3.1 L123 6 L120 8.9 L117 6 Z" fill="#FBEEC2" opacity=".7"/>
  </svg>`;
  return enc(svg);
}

/**
 * Five-pointed star for rarity rows. `stroke`/`sw` matter: on parchment a cream
 * or gold star with a hairline outline dissolves into the paper — the review
 * measured the Tender star row as unreadable at 1080p. The ink cut below runs a
 * 1 px dark outline plus a gradient fill so each point stays separable.
 */
export function starIcon(fill = '#FFF3CF', stroke = 'rgba(90,64,16,.5)', sw = 0.5) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
    <path d="M7 .9 L8.85 5.1 L13.3 5.55 L9.95 8.6 L10.9 13 L7 10.7 L3.1 13 L4.05 8.6 L.7 5.55 L5.15 5.1 Z"
      fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
  </svg>`;
  return enc(svg);
}

/** Gold star with a real 1 px dark keyline — legible against parchment. */
export function starIconInk(on = true) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
    <defs><linearGradient id="sv" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${on ? '#FFF4CE' : 'rgba(196,186,168,.55)'}"/>
      <stop offset=".55" stop-color="${on ? T.goldPale : 'rgba(168,158,140,.5)'}"/>
      <stop offset="1" stop-color="${on ? '#B0801F' : 'rgba(140,130,114,.5)'}"/>
    </linearGradient></defs>
    <path d="M9 1.4 L11.36 6.6 L17.0 7.2 L12.75 10.98 L13.95 16.6 L9 13.72 L4.05 16.6 L5.25 10.98 L1.0 7.2 L6.64 6.6 Z"
      fill="url(#sv)" stroke="${on ? 'rgba(46,34,10,.92)' : 'rgba(74,64,52,.42)'}" stroke-width="1.05" stroke-linejoin="round"/>
    ${on ? '<path d="M9 3.9 L10.3 6.9 L13.2 7.2 L11.0 9.2 L9 8.3 Z" fill="#FFFBE8" opacity=".55"/>' : ''}
  </svg>`;
  return enc(svg);
}

/**
 * Wax-seal medallion for the locked Tender row. Replaces the grey diagonal
 * hatch the review read as "a disabled HTML fieldset": a sealed scroll is the
 * in-world way to say "not yet", and it is gold rather than grey.
 */
export function waxSeal(size = 40) {
  const scallop = [];
  const N = 15;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 17.4 + (i % 2 ? -0.85 : 0.95);
    scallop.push(`${(20 + Math.cos(a) * r).toFixed(2)} ${(20 + Math.sin(a) * r).toFixed(2)}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">
    <defs>
      <radialGradient id="wx" cx=".38" cy=".32" r=".78">
        <stop offset="0" stop-color="#FBEDC0"/><stop offset=".42" stop-color="${T.goldPale}"/>
        <stop offset=".78" stop-color="#B98B32"/><stop offset="1" stop-color="#7C5510"/>
      </radialGradient>
      <linearGradient id="wr" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFF6D6"/><stop offset="1" stop-color="#A8792C"/>
      </linearGradient>
    </defs>
    <polygon points="${scallop.join(' ')}" fill="url(#wx)" stroke="rgba(66,46,10,.8)" stroke-width=".9"/>
    <circle cx="20" cy="20" r="13.4" fill="none" stroke="rgba(72,50,10,.42)" stroke-width=".8"/>
    <circle cx="20" cy="20" r="11.2" fill="none" stroke="url(#wr)" stroke-width=".7" opacity=".8"/>
    <g fill="rgba(70,48,10,.62)">
      ${[0, 1, 2, 3, 4].map((i) => {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const cx = 20 + Math.cos(a) * 5.4, cy = 20 + Math.sin(a) * 5.4;
    return `<ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="3.5" ry="2.5" transform="rotate(${(a * 180 / Math.PI + 90).toFixed(1)} ${cx.toFixed(2)} ${cy.toFixed(2)})"/>`;
  }).join('')}
    </g>
    <circle cx="20" cy="20" r="2.2" fill="#FFF6DA" opacity=".85"/>
  </svg>`;
  return enc(svg);
}

/** Monochrome blossom watermark — sits inside the rarity icon chip. */
export function blossomMark(size = 40, color = '#FFFFFF') {
  const p = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const cx = 20 + Math.cos(a) * 7.2, cy = 20 + Math.sin(a) * 7.2;
    p.push(`<ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="5.2" ry="3.6" transform="rotate(${(a * 180 / Math.PI + 90).toFixed(1)} ${cx.toFixed(2)} ${cy.toFixed(2)})"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">
    <g fill="${color}">${p.join('')}</g>
  </svg>`;
  return enc(svg);
}

/** A stylised five-petal blossom — the Petals currency glyph. */
export function blossomIcon(size = 26) {
  const p = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const cx = 13 + Math.cos(a) * 5.1, cy = 13 + Math.sin(a) * 5.1;
    const ax = Math.cos(a), ay = Math.sin(a);
    const px = -ay, py = ax;
    const tipx = 13 + ax * 11.4, tipy = 13 + ay * 11.4;
    p.push(`<path d="M13 13 C ${cx + px * 4.4} ${cy + py * 4.4} ${tipx + px * 3.0} ${tipy + py * 3.0} ${tipx - ax * 1.1 + px * 0.7} ${tipy - ay * 1.1 + py * 0.7}
      C ${tipx + ax * 1.2} ${tipy + ay * 1.2} ${tipx - px * 3.0} ${tipy - py * 3.0} ${cx - px * 4.4} ${cy - py * 4.4} Z" fill="url(#bl)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 26 26">
    <defs><radialGradient id="bl" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#FFF2F6"/><stop offset=".45" stop-color="${T.petalLight}"/>
      <stop offset=".82" stop-color="${T.petalMid}"/><stop offset="1" stop-color="${T.petalShadow}"/>
    </radialGradient></defs>
    ${p.join('')}
    <circle cx="13" cy="13" r="1.9" fill="#FFF6D8" opacity=".9"/>
  </svg>`;
  return enc(svg);
}

/** Blossoms (permanent currency) — a gold blossom seal. */
export function sealIcon(size = 20, tint = T.goldPale) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">
    ${goldDefs('sg')}
    <circle cx="10" cy="10" r="8.4" fill="none" stroke="url(#sg)" stroke-width="1.2"/>
    <circle cx="10" cy="10" r="6" fill="none" stroke="${tint}" stroke-width=".6" opacity=".7"/>
    <path d="M10 4.6 L11.6 8.4 L15.4 10 L11.6 11.6 L10 15.4 L8.4 11.6 L4.6 10 L8.4 8.4 Z" fill="url(#sg)"/>
  </svg>`;
  return enc(svg);
}

/** Essence — a four-point spark. */
export function essenceIcon(size = 20) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">
    <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFF0F6"/><stop offset=".5" stop-color="#F0A8CB"/><stop offset="1" stop-color="#B36A99"/>
    </linearGradient></defs>
    <path d="M10 .8 C 11 6 14 9 19.2 10 C 14 11 11 14 10 19.2 C 9 14 6 11 .8 10 C 6 9 9 6 10 .8 Z" fill="url(#eg)"/>
  </svg>`;
  return enc(svg);
}

/**
 * Band divider for long card lists: a tapered dark hairline, a gold companion
 * line and a centred rhombus. Heavier than `taperRule` on purpose — at 6 px and
 * 42% alpha the plain rule vanished between two tinted cards.
 */
export function bandRule(w = 320) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="10" viewBox="0 0 ${w} 10" preserveAspectRatio="none">
    <defs>
      <linearGradient id="br" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">
        <stop offset="0" stop-color="${T.border}" stop-opacity="0"/>
        <stop offset=".14" stop-color="${T.border}" stop-opacity=".5"/>
        <stop offset=".38" stop-color="${T.border}" stop-opacity=".82"/>
        <stop offset=".62" stop-color="${T.border}" stop-opacity=".82"/>
        <stop offset=".86" stop-color="${T.border}" stop-opacity=".5"/>
        <stop offset="1" stop-color="${T.border}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">
        <stop offset="0" stop-color="${T.gold}" stop-opacity="0"/>
        <stop offset=".5" stop-color="${T.goldPale}" stop-opacity=".9"/>
        <stop offset="1" stop-color="${T.gold}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="3.6" width="${w}" height="1.3" fill="url(#br)"/>
    <rect x="0" y="5.5" width="${w}" height="1" fill="url(#bg)"/>
  </svg>`;
  return enc(svg);
}

/** Tapered hairline divider (thick centre, vanishing ends) + gold underline. */
export function taperRule(w = 320) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6" preserveAspectRatio="none">
    <defs>
      <linearGradient id="tr" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">
        <stop offset="0" stop-color="${T.border}" stop-opacity="0"/>
        <stop offset=".18" stop-color="${T.border}" stop-opacity=".42"/>
        <stop offset=".5" stop-color="${T.border}" stop-opacity=".62"/>
        <stop offset=".82" stop-color="${T.border}" stop-opacity=".42"/>
        <stop offset="1" stop-color="${T.border}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="tg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">
        <stop offset="0" stop-color="${T.gold}" stop-opacity="0"/>
        <stop offset=".5" stop-color="${T.gold}" stop-opacity=".6"/>
        <stop offset="1" stop-color="${T.gold}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="2" width="${w}" height="1" fill="url(#tr)"/>
    <rect x="0" y="3.7" width="${w}" height=".9" fill="url(#tg)"/>
  </svg>`;
  return enc(svg);
}

/* ------------------------------------------------------------------ *
 * Canvas-generated paper grain + fibre.  Cached, deterministic.
 * ------------------------------------------------------------------ */
let _grain = null;
export function paperGrain() {
  if (_grain) return _grain;
  try {
    const S = 156;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const r = mulberry32(0x5a4b12);
    for (let i = 0; i < S * S; i++) {
      const n = (r() + r() + r()) / 3;              // gaussian-ish speckle
      const v = Math.round(120 + (n - 0.5) * 240);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 26;
    }
    g.putImageData(img, 0, 0);
    // long fibres
    g.globalAlpha = 0.05;
    for (let i = 0; i < 70; i++) {
      const y = r() * S, len = 12 + r() * 54, x = r() * S;
      g.strokeStyle = r() < 0.5 ? '#7a6647' : '#fffaf0';
      g.lineWidth = r() < 0.8 ? 0.6 : 1.1;
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x + len * 0.35, y + (r() - 0.5) * 4, x + len * 0.7, y + (r() - 0.5) * 4, x + len, y + (r() - 0.5) * 3);
      g.stroke();
    }
    // faint blotches so large panels never read as flat
    for (let i = 0; i < 16; i++) {
      const x = r() * S, y = r() * S, rad = 8 + r() * 26;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(150,124,84,.055)');
      gr.addColorStop(1, 'rgba(150,124,84,0)');
      g.fillStyle = gr; g.globalAlpha = 1;
      g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
    }
    _grain = `url("${c.toDataURL('image/png')}")`;
  } catch {
    _grain = 'none';
  }
  return _grain;
}

/* ------------------------------------------------------------------ *
 * The stylesheet
 * ------------------------------------------------------------------ */
export function uiCss() {
  const grain = paperGrain();
  const corner = filigreeCorner(42);
  const cornerSm = filigreeCorner(26);
  const rule = taperRule(320);
  const brule = bandRule(320);
  const dia = diamond(12);
  const diaInk = diamond(9, 'rgba(74,64,52,.62)');
  const flourish = titleFlourish(240);
  const star = starIcon('#FFF3CF');
  const starOff = starIcon('rgba(255,255,255,.18)');
  /* 1 px dark keyline + gradient fill; at 11 px these stay countable on parchment */
  const starInk = starIconInk(true);
  const starInkOff = starIconInk(false);
  const seal = waxSeal(46);
  const mark = blossomMark(44, '#FFFFFF');

  return `
#ui-root{
  --u: clamp(12px, calc(0.55vw + 0.25vh), 18px);
  --rail: min(37%, calc(var(--u)*44));
  --parchment:${T.parchment}; --ink:${T.ink}; --ink-soft:${T.inkSoft}; --ink-faint:${T.inkFaint};
  --border:${T.border}; --gold:${T.gold}; --gold-hi:${T.goldHi}; --gold-lo:${T.goldLo};
  --gold-ink:${T.goldInk};
  /* every secondary label lands at >=12 px at 1080p (u = 13.26 px there) */
  --t-sec:calc(var(--u)*.92);
  --grain:${grain};
  --serif:"Hiragino Mincho ProN","Yu Mincho","YuMincho","Songti SC","Source Han Serif",Georgia,"Times New Roman",serif;
  --sans:"Hiragino Sans","Yu Gothic UI","Hiragino Kaku Gothic ProN",-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  --ease:cubic-bezier(.2,.9,.25,1.15);
  font-family:var(--sans); font-size:var(--u); color:var(--ink);
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  user-select:none; -webkit-user-select:none;
}
#ui-root *{box-sizing:border-box;margin:0;padding:0;}
#ui-root .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1;}
#ui-root button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;}
#ui-root button:focus-visible{outline:2px solid rgba(232,197,106,.9);outline-offset:2px;}
#ui-root ::-webkit-scrollbar{width:calc(var(--u)*.42);}
#ui-root ::-webkit-scrollbar-track{background:rgba(74,64,52,.09);border-radius:99px;}
#ui-root ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,${T.goldPale},${T.goldDeep});border-radius:99px;}

/* screenshots must catch settled state, never a half-played entrance */
#ui-root.is-shot *,#ui-root.is-shot *::before,#ui-root.is-shot *::after{
  animation-duration:1ms!important;animation-delay:0ms!important;
  transition-duration:1ms!important;transition-delay:0ms!important;
}
#ui-root.is-shot .sk-pulse-only{animation:none!important;}

/* ================= parchment surface ================= */
#ui-root .sk-paper{
  position:relative; color:var(--ink);
  background-color:rgba(243,235,220,.94);
  background-image:
    linear-gradient(180deg,rgba(255,253,246,.78),rgba(255,253,246,0) 26%),
    radial-gradient(130% 80% at 50% -8%,rgba(255,250,235,.85),rgba(243,235,220,0) 62%),
    radial-gradient(120% 70% at 50% 108%,rgba(180,152,110,.13),rgba(243,235,220,0) 58%),
    var(--grain);
  background-size:auto,auto,auto,156px 156px;
  border:1.5px solid var(--border);
  border-radius:3px;
  box-shadow:0 calc(var(--u)*1.3) calc(var(--u)*3.2) rgba(24,14,9,.42),
             0 1px 0 rgba(255,255,255,.5) inset,
             0 -1px 0 rgba(120,96,60,.25) inset;
  backdrop-filter:blur(14px) saturate(1.08);
  -webkit-backdrop-filter:blur(14px) saturate(1.08);
}
#ui-root .sk-paper::before{        /* gold inner keyline, offset 3px */
  content:"";position:absolute;inset:3px;pointer-events:none;border-radius:1px;
  border:1px solid rgba(201,162,39,.62);
  box-shadow:0 0 0 1px rgba(255,255,255,.28) inset;
}
/* four corner layers, each mirrored from the same source SVG */
#ui-root .sk-c{position:absolute;--cs:calc(var(--u)*3.1);width:var(--cs);height:var(--cs);pointer-events:none;
  background:${corner} no-repeat center/var(--cs) var(--cs);opacity:.95;filter:drop-shadow(0 1px 0 rgba(255,255,255,.4));}
#ui-root .sk-c.tl{left:2px;top:2px;}
#ui-root .sk-c.tr{right:2px;top:2px;transform:scaleX(-1);}
#ui-root .sk-c.bl{left:2px;bottom:2px;transform:scaleY(-1);}
#ui-root .sk-c.br{right:2px;bottom:2px;transform:scale(-1,-1);}
#ui-root .sk-c.sm{--cs:calc(var(--u)*1.95);background-image:${cornerSm};}

/* ================= type ================= */
#ui-root .sk-title{font-family:var(--serif);letter-spacing:.16em;font-weight:600;}
#ui-root .sk-kanji{font-family:var(--serif);letter-spacing:.08em;}
#ui-root .sk-flavour{font-family:var(--serif);font-style:italic;color:var(--ink-soft);letter-spacing:.02em;}
#ui-root .sk-dia{display:inline-block;width:calc(var(--u)*.8);height:calc(var(--u)*.8);vertical-align:-.08em;
  background:${dia} no-repeat center/contain;}

/* ================= HUD ================= */
#ui-root .sk-hud{position:absolute;inset:0;pointer-events:none;}
/* readability scrims — Genshin darkens the corners its HUD sits in.
   Kept soft and corner-bound so the tree never loses the frame. */
#ui-root .sk-vig{position:absolute;pointer-events:none;}
#ui-root .sk-vig.tl{left:0;top:0;width:44%;height:38%;
  background:radial-gradient(118% 118% at 0% 0%,rgba(22,10,24,.30),rgba(22,10,24,.12) 44%,rgba(22,10,24,.04) 68%,rgba(22,10,24,0) 82%);}
#ui-root .sk-vig.bt{left:0;right:0;bottom:0;height:15%;
  background:linear-gradient(0deg,rgba(18,9,20,.42),rgba(18,9,20,0));}

/* ---- HUD parchment plate (ART_BIBLE §7).  Every string inside it is dark ink
   on parchment: measured >=4.97:1 for the faintest label, 10.6:1 for the rate
   line.  Before this the HUD was 13 px grey text floating on a lit sky. ---- */
#ui-root .sk-plate{position:absolute;left:calc(var(--u)*1.35);top:calc(var(--u)*1.2);
  width:calc(var(--u)*27.6);pointer-events:none;
  padding:calc(var(--u)*.86) calc(var(--u)*1.0) calc(var(--u)*.8);
  display:flex;flex-direction:column;gap:calc(var(--u)*.5);
  animation:sk-in .34s var(--ease) both;}

#ui-root .sk-bank{display:flex;flex-direction:column;gap:calc(var(--u)*.24);}
#ui-root .sk-bank-row{display:flex;align-items:center;gap:calc(var(--u)*.55);}
#ui-root .sk-bank-icon{width:calc(var(--u)*2.05);height:calc(var(--u)*2.05);flex:0 0 auto;
  background:${blossomIcon(28)} no-repeat center/contain;
  filter:drop-shadow(0 1px 2px rgba(120,70,96,.5));
  animation:sk-breathe 5.5s ease-in-out infinite;}
#ui-root .sk-bank-val{font-family:var(--serif);font-size:calc(var(--u)*2.3);line-height:1;
  color:#33291E;letter-spacing:.01em;font-weight:600;
  text-shadow:0 1px 0 rgba(255,255,255,.7);}
#ui-root .sk-bank-unit{font-size:var(--t-sec);letter-spacing:.24em;color:${T.inkFaint};
  font-family:var(--serif);align-self:flex-end;padding-bottom:calc(var(--u)*.2);}
#ui-root .sk-bank-sub{display:flex;gap:calc(var(--u)*.3) calc(var(--u)*.62);align-items:center;flex-wrap:wrap;
  font-size:calc(var(--u)*1.21);color:${T.ink};letter-spacing:.01em;line-height:1.18;}
#ui-root .sk-bank-sub>span{display:flex;align-items:baseline;gap:.32em;white-space:nowrap;}
#ui-root .sk-bank-sub b{font-weight:600;color:#2F2618;font-family:var(--serif);}
#ui-root .sk-bank-sub em{font-style:normal;font-size:var(--t-sec);color:${T.inkFaint};letter-spacing:.05em;}
#ui-root .sk-bank-sub .sep{width:1px;height:calc(var(--u)*1.0);background:rgba(74,64,52,.3);}

#ui-root .sk-chips{display:flex;gap:calc(var(--u)*.42);flex-wrap:wrap;}
#ui-root .sk-chip{display:flex;align-items:center;gap:calc(var(--u)*.34);
  padding:calc(var(--u)*.2) calc(var(--u)*.62) calc(var(--u)*.2) calc(var(--u)*.3);
  border-radius:99px;
  background:linear-gradient(180deg,rgba(255,251,240,.9),rgba(224,210,184,.82));
  border:1px solid rgba(74,64,52,.42);
  box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 -2px 4px rgba(120,96,60,.16) inset,0 1px 3px rgba(50,36,20,.16);}
#ui-root .sk-chip i{width:calc(var(--u)*1.1);height:calc(var(--u)*1.1);background-repeat:no-repeat;background-position:center;background-size:contain;
  filter:drop-shadow(0 1px 1px rgba(80,60,20,.35));}
#ui-root .sk-chip.blossom i{background-image:${sealIcon(22)};}
#ui-root .sk-chip.essence i{background-image:${essenceIcon(22)};}
#ui-root .sk-chip span{font-size:var(--t-sec);color:#3E3425;letter-spacing:.04em;font-weight:600;}

/* --- bloom stage --- */
#ui-root .sk-stage{display:flex;flex-direction:column;}
#ui-root .sk-stage-head{display:flex;align-items:baseline;gap:calc(var(--u)*.5);}
#ui-root .sk-stage-k{font-family:var(--serif);font-size:calc(var(--u)*1.34);color:#33291E;letter-spacing:.1em;}
#ui-root .sk-stage-n{font-family:var(--serif);font-size:calc(var(--u)*.96);color:${T.inkSoft};letter-spacing:.18em;text-transform:uppercase;}
#ui-root .sk-stage-i{margin-left:auto;font-size:calc(var(--u)*.95);color:${T.goldInk};letter-spacing:.16em;font-weight:700;}
#ui-root .sk-bar{position:relative;height:calc(var(--u)*.56);margin-top:calc(var(--u)*.42);
  border-radius:99px;background:linear-gradient(180deg,rgba(16,10,20,.62),rgba(30,20,36,.5));
  border:1px solid rgba(232,197,106,.34);overflow:hidden;
  box-shadow:0 1px 4px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.12) inset;}
#ui-root .sk-bar>i{position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:99px;
  background:linear-gradient(90deg,${T.petalDeep},${T.petalMid} 55%,#FFF0F5);
  box-shadow:0 0 calc(var(--u)*.7) rgba(255,168,205,.75);
  transition:width .5s cubic-bezier(.25,.8,.3,1);}
#ui-root .sk-bar>u{position:absolute;top:0;bottom:0;width:calc(var(--u)*1.6);border-radius:99px;
  background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.55),rgba(255,255,255,0));
  animation:sk-sheen 2.6s linear infinite;}

/* --- the bloom progression capsule: 10 px tall, one tick per stage threshold,
       a glowing head at the current position.  Was a 2 px hairline. --- */
#ui-root .sk-sbar{position:relative;height:calc(var(--u)*.76);margin-top:calc(var(--u)*.46);
  border-radius:99px;overflow:hidden;
  background:linear-gradient(180deg,rgba(96,80,58,.34),rgba(150,132,102,.2));
  border:1px solid rgba(74,64,52,.5);
  box-shadow:0 2px 4px rgba(60,44,26,.3) inset,0 1px 0 rgba(255,255,255,.6);}
#ui-root .sk-sbar>i{position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:99px;
  background:linear-gradient(90deg,${T.petalDeep} 0%,${T.petalShadow} 38%,${T.petalMid} 74%,#FFF2F7 100%);
  box-shadow:0 0 calc(var(--u)*.5) rgba(255,150,195,.85),0 1px 0 rgba(255,255,255,.45) inset;
  transition:width .5s cubic-bezier(.25,.8,.3,1);}
#ui-root .sk-sbar>i::after{content:"";position:absolute;right:calc(var(--u)*-.16);top:50%;
  width:calc(var(--u)*.5);height:calc(var(--u)*.5);margin-top:calc(var(--u)*-.25);border-radius:99px;
  background:radial-gradient(circle at 40% 34%,#FFFFFF,#FFD6E7 55%,#EE8CAF);
  box-shadow:0 0 calc(var(--u)*.7) rgba(255,170,205,1);}
#ui-root .sk-sbar>u{position:absolute;top:0;bottom:0;width:1px;
  background:rgba(58,50,42,.55);box-shadow:1px 0 0 rgba(255,255,255,.42);}
#ui-root .sk-sbar>u.done{background:${T.goldInk};box-shadow:1px 0 0 rgba(255,240,190,.6);}
#ui-root .sk-stage-foot{display:flex;justify-content:space-between;margin-top:calc(var(--u)*.34);
  font-size:var(--t-sec);color:${T.inkSoft};letter-spacing:.05em;}
#ui-root .sk-stage-foot span:last-child{color:${T.goldInk};font-weight:600;}

/* --- shake readout, bottom centre --- */
#ui-root .sk-shake{position:absolute;left:calc(50% - var(--rail)*0.5);bottom:calc(var(--u)*1.5);transform:translateX(-50%);
  display:flex;align-items:center;gap:calc(var(--u)*.7);padding:calc(var(--u)*.38) calc(var(--u)*1.15);
  border-radius:99px;background:linear-gradient(180deg,rgba(26,18,32,.70),rgba(12,7,18,.80));
  border:1px solid rgba(232,197,106,.42);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  box-shadow:0 4px 16px rgba(0,0,0,.42);pointer-events:auto;
  animation:sk-in .34s .16s var(--ease) both;}
#ui-root .sk-shake kbd{font-family:var(--sans);font-size:var(--t-sec);letter-spacing:.14em;
  padding:calc(var(--u)*.14) calc(var(--u)*.52);border-radius:3px;color:#2B2118;font-weight:700;
  background:linear-gradient(180deg,${T.goldHi},${T.goldLo});border:1px solid rgba(90,64,16,.6);
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset;}
#ui-root .sk-shake span{font-size:calc(var(--u)*.92);color:rgba(255,242,246,.96);letter-spacing:.1em;}
#ui-root .sk-shake b{font-family:var(--serif);color:#FFE6B8;font-size:calc(var(--u)*1.0);}
#ui-root .sk-shake:hover{border-color:rgba(232,197,106,.6);}

/* --- live event banner --- */
#ui-root .sk-event{position:absolute;left:calc(50% - var(--rail)*0.5);top:calc(var(--u)*1.5);transform:translateX(-50%);
  min-width:calc(var(--u)*22);padding:calc(var(--u)*.5) calc(var(--u)*2.3) calc(var(--u)*.55);
  text-align:center;pointer-events:none;
  background:linear-gradient(180deg,rgba(58,32,22,.68),rgba(30,16,14,.58));
  border-top:1px solid rgba(232,197,106,.75);border-bottom:1px solid rgba(232,197,106,.5);
  box-shadow:0 6px 26px rgba(0,0,0,.42),0 0 calc(var(--u)*2) rgba(232,180,90,.22) inset;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  clip-path:polygon(calc(var(--u)*1.4) 0,calc(100% - var(--u)*1.4) 0,100% 50%,calc(100% - var(--u)*1.4) 100%,calc(var(--u)*1.4) 100%,0 50%);
  animation:sk-banner .42s var(--ease) both;}
#ui-root .sk-event-t{font-family:var(--serif);font-size:calc(var(--u)*1.18);letter-spacing:.2em;
  color:#FFE9C0;text-shadow:0 0 calc(var(--u)*1.1) rgba(255,190,110,.7);}
#ui-root .sk-event-t em{font-style:normal;color:#FFF6E2;margin-right:.5em;}
#ui-root .sk-event-d{font-size:calc(var(--u)*.76);letter-spacing:.12em;color:rgba(255,226,196,.82);margin-top:calc(var(--u)*.1);}
#ui-root .sk-event-bar{position:absolute;left:12%;right:12%;bottom:calc(var(--u)*.16);height:2px;background:rgba(255,220,170,.22);}
#ui-root .sk-event-bar>i{display:block;height:100%;background:linear-gradient(90deg,#FFD79A,#FFF3DC);box-shadow:0 0 6px rgba(255,205,130,.9);}

/* ================= toasts ================= */
#ui-root .sk-toasts{position:absolute;right:calc(var(--rail) + var(--u)*1.0);top:calc(var(--u)*1.4);
  display:flex;flex-direction:column;gap:calc(var(--u)*.5);align-items:flex-end;z-index:3;}
#ui-root .sk-toast{position:relative;display:flex;align-items:center;gap:calc(var(--u)*.7);
  padding:calc(var(--u)*.62) calc(var(--u)*1.1) calc(var(--u)*.62) calc(var(--u)*.9);
  min-width:calc(var(--u)*17);max-width:calc(var(--u)*24);
  animation:sk-toast-in .4s var(--ease) both;}
#ui-root .sk-toast .glyph{width:calc(var(--u)*2.1);height:calc(var(--u)*2.1);flex:0 0 auto;
  background:${sealIcon(28)} no-repeat center/contain;filter:drop-shadow(0 0 calc(var(--u)*.5) rgba(232,197,106,.8));}
#ui-root .sk-toast .cap{font-size:var(--t-sec);letter-spacing:.22em;color:${T.goldInk};text-transform:uppercase;font-weight:600;}
#ui-root .sk-toast .nm{font-family:var(--serif);font-size:calc(var(--u)*1.0);letter-spacing:.06em;color:var(--ink);}
#ui-root .sk-toast .rw{font-size:var(--t-sec);color:var(--ink-soft);}
#ui-root .sk-toast::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(105deg,rgba(255,255,255,0) 38%,rgba(255,246,214,.75) 50%,rgba(255,255,255,0) 62%);
  background-size:260% 100%;animation:sk-shine 1.05s .12s ease-out 1 both;}

/* ================= right rail ================= */
#ui-root .sk-rail{position:absolute;right:0;top:0;bottom:0;width:var(--rail);
  display:flex;align-items:flex-start;justify-content:flex-end;
  padding:calc(var(--u)*1.2) calc(var(--u)*1.1) calc(var(--u)*1.2) 0;gap:calc(var(--u)*.55);pointer-events:none;}
#ui-root .sk-tabs{display:flex;flex-direction:column;gap:calc(var(--u)*.42);
  align-self:flex-start;margin-top:calc(var(--u)*1.4);pointer-events:auto;}
#ui-root .sk-tab{position:relative;width:calc(var(--u)*2.55);height:calc(var(--u)*3.5);
  display:grid;place-items:center;border-radius:3px;
  background:linear-gradient(180deg,rgba(38,26,22,.62),rgba(20,13,12,.72));
  border:1px solid rgba(232,197,106,.3);color:rgba(246,232,204,.7);
  font-family:var(--serif);font-size:calc(var(--u)*1.12);letter-spacing:0;
  box-shadow:0 2px 10px rgba(0,0,0,.34);
  transition:transform .16s var(--ease),background .16s ease,border-color .16s ease,color .16s ease;
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
#ui-root .sk-tab:hover{transform:translateX(-2px);color:#FFF0CE;border-color:rgba(232,197,106,.7);}
#ui-root .sk-tab.on{background:linear-gradient(180deg,${T.goldHi},${T.goldLo});color:#2E2318;
  border-color:#7A5A18;box-shadow:0 2px 12px rgba(0,0,0,.4),0 0 calc(var(--u)*1.1) rgba(232,197,106,.5),0 1px 0 rgba(255,255,255,.6) inset;}
#ui-root .sk-tab .dot{position:absolute;right:calc(var(--u)*.22);top:calc(var(--u)*.22);
  width:calc(var(--u)*.42);height:calc(var(--u)*.42);border-radius:99px;background:${T.petalMid};
  box-shadow:0 0 calc(var(--u)*.5) ${T.petalShadow};animation:sk-blip 1.6s ease-in-out infinite;}
#ui-root .sk-tab.on .dot{display:none;}

#ui-root .sk-panel{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;pointer-events:auto;
  max-height:100%;overflow:hidden;animation:sk-panel-in .26s var(--ease) both;}
#ui-root .sk-panel-head{position:relative;flex:0 0 auto;padding:calc(var(--u)*1.05) calc(var(--u)*1.5) calc(var(--u)*.5);text-align:center;}
#ui-root .sk-panel-head h2{font-family:var(--serif);font-size:calc(var(--u)*1.22);letter-spacing:.3em;
  color:#2F281F;text-indent:.3em;}
#ui-root .sk-panel-head .kj{font-family:var(--serif);font-size:calc(var(--u)*.88);letter-spacing:.5em;
  color:${T.goldInk};text-indent:.5em;margin-top:calc(var(--u)*.14);}
#ui-root .sk-panel-head .fl{height:12px;margin:calc(var(--u)*.44) auto 0;width:82%;
  background:${flourish} no-repeat center/100% 12px;opacity:.95;}
#ui-root .sk-panel-head .fl.mirror{transform:scaleX(-1);}
#ui-root .sk-rule{height:6px;flex:0 0 auto;margin:calc(var(--u)*.1) calc(var(--u)*1.2);
  background:${rule} no-repeat center/100% 6px;}
/* flex:0 1 auto — the body sizes to its content, so a fresh save shows a panel
   the height of the rows it actually has instead of a tall dead parchment field */
#ui-root .sk-panel-body{flex:0 1 auto;overflow-y:auto;overflow-x:hidden;
  padding:calc(var(--u)*.6) calc(var(--u)*.9) calc(var(--u)*.5);
  scrollbar-width:thin;}
#ui-root .sk-panel-foot{flex:0 0 auto;padding:calc(var(--u)*.6) calc(var(--u)*3.2) calc(var(--u)*.9);
  display:flex;gap:calc(var(--u)*.5);align-items:center;justify-content:space-between;
  border-top:1px solid rgba(74,64,52,.18);}
#ui-root .sk-hint{font-size:var(--t-sec);color:var(--ink-faint);letter-spacing:.06em;}

/* ================= tender cards ================= */
#ui-root .sk-card{position:relative;display:grid;
  grid-template-columns:calc(var(--u)*2.9) minmax(0,1fr) auto;gap:0 calc(var(--u)*.62);
  align-items:center;overflow:hidden;
  padding:calc(var(--u)*.46) calc(var(--u)*.6) calc(var(--u)*.46) calc(var(--u)*.72);
  margin-bottom:calc(var(--u)*.4);
  border-radius:3px;border:1px solid rgba(74,64,52,.34);
  background-image:linear-gradient(180deg,rgba(255,252,244,.74),rgba(232,220,198,.52));
  box-shadow:0 1px 0 rgba(255,255,255,.6) inset,0 1px 3px rgba(60,44,26,.16);
  transition:transform .14s var(--ease),box-shadow .16s ease,border-color .16s ease;
  cursor:pointer;}
/* ---- rarity as a GRADIENT CARD BACKGROUND (§7), not a hairline hint ----
   The r2 review measured a 3-star row and a 5-star row 5.6 deg apart in mean
   hue and 0.008 apart in saturation: with the wash confined to a 56%-wide
   corner it was invisible at 1080p. The wash now runs top-to-bottom over the
   whole card at ~.30 -> .05, which is what actually separates the tiers.
   Blue is nearly opposite parchment on the wheel, so the 3-star card lands
   cool and the 5-star card lands warm — a large, readable split. */
#ui-root .sk-card.r3{background-image:
  linear-gradient(180deg,rgba(64,132,198,.34) 0%,rgba(70,134,196,.19) 44%,rgba(76,139,201,.07) 100%),
  linear-gradient(101deg,rgba(48,116,186,.24) 0%,rgba(76,139,201,.04) 58%,rgba(76,139,201,0) 100%),
  linear-gradient(180deg,rgba(255,252,244,.8),rgba(228,220,206,.58));}
#ui-root .sk-card.r4{background-image:
  linear-gradient(180deg,rgba(158,112,220,.34) 0%,rgba(162,119,221,.19) 44%,rgba(162,119,221,.07) 100%),
  linear-gradient(101deg,rgba(140,92,208,.24) 0%,rgba(162,119,221,.04) 58%,rgba(162,119,221,0) 100%),
  linear-gradient(180deg,rgba(255,252,244,.8),rgba(230,220,208,.58));}
#ui-root .sk-card.r5{background-image:
  linear-gradient(180deg,rgba(216,162,58,.42) 0%,rgba(213,165,74,.24) 44%,rgba(213,165,74,.09) 100%),
  linear-gradient(101deg,rgba(206,150,42,.28) 0%,rgba(213,165,74,.05) 58%,rgba(213,165,74,0) 100%),
  linear-gradient(180deg,rgba(255,252,238,.82),rgba(238,224,190,.6));}
#ui-root .sk-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:calc(var(--u)*.24);z-index:1;
  background:linear-gradient(180deg,rgba(120,104,80,.5),rgba(90,76,54,.75));
  box-shadow:1px 0 0 rgba(255,255,255,.35);}
#ui-root .sk-card.r3::before{background:linear-gradient(180deg,#8FBEE8,#3B6E9F 55%,#24486C);}
#ui-root .sk-card.r4::before{background:linear-gradient(180deg,#C7A8F0,#7E52B6 55%,#4A2F76);}
#ui-root .sk-card.r5::before{background:linear-gradient(180deg,#F7E4AE,#C08F2C 55%,#7C5510);}
/* tier-coloured inner keyline, offset 2 px — replaces the generic gold */
#ui-root .sk-card::after{content:"";position:absolute;inset:2px;pointer-events:none;border-radius:2px;
  border:1px solid rgba(74,64,52,.18);}
#ui-root .sk-card.r3::after{border-color:rgba(44,96,156,.5);box-shadow:0 0 0 1px rgba(255,255,255,.3) inset;}
#ui-root .sk-card.r4::after{border-color:rgba(104,66,164,.5);box-shadow:0 0 0 1px rgba(255,255,255,.3) inset;}
#ui-root .sk-card.r5::after{border-color:rgba(160,112,26,.62);box-shadow:0 0 0 1px rgba(255,248,220,.4) inset;}
#ui-root .sk-card:hover{transform:translateY(-1px);border-color:rgba(74,64,52,.58);
  box-shadow:0 3px 12px rgba(60,40,20,.24),0 1px 0 rgba(255,255,255,.7) inset;}
#ui-root .sk-card:active{transform:translateY(1px) scale(.996);}
#ui-root .sk-card.buy{border-color:rgba(184,138,48,.9);
  box-shadow:0 0 0 1px rgba(232,197,106,.5),0 2px 10px rgba(150,110,30,.26),0 1px 0 rgba(255,255,255,.78) inset;}
#ui-root .sk-card.poor{filter:saturate(.72);}
#ui-root .sk-card.reveal{animation:sk-flip .56s var(--ease) both;}
/* ---- rarity icon chip.  Two-stop tier gradient, a 1 px dark border with a
       3 px gold inner keyline, an embossed blossom watermark so it is never a
       flat single-colour square, and the same drop shadow the buy button uses. */
#ui-root .sk-card .ico{grid-column:1;grid-row:1/4;align-self:center;
  width:calc(var(--u)*2.9);height:calc(var(--u)*2.9);
  border-radius:3px;display:grid;place-items:center;position:relative;
  font-family:var(--serif);font-size:calc(var(--u)*1.36);color:#FFF6E4;
  background:linear-gradient(155deg,#9A7855 0%,#6A4F38 46%,#3A2B20 100%);
  border:1px solid ${T.border};
  box-shadow:0 1px 0 rgba(255,255,255,.3) inset,0 -6px 12px rgba(0,0,0,.36) inset,
             0 2px 5px rgba(30,20,8,.46),0 1px 0 rgba(255,255,255,.34);
  text-shadow:0 1px 2px rgba(0,0,0,.6),0 0 calc(var(--u)*.5) rgba(0,0,0,.35);}
#ui-root .sk-card .ico::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:${mark} no-repeat center/72% 72%;opacity:.14;mix-blend-mode:overlay;}
#ui-root .sk-card .ico::after{content:"";position:absolute;inset:3px;pointer-events:none;border-radius:1px;
  border:1px solid rgba(232,197,106,.62);
  box-shadow:0 0 0 1px rgba(0,0,0,.28) inset;}
#ui-root .sk-card.r3 .ico{background:linear-gradient(155deg,#7FA6D2 0%,#2F5580 52%,#16304C 100%);}
#ui-root .sk-card.r4 .ico{background:linear-gradient(155deg,#A98BD6 0%,#553784 52%,#2B1A46 100%);}
#ui-root .sk-card.r5 .ico{background:linear-gradient(155deg,#EBCE86 0%,#A87C2A 52%,#57400F 100%);}
#ui-root .sk-card.r5 .ico{color:#FFFDF2;}
#ui-root .sk-card.r5 .ico::after{border-color:rgba(255,240,196,.72);}
#ui-root .sk-card .ico b{position:absolute;right:-1px;bottom:-1px;
  font-family:var(--sans);font-size:calc(var(--u)*.7);font-weight:700;color:#2E2318;
  padding:0 calc(var(--u)*.28);border-radius:3px 0 2px 0;
  background:linear-gradient(180deg,${T.goldHi},${T.goldLo});border:1px solid rgba(90,64,16,.7);}
#ui-root .sk-card .nm{grid-column:2;grid-row:1;display:flex;align-items:center;gap:calc(var(--u)*.36);min-width:0;}
#ui-root .sk-card .nm h3{font-family:var(--serif);font-size:calc(var(--u)*1.0);font-weight:600;
  letter-spacing:.05em;color:#2F2820;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ui-root .sk-card .nm em{font-style:normal;font-family:var(--serif);font-size:calc(var(--u)*.82);
  color:${T.goldInk};letter-spacing:.08em;white-space:nowrap;}
#ui-root .sk-card .nm .sk-stars{margin-left:auto;flex:0 0 auto;}
#ui-root .sk-card .out{grid-column:2;grid-row:2;font-size:var(--t-sec);color:${T.inkSoft};letter-spacing:.02em;
  line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ui-root .sk-card .out i{font-style:normal;color:#3D6633;font-weight:700;}
#ui-root .sk-card .out u{text-decoration:none;color:#4A3C22;font-weight:600;}
#ui-root .sk-mini{grid-column:2/4;grid-row:3;margin-top:calc(var(--u)*.26);display:flex;align-items:center;gap:calc(var(--u)*.45);}
#ui-root .sk-mini .track{position:relative;flex:1 1 auto;height:calc(var(--u)*.34);border-radius:99px;
  background:linear-gradient(180deg,rgba(74,64,52,.3),rgba(74,64,52,.16));overflow:hidden;
  box-shadow:0 1px 2px rgba(60,44,26,.24) inset,0 1px 0 rgba(255,255,255,.55);}
#ui-root .sk-mini .track>i{position:absolute;inset:0 auto 0 0;width:0%;border-radius:99px;
  background:linear-gradient(90deg,${T.goldDeep},${T.goldPale});
  box-shadow:0 1px 0 rgba(255,255,255,.4) inset;transition:width .4s ease;}
#ui-root .sk-mini .lb{font-size:var(--t-sec);color:${T.inkFaint};letter-spacing:.04em;white-space:nowrap;}
#ui-root .sk-mini .lb b{color:${T.goldInk};font-weight:700;}

/* ---- the purchase button (ART_BIBLE §7).  Before this the only affordance on
       a Tender row was a cost string; a clicker with no button is not a game. ---- */
#ui-root .sk-buy{position:relative;grid-column:3;grid-row:1/3;align-self:center;
  display:flex;align-items:center;justify-content:center;gap:calc(var(--u)*.34);
  min-width:134px;min-height:34px;padding:0 calc(var(--u)*.58);
  border-radius:3px;overflow:hidden;pointer-events:auto;
  background:linear-gradient(180deg,${T.goldHi} 0%,#E3C270 40%,${T.goldLo} 100%);
  border:1px solid #7A5A18;
  box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 -3px 7px rgba(120,84,16,.34) inset,
             0 2px 6px rgba(40,26,6,.32);
  transition:transform 70ms var(--ease),box-shadow 70ms ease,filter 70ms ease;}
#ui-root .sk-buy .gl{position:absolute;left:1px;right:1px;top:0;height:46%;pointer-events:none;
  border-radius:2px 2px 40% 40%/2px 2px 100% 100%;
  background:linear-gradient(180deg,rgba(255,253,235,.62),rgba(255,253,235,0));}
#ui-root .sk-buy.sm{padding:0 calc(var(--u)*.48);gap:calc(var(--u)*.28);}
#ui-root .sk-buy.sm .v{font-size:calc(var(--u)*.94);}
#ui-root .sk-buy .v{position:relative;font-family:var(--serif);font-size:calc(var(--u)*1.02);
  color:#2E2318;line-height:1;font-weight:600;text-shadow:0 1px 0 rgba(255,248,214,.55);}
#ui-root .sk-buy .x{position:relative;font-size:calc(var(--u)*.72);font-weight:700;color:#5E4108;
  letter-spacing:.04em;padding:1px calc(var(--u)*.28);border-radius:2px;
  background:rgba(255,250,226,.7);border:1px solid rgba(122,90,24,.5);
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset;}
#ui-root .sk-buy:hover{transform:translateY(-1px);filter:brightness(1.05);
  box-shadow:0 1px 0 rgba(255,255,255,.78) inset,0 -3px 7px rgba(120,84,16,.3) inset,
             0 4px 12px rgba(40,26,6,.34),0 0 calc(var(--u)*1.3) rgba(232,197,106,.8);}
#ui-root .sk-buy:active{transform:translateY(1px);
  box-shadow:0 3px 6px rgba(90,62,10,.5) inset,0 1px 2px rgba(40,26,6,.22);}
#ui-root .sk-card.buy .sk-buy{animation:sk-afford 2.2s ease-in-out infinite;}
/* unaffordable: still a real pressable control, just inset and cool */
#ui-root .sk-card.poor .sk-buy{
  background:linear-gradient(180deg,rgba(230,216,184,.95),rgba(196,180,146,.92));
  border-color:rgba(110,84,30,.65);
  box-shadow:0 2px 5px rgba(60,44,26,.3) inset,0 1px 0 rgba(255,255,255,.55);}
#ui-root .sk-card.poor .sk-buy .gl{background:linear-gradient(180deg,rgba(255,255,250,.4),rgba(255,255,250,0));}
#ui-root .sk-card.poor .sk-buy .v{color:#6E3225;text-shadow:0 1px 0 rgba(255,255,255,.45);}
#ui-root .sk-card.poor .sk-buy .x{color:#5A4B36;background:rgba(255,253,246,.55);border-color:rgba(74,64,52,.4);}

/* ---- next-unlock row: a SEALED SCROLL, not a disabled fieldset.
       The r2 review read the old grey diagonal-hatched rectangle as HTML chrome.
       This is dimmed parchment at 78%, a gold wax-seal medallion where the '?'
       square was, and no hatching or grey anywhere. ---- */
#ui-root .sk-teaser{position:relative;display:grid;
  grid-template-columns:calc(var(--u)*3.1) minmax(0,1fr);gap:0 calc(var(--u)*.72);
  align-items:center;overflow:hidden;opacity:.78;
  padding:calc(var(--u)*.62) calc(var(--u)*.7) calc(var(--u)*.62) calc(var(--u)*.8);
  border-radius:3px;border:1px solid rgba(74,64,52,.34);
  background-image:
    radial-gradient(120% 150% at 8% 50%,rgba(201,162,39,.16),rgba(201,162,39,0) 58%),
    linear-gradient(180deg,rgba(252,246,232,.72),rgba(226,214,190,.6));
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 1px 3px rgba(60,44,26,.14);}
/* the rolled edges of the scroll, top and bottom — replaces the dashed border */
#ui-root .sk-teaser::before,#ui-root .sk-teaser::after{content:"";position:absolute;left:0;right:0;
  height:calc(var(--u)*.34);pointer-events:none;}
#ui-root .sk-teaser::before{top:0;background:linear-gradient(180deg,rgba(160,132,84,.32),rgba(160,132,84,0));}
#ui-root .sk-teaser::after{bottom:0;background:linear-gradient(0deg,rgba(160,132,84,.32),rgba(160,132,84,0));}
#ui-root .sk-teaser .seal{grid-column:1;grid-row:1/3;align-self:center;
  width:calc(var(--u)*3.1);height:calc(var(--u)*3.1);
  background:${seal} no-repeat center/contain;
  filter:drop-shadow(0 2px 3px rgba(60,40,10,.45));}
#ui-root .sk-teaser h3{grid-column:2;font-family:var(--serif);font-size:calc(var(--u)*.94);
  letter-spacing:.34em;color:${T.goldInk};text-transform:uppercase;}
#ui-root .sk-teaser .tx{grid-column:2;font-family:var(--serif);font-style:italic;
  font-size:calc(var(--u)*.9);color:${T.inkSoft};line-height:1.42;
  margin-top:calc(var(--u)*.2);}
#ui-root .sk-teaser .tx b{font-style:normal;color:${T.goldInk};font-weight:700;}

/* ---- band rule: a tapered hairline + centre rhombus at every rarity band, so a
       ten-row panel has rhythm instead of ten identical 78 px stripes ---- */
#ui-root .sk-gdiv{position:relative;height:10px;
  margin:calc(var(--u)*.46) calc(var(--u)*1.5) calc(var(--u)*.6);
  background:${brule} no-repeat center/100% 10px;}
#ui-root .sk-gdiv::after{content:"";position:absolute;left:50%;top:0;
  width:calc(var(--u)*.72);height:calc(var(--u)*.72);margin-left:calc(var(--u)*-.36);
  transform:translateY(calc(var(--u)*-.06));
  background:${dia} no-repeat center/contain;
  filter:drop-shadow(0 1px 0 rgba(255,255,255,.6));}

/* ================= upgrade rows ================= */
#ui-root .sk-fam{margin:calc(var(--u)*.5) 0 calc(var(--u)*.3);display:flex;align-items:center;gap:calc(var(--u)*.5);}
#ui-root .sk-fam .d{width:9px;height:9px;background:${diaInk} no-repeat center/contain;}
#ui-root .sk-fam h4{font-family:var(--serif);font-size:calc(var(--u)*.94);letter-spacing:.3em;
  color:${T.goldInk};text-transform:uppercase;}
#ui-root .sk-fam .ln{flex:1 1 auto;height:1px;background:linear-gradient(90deg,rgba(74,64,52,.35),rgba(74,64,52,0));}
#ui-root .sk-up{position:relative;display:grid;grid-template-columns:calc(var(--u)*2.3) 1fr auto;
  gap:0 calc(var(--u)*.62);align-items:center;padding:calc(var(--u)*.48) calc(var(--u)*.62);
  margin-bottom:calc(var(--u)*.38);border-radius:2px;cursor:pointer;
  border:1px solid rgba(74,64,52,.24);background:linear-gradient(180deg,rgba(255,252,244,.6),rgba(233,222,201,.42));
  transition:transform .14s var(--ease),border-color .16s ease,background .16s ease;}
#ui-root .sk-up:hover{transform:translateY(-1px);border-color:rgba(74,64,52,.48);}
#ui-root .sk-up.buy{border-color:rgba(184,138,48,.8);background:linear-gradient(180deg,rgba(255,249,226,.88),rgba(246,229,186,.62));
  animation:sk-afford 2.2s ease-in-out infinite;}
#ui-root .sk-up.poor{opacity:.66;filter:saturate(.55);}
#ui-root .sk-up.own{opacity:.58;filter:saturate(.35);cursor:default;}
#ui-root .sk-up.own:hover{transform:none;}
#ui-root .sk-up .g{grid-column:1;grid-row:1/3;align-self:center;width:calc(var(--u)*2.3);height:calc(var(--u)*2.3);border-radius:99px;
  display:grid;place-items:center;font-family:var(--serif);font-size:calc(var(--u)*1.05);color:#FFF3DC;
  background:radial-gradient(120% 120% at 30% 20%,#8E6E4E,#4A3626);
  border:1px solid rgba(60,44,28,.7);box-shadow:0 1px 0 rgba(255,255,255,.25) inset;}
#ui-root .sk-up.fam-shake .g{background:radial-gradient(120% 120% at 30% 20%,#C77A86,#7E3A4C);}
#ui-root .sk-up.fam-tender .g{background:radial-gradient(120% 120% at 30% 20%,#7F9A5C,#3E5C34);}
#ui-root .sk-up.fam-grove .g{background:radial-gradient(120% 120% at 30% 20%,#6E86B4,#33456E);}
#ui-root .sk-up h3{grid-column:2;grid-row:1;font-family:var(--serif);font-size:calc(var(--u)*.96);letter-spacing:.05em;color:#332B22;}
#ui-root .sk-up .fv{grid-column:2;grid-row:2;font-family:var(--serif);font-style:italic;font-size:var(--t-sec);
  color:var(--ink-soft);line-height:1.35;margin-top:calc(var(--u)*.1);}
#ui-root .sk-up .sk-buy{grid-column:3;grid-row:1/3;min-width:134px;min-height:34px;}
#ui-root .sk-up.buy .sk-buy{animation:sk-afford 2.2s ease-in-out infinite;}
#ui-root .sk-up.poor .sk-buy{
  background:linear-gradient(180deg,rgba(230,216,184,.95),rgba(196,180,146,.92));
  border-color:rgba(110,84,30,.65);
  box-shadow:0 2px 5px rgba(60,44,26,.3) inset,0 1px 0 rgba(255,255,255,.55);}
#ui-root .sk-up.poor .sk-buy .v{color:#6E3225;}
#ui-root .sk-up.poor .sk-buy .x{color:#5A4B36;background:rgba(255,253,246,.55);border-color:rgba(74,64,52,.4);}

/* ================= centred overlay ================= */
#ui-root .sk-scrim{position:absolute;inset:0;display:grid;place-items:center;pointer-events:auto;
  background:radial-gradient(120% 90% at 50% 46%,rgba(14,8,18,.22),rgba(10,6,14,.52));
  backdrop-filter:blur(5px) saturate(.95);-webkit-backdrop-filter:blur(5px) saturate(.95);
  animation:sk-fade .22s ease both;z-index:4;}
#ui-root .sk-modal{width:min(58vw,calc(var(--u)*54));max-height:82vh;display:flex;flex-direction:column;
  animation:sk-modal-in .3s var(--ease) both;}
#ui-root .sk-modal.wide{width:min(66vw,calc(var(--u)*64));}
#ui-root .sk-x{position:absolute;right:calc(var(--u)*.55);top:calc(var(--u)*.55);
  width:calc(var(--u)*1.7);height:calc(var(--u)*1.7);border-radius:99px;display:grid;place-items:center;
  font-size:calc(var(--u)*.9);color:${T.inkSoft};border:1px solid rgba(74,64,52,.3);
  background:linear-gradient(180deg,rgba(255,252,244,.8),rgba(226,214,192,.6));z-index:2;
  transition:transform .14s var(--ease),color .14s ease;}
#ui-root .sk-x:hover{transform:rotate(90deg);color:${T.no};}

/* ================= rarity / codex cards ================= */
#ui-root .sk-codex{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:calc(var(--u)*.55);}
#ui-root .sk-rc{position:relative;aspect-ratio:.80;border-radius:3px;overflow:hidden;cursor:pointer;
  border:1px solid rgba(50,38,24,.72);
  box-shadow:0 3px 12px rgba(30,20,10,.34),0 1px 0 rgba(255,255,255,.3) inset;
  transform-style:preserve-3d;transition:transform .18s var(--ease),box-shadow .18s ease;}
#ui-root .sk-rc:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 8px 22px rgba(30,20,10,.44);}
/* the nameplate hides the bottom 36%, so the saturated part of each rarity
   gradient has to land inside the top 64% or the cards read washed out */
#ui-root .sk-rc.r3{background:linear-gradient(168deg,#7FAEDC 0%,#4C8BC9 26%,#2A5E96 56%,#1B3E64 100%);}
#ui-root .sk-rc.r4{background:linear-gradient(168deg,#C4A4EE 0%,#A277DD 26%,#6B47A4 56%,#3F2868 100%);}
#ui-root .sk-rc.r5{background:linear-gradient(168deg,#F6E3AC 0%,#D5A54A 26%,#A2701F 56%,#6A4610 100%);}
#ui-root .sk-rc.locked{background:linear-gradient(168deg,#8A857A 0%,#5E5A52 30%,#3C3934 64%,#2A2824 100%);filter:saturate(.2);}
#ui-root .sk-rc .art{position:absolute;left:0;right:0;top:0;height:64%;display:grid;place-items:center;
  font-family:var(--serif);font-size:calc(var(--u)*2.5);color:rgba(255,255,255,.96);
  text-shadow:0 2px 8px rgba(0,0,0,.35),0 0 calc(var(--u)*1.4) rgba(255,255,255,.35);}
#ui-root .sk-rc .art::before{content:"";position:absolute;inset:0;
  background:radial-gradient(66% 56% at 50% 34%,rgba(255,255,255,.24),rgba(255,255,255,0) 70%);}
#ui-root .sk-rc.locked .art{color:rgba(255,255,255,.28);text-shadow:none;}
#ui-root .sk-rc .nameplate{position:absolute;left:0;right:0;bottom:0;height:36%;
  padding:calc(var(--u)*.34) calc(var(--u)*.4);
  background:linear-gradient(180deg,rgba(250,244,230,.06),rgba(248,242,228,.94) 32%,rgba(238,228,206,.96));
  border-top:1px solid rgba(60,46,26,.4);display:flex;flex-direction:column;justify-content:center;gap:calc(var(--u)*.12);}
#ui-root .sk-rc .nameplate .jp{font-family:var(--serif);font-size:calc(var(--u)*.86);color:#332B22;
  letter-spacing:.04em;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ui-root .sk-rc .nameplate .en{font-size:calc(var(--u)*.66);color:var(--ink-faint);letter-spacing:.1em;
  text-align:center;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ui-root .sk-stars{display:flex;justify-content:center;gap:1px;height:calc(var(--u)*.86);}
#ui-root .sk-stars i{width:calc(var(--u)*.8);height:calc(var(--u)*.8);background:${star} no-repeat center/contain;}
#ui-root .sk-stars i.off{background-image:${starOff};}
/* on parchment the cream star vanishes — use the outlined gold cut, and at a
   size a player can actually count: .84u = 11.1 px at 1080p (u = 13.26 px).
   The r2 review measured the old .64u row (~8.5 px, no outline) as unreadable. */
#ui-root .sk-stars.ink{height:calc(var(--u)*.9);gap:0;}
#ui-root .sk-stars.ink i{width:calc(var(--u)*.84);height:calc(var(--u)*.84);background-image:${starInk};
  filter:drop-shadow(0 1px 1px rgba(60,44,14,.42));}
#ui-root .sk-stars.ink i.off{background-image:${starInkOff};filter:none;}
#ui-root .sk-rc .shine{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:linear-gradient(102deg,rgba(255,255,255,0) 40%,rgba(255,255,255,.82) 50%,rgba(255,255,255,0) 60%);
  background-size:250% 100%;background-position:200% 0;}
#ui-root .sk-rc.flip{animation:sk-flip3d .68s var(--ease) both;}
#ui-root .sk-rc.flip .shine{animation:sk-shine 1.1s .42s ease-out both;}

/* ================= constellation ================= */
#ui-root .sk-sky{position:relative;width:100%;aspect-ratio:1.34;border-radius:3px;overflow:hidden;
  border:1px solid rgba(40,34,26,.6);
  background:
    radial-gradient(60% 46% at 50% 46%,rgba(96,74,150,.42),rgba(10,12,30,0) 70%),
    radial-gradient(120% 100% at 50% 110%,rgba(58,44,90,.5),rgba(8,9,24,0) 62%),
    linear-gradient(180deg,#0B0F26,#141033 52%,#1D1636);
  box-shadow:0 0 calc(var(--u)*2) rgba(0,0,0,.5) inset;}
#ui-root .sk-sky svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
#ui-root .sk-sky .starfield{position:absolute;inset:0;opacity:.85;}

/* ================= buttons ================= */
#ui-root .sk-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:.5em;
  padding:calc(var(--u)*.42) calc(var(--u)*1.15);border-radius:2px;
  font-family:var(--serif);font-size:calc(var(--u)*.86);letter-spacing:.18em;color:#2E2318;
  background:linear-gradient(180deg,${T.goldHi} 0%,#DFBE60 42%,${T.goldLo} 100%);
  border:1px solid #7A5A18;
  box-shadow:0 1px 0 rgba(255,255,255,.62) inset,0 -2px 5px rgba(120,84,16,.35) inset,0 2px 7px rgba(40,26,6,.3);
  transition:transform .12s var(--ease),box-shadow .14s ease,filter .14s ease;}
#ui-root .sk-btn:hover{transform:translateY(-1px);filter:brightness(1.06);
  box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 -2px 5px rgba(120,84,16,.32) inset,0 4px 14px rgba(40,26,6,.34),0 0 calc(var(--u)*1.1) rgba(232,197,106,.6);}
#ui-root .sk-btn:active{transform:translateY(1px);
  box-shadow:0 2px 5px rgba(90,62,10,.4) inset,0 1px 2px rgba(40,26,6,.25);}
#ui-root .sk-btn.ghost{background:linear-gradient(180deg,rgba(255,252,244,.75),rgba(226,214,192,.6));
  color:${T.inkSoft};border-color:rgba(74,64,52,.42);
  box-shadow:0 1px 0 rgba(255,255,255,.65) inset,0 1px 4px rgba(40,26,6,.14);}
#ui-root .sk-btn.danger{background:linear-gradient(180deg,#D98F82,#9B4A3A);color:#FFF1EC;border-color:#6E2E22;}
#ui-root .sk-btn[disabled]{opacity:.45;filter:grayscale(.5);cursor:default;transform:none!important;}

/* ================= settings ================= */
#ui-root .sk-row{display:flex;align-items:center;justify-content:space-between;gap:calc(var(--u)*.8);
  padding:calc(var(--u)*.5) 0;border-bottom:1px dashed rgba(74,64,52,.22);}
#ui-root .sk-row .lbl{font-family:var(--serif);font-size:calc(var(--u)*.9);color:#332B22;letter-spacing:.06em;}
#ui-root .sk-row .sub{font-size:var(--t-sec);color:var(--ink-faint);margin-top:2px;}
#ui-root textarea.sk-io{width:100%;height:calc(var(--u)*6.2);resize:none;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:calc(var(--u)*.68);line-height:1.5;color:#4A3F30;padding:calc(var(--u)*.5);
  background:rgba(255,253,246,.72);border:1px solid rgba(74,64,52,.35);border-radius:2px;
  box-shadow:0 1px 3px rgba(60,44,26,.16) inset;}
#ui-root input.sk-in{font:inherit;font-size:calc(var(--u)*.8);padding:calc(var(--u)*.3) calc(var(--u)*.55);
  background:linear-gradient(180deg,rgba(246,240,226,.9),rgba(255,253,246,.85));
  border:1px solid rgba(74,64,52,.42);border-radius:2px;color:#4A3F30;width:calc(var(--u)*10);
  box-shadow:0 2px 4px rgba(60,44,26,.16) inset,0 1px 0 rgba(255,255,255,.6);}

/* ================= stage-up set piece ================= */
#ui-root .sk-stageup{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;z-index:6;
  animation:sk-fade .3s ease both;}
#ui-root .sk-stageup .dim{position:absolute;inset:0;
  background:radial-gradient(46% 42% at 50% 50%,rgba(10,5,14,.80),rgba(10,5,14,.52) 42%,rgba(10,5,14,.16) 68%,rgba(10,5,14,0) 84%);}
#ui-root .sk-stageup .glow{position:absolute;inset:0;
  background:radial-gradient(30% 24% at 50% 50%,rgba(255,196,224,.40),rgba(255,170,210,0) 70%);
  mix-blend-mode:screen;animation:sk-glowpulse 3.4s ease-out both;}
#ui-root .sk-stageup .card{position:relative;text-align:center;padding:calc(var(--u)*2.0) calc(var(--u)*5.2);}
#ui-root .sk-stageup .eyebrow{font-family:var(--serif);font-size:calc(var(--u)*.86);letter-spacing:.52em;
  color:#FFE7B4;text-transform:uppercase;text-indent:.52em;
  text-shadow:0 2px 10px rgba(20,6,16,1),0 0 calc(var(--u)*1.4) rgba(255,190,120,.55);
  animation:sk-up-eyebrow .7s .1s var(--ease) both;}
#ui-root .sk-stageup .kj{font-family:var(--serif);font-size:calc(var(--u)*7.0);line-height:1.04;
  letter-spacing:.14em;text-indent:.14em;margin:calc(var(--u)*.28) 0 calc(var(--u)*.1);
  background:linear-gradient(180deg,#FFFFFF 4%,#FFF0F6 26%,#FFC4DC 58%,#E27FAC 88%,#C25F86 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 0 2px rgba(52,8,32,.95)) drop-shadow(0 4px 16px rgba(70,10,44,.9))
         drop-shadow(0 0 calc(var(--u)*2.6) rgba(255,150,200,.6));
  animation:sk-up-kanji .9s .16s var(--ease) both;}
#ui-root .sk-stageup .en{font-family:var(--serif);font-size:calc(var(--u)*1.62);letter-spacing:.46em;
  color:#FFF6FA;text-indent:.46em;
  text-shadow:0 2px 12px rgba(30,6,22,1),0 0 calc(var(--u)*1.6) rgba(255,180,215,.6);
  animation:sk-up-en .8s .3s var(--ease) both;}
#ui-root .sk-stageup .bars{position:absolute;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,226,240,.15) 12%,rgba(255,240,248,.95) 50%,rgba(255,226,240,.15) 88%,transparent);
  box-shadow:0 0 calc(var(--u)*.8) rgba(255,200,230,.7);
  animation:sk-up-bar .9s .06s var(--ease) both;}
#ui-root .sk-stageup .bars.t{top:calc(var(--u)*.9);}
#ui-root .sk-stageup .bars.b{bottom:calc(var(--u)*.9);}
#ui-root .sk-stageup .reward{margin-top:calc(var(--u)*1.0);font-size:calc(var(--u)*.94);letter-spacing:.2em;
  color:#FFE9B8;text-shadow:0 2px 10px rgba(30,10,6,1),0 0 calc(var(--u)*1.2) rgba(232,180,90,.5);
  animation:sk-up-en .8s .48s var(--ease) both;}

/* ================= welcome back ================= */
#ui-root .sk-wb{width:min(46vw,calc(var(--u)*40));}
#ui-root .sk-wb .lead{font-family:var(--serif);font-size:calc(var(--u)*1.0);line-height:1.7;color:#3E352A;text-align:center;}
#ui-root .sk-wb .big{font-family:var(--serif);font-size:calc(var(--u)*2.6);color:#7A5A10;text-align:center;
  letter-spacing:.02em;margin:calc(var(--u)*.3) 0 calc(var(--u)*.1);
  text-shadow:0 1px 0 rgba(255,255,255,.7);}
#ui-root .sk-wb .stat{display:flex;justify-content:space-between;font-size:calc(var(--u)*.82);
  padding:calc(var(--u)*.3) 0;border-bottom:1px dotted rgba(74,64,52,.25);color:var(--ink-soft);}
#ui-root .sk-wb .stat b{color:#3E352A;font-weight:600;}
#ui-root .sk-wb .note{font-family:var(--serif);font-style:italic;font-size:calc(var(--u)*.84);
  color:var(--ink-soft);text-align:center;margin-top:calc(var(--u)*.7);line-height:1.6;}

/* ================= floating gain numbers ================= */
#ui-root .sk-fly{position:absolute;pointer-events:none;will-change:transform,opacity;font-family:var(--serif);font-weight:600;
  font-size:calc(var(--u)*1.15);color:#FFF0F6;letter-spacing:.02em;
  text-shadow:0 2px 8px rgba(90,20,60,.8),0 0 calc(var(--u)*1.1) rgba(255,150,200,.75);}
#ui-root .sk-fly.crit{font-size:calc(var(--u)*1.75);color:#FFF6D8;
  text-shadow:0 2px 10px rgba(120,60,0,.85),0 0 calc(var(--u)*1.7) rgba(255,205,110,.9);}

/* ================= additions: chips, bulk, detail, legend, achievements ==== */
#ui-root .sk-bank-sub em{font-style:normal;opacity:.72;letter-spacing:.06em;}
#ui-root .sk-shake .bar{width:1px;height:calc(var(--u)*1.1);background:rgba(255,225,235,.32);}
#ui-root .sk-chip.season{pointer-events:auto;cursor:pointer;
  background:linear-gradient(180deg,${T.goldHi},${T.goldLo});border-color:#7A5A18;
  box-shadow:0 1px 0 rgba(255,255,255,.55) inset,0 0 calc(var(--u)*1.1) rgba(232,197,106,.55);
  animation:sk-afford 1.9s ease-in-out infinite;}
#ui-root .sk-chip.season i{background-image:${essenceIcon(22)};filter:brightness(.55) saturate(.6);}
#ui-root .sk-chip.season span{color:#2E2318;font-weight:700;font-size:calc(var(--u)*.72);letter-spacing:.16em;}

#ui-root .sk-golden{position:absolute;left:calc(50% - var(--rail)*0.5);bottom:calc(var(--u)*4.4);transform:translateX(-50%);
  display:flex;align-items:center;gap:calc(var(--u)*.5);pointer-events:none;
  padding:calc(var(--u)*.3) calc(var(--u)*1.0);border-radius:99px;
  background:linear-gradient(180deg,rgba(72,52,12,.6),rgba(40,28,6,.66));
  border:1px solid rgba(255,214,120,.75);box-shadow:0 0 calc(var(--u)*1.4) rgba(255,200,90,.45);
  animation:sk-blip 1.3s ease-in-out infinite;}
#ui-root .sk-golden i{width:calc(var(--u)*1.0);height:calc(var(--u)*1.0);border-radius:99px;
  background:radial-gradient(circle at 35% 30%,#FFF8D8,#FFD064 55%,#B8862A);
  box-shadow:0 0 calc(var(--u)*.8) rgba(255,216,120,.95);}
#ui-root .sk-golden span{font-family:var(--serif);font-size:calc(var(--u)*.82);letter-spacing:.16em;color:#FFEFC4;}

/* gold segmented control — one bevelled shell, inset parchment segments, the
   active segment on the §7 gold gradient.  Replaces four flat 1-px rectangles. */
#ui-root .sk-seg{display:flex;border-radius:4px;overflow:hidden;
  border:1px solid rgba(74,64,52,.62);
  background:linear-gradient(180deg,rgba(206,192,166,.85),rgba(234,224,204,.7));
  box-shadow:0 2px 5px rgba(60,44,26,.26) inset,0 1px 0 rgba(255,255,255,.6),
             0 1px 3px rgba(50,36,20,.2);}
#ui-root .sk-seg button{position:relative;font-size:var(--t-sec);letter-spacing:.08em;
  padding:calc(var(--u)*.28) calc(var(--u)*.66);color:${T.inkSoft};font-weight:600;
  transition:background .14s ease,color .14s ease,box-shadow .14s ease;}
#ui-root .sk-seg button+button{border-left:1px solid rgba(74,64,52,.3);
  box-shadow:-1px 0 0 rgba(255,255,255,.4);}
#ui-root .sk-seg button:hover{color:${T.ink};background:rgba(255,252,240,.5);}
#ui-root .sk-seg button.on{background:linear-gradient(180deg,${T.goldHi} 0%,#E3C270 42%,${T.goldLo} 100%);
  color:#2E2318;font-weight:700;
  box-shadow:0 1px 0 rgba(255,255,255,.66) inset,0 -3px 6px rgba(120,84,16,.34) inset;}
#ui-root .sk-seg button.on::after{content:"";position:absolute;left:0;right:0;top:0;height:44%;
  background:linear-gradient(180deg,rgba(255,253,235,.5),rgba(255,253,235,0));pointer-events:none;}

#ui-root .sk-detail{margin-top:calc(var(--u)*.8);padding:calc(var(--u)*.6) calc(var(--u)*1.0);
  text-align:center;min-height:calc(var(--u)*4.4);
  border-top:1px solid rgba(74,64,52,.18);border-bottom:1px solid rgba(74,64,52,.12);
  background:linear-gradient(180deg,rgba(255,252,244,.5),rgba(232,220,198,.28));}
#ui-root .sk-detail .sk-flavour{font-size:calc(var(--u)*.84);line-height:1.62;margin-top:calc(var(--u)*.26);}

#ui-root .sk-legend{display:flex;gap:calc(var(--u)*1.0);justify-content:center;flex-wrap:wrap;
  margin-top:calc(var(--u)*.7);}
#ui-root .sk-legend>span{display:flex;align-items:center;gap:calc(var(--u)*.3);
  font-size:var(--t-sec);color:#544733;letter-spacing:.1em;}
#ui-root .sk-legend i{width:calc(var(--u)*.52);height:calc(var(--u)*.52);border-radius:99px;
  border:1px solid rgba(74,64,52,.45);}
#ui-root .sk-legend .sk-kanji{font-size:calc(var(--u)*.86);color:#332B22;}

#ui-root .sk-achs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:calc(var(--u)*.3);
  margin-top:calc(var(--u)*.4);}
#ui-root .sk-ach{display:flex;align-items:center;gap:calc(var(--u)*.4);min-width:0;
  padding:calc(var(--u)*.24) calc(var(--u)*.45);border-radius:2px;
  border:1px solid rgba(74,64,52,.22);
  background:linear-gradient(180deg,rgba(255,252,244,.55),rgba(226,214,192,.42));
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 1px 2px rgba(60,44,26,.1);
  font-size:var(--t-sec);color:var(--ink-faint);}
#ui-root .sk-ach span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#ui-root .sk-ach i{width:calc(var(--u)*.66);height:calc(var(--u)*.66);border-radius:99px;flex:0 0 auto;
  background:rgba(74,64,52,.18);}
#ui-root .sk-ach.got{border-color:rgba(184,138,48,.55);background:linear-gradient(180deg,rgba(255,250,232,.8),rgba(246,232,196,.5));
  color:#4A3C22;}
#ui-root .sk-ach.got i{background:radial-gradient(circle at 35% 30%,#FFF6D2,${T.goldPale} 55%,${T.goldDeep});
  box-shadow:0 0 calc(var(--u)*.4) rgba(232,197,106,.8);}

#ui-root .sk-up.fam-heart .g{background:radial-gradient(120% 120% at 30% 20%,#C7A05C,#6E4A18);}
#ui-root .sk-toast.r3{box-shadow:0 calc(var(--u)*1.3) calc(var(--u)*3.2) rgba(24,14,9,.42),0 0 0 1px rgba(76,139,201,.45),0 1px 0 rgba(255,255,255,.5) inset;}
#ui-root .sk-toast.r4{box-shadow:0 calc(var(--u)*1.3) calc(var(--u)*3.2) rgba(24,14,9,.42),0 0 0 1px rgba(162,119,221,.5),0 1px 0 rgba(255,255,255,.5) inset;}
#ui-root .sk-toast.r5{box-shadow:0 calc(var(--u)*1.3) calc(var(--u)*3.2) rgba(24,14,9,.42),0 0 0 1px rgba(213,165,74,.7),0 0 calc(var(--u)*1.4) rgba(213,165,74,.3),0 1px 0 rgba(255,255,255,.5) inset;}
#ui-root .sk-toast .rw{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35;}
#ui-root .sk-stageup .blurb{margin-top:calc(var(--u)*.7);font-family:var(--serif);font-style:italic;
  font-size:calc(var(--u)*.94);line-height:1.55;color:rgba(255,238,246,.92);max-width:calc(var(--u)*30);
  margin-left:auto;margin-right:auto;text-shadow:0 2px 10px rgba(30,8,22,1);
  animation:sk-up-en .8s .4s var(--ease) both;}
#ui-root .sk-wb .cap{text-align:center;font-size:calc(var(--u)*.72);letter-spacing:.26em;
  color:var(--ink-faint);text-transform:uppercase;margin-bottom:calc(var(--u)*.9);}

/* ================= keyframes ================= */
@keyframes sk-in{from{opacity:0;transform:translateY(calc(var(--u)*-.6));}to{opacity:1;transform:none;}}
@keyframes sk-fade{from{opacity:0;}to{opacity:1;}}
@keyframes sk-panel-in{from{opacity:0;transform:translateX(calc(var(--u)*1.5));}to{opacity:1;transform:none;}}
@keyframes sk-modal-in{from{opacity:0;transform:translateY(calc(var(--u)*1.2)) scale(.97);}to{opacity:1;transform:none;}}
@keyframes sk-toast-in{0%{opacity:0;transform:translateX(calc(var(--u)*2.4)) scale(.96);}100%{opacity:1;transform:none;}}
@keyframes sk-banner{0%{opacity:0;transform:translate(-50%,calc(var(--u)*-1.4));}100%{opacity:1;transform:translate(-50%,0);}}

@keyframes sk-shine{0%{background-position:200% 0;opacity:0;}12%{opacity:1;}88%{opacity:1;}100%{background-position:-90% 0;opacity:0;}}
@keyframes sk-sheen{0%{left:-18%;opacity:0;}18%{opacity:.9;}70%{left:104%;opacity:0;}100%{left:104%;opacity:0;}}
@keyframes sk-blip{0%,100%{opacity:.45;transform:scale(.85);}50%{opacity:1;transform:scale(1.15);}}
@keyframes sk-breathe{0%,100%{transform:scale(1) rotate(0deg);}50%{transform:scale(1.06) rotate(6deg);}}
@keyframes sk-afford{0%,100%{box-shadow:0 0 0 1px rgba(232,197,106,.4),0 2px 10px rgba(150,110,30,.2),0 1px 0 rgba(255,255,255,.75) inset;}
  50%{box-shadow:0 0 0 1px rgba(232,197,106,.85),0 2px 16px rgba(212,164,58,.5),0 1px 0 rgba(255,255,255,.85) inset;}}
@keyframes sk-flip{0%{opacity:0;transform:perspective(700px) rotateY(-78deg) translateX(calc(var(--u)*1.4));}
  60%{opacity:1;transform:perspective(700px) rotateY(9deg);}100%{opacity:1;transform:none;}}
@keyframes sk-flip3d{0%{transform:perspective(900px) rotateY(-180deg) scale(.9);}
  55%{transform:perspective(900px) rotateY(-14deg) scale(1.04);}100%{transform:perspective(900px) rotateY(0) scale(1);}}
@keyframes sk-fly{0%{opacity:0;transform:translate(-50%,0) scale(.7);}
  16%{opacity:1;transform:translate(-50%,calc(var(--u)*-1.1)) scale(1.1);}
  100%{opacity:0;transform:translate(-50%,calc(var(--u)*-5.4)) scale(.95);}}
@keyframes sk-glowpulse{0%{opacity:0;transform:scale(.7);}22%{opacity:1;transform:scale(1);}100%{opacity:.35;transform:scale(1.25);}}
@keyframes sk-up-eyebrow{0%{opacity:0;letter-spacing:1.2em;}100%{opacity:1;letter-spacing:.52em;}}
@keyframes sk-up-kanji{0%{opacity:0;transform:scale(1.5);filter:blur(10px);}100%{opacity:1;transform:scale(1);filter:blur(0);}}
@keyframes sk-up-en{0%{opacity:0;transform:translateY(calc(var(--u)*.8));}100%{opacity:1;transform:none;}}
@keyframes sk-up-bar{0%{opacity:0;transform:scaleX(0);}100%{opacity:1;transform:scaleX(1);}}

@media (prefers-reduced-motion:reduce){
  #ui-root *{animation-duration:.01ms!important;transition-duration:.01ms!important;}
}
`;
}

/** Inject once. Safe to call repeatedly. */
export function injectUiStyle() {
  let s = document.getElementById('sakura-ui-style');
  if (!s) {
    s = document.createElement('style');
    s.id = 'sakura-ui-style';
    document.head.appendChild(s);
  }
  s.textContent = uiCss();
  return s;
}
