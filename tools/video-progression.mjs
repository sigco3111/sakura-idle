#!/usr/bin/env node
/**
 * Annotated visual-progression video — how this project's rendering evolved,
 * from the first placeholder blockout to the current build.
 *
 *   node tools/video-progression.mjs                       # full render + encode
 *   node tools/video-progression.mjs --frames 0,300,700    # only these frame numbers (preview)
 *   node tools/video-progression.mjs --no-encode           # frames only
 *
 * Every output frame is composited at full 1920x1080 in headless Chrome's canvas
 * (no image library is installed, and none may be added — same trick as
 * tools/sheet.mjs). Ken Burns and crossfades are computed per frame here rather
 * than in ffmpeg, so callout boxes can track the region they point at while the
 * annotation type stays pixel-locked to the 1080p grid and never gets scaled.
 *
 * Style follows ART_BIBLE.md section 7: warm parchment panel, 1.5 px dark border,
 * gold inner keyline offset 3 px, gold filigree corners, serif display type.
 *
 * Output: docs/videos/progression.mp4
 */
import puppeteer from 'puppeteer';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const has = (k) => argv.includes('--' + k);

const ROOT = path.resolve(import.meta.dirname, '..');
const STILLS = path.join(ROOT, 'docs/progression');
const WORK = path.join(ROOT, '.tmp-orch/video/frames');
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs/videos/progression.mp4')));
const AUDIO = path.resolve(arg('audio', path.join(ROOT, '.tmp-orch/video/bed.wav')));

const W = 1920, H = 1080, FPS = 30;
const XF = 0.55;          // crossfade length, seconds
const ONLY = arg('frames', null);

/* ------------------------------------------------------------------ *
 * The story. Captions must be true to what is actually in each frame.
 * `box` regions are in normalised source-image coords (0..1), so they
 * survive the Ken Burns transform.
 * ------------------------------------------------------------------ */
const BEATS = [
  {
    file: '01-placeholder-blockout.png', dur: 2.5,
    title: 'a cylinder and a sphere',
    sub: 'day one — a placeholder to hang lighting on',
    ken: { s0: 1.015, s1: 1.075, dx: 0.0, dy: 0.4 },
  },
  {
    file: '02-npr-calibration.png', dur: 2.6,
    title: 'NPR ramp shading, calibrated',
    sub: 'two tone bands, violet hue-shifted shadow, rim light',
    ken: { s0: 1.02, s1: 1.08, dx: -0.6, dy: 0.5 },
    boxes: [{ x0: 0.0, y0: 0.855, x1: 0.30, y1: 1.0, label: 'shading probes', side: 'above' }],
  },
  {
    file: '03-sky-lighting-postfx.png', dur: 2.6,
    title: 'sky, atmosphere, post chain',
    sub: 'painted clouds, layered hills, bloom, vignette, grade',
    ken: { s0: 1.02, s1: 1.08, dx: 0.5, dy: -0.5 },
    boxes: [{ x0: 0.02, y0: 0.40, x1: 0.98, y1: 0.60, label: 'aerial perspective', side: 'above', underline: true }],
  },
  {
    file: '04-first-real-tree.png', dur: 2.8,
    title: 'the first real tree',
    sub: 'procedural bark, instanced blossom clusters, grass, petals',
    ken: { s0: 1.015, s1: 1.075, dx: 0.3, dy: 0.4 },
  },
  {
    file: '05-shadows-contrast.png', dur: 2.5,
    title: 'shadows land, contrast restored',
    sub: 'the shadow frustum finally fit the canopy it was cast by',
    ken: { s0: 1.02, s1: 1.08, dx: -0.4, dy: 0.5 },
  },
  {
    file: '06-game-ui-lands.png', dur: 2.7,
    title: 'the UI arrives',
    sub: 'parchment panels, gold keyline, serif display type',
    ken: { s0: 1.015, s1: 1.07, dx: 0.35, dy: 0.35 },
    boxes: [{ x0: 0.655, y0: 0.008, x1: 0.965, y1: 0.335, label: 'DOM over the scene', side: 'below' }],
  },
  {
    file: '07-pond-props-torii.png', dur: 2.9,
    title: 'pond, torii, lanterns, mossy wall',
    sub: 'the grove stops being a field with a tree in it',
    ken: { s0: 1.02, s1: 1.08, dx: -0.5, dy: 0.45 },
    boxes: [
      { x0: 0.735, y0: 0.515, x1: 0.995, y1: 0.905, label: 'vermilion torii', side: 'above' },
      { x0: 0.0, y0: 0.845, x1: 0.20, y1: 0.985, label: 'pond', side: 'above' },
    ],
  },
  {
    file: '08-pond-reflection.png', dur: 2.8,
    title: 'the water reflects for real',
    sub: 'sky, clouds and canopy, with petals resting on the surface',
    ken: { s0: 1.02, s1: 1.075, dx: 0.2, dy: -0.35 },
    boxes: [{ x0: 0.115, y0: 0.395, x1: 0.79, y1: 0.63, label: 'sky + cloud, mirrored', side: 'above' }],
  },
  {
    file: '09-canopy-pink.png', dur: 2.8,
    title: 'canopy: violet → sakura pink',
    sub: 'the deep interior tint had been lifting blue above red',
    ken: { s0: 1.025, s1: 1.085, dx: -0.15, dy: -0.3 },
    boxes: [{ x0: 0.375, y0: 0.185, x1: 0.545, y1: 0.50, label: 'rose, not mauve', side: 'right' }],
  },
  {
    file: '10-current-full-bloom.png', dur: 3.3,
    title: 'full bloom',
    sub: 'god rays, seven tenders, eleven million petals',
    ken: { s0: 1.015, s1: 1.075, dx: -0.3, dy: 0.3 },
    boxes: [{ x0: 0.395, y0: 0.30, x1: 0.545, y1: 0.72, label: 'god rays', side: 'right' }],
  },
];

const TITLE = { dur: 3.5, backdrop: '10-current-full-bloom.png' };
const ENDCARD = { dur: 3.6, backdrop: '08-pond-reflection.png' };

/* ---- build the timeline: title, ten beats, end card, overlapping by XF ---- */
const cards = [
  { kind: 'title', dur: TITLE.dur, file: TITLE.backdrop },
  ...BEATS.map((b, i) => ({ kind: 'beat', step: i + 1, ...b })),
  { kind: 'end', dur: ENDCARD.dur, file: ENDCARD.backdrop },
];
let t = 0;
for (const c of cards) { c.start = t; c.end = t + c.dur; t = c.end - XF; }
const TOTAL = cards[cards.length - 1].end;
const NFRAMES = Math.round(TOTAL * FPS);

/* ------------------------------ load stills ------------------------------ */
const files = [...new Set(cards.map((c) => c.file))];
const encoded = {};
for (const f of files) {
  const p = path.join(STILLS, f);
  if (!existsSync(p)) { console.error('[video] missing still:', p); process.exit(2); }
  encoded[f] = 'data:image/png;base64,' + (await readFile(p)).toString('base64');
}

/* --------------------------- browser-side painter --------------------------- */
/** Everything below runs inside the page (one call per frame batch). */
const PAINTER = /* js */ `
(() => {
const W = 1920, H = 1080;
const SERIF = '"Hiragino Mincho ProN","Yu Mincho","Songti SC",Georgia,serif';
const SANS  = '"Hiragino Sans","Helvetica Neue",Helvetica,Arial,sans-serif';
const C = {
  parchment0: '#F7F1E4', parchment1: '#EBE0CB',
  ink: '#3A322A', inkSoft: '#6B5C48',
  border: '#4A4034', gold: '#C9A227', goldLite: '#E8C56A', goldDeep: '#A8792C',
  cream: '#F3EBDC',
};
const R = (v) => Math.round(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- primitives ---------- */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Warm parchment plate with dark border + inset gold keyline + filigree corners. */
function plate(g, x, y, w, h, opt = {}) {
  const o = Object.assign({ radius: 3, alpha: 0.955, shadow: 26, filigree: true }, opt);
  x = R(x); y = R(y); w = R(w); h = R(h);
  g.save();
  g.globalAlpha = o.alpha;
  g.shadowColor = 'rgba(24,16,12,0.42)';
  g.shadowBlur = o.shadow;
  g.shadowOffsetY = 6;
  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, C.parchment0);
  grad.addColorStop(0.55, '#F2E9D8');
  grad.addColorStop(1, C.parchment1);
  g.fillStyle = grad;
  roundRect(g, x, y, w, h, o.radius); g.fill();
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.globalAlpha = o.alpha;
  // dark keyline
  g.strokeStyle = C.border; g.lineWidth = 1.5;
  roundRect(g, x + 0.75, y + 0.75, w - 1.5, h - 1.5, o.radius); g.stroke();
  // gold inner keyline, inset 3px
  g.strokeStyle = C.gold; g.lineWidth = 1;
  g.globalAlpha = o.alpha * 0.85;
  roundRect(g, x + 3.5, y + 3.5, w - 7, h - 7, Math.max(1, o.radius - 1)); g.stroke();
  if (o.filigree) filigree(g, x, y, w, h);
  g.restore();
}

/** Gold corner ornament — two tapering strokes and a small dot, per corner. */
function filigree(g, x, y, w, h) {
  const L = 22;
  g.save();
  g.strokeStyle = C.goldDeep; g.lineWidth = 1.4; g.globalAlpha = 0.9;
  const corners = [[x + 7, y + 7, 1, 1], [x + w - 7, y + 7, -1, 1],
                   [x + 7, y + h - 7, 1, -1], [x + w - 7, y + h - 7, -1, -1]];
  for (const [cx, cy, sx, sy] of corners) {
    g.beginPath();
    g.moveTo(cx + sx * L, cy);
    g.lineTo(cx + sx * 5, cy);
    g.quadraticCurveTo(cx, cy, cx, cy + sy * 5);
    g.lineTo(cx, cy + sy * L);
    g.stroke();
    g.beginPath();
    g.arc(cx + sx * 5.5, cy + sy * 5.5, 1.5, 0, Math.PI * 2);
    g.fillStyle = C.goldLite; g.fill();
  }
  g.restore();
}

/** Hairline divider that tapers to nothing at both ends. */
function divider(g, x, y, w, color) {
  const grd = g.createLinearGradient(x, y, x + w, y);
  grd.addColorStop(0, 'rgba(169,121,44,0)');
  grd.addColorStop(0.18, color);
  grd.addColorStop(0.82, color);
  grd.addColorStop(1, 'rgba(169,121,44,0)');
  g.fillStyle = grd;
  g.fillRect(R(x), R(y), R(w), 1);
}

function diamond(g, cx, cy, r, fill, stroke) {
  g.beginPath();
  g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}

/** Letter-spaced text. Returns advance width. Canvas letterSpacing is honoured
 *  in Chrome, but we do it by hand so measurement and paint always agree. */
function tracked(g, str, x, y, sp) {
  let cx = x;
  for (const ch of str) { g.fillText(ch, R(cx), R(y)); cx += g.measureText(ch).width + sp; }
  return cx - x - sp;
}
function trackedWidth(g, str, sp) {
  let w = 0;
  for (const ch of str) w += g.measureText(ch).width + sp;
  return Math.max(0, w - sp);
}

/* ---------- ken burns ---------- */
/** Returns a mapper from normalised source coords to screen px, plus draw args. */
function kenBurns(img, k, p) {
  const s = k.s0 + (k.s1 - k.s0) * p;
  const halfU = 1 / (2 * s), halfV = 1 / (2 * s);
  // pan travels through the frame across the beat, clamped to available slack
  let cu = 0.5 + (k.dx || 0) * (p - 0.5) * 0.16;
  let cv = 0.5 + (k.dy || 0) * (p - 0.5) * 0.16;
  cu = clamp(cu, halfU, 1 - halfU);
  cv = clamp(cv, halfV, 1 - halfV);
  const u0 = cu - halfU, v0 = cv - halfV;
  return {
    src: { sx: u0 * img.width, sy: v0 * img.height, sw: img.width / s, sh: img.height / s },
    map: (u, v) => [(u - u0) * s * W, (v - v0) * s * H],
  };
}

/* ---------- annotation callouts ---------- */
function callout(g, box, mapper) {
  const [x0r, y0r] = mapper(box.x0, box.y0);
  const [x1r, y1r] = mapper(box.x1, box.y1);
  const x0 = clamp(x0r, -40, W + 40), x1 = clamp(x1r, -40, W + 40);
  const y0 = clamp(y0r, -40, H + 40), y1 = clamp(y1r, -40, H + 40);
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 4) return;
  g.save();
  if (box.underline) {
    // a single tapering gold rule across the region instead of a box
    const y = R((y0 + y1) / 2);
    const grd = g.createLinearGradient(x0, y, x1, y);
    grd.addColorStop(0, 'rgba(232,197,106,0)');
    grd.addColorStop(0.15, 'rgba(232,197,106,0.95)');
    grd.addColorStop(0.85, 'rgba(232,197,106,0.95)');
    grd.addColorStop(1, 'rgba(232,197,106,0)');
    g.shadowColor = 'rgba(30,22,16,0.55)'; g.shadowBlur = 6;
    g.fillStyle = grd; g.fillRect(R(x0), y, R(w), 2);
    g.restore();
    tag(g, box.label, (x0 + x1) / 2, y - 12, 'center', 'above');
    return;
  }
  // subtle bracket-cornered box: corners only, so the image stays readable
  const cl = Math.min(34, w * 0.28, h * 0.34);
  g.shadowColor = 'rgba(28,20,14,0.6)'; g.shadowBlur = 7;
  g.strokeStyle = 'rgba(232,197,106,0.92)'; g.lineWidth = 2;
  const X0 = R(x0) + 0.5, Y0 = R(y0) + 0.5, X1 = R(x1) + 0.5, Y1 = R(y1) + 0.5;
  const corners = [[X0, Y0, 1, 1], [X1, Y0, -1, 1], [X0, Y1, 1, -1], [X1, Y1, -1, -1]];
  for (const [cx, cy, sx, sy] of corners) {
    g.beginPath();
    g.moveTo(cx + sx * cl, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + sy * cl);
    g.stroke();
  }
  // whisper-faint full rectangle to close the read
  g.shadowColor = 'transparent';
  g.strokeStyle = 'rgba(232,197,106,0.28)'; g.lineWidth = 1;
  g.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
  g.restore();

  const side = box.side || 'above';
  if (side === 'above') tag(g, box.label, (x0 + x1) / 2, y0 - 13, 'center', 'above');
  else if (side === 'below') tag(g, box.label, (x0 + x1) / 2, y1 + 13, 'center', 'below');
  else if (side === 'right') tag(g, box.label, x1 + 14, (y0 + y1) / 2, 'left', 'middle');
  else tag(g, box.label, x0 - 14, (y0 + y1) / 2, 'right', 'middle');
}

/** Small gold-keyline label chip for a callout. Never scaled — 1080p native. */
function tag(g, text, ax, ay, halign, valign) {
  g.save();
  g.font = '500 21px ' + SANS;
  const sp = 0.8;
  const tw = trackedWidth(g, text, sp);
  const padX = 13, padY = 8, hh = 21 + padY * 2 - 3;
  let x = ax, y = ay;
  if (halign === 'center') x = ax - (tw + padX * 2) / 2;
  else if (halign === 'right') x = ax - (tw + padX * 2);
  if (valign === 'above') y = ay - hh;
  else if (valign === 'middle') y = ay - hh / 2;
  x = clamp(x, 14, W - 14 - (tw + padX * 2));
  y = clamp(y, 14, H - 14 - hh);
  const w = tw + padX * 2;
  g.globalAlpha = 1;
  g.shadowColor = 'rgba(20,14,10,0.5)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
  g.fillStyle = 'rgba(36,28,22,0.86)';
  roundRect(g, R(x), R(y), R(w), R(hh), 2); g.fill();
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.strokeStyle = 'rgba(201,162,39,0.9)'; g.lineWidth = 1;
  roundRect(g, R(x) + 0.5, R(y) + 0.5, R(w) - 1, R(hh) - 1, 2); g.stroke();
  g.fillStyle = '#F3EBDC';
  g.textBaseline = 'middle';
  tracked(g, text, x + padX, y + hh / 2 + 0.5, sp);
  g.restore();
}

/* ---------- the caption plate for a beat ---------- */
function captionPlate(g, step, total, title, sub) {
  const M = 74;                       // margin from frame edge
  const padX = 26, padTop = 20, padBot = 21;
  const badgeW = 74;

  g.font = '600 41px ' + SERIF;
  const twTitle = trackedWidth(g, title, 1.6);
  g.font = '400 22px ' + SANS;
  const twSub = trackedWidth(g, sub, 0.35);

  const textW = Math.max(twTitle, twSub);
  const bodyH = 41 + 15 + 22;
  const plateW = padX + badgeW + 22 + textW + padX;
  const plateH = padTop + bodyH + padBot;
  const x = M, y = H - M - plateH - 34;   // sits clear of the game's own bottom pill

  plate(g, x, y, plateW, plateH);

  // step badge: kanji mark, number, total
  const bx = x + padX, byTop = y + padTop;
  g.save();
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.goldDeep;
  g.font = '400 25px ' + SERIF;
  g.fillText('桜', R(bx + 21), R(byTop + 25));
  g.fillStyle = C.ink;
  g.font = '600 34px ' + SERIF;
  const num = String(step).padStart(2, '0');
  const nw = g.measureText(num).width;
  g.fillText(num, R(bx + badgeW / 2 - nw / 2 - 4), R(byTop + 63));
  g.fillStyle = C.inkSoft;
  g.font = '400 15px ' + SANS;
  const tot = '/ ' + String(total);
  g.fillText(tot, R(bx + badgeW / 2 - nw / 2 + nw / 2 + 5), R(byTop + 63));
  g.restore();

  // tapering vertical hairline between badge and text
  const dx = R(bx + badgeW + 6);
  const vg = g.createLinearGradient(dx, byTop, dx, byTop + bodyH);
  vg.addColorStop(0, 'rgba(74,64,52,0)');
  vg.addColorStop(0.2, 'rgba(74,64,52,0.5)');
  vg.addColorStop(0.8, 'rgba(74,64,52,0.5)');
  vg.addColorStop(1, 'rgba(74,64,52,0)');
  g.fillStyle = vg; g.fillRect(dx, R(byTop), 1, R(bodyH));

  // title + sub
  const tx = bx + badgeW + 22;
  g.save();
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.ink;
  g.font = '600 41px ' + SERIF;
  tracked(g, title, tx, byTop + 35, 1.6);
  divider(g, tx - 2, byTop + 49, Math.min(textW + 4, 560), 'rgba(169,121,44,0.75)');
  g.fillStyle = C.inkSoft;
  g.font = '400 22px ' + SANS;
  tracked(g, sub, tx, byTop + 76, 0.35);
  g.restore();

  return { x, y, plateW, plateH };
}

/* ---------- cinematic furniture ---------- */
function vignette(g, strength) {
  const r = g.createRadialGradient(W / 2, H * 0.48, H * 0.30, W / 2, H * 0.5, H * 0.86);
  r.addColorStop(0, 'rgba(0,0,0,0)');
  r.addColorStop(1, 'rgba(14,9,14,' + strength + ')');
  g.fillStyle = r; g.fillRect(0, 0, W, H);
}

function progressTicker(g, step, total) {
  // ten small diamonds, bottom-right, filled up to the current step
  const r = 4.5, gap = 20;
  const totalW = (total - 1) * gap;
  const x0 = W - 74 - totalW, y = H - 74 + 4;
  for (let i = 0; i < total; i++) {
    const cx = x0 + i * gap, on = i < step;
    g.globalAlpha = on ? 0.95 : 0.42;
    diamond(g, R(cx) + 0.5, R(y) + 0.5, on ? r : r - 1.2,
      on ? '#E8C56A' : 'rgba(243,235,220,0.55)', 'rgba(40,30,20,0.55)');
  }
  g.globalAlpha = 1;
}

/* ---------- card renderers ---------- */
function drawBeat(g, img, card, p) {
  const kb = kenBurns(img, card.ken, p);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, kb.src.sx, kb.src.sy, kb.src.sw, kb.src.sh, 0, 0, W, H);
  vignette(g, 0.30);
  // gentle darkening under the caption so parchment always has contrast behind it
  const lg = g.createLinearGradient(0, H * 0.68, 0, H);
  lg.addColorStop(0, 'rgba(18,12,16,0)');
  lg.addColorStop(1, 'rgba(18,12,16,0.34)');
  g.fillStyle = lg; g.fillRect(0, R(H * 0.68), W, R(H * 0.32));

  for (const b of (card.boxes || [])) callout(g, b, kb.map);
  captionPlate(g, card.step, 10, card.title, card.sub);
  progressTicker(g, card.step, 10);
}

function drawBackdrop(g, img, scale, blur, dark) {
  const s = scale;
  const sw = img.width / s, sh = img.height / s;
  g.save();
  g.filter = 'blur(' + blur + 'px) saturate(0.85)';
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, -30, -30, W + 60, H + 60);
  g.restore();
  g.fillStyle = 'rgba(22,15,20,' + dark + ')';
  g.fillRect(0, 0, W, H);
  vignette(g, 0.5);
}

function drawTitle(g, img, p) {
  drawBackdrop(g, img, 1.06 + 0.06 * p, 19, 0.52);
  const cx = W / 2;
  g.save();
  g.textBaseline = 'alphabetic';
  // 桜
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 26;
  g.font = '400 128px ' + SERIF;
  const kanji = '桜';
  const kw = g.measureText(kanji).width;
  const kg = g.createLinearGradient(0, 300, 0, 430);
  kg.addColorStop(0, '#F6E3B0'); kg.addColorStop(0.55, '#E8C56A'); kg.addColorStop(1, '#B0842F');
  g.fillStyle = kg;
  g.fillText(kanji, R(cx - kw / 2), 428);
  g.shadowBlur = 18;
  // title
  g.font = '600 62px ' + SERIF;
  const t1 = 'Sakura — Petals of the Everblossom';
  const w1 = trackedWidth(g, t1, 3.2);
  g.fillStyle = '#F7F1E4';
  tracked(g, t1, cx - w1 / 2, 545, 3.2);
  g.shadowColor = 'transparent';
  // divider with centre diamond
  divider(g, cx - 300, 585, 600, 'rgba(232,197,106,0.85)');
  diamond(g, R(cx) + 0.5, 585.5, 5, '#E8C56A', 'rgba(60,44,20,0.7)');
  // strap line
  g.font = '400 27px ' + SANS;
  const t2 = 'one tree, built by agents';
  const w2 = trackedWidth(g, t2, 4.4);
  g.fillStyle = 'rgba(243,235,220,0.86)';
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 10;
  tracked(g, t2, cx - w2 / 2, 636, 4.4);
  // footer
  g.font = '400 21px ' + SANS;
  const t3 = 'a visual progression';
  const w3 = trackedWidth(g, t3, 6);
  g.fillStyle = 'rgba(232,197,106,0.8)';
  tracked(g, t3, cx - w3 / 2, 700, 6);
  g.restore();
}

function drawEnd(g, img, p) {
  drawBackdrop(g, img, 1.05 + 0.05 * p, 22, 0.56);
  const pw = 980, ph = 322;
  const x = (W - pw) / 2, y = (H - ph) / 2 - 10;
  plate(g, x, y, pw, ph, { alpha: 0.96, shadow: 34 });
  const cx = W / 2;
  g.save();
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.goldDeep;
  g.font = '400 30px ' + SERIF;
  const kw = g.measureText('桜').width;
  g.fillText('桜', R(cx - kw / 2), y + 60);
  g.fillStyle = C.ink;
  g.font = '600 34px ' + SERIF;
  const nm = 'Sakura — Petals of the Everblossom';
  const nw = trackedWidth(g, nm, 2.2);
  tracked(g, nm, cx - nw / 2, y + 104, 2.2);
  divider(g, cx - 230, y + 126, 460, 'rgba(169,121,44,0.8)');
  diamond(g, R(cx) + 0.5, y + 126.5, 4, '#C9A227', null);

  const rows = [['play', 'sakura-idle.vercel.app'], ['source', 'github.com/danmana/sakura-idle']];
  let ry = y + 182;
  for (const [k, v] of rows) {
    g.font = '400 19px ' + SANS;
    g.fillStyle = C.inkSoft;
    const kwid = trackedWidth(g, k.toUpperCase(), 3);
    g.font = '600 33px ' + SANS;
    const vwid = trackedWidth(g, v, 0.6);
    const rowW = kwid + 20 + vwid;
    let rx = cx - rowW / 2;
    g.font = '400 19px ' + SANS;
    g.fillStyle = C.inkSoft;
    tracked(g, k.toUpperCase(), rx, ry, 3);
    rx += kwid + 20;
    g.font = '600 33px ' + SANS;
    g.fillStyle = C.ink;
    tracked(g, v, rx, ry, 0.6);
    ry += 54;
  }
  g.font = '400 18px ' + SANS;
  g.fillStyle = 'rgba(107,92,72,0.95)';
  const ft = 'Three.js · every texture, mesh and sound generated at runtime';
  const fw = trackedWidth(g, ft, 1.2);
  tracked(g, ft, cx - fw / 2, y + ph - 26, 1.2);
  g.restore();
}

/* ---------- frame assembly ---------- */
const main = document.createElement('canvas'); main.width = W; main.height = H;
const gm = main.getContext('2d', { alpha: false });
const layers = [0, 1].map(() => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  return { c, g: c.getContext('2d') };
});

window.__paintFrame = (frame, cards, total, fps, xf, imgs) => {
  const t = frame / fps;
  gm.fillStyle = '#0B0810'; gm.fillRect(0, 0, W, H);
  const live = cards.filter((c) => t >= c.start - 1e-6 && t < c.end);
  let li = 0;
  for (const card of live) {
    const p = Math.min(1, Math.max(0, (t - card.start) / card.dur));
    const L = layers[li % 2]; li++;
    L.g.setTransform(1, 0, 0, 1, 0, 0);
    L.g.clearRect(0, 0, W, H);
    L.g.globalAlpha = 1;
    const img = imgs[card.file];
    if (card.kind === 'title') drawTitle(L.g, img, p);
    else if (card.kind === 'end') drawEnd(L.g, img, p);
    else drawBeat(L.g, img, card, p);

    // cross-dissolve: the incoming card ramps up over the incoming card's first xf
    let a = 1;
    const into = t - card.start;
    if (into < xf) {
      const q = into / xf;
      a = q * q * (3 - 2 * q);            // smoothstep
      if (card === live[0] && live.length === 1) a = a; // first card fades up from black
    }
    gm.globalAlpha = Math.max(0, Math.min(1, a));
    gm.drawImage(L.c, 0, 0);
  }
  gm.globalAlpha = 1;
  // tail fade to black
  const tail = total - t;
  if (tail < 0.85) {
    gm.fillStyle = 'rgba(11,8,16,' + Math.min(1, (0.85 - tail) / 0.85) + ')';
    gm.fillRect(0, 0, W, H);
  }
  return main.toDataURL('image/png').slice(22);
};
return true;
})()
`;

/* ------------------------------- run ------------------------------- */
console.log(`[video] ${NFRAMES} frames · ${TOTAL.toFixed(2)}s · ${cards.length} cards (${BEATS.length} beats)`);
await mkdir(WORK, { recursive: true });
for (const f of await readdir(WORK)) if (f.endsWith('.png')) await rm(path.join(WORK, f));

const wanted = ONLY ? ONLY.split(',').map(Number) : null;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300, deviceScaleFactor: 1 });
  await page.setContent('<body style="margin:0;background:#000"></body>');
  await page.evaluate(PAINTER);
  // decode all stills once, keep them on window
  await page.evaluate(async (enc) => {
    window.__imgs = {};
    await Promise.all(Object.entries(enc).map(([k, src]) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => { window.__imgs[k] = im; res(); };
      im.onerror = rej;
      im.src = src;
    })));
    return Object.keys(window.__imgs).length;
  }, encoded);

  const slim = cards.map((c) => ({ ...c }));
  const t0 = Date.now();
  let written = 0;
  for (let f = 0; f < NFRAMES; f++) {
    if (wanted && !wanted.includes(f)) continue;
    const b64 = await page.evaluate(
      (f, cardsArg, total, fps, xf) => window.__paintFrame(f, cardsArg, total, fps, xf, window.__imgs),
      f, slim, TOTAL, FPS, XF,
    );
    await writeFile(path.join(WORK, 'f' + String(f).padStart(5, '0') + '.png'), Buffer.from(b64, 'base64'));
    written++;
    if (written % 60 === 0) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`[video] ${written} frames · ${el.toFixed(0)}s elapsed\n`);
    }
  }
  console.log(`[video] wrote ${written} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} finally {
  await browser.close();
}

if (has('no-encode') || wanted) { console.log('[video] skipping encode'); process.exit(0); }

/* ------------------------------ encode ------------------------------ */
const run = (cmd, args) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', (code) => (code === 0 ? res() : rej(new Error(cmd + ' exited ' + code))));
  p.on('error', rej);
});

await mkdir(path.dirname(OUT), { recursive: true });
const hasAudio = existsSync(AUDIO) && statSync(AUDIO).size > 4096;
const vf = 'format=yuv420p';
const args = ['-y', '-framerate', String(FPS), '-i', path.join(WORK, 'f%05d.png')];
if (hasAudio) args.push('-i', AUDIO);
args.push('-map', '0:v:0');
if (hasAudio) args.push('-map', '1:a:0');
args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-vf', vf,
  '-profile:v', 'high', '-level', '4.1', '-movflags', '+faststart', '-r', String(FPS));
if (hasAudio) {
  const fadeOut = Math.max(0, TOTAL - 2.4);
  args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-af', `volume=0.30,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOut.toFixed(2)}:d=2.4`,
    '-shortest');
}
args.push(OUT);
console.log('[video] ffmpeg', hasAudio ? '(with quiet ambient bed)' : '(silent — no audio bed found)');
await run('ffmpeg', args);

const mb = statSync(OUT).size / 1e6;
console.log(`[video] ${OUT} · ${TOTAL.toFixed(2)}s · ${mb.toFixed(2)} MB`);
