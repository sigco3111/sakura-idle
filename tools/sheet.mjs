#!/usr/bin/env node
/**
 * Compose PNGs into one contact sheet, so a reviewer can compare frames in a
 * single glance instead of holding several images in their head.
 *
 *   node tools/sheet.mjs --out shots/sheet.png --cols 2 --label 1 \
 *        shots/a/hero.png shots/b/hero.png
 *
 * Blind A/B mode — shuffles the inputs with a caller-supplied seed, labels them
 * A/B/C…, and writes the key to a SEPARATE file the reviewer is told not to open:
 *
 *   node tools/sheet.mjs --out shots/ab.png --blind 4821 --key shots/ab.key.json \
 *        shots/round3/hero.png shots/round5/hero.png
 *
 * Uses headless Chrome's canvas for compositing so no image library is needed.
 */
import puppeteer from 'puppeteer';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i === -1 ? d : argv[i + 1]; };
const flags = new Set(['out', 'cols', 'label', 'blind', 'key', 'gap', 'width']);
const inputs = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev && prev.startsWith('--') && flags.has(prev.slice(2)));
});

if (!inputs.length) { console.error('no input images'); process.exit(2); }

const OUT = path.resolve(arg('out', 'shots/sheet.png'));
const COLS = Number(arg('cols', Math.min(2, inputs.length)));
const GAP = Number(arg('gap', 12));
const MAXW = Number(arg('width', 2560));
const LABEL = arg('label', '0') !== '0' || arg('blind', null) !== null;
const BLIND = arg('blind', null);
const KEYFILE = arg('key', null);

// Deterministic shuffle (seeded) — no Math.random, so a run is reproducible.
function shuffle(list, seed) {
  let a = (Number(seed) || 1) >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const ordered = BLIND !== null ? shuffle(inputs, BLIND) : inputs;
const letters = 'ABCDEFGHIJKL';
const labels = ordered.map((p, i) => (BLIND !== null ? letters[i] : path.basename(path.dirname(p)) + '/' + path.basename(p)));

const encoded = [];
for (const p of ordered) {
  encoded.push('data:image/png;base64,' + (await readFile(path.resolve(p))).toString('base64'));
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  const b64 = await page.evaluate(async ({ srcs, labels, cols, gap, maxw, label }) => {
    const imgs = await Promise.all(srcs.map((s) => new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = s;
    })));
    const rows = Math.ceil(imgs.length / cols);
    const cellW = Math.floor((Math.min(maxw, imgs[0].width * cols + gap * (cols - 1)) - gap * (cols - 1)) / cols);
    const scale = cellW / imgs[0].width;
    const cellH = Math.round(imgs[0].height * scale);
    const bar = label ? 34 : 0;
    const c = document.createElement('canvas');
    c.width = cols * cellW + (cols - 1) * gap;
    c.height = rows * (cellH + bar) + (rows - 1) * gap;
    const g = c.getContext('2d');
    g.fillStyle = '#141018'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    imgs.forEach((im, i) => {
      const cx = (i % cols) * (cellW + gap);
      const cy = Math.floor(i / cols) * (cellH + bar + gap);
      if (label) {
        g.fillStyle = '#efe6d8';
        g.font = '600 20px ui-sans-serif, system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(labels[i], cx + 8, cy + bar / 2);
      }
      g.drawImage(im, cx, cy + bar, cellW, cellH);
    });
    return c.toDataURL('image/png').split(',')[1];
  }, { srcs: encoded, labels, cols: COLS, gap: GAP, maxw: MAXW, label: LABEL });

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(b64, 'base64'));
  console.log('[sheet]', OUT, `${ordered.length} images, ${COLS} cols`);

  if (BLIND !== null) {
    const key = Object.fromEntries(ordered.map((p, i) => [letters[i], p]));
    const kf = path.resolve(KEYFILE ?? OUT.replace(/\.png$/, '.key.json'));
    await writeFile(kf, JSON.stringify(key, null, 2));
    console.log('[sheet] blind key →', kf, '(reviewers must NOT read this)');
  }
} finally {
  await browser.close();
}
